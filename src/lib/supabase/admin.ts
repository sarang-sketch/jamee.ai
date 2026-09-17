import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { publicEnv } from '@/lib/env.public';
import { serverEnv } from '@/lib/env';
import type { Database } from '@/types/database';

/**
 * The service-role client. **Bypasses row-level security and the storage path policies entirely.**
 *
 * Requirements: 13.7 (the Service_Role_Key is referenced only in server modules and never sent to
 *               the browser), 8.11 and 18.9 (deletions run server-side with this key)
 * Design: "Security boundary — Defence in depth"
 *
 * =============================================================================
 * THE RULE FOR EVERY QUERY MADE WITH THIS CLIENT
 * =============================================================================
 *
 * **Every service-role query carries an explicit `user_id` predicate. One without it is a defect.**
 *
 * RLS is Jamee's primary authorization boundary, and this client is outside it. So for the three
 * paths that legitimately need it — the WhatsApp adapter (a webhook carries no farmer session), the
 * quota counter functions, and the retention sweep — the APPLICATION CHECK IS THE BOUNDARY, and
 * there is nothing behind it. A missing `.eq('user_id', …)` here is not a performance issue or a
 * style preference; it is a cross-tenant read.
 *
 * For deletion specifically, the same predicate applies to a second verb: the retention sweep
 * asserts that an object path's first segment equals the owning row's `user_id` before issuing a
 * delete (Requirement 18.8), and a mismatch is a hard error rather than a skipped row — because a
 * mismatch means either the path convention or the row is corrupt, and continuing would risk
 * deleting across tenants.
 *
 * =============================================================================
 * THREE LAYERS KEEP THE KEY OUT OF THE BROWSER
 * =============================================================================
 *
 *  1. `import 'server-only'` on line 1 — importing this module from a `'use client'` module is a
 *     BUILD error, not a runtime surprise.
 *  2. The client is constructed INSIDE a function, never at module scope, so merely importing this
 *     file does not read the secret.
 *  3. `assertServerRuntime()` throws when a browser global is present — a belt-and-braces check
 *     against a bundler configuration that defeated layer 1.
 *
 * Plus a fourth outside this file: `scripts/check-secret-scope.ts` (task 27.1) fails CI if
 * `SUPABASE_SERVICE_ROLE_KEY` appears anywhere but here.
 */

export type AdminClient = SupabaseClient<Database>;

function assertServerRuntime(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'createAdminClient() was called in a browser runtime. The service-role key must never ' +
        'reach the client (Requirement 13.7). Import this module only from a server module.',
    );
  }
}

/**
 * Build a service-role client.
 *
 * Not memoized, deliberately. A module-level singleton would be a long-lived object holding the
 * RLS-bypassing key across every request a warm serverless instance serves, and the construction
 * cost is a plain object allocation — there is nothing to save. Per-call construction also means
 * `assertServerRuntime()` runs on every use rather than once.
 *
 * `persistSession: false` and `autoRefreshToken: false` matter more than they look: this client
 * has no user session and must never acquire one. Left at their defaults, the SDK would keep
 * session state on an object that authenticates as the service role — so a later
 * `auth.getUser()` on it could report an identity that has nothing to do with the caller.
 */
export function createAdminClient(): AdminClient {
  assertServerRuntime();

  const { supabaseUrl } = publicEnv();
  const serviceRoleKey = serverEnv('SUPABASE_SERVICE_ROLE_KEY');

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        // Makes a service-role query identifiable in Supabase's own logs, which is how an
        // accidental service-role read gets noticed rather than blending into farmer traffic.
        'x-jamee-client': 'service-role',
      },
    },
  });
}
