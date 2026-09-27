import { describe, expect, it, vi } from 'vitest';

import {
  classifySignal,
  type FailureClassification,
  type ProviderFailure,
} from '@/lib/ai/errors';
import {
  ATTEMPT_BUDGETS,
  attemptPlan,
  chainOrderFor,
  computeDeadline,
  EXHAUSTED_CHAIN_CODE,
  providersFor,
  run,
  SOFT_BUDGET_FRACTION,
  SOFT_BUDGET_MS,
  TERMINAL_RESERVE_MS,
  type Capability,
  type ProviderAdapter,
  type ProviderCall,
  type ProviderId,
} from '@/lib/ai/gateway';
import { JAMEE_MAX_DURATION_SECONDS, PLATFORM_MAX_DURATION_SECONDS } from '@/lib/config/verified';
import { AppError } from '@/lib/errors';
import { GEMINI_FAILURE_CLASSIFICATION } from '@/lib/gemini';
import { GROQ_FAILURE_CLASSIFICATION } from '@/lib/groq';

/**
 * Unit tests for what the gateway can be judged on by itself: the deadline arithmetic, the
 * per-attempt ceilings, the minimum-remaining spend rule, and the chain shape the vision config
 * value produces. Clocks are injected and every adapter is a stub — nothing here reaches a
 * provider, and nothing here needs a platform invocation.
 *
 * The fallback matrix (which failure buckets move to the next member, and the two exhausted-chain
 * shapes) is task 8.5, appended as the last section of this file. What is asserted in the blocks
 * immediately below about the exhausted branch is only the part that belongs to the deadline:
 * whether an unserved request is reported as a timeout or as a provider failure.
 *
 * Requirements: 3.6, 3.7, 14.4, 14.8
 */

const START = 1_800_000_000_000;

/* -------------------------------------------------------------------------- */
/* Stub adapters                                                              */
/* -------------------------------------------------------------------------- */

interface StubOptions {
  id: ProviderId;
  /** Recorded per invocation, so a test can assert what the gateway handed the adapter. */
  calls?: ProviderCall[];
  /** Advance the injected clock by this much when invoked, simulating a slow call. */
  spendMs?: number;
  clock?: { nowMs: number };
  failWith?: unknown;
  failure?: ProviderFailure;
}

function stub(options: StubOptions): ProviderAdapter<string, string> {
  return {
    id: options.id,
    model: `${options.id}-stub`,
    invoke(input: string, call: ProviderCall): Promise<string> {
      options.calls?.push(call);
      if (options.spendMs !== undefined && options.clock !== undefined) {
        options.clock.nowMs += options.spendMs;
      }
      if (options.failWith !== undefined) return Promise.reject(options.failWith);
      return Promise.resolve(`${options.id}:${input}`);
    },
    classifyError: () => options.failure ?? 'OTHER',
  };
}

/** An adapter whose invocation is a test failure: it proves no provider call was issued. */
function tripwire(id: ProviderId): ProviderAdapter<string, string> {
  return {
    id,
    model: `${id}-tripwire`,
    invoke(): Promise<string> {
      throw new Error(
        'a provider attempt was started; the budget guard should have refused it before any spend',
      );
    },
    classifyError: () => 'OTHER',
  };
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the gateway to reject, but it resolved');
}

/* ========================================================================== */
/* The budget constants                                                       */
/* ========================================================================== */

describe('the soft budget', () => {
  it('is 45 s with a 15 s terminal reserve, derived from Jamee’s own 60 s ceiling', () => {
    expect(JAMEE_MAX_DURATION_SECONDS).toBe(60);
    expect(SOFT_BUDGET_FRACTION).toBe(0.75);
    expect(SOFT_BUDGET_MS).toBe(45_000);
    expect(TERMINAL_RESERVE_MS).toBe(15_000);
    expect(SOFT_BUDGET_MS + TERMINAL_RESERVE_MS).toBe(JAMEE_MAX_DURATION_SECONDS * 1000);
  });

  it('is not derived from the platform’s documented 300 s maximum', () => {
    // The same fraction of the platform ceiling would be 225 s. V16 records 300 s only as the
    // hard limit Jamee stays under; PROVIDER_CAPABILITIES.md section 3 forbids the derivation.
    expect(PLATFORM_MAX_DURATION_SECONDS).toBe(300);
    expect(SOFT_BUDGET_MS).not.toBe(SOFT_BUDGET_FRACTION * PLATFORM_MAX_DURATION_SECONDS * 1000);
  });
});

/* ========================================================================== */
/* computeDeadline                                                            */
/* ========================================================================== */

describe('computeDeadline', () => {
  it('falls back to requestStart + 45 s when the platform supplies no deadline', () => {
    expect(computeDeadline({ requestStartMs: START })).toBe(START + 45_000);
  });

  it('keeps the 45 s budget when the platform deadline is the looser bound', () => {
    // A 300 s platform invocation: 300 − 15 = 285 s out, far past the 45 s budget.
    expect(
      computeDeadline({ requestStartMs: START, platformDeadlineMs: START + 300_000 }),
    ).toBe(START + 45_000);
  });

  it('takes the platform deadline minus the terminal reserve when that is tighter', () => {
    expect(computeDeadline({ requestStartMs: START, platformDeadlineMs: START + 50_000 })).toBe(
      START + 35_000,
    );
  });

  it('can return an instant already in the past when the platform deadline is imminent', () => {
    // Under 15 s left: there is no room for a provider call AND the terminal work, so the
    // deadline lands behind `now` and the guard refuses every attempt.
    const deadline = computeDeadline({ requestStartMs: START, platformDeadlineMs: START + 5_000 });
    expect(deadline).toBe(START - 10_000);
    expect(deadline).toBeLessThan(START);
  });
});

/* ========================================================================== */
/* attemptPlan — the ceilings and the minimum-remaining guard                  */
/* ========================================================================== */

describe('attemptPlan', () => {
  const table: ReadonlyArray<[Capability, number, number]> = [
    ['vision-classify', 20_000, 6_000],
    ['text-generate', 15_000, 5_000],
    ['transcribe', 20_000, 8_000],
  ];

  it.each(table)('%s uses a %d ms ceiling and a %d ms minimum', (capability, ceiling, minimum) => {
    expect(ATTEMPT_BUDGETS[capability]).toEqual({
      ceilingMs: ceiling,
      minimumRemainingMs: minimum,
    });

    // Whole budget free: the attempt gets its ceiling, not the budget.
    expect(attemptPlan(capability, START + SOFT_BUDGET_MS, START).timeoutMs).toBe(ceiling);

    // Between the minimum and the ceiling: the attempt gets what is left, which is the half of
    // "one deadline, not a sum of per-call timeouts" that a fallback attempt depends on.
    const partial = attemptPlan(capability, START + minimum + 1_000, START);
    expect(partial.startable).toBe(true);
    expect(partial.timeoutMs).toBe(minimum + 1_000);
  });

  it.each(table)('%s refuses to start below its minimum remaining', (capability, _c, minimum) => {
    expect(attemptPlan(capability, START + minimum, START).startable).toBe(true);
    expect(attemptPlan(capability, START + minimum - 1, START).startable).toBe(false);
  });

  it('reports a negative remaining but never a negative timeout', () => {
    const plan = attemptPlan('vision-classify', START - 5_000, START);
    expect(plan.remainingMs).toBe(-5_000);
    expect(plan.startable).toBe(false);
    expect(plan.timeoutMs).toBe(0);
  });
});

/* ========================================================================== */
/* run — budget behaviour                                                     */
/* ========================================================================== */

describe('run', () => {
  it('hands the adapter a signal and the capped attempt timeout', async () => {
    const calls: ProviderCall[] = [];
    const result = await run(
      'vision-classify',
      { gemini: stub({ id: 'gemini', calls }) },
      'photo',
      { now: () => START },
    );

    expect(result).toEqual({ value: 'gemini:photo', provider: 'gemini', usedFallback: false });
    expect(calls).toHaveLength(1);

    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.timeoutMs).toBe(20_000);
    expect(call.deadlineMs).toBe(START + 45_000);
    expect(call.attempt).toBe(0);
    expect(call.capability).toBe('vision-classify');
    expect(call.signal.aborted).toBe(false);
  });

  it('prefers the platform deadline when it is tighter than the 45 s budget', async () => {
    const calls: ProviderCall[] = [];
    await run('text-generate', { gemini: stub({ id: 'gemini', calls }) }, 'question', {
      now: () => START,
      platformDeadline: () => new Date(START + 30_000),
    });

    const call = calls[0];
    expect(call?.deadlineMs).toBe(START + 15_000);
    // 15 s remain and the ceiling is 15 s, so the attempt gets the remaining budget exactly.
    expect(call?.timeoutMs).toBe(15_000);
  });

  it('starts no attempt and reports a timeout when the remaining budget is below the minimum', async () => {
    const error = await rejection(
      run('vision-classify', { gemini: tripwire('gemini') }, 'photo', {
        now: () => START,
        // 5 s left against a 6 s minimum: the call could not finish, so it is never issued.
        deadlineMs: START + 5_000,
      }),
    );

    expect(error.code).toBe('DIAGNOSIS_TIMEOUT');
    expect(error.status).toBe(504);
    expect(error.retryable).toBe(true);
    expect(error.context?.attempted).toEqual([]);
    expect(error.context?.budgetExhausted).toBe(true);
  });

  it('refuses the fallback attempt when the primary consumed the budget', async () => {
    const clock = { nowMs: START };
    const calls: ProviderCall[] = [];
    const error = await rejection(
      run(
        'vision-classify',
        {
          gemini: stub({
            id: 'gemini',
            calls,
            clock,
            // A full-ceiling attempt that then rate-limits: the classic fallback trigger.
            spendMs: 41_000,
            failWith: new Error('429'),
            failure: 'RATE_LIMIT',
          }),
          groq: tripwire('groq'),
        },
        'photo',
        { now: () => clock.nowMs, requestStartMs: START },
      ),
    );

    // The fallback adds an attempt without adding budget, so it does not run — and because the
    // shared deadline is what refused it, the request is a timeout rather than a provider verdict.
    expect(calls).toHaveLength(1);
    expect(error.code).toBe('DIAGNOSIS_TIMEOUT');
    expect(error.context?.attempted).toEqual(['gemini']);
    expect(error.context?.lastFailure).toBe('RATE_LIMIT');
  });

  it('reports a provider failure rather than a timeout while budget remains', async () => {
    const error = await rejection(
      run(
        'vision-classify',
        {
          gemini: stub({
            id: 'gemini',
            failWith: new Error('413 too large'),
            failure: 'OTHER',
          }),
        },
        'photo',
        { now: () => START },
      ),
    );

    expect(error.code).toBe('PROVIDERS_UNAVAILABLE');
    expect(error.context?.budgetExhausted).toBe(false);
  });

  it('links the caller’s abort into the attempt signal and never re-reads it as a provider signal', async () => {
    const caller = new AbortController();
    caller.abort(new Error('the caller went away'));

    const adapter: ProviderAdapter<string, string> = {
      id: 'gemini',
      model: 'gemini-stub',
      invoke: (_input, call) => Promise.reject(call.signal.reason),
      classifyError: () => {
        throw new Error('classifyError must not be consulted for an abort Jamee raised itself');
      },
    };

    const error = await rejection(
      run('text-generate', { gemini: adapter }, 'question', {
        now: () => START,
        signal: caller.signal,
      }),
    );

    // An abort is Jamee's timer or Jamee's caller talking, not the provider — so it is `OTHER` by
    // construction, and an adapter cannot turn it into a second provider call.
    expect(error.context?.lastFailure).toBe('OTHER');
    expect(error.code).toBe('PROVIDERS_UNAVAILABLE');
  });
});

/* ========================================================================== */
/* Chain shape — the V9 config value                                          */
/* ========================================================================== */

describe('chainOrderFor', () => {
  it('gives vision two members while the preview fallback model is configured', () => {
    expect(chainOrderFor('vision-classify', 'qwen/qwen3.8-27b')).toEqual(['gemini', 'groq']);
  });

  it('gives vision one member when the fallback model is withdrawn', () => {
    expect(chainOrderFor('vision-classify', null)).toEqual(['gemini']);
  });

  it('routes text through both providers and transcription through Groq alone', () => {
    expect(chainOrderFor('text-generate')).toEqual(['groq', 'gemini']);
    expect(chainOrderFor('transcribe')).toEqual(['groq']);
  });
});

describe('providersFor', () => {
  it('drops the vision fallback adapter when the config value is null', () => {
    const adapters = { gemini: stub({ id: 'gemini' }), groq: stub({ id: 'groq' }) };

    expect(providersFor('vision-classify', adapters, 'qwen/qwen3.8-27b').map((a) => a.id)).toEqual([
      'gemini',
      'groq',
    ]);
    expect(providersFor('vision-classify', adapters, null).map((a) => a.id)).toEqual(['gemini']);
  });

  it('skips a provider with no adapter rather than failing', () => {
    expect(providersFor('text-generate', { groq: stub({ id: 'groq' }) }).map((a) => a.id)).toEqual([
      'groq',
    ]);
    expect(providersFor('text-generate', {})).toEqual([]);
  });
});

/* ========================================================================== */
/* ========================================================================== */
/* Task 8.5 — the fallback matrix                                              */
/* ========================================================================== */
/* ========================================================================== */

/**
 * The matrix as named cases: which provider serves which capability, and which failures move to the
 * next member — read off V11's **per-provider** tables rather than off an abstract bucket.
 *
 * Requirements: 3.7 (reaching the duration ceiling returns a timeout naming the diagnosis
 *               operation), 14.4 (a rate-limit or unavailability condition from the primary retries
 *               on the fallback, and nothing else does), 14.8 (a both-provider failure on image
 *               interpretation is one failed operation reporting the busy message)
 * Depends on: V9 (whether the vision chain has a second member), V11 (the two tables)
 *
 * ### What this section adds that the neighbouring suites do not
 *
 * Three files already own pieces of this, and each stops short of the join:
 *
 *  - `src/lib/ai/errors.test.ts` maps a **status onto a bucket** for both V11 tables, including the
 *    two asymmetries (Gemini 408/500 are `OTHER`; Groq 500/502 are `UNAVAILABLE`). It never runs a
 *    chain, so it cannot say what a bucket *costs*.
 *  - `tests/property/gateway.property.test.ts` (Property 21) generates `ProviderFailure` values
 *    directly and asserts the dichotomy and the ordering over any pattern of them. It never starts
 *    from a real provider status, so the tables' asymmetry is invisible to it — a chain wired to the
 *    wrong provider's table would satisfy every one of its runs.
 *  - `src/lib/ai/capabilities.test.ts` asserts which adapters are *registered* per capability, not
 *    what the gateway does with the chain that results.
 *
 * So the subject here is the seam between them: a **real provider rejection**, classified by the
 * **real table of the provider that owns it**, driven through the **real `run()`** — and then the
 * consequence named. That is the level at which "429 falls back, 500 depends on who said it" is a
 * fact about Jamee rather than about a bucket enum.
 */

/* -------------------------------------------------------------------------- */
/* A stub that classifies with a real V11 table                                */
/* -------------------------------------------------------------------------- */

/** The two fields the real adapters read off an SDK rejection before classifying it. */
interface RejectionShape {
  readonly status?: number;
  readonly statusName?: string;
}

function rejectionWith(shape: RejectionShape): RejectionShape & Error {
  return Object.assign(new Error('provider rejected the call'), shape);
}

/**
 * A stub adapter that fails, and classifies its own failure with one of the two **real** V11 tables.
 *
 * The classifier is not hardcoded to a bucket anywhere below. That is the whole point: the fallback
 * decision is made by `classifySignal()` against `GEMINI_FAILURE_CLASSIFICATION` or
 * `GROQ_FAILURE_CLASSIFICATION`, exactly as `gemini.ts` and `groq.ts` make it in production, so
 * narrowing or widening either table moves these expectations.
 */
function failingWithTable(
  id: ProviderId,
  table: FailureClassification,
  shape: RejectionShape,
  attempts?: ProviderId[],
): ProviderAdapter<string, string> {
  return {
    id,
    model: `${id}-v11-stub`,
    invoke(): Promise<string> {
      attempts?.push(id);
      return Promise.reject(rejectionWith(shape));
    },
    classifyError: (error) =>
      classifySignal(
        {
          ...((error as RejectionShape).status === undefined
            ? {}
            : { status: (error as RejectionShape).status as number }),
          ...((error as RejectionShape).statusName === undefined
            ? {}
            : { statusName: (error as RejectionShape).statusName as string }),
        },
        table,
      ),
  };
}

/** A succeeding fallback that records that it ran. */
function servingFallback(
  id: ProviderId,
  attempts?: ProviderId[],
): ProviderAdapter<string, string> {
  return {
    id,
    model: `${id}-serving`,
    invoke(input: string): Promise<string> {
      attempts?.push(id);
      return Promise.resolve(`${id}:${input}`);
    },
    classifyError: () => 'OTHER',
  };
}

/* ========================================================================== */
/* 1. Which failures move to the next member — Gemini's table, as the primary   */
/* ========================================================================== */

/**
 * Gemini is the primary of both fallback-capable chains (`vision-classify`, `text-generate`), so its
 * table is the one that decides whether Jamee spends a second provider call.
 *
 * `[label, rejection, expected bucket, does it fall back]`
 */
const GEMINI_MATRIX: ReadonlyArray<[string, RejectionShape, ProviderFailure, boolean]> = [
  ['429', { status: 429 }, 'RATE_LIMIT', true],
  ['RESOURCE_EXHAUSTED', { statusName: 'RESOURCE_EXHAUSTED' }, 'RATE_LIMIT', true],
  ['503', { status: 503 }, 'UNAVAILABLE', true],
  ['UNAVAILABLE', { statusName: 'UNAVAILABLE' }, 'UNAVAILABLE', true],
  // The two V11 narrowings. Gemini's own documented retry set is 429/408/5xx; Jamee's classifier is
  // deliberately tighter, because widening it changes when Jamee doubles its provider spend.
  ['408', { status: 408 }, 'OTHER', false],
  ['500', { status: 500 }, 'OTHER', false],
  // Nothing recognisable at all — a socket reset, an SDK wrapper with no status. D4's conservative
  // default: stop, rather than spend a second call to learn nothing.
  ['no status', {}, 'OTHER', false],
];

describe('the fallback matrix — a Gemini rejection as the primary', () => {
  it.each(GEMINI_MATRIX)(
    '%s classifies as %s and %s the fallback',
    async (_label, shape, expectedBucket, fallsBack) => {
      // The bucket, first, from the same table the run below uses. Stated so the row reads as a
      // claim about V11 and not only about the outcome.
      expect(classifySignal(shape, GEMINI_FAILURE_CLASSIFICATION)).toBe(expectedBucket);

      const attempts: ProviderId[] = [];
      const chain = {
        gemini: failingWithTable('gemini', GEMINI_FAILURE_CLASSIFICATION, shape, attempts),
        groq: servingFallback('groq', attempts),
      };

      if (fallsBack) {
        const result = await run('vision-classify', chain, 'photo', { now: () => START });

        // Requirement 14.4: the fallback served it, and the answer says so — `usedFallback` is on
        // the `usage_logs` row (14.7), so it is a persisted fact and not a diagnostic convenience.
        expect(result).toEqual({ value: 'groq:photo', provider: 'groq', usedFallback: true });
        expect(attempts).toEqual(['gemini', 'groq']);
        return;
      }

      const error = await rejection(run('vision-classify', chain, 'photo', { now: () => START }));

      // Requirement 14.4 read strictly: an unrecognized error never silently doubles provider spend,
      // so the second member is never invoked at all.
      expect(attempts).toEqual(['gemini']);
      expect(error.code).toBe('PROVIDERS_UNAVAILABLE');
      expect(error.context?.lastFailure).toBe('OTHER');
      expect(error.context?.usedFallback).toBe(false);
    },
  );

  it('uses Gemini when the Groq-first text chain rate-limits', async () => {
    const attempts: ProviderId[] = [];
    const result = await run(
      'text-generate',
      {
        groq: failingWithTable(
          'groq',
          GROQ_FAILURE_CLASSIFICATION,
          { status: 429 },
          attempts,
        ),
        gemini: servingFallback('gemini', attempts),
      },
      'rephrase',
      { now: () => START },
    );

    expect(result.provider).toBe('gemini');
    expect(result.usedFallback).toBe(true);
    expect(attempts).toEqual(['groq', 'gemini']);
  });
});

/* ========================================================================== */
/* 2. The asymmetry: 500 is not one answer                                     */
/* ========================================================================== */

describe('the two V11 tables disagree about 500, and the gateway obeys whichever owns the call', () => {
  it('stops on a Gemini 500 and falls back on a Groq 500', async () => {
    // This is why the tables are per-provider rather than shared, and it is only observable through
    // `run()`: the *identical* rejection produces one provider call or two depending on which
    // adapter classified it. `errors.test.ts` proves the buckets differ; this proves the spend does.
    const rejection500 = { status: 500 } as const;

    const geminiAttempts: ProviderId[] = [];
    const stopped = await rejection(
      run(
        'vision-classify',
        {
          gemini: failingWithTable(
            'gemini',
            GEMINI_FAILURE_CLASSIFICATION,
            rejection500,
            geminiAttempts,
          ),
          groq: servingFallback('groq', geminiAttempts),
        },
        'photo',
        { now: () => START },
      ),
    );

    const groqAttempts: ProviderId[] = [];
    const servedAfterFallback = await run(
      'vision-classify',
      {
        // Same position, same rejection, Groq's table. `[500, 502, 503]` is *Groq's* documented
        // unavailability set, which is exactly the constant `gemini.ts` declines to reuse.
        gemini: failingWithTable('gemini', GROQ_FAILURE_CLASSIFICATION, rejection500, groqAttempts),
        groq: servingFallback('groq', groqAttempts),
      },
      'photo',
      { now: () => START },
    );

    expect(geminiAttempts).toEqual(['gemini']);
    expect(stopped.code).toBe('PROVIDERS_UNAVAILABLE');
    expect(stopped.context?.lastFailure).toBe('OTHER');

    expect(groqAttempts).toEqual(['gemini', 'groq']);
    expect(servedAfterFallback.usedFallback).toBe(true);
  });

  it('keeps Groq 413 and 422 out of the fallback path wherever they land', async () => {
    // 413 is Jamee's own oversized payload and 422 is documented to include model hallucinations, so
    // a second provider fails on the same bytes or has the same content problem. Retrying either
    // spends a call to learn nothing — `PROVIDER_CAPABILITIES.md` section 2 forbids it by name.
    for (const status of [413, 422]) {
      const attempts: ProviderId[] = [];
      const error = await rejection(
        run(
          'vision-classify',
          {
            gemini: failingWithTable(
              'gemini',
              GROQ_FAILURE_CLASSIFICATION,
              { status },
              attempts,
            ),
            groq: servingFallback('groq', attempts),
          },
          'photo',
          { now: () => START },
        ),
      );

      expect(classifySignal({ status }, GROQ_FAILURE_CLASSIFICATION), String(status)).toBe('OTHER');
      expect(attempts, String(status)).toEqual(['gemini']);
      expect(error.code, String(status)).toBe('PROVIDERS_UNAVAILABLE');
    }
  });
});

/* ========================================================================== */
/* 3. Which provider serves which capability, and what an exhausted chain says  */
/* ========================================================================== */

/** `[capability, vision fallback config, chain, exhausted code, HTTP status]` */
const CAPABILITY_MATRIX: ReadonlyArray<
  [Capability, string | null, readonly ProviderId[], string, number]
> = [
  ['vision-classify', 'qwen/qwen3.8-27b', ['gemini', 'groq'], 'PROVIDERS_UNAVAILABLE', 503],
  // V9 records both Groq vision candidates as Preview models that "may be discontinued at short
  // notice", so the one-member shape is an expected configuration rather than a hypothetical.
  ['vision-classify', null, ['gemini'], 'PROVIDERS_UNAVAILABLE', 503],
  ['text-generate', null, ['groq', 'gemini'], 'PROVIDERS_UNAVAILABLE', 503],
  // `transcribe` differs because the requirements make it differ: 8.4 gives a failed transcription
  // its own retryable code. Its chain has no cross-provider member by design — `whisper-large-v3`
  // is a documented alternate on the same host, so a Groq outage takes both out.
  ['transcribe', null, ['groq'], 'TRANSCRIPTION_FAILED', 502],
];

describe('the capability matrix', () => {
  it.each(CAPABILITY_MATRIX)(
    '%s with fallback %s runs %j and reports %s',
    async (capability, visionFallbackModel, expectedChain, expectedCode, expectedStatus) => {
      expect(chainOrderFor(capability, visionFallbackModel)).toEqual(expectedChain);
      expect(EXHAUSTED_CHAIN_CODE[capability]).toBe(expectedCode);

      // Every member fails with a fallback trigger, so the chain is genuinely exhausted rather than
      // stopped early — and the code comes from the table, not from the capability's branch.
      const attempts: ProviderId[] = [];
      const adapters = Object.fromEntries(
        expectedChain.map((id) => [
          id,
          failingWithTable(id, GEMINI_FAILURE_CLASSIFICATION, { status: 503 }, attempts),
        ]),
      );

      const error = await rejection(
        run(capability, adapters, 'input', { now: () => START, visionFallbackModel }),
      );

      expect(error.code).toBe(expectedCode);
      expect(error.status).toBe(expectedStatus);
      expect(error.retryable).toBe(true);
      expect(attempts).toEqual([...expectedChain]);
    },
  );
});

/* ========================================================================== */
/* 4. One exit for every unserved request (Requirement 14.8)                    */
/* ========================================================================== */

describe('the exhausted chain', () => {
  /** A vision run where every configured member fails with `503`, i.e. a fallback trigger. */
  async function exhaust(visionFallbackModel: string | null): Promise<AppError> {
    return rejection(
      run(
        'vision-classify',
        {
          gemini: failingWithTable('gemini', GEMINI_FAILURE_CLASSIFICATION, { status: 503 }),
          groq: failingWithTable('groq', GROQ_FAILURE_CLASSIFICATION, { status: 503 }),
        },
        'photo',
        { now: () => START, visionFallbackModel },
      ),
    );
  }

  it('is indistinguishable to a caller whether the chain had one member or two', async () => {
    const withoutFallback = await exhaust(null);
    const withFailedFallback = await exhaust('qwen/qwen3.8-27b');

    // Requirement 14.8's mechanical form. "No vision fallback configured" and "the vision fallback
    // also failed" leave through the same `throw`, so the farmer-visible facts are identical and a
    // caller has nothing to branch on.
    for (const error of [withoutFallback, withFailedFallback]) {
      expect(error.code).toBe('PROVIDERS_UNAVAILABLE');
      expect(error.status).toBe(503);
      expect(error.retryable).toBe(true);
      expect(error.details).toBeUndefined();
      expect(error.context?.budgetExhausted).toBe(false);
      expect(error.context?.lastFailure).toBe('UNAVAILABLE');
    }
  });

  it('is literally one branch: the same context keys, differing only in the chain it ran', async () => {
    const withoutFallback = await exhaust(null);
    const withFailedFallback = await exhaust('qwen/qwen3.8-27b');

    // The "same branch" half of the claim, which the identical codes above cannot establish on their
    // own — two `throw` statements could produce one code. Identical context *shape* is what shows
    // there is one, and the differing values inside it are the server-side detail an operator needs.
    expect(Object.keys(withoutFallback.context ?? {}).sort()).toStrictEqual(
      Object.keys(withFailedFallback.context ?? {}).sort(),
    );

    expect(withoutFallback.context?.chain).toEqual(['gemini']);
    expect(withoutFallback.context?.attempted).toEqual(['gemini']);
    expect(withoutFallback.context?.usedFallback).toBe(false);

    expect(withFailedFallback.context?.chain).toEqual(['gemini', 'groq']);
    expect(withFailedFallback.context?.attempted).toEqual(['gemini', 'groq']);
    expect(withFailedFallback.context?.usedFallback).toBe(true);
  });

  it('reaches the same exit with no member at all', async () => {
    // A chain that ends up empty because no adapter was constructed takes the same route: chain
    // length is a function of configuration, and every length leaves the same way.
    const error = await rejection(run('vision-classify', {}, 'photo', { now: () => START }));

    expect(error.code).toBe('PROVIDERS_UNAVAILABLE');
    expect(error.context?.chain).toEqual([]);
    expect(error.context?.attempted).toEqual([]);
    expect(error.context?.lastFailure).toBe('none');
  });
});

/* ========================================================================== */
/* 5. The abort deadline surfaces DIAGNOSIS_TIMEOUT (Requirement 3.7)          */
/* ========================================================================== */

/**
 * An adapter that never answers: it settles only when the attempt's own signal aborts, which is
 * Jamee's timer firing at `timeoutMs`.
 *
 * Its `classifyError` says `UNAVAILABLE` — a fallback trigger — and captures the fact that it was
 * consulted. Neither should happen: the gateway records `OTHER` *without* asking, because an abort
 * is Jamee's own deadline talking. An adapter that mapped its SDK's `AbortError` onto `UNAVAILABLE`
 * would otherwise turn a timeout into a second provider call — spend created by running out of time.
 */
function neverAnswers(
  id: ProviderId,
  clock: { nowMs: number },
  seen: { classified: number; abortReason?: unknown },
): ProviderAdapter<string, string> {
  return {
    id,
    model: `${id}-hangs`,
    invoke: (_input, call) =>
      new Promise<string>((_resolve, reject) => {
        call.signal.addEventListener(
          'abort',
          () => {
            // The wall clock really has reached the deadline by the time the abort lands, which is
            // what the timeout branch reads.
            clock.nowMs = call.deadlineMs;
            seen.abortReason = call.signal.reason;
            reject(call.signal.reason);
          },
          { once: true },
        );
      }),
    classifyError: () => {
      seen.classified += 1;
      return 'UNAVAILABLE';
    },
  };
}

describe('an attempt that outlives its share of the budget', () => {
  it('surfaces DIAGNOSIS_TIMEOUT, and spends no second provider call', async () => {
    vi.useFakeTimers();
    try {
      const clock = { nowMs: START };
      const seen = { classified: 0 } as { classified: number; abortReason?: unknown };
      const deadlineMs = START + 6_000;

      // 6 000 ms remaining against a 6 000 ms minimum: the attempt is startable and gets exactly
      // the remaining budget, so the abort timer and the deadline coincide.
      expect(attemptPlan('vision-classify', deadlineMs, START)).toEqual({
        remainingMs: 6_000,
        startable: true,
        timeoutMs: 6_000,
      });

      const pending = rejection(
        run(
          'vision-classify',
          { gemini: neverAnswers('gemini', clock, seen), groq: tripwire('groq') },
          'photo',
          { now: () => clock.nowMs, deadlineMs },
        ),
      );

      await vi.advanceTimersByTimeAsync(6_000);
      const error = await pending;

      // Requirement 3.7: the timeout question is asked first, so a deadline that expired mid-flight
      // is reported as a timeout rather than as a provider verdict.
      expect(error.code).toBe('DIAGNOSIS_TIMEOUT');
      expect(error.status).toBe(504);
      expect(error.retryable).toBe(true);
      expect(error.context?.budgetExhausted).toBe(true);
      expect(error.context?.attempted).toEqual(['gemini']);

      // The abort was Jamee's own timer, and it says so — the reason names the ms share, not the
      // provider. `tripwire('groq')` throws if invoked, so the fallback demonstrably did not run.
      expect((seen.abortReason as Error | undefined)?.message).toContain('6000 ms share');
      expect(error.context?.lastFailure).toBe('OTHER');
      expect(seen.classified).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the attempt timer on a fast success, so nothing keeps the invocation alive', async () => {
    vi.useFakeTimers();
    try {
      const result = await run('text-generate', { gemini: stub({ id: 'gemini' }) }, 'question', {
        now: () => START,
      });

      expect(result.value).toBe('gemini:question');
      // A pending timer per attempt would hold the function open past the answer, which on a metered
      // platform is real cost for no benefit. `dispose()` in the `finally` is what clears it.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
