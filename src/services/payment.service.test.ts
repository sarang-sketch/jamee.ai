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

const { insertPaymentOrder, grantAndExtend, markPaymentOrderFailed, createOrder, MockRazorpayOrderError } = vi.hoisted(
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
      grantAndExtend: vi.fn(),
      markPaymentOrderFailed: vi.fn(),
      createOrder: vi.fn(),
      MockRazorpayOrderError,
    };
  },
);

vi.mock('@/lib/db/access', () => ({
  accessData: (ownerId: string) => ({ ownerId, insertPaymentOrder }),
  grantAndExtend,
  markPaymentOrderFailed,
}));

vi.mock('@/lib/db/farmer', () => ({ withTransaction: vi.fn() }));

vi.mock('@/lib/razorpay', () => ({
  createOrder,
  RazorpayOrderError: MockRazorpayOrderError,
}));

import { createRechargeOrder, processVerifiedWebhook } from '@/services/payment.service';
import { RECHARGE_PERIOD_DAYS } from '@/lib/config/access';
import { isAppError } from '@/lib/errors';
import type { ParsedPaymentWebhook } from '@/lib/razorpay';

beforeEach(() => {
  vi.clearAllMocks();
  insertPaymentOrder.mockResolvedValue({ _id: 'order-doc' });
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
