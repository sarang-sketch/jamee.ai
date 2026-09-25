import { describe, expect, it } from 'vitest';

import {
  LINK_TOKEN_TTL_MINUTES,
  RECHARGE_CURRENCY,
  RECHARGE_PERIOD_DAYS,
  RECHARGE_PRICE_PAISE,
  RECHARGE_PRICE_RUPEES,
  isEntitlementActive,
  nextExpiry,
} from './access';

/**
 * Requirements: 21.4 (Link_Token expiry is a compile-time constant), 22.4 (the recharge price is a
 *               compile-time constant in one place)
 * Design: Amendment A2 decisions 1 and 3 (the price, the period, and the extension arithmetic)
 *
 * The arithmetic tests are the point of this file. A price constant is hard to get wrong; an
 * extension rule that silently forfeits days a farmer already paid for is easy to get wrong, and it
 * is wrong in the direction that takes money without giving access.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('the recharge price and period', () => {
  it('states the price in whole rupees and in the paise the provider takes', () => {
    expect(RECHARGE_PRICE_RUPEES).toBe(20);
    // Derived, not a second literal: a provider handed rupees where it expects minor units charges
    // one hundredth of the intended amount, and the payment still succeeds.
    expect(RECHARGE_PRICE_PAISE).toBe(2000);
    expect(RECHARGE_PRICE_PAISE).toBe(RECHARGE_PRICE_RUPEES * 100);
  });

  it('buys seven days and names an explicit currency', () => {
    expect(RECHARGE_PERIOD_DAYS).toBe(7);
    expect(RECHARGE_CURRENCY).toBe('INR');
  });

  it('expires a link token in minutes rather than days', () => {
    // D13: the token's lifetime is the window in which a leaked deep link is still a binding.
    expect(LINK_TOKEN_TTL_MINUTES).toBeGreaterThan(0);
    expect(LINK_TOKEN_TTL_MINUTES).toBeLessThanOrEqual(60);
  });
});

describe('nextExpiry: a recharge extends from the later of now and the current expiry', () => {
  const now = new Date('2026-03-01T10:00:00.000Z');

  it('starts at now for a farmer who has never recharged', () => {
    expect(nextExpiry(now, null).toISOString()).toBe('2026-03-08T10:00:00.000Z');
  });

  it('starts at now for a farmer whose window has already lapsed', () => {
    const lapsed = new Date('2026-02-20T10:00:00.000Z');
    // Not lapsed + 7 days, which would hand back days already gone.
    expect(nextExpiry(now, lapsed).toISOString()).toBe('2026-03-08T10:00:00.000Z');
  });

  it('stacks on the existing expiry when a farmer recharges early', () => {
    const threeDaysLeft = new Date('2026-03-04T10:00:00.000Z');
    // The whole point of the maximum: the three unused days survive rather than being forfeited.
    expect(nextExpiry(now, threeDaysLeft).toISOString()).toBe('2026-03-11T10:00:00.000Z');
  });

  it('treats an expiry exactly at now as lapsed rather than as credit', () => {
    expect(nextExpiry(now, new Date(now)).toISOString()).toBe('2026-03-08T10:00:00.000Z');
  });

  it('never returns less than a full period from now, for any current expiry', () => {
    const offsetsInDays = [-365, -30, -7, -1, 0, 1, 7, 30, 365];
    for (const offset of offsetsInDays) {
      const current = new Date(now.getTime() + offset * MS_PER_DAY);
      const result = nextExpiry(now, current).getTime();
      // A farmer always gets at least the period they paid for, whatever state they were in.
      expect(result).toBeGreaterThanOrEqual(now.getTime() + RECHARGE_PERIOD_DAYS * MS_PER_DAY);
      // And never more than their remaining time plus the period, so it cannot over-credit either.
      expect(result).toBeLessThanOrEqual(
        Math.max(now.getTime(), current.getTime()) + RECHARGE_PERIOD_DAYS * MS_PER_DAY,
      );
    }
  });

  it('is monotonic: a later existing expiry never yields an earlier new expiry', () => {
    const earlier = nextExpiry(now, new Date(now.getTime() + 2 * MS_PER_DAY)).getTime();
    const later = nextExpiry(now, new Date(now.getTime() + 5 * MS_PER_DAY)).getTime();
    expect(later).toBeGreaterThan(earlier);
  });
});

describe('isEntitlementActive: one predicate for the gate and for the web status', () => {
  const now = new Date('2026-03-01T10:00:00.000Z');

  it('denies access with no entitlement at all', () => {
    // A farmer with no row and a farmer with a row carrying no expiry are both unentitled.
    expect(isEntitlementActive(null, now)).toBe(false);
  });

  it('denies access on a lapsed window', () => {
    expect(isEntitlementActive(new Date(now.getTime() - 1), now)).toBe(false);
  });

  it('denies access at the exact instant of expiry', () => {
    // The boundary is stated rather than left to chance: expiry means expired.
    expect(isEntitlementActive(new Date(now), now)).toBe(false);
  });

  it('grants access while the window is still open', () => {
    expect(isEntitlementActive(new Date(now.getTime() + 1), now)).toBe(true);
    expect(isEntitlementActive(nextExpiry(now, null), now)).toBe(true);
  });
});