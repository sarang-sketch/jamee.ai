import { Buffer } from 'node:buffer';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner, TextCall, VisionCall } from '@/lib/ai/capabilities';
import type { DiagnosisInsert } from '@/lib/db/analysis';
import { AppError } from '@/lib/errors';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import {
  HEALTHY_CONDITION,
  SUPPORTED_LANGUAGES,
  VERIFIED_CONDITIONS,
  type Channel,
  type Language,
  type MediaRef,
  type Severity,
  type VerifiedCondition,
} from '@/lib/schemas';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import { diagnose, type DiagnosisDeps, type DiagnosisStore } from '@/services/diagnosis.service';
import type { CounterRpc } from '@/services/quota.service';

/**
 * ### Property 12: A healthy classification carries no treatment content
 *
 * *"For any diagnosis identified as Tomato Healthy, the result has severity `none`, reports a
 * healthy crop, and contains no treatment sentence from any knowledge base row."*
 *
 * **Validates: Requirement 3.4**
 *
 * =============================================================================
 * WHERE THE PROPERTY IS OBSERVED
 * =============================================================================
 *
 * Through `diagnose()` with every seam injected — no Supabase stack, no provider, no clock of its
 * own — because the healthy branch is **not a branch**. It is the identified path with two local
 * differences: `severity` is pinned to `none` (step 8 of the service), and the row it grounds on has
 * `treatment: []`. Everything else — `knowledgePayloadOf`, `rephrasePrompt`, `validateRephrased`,
 * `staticExplanationFor`, `finish` — is the same code that serves `Tomato Late Blight`. That shared
 * path is exactly where the interesting failure lives: a grounding step that attaches the row's
 * `treatment` array anyway, or a copy of it that survives into the persisted row.
 *
 * So the assertions are about **absence of content**, never about a flag:
 *
 *  - `result.knowledge.treatment` is empty — and the rest of the payload is not, so "no treatment"
 *    cannot pass by way of an empty payload;
 *  - the served explanation contains **no treatment sentence from any of the five seeded rows**, and
 *    no treatment heading from any of the three catalogs;
 *  - the **persisted** explanation is the same string, so nothing is stripped for display only;
 *  - the rephrase request itself carries no treatment sentence and never the word `treatment`,
 *    which is Requirement 3.4 enforced by omission (`contentFieldsOf()` in `prompts.ts`) rather than
 *    by an instruction the model has to cooperate with.
 *
 * =============================================================================
 * THE MODEL'S SEVERITY IS GENERATED, INCLUDING `high`
 * =============================================================================
 *
 * `visionVerifiedSchema` accepts any of the four severities alongside a `Tomato Healthy` name — it
 * gates the *name*, not the pairing — so "a healthy plant with severity `high`" is a response the
 * validation layer admits, and pinning it to `none` is the service's job. Generating all four
 * severities is what makes that a checked fact rather than a comment.
 *
 * =============================================================================
 * THE REPHRASE RESPONSE IS GENERATED ACROSS EVERY CLASS JAMEE'S CHECKS CONTEMPLATE
 * =============================================================================
 *
 * `validateRephrased()` has four post-generation checks and a fallback, and `explain()` adds a
 * provider-failure fallback on top. Each of those exits reaches the farmer by a different route, so
 * a property about what the farmer receives has to generate all of them: a faithful paraphrase, one
 * missing the canonical name (repaired in process), an empty one, an over-long one, one naming
 * another verified condition (deny-listed), and a provider failure. `REPHRASE_KINDS` is asserted as
 * exercised after the run, so a generator that quietly stopped producing one of them fails the test
 * instead of shrinking its coverage.
 *
 * **What is deliberately NOT generated: a provider that fabricates a treatment sentence out of
 * nothing.** `prompts.ts` states the limit in its own words — the checks are heuristics over
 * *presentation*, and the substantive guarantee is that the request contains no treatment content
 * for a model to leak. A stub that returns another row's treatment sentence verbatim is not a
 * diagnosis of Jamee; it is content Jamee never supplied, and the deny-list scan looks for condition
 * *names*, not sentences. The honest statement of the guarantee is the one asserted here: no
 * treatment content goes out, and none goes in either.
 *
 * =============================================================================
 * THE CONTROL PROPERTY IS WHY THE ABSENCE ASSERTIONS HAVE TEETH
 * =============================================================================
 *
 * "No treatment sentence appears" would also pass a harness whose knowledge base had no treatment
 * content at all. The second property runs the same pipeline over the four **disease** rows on the
 * fallback classes and asserts the opposite: the payload carries the row's treatment array, the
 * request carries its sentences, and the static template renders them under the localized heading.
 * One implementation, two outcomes, decided by the row.
 */

/* ========================================================================== */
/* Fixtures — the five seeded rows, character for character                     */
/* ========================================================================== */

/**
 * The rows are copied from `0010_seed_disease_knowledge.sql` rather than invented, for the reason
 * `prompts.test.ts` gives about the same fixtures: `Tomato Healthy`'s `treatment: []` is the row
 * Requirement 3.4 is about, and the four disease rows' real treatment sentences are what the
 * absence assertions below scan for. A simplified fixture would pass a test the real content fails.
 */
function seededRow(
  index: number,
  fields: Pick<
    KnowledgeEntry,
    | 'disease_name'
    | 'crop'
    | 'scientific_name'
    | 'symptoms'
    | 'causes'
    | 'treatment'
    | 'prevention'
    | 'default_severity'
  >,
): KnowledgeEntry {
  return {
    id: `0000000${index}-0000-4000-8000-000000000000`,
    source: `${fields.disease_name} extension bulletin, https://example.invalid/${index}`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...fields,
  };
}

const TOMATO_EARLY_BLIGHT = seededRow(1, {
  disease_name: 'Tomato Early Blight',
  crop: 'tomato',
  scientific_name: 'Alternaria solani',
  symptoms: [
    'Dark brown spots with concentric rings on older, lower leaves',
    'Yellow halo around each spot',
    'Affected leaves dry and drop, starting from the bottom of the plant',
  ],
  causes: [
    'Fungal infection by Alternaria solani',
    'Warm, humid weather with leaf wetness',
    'Spores surviving on crop debris and volunteer plants',
  ],
  treatment: [
    'Remove and destroy affected lower leaves',
    'Apply a protectant fungicide labelled for early blight, following the label rate',
    'Avoid overhead irrigation late in the day',
  ],
  prevention: [
    'Rotate away from tomato and potato for two seasons',
    'Stake plants for airflow and mulch to limit soil splash',
    'Use certified disease-free seed and clear crop debris after harvest',
  ],
  default_severity: 'moderate',
});

const TOMATO_LATE_BLIGHT = seededRow(2, {
  disease_name: 'Tomato Late Blight',
  crop: 'tomato',
  scientific_name: 'Phytophthora infestans',
  symptoms: [
    'Large greasy grey-green to brown patches on leaves',
    'White fuzzy growth on leaf undersides in humid conditions',
    'Firm brown lesions on stems and fruit; rapid collapse of foliage',
  ],
  causes: [
    'Oomycete infection by Phytophthora infestans',
    'Cool, wet, humid weather',
    'Spores carried by wind and rain from nearby infected plants or tubers',
  ],
  treatment: [
    'Remove and destroy infected plants immediately, do not compost them',
    'Apply a fungicide labelled for late blight without delay, following the label rate',
    'Harvest healthy fruit early if spread is rapid',
  ],
  prevention: [
    'Plant resistant varieties where available',
    'Avoid overhead irrigation and crowded spacing',
    'Destroy volunteer tomato and potato plants and cull piles',
  ],
  default_severity: 'high',
});

/** `treatment: []` by seed AND by the `healthy_has_no_treatment` check constraint in `0004`. */
const TOMATO_HEALTHY = seededRow(3, {
  disease_name: HEALTHY_CONDITION,
  crop: 'tomato',
  scientific_name: null,
  symptoms: [
    'Uniform green leaves with no spots, lesions, or wilting',
    'Normal leaf shape and size for the growth stage',
  ],
  causes: ['No disease detected in the submitted photo'],
  treatment: [],
  prevention: [
    'Continue regular monitoring of lower leaves',
    'Keep foliage dry by watering at the base',
    'Maintain crop rotation and field sanitation',
  ],
  default_severity: 'none',
});

const POTATO_EARLY_BLIGHT = seededRow(4, {
  disease_name: 'Potato Early Blight',
  crop: 'potato',
  scientific_name: 'Alternaria solani',
  symptoms: [
    'Dark concentric-ringed lesions on older leaves',
    'Lesions bounded by leaf veins, giving an angular outline',
    'Progressive yellowing and death of lower foliage',
  ],
  causes: [
    'Fungal infection by Alternaria solani',
    'Warm temperatures with alternating wet and dry periods',
    'Inoculum surviving in soil and crop residue',
  ],
  treatment: [
    'Remove severely affected foliage',
    'Apply a protectant fungicide labelled for early blight on potato, per label rate',
    'Maintain balanced nitrogen to avoid early senescence',
  ],
  prevention: [
    'Rotate with non-solanaceous crops',
    'Plant certified seed tubers',
    'Bury or remove crop residue after harvest',
  ],
  default_severity: 'moderate',
});

const POTATO_LATE_BLIGHT = seededRow(5, {
  disease_name: 'Potato Late Blight',
  crop: 'potato',
  scientific_name: 'Phytophthora infestans',
  symptoms: [
    'Water-soaked pale green patches that turn brown-black',
    'White sporulation at lesion margins on leaf undersides in humid weather',
    'Dark firm rot on tubers',
  ],
  causes: [
    'Oomycete infection by Phytophthora infestans',
    'Cool, wet, humid conditions',
    'Infected seed tubers and wind-blown spores',
  ],
  treatment: [
    'Destroy infected plants and affected tubers',
    'Apply a fungicide labelled for potato late blight promptly, per label rate',
    'Kill the haulm before harvest in a severe outbreak to protect tubers',
  ],
  prevention: [
    'Plant certified, disease-free seed tubers',
    'Hill soil well to cover tubers and improve drainage',
    'Remove cull piles and volunteer plants',
  ],
  default_severity: 'high',
});

const SEEDED: Record<VerifiedCondition, KnowledgeEntry> = {
  'Tomato Early Blight': TOMATO_EARLY_BLIGHT,
  'Tomato Late Blight': TOMATO_LATE_BLIGHT,
  'Tomato Healthy': TOMATO_HEALTHY,
  'Potato Early Blight': POTATO_EARLY_BLIGHT,
  'Potato Late Blight': POTATO_LATE_BLIGHT,
};

/** The four disease rows — every condition that has treatment content to leak. */
const DISEASE_CONDITIONS: readonly VerifiedCondition[] = VERIFIED_CONDITIONS.filter(
  (condition) => condition !== HEALTHY_CONDITION,
);

/**
 * Every treatment sentence in the knowledge base. "Contains no treatment sentence from **any**
 * knowledge base row" is the design's wording, so the scan is over all five rows rather than only
 * the healthy one — a grounding step that reached for the wrong row would still be caught.
 */
const ALL_TREATMENT_SENTENCES: readonly string[] = VERIFIED_CONDITIONS.flatMap(
  (condition) => SEEDED[condition].treatment,
);

/** The localized "what to do" headings — the only other way treatment content reaches a screen. */
const TREATMENT_HEADINGS: readonly string[] = SUPPORTED_LANGUAGES.map(
  (language) => messages(language).ui.treatmentHeading,
);

/* ========================================================================== */
/* Fixtures — identifiers and the request                                      */
/* ========================================================================== */

const FARMER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const DIAGNOSIS_ID = '55555555-5555-4555-8555-555555555555';

/** A3: the analysis input is a `{ fileId, kind }` Media_Reference, not a bucket/path storage ref. */
const IMAGE_REF: MediaRef = { fileId: 'a'.repeat(24), kind: 'crop-image' };

/** The bytes the owner-checked read yields, and the MIME type stored alongside them. */
const IMAGE_BYTES = Buffer.from('jamee property harness: fake crop-image bytes');
const IMAGE_MIME = 'image/jpeg';

/** 2026-09-15T19:30:00Z is 2026-09-16T01:00 in Asia/Kolkata — the far side of the +05:30 offset. */
const NOW_MS = Date.parse('2026-09-15T19:30:00.000Z');

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const languageArb = fc.constantFrom<Language>(...SUPPORTED_LANGUAGES);
const channelArb = fc.constantFrom<Channel>('web', 'telegram');

/**
 * The severity the model claims. All four, including `high`, because that is the response
 * Requirement 3.4 is written about: a healthy plant cannot carry a severity, whatever the model
 * says, and stage 2 does not refuse the pairing.
 */
const modelSeverityArb = fc.constantFrom<Severity>('none', 'low', 'moderate', 'high');

/** `numeric(4,3)` between 0 and 1 inclusive — the interval `visionRawSchema` admits. */
const confidenceArb = fc.double({ min: 0, max: 1, noNaN: true });

/**
 * The classes of rephrase response, enumerated so the run can prove it exercised each one.
 *
 * A property over a `oneof` can pass while a branch never generates, and then an untested exit is
 * green rather than absent. The predicate records the kind it saw; the test asserts the set after.
 */
const REPHRASE_KINDS = [
  'faithful',
  'no_canonical_name',
  'empty',
  'whitespace_only',
  'too_long',
  'cross_contaminated',
  'provider_failed',
] as const;

type RephraseKind = (typeof REPHRASE_KINDS)[number];

interface RephraseResponse {
  readonly kind: RephraseKind;
  /** The model's text, or `null` when the provider chain fails instead of answering. */
  readonly text: string | null;
  /** Whether the farmer ends up reading `staticExplanationFor()` rather than the model's prose. */
  readonly expectStaticTemplate: boolean;
}

/**
 * A paraphrase built only from the row's own sentences, which is what a cooperative model returns.
 * `entry.causes` for the healthy row is *"No disease detected in the submitted photo"* — the
 * sentence that reports a healthy crop — so the faithful case carries the row's own healthy
 * statement rather than one this test authored.
 */
function faithfulText(entry: KnowledgeEntry, withName: boolean): string {
  const body = [...entry.symptoms, ...entry.causes, ...entry.prevention].join(' ');
  return withName ? `${entry.disease_name}. ${body}` : body;
}

function rephraseArb(entry: KnowledgeEntry): fc.Arbitrary<RephraseResponse> {
  /** A verified condition that is NOT this row's — check 3's deny-list target. */
  const otherCondition =
    VERIFIED_CONDITIONS.find((condition) => condition !== entry.disease_name) ??
    HEALTHY_CONDITION;

  return fc.constantFrom<RephraseResponse>(
    { kind: 'faithful', text: faithfulText(entry, true), expectStaticTemplate: false },
    {
      kind: 'no_canonical_name',
      // Check 2 prefixes the canonical name on, in process, with no second model call.
      text: faithfulText(entry, false),
      expectStaticTemplate: false,
    },
    { kind: 'empty', text: '', expectStaticTemplate: true },
    { kind: 'whitespace_only', text: '   \n\t  ', expectStaticTemplate: true },
    {
      kind: 'too_long',
      // Check 1's ceiling is `REPHRASE_MAX_CHARS`; this clears it without naming the constant, so
      // the case stays valid if the ceiling moves upward.
      text: `${entry.disease_name}. ${'leaf '.repeat(600)}`,
      expectStaticTemplate: true,
    },
    {
      kind: 'cross_contaminated',
      text: `${entry.disease_name}. This looks like ${otherCondition} as well.`,
      expectStaticTemplate: true,
    },
    { kind: 'provider_failed', text: null, expectStaticTemplate: true },
  );
}

/* ========================================================================== */
/* The harness — every seam injected, the two model calls captured              */
/* ========================================================================== */

/**
 * A3, V34: the owner-checked media read yields the bytes the model is sent inline. Every seam of
 * `diagnose()` is injected below, so there is no Supabase stack to stand in for.
 */
interface Captured {
  /** The prompts the classification call carried. */
  readonly visionCalls: VisionCall[];
  /** The rephrase requests. Requirement 4.5's "supply the row, ask for a rephrase". */
  readonly textCalls: TextCall[];
  /** Every `diagnoses` document the service tried to write. */
  readonly inserted: DiagnosisInsert[];
}

interface Harness {
  readonly deps: DiagnosisDeps;
  readonly captured: Captured;
}

function harness(options: {
  readonly condition: VerifiedCondition;
  readonly severity: Severity;
  readonly confidence: number;
  readonly rephrase: RephraseResponse;
}): Harness {
  const captured: Captured = { visionCalls: [], textCalls: [], inserted: [] };

  const readMedia = (): Promise<{ bytes: Buffer; mimeType: string }> =>
    Promise.resolve({ bytes: IMAGE_BYTES, mimeType: IMAGE_MIME });

  const rpc: CounterRpc = {
    tryIncrement: () => Promise.resolve(1),
    decrement: () => Promise.resolve(0),
    used: () => Promise.resolve(0),
  };

  const models: CapabilityRunner = {
    classify: (call: VisionCall) => {
      captured.visionCalls.push(call);
      return Promise.resolve({
        value: JSON.stringify({
          status: 'identified',
          disease_name: options.condition,
          confidence: options.confidence,
          severity: options.severity,
        }),
        provider: 'gemini' as const,
        usedFallback: false,
      });
    },
    generate: (call: TextCall) => {
      captured.textCalls.push(call);
      if (options.rephrase.text === null) {
        /**
         * The exhausted-chain exit, which `explain()` degrades to the static template rather than
         * failing the request: the classification already succeeded, so Requirement 3.2 is better
         * served by knowledge-base content than by an error.
         */
        return Promise.reject(
          new AppError('PROVIDERS_UNAVAILABLE', {
            context: { reason: 'chain_exhausted', usedFallback: true },
          }),
        );
      }
      return Promise.resolve({
        value: options.rephrase.text,
        provider: 'gemini' as const,
        usedFallback: false,
      });
    },
  };

  const store: DiagnosisStore = {
    insertDiagnosis: (row: DiagnosisInsert) => {
      captured.inserted.push(row);
      return Promise.resolve(DIAGNOSIS_ID);
    },
    insertUsageLog: () => Promise.resolve(),
    ownsConversation: () => Promise.resolve(true),
  };

  const conversations: ConversationStore = {
    mostRecent: (userId: string, channel: Conversation['channel']) =>
      Promise.resolve(conversationFor(userId, channel)),
    create: (userId: string, channel: Conversation['channel']) =>
      Promise.resolve(conversationFor(userId, channel)),
  };

  /** The real knowledge base, read the way `lookupCondition` reads it. */
  const knowledge: KnowledgeReader = (names) =>
    Promise.resolve(names.map((name) => SEEDED[name]));

  return {
    captured,
    deps: {
      store,
      readMedia,
      conversations,
      knowledge,
      models,
      quota: { rpc, now: new Date(NOW_MS) },
      now: () => NOW_MS,
      // `getDeadline()` answers `undefined` outside a platform invocation; stating it keeps the run
      // independent of whether the test happens to be inside one.
      platformDeadline: () => undefined,
    },
  };
}

function conversationFor(userId: string, channel: Conversation['channel']): Conversation {
  return {
    id: CONVERSATION_ID,
    user_id: userId,
    channel,
    title: null,
    created_at: '2026-09-16T00:59:00.000Z',
    updated_at: '2026-09-16T00:59:00.000Z',
  };
}

/** Every treatment sentence, and every localized treatment heading, absent from `text`. */
function expectNoTreatmentContent(text: string, label: string): void {
  for (const sentence of ALL_TREATMENT_SENTENCES) {
    expect(text, `${label}: treatment sentence "${sentence}"`).not.toContain(sentence);
  }
  for (const heading of TREATMENT_HEADINGS) {
    expect(text, `${label}: treatment heading "${heading}"`).not.toContain(heading);
  }
}

/* ========================================================================== */
/* Property 12                                                                 */
/* ========================================================================== */

describe('Property 12: a healthy classification carries no treatment content', () => {
  it('serves severity none, a healthy crop, and no treatment sentence from any knowledge base row', async () => {
    const exercised = new Set<RephraseKind>();

    await fc.assert(
      fc.asyncProperty(
        languageArb,
        channelArb,
        modelSeverityArb,
        confidenceArb,
        rephraseArb(TOMATO_HEALTHY),
        async (language, channel, severity, confidence, rephrase) => {
          exercised.add(rephrase.kind);
          const test = harness({
            condition: HEALTHY_CONDITION,
            severity,
            confidence,
            rephrase,
          });

          const outcome = await diagnose(
            { userId: FARMER, image: IMAGE_REF, language, channel },
            test.deps,
          );

          const label = `${rephrase.kind}/${language}/${channel}/model severity ${severity}`;
          const { result } = outcome;

          /* ── The result reports a healthy crop ──────────────────────────── */

          // A healthy plant is an `identified` result, not an inconclusive one (Requirement 3.4).
          expect(result.status, label).toBe('identified');
          if (result.status !== 'identified') return;

          expect(result.diseaseName, label).toBe(HEALTHY_CONDITION);
          expect(result.needsExpert, label).toBe(false);
          expect(result.language, label).toBe(language);

          // Requirement 3.4's severity, whatever the model claimed. This is the assertion the
          // generated `high` case exists for.
          expect(result.severity, label).toBe('none');

          /**
           * "Reports a healthy crop" as content rather than as a status: the canonical name appears
           * verbatim in Latin script on every exit (Requirements 4.6, 9.4 — kept, repaired, or led
           * with by the static template), and the grounded payload carries the row's own sentence
           * that no disease was detected.
           */
          expect(result.explanation, label).toContain(HEALTHY_CONDITION);
          expect(result.knowledge.causes, label).toStrictEqual(TOMATO_HEALTHY.causes);

          /* ── No treatment content, anywhere ─────────────────────────────── */

          /**
           * The structural half, and the failure the shared code path invites: `knowledgePayloadOf`
           * is the same projection the four disease rows go through, so an identified-branch step
           * that attached `treatment` regardless would show up here.
           */
          expect(result.knowledge.treatment, label).toStrictEqual([]);

          // …and the payload is otherwise populated, so the empty array above is a fact about
          // treatment rather than about an empty payload.
          expect(result.knowledge.symptoms, label).toStrictEqual(TOMATO_HEALTHY.symptoms);
          expect(result.knowledge.prevention, label).toStrictEqual(TOMATO_HEALTHY.prevention);
          expect(result.knowledge.source, label).toBe(TOMATO_HEALTHY.source);

          // The farmer-facing sentence, scanned against every treatment sentence in the base and
          // every localized treatment heading.
          expectNoTreatmentContent(result.explanation, `${label} explanation`);

          /**
           * Requirement 3.4 enforced by omission: with `treatment: []` the word never enters the
           * request at all — not as a label, not as a rule — so a healthy result carrying treatment
           * content is not something the model has to cooperate about. One call, no re-ask (D4).
           */
          expect(test.captured.textCalls, label).toHaveLength(1);
          const prompt = test.captured.textCalls[0]?.prompt ?? '';
          expectNoTreatmentContent(prompt, `${label} rephrase request`);
          expect(prompt.toLowerCase(), label).not.toContain('treatment');
          expect(prompt, label).toContain(HEALTHY_CONDITION);

          /* ── The persisted row says the same thing ──────────────────────── */

          expect(test.captured.inserted, label).toHaveLength(1);
          const row = test.captured.inserted[0];
          expect(row?.status, label).toBe('identified');
          expect(row?.diseaseName, label).toBe(HEALTHY_CONDITION);
          expect(row?.severity, label).toBe('none');
          expect(row?.knowledgeId, label).toBe(TOMATO_HEALTHY.id);
          // The stored explanation is the served one — nothing is stripped for display only, so a
          // later render of this row cannot recover treatment content the response omitted.
          expect(row?.explanation, label).toBe(result.explanation);
          expectNoTreatmentContent(row?.explanation ?? '', `${label} persisted explanation`);

          /* ── Which text the farmer got, per class ───────────────────────── */

          /**
           * Asserted so the classes stay distinguishable: a change that made every response fall
           * back to the static template would otherwise satisfy every assertion above while
           * silently discarding the model's prose on the healthy path.
           *
           * The discriminator is the template's **localized heading**, not a leading canonical name:
           * check 2's repair also prefixes the name, so `${HEALTHY_CONDITION}\n` cannot tell a
           * repaired model answer from the template. Only `staticExplanationFor()` emits a heading
           * line, and the healthy row's `symptoms` array is non-empty, so it always emits this one.
           */
          const isStaticTemplate = result.explanation.includes(
            `${messages(language).ui.symptomsHeading}:`,
          );
          expect(isStaticTemplate, `${label}: fell back to the static template`).toBe(
            rephrase.expectStaticTemplate,
          );
        },
      ),
      { numRuns: 300 },
    );

    expect([...exercised].sort()).toStrictEqual([...REPHRASE_KINDS].sort());
  });

  /* ======================================================================== */
  /* The control: the same pipeline DOES carry treatment for a disease row     */
  /* ======================================================================== */

  it('carries the row’s treatment content for the four disease conditions, on the same code path', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<VerifiedCondition>(...DISEASE_CONDITIONS),
        languageArb,
        channelArb,
        modelSeverityArb,
        confidenceArb,
        async (condition, language, channel, severity, confidence) => {
          const entry = SEEDED[condition];
          const test = harness({
            condition,
            severity,
            confidence,
            // The empty response forces check 1's fallback, so the explanation is
            // `staticExplanationFor()` — the row rendered directly, which is where treatment
            // content is observable without asserting anything about a model's prose.
            rephrase: { kind: 'empty', text: '', expectStaticTemplate: true },
          });

          const outcome = await diagnose(
            { userId: FARMER, image: IMAGE_REF, language, channel },
            test.deps,
          );

          const label = `${condition}/${language}`;
          const { result } = outcome;
          expect(result.status, label).toBe('identified');
          if (result.status !== 'identified') return;

          // The severity is the model's here — `none` is pinned for the healthy row only.
          expect(result.severity, label).toBe(severity);

          // The payload carries this row's treatment array, non-empty and verbatim.
          expect(result.knowledge.treatment, label).toStrictEqual(entry.treatment);
          expect(result.knowledge.treatment.length, label).toBeGreaterThan(0);

          // The request supplied it, under the column's own label.
          const prompt = test.captured.textCalls[0]?.prompt ?? '';
          expect(prompt, label).toContain('treatment:');
          for (const sentence of entry.treatment) {
            expect(prompt, `${label}: ${sentence}`).toContain(sentence);
          }

          // And the fallback renders it under the localized heading, which is exactly what the
          // healthy property asserts is absent.
          expect(result.explanation, label).toContain(messages(language).ui.treatmentHeading);
          for (const sentence of entry.treatment) {
            expect(result.explanation, `${label}: ${sentence}`).toContain(sentence);
          }
        },
      ),
      { numRuns: 120 },
    );
  });
});
