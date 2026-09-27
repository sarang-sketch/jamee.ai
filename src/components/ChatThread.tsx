import { messages } from '@/lib/messages';
import type { InputKind, Language, MessageRole } from '@/lib/schemas';
import { formatInstant } from '@/lib/time';

import styles from './ChatThread.module.css';

/**
 * The conversation a farmer reads on `/chat`: their questions and Jamee's answers, oldest first.
 *
 * Requirements: 15.2 (nothing here is time-driven, and there is no percentage to advance),
 *               15.4 (the error belongs to the composer, which owns the request — see below),
 *               7.4 (both sides of a turn are persisted Messages, so this list is a read of the
 *               `messages` table rather than a client-side log), 9.3 / 9.4 (each message is
 *               rendered in the language it was written in)
 * Design: "Frontend" → screens table — `/chat` is a **server shell** that loads the conversation
 *          and its messages via RLS plus a client composer; *Mobile layout and accessibility*
 *
 * ### Deliberately NOT a client component
 *
 * There is no `'use client'` here, and that is load-bearing rather than an omission. The server
 * shell (`src/app/chat/page.tsx`) imports `CHAT_MESSAGE_LIMIT` and `toChatTurns` and calls them
 * **during the server render**; every export of a `'use client'` module becomes a client reference
 * when a server component imports it, so `toChatTurns` would arrive as a proxy and throw. Keeping
 * this module directive-free lets one file hold the view contract and the rendering of what it
 * returns, and `ChatComposer` (which *is* a client component) pulls it into the browser bundle by
 * importing it.
 *
 * Everything imported here is isomorphic for the same reason: the catalogs are literals and
 * `formatInstant` is `Intl` pinned to `Asia/Kolkata`, so a server render and a client render of
 * the same turn produce byte-identical text and there is no hydration mismatch to paper over.
 *
 * ### What this component does not own
 *
 * No request, no state, no indicator, and no error banner. `ChatComposer` holds the one open
 * request, so it holds the single `role="status"` line and the `role="alert"` message
 * (Requirements 15.2, 15.4). A thread that rendered its own "is something in flight?" from a
 * second piece of state is how one of the two ends up wrong — the same reasoning
 * `DiagnosisResultCard` records for not adding a second indicator beside `ImageUploader`'s.
 */

/* ========================================================================== */
/* The read contract                                                           */
/* ========================================================================== */

/**
 * The message fields the thread renders, as an Amendment A3 view row.
 *
 * *Amended by A3:* this was a `Pick<MessageRow, …>` paired with a PostgREST `CHAT_MESSAGES_SELECT`
 * string. Under A3 there is no PostgREST and no generated row type — the chat server shell reads
 * `messages` through the owner-scoped Data_Access_Layer and maps each `MessageDoc` to this shape.
 * So the select-string export is gone (nothing parses one now), and this is a small explicit view
 * model in the fields the thread actually uses: the row `id` as a hex string, `role`, `content`,
 * the stored `language`, the `inputKind`, and the `createdAt` instant as ISO-8601. `transcriptOf`
 * stays out — a reference to a recording this screen never loads has no business in a page's props.
 */
export interface ChatMessageRow {
  id: string;
  role: MessageRole;
  content: string;
  language: Language;
  inputKind: InputKind;
  /** ISO-8601 — `messages.createdAt` rendered by `formatInstant`. */
  createdAt: string;
}

/**
 * How many stored messages the screen loads.
 *
 * Requirement 14.1 caps a farmer at 50 chat messages a day, so this is several days of continuous
 * conversation, and the read is newest-first so the bound drops the **oldest** rather than
 * truncating the end a farmer is reading toward. `DETAIL_MESSAGE_LIMIT` in
 * `src/app/diagnosis/detail.ts` happens to carry the same number for its own screen; they are
 * separate bounds on separate reads, and neither should start importing the other's.
 */
export const CHAT_MESSAGE_LIMIT = 200;

/**
 * The IDREF that names the thread's live region.
 *
 * A `<section>` with no accessible name is not a landmark, and the design requires the region a
 * screen reader announces into to be one. Rather than an off-screen duplicate heading, the region
 * points at the screen's own visible `<h1>` — so the name a screen reader reads is the same words
 * a sighted farmer sees. A module constant rather than `useId()` because the two ends of the
 * reference live in different components (the server shell renders the heading, the client subtree
 * renders the region), and the screen renders exactly one of each.
 */
export const CHAT_HEADING_ID = 'jamee-chat-heading';

/* ========================================================================== */
/* The view model                                                              */
/* ========================================================================== */

/**
 * One message as the thread renders it.
 *
 * ### `key` and `id` are two different things, on purpose
 *
 * `id` is the **persisted row id**, and `null` means "this turn is not in the database yet" — the
 * optimistic farmer bubble, for exactly as long as its request is open. That is the only signal
 * the thread needs in order to mark a turn as in flight, which is why it does not take a second
 * "pending" prop.
 *
 * `key` is React's identity for the list item and it is **stable for the life of the turn**,
 * including across the confirmation that fills `id` in. Reusing the row id as the key would
 * change it at confirmation, React would unmount and remount that `<li>`, and an insertion into
 * an `aria-live` region is an announcement — so a farmer would hear their own question read back
 * to them the moment it was persisted. A locally created turn keeps its `local:` key forever; a
 * turn read from the database uses its row id, which cannot collide with that prefix.
 */
export interface ChatTurn {
  readonly key: string;
  /** The `messages` row id, or `null` while the turn is only optimistic. */
  readonly id: string | null;
  readonly role: MessageRole;
  readonly content: string;
  /** The language this message was written in, which is not necessarily today's selection. */
  readonly language: Language;
  readonly inputKind: InputKind;
  /**
   * ISO-8601. For a stored turn this is `messages.created_at`; for a turn created in this session
   * it is the browser's own clock, because the chat response carries message ids and not
   * timestamps. A reload replaces it with the stored instant, which is the authoritative one.
   */
  readonly createdAt: string;
}

/**
 * Stored rows, as the thread wants them.
 *
 * **Takes the rows in the order the query returns them — newest first — and returns them
 * chronologically.** The read is descending because `CHAT_MESSAGE_LIMIT` has to drop the oldest
 * messages rather than the newest, and a conversation reads oldest-first, so exactly one of the
 * two has to reverse. Doing it here rather than at the call site keeps the decision testable and
 * keeps the page from being the place where an ordering bug hides.
 */
export function toChatTurns(rowsNewestFirst: readonly ChatMessageRow[]): ChatTurn[] {
  return [...rowsNewestFirst].reverse().map((row) => ({
    key: row.id,
    id: row.id,
    role: row.role,
    content: row.content,
    language: row.language,
    inputKind: row.inputKind,
    createdAt: row.createdAt,
  }));
}

/* ========================================================================== */
/* The component                                                               */
/* ========================================================================== */

export interface ChatThreadProps {
  /** Oldest first. An unconfirmed turn (`id === null`) may only be the last one. */
  turns: readonly ChatTurn[];
  /**
   * The active UI language. The speaker labels and the timestamps are screen furniture and follow
   * the switcher; each message's own text follows its stored language instead (Requirement 9.3).
   */
  language: Language;
  /** IDREF of the screen's heading. Required, so a screen cannot leave the region unnamed. */
  labelledBy: string;
}

export function ChatThread({ turns, language, labelledBy }: ChatThreadProps) {
  const { ui } = messages(language);

  return (
    /**
     * The live region, and it is in the DOM from the **first** render — including while the
     * conversation is empty. A polite region inserted together with its content is not reliably
     * announced, so the empty `<section>` is what makes an arriving answer get read out.
     *
     * `aria-live="polite"` rather than `role="log"`: support for `log` is uneven across the mobile
     * screen readers this pilot targets, and the design names a polite region specifically. The
     * default `aria-relevant` ("additions text") is what announces an appended `<li>` and stays
     * quiet about the history that was already there on load.
     */
    <section className={styles.thread} aria-live="polite" aria-labelledby={labelledBy}>
      {turns.length === 0 ? null : (
        /**
         * An ordered list, because the order carries meaning: a follow-up question only makes
         * sense after the answer it follows (Requirements 7.1, 7.2). A `<div>` stack would leave
         * a screen reader to infer the sequence and would not announce the count.
         */
        <ol className={styles.list}>
          {turns.map((turn) => {
            const fromFarmer = turn.role === 'farmer';
            /** No row id yet ⇒ this turn's request is still open. See `ChatTurn.id`. */
            const unconfirmed = turn.id === null;

            return (
              <li
                key={turn.key}
                className={[
                  fromFarmer ? styles.fromFarmer : styles.fromJamee,
                  ...(unconfirmed ? [styles.unconfirmed] : []),
                ].join(' ')}
                /**
                 * Bound to the real request through `id`, not to a timer. `aria-busy` is the
                 * per-item counterpart of the composer's one `role="status"` line; the sentence a
                 * farmer reads lives there, and this only stops a screen reader from presenting a
                 * bubble as settled while its request is still open.
                 */
                aria-busy={unconfirmed || undefined}
              >
                <p className={styles.speaker}>
                  {/*
                   * Requirement 15.4's accessibility note applied to the thread: who spoke is
                   * carried by LABEL TEXT, never by alignment or colour alone. A farmer reading a
                   * Devanagari thread on a narrow phone, or listening to it, gets the speaker
                   * stated in words.
                   */}
                  {fromFarmer ? ui.roleFarmer : ui.roleJamee}
                  {/* Requirement 8.6 — a voice turn is labelled as what Jamee heard. */}
                  {turn.inputKind === 'voice' ? ` \u00B7 ${ui.transcriptLabel}` : ''}
                </p>
                {/*
                 * `lang` from the message's own stored language, not from the switcher: a farmer
                 * who switches to English after asking in Marathi still has a Marathi sentence on
                 * screen, and Devanagari announced under `lang="en"` is mispronounced or skipped.
                 */}
                <p className={styles.body} lang={turn.language}>
                  {turn.content}
                </p>
                {/*
                 * `formatInstant` is the one formatter for a stored instant (`src/lib/time.ts`),
                 * pinned to Asia/Kolkata so a server render and a client render agree. `dateTime`
                 * carries the machine-readable value either way.
                 */}
                <time className={styles.time} dateTime={turn.createdAt}>
                  {formatInstant(turn.createdAt, language)}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
