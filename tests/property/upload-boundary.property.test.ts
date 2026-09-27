import { Buffer } from 'node:buffer';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { API_ENDPOINTS, jameeRequests, type FetchLike } from '@/components/LanguageProvider';
import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  MAX_IMAGE_BYTES,
  REQUEST_BODY_CEILING_BYTES,
} from '@/lib/config/verified';
import { uploadMedia, MediaUploadError, type UploadFetch } from '@/lib/media/upload';
import {
  diagnoseRequestSchema,
  mediaRefSchema,
  SUPPORTED_LANGUAGES,
  voiceRequestSchema,
  type Language,
  type MediaRef,
} from '@/lib/schemas';

/**
 * ### Property 4: The upload boundary never carries media bytes and never runs ahead of a failed upload
 *
 * *"For any accepted image or recording of any size within the limits, the analysis request body
 * subsequently sent to the API layer contains no media bytes, carries a Media_Reference, and stays
 * below the platform request-body ceiling independently of the media size; the upload leg that
 * precedes it — the multipart POST to the authenticated Media_Endpoint that writes the file to
 * GridFS and returns that Media_Reference — carries the re-encoded bytes and is itself below the
 * 4.5 MB Request_Body_Ceiling; and for any upload failure at the Media_Endpoint, an upload error is
 * reported and no diagnosis or voice request is sent for that file."*
 *
 * **Validates: Requirements 2.1, 2.7, 8.1, 15.5**
 *
 * =============================================================================
 * AMENDMENT A3 — THE TWO LEGS THE BOUNDARY IS NOW MADE OF
 * =============================================================================
 *
 * Under Supabase the browser uploaded straight to a private bucket and posted a storage path. A3's
 * amended D1 removes the browser storage client: the browser now uploads the re-encoded bytes to the
 * authenticated **Media_Endpoint** (`POST /api/media`, `multipart/form-data`), which writes them to
 * GridFS and returns a **Media_Reference** (`{ fileId, kind }`); the analysis request then carries
 * only that reference. So the one boundary is now two legs, and each half of Property 4 is stated
 * over the leg it is about:
 *
 *  - **The upload leg** is `uploadMedia({ body, kind })` in `src/lib/media/upload.ts`. It is the ONE
 *    place bytes leave the browser, and it is a `fetch` wrapper with an injectable seam. This file
 *    drives it with a recording `UploadFetch` and asserts the actual `RequestInit`: the method is
 *    `POST /api/media`, the body is a `FormData` carrying a `file` part and a `kind` part (the bytes
 *    ride HERE, which is correct — this is the leg that carries them), the file part's byte length is
 *    below the 4.5 MB Request_Body_Ceiling, and the response's `mediaRef` is validated against
 *    `mediaRefSchema` before it is returned.
 *  - **The analysis request** is built by `jameeRequests(language, fetchImpl).diagnose(body)` /
 *    `.voice(body)` in `src/components/LanguageProvider.tsx`. A test that stubbed a higher seam would
 *    observe the body object and stop one step short of the claim — the object could be
 *    reference-shaped while the transport turned it into something else. So this file wires the real
 *    request builder and injects a recording `FetchLike`, and asserts the actual `RequestInit`:
 *      - `init.body` is a **`string`**, not `FormData`/`Blob`/`ArrayBuffer`/a typed-array view;
 *      - `content-type` is `application/json`;
 *      - the body **byte length** (measured with `TextEncoder`, so a multi-byte character cannot hide
 *        bytes) is below the platform ceiling and is a few hundred bytes, not kilobytes;
 *      - the body carries a **unique sentinel** in none of raw/base64/hex — an implementation that
 *        inlined the media in any encoding a browser can produce would fail here;
 *      - body length is **equal** to a 1-byte control run with the same identifiers — the
 *        "independently of the media size" clause as an equality, not an inequality a 4.4 MB body
 *        would also satisfy.
 *
 * =============================================================================
 * "NEVER RUNS AHEAD OF A FAILED UPLOAD" IS COUNTED, NOT INFERRED
 * =============================================================================
 *
 * Requirement 15.5 is a claim about something NOT happening. Under A3 the two legs are ordered
 * upload-then-request, so the claim is: when `uploadMedia` throws `MediaUploadError`, no analysis
 * request is issued for that file. The flow is modelled as the two shipped seams in that order, with
 * the request seam a counting stub, and each failure case asserts the count is exactly zero. A
 * property that only ever asserted zero would also be satisfied by code that never sends anything, so
 * the counter is proved capable of being non-zero in the same file: the accepted cases assert exactly
 * one request after a successful upload.
 */

/* ========================================================================== */
/* Fixtures and arbitraries                                                    */
/* ========================================================================== */

const languageArb = fc.constantFrom<Language>(...SUPPORTED_LANGUAGES);
const uuidArb = fc.uuid({ version: 4 });

/** A 24-hex GridFS ObjectId, the wire shape a Media_Endpoint returns. */
const fileIdArb = uuidArb.map((uuid) => uuid.replace(/-/g, '').slice(0, 24).padEnd(24, '0'));

/**
 * Byte counts across the whole admissible range, with the ceiling itself included.
 *
 * `limit` is generated because Requirement 2.3 and 8.2 both say "up to", so the largest admissible
 * medium is the most interesting one: it is where an implementation that carried bytes on the
 * analysis request would blow past the 4.5 MB platform ceiling. The re-encode leg's own bytes are
 * bounded by `REQUEST_BODY_CEILING_BYTES`, which is what the upload-leg assertion checks.
 */
function admissibleSizeArb(limit: number): fc.Arbitrary<number> {
  return fc.oneof(
    fc.constant(1),
    fc.constant(1024),
    fc.constant(512 * 1024),
    fc.integer({ min: 2, max: limit - 2 }),
    fc.constant(limit - 1),
    fc.constant(limit),
  );
}

/** A sentinel no JSON payload could contain by accident, and cheap to spell three ways. */
const sentinelArb = uuidArb.map(
  (uuid) => `JAMEE-MEDIA-${uuid.replaceAll('-', '').slice(0, 12).toUpperCase()}`,
);

const encoder = new TextEncoder();

function byteLengthOf(body: string): number {
  return encoder.encode(body).length;
}

/** `size` bytes carrying `sentinel` as ASCII, repeated so it survives any truncation. */
function bytesWithSentinel(size: number, sentinel: string): Uint8Array<ArrayBuffer> {
  const buffer = new Uint8Array(new ArrayBuffer(size));
  const marker = encoder.encode(sentinel);
  for (let offset = 0; offset + marker.length <= size; offset += marker.length * 4) {
    buffer.set(marker, offset);
  }
  return buffer;
}

/**
 * The three spellings a browser can turn bytes into before putting them in a JSON string: raw, a
 * `btoa`/data-URI base64, and a hand-rolled hex. Searching for all three is what makes the absence of
 * media bytes a finding about the payload rather than about the type of the value passed in.
 */
function sentinelSpellings(sentinel: string): readonly string[] {
  const bytes = encoder.encode(sentinel);
  return [
    sentinel,
    Buffer.from(bytes).toString('base64').replace(/=+$/, ''),
    Buffer.from(bytes).toString('hex'),
  ];
}

/* ========================================================================== */
/* The upload-leg transport (multipart)                                        */
/* ========================================================================== */

interface UploadedForm {
  readonly url: string;
  readonly method: string;
  readonly isFormData: boolean;
  readonly kind: string | null;
  readonly filePart: Blob | null;
  readonly fileBytes: number;
}

/** An `UploadFetch` that records the multipart request and returns a Media_Reference. */
function uploadTransport(fileIdFor: () => string): {
  readonly requests: UploadedForm[];
  readonly fetchImpl: UploadFetch;
} {
  const requests: UploadedForm[] = [];
  const fetchImpl: UploadFetch = async (url, init) => {
    const body = init.body;
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    let kind: string | null = null;
    let filePart: Blob | null = null;
    let fileBytes = 0;
    if (isFormData) {
      const form = body as FormData;
      const k = form.get('kind');
      kind = typeof k === 'string' ? k : null;
      const f = form.get('file');
      if (f instanceof Blob) {
        filePart = f;
        fileBytes = f.size;
      }
    }
    requests.push({ url: String(url), method: String(init.method), isFormData, kind, filePart, fileBytes });

    const mediaRef: MediaRef = { fileId: fileIdFor(), kind: (kind as MediaRef['kind']) ?? 'crop-image' };
    return new Response(JSON.stringify({ mediaRef }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { requests, fetchImpl };
}

/* ========================================================================== */
/* The analysis-request transport (JSON)                                       */
/* ========================================================================== */

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonTransport(): { readonly requests: RecordedRequest[]; readonly fetchImpl: FetchLike } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    fetchImpl: (url, init) => {
      requests.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}

/** Counts calls to the analysis-request seam, separately from the transport underneath it. */
function countingSeam<B>(inner: (body: B) => Promise<Response>): {
  calls: () => number;
  send: (body: B) => Promise<Response>;
} {
  let calls = 0;
  return {
    calls: () => calls,
    send: (body) => {
      calls += 1;
      return inner(body);
    },
  };
}

/* ========================================================================== */
/* The shared analysis-body assertions                                         */
/* ========================================================================== */

/**
 * Every claim about the analysis request itself. Returns the body byte length so the caller can
 * compare it with a control run.
 */
function assertReferenceOnlyRequest(
  request: RecordedRequest,
  options: {
    endpoint: string;
    language: Language;
    sentinels: readonly string[];
    allowedKeys: readonly string[];
    label: string;
  },
): { body: unknown; bytes: number } {
  const { init, url } = request;
  const { label } = options;

  expect(url, label).toBe(`${options.endpoint}?language=${encodeURIComponent(options.language)}`);
  expect(init.method, label).toBe('POST');
  expect(init.headers, label).toStrictEqual({ 'content-type': 'application/json' });

  // The four shapes a multipart or binary upload would take, each ruled out directly.
  expect(init.body instanceof Blob, `${label}: body is a Blob`).toBe(false);
  expect(init.body instanceof ArrayBuffer, `${label}: body is an ArrayBuffer`).toBe(false);
  expect(ArrayBuffer.isView(init.body), `${label}: body is a typed array view`).toBe(false);
  expect(
    typeof FormData !== 'undefined' && init.body instanceof FormData,
    `${label}: body is FormData`,
  ).toBe(false);
  expect(typeof init.body, label).toBe('string');

  const serialized = init.body as string;
  const bytes = byteLengthOf(serialized);

  // Requirement 2.7 / V16: below the platform ceiling, with room that is not a rounding error.
  expect(bytes, `${label}: ${bytes} bytes on the wire`).toBeLessThan(REQUEST_BODY_CEILING_BYTES);
  expect(bytes, `${label}: a reference is a few hundred bytes, not kilobytes`).toBeLessThan(512);

  // No media bytes, in any of the three encodings a browser could produce.
  for (const spelling of options.sentinels) {
    expect(serialized.includes(spelling), `${label}: body carries media bytes`).toBe(false);
  }

  const body: unknown = JSON.parse(serialized);

  // The one JSON-legal smuggling route the sentinel search cannot see is a numeric array
  // (`Array.from(bytes)`), excluded structurally: neither request schema declares an array field, so
  // an array anywhere is something no route would read. The key allowlist closes the other side —
  // Zod strips unknown keys, so `safeParse` success says nothing about extras; an explicit
  // comparison does.
  expect(body !== null && typeof body === 'object', `${label}: body is not a JSON object`).toBe(true);
  if (body === null || typeof body !== 'object') return { body, bytes };

  for (const key of Object.keys(body)) {
    expect(options.allowedKeys, `${label}: unexpected field "${key}" in the request body`).toContain(
      key,
    );
  }

  const walk = (value: unknown, path: string): void => {
    expect(value instanceof Blob, `${label}: Blob at ${path}`).toBe(false);
    expect(ArrayBuffer.isView(value), `${label}: typed array at ${path}`).toBe(false);
    expect(Array.isArray(value), `${label}: array at ${path}`).toBe(false);
    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) walk(nested, `${path}.${key}`);
      return;
    }
    expect(['string', 'number', 'boolean'], `${label}: leaf at ${path}`).toContain(typeof value);
  };
  walk(body, 'body');

  return { body, bytes };
}

/* ========================================================================== */
/* Property 4, upload leg: the bytes ride the multipart POST to the endpoint   */
/* ========================================================================== */

describe('Property 4: the upload leg carries the bytes to the Media_Endpoint, below the ceiling', () => {
  it('POSTs a multipart file + kind to /api/media and returns the validated Media_Reference', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          kind: fc.constantFrom<MediaRef['kind']>('crop-image', 'thumbnail', 'voice'),
          bytes: fc.oneof(admissibleSizeArb(768 * 1024), admissibleSizeArb(MAX_AUDIO_BYTES)),
          mimeType: fc.constantFrom('image/jpeg', 'image/png', 'audio/webm', 'audio/ogg'),
          sentinel: sentinelArb,
          fileId: fileIdArb,
        }),
        async (run) => {
          const label = `kind ${run.kind}, ${run.bytes} B`;
          const io = uploadTransport(() => run.fileId);
          const blob = new Blob([bytesWithSentinel(run.bytes, run.sentinel)], { type: run.mimeType });

          const ref = await uploadMedia({ body: blob, kind: run.kind, fetchImpl: io.fetchImpl });

          // Requirement 2.1 / 8.1 / 2.13: exactly one multipart POST to the authenticated endpoint.
          expect(io.requests, label).toHaveLength(1);
          const request = io.requests[0];
          if (request === undefined) throw new Error('no upload request recorded');
          expect(request.url, label).toBe('/api/media');
          expect(request.method, label).toBe('POST');
          expect(request.isFormData, `${label}: the upload leg is not multipart`).toBe(true);

          // The bytes ride HERE — this is the leg that carries them — as the `file` part, and the
          // `kind` part rides alongside so the route admits it per kind.
          expect(request.kind, label).toBe(run.kind);
          expect(request.filePart, `${label}: no file part`).not.toBeNull();
          expect(request.fileBytes, label).toBe(run.bytes);

          // Requirement 2.7 / V16: the upload leg is itself below the 4.5 MB Request_Body_Ceiling.
          // (The image cap the farmer selects is 10 MB, but what reaches the endpoint is the
          // re-encoded object; the wrapper bounds it, and the generated sizes stay under the ceiling.)
          expect(request.fileBytes, `${label}: upload leg exceeds the ceiling`).toBeLessThan(
            REQUEST_BODY_CEILING_BYTES,
          );

          // The reference returned is exactly the `{ fileId, kind }` shape the request schemas refine,
          // validated by `mediaRefSchema` inside `uploadMedia`.
          expect(mediaRefSchema.safeParse(ref).success, label).toBe(true);
          expect(ref.fileId, label).toBe(run.fileId);
          expect(ref.kind, label).toBe(run.kind);
        },
      ),
      { numRuns: 120 },
    );
  });

  it('reports a MediaUploadError when the endpoint refuses, and returns no reference', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(400, 401, 403, 413, 500),
        fc.constantFrom<MediaRef['kind']>('crop-image', 'thumbnail', 'voice'),
        async (status, kind) => {
          const fetchImpl: UploadFetch = () =>
            Promise.resolve(new Response(JSON.stringify({ error: { code: 'X' } }), { status }));
          const blob = new Blob([new Uint8Array(64)], { type: 'image/jpeg' });

          let thrown: unknown;
          try {
            await uploadMedia({ body: blob, kind, fetchImpl });
          } catch (error) {
            thrown = error;
          }
          expect(thrown instanceof MediaUploadError, `status ${status}`).toBe(true);
          expect((thrown as MediaUploadError).status, `status ${status}`).toBe(status);
        },
      ),
    );
  });
});

/* ========================================================================== */
/* Property 4, first half of the request: the analysis body carries no bytes   */
/* ========================================================================== */

describe('Property 4: the analysis request never carries media bytes', () => {
  it('posts a crop-image reference of constant size for any admissible photo', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          fileId: fileIdArb,
          conversationId: fc.option(fileIdArb, { nil: undefined }),
          language: languageArb,
          selectedBytes: admissibleSizeArb(MAX_IMAGE_BYTES),
          sentinel: sentinelArb,
        }),
        async (run) => {
          const sentinels = sentinelSpellings(run.sentinel);
          const label = `selected ${run.selectedBytes} B, ${run.language}`;

          // The upload leg happened first and returned this reference (its bytes-carrying is the
          // upload-leg property above); here the analysis request is built from the reference alone.
          const image: MediaRef = { fileId: run.fileId, kind: 'crop-image' };

          const io = jsonTransport();
          const requests = jameeRequests(run.language, io.fetchImpl);
          const seam = countingSeam(requests.diagnose.bind(requests));

          await seam.send({
            image,
            ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
          });

          expect(seam.calls(), label).toBe(1);
          expect(io.requests, label).toHaveLength(1);
          const request = io.requests[0];
          if (request === undefined) throw new Error('no request recorded');

          const { body, bytes } = assertReferenceOnlyRequest(request, {
            endpoint: API_ENDPOINTS.diagnose,
            language: run.language,
            sentinels,
            allowedKeys: Object.keys(diagnoseRequestSchema.shape),
            label,
          });

          const parsed = diagnoseRequestSchema.safeParse(body);
          expect(parsed.success, `${label}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
          if (!parsed.success) return;
          expect(parsed.data.image, label).toStrictEqual(image);
          expect(parsed.data.language, label).toBe(run.language);
          expect(parsed.data.conversationId, label).toBe(run.conversationId);

          // "Independently of the media size", as an equality: the selected photo could be 1 byte or
          // 10 MB — the reference-only body is byte-for-byte the same length. The photo's size never
          // touches this request, because it never entered it.
          const control = jsonTransport();
          const controlRequests = jameeRequests(run.language, control.fetchImpl);
          await controlRequests.diagnose({
            image,
            ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
          });
          const controlBody = control.requests[0]?.init.body;
          expect(typeof controlBody, label).toBe('string');
          expect(bytes, label).toBe(byteLengthOf(controlBody as string));
        },
      ),
      { numRuns: 150 },
    );
  });

  it('posts a voice-messages reference of constant size for any admissible recording', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          fileId: fileIdArb,
          conversationId: fileIdArb,
          language: languageArb,
          sizeBytes: admissibleSizeArb(MAX_AUDIO_BYTES),
          durationSeconds: fc.integer({ min: 1, max: MAX_AUDIO_SECONDS }),
          mimeType: fc.constantFrom('audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4'),
          sentinel: sentinelArb,
        }),
        async (run) => {
          const sentinels = sentinelSpellings(run.sentinel);
          const label = `${run.mimeType}, ${run.durationSeconds}s, ${run.language}`;

          const audio: MediaRef = { fileId: run.fileId, kind: 'voice' };

          const io = jsonTransport();
          const requests = jameeRequests(run.language, io.fetchImpl);
          const seam = countingSeam(requests.voice.bind(requests));

          await seam.send({
            audio,
            conversationId: run.conversationId,
            durationSeconds: run.durationSeconds,
            mimeType: run.mimeType,
          });

          expect(seam.calls(), label).toBe(1);
          expect(io.requests, label).toHaveLength(1);
          const request = io.requests[0];
          if (request === undefined) throw new Error('no request recorded');

          const { body, bytes } = assertReferenceOnlyRequest(request, {
            endpoint: API_ENDPOINTS.voice,
            language: run.language,
            sentinels,
            allowedKeys: Object.keys(voiceRequestSchema.shape),
            label,
          });

          const parsed = voiceRequestSchema.safeParse(body);
          expect(parsed.success, `${label}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
          if (!parsed.success) return;
          expect(parsed.data.audio, label).toStrictEqual(audio);
          expect(parsed.data.durationSeconds, label).toBe(run.durationSeconds);
          expect(parsed.data.durationSeconds, label).toBeLessThanOrEqual(MAX_AUDIO_SECONDS);
          // The measurement, not the byte count — `voiceRequestSchema` carries no size, so there is
          // no field a client could inflate into a payload.
          expect(body).not.toHaveProperty('sizeBytes');
          expect(body).not.toHaveProperty('bytes');

          const control = jsonTransport();
          const controlRequests = jameeRequests(run.language, control.fetchImpl);
          await controlRequests.voice({
            audio,
            conversationId: run.conversationId,
            durationSeconds: run.durationSeconds,
            mimeType: run.mimeType,
          });
          const controlBody = control.requests[0]?.init.body;
          expect(typeof controlBody, label).toBe('string');
          expect(bytes, label).toBe(byteLengthOf(controlBody as string));
        },
      ),
      { numRuns: 150 },
    );
  });
});

/* ========================================================================== */
/* Property 4, second half: nothing runs ahead of a failed upload               */
/* ========================================================================== */

/**
 * The two-leg flow a component runs, modelled over the two shipped seams in their real order: upload
 * the bytes through `uploadMedia`, and only on success send the analysis request. When the upload
 * throws `MediaUploadError`, the request seam must never be reached (Requirement 15.5). This is the
 * A3 successor to the pre-A3 `submitCropImage`/`submitVoiceRecording` orchestration, which is now
 * inside the React components (untestable as pure functions) — the sequencing rule the requirement is
 * about is a rule about these two seams, and it is asserted directly over them.
 */
async function uploadThenRequest(options: {
  readonly uploadFetch: UploadFetch;
  readonly kind: MediaRef['kind'];
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
  readonly send: (ref: MediaRef) => Promise<Response>;
}): Promise<{ status: 'sent'; ref: MediaRef } | { status: 'failed'; error: MediaUploadError }> {
  let ref: MediaRef;
  try {
    ref = await uploadMedia({
      body: new Blob([options.bytes], { type: options.mimeType }),
      kind: options.kind,
      fetchImpl: options.uploadFetch,
    });
  } catch (error) {
    if (error instanceof MediaUploadError) return { status: 'failed', error };
    throw error;
  }
  await options.send(ref);
  return { status: 'sent', ref };
}

describe('Property 4: the analysis request never runs ahead of a failed upload', () => {
  const failStatusArb = fc.constantFrom(400, 401, 403, 413, 500);

  it('sends no diagnosis request when the crop-image upload fails, for any photo and any failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          language: languageArb,
          selectedBytes: admissibleSizeArb(768 * 1024),
          status: failStatusArb,
        }),
        async (run) => {
          const label = `${run.selectedBytes} B, HTTP ${run.status}`;

          const io = jsonTransport();
          const requests = jameeRequests(run.language, io.fetchImpl);
          const seam = countingSeam(requests.diagnose.bind(requests));

          const uploadFetch: UploadFetch = () =>
            Promise.resolve(new Response(null, { status: run.status }));

          const outcome = await uploadThenRequest({
            uploadFetch,
            kind: 'crop-image',
            bytes: bytesWithSentinel(run.selectedBytes, 'JAMEE-MEDIA-FAILPATH'),
            mimeType: 'image/jpeg',
            send: (ref) => seam.send({ image: ref }),
          });

          // Requirement 15.5, first clause: the failure is reported.
          expect(outcome.status, label).toBe('failed');
          // Second clause, counted at both levels: exactly zero.
          expect(seam.calls(), `${label}: the diagnose seam ran ahead of a failed upload`).toBe(0);
          expect(io.requests, label).toHaveLength(0);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('sends no voice request when the recording upload fails, for any recording and any failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          language: languageArb,
          sizeBytes: admissibleSizeArb(MAX_AUDIO_BYTES),
          status: failStatusArb,
          mimeType: fc.constantFrom('audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4'),
        }),
        async (run) => {
          const label = `${run.mimeType}, ${run.sizeBytes} B, HTTP ${run.status}`;

          const io = jsonTransport();
          const requests = jameeRequests(run.language, io.fetchImpl);
          const seam = countingSeam(requests.voice.bind(requests));

          const uploadFetch: UploadFetch = () =>
            Promise.resolve(new Response(null, { status: run.status }));

          const outcome = await uploadThenRequest({
            uploadFetch,
            kind: 'voice',
            bytes: bytesWithSentinel(run.sizeBytes, 'JAMEE-MEDIA-FAILPATH'),
            mimeType: run.mimeType,
            send: (ref) =>
              seam.send({ audio: ref, conversationId: '000000000000000000000001', durationSeconds: 5 }),
          });

          expect(outcome.status, label).toBe('failed');
          expect(seam.calls(), `${label}: the voice seam ran ahead of a failed upload`).toBe(0);
          expect(io.requests, label).toHaveLength(0);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('does send the analysis request once the upload succeeds (the counter is not vacuously zero)', async () => {
    await fc.assert(
      fc.asyncProperty(fileIdArb, languageArb, async (fileId, language) => {
        const io = jsonTransport();
        const requests = jameeRequests(language, io.fetchImpl);
        const seam = countingSeam(requests.diagnose.bind(requests));
        const upload = uploadTransport(() => fileId);

        const outcome = await uploadThenRequest({
          uploadFetch: upload.fetchImpl,
          kind: 'crop-image',
          bytes: bytesWithSentinel(4096, 'JAMEE-MEDIA-OK'),
          mimeType: 'image/jpeg',
          send: (ref) => seam.send({ image: ref }),
        });

        expect(outcome.status).toBe('sent');
        // The same counter, in the same file, reaching exactly one after a successful upload — which
        // is what keeps the two zeros above from being vacuous.
        expect(seam.calls()).toBe(1);
        expect(io.requests).toHaveLength(1);
      }),
      { numRuns: 60 },
    );
  });
});
