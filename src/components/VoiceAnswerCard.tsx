'use client';

import { useState } from 'react';

import { ErrorBanner } from '@/components/ErrorBanner';
import { useLanguage } from '@/components/LanguageProvider';
import { VoiceRecorder } from '@/components/VoiceRecorder';
import { AppError, toEnvelope } from '@/lib/errors';
import { messages } from '@/lib/messages';
import {
  errorEnvelopeSchema,
  voiceResponseSchema,
  type ErrorEnvelope,
  type Language,
  type VoiceResponse,
} from '@/lib/schemas';

import styles from './VoiceAnswerCard.module.css';

/**
 * What a farmer reads after speaking a question: **what Jamee heard, then what Jamee answered.**
 *
 * Requirements: 8.6 (the transcript AND the text answer are both displayed, transcript first),
 *               8.8 (text answers only — there is no audio element anywhere in this module),
 *               15.7 (the listening state exists, and it belongs to the component holding the
 *               request — see below), 15.4 (the returned localized message is displayed and the
 *               failed operation has a retry action), 15.6 (a cause is logged, never rendered),
 *               9.3 (each block is rendered in the language it was produced in)
 * Design: "Frontend" → screens table — `/voice` is a **server shell** plus a client
 *          `VoiceRecorder`; "Voice capture" → *"The response renders transcript above answer
 *          (Requirement 8.6). No audio playback of answers in this release (Requirement 8.8)."*
 *
 * ### Why this file exists, and why it is not part of the page
 *
 * `src/app/voice/page.tsx` is a **server** component, so it cannot hand `VoiceRecorder` the
 * `onVoiceResponse` callback: something on the client side of that boundary has to hold the
 * response. `VoicePanel` is that something, and it lives next to the card that renders the
 * response for the same reason `DiagnosisPanel` lives next to `DiagnosisResultCard` — the parse,
 * the card and the error branch stay in one place instead of being duplicated per screen.
 *
 * ### There is exactly one loading indicator on this screen, and it is not here
 *
 * `VoiceRecorder` owns the recording, the upload and the POST, so it owns every state line: the
 * countdown while recording, `loading.uploadingRecording` while the object goes to the bucket, and
 * Requirement 15.7's `loading.listening` while the voice request is open. **This module adds no
 * second indicator** — two components rendering "is a request open?" from two pieces of state is
 * how one of them ends up wrong (the note `DiagnosisResultCard` records about `ImageUploader`,
 * for the same reason). Nothing here reads a timer, and no percentage exists in the flow to
 * advance (Requirement 15.2).
 *
 * One consequence is worth stating rather than hiding: a farmer who records a second question
 * keeps reading the previous transcript and answer until the new response arrives. That is
 * honest — it is a real answer to a real earlier question, and the listening line is on screen at
 * the same time — and the alternative would need `VoiceRecorder` to publish a request-start event
 * it does not have.
 *
 * ### Requirement 8.8 is enforced by absence
 *
 * There is no `<audio>`, no `speechSynthesis`, and no autoplay anywhere in this module or the
 * screen that renders it. `VoiceAnswerCard.test.tsx` asserts the absence, because "we did not add
 * speech" is a claim that only stays true if something checks it.
 */

/* ========================================================================== */
/* Reading the response (Requirements 15.3, 15.4)                              */
/* ========================================================================== */

/**
 * The two things `/api/voice` can answer with, after parsing.
 *
 * Mirrors `ChatOutcome` in `ChatComposer.tsx` and `DiagnosisOutcome` in
 * `DiagnosisResultCard.tsx`, including the reason for the split: the **status code** decides which
 * schema is applied, so a 200 carrying an envelope, or a 429 carrying a plausible-looking
 * transcript, is a parse failure rather than something rendered on the strength of guessing which
 * one it meant.
 *
 * `TRANSCRIPT_EMPTY` (Requirement 8.7) is an **error**, not an answer with an empty transcript:
 * `voice.service.ts` raises it before any chat turn exists, so there is no answer to pair a
 * transcript with. It arrives here as an envelope like any other coded failure, which is what puts
 * "record it again somewhere quieter" in front of the farmer in their own language.
 */
export type VoiceOutcome =
  | { kind: 'answer'; response: VoiceResponse }
  /** `cause` is the local parse failure when there was one. Logged, never rendered (15.6). */
  | { kind: 'error'; envelope: ErrorEnvelope; cause: unknown };

/**
 * A response Jamee could not make sense of, as a localized envelope.
 *
 * `INTERNAL_ERROR` is the honest code: a 200 that fails `voiceResponseSchema`, or a non-2xx whose
 * body is not an error envelope, is Jamee disagreeing with itself. The farmer reads the generic
 * localized sentence and the real cause goes to the console — Requirement 15.6's rule applied on
 * the client side of the same boundary.
 */
function internalFailure(language: Language, cause: unknown): VoiceOutcome {
  return {
    kind: 'error',
    envelope: toEnvelope(new AppError('INTERNAL_ERROR'), language),
    cause,
  };
}

/**
 * Turn the raw `/api/voice` response into one of the two outcomes.
 *
 * Exported and free of React so the branch that matters can be asserted over real `Response`
 * objects, the way `readDiagnoseResponse` and `readChatResponse` are. `VoiceRecorder` hands the
 * response over **unparsed** precisely so the schema, the envelope and the retry decision live in
 * one place.
 */
export async function readVoiceResponse(
  response: Response,
  language: Language,
): Promise<VoiceOutcome> {
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch (cause) {
    return internalFailure(language, cause);
  }

  if (response.ok) {
    const parsed = voiceResponseSchema.safeParse(payload);
    return parsed.success
      ? { kind: 'answer', response: parsed.data }
      : internalFailure(language, parsed.error);
  }

  /**
   * Requirements 15.3 and 15.4: the message rendered is the one the API returned, in the language
   * it was asked for. It is not re-derived from the code here — `QUOTA_EXCEEDED` carries a limit
   * and a reset time interpolated server-side, and `AUDIO_TOO_LONG` carries both of Requirement
   * 8.3's limits, so rebuilding those sentences on the client would give the app two versions of
   * each.
   */
  const envelope = errorEnvelopeSchema.safeParse(payload);
  return envelope.success
    ? { kind: 'error', envelope: envelope.data, cause: undefined }
    : internalFailure(language, envelope.error);
}

/* ========================================================================== */
/* The card                                                                    */
/* ========================================================================== */

export interface VoiceAnswerCardProps {
  response: VoiceResponse;
}

/**
 * The transcript, then the answer. That order is Requirement 8.6, and it is the DOM order rather
 * than a CSS one, so it is also the order a screen reader reads and the order the surrounding
 * polite live region announces.
 *
 * ### Why the transcript comes first
 *
 * Transcription is the step most likely to be wrong, and it is the only step a farmer can check.
 * An answer read before the question it answered gives no way to tell "Jamee is mistaken" from
 * "Jamee misheard me" — and re-recording is the fix for exactly one of those.
 *
 * ### The language of each block
 *
 * `answer.language` for both. It is the language the answer was produced in (Requirement 9.3),
 * and it is also the code the request carried — which is the language the Transcription_Provider
 * was asked to transcribe into, so the transcript is in it too. `voiceResponseSchema` carries no
 * separate language for the transcript, and inferring one from the characters would be a guess.
 *
 * ### `needsExpert` is deliberately not a banner here
 *
 * `answer` is the shared `chatAnswerSchema` from the shared `ChatService`, and Requirements 4.7
 * and 7.6 put the referral **in the answer text** — `chat.outOfScope` and `chat.noVerifiedInfo`
 * are catalog sentences the service returns as `content`. `/chat` renders that content and nothing
 * else, so adding a banner on this screen alone would make one service's answer read differently
 * depending on whether the farmer typed or spoke it (Requirement 16.2's whole point). The flag
 * stays on the wire for a later task that treats it the same way on both screens.
 */
export function VoiceAnswerCard({ response }: VoiceAnswerCardProps) {
  const { ui } = messages(response.answer.language);
  const transcript = response.transcript.trim();

  return (
    <article className={styles.card}>
      {/*
       * An empty transcript is unreachable through `voice.service.ts` — it raises
       * `TRANSCRIPT_EMPTY` instead of answering (Requirement 8.7) — so this guard is about not
       * rendering a heading over nothing if it ever happens, the same reading `KnowledgeSection`
       * applies to an empty knowledge array. A label with no text under it reads as content that
       * went missing.
       */}
      {transcript === '' ? null : (
        <section className={styles.block}>
          <h2 className={styles.blockHeading}>{ui.transcriptLabel}</h2>
          <p className={styles.body} lang={response.answer.language}>
            {transcript}
          </p>
        </section>
      )}

      <section className={styles.block}>
        <h2 className={styles.blockHeading}>{ui.answerLabel}</h2>
        {/*
         * Requirement 8.8 — text, and only text. No `<audio>`, no playback control, and nothing
         * that could be added later without this comment being deleted first.
         */}
        <p className={styles.body} lang={response.answer.language}>
          {response.answer.content}
        </p>
      </section>
    </article>
  );
}

/* ========================================================================== */
/* The screen's result region                                                  */
/* ========================================================================== */

export interface VoicePanelProps {
  /** The signed-in farmer, resolved server-side by the `/voice` shell. */
  userId: string;
  /**
   * The farmer's active web conversation, resolved server-side with `findOrCreateActive`.
   *
   * **Required, and never invented by the browser.** `voiceRequestSchema` requires it, a voice
   * turn is a chat turn, and Requirement 7.1 keys Conversation_Context on the conversation
   * identifier — so a fabricated id would either be refused as `CONVERSATION_NOT_FOUND` or,
   * worse, would silently start a thread with no context for a follow-up to resolve against.
   */
  conversationId: string;
  /** IDREF of the screen's heading, so the result region is a named landmark. */
  labelledBy: string;
}

/**
 * The recorder and the region that answers it, in one client subtree.
 *
 * The region is `aria-live="polite"` and it is in the DOM from the first render — **including
 * while it is empty**. A polite live region inserted together with its text is not reliably
 * announced, so the empty `<section>` is what makes the transcript and the answer get read out
 * when they arrive.
 *
 * It is named by the screen's own visible `<h1>` rather than by an off-screen duplicate heading
 * (the reading `ChatThread` records): a `<section>` with no accessible name is not a landmark, and
 * the name a screen reader announces should be the words a sighted farmer sees.
 */
export function VoicePanel({ userId, conversationId, labelledBy }: VoicePanelProps) {
  const { language } = useLanguage();

  const [outcome, setOutcome] = useState<VoiceOutcome | null>(null);

  /**
   * `VoiceRecorder` hands over the raw response synchronously; parsing it is async. The promise is
   * deliberately detached with `void` rather than awaited: the callback's contract is
   * `(response: Response) => void`, and returning a promise into it would be a promise nothing
   * observes.
   *
   * One `outcome` for the whole screen, replaced wholesale — so a failure clears the previous
   * answer and an answer clears the previous failure. Two pieces of state would allow an error
   * banner to sit under an answer that superseded it.
   */
  function onVoiceResponse(response: Response): void {
    void (async () => {
      const next = await readVoiceResponse(response, language);
      if (next.kind === 'error' && next.cause !== undefined) {
        /** Requirement 15.6's client-side half: the cause is logged, never rendered. */
        console.error('[jamee] /api/voice response could not be read', next.cause);
      }
      setOutcome(next);
    })();
  }

  return (
    <>
      {/*
       * The recorder holds the request, and therefore holds the only three state lines on this
       * screen — the countdown, `loading.uploadingRecording`, and Requirement 15.7's
       * `loading.listening`. See the module header on why nothing below duplicates them.
       */}
      <VoiceRecorder
        userId={userId}
        conversationId={conversationId}
        onVoiceResponse={onVoiceResponse}
      />

      {/*
       * Requirement 15.4's first half: the message the API returned, in the language it was asked
       * for, with `lang` from the envelope so it is pronounced in the language it was written in.
       *
       * **Beside the recorder and OUTSIDE the polite region below**, which is now `ErrorBanner`'s
       * own rule rather than this file's: `role="alert"` is an assertive live region, and nesting
       * one inside a polite one gives two announcements of one event.
       *
       * `retry: 'none'` — and this is the arm that exists for this screen. A retry control here
       * would have nothing to send: the panel never holds the recording, and re-posting a reference
       * to an object the service may already have deleted (Requirement 8.9) would fail differently
       * rather than succeed. Recording again is what a farmer does instead, and the recorder's own
       * controls are right above this sentence. Stating `none` rather than omitting a prop is what
       * makes that a decision on the record instead of a forgotten requirement.
       */}
      {outcome === null || outcome.kind !== 'error' ? null : (
        <ErrorBanner
          error={outcome.envelope.error}
          retry={{ kind: 'none' }}
          className={styles.errorSlot}
        />
      )}

      {/*
       * Requirement 8.6's pair, and nothing else. Empty on the error path — the sentence above is
       * the whole of what a failed request has to say, and a stale transcript left under a
       * failure would suggest the recording Jamee just refused was still understood.
       */}
      <section className={styles.region} aria-live="polite" aria-labelledby={labelledBy}>
        {outcome === null || outcome.kind !== 'answer' ? null : (
          <VoiceAnswerCard response={outcome.response} />
        )}
      </section>
    </>
  );
}
