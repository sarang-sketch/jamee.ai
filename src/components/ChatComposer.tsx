'use client';

import { useId, useRef, useState, type FormEvent } from 'react';

import { ChatThread, type ChatTurn } from '@/components/ChatThread';
import { ErrorBanner } from '@/components/ErrorBanner';
import { useJameeRequests } from '@/components/LanguageProvider';
import { AppError, toEnvelope } from '@/lib/errors';
import { messages } from '@/lib/messages';
import {
  chatResponseSchema,
  errorEnvelopeSchema,
  type ChatResponse,
  type ErrorEnvelope,
  type Language,
} from '@/lib/schemas';

import styles from './ChatComposer.module.css';

/**
 * The `/chat` client subtree: the thread, the box a farmer types into, and the one open request.
 *
 * Requirements: 15.2 (every indicator is derived from an observed request state — no simulated or
 *               time-based progress), 15.4 (the message the API returned is displayed, and a retry
 *               action is offered for the failed operation), 7.1 / 7.4 (the turn is written to the
 *               conversation the shell resolved, and both sides are persisted by the service),
 *               9.2 (the active language reaches every request), 15.6 (a cause is logged, never
 *               rendered)
 * Design: "Frontend" → screens table — *Optimistic farmer bubble, server-confirmed answer*;
 *         *Honest loading states* → chat awaiting response displays "Jamee is thinking…"
 *
 * ### One piece of state decides whether a request is open
 *
 * `pendingKey` is that state. It is set to the optimistic turn's key immediately before the POST
 * and cleared when the POST settles, so:
 *
 *  - `pendingKey !== null` **is** "a request is open", and it is the only thing the
 *    `loading.thinking` line reads. There is no timer, no interval, no percentage, and no second
 *    boolean that could disagree with it (Requirement 15.2).
 *  - it names *which* optimistic turn the response reconciles against, which is what makes the
 *    server-confirmed `farmerMessageId` land on the right bubble.
 *
 * The thread derives its own per-bubble `aria-busy` from `turn.id === null` rather than from a
 * flag passed down, and the two agree by construction because of the invariant below.
 *
 * ### The invariant: the typed question is in exactly one place
 *
 * At every moment a farmer's question is either **in the composer** (not sent, or sent and
 * failed) or **in the thread** (sent), never both and never neither:
 *
 * ```
 * submit ─▶ append optimistic turn (id: null)  ─▶ clear the box ─▶ POST
 *                                                                  │
 *                        ┌── 200 ──▶ fill in farmerMessageId, append the answer
 *                        │
 *                        └── error ▶ REMOVE the turn, restore the box, show the message
 * ```
 *
 * The removal is the half worth being explicit about: a failed request persisted nothing, so a
 * bubble left behind would be a message a farmer believes Jamee has and a reload would silently
 * delete. Restoring the text into the box is what makes the Send control the retry action
 * Requirement 15.4 asks for — the same reading `ImageUploader` applies to its own failures, where
 * the chosen photo stays chosen.
 *
 * One honest caveat: a request that fails *after* the server committed the rows (a dropped
 * response, a closed tab) removes a bubble whose message really was persisted. The thread is a
 * read of the `messages` table, so a reload shows the truth; inventing a confirmation from a
 * failed response would not.
 *
 * ### Where the error banner is, and where it is not
 *
 * In the form, next to the control that retries it — deliberately **outside** the thread's
 * `aria-live="polite"` region. `role="alert"` is an assertive live region, and nesting one inside
 * a polite one gives two announcements of one event. `ErrorBanner` now owns both that placement
 * rule and the `retryable` treatment, and `DiagnosisPanel` was moved to match this reading.
 */

/* ========================================================================== */
/* The wire contract, in the browser                                           */
/* ========================================================================== */

/**
 * `chatRequestSchema` caps a message at 1000 characters, and Jamee's own composer is what keeps
 * that bound from ever being tested at the edge: `/api/chat` maps an over-long body to
 * `STORAGE_REF_INVALID`, whose copy talks about a photo (a taxonomy gap `route.ts` records and a
 * later task owns). Enforcing the bound here means a farmer never reaches that sentence.
 *
 * Declared as a literal rather than read off the schema's internals, and
 * `ChatComposer.test.tsx` asserts it is exactly the boundary `chatRequestSchema` accepts — so the
 * two cannot drift without a test failing.
 */
export const CHAT_MESSAGE_MAX_LENGTH = 1000;

/**
 * The two things `/api/chat` can answer with, after parsing.
 *
 * Mirrors `DiagnosisOutcome` in `DiagnosisResultCard.tsx`, including the reason for the split:
 * the status code decides which schema is applied, so a 200 carrying an envelope, or a 429
 * carrying a plausible-looking answer, is a parse failure rather than something rendered on the
 * strength of guessing which one it meant.
 *
 * Unlike the diagnosis path there is no third case to think about: an out-of-scope or
 * unanswerable question is a **200** carrying `needsExpert: true` and the repository's own
 * referral copy (Requirements 4.7, 7.6), not an error.
 */
export type ChatOutcome =
  | { kind: 'answer'; response: ChatResponse }
  /** `cause` is the local parse failure when there was one. Logged, never rendered (15.6). */
  | { kind: 'error'; envelope: ErrorEnvelope; cause: unknown };

/**
 * A response Jamee could not make sense of, as a localized envelope.
 *
 * `INTERNAL_ERROR` is the honest code: a 200 that fails `chatResponseSchema`, or a non-2xx whose
 * body is not an error envelope, is Jamee disagreeing with itself. The farmer reads the generic
 * localized sentence and the real cause goes to the console — Requirement 15.6's rule applied on
 * the client side of the same boundary.
 */
function internalFailure(language: Language, cause: unknown): ChatOutcome {
  return {
    kind: 'error',
    envelope: toEnvelope(new AppError('INTERNAL_ERROR'), language),
    cause,
  };
}

/**
 * Turn the raw `/api/chat` response into one of the two outcomes.
 *
 * Exported and free of React so the branch that matters can be asserted over real `Response`
 * objects, the way `readDiagnoseResponse` is.
 */
export async function readChatResponse(
  response: Response,
  language: Language,
): Promise<ChatOutcome> {
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch (cause) {
    return internalFailure(language, cause);
  }

  if (response.ok) {
    const parsed = chatResponseSchema.safeParse(payload);
    return parsed.success
      ? { kind: 'answer', response: parsed.data }
      : internalFailure(language, parsed.error);
  }

  /**
   * Requirements 15.3 and 15.4: the message rendered is the one the API returned, in the language
   * it was asked for. It is not re-derived from the code here — `QUOTA_EXCEEDED` carries a limit
   * and a reset time interpolated server-side, and rebuilding that sentence on the client would
   * give the app two versions of it.
   */
  const envelope = errorEnvelopeSchema.safeParse(payload);
  return envelope.success
    ? { kind: 'error', envelope: envelope.data, cause: undefined }
    : internalFailure(language, envelope.error);
}

/* ========================================================================== */
/* Reconciliation — pure, so the rules are testable without a DOM              */
/* ========================================================================== */

/**
 * The optimistic farmer bubble.
 *
 * `id: null` is the whole of "not persisted yet" (see `ChatTurn`), and `language` is the active
 * one because that is the code the request carries and therefore the language the row will be
 * written with (Requirement 9.2).
 */
export function optimisticTurn(input: {
  key: string;
  content: string;
  language: Language;
  /** The browser's clock. The chat response carries ids, not timestamps. */
  createdAt: string;
}): ChatTurn {
  return {
    key: input.key,
    id: null,
    role: 'farmer',
    content: input.content,
    language: input.language,
    inputKind: 'text',
    createdAt: input.createdAt,
  };
}

/**
 * A confirmed turn: the optimistic bubble gains the server's `farmerMessageId`, and the answer is
 * appended.
 *
 * Two things this does **not** do, both deliberate:
 *
 *  - it does not change the optimistic turn's `key`, so React keeps that `<li>` mounted and the
 *    farmer does not hear their own question announced again (see `ChatTurn`);
 *  - it does not re-order or re-key anything else, so a turn that was already on screen is
 *    untouched.
 *
 * A `pendingKey` that matches nothing leaves the list unchanged apart from the appended answer.
 * That cannot happen from the component — the key it passes is the one it just appended — and
 * failing loudly here would turn a state race into a farmer losing an answer Jamee did produce.
 */
export function confirmedTurns(
  turns: readonly ChatTurn[],
  pendingKey: string,
  response: ChatResponse,
  createdAt: string,
): ChatTurn[] {
  const reconciled = turns.map((turn) =>
    turn.key === pendingKey ? { ...turn, id: response.farmerMessageId } : turn,
  );

  return [
    ...reconciled,
    {
      /** Server-confirmed from the start: this row exists, so its id is its identity. */
      key: response.answer.messageId,
      id: response.answer.messageId,
      role: 'jamee',
      content: response.answer.content,
      /** The language the answer was produced in, echoed by the API (Requirement 9.3). */
      language: response.answer.language,
      inputKind: 'text',
      createdAt,
    },
  ];
}

/**
 * Drop a turn that was never persisted. The other half of Requirement 15.4's honesty: the box
 * gets the text back, so nothing is lost and nothing is claimed.
 */
export function withoutTurn(turns: readonly ChatTurn[], key: string): ChatTurn[] {
  return turns.filter((turn) => turn.key !== key);
}

/* ========================================================================== */
/* The component                                                               */
/* ========================================================================== */

export interface ChatComposerProps {
  /**
   * The farmer's active web conversation, resolved server-side with `findOrCreateActive`.
   *
   * **The client never invents this.** `/api/chat` requires a uuid this farmer owns and answers
   * `CONVERSATION_NOT_FOUND` otherwise, and Requirements 7.1/7.2 key Conversation_Context on it —
   * so a fabricated id would either be refused or, worse, would silently start a thread with no
   * context for a follow-up to resolve against.
   */
  conversationId: string;
  /** The stored conversation, oldest first, from `toChatTurns` in the server shell. */
  initialTurns: readonly ChatTurn[];
  /** IDREF of the screen's heading, so the thread's live region is a named landmark. */
  labelledBy: string;
}

export function ChatComposer({ conversationId, initialTurns, labelledBy }: ChatComposerProps) {
  /**
   * `useJameeRequests()` is the only way to reach `/api/chat`, and it stamps the active language
   * onto the body from context — a caller cannot pass one (Requirement 9.2). Its `language` is
   * also what every string on this control is rendered in.
   */
  const requests = useJameeRequests();
  const { ui, loading } = messages(requests.language);

  const [turns, setTurns] = useState<readonly ChatTurn[]>(initialTurns);
  const [draft, setDraft] = useState('');
  const [failure, setFailure] = useState<ErrorEnvelope | null>(null);
  /** Non-null exactly while a request is open. The only source of the indicator. */
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const fieldId = useId();
  /**
   * A counter, not a uuid: the key only has to be unique within this list for this session, and
   * `crypto.randomUUID()` would add a runtime dependency for no gain. The `local:` prefix is what
   * guarantees no collision with a `messages` row id.
   */
  const localKeys = useRef(0);

  const message = draft.trim();
  const open = pendingKey !== null;
  const sendable = !open && message.length > 0 && message.length <= CHAT_MESSAGE_MAX_LENGTH;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!sendable) return;

    const key = `local:${(localKeys.current += 1)}`;

    /**
     * The optimistic bubble, then the box is cleared: from here the question is in the thread and
     * nowhere else. Both happen before the request so the farmer sees their own words immediately
     * — which is the point of an optimistic render — and neither is undone by anything other than
     * the response.
     */
    setTurns((current) => [
      ...current,
      optimisticTurn({
        key,
        content: message,
        language: requests.language,
        createdAt: new Date().toISOString(),
      }),
    ]);
    setDraft('');
    setFailure(null);
    /** The indicator turns on here, as the POST opens, and nowhere else (Requirement 15.2). */
    setPendingKey(key);

    let outcome: ChatOutcome;
    try {
      const response = await requests.chat({ conversationId, message });
      outcome = await readChatResponse(response, requests.language);
    } catch (cause) {
      /**
       * No response at all — the network failed, or the body failed its own schema before the
       * request was issued. Either way it is Jamee's to report, not the farmer's to interpret.
       */
      outcome = internalFailure(requests.language, cause);
    }

    if (outcome.kind === 'answer') {
      setTurns((current) =>
        confirmedTurns(current, key, outcome.response, new Date().toISOString()),
      );
    } else {
      if (outcome.cause !== undefined) {
        /** Requirement 15.6's client-side half: the cause is logged, never rendered. */
        console.error('[jamee] /api/chat response could not be read', outcome.cause);
      }
      /** Nothing was persisted, so nothing stays on screen pretending it was. */
      setTurns((current) => withoutTurn(current, key));
      /** Requirement 15.4: the retry action is Send, with the same question still in the box. */
      setDraft(message);
      setFailure(outcome.envelope);
    }

    setPendingKey(null);
  }

  return (
    <>
      <ChatThread turns={turns} language={requests.language} labelledBy={labelledBy} />

      <form
        className={styles.form}
        onSubmit={(event) => {
          void onSubmit(event);
        }}
        aria-busy={open}
      >
        <div className={styles.field}>
          {/*
           * A visible label with a real `htmlFor`, not a placeholder standing in for one: the
           * design's accessibility rule is explicit, and a placeholder disappears exactly when a
           * farmer is mid-sentence and most needs to know what the box is for. `askPlaceholder` is
           * the catalog string written for this slot — the key names the slot, not the element.
           */}
          <label className={styles.label} htmlFor={fieldId}>
            {ui.askPlaceholder}
          </label>
          {/*
           * A textarea rather than an input: a farmer describing what a leaf looks like writes
           * more than one line, and `maxLength` is the contract's 1000 characters so a paste is
           * truncated by the browser instead of refused by the API.
           */}
          <textarea
            className={styles.input}
            id={fieldId}
            name="message"
            rows={3}
            maxLength={CHAT_MESSAGE_MAX_LENGTH}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={open}
          />
        </div>

        {/*
         * Requirement 15.4 — the localized message the API returned, verbatim, with `lang` from the
         * envelope so it is pronounced in the language it was written in.
         *
         * `retry: 'control'` is the Send button below: the question is back in the box, so pressing
         * it re-sends exactly the request that failed. `ErrorBanner` renders no second button for
         * that reason, and renders none at all when the envelope says the failure is not retryable.
         */}
        {failure === null ? null : (
          <ErrorBanner error={failure.error} retry={{ kind: 'control' }} />
        )}

        {/*
         * Disabled while a request is open, and while there is nothing to send. Keeping it to one
         * request at a time is what keeps `pendingKey` a single answer to "is Jamee working on
         * something", and it is also the retry control for a failed turn.
         */}
        <button className={styles.primary} type="submit" disabled={!sendable}>
          {ui.send}
        </button>

        {/*
         * "Jamee is thinking…" — real text bound to the open request and nothing else
         * (Requirement 15.2, design: *Honest loading states*). Rendered while idle too: a live
         * region that appears together with its text is not reliably announced, and reserving the
         * line keeps the button from moving under a thumb.
         */}
        <p className={styles.status} role="status">
          {open ? loading.thinking : ''}
        </p>
      </form>
    </>
  );
}
