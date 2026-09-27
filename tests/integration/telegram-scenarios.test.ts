import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { COLLECTIONS, type BotEntitlementDoc, type ProfileDoc } from '@/lib/db/collections';
import type { TelegramDispatch } from '@/lib/telegram';

import { startHarness, type Harness } from './harness';

/**
 * The Telegram inbound pipeline, scenario by scenario, against a real single-node
 * `MongoMemoryReplSet` (V31, V33). The Amendment A3 successor to the retired WhatsApp scenarios.
 *
 * Requirements: 10.4, 10.5, 10.6 (photo/text/voice dispatch on channel telegram), 10.9 (an
 *               unsupported type is refused), 10.3 / 21.17 (an unlinked sender gets the linking
 *               instructions, zero quota), 11.5–11.8 (a duplicate `update_id` does nothing billable),
 *               22.13–22.16 (a linked-but-lapsed farmer is gated, zero quota, no message, no
 *               diagnosis), 14.4 (a provider rate limit retries on the fallback), the soft-deadline
 *               (timeout) branch, 16.5 (channel telegram on every persisted row)
 * Design: "Telegram adapter — Inbound processing order"; D7, D11, D14, D19; Amendment A2 (the
 *         windowed entitlement gate); Amendment A3
 *
 * The model gateway is mocked at the capability seam (a real service tests must never touch), and
 * the photo/voice dispatch's download + service are injected so the pipeline's DISPOSITION is what
 * is under test rather than a network round trip. Everything the Data_Access_Layer touches — the
 * `update_id` claim, sender resolution, the entitlement gate, the conversation and message
 * persistence — is real.
 */

const generate = vi.fn(async () => ({
  value: 'Remove the affected leaves and keep the plants dry.',
  provider: 'groq' as const,
  usedFallback: false,
}));
vi.mock('@/lib/ai/capabilities', () => ({
  gatewayRunner: () => ({
    classify: async () => ({ value: '{}', provider: 'gemini', usedFallback: false }),
    generate: (...a: unknown[]) => generate(...(a as [])),
  }),
}));

const USER = 'auth-user-telegram';
const TG_USER = 424242;
const CHAT_ID = 9090;

let harness: Harness;
type DispatchMod = typeof import('@/lib/telegram-dispatch');
let dispatchMod: DispatchMod;

beforeAll(async () => {
  harness = await startHarness();
  process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = 'integration-secret';
  process.env.BETTER_AUTH_URL = 'https://app.example.test';
  dispatchMod = await import('@/lib/telegram-dispatch');
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await harness.reset();
  vi.clearAllMocks();
  generate.mockResolvedValue({
    value: 'Remove the affected leaves and keep the plants dry.',
    provider: 'groq',
    usedFallback: false,
  });
});

function db() {
  return harness.db;
}

/** Seed a linked profile (telegram id set); optionally an entitlement window. */
async function seedFarmer(opts: { entitled: boolean; expiresAt?: Date }): Promise<void> {
  const now = new Date();
  await db().collection<ProfileDoc>(COLLECTIONS.profiles).insertOne({
    _id: USER,
    email: 'farmer@example.test',
    telegramUserId: TG_USER,
    language: 'en',
    createdAt: now,
    updatedAt: now,
  });
  if (opts.entitled || opts.expiresAt !== undefined) {
    await db().collection<BotEntitlementDoc>(COLLECTIONS.botEntitlements).insertOne({
      _id: USER,
      providerPaymentId: 'pay_tg_1',
      expiresAt: opts.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      grantedAt: now,
      updatedAt: now,
    });
  }
}

function textDispatch(updateId: number, text: string): TelegramDispatch {
  return { updateId, telegramUserId: TG_USER, chatId: CHAT_ID, kind: 'text', textBody: text, fileId: null, voiceMimeType: null, startPayload: null };
}
function photoDispatch(updateId: number): TelegramDispatch {
  return { updateId, telegramUserId: TG_USER, chatId: CHAT_ID, kind: 'photo', textBody: null, fileId: 'photo-1', voiceMimeType: null, startPayload: null };
}
function voiceDispatch(updateId: number): TelegramDispatch {
  return { updateId, telegramUserId: TG_USER, chatId: CHAT_ID, kind: 'voice', textBody: null, fileId: 'voice-1', voiceMimeType: 'audio/ogg', startPayload: null };
}
function otherDispatch(updateId: number): TelegramDispatch {
  return { updateId, telegramUserId: TG_USER, chatId: CHAT_ID, kind: 'other', textBody: null, fileId: null, voiceMimeType: null, startPayload: null };
}

/** A send spy plus injected download/media/diagnose/voice so photo/voice dispatch needs no network. */
function deps(send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }))) {
  return {
    send,
    now: () => Date.now(),
    platformDeadline: () => undefined,
    rechargeBaseUrl: 'https://app.example.test',
    download: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), size: 3, mimeType: 'image/jpeg' })) as never,
    media: vi.fn(async () => ({ fileId: (await import('mongodb')).ObjectId.createFromTime(2), kind: 'crop-image' as const })) as never,
    diagnose: vi.fn(async () => ({
      diagnosisId: 'd1',
      conversationId: 'c1',
      result: { status: 'identified' as const, diseaseName: 'Tomato Early Blight' as const, confidence: 0.9, severity: 'moderate' as const, explanation: 'x', knowledge: {} as never, needsExpert: false as const, language: 'en' as const },
      quota: { operation: 'image' as const, used: 1, limit: 20, resetsAt: new Date().toISOString() },
      provider: 'gemini' as const,
      usedFallback: false,
    })) as never,
    voice: vi.fn(async () => ({
      transcript: 'my leaves have spots',
      answer: { content: 'Remove the affected leaves.', groundedIn: null, needsExpert: false as const, language: 'en' as const },
      conversationId: 'c1',
      quota: { operation: 'voice' as const, used: 1, limit: 20, resetsAt: new Date().toISOString() },
      farmerMessageId: 'm1',
      provider: 'groq' as const,
      usedFallback: false,
      audio: { outcome: 'deleted' as const },
    })) as never,
  };
}

/* ========================================================================== */
/* A linked, entitled farmer — text / photo / voice (10.4–10.6, 16.5)          */
/* ========================================================================== */

describe('a linked, entitled farmer', () => {
  it('processes a text turn and persists it on channel telegram', async () => {
    await seedFarmer({ entitled: true });
    const send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }));

    const result = await dispatchMod.processInboundUpdate(textDispatch(1001, 'why are my leaves spotty?'), deps(send));

    expect(result.disposition).toBe('processed');
    expect(send).toHaveBeenCalledTimes(1);
    const conv = await db().collection(COLLECTIONS.conversations).findOne({ ownerId: USER });
    expect(conv?.channel).toBe('telegram');
    const row = await db().collection(COLLECTIONS.telegramInbound).findOne({ _id: 1001 as never });
    expect(row?.status).toBe('processed');
    expect(row?.ownerId).toBe(USER);
  });

  it('processes a photo through the diagnosis service', async () => {
    await seedFarmer({ entitled: true });
    const d = deps();
    const result = await dispatchMod.processInboundUpdate(photoDispatch(1002), d);
    expect(result.disposition).toBe('processed');
    expect(d.diagnose).toHaveBeenCalledTimes(1);
  });

  it('processes a voice note through the voice service', async () => {
    await seedFarmer({ entitled: true });
    const d = deps();
    const result = await dispatchMod.processInboundUpdate(voiceDispatch(1003), d);
    expect(result.disposition).toBe('processed');
    expect(d.voice).toHaveBeenCalledTimes(1);
  });

  it('refuses an unsupported type with zero quota and no service call (10.9)', async () => {
    await seedFarmer({ entitled: true });
    const d = deps();
    const result = await dispatchMod.processInboundUpdate(otherDispatch(1004), d);
    expect(result.disposition).toBe('rejected_unsupported_type');
    expect(d.diagnose).not.toHaveBeenCalled();
    expect(d.voice).not.toHaveBeenCalled();
    expect(await db().collection(COLLECTIONS.counters).countDocuments({ ownerId: USER })).toBe(0);
    const row = await db().collection(COLLECTIONS.telegramInbound).findOne({ _id: 1004 as never });
    expect(row?.status).toBe('rejected');
  });
});

/* ========================================================================== */
/* Duplicate delivery (11.5–11.8)                                              */
/* ========================================================================== */

describe('a duplicate delivery', () => {
  it('two concurrent deliveries of one update_id: one processes, one is duplicate_ignored', async () => {
    await seedFarmer({ entitled: true });
    const [a, b] = await Promise.all([
      dispatchMod.processInboundUpdate(textDispatch(2001, 'hello'), deps()),
      dispatchMod.processInboundUpdate(textDispatch(2001, 'hello'), deps()),
    ]);
    expect([a.disposition, b.disposition].sort()).toEqual(['duplicate_ignored', 'processed']);
    expect(await db().collection(COLLECTIONS.conversations).countDocuments({ ownerId: USER })).toBe(1);
    const rows = await db().collection(COLLECTIONS.telegramInbound).find({ _id: 2001 as never }).toArray();
    expect(rows).toHaveLength(1);
  });

  it('a redelivery after the first is processed is a no-op', async () => {
    await seedFarmer({ entitled: true });
    const first = await dispatchMod.processInboundUpdate(textDispatch(2002, 'hello'), deps());
    const second = await dispatchMod.processInboundUpdate(textDispatch(2002, 'hello'), deps());
    expect(first.disposition).toBe('processed');
    expect(second.disposition).toBe('duplicate_ignored');
  });
});

/* ========================================================================== */
/* An unlinked sender (10.3, 21.17)                                            */
/* ========================================================================== */

describe('an unlinked sender', () => {
  it('gets the linking instructions, zero quota, no service, status unlinked', async () => {
    const d = deps();
    const result = await dispatchMod.processInboundUpdate(textDispatch(3001, 'hello'), d);
    expect(result.disposition).toBe('unlinked');
    expect(await db().collection(COLLECTIONS.counters).countDocuments()).toBe(0);
    expect(await db().collection(COLLECTIONS.conversations).countDocuments()).toBe(0);
    const row = await db().collection(COLLECTIONS.telegramInbound).findOne({ _id: 3001 as never });
    expect(row?.status).toBe('unlinked');
  });
});

/* ========================================================================== */
/* A lapsed-window sender (22.13–22.16, A2)                                    */
/* ========================================================================== */

describe('a linked but lapsed-window sender', () => {
  it('is gated: zero quota, no message, no diagnosis, status not_entitled', async () => {
    await seedFarmer({ entitled: false, expiresAt: new Date(Date.now() - 60_000) });
    const d = deps();

    const result = await dispatchMod.processInboundUpdate(photoDispatch(4001), d);
    expect(result.disposition).toBe('not_entitled');
    expect(d.diagnose).not.toHaveBeenCalled();
    expect(await db().collection(COLLECTIONS.counters).countDocuments({ ownerId: USER })).toBe(0);
    expect(await db().collection(COLLECTIONS.conversations).countDocuments({ ownerId: USER })).toBe(0);
    expect(await db().collection(COLLECTIONS.messages).countDocuments({ ownerId: USER })).toBe(0);
    const row = await db().collection(COLLECTIONS.telegramInbound).findOne({ _id: 4001 as never });
    expect(row?.status).toBe('not_entitled');
    expect(row?.ownerId).toBe(USER);
  });

  it('a farmer with no entitlement row at all is gated the same way', async () => {
    await seedFarmer({ entitled: false });
    const d = deps();
    const result = await dispatchMod.processInboundUpdate(textDispatch(4002, 'hello'), d);
    expect(result.disposition).toBe('not_entitled');
  });
});

/* ========================================================================== */
/* The soft-deadline (timeout) branch (D11)                                    */
/* ========================================================================== */

describe('the soft deadline', () => {
  it('replies with the taking-longer copy, marks failed, and spends nothing', async () => {
    await seedFarmer({ entitled: true });
    const d = deps();
    const result = await dispatchMod.processInboundUpdate(photoDispatch(5001), {
      ...d,
      now: () => 1_000_000,
      platformDeadline: () => new Date(0),
    });
    expect(result.disposition).toBe('soft_deadline');
    expect(d.diagnose).not.toHaveBeenCalled();
    expect(await db().collection(COLLECTIONS.counters).countDocuments({ ownerId: USER })).toBe(0);
    const row = await db().collection(COLLECTIONS.telegramInbound).findOne({ _id: 5001 as never });
    expect(row?.status).toBe('failed');
  });
});

/* ========================================================================== */
/* Provider rate-limit fallback (14.4)                                         */
/* ========================================================================== */

describe('a provider rate limit', () => {
  it('is served by the fallback member: the text turn still processes', async () => {
    await seedFarmer({ entitled: true });
    generate.mockResolvedValueOnce({ value: 'answer via fallback', provider: 'groq', usedFallback: true });
    const send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }));
    const result = await dispatchMod.processInboundUpdate(textDispatch(6001, 'why spots?'), deps(send));
    expect(result.disposition).toBe('processed');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
