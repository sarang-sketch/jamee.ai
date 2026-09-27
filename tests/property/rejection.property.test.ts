import { Buffer } from 'node:buffer';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner, VisionCall } from '@/lib/ai/capabilities';
import { DAILY_QUOTAS } from '@/lib/config/verified';
import type { DiagnosisInsert } from '@/lib/db/analysis';
import type { UsageLogInsert } from '@/lib/db/usage-log';
import type { KnowledgeReader } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import { PROMPT_VERSION } from '@/lib/prompts';
import { REJECTION_REASONS, languageSchema } from '@/lib/schemas';
import type { MediaRef, RejectionReason } from '@/lib/schemas';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import { diagnose, type DiagnosisDeps, type DiagnosisStore } from '@/services/diagnosis.service';
import type { CounterRpc } from '@/services/quota.service';

/**
 * **Property 7: Every rejection is attributable and its content is discarded.**
 *
 * > For any rejected provider response, a usage log row records a rejection reason that
 * > distinguishes its cause, and no token originating from the rejected content appears anywhere in
 * > the response returned to the farmer.
 *
 * **Validates: Requirement 5.7**
 *
 * =============================================================================
 * WHY THIS RUNS THROUGH `diagnose()` AND NOT THROUGH `interpret()`
 * =============================================================================
 *
 * Property 6 (task 3.5) is a claim about a *verdict*, so it is driven at `interpret()`. This one is a
 * claim about two things `interpret()` cannot produce: a **usage log row** and a **response returned
 * to the farmer**. Requirement 5.7 assigns both to the API_Layer — "THE API_Layer SHALL record the
 * rejection reason in the Usage_Log and SHALL exclude the rejected content from the response
 * returned to the Farmer" — and in Jamee the service is where both are written. So the property is
 * driven end to end through `diagnose()` with the gateway and the database stubbed at their seams,
 * and it reads the rows the service actually wrote.
 *
 * =============================================================================
 * WHAT "ATTRIBUTABLE" IS ASSERTED TO MEAN
 * =============================================================================
 *
 * Not "a reason was recorded" — a single reason recorded for everything would satisfy that and
 * answer nothing. Three claims together:
 *
 *  1. **Recorded.** Exactly one `usage_logs` row per rejected request, with a non-null
 *     `rejection_reason` drawn from the closed vocabulary, and the same reason on the value the
 *     caller gets back so a route or the WhatsApp adapter can log it without re-deriving it.
 *  2. **Correct.** The reason names *the criterion that refused the response*. Each generator below
 *     breaks exactly one criterion, so its expected reason is fixed by construction rather than by
 *     re-implementing the validation layer — which is what makes this an attribution test and not a
 *     second copy of Property 6.
 *  3. **Distinguishing.** The eight generators cover seven criteria and produce seven *distinct*
 *     reasons, with the `outcome` column separating the five Jamee refused (5.2–5.6,
 *     `validation_rejected`) from the two the model reported honestly (6.2, 6.3, `inconclusive`).
 *     Requirement 5.7's audit exists to answer "why did this come back inconclusive", and a
 *     vocabulary that collapsed two causes onto one value could not.
 *
 * **This file is where a known attribution defect was settled.** Task 3.5 found that an absent or
 * wrong-typed `severity` was recorded as `invalid_severity` (Requirement 5.5) rather than
 * `missing_field` (5.3): `severity` is a `z.enum` and Zod reports `invalid_value` for an absent key,
 * a wrong-typed value and a non-member value alike, so `stage1Reason`'s "absent or wrongly typed"
 * rule — which looked for an `invalid_type` issue — never fired for it. Property 6 was unaffected
 * because the accept/reject verdict was not, and 3.5 deliberately left the reason unpinned rather
 * than turn the defect into a fixture. `stage1Reason` now decides that rule from the parsed payload;
 * the `5.3` generators below carry an absent and a wrong-typed `severity` on purpose.
 *
 * =============================================================================
 * HOW "DISCARDED" IS ASSERTED — STRUCTURALLY FIRST, BY TOKEN SECOND
 * =============================================================================
 *
 * A token search alone is a weak test: it can only look for what the author thought to look for, and
 * it passes vacuously if the generator stops producing distinctive content. So discard is asserted
 * three ways, strongest first:
 *
 *  1. **Complete accounting of what leaves the service.** Every string and every number in the
 *     returned `DiagnosisOutcome` is checked against an allowlist assembled from Jamee's own facts —
 *     the static localized sentence, the row ids, the quota window, the provider name, the reason. A
 *     leaf the allowlist does not name fails the test, whether or not anyone anticipated it. This is
 *     what proves the model's confidence did not survive: no unaccounted number exists.
 *  2. **The persisted row's guessable columns are pinned.** `disease_name`, `knowledge_id` and
 *     `confidence` are `null` and `severity` is `none` on the `diagnoses` row, because Requirement
 *     5.7's "excluded from the response" is worth little if the value is sitting in the database
 *     ready for the history screen to read.
 *  3. **Marker tokens.** Every generated response carries a nonce token — filtered against the
 *     corpus of everything that legitimately appears in the output — and a confidence with a
 *     distinctive decimal expansion. Neither may appear anywhere in the outcome or in either
 *     persisted row. This is the half that covers the free prose in a `not_json` response and an
 *     extra key the schema dropped, where there is no field to make a structural claim about.
 */

/* ========================================================================== */
/* Fixtures — the request, the clock, and the seams                            */
/* ========================================================================== */

const USER = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const DIAGNOSIS_ID = '55555555-5555-4555-8555-555555555555';

/** 2026-09-15T19:30:00Z is 2026-09-16T01:00 in Asia/Kolkata — the far side of the +05:30 offset. */
const NOW_MS = Date.parse('2026-09-15T19:30:00.000Z');
const RESETS_AT = '2026-09-16T18:30:00.000Z';

const IMAGE_REF: MediaRef = { fileId: 'a'.repeat(24), kind: 'crop-image' };

/** The bytes the owner-checked read yields, and the MIME type stored alongside them. */
const IMAGE_BYTES = Buffer.from('jamee property harness: fake crop-image bytes');
const IMAGE_MIME = 'image/jpeg';

/**
 * A3, V34: the owner-checked media read yields the bytes the model is sent inline. Every dependency
 * of `diagnose()` is injected below, so there is no Supabase stack to stand in for.
 */
const readMedia = (): Promise<{ bytes: Buffer; mimeType: string }> =>
  Promise.resolve({ bytes: IMAGE_BYTES, mimeType: IMAGE_MIME });

/** Nothing is grounded on a rejected response, so a knowledge-base read here is a defect. */
const unreachableKnowledge: KnowledgeReader = () => {
  throw new Error('the knowledge base was read for a rejected response');
};

const conversations: ConversationStore = {
  mostRecent: (_userId, channel) => Promise.resolve(conversationRow(channel)),
  create: (_userId, channel) => Promise.resolve(conversationRow(channel)),
};

function conversationRow(channel: Conversation['channel']): Conversation {
  return {
    id: CONVERSATION_ID,
    user_id: USER,
    channel,
    title: null,
    created_at: '2026-09-16T00:59:00.000Z',
    updated_at: '2026-09-16T00:59:00.000Z',
  };
}

const counterRpc: CounterRpc = {
  tryIncrement: () => Promise.resolve(1),
  decrement: () => Promise.resolve(0),
  used: () => Promise.resolve(0),
};

interface Recorder {
  readonly deps: DiagnosisDeps;
  readonly diagnoses: DiagnosisInsert[];
  readonly usage: UsageLogInsert[];
  readonly classifyCalls: VisionCall[];
  readonly generateCalls: number[];
}

/** One request's worth of seams, recording every row written and every gateway call made. */
function recorder(modelSaid: string): Recorder {
  const diagnoses: DiagnosisInsert[] = [];
  const usage: UsageLogInsert[] = [];
  const classifyCalls: VisionCall[] = [];
  const generateCalls: number[] = [];

  const store: DiagnosisStore = {
    insertDiagnosis: (row) => {
      diagnoses.push(row);
      return Promise.resolve(DIAGNOSIS_ID);
    },
    insertUsageLog: (row) => {
      usage.push(row);
      return Promise.resolve();
    },
    ownsConversation: () => Promise.resolve(true),
  };

  const models: CapabilityRunner = {
    classify: (input) => {
      classifyCalls.push(input);
      return Promise.resolve({ value: modelSaid, provider: 'gemini' as const, usedFallback: false });
    },
    generate: () => {
      generateCalls.push(1);
      // Requirement 6.6 / D4 — no model call is reachable once a response has been rejected.
      throw new Error('a second model call was issued for a rejected response');
    },
  };

  return {
    diagnoses,
    usage,
    classifyCalls,
    generateCalls,
    deps: {
      store,
      readMedia,
      conversations,
      knowledge: unreachableKnowledge,
      models,
      quota: { rpc: counterRpc, now: new Date(NOW_MS) },
      now: () => NOW_MS,
      platformDeadline: () => undefined,
    },
  };
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

/**
 * Everything that may legitimately appear in the output, as one searchable corpus.
 *
 * The marker arbitrary is filtered against it, so "this token came from the rejected response" is a
 * fact about the token rather than an assumption about the copy. Regenerating the catalogs in another
 * language cannot silently make a marker collide.
 */
const OUTPUT_CORPUS = [
  ...languageSchema.options.flatMap((language) =>
    Object.values(messages(language).inconclusive as Record<string, string>),
  ),
  USER,
  OBJECT_ID,
  CONVERSATION_ID,
  DIAGNOSIS_ID,
  IMAGE_REF.fileId,
  PROMPT_VERSION,
  RESETS_AT,
  ...REJECTION_REASONS,
  'gemini',
  'validation_rejected',
  'inconclusive',
].join('\u0000');

/**
 * A nonce token that cannot occur in Jamee's own output.
 *
 * `Zq` is not a hex digit pair, so it cannot appear inside a uuid or a storage path, and the catalogs
 * are English and Devanagari prose. The filter is belt and braces, and it is the honest kind: it
 * makes the claim checkable rather than assumed.
 */
const markerToken = fc
  .integer({ min: 100_000, max: 99_999_999 })
  .map((value) => `Zq${value.toString(36).toUpperCase()}Xk`)
  .filter((token) => !OUTPUT_CORPUS.includes(token));

/** A confidence whose decimal expansion is distinctive enough to search for. Inside [0, 1]. */
const admissibleConfidence = fc
  .integer({ min: 1_000_001, max: 9_999_998 })
  .map((value) => value / 10_000_000);

/** Outside [0, 1], on either side, and equally distinctive. */
const inadmissibleConfidence = fc.oneof(
  fc.integer({ min: 1_000_001, max: 9_999_999 }).map((value) => value / 1_000_000),
  fc.integer({ min: 1_000_001, max: 9_999_999 }).map((value) => -value / 10_000_000),
);

const severityValue = fc.constantFrom('none', 'low', 'moderate', 'high');
const language = fc.constantFrom(...languageSchema.options);

/** What one generated case claims about itself. */
interface RejectedResponse {
  /** The acceptance criterion this response breaks, for the failure message. */
  readonly criterion: string;
  /** The reason that criterion must be attributed to. */
  readonly reason: RejectionReason;
  /** Which family `usage_logs.outcome` must place it in. */
  readonly usageOutcome: 'validation_rejected' | 'inconclusive';
  /** The provider response, verbatim. */
  readonly raw: string;
  /** Substrings that originate in `raw` and must not survive into any output. */
  readonly needles: readonly string[];
}

const jsonOf = (payload: unknown): string => JSON.stringify(payload);

/**
 * A well-formed, non-identified payload carrying the marker in `disease_name`.
 *
 * `disease_name` is a free string at stage 1 (D2) whenever `status` is not `identified`, so this is
 * the one place a marker can ride along in a payload that is otherwise valid — which is what lets
 * each generator below break exactly one criterion and no more.
 */
const carrierPayload = (
  marker: string,
  confidence: number,
  severity: string,
  status = 'unclear',
): Record<string, unknown> => ({
  status,
  disease_name: `${marker} Blight`,
  confidence,
  severity,
});

const withoutKey = (
  payload: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const copy = { ...payload };
  delete copy[key];
  return copy;
};

/** 5.2 — prose, which is what a provider that ignored its own output contract actually returns. */
const notJsonCase = fc.tuple(markerToken, admissibleConfidence).map(
  ([marker, confidence]): RejectedResponse => ({
    criterion: '5.2 — the response is not parseable JSON',
    reason: 'not_json',
    usageOutcome: 'validation_rejected',
    raw: `This leaf shows ${marker} Blight. My confidence is ${confidence}.`,
    needles: [marker, String(confidence)],
  }),
);

/**
 * 5.3 — a required key absent. `severity` is one of the two fields dropped, deliberately: the reason
 * for an absent `severity` is the one this file settled.
 *
 * The payload also carries an extra key holding the marker, because a key the schema drops is still
 * rejected content and Requirement 5.7 excludes it just the same.
 */
const absentFieldCase = fc
  .tuple(markerToken, admissibleConfidence, severityValue, fc.constantFrom('status', 'severity'))
  .map(([marker, confidence, severity, field]): RejectedResponse => {
    const payload = {
      ...carrierPayload(marker, confidence, severity),
      notes: `${marker} is spreading fast`,
    };
    return {
      criterion: `5.3 — the required field \`${field}\` is absent`,
      reason: 'missing_field',
      usageOutcome: 'validation_rejected',
      raw: jsonOf(withoutKey(payload, field)),
      needles: [marker, String(confidence)],
    };
  });

/** 5.3 — a required key present with the wrong JSON type, `severity: false` among them. */
const wrongTypeFieldCase = fc
  .tuple(
    markerToken,
    admissibleConfidence,
    severityValue,
    fc.constantFrom<Record<string, unknown>>({ severity: false }, { status: 7 }, { severity: null }),
  )
  .map(([marker, confidence, severity, override]): RejectedResponse => ({
    criterion: `5.3 — a required field carries the wrong type (${jsonOf(override)})`,
    reason: 'missing_field',
    usageOutcome: 'validation_rejected',
    raw: jsonOf({ ...carrierPayload(marker, confidence, severity), ...override }),
    needles: [marker, String(confidence)],
  }));

/** 5.4 — a number, the right type, outside the closed interval. */
const outOfRangeCase = fc
  .tuple(markerToken, inadmissibleConfidence, severityValue)
  .map(([marker, confidence, severity]): RejectedResponse => ({
    criterion: '5.4 — confidence outside the closed interval 0 to 1',
    reason: 'confidence_out_of_range',
    usageOutcome: 'validation_rejected',
    raw: jsonOf(carrierPayload(marker, confidence, severity)),
    needles: [marker, String(confidence)],
  }));

/** 5.5 — present, well typed, and outside the four values. The marker rides in the value itself. */
const invalidSeverityCase = fc
  .tuple(markerToken, admissibleConfidence)
  .map(([marker, confidence]): RejectedResponse => ({
    criterion: '5.5 — a severity outside the four Severity_Values',
    reason: 'invalid_severity',
    usageOutcome: 'validation_rejected',
    raw: jsonOf(carrierPayload(marker, confidence, `${marker}-high`)),
    needles: [marker, String(confidence)],
  }));

/**
 * 5.6 — the safety gate. A confidently reported condition Jamee holds no verified content for, which
 * is the case the requirement exists for rather than a garbage string.
 */
const unverifiedConditionCase = fc
  .tuple(
    markerToken,
    admissibleConfidence,
    severityValue,
    fc.constantFrom('Rust', 'Mosaic Virus', 'Bacterial Wilt', 'Powdery Mildew'),
  )
  .map(([marker, confidence, severity, condition]): RejectedResponse => ({
    criterion: '5.6 — an identified response naming a condition outside the five',
    reason: 'unverified_condition',
    usageOutcome: 'validation_rejected',
    raw: jsonOf({
      status: 'identified',
      disease_name: `${marker} ${condition}`,
      confidence,
      severity,
    }),
    needles: [marker, String(confidence)],
  }));

/**
 * 6.2 and 6.3 — the model reporting honestly, which is a *valid* stage-1 parse and not a refusal.
 *
 * Included because Requirement 5.7's column is written on these rows too, and because the candidate
 * name and confidence they carry must be discarded for exactly the same reason: the farmer is
 * getting an inconclusive result either way, and a name attached to one would be a guess.
 */
const modelReportedCase = fc
  .tuple(markerToken, admissibleConfidence, severityValue, fc.constantFrom('unclear', 'no_plant'))
  .map(([marker, confidence, severity, status]): RejectedResponse => ({
    criterion:
      status === 'unclear'
        ? '6.2 — the model reported the photo too unclear to judge'
        : '6.3 — the model reported no plant in the frame',
    reason: status === 'unclear' ? 'model_unclear' : 'model_no_plant',
    usageOutcome: 'inconclusive',
    raw: jsonOf(carrierPayload(marker, confidence, severity, status)),
    needles: [marker, String(confidence)],
  }));

const CASE_ARBITRARIES = [
  notJsonCase,
  absentFieldCase,
  wrongTypeFieldCase,
  outOfRangeCase,
  invalidSeverityCase,
  unverifiedConditionCase,
  modelReportedCase,
] as const;

const rejectedResponse = fc.oneof(...CASE_ARBITRARIES);

/* ========================================================================== */
/* Leaf accounting — the strong half of "discarded"                            */
/* ========================================================================== */

function stringLeaves(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, into);
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) stringLeaves(item, into);
  }
  return into;
}

function numberLeaves(value: unknown, into: number[] = []): number[] {
  if (typeof value === 'number') into.push(value);
  else if (Array.isArray(value)) for (const item of value) numberLeaves(item, into);
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) numberLeaves(item, into);
  }
  return into;
}

/* ========================================================================== */
/* The property                                                                */
/* ========================================================================== */

describe('Property 7 — every rejection is attributable', () => {
  it('covers seven criteria with seven distinct reasons, split into refusals and model reports', () => {
    // The generators are the oracle for "which criterion refused this", so a table that quietly lost
    // a criterion — or gave two of them the same reason — would make every assertion below weaker
    // while still reporting green. The seed is fixed so this is a statement about the arbitraries.
    const cases = fc.sample(rejectedResponse, { numRuns: 400, seed: 7 });

    const byReason = new Map<RejectionReason, Set<string>>();
    for (const testCase of cases) {
      const criteria = byReason.get(testCase.reason) ?? new Set<string>();
      criteria.add(testCase.criterion.slice(0, 3));
      byReason.set(testCase.reason, criteria);
    }

    expect([...byReason.keys()].sort()).toEqual([...REJECTION_REASONS].sort());

    // No reason serves two acceptance criteria. `missing_field` is reached by an absent field and by
    // a wrong-typed one, but both are Requirement 5.3.
    for (const [reason, criteria] of byReason) {
      expect([...criteria], `${reason} is attributed to more than one criterion`).toHaveLength(1);
    }

    const refusals = new Set(
      cases.filter((c) => c.usageOutcome === 'validation_rejected').map((c) => c.reason),
    );
    const reported = new Set(
      cases.filter((c) => c.usageOutcome === 'inconclusive').map((c) => c.reason),
    );
    expect([...refusals].sort()).toEqual([
      'confidence_out_of_range',
      'invalid_severity',
      'missing_field',
      'not_json',
      'unverified_condition',
    ]);
    expect([...reported].sort()).toEqual(['model_no_plant', 'model_unclear']);
  });

  it('records the reason of the criterion that refused the response, on the row and on the result', async () => {
    await fc.assert(
      fc.asyncProperty(rejectedResponse, language, async (testCase, lang) => {
        const test = recorder(testCase.raw);

        const outcome = await diagnose(
          { userId: USER, image: IMAGE_REF, language: lang, channel: 'web' },
          test.deps,
        );

        // 1. Recorded — exactly one row, and the reason is on it.
        expect(test.usage).toHaveLength(1);
        const row = test.usage[0];
        if (row === undefined) throw new Error('no usage_logs row was written');

        // 2. Correct — the reason names the criterion this response broke.
        expect(row.rejection_reason, testCase.criterion).toBe(testCase.reason);
        expect(outcome.rejectionReason, testCase.criterion).toBe(testCase.reason);

        // 3. Distinguishing — the outcome column keeps Jamee's refusals apart from the model's own
        // honest statuses, which is the coarser question an operator asks first.
        expect(row.outcome).toBe(testCase.usageOutcome);

        // The row is attributable to a request as well as to a cause: Requirement 14.6's five facts,
        // and the spend rule (6.7) — a classification call happened, so the unit stays spent.
        expect(row).toMatchObject({
          user_id: USER,
          operation: 'image',
          channel: 'web',
          model_provider: 'gemini',
          used_fallback: false,
          quota_spent: true,
          prompt_version: PROMPT_VERSION,
          diagnosis_id: DIAGNOSIS_ID,
          conversation_id: CONVERSATION_ID,
        });

        // One classification, no second call — the reason was decided, not negotiated (6.6, D4).
        expect(test.classifyCalls).toHaveLength(1);
        expect(test.generateCalls).toHaveLength(0);
      }),
      { numRuns: 250 },
    );
  });
});

describe('Property 7 — the rejected content is discarded', () => {
  it('returns nothing but Jamee’s own facts: every string and number leaf is accounted for', async () => {
    await fc.assert(
      fc.asyncProperty(rejectedResponse, language, async (testCase, lang) => {
        const test = recorder(testCase.raw);

        const outcome = await diagnose(
          { userId: USER, image: IMAGE_REF, language: lang, channel: 'web' },
          test.deps,
        );

        // The complete accounting. Nothing here originates in the provider's response: the sentence
        // is a static catalog lookup (D5), the ids are Jamee's, the quota window is the clock's, and
        // the reason is the closed vocabulary's.
        const permittedStrings = new Set([
          'unknown',
          'none',
          lang,
          messages(lang).inconclusive[testCase.reason],
          DIAGNOSIS_ID,
          CONVERSATION_ID,
          'image',
          RESETS_AT,
          'gemini',
          testCase.reason,
        ]);
        const permittedNumbers = new Set([1, DAILY_QUOTAS.image]);

        for (const leaf of stringLeaves(outcome)) {
          expect(permittedStrings, `unaccounted string ${JSON.stringify(leaf)}`).toContain(leaf);
        }
        // The model's confidence is a number, so this loop is what proves it did not survive in a
        // weaker form — rounded, stringified, or moved to a field nobody thought to check.
        for (const leaf of numberLeaves(outcome)) {
          expect(permittedNumbers, `unaccounted number ${leaf}`).toContain(leaf);
        }
      }),
      { numRuns: 250 },
    );
  });

  it('pins every guessable column on the persisted row, so the history screen has nothing to read', async () => {
    await fc.assert(
      fc.asyncProperty(rejectedResponse, language, async (testCase, lang) => {
        const test = recorder(testCase.raw);

        const outcome = await diagnose(
          { userId: USER, image: IMAGE_REF, language: lang, channel: 'web' },
          test.deps,
        );

        // Requirement 6.4's one shape, compared whole: an extra field carrying a guess fails here.
        expect(outcome.result).toEqual({
          status: 'unknown',
          diseaseName: null,
          confidence: null,
          severity: 'none',
          explanation: messages(lang).inconclusive[testCase.reason],
          knowledge: null,
          needsExpert: true,
          language: lang,
        });

        expect(test.diagnoses).toHaveLength(1);
        const row = test.diagnoses[0];
        if (row === undefined) throw new Error('no diagnoses row was written');

        // Requirement 5.7's exclusion at the persistence layer. `diagnoses_unknown_shape` enforces
        // the same thing in SQL; this is the boundary above it.
        expect(row).toMatchObject({
          status: 'unknown',
          diseaseName: null,
          knowledgeId: null,
          confidence: null,
          severity: 'none',
          needsExpert: true,
        });
      }),
      { numRuns: 250 },
    );
  });

  it('lets no token from the rejected response reach the outcome or either row', async () => {
    await fc.assert(
      fc.asyncProperty(rejectedResponse, language, async (testCase, lang) => {
        const test = recorder(testCase.raw);

        const outcome = await diagnose(
          { userId: USER, image: IMAGE_REF, language: lang, channel: 'web' },
          test.deps,
        );

        const everythingWritten = JSON.stringify({
          outcome,
          diagnoses: test.diagnoses,
          usage: test.usage,
        });

        // The token half. It covers what the structural checks cannot reach: free prose in a
        // `not_json` response, and an extra key the schema silently dropped rather than rejected.
        for (const needle of testCase.needles) {
          expect(
            everythingWritten.includes(needle),
            `${JSON.stringify(needle)} survived from the rejected response (${testCase.criterion})`,
          ).toBe(false);
          // The needle really was in the rejected content, so the assertion above is not vacuous.
          expect(testCase.raw.includes(needle)).toBe(true);
        }
      }),
      { numRuns: 250 },
    );
  });
});
