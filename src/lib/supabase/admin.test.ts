import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Unit tests for the service-role isolation in `src/lib/supabase/admin.ts`.
 *
 * Requirements: 13.7 (the Service_Role_Key is referenced only in server-side modules and is excluded
 *               from every value sent to the browser)
 *
 * ### What this file adds that the property suite does not
 *
 * `tests/property/tenant-isolation.property.test.ts` asserts the RLS policy text in the migrations
 * and the `.eq('user_id', …)` predicates the *adapters* compose — the rule `admin.ts` states, checked
 * at the call sites that obey it. It never imports `admin.ts`, so the three layers that module's own
 * header claims are unowned by it:
 *
 *  1. `import 'server-only'` on line 1, so a `'use client'` importer is a **build** error;
 *  2. the client is built inside a function, so importing the module reads no secret;
 *  3. `assertServerRuntime()` throws when a browser global is present.
 *
 * Layer 3 is directly executable here, and the unit project's `jsdom` environment is what makes it
 * so: `window` exists by default, which is exactly the runtime the guard exists to refuse. Layer 1's
 * *build* failure cannot be observed from a test — `vitest.config.ts` aliases `server-only` onto an
 * empty stub so `src/lib` stays testable at all — so it is asserted as the two facts that make the
 * build-failure claim true and checkable: the marker is present, and nothing that would trip it
 * reaches this module.
 *
 * ### A recorded gap, not fixed here
 *
 * `admin.ts` carries no `Depends on: V<n>` line, and the surface it codes against — `createClient`
 * from `@supabase/supabase-js` with an `auth` options bag — is not the surface V1 resolved: V1 names
 * `createBrowserClient` / `createServerClient` from `@supabase/ssr`. Those two are the *session*
 * factories, and this client deliberately has no session, so the omission looks defensible rather
 * than wrong. It is left as found and reported rather than patched.
 *
 * The consequence for what is asserted below: the argument-level assertions in the last block pin
 * **the surface as it stands**, and would fail if `admin.ts` moved to the V1-named factories. That is
 * the right failure — such a move changes which SDK decides what a session-less client does, and it
 * should be a reviewed change rather than a silent one.
 */

/* -------------------------------------------------------------------------- */
/* A pass-through spy on the SDK factory                                       */
/* -------------------------------------------------------------------------- */

/**
 * `vi.hoisted` because `vi.mock`'s factory is hoisted above the imports, so a plain top-level `const`
 * would be in its temporal dead zone when the factory runs.
 */
const { createClientCalls } = vi.hoisted(() => ({ createClientCalls: [] as unknown[][] }));

/**
 * Records the arguments and then calls the **real** `createClient`. Not a fake: the client that
 * comes back is the SDK's own, so the construction path under test is the production one and only
 * the arguments become observable.
 */
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    createClient: (...args: unknown[]) => {
      createClientCalls.push(args);
      return (actual.createClient as (...a: unknown[]) => unknown)(...args);
    },
  };
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** Obviously synthetic. The factory checks presence and length only, so nothing realistic is needed. */
const SYNTHETIC_SERVICE_ROLE_KEY = 'synthetic-service-role-key-not-a-secret';
const SYNTHETIC_URL = 'https://synthetic-project.supabase.test';
const SYNTHETIC_PUBLISHABLE_KEY = 'synthetic-publishable-key';

/**
 * The factory reads `publicEnv()` for the URL before `serverEnv()` for the key, and `publicEnv()`
 * needs both public values — so the publishable key is part of the fixture even though this client
 * never uses it.
 */
function stubPublicEnv(): void {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SYNTHETIC_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', SYNTHETIC_PUBLISHABLE_KEY);
}

function stubServerRuntime(): void {
  // jsdom defines `window`; removing it is what makes this process look like a server runtime.
  vi.stubGlobal('window', undefined);
  stubPublicEnv();
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SYNTHETIC_SERVICE_ROLE_KEY);
}

function thrownBy(call: () => unknown): Error {
  try {
    call();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected createAdminClient() to throw, but it returned a client');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  createClientCalls.length = 0;
});

/* ========================================================================== */
/* Layer 3 — the browser-global guard                                          */
/* ========================================================================== */

describe('createAdminClient in a browser runtime', () => {
  it('throws, naming the key it is protecting and the requirement', () => {
    // No stubbing at all: the unit project runs on `jsdom`, so `window` is present and this is the
    // browser runtime the guard is written against.
    expect(typeof window).not.toBe('undefined');

    const error = thrownBy(createAdminClient);

    expect(error.message).toContain('createAdminClient()');
    expect(error.message).toContain('browser runtime');
    expect(error.message).toContain('service-role key');
    expect(error.message).toContain('13.7');
  });

  it('refuses before reading the secret, so a browser call cannot even resolve it', () => {
    // The ordering is the substance. `assertServerRuntime()` is the first statement in the factory,
    // so with the credential present *and* a browser global present the answer is still refusal —
    // the guard is not a fallback for a missing variable.
    stubPublicEnv();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SYNTHETIC_SERVICE_ROLE_KEY);

    expect(thrownBy(createAdminClient).message).toContain('browser runtime');
    // And nothing was handed to the SDK, so no object holding the key was ever built.
    expect(createClientCalls).toHaveLength(0);
  });

  it('refuses with no environment configured at all, rather than reporting a missing variable', () => {
    // With the variables cleared, a factory that read the environment first would fail by naming
    // `SUPABASE_SERVICE_ROLE_KEY` — a message that invites an operator to *set* it, in a runtime
    // where setting it is the leak. The guard answers first.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', undefined);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', undefined);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);

    const error = thrownBy(createAdminClient);

    expect(error.message).toContain('browser runtime');
    expect(error.message).not.toContain('is not set');
    expect(error.message).not.toContain('Missing environment variable');
  });

  it('runs the guard on every call, not once at import', () => {
    // The factory is not memoized, which is what keeps the guard a per-use check. A cached client
    // built during one server-side call would be returned to a later browser-side one unchecked.
    expect(thrownBy(createAdminClient).message).toContain('browser runtime');
    expect(thrownBy(createAdminClient).message).toContain('browser runtime');
  });
});

/* ========================================================================== */
/* Layer 2 — importing reads no secret                                         */
/* ========================================================================== */

describe('createAdminClient in a server runtime', () => {
  it('builds a client, and a distinct one each time', () => {
    stubServerRuntime();

    const first = createAdminClient();
    const second = createAdminClient();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Deliberately not memoized: a long-lived singleton would hold the RLS-bypassing key across
    // every request a warm serverless instance serves, and the construction cost is an allocation.
    expect(first).not.toBe(second);
    expect(createClientCalls).toHaveLength(2);
  });

  it('fails by name when the service-role key is absent', () => {
    // Layer 2 in its observable form: `admin.ts` was imported at the top of this file with nothing
    // configured and threw nothing, because the secret is read *inside* the factory. The read then
    // goes through `serverEnv()`, so the failure names the variable rather than handing the SDK an
    // undefined credential.
    vi.stubGlobal('window', undefined);
    stubPublicEnv();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);

    const error = thrownBy(createAdminClient);

    expect(error.message).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(error.message).toContain('is not set');
    expect(createClientCalls).toHaveLength(0);
  });

  it('fails by name when the project URL is absent', () => {
    vi.stubGlobal('window', undefined);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', SYNTHETIC_PUBLISHABLE_KEY);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SYNTHETIC_SERVICE_ROLE_KEY);

    expect(thrownBy(createAdminClient).message).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(createClientCalls).toHaveLength(0);
  });
});

/* ========================================================================== */
/* Layer 1 — the marker, and nothing that would trip it                        */
/* ========================================================================== */

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const ADMIN_MODULE = 'src/lib/supabase/admin.ts';

interface SourceModule {
  /** Repository-relative with POSIX separators, so the assertions are platform-independent. */
  readonly path: string;
  readonly source: string;
}

function collectModules(directory: string, found: SourceModule[] = []): SourceModule[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectModules(full, found);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    found.push({
      path: resolve(full).slice(REPO_ROOT.length + 1).split('\\').join('/'),
      source: readFileSync(full, 'utf8'),
    });
  }
  return found;
}

const MODULES = collectModules(SRC_ROOT);
const BY_PATH = new Map(MODULES.map((entry) => [entry.path, entry]));

/** A `'use client'` directive on its own line, at the top of the file. */
function isClientModule(source: string): boolean {
  return /^\s*(['"])use client\1\s*;?\s*$/m.test(source.split('\n').slice(0, 5).join('\n'));
}

/**
 * Every `@/…` specifier one source file depends on, static and dynamic alike.
 *
 * Both edge kinds count because `server-only` is enforced at *resolution*, not at call time: a
 * `'use client'` file reaching this one either way is a build error. Relative specifiers are absent
 * from `src/**` by convention (the `@` alias is used throughout), so the alias form is the whole
 * graph.
 */
function dependenciesOf(source: string): string[] {
  const found = new Set<string>();
  const pattern = /(?:from\s*|import\s*\(\s*)['"](@\/[^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) found.add(specifier);
  }
  return [...found];
}

/** `@/lib/supabase/admin` → the repository path it resolves to, or `undefined` if it is not a file. */
function resolveSpecifier(specifier: string): string | undefined {
  const base = `src/${specifier.slice('@/'.length)}`;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (BY_PATH.has(candidate)) return candidate;
  }
  return undefined;
}

/** Every source file that reaches `admin.ts`, directly or through any chain of imports. */
function modulesReaching(target: string): Set<string> {
  const reaching = new Set<string>();
  let grew = true;

  while (grew) {
    grew = false;
    for (const entry of MODULES) {
      if (reaching.has(entry.path)) continue;
      const reaches = dependenciesOf(entry.source).some((specifier) => {
        const resolved = resolveSpecifier(specifier);
        return resolved === target || (resolved !== undefined && reaching.has(resolved));
      });
      if (reaches) {
        reaching.add(entry.path);
        grew = true;
      }
    }
  }

  return reaching;
}

describe('the server-only marker', () => {
  it('is the first statement of admin.ts', () => {
    const admin = BY_PATH.get(ADMIN_MODULE);
    expect(admin, `${ADMIN_MODULE} was not found`).toBeDefined();
    if (admin === undefined) return;

    const firstStatement = admin.source
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('//') && !line.startsWith('/*'));

    // Not decorative. This line is the entire mechanism behind "importing this from a client
    // component is a build error"; the runtime guard below it is the belt to this braces.
    expect(firstStatement).toBe("import 'server-only';");
  });

  it('is not carried by env.public.ts, which the browser client legitimately needs', () => {
    // The split that makes the marker usable: if the two public values lived behind it, the sign-in
    // screen would be a build error and someone would remove the marker to fix the screen.
    //
    // Matched as a statement rather than as a substring: `env.public.ts` *documents* the marker at
    // length ("`env.ts` begins with `import 'server-only'`…"), so a `toContain` would read its own
    // explanation of why it has no marker as a marker.
    const markerStatement = /^\s*import\s*(['"])server-only\1\s*;?\s*$/m;

    const publicEnv = BY_PATH.get('src/lib/env.public.ts');
    expect(publicEnv, 'src/lib/env.public.ts was not found').toBeDefined();
    expect(publicEnv?.source).not.toMatch(markerStatement);
    expect(BY_PATH.get('src/lib/env.ts')?.source).toMatch(markerStatement);
    expect(BY_PATH.get(ADMIN_MODULE)?.source).toMatch(markerStatement);
  });
});

describe('nothing under a use-client directive reaches the admin module', () => {
  it('holds directly and transitively', () => {
    const reaching = modulesReaching(ADMIN_MODULE);
    const clientImporters = [...reaching].filter((path) => {
      const entry = BY_PATH.get(path);
      return entry !== undefined && isClientModule(entry.source);
    });

    // The build-failure claim, stated as the fact that keeps the build passing: everything in the
    // import closure of `admin.ts` is a server module. A `'use client'` file appearing here is the
    // failure — and it would be a `next build` failure long before it was a leak.
    expect(clientImporters).toStrictEqual([]);
  });

  it('is a claim about a closure that is actually populated', () => {
    const reaching = modulesReaching(ADMIN_MODULE);

    // Non-vacuity, in both directions. The graph really found the direct importers…
    expect(reaching).toContain('src/services/quota.service.ts');
    expect(reaching).toContain('src/lib/rate-limit.ts');
    expect(reaching).toContain('src/lib/db/whatsapp-inbound.ts');
    // …and really walked past them, so the transitive half of the assertion above has work to do.
    expect(reaching.size).toBeGreaterThan(5);
    expect(reaching.has(ADMIN_MODULE)).toBe(false);

    // …while the client components that exist were seen and classified, so the filter above is not
    // silently matching nothing.
    const clientModules = MODULES.filter((entry) => isClientModule(entry.source));
    expect(clientModules.length).toBeGreaterThan(5);
    expect(clientModules.map((entry) => entry.path)).toContain('src/components/SignInForm.tsx');
  });

  it('keeps the four service-role consumers reaching it lazily where construction is deferred', () => {
    // `diagnosis`, `chat`, `voice` and `retention` reach `admin.ts` through `await import(...)`
    // inside their default-store factories rather than a top-level import. That is not about the
    // marker — all four are server modules — it is so constructing a service with injected stores
    // never reads `SUPABASE_SERVICE_ROLE_KEY` at all, which is what lets every unit test in this
    // repository exercise them without a credential.
    for (const path of [
      'src/services/diagnosis.service.ts',
      'src/services/chat.service.ts',
      'src/services/voice.service.ts',
      'src/services/retention.service.ts',
    ]) {
      const source = BY_PATH.get(path)?.source;
      expect(source, `${path} was not found`).toBeDefined();
      expect(source).toContain("await import('@/lib/supabase/admin')");
      expect(source).not.toContain("from '@/lib/supabase/admin'");
    }
  });
});

/* ========================================================================== */
/* The session discipline                                                      */
/* ========================================================================== */

describe('what the admin client is constructed with', () => {
  it('holds no session and never acquires one', () => {
    stubServerRuntime();
    createAdminClient();

    const call = createClientCalls[0];
    expect(call, 'the SDK factory was not called').toBeDefined();
    if (call === undefined) return;

    expect(call[0]).toBe(SYNTHETIC_URL);
    expect(call[1]).toBe(SYNTHETIC_SERVICE_ROLE_KEY);

    // These three matter more than they look. Left at their defaults the SDK would keep session
    // state on an object that authenticates as the service role, so a later `auth.getUser()` on it
    // could report an identity with nothing to do with the caller.
    expect(call[2]).toMatchObject({
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  });

  it('labels itself in the provider’s own logs', () => {
    stubServerRuntime();
    createAdminClient();

    // How an accidental service-role read gets noticed rather than blending into farmer traffic.
    expect(createClientCalls[0]?.[2]).toMatchObject({
      global: { headers: { 'x-jamee-client': 'service-role' } },
    });
  });
});
