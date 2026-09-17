'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import {
  ErrorBanner,
  type ErrorBannerError,
  type ErrorBannerRetry,
} from '@/components/ErrorBanner';
import { useJameeRequests, type VoiceBody } from '@/components/LanguageProvider';
import {
  AUDIO_COUNTDOWN_FROM_SECONDS,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  STORAGE_BUCKETS,
  TRANSCRIBE_ACCEPTED_CONTAINERS,
  TRANSCRIBE_MIN_SECONDS,
} from '@/lib/config/verified';
import { AppError, toEnvelope } from '@/lib/errors';
import { interpolate, messages } from '@/lib/messages';
import type { ErrorCode, Language, StorageRef } from '@/lib/schemas';
import { buildStorageRef } from '@/lib/storage';
import { createClient } from '@/lib/supabase/client';

import styles from './VoiceRecorder.module.css';

/**
 * Hold to speak: record a question in the browser, upload the audio straight to storage, then
 * post the reference and the measured duration.
 *
 * Requirements: 8.1 (the recording goes browser-direct to `voice-messages` and only the
 *               Storage_Reference reaches the API), 8.2 (up to 120 seconds and up to 10 MB, with
 *               a visible countdown), 8.3 (a recording over either limit is declined and the
 *               message states BOTH limits), 15.2 (every indicator is bound to an observed
 *               state), 15.5 (an upload failure is reported and NO voice request is sent),
 *               15.7 (a listening state while transcription is in flight)
 * Design: "Voice capture"; "Frontend" → *Browser-direct upload*, *Honest loading states*,
 *         *Mobile layout and accessibility*
 * Depends on: V10 (the containers the Transcription_Provider accepts), V20 (which container
 *             `MediaRecorder` actually records — **U-V20**, unresolved on the target Android
 *             browsers, which is why this component probes instead of assuming)
 *
 * ### The order of operations, and why it is this order
 *
 * ```
 * press ──▶ pick container (V10 ∩ isTypeSupported) ──▶ microphone ──▶ record (≤120 s)
 *              │                                          │                │
 *              └─▶ none: record NOTHING, say so           └─▶ denied: say  ▼
 *                                                              so       release / hard stop
 *                                                                            │
 *                        admit the blob (8.3) ◀───────────────────────────────┘
 *                             │
 *                             ├─▶ decline: no bytes leave the phone, both limits stated
 *                             ▼
 *                        upload to voice-messages/{user_id}/… (8.1)
 *                             │
 *                             ├─▶ fail: report, NO voice request (15.5)
 *                             ▼
 *                        POST { audio: ref, durationSeconds, mimeType } (8.1)
 * ```
 *
 * **The container is chosen before the microphone is opened.** A browser that cannot produce a
 * recording the provider accepts is a fact Jamee can establish without a permission prompt, and
 * asking for a microphone it is about to refuse to use would be the wrong order to fail in.
 *
 * ### Why the countdown is not a progress animation
 *
 * Requirement 15.2 forbids simulated or time-based progress, and Requirement 8.2 asks for a
 * visible countdown. Those are compatible because the countdown is a **measurement**: it reads
 * `MAX_AUDIO_SECONDS` minus real elapsed recording time, so it is bound to an observed state
 * exactly as a byte count would be. What 15.2 rules out is a percentage that advances on a timer
 * while a request is open — and there is none here. The upload and the transcription get text
 * (`loading.uploadingRecording`, `loading.listening`), never a bar.
 *
 * ### Two controls, because press-and-hold cannot be the only way in
 *
 * The design requires the recorder to be keyboard operable with an equivalent
 * tap-to-start/tap-to-stop path. So there are two real `<button>` elements: the hold control
 * (pointer press/release, plus a genuine key-down/key-up hold) and the toggle control, whose
 * label flips between `ui.tapToStart` and `ui.tapToStop`. Both end at the same two functions.
 * The hold control cancels the default action of Enter and Space on key-down, which is what stops
 * a keyboard hold from also firing a synthetic click and starting a second recording.
 *
 * ### What task 19.2 has to wire
 *
 * This component owns the recording, the upload and the voice request; it renders no transcript
 * and no answer. `/voice` (task 19.2) must:
 *
 *  1. resolve the session server-side and pass `userId` — the first path segment of every object,
 *     and the value the storage policy re-checks against `auth.uid()`;
 *  2. resolve or create a conversation server-side and pass `conversationId`. It is REQUIRED
 *     rather than optional because `voiceRequestSchema` requires it: a voice turn is a chat turn,
 *     and Requirement 7.1 keys Conversation_Context on the conversation identifier;
 *  3. wrap this component in `<LanguageProvider>`, because `useJameeRequests()` is the only way
 *     to reach `/api/voice` and it takes the language from that context (Requirement 9.2);
 *  4. render the transcript ABOVE the answer from `onVoiceResponse` (Requirement 8.6), including
 *     the non-ok case, where the envelope's message and a retry action are Requirement 15.4's
 *     job;
 *  5. NOT add a second loading indicator. The three honest strings — the countdown while
 *     recording, `loading.uploadingRecording` while the object is going to the bucket, and
 *     `loading.listening` while the POST is open (Requirement 15.7) — are rendered here, because
 *     this is the component holding the request.
 */

/* ========================================================================== */
/* Container choice — V10 ∩ MediaRecorder.isTypeSupported (V20)                 */
/* ========================================================================== */

/**
 * The MIME types this recorder will ask for, best first.
 *
 * **Every entry normalizes to a member of `TRANSCRIBE_ACCEPTED_CONTAINERS`** (V10), and the
 * intersection in `chooseRecordingType()` re-checks that rather than trusting this list to stay
 * true. Opus first because MDN documents Opus in both WebM and Ogg as the widely supported
 * recording codec, and because it is the smallest of the candidates at speech bitrates — which
 * is what keeps a 120 s recording far below the 10 MB ceiling.
 *
 * **`audio/aac` and `audio/amr` are deliberately absent.** V14 documents both as containers
 * WhatsApp delivers, and task 22.2 confirmed that **neither is in V10's accepted list** and
 * corrected `docs/VERIFIED_VALUES.md` accordingly. Adding either here would produce a recording
 * the Transcription_Provider refuses, discovered as a provider error after the farmer has spoken
 * and after the upload — which is the opposite of failing loudly. `3gp`/`3gpp` is absent for the
 * same reason: MDN mentions it for Firefox for Android, V10 does not list it.
 */
export const RECORDER_MIME_PREFERENCES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
] as const;

/** How often the countdown is recomputed from real elapsed time. Display only. */
const COUNTDOWN_TICK_MS = 250;

/**
 * Reduce a MIME type to the bare container name V10 lists, or `undefined`.
 *
 * ```
 * 'audio/webm;codecs=opus'  ->  'webm'      parameters dropped
 * 'audio/ogg'               ->  'ogg'       subtype taken
 * 'audio/x-m4a'             ->  'm4a'       RFC 6838 legacy `x-` tree marker dropped
 * ```
 *
 * **This mirrors `normalizeAudioContainer()` in `src/lib/groq.ts` on purpose, and cannot import
 * it:** that module reads `serverEnv()` and is therefore `server-only`, so a client component
 * importing it would be a build error. What is NOT duplicated is the list itself — both read
 * `TRANSCRIBE_ACCEPTED_CONTAINERS` from `config/verified.ts`, which exists to be importable from
 * both sides. If V10's list is ever widened, both paths widen with one edit.
 */
export function recordingContainerOf(value: string): string | undefined {
  const base = value.trim().toLowerCase().split(';')[0]?.trim() ?? '';
  if (base === '') return undefined;
  const subtype = base.includes('/') ? (base.split('/')[1] ?? '') : base;
  const bare = subtype.replace(/^\./, '').replace(/^x-/, '');
  return bare === '' ? undefined : bare;
}

/** Whether V10 accepts what this MIME type is a container for. */
export function isTranscribableRecordingType(value: string): boolean {
  const container = recordingContainerOf(value);
  return (
    container !== undefined &&
    (TRANSCRIBE_ACCEPTED_CONTAINERS as readonly string[]).includes(container)
  );
}

export interface RecordingType {
  /** Passed to `new MediaRecorder(stream, { mimeType })`, and sent with the request. */
  readonly mimeType: string;
  /** The bare container, which is also the object's file extension. */
  readonly container: string;
}

/**
 * The first preference this browser supports AND the provider accepts, or `null`.
 *
 * `isTypeSupported` is injected rather than read from the global so the intersection is testable
 * under jsdom, which has no `MediaRecorder` at all. In production it is
 * `MediaRecorder.isTypeSupported` — the documented probe (V20).
 *
 * **`null` means record nothing.** Requirement 8.3's rejections are about a recording that
 * exists; this is the earlier case, and the honest response is to say so and capture no audio.
 * Falling back to an unaccepted container would trade a clear message now for a failed
 * transcription later, after the farmer has spoken and after a quota unit was reserved.
 */
export function chooseRecordingType(
  isTypeSupported: (mimeType: string) => boolean,
  preferences: readonly string[] = RECORDER_MIME_PREFERENCES,
): RecordingType | null {
  for (const mimeType of preferences) {
    const container = recordingContainerOf(mimeType);
    if (container === undefined) continue;
    if (!(TRANSCRIBE_ACCEPTED_CONTAINERS as readonly string[]).includes(container)) continue;
    if (!isTypeSupported(mimeType)) continue;
    return { mimeType, container };
  }
  return null;
}

/**
 * What the browser actually selected, read back from `MediaRecorder.mimeType` (V20).
 *
 * The read-back wins over the requested type when it is present, because it is the statement of
 * fact — U-V20 records that which container really records on the target Android browsers could
 * not be confirmed from documentation, so this is where Jamee finds out. A read-back the provider
 * does not accept returns `null` and the recording is abandoned before it starts, for the same
 * reason `chooseRecordingType()` returns `null`.
 *
 * An empty read-back is not evidence of anything: the property is documented as the container in
 * use, and a browser that has not started yet may report `''`. In that case the requested type
 * stands, and it was already checked against V10.
 */
export function resolveRecordedType(
  requested: RecordingType,
  reported: string | null | undefined,
): RecordingType | null {
  const readBack = reported?.trim() ?? '';
  if (readBack === '') return requested;

  const container = recordingContainerOf(readBack);
  if (container === undefined) return null;
  if (!(TRANSCRIBE_ACCEPTED_CONTAINERS as readonly string[]).includes(container)) return null;
  return { mimeType: readBack, container };
}

/* ========================================================================== */
/* Elapsed time, the countdown, and the reported duration                       */
/* ========================================================================== */

/**
 * Remaining whole seconds once the countdown is due, otherwise `null`.
 *
 * `AUDIO_COUNTDOWN_FROM_SECONDS` (100) is the value the countdown STARTS AT, so the readout
 * appears once 100 seconds remain — twenty seconds into a recording — and runs down to zero.
 * Before that there is a state to announce but no number, which is what `ui.recording` is for:
 * showing "120 seconds left" the instant a farmer presses would put a deadline in front of
 * someone who is about to ask a ten-second question.
 *
 * `ceil` rather than `round` so the last displayed number is `1` and not `0` for half a second
 * while audio is still being captured.
 */
export function countdownSeconds(elapsedMs: number): number | null {
  const remaining = Math.max(0, Math.ceil(MAX_AUDIO_SECONDS - elapsedMs / 1000));
  return remaining > AUDIO_COUNTDOWN_FROM_SECONDS ? null : remaining;
}

/**
 * How far past `MAX_AUDIO_SECONDS` a measurement may land before it stops being lag.
 *
 * The hard stop is a timer, and a timer fires late: a busy main thread, or a phone that
 * backgrounded the tab for a moment, can put the stop a few hundred milliseconds beyond the cap.
 * That overshoot is measurement lag rather than farmer speech, so it is absorbed — the duration
 * reported is the cap, and `voiceRequestSchema`'s own `.max(MAX_AUDIO_SECONDS)` is satisfied
 * without the recorder having to lie about a number it measured.
 *
 * Beyond one second it is no longer lag: something suspended the timers, and the recording really
 * is longer than Requirement 8.2 allows. That is declined, with both limits stated.
 */
export const DURATION_OVERSHOOT_TOLERANCE_SECONDS = 1;

/**
 * The measured recording length in seconds, to millisecond precision.
 *
 * This is the number Requirement 8.3 is checked against, and it is real: `performance.now()` at
 * stop minus `performance.now()` at start.
 */
export function measuredSeconds(elapsedMs: number): number {
  return Math.round(Math.max(0, elapsedMs)) / 1000;
}

/**
 * The duration POSTED with the reference, which is the measurement clamped to the cap.
 *
 * The clamp only ever removes overshoot the tolerance above already declared admissible — a
 * recording longer than that never reaches this function, because `voiceRejectionCode()` declined
 * it. `voice.service.ts` re-checks this value server-side (Requirement 8.3 is a spend rule, so
 * the browser's number is evidence rather than authority).
 */
export function reportedDurationSeconds(elapsedMs: number): number {
  return Math.min(measuredSeconds(elapsedMs), MAX_AUDIO_SECONDS);
}

/* ========================================================================== */
/* Admission — on the recorded blob, after stop (Requirements 8.2, 8.3)         */
/* ========================================================================== */

/** The four ways a finished recording is declined. All four are catalogued `ErrorCode`s. */
export type VoiceRejectionCode = Extract<
  ErrorCode,
  'AUDIO_FORMAT_UNSUPPORTED' | 'AUDIO_TOO_LONG' | 'FILE_TOO_LARGE' | 'TRANSCRIPT_EMPTY'
>;

/**
 * The facts admission reads. A test constructs one of these rather than fabricating audio: the
 * check is about the container the browser reported, the bytes it produced and the time it
 * measured, and none of those becomes more real for having Opus frames behind it.
 */
export interface RecordingFacts {
  /** `MediaRecorder.mimeType`, as resolved by `resolveRecordedType()`. */
  mimeType: string;
  sizeBytes: number;
  elapsedMs: number;
}

/**
 * Which rejection a finished recording earns, or `null` when it is admitted.
 *
 * Four checks, in this order, and each code is the one the server-side check would have used —
 * `assertAdmissibleAudio()` in `src/services/voice.service.ts` makes the same three decisions
 * over the same constants, so the browser refuses early instead of differently:
 *
 *  1. **A container V10 does not accept** → `AUDIO_FORMAT_UNSUPPORTED`. Unreachable through this
 *     component, which never starts a recorder on an unaccepted type — kept because
 *     `submitVoiceRecording()` is callable directly, and because a browser that reports one
 *     container and produces another should be refused rather than trusted.
 *  2. **Longer than `MAX_AUDIO_SECONDS` plus the overshoot tolerance** → `AUDIO_TOO_LONG`.
 *  3. **Over `MAX_AUDIO_BYTES`** → `FILE_TOO_LARGE`, checked on the real blob after stop. This is
 *     the only one of Requirement 8.3's two limits that can be enforced any other way: a size
 *     cannot be known while recording, only bounded by guesswork about a bitrate.
 *  4. **Shorter than V10's `TRANSCRIBE_MIN_SECONDS`** → `TRANSCRIPT_EMPTY`. A tap that starts and
 *     stops the recorder in the same moment has captured nothing; "record it again somewhere
 *     quieter" is the accurate instruction, and refusing here costs no quota unit and no round
 *     trip. `voice.service.ts` reaches the same code one step later for the same reason.
 *
 * `sizeBytes` is compared with `>`, so `MAX_AUDIO_BYTES` is inclusive — Requirement 8.2 says "up
 * to 10 MB", and a recording of exactly 10 485 760 bytes is admitted.
 */
export function voiceRejectionCode(facts: RecordingFacts): VoiceRejectionCode | null {
  if (!isTranscribableRecordingType(facts.mimeType)) return 'AUDIO_FORMAT_UNSUPPORTED';

  const seconds = measuredSeconds(facts.elapsedMs);
  if (seconds > MAX_AUDIO_SECONDS + DURATION_OVERSHOOT_TOLERANCE_SECONDS) return 'AUDIO_TOO_LONG';
  if (facts.sizeBytes > MAX_AUDIO_BYTES) return 'FILE_TOO_LARGE';
  if (seconds < TRANSCRIBE_MIN_SECONDS) return 'TRANSCRIPT_EMPTY';

  return null;
}

/**
 * The farmer-facing sentence for a rejection, in the active language.
 *
 * **Requirement 8.3 wants BOTH limits on either limit rejection** — the duration and the size —
 * and `errors.AUDIO_TOO_LONG` is the one catalog string that carries both ("A recording can be up
 * to 120 seconds and 10 MB…"). So that string is the shared *instruction*, and `FILE_TOO_LARGE`'s
 * copy is prepended as the *reason* when size is what happened. A too-large recording therefore
 * reads: reason, then what will work instead.
 *
 * `FILE_TOO_LARGE` is asked for **`MAX_AUDIO_BYTES` explicitly**, because its implied details in
 * `errors.ts` carry `MAX_IMAGE_BYTES` — the two constants happen to be equal today, and a message
 * that quotes the image limit at a recording would start lying the day one of them moves.
 *
 * The two non-limit codes get their own copy unchanged: neither is about a limit, so neither
 * states one.
 */
export function voiceRejectionMessage(code: VoiceRejectionCode, language: Language): string {
  const bothLimits = toEnvelope(new AppError('AUDIO_TOO_LONG'), language).error.message;

  switch (code) {
    case 'AUDIO_TOO_LONG':
      return bothLimits;
    case 'FILE_TOO_LARGE': {
      const reason = toEnvelope(
        new AppError('FILE_TOO_LARGE', { details: { maxBytes: MAX_AUDIO_BYTES } }),
        language,
      ).error.message;
      return `${reason} ${bothLimits}`;
    }
    case 'AUDIO_FORMAT_UNSUPPORTED':
    case 'TRANSCRIPT_EMPTY':
      return toEnvelope(new AppError(code), language).error.message;
  }
}

/* ========================================================================== */
/* Notices — everything the recorder reports, as an ErrorBanner (Req. 15.4)     */
/* ========================================================================== */

/**
 * One farmer-facing problem, in the shape `ErrorBanner` renders.
 *
 * Task 25.1 consolidated six components onto `ErrorBanner` and left this one out, because the
 * recorder's notices are catalog sentences rather than envelopes and had no language or `retryable`
 * to carry. Task 26.2 is the pass that gives them both, so `role="alert"` now exists in exactly one
 * component in this codebase and the placement rule — a banner is a **sibling** of the polite
 * region, never a child of it — is enforced by that component rather than restated here.
 *
 * The `retry` arm is the part worth reading. Requirement 15.4 asks for a retry action for the
 * failed operation, and for four of these five there honestly is not one:
 *
 *  - **A declined recording** (too long, too large, too short, wrong container) cannot be retried.
 *    Sending the same audio again is declined identically, and recording a shorter one is a new
 *    request. `ImageUploader` says `none` about a declined photo for exactly this reason.
 *  - **A failed upload or a failed POST** cannot be retried either: the blob is not held past
 *    `send()`, so there is nothing left to re-send. This corrects the older claim in this file that
 *    the two record controls were that retry — they are not, they start a fresh recording, which is
 *    the same reasoning `VoicePanel` already states for its own banner.
 *  - **A browser with no container the provider accepts** latches `unsupported` and disables both
 *    controls. Nothing retries it, on this browser, ever.
 *  - **A refused microphone** is the one real `control` case. Nothing was captured, so nothing is
 *    lost, and pressing the same control after granting permission retries precisely the operation
 *    that failed.
 */
export interface RecorderNotice {
  readonly error: ErrorBannerError;
  readonly retry: ErrorBannerRetry;
}

/**
 * A declined recording (Requirements 8.2, 8.3). `retryable` comes from the taxonomy rather than
 * from a judgement here, so the flag and `ERROR_SPECS` cannot disagree.
 */
export function voiceRejectionNotice(
  code: VoiceRejectionCode,
  language: Language,
): RecorderNotice {
  const { error } = toEnvelope(new AppError(code), language);
  return {
    error: { message: voiceRejectionMessage(code, language), language, retryable: error.retryable },
    retry: { kind: 'none' },
  };
}

/**
 * The upload, the POST, or `MediaRecorder` itself failed.
 *
 * `INTERNAL_ERROR` is the honest code for all three: the taxonomy has no upload-specific code, and
 * inventing one here would put a farmer-facing string outside the catalog. It is `retryable: true`
 * in `ERROR_SPECS` — the *operation* can succeed on another attempt — and the arm is still `none`,
 * because the recording that would have been re-sent no longer exists. Those two facts are not in
 * tension: one is about the error class, the other about what this screen is holding.
 */
export function recorderFailureNotice(language: Language): RecorderNotice {
  return { error: toEnvelope(new AppError('INTERNAL_ERROR'), language).error, retry: { kind: 'none' } };
}

/**
 * The microphone was refused, or there is none, or the origin is insecure — Jamee cannot tell those
 * apart, so the sentence names the one action that changes the outcome and claims nothing else.
 *
 * The only `control` arm in this component: the record controls stay enabled, and pressing one
 * after granting permission is a retry of the operation that failed rather than a new one.
 */
export function microphoneBlockedNotice(language: Language): RecorderNotice {
  return {
    error: { message: messages(language).ui.microphoneBlocked, language, retryable: true },
    retry: { kind: 'control' },
  };
}

/**
 * This browser offers no container the Transcription_Provider accepts.
 *
 * `retryable: false` and `none`, and both are the same fact stated twice: the component latches
 * `unsupported`, which disables the hold and the toggle, so there is no control left to press and
 * no attempt that could turn out differently.
 */
export function recordingUnsupportedNotice(language: Language): RecorderNotice {
  return {
    error: { message: messages(language).ui.recordingUnsupported, language, retryable: false },
    retry: { kind: 'none' },
  };
}

/* ========================================================================== */
/* Upload seam                                                                 */
/* ========================================================================== */

/**
 * One object into the bucket, or throw.
 *
 * Structurally the same seam `ImageUploader` uses, and declared here rather than imported from it
 * for one reason: importing the *value* `browserObjectUploader` would pull that module's CSS and
 * its canvas re-encoder into the voice bundle, for eight lines of Supabase call. The shape is the
 * contract; `StorageRef` and the client are the shared parts, and both come from shared modules.
 */
export type ObjectUploader = (input: {
  ref: StorageRef;
  body: Blob;
  contentType: string;
}) => Promise<void>;

/**
 * The production uploader, on the browser client and the public key.
 *
 * `upsert: false` because every path carries a fresh uuid: an upsert would turn a uuid collision
 * — or a replayed request — into a silent overwrite of an object a request already points at.
 *
 * **The prefix is not enforced here.** `voice_messages_insert_own` in migration 0009 compares the
 * path's first segment to `auth.uid()` in the database, so a tampered client cannot write into
 * another farmer's folder however it builds the path (Requirement 8.11's server-side delete makes
 * the same comparison on the way out).
 */
export function browserObjectUploader(client: ReturnType<typeof createClient>): ObjectUploader {
  return async ({ ref, body, contentType }) => {
    const { error } = await client.storage
      .from(ref.bucket)
      .upload(ref.path, body, { contentType, upsert: false });
    if (error !== null) throw error;
  };
}

/* ========================================================================== */
/* The submission (Requirements 8.1, 8.3, 15.5)                                 */
/* ========================================================================== */

/** What came out of `MediaRecorder`. No React, no DOM. */
export interface RecordedAudio {
  blob: Blob;
  /** `MediaRecorder.mimeType` after `resolveRecordedType()` — the container actually used. */
  mimeType: string;
  /** Real elapsed recording time, `performance.now()` at stop minus at start. */
  elapsedMs: number;
}

export type VoiceSubmission =
  /** Declined after stop, before any bytes left the phone (Requirements 8.2, 8.3). */
  | { status: 'rejected'; code: VoiceRejectionCode }
  /**
   * `upload` means no object exists, so no voice request is sent (Requirement 15.5). `voice`
   * means the object is in the bucket but the POST never produced a response — the retention
   * sweep's orphan scan is what eventually reclaims those bytes.
   */
  | { status: 'failed'; stage: 'upload' | 'voice'; cause: unknown }
  | {
      status: 'sent';
      audio: StorageRef;
      /** What was posted, after the overshoot clamp. */
      durationSeconds: number;
      /** Unparsed on purpose: the transcript, the answer and the envelope belong to the screen. */
      response: Response;
    };

export interface SubmitVoiceRecordingInput {
  recording: RecordedAudio;
  /** The signed-in farmer. Becomes the first path segment, and nothing else may. */
  userId: string;
  /** Required by `voiceRequestSchema`: a voice turn is a chat turn and needs its conversation. */
  conversationId: string;
  upload: ObjectUploader;
  /** `useJameeRequests().voice` — the only way to reach `/api/voice`. */
  voice: (body: VoiceBody) => Promise<Response>;
  /** Injected by tests so the path is predictable. Default to now / a fresh uuid. */
  now?: Date;
  objectId?: string;
}

/**
 * Admit, upload, then post the reference — the whole flow, with no React in it.
 *
 * Extracted from the component because every rule worth testing here is a rule about
 * *sequencing*: that a declined recording uploads nothing, that a failed upload posts nothing
 * (Requirement 15.5), and that what is posted is a reference plus a measured duration rather than
 * audio bytes (Requirements 8.1, 2.7). None of that is about the DOM, and asserting it through a
 * rendered tree would prove less — the more so here, where jsdom has neither `MediaRecorder` nor
 * `getUserMedia`, so the capture half cannot be rendered at all.
 */
export async function submitVoiceRecording(
  input: SubmitVoiceRecordingInput,
): Promise<VoiceSubmission> {
  const { recording, userId, conversationId, upload, voice } = input;

  const container = recordingContainerOf(recording.mimeType);
  if (container === undefined) return { status: 'rejected', code: 'AUDIO_FORMAT_UNSUPPORTED' };

  const rejected = voiceRejectionCode({
    mimeType: recording.mimeType,
    sizeBytes: recording.blob.size,
    elapsedMs: recording.elapsedMs,
  });
  if (rejected !== null) return { status: 'rejected', code: rejected };

  /** Requirement 8.1: the `voice-messages` bucket, under the farmer's own prefix. */
  const audio = buildStorageRef({
    bucket: STORAGE_BUCKETS.voiceMessages,
    userId,
    extension: container,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.objectId === undefined ? {} : { objectId: input.objectId }),
  });

  try {
    await upload({ ref: audio, body: recording.blob, contentType: recording.mimeType });
  } catch (cause) {
    /** Requirement 15.5: report the upload failure, send NO voice request. */
    return { status: 'failed', stage: 'upload', cause };
  }

  const durationSeconds = reportedDurationSeconds(recording.elapsedMs);

  /**
   * Requirement 8.1: the reference, the measured duration, and the container — ~250 bytes on the
   * wire. `voiceRequestSchema` carries no byte count, deliberately: Requirement 8.3's 10 MB rule
   * is enforced here against the blob the farmer recorded, and a client-supplied size would be a
   * number the server could not verify anyway (`src/lib/groq.ts` documents the same reasoning for
   * its optional `bytes` field).
   *
   * `mimeType` is sent rather than assumed because U-V20 leaves the recorded container unresolved
   * on the target Android browsers; `audioContainerOf()` in `voice.service.ts` prefers it over
   * the path's extension for exactly that reason.
   */
  const body: VoiceBody = { audio, conversationId, durationSeconds, mimeType: recording.mimeType };

  let response: Response;
  try {
    response = await voice(body);
  } catch (cause) {
    return { status: 'failed', stage: 'voice', cause };
  }

  return { status: 'sent', audio, durationSeconds, response };
}

/* ========================================================================== */
/* Component                                                                   */
/* ========================================================================== */

export interface VoiceRecorderProps {
  /** The signed-in farmer, from `getUser()` in the `/voice` server shell (task 19.2). */
  userId: string;
  /** The conversation this question belongs to, resolved server-side by that shell. */
  conversationId: string;
  /**
   * The unparsed `/api/voice` response, ok or not. Task 19.2 parses it with
   * `voiceResponseSchema`, renders the transcript above the answer (Requirement 8.6), and renders
   * the error envelope plus a retry for a non-ok status (Requirement 15.4).
   */
  onVoiceResponse?: (response: Response) => void;
  /** Test seam. The production default is the browser Supabase client. */
  upload?: ObjectUploader;
}

/**
 * `'idle'` plus the three observed states. There is nothing else to derive an indicator from,
 * and nothing here advances without something real having happened.
 */
type Phase = 'idle' | 'recording' | 'uploading' | 'listening';

/** Monotonic, so a clock adjustment mid-recording cannot change a measured duration. */
function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/** Release the microphone. Without this the phone keeps showing a recording indicator. */
function releaseStream(stream: MediaStream | null): void {
  if (stream === null) return;
  for (const track of stream.getTracks()) track.stop();
}

export function VoiceRecorder({
  userId,
  conversationId,
  onVoiceResponse,
  upload,
}: VoiceRecorderProps) {
  /**
   * `useJameeRequests()` is the only way to reach `/api/voice`, and it stamps the active language
   * onto the body from context — a caller cannot pass one (Requirement 9.2). Its `language` is
   * also what every string on this control is rendered in.
   */
  const requests = useJameeRequests();
  const { ui, loading } = messages(requests.language);

  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  /** One farmer-facing problem at a time: a rejection, a refusal, or a failure. */
  const [notice, setNotice] = useState<RecorderNotice | null>(null);
  /** This browser offers no container the provider accepts. Latched: it will not change. */
  const [unsupported, setUnsupported] = useState(false);

  const statusId = useId();

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const elapsedAtStopRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hardStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A press is in progress, so a release should stop the recording. */
  const holdingRef = useRef(false);
  /** `getUserMedia` is open. Blocks a second start, and remembers an early release. */
  const startingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  /** The blob is being uploaded or posted. Blocks a start until it resolves. */
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);

  /**
   * Built on first use, not during render: `publicEnv()` throws when
   * `NEXT_PUBLIC_SUPABASE_URL` is absent and this component is server-rendered before it
   * hydrates. Same reasoning as `ImageUploader` and `SignInForm`.
   */
  const uploaderRef = useRef<ObjectUploader | null>(null);
  function objectUploader(): ObjectUploader {
    if (upload !== undefined) return upload;
    uploaderRef.current ??= browserObjectUploader(createClient());
    return uploaderRef.current;
  }

  function clearTimers(): void {
    if (tickRef.current !== null) clearInterval(tickRef.current);
    if (hardStopRef.current !== null) clearTimeout(hardStopRef.current);
    tickRef.current = null;
    hardStopRef.current = null;
  }

  /**
   * A recording that outlives the screen would keep the microphone open and upload something
   * nobody is waiting for, so unmount stops everything and releases the device.
   */
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimers();
      const recorder = recorderRef.current;
      if (recorder !== null && recorder.state !== 'inactive') recorder.stop();
      recorderRef.current = null;
      releaseStream(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  async function send(recording: RecordedAudio): Promise<void> {
    const outcome = await submitVoiceRecording({
      recording,
      userId,
      conversationId,
      /**
       * The phase flips as the upload actually opens, and again as the POST opens — not on a
       * timer, and not before either has anything to report. That is the whole of Requirements
       * 15.2 and 15.7: real request state, no interval, no percentage.
       */
      upload: (object) => {
        setPhase('uploading');
        return objectUploader()(object);
      },
      voice: (body) => {
        setPhase('listening');
        return requests.voice(body);
      },
    });

    switch (outcome.status) {
      case 'rejected':
        /** Requirement 8.3 — the message states both limits, in the active language. */
        setNotice(voiceRejectionNotice(outcome.code, requests.language));
        break;

      case 'failed':
        /**
         * The real cause goes to the browser console and nowhere else (Requirement 15.6);
         * `recorderFailureNotice` decides what the farmer reads and whether a retry is claimed.
         */
        console.error(`[jamee] voice ${outcome.stage} failed`, outcome.cause);
        setNotice(recorderFailureNotice(requests.language));
        break;

      case 'sent':
        onVoiceResponse?.(outcome.response);
        break;
    }

    sendingRef.current = false;
    setElapsedMs(0);
    setPhase('idle');
  }

  /**
   * Stop the recorder, if there is one. Idempotent, because four different events can call it:
   * a pointer release, a key release, a blur, and the hard stop.
   */
  function endRecording(): void {
    holdingRef.current = false;

    const recorder = recorderRef.current;
    if (recorder === null) {
      /** Released before the microphone opened. Remembered, and honoured on arrival. */
      if (startingRef.current) stopRequestedRef.current = true;
      return;
    }
    if (recorder.state === 'inactive') return;

    /**
     * Measured HERE rather than in the `stop` event, which fires after the last chunk has been
     * flushed: the elapsed time a farmer spent speaking ends when they release the control, not
     * when the encoder finishes.
     */
    elapsedAtStopRef.current = nowMs() - startedAtRef.current;
    clearTimers();
    recorder.stop();
  }

  async function beginRecording(): Promise<void> {
    if (recorderRef.current !== null || startingRef.current || sendingRef.current) return;

    setNotice(null);

    /**
     * The container decision comes FIRST, before the permission prompt: a browser that cannot
     * produce something the provider accepts is refused without being asked for a microphone.
     */
    if (typeof MediaRecorder === 'undefined') {
      setUnsupported(true);
      setNotice(recordingUnsupportedNotice(requests.language));
      return;
    }
    const requested = chooseRecordingType((mimeType) => MediaRecorder.isTypeSupported(mimeType));
    if (requested === null) {
      setUnsupported(true);
      setNotice(recordingUnsupportedNotice(requests.language));
      return;
    }

    startingRef.current = true;
    stopRequestedRef.current = false;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (cause) {
      startingRef.current = false;
      /**
       * A refused prompt, a device with no microphone, and a browser blocking capture on an
       * insecure origin all arrive here, and Jamee cannot tell them apart — so the message names
       * the one action that changes the outcome and claims nothing else. Not `INTERNAL_ERROR`:
       * nothing went wrong at Jamee's end.
       */
      console.warn('[jamee] microphone unavailable', cause);
      if (mountedRef.current) setNotice(microphoneBlockedNotice(requests.language));
      return;
    }

    if (!mountedRef.current) {
      releaseStream(stream);
      startingRef.current = false;
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: requested.mimeType });
    } catch (cause) {
      /**
       * `isTypeSupported` said yes and the constructor disagreed. Treated as the same refusal:
       * the probe is the only thing that could have told Jamee otherwise, and there is no second
       * candidate worth trying that this browser has not already declined.
       */
      console.warn('[jamee] MediaRecorder rejected a supported type', cause);
      releaseStream(stream);
      startingRef.current = false;
      setUnsupported(true);
      setNotice(recordingUnsupportedNotice(requests.language));
      return;
    }

    /** V20: what the browser actually selected wins over what was asked for. */
    const resolved = resolveRecordedType(requested, recorder.mimeType);
    if (resolved === null) {
      console.warn(`[jamee] recorded container not accepted: ${recorder.mimeType}`);
      releaseStream(stream);
      startingRef.current = false;
      setUnsupported(true);
      setNotice(recordingUnsupportedNotice(requests.language));
      return;
    }

    const chunks: Blob[] = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    recorder.addEventListener('error', (event) => {
      console.error('[jamee] MediaRecorder error', event);
      clearTimers();
      releaseStream(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      holdingRef.current = false;
      if (!mountedRef.current) return;
      setNotice(recorderFailureNotice(requests.language));
      setElapsedMs(0);
      setPhase('idle');
    });

    recorder.addEventListener('stop', () => {
      clearTimers();
      releaseStream(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      if (!mountedRef.current) return;

      sendingRef.current = true;
      void send({
        blob: new Blob(chunks, { type: resolved.mimeType }),
        mimeType: resolved.mimeType,
        elapsedMs: elapsedAtStopRef.current,
      });
    });

    streamRef.current = stream;
    recorderRef.current = recorder;
    startedAtRef.current = nowMs();
    elapsedAtStopRef.current = 0;
    setElapsedMs(0);
    setPhase('recording');
    recorder.start();
    startingRef.current = false;

    /**
     * The countdown reads real elapsed time on every tick — it is a measurement, not an
     * animation (Requirement 15.2). The same tick is the backstop for the hard stop below: if a
     * backgrounded tab throttles the timeout, whichever timer fires first ends the recording, and
     * `endRecording()` is idempotent.
     */
    tickRef.current = setInterval(() => {
      const elapsed = nowMs() - startedAtRef.current;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_AUDIO_SECONDS * 1000) endRecording();
    }, COUNTDOWN_TICK_MS);

    /** Requirement 8.2's hard 120 second stop. */
    hardStopRef.current = setTimeout(endRecording, MAX_AUDIO_SECONDS * 1000);

    /** Released during the permission prompt: honour it now rather than record unattended. */
    if (stopRequestedRef.current) {
      stopRequestedRef.current = false;
      endRecording();
    }
  }

  const isRecording = phase === 'recording';
  const busy = phase === 'uploading' || phase === 'listening';

  /** One string, from the one piece of state. Empty while idle. */
  let statusText = '';
  if (isRecording) {
    const remaining = countdownSeconds(elapsedMs);
    statusText =
      remaining === null
        ? ui.recording
        : interpolate(ui.recordingSecondsLeft, { seconds: remaining });
  } else if (phase === 'uploading') {
    statusText = loading.uploadingRecording;
  } else if (phase === 'listening') {
    /** Requirement 15.7 — Jamee is listening to the recording. */
    statusText = loading.listening;
  }

  function onHoldStart(event: PointerEvent<HTMLButtonElement>): void {
    /** Secondary buttons and a right-click context menu are not a press. */
    if (event.button !== 0) return;
    holdingRef.current = true;
    void beginRecording();
  }

  function onHoldEnd(): void {
    if (holdingRef.current) endRecording();
  }

  /**
   * A real press-and-hold on a keyboard: Enter or Space down starts, up stops.
   *
   * `preventDefault()` on key-down cancels the button's default activation, which is what stops
   * this control from ALSO firing a synthetic click — otherwise one keystroke would both start a
   * recording here and, on the toggle path, immediately stop it. Key repeat is ignored so a held
   * key does not restart anything.
   */
  function onHoldKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (event.repeat || holdingRef.current) return;
    holdingRef.current = true;
    void beginRecording();
  }

  function onHoldKeyUp(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onHoldEnd();
  }

  function onToggle(): void {
    if (isRecording) endRecording();
    else void beginRecording();
  }

  return (
    <div className={styles.recorder} aria-busy={busy}>
      {/*
       * Press and hold. A real `<button>` rather than a click-handled `<div>`, so it is focusable
       * and announced as a button — and it carries its own keyboard hold rather than being a
       * pointer-only control a keyboard user can reach but not operate.
       */}
      <button
        className={`${styles.hold} ${isRecording ? styles.recording : ''}`}
        type="button"
        disabled={busy || unsupported}
        aria-describedby={statusId}
        /*
         * `aria-pressed` here and a changing label on the toggle below — one state signal each,
         * never both on the same control. This label is fixed, so the held state has to be
         * announced some other way; the toggle's label already says which action it performs, and
         * adding `aria-pressed` to it would have a screen reader read "tap to stop recording,
         * pressed".
         */
        aria-pressed={isRecording}
        onPointerDown={onHoldStart}
        onPointerUp={onHoldEnd}
        onPointerCancel={onHoldEnd}
        onPointerLeave={onHoldEnd}
        onKeyDown={onHoldKeyDown}
        onKeyUp={onHoldKeyUp}
        /** A focus loss mid-hold would otherwise leave the microphone open. */
        onBlur={onHoldEnd}
      >
        {ui.holdToSpeak}
      </button>

      {/*
       * The equivalent path the design requires: tap to start, tap again to stop. Operable with a
       * single click, a single Enter, or a screen reader's activation, and it is the control a
       * farmer who cannot hold a button steady uses for the full 120 seconds.
       */}
      <button
        className={styles.toggle}
        type="button"
        disabled={busy || unsupported}
        aria-describedby={statusId}
        onClick={onToggle}
      >
        {isRecording ? ui.tapToStop : ui.tapToStart}
      </button>

      {/*
       * A declined recording, a refused microphone, a browser with no usable container, or a
       * failed upload — through the one component that renders `role="alert"` (task 25.1's
       * consolidation, completed here). Directly under the two controls, and a **sibling** of the
       * polite region below rather than a child of it: an assertive region nested inside a polite
       * one announces one event twice. `ErrorBanner` owns both of those rules.
       */}
      {notice !== null ? <ErrorBanner error={notice.error} retry={notice.retry} /> : null}

      {/*
       * The countdown, the upload and the listening state, in one polite region. Rendered while
       * idle too: a live region that appears together with its text is not reliably announced,
       * and reserving the line keeps the buttons from moving under a thumb. `role="status"` is
       * polite by definition — ordinary state does not interrupt a screen reader mid-sentence.
       */}
      <p className={styles.status} id={statusId} role="status">
        {statusText}
      </p>
    </div>
  );
}
