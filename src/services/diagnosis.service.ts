import 'server-only';

import { getDeadline } from '@vercel/functions';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  gatewayRunner,
  type CapabilityRunner,
  type TextCall,
  type VisionCall,
} from '@/lib/ai/capabilities';
import {
  attemptPlan,
  computeDeadline,
  type GatewayResult,
  type RunOptions,
} from '@/lib/ai/gateway';
import { ACCEPTED_IMAGE_TYPES, STORAGE_BUCKETS } from '@/lib/config/verified';
import {
  outcomeForDegradation,
  rejectionReasonForDegradation,
  writeUsageLog,
  type RephraseDegradation,
  type UsageFacts,
} from '@/lib/db/usage-log';
import { AppError, isAppError } from '@/lib/errors';
import {
  knowledgePayloadOf,
  knowledgeReaderFrom,
  lookupCondition,
  type KnowledgeEntry,
  type KnowledgeReader,
} from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import { noBurstCheck, type BurstCheck } from '@/lib/rate-limit';
import {
  CLASSIFICATION_PROMPT,
  VISION_RESPONSE_JSON_SCHEMA,
  rephrasePrompt,
  staticExplanationFor,
  validateRephrased,
} from '@/lib/prompts';
import {
  HEALTHY_CONDITION,
  visionRawSchema,
  visionVerifiedSchema,
  type DiagnoseInput,
  type DiagnosisResult,
  type IdentifiedResult,
  type InconclusiveResult,
  type Language,
  type Operation,
  type QuotaStatus,
  type RejectionReason,
  type Severity,
  type UsageOutcome,
  type UsageRejectionReason,
  type VerifiedCondition,
  type VisionRaw,
  type VisionVerified,
} from '@/lib/schemas';
import { assertOwnershipInBucket, signedUrlFor, type StorageClientLike } from '@/lib/storage';
import {
  conversationStoreFrom,
  findOrCreateActive,
  type ConversationStore,
} from '@/services/conversation.service';
import {
  ownsRequest,
  quotaExceededError,
  quotaStatusOf,
  refundReservation,
  reserveForRequest,
  type QuotaOptions,
  type QuotaReservation,
} from '@/services/quota.service';
import type { Database, DiagnosisRow, TablesInsert } from '@/types/database';

/**
 * The single image-analysis implementation. Both channels enter here (Requirements 3.8, 16.1, 16.3).
 *
 * Requirements: 2.8 (image bytes are read through a Signed_URL), 3.1 (the classification request
 *               asks for a candidate condition, a confidence in [0,1] and a Severity_Value), 3.2
 *               (an identified result's explanation is composed only from the matching Knowledge_Base
 *               entry), 3.3 (the result is persisted with farmer, conversation, storage reference and
 *               channel), 3.4 (a healthy crop reports severity `none` and carries no treatment
 *               content), 3.5 (exactly one primary condition), 3.7 (budget expiry returns a timeout
 *               naming the diagnosis operation and records it), 3.8 / 16.1 / 16.3 (one
 *               implementation serving the Web_App and WhatsApp), 5.1 (every model response is
 *               parsed against a Zod schema before any part of it is persisted or returned), 5.7
 *               (the rejection reason is recorded and the rejected content is excluded), 6.1–6.6
 *               (one inconclusive shape for every non-identified cause, no further model call),
 *               6.7 (an accepted inconclusive result still counts exactly one image analysis),
 *               16.5 (`channel` is an input parameter and is written to every persisted row)
 * Design: D2 (two-stage validation), D3 (every failure produces the one inconclusive shape),
 *         D4 (no repair re-ask), D7 (channel parity is one code path and identical structured
 *         fields), D10 (`usage_logs` is append-only audit, not the quota source of truth);
 *         "Diagnosis sequence"; "Quota enforcement" → *When a unit is reserved, finalized, or
 *         refunded*
 *
 * =============================================================================
 * THE ORDER OF OPERATIONS IS THE CONTRACT
 * =============================================================================
 *
 * Not a style preference — the order is what makes the requirements true, and each step names the
 * criterion it satisfies by *being where it is*:
 *
 *  1. **Ownership** (`assertOwnershipInBucket`) — Requirements 2.5, 2.6. Before the reserve, so
 *     "leave the farmer's quota unchanged" holds because nothing was taken, not because something
 *     was given back.
 *  2. **Burst check** — Requirement 13.8, `src/lib/rate-limit.ts`. Before the reserve, so a refused
 *     burst request never increments the daily counter and never needs a refund.
 *  3. **Quota reserve** — Requirements 14.1–14.3. At-limit declines here and **calls no provider**.
 *  4. **Signed URL** — Requirement 2.8. The last step that can still be refunded: no provider call
 *     has been attempted yet.
 *  5. **`vision-classify`** — Requirement 3.1. From this instant the unit is spent, whatever
 *     happens next.
 *  6. **Stage 1, shape** — Requirements 5.1–5.5.
 *  7. **Stage 2, knowledge-base membership** — Requirements 5.6, 6.1. The safety gate.
 *  8. **Grounding and rephrase, identified results only** — Requirements 3.2, 4.3, 4.5, 4.6, 9.3.
 *  9. **Persistence** — Requirement 3.3.
 * 10. **Usage log** — Requirements 5.7, 14.6, 14.7, 3.7.
 *
 * Moving any step earlier or later changes which requirement holds. The unit tests assert the order
 * by observing what a stub was *not* asked to do.
 *
 * =============================================================================
 * THE SPEND RULE, AND THE ONE PLACE IT DIVERGES FROM THE DESIGN'S LIST
 * =============================================================================
 *
 * The rule is the biconditional in `quota.service.ts`: **a unit is spent if and only if at least one
 * provider call was attempted for that request.** The design's step 9 then *enumerates* the
 * refundable failures — signed-URL issuance, an unreadable object, a knowledge-base read, an
 * unhandled error ahead of the gateway call.
 *
 * In this pipeline the knowledge-base read is at step 8, **after** the classification. So a
 * knowledge-base failure here is NOT refunded, and that is the biconditional applied faithfully
 * rather than a departure from it: the enumeration describes a generic service where the KB read
 * precedes the model call (which is true of `ChatService`, where scope resolution runs first and
 * costs zero provider calls). Requirement 3.2 forces the order here — an explanation must be
 * grounded in the row for the condition the model named, so the row cannot be read before the name
 * exists.
 *
 * Everything at or after step 5 is spent and stays spent, including a both-providers-failed
 * classification and a timeout. Deliberate: those requests consumed real provider capacity, and
 * refunding them would let a failing provider drain the free tier through retries.
 *
 * =============================================================================
 * TWO DECISIONS ABOUT THE REPHRASE STEP, BOTH FLAGGED RATHER THAN ASSUMED
 * =============================================================================
 *
 * `docs/PROVIDER_CAPABILITIES.md` section 3 records that a diagnosis needing the **vision fallback**
 * may have no budget left to rephrase: `2 s + 20 s + 20 s` of a 45 s budget leaves 3 s, below
 * `text-generate`'s 5 s minimum-remaining guard.
 *
 *  - **Budget exhausted → `DIAGNOSIS_TIMEOUT`, as Requirement 3.7 specifies.** Checked with
 *    `attemptPlan()` *before* the call rather than discovered mid-flight, so the request fails on
 *    arithmetic instead of on a wasted provider attempt. The open item in that document proposes
 *    serving `staticExplanationFor()` here instead — grounded content rather than an error — and it
 *    is not adopted, because it changes observable behaviour on a path the requirement currently
 *    specifies as a timeout. That remains the user's call; the mechanism is one line away.
 *  - **The rephrase provider failing → the static localized template**, not an error. This is the
 *    design's own remedy in *Post-generation validation of rephrased text*, check 4: "identified
 *    diagnoses fall back to a static localized … template built from the knowledge-base row itself,
 *    so the farmer still receives KB-grounded content. This keeps Requirement 3.2 true even when the
 *    language model is unhelpful." A provider outage is the language model at its least helpful, and
 *    Requirement 14.8's busy-message rule is written about *image interpretation*, which has already
 *    succeeded by this point. The failure is not hidden: the `usage_logs` row records
 *    `outcome = 'provider_error'` while carrying a `diagnosis_id`, so "degraded but served" and
 *    "failed" are distinguishable in the audit by whether that reference is present.
 *
 * =============================================================================
 * WHY EVERY CLIENT IS A PARAMETER
 * =============================================================================
 *
 * Requirement 3.8 needs one implementation for two callers holding different credentials: the web
 * route has a farmer session (RLS-scoped client), and the WhatsApp webhook has no session at all
 * (service-role client). So `DiagnosisDeps.supabase` is the request's client and every seam is
 * derived from it — the same pattern as `storage.ts`, `knowledge.ts` and `conversation.service.ts`.
 * A module that constructed its own client would have had to pick one caller and break the other.
 *
 * The one exception is the `usage_logs` insert, and it is a database fact rather than a choice:
 * migration `0006` grants `authenticated` **no** insert policy — "append-only" is enforced by that
 * absence — so the audit row is only writable with the service role. See `diagnosisStoreFrom()`.
 *
 * =============================================================================
 * WHAT IS DELIBERATELY NOT HERE
 * =============================================================================
 *
 * **No HTTP.** No `Request`, no `Response`, no cookies, no WhatsApp payload shapes. The route
 * (task 11.3) parses and maps; this service decides.
 *
 * **No `messages` row.** The design's diagnosis sequence persists `diagnoses` and `usage_logs` and
 * nothing else; Requirement 7.4 attaches messages to a *chat* turn, and inventing a farmer message
 * for an image upload would put a fabricated string in a farmer's conversation history.
 *
 * **No `conversations.updated_at` bump.** `conversation.service.ts` assigns that to the code that
 * persists a message, which this is not.
 *
 * **No burst ceiling arithmetic.** Requirement 13.8 lives in `src/lib/rate-limit.ts`; this file
 * owns only the *position* of the check — step 2, before the reserve — and calls whatever the caller
 * bound there.
 */

/** This service reserves, and audits, exactly one operation type. */
const OPERATION: Operation = 'image';

/* ========================================================================== */
/* Step 2's seam — the burst limiter (Requirement 13.8)                         */
/* ========================================================================== */

/**
 * `BurstCheck` and `noBurstCheck` **were declared here** while Requirement 13.8 had no
 * implementation, so the *position* of the check could be fixed before the check existed — between
 * ownership and the reserve, which is the position that makes it unrefundable by construction (there
 * is nothing to refund yet) and keeps it from touching the daily counter.
 *
 * Task 24.1 built the implementation in `src/lib/rate-limit.ts`, the home the design gives
 * Requirement 13.8, and the declarations moved there with it rather than being copied — all three
 * services now import them from that module. Nothing about the seam's shape or its position changed;
 * this note exists so the move is legible from the file the seam used to live in.
 */

/* ========================================================================== */
/* The persistence seam                                                        */
/* ========================================================================== */

export interface DiagnosisStore {
  /** Requirement 3.3. Returns the stored row, because the response and the audit need its id. */
  insertDiagnosis(row: TablesInsert<'diagnoses'>): Promise<DiagnosisRow>;
  /** Requirements 5.7, 14.6, 14.7, 3.7. Append-only (D10). */
  insertUsageLog(row: TablesInsert<'usage_logs'>): Promise<void>;
  /**
   * Whether a client-supplied conversation id is this farmer's.
   *
   * `conversation.service.ts` declines to resolve a client-supplied identifier — "mixing it in here
   * would blur 'find the active thread' with 'trust this client-supplied id'" — and the design gives
   * `CONVERSATION_NOT_FOUND` to the requesting route. The check is *also* made here, for one reason
   * that is not redundant: `conversationId` is an optional field on a JSON body (Requirement 2.2),
   * and without it a farmer could attach their diagnosis to another farmer's thread. The
   * `diagnoses` RLS policy would not catch that — it constrains `user_id`, not `conversation_id`.
   */
  ownsConversation(conversationId: string, userId: string): Promise<boolean>;
}

/**
 * Bind the store to the request's client, with the audit write on the service role.
 *
 * Two clients, and the split is the policy set, not a preference:
 *
 *  - **`diagnoses`** has `diagnoses_insert_own` (`auth.uid() = user_id`, migration 0005), so on the
 *    web path the insert is written with the farmer's own session and **RLS is a second boundary**
 *    behind the `user_id` this service supplies. On the WhatsApp path `client` *is* the service-role
 *    client and the application check is the only boundary — which is why the row's `user_id` is
 *    always the resolved farmer and never anything derived from a payload.
 *  - **`usage_logs`** has a select policy and nothing else (migration 0006). The audit row is
 *    therefore unwritable with a farmer session, by design, so it goes through `auditClient`.
 *
 * A PostgREST `error` is never read as an empty result, the same rule `knowledge.ts` and
 * `conversation.service.ts` state: the cause is logged server-side and the farmer sees
 * `INTERNAL_ERROR` (Requirement 15.6).
 */
export function diagnosisStoreFrom(
  client: SupabaseClient<Database>,
  auditClient: SupabaseClient<Database>,
): DiagnosisStore {
  return {
    async insertDiagnosis(row) {
      const { data, error } = await client.from('diagnoses').insert(row).select('*').single();
      if (error !== null || data === null) {
        throw new AppError('INTERNAL_ERROR', {
          cause: error,
          context: {
            reason: 'diagnosis_insert_failed',
            userId: row.user_id,
            conversationId: row.conversation_id,
            status: row.status,
          },
        });
      }
      return data;
    },

    async insertUsageLog(row) {
      const { error } = await auditClient.from('usage_logs').insert(row);
      if (error !== null) {
        throw new AppError('INTERNAL_ERROR', {
          cause: error,
          context: {
            reason: 'usage_log_insert_failed',
            userId: row.user_id,
            outcome: row.outcome,
          },
        });
      }
    },

    async ownsConversation(conversationId, userId) {
      const { data, error } = await client
        .from('conversations')
        .select('id')
        // Both predicates matter: `id` selects the row, `user_id` is the tenant boundary — the only
        // boundary when `client` is the service-role client (admin.ts).
        .eq('id', conversationId)
        .eq('user_id', userId)
        .maybeSingle();

      if (error !== null) {
        throw new AppError('INTERNAL_ERROR', {
          cause: error,
          context: { reason: 'conversation_lookup_failed', conversationId, userId },
        });
      }
      return data !== null;
    },
  };
}

/* ========================================================================== */
/* Dependencies                                                                */
/* ========================================================================== */

export interface DiagnosisDeps {
  /**
   * The request's Supabase client: RLS-scoped for the web path, service-role for WhatsApp.
   *
   * Required rather than defaulted, deliberately. A default would be one credential, and the caller
   * that needed the other would have to remember to override it — on the WhatsApp path that mistake
   * surfaces as a cookie read outside a request scope, which is a confusing failure for a
   * straightforward omission. Making it explicit means the credential decision is visible at every
   * call site.
   */
  readonly supabase: SupabaseClient<Database>;
  /** Storage reads. Defaults to `supabase`, which satisfies the narrow slice `storage.ts` needs. */
  readonly storage?: StorageClientLike;
  /** Defaults to `diagnosisStoreFrom(supabase, createAdminClient())`, built on first use. */
  readonly store?: DiagnosisStore;
  readonly conversations?: ConversationStore;
  readonly knowledge?: KnowledgeReader;
  /** The two model calls. Defaults to the real gateway over the real adapter sets. */
  readonly models?: CapabilityRunner;
  /**
   * Step 2, Requirement 13.8. `/api/diagnose` binds `burstLimiter()`; the default is `noBurstCheck`,
   * which is what keeps a unit test from opening a connection to check a ceiling it is not testing.
   */
  readonly burst?: BurstCheck;
  /** The counter RPC seam and the quota clock. Both default inside `quota.service.ts`. */
  readonly quota?: QuotaOptions;
  /** Injected clock, epoch ms. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** A deadline already computed for this request; otherwise derived once, here. */
  readonly deadlineMs?: number;
  /** Source of the platform deadline. Defaults to V18's `getDeadline()`. */
  readonly platformDeadline?: () => Date | undefined;
  /** The caller's abort, linked into every provider attempt. */
  readonly signal?: AbortSignal;
}

/**
 * What the caller gets back.
 *
 * The first four fields are exactly `diagnoseResponseSchema`, so the route serializes them without
 * reshaping. The last three are audit facts a caller may want to log or, on the WhatsApp path, use
 * to decide how to phrase a reply — never to change the diagnosis itself, which is what D7's parity
 * definition rests on: same service invocation, same knowledge-base row, identical structured
 * fields.
 */
export interface DiagnosisOutcome {
  readonly diagnosisId: string;
  readonly conversationId: string;
  readonly result: DiagnosisResult;
  readonly quota: QuotaStatus;
  /** Which provider served the classification. */
  readonly provider: 'gemini' | 'groq';
  /** True when any model call in this request was served by a fallback member (Requirement 14.7). */
  readonly usedFallback: boolean;
  /** Present exactly when `result.status === 'unknown'` (Requirement 5.7). */
  readonly rejectionReason?: RejectionReason;
}

/* ========================================================================== */
/* Stage 1 and stage 2 (D2)                                                    */
/* ========================================================================== */

/**
 * What the two validation stages produced: a verified condition, or one attributable reason.
 *
 * There is no third branch, and that is D3 made structural — every way of not being identified
 * (malformed JSON, a missing field, an out-of-range confidence, an unknown severity, a name outside
 * the five, the model's own `unclear`, the model's own `no_plant`) leaves through
 * `{ ok: false, reason }` and therefore through the same farmer-facing shape.
 */
type Interpretation =
  | { readonly ok: true; readonly verified: VisionVerified }
  | { readonly ok: false; readonly reason: RejectionReason };

/**
 * Which rejection reason a stage-1 failure is.
 *
 * `rejectionReasonSchema` is a **closed** vocabulary owned by `schemas.ts`, with one value per
 * acceptance criterion, so this function's whole job is picking the right one when a response fails
 * several checks at once. Three rules, in this order, and the order is the requirement numbering:
 *
 *  1. **An absent or wrongly-typed field is `missing_field`** (Requirement 5.3), whatever else is
 *     also wrong. A response that omitted `severity` has not supplied a severity *value* to be
 *     outside the vocabulary, and one that omitted `confidence` has supplied nothing to be out of
 *     range — reporting either as a value problem would misattribute the rejection in the audit.
 *     This rule also covers a payload that parsed as JSON but is not the diagnosis object at all
 *     (`"unclear"`, `[]`): every required field is absent from it.
 *  2. **A `severity` outside the four values is `invalid_severity`** (Requirement 5.5).
 *  3. **A `confidence` outside the closed interval is `confidence_out_of_range`** (Requirement 5.4).
 *
 * A response failing both 2 and 3 is logged as `invalid_severity`; one reason has to win, and stating
 * which keeps the audit deterministic.
 *
 * What is deliberately *not* here is an eighth reason for "present but unusable" — e.g. a `status`
 * outside the three values, which lands on rule 1. Adding one would change a contract `schemas.ts`
 * owns in order to record a distinction no farmer can act on: all four schema reasons already render
 * identical copy (see `messages/en.ts`).
 *
 * ### Rule 1 reads the PAYLOAD, not the issue codes, and it has to
 *
 * The first spelling of rule 1 was `issues.some((issue) => issue.code === 'invalid_type')`, on the
 * assumption that Zod reports a wrong JSON type as `invalid_type` for every field. It does not, and
 * the exception is the one field rule 1 is documented against: `severity` is a `z.enum`, and Zod
 * reports **`invalid_value` for an absent key, a wrong-typed value, and a non-member value alike**.
 * Verified against `visionRawSchema`:
 *
 * ```
 * {"status":"unclear","disease_name":" ","confidence":0}                  → invalid_value ["severity"]
 * {"status":"unclear","disease_name":" ","confidence":0,"severity":false} → invalid_value ["severity"]
 * {"status":"unclear","disease_name":" ","confidence":0,"severity":"bad"} → invalid_value ["severity"]
 * ```
 *
 * So rule 1 never fired for `severity` and rule 2 claimed all three cases, labelling a response
 * carrying **no severity key at all** `invalid_severity`. The accept/reject verdict was unaffected —
 * which is why Property 6 held and why this went unseen — but Requirement 5.7's audit was wrong in
 * exactly the way the two reasons exist to prevent: `missing_field` and `invalid_severity` are there
 * to tell a malformed response from a response carrying an unsupported *value*, and they did not.
 *
 * The fix is to decide rule 1 from the parsed payload, which is the only place the distinction is
 * legible: a key is absent or it carries a JSON type the field cannot accept, and neither question
 * has anything to do with which issue code Zod chose. `CARRIES_JSON_TYPE_OF` states the accepted
 * type per field, once. Rules 2 and 3 then run over values already known to be well typed, so an
 * issue on `severity` or `confidence` can only be a *value* problem — which is what they claim.
 *
 * `confidence: 1e999` is deliberately NOT wrongly typed: `JSON.parse` yields `Infinity`, a number,
 * and a number outside the interval is Requirement 5.4's case rather than 5.3's.
 */

/** The JSON type each required field accepts, so "wrongly typed" is one statement per field. */
const CARRIES_JSON_TYPE_OF: Readonly<Record<keyof VisionRaw, (value: unknown) => boolean>> = {
  status: (value) => typeof value === 'string',
  /** Nullable by schema (D2), so `null` is a legal type here — an empty string is a value problem. */
  disease_name: (value) => value === null || typeof value === 'string',
  confidence: (value) => typeof value === 'number',
  severity: (value) => typeof value === 'string',
};

const REQUIRED_VISION_FIELDS = Object.keys(CARRIES_JSON_TYPE_OF) as (keyof VisionRaw)[];

function stage1Reason(
  payload: unknown,
  issues: readonly { code: string; path: readonly PropertyKey[] }[],
): RejectionReason {
  // Rule 1's other half: a payload that parsed as JSON but is not the diagnosis object at all
  // (`"unclear"`, `[]`, `null`) has every required field absent from it.
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return 'missing_field';
  }
  const record = payload as Record<string, unknown>;

  // Rule 1. An absent key reads as `undefined`, which no accepted type admits, so absence and a
  // wrong type are the same check — as Requirement 5.3 treats them.
  for (const field of REQUIRED_VISION_FIELDS) {
    if (!CARRIES_JSON_TYPE_OF[field](record[field])) return 'missing_field';
  }

  // Rules 2 and 3, over values that are at least the right type.
  const onField = (field: keyof VisionRaw): boolean =>
    issues.some((issue) => issue.path[0] === field);

  if (onField('severity')) return 'invalid_severity';
  if (onField('confidence')) return 'confidence_out_of_range';
  return 'missing_field';
}

/**
 * Run both validation stages over the model's raw text (Requirement 5.1).
 *
 * ### The text is parsed strictly, and no markdown fence is stripped
 *
 * A fenced ```json block is `not_json` here. Both configured members return raw JSON — Gemini by
 * V7's request-level `response_format` with a schema, Groq by V9's `json_object` mode — so a fence
 * would mean a provider ignored its own output contract, and quietly repairing that is Jamee
 * performing a content repair on the model's behalf. D4 forbids re-asking the model to fix its
 * output; unwrapping it locally is the same leniency without the round trip, and it would make the
 * inconclusive rate stop reporting a real provider problem.
 *
 * ### The model's own non-identified statuses are not failures
 *
 * `unclear` and `no_plant` are the model reporting honestly (Requirements 6.2, 6.3) and they arrive
 * as a *valid* stage-1 parse. They still collapse into the same inconclusive shape, which is why
 * their reasons sit in the same union — the difference is visible only in
 * `usage_logs.rejection_reason` and in which static sentence the farmer reads.
 */
export function interpret(raw: string): Interpretation {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: 'not_json' };
  }

  const stage1 = visionRawSchema.safeParse(payload);
  if (!stage1.success) return { ok: false, reason: stage1Reason(payload, stage1.error.issues) };

  if (stage1.data.status === 'unclear') return { ok: false, reason: 'model_unclear' };
  if (stage1.data.status === 'no_plant') return { ok: false, reason: 'model_no_plant' };

  // Stage 2 — the safety gate. The only way to fail from here is a `disease_name` outside the five
  // verified conditions (including `null` on an `identified` response), which is Requirement 5.6
  // and, farmer-facing, Requirement 6.1.
  const stage2 = visionVerifiedSchema.safeParse(stage1.data);
  return stage2.success
    ? { ok: true, verified: stage2.data }
    : { ok: false, reason: 'unverified_condition' };
}

/* ========================================================================== */
/* The one inconclusive shape (Requirements 6.4, 6.5; D3)                      */
/* ========================================================================== */

/**
 * Build the inconclusive result for a reason.
 *
 * **The model's disease name and its confidence are not carried here in any form** (Requirement
 * 6.5). They are not passed to this function, so there is nothing to forget to discard: the type
 * pins `diseaseName`, `confidence` and `knowledge` to `null`, `severity` to `'none'` and
 * `needsExpert` to `true`, and the `diagnoses_unknown_shape` check constraint enforces the same
 * shape at the database. Two independent boundaries, neither relying on a developer remembering.
 *
 * The explanation is a static catalog lookup (D5) — **no model call is reachable from here**
 * (Requirement 6.6).
 */
function inconclusiveFor(reason: RejectionReason, language: Language): InconclusiveResult {
  return {
    status: 'unknown',
    diseaseName: null,
    confidence: null,
    severity: 'none',
    explanation: messages(language).inconclusive[reason],
    knowledge: null,
    needsExpert: true,
    language,
  };
}

/**
 * `validation_rejected` for the five reasons Jamee's Validation_Layer produced (Requirements
 * 5.2–5.6), `inconclusive` for the two the model reported itself (6.2, 6.3).
 *
 * Both are farmer-identical (Requirement 6.4) and both spend one unit (6.7). The split exists
 * because `usage_logs.outcome` can express it and because it answers a real question from a week of
 * rows: is the model refusing to judge photos, or is it answering in a shape Jamee rejects? The
 * `rejection_reason` column narrows either answer further (5.7, D2).
 */
function outcomeFor(reason: RejectionReason): UsageOutcome {
  return reason === 'model_unclear' || reason === 'model_no_plant'
    ? 'inconclusive'
    : 'validation_rejected';
}

/* ========================================================================== */
/* Object MIME type, from the reference                                        */
/* ========================================================================== */

/**
 * The MIME type the provider is told the image carries, derived from the object's extension.
 *
 * Requirement 2.4's admission check runs in the browser against the file the farmer selected, and
 * the bytes are in Storage by the time this service sees a reference — so the extension is the only
 * statement of type available here, and `storageRefSchema` has already constrained its shape. An
 * extension outside `ACCEPTED_IMAGE_TYPES` is `FILE_TYPE_UNSUPPORTED` (400) and is decided **before
 * the reserve**, so a reference Jamee will not classify costs nothing.
 *
 * `jpeg` and `jpg` both map to `image/jpeg`; the uploader writes one of them and a hand-built
 * request may use either.
 */
export function imageMimeTypeOf(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const mime = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;

  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(mime)) {
    throw new AppError('FILE_TYPE_UNSUPPORTED', {
      context: { reason: 'unsupported_object_extension', extension },
    });
  }
  return mime;
}

/* ========================================================================== */
/* The pipeline                                                                */
/* ========================================================================== */

/**
 * Analyze one crop image and return one `Diagnosis_Result`.
 *
 * `channel` is a required field of `DiagnoseInput` (Requirement 16.5), so a caller cannot forget it
 * and both persisted rows carry it. `language` is already validated at the edge (Requirement 9.5),
 * which is why it is a `Language` here and not a string.
 */
export async function diagnose(
  input: DiagnoseInput,
  deps: DiagnosisDeps,
): Promise<DiagnosisOutcome> {
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const { language, channel, userId } = input;

  const storage = deps.storage ?? deps.supabase;
  const conversations = deps.conversations ?? conversationStoreFrom(deps.supabase);
  const knowledge = deps.knowledge ?? knowledgeReaderFrom(deps.supabase);
  const models = deps.models ?? gatewayRunner();
  const burst = deps.burst ?? noBurstCheck;
  const quotaOptions: QuotaOptions = deps.quota ?? {};
  const store = deps.store ?? (await defaultStore(deps.supabase));

  // One deadline for the whole request, shared by both model calls. A fallback on the first call
  // therefore spends budget the second one will not have, which is the arithmetic
  // `docs/PROVIDER_CAPABILITIES.md` section 3 describes rather than a surprise.
  const deadlineMs =
    deps.deadlineMs ??
    computeDeadline({ requestStartMs: startedMs, ...platformDeadlineOf(deps.platformDeadline) });

  const runOptions: RunOptions = {
    deadlineMs,
    now,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  };

  /** The audit write, which never throws — see `writeUsageLog` in `src/lib/db/usage-log.ts`. */
  const log = async (facts: DiagnosisUsageFacts): Promise<void> => {
    await writeUsageLog(store, {
      userId,
      operation: OPERATION,
      channel,
      latencyMs: now() - startedMs,
      ...facts,
    });
  };

  // ── 1. Ownership (Requirements 2.5, 2.6) — nothing has been spent yet ──────
  await assertOwnershipInBucket(input.storageRef, userId, STORAGE_BUCKETS.cropImages, storage);
  const imageMimeType = imageMimeTypeOf(input.storageRef.path);

  // ── 2. Burst check (Requirement 13.8) — still nothing spent ───────────────
  // An image analysis is always the entry point for its own operation type, so there is no coverage
  // to consult here: `checkBurstForRequest()` in `rate-limit.ts` exists for `chatTurn()`, which is
  // the one service that is sometimes nested. A refusal throws `RATE_LIMITED` before the reserve.
  try {
    await burst(userId, OPERATION);
  } catch (error) {
    // Task 24.3 closed the gap `rate-limit.ts` recorded: a burst refusal used to leave no audit row
    // at all, because 0006's `outcome` vocabulary had no value meaning "refused for asking too
    // fast". Migration 0011 added `rate_limited`, and the row is written HERE rather than inside the
    // limiter for two reasons — this is where the request's `channel` and its start instant are
    // known, so the row is honest on both counts even if the WhatsApp adapter ever binds a limiter;
    // and `usage_logs` writes stay in the layer Requirement 14.6 assigns them to.
    //
    // Requirement 13.8's refusal costs nothing: nothing has been reserved, so `quota_spent: false`
    // and no refund exists to make. Non-`RATE_LIMITED` failures fall through unlogged — a limiter
    // that could not reach the counter is an `INTERNAL_ERROR`, not a refusal, and recording it as
    // one would put a fictional refusal in the audit.
    if (isRateLimited(error)) {
      await log({ outcome: 'rate_limited', provider: 'none', usedFallback: false, quotaSpent: false });
    }
    throw error;
  }

  // ── 3. Reserve (Requirements 14.1–14.3, 6.7) ──────────────────────────────
  // `ownsRequest` because an image analysis is always the entry point for its own operation type:
  // nothing else in Jamee reserves an image unit, so there is no nesting case here. (The nesting
  // seam in `quota.service.ts` exists for a chat answer produced inside a voice request.)
  const reserved = await reserveForRequest(ownsRequest(userId, OPERATION), quotaOptions);
  if (reserved.outcome === 'at_limit') {
    await log({
      outcome: 'quota_declined',
      provider: 'none',
      usedFallback: false,
      quotaSpent: false,
    });
    // Requirement 14.3: states the limit and the reset time, and no provider was called.
    throw quotaExceededError(reserved.status);
  }
  const reservation: QuotaReservation = reserved.reservation;
  const quota = quotaStatusOf(reservation);

  // ── 4. Signed URL (Requirement 2.8) — the last refundable step ────────────
  let imageUrl: string;
  try {
    imageUrl = await signedUrlFor(input.storageRef, storage);
  } catch (error) {
    // No provider call was attempted, so the unit goes back (design step 9). The audit row records
    // `quota_spent = false`, which is what distinguishes a pre-provider failure from a provider one
    // — the outcome vocabulary has no value for "storage failed", and `provider_error` with
    // `quota_spent = false` says exactly that without inventing one.
    await refundReservation(reservation, quotaOptions);
    await log({ outcome: 'provider_error', provider: 'none', usedFallback: false, quotaSpent: false });
    throw error;
  }

  // ── 5. Classification (Requirement 3.1) — the unit is now spent ───────────
  const classifyCall: VisionCall = {
    imageUrl,
    imageMimeType,
    prompt: CLASSIFICATION_PROMPT,
    // Spread so the schema arrives as a plain JSON object: `VISION_RESPONSE_JSON_SCHEMA` is a typed
    // interface in `prompts.ts`, and the adapters take an opaque `JsonSchema`.
    responseSchema: { ...VISION_RESPONSE_JSON_SCHEMA },
  };

  let classified: GatewayResult<string>;
  try {
    classified = await models.classify(classifyCall, runOptions);
  } catch (error) {
    // `PROVIDERS_UNAVAILABLE` (Requirement 14.8 — indistinguishably "no fallback configured" or
    // "the fallback failed too") or `DIAGNOSIS_TIMEOUT` (3.7). Spent, and NOT refunded.
    await log({
      outcome: isTimeout(error) ? 'timeout' : 'provider_error',
      provider: 'none',
      usedFallback: usedFallbackOf(error),
      quotaSpent: true,
    });
    throw error;
  }

  const provider = classified.provider;

  // ── 6 + 7. Stage 1 shape, then stage 2 knowledge-base membership (D2) ─────
  const interpretation = interpret(classified.value);

  // ── 8. Grounding, or the one inconclusive shape ───────────────────────────

  /**
   * The single exit for every non-identified cause: one shape, one static sentence, one logged
   * reason, and **no further model call** (Requirements 6.4, 6.6; D3, D4). Declared as a closure so
   * the three ways of reaching it below are three `return` statements rather than three copies of an
   * insert.
   */
  const returnInconclusive = (reason: RejectionReason): Promise<DiagnosisOutcome> =>
    finish({
      store,
      log,
      input,
      conversations,
      quota,
      result: inconclusiveFor(reason, language),
      row: {
        status: 'unknown',
        // Requirement 6.5, again at the persistence layer: no name, no knowledge reference, no
        // confidence. The `diagnoses_unknown_shape` constraint refuses the insert if this drifts.
        disease_name: null,
        knowledge_id: null,
        confidence: null,
        severity: 'none',
        needs_expert: true,
      },
      outcome: outcomeFor(reason),
      provider,
      usedFallback: classified.usedFallback,
      rejectionReason: reason,
    });

  if (!interpretation.ok) return returnInconclusive(interpretation.reason);

  const verified: VisionVerified = interpretation.verified;

  const lookup = await lookupCondition(verified.disease_name, knowledge);
  if (!lookup.found) {
    // Requirement 4.1 says all five rows exist, so this is an unseeded or partially seeded
    // deployment — a defect, not a farmer's mistake. `knowledge.ts` is explicit that the caller's
    // answer is "an inconclusive result or a referral, not a crash", and Requirement 3.2 leaves no
    // alternative: without the row there is no grounded explanation to compose, and an ungrounded
    // one is the thing Requirement 4.3 forbids outright. `unverified_condition` is the honest reason
    // — Jamee holds no verified content for the named condition — and the farmer reads the same
    // coverage-limit copy either way. The defect is logged so it is not invisible.
    console.error(
      '[jamee] diagnosis knowledge_row_missing',
      JSON.stringify({ condition: verified.disease_name, userId, channel }),
    );
    return returnInconclusive('unverified_condition');
  }
  const entry: KnowledgeEntry = lookup.entry;

  // Requirement 3.4 — a healthy crop reports `none` whatever the model said. The prompt asks for it
  // and the model usually complies; pinning it here means the requirement holds by construction
  // rather than by cooperation. This is a local normalization, not a model repair: no second call.
  const severity: Severity =
    verified.disease_name === HEALTHY_CONDITION ? 'none' : verified.severity;

  // The rephrase (Requirements 3.2, 4.3, 4.5, 4.6, 9.3). See the header for both decisions.
  let rephrased: Explained;
  try {
    rephrased = await explain({ entry, language, models, runOptions, deadlineMs, now });
  } catch (error) {
    // Requirement 3.7 — a budget expiry is recorded before it propagates, and the unit stays spent:
    // the classification call already happened. `explain()` only throws a timeout, and the ternary
    // keeps that from silently becoming a wrong audit row if that ever changes.
    await log({
      outcome: isTimeout(error) ? 'timeout' : 'provider_error',
      provider,
      // Requirement 14.7 on a path that reaches TWO gateway calls: either one may have been served
      // by a fallback member, so the flag is the disjunction. Reading only the classification's flag
      // would under-report a request whose rephrase fell back and then timed out.
      usedFallback: classified.usedFallback || usedFallbackOf(error),
      quotaSpent: true,
    });
    throw error;
  }

  const result: IdentifiedResult = {
    status: 'identified',
    diseaseName: verified.disease_name,
    // The model's value, unrounded. `diagnoses.confidence` is `numeric(4,3)`, so the stored copy is
    // rounded by Postgres to the column's precision; Requirement 3.2 asks for "the returned
    // confidence value" and that is what a farmer is shown.
    confidence: verified.confidence,
    severity,
    explanation: rephrased.explanation,
    // Requirement 3.4's "no treatment content" holds through this payload too: `treatment` is empty
    // for `Tomato Healthy` by seed and by the `healthy_has_no_treatment` constraint.
    knowledge: knowledgePayloadOf(entry),
    needsExpert: false,
    language,
  };

  return finish({
    store,
    log,
    input,
    conversations,
    quota,
    result,
    row: {
      status: 'identified',
      disease_name: verified.disease_name,
      knowledge_id: entry.id,
      confidence: verified.confidence,
      severity,
      needs_expert: false,
    },
    /**
     * The reconciliation task 24.3 owed. This branch used to write the coarse `provider_error` for
     * **both** degraded cases, while `chat.service.ts` split the identical event three ways — so an
     * operator counting `provider_error` was counting "Groq is down" and "Jamee refused the model's
     * prose" as one number, and Requirement 5.7's rejection went unrecorded on the diagnosis path
     * entirely.
     *
     * Both paths now go through `outcomeForDegradation()` in `src/lib/db/usage-log.ts`, keyed on the
     * shared `RephraseDegradation`. A rejected rephrase is `validation_rejected` with
     * `rephrase_rejected` (5.7, migration 0011); a failed chain stays `provider_error` (14.5).
     *
     * "Degraded but served" is still distinguishable from "failed" the way the header describes:
     * this row carries a `diagnosis_id` and a served result, and a genuinely failed request has
     * neither.
     */
    outcome: outcomeForDegradation(rephrased.degradation),
    provider,
    usedFallback: classified.usedFallback || rephrased.usedFallback,
    ...(rephrased.degradation === null
      ? {}
      : { auditRejectionReason: rejectionReasonForDegradation(rephrased.degradation) }),
  });
}

/* ========================================================================== */
/* Step 8's second half — the rephrase                                         */
/* ========================================================================== */

interface ExplainInput {
  readonly entry: KnowledgeEntry;
  readonly language: Language;
  readonly models: CapabilityRunner;
  readonly runOptions: RunOptions;
  readonly deadlineMs: number;
  readonly now: () => number;
}

interface Explained {
  readonly explanation: string;
  /**
   * Why the model's prose was not used, or `null` when it was.
   *
   * Was a `degraded: boolean` until task 24.3. A boolean could not tell "the chain failed" from
   * "Jamee refused the answer", which is precisely the distinction `chat.service.ts` had been
   * recording all along — so the two services audited one event two different ways. The shared
   * `RephraseDegradation` is now the vocabulary for both.
   *
   * `budget_exhausted` never appears here: `explain()` **throws** `DIAGNOSIS_TIMEOUT` on an expired
   * budget rather than degrading, because Requirement 3.7 specifies a timeout on this path. The
   * caller audits that as `timeout` from its own catch block.
   */
  readonly degradation: RephraseDegradation | null;
  readonly usedFallback: boolean;
}

/**
 * One rephrase call, guarded before it starts and validated after it returns.
 *
 * `attemptPlan('text-generate', …)` is the gateway's own minimum-remaining guard, asked here rather
 * than reimplemented, so the service and the gateway cannot disagree about whether a call fits. It
 * is asked **before** the call for the reason the gateway states as a spend rule: starting an
 * attempt that cannot finish issues a real provider call whose answer arrives after the deadline and
 * is discarded.
 *
 * `validateRephrased()` owns the four post-generation checks, including the deterministic
 * canonical-name repair and the fallback to `staticExplanationFor()` — none of which re-calls the
 * model (D4). This function adds only the provider-failure case, which the gateway raises as a
 * throw and `validateRephrased()` therefore never sees.
 */
async function explain(input: ExplainInput): Promise<Explained> {
  const { entry, language, models, runOptions, deadlineMs, now } = input;

  const plan = attemptPlan('text-generate', deadlineMs, now());
  if (!plan.startable) {
    // Requirement 3.7, as specified. `docs/PROVIDER_CAPABILITIES.md` section 3's open item proposes
    // serving the static template here instead; adopting it would change observable behaviour on
    // this path, so it stays flagged rather than assumed.
    throw new AppError('DIAGNOSIS_TIMEOUT', {
      context: {
        reason: 'rephrase_budget_exhausted',
        capability: 'text-generate',
        remainingMs: plan.remainingMs,
        condition: entry.disease_name,
      },
    });
  }

  const call: TextCall = { prompt: rephrasePrompt({ entry, language }) };

  let generated: GatewayResult<string>;
  try {
    generated = await models.generate(call, runOptions);
  } catch (error) {
    // A timeout is the request's budget talking and stays a timeout (Requirement 3.7). Any other
    // provider failure degrades to the knowledge-base template, which keeps Requirement 3.2 true —
    // the farmer receives grounded content instead of an error for a classification that succeeded.
    if (isTimeout(error)) throw error;
    return {
      explanation: staticExplanationFor(entry, language),
      degradation: 'provider_failed',
      usedFallback: usedFallbackOf(error),
    };
  }

  const checked = validateRephrased(generated.value, { entry, language });
  return {
    explanation: checked.text,
    // Requirement 5.7 — the post-generation checks are the Validation_Layer applied to rephrased
    // text, so their refusal is a *rejection* and is audited as one, with a reason.
    degradation: checked.source === 'static_template' ? 'checks_failed' : null,
    usedFallback: generated.usedFallback,
  };
}

/* ========================================================================== */
/* Steps 9 and 10 — persistence, then the audit row                            */
/* ========================================================================== */

/** The fields of a `diagnoses` row that differ between the two branches. */
interface DiagnosisRowShape {
  readonly status: 'identified' | 'unknown';
  /** `null` on the inconclusive branch, and `null` rather than absent so it cannot be forgotten. */
  readonly disease_name: VerifiedCondition | null;
  readonly knowledge_id: string | null;
  readonly confidence: number | null;
  readonly severity: Severity;
  readonly needs_expert: boolean;
}

interface FinishInput {
  readonly store: DiagnosisStore;
  readonly log: (facts: DiagnosisUsageFacts) => Promise<void>;
  readonly input: DiagnoseInput;
  readonly conversations: ConversationStore;
  readonly quota: QuotaStatus;
  readonly result: DiagnosisResult;
  readonly row: DiagnosisRowShape;
  readonly outcome: UsageOutcome;
  readonly provider: 'gemini' | 'groq';
  readonly usedFallback: boolean;
  /**
   * The **farmer-facing** reason, present exactly on the inconclusive branch. It is returned to the
   * caller as well as logged, because `DiagnosisOutcome.rejectionReason` is documented as present
   * exactly when the result is `unknown`.
   */
  readonly rejectionReason?: RejectionReason;
  /**
   * A reason that belongs on the audit row but **not** on the returned outcome — today only
   * `rephrase_rejected`, which accompanies an `identified` result the farmer receives normally.
   *
   * Two fields rather than one widened field, so `DiagnosisOutcome.rejectionReason` keeps its
   * invariant: a caller reading it can still conclude the result was inconclusive.
   */
  readonly auditRejectionReason?: UsageRejectionReason | undefined;
}

/**
 * Resolve the conversation, persist the diagnosis, append the audit row.
 *
 * One function for both branches, which is what keeps Requirement 6.4's single shape from being two
 * near-identical insert sites that could drift — and what makes Requirement 3.3's column set
 * (farmer, conversation, storage reference, channel) identical on an inconclusive row and an
 * identified one.
 *
 * The conversation is resolved **here**, after the model work, rather than up front: a request that
 * never produces a result needs no thread, and Requirement 7.5 only requires one for a diagnosis
 * that is being attached to it.
 */
async function finish(args: FinishInput): Promise<DiagnosisOutcome> {
  const { store, input, result } = args;
  const conversationId = await resolveConversation(args);

  const stored = await store.insertDiagnosis({
    user_id: input.userId,
    conversation_id: conversationId,
    status: args.row.status,
    disease_name: args.row.disease_name,
    knowledge_id: args.row.knowledge_id,
    confidence: args.row.confidence,
    severity: args.row.severity,
    explanation: result.explanation,
    language: input.language,
    needs_expert: args.row.needs_expert,
    // Requirement 16.5 — the channel the service was given, on the row.
    channel: input.channel,
    image_bucket: STORAGE_BUCKETS.cropImages,
    image_path: input.storageRef.path,
    model_provider: args.provider,
  });

  /**
   * Requirement 5.7 — one reason column, fed by whichever of the two reasons applies. They are
   * mutually exclusive by construction: the inconclusive branch never reaches a rephrase, and a
   * rephrase only happens on an identified result.
   */
  const auditReason: UsageRejectionReason | undefined =
    args.rejectionReason ?? args.auditRejectionReason;

  await args.log({
    outcome: args.outcome,
    provider: args.provider,
    usedFallback: args.usedFallback,
    // Requirement 6.7 / the spend rule: a classification call was attempted, so the unit is spent —
    // including for an accepted inconclusive result.
    quotaSpent: true,
    conversationId,
    diagnosisId: stored.id,
    ...(auditReason === undefined ? {} : { rejectionReason: auditReason }),
  });

  return {
    diagnosisId: stored.id,
    conversationId,
    result,
    quota: args.quota,
    provider: args.provider,
    usedFallback: args.usedFallback,
    ...(args.rejectionReason === undefined ? {} : { rejectionReason: args.rejectionReason }),
  };
}

/**
 * The conversation this diagnosis attaches to.
 *
 * A supplied id is verified to be this farmer's and otherwise refused with
 * `CONVERSATION_NOT_FOUND` — see `DiagnosisStore.ownsConversation` for why the route's own check is
 * not the only one that matters. An absent id goes to `findOrCreateActive`, which is Requirement
 * 7.5 for the web path and Requirement 10.5's per-channel thread for WhatsApp.
 */
async function resolveConversation(args: FinishInput): Promise<string> {
  const { input, store, conversations } = args;
  const supplied = input.conversationId;

  if (supplied !== undefined) {
    if (!(await store.ownsConversation(supplied, input.userId))) {
      throw new AppError('CONVERSATION_NOT_FOUND', {
        context: { reason: 'conversation_not_owned', conversationId: supplied, userId: input.userId },
      });
    }
    return supplied;
  }

  const conversation = await findOrCreateActive(input.userId, input.channel, conversations);
  return conversation.id;
}

/* ========================================================================== */
/* The audit row (Requirements 5.7, 14.6, 14.7, 3.7; D10)                      */
/* ========================================================================== */

/**
 * The facts a diagnosis call site supplies. The four this service already knows — the farmer, the
 * operation, the channel and the elapsed time — are filled in by the `log` closure, so a call site
 * cannot get them wrong and cannot omit them.
 *
 * Derived from the shared `UsageFacts` by subtraction rather than re-declared, which is what makes
 * "one audit vocabulary" a compiler-checked fact: a column added to `usage_logs` appears here
 * automatically, and this service stops compiling until every branch decides what to write in it.
 *
 * The row shape, the never-throw rule and the `prompt_version`-on-every-row rule all live in
 * `src/lib/db/usage-log.ts` now. They used to live in a near-copy in each of four modules, and the
 * copies had drifted — see that module's header for what the drift cost.
 */
type DiagnosisUsageFacts = Omit<
  UsageFacts,
  'userId' | 'operation' | 'channel' | 'latencyMs'
>;

/* ========================================================================== */
/* Small shared helpers                                                        */
/* ========================================================================== */

function isTimeout(error: unknown): boolean {
  return isAppError(error) && error.code === 'DIAGNOSIS_TIMEOUT';
}

/**
 * Whether the burst limiter refused this request (Requirement 13.8), as opposed to failing.
 *
 * Read off the code rather than caught by position, because `burst` is an injected seam: a limiter
 * whose counter RPC failed raises `INTERNAL_ERROR`, and auditing that as a `rate_limited` refusal
 * would record a refusal that never happened.
 */
function isRateLimited(error: unknown): boolean {
  return isAppError(error) && error.code === 'RATE_LIMITED';
}

/**
 * Whether the failed gateway call had reached a fallback member (Requirement 14.7).
 *
 * Read off `AppError.context`, which the gateway populates with `usedFallback` on its single
 * exhausted-chain exit. Defaults to `false` for anything else, because "we do not know" and "no
 * fallback was used" have the same audit meaning and inventing a `true` would overstate spend.
 */
function usedFallbackOf(error: unknown): boolean {
  return isAppError(error) && error.context?.usedFallback === true;
}

/** V18's platform deadline, tolerating its absence exactly as the gateway does. */
function platformDeadlineOf(
  source: (() => Date | undefined) | undefined,
): { platformDeadlineMs?: number } {
  const at = (source ?? getDeadline)();
  if (at === undefined) return {};
  const ms = at.getTime();
  return Number.isFinite(ms) ? { platformDeadlineMs: ms } : {};
}

/**
 * The default store, built on first use.
 *
 * `createAdminClient()` is imported **lazily** so a caller that injects its own store — every unit
 * test — never reads `SUPABASE_SERVICE_ROLE_KEY`. Same reasoning as the lazy `createServerSupabase`
 * imports in `knowledge.ts` and `conversation.service.ts`, applied to the other credential.
 */
async function defaultStore(client: SupabaseClient<Database>): Promise<DiagnosisStore> {
  const { createAdminClient } = await import('@/lib/supabase/admin');
  return diagnosisStoreFrom(client, createAdminClient());
}
