import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import type { CapabilityRunner, TextCall } from '@/lib/ai/capabilities';
import { matchConditions, type KnowledgeEntry, type KnowledgeReader } from '@/lib/knowledge';
import { setupDatabase } from '@/lib/db/setup';
import {
  HEALTHY_CONDITION,
  SUPPORTED_LANGUAGES,
  VERIFIED_CONDITIONS,
  type Channel,
  type Language,
  type MessageRole,
  type VerifiedCondition,
} from '@/lib/schemas';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from '../integration/mongo';

/**
 * ### Property 16: Subject-less follow-ups resolve to the latest diagnosis on either channel
 *
 * *"For any conversation on either channel that contains at least one diagnosis, and any follow-up
 * question with no explicit subject, the resolved subject is the condition of the most recent
 * diagnosis in that conversation."*
 *
 * **Validates: Requirements 7.3, 10.8**
 *
 * =============================================================================
 * WHERE THE PROPERTY IS OBSERVED (Amendment A3)
 * =============================================================================
 *
 * `answerQuestion()` in `chat.service.ts`, which is where Requirement 7.3 is a single argument list:
 * `resolveScope({ condition: context.condition, question })`. Under A3 the context window and the
 * conversation identification are read only through the owner-scoped **Data_Access_Layer** (D18),
 * which merges the owning Auth_User_Id into every filter — there is no Supabase client and no
 * PostgREST seam any more. This property is a claim about that layer resolving the *conversation's
 * own* most-recent diagnosis and about `findOrCreateActive()` identifying the farmer's Telegram
 * thread, so it is driven against the **real** Data_Access_Layer on a single-node
 * `MongoMemoryReplSet` (V31, V33): the rows are seeded through the same write accessors production
 * uses, and the real `answerQuestion()`/`findOrCreateActive()` run over the default DAL-backed
 * stores. Only the knowledge reader and the model are injected — the reader so the run costs nothing
 * at a provider, the model so the prompt it is handed can be read back.
 *
 * The resolved subject is observable in four independent places, and all four are asserted:
 *
 *  1. **The names the knowledge reader was asked for** — the read the answer is grounded in.
 *  2. **`answer.groundedIn`** — the field a farmer's client receives.
 *  3. **The prompt's `CURRENT DIAGNOSIS:` line** — where the model is told what "why?" refers to.
 *  4. **The prompt's `VERIFIED CONTENT` block**, marker-tagged per knowledge row — a containment
 *     check that this row and no other reached the model.
 *
 * =============================================================================
 * HOW "RESOLVED AGAINST THE CONVERSATION" IS PROVED RATHER THAN ASSUMED
 * =============================================================================
 *
 *  - **The question contributes nothing.** Every enumerated follow-up shape is asserted against
 *    `matchConditions()` directly (English carrying none of the five names' vocabulary, and
 *    Devanagari which `knowledge.ts` states contributes no tokens at all).
 *  - **There is a wrong answer available, and it is distinguishable.** The farmer holds a web thread
 *    and a Telegram thread at once (`conversation.service.ts` keeps them as separate rows), each
 *    with its own diagnoses on **interleaved** timestamps, and the two threads' newest conditions
 *    are distinct by construction. So resolving against the farmer, or against the globally newest
 *    diagnosis, names a different condition — and the coverage set asserts the run reached the case
 *    where the other thread's diagnosis is newer.
 *  - **There is no default to fall back to.** Every iteration also asks the same question in a third
 *    conversation of the same farmer that has messages but no diagnosis; that must come back as the
 *    honest referral with no model call.
 *
 * =============================================================================
 * REQUIREMENT 10.8 — "ON EITHER CHANNEL", RUN AS A PARITY CLAIM
 * =============================================================================
 *
 * Both conversations are exercised on every iteration, one `web` and one `telegram`, same question,
 * same farmer, each resolving to its own thread's condition. And Requirement 10.8's own clause "the
 * Conversation identified for that Farmer" is run end to end: `findOrCreateActive(farmer, 'telegram')`
 * over the real DAL must pick the farmer's single Telegram row out of his several conversation rows,
 * whichever row is his most-recently-updated overall — the case a channel-blind identification gets
 * wrong.
 *
 * =============================================================================
 * THE MOST RECENT DIAGNOSIS, FULL STOP
 * =============================================================================
 *
 * When a thread's newest diagnosis is inconclusive it carries no name (`diagnoses_unknown_shape`,
 * Requirement 6.5), so the resolved subject is nothing and the follow-up gets Requirement 4.7's
 * referral. Those threads hold an **older identified** diagnosis whose condition is distinct, so a
 * service that reached back past the newest row would resolve to it and fail.
 *
 * numRuns is 25 (not the pre-A3 200): each run seeds several conversations/messages/diagnoses and
 * makes three real `answerQuestion` chains plus a `findOrCreateActive`, all against the real replica
 * set, so a larger count would exceed the 30-second per-test timeout. The generator breadth (seven
 * follow-up shapes, two channels, two newest-row shapes, three languages, interleaved recencies) is
 * unchanged; only the iteration count is lowered, and the coverage assertions still require every
 * class to have been produced.
 */

/* ========================================================================== */
/* The follow-up shapes                                                        */
/* ========================================================================== */

const FOLLOW_UP_SHAPES = [
  'why',
  'how_much',
  'the_spray',
  'when',
  'how_many_days',
  'hindi',
  'marathi',
] as const;

type FollowUpShape = (typeof FOLLOW_UP_SHAPES)[number];

const FOLLOW_UP_TEXT: Record<FollowUpShape, string> = {
  why: 'why?',
  how_much: 'how much?',
  the_spray: 'what about the spray?',
  when: 'and when should i do it?',
  how_many_days: 'for how many days?',
  /** Devanagari: "why did this happen?" — no Latin token at all, so no vocabulary either. */
  hindi: '\u0910\u0938\u093e \u0915\u094d\u092f\u094b\u0902 \u0939\u0941\u0906?',
  /** Devanagari: "how many times should I spray?" */
  marathi:
    '\u0915\u093f\u0924\u0940 \u0935\u0947\u0933\u093e \u092b\u0935\u093e\u0930\u0923\u0940 \u0915\u0930\u093e\u0935\u0940?',
};

/* ========================================================================== */
/* DAL modules, imported after MONGODB_URI is set                              */
/* ========================================================================== */

let harness: MongoHarness | undefined;
let farmer: typeof import('@/lib/db/farmer');
let chat: typeof import('@/services/chat.service');
let conversation: typeof import('@/services/conversation.service');

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  // Import AFTER MONGODB_URI is set so the DAL's lazily-cached client connects to the harness, and
  // the services resolve their default (DAL-backed) stores against it.
  farmer = await import('@/lib/db/farmer');
  chat = await import('@/services/chat.service');
  conversation = await import('@/services/conversation.service');
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  if (harness === undefined) throw new Error('harness not started');
  await clearDatabase(harness.db);
  // Re-seed the farmer-agnostic, read-only knowledge base after each clear.
  await setupDatabase(harness.db);
});

function db() {
  if (harness === undefined) throw new Error('harness not started');
  return harness.db;
}

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const MAX_MESSAGES_PER_THREAD = 4;
const MAX_DIAGNOSES_PER_THREAD = 3;

/** Minutes 0–35, shuffled: the interleaving of both threads' diagnoses and messages. */
const MINUTE_POOL: readonly number[] = Array.from({ length: 36 }, (_unused, index) => index);
/** `conversations.updatedAt` slots, past the row pool so the two spaces cannot be confused. */
const CONVERSATION_MINUTE_BASE = 40;

const MESSAGE_TAILS: readonly string[] = [
  'the lower leaves are drying',
  'i watered in the evening yesterday',
  'the spots grew after the rain',
  'the field is on heavy soil',
];

const KB_FIELDS = ['symptoms', 'causes', 'treatment', 'prevention'] as const;
type KbField = (typeof KB_FIELDS)[number];

/** Every knowledge-row statement marker. Prose elsewhere in the prompt cannot match this shape. */
const KB_MARKERS = /KB[0-9A-F]{4}-(?:symptoms|causes|treatment|prevention)\d+/g;

function markerFor(tag: string, field: KbField, index: number): string {
  return `KB${tag}-${field}${index}`;
}

const CROP_OF: Record<VerifiedCondition, KnowledgeEntry['crop']> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture index ${index} is absent`);
  return item;
}

function minuteDate(minute: number): Date {
  return new Date(`2026-09-15T10:${String(minute).padStart(2, '0')}:00.000Z`);
}

function tagFor(seed: number, index: number): string {
  return (seed + index).toString(16).toUpperCase().padStart(4, '0');
}

function conditionAt(offset: number): VerifiedCondition {
  return at(VERIFIED_CONDITIONS, offset % VERIFIED_CONDITIONS.length);
}

/**
 * The five knowledge rows this run's answers are grounded in, each tagged so the prompt's verified
 * content is attributable to one row. Injected as the reader on every run so it costs nothing at a
 * provider; a reader holding only the expected row would make "this row and no other" true by
 * fixture rather than by the resolution under test.
 */
function knowledgeRowsFor(seed: number): readonly KnowledgeEntry[] {
  return VERIFIED_CONDITIONS.map((condition, index) => {
    const tag = tagFor(seed, index);
    const healthy = condition === HEALTHY_CONDITION;
    const statements = (field: KbField): string[] => [
      `${markerFor(tag, field, 0)} statement for ${field}`,
    ];
    return {
      id: `00000000000040008000${tag.padStart(4, '0')}`,
      disease_name: condition,
      crop: CROP_OF[condition],
      scientific_name: healthy ? null : `${tag} pathogen`,
      symptoms: statements('symptoms'),
      causes: statements('causes'),
      treatment: healthy ? [] : statements('treatment'),
      prevention: statements('prevention'),
      default_severity: healthy ? ('none' as const) : ('moderate' as const),
      source: `${tag} extension bulletin`,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
  });
}

function markersOf(entry: KnowledgeEntry): readonly string[] {
  return KB_FIELDS.flatMap((field) => entry[field].flatMap((item) => item.match(KB_MARKERS) ?? []));
}

function expectedMarkerCount(entry: KnowledgeEntry): number {
  return KB_FIELDS.filter((field) => entry[field].length > 0).length;
}

/* ========================================================================== */
/* Scenario                                                                    */
/* ========================================================================== */

const LATEST_SHAPES = ['identified', 'inconclusive'] as const;
type LatestShape = (typeof LATEST_SHAPES)[number];

const RECENCY_SHAPES = ['own_thread_newest', 'other_thread_newer'] as const;
type RecencyShape = (typeof RECENCY_SHAPES)[number];

const OUTCOME_SHAPES = ['resolved', 'referral'] as const;
type OutcomeShape = (typeof OUTCOME_SHAPES)[number];

const RECORD_RECENCY_SHAPES = ['telegram_row_newest', 'web_row_newest'] as const;
type RecordRecencyShape = (typeof RECORD_RECENCY_SHAPES)[number];

interface ThreadSpec {
  readonly messageCount: number;
  readonly diagnosisCount: number;
  readonly latest: LatestShape;
}

interface Scenario {
  readonly kbSeed: number;
  readonly shape: FollowUpShape;
  readonly language: Language;
  readonly conditionBase: number;
  /** The web thread, then the Telegram thread. The control thread is generated separately. */
  readonly threads: readonly [ThreadSpec, ThreadSpec];
  readonly controlMessageCount: number;
  readonly minutes: readonly number[];
  readonly tailOffset: number;
  /** A permutation of `[0,1,2]`: thread index → `updatedAt` slot on its `conversations` row. */
  readonly conversationRecency: readonly number[];
}

const threadSpecArb: fc.Arbitrary<ThreadSpec> = fc.record({
  messageCount: fc.integer({ min: 0, max: MAX_MESSAGES_PER_THREAD }),
  diagnosisCount: fc.integer({ min: 1, max: MAX_DIAGNOSES_PER_THREAD }),
  latest: fc.constantFrom<LatestShape>(...LATEST_SHAPES),
});

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  kbSeed: fc.integer({ min: 0x1000, max: 0xfff0 }),
  shape: fc.constantFrom<FollowUpShape>(...FOLLOW_UP_SHAPES),
  language: fc.constantFrom<Language>(...SUPPORTED_LANGUAGES),
  conditionBase: fc.integer({ min: 0, max: VERIFIED_CONDITIONS.length - 1 }),
  threads: fc.tuple(threadSpecArb, threadSpecArb),
  controlMessageCount: fc.integer({ min: 0, max: MAX_MESSAGES_PER_THREAD }),
  minutes: fc.shuffledSubarray([...MINUTE_POOL], {
    minLength: MINUTE_POOL.length,
    maxLength: MINUTE_POOL.length,
  }),
  tailOffset: fc.integer({ min: 0, max: MESSAGE_TAILS.length - 1 }),
  conversationRecency: fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
});

interface SeededThread {
  /** The conversation `_id` as a hex string — the conversationId the service is asked with. */
  readonly id: string;
  readonly channel: Channel;
  readonly latestDiagnosisId: string | null;
  /** The subject a subject-less follow-up in this thread must resolve to. `null` → referral. */
  readonly condition: VerifiedCondition | null;
  /** The condition of the newest *identified* row, present even when the newest row is not. */
  readonly reachBackCondition: VerifiedCondition | null;
  readonly newestDiagnosisMinute: number | null;
  readonly olderConditions: readonly VerifiedCondition[];
}

interface World {
  readonly farmerId: string;
  /** The `web` thread and the `telegram` thread, both carrying at least one diagnosis. */
  readonly channelThreads: readonly [SeededThread, SeededThread];
  /** Messages, no diagnosis: the per-iteration control that closes the "a default" reading. */
  readonly control: SeededThread;
  /** The conversation id whose row is the farmer's most-recently-updated overall. */
  readonly newestConversationId: string;
  /** The globally newest diagnosis minute across both threads. */
  readonly newestDiagnosisMinute: number;
}

const CHANNELS: readonly [Channel, Channel] = ['web', 'telegram'];

/**
 * Seed the run's rows through the real Data_Access_Layer write accessors, so every row is
 * owner-stamped exactly as production writes it. `createdAt`/`updatedAt` are overwritten directly so
 * the interleaved ordering is deterministic (the accessor stamps `now`, which a property cannot
 * depend on).
 */
async function seedWorld(scenario: Scenario, farmerId: string): Promise<World> {
  const data = farmer.farmerData(farmerId);
  let cursor = 0;
  const nextMinute = (): number => {
    const minute = at(scenario.minutes, cursor);
    cursor += 1;
    return minute;
  };

  const setCreatedAt = async (
    collection: 'messages' | 'diagnoses',
    id: import('mongodb').ObjectId,
    minute: number,
  ): Promise<void> => {
    await db().collection(collection).updateOne({ _id: id }, { $set: { createdAt: minuteDate(minute) } });
  };

  const channelThreads: SeededThread[] = [];
  const conversationOids: import('mongodb').ObjectId[] = [];

  for (const [index, channel] of CHANNELS.entries()) {
    const spec = at(scenario.threads, index);
    const conv = await data.insertConversation({ channel });
    conversationOids.push(conv._id);

    for (let position = 0; position < spec.messageCount; position += 1) {
      const role: MessageRole = position % 2 === 0 ? 'farmer' : 'jamee';
      const msg = await data.insertMessage({
        conversationId: conv._id,
        role,
        content: at(MESSAGE_TAILS, (scenario.tailOffset + position) % MESSAGE_TAILS.length),
        language: scenario.language,
        channel,
        inputKind: 'text',
      });
      await setCreatedAt('messages', msg._id, nextMinute());
    }

    const inconclusiveLatest = spec.latest === 'inconclusive';
    const count = Math.max(inconclusiveLatest ? 2 : 1, spec.diagnosisCount);
    const minutes = Array.from({ length: count }, () => nextMinute()).sort((a, b) => a - b);

    let latestDiagnosisId: string | null = null;
    let latestCondition: VerifiedCondition | null = null;
    let newestIdentified: VerifiedCondition | null = null;
    let newestMinute: number | null = null;
    const olderConditions: VerifiedCondition[] = [];

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
        confidence: identified ? 0.81 : null,
        severity: identified ? 'moderate' : 'none',
        explanation: identified ? 'dark patches on the older leaves' : 'the photo could not be judged',
        language: scenario.language,
        needsExpert: !identified,
        channel,
        mediaRef: { fileId: (await import('mongodb')).ObjectId.createFromTime(position + 1), kind: 'crop-image' },
        modelProvider: 'gemini',
      });
      const minute = at(minutes, position);
      await setCreatedAt('diagnoses', inserted._id, minute);
      if (identified) newestIdentified = condition;
      if (newest) {
        latestDiagnosisId = inserted._id.toHexString();
        latestCondition = condition;
        newestMinute = minute;
      } else if (identified) {
        olderConditions.push(condition);
      }
    }

    channelThreads.push({
      id: conv._id.toHexString(),
      channel,
      latestDiagnosisId,
      condition: latestCondition,
      reachBackCondition: newestIdentified,
      newestDiagnosisMinute: newestMinute,
      olderConditions,
    });
  }

  // The control thread is a SECOND WEB conversation of the same farmer (Requirement 7.5 accumulates
  // web threads); it has messages but no diagnosis.
  const controlConv = await data.insertConversation({ channel: 'web' });
  conversationOids.push(controlConv._id);
  for (let position = 0; position < scenario.controlMessageCount; position += 1) {
    const role: MessageRole = position % 2 === 0 ? 'farmer' : 'jamee';
    const msg = await data.insertMessage({
      conversationId: controlConv._id,
      role,
      content: at(MESSAGE_TAILS, (scenario.tailOffset + position) % MESSAGE_TAILS.length),
      language: scenario.language,
      channel: 'web',
      inputKind: 'text',
    });
    await setCreatedAt('messages', msg._id, nextMinute());
  }

  // Set each conversation's updatedAt to a distinct generated slot, so which row is the farmer's
  // most-recently-updated one varies across the run (the identification step's discriminator).
  for (const [index, oid] of conversationOids.entries()) {
    await db()
      .collection('conversations')
      .updateOne(
        { _id: oid },
        { $set: { updatedAt: minuteDate(CONVERSATION_MINUTE_BASE + at(scenario.conversationRecency, index)) } },
      );
  }

  const [web, telegram] = channelThreads;
  if (web === undefined || telegram === undefined) throw new Error('both channel threads must exist');

  // Which conversation row `mostRecent` (updatedAt desc, id desc) would pick for this farmer.
  const rows = await db()
    .collection('conversations')
    .find({ ownerId: farmerId })
    .toArray();
  const newest = rows
    .map((row) => ({ id: (row._id as import('mongodb').ObjectId).toHexString(), updatedAt: row.updatedAt as Date }))
    .sort((a, b) =>
      a.updatedAt.getTime() === b.updatedAt.getTime()
        ? b.id.localeCompare(a.id)
        : b.updatedAt.getTime() - a.updatedAt.getTime(),
    );

  const control: SeededThread = {
    id: controlConv._id.toHexString(),
    channel: 'web',
    latestDiagnosisId: null,
    condition: null,
    reachBackCondition: null,
    newestDiagnosisMinute: null,
    olderConditions: [],
  };

  const newestDiagnosisMinute = Math.max(
    web.newestDiagnosisMinute ?? -1,
    telegram.newestDiagnosisMinute ?? -1,
  );

  return {
    farmerId,
    channelThreads: [web, telegram],
    control,
    newestConversationId: at(newest, 0).id,
    newestDiagnosisMinute,
  };
}

/* ========================================================================== */
/* Ask one question, every seam past the DAL injected                          */
/* ========================================================================== */

interface Recorded {
  readonly knowledgeReads: VerifiedCondition[][];
  readonly prompts: string[];
}

async function ask(options: {
  readonly world: World;
  readonly conversationId: string;
  readonly question: string;
  readonly language: Language;
  readonly rows: readonly KnowledgeEntry[];
  readonly answer: string;
}): Promise<{ readonly outcome: import('@/services/chat.service').ChatTurnOutcome; readonly recorded: Recorded }> {
  const recorded: Recorded = { knowledgeReads: [], prompts: [] };

  const knowledge: KnowledgeReader = (names) => {
    recorded.knowledgeReads.push([...names]);
    return Promise.resolve(options.rows.filter((row) => names.includes(row.disease_name)));
  };

  const models: CapabilityRunner = {
    classify: () =>
      Promise.reject(new Error('Property 16 makes no vision call; a follow-up is a text turn')),
    generate: (call: TextCall) => {
      recorded.prompts.push(call.prompt);
      return Promise.resolve({ value: options.answer, provider: 'gemini' as const, usedFallback: false });
    },
  };

  // `store` is left to the default (the DAL-backed context store), so the context window and the
  // latest-diagnosis read run against the real owner-scoped layer.
  const outcome = await chat.answerQuestion(
    {
      conversationId: options.conversationId,
      userId: options.world.farmerId,
      message: options.question,
      language: options.language,
    },
    { knowledge, models },
  );

  return { outcome, recorded };
}

function markersIn(text: string): readonly string[] {
  return text.match(KB_MARKERS) ?? [];
}

function entryFor(rows: readonly KnowledgeEntry[], condition: VerifiedCondition): KnowledgeEntry {
  const found = rows.find((row) => row.disease_name === condition);
  if (found === undefined) throw new Error(`no generated row for "${condition}"`);
  return found;
}

/* ========================================================================== */
/* Property 16                                                                 */
/* ========================================================================== */

describe('Property 16: subject-less follow-ups resolve to the latest diagnosis on either channel', () => {
  it('resolves a subject-less follow-up against its own conversation\u2019s most recent diagnosis, on both channels', async () => {
    const shapesSeen = new Set<FollowUpShape>();
    const languagesSeen = new Set<Language>();
    const channelsSeen = new Set<Channel>();
    const latestShapesSeen = new Set<LatestShape>();
    const recenciesSeen = new Set<RecencyShape>();
    const outcomesSeen = new Set<OutcomeShape>();
    const recordRecenciesSeen = new Set<RecordRecencyShape>();
    let sawBothIdentified = false;
    let farmerSerial = 0;

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        // A fresh farmer per iteration keeps each run's rows disjoint without a per-iteration clear.
        farmerSerial += 1;
        const farmerId = `auth-user-followup-${farmerSerial}`;
        const world = await seedWorld(scenario, farmerId);
        const rows = knowledgeRowsFor(scenario.kbSeed);
        const question = FOLLOW_UP_TEXT[scenario.shape];

        shapesSeen.add(scenario.shape);
        languagesSeen.add(scenario.language);

        const [web, telegram] = world.channelThreads;

        if (web.condition !== null && telegram.condition !== null) {
          sawBothIdentified = true;
          expect(web.condition).not.toBe(telegram.condition);
        }

        /* 0. The question carries no explicit subject. */
        expect(matchConditions(question), scenario.shape).toStrictEqual([]);

        /* 1. Each channel thread resolves to its OWN most recent diagnosis (7.3, 10.8). */
        for (const thread of world.channelThreads) {
          const other = thread === web ? telegram : web;
          const expected = thread.condition;
          const label = `${scenario.shape} / ${thread.channel} / latest ${expected ?? 'inconclusive'}`;

          channelsSeen.add(thread.channel);
          latestShapesSeen.add(expected === null ? 'inconclusive' : 'identified');
          recenciesSeen.add(
            thread.newestDiagnosisMinute === world.newestDiagnosisMinute
              ? 'own_thread_newest'
              : 'other_thread_newer',
          );
          outcomesSeen.add(expected === null ? 'referral' : 'resolved');

          const asked = await ask({
            world,
            conversationId: thread.id,
            question,
            language: scenario.language,
            rows,
            answer:
              expected === null ? 'unused' : `${expected}. ${at(entryFor(rows, expected).symptoms, 0)}`,
          });
          const { outcome, recorded } = asked;

          expect(outcome.context.latestDiagnosis?._id.toHexString() ?? null, label).toBe(
            thread.latestDiagnosisId,
          );
          expect(outcome.context.condition, label).toBe(expected);

          if (expected === null) {
            expect(outcome.referralReason, label).toBe('out_of_scope');
            expect(recorded.knowledgeReads, label).toStrictEqual([]);
            expect(recorded.prompts, label).toStrictEqual([]);
            expect(outcome.provider, label).toBeNull();
            expect([...outcome.answer.groundedIn], label).toStrictEqual([]);
            expect(outcome.answer.needsExpert, label).toBe(true);
            // The older identified row of this thread exists and was NOT reached for.
            expect(thread.reachBackCondition, label).not.toBeNull();
            continue;
          }

          expect(recorded.knowledgeReads, label).toStrictEqual([[expected]]);
          expect([...outcome.answer.groundedIn], label).toStrictEqual([expected]);
          expect(outcome.referralReason, label).toBeNull();
          expect(outcome.degradation, label).toBeNull();

          expect(recorded.prompts.length, label).toBe(1);
          const prompt = at(recorded.prompts, 0);
          expect(prompt, label).toContain(`CURRENT DIAGNOSIS: ${expected}`);

          const entry = entryFor(rows, expected);
          const permitted = new Set<string>(markersOf(entry));
          expect(permitted.size, label).toBe(expectedMarkerCount(entry));
          expect(permitted.size, label).toBeGreaterThan(0);
          for (const marker of markersIn(prompt)) {
            expect(
              permitted.has(marker),
              `${label}: "${marker}" is another row's content and reached the prompt`,
            ).toBe(true);
          }
          for (const marker of permitted) {
            expect(prompt, label).toContain(marker);
          }

          for (const wrong of [other.condition, ...thread.olderConditions]) {
            if (wrong === null || wrong === expected) continue;
            expect(
              prompt.includes(wrong),
              `${label}: "${wrong}" is not this conversation's subject and reached the prompt`,
            ).toBe(false);
          }
        }

        /* 2. Requirement 10.8 end to end: identify the farmer's Telegram conversation, then resolve
              the follow-up against THAT one, over the real DAL find-or-create. */
        const identified = await conversation.findOrCreateActive(world.farmerId, 'telegram');
        const waLabel = `${scenario.shape} / identified telegram thread`;

        recordRecenciesSeen.add(
          world.newestConversationId === telegram.id ? 'telegram_row_newest' : 'web_row_newest',
        );

        expect(identified.id, waLabel).toBe(telegram.id);
        expect(identified.channel, waLabel).toBe('telegram');
        expect(identified.user_id, waLabel).toBe(world.farmerId);

        const viaAdapter = await ask({
          world,
          conversationId: identified.id,
          question,
          language: scenario.language,
          rows,
          answer:
            telegram.condition === null
              ? 'unused'
              : `${telegram.condition}. ${at(entryFor(rows, telegram.condition).symptoms, 0)}`,
        });

        expect(viaAdapter.outcome.context.conversationId, waLabel).toBe(telegram.id);
        expect(viaAdapter.outcome.context.latestDiagnosis?._id.toHexString() ?? null, waLabel).toBe(
          telegram.latestDiagnosisId,
        );
        expect(viaAdapter.outcome.context.condition, waLabel).toBe(telegram.condition);
        expect([...viaAdapter.outcome.answer.groundedIn], waLabel).toStrictEqual(
          telegram.condition === null ? [] : [telegram.condition],
        );

        const webCondition = web.condition;
        if (webCondition !== null && webCondition !== telegram.condition) {
          expect(
            viaAdapter.recorded.prompts.some((prompt) => prompt.includes(webCondition)),
            `${waLabel}: the web thread\u2019s condition reached a Telegram follow-up`,
          ).toBe(false);
        }

        /* 3. The control: the same question, a thread with no diagnosis. */
        const control = await ask({
          world,
          conversationId: world.control.id,
          question,
          language: scenario.language,
          rows,
          answer: 'unused',
        });
        const controlLabel = `${scenario.shape} / control thread`;
        expect(control.outcome.context.latestDiagnosis, controlLabel).toBeNull();
        expect(control.outcome.context.condition, controlLabel).toBeNull();
        expect(control.outcome.referralReason, controlLabel).toBe('out_of_scope');
        expect(control.recorded.knowledgeReads, controlLabel).toStrictEqual([]);
        expect(control.recorded.prompts, controlLabel).toStrictEqual([]);
        expect(control.outcome.answer.needsExpert, controlLabel).toBe(true);
      }),
      // 25 runs against the real replica set (each seeds several rows and makes three real
      // answerQuestion chains plus a find-or-create); lowered from the pre-A3 200 so the suite stays
      // inside the 30-second per-test timeout. Generator breadth is unchanged.
      { numRuns: 40 },
    );

    expect([...shapesSeen].sort()).toStrictEqual([...FOLLOW_UP_SHAPES].sort());
    expect([...channelsSeen].sort()).toStrictEqual(['telegram', 'web']);
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
    expect([...latestShapesSeen].sort()).toStrictEqual([...LATEST_SHAPES].sort());
    expect([...outcomesSeen].sort()).toStrictEqual([...OUTCOME_SHAPES].sort());
    expect([...recenciesSeen].sort()).toStrictEqual([...RECENCY_SHAPES].sort());
    expect([...recordRecenciesSeen].sort()).toStrictEqual([...RECORD_RECENCY_SHAPES].sort());
    expect(sawBothIdentified).toBe(true);
  });

  it('has no explicit subject in any enumerated follow-up shape', () => {
    for (const shape of FOLLOW_UP_SHAPES) {
      const question = FOLLOW_UP_TEXT[shape];
      expect(matchConditions(question), shape).toStrictEqual([]);
      for (const condition of VERIFIED_CONDITIONS) {
        expect(question.toLowerCase().includes(condition.toLowerCase()), shape).toBe(false);
      }
    }
  });
});
