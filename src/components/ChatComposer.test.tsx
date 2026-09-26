import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  CHAT_MESSAGE_MAX_LENGTH,
  ChatComposer,
  confirmedTurns,
  optimisticTurn,
  readChatResponse,
  withoutTurn,
} from '@/components/ChatComposer';
import { CHAT_HEADING_ID, toChatTurns, type ChatMessageRow } from '@/components/ChatThread';
import { LanguageContext, type LanguageContextValue } from '@/components/LanguageProvider';
import { messages } from '@/lib/messages';
import {
  chatRequestSchema,
  chatResponseSchema,
  type ChatResponse,
  type Language,
} from '@/lib/schemas';

/**
 * Unit tests for the composer: how a `/api/chat` response is read, how the optimistic farmer
 * bubble is reconciled against it, and what the control says before anything has been sent.
 *
 * Requirements: 15.2 (exactly one indicator, bound to the open request, with no simulated or
 *               time-based progress), 15.3 / 15.4 (the returned localized message is displayed
 *               verbatim and a retry action exists), 15.6 (a cause is logged, never rendered),
 *               7.4 (the answer is a persisted message, so its id is its identity)
 *
 * The reconciliation rules are asserted on the exported pure functions rather than through a
 * mounted tree, for the same reason `submitCropImage` was extracted from `ImageUploader`: every
 * rule worth testing here is a rule about *what the list becomes*, and asserting it through the
 * DOM would prove less. The DOM assertions cover what static markup can answer.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const FARMER_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const ANSWER_MESSAGE_ID = '66666666-6666-4666-8666-666666666666';

const STORED_ROW: ChatMessageRow = {
  id: '11111111-1111-4111-8111-111111111111',
  role: 'farmer',
  content: 'What should I spray on my potatoes?',
  language: 'en',
  inputKind: 'text',
  createdAt: '2026-09-15T06:00:00.000Z',
};

function chatResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  /** Parsed rather than trusted, so a fixture that drifts from the contract fails here. */
  return chatResponseSchema.parse({
    conversationId: CONVERSATION_ID,
    farmerMessageId: FARMER_MESSAGE_ID,
    answer: {
      messageId: ANSWER_MESSAGE_ID,
      content: 'Remove the affected leaves and keep the leaves dry.',
      language: 'en',
      groundedIn: ['Potato Late Blight'],
      needsExpert: false,
    },
    quota: {
      operation: 'chat',
      used: 4,
      limit: 50,
      resetsAt: '2026-09-15T18:30:00.000Z',
    },
    ...overrides,
  });
}

const NOW = '2026-09-15T06:05:00.000Z';

/* ========================================================================== */
/* The 1000-character bound                                                    */
/* ========================================================================== */

describe('CHAT_MESSAGE_MAX_LENGTH', () => {
  /**
   * The composer's `maxLength` and the wire contract's `.max(1000)` are two literals, so this is
   * the guard that keeps them one number. A farmer who could type past the contract would reach
   * `STORAGE_REF_INVALID`, whose copy talks about a photo.
   */
  it('is exactly the boundary chatRequestSchema accepts', () => {
    const body = (length: number): unknown => ({
      conversationId: CONVERSATION_ID,
      message: 'x'.repeat(length),
      language: 'en' satisfies Language,
    });

    expect(chatRequestSchema.safeParse(body(CHAT_MESSAGE_MAX_LENGTH)).success).toBe(true);
    expect(chatRequestSchema.safeParse(body(CHAT_MESSAGE_MAX_LENGTH + 1)).success).toBe(false);
  });
});

/* ========================================================================== */
/* Reading the response (Requirements 15.3, 15.4)                              */
/* ========================================================================== */

describe('readChatResponse', () => {
  it('reads a 200 into an answer', async () => {
    const response = chatResponse();
    const outcome = await readChatResponse(Response.json(response), 'en');

    expect(outcome.kind).toBe('answer');
    if (outcome.kind !== 'answer') return;
    expect(outcome.response).toEqual(response);
  });

  /**
   * An out-of-scope referral is a successful answer, not an error (Requirements 4.7, 7.6): the
   * request worked and Jamee answered honestly from the repository's own copy.
   */
  it('reads a needs-expert referral as an answer, not an error', async () => {
    const response = chatResponse({
      answer: {
        messageId: ANSWER_MESSAGE_ID,
        content: messages('en').chat.outOfScope,
        language: 'en',
        groundedIn: [],
        needsExpert: true,
      },
    });

    const outcome = await readChatResponse(Response.json(response), 'en');

    expect(outcome.kind).toBe('answer');
    if (outcome.kind !== 'answer') return;
    expect(outcome.response.answer.needsExpert).toBe(true);
    expect(outcome.response.answer.groundedIn).toEqual([]);
  });

  /**
   * Requirements 15.3 and 15.4 — the message displayed is the one the API returned, not one
   * rebuilt on the client from the code. `QUOTA_EXCEEDED` is the case that proves it: its sentence
   * carries a limit and a reset time interpolated server-side.
   */
  it('reads a non-2xx envelope and keeps the returned message verbatim', async () => {
    const body = {
      error: {
        code: 'QUOTA_EXCEEDED',
        message: 'You have used all 50 of today\u2019s chat requests.',
        language: 'hi' satisfies Language,
        retryable: false,
        details: { limit: 50, used: 50, resetsAt: '2026-09-15T18:30:00.000Z' },
      },
    };

    const outcome = await readChatResponse(Response.json(body, { status: 429 }), 'hi');

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.envelope.error.code).toBe('QUOTA_EXCEEDED');
    expect(outcome.envelope.error.message).toBe(body.error.message);
    expect(outcome.envelope.error.retryable).toBe(false);
    expect(outcome.cause).toBeUndefined();
  });

  /** A conversation id that is not this farmer's comes back as the coded 404, rendered as-is. */
  it('reads CONVERSATION_NOT_FOUND as the envelope it is', async () => {
    const body = {
      error: {
        code: 'CONVERSATION_NOT_FOUND',
        message: messages('en').errors.CONVERSATION_NOT_FOUND,
        language: 'en' satisfies Language,
        retryable: false,
      },
    };

    const outcome = await readChatResponse(Response.json(body, { status: 404 }), 'en');

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.envelope.error.code).toBe('CONVERSATION_NOT_FOUND');
  });

  /**
   * A 200 that fails the response contract is Jamee disagreeing with itself: the farmer gets the
   * generic localized sentence and the real cause is returned for the log (Requirement 15.6).
   */
  it('turns a malformed 200 into a localized INTERNAL_ERROR', async () => {
    const outcome = await readChatResponse(
      Response.json({ conversationId: 'not-a-uuid' }, { status: 200 }),
      'mr',
    );

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.envelope.error.code).toBe('INTERNAL_ERROR');
    expect(outcome.envelope.error.message).toBe(messages('mr').errors.INTERNAL_ERROR);
    expect(outcome.envelope.error.language).toBe('mr');
    expect(outcome.cause).toBeDefined();
  });

  it('turns a body that is not JSON into a localized INTERNAL_ERROR', async () => {
    const outcome = await readChatResponse(
      new Response('<html>gateway timeout</html>', { status: 504 }),
      'en',
    );

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.envelope.error.code).toBe('INTERNAL_ERROR');
    // No provider payload, no markup, no stack trace in what the farmer would read.
    expect(outcome.envelope.error.message).not.toContain('html');
  });
});

/* ========================================================================== */
/* Reconciliation                                                              */
/* ========================================================================== */

describe('the optimistic bubble', () => {
  it('starts with no row id, the active language, and the typed text', () => {
    const turn = optimisticTurn({
      key: 'local:1',
      content: 'Why are the leaves curling?',
      language: 'mr',
      createdAt: NOW,
    });

    expect(turn.id).toBeNull();
    expect(turn.role).toBe('farmer');
    expect(turn.language).toBe('mr');
    expect(turn.content).toBe('Why are the leaves curling?');
    // The key cannot collide with a uuid row id.
    expect(turn.key.startsWith('local:')).toBe(true);
  });

  /**
   * The reconciliation the task turns on: the bubble gains the **server-confirmed**
   * `farmerMessageId`, and it keeps its React key so the `<li>` is not remounted — a re-inserted
   * node inside an `aria-live` region would announce the farmer's own question back at them.
   */
  it('gains the server-confirmed farmerMessageId without changing its key', () => {
    const stored = toChatTurns([STORED_ROW]);
    const pending = optimisticTurn({
      key: 'local:1',
      content: 'Why are the leaves curling?',
      language: 'en',
      createdAt: NOW,
    });

    const next = confirmedTurns([...stored, pending], pending.key, chatResponse(), NOW);

    const farmer = next.find((turn) => turn.key === pending.key);
    expect(farmer?.id).toBe(FARMER_MESSAGE_ID);
    expect(farmer?.content).toBe(pending.content);
    // The turn that was already on screen is untouched.
    expect(next[0]).toEqual(stored[0]);
  });

  /** The answer is a persisted row (Requirement 7.4), so its id is its identity from the start. */
  it('appends the answer keyed by its stored message id', () => {
    const pending = optimisticTurn({
      key: 'local:1',
      content: 'Why are the leaves curling?',
      language: 'en',
      createdAt: NOW,
    });
    const response = chatResponse();

    const next = confirmedTurns([pending], pending.key, response, NOW);

    expect(next).toHaveLength(2);
    const answer = next[1];
    expect(answer?.key).toBe(ANSWER_MESSAGE_ID);
    expect(answer?.id).toBe(ANSWER_MESSAGE_ID);
    expect(answer?.role).toBe('jamee');
    expect(answer?.content).toBe(response.answer.content);
    // The language the answer was produced in, echoed by the API (Requirement 9.3).
    expect(answer?.language).toBe(response.answer.language);
  });

  it('keeps the answer after the question that produced it', () => {
    const pending = optimisticTurn({
      key: 'local:1',
      content: 'Why are the leaves curling?',
      language: 'en',
      createdAt: NOW,
    });

    const next = confirmedTurns([pending], pending.key, chatResponse(), NOW);

    expect(next.map((turn) => turn.role)).toEqual(['farmer', 'jamee']);
  });

  /**
   * A failed request persisted nothing, so the bubble goes. A phantom left behind would be a
   * message a farmer believes Jamee has, and a reload would silently delete it.
   */
  it('removes the phantom bubble and nothing else on a failure', () => {
    const stored = toChatTurns([STORED_ROW]);
    const pending = optimisticTurn({
      key: 'local:1',
      content: 'Why are the leaves curling?',
      language: 'en',
      createdAt: NOW,
    });

    const next = withoutTurn([...stored, pending], pending.key);

    expect(next).toEqual(stored);
    expect(next.some((turn) => turn.id === null)).toBe(false);
  });
});

/* ========================================================================== */
/* The control                                                                 */
/* ========================================================================== */

describe('ChatComposer', () => {
  function renderComposer(language: Language): string {
    const value: LanguageContextValue = { language, setLanguage: () => {} };
    return renderToStaticMarkup(
      <LanguageContext.Provider value={value}>
        <ChatComposer
          conversationId={CONVERSATION_ID}
          initialTurns={toChatTurns([STORED_ROW])}
          labelledBy={CHAT_HEADING_ID}
        />
      </LanguageContext.Provider>,
    );
  }

  it('renders the stored conversation inside the named live region', () => {
    const markup = renderComposer('en');

    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain(`aria-labelledby="${CHAT_HEADING_ID}"`);
    expect(markup).toContain(STORED_ROW.content);
  });

  /**
   * Requirement 15.2 — exactly one `role="status"`, empty until a request is open, and nothing
   * time-driven anywhere in the flow. The line is present while idle because a live region that
   * appears together with its text is not reliably announced.
   */
  it('renders one empty status line and no simulated progress', () => {
    const markup = renderComposer('en');

    expect([...markup.matchAll(/role="status"/g)]).toHaveLength(1);
    expect(markup).not.toContain(messages('en').loading.thinking);
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain('<progress');
  });

  /** Nothing to send yet, so the control that would send it is disabled rather than misleading. */
  it('disables the send control until something has been typed', () => {
    const markup = renderComposer('en');
    const button = /<button([^>]*)>/.exec(markup);

    expect(button?.[1]).toContain('disabled');
  });

  /** A real visible label with a real `htmlFor`, not a placeholder standing in for one. */
  it('labels the message field visibly, in every language', () => {
    for (const language of ['en', 'hi', 'mr'] satisfies readonly Language[]) {
      const markup = renderComposer(language);
      const { ui } = messages(language);
      const fieldId = /<label[^>]*for="([^"]+)"/.exec(markup)?.[1];

      expect(markup).toContain(ui.askPlaceholder);
      expect(markup).toContain(ui.send);
      expect(fieldId).toBeDefined();
      expect(markup).toContain(`id="${fieldId ?? ''}"`);
    }
  });

  /** The contract's bound is on the control, so the API's photo-flavoured 400 is unreachable. */
  it('caps the field at the contract length', () => {
    expect(renderComposer('en').toLowerCase()).toContain(
      `maxlength="${CHAT_MESSAGE_MAX_LENGTH}"`,
    );
  });

  /** Nothing is claimed before a request: no error banner on a screen nobody has used yet. */
  it('renders no error banner before anything has been sent', () => {
    expect(renderComposer('en')).not.toContain('role="alert"');
  });
});
