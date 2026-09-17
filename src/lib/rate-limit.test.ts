import { describe, expect, it } from 'vitest';

import { BURST_QUOTAS } from '@/lib/config/verified';
import { ERROR_SPECS, isAppError } from '@/lib/errors';
import {
  BURST_PRUNE_OLDER_THAN_MINUTES,
  burstLimitFor,
  burstLimiter,
  checkBurst,
  checkBurstForRequest,
  noBurstCheck,
  pruneMinuteWindows,
  secondsToNextWindow,
  type MinutePruneClient,
} from '@/lib/rate-limit';
import type { Operation } from '@/lib/schemas';
import { minuteWindowKey } from '@/lib/time';
import { coveredBy, ownsRequest, reserve, type CounterRpc } from '@/services/quota.service';

/**
 * Unit tests for `src/lib/rate-limit.ts`, with the counter functions stubbed at the seam
 * `quota.service.ts` declares.
 *
 * Requirements: 13.8 (per-farmer request rate limiting on the diagnosis, chat and voice endpoints)
 * Design: "Rate limiting versus daily quota"; "Quota enforcement" → step 5 of the ordered sequence
 *
 * ### What these tests can and cannot decide
 *
 * They decide **which row is written, with which ceiling, and what is NOT written**: the window kind,
 * the minute key, the per-operation limit, the refusal's code, and — the load-bearing one — that a
 * refused request leaves the `'day'` row untouched. That is Requirement 13.8's whole content, and
 * every assertion here is about arguments and absence rather than about a stub's return value.
 *
 * They do not decide counter atomicity (task 10.2, against a real Postgres) or the prune's SQL
 * (migration 0007 owns the age predicate and the "never touch a day row" rule). A stub asserting its
 * own delete would be a test of the stub.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const FARMER = '11111111-1111-4111-8111-111111111111';
const OTHER_FARMER = '22222222-2222-4222-8222-222222222222';

/** 2026-09-15T19:30:12Z is 2026-09-16T01:00 in Asia/Kolkata — the far side of the +05:30 offset. */
const NOW = new Date('2026-09-15T19:30:12.000Z');
/** The same minute, later in it: the window key must not move. */
const NOW_LATER_SAME_MINUTE = new Date('2026-09-15T19:30:59.000Z');
/** The next minute: a new key, and therefore a fresh allowance. */
const NEXT_MINUTE = new Date('2026-09-15T19:31:00.000Z');

interface RecordedIncrement {
  readonly userId: string;
  readonly operation: Operation;
  readonly windowKind: string;
  readonly windowKey: string;
  readonly limit: number;
}

interface CounterStub {
  readonly rpc: CounterRpc;
  readonly increments: readonly RecordedIncrement[];
  readonly decrements: number;
  readonly reads: number;
  /** Increments recorded for one window kind — how "the daily row was never touched" is asserted. */
  forKind(windowKind: string): readonly RecordedIncrement[];
}

/**
 * An in-memory `counters` table keyed exactly as migration 0007 keys it, applying
 * `counter_try_increment`'s `used < limit` guard and its NULL-at-limit signal.
 *
 * Keyed by all four columns, `window_kind` included, because the whole point of the burst limiter is
 * that its rows are *different rows* from the daily quota's. A stub that collapsed them could not
 * observe the property these tests exist for.
 */
function counterStub(seed: Readonly<Record<string, number>> = {}): CounterStub {
  const rows = new Map<string, number>(Object.entries(seed));
  const increments: RecordedIncrement[] = [];
  let decrements = 0;
  let reads = 0;

  const keyOf = (args: {
    userId: string;
    operation: Operation;
    windowKind: string;
    windowKey: string;
  }): string => `${args.userId}::${args.operation}::${args.windowKind}::${args.windowKey}`;

  return {
    increments,
    get decrements() {
      return decrements;
    },
    get reads() {
      return reads;
    },
    forKind(windowKind) {
      return increments.filter((entry) => entry.windowKind === windowKind);
    },
    rpc: {
      tryIncrement: (args) => {
        increments.push({
          userId: args.userId,
          operation: args.operation,
          windowKind: args.windowKind,
          windowKey: args.windowKey,
          limit: args.limit,
        });
        const key = keyOf(args);
        const used = rows.get(key) ?? 0;
        if (used >= args.limit) return Promise.resolve(null);
        rows.set(key, used + 1);
        return Promise.resolve(used + 1);
      },
      decrement: (args) => {
        decrements += 1;
        const key = keyOf(args);
        const used = rows.get(key) ?? 0;
        if (used === 0) return Promise.resolve(null);
        rows.set(key, used - 1);
        return Promise.resolve(used - 1);
      },
      used: (args) => {
        reads += 1;
        return Promise.resolve(rows.get(keyOf(args)) ?? 0);
      },
    },
  };
}

/** Fails the test if the counter is reached at all — how "no RPC was made" is asserted. */
const unreachableCounter: CounterRpc = {
  tryIncrement: () => {
    throw new Error('counter_try_increment was called; this path must take no slot');
  },
  decrement: () => {
    throw new Error('counter_decrement was called; a burst window is never refunded');
  },
  used: () => {
    throw new Error('counter_used was called; the burst check needs no read');
  },
};

interface PruneStub {
  readonly client: MinutePruneClient;
  readonly calls: ({ p_older_than_minutes?: number } | undefined)[];
}

function pruneStub(options: { deleted?: number; error?: unknown } = {}): PruneStub {
  const calls: ({ p_older_than_minutes?: number } | undefined)[] = [];
  return {
    calls,
    client: {
      rpc: (_fn, args) => {
        calls.push(args);
        return Promise.resolve({
          data: options.error === undefined ? (options.deleted ?? 0) : null,
          error: options.error ?? null,
        });
      },
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return { code: error.code, status: error.status };
    throw error;
  }
  throw new Error('expected the call to reject with an AppError');
}

/* ========================================================================== */
/* The ceiling                                                                 */
/* ========================================================================== */

describe('burstLimitFor', () => {
  it('reads the per-operation ceiling from config/verified.ts and copies nothing', () => {
    /**
     * The numbers are asserted against `BURST_QUOTAS` rather than against literals. A test with its
     * own 3 / 10 / 3 would keep passing after the product number changed, which is the one thing a
     * test of a single-declaration rule must not do.
     */
    expect(burstLimitFor('image')).toBe(BURST_QUOTAS.image);
    expect(burstLimitFor('chat')).toBe(BURST_QUOTAS.chat);
    expect(burstLimitFor('voice')).toBe(BURST_QUOTAS.voice);
  });

  it('sets the burst ceiling independently of the daily quota', () => {
    /**
     * Design: *"its own per-operation ceiling … set independently of the daily quota"*. A burst
     * allowance at or above the daily limit would make the minute row unreachable and Requirement
     * 13.8 a no-op, so the relationship is asserted rather than assumed.
     */
    for (const operation of ['image', 'chat', 'voice'] as const) {
      expect(burstLimitFor(operation)).toBeGreaterThan(0);
      expect(burstLimitFor(operation)).toBeLessThan(20);
    }
  });
});

/* ========================================================================== */
/* The check — Requirement 13.8                                                */
/* ========================================================================== */

describe('checkBurst', () => {
  it('takes one minute slot per request, against the operation ceiling', async () => {
    const counter = counterStub();

    await checkBurst(FARMER, 'image', { rpc: counter.rpc, now: NOW });

    expect(counter.increments).toEqual([
      {
        userId: FARMER,
        operation: 'image',
        windowKind: 'minute',
        windowKey: minuteWindowKey(NOW),
        limit: BURST_QUOTAS.image,
      },
    ]);
  });

  it('allows the whole allowance and refuses the request after it', async () => {
    const counter = counterStub();
    const limit = BURST_QUOTAS.image;

    for (let i = 0; i < limit; i += 1) {
      await expect(
        checkBurst(FARMER, 'image', { rpc: counter.rpc, now: NOW }),
      ).resolves.toBeUndefined();
    }

    const refused = await refusal(checkBurst(FARMER, 'image', { rpc: counter.rpc, now: NOW }));

    // 429, and **retryable** — unlike QUOTA_EXCEEDED, this one clears within the minute.
    expect(refused).toEqual({ code: 'RATE_LIMITED', status: 429 });
    expect(ERROR_SPECS.RATE_LIMITED.retryable).toBe(true);
  });

  it('never refunds and never reads: a refused window is not a spend to hand back', async () => {
    const counter = counterStub();
    const limit = BURST_QUOTAS.voice;

    for (let i = 0; i < limit; i += 1) {
      await checkBurst(FARMER, 'voice', { rpc: counter.rpc, now: NOW });
    }
    await refusal(checkBurst(FARMER, 'voice', { rpc: counter.rpc, now: NOW }));

    expect(counter.decrements).toBe(0);
    expect(counter.reads).toBe(0);
  });

  it('keys the window by the minute, so the next minute starts fresh', async () => {
    const counter = counterStub();
    const limit = BURST_QUOTAS.voice;

    for (let i = 0; i < limit; i += 1) {
      await checkBurst(FARMER, 'voice', { rpc: counter.rpc, now: NOW });
    }
    // Same minute, 47 seconds later: still refused.
    await refusal(checkBurst(FARMER, 'voice', { rpc: counter.rpc, now: NOW_LATER_SAME_MINUTE }));

    // A new key, and therefore a new row that starts at zero. Nothing resets on a schedule.
    await expect(
      checkBurst(FARMER, 'voice', { rpc: counter.rpc, now: NEXT_MINUTE }),
    ).resolves.toBeUndefined();

    expect(minuteWindowKey(NOW)).toBe(minuteWindowKey(NOW_LATER_SAME_MINUTE));
    expect(minuteWindowKey(NEXT_MINUTE)).not.toBe(minuteWindowKey(NOW));
  });

  it('counts each operation and each farmer separately', async () => {
    const counter = counterStub();

    // `image` exhausted for one farmer …
    for (let i = 0; i < BURST_QUOTAS.image; i += 1) {
      await checkBurst(FARMER, 'image', { rpc: counter.rpc, now: NOW });
    }
    await refusal(checkBurst(FARMER, 'image', { rpc: counter.rpc, now: NOW }));

    // … leaves their chat allowance, and everyone else's image allowance, untouched.
    await expect(
      checkBurst(FARMER, 'chat', { rpc: counter.rpc, now: NOW }),
    ).resolves.toBeUndefined();
    await expect(
      checkBurst(OTHER_FARMER, 'image', { rpc: counter.rpc, now: NOW }),
    ).resolves.toBeUndefined();
  });

  it('states how long to wait, and only that', async () => {
    const counter = counterStub();
    for (let i = 0; i < BURST_QUOTAS.image; i += 1) {
      await checkBurst(FARMER, 'image', { rpc: counter.rpc, now: NOW });
    }

    try {
      await checkBurst(FARMER, 'image', { rpc: counter.rpc, now: NOW });
      throw new Error('expected a refusal');
    } catch (error) {
      if (!isAppError(error)) throw error;

      // Actionable: `errorResponse()` renders this as the `retry-after` header. NOW is at :12, so
      // the next window opens in 48 s.
      expect(error.details).toEqual({ retryAfterSeconds: 48 });

      // The ceiling is a server-side fact. A `limit` here would read beside the farmer's daily
      // allowance as if it were the same number.
      expect(error.details?.limit).toBeUndefined();
      expect(error.context).toMatchObject({ operation: 'image', limit: BURST_QUOTAS.image });
    }
  });

  it('never reports zero seconds to wait', () => {
    // A `retryAfterSeconds: 0` would say "retry now" on the one request that must not be retried now.
    expect(secondsToNextWindow(new Date('2026-09-15T19:30:00.000Z'))).toBe(60);
    expect(secondsToNextWindow(new Date('2026-09-15T19:30:59.000Z'))).toBe(1);
    expect(secondsToNextWindow(new Date('2026-09-15T19:30:59.999Z'))).toBe(1);
  });
});

/* ========================================================================== */
/* The ordering claim — a refusal never reaches the daily counter               */
/* ========================================================================== */

describe('the burst check precedes any daily spend', () => {
  it('writes only minute rows: the daily counter is never touched by the limiter', async () => {
    /**
     * The structural half of Property 28 (task 24.5). The two controls share a table, so the
     * assertion that matters is about the `window_kind` column: every row this module writes is a
     * `'minute'` row, refusals included, which is why a rate-limited request cannot have spent a
     * daily unit no matter where the check is called from.
     */
    const counter = counterStub();
    const limiter = burstLimiter({ rpc: counter.rpc, now: () => NOW, prune: null });

    for (let i = 0; i < BURST_QUOTAS.chat; i += 1) {
      await limiter(FARMER, 'chat');
    }
    await refusal(limiter(FARMER, 'chat'));

    expect(counter.forKind('minute')).toHaveLength(BURST_QUOTAS.chat + 1);
    expect(counter.forKind('day')).toEqual([]);
  });

  it('leaves the daily row at zero when the burst ceiling refuses first', async () => {
    /**
     * The same claim from the other side, against the real `reserve()`: the sequence a service runs
     * is burst → reserve, and the reserve is never reached. `counter.forKind('day')` being empty is
     * "the daily counter was not incremented", and it is observable only because the stub records
     * the window kind of every call.
     */
    const counter = counterStub();
    const limiter = burstLimiter({ rpc: counter.rpc, now: () => NOW, prune: null });

    for (let i = 0; i < BURST_QUOTAS.voice; i += 1) {
      await limiter(FARMER, 'voice');
    }

    let reserveWasReached = false;
    const refused = await refusal(
      (async () => {
        await limiter(FARMER, 'voice');
        reserveWasReached = true;
        return reserve(FARMER, 'voice', { rpc: counter.rpc, now: NOW });
      })(),
    );

    expect(refused.code).toBe('RATE_LIMITED');
    expect(reserveWasReached).toBe(false);
    expect(counter.forKind('day')).toEqual([]);
  });
});

/* ========================================================================== */
/* Nesting — the coverage argument, not a second flag                          */
/* ========================================================================== */

describe('checkBurstForRequest', () => {
  it('checks when the request enters here', async () => {
    const seen: { userId: string; operation: Operation }[] = [];

    await checkBurstForRequest(ownsRequest(FARMER, 'chat'), async (userId, operation) => {
      seen.push({ userId, operation });
    });

    expect(seen).toEqual([{ userId: FARMER, operation: 'chat' }]);
  });

  it('performs NO check at all when the request is covered by an outer reservation', async () => {
    /**
     * Requirement 14.1's nesting rule, applied to Requirement 13.8: a chat answer produced inside a
     * voice request was burst-checked by the voice endpoint. Checking again would refuse a farmer for
     * a request they made once — and with a `voice` ceiling of 3 against a `chat` ceiling of 10, it
     * would also charge them an allowance they never spent.
     *
     * The coverage is minted by a real `reserve()` because a `QuotaReservation` is branded: there is
     * no way to fabricate one, which is exactly why the burst check reuses this context instead of a
     * boolean of its own.
     */
    const counter = counterStub();
    const outer = await reserve(FARMER, 'voice', { rpc: counter.rpc, now: NOW });
    if (outer.outcome !== 'allowed') throw new Error('fixture: the outer reserve must succeed');

    // The REAL limiter, over a counter that throws on contact: "no RPC at all", not "no refusal".
    const limiter = burstLimiter({ rpc: unreachableCounter, now: () => NOW, prune: null });

    await expect(
      checkBurstForRequest(coveredBy(outer.reservation), limiter),
    ).resolves.toBeUndefined();

    // The outer voice reserve is the only counter write in the whole request.
    expect(counter.increments).toHaveLength(1);
    expect(counter.forKind('minute')).toEqual([]);
  });
});

describe('noBurstCheck', () => {
  it('is the no-op default, and reaches no counter', async () => {
    await expect(noBurstCheck(FARMER, 'chat')).resolves.toBeUndefined();
    // Reading it is the point: constructing a service without a limiter must open no connection.
    await expect(
      checkBurstForRequest(ownsRequest(FARMER, 'chat'), noBurstCheck),
    ).resolves.toBeUndefined();
  });
});

/* ========================================================================== */
/* The prune                                                                   */
/* ========================================================================== */

describe('pruneMinuteWindows', () => {
  it('calls the migration 0007 function with the age cutoff and reports the row count', async () => {
    const prune = pruneStub({ deleted: 7 });

    await expect(pruneMinuteWindows({ client: prune.client })).resolves.toBe(7);
    expect(prune.calls).toEqual([{ p_older_than_minutes: BURST_PRUNE_OLDER_THAN_MINUTES }]);
  });

  it('reports a failure as an internal error rather than as zero rows', async () => {
    const prune = pruneStub({ error: { message: 'connection reset' } });

    const failed = await refusal(pruneMinuteWindows({ client: prune.client }));
    expect(failed).toEqual({ code: 'INTERNAL_ERROR', status: 500 });
  });
});

describe('burstLimiter — the periodic prune', () => {
  it('prunes once per interval, after the check, and never more than once per window', async () => {
    const counter = counterStub();
    let nowMs = NOW.getTime();
    let pruned = 0;

    const limiter = burstLimiter({
      rpc: counter.rpc,
      now: () => new Date(nowMs),
      pruneEveryMs: 60_000,
      prune: () => {
        pruned += 1;
        return Promise.resolve(0);
      },
    });

    await limiter(FARMER, 'chat');
    expect(pruned).toBe(1); // A fresh process is due immediately — see the module header.

    await limiter(FARMER, 'chat');
    nowMs += 59_000;
    await limiter(FARMER, 'chat');
    expect(pruned).toBe(1); // Inside the interval: no second prune.

    nowMs += 2_000;
    await limiter(FARMER, 'chat');
    expect(pruned).toBe(2);
  });

  it('does not prune on a refused request', async () => {
    const counter = counterStub();
    let pruned = 0;

    const limiter = burstLimiter({
      rpc: counter.rpc,
      now: () => NOW,
      pruneEveryMs: 0,
      prune: () => {
        pruned += 1;
        return Promise.resolve(0);
      },
    });

    for (let i = 0; i < BURST_QUOTAS.image; i += 1) {
      await limiter(FARMER, 'image');
    }
    const prunesBefore = pruned;

    await refusal(limiter(FARMER, 'image'));

    // A farmer in a retry loop must not be able to drive housekeeping.
    expect(pruned).toBe(prunesBefore);
  });

  it('never fails a request because housekeeping failed', async () => {
    const counter = counterStub();
    const limiter = burstLimiter({
      rpc: counter.rpc,
      now: () => NOW,
      prune: () => Promise.reject(new Error('prune exploded')),
    });

    // The answer matters; reclaiming rows nobody is waiting on does not.
    await expect(limiter(FARMER, 'chat')).resolves.toBeUndefined();
    expect(counter.forKind('minute')).toHaveLength(1);
  });

  it('reads no environment and builds no client when both seams are injected', async () => {
    /**
     * `prune: null` is how a caller opts out of the piggyback — the shape a cron-driven sweep would
     * use. With the counter injected too, the whole path is reachable without
     * `SUPABASE_SERVICE_ROLE_KEY`, which is what this test proves by not throwing: CI runs with no
     * Supabase variables set, so a `createAdminClient()` anywhere in here would fail the run.
     */
    const counter = counterStub();
    const limiter = burstLimiter({ rpc: counter.rpc, now: () => NOW, prune: null });

    await expect(limiter(FARMER, 'chat')).resolves.toBeUndefined();
    expect(counter.forKind('minute')).toHaveLength(1);
  });
});
