import 'server-only';

import { Buffer } from 'node:buffer';

import { GridFSBucket, ObjectId, type Db, type GridFSFile } from 'mongodb';

import { getDb } from '@/lib/db/client';
import { MEDIA_BUCKET, type MediaKind } from '@/lib/db/names';
import type { MediaRefDoc } from '@/lib/db/collections';

/**
 * The GridFS media store — the ONLY code that opens the single Jamee media bucket, and the
 * Data_Access_Layer half of task 54.1. Every uploaded file (a Full_Size_Image, its
 * Thumbnail_Derivative, a voice recording) is a GridFS file in ONE bucket, told apart by
 * `metadata.kind` and owned by `metadata.ownerId`.
 *
 * Requirements: 2.5, 2.6 (a file is read only by the Farmer who owns it, proven before anything is
 *               spent), 2.8, 12.5 (the read path the diagnosis and the history views use), 13.5,
 *               13.6 (files are private and owner-scoped), 18.3, 18.4 (the retention sweep lists and
 *               deletes by kind and age)
 * Design: D17 (one bucket distinguished by `metadata.kind`, not two), D18 (this module is inside
 *         `src/lib/db/**`, so it is one of the few files allowed to hold the driver; every access
 *         path filters on `metadata`), Media lifecycle and retention; V29 (the GridFS surface)
 *
 * =============================================================================
 * WHY THE OWNER CHECK IS A READ FILTER, NOT AN AFTER-THE-FACT COMPARISON
 * =============================================================================
 *
 * `readMediaForOwner` and `deleteMediaForOwner` both scope by `{ _id: fileId, 'metadata.ownerId':
 * ownerId }` — the owner is part of the query, not a field compared after the file is found. That
 * is what makes a stranger unable to learn whether a file exists (Requirement 2.6): a file owned by
 * someone else and a file that does not exist both produce ZERO matches, so both return `null`, and
 * the caller cannot tell them apart. A find-then-compare would leak that difference through timing
 * or through a distinguishable "forbidden" vs "not found" branch — exactly the classic mistake D18
 * relocates into the application layer and this module must not reintroduce.
 *
 * =============================================================================
 * THE SYSTEM SWEEP FUNCTIONS ARE UNSCOPED BY NECESSITY, AND NAMED FOR IT
 * =============================================================================
 *
 * `listMediaOfKindOlderThan` and `deleteMediaById` carry no owner, because the retention sweep's
 * age-driven backstop (scan 2) finds orphans by `metadata.kind` + `uploadDate` across all farmers
 * — an object whose owning document never landed has no farmer to key on from the document side.
 * They are named for exactly that, following the "named system accessor" convention in
 * `farmer.ts`: an unscoped media operation is a deliberate, greppable exception. The sweep re-reads
 * each file's own `metadata.ownerId` before deleting (Requirement 18.8), which is the owner anchor
 * scan 2 has; the application-level wrapper in `src/lib/media/index.ts` and the retention service
 * are where that check lives.
 */

/* ========================================================================== */
/* The single bucket                                                           */
/* ========================================================================== */

/**
 * The one `GridFSBucket`, over the `getDb()` handle. A fresh handle is cheap (it reuses the cached
 * `MongoClient`'s pool — D19), and the driver creates the bucket's `media.files` / `media.chunks`
 * collections and their indexes lazily on first write (V29), so constructing this per call is
 * correct and holds no state that must be cached.
 */
function bucket(db: Db = getDb()): GridFSBucket {
  return new GridFSBucket(db, { bucketName: MEDIA_BUCKET });
}

/** The `metadata` every Jamee media file carries (D17). `sourceRef` links back to its origin. */
interface MediaMetadata {
  ownerId: string;
  kind: MediaKind;
  /**
   * The `_id` of the file's source: for a `thumbnail`, its Full_Size_Image; for a `crop-image` or
   * `voice` original, the `diagnoses` / `messages` document that references it. Optional because a
   * write can precede the document that will point back at it.
   */
  sourceRef?: ObjectId | null;
  /** The MIME type the bytes were uploaded with, so a reader serves the right `Content-Type`. */
  mimeType: string;
}

/** Read the Jamee `metadata` off a GridFS file. The driver types `metadata` as an open `Document`. */
function metadataOf(file: GridFSFile): MediaMetadata | undefined {
  return file.metadata as MediaMetadata | undefined;
}

/** What a successful read returns. Only the three facts a caller needs — never the metadata owner. */
export interface MediaBytes {
  readonly bytes: Buffer;
  readonly mimeType: string;
  readonly length: number;
}

/* ========================================================================== */
/* Writing                                                                     */
/* ========================================================================== */

/**
 * Store `bytes` as one GridFS file owned by `ownerId`, tagged `kind`, carrying its MIME type, and
 * return the Media_Reference (`{ fileId, kind }`) a domain document stores.
 *
 * The upload is done through `openUploadStream` with the bytes written in one `end()` — the files
 * here are small (a re-encoded image is ~400 KB, a voice note at most 3 MB), so there is no reason
 * to chunk the source Buffer ourselves; the driver splits it into 255 KB GridFS chunks (V29). The
 * promise resolves on the stream's `finish` event, which is when the `files` document and all its
 * `chunks` are committed, so the returned `fileId` is immediately readable.
 *
 * `filename` is set to the file id's hex string. GridFS requires a filename and Jamee never looks a
 * file up by name (every read is by `_id` + owner), so a stable, collision-free, non-identifying
 * value is the right choice — never a farmer-supplied name.
 */
export async function writeMedia(
  ownerId: string,
  kind: MediaKind,
  mimeType: string,
  bytes: Buffer,
  sourceRef?: ObjectId | string | null,
): Promise<MediaRefDoc> {
  const resolvedSourceRef = sourceRef == null ? undefined : (toFileId(sourceRef) ?? undefined);
  const metadata: MediaMetadata = {
    ownerId,
    kind,
    mimeType,
    ...(resolvedSourceRef === undefined ? {} : { sourceRef: resolvedSourceRef }),
  };

  const stream = bucket().openUploadStream(new ObjectId().toHexString(), { metadata });

  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('finish', () => resolve());
    stream.end(bytes);
  });

  return { fileId: stream.id as ObjectId, kind };
}

/* ========================================================================== */
/* Reading — owner-scoped, existence-opaque to a stranger                      */
/* ========================================================================== */

/**
 * Coerce a caller-supplied file id to an `ObjectId`, or `null` when it is not a valid id. Accepting
 * a string here keeps the `mongodb` driver — including `ObjectId` construction and validation —
 * inside `src/lib/db/**`, so the application-level wrapper in `src/lib/media/index.ts` can pass the
 * hex string it received without importing the driver (which `scripts/check-data-access.ts` forbids
 * outside this directory).
 */
function toFileId(fileId: ObjectId | string): ObjectId | null {
  if (fileId instanceof ObjectId) return fileId;
  return ObjectId.isValid(fileId) ? new ObjectId(fileId) : null;
}

/**
 * Return the bytes, MIME type, and length of `fileId` — but ONLY when `ownerId` owns it. A file
 * owned by another farmer, and a file that does not exist, both return `null`, so a stranger cannot
 * probe for existence (Requirement 2.6). An unparseable id is treated as "does not exist" — `null`,
 * indistinguishable from the rest.
 *
 * The owner is part of the `files` lookup filter, so a non-owner never even opens a download
 * stream. When the file matches, the bytes are drained from `openDownloadStream(fileId)` into one
 * Buffer — the streaming API cannot load partial chunks (V29), and these files are small, so
 * buffering the whole thing is both correct and cheap.
 */
export async function readMediaForOwner(ownerId: string, fileId: ObjectId | string): Promise<MediaBytes | null> {
  const id = toFileId(fileId);
  if (id === null) return null;

  const files = bucket();
  const doc = await files
    .find({ _id: id, 'metadata.ownerId': ownerId })
    .limit(1)
    .toArray();

  const file = doc[0];
  if (file === undefined) return null;

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = files.openDownloadStream(id);
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });

  return {
    bytes: Buffer.concat(chunks),
    mimeType: metadataOf(file)?.mimeType ?? 'application/octet-stream',
    length: file.length,
  };
}

/* ========================================================================== */
/* Deleting — owner-scoped                                                     */
/* ========================================================================== */

/**
 * Delete `fileId`, but only when `ownerId` owns it. Returns `true` if a file was deleted, `false`
 * when none matched (a stranger's file, or one already gone). A non-owner's delete is a no-op that
 * returns `false` rather than an error — the same existence-opaque property as the read.
 *
 * The owner check runs as a scoped `find` before `bucket.delete`, because the driver's `delete`
 * takes only an id and would otherwise delete across owners. `delete` on an absent id is normalized
 * to `false` (V29 notes it may throw on a missing file), so a double-delete is harmless — the
 * property the idempotent retention sweep relies on.
 */
export async function deleteMediaForOwner(ownerId: string, fileId: ObjectId | string): Promise<boolean> {
  const id = toFileId(fileId);
  if (id === null) return false;

  const files = bucket();
  const owned = await files
    .find({ _id: id, 'metadata.ownerId': ownerId })
    .limit(1)
    .toArray();

  if (owned[0] === undefined) return false;

  try {
    await files.delete(id);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

/* ========================================================================== */
/* NAMED system functions — the retention sweep's age-driven backstop          */
/* ========================================================================== */

/**
 * One entry the retention sweep reads for a candidate file: its id and its own owner anchor, so the
 * sweep can re-check ownership before deleting (Requirement 18.8) rather than deleting by id blind.
 */
export interface AgedMediaFile {
  readonly fileId: ObjectId;
  readonly ownerId: string | null;
  readonly uploadDate: Date;
  readonly length: number;
}

/**
 * List, oldest-first, the media files of one `kind` uploaded before `instant`, up to `limit`. The
 * age is `uploadDate`, GridFS's own timestamp on every file (V29) — the field the retired V22 could
 * not get from Supabase's `storage.objects`, and the whole reason scan 2 of the sweep is now
 * runnable rather than switched off.
 *
 * Unscoped by necessity: an orphaned original (an upload whose owning document never landed) has no
 * farmer to key on from the document side, so this finds candidates by `metadata.kind` + age across
 * all farmers, and the CALLER re-reads each file's `metadata.ownerId` before deleting. It never
 * matches a `thumbnail` unless asked, so the sweep passing only `crop-image` / `voice` keeps every
 * Thumbnail_Derivative (Requirement 18.5).
 */
export async function listMediaOfKindOlderThan(
  kind: MediaKind,
  instant: Date,
  limit: number,
): Promise<AgedMediaFile[]> {
  const docs = await bucket()
    .find({ 'metadata.kind': kind, uploadDate: { $lt: instant } })
    .sort({ uploadDate: 1 })
    .limit(limit)
    .toArray();

  return docs.map((doc) => ({
    fileId: doc._id,
    ownerId: metadataOf(doc)?.ownerId ?? null,
    uploadDate: doc.uploadDate,
    length: doc.length,
  }));
}

/**
 * Delete one media file by id, with no owner check. For the retention sweep ONLY, which has already
 * re-read and asserted the file's own `metadata.ownerId` against the owning document (scan 1) or
 * confirmed it is present (scan 2) before calling this. Returns `false` when the file was already
 * gone, so a doubled or late sweep run is harmless (Requirement 18.10).
 *
 * Named `...ById` and living beside the owner-scoped `deleteMediaForOwner` so the unscoped one is a
 * deliberate, greppable exception rather than an accident — the same discipline `farmer.ts` applies
 * to its named system accessors.
 */
export async function deleteMediaById(fileId: ObjectId): Promise<boolean> {
  try {
    await bucket().delete(fileId);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

/* ========================================================================== */
/* Absent-file detection                                                       */
/* ========================================================================== */

/**
 * The driver raises a `FileNotFound`-shaped error when `delete` is given an id with no `files`
 * document (V29). Normalized to "already deleted" so idempotence holds. Matched on the driver's
 * documented error code / message rather than on message text alone, and defensively — an
 * unrecognised error is rethrown, never swallowed.
 */
function isFileNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'ENOENT') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /FileNotFound|file not found|does not exist/i.test(message);
}
