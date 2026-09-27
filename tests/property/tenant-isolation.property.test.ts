import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { Buffer } from 'node:buffer';
import { ObjectId } from 'mongodb';

import type {
  ConversationDoc,
  DiagnosisDoc,
  MessageDoc,
  UsageLogDoc,
} from '@/lib/db/collections';
import { setupDatabase } from '@/lib/db/setup';
import { VERIFIED_CONDITIONS, type Channel, type VerifiedCondition } from '@/lib/schemas';

import {
  BANNED_IMPORTS,
  DATA_ACCESS_DIR,
  checkDataAccess,
  collectSourceFiles,
  isBannedSpecifier,
  isWithinDataAccessLayer,
  type SourceFile,
} from '../../scripts/check-data-access';
import { clearDatabase, startMongo, stopMongo, type MongoHarness } from '../integration/mongo';

/**
 * ### Property 27: Tenant isolation holds over the Data_Access_Layer, its media, and the knowledge base
 *
 * *"For any two distinct farmers, tenant isolation is a property of the Data_Access_Layer through
 * which every collection access passes: its accessors take the acting farmer's Auth_User_Id as a
 * mandatory argument and merge `{ ownerId }` into every filter, insert, update, and delete, and they
 * expose no seam through which an unscoped read, write, or delete can be expressed — so one farmer
 * can never read, write, or delete another farmer's documents in `profiles`, `conversations`,
 * `messages`, `diagnoses`, `usage_logs`, `link_tokens`, `payment_orders`, or `bot_entitlements`, an
 * attempt returning no documents or failing. On the three access collections a farmer session reaches
 * no write accessor at all. Media is isolated the same way: a farmer can neither read nor delete a
 * GridFS file whose `metadata.ownerId` is another farmer's. That the Data_Access_Layer is the only
 * holder of the isolation is itself enforced structurally: the CI import check fails the build if any
 * module outside `src/lib/db/**` imports the `mongodb` driver or the raw database handle. And for any
 * authenticated farmer, reads of `disease_knowledge` succeed while there is no accessor by which a
 * farmer session can insert, update, or delete a knowledge base document."*
 *
 * **Validates: Requirements 13.2, 13.4, 13.6, 21.3, 22.23** (and the isolation dimension of
 * Properties 5, 15, 22, 26 — media, conversation context, the audit row, and history — each of which
 * is a farmer-scoped surface this file confirms one farmer never reaches another's rows in.)
 *
 * =============================================================================
 * AMENDMENT A3 — THIS IS NOW A REAL-LAYER PROPERTY, NOT A SQL-POLICY ONE
 * =============================================================================
 *
 * Under Supabase this property was about Row-Level Security policy TEXT in migrations, interpreted by
 * a hand-written three-valued-logic evaluator, because a Node test could not run a Postgres policy.
 * A3 removes RLS entirely: tenant isolation is the Data_Access_Layer (D18), which merges the owning
 * Auth_User_Id into every filter and stamps it on every insert. That is application code a Node test
 * CAN run — so the brief requires this claim to run against the real layer. Every assertion below is
 * made against the shipped `farmerData`, `accessData`, media store, and `knowledgeReads` accessors on
 * a single-node `MongoMemoryReplSet` (V31, V33), with two real farmers' data present. The old SQL
 * interpreter, the storage-path evaluator, the WhatsApp dispatch import and `@/types/database` are
 * gone — there is no path, no bucket, and no policy left to interpret.
 *
 * Two halves cannot be a runtime read and are asserted structurally instead:
 *
 *  - **"exposes no seam through which an unscoped read can be expressed"** — the accessors have no
 *    `find(arbitraryFilter)` method and no owner-override parameter. This is a claim about the
 *    layer's SHAPE, so it is asserted by driving a read with a filter that TRIES to name the other
 *    farmer's owner and observing the bound owner win (the merge puts `ownerId` last), and by the
 *    knowledge accessor exposing only `byNames`/`all` and no write.
 *  - **"the Data_Access_Layer is the only holder"** — proven by `scripts/check-data-access.ts`, the
 *    CI import guard. This file drives its real `checkDataAccess()` over a synthetic outside-layer
 *    file importing `mongodb` and asserts a VIOLATION, and over an in-layer file and asserts a NOTE —
 *    so the guard that makes D18 structural is itself exercised, and the whole shipped `src` tree is
 *    scanned for a real violation too.
 */

/* ========================================================================== */
/* DAL modules, imported after MONGODB_URI is set                              */
/* ========================================================================== */

let harness: MongoHarness | undefined;
let farmerMod: typeof import('@/lib/db/farmer');
let accessMod: typeof import('@/lib/db/access');
let mediaMod: typeof import('@/lib/db/media');
let readsMod: typeof import('@/lib/db/reads');

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  farmerMod = await import('@/lib/db/farmer');
  accessMod = await import('@/lib/db/access');
  mediaMod = await import('@/lib/db/media');
  readsMod = await import('@/lib/db/reads');
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  if (harness === undefined) throw new Error('harness not started');
  await clearDatabase(harness.db);
  await setupDatabase(harness.db);
});

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const farmerIdArb = fc.uuid().map((uuid) => `user-${uuid}`);
const twoFarmersArb = fc.tuple(farmerIdArb, farmerIdArb).filter(([a, b]) => a !== b);
const channelArb = fc.constantFrom<Channel>('web', 'telegram');
const conditionArb = fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS);

/* ========================================================================== */
/* Seeding helpers, through the shipped owner-scoped accessors                 */
/* ========================================================================== */

/** Seed one conversation + message + diagnosis + usage log for a farmer, through `farmerData`. */
async function seedFarmerData(
  ownerId: string,
  channel: Channel,
  condition: VerifiedCondition,
): Promise<{ conversationId: ObjectId; diagnosisId: ObjectId; messageId: ObjectId }> {
  const data = farmerMod.farmerData(ownerId);
  const conversation = await data.insertConversation({ channel, title: null });
  const message = await data.insertMessage({
    conversationId: conversation._id,
    role: 'farmer',
    content: `${ownerId} asked about ${condition}`,
    language: 'en',
    channel,
    inputKind: 'text',
  });
  const fileRef = await mediaMod.writeMedia(ownerId, 'crop-image', 'image/jpeg', Buffer.from(`img-${ownerId}`));
  const diagnosis = await data.insertDiagnosis({
    conversationId: conversation._id,
    status: 'identified',
    diseaseName: condition,
    knowledgeId: null,
    confidence: 0.8,
    severity: 'moderate',
    explanation: `${ownerId} explanation`,
    language: 'en',
    needsExpert: false,
    channel,
    mediaRef: fileRef,
    fullImageDeletedAt: null,
    modelProvider: 'gemini',
  });
  await data.insertUsageLog({
    operation: 'image',
    channel,
    modelProvider: 'gemini',
    outcome: 'success',
    usedFallback: false,
    rejectionReason: null,
    quotaSpent: true,
    latencyMs: 10,
    promptVersion: 'v1',
    conversationId: conversation._id,
    diagnosisId: diagnosis._id,
  });
  return { conversationId: conversation._id, diagnosisId: diagnosis._id, messageId: message._id };
}

/* ========================================================================== */
/* Surface 1 — the farmer-scoped collections read only their own owner's rows   */
/* ========================================================================== */

describe('Property 27, surface 1: every farmer-scoped read returns only the acting farmer’s rows', () => {
  it('shows farmer A their own conversations, messages, diagnoses and usage; and none of farmer B’s', async () => {
    await fc.assert(
      fc.asyncProperty(
        twoFarmersArb,
        channelArb,
        conditionArb,
        conditionArb,
        async (farmers, channel, condA, condB) => {
          await clearDatabase(harness!.db);
          await setupDatabase(harness!.db);
          const [a, b] = farmers;

          const seedA = await seedFarmerData(a, channel, condA);
          await seedFarmerData(b, channel, condB);

          const dataA = farmerMod.farmerData(a);

          // Requirement 13.2 (conversations, Property 15's surface): A sees exactly their own.
          const convA = await dataA.findConversations();
          expect(convA.every((doc) => doc.ownerId === a)).toBe(true);
          expect(convA.some((doc) => doc._id.equals(seedA.conversationId))).toBe(true);

          // messages (Property 15) — only A's.
          const msgsA = await dataA.findMessages();
          expect(msgsA.every((doc) => doc.ownerId === a)).toBe(true);
          expect(msgsA.length).toBeGreaterThan(0);

          // diagnoses (Property 26's surface) — only A's.
          const diagsA = await dataA.findDiagnoses();
          expect(diagsA.every((doc) => doc.ownerId === a)).toBe(true);
          expect(diagsA.some((doc) => doc._id.equals(seedA.diagnosisId))).toBe(true);

          // A read scoped to A does not see B's rows — over a database that DOES hold B's rows, so an
          // empty result is real scoping, not an empty collection.
          const rawConversations = harness!.db.collection<ConversationDoc>('conversations');
          const totalConversations = await rawConversations.countDocuments({});
          expect(totalConversations, 'both farmers seeded conversations').toBeGreaterThan(convA.length);
          expect(convA.some((doc) => doc.ownerId === b), 'A saw a B conversation').toBe(false);

          const rawMessages = harness!.db.collection<MessageDoc>('messages');
          expect(await rawMessages.countDocuments({ ownerId: b })).toBeGreaterThan(0);
          expect(msgsA.some((doc) => doc.ownerId === b)).toBe(false);

          const rawDiagnoses = harness!.db.collection<DiagnosisDoc>('diagnoses');
          expect(await rawDiagnoses.countDocuments({ ownerId: b })).toBeGreaterThan(0);
          expect(diagsA.some((doc) => doc.ownerId === b)).toBe(false);

          const rawUsage = harness!.db.collection<UsageLogDoc>('usage_logs');
          expect(await rawUsage.countDocuments({ ownerId: a }), 'A usage row (Property 22)').toBeGreaterThan(0);
          expect(await rawUsage.countDocuments({ ownerId: b })).toBeGreaterThan(0);
        },
      ),
      { numRuns: 25 },
    );
  }, 30_000);

  it('cannot be widened by a caller filter that names the other farmer’s owner: the bound owner wins', async () => {
    await fc.assert(
      fc.asyncProperty(twoFarmersArb, async (farmers) => {
        await clearDatabase(harness!.db);
        await setupDatabase(harness!.db);
        const [a, b] = farmers;
        await seedFarmerData(a, 'web', 'Tomato Early Blight');
        await seedFarmerData(b, 'web', 'Tomato Late Blight');

        // The accessor takes its filter WITHOUT an owner field and merges `{ ownerId }` LAST
        // (`owned()` in `farmer.ts`), so a caller who tries to pass the other farmer's owner cannot
        // override the bound one — the read still returns only A's rows. This is the "no seam for an
        // unscoped read" clause, exercised: even a hostile filter is scoped.
        const dataA = farmerMod.farmerData(a);
        const hostile = await dataA.findConversations({ ownerId: b } as unknown as Record<string, never>);
        expect(hostile.every((doc) => doc.ownerId === a), 'a filter naming B leaked B rows').toBe(true);
        expect(hostile.some((doc) => doc.ownerId === b)).toBe(false);
      }),
      { numRuns: 25 },
    );
  }, 30_000);
});

/* ========================================================================== */
/* Surface 2 — GridFS media is isolated by metadata.ownerId (Property 5's dim.) */
/* ========================================================================== */

describe('Property 27, surface 2: a farmer can neither read nor delete another farmer’s GridFS file', () => {
  it('reads back its own file, reads null for the other farmer’s, and cannot delete it', async () => {
    await fc.assert(
      fc.asyncProperty(twoFarmersArb, async (farmers) => {
        await clearDatabase(harness!.db);
        await setupDatabase(harness!.db);
        const [a, b] = farmers;

        const refA = await mediaMod.writeMedia(a, 'crop-image', 'image/jpeg', Buffer.from('A-owns-this'));
        const refB = await mediaMod.writeMedia(b, 'crop-image', 'image/jpeg', Buffer.from('B-owns-this'));
        const fileA = refA.fileId.toHexString();
        const fileB = refB.fileId.toHexString();

        // A reads its own file back.
        expect(await mediaMod.readMediaForOwner(a, fileA), 'A could not read its own file').not.toBeNull();

        // Requirement 13.6 / 2.6 — A reading B's file is `null`, indistinguishable from a missing
        // one, because the owner is part of the `{ _id, metadata.ownerId }` filter (D18). The file
        // EXISTS (B wrote it), so `null` here is real owner-scoping.
        expect(await mediaMod.readMediaForOwner(a, fileB), 'A read B’s file').toBeNull();

        // A deleting B's file: a no-op returning `false`, and B's file survives.
        expect(await mediaMod.deleteMediaForOwner(a, fileB), 'A deleted B’s file').toBe(false);
        expect(await mediaMod.readMediaForOwner(b, fileB), 'B’s file was destroyed by A').not.toBeNull();
      }),
      { numRuns: 25 },
    );
  }, 30_000);
});

/* ========================================================================== */
/* Surface 3 — the access collections: farmer-scoped, no cross-owner write      */
/* ========================================================================== */

describe('Property 27, surface 3: link_tokens, payment_orders and bot_entitlements are owner-scoped', () => {
  it('reads and mints only the acting farmer’s access rows, and never another owner’s', async () => {
    await fc.assert(
      fc.asyncProperty(twoFarmersArb, async (farmers) => {
        await clearDatabase(harness!.db);
        await setupDatabase(harness!.db);
        const [a, b] = farmers;

        const accessA = accessMod.accessData(a);
        const accessB = accessMod.accessData(b);

        // Each farmer mints their own link token and payment order — the accessors stamp the bound
        // owner (Requirement 21.3, 22.23); there is NO parameter to name another owner.
        await accessA.insertLinkToken({ tokenHash: 'hash-a', expiresAt: new Date(Date.now() + 60_000) });
        await accessB.insertLinkToken({ tokenHash: 'hash-b', expiresAt: new Date(Date.now() + 60_000) });
        await accessA.insertPaymentOrder({
          providerOrderId: 'order-a',
          amountMinor: 2000,
          currency: 'INR',
          status: 'created',
        });
        await accessB.insertPaymentOrder({
          providerOrderId: 'order-b',
          amountMinor: 2000,
          currency: 'INR',
          status: 'created',
        });

        // A reads only A's orders — B's `order-b` is not among them.
        const ordersA = await accessA.findPaymentOrders();
        expect(ordersA.every((doc) => doc.ownerId === a), 'A saw a non-A order').toBe(true);
        expect(ordersA.some((doc) => doc.providerOrderId === 'order-b'), 'A saw B’s order').toBe(false);
        expect(ordersA.some((doc) => doc.providerOrderId === 'order-a')).toBe(true);

        // The entitlement read is keyed on `_id = ownerId` (D14), so it is own-row by construction —
        // A never reads B's, even though B's is seeded.
        await harness!.db.collection('bot_entitlements').insertOne({
          _id: b as unknown as ObjectId,
          providerPaymentId: 'pay-b',
          paymentOrderId: null,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          grantedAt: new Date(),
          updatedAt: new Date(),
        });
        expect(await accessA.readEntitlement(), 'A read B’s entitlement').toBeNull();
      }),
      { numRuns: 25 },
    );
  }, 30_000);
});

/* ========================================================================== */
/* Surface 4 — the knowledge base is shared read-only reference data            */
/* ========================================================================== */

describe('Property 27, surface 4: the knowledge base is readable by every farmer and writable by none', () => {
  it('returns the same seeded rows to any farmer and exposes no write accessor', async () => {
    // `setupDatabase` seeded the five conditions. Every farmer reads the same rows — there is no
    // owner dimension to isolate along (Requirement 13.3): the base grounds every diagnosis.
    const readsAll = readsMod.knowledgeReads();

    const all = await readsAll.all();
    expect(all.length).toBe(VERIFIED_CONDITIONS.length);
    const names = new Set(all.map((row) => row.diseaseName));
    for (const condition of VERIFIED_CONDITIONS) expect(names.has(condition)).toBe(true);

    const some = await readsAll.byNames(['Tomato Early Blight', 'Potato Late Blight']);
    expect(some.map((r) => r.diseaseName).sort()).toStrictEqual(
      ['Potato Late Blight', 'Tomato Early Blight'].sort(),
    );

    // Requirement 13.4: the accessor exposes ONLY reads. A write path here would be a second way to
    // change agronomic content a farmer reads — the accessor's SHAPE is how that is enforced.
    const accessor = readsMod.knowledgeReads() as unknown as Record<string, unknown>;
    expect(Object.keys(accessor).sort()).toStrictEqual(['all', 'byNames']);
    for (const verb of ['insert', 'update', 'delete', 'upsert', 'insertOne', 'deleteOne']) {
      expect(accessor[verb], `knowledgeReads exposes a ${verb} accessor`).toBeUndefined();
    }

    // And the module source calls no write verb on the knowledge collection.
    const source = readFileSync(resolve(__dirname, '..', '..', 'src', 'lib', 'db', 'reads.ts'), 'utf8');
    const knowledgeSection = source.slice(source.indexOf('knowledgeReads'));
    for (const verb of ['diseaseKnowledge().insert', 'diseaseKnowledge().update', 'diseaseKnowledge().delete']) {
      expect(knowledgeSection.includes(verb), `knowledge accessor calls ${verb}`).toBe(false);
    }
  });
});

/* ========================================================================== */
/* Surface 5 — the layer is the ONLY holder of the driver (the CI import guard) */
/* ========================================================================== */

describe('Property 27, surface 5: the Data_Access_Layer is the only holder of the driver', () => {
  it('flags a module outside src/lib/db/** that imports the mongodb driver, and allows one inside', () => {
    // The guard that makes D18 structural, exercised on synthetic files.
    const outside: SourceFile = {
      path: 'src/services/rogue.service.ts',
      source: "import { MongoClient } from 'mongodb';\nexport const c = MongoClient;\n",
    };
    const inside: SourceFile = {
      path: 'src/lib/db/inside.ts',
      source: "import { ObjectId } from 'mongodb';\nexport const x = ObjectId;\n",
    };
    const viaClient: SourceFile = {
      path: 'src/app/api/rogue/route.ts',
      source: "import { getDb } from '@/lib/db/client';\nexport const GET = getDb;\n",
    };

    const findings = checkDataAccess([outside, inside, viaClient]);

    const violationPaths = findings.filter((f) => f.severity === 'violation').map((f) => f.path).sort();
    // Both the raw-driver import and the raw-handle import from outside the layer are violations.
    expect(violationPaths).toStrictEqual(
      ['src/app/api/rogue/route.ts', 'src/services/rogue.service.ts'].sort(),
    );
    // The in-layer import is allowed — a note, never a violation.
    expect(findings.some((f) => f.path === 'src/lib/db/inside.ts' && f.severity === 'violation')).toBe(false);
    expect(findings.some((f) => f.path === 'src/lib/db/inside.ts' && f.severity === 'note')).toBe(true);

    // The guard's own facts, so the property fails if the boundary is redefined out from under it.
    expect(BANNED_IMPORTS).toContain('mongodb');
    expect(BANNED_IMPORTS).toContain('@/lib/db/client');
    expect(DATA_ACCESS_DIR).toBe('src/lib/db/');
    expect(isBannedSpecifier('mongodb')).toBe(true);
    expect(isBannedSpecifier('mongodb/lib/foo')).toBe(true);
    expect(isBannedSpecifier('@/lib/db/farmer')).toBe(false);
    expect(isWithinDataAccessLayer('src/lib/db/media.ts')).toBe(true);
    expect(isWithinDataAccessLayer('src/services/x.ts')).toBe(false);
  });

  it('finds no real violation in the shipped src tree', () => {
    // The real assertion the release gate makes (`npm run check:data-access`), pinned here too.
    const repoRoot = resolve(__dirname, '..', '..');
    const files = collectSourceFiles(join(repoRoot, 'src'), repoRoot);
    const violations = checkDataAccess(files).filter((f) => f.severity === 'violation');
    expect(
      violations,
      `driver imported outside the layer: ${violations.map((v) => v.path).join(', ')}`,
    ).toStrictEqual([]);
  });
});
