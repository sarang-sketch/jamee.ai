import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as fc from 'fast-check';
import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { SIGN_IN_PATH } from '@/lib/auth/protected-paths';
import { errorEnvelopeSchema } from '@/lib/schemas';
import { config as proxyConfig, proxy } from '@/proxy';

/**
 * **Property 2: The authentication gate covers the whole protected surface**
 *
 * > For any protected surface — the diagnosis, chat, voice, and history screens, and the diagnosis,
 * > chat, voice, and history endpoints — and any request body, a request carrying no valid session
 * > results in the sign-in screen for a screen and HTTP 401 for an endpoint, with no domain service
 * > invoked.
 *
 * **Validates: Requirements 1.6, 1.7**
 *
 * ### The claim is coverage, so the route set is read off the filesystem
 *
 * A property that enumerated the gated paths from `PROTECTED_SCREEN_PATHS` would be a tautology: it
 * would ask the gate whether it gates what it says it gates. The interesting failure is the route
 * somebody adds without gating it, and no hand-written list can contain a route that does not exist
 * yet. So `discoverRoutes()` walks `src/app/**` for `page.tsx` and `route.ts` exactly as the App
 * Router does, and the generated cases are drawn from what it finds.
 *
 * Classification then **fails closed**. `SESSIONLESS_SURFACE` names the four routes that legitimately
 * answer a request carrying no farmer session, each with the requirement that makes it so. Every
 * other discovered route is treated as protected. A new screen or endpoint is therefore assumed to be
 * farmer-private until someone deliberately declares otherwise, and the declaration is the moment
 * where the reason gets written down — not a silent default.
 *
 * ### Both halves of the gate, driven for real
 *
 * The gate is two mechanisms, and the property covers both because Requirement 1.6 and Requirement
 * 1.7 want different answers to the same absence of a session:
 *
 *  - **Screens** — `src/proxy.ts`. Driven directly with a real `NextRequest`; the only thing stubbed
 *    is `createServerClient` from `@supabase/ssr`, which is the seam where "is there a session"
 *    enters. The proxy's own matcher is part of the mechanism, not scenery: a gated path the matcher
 *    excludes is not gated at all, so `screenOutcome()` consults the matcher first and only then runs
 *    the proxy — the same order the framework does.
 *  - **Endpoints** — the real exported route handlers, imported from the files discovery found and
 *    invoked with generated requests. Only `currentUserId` and the domain services are stubbed, so
 *    the code deciding the 401 is the shipped `authenticatedRoute` wrapper and the shipped route
 *    module, not a re-description of them.
 *
 * Nothing here needs a live Supabase project, a database, or a running Next server.
 *
 * ### The clause that carries the weight
 *
 * "with no domain service invoked" is the half a status-code assertion cannot see. Every service the
 * three protected endpoints can reach is replaced by a tripwire that records its own name and then
 * throws, so a guard that let a handler run would fail twice over: once on the recorded call, and
 * once on the status, because the throw would have surfaced as a 500 instead of a 401.
 *
 * ### Relationship to the example-based tests
 *
 * `src/lib/auth/protected-paths.test.ts` pins the predicate and the matcher on named paths, and
 * `src/lib/api/authenticated-route.test.ts` pins the wrapper and scans for a route written without
 * it. Neither drives `proxy()` or a route module end to end, and neither generates the path variants
 * below. This file is the one that runs the two mechanisms over the surface as the filesystem
 * reports it.
 */

/* ========================================================================== */
/* Seams                                                                       */
/* ========================================================================== */

/**
 * Everything the gate touches on the far side of itself.
 *
 * `domainCalls` is the ledger Requirement 1.7's second clause is asserted against. Each tripwire
 * records its own name before throwing, so a violation is reported as "which service ran" rather
 * than as an opaque status mismatch.
 */
const seams = vi.hoisted(() => {
  const domainCalls: string[] = [];

  const tripwire = (label: string) =>
    vi.fn(() => {
      domainCalls.push(label);
      throw new Error(`tripwire: ${label} ran for a request the gate had not admitted`);
    });

  return {
    domainCalls,

    /** The proxy's identity call — `supabase.auth.getUser()` in `src/proxy.ts`. */
    getUser: vi.fn(),

    /** The wrapper's identity call — `currentUserId()` in `src/lib/supabase/server.ts`. */
    currentUserId: vi.fn(),

    createServerSupabase: tripwire('supabase.createServerSupabase'),
    chatTurn: tripwire('ChatService.chatTurn'),
    chatAnswerer: tripwire('ChatService.chatAnswerer'),
    diagnose: tripwire('DiagnosisService.diagnose'),
    transcribeAndAnswer: tripwire('VoiceService.transcribeAndAnswer'),
    voiceRequestDeadline: tripwire('VoiceService.voiceRequestDeadline'),
    burstLimiter: tripwire('RateLimit.burstLimiter'),
    objectSizeOf: tripwire('Storage.objectSizeOf'),
  };
});

interface CookieMethods {
  getAll: () => { name: string; value: string }[];
  setAll: (cookies: { name: string; value: string; options?: Record<string, unknown> }[]) => void;
}

/**
 * The one seam the screen half is stubbed at.
 *
 * `getAll` and `setAll` are both exercised, because `setAll` is what makes the proxy rebuild the
 * response it returns — the branch a redirect has to survive. What comes back is only an `auth`
 * object: the proxy calls `getUser()` and nothing else on the client.
 */
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: CookieMethods }) => {
    options.cookies.getAll();
    options.cookies.setAll([
      { name: 'sb-jamee-auth-token', value: 'rotated', options: { path: '/' } },
    ]);
    return { auth: { getUser: seams.getUser } };
  },
}));

/** The wrapper's identity resolver. The wrapper itself stays real — only its answer is stubbed. */
vi.mock('@/lib/supabase/server', () => ({
  currentUserId: seams.currentUserId,
  createServerSupabase: seams.createServerSupabase,
}));

vi.mock('@/services/chat.service', () => ({
  chatTurn: seams.chatTurn,
  chatAnswerer: seams.chatAnswerer,
}));
vi.mock('@/services/diagnosis.service', () => ({ diagnose: seams.diagnose }));
vi.mock('@/services/voice.service', () => ({
  transcribeAndAnswer: seams.transcribeAndAnswer,
  voiceRequestDeadline: seams.voiceRequestDeadline,
}));
vi.mock('@/lib/rate-limit', () => ({ burstLimiter: seams.burstLimiter }));
vi.mock('@/lib/storage', () => ({ objectSizeOf: seams.objectSizeOf }));

/**
 * The imports at the top of this file resolve **after** the mocks above, not before: `vi.mock` is
 * hoisted above every import by Vitest's transform, so `@/proxy` and the route modules loaded in
 * `beforeAll` both see the stubs. Keeping the imports in one block rather than splitting them around
 * the `vi.mock` calls is safe for that reason, and it is the arrangement every route test in `src/`
 * already uses.
 */

/**
 * `publicEnv()` runs inside `proxy()` and throws by name when either value is absent. These are the
 * two non-secret public values; nothing here is a credential, and `createServerClient` is mocked, so
 * they are never used to reach anything.
 */
vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test_key');

const ORIGIN = 'https://jamee.test';
const USER = '11111111-1111-4111-8111-111111111111';

/* ========================================================================== */
/* The route surface, read off the filesystem                                  */
/* ========================================================================== */

const APP_DIR = fileURLToPath(new URL('../../src/app/', import.meta.url));

type RouteKind = 'screen' | 'endpoint';

interface DiscoveredRoute {
  readonly kind: RouteKind;
  /** The App Router pattern, dynamic segments included: `/diagnosis/[id]`. */
  readonly pattern: string;
  readonly file: string;
  /** Repository-relative, POSIX separators, so a failure message reads the same everywhere. */
  readonly source: string;
}

/**
 * The App Router's own conventions, applied to the tree: `page.tsx` is a screen, `route.ts` is an
 * endpoint, `_private` folders hold neither, and `(groups)` and `@slots` contribute no URL segment.
 */
function discoverRoutes(dir: string, segments: readonly string[] = []): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith('_')) continue;
      const contributesSegment =
        !entry.name.startsWith('@') && !(entry.name.startsWith('(') && entry.name.endsWith(')'));
      found.push(...discoverRoutes(full, contributesSegment ? [...segments, entry.name] : segments));
      continue;
    }

    const kind: RouteKind | null = /^page\.tsx?$/.test(entry.name)
      ? 'screen'
      : /^route\.tsx?$/.test(entry.name)
        ? 'endpoint'
        : null;
    if (kind === null) continue;

    found.push({
      kind,
      pattern: segments.length === 0 ? '/' : `/${segments.join('/')}`,
      file: full,
      source: `src/app/${relative(APP_DIR, full).split(sep).join('/')}`,
    });
  }

  return found;
}

const ROUTES = discoverRoutes(APP_DIR);

/* ========================================================================== */
/* Classification, failing closed                                              */
/* ========================================================================== */

interface SessionlessRoute {
  readonly pattern: string;
  readonly why: string;
}

/**
 * The routes that may answer a request carrying no farmer session, and the reason each may.
 *
 * This is the whole of the exception surface. Anything `discoverRoutes()` finds that is not listed
 * here is generated as protected, so forgetting to gate a new screen or endpoint shows up as a
 * failing property rather than as a passing test about a smaller surface.
 */
const SESSIONLESS_SURFACE: readonly SessionlessRoute[] = [
  {
    pattern: '/',
    why: 'the sign-in screen itself — Requirement 1.6 sends a gated visitor here, so gating it would leave nowhere to land',
  },
  {
    pattern: '/auth/callback',
    why: 'establishes the session and creates the Profile (Requirement 1.4); it runs before a session exists',
  },
  {
    pattern: '/api/whatsapp',
    why: 'authenticated by an HMAC signature over the raw body (Requirement 11.3); it carries no farmer session at all',
  },
  {
    pattern: '/api/internal/retention-sweep',
    why: 'authenticated by the retention-sweep secret (Requirement 18.12) and deliberately unreachable by a Farmer session (Requirement 18.13)',
  },
];

function isSessionless(pattern: string): boolean {
  return SESSIONLESS_SURFACE.some((entry) => entry.pattern === pattern);
}

const PROTECTED_SCREENS = ROUTES.filter((r) => r.kind === 'screen' && !isSessionless(r.pattern));
const SESSIONLESS_SCREENS = ROUTES.filter((r) => r.kind === 'screen' && isSessionless(r.pattern));
const PROTECTED_ENDPOINTS = ROUTES.filter((r) => r.kind === 'endpoint' && !isSessionless(r.pattern));
const ALL_ENDPOINTS = ROUTES.filter((r) => r.kind === 'endpoint');

/* ========================================================================== */
/* The matcher, and what the screen half answers                               */
/* ========================================================================== */

/**
 * A reconstruction of the matcher, for the reason `protected-paths.test.ts` records: Next reads
 * `config.matcher` statically at build time and compiles it with `path-to-regexp`, which is not
 * reachable from a test. Anchoring the same source as a plain `RegExp` gives the same answers for
 * the shapes asserted here, and it keeps the matcher inside the property rather than beside it — a
 * gated path the matcher excludes is not gated, and that is a failure this property should catch.
 */
const MATCHER_PATTERNS = proxyConfig.matcher.map((source) => new RegExp(`^${source}$`));

function matcherAdmits(pathname: string): boolean {
  return MATCHER_PATTERNS.some((pattern) => pattern.test(pathname));
}

interface ScreenOutcome {
  readonly status: number;
  readonly redirectedTo: string | null;
  /** True only for a redirect whose target is exactly the sign-in screen. */
  readonly signIn: boolean;
}

/**
 * What a visitor requesting `url` actually receives from the screen half, matcher included.
 *
 * A path the matcher excludes never reaches `proxy()`, so it is reported as served — which is the
 * truth about production and the reason the matcher cannot be left out of the property.
 */
async function screenOutcome(url: string): Promise<ScreenOutcome> {
  const request = new NextRequest(new URL(url, ORIGIN));

  if (!matcherAdmits(request.nextUrl.pathname)) {
    return { status: 200, redirectedTo: null, signIn: false };
  }

  const response = await proxy(request);
  const location = response.headers.get('location');
  const redirected = response.status >= 300 && response.status < 400 && location !== null;

  if (!redirected || location === null) {
    return { status: response.status, redirectedTo: null, signIn: false };
  }

  const target = new URL(location, ORIGIN);
  return {
    status: response.status,
    redirectedTo: `${target.pathname}${target.search}`,
    signIn: target.pathname === SIGN_IN_PATH && target.search === '',
  };
}

/* ========================================================================== */
/* The endpoint half: the real handlers, from the files discovery found        */
/* ========================================================================== */

const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type Verb = (typeof HTTP_VERBS)[number];

interface EndpointHandler {
  readonly route: DiscoveredRoute;
  readonly verb: Verb;
  readonly invoke: (request: NextRequest) => Promise<Response>;
}

const handlers: EndpointHandler[] = [];

beforeAll(async () => {
  for (const route of PROTECTED_ENDPOINTS) {
    const loaded: Record<string, unknown> = await import(pathToFileURL(route.file).href);

    for (const verb of HTTP_VERBS) {
      const exported = loaded[verb];
      if (typeof exported !== 'function') continue;
      const handler = exported as (request: NextRequest) => Promise<Response>;
      handlers.push({ route, verb, invoke: (request) => handler(request) });
    }
  }
});

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const LOWER = 'abcdefghijklmnopqrstuvwxyz'.split('');

const wordArb = fc
  .array(fc.constantFrom(...LOWER), { minLength: 1, maxLength: 8 })
  .map((letters) => letters.join(''));

/**
 * The shape of a generated URL segment, and the reason it has a shape at all.
 *
 * A nested-sub-path variant of one route must not accidentally spell another route: `/` plus a
 * generated segment `history` would be `/history`, and the case would then be classified as public
 * while pointing at a protected screen. Constraining generated segments to `word-digits` removes
 * that possibility, and `no generated segment can alias a declared route` below **checks** the
 * constraint against the discovered patterns rather than asserting it in a comment.
 */
const GENERATED_SEGMENT = /^[a-z]{1,8}-\d{1,4}$/;

const segmentArb = fc
  .tuple(wordArb, fc.integer({ min: 0, max: 9999 }))
  .map(([word, number]) => `${word}-${number}`);

const trailingArb = fc.constantFrom('', '/', '//');

const queryArb = fc.oneof(
  fc.constant(''),
  fc
    .array(fc.tuple(wordArb, wordArb), { minLength: 1, maxLength: 3 })
    .map((pairs) => `?${new URLSearchParams(pairs).toString()}`),
);

const nestedArb = fc.array(segmentArb, { minLength: 0, maxLength: 2 });

function dynamicSegmentCount(pattern: string): number {
  return pattern.split('/').filter((segment) => segment.startsWith('[')).length;
}

function concretePath(pattern: string, dynamicValues: readonly string[]): string {
  let index = 0;
  const filled = pattern
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      if (!segment.startsWith('[')) return segment;
      const value = dynamicValues[index];
      index += 1;
      return value ?? USER;
    });
  return filled.length === 0 ? '/' : `/${filled.join('/')}`;
}

interface PathVariant {
  readonly pathname: string;
  readonly url: string;
  readonly label: string;
}

/**
 * One route, many spellings of it. Trailing slashes, a query string, and one or two extra path
 * segments — the variants a gate that only covers the exact path would let through, which is the
 * bug this property exists to catch.
 */
function variantArb(route: DiscoveredRoute): fc.Arbitrary<PathVariant> {
  const dynamicCount = dynamicSegmentCount(route.pattern);

  return fc
    .record({
      dynamic: fc.array(fc.uuid(), { minLength: dynamicCount, maxLength: dynamicCount }),
      nested: nestedArb,
      trailing: trailingArb,
      query: queryArb,
    })
    .map(({ dynamic, nested, trailing, query }) => {
      const base = concretePath(route.pattern, dynamic);
      const withNested =
        nested.length === 0
          ? base
          : `${base === '/' ? '' : base}/${nested.join('/')}`;

      /**
       * `'//'` on its own is a network-path reference, not a path — `new URL('//x', origin)` reads
       * `x` as a host. The root pattern therefore keeps no trailing variant; every other path is
       * already anchored by its first segment.
       */
      const suffix = withNested === '/' ? '' : trailing;
      const pathname = `${withNested}${suffix}`;

      return {
        pathname,
        url: `${pathname}${query}`,
        label: `${route.pattern} as ${pathname}${query}`,
      };
    });
}

/** Both spellings of "no user" a Supabase client returns, and neither may count as signed in. */
const noSessionAnswerArb = fc.constantFrom(
  { data: { user: null }, error: { message: 'Auth session missing!' } },
  { data: { user: null }, error: null },
);

function anonymous(answer: unknown): void {
  seams.getUser.mockResolvedValue(answer);
  seams.currentUserId.mockResolvedValue(null);
}

function signedIn(userId: string): void {
  seams.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
  seams.currentUserId.mockResolvedValue(userId);
}

/**
 * "Any request body." A plausible one is in the mix on purpose: it is what makes an unauthenticated
 * 401 mean "the session was checked first" rather than "the body failed to parse".
 */
const bodyArb = fc.oneof(
  fc.constant(null),
  fc.constant('not json at all'),
  fc.json(),
  fc
    .record({
      language: fc.constantFrom('en', 'hi', 'mr'),
      message: wordArb,
      conversationId: fc.uuid(),
      image: fc.uuid().map((id) => `crop-images/${USER}/${id}.jpg`),
      audio: fc.uuid().map((id) => `voice-messages/${USER}/${id}.webm`),
      durationSeconds: fc.integer({ min: 1, max: 60 }),
    })
    .map((body) => JSON.stringify(body)),
);

const acceptLanguageArb = fc.constantFrom(
  null,
  'en',
  'hi-IN,hi;q=0.9',
  'mr,en;q=0.5',
  'fr-FR,de;q=0.8',
);

interface EndpointRequestShape {
  readonly body: string | null;
  readonly acceptLanguage: string | null;
  readonly languageQuery: string | null;
}

const endpointRequestArb: fc.Arbitrary<EndpointRequestShape> = fc.record({
  body: bodyArb,
  acceptLanguage: acceptLanguageArb,
  languageQuery: fc.constantFrom(null, 'en', 'hi', 'mr', 'ta', ''),
});

function endpointRequest(
  handler: EndpointHandler,
  variant: PathVariant,
  shape: EndpointRequestShape,
): NextRequest {
  const url = new URL(variant.url, ORIGIN);
  if (shape.languageQuery !== null) url.searchParams.set('language', shape.languageQuery);

  const headers = new Headers({ 'content-type': 'application/json' });
  if (shape.acceptLanguage !== null) headers.set('accept-language', shape.acceptLanguage);

  const carriesBody = handler.verb !== 'GET' && handler.verb !== 'HEAD' && shape.body !== null;

  return new NextRequest(url, {
    method: handler.verb,
    headers,
    ...(carriesBody ? { body: shape.body } : {}),
  });
}

async function envelopeCodeOf(response: Response): Promise<string | null> {
  const text = await response.text();
  if (text === '') return null;
  try {
    const parsed = errorEnvelopeSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.error.code : null;
  } catch {
    return null;
  }
}

/* ========================================================================== */
/* What the surface is — the assertions the property is drawn from            */
/* ========================================================================== */

describe('the protected surface, as the filesystem reports it', () => {
  it("contains every screen Requirement 1.6 names, and none of them is declared sessionless", () => {
    const patterns = PROTECTED_SCREENS.map((route) => route.pattern);
    for (const screen of ['/diagnose', '/chat', '/voice', '/history']) {
      expect(patterns, `Requirement 1.6 names ${screen}`).toContain(screen);
    }
  });

  it('classifies every discovered route, and every sessionless entry still names a real route', () => {
    /** Nothing may be silently skipped: a route is protected or it is listed with a reason. */
    expect(ROUTES.length).toBeGreaterThan(0);
    for (const route of ROUTES) {
      const classified = isSessionless(route.pattern) || route.kind === 'screen' || route.kind === 'endpoint';
      expect(classified, `${route.source} is unclassified`).toBe(true);
    }

    /** And the exception list may not outlive the routes it excuses. */
    const discovered = new Set(ROUTES.map((route) => route.pattern));
    for (const entry of SESSIONLESS_SURFACE) {
      expect(discovered, `stale sessionless allowance: ${entry.pattern} (${entry.why})`).toContain(
        entry.pattern,
      );
    }
  });

  it('treats every endpoint group Requirement 1.7 names as protected', () => {
    /**
     * `history` is deliberately included and, today, matches nothing: Jamee's history surface is the
     * `/history` screen reading through `src/lib/history.ts` in a Server Component, so there is no
     * `/api/history` for the API half to refuse. Requirement 1.7 names it anyway, and this loop is
     * written over the requirement's four names rather than over the three that exist so that an
     * `/api/history` added later is checked by the name the requirement already gave it.
     */
    for (const group of ['diagnose', 'chat', 'voice', 'history']) {
      const endpoint = ALL_ENDPOINTS.find((route) => route.pattern === `/api/${group}`);
      if (endpoint === undefined) continue;
      expect(isSessionless(endpoint.pattern), `/api/${group} is declared sessionless`).toBe(false);
    }
  });

  it('exports at least one HTTP verb from every protected endpoint', () => {
    for (const route of PROTECTED_ENDPOINTS) {
      const verbs = handlers.filter((handler) => handler.route.pattern === route.pattern);
      expect(verbs.length, `${route.source} exports no HTTP verb this property could drive`).toBeGreaterThan(0);
    }
  });

  it('generates no path segment that could alias a declared route', () => {
    /** The constraint `variantArb` relies on, checked against the surface rather than assumed. */
    const declaredSegments = ROUTES.flatMap((route) => route.pattern.split('/')).filter(
      (segment) => segment !== '',
    );
    for (const segment of declaredSegments) {
      expect(GENERATED_SEGMENT.test(segment), `${segment} collides with the generated shape`).toBe(
        false,
      );
    }
  });
});

/* ========================================================================== */
/* Property 2 — the screen half                                                */
/* ========================================================================== */

describe('Property 2: the authentication gate covers the whole protected surface', () => {
  it('sends every spelling of every protected screen to the sign-in screen when no session is carried', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PROTECTED_SCREENS).chain((route) =>
          fc.tuple(fc.constant(route), variantArb(route), noSessionAnswerArb),
        ),
        async ([route, variant, answer]) => {
          anonymous(answer);

          const outcome = await screenOutcome(variant.url);

          /** Requirement 1.6: the sign-in screen instead, for the screen and everything under it. */
          expect(outcome.signIn, `${variant.label} (${route.source}) was not gated`).toBe(true);
          expect(outcome.redirectedTo).toBe(SIGN_IN_PATH);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('serves every protected screen once a session is carried', async () => {
    /**
     * The other half of coverage. A gate that redirected a signed-in farmer would satisfy the
     * sentence above and still be broken, so the same generated variants are replayed with a
     * confirmed user and must come back served.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PROTECTED_SCREENS).chain((route) => variantArb(route)),
        async (variant) => {
          signedIn(USER);

          const outcome = await screenOutcome(variant.url);

          expect(outcome.redirectedTo, `${variant.label} was redirected for a signed-in farmer`).toBe(
            null,
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never blocks a sessionless screen, with or without a session', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SESSIONLESS_SCREENS).chain((route) =>
          fc.tuple(fc.constant(route), variantArb(route), fc.boolean(), noSessionAnswerArb),
        ),
        async ([route, variant, hasSession, answer]) => {
          if (hasSession) signedIn(USER);
          else anonymous(answer);

          const outcome = await screenOutcome(variant.url);

          expect(
            outcome.redirectedTo,
            `${variant.label} (${route.source}) was blocked, though it is sessionless because ${
              SESSIONLESS_SURFACE.find((entry) => entry.pattern === route.pattern)?.why ?? 'declared'
            }`,
          ).toBe(null);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never answers an endpoint with a redirect, so exactly one half of the gate decides', async () => {
    /**
     * Requirement 1.7 wants HTTP 401 with the `AUTH_REQUIRED` envelope, and a 307 to an HTML page is
     * not that. `/api/**` is excluded by the matcher; `/auth/callback` is admitted so a session can
     * be refreshed there but is not part of the protected screen surface. Both must come back
     * un-redirected, and this property covers them together rather than by path.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_ENDPOINTS).chain((route) =>
          fc.tuple(fc.constant(route), variantArb(route), fc.boolean(), noSessionAnswerArb),
        ),
        async ([route, variant, hasSession, answer]) => {
          if (hasSession) signedIn(USER);
          else anonymous(answer);

          const outcome = await screenOutcome(variant.url);

          expect(
            outcome.redirectedTo,
            `${variant.label} (${route.source}) was redirected by the screen half`,
          ).toBe(null);
        },
      ),
      { numRuns: 200 },
    );
  });
});

/* ========================================================================== */
/* Property 2 — the endpoint half                                              */
/* ========================================================================== */

describe('Property 2: every protected endpoint refuses an unauthenticated request with 401', () => {
  it('answers 401 AUTH_REQUIRED for any verb, any path spelling, and any request body', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...handlers).chain((handler) =>
          fc.tuple(
            fc.constant(handler),
            variantArb(handler.route),
            endpointRequestArb,
            noSessionAnswerArb,
          ),
        ),
        async ([handler, variant, shape, answer]) => {
          anonymous(answer);
          seams.domainCalls.length = 0;

          const request = endpointRequest(handler, variant, shape);
          const response = await handler.invoke(request);
          const where = `${handler.verb} ${variant.label} (${handler.route.source})`;

          /** Requirement 1.7's status. */
          expect(response.status, `${where} was not refused with 401`).toBe(401);
          expect(await envelopeCodeOf(response), `${where} carried the wrong code`).toBe(
            'AUTH_REQUIRED',
          );

          /** Requirement 1.7's second clause, and the one a status cannot see. */
          expect(seams.domainCalls, `${where} reached a domain service`).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never answers 401 AUTH_REQUIRED once a session is carried', async () => {
    /**
     * The complement. What a request past the gate gets instead is this property's business only in
     * the negative: the domain seams are tripwires, so the answer here is a coded 4xx from the body
     * contract or a 500 from the tripwire. Either is a request the gate admitted, which is the
     * claim — and neither may be `AUTH_REQUIRED`, or the gate would be refusing a farmer who is
     * signed in.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...handlers).chain((handler) =>
          fc.tuple(fc.constant(handler), variantArb(handler.route), endpointRequestArb),
        ),
        async ([handler, variant, shape]) => {
          signedIn(USER);
          seams.domainCalls.length = 0;

          const request = endpointRequest(handler, variant, shape);
          const response = await handler.invoke(request);
          const where = `${handler.verb} ${variant.label} (${handler.route.source})`;

          expect(response.status, `${where} refused a signed-in farmer with 401`).not.toBe(401);
          expect(await envelopeCodeOf(response), `${where} answered AUTH_REQUIRED`).not.toBe(
            'AUTH_REQUIRED',
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
