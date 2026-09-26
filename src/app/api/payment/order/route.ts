import 'server-only';

import { authenticatedRoute } from '@/lib/api/authenticated-route';
import { checkBurst } from '@/lib/rate-limit';
import { createRechargeOrder } from '@/services/payment.service';

/**
 * `POST /api/payment/order` — create a Razorpay recharge order for the session farmer.
 *
 * Requirements: 1.7 (no valid session ⇒ 401, no order created), 13.8 (burst rate limiting ahead of
 *               the work), 22.1 (create the order at Jamee's price), 22.2 (amount, currency, and
 *               paying farmer are server-side; none is read from the body), 22.3, 22.22 (a farmer
 *               can always start another)
 * Design: D15; Amendment A2 (the ₹20 recharge)
 *
 * `authenticatedRoute` supplies the server-confirmed farmer id — the order is recorded against
 * `session.userId`, never a body field, so a tampered request cannot buy an entitlement for another
 * farmer. There is no request body to read: the amount and currency come from
 * `src/lib/config/access.ts` inside the service.
 *
 * The burst check runs BEFORE the order is created (13.8), so a farmer hammering the button does
 * not open a stream of Razorpay orders. It is keyed on the `chat` minute window rather than a
 * payment-specific one: the burst counter's key is `(userId, operation, minute, windowKey)` over
 * the closed `Operation` enum, which has no `payment` member, so the recharge action rides the same
 * per-farmer minute ceiling — the goal of 13.8 is to bound the request RATE per farmer, which this
 * achieves without a schema change to the shared counter. A refused burst throws `RATE_LIMITED`
 * (429) through the same `withErrorHandling` envelope and creates no order.
 */

export const POST = authenticatedRoute(async (_request, session) => {
  await checkBurst(session.userId, 'chat');
  const order = await createRechargeOrder(session.userId);
  return Response.json(order, { status: 201 });
});
