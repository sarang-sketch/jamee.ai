import { describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the server session module.
 *
 * Requirements: 1.5 (the Auth_User_Id is the single identity), 1.6 (a signed-out visitor is sent
 *               to the sign-in screen), 1.7 (the API gate reads this)
 * Design: D8, D18a; V30 (`auth.api.getSession` returns `null` when signed out)
 *
 * `getAuth`, `headers`, and `redirect` are mocked at their seams so the two functions can be driven
 * with "signed in" and "signed out" without a real request. `requireFarmer`'s redirect is modelled
 * by a thrown sentinel, because `next/navigation`'s `redirect` throws to unwind a render.
 */

let sessionResult: { user: { id: string } } | null = null;

vi.mock('@/lib/auth/auth', () => ({
  getAuth: () => ({
    api: {
      getSession: async () => sessionResult,
    },
  }),
  SIGN_IN_CALLBACK_URL: '/diagnose',
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

import { currentUserId, requireFarmer } from './session';

describe('currentUserId', () => {
  it('returns the user id when a session exists', async () => {
    sessionResult = { user: { id: 'auth-user-1' } };
    expect(await currentUserId()).toBe('auth-user-1');
  });

  it('returns null when there is no session', async () => {
    sessionResult = null;
    expect(await currentUserId()).toBeNull();
  });
});

describe('requireFarmer', () => {
  it('returns the user id when signed in', async () => {
    sessionResult = { user: { id: 'auth-user-2' } };
    expect(await requireFarmer()).toBe('auth-user-2');
  });

  it('redirects to the sign-in screen when signed out', async () => {
    sessionResult = null;
    await expect(requireFarmer()).rejects.toBeInstanceOf(RedirectSignal);
    await expect(requireFarmer()).rejects.toMatchObject({ to: '/' });
  });
});
