import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner, TextCall } from '@/lib/ai/capabilities';
import { DAILY_QUOTAS } from '@/lib/config/verified';
import { AppError } from '@/lib/errors';
import {
  matchConditions,
  type KnowledgeEntry,
  type KnowledgeReader,
  type ReferralReason,
} from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import { PROMPT_VERSION, outOfScopeConditionsIn, staticExplanationFor } from '@/lib/prompts';
import {
  ERROR_CODES,
  HEALTHY_CONDITION,
  SUPPORTED_LANGUAGES,
  VERIFIED_CONDITIONS,
  type Channel,
  type ChatInput,
  type Language,
  type UsageOutcome,
  type VerifiedCondition,
} from '@/lib/schemas';
import {
  chatAnswerer,
  type ChatTurnDeps,
  type ChatWriteStore,
  type ContextMessage,
  type ContextStore,
} from '@/services/chat.service';
import { ownsRequest, type CounterRpc } from '@/services/quota.service';
import type { Database, DiagnosisRow, MessageRow, TablesInsert } from '@/types/database';

/**
 * ### Property 14: Questions outside verified knowledge yield an honest referral
 *
 * *"For any question about a crop or condition outside the verified conditions, and for any question
 * whose knowledge base resolution set is empty, the answer states the limits of Jamee's coverage or
 * its lack of verified information, recommends consulting an agricultural expert, sets `needsExpert`
 * true, and contains no treatment content."*
 *
 * **Validates: Requirements 4.7, 7.6**
 *
 * =============================================================================
 * WHERE THE PROPERTY IS OBSERVED
 * =============================================================================
 *
 * A whole chat turn, through `chatAnswerer()` — the bound `ChatService` that `/api/chat`,
 * `/api/voice` and the WhatsApp adapter all hold — with every seam injected: the context reads, the
 * knowledge reader, the counter RPC, the write store and the capability runner. So there is no
 * Supabase stack and no provider, and the four things the property is *about* are directly
 * observable: the answer handed back, the answer persisted as the Jamee message, the counter, and
 * the audit row.
 *
 * The turn rather than `answerQuestion()` alone, because two of this property's claims are only
 * true of a turn. "No model call at all" is a claim about the request, and the spend rule below is
 * a claim about the counter — neither of which `answerQuestion()` touches.
 *
 * =============================================================================
 * THE TWO PREMISES, RUN AS TWO PREMISES
 * =============================================================================
 *
 * The design statement names two disjuncts, and `resolveScope()` in `knowledge.ts` has exactly two
 * `ReferralReason`s for them. Both are generated, and `REFERRAL_COPY` below is exhaustive over the
 * type, so a third reason breaks this file until it has a premise and copy of its own.
 *
 *  - **`out_of_scope` (Requirement 4.7)** — the question names a crop or a condition outside the
 *    five, and the conversation supplies no subject either. The scope resolution returns before any
 *    I/O, so this branch reads nothing and calls nothing.
 *  - **`no_verified_content` (Requirement 7.6)** — the question's own vocabulary *is* in scope, or
 *    the conversation's diagnosis puts something in scope, and the base returns no row for it. This
 *    is the disjunct the design phrases as "whose knowledge base resolution set is empty", and it is
 *    reachable only by an unseeded base: Requirement 4.1 says a seeded deployment has all five rows.
 *    Two shapes are run — a base holding every row *except* the ones asked for, so there is
 *    unresolved content available to leak, and a base holding nothing at all.
 *
 * `matchConditions()` is asserted directly on every generated question, per iteration and again over
 * the whole enumeration, so "outside the verified conditions" and "in scope by vocabulary" are
 * checked facts about the text rather than intentions about it.
 *
 * =============================================================================
 * "CONTAINS NO TREATMENT CONTENT", AS CONTAINMENT RATHER THAN AS AN ASSUMPTION
 * =============================================================================
 *
 * Every generated knowledge row is built from **tagged statements**: each array item opens with a
 * token naming its row, its column and its index (`KB1A2B-treatment-0 remove and destroy affected
 * leaves`). So the fourth clause is a containment check over the rows the base actually held — no
 * statement token from any stocked row may appear in what the farmer reads, and no localized
 * treatment heading either, in any of the three languages.
 *
 * That check would pass over an untagged fixture by iterating over nothing, so two guards make it
 * discriminating rather than vacuous:
 *
 *  1. **The stocked rows are asserted to carry treatment statements** before the claim is made.
 *  2. **The contrast is run.** The second test drives the same harness down the *grounded*
 *     degradation path, where `staticExplanationFor()` is the answer — and asserts that the farmer
 *     then *does* read the primary row's treatment statements under its treatment heading. So "no
 *     treatment content" is a difference this code produces between two paths, not a property of
 *     short copy.
 *
 * The referral is also asserted to name **no verified condition at all**, in the service's own
 * `outOfScopeConditionsIn()` scan: a turn that resolved to no row has no name it may use.
 *
 * =============================================================================
 * `quota_spent` IS `false` FOR A REFERRAL — COUNTED, NOT INFERRED
 * =============================================================================
 *
 * The design's spend rule is a biconditional: *a unit is spent if and only if at least one provider
 * call was attempted for that request.* A referral attempts none, so the unit is not spent. What the
 * code actually does is **reserve at step 3 and hand the unit back at step 6** — not "never
 * reserve" — and that distinction is only visible by counting, so all three directions the counter
 * can be touched are counted at the `CounterRpc` seam:
 *
 *      tryIncrement 1 · decrement 1 · reported used 0 · classify 0 · generate 0
 *
 * A turn that never reserved would show `tryIncrement 0`, and one that kept the unit `decrement 0`.
 * Both pass a test that only reads `quota.used`, which is why the counts are asserted and not the
 * balance alone. The second test asserts the other direction of the same biconditional — a grounded
 * turn, and a *degraded* grounded turn, both keep the unit — so the rule is exercised as a rule
 * rather than as one case.
 *
 * **This reading is off the biconditional, not off an acceptance criterion, and the disagreement is
 * recorded rather than resolved silently.** The design's step 9 enumerates only *failures* as
 * refundable — signed-URL issuance, an unreadable object, a knowledge-base read failure, an
 * unhandled error ahead of the gateway — and does not contemplate a pre-provider exit that
 * *succeeded*. A referral is such an exit. `chat.service.ts` says the same thing in its own header
 * and resolves it the same way; this file is the executable half of that record.
 *
 * =============================================================================
 * A REFERRAL IS NOT AN ERROR, AND A DEGRADATION IS NOT A TIMEOUT
 * =============================================================================
 *
 * Both tests assert that what the farmer reads is none of the error taxonomy's localized strings —
 * `ERROR_CODES` in full, in the request's language. That matters most for `DIAGNOSIS_TIMEOUT`, whose
 * `en` copy tells a farmer to send the crop photo again: it is the taxonomy's only timeout code, and
 * on a chat turn there is no photo to resend. `chat.service.ts` records the decision that a chat
 * model failure or an exhausted budget degrades to the **grounded static template** instead, and the
 * second test pins that — the audit row still records `timeout` or `provider_error`, so the
 * degradation is visible to an operator while the farmer gets content they can act on.
 *
 * =============================================================================
 * WHAT THIS PROPERTY DELIBERATELY DOES NOT CLAIM
 * =============================================================================
 *
 * **Which rows a question resolves to**, when it resolves to any. That is Property 11's, and every
 * `matched` set below is written out by hand rather than computed with the matcher under test.
 *
 * **What the window contained** (Property 15's) and **how a subject-less follow-up resolves when
 * there is a diagnosis to resolve against** (Property 16's). A transcript and a diagnosis are
 * present here only so the referral has something it could wrongly reach for.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const FARMER = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const THREAD = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
const FARMER_MESSAGE_ID = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';
const ANSWER_MESSAGE_ID = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
const DIAGNOSIS_ID = '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f';

/** 2026-09-15T19:30:00Z. Fixed, so a run owns its clock and never reads the wall clock. */
const NOW_MS = Date.parse('2026-09-15T19:30:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();

/** The four agronomic columns, in the order a farmer needs them and the template renders them. */
const KB_FIELDS = ['symptoms', 'causes', 'treatment', 'prevention'] as const;
type KbField = (typeof KB_FIELDS)[number];

/**
 * Which static sentence each referral reason renders.
 *
 * `satisfies Record<ReferralReason, …>` is exhaustive, so a third reason in `knowledge.ts` breaks
 * this file until it has a premise, copy and a claim of its own — the same structural-completeness
 * move `chat.service.ts` makes for the same two values.
 */
const REFERRAL_COPY = {
  out_of_scope: 'outOfScope',
  no_verified_content: 'noVerifiedInfo',
} as const satisfies Record<ReferralReason, 'outOfScope' | 'noVerifiedInfo'>;

const REFERRAL_REASONS = Object.keys(REFERRAL_COPY) as readonly ReferralReason[];

/**
 * The design statement's first two clauses, stated **independently of the catalog**.
 *
 * Asserting only `content === messages(language).chat.outOfScope` would prove the service rendered
 * the catalog entry and nothing about what that entry *says* — a catalog whose referral copy lost
 * its expert recommendation would keep every equality assertion green. So each reason carries, per
 * language, the clause that states the limit and the clause that recommends the expert, written out
 * here rather than read from the module under test.
 */
interface CopyClaim {
  /** "states the limits of Jamee's coverage" (4.7) or "its lack of verified information" (7.6). */
  readonly limit: string;
  /** "recommends consulting an agricultural expert" — both reasons, all three languages. */
  readonly expert: string;
}

const COPY_CLAIMS: Record<ReferralReason, Record<Language, CopyClaim>> = {
  out_of_scope: {
    en: {
      limit: 'covers tomato and potato conditions only',
      expert: 'consult an agricultural expert',
    },
    hi: { limit: 'केवल टमाटर और आलू', expert: 'कृषि विशेषज्ञ' },
    mr: { limit: 'फक्त टोमॅटो आणि बटाट', expert: 'कृषी तज्ज्ञ' },
  },
  no_verified_content: {
    en: {
      limit: 'does not have verified information',
      expert: 'consult an agricultural expert',
    },
    hi: { limit: 'जाँची गई जानकारी नहीं', expert: 'कृषि विशेषज्ञ' },
    mr: { limit: 'तपासलेली माहिती नाही', expert: 'कृषी तज्ज्ञ' },
  },
};

/**
 * Clause tails for the generated statements.
 *
 * Realistic agronomy, and deliberately free of any verified condition name, so the deny-list scan
 * never fires on a row's own content and a leaked statement is attributable to its row rather than
 * to its vocabulary.
 */
const TAILS: readonly string[] = [
  'dark rings on the older leaves',
  'a yellow halo around each spot',
  'warm humid weather and long leaf wetness',
  'remove and destroy affected leaves',
  'water at the base, keep foliage dry',
  'rotate away from solanaceous crops',
];

/** Every tagged knowledge-base statement, whichever row and whichever column it came from. */
const KB_STATEMENT = /KB[0-9A-F]{4}-(?:symptoms|causes|treatment|prevention)-\d+/g;

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

/** `noUncheckedIndexedAccess` is on; a missing fixture index is a defect in the fixture. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture index ${index} is absent`);
  return item;
}

/* ========================================================================== */
/* Row construction                                                            */
/* ========================================================================== */

/** `KB1A2B` — one tag per row, distinct across the five rows of a run. */
function tagFor(seed: number, index: number): string {
  return `KB${(seed + index).toString(16).toUpperCase()}`;
}

function rowFor(condition: VerifiedCondition, tag: string, tails: readonly string[]): KnowledgeEntry {
  const healthy = condition === HEALTHY_CONDITION;
  const statements = (field: KbField): string[] =>
    tails.map((tail, index) => `${tag}-${field}-${index} ${tail}`);
  return {
    id: `00000000-0000-4000-8000-${tag.slice(2).padStart(12, '0')}`,
    disease_name: condition,
    crop: CROP_OF[condition],
    scientific_name: healthy ? null : `${tag} pathogen`,
    symptoms: statements('symptoms'),
    causes: statements('causes'),
    // Requirement 3.4 and the `healthy_has_no_treatment` check constraint: the healthy row's
    // treatment array is empty, which is a row shape the database actually admits.
    treatment: healthy ? [] : statements('treatment'),
    prevention: statements('prevention'),
    default_severity: healthy ? 'none' : 'moderate',
    source: `${tag} extension bulletin`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/** The row's four arrays concatenated in column order — the whole of what it could contribute. */
function statementsOf(entry: KnowledgeEntry): readonly string[] {
  return KB_FIELDS.flatMap((field) => entry[field]);
}

function canonicalIndexOf(name: VerifiedCondition): number {
  return VERIFIED_CONDITIONS.indexOf(name);
}

/** Canonical order, which is the order `resolveScope()` asks the reader for. */
function orderCanonically(names: readonly VerifiedCondition[]): readonly VerifiedCondition[] {
  return [...new Set(names)].sort((a, b) => canonicalIndexOf(a) - canonicalIndexOf(b));
}

function rowOf(rows: readonly KnowledgeEntry[], name: VerifiedCondition): KnowledgeEntry {
  const row = rows.find((entry) => entry.disease_name === name);
  if (row === undefined) throw new Error(`no generated row for "${name}"`);
  return row;
}

/* ========================================================================== */
/* Premise 1 — a question about a crop or condition outside the five (4.7)      */
/* ========================================================================== */

/**
 * Questions that put nothing in scope, enumerated so the run can prove it exercised every one.
 *
 * None carries any of the vocabulary derived from the five canonical names — `tomato`, `potato`,
 * `early`, `late`, `blight`, `healthy` (`knowledge.ts`), whose tokenizer also strips a trailing `s`
 * or `es`. `matchConditions()` is asserted over all five below, and again inside the property.
 */
const OUT_OF_SCOPE_KINDS = [
  /** Another crop entirely, with a condition Jamee has never heard of. */
  'other_crop',
  /** A condition outside the five, on a crop outside the two. */
  'unverified_condition',
  /** Not a disease question at all. */
  'general_agronomy',
  /** Subject-less, in a conversation with no subject to resolve against. */
  'subject_less',
  /** Devanagari, which contributes no Latin token and therefore no vocabulary. */
  'devanagari',
] as const;

type OutOfScopeKind = (typeof OUT_OF_SCOPE_KINDS)[number];

const OUT_OF_SCOPE_TEXT: Record<OutOfScopeKind, string> = {
  other_crop: 'my wheat crop has rust on the leaves, what should i spray?',
  unverified_condition: 'is this bacterial wilt on my brinjal?',
  general_agronomy: 'how much urea should i give my cotton field?',
  subject_less: 'why?',
  /** "What should be sprayed on wheat?" — no Latin token at all. */
  devanagari: 'गव्हावर काय फवारावे?',
};

/* ========================================================================== */
/* Premise 2 — a question whose resolution set comes back empty (7.6)           */
/* ========================================================================== */

/**
 * Questions that *are* in scope by vocabulary, one per tier of `matchConditions()`, plus the one
 * whose subject comes from the conversation instead.
 *
 * `matched` is written out by hand rather than computed with the matcher: the point of the asserted
 * knowledge read below is that the *code* asked for exactly these names, and an expectation derived
 * from the same matcher would agree with any matcher.
 */
const IN_SCOPE_KINDS = [
  /** Crop and qualifier — the exact tier, one row. */
  'explicit_condition',
  /** The crop alone — both rows of that crop. */
  'crop_only',
  /** The qualifier alone — that qualifier across both crops. */
  'qualifier_only',
  /** One qualifier word — the loose tier, every row carrying it. */
  'loose_qualifier',
  /** The healthy qualifier alone. */
  'healthy_only',
  /** No vocabulary at all: the subject is the conversation's diagnosis (Requirement 7.3). */
  'from_diagnosis',
] as const;

type InScopeKind = (typeof IN_SCOPE_KINDS)[number];

interface InScopeCase {
  readonly text: string;
  /** The rows this question's own words put in scope. */
  readonly matched: readonly VerifiedCondition[];
}

const IN_SCOPE_CASES: Record<InScopeKind, InScopeCase> = {
  explicit_condition: {
    text: 'my tomato has late blight, what should i do now?',
    matched: ['Tomato Late Blight'],
  },
  crop_only: {
    text: 'what are these spots on my potato leaves?',
    matched: ['Potato Early Blight', 'Potato Late Blight'],
  },
  qualifier_only: {
    text: 'what is late blight?',
    matched: ['Tomato Late Blight', 'Potato Late Blight'],
  },
  loose_qualifier: {
    text: 'is this blight?',
    matched: [
      'Tomato Early Blight',
      'Tomato Late Blight',
      'Potato Early Blight',
      'Potato Late Blight',
    ],
  },
  healthy_only: { text: 'is my crop healthy?', matched: ['Tomato Healthy'] },
  from_diagnosis: { text: 'how much should i use?', matched: [] },
};

/** What the base held when the resolution came back empty. */
const BASE_SHAPES = [
  /** Every row except the ones asked for: unresolved content is present, and must not leak. */
  'complement',
  /** Nothing at all — the unseeded deployment Requirement 4.1 rules out and 7.6 answers anyway. */
  'empty',
] as const;

type BaseShape = (typeof BASE_SHAPES)[number];

/** What sits behind the conversation, which decides whether it supplies a subject. */
const DIAGNOSIS_SHAPES = [
  /** No diagnosis at all. */
  'none',
  /** An inconclusive newest row: a diagnosis carrying no name (`diagnoses_unknown_shape`, 6.5). */
  'inconclusive',
  /** An identified newest row, whose condition joins the resolved set. */
  'identified',
] as const;

type DiagnosisShape = (typeof DIAGNOSIS_SHAPES)[number];

const WINDOW_SHAPES = ['empty', 'populated'] as const;
type WindowShape = (typeof WINDOW_SHAPES)[number];

const DECOY_SHAPES = ['present', 'absent'] as const;
type DecoyShape = (typeof DECOY_SHAPES)[number];

/**
 * Whether the rows the base held carried treatment content at all.
 *
 * Both classes are real and both are reached: the healthy row's treatment array is empty by
 * construction (Requirement 3.4 and the `healthy_has_no_treatment` check constraint), so a base
 * holding only that row has no treatment statement to withhold. The coverage assertion below is what
 * keeps the `present` class — the one where clause 4 has something to prove — from going unrun.
 */
const TREATMENT_SHAPES = ['present', 'absent'] as const;
type TreatmentShape = (typeof TREATMENT_SHAPES)[number];

/* ========================================================================== */
/* The harness — every seam injected, every count recorded                     */
/* ========================================================================== */

interface Counts {
  classify: number;
  generate: number;
  increments: number;
  decrements: number;
}

interface Recorded {
  /** Every prompt the text seam was handed. Empty on every referral. */
  readonly prompts: string[];
  /** Every name set the knowledge reader was asked for. */
  readonly knowledgeReads: VerifiedCondition[][];
  readonly messageRows: TablesInsert<'messages'>[];
  readonly usageRows: TablesInsert<'usage_logs'>[];
  readonly touched: string[];
  readonly counts: Counts;
}

/** What the text seam does — or, on a referral, what it must never be asked to do. */
type Behaviour =
  /** Reaching the seam at all is the failure. Counted first, so the count reports it too. */
  | { readonly kind: 'tripwire' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'fail'; readonly error: AppError };

/**
 * A tripwire, not a stand-in: every seam is injected, so a read of the request client means the
 * service reached past its dependencies and nothing recorded above can be trusted.
 */
const unreachableSupabase = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `the request client was used (read of "${String(property)}"); every seam must be injected`,
      );
    },
  },
) as unknown as SupabaseClient<Database>;

interface Harness {
  readonly deps: ChatTurnDeps;
  readonly recorded: Recorded;
}

function harness(options: {
  /** What the base holds. A referral premise stocks it so a leak has something to leak. */
  readonly rows: readonly KnowledgeEntry[];
  /** The window, oldest → newest. The store hands it back newest-first, as the index does. */
  readonly transcript: readonly ContextMessage[];
  readonly latestDiagnosis: DiagnosisRow | null;
  readonly behaviour: Behaviour;
}): Harness {
  const counts: Counts = { classify: 0, generate: 0, increments: 0, decrements: 0 };
  const recorded: Recorded = {
    prompts: [],
    knowledgeReads: [],
    messageRows: [],
    usageRows: [],
    touched: [],
    counts,
  };

  let used = 0;

  /**
   * The counting seam. All three directions the counter can be touched are recorded, because
   * "the unit was handed back" and "the unit was never taken" are different claims and only one of
   * them is what `chat.service.ts` does.
   */
  const rpc: CounterRpc = {
    tryIncrement: (args) => {
      counts.increments += 1;
      if (used >= args.limit) return Promise.resolve(null);
      used += 1;
      return Promise.resolve(used);
    },
    decrement: () => {
      counts.decrements += 1;
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
      // A chat turn classifies nothing. Counted so "no provider call" is a count, not a hope.
      counts.classify += 1;
      return Promise.reject(new Error('a chat turn must not call the vision capability'));
    },
    generate: (call: TextCall) => {
      counts.generate += 1;
      recorded.prompts.push(call.prompt);
      if (options.behaviour.kind === 'tripwire') {
        return Promise.reject(
          new Error('a referral must make no model call; the text capability was reached'),
        );
      }
      if (options.behaviour.kind === 'fail') return Promise.reject(options.behaviour.error);
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
      const stored: MessageRow[] = pair.map((row, index) => ({
        id: index === 0 ? FARMER_MESSAGE_ID : ANSWER_MESSAGE_ID,
        conversation_id: row.conversation_id,
        user_id: row.user_id,
        role: row.role,
        content: row.content,
        language: row.language,
        channel: row.channel,
        input_kind: row.input_kind ?? 'text',
        transcript_of: row.transcript_of ?? null,
        created_at: NOW_ISO,
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
      supabase: unreachableSupabase,
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

function transcriptFor(turns: number): readonly ContextMessage[] {
  return Array.from({ length: turns }, (_unused, index) => ({
    id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    conversation_id: THREAD,
    user_id: FARMER,
    role: index % 2 === 0 ? ('farmer' as const) : ('jamee' as const),
    content: 'an earlier turn of this thread',
    language: 'en' as const,
    channel: 'web' as const,
    input_kind: 'text' as const,
    transcript_of: null,
    created_at: new Date(NOW_MS - (turns - index) * 60_000).toISOString(),
  }));
}

/**
 * The conversation's newest diagnosis, in the shape the scenario asked for.
 *
 * An inconclusive row is generated with the real `diagnoses_unknown_shape` column set — no name, no
 * knowledge id, no confidence, severity `none`, an expert needed (Requirement 6.5) — so the branch
 * where a diagnosis exists and still supplies no subject is exercised by a row the database admits.
 */
function diagnosisFor(premise: Premise): DiagnosisRow | null {
  const shape = premise.diagnosisShape;
  if (shape === 'none') return null;
  const identified = shape === 'identified';
  // The name the row carries is the premise's condition, never the raw generated one: the
  // `loose_qualifier` case overrides it (see `premiseOf`), and a row built from the other value
  // would put a different name in scope than the ask this run is checked against.
  const condition = premise.condition;
  if (identified && condition === null) {
    throw new Error('an identified diagnosis row needs a condition');
  }
  return {
    id: DIAGNOSIS_ID,
    user_id: FARMER,
    conversation_id: THREAD,
    status: identified ? 'identified' : 'unknown',
    disease_name: identified ? condition : null,
    knowledge_id: null,
    confidence: identified ? 0.84 : null,
    severity: identified ? 'moderate' : 'none',
    explanation: 'an earlier diagnosis of this conversation',
    language: 'en',
    needs_expert: !identified,
    channel: 'web',
    image_bucket: 'crop-images',
    image_path: `${FARMER}/2026/09/leaf.jpg`,
    full_image_deleted_at: null,
    model_provider: 'gemini',
    created_at: new Date(NOW_MS - 300_000).toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Readers over what the farmer received                                       */
/* -------------------------------------------------------------------------- */

/** Every tagged knowledge statement present in a string, in order of appearance. */
function kbTokensIn(text: string): readonly string[] {
  return text.match(KB_STATEMENT) ?? [];
}

/** The token that opens a statement — `KB1A2B-treatment-0`. */
function tokenOf(statement: string): string {
  return statement.split(' ')[0] ?? statement;
}

/** Every localized column heading, so "no treatment content" is checked in all three languages. */
function treatmentHeadings(): readonly string[] {
  return SUPPORTED_LANGUAGES.map((language) => messages(language).ui.treatmentHeading);
}

/**
 * What a farmer reads must be none of the error taxonomy's localized strings.
 *
 * `DIAGNOSIS_TIMEOUT` is the one that matters — its copy asks for the crop photo again, which is
 * wrong advice for a question that carried no photo — but the whole taxonomy is checked rather than
 * that one code, so a future timeout code inherits the claim without an edit here.
 */
function assertNotAnErrorMessage(content: string, language: Language, label: string): void {
  const catalog = messages(language).errors;
  for (const code of ERROR_CODES) {
    expect(content, `${label}: the farmer read the ${code} error message`).not.toBe(catalog[code]);
  }
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const languageArb = fc.constantFrom<Language>(...SUPPORTED_LANGUAGES);
const channelArb = fc.constantFrom<Channel>('web', 'whatsapp');

/** One or two statements per column: enough for containment, short enough to stay terse. */
const tailsArb = fc.subarray([...TAILS], { minLength: 1, maxLength: 2 });

/**
 * `seed + 4` stays inside four hex digits, so all five tags of a run are four uppercase hex
 * characters and all five are distinct.
 */
const seedArb = fc.integer({ min: 0x1000, max: 0xfff0 });

interface Scenario {
  readonly reason: ReferralReason;
  readonly outOfScopeKind: OutOfScopeKind;
  readonly inScopeKind: InScopeKind;
  readonly baseShape: BaseShape;
  readonly diagnosisShape: DiagnosisShape;
  readonly condition: VerifiedCondition;
  readonly language: Language;
  readonly channel: Channel;
  readonly seed: number;
  readonly tails: readonly string[];
  /** Turns of transcript ahead of this question. Zero exercises the omitted-window path. */
  readonly turns: number;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  reason: fc.constantFrom<ReferralReason>(...REFERRAL_REASONS),
  outOfScopeKind: fc.constantFrom<OutOfScopeKind>(...OUT_OF_SCOPE_KINDS),
  inScopeKind: fc.constantFrom<InScopeKind>(...IN_SCOPE_KINDS),
  baseShape: fc.constantFrom<BaseShape>(...BASE_SHAPES),
  diagnosisShape: fc.constantFrom<DiagnosisShape>(...DIAGNOSIS_SHAPES),
  condition: fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS),
  language: languageArb,
  channel: channelArb,
  seed: seedArb,
  tails: tailsArb,
  turns: fc.integer({ min: 0, max: 2 }),
});

/* ========================================================================== */
/* The premise, resolved from the scenario                                     */
/* ========================================================================== */

interface Premise {
  readonly reason: ReferralReason;
  readonly question: string;
  readonly diagnosisShape: DiagnosisShape;
  /** The condition the conversation established, or `null` when it established none. */
  readonly condition: VerifiedCondition | null;
  /** The names the resolution asks the base for. Empty exactly when nothing is in scope. */
  readonly asked: readonly VerifiedCondition[];
  /** What the base holds. Every row here is unresolved content the answer must not carry. */
  readonly stocked: readonly KnowledgeEntry[];
  readonly label: string;
}

/**
 * Turn a generated scenario into one of the design statement's two premises.
 *
 * Two reconciliations, both forced by the premises themselves rather than by convenience:
 *
 *  - **An out-of-scope question needs a conversation with no subject.** A thread carrying an
 *    identified diagnosis puts that condition in scope (Requirement 7.3), which is Property 11's
 *    premise and not this one's — so `identified` is mapped onto `none` for that branch. The
 *    `inconclusive` shape survives, and is the interesting half: a diagnosis exists, and it still
 *    supplies no name.
 *  - **`from_diagnosis` needs a diagnosis.** Its question contributes no vocabulary, so without one
 *    the resolution is empty for the *other* reason and the premise would silently change.
 *
 * The `loose_qualifier` case takes `HEALTHY_CONDITION` as its diagnosis rather than the generated
 * one, and that is deliberate: the loose tier reaches the four blight rows, so the healthy row is
 * the only condition that widens the ask to all five. It is the widest resolution set a chat
 * question can produce, and making it reachable by construction rather than by luck is what lets the
 * coverage assertion below claim it.
 */
function premiseOf(scenario: Scenario, rows: readonly KnowledgeEntry[]): Premise {
  if (scenario.reason === 'out_of_scope') {
    const shape: DiagnosisShape =
      scenario.diagnosisShape === 'identified' ? 'none' : scenario.diagnosisShape;
    return {
      reason: 'out_of_scope',
      question: OUT_OF_SCOPE_TEXT[scenario.outOfScopeKind],
      diagnosisShape: shape,
      condition: null,
      asked: [],
      // Every row, and none of them asked for: nothing may reach the farmer from any of them.
      stocked: rows,
      label: `out_of_scope / ${scenario.outOfScopeKind} / ${shape} / ${scenario.language}`,
    };
  }

  const kind = scenario.inScopeKind;
  const shape: DiagnosisShape = kind === 'from_diagnosis' ? 'identified' : scenario.diagnosisShape;
  const condition =
    shape === 'identified'
      ? kind === 'loose_qualifier'
        ? HEALTHY_CONDITION
        : scenario.condition
      : null;

  const asked = orderCanonically([
    ...(condition === null ? [] : [condition]),
    ...IN_SCOPE_CASES[kind].matched,
  ]);

  return {
    reason: 'no_verified_content',
    question: IN_SCOPE_CASES[kind].text,
    diagnosisShape: shape,
    condition,
    asked,
    // The base returns nothing for what was asked. `complement` leaves the other rows in place, so
    // there is unresolved content available to leak; `empty` is the unseeded base.
    stocked:
      scenario.baseShape === 'empty'
        ? []
        : rows.filter((row) => !asked.includes(row.disease_name)),
    label: `no_verified_content / ${kind} / ${scenario.baseShape} / ${shape} / ${scenario.language}`,
  };
}

/* ========================================================================== */
/* Property 14                                                                 */
/* ========================================================================== */

describe('Property 14: questions outside verified knowledge yield an honest referral', () => {
  it('answers from the repository\u2019s own copy, calls no provider, carries no treatment content, and hands the unit back', async () => {
    const reasonsSeen = new Set<ReferralReason>();
    const outOfScopeKindsSeen = new Set<OutOfScopeKind>();
    const inScopeKindsSeen = new Set<InScopeKind>();
    const baseShapesSeen = new Set<BaseShape>();
    const diagnosisShapesSeen = new Set<DiagnosisShape>();
    const languagesSeen = new Set<Language>();
    const channelsSeen = new Set<Channel>();
    const windowsSeen = new Set<WindowShape>();
    const decoysSeen = new Set<DecoyShape>();
    const treatmentsSeen = new Set<TreatmentShape>();
    const askedSizesSeen = new Set<number>();

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { language, channel } = scenario;

        const rows = VERIFIED_CONDITIONS.map((name, index) =>
          rowFor(name, tagFor(scenario.seed, index), scenario.tails),
        );
        const premise = premiseOf(scenario, rows);
        const { label } = premise;

        reasonsSeen.add(premise.reason);
        if (premise.reason === 'out_of_scope') outOfScopeKindsSeen.add(scenario.outOfScopeKind);
        else {
          inScopeKindsSeen.add(scenario.inScopeKind);
          baseShapesSeen.add(scenario.baseShape);
          askedSizesSeen.add(premise.asked.length);
        }
        diagnosisShapesSeen.add(premise.diagnosisShape);
        languagesSeen.add(language);
        channelsSeen.add(channel);
        windowsSeen.add(scenario.turns === 0 ? 'empty' : 'populated');
        decoysSeen.add(premise.stocked.length === 0 ? 'absent' : 'present');

        /* ================================================================== */
        /* 0. The premise is the premise                                       */
        /* ================================================================== */

        // Asserted per iteration rather than only over the enumerations, because everything below
        // rests on it: whichever referral the code produced, the question's own words either put
        // nothing in scope or put exactly the names the read is checked against.
        expect(matchConditions(premise.question), label).toStrictEqual([
          ...IN_SCOPE_CASES[scenario.inScopeKind].matched.filter(
            () => premise.reason === 'no_verified_content',
          ),
        ]);

        const transcript = transcriptFor(scenario.turns);
        const test = harness({
          rows: premise.stocked,
          transcript,
          latestDiagnosis: diagnosisFor(premise),
          // A referral makes no model call, so the seam is a tripwire rather than a stub.
          behaviour: { kind: 'tripwire' },
        });

        const input: ChatInput = {
          userId: FARMER,
          conversationId: THREAD,
          message: premise.question,
          language,
          channel,
          inputKind: 'text',
        };

        // `chatAnswerer()` is the bound service both channels hold, so the turn under test is the
        // one `/api/chat`, `/api/voice` and the WhatsApp adapter all run.
        const outcome = await chatAnswerer(test.deps)(input, ownsRequest(FARMER, 'chat'));
        const { answer } = outcome;

        /* ================================================================== */
        /* 1. No provider call was made at all (4.7, 7.6)                      */
        /* ================================================================== */

        expect(test.recorded.counts.generate, label).toBe(0);
        expect(test.recorded.counts.classify, label).toBe(0);
        expect(test.recorded.prompts, label).toStrictEqual([]);

        // Which referral it was, and the read that distinguishes them: an out-of-scope question is
        // refused before any I/O, while an empty resolution set means the base was asked and
        // answered with nothing.
        if (premise.reason === 'out_of_scope') {
          expect(test.recorded.knowledgeReads, label).toStrictEqual([]);
        } else {
          expect(test.recorded.knowledgeReads, label).toStrictEqual([[...premise.asked]]);
          expect(premise.asked.length, label).toBeGreaterThan(0);
        }

        /* ================================================================== */
        /* 2. The answer states the limit, recommends an expert, and sets        */
        /*    needsExpert (4.7, 7.6)                                           */
        /* ================================================================== */

        const key = REFERRAL_COPY[premise.reason];
        expect(answer.content, label).toBe(messages(language).chat[key]);
        expect(answer.language, label).toBe(language);
        expect(answer.needsExpert, label).toBe(true);
        expect([...answer.groundedIn], label).toStrictEqual([]);

        // The two clauses, asserted against text written here rather than read from the catalog: a
        // catalog entry that lost its expert recommendation fails this even though the equality
        // above would still hold.
        const claim = COPY_CLAIMS[premise.reason][language];
        expect(answer.content, `${label}: states the limit`).toContain(claim.limit);
        expect(answer.content, `${label}: recommends an expert`).toContain(claim.expert);

        // Not an error, in any language — see `assertNotAnErrorMessage`.
        assertNotAnErrorMessage(answer.content, language, label);

        /* ================================================================== */
        /* 3. No treatment content, and no agronomy from any row the base held  */
        /* ================================================================== */

        const stockedStatements = premise.stocked.flatMap((entry) => [...statementsOf(entry)]);
        const treatmentStatements = premise.stocked.flatMap((entry) => [...entry.treatment]);
        treatmentsSeen.add(treatmentStatements.length === 0 ? 'absent' : 'present');

        // The containment loops below are over these lists, so their sizes are asserted first: an
        // untagged fixture would make the claim pass by iterating over nothing.
        if (premise.stocked.length > 0) {
          expect(stockedStatements.length, `${label}: the stocked rows carry no statements`)
            .toBeGreaterThan(0);
        }
        // Every row except the healthy one carries treatment content (Requirement 3.4), so a base
        // holding any of them must have treatment content for clause 4 to withhold.
        if (premise.stocked.some((entry) => entry.disease_name !== HEALTHY_CONDITION)) {
          expect(treatmentStatements.length, `${label}: the stocked rows carry no treatment`)
            .toBeGreaterThan(0);
        }

        expect(kbTokensIn(answer.content), `${label}: knowledge-base content in a referral`)
          .toStrictEqual([]);
        for (const statement of stockedStatements) {
          expect(
            answer.content.includes(tokenOf(statement)),
            `${label}: unresolved statement "${tokenOf(statement)}" reached the farmer`,
          ).toBe(false);
        }
        for (const heading of treatmentHeadings()) {
          expect(
            answer.content.includes(heading),
            `${label}: a treatment heading reached a referral`,
          ).toBe(false);
        }
        // And the referral is not the grounded template, which is where treatment content lives.
        for (const entry of premise.stocked) {
          expect(answer.content, label).not.toBe(staticExplanationFor(entry, language));
        }
        // A turn that resolved to no row has no verified condition it may name — in the service's
        // own deny-list scan, with an empty in-scope set.
        expect(outOfScopeConditionsIn(answer.content, []), label).toStrictEqual([]);

        /* ================================================================== */
        /* 4. The unit: reserved, then handed back (counted, not inferred)      */
        /* ================================================================== */

        expect(test.recorded.counts.increments, `${label}: the unit was never reserved`).toBe(1);
        expect(test.recorded.counts.decrements, `${label}: the unit was not handed back`).toBe(1);
        expect(outcome.quota.used, label).toBe(0);
        expect(outcome.quota.limit, label).toBe(DAILY_QUOTAS.chat);

        /* ================================================================== */
        /* 5. The audit row says so, and the exchange is still in the history   */
        /* ================================================================== */

        expect(test.recorded.usageRows.length, label).toBe(1);
        const audit = at(test.recorded.usageRows, 0);
        expect(audit.quota_spent, label).toBe(false);
        // 0006 glosses `inconclusive` as a SUCCESSFUL request Jamee could not judge, which is the
        // shape of this fact: the request worked, and the honest answer was "not this one".
        expect(audit.outcome, label).toBe('inconclusive');
        expect(audit.operation, label).toBe('chat');
        expect(audit.channel, label).toBe(channel);
        expect(audit.model_provider, label).toBe('none');
        expect(audit.used_fallback, label).toBe(false);
        expect(audit.rejection_reason, label).toBeNull();
        expect(audit.conversation_id, label).toBe(THREAD);
        expect(audit.diagnosis_id, label).toBeNull();
        // Written on every row, including rows that composed no prompt (`usageLogRow()`).
        expect(audit.prompt_version, label).toBe(PROMPT_VERSION);

        // Requirement 7.4 holds either way: the exchange is in the farmer's history, on the channel
        // it arrived on, and a referral is not a reason to drop it.
        expect(test.recorded.messageRows.length, label).toBe(2);
        const persistedQuestion = test.recorded.messageRows.find((row) => row.role === 'farmer');
        const persistedAnswer = test.recorded.messageRows.find((row) => row.role === 'jamee');
        expect(persistedQuestion?.content, label).toBe(premise.question);
        expect(persistedAnswer?.content, label).toBe(answer.content);
        expect(persistedAnswer?.channel, label).toBe(channel);
        expect(test.recorded.touched, label).toStrictEqual([THREAD]);

        // The service reports which referral it was, so 4.7 and 7.6 stay distinguishable to a
        // caller even though both are honest answers.
        expect(outcome.answer.needsExpert, label).toBe(true);
      }),
      // 500 runs over two premises, five out-of-scope shapes, six in-scope shapes, two base shapes,
      // three diagnosis shapes, three languages and two channels.
      { numRuns: 500 },
    );

    /* ---------------------------------------------------------------------- */
    /* Non-vacuity: the generators produced every class the property names     */
    /* ---------------------------------------------------------------------- */

    // Both disjuncts of the design statement, and both are `knowledge.ts`'s own reasons.
    expect([...reasonsSeen].sort()).toStrictEqual([...REFERRAL_REASONS].sort());
    expect([...outOfScopeKindsSeen].sort()).toStrictEqual([...OUT_OF_SCOPE_KINDS].sort());
    expect([...inScopeKindsSeen].sort()).toStrictEqual([...IN_SCOPE_KINDS].sort());
    // Both a base that still held rows — so a leak had material — and the unseeded base.
    expect([...baseShapesSeen].sort()).toStrictEqual([...BASE_SHAPES].sort());
    expect([...decoysSeen].sort()).toStrictEqual([...DECOY_SHAPES].sort());
    // And the base really did hold treatment content on some runs, which is what makes "contains no
    // treatment content" a withheld fact rather than an absent one.
    expect([...treatmentsSeen].sort()).toStrictEqual([...TREATMENT_SHAPES].sort());
    // All three shapes behind the conversation, including the inconclusive row that exists and
    // still supplies no subject.
    expect([...diagnosisShapesSeen].sort()).toStrictEqual([...DIAGNOSIS_SHAPES].sort());
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
    // Requirement 7.7 — one implementation, exercised on both channels.
    expect([...channelsSeen].sort()).toStrictEqual(['web', 'whatsapp']);
    expect([...windowsSeen].sort()).toStrictEqual([...WINDOW_SHAPES].sort());
    // Every resolution-set size a chat question can ask for and be answered with nothing, up to all
    // five rows. A run that only ever asked for one would have proved nothing about the wide case.
    expect([...askedSizesSeen].sort((a, b) => a - b)).toStrictEqual([1, 2, 3, 4, 5]);

    // The enumerations themselves: every out-of-scope question really is outside the vocabulary, and
    // every in-scope question really does put exactly its declared names in scope.
    for (const kind of OUT_OF_SCOPE_KINDS) {
      expect(matchConditions(OUT_OF_SCOPE_TEXT[kind]), kind).toStrictEqual([]);
    }
    for (const kind of IN_SCOPE_KINDS) {
      const entry = IN_SCOPE_CASES[kind];
      expect(matchConditions(entry.text), kind).toStrictEqual([...entry.matched]);
    }
  });

  /* ======================================================================== */
  /* The boundary: what a referral is NOT, and what the spend rule turns on    */
  /* ======================================================================== */

  it('keeps the unit and returns grounded content whenever a provider call was attempted, including a failure and an exhausted budget', async () => {
    const classesSeen = new Set<SpendClass>();
    const languagesSeen = new Set<Language>();

    await fc.assert(
      fc.asyncProperty(spendClassArb, languageArb, channelArb, async (spendClass, language, channel) => {
        classesSeen.add(spendClass);
        languagesSeen.add(language);
        const label = `${spendClass} / ${language} / ${channel}`;

        const rows = VERIFIED_CONDITIONS.map((name, index) =>
          rowFor(name, tagFor(0x2000, index), [at(TAILS, 0), at(TAILS, 3)]),
        );
        const referral = spendClass === 'referral';
        // The one row `explicit_condition` resolves to, with no diagnosis behind the thread — so the
        // resolved set is exactly this row and it is the primary one.
        const primary = rowOf(rows, 'Tomato Late Blight');

        const test = harness({
          rows,
          transcript: transcriptFor(1),
          latestDiagnosis: null,
          behaviour: behaviourFor(spendClass, primary),
        });

        const outcome = await chatAnswerer(test.deps)(
          {
            userId: FARMER,
            conversationId: THREAD,
            message: referral
              ? OUT_OF_SCOPE_TEXT.other_crop
              : IN_SCOPE_CASES.explicit_condition.text,
            language,
            channel,
            inputKind: 'text',
          },
          ownsRequest(FARMER, 'chat'),
        );
        const { answer } = outcome;
        const audit = at(test.recorded.usageRows, 0);

        // The biconditional, in both directions and counted at the same seam. A referral attempted
        // no provider call and the unit goes back; every other class attempted exactly one — the
        // budget-exhausted class included, since the gateway declining to start is still an attempt
        // for this request — and the unit stays taken.
        expect(test.recorded.counts.increments, label).toBe(1);
        expect(test.recorded.counts.generate, label).toBe(referral ? 0 : 1);
        expect(test.recorded.counts.decrements, label).toBe(referral ? 1 : 0);
        expect(outcome.quota.used, label).toBe(referral ? 0 : 1);
        expect(audit.quota_spent, label).toBe(!referral);
        expect(audit.outcome, label).toBe(EXPECTED_OUTCOME[spendClass]);

        // Whatever happened to the model, the farmer never reads an error — and in particular never
        // reads `DIAGNOSIS_TIMEOUT`'s "send the photo again", which is wrong advice for a question
        // that carried no photo (`chat.service.ts`, *A model failure degrades; it does not surface
        // as a timeout*).
        assertNotAnErrorMessage(answer.content, language, label);

        if (referral) {
          expect(answer.needsExpert, label).toBe(true);
          expect(kbTokensIn(answer.content), label).toStrictEqual([]);
          return;
        }

        /* ── The contrast that makes clause 4 discriminating ─────────────── */

        // A grounded answer is content the farmer can act on, and on the degraded paths it is the
        // primary row's own template — treatment statements under the localized treatment heading.
        // So "a referral contains no treatment content" is a difference this code produces between
        // two paths, not a property of short copy.
        expect(answer.needsExpert, label).toBe(false);
        expect([...answer.groundedIn], label).toStrictEqual(['Tomato Late Blight']);
        expect(answer.content, label).toContain(primary.disease_name);

        if (spendClass === 'grounded_success') {
          expect(audit.model_provider, label).toBe('gemini');
          return;
        }

        expect(answer.content, label).toBe(staticExplanationFor(primary, language));
        expect(audit.model_provider, label).toBe('none');
        expect(answer.content, label).toContain(messages(language).ui.treatmentHeading);
        for (const statement of primary.treatment) {
          expect(answer.content, label).toContain(statement);
        }
      }),
      { numRuns: 120 },
    );

    expect([...classesSeen].sort()).toStrictEqual([...SPEND_CLASSES].sort());
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
  });
});

/* ========================================================================== */
/* The spend classes of the second test                                        */
/* ========================================================================== */

/**
 * The four ways a chat turn can end that the spend rule distinguishes.
 *
 * The two degraded ones are the interesting cells: a provider call was *attempted* and failed, so
 * the unit stays spent even though the farmer read a template rather than the model's prose. A test
 * that ran only the referral and the success would leave the biconditional's hard case unasserted.
 */
const SPEND_CLASSES = [
  'referral',
  'grounded_success',
  'grounded_provider_failed',
  'grounded_budget_exhausted',
] as const;

type SpendClass = (typeof SPEND_CLASSES)[number];

const spendClassArb = fc.constantFrom<SpendClass>(...SPEND_CLASSES);

/** `usage_logs.outcome` per class, from `chat.service.ts`'s shared degradation mapping. */
const EXPECTED_OUTCOME: Record<SpendClass, UsageOutcome> = {
  referral: 'inconclusive',
  grounded_success: 'success',
  grounded_provider_failed: 'provider_error',
  /** Requirement 3.7's outcome value, on a row whose operation is `chat`. */
  grounded_budget_exhausted: 'timeout',
};

function behaviourFor(spendClass: SpendClass, primary: KnowledgeEntry): Behaviour {
  switch (spendClass) {
    case 'referral':
      return { kind: 'tripwire' };
    case 'grounded_success':
      return { kind: 'text', text: `${primary.disease_name}. ${at(primary.symptoms, 0)}.` };
    case 'grounded_provider_failed':
      // Requirement 14.5's exhausted chain, which `chat.service.ts` degrades on rather than throwing.
      return {
        kind: 'fail',
        error: new AppError('PROVIDERS_UNAVAILABLE', { context: { reason: 'test_chain_exhausted' } }),
      };
    case 'grounded_budget_exhausted':
      // What the gateway raises when the request's own budget cannot cover an attempt.
      return {
        kind: 'fail',
        error: new AppError('DIAGNOSIS_TIMEOUT', { context: { budgetExhausted: true } }),
      };
  }
}
