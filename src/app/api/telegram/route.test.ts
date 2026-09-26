import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NextRequest } from 'next/server';

/**
 * Unit tests for `POST /api/telegram` (`src/app/api/telegram/route.ts`).
 *
 * The route is a thin adapter: read the start instant, throttle by a hash of the caller address,
 * hand the request to `dispatchTelegramRequest`, and map its one authentication verdict to a status.
 * So both collaborators are mocked at the module level and the tests assert ONLY the route's own
 * contract:
 *
 *   - Requirement 13.9 / D16: a throttled caller gets 429 with nothing dispatched.
 *   - Requirement 11.3 / D12: `authenticated: false` → 401 (the sole exception to acknowledge-200).
 *   - Requirement 10.11: every authenticated delivery → 200, whatever the per-update disposition.
 *   - `maxDuration` is exported as V17's 60.
 */

type Outcome =
  | { authenticated: false }
  | { authenticated: true; result: { updateId: number | null; disposition: string; replySent: boolean; detail: string } };

const throttle = vi.fn<(...args: unknown[]) => Promise<number | null>>(async () => 1);
const dispatchRequest = vi.fn<(...args: unknown[]) => Promise<Outcome>>(async () => ({
  authenticated: true,
  result: { updateId: 1, disposition: 'processed', replySent: true, detail: 'dispatched:text' },
}));

vi.mock('@/lib/db/farmer', () => ({
  webhookThrottleTryIncrement: (...a: unknown[]) => throttle(...(a as [])),
}));
vi.mock('@/lib/telegram-dispatch', () => ({
  dispatchTelegramRequest: (...a: unknown[]) => dispatchRequest(...(a as [])),
}));
// `minuteWindowKey` is pure; the real one is fine, but stub it to avoid coupling to the clock.
vi.mock('@/lib/time', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, minuteWindowKey: () => '2026-09-27T00:00' };
});

const route = await import('@/app/api/telegram/route');

function req(headers: Record<string, string> = {}): NextRequest {
  return new Request('https://jamee.test/api/telegram', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.9', ...headers },
    body: '{}',
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  throttle.mockResolvedValue(1);
  dispatchRequest.mockResolvedValue({
    authenticated: true,
    result: { updateId: 1, disposition: 'processed', replySent: true, detail: 'dispatched:text' },
  });
});

describe('POST /api/telegram', () => {
  it('exports maxDuration = 60 (V17)', () => {
    expect(route.maxDuration).toBe(60);
  });

  it('a throttled caller gets 429 and nothing is dispatched', async () => {
    throttle.mockResolvedValueOnce(null);
    const res = await route.POST(req());
    expect(res.status).toBe(429);
    expect(dispatchRequest).not.toHaveBeenCalled();
  });

  it('an unauthenticated delivery (bad secret) returns 401', async () => {
    dispatchRequest.mockResolvedValueOnce({ authenticated: false });
    const res = await route.POST(req());
    expect(res.status).toBe(401);
  });

  it('an authenticated delivery returns 200 regardless of the per-update disposition', async () => {
    dispatchRequest.mockResolvedValueOnce({
      authenticated: true,
      result: { updateId: 5, disposition: 'not_entitled', replySent: true, detail: 'no_active_entitlement_window' },
    });
    const res = await route.POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('the throttle is keyed on the telegram route and a hash of the caller address (not the raw address)', async () => {
    await route.POST(req({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }));
    expect(throttle).toHaveBeenCalledTimes(1);
    const [routeArg, callerHash, windowKey, limit] = throttle.mock.calls[0]!;
    expect(routeArg).toBe('telegram');
    // sha-256 hex of the first forwarded hop, lowercased — 64 hex chars, and not the raw address.
    expect(callerHash).toMatch(/^[0-9a-f]{64}$/);
    expect(callerHash).not.toContain('198.51.100.7');
    expect(windowKey).toBe('2026-09-27T00:00');
    expect(typeof limit).toBe('number');
  });
});
