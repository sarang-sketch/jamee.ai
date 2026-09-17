import { STORAGE_BUCKETS, type StorageBucket } from '@/lib/config/verified';
import { buildStorageRef, type StorageClientLike } from '@/lib/storage';
import type { StorageRef } from '@/lib/schemas';
import type { MediaUploadClientLike } from '@/lib/whatsapp';
import type { ObjectRemoveClient } from '@/services/voice.service';

/**
 * Uploaded objects, as the two questions the services actually ask about them.
 *
 * Requirements: 2.5 / 2.6 (a reference outside the farmer's own prefix, or naming the wrong bucket,
 *               is refused before anything is spent), 2.8 (the provider receives a signed,
 *               time-limited URL and never the bytes)
 * Design: D1 (upload to Storage from the browser, then post a reference)
 *
 * =============================================================================
 * THE ONE SUPABASE SURFACE THE HARNESS FAKES, AND WHY THAT IS HONEST
 * =============================================================================
 *
 * Postgres, PostgREST, Auth and RLS are all real in this harness. Storage is not: the services reach
 * it through narrow structural types — `StorageClientLike`'s `exists` and `createSignedUrl`,
 * `ObjectRemoveClient`'s `remove`, `MediaUploadClientLike`'s `upload` — and this module implements
 * those four methods over a `Set` of paths.
 *
 * What that keeps real is everything the requirements put on this path. `assertOwnership()` runs for
 * real, so the prefix comparison, the bucket comparison and `storageRefSchema`'s path grammar all
 * decide the outcome — including `exists()`'s three-way result, which is why absence is modelled as
 * `data: false` and a probe failure as a throw. What it drops is Storage's own path policies from
 * `0009_storage_buckets_policies.sql`, which are asserted by `scripts/check-deployment.ts` against a
 * live project instead.
 *
 * The alternative — uploading real bytes to the local Storage service — is available and needs no
 * change here: pass the farmer's own `client` as a service's `storage` dependency, since
 * `SupabaseClient` satisfies `StorageClientLike` structurally. It is not what the harness does by
 * default because it would make every scenario depend on a fixture image and on the signed-URL
 * expiry clock, to assert a boundary the provider stub never crosses: the URL is handed to a stubbed
 * SDK call that does not fetch it.
 */
/**
 * One `createSignedUrl` call.
 *
 * The expiry is recorded in the unit the API takes — **seconds**, per V3 — because that unit is the
 * one thing about signed URLs this codebase has to keep saying out loud, and a scenario asserting
 * Requirement 2.8's time limit should be reading a number rather than trusting a name.
 */
export interface SignedUrlRequest {
  readonly bucket: string;
  readonly path: string;
  readonly expiresInSeconds: number;
}

/** One `remove()` call, as the API takes it: bucket-relative paths, never `bucket/path` (V22). */
export interface RemoveRequest {
  readonly bucket: string;
  readonly paths: readonly string[];
}

/** One `upload()` call — the WhatsApp media path's service-role write (Requirements 10.4, 10.6). */
export interface UploadRequest {
  readonly bucket: string;
  readonly path: string;
  readonly bytes: number;
  readonly contentType: string | undefined;
}

/**
 * The four methods the services call on `storage.from(bucket)`, in one surface.
 *
 * `remove` and `upload` were added when the scenario suites needed them, and they belong **here**
 * rather than in each suite: `VoiceDeps.deleter` needs `storage.from(bucket).remove(paths)` and
 * `storeInboundMedia`'s client needs `storage.from(bucket).upload(...)`, so a store that offered
 * removal only as a top-level `remove(ref)` helper forced every voice or WhatsApp-media scenario to
 * compose a local bridge object. Four suites composing the same bridge four times is four chances to
 * bridge it slightly differently — and one of them getting the bucket narrowing wrong would aim a
 * delete at a bucket the harness does not model, which is a silent pass rather than a failure.
 */
/**
 * `remove` and `upload` as the production types declare them, rather than retyped here.
 *
 * Derived so a signature change in `voice.service.ts` or `whatsapp.ts` breaks **this file** instead
 * of breaking a scenario with a message about an incompatible argument — which is the difference
 * between "the harness is out of date" and "the test is wrong".
 */
type RemoveSeam = ReturnType<ObjectRemoveClient['storage']['from']>;
type UploadSeam = ReturnType<MediaUploadClientLike['storage']['from']>;

interface TestBucket extends RemoveSeam, UploadSeam {
  exists(path: string): Promise<{ data: boolean; error: unknown }>;
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<{ data: { signedUrl: string }; error: null } | { data: null; error: unknown }>;
}

/**
 * Satisfies `StorageClientLike` (the read seam), `ObjectRemoveClient` (`VoiceDeps.deleter`, the
 * retention sweep) and `MediaUploadClientLike` (`storeInboundMedia`) at once.
 *
 * Stated as one interface rather than by extending all three, because they each declare a `storage`
 * property and TypeScript refuses an interface that extends conflicting members of the same name.
 * The three imports above are what keep this honest: `remove`'s and `upload`'s shapes are read off
 * the production types, so a signature change there breaks this file rather than a scenario.
 */
export interface TestObjectStore extends StorageClientLike {
  storage: { from(bucket: string): TestBucket };
  /** Record an object as present, so the ownership check finds it. */
  put(ref: StorageRef): StorageRef;
  /** Forget it, e.g. to reproduce a retention sweep having deleted the original. */
  remove(ref: StorageRef): void;
  has(ref: StorageRef): boolean;
  /** Every `createSignedUrl` call, in order. */
  readonly signed: SignedUrlRequest[];
  /** Every `remove()` call, in order — including one for a path that was already gone. */
  readonly removed: RemoveRequest[];
  /** Every `upload()` call, in order. */
  readonly uploaded: UploadRequest[];
  /** Set to make the existence probe throw — Requirement 15.6's `INTERNAL_ERROR` branch. */
  failProbe: boolean;
  /** Set to make `remove()` report an error — Requirement 8.9's `remove_failed` disposition. */
  failRemove: boolean;
}

const keyOf = (bucket: string, path: string): string => `${bucket}/${path}`;

/**
 * A signed URL that looks like the real thing and resolves to nothing.
 *
 * Shaped after Supabase's `/storage/v1/object/sign/...?token=...` because the string reaches the
 * provider request body, and a scenario asserting "the provider was given a signed URL for the
 * farmer's own object" should be reading a plausible value rather than a sentinel.
 */
function signedUrlFor(bucket: string, path: string): string {
  return `https://jamee-integration.invalid/storage/v1/object/sign/${bucket}/${path}?token=integration`;
}

export function objectStore(): TestObjectStore {
  const present = new Set<string>();
  const signed: SignedUrlRequest[] = [];
  const removed: RemoveRequest[] = [];
  const uploaded: UploadRequest[] = [];

  const store: TestObjectStore = {
    failProbe: false,
    failRemove: false,
    signed,
    removed,
    uploaded,

    put(ref) {
      present.add(keyOf(ref.bucket, ref.path));
      return ref;
    },

    remove(ref) {
      present.delete(keyOf(ref.bucket, ref.path));
    },

    has(ref) {
      return present.has(keyOf(ref.bucket, ref.path));
    },

    storage: {
      from(bucket: string) {
        return {
          exists(path: string) {
            if (store.failProbe) {
              return Promise.reject(new Error('jamee integration harness: existence probe refused'));
            }
            return Promise.resolve({ data: present.has(keyOf(bucket, path)), error: null });
          },
          createSignedUrl(path: string, expiresIn: number) {
            signed.push({ bucket, path, expiresInSeconds: expiresIn });
            if (!present.has(keyOf(bucket, path))) {
              return Promise.resolve({
                data: null,
                error: new Error('jamee integration harness: object not found'),
              });
            }
            return Promise.resolve({
              data: { signedUrl: signedUrlFor(bucket, path) },
              error: null,
            });
          },
          remove(paths: string[]) {
            removed.push({ bucket, paths: [...paths] });
            if (store.failRemove) {
              return Promise.resolve({
                data: null,
                error: new Error('jamee integration harness: remove refused'),
              });
            }
            for (const path of paths) present.delete(keyOf(bucket, path));
            // `data` is the removed list rather than `null`, matching the real API closely enough
            // that a caller reading it sees what it asked to delete. V22 leaves the
            // already-absent case unresolved and nothing here depends on the answer: the deleter
            // classifies absence before `remove()` is reached.
            return Promise.resolve({ data: [...paths], error: null });
          },
          upload(
            path: string,
            body: Uint8Array,
            options?: { readonly contentType?: string; readonly upsert?: boolean },
          ) {
            const key = keyOf(bucket, path);
            // `upsert: false` is what the production upload sends, and refusing an existing path is
            // the behaviour it relies on to turn an impossible collision into a loud error rather
            // than a silent overwrite of a farmer's object.
            if (present.has(key) && options?.upsert !== true) {
              return Promise.resolve({
                data: null,
                error: new Error('jamee integration harness: object already exists'),
              });
            }
            uploaded.push({
              bucket,
              path,
              bytes: body.byteLength,
              contentType: options?.contentType,
            });
            present.add(key);
            return Promise.resolve({ data: { path }, error: null });
          },
        };
      },
    },
  };

  return store;
}

/**
 * A valid reference under a farmer's own prefix, already recorded as present.
 *
 * Built with the application's own `buildStorageRef()` rather than a hand-written string, so a path
 * convention change (`{user_id}/{YYYY}/{MM}/{uuid}.{ext}`) breaks the fixture in one place instead of
 * silently producing a path that `storageRefSchema` refuses.
 */
export function uploadedObject(
  store: TestObjectStore,
  userId: string,
  bucket: StorageBucket,
  extension: string,
): StorageRef {
  return store.put(buildStorageRef({ bucket, userId, extension }));
}

/** A crop image in `crop-images`, present and owned by this farmer. */
export function uploadedImage(store: TestObjectStore, userId: string): StorageRef {
  return uploadedObject(store, userId, STORAGE_BUCKETS.cropImages, 'jpg');
}

/** A recording in `voice-messages`, present and owned by this farmer. */
export function uploadedRecording(store: TestObjectStore, userId: string): StorageRef {
  return uploadedObject(store, userId, STORAGE_BUCKETS.voiceMessages, 'webm');
}
