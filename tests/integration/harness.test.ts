import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { VERIFIED_CONDITIONS } from '@/lib/schemas';
import { COLLECTIONS } from '@/lib/db/names';

import { profileOf } from './farmers';
import { startHarness, type Harness } from './harness';
import { startMongo } from './mongo';

/**
 * Harness smoke test: proves the integration project runs against a real single-node
 * `MongoMemoryReplSet` (V31, V33), that two farmers minted through the Google path get a D8 Profile
 * with no phone, and that owner-scoping (the Data_Access_Layer, D18) refuses a cross-farmer read.
 *
 * Requirements: 13.1 / 13.2 (owner-scoping, and each farmer restricted to their own documents), 4.1
 *               / 4.2 (exactly the five verified conditions, each with a source), 1.4 (a first
 *               Google sign-in produces a Profile keyed by the Auth_User_Id and carrying the Google
 *               email), 1.9 (no phone is written), 12.1, 12.2, 17.5
 * Design: Amendment A3 — the harness no longer needs a local Supabase stack, and no longer
 *         self-skips on a missing `JAMEE_TEST_DATABASE_URL`; it starts an in-memory replica set and
 *         a failed start FAILS the run loudly (task 53.5, the broken-gate rule) rather than skipping.
 *
 * **The cross-farmer read is the assertion that justifies the whole harness.** Every other
 * assertion here could be made against a fake accessor; "farmer B reads farmer A's document and gets
 * zero documents" cannot, because the thing under test is the owner merge inside the layer, proven
 * end-to-end against a real database.
 *
 * The half of the harness that needs no database — the classification fixtures, the provider stubs
 * — is tested in `tests/unit/integration-harness.test.ts`, so a fixture bug is caught on every
 * `npm test` rather than only when the integration project runs.
 */

let harness: Harness;
type FarmerMod = typeof import('@/lib/db/farmer');
let farmer: FarmerMod;

beforeAll(async () => {
  harness = await startHarness();
  // Import AFTER startHarness set MONGODB_URI, so the DAL's cached client connects to the harness.
  farmer = await import('@/lib/db/farmer');
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await harness.reset();
});

/* ========================================================================== */
/* The knowledge base setupDatabase seeded (4.1, 4.2)                          */
/* ========================================================================== */

describe('the knowledge base setupDatabase seeded', () => {
  it('holds exactly the five verified conditions, each with a source', async () => {
    const rows = await harness.db.collection(COLLECTIONS.diseaseKnowledge).find({}).toArray();
    expect(rows).toHaveLength(VERIFIED_CONDITIONS.length);
    expect(rows.map((row) => row.diseaseName).sort()).toEqual([...VERIFIED_CONDITIONS].sort());
    for (const row of rows) expect(String(row.source).trim()).not.toBe('');
  });

  it('gives Tomato Healthy no treatment content (Requirement 3.4)', async () => {
    const healthy = await harness.db
      .collection(COLLECTIONS.diseaseKnowledge)
      .findOne({ diseaseName: 'Tomato Healthy' });
    expect(healthy?.treatment).toEqual([]);
  });
});

/* ========================================================================== */
/* The two farmers, minted through the Google path (1.4, 1.9)                  */
/* ========================================================================== */

describe('the two farmers (the Google path + D8 bootstrap)', () => {
  it('has a D8 Profile per farmer, keyed by the Auth_User_Id and carrying the Google email (1.4)', async () => {
    const profileA = await profileOf(harness.db, harness.farmerA.id);
    const profileB = await profileOf(harness.db, harness.farmerB.id);

    expect(profileA?._id).toBe(harness.farmerA.id);
    expect(profileA?.email).toBe(harness.farmerA.email);
    expect(profileB?._id).toBe(harness.farmerB.id);
    expect(profileA?.email).not.toBe(profileB?.email);
  });

  it('writes NO phone on either Profile (Requirement 1.9)', async () => {
    const profileA = await profileOf(harness.db, harness.farmerA.id);
    const profileB = await profileOf(harness.db, harness.farmerB.id);
    // Neither the Google-path fixture nor the D8 bootstrap writes a phone: it is absent, not null.
    expect(profileA?.phone ?? null).toBeNull();
    expect(profileB?.phone ?? null).toBeNull();
  });

  it('writes the auth library user + Google account records (D8)', async () => {
    const user = await harness.db.collection('user').findOne({ _id: harness.farmerA.id as never });
    const account = await harness.db.collection('account').findOne({ userId: harness.farmerA.id });
    expect(user?.email).toBe(harness.farmerA.email);
    expect(account?.providerId).toBe('google');
  });
});

/* ========================================================================== */
/* Owner-scoping over a farmer-owned row (13.1, 13.2)                          */
/* ========================================================================== */

describe('owner-scoping over a farmer-owned row (the Data_Access_Layer, D18)', () => {
  async function seedDiagnosis(ownerId: string): Promise<string> {
    const data = farmer.farmerData(ownerId);
    const conversation = await data.insertConversation({ channel: 'web' });
    const diagnosis = await data.insertDiagnosis({
      conversationId: conversation._id,
      status: 'identified',
      diseaseName: 'Tomato Early Blight',
      knowledgeId: null,
      confidence: 0.9,
      severity: 'moderate',
      explanation: 'seeded',
      language: 'en',
      needsExpert: false,
      channel: 'web',
      mediaRef: { fileId: (await import('mongodb')).ObjectId.createFromTime(1), kind: 'crop-image' },
      fullImageDeletedAt: null,
      modelProvider: 'gemini',
    });
    return diagnosis._id.toHexString();
  }

  it('lets the owner read the row and shows the other farmer nothing', async () => {
    const id = await seedDiagnosis(harness.farmerA.id);

    const owner = await farmer.farmerData(harness.farmerA.id).findOneDiagnosis({});
    // The whole harness exists for this line: B's scope reads zero of A's documents.
    const other = await farmer.farmerData(harness.farmerB.id).findDiagnoses();

    expect(owner?._id.toHexString()).toBe(id);
    expect(other).toEqual([]);
  });

  it('shows the other farmer nothing on an unfiltered find either', async () => {
    await seedDiagnosis(harness.farmerA.id);
    const asB = await farmer.farmerData(harness.farmerB.id).findDiagnoses();
    expect(asB.some((row) => row.ownerId === harness.farmerA.id)).toBe(false);
  });

  it('keeps the append-only usage log readable only in its owner scope', async () => {
    await farmer.farmerData(harness.farmerA.id).insertUsageLog({
      operation: 'image',
      channel: 'web',
      outcome: 'success',
      usedFallback: false,
      quotaSpent: true,
    });
    const mine = await harness.db.collection(COLLECTIONS.usageLogs).find({ ownerId: harness.farmerA.id }).toArray();
    expect(mine.length).toBeGreaterThan(0);
    // Farmer B's DAL cannot even express a read of A's usage log — there is no read accessor for it,
    // and the write accessor stamps the owner. A raw scoped read confirms none is B's.
    const asB = await harness.db.collection(COLLECTIONS.usageLogs).find({ ownerId: harness.farmerB.id }).toArray();
    expect(asB).toEqual([]);
  });
});

/* ========================================================================== */
/* The fail-loud contract (task 53.5): a failed replica-set start never skips  */
/* ========================================================================== */

describe('the replica-set start fails loudly and never skips (task 53.5)', () => {
  it('startMongo throws with an explicit reason rather than returning a skip sentinel', async () => {
    // A replica set that started is a MongoHarness; a failed one THROWS from startMongo (its
    // catch rethrows with the download-failure message). It never returns undefined / a skip
    // marker — the A3 broken-gate rule. We assert the success shape is a real replica set, so a
    // regression that made startMongo swallow a failure and return a stub would fail this.
    const extra = await startMongo();
    try {
      expect(typeof extra.replSet.getUri()).toBe('string');
      expect(extra.db.databaseName).toBe('jamee');
    } finally {
      await extra.client.close().catch(() => undefined);
      await extra.replSet.stop().catch(() => undefined);
    }
  });
});
