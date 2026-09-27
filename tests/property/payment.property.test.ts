import { createHmac } from 'node:crypto';

import * as fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { nextExpiry, RECHARGE_PERIOD_DAYS, RECHARGE_PRICE_PAISE } from '@/lib/config/access';
import { COLLECTIONS, type BotEntitlementDoc, type PaymentOrderDoc, type ProfileDoc } from '@/lib/db/collections';
import { RAZORPAY_SIGNATURE_HEADER, verifyWebhookSignature, type ParsedPaymentWebhook } from '@/lib/razorpay';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from '../integration/mongo';

/**
 * **Property 34: No entitlement without a verified signature, and one payment grants exactly once**
 *
 * > No entitlement is recorded or extended unless the signature verifies in constant time over the
 * > exact raw request body bytes against the configured payment webhook secret; a missing header, a
 * > signature that does not verify, and an absent configured secret each fail; and no browser-
 * > reported checkout success records or extends an entitlement. For any verified webhook reporting
 * > a captured payment against a recorded Payment_Order, and any number of redeliveries in any
 * > order, the payment is applied exactly once — the claim on the payment id and the extension of
 * > the window run inside one transaction (D19), the duplicate-key error on `providerPaymentId`
 * > being the duplicate signal. Afterwards exactly one Bot_Entitlement exists for that order's
 * > Auth_User_Id, carrying the payment id and an expiry set to `nextExpiry` for that payment. For a
 * > failed payment, nothing is recorded or extended.
 *
 * **Validates: Requirements 22.5, 22.6, 22.7, 22.8, 22.9, 22.10, 22.11, 22.12, 22.21**
 *
 * Also carries **the redelivery half of Property 36**: over any redelivery multiset of one distinct
 * captured payment, the window is extended exactly once (the arithmetic half — order-independence
 * and the paid-day rules — lives in `recharge.property.test.ts` against the pure `nextExpiry`).
 *
 * =============================================================================
 * A3/A2 RESTATEMENT — REAL LAYER FOR THE GRANT, PURE FOR THE SIGNATURE
 * =============================================================================
 *
 * Two halves, each stated over the substrate the brief names:
 *
 *  - **The authenticity half** is a claim about `verifyWebhookSignature` in `src/lib/razorpay.ts`:
 *    the HMAC-SHA256 over the raw body keyed with the webhook secret. It is PURE (no database), so
 *    this file drives it directly over arbitrary bodies, flipped bytes, absent headers, and an empty
 *    (unconfigured) secret. This replaces the old Meta `X-Hub-Signature-256` claim with Razorpay's
 *    `X-Razorpay-Signature`.
 *
 *  - **The idempotency/grant half** is a claim about the D19 `grantAndExtend` TRANSACTION and the
 *    partial-unique `providerPaymentId` index, which only a real replica set can establish (an
 *    in-memory Map serialises itself and would report idempotent whether or not the index is). The
 *    brief directs running Property 34 and the redelivery half of 36 "against the real layer on
 *    tests/integration/mongo.ts"; this file does, through `processVerifiedWebhook`, at
 *    numRuns ≈ 25.
 *
 * The old permanent-unlock "no expiry" clause of Property 34 is INVERTED by Amendment A2: the grant
 * now carries a window and the extension is `nextExpiry(now, currentExpiry)`, checked here against
 * the recorded `expiresAt`.
 */

let harness: MongoHarness | undefined;
type AccessDal = typeof import('@/lib/db/access');
type Payment = typeof import('@/services/payment.service');

let access: AccessDal;
let payment: Payment;
let setupDatabase: typeof import('@/lib/db/setup').setupDatabase;

const REAL_LAYER_RUNS = 25;

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  access = await import('@/lib/db/access');
  payment = await import('@/services/payment.service');
  ({ setupDatabase } = await import('@/lib/db/setup'));
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

async function seedProfile(userId: string): Promise<void> {
  const now = new Date();
  const doc: ProfileDoc = { _id: userId, email: `${userId}@example.test`, language: 'en', createdAt: now, updatedAt: now };
  await db().collection<ProfileDoc>(COLLECTIONS.profiles).insertOne(doc);
}

async function seedOrder(userId: string, providerOrderId: string): Promise<void> {
  await access.accessData(userId).insertPaymentOrder({
    providerOrderId,
    amountMinor: RECHARGE_PRICE_PAISE,
    currency: 'INR',
    status: 'created',
  });
}

async function entitlementOf(userId: string): Promise<BotEntitlementDoc | null> {
  return db().collection<BotEntitlementDoc>(COLLECTIONS.botEntitlements).findOne({ _id: userId });
}

async function entitlementCount(userId: string): Promise<number> {
  return db().collection<BotEntitlementDoc>(COLLECTIONS.botEntitlements).countDocuments({ _id: userId });
}

async function orderOf(providerOrderId: string): Promise<PaymentOrderDoc | null> {
  return db().collection<PaymentOrderDoc>(COLLECTIONS.paymentOrders).findOne({ providerOrderId });
}

function captured(paymentId: string, orderId: string): ParsedPaymentWebhook {
  return { kind: 'captured', paymentId, orderId, amountMinor: RECHARGE_PRICE_PAISE, status: 'captured', eventId: null };
}

/* ========================================================================== */
/* Property 34 — the authenticity half (pure, over verifyWebhookSignature)     */
/* ========================================================================== */

describe('Property 34 (authenticity): a signature must verify over the exact raw bytes', () => {
  const SECRET = 'property-payment-webhook-secret-not-a-real-credential';
  const sign = (raw: string): string => createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');

  it('a correct HMAC over the raw body verifies; any tamper, absent header, or empty secret fails', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.constantFrom<'valid' | 'flip' | 'truncate' | 'absent' | 'reserialize' | 'empty_secret'>(
          'valid',
          'flip',
          'truncate',
          'absent',
          'reserialize',
          'empty_secret',
        ),
        (rawBody, variant) => {
          if (variant === 'valid') {
            expect(verifyWebhookSignature(rawBody, sign(rawBody), SECRET)).toBe(true);
            return;
          }
          if (variant === 'flip') {
            const good = sign(rawBody);
            // Flip the last hex nibble.
            const last = good.at(-1) as string;
            const flipped = good.slice(0, -1) + (last === '0' ? '1' : '0');
            expect(verifyWebhookSignature(rawBody, flipped, SECRET)).toBe(false);
            return;
          }
          if (variant === 'truncate') {
            expect(verifyWebhookSignature(rawBody, sign(rawBody).slice(0, -2), SECRET)).toBe(false);
            return;
          }
          if (variant === 'absent') {
            expect(verifyWebhookSignature(rawBody, null, SECRET)).toBe(false);
            expect(verifyWebhookSignature(rawBody, undefined, SECRET)).toBe(false);
            expect(verifyWebhookSignature(rawBody, '', SECRET)).toBe(false);
            return;
          }
          if (variant === 'reserialize') {
            // A body signed as `{"a":1}` does not verify against a re-serialized `{ "a": 1 }`.
            const original = `{"a":1,"b":"${rawBody.replace(/[\\"]/g, '')}"}`;
            const reserialized = JSON.stringify(JSON.parse(original));
            const sig = sign(original);
            // Only assert the divergence case where re-serialization actually changed the bytes.
            if (reserialized !== original) {
              expect(verifyWebhookSignature(reserialized, sig, SECRET)).toBe(false);
            }
            return;
          }
          // empty_secret: an unconfigured secret is a failed verification, never a skip.
          expect(verifyWebhookSignature(rawBody, sign(rawBody), '')).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('the header name is the Razorpay one (A3 substrate, not the retired Meta header)', () => {
    expect(RAZORPAY_SIGNATURE_HEADER.toLowerCase()).toContain('razorpay');
  });
});

/* ========================================================================== */
/* Property 34 + 36-redelivery — the grant half (real layer)                   */
/* ========================================================================== */

describe('Property 34/36 (grant): one payment extends the window exactly once across redeliveries', () => {
  it('any number of redeliveries of one captured payment leave exactly one entitlement, extended once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }), // redelivery count
        async (deliveries) => {
          await clearDatabase(db());
          const userId = 'payer-1';
          const orderId = `order-${Math.random().toString(36).slice(2)}`;
          const paymentId = `pay-${Math.random().toString(36).slice(2)}`;
          await seedProfile(userId);
          await seedOrder(userId, orderId);

          const now = new Date('2026-06-01T00:00:00.000Z');
          const expectedExpiry = nextExpiry(now, null);

          // Fire the same captured payment `deliveries` times, concurrently — the real race.
          const results = await Promise.all(
            Array.from({ length: deliveries }, () =>
              payment.processVerifiedWebhook(captured(paymentId, orderId), now),
            ),
          );

          // Exactly one delivery granted; the rest are duplicates.
          const granted = results.filter((r) => r.kind === 'granted');
          const dup = results.filter((r) => r.kind === 'duplicate');
          expect(granted.length, 'exactly one grant').toBe(1);
          expect(dup.length).toBe(deliveries - 1);

          // Exactly one entitlement document, carrying this payment id and the single-window expiry.
          expect(await entitlementCount(userId)).toBe(1);
          const ent = await entitlementOf(userId);
          expect(ent?.providerPaymentId).toBe(paymentId);
          expect(ent?.expiresAt?.getTime()).toBe(expectedExpiry.getTime());

          // The order was captured and stamped with the payment id exactly once.
          const order = await orderOf(orderId);
          expect(order?.status).toBe('captured');
          expect(order?.providerPaymentId).toBe(paymentId);
        },
      ),
      { numRuns: REAL_LAYER_RUNS },
    );
  });

  it('distinct payments each extend once; the window is nextExpiry applied per distinct payment', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async (paymentCount) => {
        await clearDatabase(db());
        const userId = 'payer-2';
        await seedProfile(userId);

        const now = new Date('2026-06-01T00:00:00.000Z');
        let expectedExpiry: Date | null = null;

        for (let i = 0; i < paymentCount; i += 1) {
          const orderId = `order-${i}-${Math.random().toString(36).slice(2)}`;
          const paymentId = `pay-${i}-${Math.random().toString(36).slice(2)}`;
          await seedOrder(userId, orderId);
          // Apply, then redeliver once — the redelivery must not double-extend.
          await payment.processVerifiedWebhook(captured(paymentId, orderId), now);
          await payment.processVerifiedWebhook(captured(paymentId, orderId), now);
          expectedExpiry = nextExpiry(now, expectedExpiry);
        }

        // At most one entitlement doc for the farmer, expiry = nextExpiry applied once per distinct payment.
        expect(await entitlementCount(userId)).toBe(1);
        const ent = await entitlementOf(userId);
        expect(ent?.expiresAt?.getTime()).toBe(expectedExpiry?.getTime());
        // All applied at the same `now`, so the window is now + paymentCount * 7 days.
        expect(ent?.expiresAt?.getTime()).toBe(now.getTime() + paymentCount * RECHARGE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
      }),
      { numRuns: REAL_LAYER_RUNS },
    );
  });

  it('a captured webhook for an unrecorded order grants nothing', async () => {
    await clearDatabase(db());
    const result = await payment.processVerifiedWebhook(captured('pay-x', 'order-never-recorded'), new Date());
    expect(result.kind).toBe('order_not_found');
    expect(await db().collection(COLLECTIONS.botEntitlements).countDocuments({})).toBe(0);
  });

  it('a failed payment records nothing and leaves the entitlement untouched', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (hadPriorWindow) => {
        await clearDatabase(db());
        const userId = 'payer-3';
        const orderId = `order-failed-${Math.random().toString(36).slice(2)}`;
        await seedProfile(userId);
        await seedOrder(userId, orderId);

        let priorExpiry: number | null = null;
        if (hadPriorWindow) {
          const now = new Date('2026-06-01T00:00:00.000Z');
          const firstOrder = `order-ok-${Math.random().toString(36).slice(2)}`;
          await seedOrder(userId, firstOrder);
          await payment.processVerifiedWebhook(captured(`pay-ok-${Math.random()}`, firstOrder), now);
          priorExpiry = (await entitlementOf(userId))?.expiresAt?.getTime() ?? null;
        }

        const failed: ParsedPaymentWebhook = {
          kind: 'failed',
          paymentId: 'pay-fail',
          orderId,
          amountMinor: RECHARGE_PRICE_PAISE,
          status: 'failed',
          eventId: null,
        };
        const result = await payment.processVerifiedWebhook(failed, new Date());
        expect(result.kind).toBe('failed_recorded');

        // The failed order is marked failed; the entitlement window is exactly as it was.
        expect((await orderOf(orderId))?.status).toBe('failed');
        const ent = await entitlementOf(userId);
        expect(ent?.expiresAt?.getTime() ?? null).toBe(priorExpiry);
      }),
      { numRuns: REAL_LAYER_RUNS },
    );
  });

  it('the grant derives the paying farmer from the recorded order, never the payload', async () => {
    // Two farmers; a webhook naming farmer-A's order grants to farmer-A even though the payload
    // carries only the order id — who paid comes from the recorded order (D15).
    await clearDatabase(db());
    await seedProfile('farmer-A');
    await seedProfile('farmer-B');
    const orderA = 'order-A';
    await seedOrder('farmer-A', orderA);

    const now = new Date('2026-06-01T00:00:00.000Z');
    const result = await payment.processVerifiedWebhook(captured('pay-A', orderA), now);
    expect(result.kind).toBe('granted');
    if (result.kind === 'granted') expect(result.ownerId).toBe('farmer-A');

    expect(await entitlementCount('farmer-A')).toBe(1);
    expect(await entitlementCount('farmer-B')).toBe(0);
  });
});
