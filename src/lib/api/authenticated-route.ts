import 'server-only';

import type { NextRequest } from 'next/server';

import { AppError, withErrorHandling } from '@/lib/errors';
import { languageSchema, type Language } from '@/lib/schemas';
import { currentUserId } from '@/lib/auth/session';

/**
 * The API half of the auth gate: one wrapper every protected route handler is built from.
 *
 * Requirements: 1.7 (every request to a diagnosis, chat, voice, or history endpoint that carries
 *               no valid authenticated session is rejected with HTTP 401), 13.2 (the session, not
 *               a client-supplied identifier, decides whose rows a request can reach), 15.3 /
 *               15.6 (the refusal leaves through the single error envelope)
 * Design: "Security boundary" — defence in depth; "Error taxonomy" — `AUTH_REQUIRED` → 401
 * Depends on: V30 — Better Auth's `getSession` as the server-confirmed identity call
 *
 * ### Why a wrapper and not a convention
 *
 * `/api/diagnose`, `/api/chat` and `/api/voice` do not exist yet (tasks 11.3, 15.3, 18.3 own
 * them). "Check the session first" written in a design document is a rule three future handlers
 * have to follow; a wrapper that **owns the call to the handler** is a rule they cannot break:
 *
 * ```ts
 * export const POST = authenticatedRoute(async (request, session) => {
 *   //                                                     ^ only this module can produce one
 * });
 * ```
 *
 * The handler is a callback. The only thing that invokes it is the branch below that has already
 * resolved a non-null user id, so "the session check precedes any domain service call, any quota
 * reserve, and any provider call" is not an ordering someone maintains — it is the only order the
 * control flow permits. Nothing in the handler body can run first, because the body does not run.
 *
 * `FarmerSession` closes the second half of that: it carries a brand keyed by a symbol this module
 * does not export, so a handler cannot fabricate one, and the `userId` a service is called with
 * therefore came from `getUser()` and from nowhere else.
 *
 * `authenticated-route.test.ts` additionally scans `src/app/api/**` and fails if a diagnosis,
 * chat, voice, or history handler is exported in any other form — so the wrapper is enforced at
 * the point where forgetting it would matter.
 */

/* ========================================================================== */
/* The session a handler receives                                              */
/* ========================================================================== */

/**
 * Not exported, and that is the point: a computed property whose key is this symbol cannot be
 * written outside this module, so `FarmerSession` cannot be constructed outside it either.
 */
const SERVER_CONFIRMED: unique symbol = Symbol('jamee.server-confirmed-session');

export interface FarmerSession {
  /**
   * The Auth_User_Id of the signed-in farmer, from Better Auth's server-confirmed session (V30).
   * This is the owner id every `farmerData(...)` accessor is bound to and every owner-scoped
   * filter is keyed on (D18).
   */
  readonly userId: string;

  /** Nominal marker. Proof of provenance, carried by the type rather than by a comment. */
  readonly [SERVER_CONFIRMED]: true;
}

/* ========================================================================== */
/* Shapes                                                                      */
/* ========================================================================== */

/**
 * How the identity is resolved. A seam rather than a direct call so the guard is testable without
 * a cookie store or an Auth round trip — the same structural-seam approach the profile bootstrap
 * (`src/lib/auth/bootstrap.ts`) takes.
 *
 * `null` means "no valid session". A resolver that throws is a *different* thing (the Auth service
 * is unreachable, an env var is missing) and is treated as one: it becomes `INTERNAL_ERROR`, and
 * the handler still does not run.
 */
export type UserIdResolver = () => Promise<string | null>;

export type AuthenticatedHandler<Req extends Request = NextRequest> = (
  request: Req,
  session: FarmerSession,
) => Promise<Response>;

export type RouteHandler<Req extends Request = NextRequest> = (request: Req) => Promise<Response>;

/**
 * The wrapper's own type. Generic over the request so a unit test can drive it with a plain
 * `Request`; route handlers get `NextRequest` from the default and never write the parameter.
 */
export interface AuthenticatedRouteWrapper {
  <Req extends Request = NextRequest>(handler: AuthenticatedHandler<Req>): RouteHandler<Req>;
}

/* ========================================================================== */
/* Language for the refusal                                                    */
/* ========================================================================== */

/**
 * Which language a 401 is written in, decided **without reading the body**.
 *
 * Requirement 2.2 puts the language code in the request body, and task 16.2 owns validating it
 * there. This function deliberately does not go looking: consuming the body of a request that is
 * about to be refused would parse up to the platform's 4.5 MB ceiling of attacker-supplied JSON
 * before deciding whether the caller is allowed to be here at all.
 *
 * So the sources are the two that cost nothing: an explicit `?language=` on the URL, then the
 * browser's `Accept-Language`. Anything unrecognized falls back to `en` rather than being
 * refused — `LANGUAGE_UNSUPPORTED` (Requirement 9.5) is a judgement about a request that got
 * past the gate, and returning it here would answer a question the caller did not ask.
 */
export function envelopeLanguage(request: Pick<Request, 'url' | 'headers'>): Language {
  const fromQuery = ((): Language | null => {
    try {
      const value = new URL(request.url).searchParams.get('language');
      const parsed = languageSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    } catch {
      /* A url that will not parse tells us nothing about a language. */
      return null;
    }
  })();
  if (fromQuery !== null) return fromQuery;

  return fromAcceptLanguage(request.headers.get('accept-language')) ?? 'en';
}

/**
 * The first tag in listed order whose primary subtag is one of Jamee's three languages, so
 * `hi-IN,en;q=0.9` resolves to `hi`.
 *
 * Listed order, not `q` order — a deliberate simplification, and the honest bound on it is that
 * this value only ever renders an error for a caller who is **not** signed in. A farmer's real
 * preference lives on their profile (Requirement 1.8) and in the request body (Requirement 9.2),
 * both of which are read on the authenticated side of this gate.
 */
function fromAcceptLanguage(header: string | null): Language | null {
  if (header === null) return null;

  for (const entry of header.split(',')) {
    const tag = entry.split(';')[0]?.trim().toLowerCase() ?? '';
    const primary = tag.split('-')[0] ?? '';
    const parsed = languageSchema.safeParse(primary);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/* ========================================================================== */
/* The wrapper                                                                 */
/* ========================================================================== */

/**
 * Build a wrapper over a given identity resolver.
 *
 * @internal Exported for `authenticated-route.test.ts`, which drives the guard with a stub
 * resolver instead of a real Auth round trip. **Route handlers must import `authenticatedRoute`,
 * never this** — a handler that built its own wrapper could choose its own idea of who is signed
 * in, which is exactly the hole the wrapper exists to close. The static check in that test file
 * fails a route that imports this.
 */
export function buildAuthenticatedRoute(resolveUserId: UserIdResolver): AuthenticatedRouteWrapper {
  return function authenticatedRoute<Req extends Request = NextRequest>(
    handler: AuthenticatedHandler<Req>,
  ): RouteHandler<Req> {
    return (request) =>
      withErrorHandling(async () => {
        const userId = await resolveUserId();

        /**
         * Requirement 1.7. Thrown rather than returned so the refusal is rendered by the same
         * `toEnvelope` every other coded failure goes through — one envelope shape, one place
         * that can leak (Requirement 15.6).
         *
         * No `cause` and no `context`: an anonymous request is not a server fault, and
         * `withErrorHandling` logs only causes. A log line per unauthenticated probe would be
         * noise that buries the failures that are Jamee's fault.
         */
        if (userId === null) throw new AppError('AUTH_REQUIRED');

        return handler(request, { userId, [SERVER_CONFIRMED]: true });
      }, () => envelopeLanguage(request));
  };
}

/**
 * The wrapper every protected route handler uses.
 *
 * `currentUserId()` reads the session through Better Auth (`getAuth().api.getSession`, the
 * server-confirmed call — V30), so the identity is validated against the session store rather than
 * decoded from a cookie the caller supplied. A forged or edited session cookie resolves to `null`
 * here and gets the 401. Behaviour is unchanged from the Supabase wiring: the resolver stays
 * injectable via `buildAuthenticatedRoute`, and the `AUTH_REQUIRED` → 401 refusal is identical.
 */
export const authenticatedRoute: AuthenticatedRouteWrapper =
  buildAuthenticatedRoute(currentUserId);
