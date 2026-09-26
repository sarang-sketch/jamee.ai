import 'server-only';

import { DAILY_QUOTAS } from '@/lib/config/verified';
import { farmerData } from '@/lib/db/farmer';
import { AppError } from '@/lib/errors';
import type { Operation, QuotaStatus, WindowKind } from '@/lib/schemas';
import { dayWindowKey, nextResetAtIso } from '@/lib/time';

/**
 * The daily quota reserve, refund, and read — the only module that spends a unit.
 *
 * Requirements: 14.1 (20 image / 50 chat / 20 voice per Quota_Window), 14.2 (the Web_App and
 *               WhatsApp channels count against ONE shared per-farmer limit per operation),
 *               14.3 (a request past the limit is declined, states the limit and the reset time,
 *               and invokes no model provider), 6.7 (an accepted inconclusive diagnosis counts
 *               exactly one image analysis)
 * Design: "Quota enforcement" — *When a unit is reserved, finalized, or refunded*
 * Depends on: migration `0007_counters_and_quota_fn.sql`, `src/lib/time.ts`
 *
 * =============================================================================
 * THE SPEND RULE, AND WHY IT IS ONE SENTENCE
 * =============================================================================
 *
 * **A unit is spent if and only if at least one provider call was attempted for that request.**
 *
 * A biconditional, not a list of cases, because a list drifts. What it settles:
 *
 *  - An ownership 403 spends **zero** (Requirement 2.6) — `assertOwnership()` runs at step 4,
 *    before the reserve at step 6, so nothing was taken to give back.
 *  - A duplicate WhatsApp delivery spends **zero** (Requirement 11.5) — the `whatsapp_inbound`
 *    idempotency insert is step 3, so a Meta redelivery never reaches the counter.
 *  - An exhausted quota spends **zero** and calls no provider (Requirement 14.3).
 *  - An accepted inconclusive diagnosis spends **exactly one** (Requirement 6.7). The
 *    classification call happened; validation rejected its content. Spent.
 *  - A provider fallback still spends **one**, plus a `used_fallback` audit row (14.4, 14.7).
 *  - **Both providers failed, or the request timed out: spent, and NOT refunded.** Deliberate.
 *    Those requests consumed real provider capacity, and refunding them would let a failing
 *    provider drain the free tier through retries. The farmer is told honestly that Jamee is
 *    busy; the retry costs a new unit.
 *
 * The order of operations in the design is the contract, and this module is step 6 (`reserve`),
 * step 8's read (`status`), and step 9 (`refund`). It knows nothing about steps 1–5 or 7 on
 * purpose: it cannot enforce an ordering it cannot see, so the guarantee lives in the sequence
 * the services follow, and `refund` is documented at the point where it would be misused.
 *
 * =============================================================================
 * BURST RATE LIMITING IS A DIFFERENT CONTROL (task 24.1, Requirement 13.8)
 * =============================================================================
 *
 * The burst limiter writes the SAME `counters` table with `window_kind = 'minute'` and its own
 * per-operation ceiling (`BURST_QUOTAS`), set independently of the daily quota. Three facts about
 * it that belong here so the two are never confused:
 *
 *  1. It is checked at **step 5, BEFORE the reserve**. A refused burst request therefore never
 *     increments the daily counter (the design's Property 28).
 *  2. It is **never refunded**, precisely because it precedes the reserve — there is nothing to
 *     hand back, and "spent" for it means "you asked too fast", not "Jamee did work".
 *  3. It is `RATE_LIMITED` (429, retryable in seconds), not `QUOTA_EXCEEDED` (429, not retryable
 *     today). Same status code, different truth about when a retry can work.
 *
 * Nothing in this file reads or writes a minute window. `CounterRpc` below carries `windowKind`
 * so task 24.1 can reuse the same seam, but every public function here passes `'day'`.
 *
 * =============================================================================
 * WHY `server-only` AND THE SERVICE-ROLE CLIENT
 * =============================================================================
 *
 * *Amended by Amendment A3.* Under Supabase, `counters` granted `authenticated` no write policy and
 * the only writes were through `security definer` functions invoked with the service role. Under
 * A3 there is no RLS and no service-role client: `counters` is reachable only through the
 * Data_Access_Layer's owner-scoped accessors (D18), which merge the owning Auth_User_Id into the
 * counter key by construction. So this module is server-only, it holds no database handle of its
 * own, and the old rule "every service-role query carries an explicit `user_id`" is now structural
 * — `farmerData(userId)` binds the owner, and there is no code path that reaches a counter row
 * without one.
 */

/* ========================================================================== */
/* The limits, and the window kind                                             */
/* ========================================================================== */

/**
 * Requirement 14.1's three numbers live in `src/lib/config/verified.ts` and are read from there,
 * never copied. There is no second copy in the database either: the conditional reserve takes the
 * limit as an argument rather than reading a table, so `DAILY_QUOTAS` is the single declaration
 * site for 20 / 50 / 20 across the whole system.
 */
export function limitFor(operation: Operation): number {
  return DAILY_QUOTAS[operation];
}

/**
 * Daily quota rows only. The burst limiter's `'minute'` rows are task 24.1's business.
 */
const DAY_WINDOW: WindowKind = 'day';

/* ========================================================================== */
/* The RPC seam                                                                */
/* ========================================================================== */

/** Arguments shared by all three counter functions. `userId` is not optional anywhere. */
interface CounterKey {
  readonly userId: string;
  readonly operation: Operation;
  readonly windowKind: WindowKind;
  /** From `src/lib/time.ts`. **No channel component** — see `reserve()`. */
  readonly windowKey: string;
}

/**
 * The three counter operations, as this module uses them.
 *
 * A three-method seam rather than the Data_Access_Layer's `FarmerData` bundle directly, for one
 * reason that survived the A3 port unchanged: **it is the boundary where a transport failure stops
 * looking like an at-limit answer.** `counterTryIncrement` signals "already at the limit" by
 * returning `null` (the conditional upsert matched nothing at the boundary, or it raced and the
 * duplicate-key error `11000` was caught inside the layer). Any OTHER database failure throws out
 * of the layer rather than arriving as a `null`, so by the time a `null` reaches `reserve()` it
 * means exactly one thing — declined, not "the database was unreachable".
 *
 * Unit tests stub this interface. Real atomicity is a MongoDB fact proven by the integration suite
 * against `mongodb-memory-server` (V31, V33), not by a stub here.
 */
export interface CounterRpc {
  /** The conditional reserve (D19). The new count, or `null` when already at `limit`. */
  tryIncrement(args: CounterKey & { readonly limit: number }): Promise<number | null>;
  /** The guarded refund. The new count, or `null` when no row matched (already zero). */
  decrement(args: CounterKey): Promise<number | null>;
  /** The read. Zero for an absent row — the layer coalesces, so there is no null case. */
  used(args: CounterKey): Promise<number>;
}

/**
 * Bind the seam to the Data_Access_Layer.
 *
 * *Amended by Amendment A3:* this was `adminCounterRpc(client = createAdminClient())`, a slice of a
 * Supabase service-role client calling the three `0007` `security definer` functions. Under A3 the
 * atomic counter operations are D19's `findOneAndUpdate` conditional upsert / guarded decrement /
 * read, and they live on the owner-scoped `FarmerData` bundle in `src/lib/db/farmer.ts` — the only
 * holder of the driver (D18). So each method resolves `farmerData(args.userId)` and forwards to its
 * counter helper. The exported name is kept — every service and the burst limiter build their
 * default RPC through `adminCounterRpc()` — and it now takes NO argument in production, because
 * there is no separate service-role client to inject: the layer *is* the access boundary, and its
 * accessor merges the owner into the counter key by construction.
 *
 * A caller that injects its own `CounterRpc` (every unit test, via `QuotaOptions.rpc`) bypasses this
 * entirely, so a test reads no `MONGODB_URI` and opens no connection.
 *
 * ### The optional `legacyClient` parameter
 *
 * A property test still exercises the "a transport failure must not read as at-limit" classifier
 * through the OLD PostgREST-shaped seam (`{ data, error }`). That property is preserved verbatim
 * under A3 — a database failure throws out of the Data_Access_Layer rather than arriving as a
 * `null` — and rewriting those property tests belongs to a later restatement task, not this port.
 * So `adminCounterRpc` accepts an OPTIONAL legacy client for exactly that: when one is supplied its
 * `{ data, error }` is checked `error`-first and a non-null error becomes `INTERNAL_ERROR`, the same
 * classification the DAL now gives by throwing. Production passes nothing and takes the DAL path.
 */
export interface CounterRpcResponse {
  readonly data: number | null;
  readonly error: unknown;
}

/**
 * The narrow legacy seam a restatement-pending property test still constructs: one `rpc(fn, args)`
 * returning `{ data, error }`. Kept solely so those tests compile against the ported module; nothing
 * in production constructs one.
 */
export interface CounterRpcClient {
  rpc(fn: string, args: unknown): PromiseLike<CounterRpcResponse>;
}

function legacyRpcFailure(fn: string, cause: unknown, key: CounterKey): AppError {
  return new AppError('INTERNAL_ERROR', {
    cause,
    context: {
      reason: 'counter_rpc_failed',
      fn,
      userId: key.userId,
      operation: key.operation,
      windowKind: key.windowKind,
      windowKey: key.windowKey,
    },
  });
}

export function adminCounterRpc(legacyClient?: CounterRpcClient): CounterRpc {
  if (legacyClient !== undefined) {
    const call = async (fn: string, key: CounterKey, extra: Record<string, unknown> = {}): Promise<number | null> => {
      const { data, error } = await legacyClient.rpc(fn, {
        p_user: key.userId,
        p_operation: key.operation,
        p_window_kind: key.windowKind,
        p_window_key: key.windowKey,
        ...extra,
      });
      if (error !== null && error !== undefined) throw legacyRpcFailure(fn, error, key);
      return data;
    };
    return {
      tryIncrement: (args) => call('counter_try_increment', args, { p_limit: args.limit }),
      decrement: (args) => call('counter_decrement', args),
      async used(args) {
        return (await call('counter_used', args)) ?? 0;
      },
    };
  }

  return {
    tryIncrement(args) {
      return farmerData(args.userId).counterTryIncrement(
        args.operation,
        args.windowKind,
        args.windowKey,
        args.limit,
      );
    },
    decrement(args) {
      return farmerData(args.userId).counterDecrement(args.operation, args.windowKind, args.windowKey);
    },
    used(args) {
      return farmerData(args.userId).counterUsed(args.operation, args.windowKind, args.windowKey);
    },
  };
}

/* ========================================================================== */
/* Options                                                                     */
/* ========================================================================== */

export interface QuotaOptions {
  /** The RPC seam. Defaults to the Data_Access_Layer-backed counter, built on first use. */
  readonly rpc?: CounterRpc | undefined;
  /**
   * The instant the window key and the reset instant are derived from. Defaults to now.
   *
   * Injectable because a quota window is a wall-clock fact in Asia/Kolkata, and a test that had
   * to wait for 18:30 UTC to check the boundary would not be a test.
   */
  readonly now?: Date | undefined;
}

/* ========================================================================== */
/* A reservation, and why it is unforgeable                                    */
/* ========================================================================== */

/**
 * Brand. Not exported, and a real runtime symbol rather than a `declare const`, so a
 * `QuotaReservation` can only be minted inside this module: no other file can write the key.
 *
 * That is what turns "a nested service must not reserve" from a rule someone remembers into
 * something the type system carries — see `QuotaContext`.
 */
const RESERVATION = Symbol('jamee.quota.reservation');

/**
 * Proof that one unit is spent for the request in hand.
 *
 * Carries the `windowKey` it actually incremented, which matters for exactly one case and that
 * case is real: a request that starts at 23:59:59 IST and fails at 00:00:01 IST. Refunding by
 * "today's key" would then decrement TOMORROW's row — creating a spare unit tomorrow and leaving
 * yesterday's spend in place. `refundReservation()` refunds this key instead of re-deriving one.
 */
export interface QuotaReservation {
  readonly [RESERVATION]: true;
  readonly userId: string;
  readonly operation: Operation;
  readonly windowKey: string;
  /** The count AFTER the increment, straight from the atomic statement. */
  readonly used: number;
  readonly limit: number;
  /** Next Asia/Kolkata midnight, ISO-8601 (Requirement 14.3). */
  readonly resetsAt: string;
  /**
   * `true` when THIS service took the reserve; `false` when it inherited one from the request
   * that called it. `refundReservation()` is a no-op on an inherited reservation — the owner
   * refunds, and a nested refund would give back a unit the outer request is still holding.
   */
  readonly reservedHere: boolean;
}

export type ReserveOutcome =
  | { readonly outcome: 'allowed'; readonly reservation: QuotaReservation }
  /** Requirement 14.3: the caller declines with this and calls **no** provider. */
  | { readonly outcome: 'at_limit'; readonly status: QuotaStatus };

/* ========================================================================== */
/* reserve (step 6)                                                            */
/* ========================================================================== */

/**
 * Take one unit atomically, or report that the farmer is at their limit.
 *
 * ### The key is `(user_id, operation, 'day', window_key)` and has NO channel component
 *
 * Requirement 14.2's cross-channel sharing is therefore automatic rather than enforced by
 * convention: this function accepts no channel, the SQL primary key has no column for one, and
 * a web request and a WhatsApp request land on the same counter row because there is nothing
 * that could separate them. `channel` is still recorded on the `usage_logs` row (Requirement
 * 14.6) — that is an audit fact, and audit facts do not partition quota.
 *
 * ### The at-limit branch carries what the decline has to say
 *
 * A `null` from `counter_try_increment` means the row was already at `limit`. Requirement 14.3
 * requires the decline to state the limit AND the reset time, so both travel back inside a
 * `QuotaStatus` — `used` is reported as `limit`, because that is what the row holds. Pass that
 * status to `quotaExceededError()` and the envelope's `details` is populated from the same values
 * the check used, rather than from a caller's recollection of them.
 *
 * Never call this more than once per request. See `reserveForRequest()`.
 */
export async function reserve(
  userId: string,
  operation: Operation,
  options: QuotaOptions = {},
): Promise<ReserveOutcome> {
  const now = options.now ?? new Date();
  const rpc = options.rpc ?? adminCounterRpc();

  const windowKey = dayWindowKey(now);
  const limit = limitFor(operation);
  const resetsAt = nextResetAtIso(now);

  const used = await rpc.tryIncrement({
    userId,
    operation,
    windowKind: DAY_WINDOW,
    windowKey,
    limit,
  });

  if (used === null) {
    return { outcome: 'at_limit', status: { operation, used: limit, limit, resetsAt } };
  }

  return {
    outcome: 'allowed',
    reservation: {
      [RESERVATION]: true,
      userId,
      operation,
      windowKey,
      used,
      limit,
      resetsAt,
      reservedHere: true,
    },
  };
}

/* ========================================================================== */
/* One reserve per REQUEST, not per service call                               */
/* ========================================================================== */

/**
 * Whose reserve is it.
 *
 * The reserve is taken once per **request**, by whichever service owns that request's operation
 * type. A `ChatService` invocation nested inside a `VoiceService` request must perform **no**
 * reserve of its own: the voice unit already taken covers the answer that request produces, so
 * one voice message must never spend both a voice unit and a chat unit.
 *
 * This union is how that is made hard to get wrong. A service that can run either as the entry
 * point or nested takes a `QuotaContext` and hands it to `reserveForRequest()`; it never calls
 * `reserve()` directly. The nested caller cannot fabricate coverage either — `coveredBy()` needs
 * a `QuotaReservation`, and the branded symbol above means the only source of one is a real
 * reserve. So the failure mode is a type error rather than a farmer charged twice.
 *
 * (`ChatInput.skipQuotaReserve` in `src/lib/schemas.ts` is the boolean form of the same fact.
 * When task 16 builds `ChatService`, map it once at the top of the service —
 * `skipQuotaReserve === true` → `coveredBy(reservation)`, otherwise `ownsRequest(...)` — so the
 * boolean never reaches this module.)
 */
export type QuotaContext =
  | { readonly role: 'owns_request'; readonly userId: string; readonly operation: Operation }
  | { readonly role: 'covered'; readonly reservation: QuotaReservation };

/** This service is the entry point for the request: it takes the reserve. */
export function ownsRequest(userId: string, operation: Operation): QuotaContext {
  return { role: 'owns_request', userId, operation };
}

/**
 * This service was invoked inside a request that has already reserved: it takes nothing.
 *
 * The returned context carries the outer reservation with `reservedHere: false`, which is what
 * makes a nested `refundReservation()` a no-op instead of a stray decrement.
 */
export function coveredBy(reservation: QuotaReservation): QuotaContext {
  return { role: 'covered', reservation: { ...reservation, reservedHere: false } };
}

/**
 * The reserve entry point for any service that might be nested.
 *
 * On a `covered` context this performs **no RPC at all** — not a read, not a write — and returns
 * the inherited reservation. That is the safe path, and it is the default in the sense that
 * matters: a caller that forgets to think about nesting cannot reach `counter_try_increment`
 * without first constructing an `owns_request` context and saying so.
 */
export async function reserveForRequest(
  context: QuotaContext,
  options: QuotaOptions = {},
): Promise<ReserveOutcome> {
  if (context.role === 'covered') {
    return { outcome: 'allowed', reservation: context.reservation };
  }
  return reserve(context.userId, context.operation, options);
}

/* ========================================================================== */
/* refund (step 9)                                                             */
/* ========================================================================== */

export interface RefundOutcome {
  /** `false` when the counter had nothing to give back — see below. */
  readonly refunded: boolean;
  /** The count after the attempt. */
  readonly used: number;
}

/**
 * Give one unit back.
 *
 * =============================================================================
 * ONLY FOR A FAILURE BEFORE THE FIRST PROVIDER CALL WAS ATTEMPTED
 * =============================================================================
 *
 * The design enumerates the whole list, and it is short:
 *
 *  - signed-URL issuance failure,
 *  - an unreadable storage object,
 *  - a knowledge-base read failure,
 *  - an unhandled error thrown ahead of the gateway call.
 *
 * That is all. **Anything at or after the first provider attempt is not refundable** — including
 * a both-providers-failed request and a timeout, which stay spent because they consumed real
 * provider capacity and refunding them would let a failing provider drain the free tier through
 * retries. If you are reaching for this function while holding a provider error, the spend rule
 * says stop: log `quota_spent = true` and return the busy message.
 *
 * A refunded failure writes `quota_spent = false` on its `usage_logs` row, so the audit trail
 * states which of the two happened rather than leaving it to be inferred from a counter.
 *
 * ### Why a double refund is not an error
 *
 * `counter_decrement` carries `and used > 0`, so a second refund matches no row and returns NULL
 * — reported here as `refunded: false`. That guard is what makes the table's `used >= 0` check
 * constraint unreachable: without it, a duplicate refund would raise a constraint violation and
 * turn a harmless retry into a 500. Callers may treat `refunded: false` as "nothing to do".
 *
 * Prefer `refundReservation()` when you hold the reservation: this overload re-derives the window
 * key from the clock, which is wrong for a request that crossed Kolkata midnight.
 */
export async function refund(
  userId: string,
  operation: Operation,
  options: QuotaOptions = {},
): Promise<RefundOutcome> {
  const now = options.now ?? new Date();
  const rpc = options.rpc ?? adminCounterRpc();

  return applyDecrement(rpc, {
    userId,
    operation,
    windowKind: DAY_WINDOW,
    windowKey: dayWindowKey(now),
  });
}

/**
 * Refund the reservation actually taken — same window key, same operation, same farmer.
 *
 * Two guards, both structural rather than advisory:
 *
 *  1. **An inherited reservation refunds nothing** (`reservedHere === false`). The service that
 *     owns the request owns the refund; a nested `ChatService` handing back a `VoiceService`'s
 *     unit would decrement a reservation that is still in use.
 *  2. **The window key comes from the reservation**, so a failure a second after Kolkata midnight
 *     refunds yesterday's row rather than creating a spare unit in today's.
 */
export async function refundReservation(
  reservation: QuotaReservation,
  options: QuotaOptions = {},
): Promise<RefundOutcome> {
  if (!reservation.reservedHere) {
    return { refunded: false, used: reservation.used };
  }

  const rpc = options.rpc ?? adminCounterRpc();
  return applyDecrement(rpc, {
    userId: reservation.userId,
    operation: reservation.operation,
    windowKind: DAY_WINDOW,
    windowKey: reservation.windowKey,
  });
}

async function applyDecrement(rpc: CounterRpc, key: CounterKey): Promise<RefundOutcome> {
  const used = await rpc.decrement(key);
  // NULL means "no row matched", which is either an absent row or one already at zero. Both are
  // "nothing to give back", and both read as zero.
  return used === null ? { refunded: false, used: 0 } : { refunded: true, used };
}

/* ========================================================================== */
/* status (the successful response envelope)                                   */
/* ========================================================================== */

/**
 * Read `used`, `limit`, and `resetsAt` for one farmer and operation.
 *
 * `counter_used` is `stable` and coalesces an absent row to zero, so a farmer's first request of
 * the day reports `used: 0` with no special case. This is a READ: it never increments, which is
 * why it is safe on a GET and why it is not the thing a request spends its unit through.
 *
 * After a successful reserve, prefer `quotaStatusOf(reservation)` — the atomic statement already
 * returned the post-increment count, so a second round trip could only disagree with it.
 */
export async function status(
  userId: string,
  operation: Operation,
  options: QuotaOptions = {},
): Promise<QuotaStatus> {
  const now = options.now ?? new Date();
  const rpc = options.rpc ?? adminCounterRpc();

  const used = await rpc.used({
    userId,
    operation,
    windowKind: DAY_WINDOW,
    windowKey: dayWindowKey(now),
  });

  return { operation, used, limit: limitFor(operation), resetsAt: nextResetAtIso(now) };
}

/** The response envelope's quota block, from the reservation. No I/O. */
export function quotaStatusOf(reservation: QuotaReservation): QuotaStatus {
  return {
    operation: reservation.operation,
    used: reservation.used,
    limit: reservation.limit,
    resetsAt: reservation.resetsAt,
  };
}

/* ========================================================================== */
/* The decline (Requirement 14.3)                                              */
/* ========================================================================== */

/**
 * Build the `QUOTA_EXCEEDED` error for an at-limit outcome.
 *
 * Requirement 14.3 requires the decline to state the limit and the reset time, and the message
 * templates in `src/lib/messages/*` read `{limit}`, `{operation}` and `{resetsAt}`. Filling those
 * here, from the status the check itself produced, is what keeps the sentence and the structured
 * `details` from disagreeing — the failure mode where a farmer is told "all 20 of today's chat
 * requests" against a limit of 50.
 *
 * `operation` travels in `context` rather than `details` because `toEnvelope()` reads it from
 * there for the template, and `errorDetailsSchema` has no operation field.
 *
 * The code is **not retryable** (`ERROR_SPECS`): the request will succeed after `resetsAt`, but a
 * retry button that does nothing for hours is worse than no button.
 */
export function quotaExceededError(status: QuotaStatus): AppError {
  return new AppError('QUOTA_EXCEEDED', {
    details: { limit: status.limit, used: status.used, resetsAt: status.resetsAt },
    context: { operation: status.operation },
  });
}
