import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { messages } from '@/lib/messages';
import {
  HEALTHY_CONDITION,
  type IdentifiedResult,
  type InconclusiveResult,
  type Language,
  type RejectionReason,
  type VerifiedCondition,
  type VisionRaw,
} from '@/lib/schemas';
import { dayWindowKey } from '@/lib/time';
import { COLLECTIONS, type DiagnosisDoc, type DiseaseKnowledgeDoc, type UsageLogDoc } from '@/lib/db/collections';

import { knowledgeRow, startHarness, type Harness } from './harness';
import {
  CLASSIFICATIONS,
  classificationText,
  echoingRephrase,
  imagePartsOf,
  promptTextOf,
  providerCallCount,
  verifiedItemsIn,
  type EchoingRephrase,
} from './providers';

/**
 * The image path, scenario by scenario, against a real single-node `MongoMemoryReplSet` (V31, V33).
 *
 * Requirements: 3.2 (an identified result carries the Canonical_Disease_Name, the returned
 *               confidence and severity, and an explanation composed only from the matching
 *               Knowledge_Base entry), 3.4 (a healthy crop reports severity `none` and carries no
 *               treatment content), 3.5 (a multi-leaf image yields exactly one primary condition),
 *               6.1–6.7 (one inconclusive shape, no name carried, no second model call, one unit
 *               still spent), 5.6 / 5.7 (stage 2 and the recorded rejection reason), 2.8 (the bytes
 *               reach the model inline, read from GridFS — A3), 3.3 (persistence), 13.2 (owner
 *               scoping), 17.5
 * Design: "Integration tests — mocked providers, real MongoDB"; D2 (two-stage validation), D3 (one
 *         inconclusive shape), D4 (no repair re-ask), D18 (owner-scoping is the Data_Access_Layer),
 *         Amendment A3 (the analysis reads bytes from GridFS by Media_Reference, not a Signed_URL)
 *
 * =============================================================================
 * WHAT MAKES THESE SCENARIOS AND NOT UNIT TESTS — RESTATED FOR A3
 * =============================================================================
 *
 * `src/services/diagnosis.service.test.ts` drives every branch below with a stubbed
 * `CapabilityRunner`, store and knowledge reader. What it cannot do is what the requirements are
 * about:
 *
 *  - **3.2's "composed only from the matching Knowledge_Base entry"** is a claim about a row
 *    `setupDatabase` seeded; a stubbed reader would compare the fixture with itself. Here the row
 *    is the seed and the harness never inserts `disease_knowledge`.
 *  - **3.4's "no treatment content"** rests on `Tomato Healthy` having none — a seed fact AND the
 *    collection validator's shape, both of which need a real database.
 *  - **3.3's persistence** and the diagnosis validator decide whether the inconclusive row is even
 *    insertable; a stubbed store accepts anything.
 *  - **6.7's "exactly one image analysis"** is the real `counters` conditional upsert, read back
 *    through the owner-scoped DAL (D10), not from the response envelope.
 *  - **2.8's inline bytes** — under A3 the service reads the bytes from GridFS by Media_Reference
 *    and hands them to the model as `data`; a stub never touches GridFS.
 *  - **13.2** needs a second farmer's scope, which no unit test has.
 *
 * Grounding is turned into an assertion through `echoingRephrase()`: the rephrase stub returns only
 * lines it found in the prompt the service itself built, so any line in the explanation that is not
 * a verbatim row item came from Jamee. The reasoning lives where the stub is defined.
 */

/** English throughout: the language step is `release-acceptance.test.ts`'s (Requirements 9.3, 9.4). */
const LANGUAGE: Language = 'en';
/** The language name the echo stub emits — the one non-agronomic line every answer carries. */
const LANGUAGE_NAME = 'English';

/**
 * The quota window every reserve in this file lands in — pinned and in the past so an assertion
 * cannot straddle a Kolkata midnight and read a fresh row (the reason `QuotaOptions.now` exists).
 * Everything else about the reserve is the real `counters` conditional upsert. Fewer than twenty
 * reserves against a limit of twenty, so the shared window never declines one.
 */
const QUOTA_INSTANT = new Date(Date.UTC(1970, 0, 15, 12, 0, 0));

/** A classification naming two conditions at once — Requirement 3.5's failure mode. */
const TWO_CONDITIONS: VisionRaw = {
  status: 'identified',
  disease_name: 'Tomato Early Blight, Potato Late Blight',
  confidence: 0.9,
  severity: 'high',
};

/** A healthy crop the model nonetheless graded — Requirement 3.4 pins this to `none`. */
const HEALTHY_WITH_SEVERITY: VisionRaw = {
  status: 'identified',
  disease_name: HEALTHY_CONDITION,
  confidence: 0.94,
  severity: 'high',
};

let harness: Harness;
let rephrase: EchoingRephrase;
type Diagnosis = typeof import('@/services/diagnosis.service');
type Farmer = typeof import('@/lib/db/farmer');
let diagnosis: Diagnosis;
let farmer: Farmer;

beforeAll(async () => {
  rephrase = echoingRephrase();
  harness = await startHarness({ providers: { text: rephrase.text } });
  // Import AFTER startHarness set MONGODB_URI, so the DAL's cached client connects to the harness.
  diagnosis = await import('@/services/diagnosis.service');
  farmer = await import('@/lib/db/farmer');
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await harness.reset();
});

/* ========================================================================== */
/* Wiring and shared assertions                                               */
/* ========================================================================== */

/**
 * The web channel's dependencies. Under A3 the service reads the bytes from GridFS itself, so there
 * is no storage/store injection — every seam defaults to the real Data_Access_Layer, and `quota`
 * only pins the clock so the reserve lands in `QUOTA_INSTANT`.
 */
function webDeps(): import('@/services/diagnosis.service').DiagnosisDeps {
  return { models: harness.providers.models, quota: { now: QUOTA_INSTANT } };
}

/** One owned GridFS image from farmer A, classified as `raw`, answered on the web channel. */
async function diagnoseAs(raw: VisionRaw | string): Promise<import('@/services/diagnosis.service').DiagnosisOutcome> {
  harness.providers.script.vision = typeof raw === 'string' ? raw : classificationText(raw);
  const image = await harness.objects.image(harness.farmerA.id);
  return diagnosis.diagnose(
    { userId: harness.farmerA.id, image, language: LANGUAGE, channel: 'web' },
    webDeps(),
  );
}

function identifiedOf(outcome: import('@/services/diagnosis.service').DiagnosisOutcome): IdentifiedResult {
  expect(outcome.result.status).toBe('identified');
  if (outcome.result.status !== 'identified') throw new Error(`expected identified, got ${outcome.result.status}`);
  return outcome.result;
}

function inconclusiveOf(outcome: import('@/services/diagnosis.service').DiagnosisOutcome): InconclusiveResult {
  expect(outcome.result.status).toBe('unknown');
  if (outcome.result.status !== 'unknown') throw new Error(`expected inconclusive, got ${outcome.result.status}`);
  return outcome.result;
}

/** Farmer A's image counter in the pinned window — the source of truth for what was spent (D10). */
function imageUnitsUsed(): Promise<number> {
  return farmer.farmerData(harness.farmerA.id).counterUsed('image', 'day', dayWindowKey(QUOTA_INSTANT));
}

/** The stored diagnosis document (service-role view). */
async function storedDiagnosis(id: string): Promise<DiagnosisDoc | null> {
  return harness.db
    .collection<DiagnosisDoc>(COLLECTIONS.diagnoses)
    .findOne({ _id: (await import('mongodb')).ObjectId.createFromHexString(id) });
}

/** The audit rows for one diagnosis (camelCase Mongo shape). */
async function auditFor(diagnosisId: string): Promise<UsageLogDoc[]> {
  const id = (await import('mongodb')).ObjectId.createFromHexString(diagnosisId);
  return harness.db.collection<UsageLogDoc>(COLLECTIONS.usageLogs).find({ diagnosisId: id }).toArray();
}

async function expectAudit(
  diagnosisId: string,
  expected: { outcome: string; rejectionReason: RejectionReason | null; quotaSpent: boolean },
): Promise<void> {
  const rows = await auditFor(diagnosisId);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row?.operation).toBe('image');
  expect(row?.channel).toBe('web');
  expect(row?.outcome).toBe(expected.outcome);
  expect(row?.rejectionReason ?? null).toBe(expected.rejectionReason);
  expect(row?.quotaSpent).toBe(expected.quotaSpent);
  expect(row?.ownerId).toBe(harness.farmerA.id);
}

/**
 * Requirement 13.2. The owner reads the row; the other farmer's scope reads nothing.
 *
 * Asserted on every scenario rather than once, because a suite that only checked its own rows would
 * pass against a Data_Access_Layer with the owner merge removed.
 */
async function expectVisibleToOwnerOnly(diagnosisId: string): Promise<void> {
  const mine = await farmer.farmerData(harness.farmerA.id).findOneDiagnosis({});
  const theirs = await farmer.farmerData(harness.farmerB.id).findDiagnoses();
  expect(mine).not.toBeNull();
  // The whole harness exists for this line.
  expect(theirs.some((row) => row._id.toHexString() === diagnosisId)).toBe(false);
  expect(theirs).toEqual([]);
}

/** Every line a farmer may read without Jamee having invented it. */
function traceableLines(rows: readonly DiseaseKnowledgeDoc[]): ReadonlySet<string> {
  const allowed = new Set<string>([LANGUAGE_NAME]);
  for (const row of rows) {
    allowed.add(row.diseaseName);
    for (const field of ['symptoms', 'causes', 'treatment', 'prevention'] as const) {
      for (const item of row[field]) allowed.add(item);
    }
  }
  return allowed;
}

/** The lines of `text` that trace to no row — empty is the assertion (Requirement 4.3). */
function untraceableLines(text: string, rows: readonly DiseaseKnowledgeDoc[]): string[] {
  const allowed = traceableLines(rows);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !allowed.has(line));
}

/** The grounded shape every identified scenario shares: the row's own payload, no borrowed sentence. */
function expectGroundedIn(
  outcome: import('@/services/diagnosis.service').DiagnosisOutcome,
  condition: VerifiedCondition,
): void {
  const row = knowledgeRow(harness, condition);
  const result = identifiedOf(outcome);

  expect(result.diseaseName).toBe(condition);
  // Requirement 3.2, out of the model: the structured payload is the row's own arrays.
  expect(result.knowledge).toEqual({
    symptoms: row.symptoms,
    causes: row.causes,
    treatment: row.treatment,
    prevention: row.prevention,
    source: row.source,
  });
  // Requirement 4.5, into the model: the request carried this row's four arrays, in order.
  expect(verifiedItemsIn(rephrase.last())).toEqual([
    ...row.symptoms,
    ...row.causes,
    ...row.treatment,
    ...row.prevention,
  ]);
  // Requirements 4.6 / 9.4 — the canonical name leads in Latin script.
  expect(result.explanation.split('\n')[0]).toBe(condition);
  expect(
    untraceableLines(result.explanation, [row]),
    `${condition}: explanation lines that trace to no knowledge-base row`,
  ).toEqual([]);
}

/** The inconclusive shape every non-identified scenario shares (Requirements 6.4, 6.5). */
function expectInconclusiveShape(
  outcome: import('@/services/diagnosis.service').DiagnosisOutcome,
  reason: RejectionReason,
): InconclusiveResult {
  const result = inconclusiveOf(outcome);
  expect(result.needsExpert).toBe(true);
  expect(result.severity).toBe('none');
  expect(result.language).toBe(LANGUAGE);
  expect(result.diseaseName).toBeNull();
  expect(result.confidence).toBeNull();
  expect(result.knowledge).toBeNull();
  // D5 — the sentence is the static catalog entry for this reason, not model prose.
  expect(result.explanation).toBe(messages(LANGUAGE).inconclusive[reason]);
  expect(outcome.rejectionReason).toBe(reason);
  return result;
}

/** The persisted inconclusive row, which the diagnosis validator refuses if the shape drifts. */
async function expectInconclusiveRow(outcome: import('@/services/diagnosis.service').DiagnosisOutcome): Promise<void> {
  const stored = await storedDiagnosis(outcome.diagnosisId);
  expect(stored?.status).toBe('unknown');
  expect(stored?.diseaseName ?? null).toBeNull();
  expect(stored?.knowledgeId ?? null).toBeNull();
  expect(stored?.confidence ?? null).toBeNull();
  expect(stored?.severity).toBe('none');
  expect(stored?.needsExpert).toBe(true);
  expect(stored?.explanation).toBe(outcome.result.explanation);
}

/* ========================================================================== */
/* A clear diseased crop — Requirement 3.2                                    */
/* ========================================================================== */

describe('a clear diseased crop', () => {
  it('grounds the result in the seeded row of the name the model reported', async () => {
    const classified = CLASSIFICATIONS.tomatoEarlyBlight;
    const condition: VerifiedCondition = classified.disease_name;

    const before = await imageUnitsUsed();
    const callsBefore = providerCallCount(harness.providers.calls);
    const outcome = await diagnoseAs(classified);

    expectGroundedIn(outcome, condition);
    const result = identifiedOf(outcome);
    expect(result.confidence).toBe(classified.confidence);
    expect(result.severity).toBe(classified.severity);
    expect(result.needsExpert).toBe(false);

    // Requirement 3.3 — the row carries the farmer, the conversation, the Media_Reference and channel.
    const stored = await storedDiagnosis(outcome.diagnosisId);
    expect(stored?.ownerId).toBe(harness.farmerA.id);
    expect(stored?.conversationId.toHexString()).toBe(outcome.conversationId);
    expect(stored?.channel).toBe('web');
    expect(stored?.mediaRef.kind).toBe('crop-image');
    expect(stored?.diseaseName).toBe(condition);
    expect(stored?.explanation).toBe(result.explanation);
    expect(stored?.language).toBe(LANGUAGE);

    // Requirement 2.8 (A3) — the provider was handed the farmer's own bytes INLINE, never a URL.
    const visionRequest = harness.providers.calls.geminiVision.at(-1);
    expect(visionRequest).toBeDefined();
    const images = visionRequest === undefined ? [] : imagePartsOf(visionRequest);
    // The A3 inline form carries `data` (base64), not a signed `uri`.
    expect(images.length === 0 || (images[0] as Record<string, unknown>)['uri'] === undefined).toBe(true);

    // Two round trips and no more: one classification, one rephrase. D4 forbids a repair re-ask.
    expect(providerCallCount(harness.providers.calls)).toBe(callsBefore + 2);

    await expectAudit(outcome.diagnosisId, { outcome: 'success', rejectionReason: null, quotaSpent: true });
    expect(await imageUnitsUsed()).toBe(before + 1);
    await expectVisibleToOwnerOnly(outcome.diagnosisId);
  });
});

/* ========================================================================== */
/* A healthy crop — Requirement 3.4                                           */
/* ========================================================================== */

describe('a healthy crop', () => {
  it('reports severity none and an explanation with no treatment content', async () => {
    const row = knowledgeRow(harness, HEALTHY_CONDITION);
    // The seed fact the requirement rests on: the healthy row itself has no treatment content.
    expect(row.treatment).toEqual([]);

    const outcome = await diagnoseAs(CLASSIFICATIONS.tomatoHealthy);
    expectGroundedIn(outcome, HEALTHY_CONDITION);

    const result = identifiedOf(outcome);
    expect(result.severity).toBe('none');
    expect(result.knowledge?.treatment).toEqual([]);

    // No treatment sentence from ANY seeded row appears in the healthy explanation.
    const everyTreatmentSentence = harness.knowledge.flatMap((entry) => entry.treatment);
    expect(everyTreatmentSentence.length).toBeGreaterThan(0);
    for (const sentence of everyTreatmentSentence) expect(result.explanation).not.toContain(sentence);

    // The prompt is the other half: an empty treatment array means the model was never given
    // treatment content to rephrase.
    expect(verifiedItemsIn(rephrase.last())).toEqual([...row.symptoms, ...row.causes, ...row.prevention]);

    await expectAudit(outcome.diagnosisId, { outcome: 'success', rejectionReason: null, quotaSpent: true });
    await expectVisibleToOwnerOnly(outcome.diagnosisId);
  });

  it('pins severity to none even when the model graded the healthy crop', async () => {
    const outcome = await diagnoseAs(HEALTHY_WITH_SEVERITY);
    const result = identifiedOf(outcome);
    expect(result.diseaseName).toBe(HEALTHY_CONDITION);
    expect(HEALTHY_WITH_SEVERITY.severity).toBe('high');
    expect(result.severity).toBe('none');
    const stored = await storedDiagnosis(outcome.diagnosisId);
    expect(stored?.severity).toBe('none');
    expect(stored?.diseaseName).toBe(HEALTHY_CONDITION);
  });
});

/* ========================================================================== */
/* A blurry image — Requirement 6.2                                           */
/* ========================================================================== */

describe('a blurry image the model declines to judge', () => {
  it('returns the inconclusive shape, spends one unit, and calls no second model', async () => {
    const before = await imageUnitsUsed();
    const callsBefore = providerCallCount(harness.providers.calls);

    const outcome = await diagnoseAs(CLASSIFICATIONS.unclear);
    const result = expectInconclusiveShape(outcome, 'model_unclear');
    expect(result.explanation).toContain('good daylight');
    expect(result.explanation).toContain('agricultural expert');

    // Requirement 6.6 — one round trip for the whole request.
    expect(providerCallCount(harness.providers.calls)).toBe(callsBefore + 1);
    await expectInconclusiveRow(outcome);
    await expectAudit(outcome.diagnosisId, { outcome: 'inconclusive', rejectionReason: 'model_unclear', quotaSpent: true });
    // Requirement 6.7 — an accepted inconclusive result still counts exactly one image analysis.
    expect(await imageUnitsUsed()).toBe(before + 1);
    await expectVisibleToOwnerOnly(outcome.diagnosisId);
  });
});

/* ========================================================================== */
/* A non-plant image — Requirement 6.3                                        */
/* ========================================================================== */

describe('an image with no plant in it', () => {
  it('asks for a photo of the affected crop and calls no second model', async () => {
    const before = await imageUnitsUsed();
    const callsBefore = providerCallCount(harness.providers.calls);

    const outcome = await diagnoseAs(CLASSIFICATIONS.noPlant);
    const result = expectInconclusiveShape(outcome, 'model_no_plant');
    expect(result.explanation).toContain('affected crop leaf');
    expect(result.explanation).not.toBe(messages(LANGUAGE).inconclusive.model_unclear);

    expect(providerCallCount(harness.providers.calls)).toBe(callsBefore + 1);
    await expectInconclusiveRow(outcome);
    await expectAudit(outcome.diagnosisId, { outcome: 'inconclusive', rejectionReason: 'model_no_plant', quotaSpent: true });
    expect(await imageUnitsUsed()).toBe(before + 1);
    await expectVisibleToOwnerOnly(outcome.diagnosisId);
  });
});

/* ========================================================================== */
/* A condition outside the five — Requirements 6.1, 5.6, 6.5                  */
/* ========================================================================== */

describe('a real condition the knowledge base does not cover', () => {
  it('recommends an expert and repeats none of the name the model guessed', async () => {
    const classified = CLASSIFICATIONS.outsideKnowledgeBase;
    const before = await imageUnitsUsed();
    const callsBefore = providerCallCount(harness.providers.calls);

    const outcome = await diagnoseAs(classified);
    const result = expectInconclusiveShape(outcome, 'unverified_condition');
    expect(result.explanation).toContain('agricultural expert');
    // Requirement 6.5 — the guessed name is nowhere in what the farmer receives, nor in storage.
    expect(result.explanation).not.toContain(classified.disease_name);
    const stored = await storedDiagnosis(outcome.diagnosisId);
    expect(stored?.explanation ?? '').not.toContain(classified.disease_name);
    expect(stored?.diseaseName ?? null).toBeNull();

    expect(providerCallCount(harness.providers.calls)).toBe(callsBefore + 1);
    await expectInconclusiveRow(outcome);
    // `validation_rejected`, not `inconclusive`: Jamee's Validation_Layer refused a name (5.6).
    await expectAudit(outcome.diagnosisId, { outcome: 'validation_rejected', rejectionReason: 'unverified_condition', quotaSpent: true });
    expect(await imageUnitsUsed()).toBe(before + 1);
    await expectVisibleToOwnerOnly(outcome.diagnosisId);
  });
});

/* ========================================================================== */
/* Tomato and potato — Requirement 3.2 across both crops                      */
/* ========================================================================== */

describe('tomato and potato crops', () => {
  it('grounds each crop in its own row and borrows no sentence from the other', async () => {
    const tomato = await diagnoseAs(CLASSIFICATIONS.tomatoEarlyBlight);
    expectGroundedIn(tomato, 'Tomato Early Blight');
    const potato = await diagnoseAs(CLASSIFICATIONS.potatoLateBlight);
    expectGroundedIn(potato, 'Potato Late Blight');

    const tomatoRow = knowledgeRow(harness, 'Tomato Early Blight');
    const potatoRow = knowledgeRow(harness, 'Potato Late Blight');
    expect(tomatoRow.crop).toBe('tomato');
    expect(potatoRow.crop).toBe('potato');

    const tomatoResult = identifiedOf(tomato);
    const potatoResult = identifiedOf(potato);
    expect(tomatoResult.knowledge).not.toEqual(potatoResult.knowledge);

    // The cross-crop leak assertion, both directions.
    const onlyTomato = new Set(tomatoRow.symptoms);
    for (const item of potatoRow.symptoms) onlyTomato.delete(item);
    expect(onlyTomato.size).toBeGreaterThan(0);
    for (const sentence of onlyTomato) expect(potatoResult.explanation).not.toContain(sentence);

    const onlyPotato = new Set(potatoRow.symptoms);
    for (const item of tomatoRow.symptoms) onlyPotato.delete(item);
    expect(onlyPotato.size).toBeGreaterThan(0);
    for (const sentence of onlyPotato) expect(tomatoResult.explanation).not.toContain(sentence);

    await expectVisibleToOwnerOnly(tomato.diagnosisId);
    await expectVisibleToOwnerOnly(potato.diagnosisId);
  });
});

/* ========================================================================== */
/* Several leaves in one image — Requirement 3.5                              */
/* ========================================================================== */

describe('several leaves in one image', () => {
  it('asks the model for exactly one condition and reports exactly one', async () => {
    const outcome = await diagnoseAs(CLASSIFICATIONS.tomatoEarlyBlight);
    const result = identifiedOf(outcome);

    const visionRequest = harness.providers.calls.geminiVision.at(-1);
    expect(visionRequest).toBeDefined();
    const prompt = visionRequest === undefined ? '' : promptTextOf(visionRequest);
    expect(prompt).toContain('If several leaves are visible');
    expect(prompt).toContain('exactly one condition');

    expect(result.diseaseName).toBe('Tomato Early Blight');

    const rows = await farmer.farmerData(harness.farmerA.id).findDiagnoses();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.diseaseName).toBe('Tomato Early Blight');
  });

  it('refuses a classification that names two conditions instead of picking one', async () => {
    const callsBefore = providerCallCount(harness.providers.calls);
    const outcome = await diagnoseAs(TWO_CONDITIONS);

    const result = expectInconclusiveShape(outcome, 'unverified_condition');
    expect(result.explanation).not.toContain('Tomato Early Blight');
    expect(result.explanation).not.toContain('Potato Late Blight');

    expect(providerCallCount(harness.providers.calls)).toBe(callsBefore + 1);
    await expectInconclusiveRow(outcome);
    await expectAudit(outcome.diagnosisId, { outcome: 'validation_rejected', rejectionReason: 'unverified_condition', quotaSpent: true });
  });
});
