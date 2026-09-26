import 'server-only';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth/auth';
import { SIGN_IN_PATH } from '@/lib/auth/protected-paths';

/**
 * The server-confirmed session, for server components, route handlers, and the API auth gate.
 *
 * Requirements: 1.5 (the Auth_User_Id is the single Farmer identity), 1.6 (a signed-out visitor is
 *               sent to the sign-in screen), 1.7 (the API gate reads this, not a client-supplied
 *               id), 13.2 (whose data a request can reach is decided by this value)
 * Design: D8, D18a; V30 (`auth.api.getSession({ headers: await headers() })`, which returns `null`
 *         when signed out)
 *
 * =============================================================================
 * WHY THIS IS THE ONLY IDENTITY CALL
 * =============================================================================
 *
 * Better Auth's `auth.api.getSession` validates the session against the store (V30) — it is the
 * successor to Supabase's `getUser()`, which V1 recorded as the *server-confirmed* call, as
 * opposed to a user object decoded from a cookie a client supplied. Every authorization decision
 * in Jamee reads `currentUserId()` here, so a forged or edited session cookie resolves to `null`
 * and cannot mint an identity. `getAuth()` is called at request time (never at import), so a
 * missing secret is a fail-loud request error rather than a build failure.
 *
 * `headers()` is awaited (Next.js 16 makes it async) and handed to `getSession` so the library
 * reads the request's own cookies. This module is `server-only`; the browser reads its session
 * through `authClient` (`src/lib/auth/auth-client.ts`) instead.
 */

/**
 * The signed-in farmer's Auth_User_Id, or `null` when there is no valid session.
 *
 * This is the resolver `buildAuthenticatedRoute` is wired to in production (task 55.4 / the
 * `authenticated-route` rewire), and the value every owner-scoped `farmerData(...)` accessor is
 * bound to.
 */
export async function currentUserId(): Promise<string | null> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  return session?.user.id ?? null;
}

/**
 * For a server component behind the protected screen surface: return the signed-in farmer's id, or
 * `redirect('/')` when signed out (Requirement 1.6).
 *
 * The proxy (`src/proxy.ts`) already performs an optimistic cookie-existence redirect for these
 * paths, but that check is deliberately not a validation (V30 / the bundled Proxy guide say the
 * real check belongs in each page). `requireFarmer()` is that real check: it validates the session
 * against the store and redirects a farmer whose cookie exists but no longer resolves. `redirect()`
 * throws to unwind the render, so nothing after this call runs for a signed-out visitor.
 */
export async function requireFarmer(): Promise<string> {
  const userId = await currentUserId();
  if (userId === null) redirect(SIGN_IN_PATH);
  return userId;
}
