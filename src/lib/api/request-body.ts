import 'server-only';

import type { ZodType, z } from 'zod';

import { AppError } from '@/lib/errors';
import type { ErrorCode } from '@/lib/schemas';

/**
 * The request-body edge: read the JSON, parse it against the endpoint's contract, and name the
 * coded failure — once, for all three farmer-facing endpoints.
 *
 * Requirements: 9.5 (a language code outside the Supported_Languages is HTTP 400 naming the
 *               supported codes), 2.2 / 8.1 (the JSON body contracts), 15.6 (the real parse
 *               failure stays server-side)
 * Design: "Route handlers (thin)"; *Ordered checks* step 2 — *"Request body Zod-parsed;
 *          unsupported language → 400 — no reserve"*
 *
 * ### Why this module exists
 *
 * `/api/diagnose`, `/api/chat` and `/api/voice` each carried their own `readJsonBody` and their own
 * `requestErrorFor`. The three `readJsonBody` copies were identical; the three
 * `LANGUAGE_UNSUPPORTED` branches were identical; and Requirement 9.5 is **one rule**, so three
 * copies of it is three places a fourth endpoint could be written slightly differently — the exact
 * drift Requirement 16's one-implementation discipline is about, applied to the edge instead of to
 * the services. There is now one branch that decides Requirement 9.5 for every endpoint, and
 * `request-body.test.ts` pins it in one place rather than three.
 *
 * What stays with each route is what is genuinely that endpoint's judgement: which code a body
 * that fails in no more specific way gets (`contract.fallback`), and any branch only that endpoint
 * has (`contract.endpointSpecific` — Requirement 8.3's `AUDIO_TOO_LONG`, which is meaningless on a
 * request that carries no audio). Both are parameters rather than branches in here, so this module
 * holds no per-endpoint opinion and a route cannot inherit one it did not ask for.
 *
 * ### `languageSchema` is the check. `activeLanguage()` is not
 *
 * The check is **not hand-rolled**: each request schema's `language` field is `languageSchema`, the
 * enum `schemas.ts` declares once, so an unsupported code is already a parse issue on the
 * `language` path by the time `edgeErrorFor` sees it. All that is left is naming the failure, and
 * `LANGUAGE_UNSUPPORTED` fills `details.supportedLanguages` from `SUPPORTED_LANGUAGES` in
 * `errors.ts` — so the three codes the response names come from the same array the parse rejected
 * against and cannot disagree with it.
 *
 * `src/lib/language.server.ts`'s `activeLanguage()` is emphatically *not* the helper for this, and
 * the reason is worth keeping written down because it looks like the obvious choice. It resolves
 * the active language for a server-rendered shell by reading the language cookie and falling back
 * to the profile and then to `en` — so handed an unsupported code it would **silently answer in
 * English instead of refusing**, which is Requirement 9.5 inverted. A fallback is right for a
 * screen that must render something; a refusal is right for a request that stated something Jamee
 * does not support.
 *
 * `envelopeLanguage()` in `authenticated-route.ts` falls back the same way, and for the same
 * reason: it decides which language a failure is *written in*, not whether the request is
 * acceptable. The two are complementary — a `LANGUAGE_UNSUPPORTED` is rendered in the
 * `?language=` / `Accept-Language` fallback, because rendering it in the unsupported language would
 * be the one obviously wrong choice.
 */

/* ========================================================================== */
/* Issues                                                                      */
/* ========================================================================== */

/**
 * A parse issue, as much of it as the edge reads.
 *
 * Typed structurally rather than with Zod's issue type, which is the shape the three routes already
 * used: `path[0]` names the field, and `code` is read by exactly one endpoint-specific branch
 * (`too_big` on `durationSeconds`). Nothing here needs to track a library's internal shape beyond
 * that, and a mapper written against this type keeps compiling across a Zod upgrade.
 */
export interface ParseIssue {
  readonly path: readonly PropertyKey[];
  readonly code?: string | undefined;
}

/**
 * An endpoint's own branch: the code for a rejection only that endpoint can have, or `null` to fall
 * through.
 *
 * Consulted **after** Requirement 9.5 and the conversation branch and **before** the fallback,
 * which preserves the order the voice route already had (language, conversation, duration,
 * catch-all). A mapper cannot therefore shadow the language refusal — a body that names both an
 * unsupported language and an over-long recording is `LANGUAGE_UNSUPPORTED`, because the language
 * is the thing Jamee will not do at all.
 */
export type IssueMapper = (issues: readonly ParseIssue[]) => ErrorCode | null;

/** What an endpoint contributes to the shared edge. */
export interface BodyContract {
  /**
   * The code for a body that fails the contract in no more specific way — an absent field, a path
   * outside the object convention, a body that is not an object at all.
   *
   * Explicit per endpoint rather than defaulted, because it is a statement about what that
   * endpoint's body *is*: on `/api/diagnose` and `/api/voice` the storage reference is the
   * substance of the body (Requirements 2.2, 8.1), so `STORAGE_REF_INVALID` is a fit rather than a
   * borrowing. `/api/chat` takes a typed question and therefore names `MESSAGE_INVALID`, the code
   * added for it — its own header carries the reasoning, and the gap it used to record is closed.
   */
  readonly fallback: ErrorCode;
  /** Branches only this endpoint has. Absent on the two endpoints that have none. */
  readonly endpointSpecific?: IssueMapper | undefined;
}

/* ========================================================================== */
/* Naming the failure                                                          */
/* ========================================================================== */

/**
 * Which coded failure a rejected body is — the one implementation, shared by all three endpoints.
 *
 * **Requirement 9.5 is the first branch, and it is the reason this function is shared.** The
 * response names the three supported codes through `LANGUAGE_UNSUPPORTED`'s implied details, so no
 * caller writes the list and no caller can write a stale one.
 *
 * A `conversationId` that is not a uuid gets `CONVERSATION_NOT_FOUND`, the same code the services
 * raise for an id that is not this farmer's. A client cannot tell "malformed" from "not yours" from
 * the outside, and it should not be able to: both mean "you may not write to that thread", and one
 * code for one meaning keeps the response from being an oracle.
 *
 * The rejected paths are logged as server-side `context` and never rendered (Requirement 15.6).
 */
export function edgeErrorFor(
  issues: readonly ParseIssue[],
  contract: BodyContract,
): AppError {
  const paths = issues.map((issue) => issue.path[0]);
  const context = { reason: 'schema_rejected', paths: paths.map((path) => String(path)) };

  if (paths.includes('language')) {
    // Requirement 9.5. `details.supportedLanguages` is implied by the code itself.
    return new AppError('LANGUAGE_UNSUPPORTED', { context });
  }
  if (paths.includes('conversationId')) {
    return new AppError('CONVERSATION_NOT_FOUND', { context });
  }

  const specific = contract.endpointSpecific?.(issues) ?? null;
  if (specific !== null) return new AppError(specific, { context });

  return new AppError(contract.fallback, { context });
}

/* ========================================================================== */
/* Reading and parsing                                                        */
/* ========================================================================== */

/**
 * The request body as unvalidated JSON.
 *
 * A body that is not JSON at all is a **400**, not a 500: it is a malformed request, and letting
 * `request.json()` throw into `withErrorHandling` would report Jamee's fault for the caller's. The
 * real parse failure is kept server-side, as Requirement 15.6 requires.
 */
async function readJsonBody(request: Request, fallback: ErrorCode): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch (cause) {
    throw new AppError(fallback, { cause, context: { reason: 'body_not_json' } });
  }
}

/**
 * Read the body, parse it against the endpoint's request schema, and throw the coded 4xx a
 * rejection deserves. The only place a route interprets client input.
 *
 * Returns the schema's output type, so the language a route hands to a service is a `Language` and
 * not a string — which is what lets `ChatQuestion.language` and `DiagnoseInput.language` be typed
 * rather than re-validated. Requirement 9.5 is enforced exactly once, here, and every layer behind
 * it is closed to an unsupported code by the type system.
 */
export async function parseJsonBody<Schema extends ZodType>(
  request: Request,
  schema: Schema,
  contract: BodyContract,
): Promise<z.infer<Schema>> {
  const payload = await readJsonBody(request, contract.fallback);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw edgeErrorFor(parsed.error.issues, contract);
  return parsed.data as z.infer<Schema>;
}
