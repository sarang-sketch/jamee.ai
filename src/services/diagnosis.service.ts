import 'server-only';

import { Buffer } from 'node:buffer';

import { getDeadline } from '@vercel/functions';

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
import {
  analysisData,
  readMediaBytesForOwner,
  type AnalysisData,
  type DiagnosisInsert,
} from '@/lib/db/analysis';
import {
  outcomeForDegradation,
  rejectionReasonForDegradation,
  usageLogWriterFrom,
  writeUsageLog,
  type RephraseDegradation,
  type UsageFacts,
  type UsageLogWriter,
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
  type MediaRef,
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
import {
  conversationStoreFrom,
  findOrCreateActive,
  type ConversationStore,
} from '@/services/conversation.service';
import {
  ownsRequest,
  quotaExceededError,
  quotaStatusOf,
  reserveForRequest,
  type QuotaOptions,
  type QuotaReservation,
} from '@/services/quota.service';

/**
 * The single image-analysis implementation. Both channels enter here (Requirements 3.8, 16.1, 16.3).
 *
 * Requirements: 2.5, 2.6 (a file's bytes are read only by the Farmer who owns it, proven before
 *               anything is spent), 2.8 (image bytes reach the model — under Amendment A3 inline,
 *               read from GridFS through the Data_Access_Layer, not fetched from a Signed_URL), 3.1
 *               (the classification request asks for a candidate condition, a confidence in [0,1]
 *               and a Severity_Value), 3.2 (an identified result's explanation is composed only from
 *               the matching Knowledge_Base entry), 3.3 (the result is persisted with farmer,
 *               conversation, the Media_Reference and channel), 3.4 (a healthy crop reports severity
 *               `none` and carries no treatment content), 3.5 (exactly one primary condition), 3.7
 *               (budget expiry returns a timeout naming the diagnosis operation and records it), 3.8
 *               / 16.1 / 16.3 (one implementation serving the Web_App and Telegram), 5.1 (every
 *               model response is parsed against a Zod schema before any part of it is persisted or
 *               returned), 5.7 (the rejection reason is recorded and the rejected content is
 *               excluded), 6.1–6.6 (one inconclusive shape for every non-identified cause, no
 *               further model call), 6.7 (an accepted inconclusive result still counts exactly one
 *               image analysis), 16.5 (`channel` is an input parameter and is written to every
 *               persisted row)
 * Design: D1 (amended — the analysis request carries a Media_Reference and no bytes; the bytes are
 *         read from GridFS and sent inline), D2 (two-stage validation), D3 (every failure produces
 *         the one inconclusive shape), D4 (no repair re-ask), D7 (channel parity is one code path
 *         and identical structured fields), D10 (`usage_logs` is append-only audit, not the quota
 *         source of truth), D17 (one GridFS bucket), D18 (the Data_Access_Layer is the isolation
 *         boundary), Amendment A3 (media lifecycle); V29, V34
 *
 * =============================================================================
 * THE ORDER OF OPERATIONS IS THE CONTRACT
 * =============================================================================
 *
 * Not a style preference — the order is what makes the requirements true, and each step names the
 * criterion it satisfies by *being where it is*:
 *
 *  1. **Ownership + bytes** (`readMediaBytesForOwner`) — Requirements 2.5, 2.6. Before the reserve,
 *     so "leave the farmer's quota unchanged" holds because nothing was taken. The owner-scoped read
 *     both proves ownership and returns the bytes: a foreign or missing image is one `null`, mapped
 *     to `STORAGE_REF_FORBIDDEN` (403, quota untouched — the A3 taxonomy code, Requirement 2.6). No
 *     provider call has been attempted, so this is refundable by never having reserved.
 *  2. **Burst check** — Requirement 13.8, `src/lib/rate-limit.ts`. Before the reserve, so a refused
 *     burst request never increments the daily counter and never needs a refund.
 *  3. **Quota reserve** — Requirements 14.1–14.3. At-limit declines here and **calls no provider**.
 *  4. **`vision-classify`** — Requirement 3.1, with the bytes sent inline (V34). From this instant
 *     the unit is spent, whatever happens next.
 *  5. **Stage 1, shape** — Requirements 5.1–5.5.
 *  6. **Stage 2, knowledge-base membership** — Requirements 5.6, 6.1. The safety gate.
 *  7. **Grounding and rephrase, identified results only** — Requirements 3.2, 4.3, 4.5, 4.6, 9.3.
 *  8. **Persistence** — Requirement 3.3.
 *  9. **Usage log** — Requirements 5.7, 14.6, 14.7, 3.7.
 *
 * Moving any step earlier or later changes which requirement holds. The unit tests assert the order
 * by observing what a stub was *not* asked to do.
 *
 * =============================================================================
 * THE SPEND RULE
 * =============================================================================
 *
 * The rule is the biconditional in `quota.service.ts`: **a unit is spent if and only if at least one
 * provider call was attempted for that request.** Reading the image bytes is not a provider call, so
 * a foreign/missing image at step 1 costs nothing and reserves nothing. Everything at or after step
 * 4 is spent and stays spent, including a both-providers-failed classification and a timeout —
 * refunding those would let a failing provider drain the free tier through retries.
 *
 * The knowledge-base read at step 6 is AFTER the classification, so a knowledge-base failure is NOT
 * refunded — Requirement 3.2 forces that order, because an explanation must be grounded in the row
 * for the condition the model named, and the row cannot be read before the name exists.
 *
 * =============================================================================
 * WHY THIS SERVICE NO LONGER HOLDS A CLIENT (Amendment A3)
 * =============================================================================
 *
 * Under A3 there is no Supabase Storage and no RLS: farmer isolation is the Data_Access_Layer (D18),
 * and every farmer read/write goes through `farmerData(userId)`, which merges and stamps the owner.
 * So this service does not import the driver or `src/lib/db/client` (forbidden outside `src/lib/db`
 * by `npm run check:data-access`) — it uses `analysisData(userId)` from the new `src/lib/db/analysis`
 * module for persistence and the owner-checked media read, and `usageLogWriterFrom()` for the audit
 * row. No client is a parameter, because there is no credential to choose between: the owner id from
 * the session is the only boundary, and it arrives on `DiagnoseInput`.
 *
 * The `usage_logs` write is owner-scoped through the layer too: `usageLogWriterFrom()` resolves
 * `farmerData(row.user_id)` from the row's own required `user_id`, so "append-only" holds because
 * the layer is the only writer and nothing hands a farmer session the driver.
 *
 * =============================================================================
 * WHAT IS DELIBERATELY NOT HERE
 * =============================================================================
 *
 * **No HTTP.** No `Request`, no `Response`, no cookies, no Telegram payload shapes. The route parses
 * and maps; this service decides.
 *
 * **No `messages` row.** The design's diagnosis sequence persists a diagnosis and a `usage_logs`
 * row and nothing else; inventing a farmer message for an image upload would put a fabricated string
 * in a farmer's conversation history.
 *
 * **No burst ceiling arithmetic.** Requirement 13.8 lives in `src/lib/rate-limit.ts`; this file owns
 * only the *position* of the check — step 2, before the reserve — and calls whatever the caller
 * bound there.
 */

/** This service reserves, and audits, exactly one operation type. */
const OPERATION: Operation = 'image';

/* ========================================================================== */
/* The persistence seam                                                        */
/* ========================================================================== */

/**
 * The two writes this service makes, over the Data_Access_Layer.
 *
 * `AnalysisData` (from `src/lib/db/analysis`) owns the owner-stamped diagnosis insert; `UsageLogWriter`
 * (from `src/lib/db/usage-log`) owns the owner-scoped append-only audit write. A third method,
 * `ownsConversation`, is here because a client-supplied `conversationId` (Requirement 2.2) could
 * otherwise attach a diagnosis to another farmer's thread — and it is answered through
 * `farmerData(userId)`, which scopes the lookup to this farmer by construction.
 */
export interface DiagnosisStore {
  /** Requirement 3.3. Returns the stored diagnosis id (hex string) — the response and audit need it. */
  insertDiagnosis(doc: DiagnosisInsert): Promise<string>;
  /** Requirements 5.7, 14.6, 14.7, 3.7. Append-only (D10), owner-scoped through the layer. */
  insertUsageLog: UsageLogWriter['insertUsageLog'];
  /** Whether a client-supplied conversation id is this farmer's (D18 scopes the lookup). */
  ownsConversation(conversationId: string): Promise<boolean>;
}

/**
 * Bind the store to one farmer, over the Data_Access_Layer.
 *
 * `analysisData(userId).insertDiagnosis` stamps the owner and persists the Media_Reference (D17);
 * `usageLogWriterFrom()` writes the audit row through the owner-scoped accessor; `ownsConversation`
 * reads this farmer's conversations only, because `farmerData(userId).findOneConversation` merges the
 * owner into the filter (D18). No client, no service role — the layer is the boundary.
 */
export function diagnosisStoreFrom(userId: string): DiagnosisStore {
  const data: AnalysisData = analysisData(userId);
  const audit: UsageLogWriter = usageLogWriterFrom();

  return {
    insertDiagnosis: (doc) => data.insertDiagnosis(doc),
    insertUsageLog: (row) => audit.insertUsageLog(row),
    ownsConversation: (conversationId) => data.ownsConversation(conversationId),
  };
}

/* ========================================================================== */
/* Dependencies                                                                */
/* ========================================================================== */

export interface DiagnosisDeps {
  /** Defaults to `diagnosisStoreFrom(userId)`, built on first use from the input's owner. */
  readonly store?: DiagnosisStore;
  readonly conversations?: ConversationStore;
  readonly knowledge?: KnowledgeReader;
  /** The two model calls. Defaults to the real gateway over the real adapter sets. */
  readonly models?: CapabilityRunner;
  /**
   * The owner-checked media read. Defaults to `readMediaBytesForOwner` from `src/lib/db/analysis`.
   * A seam so a unit test can prove the pipeline order (foreign image → no reserve) without GridFS.
   */
  readonly readMedia?: (userId: string, ref: MediaRef) => Promise<{ bytes: Buffer; mimeType: string } | null>;
  /**
   * Step 2, Requirement 13.8. `/api/diagnose` binds `burstLimiter()`; the default is `noBurstCheck`,
   * which is what keeps a unit test from opening a connection to check a ceiling it is not testing.
   */
  readonly burst?: BurstCheck;
  /** The counter seam and the quota clock. Both default inside `quota.service.ts`. */
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
 * reshaping. The last three are audit facts a caller may want to log — never to change the diagnosis
 * itself, which is what D7's parity definition rests on: same service invocation, same knowledge-base
 * row, identical structured fields.
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

/** The JSON type each required field accepts, so "wrongly typed" is one statement per field. */
const CARRIES_JSON_TYPE_OF: Readonly<Record<keyof VisionRaw, (value: unknown) => boolean>> = {
  status: (value) => typeof value === 'string',
  /** Nullable by schema (D2), so `null` is a legal type here — an empty string is a value problem. */
  disease_name: (value) => value === null || typeof value === 'string',
  confidence: (value) => typeof value === 'number',
  severity: (value) => typeof value === 'string',
};

const REQUIRED_VISION_FIELDS = Object.keys(CARRIES_JSON_TYPE_OF) as (keyof VisionRaw)[];

/**
 * Which rejection reason a stage-1 failure is. See the vision-validation design for the three-rule
 * order (missing_field wins over invalid_severity wins over confidence_out_of_range), and why rule 1
 * reads the parsed payload rather than the Zod issue codes.
 */
function stage1Reason(
  payload: unknown,
  issues: readonly { code: string; path: readonly PropertyKey[] }[],
): RejectionReason {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return 'missing_field';
  }
  const record = payload as Record<string, unknown>;

  for (const field of REQUIRED_VISION_FIELDS) {
    if (!CARRIES_JSON_TYPE_OF[field](record[field])) return 'missing_field';
  }

  const onField = (field: keyof VisionRaw): boolean =>
    issues.some((issue) => issue.path[0] === field);

  if (onField('severity')) return 'invalid_severity';
  if (onField('confidence')) return 'confidence_out_of_range';
  return 'missing_field';
}

/**
 * Run both validation stages over the model's raw text (Requirement 5.1). The text is parsed
 * strictly — a fenced ```json block is `not_json`, because both members return raw JSON and quietly
 * repairing a fence would make the inconclusive rate stop reporting a real provider problem (D4).
 * The model's own `unclear` / `no_plant` are honest non-identified statuses, not failures.
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

  const stage2 = visionVerifiedSchema.safeParse(stage1.data);
  return stage2.success
    ? { ok: true, verified: stage2.data }
    : { ok: false, reason: 'unverified_condition' };
}

/* ========================================================================== */
/* The one inconclusive shape (Requirements 6.4, 6.5; D3)                      */
/* ========================================================================== */

/**
 * Build the inconclusive result for a reason. The model's disease name and confidence are not passed
 * in, so there is nothing to forget to discard (Requirement 6.5); the explanation is a static
 * catalog lookup (D5) — no model call is reachable from here (Requirement 6.6).
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
 * `validation_rejected` for the reasons Jamee's Validation_Layer produced (5.2–5.6), `inconclusive`
 * for the two the model reported itself (6.2, 6.3). Both are farmer-identical (6.4) and both spend
 * one unit (6.7).
 */
function outcomeFor(reason: RejectionReason): UsageOutcome {
  return reason === 'model_unclear' || reason === 'model_no_plant'
    ? 'inconclusive'
    : 'validation_rejected';
}

/* ========================================================================== */
/* The pipeline                                                                */
/* ========================================================================== */

/**
 * Analyze one crop image and return one `Diagnosis_Result`.
 *
 * `channel` is a required field of `DiagnoseInput` (Requirement 16.5), so a caller cannot forget it
 * and both persisted rows carry it. `language` is already validated at the edge (Requirement 9.5).
 */
export async function diagnose(
  input: DiagnoseInput,
  deps: DiagnosisDeps = {},
): Promise<DiagnosisOutcome> {
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const { language, channel, userId } = input;

  const conversations = deps.conversations ?? conversationStoreFrom();
  const knowledge = deps.knowledge ?? knowledgeReaderFrom();
  const models = deps.models ?? gatewayRunner();
  const burst = deps.burst ?? noBurstCheck;
  const quotaOptions: QuotaOptions = deps.quota ?? {};
  const store = deps.store ?? diagnosisStoreFrom(userId);
  const readMedia = deps.readMedia ?? readMediaBytesForOwner;

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

  // ── 1. Ownership + bytes (Requirements 2.5, 2.6) — nothing has been spent ──
  // The owner-scoped read proves ownership AND yields the bytes. A foreign or missing image is one
  // `null` (Requirement 2.6), mapped to STORAGE_REF_FORBIDDEN (403) BEFORE the reserve, so it costs
  // no quota unit — the A3 taxonomy's answer for a forbidden/absent reference.
  const image = await readMedia(userId, input.image);
  if (image === null) {
    throw new AppError('STORAGE_REF_FORBIDDEN', {
      context: { reason: 'crop_image_not_owned_or_missing', userId, fileId: input.image.fileId },
    });
  }

  // ── 2. Burst check (Requirement 13.8) — still nothing spent ───────────────
  try {
    await burst(userId, OPERATION);
  } catch (error) {
    if (isRateLimited(error)) {
      await log({ outcome: 'rate_limited', provider: 'none', usedFallback: false, quotaSpent: false });
    }
    throw error;
  }

  // ── 3. Reserve (Requirements 14.1–14.3, 6.7) ──────────────────────────────
  const reserved = await reserveForRequest(ownsRequest(userId, OPERATION), quotaOptions);
  if (reserved.outcome === 'at_limit') {
    await log({ outcome: 'quota_declined', provider: 'none', usedFallback: false, quotaSpent: false });
    throw quotaExceededError(reserved.status);
  }
  const reservation: QuotaReservation = reserved.reservation;
  const quota = quotaStatusOf(reservation);

  // ── 4. Classification (Requirement 3.1) — the unit is now spent ───────────
  // Amendment A3, V34: the bytes read at step 1 are sent inline. There is no signed URL — the last
  // refundable step (a URL mint) no longer exists, because ownership + bytes were established at
  // step 1 without spending anything.
  const classifyCall: VisionCall = {
    imageBase64: image.bytes.toString('base64'),
    imageMimeType: image.mimeType,
    prompt: CLASSIFICATION_PROMPT,
    responseSchema: { ...VISION_RESPONSE_JSON_SCHEMA },
  };

  let classified: GatewayResult<string>;
  try {
    classified = await models.classify(classifyCall, runOptions);
  } catch (error) {
    // `PROVIDERS_UNAVAILABLE` (14.8) or `DIAGNOSIS_TIMEOUT` (3.7). Spent, and NOT refunded.
    await log({
      outcome: isTimeout(error) ? 'timeout' : 'provider_error',
      provider: 'none',
      usedFallback: usedFallbackOf(error),
      quotaSpent: true,
    });
    throw error;
  }

  const provider = classified.provider;

  // ── 5 + 6. Stage 1 shape, then stage 2 knowledge-base membership (D2) ─────
  const interpretation = interpret(classified.value);

  // ── 7. Grounding, or the one inconclusive shape ───────────────────────────
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
        diseaseName: null,
        knowledgeId: null,
        confidence: null,
        severity: 'none',
        needsExpert: true,
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
    console.error(
      '[jamee] diagnosis knowledge_row_missing',
      JSON.stringify({ condition: verified.disease_name, userId, channel }),
    );
    return returnInconclusive('unverified_condition');
  }
  const entry: KnowledgeEntry = lookup.entry;

  // Requirement 3.4 — a healthy crop reports `none` whatever the model said. Local normalization,
  // not a model repair: no second call.
  const severity: Severity =
    verified.disease_name === HEALTHY_CONDITION ? 'none' : verified.severity;

  let rephrased: Explained;
  try {
    rephrased = await explain({ entry, language, models, runOptions, deadlineMs, now });
  } catch (error) {
    await log({
      outcome: isTimeout(error) ? 'timeout' : 'provider_error',
      provider,
      usedFallback: classified.usedFallback || usedFallbackOf(error),
      quotaSpent: true,
    });
    throw error;
  }

  const result: IdentifiedResult = {
    status: 'identified',
    diseaseName: verified.disease_name,
    confidence: verified.confidence,
    severity,
    explanation: rephrased.explanation,
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
      diseaseName: verified.disease_name,
      knowledgeId: entry.id,
      confidence: verified.confidence,
      severity,
      needsExpert: false,
    },
    outcome: outcomeForDegradation(rephrased.degradation),
    provider,
    usedFallback: classified.usedFallback || rephrased.usedFallback,
    ...(rephrased.degradation === null
      ? {}
      : { auditRejectionReason: rejectionReasonForDegradation(rephrased.degradation) }),
  });
}

/* ========================================================================== */
/* Step 7's second half — the rephrase                                         */
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
  readonly degradation: RephraseDegradation | null;
  readonly usedFallback: boolean;
}

/**
 * One rephrase call, guarded before it starts (`attemptPlan` is the gateway's minimum-remaining
 * guard) and validated after it returns (`validateRephrased` owns the four post-generation checks
 * and the fallback to `staticExplanationFor`, none of which re-calls the model — D4). A budget
 * expiry throws `DIAGNOSIS_TIMEOUT` (Requirement 3.7); a provider failure degrades to the static
 * knowledge-base template, keeping Requirement 3.2 true.
 */
async function explain(input: ExplainInput): Promise<Explained> {
  const { entry, language, models, runOptions, deadlineMs, now } = input;

  const plan = attemptPlan('text-generate', deadlineMs, now());
  if (!plan.startable) {
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
    degradation: checked.source === 'static_template' ? 'checks_failed' : null,
    usedFallback: generated.usedFallback,
  };
}

/* ========================================================================== */
/* Steps 8 and 9 — persistence, then the audit row                             */
/* ========================================================================== */

/** The fields of a diagnosis document that differ between the two branches. */
interface DiagnosisRowShape {
  readonly status: 'identified' | 'unknown';
  readonly diseaseName: VerifiedCondition | null;
  readonly knowledgeId: string | null;
  readonly confidence: number | null;
  readonly severity: Severity;
  readonly needsExpert: boolean;
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
  readonly rejectionReason?: RejectionReason;
  readonly auditRejectionReason?: UsageRejectionReason | undefined;
}

/**
 * Resolve the conversation, persist the diagnosis, append the audit row. One function for both
 * branches, which keeps Requirement 6.4's single shape from being two near-identical insert sites,
 * and makes Requirement 3.3's column set (farmer, conversation, Media_Reference, channel) identical
 * on an inconclusive row and an identified one.
 */
async function finish(args: FinishInput): Promise<DiagnosisOutcome> {
  const { store, input, result } = args;
  const conversationId = await resolveConversation(args);

  const doc: DiagnosisInsert = {
    conversationId,
    status: args.row.status,
    diseaseName: args.row.diseaseName,
    knowledgeId: args.row.knowledgeId,
    confidence: args.row.confidence,
    severity: args.row.severity,
    explanation: result.explanation,
    language: input.language,
    needsExpert: args.row.needsExpert,
    channel: input.channel,
    // Requirement 3.3 — the Full_Size_Image reference on the row (D17). The optional thumbnail
    // reference is persisted alongside it; it is never analysed.
    mediaRef: input.image,
    modelProvider: args.provider,
  };
  const diagnosisId = await store.insertDiagnosis(doc);

  const auditReason: UsageRejectionReason | undefined =
    args.rejectionReason ?? args.auditRejectionReason;

  await args.log({
    outcome: args.outcome,
    provider: args.provider,
    usedFallback: args.usedFallback,
    quotaSpent: true,
    conversationId,
    diagnosisId,
    ...(auditReason === undefined ? {} : { rejectionReason: auditReason }),
  });

  return {
    diagnosisId,
    conversationId,
    result,
    quota: args.quota,
    provider: args.provider,
    usedFallback: args.usedFallback,
    ...(args.rejectionReason === undefined ? {} : { rejectionReason: args.rejectionReason }),
  };
}

/**
 * The conversation this diagnosis attaches to. A supplied id is verified to be this farmer's and
 * otherwise refused with `CONVERSATION_NOT_FOUND`; an absent id goes to `findOrCreateActive`
 * (Requirement 7.5 for the web path, Requirement 10.5's per-channel thread for Telegram).
 */
async function resolveConversation(args: FinishInput): Promise<string> {
  const { input, store, conversations } = args;
  const supplied = input.conversationId;

  if (supplied !== undefined) {
    if (!(await store.ownsConversation(supplied))) {
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
 * cannot get them wrong. Derived from the shared `UsageFacts` by subtraction, so a new column stops
 * this service compiling until every branch decides what to write in it.
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

/** Whether the burst limiter refused this request (13.8), as opposed to failing. */
function isRateLimited(error: unknown): boolean {
  return isAppError(error) && error.code === 'RATE_LIMITED';
}

/** Whether the failed gateway call had reached a fallback member (14.7). */
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
