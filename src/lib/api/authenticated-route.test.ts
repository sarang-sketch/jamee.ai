import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { messages } from '@/lib/messages';
import { errorEnvelopeSchema } from '@/lib/schemas';

import {
  buildAuthenticatedRoute,
  envelopeLanguage,
  type FarmerSession,
  type UserIdResolver,
} from './authenticated-route';

/**
 * Unit tests for the API half of the auth gate.
 *
 * Requirements: 1.7 (no valid session → HTTP 401), 13.2, 15.3, 15.6
 * Design: "Security boundary" — defence in depth; "Error taxonomy"
 *
 * The substantive claim under test is not "a 401 comes back" — it is **"no domain service was
 * invoked"**. So every unauthenticated case below runs a handler that is a tripwire: it records
 * that it was entered and then throws. If the guard ever calls it, the recorded call fails the
 * assertion and the 401 assertion fails alongside it, because the throw would have become a 500.
 *
 * The identity resolver is a stub rather than a mocked Supabase client. That is the seam the guard
 * is built on (`buildAuthenticatedRoute`), so nothing here fakes the thing under test: the resolver
 * models exactly the two answers a real `getUser()` gives the guard — a user id, or `null`.
 * Whether `getUser()` itself is server-confirmed is V1's claim and `lib/supabase/server.ts`'s
 * responsibility, and task 29.1's harness is where a real session round trip belongs.
 */

const USER = '11111111-1111-4111-8111-111111111111';

/* ========================================================================== */
/* Tripwires                                                                   */
/* ========================================================================== */

/**
 * A stand-in for the things Requirement 1.7 says must not run: `DiagnosisService.analyze`, a
 * quota reserve, a provider call. Every entry in this array is a violation.
 */
interface DomainCall {
  service: string;
  userId: string;
}

function tripwireHandler(calls: DomainCall[], service: string) {
  return async (_request: Request, session: FarmerSession): Promise<Response> => {
    calls.push({ service, userId: session.userId });
    throw new Error(
      `tripwire: ${service} was reached for ${session.userId} — the session check did not run first`,
    );
  };
}

const noSession: UserIdResolver = async () => null;
const withSession: UserIdResolver = async () => USER;

function post(url = 'https://jamee.test/api/diagnose', headers: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', headers });
}

/* ========================================================================== */
/* No session                                                                  */
/* ========================================================================== */

describe('authenticatedRoute with no session', () => {
  it('returns 401 with the AUTH_REQUIRED envelope and never enters the handler', async () => {
    const calls: DomainCall[] = [];
    const route = buildAuthenticatedRoute(noSession)<Request>(
      tripwireHandler(calls, 'DiagnosisService.analyze'),
    );

    const response = await route(post());

    /** Requirement 1.7's status, and Requirement 15.3's envelope shape around it. */
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/json');

    const body = errorEnvelopeSchema.parse(await response.json());
    expect(body.error.code).toBe('AUTH_REQUIRED');
    expect(body.error.message).toBe(messages('en').errors.AUTH_REQUIRED);
    /** No amount of retrying fixes a missing session — Requirement 15.4 forbids the button. */
    expect(body.error.retryable).toBe(false);

    /** The clause that matters: not one domain service was invoked. */
    expect(calls).toEqual([]);
  });

  it('invokes no service even when the handler would reserve quota before anything else', async () => {
    /**
     * Ordering, stated as a test. A handler whose FIRST act is a quota reserve is the worst case
     * for Requirement 14.2's spend rule: a reserve that ran for an anonymous caller would either
     * charge a stranger's counter or charge nobody's. The guard makes the case unreachable, so
     * both the reserve and the analyze tripwire stay unrecorded.
     */
    const calls: DomainCall[] = [];
    const route = buildAuthenticatedRoute(noSession)<Request>(async (request, session) => {
      calls.push({ service: 'QuotaService.reserve', userId: session.userId });
      return tripwireHandler(calls, 'AiGateway.classify')(request, session);
    });

    const response = await route(post());

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('renders the refusal in the language the request asks for, without reading the body', async () => {
    /**
     * The body is where the language code lives (Requirement 2.2), and an unauthenticated request's
     * body is never parsed — so the 401 is written from the URL and the headers. The assertion that
     * proves the body was untouched is `bodyUsed`.
     */
    const calls: DomainCall[] = [];
    const route = buildAuthenticatedRoute(noSession)<Request>(tripwireHandler(calls, 'ChatService'));

    const request = new Request('https://jamee.test/api/chat?language=hi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'mr', message: 'hello' }),
    });
    const response = await route(request);
    const body = errorEnvelopeSchema.parse(await response.json());

    expect(response.status).toBe(401);
    expect(body.error.language).toBe('hi');
    expect(body.error.message).toBe(messages('hi').errors.AUTH_REQUIRED);
    expect(request.bodyUsed).toBe(false);
    expect(calls).toEqual([]);
  });

  it('treats an unreachable auth service as an internal error and still runs nothing', async () => {
    /**
     * A resolver that THROWS is not the same fact as a resolver that returns `null`, and the guard
     * does not flatten one into the other: a failed identity check is Jamee's problem (500,
     * Requirement 15.6), not the farmer's (401). What both share is the part that matters — the
     * handler does not run.
     */
    const calls: DomainCall[] = [];
    const route = buildAuthenticatedRoute(async () => {
      throw new Error('auth service unreachable');
    })<Request>(tripwireHandler(calls, 'DiagnosisService.analyze'));

    const response = await route(post());
    const body = errorEnvelopeSchema.parse(await response.json());

    expect(response.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(calls).toEqual([]);
  });
});

/* ========================================================================== */
/* With a session                                                              */
/* ========================================================================== */

describe('authenticatedRoute with a session', () => {
  it('calls the handler once with the resolved user id and returns its response unchanged', async () => {
    const seen: FarmerSession[] = [];
    const handlerResponse = new Response(JSON.stringify({ ok: true }), { status: 201 });

    const route = buildAuthenticatedRoute(withSession)<Request>(async (_request, session) => {
      seen.push(session);
      return handlerResponse;
    });

    const response = await route(post());

    expect(response).toBe(handlerResponse);
    expect(response.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.userId).toBe(USER);
  });

  it('passes the request through untouched, body included', async () => {
    /**
     * The guard reads `url` and `headers` for the envelope language and nothing else. A handler
     * that needs the JSON body must find it unconsumed, or every protected route would have to
     * work around the gate to read its own input.
     */
    const request = new Request('https://jamee.test/api/diagnose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'mr' }),
    });

    const route = buildAuthenticatedRoute(withSession)<Request>(async (received, session) => {
      const parsed: unknown = await received.json();
      return Response.json({ parsed, userId: session.userId });
    });

    const response = await route(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ parsed: { language: 'mr' }, userId: USER });
  });

  it('leaves a handler failure to the shared envelope rather than swallowing it', async () => {
    const route = buildAuthenticatedRoute(withSession)<Request>(async () => {
      throw new Error('provider exploded');
    });

    const response = await route(post());
    const body = errorEnvelopeSchema.parse(await response.json());

    expect(response.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    /** Requirement 15.6: the real cause is logged server-side, never rendered. */
    expect(body.error.message).not.toContain('provider exploded');
  });
});

/* ========================================================================== */
/* envelopeLanguage                                                            */
/* ========================================================================== */

describe('envelopeLanguage', () => {
  it('prefers an explicit ?language= over the browser header', () => {
    expect(envelopeLanguage(post('https://jamee.test/api/chat?language=mr', {
      'accept-language': 'hi-IN,hi;q=0.9',
    }))).toBe('mr');
  });

  it('falls back to the first supported Accept-Language tag', () => {
    expect(envelopeLanguage(post('https://jamee.test/api/chat', {
      'accept-language': 'hi-IN,en;q=0.9',
    }))).toBe('hi');
    expect(envelopeLanguage(post('https://jamee.test/api/chat', {
      'accept-language': 'fr-FR,mr;q=0.7',
    }))).toBe('mr');
  });

  it('falls back to en rather than refusing an unsupported code', () => {
    /** `LANGUAGE_UNSUPPORTED` is task 16.2's judgement about an authenticated request, not this. */
    expect(envelopeLanguage(post('https://jamee.test/api/chat?language=ta'))).toBe('en');
    expect(envelopeLanguage(post('https://jamee.test/api/chat', {
      'accept-language': 'fr-FR,de;q=0.8',
    }))).toBe('en');
    expect(envelopeLanguage(post())).toBe('en');
  });
});

/* ========================================================================== */
/* The static half: a protected endpoint cannot be written without the wrapper  */
/* ========================================================================== */

const HTTP_VERBS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';

/** Any exported HTTP method, however it is written. */
const EXPORTED_VERB = new RegExp(
  String.raw`export\s+(?:async\s+function|function|const|let|var)\s+(${HTTP_VERBS})\b`,
  'g',
);

/** The one form that carries the gate: `export const POST = authenticatedRoute(...)`. */
const GUARDED_VERB = new RegExp(
  String.raw`export\s+const\s+(${HTTP_VERBS})\s*(?::[^=]+)?=\s*authenticatedRoute\s*[(<]`,
  'g',
);

function matches(pattern: RegExp, source: string): string[] {
  return [...source.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

/**
 * Which exported HTTP methods of a route module are NOT produced by the wrapper — plus the two
 * import-level ways of escaping it.
 *
 * Requirement 1.7 has to survive tasks 11.3, 15.3 and 18.3, all of which write route handlers this
 * file cannot see. A structural check is the only kind of test that can fail on code that does not
 * exist yet, so this is the mechanism that makes the wrapper mandatory rather than customary.
 */
function guardViolations(source: string): string[] {
  const exported = matches(EXPORTED_VERB, source);
  const guarded = new Set(matches(GUARDED_VERB, source));
  const violations = exported.filter((verb) => !guarded.has(verb));

  if (exported.length > 0 && !source.includes('@/lib/api/authenticated-route')) {
    violations.push('missing import of @/lib/api/authenticated-route');
  }
  /** The test-only seam. A route that resolves its own identity chooses who is signed in. */
  if (source.includes('buildAuthenticatedRoute')) {
    violations.push('imports buildAuthenticatedRoute, which bypasses the session check');
  }
  return violations;
}

describe('guardViolations', () => {
  const GOOD = `
    import { authenticatedRoute } from '@/lib/api/authenticated-route';
    export const maxDuration = 60;
    export const POST = authenticatedRoute(async (request, session) => Response.json(session));
  `;

  it('accepts a handler produced by the wrapper', () => {
    expect(guardViolations(GOOD)).toEqual([]);
  });

  it('rejects a plain exported function', () => {
    const source = `
      export async function POST(request: NextRequest) { return Response.json({}); }
    `;
    expect(guardViolations(source)).toContain('POST');
  });

  it('rejects a handler wrapped in something else', () => {
    const source = `
      import { withErrorHandling } from '@/lib/errors';
      export const POST = withErrorHandling(async () => Response.json({}));
    `;
    expect(guardViolations(source)).toContain('POST');
  });

  it('rejects a route that builds its own wrapper', () => {
    const source = `
      import { buildAuthenticatedRoute } from '@/lib/api/authenticated-route';
      const authenticatedRoute = buildAuthenticatedRoute(async () => 'anyone');
      export const POST = authenticatedRoute(async () => Response.json({}));
    `;
    expect(guardViolations(source)).toHaveLength(1);
  });
});

/**
 * Requirement 1.7 names four endpoint groups. `whatsapp` is deliberately absent: it is
 * authenticated by an HMAC signature over the raw body (Requirement 11.3), carries no farmer
 * session, and gating it on one would break the channel.
 */
const PROTECTED_ENDPOINTS = new Set(['diagnose', 'chat', 'voice', 'history']);

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'api');

function routeFilesUnder(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    /** `src/app/api` does not exist yet. Nothing to check, and nothing wrong. */
    return [];
  }

  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return routeFilesUnder(full);
    return /^route\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('every protected API route is built from the wrapper', () => {
  it('finds no diagnosis, chat, voice or history handler that skips the session check', () => {
    /**
     * Today this scans an empty directory — tasks 11.3, 15.3 and 18.3 own those routes and none of
     * them exists. That is the point of writing it now: the first handler that lands without the
     * wrapper fails this test instead of shipping.
     */
    const offenders = routeFilesUnder(API_DIR)
      .filter((file) => {
        const group = relative(API_DIR, file).split(sep)[0];
        return group !== undefined && PROTECTED_ENDPOINTS.has(group);
      })
      .map((file) => ({
        route: relative(API_DIR, file),
        violations: guardViolations(readFileSync(file, 'utf8')),
      }))
      .filter((result) => result.violations.length > 0);

    expect(offenders).toEqual([]);
  });
});
