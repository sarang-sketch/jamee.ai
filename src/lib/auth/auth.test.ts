import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the lazy Better Auth factory.
 *
 * Requirements: 1.1, 1.2 (Google sign-in through the library), 13.7 (secrets read through
 *               `serverEnv`, never at module scope)
 * Design: D8, D18a; V30, V35
 *
 * The one behaviour this file guards is the "lazy" in `getAuth()`: importing `src/lib/auth/auth.ts`
 * with NO environment variables set must not throw, because `next build` runs with the production
 * secrets legitimately absent and a module-scope `betterAuth({...})` would fail the build for the
 * wrong reason. `betterAuth` and the MongoDB adapter are mocked so this test asserts *when*
 * construction happens (on first `getAuth()`), not that a real client connects.
 */

/* The adapter and DB client are mocked so nothing tries to reach Mongo or read the driver. */
vi.mock('@/lib/db/auth-adapter', () => ({
  authDatabaseAdapter: () => ({ id: 'mock-adapter' }),
}));

/** The bootstrap hook target — mocked so importing auth.ts pulls in no real DAL/driver. */
vi.mock('@/lib/auth/bootstrap', () => ({
  bootstrapProfile: vi.fn(async () => {}),
}));

/** `betterAuth` is a spy so we can prove it is NOT called at import, only at first `getAuth()`. */
const betterAuthSpy = vi.fn((opts: unknown) => ({ options: opts, api: {} }));
vi.mock('better-auth', () => ({
  betterAuth: (opts: unknown) => betterAuthSpy(opts),
}));

const AUTH_ENV_KEYS = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
] as const;

describe('getAuth() laziness', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    /* Remove every auth env var so a construction-at-import would throw via serverEnv. */
    for (const key of AUTH_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    betterAuthSpy.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of AUTH_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('importing auth.ts with no environment variables set does not throw', async () => {
    /** The load-bearing assertion (task 55.5): the import itself must be side-effect-free of env. */
    await expect(import('./auth')).resolves.toBeDefined();
    /** And nothing was constructed just by importing. */
    expect(betterAuthSpy).not.toHaveBeenCalled();
  });

  it('constructs the instance only on the first getAuth() call, and caches it', async () => {
    const mod = await import('./auth');

    /* With the env set, the first getAuth() constructs; the second returns the cached instance. */
    process.env.BETTER_AUTH_SECRET = 'x'.repeat(32);
    process.env.BETTER_AUTH_URL = 'https://jamee.test';
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';

    const first = mod.getAuth();
    const second = mod.getAuth();

    expect(betterAuthSpy).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('configures exactly the Google social provider and the D8 databaseHooks', async () => {
    process.env.BETTER_AUTH_SECRET = 'x'.repeat(32);
    process.env.BETTER_AUTH_URL = 'https://jamee.test';
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';

    const mod = await import('./auth');
    mod.getAuth();

    const opts = betterAuthSpy.mock.calls[0]?.[0] as {
      socialProviders?: Record<string, unknown>;
      databaseHooks?: { user?: unknown; session?: unknown };
    };

    /* Google only — no email/password provider. */
    expect(Object.keys(opts.socialProviders ?? {})).toEqual(['google']);
    /* Both bootstrap hooks are wired (user creation + defensive on every sign-in). */
    expect(opts.databaseHooks?.user).toBeDefined();
    expect(opts.databaseHooks?.session).toBeDefined();
  });
});
