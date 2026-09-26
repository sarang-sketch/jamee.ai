import { mediaRefSchema, type MediaKind, type MediaRef } from '@/lib/schemas';

/**
 * The browser-side upload leg of the Media_Endpoint: POST one file to `POST /api/media` and get
 * back the Media_Reference the analysis request then carries.
 *
 * Requirements: 2.1 (a crop image is uploaded), 2.13 (a Thumbnail_Derivative is uploaded too), 8.1
 *               (a voice recording is uploaded), 2.7 (the analysis request then stays a ~60-byte
 *               reference — no bytes ride it, D1)
 * Design: D1 (amended by Amendment A3 — the browser uploads through the Media_Endpoint rather than
 *         direct-to-Storage), D17, D18
 *
 * =============================================================================
 * WHY THIS EXISTS, AND WHAT IT DELIBERATELY IS NOT
 * =============================================================================
 *
 * Under A3 there is no Supabase Storage and no browser storage client: `ImageUploader` and
 * `VoiceRecorder` no longer talk to a bucket. They re-encode/record in the browser exactly as
 * before, then hand the bytes here, and this posts them as `multipart/form-data` with two fields —
 * `file` (the bytes) and `kind` (`crop-image`, `thumbnail`, or `voice`) — to the authenticated
 * upload route, which admits them through `storeMedia` (kind + MIME type + size) and returns
 * `{ mediaRef }`. The reference is validated here against `mediaRefSchema` before it is returned,
 * so a caller can only ever receive the exact `{ fileId, kind }` shape the diagnose/voice request
 * schemas refine.
 *
 * This is a **client** module: it holds no server-only import, no driver, and no session — the
 * route reads the session and stamps `metadata.ownerId` from it, so this helper never names an
 * owner. It is a `fetch` wrapper, nothing more; the decision about what a failed upload means stays
 * in the component that called it (Requirements 2.14 and 15.5 are sequencing rules the caller owns).
 */

/** The success payload of `POST /api/media` — the Media_Reference the analysis request will carry. */
interface MediaUploadResponseBody {
  readonly mediaRef: unknown;
}

/**
 * Thrown when the Media_Endpoint refuses or fails an upload. Carries the HTTP status so the caller
 * can tell an admission refusal (400/403 — a wrong type, an oversized file) from a server fault
 * (500) if it wants to; the components map every upload failure to the same farmer-facing outcome
 * (`INTERNAL_ERROR` for the image path, a failed recording for voice), so the status is diagnostic
 * rather than farmer-facing. The response body is deliberately not surfaced — it is an error
 * envelope the component does not render on this path.
 */
export class MediaUploadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MediaUploadError';
    this.status = status;
  }
}

/**
 * The `fetch` seam, so a unit test drives `uploadMedia` without a network. Defaults to the global
 * `fetch`. Narrowed to the one call shape this helper makes.
 */
export type UploadFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface UploadMediaInput {
  /** The bytes to upload — a re-encoded image, a thumbnail, or a recording. */
  readonly body: Blob;
  /** Which kind of file this is. Refined per endpoint by the request schema downstream. */
  readonly kind: MediaKind;
  /**
   * The multipart filename. Non-identifying and best-effort — the route reads `file.type`, not the
   * name — so a caller may omit it and let this derive one from the kind.
   */
  readonly filename?: string;
  /** Injected by tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: UploadFetch;
}

/**
 * Upload one file and return its validated Media_Reference, or throw `MediaUploadError`.
 *
 * The MIME type the route admits comes from `body.type` (the `Blob`'s own type — what the browser
 * re-encoder or `MediaRecorder` stamped on it), so the caller does not pass one separately. A
 * `Blob` with no type would be refused by the route's admission check, which is the correct
 * outcome: an untyped payload is not something Jamee can classify or transcribe.
 */
export async function uploadMedia(input: UploadMediaInput): Promise<MediaRef> {
  const fetchImpl: UploadFetch = input.fetchImpl ?? ((url, init) => fetch(url, init));

  const form = new FormData();
  form.append('kind', input.kind);
  form.append('file', input.body, input.filename ?? defaultFilename(input.kind, input.body.type));

  let response: Response;
  try {
    response = await fetchImpl('/api/media', { method: 'POST', body: form });
  } catch (cause) {
    throw new MediaUploadError(0, `media upload request failed: ${String(cause)}`);
  }

  if (!response.ok) {
    throw new MediaUploadError(response.status, `media upload rejected with HTTP ${response.status}`);
  }

  let payload: MediaUploadResponseBody;
  try {
    payload = (await response.json()) as MediaUploadResponseBody;
  } catch (cause) {
    throw new MediaUploadError(response.status, `media upload response was not JSON: ${String(cause)}`);
  }

  const parsed = mediaRefSchema.safeParse(payload.mediaRef);
  if (!parsed.success) {
    throw new MediaUploadError(response.status, 'media upload response did not carry a valid mediaRef');
  }
  return parsed.data;
}

/** A plausible, non-identifying filename for the multipart part, derived from the kind and type. */
function defaultFilename(kind: MediaKind, mimeType: string): string {
  const subtype = mimeType.split(';')[0]?.split('/')[1]?.trim();
  const extension = subtype === undefined || subtype === '' ? 'bin' : subtype;
  return `${kind}.${extension}`;
}
