import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner } from '@/lib/ai/capabilities';
import { DAILY_QUOTAS, STORAGE_BUCKETS } from '@/lib/config/verified';
import { isAppError, toEnvelope, type AppError } from '@/lib/errors';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import {
  HEALTHY_CONDITION,
  VERIFIED_CONDITIONS,
  type Channel,
  type ChatInput,
  type Language,
  type Operation,
  type StorageRef,
  type VerifiedCondition,
} from '@/lib/schemas';
import type { StorageClientLike } from '@/lib/storage';
import { dayWindowKey, nextResetAtIso } from '@/lib/time';
import {
  chatTurn,
  type ChatTurnDeps,
  type ChatWriteStore,
  type ContextStore,
} from '@/services/chat.service';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import { diagnose, type DiagnosisDeps, type DiagnosisStore } from '@/services/diagnosis.service';
import { reserveForRequest, type CounterRpc, type QuotaContext } from '@/services/quota.service';
import {
  transcribeAndAnswer,
  type ChatAnswerer,
  type NestedChatOutcome,
  type ObjectRemoveClient,
  type Transcriber,
  type VoiceDeps,
  type VoiceStore,
} from '@/services/voice.service';
import type { TranscriptionResult } from '@/lib/groq';
import type { Database, DiagnosisRow, MessageRow, TablesInsert } from '@/types/database';

/**
 * **Property 20: Daily quotas are never exceeded and are shared across channels**
 *
 * > For any interleaving of web and WhatsApp requests of one operation type by one farmer within one
 * > Asia/Kolkata day, including concurrent requests, the number of requests that reach a provider
 * > never exceeds that operation's daily limit; every request beyond the limit is declined with the
 * > limit and the reset time stated and invokes no provider; and the accepted count is identical
 * > regardless of how the requests were distributed between channels.
 *
 * **Validates: Requirements 14.1, 14.2, 14.3**
 *
 * ### Where the property is observed
 *
 * Through the **three real services**, which are the only things in Jamee that spend a unit:
 * `diagnose()`, `chatTurn()` and `transcribeAndAnswer()`, each reaching the **real**
 * `reserveForRequest()` in `src/services/quota.service.ts`. Nothing about the reserve, the decline,
 * the window key or the reset instant is re-described here.
 *
 * The one thing that cannot be real off a database is `counter_try_increment`, so it is modelled
 * with the property migration `0007` gives it: the row is read and written **with no `await` between
 * them**, which is the atomicity a single UPDATE has in Postgres, and the increment is refused at
 * the ceiling. That the real statement is atomic is not this file's claim to make —
 * `quota.service.test.ts` pins the seam's contract and task 10.2 owns it against a real Postgres.
 *
 * ### "Shared across channels" is asserted as a mechanism, not just as a count
 *
 * The counter key is `(user_id, operation, window_kind, window_key)` and has **no channel
 * component** — that absence *is* Requirement 14.2. So the in-memory table is keyed the same way
 * and every run asserts that a mixed-channel burst touched **exactly one row**. A channel that
 * quietly got its own allowance would show up as two rows long before the accepted count drifted,
 * and the assertion names the row rather than inferring it.
 *
 * The count claim is then made the way the design words it: the same multiset of requests is run
 * twice, once as generated and once with **every channel mirrored** (`web`↔`whatsapp`), against two
 * fresh counters, and the accepted totals must be equal. Mirroring is what makes the uniform cases
 * meet: an all-web run's mirror is an all-WhatsApp run, so "20 photos from the browser" and "20
 * photos from WhatsApp" are compared directly, and a mixed run is compared against its own
 * complement.
 *
 * ### "Never exceeds" and "invokes no provider" are counted, per request
 *
 * Every provider call is counted **per request**, not in aggregate, so the ordering claim is exact:
 * an accepted request must make its operation's full number of gateway calls (two for a diagnosis —
 * the classification and the rephrase — one for a chat answer, one for a transcription) and a
 * declined request must make **zero**. An aggregate total could be satisfied by an accepted request
 * that called nothing while a declined one called twice.
 *
 * The counter is watched in all three directions: increments, decrements, and the maximum `used` any
 * row ever held. `decrements` is asserted **zero** across the run, which is what stops a refund from
 * quietly buying the burst extra accepted requests — the failure mode that would make an
 * accepted-count assertion pass while the daily limit was in fact exceeded.
 *
 * ### The nesting rule rides along on the voice runs
 *
 * A voice request's nested chat answer is `covered`, so it must reserve nothing. The chat seam this
 * file injects hands its coverage to the same real `reserveForRequest()` the services use, against
 * the same counter — so a voice run that spent a chat unit would create a second counter row, and
 * the one-row assertion fails. One voice message never costs both a voice and a chat unit, and that
 * is observed rather than assumed.
 *
 * ### Non-vacuity
 *
 * Four coverage sets, all asserted after `fc.assert`: every operation, every distribution shape
 * (all-web, all-WhatsApp, alternating, mixed, WhatsApp-first), both execution orders (sequential and
 * **concurrent**, with every request in flight at once), and every generated clock instant inside the
 * Asia/Kolkata day. And the run is asserted to have produced **both** answers — at least one
 * accepted request and at least one decline — so a harness that refused or admitted everything
 * cannot pass.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const USER_ID = '2b4d6f8a-1c3e-4a5b-8d7f-9e0a1b2c3d4e';
const CONVERSATION_ID = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b';
const DIAGNOSIS_ID = 'f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b';
const FARMER_MESSAGE_ID = 'a9b8c7d6-e5f4-4321-8a1b-2c3d4e5f6071';
const ANSWER_MESSAGE_ID = 'b8c7d6e5-f4a3-4210-8b2c-3d4e5f607182';

const CONDITION: VerifiedCondition = 'Tomato Early Blight';

/**
 * Three instants inside **one** Asia/Kolkata day (2026-09-16 IST), including both ends of it.
 *
 * 18:30 UTC is IST midnight, so `2026-09-15T18:31Z` is 00:01 IST and `2026-09-16T18:29Z` is 23:59
 * IST — the same `dayWindowKey`, and the same `nextResetAtIso`. Generating across them means the
 * decline's reset instant is asserted against a value that varies with the clock rather than
 * against one fixed string.
 */
const CLOCKS = [
  '2026-09-15T18:31:00.000Z',
  '2026-09-16T06:00:00.000Z',
  '2026-09-16T18:29:00.000Z',
] as const;

const CROP_OF: Readonly<Record<VerifiedCondition, KnowledgeEntry['crop']>> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

const KNOWLEDGE_ROWS: readonly KnowledgeEntry[] = VERIFIED_CONDITIONS.map((condition, index) => {
  const healthy = condition === HEALTHY_CONDITION;
  return {
    id: `20b0abcd-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    disease_name: condition,
    crop: CROP_OF[condition],
    scientific_name: healthy ? null : `${condition} pathogen`,
    symptoms: [`${condition} symptom line`],
    causes: [`${condition} cause line`],
    treatment: healthy ? [] : [`${condition} treatment line`],
    prevention: [`${condition} prevention line`],
    default_severity: healthy ? 'none' : 'moderate',
    source: `${condition} extension bulletin`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
});

const CLASSIFICATION = JSON.stringify({
  status: 'identified',
  disease_name: CONDITION,
  confidence: 0.86,
  severity: 'moderate',
});

/**
 * How many gateway calls one accepted request of each operation makes.
 *
 * Two for a diagnosis: `vision-classify` and the rephrase, which are both the `image` operation
 * (`usage-log.ts` — one row, one operation). One each for a chat answer and a transcription.
 */
const PROVIDER_CALLS_PER_ACCEPTED: Readonly<Record<Operation, number>> = {
  image: 2,
  chat: 1,
  voice: 1,
};

/* ========================================================================== */
/* The counter — one in-memory `counters` table, keyed as migration 0007 keys it */
/* ========================================================================== */

interface CounterState {
  /** `user::operation::window_kind::window_key` → `used`. **No channel component.** */
  readonly rows: Map<string, number>;
  increments: number;
  decrements: number;
  reads: number;
  /** The highest `used` any row ever held, so "never exceeds" is a watermark and not a final read. */
  maxUsed: number;
}

function counterState(): CounterState {
  return { rows: new Map<string, number>(), increments: 0, decrements: 0, reads: 0, maxUsed: 0 };
}

/**
 * `counter_try_increment`, `counter_decrement` and `counter_used` as one in-memory row set.
 *
 * The read and the write in `tryIncrement` are separated by **no `await`**, which is what makes a
 * concurrent burst behave the way a single atomic UPDATE does: two overlapping requests cannot both
 * observe the same `used` and both write `used + 1`.
 */
function sharedCounter(state: CounterState): CounterRpc {
  const key = (args: {
    userId: string;
    operation: Operation;
    windowKind: string;
    windowKey: string;
  }): string => `${args.userId}::${args.operation}::${args.windowKind}::${args.windowKey}`;

  return {
    async tryIncrement(args) {
      state.increments += 1;
      const at = key(args);
      const used = state.rows.get(at) ?? 0;
      if (used >= args.limit) return null;
      const next = used + 1;
      state.rows.set(at, next);
      state.maxUsed = Math.max(state.maxUsed, next);
      return next;
    },
    async decrement(args) {
      state.decrements += 1;
      const at = key(args);
      const used = state.rows.get(at) ?? 0;
      if (used === 0) return null;
      state.rows.set(at, used - 1);
      return used - 1;
    },
    async used(args) {
      state.reads += 1;
      return state.rows.get(key(args)) ?? 0;
    },
  };
}

/* ========================================================================== */
/* One request's recorder                                                      */
/* ========================================================================== */

interface RequestRecord {
  /** Gateway calls this request made. Asserted per request, which is what makes zero mean zero. */
  providerCalls: number;
  readonly usageRows: TablesInsert<'usage_logs'>[];
  /** The coverage a nested chat call was handed, if one happened. */
  readonly nestedCoverage: QuotaContext['role'][];
}

function requestRecord(): RequestRecord {
  return { providerCalls: 0, usageRows: [], nestedCoverage: [] };
}

/** A tripwire, not a stand-in: every seam is injected, so a read here means one was missed. */
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

function conversationFor(userId: string, channel: Conversation['channel']): Conversation {
  return {
    id: CONVERSATION_ID,
    user_id: userId,
    channel,
    title: null,
    created_at: '2026-09-16T00:05:00.000Z',
    updated_at: '2026-09-16T00:05:00.000Z',
  };
}

const knowledge: KnowledgeReader = (names) =>
  Promise.resolve(KNOWLEDGE_ROWS.filter((row) => names.includes(row.disease_name)));

function storageStub(): StorageClientLike & ObjectRemoveClient {
  return {
    storage: {
      from: () => ({
        exists: () => Promise.resolve({ data: true, error: null }),
        createSignedUrl: (path: string) =>
          Promise.resolve({
            data: { signedUrl: `https://storage.test/${path}?token=synthetic` },
            error: null,
          }),
        remove: () => Promise.resolve({ data: [{ name: 'removed' }], error: null }),
      }),
    },
  };
}

function refFor(bucket: string): StorageRef {
  return { bucket: bucket as StorageRef['bucket'], path: `${USER_ID}/2026/09/${randomUUID()}.jpg` };
}

/* -------------------------------------------------------------------------- */
/* image                                                                       */
/* -------------------------------------------------------------------------- */

function diagnosisDeps(rpc: CounterRpc, record: RequestRecord, clockMs: number): DiagnosisDeps {
  const models: CapabilityRunner = {
    classify: () => {
      record.providerCalls += 1;
      return Promise.resolve({ value: CLASSIFICATION, provider: 'gemini', usedFallback: false });
    },
    generate: () => {
      record.providerCalls += 1;
      const entry = KNOWLEDGE_ROWS.find((row) => row.disease_name === CONDITION);
      return Promise.resolve({
        value: `${CONDITION}: ${entry?.symptoms[0] ?? ''}`,
        provider: 'gemini',
        usedFallback: false,
      });
    },
  };

  const store: DiagnosisStore = {
    insertDiagnosis: (row) => {
      const stored: DiagnosisRow = {
        id: DIAGNOSIS_ID,
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
        created_at: '2026-09-16T01:00:00.000Z',
      };
      return Promise.resolve(stored);
    },
    insertUsageLog: (row) => {
      record.usageRows.push(row);
      return Promise.resolve();
    },
    ownsConversation: () => Promise.resolve(true),
  };

  const conversations: ConversationStore = {
    mostRecent: (userId, channel) => Promise.resolve(conversationFor(userId, channel)),
    create: (userId, channel) => Promise.resolve(conversationFor(userId, channel)),
  };

  return {
    supabase: unreachableSupabase,
    storage: storageStub(),
    store,
    conversations,
    knowledge,
    models,
    quota: { rpc, now: new Date(clockMs) },
    now: () => clockMs,
    deadlineMs: clockMs + 45_000,
    platformDeadline: () => undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* chat                                                                        */
/* -------------------------------------------------------------------------- */

/** A question that names a verified condition, so the turn resolves a scope and calls the model. */
const CHAT_QUESTION = `what should I do about ${CONDITION}`;

function messageRowFor(row: TablesInsert<'messages'>, id: string): MessageRow {
  return {
    id,
    conversation_id: row.conversation_id,
    user_id: row.user_id,
    role: row.role,
    content: row.content,
    language: row.language,
    channel: row.channel,
    input_kind: row.input_kind ?? 'text',
    transcript_of: row.transcript_of ?? null,
    created_at: '2026-09-16T01:00:00.000Z',
  };
}

function chatDeps(rpc: CounterRpc, record: RequestRecord, clockMs: number): ChatTurnDeps {
  const models: CapabilityRunner = {
    classify: () => Promise.reject(new Error('a chat turn asked for a vision judgement')),
    generate: () => {
      record.providerCalls += 1;
      const entry = KNOWLEDGE_ROWS.find((row) => row.disease_name === CONDITION);
      return Promise.resolve({
        value: `${CONDITION}: ${entry?.treatment[0] ?? ''}`,
        provider: 'gemini',
        usedFallback: false,
      });
    },
  };

  const store: ContextStore = {
    recentMessages: () => Promise.resolve([]),
    latestDiagnosis: () => Promise.resolve(null),
  };

  const writes: ChatWriteStore = {
    insertTurn: (rows) =>
      Promise.resolve([
        messageRowFor(rows[0], FARMER_MESSAGE_ID),
        messageRowFor(rows[1], ANSWER_MESSAGE_ID),
      ]),
    insertUsageLog: (row) => {
      record.usageRows.push(row);
      return Promise.resolve();
    },
    ownsConversation: () => Promise.resolve(true),
    touchConversation: () => Promise.resolve(true),
  };

  return {
    supabase: unreachableSupabase,
    writes,
    store,
    knowledge,
    models,
    quota: { rpc, now: new Date(clockMs) },
    now: () => clockMs,
    platformDeadline: () => undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* voice                                                                       */
/* -------------------------------------------------------------------------- */

function voiceDeps(rpc: CounterRpc, record: RequestRecord, clockMs: number): VoiceDeps {
  const transcribe: Transcriber = () => {
    record.providerCalls += 1;
    const value: TranscriptionResult = {
      text: CHAT_QUESTION,
      language: 'en',
      durationSeconds: 6.5,
      signals: { avgLogprob: -0.2, compressionRatio: 1.4, noSpeechProb: 0.02 },
      segments: [],
    };
    return Promise.resolve({ value, provider: 'groq', usedFallback: false });
  };

  /**
   * The nested `ChatService`, standing in for the one thing the nesting rule turns on: it hands the
   * coverage it was given to the **same real** `reserveForRequest()` the services use, against the
   * **same counter**. So a `covered` context performs no RPC — and a broken one would create a
   * second counter row, which the one-row assertion catches.
   */
  const chat: ChatAnswerer = async (input: ChatInput, coverage: QuotaContext) => {
    record.nestedCoverage.push(coverage.role);
    const reserved = await reserveForRequest(coverage, { rpc, now: new Date(clockMs) });
    if (reserved.outcome !== 'allowed') {
      throw new Error('the nested chat call was declined; a covered context reserves nothing');
    }
    const outcome: NestedChatOutcome = {
      conversationId: input.conversationId,
      farmerMessageId: FARMER_MESSAGE_ID,
      answer: {
        messageId: ANSWER_MESSAGE_ID,
        content: `${CONDITION}: remove the affected leaves.`,
        language: input.language,
        groundedIn: [CONDITION],
        needsExpert: false,
      },
      quota: {
        operation: 'voice',
        used: reserved.reservation.used,
        limit: reserved.reservation.limit,
        resetsAt: reserved.reservation.resetsAt,
      },
    };
    return outcome;
  };

  const store: VoiceStore = {
    insertUsageLog: (row) => {
      record.usageRows.push(row);
      return Promise.resolve();
    },
  };

  const storage = storageStub();

  return {
    supabase: unreachableSupabase,
    chat,
    storage,
    deleter: storage,
    store,
    transcribe,
    quota: { rpc, now: new Date(clockMs) },
    now: () => clockMs,
    deadlineMs: clockMs + 45_000,
    platformDeadline: () => undefined,
  };
}

/* ========================================================================== */
/* One request                                                                 */
/* ========================================================================== */

type RequestOutcome =
  | { readonly kind: 'accepted'; readonly record: RequestRecord; readonly channel: Channel }
  | {
      readonly kind: 'declined';
      readonly error: AppError;
      readonly record: RequestRecord;
      readonly channel: Channel;
    };

async function runRequest(
  operation: Operation,
  channel: Channel,
  language: Language,
  rpc: CounterRpc,
  clockMs: number,
): Promise<RequestOutcome> {
  const record = requestRecord();

  try {
    if (operation === 'image') {
      await diagnose(
        {
          userId: USER_ID,
          storageRef: refFor(STORAGE_BUCKETS.cropImages),
          language,
          channel,
          conversationId: CONVERSATION_ID,
        },
        diagnosisDeps(rpc, record, clockMs),
      );
    } else if (operation === 'chat') {
      await chatTurn(
        {
          userId: USER_ID,
          conversationId: CONVERSATION_ID,
          message: CHAT_QUESTION,
          language,
          channel,
          inputKind: 'text',
        },
        chatDeps(rpc, record, clockMs),
      );
    } else {
      await transcribeAndAnswer(
        {
          userId: USER_ID,
          storageRef: refFor(STORAGE_BUCKETS.voiceMessages),
          language,
          channel,
          conversationId: CONVERSATION_ID,
          durationSeconds: 6.5,
          mimeType: 'audio/ogg',
          bytes: 90_000,
        },
        voiceDeps(rpc, record, clockMs),
      );
    }
    return { kind: 'accepted', record, channel };
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { kind: 'declined', error, record, channel };
  }
}

/* ========================================================================== */
/* One distribution                                                            */
/* ========================================================================== */

type ExecutionOrder = 'sequential' | 'concurrent';

interface Summary {
  readonly outcomes: readonly RequestOutcome[];
  readonly state: CounterState;
  readonly accepted: number;
  readonly declined: number;
  readonly acceptedWeb: number;
  readonly acceptedWhatsapp: number;
}

async function executeAll(
  operation: Operation,
  channels: readonly Channel[],
  language: Language,
  order: ExecutionOrder,
  clockMs: number,
): Promise<Summary> {
  const state = counterState();
  const rpc = sharedCounter(state);

  const outcomes =
    order === 'concurrent'
      ? // Every request in flight at once: the reserves interleave at the services' own awaits,
        // which is the ordering a sequential loop cannot produce.
        await Promise.all(
          channels.map((channel) => runRequest(operation, channel, language, rpc, clockMs)),
        )
      : await (async () => {
          const collected: RequestOutcome[] = [];
          for (const channel of channels) {
            collected.push(await runRequest(operation, channel, language, rpc, clockMs));
          }
          return collected;
        })();

  const accepted = outcomes.filter((outcome) => outcome.kind === 'accepted');

  return {
    outcomes,
    state,
    accepted: accepted.length,
    declined: outcomes.length - accepted.length,
    acceptedWeb: accepted.filter((outcome) => outcome.channel === 'web').length,
    acceptedWhatsapp: accepted.filter((outcome) => outcome.channel === 'whatsapp').length,
  };
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

/** How the requests are spread across the two channels. */
const DISTRIBUTIONS = [
  'all_web',
  'all_whatsapp',
  'alternating',
  'whatsapp_first_then_web',
  'mixed',
] as const;

type Distribution = (typeof DISTRIBUTIONS)[number];

const ORDERS: readonly ExecutionOrder[] = ['sequential', 'concurrent'];

interface Burst {
  readonly operation: Operation;
  readonly distribution: Distribution;
  readonly order: ExecutionOrder;
  readonly language: Language;
  readonly clockIso: (typeof CLOCKS)[number];
  /** How many requests past the limit the burst carries. At least one, so a decline always happens. */
  readonly beyond: number;
  /** Bits for the `mixed` distribution, so the interleaving is generated rather than patterned. */
  readonly bits: readonly boolean[];
}

const burstArb: fc.Arbitrary<Burst> = fc.record({
  operation: fc.constantFrom<Operation>('image', 'chat', 'voice'),
  distribution: fc.constantFrom<Distribution>(...DISTRIBUTIONS),
  order: fc.constantFrom<ExecutionOrder>(...ORDERS),
  language: fc.constantFrom<Language>('en', 'hi', 'mr'),
  clockIso: fc.constantFrom(...CLOCKS),
  beyond: fc.integer({ min: 1, max: 3 }),
  bits: fc.array(fc.boolean(), { minLength: 60, maxLength: 60 }),
});

function channelsFor(burst: Burst): readonly Channel[] {
  const total = DAILY_QUOTAS[burst.operation] + burst.beyond;

  return Array.from({ length: total }, (_unused, index): Channel => {
    switch (burst.distribution) {
      case 'all_web':
        return 'web';
      case 'all_whatsapp':
        return 'whatsapp';
      case 'alternating':
        return index % 2 === 0 ? 'web' : 'whatsapp';
      case 'whatsapp_first_then_web':
        return index < Math.floor(total / 2) ? 'whatsapp' : 'web';
      case 'mixed':
        return burst.bits[index % burst.bits.length] === true ? 'whatsapp' : 'web';
    }
  });
}

/** `web`↔`whatsapp`. The mirror of an all-web burst is an all-WhatsApp burst. */
function mirrored(channels: readonly Channel[]): readonly Channel[] {
  return channels.map((channel) => (channel === 'web' ? 'whatsapp' : 'web'));
}

/* ========================================================================== */
/* Property 20                                                                 */
/* ========================================================================== */

describe('Property 20: the daily quota is never exceeded, and both channels share it', () => {
  it('accepts exactly the limit across any channel distribution, declines the rest, and spends nothing on a decline', async () => {
    const operations = new Set<Operation>();
    const distributions = new Set<Distribution>();
    const orders = new Set<ExecutionOrder>();
    const clocks = new Set<string>();
    let acceptedSeen = 0;
    let declinedSeen = 0;

    await fc.assert(
      fc.asyncProperty(burstArb, async (burst) => {
        const { operation, language, order } = burst;
        const limit = DAILY_QUOTAS[operation];
        const channels = channelsFor(burst);
        const clockMs = Date.parse(burst.clockIso);
        const label = `${operation} / ${burst.distribution} / ${order} / ${burst.clockIso}`;

        operations.add(operation);
        distributions.add(burst.distribution);
        orders.add(order);
        clocks.add(burst.clockIso);

        const run = await executeAll(operation, channels, language, order, clockMs);
        acceptedSeen += run.accepted;
        declinedSeen += run.declined;

        /* ── Requirement 14.1 — the number that reached a provider never exceeds it ── */
        expect(run.accepted, `${label} accepted more than the limit`).toBe(limit);
        expect(run.declined, label).toBe(channels.length - limit);
        expect(run.state.maxUsed, `${label} let a counter row pass the limit`).toBeLessThanOrEqual(
          limit,
        );
        /** No refund bought an extra acceptance. */
        expect(run.state.decrements, `${label} refunded a unit`).toBe(0);

        /* ── Requirement 14.2 — ONE counter row, for both channels together ────── */
        const rowKey = `${USER_ID}::${operation}::day::${dayWindowKey(new Date(clockMs))}`;
        expect(
          [...run.state.rows.keys()],
          `${label} did not share one counter across the channels`,
        ).toStrictEqual([rowKey]);
        expect(run.state.rows.get(rowKey), label).toBe(limit);

        /* ── Per request: what an acceptance costs, and what a decline costs ───── */
        for (const outcome of run.outcomes) {
          if (outcome.kind === 'accepted') {
            expect(outcome.record.providerCalls, `${label} accepted without calling a provider`).toBe(
              PROVIDER_CALLS_PER_ACCEPTED[operation],
            );
            continue;
          }

          /** Requirement 14.3 — declined, and **no** provider was invoked. */
          expect(outcome.record.providerCalls, `${label} called a provider on a declined request`)
            .toBe(0);
          expect(outcome.error.code, label).toBe('QUOTA_EXCEEDED');
          expect(outcome.error.status, label).toBe(429);

          /** …with the limit and the reset time stated, in the farmer's own language. */
          const envelope = toEnvelope(outcome.error, language);
          expect(envelope.error.code, label).toBe('QUOTA_EXCEEDED');
          expect(envelope.error.details?.limit, label).toBe(limit);
          expect(envelope.error.details?.used, label).toBe(limit);
          expect(envelope.error.details?.resetsAt, label).toBe(nextResetAtIso(new Date(clockMs)));
          expect(envelope.error.message, label).toContain(String(limit));
          /** Every placeholder substituted: a template still holding `{resetsAt}` states nothing. */
          expect(envelope.error.message, label).not.toMatch(/\{(limit|operation|resetsAt|used)\}/);

          /** And the audit says the decline spent nothing (Requirements 14.3, 14.6). */
          expect(outcome.record.usageRows, label).toHaveLength(1);
          const row = outcome.record.usageRows[0] as TablesInsert<'usage_logs'>;
          expect(row.outcome, label).toBe('quota_declined');
          expect(row.quota_spent, label).toBe(false);
          expect(row.model_provider, label).toBe('none');
          expect(row.channel, label).toBe(outcome.channel);
        }

        /* ── The nesting rule, on the voice runs ──────────────────────────────── */
        if (operation === 'voice') {
          const nested = run.outcomes.flatMap((outcome) => outcome.record.nestedCoverage);
          expect(nested, label).toHaveLength(limit);
          expect(new Set(nested), `${label} let a nested chat call own its request`).toStrictEqual(
            new Set(['covered']),
          );
        }

        /* ── "Identical regardless of how the requests were distributed" ───────── */
        const mirror = await executeAll(operation, mirrored(channels), language, order, clockMs);
        expect(mirror.accepted, `${label} depends on which channel the requests came from`).toBe(
          run.accepted,
        );
        expect(mirror.declined, label).toBe(run.declined);
        expect(mirror.acceptedWeb + mirror.acceptedWhatsapp, label).toBe(mirror.accepted);

        /**
         * And the mirror really was a different distribution: in the sequential order the accepted
         * set is the first `limit` positions, so the mirror's per-channel split is the swap of this
         * run's. Asserted only there, because a concurrent burst's accepted set is not positional
         * and pinning it would be asserting a scheduling accident.
         */
        if (order === 'sequential') {
          expect(mirror.acceptedWeb, label).toBe(run.acceptedWhatsapp);
          expect(mirror.acceptedWhatsapp, label).toBe(run.acceptedWeb);
        }
      }),
      // 60 runs: the chat operation alone drives 51-53 real service calls per distribution, twice
      // (the run and its mirror), so this is already tens of thousands of reserves.
      { numRuns: 60 },
    );

    /* ── Non-vacuity ─────────────────────────────────────────────────────────── */
    expect([...operations].sort()).toStrictEqual(['chat', 'image', 'voice']);
    expect([...distributions].sort()).toStrictEqual([...DISTRIBUTIONS].sort());
    expect([...orders].sort()).toStrictEqual([...ORDERS].sort());
    expect([...clocks].sort()).toStrictEqual([...CLOCKS].sort());
    /** Both answers were observed: a harness that refused or admitted everything cannot pass. */
    expect(acceptedSeen).toBeGreaterThan(0);
    expect(declinedSeen).toBeGreaterThan(0);
  });

  it('lets a WhatsApp request spend the unit a web request would have had', async () => {
    /**
     * The sharing claim from the other side, and the one an accepted-count comparison cannot make:
     * a farmer who has spent their whole allowance **on the web** is declined on **WhatsApp**, and
     * the reverse. Two channels with two counters would answer both of these with an acceptance.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          operation: fc.constantFrom<Operation>('image', 'chat', 'voice'),
          spender: fc.constantFrom<Channel>('web', 'whatsapp'),
          language: fc.constantFrom<Language>('en', 'hi', 'mr'),
          clockIso: fc.constantFrom(...CLOCKS),
        }),
        async ({ operation, spender, language, clockIso }) => {
          const limit = DAILY_QUOTAS[operation];
          const other: Channel = spender === 'web' ? 'whatsapp' : 'web';
          const clockMs = Date.parse(clockIso);

          const state = counterState();
          const rpc = sharedCounter(state);

          for (let index = 0; index < limit; index += 1) {
            const outcome = await runRequest(operation, spender, language, rpc, clockMs);
            expect(outcome.kind).toBe('accepted');
          }

          const crossing = await runRequest(operation, other, language, rpc, clockMs);
          expect(crossing.kind, `${operation}: ${other} was not declined after ${spender} spent all`)
            .toBe('declined');
          if (crossing.kind === 'declined') {
            expect(crossing.error.code).toBe('QUOTA_EXCEEDED');
            expect(crossing.record.providerCalls).toBe(0);
          }
          expect(state.rows.size).toBe(1);
          expect(state.maxUsed).toBe(limit);
        },
      ),
      { numRuns: 18 },
    );
  });
});
