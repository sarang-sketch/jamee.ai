import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { COLLECTIONS } from '@/lib/db/names';
import { setupDatabase } from '@/lib/db/setup';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from './mongo';

/**
 * Integration tests for the Data_Access_Layer's atomic helpers and owner-scoping (tasks 53.5 and
 * the DB-backed half of 52.4), against a single-node `MongoMemoryReplSet` (V31, V33).
 *
 * Requirements: 13.1, 13.2 (owner-scoping cannot be bypassed), 14.1-14.3 (the counter never exceeds
 *               its limit and returns null at the limit, even under concurrency)
 * Design: D18, D19; V28, V33
 *
 * `MONGODB_URI` is pointed at the in-memory replica set in `beforeAll` before any DAL function runs,
 * and `src/lib/db/farmer.ts` is imported dynamically AFTER that, so its lazily-constructed cached
 * client connects to the harness rather than to a real Atlas cluster.
 */

let harness: MongoHarness | undefined;
type Farmer = typeof import('@/lib/db/farmer');
let dal: Farmer;

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  // Import AFTER MONGODB_URI is set so client.ts caches a client for the in-memory server.
  dal = await import('@/lib/db/farmer');
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  if (harness) await clearDatabase(harness.db);
});

function db() {
  if (harness === undefined) throw new Error('harness not started');
  return harness.db;
}

/* ========================================================================== */
/* Owner-scoping cannot be bypassed (52.4, DB-backed)                          */
/* ========================================================================== */

describe('owner-scoping', () => {
  it('a farmer reads only their own conversations, never another farmer’s', async () => {
    const a = dal.farmerData('farmer-A');
    const b = dal.farmerData('farmer-B');
    await a.insertConversation({ channel: 'web' });
    await b.insertConversation({ channel: 'web' });

    expect(await a.findConversations()).toHaveLength(1);
    expect(await b.findConversations()).toHaveLength(1);
    // A cannot reach B's row even by passing a filter that names B's data.
    expect(await a.findConversations({ channel: 'web' })).toHaveLength(1);
  });

  it('the owner stamp on an insert cannot be overridden by the caller', async () => {
    const a = dal.farmerData('farmer-A');
    // The doc type has no ownerId field, but a malicious caller might spread one in; the stamp wins.
    await a.insertConversation({ channel: 'web', ...( { ownerId: 'farmer-B' } as object) });
    const stored = await db().collection(COLLECTIONS.conversations).findOne({});
    expect(stored?.ownerId).toBe('farmer-A');
  });

  it('a diagnosis inserted by A is invisible to B', async () => {
    const a = dal.farmerData('farmer-A');
    await a.insertDiagnosis({
      conversationId: (await a.insertConversation({ channel: 'web' }))._id,
      status: 'unknown',
      diseaseName: null,
      knowledgeId: null,
      confidence: null,
      severity: 'none',
      explanation: 'inconclusive',
      language: 'en',
      needsExpert: true,
      channel: 'web',
      mediaRef: { fileId: (await import('mongodb')).ObjectId.createFromTime(1), kind: 'crop-image' },
      modelProvider: 'gemini',
    });
    const b = dal.farmerData('farmer-B');
    expect(await b.findDiagnoses()).toHaveLength(0);
    expect(await dal.farmerData('farmer-A').findDiagnoses()).toHaveLength(1);
  });
});

/* ========================================================================== */
/* The atomic quota counter (D19)                                              */
/* ========================================================================== */

describe('counterTryIncrement', () => {
  const dayKey = '2026-09-27';

  it('returns the running count up to the limit, then null', async () => {
    const f = dal.farmerData('quota-farmer');
    expect(await f.counterTryIncrement('image', 'day', dayKey, 3)).toBe(1);
    expect(await f.counterTryIncrement('image', 'day', dayKey, 3)).toBe(2);
    expect(await f.counterTryIncrement('image', 'day', dayKey, 3)).toBe(3);
    // At the limit: declined.
    expect(await f.counterTryIncrement('image', 'day', dayKey, 3)).toBeNull();
    expect(await f.counterTryIncrement('image', 'day', dayKey, 3)).toBeNull();
  });

  it('never exceeds the limit under concurrent calls, and the accepted total equals the limit', async () => {
    const f = dal.farmerData('concurrent-farmer');
    const limit = 20;
    const attempts = 50;
    const results = await Promise.all(
      Array.from({ length: attempts }, () => f.counterTryIncrement('chat', 'day', dayKey, limit)),
    );
    const accepted = results.filter((r): r is number => r !== null);
    const declined = results.filter((r) => r === null);

    expect(accepted).toHaveLength(limit);
    expect(declined).toHaveLength(attempts - limit);
    // The stored count is exactly the limit — no reservation lost, none double-counted.
    const stored = await db()
      .collection(COLLECTIONS.counters)
      .findOne({ ownerId: 'concurrent-farmer', operation: 'chat', windowKind: 'day', windowKey: dayKey });
    expect(stored?.used).toBe(limit);
    // The accepted values are exactly 1..limit.
    expect([...accepted].sort((x, y) => x - y)).toEqual(Array.from({ length: limit }, (_, i) => i + 1));
  });

  it('a fresh window key starts at zero with no reset job', async () => {
    const f = dal.farmerData('window-farmer');
    expect(await f.counterTryIncrement('voice', 'day', '2026-09-27', 5)).toBe(1);
    expect(await f.counterTryIncrement('voice', 'day', '2026-09-28', 5)).toBe(1);
  });

  it('counterDecrement never drives used below zero', async () => {
    const f = dal.farmerData('refund-farmer');
    await f.counterTryIncrement('image', 'day', dayKey, 5);
    expect(await f.counterDecrement('image', 'day', dayKey)).toBe(0);
    // Already zero — the guard returns null and leaves it at zero.
    expect(await f.counterDecrement('image', 'day', dayKey)).toBeNull();
    expect(await f.counterUsed('image', 'day', dayKey)).toBe(0);
  });
});

/* ========================================================================== */
/* withTransaction rolls back on error (D19, V33)                              */
/* ========================================================================== */

describe('withTransaction', () => {
  it('commits both writes when the body succeeds', async () => {
    // Use the DAL's OWN db handle: withTransaction opens a session on the DAL's cached client, and a
    // session can only drive collections from that same client.
    const conversations = dal.getDb().collection(COLLECTIONS.conversations);
    await dal.withTransaction(async (session) => {
      await conversations.insertOne(
        { ownerId: 'txn', channel: 'web', createdAt: new Date(), updatedAt: new Date() },
        { session },
      );
      await conversations.insertOne(
        { ownerId: 'txn', channel: 'telegram', createdAt: new Date(), updatedAt: new Date() },
        { session },
      );
    });
    expect(await conversations.countDocuments({ ownerId: 'txn' })).toBe(2);
  });

  it('rolls back every write when the body throws', async () => {
    const conversations = dal.getDb().collection(COLLECTIONS.conversations);
    await expect(
      dal.withTransaction(async (session) => {
        await conversations.insertOne(
          { ownerId: 'rollback', channel: 'web', createdAt: new Date(), updatedAt: new Date() },
          { session },
        );
        throw new Error('deliberate failure after the first write');
      }),
    ).rejects.toThrow('deliberate failure');

    // The first write must not have survived the abort.
    expect(await conversations.countDocuments({ ownerId: 'rollback' })).toBe(0);
  });
});

/* ========================================================================== */
/* The telegram_inbound claim and webhook throttle (D19)                       */
/* ========================================================================== */

describe('system accessors', () => {
  it('claimTelegramUpdate is true once and false on a duplicate update_id', async () => {
    expect(await dal.claimTelegramUpdate(1001, 42, 'text')).toBe(true);
    expect(await dal.claimTelegramUpdate(1001, 42, 'text')).toBe(false);
  });

  it('webhookThrottleTryIncrement counts to the limit then returns null', async () => {
    const key = '2026-09-27T00:23';
    expect(await dal.webhookThrottleTryIncrement('payment', 'hashX', key, 2)).toBe(1);
    expect(await dal.webhookThrottleTryIncrement('payment', 'hashX', key, 2)).toBe(2);
    expect(await dal.webhookThrottleTryIncrement('payment', 'hashX', key, 2)).toBeNull();
  });
});
