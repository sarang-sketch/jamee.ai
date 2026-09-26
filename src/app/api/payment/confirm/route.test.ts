import type { NextRequest } from 'next/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wiring tests for `src/app/api/payment/confirm/route.ts`.
 *
 * Requirements: 1.7 (no session ⇒ 401, nothing confirmed), 13.8 (burst check BEFORE the work),
 *               22.7 (the browser is not trusted; only the order id is read and the server confirms)
 * Design: D14, D15, D20
 *
 * Boundary facts: the burst limiter runs before `confirmOrder`; the order id comes from the body and
 * the farmer from the session; granted/pending/failed answer 200 with the entitlement window; a
 * not_found order is 404 with no body; a missing session is 401 before the service; a refused burst
 * is 429 with nothing confirmed.
 */

const spies = vi.hoisted(() => ({ currentUserId: vi.fn(), checkBurst: vi.fn(), confirmOrder: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ currentUserId: spies.currentUserId }));
vi.mock('@/lib/rate-limit', () => ({ checkBurst: spies.checkBurst }));
vi.mock('@/services/payment.service', () => ({ confirmOrder: spies.confirmOrder }));

import { POST } from './route';
import { AppError } from '@/lib/errors';

const USER = 'user-1';
const WINDOW = { expiresAt: '2026-01-08T00:00:00.000Z', isActive: true };

function request(body: unknown = { orderId: 'ord_1' }): NextRequest {
  return new Request('https://jamee.test/api/payment/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.currentUserId.mockResolvedValue(USER);
  spies.checkBurst.mockResolvedValue(undefined);
  spies.confirmOrder.mockResolvedValue({ result: { kind: 'granted' }, entitlement: WINDOW });
});

describe('POST /api/payment/confirm', () => {
  it('checks the burst limit BEFORE confirming, then returns 200 with the window (13.8, 22.7)', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(spies.checkBurst).toHaveBeenCalledWith(USER, 'chat');
    expect(spies.confirmOrder).toHaveBeenCalledWith(USER, 'ord_1');
    expect(spies.checkBurst.mock.invocationCallOrder[0]!).toBeLessThan(spies.confirmOrder.mock.invocationCallOrder[0]!);
    await expect(response.json()).resolves.toEqual({ status: 'granted', entitlement: WINDOW });
  });

  it('passes only the order id and the session farmer — never a body-supplied user (22.7, D15)', async () => {
    await POST(request({ orderId: 'ord_9', userId: 'attacker', amount: 1 }));
    expect(spies.confirmOrder).toHaveBeenCalledWith(USER, 'ord_9');
  });

  it('answers 200 with the window for a pending confirmation', async () => {
    spies.confirmOrder.mockResolvedValue({ result: { kind: 'pending' }, entitlement: { expiresAt: null, isActive: false } });
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'pending' });
  });

  it('answers 200 for a failed order', async () => {
    spies.confirmOrder.mockResolvedValue({ result: { kind: 'failed' }, entitlement: { expiresAt: null, isActive: false } });
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'failed' });
  });

  it('answers 404 with no body when the order is not this farmer’s', async () => {
    spies.confirmOrder.mockResolvedValue({ result: { kind: 'not_found' }, entitlement: { expiresAt: null, isActive: false } });
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('no session ⇒ 401 and no burst check, nothing confirmed (1.7)', async () => {
    spies.currentUserId.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(spies.checkBurst).not.toHaveBeenCalled();
    expect(spies.confirmOrder).not.toHaveBeenCalled();
  });

  it('a refused burst is 429 and confirms nothing (13.8)', async () => {
    spies.checkBurst.mockRejectedValue(new AppError('RATE_LIMITED'));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(spies.confirmOrder).not.toHaveBeenCalled();
  });

  it('a body with no order id is 400 (MESSAGE_INVALID) and confirms nothing', async () => {
    const response = await POST(request({ notOrderId: 'x' }));
    expect(response.status).toBe(400);
    expect(spies.confirmOrder).not.toHaveBeenCalled();
  });

  it('a non-JSON body is 400 and confirms nothing', async () => {
    const response = await POST(request('not json'));
    expect(response.status).toBe(400);
    expect(spies.confirmOrder).not.toHaveBeenCalled();
  });
});
