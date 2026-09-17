import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VERIFIED_CONDITIONS } from '@/lib/schemas';

import {
  TEST_DATABASE_URL_VAR,
  describeIntegration,
  requireTestDatabaseUrl,
} from './database';
import { profileOf } from './farmers';
import { seedDiagnosis, startHarness, type Harness } from './harness';

/**
 * Harness smoke test: proves the integration project runs, that the database gate works, and that
 * the fixtures which need a real stack do what they claim.
 *
 * Requirements: 13.1 / 13.2 (RLS enabled, and each authenticated farmer restricted to their own
 *               rows), 4.1 / 4.2 (exactly the five verified conditions, each with a source), 3.4
 *               (Tomato Healthy carries no treatment content), 13.4 (knowledge-base writes are
 *               migrations only), 1.4 (a first session for a phone produces a Profile keyed by the
 *               auth user id and carrying the E.164 number), 17.5
 *
 * Without `JAMEE_TEST_DATABASE_URL` this suite reports as skipped instead of failing the run; with
 * it set, everything below runs against the local stack. `tests/integration/database.ts` has the
 * three commands that start one.
 *
 * **The cross-farmer read is the assertion that justifies the whole harness.** Every other
 * assertion in the repository could be made against a fake client; "farmer B selects farmer A's row
 * and gets zero rows" cannot, because the thing under test is a policy in Postgres.
 *
 * The half of the harness that needs no database — the connection-string derivation, the provider
 * stubs, the classification fixtures and the object store — is tested in
 * `tests/unit/integration-harness.test.ts`, so a fixture bug is caught on a machine with no stack
 * rather than waiting for one.
 */
describeIntegration(`integration harness (requires ${TEST_DATABASE_URL_VAR})`, () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it('has a Postgres connection string', () => {
    expect(requireTestDatabaseUrl()).not.toBe('');
  });

  describe('the knowledge base the migrations seeded', () => {
    it('holds exactly the five verified conditions, each with a source', () => {
      expect(harness.knowledge).toHaveLength(VERIFIED_CONDITIONS.length);
      expect(harness.knowledge.map((row) => row.disease_name).sort()).toEqual(
        [...VERIFIED_CONDITIONS].sort(),
      );
      for (const row of harness.knowledge) {
        expect(row.source.trim()).not.toBe('');
      }
    });

    it('gives Tomato Healthy no treatment content', () => {
      const healthy = harness.knowledge.find((row) => row.disease_name === 'Tomato Healthy');
      expect(healthy?.treatment).toEqual([]);
    });

    it('is unchanged by a farmer session attempting to write it', async () => {
      const row = harness.knowledge[0];
      expect(row).toBeDefined();
      const id = row?.id ?? '';

      // 0004 grants no insert, update or delete policy, so RLS makes this statement match nothing.
      await harness.farmerA.client
        .from('disease_knowledge')
        .update({ source: 'edited by a farmer session' })
        .eq('id', id);

      const after = await harness.admin
        .from('disease_knowledge')
        .select('source')
        .eq('id', id)
        .single();
      expect(after.data?.source).toBe(row?.source);
    });
  });

  describe('the two farmers', () => {
    it('has a profile per farmer, written by the 0002 trigger and carrying the E.164 phone', async () => {
      const profileA = await profileOf(harness.admin, harness.farmerA.id);
      const profileB = await profileOf(harness.admin, harness.farmerB.id);

      expect(profileA?.id).toBe(harness.farmerA.id);
      expect(profileA?.phone).toBe(harness.farmerA.phone);
      expect(profileB?.phone).toBe(harness.farmerB.phone);
      expect(profileA?.phone).not.toBe(profileB?.phone);
    });

    it('gives each farmer a session whose uid is their own profile id', async () => {
      const { data } = await harness.farmerA.client.auth.getUser();

      expect(data.user?.id).toBe(harness.farmerA.id);
      expect(harness.farmerA.accessToken).not.toBe(harness.farmerB.accessToken);
    });

    it('reads its own profile through the RLS-scoped client', async () => {
      const { data, error } = await harness.farmerA.client
        .from('profiles')
        .select('*')
        .eq('id', harness.farmerA.id);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('returns zero rows when one farmer reads the other profile', async () => {
      const { data, error } = await harness.farmerB.client
        .from('profiles')
        .select('*')
        .eq('id', harness.farmerA.id);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  });

  describe('RLS over a farmer-owned row (Requirements 13.1, 13.2)', () => {
    it('lets the owner read the row and shows the other farmer nothing', async () => {
      const diagnosis = await seedDiagnosis(harness, harness.farmerA);

      const owner = await harness.farmerA.client
        .from('diagnoses')
        .select('*')
        .eq('id', diagnosis.id);
      const other = await harness.farmerB.client
        .from('diagnoses')
        .select('*')
        .eq('id', diagnosis.id);
      const serviceRole = await harness.admin
        .from('diagnoses')
        .select('*')
        .eq('id', diagnosis.id);

      expect(owner.data).toHaveLength(1);
      // The whole harness exists for this line.
      expect(other.data).toEqual([]);
      expect(other.error).toBeNull();
      // And for this one, which proves the row was really there to be missed.
      expect(serviceRole.data).toHaveLength(1);
    });

    it('shows the other farmer nothing on an unfiltered select either', async () => {
      await seedDiagnosis(harness, harness.farmerA);

      const { data } = await harness.farmerB.client.from('diagnoses').select('user_id');

      expect(data?.some((row) => row.user_id === harness.farmerA.id)).toBe(false);
    });

    it('refuses an insert that claims the other farmer as its owner', async () => {
      const diagnosis = await seedDiagnosis(harness, harness.farmerA);

      const { error } = await harness.farmerB.client.from('diagnoses').insert({
        user_id: harness.farmerA.id,
        conversation_id: diagnosis.conversation_id,
        status: 'unknown',
        severity: 'none',
        explanation: 'written by the wrong farmer',
        language: 'en',
        needs_expert: true,
        channel: 'web',
        image_bucket: 'crop-images',
        image_path: diagnosis.image_path,
        model_provider: 'gemini',
      });

      expect(error).not.toBeNull();
    });

    it('keeps the append-only audit rows readable by their owner only', async () => {
      const written = await harness.admin.from('usage_logs').insert({
        user_id: harness.farmerA.id,
        operation: 'image',
        channel: 'web',
        outcome: 'success',
        model_provider: 'gemini',
        quota_spent: true,
      });
      expect(written.error).toBeNull();

      const mine = await harness.farmerA.client.from('usage_logs').select('user_id');
      const theirs = await harness.farmerB.client.from('usage_logs').select('user_id');

      expect(mine.data?.length ?? 0).toBeGreaterThan(0);
      expect(theirs.data?.some((row) => row.user_id === harness.farmerA.id)).toBe(false);
    });
  });

  describe('the quota counter functions (0007)', () => {
    it('reserves through the harness service-role client and reads back what it wrote', async () => {
      const { rpc } = harness.quota;
      expect(rpc).toBeDefined();

      // A real-shaped day key ('YYYY-MM-DD', Asia/Kolkata) far in the past, so it is the right
      // format for the column and cannot collide with the window a scenario's own reserve uses.
      const args = {
        userId: harness.farmerA.id,
        operation: 'image' as const,
        windowKind: 'day' as const,
        windowKey: '1970-01-02',
      };

      expect(await rpc?.used(args)).toBe(0);
      expect(await rpc?.tryIncrement({ ...args, limit: 1 })).toBe(1);
      // At the limit, the function returns null rather than raising — the at-limit signal.
      expect(await rpc?.tryIncrement({ ...args, limit: 1 })).toBeNull();
      expect(await rpc?.decrement(args)).toBe(0);
    });
  });
});
