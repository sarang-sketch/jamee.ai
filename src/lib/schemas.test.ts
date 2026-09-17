import { describe, expect, it } from 'vitest';

import {
  REJECTION_REASONS,
  VERIFIED_CONDITIONS,
  inconclusiveResultSchema,
  severitySchema,
  visionRawSchema,
  type InconclusiveResult,
  type RejectionReason,
} from '@/lib/schemas';
import { interpret } from '@/services/diagnosis.service';

/**
 * Unit tests for the rejection-reason contract and the inconclusive shape.
 *
 * Requirements: 5.2 (a response that is not valid JSON is rejected), 5.3 (a required field of the
 *               diagnosis schema is absent), 5.4 (confidence outside the range 0 to 1 *inclusive*),
 *               5.5 (a severity outside the four Severity_Values), 5.6 (a condition outside the five
 *               Verified_Conditions), 6.5 (an Inconclusive_Result carries no candidate disease name
 *               and no treatment content)
 * Design: D2 (two-stage validation), D3 (one inconclusive shape)
 *
 * ### Why a schemas test reaches into the service
 *
 * `schemas.ts` owns the two halves this file is about — the closed `REJECTION_REASONS` vocabulary,
 * one value per acceptance criterion, and `inconclusiveResultSchema`, whose every guessable field is
 * pinned to a literal. What it does not own is the **mapping**: which reason a given malformed
 * response is attributed to. That is `interpret()` in `src/services/diagnosis.service.ts`, the
 * composition of `visionRawSchema` then `visionVerifiedSchema` around a `JSON.parse`.
 *
 * A rejection reason is only worth having if it is the *right* one, so the mapping is where these
 * criteria are observable and this file drives it there. The schemas are also asserted directly
 * where the claim is theirs alone — the closed confidence interval, and Requirement 6.5's shape.
 *
 * ### The distinction this file exists to defend
 *
 * `missing_field` (5.3) and `invalid_severity` (5.5) are separate values for one reason: a malformed
 * response and a response carrying an unsupported *value* are different provider problems, and
 * Requirement 5.7's audit is what tells them apart a week later. So the absent-field table below
 * covers all four required fields including `severity`, and the invalid-severity table covers only
 * values that are **present and well typed**.
 *
 * That split is not hypothetical. `stage1Reason` used to decide "absent or wrongly typed" by looking
 * for a Zod issue of code `invalid_type`, and `severity` is a `z.enum` — Zod reports `invalid_value`
 * for an absent key, a wrong-typed value and a non-member value alike, so a response carrying no
 * `severity` key at all was audited as `invalid_severity`. The accept/reject verdict was unaffected,
 * which is why it survived Property 6; only the audit was wrong. `stage1Reason` now decides that
 * rule from the parsed payload, and the four `severity` rows below are what hold it there.
 *
 * ### Companion coverage
 *
 * `tests/property/schemas.property.test.ts` drives the same criteria over generated responses
 * (Property 6, the accept/reject biconditional) and `tests/property/rejection.property.test.ts`
 * drives attribution and discard end to end through `diagnose()` (Property 7). This file pins the
 * named examples and the one claim neither property can make, because it is not a runtime claim at
 * all: Requirement 6.5 as a *compile* error.
 */

/* ========================================================================== */
/* The vocabulary                                                              */
/* ========================================================================== */

describe('REJECTION_REASONS', () => {
  it('is a closed vocabulary of seven distinct values', () => {
    // One value per acceptance criterion — 5.2–5.6 plus the model's own 6.2 and 6.3. Distinctness is
    // what makes an audit row attributable rather than decorative (Requirement 5.7).
    expect(REJECTION_REASONS).toHaveLength(7);
    expect(new Set(REJECTION_REASONS).size).toBe(REJECTION_REASONS.length);
  });
});

/* ========================================================================== */
/* Requirements 5.2–5.6, one named case per criterion                          */
/* ========================================================================== */

const IN_KNOWLEDGE_BASE = 'Tomato Early Blight';

function visionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'identified',
    disease_name: IN_KNOWLEDGE_BASE,
    confidence: 0.87,
    severity: 'moderate',
    ...overrides,
  });
}

/** The well-formed payload with one key removed, rather than with that key set to `undefined`. */
function visionJsonWithout(field: string): string {
  const payload = JSON.parse(visionJson()) as Record<string, unknown>;
  delete payload[field];
  return JSON.stringify(payload);
}

interface CriterionCase {
  readonly criterion: string;
  readonly modelSaid: string;
  readonly reason: RejectionReason;
}

/**
 * The five criteria, each driven by the case the requirement names.
 *
 * `interpret` is compared **whole** rather than by reading `.reason`: the refusal value has no field
 * for a rejected name or confidence to travel in, and comparing the whole object is what keeps it
 * that way if someone adds one.
 */
const CRITERION_CASES: readonly CriterionCase[] = [
  {
    criterion: '5.2 — the response is not parseable JSON',
    modelSaid: 'I think this leaf has early blight.',
    reason: 'not_json',
  },
  {
    criterion: '5.3 — a required field of the diagnosis schema is absent',
    modelSaid: visionJsonWithout('confidence'),
    reason: 'missing_field',
  },
  {
    criterion: '5.4 — confidence below the closed interval',
    modelSaid: visionJson({ confidence: -0.1 }),
    reason: 'confidence_out_of_range',
  },
  {
    criterion: '5.4 — confidence above the closed interval',
    modelSaid: visionJson({ confidence: 1.1 }),
    reason: 'confidence_out_of_range',
  },
  {
    criterion: '5.5 — a severity outside the four Severity_Values',
    modelSaid: visionJson({ severity: 'catastrophic' }),
    reason: 'invalid_severity',
  },
  {
    criterion: '5.6 — a real condition outside the five Verified_Conditions',
    modelSaid: visionJson({ disease_name: 'Wheat Rust', confidence: 0.94, severity: 'high' }),
    reason: 'unverified_condition',
  },
];

describe('interpret — each rejection criterion maps to its own reason', () => {
  for (const testCase of CRITERION_CASES) {
    it(`attributes ${testCase.criterion} to ${testCase.reason}`, () => {
      expect(interpret(testCase.modelSaid)).toEqual({ ok: false, reason: testCase.reason });
    });
  }

  it('gives the five criteria four distinct reasons, with only the two confidence ends sharing one', () => {
    // The named cases must not collapse onto one another: a vocabulary where 5.3 and 5.5 report the
    // same value would answer none of the questions Requirement 5.7 asks of the audit. The two
    // confidence rows are one criterion driven at both ends, so they share by design.
    const attributed = CRITERION_CASES.map((testCase) => {
      const verdict = interpret(testCase.modelSaid);
      return verdict.ok ? 'accepted' : verdict.reason;
    });

    expect(new Set(attributed)).toEqual(
      new Set([
        'not_json',
        'missing_field',
        'confidence_out_of_range',
        'invalid_severity',
        'unverified_condition',
      ]),
    );
    expect(attributed.filter((reason) => reason === 'confidence_out_of_range')).toHaveLength(2);
  });

  it('reports a fenced JSON block as not_json rather than unwrapping it (5.2)', () => {
    // Both configured members return raw JSON, so a fence means a provider ignored its own output
    // contract. Repairing that locally is the content repair D4 forbids, one step earlier.
    expect(interpret(`\`\`\`json\n${visionJson()}\n\`\`\``)).toEqual({
      ok: false,
      reason: 'not_json',
    });
    // A truncated object — the interrupted-stream failure — is the same verdict.
    expect(interpret(visionJson().slice(0, -1))).toEqual({ ok: false, reason: 'not_json' });
  });
});

/* ========================================================================== */
/* Requirement 5.3, per field — including the one that used to be misattributed */
/* ========================================================================== */

const REQUIRED_FIELDS = ['status', 'disease_name', 'confidence', 'severity'] as const;

/** A value of the wrong JSON type per field. `disease_name` is nullable, so `null` is not one. */
const WRONG_TYPE_FOR: Readonly<Record<(typeof REQUIRED_FIELDS)[number], unknown>> = {
  status: 7,
  disease_name: 7,
  confidence: 'high',
  severity: false,
};

describe('interpret — an absent or wrong-typed field is missing_field, whatever else is also wrong', () => {
  for (const field of REQUIRED_FIELDS) {
    it(`attributes an absent ${field} to missing_field`, () => {
      expect(interpret(visionJsonWithout(field))).toEqual({ ok: false, reason: 'missing_field' });
    });

    it(`attributes a wrong-typed ${field} to missing_field`, () => {
      expect(interpret(visionJson({ [field]: WRONG_TYPE_FOR[field] }))).toEqual({
        ok: false,
        reason: 'missing_field',
      });
    });
  }

  it('attributes an absent severity to 5.3 rather than 5.5, because no severity value was supplied', () => {
    // The regression this file was written around, stated as its own case so it fails by name.
    // A response with no `severity` key has not named a severity outside the vocabulary — it has
    // named none — and `invalid_severity` would tell an operator the opposite.
    expect(interpret('{"status":"unclear","disease_name":" ","confidence":0}')).toEqual({
      ok: false,
      reason: 'missing_field',
    });
    expect(
      interpret('{"status":"unclear","disease_name":" ","confidence":0,"severity":false}'),
    ).toEqual({ ok: false, reason: 'missing_field' });
  });

  it('attributes a payload that is valid JSON but not the diagnosis object to missing_field', () => {
    // Every required field is absent from these, which is rule 1's other half.
    expect(interpret('"unclear"')).toEqual({ ok: false, reason: 'missing_field' });
    expect(interpret('[]')).toEqual({ ok: false, reason: 'missing_field' });
    expect(interpret('null')).toEqual({ ok: false, reason: 'missing_field' });
  });

  it('attributes a present-but-unusable status or empty name to missing_field, not to a value reason', () => {
    // No reason exists for "present, well typed, and still unusable", and inventing an eighth would
    // record a distinction no farmer can act on — all four schema reasons render identical copy.
    expect(interpret(visionJson({ status: 'sideways' }))).toEqual({
      ok: false,
      reason: 'missing_field',
    });
    expect(interpret(visionJson({ disease_name: '' }))).toEqual({
      ok: false,
      reason: 'missing_field',
    });
  });
});

/* ========================================================================== */
/* Requirement 5.5, and the documented tie-break                               */
/* ========================================================================== */

describe('interpret — a present, well-typed severity outside the four values is invalid_severity', () => {
  for (const severity of ['catastrophic', 'severe', 'mild', 'NONE', '']) {
    it(`attributes severity ${JSON.stringify(severity)} to invalid_severity`, () => {
      expect(interpret(visionJson({ severity }))).toEqual({
        ok: false,
        reason: 'invalid_severity',
      });
    });
  }

  it('accepts each of the four defined Severity_Values', () => {
    for (const severity of severitySchema.options) {
      expect(interpret(visionJson({ severity })).ok).toBe(true);
    }
  });

  it('attributes a response failing both 5.5 and 5.4 to its severity, so the audit is deterministic', () => {
    // One reason has to win, and `stage1Reason` states which. Pinned because "whichever Zod
    // reported first" is not a contract.
    expect(interpret(visionJson({ severity: 'catastrophic', confidence: 1.1 }))).toEqual({
      ok: false,
      reason: 'invalid_severity',
    });
  });
});

/* ========================================================================== */
/* Requirement 5.4 — the interval is CLOSED at both ends                       */
/* ========================================================================== */

describe('confidence sits in the closed interval 0 to 1', () => {
  it('rejects -0.1 and 1.1 and accepts 0 and 1 (Requirement 5.4)', () => {
    expect(interpret(visionJson({ confidence: -0.1 }))).toEqual({
      ok: false,
      reason: 'confidence_out_of_range',
    });
    expect(interpret(visionJson({ confidence: 1.1 }))).toEqual({
      ok: false,
      reason: 'confidence_out_of_range',
    });

    // `0` and `1` are VALID: an interval read as open here would refuse a model that was certain, or
    // one that reported it had nothing, and record the refusal as the model's fault.
    for (const confidence of [0, 1]) {
      expect(interpret(visionJson({ confidence }))).toEqual({
        ok: true,
        verified: {
          status: 'identified',
          disease_name: IN_KNOWLEDGE_BASE,
          confidence,
          severity: 'moderate',
        },
      });
    }
  });

  it('is the schema’s own rule, not the service’s', () => {
    // Asserted on `visionRawSchema` directly so the boundary cannot drift into the caller.
    const at = (confidence: number): boolean =>
      visionRawSchema.safeParse({
        status: 'identified',
        disease_name: IN_KNOWLEDGE_BASE,
        confidence,
        severity: 'moderate',
      }).success;

    expect([at(-0.1), at(0), at(1), at(1.1)]).toEqual([false, true, true, false]);
  });
});

/* ========================================================================== */
/* Requirement 5.6 — the safety gate                                           */
/* ========================================================================== */

describe('interpret — the knowledge-base membership gate', () => {
  it('accepts each of the five verified conditions', () => {
    for (const name of VERIFIED_CONDITIONS) {
      expect(interpret(visionJson({ disease_name: name })).ok).toBe(true);
    }
  });

  for (const name of ['Wheat Rust', 'Rice Bacterial Wilt', 'tomato early blight', 'Tomato Blight']) {
    it(`refuses the out-of-knowledge-base name ${JSON.stringify(name)}`, () => {
      // `tomato early blight` is in the list only if capitalisation is ignored, and it is not: the
      // five names are matched character for character by the schema and by two SQL constraints.
      expect(interpret(visionJson({ disease_name: name }))).toEqual({
        ok: false,
        reason: 'unverified_condition',
      });
    });
  }

  it('refuses an identified response that names nothing at all', () => {
    expect(interpret(visionJson({ disease_name: null }))).toEqual({
      ok: false,
      reason: 'unverified_condition',
    });
  });

  it('leaves disease_name a free string when the status is not identified (D2)', () => {
    // Stage 2 never runs for a model-reported status, which is the whole point of splitting
    // validation in two: an unsupported name and an unjudgeable photo are different events.
    expect(interpret(visionJson({ status: 'unclear', disease_name: 'Wheat Rust' }))).toEqual({
      ok: false,
      reason: 'model_unclear',
    });
    expect(interpret(visionJson({ status: 'no_plant', disease_name: null }))).toEqual({
      ok: false,
      reason: 'model_no_plant',
    });
  });
});

/* ========================================================================== */
/* Requirement 6.5 — a COMPILE-TIME claim, asserted as one                     */
/* ========================================================================== */

/**
 * Requirement 6.5 is not a runtime rule. It says an Inconclusive_Result *cannot carry* a candidate
 * disease name or treatment content, and `inconclusiveResultSchema` makes that structural by pinning
 * `diseaseName`, `confidence` and `knowledge` to `null` rather than making them optional.
 *
 * `knowledge: null` is the load-bearing one: because it is `null` and not an empty payload, no screen
 * can render treatment text for an inconclusive result — `result.knowledge.treatment` does not
 * typecheck. So the honest assertion is a **compile** error, and `@ts-expect-error` is how a test
 * makes one. Each directive below fails `npm run typecheck` in *both* directions: it fails if the
 * illegal construction stops erroring (TypeScript reports an unused directive), and it fails if the
 * legal construction beside it starts erroring.
 *
 * A `safeParse` rejection would prove something weaker and later — that a value already built wrong
 * is caught at a boundary — where the point of 6.5 is that it cannot be built. The runtime check is
 * still worth one line, because the same shape is enforced a third time by the
 * `diagnoses_unknown_shape` constraint and the three must agree.
 */

const asInconclusive = (result: InconclusiveResult): InconclusiveResult => result;

const LEGAL_INCONCLUSIVE: InconclusiveResult = {
  status: 'unknown',
  diseaseName: null,
  confidence: null,
  severity: 'none',
  explanation: 'Jamee could not read this photo. Please consult an agricultural expert.',
  knowledge: null,
  needsExpert: true,
  language: 'en',
};

describe('Requirement 6.5 — the inconclusive branch cannot be constructed with a name or knowledge', () => {
  it('accepts the one legal shape', () => {
    expect(asInconclusive(LEGAL_INCONCLUSIVE)).toEqual(LEGAL_INCONCLUSIVE);
    expect(inconclusiveResultSchema.safeParse(LEGAL_INCONCLUSIVE).success).toBe(true);
  });

  it('does not typecheck with a non-null knowledge payload', () => {
    const illegal = asInconclusive({
      ...LEGAL_INCONCLUSIVE,
      // @ts-expect-error Requirement 6.5 — `knowledge` is pinned to `null`, so no treatment content
      // can be attached to an inconclusive result. If this line ever compiles, a screen can render
      // treatment text for a photo Jamee could not judge.
      knowledge: {
        symptoms: ['dark concentric lesions'],
        causes: ['Alternaria solani'],
        treatment: ['apply a copper-based fungicide'],
        prevention: ['rotate crops'],
        source: 'extension bulletin',
      },
    });

    // The schema agrees at runtime, which is the boundary the SQL constraint mirrors.
    expect(inconclusiveResultSchema.safeParse(illegal).success).toBe(false);
  });

  it('does not typecheck with a non-null disease name', () => {
    const illegal = asInconclusive({
      ...LEGAL_INCONCLUSIVE,
      // @ts-expect-error Requirement 6.5 — `diseaseName` is pinned to `null`, so the rejected
      // model's candidate name has nowhere to be carried in a weaker form.
      diseaseName: 'Tomato Early Blight',
    });

    expect(inconclusiveResultSchema.safeParse(illegal).success).toBe(false);
  });

  it('does not typecheck with a non-null confidence', () => {
    const illegal = asInconclusive({
      ...LEGAL_INCONCLUSIVE,
      // @ts-expect-error Requirement 6.5 — the rejected model's confidence is discarded, not
      // downgraded. A number here would let a farmer read a percentage off a refused response.
      confidence: 0.94,
    });

    expect(inconclusiveResultSchema.safeParse(illegal).success).toBe(false);
  });
});
