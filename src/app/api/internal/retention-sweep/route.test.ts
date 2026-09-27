import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JAMEE_MAX_DURATION_SECONDS, PLATFORM_MAX_DURATION_SECONDS } from '@/lib/config/verified';

import { blankComments } from '../../../../../scripts/check-secret-scope';

import { GET, POST, authorizeSweep, maxDuration } from './route';

/**
 * Wiring tests for `src/app/api/internal/retention-sweep/route.ts`.
 *
 * Requirements: 18.12 (no valid secret → HTTP 401, no object deleted, no detail in the body),
 *               18.13 (the endpoint is not reachable by a Farmer session), 18.11 (`maxDuration`)
 * Design: "Media lifecycle and retention" → *Triggering a sweep with no always-on process*
 * Depends on: V21 (the cron issues GET and injects `Authorization: Bearer <CRON_SECRET>`)
 *
 * The sweep itself is stubbed here, and that stub is the point: it is the single door to every
 * deletion on this path, so **"the sweep was not called" is a direct statement that no object was
 * deleted** — which is the half of Requirement 18.12 a status code cannot express.
 * `retention.service.test.ts` drives the real sweep against injected seams.
 */

const spies = vi.hoisted(() => ({ runRetentionSweep: vi.fn() }));

vi.mock('@/services/retention.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/retention.service')>();
  return { ...actual, runRetentionSweep: spies.runRetentionSweep };
});

const SECRET = 'route-test-cron-secret-4d5e6f7a8b';

const REPORT = {
  retentionDays: 7,
  cutoff: '2026-09-13T10:00:00.000Z',
  fullImages: {
    scanned: 2,
    removed: 2,
    stamped: 2,
    alreadyStamped: 0,
    failed: 0,
    limit: 200,
    bounded: false,
  },
  orphans: { scanned: 0, removed: 0, refused: 0, failed: 0, limit: 200, bounded: false },
};

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://jamee.example/api/internal/retention-sweep', { headers });
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  spies.runRetentionSweep.mockReset();
  spies.runRetentionSweep.mockResolvedValue(REPORT);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* ========================================================================== */
/* The gate (Requirement 18.12)                                                 */
/* ========================================================================== */

describe('a request with no valid secret', () => {
  const refusals: readonly [string, Record<string, string>][] = [
    ['no Authorization header at all', {}],
    ['an empty Authorization header', { authorization: '' }],
    ['a different scheme', { authorization: `Basic ${SECRET}` }],
    ['Bearer with no token', { authorization: 'Bearer' }],
    ['Bearer with only whitespace after it', { authorization: 'Bearer   ' }],
    ['the wrong secret', { authorization: 'Bearer not-the-configured-secret-000' }],
    // A near miss: same length, last character changed. A comparison that exited early would be
    // the thing that makes guessing feasible, which is why the primitive is constant-time.
    ['a near-miss secret', { authorization: `Bearer ${SECRET.slice(0, -1)}X` }],
    ['the secret without the Bearer prefix', { authorization: SECRET }],
  ];

  for (const [label, headers] of refusals) {
    it(`gets 401 with an empty body and no sweep — ${label}`, async () => {
      const response = await GET(request(headers));

      expect(response.status).toBe(401);
      expect(await response.text()).toBe('');
      expect(response.headers.get('content-type')).toBeNull();
      expect(spies.runRetentionSweep).not.toHaveBeenCalled();
    });
  }

  it('refuses a POST on the same terms', async () => {
    const response = await POST(request({ authorization: 'Bearer wrong' }));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
    expect(spies.runRetentionSweep).not.toHaveBeenCalled();
  });

  it('answers 401 rather than 500 when CRON_SECRET is not configured, and sweeps nothing', async () => {
    vi.stubEnv('CRON_SECRET', '');

    const response = await GET(request({ authorization: `Bearer ${SECRET}` }));

    // Distinguishing "no secret configured" from "wrong secret" would tell an anonymous caller
    // whether the sweep is armed. The operator gets the reason in the server log instead.
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
    expect(spies.runRetentionSweep).not.toHaveBeenCalled();
  });

  it('decides the same way as a pure function, without a Response in the way', () => {
    expect(authorizeSweep(new Headers(), SECRET)).toEqual({
      ok: false,
      reason: 'header_absent',
    });
    expect(authorizeSweep(new Headers({ authorization: 'Token abc' }), SECRET)).toEqual({
      ok: false,
      reason: 'scheme_not_bearer',
    });
    expect(authorizeSweep(new Headers({ authorization: 'Bearer' }), SECRET)).toEqual({
      ok: false,
      reason: 'token_absent',
    });
    expect(authorizeSweep(new Headers({ authorization: 'Bearer nope' }), SECRET)).toEqual({
      ok: false,
      reason: 'token_mismatch',
    });
    expect(authorizeSweep(new Headers({ authorization: 'Bearer nope' }), undefined)).toEqual({
      ok: false,
      reason: 'secret_not_configured',
    });
    expect(authorizeSweep(new Headers({ authorization: `Bearer ${SECRET}` }), SECRET)).toEqual({
      ok: true,
    });
  });
});

/* ========================================================================== */
/* The two admitted verbs (V21)                                                 */
/* ========================================================================== */

describe('a request carrying the configured secret', () => {
  it('runs the sweep on GET, which is the verb the platform cron issues', async () => {
    const response = await GET(request({ authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(200);
    expect(spies.runRetentionSweep).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({ ok: true, verb: 'GET', ...REPORT });
  });

  it('runs the same sweep on POST, which is the documented manual run', async () => {
    const response = await POST(request({ authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(200);
    expect(spies.runRetentionSweep).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({ ok: true, verb: 'POST' });
  });

  it('accepts the scheme label case-insensitively and tolerates surrounding whitespace', async () => {
    const response = await GET(request({ authorization: `  bearer   ${SECRET}  ` }));

    expect(response.status).toBe(200);
    expect(spies.runRetentionSweep).toHaveBeenCalledTimes(1);
  });

  it('reads no request parameter, so a caller cannot widen the window', async () => {
    await GET(request({ authorization: `Bearer ${SECRET}` }));

    // No deps: the window, the batch bound and the flag are configuration, not request input.
    expect(spies.runRetentionSweep).toHaveBeenCalledWith();
  });

  it('answers 500 with no body when the sweep fails, leaving the retry to the next run', async () => {
    spies.runRetentionSweep.mockRejectedValue(new Error('storage unavailable'));

    const response = await POST(request({ authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('');
  });

  it('never lets a sweep response be cached', async () => {
    const ok = await GET(request({ authorization: `Bearer ${SECRET}` }));
    const refused = await GET(request());

    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(refused.headers.get('cache-control')).toBe('no-store');
  });
});

/* ========================================================================== */
/* Requirements 18.13 and 18.11, structurally                                   */
/* ========================================================================== */

describe('the route as a module', () => {
  // Read off disk rather than through `import.meta.url`: under the jsdom test environment that
  // value is not a `file:` URL. Vitest runs with the project root as its working directory.
  const raw = readFileSync(
    join(process.cwd(), 'src', 'app', 'api', 'internal', 'retention-sweep', 'route.ts'),
    'utf8',
  );

  /**
   * Comments blanked with the CI guard's own function, for the reason that guard exists: this
   * module's header *explains* that it never calls `currentUserId()` and is not wrapped in
   * `authenticatedRoute`, and a sentence about a thing must not read as a use of it.
   */
  const moduleSource = blankComments(raw);

  it('consults no Supabase session, so a farmer session grants nothing (Requirement 18.13)', () => {
    // Call and import syntax rather than bare words: the module's own header explains that it does
    // NOT wrap `authenticatedRoute` or import `createServerSupabase`, and a prose mention must not
    // read as a use. What is asserted is that no session machinery is invoked or imported.
    for (const forbidden of [
      /createServerSupabase\(/,
      /currentUserId\(/,
      /authenticatedRoute\(/,
      /\.auth\./,
      /getUser\(/,
      /cookies\(/,
      /from '@\/lib\/supabase\/server'/,
      /from '@\/lib\/api\/authenticated-route'/,
    ]) {
      expect(moduleSource).not.toMatch(forbidden);
    }
    // Exactly one header is read on this path, and it is the credential.
    expect(moduleSource.match(/headers\.get\(/g) ?? []).toHaveLength(1);
    expect(moduleSource).toContain("headers.get('authorization')");
  });

  it('gates both verbs behind one comparison', () => {
    // Two exported handlers, one `authorizeSweep` call site inside `sweep()`, so there is no second
    // authorization story to keep in step.
    expect(moduleSource.match(/authorizeSweep\(/g) ?? []).toHaveLength(2); // definition + call
    expect(moduleSource).toContain('export async function GET');
    expect(moduleSource).toContain('export async function POST');
  });

  it('compares the secret with the constant-time primitive and never with ===', () => {
    expect(moduleSource).toContain("import { timingSafeEqualStrings } from '@/lib/timing-safe';");
    expect(moduleSource).not.toMatch(/presented\s*[!=]==\s*expectedSecret/);
    expect(moduleSource).not.toMatch(/expectedSecret\s*[!=]==\s*presented/);
  });

  it('declares Jamee’s own duration ceiling (Requirement 18.11, V17)', () => {
    expect(maxDuration).toBe(JAMEE_MAX_DURATION_SECONDS);
    expect(maxDuration).toBeLessThan(PLATFORM_MAX_DURATION_SECONDS);
  });
});
