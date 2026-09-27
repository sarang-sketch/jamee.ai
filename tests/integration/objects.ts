import { Buffer } from 'node:buffer';

import type { MediaKind } from '@/lib/db/names';
import type { MediaRef } from '@/lib/schemas';

/**
 * Uploaded media, as Amendment A3 stores it: real GridFS files in the one Jamee media bucket, owned
 * by `metadata.ownerId` and told apart by `metadata.kind` (D17). Not a Supabase-Storage double.
 *
 * Requirements: 2.5, 2.6 (a file's bytes are read only by the Farmer who owns it, proven before
 *               anything is spent — the owner is part of the GridFS query, so a stranger's read and
 *               a missing file are indistinguishable), 2.8 (under A3 the bytes reach the model
 *               inline, read from GridFS — there is no signed URL), 8.9, 8.11 (a voice original is
 *               deleted through the owner-scoped Data_Access_Layer once its transcript is durable)
 * Design: D17 (one GridFS bucket distinguished by `metadata.kind`), D18 (the media DAL under
 *         `src/lib/db/**` is the only holder of the driver and the bucket), Amendment A3
 *
 * =============================================================================
 * WHY THE FIXTURE WRITES REAL GRIDFS RATHER THAN FAKING AN OBJECT STORE
 * =============================================================================
 *
 * The retired harness faked Supabase Storage: it implemented `exists` / `createSignedUrl` /
 * `remove` / `upload` over a `Set` of paths, because under Supabase the services took a
 * `StorageClientLike` and asked it for a signed URL that the stubbed provider then never fetched.
 * Under A3 the analysis and voice services read the bytes THEMSELVES, from GridFS, through
 * `readMediaBytesForOwner` in the Data_Access_Layer — there is no signed URL and no injectable
 * storage seam. So the honest fixture is a real GridFS file: `writeMedia(ownerId, kind, mime,
 * bytes)` puts one in the harness's in-memory replica set, stamped with the owner, and returns the
 * Media_Reference (`{ fileId, kind }`) a scenario hands to `diagnose()` / `transcribeAndAnswer()`.
 * The service then reads it back through the real owner-scoped read, so the ownership check, the
 * `metadata.ownerId` filter, and the retention delete are all the production ones.
 *
 * The media DAL is `server-only` and lives under `src/lib/db/**`, so it is imported DYNAMICALLY by
 * the harness (after `MONGODB_URI` is pointed at the replica set) and threaded in here as
 * `writeMedia`, rather than imported at the top of this module — the same discipline every wave-5
 * mongo test uses so the cached client connects to the harness.
 */

/** The `writeMedia` seam, structurally matched to `@/lib/db/media`'s export so a signature drift breaks here. */
export type WriteMedia = (
  ownerId: string,
  kind: MediaKind,
  mimeType: string,
  bytes: Buffer,
  sourceRef?: string | null,
) => Promise<{ fileId: { toHexString(): string }; kind: MediaKind }>;

/** The `readMediaForOwner` seam, for a fixture assertion that a farmer's own file is (or is not) present. */
export type ReadMediaForOwner = (
  ownerId: string,
  fileId: string,
) => Promise<{ readonly bytes: Buffer; readonly mimeType: string; readonly length: number } | null>;

/**
 * A media fixture bound to the harness's dynamically-imported media DAL. Every method writes or
 * reads a REAL GridFS file in the harness database.
 */
export interface MediaFixture {
  /**
   * Write one owned GridFS file and return the Media_Reference a service reads. `bytes` defaults to
   * a small deterministic buffer — the provider is stubbed, so the actual bytes are never analysed;
   * what matters is that the file exists, is owned, and carries the MIME type.
   */
  write(
    ownerId: string,
    kind: MediaKind,
    mimeType: string,
    bytes?: Buffer,
  ): Promise<MediaRef>;
  /** A `crop-image` (`image/jpeg`) owned by the farmer, present in GridFS. */
  image(ownerId: string): Promise<MediaRef>;
  /** A `voice` (`audio/ogg`) recording owned by the farmer, present in GridFS. */
  recording(ownerId: string): Promise<MediaRef>;
  /** Whether `ownerId` can still read `ref` — i.e. the owner-scoped read finds it. */
  ownerCanRead(ownerId: string, ref: MediaRef): Promise<boolean>;
}

/**
 * Build the fixture over the harness's media DAL functions.
 *
 * ```ts
 * const media = await import('@/lib/db/media');
 * const objects = mediaFixture(media.writeMedia, media.readMediaForOwner);
 * const image = await objects.image(farmerA.id);
 * const outcome = await diagnose({ userId: farmerA.id, image, language: 'en', channel: 'web' }, deps);
 * ```
 */
export function mediaFixture(writeMedia: WriteMedia, readMediaForOwner: ReadMediaForOwner): MediaFixture {
  const write = async (
    ownerId: string,
    kind: MediaKind,
    mimeType: string,
    bytes: Buffer = Buffer.from(`${kind}-${ownerId}-bytes`),
  ): Promise<MediaRef> => {
    const ref = await writeMedia(ownerId, kind, mimeType, bytes);
    return { fileId: ref.fileId.toHexString(), kind };
  };

  return {
    write,
    image: (ownerId) => write(ownerId, 'crop-image', 'image/jpeg'),
    recording: (ownerId) => write(ownerId, 'voice', 'audio/ogg'),
    async ownerCanRead(ownerId, ref) {
      return (await readMediaForOwner(ownerId, ref.fileId)) !== null;
    },
  };
}
