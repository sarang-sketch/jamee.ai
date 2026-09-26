import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

import { SIGN_IN_PATH, isProtectedScreenPath } from '@/lib/auth/protected-paths';

/**
 * The screen half of the auth gate — an OPTIMISTIC cookie-existence redirect, nothing more.
 *
 * Requirements: 1.6 (a visitor with no session gets the sign-in screen instead of a protected
 *               screen)
 * Design: "Frontend" — screens and component boundaries; "Security boundary" — defence in depth;
 *         D18a; V30 (`getSessionCookie` in the proxy, real validation in each page/route)
 *
 * =============================================================================
 * WHY THIS IS A COOKIE-EXISTENCE CHECK AND NOT A SESSION VALIDATION
 * =============================================================================
 *
 * Better Auth's own guidance, and the bundled Next.js Proxy guide
 * (`node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`), both say the same thing:
 * a Proxy is for OPTIMISTIC checks such as permission-based redirects, NOT for full session
 * management or authorization. So this file calls `getSessionCookie(request)`, which V30 records
 * as checking only that the session cookie EXISTS — it does not validate it — and redirects a
 * visitor with no such cookie away from a protected screen. The real check lives in each protected
 * page (`requireFarmer()` in `src/lib/auth/session.ts`, which calls `auth.api.getSession`) and in
 * each protected API route (`authenticatedRoute`), where a cookie that exists but no longer
 * resolves is turned into a redirect or a 401. A farmer whose cookie is present but stale therefore
 * gets past this proxy and is stopped by the page — which is the intended split, not a hole.
 *
 * This is what makes the file "clean" of the old backend: there is no Supabase client, no
 * `createServerClient`, no `getUser()` round trip, and no session-refresh cookie dance. Better
 * Auth refreshes its own session through `/api/auth/**` (the catch-all handler), so the proxy has
 * no refresh to preserve and returns a plain `NextResponse.next()`.
 *
 * =============================================================================
 * WHAT THIS DELIBERATELY DOES NOT DO
 * =============================================================================
 *
 * It does not touch `/api/**`. Requirement 1.7 wants an unauthenticated API request answered with
 * the `AUTH_REQUIRED` envelope and HTTP 401, and a proxy redirect would answer it with a 307 to an
 * HTML page. The matcher excludes `api/`, and `lib/api/authenticated-route.ts` owns that half — so
 * exactly one of the two halves ever decides a given request.
 *
 * This file is `proxy.ts`, not `middleware.ts`: Next.js 16 renamed Middleware to Proxy (the
 * bundled Proxy guide states the functionality is unchanged), detects `proxy.{ext}` at the project
 * root or in `src/`, and deprecates `middleware`.
 */

export function proxy(request: NextRequest): NextResponse {
  /**
   * The optimistic check. `getSessionCookie` returns the cookie value when present, `null`
   * otherwise — it does NOT validate the session (V30). A signed-out visitor on a protected screen
   * is redirected to the sign-in screen; every other request passes straight through.
   */
  const hasSessionCookie = getSessionCookie(request) !== null;

  if (!hasSessionCookie && isProtectedScreenPath(request.nextUrl.pathname)) {
    const signIn = request.nextUrl.clone();
    signIn.pathname = SIGN_IN_PATH;
    /**
     * The requested path is not carried as `?next=`: the sign-in flow lands on a fixed destination
     * (`/diagnose`, via the sign-in button's `callbackURL` and `/`'s own redirect), so a parameter
     * added here would be read by nothing, and a query string that looks like it works is worse
     * than none.
     */
    signIn.search = '';
    return NextResponse.redirect(signIn);
  }

  return NextResponse.next();
}

/**
 * Where the proxy runs. Everything except Next's own assets, static files, and `/api/**`.
 *
 * Narrower in effect than before by intent: this proxy only ever REDIRECTS, and only on a
 * protected path, so it needs to run just where a protected screen might be requested. It stays
 * broad (rather than matching only `PROTECTED_SCREEN_PATHS`) so that adding a screen to the
 * protected list is a one-line data change in `protected-paths.ts` and never a matcher edit — the
 * redirect decision remains governed by `isProtectedScreenPath`, so matching a path and gating it
 * are two separate decisions.
 */
export const config = {
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|txt|xml|webmanifest)$).*)',
  ],
};
