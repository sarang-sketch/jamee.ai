import { describe } from 'vitest';

/**
 * Integration tests need a real Postgres (design: "Integration tests — mocked providers,
 * real Postgres"). The connection string comes from `JAMEE_TEST_DATABASE_URL`.
 *
 * When that variable is absent the suite is SKIPPED, not failed: a developer without a
 * local database still gets a green `npm run test`, and CI opts in by setting the
 * variable. Every integration suite must use `describeIntegration` rather than `describe`
 * so the gate applies uniformly.
 *
 * =============================================================================
 * STARTING THE STACK THESE TESTS RUN AGAINST
 * =============================================================================
 *
 * The harness talks to a **local Supabase stack**, not to a bare Postgres: RLS is evaluated
 * against `auth.uid()`, which only exists when a request carries a real session JWT, and minting
 * one needs the Auth service. The Postgres URL below stays the *gate* because it is the one
 * variable `.env.example` and `docs/DEPLOYMENT.md` already document, and because a stack whose
 * database is up has the rest of it up too.
 *
 * ```sh
 * # 1. Normally a no-op: supabase/config.toml IS committed, so the CLI is already initialized and
 * #    `supabase start` works on a fresh clone. Run this only if `start` complains that the project
 * #    is not initialized, and then answer "N" to overwriting anything under supabase/ — the
 * #    committed config carries this repository's ports and its [auth.sms] setting.
 * npx supabase init
 *
 * # 2. Start Postgres, Auth, PostgREST and Storage, then apply supabase/migrations in order.
 * #    `db reset` is what seeds the five verified conditions (0010) — the harness asserts they
 * #    are present and never inserts its own.
 * npx supabase start
 * npx supabase db reset
 *
 * # 3. Print the URL and keys this harness reads, and put them in .env.local.
 * npx supabase status -o env
 * ```
 *
 * Then set, in `.env.local`:
 *
 * ```
 * JAMEE_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 * NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
 * NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY from step 3>
 * SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from step 3>
 * ```
 *
 * `npm run test:integration` runs the suite. **Never set `JAMEE_TEST_DATABASE_URL` in
 * production** — `docs/DEPLOYMENT.md` says why, and nothing here is loaded by the application.
 */
export const TEST_DATABASE_URL_VAR = 'JAMEE_TEST_DATABASE_URL';

export function testDatabaseUrl(): string | undefined {
  const value = process.env[TEST_DATABASE_URL_VAR];
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

export const hasTestDatabase: boolean = testDatabaseUrl() !== undefined;

/**
 * `describe` when a test database is configured, `describe.skip` otherwise.
 */
export const describeIntegration: typeof describe | typeof describe.skip =
  hasTestDatabase ? describe : describe.skip;

/**
 * Use inside a gated suite where the URL is known to be present.
 */
export function requireTestDatabaseUrl(): string {
  const url = testDatabaseUrl();
  if (url === undefined) {
    throw new Error(
      `${TEST_DATABASE_URL_VAR} is not set. Integration tests require a real Postgres connection string.`,
    );
  }
  return url;
}

/* ========================================================================== */
/* The rest of the stack: API URL and keys                                     */
/* ========================================================================== */

/**
 * The variable names are the **application's own**, not test-only aliases.
 *
 * Two reasons. A developer who has configured `.env.local` to run `npm run dev` against a local
 * stack has already set all three, so opting into the integration suite is one extra variable
 * rather than four. And every production default path — `createAdminClient()`, `publicEnv()` —
 * reads these same names, so a service the harness calls without an injected client behaves the
 * way it behaves in production instead of the way a test alias made it behave.
 */
export const SUPABASE_API_URL_VAR = 'NEXT_PUBLIC_SUPABASE_URL';
export const SUPABASE_PUBLISHABLE_KEY_VAR = 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY';
export const SUPABASE_ANON_KEY_VAR = 'NEXT_PUBLIC_SUPABASE_ANON_KEY';
export const SUPABASE_SERVICE_ROLE_KEY_VAR = 'SUPABASE_SERVICE_ROLE_KEY';

/** The Supabase CLI's default API port. Its default database port is 54322. */
export const LOCAL_SUPABASE_API_PORT = 54321;

export interface SupabaseTestConfig {
  /** The gate value — carried through so a failure can quote what it was pointed at. */
  readonly databaseUrl: string;
  /** PostgREST / Auth / Storage base URL. */
  readonly apiUrl: string;
  /** The public key. RLS is what authorizes a request made with it. */
  readonly anonKey: string;
  /** RLS-bypassing. Used to seed a row the RLS-scoped clients then fail to reach. */
  readonly serviceRoleKey: string;
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * The host of a Postgres URL, or `undefined` when it does not parse.
 *
 * `new URL()` handles a non-special scheme with an authority, and the regular expression is the
 * fallback for a connection string it rejects (a socket path, an unusual escape). Returning
 * `undefined` rather than guessing keeps the failure a named-variable error instead of a connection
 * refused against a host nobody chose.
 */
export function hostOfDatabaseUrl(databaseUrl: string): string | undefined {
  try {
    const { hostname } = new URL(databaseUrl);
    if (hostname !== '') return hostname;
  } catch {
    /* fall through to the pattern below */
  }
  const matched = /@([^/@:]+)(?::\d+)?(?:\/|$)/.exec(databaseUrl);
  return matched?.[1];
}

/**
 * The API URL implied by the database URL, for the local stack's default port layout.
 *
 * A convenience, not an assumption that survives contradiction: `NEXT_PUBLIC_SUPABASE_URL` always
 * wins when it is set, which is what lets the same harness run against a hosted project.
 */
export function apiUrlFromDatabaseUrl(databaseUrl: string): string | undefined {
  const host = hostOfDatabaseUrl(databaseUrl);
  return host === undefined ? undefined : `http://${host}:${LOCAL_SUPABASE_API_PORT}`;
}

function configurationHelp(missing: readonly string[]): string {
  return [
    `${TEST_DATABASE_URL_VAR} is set, so the integration suite is opted in — but ${missing.join(', ')} `,
    'is missing, and the suite cannot reach the Auth and PostgREST endpoints without it.',
    '',
    'Start the stack and print its values:',
    '',
    '  npx supabase init      # once per clone — the repository ships no supabase/config.toml',
    '  npx supabase start',
    '  npx supabase db reset  # applies supabase/migrations, including the 0010 seed rows',
    '  npx supabase status -o env',
    '',
    `Then set ${SUPABASE_API_URL_VAR}, ${SUPABASE_ANON_KEY_VAR} (or ${SUPABASE_PUBLISHABLE_KEY_VAR}) `,
    `and ${SUPABASE_SERVICE_ROLE_KEY_VAR} in .env.local. Unset ${TEST_DATABASE_URL_VAR} to skip the `,
    'suite instead.',
  ].join('\n');
}

/**
 * Every value the harness needs, or a failure that says what to set and how to get it.
 *
 * This **throws rather than skips**, and the asymmetry with `describeIntegration` is deliberate:
 * absence of the database URL means "this developer has no stack", which is a supported state, while
 * its presence alongside missing keys means "this developer meant to run these tests and the setup
 * is half done" — silently skipping that would report a green run for a suite that never executed.
 */
export function requireSupabaseTestConfig(): SupabaseTestConfig {
  const databaseUrl = requireTestDatabaseUrl();
  const apiUrl = envValue(SUPABASE_API_URL_VAR) ?? apiUrlFromDatabaseUrl(databaseUrl);
  const anonKey = envValue(SUPABASE_PUBLISHABLE_KEY_VAR) ?? envValue(SUPABASE_ANON_KEY_VAR);
  const serviceRoleKey = envValue(SUPABASE_SERVICE_ROLE_KEY_VAR);

  const missing: string[] = [];
  if (apiUrl === undefined) missing.push(SUPABASE_API_URL_VAR);
  if (anonKey === undefined) {
    missing.push(`${SUPABASE_PUBLISHABLE_KEY_VAR} (or ${SUPABASE_ANON_KEY_VAR})`);
  }
  if (serviceRoleKey === undefined) missing.push(SUPABASE_SERVICE_ROLE_KEY_VAR);

  if (apiUrl === undefined || anonKey === undefined || serviceRoleKey === undefined) {
    throw new Error(configurationHelp(missing));
  }

  return { databaseUrl, apiUrl, anonKey, serviceRoleKey };
}
