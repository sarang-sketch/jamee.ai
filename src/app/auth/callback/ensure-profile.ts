/**
 * The callback helper module — now a thin re-export of the D8 bootstrap plus the sign-in path.
 *
 * Requirements: 1.4, 1.5, 1.9 (the bootstrap contract, defined in `@/lib/auth/bootstrap`)
 * Design: D8 — the bootstrap logic moved into `src/lib/auth/bootstrap.ts` so Better Auth's
 *         `databaseHooks` (in `src/lib/auth/auth.ts`) can call it without `src/lib` importing from
 *         `src/app` (the one-way rule `scripts/check-shared-implementation.ts` enforces)
 *
 * The Supabase code-exchange callback, the E.164 normalizer, the PostgREST error classifier, and
 * the `next`-path helpers are gone with the phone identity and the Supabase backend they served
 * (Amendment A1 retired phone identity; Amendment A3 retired Supabase). Better Auth owns its own
 * OAuth callback at `/api/auth/callback/google` (V30), and the legacy `/auth/callback` route is now
 * a plain redirect (see `route.ts` beside this file).
 *
 * This module survives for two reasons: `bootstrapProfile` is re-exported here so its unit test
 * (`ensure-profile.test.ts`) keeps a stable import site, and `SIGN_IN_PATH` is declared here for
 * the callback route to import without reaching across the `src/lib` ↔ `src/app` boundary.
 */

export { bootstrapProfile } from '@/lib/auth/bootstrap';

/** The sign-in screen. Mirrors the constant in `src/lib/auth/protected-paths.ts`. */
export const SIGN_IN_PATH = '/';
