import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  CHAT_HEADING_ID,
  CHAT_MESSAGE_LIMIT,
  CHAT_MESSAGES_SELECT,
  ChatThread,
  toChatTurns,
  type ChatMessageRow,
  type ChatTurn,
} from '@/components/ChatThread';
import { messages } from '@/lib/messages';
import { SUPPORTED_LANGUAGES, type Language } from '@/lib/schemas';

/**
 * Unit tests for what the chat thread says, and for the ordering of what it is given.
 *
 * Requirements: 15.2 (no indicator and no simulated progress in this module), 9.3 / 9.4 (each
 *               message is rendered in the language it was written in while the furniture follows
 *               the switcher), 7.1 / 7.4 (the thread is the persisted conversation, oldest first)
 *
 * Rendered to static markup rather than mounted, following `DiagnosisResultCard.test.tsx`: this
 * project has no React testing library, and the questions here are about what the DOM says.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const FARMER_ROW: ChatMessageRow = {
  id: '11111111-1111-4111-8111-111111111111',
  role: 'farmer',
  content: 'My tomato leaves have dark patches.',
  language: 'en',
  input_kind: 'text',
  created_at: '2026-09-15T06:00:00.000Z',
};

const ANSWER_ROW: ChatMessageRow = {
  id: '22222222-2222-4222-8222-222222222222',
  role: 'jamee',
  content: 'Those patches suggest late blight. Remove the affected leaves.',
  language: 'en',
  input_kind: 'text',
  created_at: '2026-09-15T06:00:05.000Z',
};

const VOICE_ROW: ChatMessageRow = {
  id: '33333333-3333-4333-8333-333333333333',
  role: 'farmer',
  content: '\u092E\u093E\u091D\u094D\u092F\u093E \u091F\u094B\u092E\u0945\u091F\u094B\u0935\u0930 \u0921\u093E\u0917 \u0906\u0939\u0947\u0924.',
  language: 'mr',
  input_kind: 'voice',
  created_at: '2026-09-15T06:01:00.000Z',
};

/** The rows as the query returns them: newest first. */
const ROWS_NEWEST_FIRST: readonly ChatMessageRow[] = [VOICE_ROW, ANSWER_ROW, FARMER_ROW];

function render(
  turns: readonly ChatTurn[],
  language: Language = 'en',
): string {
  return renderToStaticMarkup(
    <ChatThread turns={turns} language={language} labelledBy={CHAT_HEADING_ID} />,
  );
}

/** Text as it reads to a farmer: tags removed, entities that matter decoded. */
function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ========================================================================== */
/* toChatTurns                                                                 */
/* ========================================================================== */

describe('toChatTurns', () => {
  /**
   * The read is descending so the limit drops the oldest messages; a conversation reads
   * oldest-first. Exactly one of the two has to reverse, and this is it.
   */
  it('turns newest-first rows into a chronological thread', () => {
    const turns = toChatTurns(ROWS_NEWEST_FIRST);

    expect(turns.map((turn) => turn.id)).toEqual([FARMER_ROW.id, ANSWER_ROW.id, VOICE_ROW.id]);
    expect(turns.map((turn) => turn.createdAt)).toEqual([
      FARMER_ROW.created_at,
      ANSWER_ROW.created_at,
      VOICE_ROW.created_at,
    ]);
  });

  it('does not mutate the rows it is given', () => {
    const rows = [...ROWS_NEWEST_FIRST];
    toChatTurns(rows);
    expect(rows).toEqual(ROWS_NEWEST_FIRST);
  });

  /** A stored row is server-confirmed by definition, so `id` is set and the key is that id. */
  it('carries the row id as both the identity and the React key', () => {
    const [first] = toChatTurns([FARMER_ROW]);

    expect(first?.id).toBe(FARMER_ROW.id);
    expect(first?.key).toBe(FARMER_ROW.id);
    expect(first?.role).toBe('farmer');
    expect(first?.inputKind).toBe('text');
  });

  /** Requirement 9.3 — the row's own language travels with it, not the screen's. */
  it('keeps each row\u2019s own language', () => {
    const turns = toChatTurns([VOICE_ROW, FARMER_ROW]);

    expect(turns.map((turn) => turn.language)).toEqual(['en', 'mr']);
  });

  it('reads an empty conversation as an empty thread', () => {
    expect(toChatTurns([])).toEqual([]);
  });
});

/* ========================================================================== */
/* The read contract                                                           */
/* ========================================================================== */

describe('the read contract', () => {
  /**
   * The select must name every column `ChatTurn` is built from — and must not name
   * `transcript_of`, which is a storage path this screen never reads.
   */
  it('selects exactly the columns the thread renders', () => {
    const columns = CHAT_MESSAGES_SELECT.split(',').map((column) => column.trim());

    expect(columns).toEqual(['id', 'role', 'content', 'language', 'input_kind', 'created_at']);
    expect(columns).not.toContain('transcript_of');
  });

  /** The bound drops the oldest messages, so it has to be large enough to be a bound. */
  it('bounds the thread well above one day of chat quota', () => {
    expect(CHAT_MESSAGE_LIMIT).toBeGreaterThan(50);
  });
});

/* ========================================================================== */
/* Rendering                                                                   */
/* ========================================================================== */

describe('ChatThread', () => {
  /**
   * A polite live region inserted together with its content is not reliably announced, so the
   * region — named by the screen's heading — is in the DOM before there is anything in it.
   */
  it('renders a named aria-live landmark for an empty conversation', () => {
    const markup = render([]);
    const section = /<section([^>]*)>/.exec(markup);

    expect(section?.[1]).toContain('aria-live="polite"');
    expect(section?.[1]).toContain(`aria-labelledby="${CHAT_HEADING_ID}"`);
    // Nothing is claimed about a conversation that has not started.
    expect(markup).not.toContain('<ol');
    expect(markup).not.toContain('<li');
  });

  it('renders one ordered list item per turn, oldest first', () => {
    const markup = render(toChatTurns(ROWS_NEWEST_FIRST));

    expect(markup).toContain('<ol');
    expect([...markup.matchAll(/<li/g)]).toHaveLength(3);
    expect(markup.indexOf(FARMER_ROW.content)).toBeLessThan(markup.indexOf(ANSWER_ROW.content));
  });

  /** The speaker is carried by label text, never by alignment or colour alone. */
  it('names the speaker in words, localized to the active language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const { ui } = messages(language);
      const text = textOf(render(toChatTurns([ANSWER_ROW, FARMER_ROW]), language));

      expect(text).toContain(ui.roleFarmer);
      expect(text).toContain(ui.roleJamee);
    }
  });

  /**
   * Requirement 9.3 — the message body is marked with its stored language while the furniture
   * around it follows the switcher. Both halves in one assertion, because "the message kept its
   * language" only means something if the labels changed.
   */
  it('marks each message with its own language, not the screen\u2019s', () => {
    const markup = render(toChatTurns([VOICE_ROW, FARMER_ROW]), 'en');

    expect(markup).toContain('lang="mr"');
    expect(markup).toContain('lang="en"');
    expect(textOf(markup)).toContain(messages('en').ui.roleFarmer);
  });

  /** Requirement 8.6 — a voice turn is labelled as what Jamee heard. */
  it('labels a voice turn with the transcript label', () => {
    const text = textOf(render(toChatTurns([VOICE_ROW])));

    expect(text).toContain(messages('en').ui.transcriptLabel);
  });

  /**
   * The optimistic bubble: no row id yet, so the item is marked busy. The sentence that says what
   * is happening belongs to the composer, so there is no status text here.
   */
  it('marks an unconfirmed turn busy and a confirmed one not', () => {
    const [confirmed] = toChatTurns([FARMER_ROW]);
    if (confirmed === undefined) throw new Error('fixture produced no turn');
    const optimistic: ChatTurn = { ...confirmed, key: 'local:1', id: null };

    expect(render([optimistic])).toContain('aria-busy="true"');
    expect(render([confirmed])).not.toContain('aria-busy');
  });

  /**
   * Requirement 15.2 — the one honest indicator lives in the composer, which owns the request.
   * Nothing here is time-driven and there is no percentage to advance.
   */
  it('adds no indicator and no simulated progress', () => {
    const markup = render(toChatTurns(ROWS_NEWEST_FIRST));

    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain('<progress');
    expect(markup).not.toContain(messages('en').loading.thinking);
  });

  /**
   * A timestamp a screen reader and a browser can both use. Compared case-insensitively because
   * the attribute's spelling in the serialized output is React's business, not this screen's.
   */
  it('renders each turn\u2019s instant as a machine-readable time', () => {
    const markup = render(toChatTurns([FARMER_ROW])).toLowerCase();

    expect(markup).toContain(`datetime="${FARMER_ROW.created_at.toLowerCase()}"`);
  });
});
