import { AppError } from '@/lib/errors';
import type { Database } from '@/types/database';

/**
 * D8's defensive half: the idempotent profile upsert, and the phone normalization it needs.
 *
 * Requirements: 1.4 (a first session for a phone with no Profile produces a Profile whose `id`
 *               references `auth.users` and whose `phone` holds the E.164 number), 1.5 (that
 *               `phone` is the single cross-channel Farmer identity)
 * Design: D8 — `on auth.users insert` trigger PLUS an idempotent server-side upsert
 * Depends on: V5 (the trigger is the documented bootstrap pattern, and a failing trigger can
 *             block signups — which is why this exists at all)
 *
 * ### Why a module beside `route.ts` rather than inside it
 *
 * Next validates the export surface of a `route.ts` against the allowed route exports, so a
 * helper exported from that file fails `next build`. Keeping the logic here also keeps it free of
 * `next/headers`, so it is unit-testable without a request scope — see `ensure-profile.test.ts`.
 *
 * ### What this absorbs, in the migration's own words
 *
 * `0002_profiles.sql` enumerates the two paths its trigger cannot cover on its own:
 *
 *   * an auth user created without a phone — `null` violates `phone not null`;
 *   * a phone already present on another profile — the trigger's `on conflict (id)` clause does
 *     not catch a unique violation on `phone`.
 *
 * Neither is fixable here either. What this module does is make them **named, logged, non-leaking
 * failures** instead of an unhandled exception: each one throws an `AppError` whose `context`
 * carries a specific `reason`, which `withErrorHandling` logs server-side while the farmer gets
 * the generic localized 500 body Requirement 15.6 specifies. A handled 500 and a raw 500 look the
 * same to a browser and completely different to whoever has to diagnose it.
 *
 * ### Why failing is right, rather than signing the farmer in anyway
 *
 * `conversations`, `messages`, `diagnoses` and `usage_logs` all declare
 * `user_id ... references public.profiles(id)`. With no profile row, the farmer's first diagnosis
 * fails on a foreign key deep inside a service, and Requirement 10.2's WhatsApp resolution finds
 * nothing. Stopping at the profile write is the earliest honest place to stop.
 */

/* ========================================================================== */
/* E.164                                                                       */
/* ========================================================================== */

/**
 * The shape the database enforces: `profiles_phone_e164` in migration 0002 is
 * `check (phone ~ '^\+[1-9][0-9]{7,14}$')`. That constraint is the source of truth; this is a
 * copy of it kept deliberately identical.
 *
 * (`SignInForm.tsx` holds a third copy for its pre-flight check. It cannot be shared: that module
 * carries `'use client'`, so a server import of its exports gets client references rather than
 * functions. A single shared constant belongs in `lib/schemas.ts`, which no current task owns.)
 */
export const E164_PHONE = /^\+[1-9][0-9]{7,14}$/;

/** Separators people type or providers insert. None of them carry meaning. */
const SEPARATORS = /[\s()\u2010-\u2015-]/g;

/**
 * `auth.users.phone` re-expressed in the form the `profiles.phone` column requires, or `null`
 * when that is not possible.
 *
 * **The leading `+` is added when absent, and this is not a guess.** The format Supabase Auth
 * stores a phone in is not recorded in `docs/VERIFIED_VALUES.md` — V2 covers enabling phone auth
 * and the call names, not the stored representation — and third-party sources say the `+` is
 * stripped on the way in. So the value arriving here may be `+919876543210` or `919876543210`,
 * and normalization has to be correct either way: prefixing `+` to the same digits changes no
 * digit and is a no-op when the `+` is already there. That is a different act from the one
 * `SignInForm` refuses — inventing a *country code* would choose which country a farmer is in;
 * restoring the `+` chooses nothing.
 *
 * Anything that is not E.164 after that is rejected rather than written. A value the check
 * constraint would refuse is not worth a round trip, and a wrong number in the identity column
 * would misroute a WhatsApp conversation (Requirement 10.2).
 */
export function toE164(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const compact = raw.replace(SEPARATORS, '');
  if (compact === '') return null;

  const candidate = compact.startsWith('+') ? compact : `+${compact}`;
  return E164_PHONE.test(candidate) ? candidate : null;
}

/* ========================================================================== */
/* The write, and the seam it goes through                                     */
/* ========================================================================== */

type ProfileInsert = Database['public']['Tables']['profiles']['Insert'];

/**
 * Exactly the columns this bootstrap owns — and the type is a `Pick` of the generated insert type
 * so it cannot drift from the table.
 *
 * `display_name` and `language` are deliberately absent. PostgREST builds `on conflict do update`
 * from the keys present in the payload, so an upsert carrying only these two cannot reset the
 * values task 6.4's profile screen writes. That is most of what makes this safe to run on **every**
 * sign-in rather than only the first.
 */
export type ProfileBootstrapRow = Pick<ProfileInsert, 'id' | 'phone'>;

/** The slice of a PostgREST error this module reads. `PostgrestError` satisfies it. */
export interface ProfileWriteError {
  code: string;
  message: string;
}

/**
 * The narrow slice of a Supabase client the upsert needs.
 *
 * Structural, like `StorageClientLike` in `lib/storage.ts`, so the RLS-scoped client satisfies it
 * without being imported here — which is what keeps this module out of the request scope and in
 * reach of a unit test. `PromiseLike` rather than `Promise` because a PostgREST builder is
 * thenable, not a `Promise`.
 */
export interface ProfileWriterLike {
  from(table: 'profiles'): {
    upsert(
      values: ProfileBootstrapRow,
      options: { onConflict: string; ignoreDuplicates: boolean },
    ): PromiseLike<{ error: ProfileWriteError | null }>;
  };
}

/** The `auth.users` record this needs, and nothing more. A supabase-js `User` satisfies it. */
export interface AuthUserLike {
  id: string;
  phone?: string | null;
}

/**
 * Why each failure happened, in one word, for the server log. Never rendered to a farmer — the
 * farmer-facing text comes from the catalog via `toEnvelope`, and these strings never touch it.
 */
export type ProfileBootstrapReason =
  | 'auth_user_has_no_e164_phone'
  | 'profile_phone_owned_by_another_user'
  | 'profile_phone_rejected_by_e164_check'
  | 'profile_upsert_denied_by_rls'
  | 'profile_upsert_failed';

/**
 * `INTERNAL_ERROR` for every one of these, deliberately.
 *
 * The taxonomy in `lib/errors.ts` is exhaustive over `ERROR_CODES`, and none of its codes means
 * "your profile row could not be written": `AUTH_REQUIRED` would be a lie (the farmer holds a
 * valid session at this point) and inventing a code would put a farmer-facing string outside the
 * catalog and outside the requirements. So the code stays `INTERNAL_ERROR` — which is honest, since
 * every branch below is a server-side defect or a corrupt data state rather than anything the
 * farmer did — and the `reason` in the context is what makes the log line specific.
 *
 * **Re-examined by task 25.2 and left as it is, deliberately.** A `PROFILE_WRITE_FAILED` code would
 * add a farmer-facing sentence in three languages that says no more than `INTERNAL_ERROR` already
 * does: there is nothing here the farmer can do differently, so a more specific code would buy
 * precision for the *log* — which `context.reason` already gives, at no cost to the catalog — and
 * none for the person reading the message. This is the one recorded gap of the three that stays
 * open on purpose rather than for want of work.
 *
 * **No phone number goes into the context.** A phone is the farmer's identity here (Requirement
 * 1.5); the user id names the row just as precisely without putting PII in a log.
 */
function bootstrapFailure(
  reason: ProfileBootstrapReason,
  userId: string,
  cause?: unknown,
): AppError {
  return new AppError('INTERNAL_ERROR', {
    context: { reason, userId },
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Map a PostgREST failure onto the residual mode it actually is.
 *
 * Classification is on the SQLSTATE code alone, never on the message text — the message is
 * Postgres's own prose and can be localized or reworded between versions, and a classifier that
 * reads it would silently degrade into the `default` branch.
 *
 * `23505` needs the migration's comment to read correctly: a unique violation on THIS insert cannot
 * be an `id` collision, because `on conflict (id)` absorbs those. The only other unique index on
 * `profiles` is on `phone`. So a `23505` here means a *different* auth user's profile already holds
 * this phone — residual mode two, exactly as documented in `0002_profiles.sql`.
 */
export function classifyProfileWriteError(error: ProfileWriteError): ProfileBootstrapReason {
  switch (error.code) {
    case '23505':
      return 'profile_phone_owned_by_another_user';

    /** `23514` check violation, `23502` not-null: the value this module built was refused. */
    case '23514':
    case '23502':
      return 'profile_phone_rejected_by_e164_check';

    /**
     * `42501` is RLS refusing the row. Unreachable by construction — `id` comes from `getUser()`,
     * so `auth.uid() = id` holds — which is precisely why it must not be swallowed: reaching it
     * means the session and the row disagree about who is writing.
     */
    case '42501':
      return 'profile_upsert_denied_by_rls';

    default:
      return 'profile_upsert_failed';
  }
}

/**
 * Ensure this auth user has a Profile carrying their E.164 phone. Returns the row it asserted.
 *
 * Idempotent, and safe on every sign-in rather than only the first:
 *  - one statement, `insert … on conflict (id) do update`, so two concurrent sign-ins cannot race
 *    into a duplicate or a lost write;
 *  - `ignoreDuplicates: false` — the conflict path UPDATES. `do nothing` would leave a stale phone
 *    in place after a farmer changes their number in Auth, and a stale identity column silently
 *    misroutes the WhatsApp channel (Requirement 10.2). The cost is that `updated_at` moves on each
 *    sign-in, which nothing in Jamee reads as a signal;
 *  - the payload is two columns, so nothing else on the row is disturbed.
 *
 * **The RLS-scoped client is the right client here, and the admin client would be wrong.** The
 * session exists by the time this runs, `profiles_insert_own` and `profiles_update_own` both check
 * `auth.uid() = id`, and `id` comes from a server-confirmed `getUser()` — so the database
 * independently re-checks the one thing that must be true, and a bug in this file cannot write
 * another farmer's row. Nothing here needs to bypass RLS: residual mode two is a unique-index
 * violation, which the service role hits identically, so reaching for it would move the write
 * outside Jamee's authorization boundary for no capability at all.
 */
export async function ensureProfile(
  writer: ProfileWriterLike,
  user: AuthUserLike,
): Promise<ProfileBootstrapRow> {
  const phone = toE164(user.phone);

  /**
   * Residual mode one. Nothing is attempted: `phone` is `not null` with an E.164 check, so there is
   * no row to write, and no client — RLS-scoped or service-role — can invent an identity.
   */
  if (phone === null) throw bootstrapFailure('auth_user_has_no_e164_phone', user.id);

  const row: ProfileBootstrapRow = { id: user.id, phone };

  /** `onConflict: 'id'` is the primary key and therefore the default; stated to match D8's clause. */
  const { error } = await writer
    .from('profiles')
    .upsert(row, { onConflict: 'id', ignoreDuplicates: false });

  if (error !== null) {
    throw bootstrapFailure(classifyProfileWriteError(error), user.id, error);
  }

  return row;
}

/* ========================================================================== */
/* Where the browser goes next                                                 */
/* ========================================================================== */

/** Task 6.1's destination. The callback is a stop on the way, not a new landing screen. */
export const DEFAULT_NEXT_PATH = '/diagnose';

/** The sign-in screen, for a visit that carries no session. */
export const SIGN_IN_PATH = '/';

/**
 * The onward path, reduced to a same-origin absolute path.
 *
 * This value comes from a query string, so it is attacker-controlled, and `Location` is exactly
 * the header an open redirect lives in — a link to
 * `/auth/callback?next=https://not-jamee.example` would otherwise hand a signed-in farmer to
 * someone else's page from Jamee's own domain. Anything that is not a single-slash-prefixed path
 * falls back to the default rather than being repaired: `//host` is protocol-relative, a backslash
 * is treated as a slash by some URL parsers, and a scheme needs no comment.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return DEFAULT_NEXT_PATH;
  if (!raw.startsWith('/')) return DEFAULT_NEXT_PATH;
  if (raw.startsWith('//')) return DEFAULT_NEXT_PATH;
  if (raw.includes('\\')) return DEFAULT_NEXT_PATH;
  return raw;
}
