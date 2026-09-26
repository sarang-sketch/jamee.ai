import 'server-only';

import { nextExpiry, RECHARGE_PRICE_PAISE } from '@/lib/config/access';
import { accessData, grantAndExtend, markPaymentOrderFailed } from '@/lib/db/access';
import { withTransaction } from '@/lib/db/farmer';
import { AppError } from '@/lib/errors';
import {
  createOrder,
  fetchOrderPayments,
  RazorpayOrderError,
  type ParsedPaymentWebhook,
} from '@/lib/razorpay';
import type { EntitlementStatus, PaymentOrderResponse } from '@/lib/access-schemas';
import { entitlementStatus } from '@/services/entitlement.service';

/**
 * The payment service — the order half and the webhook grant half of the weekly recharge.
 *
 * Requirements: 22.1 (create an order at Jamee's price), 22.2 (amount, currency, and paying farmer
 *               are server-side; none is read from the request body), 22.3, 22.22 (a farmer can
 *               always start another order), 22.7–22.12 (the grant is derived from the verified
 *               payload plus the recorded order, is idempotent, and extends the window exactly
 *               once), 22.19 (a failed payment changes nothing)
 * Design: D14 (the entitlement window), D15 (who paid comes from the recorded order, never the
 *         payload), D19 (the grant-plus-extend is one transaction); Amendment A2 (the ₹20 / 7-day
 *         recharge, `nextExpiry` = `max(now, currentExpiry) + 7 days`)
 *
 * The pure Razorpay half — order creation, signature verification, payload parsing — lives in
 * `src/lib/razorpay.ts`. This service is the stateful half: it records the order, and on a VERIFIED
 * webhook it claims the payment and extends the window. It never verifies a signature itself (the
 * route does that over the raw body before calling in) and never renders provider error text.
 */

/* ========================================================================== */
/* The order half (22.1, 22.2)                                                 */
/* ========================================================================== */

/**
 * Create a Razorpay order for `ownerId` and record a `payment_orders` document.
 *
 * The amount is `RECHARGE_PRICE_PAISE` from `src/lib/config/access.ts` and the currency is
 * `RECHARGE_CURRENCY` — both server-side constants, never the caller's (22.2), so a tampered body
 * cannot buy a recharge at another price. `createOrder` has no amount parameter for exactly that
 * reason. The recorded order is `created`; only the four checkout identifiers are returned (22.2).
 *
 * A farmer whose window has lapsed, or who holds orders in any non-`captured` state, can always
 * start another — nothing here reads a previous order, so none is an obstacle (22.22, A2 decision 5
 * supersedes the one-time 22.18).
 *
 * A provider failure raises `PAYMENT_ORDER_FAILED`, whose message never carries Razorpay's error
 * text (D15) — the route maps the `RazorpayOrderError` here so the boundary stays in one place.
 */
export async function createRechargeOrder(ownerId: string): Promise<PaymentOrderResponse> {
  let order;
  try {
    order = await createOrder({ receipt: `jamee-${ownerId}-${Date.now()}` });
  } catch (error) {
    if (error instanceof RazorpayOrderError) {
      throw new AppError('PAYMENT_ORDER_FAILED', {
        cause: error,
        context: { reason: 'razorpay_order_creation_failed', ownerId, status: error.status },
      });
    }
    throw error;
  }

  await accessData(ownerId).insertPaymentOrder({
    providerOrderId: order.orderId,
    amountMinor: order.amountMinor,
    currency: order.currency,
    status: 'created',
  });

  return {
    orderId: order.orderId,
    keyId: order.keyId,
    amountMinor: order.amountMinor,
    currency: order.currency,
  };
}

/* ========================================================================== */
/* The webhook grant half (22.7–22.12, 22.19, A2)                              */
/* ========================================================================== */

/** What processing a verified webhook did, for the route's log and its 200 response. */
export type WebhookProcessResult =
  | { readonly kind: 'granted'; readonly ownerId: string; readonly expiresAt: Date }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'order_not_found' }
  | { readonly kind: 'failed_recorded' }
  | { readonly kind: 'ignored' };

/**
 * Apply a VERIFIED webhook payload. The route MUST have verified the raw-body signature first
 * (22.5); this function only interprets a payload already trusted, and derives the paying farmer,
 * the amount, and the outcome from the payload's order id plus the recorded order — never from the
 * payload's own account fields (D15).
 *
 *  - `captured` → claim the payment id and extend the window to `nextExpiry(now, currentExpiry)` in
 *    ONE transaction (D19, A2). A redelivery of the same payment id is a no-op — the window extends
 *    exactly once no matter how many times the webhook arrives (22.10, 22.11, Property 36). A
 *    captured webhook whose order Jamee never recorded returns `order_not_found` and grants nothing.
 *  - `failed` → mark the order failed and leave the window untouched (22.19).
 *
 * The route answers 200 to every verified delivery, including duplicates — the return value is for
 * logging and for the recharge confirmation, not for the HTTP status.
 */
export async function processVerifiedWebhook(
  webhook: ParsedPaymentWebhook,
  now: Date = new Date(),
): Promise<WebhookProcessResult> {
  if (webhook.kind === 'failed') {
    const matched = await markPaymentOrderFailed(webhook.orderId, now);
    return matched ? { kind: 'failed_recorded' } : { kind: 'ignored' };
  }

  // captured — grant and extend, deriving the farmer from the recorded order (D15).
  const result = await grantAndExtend(
    webhook.paymentId,
    webhook.orderId,
    (currentExpiry) => nextExpiry(now, currentExpiry),
    withTransaction,
    now,
  );

  switch (result.kind) {
    case 'granted':
      return { kind: 'granted', ownerId: result.ownerId, expiresAt: result.expiresAt };
    case 'duplicate':
      return { kind: 'duplicate' };
    case 'order_not_found':
      return { kind: 'order_not_found' };
  }
}

/* ========================================================================== */
/* The webhook-free confirmation half (22.7, D20)                              */
/* ========================================================================== */

/**
 * What confirming an order did, for the route's log — the entitlement window is returned separately
 * so the route answers the browser with the same shape `/api/profile/access` does.
 *
 *  - `granted`  — a captured payment for this order was found and the window was extended (or a
 *    concurrent webhook had already extended it; a duplicate is a success from the caller's view).
 *  - `failed`   — every payment against the order has failed; the order is marked failed.
 *  - `pending`  — the order has payments that are not yet captured and not all failed, or no
 *    payment at all yet; nothing changed and the browser should keep polling.
 *  - `not_found` — the order is not this farmer's (or does not exist). The caller maps it to a 404.
 */
export type ConfirmResult =
  | { readonly kind: 'granted' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'not_found' };

/**
 * Confirm a recharge order WITHOUT a webhook (Requirement 22.7, D20).
 *
 * Razorpay cannot deliver a webhook to `localhost`, so this is the path that makes a recharge work
 * in local development and behind any private address: the browser's checkout success handler calls
 * the confirm route with the order id, and this asks Razorpay directly whether the order settled.
 * **The browser's own success report is never trusted as proof** (22.7) — it only triggers this
 * server-side check, and the grant still derives the paying farmer from the recorded order, not
 * from anything the browser sent.
 *
 * The order is loaded through `accessData(ownerId)`, which merges the owner into the read, so
 * another farmer's order id (and a non-existent one) both read as absent and return `not_found` —
 * a farmer cannot confirm, fail, or grant against an order that is not their own.
 *
 * When a payment against the order is `captured`, has the matching `order_id`, and its amount equals
 * `RECHARGE_PRICE_PAISE`, this grants through the SAME `grantAndExtend` transaction the webhook uses,
 * keyed on the provider PAYMENT id — so a confirm and a webhook for one payment extend the window
 * exactly once (Property 36). A duplicate (the webhook already granted, or a second confirm) is a
 * success from the browser's point of view, so it maps to `granted` too. When every payment has
 * `failed`, the order is marked failed (mirroring the `payment.failed` webhook). Anything else —
 * an authorized-but-not-captured payment, a captured payment at the wrong amount, or no payment yet
 * — is `pending`: nothing is changed and the card keeps polling.
 */
export async function confirmOrder(
  ownerId: string,
  providerOrderId: string,
  now: Date = new Date(),
): Promise<{ readonly result: ConfirmResult; readonly entitlement: EntitlementStatus }> {
  // Owner-scoped read: another farmer's order (and a missing one) both read as absent (D15, 13.2).
  const orders = await accessData(ownerId).findPaymentOrders({ providerOrderId });
  const order = orders[0];
  if (order === undefined) {
    return { result: { kind: 'not_found' }, entitlement: await entitlementStatus(ownerId, now) };
  }

  let payments;
  try {
    payments = await fetchOrderPayments(providerOrderId);
  } catch (error) {
    if (error instanceof RazorpayOrderError) {
      throw new AppError('PAYMENT_ORDER_FAILED', {
        cause: error,
        context: { reason: 'razorpay_order_payments_failed', ownerId, status: error.status },
      });
    }
    throw error;
  }

  // A captured payment for THIS order at Jamee's exact price is the one that grants (22.7). The
  // amount is checked server-side against the constant, never trusted from the browser or the order.
  const captured = payments.find(
    (payment) =>
      payment.status === 'captured' &&
      payment.orderId === providerOrderId &&
      payment.amountMinor === RECHARGE_PRICE_PAISE,
  );

  if (captured !== undefined) {
    const grant = await grantAndExtend(
      captured.id,
      providerOrderId,
      (currentExpiry) => nextExpiry(now, currentExpiry),
      withTransaction,
      now,
    );
    // `granted` and `duplicate` are both a success for the browser: the window is (or already was)
    // extended for this payment. `order_not_found` cannot happen — we loaded the order above — but
    // is mapped to pending defensively rather than asserted.
    const kind: ConfirmResult['kind'] = grant.kind === 'order_not_found' ? 'pending' : 'granted';
    return { result: { kind }, entitlement: await entitlementStatus(ownerId, now) };
  }

  // No capture. If every payment failed, mark the order failed (mirrors the payment.failed webhook,
  // 22.19). An order with no payments at all is still pending, not failed.
  if (payments.length > 0 && payments.every((payment) => payment.status === 'failed')) {
    await markPaymentOrderFailed(providerOrderId, now);
    return { result: { kind: 'failed' }, entitlement: await entitlementStatus(ownerId, now) };
  }

  return { result: { kind: 'pending' }, entitlement: await entitlementStatus(ownerId, now) };
}
