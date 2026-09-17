import type { SupabaseClient } from '@supabase/supabase-js';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { SIGNED_URL_EXPIRY_SECONDS, STORAGE_BUCKETS } from '@/lib/config/verified';
import { AppError } from '@/lib/errors';
import { storageRefSchema, STORAGE_PATH_REGEX } from '@/lib/schemas';
import {
  assertOwnership,
  assertOwnershipInBucket,
  buildStorageRef,
  isThumbPath,
  objectSizeOf,
  originalPathFor,
  ownerSegmentOf,
  signedUrlFor,
  signedUrlOrNull,
  thumbPathFor,
  thumbRefFor,
  type ObjectInfoClientLike,
  type StorageClientLike,
} from '@/lib/storage';
import type { Database } from '@/types/database';

/**
 * Unit tests for the parts of `src/lib/storage.ts` that are decidable without a Supabase project:
 * the path convention, the thumbnail inverse pair, and the ordering guarantee inside the ownership
 * gate. The ownership gate's network half is exercised by task 5.3's property test and the
 * integration project.
 *
 * Requirements: 2.5, 2.6, 2.13, 12.5
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const OBJECT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/**
 * A client whose storage surface is a tripwire rather than a stand-in. It returns nothing and
 * fakes nothing; touching it fails the test. That is what lets the mismatch cases below assert
 * something real — not "the right error came back", but "no probe was attempted at all".
 */
function unreachableClient(): StorageClientLike {
  return {
    storage: {
      from() {
        throw new Error('storage was reached; the caller should have rejected before any I/O');
      },
    },
  };
}

/** A client that answers the existence probe honestly for a fixed set of present paths. */
function clientWithObjects(present: readonly string[]): StorageClientLike {
  return {
    storage: {
      from(bucket: string) {
        return {
          exists: (path: string) =>
            Promise.resolve({ data: present.includes(`${bucket}/${path}`), error: null }),
          createSignedUrl: () =>
            Promise.resolve({ data: null, error: new Error('not used in this test') }),
        };
      },
    },
  };
}

/** A client whose existence probe fails at the transport, which is neither present nor absent. */
function clientWithBrokenProbe(): StorageClientLike {
  return {
    storage: {
      from() {
        return {
          exists: () => Promise.reject(new Error('socket hang up')),
          createSignedUrl: () =>
            Promise.resolve({ data: null, error: new Error('not used in this test') }),
        };
      },
    },
  };
}

interface SigningCall {
  bucket: string;
  path: string;
  expiresInSeconds: number;
}

/**
 * A signer that records what it was asked for. The recording is the assertion: V3's `expiresIn` is
 * a number of SECONDS, and the only way to prove Jamee passes seconds is to read the argument that
 * reached the SDK seam.
 */
function recordingSigner(
  calls: SigningCall[],
  outcome: 'ok' | 'error' | 'throw' = 'ok',
): StorageClientLike {
  return {
    storage: {
      from(bucket: string) {
        return {
          exists: () => Promise.resolve({ data: true, error: null }),
          createSignedUrl: (path: string, expiresIn: number) => {
            calls.push({ bucket, path, expiresInSeconds: expiresIn });
            if (outcome === 'throw') return Promise.reject(new Error('socket hang up'));
            if (outcome === 'error') {
              return Promise.resolve({ data: null, error: new Error('Object not found') });
            }
            return Promise.resolve({
              data: { signedUrl: `https://signed.example/${bucket}/${path}` },
              error: null,
            });
          },
        };
      },
    },
  };
}

/* ========================================================================== */
/* buildStorageRef                                                             */
/* ========================================================================== */

describe('buildStorageRef', () => {
  it('produces {user_id}/{YYYY}/{MM}/{uuid}.{ext} and leaves the bucket off the path', () => {
    const ref = buildStorageRef({
      bucket: STORAGE_BUCKETS.cropImages,
      userId: USER,
      extension: 'jpg',
      now: new Date('2026-09-14T10:00:00.000Z'),
      objectId: OBJECT,
    });

    expect(ref).toEqual({
      bucket: 'crop-images',
      path: `${USER}/2026/09/${OBJECT}.jpg`,
    });
    expect(ref.path).not.toContain('crop-images');
  });

  it('zero-pads the month and reads the date in UTC', () => {
    const ref = buildStorageRef({
      bucket: STORAGE_BUCKETS.voiceMessages,
      userId: USER,
      extension: 'webm',
      // 20:00 UTC on 31 January is already 1 February in Asia/Kolkata. The path segments are
      // organizational and explicitly UTC, so this must stay in the January folder.
      now: new Date('2026-01-31T20:00:00.000Z'),
      objectId: OBJECT,
    });
    expect(ref.path).toBe(`${USER}/2026/01/${OBJECT}.webm`);
  });

  it('normalizes a leading dot and uppercase in the extension', () => {
    const ref = buildStorageRef({
      bucket: STORAGE_BUCKETS.cropImages,
      userId: USER,
      extension: '.WEBP',
      now: new Date('2026-09-14T10:00:00.000Z'),
      objectId: OBJECT,
    });
    expect(ref.path.endsWith('.webp')).toBe(true);
  });

  it('emits a path that storageRefSchema accepts, for every accepted image extension', () => {
    for (const extension of ['jpg', 'png', 'webp']) {
      const ref = buildStorageRef({
        bucket: STORAGE_BUCKETS.cropImages,
        userId: USER,
        extension,
        objectId: OBJECT,
      });
      expect(storageRefSchema.safeParse(ref).success).toBe(true);
    }
  });

  it('fails loudly rather than emitting a path the contract would reject', () => {
    expect(() =>
      buildStorageRef({
        bucket: STORAGE_BUCKETS.cropImages,
        userId: 'not-a-uuid',
        extension: 'jpg',
        objectId: OBJECT,
      }),
    ).toThrow(/fails storageRefSchema/);
  });
});

/* ========================================================================== */
/* Thumbnail derivation (Requirement 2.13)                                     */
/* ========================================================================== */

describe('thumbPathFor / originalPathFor', () => {
  it('inserts .thumb immediately before the final extension', () => {
    expect(thumbPathFor('a/2026/09/b.jpg')).toBe('a/2026/09/b.thumb.jpg');
    expect(originalPathFor('a/2026/09/b.thumb.jpg')).toBe('a/2026/09/b.jpg');
  });

  it('keeps the derived path in the same bucket and under the same prefix', () => {
    const ref = { bucket: STORAGE_BUCKETS.cropImages, path: `${USER}/2026/09/${OBJECT}.jpg` };
    const thumb = thumbRefFor(ref);

    expect(thumb.bucket).toBe(ref.bucket);
    expect(ownerSegmentOf(thumb.path)).toBe(USER);
    expect(thumb.path).toBe(`${USER}/2026/09/${OBJECT}.thumb.jpg`);
  });

  it('round-trips paths with an uppercase extension without changing its case', () => {
    expect(thumbPathFor('a/2026/09/b.JPG')).toBe('a/2026/09/b.thumb.JPG');
    expect(originalPathFor('a/2026/09/b.thumb.JPG')).toBe('a/2026/09/b.JPG');
  });

  it('round-trips a path that already contains .thumb., removing exactly one infix', () => {
    const already = 'a/2026/09/b.thumb.jpg';
    expect(thumbPathFor(already)).toBe('a/2026/09/b.thumb.thumb.jpg');
    expect(originalPathFor(thumbPathFor(already))).toBe(already);
  });

  it('round-trips a stem carrying extra dots', () => {
    const dotty = `${USER}/2026/09/${OBJECT}.v2.final.jpg`;
    expect(thumbPathFor(dotty)).toBe(`${USER}/2026/09/${OBJECT}.v2.final.thumb.jpg`);
    expect(originalPathFor(thumbPathFor(dotty))).toBe(dotty);
  });

  it('is an exact inverse across generated paths (Requirement 2.13)', () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/);
    const extension = fc.constantFrom('jpg', 'JPG', 'png', 'webp', 'webm', 'ogg', 'm4a');

    fc.assert(
      fc.property(
        fc.array(segment, { minLength: 0, maxLength: 4 }),
        segment,
        extension,
        (dirs, stem, ext) => {
          const path = [...dirs, stem].join('/') + `.${ext}`;
          const thumb = thumbPathFor(path);

          expect(thumb).not.toBe(path);
          expect(isThumbPath(thumb)).toBe(true);
          expect(originalPathFor(thumb)).toBe(path);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('rejects a path with no extension to insert before', () => {
    expect(() => thumbPathFor('a/2026/09/b')).toThrow(/no file extension/);
    expect(() => thumbPathFor('a/2026/09/.jpg')).toThrow(/no file extension/);
    expect(() => thumbPathFor('a/2026/09/b.')).toThrow(/bare dot/);
  });

  it('rejects deriving an original from something that is not a thumbnail path', () => {
    expect(() => originalPathFor('a/2026/09/b.jpg')).toThrow(/not a Thumbnail_Derivative/);
    // Case-sensitive: only the literal `.thumb` produced by thumbPathFor counts.
    expect(() => originalPathFor('a/2026/09/b.THUMB.jpg')).toThrow(/not a Thumbnail_Derivative/);
    // No original stem left to recover, so this is a derivative of nothing.
    expect(() => originalPathFor('a/2026/09/.thumb.jpg')).toThrow(/not a Thumbnail_Derivative/);
  });
});

describe('isThumbPath', () => {
  it('separates originals from derivatives, which is the sweep predicate', () => {
    expect(isThumbPath('a/2026/09/b.jpg')).toBe(false);
    expect(isThumbPath('a/2026/09/b.thumb.jpg')).toBe(true);
    expect(isThumbPath('a/2026/09/b.thumb.thumb.jpg')).toBe(true);
    expect(isThumbPath('a/2026/09/thumb.jpg')).toBe(false);
    expect(isThumbPath('a/2026/09/.thumb.jpg')).toBe(false);
    expect(isThumbPath('a/2026/09/b')).toBe(false);
  });
});

/* ========================================================================== */
/* storageRefSchema still rejects a thumbnail path                             */
/* ========================================================================== */

describe('the contract still refuses a client-submitted thumbnail path', () => {
  it('accepts an original and rejects its derivative', () => {
    const original = `${USER}/2026/09/${OBJECT}.jpg`;
    const thumb = thumbPathFor(original);

    expect(STORAGE_PATH_REGEX.test(original)).toBe(true);
    // The single-dot rule: widening the regex would let a client submit a Thumbnail_Derivative as
    // the object to diagnose, or submit a fabricated derived path at all.
    expect(STORAGE_PATH_REGEX.test(thumb)).toBe(false);

    expect(
      storageRefSchema.safeParse({ bucket: STORAGE_BUCKETS.cropImages, path: thumb }).success,
    ).toBe(false);
  });
});

/* ========================================================================== */
/* assertOwnership (Requirements 2.5, 2.6)                                     */
/* ========================================================================== */

describe('assertOwnership', () => {
  const path = `${USER}/2026/09/${OBJECT}.jpg`;
  const ref = { bucket: STORAGE_BUCKETS.cropImages, path } as const;

  it('passes when the prefix matches and the object is there', async () => {
    await expect(
      assertOwnership(ref, USER, clientWithObjects([`crop-images/${path}`])),
    ).resolves.toBeUndefined();
  });

  it('rejects another farmer prefix with 403 before touching storage', async () => {
    const error = await assertOwnership(ref, OTHER_USER, unreachableClient()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('STORAGE_REF_FORBIDDEN');
    expect((error as AppError).status).toBe(403);
    expect((error as AppError).context?.reason).toBe('prefix_mismatch');
  });

  it('rejects a malformed reference with 400 before touching storage', async () => {
    const error = await assertOwnership(
      { bucket: STORAGE_BUCKETS.cropImages, path: `${USER}/2026/09/${OBJECT}.thumb.jpg` },
      USER,
      unreachableClient(),
    ).catch((caught: unknown) => caught);

    expect((error as AppError).code).toBe('STORAGE_REF_INVALID');
    expect((error as AppError).status).toBe(400);
  });

  it('rejects an absent object with 403, distinguishable only in the server log', async () => {
    const error = await assertOwnership(ref, USER, clientWithObjects([])).catch(
      (caught: unknown) => caught,
    );

    expect((error as AppError).code).toBe('STORAGE_REF_FORBIDDEN');
    expect((error as AppError).status).toBe(403);
    expect((error as AppError).context?.reason).toBe('object_absent');
    // `details` is the only field that reaches the wire, and neither branch sets one — so a client
    // cannot tell "absent" from "someone else's" (see the note in storage.ts).
    expect((error as AppError).details).toBeUndefined();
  });

  it('reports a failed probe as 500, never as "you do not own this"', async () => {
    const error = await assertOwnership(ref, USER, clientWithBrokenProbe()).catch(
      (caught: unknown) => caught,
    );

    // A transport failure is not a permission fact about the farmer. Reporting it as 403 would
    // tell a farmer their own photo is not theirs during a Storage outage.
    expect((error as AppError).code).toBe('INTERNAL_ERROR');
    expect((error as AppError).status).toBe(500);
    expect((error as AppError).context?.reason).toBe('existence_probe_failed');
  });

  it('narrows to a bucket and refuses the wrong one before touching storage', async () => {
    const error = await assertOwnershipInBucket(
      ref,
      USER,
      STORAGE_BUCKETS.voiceMessages,
      unreachableClient(),
    ).catch((caught: unknown) => caught);

    expect((error as AppError).code).toBe('STORAGE_REF_FORBIDDEN');
    expect((error as AppError).context?.reason).toBe('wrong_bucket');

    await expect(
      assertOwnershipInBucket(
        ref,
        USER,
        STORAGE_BUCKETS.cropImages,
        clientWithObjects([`crop-images/${path}`]),
      ),
    ).resolves.toBeUndefined();
  });
});

/* ========================================================================== */
/* The client seam                                                             */
/* ========================================================================== */

describe('StorageClientLike', () => {
  it('is satisfied by a real Supabase client, checked at compile time', () => {
    // The seam exists so one implementation serves the RLS-scoped server client, the service-role
    // client, and a test double. If a Supabase upgrade changes `exists()` or `createSignedUrl()`,
    // this conditional resolves to `false` and the assignment below stops compiling — which is the
    // point of writing it as a type rather than as a runtime check.
    type RealClientSatisfiesSeam =
      SupabaseClient<Database> extends StorageClientLike ? true : false;
    const holds: RealClientSatisfiesSeam = true;
    expect(holds).toBe(true);
  });
});

/* ========================================================================== */
/* Signed URLs (Requirements 2.8, 12.5) — V3: expiresIn is in SECONDS          */
/* ========================================================================== */

describe('signedUrlOrNull / signedUrlFor', () => {
  const original = { bucket: STORAGE_BUCKETS.cropImages, path: `${USER}/2026/09/${OBJECT}.jpg` };

  it('passes SIGNED_URL_EXPIRY_SECONDS through as seconds by default', async () => {
    const calls: SigningCall[] = [];
    const url = await signedUrlOrNull(original, recordingSigner(calls));

    expect(url).toBe(`https://signed.example/crop-images/${original.path}`);
    expect(calls).toEqual([
      { bucket: 'crop-images', path: original.path, expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS },
    ]);
    // Stated as an interval, not just as a constant: a milliseconds mix-up would show up here as
    // 600_000 rather than 600.
    expect(SIGNED_URL_EXPIRY_SECONDS).toBe(600);
  });

  it('honours an explicit expiry and signs a thumbnail through the same call', async () => {
    const calls: SigningCall[] = [];
    const thumb = thumbRefFor(original);
    const url = await signedUrlFor(thumb, recordingSigner(calls), 60);

    // Requirement 12.5 covers a stored crop image AND a Thumbnail_Derivative, so one function
    // serves both. The thumbnail is signed at its derived path, which no column stores.
    expect(url).toContain('.thumb.jpg');
    expect(calls).toEqual([
      { bucket: 'crop-images', path: thumb.path, expiresInSeconds: 60 },
    ]);
  });

  it('returns null for an object the sweep has already deleted', async () => {
    const calls: SigningCall[] = [];

    // Requirements 18.3 and 18.7 make this an expected state, not an error: the row and the
    // thumbnail survive the Full_Size_Image, and Requirements 12.9/12.10 define what to render.
    await expect(signedUrlOrNull(original, recordingSigner(calls, 'error'))).resolves.toBeNull();
    await expect(signedUrlOrNull(original, recordingSigner(calls, 'throw'))).resolves.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('throws for the diagnosis read path, where absent bytes mean there is nothing to classify', async () => {
    const error = await signedUrlFor(original, recordingSigner([], 'error')).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INTERNAL_ERROR');
    expect((error as AppError).context?.reason).toBe('signed_url_failed');
  });
});

/* ========================================================================== */
/* Object size — Requirement 8.2's size half, and V10's provider cap            */
/* ========================================================================== */

/**
 * A metadata probe with one scripted answer, recording the path it was asked about.
 *
 * The three failure shapes are the ones a real deployment produces: a `StorageError` in the
 * envelope, a thrown transport failure, and a metadata row that simply carries no size. All three
 * must reduce to "no number", because the caller's contract is that an unanswered probe costs the
 * guard rather than the farmer's request.
 */
function infoClient(
  answer: { size?: number } | 'error' | 'throw',
  calls: string[] = [],
): ObjectInfoClientLike {
  return {
    storage: {
      from: () => ({
        info: (path: string) => {
          calls.push(path);
          if (answer === 'throw') return Promise.reject(new Error('storage unreachable'));
          if (answer === 'error') {
            return Promise.resolve({ data: null, error: { message: 'not found' } });
          }
          return Promise.resolve({ data: answer, error: null });
        },
      }),
    },
  };
}

describe('objectSizeOf', () => {
  const audio = { bucket: STORAGE_BUCKETS.voiceMessages, path: `${USER}/2026/09/${OBJECT}.webm` };

  it('reads the size off the object itself', async () => {
    const calls: string[] = [];

    // The point of the probe: the number comes from the object, not from a client's claim about it.
    await expect(objectSizeOf(audio, infoClient({ size: 2_097_152 }, calls))).resolves.toBe(
      2_097_152,
    );
    expect(calls).toEqual([audio.path]);
  });

  it('reports absence rather than throwing, and says so in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      // A recording that is already in the bucket must not be refused over a metadata read, so
      // every one of these is `undefined` and not an error — and none of them is silent, which is
      // what keeps a guard with no input from looking like a guard that passed.
      await expect(objectSizeOf(audio, infoClient('error'))).resolves.toBeUndefined();
      await expect(objectSizeOf(audio, infoClient('throw'))).resolves.toBeUndefined();
      await expect(objectSizeOf(audio, infoClient({}))).resolves.toBeUndefined();
      await expect(objectSizeOf(audio, infoClient({ size: -1 }))).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledTimes(4);
      expect(warn.mock.calls.every((call) => call[0] === '[jamee] object_size_unknown')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('is satisfied by a real Supabase client, checked at compile time', () => {
    // `info()` was read off the pinned package rather than from a V-item (V3 covers
    // `createSignedUrl` only), so a Supabase upgrade that changes its shape stops compiling here.
    type RealClientSatisfiesSeam =
      SupabaseClient<Database> extends ObjectInfoClientLike ? true : false;
    const holds: RealClientSatisfiesSeam = true;
    expect(holds).toBe(true);
  });
});
