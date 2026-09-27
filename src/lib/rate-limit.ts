import 'server-only';

import { BURST_QUOTAS } from '@/lib/config/verified';
import { pruneMinuteCounters } from '@/lib/db/farmer';
import { AppError } from '@/lib/errors';
import type { Operation, WindowKind } from '@/lib/schemas';
import { minuteWindowKey } from '@/lib/time';
import {
  adminCounterRpc,
  type CounterRpc,
  type QuotaContext,
} from '@/services/quota.service';

/**
 * Per-farmer burst rate limiting: the minute-window control that sits one step above the daily
 * quota and refuses a farmer who is asking faster than a human works.
 *
 * Requirements: 13.8 (the API_Layer applies per-farmer request rate limiting to the diagnosis,
 *               chat, and voice endpoints)
 * Design: "Rate limiting versus daily quota"; "Quota enforcement" → *When a unit is reserved,
 *         finalized, or refunded*, step 5
 * Depends on: migration `0007_counters_and_quota_fn.sql`, `src/lib/time.ts`,
 *             `src/services/quota.service.ts`
 *
 * =============================================================================
 * THE ONE THING THIS MODULE GUARANTEES
 * =============================================================================
 *
 * **A rate-limited request never increments the daily counter, and never calls a provider.**
 *
 * That is Property 28, and it is true here by *position* rather than by bookkeeping. The check
 * runs at step 5 of the design's ordered sequence — after ownership, before the reserve — so a
 * refusal happens while the farmer's daily row is still untouched. There is nothing to refund
 * because nothing was taken, which is also why this module has no refund and never will: unlike
 * the daily quota, "spent" for a burst window means *you asked too fast*, not *Jamee did work*.
 *
 * The three services already hold the seam at that exact position (`BurstCheck` below), so
 * filling it cannot move it. What fills it is bound at the three route handlers, which are the
 * API_Layer surfaces Requirement 13.8 names.
 *
 * =============================================================================
 * SAME TABLE, DIFFERENT CONTROL
 * =============================================================================
 *
 * | | Daily quota (14.1) | Burst limit (13.8) |
 * | --- | --- | --- |
 * | Row | `counters`, `window_kind = 'day'` | `counters`, `window_kind = 'minute'` |
 * | Ceiling | `DAILY_QUOTAS` — 20 / 50 / 20 | `BURST_QUOTAS` — set independently |
 * | Key | `YYYY-MM-DD` (Asia/Kolkata) | `YYYY-MM-DDTHH:MM` (Asia/Kolkata) |
 * | Refundable | yes, before the first provider attempt | **never** |
 * | Code | `QUOTA_EXCEEDED`, 429, not retryable today | `RATE_LIMITED`, 429, retryable in seconds |
 * | Pruned | never — a deleted day row is a free allowance | yes, by age |
 *
 * Both statuses are 429 and that is not sloppiness: the difference a client needs is the
 * *retryable* flag, and the two disagree on it. A burst refusal clears within the minute; a daily
 * decline does not clear until the next Asia/Kolkata midnight, which is why `errors.ts` marks it
 * not retryable and gives it a `resetsAt` instead.
 *
 * No new SQL. `counter_try_increment` already takes `p_window_kind` and takes its ceiling as a
 * *parameter*, so the burst check is the same atomic statement the reserve uses with two different
 * arguments — one row lock, one round trip, no advisory lock, and no second implementation of the
 * boundary race to keep in step. `counter_prune_minute_windows` already exists for the prune.
 *
 * =============================================================================
 * THE CEILING IS JAMEE'S OWN NUMBER
 * =============================================================================
 *
 * `BURST_QUOTAS` in `config/verified.ts` (3 image / 10 chat / 3 voice per minute) is a **product**
 * rule alongside `DAILY_QUOTAS`, and carries no V annotation for a reason worth stating explicitly:
 * `docs/PROVIDER_CAPABILITIES.md` records provider requests-per-minute as **UNRESOLVED**
 * (U-V19a, U-V19b). So this number must not be read, quoted, or documented as a provider limit —
 * it is Jamee's answer to "faster than a human works", derived from the farmer's own loop:
 * photographing a leaf and reading a diagnosis is tens of seconds of work, so three image or voice
 * requests inside one minute is already generous, and a chat turn is faster to type than to
 * photograph, so ten is the matching allowance.
 *
 * What the number is *for* is also worth being honest about. It is not free-tier capacity
 * management — the daily quota does that, and it is the control that bounds a day's provider spend.
 * The burst ceiling bounds the *rate*, which is what protects a single serverless instance and the
 * database connection pool from one client in a retry loop, and what makes an accidental
 * double-submit cost one unit instead of two. When the providers' real RPM figures resolve, they
 * become a *second* ceiling to check this one against — never a replacement for it.
 *
 * =============================================================================
 * NESTING: THE COVERAGE ARGUMENT, NOT A SECOND FLAG
 * =============================================================================
 *
 * A chat answer produced inside a voice request must not be burst-checked twice — for the same
 * reason it must not reserve twice (Requirement 14.1). `quota.service.ts` already has the concept
 * for "this request entered somewhere else": a `QuotaContext` is either `owns_request` or
 * `covered`, and `covered` can only be minted from a real, branded `QuotaReservation`.
 *
 * `checkBurstForRequest()` below reuses that context rather than inventing a parallel boolean. On a
 * `covered` context it performs **no RPC at all**, exactly as `reserveForRequest()` does, so the
 * nested turn cannot consume a second minute slot from a ceiling of three. A second flag would be
 * a second thing to keep in step with the reservation, and the two disagreeing is precisely the
 * bug — a farmer's voice message eating two of their three chat burst slots — that the shared
 * context makes unrepresentable.
 *
 * Defence in depth on the same fact: `/api/voice` binds a limiter to `VoiceService` and binds
 * **none** to the nested `chatAnswerer()`, so the nested turn has no limiter to call even if the
 * context reasoning were ever weakened.
 *
 * =============================================================================
 * A BURST REFUSAL IS AUDITED — AND NOT FROM HERE
 * =============================================================================
 *
 * This module once recorded a gap: a refused request threw out of the service before any audit
 * write, so nothing was logged beyond the `context` on the error, because migration `0006`'s
 * `outcome` check constraint had seven values and **none of them meant "refused for asking too
 * fast"**. `quota_declined` was the only near-fit and using it would have made the audit trail claim
 * a farmer hit their daily limit when they had not — the one thing that column exists to answer.
 *
 * **Task 24.3 closed it.** `rate_limited` is now in `usageOutcomeSchema` and in the `outcome`
 * constraint, widened by `0011_usage_logs_audit_vocabulary.sql` (0006 itself is untouched; an
 * applied migration is history). Requirement 14.6 never demanded the row — this path completes no
 * model operation — but the glossary defines a Usage_Log as recording "one billable **or
 * rate-limited** operation", and that phrase is now satisfiable rather than merely aspirational.
 *
 * **The row is written by the three services, not by `checkBurst()`.** That placement is the point,
 * so it is stated here rather than left to be rediscovered:
 *
 *  - A row needs the request's `channel` and its start instant for `latency_ms`. This module sees
 *    neither — `BurstCheck` is `(userId, operation) => Promise<void>` deliberately, and widening it
 *    to carry audit facts would make every caller supply them to a *rate limiter*.
 *  - `burst` is an **injected seam**. A limiter whose counter RPC failed raises `INTERNAL_ERROR`,
 *    and a writer inside this module could not tell that apart from a refusal without re-inspecting
 *    its own throw. The services read `error.code === 'RATE_LIMITED'` instead, so an unreachable
 *    counter is never recorded as a refusal that never happened.
 *  - A nested chat turn is `covered`, so `checkBurstForRequest()` performs no check and the service
 *    reaches no catch — which is what keeps one voice request from writing two `rate_limited` rows.
 *
 * `quota_spent: false` on every such row, and that is a fact rather than a convention: the check
 * runs at step 5, above the reserve, so nothing was taken and no refund exists to make.
 *
 * =============================================================================
 * SCOPE: THREE ENDPOINTS, NOT EVERY CALLER
 * =============================================================================
 *
 * Requirement 13.8 names "the diagnosis, chat, and voice endpoints", and that is exactly where a
 * limiter is bound: `/api/diagnose`, `/api/chat`, `/api/voice`. **The Telegram webhook is not burst
 * -limited**, and that is the requirement's scope rather than an omission — an inbound webhook is
 * rate-controlled by the platform's own delivery behaviour, its duplicates are already refused by
 * the inbound idempotency guard (Requirement 11.5) at a step *above* this one, and its per-farmer
 * daily cost is bounded by the shared counter it writes with the web channel.
 *
 * The counters do not care: the key has no channel component, so binding `burstLimiter()` in the
 * Telegram adapter needs no change here — it simply shares the same minute row. What would need
 * deciding first is the refusal's shape, because a 429 to the platform is a redelivery request
 * rather than a message to a farmer, and Requirement 10.11 wants an acknowledgement.
 */

/* ========================================================================== */
/* The seam                                                                    */
/* ========================================================================== */

/**
 * Throw `RATE_LIMITED` when this farmer is asking faster than the burst allowance permits.
 *
 * The declaration lives here, in the module the design names for Requirement 13.8. It was born in
 * `diagnosis.service.ts` — a seam fixing the check's *position* before the check existed — and moved
 * here with the implementation rather than being copied, so all three services import one type from
 * one place and there is nothing to keep in step.
 *
 * It is a plain `(userId, operation) => Promise<void>` rather than something that returns a
 * decision, because a caller that could *inspect* the refusal could also continue past it. Throwing
 * is what makes "the reserve is not reached" a control-flow fact.
 */
export type BurstCheck = (userId: string, operation: Operation) => Promise<void>;

/**
 * No burst ceiling. The default in every service, and the right one there.
 *
 * Two callers depend on this being the *default* rather than the exception:
 *
 *  - **Unit tests.** A service constructed without an explicit limiter reads no environment
 *    variable and opens no connection, so a test of the diagnosis pipeline stays a test of the
 *    diagnosis pipeline.
 *  - **Nested calls.** `chatAnswerer()` inside a voice request is handed no limiter (see the module
 *    header), so the default is what it gets.
 *
 * Requirement 14.1's daily limit applies regardless — this is the *burst* control only.
 */
export const noBurstCheck: BurstCheck = () => Promise.resolve();

/* ========================================================================== */
/* The ceiling and the window                                                  */
/* ========================================================================== */

/** Minute rows only. The daily quota's `'day'` rows belong to `quota.service.ts`. */
const MINUTE_WINDOW: WindowKind = 'minute';

/**
 * Requirement 13.8's per-operation ceiling, read from `config/verified.ts` and never copied — the
 * same discipline `limitFor()` follows for the daily quota, and for the same reason: the number a
 * check uses and the number anything else quotes must be one declaration.
 */
export function burstLimitFor(operation: Operation): number {
  return BURST_QUOTAS[operation];
}

/**
 * Seconds until this farmer's next burst window opens.
 *
 * The minute boundary is the same instant in Asia/Kolkata as in UTC — India's offset is a whole
 * number of minutes (+05:30) — so the seconds field is enough and no timezone arithmetic is needed
 * here. Clamped to at least 1: `retryAfterSeconds: 0` would read as "retry now" on the one request
 * that must not be retried now, and `errorDetailsSchema` wants an integer either way.
 */
export function secondsToNextWindow(now: Date = new Date()): number {
  const elapsed = now.getUTCSeconds();
  return Math.min(60, Math.max(1, 60 - elapsed));
}

/**
 * The refusal (Requirement 13.8, `ERROR_SPECS`: 429, **retryable**).
 *
 * `details.retryAfterSeconds` is the only structured field, and it is the one a client can act on:
 * `errorResponse()` turns it into a `retry-after` header, and the catalogs' sentence ("That was
 * very quick. Please wait a moment and try again.") already says the rest in all three languages.
 *
 * What is deliberately **not** in `details`: the ceiling and the used count. A farmer cannot act on
 * "3 per minute", and putting a `limit` on this envelope would invite a client to render it beside
 * the daily allowance a farmer actually tracks — two different limits reading as one number. Both
 * go to `context` instead, which `toEnvelope()` structurally cannot serialize outward.
 */
export function rateLimitedError(userId: string, operation: Operation, now: Date): AppError {
  return new AppError('RATE_LIMITED', {
    details: { retryAfterSeconds: secondsToNextWindow(now) },
    context: {
      reason: 'burst_ceiling_reached',
      userId,
      operation,
      limit: burstLimitFor(operation),
      windowKind: MINUTE_WINDOW,
      windowKey: minuteWindowKey(now),
    },
  });
}

/* ========================================================================== */
/* The check                                                                   */
/* ========================================================================== */

export interface BurstOptions {
  /**
   * The counter seam, shared with `quota.service.ts` rather than re-declared. Defaults to the
   * Data_Access_Layer-backed counter, built on first use — so a caller that injects its own (every
   * unit test) reads no `MONGODB_URI`.
   */
  readonly rpc?: CounterRpc | undefined;
  /**
   * The instant the minute key is derived from. Defaults to now.
   *
   * Injectable for the same reason `QuotaOptions.now` is: a test that had to wait for a minute
   * boundary to cross would not be a test.
   */
  readonly now?: Date | undefined;
}

/**
 * Take one slot in this farmer's current minute window, or refuse the request.
 *
 * One `counter_try_increment` against `(user_id, operation, 'minute', 'YYYY-MM-DDTHH:MM')`. A
 * `null` result means the row was already at the ceiling — the same at-limit signal the daily
 * reserve reads, and `adminCounterRpc()` is what guarantees a transport failure cannot arrive
 * looking like one (it checks `error` first and throws `INTERNAL_ERROR`).
 *
 * Three consequences of the key that are worth naming:
 *
 *  - **No channel component**, inherited from 0007's primary key rather than restated here. So the
 *    minute row is per farmer and per operation, whatever channel a request arrives on — the same
 *    shape Requirement 14.2 gives the daily limit. (Which *endpoints* consult it is a separate
 *    question; see the scope note in the module header.)
 *  - **Nothing resets on a schedule.** A new minute is a new key, and a key with no row starts at
 *    zero, so there is no window to be half-open during a deploy.
 *  - **A successful check writes a row even when the request later fails.** That is correct for a
 *    rate limit: the request was *made*, and the cost being bounded is the rate, not the outcome.
 */
export async function checkBurst(
  userId: string,
  operation: Operation,
  options: BurstOptions = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const rpc = options.rpc ?? adminCounterRpc();

  const used = await rpc.tryIncrement({
    userId,
    operation,
    windowKind: MINUTE_WINDOW,
    windowKey: minuteWindowKey(now),
    limit: burstLimitFor(operation),
  });

  if (used === null) throw rateLimitedError(userId, operation, now);
}

/**
 * The burst check for a service that might be running nested — the counterpart of
 * `reserveForRequest()`, and deliberately the same shape.
 *
 * On a `covered` context this returns without calling `check` at all: the request entered
 * somewhere else, that entry point was burst-checked, and a second check here would refuse a
 * farmer for a request they only made once. On `owns_request` it forwards the farmer and the
 * operation the context carries, so the check cannot be run against an operation the reserve is
 * not about.
 *
 * A service that owns its request unconditionally (diagnosis, voice) does not need this — it calls
 * its `BurstCheck` directly with `ownsRequest`'s own two values. It exists for `chatTurn()`, the
 * one entry point that is sometimes nested.
 */
export async function checkBurstForRequest(
  context: QuotaContext,
  check: BurstCheck,
): Promise<void> {
  if (context.role === 'covered') return;
  await check(context.userId, context.operation);
}

/* ========================================================================== */
/* The prune (Requirement 13.8's periodic minute-row cleanup)                  */
/* ========================================================================== */

/** How stale a minute row must be before the prune removes it. */
export const BURST_PRUNE_OLDER_THAN_MINUTES = 60;

/** How often a limiter runs the prune, at most, per process. */
export const BURST_PRUNE_EVERY_MS = 15 * 60_000;

/**
 * The narrow legacy seam a restatement-pending test still constructs: one `rpc(fn, args)` returning
 * `{ data, error }`, mirroring how the retired `counter_prune_minute_windows` PostgREST call read.
 * Kept solely so that test compiles against the ported module; production passes no client and
 * takes the Data_Access_Layer path below.
 */
export interface MinutePruneClient {
  rpc(
    fn: 'counter_prune_minute_windows',
    args: { readonly p_older_than_minutes: number },
  ): PromiseLike<{ readonly data: number | null; readonly error: unknown }>;
}

/** Rows deleted. A number rather than void, so a caller can log what housekeeping achieved. */
export type MinutePrune = () => Promise<number>;

export interface PruneOptions {
  /**
   * *Amended by A3:* production supplies nothing and the prune runs through the Data_Access_Layer.
   * A legacy `{ data, error }` client may still be injected by a restatement-pending test.
   */
  readonly client?: MinutePruneClient | undefined;
  readonly olderThanMinutes?: number | undefined;
}

/**
 * Delete stale minute rows.
 *
 * *Amended by Amendment A3:* this was `client.rpc('counter_prune_minute_windows', …)` on the
 * Supabase service-role client. Under A3 it is the Data_Access_Layer's `pruneMinuteCounters`, a
 * named system accessor that deletes by `windowKind: 'minute'` and age and **never touches a day
 * row** — deleting one would silently hand a farmer a fresh daily allowance, so the invariant lives
 * inside the accessor's filter, exactly where the `0007` function used to keep it. It is one of the
 * few legitimately farmer-unscoped operations (age-scoped across all farmers), which is why it is a
 * named system accessor beside the owner-scoped ones rather than part of `FarmerData`.
 *
 * The optional legacy `client` preserves the old `{ data, error }` classification for a
 * restatement-pending test — an `error` becomes `INTERNAL_ERROR`, never a silent zero. Production
 * passes nothing and reaches the DAL.
 */
export async function pruneMinuteWindows(options: PruneOptions = {}): Promise<number> {
  const olderThanMinutes = options.olderThanMinutes ?? BURST_PRUNE_OLDER_THAN_MINUTES;

  if (options.client !== undefined) {
    const { data, error } = await options.client.rpc('counter_prune_minute_windows', {
      p_older_than_minutes: olderThanMinutes,
    });
    if (error !== null && error !== undefined) {
      throw new AppError('INTERNAL_ERROR', {
        cause: error,
        context: { reason: 'counter_prune_failed', olderThanMinutes },
      });
    }
    return data ?? 0;
  }

  try {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
    return await pruneMinuteCounters(cutoff);
  } catch (error) {
    throw new AppError('INTERNAL_ERROR', {
      cause: error,
      context: { reason: 'counter_prune_failed', olderThanMinutes },
    });
  }
}

/* ========================================================================== */
/* The production limiter                                                      */
/* ========================================================================== */

export interface BurstLimiterOptions {
  /** As `BurstOptions.rpc`, built on first use rather than at construction. */
  readonly rpc?: CounterRpc | undefined;
  /**
   * The clock, read per call. A `Date` would be wrong here: a limiter is constructed once per
   * request and asked once, but nothing stops a caller holding one longer, and a frozen instant
   * would pin every farmer to one minute window forever.
   */
  readonly now?: (() => Date) | undefined;
  /**
   * Housekeeping. `null` disables it; the default runs `pruneMinuteWindows()` through the
   * Data_Access_Layer, at most once per `pruneEveryMs` **per process**.
   */
  readonly prune?: MinutePrune | null | undefined;
  readonly pruneEveryMs?: number | undefined;
}

/**
 * The `BurstCheck` the routes bind: the real ceiling, plus the periodic prune.
 *
 * ### Why the prune rides along here
 *
 * Requirement 13.8 asks for the limiter; the design asks for "a periodic delete" and is explicit
 * that "at the 6-tester scale a prune is a convenience, not a requirement". Migration 0007 makes
 * the same point from the other side — the prune is *a function to be called* rather than a
 * trigger, because a trigger "would put a delete on the hot path of every reserve to reclaim rows
 * nobody is waiting on".
 *
 * So it needs a caller, and the honest options were a cron-driven internal endpoint or a throttled
 * piggyback. This is the piggyback, and the trade-off is stated rather than hidden:
 *
 *  - **At most once per 15 minutes per process**, and the schedule is marked *before* the await, so
 *    two concurrent requests on one instance cannot both prune.
 *  - **After the check has passed**, never before it, so a refused request stays as cheap as it can
 *    be and a farmer in a retry loop cannot drive housekeeping.
 *  - **Awaited, and its failures swallowed.** Awaiting costs the unlucky request one small `delete`
 *    on a table holding tens of rows at this scale; not awaiting would leave a floating promise a
 *    serverless freeze can drop mid-statement, which is how a reclaim job becomes a mystery. A
 *    failed prune is logged and *never* propagated: refusing a farmer's diagnosis because
 *    housekeeping failed would be the tail wagging the dog.
 *  - **The schedule is per limiter instance**, not module state, so nothing here leaks between
 *    tests and a test can drive the interval with its own clock.
 *
 * When `src/app/api/internal/**` gains a scheduled sweep, `pruneMinuteWindows()` is the function to
 * call from it and `prune: null` is how a route opts out of the piggyback. Nothing else changes.
 */
export function burstLimiter(options: BurstLimiterOptions = {}): BurstCheck {
  const clock = options.now ?? ((): Date => new Date());
  const pruneEveryMs = options.pruneEveryMs ?? BURST_PRUNE_EVERY_MS;
  const prune = options.prune === undefined ? defaultPrune : options.prune;

  let rpc = options.rpc;
  /** 0 means "due now": a cold instance prunes on its first request. See below. */
  let nextPruneAtMs = 0;

  return async (userId, operation) => {
    const now = clock();
    rpc ??= adminCounterRpc();

    await checkBurst(userId, operation, { rpc, now });

    if (prune === null) return;

    /**
     * A fresh process is due immediately rather than after one interval. A serverless instance
     * often does not live 15 minutes, and a prune that waits for an uptime the platform never
     * grants is a prune that never runs — which is not what "a periodic prune" means.
     */
    const nowMs = now.getTime();
    if (nowMs < nextPruneAtMs) return;
    nextPruneAtMs = nowMs + pruneEveryMs;

    try {
      const deleted = await prune();
      if (deleted > 0) {
        console.info('[jamee] counter_minute_prune', JSON.stringify({ deleted }));
      }
    } catch (cause) {
      // Housekeeping never fails a farmer's request. The sweep is a convenience; the answer is not.
      console.error(
        '[jamee] counter_minute_prune_failed',
        cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
      );
    }
  };
}

/** The default prune: the Data_Access_Layer, reached on first use rather than at import. */
const defaultPrune: MinutePrune = () => pruneMinuteWindows();
