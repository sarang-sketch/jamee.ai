import type { Db } from 'mongodb';

import { VERIFIED_CONDITIONS } from '@/lib/schemas';
import type { DiseaseKnowledgeDoc } from '@/lib/db/collections';
import { COLLECTIONS } from '@/lib/db/names';

import { createTestFarmer, type CreateFarmerOptions, type TestFarmer } from './farmers';
import { mediaFixture, type MediaFixture } from './objects';
import { clearDatabase, startMongo, stopMongo, type MongoHarness } from './mongo';
import { providerStubs, type ProviderScript, type ProviderStubs } from './providers';

/**
 * One call that produces everything a scenario needs against a real single-node
 * `MongoMemoryReplSet` (V31, V33), and one call that resets it — the Amendment A3 successor to the
 * Supabase harness.
 *
 * Requirements: 13.1, 13.2 (owner-scoping is the Data_Access_Layer, and each farmer reaches only
 *               their own documents — proven with TWO farmers), 4.1, 4.2 (exactly the five verified
 *               conditions, each seeded with a source), 17.5 (the scenario matrix the testing
 *               report records), 12.1, 12.2 (a farmer created through the Google path)
 * Design: "Integration tests — mocked providers, real MongoDB"; D8, D17, D18, D19; Amendment A3
 *
 * =============================================================================
 * WHAT IS REAL HERE
 * =============================================================================
 *
 * Everything except the three provider SDK calls. Concretely: a real MongoDB (an in-memory
 * replica set, so the link and payment multi-document transactions run — V33), every collection
 * validator and index and the five-condition seed from `setupDatabase`, the whole
 * Data_Access_Layer with its owner-scoped accessors, GridFS media through the real media DAL, the
 * gateway's chain order / deadline / fallback loop, both validation stages, `validateRephrased`,
 * the knowledge-base reads, and every insert. `tests/integration/providers.ts` says where the
 * provider seam is and why it is not higher; `tests/integration/objects.ts` says why the media is a
 * real GridFS write rather than a faked object store.
 *
 * =============================================================================
 * WHY MODULES ARE IMPORTED DYNAMICALLY, AFTER MONGODB_URI IS SET
 * =============================================================================
 *
 * `src/lib/db/client.ts` reads `MONGODB_URI` through `serverEnv` and caches ONE `MongoClient` on
 * `globalThis` on first use. So the harness points `MONGODB_URI` at the in-memory replica set
 * BEFORE any module that reaches `getDb()` / `getMongoClient()` is imported, and imports the DAL,
 * the media store, and the D8 bootstrap DYNAMICALLY afterwards — exactly the discipline every
 * wave-5 mongo test uses (`data-access.test.ts`, `access-flow.test.ts`). A static import at the top
 * of a scenario file would cache a client pointed at a real Atlas cluster from `.env.local` instead.
 * So a scenario calls `startHarness()` in `beforeAll` and does its own dynamic service imports there
 * too; this module only guarantees `MONGODB_URI` is set before it returns.
 *
 * =============================================================================
 * THE SHAPE A SCENARIO TEST TAKES
 * =============================================================================
 *
 * ```ts
 * import { afterAll, beforeAll, describe, expect, it } from 'vitest';
 * import { startHarness, type Harness } from './harness';
 *
 * let harness: Harness;
 * type Diagnosis = typeof import('@/services/diagnosis.service');
 * let diagnosis: Diagnosis;
 *
 * beforeAll(async () => {
 *   harness = await startHarness();
 *   diagnosis = await import('@/services/diagnosis.service'); // AFTER startHarness set MONGODB_URI
 * });
 * afterAll(async () => { await harness.cleanup(); });
 *
 * it('grounds a clear diseased crop and shows nobody else the row', async () => {
 *   const { farmerA, farmerB, objects, providers } = harness;
 *   const image = await objects.image(farmerA.id);
 *   const outcome = await diagnosis.diagnose(
 *     { userId: farmerA.id, image, language: 'en', channel: 'web' },
 *     { models: providers.models },
 *   );
 *   expect(outcome.result.status).toBe('identified');
 *   // The whole reason there are two farmers: B sees nothing of A's.
 *   const forB = await harness.farmerReads(farmerB.id).findDiagnoses();
 *   expect(forB).toEqual([]);
 * });
 * ```
 *
 * Two conventions worth keeping in every scenario:
 *
 *  - **`channel: 'web'`** for the web path and **`channel: 'telegram'`** for the messaging path.
 *    That single field is the difference the design draws between the two channels, and it is
 *    written to every persisted row (Requirement 16.5).
 *  - **Assert the cross-farmer read.** A scenario that only checks its own rows would pass against
 *    a Data_Access_Layer with the owner merge removed; the isolation claim is the second farmer
 *    reading zero documents.
 */
export interface Harness {
  readonly db: Db;
  readonly replSet: MongoHarness['replSet'];
  readonly farmerA: TestFarmer;
  readonly farmerB: TestFarmer;
  readonly providers: ProviderStubs;
  /** Real GridFS media, owned and read through the Data_Access_Layer (D17, D18). */
  readonly objects: MediaFixture;
  /**
   * The five seeded conditions as `setupDatabase` wrote them, for a scenario that grounds an
   * assertion in the same content the service read. Never written to by the harness.
   */
  readonly knowledge: readonly DiseaseKnowledgeDoc[];
  /** Drop every non-system collection and re-seed the knowledge base — a per-test reset. */
  reset(): Promise<void>;
  /** Stop the client and the replica set. */
  cleanup(): Promise<void>;
}

export interface StartHarnessOptions {
  readonly farmerA?: CreateFarmerOptions;
  readonly farmerB?: CreateFarmerOptions;
  /** Initial provider answers. Every one is also mutable through `harness.providers.script`. */
  readonly providers?: Partial<ProviderScript>;
}

/**
 * Assert the five conditions are seeded, and hand back the rows. The harness NEVER inserts
 * knowledge rows itself — Requirement 4.3 makes `disease_knowledge` the only agricultural content a
 * farmer reads, so a fixture that seeded its own agronomy would make every grounding assertion
 * confirm the fixture rather than the service. `setupDatabase` owns that content; this only refuses
 * to run against a database where the seed did not land.
 */
async function assertKnowledgeSeeded(db: Db): Promise<readonly DiseaseKnowledgeDoc[]> {
  const rows = await db
    .collection<DiseaseKnowledgeDoc>(COLLECTIONS.diseaseKnowledge)
    .find({})
    .toArray();

  if (rows.length !== VERIFIED_CONDITIONS.length) {
    throw new Error(
      `disease_knowledge holds ${rows.length} rows, expected exactly ${VERIFIED_CONDITIONS.length} ` +
        '(Requirement 4.1). setupDatabase did not seed the five conditions.',
    );
  }
  const names = new Set(rows.map((row) => row.diseaseName));
  const missing = VERIFIED_CONDITIONS.filter((condition) => !names.has(condition));
  if (missing.length > 0) {
    throw new Error(`disease_knowledge is missing ${missing.join(', ')} (Requirement 4.1).`);
  }
  const sourceless = rows.filter((row) => row.source.trim() === '').map((row) => row.diseaseName);
  if (sourceless.length > 0) {
    throw new Error(`disease_knowledge rows with a blank source: ${sourceless.join(', ')} (Requirement 4.2).`);
  }
  return rows;
}

/**
 * Start the replica set, point `MONGODB_URI` at it, set up the database, and create two farmers
 * through the Google path.
 *
 * Two farmers rather than one because tenant isolation is the assertion a unit test cannot make:
 * Requirements 13.1 and 13.2 are about what happens when ANOTHER farmer's scope reads, and there is
 * no way to ask that with one farmer. The DAL, the media store, and the D8 bootstrap are imported
 * DYNAMICALLY here, after `MONGODB_URI` is set, so their cached client connects to the harness.
 *
 * A failed replica-set start throws loudly from `startMongo` (never skips — the A3 broken-gate
 * rule); a failure creating the second farmer tears the whole harness down rather than leaking the
 * replica set into later runs.
 */
export async function startHarness(options: StartHarnessOptions = {}): Promise<Harness> {
  const mongo = await startMongo();
  process.env.MONGODB_URI = mongo.replSet.getUri();

  // Dynamic imports AFTER MONGODB_URI is set — the cached client connects to the harness.
  const { setupDatabase } = await import('@/lib/db/setup');
  const media = await import('@/lib/db/media');
  const { bootstrapProfile } = await import('@/lib/auth/bootstrap');

  try {
    await setupDatabase(mongo.db);
    const knowledge = await assertKnowledgeSeeded(mongo.db);

    const farmerA = await createTestFarmer(mongo.db, bootstrapProfile, options.farmerA ?? {});
    const farmerB = await createTestFarmer(mongo.db, bootstrapProfile, options.farmerB ?? {});

    const objects = mediaFixture(media.writeMedia, media.readMediaForOwner);
    const providers = providerStubs(options.providers ?? {});

    return {
      db: mongo.db,
      replSet: mongo.replSet,
      farmerA,
      farmerB,
      providers,
      objects,
      knowledge,

      async reset() {
        await clearDatabase(mongo.db);
        // Re-seed the knowledge base (farmer-agnostic, read-only) AND re-create the two farmers
        // with their same ids/emails, so a per-test reset leaves the same starting world
        // `beforeAll` built — `clearDatabase` wipes the auth `user`/`account` and `profiles`
        // collections too, so a reset that only re-seeded knowledge would leave the farmers gone.
        await setupDatabase(mongo.db);
        await createTestFarmer(mongo.db, bootstrapProfile, {
          id: farmerA.id,
          email: farmerA.email,
          language: farmerA.language,
        });
        await createTestFarmer(mongo.db, bootstrapProfile, {
          id: farmerB.id,
          email: farmerB.email,
          language: farmerB.language,
        });
      },

      async cleanup() {
        await stopMongo(mongo);
      },
    };
  } catch (error) {
    await stopMongo(mongo);
    throw error;
  }
}

/** The seeded row for one condition, for a scenario that grounds an assertion in its sentences. */
export function knowledgeRow(
  harness: Harness,
  condition: DiseaseKnowledgeDoc['diseaseName'],
): DiseaseKnowledgeDoc {
  const row = harness.knowledge.find((entry) => entry.diseaseName === condition);
  if (row === undefined) {
    throw new Error(`No seeded disease_knowledge row for ${condition}.`);
  }
  return row;
}
