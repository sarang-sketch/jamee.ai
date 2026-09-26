import type { NextRequest } from 'next/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wiring tests for `src/app/api/profile/access/route.ts`.
 *
 * Requirements: 1.7 (no session ⇒ 401), 21.20 (link state), 22.18 (entitlement window)
 *
 * Boundary facts: the route reads the session farmer's link state and entitlement in one response,
 * never exposes the raw telegram id, and refuses without a session.
 */

const spies = vi.hoisted(() => ({ currentUserId: vi.fn(), isTelegramLinked: vi.fn(), entitlementStatus: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ currentUserId: spies.currentUserId }));
vi.mock('@/lib/db/access', () => ({ accessData: (ownerId: string) => ({ ownerId, isTelegramLinked: spies.isTelegramLinked }) }));
vi.mock('@/services/entitlement.service', () => ({ entitlementStatus: spies.entitlementStatus }));

import { GET } from './route';

const USER = 'user-1';

function request(): NextRequest {
  return new Request('https://jamee.test/api/profile/access') as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.currentUserId.mockResolvedValue(USER);
  spies.isTelegramLinked.mockResolvedValue(true);
  spies.entitlementStatus.mockResolvedValue({ expiresAt: '2026-01-05T00:00:00.000Z', isActive: true });
});

describe('GET /api/profile/access', () => {
  it('returns the link state and entitlement window for the session farmer (21.20, 22.18)', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ isLinked: true, entitlement: { expiresAt: '2026-01-05T00:00:00.000Z', isActive: true } });
    // No raw telegram id is exposed — only the boolean.
    expect(JSON.stringify(body)).not.toMatch(/telegramUserId/);
  });

  it('no session ⇒ 401 and no reads (1.7)', async () => {
    spies.currentUserId.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(spies.isTelegramLinked).not.toHaveBeenCalled();
    expect(spies.entitlementStatus).not.toHaveBeenCalled();
  });
});
