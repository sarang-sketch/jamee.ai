import type { NextRequest } from 'next/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wiring tests for `src/app/api/payment/order/route.ts`.
 *
 * Requirements: 1.7 (no session ⇒ 401, no order), 13.8 (burst check BEFORE the work), 22.1, 22.2
 *               (the order is created for the session farmer; no amount from the body)
 *
 * Boundary facts: the burst limiter runs before `createRechargeOrder`, the order is created for the
 * session farmer, a success is 201 with the four checkout fields, a missing session is 401 before
 * the service, and a refused burst (RATE_LIMITED) is 429 with no order created.
 */

const spies = vi.hoisted(() => ({ currentUserId: vi.fn(), checkBurst: vi.fn(), createRechargeOrder: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ currentUserId: spies.currentUserId }));
vi.mock('@/lib/rate-limit', () => ({ checkBurst: spies.checkBurst }));
vi.mock('@/services/payment.service', () => ({ createRechargeOrder: spies.createRechargeOrder }));

import { POST } from './route';
import { AppError } from '@/lib/errors';

const USER = 'user-1';
const ORDER = { orderId: 'ord_1', keyId: 'rzp_test', amountMinor: 2000, currency: 'INR' };

function request(): NextRequest {
  return new Request('https://jamee.test/api/payment/order', { method: 'POST' }) as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.currentUserId.mockResolvedValue(USER);
  spies.checkBurst.mockResolvedValue(undefined);
  spies.createRechargeOrder.mockResolvedValue(ORDER);
});

describe('POST /api/payment/order', () => {
  it('checks the burst limit BEFORE creating the order, then returns 201 with the checkout fields (13.8, 22.2)', async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(spies.checkBurst).toHaveBeenCalledTimes(1);
    expect(spies.checkBurst).toHaveBeenCalledWith(USER, 'chat');
    expect(spies.createRechargeOrder).toHaveBeenCalledWith(USER);
    // The order invocation happened after the burst check resolved.
    expect(spies.checkBurst.mock.invocationCallOrder[0]!).toBeLessThan(spies.createRechargeOrder.mock.invocationCallOrder[0]!);
    expect(await response.json()).toEqual(ORDER);
  });

  it('no session ⇒ 401 and no burst check, no order (1.7)', async () => {
    spies.currentUserId.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(spies.checkBurst).not.toHaveBeenCalled();
    expect(spies.createRechargeOrder).not.toHaveBeenCalled();
  });

  it('a refused burst is 429 and creates no order (13.8)', async () => {
    spies.checkBurst.mockRejectedValue(new AppError('RATE_LIMITED'));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(spies.createRechargeOrder).not.toHaveBeenCalled();
  });
});
