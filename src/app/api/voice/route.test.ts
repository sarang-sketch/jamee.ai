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
  type QuotaStatus,
  type StorageRef,
  type VoiceInput,
} from '@/lib/schemas';
import type { VoiceDeps, VoiceOutcome } from '@/services/voice.service';

import { POST, maxDuration } from './route';

/**
 * Wiring tests for `src/app/api/voice/route.ts`.
 *
 * Requirements: 1.7 (no session → 401 and no domain service invoked), 8.1 (the body carries a
 *               `voice-messages` reference and nothing else), 8.2 / 8.3 (120 s and 10 MB, re-checked
 *               server-side), 8.6 (the transcript AND the answer are both returned), 9.5 (a language
 *               outside en/hi/mr is 400 naming the supported codes), 14.1 (the route reserves
 *               nothing and passes no coverage), 15.3 (one localized envelope), 16.5 (`channel`
 *               reaches the service as an input parameter)
 *
 * `voice.service.test.ts` already decides what a voice turn *is* — the ordered spend, the single
 * counter touch across two nested services, the retained object after an empty transcript. What only
 * this file can decide is what the **route** does with it, so the service is a spy here and the
 * assertions are about the boundary: was it reached, how many times, with whose identity, with which
 * client, with which budget, and what came back on the wire.
 *
 * The strongest tests are negative. A 401 that also proves `transcribeAndAnswer` was never entered
 * is Requirement 1.7's actual claim; a 400 that proves the same is Requirement 9.5's and 8.3's.
 */

/* -------------------------------------------------------------------------- */
/* Seams                                                                       */
/* -------------------------------------------------------------------------- */

const spies = vi.hoisted(() => ({
  currentUserId: vi.fn(),
  createServerSupabase: vi.fn(),
  transcribeAndAnswer: vi.fn(),
  voiceRequestDeadline: vi.fn(),
  chatAnswerer: vi.fn(),
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
 * The service, as a tripwire by default. Every test that expects a refusal leaves this rejecting, so
 * a route that reached the service would fail twice: once on the recorded call and once on the
 * status, because the throw would have become a 500.
 *
 * `voiceRequestDeadline` is stubbed alongside it because the route calls it for a value it must then
 * hand to *both* halves of the request — which is only assertable if the number is known here.
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
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const OBJECT_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const ANSWER_MESSAGE_ID = '77777777-7777-4777-8777-777777777777';
const FARMER_MESSAGE_ID = '88888888-8888-4888-8888-888888888888';

const AUDIO_PATH = `${USER}/2026/09/${OBJECT_ID}.webm`;
const AUDIO_REF: StorageRef = { bucket: 'voice-messages', path: AUDIO_PATH };

/** The deadline the route computes once and must share. Any number will do; a fixed one is checkable. */
const DEADLINE_MS = 1_760_000_045_000;

/** The size the object actually is, as Storage reports it. 2 MB — inside every limit. */
const OBJECT_BYTES = 2 * 1024 * 1024;

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

/**
 * The request client, with the one storage call the route makes on it.
 *
 * A real fake rather than a mock of `objectSizeOf`: the size probe *is* part of this route's wiring
 * (Requirement 8.2's server-side half), so the test drives the same `info()` seam a deployment does
 * and can assert both which path was asked about and what the service was told.
 */
function supabaseStub(
  answer: { size?: number } | 'error' = { size: OBJECT_BYTES },
  probed: string[] = [],
): Record<string, unknown> {
  return {
    tag: 'rls-scoped-server-client',
    storage: {
      from: () => ({
        info: (path: string) => {
          probed.push(path);
          return Promise.resolve(
            answer === 'error'
              ? { data: null, error: { message: 'not found' } }
              : { data: answer, error: null },
          );
        },
      }),
    },
  };
}

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
  spies.createServerSupabase.mockResolvedValue(supabaseStub());
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
  it('returns 401 and invokes no service, not even the Supabase client factory', async () => {
    spies.currentUserId.mockResolvedValue(null);

    const response = await post(validBody());
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(401);
    expect(envelope.error.code).toBe('AUTH_REQUIRED');

    /** The clause that matters: no domain service, no client, and no storage read either. */
    expect(spies.transcribeAndAnswer).not.toHaveBeenCalled();
    expect(spies.createServerSupabase).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* A valid body reaches the service exactly once                                */
/* ========================================================================== */

describe('POST /api/voice with a valid body', () => {
  it('calls the service once with the session user id, web channel, and the object size', async () => {
    const probed: string[] = [];
    const supabase = supabaseStub({ size: OBJECT_BYTES }, probed);
    spies.createServerSupabase.mockResolvedValue(supabase);
    spies.transcribeAndAnswer.mockResolvedValue(OUTCOME);

    const response = await post(validBody({ mimeType: 'audio/webm;codecs=opus' }));

    expect(response.status).toBe(200);
    expect(spies.transcribeAndAnswer).toHaveBeenCalledTimes(1);

    /**
     * Deep equality on the input, which is what makes this a contract test rather than a smoke test:
     *  - `userId` is the resolved session id. A route that read an id out of the body would fail
     *    here, and Requirement 13.2 is exactly that distinction.
     *  - `channel: 'web'` is on the input, so Requirement 16.5's columns are populated from the route
     *    rather than defaulted downstream.
     *  - `bytes` is the size Storage reported, not a number the body carried — Requirement 8.2's size
     *    half, which had no server-side input before this route read it.
     *  - `mimeType` travels because U-V20 leaves the recorded container unresolved, so the recorder's
     *    own answer is more specific than the object's extension.
     */
    const expectedInput: VoiceInput = {
      userId: USER,
      storageRef: AUDIO_REF,
      language: 'hi',
      channel: 'web',
      conversationId: CONVERSATION_ID,
      durationSeconds: 6.5,
      bytes: OBJECT_BYTES,
      mimeType: 'audio/webm;codecs=opus',
    };
    expect(spies.transcribeAndAnswer.mock.calls[0]?.[0]).toEqual(expectedInput);
    expect(probed).toEqual([AUDIO_PATH]);

    /**
     * `deps` is the RLS-scoped client, the bound chat answerer, Requirement 13.8's burst limiter and
     * the shared deadline — and nothing else. No store, no admin client, no quota options: the
     * `usage_logs` audit client and the service-role deleter are the service's own business
     * (migration `0006` grants `authenticated` no insert policy, `0009` grants a farmer session no
     * delete).
     */
    const deps = spies.transcribeAndAnswer.mock.calls[0]?.[1] as VoiceDeps;
    expect(Object.keys(deps).sort()).toEqual(['burst', 'chat', 'deadlineMs', 'supabase']);
    expect(deps.supabase).toBe(supabase);
    expect(deps.chat).toBe(CHAT_ANSWERER);
    expect(deps.deadlineMs).toBe(DEADLINE_MS);
    expect(typeof deps.burst).toBe('function');
  });

  it('gives the nested chat call the same deadline and the same client', async () => {
    /**
     * Requirement 14.1's sibling concern: one voice request, one budget. `ChatAnswerer` has no
     * deadline parameter, so `runOptions` in the closure is the only channel there is — a route that
     * omitted it would leave the nested turn computing a fresh 45 s partway through a request that
     * already spent part of its own on transcription.
     */
    const supabase = supabaseStub();
    spies.createServerSupabase.mockResolvedValue(supabase);
    spies.transcribeAndAnswer.mockResolvedValue(OUTCOME);

    await post(validBody());

    expect(spies.voiceRequestDeadline).toHaveBeenCalledTimes(1);
    expect(spies.chatAnswerer).toHaveBeenCalledTimes(1);

    /**
     * **No `burst` on the nested answerer** (Requirement 13.8). The voice request took its own minute
     * slot against the `voice` ceiling; the answer it produces is covered by that, exactly as it is
     * covered by the voice quota unit. Binding a limiter here would let one recording consume a chat
     * burst slot the farmer never asked for — and this key list is what would fail if it were added.
     */
    expect(spies.chatAnswerer).toHaveBeenCalledWith({
      supabase,
      runOptions: { deadlineMs: DEADLINE_MS },
    });
  });

  it('passes no quota context and nothing that could opt out of a reserve (14.1)', async () => {
    spies.transcribeAndAnswer.mockResolvedValue(OUTCOME);

    await post(validBody());

    /**
     * Two arguments, and neither carries a spend decision. The voice unit is reserved by the service
     * and covers the nested answer, so a route that reached for `coveredBy()` or a
     * `skipQuotaReserve` would be making a decision that belongs one layer down — and would be the
     * one way to charge a farmer twice for one recording.
     */
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
    /**
     * Requirement 8.6 is the pair being present together. The transcript is byte-for-byte the
     * provider's — leading space and Devanagari intact — because a transcript Jamee quietly edited
     * is not what the farmer said.
     */
    expect((payload as { transcript: string }).transcript).toBe(TRANSCRIPT);
    /** The audit facts stay server-side: which provider transcribed, and what became of the audio. */
    expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual([
      'answer',
      'conversationId',
      'quota',
      'transcript',
    ]);
  });

  it('proceeds without a size when Storage cannot answer, and says so in the log', async () => {
    /**
     * The probe is a guard, not a gate: the bytes are already in the bucket and the ownership check
     * is about to run, so a metadata failure must not cost the farmer their recording. The service is
     * told nothing rather than told zero — `assertAdmissibleAudio()` skips a check it has no number
     * for — and the miss is logged instead of passing silently.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    spies.createServerSupabase.mockResolvedValue(supabaseStub('error'));
    spies.transcribeAndAnswer.mockResolvedValue(OUTCOME);

    try {
      const response = await post(validBody());

      expect(response.status).toBe(200);
      expect(spies.transcribeAndAnswer.mock.calls[0]?.[0]).not.toHaveProperty('bytes');
      expect(warn).toHaveBeenCalledWith(
        '[jamee] object_size_unknown',
        expect.stringContaining(AUDIO_PATH),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('renders the service refusal for an oversized object, with the audio limit in it', async () => {
    /**
     * End of the chain the probe feeds: the size reaches the service, the service judges it
     * (`FILE_TOO_LARGE`, before the reserve), and the route renders that judgement. The number in
     * the sentence is the audio ceiling — the guard that was previously unreachable on this path
     * because nothing supplied a byte count.
     */
    spies.createServerSupabase.mockResolvedValue(supabaseStub({ size: MAX_AUDIO_BYTES + 1 }));
    spies.transcribeAndAnswer.mockRejectedValue(
      new AppError('FILE_TOO_LARGE', { details: { maxBytes: MAX_AUDIO_BYTES } }),
    );

    const response = await post(validBody());
    const envelope = await envelopeOf(response);

    expect(spies.transcribeAndAnswer.mock.calls[0]?.[0]).toMatchObject({
      bytes: MAX_AUDIO_BYTES + 1,
    });
    expect(response.status).toBe(400);
    expect(envelope.error.code).toBe('FILE_TOO_LARGE');
    expect(envelope.error.details?.maxBytes).toBe(MAX_AUDIO_BYTES);
    expect(envelope.error.retryable).toBe(false);
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
    /**
     * `VoiceRecorder` stops at 120 s, but a hand-built request has no recorder in it — which is the
     * whole reason the bound is re-checked here rather than trusted.
     */
    const response = await post(validBody({ durationSeconds: MAX_AUDIO_SECONDS + 1 }));
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(400);
    expect(envelope.error.code).toBe('AUDIO_TOO_LONG');
    /** Requirement 8.3 states both limits, and both come from `config/verified.ts`. */
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
    /**
     * A zero, a negative, or an absent duration is a malformed request, not a long recording, and
     * telling the farmer to record something shorter would be a sentence about the wrong problem.
     */
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
    /**
     * The same code the nested `ChatService` raises for an id that is not this farmer's — one code
     * for one meaning, so the response cannot be used as an oracle for which conversations exist.
     */
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

  it('returns 400 STORAGE_REF_INVALID for a reference the contract does not admit', async () => {
    const cases = [
      { label: 'no audio', send: () => post({ ...validBody(), audio: undefined }) },
      {
        label: 'wrong bucket',
        send: () => post(validBody({ audio: { bucket: 'crop-images', path: AUDIO_PATH } })),
      },
      {
        label: 'path outside the convention',
        send: () => post(validBody({ audio: { bucket: 'voice-messages', path: 'recording.webm' } })),
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

  it('leaves a foreign prefix to the service, which refuses it with the quota untouched', async () => {
    /**
     * The path convention is satisfied, so this is a well-formed request for someone else's object —
     * a judgement the ownership gate makes, not the parser. The route hands it on, and 403 comes back
     * from `assertOwnershipInBucket()` (Requirements 2.5, 2.6).
     */
    const foreign = { bucket: 'voice-messages', path: `${OTHER_USER}/2026/09/${OBJECT_ID}.webm` };
    spies.transcribeAndAnswer.mockRejectedValue(
      new AppError('STORAGE_REF_FORBIDDEN', { context: { reason: 'prefix_mismatch' } }),
    );

    const response = await post(validBody({ audio: foreign }));
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

    /** The status comes from the taxonomy, so the route holds no HTTP code of its own. */
    expect(response.status).toBe(422);
    expect(envelope.error.code).toBe('TRANSCRIPT_EMPTY');
    /** Requirement 8.7: the farmer can act — record again somewhere quieter, over a new object. */
    expect(envelope.error.retryable).toBe(true);
    /**
     * Requirement 15.3, and the reason the handler nests a second envelope: the language a farmer
     * reads the failure in is the one their body asked for, not the `Accept-Language` this request
     * never sent.
     */
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
    /** Requirement 14.3 — the limit and the reset instant travel structured, not baked into prose. */
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
    /** Requirement 15.6: the real cause is logged server-side, never rendered. */
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
