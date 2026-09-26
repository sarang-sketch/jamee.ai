import type { NextRequest } from 'next/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JAMEE_MAX_DURATION_SECONDS, PLATFORM_MAX_DURATION_SECONDS } from '@/lib/config/verified';
import { AppError } from '@/lib/errors';
import { messages } from '@/lib/messages';
import {
  SUPPORTED_LANGUAGES,
  chatResponseSchema,
  errorEnvelopeSchema,
  type ChatAnswer,
  type ChatInput,
  type QuotaStatus,
} from '@/lib/schemas';
import type { ChatTurnDeps, ChatTurnResult } from '@/services/chat.service';

import { POST, maxDuration } from './route';

/**
 * Wiring tests for `src/app/api/chat/route.ts`.
 *
 * Requirements: 1.7 (no session → 401 and no domain service invoked), 9.5 (a language outside
 *               en/hi/mr is 400 naming the supported codes), 14.1 (the route opts out of nothing —
 *               no `skipQuotaReserve`, no coverage), 15.3 (one localized envelope), 16.5 (`channel`
 *               reaches the service as an input parameter)
 *
 * `chat.service.test.ts` already decides what a turn *is* — the ordered spend, the referral refund,
 * the two persisted rows. What only this file can decide is what the **route** does with it, so the
 * service is a spy here and the assertions are about the boundary: was it reached, how many times,
 * with whose identity, with which client, and what came back on the wire.
 *
 * The two strongest tests are negative. A 401 that also proves `chatTurn` was never entered is
 * Requirement 1.7's actual claim; a 400 that proves the same is Requirement 9.5's.
 */

/* -------------------------------------------------------------------------- */
/* Seams                                                                       */
/* -------------------------------------------------------------------------- */

const spies = vi.hoisted(() => ({
  currentUserId: vi.fn(),
  createServerSupabase: vi.fn(),
  chatTurn: vi.fn(),
}));

/**
 * The identity resolver the route's wrapper was built over. Mocking the module rather than the
 * wrapper keeps the real guard under test — the route imports the real `authenticatedRoute`, and only
 * the answer to "who is signed in" is stubbed.
 */
vi.mock('@/lib/supabase/server', () => ({
  currentUserId: spies.currentUserId,
  createServerSupabase: spies.createServerSupabase,
}));

/**
 * Amendment A3 rewire: `authenticatedRoute` resolves identity through `@/lib/auth/session`'s
 * `currentUserId` (Better Auth). The same spy backs both paths so the gate stays stubbed while the
 * real wrapper is under test; `createServerSupabase` above is still the route's RLS client source
 * until the route is ported (task 56).
 */
vi.mock('@/lib/auth/session', () => ({
  currentUserId: spies.currentUserId,
}));

/**
 * The service, as a tripwire by default. Every test that expects a refusal leaves this rejecting, so
 * a route that reached the service would fail twice: once on the recorded call and once on the
 * status, because the throw would have become a 500.
 */
vi.mock('@/services/chat.service', () => ({ chatTurn: spies.chatTurn }));

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const USER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const FARMER_MESSAGE_ID = '66666666-6666-4666-8666-666666666666';
const ANSWER_MESSAGE_ID = '77777777-7777-4777-8777-777777777777';

/** A sentinel, so "the RLS-scoped server client was passed through" is an identity assertion. */
const SUPABASE = { tag: 'rls-scoped-server-client' };

const QUOTA: QuotaStatus = {
  operation: 'chat',
  used: 7,
  limit: 50,
  resetsAt: '2026-09-16T18:30:00.000Z',
};

const ANSWER: ChatAnswer = {
  messageId: ANSWER_MESSAGE_ID,
  content: 'Early blight spreads in warm, humid weather.',
  language: 'hi',
  groundedIn: ['Tomato Early Blight'],
  needsExpert: false,
};

const RESULT: ChatTurnResult = {
  conversationId: CONVERSATION_ID,
  farmerMessageId: FARMER_MESSAGE_ID,
  answer: ANSWER,
  quota: QUOTA,
};

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { conversationId: CONVERSATION_ID, message: 'why?', language: 'hi', ...overrides };
}

/** The handler takes a `NextRequest`; a plain `Request` carries everything this route reads. */
function post(body: unknown, options: { raw?: string } = {}): Promise<Response> {
  const request = new Request('https://jamee.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: options.raw ?? JSON.stringify(body),
  });
  return POST(request as NextRequest);
}

async function envelopeOf(response: Response) {
  return errorEnvelopeSchema.parse(await response.json());
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.currentUserId.mockResolvedValue(USER);
  spies.createServerSupabase.mockResolvedValue(SUPABASE);
  spies.chatTurn.mockRejectedValue(
    new Error('tripwire: chatTurn was reached for a request that must not reach it'),
  );
});

/* ========================================================================== */
/* Requirement 1.7 — the gate                                                  */
/* ========================================================================== */

describe('POST /api/chat with no session', () => {
  it('returns 401 and invokes no service, not even the Supabase client factory', async () => {
    spies.currentUserId.mockResolvedValue(null);

    const response = await post(validBody());
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(401);
    expect(envelope.error.code).toBe('AUTH_REQUIRED');

    /** The clause that matters: no domain service, and no request-scoped client either. */
    expect(spies.chatTurn).not.toHaveBeenCalled();
    expect(spies.createServerSupabase).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* A valid body reaches the service exactly once                                */
/* ========================================================================== */

describe('POST /api/chat with a valid body', () => {
  it('calls the service once with the session user id, web channel, and the RLS-scoped client', async () => {
    spies.chatTurn.mockResolvedValue(RESULT);

    const response = await post(validBody());

    expect(response.status).toBe(200);
    expect(spies.chatTurn).toHaveBeenCalledTimes(1);

    /**
     * Deep equality on both arguments, which is what makes this a contract test rather than a smoke
     * test:
     *  - `userId` is the resolved session id. A route that read an id out of the body would fail
     *    here, and Requirement 13.2 is exactly that distinction.
     *  - `channel: 'web'` and `inputKind: 'text'` are on the input, so Requirement 16.5's columns and
     *    0003's `input_kind` are populated from the route rather than defaulted downstream.
     *  - `skipQuotaReserve` is ABSENT. Requirement 14.1's nesting rule only ever relaxes the reserve
     *    for a turn nested inside a voice request, and an extra key here would fail this assertion.
     *  - `deps` is `{ supabase, burst }` and nothing else — no store, no admin client. The
     *    `usage_logs` audit client is the service's own business (migration 0006 grants
     *    `authenticated` no insert policy). `burst` is Requirement 13.8's limiter, which the API_Layer
     *    binds because it is the API_Layer the requirement is written about; the *position* of the
     *    check (before the reserve) stays the service's.
     */
    const expectedInput: ChatInput = {
      userId: USER,
      conversationId: CONVERSATION_ID,
      message: 'why?',
      language: 'hi',
      channel: 'web',
      inputKind: 'text',
    };
    const [, deps] = spies.chatTurn.mock.calls[0] ?? [];
    expect(Object.keys(deps as ChatTurnDeps).sort()).toEqual(['burst', 'supabase']);
    expect((deps as ChatTurnDeps).supabase).toBe(SUPABASE);
    expect(typeof (deps as ChatTurnDeps).burst).toBe('function');
    expect(spies.chatTurn.mock.calls[0]?.[0]).toEqual(expectedInput);
  });

  it('passes no quota coverage, so the service reads the request as its own entry point', async () => {
    spies.chatTurn.mockResolvedValue(RESULT);

    await post(validBody());

    /**
     * Two arguments, not three. The third parameter of `chatTurn` is a `QuotaContext`, and omitting
     * it *is* the statement "this request enters here" — a route that supplied one would be making a
     * spend decision that belongs to the service.
     */
    expect(spies.chatTurn.mock.calls[0]).toHaveLength(2);
  });

  it('serializes exactly the four response fields', async () => {
    spies.chatTurn.mockResolvedValue(RESULT);

    const response = await post(validBody());
    const payload: unknown = await response.json();

    expect(response.headers.get('content-type')).toContain('application/json');
    expect(chatResponseSchema.parse(payload)).toEqual({
      conversationId: CONVERSATION_ID,
      farmerMessageId: FARMER_MESSAGE_ID,
      answer: ANSWER,
      quota: QUOTA,
    });
    expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual([
      'answer',
      'conversationId',
      'farmerMessageId',
      'quota',
    ]);
  });

  it('returns the out-of-scope referral as a 200 with needsExpert set', async () => {
    /**
     * Requirement 4.7 is not an error: the farmer gets the coverage statement and an expert
     * recommendation, and `needsExpert` is how a client knows to show it that way. The service makes
     * no model call on this path, which `chat.service.test.ts` asserts; what matters here is that the
     * route does not translate it into a failure.
     */
    const referral: ChatTurnResult = {
      ...RESULT,
      answer: {
        messageId: ANSWER_MESSAGE_ID,
        content: messages('hi').chat.outOfScope,
        language: 'hi',
        groundedIn: [],
        needsExpert: true,
      },
    };
    spies.chatTurn.mockResolvedValue(referral);

    const response = await post(validBody());
    const payload = chatResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(payload.answer.needsExpert).toBe(true);
    expect(payload.answer.groundedIn).toEqual([]);
    expect(payload.answer.content).toBe(messages('hi').chat.outOfScope);
  });
});

/* ========================================================================== */
/* Requirement 9.5 — an unsupported language                                   */
/* ========================================================================== */

describe('POST /api/chat with an unsupported language', () => {
  it('returns 400 naming the three supported codes, and calls no service', async () => {
    const response = await post(validBody({ language: 'ta' }));
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(400);
    expect(envelope.error.code).toBe('LANGUAGE_UNSUPPORTED');
    expect(envelope.error.details?.supportedLanguages).toEqual([...SUPPORTED_LANGUAGES]);
    expect(envelope.error.details?.supportedLanguages).toEqual(['en', 'hi', 'mr']);
    expect(spies.chatTurn).not.toHaveBeenCalled();
  });

  it('accepts each of the three supported codes', async () => {
    spies.chatTurn.mockResolvedValue(RESULT);

    for (const language of SUPPORTED_LANGUAGES) {
      const response = await post(validBody({ language }));
      expect(response.status, language).toBe(200);
    }
  });
});

/* ========================================================================== */
/* A malformed body                                                            */
/* ========================================================================== */

describe('POST /api/chat with a malformed body', () => {
  it('returns 404 CONVERSATION_NOT_FOUND for an absent or non-uuid conversation id', async () => {
    /**
     * The same code the service raises for an id that is not this farmer's — one code for one
     * meaning, so the response cannot be used as an oracle for which conversations exist.
     */
    const cases = [
      { label: 'absent', send: () => post({ message: 'why?', language: 'hi' }) },
      { label: 'not a uuid', send: () => post(validBody({ conversationId: 'thread-1' })) },
    ];

    for (const { label, send } of cases) {
      const response = await send();
      const envelope = await envelopeOf(response);

      expect(response.status, label).toBe(404);
      expect(envelope.error.code, label).toBe('CONVERSATION_NOT_FOUND');
    }

    expect(spies.chatTurn).not.toHaveBeenCalled();
  });

  it('returns 400 for an absent, empty or oversized message, and for non-JSON', async () => {
    const oversized = 'क'.repeat(1001);

    const cases = [
      { label: 'no message', send: () => post({ conversationId: CONVERSATION_ID, language: 'hi' }) },
      { label: 'empty message', send: () => post(validBody({ message: '' })) },
      { label: 'over 1000 characters', send: () => post(validBody({ message: oversized })) },
      { label: 'not JSON at all', send: () => post(null, { raw: 'not json' }) },
    ];

    for (const { label, send } of cases) {
      const response = await send();
      const envelope = await envelopeOf(response);

      expect(response.status, label).toBe(400);
      /**
       * The taxonomy gap this expectation used to record is closed (task 25.2). It was
       * `STORAGE_REF_INVALID`, whose sentence names a photo — the wrong noun on an endpoint that
       * takes a typed question. The status and the flag were already right, so closing it changed
       * only the code and the sentence a farmer reads.
       */
      expect(envelope.error.code, label).toBe('MESSAGE_INVALID');
      expect(envelope.error.retryable, label).toBe(false);
      /** Requirement 15.3 — and in the language the body asked for, which is `hi` here. */
      expect(envelope.error.message.length, label).toBeGreaterThan(0);
    }

    expect(spies.chatTurn).not.toHaveBeenCalled();
  });

  it('accepts a message at exactly the 1000-character contract boundary', async () => {
    spies.chatTurn.mockResolvedValue(RESULT);

    const response = await post(validBody({ message: 'a'.repeat(1000) }));

    expect(response.status).toBe(200);
    expect(spies.chatTurn).toHaveBeenCalledTimes(1);
  });
});

/* ========================================================================== */
/* Requirement 15.3 — the envelope, in the body's language                     */
/* ========================================================================== */

describe('POST /api/chat when the service declines', () => {
  it('renders QUOTA_EXCEEDED as 429 in the language the body asked for', async () => {
    spies.chatTurn.mockRejectedValue(
      new AppError('QUOTA_EXCEEDED', {
        details: { limit: 50, used: 50, resetsAt: QUOTA.resetsAt },
        context: { operation: 'chat' },
      }),
    );

    const response = await post(validBody({ language: 'mr' }));
    const envelope = await envelopeOf(response);

    /** The status comes from the taxonomy, so the route holds no HTTP code of its own. */
    expect(response.status).toBe(429);
    expect(envelope.error.code).toBe('QUOTA_EXCEEDED');
    /** Requirement 14.3 — the limit and the reset instant travel structured, not baked into prose. */
    expect(envelope.error.details?.limit).toBe(50);
    expect(envelope.error.details?.resetsAt).toBe(QUOTA.resetsAt);
    /**
     * Requirement 15.3, and the reason the handler nests a second envelope: the language a farmer
     * reads the failure in is the one their body asked for, not the `Accept-Language` this request
     * never sent.
     */
    expect(envelope.error.language).toBe('mr');
  });

  it('never renders a server-side cause, whatever the service threw', async () => {
    spies.chatTurn.mockRejectedValue(new Error('postgrest: relation "messages" does not exist'));

    const response = await post(validBody());
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(500);
    expect(envelope.error.code).toBe('INTERNAL_ERROR');
    /** Requirement 15.6: the real cause is logged server-side, never rendered. */
    expect(envelope.error.message).not.toContain('postgrest');
    expect(envelope.error.language).toBe('hi');
    expect(envelope.error.message).toBe(messages('hi').errors.INTERNAL_ERROR);
  });
});

/* ========================================================================== */
/* V17 — the declared ceiling                                                  */
/* ========================================================================== */

describe("the route declares Jamee's own duration ceiling", () => {
  it('exports maxDuration as the resolved 60 s, not the platform maximum', () => {
    expect(maxDuration).toBe(JAMEE_MAX_DURATION_SECONDS);
    expect(maxDuration).toBeLessThan(PLATFORM_MAX_DURATION_SECONDS);
  });
});
