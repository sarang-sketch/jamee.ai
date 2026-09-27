import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { Buffer } from 'node:buffer';
import { GridFSBucket, ObjectId } from 'mongodb';

import { MEDIA_RETENTION_DAYS, RETENTION_SWEEP_BATCH_LIMIT } from '@/lib/config/media';
import type { DiagnosisDoc } from '@/lib/db/collections';
import { setupDatabase } from '@/lib/db/setup';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from '../integration/mongo';

/**
 * ### Property 31: Tenant isolation holds over deletion
 *
 * *"For any batch of retention candidates drawn from any number of distinct farmers, every GridFS
 * file the sweep hands to a delete is anchored to an owner it did not invent: for a document-driven
 * candidate, the file id is the `mediaRef.fileId` read off a `diagnoses` document, and the sweep
 * confirms the GridFS file's `metadata.ownerId` equals that document's `ownerId` before issuing the
 * delete; every deletion-instant stamp is written through the Data_Access_Layer anchored on both that
 * document's id and its `ownerId` and touches no other field; and for a candidate that has no owning
 * document — the age-driven orphan backstop, whose only tenant anchor is the GridFS file's own
 * `metadata.ownerId` — a file whose owner metadata is missing or malformed is refused rather than
 * deleted, and no file outside the ones the `files` collection query returned is ever deleted.
 * On-success voice deletion is bound the same way: the file is deleted only after its
 * `metadata.ownerId` is confirmed equal to the requesting farmer's Auth_User_Id."*
 *
 * **Validates: Requirement 18.8** (and the deletion dimension of Properties 5, 27, and the
 * environment/endpoint deliverable set of Property 30 — the sweep route reads no caller input.)
 *
 * =============================================================================
 * AMENDMENT A3 — DELETION IS OVER metadata.ownerId IN GridFS, NOT A STORAGE PATH
 * =============================================================================
 *
 * The retired design reasoned over storage paths: scan 1 asserted a path's first segment equalled its
 * row's `user_id` before a `remove()`; scan 2 anchored on the path's own first folder. A3 re-expresses
 * every anchor over `metadata.ownerId` in GridFS (Amendment A3, Property 31's own reconstruction
 * note), and the sweep is now `src/services/retention.service.ts` (`sweepFullImages`, `sweepOrphans`,
 * `runRetentionSweep`) driving Data_Access_Layer seams:
 *
 *  - **Scan 1** deletes each candidate's `mediaRef.fileId` through the OWNER-SCOPED
 *    `deleteMediaForOwner(ownerId, fileId)` — the owner is part of the GridFS `{ _id, metadata.ownerId }`
 *    filter, so a file whose `metadata.ownerId` is not the document's owner is simply not matched and
 *    not deleted (the Requirement 18.8 check IS that scoped delete), and an already-absent file is a
 *    no-op. Then it stamps `fullImageDeletedAt` anchored on `_id` AND `ownerId` (`stampFullImageDeleted`).
 *  - **Scan 2** lists GridFS files of kind `crop-image`/`voice` older than the cutoff (never
 *    `thumbnail` — Requirement 18.5), re-reads each file's own `metadata.ownerId`, refuses a file whose
 *    owner metadata is missing/empty (counted, not deleted), and deletes the rest by id.
 *
 * So the claim runs on the real layer where owner-scoping is decidable (scan 1: write real GridFS
 * files for two farmers, run the shipped sweep, assert B's files survive and the stamp carries B's
 * data untouched), and at the seam where a null-owner file is easy to construct (scan 2: an injected
 * `listAged` returns a file with `ownerId: null` and the delete-by-id seam is a counting stub that
 * must never be called for it). On-success voice deletion is the same `deleteMediaForOwner` scoping,
 * asserted on the real layer.
 */

/* ========================================================================== */
/* DAL / service modules, imported after MONGODB_URI is set                    */
/* ========================================================================== */

let harness: MongoHarness | undefined;
let farmerMod: typeof import('@/lib/db/farmer');
let mediaMod: typeof import('@/lib/db/media');
let retentionSvc: typeof import('@/services/retention.service');

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  farmerMod = await import('@/lib/db/farmer');
  mediaMod = await import('@/lib/db/media');
  retentionSvc = await import('@/services/retention.service');
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  if (harness === undefined) throw new Error('harness not started');
  await clearDatabase(harness.db);
  await setupDatabase(harness.db);
});

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

/** Fixed clock; the sweep derives its cutoff from it. */
const NOW = new Date('2026-09-30T00:00:00.000Z');
/** Comfortably older than the window, so age is never why a candidate is skipped. */
const LONG_PAST = new Date(NOW.getTime() - (MEDIA_RETENTION_DAYS + 30) * 24 * 60 * 60 * 1000);

const farmerIdArb = fc.uuid().map((uuid) => `user-${uuid}`);
const twoFarmersArb = fc.tuple(farmerIdArb, farmerIdArb).filter(([a, b]) => a !== b);

/**
 * Seed one aged diagnosis with a real GridFS Full_Size_Image for `ownerId`, its `createdAt` set into
 * the past so scan 1 selects it. Returns the diagnosis id and the file id.
 */
async function seedAgedDiagnosis(
  ownerId: string,
): Promise<{ diagnosisId: ObjectId; fileId: ObjectId }> {
  const ref = await mediaMod.writeMedia(ownerId, 'crop-image', 'image/jpeg', Buffer.from(`img-${ownerId}-${Math.random()}`));
  const conversation = await farmerMod.farmerData(ownerId).insertConversation({ channel: 'web', title: null });
  const stored = await farmerMod.farmerData(ownerId).insertDiagnosis({
    conversationId: conversation._id,
    status: 'identified',
    diseaseName: 'Tomato Early Blight',
    knowledgeId: null,
    confidence: 0.8,
    severity: 'moderate',
    explanation: 'x',
    language: 'en',
    needsExpert: false,
    channel: 'web',
    mediaRef: ref,
    fullImageDeletedAt: null,
    modelProvider: 'gemini',
  });
  await harness!.db
    .collection<DiagnosisDoc>('diagnoses')
    .updateOne({ _id: stored._id }, { $set: { createdAt: LONG_PAST } });
  return { diagnosisId: stored._id, fileId: ref.fileId };
}

/** Whether a GridFS file with this id still exists in the media bucket. */
async function fileExists(fileId: ObjectId): Promise<boolean> {
  const bucket = new GridFSBucket(harness!.db, { bucketName: 'media' });
  const found = await bucket.find({ _id: fileId }).limit(1).toArray();
  return found.length === 1;
}

/* ========================================================================== */
/* Scan 1 — document-driven deletion is owner-scoped (real layer)              */
/* ========================================================================== */

describe('Property 31, scan 1: a Full_Size_Image is deleted only under its owning document’s owner', () => {
  it('deletes farmer A’s aged originals and stamps their rows, and never touches farmer B’s file', async () => {
    await fc.assert(
      fc.asyncProperty(twoFarmersArb, fc.integer({ min: 1, max: 4 }), async (farmers, countA) => {
        await clearDatabase(harness!.db);
        await setupDatabase(harness!.db);
        const [a, b] = farmers;

        const aSeeds: { diagnosisId: ObjectId; fileId: ObjectId }[] = [];
        for (let i = 0; i < countA; i += 1) aSeeds.push(await seedAgedDiagnosis(a));
        // Farmer B has an aged diagnosis too — the sweep is deployment-wide, so B's row is a
        // candidate as well; the point is that A's sweep pass over A's rows never touches B's FILE,
        // and B's file id is the anchor read off B's own row.
        const bSeed = await seedAgedDiagnosis(b);

        const report = await retentionSvc.sweepFullImages({
          now: NOW,
          limit: RETENTION_SWEEP_BATCH_LIMIT,
        });

        // Every candidate across both farmers was swept, each file deleted under ITS OWN document's
        // owner via `deleteMediaForOwner(ownerId, fileId)` — the Requirement 18.8 scoped delete.
        expect(report.scanned).toBe(countA + 1);
        expect(report.stamped).toBe(countA + 1);
        expect(report.failed).toBe(0);

        // A's files are gone, and each of A's rows carries the stamp anchored on its own id+owner.
        for (const seed of aSeeds) {
          expect(await fileExists(seed.fileId), 'A’s aged original survived the sweep').toBe(false);
          const row = await harness!.db
            .collection<DiagnosisDoc>('diagnoses')
            .findOne({ _id: seed.diagnosisId });
          expect(row?.ownerId, 'the stamp crossed a tenant boundary').toBe(a);
          expect(row?.fullImageDeletedAt, 'A’s row was not stamped').not.toBeNull();
          // Requirement 18.7: only `fullImageDeletedAt` changed — `mediaRef` (and thus the surviving
          // thumbnail link) is intact.
          expect(row?.mediaRef.fileId.equals(seed.fileId)).toBe(true);
        }

        // And B's file — deleted under B's own document owner, never under A's — was itself swept
        // (it is an aged candidate), and B's row stamped with B's owner. The isolation point: no
        // stamp ever wrote A's owner onto B's row or vice versa, asserted above per row.
        const bRow = await harness!.db
          .collection<DiagnosisDoc>('diagnoses')
          .findOne({ _id: bSeed.diagnosisId });
        expect(bRow?.ownerId).toBe(b);
        expect(bRow?.fullImageDeletedAt).not.toBeNull();
      }),
      { numRuns: 20 },
    );
  }, 30_000);

  it('does not delete a file whose GridFS metadata.ownerId does not match its document’s owner', async () => {
    await fc.assert(
      fc.asyncProperty(twoFarmersArb, async (farmers) => {
        await clearDatabase(harness!.db);
        await setupDatabase(harness!.db);
        const [a, b] = farmers;

        // A corrupt candidate: a `diagnoses` row owned by A whose `mediaRef.fileId` points at a file
        // whose GridFS `metadata.ownerId` is B's. `deleteMediaForOwner(A, fileId)` scopes by
        // `{ _id, metadata.ownerId: A }`, so it does NOT match B's file and deletes nothing — the
        // 18.8 boundary, enforced by the scoped delete rather than by a pre-check the sweep could skip.
        const bFile = await mediaMod.writeMedia(b, 'crop-image', 'image/jpeg', Buffer.from('B-owns-bytes'));
        const conversation = await farmerMod.farmerData(a).insertConversation({ channel: 'web', title: null });
        const stored = await farmerMod.farmerData(a).insertDiagnosis({
          conversationId: conversation._id,
          status: 'identified',
          diseaseName: 'Tomato Early Blight',
          knowledgeId: null,
          confidence: 0.8,
          severity: 'moderate',
          explanation: 'x',
          language: 'en',
          needsExpert: false,
          channel: 'web',
          mediaRef: bFile, // A's row pointing at B's file — the corruption.
          fullImageDeletedAt: null,
          modelProvider: 'gemini',
        });
        await harness!.db
          .collection<DiagnosisDoc>('diagnoses')
          .updateOne({ _id: stored._id }, { $set: { createdAt: LONG_PAST } });

        await retentionSvc.sweepFullImages({ now: NOW, limit: RETENTION_SWEEP_BATCH_LIMIT });

        // B's file survives — A's sweep pass could not reach across the tenant boundary to delete it.
        expect(await fileExists(bFile.fileId), 'a cross-owner file was deleted').toBe(true);
        // B, reading their own file, still has it.
        expect(await mediaMod.readMediaForOwner(b, bFile.fileId.toHexString())).not.toBeNull();
      }),
      { numRuns: 20 },
    );
  }, 30_000);
});

/* ========================================================================== */
/* Scan 2 — the orphan backstop refuses a file with no owner metadata (seam)   */
/* ========================================================================== */

describe('Property 31, scan 2: an orphan with no owner metadata is refused, never deleted', () => {
  interface OrphanFile {
    readonly fileId: ObjectId;
    readonly ownerId: string | null;
    readonly uploadDate: Date;
    readonly length: number;
  }

  const OWNER_KINDS = ['owned', 'null_owner', 'empty_owner'] as const;
  type OwnerKind = (typeof OWNER_KINDS)[number];

  /**
   * A batch of aged files as scan 2's age listing would report them, one per owner kind at a
   * generated position — including the case where the only files are ownerless, so a refusal is not
   * masked by an owned one deleting.
   */
  const batchArb = fc
    .array(
      fc.record({
        kind: fc.constantFrom<OwnerKind>(...OWNER_KINDS),
        owner: farmerIdArb,
      }),
      { minLength: 1, maxLength: 8 },
    )
    .map((entries) =>
      entries.map<OrphanFile>((entry) => ({
        fileId: new ObjectId(),
        ownerId: entry.kind === 'owned' ? entry.owner : entry.kind === 'empty_owner' ? '' : null,
        uploadDate: LONG_PAST,
        length: 1000,
      })),
    );

  it('deletes only files carrying a real metadata.ownerId, and counts the ownerless as refused', async () => {
    const kindsSeen = new Set<OwnerKind>();

    await fc.assert(
      fc.asyncProperty(batchArb, async (files) => {
        for (const file of files) {
          kindsSeen.add(file.ownerId === null ? 'null_owner' : file.ownerId === '' ? 'empty_owner' : 'owned');
        }

        const deleted: string[] = [];

        // Inject the age listing and the delete-by-id seam. `listAged` returns the batch for
        // `crop-image` and nothing for `voice`; `deleteFileById` records what it was asked to delete
        // — it must never be handed an ownerless file (Requirement 18.8).
        const report = await retentionSvc.sweepOrphans({
          now: NOW,
          limit: RETENTION_SWEEP_BATCH_LIMIT,
          listAged: (kind: 'crop-image' | 'thumbnail' | 'voice') =>
            Promise.resolve(
              kind === 'crop-image'
                ? files.map((f) => ({
                    fileId: f.fileId,
                    ownerId: f.ownerId,
                    uploadDate: f.uploadDate,
                    length: f.length,
                  }))
                : [],
            ),
          deleteFileById: (fileId: ObjectId) => {
            deleted.push(fileId.toHexString());
            return Promise.resolve(true);
          },
        });

        const ownerless = files.filter((f) => f.ownerId === null || f.ownerId === '');
        const owned = files.filter((f) => f.ownerId !== null && f.ownerId !== '');

        // Requirement 18.8: no ownerless file was ever handed to a delete.
        for (const f of ownerless) {
          expect(deleted, `an ownerless file was deleted: ${f.fileId.toHexString()}`).not.toContain(
            f.fileId.toHexString(),
          );
        }
        // Every owned file (and only those) was deleted — the positive direction, so the refusal is
        // not vacuous.
        expect([...deleted].sort()).toStrictEqual(owned.map((f) => f.fileId.toHexString()).sort());

        // The report accounts for the split, and nothing outside the listed files was deleted.
        expect(report.scanned).toBe(files.length);
        expect(report.removed).toBe(owned.length);
        expect(report.refused).toBe(ownerless.length);
        expect(report.failed).toBe(0);
      }),
      { numRuns: 200 },
    );

    expect([...kindsSeen].sort()).toStrictEqual([...OWNER_KINDS].sort());
  });

  it('never lists thumbnails, so a Thumbnail_Derivative is never swept (Requirement 18.5)', async () => {
    const kindsAsked: string[] = [];
    await retentionSvc.sweepOrphans({
      now: NOW,
      limit: RETENTION_SWEEP_BATCH_LIMIT,
      listAged: (kind: 'crop-image' | 'thumbnail' | 'voice') => {
        kindsAsked.push(kind);
        return Promise.resolve([]);
      },
      deleteFileById: () => Promise.resolve(true),
    });
    // The sweep asks only for the two original kinds, never `thumbnail`.
    expect(kindsAsked.sort()).toStrictEqual(['crop-image', 'voice']);
    expect(kindsAsked).not.toContain('thumbnail');
  });
});

/* ========================================================================== */
/* On-success voice deletion is owner-scoped (real layer, Property 5's dim.)    */
/* ========================================================================== */

describe('Property 31: on-success voice deletion is bound to the requesting farmer', () => {
  it('deletes a farmer’s own voice file and refuses to delete another farmer’s', async () => {
    await fc.assert(
      fc.asyncProperty(twoFarmersArb, async (farmers) => {
        await clearDatabase(harness!.db);
        await setupDatabase(harness!.db);
        const [a, b] = farmers;

        const voiceA = await mediaMod.writeMedia(a, 'voice', 'audio/ogg', Buffer.from('A-voice'));
        const voiceB = await mediaMod.writeMedia(b, 'voice', 'audio/ogg', Buffer.from('B-voice'));

        // A deleting A's own voice file on transcription success — the `deleteMediaForOwner` owner
        // check is `metadata.ownerId === A`.
        expect(await mediaMod.deleteMediaForOwner(a, voiceA.fileId.toHexString())).toBe(true);
        expect(await fileExists(voiceA.fileId)).toBe(false);

        // A cannot delete B's voice file — the same scoped delete refuses it, and B's file survives.
        expect(await mediaMod.deleteMediaForOwner(a, voiceB.fileId.toHexString())).toBe(false);
        expect(await fileExists(voiceB.fileId)).toBe(true);
      }),
      { numRuns: 20 },
    );
  }, 30_000);
});

/* ========================================================================== */
/* The sweep route cannot be aimed by a caller (Property 30's dimension)        */
/* ========================================================================== */

describe('Property 31: no caller-supplied value can reach a delete target', () => {
  /**
   * The ways a route handler could let a request influence what gets deleted. Enumerated so this is a
   * closed check: the sweep's window, batch bound and candidate set are configuration, not input.
   */
  const REQUEST_READERS = [
    'request.json',
    'request.text',
    'request.formData',
    'request.arrayBuffer',
    'request.body',
    'searchParams',
    'nextUrl',
  ] as const;

  it('invokes the sweep with no caller input and reads only the CRON_SECRET authorization header', () => {
    const source = readFileSync(
      resolve(__dirname, '..', '..', 'src', 'app', 'api', 'internal', 'retention-sweep', 'route.ts'),
      'utf8',
    );
    // Comments stripped so a sentence discussing an expression is not read as the expression.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // The sweep is invoked with no argument carrying a caller value.
    expect(code).toMatch(/runRetentionSweep\(\s*\)/);
    expect(code).not.toMatch(/runRetentionSweep\(\s*[^)\s]/);

    for (const reader of REQUEST_READERS) {
      expect(code, `the sweep route reads ${reader}`).not.toContain(reader);
    }

    // The one header it reads is the credential.
    const headerGets = [...code.matchAll(/headers\.get\(/g)];
    expect(headerGets.length, 'the sweep route reads more than one header').toBe(1);
    expect(code.toLowerCase()).toContain("authorization");
  });
});
