import * as fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { COLLECTIONS, type ProfileDoc } from '@/lib/db/collections';
import type { Language } from '@/lib/schemas';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from '../integration/mongo';

/**
 * **Property 1: Identity round-trip across channels**
 *
 * > For any user record the authentication library establishes, after a first authenticated session
 * > through Google sign-in, a Profile exists in `profiles` whose `_id` equals that Auth_User_Id and
 * > whose `email` equals the Google_Email, written by the Data_Access_Layer's idempotent bootstrap
 * > upsert; for any Telegram user id bound to that Profile, resolving it through
 * > `profiles.telegram_user_id` the way an inbound update resolves its sender returns that same
 * > Profile, and a Telegram user id on no Profile resolves to no Profile at all; at most one Profile
 * > carries any given Telegram user id (the partial unique index); and for any display name and
 * > supported language written, reading it back returns the same values. No phone value takes part
 * > in any resolution, and the bootstrap stores none.
 *
 * **Validates: Requirements 1.4, 1.5, 1.8, 1.9, 10.2, 21.16**
 *
 * This file also carries the IDENTITY-scoped slices of two properties whose full statements live in
 * their own owned files (`tenant-isolation.property.test.ts`, `chat-context.property.test.ts`):
 *  - **Property 27** (tenant isolation) — the identity slice: resolving one farmer's Telegram id
 *    never returns another farmer's Profile, and the partial-unique index forbids two Profiles
 *    sharing a Telegram id.
 *  - **Property 15** (conversation context isolation) — the identity slice: a Telegram sender only
 *    ever resolves to its OWN Profile, which is the identity precondition the context assembly
 *    relies on to keep one farmer's conversation out of another's.
 *
 * =============================================================================
 * A1/A3 RESTATEMENT — HOW THIS PROPERTY GOT ITS CURRENT SHAPE
 * =============================================================================
 *
 * The ORIGINAL Property 1 was stated over "any valid E.164 phone number" and resolving a sender by
 * phone; Amendment A1 (D8) removed phone identity entirely and re-stated it over the Auth_User_Id
 * plus `profiles.telegram_user_id`. Amendment A3 then moved the substrate from Postgres to MongoDB:
 * the Profile is a `profiles` document keyed by `_id = Auth_User_Id`, the bootstrap is the
 * Data_Access_Layer's `upsertProfileBootstrap`, the telegram resolution is
 * `resolveProfileByTelegramUserId`, and "at most one Profile per Telegram id" is a **partial unique
 * index** on `telegram_user_id` rather than a Postgres `UNIQUE` constraint.
 *
 * Because the claim rests on the bootstrap upsert, the resolution read, AND a real unique index —
 * all facts of the Data_Access_Layer under A3 — this runs against the real layer on
 * tests/integration/mongo.ts per the brief, at numRuns ≈ 25. No phone appears anywhere below,
 * which is itself part of the claim (Requirement 1.9).
 */

let harness: MongoHarness | undefined;
type Farmer = typeof import('@/lib/db/farmer');
type Bootstrap = typeof import('@/lib/auth/bootstrap');

let farmer: Farmer;
let bootstrap: Bootstrap;
let setupDatabase: typeof import('@/lib/db/setup').setupDatabase;

const REAL_LAYER_RUNS = 25;
const LANGUAGES: readonly Language[] = ['en', 'hi', 'mr'];

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  farmer = await import('@/lib/db/farmer');
  bootstrap = await import('@/lib/auth/bootstrap');
  ({ setupDatabase } = await import('@/lib/db/setup'));
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  if (harness) await clearDatabase(harness.db);
});

function db() {
  if (harness === undefined) throw new Error('harness not started');
  return harness.db;
}

async function profileOf(userId: string): Promise<ProfileDoc | null> {
  return db().collection<ProfileDoc>(COLLECTIONS.profiles).findOne({ _id: userId });
}

/** Bind a Telegram id onto a Profile the way the linking bind does — directly, for this identity test. */
async function bindTelegram(userId: string, telegramUserId: number): Promise<void> {
  await db()
    .collection<ProfileDoc>(COLLECTIONS.profiles)
    .updateOne({ _id: userId }, { $set: { telegramUserId, updatedAt: new Date() } });
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

/** An Auth_User_Id as the auth library would emit — an opaque non-empty string. */
const authUserIdArb = fc.string({ minLength: 6, maxLength: 40 }).map((s) => `auth_${s.replace(/\s/g, '_')}`);
const emailArb = fc
  .tuple(fc.string({ minLength: 1, maxLength: 12 }), fc.constantFrom('example.test', 'mail.test'))
  .map(([local, domain]) => `${local.replace(/[^a-z0-9]/gi, 'x') || 'x'}@${domain}`);
const telegramIdArb = fc.integer({ min: 1, max: 2_000_000_000 });

/* ========================================================================== */
/* Property 1                                                                  */
/* ========================================================================== */

describe('Property 1: identity round-trip across channels', () => {
  it('bootstrap creates a Profile keyed by the Auth_User_Id with the Google email, and no phone', async () => {
    await fc.assert(
      fc.asyncProperty(authUserIdArb, emailArb, async (userId, email) => {
        await clearDatabase(db());
        await bootstrap.bootstrapProfile(userId, email);

        const profile = await profileOf(userId);
        expect(profile, 'a Profile must exist after the first session').not.toBeNull();
        expect(profile?._id).toBe(userId);
        expect(profile?.email).toBe(email);
        // No phone is written by the bootstrap (Requirement 1.9).
        expect(profile?.phone ?? null).toBeNull();
        // Default language is a supported one.
        expect(LANGUAGES).toContain(profile?.language);
      }),
      { numRuns: REAL_LAYER_RUNS },
    );
  });

  it('the bootstrap is idempotent and a defensive re-run never clobbers the stored email', async () => {
    await fc.assert(
      fc.asyncProperty(authUserIdArb, emailArb, async (userId, email) => {
        await clearDatabase(db());
        await bootstrap.bootstrapProfile(userId, email);
        // A defensive re-run passing null must PRESERVE the stored email (D8).
        await bootstrap.bootstrapProfile(userId, null);
        const profile = await profileOf(userId);
        expect(profile?.email).toBe(email);
        // Still exactly one Profile.
        expect(await db().collection<ProfileDoc>(COLLECTIONS.profiles).countDocuments({ _id: userId })).toBe(1);
      }),
      { numRuns: REAL_LAYER_RUNS },
    );
  });

  it('a bound Telegram id resolves to its Profile; an unbound id resolves to no Profile', async () => {
    await fc.assert(
      fc.asyncProperty(authUserIdArb, emailArb, telegramIdArb, async (userId, email, tgId) => {
        await clearDatabase(db());
        await bootstrap.bootstrapProfile(userId, email);

        // Before binding, the id resolves to nothing.
        expect(await farmer.resolveProfileByTelegramUserId(tgId)).toBeNull();

        await bindTelegram(userId, tgId);

        // After binding, resolution returns exactly this Profile — the way an inbound update does.
        const resolved = await farmer.resolveProfileByTelegramUserId(tgId);
        expect(resolved?._id).toBe(userId);
        expect(resolved?.telegramUserId).toBe(tgId);

        // A DIFFERENT, unbound id still resolves to nothing (no phone, no other route).
        const otherId = tgId === 1 ? 2 : tgId - 1;
        expect(await farmer.resolveProfileByTelegramUserId(otherId)).toBeNull();
      }),
      { numRuns: REAL_LAYER_RUNS },
    );
  });

  it('display name and language round-trip through the Data_Access_Layer', async () => {
    await fc.assert(
      fc.asyncProperty(
        authUserIdArb,
        emailArb,
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.constantFrom<Language>(...LANGUAGES),
        async (userId, email, displayName, language) => {
          await clearDatabase(db());
          await bootstrap.bootstrapProfile(userId, email);
          await farmer.farmerData(userId).setProfileFields({ displayName, language });

          const profile = await farmer.farmerData(userId).readProfile();
          expect(profile?.displayName).toBe(displayName);
          expect(profile?.language).toBe(language);
          // The email survived the profile-field write.
          expect(profile?.email).toBe(email);
          // Still no phone.
          expect(profile?.phone ?? null).toBeNull();
        },
      ),
      { numRuns: REAL_LAYER_RUNS },
    );
  });
});

/* ========================================================================== */
/* Property 27 / 15 — the identity slice                                       */
/* ========================================================================== */

describe('Property 27 (identity slice): at most one Profile carries any Telegram id, and resolution is isolated', () => {
  it('the partial unique index forbids a second Profile from taking a bound Telegram id', async () => {
    await fc.assert(
      fc.asyncProperty(telegramIdArb, async (tgId) => {
        await clearDatabase(db());
        await bootstrap.bootstrapProfile('farmer-1', 'one@example.test');
        await bootstrap.bootstrapProfile('farmer-2', 'two@example.test');
        await bindTelegram('farmer-1', tgId);

        // A direct attempt to give farmer-2 the SAME id must be refused by the unique index.
        let refused = false;
        try {
          await db()
            .collection<ProfileDoc>(COLLECTIONS.profiles)
            .updateOne({ _id: 'farmer-2' }, { $set: { telegramUserId: tgId, updatedAt: new Date() } });
        } catch (error) {
          refused = farmer.isDuplicateKeyError(error);
        }
        expect(refused, 'the partial unique telegram index must reject a duplicate id').toBe(true);

        // Resolution still returns farmer-1 and only farmer-1.
        const resolved = await farmer.resolveProfileByTelegramUserId(tgId);
        expect(resolved?._id).toBe('farmer-1');
        expect((await profileOf('farmer-2'))?.telegramUserId ?? null).toBeNull();
      }),
      { numRuns: REAL_LAYER_RUNS },
    );
  });

  it('two farmers with distinct Telegram ids each resolve to their own Profile only (Property 15 identity slice)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(telegramIdArb, telegramIdArb).filter(([a, b]) => a !== b),
        async ([tgA, tgB]) => {
          await clearDatabase(db());
          await bootstrap.bootstrapProfile('farmer-A', 'a@example.test');
          await bootstrap.bootstrapProfile('farmer-B', 'b@example.test');
          await bindTelegram('farmer-A', tgA);
          await bindTelegram('farmer-B', tgB);

          expect((await farmer.resolveProfileByTelegramUserId(tgA))?._id).toBe('farmer-A');
          expect((await farmer.resolveProfileByTelegramUserId(tgB))?._id).toBe('farmer-B');
        },
      ),
      { numRuns: REAL_LAYER_RUNS },
    );
  });
});
