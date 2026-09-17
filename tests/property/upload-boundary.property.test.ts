import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  REENCODE_EXTENSION,
  REENCODE_TYPE,
  submitCropImage,
  type CropImageEncoder,
  type EncodedCropImage,
  type ObjectUploader,
} from '@/components/ImageUploader';
import {
  API_ENDPOINTS,
  jameeRequests,
  type FetchLike,
} from '@/components/LanguageProvider';
import { submitVoiceRecording } from '@/components/VoiceRecorder';
import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  MAX_IMAGE_BYTES,
  REQUEST_BODY_CEILING_BYTES,
  STORAGE_BUCKETS,
} from '@/lib/config/verified';
import {
  diagnoseRequestSchema,
  storageRefSchema,
  SUPPORTED_LANGUAGES,
  voiceRequestSchema,
  type Language,
} from '@/lib/schemas';
import { thumbPathFor } from '@/lib/storage';

/**
 * ### Property 4: The upload boundary never carries media bytes and never runs ahead of a failed upload
 *
 * *"For any accepted image or recording of any size within the limits, the request body
 * subsequently sent to the API layer contains no media bytes, carries a storage reference, and
 * stays below the platform request-body ceiling independently of the media size; and for any
 * upload failure, an upload error is reported and no diagnosis or voice request is sent for that
 * file."*
 *
 * **Validates: Requirements 2.1, 2.7, 8.1, 15.5**
 *
 * =============================================================================
 * WHERE THE BOUNDARY ACTUALLY IS, AND WHY THE ASSERTION GOES THROUGH `jameeRequests`
 * =============================================================================
 *
 * "The upload boundary" is the seam between the browser and `/api/diagnose` or `/api/voice`, and
 * D1 is the design decision that makes this property statable at all: the browser uploads to
 * Storage and posts a **reference**, so a 10 MB allowance (Requirement 2.3) and a 4.5 MB platform
 * body ceiling (Requirement 2.7, V16) can both be true at once.
 *
 * A test that stubbed the `diagnose` seam would observe the `DiagnoseBody` **object** and stop
 * one step short of the claim — the object could be reference-shaped while the transport turned
 * it into something else. So this file wires the real request builder,
 * `jameeRequests(language, fetchImpl)`, and injects a recording `FetchLike`. What is asserted is
 * therefore the actual `RequestInit`:
 *
 *  - `init.body` is a **`string`** — not `FormData`, not a `Blob`, not an `ArrayBuffer` or a view
 *    over one. Those are the four shapes a multipart upload would have to take, and each is ruled
 *    out by type rather than by inspection.
 *  - `content-type` is `application/json`, which is the wire half of Requirement 2.2.
 *  - The body **byte length** — measured with `TextEncoder`, not `String.length`, so a
 *    multi-byte character could not hide bytes — is compared against the platform ceiling.
 *  - The generated media carries a **unique sentinel** and the body is searched for it in raw,
 *    base64 and hex spellings. This is what makes "carries no bytes" a structural finding rather
 *    than trust that the code called a JSON helper: an implementation that inlined the photo in
 *    any of the three encodings a browser can produce would fail here.
 *  - Body length is compared against a **1-byte control run** with the same identifiers, which is
 *    the "independently of the media size" clause stated as an equality rather than as an
 *    inequality that a 4.4 MB body would also satisfy.
 *
 * This runs in the property project under **node**. Both flows are already extracted from their
 * components for exactly this reason — `submitCropImage` and `submitVoiceRecording` have no React
 * in them, and both headers say so: *"every rule worth testing here is a rule about sequencing…
 * None of that is about the DOM, and asserting it through a rendered tree would prove less."*
 * The re-encode and the `MediaRecorder` capture are the only DOM-bound parts, and both are
 * injected seams (`CropImageEncoder`, `RecordedAudio`), which is also why the sentinel can be
 * placed in the bytes at all.
 *
 * =============================================================================
 * "NEVER RUNS AHEAD OF A FAILED UPLOAD" IS COUNTED, NOT INFERRED
 * =============================================================================
 *
 * Requirement 15.5 is a claim about something *not* happening, so every seam it could happen
 * through is a counting stub and each failure case asserts the count is exactly **zero**:
 *
 *  - the `diagnose` / `voice` function `submitCropImage` and `submitVoiceRecording` are handed;
 *  - the `fetch` seam underneath it, counted separately — a body assembled and issued without
 *    going through the typed helper would still be a request, and the outer count alone would
 *    miss it.
 *
 * A property that only ever asserted zero would also be satisfied by code that never sends
 * anything, so the counter is proved capable of being non-zero in the same run: the accepted
 * cases assert exactly **one**, and the thumbnail-only failure asserts exactly one as well
 * (Requirement 2.14 — a thumbnail that fails after its full image succeeded still sends the
 * diagnosis).
 *
 * =============================================================================
 * ONE NOTE ON THE DESIGN SENTENCE
 * =============================================================================
 *
 * The design says *"for any accepted image or recording of any size within the limits"*. For the
 * image path the size that reaches storage is not the selected size — Requirement 2.10 has the
 * browser re-encode and upload the derivative **in place of** the selected file. So both are
 * generated and both are varied across the whole admissible range: the selected size, because
 * that is what "within the limits" is measured against, and the encoded size, because that is
 * what the sentinel travels in. Neither may appear in the body.
 */

/* ========================================================================== */
/* Fixtures and arbitraries                                                    */
/* ========================================================================== */

const NOW = new Date('2026-09-14T18:30:00.000Z');

const languageArb = fc.constantFrom<Language>(...SUPPORTED_LANGUAGES);
/** Matches `storageRefSchema`'s `[0-9a-f-]{36}` path segments and `z.uuid()` alike. */
const uuidArb = fc.uuid({ version: 4 });

/**
 * Byte counts across the whole admissible range, with the ceiling itself included.
 *
 * `limit` is generated because Requirement 2.3 and Requirement 8.2 both say "up to", so the
 * largest admissible medium is the most interesting one for this property: it is the case where
 * an implementation that carried bytes would blow past the 4.5 MB platform ceiling.
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

/**
 * `size` bytes carrying `sentinel` as ASCII, repeated so it survives any truncation an
 * implementation might apply before inlining.
 *
 * Zero-filled elsewhere: what matters is that the sentinel is *in* the bytes and that
 * `blob.size` is exactly the generated figure, because that is the number admission reads.
 */
function bytesWithSentinel(size: number, sentinel: string): Uint8Array<ArrayBuffer> {
  const buffer = new Uint8Array(new ArrayBuffer(size));
  const marker = new TextEncoder().encode(sentinel);
  for (let offset = 0; offset + marker.length <= size; offset += marker.length * 4) {
    buffer.set(marker, offset);
  }
  return buffer;
}

/** A sentinel no JSON payload could contain by accident, and cheap to spell three ways. */
const sentinelArb = uuidArb.map(
  (uuid) => `JAMEE-MEDIA-${uuid.replaceAll('-', '').slice(0, 12).toUpperCase()}`,
);

const encoder = new TextEncoder();

function byteLengthOf(body: string): number {
  return encoder.encode(body).length;
}

/**
 * The three spellings a browser can turn bytes into before putting them in a JSON string.
 *
 * Raw is a `Blob` stringified or a latin-1 read; base64 is what a data URI or `btoa` produces;
 * hex is what a hand-rolled `Array.from(bytes, …toString(16))` produces. Searching for all three
 * is what makes the absence of media bytes a finding about the payload rather than about the type
 * of the value that was passed in.
 */
function sentinelSpellings(sentinel: string): readonly string[] {
  const bytes = encoder.encode(sentinel);
  const base64 = Buffer.from(bytes).toString('base64');
  const hex = Buffer.from(bytes).toString('hex');
  return [
    sentinel,
    // Trim the trailing `=` padding: an offset encode would produce the payload without it.
    base64.replace(/=+$/, ''),
    hex,
  ];
}

/* ========================================================================== */
/* The recording transport                                                     */
/* ========================================================================== */

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

interface Transport {
  /** Every request that reached the `fetch` seam. */
  readonly requests: RecordedRequest[];
  /** How many times the typed helper was invoked, counted one level above `fetch`. */
  helperCalls: () => number;
  readonly fetchImpl: FetchLike;
}

function transport(): Transport {
  const requests: RecordedRequest[] = [];
  let helperCalls = 0;
  return {
    requests,
    helperCalls: () => helperCalls,
    fetchImpl: (url, init) => {
      helperCalls += 1;
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

/**
 * Counts calls to the seam `submitCropImage` / `submitVoiceRecording` was handed, separately from
 * the `fetch` seam underneath it. Requirement 15.5 has to hold at both levels.
 */
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

/** An uploader that records what it took, and throws for the paths `failOn` selects. */
function uploaderRecording(failOn?: (path: string) => boolean): {
  paths: string[];
  upload: ObjectUploader;
} {
  const paths: string[] = [];
  return {
    paths,
    upload: ({ ref }) => {
      if (failOn?.(ref.path) === true) {
        return Promise.reject(new Error(`storage refused ${ref.path}`));
      }
      paths.push(ref.path);
      return Promise.resolve();
    },
  };
}

/** An encoder that hands back the sentinel-carrying bytes, with no canvas anywhere. */
function encoderOf(options: {
  /**
   * `Uint8Array<ArrayBuffer>` rather than plain `Uint8Array`: `BlobPart` requires an
   * `ArrayBufferView<ArrayBuffer>`, and the unparameterized alias widens to `ArrayBufferLike`,
   * which admits a `SharedArrayBuffer` a `Blob` cannot take.
   */
  fullBytes: Uint8Array<ArrayBuffer>;
  thumbBytes: Uint8Array<ArrayBuffer> | null;
}): CropImageEncoder {
  return () => {
    const encoded: EncodedCropImage = {
      full: new Blob([options.fullBytes], { type: REENCODE_TYPE }),
      thumbnail:
        options.thumbBytes === null
          ? null
          : new Blob([options.thumbBytes], { type: REENCODE_TYPE }),
      contentType: REENCODE_TYPE,
      extension: REENCODE_EXTENSION,
      outcome: { width: 1600, height: 1200, quality: 0.72, reachedTarget: true },
    };
    return Promise.resolve(encoded);
  };
}

/* ========================================================================== */
/* The shared body assertions                                                  */
/* ========================================================================== */

/**
 * Every claim in the first half of Property 4 that is about the request itself rather than about
 * one endpoint's schema. Returns the body byte length so the caller can compare it with a
 * control run.
 */
function assertReferenceOnlyRequest(
  request: RecordedRequest,
  options: {
    endpoint: string;
    language: Language;
    sentinels: readonly string[];
    /** Every top-level field the endpoint's schema declares. Nothing else may be present. */
    allowedKeys: readonly string[];
    label: string;
  },
): { body: unknown; bytes: number } {
  const { init, url } = request;
  const { label } = options;

  expect(url, label).toBe(
    `${options.endpoint}?language=${encodeURIComponent(options.language)}`,
  );
  expect(init.method, label).toBe('POST');
  expect(init.headers, label).toStrictEqual({ 'content-type': 'application/json' });

  /**
   * The four shapes a multipart or binary upload would have to take, each ruled out directly.
   * `typeof === 'string'` alone would already exclude them; they are named anyway so a future
   * change that swapped the transport fails against the reason rather than against a type check.
   */
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

  /**
   * The sentinel search covers the three *encodings* of media bytes. The one remaining JSON-legal
   * smuggling route is a **numeric array** — `Array.from(bytes)` — which no encoding search can
   * see, so it is excluded structurally instead: neither `diagnoseRequestSchema` nor
   * `voiceRequestSchema` declares a single array field, so an array anywhere in the body is
   * something no route would read and nothing legitimate would send.
   *
   * The key allowlist closes the same hole from the other side. Zod object schemas **strip**
   * unknown keys rather than rejecting them, so `safeParse` succeeding says nothing about extra
   * fields; only an explicit comparison does.
   */
  expect(body !== null && typeof body === 'object', `${label}: body is not a JSON object`).toBe(
    true,
  );
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
    // Leaves may only be the JSON scalars.
    expect(['string', 'number', 'boolean'], `${label}: leaf at ${path}`).toContain(typeof value);
  };
  walk(body, 'body');

  return { body, bytes };
}

/* ========================================================================== */
/* Property 4, first half: the boundary carries no bytes — images               */
/* ========================================================================== */

describe('Property 4: the upload boundary never carries media bytes', () => {
  it('posts a crop-image reference of constant size for any admissible photo', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: uuidArb,
          objectId: uuidArb,
          conversationId: fc.option(uuidArb, { nil: undefined }),
          language: languageArb,
          selectedBytes: admissibleSizeArb(MAX_IMAGE_BYTES),
          encodedBytes: admissibleSizeArb(768 * 1024),
          sentinel: sentinelArb,
        }),
        async (run) => {
          const sentinels = sentinelSpellings(run.sentinel);
          const label = `selected ${run.selectedBytes} B, encoded ${run.encodedBytes} B, ${run.language}`;

          const io = transport();
          const requests = jameeRequests(run.language, io.fetchImpl);
          const seam = countingSeam(requests.diagnose.bind(requests));
          const storage = uploaderRecording();

          const selected = new File(
            [bytesWithSentinel(run.selectedBytes, run.sentinel)],
            'leaf.jpg',
            { type: 'image/jpeg' },
          );
          expect(selected.size, label).toBe(run.selectedBytes);

          const outcome = await submitCropImage({
            file: selected,
            userId: run.userId,
            upload: storage.upload,
            encode: encoderOf({
              fullBytes: bytesWithSentinel(run.encodedBytes, run.sentinel),
              thumbBytes: bytesWithSentinel(4096, run.sentinel),
            }),
            diagnose: seam.send,
            ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
            now: NOW,
            objectId: run.objectId,
          });

          // The medium was admissible, so exactly one request was made — the counter is proved
          // able to be non-zero here, which is what gives the zeros in the second half meaning.
          expect(outcome.status, label).toBe('sent');
          expect(seam.calls(), label).toBe(1);
          expect(io.helperCalls(), label).toBe(1);
          expect(io.requests, label).toHaveLength(1);

          // Requirement 2.1: the bytes went browser-direct to `crop-images`, both objects.
          expect(storage.paths, label).toHaveLength(2);
          if (outcome.status !== 'sent') return;
          expect(storage.paths, label).toStrictEqual([
            outcome.image.path,
            thumbPathFor(outcome.image.path),
          ]);

          const request = io.requests[0];
          if (request === undefined) throw new Error('no request recorded');

          const { body, bytes } = assertReferenceOnlyRequest(request, {
            endpoint: API_ENDPOINTS.diagnose,
            language: run.language,
            sentinels,
            allowedKeys: Object.keys(diagnoseRequestSchema.shape),
            label,
          });

          // It carries a storage reference, and the route's own schema is what says so.
          const parsed = diagnoseRequestSchema.safeParse(body);
          expect(parsed.success, `${label}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(
            true,
          );
          if (!parsed.success) return;
          expect(parsed.data.image, label).toStrictEqual(outcome.image);
          expect(parsed.data.image.bucket, label).toBe(STORAGE_BUCKETS.cropImages);
          expect(parsed.data.language, label).toBe(run.language);
          expect(parsed.data.conversationId, label).toBe(run.conversationId);

          /**
           * "Independently of the media size", as an equality rather than an inequality: the same
           * submission with a 1-byte photo and the same identifiers produces a body of exactly
           * the same length. A body that grew with the photo would fail here long before it
           * reached the 4.5 MB ceiling.
           */
          const control = transport();
          const controlRequests = jameeRequests(run.language, control.fetchImpl);
          await submitCropImage({
            file: new File([new Uint8Array(1)], 'leaf.jpg', { type: 'image/jpeg' }),
            userId: run.userId,
            upload: uploaderRecording().upload,
            encode: encoderOf({ fullBytes: new Uint8Array(1), thumbBytes: new Uint8Array(1) }),
            diagnose: controlRequests.diagnose.bind(controlRequests),
            ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
            now: NOW,
            objectId: run.objectId,
          });
          const controlBody = control.requests[0]?.init.body;
          expect(typeof controlBody, label).toBe('string');
          expect(bytes, `${label}: body length tracks the media size`).toBe(
            byteLengthOf(controlBody as string),
          );
        },
      ),
      // Each run allocates the generated photo twice (the array and the File's copy), so the count
      // is chosen to cover every size class several times without churning gigabytes.
      { numRuns: 120 },
    );
  });

  /* ======================================================================== */
  /* …and recordings                                                           */
  /* ======================================================================== */

  it('posts a voice-messages reference of constant size for any admissible recording', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: uuidArb,
          objectId: uuidArb,
          conversationId: uuidArb,
          language: languageArb,
          mimeType: fc.constantFrom(
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/mp4',
            'audio/wav',
          ),
          sizeBytes: admissibleSizeArb(MAX_AUDIO_BYTES),
          elapsedMs: fc.oneof(
            fc.constant(1000),
            fc.integer({ min: 10, max: MAX_AUDIO_SECONDS * 1000 }),
            fc.constant(MAX_AUDIO_SECONDS * 1000),
          ),
          sentinel: sentinelArb,
        }),
        async (run) => {
          const sentinels = sentinelSpellings(run.sentinel);
          const label = `${run.mimeType}, ${run.sizeBytes} B, ${run.elapsedMs} ms, ${run.language}`;

          const io = transport();
          const requests = jameeRequests(run.language, io.fetchImpl);
          const seam = countingSeam(requests.voice.bind(requests));
          const storage = uploaderRecording();

          const blob = new Blob([bytesWithSentinel(run.sizeBytes, run.sentinel)], {
            type: run.mimeType,
          });
          expect(blob.size, label).toBe(run.sizeBytes);

          const outcome = await submitVoiceRecording({
            recording: { blob, mimeType: run.mimeType, elapsedMs: run.elapsedMs },
            userId: run.userId,
            conversationId: run.conversationId,
            upload: storage.upload,
            voice: seam.send,
            now: NOW,
            objectId: run.objectId,
          });

          expect(outcome.status, label).toBe('sent');
          expect(seam.calls(), label).toBe(1);
          expect(io.requests, label).toHaveLength(1);

          // Requirement 8.1: browser-direct to `voice-messages`, one object.
          if (outcome.status !== 'sent') return;
          expect(storage.paths, label).toStrictEqual([outcome.audio.path]);

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
          expect(parsed.success, `${label}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(
            true,
          );
          if (!parsed.success) return;
          expect(parsed.data.audio, label).toStrictEqual(outcome.audio);
          expect(parsed.data.audio.bucket, label).toBe(STORAGE_BUCKETS.voiceMessages);
          expect(storageRefSchema.safeParse(parsed.data.audio).success, label).toBe(true);
          expect(parsed.data.durationSeconds, label).toBe(outcome.durationSeconds);
          // The measurement, not the byte count: `voiceRequestSchema` carries no size, so there
          // is no field a client could inflate into a payload.
          expect(parsed.data.durationSeconds, label).toBeLessThanOrEqual(MAX_AUDIO_SECONDS);
          expect(body).not.toHaveProperty('sizeBytes');
          expect(body).not.toHaveProperty('bytes');

          const control = transport();
          const controlRequests = jameeRequests(run.language, control.fetchImpl);
          await submitVoiceRecording({
            recording: {
              blob: new Blob([new Uint8Array(1)], { type: run.mimeType }),
              mimeType: run.mimeType,
              elapsedMs: run.elapsedMs,
            },
            userId: run.userId,
            conversationId: run.conversationId,
            upload: uploaderRecording().upload,
            voice: controlRequests.voice.bind(controlRequests),
            now: NOW,
            objectId: run.objectId,
          });
          const controlBody = control.requests[0]?.init.body;
          expect(typeof controlBody, label).toBe('string');
          expect(bytes, `${label}: body length tracks the recording size`).toBe(
            byteLengthOf(controlBody as string),
          );
        },
      ),
      { numRuns: 120 },
    );
  });
});

/* ========================================================================== */
/* Property 4, second half: nothing runs ahead of a failed upload               */
/* ========================================================================== */

describe('Property 4: the upload boundary never runs ahead of a failed upload', () => {
  /**
   * The things a browser-direct upload really fails with, generated rather than assumed to be an
   * `Error`. `submitCropImage` catches the cause and reports the stage, so a thrown string or a
   * plain object must be handled as squarely as a `StorageError` — otherwise a rejection that was
   * not an `Error` would escape the `catch` and the diagnosis request would never be reached for
   * a different reason than Requirement 15.5 intends.
   */
  const causeArb = fc.oneof(
    fc.constant<unknown>(new Error('network changed')),
    fc.constant<unknown>(new TypeError('Failed to fetch')),
    fc.constant<unknown>({ name: 'StorageApiError', message: 'exceeded bucket quota', status: 413 }),
    fc.constant<unknown>('upstream reset'),
    fc.constant<unknown>(null),
  );

  it('sends no diagnosis request when the full-image upload fails, for any photo and any cause', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: uuidArb,
          objectId: uuidArb,
          language: languageArb,
          selectedBytes: admissibleSizeArb(MAX_IMAGE_BYTES),
          cause: causeArb,
          // A thumbnail the browser could not produce is the same case as one that failed to
          // upload (Requirement 2.14), and neither may change what happens to the full image.
          hasThumbnail: fc.boolean(),
        }),
        async (run) => {
          const label = `${run.selectedBytes} B, cause ${String(run.cause)}`;

          const io = transport();
          const requests = jameeRequests(run.language, io.fetchImpl);
          const seam = countingSeam(requests.diagnose.bind(requests));

          const attempted: string[] = [];
          const upload: ObjectUploader = ({ ref }) => {
            attempted.push(ref.path);
            return Promise.reject(run.cause);
          };

          const outcome = await submitCropImage({
            file: new File(
              [bytesWithSentinel(run.selectedBytes, 'JAMEE-MEDIA-FAILPATH')],
              'leaf.jpg',
              { type: 'image/jpeg' },
            ),
            userId: run.userId,
            upload,
            encode: encoderOf({
              fullBytes: new Uint8Array(4096),
              thumbBytes: run.hasThumbnail ? new Uint8Array(1024) : null,
            }),
            diagnose: seam.send,
            now: NOW,
            objectId: run.objectId,
          });

          // Requirement 15.5, first clause: the failure is reported, and attributed to the upload
          // rather than collapsed into a generic failure the screen could not explain.
          expect(outcome.status, label).toBe('failed');
          if (outcome.status !== 'failed') return;
          expect(outcome.stage, label).toBe('upload');
          expect(outcome.cause, label).toBe(run.cause);

          // Requirement 15.5, second clause, counted at both levels: exactly zero.
          expect(seam.calls(), `${label}: the diagnose seam ran ahead of a failed upload`).toBe(0);
          expect(io.helperCalls(), `${label}: a request reached the transport`).toBe(0);
          expect(io.requests, label).toHaveLength(0);

          // And the thumbnail was never attempted either: the full image is the object the
          // diagnosis reads, so there is nothing left for a derivative to be a derivative of.
          expect(attempted, label).toHaveLength(1);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('sends no voice request when the recording upload fails, for any recording and any cause', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: uuidArb,
          objectId: uuidArb,
          conversationId: uuidArb,
          language: languageArb,
          mimeType: fc.constantFrom('audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4'),
          sizeBytes: admissibleSizeArb(MAX_AUDIO_BYTES),
          elapsedMs: fc.integer({ min: 10, max: MAX_AUDIO_SECONDS * 1000 }),
          cause: causeArb,
        }),
        async (run) => {
          const label = `${run.mimeType}, ${run.sizeBytes} B, cause ${String(run.cause)}`;

          const io = transport();
          const requests = jameeRequests(run.language, io.fetchImpl);
          const seam = countingSeam(requests.voice.bind(requests));

          const outcome = await submitVoiceRecording({
            recording: {
              blob: new Blob([bytesWithSentinel(run.sizeBytes, 'JAMEE-MEDIA-FAILPATH')], {
                type: run.mimeType,
              }),
              mimeType: run.mimeType,
              elapsedMs: run.elapsedMs,
            },
            userId: run.userId,
            conversationId: run.conversationId,
            upload: () => Promise.reject(run.cause),
            voice: seam.send,
            now: NOW,
            objectId: run.objectId,
          });

          expect(outcome.status, label).toBe('failed');
          if (outcome.status !== 'failed') return;
          expect(outcome.stage, label).toBe('upload');
          expect(outcome.cause, label).toBe(run.cause);

          expect(seam.calls(), `${label}: the voice seam ran ahead of a failed upload`).toBe(0);
          expect(io.helperCalls(), `${label}: a request reached the transport`).toBe(0);
          expect(io.requests, label).toHaveLength(0);
        },
      ),
      { numRuns: 150 },
    );
  });

  /* ======================================================================== */
  /* The other direction: the counter can be non-zero after a partial failure   */
  /* ======================================================================== */

  it('still posts the reference when only the thumbnail upload fails (Requirement 2.14)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: uuidArb,
          objectId: uuidArb,
          language: languageArb,
          selectedBytes: admissibleSizeArb(MAX_IMAGE_BYTES),
          cause: causeArb,
          sentinel: sentinelArb,
        }),
        async (run) => {
          const label = `${run.selectedBytes} B, cause ${String(run.cause)}`;

          const io = transport();
          const requests = jameeRequests(run.language, io.fetchImpl);
          const seam = countingSeam(requests.diagnose.bind(requests));

          const landed: string[] = [];
          const upload: ObjectUploader = ({ ref }) => {
            if (ref.path.includes('.thumb.')) return Promise.reject(run.cause);
            landed.push(ref.path);
            return Promise.resolve();
          };

          const outcome = await submitCropImage({
            file: new File([bytesWithSentinel(run.selectedBytes, run.sentinel)], 'leaf.jpg', {
              type: 'image/jpeg',
            }),
            userId: run.userId,
            upload,
            encode: encoderOf({
              fullBytes: bytesWithSentinel(4096, run.sentinel),
              thumbBytes: bytesWithSentinel(1024, run.sentinel),
            }),
            diagnose: seam.send,
            now: NOW,
            objectId: run.objectId,
          });

          expect(outcome.status, label).toBe('sent');
          if (outcome.status !== 'sent') return;
          expect(outcome.thumbnail, label).toBe('failed');

          /**
           * This is the assertion that keeps the two zero-counts above from being vacuous: the
           * same counter, in the same file, reaching exactly one after an upload failure that was
           * not the full image's.
           */
          expect(seam.calls(), label).toBe(1);
          expect(io.requests, label).toHaveLength(1);
          expect(landed, label).toStrictEqual([outcome.image.path]);

          const request = io.requests[0];
          if (request === undefined) throw new Error('no request recorded');
          assertReferenceOnlyRequest(request, {
            endpoint: API_ENDPOINTS.diagnose,
            language: run.language,
            sentinels: sentinelSpellings(run.sentinel),
            allowedKeys: Object.keys(diagnoseRequestSchema.shape),
            label,
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
