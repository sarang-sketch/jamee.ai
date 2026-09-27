import 'server-only';

import { getDeadline } from '@vercel/functions';

import {
  isFallbackTrigger,
  retryAfterSecondsOf,
  type ClassifyError,
  type ProviderFailure,
} from '@/lib/ai/errors';
import { JAMEE_MAX_DURATION_SECONDS, VISION_FALLBACK_MODEL } from '@/lib/config/verified';
import { AppError } from '@/lib/errors';
import type { ErrorCode } from '@/lib/schemas';

/**
 * Capability routing, the shared request deadline, and the fallback loop.
 *
 * Requirements: 3.6 (a diagnosis completes inside the duration ceiling), 3.7 (reaching it returns a
 *               timeout error naming the diagnosis operation), 14.4 (a rate-limit or unavailability
 *               condition from the primary retries on the fallback), 14.8 (image interpretation
 *               treats a both-provider failure as a failed operation returning the busy message)
 * Design: "Provider strategy and fallback", "Fallback matrix", "Timeouts"
 * Depends on: V11 (error classification), V16/V17 (the duration ceiling), V18 (`getDeadline()`),
 *             V9 (whether the vision chain has a second member)
 * Authority: `docs/PROVIDER_CAPABILITIES.md` sections 1–3
 *
 * ### WHAT THIS MODULE IS NOT ALLOWED TO KNOW
 *
 * Nothing about agronomy, prompts, the knowledge base, or what a farmer should be told. It returns
 * raw provider output, the provider that produced it, and whether that was the fallback; every
 * interpretation of that output happens above it (D2's two-stage validation) and every farmer-facing
 * sentence comes from the message catalogs. That is why `run()` is generic over both the input and
 * the output type and never inspects either: a gateway that could read a classification result
 * would eventually be asked to retry on a bad one, which is exactly the spend D4 forbids.
 *
 * ### ONE DEADLINE PER REQUEST, NOT A SUM OF PER-CALL TIMEOUTS
 *
 * A fallback adds an attempt without adding budget. If the primary vision call burns its full 20 s
 * ceiling and then returns 429, the fallback gets what remains — not a fresh 20 s. Summing
 * per-call timeouts would over-commit the request by exactly the fallback attempt, so there is one
 * absolute deadline instant and every attempt is measured against it.
 *
 * ### THE MINIMUM-REMAINING GUARD IS A SPEND RULE
 *
 * The gateway does not start an attempt it cannot finish. Starting one would issue a real provider
 * call whose result arrives after the deadline and is discarded — real cost, zero value — and on a
 * rate-limited provider it consumes an allowance the next farmer needs. Below the minimum, the
 * request goes straight to the timeout branch without spending anything.
 */

/* ========================================================================== */
/* Capabilities and providers                                                  */
/* ========================================================================== */

export type Capability = 'vision-classify' | 'text-generate' | 'transcribe';

export const CAPABILITIES: readonly Capability[] = [
  'vision-classify',
  'text-generate',
  'transcribe',
];

export type ProviderId = 'gemini' | 'groq';

/**
 * What a caller gets back: the provider's own output, which provider produced it, and whether that
 * was a fallback.
 *
 * `usedFallback` is not a diagnostic convenience — Requirement 14.7 puts it on the `usage_logs` row,
 * and `docs/PROVIDER_CAPABILITIES.md` section 1 notes it is one of only two columns that
 * distinguish "diagnosis quality dropped" from "Gemini is rate-limiting us" after the fact.
 */
export interface GatewayResult<T> {
  value: T;
  provider: ProviderId;
  usedFallback: boolean;
}

/* ========================================================================== */
/* The adapter interface (implemented by tasks 8.2, 8.3, 18.1)                 */
/* ========================================================================== */

/**
 * The per-attempt envelope handed to an adapter.
 *
 * **`signal` is not optional to honour.** V11 records that Google's official SDKs retry transient
 * errors internally — the Python SDK up to four attempts with a 60 s ceiling, which is larger than
 * Jamee's entire per-request budget. A single `interactions.create()` can therefore consume the
 * whole budget inside its own retry loop and return one aggregate failure. Passing this signal into
 * the provider call is what lets the shared deadline cut that loop mid-flight; an adapter that drops
 * it re-opens exactly the hole the deadline exists to close.
 */
export interface ProviderCall {
  /** Aborts at `min(per-attempt ceiling, remaining budget)`, or when the caller's signal aborts. */
  readonly signal: AbortSignal;
  /** Milliseconds this attempt has. Already capped by the ceiling and by the shared deadline. */
  readonly timeoutMs: number;
  /** The shared deadline, as epoch ms. For an adapter that bounds its own internal retries. */
  readonly deadlineMs: number;
  readonly capability: Capability;
  /** 0-based position in the chain. 0 is the primary. */
  readonly attempt: number;
}

/**
 * One provider serving one capability.
 *
 * Generic over input and output so the gateway stays content-blind: `TInput` is whatever that
 * capability's adapters agree to take (a signed image URL and a prompt, an audio reference), and
 * `TOutput` is whatever they return. Both are opaque here.
 */
export interface ProviderAdapter<TInput, TOutput> {
  readonly id: ProviderId;
  /** The resolved model identifier, for logging and for the fallback-model config read. */
  readonly model: string;
  invoke(input: TInput, call: ProviderCall): Promise<TOutput>;
  classifyError: ClassifyError;
}

/**
 * The adapters a caller has constructed, keyed by provider.
 *
 * A set rather than a list because chain *order* is this module's decision (it encodes the fallback
 * matrix) while chain *membership* depends on which adapters exist. An absent key is not an error:
 * `providersFor()` skips it, and a chain that ends up empty reaches the same exhausted branch as a
 * chain whose members all failed.
 */
export type AdapterSet<TInput, TOutput> = Partial<
  Record<ProviderId, ProviderAdapter<TInput, TOutput>>
>;

/* ========================================================================== */
/* The chains (docs/PROVIDER_CAPABILITIES.md section 1)                        */
/* ========================================================================== */

const GEMINI_THEN_GROQ: readonly ProviderId[] = ['gemini', 'groq'];
const GROQ_THEN_GEMINI: readonly ProviderId[] = ['groq', 'gemini'];
const GEMINI_ONLY: readonly ProviderId[] = ['gemini'];
const GROQ_ONLY: readonly ProviderId[] = ['groq'];

/**
 * The provider order for a capability.
 *
 * Image classification keeps Gemini's schema-enforced vision path first and the optional Groq
 * vision model second. Text generation — including website chat and the answer half of voice —
 * uses Groq first and Gemini second. Transcription remains Groq-only because Gemini transcription
 * is not implemented in this release.
 */
export function chainOrderFor(
  capability: Capability,
  visionFallbackModel: string | null = VISION_FALLBACK_MODEL,
): readonly ProviderId[] {
  switch (capability) {
    case 'vision-classify':
      return visionFallbackModel === null ? GEMINI_ONLY : GEMINI_THEN_GROQ;
    case 'text-generate':
      return GROQ_THEN_GEMINI;
    case 'transcribe':
      return GROQ_ONLY;
  }
}

/**
 * The ordered chain for a capability, built from the adapters that exist.
 *
 * Skipping an absent adapter rather than throwing keeps one property true: chain length is a
 * function of configuration, and every length — two, one, zero — leaves through the same exit in
 * `run()`.
 */
export function providersFor<TInput, TOutput>(
  capability: Capability,
  adapters: AdapterSet<TInput, TOutput>,
  visionFallbackModel: string | null = VISION_FALLBACK_MODEL,
): readonly ProviderAdapter<TInput, TOutput>[] {
  const chain: ProviderAdapter<TInput, TOutput>[] = [];
  for (const id of chainOrderFor(capability, visionFallbackModel)) {
    const adapter = adapters[id];
    if (adapter !== undefined) chain.push(adapter);
  }
  return chain;
}

/**
 * The code an exhausted chain raises, per capability.
 *
 * A table rather than a conditional, so `run()` keeps **one** `throw` for every unserved request.
 * That is the mechanical form of Requirement 14.8: the vision rows resolve to the same code whether
 * the chain had one member or two, so a caller cannot tell the two situations apart.
 *
 * `transcribe` differs because the requirements make it differ, not because the branch does:
 * Requirement 8.4 gives a failed transcription its own retryable code, and the empty-transcript
 * case is a third thing again (`TRANSCRIPT_EMPTY`, Requirement 8.7) that this module never sees —
 * an empty transcript is a successful provider call.
 */
export const EXHAUSTED_CHAIN_CODE: Record<Capability, ErrorCode> = {
  'vision-classify': 'PROVIDERS_UNAVAILABLE',
  'text-generate': 'PROVIDERS_UNAVAILABLE',
  transcribe: 'TRANSCRIPTION_FAILED',
};

/* ========================================================================== */
/* The budget (docs/PROVIDER_CAPABILITIES.md section 3)                        */
/* ========================================================================== */

/**
 * The soft budget as a fraction of Jamee's own declared ceiling.
 *
 * ```
 * soft budget      = 0.75 × 60 s = 45 s
 * terminal reserve = 60 s − 45 s = 15 s
 * ```
 *
 * **The multiplicand is `JAMEE_MAX_DURATION_SECONDS` (60), never the platform's documented 300.**
 * V16 records 300 s as the plan maximum and `config/verified.ts` keeps it as a ceiling Jamee stays
 * under, not as an input: 0.75 × 300 s would be a 225 s budget — a wait no farmer would sit through,
 * and one that would let a hung provider call occupy a function for nearly four minutes.
 * `docs/PROVIDER_CAPABILITIES.md` section 3 carries an explicit blockquote forbidding that
 * derivation. Raising `maxDuration` moves both numbers here and touches no call site, which is the
 * point of expressing the budget as a fraction.
 */
export const SOFT_BUDGET_FRACTION = 0.75;

/** 45 000 ms. */
export const SOFT_BUDGET_MS = SOFT_BUDGET_FRACTION * JAMEE_MAX_DURATION_SECONDS * 1000;

/**
 * 15 000 ms, and not slack.
 *
 * It is the work the request still has to do *after* the budget expires, inside the same invocation:
 * build and localize the error envelope, write the `usage_logs` row with `outcome = 'timeout'`, mark
 * the inbound-idempotency row on the Telegram path, and send the farmer a message. V16 records that
 * `SIGTERM` grants only ~500 ms of cleanup, so none of that can be deferred to shutdown.
 */
export const TERMINAL_RESERVE_MS = JAMEE_MAX_DURATION_SECONDS * 1000 - SOFT_BUDGET_MS;

export interface AttemptBudget {
  /** The most one attempt may take, even with the whole budget free. */
  readonly ceilingMs: number;
  /** Below this much remaining, no attempt starts — see the spend rule at the top of this file. */
  readonly minimumRemainingMs: number;
}

/**
 * Per-attempt ceilings and minimum-remaining guards, from `PROVIDER_CAPABILITIES.md` section 3.
 *
 *  - `vision-classify` — 20 s / 6 s. Largest payload, and V6 records that Gemini 3.x has thinking
 *    enabled by default, which raises latency.
 *  - `text-generate` — 15 s / 5 s. Short prompt, bounded output tokens (V7 `max_output_tokens`).
 *  - `transcribe` — 20 s / 8 s. The audio upload to the provider dominates.
 */
export const ATTEMPT_BUDGETS: Record<Capability, AttemptBudget> = {
  'vision-classify': { ceilingMs: 20_000, minimumRemainingMs: 6_000 },
  'text-generate': { ceilingMs: 15_000, minimumRemainingMs: 5_000 },
  transcribe: { ceilingMs: 20_000, minimumRemainingMs: 8_000 },
};

export interface DeadlineInput {
  /** Epoch ms at which the request began. */
  requestStartMs: number;
  /** Epoch ms from `getDeadline()`, when the platform supplied one. */
  platformDeadlineMs?: number;
}

/**
 * The one absolute deadline for a request, as epoch ms.
 *
 * ```
 * deadline = min( platformDeadline − 15 s , requestStart + 45 s )
 * ```
 *
 * V18 confirms `getDeadline()` from `@vercel/functions` returns the shared invocation deadline, and
 * it is the preferred source because it reflects what the platform will actually enforce rather than
 * what the codebase believes. The 45 s arithmetic is the fallback for when it is absent — local
 * development, a unit test, a non-Vercel host — and stating both makes the figure reviewable without
 * a running invocation.
 *
 * `min` rather than a preference order: whichever bound is tighter is the one that will actually be
 * enforced, and taking the looser one would mean planning past a limit that exists.
 */
export function computeDeadline(input: DeadlineInput): number {
  const budgetDeadline = input.requestStartMs + SOFT_BUDGET_MS;
  const platform = input.platformDeadlineMs;
  if (platform === undefined) return budgetDeadline;
  return Math.min(platform - TERMINAL_RESERVE_MS, budgetDeadline);
}

export interface AttemptWindow {
  /** Milliseconds left before the shared deadline. Negative once it has passed. */
  readonly remainingMs: number;
  /** Whether the spend rule permits starting this attempt. */
  readonly startable: boolean;
  /** What the attempt would get: the remaining budget, capped by the per-attempt ceiling. */
  readonly timeoutMs: number;
}

/**
 * The minimum-remaining guard and the per-attempt cap, as one pure function.
 *
 * Separate from `run()` so the arithmetic is testable against an injected clock without a provider,
 * and so a service that needs to know whether a second model call still fits (task 11.2's rephrase
 * step) asks the same function the gateway asks rather than reimplementing the comparison.
 */
export function attemptPlan(
  capability: Capability,
  deadlineMs: number,
  nowMs: number,
): AttemptWindow {
  const budget = ATTEMPT_BUDGETS[capability];
  const remainingMs = deadlineMs - nowMs;
  return {
    remainingMs,
    startable: remainingMs >= budget.minimumRemainingMs,
    timeoutMs: Math.min(Math.max(remainingMs, 0), budget.ceilingMs),
  };
}

/* ========================================================================== */
/* The abort scope                                                             */
/* ========================================================================== */

interface AttemptAbort {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * An abort signal for one attempt: fires at `timeoutMs`, or immediately when the caller's own
 * signal aborts.
 *
 * Built from an `AbortController` and a timer rather than `AbortSignal.any([...])` so the timer can
 * be cleared the moment the attempt settles — a pending timer per attempt would keep the invocation
 * alive past a fast success, which on a metered platform is a real cost for no benefit.
 */
function attemptAbort(timeoutMs: number, parent: AbortSignal | undefined): AttemptAbort {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`jamee: provider attempt exceeded its ${timeoutMs} ms share of the request budget`),
    );
  }, timeoutMs);

  const onParentAbort = (): void => {
    clearTimeout(timer);
    controller.abort(parent?.reason);
  };

  if (parent !== undefined) {
    if (parent.aborted) onParentAbort();
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose(): void {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/* ========================================================================== */
/* run()                                                                       */
/* ========================================================================== */

export interface RunOptions {
  /** Injected clock, epoch ms. Defaults to `Date.now`. */
  now?: () => number;
  /** Source of the platform deadline. Defaults to V18's `getDeadline()`. */
  platformDeadline?: () => Date | undefined;
  /** Epoch ms the request began. Defaults to the first clock read. */
  requestStartMs?: number;
  /**
   * A deadline already computed for this request. Set by a service that makes several gateway
   * calls in one request — the rephrase after a classify (task 11.2) — because those two calls
   * share one budget rather than getting one each.
   */
  deadlineMs?: number;
  /** The caller's own abort, linked into every attempt signal. */
  signal?: AbortSignal;
  /** Same injection seam as `providersFor`'s third parameter. Defaults to the config value. */
  visionFallbackModel?: string | null;
}

/**
 * Run a capability against its chain: first member that answers wins, and the answer says who.
 *
 * The loop is the design's, unchanged in shape:
 *
 *  1. **Budget check before spend.** An attempt that cannot finish is never started.
 *  2. **Invoke with a deadline-derived signal.** The adapter must pass it to the provider.
 *  3. **Classify a failure and decide.** `RATE_LIMIT` or `UNAVAILABLE` moves to the next member;
 *     `OTHER` breaks immediately, which is Requirement 14.4 read strictly and D4 read literally.
 *  4. **One exit for every unserved request.** See the throw at the bottom.
 *
 * ### An abort is never re-read as a provider signal
 *
 * When the attempt's own signal aborted, the failure is Jamee's timer talking, not the provider, so
 * the gateway records `OTHER` *without* consulting `classifyError()`. Otherwise an adapter that
 * mapped its SDK's `AbortError` onto `UNAVAILABLE` would turn Jamee's own deadline into a second
 * provider call — spend created by a timeout, which is the opposite of what the deadline is for.
 *
 * ### Timeout versus exhausted chain
 *
 * The timeout question is asked first, so a deadline that expired mid-flight surfaces as
 * `DIAGNOSIS_TIMEOUT` (Requirement 3.7) rather than as a provider verdict. `starved` is the
 * "never started an attempt" half of the same condition. Everything else is the chain having been
 * genuinely exhausted, and takes the capability's code from `EXHAUSTED_CHAIN_CODE`.
 *
 * `DIAGNOSIS_TIMEOUT` is the taxonomy's only timeout code and its message names the diagnosis
 * operation, so a non-diagnosis caller that wants different wording translates it — the gateway does
 * not invent a code, and Requirement 3.7's path gets the code it specifies.
 */
export async function run<TInput, TOutput>(
  capability: Capability,
  adapters: AdapterSet<TInput, TOutput>,
  input: TInput,
  options: RunOptions = {},
): Promise<GatewayResult<TOutput>> {
  const now = options.now ?? Date.now;
  const requestStartMs = options.requestStartMs ?? now();
  const deadlineMs =
    options.deadlineMs ??
    computeDeadline({ requestStartMs, ...platformDeadlineInput(options.platformDeadline) });

  const chain = providersFor(capability, adapters, options.visionFallbackModel);

  let starved = false;
  let lastFailure: ProviderFailure | undefined;
  let lastError: unknown;
  let retryAfterSeconds: number | undefined;
  const attempted: ProviderId[] = [];

  for (const [index, provider] of chain.entries()) {
    const plan = attemptPlan(capability, deadlineMs, now());
    if (!plan.startable) {
      starved = true;
      break;
    }

    const scope = attemptAbort(plan.timeoutMs, options.signal);
    attempted.push(provider.id);
    try {
      const value = await provider.invoke(input, {
        signal: scope.signal,
        timeoutMs: plan.timeoutMs,
        deadlineMs,
        capability,
        attempt: index,
      });
      return { value, provider: provider.id, usedFallback: index > 0 };
    } catch (error) {
      lastError = error;
      lastFailure = scope.signal.aborted ? 'OTHER' : provider.classifyError(error);
      retryAfterSeconds = retryAfterSecondsOf(error) ?? retryAfterSeconds;
      if (!isFallbackTrigger(lastFailure)) break;
    } finally {
      scope.dispose();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The single exit. Every unserved request leaves here, whatever the chain
  // length was — which is what makes "no vision fallback configured" and
  // "vision fallback also failed" indistinguishable to callers (Requirement
  // 14.8). The code is data; the branch is one.
  // ───────────────────────────────────────────────────────────────────────────
  const timedOut = starved || now() >= deadlineMs;
  throw new AppError(timedOut ? 'DIAGNOSIS_TIMEOUT' : EXHAUSTED_CHAIN_CODE[capability], {
    cause: lastError,
    context: {
      capability,
      chain: chain.map((provider) => provider.id),
      attempted,
      usedFallback: attempted.length > 1,
      lastFailure: lastFailure ?? 'none',
      budgetExhausted: timedOut,
      // Logged, never waited on and never sent outward — see `retryAfterSecondsOf()`.
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  });
}

/**
 * Read the platform deadline, tolerating its absence.
 *
 * `getDeadline()` returns `undefined` outside a platform invocation (V18), and a `Date` it cannot
 * parse is treated the same way: an unusable deadline must fall back to the 45 s arithmetic rather
 * than produce `NaN`, which would compare false against everything and disable the guard entirely.
 */
function platformDeadlineInput(
  source: (() => Date | undefined) | undefined,
): { platformDeadlineMs?: number } {
  const at = (source ?? getDeadline)();
  if (at === undefined) return {};
  const ms = at.getTime();
  return Number.isFinite(ms) ? { platformDeadlineMs: ms } : {};
}
