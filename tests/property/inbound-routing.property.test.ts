import * as fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RECHARGE_PRICE_RUPEES } from '@/lib/config/access';
import { formatChatReply, formatDiagnosisReply, formatVoiceReply } from '@/lib/channel-reply';
import { interpolate, messages } from '@/lib/messages';
import type { DiagnosisResult, Language } from '@/lib/schemas';
import type { TelegramDispatch, TelegramUpdateKind } from '@/lib/telegram';

/**
 * **Property 24: Inbound Telegram updates are routed by type and always acknowledged**
 *
 * > For any authenticated, non-duplicate, well-formed inbound update whose sender resolves to an
 * > entitled Profile, a photo is written to GridFS and dispatched to the diagnosis service, a text
 * > is dispatched to the chat service on the farmer's active Telegram conversation, a voice note
 * > (OGG/Opus, MP3 or M4A) is written to GridFS and dispatched to the voice service, and any other
 * > type receives the "photos, text, voice notes" reply with no service call and no quota change.
 * > Two further non-service outcomes: a sender on no Profile receives the linking instructions in
 * > English, and a resolved Profile with no unexpired entitlement receives the gated reply in its
 * > language. Every one of these is acknowledged with HTTP 200, and each reply is sent in addition
 * > to that acknowledgement.
 *
 * **Validates: Requirements 10.3, 10.4, 10.5, 10.6, 10.9, 10.11, 21.17, 21.19, 22.14**
 *
 * Carries the routing/acknowledgement slices of **Property 23** (a non-duplicate claim is what lets
 * routing run at all; a duplicate short-circuits with no service and no reply) and **Property 25**
 * (the routed photo renders through the shared diagnosis formatter). The `update_id` insertOne claim
 * itself and the secret-token check live in `webhook.property.test.ts`; the entitlement gate's
 * TOTALITY over kinds lives in `entitlement-gate.property.test.ts`. This file owns "routed by kind,
 * always acknowledged".
 *
 * =============================================================================
 * A3 RESTATEMENT
 * =============================================================================
 *
 * The Supabase/WhatsApp predecessor routed a Meta webhook by `type` and asserted a Supabase row
 * transition. Under Amendment A3 the channel is Telegram and routing is `processInboundUpdate` in
 * `src/lib/telegram-dispatch.ts`, which branches on `TelegramUpdateKind` (`start | text | photo |
 * voice | other`) and marks a `telegram_inbound` document terminal after the reply. "Always
 * acknowledged" is expressed as: every branch returns a `TelegramInboundResult` with a terminal
 * disposition (the route maps every authenticated delivery to HTTP 200), and the 401 is the sole
 * non-ack, which is the secret-token branch owned by the webhook file.
 *
 * Every service and outbound effect is an injectable seam; the ones a given branch must NOT reach
 * are tripwires, so a mis-route aborts the run rather than merely failing an assertion. The DAL
 * (`claimInbound`, the `markX` writes) is module-mocked exactly as the module's unit test does, so
 * this is a pure routing property with no database.
 */

/* ========================================================================== */
/* Module seams                                                                */
/* ========================================================================== */

const claimInbound = vi.fn(async () => true);
const markProcessed = vi.fn(async () => undefined);
const markUnlinked = vi.fn(async () => undefined);
const markNotEntitled = vi.fn(async () => undefined);
const markRejected = vi.fn(async () => undefined);
const markFailed = vi.fn(async () => undefined);
const resolveSender = vi.fn(async () => null);

vi.mock('@/lib/db/telegram-inbound', () => ({
  claimInbound: (...a: unknown[]) => claimInbound(...(a as [])),
  markProcessed: (...a: unknown[]) => markProcessed(...(a as [])),
  markUnlinked: (...a: unknown[]) => markUnlinked(...(a as [])),
  markNotEntitled: (...a: unknown[]) => markNotEntitled(...(a as [])),
  markRejected: (...a: unknown[]) => markRejected(...(a as [])),
  markFailed: (...a: unknown[]) => markFailed(...(a as [])),
  resolveSender: (...a: unknown[]) => resolveSender(...(a as [])),
}));

const chatAnswer = vi.fn();
vi.mock('@/services/chat.service', () => ({ chatAnswerer: () => chatAnswer }));
vi.mock('@/services/quota.service', () => ({ ownsRequest: (u: string, o: string) => ({ u, o }) }));

const { processInboundUpdate } = await import('@/lib/telegram-dispatch');
type Deps = Parameters<typeof processInboundUpdate>[1];

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const CHAT_ID = 909;
const OWNER = 'routed-farmer';
const LANGUAGES: readonly Language[] = ['en', 'hi', 'mr'];

const DIAGNOSIS: DiagnosisResult = {
  status: 'identified',
  diseaseName: 'Tomato Early Blight',
  confidence: 0.9,
  severity: 'moderate',
  explanation: 'A grounded explanation.',
  knowledge: { symptoms: ['s'], causes: ['c'], treatment: ['t'], prevention: ['p'], source: 'bulletin' },
  needsExpert: false,
  language: 'en',
};
const TRANSCRIPT = 'what is wrong with my crop';
const CHAT_CONTENT = 'Water less and remove infected leaves.';

function dispatchFor(kind: TelegramUpdateKind, overrides: Partial<TelegramDispatch> = {}): TelegramDispatch {
  return {
    updateId: 1,
    telegramUserId: 77,
    chatId: CHAT_ID,
    kind,
    textBody: kind === 'text' ? 'hello' : null,
    fileId: kind === 'photo' || kind === 'voice' ? 'file-x' : null,
    voiceMimeType: kind === 'voice' ? 'audio/ogg' : null,
    startPayload: null,
    ...overrides,
  };
}

type CallLog = { diagnose: number; voice: number; chat: number };

function entitledDeps(language: Language): { deps: Deps; send: ReturnType<typeof vi.fn>; calls: CallLog } {
  const send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }));
  const calls: CallLog = { diagnose: 0, voice: 0, chat: 0 };

  chatAnswer.mockImplementation(async () => {
    calls.chat += 1;
    return { answer: { content: CHAT_CONTENT }, conversationId: 'c1', farmerMessageId: 'm1', quota: {} };
  });

  const deps: Deps = {
    resolveProfile: async () => ({ userId: OWNER, language }),
    isEntitled: async () => true,
    conversations: {
      mostRecent: async () => ({ id: 'c1', user_id: OWNER, channel: 'telegram', title: null, created_at: '2026-09-27T00:00:00.000Z', updated_at: '2026-09-27T00:00:00.000Z' }),
      create: async () => ({ id: 'c1', user_id: OWNER, channel: 'telegram', title: null, created_at: '2026-09-27T00:00:00.000Z', updated_at: '2026-09-27T00:00:00.000Z' }),
    } as never,
    download: (async () => ({ bytes: new Uint8Array([1, 2, 3]), size: 3, mimeType: 'image/jpeg' })) as never,
    media: (async () => ({ fileId: { toHexString: () => 'a'.repeat(24) }, kind: 'crop-image' })) as never,
    diagnose: (async () => {
      calls.diagnose += 1;
      return { result: DIAGNOSIS, conversationId: 'c1', quota: {}, diagnosisId: 'd1', provider: 'gemini', usedFallback: false };
    }) as never,
    voice: (async () => {
      calls.voice += 1;
      return { transcript: TRANSCRIPT, answer: { content: CHAT_CONTENT }, conversationId: 'c1', quota: {}, farmerMessageId: 'm1', provider: 'groq', usedFallback: false, audio: {} };
    }) as never,
    send,
    now: () => Date.parse('2026-09-27T00:00:00.000Z'),
    platformDeadline: () => undefined,
  };
  return { deps, send, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  claimInbound.mockResolvedValue(true);
});

/* ========================================================================== */
/* Property 24 — routing by kind for an entitled farmer                        */
/* ========================================================================== */

describe('Property 24: entitled inbound updates route by kind and are always acknowledged', () => {
  it('photo → diagnosis, text → chat, voice → voice; exactly one service per delivery; reply sent', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'photo' | 'text' | 'voice'>('photo', 'text', 'voice'),
        fc.constantFrom<Language>(...LANGUAGES),
        async (kind, language) => {
          const { deps, send, calls } = entitledDeps(language);
          const outcome = await processInboundUpdate(dispatchFor(kind), deps);

          // Acknowledged: a terminal 'processed' disposition, one reply sent.
          expect(outcome.disposition, kind).toBe('processed');
          expect(outcome.replySent, kind).toBe(true);
          expect(send, kind).toHaveBeenCalledTimes(1);
          expect(markProcessed, kind).toHaveBeenCalledWith(1, OWNER);

          // Exactly the ONE service for this kind ran.
          if (kind === 'photo') expect(calls).toStrictEqual({ diagnose: 1, voice: 0, chat: 0 });
          if (kind === 'text') expect(calls).toStrictEqual({ diagnose: 0, voice: 0, chat: 1 });
          if (kind === 'voice') expect(calls).toStrictEqual({ diagnose: 0, voice: 1, chat: 0 });

          // The reply is the shared formatter's output for that kind (Property 25 slice).
          const [, text] = send.mock.calls[0] as unknown as [number, string];
          if (kind === 'photo') expect(text).toBe(formatDiagnosisReply(DIAGNOSIS, language));
          if (kind === 'text') expect(text).toBe(formatChatReply(CHAT_CONTENT));
          if (kind === 'voice') expect(text).toBe(formatVoiceReply(TRANSCRIPT, CHAT_CONTENT, language));
        },
      ),
      { numRuns: 150 },
    );
  });

  it('an unsupported type (other) is acknowledged with the unsupported reply, no service, no quota', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<Language>(...LANGUAGES), async (language) => {
        const { deps, send, calls } = entitledDeps(language);
        const outcome = await processInboundUpdate(dispatchFor('other'), deps);

        expect(outcome.disposition).toBe('rejected_unsupported_type');
        expect(markRejected).toHaveBeenCalledWith(1, OWNER);
        expect(calls).toStrictEqual({ diagnose: 0, voice: 0, chat: 0 });
        const [, text] = send.mock.calls[0] as unknown as [number, string];
        expect(text).toBe(messages(language).telegram.unsupportedType);
      }),
      { numRuns: 30 },
    );
  });
});

/* ========================================================================== */
/* The two non-service outcomes                                                */
/* ========================================================================== */

describe('Property 24: the non-service outcomes are acknowledged', () => {
  it('an unlinked sender gets linking instructions in English, marked unlinked, no service', async () => {
    const send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }));
    const diagnoseTrip = vi.fn(() => {
      throw new Error('tripwire: diagnose ran for an unlinked sender');
    });
    const deps: Deps = {
      resolveProfile: async () => null,
      diagnose: diagnoseTrip as never,
      send,
      now: () => Date.parse('2026-09-27T00:00:00.000Z'),
      platformDeadline: () => undefined,
    };
    const outcome = await processInboundUpdate(dispatchFor('photo'), deps);
    expect(outcome.disposition).toBe('unlinked');
    expect(markUnlinked).toHaveBeenCalledWith(1);
    expect(diagnoseTrip).not.toHaveBeenCalled();
    const [, text] = send.mock.calls[0] as unknown as [number, string];
    expect(text).toBe(messages('en').telegram.linkingInstructions);
  });

  it('a resolved-but-unentitled sender gets the gated reply in its language, marked not_entitled', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<Language>(...LANGUAGES), async (language) => {
        const send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }));
        const deps: Deps = {
          resolveProfile: async () => ({ userId: OWNER, language }),
          isEntitled: async () => false,
          send,
          now: () => Date.parse('2026-09-27T00:00:00.000Z'),
          platformDeadline: () => undefined,
        };
        const outcome = await processInboundUpdate(dispatchFor('text', { textBody: 'help my crop' }), deps);
        expect(outcome.disposition).toBe('not_entitled');
        expect(markNotEntitled).toHaveBeenCalledWith(1, OWNER);
        const [, text] = send.mock.calls[0] as unknown as [number, string];
        expect(text).toBe(interpolate(messages(language).telegram.gated, { price: RECHARGE_PRICE_RUPEES }));
      }),
      { numRuns: 30 },
    );
  });
});

/* ========================================================================== */
/* Property 23 slice — a duplicate short-circuits before any routing            */
/* ========================================================================== */

describe('Property 23 (routing slice): a duplicate delivery routes to nothing and replies nothing', () => {
  it('a claim that returns false does no download, no service, no reply, and is acknowledged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'photo' | 'text' | 'voice' | 'other' | 'start'>('photo', 'text', 'voice', 'other', 'start'),
        async (kind) => {
          claimInbound.mockResolvedValueOnce(false); // a redelivery
          const { deps, send, calls } = entitledDeps('en');
          const outcome = await processInboundUpdate(dispatchFor(kind), deps);

          expect(outcome.disposition).toBe('duplicate_ignored');
          expect(outcome.replySent).toBe(false);
          expect(send).not.toHaveBeenCalled();
          expect(calls).toStrictEqual({ diagnose: 0, voice: 0, chat: 0 });
          // No terminal write beyond the claim — the original delivery owns the record.
          expect(markProcessed).not.toHaveBeenCalled();
          expect(markNotEntitled).not.toHaveBeenCalled();
          expect(markRejected).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 50 },
    );
  });
});


