import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Unit test for `ProfileAccessCards` — the client wrapper that composes the two access cards and
 * supplies `router.refresh()` as their `onChanged`. A static render confirms both cards mount from
 * one server-supplied read (Requirements 21.20, 22.18); the refresh callback is a client-only
 * effect the route/integration layers already exercise.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/env.public', () => ({ razorpayPublicKeyId: () => 'rzp_test_key' }));

import { ProfileAccessCards } from '@/components/ProfileAccessCards';
import { messages } from '@/lib/messages';

describe('ProfileAccessCards', () => {
  it('renders both the link card and the recharge card from one read', () => {
    const html = renderToStaticMarkup(
      <ProfileAccessCards botUsername="jamee_bot" isLinked={false} entitlement={{ expiresAt: null, isActive: false }} language="en" />,
    );
    const { access } = messages('en');
    expect(html).toContain(access.linkHeading);
    expect(html).toContain(access.rechargeHeading);
  });
});
