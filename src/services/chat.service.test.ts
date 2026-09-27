import { ObjectId, type WithId } from 'mongodb';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner } from '@/lib/ai/capabilities';
import type { DiagnosisDoc, MessageDoc } from '@/lib/db/collections';
import { AppError } from '@/lib/errors';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import { PROMPT_VERSION, staticExplanationFor } from '@/lib/prompts';
import {
  SUPPORTED_LANGUAGES,
  type ChatInput,
  type Language,
  type Operation,
  type VerifiedCondition,
} from '@/lib/schemas';
import type { UsageLogInsert } from '@/lib/db/usage-log';
import {
  CONTEXT_MESSAGE_LIMIT,
  CONTEXT_TOKEN_BUDGET,
  answerQuestion,
  assembleContext,
  chatAnswerer,
  chatTurn,
  estimateTokens,
  type ChatTurnDeps,
  type ChatWriteStore,
  type ContextStore,
  type ConversationScope,
  type MessageInsert,
} from '@/services/chat.service';
import {
  coveredBy,
  reserve,
  type CounterRpc,
  type QuotaOptions,
} from '@/services/quota.service';

/**
 * Unit tests for Conversation_Context assembly, with the database stubbed at the `ContextStore`
 * seam — two plain async functions, so nothing here touches the Data_Access_Layer's driver.
 *
 * Requirements: 7.1 (recent messages AND the conversation's most recent Diagnosis_Result),
 *               7.2 (keyed on the conversation identifier)
 *
 * *Amendment A3:* the seam now yields Data_Access_Layer documents (`WithId<MessageDoc>` /
 * `WithId<DiagnosisDoc>`) rather than Supabase rows. `contextStoreFrom()` is deliberately not
 * exercised: whether the owner-scoped accessors behave against a live Mongo replica set with its
 * two indexes is `tests/integration`'s question. The fake store below **mirrors** those reads — the
 * same owner + conversation scoping, the same total order, the same cap — so these tests pin the
 * window that sits on top of them.
 */

/* ========================================================================== */
/* A fake messages + diagnoses pair                                            */
/* ========================================================================== */

const FARMER = 'auth-user-1111';
const OTHER_FARMER = 'auth-user-2222';
const THREAD = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_THREAD = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const THREAD_OID = new ObjectId(THREAD);

const SCOPE: ConversationScope = { conversationId: THREAD, userId: FARMER };

interface FakeStore extends ContextStore {
  /** The row cap the last `recentMessages` call was given, so "N reached the read" is assertable. */
  readonly lastLimit: number | null;
}

/**
 * In-memory `messages` and `diagnoses` applying exactly what the real accessors apply: scope on
 * `ownerId` AND `conversationId`, order by `createdAt desc, role desc, _id desc`, take `limit`.
 * `conversationId` is compared by hex string, as the store's `.toHexString()` scope check does.
 */
function fakeStore(
  msgs: readonly WithId<MessageDoc>[] = [],
  diags: readonly WithId<DiagnosisDoc>[] = [],
): FakeStore {
  let lastLimit: number | null = null;

  return {
    get lastLimit() {
      return lastLimit;
    },

    async recentMessages(scope, limit) {
      lastLimit = limit;
      return msgs
        .filter(
          (row) =>
            row.conversationId.toHexString() === scope.conversationId &&
            row.ownerId === scope.userId,
        )
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b.role.localeCompare(a.role) ||
            b._id.toHexString().localeCompare(a._id.toHexString()),
        )
        .slice(0, limit);
    },

    async latestDiagnosis(scope) {
      const ordered = diags
        .filter(
          (row) =>
            row.conversationId.toHexString() === scope.conversationId &&
            row.ownerId === scope.userId,
        )
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b._id.toHexString().localeCompare(a._id.toHexString()),
        );
      return ordered[0] ?? null;
    },
  };
}

/** A `Date` `minute` minutes past a fixed instant, so ordering is deterministic. */
function at(minute: number): Date {
  return new Date(Date.UTC(2026, 8, 15, 10, minute, 0));
}

/** A stable ObjectId derived from a short label, so a test can name a row and assert on its id. */
function oid(label: string): ObjectId {
  const hex = Buffer.from(label).toString('hex').padEnd(24, '0').slice(0, 24);
  return new ObjectId(hex);
}

function message(overrides: Partial<WithId<MessageDoc>> & { id: string }): WithId<MessageDoc> {
  const { id, ...rest } = overrides;
  return {
    _id: oid(id),
    ownerId: FARMER,
    conversationId: THREAD_OID,
    role: 'farmer',
    content: 'why?',
    language: 'en',
    channel: 'web',
    inputKind: 'text',
    transcriptOf: null,
    createdAt: at(0),
    ...rest,
  } as WithId<MessageDoc>;
}

function diagnosis(overrides: Partial<WithId<DiagnosisDoc>> & { id: string }): WithId<DiagnosisDoc> {
  const { id, ...rest } = overrides;
  return {
    _id: oid(id),
    ownerId: FARMER,
    conversationId: THREAD_OID,
    status: 'identified',
    diseaseName: 'Tomato Early Blight',
    knowledgeId: null,
    confidence: 0.82,
    severity: 'moderate',
    explanation: 'Dark spots with rings on the lower leaves.',
    language: 'en',
    needsExpert: false,
    channel: 'web',
    mediaRef: { fileId: new ObjectId(), kind: 'crop-image' },
    fullImageDeletedAt: null,
    modelProvider: 'gemini',
    createdAt: at(0),
    ...rest,
  } as WithId<DiagnosisDoc>;
}

/** A message whose content costs a known number of estimated tokens. */
function sized(id: string, tokens: number, createdAt: Date): WithId<MessageDoc> {
  return message({ id, content: 'x'.repeat(tokens * 4), createdAt });
}

/* ========================================================================== */
/* Requirement 7.1 — the conversation's most recent diagnosis                  */
/* ========================================================================== */

describe('assembleContext — the most recent diagnosis of the conversation', () => {
  it('carries the newest diagnosis of this conversation and its condition', async () => {
    const store = fakeStore(
      [],
      [
        diagnosis({ id: 'older', diseaseName: 'Potato Late Blight', createdAt: at(10) }),
        diagnosis({ id: 'newest', diseaseName: 'Tomato Late Blight', createdAt: at(30) }),
        diagnosis({ id: 'middle', diseaseName: 'Tomato Early Blight', createdAt: at(20) }),
      ],
    );

    const context = await assembleContext(SCOPE, { store });

    expect(context.latestDiagnosis?._id.toHexString()).toBe(oid('newest').toHexString());
    // The field a subject-less follow-up resolves against (Requirement 7.3).
    expect(context.condition).toBe('Tomato Late Blight');
  });

  it('reports no diagnosis and no condition for a conversation that has none', async () => {
    const context = await assembleContext(SCOPE, { store: fakeStore([message({ id: 'm1' })]) });

    expect(context.latestDiagnosis).toBeNull();
    expect(context.condition).toBeNull();
  });

  it('surfaces an inconclusive newest diagnosis as a diagnosis with no subject', async () => {
    const store = fakeStore(
      [],
      [
        diagnosis({ id: 'identified', diseaseName: 'Tomato Early Blight', createdAt: at(10) }),
        // `diagnoses_unknown_shape` — an inconclusive row carries no name (Requirement 6.5).
        diagnosis({
          id: 'inconclusive',
          status: 'unknown',
          diseaseName: null,
          knowledgeId: null,
          confidence: null,
          severity: 'none',
          needsExpert: true,
          createdAt: at(20),
        }),
      ],
    );

    const context = await assembleContext(SCOPE, { store });

    // Most recent, full stop: no reaching back past it to the older identified row, because that
    // would answer a follow-up about a different photo than the one the farmer just sent.
    expect(context.latestDiagnosis?._id.toHexString()).toBe(oid('inconclusive').toHexString());
    expect(context.condition).toBeNull();
  });

  it("never returns another conversation's or another farmer's diagnosis", async () => {
    const store = fakeStore(
      [],
      [
        diagnosis({ id: 'other-thread', conversationId: new ObjectId(OTHER_THREAD), createdAt: at(50) }),
        diagnosis({ id: 'other-farmer', ownerId: OTHER_FARMER, createdAt: at(40) }),
        diagnosis({ id: 'ours', createdAt: at(10) }),
      ],
    );

    const context = await assembleContext(SCOPE, { store });

    expect(context.latestDiagnosis?._id.toHexString()).toBe(oid('ours').toHexString());
  });
});

/* ========================================================================== */
/* Requirement 7.2 — the window holds only this conversation's messages         */
/* ========================================================================== */

describe('assembleContext — the window is keyed on the conversation', () => {
  it('excludes another conversation of the same farmer even when its messages interleave', async () => {
    // Alternating timestamps, so a read that forgot `conversationId` would produce a window that
    // still looked chronologically plausible — which is the failure worth catching.
    const store = fakeStore([
      message({ id: 'ours-1', createdAt: at(10), content: 'my tomato has spots' }),
      message({ id: 'theirs-1', conversationId: new ObjectId(OTHER_THREAD), createdAt: at(11) }),
      message({ id: 'ours-2', createdAt: at(12), content: 'how much water?' }),
      message({ id: 'theirs-2', conversationId: new ObjectId(OTHER_THREAD), createdAt: at(13) }),
      message({ id: 'ours-3', createdAt: at(14), content: 'why?' }),
      message({ id: 'theirs-3', conversationId: new ObjectId(OTHER_THREAD), createdAt: at(15) }),
    ]);

    const context = await assembleContext(SCOPE, { store });

    expect(context.messages.map((m) => m._id.toHexString())).toEqual([
      oid('ours-1').toHexString(),
      oid('ours-2').toHexString(),
      oid('ours-3').toHexString(),
    ]);
    expect(context.messages.every((m) => m.conversationId.toHexString() === THREAD)).toBe(true);
  });

  it("excludes another farmer's messages in the same-numbered window", async () => {
    const store = fakeStore([
      message({ id: 'theirs', ownerId: OTHER_FARMER, createdAt: at(20) }),
      message({ id: 'ours', createdAt: at(10) }),
    ]);

    const context = await assembleContext(SCOPE, { store });

    expect(context.messages.map((m) => m._id.toHexString())).toEqual([oid('ours').toHexString()]);
    expect(context.messages.every((m) => m.ownerId === FARMER)).toBe(true);
  });

  it('returns an empty window for a conversation with no messages', async () => {
    const context = await assembleContext(SCOPE, { store: fakeStore() });

    expect(context.messages).toEqual([]);
    expect(context.conversationId).toBe(THREAD);
    expect(context.bound).toEqual({ rowsRead: 0, estimatedTokens: 0, boundedBy: 'complete' });
  });

  it('orders the window chronologically, oldest first', async () => {
    const store = fakeStore([
      message({ id: 'third', createdAt: at(30) }),
      message({ id: 'first', createdAt: at(10) }),
      message({ id: 'second', createdAt: at(20) }),
    ]);

    const context = await assembleContext(SCOPE, { store });

    expect(context.messages.map((m) => m._id.toHexString())).toEqual([
      oid('first').toHexString(),
      oid('second').toHexString(),
      oid('third').toHexString(),
    ]);
  });

  it('keeps a same-instant turn in question-then-answer order', async () => {
    // `createdAt` is stamped by the layer; a farmer message and its answer persisted in one turn
    // share an instant. The `role` tiebreak is what stops the transcript reading answer-first.
    const store = fakeStore([
      message({ id: 'answer', role: 'jamee', content: 'Because of...', createdAt: at(10) }),
      message({ id: 'question', role: 'farmer', content: 'why?', createdAt: at(10) }),
    ]);

    const context = await assembleContext(SCOPE, { store });

    expect(context.messages.map((m) => m.role)).toEqual(['farmer', 'jamee']);
    expect(context.messages.map((m) => m._id.toHexString())).toEqual([
      oid('question').toHexString(),
      oid('answer').toHexString(),
    ]);
  });
});

/* ========================================================================== */
/* A store that ignored the predicates must fail loudly                        */
/* ========================================================================== */

describe('assembleContext — the scope post-condition', () => {
  const leakedMessage = message({
    id: 'leaked',
    conversationId: new ObjectId(OTHER_THREAD),
    ownerId: OTHER_FARMER,
    createdAt: at(10),
  });

  it("rejects a message from another conversation rather than putting it in a prompt", async () => {
    // The Telegram/service path has no RLS behind it, so a dropped scope predicate must fail loudly
    // instead of becoming another farmer's message inside a chat prompt.
    const leaky: ContextStore = {
      recentMessages: async () => [leakedMessage],
      latestDiagnosis: async () => null,
    };

    await expect(assembleContext(SCOPE, { store: leaky })).rejects.toBeInstanceOf(AppError);
    await expect(assembleContext(SCOPE, { store: leaky })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    });
  });

  it('rejects a diagnosis from another conversation rather than answering against it', async () => {
    const leaky: ContextStore = {
      recentMessages: async () => [],
      latestDiagnosis: async () =>
        diagnosis({ id: 'leaked', conversationId: new ObjectId(OTHER_THREAD) }),
    };

    await expect(assembleContext(SCOPE, { store: leaky })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('propagates a read failure instead of reporting an empty context', async () => {
    const failing: ContextStore = {
      recentMessages: async () => {
        throw new AppError('INTERNAL_ERROR', { context: { reason: 'context_read_failed' } });
      },
      latestDiagnosis: async () => null,
    };

    // An empty context is a legitimate first turn; a failed read is not, and answering as though it
    // were would strip Requirement 7.3's subject out of a follow-up Jamee could have answered.
    await expect(assembleContext(SCOPE, { store: failing })).rejects.toBeInstanceOf(AppError);
  });
});

/* ========================================================================== */
/* The window respects its bound                                               */
/* ========================================================================== */

describe('assembleContext — the bound', () => {
  it('reads at most N rows and reports that the read was capped', async () => {
    const store = fakeStore(
      Array.from({ length: CONTEXT_MESSAGE_LIMIT + 8 }, (_, index) =>
        message({ id: `m${String(index)}`, createdAt: at(index), content: 'short' }),
      ),
    );

    const context = await assembleContext(SCOPE, { store });

    expect(store.lastLimit).toBe(CONTEXT_MESSAGE_LIMIT);
    expect(context.messages).toHaveLength(CONTEXT_MESSAGE_LIMIT);
    expect(context.bound.rowsRead).toBe(CONTEXT_MESSAGE_LIMIT);
    expect(context.bound.boundedBy).toBe('message_limit');
  });

  it('keeps the newest messages and drops the oldest when the token budget binds', async () => {
    const store = fakeStore([
      sized('oldest', 100, at(10)),
      sized('middle', 100, at(20)),
      sized('newest', 100, at(30)),
    ]);

    const context = await assembleContext(SCOPE, { store, tokenBudget: 250 });

    // 100 + 100 fits, the third would reach 300, so the OLDEST goes — a follow-up needs the end of
    // the conversation, not the beginning.
    expect(context.messages.map((m) => m._id.toHexString())).toEqual([
      oid('middle').toHexString(),
      oid('newest').toHexString(),
    ]);
    expect(context.bound.estimatedTokens).toBe(200);
    expect(context.bound.estimatedTokens).toBeLessThanOrEqual(250);
    expect(context.bound.rowsRead).toBe(3);
    expect(context.bound.boundedBy).toBe('token_budget');
  });

  it('drops everything older than the message that broke the budget, leaving no gap', async () => {
    const store = fakeStore([
      sized('small-oldest', 10, at(10)),
      sized('large', 300, at(20)),
      sized('small-newest', 10, at(30)),
    ]);

    const context = await assembleContext(SCOPE, { store, tokenBudget: 100 });

    // `large` does not fit, and `small-oldest` is NOT then smuggled in behind it: a transcript with
    // a hole in the middle reads as a non-sequitur.
    expect(context.messages.map((m) => m._id.toHexString())).toEqual([
      oid('small-newest').toHexString(),
    ]);
    expect(context.bound.boundedBy).toBe('token_budget');
  });

  it('keeps the newest message even when it alone exceeds the budget', async () => {
    const store = fakeStore([sized('older', 10, at(10)), sized('huge', 5000, at(20))]);

    const context = await assembleContext(SCOPE, { store, tokenBudget: 100 });

    // The floor of one: a window that silently emptied would lose the whole conversation over one
    // oversized row.
    expect(context.messages.map((m) => m._id.toHexString())).toEqual([oid('huge').toHexString()]);
    expect(context.bound.boundedBy).toBe('token_budget');
  });

  it('reports a complete window when neither bound is reached', async () => {
    const store = fakeStore([sized('m1', 5, at(10)), sized('m2', 7, at(20))]);

    const context = await assembleContext(SCOPE, { store });

    expect(context.messages).toHaveLength(2);
    expect(context.bound).toEqual({ rowsRead: 2, estimatedTokens: 12, boundedBy: 'complete' });
  });

  it('holds a full window of realistic turns inside the default budget', async () => {
    // A 1000-character question (`chatRequestSchema`) and a 1200-character answer
    // (`REPHRASE_MAX_CHARS`) are the two ceilings the budget was computed from: three worst-case
    // turns must fit, and twelve typical ones must too.
    const worstCase = fakeStore([
      ...Array.from({ length: 3 }, (_, turn) => [
        message({ id: `q${String(turn)}`, content: 'q'.repeat(1000), createdAt: at(turn * 2) }),
        message({
          id: `a${String(turn)}`,
          role: 'jamee',
          content: 'a'.repeat(1200),
          createdAt: at(turn * 2 + 1),
        }),
      ]).flat(),
    ]);

    const worst = await assembleContext(SCOPE, { store: worstCase });
    expect(worst.messages).toHaveLength(6);
    expect(worst.bound.boundedBy).toBe('complete');
    expect(worst.bound.estimatedTokens).toBeLessThanOrEqual(CONTEXT_TOKEN_BUDGET);

    const typical = fakeStore(
      Array.from({ length: CONTEXT_MESSAGE_LIMIT }, (_, index) =>
        message({
          id: `m${String(index)}`,
          content: index % 2 === 0 ? 'why is this happening?' : 'x'.repeat(400),
          createdAt: at(index),
        }),
      ),
    );

    const context = await assembleContext(SCOPE, { store: typical });
    expect(context.messages).toHaveLength(CONTEXT_MESSAGE_LIMIT);
    expect(context.bound.estimatedTokens).toBeLessThanOrEqual(CONTEXT_TOKEN_BUDGET);
    // The row cap bound it, not the token budget — the ordinary path.
    expect(context.bound.boundedBy).toBe('message_limit');
  });
});

/* ========================================================================== */
/* The estimator                                                               */
/* ========================================================================== */

describe('estimateTokens', () => {
  it('charges one token per four characters, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('x'.repeat(4000))).toBe(1000);
  });

  it('never charges zero for a non-empty message', () => {
    // A long tail of one-character messages must not be free, or the budget bounds nothing.
    for (const text of ['a', 'ab', 'abc', 'क', 'क्या']) {
      expect(estimateTokens(text)).toBeGreaterThan(0);
    }
  });
});
/* ========================================================================== */
/* The answer half (task 15.2)                                                 */
/* ========================================================================== */

/**
 * Requirements: 4.4 (every agricultural statement comes from Knowledge_Base entries), 4.5 (the
 *               request supplies those entries and asks for a rephrase only), 4.7 (a question
 *               outside the Verified_Conditions gets the coverage statement and an expert
 *               referral), 7.3 (a subject-less follow-up resolves against the conversation's most
 *               recent Diagnosis_Result), 7.6 (no verified content behind a question is admitted
 *               honestly), 9.3 / 9.6 (language), 4.6 / 9.4 (the canonical name is Latin script in
 *               every language), 16.4 (one grounding-and-rephrase implementation)
 *
 * The knowledge base and the gateway are stubbed at their seams — a `KnowledgeReader` is one async
 * function and a `CapabilityRunner` is two, so nothing here reproduces a query builder chain or an SDK
 * shape. `resolveScope()` and `validateRephrased()` run for real, because they are what the
 * requirements above are about: stubbing either would leave these tests asserting the stub.
 *
 * The strongest assertions are negative — `generate` never called for an out-of-scope question,
 * never called twice to repair an answer, and the other three rows' content absent from the prompt.
 */

/* -------------------------------------------------------------------------- */
/* The five rows, and the two seams                                            */
/* -------------------------------------------------------------------------- */

function knowledgeRow(
  name: VerifiedCondition,
  overrides: Partial<KnowledgeEntry> = {},
): KnowledgeEntry {
  return {
    id: `kb-${name.toLowerCase().replace(/ /g, '-')}`,
    disease_name: name,
    crop: name.startsWith('Tomato') ? 'tomato' : 'potato',
    scientific_name: null,
    symptoms: [`${name} symptom one`],
    causes: [`${name} cause one`],
    treatment: [`${name} treatment one`],
    prevention: [`${name} prevention one`],
    default_severity: 'moderate',
    source: `${name} extension bulletin`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const TOMATO_EARLY = knowledgeRow('Tomato Early Blight');
const TOMATO_LATE = knowledgeRow('Tomato Late Blight');
/** `treatment: []` by seed AND by the `healthy_has_no_treatment` constraint (Requirement 3.4). */
const TOMATO_HEALTHY = knowledgeRow('Tomato Healthy', {
  treatment: [],
  default_severity: 'none',
});
const POTATO_EARLY = knowledgeRow('Potato Early Blight');
const POTATO_LATE = knowledgeRow('Potato Late Blight');

const KNOWLEDGE_BASE = [TOMATO_EARLY, TOMATO_LATE, TOMATO_HEALTHY, POTATO_EARLY, POTATO_LATE];

interface KnowledgeStub {
  readonly read: KnowledgeReader;
  /** Every batch of names the service asked for, so "zero queries" is assertable. */
  readonly requested: VerifiedCondition[][];
}

function knowledgeStub(rows: readonly KnowledgeEntry[] = KNOWLEDGE_BASE): KnowledgeStub {
  const requested: VerifiedCondition[][] = [];
  return {
    requested,
    read: async (names) => {
      requested.push([...names]);
      return rows.filter((row) => names.includes(row.disease_name));
    },
  };
}

interface ModelStub {
  readonly runner: CapabilityRunner;
  /** Every prompt the service sent. Length is how "exactly one model call" is observed. */
  readonly prompts: string[];
}

function modelStub(answer: string | Error = `${TOMATO_EARLY.disease_name} spreads in wet weather.`): ModelStub {
  const prompts: string[] = [];
  return {
    prompts,
    runner: {
      classify: () => Promise.reject(new Error('a chat turn must never classify an image')),
      generate: (input) => {
        prompts.push(input.prompt);
        return answer instanceof Error
          ? Promise.reject(answer)
          : Promise.resolve({ value: answer, provider: 'gemini' as const, usedFallback: false });
      },
    },
  };
}

/**
 * A tripwire, not a stand-in: any model call at all fails the test.
 *
 * This is how "makes no model call" is observed from outside. A counting stub would report a zero
 * that a later refactor could turn into a one without anything else changing.
 */
const tripwireModels: CapabilityRunner = {
  classify: () => Promise.reject(new Error('no model call is permitted on this path')),
  generate: () =>
    Promise.reject(new Error('a referral must reach the farmer with no model call (4.7, 7.6)')),
};

function ask(message: string, language: Language = 'en'): Parameters<typeof answerQuestion>[0] {
  return { ...SCOPE, message, language };
}

/* -------------------------------------------------------------------------- */
/* Requirements 4.7 and 7.6 — the referral, with no model call                 */
/* -------------------------------------------------------------------------- */

describe('answerQuestion — an out-of-scope question never reaches a model', () => {
  it('returns the static coverage message with needsExpert and no provider call', async () => {
    const knowledge = knowledgeStub();

    const outcome = await answerQuestion(ask('my wheat has rust, what should I spray?'), {
      store: fakeStore(),
      knowledge: knowledge.read,
      models: tripwireModels,
    });

    expect(outcome.answer.content).toBe(messages('en').chat.outOfScope);
    expect(outcome.answer.needsExpert).toBe(true);
    expect(outcome.answer.groundedIn).toEqual([]);
    expect(outcome.referralReason).toBe('out_of_scope');
    // No provider served it, and no prompt version may claim to have produced it.
    expect(outcome.provider).toBeNull();
    expect(outcome.promptVersion).toBeNull();
    expect(outcome.degradation).toBeNull();
    // Zero database queries too: nothing matched the vocabulary, so there was nothing to read.
    expect(knowledge.requested).toEqual([]);
  });

  it('renders the referral in the farmer’s own language', async () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const outcome = await answerQuestion(ask('does my wheat need urea?', language), {
        store: fakeStore(),
        knowledge: knowledgeStub().read,
        models: tripwireModels,
      });

      expect(outcome.answer.content).toBe(messages(language).chat.outOfScope);
      expect(outcome.answer.language).toBe(language);
    }
  });

  it('admits an unseeded row as "no verified information", still with no model call', async () => {
    // In scope by vocabulary, but the base returned nothing for it (Requirement 7.6). Answering
    // anyway would mean inventing the content the row was supposed to supply.
    const knowledge = knowledgeStub([]);

    const outcome = await answerQuestion(ask('what is late blight?'), {
      store: fakeStore(),
      knowledge: knowledge.read,
      models: tripwireModels,
    });

    expect(outcome.answer.content).toBe(messages('en').chat.noVerifiedInfo);
    expect(outcome.answer.needsExpert).toBe(true);
    expect(outcome.referralReason).toBe('no_verified_content');
    expect(outcome.promptVersion).toBeNull();
    // The read was attempted — that is the difference between 7.6 and 4.7.
    expect(knowledge.requested).toEqual([['Tomato Late Blight', 'Potato Late Blight']]);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirements 4.4 and 4.5 — the prompt carries the resolved rows, and only   */
/* -------------------------------------------------------------------------- */

describe('answerQuestion — an in-scope question grounds only in the resolved rows', () => {
  it('supplies the two late-blight rows verbatim and no other row', async () => {
    const knowledge = knowledgeStub();
    const models = modelStub('Tomato Late Blight spreads fast in cool, wet weather.');

    const outcome = await answerQuestion(ask('what is late blight?'), {
      store: fakeStore(),
      knowledge: knowledge.read,
      models: models.runner,
    });

    expect(knowledge.requested).toEqual([['Tomato Late Blight', 'Potato Late Blight']]);
    expect(outcome.answer.groundedIn).toEqual(['Tomato Late Blight', 'Potato Late Blight']);
    expect(models.prompts).toHaveLength(1);

    const prompt = models.prompts[0] ?? '';
    for (const row of [TOMATO_LATE, POTATO_LATE]) {
      for (const item of [...row.symptoms, ...row.causes, ...row.treatment, ...row.prevention]) {
        expect(prompt).toContain(item);
      }
    }
    // The three rows scope resolution excluded are absent, which is what Requirement 4.5's
    // "supply the relevant content" means in the negative.
    for (const row of [TOMATO_EARLY, TOMATO_HEALTHY, POTATO_EARLY]) {
      expect(prompt).not.toContain(row.symptoms[0] ?? 'unreachable');
      expect(prompt).not.toContain(row.disease_name);
    }
    expect(outcome.provider).toBe('gemini');
    expect(outcome.promptVersion).toBe(PROMPT_VERSION);
    expect(outcome.degradation).toBeNull();
  });

  it('carries the request’s own rules and the localized fallback sentence', async () => {
    const models = modelStub('Tomato Late Blight spreads fast in cool, wet weather.');

    await answerQuestion(ask('what is late blight?', 'mr'), {
      store: fakeStore(),
      knowledge: knowledgeStub().read,
      models: models.runner,
    });

    const prompt = models.prompts[0] ?? '';
    // The design's rule only works if the sentence is in fact supplied (Requirements 7.6, 4.7).
    expect(prompt).toContain(`FALLBACK SENTENCE: ${messages('mr').chat.noVerifiedInfo}`);
    // D9's pair: the message's language first, the requested one otherwise (Requirements 9.6, 9.3).
    expect(prompt).toContain('English, Hindi or Marathi');
    expect(prompt).toContain('otherwise reply in Marathi');
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 7.3 — the subject of a subject-less question                    */
/* -------------------------------------------------------------------------- */

describe('answerQuestion — a subject-less follow-up resolves against the diagnosis', () => {
  it('grounds "why?" in the conversation’s most recent condition', async () => {
    const store = fakeStore(
      [message({ id: 'm1', content: 'my tomato has dark spots', createdAt: at(10) })],
      [diagnosis({ id: 'd1', diseaseName: 'Tomato Early Blight', createdAt: at(11) })],
    );
    const knowledge = knowledgeStub();
    const models = modelStub();

    const outcome = await answerQuestion(ask('why?'), {
      store,
      knowledge: knowledge.read,
      models: models.runner,
    });

    // The question contributes no vocabulary of its own; `context.condition` is the whole subject.
    expect(knowledge.requested).toEqual([['Tomato Early Blight']]);
    expect(outcome.answer.groundedIn).toEqual(['Tomato Early Blight']);

    const prompt = models.prompts[0] ?? '';
    expect(prompt).toContain('QUESTION: why?');
    expect(prompt).toContain('CURRENT DIAGNOSIS: Tomato Early Blight');
    expect(prompt).toContain('  farmer: my tomato has dark spots');
  });

  it('refers a subject-less question in a conversation with no diagnosis, with no model call', async () => {
    // Nothing established the subject and the question supplies none, so there is no honest answer
    // to compose — and Requirement 4.7's referral costs no provider call.
    const outcome = await answerQuestion(ask('why?'), {
      store: fakeStore([message({ id: 'm1', content: 'hello' })]),
      knowledge: knowledgeStub().read,
      models: tripwireModels,
    });

    expect(outcome.referralReason).toBe('out_of_scope');
    expect(outcome.answer.needsExpert).toBe(true);
  });

  it('reports no diagnosis as "none" rather than omitting the label', async () => {
    const models = modelStub('Tomato Late Blight spreads fast in cool, wet weather.');

    await answerQuestion(ask('what is late blight?'), {
      store: fakeStore(),
      knowledge: knowledgeStub().read,
      models: models.runner,
    });

    const prompt = models.prompts[0] ?? '';
    expect(prompt).toContain('CURRENT DIAGNOSIS: none');
    // An empty transcript is omitted entirely: an empty label in a prompt invites filling it.
    expect(prompt).not.toContain('RECENT MESSAGES:');
  });
});

/* -------------------------------------------------------------------------- */
/* Requirements 4.6 and 9.4 — the canonical name, in all three languages       */
/* -------------------------------------------------------------------------- */

describe('answerQuestion — the canonical name stays Latin script in every language', () => {
  const DEVANAGARI = /[\u0900-\u097F]/;

  /** A plausible answer per language, each keeping the name as stored. */
  const ANSWERS: Record<Language, string> = {
    en: 'Tomato Early Blight makes dark rings on the lower leaves. Remove them.',
    hi: 'Tomato Early Blight से नीचे की पत्तियों पर काले धब्बे बनते हैं। उन्हें हटा दें।',
    mr: 'Tomato Early Blight मुळे खालच्या पानांवर काळे डाग पडतात. ती काढून टाका.',
  };

  const store = (): ContextStore =>
    fakeStore([], [diagnosis({ id: 'd1', diseaseName: 'Tomato Early Blight' })]);

  for (const language of SUPPORTED_LANGUAGES) {
    it(`keeps it verbatim in a ${language} answer`, async () => {
      const outcome = await answerQuestion(ask('why?', language), {
        store: store(),
        knowledge: knowledgeStub().read,
        models: modelStub(ANSWERS[language]).runner,
      });

      expect(outcome.answer.content).toContain('Tomato Early Blight');
      expect(outcome.answer.language).toBe(language);
      expect(outcome.degradation).toBeNull();
      // The prose is in the farmer's script while the name is not — which is the whole point.
      expect(DEVANAGARI.test(outcome.answer.content)).toBe(language !== 'en');
    });
  }

  it('prefixes the name deterministically when a Marathi answer transliterated it', async () => {
    const transliterated = 'टोमॅटो अर्ली ब्लाइट मुळे पानांवर काळे डाग पडतात.';
    const models = modelStub(transliterated);

    const outcome = await answerQuestion(ask('why?', 'mr'), {
      store: store(),
      knowledge: knowledgeStub().read,
      models: models.runner,
    });

    expect(outcome.answer.content.startsWith('Tomato Early Blight')).toBe(true);
    // Repaired in process, never by asking again (D4): still exactly one model call, and the
    // model's own grounded prose is kept rather than discarded.
    expect(models.prompts).toHaveLength(1);
    expect(outcome.answer.content).toContain(transliterated);
    expect(outcome.degradation).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 16.4 — the shared check, with the chat path's scope set         */
/* -------------------------------------------------------------------------- */

describe('answerQuestion — cross-contamination is caught, in-scope siblings are not', () => {
  it('replaces an answer that names a condition outside the resolved rows', async () => {
    const contaminated =
      'Tomato Early Blight causes dark rings. Spray the same mixture you use for Potato Late Blight.';
    const models = modelStub(contaminated);

    const outcome = await answerQuestion(ask('why?'), {
      store: fakeStore([], [diagnosis({ id: 'd1', diseaseName: 'Tomato Early Blight' })]),
      knowledge: knowledgeStub().read,
      models: models.runner,
    });

    // Prose about a disease the farmer does not have is worse than the terse template, and D4
    // closes off re-asking — so the row it should have been rephrasing is served instead.
    expect(outcome.answer.content).toBe(staticExplanationFor(TOMATO_EARLY, 'en'));
    expect(outcome.answer.content).not.toContain('Potato Late Blight');
    expect(outcome.degradation).toBe('checks_failed');
    expect(outcome.outOfScopeMentions).toEqual(['Potato Late Blight']);
    // Still grounded content from a verified row, so this is not a referral.
    expect(outcome.answer.needsExpert).toBe(false);
    expect(models.prompts).toHaveLength(1);
  });

  it('accepts an answer naming both rows a two-row question resolved to', async () => {
    // `RephraseCheckTarget.inScope` exists for exactly this: "what is late blight?" grounds in two
    // rows, so the second name is in scope rather than contamination.
    const both =
      'Tomato Late Blight and Potato Late Blight both spread fast in cool, wet weather.';
    const models = modelStub(both);

    const outcome = await answerQuestion(ask('what is late blight?'), {
      store: fakeStore(),
      knowledge: knowledgeStub().read,
      models: models.runner,
    });

    expect(outcome.answer.content).toBe(both);
    expect(outcome.outOfScopeMentions).toEqual([]);
    expect(outcome.degradation).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* A failed model call still leaves the farmer with grounded content           */
/* -------------------------------------------------------------------------- */

describe('answerQuestion — degradation is grounded, and it is reported', () => {
  it('serves the knowledge-base row when the provider chain is exhausted', async () => {
    const models = modelStub(new AppError('PROVIDERS_UNAVAILABLE', { context: { usedFallback: true } }));

    const outcome = await answerQuestion(ask('why?'), {
      store: fakeStore([], [diagnosis({ id: 'd1', diseaseName: 'Tomato Early Blight' })]),
      knowledge: knowledgeStub().read,
      models: models.runner,
    });

    expect(outcome.answer.content).toBe(staticExplanationFor(TOMATO_EARLY, 'en'));
    expect(outcome.answer.groundedIn).toEqual(['Tomato Early Blight']);
    expect(outcome.degradation).toBe('provider_failed');
    // Requirement 14.7 — a fallback member was involved, and the audit says so.
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.provider).toBeNull();
    expect(outcome.promptVersion).toBeNull();
  });

  it('never shows a chat turn the diagnosis timeout’s photo copy', async () => {
    const models = modelStub(new AppError('DIAGNOSIS_TIMEOUT', { context: { budgetExhausted: true } }));

    const outcome = await answerQuestion(ask('why?'), {
      store: fakeStore([], [diagnosis({ id: 'd1', diseaseName: 'Tomato Early Blight' })]),
      knowledge: knowledgeStub().read,
      models: models.runner,
    });

    // The only timeout code in the taxonomy says "send the photo again", which is wrong for a typed
    // question — so the budget expiry becomes grounded content and an audit label instead.
    expect(outcome.answer.content).toBe(staticExplanationFor(TOMATO_EARLY, 'en'));
    expect(outcome.answer.content).not.toContain(messages('en').errors.DIAGNOSIS_TIMEOUT);
    expect(outcome.degradation).toBe('budget_exhausted');
  });

  it('serves the row when a returned answer is empty or absurdly long', async () => {
    for (const useless of ['   ', 'x'.repeat(5000)]) {
      const outcome = await answerQuestion(ask('why?'), {
        store: fakeStore([], [diagnosis({ id: 'd1', diseaseName: 'Tomato Early Blight' })]),
        knowledge: knowledgeStub().read,
        models: modelStub(useless).runner,
      });

      expect(outcome.answer.content).toBe(staticExplanationFor(TOMATO_EARLY, 'en'));
      expect(outcome.degradation).toBe('checks_failed');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The context the answer was produced from travels with it                    */
/* -------------------------------------------------------------------------- */

describe('answerQuestion — the outcome carries its context for task 15.3', () => {
  it('returns the same window the answer was grounded in', async () => {
    const store = fakeStore(
      [message({ id: 'm1', content: 'my tomato has dark spots', createdAt: at(10) })],
      [diagnosis({ id: 'd1', diseaseName: 'Tomato Early Blight', createdAt: at(11) })],
    );

    const outcome = await answerQuestion(ask('why?'), {
      store,
      knowledge: knowledgeStub().read,
      models: modelStub().runner,
    });

    // So the route need not read the conversation a second time to persist against it.
    expect(outcome.context.conversationId).toBe(THREAD);
    expect(outcome.context.userId).toBe(FARMER);
    expect(outcome.context.condition).toBe('Tomato Early Blight');
    expect(outcome.context.messages.map((m) => m._id.toHexString())).toEqual([
      oid('m1').toHexString(),
    ]);
  });
});

/* ========================================================================== */
/* chatTurn — the ordered spend, and Requirement 7.4's pair of messages         */
/* ========================================================================== */

/**
 * Requirements: 7.4 (the farmer message AND the Jamee answer are persisted as Messages in the same
 *               Conversation), 14.1 (one chat message spends exactly one chat unit; a chat answer
 *               produced inside a voice request spends none), 14.3 (an at-limit farmer is declined
 *               and NO provider is called), 14.6 / 14.7 (the audit row), 16.5 (`channel` reaches
 *               every persisted row)
 * Design: "Quota enforcement" → *When a unit is reserved, finalized, or refunded*; D9, D10
 *
 * The counter is stubbed at `CounterRpc` — the same seam `quota.service.ts` declares — so the spend
 * assertions are about the real `reserveForRequest` / `refundReservation` and not about a
 * reimplementation of them. The write seam is one object of four async functions, so nothing here
 * reproduces a query builder chain.
 *
 * The strongest assertions are the spend ones, and they are counted rather than inferred:
 * `tryIncrement` exactly once for a chat request, exactly zero times for a covered one.
 */

/* -------------------------------------------------------------------------- */
/* The counter and the write seam                                              */
/* -------------------------------------------------------------------------- */

interface CounterStub {
  readonly rpc: CounterRpc;
  readonly increments: number;
  readonly decrements: number;
  readonly used: number;
}

/** An in-memory `counters` row for one key, applying `counter_try_increment`'s limit check. */
function counterStub(options: { start?: number; limit?: number } = {}): CounterStub {
  const limit = options.limit ?? 50;
  let used = options.start ?? 0;
  let increments = 0;
  let decrements = 0;

  return {
    get increments() {
      return increments;
    },
    get decrements() {
      return decrements;
    },
    get used() {
      return used;
    },
    rpc: {
      async tryIncrement() {
        increments += 1;
        if (used >= limit) return null;
        used += 1;
        return used;
      },
      async decrement() {
        decrements += 1;
        // `and used > 0` in the SQL: a decrement that matches no row returns NULL.
        if (used === 0) return null;
        used -= 1;
        return used;
      },
      async used() {
        return used;
      },
    },
  };
}

interface WriteStub {
  readonly writes: ChatWriteStore;
  /** Every row handed to `insertTurn`, flattened. Length is how "exactly two" is observed. */
  readonly rows: MessageInsert[];
  readonly usageLogs: UsageLogInsert[];
  readonly touched: string[];
}

function writeStub(
  options: {
    owns?: boolean;
    insertError?: Error;
    touchFails?: boolean;
    usageLogError?: Error;
  } = {},
): WriteStub {
  const rows: MessageInsert[] = [];
  const usageLogs: UsageLogInsert[] = [];
  const touched: string[] = [];
  let nextId = 0;

  return {
    rows,
    usageLogs,
    touched,
    writes: {
      async ownsConversation(conversationId, userId) {
        return (options.owns ?? true) && conversationId === THREAD && userId === FARMER;
      },
      async insertTurn(pair) {
        if (options.insertError !== undefined) throw options.insertError;
        rows.push(...pair);
        // One turn, so both rows share a `createdAt` — the tie `recentMessages` breaks on `role`.
        // The seam takes string-shaped rows (ChatTurnInsert) and the layer returns stored records,
        // so this stub converts the string ids to ObjectId exactly as `insertChatTurn` does.
        return pair.map(
          (row): WithId<MessageDoc> => ({
            _id: oid(`msg-${(nextId += 1)}`),
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
            createdAt: at(59),
          }),
        );
      },
      async insertUsageLog(row) {
        if (options.usageLogError !== undefined) throw options.usageLogError;
        usageLogs.push(row);
      },
      async touchConversation(conversationId) {
        touched.push(conversationId);
        return options.touchFails !== true;
      },
    },
  };
}

/** No client is reached: every seam a turn uses is injected in these tests. */
const NO_CLIENT: ChatTurnDeps['supabase'] = undefined;

function turnDeps(
  overrides: Partial<ChatTurnDeps> & { writes: ChatWriteStore; quota: QuotaOptions },
): ChatTurnDeps {
  return {
    supabase: NO_CLIENT,
    store: fakeStore([], [diagnosis({ id: 'd1', diseaseName: 'Tomato Early Blight' })]),
    knowledge: knowledgeStub().read,
    models: modelStub().runner,
    ...overrides,
  };
}

function question(overrides: Partial<ChatInput> = {}): ChatInput {
  return {
    userId: FARMER,
    conversationId: THREAD,
    message: 'why?',
    language: 'en',
    channel: 'web',
    inputKind: 'text',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Requirement 7.4 — one farmer message, one Jamee answer                      */
/* -------------------------------------------------------------------------- */

describe('chatTurn — persistence', () => {
  it('persists exactly two rows with the right roles, channel and input kinds', async () => {
    const store = writeStub();
    const counter = counterStub();

    const result = await chatTurn(
      question(),
      turnDeps({ writes: store.writes, quota: { rpc: counter.rpc } }),
    );

    expect(store.rows).toHaveLength(2);
    const [farmer, jamee] = store.rows;

    expect(farmer?.role).toBe('farmer');
    expect(farmer?.content).toBe('why?');
    expect(farmer?.inputKind).toBe('text');
    expect(jamee?.role).toBe('jamee');
    expect(jamee?.inputKind).toBe('text');

    // Requirement 16.5 and 7.4: same conversation, same farmer, the supplied channel, on both rows.
    for (const row of store.rows) {
      expect(row.conversationId).toBe(THREAD);
      expect(row.ownerId).toBe(FARMER);
      expect(row.channel).toBe('web');
    }

    // The answer the caller gets back carries the id of the row it was actually stored as.
    expect(result.farmerMessageId).toBe(oid('msg-1').toHexString());
    expect(result.answer.messageId).toBe(oid('msg-2').toHexString());
    expect(result.conversationId).toBe(THREAD);
  });

  it("records the voice path's transcript as a farmer message distinguished by inputKind", async () => {
    /**
     * Requirement 8.4: the transcript enters the conversation as a normal farmer message, and this
     * field is what distinguishes it afterwards. Requirement 8.9's provenance (the Media_Reference)
     * travels with it.
     */
    const store = writeStub();
    const counter = counterStub();

    await chatTurn(
      question({
        inputKind: 'voice',
        transcriptOf: { fileId: 'dddddddddddddddddddddddd', kind: 'voice' },
        message: 'why?',
      }),
      turnDeps({ writes: store.writes, quota: { rpc: counter.rpc } }),
    );

    const [farmer, jamee] = store.rows;
    expect(farmer?.inputKind).toBe('voice');
    expect(farmer?.transcriptOf).toEqual({ fileId: 'dddddddddddddddddddddddd', kind: 'voice' });
    /** Requirement 8.8 — Jamee never answers with audio, so its row is text on every channel. */
    expect(jamee?.inputKind).toBe('text');
    expect(jamee?.transcriptOf ?? null).toBeNull();
  });

  it("ties the Jamee row's language to the answer, and the farmer row's to the request (D9)", async () => {
    /**
     * D9 has the answer's language follow the *message*, resolved by the model rather than by a
     * script detector. So the two columns are read from two sources: the farmer row from
     * `input.language`, the Jamee row from `answer.language`.
     *
     * Today those two values always agree — `answerQuestion` reports the requested code, because the
     * model resolves the language inside the prose rather than reporting it back — so the honest
     * assertion is the *linkage*, not a fabricated disagreement: the row carries whatever the answer
     * carries. If a later task has the model report the resolved code, this test starts distinguishing
     * the two sources without being rewritten.
     */
    const store = writeStub();
    const counter = counterStub();

    const result = await chatTurn(
      question({ language: 'mr' }),
      turnDeps({ writes: store.writes, quota: { rpc: counter.rpc } }),
    );

    const [farmer, jamee] = store.rows;
    expect(farmer?.language).toBe('mr');
    expect(jamee?.language).toBe(result.answer.language);
  });

  it('bumps the conversation so find-or-create keeps returning this thread', async () => {
    const store = writeStub();
    const counter = counterStub();

    await chatTurn(question(), turnDeps({ writes: store.writes, quota: { rpc: counter.rpc } }));

    expect(store.touched).toEqual([THREAD]);
  });

  it('serves the turn even when the activity bump fails', async () => {
    /**
     * Both messages are committed and the farmer has an answer by then; a 500 here would cost them a
     * retry and another unit for a problem they cannot act on.
     */
    const store = writeStub({ touchFails: true });
    const counter = counterStub();

    const result = await chatTurn(
      question(),
      turnDeps({ writes: store.writes, quota: { rpc: counter.rpc } }),
    );

    expect(result.answer.content.length).toBeGreaterThan(0);
    expect(store.usageLogs[0]?.outcome).toBe('success');
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 7.1 — the conversation must be this farmer's, before any spend   */
/* -------------------------------------------------------------------------- */

describe('chatTurn — conversation ownership precedes every spend', () => {
  it("refuses a conversation that is not this farmer's without touching the counter", async () => {
    const store = writeStub({ owns: false });
    const counter = counterStub();

    await expect(
      chatTurn(
        question(),
        turnDeps({
          writes: store.writes,
          quota: { rpc: counter.rpc },
          models: tripwireModels,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });

    /** Nothing was taken, so nothing had to be handed back — and nothing was written. */
    expect(counter.increments).toBe(0);
    expect(counter.decrements).toBe(0);
    expect(counter.used).toBe(0);
    expect(store.rows).toEqual([]);
    expect(store.usageLogs).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 13.8's seam sits before the reserve                             */
/* -------------------------------------------------------------------------- */

describe('chatTurn — the burst check seam', () => {
  it('runs before the reserve, so a refused burst never reaches the counter', async () => {
    const store = writeStub();
    const counter = counterStub();

    await expect(
      chatTurn(
        question(),
        turnDeps({
          writes: store.writes,
          quota: { rpc: counter.rpc },
          models: tripwireModels,
          burst: () => Promise.reject(new AppError('RATE_LIMITED')),
        }),
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    expect(counter.increments).toBe(0);
    expect(counter.decrements).toBe(0);
    expect(store.rows).toEqual([]);
  });

  it('is skipped entirely when the turn is covered by an outer reservation (13.8)', async () => {
    /**
     * The nesting rule, applied to the burst check rather than only to the reserve: a chat answer
     * produced inside a voice request was already burst-checked by the voice endpoint, so checking
     * again would refuse a farmer for a request they made once — and would spend a `chat` burst slot
     * they never asked for. `checkBurstForRequest()` in `rate-limit.ts` reads the same coverage the
     * reserve reads, so this cannot drift from the quota side of the same fact.
     */
    const store = writeStub();
    const counter = counterStub();

    const outer = await reserve(FARMER, 'voice', { rpc: counter.rpc });
    if (outer.outcome !== 'allowed') throw new Error('fixture: the outer reserve must succeed');

    await chatTurn(
      question({ skipQuotaReserve: true }),
      turnDeps({
        writes: store.writes,
        quota: { rpc: counter.rpc },
        burst: () => Promise.reject(new AppError('RATE_LIMITED')),
      }),
      coveredBy(outer.reservation),
    );

    // A limiter that refuses everything was bound, and the turn still completed: it was never called.
    expect(store.rows).toHaveLength(2);
    expect(counter.increments).toBe(1);
  });

  it('is handed the farmer and the chat operation', async () => {
    const seen: { userId: string; operation: Operation }[] = [];
    const store = writeStub();
    const counter = counterStub();

    await chatTurn(
      question(),
      turnDeps({
        writes: store.writes,
        quota: { rpc: counter.rpc },
        burst: async (userId, operation) => {
          seen.push({ userId, operation });
        },
      }),
    );

    expect(seen).toEqual([{ userId: FARMER, operation: 'chat' }]);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 14.1 — exactly one chat unit, and the nesting rule              */
/* -------------------------------------------------------------------------- */

describe('chatTurn — the spend', () => {
  it('spends exactly one chat unit for a grounded answer, and reports the count', async () => {
    const store = writeStub();
    const counter = counterStub({ start: 6 });

    const result = await chatTurn(
      question(),
      turnDeps({ writes: store.writes, quota: { rpc: counter.rpc } }),
    );

    expect(counter.increments).toBe(1);
    expect(counter.decrements).toBe(0);
    expect(counter.used).toBe(7);

    expect(result.quota).toEqual({
      operation: 'chat',
      used: 7,
      limit: 50,
      resetsAt: expect.any(String),
    });
    expect(store.usageLogs[0]?.quota_spent).toBe(true);
    expect(store.usageLogs[0]?.operation).toBe('chat');
  });

  it('declines an at-limit farmer with the limit and the reset time, calling no provider', async () => {
    const store = writeStub();
    const counter = counterStub({ start: 50 });

    await expect(
      chatTurn(
        question(),
        turnDeps({
          writes: store.writes,
          quota: { rpc: counter.rpc },
          // Requirement 14.3's actual claim: no provider is invoked on this path.
          models: tripwireModels,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { limit: 50, used: 50 },
    });

    /** No row is written for a declined request, but the decline IS audited. */
    expect(store.rows).toEqual([]);
    expect(store.usageLogs).toHaveLength(1);
    expect(store.usageLogs[0]?.outcome).toBe('quota_declined');
    expect(store.usageLogs[0]?.quota_spent).toBe(false);
    expect(store.usageLogs[0]?.model_provider).toBe('none');
  });

  it('performs NO reserve at all when the turn is covered by an outer reservation', async () => {
    /**
     * Requirement 14.1's nesting rule, as the only assertion an ordering permits from outside: the
     * counter is shared with the outer request, and `tryIncrement` must have been called exactly once
     * — by the outer reserve, never by this turn.
     */
    const store = writeStub();
    const counter = counterStub();

    const outer = await reserve(FARMER, 'voice', { rpc: counter.rpc });
    if (outer.outcome !== 'allowed') throw new Error('fixture: the outer reserve must succeed');
    expect(counter.increments).toBe(1);

    await chatTurn(
      question({ skipQuotaReserve: true }),
      turnDeps({ writes: store.writes, quota: { rpc: counter.rpc } }),
      coveredBy(outer.reservation),
    );

    /** One voice unit for the whole request. Never a voice unit and a chat unit. */
    expect(counter.increments).toBe(1);
    expect(counter.decrements).toBe(0);
    expect(store.rows).toHaveLength(2);
  });

  it('refuses a bare skipQuotaReserve that arrives without coverage', async () => {
    /**
     * A boolean cannot be turned into coverage. If it could, it would be a client-settable discount
     * on Requirement 14.1's limit — so the flag alone fails loudly instead of skipping the counter.
     */
    const store = writeStub();
    const counter = counterStub();

    await expect(
      chatTurn(
        question({ skipQuotaReserve: true }),
        turnDeps({ writes: store.writes, quota: { rpc: counter.rpc }, models: tripwireModels }),
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    expect(counter.increments).toBe(0);
    expect(store.rows).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The spend rule's "only if": a referral attempts no provider call            */
/* -------------------------------------------------------------------------- */

describe('chatTurn — an out-of-scope referral', () => {
  it('answers, persists both messages, and leaves the counter where it found it', async () => {
    /**
     * The design's rule is a biconditional — spent *if and only if* at least one provider call was
     * attempted — and Requirements 4.7 / 7.6 attempt none. So the reserve is taken (it precedes the
     * knowledge-base read, which is where scope is decided) and then handed straight back, with
     * `quota_spent = false` on the audit row saying so.
     */
    const store = writeStub();
    const counter = counterStub({ start: 4 });

    const result = await chatTurn(
      question({ message: 'my wheat has rust, what should I spray?' }),
      turnDeps({
        writes: store.writes,
        quota: { rpc: counter.rpc },
        store: fakeStore(),
        // The claim under test: no model call at all on this path.
        models: tripwireModels,
      }),
    );

    expect(result.answer.needsExpert).toBe(true);
    expect(result.answer.groundedIn).toEqual([]);
    expect(result.answer.content).toBe(messages('en').chat.outOfScope);

    /** Requirement 7.4 still holds: the exchange is in the farmer's history either way. */
    expect(store.rows).toHaveLength(2);

    expect(counter.increments).toBe(1);
    expect(counter.decrements).toBe(1);
    expect(counter.used).toBe(4);
    /** The reported count is the counter's post-refund value, not the reservation's. */
    expect(result.quota.used).toBe(4);

    expect(store.usageLogs[0]?.quota_spent).toBe(false);
    expect(store.usageLogs[0]?.outcome).toBe('inconclusive');
    expect(store.usageLogs[0]?.model_provider).toBe('none');
  });

  it('hands nothing back when the referral was produced inside a voice request', async () => {
    /**
     * The other half of the nesting rule, and it is structural rather than remembered:
     * `refundReservation` is a no-op on an inherited reservation, so a referral cannot refund a
     * transcription that really happened.
     */
    const store = writeStub();
    const counter = counterStub();

    const outer = await reserve(FARMER, 'voice', { rpc: counter.rpc });
    if (outer.outcome !== 'allowed') throw new Error('fixture: the outer reserve must succeed');

    await chatTurn(
      question({ message: 'does my wheat need urea?', skipQuotaReserve: true }),
      turnDeps({
        writes: store.writes,
        quota: { rpc: counter.rpc },
        store: fakeStore(),
        models: tripwireModels,
      }),
      coveredBy(outer.reservation),
    );

    expect(counter.increments).toBe(1);
    expect(counter.used).toBe(1);
    expect(store.usageLogs[0]?.quota_spent).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* A pre-provider failure is refunded; a degradation is not                    */
/* -------------------------------------------------------------------------- */

describe('chatTurn — failures and degradations', () => {
  it('refunds a knowledge-base read failure and records quota_spent = false', async () => {
    const store = writeStub();
    const counter = counterStub();

    await expect(
      chatTurn(
        question(),
        turnDeps({
          writes: store.writes,
          quota: { rpc: counter.rpc },
          knowledge: () => Promise.reject(new AppError('INTERNAL_ERROR')),
          models: tripwireModels,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    expect(counter.increments).toBe(1);
    expect(counter.decrements).toBe(1);
    expect(counter.used).toBe(0);
    expect(store.rows).toEqual([]);
    expect(store.usageLogs[0]?.quota_spent).toBe(false);
  });

  it('degrades a provider failure to the grounded template, spent and not refunded', async () => {
    /**
     * A provider failure on a chat turn is not `DIAGNOSIS_TIMEOUT`: that code's copy tells a farmer to
     * resend a photo they never sent. The farmer gets grounded content from the verified row, the unit
     * stays spent because the call really happened, and the audit row is the only place the
     * degradation shows.
     */
    const store = writeStub();
    const counter = counterStub();

    const result = await chatTurn(
      question(),
      turnDeps({
        writes: store.writes,
        quota: { rpc: counter.rpc },
        models: modelStub(new AppError('PROVIDERS_UNAVAILABLE')).runner,
      }),
    );

    expect(result.answer.content).toBe(staticExplanationFor(TOMATO_EARLY, 'en'));
    expect(result.answer.needsExpert).toBe(false);

    expect(counter.decrements).toBe(0);
    expect(counter.used).toBe(1);
    expect(store.usageLogs[0]?.outcome).toBe('provider_error');
    expect(store.usageLogs[0]?.quota_spent).toBe(true);
  });

  it('records an exhausted budget as a timeout while still answering', async () => {
    const store = writeStub();
    const counter = counterStub();

    const result = await chatTurn(
      question(),
      turnDeps({
        writes: store.writes,
        quota: { rpc: counter.rpc },
        models: modelStub(new AppError('DIAGNOSIS_TIMEOUT')).runner,
      }),
    );

    expect(result.answer.content).toBe(staticExplanationFor(TOMATO_EARLY, 'en'));
    expect(store.usageLogs[0]?.outcome).toBe('timeout');
    expect(store.usageLogs[0]?.quota_spent).toBe(true);
  });

  it('records a rejected rephrase as validation_rejected', async () => {
    const store = writeStub();
    const counter = counterStub();

    const result = await chatTurn(
      question(),
      turnDeps({
        writes: store.writes,
        quota: { rpc: counter.rpc },
        // Empty prose fails the post-generation checks and falls back to the row's own template.
        models: modelStub('   ').runner,
      }),
    );

    expect(result.answer.content).toBe(staticExplanationFor(TOMATO_EARLY, 'en'));
    expect(store.usageLogs[0]?.outcome).toBe('validation_rejected');
    /**
     * `rephrase_rejected`, not `null` — the gap task 24.3 closed.
     *
     * This assertion used to expect `null`, on the reading that `rejection_reason`'s vocabulary was
     * decision D2's vision-stage set and a rejected rephrase had no value in it. That was true of
     * migration 0006 and it made the row **fail the letter of Requirement 5.7**: a rejection was
     * recorded without its reason, which is the one thing that criterion asks for.
     *
     * Migration 0011 added `rephrase_rejected` for exactly this, as an audit-only value — it is
     * deliberately absent from `MessageCatalog.inconclusive`, because a farmer whose rephrase was
     * refused reads the knowledge-base static template rather than an inconclusive sentence, so there
     * is nothing to localize.
     */
    expect(store.usageLogs[0]?.rejection_reason).toBe('rephrase_rejected');
    expect(store.usageLogs[0]?.quota_spent).toBe(true);
  });

  it('propagates a persistence failure rather than reporting an answer that was not stored', async () => {
    const store = writeStub({ insertError: new Error('db: insert failed') });
    const counter = counterStub();

    await expect(
      chatTurn(question(), turnDeps({ writes: store.writes, quota: { rpc: counter.rpc } })),
    ).rejects.toThrow();

    /** The model call happened, so the unit stays spent. */
    expect(counter.used).toBe(1);
    expect(store.usageLogs[0]?.quota_spent).toBe(true);
    expect(store.touched).toEqual([]);
  });

  it('still serves a turn whose audit insert fails', async () => {
    /**
     * The audit write never throws: on a success path it would turn a served turn into a 500, and on a
     * failure path it would replace `QUOTA_EXCEEDED` with "something went wrong".
     */
    const store = writeStub({ usageLogError: new Error('db: usage_logs unavailable') });
    const counter = counterStub();

    const result = await chatTurn(
      question(),
      turnDeps({ writes: store.writes, quota: { rpc: counter.rpc } }),
    );

    expect(result.answer.content.length).toBeGreaterThan(0);
    expect(store.usageLogs).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The shape voice.service.ts consumes                                         */
/* -------------------------------------------------------------------------- */

describe('chatAnswerer', () => {
  it('is a two-argument answerer that carries the coverage through to the counter', async () => {
    /**
     * `voice.service.ts` declares `ChatAnswerer` with no default because this half did not exist. The
     * factory is that default: the wiring is closed over once, and the coverage travels per call —
     * which is the only way an unforgeable reservation can reach the nested turn.
     */
    const store = writeStub();
    const counter = counterStub();

    const outer = await reserve(FARMER, 'voice', { rpc: counter.rpc });
    if (outer.outcome !== 'allowed') throw new Error('fixture: the outer reserve must succeed');

    const answerer = chatAnswerer(
      turnDeps({ writes: store.writes, quota: { rpc: counter.rpc } }),
    );
    const nested = await answerer(
      question({ inputKind: 'voice', skipQuotaReserve: true, message: 'why?' }),
      coveredBy(outer.reservation),
    );

    // Exactly `chatResponseSchema`'s four fields, which is what makes `NestedChatOutcome` satisfied.
    expect(Object.keys(nested).sort()).toEqual([
      'answer',
      'conversationId',
      'farmerMessageId',
      'quota',
    ]);
    expect(nested.farmerMessageId).toBe(oid('msg-1').toHexString());
    expect(nested.answer.messageId).toBe(oid('msg-2').toHexString());
    expect(counter.increments).toBe(1);
  });
});
