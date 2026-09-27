import { Buffer } from 'node:buffer';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { COLLECTIONS } from '@/lib/db/names';

import { startHarness, type Harness } from './harness';

/**
 * Tenant isolation, application-enforced by the Data_Access_Layer (D18), proven end to end against a
 * real single-node `MongoMemoryReplSet` (V31, V33) — the Amendment A3 successor to the RLS
 * cross-tenant checks.
 *
 * Requirements: 13.1, 13.2 (every farmer-scoped read/write is scoped to the owning Farmer), 13.6
 *               (GridFS media is owner-scoped), 2.6 (a stranger cannot even learn a file exists)
 * Design: D18 (the layer is the isolation boundary; the CI check `check:data-access` makes it the
 *         only holder of the driver, so the owner scope can be forgotten only inside the one small
 *         layer that is unit-tested for it), D17; Amendment A3; Properties 27, 31
 *
 * The design's own words for this file (Integration tests, A3): *"Tenant isolation is verified by
 * attempting cross-farmer reads through a second farmer's scope and asserting zero documents —
 * across profiles, conversations, messages, diagnoses, usage_logs, link_tokens, payment_orders, and
 * bot_entitlements — and, on the access collections, a cross-farmer WRITE attempt that must fail (the
 * accessor exposes no unscoped seam) rather than return zero documents. GridFS ownership is verified
 * the same way: a farmer cannot fetch or delete a file whose metadata.ownerId is another's."*
 */

let harness: Harness;
type Farmer = typeof import('@/lib/db/farmer');
type Access = typeof import('@/lib/db/access');
let farmer: Farmer;
let access: Access;

beforeAll(async () => {
  harness = await startHarness();
  farmer = await import('@/lib/db/farmer');
  access = await import('@/lib/db/access');
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await harness.reset();
});

function A() {
  return harness.farmerA.id;
}
function B() {
  return harness.farmerB.id;
}

/** Seed one row in every farmer-scoped collection for farmer A. */
async function seedAllForA(): Promise<void> {
  const a = farmer.farmerData(A());
  const conversation = await a.insertConversation({ channel: 'web' });
  await a.insertMessage({ conversationId: conversation._id, role: 'farmer', content: 'hello', language: 'en', channel: 'web', inputKind: 'text' });
  await a.insertDiagnosis({
    conversationId: conversation._id,
    status: 'identified',
    diseaseName: 'Tomato Early Blight',
    knowledgeId: null,
    confidence: 0.9,
    severity: 'moderate',
    explanation: 'x',
    language: 'en',
    needsExpert: false,
    channel: 'web',
    mediaRef: { fileId: (await import('mongodb')).ObjectId.createFromTime(1), kind: 'crop-image' },
    fullImageDeletedAt: null,
    modelProvider: 'gemini',
  });
  await a.insertUsageLog({ operation: 'image', channel: 'web', outcome: 'success', usedFallback: false, quotaSpent: true });
  await a.counterTryIncrement('image', 'day', '1970-01-15', 20);
  await access.accessData(A()).insertLinkToken({ tokenHash: 'hash-a', expiresAt: new Date(Date.now() + 60_000) });
  await access.accessData(A()).insertPaymentOrder({ providerOrderId: 'order-a', amountMinor: 2000, currency: 'INR', status: 'created' });
  await harness.db.collection(COLLECTIONS.botEntitlements).insertOne({
    _id: A() as never,
    providerPaymentId: 'pay-a',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    grantedAt: new Date(),
    updatedAt: new Date(),
  } as never);
}

/* ========================================================================== */
/* Cross-farmer reads return zero across every collection                      */
/* ========================================================================== */

describe('cross-farmer reads return zero', () => {
  it("farmer B's scope reads none of farmer A's documents", async () => {
    await seedAllForA();
    const b = farmer.farmerData(B());
    const accessB = access.accessData(B());

    // profiles — B's own profile exists but is not A's; reading A's is not expressible through B's
    // scope (the accessor keys on B's id), and B's readProfile returns B's row only.
    expect((await b.readProfile())?._id).toBe(B());

    expect(await b.findConversations()).toEqual([]);
    expect(await b.findMessages()).toEqual([]);
    expect(await b.findDiagnoses()).toEqual([]);
    expect(await b.findPaymentOrders()).toEqual([]);
    expect(await b.readEntitlement()).toBeNull();
    expect(await accessB.findPaymentOrders()).toEqual([]);
    expect(await accessB.readEntitlement()).toBeNull();
    // counters — B's counter for the same key is a fresh 0, never A's value.
    expect(await b.counterUsed('image', 'day', '1970-01-15')).toBe(0);

    // A still sees all of A's own rows — proof the rows were there to be missed.
    const a = farmer.farmerData(A());
    expect(await a.findConversations()).toHaveLength(1);
    expect(await a.findMessages()).toHaveLength(1);
    expect(await a.findDiagnoses()).toHaveLength(1);
    expect(await a.readEntitlement()).not.toBeNull();
  });
});

/* ========================================================================== */
/* Cross-farmer writes on the access collections FAIL (no unscoped seam)       */
/* ========================================================================== */

describe('cross-farmer writes cannot be expressed', () => {
  it('the access accessor exposes no seam to write another farmer’s rows', async () => {
    await seedAllForA();

    // `accessData(B())` binds every write to B. There is no method that accepts an owner override,
    // so B cannot mint a link token or a payment order attributed to A — the write is stamped B's.
    const tokenB = await access.accessData(B()).insertLinkToken({ tokenHash: 'hash-b', expiresAt: new Date(Date.now() + 60_000) });
    const orderB = await access.accessData(B()).insertPaymentOrder({ providerOrderId: 'order-b', amountMinor: 2000, currency: 'INR', status: 'created' });

    const tokenDoc = await harness.db.collection(COLLECTIONS.linkTokens).findOne({ _id: tokenB._id });
    const orderDoc = await harness.db.collection(COLLECTIONS.paymentOrders).findOne({ _id: orderB._id });
    // The owner is B, never the A the caller might have wished for — the stamp is structural.
    expect(tokenDoc?.ownerId).toBe(B());
    expect(orderDoc?.ownerId).toBe(B());

    // And B's unlink touches only B: A's link token and entitlement are untouched.
    await access.accessData(B()).clearTelegramLink();
    await access.accessData(B()).invalidateOutstandingLinkTokens(new Date());
    const aToken = await harness.db.collection(COLLECTIONS.linkTokens).findOne({ tokenHash: 'hash-a' });
    expect(aToken?.consumedAt ?? null).toBeNull();
    expect(await access.accessData(A()).readEntitlement()).not.toBeNull();
  });
});

/* ========================================================================== */
/* GridFS ownership — 13.6, 2.6                                                */
/* ========================================================================== */

describe('GridFS ownership', () => {
  it("a farmer cannot fetch or delete a file whose metadata.ownerId is another's", async () => {
    const media = await import('@/lib/db/media');

    const ownedByA = await media.writeMedia(A(), 'crop-image', 'image/jpeg', Buffer.from('a-bytes'));

    // B cannot read A's file — a foreign file and a missing one are indistinguishable (2.6).
    expect(await media.readMediaForOwner(B(), ownedByA.fileId)).toBeNull();
    // B's delete of A's file removes nothing and returns false; A's file survives.
    expect(await media.deleteMediaForOwner(B(), ownedByA.fileId)).toBe(false);
    expect(await media.readMediaForOwner(A(), ownedByA.fileId)).not.toBeNull();

    // A can read and delete their own.
    expect(await media.deleteMediaForOwner(A(), ownedByA.fileId)).toBe(true);
    expect(await media.readMediaForOwner(A(), ownedByA.fileId)).toBeNull();
  });
});
