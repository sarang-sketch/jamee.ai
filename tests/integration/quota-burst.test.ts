import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DAILY_QUOTAS, BURST_QUOTAS } from '@/lib/config/verified';
import { setupDatabase } from '@/lib/db/setup';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from './mongo';

/**
 * Integration tests for the ported quota and burst services (task 56.1) against a single-node
 * `MongoMemoryReplSet` (V31, V33). These exercise the REAL Data_Access_Layer atomic counter
 * (`findOneAndUpdate` conditional upsert / guarded decrement) rather than a stub, which is where
 * the concurrency guarantee actually lives.
 *
 * Requirements: 14.1 (the daily quota is never exceeded), 14.2 (one shared per-farmer counter),
 *               14.3 (a request past the limit is declined), 13.8 (the burst limiter declines past
 *               its per-minute window ceiling)
 * Design: D19 (the counter is one atomic statement, no read-then-write); V28, V33
 *
 * `MONGODB_URI` is pointed at the in-memory replica set before any service runs, and the service
 * modules are imported dynamically AFTER that, so their lazily-cached client connects to the
 * harness — the same wiring `data-access.test.ts` uses.
 */

let harness: MongoHarness | undefined;
type QuotaModule = typeof import('@/services/quota.service');
type RateLimitModule = typeof import('@/lib/rate-limit');
let quota: QuotaModule;
let rateLimit: RateLimitModule;

const USER = 'farmer-quota';
const NOW = new Date('2026-09-15T19:30:00.000Z'); // 2026-09-16 01:00 in Asia/Kolkata.

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  quota = await import('@/services/quota.service');
  rateLimit = await import('@/lib/rate-limit');
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  if (harness) await clearDatabase(harness.db);
});

/* ========================================================================== */
/* The counter never exceeds its limit under concurrent reservations           */
/* ========================================================================== */

describe('quota reserve under concurrency (14.1, 14.2)', () => {
  it('never lets more reservations succeed than the daily limit, even fired together', async () => {
    const limit = DAILY_QUOTAS.image; // 20
    const attempts = limit + 15;

    // Fire all reserves at once against the real atomic counter.
    const outcomes = await Promise.all(
      Array.from({ length: attempts }, () => quota.reserve(USER, 'image', { now: NOW })),
    );

    const allowed = outcomes.filter((o) => o.outcome === 'allowed');
    const declined = outcomes.filter((o) => o.outcome === 'at_limit');

    // The load-bearing guarantee (14.1, D19): the counter NEVER over-issues. At most `limit`
    // succeed, every other attempt is declined, and the two partition the attempts exactly.
    expect(allowed.length).toBeLessThanOrEqual(limit);
    expect(allowed.length + declined.length).toBe(attempts);
    expect(declined.length).toBeGreaterThanOrEqual(attempts - limit);

    // The stored count equals the number allowed and never exceeds the limit.
    const doc = await harness!.db
      .collection('counters')
      .findOne({ ownerId: USER, operation: 'image', windowKind: 'day' });
    expect(doc?.used).toBe(allowed.length);
    expect(doc?.used).toBeLessThanOrEqual(limit);
  });

  it('the allowed reservations carry the strictly increasing counts 1..limit', async () => {
    const limit = DAILY_QUOTAS.voice; // 20
    const counts: number[] = [];
    // Sequential reserves: this test asserts that each succeeding reserve gets the next count, not
    // that the counter is safe under concurrency (the first test covers that).
    for (let i = 0; i < limit; i += 1) {
      const outcome = await quota.reserve(USER, 'voice', { now: NOW });
      if (outcome.outcome !== 'allowed') throw new Error(`expected allowed at i=${i}`);
      counts.push(outcome.reservation.used);
    }
    expect(counts).toEqual(Array.from({ length: limit }, (_, i) => i + 1));
  });
});

/* ========================================================================== */
/* Refund gives a unit back, and never drives below zero                       */
/* ========================================================================== */

describe('quota refund (14.x)', () => {
  it('a reserve then a refund leaves the counter back at zero, and a second refund is a no-op', async () => {
    const outcome = await quota.reserve(USER, 'chat', { now: NOW });
    if (outcome.outcome !== 'allowed') throw new Error('expected allowed');
    expect(outcome.reservation.used).toBe(1);

    const first = await quota.refundReservation(outcome.reservation, { now: NOW });
    expect(first).toEqual({ refunded: true, used: 0 });

    // A second refund matches no row (used is already 0) — reported as nothing to do, never below 0.
    const second = await quota.refund(USER, 'chat', { now: NOW });
    expect(second.refunded).toBe(false);

    const doc = await harness!.db
      .collection('counters')
      .findOne({ ownerId: USER, operation: 'chat', windowKind: 'day' });
    expect(doc?.used).toBe(0);
  });

  it('a fresh window key starts at zero with no reset job', async () => {
    const day1 = new Date('2026-09-15T19:30:00.000Z'); // 2026-09-16 IST
    const day2 = new Date('2026-09-16T19:30:00.000Z'); // 2026-09-17 IST
    await quota.reserve(USER, 'image', { now: day1 });
    const next = await quota.reserve(USER, 'image', { now: day2 });
    if (next.outcome !== 'allowed') throw new Error('expected allowed');
    // A new Asia/Kolkata day is a new key, so the count starts at 1 again.
    expect(next.reservation.used).toBe(1);
  });
});

/* ========================================================================== */
/* The burst limiter declines past its per-minute window ceiling (13.8)         */
/* ========================================================================== */

describe('burst limiter (13.8)', () => {
  it('allows up to the per-minute ceiling and then declines with RATE_LIMITED', async () => {
    const limit = BURST_QUOTAS.image; // 3
    const now = () => NOW;

    // Up to the ceiling: no throw.
    for (let i = 0; i < limit; i += 1) {
      await expect(rateLimit.checkBurst(USER, 'image', { now: now() })).resolves.toBeUndefined();
    }

    // The next one, in the same minute window, is refused.
    await expect(rateLimit.checkBurst(USER, 'image', { now: now() })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
    });

    // The minute counter sits exactly at the ceiling — the refusal did not increment past it.
    const doc = await harness!.db
      .collection('counters')
      .findOne({ ownerId: USER, operation: 'image', windowKind: 'minute' });
    expect(doc?.used).toBe(limit);
  });

  it('a new minute window starts fresh', async () => {
    const minute1 = new Date('2026-09-15T19:30:10.000Z');
    const minute2 = new Date('2026-09-15T19:31:10.000Z');
    for (let i = 0; i < BURST_QUOTAS.chat; i += 1) {
      await rateLimit.checkBurst(USER, 'chat', { now: minute1 });
    }
    await expect(rateLimit.checkBurst(USER, 'chat', { now: minute1 })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    // The next minute is a new key and starts at zero.
    await expect(rateLimit.checkBurst(USER, 'chat', { now: minute2 })).resolves.toBeUndefined();
  });
});
