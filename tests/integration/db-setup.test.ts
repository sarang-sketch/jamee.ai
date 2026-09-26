import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupDatabase } from '@/lib/db/setup';
import { COLLECTIONS, MEDIA_BUCKET } from '@/lib/db/names';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from './mongo';

/**
 * Integration tests for the MongoDB setup and the atomic helpers (tasks 53.5, and the concurrency
 * half of 52.4), run against a single-node `MongoMemoryReplSet` (V31, V33).
 *
 * Requirements: 4.1 (exactly five conditions), 6.4/6.5 (via the diagnoses shape the validator
 *               pins), 13.3/13.4, 13.9, 14.1-14.3, 17.6, 21.16, 22.11, 22.12
 * Design: "Data model and collection setup", D14, D17, D19; V28, V29, V31, V33
 *
 * The harness always tries to start the server and reports a binary-download failure exactly rather
 * than skipping (see `tests/integration/mongo.ts`) — a self-skipping suite would be a broken gate.
 *
 * The counter and transaction cases drive `src/lib/db/farmer.ts`, whose `getMongoClient()`/`getDb()`
 * read `MONGODB_URI`. `beforeAll` points that at the in-memory replica set BEFORE any DAL function
 * runs (the client constructs lazily on first use), so the layer exercises the same in-memory server
 * the raw-driver assertions use.
 */

let harness: MongoHarness | undefined;

beforeAll(async () => {
  harness = await startMongo();
  // Point the Data_Access_Layer's cached client at the in-memory replica set before any DAL call.
  process.env.MONGODB_URI = harness.replSet.getUri();
}, 120_000); // first run downloads a MongoDB binary

afterAll(async () => {
  await stopMongo(harness);
});

function db() {
  if (harness === undefined) throw new Error('harness not started');
  return harness.db;
}

/**
 * A raw, loosely-typed collection handle for the validator/index tests. The default
 * `Collection<Document>` types `_id` as `ObjectId`, but these tests deliberately insert string
 * `_id`s and intentionally-malformed documents to prove the `$jsonSchema` validators and unique
 * indexes reject them — so the handle's document type is `{ _id?: unknown; [k]: unknown }`, which
 * lets a test express the bad shape it means to send to the server.
 */
type RawDoc = { _id?: string; [key: string]: unknown };
function raw(name: string) {
  return db().collection<RawDoc>(name);
}

describe('setupDatabase — idempotence, collections, GridFS, seed', () => {
  beforeAll(async () => {
    await clearDatabase(db());
    await setupDatabase(db());
  });

  it('creates every declared collection', async () => {
    const names = new Set(
      (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
    );
    for (const name of Object.values(COLLECTIONS)) {
      expect(names.has(name), `missing collection ${name}`).toBe(true);
    }
  });

  it('creates the single GridFS files collection', async () => {
    const names = new Set(
      (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
    );
    expect(names.has(`${MEDIA_BUCKET}.files`)).toBe(true);
  });

  it('seeds exactly five verified conditions', async () => {
    const count = await db().collection(COLLECTIONS.diseaseKnowledge).countDocuments();
    expect(count).toBe(5);
  });

  it('Tomato Healthy carries an empty treatment array', async () => {
    const healthy = await db()
      .collection(COLLECTIONS.diseaseKnowledge)
      .findOne({ diseaseName: 'Tomato Healthy' });
    expect(healthy?.treatment).toEqual([]);
    expect(String(healthy?.source ?? '')).not.toHaveLength(0);
  });

  it('is idempotent — a second run changes nothing', async () => {
    const before = await db().collection(COLLECTIONS.diseaseKnowledge).countDocuments();
    const result = await setupDatabase(db()); // run twice
    const after = await db().collection(COLLECTIONS.diseaseKnowledge).countDocuments();
    expect(after).toBe(before);
    expect(result.seededConditions).toBe(5);
    // Collections and indexes are unchanged (creating an existing one is a no-op).
    const names = new Set(
      (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
    );
    for (const name of Object.values(COLLECTIONS)) expect(names.has(name)).toBe(true);
  });
});

describe('$jsonSchema validators reject bad enumerated values', () => {
  beforeAll(async () => {
    await clearDatabase(db());
    await setupDatabase(db());
  });

  it('rejects a conversation with an out-of-enum channel', async () => {
    await expect(
      raw(COLLECTIONS.conversations).insertOne({
        ownerId: 'u1',
        channel: 'whatsapp', // retired — not in the A3 enum
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('accepts a conversation with a valid channel', async () => {
    await expect(
      raw(COLLECTIONS.conversations).insertOne({
        ownerId: 'u1',
        channel: 'telegram',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a profile with an unsupported language', async () => {
    await expect(
      raw(COLLECTIONS.profiles).insertOne({
        _id: 'u-bad-lang',
        language: 'fr',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('rejects a diagnosis with an out-of-enum severity', async () => {
    await expect(
      raw(COLLECTIONS.diagnoses).insertOne({
        ownerId: 'u1',
        conversationId: 'c1',
        status: 'identified',
        severity: 'catastrophic',
        explanation: 'x',
        language: 'en',
        needsExpert: false,
        channel: 'web',
        mediaRef: { fileId: 'f', kind: 'crop-image' },
        modelProvider: 'gemini',
        createdAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});

describe('unique and partial indexes', () => {
  beforeAll(async () => {
    await clearDatabase(db());
    await setupDatabase(db());
  });

  it('profiles.telegramUserId is unique when present but any number of profiles may omit it', async () => {
    const profiles = raw(COLLECTIONS.profiles);
    const base = { language: 'en', createdAt: new Date(), updatedAt: new Date() };
    // Two profiles with NO telegramUserId — both allowed (partial index).
    await profiles.insertOne({ _id: 'p1', ...base });
    await profiles.insertOne({ _id: 'p2', ...base });
    // One with a telegramUserId.
    await profiles.insertOne({ _id: 'p3', telegramUserId: 555, ...base });
    // A second profile with the SAME telegramUserId is rejected.
    await expect(
      profiles.insertOne({ _id: 'p4', telegramUserId: 555, ...base }),
    ).rejects.toThrow();
  });

  it('disease_knowledge.diseaseName is unique', async () => {
    const dk = raw(COLLECTIONS.diseaseKnowledge);
    await expect(
      dk.insertOne({
        diseaseName: 'Tomato Healthy',
        crop: 'tomato',
        symptoms: [],
        causes: [],
        treatment: [],
        prevention: [],
        defaultSeverity: 'none',
        source: 'dup',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('bot_entitlements enforces one-per-farmer (_id) and unique providerPaymentId', async () => {
    const ents = raw(COLLECTIONS.botEntitlements);
    const now = new Date();
    await ents.insertOne({ _id: 'f1', providerPaymentId: 'pay_a', expiresAt: now, grantedAt: now, updatedAt: now });
    // Same farmer again — primary-key clash.
    await expect(
      ents.insertOne({ _id: 'f1', providerPaymentId: 'pay_b', expiresAt: now, grantedAt: now, updatedAt: now }),
    ).rejects.toThrow();
    // Different farmer, same payment id — unique-index clash.
    await expect(
      ents.insertOne({ _id: 'f2', providerPaymentId: 'pay_a', expiresAt: now, grantedAt: now, updatedAt: now }),
    ).rejects.toThrow();
  });

  it('payment_orders.providerPaymentId is unique when present, omitted freely', async () => {
    const orders = raw(COLLECTIONS.paymentOrders);
    const base = { ownerId: 'u1', amountMinor: 2000, currency: 'INR', status: 'created', createdAt: new Date(), updatedAt: new Date() };
    await orders.insertOne({ ...base, providerOrderId: 'ord_1' }); // no providerPaymentId
    await orders.insertOne({ ...base, providerOrderId: 'ord_2' }); // no providerPaymentId — allowed
    await orders.insertOne({ ...base, providerOrderId: 'ord_3', providerPaymentId: 'pp_1' });
    await expect(
      orders.insertOne({ ...base, providerOrderId: 'ord_4', providerPaymentId: 'pp_1' }),
    ).rejects.toThrow();
  });

  it('the telegram_inbound TTL index exists', async () => {
    const indexes = await db().collection(COLLECTIONS.telegramInbound).indexes();
    const ttl = indexes.find((i) => i.name === 'received_ttl');
    expect(ttl?.expireAfterSeconds).toBe(7 * 24 * 60 * 60);
  });
});
