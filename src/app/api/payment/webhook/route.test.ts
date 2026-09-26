import { createHmac } from 'node:crypto';

import type { NextRequest } from 'next/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wiring tests for `src/app/api/payment/webhook/route.ts`.
 *
 * Requirements: 13.9 (a per-caller throttle keyed on a hash of the caller address), 22.5 (verify
 *               over the RAW body before any parse), 22.6 (a missing header OR an unset secret is a
 *               401 — never a skipped check), 22.10, 22.11 (a verified duplicate is answered 200),
 *               22.19 (a failed payment records nothing extra), 22.24 (no farmer session consulted)
 * Design: D15, D16, D19
 *
 * These are boundary facts about the ROUTE: the order of operations (raw body → throttle → verify →
 * parse → process), that a forged signature reaches neither the parser nor the service, that a
 * missing header and an unset secret both 401, and that a throttled caller gets 429 with nothing
 * parsed. The grant idempotency and window arithmetic are the service's/DAL's, proven in
 * `tests/integration/access-flow.test.ts`.
 *
 * The signature verification and payload parsing are the REAL functions from `@/lib/razorpay` (they
 * are pure and secret-free once the secret is supplied), so "a forged signature is rejected" is a
 * real HMAC comparison, not a stub returning false.
 */

const spies = vi.hoisted(() => ({
  throttle: vi.fn(),
  serverEnv: vi.fn(),
  processVerifiedWebhook: vi.fn(),
}));

vi.mock('@/lib/db/farmer', () => ({ webhookThrottleTryIncrement: spies.throttle }));
vi.mock('@/lib/env', () => ({ serverEnv: spies.serverEnv }));
vi.mock('@/services/payment.service', () => ({ processVerifiedWebhook: spies.processVerifiedWebhook }));

import { POST, maxDuration } from './route';
import { RAZORPAY_SIGNATURE_HEADER } from '@/lib/razorpay';

const WEBHOOK_SECRET = 'test_webhook_secret';

/** A well-formed captured payload the real parser accepts. */
const capturedBody = JSON.stringify({
  event: 'payment.captured',
  payload: { payment: { entity: { id: 'pay_1', order_id: 'ord_1', amount: 2000, status: 'captured' } } },
});

/** The correct HMAC-SHA256 hex signature over a raw body. */
function sign(rawBody: string, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function webhookRequest(rawBody: string, headers: Record<string, string> = {}): NextRequest {
  const request = new Request('https://jamee.test/api/payment/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers },
    body: rawBody,
  });
  return request as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: throttle allows, secret is configured, the service confirms a grant.
  spies.throttle.mockResolvedValue(1);
  spies.serverEnv.mockReturnValue(WEBHOOK_SECRET);
  spies.processVerifiedWebhook.mockResolvedValue({ kind: 'granted', ownerId: 'A', expiresAt: new Date() });
});

/* ========================================================================== */
/* maxDuration                                                                 */
/* ========================================================================== */

it('declares a 60s maxDuration', () => {
  expect(maxDuration).toBe(60);
});

/* ========================================================================== */
/* The signature is the whole boundary (22.5, 22.6, 22.24)                     */
/* ========================================================================== */

describe('signature verification', () => {
  it('a valid signature over the raw body is processed and answered 200', async () => {
    const response = await POST(webhookRequest(capturedBody, { [RAZORPAY_SIGNATURE_HEADER]: sign(capturedBody) }));
    expect(response.status).toBe(200);
    expect(spies.processVerifiedWebhook).toHaveBeenCalledTimes(1);
    // The parsed captured event reached the service.
    expect(spies.processVerifiedWebhook.mock.calls[0]![0]).toMatchObject({ kind: 'captured', orderId: 'ord_1', paymentId: 'pay_1' });
  });

  it('a FORGED signature is 401 and reaches neither the parser nor the service (22.5)', async () => {
    const response = await POST(webhookRequest(capturedBody, { [RAZORPAY_SIGNATURE_HEADER]: 'deadbeef' }));
    expect(response.status).toBe(401);
    expect(spies.processVerifiedWebhook).not.toHaveBeenCalled();
  });

  it('a signature computed over a DIFFERENT body is 401 (the raw bytes must be the signed bytes)', async () => {
    const otherSig = sign('{"event":"payment.captured","payload":{}}');
    const response = await POST(webhookRequest(capturedBody, { [RAZORPAY_SIGNATURE_HEADER]: otherSig }));
    expect(response.status).toBe(401);
    expect(spies.processVerifiedWebhook).not.toHaveBeenCalled();
  });

  it('a MISSING signature header is 401 (22.6)', async () => {
    const response = await POST(webhookRequest(capturedBody));
    expect(response.status).toBe(401);
    expect(spies.processVerifiedWebhook).not.toHaveBeenCalled();
  });

  it('an UNSET secret (serverEnv throws) is 401, never a skipped check (22.6)', async () => {
    spies.serverEnv.mockImplementation(() => {
      throw new Error('Missing environment variable RAZORPAY_WEBHOOK_SECRET');
    });
    const response = await POST(webhookRequest(capturedBody, { [RAZORPAY_SIGNATURE_HEADER]: sign(capturedBody) }));
    expect(response.status).toBe(401);
    expect(spies.processVerifiedWebhook).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* The per-caller throttle (13.9, D16)                                         */
/* ========================================================================== */

describe('per-caller throttle', () => {
  it('is keyed on a hash of the caller address, not the raw address (D16)', async () => {
    await POST(webhookRequest(capturedBody, { [RAZORPAY_SIGNATURE_HEADER]: sign(capturedBody) }));
    expect(spies.throttle).toHaveBeenCalledTimes(1);
    const [route, callerHash] = spies.throttle.mock.calls[0]!;
    expect(route).toBe('payment');
    // A sha-256 hex digest, never the raw IP.
    expect(callerHash).toMatch(/^[0-9a-f]{64}$/);
    expect(callerHash).not.toContain('203.0.113.7');
  });

  it('a throttled caller (null) gets 429 with nothing verified or parsed', async () => {
    spies.throttle.mockResolvedValue(null);
    const response = await POST(webhookRequest(capturedBody, { [RAZORPAY_SIGNATURE_HEADER]: sign(capturedBody) }));
    expect(response.status).toBe(429);
    // The throttle ran before verification — serverEnv (the secret read) was never reached.
    expect(spies.serverEnv).not.toHaveBeenCalled();
    expect(spies.processVerifiedWebhook).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* Every verified delivery is answered 200 (22.10, 22.11)                      */
/* ========================================================================== */

describe('verified deliveries are always 200', () => {
  const sig = () => sign(capturedBody);

  it('a duplicate grant is answered 200', async () => {
    spies.processVerifiedWebhook.mockResolvedValue({ kind: 'duplicate' });
    const response = await POST(webhookRequest(capturedBody, { [RAZORPAY_SIGNATURE_HEADER]: sig() }));
    expect(response.status).toBe(200);
  });

  it('an unmatched order is answered 200', async () => {
    spies.processVerifiedWebhook.mockResolvedValue({ kind: 'order_not_found' });
    const response = await POST(webhookRequest(capturedBody, { [RAZORPAY_SIGNATURE_HEADER]: sig() }));
    expect(response.status).toBe(200);
  });

  it('a verified body Jamee does not act on (unparseable) is answered 200 without calling the service', async () => {
    const junk = '{"event":"payment.refunded","payload":{}}';
    const response = await POST(webhookRequest(junk, { [RAZORPAY_SIGNATURE_HEADER]: sign(junk) }));
    expect(response.status).toBe(200);
    expect(spies.processVerifiedWebhook).not.toHaveBeenCalled();
  });
});
