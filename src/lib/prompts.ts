import { hasTreatmentContent, type KnowledgeEntry } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import {
  HEALTHY_CONDITION,
  severitySchema,
  VERIFIED_CONDITIONS,
  visionRawSchema,
  type Language,
  type MessageRole,
  type Severity,
  type VerifiedCondition,
  type VisionRaw,
} from '@/lib/schemas';

/**
 * Every prompt Jamee sends, and the request-side JSON Schema that goes with the classification
 * call.
 *
 * Requirements: 3.1 (classification asks for a candidate condition, a confidence in [0, 1], and a
 *               severity), 3.4 (`Tomato Healthy` reports severity `none` and no treatment content),
 *               3.5 (a multi-leaf image yields exactly one condition), 4.7 / 5.6 (a crop or
 *               condition outside the Verified_Conditions is never named), 6.2 (an unjudgeable
 *               image is reported as unclear), 6.3 (an image with no plant is reported as such)
 * Design: "Prompting and grounding" → *1. Constrained vision classification*
 * Depends on: V7 — `response_format: { type: 'text', mime_type: 'application/json',
 *             schema: <JSON Schema> }`, and the JSON Schema keyword subset Gemini accepts
 *
 * ### THE PROMPT IS A REQUEST; THE SCHEMA IS THE ENFORCEMENT
 *
 * Read every string in this file as *asking* a model for a shape, never as guaranteeing one.
 * Three separate mechanisms stand behind the ask, and they are deliberately not the same thing:
 *
 *  1. **Structured output is configured ON THE REQUEST, not trusted to the prompt.** V7's
 *     `response_format` (MIME type + `schema`) and `generation_config` (lowest available
 *     temperature, max output tokens) are set by the provider adapter — task 8.2's `gemini.ts` —
 *     using `VISION_RESPONSE_JSON_SCHEMA` below. A prompt that merely says "JSON only" is a
 *     request a model may decline; a request-level response format is not.
 *  2. **Even so, the response is parsed by `visionRawSchema` and then `visionVerifiedSchema`**
 *     (Requirement 5.1, design D2). V7 is explicit that structured output is *syntactically*
 *     valid JSON but *semantically* unvalidated, and V9 records that the Groq vision fallback
 *     has only a plain JSON-object mode with no schema at all — so on that path stage 1 is the
 *     first check of any kind. Neither path may skip stage 2.
 *  3. **A name outside the five is a validation outcome, not a prompt failure.** The prompt asks
 *     for `unclear` rather than an invented name (Requirements 4.7, 5.6). If a model names one
 *     anyway, `visionVerifiedSchema` rejects it, the service records
 *     `rejection_reason: 'unverified_condition'`, discards the name *and* the confidence, and
 *     returns the one inconclusive shape (Requirements 6.1, 6.4, 6.5) with no second model call
 *     (Requirement 6.6).
 *
 * ### Why the wording is DERIVED rather than typed out
 *
 * The design writes the five condition names literally inside the prompt. Here they come from
 * `VERIFIED_CONDITIONS` in `schemas.ts` instead, along with the status values, the severity
 * values, and the count. A sixth verified condition is a change to one tuple in one file
 * (plus the two SQL check constraints that tuple documents); a prompt with a retyped list would
 * silently keep classifying against five while the rest of the system knew six, and nothing
 * would fail — the model would simply never name the new condition. The only wording deviation
 * from the design is the count: it renders as the numeral `5` rather than the word "five",
 * because a derived numeral cannot contradict the list above it.
 *
 * The bracketed `[Requirement n.n]` annotations in the design's prompt block are traceability
 * notes for a reader, not text for a model. They live in the comments beside each rule below
 * instead of in the string, so the model receives instructions and nothing else.
 *
 * ### Layout
 *
 * Three prompts share this module (design: *Prompting and grounding*), and they share the
 * derived vocabulary in the first section. Section 2 is the rephrase path; task 15.2 fills in
 * section 3 — the placeholder at the bottom is where it goes.
 *
 * ### This module became server-side when section 2 landed, and that is recorded rather than hidden
 *
 * It still carries no `import 'server-only'` marker of its own and holds no secret. But section 2
 * imports `hasTreatmentContent()` from `knowledge.ts`, which *is* marked `server-only`, so
 * `prompts.ts` is now server-side transitively: a client component importing it is a build error.
 *
 * That is the right trade and not an accident. Every prompt here is composed inside a request, on
 * a server, from a `disease_knowledge` row — there is no client caller and never will be. The
 * alternative was to re-spell `entry.treatment.length > 0` locally, which would put Requirement
 * 3.4's predicate in two files and make "does this row have treatment to show" a question with two
 * answers. `knowledge.ts` says explicitly that it exists to be the one place that question is
 * asked; taking the dependency honours that, and duplicating the predicate to preserve a
 * client-importability nobody uses would not.
 */

/* ========================================================================== */
/* Version                                                                     */
/* ========================================================================== */

/**
 * Written to `usage_logs.prompt_version` on every row a model operation produces (migration
 * `0006_usage_logs.sql`, Requirement 14.6).
 *
 * **Why the column exists:** without it, a prompt edit and a model change are indistinguishable
 * when reading a week of rows — an outcome distribution that shifts on Tuesday could be either.
 * With it, a behavioural change is attributable to the exact prompt revision that produced it.
 *
 * **Bump discipline.** One version covers the whole module, matching the design's single
 * constant. Bump it whenever the text a model actually receives changes — including when tasks
 * 9.2 and 15.2 add their prompts, and including a change that arrives *through* a derivation
 * (adding a sixth verified condition rewrites the classification prompt without touching this
 * file). Do not bump it for a comment or a refactor that leaves every emitted string identical.
 *
 * `v1` → `v2` because task 9.2 added section 2's rephrase prompt. `v2` → `v3` because task 15.2
 * added section 3's chat prompt. The classification prompt is byte-identical to what `v1` sent; one
 * version covering the module means a rephrase row, a classification row and a chat row from the
 * same deployment carry the same value, which is what makes "this distribution shifted on Tuesday"
 * attributable to a known revision of the whole module rather than to a per-prompt version a reader
 * would have to correlate.
 */
export const PROMPT_VERSION = 'v3';

/* ========================================================================== */
/* Derived vocabulary, shared by all three prompts                             */
/* ========================================================================== */

/**
 * The status and severity vocabularies, read off the schemas that validate them rather than
 * restated. `visionRawSchema.shape.status` is the same enum stage 1 parses against, so the JSON
 * template below and the parser cannot disagree about which statuses exist.
 */
const VISION_STATUSES = visionRawSchema.shape.status.options;
const SEVERITY_VALUES = severitySchema.options;

/**
 * Requirement 5.4's confidence interval, **closed at both ends**.
 *
 * Declared once and used twice — in the prompt's JSON template and as the JSON Schema's
 * `minimum`/`maximum` — so the number Jamee asks for is the number it configures. The runtime
 * check is `visionRawSchema`'s `.min(0).max(1)`; these two constants only describe it.
 */
const CONFIDENCE_MIN = 0;
const CONFIDENCE_MAX = 1;

/**
 * The two non-identified statuses, named so the rules below cannot drift from the union. The
 * `satisfies` clause is what makes a rename of either value a compile error here rather than a
 * prompt that asks for a status the parser will reject.
 */
const STATUS = {
  identified: 'identified',
  unclear: 'unclear',
  noPlant: 'no_plant',
} as const satisfies Record<string, VisionRaw['status']>;

/** Requirement 3.4's severity for a healthy crop, checked against the severity enum. */
const HEALTHY_SEVERITY = 'none' satisfies Severity;

/** `["a", "b"]` → `"a"|"b"`, the union notation the design's JSON template uses. */
function quotedUnion(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join('|');
}

/** `["tomato", "potato"]` → `tomato or potato`. */
function joinWithOr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  const last = items[items.length - 1] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${last}`;
}

/**
 * Group the verified conditions by their crop word, which is the first token of every canonical
 * name (`Tomato Early Blight`, `Potato Late Blight`).
 *
 * This reproduces the design's two-line layout — tomato names on one line, potato names on the
 * next — from the tuple rather than from hand-wrapped text, and it degrades sensibly: a sixth
 * condition joins its crop's line, and a new crop gets a line of its own. The grouping also
 * supplies the crop phrase the out-of-scope rule needs, so "not tomato or potato" cannot end up
 * naming a different set than the list above it.
 */
function groupConditionsByCrop(
  conditions: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const groups = new Map<string, string[]>();
  for (const condition of conditions) {
    // A name with no space is its own crop group; the tuple has none today, and the fallback
    // keeps a future one-word condition from being grouped under `undefined`.
    const crop = condition.split(' ')[0] ?? condition;
    const bucket = groups.get(crop);
    if (bucket === undefined) groups.set(crop, [condition]);
    else bucket.push(condition);
  }
  return groups;
}

const CONDITIONS_BY_CROP = groupConditionsByCrop(VERIFIED_CONDITIONS);

/** Two indented lines of `Name | Name | Name`, one per crop. */
const CONDITION_LINES = [...CONDITIONS_BY_CROP.values()]
  .map((names) => `  ${names.join(' | ')}`)
  .join('\n');

/** `tomato or potato` — lowercased for use mid-sentence. */
const CROP_PHRASE = joinWithOr(
  [...CONDITIONS_BY_CROP.keys()].map((crop) => crop.toLowerCase()),
);

/** The crop word of the healthy condition, so Requirement 3.4's rule follows the tuple too. */
const HEALTHY_CROP = (HEALTHY_CONDITION.split(' ')[0] ?? HEALTHY_CONDITION).toLowerCase();

/* ========================================================================== */
/* 1. Constrained vision classification                                       */
/* ========================================================================== */

/**
 * The object shape the prompt asks for, in the design's compact notation. Every value in it is
 * derived, so this template and `visionRawSchema` describe the same object by construction.
 */
const JSON_TEMPLATE = [
  `{"status":${quotedUnion(VISION_STATUSES)},`,
  ` "disease_name": <one of the ${VERIFIED_CONDITIONS.length} names above, or null>,`,
  ` "confidence": <number ${CONFIDENCE_MIN}..${CONFIDENCE_MAX}>,`,
  ` "severity": ${quotedUnion(SEVERITY_VALUES)}}`,
].join('\n');

/**
 * The constrained classification prompt (Requirement 3.1).
 *
 * Sent with the image on the `vision-classify` chain — Gemini first, and the Groq vision member
 * when V9's preview model is registered. One string serves both, because the contract it states
 * is Jamee's, not a provider's: five names or a non-identified status, JSON only, no advice.
 *
 * Each rule below carries the acceptance criterion it exists for. The last one matters more than
 * it looks: a classifier that volunteers treatment text would put an ungrounded agricultural
 * statement in front of a farmer, which Requirement 4.3 forbids outright. Treatment reaches a
 * farmer only from a `disease_knowledge` row, through the rephrase path in section 2.
 */
export const CLASSIFICATION_PROMPT = [
  `You are an image classifier for a crop advisory tool. You classify ONLY these`,
  `${VERIFIED_CONDITIONS.length} conditions:`,
  CONDITION_LINES,
  ``,
  `Return ONLY this JSON object, no prose, no markdown fence:`,
  JSON_TEMPLATE,
  ``,
  `Rules:`,
  // Requirement 6.2 — an unjudgeable photo is reported, not guessed at.
  `- If the image is blurry, dark, or too low-resolution to judge -> status "${STATUS.unclear}",`,
  `  disease_name null.`,
  // Requirement 6.3 — no plant in frame.
  `- If the image contains no plant -> status "${STATUS.noPlant}", disease_name null.`,
  // Requirements 4.7, 5.6 — out-of-scope crop or condition. "Never invent or substitute" is the
  // sentence that keeps a real-but-unsupported disease out of `disease_name`; stage 2 rejects it
  // if the model ignores this anyway.
  `- If the plant is not ${CROP_PHRASE}, or the condition is not one of the ${VERIFIED_CONDITIONS.length}`,
  `  -> status "${STATUS.unclear}", disease_name null. Never invent or substitute a name.`,
  // Requirement 3.5 — exactly one condition for a multi-leaf image.
  `- If several leaves are visible, judge the single most affected leaf and report`,
  `  exactly one condition.`,
  // Requirement 3.4 — a healthy crop is an `identified` result with severity `none`.
  `- A visibly healthy ${HEALTHY_CROP} plant -> "${HEALTHY_CONDITION}", severity "${HEALTHY_SEVERITY}".`,
  // Requirement 4.3 — no agronomic content from the classifier, ever.
  `- Do not give treatment advice. Do not explain. JSON only.`,
].join('\n');

/* -------------------------------------------------------------------------- */
/* The request-side JSON Schema (V7)                                           */
/* -------------------------------------------------------------------------- */

/**
 * One field of the classification response schema, restricted to the keywords **V7 confirms**
 * Gemini's supported JSON Schema subset accepts: `enum` on strings, `minimum`/`maximum` on
 * numbers, `required`, and `["string", "null"]` for a nullable field.
 *
 * The type is this narrow on purpose. A keyword outside the confirmed subset is not a harmless
 * extra — an ignored constraint reads as an enforced one at the call site, and a rejected
 * request fails the whole diagnosis. Widening this needs a V-item, not a guess.
 */
export interface VisionJsonSchemaField {
  type: 'string' | 'number' | ['string', 'null'];
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

/**
 * `properties` is keyed by `keyof VisionRaw`, so a field added to `visionRawSchema` is a compile
 * error here until it is described. That is the same anti-drift move `schemas.ts` makes with
 * `z.infer`, applied to the request side of the call.
 */
export interface VisionResponseJsonSchema {
  type: 'object';
  properties: Record<keyof VisionRaw, VisionJsonSchemaField>;
  required: Array<keyof VisionRaw>;
}

/**
 * Passed as `response_format.schema` by the Gemini adapter (V7), alongside
 * `mime_type: 'application/json'` and the lowest available temperature.
 *
 * ### `disease_name` carries NO enum, and that is deliberate
 *
 * Constraining it to the five names at the request level looks like a free extra gate. It is
 * not:
 *
 *  - **It is outside the confirmed subset.** V7 confirms `enum` on strings and `["string",
 *    "null"]` nullable types; it does not confirm an enum that must also admit `null`. A
 *    provider that accepted the enum and quietly dropped `null` from it would leave the two
 *    non-identified statuses unable to say "no name" — forcing the model to pick one of the five
 *    for a blurry photo or a bicycle, which is precisely the invention Requirements 4.7, 6.2 and
 *    6.3 exist to prevent. Trading a real safety property for a redundant one is a bad trade.
 *  - **It would gain nothing.** The five-name gate already exists twice: in the prompt as a
 *    request, and in `visionVerifiedSchema` as enforcement. The Groq vision member has no schema
 *    mode at all (V9), so stage 2 has to hold on its own regardless — and if it holds there, a
 *    request-level enum is not what is keeping farmers safe.
 *
 * So the schema pins what it can honestly pin — the two closed vocabularies, the confidence
 * interval, the four required fields, the nullability — and the rest is `visionRawSchema` and
 * `visionVerifiedSchema`'s job.
 */
export const VISION_RESPONSE_JSON_SCHEMA: VisionResponseJsonSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: [...VISION_STATUSES] },
    // Nullable by V7's `["string", "null"]`. Non-emptiness is stage 1's `.min(1)`; membership in
    // the five is stage 2's.
    disease_name: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: CONFIDENCE_MIN, maximum: CONFIDENCE_MAX },
    severity: { type: 'string', enum: [...SEVERITY_VALUES] },
  },
  // Requirement 5.3 — an omitted field is a rejection, so all four are required. The unit test
  // cross-checks this list against `visionRawSchema.shape` so the two cannot fall out of step.
  required: ['status', 'disease_name', 'confidence', 'severity'],
};

/* ========================================================================== */
/* 2. Knowledge-base rephrasing (identified results only)                      */
/* ========================================================================== */

/**
 * The rephrase-only request, and the post-generation checks on what comes back.
 *
 * Requirements: 3.2 (an identified result's explanation is composed only from the matching
 *               knowledge-base entry), 3.4 (a healthy result contains no treatment content),
 *               4.3 (every symptom, cause, treatment and prevention statement a farmer reads
 *               comes from that entry), 4.5 (the request supplies the relevant entry and
 *               instructs the model to rephrase only the supplied content), 4.6 / 9.4 (the
 *               Canonical_Disease_Name is preserved unchanged in every Supported_Language),
 *               9.3 (the explanation is returned in the requested language)
 * Design: "Prompting and grounding" → *2. Knowledge-base rephrasing*; "Post-generation
 *         validation of rephrased text"
 *
 * ### ###########################################################################
 * ### THE CHECKS BELOW ARE NOT THE SAFETY GUARANTEE. READ THIS BEFORE TRUSTING THEM.
 * ### ###########################################################################
 *
 * Checks 2, 3 and 4 are heuristics over **presentation**. They look at a finished string and ask
 * whether it *reads* correctly: is the canonical name there, does it name a condition that is not
 * in scope, is it empty or absurdly long. A heuristic over prose can be fooled, and none of these
 * can prove a sentence is true.
 *
 * **The substantive guarantee is structural, and it lives in `rephrasePrompt()`, not here.** The
 * only agricultural content the model ever receives is the `disease_knowledge` row — the four
 * arrays and the canonical name, verbatim, and nothing else. No other row, no other crop, no
 * severity, no citation, no farmer message, no classification output. So there is **no unverified
 * fact available for the model to leak**, and Requirements 4.3 and 4.5 hold because of what the
 * request omits rather than because of what these checks catch.
 *
 * Do not later read a passing check as evidence the text is grounded, and do not relax the
 * request's content on the grounds that the checks would catch a problem. They would not. They
 * catch a *garbled presentation* of grounded content, which is a different and much smaller job.
 */

/* -------------------------------------------------------------------------- */
/* The verified-content block                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A `disease_knowledge` row, on its way into a prompt or a static template.
 *
 * `entry` is the whole row rather than `knowledgePayloadOf(entry)`'s projection, because the
 * prompt needs `disease_name` — which the payload deliberately omits, since on an identified
 * result the name lives on `identifiedResultSchema.diseaseName` beside the payload rather than
 * inside it.
 */
export interface RephraseTarget {
  readonly entry: KnowledgeEntry;
  readonly language: Language;
}

/**
 * The row's four agronomic arrays, named by their **column names**.
 *
 * `satisfies readonly (keyof KnowledgeEntry)[]` is what keeps the prompt's labels and the
 * database's columns the same words: renaming a column breaks this line rather than producing a
 * prompt that labels content with a field that no longer exists. The design's prompt block uses
 * these same four labels, so the derivation costs nothing in fidelity.
 *
 * The order is the design's, and it is the order a farmer needs: what you see, why it happened,
 * what to do, how to stop it happening again.
 */
const KB_ARRAY_FIELDS = [
  'symptoms',
  'causes',
  'treatment',
  'prevention',
] as const satisfies readonly (keyof KnowledgeEntry)[];

type KbArrayField = (typeof KB_ARRAY_FIELDS)[number];

/**
 * Which of the four arrays this row has content for.
 *
 * ### Requirement 3.4, enforced by omission rather than by instruction
 *
 * The design's prompt block carries the rule *"If treatment is empty, do not mention treatment at
 * all"*. That rule is **not** emitted below, and its absence is the stronger form of the same
 * requirement: when the array is empty the word "treatment" never appears in the prompt at all —
 * not as a label, not as a rule — so a healthy result carrying treatment content is not something
 * the model has to cooperate about. An instruction is a request; an omitted field is a fact. (The
 * rule would also only ever be emitted alongside treatment content, where it is vacuous, so it
 * never did any work.)
 *
 * The question is asked of `hasTreatmentContent()` rather than of `HEALTHY_CONDITION`. Matching on
 * the name would be a second, weaker spelling of the same test: `Tomato Healthy` is the row with
 * no treatment *today*, by seed and by the `healthy_has_no_treatment` check constraint, but the
 * property that matters is the empty array, and a row is the thing that has or has not got
 * treatment to show.
 *
 * The other three are filtered on emptiness too, defensively: an empty `causes:` label in a
 * prompt is an invitation to fill it, which is exactly the invention Requirement 4.3 forbids.
 */
function contentFieldsOf(entry: KnowledgeEntry): readonly KbArrayField[] {
  const withTreatment = hasTreatmentContent(entry)
    ? KB_ARRAY_FIELDS
    : KB_ARRAY_FIELDS.filter((field) => field !== 'treatment');
  return withTreatment.filter((field) => entry[field].length > 0);
}

/**
 * The VERIFIED CONTENT block: the canonical name, then one line per array item.
 *
 * **One item per line, and this is the one place the layout deviates from the design.** The design
 * renders the arrays as `{…}` placeholders on two shared lines, so the *item* layout was never
 * pinned — and an inline join needs a separator, which the seeded content rules out: `Tomato Late
 * Blight`'s third symptom is already *"Firm brown lesions on stems and fruit; rapid collapse of
 * foliage"*, so a `; ` join would silently turn one verified sentence into two. A line per item
 * carries every string across byte-for-byte, which is what "verbatim" has to mean here, and makes
 * "every item appears exactly as stored" a checkable assertion rather than a parsing exercise.
 */
function verifiedContentBlock(entry: KnowledgeEntry): string {
  const lines = [`  disease: ${entry.disease_name}`];
  for (const field of contentFieldsOf(entry)) {
    lines.push(`  ${field}:`);
    for (const item of entry[field]) lines.push(`    - ${item}`);
  }
  return lines.join('\n');
}

/**
 * The language the model is asked to write in, by name.
 *
 * `Record<Language, string>` is exhaustive, so a fourth code added to `languageSchema` breaks this
 * object until it has a name — the same structural-completeness move the message catalogs make for
 * error codes. English names rather than the catalogs' endonyms (`हिन्दी`, `मराठी`): the
 * surrounding prompt is English, and the instruction has to be unambiguous to a model that has
 * only this string to go on.
 */
const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
};

/** The design's "4-6 short sentences". Two constants so the prompt cannot say one and mean another. */
const REPHRASE_MIN_SENTENCES = 4;
const REPHRASE_MAX_SENTENCES = 6;

/**
 * The rephrase request for one knowledge-base row in one language (Requirement 4.5).
 *
 * Called **once**, only after stage-2 validation has already established that the condition is one
 * of the five (design: *2. Knowledge-base rephrasing*). It is not a retry surface: a response that
 * fails a check below falls back to the static template rather than asking again, per D4 and
 * Requirement 6.6's reasoning.
 *
 * Everything agronomic in the returned string comes from `entry`. The two literal condition-shaped
 * strings in it are both `entry.disease_name` — once as the content label, once in the Latin-script
 * rule — and no other verified condition is named, which is what keeps a rephrase of one row from
 * cueing the model about another.
 */
export function rephrasePrompt(target: RephraseTarget): string {
  const { entry, language } = target;
  return [
    `Rephrase the VERIFIED CONTENT below into simple ${LANGUAGE_NAMES[language]} for a smallholder`,
    `farmer with limited schooling. ${REPHRASE_MIN_SENTENCES}-${REPHRASE_MAX_SENTENCES} short sentences.`,
    ``,
    `VERIFIED CONTENT (the only facts you may use):`,
    verifiedContentBlock(entry),
    ``,
    `Rules:`,
    // Requirement 4.3 — the only facts are the ones above. The list of things not to add is the
    // design's, and "chemical, dose, brand, timing" is not decoration: those four are exactly what
    // the seeded `treatment` arrays deliberately omit, so they are what a model would be most
    // tempted to helpfully supply.
    `- Use ONLY the facts above. Add no disease, symptom, cause, chemical, dose,`,
    `  brand, or timing that is not written above.`,
    // Requirements 4.6, 9.4 — the canonical name survives translation untouched. Check 2 below is
    // what happens when this instruction is not followed.
    `- Write the disease name exactly as "${entry.disease_name}" in Latin script. Do not`,
    `  translate or transliterate it.`,
    // Requirement 3.4's rule is absent by design — see `contentFieldsOf()`.
    `- No greetings, no disclaimers, no markdown.`,
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Post-generation validation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The length ceiling for check 1, in UTF-16 code units.
 *
 * Three things fix this number, none of them a provider limit:
 *  - The prompt asks for four to six short sentences. Devanagari spends roughly half again as many
 *    code units per visible character as Latin does (a cluster like `क्या` is four), so the ceiling
 *    has to clear six short Marathi sentences without clearing six English paragraphs — 1200 does.
 *  - It sits far below a messaging channel's per-message text limit (~4096 chars), so an accepted
 *    rephrase always fits in one message and the adapter's sentence-boundary truncation stays the
 *    guard it is described as rather than a routine path.
 *  - It sits above the longest `staticExplanationFor()` output (~900 code units for the longest
 *    seeded row), so the fallback is never longer than what the check that triggered it admits.
 *
 * Measured on code units rather than grapheme clusters because the number only has to be *large
 * enough*: it is catching a runaway generation, not trimming to a budget.
 */
export const REPHRASE_MAX_CHARS = 1200;

/** Why a model's rephrase was discarded. Each value is one check from the design's list. */
export type RephraseRejection =
  /** Check 1 — nothing, or nothing but whitespace, came back. */
  | 'empty'
  /** Check 1 — longer than `REPHRASE_MAX_CHARS`. */
  | 'too_long'
  /** Check 3 — the text named a verified condition that is not in scope. */
  | 'cross_contaminated';

export interface RephraseCheckTarget extends RephraseTarget {
  /**
   * The conditions this answer is legitimately allowed to name. Defaults to `entry.disease_name`
   * alone, which is the diagnosis path: one row, one condition.
   *
   * A parameter because the chat path (task 15.2) grounds an answer in *several* rows — a question
   * like "what is late blight?" resolves to both late blight rows — and there the other names are
   * in scope rather than contamination. Same check, different scope set.
   */
  readonly inScope?: readonly VerifiedCondition[] | undefined;
}

export interface RephraseCheck {
  /** What the farmer receives. Never empty, and always grounded in `entry`. */
  readonly text: string;
  /** Whether `text` is the model's prose or the static template built from the row. */
  readonly source: 'model' | 'static_template';
  /** Check 2 — true when the canonical name was missing and was prefixed on. */
  readonly repairedCanonicalName: boolean;
  /** Absent when the model's text was kept. Worth logging: it is a provider-quality signal. */
  readonly rejection?: RephraseRejection;
  /** Check 3 — out-of-scope condition names found. Non-empty only alongside a rejection. */
  readonly outOfScopeMentions: readonly VerifiedCondition[];
}

/**
 * Check 3 — verified condition names present in `text` that are not in `inScope`.
 *
 * Exported because it is pure and decides a farmer-visible outcome, so it is worth testing
 * directly (same reasoning as `matchConditions()` in `knowledge.ts`).
 *
 * Whitespace is collapsed before matching, so a name broken across a line wrap still matches, and
 * the comparison is case-insensitive, so a model that lowercased the name does not slip through.
 * None of the five names is a substring of another, so the scan needs no boundary handling.
 *
 * It is a scan for *names*, which is the honest limit of it: a paragraph describing late blight
 * without naming it passes. That is fine, because it is not what stops an ungrounded fact reaching
 * a farmer — see the block comment at the top of this section.
 */
export function outOfScopeConditionsIn(
  text: string,
  inScope: readonly VerifiedCondition[],
): readonly VerifiedCondition[] {
  const haystack = text.toLowerCase().replace(/\s+/g, ' ');
  return VERIFIED_CONDITIONS.filter(
    (condition) =>
      !inScope.includes(condition) && haystack.includes(condition.toLowerCase()),
  );
}

/**
 * Run the design's four post-generation checks over a model's rephrase, in the design's order.
 *
 *  1. **Non-empty, within `REPHRASE_MAX_CHARS`.** Failure goes straight to check 4.
 *  2. **The canonical name appears verbatim in Latin script** (Requirements 4.6, 9.4). If it does
 *     not, it is **prefixed on** — deterministically, in process, with no second model call. That
 *     restraint is Requirement 6.6's reasoning and D4's no-repair-re-ask rule applied one step
 *     later in the pipeline: a re-ask doubles provider spend to fix a formatting slip in text that
 *     is already grounded, and the fix does not need a model.
 *  3. **A deny-list scan for verified conditions not in scope.** Run *after* the repair, which is
 *     safe because the repair can only add an in-scope name.
 *  4. **Fall back to `staticExplanationFor()`** — the row itself, localized headings, no model —
 *     so the farmer still receives knowledge-base-grounded content. This is what keeps Requirement
 *     3.2 true when the language model is unhelpful.
 *
 * ### Two deliberate asymmetries
 *
 * **A deny-list hit falls back too, though the design names only check 1 as the fallback
 * trigger.** The design says check 3 "catch[es] a cross-contaminated answer" without stating the
 * remedy, and there are only two available: ship the text with the finding logged, or replace it.
 * Shipping loses — a cross-contaminated answer is prose about a disease the farmer does not have,
 * which is worse than the terse template, and re-asking is closed off by D4. So the caught text is
 * replaced by the row it should have been rephrasing. The finding is returned in
 * `outOfScopeMentions` either way, so a caller can log it.
 *
 * **Check 1 is not re-run after check 2's repair.** The prefix adds at most the canonical name
 * plus a newline — 20 code units for the longest of the five — and the ceiling sits ~2900 below
 * a messaging channel's per-message text limit. Re-checking would discard a fully grounded,
 * correctly named answer over 20 characters, which trades something a farmer needs for tidiness in
 * a number that has slack by construction.
 */
export function validateRephrased(candidate: string, target: RephraseCheckTarget): RephraseCheck {
  const { entry } = target;
  const inScope = target.inScope ?? [entry.disease_name];
  const trimmed = candidate.trim();

  // Check 1.
  if (trimmed.length === 0) return fallbackTo(target, 'empty', []);
  if (trimmed.length > REPHRASE_MAX_CHARS) return fallbackTo(target, 'too_long', []);

  // Check 2. `includes` is case-sensitive and exact, which is the point: Requirements 4.6 and 9.4
  // are about the canonical name surviving *unchanged*, so a transliteration or a lowercased copy
  // is a miss, and the miss is repaired by prefixing the real thing.
  //
  // The join is a newline and not a sentence. A localized connective ("This condition is…") would
  // have to be invented for three languages on a path where the model has just failed, and an
  // English one in front of a Marathi farmer reads as a bug; a bare `.` is wrong punctuation in
  // Devanagari, which ends a sentence with `।`. A line break is correct in every script and
  // asserts nothing.
  const repairedCanonicalName = !trimmed.includes(entry.disease_name);
  const text = repairedCanonicalName ? `${entry.disease_name}\n${trimmed}` : trimmed;

  // Check 3.
  const outOfScopeMentions = outOfScopeConditionsIn(text, inScope);
  if (outOfScopeMentions.length > 0) {
    return fallbackTo(target, 'cross_contaminated', outOfScopeMentions);
  }

  return { text, source: 'model', repairedCanonicalName, outOfScopeMentions: [] };
}

function fallbackTo(
  target: RephraseTarget,
  rejection: RephraseRejection,
  outOfScopeMentions: readonly VerifiedCondition[],
): RephraseCheck {
  return {
    text: staticExplanationFor(target.entry, target.language),
    source: 'static_template',
    repairedCanonicalName: false,
    rejection,
    outOfScopeMentions,
  };
}

/**
 * Check 4's fallback: the knowledge-base row rendered directly, with localized headings and no
 * model call.
 *
 * The canonical name leads, in Latin script, so Requirements 4.6 and 9.4 hold by construction on
 * this path. Headings come from the message catalogs — the same `symptomsHeading` /
 * `causesHeading` / `treatmentHeading` / `preventionHeading` strings the results screen uses — so
 * a farmer reads the same words here as everywhere else, and D5's rule that farmer-facing static
 * copy ships pre-translated in the repository is honoured rather than worked around.
 *
 * Treatment is omitted for a row with none, via the same `contentFieldsOf()` the prompt uses, so
 * Requirement 3.4 holds on the degraded path too — a healthy result cannot acquire treatment
 * content by way of a provider failure.
 *
 * ### What this path cannot do, stated plainly
 *
 * **The row's own sentences are not translated.** Translating them needs a model, and this
 * function exists precisely because the model just produced nothing usable; re-calling it is
 * exactly what D4 forbids. So the headings are in the farmer's language and the verified content
 * is in the language it is stored in. That is a real, partial shortfall against Requirement 9.3 on
 * this branch, taken knowingly: Requirement 3.2 — an explanation composed from the matching
 * knowledge-base entry — is the one a farmer can act on, and grounded-but-untranslated beats
 * localized-but-absent. It is also the reason this is a fallback and not a design.
 *
 * Items go one per line with no added punctuation, for the same reason the prompt block does:
 * appending a `.` would be wrong for a row stored in a script that does not use one, and this
 * function is not allowed to author a single character of content.
 */
export function staticExplanationFor(entry: KnowledgeEntry, language: Language): string {
  const { ui } = messages(language);
  const headings: Record<KbArrayField, string> = {
    symptoms: ui.symptomsHeading,
    causes: ui.causesHeading,
    treatment: ui.treatmentHeading,
    prevention: ui.preventionHeading,
  };

  // Annotated `string[]`: seeded from `entry.disease_name`, whose type is the five-name union, so
  // an inferred array would reject every heading and item line pushed onto it.
  const lines: string[] = [entry.disease_name];
  for (const field of contentFieldsOf(entry)) {
    lines.push(`${headings[field]}:`);
    for (const item of entry[field]) lines.push(`  ${item}`);
  }
  return lines.join('\n');
}

/* ========================================================================== */
/* 3. Chat over conversation context                                           */
/* ========================================================================== */

/**
 * The context-grounded chat request.
 *
 * Requirements: 4.4 (every symptom, cause, treatment and prevention statement a farmer reads in a
 *               chat answer is composed from Knowledge_Base entries), 4.5 (the request supplies the
 *               relevant entries and instructs the model to rephrase only the supplied content),
 *               4.6 / 9.4 (the Canonical_Disease_Name stays unchanged in every Supported_Language),
 *               7.3 (a subject-less follow-up resolves against the conversation's most recent
 *               Diagnosis_Result), 7.6 (a question with no verified content behind it gets the
 *               honest referral), 9.3 (the answer is returned in the requested language), 9.6 (a
 *               question written in a Supported_Language is answered in that language)
 * Design: "Prompting and grounding" → *3. Chat over conversation context*; D9
 *
 * ### THIS PROMPT IS THE SECOND LINE OF DEFENCE, NOT THE FIRST
 *
 * The design is explicit that out-of-scope (4.7) and unanswerable (7.6) questions are **not left to
 * the model's judgement**: `ChatService` resolves scope first, and an empty resolution set returns
 * the static localized referral with `needsExpert: true` and **no model call at all**. So this
 * function is only ever called with at least one `disease_knowledge` row in hand, and the fallback
 * rule below covers the harder middle case — rows exist, but they do not contain the answer.
 *
 * Read the rest of it the way section 2 asks to be read: the substantive guarantee is that the only
 * agricultural content in the request is the resolved rows, verbatim. The rules are requests.
 *
 * ### D9 — THE LANGUAGE OF THE MESSAGE IS THE MODEL'S TO RESOLVE
 *
 * Requirement 9.6 wants the answer in the language the farmer wrote in. Hindi and Marathi share
 * Devanagari, so no character-range check can tell them apart, and a script detector here would be
 * a guess dressed as a mechanism. The prompt therefore carries **both** the requested language and
 * the instruction to prefer the message's own language when it is one of the three. Requirement
 * 9.5's rejection of an unsupported explicit code stays at the API edge, where a 400 belongs.
 */

/**
 * One turn of the transcript, structurally satisfied by a `messages` row.
 *
 * Declared here rather than imported from `chat.service.ts` on purpose: that module imports this
 * one, and a type import back the other way would make the pair mutually dependent for no gain.
 * `role` reuses `MessageRole` from `schemas.ts`, so the labels a model sees are the same two words
 * the database stores (`0003`) rather than a second vocabulary for the same thing.
 */
export interface ChatTurn {
  readonly role: MessageRole;
  readonly content: string;
}

export interface ChatPromptTarget {
  /** The farmer's question, verbatim. */
  readonly question: string;
  /**
   * The rows `resolveScope()` put in scope, in canonical order. **Never empty** — the empty case is
   * `KnowledgeScope`'s `referral` variant and never reaches a prompt.
   */
  readonly entries: readonly KnowledgeEntry[];
  /**
   * The condition established by the conversation's most recent Diagnosis_Result, or `null` when
   * the conversation has none (or its most recent one was inconclusive). This is the subject a
   * subject-less follow-up resolves against (Requirement 7.3).
   */
  readonly condition: VerifiedCondition | null;
  /**
   * The conversation so far, oldest → newest, already bounded by `ChatService`'s row cap and token
   * budget. **This is the transcript BEFORE this turn**: the current question travels in
   * `question`, so a caller that persists the farmer message before answering must not also pass
   * it here, or the model reads it twice.
   */
  readonly recentMessages: readonly ChatTurn[];
  /** The requested/preferred language — one half of D9's pair. */
  readonly language: Language;
}

/** The design's `{canonical_name | none}` when the conversation has no condition yet. */
const NO_CURRENT_DIAGNOSIS = 'none';

/** `English, Hindi or Marathi`, derived so a fourth supported language extends the rule. */
const LANGUAGE_PHRASE = joinWithOr(Object.values(LANGUAGE_NAMES));

/**
 * Collapse whitespace so a farmer-supplied string stays on the line it was put on.
 *
 * The question and the transcript are the only **untrusted** content in any Jamee prompt. A newline
 * inside one would let it appear to open a block of its own — a line reading `VERIFIED CONTENT:`
 * followed by invented treatment advice — and the label layout is what tells the model which content
 * is verified. Collapsing keeps the structure intact.
 *
 * What it does **not** do is stop a farmer writing `VERIFIED CONTENT: …` inline, and it is not
 * relied on to: the guarantee is still structural, because the only agronomic content in the request
 * is the resolved rows, and `validateRephrased()`'s deny-list scan catches an answer that names a
 * condition outside them (Requirement 4.4).
 */
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `  farmer: why?` per turn, in transcript order. */
function transcriptBlock(turns: readonly ChatTurn[]): string {
  return turns.map((turn) => `  ${turn.role}: ${singleLine(turn.content)}`).join('\n');
}

/**
 * The chat request for one turn (Requirements 4.4, 4.5, 7.3, 9.6).
 *
 * ### Layout deviations from the design, and why
 *
 * The design renders `CURRENT DIAGNOSIS` and `RECENT MESSAGES` on one line and `VERIFIED CONTENT`
 * on the next, with `{…}` placeholders standing in for content whose layout was therefore never
 * pinned. Three things are laid out differently here:
 *
 *  1. **One label per line, and the rows through `verifiedContentBlock()`** — the same function
 *     section 2 uses, so a row reaches a model in exactly one format whichever prompt carries it,
 *     and every stored sentence crosses verbatim (that function's comment explains why a `; ` join
 *     could not).
 *  2. **The question is its own labelled line.** The design's first sentence refers to "the
 *     farmer's question" without showing where it sits; labelling it means the newest turn cannot
 *     be mistaken for context, and it keeps `recentMessages` a pure record of what came before.
 *  3. **`FALLBACK SENTENCE` is emitted, and read from the catalog rather than passed in.** The
 *     design's rule says "reply exactly with the supplied fallback sentence", which only works if
 *     the sentence is in fact supplied. It is Requirement 7.6's own copy — the same string
 *     `ChatService` returns when scope resolution comes back empty — so the two paths cannot drift
 *     into two different admissions of the same thing. It is rendered in the requested language,
 *     which is the one language known here; D9's whole point is that the message's language is not.
 *
 * An absent `RECENT MESSAGES` block is omitted entirely rather than emitted empty, for the reason
 * `contentFieldsOf()` gives: an empty label in a prompt is an invitation to fill it.
 */
export function chatPrompt(target: ChatPromptTarget): string {
  const { entries, condition, language, recentMessages } = target;

  return [
    `Answer the farmer's question using ONLY the verified content supplied.`,
    ``,
    `QUESTION: ${singleLine(target.question)}`,
    `CURRENT DIAGNOSIS: ${condition ?? NO_CURRENT_DIAGNOSIS}`,
    ...(recentMessages.length === 0 ? [] : [`RECENT MESSAGES:`, transcriptBlock(recentMessages)]),
    `VERIFIED CONTENT (the only facts you may use):`,
    entries.map((entry) => verifiedContentBlock(entry)).join('\n'),
    `FALLBACK SENTENCE: ${messages(language).chat.noVerifiedInfo}`,
    ``,
    `Rules:`,
    // Requirement 7.3 — the subject of "why?" is the conversation's diagnosis, not a guess. The two
    // examples are the design's, and they stay English because the surrounding prompt is.
    `- If the question has no explicit subject (e.g. "why?", "how much?"), it refers`,
    `  to CURRENT DIAGNOSIS.`,
    // Requirements 7.6, 4.7 — the middle case: rows are in scope but do not answer the question.
    `- If the answer is not in VERIFIED CONTENT, reply with exactly the FALLBACK`,
    `  SENTENCE and nothing else.`,
    // Requirements 9.6, 9.3 — D9's pair: the message's language first, the requested one otherwise.
    `- Reply in the language of the farmer's message when it is ${LANGUAGE_PHRASE};`,
    `  otherwise reply in ${LANGUAGE_NAMES[language]}.`,
    // Requirements 4.6, 9.4 — the canonical name survives translation untouched. Check 2 of
    // `validateRephrased()` is what happens when this instruction is not followed.
    `- Write every disease name exactly as it appears above, in Latin script. Do not`,
    `  translate or transliterate it.`,
    // Requirement 4.4 — the same four temptations section 2 names, for the same reason: the seeded
    // `treatment` arrays deliberately omit them.
    `- Add no disease, symptom, cause, chemical, dose, brand, or timing that is not`,
    `  written above.`,
    `- No greetings, no disclaimers, no markdown.`,
  ].join('\n');
}
