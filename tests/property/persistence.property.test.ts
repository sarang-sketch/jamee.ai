import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { ObjectId } from 'mongodb';

import type { CapabilityRunner } from '@/lib/ai/capabilities';
import { Buffer } from 'node:buffer';
import type { DiagnosisInsert } from '@/lib/db/analysis';
import type { MessageRecord } from '@/lib/db/reads';
import type { UsageLogInsert } from '@/lib/db/usage-log';
import { AppError } from '@/lib/errors';
import { setupDatabase } from '@/lib/db/setup';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import {
  HEALTHY_CONDITION,
  SUPPORTED_LANGUAGES,
  VERIFIED_CONDITIONS,
  channelSchema,
  inputKindSchema,
  type Channel,
  type ChatInput,
  type InputKind,
  type Language,
  type MediaRef,
  type VerifiedCondition,
} from '@/lib/schemas';
import {
  type ChatTurnDeps,
  type ChatWriteStore,
  type ContextStore,
  type MessageInsert,
} from '@/services/chat.service';
import type { DiagnosisDeps, DiagnosisStore } from '@/services/diagnosis.service';
import {
  coveredBy,
  ownsRequest,
  reserveForRequest,
  type CounterRpc,
  type QuotaContext,
} from '@/services/quota.service';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from '../integration/mongo';

/**
 * ### Property 17: Conversation and message persistence round-trips, carrying the channel
 *
 * *"For any chat exchange, exactly one farmer message and one Jamee answer are persisted in the same
 * conversation with the correct roles; for any diagnosis request submitted without a conversation
 * identifier, a conversation is created and the diagnosis references it; and for any operation on
 * either channel, every persisted document records the channel value supplied to the service."*
 *
 * **Validates: Requirements 3.3, 7.4, 7.5, 16.5**
 *
 * =============================================================================
 * THE CLAIM IS ABOUT DOCUMENTS, SO EVERY ASSERTION READS A DOCUMENT (Amendment A3)
 * =============================================================================
 *
 * The returned object is not evidence. So each clause is decided on the persisted document:
 *
 *  - **`conversations`** is observed one layer deep, through the **real** Data_Access_Layer on a
 *    single-node `MongoMemoryReplSet` (V31, V33). It has to be: under A3 the `{ ownerId, channel }`
 *    insert body for a conversation is composed *inside* `conversation.service.ts` over the
 *    owner-scoped layer (`conversationStoreFrom()` ignores any argument and binds `farmerData`), so
 *    a `ConversationStore` seam would have let the fixture supply the very column the property is
 *    about. Everything the two services do to a conversation — the find-or-create read, its total
 *    order, the read-back, the create — runs as shipped against that layer, and the created row is
 *    read back out of the `conversations` collection.
 *  - **`messages`, `diagnoses`, `usage_logs`** are observed at their persistence seams
 *    (`ChatWriteStore`, `DiagnosisStore`), which is where the fully composed insert document is
 *    handed over — the document the Data_Access_Layer converts to a `MessageDoc`/`DiagnosisDoc` and
 *    stamps the owner on. That the layer then writes it owner-stamped is Property 27's claim;
 *    Property 17's is that the service composed the right document, and the seam is where that is
 *    observable without a second read.
 *
 * The return values are still checked, but only as a **bridge**: the ids a farmer's client receives
 * must be the ids of the documents that were written.
 *
 * =============================================================================
 * WHAT "EVERY OPERATION ON EITHER CHANNEL" IS GENERATED OVER
 * =============================================================================
 *
 * Both channels (`web`, `telegram`), and all three of `InputKind`'s values:
 *
 *  - **`text`** — `chatTurn()` with `inputKind: 'text'`, as `/api/chat` calls it.
 *  - **`voice`** — `chatTurn()` with `inputKind: 'voice'`, a `transcriptOf` Media_Reference,
 *    `skipQuotaReserve: true` and a real `coveredBy()` reservation, exactly the `ChatInput`
 *    `voice.service.ts` composes. The boolean alone is a wiring defect (`quotaContextFor()` throws),
 *    so the coverage is a genuine reservation taken through `reserveForRequest()`.
 *  - **`image`** — `diagnose()`, which persists a `diagnoses` document rather than a `messages` one.
 *
 * =============================================================================
 * CLAUSE 2 IS A PAIR OF CASES, NOT ONE
 * =============================================================================
 *
 *  - **absent** — the farmer has no conversation yet, `diagnose()` must create exactly one, and the
 *    persisted diagnosis must reference the created row.
 *  - **supplied** — a conversation already exists, and `diagnose()` must create **nothing** and
 *    reference the id it was given.
 *
 * numRuns is 40 (not the pre-A3 320): each run seeds/reads through the real replica set, so a larger
 * count would exceed the 30-second per-test timeout. Generator breadth is unchanged, and the
 * coverage assertions still require every class to have been produced.
 */

/* ========================================================================== */
/* DAL / service modules, imported after MONGODB_URI is set                    */
/* ========================================================================== */

let harness: MongoHarness | undefined;
let chatMod: typeof import('@/services/chat.service');
let diagnosisMod: typeof import('@/services/diagnosis.service');
let conversationMod: typeof import('@/services/conversation.service');

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  chatMod = await import('@/services/chat.service');
  diagnosisMod = await import('@/services/diagnosis.service');
  conversationMod = await import('@/services/conversation.service');
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

function db() {
  if (harness === undefined) throw new Error('harness not started');
  return harness.db;
}

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

/** 2026-09-16T01:30:00Z. Fixed, so a run owns its clock and never reads the wall clock. */
const NOW_MS = Date.parse('2026-09-16T01:30:00.000Z');

const CHANNELS = channelSchema.options;
const INPUT_KINDS = inputKindSchema.options;

const CROP_OF: Record<VerifiedCondition, KnowledgeEntry['crop']> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

function hexId(seed: number): string {
  return seed.toString(16).padStart(24, '0');
}

const KNOWLEDGE_ROWS: readonly KnowledgeEntry[] = VERIFIED_CONDITIONS.map((condition, index) => {
  const healthy = condition === HEALTHY_CONDITION;
  return {
    id: hexId(index + 1),
    disease_name: condition,
    crop: CROP_OF[condition],
    scientific_name: healthy ? null : `${condition} pathogen`,
    symptoms: [`${condition} symptom line`],
    causes: [`${condition} cause line`],
    treatment: healthy ? [] : [`${condition} treatment line`],
    prevention: [`${condition} prevention line`],
    default_severity: healthy ? 'none' : 'moderate',
    source: `${condition} extension bulletin`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
});

function entryFor(condition: VerifiedCondition): KnowledgeEntry {
  const found = KNOWLEDGE_ROWS.find((row) => row.disease_name === condition);
  if (found === undefined) throw new Error(`no generated row for "${condition}"`);
  return found;
}

const OUT_OF_SCOPE_QUESTIONS: readonly string[] = [
  'how much water does wheat need in summer',
  'which fertilizer suits sugarcane in this season',
  'when should I sow onions',
];

const FOLLOW_UP_QUESTIONS: readonly string[] = ['why?', 'what should I do now', 'how serious is it'];

/** A 24-hex GridFS `_id`, so a Media_Reference satisfies `mediaRefSchema` (A3). */
function fileId(): string {
  return new ObjectId().toHexString();
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const CHAT_BRANCHES = ['grounded', 'referral', 'degraded'] as const;
type ChatBranch = (typeof CHAT_BRANCHES)[number];

const DIAGNOSIS_OUTCOMES = ['identified', 'inconclusive'] as const;
type DiagnosisOutcomeKind = (typeof DIAGNOSIS_OUTCOMES)[number];

const CONVERSATION_ROUTES = ['created_inside_the_service', 'supplied_by_the_caller'] as const;
type ConversationRoute = (typeof CONVERSATION_ROUTES)[number];

interface Scenario {
  readonly inputKind: InputKind;
  readonly channel: Channel;
  readonly language: Language;
  readonly condition: VerifiedCondition;
  readonly chatBranch: ChatBranch;
  readonly diagnosisOutcome: DiagnosisOutcomeKind;
  /** Only read on the image kind: whether the request carries a conversation identifier. */
  readonly suppliesConversation: boolean;
  readonly questionIndex: number;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  inputKind: fc.constantFrom<InputKind>(...INPUT_KINDS),
  channel: fc.constantFrom<Channel>(...CHANNELS),
  language: fc.constantFrom<Language>(...SUPPORTED_LANGUAGES),
  condition: fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS),
  chatBranch: fc.constantFrom<ChatBranch>(...CHAT_BRANCHES),
  diagnosisOutcome: fc.constantFrom<DiagnosisOutcomeKind>(...DIAGNOSIS_OUTCOMES),
  suppliesConversation: fc.boolean(),
  questionIndex: fc.integer({ min: 0, max: 2 }),
});

function questionFor(scenario: Scenario): string {
  const pool = scenario.chatBranch === 'referral' ? OUT_OF_SCOPE_QUESTIONS : FOLLOW_UP_QUESTIONS;
  return pool[scenario.questionIndex % pool.length] ?? 'why?';
}

/** The counter, always allowing. What a quota costs is Property 20's claim, not this one's. */
function countingRpc(): CounterRpc {
  return {
    tryIncrement: () => Promise.resolve(1),
    decrement: () => Promise.resolve(0),
    used: () => Promise.resolve(0),
  };
}

/* ========================================================================== */
/* The chat harness (messages/usage at the seam; conversation via the real DAL) */
/* ========================================================================== */

interface ChatRecorded {
  readonly messageRows: MessageInsert[];
  readonly usageRows: UsageLogInsert[];
  readonly touches: { readonly conversationId: string; readonly userId: string }[];
  readonly ownershipChecks: { readonly conversationId: string; readonly userId: string }[];
  counts: { turns: number; generate: number; classify: number };
}

function chatHarness(options: {
  readonly branch: ChatBranch;
  readonly condition: VerifiedCondition;
  readonly conversationId: string;
  readonly userId: string;
}): { readonly deps: ChatTurnDeps; readonly recorded: ChatRecorded } {
  const recorded: ChatRecorded = {
    messageRows: [],
    usageRows: [],
    touches: [],
    ownershipChecks: [],
    counts: { turns: 0, generate: 0, classify: 0 },
  };

  const store: ContextStore = {
    recentMessages: () => Promise.resolve([]),
    latestDiagnosis: () =>
      Promise.resolve(
        options.branch === 'referral'
          ? null
          : diagnosisRecordFor(options.conversationId, options.userId, options.condition),
      ),
  };

  const knowledge: KnowledgeReader = (names) =>
    Promise.resolve(KNOWLEDGE_ROWS.filter((row) => names.includes(row.disease_name)));

  const models: CapabilityRunner = {
    classify: () => {
      recorded.counts.classify += 1;
      return Promise.reject(new Error('a chat turn asked the vision capability for a judgement'));
    },
    generate: () => {
      recorded.counts.generate += 1;
      if (options.branch === 'degraded') {
        return Promise.reject(
          new AppError('PROVIDERS_UNAVAILABLE', { context: { reason: 'test_chain_exhausted' } }),
        );
      }
      const entry = entryFor(options.condition);
      return Promise.resolve({
        value: `${entry.disease_name}. ${entry.symptoms[0] ?? ''}`,
        provider: 'gemini' as const,
        usedFallback: false,
      });
    },
  };

  const writes: ChatWriteStore = {
    insertTurn: (rows) => {
      recorded.counts.turns += 1;
      recorded.messageRows.push(...rows);
      const stored: MessageRecord[] = rows.map((row, index) => ({
        _id: new ObjectId(hexId(recorded.messageRows.length - rows.length + index + 1000)),
        ownerId: row.ownerId,
        conversationId: new ObjectId(row.conversationId),
        role: row.role,
        content: row.content,
        language: row.language,
        channel: row.channel,
        inputKind: row.inputKind,
        transcriptOf:
          row.transcriptOf === undefined
            ? null
            : { fileId: new ObjectId(row.transcriptOf.fileId), kind: row.transcriptOf.kind },
        createdAt: new Date(NOW_MS),
      }));
      return Promise.resolve(stored);
    },
    insertUsageLog: (row) => {
      recorded.usageRows.push(row);
      return Promise.resolve();
    },
    ownsConversation: (conversationId, userId) => {
      recorded.ownershipChecks.push({ conversationId, userId });
      // The real conversation exists in the DB (created by find-or-create before the turn); a
      // read-back through the layer would work too, but the id is already known-owned here.
      return Promise.resolve(true);
    },
    touchConversation: (conversationId, userId) => {
      recorded.touches.push({ conversationId, userId });
      return Promise.resolve(true);
    },
  };

  return {
    recorded,
    deps: {
      writes,
      store,
      knowledge,
      models,
      quota: { rpc: countingRpc(), now: new Date(NOW_MS) },
      now: () => NOW_MS,
      platformDeadline: () => undefined,
    },
  };
}

/** A diagnosis in this conversation, so a subject-less follow-up has a subject to resolve to. */
function diagnosisRecordFor(
  conversationId: string,
  userId: string,
  condition: VerifiedCondition,
): import('@/lib/db/reads').DiagnosisRecord {
  return {
    _id: new ObjectId(hexId(700)),
    ownerId: userId,
    conversationId: new ObjectId(conversationId),
    status: 'identified',
    diseaseName: condition,
    knowledgeId: new ObjectId(entryFor(condition).id),
    confidence: 0.87,
    severity: condition === HEALTHY_CONDITION ? 'none' : 'moderate',
    explanation: `${condition} explanation`,
    language: 'en',
    needsExpert: false,
    channel: 'web',
    mediaRef: { fileId: new ObjectId(hexId(701)), kind: 'crop-image' },
    fullImageDeletedAt: null,
    modelProvider: 'gemini',
    createdAt: new Date(NOW_MS - 3_600_000),
  };
}

/* ========================================================================== */
/* The diagnosis harness (diagnosis/usage at the seam; conversation via DAL)   */
/* ========================================================================== */

interface DiagnosisRecorded {
  readonly diagnosisRows: DiagnosisInsert[];
  readonly usageRows: UsageLogInsert[];
  readonly ownershipChecks: string[];
}

function diagnosisHarness(options: {
  readonly outcome: DiagnosisOutcomeKind;
  readonly condition: VerifiedCondition;
  readonly userId: string;
  readonly ownedConversationId: string | null;
}): { readonly deps: DiagnosisDeps; readonly recorded: DiagnosisRecorded } {
  const recorded: DiagnosisRecorded = { diagnosisRows: [], usageRows: [], ownershipChecks: [] };

  const models: CapabilityRunner = {
    classify: () =>
      Promise.resolve({
        value: JSON.stringify(
          options.outcome === 'identified'
            ? {
                status: 'identified',
                disease_name: options.condition,
                confidence: 0.8231,
                severity: options.condition === HEALTHY_CONDITION ? 'none' : 'moderate',
              }
            : { status: 'unclear', disease_name: null, confidence: 0, severity: 'none' },
        ),
        provider: 'gemini' as const,
        usedFallback: false,
      }),
    generate: () => {
      const entry = entryFor(options.condition);
      return Promise.resolve({
        value: `${entry.disease_name}. ${entry.symptoms[0] ?? ''}`,
        provider: 'gemini' as const,
        usedFallback: false,
      });
    },
  };

  const store: DiagnosisStore = {
    insertDiagnosis: (row) => {
      recorded.diagnosisRows.push(row);
      return Promise.resolve(hexId(2000 + recorded.diagnosisRows.length));
    },
    insertUsageLog: (row) => {
      recorded.usageRows.push(row);
      return Promise.resolve();
    },
    ownsConversation: (conversationId) => {
      recorded.ownershipChecks.push(conversationId);
      return Promise.resolve(conversationId === options.ownedConversationId);
    },
  };

  const knowledge: KnowledgeReader = (names) =>
    Promise.resolve(KNOWLEDGE_ROWS.filter((row) => names.includes(row.disease_name)));

  return {
    recorded,
    deps: {
      store,
      // The owner-scoped media read (A3): a few bytes and a MIME type. The classify seam base64s
      // whatever it gets; the property is about persistence, not the image.
      readMedia: () => Promise.resolve({ bytes: Buffer.from('image-bytes'), mimeType: 'image/jpeg' }),
      // The REAL conversation store over the Data_Access_Layer — see the header for why this one is
      // not a seam. `conversationStoreFrom()` ignores any argument and binds `farmerData`.
      conversations: conversationMod.conversationStoreFrom(),
      knowledge,
      models,
      quota: { rpc: countingRpc(), now: new Date(NOW_MS) },
      now: () => NOW_MS,
      platformDeadline: () => undefined,
    },
  };
}

/* ========================================================================== */
/* Readers over the recorded rows                                              */
/* ========================================================================== */

interface ChannelledRow {
  readonly table: string;
  readonly channel: Channel;
}

function channelledRowsOf(rows: {
  readonly conversations: readonly Channel[];
  readonly messages?: readonly MessageInsert[] | undefined;
  readonly diagnoses?: readonly DiagnosisInsert[] | undefined;
  readonly usageLogs: readonly UsageLogInsert[];
}): readonly ChannelledRow[] {
  return [
    ...rows.conversations.map((channel) => ({ table: 'conversations', channel })),
    ...(rows.messages ?? []).map((row) => ({ table: 'messages', channel: row.channel })),
    ...(rows.diagnoses ?? []).map((row) => ({ table: 'diagnoses', channel: row.channel })),
    ...rows.usageLogs.map((row) => ({ table: 'usage_logs', channel: row.channel })),
  ];
}

function roleOf(rows: readonly MessageInsert[], role: 'farmer' | 'jamee'): MessageInsert {
  const matched = rows.filter((row) => row.role === role);
  if (matched.length !== 1) throw new Error(`expected exactly one ${role} row, got ${matched.length}`);
  const [only] = matched;
  if (only === undefined) throw new Error(`no ${role} row`);
  return only;
}

/** Read a conversation document's channel back out of the collection. */
async function conversationChannel(conversationId: string): Promise<Channel> {
  const row = await db().collection('conversations').findOne({ _id: new ObjectId(conversationId) });
  if (row === null) throw new Error(`conversation ${conversationId} is not in the database`);
  return (row as unknown as { channel: Channel }).channel;
}

/** How many conversations this farmer owns right now. */
async function conversationCount(userId: string): Promise<number> {
  return db().collection('conversations').countDocuments({ ownerId: userId });
}

/* ========================================================================== */
/* Property 17                                                                 */
/* ========================================================================== */

describe('Property 17: conversation and message persistence round-trips, carrying the channel', () => {
  it('writes one farmer message and one answer per exchange, creates a conversation for a diagnosis that names none, and stamps the supplied channel on every document', async () => {
    const channelsSeen = new Set<Channel>();
    const inputKindsSeen = new Set<InputKind>();
    const languagesSeen = new Set<Language>();
    const chatBranchesSeen = new Set<ChatBranch>();
    const diagnosisOutcomesSeen = new Set<DiagnosisOutcomeKind>();
    const conversationRoutesSeen = new Set<ConversationRoute>();
    const tablesSeen = new Set<string>();
    let serial = 0;

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        serial += 1;
        const userId = `auth-user-persist-${serial}`;
        const { channel, language, inputKind } = scenario;

        channelsSeen.add(channel);
        inputKindsSeen.add(inputKind);
        languagesSeen.add(language);

        const label = `${inputKind} / ${channel} / ${language}`;

        /* ================================================================== */
        /* The image kind — Requirements 7.5, 3.3, 16.5                        */
        /* ================================================================== */

        if (inputKind === 'image') {
          diagnosisOutcomesSeen.add(scenario.diagnosisOutcome);

          const existing = scenario.suppliesConversation
            ? await conversationMod.findOrCreateActive(userId, channel)
            : null;

          const countBefore = await conversationCount(userId);
          const test = diagnosisHarness({
            outcome: scenario.diagnosisOutcome,
            condition: scenario.condition,
            userId,
            ownedConversationId: existing?.id ?? null,
          });

          const imageRef: MediaRef = { fileId: fileId(), kind: 'crop-image' };
          const outcome = await diagnosisMod.diagnose(
            {
              userId,
              image: imageRef,
              language,
              channel,
              ...(existing === null ? {} : { conversationId: existing.id }),
            },
            test.deps,
          );

          const countAfter = await conversationCount(userId);
          const persisted = test.recorded.diagnosisRows[0];
          if (persisted === undefined) throw new Error('no diagnosis row was persisted');
          expect(test.recorded.diagnosisRows, label).toHaveLength(1);

          if (existing === null) {
            conversationRoutesSeen.add('created_inside_the_service');
            // Requirement 7.5: exactly one conversation was created.
            expect(countAfter - countBefore, `${label}: the service did not create one conversation`).toBe(1);
            // The diagnosis references it, and that conversation is this farmer's on this channel.
            expect(persisted.conversationId, label).toBe(outcome.conversationId);
            expect(await conversationChannel(persisted.conversationId), label).toBe(channel);
            expect(test.recorded.ownershipChecks, label).toStrictEqual([]);
          } else {
            conversationRoutesSeen.add('supplied_by_the_caller');
            // The complement: nothing new was created, and the supplied id is referenced.
            expect(countAfter - countBefore, `${label}: a supplied conversation still created one`).toBe(0);
            expect(persisted.conversationId, label).toBe(existing.id);
            expect(existing.channel, label).toBe(channel);
            expect(test.recorded.ownershipChecks, label).toStrictEqual([existing.id]);
          }

          // Requirement 3.3's document set, on the row rather than in the return value.
          expect(persisted.mediaRef.fileId, label).toBe(imageRef.fileId);
          expect(persisted.mediaRef.kind, label).toBe('crop-image');
          expect(persisted.language, label).toBe(language);

          // Requirement 16.5 — every persisted document carries the channel it was given.
          const rows = channelledRowsOf({
            conversations: [await conversationChannel(persisted.conversationId)],
            diagnoses: test.recorded.diagnosisRows,
            usageLogs: test.recorded.usageRows,
          });
          expect(rows.length, `${label}: nothing was persisted`).toBeGreaterThan(0);
          for (const row of rows) {
            tablesSeen.add(row.table);
            expect(row.channel, `${label}: ${row.table} recorded the wrong channel`).toBe(channel);
          }

          // The bridge.
          expect(outcome.result.language, label).toBe(language);
          return;
        }

        /* ================================================================== */
        /* The text and voice kinds — Requirements 7.4, 16.5                   */
        /* ================================================================== */

        chatBranchesSeen.add(scenario.chatBranch);
        conversationRoutesSeen.add('supplied_by_the_caller');

        // `ChatInput.conversationId` is required (Requirement 7.2), so the thread is resolved first
        // — through the same shared find-or-create both channels use, over the real DAL.
        const conversation = await conversationMod.findOrCreateActive(userId, channel);
        expect(conversation.channel, `${label}: find-or-create ignored the channel`).toBe(channel);
        expect(await conversationCount(userId), label).toBe(1);

        const message = questionFor(scenario);
        const recording: MediaRef = { fileId: fileId(), kind: 'voice' };

        const test = chatHarness({
          branch: scenario.chatBranch,
          condition: scenario.condition,
          conversationId: conversation.id,
          userId,
        });

        // The voice kind is composed exactly as `voice.service.ts` composes it: the boolean AND a
        // real reservation (a `skipQuotaReserve: true` with no coverage is a wiring defect).
        let coverage: QuotaContext | undefined;
        if (inputKind === 'voice') {
          const reserved = await reserveForRequest(ownsRequest(userId, 'voice'), {
            rpc: countingRpc(),
            now: new Date(NOW_MS),
          });
          if (reserved.outcome !== 'allowed') throw new Error('the voice reserve was declined');
          coverage = coveredBy(reserved.reservation);
        }

        const input: ChatInput = {
          userId,
          conversationId: conversation.id,
          message,
          language,
          channel,
          inputKind,
          ...(inputKind === 'voice' ? { skipQuotaReserve: true, transcriptOf: recording } : {}),
        };

        const result = await chatMod.chatTurn(input, test.deps, coverage);

        /* Requirement 7.4 — exactly one farmer message and one answer. */
        expect(test.recorded.counts.turns, label).toBe(1);
        expect(test.recorded.messageRows, label).toHaveLength(2);

        const farmer = roleOf(test.recorded.messageRows, 'farmer');
        const jamee = roleOf(test.recorded.messageRows, 'jamee');

        expect(farmer.content, label).toBe(message);
        expect(jamee.content, label).toBe(result.answer.content);
        expect(jamee.content.length, label).toBeGreaterThan(0);

        expect(farmer.conversationId, label).toBe(conversation.id);
        expect(jamee.conversationId, label).toBe(conversation.id);
        expect(farmer.ownerId, label).toBe(userId);
        expect(jamee.ownerId, label).toBe(userId);

        expect(farmer.inputKind, label).toBe(inputKind);
        expect(jamee.inputKind, label).toBe('text');

        if (inputKind === 'voice') {
          // Requirement 8.9's provenance, on the row that carries the transcript and on no other —
          // a Media_Reference (`{ fileId, kind: 'voice' }`) under A3, not a storage path.
          expect(farmer.transcriptOf, label).toStrictEqual(recording);
          expect(jamee.transcriptOf, label).toBeUndefined();
        } else {
          expect(farmer.transcriptOf, label).toBeUndefined();
          expect(jamee.transcriptOf, label).toBeUndefined();
        }

        expect(test.recorded.ownershipChecks, label).toStrictEqual([
          { conversationId: conversation.id, userId },
        ]);
        expect(test.recorded.touches, label).toStrictEqual([
          { conversationId: conversation.id, userId },
        ]);

        expect(test.recorded.counts.classify, label).toBe(0);
        expect(test.recorded.counts.generate, label).toBe(scenario.chatBranch === 'referral' ? 0 : 1);

        /* Requirement 16.5 — the channel, on every document. */
        const rows = channelledRowsOf({
          conversations: [await conversationChannel(conversation.id)],
          messages: test.recorded.messageRows,
          usageLogs: test.recorded.usageRows,
        });
        expect(rows.length, `${label}: nothing was persisted`).toBeGreaterThan(0);
        for (const row of rows) {
          tablesSeen.add(row.table);
          expect(row.channel, `${label}: ${row.table} recorded the wrong channel`).toBe(channel);
        }

        // The bridge.
        expect(result.conversationId, label).toBe(conversation.id);
        expect(result.farmerMessageId, label).not.toBe(result.answer.messageId);
      }),
      // 40 runs against the real replica set; lowered from the pre-A3 320 so the suite stays inside
      // the 30-second per-test timeout. Generator breadth is unchanged.
      { numRuns: 40 },
    );

    /* Non-vacuity. */
    expect([...channelsSeen].sort()).toStrictEqual([...CHANNELS].sort());
    expect([...inputKindsSeen].sort()).toStrictEqual([...INPUT_KINDS].sort());
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
    expect([...chatBranchesSeen].sort()).toStrictEqual([...CHAT_BRANCHES].sort());
    expect([...diagnosisOutcomesSeen].sort()).toStrictEqual([...DIAGNOSIS_OUTCOMES].sort());
    expect([...conversationRoutesSeen].sort()).toStrictEqual([...CONVERSATION_ROUTES].sort());
    expect([...tablesSeen].sort()).toStrictEqual([
      'conversations',
      'diagnoses',
      'messages',
      'usage_logs',
    ]);
  });
});
