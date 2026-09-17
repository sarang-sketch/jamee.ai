import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner } from '@/lib/ai/capabilities';
import { STORAGE_BUCKETS } from '@/lib/config/verified';
import { AppError } from '@/lib/errors';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import {
  HEALTHY_CONDITION,
  SUPPORTED_LANGUAGES,
  VERIFIED_CONDITIONS,
  channelSchema,
  inputKindSchema,
  type Channel,
  type ChatInput,
  type InputKind,
  type Language,
  type VerifiedCondition,
} from '@/lib/schemas';
import type { StorageClientLike } from '@/lib/storage';
import {
  chatTurn,
  type ChatTurnDeps,
  type ChatWriteStore,
  type ContextStore,
} from '@/services/chat.service';
import { conversationStoreFrom, findOrCreateActive } from '@/services/conversation.service';
import { diagnose, type DiagnosisDeps, type DiagnosisStore } from '@/services/diagnosis.service';
import {
  coveredBy,
  ownsRequest,
  reserveForRequest,
  type CounterRpc,
  type QuotaContext,
} from '@/services/quota.service';
import type {
  ConversationRow,
  Database,
  DiagnosisRow,
  MessageRow,
  TablesInsert,
} from '@/types/database';

/**
 * ### Property 17: Conversation and message persistence round-trips, carrying the channel
 *
 * *"For any chat exchange, exactly one farmer message and one Jamee answer are persisted in the same
 * conversation with the correct roles; for any diagnosis request submitted without a conversation
 * identifier, a conversation is created and the diagnosis references it; and for any operation on
 * either channel, every persisted row records the channel value supplied to the service."*
 *
 * **Validates: Requirements 3.3, 7.4, 7.5, 16.5**
 *
 * =============================================================================
 * THE CLAIM IS ABOUT ROWS, SO EVERY ASSERTION READS A ROW
 * =============================================================================
 *
 * The returned object is not evidence. `ChatTurnResult` carries two message ids and
 * `DiagnosisOutcome` carries a conversation id, and a service that composed those correctly while
 * writing a row with the wrong `channel`, the wrong `role`, or the wrong `conversation_id` would
 * satisfy every assertion anyone could make about the return value. So each of the three clauses is
 * decided on the **insert payload**:
 *
 *  - `messages` and `diagnoses` and `usage_logs` are observed at their persistence seams
 *    (`ChatWriteStore`, `DiagnosisStore`), which is where the fully composed
 *    `TablesInsert<'…'>` row is handed over. That row is the row PostgREST would receive.
 *  - `conversations` is observed one layer deeper, through the **real** `conversationStoreFrom()`
 *    adapter over an in-memory table. It has to be: the `{ user_id, channel }` insert body for a
 *    conversation is composed *inside* that adapter, so a `ConversationStore` seam would have let
 *    the fixture supply the very column the property is about. Everything the two services do to a
 *    conversation — the find-or-create read, its total order, the read-back, the create — runs as
 *    shipped against that table.
 *
 * The return values are still checked, but only as a **bridge**: the ids a farmer's client receives
 * must be the ids of the rows that were written. That is a different claim from the rows being
 * right, and it is asserted after them rather than instead of them.
 *
 * =============================================================================
 * WHAT "EVERY OPERATION ON EITHER CHANNEL" IS GENERATED OVER
 * =============================================================================
 *
 * Both channels, and all three of `InputKind`'s values, because those are the three ways an
 * operation arrives:
 *
 *  - **`text`** — a typed question. `chatTurn()` with `inputKind: 'text'`, as `/api/chat` calls it.
 *  - **`voice`** — a transcript. `chatTurn()` with `inputKind: 'voice'`, `transcriptOf`,
 *    `skipQuotaReserve: true` and a real `coveredBy()` reservation, which is exactly the
 *    `ChatInput` `voice.service.ts` composes. The boolean alone would be a wiring defect —
 *    `quotaContextFor()` throws on it — so the coverage is a genuine reservation taken through
 *    `reserveForRequest()`, not a flag.
 *  - **`image`** — a crop photo. `diagnose()`, which persists a `diagnoses` row rather than a
 *    `messages` row. That asymmetry is the requirement's, not a gap in the property: Requirement 7.4
 *    is about an answer the Chat_Service produced, and Requirement 3.3 is the diagnosis's own row.
 *
 * Both channels are generated for every kind, and the `whatsapp` cells are not decoration: the two
 * channels reach these functions with different credentials in production, and the row is the only
 * place the difference is supposed to show.
 *
 * =============================================================================
 * CLAUSE 2 IS A PAIR OF CASES, NOT ONE
 * =============================================================================
 *
 * "For any diagnosis request submitted **without** a conversation identifier" is only half a claim
 * unless the other half is also pinned, so the image kind generates both:
 *
 *  - **absent** — the table starts empty, `diagnose()` must create exactly one conversation, and the
 *    persisted diagnosis must reference the row that was created.
 *  - **supplied** — a conversation already exists, and `diagnose()` must create **nothing** and
 *    reference the id it was given. Without this case, a service that created a spare conversation
 *    on every request would pass clause 2 perfectly.
 *
 * The chat kinds always carry an identifier — `ChatInput.conversationId` is required, because
 * Requirement 7.2 keys the context on it — so their conversation is created by an explicit
 * `findOrCreateActive()` call first, which is where their conversation row's channel is read from.
 *
 * =============================================================================
 * NO PROVIDER, NO DATABASE
 * =============================================================================
 *
 * Every seam is injected: storage, the counter RPC, the knowledge reader, the context reads, the
 * capability runner and both persistence stores. The request client itself is a proxy that throws on
 * any read, so a service reaching past its dependencies fails loudly instead of quietly making the
 * recorded rows irrelevant.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const CROP_IMAGES = STORAGE_BUCKETS.cropImages;

/** 2026-09-16T01:30:00Z. Fixed, so a run owns its clock and never reads the wall clock. */
const NOW_MS = Date.parse('2026-09-16T01:30:00.000Z');

const CHANNELS = channelSchema.options;
const INPUT_KINDS = inputKindSchema.options;

const CROP_OF: Record<VerifiedCondition, KnowledgeEntry['crop']> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

function uuidFor(prefix: string, serial: number): string {
  return `${prefix}-0000-4000-8000-${String(serial).padStart(12, '0')}`;
}

/**
 * The five knowledge rows, so nothing in this property rests on a base holding exactly the row it
 * needed. Deliberately terse: what an explanation is made of is Property 10's claim, not this one's.
 */
const KNOWLEDGE_ROWS: readonly KnowledgeEntry[] = VERIFIED_CONDITIONS.map((condition, index) => {
  const healthy = condition === HEALTHY_CONDITION;
  return {
    id: uuidFor('1000abcd', index + 1),
    disease_name: condition,
    crop: CROP_OF[condition],
    scientific_name: healthy ? null : `${condition} pathogen`,
    symptoms: [`${condition} symptom line`],
    causes: [`${condition} cause line`],
    // Empty for the healthy row, as the `healthy_has_no_treatment` check constraint requires.
    treatment: healthy ? [] : [`${condition} treatment line`],
    prevention: [`${condition} prevention line`],
    default_severity: healthy ? 'none' : 'moderate',
    source: `${condition} extension bulletin`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
});

function entryFor(condition: VerifiedCondition): KnowledgeEntry {
  const found = KNOWLEDGE_ROWS.find((row) => row.disease_name === condition);
  if (found === undefined) throw new Error(`no generated row for "${condition}"`);
  return found;
}

/**
 * Questions carrying **no** verified vocabulary, so `resolveScope()` refers the farmer onward
 * (Requirement 4.7) rather than reaching a row. None of them contains a crop, a condition word, or
 * `blight`, which is what makes the referral branch reachable at all.
 */
const OUT_OF_SCOPE_QUESTIONS: readonly string[] = [
  'how much water does wheat need in summer',
  'which fertilizer suits sugarcane in this season',
  'when should I sow onions',
];

/**
 * Subject-less follow-ups. They contribute no vocabulary either, so the scope comes from the
 * conversation's own most recent diagnosis — Requirement 7.3's route, and the one every Hindi and
 * Marathi question takes.
 */
const FOLLOW_UP_QUESTIONS: readonly string[] = ['why?', 'what should I do now', 'how serious is it'];

/* ========================================================================== */
/* The conversations table, behind the REAL store adapter                      */
/* ========================================================================== */

interface ReadPlan {
  readonly filters: { readonly column: string; readonly value: unknown }[];
  readonly orders: { readonly column: string; readonly ascending: boolean }[];
  cap: number | null;
}

interface SelectChain {
  eq(column: string, value: unknown): SelectChain;
  order(column: string, options: { ascending: boolean }): SelectChain;
  limit(count: number): SelectChain;
  maybeSingle(): Promise<{ data: ConversationRow | null; error: null }>;
}

interface ConversationsTable {
  /** The rows the table holds, newest last. */
  readonly rows: readonly ConversationRow[];
  /** Every insert body, exactly as `conversationStoreFrom()` composed it. */
  readonly inserts: readonly TablesInsert<'conversations'>[];
  /** The client the real adapter is bound to. */
  readonly client: SupabaseClient<Database>;
}

function columnOf(row: ConversationRow, column: string): unknown {
  return (row as unknown as Record<string, unknown>)[column];
}

/**
 * An in-memory `conversations` table that answers the two chains `conversation.service.ts` actually
 * issues — `select → eq → eq → order → order → limit → maybeSingle` and
 * `insert → select → single`.
 *
 * Narrow on purpose. It is not a Supabase emulator: it exists so the adapter that **composes the
 * insert body** runs as shipped, and it throws on any table other than `conversations` so a caller
 * that reached for a different one fails loudly rather than silently reading nothing.
 */
function conversationsTable(): ConversationsTable {
  const rows: ConversationRow[] = [];
  const inserts: TablesInsert<'conversations'>[] = [];
  let minted = 0;

  const resolvePlan = (plan: ReadPlan): readonly ConversationRow[] => {
    const matched = rows.filter((row) =>
      plan.filters.every((filter) => columnOf(row, filter.column) === filter.value),
    );
    const ordered = [...matched].sort((left, right) => {
      for (const { column, ascending } of plan.orders) {
        const a = String(columnOf(left, column) ?? '');
        const b = String(columnOf(right, column) ?? '');
        if (a !== b) return (a < b ? -1 : 1) * (ascending ? 1 : -1);
      }
      return 0;
    });
    return plan.cap === null ? ordered : ordered.slice(0, plan.cap);
  };

  const selectChain = (plan: ReadPlan): SelectChain => {
    const chain: SelectChain = {
      eq(column, value) {
        plan.filters.push({ column, value });
        return chain;
      },
      order(column, options) {
        plan.orders.push({ column, ascending: options.ascending });
        return chain;
      },
      limit(count) {
        plan.cap = count;
        return chain;
      },
      maybeSingle: () => Promise.resolve({ data: resolvePlan(plan)[0] ?? null, error: null }),
    };
    return chain;
  };

  const client = {
    from(table: string) {
      if (table !== 'conversations') {
        throw new Error(`the conversations table was asked for "${table}"`);
      }
      return {
        select: () => selectChain({ filters: [], orders: [], cap: null }),
        insert(row: TablesInsert<'conversations'>) {
          inserts.push(row);
          minted += 1;
          const stored: ConversationRow = {
            id: uuidFor('c0a0d0e0', minted),
            user_id: row.user_id,
            channel: row.channel,
            title: row.title ?? null,
            // Increasing, so the find-or-create order is total and the read-back is meaningful.
            created_at: instantFor(minted),
            updated_at: instantFor(minted),
          };
          rows.push(stored);
          return {
            select: () => ({ single: () => Promise.resolve({ data: stored, error: null }) }),
          };
        },
      };
    },
  };

  return { rows, inserts, client: client as unknown as SupabaseClient<Database> };
}

function instantFor(serial: number): string {
  return `2026-09-16T00:${String(serial).padStart(2, '0')}:00.000Z`;
}

/* ========================================================================== */
/* The unreachable request client                                              */
/* ========================================================================== */

/**
 * A tripwire, not a stand-in: every seam is injected, so a read of the request client means the
 * service reached past its dependencies and nothing recorded below can be trusted.
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

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

/** How the chat answer was produced. All three persist a farmer message and a Jamee answer. */
const CHAT_BRANCHES = [
  /** The model answered and its prose was kept. */
  'grounded',
  /** Nothing was in scope, so the answer is the repository's own copy and no model was called. */
  'referral',
  /** The chain was exhausted, so the answer is the knowledge row's own template. */
  'degraded',
] as const;
type ChatBranch = (typeof CHAT_BRANCHES)[number];

/** Which of Requirement 6.4's two diagnosis shapes the row carries. */
const DIAGNOSIS_OUTCOMES = ['identified', 'inconclusive'] as const;
type DiagnosisOutcomeKind = (typeof DIAGNOSIS_OUTCOMES)[number];

/** Where the conversation the row references came from. Both must occur — see the header. */
const CONVERSATION_ROUTES = ['created_inside_the_service', 'supplied_by_the_caller'] as const;
type ConversationRoute = (typeof CONVERSATION_ROUTES)[number];

interface Scenario {
  readonly inputKind: InputKind;
  readonly channel: Channel;
  readonly language: Language;
  readonly userId: string;
  readonly objectId: string;
  readonly condition: VerifiedCondition;
  readonly chatBranch: ChatBranch;
  readonly diagnosisOutcome: DiagnosisOutcomeKind;
  /** Only read on the image kind: whether the request carries a conversation identifier. */
  readonly suppliesConversation: boolean;
  readonly questionIndex: number;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  inputKind: fc.constantFrom<InputKind>(...INPUT_KINDS),
  channel: fc.constantFrom<Channel>(...CHANNELS),
  language: fc.constantFrom<Language>(...SUPPORTED_LANGUAGES),
  userId: fc.uuid(),
  objectId: fc.uuid(),
  condition: fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS),
  chatBranch: fc.constantFrom<ChatBranch>(...CHAT_BRANCHES),
  diagnosisOutcome: fc.constantFrom<DiagnosisOutcomeKind>(...DIAGNOSIS_OUTCOMES),
  suppliesConversation: fc.boolean(),
  questionIndex: fc.integer({ min: 0, max: 2 }),
});

function questionFor(scenario: Scenario): string {
  const pool =
    scenario.chatBranch === 'referral' ? OUT_OF_SCOPE_QUESTIONS : FOLLOW_UP_QUESTIONS;
  return pool[scenario.questionIndex % pool.length] ?? 'why?';
}

/* ========================================================================== */
/* The chat harness                                                            */
/* ========================================================================== */

interface ChatRecorded {
  /** Every `messages` row handed to the write seam, in insert order. */
  readonly messageRows: TablesInsert<'messages'>[];
  readonly usageRows: TablesInsert<'usage_logs'>[];
  readonly touches: { readonly conversationId: string; readonly userId: string }[];
  readonly ownershipChecks: { readonly conversationId: string; readonly userId: string }[];
  /** How many multi-row inserts were issued. Requirement 7.4 wants exactly one. */
  counts: { turns: number; generate: number; classify: number };
}

interface ChatHarness {
  readonly deps: ChatTurnDeps;
  readonly recorded: ChatRecorded;
}

function chatHarness(options: {
  readonly table: ConversationsTable;
  readonly branch: ChatBranch;
  readonly condition: VerifiedCondition;
  readonly conversationId: string;
  readonly userId: string;
}): ChatHarness {
  const recorded: ChatRecorded = {
    messageRows: [],
    usageRows: [],
    touches: [],
    ownershipChecks: [],
    counts: { turns: 0, generate: 0, classify: 0 },
  };

  const scope = { conversationId: options.conversationId, userId: options.userId };

  /**
   * The window this turn is answered from. Empty of messages and carrying a diagnosis only when the
   * branch needs a subject: a referral must resolve to nothing, so its context holds no condition.
   */
  const store: ContextStore = {
    recentMessages: () => Promise.resolve([]),
    latestDiagnosis: () =>
      Promise.resolve(
        options.branch === 'referral' ? null : diagnosisRowFor(scope, options.condition),
      ),
  };

  const knowledge: KnowledgeReader = (names) =>
    Promise.resolve(KNOWLEDGE_ROWS.filter((row) => names.includes(row.disease_name)));

  const models: CapabilityRunner = {
    classify: () => {
      recorded.counts.classify += 1;
      // A chat turn classifies nothing. Reaching this is a defect, not a fixture gap.
      return Promise.reject(new Error('a chat turn asked the vision capability for a judgement'));
    },
    generate: () => {
      recorded.counts.generate += 1;
      if (options.branch === 'degraded') {
        return Promise.reject(
          new AppError('PROVIDERS_UNAVAILABLE', { context: { reason: 'test_chain_exhausted' } }),
        );
      }
      const entry = entryFor(options.condition);
      return Promise.resolve({
        value: `${entry.disease_name}. ${entry.symptoms[0] ?? ''}`,
        provider: 'gemini' as const,
        usedFallback: false,
      });
    },
  };

  const writes: ChatWriteStore = {
    insertTurn: (rows) => {
      recorded.counts.turns += 1;
      recorded.messageRows.push(...rows);
      const stored: MessageRow[] = rows.map((row, index) => ({
        id: uuidFor('9e55a9e0', recorded.messageRows.length - rows.length + index + 1),
        conversation_id: row.conversation_id,
        user_id: row.user_id,
        role: row.role,
        content: row.content,
        language: row.language,
        channel: row.channel,
        input_kind: row.input_kind ?? 'text',
        transcript_of: row.transcript_of ?? null,
        created_at: '2026-09-16T01:31:00.000Z',
      }));
      return Promise.resolve(stored);
    },
    insertUsageLog: (row) => {
      recorded.usageRows.push(row);
      return Promise.resolve();
    },
    ownsConversation: (conversationId, userId) => {
      recorded.ownershipChecks.push({ conversationId, userId });
      return Promise.resolve(
        options.table.rows.some((row) => row.id === conversationId && row.user_id === userId),
      );
    },
    touchConversation: (conversationId, userId) => {
      recorded.touches.push({ conversationId, userId });
      return Promise.resolve(true);
    },
  };

  return {
    recorded,
    deps: {
      supabase: unreachableSupabase,
      writes,
      store,
      knowledge,
      models,
      quota: { rpc: countingRpc(), now: new Date(NOW_MS) },
      now: () => NOW_MS,
      platformDeadline: () => undefined,
    },
  };
}

/** A diagnosis in this conversation, so a subject-less follow-up has a subject to resolve to. */
function diagnosisRowFor(
  scope: { readonly conversationId: string; readonly userId: string },
  condition: VerifiedCondition,
): DiagnosisRow {
  return {
    id: uuidFor('d1a90515', 1),
    user_id: scope.userId,
    conversation_id: scope.conversationId,
    status: 'identified',
    disease_name: condition,
    knowledge_id: entryFor(condition).id,
    confidence: 0.87,
    severity: condition === HEALTHY_CONDITION ? 'none' : 'moderate',
    explanation: `${condition} explanation`,
    language: 'en',
    needs_expert: false,
    channel: 'web',
    image_bucket: CROP_IMAGES,
    image_path: `${scope.userId}/2026/09/${uuidFor('0b1ec700', 1)}.jpg`,
    full_image_deleted_at: null,
    model_provider: 'gemini',
    created_at: '2026-09-16T00:30:00.000Z',
  };
}

/** The counter, always allowing. What a quota costs is Property 20's claim, not this one's. */
function countingRpc(): CounterRpc {
  return {
    tryIncrement: () => Promise.resolve(1),
    decrement: () => Promise.resolve(0),
    used: () => Promise.resolve(0),
  };
}

/* ========================================================================== */
/* The diagnosis harness                                                       */
/* ========================================================================== */

interface DiagnosisRecorded {
  readonly diagnosisRows: TablesInsert<'diagnoses'>[];
  readonly usageRows: TablesInsert<'usage_logs'>[];
  readonly ownershipChecks: { readonly conversationId: string; readonly userId: string }[];
}

interface DiagnosisHarness {
  readonly deps: DiagnosisDeps;
  readonly recorded: DiagnosisRecorded;
}

function diagnosisHarness(options: {
  readonly table: ConversationsTable;
  readonly outcome: DiagnosisOutcomeKind;
  readonly condition: VerifiedCondition;
}): DiagnosisHarness {
  const recorded: DiagnosisRecorded = {
    diagnosisRows: [],
    usageRows: [],
    ownershipChecks: [],
  };

  const storage: StorageClientLike = {
    storage: {
      from: () => ({
        exists: () => Promise.resolve({ data: true, error: null }),
        createSignedUrl: (path: string) =>
          Promise.resolve({
            data: { signedUrl: `https://storage.test/${path}?token=abc` },
            error: null,
          }),
      }),
    },
  };

  const models: CapabilityRunner = {
    classify: () =>
      Promise.resolve({
        value: JSON.stringify(
          options.outcome === 'identified'
            ? {
                status: 'identified',
                disease_name: options.condition,
                confidence: 0.8231,
                severity: options.condition === HEALTHY_CONDITION ? 'none' : 'moderate',
              }
            : // Requirement 6.2 — the model reporting honestly, which is the shortest honest route
              // to Requirement 6.4's other shape and issues no rephrase call.
              { status: 'unclear', disease_name: null, confidence: 0, severity: 'none' },
        ),
        provider: 'gemini' as const,
        usedFallback: false,
      }),
    generate: () => {
      const entry = entryFor(options.condition);
      return Promise.resolve({
        value: `${entry.disease_name}. ${entry.symptoms[0] ?? ''}`,
        provider: 'gemini' as const,
        usedFallback: false,
      });
    },
  };

  const store: DiagnosisStore = {
    insertDiagnosis: (row) => {
      recorded.diagnosisRows.push(row);
      const stored: DiagnosisRow = {
        id: uuidFor('d1a90515', recorded.diagnosisRows.length),
        user_id: row.user_id,
        conversation_id: row.conversation_id,
        status: row.status,
        disease_name: row.disease_name ?? null,
        knowledge_id: row.knowledge_id ?? null,
        confidence: row.confidence ?? null,
        severity: row.severity,
        explanation: row.explanation,
        language: row.language,
        needs_expert: row.needs_expert ?? false,
        channel: row.channel,
        image_bucket: row.image_bucket,
        image_path: row.image_path,
        full_image_deleted_at: null,
        model_provider: row.model_provider,
        created_at: '2026-09-16T01:31:00.000Z',
      };
      return Promise.resolve(stored);
    },
    insertUsageLog: (row) => {
      recorded.usageRows.push(row);
      return Promise.resolve();
    },
    ownsConversation: (conversationId, userId) => {
      recorded.ownershipChecks.push({ conversationId, userId });
      return Promise.resolve(
        options.table.rows.some((row) => row.id === conversationId && row.user_id === userId),
      );
    },
  };

  const knowledge: KnowledgeReader = (names) =>
    Promise.resolve(KNOWLEDGE_ROWS.filter((row) => names.includes(row.disease_name)));

  return {
    recorded,
    deps: {
      supabase: unreachableSupabase,
      storage,
      store,
      // The REAL adapter over the in-memory table — see the header for why this one is not a seam.
      conversations: conversationStoreFrom(options.table.client),
      knowledge,
      models,
      quota: { rpc: countingRpc(), now: new Date(NOW_MS) },
      now: () => NOW_MS,
      platformDeadline: () => undefined,
    },
  };
}

/* ========================================================================== */
/* Readers over the recorded rows                                              */
/* ========================================================================== */

/** Every recorded row that carries a `channel`, whichever table it belongs to. */
interface ChannelledRow {
  readonly table: string;
  readonly channel: Channel;
}

function channelledRowsOf(rows: {
  readonly conversations: readonly TablesInsert<'conversations'>[];
  readonly messages?: readonly TablesInsert<'messages'>[] | undefined;
  readonly diagnoses?: readonly TablesInsert<'diagnoses'>[] | undefined;
  readonly usageLogs: readonly TablesInsert<'usage_logs'>[];
}): readonly ChannelledRow[] {
  return [
    ...rows.conversations.map((row) => ({ table: 'conversations', channel: row.channel })),
    ...(rows.messages ?? []).map((row) => ({ table: 'messages', channel: row.channel })),
    ...(rows.diagnoses ?? []).map((row) => ({ table: 'diagnoses', channel: row.channel })),
    ...rows.usageLogs.map((row) => ({ table: 'usage_logs', channel: row.channel })),
  ];
}

function roleOf(
  rows: readonly TablesInsert<'messages'>[],
  role: 'farmer' | 'jamee',
): TablesInsert<'messages'> {
  const matched = rows.filter((row) => row.role === role);
  if (matched.length !== 1) {
    throw new Error(`expected exactly one ${role} row, got ${matched.length}`);
  }
  const [only] = matched;
  if (only === undefined) throw new Error(`no ${role} row`);
  return only;
}

/* ========================================================================== */
/* Property 17                                                                 */
/* ========================================================================== */

describe('Property 17: conversation and message persistence round-trips, carrying the channel', () => {
  it('writes one farmer message and one answer per exchange, creates a conversation for a diagnosis that names none, and stamps the supplied channel on every row', async () => {
    const channelsSeen = new Set<Channel>();
    const inputKindsSeen = new Set<InputKind>();
    const languagesSeen = new Set<Language>();
    const chatBranchesSeen = new Set<ChatBranch>();
    const diagnosisOutcomesSeen = new Set<DiagnosisOutcomeKind>();
    const conversationRoutesSeen = new Set<ConversationRoute>();
    /** Which tables the run actually observed a channel on. */
    const tablesSeen = new Set<string>();

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { channel, language, userId, inputKind } = scenario;

        channelsSeen.add(channel);
        inputKindsSeen.add(inputKind);
        languagesSeen.add(language);

        const table = conversationsTable();
        const label = `${inputKind} / ${channel} / ${language}`;

        /* ================================================================== */
        /* The image kind — Requirements 7.5, 3.3, 16.5                        */
        /* ================================================================== */

        if (inputKind === 'image') {
          diagnosisOutcomesSeen.add(scenario.diagnosisOutcome);

          // The supplied case needs a thread to supply. It is created through the shared
          // find-or-create, which is the only conversation-creating path Jamee has.
          const existing = scenario.suppliesConversation
            ? await findOrCreateActive(userId, channel, conversationStoreFrom(table.client))
            : null;

          const insertsBefore = table.inserts.length;
          const test = diagnosisHarness({
            table,
            outcome: scenario.diagnosisOutcome,
            condition: scenario.condition,
          });

          const outcome = await diagnose(
            {
              userId,
              storageRef: {
                bucket: CROP_IMAGES,
                path: `${userId}/2026/09/${scenario.objectId}.jpg`,
              },
              language,
              channel,
              ...(existing === null ? {} : { conversationId: existing.id }),
            },
            test.deps,
          );

          const createdByService = table.inserts.slice(insertsBefore);
          const persisted = test.recorded.diagnosisRows[0];
          if (persisted === undefined) throw new Error('no diagnosis row was persisted');
          expect(test.recorded.diagnosisRows, label).toHaveLength(1);

          if (existing === null) {
            conversationRoutesSeen.add('created_inside_the_service');

            /* Requirement 7.5, first half: a conversation was created. Exactly one, so a
               request with no identifier does not leave spare threads behind. */
            expect(createdByService, `${label}: the service created no conversation`).toHaveLength(
              1,
            );
            const created = table.rows[table.rows.length - 1];
            if (created === undefined) throw new Error('the created conversation is not readable');

            /* Requirement 7.5, second half: the diagnosis references it — read off the row. */
            expect(persisted.conversation_id, label).toBe(created.id);
            /* And the created conversation is this farmer's, on this channel. */
            expect(created.user_id, label).toBe(userId);
            expect(created.channel, label).toBe(channel);

            /* No id was supplied, so there was nothing to authorize. */
            expect(test.recorded.ownershipChecks, label).toStrictEqual([]);
          } else {
            conversationRoutesSeen.add('supplied_by_the_caller');

            /* The complement. A service that minted a spare conversation per request would
               satisfy the branch above and be wrong here. */
            expect(
              createdByService,
              `${label}: a supplied conversation still produced an insert`,
            ).toStrictEqual([]);
            expect(persisted.conversation_id, label).toBe(existing.id);
            expect(existing.channel, label).toBe(channel);

            /* A client-supplied id is authorized before it is written to. */
            expect(test.recorded.ownershipChecks, label).toStrictEqual([
              { conversationId: existing.id, userId },
            ]);
          }

          /* Requirement 3.3's column set, on the row rather than in the return value. */
          expect(persisted.user_id, label).toBe(userId);
          expect(persisted.image_bucket, label).toBe(CROP_IMAGES);
          expect(persisted.image_path, label).toBe(`${userId}/2026/09/${scenario.objectId}.jpg`);
          expect(persisted.language, label).toBe(language);

          /* Requirement 16.5 — every row this operation persisted carries the channel it was
             given, whichever table it landed in. */
          const rows = channelledRowsOf({
            conversations: table.inserts,
            diagnoses: test.recorded.diagnosisRows,
            usageLogs: test.recorded.usageRows,
          });
          expect(rows.length, `${label}: nothing was persisted`).toBeGreaterThan(0);
          for (const row of rows) {
            tablesSeen.add(row.table);
            expect(row.channel, `${label}: ${row.table} recorded the wrong channel`).toBe(channel);
          }

          /* The bridge: the identifiers the caller receives are the row's own. */
          expect(outcome.conversationId, label).toBe(persisted.conversation_id);
          expect(outcome.result.language, label).toBe(language);
          return;
        }

        /* ================================================================== */
        /* The text and voice kinds — Requirements 7.4, 16.5                   */
        /* ================================================================== */

        chatBranchesSeen.add(scenario.chatBranch);
        conversationRoutesSeen.add('supplied_by_the_caller');

        // `ChatInput.conversationId` is required (Requirement 7.2), so the thread is resolved
        // first — through the same shared find-or-create both channels use.
        const conversation = await findOrCreateActive(
          userId,
          channel,
          conversationStoreFrom(table.client),
        );
        expect(conversation.channel, `${label}: find-or-create ignored the channel`).toBe(channel);
        expect(table.inserts, label).toHaveLength(1);

        const message = questionFor(scenario);
        const recordingPath = `${userId}/2026/09/${scenario.objectId}.webm`;

        const test = chatHarness({
          table,
          branch: scenario.chatBranch,
          condition: scenario.condition,
          conversationId: conversation.id,
          userId,
        });

        /**
         * The voice kind is composed exactly as `voice.service.ts` composes it: the boolean AND a
         * real reservation. A `skipQuotaReserve: true` with no coverage is a wiring defect that
         * `quotaContextFor()` throws on, so the coverage here is taken rather than asserted.
         */
        let coverage: QuotaContext | undefined;
        if (inputKind === 'voice') {
          const reserved = await reserveForRequest(ownsRequest(userId, 'voice'), {
            rpc: countingRpc(),
            now: new Date(NOW_MS),
          });
          if (reserved.outcome !== 'allowed') throw new Error('the voice reserve was declined');
          coverage = coveredBy(reserved.reservation);
        }

        const input: ChatInput = {
          userId,
          conversationId: conversation.id,
          message,
          language,
          channel,
          inputKind,
          ...(inputKind === 'voice'
            ? { skipQuotaReserve: true, transcriptOf: recordingPath }
            : {}),
        };

        const result = await chatTurn(input, test.deps, coverage);

        /* ---------------------------------------------------------------- */
        /* Requirement 7.4 — exactly one farmer message and one answer      */
        /* ---------------------------------------------------------------- */

        /* One statement, two rows. Two inserts could half-commit and leave a question with no
           answer under it, which is why the count of inserts is asserted and not only the rows. */
        expect(test.recorded.counts.turns, label).toBe(1);
        expect(test.recorded.messageRows, label).toHaveLength(2);

        const farmer = roleOf(test.recorded.messageRows, 'farmer');
        const jamee = roleOf(test.recorded.messageRows, 'jamee');

        /* The farmer's own words, verbatim, and Jamee's answer beside them. */
        expect(farmer.content, label).toBe(message);
        expect(jamee.content, label).toBe(result.answer.content);
        expect(jamee.content.length, label).toBeGreaterThan(0);

        /* "In the same conversation" — both rows, both columns. */
        expect(farmer.conversation_id, label).toBe(conversation.id);
        expect(jamee.conversation_id, label).toBe(conversation.id);
        expect(farmer.user_id, label).toBe(userId);
        expect(jamee.user_id, label).toBe(userId);

        /* What arrived, and what Jamee sent back. Requirement 8.8 rules out synthesized speech,
           so a Jamee row is text on every channel and for every kind of question. */
        expect(farmer.input_kind, label).toBe(inputKind);
        expect(jamee.input_kind, label).toBe('text');

        if (inputKind === 'voice') {
          /* Requirement 8.9's provenance, on the row that carries the transcript and on no other. */
          expect(farmer.transcript_of, label).toBe(recordingPath);
          expect(jamee.transcript_of, label).toBeUndefined();
        } else {
          expect(farmer.transcript_of, label).toBeUndefined();
          expect(jamee.transcript_of, label).toBeUndefined();
        }

        /* The conversation the pair landed in was authorized before either row was composed, and
           its activity was bumped afterwards — the ordering `conversation.service.ts` depends on. */
        expect(test.recorded.ownershipChecks, label).toStrictEqual([
          { conversationId: conversation.id, userId },
        ]);
        expect(test.recorded.touches, label).toStrictEqual([
          { conversationId: conversation.id, userId },
        ]);

        /* Which branch produced the answer, read off the model counter rather than assumed — so a
           run that meant to exercise the referral cannot silently have called a provider. */
        expect(test.recorded.counts.classify, label).toBe(0);
        expect(test.recorded.counts.generate, label).toBe(
          scenario.chatBranch === 'referral' ? 0 : 1,
        );

        /* ---------------------------------------------------------------- */
        /* Requirement 16.5 — the channel, on every row                     */
        /* ---------------------------------------------------------------- */

        const rows = channelledRowsOf({
          conversations: table.inserts,
          messages: test.recorded.messageRows,
          usageLogs: test.recorded.usageRows,
        });
        expect(rows.length, `${label}: nothing was persisted`).toBeGreaterThan(0);
        for (const row of rows) {
          tablesSeen.add(row.table);
          expect(row.channel, `${label}: ${row.table} recorded the wrong channel`).toBe(channel);
        }

        /* The bridge: the ids the caller receives are the ids of the rows that were written. */
        expect(result.conversationId, label).toBe(conversation.id);
        expect(result.farmerMessageId, label).not.toBe(result.answer.messageId);
      }),
      // 320 runs over three input kinds, two channels, three languages and the per-kind branches,
      // so every cell of the grid is reached many times over rather than probably.
      { numRuns: 320 },
    );

    /* ---------------------------------------------------------------------- */
    /* Non-vacuity: the generators actually produced every class               */
    /* ---------------------------------------------------------------------- */

    expect([...channelsSeen].sort()).toStrictEqual([...CHANNELS].sort());
    expect([...inputKindsSeen].sort()).toStrictEqual([...INPUT_KINDS].sort());
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
    expect([...chatBranchesSeen].sort()).toStrictEqual([...CHAT_BRANCHES].sort());
    expect([...diagnosisOutcomesSeen].sort()).toStrictEqual([...DIAGNOSIS_OUTCOMES].sort());
    // Both halves of clause 2 ran: a conversation created by the service, and one supplied to it.
    expect([...conversationRoutesSeen].sort()).toStrictEqual([...CONVERSATION_ROUTES].sort());
    // And the channel claim was decided on all four tables that carry the column, rather than on
    // whichever one a lucky generation happened to write.
    expect([...tablesSeen].sort()).toStrictEqual([
      'conversations',
      'diagnoses',
      'messages',
      'usage_logs',
    ]);
  });
});
