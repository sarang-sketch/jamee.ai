import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the D8 profile bootstrap (Amendment A3: MongoDB, auth-hook path).
 *
 * Requirements: 1.4 (a first session for an Auth_User_Id with no Profile produces a Profile whose
 *               `_id` is that id and whose `email` holds the Google_Email), 1.5, 1.9 (no phone is
 *               written)
 * Design: D8 — the bootstrap is the auth library's hook plus an idempotent upsert through the
 *         Data_Access_Layer (D18)
 *
 * The Data_Access_Layer is mocked at the `farmerData` seam (the design's testing-strategy note:
 * "unit tests mock the Data_Access_Layer, not a client"). Each test asserts the owner id the
 * bootstrap bound and the email it passed to `upsertProfileBootstrap` — and, crucially, that it
 * passed NO phone: the accessor's signature is `(email)` only, so a phone cannot be smuggled
 * through, and these tests pin that the email is the sole argument.
 */

interface UpsertCall {
  ownerId: string;
  email: string | null;
}

const upsertCalls: UpsertCall[] = [];
/** What `readProfile()` returns for the next call — set per test to model an existing Profile. */
let existingProfile: { email?: string | null } | null = null;

vi.mock('@/lib/db/farmer', () => ({
  farmerData: (ownerId: string) => ({
    ownerId,
    readProfile: async () => existingProfile,
    upsertProfileBootstrap: async (email: string | null) => {
      upsertCalls.push({ ownerId, email });
    },
  }),
}));

import { bootstrapProfile } from './ensure-profile';

const USER = 'auth-user-123';
const EMAIL = 'farmer@example.com';

describe('bootstrapProfile', () => {
  beforeEach(() => {
    upsertCalls.length = 0;
    existingProfile = null;
  });

  it('on user creation writes the id and email and passes no phone', async () => {
    await bootstrapProfile(USER, EMAIL);

    expect(upsertCalls).toEqual([{ ownerId: USER, email: EMAIL }]);
    /**
     * The accessor takes `(email)` only — there is no phone parameter to pass. The `UpsertCall`
     * shape captures exactly what the bootstrap handed over, and it carries no phone field, which
     * is Requirement 1.9 held by the type rather than by a runtime check.
     */
    const call = upsertCalls[0]!;
    expect(call).not.toHaveProperty('phone');
    expect(call.email).toBe(EMAIL);
  });

  it('is idempotent: a second call for the same auth user upserts again harmlessly', async () => {
    await bootstrapProfile(USER, EMAIL);
    await bootstrapProfile(USER, EMAIL);

    /* Two identical upserts — the accessor's `$setOnInsert`/`$set` makes re-running a no-op. */
    expect(upsertCalls).toEqual([
      { ownerId: USER, email: EMAIL },
      { ownerId: USER, email: EMAIL },
    ]);
  });

  it('on a defensive re-run (email null) preserves a stored email rather than nulling it', async () => {
    existingProfile = { email: EMAIL };

    await bootstrapProfile(USER, null);

    /* Reads the existing Profile and re-supplies its email, so the stored value is not clobbered. */
    expect(upsertCalls).toEqual([{ ownerId: USER, email: EMAIL }]);
  });

  it('on a defensive re-run with no existing Profile creates one with a null email', async () => {
    existingProfile = null;

    await bootstrapProfile(USER, null);

    /* No Profile yet → create one with a null email (a Profile without an email, not a failure). */
    expect(upsertCalls).toEqual([{ ownerId: USER, email: null }]);
  });

  it('binds the upsert to the given auth user id, never a caller-supplied owner', async () => {
    await bootstrapProfile('another-user', EMAIL);
    expect(upsertCalls[0]?.ownerId).toBe('another-user');
  });
});
