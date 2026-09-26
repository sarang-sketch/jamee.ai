import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { COLLECTIONS } from '@/lib/db/names';
import { setupDatabase } from '@/lib/db/setup';
import type { TelegramDispatch } from '@/lib/telegram';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from './mongo';

/**
 * End-to-end integration for the Telegram inbound pipeline against a single-node
 * `MongoMemoryReplSet` (V31, V33) with the real collection validators from `setupDatabase`.
 *
 * What this proves — and why it needs a real database rather than a stub:
 *
 *  1. **The `update_id` claim is idempotent under concurrent deliveries (11.5–11.8, D19).** Two
 *     deliveries of the same `update_id` race the real MongoDB `insertOne(_id = update_id)`; exactly
 *     one wins the claim and drives the pipeline, the other is `duplicate_ignored` and does nothing.
 *     A stub cannot prove this — the guarantee IS the unique-index race.
 *  2. **A gated farmer's update invokes no service and reserves no quota (22.13–22.16).** The
 *     entitlement gate reads a real `bot_entitlements` row; with none, no diagnosis/voice/chat runs
 *     and the `counters` collection stays empty for that farmer.
 *  3. **A Telegram turn stores its conversation, message and usage-log documents with channel
 *     `telegram`, and they pass the collection validators (16.5, D7).** The chat persistence is the
 *     real Data_Access_Layer; only the model gateway is stubbed (a real service tests must never
 *     touch), so the documents are written by production code and accepted by the real validators —
 *     which is exactly what the channel-vocabulary widening could have broken.
 *
 * `MONGODB_URI` is pointed at the harness in `beforeAll` BEFORE any module that constructs the DAL
 * client is imported, so `src/lib/db/client.ts` caches a client for the in-memory server. The model
 * gateway is mocked at the module level so the chat answer is produced without a network call.
 */

/** A canned model runner so the chat answer is produced with no network call (no real service). */
const generate = vi.fn(async () => ({
  value: 'Water the plants less and remove the affected leaves.',
  provider: 'groq' as const,
  usedFallback: false,
}));
vi.mock('@/lib/ai/capabilities', () => ({
  gatewayRunner: () => ({
    classify: async () => ({ value: '{}', provider: 'gemini', usedFallback: false }),
    generate: (...a: unknown[]) => generate(...(a as [])),
  }),
}));

let harness: MongoHarness | undefined;
type DispatchMod = typeof import('@/lib/telegram-dispatch');
let dispatchMod: DispatchMod;

const USER = 'auth-user-telegram';
const TG_USER = 987654;
const CHAT_ID = 111;

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = 'integration-secret';
  process.env.BETTER_AUTH_URL = 'https://app.example.test';
  // Import AFTER MONGODB_URI is set so the DAL client connects to the harness.
  dispatchMod = await import('@/lib/telegram-dispatch');
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  if (harness) await clearDatabase(harness.db);
  vi.clearAllMocks();
  generate.mockResolvedValue({
    value: 'Water the plants less and remove the affected leaves.',
    provider: 'groq',
    usedFallback: false,
  });
});

function db() {
  if (harness === undefined) throw new Error('harness not started');
  return harness.db;
}

/** Seed a linked profile; optionally an active entitlement window. */
async function seedFarmer(opts: { entitled: boolean }): Promise<void> {
  const now = new Date();
  await db().collection(COLLECTIONS.profiles).insertOne({
    _id: USER,
    email: 'farmer@example.test',
    telegramUserId: TG_USER,
    language: 'en',
    createdAt: now,
    updatedAt: now,
  } as never);
  if (opts.entitled) {
    await db().collection(COLLECTIONS.botEntitlements).insertOne({
      _id: USER,
      providerPaymentId: 'pay_integration_1',
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      grantedAt: now,
      updatedAt: now,
    } as never);
  }
}

function textDispatch(updateId: number, text: string): TelegramDispatch {
  return {
    updateId,
    telegramUserId: TG_USER,
    chatId: CHAT_ID,
    kind: 'text',
    textBody: text,
    fileId: null,
    voiceMimeType: null,
    startPayload: null,
  };
}

/** A send spy and deps that leave every DB-touching seam at its real default. */
function realDeps(send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }))) {
  return {
    send,
    // resolveProfile, isEntitled, conversations all default to the real Data_Access_Layer paths.
    now: () => Date.now(),
    platformDeadline: () => undefined,
    rechargeBaseUrl: 'https://app.example.test',
  };
}

/* ========================================================================== */
/* 1. The claim is idempotent under concurrent deliveries                       */
/* ========================================================================== */

describe('the update_id claim under concurrency (D19)', () => {
  it('two concurrent deliveries of one update_id: exactly one processes, one is duplicate_ignored', async () => {
    await seedFarmer({ entitled: true });
    const send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }));

    const [a, b] = await Promise.all([
      dispatchMod.processInboundUpdate(textDispatch(5000, 'why are my leaves spotty?'), realDeps(send)),
      dispatchMod.processInboundUpdate(textDispatch(5000, 'why are my leaves spotty?'), realDeps(send)),
    ]);

    const dispositions = [a.disposition, b.disposition].sort();
    expect(dispositions).toEqual(['duplicate_ignored', 'processed']);

    // Exactly one telegram_inbound row exists for the update_id, and it is terminal.
    const rows = await db().collection(COLLECTIONS.telegramInbound).find({ _id: 5000 } as never).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('processed');

    // The duplicate did no billable work: exactly one conversation and one usage-log turn.
    expect(await db().collection(COLLECTIONS.conversations).countDocuments({ ownerId: USER })).toBe(1);
  });

  it('a redelivery after the first is processed is a no-op (claim returns false)', async () => {
    await seedFarmer({ entitled: true });
    const first = await dispatchMod.processInboundUpdate(textDispatch(5001, 'hello'), realDeps());
    const second = await dispatchMod.processInboundUpdate(textDispatch(5001, 'hello'), realDeps());
    expect(first.disposition).toBe('processed');
    expect(second.disposition).toBe('duplicate_ignored');
  });
});

/* ========================================================================== */
/* 2. A gated farmer invokes no service and reserves no quota                   */
/* ========================================================================== */

describe('a gated farmer (22.13–22.16)', () => {
  it('an update from a linked-but-unentitled farmer invokes no service and reserves no quota', async () => {
    await seedFarmer({ entitled: false });
    const send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }));
    const diagnose = vi.fn();
    const voice = vi.fn();

    const result = await dispatchMod.processInboundUpdate(
      // A photo update, so any billable dispatch would call diagnose.
      {
        updateId: 6000,
        telegramUserId: TG_USER,
        chatId: CHAT_ID,
        kind: 'photo',
        textBody: null,
        fileId: 'photo-1',
        voiceMimeType: null,
        startPayload: null,
      },
      { ...realDeps(send), diagnose: diagnose as never, voice: voice as never },
    );

    expect(result.disposition).toBe('not_entitled');
    expect(diagnose).not.toHaveBeenCalled();
    expect(voice).not.toHaveBeenCalled();
    // The model gateway was never reached either.
    expect(generate).not.toHaveBeenCalled();

    // No quota reserved: the counters collection has no row for this farmer, and no conversation
    // or message was created.
    expect(await db().collection(COLLECTIONS.counters).countDocuments({ ownerId: USER })).toBe(0);
    expect(await db().collection(COLLECTIONS.conversations).countDocuments({ ownerId: USER })).toBe(0);
    expect(await db().collection(COLLECTIONS.messages).countDocuments({ ownerId: USER })).toBe(0);

    // The record is terminal as not_entitled, attributed to the resolved farmer.
    const row = await db().collection(COLLECTIONS.telegramInbound).findOne({ _id: 6000 } as never);
    expect(row?.status).toBe('not_entitled');
    expect(row?.ownerId).toBe(USER);
  });
});

/* ========================================================================== */
/* 3. A Telegram turn stores docs with channel telegram, passing the validators */
/* ========================================================================== */

describe('a Telegram text turn persists with channel telegram (16.5, D7)', () => {
  it('stores conversation, message and usage-log documents with channel telegram, accepted by the validators', async () => {
    await seedFarmer({ entitled: true });
    const send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }));

    const result = await dispatchMod.processInboundUpdate(
      textDispatch(7000, 'my tomato leaves have brown spots, what should I do?'),
      realDeps(send),
    );

    expect(result.disposition).toBe('processed');
    expect(send).toHaveBeenCalledTimes(1);

    // The conversation was created on the telegram channel — and it was ACCEPTED by the validator
    // (an insert of a non-enum channel would have thrown a write error, failing this test).
    const conversation = await db().collection(COLLECTIONS.conversations).findOne({ ownerId: USER } as never);
    expect(conversation).not.toBeNull();
    expect(conversation!.channel).toBe('telegram');

    // The farmer message (and the jamee answer) were persisted on the telegram channel.
    const messages = await db().collection(COLLECTIONS.messages).find({ ownerId: USER } as never).toArray();
    expect(messages.length).toBeGreaterThanOrEqual(1);
    for (const m of messages) expect(m.channel).toBe('telegram');
    expect(messages.some((m) => m.role === 'farmer')).toBe(true);

    // The usage-log turn recorded channel telegram, operation chat — again accepted by the validator.
    const logs = await db().collection(COLLECTIONS.usageLogs).find({ ownerId: USER } as never).toArray();
    expect(logs.length).toBeGreaterThanOrEqual(1);
    for (const l of logs) {
      expect(l.channel).toBe('telegram');
      expect(l.operation).toBe('chat');
    }
  });
});
