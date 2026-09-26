import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { RECHARGE_CURRENCY, RECHARGE_PRICE_PAISE } from '@/lib/config/access';
import {
  createOrder,
  fetchOrderPayments,
  parsePaymentWebhook,
  RAZORPAY_EVENT_ID_HEADER,
  RAZORPAY_ORDERS_ENDPOINT,
  RazorpayOrderError,
  verifyWebhookSignature,
  type RazorpayFetch,
  type RazorpayGetFetch,
} from '@/lib/razorpay';

/**
 * Unit tests for `src/lib/razorpay.ts` (the pure provider half — task 59.1).
 *
 * Requirements: 22.1 (order creation), 22.2 (the amount and currency come from access.ts, never
 *               the caller's body), 22.5 (the signature is verified over the raw body), 22.6 (a
 *               missing header and an unconfigured secret are both failures).
 *
 * Every function takes its secret as an explicit parameter, so no test reads the environment.
 */

const KEY_ID = 'rzp_test_ExampleKeyId';
const KEY_SECRET = 'test-key-secret-abc';
const WEBHOOK_SECRET = 'test-webhook-secret-xyz';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/* -------------------------------------------------------------------------- */
/* createOrder (Requirements 22.1, 22.2)                                       */
/* -------------------------------------------------------------------------- */

describe('createOrder', () => {
  it('posts the amount from access.ts, not from any caller input', async () => {
    const fetchImpl = vi.fn<RazorpayFetch>().mockResolvedValue(
      jsonResponse({ id: 'order_123', amount: RECHARGE_PRICE_PAISE, currency: RECHARGE_CURRENCY, status: 'created' }),
    );
    const order = await createOrder({ keyId: KEY_ID, keySecret: KEY_SECRET, fetchImpl, receipt: 'jamee-order-1' });

    expect(order).toEqual({
      orderId: 'order_123',
      keyId: KEY_ID,
      amountMinor: RECHARGE_PRICE_PAISE,
      currency: RECHARGE_CURRENCY,
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(RAZORPAY_ORDERS_ENDPOINT);
    const body = JSON.parse(init?.body ?? '{}');
    expect(body.amount).toBe(RECHARGE_PRICE_PAISE);
    expect(body.currency).toBe(RECHARGE_CURRENCY);
    expect(body.receipt).toBe('jamee-order-1');
  });

  it('uses HTTP Basic auth with the key id and secret, and never returns the secret', async () => {
    const fetchImpl = vi.fn<RazorpayFetch>().mockResolvedValue(
      jsonResponse({ id: 'order_1', amount: RECHARGE_PRICE_PAISE, currency: RECHARGE_CURRENCY, status: 'created' }),
    );
    const order = await createOrder({ keyId: KEY_ID, keySecret: KEY_SECRET, fetchImpl });

    const auth = fetchImpl.mock.calls[0]?.[1]?.headers?.['authorization'] ?? '';
    expect(auth.startsWith('Basic ')).toBe(true);
    const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8');
    expect(decoded).toBe(`${KEY_ID}:${KEY_SECRET}`);
    // The secret is not present anywhere in the returned object.
    expect(JSON.stringify(order)).not.toContain(KEY_SECRET);
  });

  it('throws a RazorpayOrderError carrying no provider text on a non-2xx', async () => {
    const fetchImpl = vi.fn<RazorpayFetch>().mockResolvedValue(
      jsonResponse({ error: { description: 'the exact provider message' } }, 400),
    );
    await expect(createOrder({ keyId: KEY_ID, keySecret: KEY_SECRET, fetchImpl })).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(RazorpayOrderError);
      expect((e as Error).message).not.toContain('the exact provider message');
      expect((e as Error).message).not.toContain(KEY_SECRET);
      return true;
    });
  });

  it('throws when the response does not match the expected shape', async () => {
    const fetchImpl = vi.fn<RazorpayFetch>().mockResolvedValue(jsonResponse({ nonsense: true }));
    await expect(createOrder({ keyId: KEY_ID, keySecret: KEY_SECRET, fetchImpl })).rejects.toBeInstanceOf(
      RazorpayOrderError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* verifyWebhookSignature (Requirements 22.5, 22.6)                            */
/* -------------------------------------------------------------------------- */

const RAW_BODY = JSON.stringify({
  event: 'payment.captured',
  payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 2000, status: 'captured' } } },
});

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature over the raw body', () => {
    expect(verifyWebhookSignature(RAW_BODY, sign(RAW_BODY, WEBHOOK_SECRET), WEBHOOK_SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const tampered = RAW_BODY.replace('2000', '999999');
    expect(verifyWebhookSignature(tampered, sign(RAW_BODY, WEBHOOK_SECRET), WEBHOOK_SECRET)).toBe(false);
  });

  it('rejects a re-serialized body (the mistake that looks correct in review)', () => {
    const reserialized = JSON.stringify(JSON.parse(RAW_BODY));
    // Only fails if re-serialization actually changed the bytes; construct a body where it does.
    const spacedBody = JSON.stringify({ a: 1, b: 2 }, null, 2);
    const compact = JSON.stringify(JSON.parse(spacedBody));
    expect(verifyWebhookSignature(compact, sign(spacedBody, WEBHOOK_SECRET), WEBHOOK_SECRET)).toBe(false);
    // And the canonical case still verifies against its own exact bytes.
    expect(verifyWebhookSignature(reserialized, sign(reserialized, WEBHOOK_SECRET), WEBHOOK_SECRET)).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifyWebhookSignature(RAW_BODY, sign(RAW_BODY, 'a-different-secret'), WEBHOOK_SECRET)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyWebhookSignature(RAW_BODY, null, WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(RAW_BODY, '', WEBHOOK_SECRET)).toBe(false);
  });

  it('rejects an unconfigured (empty) secret rather than computing an HMAC keyed with nothing', () => {
    expect(verifyWebhookSignature(RAW_BODY, sign(RAW_BODY, ''), '')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* parsePaymentWebhook (V27)                                                   */
/* -------------------------------------------------------------------------- */

describe('parsePaymentWebhook', () => {
  it('parses a payment.captured payload and the event-id header', () => {
    const headers = new Headers({ [RAZORPAY_EVENT_ID_HEADER]: 'evt_abc' });
    const result = parsePaymentWebhook(RAW_BODY, headers);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.webhook).toEqual({
      kind: 'captured',
      paymentId: 'pay_1',
      orderId: 'order_1',
      amountMinor: 2000,
      status: 'captured',
      eventId: 'evt_abc',
    });
  });

  it('parses a payment.failed payload', () => {
    const body = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_2', order_id: 'order_2', amount: 2000, status: 'failed' } } },
    });
    const result = parsePaymentWebhook(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.webhook.kind).toBe('failed');
    expect(result.webhook.paymentId).toBe('pay_2');
    expect(result.webhook.eventId).toBeNull();
  });

  it('rejects a body that is not JSON', () => {
    const result = parsePaymentWebhook('not json');
    expect(result.ok).toBe(false);
  });

  it('rejects an event Jamee does not act on', () => {
    const body = JSON.stringify({ event: 'order.paid', payload: {} });
    expect(parsePaymentWebhook(body).ok).toBe(false);
  });

  it('rejects a payload missing a required entity path', () => {
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1' } } } });
    expect(parsePaymentWebhook(body).ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* fetchOrderPayments (V27, D20)                                               */
/* -------------------------------------------------------------------------- */

function paymentsResponse(items: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ entity: 'collection', count: items.length, items }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchOrderPayments', () => {
  it('GETs the order-payments endpoint with Basic auth and parses the items', async () => {
    const fetchImpl = vi.fn<RazorpayGetFetch>().mockResolvedValue(
      paymentsResponse([
        {
          id: 'pay_1',
          order_id: 'order_123',
          amount: RECHARGE_PRICE_PAISE,
          currency: RECHARGE_CURRENCY,
          status: 'captured',
          captured: true,
          // extra fields Razorpay sends are ignored, not rejected
          method: 'card',
          international: false,
        },
      ]),
    );

    const payments = await fetchOrderPayments('order_123', { keyId: KEY_ID, keySecret: KEY_SECRET, fetchImpl });

    expect(payments).toEqual([
      { id: 'pay_1', orderId: 'order_123', amountMinor: RECHARGE_PRICE_PAISE, currency: RECHARGE_CURRENCY, status: 'captured', captured: true },
    ]);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${RAZORPAY_ORDERS_ENDPOINT}/order_123/payments`);
    expect(init?.method).toBe('GET');
    const auth = init?.headers?.['authorization'] ?? '';
    expect(auth.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8')).toBe(`${KEY_ID}:${KEY_SECRET}`);
  });

  it('never returns or logs the key secret', async () => {
    const fetchImpl = vi.fn<RazorpayGetFetch>().mockResolvedValue(paymentsResponse([]));
    const payments = await fetchOrderPayments('order_1', { keyId: KEY_ID, keySecret: KEY_SECRET, fetchImpl });
    expect(JSON.stringify(payments)).not.toContain(KEY_SECRET);
  });

  it('returns an empty array for an order with no payments yet', async () => {
    const fetchImpl = vi.fn<RazorpayGetFetch>().mockResolvedValue(paymentsResponse([]));
    await expect(
      fetchOrderPayments('order_1', { keyId: KEY_ID, keySecret: KEY_SECRET, fetchImpl }),
    ).resolves.toEqual([]);
  });

  it('parses every documented status', async () => {
    const statuses = ['created', 'authorized', 'captured', 'refunded', 'failed'] as const;
    const fetchImpl = vi.fn<RazorpayGetFetch>().mockResolvedValue(
      paymentsResponse(
        statuses.map((status, i) => ({
          id: `pay_${i}`,
          order_id: 'order_1',
          amount: RECHARGE_PRICE_PAISE,
          currency: RECHARGE_CURRENCY,
          status,
          captured: status === 'captured',
        })),
      ),
    );
    const payments = await fetchOrderPayments('order_1', { keyId: KEY_ID, keySecret: KEY_SECRET, fetchImpl });
    expect(payments.map((p) => p.status)).toEqual([...statuses]);
  });

  it('throws a RazorpayOrderError carrying no provider text on a non-2xx', async () => {
    const fetchImpl = vi.fn<RazorpayGetFetch>().mockResolvedValue(
      paymentsResponse([{ error: 'the exact provider message' }], 400),
    );
    await expect(
      fetchOrderPayments('order_1', { keyId: KEY_ID, keySecret: KEY_SECRET, fetchImpl }),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(RazorpayOrderError);
      expect((e as Error).message).not.toContain('the exact provider message');
      expect((e as Error).message).not.toContain(KEY_SECRET);
      return true;
    });
  });

  it('throws when the response does not match the V27 shape', async () => {
    const fetchImpl = vi.fn<RazorpayGetFetch>().mockResolvedValue(
      paymentsResponse([{ id: 'pay_1' /* missing order_id/amount/status/captured */ }]),
    );
    await expect(
      fetchOrderPayments('order_1', { keyId: KEY_ID, keySecret: KEY_SECRET, fetchImpl }),
    ).rejects.toBeInstanceOf(RazorpayOrderError);
  });

  it('URL-encodes the order id', async () => {
    const fetchImpl = vi.fn<RazorpayGetFetch>().mockResolvedValue(paymentsResponse([]));
    await fetchOrderPayments('order/with space', { keyId: KEY_ID, keySecret: KEY_SECRET, fetchImpl });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${RAZORPAY_ORDERS_ENDPOINT}/order%2Fwith%20space/payments`);
  });
});
