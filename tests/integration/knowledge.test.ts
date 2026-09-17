import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VERIFIED_CONDITIONS, type VerifiedCondition } from '@/lib/schemas';
import type { DiseaseKnowledgeRow, TablesInsert, TablesUpdate } from '@/types/database';

import { anonClient } from './clients';
import { TEST_DATABASE_URL_VAR, describeIntegration } from './database';
import { seedDiagnosis, startHarness, type Harness } from './harness';

/**
 * The knowledge-base invariants, asserted where they actually live: in the database.
 *
 * Requirements: 4.1 (the Knowledge_Base holds exactly the five Verified_Conditions), 4.2 (seeded
 *               through a migration with `source` populated per row), 3.4 (Tomato Healthy carries no
 *               treatment content), 6.4 / 6.5 (one inconclusive shape, carrying no candidate disease
 *               name and no treatment reference), 13.3 (every authenticated Farmer may read
 *               `disease_knowledge`), 13.4 (writes are restricted to migrations run with the
 *               Service_Role_Key)
 * Design: "Integration tests — mocked providers, real Postgres"
 * Migrations: `0004_disease_knowledge.sql` (the table, its constraints, and the deliberate absence
 *             of any write policy), `0005_diagnoses.sql` (the two shape constraints),
 *             `0010_seed_disease_knowledge.sql` (the five rows and their citations)
 *
 * =============================================================================
 * WHY NONE OF THIS IS A UNIT TEST
 * =============================================================================
 *
 * Every claim below is a claim about Postgres, and each one is invisible to a stub:
 *
 *  - **"exactly five rows"** is half a check constraint and half a seed migration. A fixture that
 *    returned five rows would be asserting its own array literal. Only a database that ran `0004`
 *    *and* `0010` can be asked.
 *  - **A constraint rejecting a write** is a statement failing. `healthy_has_no_treatment`,
 *    the `crop` check, and the `disease_name` enum are enforced by the row being refused, and a
 *    TypeScript union cannot refuse anything at runtime.
 *  - **"an authenticated farmer cannot write"** is the *absence* of a policy, evaluated against a
 *    real JWT. There is no client-side artefact of it at all: the SDK builds the same request either
 *    way, and what differs is what the database does with it.
 *  - **The `diagnoses` shape constraints** are the second of two independent boundaries. The first
 *    is `inconclusiveResultSchema`, which unit tests already cover; this file asserts the one that
 *    still holds when a service-layer bug tries to persist a malformed row anyway.
 *
 * The suite skips without `JAMEE_TEST_DATABASE_URL`. `tests/integration/database.ts` carries the
 * commands that start a stack for it.
 *
 * =============================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * =============================================================================
 *
 * **It never successfully writes `disease_knowledge`.** Requirement 4.3 makes that table the only
 * source of agricultural content a farmer reads, so a test that seeded or edited a row would be
 * authoring agronomy — the thing the whole design forbids. Every write attempted below is one that
 * is *expected to fail*, which is why the assertions afterwards re-read the row and confirm it is
 * byte-identical to what the migration seeded.
 */

/* ========================================================================== */
/* SQLSTATEs                                                                   */
/* ========================================================================== */

/**
 * `check_violation`. The signal for every shape constraint in `0004` and `0005`.
 *
 * Asserted by code rather than by message text, for the reason `isUniqueViolation` in
 * `src/lib/db/whatsapp-inbound.ts` gives: Postgres's prose is not part of any contract and a
 * localized or reworded build would silently turn a passing assertion into a different one.
 */
const CHECK_VIOLATION = '23514';

/** `not_null_violation`. */
const NOT_NULL_VIOLATION = '23502';

/**
 * `insufficient_privilege` — what a statement with no permissive RLS policy comes back as.
 *
 * Postgres raises this for both possible mechanisms, which is why one constant covers them: RLS
 * refusing an `insert` ("new row violates row-level security policy") and a missing table grant both
 * arrive as `42501`. The distinction does not matter to Requirement 13.4; being refused does.
 */
const INSUFFICIENT_PRIVILEGE = '42501';

/* ========================================================================== */
/* What `0010` seeded, as facts a test can check without authoring agronomy     */
/* ========================================================================== */

/** The crop each condition's name commits it to — `0004`'s `crop` check, read from the name. */
const CROP_OF: Record<VerifiedCondition, DiseaseKnowledgeRow['crop']> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

/**
 * The institution each row is cited to, as a substring of `source`.
 *
 * A **substring**, not the whole citation: copying `0010`'s five strings in full would make this file
 * a second declaration site for the provenance of advice a farmer may act on, and the two copies
 * would drift the first time a publication moved. The institution is the part that cannot change
 * without the citation being a different citation, so it is the part worth pinning — and pinning it
 * is what makes "the placeholder was replaced with something real" checkable rather than assumed.
 */
const CITED_INSTITUTION: Record<VerifiedCondition, string> = {
  'Tomato Early Blight': 'West Virginia University Extension',
  'Tomato Late Blight': 'Virginia Cooperative Extension',
  'Tomato Healthy': 'Utah State University Extension',
  'Potato Early Blight': 'North Dakota State University Extension',
  'Potato Late Blight': 'North Dakota State University Extension',
};

/**
 * The design's unfilled citation, which must appear in no seeded row.
 *
 * `design.md` sketches the seed with `<extension-service citation - fill at implementation>` and
 * `0010`'s header explains that the placeholder was replaced deliberately rather than mechanically.
 * A row that still carried it would be a row of agricultural advice with no provenance behind it —
 * `not null` satisfied, Requirement 4.2 not.
 */
const UNFILLED_CITATION = 'extension-service citation';

/** `(checked YYYY-MM-DD)` — the retrieval date every citation in `0010` carries. */
const CHECKED_DATE = /\(checked \d{4}-\d{2}-\d{2}\)/;

/* ========================================================================== */
/* Off-schema payloads                                                         */
/* ========================================================================== */

/**
 * A payload TypeScript would refuse, handed to the database on purpose.
 *
 * `src/types/database.ts` types `crop` as `'tomato' | 'potato'` and `disease_name` as the five-value
 * union, so the compiler is the *first* boundary against an off-schema write and a well-typed test
 * cannot express one. That is exactly why these casts exist: the claim being checked is that the
 * database is the **second** boundary, still refusing the row when a bug upstream got past the
 * first. A test that could only send well-typed values could never ask the question.
 */
function offSchemaUpdate(payload: Record<string, unknown>): TablesUpdate<'disease_knowledge'> {
  return payload as unknown as TablesUpdate<'disease_knowledge'>;
}

function offSchemaDiagnosis(payload: Record<string, unknown>): TablesInsert<'diagnoses'> {
  return payload as unknown as TablesInsert<'diagnoses'>;
}

describeIntegration(`knowledge base invariants (requires ${TEST_DATABASE_URL_VAR})`, () => {
  let harness: Harness;
  /** A conversation of farmer A's, so a `diagnoses` insert has something valid to reference. */
  let conversationId: string;
  let imagePath: string;

  beforeAll(async () => {
    harness = await startHarness();
    // Seeded rather than produced by `diagnose()`: this file asserts constraints, and what matters
    // is that the conversation and the image path are real foreign-key-satisfying values.
    const seeded = await seedDiagnosis(harness, harness.farmerA);
    conversationId = seeded.conversation_id;
    imagePath = seeded.image_path;
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  /** The row for one condition, re-read from the database rather than from the harness cache. */
  async function reread(condition: VerifiedCondition): Promise<DiseaseKnowledgeRow> {
    const { data, error } = await harness.admin
      .from('disease_knowledge')
      .select('*')
      .eq('disease_name', condition)
      .single();

    expect(error).toBeNull();
    if (data === null) throw new Error(`no disease_knowledge row for ${condition}`);
    return data;
  }

  /* ====================================================================== */
  /* Requirement 4.1 — exactly five, and exactly which five                  */
  /* ====================================================================== */

  describe('the five seeded rows (Requirements 4.1, 4.2)', () => {
    it('holds exactly five rows, counted in the database rather than in a fixture', async () => {
      // `head: true` with an exact count is `select count(*)` — the task's own wording, and the same
      // assertion `scripts/check-deployment.ts` makes against a live project one layer up.
      const counted = await harness.admin
        .from('disease_knowledge')
        .select('*', { count: 'exact', head: true });

      expect(counted.error).toBeNull();
      expect(counted.count).toBe(5);
      expect(counted.count).toBe(VERIFIED_CONDITIONS.length);
    });

    it('holds exactly the five Verified_Conditions, character for character', async () => {
      const { data, error } = await harness.admin.from('disease_knowledge').select('disease_name');

      expect(error).toBeNull();
      // Sorted comparison of the whole set, so a missing name and an extra name are both failures
      // rather than one of them passing by coincidence. `0004`'s check constraint and unique index
      // make five the maximum; `0010` makes it the minimum; this is both halves at once.
      expect((data ?? []).map((row) => row.disease_name).sort()).toEqual(
        [...VERIFIED_CONDITIONS].sort(),
      );
    });

    it('gives every row a crop its name agrees with, and the arrays the screens read', async () => {
      for (const condition of VERIFIED_CONDITIONS) {
        const row = await reread(condition);

        expect(row.crop).toBe(CROP_OF[condition]);
        expect(row.symptoms.length).toBeGreaterThan(0);
        expect(row.causes.length).toBeGreaterThan(0);
        expect(row.prevention.length).toBeGreaterThan(0);
        expect(row.default_severity).not.toBe('');
      }
    });

    it('cites every row to a real, dated extension-service publication (Requirement 4.2)', async () => {
      for (const condition of VERIFIED_CONDITIONS) {
        const { source } = await reread(condition);

        expect(source.trim(), `${condition}: source is blank`).not.toBe('');
        // The design's unfilled placeholder survives only in `design.md`'s sketch and in `0010`'s
        // own header comment explaining that it was replaced. A *row* carrying it would be advice
        // with no provenance.
        expect(source, `${condition}: still carries the design placeholder`).not.toContain(
          UNFILLED_CITATION,
        );
        expect(source, `${condition}: does not name its institution`).toContain(
          CITED_INSTITUTION[condition],
        );
        expect(source, `${condition}: carries no retrievable URL`).toContain('https://');
        expect(source, `${condition}: carries no retrieval date`).toMatch(CHECKED_DATE);
      }
    });
  });

  /* ====================================================================== */
  /* Requirement 3.4 — the healthy row, and the constraint behind it         */
  /* ====================================================================== */

  describe('Tomato Healthy carries no treatment content (Requirement 3.4)', () => {
    it('seeded an empty treatment array and a severity of none', async () => {
      const healthy = await reread('Tomato Healthy');

      expect(healthy.treatment).toEqual([]);
      expect(healthy.default_severity).toBe('none');
      // Not a disease, so there is no pathogen to name. `0004` allows null for exactly this row.
      expect(healthy.scientific_name).toBeNull();
    });

    it('carries treatment content on the four disease rows, so the constraint is not blanket', async () => {
      // The other half of `healthy_has_no_treatment`: its left disjunct
      // (`disease_name <> 'Tomato Healthy'`) is true for these four, so an arbitrary treatment array
      // is permitted — and `0010` supplies one. Asserted by reading rather than by writing, because
      // a successful write here would author agronomy.
      for (const condition of VERIFIED_CONDITIONS.filter((name) => name !== 'Tomato Healthy')) {
        const row = await reread(condition);
        expect(row.treatment.length, `${condition}: no treatment content`).toBeGreaterThan(0);
        expect(row.scientific_name, `${condition}: no pathogen named`).not.toBeNull();
      }
    });

    it('rejects a service-role update that gives Tomato Healthy treatment content', async () => {
      const before = await reread('Tomato Healthy');

      // The service role bypasses RLS, so nothing but the check constraint can refuse this. That is
      // the point: Requirement 3.4 holds against the credential that holds every other permission.
      const { error } = await harness.admin
        .from('disease_knowledge')
        .update({ treatment: ['spray something'] })
        .eq('disease_name', 'Tomato Healthy');

      expect(error).not.toBeNull();
      expect(error?.code).toBe(CHECK_VIOLATION);
      expect(error?.message).toContain('healthy_has_no_treatment');

      // The failed statement rolled back, so the row a farmer reads is untouched.
      expect((await reread('Tomato Healthy')).treatment).toEqual(before.treatment);
    });
  });

  /* ====================================================================== */
  /* The rest of `0004`'s constraints                                        */
  /* ====================================================================== */

  describe('the column constraints reject what they should (Requirement 4.1)', () => {
    it('refuses a sixth disease name, which is what makes five the maximum', async () => {
      const before = await reread('Potato Late Blight');

      const { error } = await harness.admin
        .from('disease_knowledge')
        .update(offSchemaUpdate({ disease_name: 'Wheat Rust' }))
        .eq('disease_name', 'Potato Late Blight');

      expect(error?.code).toBe(CHECK_VIOLATION);
      expect((await reread('Potato Late Blight')).disease_name).toBe(before.disease_name);
    });

    it('refuses a crop outside tomato and potato', async () => {
      const { error } = await harness.admin
        .from('disease_knowledge')
        .update(offSchemaUpdate({ crop: 'wheat' }))
        .eq('disease_name', 'Tomato Early Blight');

      expect(error?.code).toBe(CHECK_VIOLATION);
      expect((await reread('Tomato Early Blight')).crop).toBe('tomato');
    });

    it('refuses a severity outside the four Severity_Values', async () => {
      const { error } = await harness.admin
        .from('disease_knowledge')
        .update(offSchemaUpdate({ default_severity: 'catastrophic' }))
        .eq('disease_name', 'Potato Early Blight');

      expect(error?.code).toBe(CHECK_VIOLATION);
      expect((await reread('Potato Early Blight')).default_severity).toBe('moderate');
    });

    it('refuses a row of advice with no source at all (Requirement 4.2)', async () => {
      const before = await reread('Tomato Late Blight');

      const { error } = await harness.admin
        .from('disease_knowledge')
        .update(offSchemaUpdate({ source: null }))
        .eq('disease_name', 'Tomato Late Blight');

      // `not null` is the constraint; a *blank* string is a different case and there is deliberately
      // no check constraint for it. `0010`'s closing `do` block refuses a blank at migration time and
      // the citation assertions above refuse one here, so the gap is covered twice without putting a
      // third opinion about provenance in the schema.
      expect(error?.code).toBe(NOT_NULL_VIOLATION);
      expect((await reread('Tomato Late Blight')).source).toBe(before.source);
    });
  });

  /* ====================================================================== */
  /* Requirements 13.3 and 13.4 — read by every farmer, written by no farmer  */
  /* ====================================================================== */

  describe('read access (Requirement 13.3)', () => {
    it('lets every authenticated farmer read all five rows, identically', async () => {
      const mine = await harness.farmerA.client
        .from('disease_knowledge')
        .select('*', { count: 'exact' });
      const theirs = await harness.farmerB.client
        .from('disease_knowledge')
        .select('*', { count: 'exact' });

      expect(mine.error).toBeNull();
      expect(theirs.error).toBeNull();
      expect(mine.count).toBe(5);
      expect(theirs.count).toBe(5);
      // Nothing in this table is farmer-specific, so the two sessions see the same content. This is
      // the one table in the schema where a cross-farmer read is *supposed* to succeed.
      expect(
        (mine.data ?? []).map((row) => row.disease_name).sort(),
      ).toEqual((theirs.data ?? []).map((row) => row.disease_name).sort());
    });

    it('shows a session-less client nothing, because the policy names `authenticated`', async () => {
      // `0004`'s only policy is `for select to authenticated`. A client holding the public key with
      // no session is `anon`, which matches no policy — so the grant is a grant to farmers who have
      // signed in, not to anyone holding the key that ships in the browser bundle.
      const { data, error } = await anonClient(harness.config)
        .from('disease_knowledge')
        .select('disease_name');

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  });

  describe('write access is migrations only (Requirement 13.4)', () => {
    it('denies an insert made with a farmer session', async () => {
      // Otherwise valid — the same crop, severity and non-empty source `0010` uses — so the only
      // thing left to refuse it is the missing insert policy. Postgres evaluates check constraints
      // before RLS, so a deliberately malformed payload would have failed for the wrong reason.
      const { error } = await harness.farmerA.client.from('disease_knowledge').insert({
        disease_name: 'Tomato Early Blight',
        crop: 'tomato',
        symptoms: ['written by a farmer session'],
        causes: ['written by a farmer session'],
        treatment: ['written by a farmer session'],
        prevention: ['written by a farmer session'],
        default_severity: 'low',
        source: 'a farmer session',
      });

      expect(error).not.toBeNull();
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const counted = await harness.admin
        .from('disease_knowledge')
        .select('*', { count: 'exact', head: true });
      expect(counted.count).toBe(5);
    });

    it('denies an update made with a farmer session', async () => {
      const before = await reread('Tomato Early Blight');

      const { data } = await harness.farmerA.client
        .from('disease_knowledge')
        .update({ source: 'edited by a farmer session' })
        .eq('disease_name', 'Tomato Early Blight')
        .select('disease_name');

      // Two mechanisms can deny this and the requirement is indifferent between them: with no
      // permissive `update` policy the rows are invisible to the statement, so it matches nothing and
      // reports success with an empty array; a missing table grant would instead be a `42501`, which
      // leaves `data` null. `data ?? []` covers both, and the assertion that matters is the next one.
      expect(data ?? []).toEqual([]);
      expect((await reread('Tomato Early Blight')).source).toBe(before.source);
    });

    it('denies a delete made with a farmer session', async () => {
      const { data } = await harness.farmerA.client
        .from('disease_knowledge')
        .delete()
        .eq('disease_name', 'Potato Early Blight')
        .select('disease_name');

      expect(data ?? []).toEqual([]);

      // The row that grounds every potato early blight diagnosis is still there.
      const counted = await harness.admin
        .from('disease_knowledge')
        .select('*', { count: 'exact', head: true });
      expect(counted.count).toBe(5);
      expect((await reread('Potato Early Blight')).disease_name).toBe('Potato Early Blight');
    });
  });

  /* ====================================================================== */
  /* Requirements 6.4 and 6.5 — the inconclusive shape, in the database       */
  /* ====================================================================== */

  describe('the inconclusive shape constraints (Requirements 6.4, 6.5)', () => {
    /** A well-formed inconclusive row, for a test to break one field of. */
    function unknownRow(overrides: Record<string, unknown> = {}): TablesInsert<'diagnoses'> {
      return offSchemaDiagnosis({
        user_id: harness.farmerA.id,
        conversation_id: conversationId,
        status: 'unknown',
        disease_name: null,
        knowledge_id: null,
        confidence: null,
        severity: 'none',
        explanation: 'Jamee could not judge this photo.',
        language: 'en',
        needs_expert: true,
        channel: 'web',
        image_bucket: 'crop-images',
        image_path: imagePath,
        model_provider: 'gemini',
        ...overrides,
      });
    }

    it('accepts the one shape every Inconclusive_Result takes', async () => {
      // Written with the farmer's own session, so RLS's insert policy and the shape constraint both
      // apply — the row a real web request would write.
      const { data, error } = await harness.farmerA.client
        .from('diagnoses')
        .insert(unknownRow())
        .select('status, disease_name, knowledge_id, needs_expert, severity')
        .single();

      expect(error).toBeNull();
      expect(data?.status).toBe('unknown');
      expect(data?.disease_name).toBeNull();
      expect(data?.knowledge_id).toBeNull();
      expect(data?.needs_expert).toBe(true);
      expect(data?.severity).toBe('none');
    });

    it('rejects an unknown diagnosis that names a disease', async () => {
      const { error } = await harness.farmerA.client
        .from('diagnoses')
        .insert(unknownRow({ disease_name: 'Tomato Early Blight' }));

      expect(error?.code).toBe(CHECK_VIOLATION);
      expect(error?.message).toContain('diagnoses_unknown_shape');
    });

    it('rejects an unknown diagnosis that references a knowledge-base row', async () => {
      const knowledgeId = (await reread('Tomato Early Blight')).id;

      // Requirement 6.5's other half: no treatment content. Every treatment sentence a farmer reads
      // is composed from the referenced row, so a null `knowledge_id` is what makes "carries no
      // treatment content" true by construction rather than by the renderer remembering.
      const { error } = await harness.farmerA.client
        .from('diagnoses')
        .insert(unknownRow({ knowledge_id: knowledgeId }));

      expect(error?.code).toBe(CHECK_VIOLATION);
      expect(error?.message).toContain('diagnoses_unknown_shape');
    });

    it('rejects an unknown diagnosis that does not ask for an expert', async () => {
      const { error } = await harness.farmerA.client
        .from('diagnoses')
        .insert(unknownRow({ needs_expert: false }));

      expect(error?.code).toBe(CHECK_VIOLATION);
      expect(error?.message).toContain('diagnoses_unknown_shape');
    });

    it('rejects an unknown diagnosis that reports a severity it cannot know', async () => {
      const { error } = await harness.farmerA.client
        .from('diagnoses')
        .insert(unknownRow({ severity: 'moderate' }));

      expect(error?.code).toBe(CHECK_VIOLATION);
      expect(error?.message).toContain('diagnoses_unknown_shape');
    });

    it('rejects an identified diagnosis with no disease name or knowledge row', async () => {
      // The complementary constraint. Without it, "unknown carries no name" could be satisfied by a
      // service that wrote every result as `identified` with a null name instead.
      const { error } = await harness.farmerA.client.from('diagnoses').insert(
        unknownRow({
          status: 'identified',
          severity: 'moderate',
          needs_expert: false,
        }),
      );

      expect(error?.code).toBe(CHECK_VIOLATION);
      expect(error?.message).toContain('diagnoses_identified_shape');
    });
  });
});
