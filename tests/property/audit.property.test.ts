import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { CapabilityRunner } from '@/lib/ai/capabilities';
import { STORAGE_BUCKETS } from '@/lib/config/verified';
import { usageLogRow, type UsageFacts } from '@/lib/db/usage-log';
import type {
  ExistingInbound,
  InboundReceivedRow,
  TerminalInboundStatus,
  WhatsappInboundStore,
} from '@/lib/db/whatsapp-inbound';
import { AppError, isAppError } from '@/lib/errors';
import type { TranscriptionResult } from '@/lib/groq';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import type { BurstCheck } from '@/lib/rate-limit';
import {
  HEALTHY_CONDITION,
  VERIFIED_CONDITIONS,
  usageOutcomeSchema,
  type Channel,
  type ChatInput,
  type Language,
  type Operation,
  type StorageRef,
  type UsageOutcome,
  type VerifiedCondition,
} from '@/lib/schemas';
import type { StorageClientLike } from '@/lib/storage';
import type { InboundContent, InboundMessage, SendReplyResult } from '@/lib/whatsapp';
import { processInboundBatch, type WhatsappDispatchDeps } from '@/lib/whatsapp-dispatch';
import {
  chatTurn,
  type ChatTurnDeps,
  type ChatWriteStore,
  type ContextStore,
} from '@/services/chat.service';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import { diagnose, type DiagnosisDeps, type DiagnosisStore } from '@/services/diagnosis.service';
import type { CounterRpc, QuotaContext } from '@/services/quota.service';
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
 * **Property 22: Every model operation leaves a complete audit row**
 *
 * > For any completed model operation, exactly one usage log row records the farmer identifier, the
 * > operation type, the channel, the model provider used, and the outcome; and whenever the gateway
 * > served the request from the fallback provider, that row records the fallback.
 *
 * **Validates: Requirements 14.6, 14.7**
 *
 * ### The column list is read out of the source, not copied into this file
 *
 * `usageLogRow()` in `src/lib/db/usage-log.ts` is the one row builder every audit write goes through,
 * and it writes **every** column on **every** row — explicit `null` rather than an omitted key, so a
 * database default can never stand in for a decision. Both column sets below are derived by calling
 * it:
 *
 *  - `ALL_COLUMNS` — the keys it produces. Every row observed in this file must have exactly these
 *    keys, so a call site that hand-built a row and forgot one fails here, and a column added to the
 *    builder later is covered with no edit to this test.
 *  - `REQUIRED_COLUMNS` — the keys that are non-null when only `UsageFacts`'s **required** fields are
 *    supplied. That is the module's own type discipline read as data: a fact a caller may omit comes
 *    out `null`, and a fact it cannot omit comes out with a value. Those are the columns asserted
 *    non-null on every row.
 *
 * The tie back to the requirement text is then asserted rather than assumed: the five facts
 * Requirement 14.6 names, and the fallback flag Requirement 14.7 names, must all be members of the
 * derived `REQUIRED_COLUMNS`. If `usageLogRow` ever stopped writing one, or made it optional, that
 * assertion fails before any property runs.
 *
 * ### Every operation kind and every outcome, on real paths
 *
 * Twenty-three cases drive the **real** services and the **real** WhatsApp pipeline — `diagnose()`,
 * `chatTurn()`, `transcribeAndAnswer()` and `processInboundBatch()` — one per audited path, including
 * the ones that are not model successes:
 *
 *  - the served answer, on all three operations;
 *  - the four ways an answer degrades: a stage-1 rejection, a refused rephrase, an exhausted chain
 *    and an expired budget;
 *  - the two honest non-answers: an unclear photo, and an empty transcript;
 *  - the referral, which is the one path that reaches no provider and therefore refunds;
 *  - a pre-provider storage failure, which is spent-nothing rather than spent;
 *  - both refusals — the daily decline (14.3) and the burst refusal (13.8, migration `0011`);
 *  - the WhatsApp adapter's own two rows: the pre-flight soft-deadline refusal and a redelivery.
 *
 * The **non-vacuity guard is the strongest available one**: the set of `outcome` values observed
 * across the run must equal `usageOutcomeSchema.options` exactly. Every value the vocabulary can hold
 * is produced by a real path in this file, so a value added to the schema without a path that writes
 * it fails the run — which is the failure the task calls out, an operation path that writes no row.
 *
 * ### Requirement 14.7 is asserted in both directions
 *
 * The fallback flag is generated, and the same case is run with it `false` and `true`; a row for a
 * path that reached the gateway must carry the generated value, and a row for a path that reached no
 * provider at all must carry `false`. Both are asserted per case, so "records the fallback" cannot be
 * satisfied by a column that is always `true`, nor by one that is always `false`.
 *
 * ### One request is not always one row
 *
 * `usage-log.ts` states the rule: a row covers one `operation`, so a diagnosis (two gateway calls,
 * one operation) is one row, and a voice request (transcription plus the nested chat answer, two
 * operations) is **two**. The voice success case therefore runs the **real** `chatTurn` as its nested
 * service and asserts two complete rows — a `voice` row and a `chat` row — against a single reserved
 * unit. A harness that stubbed the nested call would have quietly asserted the weaker claim.
 */

/* ========================================================================== */
/* The column sets, derived from the one row builder                           */
/* ========================================================================== */

const USER_ID = '8e2c4a6b-1d3f-4e5a-8b7c-9d0e1f2a3b4c';
const CONVERSATION_ID = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
const DIAGNOSIS_ID = 'c2d3e4f5-a6b7-4c8d-8e9f-1a2b3c4d5e6f';
const FARMER_MESSAGE_ID = 'd3e4f5a6-b7c8-4d9e-8f01-2b3c4d5e6f70';
const ANSWER_MESSAGE_ID = 'e4f5a6b7-c8d9-4e0f-8123-3c4d5e6f7081';

/** Everything a caller may supply, so the key list is the full column set. */
const FULL_FACTS: UsageFacts = {
  userId: USER_ID,
  operation: 'image',
  channel: 'web',
  outcome: 'success',
  provider: 'gemini',
  usedFallback: true,
  quotaSpent: true,
  latencyMs: 12,
  rejectionReason: 'rephrase_rejected',
  conversationId: CONVERSATION_ID,
  diagnosisId: DIAGNOSIS_ID,
  promptVersion: 'probe',
};

/**
 * Only `UsageFacts`'s **required** fields. Whatever comes out non-null from these is a column that
 * can never legitimately be null — which is exactly the "populated" half of this property, derived
 * rather than listed.
 */
const MINIMAL_FACTS: UsageFacts = {
  userId: USER_ID,
  operation: 'image',
  channel: 'web',
  outcome: 'success',
  provider: 'gemini',
  usedFallback: false,
  quotaSpent: true,
  latencyMs: 0,
};

const ALL_COLUMNS: readonly string[] = Object.keys(usageLogRow(FULL_FACTS)).sort();

const REQUIRED_COLUMNS: readonly string[] = Object.entries(usageLogRow(MINIMAL_FACTS))
  .filter(([, value]) => value !== null)
  .map(([column]) => column)
  .sort();

/** The five facts Requirement 14.6 names, as the columns that carry them. */
const REQUIREMENT_14_6_COLUMNS = {
  'the farmer identifier': 'user_id',
  'the operation type': 'operation',
  'the channel': 'channel',
  'the model provider used': 'model_provider',
  'the outcome': 'outcome',
} as const;

/** Requirement 14.7's fact. */
const REQUIREMENT_14_7_COLUMN = 'used_fallback';

function columnOf(row: TablesInsert<'usage_logs'>, column: string): unknown {
  return (row as unknown as Record<string, unknown>)[column];
}

/**
 * The completeness assertion, applied to every row this file observes.
 *
 * Two halves: the key set is exactly the builder's (so nothing was omitted and no database default
 * was relied on), and every column that cannot legitimately be null carries a value.
 */
function assertComplete(row: TablesInsert<'usage_logs'>, label: string): void {
  expect(Object.keys(row).sort(), `${label}: the row's column set`).toStrictEqual(ALL_COLUMNS);

  for (const column of REQUIRED_COLUMNS) {
    const value = columnOf(row, column);
    expect(value, `${label}: ${column} is null`).not.toBeNull();
    expect(value, `${label}: ${column} is absent`).not.toBeUndefined();
    if (column === 'latency_ms') {
      expect(typeof value, `${label}: latency_ms is not a number`).toBe('number');
      expect(value as number, `${label}: latency_ms is negative`).toBeGreaterThanOrEqual(0);
    } else {
      expect(String(value).length, `${label}: ${column} is empty`).toBeGreaterThan(0);
    }
  }
}

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const CONDITION: VerifiedCondition = 'Tomato Early Blight';
/** A different verified condition, used to make a rephrase fail its out-of-scope check. */
const OTHER_CONDITION: VerifiedCondition = 'Potato Late Blight';

const CLOCK_MS = Date.parse('2026-09-16T06:17:42.000Z');

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
    id: `40d0abcd-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
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

function entryFor(condition: VerifiedCondition): KnowledgeEntry {
  const found = KNOWLEDGE_ROWS.find((row) => row.disease_name === condition);
  if (found === undefined) throw new Error(`no generated row for "${condition}"`);
  return found;
}

const IDENTIFIED_CLASSIFICATION = JSON.stringify({
  status: 'identified',
  disease_name: CONDITION,
  confidence: 0.86,
  severity: 'moderate',
});

const UNCLEAR_CLASSIFICATION = JSON.stringify({
  status: 'unclear',
  disease_name: null,
  confidence: 0.1,
  severity: 'none',
});

const IN_SCOPE_QUESTION = `what should I do about ${CONDITION}`;
/** No verified vocabulary at all, so the turn refers the farmer on and calls no model (4.7). */
const OUT_OF_SCOPE_QUESTION = 'how much water does wheat need in summer';

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

function refFor(bucket: string, extension: 'jpg' | 'ogg'): StorageRef {
  return {
    bucket: bucket as StorageRef['bucket'],
    path: `${USER_ID}/2026/09/${randomUUID()}.${extension}`,
  };
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

/** The counter, with the two behaviours the refusal cases need. */
function counterRpc(options: { readonly atLimit?: boolean } = {}): CounterRpc {
  const rows = new Map<string, number>();
  return {
    async tryIncrement(args) {
      if (options.atLimit === true && args.windowKind === 'day') return null;
      const key = `${args.userId}::${args.operation}::${args.windowKind}::${args.windowKey}`;
      const used = (rows.get(key) ?? 0) + 1;
      rows.set(key, used);
      return used;
    },
    async decrement() {
      return 0;
    },
    async used() {
      return 0;
    },
  };
}

/** Requirement 13.8's refusal, as the limiter raises it. */
const refusingBurst: BurstCheck = () =>
  Promise.reject(
    new AppError('RATE_LIMITED', {
      details: { retryAfterSeconds: 17 },
      context: { reason: 'burst_ceiling_reached', userId: USER_ID },
    }),
  );

function storageStub(
  options: { readonly signFails?: boolean } = {},
): StorageClientLike & ObjectRemoveClient {
  return {
    storage: {
      from: () => ({
        exists: () => Promise.resolve({ data: true, error: null }),
        createSignedUrl: (path: string) =>
          options.signFails === true
            ? Promise.resolve({ data: null, error: { message: 'signing is unavailable' } })
            : Promise.resolve({
                data: { signedUrl: `https://storage.test/${path}?token=synthetic` },
                error: null,
              }),
        remove: () => Promise.resolve({ data: [{ name: 'removed' }], error: null }),
      }),
    },
  };
}

/* ========================================================================== */
/* The cases                                                                   */
/* ========================================================================== */

/**
 * One audited path each. The names say what happened, not which assertion follows, so a shrunk
 * counterexample names the path rather than a case number.
 */
const CASES = [
  'image_served',
  'image_stage1_rejected',
  'image_rephrase_rejected',
  'image_model_unclear',
  'image_chain_exhausted',
  'image_budget_expired',
  'image_signed_url_failed',
  'image_quota_declined',
  'image_burst_refused',

  'chat_served',
  'chat_rephrase_rejected',
  'chat_chain_exhausted',
  'chat_referral',
  'chat_quota_declined',
  'chat_burst_refused',

  'voice_served_with_nested_chat',
  'voice_empty_transcript',
  'voice_transcription_failed',
  'voice_budget_expired',
  'voice_quota_declined',
  'voice_burst_refused',

  'whatsapp_preflight_budget_expired',
  'whatsapp_redelivery_ignored',
] as const;

type CaseId = (typeof CASES)[number];

interface ExpectedRow {
  readonly operation: Operation;
  readonly outcome: UsageOutcome;
  /**
   * `'request'` means the row must name the **generated** provider, so `model_provider` is not a
   * constant across the run. `'groq'` is the transcription's only member (V10). `'none'` is the
   * positive statement that no provider served the row.
   */
  readonly provider: 'request' | 'groq' | 'none';
  readonly quotaSpent: boolean;
  readonly rejectionReason: string | null;
  /**
   * Whether Requirement 14.7's flag on this row must equal the **generated** fallback value. `false`
   * for a path that reached no provider, where the only honest value is `false`.
   */
  readonly carriesRequestFallback: boolean;
}

const EXPECTED: Readonly<Record<CaseId, readonly ExpectedRow[]>> = {
  image_served: [
    {
      operation: 'image',
      outcome: 'success',
      provider: 'request',
      quotaSpent: true,
      rejectionReason: null,
      carriesRequestFallback: true,
    },
  ],
  image_stage1_rejected: [
    {
      operation: 'image',
      outcome: 'validation_rejected',
      provider: 'request',
      quotaSpent: true,
      rejectionReason: 'not_json',
      carriesRequestFallback: true,
    },
  ],
  image_rephrase_rejected: [
    {
      operation: 'image',
      outcome: 'validation_rejected',
      provider: 'request',
      quotaSpent: true,
      rejectionReason: 'rephrase_rejected',
      carriesRequestFallback: true,
    },
  ],
  image_model_unclear: [
    {
      operation: 'image',
      outcome: 'inconclusive',
      provider: 'request',
      quotaSpent: true,
      rejectionReason: 'model_unclear',
      carriesRequestFallback: true,
    },
  ],
  image_chain_exhausted: [
    {
      operation: 'image',
      outcome: 'provider_error',
      provider: 'none',
      quotaSpent: true,
      rejectionReason: null,
      carriesRequestFallback: true,
    },
  ],
  image_budget_expired: [
    {
      operation: 'image',
      outcome: 'timeout',
      provider: 'none',
      quotaSpent: true,
      rejectionReason: null,
      carriesRequestFallback: true,
    },
  ],
  image_signed_url_failed: [
    {
      operation: 'image',
      outcome: 'provider_error',
      provider: 'none',
      quotaSpent: false,
      rejectionReason: null,
      carriesRequestFallback: false,
    },
  ],
  image_quota_declined: [
    {
      operation: 'image',
      outcome: 'quota_declined',
      provider: 'none',
      quotaSpent: false,
      rejectionReason: null,
      carriesRequestFallback: false,
    },
  ],
  image_burst_refused: [
    {
      operation: 'image',
      outcome: 'rate_limited',
      provider: 'none',
      quotaSpent: false,
      rejectionReason: null,
      carriesRequestFallback: false,
    },
  ],

  chat_served: [
    {
      operation: 'chat',
      outcome: 'success',
      provider: 'request',
      quotaSpent: true,
      rejectionReason: null,
      carriesRequestFallback: true,
    },
  ],
  chat_rephrase_rejected: [
    {
      operation: 'chat',
      outcome: 'validation_rejected',
      provider: 'request',
      quotaSpent: true,
      rejectionReason: 'rephrase_rejected',
      carriesRequestFallback: true,
    },
  ],
  chat_chain_exhausted: [
    {
      operation: 'chat',
      outcome: 'provider_error',
      // `answerQuestion` degrades rather than throwing, and reports no provider: none served it.
      provider: 'none',
      quotaSpent: true,
      rejectionReason: null,
      carriesRequestFallback: true,
    },
  ],
  chat_referral: [
    {
      operation: 'chat',
      outcome: 'inconclusive',
      provider: 'none',
      // The spend rule read in the direction it usually is not: no provider call, so nothing spent.
      quotaSpent: false,
      rejectionReason: null,
      carriesRequestFallback: false,
    },
  ],
  chat_quota_declined: [
    {
      operation: 'chat',
      outcome: 'quota_declined',
      provider: 'none',
      quotaSpent: false,
      rejectionReason: null,
      carriesRequestFallback: false,
    },
  ],
  chat_burst_refused: [
    {
      operation: 'chat',
      outcome: 'rate_limited',
      provider: 'none',
      quotaSpent: false,
      rejectionReason: null,
      carriesRequestFallback: false,
    },
  ],

  /** Two operations, two rows — the transcription and the nested answer. */
  voice_served_with_nested_chat: [
    {
      operation: 'chat',
      outcome: 'success',
      provider: 'request',
      quotaSpent: true,
      rejectionReason: null,
      carriesRequestFallback: true,
    },
    {
      operation: 'voice',
      outcome: 'success',
      provider: 'groq',
      quotaSpent: true,
      rejectionReason: null,
      carriesRequestFallback: true,
    },
  ],
  voice_empty_transcript: [
    {
      operation: 'voice',
      outcome: 'inconclusive',
      provider: 'groq',
      quotaSpent: true,
      rejectionReason: null,
      carriesRequestFallback: true,
    },
  ],
  voice_transcription_failed: [
    {
      operation: 'voice',
      outcome: 'provider_error',
      provider: 'none',
      quotaSpent: true,
      rejectionReason: null,
      carriesRequestFallback: true,
    },
  ],
  voice_budget_expired: [
    {
      operation: 'voice',
      outcome: 'timeout',
      provider: 'none',
      quotaSpent: true,
      rejectionReason: null,
      carriesRequestFallback: true,
    },
  ],
  voice_quota_declined: [
    {
      operation: 'voice',
      outcome: 'quota_declined',
      provider: 'none',
      quotaSpent: false,
      rejectionReason: null,
      carriesRequestFallback: false,
    },
  ],
  voice_burst_refused: [
    {
      operation: 'voice',
      outcome: 'rate_limited',
      provider: 'none',
      quotaSpent: false,
      rejectionReason: null,
      carriesRequestFallback: false,
    },
  ],

  /** The WhatsApp adapter's own row (Requirement 3.7's reading of D11's soft deadline). */
  whatsapp_preflight_budget_expired: [
    {
      operation: 'image',
      outcome: 'timeout',
      provider: 'none',
      quotaSpent: false,
      rejectionReason: null,
      carriesRequestFallback: false,
    },
  ],
  /** Requirement 11.5's row, written by the duplicate guard once the farmer is attributable. */
  whatsapp_redelivery_ignored: [
    {
      operation: 'image',
      outcome: 'duplicate_ignored',
      provider: 'none',
      quotaSpent: false,
      rejectionReason: null,
      carriesRequestFallback: false,
    },
  ],
};

/** Which channel a case can run on. The WhatsApp adapter's own rows are `whatsapp` by construction. */
function channelsFor(caseId: CaseId): readonly Channel[] {
  return caseId.startsWith('whatsapp_') ? ['whatsapp'] : ['web', 'whatsapp'];
}

/* ========================================================================== */
/* Running one case                                                            */
/* ========================================================================== */

interface RunInput {
  readonly caseId: CaseId;
  readonly channel: Channel;
  readonly language: Language;
  readonly usedFallback: boolean;
  /** Which provider served, when one did. Generated so `model_provider` is not a constant. */
  readonly provider: 'gemini' | 'groq';
}

function providerFailure(code: 'PROVIDERS_UNAVAILABLE' | 'DIAGNOSIS_TIMEOUT', usedFallback: boolean) {
  return new AppError(code, { context: { reason: 'property_case', usedFallback } });
}

/* -------------------------------------------------------------------------- */
/* image                                                                       */
/* -------------------------------------------------------------------------- */

function diagnosisDeps(input: RunInput, rows: TablesInsert<'usage_logs'>[]): DiagnosisDeps {
  const { caseId, usedFallback, provider } = input;

  const models: CapabilityRunner = {
    classify: () => {
      if (caseId === 'image_chain_exhausted') {
        return Promise.reject(providerFailure('PROVIDERS_UNAVAILABLE', usedFallback));
      }
      if (caseId === 'image_budget_expired') {
        return Promise.reject(providerFailure('DIAGNOSIS_TIMEOUT', usedFallback));
      }
      return Promise.resolve({
        value:
          caseId === 'image_stage1_rejected'
            ? 'the leaves look unwell — prose, not JSON'
            : caseId === 'image_model_unclear'
              ? UNCLEAR_CLASSIFICATION
              : IDENTIFIED_CLASSIFICATION,
        provider,
        usedFallback,
      });
    },
    generate: () => {
      const entry = entryFor(CONDITION);
      return Promise.resolve({
        value:
          caseId === 'image_rephrase_rejected'
            ? // Names a condition the supplied row is not about, so the post-generation checks
              // refuse the prose and the farmer reads the row's own template instead.
              `${OTHER_CONDITION} has taken over this field.`
            : `${CONDITION}: ${entry.symptoms[0] ?? ''}`,
        provider,
        usedFallback,
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
      rows.push(row);
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
    storage: storageStub({ signFails: caseId === 'image_signed_url_failed' }),
    store,
    conversations,
    knowledge,
    models,
    ...(caseId === 'image_burst_refused' ? { burst: refusingBurst } : {}),
    quota: { rpc: counterRpc({ atLimit: caseId === 'image_quota_declined' }), now: new Date(CLOCK_MS) },
    now: () => CLOCK_MS,
    deadlineMs: CLOCK_MS + 45_000,
    platformDeadline: () => undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* chat                                                                       */
/* -------------------------------------------------------------------------- */

function chatDeps(
  input: RunInput,
  rows: TablesInsert<'usage_logs'>[],
  options: { readonly nested?: boolean } = {},
): ChatTurnDeps {
  const { caseId, usedFallback, provider } = input;

  const models: CapabilityRunner = {
    classify: () => Promise.reject(new Error('a chat turn asked for a vision judgement')),
    generate: () => {
      if (caseId === 'chat_chain_exhausted') {
        return Promise.reject(providerFailure('PROVIDERS_UNAVAILABLE', usedFallback));
      }
      const entry = entryFor(CONDITION);
      return Promise.resolve({
        value:
          caseId === 'chat_rephrase_rejected'
            ? `${OTHER_CONDITION} is the real problem here.`
            : `${CONDITION}: ${entry.treatment[0] ?? ''}`,
        provider,
        usedFallback,
      });
    },
  };

  const store: ContextStore = {
    recentMessages: () => Promise.resolve([]),
    latestDiagnosis: () => Promise.resolve(null),
  };

  const writes: ChatWriteStore = {
    insertTurn: (turnRows) =>
      Promise.resolve([
        messageRowFor(turnRows[0], FARMER_MESSAGE_ID),
        messageRowFor(turnRows[1], ANSWER_MESSAGE_ID),
      ]),
    insertUsageLog: (row) => {
      rows.push(row);
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
    ...(caseId === 'chat_burst_refused' && options.nested !== true ? { burst: refusingBurst } : {}),
    quota: {
      rpc: counterRpc({ atLimit: caseId === 'chat_quota_declined' && options.nested !== true }),
      now: new Date(CLOCK_MS),
    },
    now: () => CLOCK_MS,
    platformDeadline: () => undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* voice                                                                       */
/* -------------------------------------------------------------------------- */

function voiceDeps(input: RunInput, rows: TablesInsert<'usage_logs'>[]): VoiceDeps {
  const { caseId, usedFallback } = input;

  const transcribe: Transcriber = () => {
    if (caseId === 'voice_transcription_failed') {
      return Promise.reject(providerFailure('PROVIDERS_UNAVAILABLE', usedFallback));
    }
    if (caseId === 'voice_budget_expired') {
      return Promise.reject(providerFailure('DIAGNOSIS_TIMEOUT', usedFallback));
    }
    const value: TranscriptionResult = {
      text: caseId === 'voice_empty_transcript' ? '   ' : IN_SCOPE_QUESTION,
      language: 'en',
      durationSeconds: 6.5,
      signals: { avgLogprob: -0.2, compressionRatio: 1.4, noSpeechProb: 0.8 },
      segments: [],
    };
    // V10 has one `transcribe` member, so `groq` is the only provider this row can name.
    return Promise.resolve({ value, provider: 'groq', usedFallback });
  };

  /**
   * The nested `ChatService` — the **real** `chatTurn`, so a served voice request produces the two
   * rows `usage-log.ts` says it must: one per operation.
   */
  const chat: ChatAnswerer = async (chatInput: ChatInput, coverage: QuotaContext) => {
    const result = await chatTurn(chatInput, chatDeps(input, rows, { nested: true }), coverage);
    const outcome: NestedChatOutcome = {
      conversationId: result.conversationId,
      farmerMessageId: result.farmerMessageId,
      answer: result.answer,
      quota: result.quota,
    };
    return outcome;
  };

  const store: VoiceStore = {
    insertUsageLog: (row) => {
      rows.push(row);
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
    ...(caseId === 'voice_burst_refused' ? { burst: refusingBurst } : {}),
    quota: { rpc: counterRpc({ atLimit: caseId === 'voice_quota_declined' }), now: new Date(CLOCK_MS) },
    now: () => CLOCK_MS,
    deadlineMs: CLOCK_MS + 45_000,
    platformDeadline: () => undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* the WhatsApp adapter's own two rows                                         */
/* -------------------------------------------------------------------------- */

interface InboundHarness {
  readonly deps: WhatsappDispatchDeps;
  readonly rows: TablesInsert<'usage_logs'>[];
  readonly stored: Map<string, { user_id: string | null; status: string; message_type: string }>;
}

function inboundHarness(
  input: RunInput,
  rows: TablesInsert<'usage_logs'>[],
  options: { readonly expired: boolean },
): InboundHarness {
  const stored = new Map<string, { user_id: string | null; status: string; message_type: string }>();

  const store: WhatsappInboundStore = {
    async insertReceived(row: InboundReceivedRow) {
      const wamid = row.provider_message_id;
      if (stored.has(wamid)) {
        return {
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        };
      }
      stored.set(wamid, { user_id: null, status: row.status, message_type: row.message_type });
      return { error: null };
    },
    async readExisting(providerMessageId: string) {
      const row = stored.get(providerMessageId);
      if (row === undefined) return { data: null, error: null };
      const existing: ExistingInbound = {
        user_id: row.user_id,
        status: row.status as ExistingInbound['status'],
        message_type: row.message_type,
      };
      return { data: existing, error: null };
    },
    async attachUser(providerMessageId: string, userId: string) {
      const row = stored.get(providerMessageId);
      if (row !== undefined) row.user_id = userId;
      return { error: null };
    },
    async transitionFromReceived(providerMessageId: string, status: TerminalInboundStatus) {
      const row = stored.get(providerMessageId);
      if (row === undefined || row.status !== 'received') return { data: [], error: null };
      row.status = status;
      return { data: [{ status }], error: null };
    },
    async insertUsageLog(row: TablesInsert<'usage_logs'>) {
      rows.push(row);
      return { error: null };
    },
  };

  const deps: WhatsappDispatchDeps = {
    supabase: { __jameePropertyClient: true } as unknown as NonNullable<
      WhatsappDispatchDeps['supabase']
    >,
    inbound: { store },
    usage: {
      insertUsageLog: async (row) => {
        rows.push(row);
      },
    },
    deadline: {
      // Expired: the pre-flight gate refuses before any media fetch, any service and any reserve.
      deadlineMs: options.expired ? CLOCK_MS - 1_000 : CLOCK_MS + 45_000,
      now: () => CLOCK_MS,
      platformDeadline: () => undefined,
    },
    profiles: {
      async byPhone() {
        return { data: { id: USER_ID, language: input.language }, error: null };
      },
    },
    conversations: {
      mostRecent: (userId, channel) => Promise.resolve(conversationFor(userId, channel)),
      create: (userId, channel) => Promise.resolve(conversationFor(userId, channel)),
    },
    media: async () => ({
      ok: true,
      ref: refFor(STORAGE_BUCKETS.cropImages, 'jpg'),
      kind: 'image',
      mimeType: 'image/jpeg',
      bytes: 120_000,
    }),
    diagnose: async (diagnoseInput) => ({
      diagnosisId: DIAGNOSIS_ID,
      conversationId: diagnoseInput.conversationId ?? CONVERSATION_ID,
      result: {
        status: 'identified',
        diseaseName: CONDITION,
        confidence: 0.86,
        severity: 'moderate',
        explanation: `${CONDITION} explanation`,
        knowledge: {
          symptoms: ['spots'],
          causes: ['fungus'],
          treatment: ['remove leaves'],
          prevention: ['rotate'],
          source: 'bulletin',
        },
        needsExpert: false,
        language: diagnoseInput.language,
      },
      quota: { operation: 'image', used: 1, limit: 20, resetsAt: '2026-09-16T18:30:00.000Z' },
      provider: input.provider,
      usedFallback: input.usedFallback,
    }),
    send: async (): Promise<SendReplyResult> => ({
      ok: true,
      sentMessageId: 'wamid.OUT001',
      bodyChars: 42,
    }),
  };

  return { deps, rows, stored };
}

function inboundMessage(wamid: string): InboundMessage {
  const content: InboundContent = { kind: 'image', mediaId: `media-${wamid}`, provisional: true };
  return {
    providerMessageId: wamid,
    fromPhone: '919876543210',
    timestamp: '1758000000',
    rawType: 'image',
    wabaId: '102290129340398',
    phoneNumberId: '106540352242922',
    displayPhoneNumber: '15550001111',
    content,
  };
}

/* -------------------------------------------------------------------------- */
/* The dispatcher                                                             */
/* -------------------------------------------------------------------------- */

/** Run one case and return the audit rows it produced, sorted by operation for a stable comparison. */
async function runCase(input: RunInput): Promise<readonly TablesInsert<'usage_logs'>[]> {
  const rows: TablesInsert<'usage_logs'>[] = [];
  const { caseId, channel, language } = input;

  if (caseId.startsWith('whatsapp_')) {
    const wamid = `wamid.PROPERTY${randomUUID().slice(0, 8)}`;
    const expired = caseId === 'whatsapp_preflight_budget_expired';
    const harness = inboundHarness(input, rows, { expired });

    await processInboundBatch([inboundMessage(wamid)], harness.deps);

    if (caseId === 'whatsapp_redelivery_ignored') {
      // The first delivery is the setup: it attaches the farmer, which is what makes the
      // redelivery's row attributable. Only the second delivery's rows are the case's.
      rows.length = 0;
      await processInboundBatch([inboundMessage(wamid)], harness.deps);
    }
    return sorted(rows);
  }

  const attempt = async (): Promise<void> => {
    if (caseId.startsWith('image_')) {
      await diagnose(
        {
          userId: USER_ID,
          storageRef: refFor(STORAGE_BUCKETS.cropImages, 'jpg'),
          language,
          channel,
          conversationId: CONVERSATION_ID,
        },
        diagnosisDeps(input, rows),
      );
      return;
    }
    if (caseId.startsWith('chat_')) {
      await chatTurn(
        {
          userId: USER_ID,
          conversationId: CONVERSATION_ID,
          message: caseId === 'chat_referral' ? OUT_OF_SCOPE_QUESTION : IN_SCOPE_QUESTION,
          language,
          channel,
          inputKind: 'text',
        },
        chatDeps(input, rows),
      );
      return;
    }
    await transcribeAndAnswer(
      {
        userId: USER_ID,
        storageRef: refFor(STORAGE_BUCKETS.voiceMessages, 'ogg'),
        language,
        channel,
        conversationId: CONVERSATION_ID,
        durationSeconds: 6.5,
        mimeType: 'audio/ogg',
        bytes: 90_000,
      },
      voiceDeps(input, rows),
    );
  };

  try {
    await attempt();
  } catch (error) {
    // Every failing case here is a coded failure whose row is written before it propagates. An
    // uncoded throw is a defect in this harness, not an outcome, so it is re-raised.
    if (!isAppError(error)) throw error;
  }

  return sorted(rows);
}

function sorted(
  rows: readonly TablesInsert<'usage_logs'>[],
): readonly TablesInsert<'usage_logs'>[] {
  return [...rows].sort((left, right) => left.operation.localeCompare(right.operation));
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const runArb: fc.Arbitrary<RunInput> = fc
  .record({
    caseId: fc.constantFrom<CaseId>(...CASES),
    language: fc.constantFrom<Language>('en', 'hi', 'mr'),
    usedFallback: fc.boolean(),
    provider: fc.constantFrom<'gemini' | 'groq'>('gemini', 'groq'),
    channelIndex: fc.nat({ max: 1 }),
  })
  .map(({ caseId, language, usedFallback, provider, channelIndex }) => {
    const channels = channelsFor(caseId);
    return {
      caseId,
      language,
      usedFallback,
      provider,
      channel: channels[channelIndex % channels.length] as Channel,
    };
  });

beforeAll(() => {
  // The services log defects (a missing knowledge row, a failed touch) and the pipeline logs every
  // decision. Silenced rather than asserted: the unit tests own the log content.
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

/* ========================================================================== */
/* The facts the property rests on                                             */
/* ========================================================================== */

describe('the column list Property 22 is asserted against, derived from the row builder', () => {
  it('requires every fact Requirements 14.6 and 14.7 name', () => {
    for (const [fact, column] of Object.entries(REQUIREMENT_14_6_COLUMNS)) {
      expect(ALL_COLUMNS, `14.6 names ${fact}`).toContain(column);
      expect(REQUIRED_COLUMNS, `14.6's ${fact} may not be null`).toContain(column);
    }
    expect(REQUIRED_COLUMNS, '14.7 names the fallback').toContain(REQUIREMENT_14_7_COLUMN);

    /** And the builder writes more than the required set, so `ALL_COLUMNS` is the wider claim. */
    expect(ALL_COLUMNS.length).toBeGreaterThan(REQUIRED_COLUMNS.length);
    /** The three columns a caller may legitimately leave empty, and nothing else. */
    expect(ALL_COLUMNS.filter((column) => !REQUIRED_COLUMNS.includes(column)).sort()).toStrictEqual([
      'conversation_id',
      'diagnosis_id',
      'rejection_reason',
    ]);
  });
});

/* ========================================================================== */
/* Property 22                                                                 */
/* ========================================================================== */

describe('Property 22: every audited operation leaves one complete row', () => {
  it('writes exactly one complete row per operation, on every path and every outcome', async () => {
    const exercised = new Set<CaseId>();
    const outcomes = new Set<UsageOutcome>();
    const providers = new Set<string>();
    const fallbacks = new Set<boolean>();
    const channels = new Set<Channel>();
    const operations = new Set<Operation>();

    await fc.assert(
      fc.asyncProperty(runArb, async (input) => {
        const { caseId, channel, usedFallback } = input;
        const label = `${caseId} / ${channel} / fallback=${String(usedFallback)}`;
        exercised.add(caseId);
        channels.add(channel);

        const expected = [...EXPECTED[caseId]].sort((left, right) =>
          left.operation.localeCompare(right.operation),
        );

        const rows = await runCase(input);

        /** The interesting failure: a path that writes no row, or writes more than its operations. */
        expect(rows.length, `${label} wrote the wrong number of rows`).toBe(expected.length);

        rows.forEach((row, index) => {
          const wanted = expected[index] as ExpectedRow;
          const rowLabel = `${label} [${wanted.operation}]`;

          /* ── Completeness, from the derived column sets ─────────────────────── */
          assertComplete(row, rowLabel);

          /* ── Requirement 14.6's five facts, each carrying the right value ───── */
          expect(row.user_id, rowLabel).toBe(USER_ID);
          expect(row.operation, rowLabel).toBe(wanted.operation);
          expect(row.channel, rowLabel).toBe(channel);
          expect(row.model_provider, rowLabel).toBe(
            wanted.provider === 'request' ? input.provider : wanted.provider,
          );
          expect(row.outcome, rowLabel).toBe(wanted.outcome);

          /* ── Requirement 14.7, in both directions ──────────────────────────── */
          expect(row.used_fallback, rowLabel).toBe(
            wanted.carriesRequestFallback ? usedFallback : false,
          );

          /* ── The spend rule, and Requirement 5.7's reason where there is one ── */
          expect(row.quota_spent, rowLabel).toBe(wanted.quotaSpent);
          expect(row.rejection_reason ?? null, rowLabel).toBe(wanted.rejectionReason);

          /** The outcome value is in the vocabulary the migration constrains. */
          expect(usageOutcomeSchema.safeParse(row.outcome).success, rowLabel).toBe(true);

          outcomes.add(row.outcome as UsageOutcome);
          providers.add(String(row.model_provider));
          fallbacks.add(row.used_fallback === true);
          operations.add(row.operation as Operation);
        });
      }),
      { numRuns: 400 },
    );

    /* ── Non-vacuity ─────────────────────────────────────────────────────────── */
    expect([...exercised].sort()).toStrictEqual([...CASES].sort());
    /**
     * The strongest guard available: **every** value the audit vocabulary can hold was produced by a
     * real path in this run. A value added to `usageOutcomeSchema` with no path that writes it — or a
     * path that stopped writing one — fails here.
     */
    expect([...outcomes].sort()).toStrictEqual([...usageOutcomeSchema.options].sort());
    expect([...providers].sort()).toStrictEqual(['gemini', 'groq', 'none']);
    expect([...fallbacks].sort()).toStrictEqual([false, true]);
    expect([...channels].sort()).toStrictEqual(['web', 'whatsapp']);
    expect([...operations].sort()).toStrictEqual(['chat', 'image', 'voice']);
  });

  it('records the fallback on the row of the call that used it, not on its neighbour', async () => {
    /**
     * Requirement 14.7 read at the resolution `usage-log.ts` argues for: a voice request is two
     * operations, and each row carries **its own** call's flag. So a transcription served by a
     * fallback member and an answer served by the primary must not report the same thing — ORing the
     * two would claim a fallback on a call that did not use one.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          language: fc.constantFrom<Language>('en', 'hi', 'mr'),
          channel: fc.constantFrom<Channel>('web', 'whatsapp'),
          transcriptionFellBack: fc.boolean(),
        }),
        async ({ language, channel, transcriptionFellBack }) => {
          const rows: TablesInsert<'usage_logs'>[] = [];
          const input: RunInput = {
            caseId: 'voice_served_with_nested_chat',
            channel,
            language,
            usedFallback: transcriptionFellBack,
            provider: 'gemini',
          };

          const deps = voiceDeps(input, rows);
          const transcribe: Transcriber = () => {
            const value: TranscriptionResult = {
              text: IN_SCOPE_QUESTION,
              language: 'en',
              durationSeconds: 6.5,
              signals: { avgLogprob: -0.2, compressionRatio: 1.4, noSpeechProb: 0.02 },
              segments: [],
            };
            return Promise.resolve({
              value,
              provider: 'groq',
              usedFallback: transcriptionFellBack,
            });
          };

          /** The nested answer never falls back, whatever the transcription did. */
          const nestedRows: TablesInsert<'usage_logs'>[] = rows;
          const chat: ChatAnswerer = async (chatInput, coverage) => {
            const result = await chatTurn(
              chatInput,
              chatDeps(
                { ...input, usedFallback: false },
                nestedRows,
                { nested: true },
              ),
              coverage,
            );
            return {
              conversationId: result.conversationId,
              farmerMessageId: result.farmerMessageId,
              answer: result.answer,
              quota: result.quota,
            };
          };

          await transcribeAndAnswer(
            {
              userId: USER_ID,
              storageRef: refFor(STORAGE_BUCKETS.voiceMessages, 'ogg'),
              language,
              channel,
              conversationId: CONVERSATION_ID,
              durationSeconds: 6.5,
              mimeType: 'audio/ogg',
              bytes: 90_000,
            },
            { ...deps, transcribe, chat },
          );

          const byOperation = new Map(rows.map((row) => [row.operation, row]));
          expect(byOperation.size).toBe(2);
          expect(byOperation.get('voice')?.used_fallback).toBe(transcriptionFellBack);
          expect(byOperation.get('chat')?.used_fallback).toBe(false);

          for (const row of rows) assertComplete(row, `voice pair / ${row.operation}`);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('reserves exactly one unit for a voice request that produced two audit rows', async () => {
    /**
     * The other half of "one request is not always one row": two rows, one reserve. Both rows report
     * `quota_spent: true` — each really attempted a provider call — so reconciling `usage_logs`
     * against `counters` is a comparison per request, which is the rule `usage-log.ts` states and the
     * reason this is asserted next to the row count rather than left implicit.
     */
    const rows: TablesInsert<'usage_logs'>[] = [];
    let increments = 0;

    const rpc: CounterRpc = {
      tryIncrement: () => {
        increments += 1;
        return Promise.resolve(1);
      },
      decrement: () => Promise.resolve(0),
      used: () => Promise.resolve(0),
    };

    const input: RunInput = {
      caseId: 'voice_served_with_nested_chat',
      channel: 'whatsapp',
      language: 'en',
      usedFallback: false,
      provider: 'gemini',
    };

    const base = voiceDeps(input, rows);
    const chat: ChatAnswerer = async (chatInput, coverage) => {
      const result = await chatTurn(
        chatInput,
        { ...chatDeps(input, rows, { nested: true }), quota: { rpc, now: new Date(CLOCK_MS) } },
        coverage,
      );
      return {
        conversationId: result.conversationId,
        farmerMessageId: result.farmerMessageId,
        answer: result.answer,
        quota: result.quota,
      };
    };

    await transcribeAndAnswer(
      {
        userId: USER_ID,
        storageRef: refFor(STORAGE_BUCKETS.voiceMessages, 'ogg'),
        language: 'en',
        channel: 'whatsapp',
        conversationId: CONVERSATION_ID,
        durationSeconds: 6.5,
        mimeType: 'audio/ogg',
        bytes: 90_000,
      },
      { ...base, chat, quota: { rpc, now: new Date(CLOCK_MS) } },
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.operation).sort()).toStrictEqual(['chat', 'voice']);
    expect(rows.every((row) => row.quota_spent === true)).toBe(true);
    expect(increments, 'one voice request must reserve exactly one unit').toBe(1);
    for (const row of rows) assertComplete(row, `one reserve / ${row.operation}`);
  });
});
