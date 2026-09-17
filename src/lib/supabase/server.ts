import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { publicEnv } from '@/lib/env.public';
import type { Database } from '@/types/database';

/**
 * RLS-scoped server client, wired to the App Router cookie store.
 *
 * Requirements: 1.6 / 1.7 (the auth gate), 13.1 / 13.2 (every read passes through RLS)
 * Depends on: V1
 *
 * This is the client every server component and route handler uses for farmer data. It carries the
 * farmer's session, so **RLS is doing the authorization** and a query cannot return another
 * farmer's rows even if a predicate is forgotten. That is the opposite of the admin client, where
 * the application check IS the boundary.
 *
 * ### `getAll` / `setAll` only — V1 is explicit about this
 *
 * V1 records that the docs permit **only** the `getAll` / `setAll` cookie methods, and call out
 * `get` / `set` / `remove` and `@supabase/auth-helpers-nextjs` as breaking. Do not "simplify" this
 * to the per-cookie form.
 */
export async function createServerSupabase() {
  const { supabaseUrl, supabaseAnonKey } = publicEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        /**
         * `cookies()` is READ-ONLY in a Server Component render, and writing there throws. That
         * is not a bug to work around: session refresh belongs in the proxy (V1), and a Server
         * Component that could rotate a session token would rotate it during a render that may be
         * cached or replayed.
         *
         * So the write is attempted and a failure is swallowed **only here**, where the session
         * the caller already holds stays valid for this request either way. Route handlers and
         * Server Actions CAN write, and there the write succeeds — which is what makes sign-in and
         * sign-out work.
         */
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component render: refresh is the proxy's job. See above.
        }
      },
    },
  });
}

/**
 * The signed-in farmer's id, or `null`.
 *
 * Uses `getUser()`, which V1 records as the call that returns a **server-confirmed** user record,
 * and warns explicitly against trusting the user object from `getSession()` — that one is decoded
 * from a cookie the client could have supplied. Every authorization decision in Jamee reads this
 * function, never a session object, so a forged cookie cannot mint an identity.
 */
export async function currentUserId(): Promise<string | null> {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error !== null || data.user === null) return null;
  return data.user.id;
}
