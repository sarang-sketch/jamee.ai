import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Unit tests for the optimistic proxy redirect.
 *
 * Requirements: 1.6 (a signed-out visitor on a protected screen gets the sign-in screen)
 * Design: "Security boundary" — defence in depth; D18a; V30 (`getSessionCookie` = cookie-existence
 *         only, real validation in each page)
 *
 * `getSessionCookie` is mocked at the `better-auth/cookies` seam so the test controls "cookie
 * present" vs "cookie absent" without a real session. The claims under test are exactly the two
 * the task names: a protected path with no session cookie redirects to `/`, and a protected path
 * with a session cookie passes through. Plus the invariants that keep the two halves of the gate
 * from colliding — `/api/**` and unprotected paths are never redirected.
 */

let cookiePresent = false;

vi.mock('better-auth/cookies', () => ({
  getSessionCookie: () => (cookiePresent ? 'a-session-cookie-value' : null),
}));

import { proxy } from './proxy';

function request(path: string): NextRequest {
  return new NextRequest(new URL(`https://jamee.test${path}`));
}

describe('proxy optimistic redirect', () => {
  beforeEach(() => {
    cookiePresent = false;
  });

  it('redirects a protected path to the sign-in screen when no session cookie is present', () => {
    cookiePresent = false;
    const response = proxy(request('/diagnose'));

    /* A redirect carries 3xx + a Location header pointing at `/`. */
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    const location = response.headers.get('location');
    expect(location).not.toBeNull();
    expect(new URL(location!).pathname).toBe('/');
  });

  it('lets a protected path through when a session cookie is present', () => {
    cookiePresent = true;
    const response = proxy(request('/diagnose'));

    /* NextResponse.next() is a pass-through: no redirect, so no Location. */
    expect(response.headers.get('location')).toBeNull();
    expect(response.status).toBeLessThan(300);
  });

  it('redirects every protected screen prefix when signed out', () => {
    cookiePresent = false;
    for (const path of ['/diagnose', '/chat', '/voice', '/history', '/profile', '/diagnosis/abc']) {
      const response = proxy(request(path));
      expect(response.headers.get('location'), `expected ${path} to redirect`).not.toBeNull();
    }
  });

  it('never redirects an unprotected path even when signed out', () => {
    cookiePresent = false;
    for (const path of ['/', '/api/auth/callback/google']) {
      const response = proxy(request(path));
      expect(response.headers.get('location'), `expected ${path} to pass through`).toBeNull();
    }
  });

  it('carries no ?next= on the redirect', () => {
    cookiePresent = false;
    const response = proxy(request('/history'));
    const location = new URL(response.headers.get('location')!);
    expect(location.search).toBe('');
  });
});
