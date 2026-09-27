import { authenticatedRoute } from '@/lib/api/authenticated-route';
import { parseJsonBody } from '@/lib/api/request-body';
import { withErrorHandling } from '@/lib/errors';
import { burstLimiter } from '@/lib/rate-limit';
import {
  diagnoseRequestSchema,
  type DiagnoseResponse,
  type Language,
} from '@/lib/schemas';
import { diagnose } from '@/services/diagnosis.service';

/**
 * `POST /api/diagnose` — the web channel's entry to the shared DiagnosisService.
 *
 * Requirements: 1.7 (no valid session → HTTP 401 and no domain service invoked), 2.2 (a JSON body
 *               carrying a Storage_Reference, a Supported_Language code and an optional
 *               Conversation identifier), 3.7 (a budget expiry returns a timeout naming the
 *               diagnosis operation and the outcome is recorded), 9.5 (a language code outside the
 *               Supported_Languages is HTTP 400 naming the supported codes), 15.3 (every failure
 *               leaves through the one localized error envelope)
 * Design: D1 (JSON, not multipart); "Route handlers (thin)"
 * Depends on: V16, V17 (the duration ceiling and the route segment config that declares it)
 *
 * ### Five steps, and nothing else
 *
 * Session check (the wrapper) → read the body → parse it → **one** service call → serialize the
 * result. No agronomy, no prompt text, no provider call, no SQL, and no second call to anything:
 * every judgement a farmer sees was made by `DiagnosisService`, which is what keeps the web and
 * Telegram channels answering identically (Requirements 3.8, 16.1, 16.3) rather than by agreement
 * between two handlers.
 *
 * The ordering that matters is not maintained here either — it is the wrapper's. The handler body
 * is a callback that only runs after a non-null user id has been resolved, so "the session check
 * precedes any domain service call, any quota reserve and any provider call" is the only order the
 * control flow permits (Requirement 1.7).
 *
 * ### Why the body is JSON and stays tiny (D1)
 *
 * Requirement 2.3 allows a 10 MB image and Requirement 2.7 keeps request bodies under the 4.5 MB
 * platform ceiling (V16); a multipart upload cannot satisfy both. So the browser uploads the
 * re-encoded image to the Media_Endpoint, which writes it to GridFS, and posts a ~200-byte
 * Media_Reference. **No multipart parsing and no media bytes appear in this file**, and
 * `request.formData()` is never called.
 *
 * ### What the service is given, and what it is not
 *
 * `deps` is `{ burst }` — Requirement 13.8's burst limiter, bound here because this is one of the
 * three endpoints that requirement names.
 *
 * *Amendment A3:* the route builds and passes no database client. Under A3 there is no relational
 * RLS layer; `diagnose` reads and writes through the owner-scoped Data_Access_Layer, scoped by the
 * `userId` the service supplies, which is the sole tenant boundary. The `diagnoses` write, the
 * conversation-ownership lookup and the `usage_logs` audit write are all the service's own business
 * through that layer — this route neither builds nor holds a credential for them.
 *
 * ### Why the burst limiter is bound here and not inside the service
 *
 * Requirement 13.8 is written about *the API_Layer and its three endpoints*, and this is one of them.
 * The service owns the **position** of the check — step 2, between ownership and the reserve, which
 * is what makes a refusal cost nothing — and the endpoint owns the **decision to enforce**. Binding
 * it here keeps that split honest in both directions: `burstLimiter()` reaches the counter through
 * the Data_Access_Layer, and a `DiagnosisService` constructed by anything other than a farmer-facing
 * endpoint (a unit test, a future internal tool) is not silently rate-limited by a default it did not
 * ask for.
 *
 * Constructed per request, which costs an object: it holds no client until its first call, and its
 * only state is the prune schedule (`rate-limit.ts`).
 */

/**
 * **V17.** Jamee's own ceiling, in seconds — not the platform's documented 300
 * (`PLATFORM_MAX_DURATION_SECONDS`). Every soft timeout in Jamee is a fraction of this number, so
 * raising it is a deliberate act with arithmetic consequences (`docs/PROVIDER_CAPABILITIES.md`
 * section 3).
 *
 * Written as a literal because Next.js reads route segment config by static analysis, so an
 * imported constant is not usable here. `route.test.ts` asserts this literal equals
 * `JAMEE_MAX_DURATION_SECONDS`, which is what stops the two drifting apart — the same guard the
 * Telegram route carries.
 */
export const maxDuration = 60;

/* ========================================================================== */
/* Reading the body                                                            */
/* ========================================================================== */

/**
 * Requirement 2.2's contract, and the single edge that applies it.
 *
 * `parseJsonBody` reads the JSON, parses it against `diagnoseRequestSchema` and names the coded
 * failure — including Requirement 9.5's `LANGUAGE_UNSUPPORTED`, whose branch lives there rather
 * than here because it is *one* rule and this is one of three endpoints stating it. See
 * `src/lib/api/request-body.ts` for why `languageSchema` is the check and `activeLanguage()` is
 * deliberately not.
 *
 * `fallback: 'STORAGE_REF_INVALID'` is this endpoint's own judgement, which is why it is a
 * parameter: everything that is not a language or a conversation rejection — an absent `image`, a
 * path outside the `{user_id}/{YYYY}/{MM}/{uuid}.{ext}` convention, the wrong bucket, a body that
 * is not an object, a body that is not JSON at all — is Requirement 2.2's contract failure, and the
 * taxonomy's code for "the request body carries a storage reference" is the closest thing the
 * closed vocabulary has to a general 400.
 *
 * No `endpointSpecific` branch: this endpoint has no rejection the other two do not.
 */
const BODY_CONTRACT = { fallback: 'STORAGE_REF_INVALID' } as const;

/* ========================================================================== */
/* The handler                                                                 */
/* ========================================================================== */

export const POST = authenticatedRoute(async (request, session) => {
  /**
   * This throws coded 400s, and they are rendered by the wrapper's envelope — whose language comes
   * from `?language=` or `Accept-Language`, because at this point the body's language code is
   * either unread or the very thing being refused. Rendering a `LANGUAGE_UNSUPPORTED` in the
   * unsupported language would be the one obviously wrong choice.
   */
  const body = await parseJsonBody(request, diagnoseRequestSchema, BODY_CONTRACT);
  const language: Language = body.language;

  /**
   * A second envelope, and not a redundant one: from here on the farmer's requested language is
   * known, and Requirement 15.3 wants the failure written in it. The wrapper's thunk cannot supply
   * that — `withErrorHandling` resolves the language **before** running the handler, so there is no
   * later assignment it could pick up. Nesting is what puts the parsed language in scope of the
   * envelope that will render `QUOTA_EXCEEDED`, `PROVIDERS_UNAVAILABLE` or `DIAGNOSIS_TIMEOUT`.
   */
  return withErrorHandling(
    async () => {
      /**
       * The one service call. `channel: 'web'` is a literal because `DiagnoseInput.channel` is
       * required (Requirement 16.5) and this route is only ever the web channel. Under Amendment A3
       * the body carries Media_References, not a storage path: `image` (a `crop-image` reference)
       * and an optional `thumbnail` reference, both validated by `diagnoseRequestSchema`. The
       * service reads the image bytes from GridFS through the Data_Access_Layer and sends them
       * inline — this route holds no client and passes no bytes (D1).
       *
       * `thumbnail` and `conversationId` are spread conditionally rather than passed as `undefined`,
       * which `exactOptionalPropertyTypes` distinguishes.
       */
      const outcome = await diagnose(
        {
          userId: session.userId,
          image: body.image,
          ...(body.thumbnail === undefined ? {} : { thumbnail: body.thumbnail }),
          language,
          channel: 'web',
          ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
        },
        { burst: burstLimiter() },
      );

      /**
       * Exactly `diagnoseResponseSchema`, and nothing more. The four fields are copied off the
       * outcome unchanged — no reshaping, no renaming, no derived field — so the wire contract and
       * the service's answer cannot drift apart. The annotation is the check: a service that
       * returned a shape outside the contract would fail to compile here.
       *
       * The outcome's remaining fields (`provider`, `usedFallback`, `rejectionReason`) are audit
       * facts and are deliberately left off the wire: which provider served a request is not a
       * farmer's business, and a client that could see it could start depending on it.
       */
      const payload: DiagnoseResponse = {
        diagnosisId: outcome.diagnosisId,
        conversationId: outcome.conversationId,
        result: outcome.result,
        quota: outcome.quota,
      };

      return Response.json(payload);
    },
    () => language,
  );
});
