import { describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the Google sign-in control's one decision.
 *
 * Requirements: 1.1 (activating the control starts authentication with Google as the provider),
 *               1.3 (a sign-in that does not complete is reported)
 * Design: "Frontend"; D8, D18a; V30
 *
 * The DOM half of the button (the disabled state, the `role="alert"` message) is left to the
 * accessibility pass rather than faked, exactly as `SignInForm.test.tsx` leaves its DOM to the
 * manual plan. What is asserted here is the substantive contract the task names: the control calls
 * `signIn.social` EXACTLY ONCE with `provider: 'google'`, and maps the outcomes to Requirement
 * 1.3. The browser auth client is mocked so no real flow starts.
 */

vi.mock('@/lib/auth/auth-client', () => ({ authClient: { signIn: { social: vi.fn() } } }));

import { startGoogleSignIn, type SocialSignInClient } from './GoogleSignInButton';

function stubClient(
  social: SocialSignInClient['signIn']['social'],
): { client: SocialSignInClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const wrapped: SocialSignInClient['signIn']['social'] = (input) => {
    calls.push(input);
    return social(input);
  };
  return { client: { signIn: { social: wrapped } }, calls };
}

describe('startGoogleSignIn', () => {
  it('calls signIn.social exactly once with provider google and callbackURL /diagnose', async () => {
    const { client, calls } = stubClient(async () => undefined);

    const outcome = await startGoogleSignIn(client);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'google', callbackURL: '/diagnose' });
    expect(outcome).toBe('ok');
  });

  it('reports failure when the client resolves with an error (Requirement 1.3)', async () => {
    const { client, calls } = stubClient(async () => ({ error: { message: 'cancelled' } }));

    const outcome = await startGoogleSignIn(client);

    expect(calls).toHaveLength(1);
    expect(outcome).toBe('failed');
  });

  it('reports failure when the client throws before the flow starts (Requirement 1.3)', async () => {
    const { client, calls } = stubClient(async () => {
      throw new Error('sdk could not start');
    });

    const outcome = await startGoogleSignIn(client);

    expect(calls).toHaveLength(1);
    expect(outcome).toBe('failed');
  });

  it('names no provider other than google', async () => {
    const { client, calls } = stubClient(async () => undefined);
    await startGoogleSignIn(client);
    expect((calls[0] as { provider: string }).provider).toBe('google');
  });
});
