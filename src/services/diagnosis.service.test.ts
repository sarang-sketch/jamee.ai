import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import type { CapabilityRunner, TextCall, VisionCall } from '@/lib/ai/capabilities';
import { DAILY_QUOTAS } from '@/lib/config/verified';
import type { DiagnosisInsert } from '@/lib/db/analysis';
import { AppError, isAppError } from '@/lib/errors';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import { burstLimiter } from '@/lib/rate-limit';
import { PROMPT_VERSION, rephrasePrompt, staticExplanationFor } from '@/lib/prompts';
import type { Language, MediaRef, RejectionReason, VerifiedCondition } from '@/lib/schemas';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import {
  diagnose,
  interpret,
  type DiagnosisDeps,
  type DiagnosisStore,
} from '@/services/diagnosis.service';
import type { CounterRpc } from '@/services/quota.service';
import type { TablesInsert } from '@/types/database';

/**
 * Unit tests for `src/services/diagnosis.service.ts` (Amendment A3), with the gateway and the
 * Data_Access_Layer stubbed at their seams.
 *
 * Requirements: 2.6 (an ownership rejection leaves the quota unchanged), 2.8 (the image bytes reach
 *               the model inline, read through the Data_Access_Layer — no signed URL under A3), 3.2
 *               (an identified result is composed only from the matching Knowledge_Base entry), 3.3
 *               (the result is persisted with farmer, conversation, the Media_Reference and channel),
 *               3.4 (a healthy crop reports severity `none` and carries no treatment content), 3.7
 *               (budget expiry is a timeout, recorded), 5.7 (the rejection reason is recorded), 6.1–
 *               6.6 (one inconclusive shape, no further model call), 6.7 (an accepted inconclusive
 *               result counts exactly one unit), 14.3 (a decline states the limit and the reset),
 *               16.5 (`channel` is written to every persisted row)
 *
 * They decide **order and attribution**: which seam was called, with what, in which sequence, and
 * what the service made of the answer. The strongest assertions are the **negative** ones — the
 * model never called after a rejection, the counter never touched on an ownership failure — because
 * the pipeline order is the contract and a negative is how you observe an order from outside.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const USER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const DIAGNOSIS_ID = '55555555-5555-4555-8555-555555555555';
const EARLY_BLIGHT_ID = '66666666-6666-4666-8666-666666666666';
const LATE_BLIGHT_ID = '77777777-7777-4777-8777-777777777777';
const HEALTHY_ID = '88888888-8888-4888-8888-888888888888';

/** 2026-09-15T19:30:00Z is 2026-09-16T01:00 in Asia/Kolkata — the far side of the +05:30 offset. */
const NOW_MS = Date.parse('2026-09-15T19:30:00.000Z');

/** A3: the analysis input carries a `{ fileId, kind }` Media_Reference, not a storage path. */
const IMAGE_REF: MediaRef = { fileId: 'a'.repeat(24), kind: 'crop-image' };

/** The bytes the owner-checked read yields, and their stored MIME type. */
const IMAGE_BYTES = Buffer.from('fake-jpeg-bytes');
const IMAGE_MIME = 'image/jpeg';

function knowledgeRow(
  name: VerifiedCondition,
  id: string,
  overrides: Partial<KnowledgeEntry> = {},
): KnowledgeEntry {
  return {
    id,
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

const EARLY_BLIGHT = knowledgeRow('Tomato Early Blight', EARLY_BLIGHT_ID);
const LATE_BLIGHT = knowledgeRow('Tomato Late Blight', LATE_BLIGHT_ID);
const HEALTHY = knowledgeRow('Tomato Healthy', HEALTHY_ID, {
  treatment: [],
  default_severity: 'none',
});

const KNOWLEDGE_BASE = [EARLY_BLIGHT, LATE_BLIGHT, HEALTHY];

function visionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'identified',
    disease_name: 'Tomato Early Blight',
    confidence: 0.87,
    severity: 'moderate',
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */
/* Seams                                                                       */
/* -------------------------------------------------------------------------- */

interface MediaReadStub {
  readonly read: (userId: string, ref: MediaRef) => Promise<{ bytes: Buffer; mimeType: string } | null>;
  readonly readsFor: string[];
}

/**
 * The owner-checked media read. `owned: false` returns `null` — the store makes a foreign file and a
 * missing file indistinguishable (Requirement 2.6), and the service maps that single `null` to
 * `STORAGE_REF_FORBIDDEN` before spending anything.
 */
function mediaReadStub(options: { owned?: boolean; mimeType?: string } = {}): MediaReadStub {
  const readsFor: string[] = [];
  const owned = options.owned ?? true;
  return {
    readsFor,
    read: (_userId, ref) => {
      readsFor.push(ref.fileId);
      return Promise.resolve(
        owned ? { bytes: IMAGE_BYTES, mimeType: options.mimeType ?? IMAGE_MIME } : null,
      );
    },
  };
}

interface ModelStub {
  readonly runner: CapabilityRunner;
  readonly classifyCalls: VisionCall[];
  readonly generateCalls: TextCall[];
}

function modelStub(
  options: { classify?: string | Error; generate?: string | Error } = {},
): ModelStub {
  const classifyCalls: VisionCall[] = [];
  const generateCalls: TextCall[] = [];

  return {
    classifyCalls,
    generateCalls,
    runner: {
      classify: (input) => {
        classifyCalls.push(input);
        const answer = options.classify ?? visionJson();
        return answer instanceof Error
          ? Promise.reject(answer)
          : Promise.resolve({ value: answer, provider: 'gemini' as const, usedFallback: false });
      },
      generate: (input) => {
        generateCalls.push(input);
        const answer = options.generate ?? 'Rephrased, grounded, Tomato Early Blight.';
        return answer instanceof Error
          ? Promise.reject(answer)
          : Promise.resolve({ value: answer, provider: 'gemini' as const, usedFallback: false });
      },
    },
  };
}

interface StoreStub {
  readonly store: DiagnosisStore;
  readonly diagnoses: DiagnosisInsert[];
  readonly usage: TablesInsert<'usage_logs'>[];
}

function storeStub(options: { ownsConversation?: boolean } = {}): StoreStub {
  const diagnoses: DiagnosisInsert[] = [];
  const usage: TablesInsert<'usage_logs'>[] = [];

  return {
    diagnoses,
    usage,
    store: {
      insertDiagnosis: (doc) => {
        diagnoses.push(doc);
        return Promise.resolve(DIAGNOSIS_ID);
      },
      insertUsageLog: (row) => {
        usage.push(row);
        return Promise.resolve();
      },
      ownsConversation: () => Promise.resolve(options.ownsConversation ?? true),
    },
  };
}

function conversationStub(): ConversationStore {
  const conversation = (channel: Conversation['channel']): Conversation => ({
    id: CONVERSATION_ID,
    user_id: USER,
    channel,
    title: null,
    created_at: '2026-09-16T00:59:00.000Z',
    updated_at: '2026-09-16T00:59:00.000Z',
  });
  return {
    mostRecent: (_userId, channel) => Promise.resolve(conversation(channel)),
    create: (_userId, channel) => Promise.resolve(conversation(channel)),
  };
}

function knowledgeStub(rows: readonly KnowledgeEntry[] = KNOWLEDGE_BASE): {
  read: KnowledgeReader;
  requested: VerifiedCondition[][];
} {
  const requested: VerifiedCondition[][] = [];
  const read: KnowledgeReader = (names) => {
    requested.push([...names]);
    return Promise.resolve(rows.filter((row) => names.includes(row.disease_name)));
  };
  return { read, requested };
}

interface CounterStub {
  readonly rpc: CounterRpc;
  readonly increments: number;
  readonly decrements: number;
}

function counterStub(options: { tryIncrement?: number | null } = {}): CounterStub {
  const state = { increments: 0, decrements: 0 };
  const rpc: CounterRpc = {
    tryIncrement: () => {
      state.increments += 1;
      return Promise.resolve(options.tryIncrement === undefined ? 1 : options.tryIncrement);
    },
    decrement: () => {
      state.decrements += 1;
      return Promise.resolve(0);
    },
    used: () => Promise.resolve(0),
  };
  return {
    rpc,
    get increments() {
      return state.increments;
    },
    get decrements() {
      return state.decrements;
    },
  };
}

/** Fails the test if the counter is reached at all — the ownership case's real assertion. */
const unreachableCounter: CounterRpc = {
  tryIncrement: () => {
    throw new Error('counter_try_increment was called; this path must reserve nothing');
  },
  decrement: () => {
    throw new Error('counter_decrement was called; this path must refund nothing');
  },
  used: () => {
    throw new Error('counter_used was called; this path needs no read');
  },
};

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly deps: DiagnosisDeps;
  readonly media: MediaReadStub;
  readonly models: ModelStub;
  readonly store: StoreStub;
  readonly knowledge: { read: KnowledgeReader; requested: VerifiedCondition[][] };
  readonly counter: CounterStub;
}

function harness(
  options: {
    media?: MediaReadStub;
    models?: ModelStub;
    store?: StoreStub;
    knowledgeRows?: readonly KnowledgeEntry[];
    counter?: CounterStub;
    rpc?: CounterRpc;
    deadlineMs?: number;
  } = {},
): Harness {
  const media = options.media ?? mediaReadStub();
  const models = options.models ?? modelStub();
  const store = options.store ?? storeStub();
  const knowledge = knowledgeStub(options.knowledgeRows ?? KNOWLEDGE_BASE);
  const counter = options.counter ?? counterStub();

  return {
    media,
    models,
    store,
    knowledge,
    counter,
    deps: {
      store: store.store,
      readMedia: media.read,
      conversations: conversationStub(),
      knowledge: knowledge.read,
      models: models.runner,
      quota: { rpc: options.rpc ?? counter.rpc, now: new Date(NOW_MS) },
      now: () => NOW_MS,
      platformDeadline: () => undefined,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    },
  };
}

function request(
  overrides: { language?: Language; channel?: 'web' | 'whatsapp'; conversationId?: string; image?: MediaRef } = {},
): import('@/lib/schemas').DiagnoseInput {
  return {
    userId: USER,
    image: overrides.image ?? IMAGE_REF,
    language: overrides.language ?? ('en' as Language),
    channel: overrides.channel ?? ('web' as const),
    ...(overrides.conversationId === undefined ? {} : { conversationId: overrides.conversationId }),
  };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to reject with an AppError');
}

function onlyUsageRow(store: StoreStub): TablesInsert<'usage_logs'> {
  expect(store.usage).toHaveLength(1);
  const row = store.usage[0];
  if (row === undefined) throw new Error('no usage_logs row was written');
  return row;
}

function onlyDiagnosisRow(store: StoreStub): DiagnosisInsert {
  expect(store.diagnoses).toHaveLength(1);
  const row = store.diagnoses[0];
  if (row === undefined) throw new Error('no diagnosis doc was written');
  return row;
}

/* ========================================================================== */
/* Every non-identified cause → the one inconclusive shape (D3, 6.1–6.6)       */
/* ========================================================================== */

interface RejectionCase {
  readonly reason: RejectionReason;
  readonly modelSaid: string;
  readonly outcome: 'validation_rejected' | 'inconclusive';
  readonly why: string;
}

const REJECTION_CASES: readonly RejectionCase[] = [
  {
    reason: 'not_json',
    modelSaid: 'I think this leaf has early blight.',
    outcome: 'validation_rejected',
    why: 'Requirement 5.2 — the response is not parseable JSON',
  },
  {
    reason: 'missing_field',
    modelSaid: JSON.stringify({ status: 'identified', confidence: 0.9 }),
    outcome: 'validation_rejected',
    why: 'Requirement 5.3 — required fields of the diagnosis schema are absent',
  },
  {
    reason: 'confidence_out_of_range',
    modelSaid: visionJson({ confidence: 1.1 }),
    outcome: 'validation_rejected',
    why: 'Requirement 5.4 — outside the closed interval [0, 1]',
  },
  {
    reason: 'invalid_severity',
    modelSaid: visionJson({ severity: 'catastrophic' }),
    outcome: 'validation_rejected',
    why: 'Requirement 5.5 — outside the four Severity_Values',
  },
  {
    reason: 'unverified_condition',
    modelSaid: visionJson({ disease_name: 'Wheat Rust', confidence: 0.94, severity: 'high' }),
    outcome: 'validation_rejected',
    why: 'Requirements 5.6, 6.1 — a real condition Jamee has no verified content for',
  },
  {
    reason: 'model_unclear',
    modelSaid: visionJson({ status: 'unclear', disease_name: null, confidence: 0.2, severity: 'none' }),
    outcome: 'inconclusive',
    why: 'Requirement 6.2 — the model reported the photo unjudgeable',
  },
  {
    reason: 'model_no_plant',
    modelSaid: visionJson({ status: 'no_plant', disease_name: null, confidence: 0, severity: 'none' }),
    outcome: 'inconclusive',
    why: 'Requirement 6.3 — no plant in the frame',
  },
];

describe('diagnose — every non-identified cause collapses into one inconclusive shape', () => {
  for (const testCase of REJECTION_CASES) {
    it(`maps ${testCase.reason} to the inconclusive shape (${testCase.why})`, async () => {
      const test = harness({ models: modelStub({ classify: testCase.modelSaid }) });

      const outcome = await diagnose(request(), test.deps);

      expect(outcome.result).toEqual({
        status: 'unknown',
        diseaseName: null,
        confidence: null,
        severity: 'none',
        explanation: messages('en').inconclusive[testCase.reason],
        knowledge: null,
        needsExpert: true,
        language: 'en',
      });

      // Requirement 6.6 / D4 — no second model call, and no repair re-ask of the first.
      expect(test.models.classifyCalls).toHaveLength(1);
      expect(test.models.generateCalls).toHaveLength(0);

      // Requirement 5.7 — the reason is recorded, distinctly.
      const usage = onlyUsageRow(test.store);
      expect(usage.rejection_reason).toBe(testCase.reason);
      expect(usage.outcome).toBe(testCase.outcome);
      expect(usage.prompt_version).toBe(PROMPT_VERSION);
      expect(outcome.rejectionReason).toBe(testCase.reason);

      // Requirement 6.5 — the rejected name and confidence are excluded from the persisted row too.
      const row = onlyDiagnosisRow(test.store);
      expect(row.status).toBe('unknown');
      expect(row.diseaseName).toBeNull();
      expect(row.knowledgeId).toBeNull();
      expect(row.confidence).toBeNull();
      expect(row.severity).toBe('none');
      expect(row.needsExpert).toBe(true);
      // Requirement 3.3 — the Media_Reference is on the row regardless of outcome.
      expect(row.mediaRef).toEqual(IMAGE_REF);
    });
  }

  it('never lets a rejected disease name reach the result or the row', async () => {
    const test = harness({
      models: modelStub({ classify: visionJson({ disease_name: 'Wheat Rust', confidence: 0.99 }) }),
    });

    const outcome = await diagnose(request(), test.deps);
    const serialized = JSON.stringify({ outcome, rows: test.store.diagnoses });

    expect(serialized).not.toContain('Wheat Rust');
    expect(serialized).not.toContain('0.99');
  });

  it('reads the two model-reported statuses without a knowledge-base read', async () => {
    const test = harness({
      models: modelStub({ classify: visionJson({ status: 'no_plant', disease_name: null }) }),
    });

    await diagnose(request(), test.deps);

    expect(test.knowledge.requested).toHaveLength(0);
  });
});

/* ========================================================================== */
/* The identified path (3.2, 3.3, 4.3, 4.5)                                    */
/* ========================================================================== */

describe('diagnose — identified results are grounded only in the matching row', () => {
  it('reads exactly the named condition and rephrases only that row', async () => {
    const test = harness();

    const outcome = await diagnose(request(), test.deps);

    expect(test.knowledge.requested).toEqual([['Tomato Early Blight']]);
    expect(outcome.result).toEqual({
      status: 'identified',
      diseaseName: 'Tomato Early Blight',
      confidence: 0.87,
      severity: 'moderate',
      explanation: 'Rephrased, grounded, Tomato Early Blight.',
      knowledge: {
        symptoms: EARLY_BLIGHT.symptoms,
        causes: EARLY_BLIGHT.causes,
        treatment: EARLY_BLIGHT.treatment,
        prevention: EARLY_BLIGHT.prevention,
        source: EARLY_BLIGHT.source,
      },
      needsExpert: false,
      language: 'en',
    });

    expect(test.models.generateCalls).toHaveLength(1);
    expect(test.models.generateCalls[0]?.prompt).toBe(
      rephrasePrompt({ entry: EARLY_BLIGHT, language: 'en' }),
    );
    expect(test.models.generateCalls[0]?.prompt).not.toContain('Tomato Late Blight');
    expect(test.models.generateCalls[0]?.prompt).not.toContain(LATE_BLIGHT.symptoms[0] ?? '');
  });

  it('persists the doc Requirement 3.3 describes and echoes the quota', async () => {
    const test = harness();

    const outcome = await diagnose(request(), test.deps);

    const row = onlyDiagnosisRow(test.store);
    expect(row).toMatchObject({
      conversationId: CONVERSATION_ID,
      status: 'identified',
      diseaseName: 'Tomato Early Blight',
      knowledgeId: EARLY_BLIGHT_ID,
      confidence: 0.87,
      severity: 'moderate',
      language: 'en',
      needsExpert: false,
      channel: 'web',
      mediaRef: IMAGE_REF,
      modelProvider: 'gemini',
    });

    expect(outcome.diagnosisId).toBe(DIAGNOSIS_ID);
    expect(outcome.conversationId).toBe(CONVERSATION_ID);
    expect(outcome.quota).toEqual({
      operation: 'image',
      used: 1,
      limit: DAILY_QUOTAS.image,
      resetsAt: '2026-09-16T18:30:00.000Z',
    });

    const usage = onlyUsageRow(test.store);
    expect(usage).toMatchObject({
      operation: 'image',
      channel: 'web',
      model_provider: 'gemini',
      outcome: 'success',
      used_fallback: false,
      rejection_reason: null,
      quota_spent: true,
      diagnosis_id: DIAGNOSIS_ID,
      conversation_id: CONVERSATION_ID,
      prompt_version: PROMPT_VERSION,
    });
    expect(usage.latency_ms).toBe(0);
  });

  it('reads the image through the owner-checked read and sends the bytes inline (Requirement 2.8)', async () => {
    const test = harness();

    await diagnose(request(), test.deps);

    // A3, V34: the owner-scoped read yielded the bytes, which travel inline as base64 — no URL.
    expect(test.media.readsFor).toEqual([IMAGE_REF.fileId]);
    expect(test.models.classifyCalls[0]?.imageBase64).toBe(IMAGE_BYTES.toString('base64'));
    expect(test.models.classifyCalls[0]?.imageMimeType).toBe(IMAGE_MIME);
  });

  it('writes the supplied channel to every persisted row (Requirement 16.5)', async () => {
    const test = harness();

    await diagnose(request({ channel: 'whatsapp' }), test.deps);

    expect(onlyDiagnosisRow(test.store).channel).toBe('whatsapp');
    expect(onlyUsageRow(test.store).channel).toBe('whatsapp');
  });

  it('refuses a conversation id that is not this farmer’s', async () => {
    const test = harness({ store: storeStub({ ownsConversation: false }) });

    const error = await failure(diagnose(request({ conversationId: CONVERSATION_ID }), test.deps));

    expect(error.code).toBe('CONVERSATION_NOT_FOUND');
    expect(test.store.diagnoses).toHaveLength(0);
  });
});

/* ========================================================================== */
/* Healthy carries no treatment (Requirement 3.4)                              */
/* ========================================================================== */

describe('diagnose — a healthy classification carries no treatment content', () => {
  it('reports severity none and an empty treatment array, whatever the model said', async () => {
    const test = harness({
      models: modelStub({
        classify: visionJson({ disease_name: 'Tomato Healthy', severity: 'high', confidence: 0.8 }),
        generate: 'Your Tomato Healthy crop looks well.',
      }),
    });

    const outcome = await diagnose(request(), test.deps);

    expect(outcome.result.status).toBe('identified');
    expect(outcome.result.severity).toBe('none');
    expect(outcome.result.knowledge?.treatment).toEqual([]);
    expect(onlyDiagnosisRow(test.store).severity).toBe('none');
    expect(test.models.generateCalls[0]?.prompt).not.toContain('treatment');
  });
});

/* ========================================================================== */
/* The spend rule (2.6, 6.7, 14.3)                                             */
/* ========================================================================== */

describe('diagnose — the spend rule', () => {
  it('spends zero and calls no provider when the image is not owned (Requirement 2.6)', async () => {
    const test = harness({
      media: mediaReadStub({ owned: false }),
      rpc: unreachableCounter,
    });

    const error = await failure(diagnose(request(), test.deps));

    expect(error.code).toBe('STORAGE_REF_FORBIDDEN');
    expect(error.status).toBe(403);
    expect(test.models.classifyCalls).toHaveLength(0);
    expect(test.store.diagnoses).toHaveLength(0);
    expect(test.store.usage).toHaveLength(0);
  });

  it('refuses a burst before the reserve, leaving the daily counter untouched (13.8)', async () => {
    const minuteCalls: string[] = [];
    const minuteAtCeiling: CounterRpc = {
      tryIncrement: (args) => {
        minuteCalls.push(args.windowKind);
        return Promise.resolve(null);
      },
      decrement: () => {
        throw new Error('counter_decrement was called; a burst window is never refunded');
      },
      used: () => {
        throw new Error('counter_used was called; the burst check needs no read');
      },
    };

    const test = harness();

    const error = await failure(
      diagnose(request(), {
        ...test.deps,
        burst: burstLimiter({
          rpc: minuteAtCeiling,
          now: () => new Date(NOW_MS),
          prune: null,
        }),
      }),
    );

    expect(error.code).toBe('RATE_LIMITED');
    expect(error.status).toBe(429);
    expect(minuteCalls).toEqual(['minute']);

    expect(test.counter.increments).toBe(0);
    expect(test.counter.decrements).toBe(0);
    expect(test.models.classifyCalls).toHaveLength(0);
    expect(test.store.diagnoses).toHaveLength(0);

    expect(test.store.usage).toHaveLength(1);
    expect(onlyUsageRow(test.store)).toMatchObject({
      outcome: 'rate_limited',
      model_provider: 'none',
      used_fallback: false,
      quota_spent: false,
      rejection_reason: null,
    });
  });

  it('spends exactly one unit for an accepted inconclusive result (Requirement 6.7)', async () => {
    const test = harness({
      models: modelStub({ classify: visionJson({ status: 'unclear', disease_name: null }) }),
    });

    await diagnose(request(), test.deps);

    expect(test.counter.increments).toBe(1);
    expect(test.counter.decrements).toBe(0);
    expect(onlyUsageRow(test.store).quota_spent).toBe(true);
  });

  it('declines at the limit with the limit and reset, and calls no provider (14.3)', async () => {
    const test = harness({ counter: counterStub({ tryIncrement: null }) });

    const error = await failure(diagnose(request(), test.deps));

    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.details).toEqual({
      limit: DAILY_QUOTAS.image,
      used: DAILY_QUOTAS.image,
      resetsAt: '2026-09-16T18:30:00.000Z',
    });
    expect(test.models.classifyCalls).toHaveLength(0);
    expect(test.store.diagnoses).toHaveLength(0);
    expect(onlyUsageRow(test.store)).toMatchObject({
      outcome: 'quota_declined',
      model_provider: 'none',
      quota_spent: false,
    });
  });

  it('does not refund an exhausted provider chain (Requirement 14.8)', async () => {
    const test = harness({
      models: modelStub({
        classify: new AppError('PROVIDERS_UNAVAILABLE', { context: { usedFallback: true } }),
      }),
    });

    const error = await failure(diagnose(request(), test.deps));

    expect(error.code).toBe('PROVIDERS_UNAVAILABLE');
    expect(test.counter.decrements).toBe(0);
    expect(test.store.diagnoses).toHaveLength(0);
    expect(onlyUsageRow(test.store)).toMatchObject({
      outcome: 'provider_error',
      quota_spent: true,
      used_fallback: true,
    });
  });
});

/* ========================================================================== */
/* The rephrase step's failure modes                                           */
/* ========================================================================== */

describe('diagnose — the rephrase step', () => {
  it('returns DIAGNOSIS_TIMEOUT when the budget cannot fit the call (Requirement 3.7)', async () => {
    const test = harness({ deadlineMs: NOW_MS + 1_000 });

    const error = await failure(diagnose(request(), test.deps));

    expect(error.code).toBe('DIAGNOSIS_TIMEOUT');
    expect(test.models.generateCalls).toHaveLength(0);
    expect(test.counter.decrements).toBe(0);
    expect(test.store.diagnoses).toHaveLength(0);
    expect(onlyUsageRow(test.store)).toMatchObject({ outcome: 'timeout', quota_spent: true });
  });

  it('degrades to the knowledge-base template when the text provider fails', async () => {
    const test = harness({
      models: modelStub({ generate: new AppError('PROVIDERS_UNAVAILABLE') }),
    });

    const outcome = await diagnose(request(), test.deps);

    expect(outcome.result.status).toBe('identified');
    expect(outcome.result.explanation).toBe(staticExplanationFor(EARLY_BLIGHT, 'en'));
    expect(outcome.result.explanation).toContain('Tomato Early Blight');

    expect(onlyUsageRow(test.store)).toMatchObject({
      outcome: 'provider_error',
      quota_spent: true,
      diagnosis_id: DIAGNOSIS_ID,
    });
  });

  it('keeps a timeout raised mid-call a timeout', async () => {
    const test = harness({ models: modelStub({ generate: new AppError('DIAGNOSIS_TIMEOUT') }) });

    const error = await failure(diagnose(request(), test.deps));

    expect(error.code).toBe('DIAGNOSIS_TIMEOUT');
    expect(test.store.diagnoses).toHaveLength(0);
    expect(onlyUsageRow(test.store).outcome).toBe('timeout');
  });

  it('falls back to the template when a returned rephrase fails its checks', async () => {
    const test = harness({ models: modelStub({ generate: '   ' }) });

    const outcome = await diagnose(request(), test.deps);

    expect(outcome.result.explanation).toBe(staticExplanationFor(EARLY_BLIGHT, 'en'));
    expect(onlyUsageRow(test.store)).toMatchObject({
      outcome: 'validation_rejected',
      rejection_reason: 'rephrase_rejected',
      quota_spent: true,
    });
  });
});

/* ========================================================================== */
/* A missing knowledge-base row (Requirement 4.1's unseeded deployment)        */
/* ========================================================================== */

describe('diagnose — an unseeded knowledge base', () => {
  it('returns the inconclusive shape rather than ungrounded advice', async () => {
    const test = harness({ knowledgeRows: [LATE_BLIGHT] });

    const outcome = await diagnose(request(), test.deps);

    expect(outcome.result.status).toBe('unknown');
    expect(outcome.rejectionReason).toBe('unverified_condition');
    expect(test.models.generateCalls).toHaveLength(0);
    expect(onlyDiagnosisRow(test.store).diseaseName).toBeNull();
  });
});

/* ========================================================================== */
/* The two validation stages, directly                                         */
/* ========================================================================== */

describe('interpret', () => {
  it('accepts a well-formed, in-knowledge-base response', () => {
    expect(interpret(visionJson())).toEqual({
      ok: true,
      verified: {
        status: 'identified',
        disease_name: 'Tomato Early Blight',
        confidence: 0.87,
        severity: 'moderate',
      },
    });
  });

  it('treats the closed confidence interval as closed (Requirement 5.4)', () => {
    expect(interpret(visionJson({ confidence: 0 })).ok).toBe(true);
    expect(interpret(visionJson({ confidence: 1 })).ok).toBe(true);
    expect(interpret(visionJson({ confidence: -0.1 }))).toEqual({
      ok: false,
      reason: 'confidence_out_of_range',
    });
    expect(interpret(visionJson({ confidence: 1.1 }))).toEqual({
      ok: false,
      reason: 'confidence_out_of_range',
    });
  });

  it('rejects a fenced JSON block rather than unwrapping it', () => {
    expect(interpret(`\`\`\`json\n${visionJson()}\n\`\`\``)).toEqual({
      ok: false,
      reason: 'not_json',
    });
  });

  it('rejects an identified response with no name', () => {
    expect(interpret(visionJson({ disease_name: null }))).toEqual({
      ok: false,
      reason: 'unverified_condition',
    });
  });

  it('rejects a payload that is valid JSON but not the diagnosis object', () => {
    expect(interpret('"unclear"')).toEqual({ ok: false, reason: 'missing_field' });
    expect(interpret('[]')).toEqual({ ok: false, reason: 'missing_field' });
  });
});
