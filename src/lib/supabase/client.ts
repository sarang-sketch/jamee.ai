'use client';

import { createBrowserClient } from '@supabase/ssr';

import { publicEnv } from '@/lib/env.public';
import type { Database } from '@/types/database';

/**
 * Browser Supabase client, on the public key. RLS is what authorizes it.
 *
 * Requirements: 13.7 (no service-role key reaches the browser), 2.1 / 8.1 (direct browser upload)
 * Depends on: V1 — `createBrowserClient(url, key)` from `@supabase/ssr`
 *
 * This client does exactly three things in Jamee, all of which the storage and RLS policies
 * independently constrain:
 *  - phone OTP sign-in (`signInWithOtp`, `verifyOtp`),
 *  - direct object upload under `{user_id}/…`, and
 *  - reading the caller's own rows where a client component needs them.
 *
 * A tampered client cannot exceed any of that: `crop_images_insert_own` in migration 0009 checks
 * the path's first segment against `auth.uid()` in the database, so the browser choosing its own
 * path is safe by construction rather than by the component behaving.
 */
export function createClient() {
  const { supabaseUrl, supabaseAnonKey } = publicEnv();
  return createBrowserClient<Database>(supabaseUrl, supabaseAnonKey);
}
