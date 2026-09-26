import 'server-only';

import { authenticatedRoute } from '@/lib/api/authenticated-route';
import { checkBurst } from '@/lib/rate-limit';
import { AppError } from '@/lib/errors';
import { paymentConfirmRequestSchema, type ProfileAccess } from '@/lib/access-schemas';
import { confirmOrder } from '@/services/payment.service';

/**
 * `POST /api/payment/confirm` — confirm a recharge order server-side, with no webhook (D20).
 *
 * Requirements: 1.7 (no valid session ⇒ 401, nothing confirmed), 13.8 (burst limiting ahead of the
 *               work), 22.7 (the browser's checkout success is NEVER trusted as proof of payment;
 *               it only triggers this server-side check), 22.2/D15 (the paying farmer is the
 *               session farmer and the amount is Jamee's server-side constant — neither is read from
 *               the browser)
 * Design: D14, D15; Amendment A2 (the ₹20 / 7-day recharge), D20 (the webhook-free confirmation)
 *
 * =============================================================================
 * WHY THIS ENDPOINT EXISTS AND WHAT IT DOES NOT TRUST
 * =============================================================================
 *
 * Razorpay cannot deliver a webhook to `localhost`, so the `payment.captured` webhook (the normal
 * grant path) never fires in local development and behind any private address. The Razorpay
 * Standard Checkout success handler runs in the FARMER'S BROWSER, which is not a trusted grant
 * source (Requirement 22.7): a tampered page could call it without paying. So this route takes ONLY
 * the order id, and its whole job is to make the SERVER ask Razorpay — via `confirmOrder` /
 * `fetchOrderPayments` — whether that order actually settled. The grant derives the paying farmer
 * from the recorded order and the session, and the amount from `RECHARGE_PRICE_PAISE`, so nothing
 * the browser sends can grant an entitlement or grant one at another price.
 *
 * `authenticatedRoute` supplies the server-confirmed farmer id; the order is loaded owner-scoped, so
 * another farmer's order id reads as absent and is answered 404. The burst check runs BEFORE the
 * confirmation (13.8), on the shared `chat` minute window, exactly as `/api/payment/order` does — a
 * farmer hammering confirm does not open a stream of Razorpay round trips.
 *
 * The 200 body is the same `ProfileAccess`-adjacent shape the card already reads elsewhere: the
 * entitlement window, so the browser refreshes the shown expiry from the server's own answer rather
 * than from anything it computed. A confirm that finds the order not this farmer's is a 404
 * (`CONVERSATION_NOT_FOUND` is the wrong noun; there is no order-specific code, so a bare 404 with
 * no coded envelope is used — see below).
 */

export const maxDuration = 60;

/** A sweep is never cached; a confirmation reads a live provider state and differs per call. */
export const dynamic = 'force-dynamic';

export const POST = authenticatedRoute(async (request, session) => {
  await checkBurst(session.userId, 'chat');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError('MESSAGE_INVALID', { context: { reason: 'payment_confirm_body_not_json' } });
  }

  const parsed = paymentConfirmRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('MESSAGE_INVALID', { context: { reason: 'payment_confirm_body_invalid' } });
  }

  const { result, entitlement } = await confirmOrder(session.userId, parsed.data.orderId);

  if (result.kind === 'not_found') {
    // The order is not this farmer's (or does not exist). No entitlement window is disclosed for an
    // order the caller does not own — a bare 404, no body.
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  // granted / failed / pending all answer 200 with the current window; the card decides from
  // `isActive` whether to stop polling. `isLinked` is not this route's concern, so only the
  // entitlement half of the access shape is returned — the card reads `entitlement`.
  const responseBody: Pick<ProfileAccess, 'entitlement'> & { status: typeof result.kind } = {
    status: result.kind,
    entitlement,
  };
  return Response.json(responseBody, { status: 200, headers: { 'cache-control': 'no-store' } });
});
