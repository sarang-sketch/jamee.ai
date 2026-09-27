import { authenticatedRoute } from '@/lib/api/authenticated-route';
import { parseJsonBody } from '@/lib/api/request-body';
import { withErrorHandling } from '@/lib/errors';
import { burstLimiter } from '@/lib/rate-limit';
import { chatRequestSchema, type ChatResponse, type Language } from '@/lib/schemas';
import { chatTurn } from '@/services/chat.service';

/**
 * `POST /api/chat` — the web channel's entry to the shared `ChatService`.
 *
 * Requirements: 1.7 (no valid session → HTTP 401 and no domain service invoked), 7.4 (the farmer
 *               message and the Jamee answer are persisted as Messages in the same Conversation),
 *               9.5 (a language code outside the Supported_Languages is HTTP 400 naming the
 *               supported codes), 14.1 (one chat message spends exactly one chat unit), 16.2 (one
 *               chat implementation serves the Web_App and the Telegram channel), 16.5 (`channel` is
 *               an input parameter and is recorded on the persisted rows), 15.3 (every failure
 *               leaves through the one localized error envelope)
 * Design: "Route handlers (thin)"; D9; "Quota enforcement" → *When a unit is reserved, finalized, or
 *         refunded*
 * Depends on: V17 (the duration ceiling and the route segment config that declares it)
 *
 * ### Five steps, and nothing else — the same five as `/api/diagnose`
 *
 * Session check (the wrapper) → read the body → parse it → **one** service call → serialize the
 * result. No agronomy, no prompt text, no provider call, no SQL, no quota arithmetic, and no second
 * call to anything: every judgement a farmer sees was made by `ChatService`, which is what keeps the
 * web and Telegram channels answering identically (Requirements 7.7, 16.2) rather than by agreement
 * between two handlers.
 *
 * The ordering that matters is not maintained here either — it is the wrapper's. The handler body is
 * a callback that only runs after a non-null user id has been resolved, so "the session check
 * precedes any domain service call, any quota reserve and any provider call" is the only order the
 * control flow permits (Requirement 1.7).
 *
 * ### Where the spend rule lives, and why not here
 *
 * The design's ordered sequence — ownership, burst check seam, reserve, provider work, persist,
 * audit — runs inside `chatTurn()`, exactly as the diagnosis path's runs inside `diagnose()`. It is
 * taken there and not here because **chat is the entry point for this request**, and the same
 * function also serves the case where it is not: a chat answer produced inside a voice request
 * inherits that request's reservation and reserves nothing (Requirement 14.1). A reserve written
 * into this file would be a second implementation of that rule, reachable from one channel only, and
 * the nesting case would have nowhere to live.
 *
 * So this route passes no `QuotaContext`. Omitting it *is* the statement "this request enters here",
 * and `chatTurn()` reads it as `ownsRequest(userId, 'chat')`.
 *
 * ### What the service is given, and what it is not
 *
 * `deps` is `{ burst }` — Requirement 13.8's burst limiter, bound here because this is one of the
 * three endpoints that requirement names. The service owns the check's **position** (step 2, before
 * the reserve, so a refusal costs nothing) and skips it altogether for a turn that is `covered` by an
 * outer reservation; this file owns the decision to enforce it at all.
 *
 * *Amendment A3:* the route builds and passes no database client. Under A3 there is no relational
 * RLS layer; `chatTurn` reads and writes through the owner-scoped Data_Access_Layer, scoped by the
 * `userId` the service supplies, which is the sole tenant boundary. The two `messages` writes, the
 * conversation-ownership lookup and the activity bump all run through that layer, and the `usage_logs`
 * audit write is likewise the service's own business through the same layer — this route neither
 * builds nor holds a credential for it.
 */

/**
 * **V17.** Jamee's own ceiling, in seconds — not the platform's documented 300
 * (`PLATFORM_MAX_DURATION_SECONDS`). Every soft timeout in Jamee is a fraction of this number, so
 * raising it is a deliberate act with arithmetic consequences (`docs/PROVIDER_CAPABILITIES.md`
 * section 3).
 *
 * Written as a literal because Next.js reads route segment config by static analysis, so an imported
 * constant is not usable here. `route.test.ts` asserts this literal equals
 * `JAMEE_MAX_DURATION_SECONDS`, which is what stops the two drifting apart — the same guard the
 * diagnose and Telegram routes carry.
 */
export const maxDuration = 60;

/* ========================================================================== */
/* Reading the body                                                            */
/* ========================================================================== */

/**
 * `chatRequestSchema`'s contract, and the single edge that applies it.
 *
 * `parseJsonBody` reads the JSON, parses it against the schema and names the coded failure —
 * including Requirement 9.5's `LANGUAGE_UNSUPPORTED`, whose branch lives in
 * `src/lib/api/request-body.ts` rather than here because it is *one* rule and this is one of three
 * endpoints stating it. That module also records why `languageSchema` is the check and why
 * `language.server.ts`'s `activeLanguage()` is not: handed an unsupported code it falls back to
 * `en`, where Requirement 9.5 wants a refusal.
 *
 * A `conversationId` that is not a uuid gets `CONVERSATION_NOT_FOUND` there too, the same code
 * `chatTurn()` raises for an id that is not this farmer's. A client cannot tell "malformed" from
 * "not yours" from the outside, and it should not be able to: both mean "you may not write to that
 * thread", and one code for one meaning keeps the response from being an oracle.
 *
 * `fallback` is this endpoint's own judgement, which is why it is a parameter rather than a branch in
 * the shared module. Everything that is not a language or a conversation rejection — an absent
 * `message`, an empty one, one past the 1000-character contract, a body that is not an object, a body
 * that is not JSON at all — takes it, and here that is `MESSAGE_INVALID` (400, not retryable).
 *
 * **This used to be `STORAGE_REF_INVALID`, borrowed from the diagnose route as a catch-all for "the
 * body does not satisfy the request contract", and recorded here as a taxonomy gap.** The status and
 * the flag were right; the *sentence* was not. Its `en` rendering is "That photo could not be found.
 * Please upload it again.", which names a photo this endpoint never takes — and the sentence is the
 * part a farmer reads (Requirement 15.3). Task 25.2 closed the gap by adding the text counterpart of
 * that code, so the sentence now asks for the thing this endpoint actually wants. The status, the
 * flag and the spend are all unchanged: still 400, still not retryable, and still no unit spent,
 * because the parse happens before the service is called at all.
 *
 * `/api/diagnose` and `/api/voice` keep `STORAGE_REF_INVALID` for their own malformed bodies, and
 * that is not an oversight — Requirements 2.2 and 8.1 make the storage reference the substance of
 * those bodies, so the code describes what is wrong there. One shared edge, three endpoint-specific
 * catch-alls: the rule that is the same everywhere is written once, and the code that differs per
 * endpoint is stated at the endpoint.
 *
 * No `endpointSpecific` branch: this endpoint has no rejection the other two do not.
 */
const BODY_CONTRACT = { fallback: 'MESSAGE_INVALID' } as const;

/* ========================================================================== */
/* The handler                                                                 */
/* ========================================================================== */

export const POST = authenticatedRoute(async (request, session) => {
  /**
   * This throws coded 4xxs, and they are rendered by the wrapper's envelope — whose language comes
   * from `?language=` or `Accept-Language`, because at this point the body's language code is either
   * unread or the very thing being refused. Rendering a `LANGUAGE_UNSUPPORTED` in the unsupported
   * language would be the one obviously wrong choice.
   */
  const body = await parseJsonBody(request, chatRequestSchema, BODY_CONTRACT);
  const language: Language = body.language;

  /**
   * A second envelope, and not a redundant one: from here on the farmer's requested language is
   * known, and Requirement 15.3 wants the failure written in it. The wrapper's thunk cannot supply
   * that — `withErrorHandling` resolves the language **before** running the handler, so there is no
   * later assignment it could pick up. Nesting is what puts the parsed language in scope of the
   * envelope that will render `QUOTA_EXCEEDED` or `CONVERSATION_NOT_FOUND`.
   */
  return withErrorHandling(
    async () => {
      /**
       * The one service call.
       *
       * `channel: 'web'` is a literal because `ChatInput.channel` is required (Requirement 16.5) and
       * this route is only ever the web channel; the Telegram adapter passes its own. `inputKind:
       * 'text'` is likewise a literal — a typed question is text, and the voice path sets `'voice'`
       * on its own call so the transcript is distinguishable afterwards (Requirement 8.4).
       *
       * *Amendment A3:* no database client is built or passed. `chatTurn` writes and reads through
       * the owner-scoped Data_Access_Layer, scoped by `userId`, so `deps` carries only Requirement
       * 13.8's burst limiter (bound here because this is one of the three endpoints that requirement
       * names). `skipQuotaReserve` is deliberately absent and no `QuotaContext` is passed: this
       * request is the entry point for its own chat unit.
       *
       * Everything a farmer sees comes back from here — including the out-of-scope and
       * no-verified-content referrals (Requirements 4.7, 7.6), which the service answers from the
       * repository's own pre-translated copy without calling a model. A provider failure is not an
       * error on this path either: the service degrades to the grounded knowledge-base template
       * rather than surfacing `DIAGNOSIS_TIMEOUT`. That decision, and its audit trail, live in
       * `chat.service.ts`.
       */
      const outcome = await chatTurn(
        {
          userId: session.userId,
          conversationId: body.conversationId,
          message: body.message,
          language,
          channel: 'web',
          inputKind: 'text',
        },
        { burst: burstLimiter() },
      );

      /**
       * Exactly `chatResponseSchema`, and nothing more. The four fields are copied off the outcome
       * unchanged — no reshaping, no renaming, no derived field — so the wire contract and the
       * service's answer cannot drift apart. The annotation is the check: a service that returned a
       * shape outside the contract would fail to compile here.
       */
      const payload: ChatResponse = {
        conversationId: outcome.conversationId,
        farmerMessageId: outcome.farmerMessageId,
        answer: outcome.answer,
        quota: outcome.quota,
      };

      return Response.json(payload);
    },
    () => language,
  );
});
