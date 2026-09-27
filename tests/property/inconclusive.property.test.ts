import { Buffer } from 'node:buffer';

import * as fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ProviderFailure } from '@/lib/ai/errors';
import type { CapabilityRunner, TextCall, VisionCall } from '@/lib/ai/capabilities';
import { run, type AdapterSet } from '@/lib/ai/gateway';
import type { DiagnosisInsert } from '@/lib/db/analysis';
import type { UsageLogInsert } from '@/lib/db/usage-log';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import {
  HEALTHY_CONDITION,
  VERIFIED_CONDITIONS,
  inconclusiveResultSchema,
  type Channel,
  type Language,
  type MediaRef,
  type RejectionReason,
  type Severity,
  type VerifiedCondition,
} from '@/lib/schemas';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import { diagnose, type DiagnosisDeps, type DiagnosisStore } from '@/services/diagnosis.service';
import type { CounterRpc } from '@/services/quota.service';

/**
 * ### Property 8: All non-identified outcomes collapse into one inconclusive shape
 *
 * > *"For any cause of a non-identified diagnosis — an out-of-knowledge-base condition name, an
 * > unclear image, an image with no plant, or a response that fails schema validation — the result
 * > has status `unknown`, `needs_expert` true, a null disease name, no knowledge payload, severity
 * > `none`, an explanation recommending an agricultural expert, and no treatment sentence from any
 * > knowledge base row."*
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**
 *
 * ### Property 9: An inconclusive result costs exactly one unit and no extra model call
 *
 * > *"For any request that yields an inconclusive result, exactly one image-analysis unit is added
 * > to the farmer's daily counter, exactly one classification attempt is made, and no model call is
 * > issued after the result is determined inconclusive. A transport-level fallback retry of that
 * > single attempt (Requirement 14.4) is the one permitted second invocation, and it never re-asks
 * > the model for different content."*
 *
 * **Validates: Requirements 6.6, 6.7**
 *
 * =============================================================================
 * THE TWELVE WAYS TO REACH THE INCONCLUSIVE SHAPE, ENUMERATED FROM THE CODE
 * =============================================================================
 *
 * Property 8 is a claim about a *set* of causes, so the set is written down and the run proves it
 * generated every member (`PATH_KINDS`, asserted after `fc.assert`). Read off `interpret()` and the
 * three `returnInconclusive()` call sites in `diagnosis.service.ts`, the causes are:
 *
 *  | Path | Where it fails | Reason recorded |
 *  | --- | --- | --- |
 *  | `not_json` | `JSON.parse` throws | `not_json` (5.2) |
 *  | `not_the_diagnosis_object` | parses, but is a string / array / number / null | a schema reason (5.3) |
 *  | `absent_required_field` | stage 1, a required key omitted | a schema reason (5.3) |
 *  | `wrong_typed_field` | stage 1, a required key present with the wrong type | a schema reason (5.3) |
 *  | `status_outside_vocabulary` | stage 1, `status` outside the three values | a schema reason |
 *  | `confidence_out_of_range` | stage 1, outside the closed interval | a schema reason (5.4) |
 *  | `severity_outside_vocabulary` | stage 1, outside the four values | a schema reason (5.5) |
 *  | `unverified_condition_name` | stage 2, a real name outside the five | `unverified_condition` (5.6 → 6.1) |
 *  | `identified_without_a_name` | stage 2, `identified` with `disease_name: null` | `unverified_condition` |
 *  | `knowledge_row_absent` | both stages pass, the row is not seeded | `unverified_condition` |
 *  | `model_reported_unclear` | no failure — the model said `unclear` | `model_unclear` (6.2) |
 *  | `model_reported_no_plant` | no failure — the model said `no_plant` | `model_no_plant` (6.3) |
 *
 * `knowledge_row_absent` is the one the design sentence does not name. It is a real thirteenth-hour
 * path in the code — an unseeded or partially seeded deployment — and it lands on the same shape by
 * the same closure, so it belongs in the enumeration rather than outside it.
 *
 * **A provider failure is deliberately NOT in this set.** Both providers failing raises
 * `PROVIDERS_UNAVAILABLE` and an expired budget raises `DIAGNOSIS_TIMEOUT`; neither returns a
 * result. The design says so directly in the error taxonomy — *"`Inconclusive_Result` is not in this
 * table"* — and Property 8's own enumeration omits it. Treating a provider outage as inconclusive
 * would tell a farmer their photo could not be judged when it was never looked at.
 *
 * =============================================================================
 * ATTRIBUTION IS ASSERTED AS A SET, ON PURPOSE
 * =============================================================================
 *
 * Each path declares the reasons it may be attributed to, and the four stage-1 paths declare all
 * four schema reasons rather than one. That is not laxity: Property 8 is about the shape a farmer
 * receives (6.1–6.5), and *which* schema reason a multi-fault response is logged under is Property
 * 7's subject (task 11.6, Requirement 5.7). The four schema reasons render byte-identical copy in
 * all three languages by design, so a farmer cannot tell them apart either.
 *
 * It also keeps this file honest across a fix that is in flight: an absent or wrongly-typed
 * `severity` is currently attributed to `invalid_severity` where `stage1Reason`'s own rule 1 says it
 * should be `missing_field`. Pinning either spelling here would make this file break on a change it
 * is not about. The explanation assertion is exact regardless — it is compared against
 * `messages(language).inconclusive[reason]` for whichever reason the service reported.
 *
 * =============================================================================
 * WHERE THE STUBS SIT — AND WHY THE GATEWAY IS REAL
 * =============================================================================
 *
 * Every dependency of `diagnose()` is injected, so there is no Supabase stack, no provider, and no
 * clock. Under Amendment A3 the owner-checked media read is the `readMedia` seam (returning
 * `{ bytes, mimeType }` from GridFS), and its call count is one of the tallies below, so a seam that
 * fired the wrong number of times shows up rather than passing silently.
 *
 * The one thing *not* stubbed away is `run()`. The `CapabilityRunner` here is built over the real
 * gateway with two hand-built adapters underneath it, so Property 9's "no extra model call" is
 * counted at **two** levels rather than one:
 *
 *  - **`classify` / `generate`** — the capability seam. One classification, zero rephrases.
 *  - **`invoke` on each adapter** — the transport seam, *inside* the fallback loop. This is the only
 *    place the permitted second invocation of Requirement 14.4 is visible: a stubbed
 *    `CapabilityRunner` hides it, and "exactly one attempt" would then be an assertion about the
 *    stub. Every recorded invocation's input is compared for deep equality, which is the literal
 *    reading of *"it never re-asks the model for different content"* (D4 — no repair re-ask).
 *
 * =============================================================================
 * ONE DISCREPANCY BETWEEN PROPERTY 8'S SENTENCE AND REQUIREMENT 6.3
 * =============================================================================
 *
 * Property 8 asks for *"an explanation recommending an agricultural expert"* on every path.
 * Requirement 6.3 specifies something different for one of them: an image with no plant gets a
 * result that *"asks for a photo of the affected crop"*, and the catalogs implement exactly that —
 * `model_no_plant` names no expert in `en`, `hi` or `mr`.
 *
 * The requirement is the narrower, later statement and the catalogs follow it, so this file asserts
 * the expert recommendation in words on the eleven paths whose copy is specified to carry it, and
 * asserts Requirement 6.3's own clause on `model_no_plant`. `needsExpert === true` — the machine-
 * readable half of the same recommendation, and the one Requirement 6.4 actually names — is asserted
 * on **every** path without exception. Flagged rather than quietly generalized in either direction.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const CONVERSATION_ID = '77777777-7777-4777-8777-777777777777';
const DIAGNOSIS_ID = '88888888-8888-4888-8888-888888888888';

/** A3: the analysis input is a `{ fileId, kind }` Media_Reference, not a bucket/path storage ref. */
const IMAGE_REF: MediaRef = { fileId: 'a'.repeat(24), kind: 'crop-image' };

/** The bytes the owner-checked read yields, and the MIME type stored alongside them. */
const IMAGE_BYTES = Buffer.from('jamee property harness: fake crop-image bytes');
const IMAGE_MIME = 'image/jpeg';

/** 2026-09-15T19:30:00Z is 2026-09-16T01:00 in Asia/Kolkata — the far side of the +05:30 offset. */
const NOW_MS = Date.parse('2026-09-15T19:30:00.000Z');

/**
 * A non-null vision fallback model, so the chain this file exercises has two members whatever
 * `config/verified.ts` currently holds. A placeholder rather than the real identifier: `run()`
 * compares it against `null` and reads nothing else, so pinning today's Preview model id here would
 * make a config edit look like a behaviour change.
 */
const A_CONFIGURED_VISION_FALLBACK = 'stub/vision-fallback';

/**
 * The marker every knowledge-base string below carries.
 *
 * Property 8 ends with *"no treatment sentence from any knowledge base row"*. Asserting the absence
 * of one prefix is a total check over all four arrays of all five rows at once, and it cannot be
 * satisfied by copy that merely happens to differ — any row content reaching the farmer drags the
 * marker with it.
 */
const KB_MARKER = 'kb-';

/** All five rows, so a seeded reader answers every lookup the pipeline could make. */
const KNOWLEDGE_ROWS: readonly KnowledgeEntry[] = VERIFIED_CONDITIONS.map((condition, index) => ({
  id: `9999999${index}-9999-4999-8999-999999999999`,
  disease_name: condition,
  crop: condition.startsWith('Tomato') ? 'tomato' : 'potato',
  scientific_name: null,
  symptoms: [`${KB_MARKER}symptom of ${condition}`],
  causes: [`${KB_MARKER}cause of ${condition}`],
  /** Empty for `Tomato Healthy`, by seed and by the `healthy_has_no_treatment` constraint. */
  treatment: condition === HEALTHY_CONDITION ? [] : [`${KB_MARKER}treatment for ${condition}`],
  prevention: [`${KB_MARKER}prevention for ${condition}`],
  default_severity: 'moderate',
  source: `${KB_MARKER}source for ${condition}`,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}));

/** Every agronomic string the knowledge base holds, flattened. None may reach a farmer here. */
const ALL_KNOWLEDGE_TEXT: readonly string[] = KNOWLEDGE_ROWS.flatMap((row) => [
  ...row.symptoms,
  ...row.causes,
  ...row.treatment,
  ...row.prevention,
  row.source,
]);

/**
 * The expert recommendation, per language, as a substring of the catalog copy.
 *
 * Written out here rather than read from the catalog: comparing
 * `messages(language).inconclusive[reason]` against itself would pass whatever it said.
 */
const EXPERT_PHRASE: Record<Language, string> = {
  en: 'agricultural expert',
  hi: 'कृषि विशेषज्ञ',
  mr: 'कृषी तज्ज्ञ',
};

/** Requirement 6.3's own clause, per language: a photo of the affected crop is what is asked for. */
const CROP_PHOTO_PHRASE: Record<Language, string> = {
  en: 'photo of the affected crop',
  hi: 'प्रभावित फसल की पत्ती की फोटो',
  mr: 'प्रभावित पिकाच्या पानाचा फोटो',
};

/**
 * The four reasons a stage-1 schema failure may be attributed to (Requirements 5.2–5.5).
 *
 * Listed as a set for the reason the header gives: their farmer-facing copy is identical, and which
 * one a multi-fault response earns is Property 7's subject.
 */
const SCHEMA_REASONS: readonly RejectionReason[] = [
  'not_json',
  'missing_field',
  'confidence_out_of_range',
  'invalid_severity',
];

/** Names a model could plausibly return that Jamee holds no verified content for. */
const OUT_OF_KB_NAMES = [
  'Wheat Rust',
  'Rice Blast',
  'Cotton Leaf Curl',
  'Mango Anthracnose',
  'Sugarcane Red Rot',
  'Citrus Greening',
] as const;

/* ========================================================================== */
/* The enumerated paths                                                        */
/* ========================================================================== */

const PATH_KINDS = [
  'not_json',
  'not_the_diagnosis_object',
  'absent_required_field',
  'wrong_typed_field',
  'status_outside_vocabulary',
  'confidence_out_of_range',
  'severity_outside_vocabulary',
  'unverified_condition_name',
  'identified_without_a_name',
  'knowledge_row_absent',
  'model_reported_unclear',
  'model_reported_no_plant',
] as const;

type PathKind = (typeof PATH_KINDS)[number];

interface InconclusivePath {
  readonly kind: PathKind;
  /** Names itself, so a shrunk counterexample is readable without decoding the payload. */
  readonly label: string;
  /** Exactly what the classification call answers with. */
  readonly classificationText: string;
  /** False only for the unseeded-deployment path. */
  readonly knowledgeSeeded: boolean;
  /** The reasons this path may be attributed to. */
  readonly reasons: readonly RejectionReason[];
  /**
   * Text that must not appear in the explanation, compared case-insensitively.
   *
   * Only names the model *guessed* go here. The five canonical names are checked separately and
   * case-sensitively, because the `unverified_condition` copy states Jamee's coverage in lowercase
   * prose (`"tomato and potato early blight and late blight"`) — a case-insensitive probe would
   * report Jamee's own coverage statement as an echo of the model's guess.
   */
  readonly echoLoose: readonly string[];
  /** Whether the copy is specified to recommend an expert in words. False only for 6.3's path. */
  readonly expertInWords: boolean;
  /** How many defect lines the service is expected to log. One only for the unseeded path. */
  readonly expectedDefectLogs: number;
}

/** Defaults every path shares, so each arbitrary below states only what it changes. */
const PATH_DEFAULTS = {
  knowledgeSeeded: true,
  echoLoose: [] as readonly string[],
  expertInWords: true,
  expectedDefectLogs: 0,
} as const;

const languageArb = fc.constantFrom<Language>('en', 'hi', 'mr');
const channelArb = fc.constantFrom<Channel>('web', 'telegram');
const severityArb = fc.constantFrom<Severity>('none', 'low', 'moderate', 'high');
const conditionArb = fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS);

/** Confidence inside the closed interval, at a precision a provider would plausibly emit. */
const inRangeConfidenceArb = fc.integer({ min: 0, max: 100 }).map((n) => n / 100);

/** Outside it, on both sides — Requirement 5.4's interval is closed, so 0 and 1 are not here. */
const outOfRangeConfidenceArb = fc.oneof(
  fc.integer({ min: -500, max: -1 }).map((n) => n / 100),
  fc.integer({ min: 101, max: 500 }).map((n) => n / 100),
);

/** The well-formed, in-knowledge-base response every failing payload below is a mutation of. */
interface RawPayload {
  status: string;
  disease_name: string | null;
  confidence: number;
  severity: string;
}

function wellFormed(
  condition: VerifiedCondition,
  confidence: number,
  severity: Severity,
): RawPayload {
  return { status: 'identified', disease_name: condition, confidence, severity };
}

/** Requirement 5.2 — text that is not JSON at all, including a fenced block (no fence stripping). */
const notJsonArb: fc.Arbitrary<InconclusivePath> = fc
  .constantFrom(
    '',
    '   ',
    'Jamee could not read this image.',
    '{"status":',
    '{\'status\':\'identified\'}',
    '```json\n{"status":"identified","disease_name":"Tomato Early Blight","confidence":0.9,"severity":"high"}\n```',
  )
  .map((text) => ({
    ...PATH_DEFAULTS,
    kind: 'not_json' as const,
    label: `text that is not JSON: ${JSON.stringify(text)}`,
    classificationText: text,
    reasons: SCHEMA_REASONS,
  }));

/** Valid JSON that is not the diagnosis object at all. Every required field is absent from it. */
const notTheObjectArb: fc.Arbitrary<InconclusivePath> = fc
  .constantFrom('"unclear"', '[]', 'null', '42', 'true', '[{"status":"identified"}]', '{}')
  .map((text) => ({
    ...PATH_DEFAULTS,
    kind: 'not_the_diagnosis_object' as const,
    label: `JSON that is not the diagnosis object: ${text}`,
    classificationText: text,
    reasons: SCHEMA_REASONS,
  }));

/** Requirement 5.3, first half — a required key omitted. All four, one at a time. */
const absentFieldArb: fc.Arbitrary<InconclusivePath> = fc
  .record({
    condition: conditionArb,
    confidence: inRangeConfidenceArb,
    severity: severityArb,
    field: fc.constantFrom('status', 'disease_name', 'confidence', 'severity'),
  })
  .map(({ condition, confidence, severity, field }) => {
    const payload: Record<string, unknown> = { ...wellFormed(condition, confidence, severity) };
    delete payload[field];
    return {
      ...PATH_DEFAULTS,
      kind: 'absent_required_field' as const,
      label: `a required field omitted: ${field}`,
      classificationText: JSON.stringify(payload),
      reasons: SCHEMA_REASONS,
    };
  });

/** Requirement 5.3, second half — a required key present, carrying the wrong type. */
const wrongTypedFieldArb: fc.Arbitrary<InconclusivePath> = fc
  .record({
    condition: conditionArb,
    confidence: inRangeConfidenceArb,
    severity: severityArb,
    mutation: fc.constantFrom<[string, unknown]>(
      ['status', 7],
      ['disease_name', 42],
      ['disease_name', ''],
      ['confidence', 'high'],
      ['confidence', null],
      ['severity', 3],
      ['severity', null],
    ),
  })
  .map(({ condition, confidence, severity, mutation }) => {
    const [field, value] = mutation;
    const payload: Record<string, unknown> = { ...wellFormed(condition, confidence, severity) };
    payload[field] = value;
    return {
      ...PATH_DEFAULTS,
      kind: 'wrong_typed_field' as const,
      label: `a wrongly-typed field: ${field} = ${JSON.stringify(value)}`,
      classificationText: JSON.stringify(payload),
      reasons: SCHEMA_REASONS,
    };
  });

/** A `status` outside the three the raw schema admits. */
const badStatusArb: fc.Arbitrary<InconclusivePath> = fc
  .record({
    condition: conditionArb,
    confidence: inRangeConfidenceArb,
    severity: severityArb,
    status: fc.constantFrom('healthy', 'IDENTIFIED', 'identified ', 'unknown', 'blurry'),
  })
  .map(({ condition, confidence, severity, status }) => ({
    ...PATH_DEFAULTS,
    kind: 'status_outside_vocabulary' as const,
    label: `a status outside the three values: ${JSON.stringify(status)}`,
    classificationText: JSON.stringify({
      ...wellFormed(condition, confidence, severity),
      status,
    }),
    reasons: SCHEMA_REASONS,
  }));

/** Requirement 5.4 — confidence outside the closed interval [0, 1]. */
const badConfidenceArb: fc.Arbitrary<InconclusivePath> = fc
  .record({
    condition: conditionArb,
    confidence: outOfRangeConfidenceArb,
    severity: severityArb,
  })
  .map(({ condition, confidence, severity }) => ({
    ...PATH_DEFAULTS,
    kind: 'confidence_out_of_range' as const,
    label: `a confidence outside [0, 1]: ${confidence}`,
    classificationText: JSON.stringify(wellFormed(condition, confidence, severity)),
    reasons: SCHEMA_REASONS,
  }));

/** Requirement 5.5 — a severity outside the four defined values. */
const badSeverityArb: fc.Arbitrary<InconclusivePath> = fc
  .record({
    condition: conditionArb,
    confidence: inRangeConfidenceArb,
    severity: fc.constantFrom('severe', 'critical', 'NONE', 'moderate ', '', 'medium'),
  })
  .map(({ condition, confidence, severity }) => ({
    ...PATH_DEFAULTS,
    kind: 'severity_outside_vocabulary' as const,
    label: `a severity outside the four values: ${JSON.stringify(severity)}`,
    classificationText: JSON.stringify({
      ...wellFormed(condition, confidence, 'moderate'),
      severity,
    }),
    reasons: SCHEMA_REASONS,
  }));

/** Requirements 5.6 → 6.1 — a real, well-formed name Jamee holds no verified content for. */
const outOfKnowledgeNameArb: fc.Arbitrary<InconclusivePath> = fc
  .record({
    name: fc.constantFrom(...OUT_OF_KB_NAMES),
    confidence: inRangeConfidenceArb,
    severity: severityArb,
  })
  .map(({ name, confidence, severity }) => ({
    ...PATH_DEFAULTS,
    kind: 'unverified_condition_name' as const,
    label: `a condition outside the five: ${name}`,
    classificationText: JSON.stringify({
      status: 'identified',
      disease_name: name,
      confidence,
      severity,
    }),
    reasons: ['unverified_condition'] as readonly RejectionReason[],
    /** The whole point of Requirement 6.5: this guess must not come back out. */
    echoLoose: [name] as readonly string[],
  }));

/** `identified` with no name at all. Stage 1 admits `null`; the safety gate does not. */
const identifiedWithoutNameArb: fc.Arbitrary<InconclusivePath> = fc
  .record({ confidence: inRangeConfidenceArb, severity: severityArb })
  .map(({ confidence, severity }) => ({
    ...PATH_DEFAULTS,
    kind: 'identified_without_a_name' as const,
    label: 'an identified response carrying no disease name',
    classificationText: JSON.stringify({
      status: 'identified',
      disease_name: null,
      confidence,
      severity,
    }),
    reasons: ['unverified_condition'] as readonly RejectionReason[],
  }));

/**
 * Both stages pass and the knowledge base has no row for the name.
 *
 * An unseeded or partially seeded deployment — a defect, not a farmer's mistake. Requirement 3.2
 * leaves no grounded explanation to compose without the row, so the service logs the defect and
 * serves the same inconclusive shape. The log line is counted rather than swallowed.
 */
const knowledgeRowAbsentArb: fc.Arbitrary<InconclusivePath> = fc
  .record({
    condition: conditionArb,
    confidence: inRangeConfidenceArb,
    severity: severityArb,
  })
  .map(({ condition, confidence, severity }) => ({
    ...PATH_DEFAULTS,
    kind: 'knowledge_row_absent' as const,
    label: `a verified name with no seeded row: ${condition}`,
    classificationText: JSON.stringify(wellFormed(condition, confidence, severity)),
    knowledgeSeeded: false,
    reasons: ['unverified_condition'] as readonly RejectionReason[],
    expectedDefectLogs: 1,
  }));

/** Requirement 6.2 — the model reporting honestly, which is a valid stage-1 parse. */
const modelUnclearArb: fc.Arbitrary<InconclusivePath> = fc
  .record({
    name: fc.oneof(fc.constant(null), conditionArb, fc.constantFrom(...OUT_OF_KB_NAMES)),
    confidence: inRangeConfidenceArb,
    severity: severityArb,
  })
  .map(({ name, confidence, severity }) => ({
    ...PATH_DEFAULTS,
    kind: 'model_reported_unclear' as const,
    label: `the model reported unclear, disease_name ${JSON.stringify(name)}`,
    classificationText: JSON.stringify({
      status: 'unclear',
      disease_name: name,
      confidence,
      severity,
    }),
    reasons: ['model_unclear'] as readonly RejectionReason[],
    /**
     * `unclear` never reaches stage 2, so a name riding along on it is discarded by the shape
     * rather than by the safety gate. Probed anyway: that is exactly the leak Requirement 6.5
     * forbids, and it would not be caught by anything else here.
     */
    echoLoose: (name === null || VERIFIED_CONDITIONS.includes(name as VerifiedCondition)
      ? []
      : [name]) as readonly string[],
  }));

/** Requirement 6.3 — no plant in the image. The one path whose copy names no expert. */
const modelNoPlantArb: fc.Arbitrary<InconclusivePath> = fc
  .record({ confidence: inRangeConfidenceArb, severity: severityArb })
  .map(({ confidence, severity }) => ({
    ...PATH_DEFAULTS,
    kind: 'model_reported_no_plant' as const,
    label: 'the model reported no plant in the image',
    classificationText: JSON.stringify({
      status: 'no_plant',
      disease_name: null,
      confidence,
      severity,
    }),
    reasons: ['model_no_plant'] as readonly RejectionReason[],
    expertInWords: false,
  }));

const pathArb: fc.Arbitrary<InconclusivePath> = fc.oneof(
  notJsonArb,
  notTheObjectArb,
  absentFieldArb,
  wrongTypedFieldArb,
  badStatusArb,
  badConfidenceArb,
  badSeverityArb,
  outOfKnowledgeNameArb,
  identifiedWithoutNameArb,
  knowledgeRowAbsentArb,
  modelUnclearArb,
  modelNoPlantArb,
);

/* ========================================================================== */
/* The caller                                                                  */
/* ========================================================================== */

const farmerIdArb = fc.uuid();

/* ========================================================================== */
/* The transport dimension (Requirement 14.4)                                  */
/* ========================================================================== */

/**
 * What the primary vision member does. The two failing kinds are the buckets Requirement 14.4
 * admits as a reason to try the next member, so each one costs a second *transport* invocation and
 * no second *content* request.
 */
const TRANSPORT_KINDS = ['primary_answers', 'primary_rate_limited', 'primary_unavailable'] as const;

type TransportKind = (typeof TRANSPORT_KINDS)[number];

const transportArb = fc.constantFrom<TransportKind>(...TRANSPORT_KINDS);

/** One when the primary answers; two when the chain falls through to its second member. */
function expectedVisionInvocations(transport: TransportKind): 1 | 2 {
  return transport === 'primary_answers' ? 1 : 2;
}

/* ========================================================================== */
/* The seams, each one counting                                                */
/* ========================================================================== */

interface Tallies {
  /** The quota unit, in all three directions the counter can be touched. */
  increments: number;
  decrements: number;
  reads: number;
  /** The capability seam: how many classifications and how many rephrases were requested. */
  classifies: number;
  generates: number;
  /** The transport seam, inside the fallback loop: how many provider invocations happened. */
  visionInvocations: number;
  textInvocations: number;
  /** The owner-checked media read (A3, GridFS). */
  mediaReads: number;
  /** Knowledge-base reads. */
  knowledgeReads: number;
}

/**
 * A3, V34: the owner-checked media read yields the bytes the model is sent inline. Every seam is
 * injected below, so there is no Supabase stack to stand in for.
 */

interface HarnessOptions {
  readonly classificationText: string;
  readonly knowledgeSeeded: boolean;
  readonly transport: TransportKind;
}

interface Harness {
  readonly deps: DiagnosisDeps;
  readonly tallies: Tallies;
  readonly diagnosisRows: DiagnosisInsert[];
  readonly usageRows: UsageLogInsert[];
  /** Every input the transport seam was handed, in order. */
  readonly visionInputs: VisionCall[];
  readonly textInputs: TextCall[];
}

function harness(options: HarnessOptions): Harness {
  const tallies: Tallies = {
    increments: 0,
    decrements: 0,
    reads: 0,
    classifies: 0,
    generates: 0,
    visionInvocations: 0,
    textInvocations: 0,
    mediaReads: 0,
    knowledgeReads: 0,
  };

  const diagnosisRows: DiagnosisInsert[] = [];
  const usageRows: UsageLogInsert[] = [];
  const visionInputs: VisionCall[] = [];
  const textInputs: TextCall[] = [];

  const readMedia = (): Promise<{ bytes: Buffer; mimeType: string }> => {
    tallies.mediaReads += 1;
    return Promise.resolve({ bytes: IMAGE_BYTES, mimeType: IMAGE_MIME });
  };

  const rpc: CounterRpc = {
    tryIncrement: () => {
      tallies.increments += 1;
      return Promise.resolve(1);
    },
    decrement: () => {
      tallies.decrements += 1;
      return Promise.resolve(0);
    },
    used: () => {
      tallies.reads += 1;
      return Promise.resolve(1);
    },
  };

  /**
   * The primary vision member. Answers, or declines in one of the two ways Requirement 14.4 treats
   * as a reason to try the next member.
   *
   * `classifyError` is the adapter's own contract with the gateway, and the gateway's real
   * `isFallbackTrigger` acts on it. Which HTTP status maps onto which bucket is Property 21's
   * subject and is not restated here.
   */
  const visionChain: AdapterSet<VisionCall, string> = {
    gemini: {
      id: 'gemini',
      model: 'stub/vision-primary',
      invoke: (input) => {
        tallies.visionInvocations += 1;
        visionInputs.push(input);
        return options.transport === 'primary_answers'
          ? Promise.resolve(options.classificationText)
          : Promise.reject(new Error(`stub primary declined: ${options.transport}`));
      },
      classifyError: (): ProviderFailure =>
        options.transport === 'primary_rate_limited' ? 'RATE_LIMIT' : 'UNAVAILABLE',
    },
    groq: {
      id: 'groq',
      model: A_CONFIGURED_VISION_FALLBACK,
      invoke: (input) => {
        tallies.visionInvocations += 1;
        visionInputs.push(input);
        return Promise.resolve(options.classificationText);
      },
      classifyError: (): ProviderFailure => 'OTHER',
    },
  };

  /**
   * The rephrase chain. Both members answer, and both count — so a zero below is a counted zero
   * rather than an inference from the shape of the result.
   */
  const textChain: AdapterSet<TextCall, string> = {
    gemini: {
      id: 'gemini',
      model: 'stub/text-primary',
      invoke: (input) => {
        tallies.textInvocations += 1;
        textInputs.push(input);
        return Promise.resolve('a rephrased explanation no inconclusive result may carry');
      },
      classifyError: (): ProviderFailure => 'OTHER',
    },
    groq: {
      id: 'groq',
      model: 'stub/text-fallback',
      invoke: (input) => {
        tallies.textInvocations += 1;
        textInputs.push(input);
        return Promise.resolve('a rephrased explanation no inconclusive result may carry');
      },
      classifyError: (): ProviderFailure => 'OTHER',
    },
  };

  const models: CapabilityRunner = {
    classify: (input, runOptions = {}) => {
      tallies.classifies += 1;
      return run('vision-classify', visionChain, input, {
        ...runOptions,
        visionFallbackModel: A_CONFIGURED_VISION_FALLBACK,
      });
    },
    generate: (input, runOptions = {}) => {
      tallies.generates += 1;
      return run('text-generate', textChain, input, runOptions);
    },
  };

  const store: DiagnosisStore = {
    insertDiagnosis: (row: DiagnosisInsert) => {
      diagnosisRows.push(row);
      return Promise.resolve(DIAGNOSIS_ID);
    },
    insertUsageLog: (row: UsageLogInsert) => {
      usageRows.push(row);
      return Promise.resolve();
    },
    ownsConversation: () => Promise.resolve(true),
  };

  const conversations: ConversationStore = {
    mostRecent: (userId: string, channel: Conversation['channel']) =>
      Promise.resolve(conversationFor(userId, channel)),
    create: (userId: string, channel: Conversation['channel']) =>
      Promise.resolve(conversationFor(userId, channel)),
  };

  const knowledge: KnowledgeReader = (names) => {
    tallies.knowledgeReads += 1;
    if (!options.knowledgeSeeded) return Promise.resolve([]);
    return Promise.resolve(KNOWLEDGE_ROWS.filter((row) => names.includes(row.disease_name)));
  };

  return {
    tallies,
    diagnosisRows,
    usageRows,
    visionInputs,
    textInputs,
    deps: {
      store,
      readMedia,
      conversations,
      knowledge,
      models,
      quota: { rpc, now: new Date(NOW_MS) },
      now: () => NOW_MS,
      // `getDeadline()` answers `undefined` outside a platform invocation; stating it keeps the run
      // independent of whether `@vercel/functions` happens to be inside one.
      platformDeadline: () => undefined,
    },
  };
}

function conversationFor(userId: string, channel: Conversation['channel']): Conversation {
  return {
    id: CONVERSATION_ID,
    user_id: userId,
    channel,
    title: null,
    created_at: '2026-09-16T00:59:00.000Z',
    updated_at: '2026-09-16T00:59:00.000Z',
  };
}

/* ========================================================================== */
/* The defect log                                                              */
/* ========================================================================== */

/**
 * `console.error` is captured rather than left to print.
 *
 * The unseeded-deployment path logs a defect line by design, and hundreds of iterations of it would
 * bury the run's real output. Captured instead of silenced: the count is asserted per case, so the
 * suppression buys a real assertion rather than only quiet.
 */
let errorLog: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  errorLog.mockRestore();
});

/* ========================================================================== */
/* Shared assertions                                                          */
/* ========================================================================== */

/**
 * Requirement 6.4's one shape, as an object with the explanation lifted out.
 *
 * `toStrictEqual` against this catches an extra field as well as a wrong one, which is what makes
 * "one shape" a statement about the whole result rather than about seven remembered keys.
 */
function canonicalShape(language: Language): Record<string, unknown> {
  return {
    status: 'unknown',
    diseaseName: null,
    confidence: null,
    severity: 'none',
    knowledge: null,
    needsExpert: true,
    language,
  };
}

/** Requirement 6.4/6.5 at the persistence layer: the same shape, in the document's fields. */
const CANONICAL_ROW_SHAPE = {
  status: 'unknown',
  diseaseName: null,
  knowledgeId: null,
  confidence: null,
  severity: 'none',
  needsExpert: true,
} as const;

function rowShapeOf(row: DiagnosisInsert): Record<string, unknown> {
  return {
    status: row.status,
    diseaseName: row.diseaseName ?? null,
    knowledgeId: row.knowledgeId ?? null,
    confidence: row.confidence ?? null,
    severity: row.severity,
    needsExpert: row.needsExpert ?? false,
  };
}

/* ========================================================================== */
/* Property 8                                                                  */
/* ========================================================================== */

describe('Property 8: all non-identified outcomes collapse into one inconclusive shape', () => {
  it('returns the one shape, carrying no name, no knowledge, and no treatment sentence, for every cause', async () => {
    const exercised = new Set<PathKind>();
    /**
     * Languages are tracked too, because two of this property's assertions are per-language: the
     * expert recommendation and Requirement 6.3's crop-photo request are matched against `hi` and
     * `mr` copy, not only `en`. A run that happened to draw one language would leave those two
     * claims unproven for the other two catalogs.
     */
    const languages = new Set<Language>();

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          path: pathArb,
          language: languageArb,
          channel: channelArb,
          caller: farmerIdArb,
          transport: transportArb,
        }),
        async ({ path, language, channel, caller, transport }) => {
          exercised.add(path.kind);
          languages.add(language);
          errorLog.mockClear();

          const test = harness({
            classificationText: path.classificationText,
            knowledgeSeeded: path.knowledgeSeeded,
            transport,
          });

          const outcome = await diagnose(
            {
              userId: caller,
              image: IMAGE_REF,
              language,
              channel,
            },
            test.deps,
          );

          const { result } = outcome;
          const label = `${path.kind}: ${path.label}`;

          // ── Requirement 6.4 — status `unknown`, and one shape for every cause ──
          expect(result.status, label).toBe('unknown');
          expect(inconclusiveResultSchema.safeParse(result).success, label).toBe(true);

          const { explanation, ...shape } = result;
          expect(shape, label).toStrictEqual(canonicalShape(language));

          // The reason is present exactly when the result is inconclusive, and it is one of the
          // reasons this cause may be attributed to. A set, for the reason the header gives.
          const reason = outcome.rejectionReason;
          expect(reason, label).toBeDefined();
          expect(path.reasons, label).toContain(reason);

          // ── D5 — the explanation is the static localized catalog entry, not model prose ──
          expect(explanation, label).toBe(
            messages(language).inconclusive[reason as RejectionReason],
          );

          // ── Requirements 6.1/6.2 — the expert recommendation, in words ──
          // `model_no_plant` is the exception Requirement 6.3 specifies. See the header.
          if (path.expertInWords) {
            expect(explanation, label).toContain(EXPERT_PHRASE[language]);
          } else {
            expect(explanation, label).toContain(CROP_PHOTO_PHRASE[language]);
          }

          // ── Requirement 6.5 — no candidate disease name, in any casing ──
          for (const echo of path.echoLoose) {
            expect(explanation.toLowerCase(), label).not.toContain(echo.toLowerCase());
          }
          // The five canonical names are Latin-script and never translated (Requirement 4.6), so a
          // verbatim comparison is the whole check. Case-sensitive on purpose: the coverage sentence
          // in the `unverified_condition` copy names Jamee's own crops in lowercase prose.
          for (const condition of VERIFIED_CONDITIONS) {
            expect(explanation, label).not.toContain(condition);
          }

          // ── Requirement 6.5 — no treatment sentence from any knowledge base row ──
          expect(explanation, label).not.toContain(KB_MARKER);
          for (const text of ALL_KNOWLEDGE_TEXT) {
            expect(explanation, label).not.toContain(text);
          }

          // ── The same shape at the persistence layer, for every cause ──
          expect(test.diagnosisRows, label).toHaveLength(1);
          const row = test.diagnosisRows[0] as DiagnosisInsert;
          expect(rowShapeOf(row), label).toStrictEqual(CANONICAL_ROW_SHAPE);
          expect(row.explanation, label).toBe(explanation);
          expect(row.language, label).toBe(language);
          expect(row.channel, label).toBe(channel);

          // The unseeded-deployment path is a logged defect, not a silent degradation.
          expect(errorLog.mock.calls.length, label).toBe(path.expectedDefectLogs);
        },
      ),
      // 480 runs over twelve causes and three transports, so every branch is reached many times
      // over rather than probably. The coverage assertion below is what makes that a fact.
      { numRuns: 480 },
    );

    expect([...exercised].sort()).toStrictEqual([...PATH_KINDS].sort());
    expect([...languages].sort()).toStrictEqual(['en', 'hi', 'mr']);
  });
});

/* ========================================================================== */
/* Property 9                                                                  */
/* ========================================================================== */

describe('Property 9: an inconclusive result costs exactly one unit and no extra model call', () => {
  it('spends one unit, never refunds it, and issues no model call after the result is inconclusive', async () => {
    const exercisedPaths = new Set<PathKind>();
    const exercisedTransports = new Set<TransportKind>();

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          path: pathArb,
          transport: transportArb,
          language: languageArb,
          channel: channelArb,
          caller: farmerIdArb,
        }),
        async ({ path, transport, language, channel, caller }) => {
          exercisedPaths.add(path.kind);
          exercisedTransports.add(transport);
          errorLog.mockClear();

          const test = harness({
            classificationText: path.classificationText,
            knowledgeSeeded: path.knowledgeSeeded,
            transport,
          });

          const outcome = await diagnose(
            {
              userId: caller,
              image: IMAGE_REF,
              language,
              channel,
            },
            test.deps,
          );

          const label = `${path.kind} / ${transport}: ${path.label}`;

          // The premise: this request really did come back inconclusive.
          expect(outcome.result.status, label).toBe('unknown');

          // ── Requirement 6.7 — exactly one unit, and it stays spent ────────
          expect(test.tallies.increments, label).toBe(1);
          expect(test.tallies.decrements, label).toBe(0);
          expect(test.tallies.reads, label).toBe(0);
          expect(outcome.quota.used, label).toBe(1);
          expect(outcome.quota.operation, label).toBe('image');

          // ── Requirement 6.6 — one classification, and no rephrase ─────────
          // The capability seam first: exactly one classification was requested, and the second
          // model call this pipeline is capable of was never requested at all.
          expect(test.tallies.classifies, label).toBe(1);
          expect(test.tallies.generates, label).toBe(0);

          // Then the transport seam, inside the real fallback loop. This is where Requirement
          // 14.4's permitted second invocation is visible: one when the primary answers, two when
          // the chain falls through, and never more.
          expect(test.tallies.visionInvocations, label).toBe(expectedVisionInvocations(transport));
          expect(test.tallies.textInvocations, label).toBe(0);
          expect(test.textInputs, label).toStrictEqual([]);

          // …and it is a transport retry, not a content retry (D4): every invocation was handed
          // the identical request. A repair re-ask would differ here even at the same count.
          expect(test.visionInputs, label).toHaveLength(
            expectedVisionInvocations(transport),
          );
          for (const input of test.visionInputs) {
            expect(input, label).toStrictEqual(test.visionInputs[0]);
          }

          // ── Requirement 6.7 in the audit — one row, and it says the unit was spent ──
          expect(test.usageRows, label).toHaveLength(1);
          const usage = test.usageRows[0] as UsageLogInsert;
          expect(usage.quota_spent, label).toBe(true);
          expect(usage.operation, label).toBe('image');
          expect(usage.rejection_reason, label).toBe(outcome.rejectionReason);
          // `inconclusive` for the two reasons the model reported itself, `validation_rejected` for
          // the five Jamee's own Validation_Layer produced. Farmer-identical either way.
          expect(
            ['inconclusive', 'validation_rejected'].includes(usage.outcome),
            `${label} — outcome was ${usage.outcome}`,
          ).toBe(true);

          // One diagnosis row, so "one unit" bought exactly one persisted result.
          expect(test.diagnosisRows, label).toHaveLength(1);
        },
      ),
      { numRuns: 480 },
    );

    expect([...exercisedPaths].sort()).toStrictEqual([...PATH_KINDS].sort());
    expect([...exercisedTransports].sort()).toStrictEqual([...TRANSPORT_KINDS].sort());
  });
});
