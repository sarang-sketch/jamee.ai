import 'server-only';

import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { RECHARGE_CURRENCY, RECHARGE_PRICE_PAISE } from '@/lib/config/access';
import { serverEnv } from '@/lib/env';

/**
 * The Razorpay provider — the pure half.
 *
 * Three things and nothing else: create an order at the price Jamee decides (never the caller's),
 * verify a webhook signature over the exact raw body in constant time, and parse a
 * `payment.captured` / `payment.failed` webhook into the fields the grant needs. It talks to no
 * database, resolves no farmer, records no order, and grants no entitlement — recording and
 * granting are the caller's job (`src/services/payment.service.ts`, task 59).
 *
 * Requirements: 22.1 (order creation), 22.2 (the amount, currency, and paying farmer are
 *               server-side and none is read from the request body), 22.5 (the webhook signature
 *               is verified over the raw body), 22.6 (a missing header and an unconfigured secret
 *               are both failures, never a skipped check)
 * Design: D15 (the signature over raw bytes before any parse; an absent secret is a failed
 *         verification; only the verified payload plus the recorded order decide who paid what);
 *         Amendment A2 (the ₹20 / 2000-paise weekly recharge)
 * Depends on: V27 (the order endpoint and HTTP Basic auth, the `X-Razorpay-Signature` header,
 *             HMAC-SHA256 hex keyed with the webhook secret, the `payment.captured` /
 *             `payment.failed` event names, the payload paths, and the `x-razorpay-event-id`
 *             dedup header)
 *
 * ### THE KEY SECRET NEVER LEAVES THIS MODULE IN A FORM ANYTHING CAN READ
 *
 * The key secret signs order creation (HTTP Basic auth) and the webhook secret verifies
 * deliveries; neither is ever logged, returned, or placed in a thrown error. `createOrder`
 * returns only the identifiers the browser checkout needs — the order id, the public key id, the
 * amount, and the currency — and never the key secret. No provider error text crosses into a
 * farmer-facing message (Requirement 22.6): a failed order raises a plain error the caller maps
 * to `PAYMENT_ORDER_FAILED`, whose catalog copy carries none of Razorpay's response.
 *
 * ### SECRETS ARE READ LAZILY, AND EVERY FUNCTION ACCEPTS THEM AS A PARAMETER
 *
 * `keyId`, `keySecret`, and `webhookSecret` default to `serverEnv(...)`, evaluated only when the
 * argument is omitted — the same lazy-credential pattern `src/lib/telegram.ts` uses. A test passes
 * them explicitly and never touches the environment.
 *
 * ### U-V27a — the signature encoding
 *
 * The validation guide describes an HMAC-SHA256 comparison and Razorpay's SDK helpers use **hex**,
 * but a rendered raw-signature example was not retrievable to confirm hex over base64. This module
 * computes and compares **hex**, per the SDK convention, and this is the one place the assumption
 * lives. If a real signed webhook ever shows base64, this is the single function to change.
 */

/* ========================================================================== */
/* V27 — order creation                                                        */
/* ========================================================================== */

export const RAZORPAY_ORDERS_ENDPOINT = 'https://api.razorpay.com/v1/orders';

/** `fetch`, narrowed to the one shape this module issues — a POST with Basic auth and a JSON body. */
export type RazorpayFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
) => Promise<Response>;

export interface CreateOrderOptions {
  /** Defaults to `RAZORPAY_KEY_ID`, evaluated only when omitted. The public checkout key id. */
  readonly keyId?: string;
  /** Defaults to `RAZORPAY_KEY_SECRET`, evaluated only when omitted. Never returned or logged. */
  readonly keySecret?: string;
  /** An idempotency/reference string for Razorpay's own records (e.g. the Jamee order document id). */
  readonly receipt?: string;
  /** Opaque key/value notes stored on the order. Never carries a secret. */
  readonly notes?: Readonly<Record<string, string>>;
  readonly fetchImpl?: RazorpayFetch;
}

/**
 * What the browser checkout needs, and nothing more.
 *
 * `keyId` is the *public* checkout key id (also exposed as `NEXT_PUBLIC_RAZORPAY_KEY_ID`); the key
 * secret is never in here. `amountMinor` and `currency` are echoed back so the caller can render
 * the checkout without re-deriving them.
 */
export interface CreatedOrder {
  readonly orderId: string;
  readonly keyId: string;
  readonly amountMinor: number;
  readonly currency: string;
}

/** An order-creation failure. Carries no provider error text and no key secret. */
export class RazorpayOrderError extends Error {
  readonly status: number | undefined;
  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = 'RazorpayOrderError';
    if (options.status !== undefined) this.status = options.status;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * **V27.** `POST https://api.razorpay.com/v1/orders` with HTTP Basic auth (`key_id:key_secret`).
 *
 * **The amount and currency come from `src/lib/config/access.ts`, never from the caller's body**
 * (Requirement 22.2): `RECHARGE_PRICE_PAISE` and `RECHARGE_CURRENCY` are compile-time constants,
 * so a tampered request cannot buy a recharge at another price. There is deliberately no `amount`
 * parameter on this function.
 *
 * A non-2xx throws a `RazorpayOrderError` the caller maps to `PAYMENT_ORDER_FAILED`; the
 * provider's error body is read only to attach a bounded, secret-free note to the server log,
 * never to the farmer.
 */
export async function createOrder(options: CreateOrderOptions = {}): Promise<CreatedOrder> {
  const keyId = options.keyId ?? serverEnv('RAZORPAY_KEY_ID');
  const keySecret = options.keySecret ?? serverEnv('RAZORPAY_KEY_SECRET');
  const fetchImpl: RazorpayFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  const authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64')}`;
  const payload = {
    amount: RECHARGE_PRICE_PAISE,
    currency: RECHARGE_CURRENCY,
    ...(options.receipt === undefined ? {} : { receipt: options.receipt }),
    ...(options.notes === undefined ? {} : { notes: options.notes }),
  };

  let response: Response;
  try {
    response = await fetchImpl(RAZORPAY_ORDERS_ENDPOINT, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    throw new RazorpayOrderError('Razorpay order creation was unreachable', { cause });
  }

  if (!response.ok) {
    throw new RazorpayOrderError('Razorpay rejected the order creation request', { status: response.status });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new RazorpayOrderError('Razorpay order response was not readable JSON', { cause });
  }

  const parsed = z
    .object({
      id: z.string().min(1),
      amount: z.number().int(),
      currency: z.string().min(1),
      status: z.string().min(1),
    })
    .safeParse(body);

  if (!parsed.success) {
    throw new RazorpayOrderError('Razorpay order response did not match the V27 shape');
  }

  return {
    orderId: parsed.data.id,
    keyId,
    amountMinor: parsed.data.amount,
    currency: parsed.data.currency,
  };
}

/* ========================================================================== */
/* V27 — webhook signature verification                                        */
/* ========================================================================== */

export const RAZORPAY_SIGNATURE_HEADER = 'x-razorpay-signature';
export const RAZORPAY_EVENT_ID_HEADER = 'x-razorpay-event-id';
const SIGNATURE_ALGORITHM = 'sha256';

/**
 * **V27, D15.** Verify `X-Razorpay-Signature` over the **exact raw body string**.
 *
 * ### The bytes must be the bytes Razorpay signed
 *
 * `rawBody` is the body read once as text, before any parse. `request.json()` discards those bytes
 * and re-serializing the parsed object does not reproduce them — key order, whitespace, and
 * unicode escaping all differ — so a re-serialized body fails verification even when semantically
 * identical. The caller must pass the raw string, and there is a unit test for the re-serialized
 * case because it is the mistake that looks correct in review.
 *
 * ### What is compared
 *
 * HMAC-SHA256 over the raw body keyed with the **webhook secret** (`RAZORPAY_WEBHOOK_SECRET`,
 * distinct from the API key secret), rendered as **hex** (U-V27a), compared in constant time.
 *
 * ### A missing header and an unconfigured secret are both failures (Requirement 22.6)
 *
 * A missing or empty header returns `false`. An unconfigured secret is handled at the call site by
 * `serverEnv` throwing, which lands in the same 401 branch as a wrong signature — there is no
 * `if (secret) verify(...)` path. If a caller passes an explicit empty secret this function still
 * returns `false` rather than computing an HMAC keyed with nothing, so no configuration defect can
 * present itself as a stream of verified deliveries.
 */
export function verifyWebhookSignature(
  rawBody: string,
  header: string | null | undefined,
  webhookSecret: string = serverEnv('RAZORPAY_WEBHOOK_SECRET'),
): boolean {
  const presented = (header ?? '').trim();
  if (presented.length === 0) return false;
  if (webhookSecret.length === 0) return false;

  const expected = createHmac(SIGNATURE_ALGORITHM, webhookSecret).update(rawBody, 'utf8').digest('hex');

  const left = Buffer.from(presented.toLowerCase(), 'utf8');
  const right = Buffer.from(expected, 'utf8');
  // A length mismatch returns early — `timingSafeEqual` throws on unequal lengths, and the leaked
  // fact is the length of a value the caller supplied, not anything about the secret or the digest.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* ========================================================================== */
/* V27 — the webhook payload parser                                            */
/* ========================================================================== */

export type PaymentEventKind = 'captured' | 'failed';

/**
 * The fields the grant needs, extracted from a verified `payment.captured` / `payment.failed`
 * payload plus the `x-razorpay-event-id` header.
 *
 * `eventId` is Razorpay's own per-event dedup key (V27), which the caller may use in addition to
 * the order/payment-id claim. `kind` distinguishes a capture (which grants) from a failure (which
 * records nothing and leaves the window untouched).
 */
export interface ParsedPaymentWebhook {
  readonly kind: PaymentEventKind;
  readonly paymentId: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly status: string;
  /** The `x-razorpay-event-id` header value, or `null` when absent. */
  readonly eventId: string | null;
}

/**
 * **V27.** The webhook envelope: `event` is `payment.captured` or `payment.failed`, and the
 * payment entity sits at `payload.payment.entity`.
 *
 * `amount` is coerced from a number (Razorpay sends minor units as an integer). Fields Jamee does
 * not branch on are left out; requiring them would turn a documentation drift into a rejected
 * grant.
 */
const webhookPayloadSchema = z.object({
  event: z.enum(['payment.captured', 'payment.failed']),
  payload: z.object({
    payment: z.object({
      entity: z.object({
        id: z.string().min(1),
        order_id: z.string().min(1),
        amount: z.number().int(),
        status: z.string().min(1),
      }),
    }),
  }),
});

export type PaymentWebhookParse =
  | { readonly ok: true; readonly webhook: ParsedPaymentWebhook }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse a **verified** webhook body into the grant's inputs.
 *
 * The caller must have verified the signature over the raw body first (Requirement 22.5); this
 * function only interprets a body already trusted. `headers` is read for the `x-razorpay-event-id`
 * dedup key. A body whose `event` is neither captured nor failed, or whose entity is missing a
 * required path, is a payload Jamee does not act on and returns `ok: false`.
 */
export function parsePaymentWebhook(rawBody: string, headers?: Headers): PaymentWebhookParse {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'webhook body was not JSON' };
  }

  const parsed = webhookPayloadSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: issue === undefined ? 'payload did not match the V27 shape' : `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    };
  }

  const entity = parsed.data.payload.payment.entity;
  return {
    ok: true,
    webhook: {
      kind: parsed.data.event === 'payment.captured' ? 'captured' : 'failed',
      paymentId: entity.id,
      orderId: entity.order_id,
      amountMinor: entity.amount,
      status: entity.status,
      eventId: headers?.get(RAZORPAY_EVENT_ID_HEADER) ?? null,
    },
  };
}

/* ========================================================================== */
/* V27 — the order's payments, for a webhook-free confirmation (D20)           */
/* ========================================================================== */

/**
 * **V27, D20.** `GET https://api.razorpay.com/v1/orders/<order id>/payments` with the same HTTP
 * Basic auth (`key_id:key_secret`) `createOrder` uses, returning the payments made against ONE order.
 *
 * ### Why this exists at all
 *
 * Razorpay cannot deliver a webhook to `localhost`, so the webhook grant path (`processVerifiedWebhook`)
 * never fires in local development and any environment behind a private address. The confirmation
 * path in `payment.service.ts` uses this to ASK Razorpay directly, after the browser's checkout
 * success handler reports a payment, whether the order actually settled — the browser's own success
 * report is never trusted as proof (Requirement 22.7); it only triggers this server-side check.
 *
 * ### What is read, and what is deliberately not
 *
 * Each payment entity carries `id`, `amount` (paise, integer), `currency`, `status` (`created` →
 * `authorized` → `captured`, or `refunded` / `failed`), `order_id`, and a `captured` boolean. With
 * Razorpay's default auto-capture, a completed payment moves to `captured` on its own. The parser
 * reads exactly those fields the confirmation branches on and ignores the rest of the (large,
 * documentation-drift-prone) payment shape — the same narrowness `parsePaymentWebhook` applies.
 *
 * ### The key secret never leaves this module
 *
 * Auth is built here from `keyId`/`keySecret` (both defaulting to `serverEnv`, evaluated only when
 * omitted, exactly like `createOrder`). The secret is never returned, never logged, and never
 * placed in a thrown error; a non-2xx raises a `RazorpayOrderError` carrying no provider text, which
 * the service maps like any other order failure.
 */

/** One payment made against an order, narrowed to the fields the confirmation branches on. */
export interface OrderPayment {
  readonly id: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  readonly captured: boolean;
}

/** `GET`, narrowed to the one shape this function issues — Basic auth, no body. */
export type RazorpayGetFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
  },
) => Promise<Response>;

export interface FetchOrderPaymentsOptions {
  /** Defaults to `RAZORPAY_KEY_ID`, evaluated only when omitted. */
  readonly keyId?: string;
  /** Defaults to `RAZORPAY_KEY_SECRET`, evaluated only when omitted. Never returned or logged. */
  readonly keySecret?: string;
  readonly fetchImpl?: RazorpayGetFetch;
}

/**
 * The payments-collection envelope: `{ entity: 'collection', count, items: [...] }` (V27). Only the
 * per-item fields Jamee branches on are required — a payment entity carries dozens of others.
 */
const orderPaymentsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      order_id: z.string().min(1),
      amount: z.number().int(),
      currency: z.string().min(1),
      status: z.enum(['created', 'authorized', 'captured', 'refunded', 'failed']),
      captured: z.boolean(),
    }),
  ),
});

/**
 * **V27.** Fetch every payment made against `orderId`. A non-2xx or an unreadable/unexpected body
 * raises a `RazorpayOrderError` (no provider text, no secret); a 2xx with an empty `items` array is
 * a valid answer — the order simply has no payments yet — and returns `[]`.
 */
export async function fetchOrderPayments(
  orderId: string,
  options: FetchOrderPaymentsOptions = {},
): Promise<OrderPayment[]> {
  const keyId = options.keyId ?? serverEnv('RAZORPAY_KEY_ID');
  const keySecret = options.keySecret ?? serverEnv('RAZORPAY_KEY_SECRET');
  const fetchImpl: RazorpayGetFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  const authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64')}`;
  const endpoint = `${RAZORPAY_ORDERS_ENDPOINT}/${encodeURIComponent(orderId)}/payments`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, { method: 'GET', headers: { authorization } });
  } catch (cause) {
    throw new RazorpayOrderError('Razorpay order-payments fetch was unreachable', { cause });
  }

  if (!response.ok) {
    throw new RazorpayOrderError('Razorpay rejected the order-payments request', { status: response.status });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new RazorpayOrderError('Razorpay order-payments response was not readable JSON', { cause });
  }

  const parsed = orderPaymentsSchema.safeParse(body);
  if (!parsed.success) {
    throw new RazorpayOrderError('Razorpay order-payments response did not match the V27 shape');
  }

  return parsed.data.items.map((item) => ({
    id: item.id,
    orderId: item.order_id,
    amountMinor: item.amount,
    currency: item.currency,
    status: item.status,
    captured: item.captured,
  }));
}
