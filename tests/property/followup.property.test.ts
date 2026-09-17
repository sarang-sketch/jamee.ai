import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner, TextCall } from '@/lib/ai/capabilities';
import { STORAGE_BUCKETS } from '@/lib/config/verified';
import { matchConditions, type KnowledgeEntry, type KnowledgeReader } from '@/lib/knowledge';
import {
  HEALTHY_CONDITION,
  SUPPORTED_LANGUAGES,
  VERIFIED_CONDITIONS,
  type Channel,
  type Language,
  type MessageRole,
  type VerifiedCondition,
} from '@/lib/schemas';
import { answerQuestion, type ChatTurnOutcome } from '@/services/chat.service';
import { conversationStoreFrom, findOrCreateActive } from '@/services/conversation.service';
import type { ConversationRow, Database, DiagnosisRow, MessageRow } from '@/types/database';

/**
 * ### Property 16: Subject-less follow-ups resolve to the latest diagnosis on either channel
 *
 * *"For any conversation on either channel that contains at least one diagnosis, and any follow-up
 * question with no explicit subject, the resolved subject is the condition of the most recent
 * diagnosis in that conversation."*
 *
 * **Validates: Requirements 7.3, 10.8**
 *
 * =============================================================================
 * WHERE THE PROPERTY IS OBSERVED
 * =============================================================================
 *
 * `answerQuestion()` in `chat.service.ts`, which is where Requirement 7.3 is a single argument list:
 * `resolveScope({ condition: context.condition, question })`. The resolved subject is therefore
 * observable in four independent places, and all four are asserted rather than the most convenient
 * one:
 *
 *  1. **The names the knowledge reader was asked for.** Exactly `[condition]` — the strongest form,
 *     because it is the read the answer is grounded in, recorded at the seam.
 *  2. **`answer.groundedIn`**, which is the field a farmer's client receives.
 *  3. **The prompt's `CURRENT DIAGNOSIS:` line**, which is where the model is told what "why?"
 *     refers to.
 *  4. **The prompt's `VERIFIED CONTENT` block**, marker-tagged per knowledge row, so "this row and
 *     no other reached the model" is a containment check rather than an assumption.
 *
 * =============================================================================
 * HOW "RESOLVED AGAINST THE CONVERSATION" IS PROVED RATHER THAN ASSUMED
 * =============================================================================
 *
 * A subject-less follow-up could appear to resolve correctly for three uninteresting reasons: the
 * question smuggled its own vocabulary, the fixture had only one condition available, or the service
 * fell back to a default. Each is closed:
 *
 *  - **The question contributes nothing.** Every enumerated follow-up shape is asserted against
 *    `matchConditions()` directly — inside the property and again over the whole enumeration — so
 *    "no explicit subject" is a checked fact about the text rather than an intention. `knowledge.ts`
 *    is explicit that Devanagari contributes no tokens at all; two of the shapes are Devanagari and
 *    the other five are English that carries none of the five names' vocabulary.
 *  - **There is a wrong answer available, and it is distinguishable.** The farmer holds a web thread
 *    and a WhatsApp thread at once (`conversation.service.ts` keeps them as separate rows), each
 *    with its own diagnoses on **interleaved** timestamps, and the two threads' newest conditions are
 *    distinct by construction. So resolving against the farmer instead of the conversation, or
 *    against the globally newest diagnosis, names a different condition — and the coverage set below
 *    asserts that the run really did produce the case where the other thread's diagnosis is newer.
 *  - **There is no default to fall back to.** Every iteration also asks the *same* question in a
 *    third conversation of the same farmer that has messages but no diagnosis. That must come back
 *    as the honest referral with no model call — which is what makes the two resolved cases
 *    attributable to the conversation's own diagnosis and nothing else.
 *
 * =============================================================================
 * REQUIREMENT 10.8 — "ON EITHER CHANNEL", RUN AS A PARITY CLAIM
 * =============================================================================
 *
 * Requirement 10.8 says a WhatsApp follow-up resolves against the most recent Diagnosis_Result in
 * the conversation identified for that farmer. That is two clauses, and both are run.
 *
 * **"…in the Conversation."** `answerQuestion()` takes no `channel` — deliberately, since the key is
 * the conversation (Requirement 7.2) — so this half is tested as parity: both conversations are
 * exercised on **every** iteration, one `web` and one `whatsapp`, with the same question and the
 * same farmer, and each must resolve to its own thread's condition. The `both_identified` coverage
 * class asserts the run reached the case where the two answers must differ, which is the case a
 * channel-blind or farmer-keyed resolution gets wrong.
 *
 * **"the Conversation identified for that Farmer."** The identification itself is
 * `findOrCreateActive(userId, 'whatsapp')` in `conversation.service.ts`, and skipping it would leave
 * the requirement's first clause asserted by the fixture handing the right id over. So every
 * iteration also runs the WhatsApp path as one chain — identify, assemble, resolve — through the
 * same generic row store, with the farmer holding **more than one** conversation row and the row
 * recencies generated. `conversation_recency` asserts the run reached the case where a web row is
 * the farmer's most recently updated conversation, which is the case a `channel`-blind
 * identification gets wrong: it hands the web thread to a WhatsApp follow-up, and the answer is
 * about a different photo than the one the farmer just sent.
 *
 * =============================================================================
 * THE MOST RECENT DIAGNOSIS, FULL STOP
 * =============================================================================
 *
 * When a thread's newest diagnosis is inconclusive it carries no name
 * (`diagnoses_unknown_shape`, Requirement 6.5), so the resolved subject is nothing and the
 * follow-up gets Requirement 4.7's referral. That is asserted, not avoided: those threads hold an
 * **older identified** diagnosis whose condition is distinct, so a service that reached back past
 * the newest row would resolve to it and fail. `ConversationContext.latestDiagnosis` states the same
 * reading — reaching back would answer a follow-up about a different photo than the one the farmer
 * just sent.
 */

/* ========================================================================== */
/* The follow-up shapes                                                        */
/* ========================================================================== */

/**
 * Subject-less follow-ups, enumerated so the run can prove it exercised every one.
 *
 * None carries any of the vocabulary derived from the five canonical names — `tomato`, `potato`,
 * `early`, `late`, `blight`, `healthy` (`knowledge.ts`) — which is what makes them subject-less
 * rather than merely short. `matchConditions()` is asserted over all seven below.
 */
const FOLLOW_UP_SHAPES = [
  'why',
  'how_much',
  'the_spray',
  'when',
  'how_many_days',
  'hindi',
  'marathi',
] as const;

type FollowUpShape = (typeof FOLLOW_UP_SHAPES)[number];

const FOLLOW_UP_TEXT: Record<FollowUpShape, string> = {
  /** The design's own two examples of a subject-less question (`prompts.ts`, Requirement 7.3). */
  why: 'why?',
  how_much: 'how much?',
  the_spray: 'what about the spray?',
  when: 'and when should i do it?',
  how_many_days: 'for how many days?',
  /** Devanagari: "why did this happen?" — no Latin token at all, so no vocabulary either. */
  hindi: '\u0910\u0938\u093e \u0915\u094d\u092f\u094b\u0902 \u0939\u0941\u0906?',
  /** Devanagari: "how many times should I spray?" */
  marathi:
    '\u0915\u093f\u0924\u0940 \u0935\u0947\u0933\u093e \u092b\u0935\u093e\u0930\u0923\u0940 \u0915\u0930\u093e\u0935\u0940?',
};

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

/** The two channel threads plus the no-diagnosis control thread. */
const THREAD_COUNT = 3;
const CONTROL_INDEX = 2;

const MAX_MESSAGES_PER_THREAD = 4;
const MAX_DIAGNOSES_PER_THREAD = 3;

/** Minutes 0–35, shuffled: the interleaving of both threads' diagnoses and messages. */
const MINUTE_POOL: readonly number[] = Array.from({ length: 36 }, (_unused, index) => index);

/**
 * `conversations.updated_at` slots, past the row pool so the two spaces cannot be confused.
 *
 * One slot per thread, assigned by a generated permutation, so which of the farmer's conversation
 * rows is the most recently updated one varies across the run — see `RECORD_RECENCY_SHAPES`.
 */
const CONVERSATION_MINUTE_BASE = 40;

const MESSAGE_TAILS: readonly string[] = [
  'the lower leaves are drying',
  'i watered in the evening yesterday',
  'the spots grew after the rain',
  'the field is on heavy soil',
];

const KB_FIELDS = ['symptoms', 'causes', 'treatment', 'prevention'] as const;
type KbField = (typeof KB_FIELDS)[number];

/**
 * Every knowledge-row statement marker, whichever row and whichever column it came from.
 *
 * Nothing else in a Jamee chat prompt can match this shape: the rules block, the fallback sentence
 * and the transcript are ordinary prose, so a match is always a statement from a generated row.
 */
const KB_MARKERS = /KB[0-9A-F]{4}-(?:symptoms|causes|treatment|prevention)\d+/g;

/** `KB1A2B-symptoms0` — one tag per row, one token per statement. */
function markerFor(tag: string, field: KbField, index: number): string {
  return `KB${tag}-${field}${index}`;
}

const CROP_OF: Record<VerifiedCondition, KnowledgeEntry['crop']> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture index ${index} is absent`);
  return item;
}

function atMinute(minute: number): string {
  return `2026-09-15T10:${String(minute).padStart(2, '0')}:00.000Z`;
}

function tagFor(seed: number, index: number): string {
  return (seed + index).toString(16).toUpperCase().padStart(4, '0');
}

function conditionAt(offset: number): VerifiedCondition {
  return at(VERIFIED_CONDITIONS, offset % VERIFIED_CONDITIONS.length);
}

/**
 * The five knowledge rows, each tagged so the prompt's verified content is attributable to one row.
 *
 * All five are stocked on every run — a reader holding only the expected row would make "this row
 * and no other" true by fixture rather than by the resolution under test.
 */
function knowledgeRowsFor(seed: number): readonly KnowledgeEntry[] {
  return VERIFIED_CONDITIONS.map((condition, index) => {
    const tag = tagFor(seed, index);
    const healthy = condition === HEALTHY_CONDITION;
    const statements = (field: KbField): string[] => [
      `${markerFor(tag, field, 0)} statement for ${field}`,
    ];
    return {
      id: `00000000-0000-4000-8000-${tag.padStart(12, '0')}`,
      disease_name: condition,
      crop: CROP_OF[condition],
      scientific_name: healthy ? null : `${tag} pathogen`,
      symptoms: statements('symptoms'),
      causes: statements('causes'),
      // Requirement 3.4 and the `healthy_has_no_treatment` check constraint.
      treatment: healthy ? [] : statements('treatment'),
      prevention: statements('prevention'),
      default_severity: healthy ? ('none' as const) : ('moderate' as const),
      source: `${tag} extension bulletin`,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
  });
}

/** Every marker of one row, whichever column it sits in. */
function markersOf(entry: KnowledgeEntry): readonly string[] {
  return KB_FIELDS.flatMap((field) => entry[field].flatMap((item) => item.match(KB_MARKERS) ?? []));
}

/**
 * How many markers a row **must** contribute: one per non-empty content field.
 *
 * The containment check below is a loop over the markers of a row, and a row that carried none would
 * make it pass by iterating over nothing. So the expected count is derived from the row's own
 * columns and asserted, which turns "the fixture is tagged" into a checked fact rather than a
 * property of the string literal above. `treatment` is empty for the healthy row (Requirement 3.4),
 * which is why this counts non-empty fields rather than all four.
 */
function expectedMarkerCount(entry: KnowledgeEntry): number {
  return KB_FIELDS.filter((field) => entry[field].length > 0).length;
}

/* ========================================================================== */
/* The generated world                                                         */
/* ========================================================================== */

/** What a thread's newest diagnosis is, which is what the follow-up must resolve against. */
const LATEST_SHAPES = [
  /** Identified: the subject is its condition. */
  'identified',
  /**
   * Inconclusive over an older identified row: the subject is nothing, and the honest referral
   * follows. Reaching back to the older row would resolve to a distinguishable condition.
   */
  'inconclusive',
] as const;

type LatestShape = (typeof LATEST_SHAPES)[number];

/** Whether the farmer's newest diagnosis anywhere is in the thread being asked about. */
const RECENCY_SHAPES = ['own_thread_newest', 'other_thread_newer'] as const;
type RecencyShape = (typeof RECENCY_SHAPES)[number];

/** Whether the resolution reached a grounded answer or the referral. */
const OUTCOME_SHAPES = ['resolved', 'referral'] as const;
type OutcomeShape = (typeof OUTCOME_SHAPES)[number];

/**
 * Whether the farmer's most recently updated **conversation row** is his WhatsApp thread or one of
 * his web threads.
 *
 * The second class is the discriminating one for the identification step: an identification narrowed
 * only by `user_id` returns that web row, and a WhatsApp follow-up would then be answered against a
 * thread the farmer never wrote to from WhatsApp.
 */
const RECORD_RECENCY_SHAPES = ['whatsapp_row_newest', 'web_row_newest'] as const;
type RecordRecencyShape = (typeof RECORD_RECENCY_SHAPES)[number];

interface ThreadSpec {
  readonly messageCount: number;
  readonly diagnosisCount: number;
  readonly latest: LatestShape;
}

interface Scenario {
  readonly kbSeed: number;
  readonly shape: FollowUpShape;
  readonly language: Language;
  readonly conditionBase: number;
  /** The web thread, then the WhatsApp thread. The control thread is generated separately. */
  readonly threads: readonly [ThreadSpec, ThreadSpec];
  readonly controlMessageCount: number;
  readonly minutes: readonly number[];
  readonly farmerId: string;
  readonly conversationIds: readonly string[];
  readonly tailOffset: number;
  /**
   * A permutation of `[0, 1, 2]`: thread index → `updated_at` slot on its `conversations` row. The
   * farmer's three rows therefore have distinct instants in a generated order, and which row is his
   * most recently updated one varies rather than being fixed by construction order.
   */
  readonly conversationRecency: readonly number[];
}

const threadSpecArb: fc.Arbitrary<ThreadSpec> = fc.record({
  messageCount: fc.integer({ min: 0, max: MAX_MESSAGES_PER_THREAD }),
  diagnosisCount: fc.integer({ min: 1, max: MAX_DIAGNOSES_PER_THREAD }),
  latest: fc.constantFrom<LatestShape>(...LATEST_SHAPES),
});

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  kbSeed: fc.integer({ min: 0x1000, max: 0xfff0 }),
  shape: fc.constantFrom<FollowUpShape>(...FOLLOW_UP_SHAPES),
  language: fc.constantFrom<Language>(...SUPPORTED_LANGUAGES),
  conditionBase: fc.integer({ min: 0, max: VERIFIED_CONDITIONS.length - 1 }),
  threads: fc.tuple(threadSpecArb, threadSpecArb),
  controlMessageCount: fc.integer({ min: 0, max: MAX_MESSAGES_PER_THREAD }),
  minutes: fc.shuffledSubarray([...MINUTE_POOL], {
    minLength: MINUTE_POOL.length,
    maxLength: MINUTE_POOL.length,
  }),
  farmerId: fc.uuid(),
  conversationIds: fc.uniqueArray(fc.uuid(), { minLength: THREAD_COUNT, maxLength: THREAD_COUNT }),
  tailOffset: fc.integer({ min: 0, max: MESSAGE_TAILS.length - 1 }),
  conversationRecency: fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
});

interface Thread {
  readonly id: string;
  readonly channel: Channel;
  readonly messages: readonly MessageRow[];
  readonly diagnoses: readonly DiagnosisRow[];
  readonly latestDiagnosis: DiagnosisRow | null;
  /** The subject a subject-less follow-up in this thread must resolve to. `null` → referral. */
  readonly condition: VerifiedCondition | null;
  /** The condition of the newest *identified* row, present even when the newest row is not. */
  readonly reachBackCondition: VerifiedCondition | null;
}

interface World {
  readonly farmerId: string;
  /** The `web` thread and the `whatsapp` thread, both carrying at least one diagnosis. */
  readonly channelThreads: readonly [Thread, Thread];
  /** Messages, no diagnosis: the per-iteration control that closes the "a default" reading. */
  readonly control: Thread;
  readonly messages: readonly MessageRow[];
  readonly diagnoses: readonly DiagnosisRow[];
  /**
   * One `conversations` row per thread, all owned by this farmer: the rows the identification step
   * of Requirement 10.8 reads. Deliberately **more than one**, and only one of them on `whatsapp`,
   * so "the Conversation identified for that Farmer" is a choice the production query has to make.
   */
  readonly conversationRows: readonly ConversationRow[];
  /** The row `order(updated_at desc, id desc)` picks when narrowed by `user_id` alone. */
  readonly newestConversationId: string;
}

const CHANNELS: readonly [Channel, Channel] = ['web', 'whatsapp'];

/**
 * Build the run's rows.
 *
 * Timestamps come off the generated permutation in construction order, so the two threads' rows
 * interleave arbitrarily while staying distinct. Conditions are assigned **by recency rank**: each
 * thread's newest identified row takes `conditionBase + threadIndex`, distinct between the two
 * threads, and its older rows take later offsets, distinct from their own thread's newest. Every
 * wrong answer a resolution could give — the other thread's condition, or an older row of this one —
 * is therefore a different name than the right one.
 */
function buildWorld(scenario: Scenario): World {
  let cursor = 0;
  const nextMinute = (): number => {
    const minute = at(scenario.minutes, cursor);
    cursor += 1;
    return minute;
  };

  const messagesFor = (
    conversationId: string,
    channel: Channel,
    count: number,
    tail: number,
  ): readonly MessageRow[] =>
    Array.from({ length: count }, (_unused, position) => ({
      id: `msg-${conversationId.slice(0, 8)}-${position}`,
      conversation_id: conversationId,
      user_id: scenario.farmerId,
      role: (position % 2 === 0 ? 'farmer' : 'jamee') satisfies MessageRole as MessageRole,
      content: at(MESSAGE_TAILS, (tail + position) % MESSAGE_TAILS.length),
      language: scenario.language,
      channel,
      input_kind: 'text' as const,
      transcript_of: null,
      created_at: atMinute(nextMinute()),
    })).sort((left, right) => (left.created_at < right.created_at ? -1 : 1));

  const channelThreads = CHANNELS.map((channel, index): Thread => {
    const spec = at(scenario.threads, index);
    const conversationId = at(scenario.conversationIds, index);
    const inconclusiveLatest = spec.latest === 'inconclusive';
    // An inconclusive newest row needs an older identified one behind it, so "no reaching back" is
    // a discriminating claim rather than a vacuous one.
    const count = Math.max(inconclusiveLatest ? 2 : 1, spec.diagnosisCount);

    const instants = Array.from({ length: count }, () => atMinute(nextMinute())).sort((a, b) =>
      a < b ? -1 : 1,
    );

    const diagnoses = instants.map((createdAt, position) => {
      const rank = instants.length - 1 - position;
      const unknown = rank === 0 && inconclusiveLatest;
      return diagnosisRow({
        id: `dx-${conversationId.slice(0, 8)}-${position}`,
        conversationId,
        userId: scenario.farmerId,
        channel,
        language: scenario.language,
        condition: unknown ? null : conditionAt(scenario.conditionBase + index + rank),
        createdAt,
      });
    });

    const latestDiagnosis = at(diagnoses, diagnoses.length - 1);
    const newestIdentified = [...diagnoses]
      .reverse()
      .find((row) => row.disease_name !== null)?.disease_name;

    return {
      id: conversationId,
      channel,
      messages: messagesFor(conversationId, channel, spec.messageCount, scenario.tailOffset),
      diagnoses,
      latestDiagnosis,
      condition: latestDiagnosis.disease_name,
      reachBackCondition: newestIdentified ?? null,
    };
  });

  const [web, whatsapp] = channelThreads;
  if (web === undefined || whatsapp === undefined) {
    throw new Error('both channel threads must exist');
  }

  const controlId = at(scenario.conversationIds, CONTROL_INDEX);
  /**
   * The control thread is a **second web** conversation of the same farmer, not a second WhatsApp
   * one. Requirement 7.5 creates a conversation per diagnosis started without one, so a returning
   * web farmer legitimately accumulates threads — `conversation.service.ts` says so outright, and
   * its plural is the reason the identification below reads "the most recently updated" rather than
   * "the" conversation. Two WhatsApp rows would instead be the split history that module treats as a
   * defect, and pinning behaviour on it here would pin a state Jamee tries not to reach.
   */
  const control: Thread = {
    id: controlId,
    channel: 'web',
    messages: messagesFor(controlId, 'web', scenario.controlMessageCount, scenario.tailOffset),
    diagnoses: [],
    latestDiagnosis: null,
    condition: null,
    reachBackCondition: null,
  };

  const threads = [web, whatsapp, control];

  const conversationRows: readonly ConversationRow[] = threads.map((thread, index) => ({
    id: thread.id,
    user_id: scenario.farmerId,
    channel: thread.channel,
    title: null,
    created_at: atMinute(CONVERSATION_MINUTE_BASE),
    updated_at: atMinute(CONVERSATION_MINUTE_BASE + at(scenario.conversationRecency, index)),
  }));

  // The same total order `conversationStoreFrom()` asks the database for, applied here only to name
  // the row a `user_id`-only read would return — never to narrow anything.
  const newest = [...conversationRows].sort((left, right) =>
    left.updated_at === right.updated_at
      ? right.id.localeCompare(left.id)
      : right.updated_at.localeCompare(left.updated_at),
  );

  return {
    farmerId: scenario.farmerId,
    channelThreads: [web, whatsapp],
    control,
    messages: threads.flatMap((thread) => thread.messages),
    diagnoses: threads.flatMap((thread) => thread.diagnoses),
    conversationRows,
    newestConversationId: at(newest, 0).id,
  };
}

function diagnosisRow(options: {
  readonly id: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly channel: Channel;
  readonly language: Language;
  readonly condition: VerifiedCondition | null;
  readonly createdAt: string;
}): DiagnosisRow {
  const identified = options.condition !== null;
  return {
    id: options.id,
    user_id: options.userId,
    conversation_id: options.conversationId,
    status: identified ? 'identified' : 'unknown',
    disease_name: options.condition,
    knowledge_id: identified ? '00000000-0000-4000-8000-000000000001' : null,
    confidence: identified ? 0.81 : null,
    severity: identified ? 'moderate' : 'none',
    explanation: identified ? 'dark patches on the older leaves' : 'the photo could not be judged',
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
/* The harness — the context read runs against a generic row store              */
/* ========================================================================== */

interface Predicate {
  readonly column: string;
  readonly value: unknown;
}

const STUBBED_TABLES = ['messages', 'diagnoses', 'conversations'] as const;
type StubbedTable = (typeof STUBBED_TABLES)[number];

function isStubbed(table: string): table is StubbedTable {
  return (STUBBED_TABLES as readonly string[]).includes(table);
}

/**
 * A generic row store over the three tables this property's reads touch: it applies whatever `.eq()`
 * predicates the production query supplied, orders by whatever keys it named, and truncates to
 * whatever limit it asked for. Nothing here knows what a conversation or a channel is, so both
 * narrowings the property depends on — the one that makes a follow-up resolve against **this** thread
 * (`contextStoreFrom()`) and the one that identifies the farmer's WhatsApp thread
 * (`conversationStoreFrom()`) — are the production queries' rather than the fixture's. A missing
 * predicate is therefore a *wider* read, not an equal one.
 *
 * Any other table is a hard failure: the knowledge reader is injected on every run. So is any write.
 * Every thread of the world already has a `conversations` row, so `findOrCreateActive()` must find
 * one rather than create one, and an insert would mean the read that should have found it did not.
 */
function fakeDatabase(rows: {
  readonly messages: readonly MessageRow[];
  readonly diagnoses: readonly DiagnosisRow[];
  readonly conversations?: readonly ConversationRow[];
}): SupabaseClient<Database> {
  const sourceFor = (table: StubbedTable): readonly unknown[] => {
    if (table === 'messages') return rows.messages;
    if (table === 'diagnoses') return rows.diagnoses;
    return rows.conversations ?? [];
  };

  const from = (table: string): unknown => {
    if (!isStubbed(table)) {
      throw new Error(
        `Property 16 stubs only ${STUBBED_TABLES.join(', ')}; a read reached "${table}"`,
      );
    }

    const predicates: Predicate[] = [];
    const orders: { column: string; ascending: boolean }[] = [];
    let limit: number | null = null;

    const run = (): readonly Record<string, unknown>[] => {
      const source = sourceFor(table) as readonly Record<string, unknown>[];

      const ordered = source
        .filter((row) => predicates.every((predicate) => row[predicate.column] === predicate.value))
        .sort((left, right) => {
          for (const order of orders) {
            const a = String(left[order.column]);
            const b = String(right[order.column]);
            if (a === b) continue;
            const ascending = a < b ? -1 : 1;
            return order.ascending ? ascending : -ascending;
          }
          return 0;
        });
      return limit === null ? ordered : ordered.slice(0, limit);
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
      insert: () => {
        throw new Error(
          `Property 16 writes nothing; an insert into "${table}" means a read that should have found an existing row did not`,
        );
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

  return { from } as unknown as SupabaseClient<Database>;
}

interface Recorded {
  /** Every name set the knowledge reader was asked for. The resolved subject, at the seam. */
  readonly knowledgeReads: VerifiedCondition[][];
  /** Every prompt the text seam was handed. */
  readonly prompts: string[];
}

/** Ask one question in one conversation, with every seam injected and both reads recorded. */
async function ask(options: {
  readonly world: World;
  readonly conversationId: string;
  readonly question: string;
  readonly language: Language;
  readonly rows: readonly KnowledgeEntry[];
  readonly answer: string;
}): Promise<{ readonly outcome: ChatTurnOutcome; readonly recorded: Recorded }> {
  const recorded: Recorded = { knowledgeReads: [], prompts: [] };

  const knowledge: KnowledgeReader = (names) => {
    recorded.knowledgeReads.push([...names]);
    return Promise.resolve(options.rows.filter((row) => names.includes(row.disease_name)));
  };

  const models: CapabilityRunner = {
    classify: () =>
      Promise.reject(new Error('Property 16 makes no vision call; a follow-up is a text turn')),
    generate: (call: TextCall) => {
      recorded.prompts.push(call.prompt);
      return Promise.resolve({
        value: options.answer,
        provider: 'gemini' as const,
        usedFallback: false,
      });
    },
  };

  const outcome = await answerQuestion(
    {
      conversationId: options.conversationId,
      userId: options.world.farmerId,
      message: options.question,
      language: options.language,
    },
    {
      supabase: fakeDatabase({
        messages: options.world.messages,
        diagnoses: options.world.diagnoses,
      }),
      knowledge,
      models,
    },
  );

  return { outcome, recorded };
}

function markersIn(text: string): readonly string[] {
  return text.match(KB_MARKERS) ?? [];
}

function entryFor(
  rows: readonly KnowledgeEntry[],
  condition: VerifiedCondition,
): KnowledgeEntry {
  const found = rows.find((row) => row.disease_name === condition);
  if (found === undefined) throw new Error(`no generated row for "${condition}"`);
  return found;
}

/**
 * Requirement 10.8's first clause: which conversation is this farmer's WhatsApp thread.
 *
 * Runs the production find-or-create over the same generic row store, so the `channel` predicate in
 * `conversationStoreFrom()` is what has to distinguish the farmer's one WhatsApp row from his two
 * web rows.
 */
function identifyWhatsAppThread(world: World): Promise<ConversationRow> {
  return findOrCreateActive(
    world.farmerId,
    'whatsapp',
    conversationStoreFrom(
      fakeDatabase({
        messages: world.messages,
        diagnoses: world.diagnoses,
        conversations: world.conversationRows,
      }),
    ),
  );
}

/* ========================================================================== */
/* Property 16                                                                 */
/* ========================================================================== */

describe('Property 16: subject-less follow-ups resolve to the latest diagnosis on either channel', () => {
  it('resolves a subject-less follow-up against its own conversation\u2019s most recent diagnosis, on both channels', async () => {
    const shapesSeen = new Set<FollowUpShape>();
    const languagesSeen = new Set<Language>();
    const channelsSeen = new Set<Channel>();
    const latestShapesSeen = new Set<LatestShape>();
    const recenciesSeen = new Set<RecencyShape>();
    const outcomesSeen = new Set<OutcomeShape>();
    const recordRecenciesSeen = new Set<RecordRecencyShape>();
    /** Runs where both threads had a condition, so the two answers had to differ. */
    let sawBothIdentified = false;

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const world = buildWorld(scenario);
        const rows = knowledgeRowsFor(scenario.kbSeed);
        const question = FOLLOW_UP_TEXT[scenario.shape];

        shapesSeen.add(scenario.shape);
        languagesSeen.add(scenario.language);

        const [web, whatsapp] = world.channelThreads;

        // The fixture's own invariant, stated: the two threads cannot resolve to the same name, so
        // "its own conversation" is a discriminating claim on every iteration.
        if (web.condition !== null && whatsapp.condition !== null) {
          sawBothIdentified = true;
          expect(web.condition).not.toBe(whatsapp.condition);
        }

        /* ================================================================== */
        /* 0. The question carries no explicit subject                          */
        /* ================================================================== */

        // Asserted per iteration and not only over the enumeration, because this is the premise the
        // whole property rests on: whatever the resolution turns out to be, the question did not
        // supply it.
        expect(matchConditions(question), scenario.shape).toStrictEqual([]);

        /* ================================================================== */
        /* 1. Each channel thread resolves to its OWN most recent diagnosis     */
        /*    (Requirements 7.3, 10.8)                                         */
        /* ================================================================== */

        const newestInstant = world.diagnoses
          .map((row) => row.created_at)
          .reduce((left, right) => (left > right ? left : right), '');

        for (const thread of world.channelThreads) {
          const other = thread === web ? whatsapp : web;
          const expected = thread.condition;
          const label = `${scenario.shape} / ${thread.channel} / latest ${
            expected ?? 'inconclusive'
          }`;

          channelsSeen.add(thread.channel);
          latestShapesSeen.add(expected === null ? 'inconclusive' : 'identified');
          recenciesSeen.add(
            thread.latestDiagnosis?.created_at === newestInstant
              ? 'own_thread_newest'
              : 'other_thread_newer',
          );
          outcomesSeen.add(expected === null ? 'referral' : 'resolved');

          const asked = await ask({
            world,
            conversationId: thread.id,
            question,
            language: scenario.language,
            rows,
            answer:
              expected === null
                ? 'unused'
                : `${expected}. ${at(entryFor(rows, expected).symptoms, 0)}`,
          });
          const { outcome, recorded } = asked;

          // The context half: the most recent diagnosis of THIS conversation, and the subject read
          // off it (Requirement 7.1's second clause, which 7.3 then resolves against).
          expect(outcome.context.latestDiagnosis?.id ?? null, label).toBe(
            thread.latestDiagnosis?.id ?? null,
          );
          expect(outcome.context.condition, label).toBe(expected);

          if (expected === null) {
            /* ── The newest row is inconclusive: no subject, and no reach-back ── */

            // Requirement 4.7's referral, and the proof that nothing was resolved: the knowledge
            // base was never read and no model was called at all.
            expect(outcome.referralReason, label).toBe('out_of_scope');
            expect(recorded.knowledgeReads, label).toStrictEqual([]);
            expect(recorded.prompts, label).toStrictEqual([]);
            expect(outcome.provider, label).toBeNull();
            expect([...outcome.answer.groundedIn], label).toStrictEqual([]);
            expect(outcome.answer.needsExpert, label).toBe(true);
            // The older identified row of this same thread exists and was NOT reached for.
            expect(thread.reachBackCondition, label).not.toBeNull();
            continue;
          }

          /* ── The newest row is identified: it is the subject ─────────────── */

          // (1) The read the answer is grounded in: exactly this condition, nothing beside it.
          expect(recorded.knowledgeReads, label).toStrictEqual([[expected]]);
          // (2) What the farmer's client receives.
          expect([...outcome.answer.groundedIn], label).toStrictEqual([expected]);
          expect(outcome.referralReason, label).toBeNull();
          expect(outcome.degradation, label).toBeNull();

          expect(recorded.prompts.length, label).toBe(1);
          const prompt = at(recorded.prompts, 0);

          // (3) The line that tells the model what "why?" refers to.
          expect(prompt, label).toContain(`CURRENT DIAGNOSIS: ${expected}`);

          // (4) The verified content is this condition's row and no other — a containment check
          // over five stocked rows, each tagged, rather than an assumption about the copy.
          const entry = entryFor(rows, expected);
          const permitted = new Set<string>(markersOf(entry));
          // The containment loop is over this set, so an untagged fixture would make it vacuous.
          expect(permitted.size, label).toBe(expectedMarkerCount(entry));
          expect(permitted.size, label).toBeGreaterThan(0);
          for (const marker of markersIn(prompt)) {
            expect(
              permitted.has(marker),
              `${label}: "${marker}" is another row's content and reached the prompt`,
            ).toBe(true);
          }
          for (const marker of permitted) {
            expect(prompt, label).toContain(marker);
          }

          // And the wrong answers are absent by name: the other thread's condition, and this
          // thread's older rows' conditions, none of which the resolution may reach.
          for (const wrong of [
            other.condition,
            ...thread.diagnoses.slice(0, -1).map((row) => row.disease_name),
          ]) {
            if (wrong === null || wrong === expected) continue;
            expect(
              prompt.includes(wrong),
              `${label}: "${wrong}" is not this conversation's subject and reached the prompt`,
            ).toBe(false);
          }
        }

        /* ================================================================== */
        /* 2. Requirement 10.8 end to end: identify the farmer's WhatsApp        */
        /*    conversation, then resolve the follow-up against THAT one          */
        /* ================================================================== */

        // Step 1 asked in a conversation the fixture named. Requirement 10.8's own wording — "the
        // Conversation identified for that Farmer" — puts one more step in front of that, and
        // leaving it out would mean the fixture, not Jamee, chose the thread a WhatsApp follow-up is
        // answered in. So the whole path runs as one chain here: identify, assemble, resolve.
        const identified = await identifyWhatsAppThread(world);
        const waLabel = `${scenario.shape} / identified whatsapp thread`;

        recordRecenciesSeen.add(
          world.newestConversationId === whatsapp.id ? 'whatsapp_row_newest' : 'web_row_newest',
        );

        // The farmer holds three conversation rows and exactly one is on WhatsApp; the identified
        // thread is that one, whichever row happens to be his most recently updated overall.
        expect(identified.id, waLabel).toBe(whatsapp.id);
        expect(identified.channel, waLabel).toBe('whatsapp');
        expect(identified.user_id, waLabel).toBe(world.farmerId);

        const viaAdapter = await ask({
          world,
          conversationId: identified.id,
          question,
          language: scenario.language,
          rows,
          answer:
            whatsapp.condition === null
              ? 'unused'
              : `${whatsapp.condition}. ${at(entryFor(rows, whatsapp.condition).symptoms, 0)}`,
        });

        // The same subject step 1 reached for this thread, now arrived at without the fixture naming
        // the conversation: the WhatsApp thread's own most recent diagnosis, and never the web
        // thread's — which is what a `channel`-blind identification would have handed over whenever
        // a web row was the farmer's most recently updated one.
        expect(viaAdapter.outcome.context.conversationId, waLabel).toBe(whatsapp.id);
        expect(viaAdapter.outcome.context.latestDiagnosis?.id ?? null, waLabel).toBe(
          whatsapp.latestDiagnosis?.id ?? null,
        );
        expect(viaAdapter.outcome.context.condition, waLabel).toBe(whatsapp.condition);
        expect([...viaAdapter.outcome.answer.groundedIn], waLabel).toStrictEqual(
          whatsapp.condition === null ? [] : [whatsapp.condition],
        );

        const webCondition = web.condition;
        if (webCondition !== null && webCondition !== whatsapp.condition) {
          expect(
            viaAdapter.recorded.prompts.some((prompt) => prompt.includes(webCondition)),
            `${waLabel}: the web thread\u2019s condition reached a WhatsApp follow-up`,
          ).toBe(false);
        }

        /* ================================================================== */
        /* 3. The control: the same question, a thread with no diagnosis        */
        /* ================================================================== */

        // Nothing to resolve against, so nothing is resolved — which is what makes the two results
        // above attributable to their conversations' diagnoses rather than to a default.
        const control = await ask({
          world,
          conversationId: world.control.id,
          question,
          language: scenario.language,
          rows,
          answer: 'unused',
        });

        const controlLabel = `${scenario.shape} / control thread`;
        expect(control.outcome.context.latestDiagnosis, controlLabel).toBeNull();
        expect(control.outcome.context.condition, controlLabel).toBeNull();
        expect(control.outcome.referralReason, controlLabel).toBe('out_of_scope');
        expect(control.recorded.knowledgeReads, controlLabel).toStrictEqual([]);
        expect(control.recorded.prompts, controlLabel).toStrictEqual([]);
        expect(control.outcome.answer.needsExpert, controlLabel).toBe(true);
      }),
      // 200 runs, each asking three questions, over seven follow-up shapes, two channels, two
      // newest-row shapes and three languages.
      { numRuns: 200 },
    );

    /* ---------------------------------------------------------------------- */
    /* Non-vacuity: the generators produced every case the property needs      */
    /* ---------------------------------------------------------------------- */

    expect([...shapesSeen].sort()).toStrictEqual([...FOLLOW_UP_SHAPES].sort());
    // Requirement 10.8's "either channel", exercised on every iteration rather than probably.
    expect([...channelsSeen].sort()).toStrictEqual(['web', 'whatsapp']);
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
    // Both newest-row shapes, so the property covers a resolvable subject and an inconclusive
    // newest row whose older identified sibling must not be reached for.
    expect([...latestShapesSeen].sort()).toStrictEqual([...LATEST_SHAPES].sort());
    expect([...outcomesSeen].sort()).toStrictEqual([...OUTCOME_SHAPES].sort());
    // The discriminating interleaving: the farmer's newest diagnosis was sometimes in the thread
    // being asked about and sometimes in the other one. Without the second case, a resolution that
    // picked the farmer's globally newest diagnosis would have passed.
    expect([...recenciesSeen].sort()).toStrictEqual([...RECENCY_SHAPES].sort());
    // The same discrimination one level up, for the identification step: the farmer's most recently
    // updated conversation row was sometimes his WhatsApp thread and sometimes one of his web
    // threads. Without the second case, an identification narrowed only by `user_id` would have
    // passed.
    expect([...recordRecenciesSeen].sort()).toStrictEqual([...RECORD_RECENCY_SHAPES].sort());
    // And the case where the two channels had to give different answers really did occur.
    expect(sawBothIdentified).toBe(true);
  });

  /* ------------------------------------------------------------------------ */
  /* The premise, over the whole enumeration                                  */
  /* ------------------------------------------------------------------------ */

  it('has no explicit subject in any enumerated follow-up shape', () => {
    for (const shape of FOLLOW_UP_SHAPES) {
      const question = FOLLOW_UP_TEXT[shape];
      // The pure matcher, asked directly: none of these questions contributes a condition of its
      // own, in any tier of `matchConditions`. A shape that did would make this property pass for
      // the wrong reason.
      expect(matchConditions(question), shape).toStrictEqual([]);
      // And none of them names a canonical condition outright, which is the same claim read as a
      // fact about the text a farmer typed.
      for (const condition of VERIFIED_CONDITIONS) {
        expect(question.toLowerCase().includes(condition.toLowerCase()), shape).toBe(false);
      }
    }
  });
});
