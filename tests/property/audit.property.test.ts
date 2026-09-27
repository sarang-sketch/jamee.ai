import { Buffer } from 'node:buffer';

import * as fc from 'fast-check';
import { ObjectId, type WithId } from 'mongodb';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { CapabilityRunner } from '@/lib/ai/capabilities';
import type { MessageDoc } from '@/lib/db/collections';
import { usageLogRow, type UsageFacts, type UsageLogInsert } from '@/lib/db/usage-log';
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
  type MediaRef,
  type Operation,
  type UsageOutcome,
  type VerifiedCondition,
} from '@/lib/schemas';
import {
  chatTurn,
  type ChatTurnDeps,
  type ChatWriteStore,
  type ContextStore,
  type MessageInsert,
} from '@/services/chat.service';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import { diagnose, type DiagnosisDeps, type DiagnosisStore } from '@/services/diagnosis.service';
import type { CounterRpc, QuotaContext } from '@/services/quota.service';
import {
  transcribeAndAnswer,
  type ChatAnswerer,
  type MediaRemover,
  type NestedChatOutcome,
  type Transcriber,
  type VoiceDeps,
  type VoiceStore,
} from '@/services/voice.service';

/**
 * **Property 22: Every model operation leaves a complete audit row**
 *
 * > For any completed model operation, exactly one usage log row records the farmer identifier, the
 * > operation type, the channel, the model provider used, and the outcome; and whenever the gateway
 * > served the request from the fallback provider, that row records the fallback.
 *
 * **Validates: Requirements 14.6, 14.7**
 *
 * ### Amendment A1–A3 — restated for the MongoDB/GridFS substrate and the web + telegram channels
 *
 * Under Amendment A1 the WhatsApp channel and every WhatsApp module were removed (`channelSchema`
 * is `web | telegram` only), so this property no longer drives `processInboundBatch` or the
 * WhatsApp adapter's own two audit rows. Those two cases produced the `duplicate_ignored` outcome
 * (a platform redelivery, Requirement 11.5) and a pre-flight soft-deadline `timeout`; the Telegram
 * inbound path (`src/lib/telegram-dispatch.ts`, owned by a Telegram-side worker) is now what writes
 * a `duplicate_ignored` row, so that outcome is asserted **there** rather than here. The
 * non-vacuity guard below therefore checks the diagnosis/chat/voice services' own outcome set,
 * which is every value the vocabulary can hold **except** `duplicate_ignored` — see the guard for
 * why that exclusion is stated rather than silently narrowed.
 *
 * Under Amendment A3 the services read image and audio bytes from GridFS through the
 * Data_Access_Layer (the `readMedia` seam) rather than minting a Supabase signed URL, and persist
 * through the owner-scoped accessors — so the harness below injects `readMedia` and the wire-shaped
 * `UsageLogInsert` writer, and there is no Supabase client, no storage bucket, and no signed-URL
 * seam.
 *
 * ### The column list is read out of the source, not copied into this file
 *
 * `usageLogRow()` in `src/lib/db/usage-log.ts` is the one row builder every audit write goes through,
 * and it writes **every** column on **every** row — explicit `null` rather than an omitted key, so a
 * default can never stand in for a decision. Both column sets below are derived by calling it:
 *
 *  - `ALL_COLUMNS` — the keys it produces. Every row observed in this file must have exactly these
 *    keys, so a call site that hand-built a row and forgot one fails here, and a column added to the
 *    builder later is covered with no edit to this test.
 *  - `REQUIRED_COLUMNS` — the keys that are non-null when only `UsageFacts`'s **required** fields are
 *    supplied. That is the module's own type discipline read as data: a fact a caller may omit comes
 *    out `null`, and a fact it cannot omit comes out with a value.
 *
 * ### Every operation kind and every reachable outcome, on real service paths
 *
 * The cases drive the **real** services — `diagnose()`, `chatTurn()`, `transcribeAndAnswer()` — one
 * per audited path, including the ones that are not model successes: the served answer on all three
 * operations; the four ways an answer degrades (a stage-1 rejection, a refused rephrase, an
 * exhausted chain, an expired budget); the two honest non-answers (an unclear photo, an empty
 * transcript); the referral, which reaches no provider and refunds; a pre-provider media-read
 * failure, which is spent-nothing; and both refusals — the daily decline (14.3) and the burst
 * refusal (13.8, migration `0011`).
 *
 * ### Requirement 14.7 is asserted in both directions
 *
 * The fallback flag is generated, and the same case is run with it `false` and `true`; a row for a
 * path that reached the gateway must carry the generated value, and a row for a path that reached no
 * provider at all must carry `false`.
 *
 * ### One request is not always one row
 *
 * A diagnosis (two gateway calls, one operation) is one row; a voice request (transcription plus the
 * nested chat answer, two operations) is **two**. The voice success case runs the **real** `chatTurn`
 * as its nested service and asserts two complete rows — a `voice` row and a `chat` row — against a
 * single reserved unit.
 */

/* ========================================================================== */
/* The column sets, derived from the one row builder                           */
/* ========================================================================== */

const USER_ID = '8e2c4a6b-1d3f-4e5a-8b7c-9d0e1f2a3b4c';
const CONVERSATION_ID = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
const DIAGNOSIS_ID = 'c2d3e4f5-a6b7-4c8d-8e9f-1a2b3c4d5e6f';

/** A stored `messages` `_id` per role, as ObjectId hex — the shape `insertTurn` returns now. */
const FARMER_MESSAGE_OID = new ObjectId();
const ANSWER_MESSAGE_OID = new ObjectId();

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

function columnOf(row: UsageLogInsert, column: string): unknown {
  return (row as unknown as Record<string, unknown>)[column];
}

/**
 * The completeness assertion, applied to every row this file observes.
 *
 * Two halves: the key set is exactly the builder's (so nothing was omitted and no default was
 * relied on), and every column that cannot legitimately be null carries a value.
 */
function assertComplete(row: UsageLogInsert, label: string): void {
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

/** A3: the crop image and the recording are `{ fileId, kind }` Media_References, not storage paths. */
const IMAGE_REF: MediaRef = { fileId: 'a'.repeat(24), kind: 'crop-image' };
const AUDIO_REF: MediaRef = { fileId: 'c'.repeat(24), kind: 'voice' };

/** The bytes the owner-checked reads yield, and their stored MIME types. */
const IMAGE_BYTES = Buffer.from('jamee property harness: fake crop-image bytes');
const AUDIO_BYTES = Buffer.from('jamee property harness: fake voice bytes');

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

/**
 * A stored `messages` record, as the owner-scoped `insertChatTurn` returns it — a `WithId<MessageDoc>`
 * whose `_id` is an ObjectId and whose `transcriptOf` is a `MediaRefDoc` or `null`. The chat write
 * seam takes the string-shaped `MessageInsert` and returns this document shape.
 */
function messageRecordFor(row: MessageInsert, id: ObjectId): WithId<MessageDoc> {
  return {
    _id: id,
    ownerId: row.ownerId,
    // The record's `conversationId` is not asserted here; a fresh ObjectId keeps this tolerant of a
    // non-ObjectId conversation id in the input row (the input carries the request's own id shape).
    conversationId: ObjectId.isValid(row.conversationId)
      ? new ObjectId(row.conversationId)
      : new ObjectId(),
    role: row.role,
    content: row.content,
    language: row.language,
    channel: row.channel,
    inputKind: row.inputKind,
    transcriptOf:
      row.transcriptOf === undefined
        ? null
        : { fileId: new ObjectId(row.transcriptOf.fileId), kind: row.transcriptOf.kind },
    createdAt: new Date(CLOCK_MS),
  };
}

/** The owner-checked media read seam — yields the bytes the model is sent inline (A3, V34). */
function readMediaOf(bytes: Buffer, mimeType: string) {
  return (): Promise<{ bytes: Buffer; mimeType: string }> => Promise.resolve({ bytes, mimeType });
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

/** The owner-scoped media delete seam voice uses; here it always removes. */
const removeStub: MediaRemover = () => Promise.resolve(true);

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
  'image_media_read_failed',
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
  // A3: the owner-checked media read returns `null` for a foreign/missing file, and the service
  // throws `STORAGE_REF_FORBIDDEN` BEFORE the reserve and before any audit write — so this path
  // writes no row at all (the pre-A3 signed-URL failure wrote a `provider_error` row because it
  // happened after the reserve; there is no signed-URL mint under A3).
  image_media_read_failed: [],
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
};

/** Both service channels are exercised for every case. */
const CASE_CHANNELS: readonly Channel[] = ['web', 'telegram'];

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

function diagnosisDeps(input: RunInput, rows: UsageLogInsert[]): DiagnosisDeps {
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
    insertDiagnosis: () => Promise.resolve(DIAGNOSIS_ID),
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

  // A3: a foreign/missing file is one `null`, which the service maps to STORAGE_REF_FORBIDDEN
  // before the reserve. Only the media-read-failed case returns `null`.
  const readMedia = (): Promise<{ bytes: Buffer; mimeType: string } | null> =>
    Promise.resolve(
      caseId === 'image_media_read_failed' ? null : { bytes: IMAGE_BYTES, mimeType: 'image/jpeg' },
    );

  return {
    store,
    readMedia,
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
  rows: UsageLogInsert[],
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
        messageRecordFor(turnRows[0], FARMER_MESSAGE_OID),
        messageRecordFor(turnRows[1], ANSWER_MESSAGE_OID),
      ]),
    insertUsageLog: (row) => {
      rows.push(row);
      return Promise.resolve();
    },
    ownsConversation: () => Promise.resolve(true),
    touchConversation: () => Promise.resolve(true),
  };

  return {
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

function voiceDeps(input: RunInput, rows: UsageLogInsert[]): VoiceDeps {
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

  return {
    chat,
    readMedia: readMediaOf(AUDIO_BYTES, 'audio/ogg'),
    remove: removeStub,
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
/* The dispatcher                                                             */
/* -------------------------------------------------------------------------- */

/** Run one case and return the audit rows it produced, sorted by operation for a stable comparison. */
async function runCase(input: RunInput): Promise<readonly UsageLogInsert[]> {
  const rows: UsageLogInsert[] = [];
  const { caseId, channel, language } = input;

  const attempt = async (): Promise<void> => {
    if (caseId.startsWith('image_')) {
      await diagnose(
        {
          userId: USER_ID,
          image: IMAGE_REF,
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
        audio: AUDIO_REF,
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

function sorted(rows: readonly UsageLogInsert[]): readonly UsageLogInsert[] {
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
    const channels = CASE_CHANNELS;
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
     * Every value the audit vocabulary can hold was produced by a real service path in this run —
     * EXCEPT `duplicate_ignored`. That outcome is a platform redelivery (Requirement 11.5), which
     * under Amendment A1 is written by the Telegram inbound path (`src/lib/telegram-dispatch.ts`,
     * owned by a Telegram-side worker) rather than by any of the three services this file drives.
     * Asserting the diagnosis/chat/voice services produce exactly the rest of the vocabulary keeps
     * the guard strong — a value added to the schema with no path that writes it still fails here —
     * while stating the one exclusion the A1 channel change made rather than silently narrowing it.
     */
    const SERVICE_OUTCOMES = usageOutcomeSchema.options.filter(
      (outcome) => outcome !== 'duplicate_ignored',
    );
    expect([...outcomes].sort()).toStrictEqual([...SERVICE_OUTCOMES].sort());
    expect([...providers].sort()).toStrictEqual(['gemini', 'groq', 'none']);
    expect([...fallbacks].sort()).toStrictEqual([false, true]);
    expect([...channels].sort()).toStrictEqual(['telegram', 'web']);
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
          channel: fc.constantFrom<Channel>('web', 'telegram'),
          transcriptionFellBack: fc.boolean(),
        }),
        async ({ language, channel, transcriptionFellBack }) => {
          const rows: UsageLogInsert[] = [];
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
          const nestedRows: UsageLogInsert[] = rows;
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
              audio: AUDIO_REF,
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
    const rows: UsageLogInsert[] = [];
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
      channel: 'telegram',
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
        audio: AUDIO_REF,
        language: 'en',
        channel: 'telegram',
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
