import 'server-only';

import { getDeadline } from '@vercel/functions';
import type { SupabaseClient } from '@supabase/supabase-js';

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
  STORAGE_BUCKETS,
  TRANSCRIBE_ACCEPTED_CONTAINERS,
  TRANSCRIBE_MIN_SECONDS,
} from '@/lib/config/verified';
import { writeUsageLog, type UsageFacts } from '@/lib/db/usage-log';
import { AppError, isAppError } from '@/lib/errors';
import {
  groqTranscribeMember,
  isAcceptedAudioContainer,
  type GroqTranscribeOptions,
  type TranscribeRequest,
  type TranscriptionResult,
} from '@/lib/groq';
import { noBurstCheck, type BurstCheck } from '@/lib/rate-limit';
import type {
  ChatAnswer,
  ChatInput,
  Operation,
  QuotaStatus,
  StorageRef,
  VoiceInput,
} from '@/lib/schemas';
import {
  assertOwnershipInBucket,
  ownerSegmentOf,
  signedUrlFor,
  type StorageClientLike,
} from '@/lib/storage';
import {
  coveredBy,
  ownsRequest,
  quotaExceededError,
  quotaStatusOf,
  refundReservation,
  reserveForRequest,
  type QuotaContext,
  type QuotaOptions,
  type QuotaReservation,
} from '@/services/quota.service';
import type { Database, TablesInsert } from '@/types/database';

/**
 * The single voice implementation: transcribe a recording, answer it as a chat turn, return both.
 *
 * Requirements: 8.4 (a valid voice request is transcribed through the Transcription_Provider and
 *               the transcript is passed to the Chat_Service as a Farmer message), 8.6 (the
 *               transcript AND the text answer are both returned), 8.7 (an empty transcript asks
 *               the farmer to record again somewhere quieter), 8.8 (text answers only, no
 *               synthesized speech), 8.9 (the voice original is deleted once its transcript is
 *               persisted as a Message), 8.10 (a failed or empty transcript RETAINS the object
 *               until its Retention_Window elapses), 8.11 (deletion happens only server-side with
 *               the Service_Role_Key, and only after the path's first segment is confirmed to be
 *               the requesting farmer), 14.1 (one voice message spends exactly one voice unit —
 *               never a voice unit and a chat unit), 16.5 (`channel` is an input parameter)
 * Design: "Media lifecycle and retention" → *What is deleted, when, and by whom*, *Why voice
 *         originals go on success rather than on a timer*, *Why a failed transcription keeps its
 *         bytes*; "Quota enforcement" → *When a unit is reserved, finalized, or refunded*
 * Depends on: V3 (signed URLs), V10 (the transcription model, containers and caps), V11 (error
 *             classification)
 *
 * =============================================================================
 * THE ORDER OF OPERATIONS IS THE CONTRACT
 * =============================================================================
 *
 * The same discipline `diagnosis.service.ts` states, with the voice steps in place of the image
 * ones. Each step satisfies its criterion *by being where it is*:
 *
 *  1. **Ownership** (`assertOwnershipInBucket` on `voice-messages`) — Requirements 2.5, 2.6.
 *     Before the reserve, so a rejected reference leaves the quota untouched because nothing was
 *     taken, not because something was handed back.
 *  2. **Audio admission** — Requirement 8.3's duration rule and V10's container list, re-checked
 *     here because the WhatsApp path never passes through `voiceRequestSchema`. Also before the
 *     reserve: a recording Jamee will not transcribe costs no unit.
 *  3. **Burst check** — Requirement 13.8, `src/lib/rate-limit.ts`. One `voice` minute slot; the
 *     nested chat answer at step 8 takes none, because it is covered.
 *  4. **Quota reserve** — Requirements 14.1–14.3. An at-limit farmer is declined here and **no
 *     provider is called**.
 *  5. **Signed URL** — V3. The last refundable step: no provider call has been attempted yet.
 *  6. **`transcribe`** — Requirement 8.4. From this instant the unit is spent, whatever follows.
 *  7. **The empty-transcript branch** — Requirement 8.7. No chat call, no answer, object retained.
 *  8. **The nested chat call** — Requirement 8.4, reserving **nothing** (see below). It persists
 *     the farmer message and the answer, and returns the farmer message id.
 *  9. **Delete the original** — Requirement 8.9, and only now: the message id from step 8 is the
 *     evidence that the transcript is durable.
 * 10. **Usage log** — Requirements 14.6, 14.7.
 *
 * =============================================================================
 * THE NESTING RULE (REQUIREMENT 14.1)
 * =============================================================================
 *
 * **The nested `ChatService` call performs no reserve of its own.** The voice unit taken at step 4
 * covers the answer this request produces, so one voice message never spends both a voice unit and
 * a chat unit.
 *
 * That is carried two ways here, and only one of them is load-bearing:
 *
 *  - `coveredBy(reservation)` from `quota.service.ts` is the mechanism. `QuotaReservation` is
 *    branded with a module-private symbol, so coverage cannot be fabricated — the only way to get
 *    one is a real reserve, and `reserveForRequest()` on a `covered` context performs **no RPC at
 *    all**, not even a read. The failure mode is therefore a type error rather than a farmer
 *    charged twice.
 *  - `ChatInput.skipQuotaReserve: true` is the same fact in the boolean form `schemas.ts` declares.
 *    It is set for contract fidelity and it is *not* what makes the guarantee true: a boolean
 *    cannot be turned into coverage. `quota.service.ts` is explicit that the boolean must be mapped
 *    once at the top of `ChatService` — `true` → `coveredBy(reservation)` — so it never reaches the
 *    quota module, which is exactly why the reservation travels alongside it through
 *    `ChatAnswerer`'s second parameter.
 *
 * The unit test asserts this the only way an ordering can be asserted from outside: the counter
 * stub is shared between this service and the nested call, and `tryIncrement` must have been
 * called **exactly once**.
 *
 * =============================================================================
 * DELETION: ONE BICONDITIONAL, NOT THREE TRIGGERS
 * =============================================================================
 *
 * *A voice object is absent if and only if a transcript message exists for it.*
 *
 *  - **Success (8.9)** — the transcript is a `messages` row with `input_kind = 'voice'`, nothing in
 *    the product reads a recording back (8.8 rules out synthesized speech), so the object has no
 *    reader and goes immediately.
 *  - **Transcription failed (8.10)** — retained. `TRANSCRIPTION_FAILED` is 502 **retryable, over
 *    the same object** (`errors.ts`); deleting it would make that flag a lie and force a farmer to
 *    re-record for a provider outage.
 *  - **Empty transcript (8.10)** — retained too, although 8.7 does ask the farmer to record again.
 *    Two reasons, both the design's: it keeps the rule one testable biconditional instead of three
 *    cases with three triggers, and V10 surfaces `no_speech_prob` precisely because an empty
 *    transcript can be a *provider artefact* rather than a silent recording — so the bytes are worth
 *    keeping for the retention window, and that signal is logged where it is available.
 *
 * The retention sweep (task 33) is the collector for both retained cases; its age-driven scan is
 * what reaches a voice object that never got a `messages` row.
 *
 * =============================================================================
 * WHY EVERY CLIENT IS A PARAMETER, AND WHY THE DELETER IS A DIFFERENT ONE
 * =============================================================================
 *
 * One implementation serves the web route and the WhatsApp adapter (Requirement 16.5), which hold
 * different credentials — a farmer session's RLS-scoped client and no session at all. So reads take
 * `deps.supabase`, exactly as `diagnosis.service.ts` does.
 *
 * The delete does not. Requirement 8.11 and migration `0009` put it on the **service role**: the
 * storage policies grant a farmer session no `delete`, and the design's rule that "the browser never
 * deletes" exists so both channels share one deletion path. `deps.deleter` therefore defaults to
 * `createAdminClient()`, imported lazily so a caller that injects its own — every unit test — never
 * reads `SUPABASE_SERVICE_ROLE_KEY`.
 *
 * This module is `server-only` for the same reason. `storage.ts` deliberately is not (its path
 * helpers are needed in the browser), so Requirement 8.11's "only from a server-side module" is
 * satisfied by the delete living **here** rather than there.
 *
 * =============================================================================
 * A CROSS-CHECK THIS SERVICE INHERITS AND DOES NOT PAPER OVER
 * =============================================================================
 *
 * V14 lists inbound WhatsApp audio as `audio/aac`, `audio/amr`, `audio/mpeg`, `audio/mp4` and
 * `audio/ogg` and asserts all five sit inside V10's accepted list. **`aac` and `amr` do not**: V10's
 * list is `flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm`. `isAcceptedAudioContainer()` in
 * `groq.ts` refuses them rather than widening the list to make V14's sentence true, and step 2 below
 * refuses them *before the reserve*, so such a request spends nothing.
 *
 * The consequence is real and belongs to the WhatsApp audio task (22.x): **a WhatsApp voice note
 * recorded as AAC or AMR cannot be transcribed today.** Resolving it means re-reading V10 and V14
 * against the providers' current documentation — and if AAC and AMR genuinely are accepted, widening
 * `TRANSCRIBE_ACCEPTED_CONTAINERS`; if they are not, transcoding or declining them in the adapter
 * with wording a farmer can act on. Inventing a container Groq may not accept would turn a loud
 * pre-flight refusal into a provider 400 discovered in production.
 *
 * =============================================================================
 * WHAT IS DELIBERATELY NOT HERE
 * =============================================================================
 *
 * **No HTTP.** No `Request`, no `Response`, no WhatsApp payload shapes. Task 18.3's route parses and
 * maps; this service decides.
 *
 * **No prompt, no knowledge-base read, no `messages` insert.** All three belong to `ChatService`
 * (tasks 15.2, 15.3), and a second copy here would be the parallel implementation Requirement 16.4
 * exists to prevent. Requirement 8.8 needs no code: this service returns text and never asks for
 * audio.
 *
 * **No conversation resolution or conversation-ownership check.** `VoiceInput.conversationId` is
 * required, so there is nothing to find-or-create. Verifying that the id is *this farmer's* belongs
 * with the code that writes a row under it — the nested `ChatService`, which persists both messages
 * and therefore needs the check for its direct callers anyway. One check, one place; if 15.3 leaves
 * it to its route instead, the voice route needs it too.
 *
 * **No synthesized speech, now or behind a flag** (Requirement 8.8).
 */

/** This service reserves, and audits, exactly one operation type. */
const OPERATION: Operation = 'voice';

/* ========================================================================== */
/* Step 6's seam — transcription                                               */
/* ========================================================================== */

/**
 * The `transcribe` capability as one injectable function.
 *
 * A local seam rather than a third method on `CapabilityRunner` (`ai/capabilities.ts`), because that
 * module exists to reconcile *two* provider surfaces into one call shape and `transcribe` has only
 * one member by design (design: *Fallback matrix*, "None in this release"). There is nothing to
 * reconcile: `TranscribeRequest` and `TranscriptionResult` are already the shared shapes, so a
 * mapping layer would add a hop that maps nothing.
 *
 * The value is the same one `CapabilityRunner` gives the diagnosis service: a unit test stubs one
 * function at the gateway boundary instead of an SDK, and can therefore assert "no chat call was
 * issued after an empty transcript" directly.
 */
export type Transcriber = (
  request: TranscribeRequest,
  options?: RunOptions,
) => Promise<GatewayResult<TranscriptionResult>>;

/**
 * The production transcriber: the real gateway over the sole `transcribe` member.
 *
 * The adapter holds no client — `groq.ts` resolves its SDK call at invoke time — so constructing
 * this reads no environment variable and touches no network.
 */
export function gatewayTranscriber(options: GroqTranscribeOptions = {}): Transcriber {
  const adapters = groqTranscribeMember(options);
  return (request, runOptions = {}) => run('transcribe', adapters, request, runOptions);
}

/* ========================================================================== */
/* Step 8's seam — the nested ChatService call                                 */
/* ========================================================================== */

/**
 * What the nested chat call returns. Exactly `chatResponseSchema`'s four fields, so the real
 * `ChatService` entry point satisfies this without an adapter.
 */
export interface NestedChatOutcome {
  readonly conversationId: string;
  /**
   * The persisted farmer message.
   *
   * **This id is Requirement 8.9's precondition**, not a convenience: "WHEN the API_Layer has
   * persisted a transcript as a Message" is the trigger for deleting the recording, and this is the
   * only evidence this service has that the row exists.
   */
  readonly farmerMessageId: string;
  readonly answer: ChatAnswer;
  readonly quota: QuotaStatus;
}

/**
 * `ChatService`, as this service needs it.
 *
 * **Required rather than defaulted**, and the reason is worth stating: the answer half of
 * `ChatService` (tasks 15.2, 15.3) is not yet built, and a default that imported a symbol which does
 * not exist would be a build error rather than a seam. Once it lands, both callers bind it with
 * their own credential — the same reason `DiagnosisDeps.supabase` is required — and this service
 * stays unchanged.
 *
 * `coverage` is a second parameter rather than a field of `ChatInput` because a `QuotaReservation`
 * is branded and unforgeable, and it has to *travel* for the nesting rule to hold: `ChatInput`
 * carries only the `skipQuotaReserve` boolean, and a boolean cannot be turned into coverage. See
 * the module header.
 */
export type ChatAnswerer = (
  input: ChatInput,
  coverage: QuotaContext,
) => Promise<NestedChatOutcome>;

/* ========================================================================== */
/* Step 9 — deletion (Requirements 8.9, 8.11)                                  */
/* ========================================================================== */

/**
 * The narrow slice of a Supabase client a delete needs.
 *
 * Structural rather than nominal, following `StorageClientLike` in `storage.ts`: the service-role
 * client satisfies it without this type naming it, so a test can exercise the deletion branches
 * without constructing a client that holds the RLS-bypassing key.
 *
 * **V22 is unresolved** on whether `remove()` errors for a path that is already absent. Nothing
 * below depends on the answer: the existence probe classifies that case as `already_absent` before
 * `remove()` is reached, and a `remove()` error is reported rather than thrown either way — which is
 * the idempotency Requirement 18.10 asks of every deleter.
 */
export interface ObjectRemoveClient {
  storage: {
    from(bucket: string): {
      remove(paths: string[]): Promise<{ data: unknown; error: unknown }>;
    };
  };
}

/**
 * What happened to the recording. Five outcomes, one requirement each.
 *
 * Reported rather than thrown, in every variant. By the time a deletion runs, the farmer has an
 * answer and the transcript is committed; turning a retention problem into HTTP 500 would cost them
 * a retry and another quota unit for something they cannot act on. The sweep is the backstop for
 * every non-`deleted` outcome, and each one is logged server-side.
 */
export type VoiceObjectDisposition =
  /** Requirement 8.9 — the transcript is durable and the original is gone. */
  | { readonly outcome: 'deleted' }
  /**
   * Requirement 8.10 — no transcript was persisted (the provider failed, or the transcript was
   * empty), so the object waits for its Retention_Window. No delete was attempted.
   */
  | { readonly outcome: 'retained'; readonly reason: 'no_transcript_persisted' }
  /**
   * Requirement 8.11 — the path's first segment is not the requesting farmer, or ownership could
   * not be confirmed. **`remove()` is never called on this branch.**
   */
  | { readonly outcome: 'refused'; readonly reason: 'prefix_mismatch' | 'ownership_unconfirmed' }
  /** Already gone. A deletion is idempotent (Requirement 18.10), so this is success-equivalent. */
  | { readonly outcome: 'already_absent' }
  /** The delete was attempted and the storage API refused it. The sweep will retry. */
  | { readonly outcome: 'failed'; readonly reason: 'remove_failed' };

/**
 * Delete one `voice-messages` object, after confirming it is the requesting farmer's.
 *
 * Requirement 8.11 has two halves and both are here. The service-role client is the caller's to
 * supply (see the module header on why the browser never deletes); the **first-segment comparison**
 * is this function's, and it happens before anything touches the network:
 *
 *  1. `ownerSegmentOf(path) !== userId` → **refused, and nothing is called.** This is 8.11's literal
 *     clause, checked explicitly so the refusal has a name a test can assert rather than being
 *     inferred from an error's context. A mismatch is a defect — every path this service sees came
 *     from a reference `assertOwnershipInBucket()` already accepted at step 1 — so it is logged
 *     loudly, and it must never widen into a delete.
 *  2. `assertOwnershipInBucket()` adds the other two halves of the gate: the bucket, and the
 *     object's existence. Deliberately the same seam the read path used, per the design's
 *     "`VoiceService`'s on-success delete reuses the existing `assertOwnership` seam".
 *
 * The re-check is not redundant with step 1 of the pipeline. That check ran against the *request's*
 * client; this one runs against the client that is about to delete, which is the only client whose
 * authority is unconstrained by RLS or a storage policy.
 */
export async function deleteVoiceOriginal(
  ref: StorageRef,
  userId: string,
  client: ObjectRemoveClient & StorageClientLike,
): Promise<VoiceObjectDisposition> {
  if (ownerSegmentOf(ref.path) !== userId) {
    console.error(
      '[jamee] voice_delete_refused',
      JSON.stringify({ reason: 'prefix_mismatch', bucket: ref.bucket, requestedBy: userId }),
    );
    return { outcome: 'refused', reason: 'prefix_mismatch' };
  }

  try {
    await assertOwnershipInBucket(ref, userId, STORAGE_BUCKETS.voiceMessages, client);
  } catch (cause) {
    // `object_absent` is the idempotent case, not a failure: something already removed it, and a
    // deleter that reported that as an error would make a re-run noisier than a first run.
    if (isAppError(cause) && cause.context?.reason === 'object_absent') {
      return { outcome: 'already_absent' };
    }
    console.error(
      '[jamee] voice_delete_refused',
      JSON.stringify({ reason: 'ownership_unconfirmed', bucket: ref.bucket, requestedBy: userId }),
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
    );
    return { outcome: 'refused', reason: 'ownership_unconfirmed' };
  }

  try {
    const { error } = await client.storage.from(ref.bucket).remove([ref.path]);
    if (error !== null && error !== undefined) {
      console.error(
        '[jamee] voice_delete_failed',
        JSON.stringify({ bucket: ref.bucket, path: ref.path }),
        error,
      );
      return { outcome: 'failed', reason: 'remove_failed' };
    }
    return { outcome: 'deleted' };
  } catch (cause) {
    console.error(
      '[jamee] voice_delete_failed',
      JSON.stringify({ bucket: ref.bucket, path: ref.path }),
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
    );
    return { outcome: 'failed', reason: 'remove_failed' };
  }
}

/* ========================================================================== */
/* Step 10's seam — the audit row                                              */
/* ========================================================================== */

export interface VoiceStore {
  /** Requirements 14.6, 14.7. Append-only (D10). */
  insertUsageLog(row: TablesInsert<'usage_logs'>): Promise<void>;
}

/**
 * Bind the audit write to the service-role client.
 *
 * Not a choice: migration `0006` grants `authenticated` no insert policy on `usage_logs` — that
 * absence *is* "append-only" — so the row is unwritable with a farmer session.
 */
export function voiceStoreFrom(auditClient: SupabaseClient<Database>): VoiceStore {
  return {
    async insertUsageLog(row) {
      const { error } = await auditClient.from('usage_logs').insert(row);
      if (error !== null) {
        throw new AppError('INTERNAL_ERROR', {
          cause: error,
          context: {
            reason: 'usage_log_insert_failed',
            userId: row.user_id,
            outcome: row.outcome,
          },
        });
      }
    },
  };
}

/* ========================================================================== */
/* Dependencies and the outcome                                                */
/* ========================================================================== */

export interface VoiceDeps {
  /**
   * The request's Supabase client: RLS-scoped for the web path, service-role for WhatsApp.
   *
   * Required rather than defaulted, for the reason `DiagnosisDeps.supabase` states — a default
   * would be one credential, and the caller needing the other would have to remember to override
   * it.
   */
  readonly supabase: SupabaseClient<Database>;
  /** `ChatService`. Required — see `ChatAnswerer`. */
  readonly chat: ChatAnswerer;
  /** Storage reads. Defaults to `supabase`, which satisfies the narrow slice `storage.ts` needs. */
  readonly storage?: StorageClientLike;
  /**
   * The **service-role** client the delete runs on (Requirement 8.11). Defaults to
   * `createAdminClient()`, built on first use so an injected deleter reads no secret.
   */
  readonly deleter?: ObjectRemoveClient & StorageClientLike;
  /** Defaults to `voiceStoreFrom(createAdminClient())`, built on first use. */
  readonly store?: VoiceStore;
  /** The transcription call. Defaults to the real gateway over the sole `transcribe` member. */
  readonly transcribe?: Transcriber;
  /**
   * Step 3, Requirement 13.8. `/api/voice` binds `burstLimiter()` from `src/lib/rate-limit.ts`, and
   * binds **none** to `deps.chat` — the nested answer is covered by this request's voice unit and by
   * this request's burst slot, so it must not take a second one.
   *
   * The default is `noBurstCheck`, which is what keeps a unit test from opening a connection to
   * check a ceiling it is not testing.
   */
  readonly burst?: BurstCheck;
  /** The counter RPC seam and the quota clock. Both default inside `quota.service.ts`. */
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
 * What the caller gets back.
 *
 * The first four fields are exactly `voiceResponseSchema`, so task 18.3's route serializes them
 * without reshaping — Requirement 8.6's "the transcript and the text answer" is that pair being
 * present together rather than a route remembering to include both.
 *
 * `quota` is the **voice** status, from the reservation this service took. Not the nested chat's:
 * that call reserved nothing, and reporting a chat counter for a voice request would tell a farmer
 * about a limit they did not spend against.
 */
export interface VoiceOutcome {
  /** The provider's transcript, verbatim. See `transcribeAndAnswer`. */
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
 * The container to declare to the provider: what the recorder actually produced, or the object's
 * own extension.
 *
 * `mimeType` is preferred because it is the more specific statement — `MediaRecorder.mimeType` reads
 * back `audio/webm;codecs=opus` where the path only says `webm` — and it is sent rather than assumed
 * because **U-V20** leaves the recorded container unresolved on the target Android browsers. The
 * extension is the fallback, and `storageRefSchema` has already constrained its shape, so there is
 * always a value and `TranscribeRequest.container` can stay required.
 */
export function audioContainerOf(input: Pick<VoiceInput, 'mimeType' | 'storageRef'>): string {
  const declared = input.mimeType?.trim();
  if (declared !== undefined && declared !== '') return declared;
  const { path } = input.storageRef;
  return path.slice(path.lastIndexOf('.') + 1);
}

/**
 * Refuse a recording Jamee or the provider will not transcribe — **before the reserve**, so it
 * spends nothing.
 *
 * Four checks, and their codes are chosen rather than convenient:
 *
 *  1. **Longer than `MAX_AUDIO_SECONDS`** → `AUDIO_TOO_LONG` (400). Requirement 8.3's own code, and
 *     `errors.ts` fills `maxSeconds` and `maxBytes` into both the sentence and `details` from
 *     `config/verified.ts`, so the message cannot quote a limit the check did not use.
 *     `voiceRequestSchema` caps this at the edge for the web path; the check is here because the
 *     WhatsApp path never passes through that schema and its duration comes from provider metadata.
 *  2. **Larger than `MAX_AUDIO_BYTES`** → `FILE_TOO_LARGE` (400), Requirement 8.2's other half and
 *     the second code Requirement 8.3 is written against (`ERROR_SPECS`: "2.4, 8.3"). Checked only
 *     when `input.bytes` is present, because a size is not always knowable: `/api/voice` reads it
 *     from Storage (`objectSizeOf()`) and the WhatsApp path gets `file_size` from V14's metadata
 *     step, but a probe that comes back empty must not fail a request whose bytes are already in
 *     the bucket. `details.maxBytes` is stated explicitly rather than left to `impliedDetails()`,
 *     which fills `MAX_IMAGE_BYTES` for this code — the same 10 MB today, and two constants that
 *     must not silently start disagreeing in a sentence a farmer reads.
 *
 *     Below this ceiling, V10's 25 MB provider cap in `groq.ts` can no longer be reached from a
 *     path that passes through here, which is the intended relationship: the farmer-facing rule is
 *     the tighter one, and the provider check stays as the floor under callers that never saw this
 *     function.
 *  3. **Shorter than V10's `TRANSCRIBE_MIN_SECONDS`** → `TRANSCRIPT_EMPTY` (422). A recording below
 *     the minimum transcribable length has nothing in it, so "record it again somewhere quieter" is
 *     the accurate instruction and 422-retryable is the accurate flag. It reaches the same farmer
 *     -facing sentence as Requirement 8.7's branch, one step earlier and for one unit less.
 *  4. **A container outside V10's accepted list** → `AUDIO_FORMAT_UNSUPPORTED` (400, **not
 *     retryable**). This used to be `TRANSCRIPTION_FAILED` (502, retryable) and was recorded here
 *     as a known taxonomy gap: the container is the recorder's choice, not the request's, so
 *     re-sending the identical object fails identically forever and Requirement 15.4's flag was a
 *     lie every time it was reached. Task 22.2 closed the gap — the code, its spec row, and all
 *     three catalog strings now exist — so the accurate code is used here and the farmer reads
 *     "type your question instead" rather than an invitation to retry. The AAC/AMR note in the
 *     module header is the case that makes this reachable in practice; the reserve has still not
 *     happened when it fires, so it also costs nothing.
 */
export function assertAdmissibleAudio(input: VoiceInput): void {
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

  const container = audioContainerOf(input);
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
 * ### The transcript is handed over VERBATIM, and the trim is only a predicate
 *
 * `result.text` reaches `ChatInput.message` and `VoiceOutcome.transcript` exactly as the provider
 * produced it. The trim below decides *whether* there is a transcript; it never becomes the
 * transcript. Requirement 8.4 passes the transcript to the Chat_Service as a Farmer message, and a
 * farmer message Jamee has quietly edited is not the farmer's message — Requirement 8.7's own
 * branch is the only place emptiness is judged, and `groq.ts` is explicit that the adapter returns
 * `''` as a *successful* call rather than judging it there.
 *
 * ### Whitespace-only counts as empty
 *
 * A transcript of spaces, tabs or newlines carries no question. Sending it onward would spend a
 * knowledge-base read and a model call to answer nothing, and would persist a blank farmer message
 * in the conversation — so `trim() === ''` is the predicate, not `text === ''`.
 */
export async function transcribeAndAnswer(
  input: VoiceInput,
  deps: VoiceDeps,
): Promise<VoiceOutcome> {
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const { userId, language, channel } = input;

  const storage = deps.storage ?? deps.supabase;
  const transcribe = deps.transcribe ?? gatewayTranscriber();
  const burst = deps.burst ?? noBurstCheck;
  const quotaOptions: QuotaOptions = deps.quota ?? {};

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
    const store = deps.store ?? (await defaultStore());
    await writeUsageLog(store, {
      userId,
      operation: OPERATION,
      channel,
      conversationId: input.conversationId,
      latencyMs: now() - startedMs,
      ...facts,
    });
  };

  // ── 1. Ownership (Requirements 2.5, 2.6) — nothing has been spent yet ─────
  await assertOwnershipInBucket(input.storageRef, userId, STORAGE_BUCKETS.voiceMessages, storage);

  // ── 2. Audio admission (Requirement 8.3, V10) — still nothing spent ───────
  assertAdmissibleAudio(input);
  const container = audioContainerOf(input);

  // ── 3. Burst check (Requirement 13.8) — still nothing spent ───────────────
  // One slot, against the `voice` minute ceiling, before the reserve. The nested chat answer at step
  // 8 takes no second slot: it is `covered`, and `checkBurstForRequest()` in `rate-limit.ts` returns
  // without calling anything on a covered context.
  try {
    await burst(userId, OPERATION);
  } catch (error) {
    // Requirement 13.8's refusal, audited (migration 0011's `rate_limited`). Nothing is reserved at
    // this point, so `quota_spent: false` and there is no refund to make. One row, not two: the
    // nested chat turn is `covered`, so it takes no burst slot and writes no refusal of its own.
    if (isRateLimited(error)) {
      await log({ outcome: 'rate_limited', provider: 'none', usedFallback: false, quotaSpent: false });
    }
    throw error;
  }

  // ── 4. Reserve (Requirements 14.1–14.3) ───────────────────────────────────
  // `ownsRequest` because a voice request is always the entry point for its own operation type.
  // The nesting case is the OTHER direction: the chat answer at step 8 is covered by this unit.
  const reserved = await reserveForRequest(ownsRequest(userId, OPERATION), quotaOptions);
  if (reserved.outcome === 'at_limit') {
    await log({ outcome: 'quota_declined', provider: 'none', usedFallback: false, quotaSpent: false });
    // Requirement 14.3: states the limit and the reset time, and no provider was called.
    throw quotaExceededError(reserved.status);
  }
  const reservation: QuotaReservation = reserved.reservation;
  const quota = quotaStatusOf(reservation);

  // ── 5. Signed URL (V3) — the last refundable step ─────────────────────────
  let audioUrl: string;
  try {
    audioUrl = await signedUrlFor(input.storageRef, storage);
  } catch (error) {
    // No provider call was attempted, so the unit goes back (design step 9). `quota_spent = false`
    // on the audit row is what distinguishes a pre-provider failure from a provider one.
    await refundReservation(reservation, quotaOptions);
    await log({ outcome: 'provider_error', provider: 'none', usedFallback: false, quotaSpent: false });
    throw error;
  }

  // ── 6. Transcription (Requirement 8.4) — the unit is now spent ────────────
  const request: TranscribeRequest = {
    audioUrl,
    container,
    // Requirement 8.5's three languages are ISO-639-1 already, and V10 records that supplying the
    // input language improves both accuracy and latency — so it is always sent.
    language,
    durationSeconds: input.durationSeconds,
    // V10's 25 MB cap, forwarded when the caller knew a size. Step 2 has already refused anything
    // over Jamee's own 10 MB, so this is the adapter's floor rather than a check that fires — but a
    // floor with no number in it is not a floor, and this is the only place that can supply one.
    ...(input.bytes === undefined ? {} : { bytes: input.bytes }),
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

  // ── 7. The empty-transcript branch (Requirement 8.7) ──────────────────────
  if (transcript.trim() === '') {
    // No chat call, no answer, and the object is retained (Requirement 8.10). `no_speech_prob` is
    // logged where the provider supplied it: V10 surfaces it precisely because it separates "the
    // farmer recorded silence" from "the provider produced nothing", which is the distinction that
    // makes retaining the bytes for the window worth something.
    await log({ outcome: 'inconclusive', provider, usedFallback: transcribed.usedFallback, quotaSpent: true });
    throw new AppError('TRANSCRIPT_EMPTY', {
      context: {
        reason: transcript === '' ? 'provider_returned_empty' : 'provider_returned_whitespace',
        userId,
        conversationId: input.conversationId,
        bucket: input.storageRef.bucket,
        path: input.storageRef.path,
        noSpeechProb: transcribed.value.signals.noSpeechProb ?? null,
        avgLogprob: transcribed.value.signals.avgLogprob ?? null,
        reportedDurationSeconds: transcribed.value.durationSeconds ?? null,
      },
    });
  }

  // ── 8. The nested chat call — reserving NOTHING (Requirement 14.1) ────────
  const chatInput: ChatInput = {
    userId,
    conversationId: input.conversationId,
    message: transcript,
    language,
    channel,
    inputKind: 'voice',
    // The boolean form of the nesting rule. The load-bearing carrier is `coveredBy()` below.
    skipQuotaReserve: true,
    // Requirement 8.9's audit trail: the row records which object the transcript came from, and
    // that object is deleted moments later — `messages.transcript_of` is documented as usually
    // pointing at an object already gone.
    transcriptOf: input.storageRef.path,
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

  // ── 9. Delete the original (Requirements 8.9, 8.11) ───────────────────────
  // Only now: `farmerMessageId` is the evidence that the transcript is durable. Never throws.
  const audio = await deleteVoiceOriginal(
    input.storageRef,
    userId,
    deps.deleter ?? (await defaultDeleter()),
  );

  // ── 10. Usage log (Requirements 14.6, 14.7) ───────────────────────────────
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
    audio,
  };
}

/* ========================================================================== */
/* The audit row                                                               */
/* ========================================================================== */

/**
 * The facts a voice call site supplies. The four this service already knows — the farmer, the
 * operation, the channel and the elapsed time — are filled in by the `log` closure, so a call site
 * cannot get them wrong and cannot omit them. `conversationId` stays available so the success path
 * can substitute the id the chat call confirmed for the one that was requested.
 *
 * Derived from the shared `UsageFacts` by subtraction rather than re-declared, which is what makes
 * "one audit vocabulary" compiler-checked: a column added to `usage_logs` appears here
 * automatically, and this service stops compiling until every branch decides what to write in it.
 *
 * `diagnosis_id` is deliberately not offered: a voice turn produces messages, not a diagnosis, so
 * `usageLogRow()` writes it as `null`. Which `outcome` each branch uses is unchanged, and the
 * reasoning is worth keeping:
 *
 *  - **`inconclusive`** for an empty transcript. The request worked and the provider answered; the
 *    recording could not be understood. That is the same shape of fact the diagnosis path logs when
 *    a model reports honestly that it cannot judge a photo, and `provider_error` would claim a
 *    failure that did not happen while `success` would claim an answer that was not produced.
 *  - **`provider_error`** / **`timeout`** for a failed transcription, and for a nested chat failure.
 *  - **`rate_limited`** for Requirement 13.8's burst refusal (new in migration 0011).
 *  - **`success`** only when a transcript was answered.
 */
type VoiceUsageFacts = Omit<
  UsageFacts,
  'userId' | 'operation' | 'channel' | 'diagnosisId' | 'latencyMs'
>;

/**
 * Whether the burst limiter refused this request (Requirement 13.8), as opposed to failing.
 *
 * Read off the code rather than caught by position, because `burst` is an injected seam: a limiter
 * whose counter RPC failed raises `INTERNAL_ERROR`, and auditing that as a `rate_limited` refusal
 * would record a refusal that never happened.
 */
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
 *
 * `DIAGNOSIS_TIMEOUT` is the taxonomy's only timeout code and its message tells the farmer to send
 * the photo again — which on this path is wrong twice over: there is no photo, and the retry they
 * need is the same recording. `gateway.ts` explicitly leaves the translation to "a non-diagnosis
 * caller that wants different wording", so a transcription that ran out of budget is reported as
 * `TRANSCRIPTION_FAILED` (502, retryable over the same object), which is both accurate and
 * actionable.
 *
 * The distinction is not lost: the audit row records `outcome = 'timeout'`, and the original error
 * travels as `cause` into the server log. Nothing about the spend changes — a timeout stays spent.
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

/**
 * Whether the failed gateway call had reached a fallback member (Requirement 14.7).
 *
 * Read off `AppError.context`, which the gateway populates on its single exhausted-chain exit.
 * `transcribe` has one member today (V10), so this is `false` in practice — it is read rather than
 * hardcoded so that adding a second member never leaves a wrong audit row behind.
 */
function usedFallbackOf(error: unknown): boolean {
  return isAppError(error) && error.context?.usedFallback === true;
}

/**
 * The one absolute deadline for this request, computed exactly as the gateway would.
 *
 * `computeDeadline` is imported through the gateway so the arithmetic lives in one place, and V18's
 * `getDeadline()` is tolerated as absent — local development, a unit test, a non-Vercel host.
 *
 * **Exported for `/api/voice`**, which needs the number *before* this service runs: it builds the
 * `ChatAnswerer` for step 8, and `chatAnswerer({ supabase, runOptions })` is the only channel a
 * nested turn has for a deadline it did not compute itself. A route that omitted it would leave the
 * nested chat call starting a fresh 45 s budget partway through a request that already spent some
 * of its own on transcription. Calling this and handing the result to both halves is what makes one
 * voice request cost one budget; duplicating the arithmetic in the route would be a second place
 * for it to drift.
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

/**
 * The default audit store and the default deleter, both built on first use.
 *
 * `createAdminClient()` is imported **lazily** so a caller that injects its own — every unit test —
 * never reads `SUPABASE_SERVICE_ROLE_KEY`. Same reasoning as the lazy import in
 * `diagnosis.service.ts`.
 */
async function defaultStore(): Promise<VoiceStore> {
  const { createAdminClient } = await import('@/lib/supabase/admin');
  return voiceStoreFrom(createAdminClient());
}

async function defaultDeleter(): Promise<ObjectRemoveClient & StorageClientLike> {
  const { createAdminClient } = await import('@/lib/supabase/admin');
  return createAdminClient();
}
