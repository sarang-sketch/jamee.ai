import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { API_ENDPOINTS, jameeRequests } from '@/components/LanguageProvider';
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  REQUEST_BODY_CEILING_BYTES,
} from '@/lib/config/verified';
import { FULL_SIZE_MAX_EDGE_PX, THUMBNAIL_MAX_EDGE_PX } from '@/lib/config/media';
import { diagnoseRequestSchema, SUPPORTED_LANGUAGES, type MediaRef } from '@/lib/schemas';

import {
  admissionCode,
  encodeCropImage,
  imageHint,
  rejectionMessage,
  REENCODE_EXTENSION,
  REENCODE_TYPE,
  scaledSize,
  submitCropImage,
  type CropImageEncoder,
  type EncodedCropImage,
  type MediaUploader,
} from './ImageUploader';

/**
 * Unit tests for the decisions `ImageUploader` makes around the network (Amendment A3): which files
 * are admitted, what a rejection says, and the ORDER of upload and diagnosis request.
 *
 * Requirements: 2.1 (upload to the Media_Endpoint, then the reference only), 2.3 / 2.4 (accepted
 *               types and the 10 MB limit, both stated on a rejection), 2.9 (admission on the
 *               selected file, before any re-encode), 2.12 (resolution is not traded for bytes),
 *               2.13 (the thumbnail is uploaded as a separate `thumbnail` file), 2.14 (a failed
 *               thumbnail still sends the diagnosis), 15.5 (a failed full-image upload sends nothing)
 *
 * Under A3 the uploader returns a Media_Reference (`{ fileId, kind }`) from `POST /api/media`, not a
 * Supabase storage path — so there is no path convention to assert and the posted body carries a
 * reference plus an optional thumbnail reference.
 *
 * The DOM half is left to the accessibility pass and the manual plan, following
 * `SignInForm.test.tsx`: this project has no React testing library, and the rules that matter here
 * are about sequencing. `encodeCropImage` is never called: jsdom has neither `createImageBitmap` nor
 * a canvas encoder, so what IS tested is the pure resolution decision `scaledSize`.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const USER_ID = '11111111-1111-4111-8111-111111111111';

/** The references the media endpoint returns for the full image and the thumbnail. */
const IMAGE_REF: MediaRef = { fileId: 'a'.repeat(24), kind: 'crop-image' };
const THUMB_REF: MediaRef = { fileId: 'b'.repeat(24), kind: 'thumbnail' };

function jpegFile(name = 'leaf.jpg'): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: 'image/jpeg' });
}

/** An encoder that produces predictable blobs without touching a canvas. */
function stubEncoder(options: { thumbnail: boolean } = { thumbnail: true }): CropImageEncoder {
  return async () => {
    const encoded: EncodedCropImage = {
      full: new Blob(['full-image-bytes'], { type: REENCODE_TYPE }),
      thumbnail: options.thumbnail ? new Blob(['thumb-bytes'], { type: REENCODE_TYPE }) : null,
      contentType: REENCODE_TYPE,
      extension: REENCODE_EXTENSION,
      outcome: { width: 1600, height: 1200, quality: 0.72, reachedTarget: true },
    };
    return encoded;
  };
}

interface RecordedUpload {
  kind: MediaRef['kind'];
  size: number;
  type: string;
}

interface Recorder {
  uploads: RecordedUpload[];
  bodies: unknown[];
  upload: MediaUploader;
  diagnose: (body: unknown) => Promise<Response>;
}

/**
 * Records what would have gone to the Media_Endpoint and to `/api/diagnose`, and hands back the
 * reference each upload would have produced.
 *
 * `failOn` names a kind whose upload throws, which is how the two failure requirements are
 * expressed: `'crop-image'` fails the full image (15.5), `'thumbnail'` fails the thumbnail (2.14).
 */
function recorder(failOn?: (kind: MediaRef['kind']) => boolean): Recorder {
  const uploads: RecordedUpload[] = [];
  const bodies: unknown[] = [];
  return {
    uploads,
    bodies,
    upload: async ({ body, kind }) => {
      if (failOn?.(kind) === true) throw new Error(`upload refused: ${kind}`);
      uploads.push({ kind, size: body.size, type: body.type });
      return kind === 'thumbnail' ? THUMB_REF : IMAGE_REF;
    },
    diagnose: async (body) => {
      bodies.push(body);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

function submit(
  overrides: {
    file?: File;
    upload?: MediaUploader;
    encode?: CropImageEncoder;
    diagnose?: (body: unknown) => Promise<Response>;
  } = {},
) {
  const io = recorder();
  return submitCropImage({
    file: overrides.file ?? jpegFile(),
    userId: USER_ID,
    upload: overrides.upload ?? io.upload,
    encode: overrides.encode ?? stubEncoder(),
    diagnose: overrides.diagnose ?? io.diagnose,
  });
}

/* ========================================================================== */
/* Admission (Requirements 2.3, 2.4, 2.9)                                      */
/* ========================================================================== */

describe('admissionCode', () => {
  it('admits every accepted type, right up to and including the 10 MB limit', () => {
    for (const type of ACCEPTED_IMAGE_TYPES) {
      expect(admissionCode({ type, size: 1 })).toBeNull();
      expect(admissionCode({ type, size: 4 * 1024 * 1024 })).toBeNull();
      expect(admissionCode({ type, size: MAX_IMAGE_BYTES })).toBeNull();
    }
  });

  it('rejects one byte over the limit', () => {
    expect(admissionCode({ type: 'image/jpeg', size: MAX_IMAGE_BYTES + 1 })).toBe('FILE_TOO_LARGE');
  });

  it('rejects a type outside the accepted three', () => {
    for (const type of ['image/gif', 'image/heic', 'image/svg+xml', 'application/pdf', '']) {
      expect(admissionCode({ type, size: 1024 })).toBe('FILE_TYPE_UNSUPPORTED');
    }
    expect(admissionCode({ type: 'image/jpg', size: 1024 })).toBe('FILE_TYPE_UNSUPPORTED');
    expect(admissionCode({ type: 'IMAGE/JPEG', size: 1024 })).toBe('FILE_TYPE_UNSUPPORTED');
  });

  it('reports the wrong kind of file before the wrong size', () => {
    expect(admissionCode({ type: 'application/pdf', size: MAX_IMAGE_BYTES + 1 })).toBe(
      'FILE_TYPE_UNSUPPORTED',
    );
  });

  it('does not admit a zero-byte file by accident of the size check alone', () => {
    expect(admissionCode({ type: 'image/jpeg', size: 0 })).toBeNull();
  });
});

describe('rejectionMessage', () => {
  const namesBothFacts = (message: string): void => {
    expect(message).toContain('JPG');
    expect(message).toContain('PNG');
    expect(message).toContain('WebP');
    expect(message).toContain('10');
    expect(message).toContain('MB');
  };

  it('states the accepted types and the size limit for a wrong type, in every language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      namesBothFacts(rejectionMessage('FILE_TYPE_UNSUPPORTED', language));
    }
  });

  it('states the accepted types and the size limit for a too-large file, in every language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      namesBothFacts(rejectionMessage('FILE_TOO_LARGE', language));
    }
  });

  it('keeps the too-large reason distinct from the shared instruction', () => {
    const tooLarge = rejectionMessage('FILE_TOO_LARGE', 'en');
    const wrongType = rejectionMessage('FILE_TYPE_UNSUPPORTED', 'en');
    expect(tooLarge).not.toBe(wrongType);
    expect(tooLarge.endsWith(wrongType)).toBe(true);
  });

  it('renders the limit from MAX_IMAGE_BYTES rather than a hand-written number', () => {
    const megabytes = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));
    expect(rejectionMessage('FILE_TOO_LARGE', 'en')).toContain(`${megabytes} MB`);
    expect(rejectionMessage('FILE_TOO_LARGE', 'en')).not.toContain('{maxMb}');
  });
});

describe('imageHint', () => {
  it('states the accepted types and the limit before anything is chosen', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const hint = imageHint(language);
      expect(hint).toContain('JPG');
      expect(hint).toContain('PNG');
      expect(hint).toContain('WebP');
      expect(hint).toContain('10');
      expect(hint).toContain('MB');
      expect(hint).not.toContain('{maxMb}');
    }
  });
});

/* ========================================================================== */
/* Re-encode target (Requirements 2.10, 2.12)                                  */
/* ========================================================================== */

describe('re-encode output format', () => {
  it('produces an Accepted_Image_Type (Requirement 2.10)', () => {
    const accepted: readonly string[] = ACCEPTED_IMAGE_TYPES;
    expect(accepted).toContain(REENCODE_TYPE);
  });

  it('is a function, not a value — the canvas paths are not exercised under jsdom', () => {
    expect(typeof encodeCropImage).toBe('function');
  });
});

describe('scaledSize', () => {
  it('caps the longest edge and keeps the aspect ratio', () => {
    expect(scaledSize(4000, 3000, FULL_SIZE_MAX_EDGE_PX)).toEqual({ width: 1600, height: 1200 });
    expect(scaledSize(3000, 4000, FULL_SIZE_MAX_EDGE_PX)).toEqual({ width: 1200, height: 1600 });
  });

  it('never upscales — Requirement 2.12 is about keeping detail, not inventing it', () => {
    expect(scaledSize(800, 600, FULL_SIZE_MAX_EDGE_PX)).toEqual({ width: 800, height: 600 });
    expect(scaledSize(FULL_SIZE_MAX_EDGE_PX, 900, FULL_SIZE_MAX_EDGE_PX)).toEqual({
      width: FULL_SIZE_MAX_EDGE_PX,
      height: 900,
    });
  });

  it('holds the resolution floor: a huge photo never lands below the cap', () => {
    for (const [w, h] of [
      [8000, 6000],
      [6000, 8000],
      [12000, 900],
    ] as const) {
      const size = scaledSize(w, h, FULL_SIZE_MAX_EDGE_PX);
      expect(Math.max(size.width, size.height)).toBe(FULL_SIZE_MAX_EDGE_PX);
    }
  });

  it('shrinks the thumbnail far harder than the full image', () => {
    const thumb = scaledSize(4000, 3000, THUMBNAIL_MAX_EDGE_PX);
    expect(Math.max(thumb.width, thumb.height)).toBe(THUMBNAIL_MAX_EDGE_PX);
    expect(thumb.width).toBeLessThan(scaledSize(4000, 3000, FULL_SIZE_MAX_EDGE_PX).width);
  });

  it('never rounds an edge down to zero', () => {
    expect(scaledSize(10000, 1, THUMBNAIL_MAX_EDGE_PX)).toEqual({ width: 320, height: 1 });
  });
});

/* ========================================================================== */
/* Sequencing (Requirements 2.1, 2.13, 2.14, 15.5)                             */
/* ========================================================================== */

describe('submitCropImage', () => {
  it('uploads the full image and its thumbnail, then posts the references', async () => {
    const io = recorder();
    const outcome = await submit({ upload: io.upload, diagnose: io.diagnose });

    expect(outcome.status).toBe('sent');
    if (outcome.status !== 'sent') return;

    expect(outcome.thumbnail).toBe('uploaded');
    expect(io.uploads).toHaveLength(2);
    expect(io.bodies).toHaveLength(1);

    // Requirement 2.1 — the full image is uploaded as a `crop-image` file and its reference returned.
    expect(io.uploads[0]?.kind).toBe('crop-image');
    expect(outcome.image).toEqual(IMAGE_REF);
  });

  it('uploads the thumbnail as a separate thumbnail-kind file (Requirement 2.13)', async () => {
    const io = recorder();
    const outcome = await submit({ upload: io.upload, diagnose: io.diagnose });
    if (outcome.status !== 'sent') throw new Error(`expected sent, got ${outcome.status}`);

    const [full, thumb] = io.uploads;
    // Full first (2.14's ordering), then the thumbnail as its own kind.
    expect(full?.kind).toBe('crop-image');
    expect(thumb?.kind).toBe('thumbnail');
    // Both objects carry the one output MIME type.
    expect(full?.type).toBe(REENCODE_TYPE);
    expect(thumb?.type).toBe(REENCODE_TYPE);
  });

  it('posts the references and no media bytes (Requirements 2.1, 2.2, 2.7)', async () => {
    const io = recorder();
    const outcome = await submit({ upload: io.upload, diagnose: io.diagnose });
    if (outcome.status !== 'sent') throw new Error(`expected sent, got ${outcome.status}`);

    const [body] = io.bodies;
    expect(body).toEqual({ image: IMAGE_REF, thumbnail: THUMB_REF });

    // Nothing binary anywhere in the body, at any depth.
    const walk = (value: unknown): void => {
      expect(value instanceof Blob).toBe(false);
      expect(value instanceof ArrayBuffer).toBe(false);
      expect(ArrayBuffer.isView(value)).toBe(false);
      if (value !== null && typeof value === 'object') {
        for (const nested of Object.values(value)) walk(nested);
      }
    };
    walk(body);

    // The serialized body stays a reference in size, whatever the photo weighed.
    expect(JSON.stringify(body).length).toBeLessThan(256);
  });

  it('sends no diagnosis request when the full-image upload fails (Requirement 15.5)', async () => {
    const io = recorder((kind) => kind === 'crop-image');
    const outcome = await submit({ upload: io.upload, diagnose: io.diagnose });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.stage).toBe('upload');

    // The whole of 15.5: nothing was posted, and the thumbnail was not attempted either.
    expect(io.bodies).toHaveLength(0);
    expect(io.uploads).toHaveLength(0);
  });

  it('still sends the diagnosis request when only the thumbnail fails (Requirement 2.14)', async () => {
    const io = recorder((kind) => kind === 'thumbnail');
    const outcome = await submit({ upload: io.upload, diagnose: io.diagnose });

    expect(outcome.status).toBe('sent');
    if (outcome.status !== 'sent') return;

    expect(outcome.thumbnail).toBe('failed');
    // The full image landed; the request went out carrying the image reference and NO thumbnail.
    expect(io.uploads.map((u) => u.kind)).toEqual(['crop-image']);
    expect(io.bodies).toEqual([{ image: IMAGE_REF }]);
  });

  it('still sends the diagnosis request when no thumbnail could be encoded', async () => {
    const io = recorder();
    const outcome = await submit({
      upload: io.upload,
      diagnose: io.diagnose,
      encode: stubEncoder({ thumbnail: false }),
    });

    expect(outcome.status).toBe('sent');
    if (outcome.status !== 'sent') return;
    expect(outcome.thumbnail).toBe('failed');
    expect(io.uploads).toHaveLength(1);
    expect(io.bodies).toEqual([{ image: IMAGE_REF }]);
  });

  it('declines a wrong type before any byte leaves the browser (Requirements 2.4, 2.9)', async () => {
    const io = recorder();
    const outcome = await submitCropImage({
      file: new File(['%PDF-1.4'], 'notes.pdf', { type: 'application/pdf' }),
      userId: USER_ID,
      upload: io.upload,
      encode: stubEncoder(),
      diagnose: io.diagnose,
    });

    expect(outcome).toEqual({ status: 'rejected', code: 'FILE_TYPE_UNSUPPORTED' });
    expect(io.uploads).toHaveLength(0);
    expect(io.bodies).toHaveLength(0);
  });

  it('declines a file over the 10 MB limit before re-encoding it (Requirements 2.4, 2.9)', async () => {
    const io = recorder();
    let encoderCalls = 0;
    const counting: CropImageEncoder = async (blob) => {
      encoderCalls += 1;
      return stubEncoder()(blob);
    };

    const outcome = await submitCropImage({
      file: new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'huge.jpg', { type: 'image/jpeg' }),
      userId: USER_ID,
      upload: io.upload,
      encode: counting,
      diagnose: io.diagnose,
    });

    expect(outcome).toEqual({ status: 'rejected', code: 'FILE_TOO_LARGE' });
    expect(encoderCalls).toBe(0);
    expect(io.uploads).toHaveLength(0);
    expect(io.bodies).toHaveLength(0);
  });

  it('reports a re-encode failure and uploads nothing', async () => {
    const io = recorder();
    const outcome = await submit({
      upload: io.upload,
      diagnose: io.diagnose,
      encode: async () => {
        throw new Error('undecodable image');
      },
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.stage).toBe('encode');
    expect(io.uploads).toHaveLength(0);
    expect(io.bodies).toHaveLength(0);
  });

  it('reports a diagnosis request that never produced a response', async () => {
    const io = recorder();
    const outcome = await submit({
      upload: io.upload,
      diagnose: async () => {
        throw new TypeError('network failure');
      },
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.stage).toBe('diagnose');
    // Both objects are in GridFS; the sweep's orphan scan is what reclaims them.
    expect(io.uploads).toHaveLength(2);
  });

  it('attaches an existing conversation when the screen has one (Requirement 2.2)', async () => {
    const io = recorder();
    const conversationId = '33333333-3333-4333-8333-333333333333';
    const outcome = await submitCropImage({
      file: jpegFile(),
      userId: USER_ID,
      upload: io.upload,
      encode: stubEncoder(),
      diagnose: io.diagnose,
      conversationId,
    });

    if (outcome.status !== 'sent') throw new Error(`expected sent, got ${outcome.status}`);
    expect(io.bodies).toEqual([{ image: IMAGE_REF, thumbnail: THUMB_REF, conversationId }]);
  });
});

/* ========================================================================== */
/* Boundary matrix + failure attribution + the posted body                     */
/* ========================================================================== */

const BOUNDARY_SIZES = [
  { label: 'empty', bytes: 0 },
  { label: 'one byte', bytes: 1 },
  { label: 'well under the limit', bytes: 4 * 1024 * 1024 },
  { label: 'one byte under the limit', bytes: MAX_IMAGE_BYTES - 1 },
  { label: 'exactly the limit', bytes: MAX_IMAGE_BYTES },
  { label: 'one byte over the limit', bytes: MAX_IMAGE_BYTES + 1 },
  { label: 'far over the limit', bytes: MAX_IMAGE_BYTES * 3 },
] as const;

const REFUSED_TYPES = ['image/heic', 'image/avif', 'image/gif', 'application/pdf', ''] as const;

describe('image admission over the 10 MB boundary, type and size together', () => {
  const megabytes = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));

  it('admits or refuses every type/size combination, and every refusal states both facts', () => {
    const outcomes = new Set<string>();

    for (const type of [...ACCEPTED_IMAGE_TYPES, ...REFUSED_TYPES]) {
      const typeAccepted = (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type);

      for (const size of BOUNDARY_SIZES) {
        const where = `type "${type}", ${size.label} (${size.bytes} B)`;

        const admissible = typeAccepted && size.bytes <= MAX_IMAGE_BYTES;
        const code = admissionCode({ type, size: size.bytes });

        expect(code === null, where).toBe(admissible);
        outcomes.add(code ?? 'admitted');
        if (code === null) continue;

        expect(code, where).toBe(typeAccepted ? 'FILE_TOO_LARGE' : 'FILE_TYPE_UNSUPPORTED');

        for (const language of SUPPORTED_LANGUAGES) {
          const message = rejectionMessage(code, language);
          for (const fact of ['JPG', 'PNG', 'WebP', `${megabytes} MB`]) {
            expect(message, `${where} in ${language}: must state "${fact}"`).toContain(fact);
          }
          expect(message, `${where} in ${language}`).not.toContain('{');
        }
      }
    }

    expect([...outcomes].sort()).toStrictEqual(
      ['FILE_TOO_LARGE', 'FILE_TYPE_UNSUPPORTED', 'admitted'].sort(),
    );
  });

  it('turns on the byte, not on the megabyte', async () => {
    const io = recorder();
    const admitted = await submit({
      file: new File([new Uint8Array(MAX_IMAGE_BYTES)], 'exactly-10mb.jpg', { type: 'image/jpeg' }),
      upload: io.upload,
      diagnose: io.diagnose,
    });
    expect(admitted.status).toBe('sent');

    const refused = await submit({
      file: new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'one-byte-over.jpg', {
        type: 'image/jpeg',
      }),
      upload: io.upload,
      diagnose: io.diagnose,
    });
    expect(refused).toEqual({ status: 'rejected', code: 'FILE_TOO_LARGE' });
  });
});

describe('a failed upload produces an upload error', () => {
  it('reports the upload stage and keeps the cause, whatever the uploader threw', async () => {
    const causes: readonly unknown[] = [
      new Error('media endpoint refused the object'),
      new TypeError('Failed to fetch'),
      { name: 'MediaUploadError', message: 'file too large', status: 400 },
      'upstream reset',
      null,
    ];

    for (const cause of causes) {
      const io = recorder();
      const outcome = await submit({
        upload: () => Promise.reject(cause),
        diagnose: io.diagnose,
      });

      expect(outcome.status, String(cause)).toBe('failed');
      if (outcome.status !== 'failed') continue;
      expect(outcome.stage, String(cause)).toBe('upload');
      expect(outcome.cause, String(cause)).toBe(cause);
      expect(io.bodies, String(cause)).toHaveLength(0);
    }
  });

  it('keeps the three failure stages distinguishable', async () => {
    const encodeIo = recorder();
    const encodeFailure = await submit({
      upload: encodeIo.upload,
      diagnose: encodeIo.diagnose,
      encode: () => Promise.reject(new Error('undecodable')),
    });
    expect(encodeFailure.status === 'failed' && encodeFailure.stage).toBe('encode');
    expect(encodeIo.uploads).toHaveLength(0);
    expect(encodeIo.bodies).toHaveLength(0);

    const uploadIo = recorder(() => true);
    const uploadFailure = await submit({ upload: uploadIo.upload, diagnose: uploadIo.diagnose });
    expect(uploadFailure.status === 'failed' && uploadFailure.stage).toBe('upload');
    expect(uploadIo.uploads).toHaveLength(0);
    expect(uploadIo.bodies).toHaveLength(0);

    const diagnoseIo = recorder();
    const diagnoseFailure = await submit({
      upload: diagnoseIo.upload,
      diagnose: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    expect(diagnoseFailure.status === 'failed' && diagnoseFailure.stage).toBe('diagnose');
    expect(diagnoseIo.uploads).toHaveLength(2);
  });
});

describe('the posted request body, as the transport actually builds it', () => {
  /**
   * Wired through the real `jameeRequests`, with a recording `fetch` seam, so what is asserted is
   * the `RequestInit` rather than the `DiagnoseBody`. The upload seam returns fixed Media_References
   * so the body is deterministic; the encode seam plants a sentinel in the bytes so a leak of the
   * image into the request body would be visible.
   */
  async function postedRequest(options: { language: 'en' | 'hi' | 'mr'; mediaBytes: number }) {
    const sentinel = 'JAMEE-MEDIA-SENTINEL';
    const marker = new TextEncoder().encode(sentinel);
    const media = new Uint8Array(options.mediaBytes);
    for (let offset = 0; offset + marker.length <= media.length; offset += marker.length) {
      media.set(marker, offset);
    }

    const urls: string[] = [];
    const captured: RequestInit[] = [];
    const requests = jameeRequests(options.language, (url, init) => {
      urls.push(url);
      captured.push(init);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const outcome = await submitCropImage({
      file: new File([media], 'leaf.jpg', { type: 'image/jpeg' }),
      userId: USER_ID,
      // The uploader never puts the bytes on the diagnose request — it returns a reference.
      upload: async ({ kind }) => (kind === 'thumbnail' ? THUMB_REF : IMAGE_REF),
      encode: async () => ({
        full: new Blob([media], { type: REENCODE_TYPE }),
        thumbnail: new Blob([media.slice(0, 1024)], { type: REENCODE_TYPE }),
        contentType: REENCODE_TYPE,
        extension: REENCODE_EXTENSION,
        outcome: { width: 1600, height: 1200, quality: 0.72, reachedTarget: true },
      }),
      diagnose: (body) => requests.diagnose(body),
    });

    return { outcome, urls, captured, sentinel, media };
  }

  it('sends a JSON body carrying the media references (Requirements 2.1, 2.2)', async () => {
    const { outcome, urls, captured } = await postedRequest({ language: 'en', mediaBytes: 4096 });
    if (outcome.status !== 'sent') throw new Error(`expected sent, got ${outcome.status}`);

    expect(urls).toStrictEqual([`${API_ENDPOINTS.diagnose}?language=en`]);
    expect(captured).toHaveLength(1);
    const [init] = captured;
    expect(init?.method).toBe('POST');
    expect(init?.headers).toStrictEqual({ 'content-type': 'application/json' });
    expect(typeof init?.body).toBe('string');

    const parsed = diagnoseRequestSchema.safeParse(JSON.parse(init?.body as string));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.image).toStrictEqual(IMAGE_REF);
    expect(parsed.data.image.kind).toBe('crop-image');
    expect(parsed.data.thumbnail).toStrictEqual(THUMB_REF);
    expect(parsed.data.language).toBe('en');
  });

  it('carries no media bytes in any encoding, and no field outside the schema', async () => {
    const { outcome, captured, sentinel } = await postedRequest({
      language: 'mr',
      mediaBytes: 64 * 1024,
    });
    if (outcome.status !== 'sent') throw new Error(`expected sent, got ${outcome.status}`);

    const serialized = captured[0]?.body as string;

    const bytes = new TextEncoder().encode(sentinel);
    for (const spelling of [
      sentinel,
      Buffer.from(bytes).toString('base64').replace(/=+$/, ''),
      Buffer.from(bytes).toString('hex'),
    ]) {
      expect(serialized.includes(spelling), `body carries media bytes as "${spelling}"`).toBe(false);
    }

    const body: unknown = JSON.parse(serialized);
    expect(Object.keys(body as object).sort()).toStrictEqual(['image', 'language', 'thumbnail']);
    const walk = (value: unknown, path: string): void => {
      expect(Array.isArray(value), `array at ${path}`).toBe(false);
      expect(value instanceof Blob, `Blob at ${path}`).toBe(false);
      expect(ArrayBuffer.isView(value), `typed array at ${path}`).toBe(false);
      if (value !== null && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) walk(nested, `${path}.${key}`);
      }
    };
    walk(body, 'body');
  });

  it('stays the same size whatever the photo weighed, far below the platform ceiling', async () => {
    const lengths: number[] = [];
    for (const mediaBytes of [1, 4096, 512 * 1024, MAX_IMAGE_BYTES]) {
      const { captured } = await postedRequest({ language: 'hi', mediaBytes });
      const serialized = captured[0]?.body as string;
      lengths.push(new TextEncoder().encode(serialized).length);
    }

    expect(new Set(lengths).size).toBe(1);
    expect(lengths[0]).toBeLessThan(512);
    expect(lengths[0]).toBeLessThan(REQUEST_BODY_CEILING_BYTES);
  });
});
