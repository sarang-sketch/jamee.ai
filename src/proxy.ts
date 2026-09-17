import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { SIGN_IN_PATH, isProtectedScreenPath } from '@/lib/auth/protected-paths';
import { publicEnv } from '@/lib/env.public';
import type { Database } from '@/types/database';

/**
 * The screen half of the auth gate, and the session refresh it rides on.
 *
 * Requirements: 1.6 (a visitor with no session gets the sign-in screen instead of the diagnosis,
 *               chat, voice, or history screen), 13.2 (RLS remains the authorization boundary —
 *               this is the layer that turns "no rows" into "sign in")
 * Design: "Frontend" — screens and component boundaries; "Security boundary" — defence in depth
 * Depends on: V1
 *
 * ### Why this file is `proxy.ts` and not `middleware.ts`
 *
 * V1 records that the Next.js-16-era Supabase guide runs session refresh in a **Proxy**
 * (`export async function proxy(request: NextRequest)`), not in `middleware.ts`. The pinned
 * framework agrees: `next@16.3.5` detects `proxy.{ext}` at the project root or in `src/`, errors
 * when both conventions are present, and warns that `middleware` is deprecated. It also states
 * that a Proxy **always runs on the Node.js runtime** and rejects a `runtime` export from this
 * file — which is why there is none below.
 *
 * ### Why the gate lives here rather than in each page
 *
 * `/diagnose`, `/chat`, `/voice` and `/history` do not exist yet (tasks 12.2, 16.1, 19.2, 13.1
 * own them). A gate written into each page would be a rule those four tasks have to remember; a
 * gate in front of all of them is one they inherit. `lib/auth/protected-paths.ts` holds the list,
 * so adding a screen to the protected surface is a one-line data change and never a new check.
 *
 * ### What this deliberately does not do
 *
 * It does not touch `/api/**`. Requirement 1.7 wants an unauthenticated API request answered with
 * the `AUTH_REQUIRED` envelope and HTTP 401, and a Proxy redirect would answer it with a 307 to an
 * HTML page. The matcher excludes `api/` and `lib/api/authenticated-route.ts` owns that half — so
 * exactly one of the two halves ever decides a given request. Excluding it also keeps the API path
 * from paying for two `getUser()` round trips per request.
 */

/**
 * `getUser()`, not a decoded cookie.
 *
 * V1 warns explicitly against trusting the user object from `getSession()` — it is decoded from a
 * cookie the client supplied — and records `getUser()` as the call that returns a
 * **server-confirmed** user record. `currentUserId()` in `lib/supabase/server.ts` makes the same
 * choice for server components and route handlers, so every authorization decision in Jamee reads
 * the same confirmed identity. V1 also names `getClaims()` for page protection; it is not adopted
 * here because a project whose JWTs are symmetrically signed makes that call reach the Auth server
 * anyway, and one identity call in one form is worth more than a conditional saving.
 *
 * This is also the call that refreshes an expiring session, which is the whole reason the Proxy
 * runs on unprotected paths too: a Server Component render cannot write cookies (see the comment
 * on `setAll` in `lib/supabase/server.ts`), so without this the refresh would be discarded and a
 * signed-in farmer would be logged out when their access token expired.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { supabaseUrl, supabaseAnonKey } = publicEnv();

  /**
   * V1's constraint: the response the Proxy returns must be the one the cookie writer built.
   * `setAll` replaces this binding, and the return statements below hand back that object — a
   * fresh `NextResponse.next()` at the end would drop a rotated session token and log the farmer
   * out on the next request.
   */
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        /**
         * Both sides of the exchange, in the order the Supabase guide gives:
         *  1. the request cookies, so anything downstream in *this* request reads the new token;
         *  2. a response rebuilt from that mutated request, then the same cookies set on it with
         *     their options, so the browser stores the rotated token.
         */
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  const { data, error } = await supabase.auth.getUser();
  const signedIn = error === null && data.user !== null;

  if (!signedIn && isProtectedScreenPath(request.nextUrl.pathname)) {
    const signIn = request.nextUrl.clone();
    signIn.pathname = SIGN_IN_PATH;
    /**
     * The original path is not carried along as `?next=`. `SignInForm` fixes its own onward
     * destination (`AFTER_SIGN_IN_PATH`, task 6.1), so a parameter added here would be read by
     * nothing — and a query string that looks like it works is worse than none. Restoring the
     * requested screen after sign-in is a change to that component, which this task does not own.
     */
    signIn.search = '';

    /**
     * The one place a response other than `supabaseResponse` is returned, and it is safe for the
     * reason the Supabase guide's own redirect branch is: this branch runs only when there is no
     * user, so there is no refreshed session on `supabaseResponse` worth preserving.
     */
    return NextResponse.redirect(signIn);
  }

  return supabaseResponse;
}

/**
 * Where the Proxy runs. Everything except Next's own assets, static files, and `/api/**`.
 *
 * Wider than the protected list on purpose — session refresh has to happen on `/` and
 * `/auth/callback` too, or a returning farmer's expired token is never rotated. The redirect
 * itself is still governed by `isProtectedScreenPath`, so matching a path and gating it are two
 * separate decisions.
 */
export const config = {
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|txt|xml|webmanifest)$).*)',
  ],
};
