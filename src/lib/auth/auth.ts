import 'server-only';

import { betterAuth } from 'better-auth';

import { authDatabaseAdapter } from '@/lib/db/auth-adapter';
import { bootstrapProfile } from '@/lib/auth/bootstrap';
import { serverEnv } from '@/lib/env';

import type { BetterAuthOptions } from 'better-auth';

/**
 * The Better Auth instance — created LAZILY through a cached `getAuth()` factory.
 *
 * Requirements: 1.1 (Google sign-in), 1.2 (session establishment), 1.4 / 1.5 (the D8 profile
 *               bootstrap writes `(_id = Auth_User_Id, email = Google_Email)` and no phone), 1.9
 *               (no phone is written), 13.7 (secrets read through `serverEnv`, never at module
 *               scope)
 * Design: D8 (the bootstrap is the library's sign-in / user-created hook plus an idempotent
 *         upsert through the Data_Access_Layer), D18a (Better Auth 1.7.6 chosen), D19 (the adapter
 *         carries the `MongoClient` so transactions are enabled); V30 (the Google provider,
 *         `databaseHooks`, the env names), V35 (the library choice)
 *
 * =============================================================================
 * WHY `getAuth()` IS LAZY AND CACHED
 * =============================================================================
 *
 * `betterAuth({...})` reads `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, and
 * `GOOGLE_CLIENT_SECRET` through `serverEnv`, which throws with the variable's name when it is
 * absent (the fail-loud rule). `next build` legitimately runs with those secrets absent, and a
 * top-level `export const auth = betterAuth({...})` would evaluate at import time and fail the
 * build for the wrong reason. So the instance is built on FIRST USE inside `getAuth()` and cached,
 * exactly mirroring how `src/lib/db/client.ts` defers the `MongoClient` and how `serverEnv`
 * validates at first access rather than at import.
 *
 * The cache is a module-scope variable rather than a `globalThis` slot: unlike the `MongoClient`
 * (which must survive a hot reload to avoid leaking connection pools against the M0 cap), the auth
 * instance holds no scarce resource — it wraps the already-cached adapter — so a per-isolate cache
 * is sufficient, and every route/handler that needs it (`toNextJsHandler(getAuth())`, the session
 * reads in `src/lib/auth/session.ts`) calls `getAuth()` at request time rather than at import.
 *
 * =============================================================================
 * THE D8 BOOTSTRAP, VIA databaseHooks (V30)
 * =============================================================================
 *
 * D8 splits into two halves, and Better Auth's `databaseHooks` supply both:
 *
 *  - `user.create.after` — fires once, server-side, when the library creates a first user record
 *    for a Google account. This is the "on user creation" half: it upserts the `profiles` document
 *    with `(_id, email)` through the Data_Access_Layer.
 *  - `session.create.after` — fires on every sign-in (a session is created each time). This is the
 *    "defensively again on every sign-in" half D8 requires: a `user.create.after` that did not run
 *    (or ran before the library committed its own user record) still leaves a `profiles` document
 *    behind on the next authenticated sign-in. `bootstrapProfile` is idempotent (`$setOnInsert`
 *    for creation, `$set` only for the email), so running it on both hooks is safe.
 *
 * Both hooks write NO phone (Requirement 1.4/1.9). The bootstrap goes through
 * `farmerData(userId).upsertProfileBootstrap(email)` (`bootstrapProfile` wraps it), so it obeys
 * the owner-scoping of D18 and never touches the driver directly.
 */

const CALLBACK_URL = '/app';

/** Module-scope cache — one instance per isolate. See the header for why not `globalThis`. */
let cached: ReturnType<typeof betterAuth> | undefined;

/**
 * Build the Better Auth options. Reads every secret through `serverEnv` at CALL time, so nothing
 * here is evaluated until `getAuth()` first runs.
 */
function options(): BetterAuthOptions {
  return {
    /** V30: the library reads `BETTER_AUTH_SECRET` itself; passing it keeps the read in one place. */
    secret: serverEnv('BETTER_AUTH_SECRET'),
    /** V30: without this the Google callback may default to localhost and break a deployed sign-in. */
    baseURL: serverEnv('BETTER_AUTH_URL'),

    /** The MongoDB adapter, built inside the Data_Access_Layer (D18) with the client for txns (D19). */
    database: authDatabaseAdapter(),

    /** Requirement 1.1 — Google only. No email/password provider is configured. */
    socialProviders: {
      google: {
        clientId: serverEnv('GOOGLE_CLIENT_ID'),
        clientSecret: serverEnv('GOOGLE_CLIENT_SECRET'),
      },
    },

    /** D8 — the profile bootstrap, on user creation and defensively on every sign-in (V30). */
    databaseHooks: {
      user: {
        create: {
          async after(user) {
            /* The Google email is on the user record here; write `(_id, email)`, no phone. */
            await bootstrapProfile(user.id, user.email ?? null);
          },
        },
      },
      session: {
        create: {
          async after(session) {
            /**
             * Defensive re-run on every sign-in (D8). The session carries only `userId`, not the
             * email — so pass `null` and let the idempotent upsert leave any stored email in place
             * while still guaranteeing the `profiles` document exists. The email was written by
             * `user.create.after` on the first sign-in.
             */
            await bootstrapProfile(session.userId, null);
          },
        },
      },
    },
  };
}

/**
 * The cached Better Auth instance, built on first use.
 *
 * Every caller — `toNextJsHandler(getAuth())` in the route, `getAuth().api.getSession(...)` in
 * `session.ts` — invokes this at REQUEST time, never at import, so `next build` never needs a real
 * secret (the callback default and the design's "next build must never need real secrets" both
 * hold).
 */
export function getAuth(): ReturnType<typeof betterAuth> {
  if (cached === undefined) {
    cached = betterAuth(options());
  }
  return cached;
}

/** The post-sign-in destination, shared with the sign-in button's `callbackURL`. */
export const SIGN_IN_CALLBACK_URL = CALLBACK_URL;
