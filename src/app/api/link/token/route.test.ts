import type { NextRequest } from 'next/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wiring tests for `src/app/api/link/token/route.ts`.
 *
 * Requirements: 1.7 (no session ⇒ 401, nothing minted/unlinked), 21.1 (mint is an action ⇒ 201),
 *               21.15 (unlink ⇒ 204)
 *
 * Boundary facts: the mint/unlink run for the SESSION farmer (never a body id), a POST returns the
 * deep link at 201, a DELETE returns 204, and a missing session refuses at 401 before the service.
 */

const spies = vi.hoisted(() => ({ currentUserId: vi.fn(), mintLinkToken: vi.fn(), unlink: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ currentUserId: spies.currentUserId }));
vi.mock('@/services/linking.service', () => ({ mintLinkToken: spies.mintLinkToken, unlink: spies.unlink }));

import { POST, DELETE } from './route';

const USER = 'user-1';

function request(method: string): NextRequest {
  return new Request('https://jamee.test/api/link/token', { method }) as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.currentUserId.mockResolvedValue(USER);
  spies.mintLinkToken.mockRejectedValue(new Error('tripwire: mint reached for a refused request'));
  spies.unlink.mockRejectedValue(new Error('tripwire: unlink reached for a refused request'));
});

describe('POST /api/link/token', () => {
  it('mints for the session farmer and returns the deep link at 201', async () => {
    spies.mintLinkToken.mockResolvedValue({ deepLink: 'https://t.me/b?start=abc', expiresAt: '2026-01-01T00:00:00.000Z' });
    const response = await POST(request('POST'));
    expect(response.status).toBe(201);
    expect(spies.mintLinkToken).toHaveBeenCalledWith(USER);
    expect(await response.json()).toEqual({ deepLink: 'https://t.me/b?start=abc', expiresAt: '2026-01-01T00:00:00.000Z' });
  });

  it('no session ⇒ 401 and nothing minted (1.7)', async () => {
    spies.currentUserId.mockResolvedValue(null);
    const response = await POST(request('POST'));
    expect(response.status).toBe(401);
    expect(spies.mintLinkToken).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/link/token', () => {
  it('unlinks the session farmer and returns 204 (21.15)', async () => {
    spies.unlink.mockResolvedValue(undefined);
    const response = await DELETE(request('DELETE'));
    expect(response.status).toBe(204);
    expect(spies.unlink).toHaveBeenCalledWith(USER);
  });

  it('no session ⇒ 401 and nothing unlinked (1.7)', async () => {
    spies.currentUserId.mockResolvedValue(null);
    const response = await DELETE(request('DELETE'));
    expect(response.status).toBe(401);
    expect(spies.unlink).not.toHaveBeenCalled();
  });
});
