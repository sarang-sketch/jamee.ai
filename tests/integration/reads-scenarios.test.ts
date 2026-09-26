import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setupDatabase } from '@/lib/db/setup';
import { VERIFIED_CONDITIONS } from '@/lib/schemas';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from './mongo';

/**
 * Integration tests for worker w4b's read paths — history, the diagnosis detail view, chat
 * Conversation_Context, and the knowledge base — against a real single-node `MongoMemoryReplSet`
 * (V31, V33), seeded by `setupDatabase`.
 *
 * Requirements: 12.1 / 12.2 (history lists the farmer's own diagnoses newest first, both channels),
 *               12.3 / 13.2 (the detail view refuses another farmer's diagnosis with a miss, never
 *               a leak), 7.1 / 7.2 (Conversation_Context holds only that conversation's messages),
 *               4.1 / 13.3 / 13.4 (the knowledge base reads the five seeded conditions)
 * Design: D18 (owner-scoping is the Data_Access_Layer, proven end-to-end here rather than only at
 *         the accessor unit level), D17, Amendment A3
 *
 * The harness pattern mirrors `data-access.test.ts`: `MONGODB_URI` is pointed at the in-memory
 * replica set in `beforeAll` BEFORE any module that calls `getDb()` is imported, so the DAL's
 * lazily-cached client connects to the harness. The read modules under test are imported
 * dynamically for the same reason.
 */

let harness: MongoHarness | undefined;

type HistoryMod = typeof import('@/lib/history');
type DetailMod = typeof import('@/app/diagnosis/detail');
type ReadsMod = typeof import('@/lib/db/reads');
type FarmerMod = typeof import('@/lib/db/farmer');

let history: HistoryMod;
let detail: DetailMod;
let reads: ReadsMod;
let farmer: FarmerMod;

const FARMER_A = 'auth-user-aaaa';
const FARMER_B = 'auth-user-bbbb';

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  // Import AFTER MONGODB_URI is set so client.ts caches a client for the in-memory server.
  history = await import('@/lib/history');
  detail = await import('@/app/diagnosis/detail');
  reads = await import('@/lib/db/reads');
  farmer = await import('@/lib/db/farmer');
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  if (harness === undefined) throw new Error('harness not started');
  await clearDatabase(harness.db);
  // Re-seed the knowledge base after each clear: it is farmer-agnostic, read-only reference data.
  await setupDatabase(harness.db);
});

/**
 * Seed one diagnosis for a farmer in a fresh conversation, returning the ids. Uses only the DAL
 * write accessors, so the rows are owner-stamped exactly as production writes them.
 */
async function seedDiagnosis(
  ownerId: string,
  overrides: {
    diseaseName?: 'Tomato Early Blight' | 'Tomato Late Blight' | null;
    channel?: 'web';
    createdAt?: Date;
    status?: 'identified' | 'unknown';
  } = {},
): Promise<{ diagnosisId: string; conversationId: string }> {
  const data = farmer.farmerData(ownerId);
  const conversation = await data.insertConversation({ channel: overrides.channel ?? 'web' });
  const status = overrides.status ?? 'identified';
  const inserted = await data.insertDiagnosis({
    conversationId: conversation._id,
    status,
    diseaseName: status === 'unknown' ? null : (overrides.diseaseName ?? 'Tomato Early Blight'),
    knowledgeId: null,
    confidence: status === 'unknown' ? null : 0.8,
    severity: status === 'unknown' ? 'none' : 'moderate',
    explanation: 'seeded',
    language: 'en',
    needsExpert: false,
    channel: overrides.channel ?? 'web',
    mediaRef: { fileId: (await import('mongodb')).ObjectId.createFromTime(1), kind: 'crop-image' },
    fullImageDeletedAt: null,
    modelProvider: 'gemini',
  });
  // `createdAt` is stamped by the accessor; override it directly when a test needs a fixed order.
  if (overrides.createdAt !== undefined) {
    await harness!.db
      .collection('diagnoses')
      .updateOne({ _id: inserted._id }, { $set: { createdAt: overrides.createdAt } });
  }
  return { diagnosisId: inserted._id.toHexString(), conversationId: conversation._id.toHexString() };
}

/* ========================================================================== */
/* 12.1 / 12.2 — history lists only the owner's diagnoses, newest first        */
/* ========================================================================== */

describe('readHistory — owner scope and order', () => {
  it("lists only the owner's diagnoses, and never another farmer's", async () => {
    await seedDiagnosis(FARMER_A, { createdAt: new Date('2026-09-10T00:00:00.000Z') });
    await seedDiagnosis(FARMER_A, { createdAt: new Date('2026-09-12T00:00:00.000Z') });
    await seedDiagnosis(FARMER_B, { createdAt: new Date('2026-09-11T00:00:00.000Z') });

    const forA = await history.readHistory({ userId: FARMER_A });
    const forB = await history.readHistory({ userId: FARMER_B });

    expect(forA).toHaveLength(2);
    expect(forB).toHaveLength(1);
  });

  it('returns the owner’s diagnoses newest first (Requirement 12.1)', async () => {
    const oldest = await seedDiagnosis(FARMER_A, { createdAt: new Date('2026-09-01T00:00:00.000Z') });
    const middle = await seedDiagnosis(FARMER_A, { createdAt: new Date('2026-09-05T00:00:00.000Z') });
    const newest = await seedDiagnosis(FARMER_A, { createdAt: new Date('2026-09-09T00:00:00.000Z') });

    const entries = await history.readHistory({ userId: FARMER_A });

    expect(entries.map((e) => e.id)).toEqual([
      newest.diagnosisId,
      middle.diagnosisId,
      oldest.diagnosisId,
    ]);
  });

  it('applies no channel filter — every one of the owner’s diagnoses is listed (Requirement 12.2)', async () => {
    // The seeded collection validator admits `web`/`telegram` and the Zod `Channel` type admits
    // `web`/`whatsapp`, so `web` is the one channel insertable through the typed DAL today; the
    // cross-channel inclusion itself is proven at the unit level in `history.test.ts`. What this
    // asserts against a real database is the load-bearing half: the read carries NO channel
    // predicate, so two of the owner's diagnoses both come back.
    await seedDiagnosis(FARMER_A, { createdAt: new Date('2026-09-06T00:00:00.000Z') });
    await seedDiagnosis(FARMER_A, { createdAt: new Date('2026-09-08T00:00:00.000Z') });

    const entries = await history.readHistory({ userId: FARMER_A });

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.channel === 'web')).toBe(true);
  });

  it('returns an empty list for a farmer with no diagnoses (Requirement 12.4)', async () => {
    expect(await history.readHistory({ userId: FARMER_A })).toEqual([]);
  });
});

/* ========================================================================== */
/* 12.3 / 13.2 — the detail view refuses another farmer's diagnosis            */
/* ========================================================================== */

describe('the detail read — cross-tenant refusal', () => {
  it("finds the owner's own diagnosis", async () => {
    const { diagnosisId } = await seedDiagnosis(FARMER_A);

    const doc = await reads.farmerReads(FARMER_A).findDiagnosis(diagnosisId);

    expect(doc).not.toBeNull();
    expect(doc?._id.toHexString()).toBe(diagnosisId);
    // And it maps to a renderable detail view.
    expect(detail.toDiagnosisDetail(doc!, null)?.id).toBe(diagnosisId);
  });

  it("returns null for another farmer's diagnosis (a 404, never a leak)", async () => {
    const { diagnosisId } = await seedDiagnosis(FARMER_A);

    // Farmer B asks for A's diagnosis by its real id — the owner-scoped read simply does not match.
    const doc = await reads.farmerReads(FARMER_B).findDiagnosis(diagnosisId);

    expect(doc).toBeNull();
  });

  it('returns null for an unparseable id, indistinguishable from a miss', async () => {
    expect(await reads.farmerReads(FARMER_A).findDiagnosis('not-an-object-id')).toBeNull();
  });
});

/* ========================================================================== */
/* 7.1 / 7.2 — Conversation_Context holds only that conversation's messages    */
/* ========================================================================== */

describe('conversationMessages — the window is keyed on the conversation', () => {
  it("holds only that conversation's messages, not the farmer's other threads", async () => {
    const data = farmer.farmerData(FARMER_A);
    const threadOne = await data.insertConversation({ channel: 'web' });
    const threadTwo = await data.insertConversation({ channel: 'web' });

    await data.insertMessage({
      conversationId: threadOne._id,
      role: 'farmer',
      content: 'in thread one',
      language: 'en',
      channel: 'web',
      inputKind: 'text',
    });
    await data.insertMessage({
      conversationId: threadTwo._id,
      role: 'farmer',
      content: 'in thread two',
      language: 'en',
      channel: 'web',
      inputKind: 'text',
    });

    const windowOne = await reads
      .farmerReads(FARMER_A)
      .conversationMessages(threadOne._id.toHexString(), 20);

    expect(windowOne).toHaveLength(1);
    expect(windowOne[0]?.content).toBe('in thread one');
    expect(windowOne.every((m) => m.conversationId.toHexString() === threadOne._id.toHexString())).toBe(
      true,
    );
  });

  it("never returns another farmer's messages in the same conversation id", async () => {
    // Two farmers cannot share a conversation id in practice, but the owner merge must hold even if
    // farmer B guesses A's conversation id.
    const a = farmer.farmerData(FARMER_A);
    const thread = await a.insertConversation({ channel: 'web' });
    await a.insertMessage({
      conversationId: thread._id,
      role: 'farmer',
      content: 'private to A',
      language: 'en',
      channel: 'web',
      inputKind: 'text',
    });

    const asB = await reads
      .farmerReads(FARMER_B)
      .conversationMessages(thread._id.toHexString(), 20);

    expect(asB).toEqual([]);
  });
});

/* ========================================================================== */
/* 4.1 / 13.3 / 13.4 — the knowledge base reads the five seeded conditions     */
/* ========================================================================== */

describe('the knowledge accessor — the five seeded conditions', () => {
  it('reads exactly the five Verified_Conditions seeded by setupDatabase', async () => {
    const all = await reads.knowledgeReads().all();

    expect(all).toHaveLength(VERIFIED_CONDITIONS.length);
    expect(all.map((row) => row.diseaseName).sort()).toEqual([...VERIFIED_CONDITIONS].sort());
  });

  it('reads a requested condition by name, and nothing for an empty request', async () => {
    const rows = await reads.knowledgeReads().byNames(['Tomato Late Blight', 'Potato Late Blight']);
    expect(rows.map((r) => r.diseaseName).sort()).toEqual([
      'Potato Late Blight',
      'Tomato Late Blight',
    ]);

    expect(await reads.knowledgeReads().byNames([])).toEqual([]);
  });
});
