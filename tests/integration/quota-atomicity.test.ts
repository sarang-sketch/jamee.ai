import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Operation } from '@/lib/schemas';
import { dayWindowKey, nextResetAtIso } from '@/lib/time';
import {
  adminCounterRpc,
  limitFor,
  refund,
  reserve,
  status,
  type CounterRpc,
  type QuotaOptions,
  type ReserveOutcome,
} from '@/services/quota.service';
import type { CounterRow } from '@/types/database';

import { serviceRoleClient, type TestClient } from './clients';
import { TEST_DATABASE_URL_VAR, describeIntegration } from './database';
import { startHarness, type Harness } from './harness';

/**
 * Quota atomicity, against the real `counter_try_increment` and `counter_decrement`.
 *
 * Requirements: 14.1 (20 image / 50 chat / 20 voice per Quota_Window), 14.2 (the Web_App and
 *               WhatsApp channels count against ONE shared per-Farmer limit per operation)
 * Design: "Quota enforcement — a dedicated counter table, not counted usage_logs rows"; D10
 * Migration: `0007_counters_and_quota_fn.sql` — the primary key IS the concurrency control
 *
 * =============================================================================
 * THIS IS THE CLAIM NO UNIT TEST IN THIS REPOSITORY MAKES
 * =============================================================================
 *
 * Every quota unit test stubs `CounterRpc` with a JavaScript object, and every one of those stubs
 * increments a number in a closure with no `await` between the read and the write. That models
 * atomicity by construction: JavaScript's event loop cannot interleave two synchronous statements,
 * so a stub is atomic whether or not the SQL is. The stubs are right to be written that way — a
 * service test should not also be a Postgres test — but it means **nothing anywhere else in this
 * repository has ever exercised the property `0007` was written for**.
 *
 * The property is specific. `counter_try_increment` is one statement:
 *
 * ```sql
 * insert into public.counters (...) values (..., 1)
 * on conflict (user_id, operation, window_kind, window_key) do update
 *   set used = public.counters.used + 1
 *   where public.counters.used < p_limit
 * returning used;
 * ```
 *
 * Postgres locks the conflicting row for the duration of the statement, so a second concurrent
 * caller evaluates `used < p_limit` against the **first caller's** post-increment value rather than
 * the value it read a moment earlier. A `count(*)`-then-`insert` under read committed would let two
 * callers at `used = 19` both observe 19 and both pass. That difference is only observable with real
 * connections racing on a real row, which is what every test below arranges.
 *
 * =============================================================================
 * HOW "CONCURRENT" IS ARRANGED, AND WHY IT IS GENUINE
 * =============================================================================
 *
 * `Promise.all` over N calls to the counter RPC issues N PostgREST requests without awaiting each
 * other, and PostgREST serves them from its connection pool — so the statements arrive on different
 * backends and really do contend for the row lock. This is not `Promise.all` over an in-memory map,
 * where the concurrency is a formality.
 *
 * Two consequences worth stating rather than discovering:
 *
 *  - **The assertions are on the multiset of returned counts, not just the total.** "Exactly L were
 *    granted" would still pass if two callers both received `7`; requiring the granted counts to be
 *    exactly `1..L` is what rules out a lost update.
 *  - **A window key is never today's.** Each test derives its own key from a distinct instant far in
 *    the past through the application's own `dayWindowKey()`, so tests cannot collide with each
 *    other and none of them depends on what time it is in Kolkata when the suite runs.
 */

/* ========================================================================== */
/* Window keys                                                                 */
/* ========================================================================== */

/**
 * A distinct instant per test, so each test owns its `counters` row outright.
 *
 * January 1970 rather than a mocked clock: the key is derived by the real `dayWindowKey()`, so the
 * value in the column is a real `YYYY-MM-DD` Asia/Kolkata day key and not a sentinel the column's
 * shape would never otherwise hold. Noon UTC is well inside the same Kolkata day, so the mapping
 * from `day` to key is unambiguous.
 */
function windowInstant(day: number): Date {
  return new Date(Date.UTC(1970, 0, day, 12, 0, 0));
}

/** Every operation Requirement 14.1 sets a number for. */
const OPERATIONS: readonly Operation[] = ['image', 'chat', 'voice'];

/** How many callers race past the limit in the per-operation sweep. */
const OVERSHOOT = 4;

describeIntegration(`quota atomicity (requires ${TEST_DATABASE_URL_VAR})`, () => {
  let harness: Harness;
  let rpc: CounterRpc;
  /** The RPC seam the service functions are given. No second admin client, no environment read. */
  let quota: QuotaOptions;
  /**
   * A second service-role client, so a test can put two reserves on genuinely different clients.
   *
   * Requirement 14.2 is about two *channels* sharing one limit, and the channels differ in which
   * credential they hold: the web route uses the farmer's session for its rows and the service role
   * for the counter, while the webhook has only the service role. Neither passes a channel to the
   * counter — there is no parameter for one — so what is actually worth asserting is that two
   * independent clients land on one row. Two clients is how that is arranged honestly.
   */
  let secondAdmin: TestClient;

  beforeAll(async () => {
    harness = await startHarness();
    if (harness.quota.rpc === undefined) {
      throw new Error('the harness did not bind a counter RPC, so there is nothing to test here');
    }
    rpc = harness.quota.rpc;
    quota = { rpc };
    secondAdmin = serviceRoleClient(harness.config);
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  /* ====================================================================== */
  /* Helpers that read the row rather than the response                      */
  /* ====================================================================== */

  /** Every `counters` row for one farmer, operation and day key. Should always be zero or one. */
  async function counterRows(
    operation: Operation,
    windowKey: string,
    userId: string = harness.farmerA.id,
  ): Promise<readonly CounterRow[]> {
    const { data, error } = await harness.admin
      .from('counters')
      .select('*')
      .eq('user_id', userId)
      .eq('operation', operation)
      .eq('window_kind', 'day')
      .eq('window_key', windowKey);

    expect(error).toBeNull();
    return data ?? [];
  }

  /** `1..count`, the granted sequence a race must produce exactly once each. */
  function countingUpTo(count: number): number[] {
    return Array.from({ length: count }, (_, index) => index + 1);
  }

  /** The `used` values the allowed outcomes came back with, ascending. */
  function grantedCounts(outcomes: readonly ReserveOutcome[]): number[] {
    const counts: number[] = [];
    for (const outcome of outcomes) {
      if (outcome.outcome === 'allowed') counts.push(outcome.reservation.used);
    }
    return counts.sort((left, right) => left - right);
  }

  /** `counter_used` for one farmer, operation and day key. */
  function unitsUsed(operation: Operation, windowKey: string): Promise<number> {
    return rpc.used({ userId: harness.farmerA.id, operation, windowKind: 'day', windowKey });
  }

  /* ====================================================================== */
  /* The boundary race                                                      */
  /* ====================================================================== */

  describe('concurrent reserves at the limit boundary (Requirement 14.1)', () => {
    it('grants exactly the limit when half again as many callers race from zero', async () => {
      const now = windowInstant(3);
      const windowKey = dayWindowKey(now);
      const limit = limitFor('image');
      const callers = limit + Math.ceil(limit / 2);

      // The real service function, not the RPC directly: `reserve()` is what every route calls, and
      // its at-limit branch exists because the SQL returns NULL. Driving it here means the branch is
      // taken by a real NULL from a real contended statement rather than by a stub returning one.
      const outcomes = await Promise.all(
        Array.from({ length: callers }, () =>
          reserve(harness.farmerA.id, 'image', { ...quota, now }),
        ),
      );

      const allowed = outcomes.filter((outcome) => outcome.outcome === 'allowed');
      const declined = outcomes.filter((outcome) => outcome.outcome === 'at_limit');

      expect(allowed).toHaveLength(limit);
      expect(declined).toHaveLength(callers - limit);

      // No reservation lost and none granted twice: the counts are 1..limit, each exactly once. A
      // read-then-write under read committed would produce a repeat here and a total below the limit.
      expect(grantedCounts(outcomes)).toEqual(countingUpTo(limit));

      // Requirement 14.3's decline carries the limit and the reset time, from the same values the
      // check used.
      for (const outcome of declined) {
        if (outcome.outcome !== 'at_limit') continue;
        expect(outcome.status.limit).toBe(limit);
        expect(outcome.status.used).toBe(limit);
        expect(outcome.status.resetsAt).toBe(nextResetAtIso(now));
      }

      // The row itself, which is the source of truth (D10) — not the responses that reported it.
      const rows = await counterRows('image', windowKey);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.used).toBe(limit);
      expect(await unitsUsed('image', windowKey)).toBe(limit);
    });

    it('grants exactly one unit when callers race at used = limit - 1', async () => {
      const now = windowInstant(4);
      const windowKey = dayWindowKey(now);
      const limit = limitFor('image');
      const key = {
        userId: harness.farmerA.id,
        operation: 'image' as const,
        windowKind: 'day' as const,
        windowKey,
      };

      // Fill to one below the limit. Concurrently, because that is also a race and it should be a
      // boring one: every one of these is below the limit, so all of them must be granted.
      const filling = await Promise.all(
        Array.from({ length: limit - 1 }, () => rpc.tryIncrement({ ...key, limit })),
      );
      expect(filling.filter((used) => used === null)).toEqual([]);
      expect([...filling].sort((left, right) => (left ?? 0) - (right ?? 0))).toEqual(
        countingUpTo(limit - 1),
      );

      // The interesting race: `0007`'s own worked example, with the last unit contested.
      const contested = await Promise.all(
        Array.from({ length: 8 }, () => rpc.tryIncrement({ ...key, limit })),
      );

      const granted = contested.filter((used): used is number => used !== null);
      expect(granted).toEqual([limit]);
      expect(contested.filter((used) => used === null)).toHaveLength(7);
      expect(await rpc.used(key)).toBe(limit);
    });

    /**
     * Requirement 14.1's three numbers, each against its own contended row.
     *
     * One test per operation rather than one loop inside one test, so each gets its own timeout and a
     * failure names the operation that failed. `chat` fires the most requests of any test in this
     * file (its limit is 50); that is the cost of asserting the number the requirement states rather
     * than a smaller one that would only assert the mechanism.
     */
    OPERATIONS.forEach((operation, index) => {
      it(`holds ${operation} to its own limit of ${limitFor(operation)} under contention`, async () => {
        const now = windowInstant(10 + index);
        const windowKey = dayWindowKey(now);
        const limit = limitFor(operation);

        const outcomes = await Promise.all(
          Array.from({ length: limit + OVERSHOOT }, () =>
            reserve(harness.farmerA.id, operation, { ...quota, now }),
          ),
        );

        expect(grantedCounts(outcomes)).toEqual(countingUpTo(limit));
        expect(
          outcomes.filter((outcome) => outcome.outcome === 'at_limit'),
        ).toHaveLength(OVERSHOOT);

        const rows = await counterRows(operation, windowKey);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.used).toBe(limit);

        // The read path agrees with the row, and reports the same limit the reserve enforced.
        const reported = await status(harness.farmerA.id, operation, { ...quota, now });
        expect(reported).toEqual({
          operation,
          used: limit,
          limit,
          resetsAt: nextResetAtIso(now),
        });
      });
    });
  });

  /* ====================================================================== */
  /* The refund floor                                                       */
  /* ====================================================================== */

  describe('counter_decrement never drives used below zero', () => {
    it('leaves used at zero when concurrent refunds outnumber the reserve', async () => {
      const now = windowInstant(5);
      const windowKey = dayWindowKey(now);
      const key = {
        userId: harness.farmerA.id,
        operation: 'voice' as const,
        windowKind: 'day' as const,
        windowKey,
      };

      const taken = await reserve(harness.farmerA.id, 'voice', { ...quota, now });
      expect(taken.outcome).toBe('allowed');

      // Six refunds for one unit. `and used > 0` in the SQL is what makes this a no-op rather than a
      // constraint violation: without it the second decrement would attempt `used = -1`, the
      // `used >= 0` check would raise, `adminCounterRpc` would throw, and this `Promise.all` would
      // reject. So "no rejection" is itself part of the assertion.
      const refunds = await Promise.all(
        Array.from({ length: 6 }, () => refund(harness.farmerA.id, 'voice', { ...quota, now })),
      );

      expect(refunds.filter((outcome) => outcome.refunded)).toHaveLength(1);
      expect(refunds.filter((outcome) => !outcome.refunded)).toHaveLength(5);
      for (const outcome of refunds) expect(outcome.used).toBe(0);

      expect(await rpc.used(key)).toBe(0);
      const rows = await counterRows('voice', windowKey);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.used).toBe(0);
    });

    it('walks a filled window back to zero and then stops, under contention', async () => {
      const now = windowInstant(6);
      const windowKey = dayWindowKey(now);
      const key = {
        userId: harness.farmerA.id,
        operation: 'chat' as const,
        windowKind: 'day' as const,
        windowKey,
      };
      /**
       * A parameterized limit rather than `limitFor('chat')`, deliberately.
       *
       * The claim under test belongs to `counter_decrement`, which takes no limit at all, and
       * `counter_try_increment` reads the limit from its argument — so filling to five is filling a
       * window, and doing it with 5 requests instead of 50 keeps the test about the floor rather than
       * about the ceiling. Requirement 14.1's actual numbers are asserted above.
       */
      const filled = 5;

      const reserves = await Promise.all(
        Array.from({ length: filled }, () => rpc.tryIncrement({ ...key, limit: filled })),
      );
      expect([...reserves].sort((left, right) => (left ?? 0) - (right ?? 0))).toEqual(
        countingUpTo(filled),
      );

      // Twice as many refunds as there are units, all at once.
      const refunds = await Promise.all(
        Array.from({ length: filled * 2 }, () => rpc.decrement(key)),
      );

      const applied = refunds.filter((used): used is number => used !== null);
      // Every applied refund returned a distinct remaining count, counting down to zero — the same
      // no-lost-update property as the reserve, in the other direction.
      expect([...applied].sort((left, right) => left - right)).toEqual(
        countingUpTo(filled).map((count) => count - 1),
      );
      expect(refunds.filter((used) => used === null)).toHaveLength(filled);

      expect(await rpc.used(key)).toBe(0);
      expect((await counterRows('chat', windowKey))[0]?.used).toBe(0);
    });
  });

  /* ====================================================================== */
  /* A new window key                                                       */
  /* ====================================================================== */

  describe('a new window key starts at zero without any reset job', () => {
    it('reads zero on an untouched key, and writes no row to say so', async () => {
      const windowKey = dayWindowKey(windowInstant(7));
      const key = {
        userId: harness.farmerA.id,
        operation: 'image' as const,
        windowKind: 'day' as const,
        windowKey,
      };

      // `coalesce(..., 0)` in `counter_used` is what makes a farmer's first request of the day need
      // no special case anywhere above the SQL.
      expect(await rpc.used(key)).toBe(0);
      // And the read is a read: it did not create the row it reported on.
      expect(await counterRows('image', windowKey)).toEqual([]);
    });

    it('grants a full allowance on the next Kolkata day while the previous day stays refused', async () => {
      // 18:29 UTC is 23:59 in Kolkata; one minute later is the next Kolkata day. The two keys come
      // from the application's own derivation, so this is the real midnight rollover and not a
      // hand-written pair of strings.
      const lastMinute = new Date(Date.UTC(1970, 0, 20, 18, 29, 0));
      const firstMinute = new Date(Date.UTC(1970, 0, 20, 18, 31, 0));
      const closingKey = dayWindowKey(lastMinute);
      const openingKey = dayWindowKey(firstMinute);
      expect(openingKey).not.toBe(closingKey);

      const closing = {
        userId: harness.farmerA.id,
        operation: 'voice' as const,
        windowKind: 'day' as const,
        windowKey: closingKey,
      };
      const opening = { ...closing, windowKey: openingKey };

      // Fill the closing window to a limit of one, so it is genuinely at its ceiling.
      expect(await rpc.tryIncrement({ ...closing, limit: 1 })).toBe(1);
      expect(await rpc.tryIncrement({ ...closing, limit: 1 })).toBeNull();

      // Nothing ran in between. No cron, no reset job, no midnight sweep — the key changed, and a key
      // with no row starts at zero.
      expect(await rpc.used(opening)).toBe(0);
      expect(await rpc.tryIncrement({ ...opening, limit: 1 })).toBe(1);

      // Two rows now, one per window, and the closed one still holds its count. That is what makes
      // the rollover an *absence* of machinery rather than a job that could fail.
      expect((await counterRows('voice', closingKey))[0]?.used).toBe(1);
      expect((await counterRows('voice', openingKey))[0]?.used).toBe(1);
      expect(await rpc.used(closing)).toBe(1);
    });
  });

  /* ====================================================================== */
  /* One row, one limit, two channels                                       */
  /* ====================================================================== */

  describe('one shared per-farmer limit (Requirement 14.2)', () => {
    it('lands reserves from two independent clients on the same counter row', async () => {
      const now = windowInstant(8);
      const windowKey = dayWindowKey(now);
      const perClient = 3;

      // Half through the harness client, half through a second service-role client, interleaved.
      // Neither call names a channel, because no function in `0007` takes one.
      const outcomes = await Promise.all([
        ...Array.from({ length: perClient }, () =>
          reserve(harness.farmerA.id, 'image', { ...quota, now }),
        ),
        ...Array.from({ length: perClient }, () =>
          reserve(harness.farmerA.id, 'image', { rpc: adminCounterRpc(secondAdmin), now }),
        ),
      ]);

      expect(grantedCounts(outcomes)).toEqual(countingUpTo(perClient * 2));

      const rows = await counterRows('image', windowKey);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.used).toBe(perClient * 2);

      // The structural half of Requirement 14.2: there is no column that *could* separate a web
      // request from a WhatsApp one, so cross-channel sharing is automatic rather than remembered.
      expect(Object.keys(rows[0] ?? {})).not.toContain('channel');
    });

    it('leaves the other farmer at zero', async () => {
      const now = windowInstant(9);
      const windowKey = dayWindowKey(now);

      await Promise.all(
        Array.from({ length: 4 }, () => reserve(harness.farmerA.id, 'chat', { ...quota, now })),
      );

      // The primary key is per farmer, so this is not a policy question — there is no row.
      expect(
        await rpc.used({
          userId: harness.farmerB.id,
          operation: 'chat',
          windowKind: 'day',
          windowKey,
        }),
      ).toBe(0);
      expect(await counterRows('chat', windowKey, harness.farmerB.id)).toEqual([]);
      expect((await counterRows('chat', windowKey))[0]?.used).toBe(4);
    });
  });
});
