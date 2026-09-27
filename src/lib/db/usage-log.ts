import 'server-only';

import { ObjectId } from 'mongodb';

import type { UsageLogDoc } from '@/lib/db/collections';
import { farmerData } from '@/lib/db/farmer';
import { PROMPT_VERSION } from '@/lib/prompts';
import type {
  Channel,
  Operation,
  UsageOutcome,
  UsageRejectionReason,
} from '@/lib/schemas';

/**
 * The wire shape of one `usage_logs` audit row, as `usageLogRow()` builds it and the persistence
 * seam consumes it. Every enumerated column is typed from the Zod-inferred domain unions in
 * `schemas.ts` (the same single-source discipline `collections.ts` follows), so a bad `channel`
 * or `outcome` is a compile error rather than a validator rejection at write time.
 *
 * This is the local audit-row contract owned by this module. `user_id` is the required tenant
 * anchor `usageLogWriterFrom` binds `farmerData` to; the nullable columns are written explicitly
 * (see `usageLogRow`) so the row shape is a property of the builder and not of a caller's spelling.
 */
export interface UsageLogInsert {
  readonly user_id: string;
  readonly operation: Operation;
  readonly channel: Channel;
  readonly model_provider?: UsageProvider | null;
  readonly outcome: UsageOutcome;
  readonly used_fallback?: boolean;
  readonly rejection_reason?: UsageRejectionReason | null;
  readonly quota_spent?: boolean;
  readonly latency_ms?: number | null;
  readonly prompt_version?: string | null;
  readonly conversation_id?: string | null;
  readonly diagnosis_id?: string | null;
}

/**
 * The one audit vocabulary. Every `usage_logs` row in Jamee is shaped here.
 *
 * Requirements: 3.7 (a budget expiry records its outcome), 5.7 (a Validation_Layer rejection records
 *               its reason), 11.5 (a redelivery is recorded and spends nothing), 13.8 (the glossary's
 *               "billable **or rate-limited** operation"), 14.6 (one row per completed model
 *               operation, recording farmer / operation / channel / provider / outcome), 14.7 (the
 *               fallback is recorded whenever the gateway served from it)
 * Design: D10 (`usage_logs` is an append-only audit table and is NOT the quota source of truth);
 *         "0006: usage_logs"; "Quota enforcement" → *When a unit is reserved, finalized, or refunded*
 * Migrations: `0006_usage_logs.sql`, `0011_usage_logs_audit_vocabulary.sql`
 *
 * =============================================================================
 * WHY THIS MODULE EXISTS: THE ROW SHAPE LIVES ONCE
 * =============================================================================
 *
 * Several call sites write audit rows — the three services and the Telegram inbound path — and each
 * had grown its own near-identical row builder. The divergences were not cosmetic:
 *
 *  - `diagnosis.service.ts` wrote the coarse `provider_error` for a rejected rephrase while
 *    `chat.service.ts` wrote `validation_rejected` for the same event. One of them had to be wrong,
 *    and an operator counting `provider_error` was counting two different facts.
 *  - An inbound-path builder omitted `prompt_version`, `latency_ms` and `used_fallback` entirely, so
 *    `prompt_version` was non-null on *most* rows — which is worse than null on all of them, because
 *    a `group by prompt_version` silently dropped the duplicates.
 *  - Each site had its own copy of "never throw, log instead", and a further site would have had to
 *    remember to write one.
 *
 * So the row shape, the column defaults, and the never-throw rule live here, once. A caller supplies
 * only the facts it actually knows; it cannot forget a column, because `usageLogRow()` writes all
 * thirteen.
 *
 * =============================================================================
 * THE RULES FOR WHEN A ROW IS WRITTEN
 * =============================================================================
 *
 * One vocabulary is only half the job — the other half is one answer to "does this path write a
 * row?". Stated as the rule the five call sites implement:
 *
 * **A row is written for every request that reached its service, plus every request refused by a
 * control that Jamee itself owns.** Concretely:
 *
 *  | Path | outcome | provider | quota_spent |
 *  | --- | --- | --- | --- |
 *  | answered | `success` | the server | `true` |
 *  | inconclusive / empty transcript / out-of-scope referral | `inconclusive` | the server or `none` | `true` except the referral |
 *  | schema or knowledge-base rejection | `validation_rejected` | the server | `true` |
 *  | rephrase checks refused the prose | `validation_rejected` + `rephrase_rejected` | the server | `true` |
 *  | chain exhausted, or a pre-provider read failed | `provider_error` | the server or `none` | `true` / `false` |
 *  | budget expiry, before or during the work | `timeout` | the server or `none` | `true` / `false` |
 *  | daily limit reached (14.3) | `quota_declined` | `none` | `false` |
 *  | burst ceiling reached (13.8) | `rate_limited` | `none` | `false` |
 *  | platform redelivery (11.5) | `duplicate_ignored` | `none` | `false` |
 *
 * And the paths that write **nothing**, each for a stated reason rather than by omission:
 *
 *  - **Anything refused before the request is attributable to a farmer.** A 401, an unparseable
 *    body, an unsupported language, an ownership 403, an unresolvable sender, a message
 *    type outside text/image/audio. `usage_logs.user_id` is `not null` and these paths either have
 *    no farmer or have refused to trust the one they were handed; a row would have to invent one.
 *  - **A redelivery whose conflicting inbound-idempotency row carries a null `user_id`.** Same
 *    reason, and the design says so explicitly: the duplicate is recorded by the inbound
 *    status alone.
 *
 * =============================================================================
 * ONE REQUEST IS NOT ALWAYS ONE ROW, AND `used_fallback` IS SCOPED TO THE ROW
 * =============================================================================
 *
 * Requirement 14.6 counts **model operations**, not requests, and two paths make several gateway
 * calls. Getting the row count wrong in either direction would be a real reporting error, so the rule
 * is stated once here rather than inferred from each service:
 *
 * **A row covers one `operation`, and its `used_fallback` is the disjunction over the gateway calls
 * that operation made.**
 *
 *  - **A diagnosis is one row.** `vision-classify` and the rephrase are both the `image` operation, so
 *    `diagnosis.service.ts` writes `classified.usedFallback || rephrased.usedFallback`. Reading only
 *    the classification's flag would under-report a request whose *rephrase* fell back.
 *  - **A voice request is two rows.** Transcription is the `voice` operation and the answer is the
 *    `chat` operation — two operations, two rows — so the voice row carries the transcription's flag
 *    and the nested turn carries its own. ORing the answer's fallback onto the voice row would claim
 *    the *transcription* fell back, which is a different fact and the one an operator reading
 *    `usage_logs_outcome_idx` is trying to separate.
 *
 * Requirement 14.7 is satisfied either way — the fallback is recorded — and this is the reading that
 * keeps it attributable to the call that used it.
 *
 * **The nested turn's `quota_spent` is `true`, and that is the rule applied rather than bent.** A
 * chat answer inside a voice request reserves nothing (`coveredBy()`), but it really does attempt a
 * provider call, and this column records the fact observed rather than a guess about the outcome. So
 * reconciling `usage_logs` against `counters` is a comparison per *request*, not a per-operation row
 * count: one voice request legitimately produces a spent `voice` row and a spent `chat` row against a
 * single reserved unit. The `chat` row's `conversation_id` and its `messages.input_kind = 'voice'`
 * are what identify it as the nested one.
 *
 * =============================================================================
 * `quota_spent` IS THE SPEND RULE, NOT A COPY OF IT
 * =============================================================================
 *
 * The design's rule is a biconditional: *a unit is spent if and only if at least one provider call
 * was attempted for that request.* This column is how that claim is checked against `counters`
 * rather than trusted, so a caller must pass the fact it observed, never a guess about the outcome.
 *
 * Two consequences that read as surprises until the biconditional is applied:
 *
 *  - **A timeout is `quota_spent: true`.** A provider call was issued; the answer arrived too late.
 *    Refunding it would let a farmer with a slow connection spend unlimited provider capacity for
 *    zero quota. (A *pre-flight* budget refusal is the opposite: nothing was attempted, nothing was
 *    reserved, so it is `false`.)
 *  - **An out-of-scope chat referral is `quota_spent: false`.** No provider call was attempted — the
 *    referral is resolved from the knowledge base and answered from a static catalog — so the unit is
 *    refunded and the row says so. The design's step-9 enumeration lists only *failures* as
 *    refundable, but that enumeration is written for a pipeline whose only pre-provider exits are
 *    failures; a referral is a pre-provider exit that *succeeded*, a case the list does not
 *    contemplate. The biconditional is the stated rule, so it governs.
 */

/* ========================================================================== */
/* The vocabulary                                                              */
/* ========================================================================== */

/**
 * `usage_logs.model_provider`, including 0006's `'none'`.
 *
 * `'none'` is not "unknown" — it is the positive statement that no provider served this row, which
 * is true of a quota decline (14.3 forbids the call), a burst refusal, a redelivery (11.5 forbids
 * the service call), a pre-flight budget refusal, and an exhausted chain where no member answered.
 */
export type UsageProvider = 'gemini' | 'groq' | 'none';

/**
 * Why a farmer read the knowledge-base static template instead of the model's own prose.
 *
 * Shared by `chat.service.ts` (which names it `ChatDegradation`) and `diagnosis.service.ts`, because
 * both run the same rephrase step through the same `validateRephrased()` and must audit it the same
 * way. Before this type they did not: the diagnosis path collapsed `provider_failed` and
 * `checks_failed` into one `provider_error`, which claimed a chain failure on a request where the
 * chain had answered perfectly well and Jamee had refused the answer.
 */
export type RephraseDegradation = 'budget_exhausted' | 'provider_failed' | 'checks_failed';

/**
 * Which `usage_logs.outcome` a rephrase degradation is.
 *
 * `Record<RephraseDegradation, UsageOutcome>` is exhaustive, so a fourth degradation cannot be added
 * without deciding how it is audited.
 *
 *  - **`timeout`** for an exhausted budget: the request's own clock, which is Requirement 3.7's
 *    outcome value whatever operation the row carries.
 *  - **`provider_error`** for a failed or exhausted chain (Requirement 14.5).
 *  - **`validation_rejected`** when the model answered and the post-generation checks refused its
 *    prose. Requirement 5.7's outcome value, and it travels with `REPHRASE_REJECTED_REASON` so the
 *    rejection is attributable as that requirement asks — the pairing is what closed the gap where
 *    a `validation_rejected` row carried a null reason.
 */
export const DEGRADATION_OUTCOME = {
  budget_exhausted: 'timeout',
  provider_failed: 'provider_error',
  checks_failed: 'validation_rejected',
} as const satisfies Record<RephraseDegradation, UsageOutcome>;

/**
 * The `rejection_reason` that accompanies every `checks_failed` row (Requirement 5.7).
 *
 * A constant rather than a literal at three call sites, so the pairing with
 * `DEGRADATION_OUTCOME.checks_failed` is one fact in one place.
 */
export const REPHRASE_REJECTED_REASON: UsageRejectionReason = 'rephrase_rejected';

/** `outcome` for a rephrase that either succeeded or degraded. `null` is the farmer reading prose. */
export function outcomeForDegradation(degradation: RephraseDegradation | null): UsageOutcome {
  return degradation === null ? 'success' : DEGRADATION_OUTCOME[degradation];
}

/** The `rejection_reason` a degradation carries, if any. Only `checks_failed` has one. */
export function rejectionReasonForDegradation(
  degradation: RephraseDegradation | null,
): UsageRejectionReason | undefined {
  return degradation === 'checks_failed' ? REPHRASE_REJECTED_REASON : undefined;
}

/* ========================================================================== */
/* The facts a caller supplies                                                 */
/* ========================================================================== */

/**
 * Everything one audit row records. The five required-by-14.6 facts are required here too, so a
 * caller cannot produce a row that fails the criterion.
 *
 * `latencyMs` is required rather than optional, and that is deliberate: it is measured from the
 * instant the request began, and a call site that had to opt in would be a call site that could
 * forget. A path with nothing to measure still has an honest number — the time it took to refuse.
 */
export interface UsageFacts {
  readonly userId: string;
  readonly operation: Operation;
  readonly channel: Channel;
  readonly outcome: UsageOutcome;
  /** `'none'` when no provider served this row. See `UsageProvider`. */
  readonly provider: UsageProvider;
  /** Requirement 14.7. Threaded from `GatewayResult.usedFallback`, or from a failure's context. */
  readonly usedFallback: boolean;
  /** The spend rule, observed rather than inferred. See the header. */
  readonly quotaSpent: boolean;
  /** Milliseconds from the start of the request to this row. */
  readonly latencyMs: number;
  /** Requirement 5.7. Absent on every outcome that is not a rejection. */
  readonly rejectionReason?: UsageRejectionReason | undefined;
  readonly conversationId?: string | null | undefined;
  readonly diagnosisId?: string | null | undefined;
  /**
   * Overrides `PROMPT_VERSION`. Supplied only by a caller that knows a *different* revision produced
   * the row — nothing does today, and the seam exists so a future prompt A/B does not have to widen
   * this interface under time pressure.
   */
  readonly promptVersion?: string | undefined;
}

/**
 * Build the row. Every column, every time.
 *
 * The nullable columns are written as explicit `null` rather than omitted, which matters more than
 * it looks: an omitted key can insert as a collection default rather than `null`, so two call sites
 * that differ only in which keys they left out would produce rows that differ in whether a field
 * holds `null` or a default. Writing all thirteen means the row shape is a property of this function
 * and not of the caller's spelling.
 *
 * `prompt_version` is written on every row, **including rows that composed no prompt** — a quota
 * decline, a burst refusal, a redelivery. It records the prompt revision the request would have
 * used, which is what keeps the column non-null across a deployment's rows and therefore groupable.
 * A `group by prompt_version` that silently dropped every refused request would be answering a
 * different question from the one an operator asked.
 */
export function usageLogRow(facts: UsageFacts): UsageLogInsert {
  return {
    user_id: facts.userId,
    operation: facts.operation,
    channel: facts.channel,
    model_provider: facts.provider,
    outcome: facts.outcome,
    used_fallback: facts.usedFallback,
    rejection_reason: facts.rejectionReason ?? null,
    quota_spent: facts.quotaSpent,
    latency_ms: facts.latencyMs,
    prompt_version: facts.promptVersion ?? PROMPT_VERSION,
    conversation_id: facts.conversationId ?? null,
    diagnosis_id: facts.diagnosisId ?? null,
  };
}

/* ========================================================================== */
/* The write                                                                   */
/* ========================================================================== */

/**
 * The persistence seam, structural rather than nominal — `DiagnosisStore`, `ChatWriteStore` and
 * `VoiceStore` already satisfy it without declaring that they do, so the services keep their own
 * store interfaces and their existing tests keep working.
 */
export interface UsageLogWriter {
  insertUsageLog(row: UsageLogInsert): Promise<void>;
}

/**
 * Whether the row landed. Returned rather than thrown, so a caller that has something to say about
 * a failed audit — the Telegram inbound path reports it as a `DuplicateAudit` — can say it, while
 * the three services can ignore it.
 */
export type UsageLogWrite =
  | { readonly written: true }
  | { readonly written: false; readonly cause: unknown };

/**
 * Append one audit row. **Never throws.**
 *
 * Two reasons, and the second is the one that matters:
 *
 *  1. On a success path the domain rows are already committed and the farmer already has an answer.
 *     Turning a served diagnosis into HTTP 500 over a failed audit insert would cost the farmer a
 *     retry and another quota unit for a problem they cannot act on.
 *  2. On a failure path this runs while an `AppError` is in flight — `QUOTA_EXCEEDED`,
 *     `RATE_LIMITED`, `PROVIDERS_UNAVAILABLE`, `DIAGNOSIS_TIMEOUT`. If the audit write threw, it
 *     would *replace* that error with `INTERNAL_ERROR`, and the farmer would be told "something went
 *     wrong" instead of "you have reached today's limit, which resets at …".
 *
 * The failure is not silent. It goes to `console.error` with the `[jamee]` prefix, which is the same
 * channel `src/lib/errors.ts` uses and what reaches the runtime log on the target platform. The log
 * line carries the outcome and the farmer id and **no farmer content** — no message body, no
 * transcript, no phone number.
 */
export async function writeUsageLog(
  writer: UsageLogWriter,
  facts: UsageFacts,
): Promise<UsageLogWrite> {
  try {
    await writer.insertUsageLog(usageLogRow(facts));
    return { written: true };
  } catch (cause) {
    console.error(
      '[jamee] usage_log_write_failed',
      JSON.stringify({
        operation: facts.operation,
        channel: facts.channel,
        outcome: facts.outcome,
        userId: facts.userId,
      }),
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
    );
    return { written: false, cause };
  }
}

/**
 * The Data_Access_Layer-backed audit writer.
 *
 * `usage_logs` is reachable only through the owner-scoped `FarmerData.insertUsageLog` (D18), which
 * merges the owning Auth_User_Id from the bound id and stamps `createdAt`. So this takes no client
 * — the layer is the boundary — and it maps the wire-shaped `usageLogRow()` output to the layer's
 * `UsageLogDoc`, resolving `farmerData(row.user_id)` from the row's own non-null `user_id` anchor.
 *
 * "Append-only" still holds, now more strongly: a farmer session has no path to a `usage_logs`
 * write at all, because the only writer is this owner-scoped accessor and nothing hands a farmer
 * session the driver. The `user_id` anchor stays required — `UsageLogInsert` types it
 * as a non-nullable `string`, so the typecheck proves every row carries one, and it is what
 * `farmerData` is bound to.
 *
 * A `conversation_id` / `diagnosis_id` on the wire row is a document id as a hex string; it is
 * converted to an `ObjectId` for the document, and left `null` when absent or unparseable rather
 * than crashing an audit write that never fails a farmer's request (see `writeUsageLog`).
 */
export function usageLogWriterFrom(): UsageLogWriter {
  return {
    async insertUsageLog(row) {
      await farmerData(row.user_id).insertUsageLog(usageLogDocFrom(row));
    },
  };
}

/** A hex string to an `ObjectId`, or `null` when absent or not a valid id. Never throws. */
function toObjectId(value: string | null | undefined): ObjectId | null {
  if (value == null) return null;
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

/**
 * Map the wire-shaped audit row `usageLogRow()` builds to the Data_Access_Layer's `UsageLogDoc`
 * (minus the fields the accessor stamps). One place the snake_case → camelCase translation lives,
 * so `usageLogRow()` can stay the single builder every call site already uses while the actual
 * write goes through the layer.
 */
function usageLogDocFrom(
  row: UsageLogInsert,
): Omit<UsageLogDoc, '_id' | 'ownerId' | 'createdAt'> {
  return {
    operation: row.operation,
    channel: row.channel,
    modelProvider: row.model_provider ?? null,
    outcome: row.outcome,
    usedFallback: row.used_fallback ?? false,
    rejectionReason: row.rejection_reason ?? null,
    quotaSpent: row.quota_spent ?? false,
    latencyMs: row.latency_ms ?? null,
    promptVersion: row.prompt_version ?? null,
    conversationId: toObjectId(row.conversation_id),
    diagnosisId: toObjectId(row.diagnosis_id),
  };
}
