import { randomUUID } from 'node:crypto';

import type { Db } from 'mongodb';

import type { ProfileDoc } from '@/lib/db/collections';
import { COLLECTIONS } from '@/lib/db/names';
import type { Language } from '@/lib/schemas';

/**
 * A farmer, as Amendment A3 mints one: an Auth_User_Id the auth library assigns, a Google email,
 * and a Profile the D8 bootstrap wrote — and NO phone.
 *
 * Requirements: 1.4 (a first session for an Auth_User_Id with no Profile produces a Profile whose
 *               `_id` is that id and whose `email` holds the Google_Email), 1.9 (no phone is
 *               written, and phone takes part in no identity resolution), 13.1, 13.2 (each farmer
 *               reaches only their own documents — proven by the tenant-isolation scenarios, which
 *               need TWO farmers)
 * Design: D8 (profile creation = the auth library's user-created hook PLUS an idempotent
 *         server-side upsert through the Data_Access_Layer), D18 (the Data_Access_Layer is the
 *         isolation boundary that replaced RLS), Amendment A3
 *
 * =============================================================================
 * WHAT CHANGED FROM THE SUPABASE HARNESS, AND WHY
 * =============================================================================
 *
 * The retired harness minted an RLS-scoped SESSION: it created an `auth.users` row, signed in with
 * a password, and handed back a `SupabaseClient` whose every statement carried a JWT so Postgres's
 * RLS decided the outcome. Under A3 there is no RLS and no session-bearing client — tenant
 * isolation is the Data_Access_Layer (D18), and a farmer is just an Auth_User_Id that the
 * owner-scoped accessors merge into every query. So a "farmer" here is a string id plus the
 * documents a first Google sign-in leaves behind, and a scenario proves isolation by asking through
 * `farmerData(theOtherFarmer.id)` and asserting zero documents — not by minting a second JWT.
 *
 * =============================================================================
 * THE GOOGLE PATH, AS FAR AS IT MATTERS TO THE DATA
 * =============================================================================
 *
 * A real first sign-in does two things (D8): the auth library writes its own `user` (and Google
 * `account`) records, and the D8 hook runs `bootstrapProfile`, which upserts the Profile through
 * the Data_Access_Layer. The auth library owns the `user`/`account` collections (they are not in
 * `scripts/db-setup.ts` — see `auth-adapter.ts`), so this fixture writes plausible `user` and
 * Google `account` documents directly (there is no in-process Better Auth server to drive without a
 * browser), then runs the SAME `bootstrapProfile` the hook runs, so the Profile row is written by
 * production code and keyed by the same Auth_User_Id. That is the "or the same documents the
 * bootstrap writes" path the task's brief allows, and it keeps every later assertion about the
 * Profile an assertion about `bootstrapProfile`, not about the fixture.
 *
 * **The email is identity here, and the phone is absent by construction.** Under A3 the Profile's
 * `email` holds the Google_Email (1.4) and there is NO phone column written (1.9) — the fixture
 * never sets one, and `bootstrapProfile` never writes one, so a phone-reader check has nothing to
 * find.
 */
export interface TestFarmer {
  /** The Auth_User_Id — `user._id` and `profiles._id`, and the tenant anchor of every owned row. */
  readonly id: string;
  /** The Google email the Profile carries (1.4). Identity here; there is no phone. */
  readonly email: string;
  /** The farmer's language, as stored on the Profile (defaults to `en`). */
  readonly language: Language;
}

export interface CreateFarmerOptions {
  /** The Profile language written after the bootstrap. Defaults to the column default, `en`. */
  readonly language?: Language;
  /** A pinned Auth_User_Id, for a scenario that needs a stable id. Defaults to a random one. */
  readonly id?: string;
  /** A pinned Google email. Defaults to a random one. */
  readonly email?: string;
}

/** The Better Auth `user` document, as far as this fixture writes it. The library owns this shape. */
interface AuthUserDoc {
  _id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The Better Auth Google `account` document. The library owns this shape. */
interface AuthAccountDoc {
  _id: string;
  userId: string;
  providerId: 'google';
  accountId: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create a farmer: write the auth library's `user` + Google `account` records, run the D8
 * `bootstrapProfile`, and set the language if one was requested.
 *
 * `bootstrap` is passed in rather than imported so this module holds no `@/`-server dependency the
 * setup script cannot resolve; the harness passes the dynamically-imported
 * `bootstrapProfile`. The write goes through production code, so the Profile is exactly the row a
 * first Google sign-in produces — keyed by the Auth_User_Id, carrying the Google email, no phone.
 */
export async function createTestFarmer(
  db: Db,
  bootstrap: (userId: string, email: string | null) => Promise<void>,
  options: CreateFarmerOptions = {},
): Promise<TestFarmer> {
  const id = options.id ?? `auth-user-${randomUUID()}`;
  const email = options.email ?? `jamee-${randomUUID()}@example.test`;
  const language: Language = options.language ?? 'en';
  const now = new Date();

  // The auth library's own records (D8). These are the documents a Google first sign-in creates;
  // the library owns these collections, so the fixture writes them directly.
  await db.collection<AuthUserDoc>('user').insertOne({
    _id: id,
    name: email.split('@')[0] ?? 'farmer',
    email,
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection<AuthAccountDoc>('account').insertOne({
    _id: `acct-${id}`,
    userId: id,
    providerId: 'google',
    accountId: `google-${id}`,
    createdAt: now,
    updatedAt: now,
  });

  // The D8 bootstrap upsert — the SAME function the auth hook runs (Requirement 1.4). It writes
  // `(_id, email)` and NO phone (1.9) through the Data_Access_Layer.
  await bootstrap(id, email);

  if (options.language !== undefined) {
    await db
      .collection<ProfileDoc>(COLLECTIONS.profiles)
      .updateOne({ _id: id }, { $set: { language, updatedAt: new Date() } });
  }

  return { id, email, language };
}

/** The Profile row as the service role sees it — for an assertion about what the bootstrap wrote. */
export async function profileOf(db: Db, userId: string): Promise<ProfileDoc | null> {
  return db.collection<ProfileDoc>(COLLECTIONS.profiles).findOne({ _id: userId });
}
