import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database';

import { requireSupabaseTestConfig, type SupabaseTestConfig } from './database';

/**
 * The two credentials an integration test holds, and nothing in between.
 *
 * Requirements: 13.1 (RLS enabled on every farmer-scoped table), 13.2 (an authenticated farmer
 *               reaches only their own rows), 13.7 (the service-role key stays server-side)
 * Design: "Security boundary — Defence in depth"; "Integration tests — mocked providers, real
 *         Postgres" (*"RLS is verified by attempting cross-farmer reads with a second farmer's
 *         session and asserting zero rows"*)
 *
 * =============================================================================
 * WHY THE HARNESS BUILDS ITS OWN CLIENTS INSTEAD OF CALLING THE APPLICATION'S
 * =============================================================================
 *
 * `src/lib/supabase/server.ts` reads request cookies through `next/headers`, which has no meaning
 * outside a request scope, and `src/lib/supabase/admin.ts` builds exactly the client
 * `serviceRoleClient()` builds below. So the anon-key client here is not a *substitute* for the
 * production one — it is the same SDK with the same key, holding a session that a test minted
 * instead of one a browser cookie carried. Everything that decides authorization afterwards —
 * every policy in `supabase/migrations/0002`–`0008` — is the real thing.
 *
 * The two clients differ in exactly one way that matters: requests made with `anonClient()` after a
 * sign-in carry the farmer's JWT, so `auth.uid()` is that farmer and RLS applies; requests made
 * with `serviceRoleClient()` carry no session and RLS does not apply at all. That asymmetry is what
 * makes a cross-tenant assertion possible: the service role seeds the row, and the other farmer's
 * session fails to see it.
 */
export type TestClient = SupabaseClient<Database>;

/**
 * No session state on any harness client.
 *
 * `persistSession: false` keeps the token in memory: two farmers in one test file would otherwise
 * share the SDK's storage and the second sign-in would overwrite the first, which turns a
 * tenant-isolation assertion into an assertion about whoever signed in last. That failure would
 * look like a policy bug and is not one.
 */
const IN_MEMORY_SESSION = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const;

/**
 * The RLS-bypassing client. Used to seed a row, to create a farmer, and to clean up — never to
 * assert that a farmer can read something, because it proves nothing about a policy.
 */
export function serviceRoleClient(
  config: SupabaseTestConfig = requireSupabaseTestConfig(),
): TestClient {
  return createClient<Database>(config.apiUrl, config.serviceRoleKey, {
    auth: IN_MEMORY_SESSION,
    global: { headers: { 'x-jamee-client': 'integration-service-role' } },
  });
}

/**
 * A client with the public key and no session yet. Sign in on it to make it RLS-scoped.
 *
 * One client per farmer, for the storage reason above.
 */
export function anonClient(config: SupabaseTestConfig = requireSupabaseTestConfig()): TestClient {
  return createClient<Database>(config.apiUrl, config.anonKey, {
    auth: IN_MEMORY_SESSION,
    global: { headers: { 'x-jamee-client': 'integration-farmer' } },
  });
}
