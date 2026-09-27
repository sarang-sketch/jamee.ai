import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { VERIFIED_CONDITIONS, type VerifiedCondition } from '@/lib/schemas';
import { COLLECTIONS, type DiseaseKnowledgeDoc } from '@/lib/db/collections';

import { startHarness, type Harness } from './harness';

/**
 * The knowledge-base invariants, asserted where they live under Amendment A3: the MongoDB
 * collection validator and the seed, against a real single-node `MongoMemoryReplSet` (V31, V33).
 *
 * Requirements: 4.1 (exactly the five Verified_Conditions), 4.2 (each seeded with a `source`), 3.4
 *               (Tomato Healthy carries no treatment content), 13.3 (a Farmer may read
 *               `disease_knowledge`), 13.4 (writes go only through `setupDatabase`/`db:setup` — the
 *               Data_Access_Layer exposes no farmer write path to this collection)
 * Design: "Integration tests — mocked providers, real MongoDB"; D17, D18; Amendment A3
 * Setup: `src/lib/db/setup.ts` (the collection, its `$jsonSchema` validator, and the five-row seed
 *        that replaced `0004` + `0010`)
 *
 * =============================================================================
 * WHY NONE OF THIS IS A UNIT TEST — RESTATED FOR A3
 * =============================================================================
 *
 *  - **"exactly five rows"** is the seed in `setupDatabase`; a fixture returning five would assert
 *    its own literal. Only a database that ran the setup can be asked.
 *  - **The validator rejecting a write** is a statement failing: an out-of-enum `diseaseName`, a
 *    bad `crop`, or a blank `source` is refused by the `$jsonSchema` validator (error 121), which a
 *    TypeScript union cannot do at runtime.
 *  - **"a farmer cannot write knowledge"** is the ABSENCE of a write accessor: the Data_Access_Layer
 *    exposes read accessors for `disease_knowledge` and no farmer-scoped write, so under A3 there is
 *    no code path a farmer could reach to author agronomy — the structural successor to the retired
 *    "no RLS write policy".
 *
 * **This file never successfully writes `disease_knowledge`.** Requirement 4.3 makes it the only
 * source of agricultural content a farmer reads, so every write attempted below is expected to fail;
 * the reads afterward confirm the seeded rows are unchanged.
 */

/** The crop each condition's name commits it to. */
const CROP_OF: Record<VerifiedCondition, DiseaseKnowledgeDoc['crop']> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

/** A MongoDB document-validation failure carries code 121. */
function isValidationError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 121;
}

let harness: Harness;
type Reads = typeof import('@/lib/db/reads');
let reads: Reads;

beforeAll(async () => {
  harness = await startHarness();
  reads = await import('@/lib/db/reads');
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await harness.reset();
});

/* ========================================================================== */
/* The seed — 4.1, 4.2, 3.4                                                    */
/* ========================================================================== */

describe('the seeded knowledge base', () => {
  it('holds exactly the five Verified_Conditions, each with a source (4.1, 4.2)', () => {
    expect(harness.knowledge).toHaveLength(VERIFIED_CONDITIONS.length);
    expect(harness.knowledge.map((row) => row.diseaseName).sort()).toEqual([...VERIFIED_CONDITIONS].sort());
    for (const row of harness.knowledge) expect(row.source.trim()).not.toBe('');
  });

  it('commits each condition to the crop its name implies', () => {
    for (const row of harness.knowledge) {
      expect(row.crop).toBe(CROP_OF[row.diseaseName]);
    }
  });

  it('gives Tomato Healthy no treatment content (3.4)', () => {
    const healthy = harness.knowledge.find((row) => row.diseaseName === 'Tomato Healthy');
    expect(healthy?.treatment).toEqual([]);
  });
});

/* ========================================================================== */
/* The read accessor — 13.3                                                    */
/* ========================================================================== */

describe('the knowledge read accessor', () => {
  it('reads exactly the five seeded conditions', async () => {
    const all = await reads.knowledgeReads().all();
    expect(all).toHaveLength(VERIFIED_CONDITIONS.length);
    expect(all.map((row) => row.diseaseName).sort()).toEqual([...VERIFIED_CONDITIONS].sort());
  });

  it('reads a requested condition by name, and nothing for an empty request', async () => {
    const rows = await reads.knowledgeReads().byNames(['Tomato Late Blight', 'Potato Late Blight']);
    expect(rows.map((r) => r.diseaseName).sort()).toEqual(['Potato Late Blight', 'Tomato Late Blight']);
    expect(await reads.knowledgeReads().byNames([])).toEqual([]);
  });
});

/* ========================================================================== */
/* The validator refuses a malformed write — 13.4 restated                     */
/* ========================================================================== */

describe('the collection validator refuses a malformed knowledge write', () => {
  const base = {
    crop: 'tomato' as const,
    symptoms: ['x'],
    causes: ['x'],
    treatment: ['x'],
    prevention: ['x'],
    defaultSeverity: 'moderate' as const,
    source: 'a source',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('refuses a diseaseName outside the five Verified_Conditions', async () => {
    let threw = false;
    try {
      await harness.db.collection(COLLECTIONS.diseaseKnowledge).insertOne({ diseaseName: 'Wheat Rust', ...base } as never);
    } catch (error) {
      threw = true;
      expect(isValidationError(error)).toBe(true);
    }
    expect(threw).toBe(true);
    // The seeded rows are untouched.
    expect(await harness.db.collection(COLLECTIONS.diseaseKnowledge).countDocuments()).toBe(VERIFIED_CONDITIONS.length);
  });

  it('refuses a blank source (4.2)', async () => {
    let threw = false;
    try {
      await harness.db
        .collection(COLLECTIONS.diseaseKnowledge)
        .insertOne({ diseaseName: 'Tomato Late Blight', ...base, source: '' } as never);
    } catch (error) {
      threw = true;
      expect(isValidationError(error)).toBe(true);
    }
    expect(threw).toBe(true);
  });

  it('refuses an unknown crop', async () => {
    let threw = false;
    try {
      await harness.db
        .collection(COLLECTIONS.diseaseKnowledge)
        .insertOne({ diseaseName: 'Tomato Late Blight', ...base, crop: 'wheat' } as never);
    } catch (error) {
      threw = true;
      expect(isValidationError(error)).toBe(true);
    }
    expect(threw).toBe(true);
  });
});
