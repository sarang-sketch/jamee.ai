import { Buffer } from 'node:buffer';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setupDatabase } from '@/lib/db/setup';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from './mongo';

/**
 * Integration tests for the GridFS media store (`src/lib/db/media.ts`, task 54.1) against a
 * single-node `MongoMemoryReplSet` (V31, V33).
 *
 * Requirements: 2.5, 2.6 (a file is read only by its owner, and a stranger cannot learn it exists),
 *               13.5, 13.6 (files are private and owner-scoped), 18.3, 18.4 (the retention sweep
 *               lists by kind and age using `uploadDate`)
 * Design: D17 (one bucket, `metadata.kind` + `metadata.ownerId` + `metadata.sourceRef`), D18; V29
 *
 * `MONGODB_URI` is pointed at the in-memory replica set before any Data_Access_Layer function runs,
 * and `src/lib/db/media.ts` is imported dynamically AFTER that, so its bucket connects to the
 * harness rather than to a real Atlas cluster — the same wiring `data-access.test.ts` uses.
 */

let harness: MongoHarness | undefined;
type MediaModule = typeof import('@/lib/db/media');
let media: MediaModule;
type Mongo = typeof import('mongodb');
let mongo: Mongo;

const OWNER_A = 'farmer-A';
const OWNER_B = 'farmer-B';

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  media = await import('@/lib/db/media');
  mongo = await import('mongodb');
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  if (harness) await clearDatabase(harness.db);
});

/* ========================================================================== */
/* GridFS round-trips bytes and metadata                                       */
/* ========================================================================== */

describe('writeMedia / readMediaForOwner', () => {
  it('round-trips the exact bytes, the MIME type, and the length for the owner', async () => {
    const bytes = Buffer.from('the quick brown crop leaf', 'utf8');

    const ref = await media.writeMedia(OWNER_A, 'crop-image', 'image/jpeg', bytes);
    expect(ref.kind).toBe('crop-image');

    const read = await media.readMediaForOwner(OWNER_A, ref.fileId);
    expect(read).not.toBeNull();
    expect(read?.bytes.equals(bytes)).toBe(true);
    expect(read?.mimeType).toBe('image/jpeg');
    expect(read?.length).toBe(bytes.byteLength);
  });

  it('stores the owner, kind, and sourceRef in metadata', async () => {
    const sourceRef = new mongo.ObjectId();
    const ref = await media.writeMedia(OWNER_A, 'thumbnail', 'image/jpeg', Buffer.from('t'), sourceRef);

    const fileDoc = await harness!.db.collection('media.files').findOne({ _id: ref.fileId });
    expect(fileDoc?.metadata).toMatchObject({
      ownerId: OWNER_A,
      kind: 'thumbnail',
      mimeType: 'image/jpeg',
    });
    expect(String(fileDoc?.metadata?.sourceRef)).toBe(String(sourceRef));
  });
});

/* ========================================================================== */
/* A stranger gets null and cannot learn the file exists                       */
/* ========================================================================== */

describe('owner scoping', () => {
  it('returns null for a non-owner, indistinguishable from a file that does not exist', async () => {
    const ref = await media.writeMedia(OWNER_A, 'crop-image', 'image/png', Buffer.from('secret'));

    // A stranger reading A's real file, and anyone reading a made-up id, both get null.
    expect(await media.readMediaForOwner(OWNER_B, ref.fileId)).toBeNull();
    expect(await media.readMediaForOwner(OWNER_B, new mongo.ObjectId())).toBeNull();
    // The owner still reads it — the file is really there.
    expect(await media.readMediaForOwner(OWNER_A, ref.fileId)).not.toBeNull();
  });

  it('a non-owner cannot delete, and the file survives for its owner', async () => {
    const ref = await media.writeMedia(OWNER_A, 'crop-image', 'image/png', Buffer.from('secret'));

    expect(await media.deleteMediaForOwner(OWNER_B, ref.fileId)).toBe(false);
    // Still readable by A: the stranger's delete was a no-op.
    expect(await media.readMediaForOwner(OWNER_A, ref.fileId)).not.toBeNull();

    // The owner can delete it, and a second delete is a harmless no-op (idempotence).
    expect(await media.deleteMediaForOwner(OWNER_A, ref.fileId)).toBe(true);
    expect(await media.deleteMediaForOwner(OWNER_A, ref.fileId)).toBe(false);
    expect(await media.readMediaForOwner(OWNER_A, ref.fileId)).toBeNull();
  });
});

/* ========================================================================== */
/* The retention listing keys on uploadDate                                    */
/* ========================================================================== */

describe('listMediaOfKindOlderThan (the retention backstop)', () => {
  it('lists only files of the asked kind uploaded before the instant, oldest first', async () => {
    const older = await media.writeMedia(OWNER_A, 'crop-image', 'image/jpeg', Buffer.from('old'));
    const voice = await media.writeMedia(OWNER_A, 'voice', 'audio/ogg', Buffer.from('voice'));

    // Backdate the first image's uploadDate so the cutoff can separate it from the newer files.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    await harness!.db
      .collection('media.files')
      .updateOne({ _id: older.fileId }, { $set: { uploadDate: tenMinutesAgo } });

    // Write the newer file AFTER backdating, so its uploadDate is genuinely recent.
    await media.writeMedia(OWNER_B, 'crop-image', 'image/jpeg', Buffer.from('new'));

    // The cutoff sits between the backdated file and the just-written files.
    const cutoff = new Date(Date.now() - 5 * 60_000);

    const aged = await media.listMediaOfKindOlderThan('crop-image', cutoff, 100);

    // Only the backdated crop-image is returned — the just-written one is newer than the cutoff,
    // and the voice file is a different kind.
    expect(aged.map((f) => String(f.fileId))).toEqual([String(older.fileId)]);
    expect(aged[0]?.ownerId).toBe(OWNER_A);
    expect(String(voice.fileId)).not.toBe(String(aged[0]?.fileId));
  });

  it('never lists a thumbnail even when it is old (thumbnails are kept forever)', async () => {
    const thumb = await media.writeMedia(OWNER_A, 'thumbnail', 'image/jpeg', Buffer.from('thumb'));
    await harness!.db
      .collection('media.files')
      .updateOne({ _id: thumb.fileId }, { $set: { uploadDate: new Date(0) } });

    const agedImages = await media.listMediaOfKindOlderThan('crop-image', new Date(), 100);
    const agedVoice = await media.listMediaOfKindOlderThan('voice', new Date(), 100);
    expect([...agedImages, ...agedVoice].map((f) => String(f.fileId))).not.toContain(
      String(thumb.fileId),
    );
  });

  it('deleteMediaById removes a listed orphan and is a no-op the second time', async () => {
    const ref = await media.writeMedia(OWNER_A, 'voice', 'audio/ogg', Buffer.from('orphan'));

    expect(await media.deleteMediaById(ref.fileId)).toBe(true);
    expect(await media.deleteMediaById(ref.fileId)).toBe(false);
    expect(await media.readMediaForOwner(OWNER_A, ref.fileId)).toBeNull();
  });
});
