import 'server-only';

import { farmerData } from '@/lib/db/farmer';

/**
 * D8's defensive half: the idempotent profile bootstrap, run from the auth library's hook path.
 *
 * Requirements: 1.4 (a first session for an Auth_User_Id with no Profile produces a Profile whose
 *               `_id` is that id and whose `email` holds the Google_Email), 1.5, 1.9 (no phone is
 *               written)
 * Design: D8 — the bootstrap is the auth library's sign-in / user-created hook (V30) PLUS an
 *         idempotent server-side upsert through the Data_Access_Layer (D18)
 *
 * =============================================================================
 * WHY THIS LIVES IN `src/lib/auth` AND NOT NEXT TO THE CALLBACK ROUTE
 * =============================================================================
 *
 * The D8 bootstrap fires from Better Auth's `databaseHooks` in `src/lib/auth/auth.ts` (V30), so
 * the function they call has to be importable from `src/lib` WITHOUT crossing the one-way rule
 * "nothing under `src/lib/**` imports from `src/app/**`" (design, project structure), which
 * `scripts/check-shared-implementation.ts` enforces. So the logic lives here, in `src/lib/auth`,
 * where both the hook path and any future caller can reach it without an `src/app` → `src/lib`
 * dependency.
 *
 * =============================================================================
 * WHAT CHANGED FROM THE SUPABASE VERSION, AND WHY THE E.164 STORY IS GONE
 * =============================================================================
 *
 * Under Supabase this normalized a phone into E.164 and classified PostgREST error codes. Under
 * Amendment A3 identity is the Auth_User_Id the auth library assigns — a string it generates and
 * never reformats — so there is no format to reconcile and the normalizer is unnecessary (D8:
 * "not lost, unnecessary"). The write goes through `farmerData(userId).upsertProfileBootstrap`,
 * which the Data_Access_Layer owns (D18): it writes `(_id, email)` idempotently and NO phone
 * column (Requirement 1.4/1.9).
 *
 * `email` is nullable on the Profile on purpose (D8): an absent Google email claim is a Profile
 * without an email, not a sign-up that cannot complete. The defensive session-create hook passes
 * `null`; this function then reads the existing Profile and re-supplies its stored email, so a
 * defensive re-run never clobbers the email the user-create hook wrote on the first sign-in. (The
 * DAL accessor `$set`s whatever email it is given; `src/lib/db/farmer.ts` is owned elsewhere and is
 * not edited here, so the "leave the stored email in place" guarantee is provided here, by reading
 * before writing, rather than by changing the accessor.)
 */
export async function bootstrapProfile(userId: string, email: string | null): Promise<void> {
  const data = farmerData(userId);

  /**
   * Defensive re-run (session-create hook passes `null`): preserve any stored email rather than
   * overwriting it with `null`. If there is no Profile yet, `existing` is `null` and the upsert
   * creates one with a null email (a Profile without an email — D8). The user-create hook supplies
   * the real email on the first sign-in.
   */
  const effectiveEmail =
    email !== null ? email : ((await data.readProfile())?.email ?? null);

  await data.upsertProfileBootstrap(effectiveEmail);
}
