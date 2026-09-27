import { ObjectId } from 'mongodb';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner, TextCall } from '@/lib/ai/capabilities';
import type { DiagnosisRecord, MessageRecord } from '@/lib/db/reads';
import { REPHRASE_REJECTED_REASON, type UsageLogInsert } from '@/lib/db/usage-log';
import { AppError } from '@/lib/errors';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import {
  PROMPT_VERSION,
  REPHRASE_MAX_CHARS,
  outOfScopeConditionsIn,
  staticExplanationFor,
} from '@/lib/prompts';
import {
  HEALTHY_CONDITION,
  SUPPORTED_LANGUAGES,
  VERIFIED_CONDITIONS,
  type Channel,
  type ChatInput,
  type Language,
  type VerifiedCondition,
} from '@/lib/schemas';
import {
  chatAnswerer,
  type ChatTurnDeps,
  type ChatWriteStore,
  type ContextMessage,
  type ContextStore,
  type MessageInsert,
} from '@/services/chat.service';
import { ownsRequest, type CounterRpc } from '@/services/quota.service';

/**
 * ### Property 11: Chat answers are grounded only in resolved knowledge base entries
 *
 * *"For any farmer question that resolves to a non-empty set of knowledge base rows, the answer is
 * generated from a request containing only those rows plus a rephrase-only instruction, and the
 * answer introduces no verified condition outside the resolved set."*
 *
 * **Validates: Requirements 4.4, 4.5**
 *
 * =============================================================================
 * WHERE THE PROPERTY IS OBSERVED
 * =============================================================================
 *
 * A whole chat turn, through `chatAnswerer()` — the bound `ChatService` both channels call — with
 * every seam injected: the context reads, the knowledge reader, the counter RPC, the write store and
 * the capability runner. So there is no Supabase stack and no provider, and the three things the
 * property is *about* are directly observable: the exact prompt handed to the text seam, the exact
 * answer handed back to the caller, and the exact answer persisted as the Jamee message.
 *
 * The turn rather than `answerQuestion()` alone, because Requirement 4.4 is about what a farmer
 * *reads*, and what a farmer reads on the web and on WhatsApp is the persisted `messages` row. A
 * grounded answer that was persisted as something else would satisfy the read half and still fail
 * the requirement, so both are compared.
 *
 * The knowledge reader is stocked with **all five** rows, not just the resolved ones. A grounding
 * step that read more than it needed, or that mixed an unresolved row into the request, would
 * therefore have material available to leak — and the assertions below would see it. A reader
 * holding only the resolved rows would have made "only those rows" true by fixture rather than by
 * code. The transcript is stocked the same way: every context message carries its own token, so a
 * step that folded the window into the verified-content block would be caught rather than assumed
 * impossible.
 *
 * =============================================================================
 * HOW "ONLY THOSE ROWS" AND "NO CONDITION OUTSIDE THE SET" ARE ASSERTED
 * =============================================================================
 *
 * Every generated row is built from **tagged statements**: each array item begins with a token that
 * names its row, its column and its index (`KB1A2B-symptoms-0 dark rings on the older leaves`). The
 * five rows of a run get five distinct tags. That turns both halves of the property into containment
 * assertions rather than existence ones:
 *
 *  - **The request.** The lines between `VERIFIED CONTENT` and `FALLBACK SENTENCE` are compared,
 *    line for line, against the block this run's resolved rows must render to — canonical name,
 *    one label per non-empty column, one line per item, rows in canonical order. A request carrying
 *    an unresolved row, a reordered array, a re-punctuated sentence, a dropped column or an extra
 *    line fails that single comparison. No decoy tag may appear anywhere in the prompt, and no
 *    transcript token may appear inside the block.
 *  - **The answer.** Every tagged statement found in the farmer's answer must be one of the
 *    resolved rows' items, and must appear verbatim rather than merely by its token. A decoy tag
 *    anywhere in either the prompt or the answer fails the run, and
 *    `outOfScopeConditionsIn(answer, resolved)` must be empty — which is Property 11's third clause
 *    stated in the same function the service itself uses to enforce it.
 *
 * `groundedIn` is checked against the conditions the fixture computed, and the knowledge read is
 * checked to be exactly one call for exactly those names: "the resolved set" is then what the
 * service asked for, not what the fixture happened to hold.
 *
 * =============================================================================
 * THE THIRD CLAUSE'S BOUNDARY, STATED RATHER THAN QUIETLY NARROWED
 * =============================================================================
 *
 * Requirement 4.4's "every statement is composed from Knowledge_Base entries" is enforced
 * **structurally, on the request side**, exactly as Property 10 records for the diagnosis path: the
 * only agricultural content in the request is the resolved rows, so there is no unverified fact
 * available for the model to rephrase. The `invents_agronomy` class exists to *show* that boundary
 * rather than to hide it — a provider that fabricates a non-condition sentence anyway has its prose
 * kept, because no check can tell an invented agronomic sentence from a rephrased one. What that
 * class asserts is the part that is Jamee's to guarantee: the fabricated token was never in the
 * request, and every resolved row's own content reaches the farmer unaltered.
 *
 * A fabricated *condition name* is a different matter — it is detectable, check 3 of
 * `validateRephrased()` catches it, and the `names_out_of_scope_condition` class asserts the farmer
 * gets the primary row's own template instead.
 *
 * =============================================================================
 * WHAT THIS PROPERTY DELIBERATELY DOES NOT CLAIM
 * =============================================================================
 *
 * **Which rows a question resolves to** is scope resolution's business (`matchConditions()` in
 * `knowledge.ts`), and it is stated here by fixture rather than computed: each question case carries
 * the set its own vocabulary puts in scope, written out by hand. Computing it with the function
 * under test would have made every containment assertion agree with the code by construction.
 *
 * **The referral branch** — a question that resolves to nothing — is Property 14's, in
 * `referral.property.test.ts`. Every case here resolves to at least one row, which is Property 11's
 * own premise.
 *
 * **The window's contents and its bounds** are Property 15's. The transcript is present so a leak
 * has something to leak, and nothing here asserts what the window should have contained.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const FARMER = '33333333-3333-4333-8333-333333333333';
/** Under A3 a conversation `_id` is a 24-hex ObjectId; the scope check compares its `toHexString()`. */
const THREAD = '44444444444444444444444a';
const THREAD_OID = new ObjectId(THREAD);
const DIAGNOSIS_OID = new ObjectId('77777777777777777777777a');

/** 2026-09-15T19:30:00Z. Fixed so the run owns its clock and never reads the wall clock. */
const NOW_MS = Date.parse('2026-09-15T19:30:00.000Z');

/** The four agronomic columns, in the order a farmer needs them and the prompt renders them. */
const KB_FIELDS = ['symptoms', 'causes', 'treatment', 'prevention'] as const;
type KbField = (typeof KB_FIELDS)[number];

/**
 * Clause tails for the generated statements.
 *
 * Realistic agronomy, and deliberately free of any verified condition name, so the deny-list scan
 * never fires on a row's own content. Short, because a chat answer grounded in up to five rows has
 * to stay under `REPHRASE_MAX_CHARS` for the classes that are meant to be *kept* — a fixture that
 * drifted past the ceiling would silently turn `faithful` into `too_long` and pass for the wrong
 * reason. `assertUnderCeiling()` below is the guard that keeps that honest rather than assumed.
 */
const TAILS: readonly string[] = [
  'dark rings on the older leaves',
  'a yellow halo around each spot',
  'lower leaves dry and drop early',
  'warm humid weather and long leaf wetness',
  'spores surviving on crop debris',
  'remove and destroy affected leaves',
  'water at the base, keep foliage dry',
  'rotate away from solanaceous crops',
];

/** Every tagged knowledge-base statement, whichever row it came from. */
const KB_STATEMENT = /KB[0-9A-F]{4}-(?:symptoms|causes|treatment|prevention)-\d+/g;

/** Every tagged transcript turn. Present in the window, and never in the verified-content block. */
const TRANSCRIPT_TOKEN = /TX[0-9A-F]{4}-\d+/g;

/**
 * `disease_knowledge.crop`, which the database constrains to two values.
 *
 * A `Record<VerifiedCondition, …>` rather than the first word of the name: exhaustive, so a sixth
 * verified condition breaks this fixture until it has a crop instead of silently generating a row
 * the `crop` check constraint would reject.
 */
const CROP_OF: Record<VerifiedCondition, KnowledgeEntry['crop']> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

const CONTENT_HEADER = 'VERIFIED CONTENT (the only facts you may use):';
const FALLBACK_PREFIX = 'FALLBACK SENTENCE: ';

/**
 * The chat path's rephrase-only instruction, in the prompt's own words.
 *
 * Requirement 4.5 asks for two things in one request — the relevant content, and the instruction to
 * rephrase only it — so the second is asserted as literally as the first. Both fragments are
 * required: the opening sentence scopes the whole answer to the supplied content, and the rule
 * enumerates what may not be added to it.
 */
const REPHRASE_ONLY_FRAGMENTS: readonly string[] = [
  `Answer the farmer's question using ONLY the verified content supplied.`,
  ['- Add no disease, symptom, cause, chemical, dose, brand, or timing that is not', '  written above.'].join(
    '\n',
  ),
];

/* ========================================================================== */
/* Row construction                                                            */
/* ========================================================================== */

/** `KB1A2B` — one tag per row, distinct across the five rows of a run. */
function tagFor(seed: number, index: number): string {
  return `KB${(seed + index).toString(16).toUpperCase()}`;
}

function statementsFor(tag: string, field: KbField, tails: readonly string[]): string[] {
  return tails.map((tail, index) => `${tag}-${field}-${index} ${tail}`);
}

type Tails = Record<KbField, readonly string[]>;

function rowFor(condition: VerifiedCondition, tag: string, tails: Tails): KnowledgeEntry {
  const healthy = condition === HEALTHY_CONDITION;
  return {
    id: `0000000000000000${tag.slice(2).toLowerCase().padStart(8, '0')}`,
    disease_name: condition,
    crop: CROP_OF[condition],
    scientific_name: healthy ? null : `${tag} pathogen`,
    symptoms: statementsFor(tag, 'symptoms', tails.symptoms),
    causes: statementsFor(tag, 'causes', tails.causes),
    // Requirement 3.4 and the `healthy_has_no_treatment` check constraint: the healthy row's
    // treatment array is empty. Generated that way so the prompt's column-omission path is
    // exercised by a row shape the database actually admits.
    treatment: healthy ? [] : statementsFor(tag, 'treatment', tails.treatment),
    prevention: statementsFor(tag, 'prevention', tails.prevention),
    default_severity: healthy ? 'none' : 'moderate',
    source: `${tag} extension bulletin`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/** The row's four arrays concatenated in column order — the whole of what it may contribute. */
function statementsOf(entry: KnowledgeEntry): readonly string[] {
  return KB_FIELDS.flatMap((field) => entry[field]);
}

function nonEmptyFieldsOf(entry: KnowledgeEntry): readonly KbField[] {
  return KB_FIELDS.filter((field) => entry[field].length > 0);
}

/** The lines one row must render to inside a `VERIFIED CONTENT` block. */
function blockLinesOf(entry: KnowledgeEntry): readonly string[] {
  const lines: string[] = [`  disease: ${entry.disease_name}`];
  for (const field of nonEmptyFieldsOf(entry)) {
    lines.push(`  ${field}:`);
    for (const item of entry[field]) lines.push(`    - ${item}`);
  }
  return lines;
}

function canonicalIndexOf(name: VerifiedCondition): number {
  return VERIFIED_CONDITIONS.indexOf(name);
}

/** Canonical order, which is the order `resolveScope()` promises and `groundedIn` carries. */
function orderCanonically(names: readonly VerifiedCondition[]): readonly VerifiedCondition[] {
  return [...new Set(names)].sort((a, b) => canonicalIndexOf(a) - canonicalIndexOf(b));
}

function rowOf(rows: readonly KnowledgeEntry[], name: VerifiedCondition): KnowledgeEntry {
  const row = rows.find((entry) => entry.disease_name === name);
  if (row === undefined) throw new Error(`no generated row for "${name}"`);
  return row;
}

/* ========================================================================== */
/* The questions, and the rows each one's own vocabulary puts in scope          */
/* ========================================================================== */

/**
 * The five tiers of scope resolution a chat question can land on, one case each.
 *
 * `matched` is written out by hand rather than computed with `matchConditions()`: the point of the
 * containment assertions is that the *code* put exactly these rows in the request, and an
 * expectation derived from the same matcher would agree with any matcher.
 */
type QuestionKind =
  /** Crop and qualifier — one row. */
  | 'explicit_condition'
  /** The crop alone — both rows of that crop. */
  | 'crop_only'
  /** The qualifier alone — that qualifier across both crops. */
  | 'qualifier_only'
  /** One qualifier word — every row carrying it. */
  | 'loose_qualifier'
  /** No vocabulary at all: the subject comes from the conversation's diagnosis (Requirement 7.3). */
  | 'subject_less'
  /** Devanagari, which contributes no Latin tokens — the same route, stated rather than implied. */
  | 'devanagari_follow_up';

interface QuestionCase {
  readonly kind: QuestionKind;
  readonly text: string;
  /** The rows this question's own words put in scope. */
  readonly matched: readonly VerifiedCondition[];
  /** True when the question needs the conversation's diagnosis to be in scope at all. */
  readonly needsCondition: boolean;
}

const QUESTION_CASES: readonly QuestionCase[] = [
  {
    kind: 'explicit_condition',
    text: 'my tomato has late blight, what should I do now?',
    matched: ['Tomato Late Blight'],
    needsCondition: false,
  },
  {
    kind: 'crop_only',
    text: 'what are these spots on my potato leaves?',
    matched: ['Potato Early Blight', 'Potato Late Blight'],
    needsCondition: false,
  },
  {
    kind: 'qualifier_only',
    text: 'what is late blight?',
    matched: ['Tomato Late Blight', 'Potato Late Blight'],
    needsCondition: false,
  },
  {
    kind: 'loose_qualifier',
    text: 'is this blight?',
    matched: ['Tomato Early Blight', 'Tomato Late Blight', 'Potato Early Blight', 'Potato Late Blight'],
    needsCondition: false,
  },
  {
    kind: 'subject_less',
    text: 'why?',
    matched: [],
    needsCondition: true,
  },
  {
    kind: 'devanagari_follow_up',
    text: 'हे का झाले?',
    matched: [],
    needsCondition: true,
  },
];

/* ========================================================================== */
/* What the model does with the request                                        */
/* ========================================================================== */

/**
 * The provider behaviours, enumerated so the run can prove it exercised every one.
 *
 * A property over a `constantFrom` can pass while a branch never generates, and a mis-stated
 * expectation for that branch is then green rather than absent. The predicate records the kind it
 * saw and the coverage assertion after the run turns "these were covered" into a claim.
 */
const MODEL_KINDS = [
  /** Prose built from the resolved rows, naming the primary condition. Kept. */
  'faithful',
  /** The same prose with the name dropped — check 2 prefixes it back on. Kept. */
  'omits_canonical_name',
  /** The same prose naming a condition outside the resolved set — check 3 refuses it. Template. */
  'names_out_of_scope_condition',
  /** Nothing, or nothing but whitespace — check 1. Template. */
  'empty',
  /** Past `REPHRASE_MAX_CHARS` — check 1. Template. */
  'too_long',
  /** A fabricated non-condition statement. Kept — see the header's boundary note. */
  'invents_agronomy',
  /** The chain is exhausted. Template, audited as a provider error, and never a farmer-facing throw. */
  'provider_failed',
  /**
   * The gateway declined to start on the request's own budget. Template, audited as a timeout, and
   * still not `DIAGNOSIS_TIMEOUT` to the farmer: that code's copy tells them to resend a photo they
   * never sent (`chat.service.ts`, *A model failure degrades; it does not surface as a timeout*).
   */
  'budget_exhausted',
] as const;

type ModelKind = (typeof MODEL_KINDS)[number];

/** Which branch of the answer step produced the text, read off the audit row rather than guessed. */
type ExpectedPath = 'model_prose' | 'row_template';

function expectedPathOf(kind: ModelKind): ExpectedPath {
  return kind === 'faithful' || kind === 'omits_canonical_name' || kind === 'invents_agronomy'
    ? 'model_prose'
    : 'row_template';
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const languageArb = fc.constantFrom<Language>(...SUPPORTED_LANGUAGES);
const channelArb = fc.constantFrom<Channel>('web', 'telegram');

/** One to two statements per column: enough for order and containment, short enough to stay terse. */
const tailsArb = fc.subarray([...TAILS], { minLength: 1, maxLength: 2 });

const tailsRecordArb: fc.Arbitrary<Tails> = fc.record({
  symptoms: tailsArb,
  causes: tailsArb,
  treatment: tailsArb,
  prevention: tailsArb,
});

/**
 * `seed + 4` stays inside four hex digits, so all five tags of a run are four uppercase hex
 * characters and all five are distinct.
 */
const seedArb = fc.integer({ min: 0x1000, max: 0xfff0 });

/** `INV1A2B` — a token shape that appears in no row, so its provenance is unambiguous. */
const inventionTagArb = fc
  .integer({ min: 0x1000, max: 0xffff })
  .map((raw) => `INV${raw.toString(16).toUpperCase()}`);

interface Scenario {
  readonly modelKind: ModelKind;
  readonly question: QuestionCase;
  readonly condition: VerifiedCondition;
  /**
   * Whether the conversation has an identified diagnosis behind it.
   *
   * Weighted two-to-one towards "it does", because the widest resolved sets need both a question
   * that matches four rows and a diagnosis that adds the fifth — and a set of five is where the
   * `names_out_of_scope_condition` class has nothing left to name.
   */
  readonly hasDiagnosis: boolean;
  readonly seed: number;
  readonly tails: Tails;
  readonly language: Language;
  readonly channel: Channel;
  /** Turns of transcript ahead of this question. Zero exercises the omitted-block path. */
  readonly turns: number;
  readonly inventionTag: string;
  /** Which condition outside the resolved set the contamination class drags in. */
  readonly otherOffset: number;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  modelKind: fc.constantFrom<ModelKind>(...MODEL_KINDS),
  question: fc.constantFrom<QuestionCase>(...QUESTION_CASES),
  condition: fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS),
  hasDiagnosis: fc.constantFrom(true, true, false),
  seed: seedArb,
  tails: tailsRecordArb,
  language: languageArb,
  channel: channelArb,
  turns: fc.integer({ min: 0, max: 2 }),
  inventionTag: inventionTagArb,
  otherOffset: fc.integer({ min: 1, max: VERIFIED_CONDITIONS.length - 1 }),
});

/* ========================================================================== */
/* The prose a provider returns                                                */
/* ========================================================================== */

/**
 * The statements a faithful answer is built from: the primary row in full, plus the opening
 * statement of every other resolved row.
 *
 * Built from the rows the test already holds — never from the prompt. Reading the prompt to build
 * the answer would make containment circular: any request would produce a "grounded" answer.
 * Bounded this way rather than "every statement of every resolved row" for one stated reason: five
 * rows in full can exceed `REPHRASE_MAX_CHARS`, and an answer that tripped check 1 would be
 * asserted as a kept answer while actually being a rejected one.
 */
function selectedStatements(
  entries: readonly KnowledgeEntry[],
  primary: KnowledgeEntry,
): readonly string[] {
  const own = statementsOf(primary);
  const others = entries
    .filter((entry) => entry.disease_name !== primary.disease_name)
    .flatMap((entry) => statementsOf(entry).slice(0, 1));
  return [...own, ...others];
}

function proseFrom(statements: readonly string[], name: string | null): string {
  const sentences = statements.map((statement) => `${statement}.`);
  return (name === null ? sentences : [name, ...sentences]).join(' ');
}

function overlongProse(statements: readonly string[], name: string): string {
  const sentences = statements.map((statement) => `${statement}.`);
  const parts: string[] = [name];
  while (parts.join(' ').length <= REPHRASE_MAX_CHARS) parts.push(...sentences);
  return parts.join(' ');
}

/** What the text seam does for this scenario: a string to return, or a failure to raise. */
type Behaviour = { readonly text: string } | { readonly fail: AppError };

function behaviourFor(options: {
  readonly kind: ModelKind;
  readonly statements: readonly string[];
  readonly primaryName: VerifiedCondition;
  readonly other: VerifiedCondition | null;
  readonly inventionTag: string;
}): Behaviour {
  const { kind, statements, primaryName } = options;
  switch (kind) {
    case 'faithful':
      return { text: proseFrom(statements, primaryName) };
    case 'omits_canonical_name':
      return { text: proseFrom(statements, null) };
    case 'names_out_of_scope_condition': {
      if (options.other === null) {
        throw new Error('the contamination class needs a condition outside the resolved set');
      }
      return { text: `${proseFrom(statements, primaryName)} Compare with ${options.other}.` };
    }
    case 'empty':
      return { text: '  \n\t ' };
    case 'too_long':
      return { text: overlongProse(statements, primaryName) };
    case 'invents_agronomy':
      return {
        text: `${proseFrom(statements, primaryName)} ${options.inventionTag}-0 spray a copper fungicide at the first sign.`,
      };
    case 'provider_failed':
      // Requirement 14.5's exhausted chain. `chat.service.ts` degrades on it rather than throwing.
      return {
        fail: new AppError('PROVIDERS_UNAVAILABLE', { context: { reason: 'test_chain_exhausted' } }),
      };
    case 'budget_exhausted':
      // What `run()` raises when the request's own budget cannot cover an attempt. Degraded here
      // for the copy reason the header states, never surfaced to the farmer.
      return {
        fail: new AppError('DIAGNOSIS_TIMEOUT', { context: { budgetExhausted: true } }),
      };
  }
}

/* ========================================================================== */
/* The harness — every seam injected, the request captured                     */
/* ========================================================================== */

interface Recorded {
  /** Every prompt the text seam was handed, in order. Exactly one on every grounded path. */
  readonly prompts: string[];
  /** Every name set the knowledge reader was asked for. */
  readonly knowledgeReads: VerifiedCondition[][];
  readonly messageRows: MessageInsert[];
  readonly usageRows: UsageLogInsert[];
  readonly touched: string[];
  counts: { classify: number; generate: number; increments: number; decrements: number };
}

interface Harness {
  readonly deps: ChatTurnDeps;
  readonly recorded: Recorded;
}

function harness(options: {
  /** All five rows, so a step that read too much has something to leak. */
  readonly rows: readonly KnowledgeEntry[];
  /** The window, oldest → newest. The store hands it back newest-first, as the index does. */
  readonly transcript: readonly ContextMessage[];
  readonly latestDiagnosis: DiagnosisRecord | null;
  readonly behaviour: Behaviour;
}): Harness {
  const recorded: Recorded = {
    prompts: [],
    knowledgeReads: [],
    messageRows: [],
    usageRows: [],
    touched: [],
    counts: { classify: 0, generate: 0, increments: 0, decrements: 0 },
  };

  let used = 0;

  const rpc: CounterRpc = {
    tryIncrement: (args) => {
      recorded.counts.increments += 1;
      if (used >= args.limit) return Promise.resolve(null);
      used += 1;
      return Promise.resolve(used);
    },
    decrement: () => {
      recorded.counts.decrements += 1;
      // `and used > 0` in the SQL: a decrement that matches no row returns NULL.
      if (used === 0) return Promise.resolve(null);
      used -= 1;
      return Promise.resolve(used);
    },
    used: () => Promise.resolve(used),
  };

  const store: ContextStore = {
    recentMessages: (_scope, limit) =>
      Promise.resolve([...options.transcript].reverse().slice(0, limit)),
    latestDiagnosis: () => Promise.resolve(options.latestDiagnosis),
  };

  const knowledge: KnowledgeReader = (names) => {
    recorded.knowledgeReads.push([...names]);
    return Promise.resolve(options.rows.filter((row) => names.includes(row.disease_name)));
  };

  const models: CapabilityRunner = {
    classify: () => {
      // A chat turn classifies nothing. Counted so "exactly one model call" is a count, not a hope.
      recorded.counts.classify += 1;
      return Promise.reject(new Error('a chat turn must not call the vision capability'));
    },
    generate: (call: TextCall) => {
      recorded.counts.generate += 1;
      recorded.prompts.push(call.prompt);
      if ('fail' in options.behaviour) return Promise.reject(options.behaviour.fail);
      return Promise.resolve({
        value: options.behaviour.text,
        provider: 'gemini' as const,
        usedFallback: false,
      });
    },
  };

  const writes: ChatWriteStore = {
    ownsConversation: (conversationId, userId) =>
      Promise.resolve(conversationId === THREAD && userId === FARMER),
    insertTurn: (pair) => {
      recorded.messageRows.push(...pair);
      const stored: MessageRecord[] = pair.map((row, index) => ({
        _id: new ObjectId(index === 0 ? '55555555555555555555555a' : '66666666666666666666666a'),
        ownerId: row.ownerId,
        conversationId: new ObjectId(row.conversationId),
        role: row.role,
        content: row.content,
        language: row.language,
        channel: row.channel,
        inputKind: row.inputKind,
        transcriptOf:
          row.transcriptOf === undefined
            ? null
            : { fileId: new ObjectId(row.transcriptOf.fileId), kind: row.transcriptOf.kind },
        createdAt: new Date(NOW_MS),
      }));
      return Promise.resolve(stored);
    },
    insertUsageLog: (row) => {
      recorded.usageRows.push(row);
      return Promise.resolve();
    },
    touchConversation: (conversationId) => {
      recorded.touched.push(conversationId);
      return Promise.resolve(true);
    },
  };

  return {
    recorded,
    deps: {
      store,
      writes,
      knowledge,
      models,
      quota: { rpc, now: new Date(NOW_MS) },
      now: () => NOW_MS,
      // `getDeadline()` answers `undefined` outside a platform invocation; stating it keeps the run
      // independent of whether the process happens to be inside one.
      platformDeadline: () => undefined,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Context fixtures                                                            */
/* -------------------------------------------------------------------------- */

function transcriptFor(seed: number, turns: number): readonly ContextMessage[] {
  const tag = `TX${(seed & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
  return Array.from({ length: turns }, (_unused, index) => ({
    _id: new ObjectId(`10000000000000000000000${index}`.slice(0, 24)),
    ownerId: FARMER,
    conversationId: THREAD_OID,
    role: index % 2 === 0 ? ('farmer' as const) : ('jamee' as const),
    content: `${tag}-${index} an earlier turn of this thread`,
    language: 'en' as const,
    channel: 'web' as const,
    inputKind: 'text' as const,
    transcriptOf: null,
    createdAt: new Date(NOW_MS - (turns - index) * 60_000),
  }));
}

function diagnosisRow(condition: VerifiedCondition, knowledgeId: string): DiagnosisRecord {
  return {
    _id: DIAGNOSIS_OID,
    ownerId: FARMER,
    conversationId: THREAD_OID,
    status: 'identified',
    diseaseName: condition,
    knowledgeId: new ObjectId(knowledgeId),
    confidence: 0.87,
    severity: 'moderate',
    explanation: 'an earlier diagnosis of this conversation',
    language: 'en',
    needsExpert: false,
    channel: 'web',
    mediaRef: { fileId: new ObjectId('a11111111111111111111111'), kind: 'crop-image' },
    fullImageDeletedAt: null,
    modelProvider: 'gemini',
    createdAt: new Date(NOW_MS - 300_000),
  };
}

/* -------------------------------------------------------------------------- */
/* Readers over the prompt                                                     */
/* -------------------------------------------------------------------------- */

/** The lines between the content header and the fallback sentence — the verified-content block. */
function verifiedContentLines(prompt: string): readonly string[] {
  const lines = prompt.split('\n');
  const from = lines.indexOf(CONTENT_HEADER);
  const to = lines.findIndex((line) => line.startsWith(FALLBACK_PREFIX));
  if (from < 0 || to <= from) {
    throw new Error('the chat request has no VERIFIED CONTENT block ahead of its fallback sentence');
  }
  return lines.slice(from + 1, to);
}

/** Every tagged knowledge statement present in a string, in order of appearance. */
function kbTokensIn(text: string): readonly string[] {
  return text.match(KB_STATEMENT) ?? [];
}

function transcriptTokensIn(text: string): readonly string[] {
  return text.match(TRANSCRIPT_TOKEN) ?? [];
}

/** The token that opens a statement — `KB1A2B-symptoms-0`. */
function tokenOf(statement: string): string {
  return statement.split(' ')[0] ?? statement;
}

/**
 * A fixture invariant, not a claim about Jamee: prose meant to be kept has to be admissible.
 *
 * Asserted rather than trusted because the failure it guards against is silent — a `faithful` answer
 * over the ceiling is rejected by check 1, and the run would then be asserting the template path's
 * facts about a class documented as the kept one.
 */
function assertUnderCeiling(text: string, label: string): void {
  expect(text.length, `${label}: fixture prose is past REPHRASE_MAX_CHARS`).toBeLessThanOrEqual(
    REPHRASE_MAX_CHARS,
  );
}

/* ========================================================================== */
/* Property 11                                                                 */
/* ========================================================================== */

describe('Property 11: chat answers are grounded only in resolved knowledge base entries', () => {
  it('builds every chat request from the resolved rows alone, and keeps the answer inside them', async () => {
    const modelKindsSeen = new Set<ModelKind>();
    const questionKindsSeen = new Set<QuestionKind>();
    const languagesSeen = new Set<Language>();
    const pathsSeen = new Set<ExpectedPath>();
    const scopeSizesSeen = new Set<number>();
    const primaryShapesSeen = new Set<'empty' | 'populated'>();

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { question, language, channel } = scenario;

        /* ================================================================== */
        /* The world: five rows, one resolved set, four-or-fewer decoys        */
        /* ================================================================== */

        const rows = VERIFIED_CONDITIONS.map((name, index) =>
          rowFor(name, tagFor(scenario.seed, index), scenario.tails),
        );

        // Requirement 7.3's subject, when the conversation has one. `needsCondition` cases have no
        // vocabulary of their own, so they resolve to nothing without it — which is Property 14's
        // premise, not this one's.
        const condition =
          question.needsCondition || scenario.hasDiagnosis ? scenario.condition : null;

        const expectedConditions = orderCanonically([
          ...(condition === null ? [] : [condition]),
          ...question.matched,
        ]);
        const expectedEntries = expectedConditions.map((name) => rowOf(rows, name));
        const decoys = rows.filter((row) => !expectedConditions.includes(row.disease_name));

        const first = expectedEntries[0];
        if (first === undefined) throw new Error('Property 11 needs a non-empty resolved set');
        const primary = condition === null ? first : rowOf(rows, condition);

        // The condition the contamination class names. Absent exactly when the resolved set is all
        // five rows, and then there is no out-of-scope name to fabricate: that run runs the faithful
        // behaviour instead, and records the kind it actually exercised.
        const outside = VERIFIED_CONDITIONS.filter((name) => !expectedConditions.includes(name));
        const other =
          outside.length === 0
            ? null
            : (outside[(scenario.otherOffset - 1) % outside.length] ?? null);
        const modelKind: ModelKind =
          scenario.modelKind === 'names_out_of_scope_condition' && other === null
            ? 'faithful'
            : scenario.modelKind;

        modelKindsSeen.add(modelKind);
        questionKindsSeen.add(question.kind);
        languagesSeen.add(language);
        pathsSeen.add(expectedPathOf(modelKind));
        scopeSizesSeen.add(expectedConditions.length);
        primaryShapesSeen.add(primary.treatment.length === 0 ? 'empty' : 'populated');

        const label = `${modelKind} / ${question.kind} / ${language} / ${expectedConditions.length} row(s)`;

        const statements = selectedStatements(expectedEntries, primary);
        const behaviour = behaviourFor({
          kind: modelKind,
          statements,
          primaryName: primary.disease_name,
          other,
          inventionTag: scenario.inventionTag,
        });
        if ('text' in behaviour && expectedPathOf(modelKind) === 'model_prose') {
          assertUnderCeiling(behaviour.text, label);
        }

        const transcript = transcriptFor(scenario.seed, scenario.turns);
        const test = harness({
          rows,
          transcript,
          latestDiagnosis: condition === null ? null : diagnosisRow(condition, rowOf(rows, condition).id),
          behaviour,
        });

        const input: ChatInput = {
          userId: FARMER,
          conversationId: THREAD,
          message: question.text,
          language,
          channel,
          inputKind: 'text',
        };

        // `chatAnswerer()` is the bound service both channels hold, so the turn under test is the
        // one `/api/chat`, `/api/voice` and the WhatsApp adapter all run.
        const outcome = await chatAnswerer(test.deps)(input, ownsRequest(FARMER, 'chat'));
        const answer = outcome.answer;

        /* ================================================================== */
        /* 1. Exactly the resolved rows were asked for, and exactly one call   */
        /*    was made (Requirement 4.5)                                       */
        /* ================================================================== */

        expect(test.recorded.knowledgeReads, label).toStrictEqual([[...expectedConditions]]);
        expect(test.recorded.counts.generate, label).toBe(1);
        expect(test.recorded.counts.classify, label).toBe(0);
        expect(answer.groundedIn, label).toStrictEqual([...expectedConditions]);

        // Grounded, so a provider call was attempted: the unit is spent and stays spent. The
        // referral's refund is Property 14's, and this is the other direction of the same rule.
        expect(test.recorded.counts.increments, label).toBe(1);
        expect(test.recorded.counts.decrements, label).toBe(0);
        expect(outcome.quota.used, label).toBe(1);

        /* ================================================================== */
        /* 2. The request was those rows, in canonical order, and nothing else */
        /*    plus the rephrase-only instruction (Requirement 4.5)             */
        /* ================================================================== */

        const prompt = test.recorded.prompts[0];
        if (prompt === undefined) throw new Error('the text seam was never handed a request');

        // The containment claim, as one comparison: a request that added, dropped, reordered or
        // re-punctuated a single line fails here.
        expect(verifiedContentLines(prompt), label).toStrictEqual(
          expectedEntries.flatMap((entry) => [...blockLinesOf(entry)]),
        );

        for (const fragment of REPHRASE_ONLY_FRAGMENTS) {
          expect(prompt, label).toContain(fragment);
        }

        // Nothing from an unresolved row reached the request, and no condition outside the resolved
        // set is named anywhere in it.
        for (const decoy of decoys) {
          for (const statement of statementsOf(decoy)) {
            expect(
              prompt.includes(tokenOf(statement)),
              `${label}: unresolved row "${decoy.disease_name}" in the request`,
            ).toBe(false);
          }
        }
        expect(outOfScopeConditionsIn(prompt, expectedConditions), label).toStrictEqual([]);

        // The window is in the prompt, and it is not in the verified-content block: a step that
        // folded the transcript into the verified content would be quoting a farmer as a source.
        const blockText = verifiedContentLines(prompt).join('\n');
        expect(transcriptTokensIn(blockText), label).toStrictEqual([]);
        if (transcript.length > 0) {
          expect(transcriptTokensIn(prompt).length, label).toBe(transcript.length);
        }

        /* ================================================================== */
        /* 3. The answer's agricultural content is the resolved rows'          */
        /*    (Requirement 4.4)                                                */
        /* ================================================================== */

        const ownStatements = expectedEntries.flatMap((entry) => [...statementsOf(entry)]);
        const ownTokens = new Set(ownStatements.map(tokenOf));

        for (const token of kbTokensIn(answer.content)) {
          expect(
            ownTokens.has(token),
            `${label}: unresolved statement "${token}" in the answer`,
          ).toBe(true);
          const statement = ownStatements.find((item) => tokenOf(item) === token);
          if (statement === undefined) throw new Error(`no statement for token "${token}"`);
          expect(answer.content, label).toContain(statement);
        }

        // Property 11's third clause, in the service's own scan.
        expect(outOfScopeConditionsIn(answer.content, expectedConditions), label).toStrictEqual([]);

        // The canonical name of the row the answer is about survives on every branch — check 2
        // prefixes it when the model dropped it, and the template leads with it.
        expect(answer.content, label).toContain(primary.disease_name);
        expect(answer.language, label).toBe(language);
        // A grounded answer is content the farmer can act on, not a referral (Requirement 4.7's
        // `needsExpert` belongs to the branch that made no model call).
        expect(answer.needsExpert, label).toBe(false);

        // What the farmer reads is the row that was persisted, on both channels.
        const persistedAnswer = test.recorded.messageRows.find((row) => row.role === 'jamee');
        const persistedQuestion = test.recorded.messageRows.find((row) => row.role === 'farmer');
        expect(persistedAnswer?.content, label).toBe(answer.content);
        expect(persistedQuestion?.content, label).toBe(question.text);
        expect(persistedAnswer?.channel, label).toBe(channel);

        /* ================================================================== */
        /* 4. Which branch produced it, and what that branch guarantees        */
        /* ================================================================== */

        const audit = test.recorded.usageRows[0];
        if (audit === undefined) throw new Error('no audit row was appended');
        expect(audit.prompt_version, label).toBe(PROMPT_VERSION);
        expect(audit.quota_spent, label).toBe(true);

        if (expectedPathOf(modelKind) === 'row_template') {
          // Checks 1 and 3, an exhausted chain, and an exhausted budget all land on the primary
          // row's own template — which is what keeps Requirement 4.4 true when the model is
          // unhelpful, and what a farmer reads instead of an error they cannot act on.
          const { ui } = messages(language);
          const headings: Record<KbField, string> = {
            symptoms: ui.symptomsHeading,
            causes: ui.causesHeading,
            treatment: ui.treatmentHeading,
            prevention: ui.preventionHeading,
          };
          const permitted = new Set<string>([
            primary.disease_name,
            ...nonEmptyFieldsOf(primary).map((field) => `${headings[field]}:`),
            ...statementsOf(primary).map((statement) => `  ${statement}`),
          ]);
          for (const line of answer.content.split('\n')) {
            expect(
              permitted.has(line),
              `${label}: template line that is not the primary row's content: ${JSON.stringify(line)}`,
            ).toBe(true);
          }
          // And it is the shared fallback rather than a second rendering of the same idea.
          expect(answer.content, label).toBe(staticExplanationFor(primary, language));

          if (modelKind === 'provider_failed' || modelKind === 'budget_exhausted') {
            // The recorded decision, asserted: a chat model failure or timeout degrades to grounded
            // content. The farmer never reads `DIAGNOSIS_TIMEOUT`'s "send the photo again", which is
            // wrong advice for a question that carried no photo.
            expect(answer.content, label).not.toBe(messages(language).errors.DIAGNOSIS_TIMEOUT);
            expect(audit.outcome, label).toBe(
              modelKind === 'provider_failed' ? 'provider_error' : 'timeout',
            );
            expect(audit.model_provider, label).toBe('none');
            expect(audit.rejection_reason, label).toBeNull();
          } else {
            expect(audit.outcome, label).toBe('validation_rejected');
            expect(audit.rejection_reason, label).toBe(REPHRASE_REJECTED_REASON);
            expect(audit.model_provider, label).toBe('gemini');
          }
        } else {
          // The model's prose was kept, and it still carries every statement it was built from.
          for (const statement of statements) {
            expect(answer.content, label).toContain(statement);
          }
          expect(audit.outcome, label).toBe('success');
          expect(audit.rejection_reason, label).toBeNull();
          expect(audit.model_provider, label).toBe('gemini');

          if (modelKind === 'invents_agronomy') {
            // The boundary the header states. The fabrication is the provider's: it was never in
            // the request, and every resolved row's content reached the farmer unaltered. No check
            // in Jamee can tell an invented agronomic sentence from a rephrased one — the design
            // says so, and says the guarantee is the request's content instead.
            expect(
              prompt.includes(scenario.inventionTag),
              `${label}: the fabricated statement came from Jamee's own request`,
            ).toBe(false);
          }
        }
      }),
      // 400 runs over eight provider behaviours, six question shapes and three languages, so each
      // cell of the grid is reached many times over rather than probably.
      { numRuns: 400 },
    );

    /* ---------------------------------------------------------------------- */
    /* Non-vacuity: the generators actually produced every class               */
    /* ---------------------------------------------------------------------- */

    expect([...modelKindsSeen].sort()).toStrictEqual([...MODEL_KINDS].sort());
    expect([...questionKindsSeen].sort()).toStrictEqual(
      QUESTION_CASES.map((entry) => entry.kind).sort(),
    );
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
    // Both halves of the answer step ran: the model's prose was kept on some runs and refused on
    // others. A run that only ever fell back would assert nothing about a kept answer, and the
    // reverse.
    expect([...pathsSeen].sort()).toStrictEqual(['model_prose', 'row_template']);
    // Every resolved-set size a question can produce, including the five-row set where there is no
    // out-of-scope condition left to fabricate. A one-row run would have proved nothing about
    // several rows in one request.
    expect([...scopeSizesSeen].sort((a, b) => a - b)).toStrictEqual([1, 2, 3, 4, 5]);
    // And both row shapes were grounded: one with treatment content, one without — so the request's
    // column-omission path is exercised rather than assumed.
    expect([...primaryShapesSeen].sort()).toStrictEqual(['empty', 'populated']);
  });
});
