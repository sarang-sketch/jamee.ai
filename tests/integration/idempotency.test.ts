import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RECHARGE_PRICE_PAISE } from '@/lib/config/access';
import { COLLECTIONS, type ProfileDoc } from '@/lib/db/collections';

import { startHarness, type Harness } from './harness';

/**
 * Inbound and grant idempotency, against the REAL unique indexes — the Amendment A3 successor to the
 * WhatsApp `provider_message_id` primary-key test.
 *
 * Requirements: 11.5–11.8 (a redelivered Telegram `update_id` is acknowledged, invokes no shared
 *               service, and leaves quota unchanged), 22.10, 22.11 (a captured payment grants and
 *               extends the window exactly once, however many times its webhook is redelivered)
 * Design: D19 (every single-statement atomicity guarantee mapped to a specific MongoDB operation;
 *         the `telegram_inbound._id = update_id` insert's duplicate-key error IS the duplicate
 *         signal, and the `bot_entitlements.providerPaymentId` unique index is the grant's claim),
 *         D11; Amendment A3; Property 23, Property 36
 *
 * =============================================================================
 * WHY A STUB CANNOT MAKE THESE CLAIMS
 * =============================================================================
 *
 * Unit tests establish what a module DOES with a duplicate-key answer — a `11000` becomes
 * `duplicate`, a redelivery writes no second row. They cannot establish that the answer is right,
 * because a single-threaded in-memory Map serialises itself for free: two `insertOne` calls cannot
 * interleave in JavaScript, so a stub is idempotent whether or not the index is. The two things that
 * need real Mongo are here: a true-concurrent `update_id` claim (only the primary key makes at-most-
 * one atomic) and a redelivered captured payment extending the window exactly once (only the unique
 * `providerPaymentId` index enforces it).
 */

let harness: Harness;
type Farmer = typeof import('@/lib/db/farmer');
type Access = typeof import('@/lib/db/access');
type Payment = typeof import('@/services/payment.service');
let farmer: Farmer;
let access: Access;
let payment: Payment;

beforeAll(async () => {
  harness = await startHarness();
  farmer = await import('@/lib/db/farmer');
  access = await import('@/lib/db/access');
  payment = await import('@/services/payment.service');
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await harness.reset();
});

/* ========================================================================== */
/* The Telegram update_id claim (11.5–11.8, D19)                              */
/* ========================================================================== */

describe('the telegram update_id claim', () => {
  it('two concurrent claims of one update_id: exactly one wins, exactly one row exists', async () => {
    const [a, b] = await Promise.all([
      farmer.claimTelegramUpdate(9001, 555, 'text'),
      farmer.claimTelegramUpdate(9001, 555, 'text'),
    ]);

    // Exactly one fresh claim (`true`), one duplicate (`false`).
    expect([a, b].filter((won) => won === true)).toHaveLength(1);
    expect([a, b].filter((won) => won === false)).toHaveLength(1);

    // Exactly one telegram_inbound row for the update_id, in the initial `received` state.
    const rows = await harness.db.collection(COLLECTIONS.telegramInbound).find({ _id: 9001 as never }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('received');
  });

  it('a redelivery after the first claim is a duplicate (returns false) and writes no second row', async () => {
    expect(await farmer.claimTelegramUpdate(9002, 555, 'photo')).toBe(true);
    expect(await farmer.claimTelegramUpdate(9002, 555, 'photo')).toBe(false);

    const rows = await harness.db.collection(COLLECTIONS.telegramInbound).find({ _id: 9002 as never }).toArray();
    expect(rows).toHaveLength(1);
  });

  it('the terminal-status write moves the claimed row to processed with its owner (D11)', async () => {
    await farmer.claimTelegramUpdate(9003, 555, 'text');
    await farmer.setTelegramInboundStatus(9003, 'processed', 'auth-user-x');

    const row = await harness.db.collection(COLLECTIONS.telegramInbound).findOne({ _id: 9003 as never });
    expect(row?.status).toBe('processed');
    expect(row?.ownerId).toBe('auth-user-x');
    expect(row?.completedAt).toBeInstanceOf(Date);
  });
});

/* ========================================================================== */
/* The payment providerPaymentId single-grant (22.10, 22.11, D19, Property 36) */
/* ========================================================================== */

describe('the payment grant claim', () => {
  async function seedProfile(userId: string): Promise<void> {
    const now = new Date();
    await harness.db.collection<ProfileDoc>(COLLECTIONS.profiles).insertOne({
      _id: userId,
      email: `${userId}@example.test`,
      language: 'en',
      createdAt: now,
      updatedAt: now,
    });
  }

  const captured = (orderId: string, paymentId: string) =>
    ({ kind: 'captured', paymentId, orderId, amountMinor: RECHARGE_PRICE_PAISE, status: 'captured', eventId: null }) as const;

  it('a captured webhook redelivered five times extends the window exactly once', async () => {
    await seedProfile('farmer-idem');
    await access.accessData('farmer-idem').insertPaymentOrder({
      providerOrderId: 'order-idem',
      amountMinor: RECHARGE_PRICE_PAISE,
      currency: 'INR',
      status: 'created',
    });

    const first = await payment.processVerifiedWebhook(captured('order-idem', 'pay-idem'));
    expect(first.kind).toBe('granted');
    const grantedExpiry = first.kind === 'granted' ? first.expiresAt.getTime() : 0;

    for (let i = 0; i < 4; i += 1) {
      const again = await payment.processVerifiedWebhook(captured('order-idem', 'pay-idem'));
      expect(again.kind).toBe('duplicate');
    }

    const ent = await access.accessData('farmer-idem').readEntitlement();
    expect(ent?.expiresAt.getTime()).toBe(grantedExpiry);
    // Exactly one entitlement row for the farmer, and one carrying that payment id.
    expect(await harness.db.collection(COLLECTIONS.botEntitlements).countDocuments({ _id: 'farmer-idem' as never })).toBe(1);
    expect(await harness.db.collection(COLLECTIONS.botEntitlements).countDocuments({ providerPaymentId: 'pay-idem' })).toBe(1);
  });
});
