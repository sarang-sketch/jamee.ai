import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { COLLECTIONS, type ProfileDoc } from '@/lib/db/collections';
import { RECHARGE_PRICE_PAISE, RECHARGE_PERIOD_DAYS } from '@/lib/config/access';
import { setupDatabase } from '@/lib/db/setup';
import type { OrderPayment } from '@/lib/razorpay';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from './mongo';

/**
 * Integration tests for the webhook-free payment confirmation (`confirmOrder`) against a single-node
 * `MongoMemoryReplSet` (V31, V33), with Razorpay's Orders-payments call MOCKED at the adapter seam —
 * tests never touch a real provider.
 *
 * Requirements: 22.7 (the server confirms with the provider; the browser is not trusted), 22.10,
 *               22.11 (the grant is idempotent — a confirm AND a webhook for one payment extend the
 *               window exactly once, Property 36), 22.19 (an all-failed order is marked failed),
 *               13.1, 13.2 (owner-scoping — a confirm on another farmer's order changes nothing)
 * Design: D14, D15, D19, D20; Amendment A2
 *
 * `MONGODB_URI` points at the in-memory replica set BEFORE any Data_Access_Layer / service module
 * runs, and those modules are imported dynamically AFTER, so the cached client connects to the
 * harness rather than to a real Atlas cluster. `@/lib/razorpay` is `vi.mock`-ed so `fetchOrderPayments`
 * returns a scripted answer while the grant-plus-extend transaction and its unique `providerPaymentId`
 * index are the REAL ones — which is the only way to prove "exactly once".
 */

const rz = vi.hoisted(() => ({ fetchOrderPayments: vi.fn<() => Promise<OrderPayment[]>>() }));

vi.mock('@/lib/razorpay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/razorpay')>();
  return { ...actual, fetchOrderPayments: rz.fetchOrderPayments };
});

let harness: MongoHarness | undefined;
type AccessDal = typeof import('@/lib/db/access');
type Payment = typeof import('@/services/payment.service');
type Entitlement = typeof import('@/services/entitlement.service');

let access: AccessDal;
let payment: Payment;
let entitlement: Entitlement;

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  access = await import('@/lib/db/access');
  payment = await import('@/services/payment.service');
  entitlement = await import('@/services/entitlement.service');
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  if (harness) await clearDatabase(harness.db);
  rz.fetchOrderPayments.mockReset();
});

function db() {
  if (harness === undefined) throw new Error('harness not started');
  return harness.db;
}

async function seedProfile(userId: string): Promise<void> {
  const now = new Date();
  const doc: ProfileDoc = {
    _id: userId,
    email: `${userId}@example.test`,
    language: 'en',
    createdAt: now,
    updatedAt: now,
  };
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

const capturedPayment = (orderId: string, paymentId: string): OrderPayment => ({
  id: paymentId,
  orderId,
  amountMinor: RECHARGE_PRICE_PAISE,
  currency: 'INR',
  status: 'captured',
  captured: true,
});

/* ========================================================================== */
/* A captured confirm grants and extends                                       */
/* ========================================================================== */

describe('confirmOrder — captured', () => {
  it('grants and extends the window from a captured payment (22.7)', async () => {
    await seedProfile('farmer-A');
    await seedOrder('farmer-A', 'order-1');
    rz.fetchOrderPayments.mockResolvedValue([capturedPayment('order-1', 'pay-1')]);

    const now = new Date('2026-01-01T00:00:00.000Z');
    const { result, entitlement: window_ } = await payment.confirmOrder('farmer-A', 'order-1', now);

    expect(result.kind).toBe('granted');
    expect(window_.isActive).toBe(true);

    const ent = await access.accessData('farmer-A').readEntitlement();
    expect(ent?.expiresAt.getTime()).toBe(now.getTime() + RECHARGE_PERIOD_DAYS * 86_400_000);
  });

  it('a confirm and a webhook for ONE payment extend the window exactly once (Property 36, 22.10, 22.11)', async () => {
    await seedProfile('farmer-A');
    await seedOrder('farmer-A', 'order-1');
    rz.fetchOrderPayments.mockResolvedValue([capturedPayment('order-1', 'pay-1')]);

    const now = new Date('2026-01-01T00:00:00.000Z');

    // The confirm grants first.
    const confirm = await payment.confirmOrder('farmer-A', 'order-1', now);
    expect(confirm.result.kind).toBe('granted');
    const afterConfirm = (await access.accessData('farmer-A').readEntitlement())?.expiresAt.getTime();

    // The webhook for the SAME payment id then arrives — it must be a duplicate, not a second extend.
    const webhook = await payment.processVerifiedWebhook(
      { kind: 'captured', paymentId: 'pay-1', orderId: 'order-1', amountMinor: RECHARGE_PRICE_PAISE, status: 'captured', eventId: null },
      new Date(now.getTime() + 60_000),
    );
    expect(webhook.kind).toBe('duplicate');

    const afterWebhook = (await access.accessData('farmer-A').readEntitlement())?.expiresAt.getTime();
    expect(afterWebhook).toBe(afterConfirm);
    // The window is exactly one period from `now`, not two.
    expect(afterWebhook).toBe(now.getTime() + RECHARGE_PERIOD_DAYS * 86_400_000);
  });

  it('a webhook first, then a confirm, also extends exactly once (order-independent)', async () => {
    await seedProfile('farmer-A');
    await seedOrder('farmer-A', 'order-1');
    rz.fetchOrderPayments.mockResolvedValue([capturedPayment('order-1', 'pay-1')]);

    const now = new Date('2026-02-01T00:00:00.000Z');
    const webhook = await payment.processVerifiedWebhook(
      { kind: 'captured', paymentId: 'pay-1', orderId: 'order-1', amountMinor: RECHARGE_PRICE_PAISE, status: 'captured', eventId: null },
      now,
    );
    expect(webhook.kind).toBe('granted');
    const afterWebhook = (await access.accessData('farmer-A').readEntitlement())?.expiresAt.getTime();

    // The confirm sees the same payment already granted — a duplicate — and maps it to granted for
    // the browser, without extending again.
    const confirm = await payment.confirmOrder('farmer-A', 'order-1', new Date(now.getTime() + 60_000));
    expect(confirm.result.kind).toBe('granted');

    const afterConfirm = (await access.accessData('farmer-A').readEntitlement())?.expiresAt.getTime();
    expect(afterConfirm).toBe(afterWebhook);
  });
});

/* ========================================================================== */
/* pending / failed / another farmer's order                                    */
/* ========================================================================== */

describe('confirmOrder — non-granting outcomes', () => {
  it('reports pending for an authorized-but-not-captured payment and grants nothing', async () => {
    await seedProfile('farmer-A');
    await seedOrder('farmer-A', 'order-1');
    rz.fetchOrderPayments.mockResolvedValue([
      { id: 'pay-1', orderId: 'order-1', amountMinor: RECHARGE_PRICE_PAISE, currency: 'INR', status: 'authorized', captured: false },
    ]);

    const { result } = await payment.confirmOrder('farmer-A', 'order-1');
    expect(result.kind).toBe('pending');
    expect(await access.accessData('farmer-A').readEntitlement()).toBeNull();
  });

  it('reports pending for a captured payment at the WRONG amount and grants nothing (22.7)', async () => {
    await seedProfile('farmer-A');
    await seedOrder('farmer-A', 'order-1');
    rz.fetchOrderPayments.mockResolvedValue([
      { id: 'pay-1', orderId: 'order-1', amountMinor: RECHARGE_PRICE_PAISE - 1, currency: 'INR', status: 'captured', captured: true },
    ]);

    const { result } = await payment.confirmOrder('farmer-A', 'order-1');
    expect(result.kind).toBe('pending');
    expect(await access.accessData('farmer-A').readEntitlement()).toBeNull();
  });

  it('marks the order failed when every payment has failed (22.19)', async () => {
    await seedProfile('farmer-A');
    await seedOrder('farmer-A', 'order-1');
    rz.fetchOrderPayments.mockResolvedValue([
      { id: 'pay-1', orderId: 'order-1', amountMinor: RECHARGE_PRICE_PAISE, currency: 'INR', status: 'failed', captured: false },
    ]);

    const { result } = await payment.confirmOrder('farmer-A', 'order-1');
    expect(result.kind).toBe('failed');

    const order = await db().collection(COLLECTIONS.paymentOrders).findOne({ providerOrderId: 'order-1' });
    expect(order?.status).toBe('failed');
    expect(await access.accessData('farmer-A').readEntitlement()).toBeNull();
  });

  it('an order with no payments yet is pending, not failed', async () => {
    await seedProfile('farmer-A');
    await seedOrder('farmer-A', 'order-1');
    rz.fetchOrderPayments.mockResolvedValue([]);

    const { result } = await payment.confirmOrder('farmer-A', 'order-1');
    expect(result.kind).toBe('pending');

    const order = await db().collection(COLLECTIONS.paymentOrders).findOne({ providerOrderId: 'order-1' });
    expect(order?.status).toBe('created');
  });

  it("another farmer's order id reads as not_found and never calls Razorpay or grants (13.2, D15)", async () => {
    await seedProfile('farmer-A');
    await seedProfile('farmer-B');
    await seedOrder('farmer-A', 'order-1'); // owned by A

    // farmer-B tries to confirm A's order.
    const { result } = await payment.confirmOrder('farmer-B', 'order-1');
    expect(result.kind).toBe('not_found');
    // The provider is never asked — the owner-scoped read short-circuits before the fetch.
    expect(rz.fetchOrderPayments).not.toHaveBeenCalled();

    // Neither farmer got an entitlement.
    expect(await access.accessData('farmer-A').readEntitlement()).toBeNull();
    expect(await access.accessData('farmer-B').readEntitlement()).toBeNull();
  });

  it('a captured payment whose order_id does not match the order is not the grant (defence)', async () => {
    await seedProfile('farmer-A');
    await seedOrder('farmer-A', 'order-1');
    // A payment carrying a different order_id must not grant against order-1.
    rz.fetchOrderPayments.mockResolvedValue([capturedPayment('order-OTHER', 'pay-x')]);

    const { result } = await payment.confirmOrder('farmer-A', 'order-1');
    expect(result.kind).toBe('pending');
    expect(await access.accessData('farmer-A').readEntitlement()).toBeNull();
  });
});

describe('confirmOrder + entitlement status parity', () => {
  it('the returned window equals the entitlement service’s own read', async () => {
    await seedProfile('farmer-A');
    await seedOrder('farmer-A', 'order-1');
    rz.fetchOrderPayments.mockResolvedValue([capturedPayment('order-1', 'pay-1')]);

    const now = new Date('2026-03-01T00:00:00.000Z');
    const { entitlement: fromConfirm } = await payment.confirmOrder('farmer-A', 'order-1', now);
    const fromService = await entitlement.entitlementStatus('farmer-A', now);
    expect(fromConfirm).toEqual(fromService);
  });
});
