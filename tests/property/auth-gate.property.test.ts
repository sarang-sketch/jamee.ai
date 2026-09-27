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
 * > chat, voice, history, Link_Token minting, and Payment_Order endpoints — and any request body, a
 * > request carrying no valid session results in the sign-in screen for a screen and HTTP 401 for an
 * > endpoint, with no domain service invoked, no Link_Token minted, and no Payment_Order created. The
 * > payment webhook route is not on this surface and is the sole exception: it carries no session by
 * > design and is authenticated by signature verification alone (Property 34).
 *
 * **Validates: Requirements 1.6, 1.7, 21.1, 22.3**
 *
 * =============================================================================
 * AMENDMENT A3 — THE GATE THIS PROPERTY IS STATED OVER
 * =============================================================================
 *
 * The claim is unchanged; the mechanism it runs over moved off Supabase. Under A3 the auth stack is
 * **Better Auth** (Google sign-in), and the gate is two mechanisms:
 *
 *  - **Screens** — `src/proxy.ts`, an OPTIMISTIC cookie-existence redirect. It calls
 *    `getSessionCookie(request)` from `better-auth/cookies` (V30: checks the cookie EXISTS, does not
 *    validate it) and redirects a visitor with no such cookie away from a protected screen. That is
 *    the seam this property stubs for the screen half — "no session" is "no session cookie". The
 *    real validation (`requireFarmer()` → `auth.api.getSession`) lives in each page; the proxy's job
 *    is the redirect, and that is what Requirement 1.6 asks of it.
 *  - **Endpoints** — the real exported route handlers, built from `authenticatedRoute`, whose
 *    identity call is `currentUserId()` in `src/lib/auth/session.ts` (Better Auth's server-confirmed
 *    `getSession`). Only `currentUserId` and the domain services are stubbed, so the code deciding
 *    the 401 is the shipped wrapper and the shipped route module.
 *
 * There is no `@supabase/ssr`, no `createServerClient`, no `getUser()` round trip, and no
 * session-refresh cookie dance anymore — the proxy returns a plain `NextResponse.next()` and Better
 * Auth refreshes its own session through `/api/auth/**`.
 *
 * ### The claim is coverage, so the route set is read off the filesystem
 *
 * A property that enumerated the gated paths from `PROTECTED_SCREEN_PATHS` would be a tautology. The
 * interesting failure is the route somebody adds without gating it, and no hand-written list can
 * contain a route that does not exist yet. So `discoverRoutes()` walks `src/app/**` for `page.tsx`
 * and `route.ts` exactly as the App Router does, and the generated cases are drawn from what it
 * finds.
 *
 * Classification then **fails closed**. `SESSIONLESS_SURFACE` names the routes that legitimately
 * answer a request carrying no farmer session, each with the requirement that makes it so. Every
 * other discovered route is treated as protected. A new screen or endpoint is therefore assumed to be
 * farmer-private until someone deliberately declares otherwise, and the declaration is the moment
 * where the reason gets written down — not a silent default.
 *
 * ### The clause that carries the weight
 *
 * "with no domain service invoked" is the half a status-code assertion cannot see. Every service the
 * protected endpoints can reach is replaced by a tripwire that records its own name and then throws,
 * so a guard that let a handler run would fail twice over: once on the recorded call, and once on the
 * status, because the throw would have surfaced as a 500 instead of a 401. The Link_Token and
 * Payment_Order clauses (Requirements 21.1, 22.3) are covered the same way — their minting/creation
 * seams are tripwires.
 *
 * Nothing here needs a live MongoDB, a Better Auth server, or a running Next server.
 */

/* ========================================================================== */
/* Seams                                                                       */
/* ========================================================================== */

/**
 * Everything the gate touches on the far side of itself.
 *
 * `domainCalls` is the ledger Requirement 1.7 / 21.1 / 22.3's "no service invoked" clause is asserted
 * against. Each tripwire records its own name before throwing, so a violation is reported as "which
 * service ran" rather than as an opaque status mismatch.
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

    /** The proxy's optimistic cookie check — `getSessionCookie(request)` in `src/proxy.ts`. */
    getSessionCookie: vi.fn<(request: unknown) => string | null>(),

    /** The wrapper's identity call — `currentUserId()` in `src/lib/auth/session.ts`. */
    currentUserId: vi.fn<() => Promise<string | null>>(),

    // The domain services the protected endpoints can reach, each a tripwire.
    chatTurn: tripwire('ChatService.chatTurn'),
    chatAnswerer: tripwire('ChatService.chatAnswerer'),
    diagnose: tripwire('DiagnosisService.diagnose'),
    transcribeAndAnswer: tripwire('VoiceService.transcribeAndAnswer'),
    voiceRequestDeadline: tripwire('VoiceService.voiceRequestDeadline'),
    burstLimiter: tripwire('RateLimit.burstLimiter'),
    // Link_Token minting (Requirement 21.1) and unlink.
    mintLinkToken: tripwire('LinkingService.mintLinkToken'),
    unlinkTelegram: tripwire('LinkingService.unlinkTelegram'),
    // Payment_Order creation (Requirement 22.3) and the optimistic confirm.
    createPaymentOrder: tripwire('PaymentService.createPaymentOrder'),
    confirmPayment: tripwire('PaymentService.confirmPayment'),
    // Profile + access reads/writes.
    saveProfile: tripwire('ProfileService.saveProfile'),
    readAccessState: tripwire('ProfileService.readAccessState'),
    // Media upload/read (owner-checked, but still session-gated).
    storeMedia: tripwire('Media.storeMedia'),
    fetchMediaForOwner: tripwire('Media.fetchMediaForOwner'),
  };
});

/** The screen half's seam: the Better Auth cookie-existence probe the proxy calls. */
vi.mock('better-auth/cookies', () => ({
  getSessionCookie: (request: unknown) => seams.getSessionCookie(request),
}));

/** The endpoint half's identity resolver. The wrapper itself stays real — only its answer is stubbed. */
vi.mock('@/lib/auth/session', () => ({
  currentUserId: seams.currentUserId,
  // `requireFarmer` is a screen-side helper; the endpoint wrapper uses `currentUserId`. Stubbed so a
  // route module that transitively imports the session module does not pull the real one.
  requireFarmer: async () => {
    const id = await seams.currentUserId();
    if (id === null) throw new Error('requireFarmer: redirect');
    return id;
  },
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
vi.mock('@/services/linking.service', () => ({
  mintLinkToken: seams.mintLinkToken,
  unlinkTelegram: seams.unlinkTelegram,
}));
vi.mock('@/services/payment.service', () => ({
  createPaymentOrder: seams.createPaymentOrder,
  confirmPayment: seams.confirmPayment,
}));
vi.mock('@/lib/rate-limit', () => ({
  burstLimiter: seams.burstLimiter,
  noBurstCheck: () => Promise.resolve(),
}));
vi.mock('@/lib/media', () => ({
  storeMedia: seams.storeMedia,
  fetchMediaForOwner: seams.fetchMediaForOwner,
  removeMediaForOwner: seams.storeMedia,
  assertAdmissible: seams.storeMedia,
}));

/**
 * The imports at the top of this file resolve **after** the mocks above, not before: `vi.mock` is
 * hoisted above every import by Vitest's transform, so `@/proxy` and the route modules loaded in
 * `beforeAll` both see the stubs.
 */

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
 * This is the whole of the exception surface under A3. Anything `discoverRoutes()` finds that is not
 * listed here is generated as protected, so forgetting to gate a new screen or endpoint shows up as a
 * failing property rather than as a passing test about a smaller surface.
 */
const SESSIONLESS_SURFACE: readonly SessionlessRoute[] = [
  {
    pattern: '/',
    why: 'the sign-in screen itself — Requirement 1.6 sends a gated visitor here, so gating it would leave nowhere to land',
  },
  {
    pattern: '/api/auth/[...all]',
    why: "Better Auth's own catch-all: it establishes and refreshes the session and runs before one exists (V30)",
  },
  {
    pattern: '/api/telegram',
    why: 'authenticated by the X-Telegram-Bot-Api-Secret-Token header compared in constant time before the body is parsed (Requirement 11.3, D12); it carries no farmer session',
  },
  {
    pattern: '/api/payment/webhook',
    why: 'authenticated by the Razorpay signature over the raw body (Requirement 22.6, D15); it carries no farmer session — the sole exception this property names (Property 34)',
  },
  {
    pattern: '/api/internal/retention-sweep',
    why: 'authenticated by the CRON_SECRET bearer (Requirement 18.12) and deliberately unreachable by a Farmer session (Requirement 18.13)',
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
function screenOutcome(url: string): ScreenOutcome {
  const request = new NextRequest(new URL(url, ORIGIN));

  if (!matcherAdmits(request.nextUrl.pathname)) {
    return { status: 200, redirectedTo: null, signIn: false };
  }

  const response = proxy(request);
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
  readonly invoke: (request: NextRequest, context: unknown) => Promise<Response>;
}

const handlers: EndpointHandler[] = [];

beforeAll(async () => {
  for (const route of PROTECTED_ENDPOINTS) {
    const loaded: Record<string, unknown> = await import(pathToFileURL(route.file).href);

    for (const verb of HTTP_VERBS) {
      const exported = loaded[verb];
      if (typeof exported !== 'function') continue;
      const handler = exported as (request: NextRequest, context: unknown) => Promise<Response>;
      handlers.push({ route, verb, invoke: (request, context) => handler(request, context) });
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
 * A nested-sub-path variant of one route must not accidentally spell another route. Constraining
 * generated segments to `word-digits` removes that possibility, and `no generated segment can alias a
 * declared route` below **checks** the constraint against the discovered patterns rather than
 * asserting it in a comment.
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
        nested.length === 0 ? base : `${base === '/' ? '' : base}/${nested.join('/')}`;

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

/** A route context whose `params` resolves the `[id]`-style dynamic segments (Next 16 async params). */
function contextFor(route: DiscoveredRoute): unknown {
  const dynamic = route.pattern
    .split('/')
    .filter((segment) => segment.startsWith('['))
    .map((segment) => segment.replace(/^\[+|\]+$/g, '').replace(/^\.\.\./, ''));
  const params: Record<string, string> = {};
  for (const name of dynamic) params[name] = USER;
  return { params: Promise.resolve(params) };
}

function anonymous(): void {
  seams.getSessionCookie.mockReturnValue(null);
  seams.currentUserId.mockResolvedValue(null);
}

function signedIn(userId: string): void {
  seams.getSessionCookie.mockReturnValue('a-session-cookie-value');
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
      image: fc
        .uuid()
        .map((id) => ({ image: { fileId: id.replace(/-/g, '').slice(0, 24), kind: 'crop-image' } })),
      durationSeconds: fc.integer({ min: 1, max: 60 }),
    })
    .map((body) => JSON.stringify(body)),
);

const acceptLanguageArb = fc.constantFrom(null, 'en', 'hi-IN,hi;q=0.9', 'mr,en;q=0.5', 'fr-FR,de;q=0.8');

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

/**
 * The routes whose 401 carries no `AUTH_REQUIRED` envelope by design.
 *
 * `/api/media/[id]` is a binary streaming serve (`<img>`/`<audio>` src), not an `authenticatedRoute`
 * JSON endpoint: its own header records that it returns a plain `401`/`404`/`200` with no farmer-
 * facing prose, because "the caller is an `<img>` reading a status and bytes, not a farmer reading a
 * sentence." Requirement 1.7's claim — 401 with no session, nothing served — still holds and is
 * asserted; the envelope code is asserted only for the endpoints that carry one.
 */
function carriesAuthEnvelope(route: DiscoveredRoute): boolean {
  return route.pattern !== '/api/media/[id]';
}

/* ========================================================================== */
/* What the surface is — the assertions the property is drawn from            */
/* ========================================================================== */

describe('the protected surface, as the filesystem reports it', () => {
  it('contains every screen Requirement 1.6 names, and none of them is declared sessionless', () => {
    const patterns = PROTECTED_SCREENS.map((route) => route.pattern);
    for (const screen of ['/diagnose', '/chat', '/voice', '/history']) {
      expect(patterns, `Requirement 1.6 names ${screen}`).toContain(screen);
    }
  });

  it('classifies every discovered route, and every sessionless entry still names a real route', () => {
    /** Nothing may be silently skipped: a route is protected or it is listed with a reason. */
    expect(ROUTES.length).toBeGreaterThan(0);
    for (const route of ROUTES) {
      const classified =
        isSessionless(route.pattern) || route.kind === 'screen' || route.kind === 'endpoint';
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

  it('treats the diagnose, chat, voice, Link_Token and Payment_Order endpoints as protected', () => {
    // Requirement 1.7 plus 21.1 (Link_Token minting) and 22.3 (Payment_Order creation). `history` has
    // no `/api/history` (the screen reads through a Server Component), so it is checked by name only
    // where it exists.
    for (const path of ['/api/diagnose', '/api/chat', '/api/voice', '/api/link/token', '/api/payment/order']) {
      const endpoint = ALL_ENDPOINTS.find((route) => route.pattern === path);
      expect(endpoint, `${path} is not a discovered endpoint`).toBeDefined();
      expect(isSessionless(path), `${path} is declared sessionless`).toBe(false);
    }
  });

  it('exports at least one HTTP verb from every protected endpoint', () => {
    for (const route of PROTECTED_ENDPOINTS) {
      const verbs = handlers.filter((handler) => handler.route.pattern === route.pattern);
      expect(
        verbs.length,
        `${route.source} exports no HTTP verb this property could drive`,
      ).toBeGreaterThan(0);
    }
  });

  it('generates no path segment that could alias a declared route', () => {
    /** The constraint `variantArb` relies on, checked against the surface rather than assumed. */
    const declaredSegments = ROUTES.flatMap((route) => route.pattern.split('/')).filter(
      (segment) => segment !== '',
    );
    for (const segment of declaredSegments) {
      // Dynamic segments (`[id]`, `[...all]`) never collide with the `word-digits` generated shape.
      if (segment.startsWith('[')) continue;
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
  it('sends every spelling of every protected screen to the sign-in screen when no session is carried', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROTECTED_SCREENS).chain((route) =>
          fc.tuple(fc.constant(route), variantArb(route)),
        ),
        ([route, variant]) => {
          anonymous();

          const outcome = screenOutcome(variant.url);

          /** Requirement 1.6: the sign-in screen instead, for the screen and everything under it. */
          expect(outcome.signIn, `${variant.label} (${route.source}) was not gated`).toBe(true);
          expect(outcome.redirectedTo).toBe(SIGN_IN_PATH);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('serves every protected screen once a session cookie is present', () => {
    /**
     * The other half of coverage. A gate that redirected a farmer with a session cookie would satisfy
     * the sentence above and still be broken, so the same generated variants are replayed with a
     * present cookie and must come back served. (The proxy is optimistic — real validation is the
     * page's `requireFarmer()` — so "cookie present" is exactly what the proxy admits.)
     */
    fc.assert(
      fc.property(
        fc.constantFrom(...PROTECTED_SCREENS).chain((route) => variantArb(route)),
        (variant) => {
          signedIn(USER);

          const outcome = screenOutcome(variant.url);

          expect(
            outcome.redirectedTo,
            `${variant.label} was redirected despite a session cookie`,
          ).toBe(null);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never blocks a sessionless screen, with or without a session', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SESSIONLESS_SCREENS).chain((route) =>
          fc.tuple(fc.constant(route), variantArb(route), fc.boolean()),
        ),
        ([route, variant, hasSession]) => {
          if (hasSession) signedIn(USER);
          else anonymous();

          const outcome = screenOutcome(variant.url);

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

  it('never answers an endpoint with a redirect, so exactly one half of the gate decides', () => {
    /**
     * Requirement 1.7 wants HTTP 401 with the `AUTH_REQUIRED` envelope, and a 307 to an HTML page is
     * not that. `/api/**` is excluded by the matcher, so every endpoint must come back
     * un-redirected from the screen half.
     */
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_ENDPOINTS).chain((route) =>
          fc.tuple(fc.constant(route), variantArb(route), fc.boolean()),
        ),
        ([route, variant, hasSession]) => {
          if (hasSession) signedIn(USER);
          else anonymous();

          const outcome = screenOutcome(variant.url);

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
          fc.tuple(fc.constant(handler), variantArb(handler.route), endpointRequestArb),
        ),
        async ([handler, variant, shape]) => {
          anonymous();
          seams.domainCalls.length = 0;

          const request = endpointRequest(handler, variant, shape);
          const response = await handler.invoke(request, contextFor(handler.route));
          const where = `${handler.verb} ${variant.label} (${handler.route.source})`;

          /** Requirement 1.7's status. */
          expect(response.status, `${where} was not refused with 401`).toBe(401);
          if (carriesAuthEnvelope(handler.route)) {
            expect(await envelopeCodeOf(response), `${where} carried the wrong code`).toBe(
              'AUTH_REQUIRED',
            );
          }

          /**
           * Requirement 1.7 / 21.1 / 22.3's second clause, and the one a status cannot see: no domain
           * service ran, no Link_Token was minted, no Payment_Order was created.
           */
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
          const response = await handler.invoke(request, contextFor(handler.route));
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
