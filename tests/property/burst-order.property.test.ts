import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner } from '@/lib/ai/capabilities';
import { BURST_QUOTAS, DAILY_QUOTAS, STORAGE_BUCKETS } from '@/lib/config/verified';
import { ERROR_SPECS, errorResponse, isAppError, toEnvelope, type AppError } from '@/lib/errors';
import type { TranscriptionResult } from '@/lib/groq';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import { burstLimiter, type BurstCheck } from '@/lib/rate-limit';
import {
  HEALTHY_CONDITION,
  VERIFIED_CONDITIONS,
  type Channel,
  type ChatInput,
  type Language,
  type Operation,
  type StorageRef,
  type VerifiedCondition,
  type WindowKind,
} from '@/lib/schemas';
import type { StorageClientLike } from '@/lib/storage';
import { dayWindowKey, minuteWindowKey } from '@/lib/time';
import {
  chatTurn,
  type ChatTurnDeps,
  type ChatWriteStore,
  type ContextStore,
} from '@/services/chat.service';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import { diagnose, type DiagnosisDeps, type DiagnosisStore } from '@/services/diagnosis.service';
import {
  adminCounterRpc,
  reserveForRequest,
  type CounterRpc,
  type CounterRpcClient,
  type QuotaContext,
} from '@/services/quota.service';
import {
  transcribeAndAnswer,
  type ChatAnswerer,
  type NestedChatOutcome,
  type ObjectRemoveClient,
  type Transcriber,
  type VoiceDeps,
  type VoiceStore,
} from '@/services/voice.service';
import type { Database, DiagnosisRow, MessageRow, TablesInsert } from '@/types/database';

/**
 * **Property 28: Burst rate limiting precedes any quota spend**
 *
 * > For any burst of requests to the diagnosis, chat, or voice endpoint by one farmer within one
 * > short window, requests beyond the burst allowance are refused with HTTP 429, and no refused
 * > request increments that farmer's daily quota counter or invokes a provider.
 *
 * **Validates: Requirement 13.8**
 *
 * ### An ordering claim, so it is decided by counting, not by inspection
 *
 * The real `burstLimiter()` from `src/lib/rate-limit.ts` is bound into each of the three real
 * services at the seam the three route handlers use, and both controls are pointed at **one**
 * in-memory `counters` table — the same table migration `0007` gives them, distinguished only by
 * `window_kind`. Every counter call is then recorded **per request**, tagged with the window kind it
 * addressed, which is what turns the ordering into an observation:
 *
 *  - a **refused** request shows exactly one `minute` increment and **zero** `day` increments, and
 *    zero provider calls;
 *  - an **accepted** request shows one `minute` increment followed by one `day` increment.
 *
 * That is stronger than "the daily counter ends up at the right number". A service that reserved
 * first and refunded after a burst refusal would leave the same final count and fail here, because
 * the `day` increment would be one rather than zero — and the refund would show up as a `decrement`,
 * which is asserted to be zero as well.
 *
 * ### The refusal's status comes from the taxonomy and from the route's own renderer
 *
 * `errorResponse()` — the function `withErrorHandling()` calls for every route — is applied to the
 * refusal, and the resulting `Response.status` is asserted. So "refused with HTTP 429" is the status
 * a farmer's client would receive rather than a restatement of `ERROR_SPECS`. The distinction from
 * `QUOTA_EXCEEDED`, which is also 429, is asserted where it actually matters: the **retryable** flag,
 * and the `retryAfterSeconds` a burst refusal carries and a daily decline does not.
 *
 * ### The audit row is the services', not the limiter's
 *
 * `docs`-level reasoning made concrete: migration `0011` added `rate_limited`, and the row is written
 * by the three services because only they know the request's `channel` and its start instant.
 * `checkBurst()` sees neither, and its `burst` seam is injectable — so a limiter whose counter is
 * **unreachable** raises `INTERNAL_ERROR`, and that must not be recorded as a refusal that never
 * happened. Both halves are asserted here: a real refusal writes exactly one `rate_limited` row with
 * `quota_spent: false` and `model_provider: 'none'`, and an unreachable counter writes **no row at
 * all** while still spending nothing.
 *
 * ### The nesting rule rides along
 *
 * A voice request's nested chat answer is `covered`, so `checkBurstForRequest()` performs no check.
 * The burst rows are therefore asserted by key: a voice burst creates a `voice` minute row and
 * **no** `chat` minute row, so one voice message cannot eat a farmer's chat burst allowance.
 *
 * ### Which channels are generated, and why both
 *
 * Requirement 13.8 names the diagnosis, chat and voice **endpoints** — the three web routes — and
 * `rate-limit.ts` records that the WhatsApp webhook deliberately binds no limiter. The channel is
 * generated anyway, and the reason is the one that module gives for writing the audit row in the
 * services: the row must be honest about the channel "even if the WhatsApp adapter ever binds a
 * limiter". A run with `channel: 'whatsapp'` is therefore that future binding, and what it asserts is
 * that the refusal's row records the channel the service was given rather than a hardcoded `web`.
 *
 * ### Non-vacuity
 *
 * Coverage sets over the operation, the execution order (including **concurrent**, every request in
 * flight at once), the channel, and how far past the allowance the burst went — all asserted after
 * `fc.assert` — plus the requirement that both answers were observed at least once.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const USER_ID = '7d1e3f5a-2b4c-4d6e-8f0a-1b2c3d4e5f60';
const CONVERSATION_ID = 'c0d1e2f3-a4b5-4c6d-8e7f-90a1b2c3d4e5';
const DIAGNOSIS_ID = 'd0e1f2a3-b4c5-4d6e-8f70-8192a3b4c5d6';
const FARMER_MESSAGE_ID = 'f0a1b2c3-d4e5-4f60-8a71-92b3c4d5e6f7';
const ANSWER_MESSAGE_ID = 'a1b2c3d4-e5f6-4071-8b82-a3c4d5e6f708';

const CONDITION: VerifiedCondition = 'Tomato Early Blight';

/** One instant, so every request in a burst lands in the same minute window. */
const CLOCK_ISO = '2026-09-16T06:17:42.000Z';
const CLOCK_MS = Date.parse(CLOCK_ISO);

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
    id: `30c0abcd-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
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

const CHAT_QUESTION = `what should I do about ${CONDITION}`;

/** Gateway calls one accepted request makes: two for a diagnosis (classify, then the rephrase). */
const PROVIDER_CALLS_PER_ACCEPTED: Readonly<Record<Operation, number>> = {
  image: 2,
  chat: 1,
  voice: 1,
};

/* ========================================================================== */
/* One `counters` table, two window kinds                                      */
/* ========================================================================== */

interface CounterState {
  /** `user::operation::window_kind::window_key` → `used`. Both controls write this one map. */
  readonly rows: Map<string, number>;
}

function counterKey(args: {
  userId: string;
  operation: Operation;
  windowKind: WindowKind | string;
  windowKey: string;
}): string {
  return `${args.userId}::${args.operation}::${args.windowKind}::${args.windowKey}`;
}

interface CounterCall {
  readonly windowKind: string;
  readonly operation: Operation;
  readonly refused: boolean;
}

interface RequestRecord {
  /** Every `counter_try_increment` this request made, in order, tagged with its window kind. */
  readonly increments: CounterCall[];
  readonly decrements: string[];
  providerCalls: number;
  readonly usageRows: TablesInsert<'usage_logs'>[];
  readonly nestedCoverage: QuotaContext['role'][];
}

function requestRecord(): RequestRecord {
  return {
    increments: [],
    decrements: [],
    providerCalls: 0,
    usageRows: [],
    nestedCoverage: [],
  };
}

/**
 * A PostgREST response that carries an error, which is what "the counter is unreachable" looks like
 * from inside `adminCounterRpc()`.
 *
 * Used through the **real** adapter rather than by throwing a hand-built error, because the
 * classification is the thing that matters: `quota.service.ts` checks `error` before `data` so a
 * transport failure can never arrive looking like an at-limit answer. This is that check being
 * exercised, not restated.
 */
const unreachableCounterClient: CounterRpcClient = {
  rpc: () =>
    Promise.resolve({
      data: null,
      error: { code: '57P01', message: 'the counter row could not be reached' },
    }),
};

/**
 * The counter seam for **one** request: shared rows, per-request bookkeeping.
 *
 * The read and the write are separated by no `await`, which is the atomicity a single UPDATE has —
 * the same modelling `tests/property/quota.property.test.ts` uses, and the reason a concurrent burst
 * behaves here as it would against Postgres.
 */
function requestRpc(
  state: CounterState,
  record: RequestRecord,
  options: { readonly minuteFails?: boolean } = {},
): CounterRpc {
  return {
    async tryIncrement(args) {
      if (options.minuteFails === true && args.windowKind === 'minute') {
        // The real adapter's answer to an unreachable row: `INTERNAL_ERROR`, never `null`.
        return adminCounterRpc(unreachableCounterClient).tryIncrement(args);
      }
      const at = counterKey(args);
      const used = state.rows.get(at) ?? 0;
      if (used >= args.limit) {
        record.increments.push({
          windowKind: args.windowKind,
          operation: args.operation,
          refused: true,
        });
        return null;
      }
      state.rows.set(at, used + 1);
      record.increments.push({
        windowKind: args.windowKind,
        operation: args.operation,
        refused: false,
      });
      return used + 1;
    },
    async decrement(args) {
      record.decrements.push(args.windowKind);
      const at = counterKey(args);
      const used = state.rows.get(at) ?? 0;
      if (used === 0) return null;
      state.rows.set(at, used - 1);
      return used - 1;
    },
    async used(args) {
      return state.rows.get(counterKey(args)) ?? 0;
    },
  };
}

function dayIncrements(record: RequestRecord): CounterCall[] {
  return record.increments.filter((call) => call.windowKind === 'day');
}

function minuteIncrements(record: RequestRecord): CounterCall[] {
  return record.increments.filter((call) => call.windowKind === 'minute');
}

/* ========================================================================== */
/* Shared seams                                                                */
/* ========================================================================== */

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

function refFor(bucket: string): StorageRef {
  return { bucket: bucket as StorageRef['bucket'], path: `${USER_ID}/2026/09/${randomUUID()}.jpg` };
}

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
    created_at: '2026-09-16T06:17:42.000Z',
  };
}

/* -------------------------------------------------------------------------- */
/* The three services, each with the real limiter at its own step              */
/* -------------------------------------------------------------------------- */

function diagnosisDeps(rpc: CounterRpc, burst: BurstCheck, record: RequestRecord): DiagnosisDeps {
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
        created_at: '2026-09-16T06:17:42.000Z',
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
    burst,
    quota: { rpc, now: new Date(CLOCK_MS) },
    now: () => CLOCK_MS,
    deadlineMs: CLOCK_MS + 45_000,
    platformDeadline: () => undefined,
  };
}

function chatDeps(rpc: CounterRpc, burst: BurstCheck, record: RequestRecord): ChatTurnDeps {
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
    burst,
    quota: { rpc, now: new Date(CLOCK_MS) },
    now: () => CLOCK_MS,
    platformDeadline: () => undefined,
  };
}

function voiceDeps(rpc: CounterRpc, burst: BurstCheck, record: RequestRecord): VoiceDeps {
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
   * The nested `ChatService`. It hands its coverage to the same real `reserveForRequest()` the
   * services use — and is given **no** limiter, which is what `/api/voice` does: the nested turn is
   * covered, so a second burst slot must not be taken.
   */
  const chat: ChatAnswerer = async (input: ChatInput, coverage: QuotaContext) => {
    record.nestedCoverage.push(coverage.role);
    const reserved = await reserveForRequest(coverage, { rpc, now: new Date(CLOCK_MS) });
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
    burst,
    quota: { rpc, now: new Date(CLOCK_MS) },
    now: () => CLOCK_MS,
    deadlineMs: CLOCK_MS + 45_000,
    platformDeadline: () => undefined,
  };
}

/* ========================================================================== */
/* One request, through the real limiter                                       */
/* ========================================================================== */

type RequestOutcome =
  | { readonly kind: 'accepted'; readonly record: RequestRecord; readonly channel: Channel }
  | {
      readonly kind: 'failed';
      readonly error: AppError;
      readonly record: RequestRecord;
      readonly channel: Channel;
    };

interface RunOptions {
  readonly minuteFails?: boolean;
  /** Counted so a refused request can be shown not to have driven housekeeping. */
  readonly prunes?: { count: number };
}

async function runRequest(
  operation: Operation,
  channel: Channel,
  language: Language,
  state: CounterState,
  options: RunOptions = {},
): Promise<RequestOutcome> {
  const record = requestRecord();
  const rpc = requestRpc(state, record, options);

  /**
   * **The real limiter**, exactly as the three route handlers bind it: `burstLimiter()` over the
   * counter seam and the request's clock. `prune` is a counting stub rather than the default, which
   * is `rate-limit.ts`'s own documented opt-out — the default would construct a service-role client
   * for housekeeping this property is not about.
   */
  const burst: BurstCheck = burstLimiter({
    rpc,
    now: () => new Date(CLOCK_MS),
    prune: () => {
      if (options.prunes !== undefined) options.prunes.count += 1;
      return Promise.resolve(0);
    },
  });

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
        diagnosisDeps(rpc, burst, record),
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
        chatDeps(rpc, burst, record),
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
        voiceDeps(rpc, burst, record),
      );
    }
    return { kind: 'accepted', record, channel };
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { kind: 'failed', error, record, channel };
  }
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

type ExecutionOrder = 'sequential' | 'concurrent';

const ORDERS: readonly ExecutionOrder[] = ['sequential', 'concurrent'];
const OPERATIONS: readonly Operation[] = ['image', 'chat', 'voice'];
const CHANNELS: readonly Channel[] = ['web', 'whatsapp'];

interface Burst {
  readonly operation: Operation;
  readonly order: ExecutionOrder;
  readonly channel: Channel;
  readonly language: Language;
  /** How many requests past the allowance. At least one, so a refusal always happens. */
  readonly beyond: number;
}

const burstArb: fc.Arbitrary<Burst> = fc.record({
  operation: fc.constantFrom<Operation>(...OPERATIONS),
  order: fc.constantFrom<ExecutionOrder>(...ORDERS),
  channel: fc.constantFrom<Channel>(...CHANNELS),
  language: fc.constantFrom<Language>('en', 'hi', 'mr'),
  beyond: fc.integer({ min: 1, max: 4 }),
});

/* ========================================================================== */
/* The facts the property rests on                                             */
/* ========================================================================== */

describe('the two 429s Property 28 has to keep apart, read from the taxonomy', () => {
  it('gives a burst refusal and a daily decline the same status and different retryability', () => {
    expect(ERROR_SPECS.RATE_LIMITED.status).toBe(429);
    expect(ERROR_SPECS.QUOTA_EXCEEDED.status).toBe(429);
    /** The difference a client can act on: a burst window clears in seconds, a day does not. */
    expect(ERROR_SPECS.RATE_LIMITED.retryable).toBe(true);
    expect(ERROR_SPECS.QUOTA_EXCEEDED.retryable).toBe(false);
    /** And the burst ceiling is a control of its own, set independently of the daily quota. */
    for (const operation of OPERATIONS) {
      expect(BURST_QUOTAS[operation]).toBeLessThan(DAILY_QUOTAS[operation]);
    }
  });
});

/* ========================================================================== */
/* Property 28                                                                 */
/* ========================================================================== */

describe('Property 28: the burst check runs before anything is spent', () => {
  it('refuses past the allowance with 429, and a refused request touches no day counter and no provider', async () => {
    const operations = new Set<Operation>();
    const orders = new Set<ExecutionOrder>();
    const channels = new Set<Channel>();
    const beyonds = new Set<number>();
    let acceptedSeen = 0;
    let refusedSeen = 0;

    await fc.assert(
      fc.asyncProperty(burstArb, async (burst) => {
        const { operation, order, channel, language } = burst;
        const allowance = BURST_QUOTAS[operation];
        const total = allowance + burst.beyond;
        const label = `${operation} / ${order} / ${channel} / +${String(burst.beyond)}`;

        operations.add(operation);
        orders.add(order);
        channels.add(channel);
        beyonds.add(burst.beyond);

        const state: CounterState = { rows: new Map<string, number>() };
        const prunes = { count: 0 };

        const outcomes =
          order === 'concurrent'
            ? await Promise.all(
                Array.from({ length: total }, () =>
                  runRequest(operation, channel, language, state, { prunes }),
                ),
              )
            : await (async () => {
                const collected: RequestOutcome[] = [];
                for (let index = 0; index < total; index += 1) {
                  collected.push(await runRequest(operation, channel, language, state, { prunes }));
                }
                return collected;
              })();

        const accepted = outcomes.filter((outcome) => outcome.kind === 'accepted');
        const refused = outcomes.filter((outcome) => outcome.kind === 'failed');
        acceptedSeen += accepted.length;
        refusedSeen += refused.length;

        /* ── The allowance is the allowance ───────────────────────────────────── */
        expect(accepted, `${label} admitted the wrong number`).toHaveLength(allowance);
        expect(refused, label).toHaveLength(burst.beyond);

        /* ── Every request reached the burst check; only the accepted reached the reserve ── */
        for (const outcome of outcomes) {
          const minute = minuteIncrements(outcome.record);
          expect(minute, `${label} did not consult the minute window`).toHaveLength(1);
          expect(minute[0]?.operation, label).toBe(operation);
        }

        for (const outcome of accepted) {
          /** One slot, then one unit, in that order — the sequence is the requirement. */
          expect(outcome.record.increments.map((call) => call.windowKind), label).toStrictEqual([
            'minute',
            'day',
          ]);
          expect(outcome.record.providerCalls, label).toBe(
            PROVIDER_CALLS_PER_ACCEPTED[operation],
          );
        }

        for (const outcome of refused) {
          if (outcome.kind !== 'failed') throw new Error('unreachable');

          /** Requirement 13.8 — refused, with the status a route would actually send. */
          expect(outcome.error.code, label).toBe('RATE_LIMITED');
          expect(errorResponse(outcome.error, language).status, label).toBe(429);

          /** The retry a burst refusal offers, and the daily decline's fields it must not carry. */
          const envelope = toEnvelope(outcome.error, language);
          expect(envelope.error.retryable, label).toBe(true);
          expect(envelope.error.details?.retryAfterSeconds ?? 0, label).toBeGreaterThanOrEqual(1);
          expect(envelope.error.details?.limit, label).toBeUndefined();
          expect(envelope.error.details?.resetsAt, label).toBeUndefined();
          expect(envelope.error.message.length, label).toBeGreaterThan(0);

          /* ── The ordering claim, as counted zeros ──────────────────────────── */
          expect(
            dayIncrements(outcome.record),
            `${label} incremented the daily counter on a refused request`,
          ).toStrictEqual([]);
          expect(
            outcome.record.decrements,
            `${label} refunded on a refused request — nothing was taken`,
          ).toStrictEqual([]);
          expect(
            outcome.record.providerCalls,
            `${label} invoked a provider on a refused request`,
          ).toBe(0);

          /** Requirement 13.8's audit row, written by the service that knows the channel. */
          expect(outcome.record.usageRows, label).toHaveLength(1);
          const row = outcome.record.usageRows[0] as TablesInsert<'usage_logs'>;
          expect(row.outcome, label).toBe('rate_limited');
          expect(row.quota_spent, label).toBe(false);
          expect(row.model_provider, label).toBe('none');
          expect(row.operation, label).toBe(operation);
          expect(row.channel, label).toBe(channel);
          expect(row.user_id, label).toBe(USER_ID);
        }

        /* ── The rows the two controls left behind ─────────────────────────────── */
        const minuteKey = counterKey({
          userId: USER_ID,
          operation,
          windowKind: 'minute',
          windowKey: minuteWindowKey(new Date(CLOCK_MS)),
        });
        const dayKey = counterKey({
          userId: USER_ID,
          operation,
          windowKind: 'day',
          windowKey: dayWindowKey(new Date(CLOCK_MS)),
        });

        expect(state.rows.get(minuteKey), label).toBe(allowance);
        /** Only the admitted requests spent a unit: the day row equals the allowance, not the burst. */
        expect(state.rows.get(dayKey), `${label} spent more units than it admitted requests`).toBe(
          allowance,
        );
        expect([...state.rows.keys()].sort(), label).toStrictEqual([dayKey, minuteKey].sort());

        /* ── The nesting rule: a voice burst never touches a chat minute row ───── */
        if (operation === 'voice') {
          const nested = outcomes.flatMap((outcome) => outcome.record.nestedCoverage);
          expect(nested, label).toHaveLength(allowance);
          expect(new Set(nested), label).toStrictEqual(new Set(['covered']));
          expect(
            [...state.rows.keys()].some((key) => key.includes('::chat::')),
            `${label} took a chat burst slot for a voice request`,
          ).toBe(false);
        }

        /** Housekeeping runs after a passing check, never before one, so it is bounded by them. */
        expect(prunes.count, label).toBeLessThanOrEqual(allowance);
      }),
      { numRuns: 90 },
    );

    /* ── Non-vacuity ─────────────────────────────────────────────────────────── */
    expect([...operations].sort()).toStrictEqual([...OPERATIONS].sort());
    expect([...orders].sort()).toStrictEqual([...ORDERS].sort());
    expect([...channels].sort()).toStrictEqual([...CHANNELS].sort());
    expect([...beyonds].sort()).toStrictEqual([1, 2, 3, 4]);
    expect(acceptedSeen).toBeGreaterThan(0);
    expect(refusedSeen).toBeGreaterThan(0);
  });

  it('records nothing as a refusal when the burst counter itself is unreachable', async () => {
    /**
     * The other half of the recorded placement decision. `checkBurst()` does not write the audit row
     * — the services do, keyed on `error.code === 'RATE_LIMITED'` — precisely so a limiter that
     * *failed* is not recorded as a farmer who asked too fast. This is that case: the minute row
     * cannot be reached, the request fails with `INTERNAL_ERROR`, and **no** `rate_limited` row is
     * written. Nothing is spent either: the reserve is still below the check.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          operation: fc.constantFrom<Operation>(...OPERATIONS),
          channel: fc.constantFrom<Channel>(...CHANNELS),
          language: fc.constantFrom<Language>('en', 'hi', 'mr'),
        }),
        async ({ operation, channel, language }) => {
          const state: CounterState = { rows: new Map<string, number>() };

          const outcome = await runRequest(operation, channel, language, state, {
            minuteFails: true,
          });

          expect(outcome.kind).toBe('failed');
          if (outcome.kind !== 'failed') return;

          /** Not a refusal: a limiter that could not reach its counter is an internal failure. */
          expect(outcome.error.code).toBe('INTERNAL_ERROR');
          expect(errorResponse(outcome.error, language).status).toBe(500);

          /** No audit row at all — a refusal that never happened is not recorded as one. */
          expect(
            outcome.record.usageRows.filter((row) => row.outcome === 'rate_limited'),
          ).toStrictEqual([]);
          expect(outcome.record.usageRows).toStrictEqual([]);

          /** And nothing was spent: the reserve sits below the check that failed. */
          expect(dayIncrements(outcome.record)).toStrictEqual([]);
          expect(outcome.record.decrements).toStrictEqual([]);
          expect(outcome.record.providerCalls).toBe(0);
          expect(state.rows.size).toBe(0);
        },
      ),
      { numRuns: 40 },
    );
  });
});
