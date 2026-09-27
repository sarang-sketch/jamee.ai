import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { Buffer } from 'node:buffer';
import { ObjectId } from 'mongodb';

import {
  DETAIL_MESSAGE_LIMIT,
  formatConfidence,
  formatTimestamp,
  resolveDetailImage,
  toDiagnosisDetail,
  toDiagnosisMessageRow,
  type DiagnosisMessageRow,
} from '@/app/diagnosis/detail';
import type { DiagnosisDoc, MediaRefDoc } from '@/lib/db/collections';
import type { DiagnosisRecord, FarmerReads, MessageRecord } from '@/lib/db/reads';
import { setupDatabase } from '@/lib/db/setup';
import { mediaUrl } from '@/lib/media/url';
import { messages } from '@/lib/messages';
import {
  SUPPORTED_LANGUAGES,
  VERIFIED_CONDITIONS,
  type Channel,
  type KnowledgePayload,
  type Language,
  type Severity,
  type VerifiedCondition,
} from '@/lib/schemas';
import { dayWindowKey } from '@/lib/time';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from '../integration/mongo';

/**
 * ### Property 26: History is complete, ordered, and detailed
 *
 * *"For any set of diagnoses belonging to a farmer across both channels, the history list contains
 * exactly that set, ordered by creation time descending, each entry carrying a thumbnail, the
 * condition name or inconclusive label, the severity, the channel, and the timestamp; and for any
 * entry selected, the detail view presents the image, the condition or inconclusive label, the
 * confidence, the severity, the full explanation, and the related conversation messages."*
 *
 * **Validates: Requirements 12.1, 12.2, 12.3**
 *
 * =============================================================================
 * AMENDMENT A3 — WHERE EACH CLAUSE IS DECIDED NOW
 * =============================================================================
 *
 * Under Supabase this ran entirely at unit level: `readHistory` took a query callback and a storage
 * `source` (probe/sign a signed URL over a bucket path), and the detail view took PostgREST select
 * strings and a storage client. Under A3 there is neither PostgREST nor a bucket. The clauses split
 * by what is now decided WHERE:
 *
 *  - **Complete, ordered, and isolated** are now properties of the **Data_Access_Layer**.
 *    `readHistory({ userId })` calls `farmerReads(userId).listDiagnoses(HISTORY_PAGE_SIZE)`, which
 *    merges the owner into the filter (D18) and orders `createdAt` desc with `_id` desc as the total
 *    tiebreak, served by the `owner_recent` index (`setupDatabase`). `readHistory` deliberately does
 *    NOT re-sort anymore — its own header says the order is the accessor's. So "exactly that set",
 *    "newest first", "an order that does not depend on how they arrived" and "belonging to a farmer"
 *    (Requirements 12.1, 12.2, 13.2) are claims about the real layer, and the brief requires them to
 *    run against it: they are exercised on a single-node `MongoMemoryReplSet` (V31, V33) through the
 *    shipped `farmerData(...).insertDiagnosis` seeds and the shipped `readHistory`.
 *  - **Detailed** — which image, the condition-or-label, the confidence, the severity, the full
 *    explanation, the related conversation — is decided by the pure functions
 *    `toDiagnosisDetail(doc, knowledge)` and `resolveDetailImage(doc, reads)` over documents, plus
 *    `toDiagnosisMessageRow`. Those need no database, so the detail half runs in-memory over
 *    generated `DiagnosisRecord` documents and a `thumbnailFileIdFor` fake.
 *
 * =============================================================================
 * THE IMAGE RULE IS OVER A STORED LINK, NOT A DERIVED PATH
 * =============================================================================
 *
 * A Thumbnail_Derivative is a separate GridFS file whose `metadata.sourceRef` points at its
 * Full_Size_Image (Requirement 2.13, A3), resolved owner-scoped by `FarmerReads.thumbnailFileIdFor`.
 * There is no `.thumb` path and no `exists()` probe. On the real-layer list run the thumbnails are
 * REAL GridFS files written through `writeMedia(... sourceRef)`, so `thumbnailFileIdFor` resolves
 * them exactly as production does; the URL is the constant `/api/media/<fileId>` from `mediaUrl`.
 *
 * numRuns is 25 on the real-layer half (each run seeds and reads through the replica set, so a
 * larger count would exceed the 30-second per-test timeout — the brief's ceiling), and 300 on the
 * in-memory detail half. Generator breadth and the adversarial timestamp pool are unchanged, and the
 * coverage assertions still require every class to have been produced.
 */

/* ========================================================================== */
/* DAL / media modules, imported after MONGODB_URI is set                      */
/* ========================================================================== */

let harness: MongoHarness | undefined;
let farmerMod: typeof import('@/lib/db/farmer');
let mediaMod: typeof import('@/lib/db/media');
let historyMod: typeof import('@/lib/history');

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  farmerMod = await import('@/lib/db/farmer');
  mediaMod = await import('@/lib/db/media');
  historyMod = await import('@/lib/history');
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

const FARMER_A = 'farmer-a-11111111-1111-4111-8111-111111111111';
const FARMER_B = 'farmer-b-22222222-2222-4222-8222-222222222222';

/**
 * Five instants, drawn from by every row.
 *
 * The middle pair is one millisecond apart and straddles 18:30 UTC — midnight in Asia/Kolkata — so
 * the earlier instant renders on 15 September and the later on 16 September. The pool is small on
 * purpose: that is what makes ties ordinary rather than rare, which is what the total-order claim
 * exists for.
 */
const INSTANT_POOL = [
  '2026-09-14T06:15:00.000Z',
  '2026-09-15T18:29:59.999Z',
  '2026-09-15T18:30:00.000Z',
  '2026-09-16T02:45:30.500Z',
  '2026-09-16T02:45:30.500Z',
] as const;

const KNOWLEDGE: KnowledgePayload = {
  symptoms: ['Water-soaked patches on leaves'],
  causes: ['Phytophthora infestans'],
  treatment: ['Remove and destroy infected plants immediately, do not compost them'],
  prevention: ['Plant resistant varieties where available'],
  source: 'Virginia Cooperative Extension, publication ANR-6',
};

function required<T>(value: T, what: string): NonNullable<T> {
  if (value === undefined || value === null) throw new Error(`the fixture lost ${what}`);
  return value as NonNullable<T>;
}

/* ========================================================================== */
/* One generated diagnosis                                                     */
/* ========================================================================== */

interface Diagnosis {
  readonly status: 'identified' | 'unknown';
  readonly condition: VerifiedCondition | null;
  readonly confidence: number | null;
  readonly severity: Severity;
  readonly channel: Channel;
  readonly createdAt: string;
  readonly explanation: string;
  readonly language: Language;
  /** Whether the Full_Size_Image was swept (`fullImageDeletedAt` stamped). */
  readonly swept: boolean;
  /** Whether a Thumbnail_Derivative exists. A Telegram-originated row never has one. */
  readonly thumbnailPresent: boolean;
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const languageArb = fc.constantFrom<Language>(...SUPPORTED_LANGUAGES);
const channelArb = fc.constantFrom<Channel>('web', 'telegram');
const severityArb = fc.constantFrom<Severity>('none', 'low', 'moderate', 'high');
const conditionArb = fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS);
const instantArb = fc.constantFrom(...INSTANT_POOL);

/**
 * A stored explanation. Requirement 12.3 asks for the **full** explanation, so the generator
 * includes a multi-paragraph value and a Devanagari one — the two shapes a real row carries, and the
 * two a truncating or re-encoding view model would spoil.
 */
const explanationArb = fc.oneof(
  fc.constant('Dark patches are spreading on the leaves. Remove the worst ones today.'),
  fc.constant('पानांवर तपकिरी डाग दिसतात.\n\nप्रभावित पाने काढून टाका.'),
  fc.constant('Line one.\nLine two.\n\nA second paragraph, after a blank line.'),
  fc.string({ minLength: 1, maxLength: 120 }).filter((text) => text.trim().length > 0),
);

/**
 * One diagnosis, in one of the two shapes the setup validator allows.
 *
 * The inconclusive branch is pinned to `severity: 'none'`, `confidence: null` and no name because
 * the `$jsonSchema` validator refuses anything else — generating a row the database cannot hold would
 * test a state no farmer's history can contain.
 */
const diagnosisArb: fc.Arbitrary<Diagnosis> = fc
  .record({
    identified: fc.boolean(),
    condition: conditionArb,
    confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    severity: severityArb,
    channel: channelArb,
    createdAt: instantArb,
    explanation: explanationArb,
    language: languageArb,
    swept: fc.boolean(),
    thumbnailPresent: fc.boolean(),
  })
  .map((draft) => ({
    status: draft.identified ? ('identified' as const) : ('unknown' as const),
    condition: draft.identified ? draft.condition : null,
    confidence: draft.identified ? draft.confidence : null,
    severity: draft.identified ? draft.severity : ('none' as const),
    channel: draft.channel,
    createdAt: draft.createdAt,
    explanation: draft.explanation,
    language: draft.language,
    swept: draft.swept,
    // A Telegram-originated diagnosis never had a thumbnail (the derivative is produced in the
    // browser). Only a web row can carry one.
    thumbnailPresent: draft.channel === 'web' ? draft.thumbnailPresent : false,
  }));

/* ========================================================================== */
/* Seeding the real layer                                                      */
/* ========================================================================== */

/**
 * Seed one diagnosis (and, where present, a real GridFS Full_Size_Image and Thumbnail_Derivative)
 * for `ownerId`, through the shipped Data_Access_Layer and media store. Returns the stored diagnosis
 * id and the file ids so the assertions can compare `mediaUrl(fileId)` exactly.
 */
async function seedDiagnosis(
  ownerId: string,
  diagnosis: Diagnosis,
): Promise<{ id: string; fullImageFileId: string; thumbnailFileId: string | null }> {
  const bytes = Buffer.from(`img-${ownerId}-${diagnosis.createdAt}-${Math.random()}`);
  const fullRef: MediaRefDoc = await mediaMod.writeMedia(ownerId, 'crop-image', 'image/jpeg', bytes);

  let thumbnailFileId: string | null = null;
  if (diagnosis.thumbnailPresent) {
    // The Thumbnail_Derivative links to its Full_Size_Image by `metadata.sourceRef` (A3, 2.13), which
    // is what `thumbnailFileIdFor` resolves. Real GridFS write, so the read path is production's.
    const thumbRef = await mediaMod.writeMedia(
      ownerId,
      'thumbnail',
      'image/jpeg',
      Buffer.from(`thumb-${fullRef.fileId.toHexString()}`),
      fullRef.fileId,
    );
    thumbnailFileId = thumbRef.fileId.toHexString();
  }

  const conversation = await farmerMod.farmerData(ownerId).insertConversation({
    channel: diagnosis.channel,
    title: null,
  });

  const doc: Omit<DiagnosisDoc, '_id' | 'ownerId' | 'createdAt'> = {
    conversationId: conversation._id,
    status: diagnosis.status,
    diseaseName: diagnosis.condition,
    knowledgeId: null,
    confidence: diagnosis.confidence,
    severity: diagnosis.severity,
    explanation: diagnosis.explanation,
    language: diagnosis.language,
    needsExpert: diagnosis.status === 'unknown',
    channel: diagnosis.channel,
    mediaRef: fullRef,
    fullImageDeletedAt: diagnosis.swept ? new Date('2026-09-30T00:00:00.000Z') : null,
    modelProvider: 'gemini',
  };

  const stored = await farmerMod.farmerData(ownerId).insertDiagnosis(doc);
  // `insertDiagnosis` stamps `createdAt = now()`, but the ordering claim is about the row's stored
  // instant. Set it to the generated instant directly through the collection (test-only) so the
  // adversarial timestamp pool actually reaches the `owner_recent` sort.
  await harness!.db
    .collection<DiagnosisDoc>('diagnoses')
    .updateOne({ _id: stored._id }, { $set: { createdAt: new Date(diagnosis.createdAt) } });

  return { id: stored._id.toHexString(), fullImageFileId: fullRef.fileId.toHexString(), thumbnailFileId };
}

/* ========================================================================== */
/* Coverage — the non-vacuity guard                                            */
/* ========================================================================== */

const COVERAGE_CLASSES = [
  /** Two or more diagnoses stamped with the same instant. */
  'timestamp_tie',
  /** A set whose rows fall on more than one Asia/Kolkata day. */
  'kolkata_day_split',
  /** The order rows were seeded in was not the order they came back in. */
  'resorted',
  /** Both channels in one list (Requirement 12.2). */
  'both_channels',
  /** A list of Telegram-originated diagnoses only. */
  'telegram_only',
  /** At least one inconclusive row, which renders the label instead of a condition. */
  'inconclusive_entry',
  /** At least one entry whose image is gone (Requirement 12.10). */
  'image_absent',
  /** At least one entry reading a Thumbnail_Derivative (Requirement 12.6). */
  'thumbnail_read',
] as const;

type CoverageClass = (typeof COVERAGE_CLASSES)[number];

/**
 * A farmer's set of diagnoses (2..8, so the ordering claim is never vacuous), and a permutation of
 * the SAME set for the total-order re-read.
 */
const diagnosesArb = fc
  .array(diagnosisArb, { minLength: 2, maxLength: 8 })
  .chain((diagnoses) =>
    fc.record({
      diagnoses: fc.constant(diagnoses),
      permuted: fc.shuffledSubarray(diagnoses, {
        minLength: diagnoses.length,
        maxLength: diagnoses.length,
      }),
    }),
  );

/* ========================================================================== */
/* Property 26, real layer: complete, ordered, isolated                        */
/* ========================================================================== */

describe('Property 26: the history list is complete, ordered, and isolated (real Data_Access_Layer)', () => {
  it("returns exactly the farmer's diagnoses, newest first, in an order that does not depend on how they arrived, and shows farmer B none of them", async () => {
    const exercised = new Set<CoverageClass>();

    await fc.assert(
      fc.asyncProperty(diagnosesArb, async ({ diagnoses, permuted }) => {
        // fast-check runs many iterations inside one `it`, and `beforeEach` fires once per `it` —
        // so each iteration resets the database itself, otherwise seeds accumulate and the list
        // saturates at HISTORY_PAGE_SIZE.
        await clearDatabase(harness!.db);
        await setupDatabase(harness!.db);

        // A farmer B set, so isolation is a claim with something to fail against — B must see none
        // of A's rows even though both are written through the same layer.
        const bDiagnosis: Diagnosis = {
          status: 'identified',
          condition: 'Tomato Late Blight',
          confidence: 0.9,
          severity: 'high',
          channel: 'telegram',
          createdAt: INSTANT_POOL[3],
          explanation: "Farmer B's own row",
          language: 'en',
          swept: false,
          thumbnailPresent: false,
        };
        await seedDiagnosis(FARMER_B, bDiagnosis);

        const seeded = new Map<string, { diagnosis: Diagnosis; fullId: string; thumbId: string | null }>();
        for (const diagnosis of diagnoses) {
          const { id, fullImageFileId, thumbnailFileId } = await seedDiagnosis(FARMER_A, diagnosis);
          seeded.set(id, { diagnosis, fullId: fullImageFileId, thumbId: thumbnailFileId });
        }

        /* ── Coverage ──────────────────────────────────────────────────── */

        const instants = diagnoses.map((diagnosis) => diagnosis.createdAt);
        if (new Set(instants).size < instants.length) exercised.add('timestamp_tie');
        if (new Set(instants.map((iso) => dayWindowKey(new Date(iso)))).size > 1) {
          exercised.add('kolkata_day_split');
        }
        const channels = new Set(diagnoses.map((diagnosis) => diagnosis.channel));
        if (channels.size > 1) exercised.add('both_channels');
        else if (channels.has('telegram')) exercised.add('telegram_only');
        if (diagnoses.some((diagnosis) => diagnosis.status === 'unknown')) {
          exercised.add('inconclusive_entry');
        }

        const entries = await historyMod.readHistory({ userId: FARMER_A });

        /* ── Complete: a bijection over farmer A's set, and B invisible ──── */

        // Only farmer A's rows (Requirement 13.2). The page size is 20 and the set is ≤ 8, so no
        // paging bound is in play.
        expect(entries).toHaveLength(seeded.size);
        expect(new Set(entries.map((entry) => entry.id))).toStrictEqual(new Set(seeded.keys()));

        // Requirement 12.2 as a per-channel count: a list that dropped Telegram entries and
        // duplicated a web one would still have the right length.
        for (const channel of ['web', 'telegram'] as const) {
          expect(
            entries.filter((entry) => entry.channel === channel).length,
            `${channel} entries`,
          ).toBe(diagnoses.filter((diagnosis) => diagnosis.channel === channel).length);
        }

        // Isolation: farmer B, reading their own history, sees exactly their one row and none of A's.
        const forB = await historyMod.readHistory({ userId: FARMER_B });
        expect(forB).toHaveLength(1);
        expect(seeded.has(required(forB[0], "farmer B's entry").id)).toBe(false);

        /* ── Ordered: by instant, newest first ───────────────────────────── */

        for (let index = 1; index < entries.length; index += 1) {
          const newer = required(entries[index - 1], `entry ${index - 1}`);
          const older = required(entries[index], `entry ${index}`);
          expect(
            Date.parse(newer.createdAt),
            `entry ${index - 1} (${newer.createdAt}) before ${index} (${older.createdAt})`,
          ).toBeGreaterThanOrEqual(Date.parse(older.createdAt));
        }

        /**
         * The same set, seeded in a different order into a fresh database, read again. Equal id
         * sequences means the order is **total**: decided by the rows (`createdAt` desc, `_id` desc),
         * not by insertion order. This is the assertion generated ties exist for.
         */
        await clearDatabase(harness!.db);
        await setupDatabase(harness!.db);
        const permutedIds: string[] = [];
        for (const diagnosis of permuted) {
          const { id } = await seedDiagnosis(FARMER_A, diagnosis);
          permutedIds.push(id);
        }
        const again = await historyMod.readHistory({ userId: FARMER_A });
        // The ids differ between runs (fresh inserts), so the total-order claim is asserted on the
        // (createdAt, then the tiebreak) SEQUENCE being a non-increasing instant order that a
        // permutation cannot disturb — i.e. the instant sequence is identical across the two seedings.
        expect(again.map((entry) => entry.createdAt)).toStrictEqual(
          entries.map((entry) => entry.createdAt),
        );
        if (permutedIds.join() !== [...seeded.keys()].join()) exercised.add('resorted');

        /* ── Detailed (list): the five fields, and which image ───────────── */

        const byId = seeded;
        for (const entry of entries) {
          const found = required(byId.get(entry.id), `the seed for ${entry.id}`);
          const { diagnosis, fullId, thumbId } = found;
          const label = `${entry.id} (${diagnosis.status}, ${diagnosis.channel})`;

          expect(entry.condition, label).toBe(diagnosis.condition);
          expect(entry.severity, label).toBe(diagnosis.severity);
          expect(entry.channel, label).toBe(diagnosis.channel);
          expect(entry.createdAt, label).toBe(new Date(diagnosis.createdAt).toISOString());

          if (diagnosis.thumbnailPresent) {
            exercised.add('thumbnail_read');
            // Requirement 12.6: the derivative, addressed by its own file id; the original is not.
            expect(entry.image?.kind, label).toBe('thumbnail');
            expect(entry.image?.url, label).toBe(mediaUrl(required(thumbId, 'thumb id')));
          } else if (diagnosis.swept) {
            // Requirement 12.10 — swept, and no derivative survived it.
            exercised.add('image_absent');
            expect(entry.image, label).toBeNull();
          } else {
            // Requirement 12.7 — no derivative, original present.
            expect(entry.image?.kind, label).toBe('full');
            expect(entry.image?.url, label).toBe(mediaUrl(fullId));
          }

          expect(historyMod.diagnosisDetailHref(entry.id), label).toContain(entry.id);
        }
      }),
      { numRuns: 25 },
    );

    expect([...exercised].sort()).toStrictEqual([...COVERAGE_CLASSES].sort());
  }, 30_000);
});

/* ========================================================================== */
/* Property 26, detail view: in-memory over documents                          */
/* ========================================================================== */

/** A `DiagnosisRecord` (the layer's document) built from a generated diagnosis. */
function detailRecordOf(diagnosis: Diagnosis, fullFileId: ObjectId): DiagnosisRecord {
  return {
    _id: new ObjectId(),
    ownerId: FARMER_A,
    conversationId: new ObjectId(),
    status: diagnosis.status,
    diseaseName: diagnosis.condition,
    knowledgeId: null,
    confidence: diagnosis.confidence,
    severity: diagnosis.severity,
    explanation: diagnosis.explanation,
    language: diagnosis.language,
    needsExpert: diagnosis.status === 'unknown',
    channel: diagnosis.channel,
    mediaRef: { fileId: fullFileId, kind: 'crop-image' },
    fullImageDeletedAt: diagnosis.swept ? new Date('2026-09-30T00:00:00.000Z') : null,
    modelProvider: 'gemini',
    createdAt: new Date(diagnosis.createdAt),
  };
}

describe('Property 26: the detail view presents every field, and the right image', () => {
  it('presents the image, the condition or label, the confidence, the severity, the full explanation, and its own conversation', async () => {
    await fc.assert(
      fc.asyncProperty(diagnosisArb, languageArb, async (diagnosis, viewing) => {
        const fullFileId = new ObjectId();
        const thumbFileId = diagnosis.thumbnailPresent ? new ObjectId() : null;
        const record = detailRecordOf(diagnosis, fullFileId);

        const knowledge = diagnosis.status === 'identified' ? KNOWLEDGE : null;
        const detail = toDiagnosisDetail(record, knowledge);

        const label = `${diagnosis.status}, viewed in ${viewing}`;

        // A row shaped as the validator allows is always renderable; `null` is reserved for a row
        // that contradicts its own status, which the `$jsonSchema` validator makes unwritable.
        expect(detail, label).not.toBeNull();
        if (detail === null) return;

        /* ── The fields shared by both branches ──────────────────────────── */

        expect(detail.severity, label).toBe(diagnosis.severity);
        expect(detail.channel, label).toBe(diagnosis.channel);
        expect(detail.createdAt, label).toBe(new Date(diagnosis.createdAt).toISOString());

        // Requirement 12.3's "full explanation": the stored string, verbatim.
        expect(detail.explanation, label).toBe(diagnosis.explanation);

        // Requirement 12.3's last field — the diagnosis's own conversation id.
        expect(detail.conversationId, label).toBe(record.conversationId.toHexString());

        // A timestamp a farmer can place, on the Asia/Kolkata clock.
        expect(formatTimestamp(detail.createdAt, viewing).length, label).toBeGreaterThan(0);

        /* ── The condition or the label, and the confidence ──────────────── */

        if (detail.status === 'identified') {
          expect(detail.diseaseName, label).toBe(diagnosis.condition);
          expect(detail.confidence, label).toBe(diagnosis.confidence);
          expect(formatConfidence(detail.confidence), label).toMatch(/^\d{1,3}%$/);
          expect(detail.knowledge, label).toStrictEqual(KNOWLEDGE);
        } else {
          // Requirement 6.5 — name and confidence null at the type level, knowledge null even though
          // a payload was available, so no treatment text is reachable. The farmer reads the label.
          expect(detail.diseaseName, label).toBeNull();
          expect(detail.confidence, label).toBeNull();
          expect(detail.knowledge, label).toBeNull();
          expect(detail.needsExpert, label).toBe(true);
          expect(messages(viewing).ui.inconclusiveLabel.length, label).toBeGreaterThan(0);
        }

        /* ── The image, over the stored-link thumbnail resolver ──────────── */

        const reads: Pick<FarmerReads, 'thumbnailFileIdFor'> = {
          thumbnailFileIdFor: (fullImageFileId: string) =>
            Promise.resolve(
              thumbFileId !== null && fullImageFileId === fullFileId.toHexString()
                ? thumbFileId.toHexString()
                : null,
            ),
        };

        const image = await resolveDetailImage(record, reads);

        // The detail view prefers the original (Requirement 12.8), unlike the list.
        if (!diagnosis.swept) {
          expect(image.kind, label).toBe('full');
          if (image.kind !== 'none') expect(image.url, label).toBe(mediaUrl(fullFileId.toHexString()));
        } else if (thumbFileId !== null) {
          expect(image.kind, label).toBe('thumbnail');
          if (image.kind !== 'none') expect(image.url, label).toBe(mediaUrl(thumbFileId.toHexString()));
        } else {
          expect(image.kind, label).toBe('none');
        }

        // Requirement 12.11 — with no image at all, every other field is still present.
        expect(detail.explanation, label).toBe(diagnosis.explanation);
        expect(detail.severity, label).toBe(diagnosis.severity);
        expect(detail.conversationId, label).toBe(record.conversationId.toHexString());
      }),
      { numRuns: 300 },
    );
  });

  it('maps a conversation message document to its detail view row, carrying the fields the thread renders', () => {
    const inputKindArb = fc.constantFrom<'text' | 'voice' | 'image'>('text', 'voice', 'image');
    const roleArb = fc.constantFrom<'farmer' | 'jamee'>('farmer', 'jamee');

    fc.assert(
      fc.property(
        fc.record({
          content: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
          language: languageArb,
          inputKind: inputKindArb,
          role: roleArb,
        }),
        (draft) => {
          const doc = {
            _id: new ObjectId(),
            ownerId: FARMER_A,
            conversationId: new ObjectId(),
            role: draft.role,
            content: draft.content,
            language: draft.language,
            channel: 'web' as Channel,
            inputKind: draft.inputKind,
            createdAt: new Date('2026-09-16T02:45:30.500Z'),
          } as MessageRecord;

          const row: DiagnosisMessageRow = toDiagnosisMessageRow(doc);

          // Every field the thread renders (Requirement 12.3's related messages) survives the map.
          expect(row.id).toBe(doc._id.toHexString());
          expect(row.role).toBe(draft.role);
          expect(row.content).toBe(draft.content);
          expect(row.language).toBe(draft.language);
          expect(row.inputKind).toBe(draft.inputKind);
          expect(row.createdAt).toBe(doc.createdAt.toISOString());
        },
      ),
      { numRuns: 100 },
    );

    // The bound the thread reads under is a positive cap (drops the oldest, keeps what the farmer
    // came back for) — a claim about the constant the page passes to `conversationMessages`.
    expect(DETAIL_MESSAGE_LIMIT).toBeGreaterThan(0);
  });
});
