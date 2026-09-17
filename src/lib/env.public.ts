/**
 * The two public environment variables, readable from the browser AND the server.
 *
 * Requirements: 13.7 (only `NEXT_PUBLIC_`-prefixed values reach the browser)
 * Depends on: V1
 *
 * ### Why this is a separate file from `src/lib/env.ts`
 *
 * `env.ts` begins with `import 'server-only'`, which makes importing it from a client component a
 * BUILD error — that is the mechanical guarantee behind Requirement 13.7 and must not be weakened.
 * But the browser Supabase client legitimately needs the URL and the public key. Putting them here
 * keeps both properties: secrets are unreachable from the browser, and the two non-secrets are
 * reachable without a `server-only` escape hatch.
 *
 * Nothing in this file is a secret. The Supabase URL is a public endpoint and the public key
 * carries no privilege of its own — RLS is what authorizes requests made with it.
 *
 * ### Why these are literal `process.env.X` reads
 *
 * Next.js inlines `NEXT_PUBLIC_*` into the client bundle by **static textual substitution** at
 * build time. A computed lookup (`process.env[name]`) is not substituted, so it reads as
 * `undefined` in the browser. That is why this file cannot use the table-driven shape `env.ts`
 * uses for server variables, and why the names appear as literals below.
 *
 * `scripts/check-secret-scope.ts` (task 27.1) allows `process.env` in exactly two files — this one
 * and `env.ts` — and fails CI on any other occurrence.
 */

const URL_VAR = 'NEXT_PUBLIC_SUPABASE_URL';

/**
 * V1 records that current Supabase docs name the public key
 * `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, while the design's security-boundary table and older
 * projects use `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Both are accepted, publishable first: a project
 * created on either side of that rename should work unchanged, and requiring one spelling would
 * make a correctly configured project fail for a naming reason.
 */
const PUBLISHABLE_KEY_VAR = 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY';
const ANON_KEY_VAR = 'NEXT_PUBLIC_SUPABASE_ANON_KEY';

export const PUBLIC_ENV_VARS = [URL_VAR, PUBLISHABLE_KEY_VAR, ANON_KEY_VAR] as const;

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

export interface PublicEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

/**
 * Throws — naming the variable — when either value is absent.
 *
 * Failing here rather than passing `undefined` through matters because the downstream failure is
 * much worse than the message suggests: `createBrowserClient(undefined, undefined)` throws about a
 * malformed URL from inside the SDK, several frames from the actual cause, in the browser console
 * of a farmer's phone.
 */
export function publicEnv(): PublicEnv {
  const supabaseUrl = nonEmpty(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const supabaseAnonKey =
    nonEmpty(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) ??
    nonEmpty(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  if (supabaseUrl === undefined) {
    throw new Error(
      `Missing environment variable ${URL_VAR}. See .env.example and docs/DEPLOYMENT.md step 1.`,
    );
  }
  if (supabaseAnonKey === undefined) {
    throw new Error(
      `Missing environment variable ${PUBLISHABLE_KEY_VAR} (or its older name ${ANON_KEY_VAR}). ` +
        'See .env.example and docs/DEPLOYMENT.md step 1.',
    );
  }

  return { supabaseUrl, supabaseAnonKey };
}

/** Non-throwing probe, for a health check that wants to report every gap at once. */
export function hasPublicEnv(): boolean {
  try {
    publicEnv();
    return true;
  } catch {
    return false;
  }
}
