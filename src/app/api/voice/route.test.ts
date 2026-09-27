import type { NextRequest } from 'next/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  JAMEE_MAX_DURATION_SECONDS,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  PLATFORM_MAX_DURATION_SECONDS,
} from '@/lib/config/verified';
import { AppError } from '@/lib/errors';
import { messages } from '@/lib/messages';
import {
  SUPPORTED_LANGUAGES,
  errorEnvelopeSchema,
  voiceResponseSchema,
  type ChatAnswer,
  type MediaRef,
  type QuotaStatus,
  type VoiceInput,
} from '@/lib/schemas';
import type { VoiceDeps, VoiceOutcome } from '@/services/voice.service';

import { POST, maxDuration } from './route';

/**
 * Wiring tests for `src/app/api/voice/route.ts` (Amendment A3).
 *
 * Requirements: 1.7 (no session → 401 and no domain service invoked), 8.1 (the body carries a
 *               `voice` Media_Reference and nothing else — no bytes), 8.2 / 8.3 (120 s re-checked
 *               server-side; the size is admitted at the Media_Endpoint, not probed here), 8.6 (the
 *               transcript AND the answer are both returned), 9.5 (a language outside en/hi/mr is
 *               400 naming the supported codes), 14.1 (the route reserves nothing and passes no
 *               coverage), 15.3 (one localized envelope), 16.5 (`channel` reaches the service)
 *
 * `voice.service.test.ts` decides what a voice turn *is*. What only this file decides is what the
 * **route** does with it, so the service is a spy and the assertions are about the boundary. Under
 * A3 the route holds no database client and reads no object size — the service reads the recording
 * from GridFS through the Data_Access_Layer — so `deps` is `{ chat, burst, deadlineMs }`.
 */

/* -------------------------------------------------------------------------- */
/* Seams                                                                       */
/* -------------------------------------------------------------------------- */

const spies = vi.hoisted(() => ({
  currentUserId: vi.fn(),
  transcribeAndAnswer: vi.fn(),
  voiceRequestDeadline: vi.fn(),
  chatAnswerer: vi.fn(),
}));

/** A3: `authenticatedRoute` resolves identity through `@/lib/auth/session`'s `currentUserId`. */
vi.mock('@/lib/auth/session', () => ({
  currentUserId: spies.currentUserId,
}));

/**
 * The service, a tripwire by default. `voiceRequestDeadline` is stubbed alongside it because the
 * route calls it for a value it must then hand to *both* halves of the request — assertable only if
 * the number is known here.
 */
vi.mock('@/services/voice.service', () => ({
  transcribeAndAnswer: spies.transcribeAndAnswer,
  voiceRequestDeadline: spies.voiceRequestDeadline,
}));

/** The nested `ChatService`, as the route binds it. The returned function is a sentinel. */
vi.mock('@/services/chat.service', () => ({ chatAnswerer: spies.chatAnswerer }));

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const USER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const ANSWER_MESSAGE_ID = '77777777-7777-4777-8777-777777777777';
const FARMER_MESSAGE_ID = '88888888-8888-4888-8888-888888888888';

/** A3: the body carries a `{ fileId, kind: 'voice' }` Media_Reference. */
const AUDIO_REF: MediaRef = { fileId: 'c'.repeat(24), kind: 'voice' };

/** The deadline the route computes once and must share. Any number will do; a fixed one is checkable. */
const DEADLINE_MS = 1_760_000_045_000;

/** A sentinel, so "the bound chat answerer was passed through" is an identity assertion. */
const CHAT_ANSWERER = Object.assign(() => Promise.resolve(), { tag: 'bound-chat-answerer' });

const QUOTA: QuotaStatus = {
  operation: 'voice',
  used: 3,
  limit: 20,
  resetsAt: '2026-09-16T18:30:00.000Z',
};

const TRANSCRIPT = ' मेरे टमाटर के पत्तों पर भूरे धब्बे हैं';

const ANSWER: ChatAnswer = {
  messageId: ANSWER_MESSAGE_ID,
  content: 'Early blight. Remove affected leaves and avoid overhead watering.',
  language: 'hi',
  groundedIn: ['Tomato Early Blight'],
  needsExpert: false,
};

const OUTCOME: VoiceOutcome = {
  transcript: TRANSCRIPT,
  answer: ANSWER,
  conversationId: CONVERSATION_ID,
  quota: QUOTA,
  farmerMessageId: FARMER_MESSAGE_ID,
  provider: 'groq',
  usedFallback: false,
  audio: { outcome: 'deleted' },
};

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    audio: AUDIO_REF,
    language: 'hi',
    conversationId: CONVERSATION_ID,
    durationSeconds: 6.5,
    ...overrides,
  };
}

/** The handler takes a `NextRequest`; a plain `Request` carries everything this route reads. */
function post(body: unknown, options: { raw?: string } = {}): Promise<Response> {
  const request = new Request('https://jamee.test/api/voice', {
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
  spies.voiceRequestDeadline.mockReturnValue(DEADLINE_MS);
  spies.chatAnswerer.mockReturnValue(CHAT_ANSWERER);
  spies.transcribeAndAnswer.mockRejectedValue(
    new Error('tripwire: transcribeAndAnswer was reached for a request that must not reach it'),
  );
});

/* ========================================================================== */
/* Requirement 1.7 — the gate                                                  */
/* ========================================================================== */

describe('POST /api/voice with no session', () => {
  it('returns 401 and invokes no service', async () => {
    spies.currentUserId.mockResolvedValue(null);

    const response = await post(validBody());
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(401);
    expect(envelope.error.code).toBe('AUTH_REQUIRED');
    expect(spies.transcribeAndAnswer).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* A valid body reaches the service exactly once                                */
/* ========================================================================== */

describe('POST /api/voice with a valid body', () => {
  it('calls the service once with the session user id, web channel, and the media reference', async () => {
    spies.transcribeAndAnswer.mockResolvedValue(OUTCOME);

    const response = await post(validBody({ mimeType: 'audio/webm;codecs=opus' }));

    expect(response.status).toBe(200);
    expect(spies.transcribeAndAnswer).toHaveBeenCalledTimes(1);

    /**
     * Deep equality on the input:
     *  - `userId` is the resolved session id, never read from the body (Requirement 13.2).
     *  - `audio` is the Media_Reference the body carried (A3) — no storage path, no bytes.
     *  - `channel: 'web'` populates Requirement 16.5's columns from the route.
     *  - `mimeType` travels because U-V20 leaves the recorded container unresolved, so the
     *    recorder's own answer is more specific than the stored MIME type.
     *  - **no `bytes`**: under A3 the size was admitted at the Media_Endpoint (`MAX_AUDIO_BYTES`),
     *    so the route reads none and the service re-checks the byte length it read from GridFS.
     */
    const expectedInput: VoiceInput = {
      userId: USER,
      audio: AUDIO_REF,
      language: 'hi',
      channel: 'web',
      conversationId: CONVERSATION_ID,
      durationSeconds: 6.5,
      mimeType: 'audio/webm;codecs=opus',
    };
    expect(spies.transcribeAndAnswer.mock.calls[0]?.[0]).toEqual(expectedInput);

    /**
     * `deps` is the bound chat answerer, Requirement 13.8's burst limiter and the shared deadline —
     * and nothing else. No client (A3), no store, no quota options: the audit writer and the media
     * delete are the service's own owner-scoped Data_Access_Layer business.
     */
    const deps = spies.transcribeAndAnswer.mock.calls[0]?.[1] as VoiceDeps;
    expect(Object.keys(deps).sort()).toEqual(['burst', 'chat', 'deadlineMs']);
    expect(deps.chat).toBe(CHAT_ANSWERER);
    expect(deps.deadlineMs).toBe(DEADLINE_MS);
    expect(typeof deps.burst).toBe('function');
  });

  it('gives the nested chat call the same shared deadline (14.1)', async () => {
    /**
     * One voice request, one budget. `ChatAnswerer` has no deadline parameter, so `runOptions` in
     * the closure is the only channel there is. **No `burst` on the nested answerer** (Requirement
     * 13.8): the voice request took its own minute slot, and the answer is covered by it. Under A3
     * the answerer takes no client — the chat service reads through the Data_Access_Layer.
     */
    spies.transcribeAndAnswer.mockResolvedValue(OUTCOME);

    await post(validBody());

    expect(spies.voiceRequestDeadline).toHaveBeenCalledTimes(1);
    expect(spies.chatAnswerer).toHaveBeenCalledTimes(1);
    expect(spies.chatAnswerer).toHaveBeenCalledWith({
      runOptions: { deadlineMs: DEADLINE_MS },
    });
  });

  it('passes no quota context and nothing that could opt out of a reserve (14.1)', async () => {
    spies.transcribeAndAnswer.mockResolvedValue(OUTCOME);

    await post(validBody());

    expect(spies.transcribeAndAnswer.mock.calls[0]).toHaveLength(2);
    const input = spies.transcribeAndAnswer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).not.toHaveProperty('skipQuotaReserve');
    const deps = spies.transcribeAndAnswer.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(deps).not.toHaveProperty('quota');
  });

  it('returns the transcript AND the answer, and nothing else (8.6)', async () => {
    spies.transcribeAndAnswer.mockResolvedValue(OUTCOME);

    const response = await post(validBody());
    const payload: unknown = await response.json();

    expect(response.headers.get('content-type')).toContain('application/json');
    expect(voiceResponseSchema.parse(payload)).toEqual({
      transcript: TRANSCRIPT,
      answer: ANSWER,
      conversationId: CONVERSATION_ID,
      quota: QUOTA,
    });
    /** The transcript is byte-for-byte the provider's — leading space and Devanagari intact. */
    expect((payload as { transcript: string }).transcript).toBe(TRANSCRIPT);
    /** The audit facts stay server-side: which provider transcribed, and what became of the audio. */
    expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual([
      'answer',
      'conversationId',
      'quota',
      'transcript',
    ]);
  });
});

/* ========================================================================== */
/* Requirement 9.5 — an unsupported language                                   */
/* ========================================================================== */

describe('POST /api/voice with an unsupported language', () => {
  it('returns 400 naming the three supported codes, and calls no service', async () => {
    const response = await post(validBody({ language: 'ta' }));
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(400);
    expect(envelope.error.code).toBe('LANGUAGE_UNSUPPORTED');
    expect(envelope.error.details?.supportedLanguages).toEqual([...SUPPORTED_LANGUAGES]);
    expect(envelope.error.details?.supportedLanguages).toEqual(['en', 'hi', 'mr']);
    expect(spies.transcribeAndAnswer).not.toHaveBeenCalled();
  });

  it('accepts each of the three languages Requirement 8.5 transcribes', async () => {
    spies.transcribeAndAnswer.mockResolvedValue(OUTCOME);

    for (const language of SUPPORTED_LANGUAGES) {
      const response = await post(validBody({ language }));
      expect(response.status, language).toBe(200);
    }
  });
});

/* ========================================================================== */
/* Requirements 8.2, 8.3 — the duration ceiling, server-side                    */
/* ========================================================================== */

describe('POST /api/voice with a duration past the ceiling', () => {
  it('returns 400 AUDIO_TOO_LONG naming both limits, and calls no service', async () => {
    const response = await post(validBody({ durationSeconds: MAX_AUDIO_SECONDS + 1 }));
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(400);
    expect(envelope.error.code).toBe('AUDIO_TOO_LONG');
    expect(envelope.error.details?.maxSeconds).toBe(MAX_AUDIO_SECONDS);
    expect(envelope.error.details?.maxBytes).toBe(MAX_AUDIO_BYTES);
    expect(envelope.error.retryable).toBe(false);
    expect(spies.transcribeAndAnswer).not.toHaveBeenCalled();
  });

  it('accepts a recording at exactly the ceiling', async () => {
    spies.transcribeAndAnswer.mockResolvedValue(OUTCOME);

    const response = await post(validBody({ durationSeconds: MAX_AUDIO_SECONDS }));

    expect(response.status).toBe(200);
    expect(spies.transcribeAndAnswer).toHaveBeenCalledTimes(1);
  });

  it('does not call a missing or non-positive duration "too long"', async () => {
    const cases = [
      { label: 'absent', send: () => post({ ...validBody(), durationSeconds: undefined }) },
      { label: 'zero', send: () => post(validBody({ durationSeconds: 0 })) },
      { label: 'negative', send: () => post(validBody({ durationSeconds: -4 })) },
      { label: 'not a number', send: () => post(validBody({ durationSeconds: '6.5' })) },
    ];

    for (const { label, send } of cases) {
      const envelope = await envelopeOf(await send());
      expect(envelope.error.code, label).toBe('STORAGE_REF_INVALID');
    }

    expect(spies.transcribeAndAnswer).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* Requirement 8.1 — a malformed body                                          */
/* ========================================================================== */

describe('POST /api/voice with a malformed body', () => {
  it('returns 404 CONVERSATION_NOT_FOUND for an absent or non-uuid conversation id', async () => {
    const cases = [
      { label: 'absent', send: () => post({ ...validBody(), conversationId: undefined }) },
      { label: 'not a uuid', send: () => post(validBody({ conversationId: 'thread-1' })) },
    ];

    for (const { label, send } of cases) {
      const response = await send();
      const envelope = await envelopeOf(response);

      expect(response.status, label).toBe(404);
      expect(envelope.error.code, label).toBe('CONVERSATION_NOT_FOUND');
    }

    expect(spies.transcribeAndAnswer).not.toHaveBeenCalled();
  });

  it('returns 400 STORAGE_REF_INVALID for a media reference the contract does not admit', async () => {
    const cases = [
      { label: 'no audio', send: () => post({ ...validBody(), audio: undefined }) },
      {
        label: 'fileId not a 24-hex ObjectId',
        send: () => post(validBody({ audio: { fileId: 'not-hex', kind: 'voice' } })),
      },
      {
        label: 'wrong kind (a crop image submitted as the recording)',
        send: () => post(validBody({ audio: { fileId: 'c'.repeat(24), kind: 'crop-image' } })),
      },
      { label: 'not JSON at all', send: () => post(null, { raw: 'not json' }) },
    ];

    for (const { label, send } of cases) {
      const response = await send();
      const envelope = await envelopeOf(response);

      expect(response.status, label).toBe(400);
      expect(envelope.error.code, label).toBe('STORAGE_REF_INVALID');
    }

    expect(spies.transcribeAndAnswer).not.toHaveBeenCalled();
  });

  it('leaves a foreign reference to the service, which refuses it with the quota untouched', async () => {
    /**
     * A well-formed reference to someone else's recording — a judgement the ownership gate makes,
     * not the parser. The route hands it on, and 403 comes back from the owner-scoped media read
     * (Requirements 2.5, 2.6), quota untouched.
     */
    spies.transcribeAndAnswer.mockRejectedValue(
      new AppError('STORAGE_REF_FORBIDDEN', { context: { reason: 'recording_not_owned_or_missing' } }),
    );

    const response = await post(validBody());
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(403);
    expect(envelope.error.code).toBe('STORAGE_REF_FORBIDDEN');
    expect(spies.transcribeAndAnswer).toHaveBeenCalledTimes(1);
  });
});

/* ========================================================================== */
/* Requirement 15.3 — the envelope, in the body's language                     */
/* ========================================================================== */

describe('POST /api/voice when the service declines', () => {
  it('renders TRANSCRIPT_EMPTY as a retryable 422 in the language the body asked for', async () => {
    spies.transcribeAndAnswer.mockRejectedValue(
      new AppError('TRANSCRIPT_EMPTY', { context: { reason: 'provider_returned_empty' } }),
    );

    const response = await post(validBody({ language: 'mr' }));
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(422);
    expect(envelope.error.code).toBe('TRANSCRIPT_EMPTY');
    expect(envelope.error.retryable).toBe(true);
    expect(envelope.error.language).toBe('mr');
    expect(envelope.error.message).toBe(messages('mr').errors.TRANSCRIPT_EMPTY);
  });

  it('renders QUOTA_EXCEEDED as 429 with the limit and the reset instant structured', async () => {
    spies.transcribeAndAnswer.mockRejectedValue(
      new AppError('QUOTA_EXCEEDED', {
        details: { limit: 20, used: 20, resetsAt: QUOTA.resetsAt },
        context: { operation: 'voice' },
      }),
    );

    const response = await post(validBody());
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(429);
    expect(envelope.error.code).toBe('QUOTA_EXCEEDED');
    expect(envelope.error.details?.limit).toBe(20);
    expect(envelope.error.details?.resetsAt).toBe(QUOTA.resetsAt);
  });

  it('never renders a server-side cause, whatever the service threw', async () => {
    spies.transcribeAndAnswer.mockRejectedValue(
      new Error('groq: 401 invalid api key sk-live-abcdef'),
    );

    const response = await post(validBody());
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(500);
    expect(envelope.error.code).toBe('INTERNAL_ERROR');
    expect(envelope.error.message).not.toContain('sk-live');
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
