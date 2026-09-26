import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import {
  ACCEPTED_IMAGE_TYPES,
  MAX_AUDIO_BYTES,
  REQUEST_BODY_CEILING_BYTES,
} from '@/lib/config/verified';
import { isAppError } from '@/lib/errors';

/**
 * Unit tests for `src/lib/media/index.ts` — the application-level admission wrapper (task 54.1).
 *
 * Requirements: 2.3, 2.4 (an image is admitted on type and size, both stated on rejection), 2.7
 *               (a stored payload stays under the 4.5 MB Request_Body_Ceiling), 8.2, 8.3 (voice is
 *               at most 3 MB under Amendment A3)
 * Design: D17
 *
 * The Data_Access_Layer's GridFS store (`@/lib/db/media`) is mocked, so these tests decide exactly
 * what the wrapper is responsible for — the admission rules — and never open a connection. The
 * store's own behaviour (owner-scoped read/write/delete, existence opacity) is proven by the
 * integration suite against a real GridFS bucket, not restated here.
 */

const store = vi.hoisted(() => ({
  writeMedia: vi.fn<(...args: unknown[]) => Promise<{ fileId: unknown; kind: string }>>(),
  readMediaForOwner: vi.fn(),
  deleteMediaForOwner: vi.fn(),
}));

vi.mock('@/lib/db/media', () => ({
  writeMedia: store.writeMedia,
  readMediaForOwner: store.readMediaForOwner,
  deleteMediaForOwner: store.deleteMediaForOwner,
}));

const { assertAdmissible, storeMedia } = await import('@/lib/media');

const OWNER = '11111111-1111-4111-8111-111111111111';

/** The AppError code a call rejected with, or a thrown failure if it did not reject. */
async function codeOfThrow(fn: () => unknown | Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  throw new Error('expected the call to reject with an AppError');
}

/* ========================================================================== */
/* Kind                                                                        */
/* ========================================================================== */

describe('assertAdmissible — kind', () => {
  it('accepts the three known kinds and returns the narrowed kind', () => {
    expect(assertAdmissible('crop-image', 'image/jpeg', 1000)).toBe('crop-image');
    expect(assertAdmissible('thumbnail', 'image/png', 1000)).toBe('thumbnail');
    expect(assertAdmissible('voice', 'audio/ogg', 1000)).toBe('voice');
  });

  it('rejects an unknown kind as STORAGE_REF_INVALID', async () => {
    expect(await codeOfThrow(() => assertAdmissible('video', 'video/mp4', 1000))).toBe(
      'STORAGE_REF_INVALID',
    );
  });
});

/* ========================================================================== */
/* MIME type                                                                   */
/* ========================================================================== */

describe('assertAdmissible — MIME type', () => {
  it('accepts every image type on the list for an image and a thumbnail', () => {
    for (const type of ACCEPTED_IMAGE_TYPES) {
      expect(assertAdmissible('crop-image', type, 1000)).toBe('crop-image');
      expect(assertAdmissible('thumbnail', type, 1000)).toBe('thumbnail');
    }
  });

  it('rejects a non-image type for an image as FILE_TYPE_UNSUPPORTED', async () => {
    expect(await codeOfThrow(() => assertAdmissible('crop-image', 'image/gif', 1000))).toBe(
      'FILE_TYPE_UNSUPPORTED',
    );
    expect(await codeOfThrow(() => assertAdmissible('crop-image', 'audio/ogg', 1000))).toBe(
      'FILE_TYPE_UNSUPPORTED',
    );
  });

  it('accepts a voice container and rejects a non-audio type as AUDIO_FORMAT_UNSUPPORTED', async () => {
    expect(assertAdmissible('voice', 'audio/webm', 1000)).toBe('voice');
    expect(await codeOfThrow(() => assertAdmissible('voice', 'image/jpeg', 1000))).toBe(
      'AUDIO_FORMAT_UNSUPPORTED',
    );
  });

  it('normalizes a MIME type carrying codec parameters before comparing', () => {
    // A browser reports `audio/webm;codecs=opus`; the bare container is what the list holds.
    expect(assertAdmissible('voice', 'audio/webm;codecs=opus', 1000)).toBe('voice');
    expect(assertAdmissible('crop-image', 'IMAGE/JPEG', 1000)).toBe('crop-image');
  });
});

/* ========================================================================== */
/* Size                                                                        */
/* ========================================================================== */

describe('assertAdmissible — size', () => {
  it('admits an image up to the 4.5 MB Request_Body_Ceiling and rejects above it', async () => {
    expect(assertAdmissible('crop-image', 'image/jpeg', REQUEST_BODY_CEILING_BYTES)).toBe('crop-image');
    expect(
      await codeOfThrow(() => assertAdmissible('crop-image', 'image/jpeg', REQUEST_BODY_CEILING_BYTES + 1)),
    ).toBe('FILE_TOO_LARGE');
  });

  it('admits a voice recording up to 3 MB and rejects above it', async () => {
    expect(assertAdmissible('voice', 'audio/ogg', MAX_AUDIO_BYTES)).toBe('voice');
    expect(await codeOfThrow(() => assertAdmissible('voice', 'audio/ogg', MAX_AUDIO_BYTES + 1))).toBe(
      'AUDIO_TOO_LONG',
    );
  });

  it('rejects a zero-length payload', async () => {
    expect(await codeOfThrow(() => assertAdmissible('crop-image', 'image/jpeg', 0))).toBe('FILE_TOO_LARGE');
  });
});

/* ========================================================================== */
/* storeMedia — validation runs before the store is touched                    */
/* ========================================================================== */

describe('storeMedia', () => {
  it('writes only after admission passes, and forwards the narrowed kind', async () => {
    store.writeMedia.mockReset().mockResolvedValue({ fileId: 'abc', kind: 'crop-image' });

    const ref = await storeMedia(OWNER, 'crop-image', 'image/jpeg', Buffer.from('x'.repeat(1000)));

    expect(ref).toEqual({ fileId: 'abc', kind: 'crop-image' });
    expect(store.writeMedia).toHaveBeenCalledTimes(1);
    expect(store.writeMedia).toHaveBeenCalledWith(
      OWNER,
      'crop-image',
      'image/jpeg',
      expect.any(Buffer),
      undefined,
    );
  });

  it('never touches the store when admission fails', async () => {
    store.writeMedia.mockReset();

    await expect(
      storeMedia(OWNER, 'voice', 'audio/ogg', Buffer.alloc(MAX_AUDIO_BYTES + 1)),
    ).rejects.toMatchObject({ code: 'AUDIO_TOO_LONG' });

    expect(store.writeMedia).not.toHaveBeenCalled();
  });
});
