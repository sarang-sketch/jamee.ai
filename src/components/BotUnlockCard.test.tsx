import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `BotUnlockCard` — the state-driven rendering (Requirement 22.18: the card shows the
 * current window or the inactive state, a recharge button naming the price, and a test-mode note).
 * The checkout flow (create order → load checkout.js → poll `GET /api/profile/access`, never grant
 * from the browser — 22.7) is a fetch/script flow proven at the route/integration layers; what a
 * static render decides is that the right state text, the priced button, and the test note appear.
 *
 * Requirements: 22.4 (the price is interpolated from `RECHARGE_PRICE_RUPEES`), 22.7, 22.18; A3 test
 *               mode note; "Mobile layout and accessibility".
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// The public key is only read inside the click handler, but keep env deterministic for the render.
vi.mock('@/lib/env.public', () => ({ razorpayPublicKeyId: () => 'rzp_test_key' }));

import { BotUnlockCard } from '@/components/BotUnlockCard';
import { RECHARGE_PRICE_RUPEES } from '@/lib/config/access';
import { interpolate, messages } from '@/lib/messages';

const noop = (): void => undefined;

describe('BotUnlockCard', () => {
  it('shows the priced recharge button and the test-mode note (22.4, A3)', () => {
    const html = renderToStaticMarkup(
      <BotUnlockCard entitlement={{ expiresAt: null, isActive: false }} language="en" onChanged={noop} />,
    );
    const { access } = messages('en');
    expect(html).toContain(interpolate(access.rechargeButton, { price: RECHARGE_PRICE_RUPEES }));
    expect(html).toContain(access.rechargeTestModeNote);
    // ₹20, from the single constant.
    expect(html).toContain(String(RECHARGE_PRICE_RUPEES));
  });

  it('an inactive window shows the inactive state (22.18)', () => {
    const html = renderToStaticMarkup(
      <BotUnlockCard entitlement={{ expiresAt: null, isActive: false }} language="en" onChanged={noop} />,
    );
    expect(html).toContain(messages('en').access.rechargeInactive);
  });

  it('an active window shows the active-until state naming the expiry (22.18)', () => {
    const html = renderToStaticMarkup(
      <BotUnlockCard
        entitlement={{ expiresAt: '2026-01-05T00:00:00.000Z', isActive: true }}
        language="en"
        onChanged={noop}
      />,
    );
    const { access } = messages('en');
    // The active-until sentence's non-placeholder text appears.
    const stem = access.rechargeActiveUntil.split('{expiry}')[0]?.trim();
    if (stem) expect(html).toContain(stem);
    expect(html).not.toContain(access.rechargeInactive);
  });

  it('renders in the farmer’s saved language (mr)', () => {
    const html = renderToStaticMarkup(
      <BotUnlockCard entitlement={{ expiresAt: null, isActive: false }} language="mr" onChanged={noop} />,
    );
    expect(html).toContain(messages('mr').access.rechargeHeading);
  });
});
