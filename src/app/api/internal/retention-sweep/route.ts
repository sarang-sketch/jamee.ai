import { serverEnv } from '@/lib/env';
import { ERROR_SPECS } from '@/lib/errors';
import { timingSafeEqualStrings } from '@/lib/whatsapp';
import { runRetentionSweep } from '@/services/retention.service';

/**
 * The Retention_Sweep trigger. **Network-exposed, and it deletes data, so the secret comparison
 * below is the entire security boundary.**
 *
 * Requirements: 18.12 (a request carrying no valid retention-sweep secret is 401 and deletes no
 *               object), 18.13 (no Retention_Sweep endpoint is reachable by a Farmer session),
 *               18.11 (each invocation finishes inside the Serverless_Duration_Ceiling),
 *               18.9 (the deletions run server-side with the Service_Role_Key — `RetentionService`
 *               is `server-only` and builds that client itself)
 * Design: "Media lifecycle and retention" → *Triggering a sweep with no always-on process*
 * Depends on: V21 (the platform's cron issues **GET** to the production URL and injects the secret
 *             as `Authorization: Bearer <CRON_SECRET>`; delivery is best-effort in both directions),
 *             V17 (`export const maxDuration`, in seconds)
 *
 * ### Two verbs, ONE check
 *
 * V21 settled two details the design had sketched differently, and both are read strictly here:
 *
 *  - **The scheduler issues `GET`, not `POST`.** So `GET` is the automatic path and `POST` is the
 *    documented manual path, and they are the same function — `sweep(request)` — rather than two
 *    handlers that could drift into two authorization stories.
 *  - **The credential arrives as `Authorization: Bearer <CRON_SECRET>`**, because that is the header
 *    the platform injects automatically; a custom header could not be used for the automatic trigger
 *    at all. Requirement 18.12's "retention sweep secret" therefore *is* `CRON_SECRET`, and there is
 *    one secret rather than two.
 *
 * ### No session is consulted here, and that is Requirement 18.13
 *
 * This route reads exactly one header. It does not import `createServerSupabase`, does not call
 * `currentUserId()`, and is deliberately **not** wrapped in `authenticatedRoute` — so a valid farmer
 * session grants nothing on this path, and a farmer cannot trigger a sweep even while signed in.
 * `route.test.ts` asserts that absence structurally, because "we did not add a session check" is the
 * kind of property that only stays true if something checks.
 *
 * ### What the 401 says: nothing
 *
 * A missing header, a malformed header, a wrong secret, and an unconfigured `CRON_SECRET` all
 * produce the same bodiless 401. There is no farmer on this path and nothing to localize, so a body
 * could only carry a machine-readable statement of *which* part failed — an oracle for an
 * unauthenticated caller. Notably that includes the configuration case: answering "the server has no
 * secret configured" with a 500 while a wrong guess gets a 401 would tell an anonymous caller
 * whether the sweep is armed. The reason is logged server-side instead, where the operator is.
 */

/**
 * **V17.** Jamee's own ceiling, in seconds, and the whole of Requirement 18.11's duration half.
 * Written as a literal because Next.js reads route segment config by static analysis, so an imported
 * constant is not usable here; `route.test.ts` asserts this equals `JAMEE_MAX_DURATION_SECONDS`.
 *
 * The sweep's per-scan batch bound (`RETENTION_SWEEP_BATCH_LIMIT`) is what keeps an invocation
 * inside this number: leftover work is picked up by the next run, which is safe because the
 * operation is idempotent.
 */
export const maxDuration = 60;

/** A sweep is never a cached read. It deletes, and its report differs per invocation. */
export const dynamic = 'force-dynamic';

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

const BEARER_SCHEME = 'bearer';

type Refusal = 'header_absent' | 'scheme_not_bearer' | 'token_absent' | 'token_mismatch' | 'secret_not_configured';

/**
 * Decide whether a request may run a sweep. Pure apart from the environment read, and it returns a
 * reason rather than a `Response` so the ordering — decide, log, *then* act — is visible.
 *
 * The token comparison is `timingSafeEqualStrings` from `src/lib/whatsapp.ts`, which is the one
 * constant-time string comparison in the codebase (it is the only caller of `crypto.timingSafeEqual`,
 * and `whatsapp.test.ts` asserts that structurally). Reusing it rather than writing a second one is
 * the point: this endpoint is public, unauthenticated by construction, and retriable without limit,
 * so a comparison that returned early would answer "how many leading characters did I get right?"
 * about a credential that authorizes deletion.
 *
 * The scheme label is matched case-insensitively — it is a fixed public string, so leniency there
 * leaks nothing — and the token exactly.
 */
export function authorizeSweep(
  headers: Headers,
  expectedSecret: string | undefined,
): { readonly ok: true } | { readonly ok: false; readonly reason: Refusal } {
  const header = headers.get('authorization');
  if (header === null || header.trim() === '') return { ok: false, reason: 'header_absent' };

  // Split on whitespace rather than slicing a fixed prefix, so `Bearer` with nothing after it is
  // reported as a missing token rather than as an unrecognized scheme. A bearer token carries no
  // whitespace, so anything beyond one part simply will not match the secret.
  const [scheme = '', ...rest] = header.trim().split(/\s+/);
  if (scheme.toLowerCase() !== BEARER_SCHEME) {
    return { ok: false, reason: 'scheme_not_bearer' };
  }
  if (rest.length === 0) return { ok: false, reason: 'token_absent' };

  const presented = rest.join(' ');

  // Checked after the presented token so a caller learns nothing about the server's configuration
  // from the shape of its own request being accepted or refused first.
  if (expectedSecret === undefined || expectedSecret === '') {
    return { ok: false, reason: 'secret_not_configured' };
  }

  return timingSafeEqualStrings(presented, expectedSecret)
    ? { ok: true }
    : { ok: false, reason: 'token_mismatch' };
}

/**
 * `CRON_SECRET`, or `undefined` when it is not configured.
 *
 * `serverEnv` throws by design — a missing variable should fail the request that needed it, naming
 * the variable. Here that throw must not become a 500, for the oracle reason in the module header, so
 * it is caught and turned into the same 401 every other refusal gets, with the cause logged.
 */
function configuredSecret(): string | undefined {
  try {
    return serverEnv('CRON_SECRET');
  } catch (cause) {
    console.error(
      '[jamee] retention.secret_not_configured',
      cause instanceof Error ? cause.message : String(cause),
    );
    return undefined;
  }
}

/**
 * Requirement 18.12: 401, no body, and no deletion attempted.
 *
 * The status comes from `SWEEP_UNAUTHORIZED` in `ERROR_SPECS` rather than from a literal, so the
 * taxonomy stays the one place an HTTP code for this condition is written down — the same
 * arrangement the WhatsApp webhook's bodiless 401 uses. What the taxonomy does *not* supply here is
 * a body: `toEnvelope` would add a machine-readable statement of which part failed, and there is no
 * farmer on this path to localize for (see the module header on why that would be an oracle).
 */
function unauthorized(): Response {
  return new Response(null, {
    status: ERROR_SPECS.SWEEP_UNAUTHORIZED.status,
    headers: { 'cache-control': 'no-store' },
  });
}

/**
 * An unhandled failure anywhere in an invocation. `INTERNAL_ERROR`'s 500 (Requirement 15.6) with no
 * body and the real cause logged server-side only — the same split `withErrorHandling` makes for
 * every route that *has* a farmer to write a message for.
 */
function internalError(): Response {
  return new Response(null, {
    status: ERROR_SPECS.INTERNAL_ERROR.status,
    headers: { 'cache-control': 'no-store' },
  });
}

/* -------------------------------------------------------------------------- */
/* The handler                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One implementation behind both verbs.
 *
 * Nothing reads the request body — not even on `POST`. The manual run needs no parameters (the
 * window and the batch bound are configuration, not request input), and a sweep that took its window
 * from a caller would be a way to delete newer media than the policy allows.
 *
 * A 200 carries the run's counts as JSON, which is what makes a cron log readable: how many rows
 * were due, how many objects went, how many were already gone, and whether the batch was full (so
 * the operator knows another run is owed). **No path and no user id appears in it** — a path's first
 * segment is a farmer's auth id.
 *
 * A failure is a bodiless 500 with the cause logged. The platform does not retry a failed cron
 * invocation (V21), so the next scheduled run is the retry — which is exactly what an idempotent,
 * bounded sweep makes safe.
 */
async function sweep(request: Request, verb: 'GET' | 'POST'): Promise<Response> {
  /**
   * The whole body is inside the `try`, including the authorization decision. Requirement 15.6 is
   * about *every* unhandled error leaving as a 500 with nothing leaked, and a throw from the gate
   * would otherwise reach the platform's own error page — which is not a body this file controls.
   */
  try {
    const decision = authorizeSweep(request.headers, configuredSecret());

    if (!decision.ok) {
      // The reason stays server-side. `console.warn` rather than `error`: an unauthenticated probe of
      // a public URL is expected background noise, whereas a misconfigured secret is not — that one
      // is already logged as an error by `configuredSecret()`.
      console.warn(
        '[jamee] retention.unauthorized',
        JSON.stringify({ verb, reason: decision.reason }),
      );
      return unauthorized();
    }

    const report = await runRetentionSweep();
    return Response.json(
      { ok: true, verb, ...report },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (cause) {
    console.error(
      '[jamee] retention.sweep_failed',
      JSON.stringify({ verb }),
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
    );
    return internalError();
  }
}

/** The platform's scheduled invocation (V21: the cron issues GET). */
export async function GET(request: Request): Promise<Response> {
  return sweep(request, 'GET');
}

/** The documented manual run, for a missed or unavailable schedule. */
export async function POST(request: Request): Promise<Response> {
  return sweep(request, 'POST');
}
