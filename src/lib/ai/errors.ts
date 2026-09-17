import { RETRY_AFTER_HEADER } from '@/lib/config/verified';

/**
 * The provider-failure vocabulary, and the one seam every adapter implements to speak it.
 *
 * Requirements: 14.4 (a rate-limit or unavailability condition from the primary is what causes a
 *               retry on the fallback — and nothing else does), 14.8 (image interpretation treats
 *               a both-provider failure as a failed operation)
 * Design: "Provider strategy and fallback"; D4 — *"adapters expose a single `classifyError()` seam
 *         with a conservative default of `OTHER` (no fallback, fail fast) so an unrecognized error
 *         never silently doubles provider spend."*
 * Depends on: V11 (`docs/PROVIDER_CAPABILITIES.md` section 2 is the resolved table)
 *
 * ### THIS FILE CLASSIFIES TRANSPORT, NOT CONTENT
 *
 * Three buckets, and the boundary between them is a spend decision rather than a taxonomy
 * preference. `RATE_LIMIT` and `UNAVAILABLE` mean *the provider did not answer*, so asking a
 * second provider can produce the answer the first one owed. `OTHER` means anything else,
 * including a malformed answer and a content refusal — those already have a path in Jamee, and it
 * is not the fallback path: D2's two-stage validation collapses them into the single inconclusive
 * shape with no second model call (Requirement 6.6). Widening the first two buckets changes when
 * Jamee doubles its provider spend, which is why the sets live in `config/verified.ts` behind V11
 * rather than in an adapter someone can adjust in passing.
 *
 * ### WHY NO MESSAGE TEXT REACHES A CLASSIFIER
 *
 * `ProviderErrorSignal` has a status, a status name and a retry-after — and deliberately no
 * message field. Message text is not part of any provider's documented contract, so a classifier
 * that reads it is one provider copy-edit away from silently changing when Jamee falls back. The
 * type is the enforcement: `classifySignal()` structurally cannot match on prose, in the same way
 * `toEnvelope()` in `src/lib/errors.ts` structurally cannot leak a cause.
 *
 * ### WHAT THIS FILE DOES NOT CONTAIN
 *
 * No per-provider table. Extracting a status out of a Groq SDK rejection is a different job from
 * extracting one out of a `@google/genai` rejection, and both belong with the adapter that owns
 * the client (tasks 8.2, 8.3). What lives here is the vocabulary, the conservative default, and
 * the table-driven matcher those adapters share, so neither of them re-derives "which statuses
 * mean the provider is down".
 *
 * Per V11, an adapter's table must be exactly:
 *  - **Groq** — rate limit `[429]`, unavailable `[500, 502, 503]`. 413 and 422 are absent on
 *    purpose: 413 is Jamee's own oversized payload, and 422 is documented to include model
 *    hallucinations, so both are `OTHER` and neither may trigger a fallback.
 *  - **Gemini** — rate limit `[429]` / `RESOURCE_EXHAUSTED`, unavailable `[503]` / `UNAVAILABLE`.
 *    Narrower than Groq's on purpose: Gemini 408 and 500 are `OTHER` here even though V11 records
 *    Gemini's own documented retry set as 429/408/5xx.
 */

/* ========================================================================== */
/* The vocabulary                                                              */
/* ========================================================================== */

export type ProviderFailure = 'RATE_LIMIT' | 'UNAVAILABLE' | 'OTHER';

/** Every bucket, for tests that need to enumerate them. Order is not significant. */
export const PROVIDER_FAILURES: readonly ProviderFailure[] = [
  'RATE_LIMIT',
  'UNAVAILABLE',
  'OTHER',
];

/**
 * Whether a failure lets the gateway try the next chain member.
 *
 * Requirement 14.4's narrowness lives in this function and nowhere else, so the fallback policy is
 * one thing to read rather than a condition repeated at each call site. Written as an exhaustive
 * switch rather than an array lookup: adding a fourth bucket then fails to compile here, which is
 * the right place to be forced to decide whether it doubles provider spend.
 */
export function isFallbackTrigger(failure: ProviderFailure): boolean {
  switch (failure) {
    case 'RATE_LIMIT':
    case 'UNAVAILABLE':
      return true;
    case 'OTHER':
      return false;
  }
}

/* ========================================================================== */
/* The classification seam                                                     */
/* ========================================================================== */

/**
 * What an adapter reads off a provider rejection before classifying it: a numeric HTTP status, a
 * documented status *name*, and the retry-after the provider volunteered. Every field is optional
 * because a thrown non-HTTP error (a socket reset, an abort) carries none of them — and that case
 * must land on `OTHER`.
 */
export interface ProviderErrorSignal {
  /** HTTP status, when the rejection carried one. */
  status?: number;
  /** Documented status name, e.g. Gemini's `RESOURCE_EXHAUSTED` (V11). Never a message. */
  statusName?: string;
  /** Seconds, from `retry-after`. Groq sets it only on a 429; Gemini documents none (U-V11). */
  retryAfterSeconds?: number;
}

/**
 * One provider's V11 table. Supplied by the adapter, consumed by `classifySignal()`.
 *
 * Both status lists and both name lists are required — an empty array is how a provider that
 * signals nothing in that dimension is expressed, and that reads as a decision rather than an
 * omission.
 */
export interface FailureClassification {
  readonly rateLimitStatuses: readonly number[];
  readonly unavailableStatuses: readonly number[];
  readonly rateLimitStatusNames: readonly string[];
  readonly unavailableStatusNames: readonly string[];
}

/**
 * The contract each adapter implements, and the only thing the gateway calls.
 *
 * `unknown` rather than a provider error type on purpose: the adapter is the only code that knows
 * what its SDK rejects with, and the gateway hands back exactly what it caught.
 */
export type ClassifyError = (error: unknown) => ProviderFailure;

/**
 * Map a signal onto a bucket against one provider's table, defaulting to `OTHER`.
 *
 * Status *names* are consulted before numeric statuses because they are the more specific signal
 * where a provider publishes both (V11: Gemini's `429 RESOURCE_EXHAUSTED`, `503 UNAVAILABLE`).
 * Where they disagree — a documented name in neither list alongside a status in one — the status
 * still decides, so an SDK that surfaces an unfamiliar name does not silently downgrade a real 429.
 *
 * Anything unmatched is `OTHER`. That default is the whole conservatism of D4: an unrecognized
 * error stops the chain instead of spending a second provider call to learn nothing.
 */
export function classifySignal(
  signal: ProviderErrorSignal,
  table: FailureClassification,
): ProviderFailure {
  const { status, statusName } = signal;

  if (statusName !== undefined) {
    if (table.rateLimitStatusNames.includes(statusName)) return 'RATE_LIMIT';
    if (table.unavailableStatusNames.includes(statusName)) return 'UNAVAILABLE';
  }
  if (status !== undefined) {
    if (table.rateLimitStatuses.includes(status)) return 'RATE_LIMIT';
    if (table.unavailableStatuses.includes(status)) return 'UNAVAILABLE';
  }
  return 'OTHER';
}

/* ========================================================================== */
/* The shared provider error                                                   */
/* ========================================================================== */

export interface ProviderErrorInit {
  failure: ProviderFailure;
  status?: number;
  statusName?: string;
  /** Seconds. Advisory — see `retryAfterSecondsOf()` for what the gateway does with it. */
  retryAfterSeconds?: number;
  /** The SDK rejection this was normalized from. Server log only. */
  cause?: unknown;
}

/**
 * A provider rejection, normalized.
 *
 * Adapters may throw this instead of re-throwing an SDK error, which lets the classification
 * happen once — at the point where the SDK's shape is known — rather than twice. The gateway does
 * not require it: it calls `classifyError()` on whatever it caught, and an adapter that wraps
 * simply reads `failure` back off its own error.
 *
 * **`message` is built from the status and the status name only**, never from the provider's own
 * message text. Requirement 15.6 keeps provider payload fragments out of farmer-facing responses,
 * and `toEnvelope()` already guarantees that structurally; this keeps them out of Jamee's *logs*
 * too, where a payload echo is a slower and quieter leak. The untouched SDK error is still
 * available as `cause` for an operator who needs it.
 */
export class ProviderError extends Error {
  readonly failure: ProviderFailure;
  readonly status: number | undefined;
  readonly statusName: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(init: ProviderErrorInit) {
    const parts = [
      init.status === undefined ? undefined : `HTTP ${init.status}`,
      init.statusName,
    ].filter((part): part is string => part !== undefined);
    super(
      parts.length === 0
        ? `provider failure ${init.failure}`
        : `provider failure ${init.failure} (${parts.join(' ')})`,
    );
    this.name = 'ProviderError';
    this.failure = init.failure;
    this.status = init.status;
    this.statusName = init.statusName;
    this.retryAfterSeconds = init.retryAfterSeconds;
    if (init.cause !== undefined) this.cause = init.cause;
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/**
 * The retry-after a rejection volunteered, in seconds, or `undefined`.
 *
 * **The gateway logs this; it never sleeps on it.** Two reasons, both about the shared budget. A
 * chain member that remains is a *different* provider, so its availability has nothing to do with
 * the first one's reset instant — waiting would spend the request's budget to learn nothing. And
 * when no member remains there is nothing to wait for: V11 records Groq's reset windows in
 * seconds-to-minutes, which is longer than the 45 s budget in the first place. So the value goes
 * into the server-side context of the raised `AppError`, where an operator watching a rate-limit
 * episode can see it, and no farmer waits on it.
 */
export function retryAfterSecondsOf(error: unknown): number | undefined {
  return isProviderError(error) ? error.retryAfterSeconds : undefined;
}

/* ========================================================================== */
/* retry-after                                                                 */
/* ========================================================================== */

/** The one header method both providers' SDK responses expose. Structural, so neither is imported. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Parse a `retry-after` value into whole seconds, or `undefined` when it is not a usable number.
 *
 * **V11: Groq's `retry-after` is in SECONDS**, and it is set only on a 429. The HTTP-date form
 * that the header also permits is deliberately not parsed: no provider Jamee talks to documents
 * sending one, and a mis-parsed date would produce a wildly wrong number rather than an absent
 * one. Absent is the honest answer to a value this function does not recognise.
 */
export function parseRetryAfterSeconds(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.ceil(seconds);
}

/** `parseRetryAfterSeconds` applied to the V11-recorded header name. */
export function retryAfterFromHeaders(headers: HeaderReader): number | undefined {
  return parseRetryAfterSeconds(headers.get(RETRY_AFTER_HEADER));
}
