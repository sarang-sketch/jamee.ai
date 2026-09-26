import { createHash } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { COLLECTIONS, type ProfileDoc } from '@/lib/db/collections';
import { RECHARGE_PERIOD_DAYS } from '@/lib/config/access';
import { setupDatabase } from '@/lib/db/setup';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from './mongo';

/**
 * Integration tests for the access flow — linking consume-and-bind, the payment grant-plus-extend,
 * and unlink — against a single-node `MongoMemoryReplSet` (V31, V33), because every claim here is
 * about a MULTI-DOCUMENT TRANSACTION and a real unique index, and neither can be established with a
 * stub.
 *
 * Requirements: 21.7, 21.8, 21.10–21.13, 21.15 (the bind outcomes and unlink), 22.10, 22.11 (the
 *               grant is idempotent and extends the window exactly once), 22.19 (a failed/forged
 *               payment changes nothing), 13.1, 13.2 (owner-scoping)
 * Design: D13, D14, D15, D19; Amendment A2; Properties 32, 34, 35, 36
 *
 * `MONGODB_URI` is pointed at the in-memory replica set in `beforeAll` BEFORE any DAL/service runs,
 * and the modules that reach `src/lib/db/client.ts` are imported dynamically AFTER that, so the
 * lazily-constructed cached client connects to the harness rather than to a real Atlas cluster.
 *
 * =============================================================================
 * WHY A STUB CANNOT MAKE ANY OF THESE CLAIMS
 * =============================================================================
 *
 * The unit tests establish what each function DOES with a DAL answer — a `bound` variant maps to a
 * `bound` outcome, a duplicate payment is ignored. They cannot establish that the answer is right,
 * because a single-threaded in-memory Map serialises itself for free: two `findOneAndUpdate` calls
 * cannot interleave in JavaScript, so a stubbed store is idempotent whether or not the index is.
 * The three things that need real Mongo are all below: true-concurrent token consumption (only the
 * single conditional update makes at-most-one atomic), the partial-unique telegram index (only it
 * enforces "already linked elsewhere leaves the token unconsumed"), and the entitlement's unique
 * `providerPaymentId` (only it makes five redeliveries extend once).
 */

let harness: MongoHarness | undefined;
type AccessDal = typeof import('@/lib/db/access');
type Linking = typeof import('@/services/linking.service');
type Payment = typeof import('@/services/payment.service');
type Entitlement = typeof import('@/services/entitlement.service');

let access: AccessDal;
let linking: Linking;
let payment: Payment;
let entitlement: Entitlement;

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  // Import AFTER MONGODB_URI is set so client.ts caches a client for the in-memory server.
  access = await import('@/lib/db/access');
  linking = await import('@/services/linking.service');
  payment = await import('@/services/payment.service');
  entitlement = await import('@/services/entitlement.service');
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  if (harness) await clearDatabase(harness.db);
});

function db() {
  if (harness === undefined) throw new Error('harness not started');
  return harness.db;
}

const sha256 = (plaintext: string): string => createHash('sha256').update(plaintext, 'utf8').digest('hex');

/** Seed a profile row (the linking bind updates it; a farmer always has one via the D8 bootstrap). */
async function seedProfile(userId: string, telegramUserId: number | null = null): Promise<void> {
  const now = new Date();
  const doc: ProfileDoc = {
    _id: userId,
    email: `${userId}@example.test`,
    language: 'en',
    createdAt: now,
    updatedAt: now,
    ...(telegramUserId === null ? {} : { telegramUserId }),
  };
  await db().collection<ProfileDoc>(COLLECTIONS.profiles).insertOne(doc);
}

/** Insert an unconsumed link token for `userId`, returning its plaintext. */
async function seedLinkToken(userId: string, ttlMinutes = 15, plaintext = `tok-${userId}-${Date.now()}`): Promise<string> {
  const inserted = await access.accessData(userId).insertLinkToken({
    tokenHash: sha256(plaintext),
    expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
  });
  expect(inserted._id).toBeDefined();
  return plaintext;
}

/** Insert a `created` payment order and return its provider order id. */
async function seedOrder(userId: string, providerOrderId: string): Promise<void> {
  await access.accessData(userId).insertPaymentOrder({
    providerOrderId,
    amountMinor: 2000,
    currency: 'INR',
    status: 'created',
  });
}

/* ========================================================================== */
/* Linking — consume-and-bind (D13, D19, Property 32)                          */
/* ========================================================================== */

describe('consumeAndBind', () => {
  it('two concurrent calls on one token produce at most one binding (Property 32)', async () => {
    await seedProfile('farmer-A');
    const token = await seedLinkToken('farmer-A');

    // Two different Telegram ids racing to consume the SAME token.
    const [a, b] = await Promise.all([
      linking.consumeAndBind(token, 111),
      linking.consumeAndBind(token, 222),
    ]);

    const kinds = [a.kind, b.kind];
    const bounds = kinds.filter((k) => k === 'bound');
    const invalids = kinds.filter((k) => k === 'invalid');
    // Exactly one consumer wins the single conditional update; the other sees an already-consumed
    // token, which is indistinguishable from unknown/expired — the `invalid` variant (21.8).
    expect(bounds).toHaveLength(1);
    expect(invalids).toHaveLength(1);

    // The profile holds exactly one telegram id, and the token is consumed.
    const profile = await db().collection<ProfileDoc>(COLLECTIONS.profiles).findOne({ _id: 'farmer-A' });
    expect([111, 222]).toContain(profile?.telegramUserId);
    const tokenDoc = await db().collection(COLLECTIONS.linkTokens).findOne({ tokenHash: sha256(token) });
    expect(tokenDoc?.consumedAt).toBeInstanceOf(Date);
  });

  it('unknown, expired, and consumed tokens all return the same indistinguishable variant (21.8)', async () => {
    await seedProfile('farmer-A');

    // unknown — never minted.
    const unknown = await linking.consumeAndBind('never-minted', 111);

    // expired — minted with a TTL already in the past.
    const expiredPlain = 'expired-token';
    await access.accessData('farmer-A').insertLinkToken({
      tokenHash: sha256(expiredPlain),
      expiresAt: new Date(Date.now() - 60_000),
    });
    const expired = await linking.consumeAndBind(expiredPlain, 111);

    // consumed — minted, then spent by a first successful bind, then tried again.
    const consumedPlain = await seedLinkToken('farmer-A');
    const first = await linking.consumeAndBind(consumedPlain, 111);
    expect(first.kind).toBe('bound');
    const consumed = await linking.consumeAndBind(consumedPlain, 111);

    expect(unknown.kind).toBe('invalid');
    expect(expired.kind).toBe('invalid');
    // The second use of a consumed token is `invalid`, NOT `already_linked` — the token is spent,
    // and the token filter fails before any profile is read.
    expect(consumed.kind).toBe('invalid');
  });

  it('a Telegram id already bound to another farmer leaves the token unconsumed and both profiles unchanged (21.13)', async () => {
    await seedProfile('farmer-A'); // no telegram id yet — mints a token
    await seedProfile('farmer-B', 999); // already bound to telegram 999
    const token = await seedLinkToken('farmer-A');

    // farmer-A tries to bind telegram 999, which is already on farmer-B.
    const outcome = await linking.consumeAndBind(token, 999);
    expect(outcome.kind).toBe('already_linked_elsewhere');

    // farmer-A's profile is unchanged (no telegram id), farmer-B still holds 999.
    const a = await db().collection<ProfileDoc>(COLLECTIONS.profiles).findOne({ _id: 'farmer-A' });
    const b = await db().collection<ProfileDoc>(COLLECTIONS.profiles).findOne({ _id: 'farmer-B' });
    expect(a?.telegramUserId ?? null).toBeNull();
    expect(b?.telegramUserId).toBe(999);

    // The token is LEFT UNCONSUMED — the whole transaction rolled back.
    const tokenDoc = await db().collection(COLLECTIONS.linkTokens).findOne({ tokenHash: sha256(token) });
    expect(tokenDoc?.consumedAt ?? null).toBeNull();
  });

  it('binding the same id already on the profile is already_linked; a different id replaces (21.10–21.12)', async () => {
    await seedProfile('farmer-A', 555);
    const sameToken = await seedLinkToken('farmer-A');
    const same = await linking.consumeAndBind(sameToken, 555);
    expect(same.kind).toBe('already_linked');

    // Now a fresh token binding a DIFFERENT id replaces, returning the previously-bound id.
    const replaceToken = await seedLinkToken('farmer-A');
    const replaced = await linking.consumeAndBind(replaceToken, 777);
    expect(replaced.kind).toBe('replaced');
    if (replaced.kind === 'replaced') expect(replaced.replacedTelegramUserId).toBe(555);

    const profile = await db().collection<ProfileDoc>(COLLECTIONS.profiles).findOne({ _id: 'farmer-A' });
    expect(profile?.telegramUserId).toBe(777);
  });
});

/* ========================================================================== */
/* Unlink (21.15)                                                              */
/* ========================================================================== */

describe('unlink', () => {
  it('clears the telegram id and invalidates outstanding tokens while keeping the entitlement (21.15, Property 34)', async () => {
    await seedProfile('farmer-A', 555);
    // An outstanding (unconsumed) token, and a granted entitlement.
    const outstanding = await seedLinkToken('farmer-A');
    await seedOrder('farmer-A', 'order-keep');
    await payment.processVerifiedWebhook({ kind: 'captured', paymentId: 'pay-keep', orderId: 'order-keep', amountMinor: 2000, status: 'captured', eventId: null });
    expect(await entitlement.isActive('farmer-A')).toBe(true);

    await linking.unlink('farmer-A');

    const profile = await db().collection<ProfileDoc>(COLLECTIONS.profiles).findOne({ _id: 'farmer-A' });
    expect(profile?.telegramUserId ?? null).toBeNull();

    // The outstanding token is now consumed (invalidated).
    const tokenDoc = await db().collection(COLLECTIONS.linkTokens).findOne({ tokenHash: sha256(outstanding) });
    expect(tokenDoc?.consumedAt).toBeInstanceOf(Date);

    // The entitlement survives — it is keyed to the farmer, not the telegram account (D14).
    expect(await entitlement.isActive('farmer-A')).toBe(true);
  });
});

/* ========================================================================== */
/* Payment grant-plus-extend (D14, D15, D19, A2, Property 36)                  */
/* ========================================================================== */

describe('processVerifiedWebhook (captured)', () => {
  const captured = (orderId: string, paymentId: string) =>
    ({ kind: 'captured', paymentId, orderId, amountMinor: 2000, status: 'captured', eventId: null }) as const;

  it('a captured webhook delivered five times extends the window exactly once (22.10, 22.11, Property 36)', async () => {
    await seedProfile('farmer-A');
    await seedOrder('farmer-A', 'order-1');

    const first = await payment.processVerifiedWebhook(captured('order-1', 'pay-1'));
    expect(first.kind).toBe('granted');
    const grantedExpiry = first.kind === 'granted' ? first.expiresAt.getTime() : 0;

    // Four redeliveries of the SAME payment id.
    for (let i = 0; i < 4; i += 1) {
      const again = await payment.processVerifiedWebhook(captured('order-1', 'pay-1'));
      expect(again.kind).toBe('duplicate');
    }

    // The window is unchanged after the redeliveries — extended once, not five times.
    const ent = await access.accessData('farmer-A').readEntitlement();
    expect(ent?.expiresAt.getTime()).toBe(grantedExpiry);
  });

  it('two distinct payments stack to 14 days (A2, Property 35)', async () => {
    await seedProfile('farmer-A');
    await seedOrder('farmer-A', 'order-1');
    await seedOrder('farmer-A', 'order-2');

    const now = new Date('2026-01-01T00:00:00.000Z');
    const first = await payment.processVerifiedWebhook(captured('order-1', 'pay-1'), now);
    expect(first.kind).toBe('granted');

    // The second payment lands while the first window is still open — it stacks on the expiry.
    const soon = new Date(now.getTime() + 60_000);
    const second = await payment.processVerifiedWebhook(captured('order-2', 'pay-2'), soon);
    expect(second.kind).toBe('granted');

    const ent = await access.accessData('farmer-A').readEntitlement();
    // 2 × 7 days from `now` (the first grant set now+7; the second stacked +7 onto that).
    const expected = now.getTime() + 2 * RECHARGE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    expect(ent?.expiresAt.getTime()).toBe(expected);
  });

  it('an early recharge keeps the remaining days (A2 — max(now, currentExpiry) + period)', async () => {
    await seedProfile('farmer-A');
    await seedOrder('farmer-A', 'order-1');
    await seedOrder('farmer-A', 'order-2');

    const now = new Date('2026-01-01T00:00:00.000Z');
    await payment.processVerifiedWebhook(captured('order-1', 'pay-1'), now);

    // Recharge three days early — the window must stack, not reset to now+7.
    const threeDaysLater = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    await payment.processVerifiedWebhook(captured('order-2', 'pay-2'), threeDaysLater);

    const ent = await access.accessData('farmer-A').readEntitlement();
    // First expiry now+7; second extends from that (the later of now+3 and now+7) → now+14.
    const expected = now.getTime() + 2 * RECHARGE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    expect(ent?.expiresAt.getTime()).toBe(expected);
  });

  it('a captured webhook for an order Jamee never recorded grants nothing (order_not_found)', async () => {
    await seedProfile('farmer-A');
    const outcome = await payment.processVerifiedWebhook(captured('order-missing', 'pay-x'));
    expect(outcome.kind).toBe('order_not_found');
    expect(await access.accessData('farmer-A').readEntitlement()).toBeNull();
  });
});

describe('processVerifiedWebhook (failed)', () => {
  it('marks the order failed and leaves the window untouched (22.19)', async () => {
    await seedProfile('farmer-A');
    await seedOrder('farmer-A', 'order-1');

    const outcome = await payment.processVerifiedWebhook({
      kind: 'failed',
      paymentId: 'pay-1',
      orderId: 'order-1',
      amountMinor: 2000,
      status: 'failed',
      eventId: null,
    });
    expect(outcome.kind).toBe('failed_recorded');

    const order = await db().collection(COLLECTIONS.paymentOrders).findOne({ providerOrderId: 'order-1' });
    expect(order?.status).toBe('failed');
    // No entitlement granted.
    expect(await access.accessData('farmer-A').readEntitlement()).toBeNull();
  });
});
