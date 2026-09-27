import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { ObjectId } from 'mongodb';

import type { CapabilityRunner, TextCall } from '@/lib/ai/capabilities';
import { isAppError } from '@/lib/errors';
import { setupDatabase } from '@/lib/db/setup';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import {
  HEALTHY_CONDITION,
  SUPPORTED_LANGUAGES,
  VERIFIED_CONDITIONS,
  type Channel,
  type Language,
  type MessageRole,
  type VerifiedCondition,
} from '@/lib/schemas';
import {
  CONTEXT_MESSAGE_LIMIT,
  assembleContext,
  type ContextStore,
  type ConversationScope,
} from '@/services/chat.service';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from '../integration/mongo';

/**
 * ### Property 15: Conversation context is complete for its conversation and isolated from every other
 *
 * *"For any two conversations belonging to any farmers, with arbitrarily interleaved message and
 * diagnosis timestamps, the context assembled for one conversation contains that conversation's most
 * recent diagnosis and only messages belonging to that conversation."*
 *
 * **Validates: Requirements 7.1, 7.2**
 *
 * =============================================================================
 * WHERE THE PROPERTY IS OBSERVED (Amendment A3)
 * =============================================================================
 *
 * `answerQuestion()` in `chat.service.ts`, end to end. Under A3 the context window and the
 * most-recent-diagnosis read are served only through the owner-scoped **Data_Access_Layer** (D18),
 * which merges the owning Auth_User_Id into every filter — there is no Supabase client and no
 * PostgREST seam any more. The interesting failure this property exists to catch — a context read
 * keyed on the **farmer** instead of on the conversation, so a farmer's web thread and Telegram
 * thread bleed into each other, or a read narrowed only by conversation, so a third farmer's rows
 * planted inside a conversation id leak in — is a property of that layer's scoping. So the property
 * is driven against the **real** Data_Access_Layer on a single-node `MongoMemoryReplSet` (V31, V33),
 * seeded through the same write accessors production uses, with the real `answerQuestion()` running
 * over the default DAL-backed store. Only the knowledge reader and the model are injected — the
 * reader so the run costs nothing at a provider, the model so the prompt it is handed can be read
 * back.
 *
 * Two things are directly observable — the `ConversationContext` the service built, and the exact
 * prompt the context reached. The prompt is the boundary the property is really about: a window that
 * leaked is only harmful once it reaches a model, and that is where it would.
 *
 * =============================================================================
 * MARKERS: "THIS TEXT CAME FROM THREAD B" AS A CHECKED FACT
 * =============================================================================
 *
 * Every generated piece of conversation content opens with a token naming its thread, its kind and
 * its index — `JAM1A2B-m0 the lower leaves are drying`. Each thread of a run gets its own four-hex
 * tag, and so does the intruder. `PROMPT_MARKERS` finds every such token in a string, which turns
 * the isolation half into a containment assertion instead of an assumption about the copy: every
 * marker found anywhere in the prompt must belong to the subject conversation, and the subject's own
 * message markers must all be there — the second half is what gives the first its teeth, since
 * markers demonstrably survive into the prompt.
 *
 * =============================================================================
 * WHAT THIS PROPERTY DELIBERATELY DOES NOT ASSERT
 * =============================================================================
 *
 * **The two bounds.** `CONTEXT_MESSAGE_LIMIT` and `CONTEXT_TOKEN_BUDGET` are pinned by
 * `chat.service.test.ts`. Fixtures stay under both bounds, so the expected window is simply "all of
 * this conversation's messages, oldest first" — a claim about the code rather than a copy of it.
 *
 * **Which rows are grounded, and what the answer says.** Property 11's and Property 14's.
 *
 * numRuns is 25 (not the pre-A3 300): each run seeds several conversations/messages/diagnoses across
 * multiple farmers and makes a real `answerQuestion` chain against the replica set, so a larger count
 * would exceed the 30-second per-test timeout. The generator breadth is unchanged, and the coverage
 * assertions still require every class to have been produced.
 */

/* ========================================================================== */
/* DAL modules, imported after MONGODB_URI is set                              */
/* ========================================================================== */

let harness: MongoHarness | undefined;
let farmer: typeof import('@/lib/db/farmer');
let reads: typeof import('@/lib/db/reads');
let chat: typeof import('@/services/chat.service');

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  farmer = await import('@/lib/db/farmer');
  reads = await import('@/lib/db/reads');
  chat = await import('@/services/chat.service');
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

const MINUTE_POOL: readonly number[] = Array.from({ length: 48 }, (_unused, index) => index);
const INTRUDER_MESSAGE_MINUTE = 58;
const INTRUDER_DIAGNOSIS_MINUTE = 59;

const MAX_MESSAGES_PER_THREAD = 5;
const MAX_DIAGNOSES_PER_THREAD = 3;

const MIN_THREADS = 2;
const MAX_THREADS = 3;

const MESSAGE_TAILS: readonly string[] = [
  'the lower leaves are drying',
  'i watered in the evening yesterday',
  'the spots grew after the rain',
  'how many days should i wait',
  'the field is on heavy soil',
  'i sprayed once last week',
];

const DIAGNOSIS_TAILS: readonly string[] = [
  'dark patches on the older leaves',
  'a pale ring around each patch',
  'the crop needs attention this week',
];

const PROMPT_MARKERS = /JAM[0-9A-F]{4}-[mdq]\d+/g;

const CROP_OF: Record<VerifiedCondition, KnowledgeEntry['crop']> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

const KNOWLEDGE_ROWS: readonly KnowledgeEntry[] = VERIFIED_CONDITIONS.map((condition, index) => {
  const healthy = condition === HEALTHY_CONDITION;
  return {
    id: `0000000000004000800000000${String(10 + index)}`.slice(0, 24),
    disease_name: condition,
    crop: CROP_OF[condition],
    scientific_name: healthy ? null : `pathogen ${index}`,
    symptoms: [`row ${index} symptom statement`],
    causes: [`row ${index} cause statement`],
    treatment: healthy ? [] : [`row ${index} treatment statement`],
    prevention: [`row ${index} prevention statement`],
    default_severity: healthy ? ('none' as const) : ('moderate' as const),
    source: `row ${index} extension bulletin`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
});

const knowledgeReader: KnowledgeReader = (names) =>
  Promise.resolve(KNOWLEDGE_ROWS.filter((row) => names.includes(row.disease_name)));

function minuteDate(minute: number): Date {
  return new Date(`2026-09-15T10:${String(minute).padStart(2, '0')}:00.000Z`);
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture index ${index} is absent`);
  return item;
}

function tagFor(seed: number, index: number): string {
  return (seed + index).toString(16).toUpperCase().padStart(4, '0');
}

function markerFor(tag: string, kind: 'm' | 'd' | 'q', index: number): string {
  return `JAM${tag}-${kind}${index}`;
}

function conditionAt(offset: number): VerifiedCondition {
  return at(VERIFIED_CONDITIONS, offset % VERIFIED_CONDITIONS.length);
}

/* ========================================================================== */
/* Scenario                                                                    */
/* ========================================================================== */

const SUBJECT_DIAGNOSIS_SHAPES = ['identified_latest', 'inconclusive_latest', 'no_diagnosis'] as const;
type SubjectDiagnosisShape = (typeof SUBJECT_DIAGNOSIS_SHAPES)[number];

const OWNERSHIP_SHAPES = ['same_farmer', 'cross_farmer'] as const;
type OwnershipShape = (typeof OWNERSHIP_SHAPES)[number];

const WINDOW_SHAPES = ['empty', 'populated'] as const;
type WindowShape = (typeof WINDOW_SHAPES)[number];

const INTRUDER_SHAPES = ['absent', 'present'] as const;
type IntruderShape = (typeof INTRUDER_SHAPES)[number];

interface ThreadSpec {
  /** Index into the run's farmer ids, reduced modulo how many farmers this run uses. */
  readonly ownerOffset: number;
  readonly channel: Channel;
  readonly messageCount: number;
  readonly diagnosisCount: number;
}

interface Scenario {
  readonly tagSeed: number;
  readonly farmerCount: number;
  readonly threads: readonly ThreadSpec[];
  readonly subjectOffset: number;
  readonly subjectDiagnosis: SubjectDiagnosisShape;
  readonly withIntruder: boolean;
  readonly conditionBase: number;
  readonly askedOffset: number;
  readonly language: Language;
  readonly minutes: readonly number[];
  readonly tailOffset: number;
}

const threadSpecArb: fc.Arbitrary<ThreadSpec> = fc.record({
  ownerOffset: fc.integer({ min: 0, max: 1 }),
  channel: fc.constantFrom<Channel>('web', 'telegram'),
  messageCount: fc.integer({ min: 0, max: MAX_MESSAGES_PER_THREAD }),
  diagnosisCount: fc.integer({ min: 1, max: MAX_DIAGNOSES_PER_THREAD }),
});

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  tagSeed: fc.integer({ min: 0x1000, max: 0xfff0 }),
  farmerCount: fc.integer({ min: 1, max: 2 }),
  threads: fc.array(threadSpecArb, { minLength: MIN_THREADS, maxLength: MAX_THREADS }),
  subjectOffset: fc.integer({ min: 0, max: MAX_THREADS - 1 }),
  subjectDiagnosis: fc.constantFrom<SubjectDiagnosisShape>(...SUBJECT_DIAGNOSIS_SHAPES),
  withIntruder: fc.boolean(),
  conditionBase: fc.integer({ min: 0, max: VERIFIED_CONDITIONS.length - 1 }),
  askedOffset: fc.integer({ min: 0, max: VERIFIED_CONDITIONS.length - 1 }),
  language: fc.constantFrom<Language>(...SUPPORTED_LANGUAGES),
  minutes: fc.shuffledSubarray([...MINUTE_POOL], {
    minLength: MINUTE_POOL.length,
    maxLength: MINUTE_POOL.length,
  }),
  tailOffset: fc.integer({ min: 0, max: MESSAGE_TAILS.length - 1 }),
});

interface SeededThread {
  readonly id: string;
  readonly userId: string;
  readonly channel: Channel;
  readonly tag: string;
  readonly messageIds: readonly string[];
  readonly latestDiagnosisId: string | null;
  readonly condition: VerifiedCondition | null;
  readonly otherConditions: readonly VerifiedCondition[];
}

interface World {
  readonly threads: readonly SeededThread[];
  readonly subject: SeededThread;
  readonly intruderTag: string | null;
}

/**
 * Seed the run's rows through the real Data_Access_Layer write accessors. `createdAt` is overwritten
 * directly so the interleaved ordering across threads is deterministic.
 */
async function seedWorld(scenario: Scenario, farmerIds: readonly string[]): Promise<World> {
  let cursor = 0;
  const nextMinute = (): number => {
    const minute = at(scenario.minutes, cursor);
    cursor += 1;
    return minute;
  };

  const setCreatedAt = async (
    collection: 'messages' | 'diagnoses',
    id: ObjectId,
    minute: number,
  ): Promise<void> => {
    await db().collection(collection).updateOne({ _id: id }, { $set: { createdAt: minuteDate(minute) } });
  };

  const subjectIndex = scenario.subjectOffset % scenario.threads.length;
  const threads: SeededThread[] = [];

  for (const [index, spec] of scenario.threads.entries()) {
    const isSubject = index === subjectIndex;
    const tag = tagFor(scenario.tagSeed, index);
    const userId = at(farmerIds, spec.ownerOffset % scenario.farmerCount);
    const data = farmer.farmerData(userId);
    const conv = await data.insertConversation({ channel: spec.channel });

    const messageIds: { id: string; minute: number }[] = [];
    for (let position = 0; position < spec.messageCount; position += 1) {
      const role: MessageRole = position % 2 === 0 ? 'farmer' : 'jamee';
      const msg = await data.insertMessage({
        conversationId: conv._id,
        role,
        content: `${markerFor(tag, 'm', position)} ${at(
          MESSAGE_TAILS,
          (scenario.tailOffset + position) % MESSAGE_TAILS.length,
        )}`,
        language: scenario.language,
        channel: spec.channel,
        inputKind: 'text',
      });
      const minute = nextMinute();
      await setCreatedAt('messages', msg._id, minute);
      messageIds.push({ id: msg._id.toHexString(), minute });
    }
    // Oldest-first, the order `assembleContext` returns the window in. `createdAt` was overwritten
    // with shuffled minutes, so insertion order is NOT the transcript order.
    const orderedMessageIds = [...messageIds]
      .sort((left, right) => left.minute - right.minute)
      .map((entry) => entry.id);

    const inconclusiveLatest = isSubject && scenario.subjectDiagnosis === 'inconclusive_latest';
    const count = isSubject
      ? scenario.subjectDiagnosis === 'no_diagnosis'
        ? 0
        : Math.max(inconclusiveLatest ? 2 : 1, spec.diagnosisCount)
      : spec.diagnosisCount;

    const minutes = Array.from({ length: count }, () => nextMinute()).sort((a, b) => a - b);

    let latestDiagnosisId: string | null = null;
    let latestCondition: VerifiedCondition | null = null;
    const otherConditions: VerifiedCondition[] = [];

    for (let position = 0; position < count; position += 1) {
      const rank = count - 1 - position;
      const newest = rank === 0;
      const unknown = newest && inconclusiveLatest;
      const condition = unknown ? null : conditionAt(scenario.conditionBase + index + rank);
      const identified = condition !== null;
      const inserted = await data.insertDiagnosis({
        conversationId: conv._id,
        status: identified ? 'identified' : 'unknown',
        diseaseName: condition,
        knowledgeId: null,
        confidence: identified ? 0.83 : null,
        severity: identified ? 'moderate' : 'none',
        explanation: `${markerFor(tag, 'd', position)} ${at(DIAGNOSIS_TAILS, position % DIAGNOSIS_TAILS.length)}`,
        language: scenario.language,
        needsExpert: !identified,
        channel: spec.channel,
        mediaRef: { fileId: ObjectId.createFromTime(position + 1), kind: 'crop-image' },
        modelProvider: 'gemini',
      });
      await setCreatedAt('diagnoses', inserted._id, at(minutes, position));
      if (newest) {
        latestDiagnosisId = inserted._id.toHexString();
        latestCondition = condition;
      } else if (condition !== null) {
        otherConditions.push(condition);
      }
    }

    threads.push({
      id: conv._id.toHexString(),
      userId,
      channel: spec.channel,
      tag,
      messageIds: orderedMessageIds,
      latestDiagnosisId,
      condition: latestCondition,
      otherConditions,
    });
  }

  const subject = at(threads, subjectIndex);

  if (!scenario.withIntruder) {
    return { threads, subject, intruderTag: null };
  }

  // A third farmer's rows, carrying the SUBJECT conversation's _id, with instants past the pool so
  // they would win "most recent" / be the newest turn if a read were not owner-scoped.
  const intruderTag = tagFor(scenario.tagSeed, MAX_THREADS);
  const intruderId = at(farmerIds, 2);
  const intruderData = farmer.farmerData(intruderId);
  const subjectOid = new ObjectId(subject.id);
  const intruderMsg = await intruderData.insertMessage({
    conversationId: subjectOid,
    role: 'farmer',
    content: `${markerFor(intruderTag, 'm', 0)} ${at(MESSAGE_TAILS, 0)}`,
    language: scenario.language,
    channel: subject.channel,
    inputKind: 'text',
  });
  await setCreatedAt('messages', intruderMsg._id, INTRUDER_MESSAGE_MINUTE);
  const intruderDx = await intruderData.insertDiagnosis({
    conversationId: subjectOid,
    status: 'identified',
    diseaseName: conditionAt(scenario.conditionBase + 4),
    knowledgeId: null,
    confidence: 0.9,
    severity: 'moderate',
    explanation: `${markerFor(intruderTag, 'd', 0)} ${at(DIAGNOSIS_TAILS, 0)}`,
    language: scenario.language,
    needsExpert: false,
    channel: subject.channel,
    mediaRef: { fileId: ObjectId.createFromTime(99), kind: 'crop-image' },
    modelProvider: 'gemini',
  });
  await setCreatedAt('diagnoses', intruderDx._id, INTRUDER_DIAGNOSIS_MINUTE);

  return { threads, subject, intruderTag };
}

/** The one model call, present only so the prompt it is handed can be read back. */
function promptCapture(answer: string): { readonly models: CapabilityRunner; prompts: string[] } {
  const prompts: string[] = [];
  const models: CapabilityRunner = {
    classify: () =>
      Promise.reject(new Error('Property 15 makes no vision call; the chat path must not classify')),
    generate: (call: TextCall) => {
      prompts.push(call.prompt);
      return Promise.resolve({ value: answer, provider: 'gemini' as const, usedFallback: false });
    },
  };
  return { models, prompts };
}

function markersIn(text: string): readonly string[] {
  return text.match(PROMPT_MARKERS) ?? [];
}

/* ========================================================================== */
/* Property 15                                                                 */
/* ========================================================================== */

describe('Property 15: conversation context is complete for its conversation and isolated from every other', () => {
  it('carries this conversation\u2019s own messages and its most recent diagnosis, and nothing from any other conversation', async () => {
    const ownershipsSeen = new Set<OwnershipShape>();
    const diagnosisShapesSeen = new Set<SubjectDiagnosisShape>();
    const intrudersSeen = new Set<IntruderShape>();
    const windowsSeen = new Set<WindowShape>();
    const threadCountsSeen = new Set<number>();
    const channelsSeen = new Set<Channel>();
    const languagesSeen = new Set<Language>();
    let sawForeignMessages = false;
    let sawForeignDiagnoses = false;
    let serial = 0;

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        serial += 1;
        // Three distinct farmer ids per iteration: two possible owners plus the intruder.
        const farmerIds = [
          `auth-user-ctx-${serial}-a`,
          `auth-user-ctx-${serial}-b`,
          `auth-user-ctx-${serial}-intruder`,
        ] as const;

        const world = await seedWorld(scenario, farmerIds);
        const { subject } = world;
        const others = world.threads.filter((thread) => thread !== subject);

        const askedCondition = conditionAt(scenario.askedOffset);
        const questionMarker = markerFor(subject.tag, 'q', 0);
        const question = `${questionMarker} what should i do about ${askedCondition} now?`;

        diagnosisShapesSeen.add(scenario.subjectDiagnosis);
        intrudersSeen.add(world.intruderTag === null ? 'absent' : 'present');
        windowsSeen.add(subject.messageIds.length === 0 ? 'empty' : 'populated');
        threadCountsSeen.add(world.threads.length);
        channelsSeen.add(subject.channel);
        languagesSeen.add(scenario.language);
        for (const other of others) {
          ownershipsSeen.add(other.userId === subject.userId ? 'same_farmer' : 'cross_farmer');
          if (other.messageIds.length > 0) sawForeignMessages = true;
          if (other.condition !== null || other.otherConditions.length > 0) sawForeignDiagnoses = true;
        }

        const capture = promptCapture(`${askedCondition} needs attention this week.`);

        const outcome = await chat.answerQuestion(
          {
            conversationId: subject.id,
            userId: subject.userId,
            message: question,
            language: scenario.language,
          },
          { knowledge: knowledgeReader, models: capture.models },
        );

        const label = `${scenario.subjectDiagnosis} / ${world.threads.length} threads / intruder ${
          world.intruderTag === null ? 'absent' : 'present'
        }`;

        /* 1. The window is exactly this conversation's messages (7.2). */
        const { context } = outcome;
        expect(context.conversationId, label).toBe(subject.id);
        expect(context.userId, label).toBe(subject.userId);
        expect(context.messages.map((row) => row._id.toHexString()), label).toStrictEqual([
          ...subject.messageIds,
        ]);
        expect(
          context.messages.every(
            (row) => row.conversationId.toHexString() === subject.id && row.ownerId === subject.userId,
          ),
          label,
        ).toBe(true);
        expect(context.bound.rowsRead, label).toBe(subject.messageIds.length);
        expect(context.bound.boundedBy, label).toBe('complete');

        /* 2. The most recent diagnosis is this conversation's (7.1). */
        expect(context.latestDiagnosis?._id.toHexString() ?? null, label).toBe(subject.latestDiagnosisId);
        expect(context.condition, label).toBe(subject.condition);
        if (scenario.subjectDiagnosis !== 'identified_latest') {
          expect(context.condition, label).toBeNull();
        }

        /* 3. The prompt carries this conversation's content and no other's. */
        expect(outcome.referralReason, label).toBeNull();
        expect(capture.prompts.length, label).toBe(1);
        const prompt = at(capture.prompts, 0);

        const ownMessageMarkers = subject.messageIds.map((_id, index) => markerFor(subject.tag, 'm', index));
        const permitted = new Set<string>([...ownMessageMarkers, questionMarker]);
        // The subject's own diagnosis markers are permitted too (the CURRENT DIAGNOSIS line does not
        // carry them, but the explanation could reach a prompt through some future path).
        for (let index = 0; index < MAX_DIAGNOSES_PER_THREAD; index += 1) {
          permitted.add(markerFor(subject.tag, 'd', index));
        }

        for (const marker of markersIn(prompt)) {
          expect(
            permitted.has(marker),
            `${label}: "${marker}" belongs to another conversation and reached the prompt`,
          ).toBe(true);
        }
        for (const marker of ownMessageMarkers) {
          expect(prompt, label).toContain(marker);
        }

        expect(prompt, label).toContain(`CURRENT DIAGNOSIS: ${subject.condition ?? 'none'}`);

        const inScope = new Set<string>([
          askedCondition,
          ...(subject.condition === null ? [] : [subject.condition]),
        ]);
        for (const other of others) {
          if (other.condition === null || inScope.has(other.condition)) continue;
          expect(
            prompt.includes(other.condition),
            `${label}: another conversation's condition "${other.condition}" reached the prompt`,
          ).toBe(false);
        }

        expect(outcome.degradation, label).toBeNull();
      }),
      { numRuns: 25 },
    );

    /* Non-vacuity. */
    expect([...threadCountsSeen].sort()).toStrictEqual([MIN_THREADS, MAX_THREADS]);
    expect([...ownershipsSeen].sort()).toStrictEqual([...OWNERSHIP_SHAPES].sort());
    expect([...intrudersSeen].sort()).toStrictEqual([...INTRUDER_SHAPES].sort());
    expect(sawForeignMessages).toBe(true);
    expect(sawForeignDiagnoses).toBe(true);
    expect([...diagnosisShapesSeen].sort()).toStrictEqual([...SUBJECT_DIAGNOSIS_SHAPES].sort());
    expect([...windowsSeen].sort()).toStrictEqual([...WINDOW_SHAPES].sort());
    expect([...channelsSeen].sort()).toStrictEqual(['telegram', 'web']);
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
    expect(MAX_MESSAGES_PER_THREAD).toBeLessThan(CONTEXT_MESSAGE_LIMIT);
  });

  /* ------------------------------------------------------------------------ */
  /* The second barrier, pinned                                               */
  /* ------------------------------------------------------------------------ */

  it('refuses a farmer-keyed window instead of letting another conversation reach a prompt', async () => {
    const farmerId = '11111111-1111-4111-8111-111111111111';
    const thread = new ObjectId('222222222222222222222222');
    const otherThread = new ObjectId('333333333333333333333333');
    const scope: ConversationScope = { conversationId: thread.toHexString(), userId: farmerId };

    /**
     * The failure Property 15 exists to catch, injected at the store seam: a read that grouped by
     * farmer and so returned this farmer's *other* thread. `assembleContext()`'s post-condition is
     * the barrier behind the query predicates — on a serverless invocation there is no RLS behind
     * the owner-scoped layer, so a dropped predicate must surface as a loud refusal rather than as
     * another conversation's text inside a prompt.
     */
    const farmerKeyedStore: ContextStore = {
      recentMessages: () =>
        Promise.resolve([
          {
            _id: new ObjectId('4444444444444444444444a0'),
            ownerId: farmerId,
            conversationId: otherThread,
            role: 'farmer',
            content: `${markerFor('BEEF', 'm', 0)} ${at(MESSAGE_TAILS, 0)}`,
            language: 'en',
            channel: 'telegram',
            inputKind: 'text',
            transcriptOf: null,
            createdAt: minuteDate(10),
          },
        ]),
      latestDiagnosis: () => Promise.resolve(null),
    };

    const failure = await assembleContext(scope, { store: farmerKeyedStore }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(isAppError(failure)).toBe(true);
    if (!isAppError(failure)) throw new Error('a leaked window was accepted');
    expect(failure.code).toBe('INTERNAL_ERROR');
    expect(failure.context?.reason).toBe('context_scope_mismatch');
    // The other conversation's identifiers are deliberately absent from the log line.
    expect(JSON.stringify(failure.context)).not.toContain(otherThread.toHexString());
  });

  /* ------------------------------------------------------------------------ */
  /* The Data_Access_Layer really is scoped by owner AND conversation          */
  /* ------------------------------------------------------------------------ */

  it('reads only the subject conversation\u2019s own owner\u2019s messages, excluding a farmer\u2019s other thread and an intruder', async () => {
    const farmerId = 'auth-user-scope-a';
    const intruderId = 'auth-user-scope-intruder';
    const a = farmer.farmerData(farmerId);
    const intruder = farmer.farmerData(intruderId);

    // The farmer's subject thread, his other thread, and a row a third farmer planted inside the
    // subject thread's id.
    const subject = await a.insertConversation({ channel: 'telegram' });
    const otherThread = await a.insertConversation({ channel: 'web' });
    const ours = await a.insertMessage({
      conversationId: subject._id,
      role: 'farmer',
      content: `${markerFor('AAAA', 'm', 0)} ${at(MESSAGE_TAILS, 0)}`,
      language: 'en',
      channel: 'telegram',
      inputKind: 'text',
    });
    await a.insertMessage({
      conversationId: otherThread._id,
      role: 'farmer',
      content: `${markerFor('BBBB', 'm', 0)} ${at(MESSAGE_TAILS, 1)}`,
      language: 'en',
      channel: 'web',
      inputKind: 'text',
    });
    await intruder.insertMessage({
      conversationId: subject._id,
      role: 'farmer',
      content: `${markerFor('CCCC', 'm', 0)} ${at(MESSAGE_TAILS, 2)}`,
      language: 'en',
      channel: 'telegram',
      inputKind: 'text',
    });

    // The production read, over the identical rows: narrowed by conversation AND by owner, so it
    // returns only the subject-thread + subject-owner row. A read keyed on the owner alone would
    // also return the other-thread row; one keyed on the conversation alone would also return the
    // intruder's.
    const read = await reads
      .farmerReads(farmerId)
      .conversationMessages(subject._id.toHexString(), CONTEXT_MESSAGE_LIMIT);
    expect(read.map((row) => row._id.toHexString())).toStrictEqual([ours._id.toHexString()]);

    // The intruder's own read of the same conversation id sees only the intruder's row, never the
    // farmer's — the isolation holds from both sides.
    const intruderRead = await reads
      .farmerReads(intruderId)
      .conversationMessages(subject._id.toHexString(), CONTEXT_MESSAGE_LIMIT);
    expect(intruderRead.every((row) => row.ownerId === intruderId)).toBe(true);
    expect(intruderRead.some((row) => row._id.toHexString() === ours._id.toHexString())).toBe(false);
  });
});
