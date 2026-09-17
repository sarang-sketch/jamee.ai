import { STORAGE_BUCKETS } from '@/lib/config/verified';
import { VERIFIED_CONDITIONS } from '@/lib/schemas';
import { buildStorageRef } from '@/lib/storage';
import { adminCounterRpc, type QuotaOptions } from '@/services/quota.service';
import type { DiagnosisRow, DiseaseKnowledgeRow } from '@/types/database';

import { serviceRoleClient, type TestClient } from './clients';
import {
  SUPABASE_API_URL_VAR,
  requireSupabaseTestConfig,
  type SupabaseTestConfig,
} from './database';
import {
  createTestFarmer,
  deleteTestFarmer,
  type CreateFarmerOptions,
  type TestFarmer,
} from './farmers';
import { objectStore, type TestObjectStore } from './objects';
import { providerStubs, type ProviderScript, type ProviderStubs } from './providers';

/**
 * One call that produces everything a scenario needs, and one call that removes it again.
 *
 * Requirements: 13.1 / 13.2 (RLS enabled, and each farmer restricted to their own rows), 4.1 / 4.2
 *               (exactly the five verified conditions, each with a source), 17.5 (the scenario
 *               matrix the testing report records)
 * Design: "Integration tests — mocked providers, real Postgres"
 *
 * =============================================================================
 * WHAT IS REAL HERE
 * =============================================================================
 *
 * Everything except three provider SDK calls and the Storage object surface. Concretely: Postgres,
 * every migration, every RLS policy, PostgREST, Auth and the sessions it issues, the quota counter
 * functions, the gateway's chain order / deadline / fallback loop, both adapters' request bodies and
 * error classification, both validation stages, the knowledge-base reads, `validateRephrased`, and
 * every insert. `tests/integration/providers.ts` says where the provider seam is and why it is not
 * higher; `tests/integration/objects.ts` says why Storage is the exception.
 *
 * =============================================================================
 * THE SHAPE A SCENARIO TEST TAKES (tasks 29.2 – 29.5)
 * =============================================================================
 *
 * ```ts
 * import { expect, it } from 'vitest';
 * import { diagnose } from '@/services/diagnosis.service';
 * import { describeIntegration } from './database';
 * import { uploadedImage } from './objects';
 * import { CLASSIFICATIONS, classificationText } from './providers';
 * import { startHarness, type Harness } from './harness';
 *
 * describeIntegration('image scenarios', () => {
 *   let harness: Harness;
 *   beforeAll(async () => { harness = await startHarness(); });
 *   afterAll(async () => { await harness.cleanup(); });
 *
 *   it('grounds a clear diseased crop in the knowledge-base row of that name', async () => {
 *     const { farmerA, objects, providers, quota } = harness;
 *     providers.script.vision = classificationText(CLASSIFICATIONS.tomatoEarlyBlight);
 *
 *     const outcome = await diagnose(
 *       {
 *         userId: farmerA.id,
 *         storageRef: uploadedImage(objects, farmerA.id),
 *         language: 'en',
 *         channel: 'web',
 *       },
 *       { supabase: farmerA.client, storage: objects, models: providers.models, quota },
 *     );
 *
 *     expect(outcome.result.status).toBe('identified');
 *     // The row is readable by its owner and by nobody else — the whole point of two farmers.
 *     const mine = await farmerA.client.from('diagnoses').select('*').eq('id', outcome.diagnosisId);
 *     const theirs = await harness.farmerB.client
 *       .from('diagnoses')
 *       .select('*')
 *       .eq('id', outcome.diagnosisId);
 *     expect(mine.data).toHaveLength(1);
 *     expect(theirs.data).toHaveLength(0);
 *   });
 * });
 * ```
 *
 * Two conventions worth keeping in every scenario:
 *
 *  - **`supabase: farmerX.client`** for the web path and **`supabase: harness.admin`** for the
 *    WhatsApp path. That single argument is the difference the design draws between "RLS is a second
 *    boundary behind the service's own check" and "the application check is the only boundary", so
 *    passing the wrong one silently tests the wrong channel.
 *  - **Assert the cross-farmer read.** A scenario that only checks its own rows would pass against a
 *    database with RLS switched off.
 */
export interface Harness {
  readonly config: SupabaseTestConfig;
  /** RLS-bypassing. Seeds, inspects and cleans up. Also the WhatsApp path's `supabase`. */
  readonly admin: TestClient;
  readonly farmerA: TestFarmer;
  readonly farmerB: TestFarmer;
  readonly providers: ProviderStubs;
  readonly objects: TestObjectStore;
  /**
   * The five rows as the migrations seeded them, for a test that grounds an assertion in the same
   * content the service read. Never written to by the harness.
   */
  readonly knowledge: readonly DiseaseKnowledgeRow[];
  /**
   * The counter RPC bound to this harness's service-role client.
   *
   * Passed explicitly rather than left to default so the quota path holds no second admin client and
   * reads no environment variable of its own. The functions themselves are the real
   * `counter_try_increment` / `counter_decrement` from `0007`, so quota atomicity is real here.
   */
  readonly quota: QuotaOptions;
  /** Deletes both farmers, which cascades to everything they produced. */
  cleanup(): Promise<void>;
}

export interface StartHarnessOptions {
  readonly farmerA?: CreateFarmerOptions;
  readonly farmerB?: CreateFarmerOptions;
  /** Initial provider answers. Every one is also mutable through `harness.providers.script`. */
  readonly providers?: Partial<ProviderScript>;
}

/**
 * Assert the migrations were applied, and hand back the knowledge-base rows they seeded.
 *
 * **The harness never inserts knowledge rows.** Requirement 4.3 makes `disease_knowledge` the only
 * source of agricultural content a farmer reads, so a fixture that seeded its own agronomy would
 * make every grounding assertion in every scenario meaningless — the test would confirm that the
 * service repeated the test's own sentences. The migrations own that content, and this function's
 * only job is refusing to run against a database where they were not applied.
 *
 * The five checks mirror `0010`'s own closing assertions plus `scripts/check-deployment.ts` (task
 * 28.4), one layer down: exactly five rows, exactly the five names, a non-empty `source` on each
 * (Requirement 4.2), no treatment content on `Tomato Healthy` (Requirement 3.4), and the `0007`
 * counter functions reachable.
 */
export async function assertMigrationsApplied(
  admin: TestClient,
): Promise<readonly DiseaseKnowledgeRow[]> {
  const { data, error } = await admin.from('disease_knowledge').select('*');

  if (error !== null || data === null) {
    throw new Error(
      `Could not read disease_knowledge: ${error?.message ?? 'no rows returned'}. Apply the ` +
        'migrations first — `npx supabase db reset` runs supabase/migrations in order.',
    );
  }

  if (data.length !== VERIFIED_CONDITIONS.length) {
    throw new Error(
      `disease_knowledge holds ${data.length} rows, expected exactly ${VERIFIED_CONDITIONS.length} ` +
        '(Requirement 4.1). Run `npx supabase db reset` so 0010_seed_disease_knowledge.sql is applied.',
    );
  }

  const names = new Set(data.map((row) => row.disease_name));
  const missing = VERIFIED_CONDITIONS.filter((condition) => !names.has(condition));
  if (missing.length > 0) {
    throw new Error(
      `disease_knowledge is missing ${missing.join(', ')} (Requirement 4.1). The seeded content and ` +
        'the application\'s five verified conditions have drifted apart.',
    );
  }

  const sourceless = data.filter((row) => row.source.trim() === '').map((row) => row.disease_name);
  if (sourceless.length > 0) {
    throw new Error(
      `disease_knowledge rows with a blank source: ${sourceless.join(', ')} (Requirement 4.2).`,
    );
  }

  const healthy = data.find((row) => row.disease_name === 'Tomato Healthy');
  if (healthy !== undefined && healthy.treatment.length > 0) {
    throw new Error(
      'Tomato Healthy carries treatment content (Requirement 3.4). The seed row and the ' +
        'healthy_has_no_treatment constraint disagree, which should not be possible.',
    );
  }

  // 0007. `counter_used` reads through `coalesce(..., 0)`, so an unknown farmer is 0 rather than an
  // error — which makes it a read-only probe that the quota functions exist at all.
  const probe = await admin.rpc('counter_used', {
    p_user: crypto.randomUUID(),
    p_operation: 'image',
    p_window_kind: 'day',
    p_window_key: '1970-01-01',
  });
  if (probe.error !== null) {
    throw new Error(
      `counter_used is not callable: ${probe.error.message}. 0007_counters_and_quota_fn.sql was ` +
        'not applied, so every quota reserve in every scenario would fail.',
    );
  }

  return data;
}

/**
 * Two farmers, a service-role client, the seeded knowledge base, and the provider stubs.
 *
 * Two farmers rather than one because tenant isolation is the assertion a unit test cannot make:
 * Requirements 13.1 and 13.2 are about what happens when *another* farmer's session asks, and there
 * is no way to ask that question with one session.
 *
 * `NEXT_PUBLIC_SUPABASE_URL` is set in the process when it was derived rather than configured, so
 * that any application default path a scenario reaches — `createAdminClient()` inside a service's
 * default store, for one — points at the same stack the harness is using rather than at nothing.
 */
export async function startHarness(options: StartHarnessOptions = {}): Promise<Harness> {
  const config = requireSupabaseTestConfig();
  if (process.env[SUPABASE_API_URL_VAR] === undefined) {
    process.env[SUPABASE_API_URL_VAR] = config.apiUrl;
  }

  const admin = serviceRoleClient(config);
  const knowledge = await assertMigrationsApplied(admin);

  const farmerA = await createTestFarmer(admin, options.farmerA ?? {}, config);
  let farmerB: TestFarmer;
  try {
    farmerB = await createTestFarmer(admin, options.farmerB ?? {}, config);
  } catch (error) {
    // Otherwise a failure creating the second farmer leaks the first one into every later run.
    await deleteTestFarmer(admin, farmerA);
    throw error;
  }

  return {
    config,
    admin,
    farmerA,
    farmerB,
    providers: providerStubs(options.providers ?? {}),
    objects: objectStore(),
    knowledge,
    quota: { rpc: adminCounterRpc(admin) },

    async cleanup(): Promise<void> {
      await deleteTestFarmer(admin, farmerA);
      await deleteTestFarmer(admin, farmerB);
    },
  };
}

/** The seeded row for one condition, for a scenario that grounds an assertion in its sentences. */
export function knowledgeRow(
  harness: Harness,
  condition: DiseaseKnowledgeRow['disease_name'],
): DiseaseKnowledgeRow {
  const row = harness.knowledge.find((entry) => entry.disease_name === condition);
  if (row === undefined) {
    throw new Error(`No seeded disease_knowledge row for ${condition}.`);
  }
  return row;
}

/**
 * Write one `identified` diagnosis for a farmer with the service-role client.
 *
 * **This is not a shortcut around the service, and a scenario suite should not use it.** Tasks
 * 29.2–29.5 produce their rows by calling `diagnose()`, because the row a service writes is part of
 * what they are asserting. This exists for the assertions that need a row to *exist* before any
 * service runs — the tenant-isolation checks, where what matters is that farmer B cannot read it and
 * not how it got there.
 *
 * Every agricultural sentence comes from the seeded row, so the fixture authors no agronomy of its
 * own (Requirement 4.3).
 */
export async function seedDiagnosis(
  harness: Harness,
  farmer: TestFarmer,
  condition: DiseaseKnowledgeRow['disease_name'] = 'Tomato Early Blight',
): Promise<DiagnosisRow> {
  const row = knowledgeRow(harness, condition);

  const conversation = await harness.admin
    .from('conversations')
    .insert({ user_id: farmer.id, channel: 'web' })
    .select('*')
    .single();

  if (conversation.error !== null || conversation.data === null) {
    throw new Error(
      `Could not seed a conversation for ${farmer.id}: ${conversation.error?.message ?? 'no row'}`,
    );
  }

  const image = buildStorageRef({
    bucket: STORAGE_BUCKETS.cropImages,
    userId: farmer.id,
    extension: 'jpg',
  });

  const diagnosis = await harness.admin
    .from('diagnoses')
    .insert({
      user_id: farmer.id,
      conversation_id: conversation.data.id,
      status: 'identified',
      disease_name: row.disease_name,
      knowledge_id: row.id,
      confidence: 0.9,
      severity: row.default_severity,
      explanation: `${row.disease_name}\n${row.symptoms[0] ?? ''}`,
      language: 'en',
      needs_expert: false,
      channel: 'web',
      image_bucket: STORAGE_BUCKETS.cropImages,
      image_path: image.path,
      model_provider: 'gemini',
    })
    .select('*')
    .single();

  if (diagnosis.error !== null || diagnosis.data === null) {
    throw new Error(
      `Could not seed a diagnosis for ${farmer.id}: ${diagnosis.error?.message ?? 'no row'}`,
    );
  }

  return diagnosis.data;
}
