import { Buffer } from 'node:buffer';

import { authenticatedRoute } from '@/lib/api/authenticated-route';
import { AppError } from '@/lib/errors';
import { storeMedia } from '@/lib/media';
import { mediaRefSchema, type MediaRef } from '@/lib/schemas';

/**
 * `POST /api/media` — the authenticated upload leg of the Media_Endpoint (task 54.2).
 *
 * Requirements: 1.7 (no valid session → HTTP 401, no write), 2.1 (a Farmer uploads a crop image),
 *               2.5 (the file is owned by the uploading Farmer — `metadata.ownerId` comes from the
 *               session, never client input), 2.7 (the stored payload stays under the 4.5 MB
 *               Request_Body_Ceiling), 12.5 (the reference the diagnosis/voice request then carries)
 * Design: D1 (amended — the upload leg carries bytes through the Media_Endpoint), D17 (one GridFS
 *         bucket by `metadata.kind`), D18 (bytes reach GridFS through `src/lib/media`); V29
 *
 * ### Multipart, and thin
 *
 * Under Amendment A3 the browser re-encodes an image toward the ~400 KB Downscale_Target (or records
 * a voice note ≤3 MB) and POSTs the bytes here as `multipart/form-data` with two fields: `file` (the
 * bytes) and `kind` (`crop-image`, `thumbnail`, or `voice`). The endpoint reads them, hands them to
 * `storeMedia` — the one place kind, MIME type and size are admitted before GridFS is touched — and
 * returns the Media_Reference (`{ fileId, kind }`) validated against `mediaRefSchema`. The client
 * then posts that reference to `/api/diagnose` or `/api/voice`; **no bytes ever ride the analysis
 * request** (D1).
 *
 * ### ownerId comes from the session, never from the client
 *
 * `storeMedia(session.userId, …)` stamps `metadata.ownerId` from the server-confirmed session
 * (`authenticatedRoute` is the only thing that can produce a `FarmerSession`), so a client cannot
 * upload a file owned by another farmer — Requirement 2.5 holds by construction, and the serve leg
 * reads back only files whose `metadata.ownerId` equals the requester.
 *
 * ### The one error envelope, from the wrapper
 *
 * `authenticatedRoute` already runs the handler inside `withErrorHandling`, whose language comes
 * from `?language=`/`Accept-Language` — the only source here, since the body is binary and carries
 * no language field. So this handler throws coded `AppError`s (`AUTH_REQUIRED` from the wrapper,
 * `STORAGE_REF_INVALID`/`FILE_TOO_LARGE`/`FILE_TYPE_UNSUPPORTED`/`AUDIO_*` from `storeMedia`) and
 * the wrapper renders them; there is no second envelope to nest.
 *
 * ### Why the bytes fit the ceiling by the time they reach here
 *
 * `storeMedia` refuses an image or thumbnail over `REQUEST_BODY_CEILING_BYTES` (4.5 MB, V16) and a
 * voice file over `MAX_AUDIO_BYTES` (3 MB, A3) with the taxonomy code a farmer reads. The platform
 * bounds the request body itself, so this route's defence is `assertAdmissible` inside `storeMedia`,
 * not a second size check here.
 */

/**
 * **V17.** Jamee's own ceiling, in seconds. Written as a literal because Next.js reads route segment
 * config by static analysis. 60 to match the analysis routes — a large upload plus the GridFS write
 * is the slow path this endpoint owns.
 */
export const maxDuration = 60;

/**
 * The Media_Endpoint's success payload: the Media_Reference the analysis request will carry. The
 * `fileId` is the 24-hex ObjectId string and `kind` echoes the admitted kind — the same shape
 * `mediaRefSchema` validates and the diagnose/voice request schemas refine.
 */
export interface MediaUploadResponse {
  readonly mediaRef: MediaRef;
}

export const POST = authenticatedRoute(async (request, session) => {
  const form = await readMultipart(request);

  const kind = form.get('kind');
  if (typeof kind !== 'string' || kind === '') {
    throw new AppError('STORAGE_REF_INVALID', { context: { reason: 'media_kind_missing' } });
  }

  const file = form.get('file');
  // A multipart file part is a `File` (which extends `Blob`) in the Node/undici runtime. We accept
  // any `Blob` so the read is robust across runtimes — the only members used below, `.type` and
  // `.arrayBuffer()`, are `Blob`'s — while a plain string form field (not a Blob) is still refused.
  if (!(file instanceof Blob)) {
    throw new AppError('STORAGE_REF_INVALID', { context: { reason: 'media_file_missing' } });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  // `storeMedia` validates kind + MIME type + size (`assertAdmissible`) and, only if it passes,
  // writes one GridFS file owned by the session's Auth_User_Id. The MIME type is read from the
  // uploaded part — what `MediaRecorder`/the browser stamped on the blob.
  const stored = await storeMedia(session.userId, kind, file.type, bytes);

  // Validate the reference against the wire schema before returning it, so the shape the client
  // receives is exactly the one it will send back: a 24-hex `fileId` and a known `kind`.
  const mediaRef = mediaRefSchema.parse({
    fileId: stored.fileId.toHexString(),
    kind: stored.kind,
  });

  const payload: MediaUploadResponse = { mediaRef };
  return Response.json(payload, { status: 201 });
});

/**
 * Read the multipart form, mapping a body that is not multipart to `STORAGE_REF_INVALID` (400)
 * rather than letting the platform's own parse error escape as a 500. The body is only read after
 * the session check (the wrapper ran first), so an unauthenticated caller never reaches here.
 */
async function readMultipart(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch (cause) {
    throw new AppError('STORAGE_REF_INVALID', {
      cause,
      context: { reason: 'media_body_not_multipart' },
    });
  }
}
