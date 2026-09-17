import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { knowledgePayloadOf, knowledgeReaderFrom } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import {
  HEALTHY_CONDITION,
  type IdentifiedResult,
  type InconclusiveResult,
  type Language,
  type RejectionReason,
  type UsageOutcome,
  type VerifiedCondition,
  type VisionRaw,
} from '@/lib/schemas';
import { dayWindowKey } from '@/lib/time';
import {
  diagnose,
  diagnosisStoreFrom,
  type DiagnosisDeps,
  type DiagnosisOutcome,
} from '@/services/diagnosis.service';
import type { CounterRpc } from '@/services/quota.service';
import type { DiseaseKnowledgeRow, UsageLogRow } from '@/types/database';

import { TEST_DATABASE_URL_VAR, describeIntegration } from './database';
import { knowledgeRow, startHarness, type Harness } from './harness';
import { uploadedImage } from './objects';
import {
  CLASSIFICATIONS,
  classificationText,
  echoingRephrase,
  imagePartsOf,
  promptTextOf,
  providerCallCount,
  verifiedItemsIn,
  type EchoingRephrase,
} from './providers';

/**
 * The image path, scenario by scenario, against a real database.
 *
 * Requirements: 3.2 (an identified result carries the Canonical_Disease_Name, the returned confidence
 *               and severity, and an explanation composed only from the matching Knowledge_Base
 *               entry), 3.4 (a healthy crop reports severity `none` and carries no treatment
 *               content), 3.5 (a multi-leaf image yields exactly one primary condition), 6.1 (a
 *               condition outside the Verified_Conditions becomes an Inconclusive_Result
 *               recommending an expert), 6.2 (an unclear photo), 6.3 (a photo with no plant)
 *               — and, because every scenario passes through them: 3.3 (persistence), 5.6 / 5.7
 *               (stage 2 and the recorded rejection reason), 6.4 / 6.5 / 6.6 / 6.7 (one shape, no
 *               name carried, no second model call, one unit still spent), 13.2 (RLS), 17.5
 * Design: "Integration tests — mocked providers, real Postgres"; D2 (two-stage validation), D3 (one
 *         inconclusive shape), D4 (no repair re-ask)
 *
 * =============================================================================
 * WHAT MAKES THESE SCENARIOS AND NOT UNIT TESTS
 * =============================================================================
 *
 * `src/services/diagnosis.service.test.ts` already drives every branch below with a stubbed
 * `CapabilityRunner`, a stubbed store and a stubbed knowledge reader. What it cannot do is exactly
 * what the requirements above are about:
 *
 *  - **Requirement 3.2's "composed only from the matching Knowledge_Base entry"** is a claim about a
 *    row the migrations wrote. A stubbed reader returns whatever the test authored, so a unit test
 *    asserting grounding is comparing the fixture with itself. Here the row comes from `0010` and
 *    the harness never seeds `disease_knowledge` (`assertMigrationsApplied`).
 *  - **Requirement 3.4's "no treatment content"** rests on `Tomato Healthy` having none. That is a
 *    seed fact *and* a check constraint (`healthy_has_no_treatment`), and only a real database has
 *    either.
 *  - **Requirement 3.3's persistence** and the `diagnoses_unknown_shape` constraint decide whether
 *    the inconclusive row is even insertable. A stubbed store accepts anything.
 *  - **Requirement 6.7's "exactly one image analysis"** is the `0007` counter functions, read back
 *    through the RPC rather than from the response envelope (D10).
 *  - **Requirement 13.2** needs a second farmer's session, which no unit test has.
 *
 * =============================================================================
 * HOW GROUNDING IS TURNED INTO AN ASSERTION
 * =============================================================================
 *
 * Through `echoingRephrase()`: the rephrase stub returns only lines it found in the prompt the
 * service itself built, so it is structurally incapable of introducing a sentence the knowledge base
 * did not supply. Any line in the farmer-facing explanation that is **not** a verbatim row item
 * therefore came from Jamee — which is what `untraceableLines()` below inspects. The reasoning is
 * spelled out where the stub lives, in `tests/integration/providers.ts`.
 *
 * Two assertions sit either side of it, because grounding is a claim about a round trip: the prompt's
 * verified-content block is compared to the seeded row's own four arrays in order (Requirement 4.5,
 * into the model), and `result.knowledge` is compared to `knowledgePayloadOf(row)` (Requirement 3.2,
 * out of it).
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

/** English throughout: the language step is `release-acceptance.test.ts`'s (Requirements 9.3, 9.4). */
const LANGUAGE: Language = 'en';

/** The language name the echo stub emits, which is the one non-agronomic line every answer carries. */
const LANGUAGE_NAME = 'English';

/**
 * The quota window every reserve in this file lands in.
 *
 * Pinned, and in the past, for the reason `QuotaOptions.now` exists: a window key is a wall-clock
 * fact in Asia/Kolkata, and an assertion that read `dayWindowKey()` at its own moment could straddle
 * a Kolkata midnight and read a fresh row. Everything else about the reserve is real — the same
 * `counter_try_increment` from `0007`, called by the same service. This file makes nine reserves
 * against a limit of twenty, so the shared window never declines one.
 */
const QUOTA_INSTANT = new Date(Date.UTC(1970, 0, 15, 12, 0, 0));

/** A classification that names two conditions at once — Requirement 3.5's failure mode. */
const TWO_CONDITIONS: VisionRaw = {
  status: 'identified',
  disease_name: 'Tomato Early Blight, Potato Late Blight',
  confidence: 0.9,
  severity: 'high',
};

/** A healthy crop that the model nonetheless graded — Requirement 3.4 pins this to `none`. */
const HEALTHY_WITH_SEVERITY: VisionRaw = {
  status: 'identified',
  disease_name: HEALTHY_CONDITION,
  confidence: 0.94,
  severity: 'high',
};

describeIntegration(`image scenarios (requires ${TEST_DATABASE_URL_VAR})`, () => {
  let harness: Harness;
  let rpc: CounterRpc;
  let rephrase: EchoingRephrase;

  beforeAll(async () => {
    rephrase = echoingRephrase();
    harness = await startHarness({ providers: { text: rephrase.text } });
    if (harness.quota.rpc === undefined) {
      throw new Error('the harness did not bind a counter RPC, so no spend claim is checkable');
    }
    rpc = harness.quota.rpc;
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  /* ====================================================================== */
  /* Wiring and shared assertions                                           */
  /* ====================================================================== */

  /**
   * The web channel's dependencies: farmer A's own RLS-scoped session everywhere except the
   * append-only audit row, which migration `0006` grants `authenticated` no insert policy for.
   *
   * Every seam is passed explicitly so nothing in this file constructs a client from an environment
   * variable, and so `supabase` is unmistakably the farmer's session rather than the service role —
   * that single argument is the difference the design draws between the web path and WhatsApp's.
   */
  function webDeps(): DiagnosisDeps {
    return {
      supabase: harness.farmerA.client,
      storage: harness.objects,
      store: diagnosisStoreFrom(harness.farmerA.client, harness.admin),
      knowledge: knowledgeReaderFrom(harness.farmerA.client),
      models: harness.providers.models,
      quota: { rpc, now: QUOTA_INSTANT },
    };
  }

  /** One upload from farmer A, classified as `raw`, answered on the web channel. */
  async function diagnoseAs(
    raw: VisionRaw | string,
    options: { readonly conversationId?: string } = {},
  ): Promise<DiagnosisOutcome> {
    harness.providers.script.vision = typeof raw === 'string' ? raw : classificationText(raw);
    return await diagnose(
      {
        userId: harness.farmerA.id,
        storageRef: uploadedImage(harness.objects, harness.farmerA.id),
        language: LANGUAGE,
        channel: 'web',
        ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
      },
      webDeps(),
    );
  }

  function identifiedOf(outcome: DiagnosisOutcome): IdentifiedResult {
    expect(outcome.result.status).toBe('identified');
    if (outcome.result.status !== 'identified') {
      throw new Error(`expected an identified result, received ${outcome.result.status}`);
    }
    return outcome.result;
  }

  function inconclusiveOf(outcome: DiagnosisOutcome): InconclusiveResult {
    expect(outcome.result.status).toBe('unknown');
    if (outcome.result.status !== 'unknown') {
      throw new Error(`expected an inconclusive result, received ${outcome.result.status}`);
    }
    return outcome.result;
  }

  /** Farmer A's image counter in the pinned window — the source of truth for what was spent (D10). */
  function imageUnitsUsed(): Promise<number> {
    return rpc.used({
      userId: harness.farmerA.id,
      operation: 'image',
      windowKind: 'day',
      windowKey: dayWindowKey(QUOTA_INSTANT),
    });
  }

  /** The audit rows for one diagnosis, read with the farmer's own session (migration 0006). */
  async function auditFor(diagnosisId: string): Promise<readonly UsageLogRow[]> {
    const { data, error } = await harness.farmerA.client
      .from('usage_logs')
      .select('*')
      .eq('diagnosis_id', diagnosisId);

    expect(error).toBeNull();
    return data ?? [];
  }

  /** The one audit row a served diagnosis writes, with the facts every scenario checks. */
  async function expectAudit(
    diagnosisId: string,
    expected: {
      readonly outcome: UsageOutcome;
      readonly rejectionReason: RejectionReason | null;
      readonly quotaSpent: boolean;
    },
  ): Promise<void> {
    const rows = await auditFor(diagnosisId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.operation).toBe('image');
    expect(row?.channel).toBe('web');
    expect(row?.outcome).toBe(expected.outcome);
    // Requirement 5.7 — a rejection is attributable, and a success carries no reason at all.
    expect(row?.rejection_reason).toBe(expected.rejectionReason);
    expect(row?.quota_spent).toBe(expected.quotaSpent);
    expect(row?.user_id).toBe(harness.farmerA.id);
  }

  /**
   * Requirements 13.1 / 13.2. The owner reads the row, the other farmer reads nothing, and the
   * service role proves it was there to be missed.
   *
   * Asserted on every scenario rather than once, because a suite that only checked its own rows
   * would pass against a database with RLS switched off.
   */
  async function expectVisibleToOwnerOnly(diagnosisId: string): Promise<void> {
    const mine = await harness.farmerA.client.from('diagnoses').select('id').eq('id', diagnosisId);
    const theirs = await harness.farmerB.client.from('diagnoses').select('id').eq('id', diagnosisId);
    const serviceRole = await harness.admin.from('diagnoses').select('id').eq('id', diagnosisId);

    expect(mine.error).toBeNull();
    expect(mine.data).toHaveLength(1);
    expect(theirs.error).toBeNull();
    expect(theirs.data).toEqual([]);
    expect(serviceRole.data).toHaveLength(1);
  }

  /**
   * Every line a farmer may read without Jamee having invented it: the four content arrays of each
   * row in scope, each Canonical_Disease_Name, and the language name — the one non-agronomic line
   * the echo stub emits, which a real model would have replaced with prose in that language.
   */
  function traceableLines(rows: readonly DiseaseKnowledgeRow[]): ReadonlySet<string> {
    const allowed = new Set<string>([LANGUAGE_NAME]);
    for (const row of rows) {
      allowed.add(row.disease_name);
      for (const field of ['symptoms', 'causes', 'treatment', 'prevention'] as const) {
        for (const item of row[field]) allowed.add(item);
      }
    }
    return allowed;
  }

  /** The lines of `text` that trace to no row in `rows` — empty is the assertion (Requirement 4.3). */
  function untraceableLines(text: string, rows: readonly DiseaseKnowledgeRow[]): string[] {
    const allowed = traceableLines(rows);
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !allowed.has(line));
  }

  /**
   * The identified shape every grounded scenario shares: the row's own payload, the canonical name
   * leading in Latin script, and not one sentence from anywhere else.
   */
  async function expectGroundedIn(
    outcome: DiagnosisOutcome,
    condition: VerifiedCondition,
  ): Promise<void> {
    const row = knowledgeRow(harness, condition);
    const result = identifiedOf(outcome);

    expect(result.diseaseName).toBe(condition);
    // Requirement 3.2, out of the model: the structured payload is the row's own arrays, compared
    // against the row rather than against strings this file authored.
    expect(result.knowledge).toEqual(knowledgePayloadOf(row));
    expect(result.knowledge.source).toBe(row.source);
    // Requirement 4.5, into the model: the request carried this row's four arrays, in order, and
    // nothing else agronomic.
    expect(verifiedItemsIn(rephrase.last())).toEqual([
      ...row.symptoms,
      ...row.causes,
      ...row.treatment,
      ...row.prevention,
    ]);
    // Requirements 4.6 / 9.4 — `split('\n')[0]` rather than `includes()`, so a transliteration
    // sitting alongside the real name could not satisfy it.
    expect(result.explanation.split('\n')[0]).toBe(condition);
    expect(
      untraceableLines(result.explanation, [row]),
      `${condition}: explanation lines that trace to no knowledge-base row`,
    ).toEqual([]);
  }

  /** The inconclusive shape every non-identified scenario shares (Requirements 6.4, 6.5). */
  function expectInconclusiveShape(
    outcome: DiagnosisOutcome,
    reason: RejectionReason,
  ): InconclusiveResult {
    const result = inconclusiveOf(outcome);

    // Requirement 6.4 — one shape for every cause.
    expect(result.needsExpert).toBe(true);
    expect(result.severity).toBe('none');
    expect(result.language).toBe(LANGUAGE);
    // Requirement 6.5 — no candidate name, no confidence, no treatment content.
    expect(result.diseaseName).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.knowledge).toBeNull();
    // D5 — the sentence is the static catalog entry for this reason, not model prose.
    expect(result.explanation).toBe(messages(LANGUAGE).inconclusive[reason]);
    expect(outcome.rejectionReason).toBe(reason);

    return result;
  }

  /** The persisted inconclusive row, which `diagnoses_unknown_shape` refuses if the shape drifts. */
  async function expectInconclusiveRow(outcome: DiagnosisOutcome): Promise<void> {
    const stored = await harness.farmerA.client
      .from('diagnoses')
      .select('status, disease_name, knowledge_id, confidence, severity, needs_expert, explanation')
      .eq('id', outcome.diagnosisId)
      .single();

    expect(stored.error).toBeNull();
    expect(stored.data?.status).toBe('unknown');
    expect(stored.data?.disease_name).toBeNull();
    expect(stored.data?.knowledge_id).toBeNull();
    expect(stored.data?.confidence).toBeNull();
    expect(stored.data?.severity).toBe('none');
    expect(stored.data?.needs_expert).toBe(true);
    expect(stored.data?.explanation).toBe(outcome.result.explanation);
  }

  /* ====================================================================== */
  /* A clear diseased crop — Requirement 3.2                                */
  /* ====================================================================== */

  describe('a clear diseased crop', () => {
    it('grounds the result in the seeded row of the name the model reported', async () => {
      const classified = CLASSIFICATIONS.tomatoEarlyBlight;
      const condition: VerifiedCondition = classified.disease_name;
      const row = knowledgeRow(harness, condition);

      const before = await imageUnitsUsed();
      const callsBefore = providerCallCount(harness.providers.calls);
      const outcome = await diagnoseAs(classified);

      await expectGroundedIn(outcome, condition);
      const result = identifiedOf(outcome);
      // "the returned confidence value" and "the returned Severity_Value", verbatim — the numbers
      // are read from `CLASSIFICATIONS` rather than written twice, so the value the stub reported and
      // the value asserted here cannot drift into a test that passes while describing another run.
      expect(result.confidence).toBe(classified.confidence);
      expect(result.severity).toBe(classified.severity);
      expect(result.needsExpert).toBe(false);

      // Requirement 3.3 — the row carries the farmer, the conversation, the storage reference and
      // the channel. The conversation was created for this request (Requirement 7.5).
      const stored = await harness.farmerA.client
        .from('diagnoses')
        .select('*')
        .eq('id', outcome.diagnosisId)
        .single();
      expect(stored.error).toBeNull();
      expect(stored.data?.user_id).toBe(harness.farmerA.id);
      expect(stored.data?.conversation_id).toBe(outcome.conversationId);
      expect(stored.data?.channel).toBe('web');
      expect(stored.data?.image_bucket).toBe('crop-images');
      expect(stored.data?.image_path?.startsWith(`${harness.farmerA.id}/`)).toBe(true);
      expect(stored.data?.disease_name).toBe(condition);
      expect(stored.data?.knowledge_id).toBe(row.id);
      expect(stored.data?.explanation).toBe(result.explanation);
      expect(stored.data?.language).toBe(LANGUAGE);

      // Requirement 2.8 — the provider was handed a Signed_URL for the farmer's own object and never
      // the bytes. Read off the request the adapter actually composed.
      const visionRequest = harness.providers.calls.geminiVision.at(-1);
      expect(visionRequest).toBeDefined();
      const images = visionRequest === undefined ? [] : imagePartsOf(visionRequest);
      expect(images).toHaveLength(1);
      expect(images[0]?.uri ?? '').toContain('/object/sign/');
      expect(images[0]?.uri ?? '').toContain(stored.data?.image_path ?? 'no path');
      const signed = harness.objects.signed.at(-1);
      expect(signed?.bucket).toBe('crop-images');
      expect(signed?.expiresInSeconds).toBeGreaterThan(0);

      // Two round trips and no more: one classification, one rephrase. D4 forbids a repair re-ask,
      // so a third call would mean the service asked a model to fix its own output.
      expect(providerCallCount(harness.providers.calls)).toBe(callsBefore + 2);

      await expectAudit(outcome.diagnosisId, {
        outcome: 'success',
        rejectionReason: null,
        quotaSpent: true,
      });
      expect(await imageUnitsUsed()).toBe(before + 1);
      await expectVisibleToOwnerOnly(outcome.diagnosisId);
    });
  });

  /* ====================================================================== */
  /* A healthy crop — Requirement 3.4                                       */
  /* ====================================================================== */

  describe('a healthy crop', () => {
    it('reports severity none and an explanation with no treatment content', async () => {
      const row = knowledgeRow(harness, HEALTHY_CONDITION);

      // The seed fact the requirement rests on, asserted rather than assumed: the row itself has no
      // treatment content, and `healthy_has_no_treatment` in `0004` is why it cannot acquire any.
      expect(row.treatment).toEqual([]);

      const outcome = await diagnoseAs(CLASSIFICATIONS.tomatoHealthy);
      await expectGroundedIn(outcome, HEALTHY_CONDITION);

      const result = identifiedOf(outcome);
      expect(result.severity).toBe('none');
      expect(result.knowledge.treatment).toEqual([]);

      /**
       * "Contains no treatment content" as something checkable rather than something believed.
       *
       * The echo stub authors nothing, so every line of this explanation is either the canonical
       * name, the language name, or a verbatim item of the healthy row — and that row has no
       * treatment items. Checking the explanation against the healthy row's **symptoms, causes and
       * prevention only** therefore leaves no line that could be treatment advice; and checking it
       * against every treatment sentence in the whole seeded base catches the other direction, a
       * sentence borrowed from one of the four diseased rows.
       */
      const allowed = new Set<string>([LANGUAGE_NAME, row.disease_name]);
      for (const field of ['symptoms', 'causes', 'prevention'] as const) {
        for (const item of row[field]) allowed.add(item);
      }
      const unexpected = result.explanation
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !allowed.has(line));
      expect(unexpected, 'healthy explanation lines outside the healthy row').toEqual([]);

      const everyTreatmentSentence = harness.knowledge.flatMap((entry) => entry.treatment);
      expect(everyTreatmentSentence.length).toBeGreaterThan(0);
      for (const sentence of everyTreatmentSentence) {
        expect(result.explanation).not.toContain(sentence);
      }

      // The prompt is the other half: `rephrasePrompt` supplies the row's arrays, and an empty
      // treatment array means the model was never given treatment content to rephrase.
      expect(verifiedItemsIn(rephrase.last())).toEqual([
        ...row.symptoms,
        ...row.causes,
        ...row.prevention,
      ]);

      await expectAudit(outcome.diagnosisId, {
        outcome: 'success',
        rejectionReason: null,
        quotaSpent: true,
      });
      await expectVisibleToOwnerOnly(outcome.diagnosisId);
    });

    it('pins severity to none even when the model graded the healthy crop', async () => {
      // The prompt asks for `none` and a model usually complies; the requirement holds by
      // construction rather than by cooperation, and this is the case that tells them apart.
      const outcome = await diagnoseAs(HEALTHY_WITH_SEVERITY);

      const result = identifiedOf(outcome);
      expect(result.diseaseName).toBe(HEALTHY_CONDITION);
      expect(HEALTHY_WITH_SEVERITY.severity).toBe('high');
      expect(result.severity).toBe('none');
      // And the *stored* row too, not just the response — `diagnoses.severity` is what history and
      // the detail view render.
      const stored = await harness.farmerA.client
        .from('diagnoses')
        .select('severity, disease_name')
        .eq('id', outcome.diagnosisId)
        .single();
      expect(stored.data?.severity).toBe('none');
      expect(stored.data?.disease_name).toBe(HEALTHY_CONDITION);
    });
  });

  /* ====================================================================== */
  /* A blurry image — Requirement 6.2                                       */
  /* ====================================================================== */

  describe('a blurry image the model declines to judge', () => {
    it('returns the inconclusive shape, spends one unit, and calls no second model', async () => {
      const before = await imageUnitsUsed();
      const callsBefore = providerCallCount(harness.providers.calls);

      const outcome = await diagnoseAs(CLASSIFICATIONS.unclear);
      const result = expectInconclusiveShape(outcome, 'model_unclear');

      // Requirement 6.2's own instruction, from the catalog: retake in good light, and see an expert.
      expect(result.explanation).toContain('good daylight');
      expect(result.explanation).toContain('agricultural expert');

      // Requirement 6.6 — one round trip for the whole request. `returnInconclusive` sits above
      // every line that could reach the rephrase call, so this counts a structural fact.
      expect(providerCallCount(harness.providers.calls)).toBe(callsBefore + 1);

      await expectInconclusiveRow(outcome);
      // `inconclusive` rather than `validation_rejected`: the model reported honestly, so nothing
      // was rejected (D2's split, recorded in `usage_logs.outcome`).
      await expectAudit(outcome.diagnosisId, {
        outcome: 'inconclusive',
        rejectionReason: 'model_unclear',
        quotaSpent: true,
      });
      // Requirement 6.7 — an accepted inconclusive result still counts exactly one image analysis.
      expect(await imageUnitsUsed()).toBe(before + 1);
      await expectVisibleToOwnerOnly(outcome.diagnosisId);
    });
  });

  /* ====================================================================== */
  /* A non-plant image — Requirement 6.3                                    */
  /* ====================================================================== */

  describe('an image with no plant in it', () => {
    it('asks for a photo of the affected crop and calls no second model', async () => {
      const before = await imageUnitsUsed();
      const callsBefore = providerCallCount(harness.providers.calls);

      const outcome = await diagnoseAs(CLASSIFICATIONS.noPlant);
      const result = expectInconclusiveShape(outcome, 'model_no_plant');

      // Requirement 6.3 asks for a photo of the affected crop — and, unlike 6.2's branch, does not
      // ask for an expert. The two sentences are different and the catalog keeps them different.
      expect(result.explanation).toContain('affected crop leaf');
      expect(result.explanation).not.toBe(messages(LANGUAGE).inconclusive.model_unclear);

      expect(providerCallCount(harness.providers.calls)).toBe(callsBefore + 1);
      await expectInconclusiveRow(outcome);
      await expectAudit(outcome.diagnosisId, {
        outcome: 'inconclusive',
        rejectionReason: 'model_no_plant',
        quotaSpent: true,
      });
      expect(await imageUnitsUsed()).toBe(before + 1);
      await expectVisibleToOwnerOnly(outcome.diagnosisId);
    });
  });

  /* ====================================================================== */
  /* A condition outside the five — Requirements 6.1, 5.6, 6.5              */
  /* ====================================================================== */

  describe('a real condition the knowledge base does not cover', () => {
    it('recommends an expert and repeats none of the name the model guessed', async () => {
      const classified = CLASSIFICATIONS.outsideKnowledgeBase;
      const before = await imageUnitsUsed();
      const callsBefore = providerCallCount(harness.providers.calls);

      const outcome = await diagnoseAs(classified);
      const result = expectInconclusiveShape(outcome, 'unverified_condition');

      // Requirement 6.1 — the coverage limit, and an expert.
      expect(result.explanation).toContain('agricultural expert');
      // Requirement 6.5 read strictly: the guessed name is nowhere in what the farmer receives, nor
      // in what was stored. Repeating it would be advice about a condition Jamee has not verified.
      expect(result.explanation).not.toContain(classified.disease_name);
      const stored = await harness.admin
        .from('diagnoses')
        .select('explanation, disease_name')
        .eq('id', outcome.diagnosisId)
        .single();
      expect(stored.data?.explanation ?? '').not.toContain(classified.disease_name);
      expect(stored.data?.disease_name).toBeNull();

      expect(providerCallCount(harness.providers.calls)).toBe(callsBefore + 1);
      await expectInconclusiveRow(outcome);
      // `validation_rejected` here, not `inconclusive`: this is Jamee's Validation_Layer refusing a
      // name (Requirement 5.6), which is a different fact from the model declining to judge.
      await expectAudit(outcome.diagnosisId, {
        outcome: 'validation_rejected',
        rejectionReason: 'unverified_condition',
        quotaSpent: true,
      });
      expect(await imageUnitsUsed()).toBe(before + 1);
      await expectVisibleToOwnerOnly(outcome.diagnosisId);
    });
  });

  /* ====================================================================== */
  /* Tomato and potato — Requirement 3.2 across both crops                  */
  /* ====================================================================== */

  describe('tomato and potato crops', () => {
    it('grounds each crop in its own row and borrows no sentence from the other', async () => {
      const tomato = await diagnoseAs(CLASSIFICATIONS.tomatoEarlyBlight);
      await expectGroundedIn(tomato, 'Tomato Early Blight');

      const potato = await diagnoseAs(CLASSIFICATIONS.potatoLateBlight);
      await expectGroundedIn(potato, 'Potato Late Blight');

      const tomatoRow = knowledgeRow(harness, 'Tomato Early Blight');
      const potatoRow = knowledgeRow(harness, 'Potato Late Blight');
      // The `crop` column the `0004` check constraint pins, so this is two crops and not two names.
      expect(tomatoRow.crop).toBe('tomato');
      expect(potatoRow.crop).toBe('potato');

      const tomatoResult = identifiedOf(tomato);
      const potatoResult = identifiedOf(potato);
      expect(tomatoResult.knowledge).not.toEqual(potatoResult.knowledge);
      expect(potatoResult.severity).toBe(CLASSIFICATIONS.potatoLateBlight.severity);

      /**
       * The cross-crop leak assertion, in both directions: no line of the potato explanation is an
       * item of the tomato row alone, and none of the tomato explanation is an item of the potato
       * row alone. `expectGroundedIn` already pins each explanation to its own row; this is the same
       * claim stated as the thing that would actually go wrong — a shared prompt buffer, or a
       * knowledge read that returned the previous request's row.
       */
      const onlyTomato = new Set(tomatoRow.symptoms);
      for (const item of potatoRow.symptoms) onlyTomato.delete(item);
      expect(onlyTomato.size).toBeGreaterThan(0);
      for (const sentence of onlyTomato) {
        expect(potatoResult.explanation).not.toContain(sentence);
      }

      const onlyPotato = new Set(potatoRow.symptoms);
      for (const item of tomatoRow.symptoms) onlyPotato.delete(item);
      expect(onlyPotato.size).toBeGreaterThan(0);
      for (const sentence of onlyPotato) {
        expect(tomatoResult.explanation).not.toContain(sentence);
      }

      await expectVisibleToOwnerOnly(tomato.diagnosisId);
      await expectVisibleToOwnerOnly(potato.diagnosisId);
    });
  });

  /* ====================================================================== */
  /* Several leaves in one image — Requirement 3.5                          */
  /* ====================================================================== */

  describe('several leaves in one image', () => {
    it('asks the model for exactly one condition and reports exactly one', async () => {
      const outcome = await diagnoseAs(CLASSIFICATIONS.tomatoEarlyBlight);
      const result = identifiedOf(outcome);

      // The request half of Requirement 3.5, read off what actually reached the provider: the
      // classification prompt tells the model to judge the single most affected leaf.
      const visionRequest = harness.providers.calls.geminiVision.at(-1);
      expect(visionRequest).toBeDefined();
      const prompt = visionRequest === undefined ? '' : promptTextOf(visionRequest);
      expect(prompt).toContain('If several leaves are visible');
      expect(prompt).toContain('exactly one condition');

      // The response half: one name, one row, one persisted diagnosis. `diseaseName` is a single
      // `VerifiedCondition` by type, so the observable form of "exactly one" is that the knowledge
      // payload is one row's and that the request produced one row.
      expect(result.diseaseName).toBe('Tomato Early Blight');
      expect(result.knowledge).toEqual(knowledgePayloadOf(knowledgeRow(harness, result.diseaseName)));

      const rows = await harness.farmerA.client
        .from('diagnoses')
        .select('id, disease_name')
        .eq('conversation_id', outcome.conversationId)
        .eq('id', outcome.diagnosisId);
      expect(rows.error).toBeNull();
      expect(rows.data).toHaveLength(1);
      expect(rows.data?.[0]?.disease_name).toBe('Tomato Early Blight');
    });

    it('refuses a classification that names two conditions instead of picking one', async () => {
      /**
       * The failure mode Requirement 3.5 exists to prevent, driven rather than assumed: a model that
       * answered a multi-leaf photo with two conditions. `visionVerifiedSchema` admits one of the
       * five names and nothing else, so the joined string is outside the Verified_Conditions and
       * stage 2 refuses it — the farmer receives the inconclusive shape rather than two diagnoses,
       * and `diagnoses.disease_name` never holds a value the check constraint would reject.
       */
      const callsBefore = providerCallCount(harness.providers.calls);
      const outcome = await diagnoseAs(TWO_CONDITIONS);

      const result = expectInconclusiveShape(outcome, 'unverified_condition');
      expect(result.explanation).not.toContain('Tomato Early Blight');
      expect(result.explanation).not.toContain('Potato Late Blight');

      expect(providerCallCount(harness.providers.calls)).toBe(callsBefore + 1);
      await expectInconclusiveRow(outcome);
      await expectAudit(outcome.diagnosisId, {
        outcome: 'validation_rejected',
        rejectionReason: 'unverified_condition',
        quotaSpent: true,
      });
    });
  });

  /* ====================================================================== */
  /* The whole file, seen from the audit trail                              */
  /* ====================================================================== */

  it('spent one image unit per scenario and attributed every row to this farmer', async () => {
    const { data, error } = await harness.farmerA.client
      .from('usage_logs')
      .select('operation, channel, outcome, quota_spent, diagnosis_id, user_id');

    expect(error).toBeNull();
    const rows = data ?? [];
    // Every scenario in this file is one image analysis on the web channel, and each one produced a
    // diagnosis row — including the inconclusive ones, which is Requirement 6.7 seen from the audit.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.operation).toBe('image');
      expect(row.channel).toBe('web');
      expect(row.user_id).toBe(harness.farmerA.id);
      expect(row.quota_spent).toBe(true);
      expect(row.diagnosis_id).not.toBeNull();
    }
    expect(await imageUnitsUsed()).toBe(rows.length);

    // Requirement 13.2 on the audit table: the other farmer's session sees none of it.
    const theirs = await harness.farmerB.client.from('usage_logs').select('user_id');
    expect(theirs.error).toBeNull();
    expect(theirs.data ?? []).toEqual([]);
  });
});
