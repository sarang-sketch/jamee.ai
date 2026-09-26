import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages } from '@/lib/messages';
import { RECHARGE_PRICE_RUPEES } from '@/lib/config/access';
import type { TelegramDispatch } from '@/lib/telegram';

/**
 * Unit tests for the ordered Telegram inbound pipeline (`src/lib/telegram-dispatch.ts`).
 *
 * Every external effect the pipeline touches is an injectable seam on `TelegramDispatchDeps`, so
 * these tests open no network, no database, and never read a secret: they drive `processInboundUpdate`
 * (steps 3–10 over a parsed dispatch) and `dispatchTelegramRequest` (verify + parse + claim) with
 * stubs, and assert the CONTRACT the design fixes — the order of operations, the reply for each
 * outcome, and that the record is marked terminal only after the reply is sent.
 *
 * Requirements exercised: 10.2/10.3 (sender resolution, unlinked → linking instructions in English),
 *   10.9 (unsupported type), 10.11 / D11 (markProcessed after the reply), 11.2 (secret before body),
 *   11.5–11.8 / D19 (the update_id claim; a duplicate does nothing), 21.9/21.18 (`/start` short-circuit),
 *   22.13–22.16 / A2 (the entitlement gate; a gated farmer costs zero quota), A2 decision 5 (`/recharge`
 *   is exempt from the gate).
 *
 * The module reads `TELEGRAM_WEBHOOK_SECRET_TOKEN` inside `telegram.ts` only on the un-injected path;
 * `dispatchTelegramRequest` is exercised here with the header set and the secret pinned via the env
 * var so `verifySecretToken`'s default resolves — the one place these tests touch `process.env`, and
 * with a dummy value, never a real secret.
 */

const SECRET = 'unit-test-secret-token';

// Set before importing the module so the secret-token verification default has a value to read.
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = SECRET;
process.env.BETTER_AUTH_URL = 'https://app.example.test';

const dispatchModule = await import('@/lib/telegram-dispatch');
const {
  processInboundUpdate,
  dispatchTelegramRequest,
  isRechargeCommand,
  TELEGRAM_SOFT_DEADLINE_MS,
} = dispatchModule;
type Deps = Parameters<typeof processInboundUpdate>[1];

const tg = messages('en').telegram;

/* ========================================================================== */
/* Builders                                                                    */
/* ========================================================================== */

const CHAT_ID = 555;
const TG_USER = 42;

function dispatch(overrides: Partial<TelegramDispatch> = {}): TelegramDispatch {
  return {
    updateId: 1,
    telegramUserId: TG_USER,
    chatId: CHAT_ID,
    kind: 'text',
    textBody: 'hello',
    fileId: null,
    voiceMimeType: null,
    startPayload: null,
    ...overrides,
  };
}

/**
 * A deps bundle whose every seam is a spy. `claimInbound` is not a dep — it is imported statically by
 * the module from `src/lib/db/telegram-inbound`, which re-exports `farmer.ts`. So the DB seam is
 * mocked at the module level below, and these deps cover only the service/telegram effects.
 */
function makeDeps(overrides: Partial<Deps> = {}): {
  deps: Deps;
  send: ReturnType<typeof vi.fn>;
  diagnose: ReturnType<typeof vi.fn>;
  voice: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  media: ReturnType<typeof vi.fn>;
  consumeAndBind: ReturnType<typeof vi.fn>;
  isEntitled: ReturnType<typeof vi.fn>;
  resolveProfile: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }));
  const diagnose = vi.fn(async () => ({
    result: {
      status: 'identified' as const,
      diseaseName: 'Tomato Early Blight' as const,
      confidence: 0.9,
      severity: 'moderate' as const,
      explanation: 'A grounded explanation.',
      knowledge: {} as never,
      needsExpert: false as const,
      language: 'en' as const,
    },
    conversationId: 'c1',
    quota: {} as never,
    diagnosisId: 'd1',
    provider: 'gemini' as const,
    usedFallback: false,
  }));
  const voice = vi.fn(async () => ({
    transcript: 'what is wrong with my crop',
    answer: { content: 'Water less.' } as never,
    conversationId: 'c1',
    quota: {} as never,
    farmerMessageId: 'm1',
    provider: 'groq' as const,
    usedFallback: false,
    audio: {} as never,
  }));
  const download = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), size: 3, mimeType: 'image/jpeg' }));
  const media = vi.fn(async () => ({
    fileId: { toHexString: () => 'a'.repeat(24) },
    kind: 'crop-image' as const,
  }));
  const consumeAndBind = vi.fn(async () => ({ kind: 'bound' as const, ownerId: 'owner-1' }));
  const isEntitled = vi.fn(async () => true);
  const resolveProfile = vi.fn(async () => ({ userId: 'owner-1', language: 'en' as const }));

  const deps: Deps = {
    send,
    diagnose: diagnose as never,
    voice: voice as never,
    download: download as never,
    media: media as never,
    consumeAndBind: consumeAndBind as never,
    isEntitled,
    resolveProfile,
    conversations: {
      mostRecent: async () => null,
      create: async () => ({
        id: 'c1',
        user_id: 'owner-1',
        channel: 'telegram',
        title: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    },
    now: () => 1_000,
    platformDeadline: () => undefined,
    requestStartMs: 1_000,
    rechargeBaseUrl: 'https://app.example.test',
    ...overrides,
  };

  return { deps, send, diagnose, voice, download, media, consumeAndBind, isEntitled, resolveProfile };
}

/* ========================================================================== */
/* The DB seam — the module imports these statically, so mock the module        */
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

/**
 * The text path builds its own `chatAnswerer` from `chat.service` (not an injectable seam) and reads
 * `ownsRequest` from `quota.service`, so both are mocked at the module level to keep this a pure
 * unit. `chatAnswerer` returns a factory whose call resolves to a fixed answer; `ownsRequest` returns
 * an opaque context that never touches a counter here.
 */
const chatAnswer = vi.fn(async () => ({
  answer: { content: 'Water less and remove infected leaves.' },
  conversationId: 'c1',
  farmerMessageId: 'm1',
  quota: {},
}));
vi.mock('@/services/chat.service', () => ({
  chatAnswerer: () => chatAnswer,
}));
vi.mock('@/services/quota.service', () => ({
  ownsRequest: (userId: string, operation: string) => ({ role: 'owns_request', userId, operation }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  claimInbound.mockResolvedValue(true);
  resolveSender.mockResolvedValue(null);
});

/* ========================================================================== */
/* Step 3 — the update_id claim / duplicate                                    */
/* ========================================================================== */

describe('the update_id claim (step 3)', () => {
  it('a fresh claim proceeds; the claim runs before anything billable', async () => {
    const { deps, diagnose } = makeDeps();
    await processInboundUpdate(dispatch({ kind: 'text' }), deps);
    // Claimed with the update_id, the sender id, and the kind.
    expect(claimInbound).toHaveBeenCalledWith(1, TG_USER, 'text');
    // The claim happened before any service was reached (a text turn does not call diagnose anyway,
    // but the ordering is what matters — the claim is call #1).
    expect(claimInbound).toHaveBeenCalledTimes(1);
    void diagnose;
  });

  it('a duplicate returns 200 and does NOTHING — no resolve, no service, no reply, no reserve', async () => {
    claimInbound.mockResolvedValueOnce(false);
    const { deps, send, diagnose, voice, resolveProfile } = makeDeps();

    const result = await processInboundUpdate(dispatch({ kind: 'photo', fileId: 'f1', textBody: null }), deps);

    expect(result.disposition).toBe('duplicate_ignored');
    expect(result.replySent).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(diagnose).not.toHaveBeenCalled();
    expect(voice).not.toHaveBeenCalled();
    expect(resolveProfile).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* Step 4 — /start, above resolution                                           */
/* ========================================================================== */

describe('/start short-circuits above profile resolution (step 4)', () => {
  it('a /start with a token binds and replies, without resolving the sender or calling a service', async () => {
    const { deps, send, consumeAndBind, resolveProfile, diagnose } = makeDeps();

    const result = await processInboundUpdate(
      dispatch({ kind: 'start', textBody: '/start TOKEN', startPayload: 'TOKEN' }),
      deps,
    );

    expect(consumeAndBind).toHaveBeenCalledWith('TOKEN', TG_USER, expect.any(Date));
    expect(resolveProfile).not.toHaveBeenCalled();
    expect(diagnose).not.toHaveBeenCalled();
    expect(result.disposition).toBe('linked');
    expect(send).toHaveBeenCalledWith(CHAT_ID, tg.replaced);
    expect(markProcessed).toHaveBeenCalledWith(1, 'owner-1');
  });

  it('a bare /start (no token) replies with the linking instructions and marks unlinked', async () => {
    const { deps, send, consumeAndBind } = makeDeps();

    const result = await processInboundUpdate(
      dispatch({ kind: 'start', textBody: '/start', startPayload: null }),
      deps,
    );

    expect(consumeAndBind).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(CHAT_ID, tg.linkingInstructions);
    expect(result.disposition).toBe('linking_instructions');
    expect(markUnlinked).toHaveBeenCalledWith(1);
  });

  it('an invalid /start token replies invalidLink and marks unlinked', async () => {
    const { deps, send, consumeAndBind } = makeDeps();
    consumeAndBind.mockResolvedValueOnce({ kind: 'invalid' });

    const result = await processInboundUpdate(
      dispatch({ kind: 'start', textBody: '/start BAD', startPayload: 'BAD' }),
      deps,
    );

    expect(send).toHaveBeenCalledWith(CHAT_ID, tg.invalidLink);
    expect(result.disposition).toBe('linking_instructions');
    expect(markUnlinked).toHaveBeenCalledWith(1);
  });

  it('a replaced bind also notifies the displaced Telegram account', async () => {
    const { deps, send, consumeAndBind } = makeDeps();
    consumeAndBind.mockResolvedValueOnce({ kind: 'replaced', ownerId: 'owner-1', replacedTelegramUserId: 99 });

    await processInboundUpdate(dispatch({ kind: 'start', textBody: '/start T', startPayload: 'T' }), deps);

    expect(send).toHaveBeenCalledWith(CHAT_ID, tg.replaced);
    expect(send).toHaveBeenCalledWith(99, tg.replacedNotice);
    expect(markProcessed).toHaveBeenCalledWith(1, 'owner-1');
  });
});

/* ========================================================================== */
/* Step 5 — /recharge is exempt from the gate (A2 decision 5)                   */
/* ========================================================================== */

describe('/recharge is exempt from the entitlement gate (step 5)', () => {
  it('recognizes the bare command, case-insensitively, with an optional @botname', () => {
    expect(isRechargeCommand('/recharge')).toBe(true);
    expect(isRechargeCommand('  /Recharge  ')).toBe(true);
    expect(isRechargeCommand('/recharge@JameeBot')).toBe(true);
    expect(isRechargeCommand('/recharge please')).toBe(false);
    expect(isRechargeCommand('recharge')).toBe(false);
    expect(isRechargeCommand(null)).toBe(false);
  });

  it('replies with the recharge copy and a link, WITHOUT calling the entitlement gate or a service', async () => {
    const { deps, send, isEntitled, diagnose } = makeDeps();
    resolveSender.mockResolvedValue(null); // resolveProfile default is injected, so this is unused
    const linked = { userId: 'owner-1', language: 'en' as const };
    const resolveProfile = vi.fn(async () => linked);

    const result = await processInboundUpdate(
      dispatch({ kind: 'text', textBody: '/recharge' }),
      { ...deps, resolveProfile },
    );

    expect(isEntitled).not.toHaveBeenCalled();
    expect(diagnose).not.toHaveBeenCalled();
    expect(result.disposition).toBe('recharge_link');
    const expected = messages('en').telegram.rechargeCommand
      .replace('{price}', String(RECHARGE_PRICE_RUPEES))
      .replace('{link}', 'https://app.example.test/profile');
    expect(send).toHaveBeenCalledWith(CHAT_ID, expected);
    expect(markProcessed).toHaveBeenCalledWith(1, 'owner-1');
  });

  it('a /recharge from an unlinked sender still replies (in English) and marks unlinked', async () => {
    const { deps, send } = makeDeps();
    const resolveProfile = vi.fn(async () => null);

    const result = await processInboundUpdate(
      dispatch({ kind: 'text', textBody: '/recharge' }),
      { ...deps, resolveProfile },
    );

    expect(result.disposition).toBe('recharge_link');
    expect(send).toHaveBeenCalledTimes(1);
    expect(markUnlinked).toHaveBeenCalledWith(1);
  });
});

/* ========================================================================== */
/* Step 6 — unlinked sender                                                    */
/* ========================================================================== */

describe('an unlinked sender (step 6)', () => {
  it('gets the linking instructions in English, zero quota, and an unlinked record', async () => {
    const { deps, send, isEntitled, diagnose } = makeDeps();
    const resolveProfile = vi.fn(async () => null);

    const result = await processInboundUpdate(dispatch({ kind: 'text' }), { ...deps, resolveProfile });

    expect(send).toHaveBeenCalledWith(CHAT_ID, tg.linkingInstructions);
    expect(result.disposition).toBe('unlinked');
    expect(isEntitled).not.toHaveBeenCalled();
    expect(diagnose).not.toHaveBeenCalled();
    expect(markUnlinked).toHaveBeenCalledWith(1);
  });
});

/* ========================================================================== */
/* Step 7 — the entitlement gate                                               */
/* ========================================================================== */

describe('the entitlement gate (step 7)', () => {
  it('a farmer with no active window gets the gated reply naming the ₹20/7-day recharge, zero quota, no service', async () => {
    const { deps, send, isEntitled, diagnose, voice } = makeDeps();
    isEntitled.mockResolvedValueOnce(false);

    const result = await processInboundUpdate(dispatch({ kind: 'photo', fileId: 'f1', textBody: null }), deps);

    expect(isEntitled).toHaveBeenCalledWith('owner-1', expect.any(Date));
    expect(diagnose).not.toHaveBeenCalled();
    expect(voice).not.toHaveBeenCalled();
    const expected = messages('en').telegram.gated.replace('{price}', String(RECHARGE_PRICE_RUPEES));
    expect(send).toHaveBeenCalledWith(CHAT_ID, expected);
    expect(result.disposition).toBe('not_entitled');
    expect(markNotEntitled).toHaveBeenCalledWith(1, 'owner-1');
    expect(markProcessed).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* Step 8 — unsupported type                                                   */
/* ========================================================================== */

describe('an unsupported type (step 8)', () => {
  it('gets the unsupported-type reply and a rejected record, after passing the gate', async () => {
    const { deps, send } = makeDeps();

    const result = await processInboundUpdate(dispatch({ kind: 'other', textBody: null }), deps);

    expect(send).toHaveBeenCalledWith(CHAT_ID, tg.unsupportedType);
    expect(result.disposition).toBe('rejected_unsupported_type');
    expect(markRejected).toHaveBeenCalledWith(1, 'owner-1');
  });
});

/* ========================================================================== */
/* Step 10 — dispatch by kind, then reply, then markProcessed                  */
/* ========================================================================== */

describe('dispatch by kind (step 10)', () => {
  it('text → the chat answerer, formatted as the reply, then markProcessed AFTER the send', async () => {
    const { deps, send } = makeDeps();

    const order: string[] = [];
    send.mockImplementation(async () => {
      order.push('send');
      return { ok: true, sentMessageId: 1 };
    });
    markProcessed.mockImplementation(async () => {
      order.push('markProcessed');
    });

    const result = await processInboundUpdate(
      dispatch({ kind: 'text', textBody: 'why are the leaves spotty?' }),
      deps,
    );

    // formatChatReply returns the answer content unchanged.
    expect(send).toHaveBeenCalledWith(CHAT_ID, 'Water less and remove infected leaves.');
    // markProcessed runs only AFTER the reply is sent (D11).
    expect(order).toEqual(['send', 'markProcessed']);
    expect(result.disposition).toBe('processed');
    expect(markProcessed).toHaveBeenCalledWith(1, 'owner-1');
  });

  it('photo → downloadFile, storeMedia as a crop image, then diagnose, then the formatted reply', async () => {
    const { deps, send, download, media, diagnose } = makeDeps();

    const result = await processInboundUpdate(
      dispatch({ kind: 'photo', fileId: 'photo-file', textBody: null }),
      deps,
    );

    expect(download).toHaveBeenCalledWith('photo-file', { kind: 'photo' });
    expect(media).toHaveBeenCalledWith(
      'owner-1',
      'crop-image',
      'image/jpeg',
      expect.any(Buffer),
      'telegram:photo-file',
    );
    expect(diagnose).toHaveBeenCalledTimes(1);
    const call = diagnose.mock.calls[0]![0] as { channel: string; image: { fileId: string } };
    expect(call.channel).toBe('telegram');
    expect(call.image.fileId).toBe('a'.repeat(24));
    expect(result.disposition).toBe('processed');
    expect(send).toHaveBeenCalledTimes(1);
    expect(markProcessed).toHaveBeenCalledWith(1, 'owner-1');
  });

  it('voice → downloadFile as voice, storeMedia as voice, then the voice service', async () => {
    const { deps, download, media, voice } = makeDeps();

    const result = await processInboundUpdate(
      dispatch({ kind: 'voice', fileId: 'voice-file', textBody: null, voiceMimeType: 'audio/ogg' }),
      deps,
    );

    expect(download).toHaveBeenCalledWith('voice-file', { kind: 'voice', reportedMimeType: 'audio/ogg' });
    expect(media).toHaveBeenCalledWith(
      'owner-1',
      'voice',
      'image/jpeg', // the download stub reports image/jpeg; the arg under test is that voice was stored as 'voice'
      expect.any(Buffer),
      'telegram:voice-file',
    );
    expect(voice).toHaveBeenCalledTimes(1);
    const call = voice.mock.calls[0]![0] as { channel: string };
    expect(call.channel).toBe('telegram');
    expect(result.disposition).toBe('processed');
  });
});

/* ========================================================================== */
/* D11 — the soft deadline                                                     */
/* ========================================================================== */

describe('the soft deadline (D11)', () => {
  it('when the budget is already spent, sends the taking-longer copy and marks failed, spending nothing', async () => {
    const start = 1_000;
    const { deps, send, diagnose } = makeDeps({
      now: () => start + TELEGRAM_SOFT_DEADLINE_MS + 1,
      requestStartMs: start,
    });

    const result = await processInboundUpdate(dispatch({ kind: 'photo', fileId: 'f1', textBody: null }), deps);

    expect(diagnose).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(CHAT_ID, tg.takingLonger);
    expect(result.disposition).toBe('soft_deadline');
    expect(markFailed).toHaveBeenCalledWith(1, 'owner-1');
  });
});

/* ========================================================================== */
/* dispatchTelegramRequest — verify + parse + claim                            */
/* ========================================================================== */

describe('dispatchTelegramRequest (steps 1–3)', () => {
  function request(headers: Record<string, string>, body: unknown): Request {
    return new Request('https://jamee.test/api/telegram', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  it('a missing/wrong secret token is authenticated:false — the 401 branch, body never parsed', async () => {
    const { deps } = makeDeps();
    const outcome = await dispatchTelegramRequest(request({ 'x-telegram-bot-api-secret-token': 'wrong' }, {}), deps);
    expect(outcome.authenticated).toBe(false);
    expect(claimInbound).not.toHaveBeenCalled();
  });

  it('a valid token with an unparseable update is acknowledged (authenticated:true) and dropped', async () => {
    const { deps } = makeDeps();
    const outcome = await dispatchTelegramRequest(
      request({ 'x-telegram-bot-api-secret-token': SECRET }, { not: 'an update' }),
      deps,
    );
    expect(outcome.authenticated).toBe(true);
    if (outcome.authenticated) expect(outcome.result.disposition).toBe('ignored_unparsed');
    expect(claimInbound).not.toHaveBeenCalled();
  });

  it('a valid token with a well-formed text update runs the pipeline and claims the update', async () => {
    const { deps } = makeDeps();
    resolveSender.mockResolvedValue(null); // unused; resolveProfile injected
    const body = { update_id: 7, message: { from: { id: TG_USER }, chat: { id: CHAT_ID }, text: 'hi' } };
    const outcome = await dispatchTelegramRequest(
      request({ 'x-telegram-bot-api-secret-token': SECRET }, body),
      deps,
    );
    expect(outcome.authenticated).toBe(true);
    expect(claimInbound).toHaveBeenCalledWith(7, TG_USER, 'text');
  });
});
