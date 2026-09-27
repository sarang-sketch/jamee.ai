import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { COLLECTIONS } from '@/lib/db/collections';

import { startHarness, type Harness } from './harness';

/**
 * Quota atomicity, against the REAL `counters` conditional upsert on a single-node
 * `MongoMemoryReplSet` (V31, V33).
 *
 * Requirements: 14.1 (the per-operation daily limit), 14.3 (a request past the limit is declined)
 * Design: "Quota enforcement"; D19 (the `findOneAndUpdate` conditional upsert with `used < limit`
 *         and `$inc`, and the guarded `used > 0` decrement — no read-then-write); Amendment A3
 *         (the testing-strategy amendment: fire the reserve concurrently at the limit boundary and
 *         assert the total never exceeds the limit and no reservation is lost; assert the guarded
 *         decrement never drives `used` below zero)
 *
 * =============================================================================
 * WHY A STUB CANNOT MAKE THIS CLAIM
 * =============================================================================
 *
 * A single-threaded in-memory Map serialises itself for free, so a stubbed counter is atomic whether
 * or not the unique index is. The only way to prove "N concurrent reserves at a limit of L grant
 * exactly min(N, L) and never more" is to race the real `findOneAndUpdate` against a real unique
 * compound index — which is what the `counters` `{ ownerId, operation, windowKind, windowKey }`
 * index and this harness provide.
 */

const OWNER = 'auth-user-quota';
const WINDOW_KEY = '1970-01-15';

let harness: Harness;
type Farmer = typeof import('@/lib/db/farmer');
let farmer: Farmer;

beforeAll(async () => {
  harness = await startHarness();
  farmer = await import('@/lib/db/farmer');
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await harness.reset();
});

function data() {
  return farmer.farmerData(OWNER);
}

/* ========================================================================== */
/* Concurrent reserve at the boundary                                          */
/* ========================================================================== */

describe('the conditional reserve under concurrency', () => {
  it('grants exactly the limit and no more when more reserves race than the limit allows', async () => {
    const limit = 5;
    const attempts = 20;

    const results = await Promise.all(
      Array.from({ length: attempts }, () => data().counterTryIncrement('image', 'day', WINDOW_KEY, limit)),
    );

    // Exactly `limit` reserves succeeded (a number in [1..limit]); the rest were declined (`null`).
    const granted = results.filter((used): used is number => used !== null);
    const declined = results.filter((used) => used === null);
    expect(granted).toHaveLength(limit);
    expect(declined).toHaveLength(attempts - limit);

    // No reservation was lost: the granted counts are exactly 1..limit, each once.
    expect([...granted].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);

    // The stored counter never exceeds the limit.
    const counter = await harness.db
      .collection(COLLECTIONS.counters)
      .findOne({ ownerId: OWNER, operation: 'image', windowKind: 'day', windowKey: WINDOW_KEY });
    expect(counter?.used).toBe(limit);
  });

  it('a reserve at the limit returns null and never increments past it', async () => {
    const limit = 1;
    expect(await data().counterTryIncrement('chat', 'day', WINDOW_KEY, limit)).toBe(1);
    expect(await data().counterTryIncrement('chat', 'day', WINDOW_KEY, limit)).toBeNull();
    expect(await data().counterTryIncrement('chat', 'day', WINDOW_KEY, limit)).toBeNull();

    const counter = await harness.db
      .collection(COLLECTIONS.counters)
      .findOne({ ownerId: OWNER, operation: 'chat', windowKind: 'day', windowKey: WINDOW_KEY });
    expect(counter?.used).toBe(1);
  });
});

/* ========================================================================== */
/* Guarded decrement never goes below zero                                     */
/* ========================================================================== */

describe('the guarded decrement', () => {
  it('never drives used below zero, and reports null when there is nothing to refund', async () => {
    // Reserve two, refund three times: the third refund matches no row (used already 0) → null.
    await data().counterTryIncrement('voice', 'day', WINDOW_KEY, 10);
    await data().counterTryIncrement('voice', 'day', WINDOW_KEY, 10);

    expect(await data().counterDecrement('voice', 'day', WINDOW_KEY)).toBe(1);
    expect(await data().counterDecrement('voice', 'day', WINDOW_KEY)).toBe(0);
    // At zero the guarded decrement matches nothing and returns null — never -1.
    expect(await data().counterDecrement('voice', 'day', WINDOW_KEY)).toBeNull();

    const counter = await harness.db
      .collection(COLLECTIONS.counters)
      .findOne({ ownerId: OWNER, operation: 'voice', windowKind: 'day', windowKey: WINDOW_KEY });
    expect(counter?.used).toBe(0);
  });

  it('concurrent refunds at zero never drive the counter negative', async () => {
    await data().counterTryIncrement('image', 'day', WINDOW_KEY, 10);

    // One unit reserved; fire five refunds concurrently. At most one matches; the counter floors at 0.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => data().counterDecrement('image', 'day', WINDOW_KEY)),
    );
    const applied = results.filter((used) => used !== null);
    expect(applied.length).toBe(1);
    expect(applied[0]).toBe(0);

    const counter = await harness.db
      .collection(COLLECTIONS.counters)
      .findOne({ ownerId: OWNER, operation: 'image', windowKind: 'day', windowKey: WINDOW_KEY });
    expect(counter?.used).toBe(0);
  });
});

/* ========================================================================== */
/* Cross-channel sharing (14.2) — one counter, no channel component            */
/* ========================================================================== */

describe('cross-channel sharing (14.2)', () => {
  it('a web reserve and a telegram reserve land on the same counter row', async () => {
    // The counter key has no channel component, so two reserves for the same operation share a row.
    expect(await data().counterTryIncrement('image', 'day', WINDOW_KEY, 10)).toBe(1);
    expect(await data().counterTryIncrement('image', 'day', WINDOW_KEY, 10)).toBe(2);

    const rows = await harness.db
      .collection(COLLECTIONS.counters)
      .find({ ownerId: OWNER, operation: 'image', windowKind: 'day', windowKey: WINDOW_KEY })
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.used).toBe(2);
  });
});
