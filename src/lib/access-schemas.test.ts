import { describe, expect, it } from 'vitest';

import {
  BIND_OUTCOME_KINDS,
  bindOutcomeKindSchema,
  entitlementStatusSchema,
  linkTokenResponseSchema,
  paymentOrderResponseSchema,
  profileAccessSchema,
} from '@/lib/access-schemas';

/**
 * Unit tests for `src/lib/access-schemas.ts` — the Zod contracts for linking, payment, and the
 * entitlement window. These are the shapes the routes validate and the client cards type against,
 * so a drift between the two would break silently without these.
 *
 * Requirements: 21.6, 21.8 (the deep-link and the collapsed invalid variant), 22.2 (only the four
 *               checkout fields), 22.18 (the entitlement window shape)
 */

describe('linkTokenResponseSchema', () => {
  it('accepts a t.me deep link and an ISO expiry', () => {
    const ok = linkTokenResponseSchema.safeParse({
      deepLink: 'https://t.me/jamee_bot?start=abc',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    expect(ok.success).toBe(true);
  });
  it('rejects a non-URL deep link and a non-ISO expiry', () => {
    expect(linkTokenResponseSchema.safeParse({ deepLink: 'not a url', expiresAt: '2026-01-01T00:00:00.000Z' }).success).toBe(false);
    expect(linkTokenResponseSchema.safeParse({ deepLink: 'https://t.me/b?start=a', expiresAt: 'soon' }).success).toBe(false);
  });
});

describe('bindOutcomeKindSchema', () => {
  it('collapses unknown/expired/consumed into ONE `invalid` variant (21.8)', () => {
    // There is exactly one negative variant — not three — so the bot cannot be a validity oracle.
    expect(BIND_OUTCOME_KINDS).toContain('invalid');
    expect(BIND_OUTCOME_KINDS).not.toContain('unknown');
    expect(BIND_OUTCOME_KINDS).not.toContain('expired');
    expect(BIND_OUTCOME_KINDS).not.toContain('consumed');
  });
  it('names the four positive variants and invalid', () => {
    expect([...BIND_OUTCOME_KINDS].sort()).toEqual(
      ['already_linked', 'already_linked_elsewhere', 'bound', 'invalid', 'replaced'],
    );
    for (const kind of BIND_OUTCOME_KINDS) expect(bindOutcomeKindSchema.safeParse(kind).success).toBe(true);
  });
});

describe('paymentOrderResponseSchema', () => {
  it('accepts exactly the four checkout identifiers (22.2)', () => {
    const ok = paymentOrderResponseSchema.safeParse({ orderId: 'ord_1', keyId: 'rzp_test', amountMinor: 2000, currency: 'INR' });
    expect(ok.success).toBe(true);
  });
  it('rejects a non-positive amount', () => {
    expect(paymentOrderResponseSchema.safeParse({ orderId: 'o', keyId: 'k', amountMinor: 0, currency: 'INR' }).success).toBe(false);
  });
});

describe('entitlementStatusSchema / profileAccessSchema', () => {
  it('a null expiry is a valid inactive window', () => {
    expect(entitlementStatusSchema.safeParse({ expiresAt: null, isActive: false }).success).toBe(true);
  });
  it('an active window carries an ISO expiry', () => {
    expect(entitlementStatusSchema.safeParse({ expiresAt: '2026-01-05T00:00:00.000Z', isActive: true }).success).toBe(true);
  });
  it('profileAccess pairs the link flag with the entitlement window', () => {
    const ok = profileAccessSchema.safeParse({ isLinked: true, entitlement: { expiresAt: null, isActive: false } });
    expect(ok.success).toBe(true);
  });
});
