import { NextResponse, type NextRequest } from 'next/server';

import { withErrorHandling } from '@/lib/errors';
import { createServerSupabase } from '@/lib/supabase/server';

import { SIGN_IN_PATH, ensureProfile, safeNextPath } from './ensure-profile';

/**
 * The post-sign-in stop: confirm the session, assert the Profile, continue into the app.
 *
 * Requirements: 1.4 (the Web_App creates a Profile whose `id` references `auth.users` and whose
 *               `phone` holds the E.164 number), 1.5 (that phone is the single Farmer identity),
 *               15.6 (a failure returns a generic message; no stack traces in the body)
 * Design: D8 — trigger plus idempotent server-side upsert; `auth/callback/route.ts` in the project
 *          structure
 * Depends on: V1 — `createServerClient` with `getAll`/`setAll`, `await cookies()`, and `getUser()`
 *             as the server-confirmed identity call
 *
 * ### There is no code to exchange, and this route does not pretend otherwise
 *
 * `exchangeCodeForSession` belongs to the PKCE flows — OAuth providers and email magic links —
 * where the browser lands back on the site holding a `?code=` and the session has to be minted
 * server-side. Jamee has neither. Requirements 1.1–1.3 describe one authentication method, phone
 * OTP, and task 6.1's `SignInForm` completes it in the browser: `verifyOtp` returns the session and
 * the `@supabase/ssr` browser client writes it into cookies the server can read. By the time this
 * handler runs the session already exists.
 *
 * So the session work here is the honest remainder of it: `getUser()` **verifies** that session
 * against the Auth service (V1 warns against trusting the user object from `getSession()`, which is
 * decoded from a cookie a client could have supplied), and because a route handler may write
 * cookies — unlike a Server Component render, see `lib/supabase/server.ts` — a token refresh
 * performed during that call is persisted here rather than silently dropped. Writing an
 * `exchangeCodeForSession` branch for a `?code=` that no Jamee flow produces would be dead code
 * guarding an imaginary path, and V1 records no call for it.
 *
 * ### Why the browser comes through here at all
 *
 * `SignInForm` sends the farmer to `/auth/callback?next=/diagnose` after a verified code, so the
 * upsert runs on the way to the app instead of being a route nothing calls. The farmer still lands
 * on `/diagnose`, which is what task 6.1 specifies; this is a redirect in between.
 */

/**
 * The whole handler reads cookies, so it can never be prerendered. Stated rather than inferred:
 * the alternative is a build-time attempt at a handler whose only correct output depends on a
 * request.
 */
export const dynamic = 'force-dynamic';

/**
 * `303 See Other` rather than a default `307`: the farmer's browser performed a GET, the work is
 * done, and the thing to look at is at another URL. 307 would promise method preservation that
 * nothing here needs.
 */
const SEE_OTHER = 303;

export async function GET(request: NextRequest): Promise<Response> {
  /**
   * Every failure leaves through the one envelope (Requirement 15.6): a generic localized body, the
   * real cause logged server-side and nowhere else. `en` is the language, because the only place a
   * farmer's preference is recorded is the profile row this route may have just failed to write.
   *
   * This is also why the redirects below are `NextResponse.redirect` and not `redirect()` from
   * `next/navigation`: that helper signals by THROWING a `NEXT_REDIRECT` error, and a wrapper whose
   * job is to catch everything would catch it and turn a successful sign-in into a 500.
   */
  return withErrorHandling(async () => {
    const origin = request.nextUrl.origin;
    const supabase = await createServerSupabase();

    const { data, error } = await supabase.auth.getUser();

    /**
     * No session: nothing to bootstrap, and nothing to report either. A visitor who reaches this
     * URL without signing in has simply arrived somewhere that has no meaning for them, so they go
     * to the sign-in screen. Creating a profile here is impossible by design — the RLS policies key
     * on `auth.uid()`, which is null for an anonymous request.
     */
    if (error !== null || data.user === null) {
      return NextResponse.redirect(new URL(SIGN_IN_PATH, origin), SEE_OTHER);
    }

    /**
     * D8's defensive half. `supabase` is the RLS-scoped client, and the write is the farmer's own
     * row by construction — see the reasoning on `ensureProfile`, which also explains why the
     * service-role client would be the wrong tool for it.
     *
     * A throw from here is a residual failure mode of the trigger in `0002_profiles.sql`, already
     * carrying its `reason`, and it lands in the wrapper above.
     */
    await ensureProfile(supabase, data.user);

    /** Attacker-controlled input; `safeNextPath` reduces it to a same-origin path. */
    const next = safeNextPath(request.nextUrl.searchParams.get('next'));
    return NextResponse.redirect(new URL(next, origin), SEE_OTHER);
  });
}
