import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `src/services/payment.service.ts` with the Data_Access_Layer and the Razorpay
 * order call mocked.
 *
 * Requirements: 22.1, 22.2 (the order is created at Jamee's server-side price; the caller supplies
 *               no amount), 22.7–22.12 (a captured webhook grants once; a duplicate/unmatched order
 *               grants nothing), 22.19 (a failed payment records the order failed and nothing else)
 * Design: D14, D15; Amendment A2
 *
 * What these decide. The SERVICE facts: the order record is written with the created status and the
 * provider's returned identifiers, only the four checkout fields are returned, a `RazorpayOrderError`
 * becomes `PAYMENT_ORDER_FAILED` (carrying no provider text), and a verified webhook is routed by
 * kind — captured → grant-and-extend deriving the expiry from `nextExpiry`, failed → mark-failed.
 * The atomicity and the exactly-once extension are facts about the transaction and the unique index,
 * proven in `tests/integration/access-flow.test.ts`.
 */

const { insertPaymentOrder, findPaymentOrders, grantAndExtend, markPaymentOrderFailed, createOrder, fetchOrderPayments, entitlementStatus, MockRazorpayOrderError } = vi.hoisted(
  () => {
    class MockRazorpayOrderError extends Error {
      readonly status: number | undefined;
      constructor(message: string, options: { status?: number } = {}) {
        super(message);
        this.name = 'RazorpayOrderError';
        this.status = options.status;
      }
    }
    return {
      insertPaymentOrder: vi.fn(),
      findPaymentOrders: vi.fn(),
      grantAndExtend: vi.fn(),
      markPaymentOrderFailed: vi.fn(),
      createOrder: vi.fn(),
      fetchOrderPayments: vi.fn(),
      entitlementStatus: vi.fn(),
      MockRazorpayOrderError,
    };
  },
);

vi.mock('@/lib/db/access', () => ({
  accessData: (ownerId: string) => ({ ownerId, insertPaymentOrder, findPaymentOrders }),
  grantAndExtend,
  markPaymentOrderFailed,
}));

vi.mock('@/lib/db/farmer', () => ({ withTransaction: vi.fn() }));

vi.mock('@/lib/razorpay', () => ({
  createOrder,
  fetchOrderPayments,
  RazorpayOrderError: MockRazorpayOrderError,
}));

vi.mock('@/services/entitlement.service', () => ({ entitlementStatus }));

import { createRechargeOrder, processVerifiedWebhook, confirmOrder } from '@/services/payment.service';
import { RECHARGE_PERIOD_DAYS, RECHARGE_PRICE_PAISE } from '@/lib/config/access';
import { isAppError } from '@/lib/errors';
import type { ParsedPaymentWebhook } from '@/lib/razorpay';

beforeEach(() => {
  vi.clearAllMocks();
  insertPaymentOrder.mockResolvedValue({ _id: 'order-doc' });
  entitlementStatus.mockResolvedValue({ expiresAt: null, isActive: false });
});

/* ========================================================================== */
/* createRechargeOrder                                                         */
/* ========================================================================== */

describe('createRechargeOrder', () => {
  it('records a created order and returns only the four checkout identifiers (22.2)', async () => {
    createOrder.mockResolvedValue({ orderId: 'ord_1', keyId: 'rzp_test_key', amountMinor: 2000, currency: 'INR' });

    const result = await createRechargeOrder('farmer-A');

    // The recorded order carries the provider ids and the created status.
    expect(insertPaymentOrder).toHaveBeenCalledTimes(1);
    const recorded = insertPaymentOrder.mock.calls[0]![0];
    expect(recorded).toMatchObject({ providerOrderId: 'ord_1', amountMinor: 2000, currency: 'INR', status: 'created' });

    // Only the four checkout fields are returned — no key secret, no owner, no recorded doc.
    expect(result).toEqual({ orderId: 'ord_1', keyId: 'rzp_test_key', amountMinor: 2000, currency: 'INR' });
  });

  it('never reads an amount from a caller — createOrder is called with no amount parameter (22.2)', async () => {
    createOrder.mockResolvedValue({ orderId: 'ord_1', keyId: 'k', amountMinor: 2000, currency: 'INR' });
    await createRechargeOrder('farmer-A');
    const arg = createOrder.mock.calls[0]?.[0] ?? {};
    expect(arg).not.toHaveProperty('amount');
    expect(arg).not.toHaveProperty('amountMinor');
  });

  it('maps a RazorpayOrderError to PAYMENT_ORDER_FAILED and records no order', async () => {
    createOrder.mockRejectedValue(new MockRazorpayOrderError('provider said no', { status: 502 }));

    await expect(createRechargeOrder('farmer-A')).rejects.toSatisfy((error: unknown) => {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe('PAYMENT_ORDER_FAILED');
        // The provider's own text never becomes the AppError's message.
        expect(error.message).not.toContain('provider said no');
      }
      return true;
    });
    expect(insertPaymentOrder).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* processVerifiedWebhook                                                      */
/* ========================================================================== */

describe('processVerifiedWebhook', () => {
  const captured: ParsedPaymentWebhook = {
    kind: 'captured',
    paymentId: 'pay_1',
    orderId: 'ord_1',
    amountMinor: 2000,
    status: 'captured',
    eventId: 'evt_1',
  };
  const failed: ParsedPaymentWebhook = { ...captured, kind: 'failed', status: 'failed' };

  it('routes a captured event to grantAndExtend with a nextExpiry computer, keyed on payment+order id (D15)', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    grantAndExtend.mockResolvedValue({ kind: 'granted', ownerId: 'farmer-A', expiresAt: new Date() });

    const result = await processVerifiedWebhook(captured, now);
    expect(result.kind).toBe('granted');

    expect(grantAndExtend).toHaveBeenCalledTimes(1);
    const [paymentId, orderId, computeExpiry] = grantAndExtend.mock.calls[0]!;
    expect(paymentId).toBe('pay_1');
    expect(orderId).toBe('ord_1');

    // The passed computer is nextExpiry(now, currentExpiry): from null it is now + period.
    const fromNull = (computeExpiry as (e: Date | null) => Date)(null);
    expect(fromNull.getTime()).toBe(now.getTime() + RECHARGE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    // From a future expiry it stacks on that expiry, not on now.
    const future = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const fromFuture = (computeExpiry as (e: Date | null) => Date)(future);
    expect(fromFuture.getTime()).toBe(future.getTime() + RECHARGE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  });

  it('passes a duplicate/order_not_found grant result straight through', async () => {
    grantAndExtend.mockResolvedValueOnce({ kind: 'duplicate' });
    expect((await processVerifiedWebhook(captured)).kind).toBe('duplicate');

    grantAndExtend.mockResolvedValueOnce({ kind: 'order_not_found' });
    expect((await processVerifiedWebhook(captured)).kind).toBe('order_not_found');
  });

  it('routes a failed event to markPaymentOrderFailed and never grants (22.19)', async () => {
    markPaymentOrderFailed.mockResolvedValue(true);
    const result = await processVerifiedWebhook(failed);
    expect(result.kind).toBe('failed_recorded');
    expect(markPaymentOrderFailed).toHaveBeenCalledWith('ord_1', expect.any(Date));
    expect(grantAndExtend).not.toHaveBeenCalled();
  });

  it('a failed event for an unmatched order is ignored, still without granting', async () => {
    markPaymentOrderFailed.mockResolvedValue(false);
    const result = await processVerifiedWebhook(failed);
    expect(result.kind).toBe('ignored');
    expect(grantAndExtend).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* confirmOrder (22.7, D20)                                                    */
/* ========================================================================== */

describe('confirmOrder', () => {
  const ownedOrder = { _id: 'order-doc', ownerId: 'farmer-A', providerOrderId: 'ord_1', amountMinor: RECHARGE_PRICE_PAISE, currency: 'INR', status: 'created' };

  const payment = (status: string, overrides: Record<string, unknown> = {}) => ({
    id: 'pay_1',
    orderId: 'ord_1',
    amountMinor: RECHARGE_PRICE_PAISE,
    currency: 'INR',
    status,
    captured: status === 'captured',
    ...overrides,
  });

  it('grants from a captured payment at the right amount, keyed on the payment id (22.7, D15)', async () => {
    findPaymentOrders.mockResolvedValue([ownedOrder]);
    fetchOrderPayments.mockResolvedValue([payment('captured')]);
    grantAndExtend.mockResolvedValue({ kind: 'granted', ownerId: 'farmer-A', expiresAt: new Date() });
    entitlementStatus.mockResolvedValue({ expiresAt: '2026-01-08T00:00:00.000Z', isActive: true });

    const { result } = await confirmOrder('farmer-A', 'ord_1', new Date('2026-01-01T00:00:00.000Z'));

    expect(result.kind).toBe('granted');
    // The grant is keyed on the provider PAYMENT id and the order id (the webhook's key), so a
    // confirm and a webhook for one payment collapse to one extension.
    const [paymentId, orderId] = grantAndExtend.mock.calls[0]!;
    expect(paymentId).toBe('pay_1');
    expect(orderId).toBe('ord_1');
  });

  it('a captured payment already granted (duplicate) still reports granted to the browser', async () => {
    findPaymentOrders.mockResolvedValue([ownedOrder]);
    fetchOrderPayments.mockResolvedValue([payment('captured')]);
    grantAndExtend.mockResolvedValue({ kind: 'duplicate' });

    const { result } = await confirmOrder('farmer-A', 'ord_1');
    expect(result.kind).toBe('granted');
  });

  it('an authorized-but-not-captured payment is pending and grants nothing', async () => {
    findPaymentOrders.mockResolvedValue([ownedOrder]);
    fetchOrderPayments.mockResolvedValue([payment('authorized')]);

    const { result } = await confirmOrder('farmer-A', 'ord_1');
    expect(result.kind).toBe('pending');
    expect(grantAndExtend).not.toHaveBeenCalled();
    expect(markPaymentOrderFailed).not.toHaveBeenCalled();
  });

  it('a captured payment at the WRONG amount is pending and grants nothing (22.7)', async () => {
    findPaymentOrders.mockResolvedValue([ownedOrder]);
    fetchOrderPayments.mockResolvedValue([payment('captured', { amountMinor: RECHARGE_PRICE_PAISE - 1 })]);

    const { result } = await confirmOrder('farmer-A', 'ord_1');
    expect(result.kind).toBe('pending');
    expect(grantAndExtend).not.toHaveBeenCalled();
  });

  it('marks the order failed when every payment failed (22.19)', async () => {
    findPaymentOrders.mockResolvedValue([ownedOrder]);
    fetchOrderPayments.mockResolvedValue([payment('failed'), payment('failed', { id: 'pay_2' })]);
    markPaymentOrderFailed.mockResolvedValue(true);

    const { result } = await confirmOrder('farmer-A', 'ord_1');
    expect(result.kind).toBe('failed');
    expect(markPaymentOrderFailed).toHaveBeenCalledWith('ord_1', expect.any(Date));
    expect(grantAndExtend).not.toHaveBeenCalled();
  });

  it("another farmer's order reads as not_found and never calls Razorpay or grants (13.2, D15)", async () => {
    findPaymentOrders.mockResolvedValue([]); // owner-scoped read finds nothing

    const { result } = await confirmOrder('farmer-B', 'ord_1');
    expect(result.kind).toBe('not_found');
    expect(fetchOrderPayments).not.toHaveBeenCalled();
    expect(grantAndExtend).not.toHaveBeenCalled();
  });

  it('a captured payment whose order_id does not match is not the grant (defence)', async () => {
    findPaymentOrders.mockResolvedValue([ownedOrder]);
    fetchOrderPayments.mockResolvedValue([payment('captured', { orderId: 'ord_OTHER' })]);

    const { result } = await confirmOrder('farmer-A', 'ord_1');
    expect(result.kind).toBe('pending');
    expect(grantAndExtend).not.toHaveBeenCalled();
  });

  it('passes a nextExpiry computer to grantAndExtend (stacks from the current window)', async () => {
    findPaymentOrders.mockResolvedValue([ownedOrder]);
    fetchOrderPayments.mockResolvedValue([payment('captured')]);
    grantAndExtend.mockResolvedValue({ kind: 'granted', ownerId: 'farmer-A', expiresAt: new Date() });

    const now = new Date('2026-01-01T00:00:00.000Z');
    await confirmOrder('farmer-A', 'ord_1', now);

    const computeExpiry = grantAndExtend.mock.calls[0]![2] as (e: Date | null) => Date;
    expect(computeExpiry(null).getTime()).toBe(now.getTime() + RECHARGE_PERIOD_DAYS * 86_400_000);
    const future = new Date(now.getTime() + 3 * 86_400_000);
    expect(computeExpiry(future).getTime()).toBe(future.getTime() + RECHARGE_PERIOD_DAYS * 86_400_000);
  });

  it('maps a RazorpayOrderError from the payments fetch to PAYMENT_ORDER_FAILED (no provider text)', async () => {
    findPaymentOrders.mockResolvedValue([ownedOrder]);
    fetchOrderPayments.mockRejectedValue(new MockRazorpayOrderError('provider said no', { status: 502 }));

    await expect(confirmOrder('farmer-A', 'ord_1')).rejects.toSatisfy((error: unknown) => {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe('PAYMENT_ORDER_FAILED');
        expect(error.message).not.toContain('provider said no');
      }
      return true;
    });
    expect(grantAndExtend).not.toHaveBeenCalled();
  });

  it('an order with no payments yet is pending, not failed', async () => {
    findPaymentOrders.mockResolvedValue([ownedOrder]);
    fetchOrderPayments.mockResolvedValue([]);

    const { result } = await confirmOrder('farmer-A', 'ord_1');
    expect(result.kind).toBe('pending');
    expect(markPaymentOrderFailed).not.toHaveBeenCalled();
  });

  it('returns the entitlement window the entitlement service reports', async () => {
    findPaymentOrders.mockResolvedValue([ownedOrder]);
    fetchOrderPayments.mockResolvedValue([payment('captured')]);
    grantAndExtend.mockResolvedValue({ kind: 'granted', ownerId: 'farmer-A', expiresAt: new Date() });
    entitlementStatus.mockResolvedValue({ expiresAt: '2026-01-08T00:00:00.000Z', isActive: true });

    const { entitlement } = await confirmOrder('farmer-A', 'ord_1');
    expect(entitlement).toEqual({ expiresAt: '2026-01-08T00:00:00.000Z', isActive: true });
  });
});
