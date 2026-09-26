import type { NextRequest } from 'next/server';

import { currentUserId } from '@/lib/auth/session';
import { fetchMediaForOwner, type MediaBytes } from '@/lib/media';

/**
 * `GET /api/media/<fileId>` — the owner-checked serve leg of the Media_Endpoint (task 54.2).
 *
 * Requirements: 1.7 (no valid session → HTTP 401, nothing served), 2.5, 2.6 (a file is streamed only
 *               to the Farmer who owns it; a missing file and a foreign file are BOTH 404, so a
 *               stranger cannot probe for existence), 12.5 (this is the URL history thumbnails and
 *               the detail screen load through, replacing signed URLs)
 * Design: D17 (one GridFS bucket), D18 (`fetchMediaForOwner` is the owner-scoped read), Media
 *         lifecycle; V29
 *
 * ### Why 404 for both a missing file and a foreign file
 *
 * `fetchMediaForOwner(userId, fileId)` scopes the GridFS lookup by `{ _id, 'metadata.ownerId' }`, so
 * a file owned by someone else and a file that does not exist both return `null` — indistinguishably
 * (Requirement 2.6). This route maps that single `null` to **404**, never 403: a distinguishable
 * "forbidden" would itself be the existence oracle the scoped read exists to deny. (The A3 taxonomy's
 * `STORAGE_REF_FORBIDDEN` 403 is for the *analysis* path, where the reference is named in a request
 * body Jamee already parsed; a raw media fetch has no such context and 404 is the honest answer.)
 *
 * ### Not built on `authenticatedRoute`
 *
 * That wrapper's handler signature is `(request, session)` and produces the one JSON error envelope
 * — neither fits a binary streaming response with a dynamic `[id]` segment. So this GET resolves the
 * session with `currentUserId()` directly (the same server-confirmed call the wrapper uses) and
 * returns a plain 401/404/200 `Response`. No farmer-facing prose is involved: the caller is an
 * `<img src>`/`<audio src>` reading a status and bytes, not a farmer reading a sentence.
 *
 * ### The response
 *
 * On a hit: the bytes, `Content-Type` from the stored MIME type (so a browser renders the image or
 * plays the recording correctly), and `Cache-Control: private, max-age=…` — **private** because the
 * object is one farmer's and must never be cached by a shared/CDN layer (Requirement 13.5), and a
 * short max-age so a re-render of the history screen does not re-fetch every thumbnail. `no-store`
 * on the misses so a 401/404 is never cached.
 */

/**
 * **V17.** Jamee's own ceiling, in seconds. Written as a literal because Next.js reads route segment
 * config by static analysis. A media stream is small (a re-encoded image ~400 KB, a voice note
 * ≤3 MB), so this rarely approaches it.
 */
export const maxDuration = 60;

/** One farmer's private media, cached briefly by the browser only — never by a shared cache. */
const PRIVATE_CACHE_CONTROL = 'private, max-age=3600, immutable';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Requirement 1.7 — server-confirmed identity, exactly as `authenticatedRoute` resolves it. A
  // forged or absent session is `null` and gets 401, and nothing is read.
  const userId = await currentUserId();
  if (userId === null) {
    return new Response(null, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  // Next.js 16: the dynamic segment is a Promise and must be awaited.
  const { id } = await context.params;

  // The owner is part of the GridFS filter (D18): a stranger never opens a download stream, and a
  // missing/foreign file both return `null`. An unparseable id is treated as "does not exist" too.
  let found: MediaBytes | null;
  try {
    found = await fetchMediaForOwner(userId, id);
  } catch {
    // A driver/read failure is a server fault, not a client 404. Answer 500 with no body — this
    // path serves an <img>/<audio> element, not a farmer, so there is no envelope to render.
    return new Response(null, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }

  if (found === null) {
    // 2.6 — missing and foreign are the same answer.
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  // `found.bytes` is a Node `Buffer` (a `Uint8Array`), drained whole by the store (V29: the
  // streaming read cannot load partial chunks, and these files are small). It is wrapped in a
  // `Blob` so the body is an unambiguous `BodyInit` — a bare `Uint8Array<ArrayBufferLike>` is not
  // one under this TS lib config, because its backing buffer could in principle be a
  // `SharedArrayBuffer`. The `Blob` also carries the MIME type, which is harmless alongside the
  // explicit header below.
  // `found.bytes` is a Node `Buffer`, drained whole by the store (V29). Copied into a fresh
  // `ArrayBuffer`-backed `Uint8Array` so the body is an unambiguous `BodyInit`: `new Uint8Array(buf)`
  // allocates its own `ArrayBuffer` (not the `SharedArrayBuffer`-typed `.buffer` a bare Node Buffer
  // exposes), which is what both the TS lib types and every runtime accept as a response body.
  const body = new Uint8Array(found.bytes);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': found.mimeType,
      'Cache-Control': PRIVATE_CACHE_CONTROL,
    },
  });
}
