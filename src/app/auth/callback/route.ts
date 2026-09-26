import { NextResponse, type NextRequest } from 'next/server';

import { SIGN_IN_PATH } from './ensure-profile';

/**
 * The legacy `/auth/callback` route — now a plain redirect to `/`.
 *
 * Requirements: 1.2 (session establishment happens elsewhere now)
 * Design: D8; V30 (Better Auth owns its own OAuth callback at `/api/auth/callback/google`)
 *
 * =============================================================================
 * WHY THIS ROUTE NO LONGER EXCHANGES A CODE
 * =============================================================================
 *
 * Under Supabase this handler verified the session and ran the profile upsert. Under Amendment A3
 * that work moved: Better Auth handles the Google OAuth callback at `/api/auth/callback/google`
 * (V30), and the D8 profile bootstrap runs in the library's `databaseHooks` (`src/lib/auth/auth.ts`)
 * rather than in a hand-written callback. So this path has nothing left to do — the old sign-in
 * flow that sent the browser here (`?next=…` after a phone-OTP verification) is gone with the
 * phone-OTP `SignInForm`.
 *
 * It is kept as a harmless redirect to the sign-in screen rather than deleted, so a stale bookmark,
 * a cached link, or an old client that still targets `/auth/callback` lands somewhere sensible
 * instead of a 404. A signed-in visitor who arrives here is bounced to `/`, and `/` immediately
 * redirects a live session on to `/diagnose` — so the round trip is correct for both states.
 * (`ensure-profile.ts` next to this file is retained too: it is the bootstrap the auth hooks call.)
 */

export const dynamic = 'force-dynamic';

const SEE_OTHER = 303;

export async function GET(request: NextRequest): Promise<Response> {
  return NextResponse.redirect(new URL(SIGN_IN_PATH, request.nextUrl.origin), SEE_OTHER);
}
