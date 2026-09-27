import 'server-only';

import { Buffer } from 'node:buffer';

import { getDeadline } from '@vercel/functions';

import {
  computeDeadline,
  run,
  type GatewayResult,
  type ProviderId,
  type RunOptions,
} from '@/lib/ai/gateway';
import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  TRANSCRIBE_ACCEPTED_CONTAINERS,
  TRANSCRIBE_MIN_SECONDS,
} from '@/lib/config/verified';
import { readMediaBytesForOwner } from '@/lib/db/analysis';
import {
  usageLogWriterFrom,
  writeUsageLog,
  type UsageFacts,
  type UsageLogWriter,
} from '@/lib/db/usage-log';
import { AppError, isAppError } from '@/lib/errors';
import {
  groqTranscribeMember,
  isAcceptedAudioContainer,
  type GroqTranscribeOptions,
  type TranscribeRequest,
  type TranscriptionResult,
} from '@/lib/groq';
import { removeMediaForOwner } from '@/lib/media';
import { noBurstCheck, type BurstCheck } from '@/lib/rate-limit';
import type {
  ChatAnswer,
  ChatInput,
  MediaRef,
  Operation,
  QuotaStatus,
  VoiceInput,
} from '@/lib/schemas';
import {
  coveredBy,
  ownsRequest,
  quotaExceededError,
  quotaStatusOf,
  reserveForRequest,
  type QuotaContext,
  type QuotaOptions,
  type QuotaReservation,
} from '@/services/quota.service';

/**
 * The single voice implementation: transcribe a recording, answer it as a chat turn, return both.
 *
 * Requirements: 2.5, 2.6 (a recording's bytes are read only by the Farmer who owns it), 8.4 (a valid
 *               voice request is transcribed through the Transcription_Provider and the transcript is
 *               passed to the Chat_Service as a Farmer message), 8.6 (the transcript AND the text
 *               answer are both returned), 8.7 (an empty transcript asks the farmer to record again
 *               somewhere quieter), 8.8 (text answers only, no synthesized speech), 8.9 (the voice
 *               original is deleted once its transcript is persisted as a Message), 8.10 (a failed or
 *               empty transcript RETAINS the object until its Retention_Window elapses), 8.11
 *               (deletion happens only server-side through the Data_Access_Layer, and only for a file
 *               the requesting farmer owns), 14.1 (one voice message spends exactly one voice unit —
 *               never a voice unit and a chat unit), 16.5 (`channel` is an input parameter)
 * Design: D1 (amended — the analysis request carries a Media_Reference and no bytes), D17 (one
 *         GridFS bucket), D18 (the Data_Access_Layer is the isolation boundary), Amendment A3
 *         (the recording's bytes are read from GridFS and sent to the provider as `file`; deletion
 *         is `removeMediaForOwner`); "Media lifecycle and retention"; "Quota enforcement"
 * Depends on: V10 (the transcription model, containers and caps), V11 (error classification), V34
 *
 * =============================================================================
 * THE ORDER OF OPERATIONS IS THE CONTRACT
 * =============================================================================
 *
 * The same discipline `diagnosis.service.ts` states, with the voice steps in place of the image
 * ones. Each step satisfies its criterion *by being where it is*:
 *
 *  1. **Ownership + bytes** (`readMediaBytesForOwner` on the `voice` reference) — Requirements 2.5,
 *     2.6. The owner-scoped read proves ownership AND yields the bytes; a foreign or missing
 *     recording is one `null`, mapped to `STORAGE_REF_FORBIDDEN` (403) BEFORE the reserve, so it
 *     costs nothing. There is no signed URL under A3 — the bytes are the input to transcription.
 *  2. **Audio admission** — Requirement 8.3's duration rule and V10's container list, re-checked
 *     here because the Telegram path never passes through `voiceRequestSchema`. Also before the
 *     reserve: a recording Jamee will not transcribe costs no unit.
 *  3. **Burst check** — Requirement 13.8. One `voice` minute slot; the nested chat answer at step 7
 *     takes none, because it is covered.
 *  4. **Quota reserve** — Requirements 14.1–14.3. An at-limit farmer is declined here and **no
 *     provider is called**.
 *  5. **`transcribe`** — Requirement 8.4, with the bytes sent as the `file` parameter (V34). From
 *     this instant the unit is spent, whatever follows.
 *  6. **The empty-transcript branch** — Requirement 8.7. No chat call, no answer, object retained.
 *  7. **The nested chat call** — Requirement 8.4, reserving **nothing** (see below). It persists the
 *     farmer message and the answer, and returns the farmer message id.
 *  8. **Delete the original** — Requirement 8.9, and only now: the message id from step 7 is the
 *     evidence that the transcript is durable.
 *  9. **Usage log** — Requirements 14.6, 14.7.
 *
 * =============================================================================
 * THE NESTING RULE (REQUIREMENT 14.1)
 * =============================================================================
 *
 * **The nested `ChatService` call performs no reserve of its own.** The voice unit taken at step 4
 * covers the answer this request produces, so one voice message never spends both a voice unit and a
 * chat unit. `coveredBy(reservation)` is the load-bearing mechanism (a `QuotaReservation` is branded
 * and unforgeable, and `reserveForRequest()` on a covered context performs no RPC); `ChatInput.
 * skipQuotaReserve: true` is the same fact in boolean form for contract fidelity, mapped once at the
 * top of `ChatService`. The reservation travels alongside the input through `ChatAnswerer`'s second
 * parameter. **This call's shape is unchanged from the pre-A3 version** — the chat service is owned
 * by another worker, and voice hands it the same `(ChatInput, QuotaContext)` pair.
 *
 * =============================================================================
 * DELETION: ONE BICONDITIONAL, THROUGH THE DATA_ACCESS_LAYER
 * =============================================================================
 *
 * *A voice object is absent if and only if a transcript message exists for it.*
 *
 *  - **Success (8.9)** — the transcript is a `messages` row with `inputKind = 'voice'`, nothing reads
 *    a recording back (8.8 rules out synthesized speech), so the object has no reader and goes
 *    immediately, through `removeMediaForOwner` (D18: the delete is owner-scoped by the layer, which
 *    is Requirement 8.11's "only for a file the requesting farmer owns" made structural — a
 *    non-owner's or an already-absent file both return `false` without error).
 *  - **Transcription failed (8.10)** — retained. `TRANSCRIPTION_FAILED` is 502 retryable over the
 *    same object; deleting it would make that flag a lie.
 *  - **Empty transcript (8.10)** — retained too, for the reasons the design gives: it keeps the rule
 *    one testable biconditional, and `no_speech_prob` can mark an empty transcript a provider
 *    artefact worth keeping for the retention window.
 *
 * The retention sweep is the collector for both retained cases.
 *
 * =============================================================================
 * WHY THIS SERVICE HOLDS NO CLIENT (Amendment A3)
 * =============================================================================
 *
 * Farmer isolation is the Data_Access_Layer (D18). Reads and writes go through owner-scoped
 * accessors — the audit row through `usageLogWriterFrom()`, the recording's bytes and its deletion
 * through `src/lib/media` (`readMediaBytesForOwner` / `removeMediaForOwner`, which delegate to the
 * GridFS store in `src/lib/db/media`) — and no client is a parameter. The delete runs only through
 * the owner-scoped layer accessor, so "only server-side, only the owner's file" holds by
 * construction and `deleteVoiceOriginal` is a thin wrapper over it. This module stays `server-only`.
 */

/** This service reserves, and audits, exactly one operation type. */
const OPERATION: Operation = 'voice';

/* ========================================================================== */
/* Step 5's seam — transcription                                               */
/* ========================================================================== */

/**
 * The `transcribe` capability as one injectable function.
 *
 * A local seam rather than a third method on `CapabilityRunner` (`ai/capabilities.ts`), because that
 * module reconciles *two* provider surfaces and `transcribe` has one member by design. A unit test
 * stubs one function at the gateway boundary and can assert "no chat call was issued after an empty
 * transcript" directly.
 */
export type Transcriber = (
  request: TranscribeRequest,
  options?: RunOptions,
) => Promise<GatewayResult<TranscriptionResult>>;

/**
 * The production transcriber: the real gateway over the sole `transcribe` member. The adapter holds
 * no client (`groq.ts` resolves its SDK call at invoke time), so constructing this reads no
 * environment variable and touches no network.
 */
export function gatewayTranscriber(options: GroqTranscribeOptions = {}): Transcriber {
  const adapters = groqTranscribeMember(options);
  return (request, runOptions = {}) => run('transcribe', adapters, request, runOptions);
}

/* ========================================================================== */
/* Step 7's seam — the nested ChatService call                                 */
/* ========================================================================== */

/**
 * What the nested chat call returns. Exactly `chatResponseSchema`'s four fields, so the real
 * `ChatService` entry point satisfies this without an adapter.
 */
export interface NestedChatOutcome {
  readonly conversationId: string;
  /**
   * The persisted farmer message. **This id is Requirement 8.9's precondition** — "WHEN the
   * API_Layer has persisted a transcript as a Message" is the trigger for deleting the recording,
   * and this is the only evidence this service has that the row exists.
   */
  readonly farmerMessageId: string;
  readonly answer: ChatAnswer;
  readonly quota: QuotaStatus;
}

/**
 * `ChatService`, as this service needs it. Owned by another worker; this service depends only on the
 * two-parameter shape. `coverage` is a second parameter rather than a field of `ChatInput` because a
 * `QuotaReservation` is branded and unforgeable, and it has to *travel* for the nesting rule to hold.
 */
export type ChatAnswerer = (
  input: ChatInput,
  coverage: QuotaContext,
) => Promise<NestedChatOutcome>;

/* ========================================================================== */
/* Step 8 — deletion (Requirements 8.9, 8.11)                                  */
/* ========================================================================== */

/**
 * The owner-scoped media delete this service uses. Defaults to `removeMediaForOwner` from
 * `src/lib/media`, a seam so a unit test can assert the delete happened (or did not) without a
 * GridFS store. Returns whether a file was removed; a non-owner's attempt and an already-absent file
 * both return `false` (the idempotence Requirement 18.10 and a double-submit both rely on).
 */
export type MediaRemover = (ownerId: string, fileId: string) => Promise<boolean>;

/**
 * What happened to the recording. Reported rather than thrown, in every variant: by the time a
 * deletion runs, the farmer has an answer and the transcript is committed, so turning a retention
 * problem into HTTP 500 would cost them a retry and another quota unit for something they cannot act
 * on. The sweep is the backstop for every non-`deleted` outcome, and each is logged server-side.
 */
export type VoiceObjectDisposition =
  /** Requirement 8.9 — the transcript is durable and the original is gone. */
  | { readonly outcome: 'deleted' }
  /**
   * Requirement 8.10 — no transcript was persisted, so the object waits for its Retention_Window.
   * No delete was attempted.
   */
  | { readonly outcome: 'retained'; readonly reason: 'no_transcript_persisted' }
  /**
   * The delete ran and removed nothing: the file was already gone, or it is not this farmer's (the
   * owner-scoped delete makes those indistinguishable, Requirement 2.6). Idempotent, so
   * success-equivalent for the farmer; the sweep needs do nothing.
   */
  | { readonly outcome: 'already_absent' }
  /** The delete was attempted and the store threw. The sweep will retry. */
  | { readonly outcome: 'failed'; readonly reason: 'remove_failed' };

/**
 * Delete one `voice` recording after its transcript is durable, through the owner-scoped
 * Data_Access_Layer media delete (Requirements 8.9, 8.11).
 *
 * Requirement 8.11's two halves are both here, and both are the layer's rather than this function's:
 * the delete is server-side (this module is `server-only` and `removeMediaForOwner` is `server-only`),
 * and it is scoped to the owner (the GridFS filter carries `metadata.ownerId`, so a file that is not
 * this farmer's is never removed). There is no first-segment path comparison any more — under A3
 * there is no storage path, only a GridFS `fileId` whose owner the layer checks — so the pre-A3
 * `prefix_mismatch` / `ownership_unconfirmed` refusals collapse into `removeMediaForOwner` returning
 * `false`, reported here as `already_absent`.
 */
export async function deleteVoiceOriginal(
  ref: MediaRef,
  userId: string,
  remove: MediaRemover = removeMediaForOwner,
): Promise<VoiceObjectDisposition> {
  try {
    const removed = await remove(userId, ref.fileId);
    if (removed) return { outcome: 'deleted' };
    // Not owned, or already gone — indistinguishable and both idempotent. Logged so a foreign
    // reference reaching here (it should not: step 1 already read the bytes as the owner) is visible.
    console.error(
      '[jamee] voice_delete_absent',
      JSON.stringify({ fileId: ref.fileId, requestedBy: userId }),
    );
    return { outcome: 'already_absent' };
  } catch (cause) {
    console.error(
      '[jamee] voice_delete_failed',
      JSON.stringify({ fileId: ref.fileId, requestedBy: userId }),
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
    );
    return { outcome: 'failed', reason: 'remove_failed' };
  }
}

/* ========================================================================== */
/* Step 9's seam — the audit row                                               */
/* ========================================================================== */

/** The audit write this service makes, over the owner-scoped Data_Access_Layer. Append-only (D10). */
export type VoiceStore = UsageLogWriter;

/**
 * The Data_Access_Layer-backed audit writer. The row is reachable only through the owner-scoped
 * `FarmerData.insertUsageLog` (D18), so this takes no client — the layer is the boundary — and
 * simply returns `usageLogWriterFrom()`. "Append-only" is structural: there is no code path to a
 * `usage_logs` update or delete.
 */
export function voiceStoreFrom(): VoiceStore {
  return usageLogWriterFrom();
}

/* ========================================================================== */
/* Dependencies and the outcome                                                */
/* ========================================================================== */

export interface VoiceDeps {
  /** `ChatService`. Required — owned by another worker, bound by the caller with its own budget. */
  readonly chat: ChatAnswerer;
  /**
   * The owner-checked media read. Defaults to `readMediaBytesForOwner` from `src/lib/db/analysis`.
   * A seam so a unit test can prove the pipeline order (foreign recording → no reserve) without GridFS.
   */
  readonly readMedia?: (userId: string, ref: MediaRef) => Promise<{ bytes: Buffer; mimeType: string } | null>;
  /** The owner-scoped media delete (Requirement 8.11). Defaults to `removeMediaForOwner`. */
  readonly remove?: MediaRemover;
  /** Defaults to `voiceStoreFrom()`, the owner-scoped audit writer. */
  readonly store?: VoiceStore;
  /** The transcription call. Defaults to the real gateway over the sole `transcribe` member. */
  readonly transcribe?: Transcriber;
  /**
   * Step 3, Requirement 13.8. `/api/voice` binds `burstLimiter()`, and binds **none** to `deps.chat`
   * — the nested answer is covered by this request's voice unit and burst slot. Default `noBurstCheck`.
   */
  readonly burst?: BurstCheck;
  /** The counter seam and the quota clock. Both default inside `quota.service.ts`. */
  readonly quota?: QuotaOptions;
  /** Injected clock, epoch ms. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** A deadline already computed for this request; otherwise derived once, here. */
  readonly deadlineMs?: number;
  /** Source of the platform deadline. Defaults to V18's `getDeadline()`. */
  readonly platformDeadline?: () => Date | undefined;
  /** The caller's abort, linked into the provider attempt. */
  readonly signal?: AbortSignal;
}

/**
 * What the caller gets back. The first four fields are exactly `voiceResponseSchema`, so the route
 * serializes them without reshaping — Requirement 8.6's "the transcript and the text answer" is that
 * pair being present together. `quota` is the **voice** status from this service's reservation, not
 * the nested chat's (which reserved nothing).
 */
export interface VoiceOutcome {
  /** The provider's transcript, verbatim. */
  readonly transcript: string;
  readonly answer: ChatAnswer;
  readonly conversationId: string;
  readonly quota: QuotaStatus;
  /** The persisted farmer message carrying the transcript (Requirement 7.4). */
  readonly farmerMessageId: string;
  /** Which provider transcribed. One member today (V10), so always `groq`. */
  readonly provider: ProviderId;
  /** True when a fallback member served any call in this request (Requirement 14.7). */
  readonly usedFallback: boolean;
  /** What happened to the recording (Requirements 8.9, 8.10, 8.11). */
  readonly audio: VoiceObjectDisposition;
}

/* ========================================================================== */
/* Step 2 — audio admission                                                    */
/* ========================================================================== */

/**
 * The container to declare to the provider: what the recorder actually produced (the media file's
 * stored MIME type, forwarded on `VoiceInput.mimeType`), or a bare `audio` fallback.
 *
 * Under A3 there is no storage path to read an extension from, so the MIME type is the only source —
 * it comes from the media file the browser uploaded (its `MediaRecorder.mimeType`, stored at the
 * Media_Endpoint) and re-stated on the request. When it is absent (a Telegram path that did not set
 * it), the read at step 1 also returns the stored MIME type, so the caller of `transcribeAndAnswer`
 * always has one to pass — see the pipeline, which prefers the request's `mimeType` and falls back to
 * the read's.
 */
export function audioContainerOf(mimeType: string | undefined): string {
  const declared = mimeType?.trim();
  return declared !== undefined && declared !== '' ? declared : 'audio';
}

/**
 * Refuse a recording Jamee or the provider will not transcribe — **before the reserve**, so it
 * spends nothing. Four checks; their codes are chosen rather than convenient (see `errors.ts`):
 * `AUDIO_TOO_LONG` (8.3), `FILE_TOO_LARGE` (8.2, only when a size is known), `TRANSCRIPT_EMPTY`
 * (below V10's minimum transcribable length), `AUDIO_FORMAT_UNSUPPORTED` (a container outside V10's
 * list — the AAC/AMR Telegram case in the module header of `groq.ts`).
 */
export function assertAdmissibleAudio(input: VoiceInput, container: string): void {
  const { durationSeconds, bytes } = input;

  if (durationSeconds > MAX_AUDIO_SECONDS) {
    throw new AppError('AUDIO_TOO_LONG', {
      context: { reason: 'duration_over_limit', durationSeconds, maxSeconds: MAX_AUDIO_SECONDS },
    });
  }

  if (bytes !== undefined && bytes > MAX_AUDIO_BYTES) {
    throw new AppError('FILE_TOO_LARGE', {
      details: { maxBytes: MAX_AUDIO_BYTES },
      context: { reason: 'size_over_limit', bytes, maxBytes: MAX_AUDIO_BYTES },
    });
  }

  if (durationSeconds < TRANSCRIBE_MIN_SECONDS) {
    throw new AppError('TRANSCRIPT_EMPTY', {
      context: {
        reason: 'below_minimum_transcribable_length',
        durationSeconds,
        minimumSeconds: TRANSCRIBE_MIN_SECONDS,
      },
    });
  }

  if (!isAcceptedAudioContainer(container)) {
    throw new AppError('AUDIO_FORMAT_UNSUPPORTED', {
      context: {
        reason: 'container_not_accepted',
        container,
        accepted: TRANSCRIBE_ACCEPTED_CONTAINERS,
      },
    });
  }
}

/* ========================================================================== */
/* The pipeline                                                                */
/* ========================================================================== */

/**
 * Transcribe one recording and answer it, returning both (Requirements 8.4, 8.6).
 *
 * The transcript is handed over VERBATIM: `result.text` reaches `ChatInput.message` and
 * `VoiceOutcome.transcript` exactly as the provider produced it. The trim below decides *whether*
 * there is a transcript (Requirement 8.7's own branch is the only place emptiness is judged); it
 * never becomes the transcript. Whitespace-only counts as empty — a transcript of spaces carries no
 * question, and sending it onward would spend a knowledge-base read and a model call to answer
 * nothing and persist a blank farmer message.
 */
export async function transcribeAndAnswer(
  input: VoiceInput,
  deps: VoiceDeps,
): Promise<VoiceOutcome> {
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const { userId, language, channel } = input;

  const transcribe = deps.transcribe ?? gatewayTranscriber();
  const burst = deps.burst ?? noBurstCheck;
  const quotaOptions: QuotaOptions = deps.quota ?? {};
  const store = deps.store ?? voiceStoreFrom();
  const readMedia = deps.readMedia ?? readMediaBytesForOwner;
  const remove = deps.remove ?? removeMediaForOwner;

  const deadlineMs =
    deps.deadlineMs ??
    voiceRequestDeadline({ requestStartMs: startedMs, platformDeadline: deps.platformDeadline });

  const runOptions: RunOptions = {
    deadlineMs,
    now,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  };

  /** The audit write, which never throws — see `writeUsageLog` in `src/lib/db/usage-log.ts`. */
  const log = async (facts: VoiceUsageFacts): Promise<void> => {
    await writeUsageLog(store, {
      userId,
      operation: OPERATION,
      channel,
      conversationId: input.conversationId,
      latencyMs: now() - startedMs,
      ...facts,
    });
  };

  // ── 1. Ownership + bytes (Requirements 2.5, 2.6) — nothing has been spent ──
  // The owner-scoped read proves ownership AND yields the bytes and the stored MIME type. A foreign
  // or missing recording is one `null` (Requirement 2.6), mapped to STORAGE_REF_FORBIDDEN (403)
  // BEFORE the reserve, so it costs no quota unit.
  const audio = await readMedia(userId, input.audio);
  if (audio === null) {
    throw new AppError('STORAGE_REF_FORBIDDEN', {
      context: { reason: 'recording_not_owned_or_missing', userId, fileId: input.audio.fileId },
    });
  }

  // ── 2. Audio admission (Requirement 8.3, V10) — still nothing spent ───────
  // The container to declare: the request's mimeType if it carried one, else the stored MIME type.
  const container = audioContainerOf(input.mimeType ?? audio.mimeType);
  assertAdmissibleAudio(input, container);

  // ── 3. Burst check (Requirement 13.8) — still nothing spent ───────────────
  try {
    await burst(userId, OPERATION);
  } catch (error) {
    if (isRateLimited(error)) {
      await log({ outcome: 'rate_limited', provider: 'none', usedFallback: false, quotaSpent: false });
    }
    throw error;
  }

  // ── 4. Reserve (Requirements 14.1–14.3) ───────────────────────────────────
  const reserved = await reserveForRequest(ownsRequest(userId, OPERATION), quotaOptions);
  if (reserved.outcome === 'at_limit') {
    await log({ outcome: 'quota_declined', provider: 'none', usedFallback: false, quotaSpent: false });
    throw quotaExceededError(reserved.status);
  }
  const reservation: QuotaReservation = reserved.reservation;
  const quota = quotaStatusOf(reservation);

  // ── 5. Transcription (Requirement 8.4) — the unit is now spent ────────────
  // Amendment A3, V34: the bytes read at step 1 go as the `file` parameter. There is no signed URL.
  const request: TranscribeRequest = {
    audioBytes: audio.bytes,
    container,
    language,
    durationSeconds: input.durationSeconds,
    ...(input.bytes === undefined ? { bytes: audio.bytes.byteLength } : { bytes: input.bytes }),
  };

  let transcribed: GatewayResult<TranscriptionResult>;
  try {
    transcribed = await transcribe(request, runOptions);
  } catch (error) {
    // Requirement 8.10: the object is RETAINED. `TRANSCRIPTION_FAILED` is retryable over the same
    // object, so deleting it here would make that flag a lie.
    const timedOut = isTimeout(error);
    await log({
      outcome: timedOut ? 'timeout' : 'provider_error',
      provider: 'none',
      usedFallback: usedFallbackOf(error),
      quotaSpent: true,
    });
    throw timedOut ? voiceTimeoutError(error) : error;
  }

  const transcript = transcribed.value.text;
  const provider = transcribed.provider;

  // ── 6. The empty-transcript branch (Requirement 8.7) ──────────────────────
  if (transcript.trim() === '') {
    // No chat call, no answer, object retained (Requirement 8.10). `no_speech_prob` is logged where
    // the provider supplied it — it separates "the farmer recorded silence" from "the provider
    // produced nothing", which is why the bytes are worth keeping for the window.
    await log({ outcome: 'inconclusive', provider, usedFallback: transcribed.usedFallback, quotaSpent: true });
    throw new AppError('TRANSCRIPT_EMPTY', {
      context: {
        reason: transcript === '' ? 'provider_returned_empty' : 'provider_returned_whitespace',
        userId,
        conversationId: input.conversationId,
        fileId: input.audio.fileId,
        noSpeechProb: transcribed.value.signals.noSpeechProb ?? null,
        avgLogprob: transcribed.value.signals.avgLogprob ?? null,
        reportedDurationSeconds: transcribed.value.durationSeconds ?? null,
      },
    });
  }

  // ── 7. The nested chat call — reserving NOTHING (Requirement 14.1) ────────
  const chatInput: ChatInput = {
    userId,
    conversationId: input.conversationId,
    message: transcript,
    language,
    channel,
    inputKind: 'voice',
    // The boolean form of the nesting rule. The load-bearing carrier is `coveredBy()` below.
    skipQuotaReserve: true,
    // Requirement 8.9's audit trail: the farmer message records which recording the transcript came
    // from (a Media_Reference under A3), and that recording is deleted moments later.
    transcriptOf: input.audio,
  };

  let answered: NestedChatOutcome;
  try {
    answered = await deps.chat(chatInput, coveredBy(reservation));
  } catch (error) {
    // Spent and not refunded: the transcription call already happened. No `messages` row exists, so
    // the object is retained (Requirement 8.10) and the sweep collects it.
    await log({
      outcome: isTimeout(error) ? 'timeout' : 'provider_error',
      provider,
      usedFallback: transcribed.usedFallback,
      quotaSpent: true,
    });
    throw error;
  }

  // ── 8. Delete the original (Requirements 8.9, 8.11) ───────────────────────
  // Only now: `farmerMessageId` is the evidence that the transcript is durable. Never throws.
  const audioDisposition = await deleteVoiceOriginal(input.audio, userId, remove);

  // ── 9. Usage log (Requirements 14.6, 14.7) ────────────────────────────────
  await log({
    outcome: 'success',
    provider,
    usedFallback: transcribed.usedFallback,
    quotaSpent: true,
    conversationId: answered.conversationId,
  });

  return {
    transcript,
    answer: answered.answer,
    conversationId: answered.conversationId,
    quota,
    farmerMessageId: answered.farmerMessageId,
    provider,
    usedFallback: transcribed.usedFallback,
    audio: audioDisposition,
  };
}

/* ========================================================================== */
/* The audit row                                                               */
/* ========================================================================== */

/**
 * The facts a voice call site supplies. The four this service already knows — the farmer, the
 * operation, the channel and the elapsed time — are filled in by the `log` closure. `diagnosis_id`
 * is deliberately not offered: a voice turn produces messages, not a diagnosis.
 */
type VoiceUsageFacts = Omit<
  UsageFacts,
  'userId' | 'operation' | 'channel' | 'diagnosisId' | 'latencyMs'
>;

/** Whether the burst limiter refused this request (13.8), as opposed to failing. */
function isRateLimited(error: unknown): boolean {
  return isAppError(error) && error.code === 'RATE_LIMITED';
}

/* ========================================================================== */
/* Small shared helpers                                                        */
/* ========================================================================== */

function isTimeout(error: unknown): boolean {
  return isAppError(error) && error.code === 'DIAGNOSIS_TIMEOUT';
}

/**
 * Translate the gateway's timeout into a code whose *sentence* fits a voice request.
 * `DIAGNOSIS_TIMEOUT` tells the farmer to send the photo again — wrong twice on this path — so a
 * transcription that ran out of budget is reported as `TRANSCRIPTION_FAILED` (502, retryable over
 * the same object). The audit row still records `outcome = 'timeout'`, and nothing about the spend
 * changes.
 */
function voiceTimeoutError(cause: unknown): AppError {
  return new AppError('TRANSCRIPTION_FAILED', {
    cause,
    context: {
      reason: 'transcription_budget_exhausted',
      capability: 'transcribe',
      ...(isAppError(cause) && cause.context !== undefined ? cause.context : {}),
    },
  });
}

/** Whether the failed gateway call had reached a fallback member (14.7). */
function usedFallbackOf(error: unknown): boolean {
  return isAppError(error) && error.context?.usedFallback === true;
}

/**
 * The one absolute deadline for this request, computed exactly as the gateway would. **Exported for
 * `/api/voice`**, which needs the number before this service runs so it can hand the same budget to
 * the nested `ChatService`.
 */
export function voiceRequestDeadline(input: {
  requestStartMs: number;
  platformDeadline?: (() => Date | undefined) | undefined;
}): number {
  const at = (input.platformDeadline ?? getDeadline)();
  const ms = at === undefined ? undefined : at.getTime();
  return computeDeadline({
    requestStartMs: input.requestStartMs,
    ...(ms === undefined || !Number.isFinite(ms) ? {} : { platformDeadlineMs: ms }),
  });
}
