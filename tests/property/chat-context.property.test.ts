import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner, TextCall } from '@/lib/ai/capabilities';
import { STORAGE_BUCKETS } from '@/lib/config/verified';
import { isAppError } from '@/lib/errors';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import {
  HEALTHY_CONDITION,
  SUPPORTED_LANGUAGES,
  VERIFIED_CONDITIONS,
  type Channel,
  type Language,
  type MessageRole,
  type VerifiedCondition,
} from '@/lib/schemas';
import {
  CONTEXT_MESSAGE_LIMIT,
  answerQuestion,
  assembleContext,
  contextStoreFrom,
  type ContextStore,
  type ConversationScope,
} from '@/services/chat.service';
import type { Database, DiagnosisRow, MessageRow } from '@/types/database';

/**
 * ### Property 15: Conversation context is complete for its conversation and isolated from every other
 *
 * *"For any two conversations belonging to any farmers, with arbitrarily interleaved message and
 * diagnosis timestamps, the context assembled for one conversation contains that conversation's most
 * recent diagnosis and only messages belonging to that conversation."*
 *
 * **Validates: Requirements 7.1, 7.2**
 *
 * =============================================================================
 * WHERE THE PROPERTY IS OBSERVED
 * =============================================================================
 *
 * `answerQuestion()` in `chat.service.ts`, end to end: `assembleContext()` reads the window,
 * `resolveScope()` puts rows in scope, and `chatPrompt()` composes the one string a model is handed.
 * Two things are therefore directly observable — the `ConversationContext` the service built, and
 * the **exact prompt** the context reached. The prompt is the boundary the property is really about:
 * a window that leaked is only harmful once it reaches a model, and that is where it would.
 *
 * =============================================================================
 * WHY THE ISOLATION IS PROVED RATHER THAN ASSUMED
 * =============================================================================
 *
 * The interesting failure — the one this property exists to catch — is a context read keyed on the
 * **farmer** instead of on the conversation, so a farmer's web thread and WhatsApp thread bleed into
 * each other. A test whose stub store filtered by `conversation_id` itself could never see that
 * failure: the stub would be doing the isolating, and the property would be about the stub.
 *
 * So the seam is pushed one level down. `deps.supabase` is a **generic row store** that speaks the
 * slice of PostgREST `contextStoreFrom()` uses — `from → select → eq* → order* → limit`
 * (`maybeSingle`) — and applies *only the predicates the production query actually asked for*.
 * Nothing in `fakeDatabase()` knows what a conversation is. The `.eq('conversation_id', …)` and
 * `.eq('user_id', …)` clauses in `contextStoreFrom()` are what narrow the rows, so:
 *
 *  - drop `conversation_id` from the messages read and the fake returns the farmer's other threads
 *    too, which the marker containment below reports as another conversation's text in the prompt;
 *  - drop `user_id` and the fake returns the intruder rows planted **inside** the subject
 *    conversation's id by a third farmer, same outcome;
 *  - drop either from the diagnosis read and `latestDiagnosis` becomes a row from somewhere else,
 *    which the `CURRENT DIAGNOSIS` line and the row-identity assertion report.
 *
 * A leak can surface in two ways, and both fail: as a foreign marker in the prompt, or as
 * `assembleContext()`'s own `context_scope_mismatch` refusal (`assertAllInScope`) — Jamee's second
 * barrier, which the last test in this file pins directly so that "the barrier exists" is a checked
 * fact rather than a hoped-for one.
 *
 * =============================================================================
 * MARKERS: "THIS TEXT CAME FROM THREAD B" AS A CHECKED FACT
 * =============================================================================
 *
 * Every generated piece of conversation content opens with a token naming its thread, its kind and
 * its index — `JAM1A2B-m0 the lower leaves are drying`. Each thread of a run gets its own four-hex
 * tag, and so does the intruder. `PROMPT_MARKERS` finds every such token in a string, which turns
 * the isolation half into a containment assertion instead of an assumption about the copy: **every**
 * marker found anywhere in the prompt must belong to the subject conversation, and the subject's own
 * message markers must all be there. The second half is what gives the first its teeth — markers
 * demonstrably survive into the prompt, so a foreign one would have shown up had it been in scope.
 *
 * Nothing else in a Jamee prompt can match the token shape: the knowledge rows, the rules block and
 * the fallback sentence are ordinary prose, and the only marker-bearing content is the farmer's
 * question and the transcript.
 *
 * =============================================================================
 * WHAT THIS PROPERTY DELIBERATELY DOES NOT ASSERT
 * =============================================================================
 *
 * **The two bounds.** `CONTEXT_MESSAGE_LIMIT` and `CONTEXT_TOKEN_BUDGET` are pinned by
 * `chat.service.test.ts`, and re-deriving the token trim here would mean re-implementing
 * `applyTokenBudget()` in the test and then comparing it with itself. Fixtures stay under both
 * bounds — asserted in the non-vacuity block against the constant itself — so the expected window is
 * simply "all of this conversation's messages, oldest first", which is a claim about the code rather
 * than a copy of it. `bound.rowsRead` is asserted for the same reason: a leaked row inflates it.
 *
 * **Which rows are grounded, and what the answer says.** Property 11's and Property 14's.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

/** Minutes 0–47 are the shuffled pool; 58 and 59 belong to the intruder — see `buildWorld`. */
const MINUTE_POOL: readonly number[] = Array.from({ length: 48 }, (_unused, index) => index);
const INTRUDER_MESSAGE_MINUTE = 58;
const INTRUDER_DIAGNOSIS_MINUTE = 59;

/** At most five messages per thread, comfortably inside `CONTEXT_MESSAGE_LIMIT`. */
const MAX_MESSAGES_PER_THREAD = 5;
/** At most three diagnoses per thread: enough for "most recent" to be a real choice. */
const MAX_DIAGNOSES_PER_THREAD = 3;

/** Two or three conversations per run, which is the property's "any two conversations". */
const MIN_THREADS = 2;
const MAX_THREADS = 3;

/**
 * Message tails. Deliberately free of the scope vocabulary derived from the five canonical names
 * (`tomato`, `potato`, `early`, `late`, `blight`, `healthy` — `knowledge.ts`), so the transcript
 * cannot quietly widen the resolved scope and change what the prompt carries.
 */
const MESSAGE_TAILS: readonly string[] = [
  'the lower leaves are drying',
  'i watered in the evening yesterday',
  'the spots grew after the rain',
  'how many days should i wait',
  'the field is on heavy soil',
  'i sprayed once last week',
];

/** Diagnosis explanations. Marker-tagged too, so a leaked diagnosis is as visible as a message. */
const DIAGNOSIS_TAILS: readonly string[] = [
  'dark patches on the older leaves',
  'a pale ring around each patch',
  'the crop needs attention this week',
];

/** Every marker token, whichever thread and whichever kind of row it came from. */
const PROMPT_MARKERS = /JAM[0-9A-F]{4}-[mdq]\d+/g;

/** `disease_knowledge.crop`, exhaustive so a sixth verified condition breaks this fixture loudly. */
const CROP_OF: Record<VerifiedCondition, KnowledgeEntry['crop']> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

/**
 * All five knowledge rows, stocked on every run.
 *
 * Plain prose, carrying no marker: what the grounding step puts in the prompt is Property 11's
 * claim, and a knowledge row that matched `PROMPT_MARKERS` would make this property's containment
 * check report legitimate content as a leak.
 */
const KNOWLEDGE_ROWS: readonly KnowledgeEntry[] = VERIFIED_CONDITIONS.map((condition, index) => {
  const healthy = condition === HEALTHY_CONDITION;
  return {
    id: `00000000-0000-4000-8000-0000000000${String(10 + index)}`,
    disease_name: condition,
    crop: CROP_OF[condition],
    scientific_name: healthy ? null : `pathogen ${index}`,
    symptoms: [`row ${index} symptom statement`],
    causes: [`row ${index} cause statement`],
    treatment: healthy ? [] : [`row ${index} treatment statement`],
    prevention: [`row ${index} prevention statement`],
    default_severity: healthy ? ('none' as const) : ('moderate' as const),
    source: `row ${index} extension bulletin`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
});

/** The reader every run injects: all five rows, filtered by the names the service asked for. */
const knowledgeReader: KnowledgeReader = (names) =>
  Promise.resolve(KNOWLEDGE_ROWS.filter((row) => names.includes(row.disease_name)));

function atMinute(minute: number): string {
  return `2026-09-15T10:${String(minute).padStart(2, '0')}:00.000Z`;
}

/** `noUncheckedIndexedAccess` is on; a missing fixture index is a defect in the fixture. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture index ${index} is absent`);
  return item;
}

/** `1A2B` — one tag per thread, distinct across every thread and the intruder of a run. */
function tagFor(seed: number, index: number): string {
  return (seed + index).toString(16).toUpperCase().padStart(4, '0');
}

function markerFor(tag: string, kind: 'm' | 'd' | 'q', index: number): string {
  return `JAM${tag}-${kind}${index}`;
}

function conditionAt(offset: number): VerifiedCondition {
  return at(VERIFIED_CONDITIONS, offset % VERIFIED_CONDITIONS.length);
}

/* ========================================================================== */
/* The generated world                                                         */
/* ========================================================================== */

/** What the subject conversation's newest diagnosis is, which decides the resolved subject. */
const SUBJECT_DIAGNOSIS_SHAPES = [
  /** An identified newest row, so the context carries its condition. */
  'identified_latest',
  /**
   * An inconclusive newest row over an older identified one. `condition` is `null` — "most recent,
   * full stop", with no reaching back past it (`ConversationContext.latestDiagnosis`).
   */
  'inconclusive_latest',
  /** No diagnosis at all, while every other thread has one. */
  'no_diagnosis',
] as const;

type SubjectDiagnosisShape = (typeof SUBJECT_DIAGNOSIS_SHAPES)[number];

/** Whether the subject shares its farmer with another thread, or the run crosses farmers. */
const OWNERSHIP_SHAPES = ['same_farmer', 'cross_farmer'] as const;
type OwnershipShape = (typeof OWNERSHIP_SHAPES)[number];

const WINDOW_SHAPES = ['empty', 'populated'] as const;
type WindowShape = (typeof WINDOW_SHAPES)[number];

const INTRUDER_SHAPES = ['absent', 'present'] as const;
type IntruderShape = (typeof INTRUDER_SHAPES)[number];

interface ThreadSpec {
  /** Index into the generated farmer ids, reduced modulo how many farmers this run uses. */
  readonly ownerOffset: number;
  readonly channel: Channel;
  readonly messageCount: number;
  readonly diagnosisCount: number;
}

interface Scenario {
  readonly tagSeed: number;
  readonly farmerCount: number;
  readonly threads: readonly ThreadSpec[];
  readonly subjectOffset: number;
  readonly subjectDiagnosis: SubjectDiagnosisShape;
  readonly withIntruder: boolean;
  readonly conditionBase: number;
  readonly askedOffset: number;
  readonly language: Language;
  /** A permutation of `MINUTE_POOL`: this is the "arbitrarily interleaved timestamps" clause. */
  readonly minutes: readonly number[];
  /** Three distinct farmer ids: two possible owners plus the intruder, who is never an owner. */
  readonly farmerIds: readonly string[];
  readonly conversationIds: readonly string[];
  readonly tailOffset: number;
}

const threadSpecArb: fc.Arbitrary<ThreadSpec> = fc.record({
  ownerOffset: fc.integer({ min: 0, max: 1 }),
  channel: fc.constantFrom<Channel>('web', 'whatsapp'),
  messageCount: fc.integer({ min: 0, max: MAX_MESSAGES_PER_THREAD }),
  diagnosisCount: fc.integer({ min: 1, max: MAX_DIAGNOSES_PER_THREAD }),
});

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  // `seed + 3` stays inside four hex digits, so all tags of a run are four characters and distinct.
  tagSeed: fc.integer({ min: 0x1000, max: 0xfff0 }),
  farmerCount: fc.integer({ min: 1, max: 2 }),
  threads: fc.array(threadSpecArb, { minLength: MIN_THREADS, maxLength: MAX_THREADS }),
  subjectOffset: fc.integer({ min: 0, max: MAX_THREADS - 1 }),
  subjectDiagnosis: fc.constantFrom<SubjectDiagnosisShape>(...SUBJECT_DIAGNOSIS_SHAPES),
  withIntruder: fc.boolean(),
  conditionBase: fc.integer({ min: 0, max: VERIFIED_CONDITIONS.length - 1 }),
  askedOffset: fc.integer({ min: 0, max: VERIFIED_CONDITIONS.length - 1 }),
  language: fc.constantFrom<Language>(...SUPPORTED_LANGUAGES),
  minutes: fc.shuffledSubarray([...MINUTE_POOL], {
    minLength: MINUTE_POOL.length,
    maxLength: MINUTE_POOL.length,
  }),
  farmerIds: fc.uniqueArray(fc.uuid(), { minLength: 3, maxLength: 3 }),
  conversationIds: fc.uniqueArray(fc.uuid(), { minLength: MAX_THREADS, maxLength: MAX_THREADS }),
  tailOffset: fc.integer({ min: 0, max: MESSAGE_TAILS.length - 1 }),
});

interface Thread {
  readonly id: string;
  readonly userId: string;
  readonly channel: Channel;
  readonly tag: string;
  /** Chronological, oldest → newest. */
  readonly messages: readonly MessageRow[];
  readonly diagnoses: readonly DiagnosisRow[];
  readonly latestDiagnosis: DiagnosisRow | null;
  readonly condition: VerifiedCondition | null;
}

interface World {
  readonly threads: readonly Thread[];
  readonly subject: Thread;
  /** Rows a third farmer planted inside the subject conversation's id, or `null`. */
  readonly intruderTag: string | null;
  readonly messages: readonly MessageRow[];
  readonly diagnoses: readonly DiagnosisRow[];
}

/**
 * Build the run's rows.
 *
 * Timestamps come off the generated permutation in construction order, so message and diagnosis
 * instants interleave arbitrarily **across** threads while staying distinct — which keeps the
 * expected window a total order without needing this test to re-derive the tie-breaking keys
 * `contextStoreFrom()` applies (those are `chat.service.test.ts`'s).
 *
 * Conditions are assigned **by recency rank rather than by construction index**: each thread's
 * newest diagnosis takes `conditionBase + threadIndex`, distinct across the run's threads, and its
 * older rows take later offsets, distinct from their own thread's newest. So every discriminating
 * failure has a distinguishable condition — a leak from another thread, and a reach-back to an older
 * row of this one, both name something other than the expected subject.
 */
function buildWorld(scenario: Scenario): World {
  let cursor = 0;
  const nextMinute = (): number => {
    const minute = at(scenario.minutes, cursor);
    cursor += 1;
    return minute;
  };

  const subjectIndex = scenario.subjectOffset % scenario.threads.length;

  const threads: Thread[] = scenario.threads.map((spec, index) => {
    const isSubject = index === subjectIndex;
    const tag = tagFor(scenario.tagSeed, index);
    const conversationId = at(scenario.conversationIds, index);
    const userId = at(scenario.farmerIds, spec.ownerOffset % scenario.farmerCount);

    const messages: MessageRow[] = Array.from(
      { length: spec.messageCount },
      (_unused, position) => ({
        id: `msg-${tag}-${position}`,
        conversation_id: conversationId,
        user_id: userId,
        role: (position % 2 === 0 ? 'farmer' : 'jamee') satisfies MessageRole as MessageRole,
        content: `${markerFor(tag, 'm', position)} ${at(
          MESSAGE_TAILS,
          (scenario.tailOffset + position) % MESSAGE_TAILS.length,
        )}`,
        language: scenario.language,
        channel: spec.channel,
        input_kind: 'text' as const,
        transcript_of: null,
        created_at: atMinute(nextMinute()),
      }),
    ).sort((left, right) => (left.created_at < right.created_at ? -1 : 1));

    const inconclusiveLatest =
      isSubject && scenario.subjectDiagnosis === 'inconclusive_latest';
    const count = isSubject
      ? scenario.subjectDiagnosis === 'no_diagnosis'
        ? 0
        : // An inconclusive newest row needs an older identified one behind it for the
          // no-reach-back claim to be discriminating.
          Math.max(inconclusiveLatest ? 2 : 1, spec.diagnosisCount)
      : spec.diagnosisCount;

    const instants = Array.from({ length: count }, () => atMinute(nextMinute())).sort((a, b) =>
      a < b ? -1 : 1,
    );

    const diagnoses: DiagnosisRow[] = instants.map((createdAt, position) => {
      // Rank from the newest: 0 is the newest row of this thread.
      const rank = instants.length - 1 - position;
      const newest = rank === 0;
      const condition = conditionAt(scenario.conditionBase + index + rank);
      const unknown = newest && inconclusiveLatest;
      return diagnosisRow({
        id: `dx-${tag}-${position}`,
        conversationId,
        userId,
        channel: spec.channel,
        language: scenario.language,
        marker: markerFor(tag, 'd', position),
        tail: at(DIAGNOSIS_TAILS, position % DIAGNOSIS_TAILS.length),
        condition: unknown ? null : condition,
        createdAt,
      });
    });

    const latestDiagnosis = diagnoses.length === 0 ? null : at(diagnoses, diagnoses.length - 1);

    return {
      id: conversationId,
      userId,
      channel: spec.channel,
      tag,
      messages,
      diagnoses,
      latestDiagnosis,
      condition: latestDiagnosis?.disease_name ?? null,
    };
  });

  const subject = at(threads, subjectIndex);

  const messages = threads.flatMap((thread) => thread.messages);
  const diagnoses = threads.flatMap((thread) => thread.diagnoses);

  if (!scenario.withIntruder) {
    return { threads, subject, intruderTag: null, messages, diagnoses };
  }

  /**
   * A third farmer's rows, carrying the **subject conversation's id**.
   *
   * This is what the `user_id` predicate defends, and nothing else in the fixture exercises it: a
   * read narrowed only by `conversation_id` would pull both rows in. Their instants sit past the
   * whole pool, so the planted diagnosis would win "most recent" and the planted message would be
   * the newest turn of the transcript — the leak is maximally visible rather than buried.
   */
  const intruderTag = tagFor(scenario.tagSeed, MAX_THREADS);
  const intruderId = at(scenario.farmerIds, 2);
  const intruderMessage: MessageRow = {
    id: `msg-${intruderTag}-0`,
    conversation_id: subject.id,
    user_id: intruderId,
    role: 'farmer',
    content: `${markerFor(intruderTag, 'm', 0)} ${at(MESSAGE_TAILS, 0)}`,
    language: scenario.language,
    channel: subject.channel,
    input_kind: 'text',
    transcript_of: null,
    created_at: atMinute(INTRUDER_MESSAGE_MINUTE),
  };
  const intruderDiagnosis = diagnosisRow({
    id: `dx-${intruderTag}-0`,
    conversationId: subject.id,
    userId: intruderId,
    channel: subject.channel,
    language: scenario.language,
    marker: markerFor(intruderTag, 'd', 0),
    tail: at(DIAGNOSIS_TAILS, 0),
    // Offset 4 differs from every thread's newest condition, whose offsets are 0, 1 and 2.
    condition: conditionAt(scenario.conditionBase + 4),
    createdAt: atMinute(INTRUDER_DIAGNOSIS_MINUTE),
  });

  return {
    threads,
    subject,
    intruderTag,
    messages: [...messages, intruderMessage],
    diagnoses: [...diagnoses, intruderDiagnosis],
  };
}

function diagnosisRow(options: {
  readonly id: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly channel: Channel;
  readonly language: Language;
  readonly marker: string;
  readonly tail: string;
  readonly condition: VerifiedCondition | null;
  readonly createdAt: string;
}): DiagnosisRow {
  const identified = options.condition !== null;
  return {
    id: options.id,
    user_id: options.userId,
    conversation_id: options.conversationId,
    // `diagnoses_unknown_shape` (Requirement 6.5): an inconclusive row carries no name, no
    // knowledge id, no confidence, severity `none`, and needs an expert.
    status: identified ? 'identified' : 'unknown',
    disease_name: options.condition,
    knowledge_id: identified ? at(KNOWLEDGE_ROWS, 0).id : null,
    confidence: identified ? 0.83 : null,
    severity: identified ? 'moderate' : 'none',
    explanation: `${options.marker} ${options.tail}`,
    language: options.language,
    needs_expert: !identified,
    channel: options.channel,
    image_bucket: STORAGE_BUCKETS.cropImages,
    image_path: `${options.userId}/2026/09/${options.id}.jpg`,
    full_image_deleted_at: null,
    model_provider: 'gemini',
    created_at: options.createdAt,
  };
}

/* ========================================================================== */
/* The database seam: predicates are production's, row matching is generic      */
/* ========================================================================== */

interface Predicate {
  readonly column: string;
  readonly value: unknown;
}

interface RecordedQuery {
  readonly table: string;
  readonly predicates: readonly Predicate[];
  readonly orders: readonly string[];
  readonly limit: number | null;
  readonly returned: number;
}

interface FakeDatabase {
  readonly client: SupabaseClient<Database>;
  readonly queries: readonly RecordedQuery[];
}

/**
 * A generic row store over the two tables the context read touches.
 *
 * It knows nothing about conversations, farmers or channels: it applies whatever `.eq()` predicates
 * the caller supplied, orders by whatever keys the caller named, and truncates to whatever limit the
 * caller asked for. That is the whole point — the narrowing is `contextStoreFrom()`'s, so this
 * property tests the production query rather than a restatement of it.
 *
 * Any other table is a hard failure: the knowledge reader is injected on every run, so a read of
 * `disease_knowledge` here would mean a seam was reached past and nothing recorded is trustworthy.
 */
function fakeDatabase(rows: {
  readonly messages: readonly MessageRow[];
  readonly diagnoses: readonly DiagnosisRow[];
}): FakeDatabase {
  const queries: RecordedQuery[] = [];

  const from = (table: string): unknown => {
    if (table !== 'messages' && table !== 'diagnoses') {
      throw new Error(
        `Property 15 stubs only "messages" and "diagnoses"; the context read reached "${table}"`,
      );
    }

    const predicates: Predicate[] = [];
    const orders: { column: string; ascending: boolean }[] = [];
    let limit: number | null = null;

    const run = (): readonly Record<string, unknown>[] => {
      const source = (
        table === 'messages' ? rows.messages : rows.diagnoses
      ) as readonly unknown[] as readonly Record<string, unknown>[];

      const matched = source.filter((row) =>
        predicates.every((predicate) => row[predicate.column] === predicate.value),
      );
      const ordered = [...matched].sort((left, right) => {
        for (const order of orders) {
          const a = String(left[order.column]);
          const b = String(right[order.column]);
          if (a === b) continue;
          const ascending = a < b ? -1 : 1;
          return order.ascending ? ascending : -ascending;
        }
        return 0;
      });
      const limited = limit === null ? ordered : ordered.slice(0, limit);

      queries.push({
        table,
        predicates: [...predicates],
        orders: orders.map((order) => `${order.column} ${order.ascending ? 'asc' : 'desc'}`),
        limit,
        returned: limited.length,
      });
      return limited;
    };

    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        predicates.push({ column, value });
        return builder;
      },
      order: (column: string, options?: { readonly ascending?: boolean }) => {
        orders.push({ column, ascending: options?.ascending ?? true });
        return builder;
      },
      limit: (rowCount: number) => {
        limit = rowCount;
        return builder;
      },
      maybeSingle: () => {
        const found = run();
        return Promise.resolve({ data: found[0] ?? null, error: null });
      },
      then: (resolve: (value: { data: unknown; error: null }) => unknown) =>
        resolve({ data: run(), error: null }),
    };

    return builder;
  };

  return { client: { from } as unknown as SupabaseClient<Database>, queries };
}

/** The one model call, present only so the prompt it is handed can be read back. */
function promptCapture(answer: string): { readonly models: CapabilityRunner; prompts: string[] } {
  const prompts: string[] = [];
  const models: CapabilityRunner = {
    classify: () =>
      Promise.reject(new Error('Property 15 makes no vision call; the chat path must not classify')),
    generate: (call: TextCall) => {
      prompts.push(call.prompt);
      return Promise.resolve({ value: answer, provider: 'gemini' as const, usedFallback: false });
    },
  };
  return { models, prompts };
}

/* ========================================================================== */
/* Readers over the prompt                                                     */
/* ========================================================================== */

function markersIn(text: string): readonly string[] {
  return text.match(PROMPT_MARKERS) ?? [];
}

function predicateOf(query: RecordedQuery, column: string): unknown {
  const found = query.predicates.filter((predicate) => predicate.column === column);
  if (found.length !== 1) {
    throw new Error(
      `the ${query.table} read carried ${found.length} "${column}" predicates; expected exactly one`,
    );
  }
  return at(found, 0).value;
}

function queryFor(queries: readonly RecordedQuery[], table: string): RecordedQuery {
  const found = queries.filter((query) => query.table === table);
  if (found.length !== 1) {
    throw new Error(`expected exactly one read of "${table}"; saw ${found.length}`);
  }
  return at(found, 0);
}

/* ========================================================================== */
/* Property 15                                                                 */
/* ========================================================================== */

describe('Property 15: conversation context is complete for its conversation and isolated from every other', () => {
  it('carries this conversation\u2019s own messages and its most recent diagnosis, and nothing from any other conversation', async () => {
    const ownershipsSeen = new Set<OwnershipShape>();
    const diagnosisShapesSeen = new Set<SubjectDiagnosisShape>();
    const intrudersSeen = new Set<IntruderShape>();
    const windowsSeen = new Set<WindowShape>();
    const threadCountsSeen = new Set<number>();
    const channelsSeen = new Set<Channel>();
    const languagesSeen = new Set<Language>();
    /** Runs where another conversation actually held content there was something to leak. */
    let sawForeignMessages = false;
    let sawForeignDiagnoses = false;

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const world = buildWorld(scenario);
        const { subject } = world;
        const others = world.threads.filter((thread) => thread !== subject);

        const askedCondition = conditionAt(scenario.askedOffset);
        const questionMarker = markerFor(subject.tag, 'q', 0);
        const question = `${questionMarker} what should i do about ${askedCondition} now?`;

        diagnosisShapesSeen.add(scenario.subjectDiagnosis);
        intrudersSeen.add(world.intruderTag === null ? 'absent' : 'present');
        windowsSeen.add(subject.messages.length === 0 ? 'empty' : 'populated');
        threadCountsSeen.add(world.threads.length);
        channelsSeen.add(subject.channel);
        languagesSeen.add(scenario.language);
        for (const other of others) {
          ownershipsSeen.add(other.userId === subject.userId ? 'same_farmer' : 'cross_farmer');
          if (other.messages.length > 0) sawForeignMessages = true;
          if (other.diagnoses.length > 0) sawForeignDiagnoses = true;
        }

        const db = fakeDatabase({ messages: world.messages, diagnoses: world.diagnoses });
        const capture = promptCapture(`${askedCondition} needs attention this week.`);

        const outcome = await answerQuestion(
          {
            conversationId: subject.id,
            userId: subject.userId,
            message: question,
            language: scenario.language,
          },
          { supabase: db.client, knowledge: knowledgeReader, models: capture.models },
        );

        const label = `${scenario.subjectDiagnosis} / ${world.threads.length} threads / intruder ${
          world.intruderTag === null ? 'absent' : 'present'
        }`;

        /* ================================================================== */
        /* 1. The window is exactly this conversation's messages (7.2)          */
        /* ================================================================== */

        const { context } = outcome;
        expect(context.conversationId, label).toBe(subject.id);
        expect(context.userId, label).toBe(subject.userId);

        // Every message of this conversation, oldest first, and no row from anywhere else. The
        // fixtures stay inside both bounds (asserted below), so the expected window is the whole
        // thread rather than a re-derivation of the trim.
        expect(context.messages.map((row) => row.id), label).toStrictEqual(
          subject.messages.map((row) => row.id),
        );
        expect(
          context.messages.every(
            (row) => row.conversation_id === subject.id && row.user_id === subject.userId,
          ),
          label,
        ).toBe(true);
        expect(context.bound.rowsRead, label).toBe(subject.messages.length);
        expect(context.bound.boundedBy, label).toBe('complete');

        /* ================================================================== */
        /* 2. The most recent diagnosis is this conversation's (7.1)            */
        /* ================================================================== */

        expect(context.latestDiagnosis?.id ?? null, label).toBe(subject.latestDiagnosis?.id ?? null);
        expect(context.condition, label).toBe(subject.condition);

        // An inconclusive newest row, and a conversation with no diagnosis at all, both resolve to
        // no subject — never to an older identified row of this thread, and never to another
        // thread's condition, both of which the fixture makes distinguishable by construction.
        if (scenario.subjectDiagnosis !== 'identified_latest') {
          expect(context.condition, label).toBeNull();
        }

        /* ================================================================== */
        /* 3. Both reads were narrowed by conversation AND by farmer            */
        /* ================================================================== */

        // Not the proof of isolation — step 4 is — but the diagnosis of *why* an isolation failure
        // happened, read off the query the production code actually issued.
        expect(db.queries.map((query) => query.table).sort(), label).toStrictEqual([
          'diagnoses',
          'messages',
        ]);
        for (const table of ['messages', 'diagnoses'] as const) {
          const query = queryFor(db.queries, table);
          expect(predicateOf(query, 'conversation_id'), `${label}: ${table}`).toBe(subject.id);
          expect(predicateOf(query, 'user_id'), `${label}: ${table}`).toBe(subject.userId);
        }

        /* ================================================================== */
        /* 4. The prompt carries this conversation's content and no other's     */
        /* ================================================================== */

        expect(outcome.referralReason, label).toBeNull();
        expect(capture.prompts.length, label).toBe(1);
        const prompt = at(capture.prompts, 0);

        const ownMessageMarkers = subject.messages.map((_row, index) =>
          markerFor(subject.tag, 'm', index),
        );
        const permitted = new Set<string>([
          ...ownMessageMarkers,
          ...subject.diagnoses.map((_row, index) => markerFor(subject.tag, 'd', index)),
          questionMarker,
        ]);

        // The containment claim. Every marker the prompt contains belongs to this conversation —
        // its transcript, its diagnoses, or the farmer's own question.
        for (const marker of markersIn(prompt)) {
          expect(
            permitted.has(marker),
            `${label}: "${marker}" belongs to another conversation and reached the prompt`,
          ).toBe(true);
        }

        // And the completeness claim, which is what gives the containment claim its teeth: this
        // conversation's own turns demonstrably do cross into the prompt, so a foreign one would
        // have been visible had it been in the window.
        for (const marker of ownMessageMarkers) {
          expect(prompt, label).toContain(marker);
        }

        // The subject a follow-up would resolve against, on the line the model reads it from.
        expect(prompt, label).toContain(`CURRENT DIAGNOSIS: ${subject.condition ?? 'none'}`);

        // Stated as a marker-free check too, since a condition name cannot be marker-tagged: no
        // other thread's established condition appears anywhere in the prompt unless the question
        // or this thread's own diagnosis put it there.
        const inScope = new Set<string>([askedCondition, ...(subject.condition === null ? [] : [subject.condition])]);
        for (const other of others) {
          if (other.condition === null || inScope.has(other.condition)) continue;
          expect(
            prompt.includes(other.condition),
            `${label}: another conversation's condition "${other.condition}" reached the prompt`,
          ).toBe(false);
        }

        // The normal path ran: no degradation is masking any of the above.
        expect(outcome.degradation, label).toBeNull();
      }),
      // 300 runs over three diagnosis shapes, two thread counts, the intruder switch and three
      // languages, so every cell is reached many times rather than probably.
      { numRuns: 300 },
    );

    /* ---------------------------------------------------------------------- */
    /* Non-vacuity: the generators produced the cases the property needs       */
    /* ---------------------------------------------------------------------- */

    // A run that only ever built one conversation would pass this property while proving nothing.
    expect([...threadCountsSeen].sort()).toStrictEqual([MIN_THREADS, MAX_THREADS]);
    // Both halves of "any farmers": a second thread of the SAME farmer, which is what a
    // farmer-keyed context read would leak, and a thread of a different farmer.
    expect([...ownershipsSeen].sort()).toStrictEqual([...OWNERSHIP_SHAPES].sort());
    // And a third farmer's rows planted inside the subject conversation's id, which is what the
    // `user_id` predicate defends.
    expect([...intrudersSeen].sort()).toStrictEqual([...INTRUDER_SHAPES].sort());
    // There was something to leak on both sides of the boundary.
    expect(sawForeignMessages).toBe(true);
    expect(sawForeignDiagnoses).toBe(true);
    // All three subject shapes, so the diagnosis half is asserted for a present condition, for an
    // inconclusive newest row, and for a thread with no diagnosis at all.
    expect([...diagnosisShapesSeen].sort()).toStrictEqual([...SUBJECT_DIAGNOSIS_SHAPES].sort());
    // Both an empty window and a populated one; the empty one is the case where every marker in the
    // prompt has to come from the question alone.
    expect([...windowsSeen].sort()).toStrictEqual([...WINDOW_SHAPES].sort());
    expect([...channelsSeen].sort()).toStrictEqual(['web', 'whatsapp']);
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());

    // The fixture really does stay inside the row cap, so "the whole thread" was a fair expectation
    // rather than an accident of the current constant.
    expect(MAX_MESSAGES_PER_THREAD).toBeLessThan(CONTEXT_MESSAGE_LIMIT);
  });

  /* ------------------------------------------------------------------------ */
  /* The second barrier, pinned                                               */
  /* ------------------------------------------------------------------------ */

  it('refuses a farmer-keyed window instead of letting another conversation reach a prompt', async () => {
    const farmer = '11111111-1111-4111-8111-111111111111';
    const thread = '22222222-2222-4222-8222-222222222222';
    const otherThread = '33333333-3333-4333-8333-333333333333';
    const scope: ConversationScope = { conversationId: thread, userId: farmer };

    /**
     * The failure Property 15 exists to catch, injected at the store seam: a read that grouped by
     * farmer and so returned this farmer's *other* thread. `assembleContext()`'s post-condition is
     * the barrier behind the query predicates — on the WhatsApp path it is the only one, since the
     * service-role client has no RLS behind it — so a dropped predicate surfaces as a loud refusal
     * rather than as another conversation's text inside a prompt.
     */
    const farmerKeyedStore: ContextStore = {
      recentMessages: () =>
        Promise.resolve([
          {
            id: 'msg-leak-0',
            conversation_id: otherThread,
            user_id: farmer,
            role: 'farmer',
            content: `${markerFor('BEEF', 'm', 0)} ${at(MESSAGE_TAILS, 0)}`,
            language: 'en',
            channel: 'whatsapp',
            input_kind: 'text',
            transcript_of: null,
            created_at: atMinute(10),
          },
        ]),
      latestDiagnosis: () => Promise.resolve(null),
    };

    const failure = await assembleContext(scope, { store: farmerKeyedStore }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(isAppError(failure)).toBe(true);
    if (!isAppError(failure)) throw new Error('a leaked window was accepted');
    expect(failure.code).toBe('INTERNAL_ERROR');
    expect(failure.context?.reason).toBe('context_scope_mismatch');
    // The other conversation's identifiers are deliberately absent from the log line: copying them
    // in would spread the leak the check just stopped.
    expect(JSON.stringify(failure.context)).not.toContain(otherThread);
  });

  /* ------------------------------------------------------------------------ */
  /* The harness's own claim, checked rather than argued                       */
  /* ------------------------------------------------------------------------ */

  it('narrows only by the predicates it is given, so a farmer-keyed read really does return two threads', async () => {
    const farmer = '11111111-1111-4111-8111-111111111111';
    const intruder = '44444444-4444-4444-8444-444444444444';
    const thread = '22222222-2222-4222-8222-222222222222';
    const otherThread = '33333333-3333-4333-8333-333333333333';

    const rowFor = (
      id: string,
      conversationId: string,
      userId: string,
      marker: string,
    ): MessageRow => ({
      id,
      conversation_id: conversationId,
      user_id: userId,
      role: 'farmer',
      content: `${marker} ${at(MESSAGE_TAILS, 0)}`,
      language: 'en',
      channel: 'whatsapp',
      input_kind: 'text',
      transcript_of: null,
      created_at: atMinute(10),
    });

    const rows = [
      rowFor('ours', thread, farmer, markerFor('AAAA', 'm', 0)),
      rowFor('other-thread', otherThread, farmer, markerFor('BBBB', 'm', 0)),
      rowFor('intruder', thread, intruder, markerFor('CCCC', 'm', 0)),
    ];
    const db = fakeDatabase({ messages: rows, diagnoses: [] });

    /**
     * The whole basis of this property: the fake is a generic row store, so a query missing a
     * predicate is *wider*, not equal. This is the query a context read keyed on the farmer would
     * issue — one `.eq()` instead of two — and it comes back with the other thread's row in it.
     *
     * Without this check, "the fake would have surfaced a leak" would be an argument in a comment.
     * With it, the containment assertions above are known to be over a store that can leak.
     */
    const { data: farmerKeyed } = await db.client
      .from('messages')
      .select('*')
      .eq('user_id', farmer)
      .order('created_at', { ascending: false })
      .limit(CONTEXT_MESSAGE_LIMIT);

    expect((farmerKeyed ?? []).map((row) => row.id).sort()).toStrictEqual(['other-thread', 'ours']);

    // A read keyed on the conversation alone is wider in the other direction: it admits the row a
    // third farmer planted inside this conversation's id.
    const { data: conversationKeyed } = await db.client
      .from('messages')
      .select('*')
      .eq('conversation_id', thread)
      .order('created_at', { ascending: false })
      .limit(CONTEXT_MESSAGE_LIMIT);

    expect((conversationKeyed ?? []).map((row) => row.id).sort()).toStrictEqual([
      'intruder',
      'ours',
    ]);

    // And the production read, over the identical rows: both predicates, one thread, one farmer.
    const read = await contextStoreFrom(db.client).recentMessages(
      { conversationId: thread, userId: farmer },
      CONTEXT_MESSAGE_LIMIT,
    );
    expect(read.map((row) => row.id)).toStrictEqual(['ours']);
  });
});
