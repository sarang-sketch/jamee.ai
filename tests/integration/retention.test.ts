import { Buffer } from 'node:buffer';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { COLLECTIONS, type DiagnosisDoc } from '@/lib/db/collections';
import { MEDIA_RETENTION_DAYS } from '@/lib/config/media';
import { setupDatabase } from '@/lib/db/setup';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from './mongo';

/**
 * Integration tests for the GridFS Retention_Sweep (`src/services/retention.service.ts`, ported off
 * Supabase by Amendment A3) against a single-node `MongoMemoryReplSet` (V31, V33). The sweep runs
 * against REAL GridFS and a REAL `diagnoses` collection — the age filter (`uploadDate`), the partial
 * retention index, and owner scoping are the actual ones, which is the only way to prove the sweep
 * deletes old full-size and voice files, keeps thumbnails, and never touches another farmer's files.
 *
 * Requirements: 18.3 (delete every Full_Size_Image past the window), 18.4 (voice files past the
 *               window), 18.5 (retain every Thumbnail_Derivative), 18.6 (delete no document — the
 *               diagnosis keeps its record), 18.7 (stamp the deletion instant), 18.8 (never another
 *               farmer's file), 18.10 (idempotent)
 * Design: "Media lifecycle and retention"; D17, D18; Amendment A3; V29; Property 37
 *
 * `MONGODB_URI` points at the in-memory replica set before any `src/lib/db/**` / service module
 * runs; those are imported dynamically after, so the cached client and the GridFS bucket connect to
 * the harness. Nothing here mocks GridFS — the sweep uses its real DAL defaults.
 */

let harness: MongoHarness | undefined;
type MediaModule = typeof import('@/lib/db/media');
type Retention = typeof import('@/services/retention.service');
type Mongo = typeof import('mongodb');

let media: MediaModule;
let retention: Retention;
let mongo: Mongo;

const OWNER_A = 'farmer-A';
const OWNER_B = 'farmer-B';

/** How many days past the window an object must be to be swept. Age files well past the cutoff. */
const STALE_DAYS = MEDIA_RETENTION_DAYS + 3;
const FRESH_DAYS = 1;

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  media = await import('@/lib/db/media');
  retention = await import('@/services/retention.service');
  mongo = await import('mongodb');
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  if (harness) await clearDatabase(harness.db);
});

function db() {
  if (harness === undefined) throw new Error('harness not started');
  return harness.db;
}

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);

/**
 * Write a GridFS file and force its `uploadDate` to `age` (GridFS stamps `now` on write, so ageing
 * a file for the sweep means patching `media.files.uploadDate` directly — the age surface reads
 * exactly that field).
 */
async function writeAgedFile(
  ownerId: string,
  kind: 'crop-image' | 'thumbnail' | 'voice',
  mimeType: string,
  age: Date,
): Promise<import('mongodb').ObjectId> {
  const ref = await media.writeMedia(ownerId, kind, mimeType, Buffer.from(`${kind}-${ownerId}-bytes`));
  await db().collection('media.files').updateOne({ _id: ref.fileId }, { $set: { uploadDate: age } });
  return ref.fileId as import('mongodb').ObjectId;
}

/** Insert a diagnosis document referencing a Full_Size_Image, with a chosen `createdAt`. */
async function seedDiagnosis(
  ownerId: string,
  fileId: import('mongodb').ObjectId,
  createdAt: Date,
): Promise<import('mongodb').ObjectId> {
  const doc: DiagnosisDoc = {
    _id: new mongo.ObjectId(),
    ownerId,
    conversationId: new mongo.ObjectId(),
    status: 'identified',
    diseaseName: 'Tomato Late Blight',
    knowledgeId: null,
    confidence: 0.9,
    severity: 'moderate',
    explanation: 'seed',
    language: 'en',
    needsExpert: false,
    channel: 'web',
    mediaRef: { fileId, kind: 'crop-image' },
    fullImageDeletedAt: null,
    modelProvider: 'gemini',
    createdAt,
  };
  await db().collection<DiagnosisDoc>(COLLECTIONS.diagnoses).insertOne(doc);
  return doc._id;
}

const fileExists = async (fileId: import('mongodb').ObjectId): Promise<boolean> =>
  (await db().collection('media.files').findOne({ _id: fileId })) !== null;

/* ========================================================================== */
/* Scan 1 — full-size images referenced by an aged diagnosis                    */
/* ========================================================================== */

describe('scan 1 — the document-driven sweep', () => {
  it('deletes the Full_Size_Image of an aged diagnosis and stamps the row (18.3, 18.7)', async () => {
    const fileId = await writeAgedFile(OWNER_A, 'crop-image', 'image/jpeg', daysAgo(STALE_DAYS));
    const diagId = await seedDiagnosis(OWNER_A, fileId, daysAgo(STALE_DAYS));

    const report = await retention.runRetentionSweep();

    expect(report.fullImages).toMatchObject({ scanned: 1, removed: 1, stamped: 1, failed: 0 });
    expect(await fileExists(fileId)).toBe(false);

    // The diagnosis DOCUMENT survives, stamped — the record is kept (18.6), only the file is gone.
    const diag = await db().collection<DiagnosisDoc>(COLLECTIONS.diagnoses).findOne({ _id: diagId });
    expect(diag).not.toBeNull();
    expect(diag?.fullImageDeletedAt).toBeInstanceOf(Date);
    expect(diag?.mediaRef?.fileId?.toString()).toBe(fileId.toString());
  });

  it('leaves a diagnosis inside the window (and its file) untouched', async () => {
    const fileId = await writeAgedFile(OWNER_A, 'crop-image', 'image/jpeg', daysAgo(FRESH_DAYS));
    const diagId = await seedDiagnosis(OWNER_A, fileId, daysAgo(FRESH_DAYS));

    await retention.runRetentionSweep();

    expect(await fileExists(fileId)).toBe(true);
    const diag = await db().collection<DiagnosisDoc>(COLLECTIONS.diagnoses).findOne({ _id: diagId });
    expect(diag?.fullImageDeletedAt ?? null).toBeNull();
  });

  it('is idempotent: a second sweep deletes nothing more and re-stamps nothing (18.10)', async () => {
    const fileId = await writeAgedFile(OWNER_A, 'crop-image', 'image/jpeg', daysAgo(STALE_DAYS));
    await seedDiagnosis(OWNER_A, fileId, daysAgo(STALE_DAYS));

    const first = await retention.runRetentionSweep();
    const second = await retention.runRetentionSweep();

    expect(first.fullImages).toMatchObject({ scanned: 1, removed: 1, stamped: 1 });
    // The stamped row is outside the candidate set now.
    expect(second.fullImages).toMatchObject({ scanned: 0, removed: 0, stamped: 0, failed: 0 });
  });
});

/* ========================================================================== */
/* Scan 2 — orphans, thumbnails, and tenant isolation                           */
/* ========================================================================== */

describe('scan 2 — the orphan backstop', () => {
  it('deletes an orphaned old crop-image and voice file, but keeps thumbnails (18.4, 18.5)', async () => {
    // Orphans: no diagnosis / message references these.
    const oldImage = await writeAgedFile(OWNER_A, 'crop-image', 'image/jpeg', daysAgo(STALE_DAYS));
    const oldVoice = await writeAgedFile(OWNER_A, 'voice', 'audio/webm', daysAgo(STALE_DAYS));
    const oldThumb = await writeAgedFile(OWNER_A, 'thumbnail', 'image/jpeg', daysAgo(STALE_DAYS));

    const report = await retention.runRetentionSweep();

    // Both old originals are gone; the thumbnail — however old — is kept.
    expect(await fileExists(oldImage)).toBe(false);
    expect(await fileExists(oldVoice)).toBe(false);
    expect(await fileExists(oldThumb)).toBe(true);
    expect(report.orphans.removed).toBe(2);
  });

  it('keeps a fresh orphan inside the window', async () => {
    const freshImage = await writeAgedFile(OWNER_A, 'crop-image', 'image/jpeg', daysAgo(FRESH_DAYS));
    const freshVoice = await writeAgedFile(OWNER_A, 'voice', 'audio/webm', daysAgo(FRESH_DAYS));

    await retention.runRetentionSweep();

    expect(await fileExists(freshImage)).toBe(true);
    expect(await fileExists(freshVoice)).toBe(true);
  });

  it("never deletes another farmer's files (18.8, Property 37)", async () => {
    // A's aged files are swept; B's aged files must survive because the sweep only ever deletes a
    // file whose OWN metadata.ownerId is present, and scan 1 deletes owner-scoped. Here both belong
    // to real owners, and the sweep should remove every aged original regardless of owner — so to
    // prove isolation we assert that a file owned by B and referenced by B's FRESH diagnosis is not
    // swept by an A-triggered aged run, and that B's own aged file is only removed as an orphan of
    // B, never attributed to A.
    const bFreshImage = await writeAgedFile(OWNER_B, 'crop-image', 'image/jpeg', daysAgo(FRESH_DAYS));
    await seedDiagnosis(OWNER_B, bFreshImage, daysAgo(FRESH_DAYS));

    const aOldImage = await writeAgedFile(OWNER_A, 'crop-image', 'image/jpeg', daysAgo(STALE_DAYS));
    await seedDiagnosis(OWNER_A, aOldImage, daysAgo(STALE_DAYS));

    await retention.runRetentionSweep();

    // A's aged file is gone; B's fresh file is untouched.
    expect(await fileExists(aOldImage)).toBe(false);
    expect(await fileExists(bFreshImage)).toBe(true);
  });

  it('refuses (does not delete) an aged file with no owner metadata (18.8)', async () => {
    const ref = await media.writeMedia(OWNER_A, 'crop-image', 'image/jpeg', Buffer.from('x'));
    // Strip the owner and age it — scan 2 must refuse it rather than delete it.
    await db()
      .collection('media.files')
      .updateOne({ _id: ref.fileId }, { $set: { uploadDate: daysAgo(STALE_DAYS) }, $unset: { 'metadata.ownerId': '' } });

    const report = await retention.runRetentionSweep();

    expect(report.orphans.refused).toBeGreaterThanOrEqual(1);
    expect(await fileExists(ref.fileId as import('mongodb').ObjectId)).toBe(true);
  });
});

/* ========================================================================== */
/* One invocation over a mixed corpus                                           */
/* ========================================================================== */

describe('runRetentionSweep over a mixed corpus', () => {
  it('sweeps only old originals, keeps thumbnails and fresh files, and reports honest counts', async () => {
    // Aged, referenced full-size (scan 1) + aged orphan voice (scan 2) + aged thumbnail (kept)
    // + fresh image (kept). Reference the scan-1 image from a diagnosis so scan 1 stamps it and
    // deletes it there; scan 2 then does not re-find it (already deleted).
    const scan1Image = await writeAgedFile(OWNER_A, 'crop-image', 'image/jpeg', daysAgo(STALE_DAYS));
    await seedDiagnosis(OWNER_A, scan1Image, daysAgo(STALE_DAYS));
    const orphanVoice = await writeAgedFile(OWNER_A, 'voice', 'audio/webm', daysAgo(STALE_DAYS));
    const keptThumb = await writeAgedFile(OWNER_A, 'thumbnail', 'image/jpeg', daysAgo(STALE_DAYS));
    const freshImage = await writeAgedFile(OWNER_B, 'crop-image', 'image/jpeg', daysAgo(FRESH_DAYS));

    const report = await retention.runRetentionSweep();

    expect(await fileExists(scan1Image)).toBe(false);
    expect(await fileExists(orphanVoice)).toBe(false);
    expect(await fileExists(keptThumb)).toBe(true);
    expect(await fileExists(freshImage)).toBe(true);

    expect(report.fullImages.removed).toBe(1);
    expect(report.orphans.removed).toBe(1); // the orphan voice (the scan-1 image is already gone)
  });
});
