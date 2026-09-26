import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `src/services/entitlement.service.ts` with the Data_Access_Layer mocked.
 *
 * Requirements: 22.13 (the gate reads whether the window is still open), 22.18 (the card shows the
 *               window), 22.20 (keyed to the farmer, independent of the linked telegram account)
 * Design: D14; Amendment A2 decision 4 (the gate is "expiry in the future")
 *
 * The service reads the farmer's entitlement row and runs it through the ONE predicate
 * `isEntitlementActive` (real, pure) — so a null row and a past expiry are both inactive, and a
 * future expiry is active, on both the status read and the gate.
 */

const { readEntitlement } = vi.hoisted(() => ({ readEntitlement: vi.fn() }));

vi.mock('@/lib/db/access', () => ({
  accessData: (ownerId: string) => ({ ownerId, readEntitlement }),
}));

import { entitlementStatus, isActive } from '@/services/entitlement.service';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const FUTURE = new Date('2026-01-05T00:00:00.000Z');
const PAST = new Date('2025-12-01T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('entitlementStatus', () => {
  it('a future expiry is active, and the ISO expiry is echoed', async () => {
    readEntitlement.mockResolvedValue({ _id: 'A', expiresAt: FUTURE, providerPaymentId: 'p', grantedAt: PAST });
    const status = await entitlementStatus('farmer-A', NOW);
    expect(status).toEqual({ expiresAt: FUTURE.toISOString(), isActive: true });
  });

  it('a past expiry is inactive but still reported as the window', async () => {
    readEntitlement.mockResolvedValue({ _id: 'A', expiresAt: PAST, providerPaymentId: 'p', grantedAt: PAST });
    const status = await entitlementStatus('farmer-A', NOW);
    expect(status).toEqual({ expiresAt: PAST.toISOString(), isActive: false });
  });

  it('no entitlement row is a null window that is not active', async () => {
    readEntitlement.mockResolvedValue(null);
    const status = await entitlementStatus('farmer-A', NOW);
    expect(status).toEqual({ expiresAt: null, isActive: false });
  });
});

describe('isActive', () => {
  it('true only for a future window (22.13, A2 decision 4)', async () => {
    readEntitlement.mockResolvedValueOnce({ _id: 'A', expiresAt: FUTURE, providerPaymentId: 'p', grantedAt: PAST });
    expect(await isActive('farmer-A', NOW)).toBe(true);

    readEntitlement.mockResolvedValueOnce({ _id: 'A', expiresAt: PAST, providerPaymentId: 'p', grantedAt: PAST });
    expect(await isActive('farmer-A', NOW)).toBe(false);

    readEntitlement.mockResolvedValueOnce(null);
    expect(await isActive('farmer-A', NOW)).toBe(false);
  });
});
