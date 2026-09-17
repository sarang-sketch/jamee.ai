import type { Language } from '@/lib/schemas';
import type { ProfileRow } from '@/types/database';

import { anonClient, type TestClient } from './clients';
import { requireSupabaseTestConfig, type SupabaseTestConfig } from './database';

/**
 * A farmer with a real session, which is the fixture every tenant-isolation assertion rests on.
 *
 * Requirements: 1.4 (a first session for a phone with no Profile produces one, keyed by the auth
 *               user id and carrying the E.164 number), 1.5 (the phone is the single cross-channel
 *               identity), 13.2 (an authenticated farmer reaches only their own rows)
 * Design: D8 (profile creation = an `auth.users` trigger plus an idempotent server-side upsert)
 *
 * =============================================================================
 * HOW AN RLS-SCOPED SESSION IS MINTED, AND WHY THIS WAY
 * =============================================================================
 *
 * RLS is written against `auth.uid()`, which is a claim on the request's JWT. There is no way to
 * fake one: a token has to be signed by the stack's own secret, so the harness has to obtain a real
 * one. Three routes exist against a local stack, and this is the one taken:
 *
 *  1. **Service role creates the user, the user signs in with a password.** ← used here
 *     `auth.admin.createUser({ email, password, phone, email_confirm, phone_confirm })` followed by
 *     `auth.signInWithPassword({ email, password })` on an anon-key client. Two documented Auth
 *     endpoints, no SMS provider, no email delivery, and the resulting client is scoped exactly the
 *     way a browser client is after a farmer signs in.
 *  2. Phone OTP, the way production signs a farmer in (Requirement 1.1). Rejected: it needs a
 *     configured SMS provider, which `docs/DEPLOYMENT.md` step 2 records as the one paid dependency
 *     in the whole deployment. A harness that cannot run without a paid third party is a harness
 *     nobody runs. Real OTP delivery stays a human-tester item, which is where the design already
 *     puts it.
 *  3. Signing a JWT locally with the stack's secret. Rejected: it would put a second, hand-rolled
 *     notion of "a valid Jamee session" in the repository, and a test that mints tokens the Auth
 *     service would refuse can pass while production is broken.
 *
 * **The email address is scaffolding, not identity.** Requirement 1.5 makes the *phone* the single
 * cross-channel identity, and that is what goes on the profile row — the trigger in
 * `0002_profiles.sql` copies `new.phone`, never the email. The email exists only because
 * password sign-in needs an identifier that does not involve an SMS provider. Every assertion about
 * identity should read `profiles.phone`.
 */
export interface TestFarmer {
  /** `auth.users.id`, which is also `profiles.id` and the first segment of every storage path. */
  readonly id: string;
  /** E.164. The single cross-channel identity (Requirement 1.5). */
  readonly phone: string;
  /** Sign-in scaffolding. Not identity — see the note above. */
  readonly email: string;
  /** The session's access token, for a test that needs to build a request by hand. */
  readonly accessToken: string;
  /**
   * RLS-scoped. Every statement made through this client carries this farmer's JWT, so the
   * policies in the migrations are what decide the outcome — pass it as a service's `supabase`
   * dependency to exercise the web path exactly as a route handler does.
   */
  readonly client: TestClient;
}

export interface CreateFarmerOptions {
  /** Defaults to a random E.164 number. Supply one to pin a WhatsApp-resolution assertion. */
  readonly phone?: string;
  /** Written to the profile after the trigger created it. Defaults to the column default, `en`. */
  readonly language?: Language;
  readonly displayName?: string;
}

/** Digits from `crypto.randomUUID()`, so no test needs a seeded random source. */
function randomDigits(count: number): string {
  let digits = '';
  while (digits.length < count) digits += crypto.randomUUID().replace(/\D/g, '');
  return digits.slice(0, count);
}

/**
 * A random E.164 number: `+91` and ten digits, which is twelve digits total and inside the 8-to-15
 * range `profiles_phone_e164` enforces.
 *
 * Random rather than sequential because `profiles.phone` is UNIQUE and a run that failed before its
 * cleanup would otherwise poison every later run with a collision that looks like a policy error.
 */
export function randomTestPhone(): string {
  return `+91${randomDigits(10)}`;
}

function randomEmail(): string {
  return `jamee-integration-${crypto.randomUUID()}@example.com`;
}

/**
 * A random sign-in password that stays inside bcrypt's input limit.
 *
 * =============================================================================
 * WHY THIS IS A FUNCTION AND NOT AN INTERPOLATION AT THE CALL SITE
 * =============================================================================
 *
 * GoTrue hashes passwords with **bcrypt, which refuses any input longer than 72 bytes** — and it
 * refuses it by panicking, so the admin create endpoint answers with a bare `500 Internal Server
 * Error` and `docker logs supabase_auth_jamee` is the only place the reason appears.
 *
 * This used to read `` `${crypto.randomUUID()}-${crypto.randomUUID()}` ``, which is 36 + 1 + 36 =
 * **73 bytes**: one byte over, so every `beforeAll` in the integration suite failed. Stripping the
 * hyphens leaves the two UUIDs' 32 hex digits each — **64 bytes**, eight under the limit, so a
 * future tweak has room. Landing exactly on 72 would invite the same bug straight back.
 *
 * Hex is ASCII, so byte length equals character length here; anything non-ASCII added later must be
 * measured with `Buffer.byteLength`, not `.length`. Per-farmer random rather than a shared constant
 * because `signInWithPassword` uses it immediately and concurrent suites must not interfere.
 *
 * Exported so `tests/unit/integration-harness.test.ts` can guard the real value on every `npm test`
 * rather than re-deriving the arithmetic and proving nothing.
 */
export function randomTestPassword(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
}

/**
 * Create an auth user, confirm both identifiers, and return a client holding its session.
 *
 * `admin` must be a service-role client: creating a user and confirming it are admin endpoints.
 *
 * The profile row is **not** inserted here. `0002_profiles.sql`'s `on_auth_user_created` trigger
 * writes it, and letting it do so is the point: a harness that inserted the row itself would make
 * every later assertion about Requirement 1.4 vacuous, and would hide a broken trigger — which
 * `0002` notes blocks signups entirely rather than degrading.
 */
export async function createTestFarmer(
  admin: TestClient,
  options: CreateFarmerOptions = {},
  config: SupabaseTestConfig = requireSupabaseTestConfig(),
): Promise<TestFarmer> {
  const phone = options.phone ?? randomTestPhone();
  const email = randomEmail();
  // 64 ASCII bytes, under bcrypt's 72-byte ceiling — see randomTestPassword().
  const password = randomTestPassword();

  const created = await admin.auth.admin.createUser({
    email,
    password,
    phone,
    email_confirm: true,
    phone_confirm: true,
  });

  if (created.error !== null || created.data.user === null) {
    throw new Error(
      `Could not create a test farmer (${phone}): ${created.error?.message ?? 'no user returned'}. ` +
        'Read the status first, because it splits the causes. A 500 / "Internal Server Error" is ' +
        'not a validation failure and usually means the Auth container itself panicked, or a ' +
        'trigger on auth.users raised — the admin endpoint has no message for either, so the actual ' +
        'reason lives in `docker logs supabase_auth_jamee` and that is where to look before ' +
        'suspecting anything below. (One such panic was bcrypt refusing a password over 72 bytes; ' +
        'see randomTestPassword().) For a non-500 failure, three causes are plausible: the ' +
        "migrations were not applied, so the 0002 trigger's insert into public.profiles failed; " +
        'this phone is already on another profile (it is UNIQUE); or the stack refuses a phone on ' +
        'the admin create endpoint, which is fixed by enabling the phone provider under [auth.sms] ' +
        'in supabase/config.toml. A phone is not optional — profiles.phone is NOT NULL and the ' +
        'trigger copies it from the auth user.',
    );
  }

  const id = created.data.user.id;

  const profileFields = {
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.displayName === undefined ? {} : { display_name: options.displayName }),
  };

  if (Object.keys(profileFields).length > 0) {
    const { error } = await admin.from('profiles').update(profileFields).eq('id', id);
    if (error !== null) {
      throw new Error(`Could not set profile fields for ${id}: ${error.message}`);
    }
  }

  const client = anonClient(config);
  const session = await client.auth.signInWithPassword({ email, password });

  if (session.error !== null || session.data.session === null) {
    throw new Error(
      `Could not sign in as the test farmer ${id}: ${session.error?.message ?? 'no session returned'}. ` +
        'Password sign-in must be enabled on the stack for the harness to mint an RLS-scoped ' +
        'session — see the note at the top of tests/integration/farmers.ts.',
    );
  }

  return { id, phone, email, accessToken: session.data.session.access_token, client };
}

/**
 * Delete the auth user, which cascades.
 *
 * Every farmer-scoped table references `profiles(id) on delete cascade`, and `profiles.id`
 * references `auth.users(id) on delete cascade`, so one delete removes the conversations, messages,
 * diagnoses, counters and usage-log rows a test produced. `whatsapp_inbound.user_id` is
 * `on delete set null` by design (Requirement 11.5) — a test that writes one cleans it up itself.
 *
 * Tolerant of an already-absent user so a failed `beforeAll` cannot cascade into a failing
 * `afterAll` that hides it.
 */
export async function deleteTestFarmer(admin: TestClient, farmer: TestFarmer): Promise<void> {
  await farmer.client.auth.signOut({ scope: 'local' });
  const { error } = await admin.auth.admin.deleteUser(farmer.id);
  if (error !== null && !/not.*found/i.test(error.message)) {
    throw new Error(`Could not delete the test farmer ${farmer.id}: ${error.message}`);
  }
}

/**
 * The profile row as the service role sees it — i.e. whether it exists at all, independent of any
 * policy. Use the farmer's own client to assert what a *farmer* can read.
 */
export async function profileOf(admin: TestClient, userId: string): Promise<ProfileRow | null> {
  const { data, error } = await admin.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error !== null) throw new Error(`Could not read profile ${userId}: ${error.message}`);
  return data;
}
