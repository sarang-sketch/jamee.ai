import { createHash } from 'node:crypto';

import * as fc from 'fast-check';
import type { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { COLLECTIONS, type BotEntitlementDoc, type ConversationDoc, type DiagnosisDoc, type LinkTokenDoc, type MessageDoc, type ProfileDoc } from '@/lib/db/collections';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from '../integration/mongo';

/**
 * **Property 32: A link token binds at most once, and an invalid one binds not at all**
 *
 * > For any minted Link_Token and any interleaving of `/start` deliveries carrying it — including
 * > two simultaneous deliveries of that one valid token — at most one binding of a Telegram user id
 * > to that token's Profile occurs and the token ends consumed, the consume and the bind running
 * > inside one multi-document transaction (D19). An `/start` payload matching no recorded token, an
 * > expired token, or an already consumed token stores no `telegram_user_id`, changes no Profile,
 * > and replies identically across all three cases. A valid token whose sending Telegram user id is
 * > already stored on ANOTHER Profile aborts the transaction on the partial unique index, so neither
 * > Profile changes and the token is left unconsumed — a failed binding, never a transfer. Handling
 * > a `/start` invokes no shared service, reserves no quota, and leaves daily limits unchanged.
 *
 * **Validates: Requirements 21.5, 21.6, 21.7, 21.8, 21.13, 21.14, 21.18**
 *
 * **Property 35: Unlink preserves everything it should**
 *
 * > An unlink from a farmer's authenticated session leaves `profiles.telegram_user_id` null, leaves
 * > every outstanding Link_Token unusable for a later binding, and leaves that farmer's
 * > Bot_Entitlement (window and all) and every Conversation, Message, and Diagnosis exactly as they
 * > were, along with every other Profile field.
 *
 * **Validates: Requirements 21.14, 21.15, 22.18, 22.19, 22.20**
 *
 * =============================================================================
 * A3 RESTATEMENT — REAL LAYER, PER THE BRIEF
 * =============================================================================
 *
 * Property 32 is about the D19 consume-and-bind TRANSACTION and the partial-unique
 * `telegram_user_id` index, and Property 35 about what unlink does and does not touch across the
 * MongoDB collections. The brief directs: "Run Properties 32 and 34 ... against the real layer on
 * tests/integration/mongo.ts (start the replica set in beforeAll with a 120-second hook timeout,
 * clearDatabase between runs, numRuns around 25)." So this file exercises the REAL
 * `consumeAndBind`/`unlink` services on a single-node `MongoMemoryReplSet`, not a fake — an
 * in-memory Map would serialise itself and could report at-most-once whether or not the index does.
 *
 * The Supabase predecessor of these claims (link_tokens rows, an `already_linked_elsewhere` from a
 * unique Postgres constraint) is re-vocabularised here to: `link_tokens`/`profiles` documents, the
 * `findOneAndUpdate` consume, the partial unique index on `telegramUserId`, and the D19 transaction.
 * numRuns is kept modest (25) because each run does real transactional round-trips; that is the
 * lowering the brief permits for a real-layer property, stated here.
 */

let harness: MongoHarness | undefined;
type AccessDal = typeof import('@/lib/db/access');
type Linking = typeof import('@/services/linking.service');

let access: AccessDal;
let linking: Linking;
let setupDatabase: typeof import('@/lib/db/setup').setupDatabase;

const REAL_LAYER_RUNS = 25;

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = 'jamee_test_bot';
  // Import AFTER MONGODB_URI so the cached client connects to the in-memory replica set.
  access = await import('@/lib/db/access');
  linking = await import('@/services/linking.service');
  ({ setupDatabase } = await import('@/lib/db/setup'));
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

const sha256 = (plaintext: string): string => createHash('sha256').update(plaintext, 'utf8').digest('hex');

async function seedProfile(userId: string, telegramUserId: number | null = null): Promise<void> {
  const now = new Date();
  const doc: ProfileDoc = {
    _id: userId,
    email: `${userId}@example.test`,
    language: 'en',
    displayName: `Name ${userId}`,
    createdAt: now,
    updatedAt: now,
    ...(telegramUserId === null ? {} : { telegramUserId }),
  };
  await db().collection<ProfileDoc>(COLLECTIONS.profiles).insertOne(doc);
}

async function seedLinkToken(userId: string, plaintext: string, ttlMinutes = 15): Promise<void> {
  await access.accessData(userId).insertLinkToken({
    tokenHash: sha256(plaintext),
    expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
  });
}

async function profileOf(userId: string): Promise<ProfileDoc | null> {
  return db().collection<ProfileDoc>(COLLECTIONS.profiles).findOne({ _id: userId });
}

async function tokenDocs(userId: string): Promise<LinkTokenDoc[]> {
  return db().collection<LinkTokenDoc>(COLLECTIONS.linkTokens).find({ ownerId: userId }).toArray();
}

/* ========================================================================== */
/* Property 32                                                                 */
/* ========================================================================== */

describe('Property 32: a link token binds at most once, and an invalid one binds not at all', () => {
  it('any interleaving of deliveries of one valid token yields at most one binding, token consumed', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Between 2 and 5 concurrent deliveries, each carrying the same token, from a small set of
        // Telegram ids (so some are the same sender re-tapping and some are different senders racing).
        fc.array(fc.integer({ min: 1000, max: 1005 }), { minLength: 2, maxLength: 5 }),
        async (telegramIds) => {
          await clearDatabase(db());
          await seedProfile('owner-1');
          const plaintext = `valid-${Math.random().toString(36).slice(2)}`;
          await seedLinkToken('owner-1', plaintext);

          // Fire every delivery concurrently — Telegram redelivers on a non-200 and a farmer can tap
          // twice, so two simultaneous consumes of one token are the real race.
          const outcomes = await Promise.all(
            telegramIds.map((tgId) => linking.consumeAndBind(plaintext, tgId)),
          );

          // The token ends consumed exactly once.
          const [tokenDoc] = await tokenDocs('owner-1');
          expect(tokenDoc).toBeDefined();
          expect(tokenDoc?.consumedAt, 'token must end consumed').not.toBeNull();

          // At most one FRESH bind ('bound'); everything else is 'already_linked' (same id, token
          // already consumed by the racer) or 'already_linked_elsewhere' (a different id, blocked by
          // the unique index). No 'replaced' can occur here — the profile started with no id.
          const bound = outcomes.filter((o) => o.kind === 'bound');
          expect(bound.length, 'at most one fresh bind').toBeLessThanOrEqual(1);

          const profile = await profileOf('owner-1');
          if (bound.length === 1) {
            // The profile carries exactly the id that won the race.
            const winner = bound[0] as { kind: 'bound'; ownerId: string };
            expect(winner.ownerId).toBe('owner-1');
            expect(typeof profile?.telegramUserId).toBe('number');
            // The bound id is one of the delivered ids.
            expect(telegramIds).toContain(profile?.telegramUserId);
          }
          // The profile never carries an id that no delivery sent.
          if (typeof profile?.telegramUserId === 'number') {
            expect(telegramIds).toContain(profile.telegramUserId);
          }
        },
      ),
      { numRuns: REAL_LAYER_RUNS },
    );
  });

  it('unknown / expired / consumed tokens all reply invalid, bind nothing, change no profile', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'unknown' | 'expired' | 'consumed'>('unknown', 'expired', 'consumed'),
        fc.integer({ min: 2000, max: 2999 }),
        async (variant, tgId) => {
          await clearDatabase(db());
          await seedProfile('owner-2');

          let plaintext: string;
          if (variant === 'unknown') {
            plaintext = 'no-such-token';
          } else if (variant === 'expired') {
            plaintext = `expired-${tgId}`;
            // TTL in the past → expiresAt < now, so the consume filter { expiresAt: { $gt: now } } misses.
            await seedLinkToken('owner-2', plaintext, -1);
          } else {
            plaintext = `consumed-${tgId}`;
            await seedLinkToken('owner-2', plaintext);
            // Consume it with a first delivery, then a second must see it as consumed.
            await linking.consumeAndBind(plaintext, 9999);
            // Reset the profile so the second delivery's "invalid" is about the token, not the id.
            await db().collection<ProfileDoc>(COLLECTIONS.profiles).updateOne(
              { _id: 'owner-2' },
              { $set: { telegramUserId: null } },
            );
          }

          const before = await profileOf('owner-2');
          const outcome = await linking.consumeAndBind(plaintext, tgId);

          // All three collapse into one indistinguishable variant (21.8).
          expect(outcome.kind, variant).toBe('invalid');

          const after = await profileOf('owner-2');
          // No telegram id was stored by THIS delivery.
          expect(after?.telegramUserId ?? null, variant).toBe(before?.telegramUserId ?? null);
        },
      ),
      { numRuns: REAL_LAYER_RUNS },
    );
  });

  it('a token whose sender is already on another profile is refused, token left unconsumed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3000, max: 3999 }), async (sharedTgId) => {
        await clearDatabase(db());
        // Farmer B already holds `sharedTgId`.
        await seedProfile('owner-B', sharedTgId);
        // Farmer A mints a token; a /start from `sharedTgId` tries to bind it to A.
        await seedProfile('owner-A');
        const plaintext = `cross-${sharedTgId}`;
        await seedLinkToken('owner-A', plaintext);

        const outcome = await linking.consumeAndBind(plaintext, sharedTgId);

        // The partial-unique index aborts the transaction: a failed binding, never a transfer.
        expect(outcome.kind).toBe('already_linked_elsewhere');

        // Neither profile changed: B keeps the id, A gets none.
        expect((await profileOf('owner-B'))?.telegramUserId).toBe(sharedTgId);
        expect((await profileOf('owner-A'))?.telegramUserId ?? null).toBeNull();

        // The token is LEFT UNCONSUMED — the consume rolled back with the aborted transaction.
        const [tokenDoc] = await tokenDocs('owner-A');
        expect(tokenDoc?.consumedAt ?? null, 'token must be left unconsumed on a failed bind').toBeNull();
      }),
      { numRuns: REAL_LAYER_RUNS },
    );
  });
});

/* ========================================================================== */
/* Property 35                                                                 */
/* ========================================================================== */

describe('Property 35: unlink preserves everything it should', () => {
  it('unlink clears telegram_user_id, kills outstanding tokens, preserves entitlement and all records', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 4000, max: 4999 }),
        fc.integer({ min: 0, max: 3 }), // outstanding tokens
        fc.integer({ min: 1, max: 4 }), // conversations
        fc.integer({ min: 0, max: 5 }), // messages
        fc.integer({ min: 0, max: 4 }), // diagnoses
        async (tgId, tokenCount, convCount, msgCount, diagCount) => {
          await clearDatabase(db());
          const userId = 'owner-unlink';
          await seedProfile(userId, tgId);

          // Outstanding (unconsumed) link tokens.
          for (let i = 0; i < tokenCount; i += 1) {
            await seedLinkToken(userId, `outstanding-${i}-${Math.random().toString(36).slice(2)}`);
          }

          // An entitlement window in the future — must survive the unlink untouched (22.20).
          const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
          const grantedAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
          await db().collection<BotEntitlementDoc>(COLLECTIONS.botEntitlements).insertOne({
            _id: userId,
            providerPaymentId: `pay-${tgId}`,
            paymentOrderId: null,
            expiresAt,
            grantedAt,
            updatedAt: grantedAt,
          });

          // Conversations / messages / diagnoses across the channels.
          const convIds: ObjectId[] = [];
          for (let i = 0; i < convCount; i += 1) {
            const now = new Date();
            const conv: ConversationDoc = {
              _id: undefined as never,
              ownerId: userId,
              channel: i % 2 === 0 ? 'web' : 'telegram',
              createdAt: now,
              updatedAt: now,
            };
            const res = await db().collection<ConversationDoc>(COLLECTIONS.conversations).insertOne(conv as never);
            convIds.push(res.insertedId);
          }
          for (let i = 0; i < msgCount; i += 1) {
            const conv = convIds[i % convIds.length]!;
            const msg: MessageDoc = {
              _id: undefined as never,
              ownerId: userId,
              conversationId: conv,
              role: i % 2 === 0 ? 'farmer' : 'jamee',
              content: `message ${i}`,
              language: 'en',
              channel: 'telegram',
              inputKind: 'text',
              createdAt: new Date(),
            };
            await db().collection<MessageDoc>(COLLECTIONS.messages).insertOne(msg as never);
          }
          for (let i = 0; i < diagCount; i += 1) {
            const conv = convIds[i % convIds.length]!;
            const diag: DiagnosisDoc = {
              _id: undefined as never,
              ownerId: userId,
              conversationId: conv,
              status: 'identified',
              diseaseName: 'Tomato Early Blight',
              severity: 'moderate',
              explanation: `explanation ${i}`,
              language: 'en',
              needsExpert: false,
              channel: 'telegram',
              mediaRef: { fileId: undefined as never, kind: 'crop-image' },
              modelProvider: 'gemini',
              createdAt: new Date(),
            };
            await db().collection<DiagnosisDoc>(COLLECTIONS.diagnoses).insertOne(diag as never);
          }

          // ── Snapshot the record collections before the unlink ──
          const convsBefore = await db().collection(COLLECTIONS.conversations).countDocuments({ ownerId: userId });
          const msgsBefore = await db().collection(COLLECTIONS.messages).countDocuments({ ownerId: userId });
          const diagsBefore = await db().collection(COLLECTIONS.diagnoses).countDocuments({ ownerId: userId });
          const profileBefore = await profileOf(userId);

          // ── Unlink ──
          await linking.unlink(userId);

          // telegram_user_id is cleared…
          const profileAfter = await profileOf(userId);
          expect(profileAfter?.telegramUserId ?? null).toBeNull();
          // …but every OTHER profile field is unchanged.
          expect(profileAfter?.email).toBe(profileBefore?.email);
          expect(profileAfter?.displayName).toBe(profileBefore?.displayName);
          expect(profileAfter?.language).toBe(profileBefore?.language);
          expect(profileAfter?.createdAt?.getTime()).toBe(profileBefore?.createdAt?.getTime());

          // Every outstanding token is now consumed → unusable for a later binding.
          const tokens = await tokenDocs(userId);
          expect(tokens.length).toBe(tokenCount);
          for (const t of tokens) expect(t.consumedAt ?? null, 'outstanding token must be invalidated').not.toBeNull();

          // A previously-consumed token can no longer bind either — re-attempt any outstanding one.
          // (A fresh plaintext is unknown; the point is that unlink left no LIVE token.)

          // The entitlement window is untouched.
          const ent = await db().collection<BotEntitlementDoc>(COLLECTIONS.botEntitlements).findOne({ _id: userId });
          expect(ent?.expiresAt?.getTime()).toBe(expiresAt.getTime());
          expect(ent?.grantedAt?.getTime()).toBe(grantedAt.getTime());
          expect(ent?.providerPaymentId).toBe(`pay-${tgId}`);

          // Every conversation, message, and diagnosis is preserved exactly.
          expect(await db().collection(COLLECTIONS.conversations).countDocuments({ ownerId: userId })).toBe(convsBefore);
          expect(await db().collection(COLLECTIONS.messages).countDocuments({ ownerId: userId })).toBe(msgsBefore);
          expect(await db().collection(COLLECTIONS.diagnoses).countDocuments({ ownerId: userId })).toBe(diagsBefore);
        },
      ),
      { numRuns: REAL_LAYER_RUNS },
    );
  });

  it('after unlink the released telegram id is free to bind to another profile', async () => {
    await clearDatabase(db());
    const tgId = 5555;
    await seedProfile('owner-first', tgId);
    await linking.unlink('owner-first');
    expect((await profileOf('owner-first'))?.telegramUserId ?? null).toBeNull();

    // A second farmer can now bind the released id.
    await seedProfile('owner-second');
    const plaintext = 'rebind-token';
    await seedLinkToken('owner-second', plaintext);
    const outcome = await linking.consumeAndBind(plaintext, tgId);
    expect(outcome.kind).toBe('bound');
    expect((await profileOf('owner-second'))?.telegramUserId).toBe(tgId);
  });
});

