import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  REJECTION_REASONS,
  VERIFIED_CONDITIONS,
  severitySchema,
  type RejectionReason,
} from '@/lib/schemas';
import { interpret } from '@/services/diagnosis.service';

/**
 * **Property 6: Model output validation accepts exactly the well-formed, in-knowledge-base
 * responses.**
 *
 * > For any provider response string, the validation layer accepts it if and only if it parses as
 * > JSON, contains every required field of the diagnosis schema, carries a confidence value within
 * > the closed interval 0 to 1, carries a severity within the defined severity values, and — when
 * > its status is identified — names one of the five verified conditions; nothing rejected is ever
 * > persisted or returned to a caller.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6**
 *
 * =============================================================================
 * WHERE THE VALIDATION LAYER IS, AND WHY THIS FILE REACHES FOR IT
 * =============================================================================
 *
 * The property is stated over a *string*, so it has to be driven at the one function that turns
 * provider text into a verdict: `interpret()` in `src/services/diagnosis.service.ts`. That function
 * is nothing but the composition of the two stages `src/lib/schemas.ts` owns — `visionRawSchema`
 * (shape, ranges, severity vocabulary) then `visionVerifiedSchema` (knowledge-base membership, D2) —
 * around a `JSON.parse`. Driving the schemas directly would test everything except the parse and the
 * staging, which is where two of the six criteria live (5.2 and 5.6).
 *
 * It is provider-agnostic by construction: there is one `interpret`, it takes text and nothing else,
 * so "every Primary_Model and Fallback_Model response" (5.1) is one code path rather than two that
 * have to be checked for agreement.
 *
 * =============================================================================
 * WHAT "ACCEPTS" MEANS HERE — THE ONE READING THAT MAKES THE PROPERTY TRUE
 * =============================================================================
 *
 * `interpret` returns `{ ok: true, verified }` or `{ ok: false, reason }`, and the `false` branch
 * carries **two kinds of reason** that the property is careful to keep apart:
 *
 *  - **Five validation verdicts** (`not_json`, `missing_field`, `confidence_out_of_range`,
 *    `invalid_severity`, `unverified_condition`) — one per Requirement 5.2–5.6. These are the
 *    layer *refusing* a response.
 *  - **Two model-reported statuses** (`model_unclear`, `model_no_plant`) — Requirements 6.2 and 6.3,
 *    the model answering honestly that it cannot judge the photo. `diagnosis.service.ts` says so in
 *    its own words: these "are not failures … they arrive as a *valid* stage-1 parse".
 *
 * So a well-formed `{"status":"unclear",…}` response satisfies every clause the property lists (the
 * knowledge-base clause is conditioned on `status` being `identified`) and is *validated*, while
 * still not producing an identified diagnosis. This file therefore reads "accepts" as the validation
 * verdict — the response passed the schema gates — and asserts, as separate halves of the same
 * biconditional, that a validated response is either identified-and-verified or the model's own
 * non-identified status, never a validation rejection.
 *
 * Reading "accepts" as `ok === true` instead would make the property false for every honest
 * `unclear` response, which is a conflict between two design sentences rather than a defect: it is
 * reported alongside this task rather than papered over.
 *
 * =============================================================================
 * HOW THE BICONDITIONAL IS ASSERTED
 * =============================================================================
 *
 * `specVerdict()` below is an **independent oracle**: it re-derives the verdict from the acceptance
 * criteria and the documented reason precedence, reading the parsed payload directly rather than
 * calling any schema. Nothing in it imports the code under test, so agreement between the two is
 * evidence rather than a tautology.
 *
 * Attributability of the reason is asserted here per criterion. The property itself claims a
 * verdict, not a label, and Requirement 5.7's audit trail is Property 7's job (task 11.6), but
 * `stage1Reason`'s documented precedence and its behaviour agree on every criterion, so the reason
 * is pinned throughout.
 *
 * The one disagreement this file found — an absent or wrong-typed `severity` labelled
 * `invalid_severity` rather than `missing_field` — is fixed: `stage1Reason` in
 * `src/services/diagnosis.service.ts` now decides its rule 1 from the parsed payload via
 * `CARRIES_JSON_TYPE_OF`, instead of looking for a Zod `invalid_type` issue code that a `z.enum`
 * never produces.
 */

/* ========================================================================== */
/* The vocabularies the property is stated over                                */
/* ========================================================================== */

const SEVERITY_VALUES: readonly string[] = severitySchema.options;

const VISION_STATUSES = ['identified', 'unclear', 'no_plant'] as const;
type VisionStatus = (typeof VISION_STATUSES)[number];

/** The four keys Requirement 5.3 calls "every required field of the diagnosis schema". */
const REQUIRED_FIELDS = ['status', 'disease_name', 'confidence', 'severity'] as const;
type RequiredField = (typeof REQUIRED_FIELDS)[number];

/** Requirements 5.2–5.6: the reasons that are the validation layer refusing a response. */
const VALIDATION_REJECTIONS = [
  'not_json', //                5.2
  'missing_field', //           5.3
  'confidence_out_of_range', // 5.4
  'invalid_severity', //        5.5
  'unverified_condition', //    5.6
] as const satisfies readonly RejectionReason[];

type ValidationRejection = (typeof VALIDATION_REJECTIONS)[number];

/** Requirements 6.2, 6.3: the model reporting honestly. A valid parse, not a refusal. */
const MODEL_REPORTED: Readonly<Record<Exclude<VisionStatus, 'identified'>, RejectionReason>> = {
  unclear: 'model_unclear',
  no_plant: 'model_no_plant',
};

/* ========================================================================== */
/* The oracle: the six criteria, restated over a parsed payload                 */
/* ========================================================================== */

type SpecVerdict =
  | { readonly validated: true; readonly status: VisionStatus }
  | { readonly validated: false; readonly reason: ValidationRejection };

const isVisionStatus = (value: string): value is VisionStatus =>
  (VISION_STATUSES as readonly string[]).includes(value);

const isVerifiedCondition = (value: string): boolean =>
  (VERIFIED_CONDITIONS as readonly string[]).includes(value);

/**
 * What Requirements 5.2–5.6 say about one response string, decided without the code under test.
 *
 * The order of the checks is the documented reason precedence, not a preference:
 *
 *  1. Not parseable → `not_json` (5.2).
 *  2. Not the diagnosis object at all, or a required field absent or of the wrong type →
 *     `missing_field` (5.3). A response that omitted `severity` supplied no severity *value* to be
 *     outside the vocabulary, so calling that `invalid_severity` would misattribute it. This rule is
 *     stated as the requirements state it, and `stage1Reason` now agrees with it on all four fields
 *     (see the header), so the absent-`severity` reason is pinned like every other criterion's.
 *  3. A severity outside the four values → `invalid_severity` (5.5).
 *  4. A confidence outside the closed interval → `confidence_out_of_range` (5.4). A response
 *     failing both 3 and 4 is attributed to its severity; one reason has to win.
 *  5. A `status` outside the three values, or an empty `disease_name`: present, unusable, and no
 *     value-specific reason exists for either, so both land on `missing_field` (5.3).
 *  6. `identified` without one of the five verified conditions → `unverified_condition` (5.6). This
 *     is the safety gate, and `null` fails it too.
 */
function specVerdict(raw: string): SpecVerdict {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return { validated: false, reason: 'not_json' };
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { validated: false, reason: 'missing_field' };
  }

  const record = payload as Record<string, unknown>;
  const status = record['status'];
  const name = record['disease_name'];
  const confidence = record['confidence'];
  const severity = record['severity'];

  if (typeof status !== 'string') return { validated: false, reason: 'missing_field' };
  if (name !== null && typeof name !== 'string') {
    return { validated: false, reason: 'missing_field' };
  }
  if (typeof confidence !== 'number') return { validated: false, reason: 'missing_field' };
  if (typeof severity !== 'string') return { validated: false, reason: 'missing_field' };

  if (!SEVERITY_VALUES.includes(severity)) {
    return { validated: false, reason: 'invalid_severity' };
  }
  if (!(confidence >= 0 && confidence <= 1)) {
    return { validated: false, reason: 'confidence_out_of_range' };
  }
  if (!isVisionStatus(status)) return { validated: false, reason: 'missing_field' };
  if (name !== null && name.length === 0) return { validated: false, reason: 'missing_field' };

  if (status === 'identified' && (name === null || !isVerifiedCondition(name))) {
    return { validated: false, reason: 'unverified_condition' };
  }

  return { validated: true, status };
}

/* ========================================================================== */
/* Arbitraries — constrained to the space where the criteria differ             */
/* ========================================================================== */

const verifiedCondition = fc.constantFrom(...VERIFIED_CONDITIONS);
const severityValue = fc.constantFrom(...severitySchema.options);
const nonIdentifiedStatus = fc.constantFrom('unclear', 'no_plant');

/** Requirement 5.4's interval is CLOSED, so both ends appear by construction, not by luck. */
const inRangeConfidence = fc.oneof(
  { weight: 3, arbitrary: fc.double({ min: 0, max: 1, noNaN: true }) },
  { weight: 1, arbitrary: fc.constantFrom(0, 1) },
);

const outOfRangeConfidence = fc
  .oneof(
    fc.double({ min: -1_000, max: 0, maxExcluded: true, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 1, max: 1_000, minExcluded: true, noNaN: true, noDefaultInfinity: true }),
    /** The two nearest representable misses, which a coarse generator would never land on. */
    fc.constantFrom(-Number.MIN_VALUE, 1 + Number.EPSILON),
  )
  /**
   * `maxExcluded` on `max: 0` yields **negative zero**, and `-0` is not out of range: `-0 >= 0` is
   * true, and JSON has no signed zero on the wire anyway (`JSON.stringify(-0) === '0'`). Excluding
   * it here keeps the arbitrary honest about what it claims to generate.
   */
  .filter((value) => !(value >= 0 && value <= 1));

/**
 * A name outside the five, weighted towards **real-looking** conditions.
 *
 * A garbage string is the easy case; `Wheat Rust` is the case Requirement 5.6 exists for — a real
 * condition, well-formed and confidently reported, that Jamee has no verified content for.
 */
const outOfKnowledgeBaseName = fc
  .oneof(
    {
      weight: 3,
      arbitrary: fc
        .tuple(
          fc.constantFrom('Wheat', 'Rice', 'Cotton', 'Maize', 'Banana', 'Tomato', 'Potato'),
          fc.constantFrom('Rust', 'Mosaic Virus', 'Bacterial Wilt', 'Powdery Mildew', 'Blight'),
        )
        .map(([crop, condition]) => `${crop} ${condition}`),
    },
    { weight: 1, arbitrary: fc.string({ minLength: 1 }) },
  )
  .filter((name) => !isVerifiedCondition(name));

const notASeverityValue = fc
  .oneof(
    { weight: 3, arbitrary: fc.constantFrom('catastrophic', 'severe', 'mild', 'NONE', 'None', '') },
    { weight: 1, arbitrary: fc.string() },
  )
  .filter((value) => !SEVERITY_VALUES.includes(value));

/** JSON values that are not a string, not a number, and not `null`. */
const neitherStringNorNumber = fc.oneof(
  fc.boolean(),
  fc.array(fc.string(), { maxLength: 2 }),
  fc.record({ nested: fc.string() }),
);

/** A value of the wrong JSON type for `field`, so the parse fails on its *type* (5.3). */
const wrongTypeFor = (field: RequiredField): fc.Arbitrary<unknown> => {
  switch (field) {
    /** `confidence` is the number; anything else, `null` included, is the wrong type. */
    case 'confidence':
      return fc.oneof(neitherStringNorNumber, fc.string(), fc.constant(null));
    /** `disease_name` is nullable, so `null` is NOT a wrong type for it — only a non-string is. */
    case 'disease_name':
      return fc.oneof(neitherStringNorNumber, fc.integer());
    default:
      return fc.oneof(neitherStringNorNumber, fc.integer(), fc.constant(null));
  }
};

const objectOf = (
  status: unknown,
  name: unknown,
  confidence: unknown,
  severity: unknown,
): Record<string, unknown> => ({
  status,
  disease_name: name,
  confidence,
  severity,
});

/** Well formed, identified, in the knowledge base: the one shape that must be accepted. */
const acceptablePayload = fc
  .tuple(verifiedCondition, inRangeConfidence, severityValue)
  .map(([name, confidence, severity]) => objectOf('identified', name, confidence, severity));

/**
 * Well formed and non-identified. `disease_name` is a free string at stage 1 (D2), and stage 2 never
 * runs, so anything goes in it — which is exactly what the property's `identified`-only condition
 * means.
 */
const modelReportedPayload = fc
  .tuple(
    nonIdentifiedStatus,
    fc.oneof(fc.constant(null), fc.string({ minLength: 1 })),
    inRangeConfidence,
    severityValue,
  )
  .map(([status, name, confidence, severity]) => objectOf(status, name, confidence, severity));

const wellFormedPayload = fc.oneof(acceptablePayload, modelReportedPayload);

const jsonOf = (payload: unknown): string => JSON.stringify(payload);

const parses = (raw: string): boolean => {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
};

const notJsonResponse = fc.oneof(
  /** Prose — what a model that ignored its response contract actually returns. */
  { weight: 2, arbitrary: fc.string({ minLength: 1 }).filter((raw) => !parses(raw)) },
  /**
   * A fenced block wrapping valid JSON. Still `not_json`: unwrapping it locally would be Jamee
   * repairing the model's output on its behalf, which D4 forbids.
   */
  { weight: 1, arbitrary: acceptablePayload.map((p) => `\`\`\`json\n${jsonOf(p)}\n\`\`\``) },
  /** A truncated object — the interrupted-stream failure. */
  { weight: 1, arbitrary: acceptablePayload.map((p) => jsonOf(p).slice(0, -1)) },
);

const withoutField = (payload: Record<string, unknown>, field: string): Record<string, unknown> => {
  const copy = { ...payload };
  delete copy[field];
  return copy;
};

const missingFieldPayload = (
  fields: readonly RequiredField[],
): fc.Arbitrary<Record<string, unknown>> =>
  fc
    .tuple(wellFormedPayload, fc.constantFrom(...fields))
    .map(([payload, field]) => withoutField(payload, field));

const wrongTypePayload = (
  fields: readonly RequiredField[],
): fc.Arbitrary<Record<string, unknown>> =>
  fc
    .constantFrom(...fields)
    .chain((field) =>
      fc
        .tuple(wellFormedPayload, wrongTypeFor(field))
        .map(([payload, value]) => ({ ...payload, [field]: value })),
    );

const outOfRangeConfidencePayload = fc
  .tuple(wellFormedPayload, outOfRangeConfidence)
  .map(([payload, confidence]) => ({ ...payload, confidence }));

const invalidSeverityPayload = fc
  .tuple(wellFormedPayload, notASeverityValue)
  .map(([payload, severity]) => ({ ...payload, severity }));

const unverifiedConditionPayload = fc
  .tuple(
    fc.oneof(outOfKnowledgeBaseName, fc.constant(null)),
    inRangeConfidence,
    severityValue,
  )
  .map(([name, confidence, severity]) => objectOf('identified', name, confidence, severity));

/**
 * Every field drawn from a mix of valid and invalid values, every key independently optional.
 *
 * This is the generator that makes the *only if* half real: it produces the near misses — a good
 * severity with a bad confidence, a status outside the three with everything else right, one key
 * absent — where a validation layer that checked the wrong thing would still look correct against
 * the clean fixtures above.
 */
const nearMissPayload = fc
  .record(
    {
      status: fc.oneof(
        { weight: 4, arbitrary: fc.constantFrom(...VISION_STATUSES) },
        { weight: 1, arbitrary: fc.string() },
        { weight: 1, arbitrary: wrongTypeFor('status') },
      ),
      disease_name: fc.oneof(
        { weight: 3, arbitrary: verifiedCondition },
        { weight: 2, arbitrary: fc.constant(null) },
        { weight: 2, arbitrary: outOfKnowledgeBaseName },
        { weight: 1, arbitrary: fc.constant('') },
        { weight: 1, arbitrary: wrongTypeFor('disease_name') },
      ),
      confidence: fc.oneof(
        { weight: 4, arbitrary: inRangeConfidence },
        { weight: 2, arbitrary: outOfRangeConfidence },
        /** An integer lands both in and out of range, and is the right type either way. */
        { weight: 1, arbitrary: fc.integer({ min: -3, max: 3 }) },
        { weight: 1, arbitrary: wrongTypeFor('confidence') },
      ),
      severity: fc.oneof(
        { weight: 4, arbitrary: severityValue },
        { weight: 2, arbitrary: notASeverityValue },
        { weight: 1, arbitrary: wrongTypeFor('severity') },
      ),
    },
    { requiredKeys: [] },
  )
  .map((partial): Record<string, unknown> => ({ ...partial }));

/** Any provider response string at all — the property's domain. */
const anyResponse = fc.oneof(
  { weight: 6, arbitrary: nearMissPayload.map(jsonOf) },
  { weight: 3, arbitrary: acceptablePayload.map(jsonOf) },
  { weight: 2, arbitrary: modelReportedPayload.map(jsonOf) },
  { weight: 2, arbitrary: unverifiedConditionPayload.map(jsonOf) },
  { weight: 2, arbitrary: missingFieldPayload(REQUIRED_FIELDS).map(jsonOf) },
  { weight: 2, arbitrary: wrongTypePayload(REQUIRED_FIELDS).map(jsonOf) },
  { weight: 2, arbitrary: outOfRangeConfidencePayload.map(jsonOf) },
  { weight: 2, arbitrary: invalidSeverityPayload.map(jsonOf) },
  { weight: 3, arbitrary: notJsonResponse },
  /** Arbitrary JSON: scalars, arrays and objects that are not a diagnosis at all. */
  { weight: 2, arbitrary: fc.jsonValue().map(jsonOf) },
  /** Arbitrary text, unfiltered — a superset of the prose case, kept honest. */
  { weight: 1, arbitrary: fc.string() },
);

/* ========================================================================== */
/* The property                                                                */
/* ========================================================================== */

describe('Property 6 — model output validation accepts exactly the well-formed, in-knowledge-base responses', () => {
  it('draws every rejection from one closed vocabulary, partitioned into refusals and model reports', () => {
    // The seven reasons are the five validation verdicts plus the two honest statuses, with no
    // overlap and nothing left over. Everything below leans on that partition.
    expect([...REJECTION_REASONS].sort()).toEqual(
      [...VALIDATION_REJECTIONS, ...Object.values(MODEL_REPORTED)].sort(),
    );
    expect(new Set(REJECTION_REASONS).size).toBe(REJECTION_REASONS.length);
  });

  it('generates every outcome the biconditional has to separate, so neither half of it is vacuous', () => {
    // A generator that drifted into producing only refusable responses would leave the *if* half
    // untested and still report green. The seed is fixed so this stays a statement about the
    // arbitraries rather than a coin toss.
    const outcomes = fc
      .sample(anyResponse, { numRuns: 1_000, seed: 6 })
      .map((raw) => interpret(raw))
      .map((verdict) => (verdict.ok ? 'accepted' : verdict.reason));

    for (const outcome of ['accepted', ...REJECTION_REASONS]) {
      expect(outcomes, `no sample produced ${outcome}`).toContain(outcome);
    }
  });

  it('accepts a response if and only if it meets all six criteria, and refuses everything else with a validation reason', () => {
    fc.assert(
      fc.property(anyResponse, (raw) => {
        const expected = specVerdict(raw);
        const actual = interpret(raw);

        if (!expected.validated) {
          // The *only if* half: a response failing any one criterion is refused, and the refusal
          // carries one of the five reasons Requirements 5.2–5.6 own — never a model-reported
          // status, which would claim the model answered honestly about a photo it never judged.
          expect(actual.ok).toBe(false);
          if (actual.ok) return;
          expect(VALIDATION_REJECTIONS).toContain(actual.reason);

          // Two of the five are decided by a *stage boundary* rather than by `stage1Reason`'s
          // tie-breaking over schema issues, so which one it is follows from the response alone and
          // is pinned here. The other three are pinned per criterion below.
          if (expected.reason === 'not_json' || expected.reason === 'unverified_condition') {
            expect(actual.reason).toBe(expected.reason);
          }
          return;
        }

        if (expected.status !== 'identified') {
          // Validated, but the model itself reported it could not judge the photo. Not a refusal:
          // the reason is its own status, never one of the five validation verdicts.
          expect(actual).toEqual({ ok: false, reason: MODEL_REPORTED[expected.status] });
          return;
        }

        // The *if* half: well formed, identified, in the knowledge base → accepted, and what comes
        // out is the response's own four fields, unchanged (Requirement 5.1).
        expect(actual.ok).toBe(true);
        if (!actual.ok) return;

        const payload = JSON.parse(raw) as Record<string, unknown>;
        expect(actual.verified).toEqual({
          status: 'identified',
          disease_name: payload['disease_name'],
          confidence: payload['confidence'],
          severity: payload['severity'],
        });
      }),
      { numRuns: 1_000 },
    );
  });

  it('carries exactly the four validated fields out of the layer, dropping anything else the provider sent', () => {
    // Requirement 5.1 — what is persisted or returned is the *parsed* value, not the response.
    // Extra keys are a provider habit, not a rejection cause, and none of them may survive.
    const extraKeys = fc.dictionary(
      fc.string({ minLength: 1 }).filter((key) => !(REQUIRED_FIELDS as readonly string[]).includes(key)),
      fc.jsonValue(),
      { maxKeys: 3 },
    );

    fc.assert(
      fc.property(acceptablePayload, extraKeys, (payload, extras) => {
        const actual = interpret(jsonOf({ ...extras, ...payload }));

        expect(actual.ok).toBe(true);
        if (!actual.ok) return;
        expect(Object.keys(actual.verified).sort()).toEqual([...REQUIRED_FIELDS].sort());
      }),
      { numRuns: 300 },
    );
  });

  it('treats the confidence interval as closed at both ends, and the nearest miss on either side as out of range', () => {
    fc.assert(
      fc.property(verifiedCondition, severityValue, (name, severity) => {
        for (const confidence of [0, 1]) {
          expect(interpret(jsonOf(objectOf('identified', name, confidence, severity)))).toEqual({
            ok: true,
            verified: { status: 'identified', disease_name: name, confidence, severity },
          });
        }

        for (const confidence of [-Number.MIN_VALUE, 1 + Number.EPSILON]) {
          expect(interpret(jsonOf(objectOf('identified', name, confidence, severity)))).toEqual({
            ok: false,
            reason: 'confidence_out_of_range',
          });
        }
      }),
      { numRuns: 200 },
    );
  });

  it('returns nothing but a reason when it refuses, so no rejected content can be persisted or returned', () => {
    fc.assert(
      fc.property(anyResponse, (raw) => {
        const actual = interpret(raw);
        if (actual.ok) return;

        // The whole refusal value is one of seven fixed shapes. There is no field for the rejected
        // name, confidence or prose to travel in — the discard is structural, not remembered.
        expect(JSON.stringify(actual)).toBe(JSON.stringify({ ok: false, reason: actual.reason }));
        expect(REJECTION_REASONS).toContain(actual.reason);
      }),
      { numRuns: 500 },
    );
  });
});

/* ========================================================================== */
/* Each criterion, driven on its own so the reason is pinned                    */
/* ========================================================================== */

interface CriterionCase {
  readonly criterion: string;
  readonly payloads: fc.Arbitrary<string>;
  readonly reason: ValidationRejection;
}

/**
 * The fields whose absence or wrong type the layer attributes to Requirement 5.3. All four of them:
 * `severity` joined the other three when `stage1Reason`'s rule 1 moved onto the parsed payload.
 */
const UNAMBIGUOUS_SHAPE_FIELDS = ['status', 'disease_name', 'confidence', 'severity'] as const;

const CRITERION_CASES: readonly CriterionCase[] = [
  {
    criterion: '5.2 — a response that is not parseable JSON',
    payloads: notJsonResponse,
    reason: 'not_json',
  },
  {
    criterion: '5.3 — a required field of the diagnosis schema is absent',
    payloads: missingFieldPayload(UNAMBIGUOUS_SHAPE_FIELDS).map(jsonOf),
    reason: 'missing_field',
  },
  {
    criterion: '5.3 — a required field is present with the wrong type',
    payloads: wrongTypePayload(UNAMBIGUOUS_SHAPE_FIELDS).map(jsonOf),
    reason: 'missing_field',
  },
  {
    criterion: '5.4 — confidence outside the closed interval 0 to 1',
    payloads: outOfRangeConfidencePayload.map(jsonOf),
    reason: 'confidence_out_of_range',
  },
  {
    criterion: '5.5 — a severity value outside the four defined values',
    payloads: invalidSeverityPayload.map(jsonOf),
    reason: 'invalid_severity',
  },
  {
    criterion: '5.6 — an identified response naming a condition outside the five',
    payloads: unverifiedConditionPayload.map(jsonOf),
    reason: 'unverified_condition',
  },
];

describe('Property 6 — each criterion refuses on its own, with its own reason', () => {
  for (const testCase of CRITERION_CASES) {
    it(`refuses ${testCase.criterion} as ${testCase.reason}`, () => {
      fc.assert(
        fc.property(testCase.payloads, (raw) => {
          expect(interpret(raw)).toEqual({ ok: false, reason: testCase.reason });
        }),
        { numRuns: 300 },
      );
    });
  }

  /**
   * An absent or wrong-typed `severity` is `missing_field`, pinned now that `stage1Reason`'s rule 1
   * reads the parsed payload (`CARRIES_JSON_TYPE_OF` in `src/services/diagnosis.service.ts`) rather
   * than a Zod `invalid_type` issue code, which a `z.enum` never produces.
   */
  it('refuses 5.3 — an absent or wrong-typed severity as missing_field', () => {
    fc.assert(
      fc.property(
        fc.oneof(missingFieldPayload(['severity']), wrongTypePayload(['severity'])).map(jsonOf),
        (raw) => {
          const actual = interpret(raw);

          expect(actual.ok).toBe(false);
          if (actual.ok) return;
          expect(actual.reason).toBe('missing_field');
        },
      ),
      { numRuns: 300 },
    );
  });
});
