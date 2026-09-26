import type { NextRequest } from 'next/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wiring tests for `src/app/api/profile/route.ts`.
 *
 * Requirements: 1.7 (no session ⇒ 401), 1.8 (both values persisted on the session Farmer's row),
 *               9.5 (an unsupported language ⇒ 400), 13.2 (own-row only — the write goes through the
 *               session-bound `farmerData`)
 *
 * Boundary facts: the route resolves the farmer from the session (never the body), writes exactly
 * displayName + language through the DAL, returns the stored pair, and refuses without a session.
 */

const spies = vi.hoisted(() => ({ currentUserId: vi.fn(), setProfileFields: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ currentUserId: spies.currentUserId }));
vi.mock('@/lib/db/farmer', () => ({ farmerData: (ownerId: string) => ({ ownerId, setProfileFields: spies.setProfileFields }) }));

import { POST } from './route';

const USER = 'user-1';

function request(body: unknown, raw?: string): NextRequest {
  return new Request('https://jamee.test/api/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  }) as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.currentUserId.mockResolvedValue(USER);
  spies.setProfileFields.mockResolvedValue(undefined);
});

describe('POST /api/profile', () => {
  it('persists exactly displayName + language for the session farmer and echoes the stored pair (1.8)', async () => {
    const response = await POST(request({ displayName: '  Asha ', language: 'hi' }));
    expect(response.status).toBe(200);
    expect(spies.setProfileFields).toHaveBeenCalledTimes(1);
    expect(spies.setProfileFields).toHaveBeenCalledWith({ displayName: 'Asha', language: 'hi' });
    expect(await response.json()).toEqual({ displayName: 'Asha', language: 'hi' });
  });

  it('an unsupported language ⇒ 400 and no write (9.5)', async () => {
    const response = await POST(request({ displayName: 'Asha', language: 'de' }));
    expect(response.status).toBe(400);
    expect(spies.setProfileFields).not.toHaveBeenCalled();
  });

  it('a non-JSON body ⇒ 400 and no write', async () => {
    const response = await POST(request(undefined, 'not json'));
    expect(response.status).toBe(400);
    expect(spies.setProfileFields).not.toHaveBeenCalled();
  });

  it('no session ⇒ 401 and no write (1.7)', async () => {
    spies.currentUserId.mockResolvedValue(null);
    const response = await POST(request({ displayName: 'Asha', language: 'hi' }));
    expect(response.status).toBe(401);
    expect(spies.setProfileFields).not.toHaveBeenCalled();
  });
});
