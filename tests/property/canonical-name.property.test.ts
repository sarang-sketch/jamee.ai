import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner, TextCall } from '@/lib/ai/capabilities';
import { STORAGE_BUCKETS } from '@/lib/config/verified';
import { REPHRASE_REJECTED_REASON } from '@/lib/db/usage-log';
import { AppError } from '@/lib/errors';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import { REPHRASE_MAX_CHARS, staticExplanationFor } from '@/lib/prompts';
import {
  HEALTHY_CONDITION,
  SUPPORTED_LANGUAGES,
  VERIFIED_CONDITIONS,
  type Channel,
  type DiagnosisResult,
  type IdentifiedResult,
  type Language,
  type Severity,
  type VerifiedCondition,
} from '@/lib/schemas';
import type { StorageClientLike } from '@/lib/storage';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import { diagnose, type DiagnosisDeps, type DiagnosisStore } from '@/services/diagnosis.service';
import type { CounterRpc } from '@/services/quota.service';
import type { Database, DiagnosisRow, TablesInsert } from '@/types/database';

/**
 * ### Property 13: The canonical disease name is language-invariant
 *
 * *"For any verified condition and any supported language, the canonical disease name appears
 * verbatim in its Latin-script canonical form in the farmer-facing output, unchanged across all
 * three languages."*
 *
 * **Validates: Requirements 4.6, 9.4**
 *
 * =============================================================================
 * INVARIANCE IS A CLAIM ABOUT A SET OF RUNS, SO EACH CASE IS THREE RUNS
 * =============================================================================
 *
 * "Unchanged across all three languages" cannot be observed one language at a time: a service that
 * returned `Tomato Late Blight` for `en` and `टोमॅटो लेट ब्लाइट` for `mr` satisfies every
 * single-language assertion anyone could write. So each generated case runs `diagnose()` **three
 * times** over one row — once per supported language, with a provider that answers in that language
 * — and the assertions are made over the triple:
 *
 *  - the canonical name is one string across the three, and it is the Latin-script canonical form;
 *  - **the rendered explanation is a different string in each of the three.**
 *
 * The second half is what keeps the first from being trivially true. A pipeline that ignored the
 * language and returned one English answer three times would satisfy invariance perfectly and be
 * badly wrong; asserting that the surface *does* change is what separates "the identifier is stable"
 * from "nothing is localized". Both paths through step 8 carry that: a kept rephrase is the model's
 * localized prose, and the fallback template carries the message catalogs' localized headings.
 *
 * =============================================================================
 * THE ADVERSARIAL PART IS THE PROVIDER, NOT THE LANGUAGE
 * =============================================================================
 *
 * Requirement 4.6 is interesting precisely when the model does not cooperate, so three of the seven
 * generated provider behaviours withhold the Latin name in a different way — dropped, written in
 * Devanagari, or lowercased — and one more each trips the two check-1 limits and the chain failure.
 * The name still has to arrive verbatim, because `validateRephrased()` repairs it deterministically
 * (check 2, no second model call) and `staticExplanationFor()` leads with it. Every one of those
 * classes is asserted to have been generated at the end of the run.
 *
 * Note that check 2 is **case-sensitive** by design — "unchanged" means unchanged — so a lowercased
 * copy counts as missing and is repaired. That is asserted rather than assumed, because it is the
 * one class where a reader might expect the model's own spelling to be kept.
 *
 * =============================================================================
 * NO PROVIDER, NO DATABASE
 * =============================================================================
 *
 * Every seam of `diagnose()` is injected: storage, the counter RPC, the conversation store, the
 * knowledge reader, the persistence store and the capability runner. The request client itself is a
 * proxy that throws on any read, so a service reaching past its dependencies fails loudly instead of
 * quietly making the fixtures irrelevant.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const CROP_IMAGES = STORAGE_BUCKETS.cropImages;

const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const DIAGNOSIS_ID = '55555555-5555-4555-8555-555555555555';

const NOW_MS = Date.parse('2026-09-15T19:30:00.000Z');

/** Devanagari, the script `hi` and `mr` are written in. */
const DEVANAGARI = /[\u0900-\u097F]/;

/** The Latin-script canonical form: letters and spaces, nothing else. */
const LATIN_CANONICAL = /^[A-Za-z][A-Za-z ]*[A-Za-z]$/;

const KB_FIELDS = ['symptoms', 'causes', 'treatment', 'prevention'] as const;
type KbField = (typeof KB_FIELDS)[number];

/** Clause tails, free of any verified condition name so only the name assertions can see one. */
const TAILS: string[] = [
  'dark rings on the older leaves',
  'a yellow halo around each spot',
  'affected leaves dry and drop from the bottom upward',
  'warm humid weather with long leaf wetness',
  'remove and destroy the affected lower leaves',
  'water at the base and keep the foliage dry',
];

/**
 * A lead-in per language, so a kept rephrase is visibly *not* the same string in the three runs.
 *
 * The three are mutually distinct on purpose: Hindi and Marathi share Devanagari, so a fixture that
 * used one Devanagari sentence for both would make the surface-varies assertion pass for `en` and
 * fail to say anything about `hi` against `mr`.
 */
const LOCALIZED_LEAD: Record<Language, string> = {
  en: 'Look closely at the lower leaves.',
  hi: 'नीचे की पत्तियों को ध्यान से देखें।',
  mr: 'खालच्या पानांकडे बारकाईने पहा।',
};

/**
 * What a model writes when it transliterates the name instead of preserving it — the failure
 * Requirements 4.6 and 9.4 exist to rule out.
 *
 * `Record<VerifiedCondition, string>` is exhaustive, so a sixth verified condition breaks this
 * object until it has a fixture rather than silently going untested.
 */
const TRANSLITERATED_NAME: Record<VerifiedCondition, string> = {
  'Tomato Early Blight': 'टोमॅटो अर्ली ब्लाइट',
  'Tomato Late Blight': 'टोमॅटो लेट ब्लाइट',
  'Tomato Healthy': 'टोमॅटो निरोगी',
  'Potato Early Blight': 'बटाटा अर्ली ब्लाइट',
  'Potato Late Blight': 'बटाटा लेट ब्लाइट',
};

/**
 * `disease_knowledge.crop`, which the database constrains to two values. Exhaustive for the same
 * reason `TRANSLITERATED_NAME` is.
 */
const CROP_OF: Record<VerifiedCondition, KnowledgeEntry['crop']> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

/* ========================================================================== */
/* Row construction                                                            */
/* ========================================================================== */

function tagFor(seed: number, index: number): string {
  return `KB${(seed + index).toString(16).toUpperCase()}`;
}

type Tails = Record<KbField, readonly string[]>;

function statementsFor(tag: string, field: KbField, tails: readonly string[]): string[] {
  return tails.map((tail, index) => `${tag}-${field}-${index} ${tail}`);
}

function rowFor(condition: VerifiedCondition, tag: string, tails: Tails): KnowledgeEntry {
  const healthy = condition === HEALTHY_CONDITION;
  return {
    id: `00000000-0000-4000-8000-${tag.slice(2).padStart(12, '0')}`,
    disease_name: condition,
    crop: CROP_OF[condition],
    scientific_name: healthy ? null : `${tag} pathogen`,
    symptoms: statementsFor(tag, 'symptoms', tails.symptoms),
    causes: statementsFor(tag, 'causes', tails.causes),
    // Empty for the healthy row, as the `healthy_has_no_treatment` check constraint requires.
    treatment: healthy ? [] : statementsFor(tag, 'treatment', tails.treatment),
    prevention: statementsFor(tag, 'prevention', tails.prevention),
    default_severity: healthy ? 'none' : 'moderate',
    source: `${tag} extension bulletin`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function statementsOf(entry: KnowledgeEntry): readonly string[] {
  return KB_FIELDS.flatMap((field) => entry[field]);
}

function nonEmptyFieldsOf(entry: KnowledgeEntry): readonly KbField[] {
  return KB_FIELDS.filter((field) => entry[field].length > 0);
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const farmerIdArb = fc.uuid();
const channelArb = fc.constantFrom<Channel>('web', 'whatsapp');
const severityArb = fc.constantFrom<Severity>('low', 'moderate', 'high');
const confidenceArb = fc.integer({ min: 7001, max: 9999 }).map((raw) => raw / 10_000);

const tailsArb = fc.subarray([...TAILS], { minLength: 1, maxLength: 2 });

const tailsRecordArb: fc.Arbitrary<Tails> = fc.record({
  symptoms: tailsArb,
  causes: tailsArb,
  treatment: tailsArb,
  prevention: tailsArb,
});

const seedArb = fc.integer({ min: 0x1000, max: 0xfff0 });

/**
 * How the rephrase provider treats the canonical name. Enumerated so the run can assert it reached
 * every one — a class that never generated would leave a mis-stated expectation green.
 */
const NAME_KINDS = [
  /** Written exactly as supplied, inside localized prose. Kept as-is. */
  'latin_name_present',
  /** Left out entirely. Check 2 prefixes it back on. */
  'name_omitted',
  /** Written in Devanagari instead — the failure 4.6 and 9.4 name. Repaired. */
  'name_transliterated',
  /** Present but lowercased. Check 2 is case-sensitive, so this is missing, and repaired. */
  'name_lowercased',
  /** Nothing came back — check 1. The row's template leads with the name. */
  'empty',
  /** Past `REPHRASE_MAX_CHARS` — check 1. Same template. */
  'too_long',
  /** The text chain is exhausted. Same template. */
  'provider_failed',
] as const;

type NameKind = (typeof NAME_KINDS)[number];

/** Classes where the model's own text withholds the Latin canonical form. */
const REPAIRED_KINDS: readonly NameKind[] = [
  'name_omitted',
  'name_transliterated',
  'name_lowercased',
];

/** Classes where check 1 or the chain sends the farmer to the row's own template. */
const TEMPLATE_KINDS: readonly NameKind[] = ['empty', 'too_long', 'provider_failed'];

type ExplanationSource = 'model_prose' | 'row_template';

function sourceOf(kind: NameKind): ExplanationSource {
  return TEMPLATE_KINDS.includes(kind) ? 'row_template' : 'model_prose';
}

interface Scenario {
  readonly kind: NameKind;
  readonly condition: VerifiedCondition;
  readonly seed: number;
  readonly tails: Tails;
  readonly confidence: number;
  readonly severity: Severity;
  readonly channel: Channel;
  readonly caller: string;
  readonly objectId: string;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  kind: fc.constantFrom<NameKind>(...NAME_KINDS),
  condition: fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS),
  seed: seedArb,
  tails: tailsRecordArb,
  confidence: confidenceArb,
  severity: severityArb,
  channel: channelArb,
  caller: farmerIdArb,
  objectId: fc.uuid(),
});

/* ========================================================================== */
/* The prose a provider returns, per language                                  */
/* ========================================================================== */

function bodyOf(entry: KnowledgeEntry): string {
  return statementsOf(entry)
    .map((statement) => `${statement}.`)
    .join(' ');
}

function overlongProse(entry: KnowledgeEntry, language: Language): string {
  const parts: string[] = [LOCALIZED_LEAD[language], entry.disease_name];
  while (parts.join(' ').length <= REPHRASE_MAX_CHARS) parts.push(bodyOf(entry));
  return parts.join(' ');
}

/**
 * The text seam's behaviour for one language: a string, or the exhausted chain.
 *
 * Every returned string opens with `LOCALIZED_LEAD[language]`, which is what makes the three runs of
 * a case genuinely three different surfaces rather than one string asserted three times.
 */
function providerBehaviour(
  kind: NameKind,
  entry: KnowledgeEntry,
  language: Language,
): { readonly text: string } | { readonly fail: true } {
  const lead = LOCALIZED_LEAD[language];
  const body = bodyOf(entry);

  switch (kind) {
    case 'latin_name_present':
      return { text: `${lead} ${entry.disease_name}. ${body}` };
    case 'name_omitted':
      return { text: `${lead} ${body}` };
    case 'name_transliterated':
      return { text: `${lead} ${TRANSLITERATED_NAME[entry.disease_name]}. ${body}` };
    case 'name_lowercased':
      return { text: `${lead} ${entry.disease_name.toLowerCase()}. ${body}` };
    case 'empty':
      return { text: ' \n\t ' };
    case 'too_long':
      return { text: overlongProse(entry, language) };
    case 'provider_failed':
      return { fail: true };
  }
}

/* ========================================================================== */
/* The harness — every seam injected                                           */
/* ========================================================================== */

interface Recorded {
  /** What the text seam was handed, and what it answered. */
  readonly requests: string[];
  readonly diagnosisRows: TablesInsert<'diagnoses'>[];
  readonly usageRows: TablesInsert<'usage_logs'>[];
}

const unreachableSupabase = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `the request client was used (read of "${String(property)}"); every seam must be injected`,
      );
    },
  },
) as unknown as SupabaseClient<Database>;

interface Harness {
  readonly deps: DiagnosisDeps;
  readonly recorded: Recorded;
}

function harness(options: {
  readonly rows: readonly KnowledgeEntry[];
  readonly condition: VerifiedCondition;
  readonly confidence: number;
  readonly severity: Severity;
  readonly behaviour: { readonly text: string } | { readonly fail: true };
}): Harness {
  const recorded: Recorded = { requests: [], diagnosisRows: [], usageRows: [] };

  const storage: StorageClientLike = {
    storage: {
      from: () => ({
        exists: () => Promise.resolve({ data: true, error: null }),
        createSignedUrl: (path: string) =>
          Promise.resolve({
            data: { signedUrl: `https://storage.test/${path}?token=abc` },
            error: null,
          }),
      }),
    },
  };

  const rpc: CounterRpc = {
    tryIncrement: () => Promise.resolve(1),
    decrement: () => Promise.resolve(0),
    used: () => Promise.resolve(0),
  };

  const models: CapabilityRunner = {
    classify: () =>
      Promise.resolve({
        value: JSON.stringify({
          status: 'identified',
          disease_name: options.condition,
          confidence: options.confidence,
          severity: options.severity,
        }),
        provider: 'gemini' as const,
        usedFallback: false,
      }),
    generate: (call: TextCall) => {
      recorded.requests.push(call.prompt);
      if ('fail' in options.behaviour) {
        return Promise.reject(
          new AppError('PROVIDERS_UNAVAILABLE', { context: { reason: 'test_chain_exhausted' } }),
        );
      }
      return Promise.resolve({
        value: options.behaviour.text,
        provider: 'gemini' as const,
        usedFallback: false,
      });
    },
  };

  const store: DiagnosisStore = {
    insertDiagnosis: (row: TablesInsert<'diagnoses'>) => {
      recorded.diagnosisRows.push(row);
      const stored: DiagnosisRow = {
        id: DIAGNOSIS_ID,
        user_id: row.user_id,
        conversation_id: row.conversation_id,
        status: row.status,
        disease_name: row.disease_name ?? null,
        knowledge_id: row.knowledge_id ?? null,
        confidence: row.confidence ?? null,
        severity: row.severity,
        explanation: row.explanation,
        language: row.language,
        needs_expert: row.needs_expert ?? false,
        channel: row.channel,
        image_bucket: row.image_bucket,
        image_path: row.image_path,
        full_image_deleted_at: null,
        model_provider: row.model_provider,
        created_at: '2026-09-16T01:00:00.000Z',
      };
      return Promise.resolve(stored);
    },
    insertUsageLog: (row: TablesInsert<'usage_logs'>) => {
      recorded.usageRows.push(row);
      return Promise.resolve();
    },
    ownsConversation: () => Promise.resolve(true),
  };

  const conversations: ConversationStore = {
    mostRecent: (userId: string, channel: Conversation['channel']) =>
      Promise.resolve(conversationFor(userId, channel)),
    create: (userId: string, channel: Conversation['channel']) =>
      Promise.resolve(conversationFor(userId, channel)),
  };

  const knowledge: KnowledgeReader = (names) =>
    Promise.resolve(options.rows.filter((row) => names.includes(row.disease_name)));

  return {
    recorded,
    deps: {
      supabase: unreachableSupabase,
      storage,
      store,
      conversations,
      knowledge,
      models,
      quota: { rpc, now: new Date(NOW_MS) },
      now: () => NOW_MS,
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

function identifiedOf(result: DiagnosisResult): IdentifiedResult {
  if (result.status !== 'identified') {
    throw new Error(`Property 13 needs an identified result; got "${result.status}"`);
  }
  return result;
}

/* ========================================================================== */
/* Property 13                                                                 */
/* ========================================================================== */

describe('Property 13: the canonical disease name is language-invariant', () => {
  it('carries one Latin-script canonical name through all three languages while the rendered text changes', async () => {
    const kindsSeen = new Set<NameKind>();
    const conditionsSeen = new Set<VerifiedCondition>();
    const languagesSeen = new Set<Language>();
    const sourcesSeen = new Set<ExplanationSource>();
    /** Whether a run needed check 2's repair — both answers must occur. */
    const repairsSeen = new Set<boolean>();

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { condition, kind, caller, channel, confidence, severity } = scenario;

        kindsSeen.add(kind);
        conditionsSeen.add(condition);
        sourcesSeen.add(sourceOf(kind));
        repairsSeen.add(REPAIRED_KINDS.includes(kind));

        const rows = VERIFIED_CONDITIONS.map((name, index) =>
          rowFor(name, tagFor(scenario.seed, index), scenario.tails),
        );
        const entry = rows[VERIFIED_CONDITIONS.indexOf(condition)];
        if (entry === undefined) throw new Error(`no generated row for "${condition}"`);

        // The canonical form itself, before anything is asked of the pipeline: Latin letters and
        // spaces, no Devanagari. Everything below is "unchanged from this".
        expect(condition).toMatch(LATIN_CANONICAL);
        expect(DEVANAGARI.test(condition)).toBe(false);

        /* ------------------------------------------------------------------ */
        /* One run per supported language, over the same row                   */
        /* ------------------------------------------------------------------ */

        const runs = await Promise.all(
          SUPPORTED_LANGUAGES.map(async (language) => {
            languagesSeen.add(language);
            const behaviour = providerBehaviour(kind, entry, language);
            const test = harness({ rows, condition, confidence, severity, behaviour });

            const outcome = await diagnose(
              {
                userId: caller,
                storageRef: {
                  bucket: CROP_IMAGES,
                  path: `${caller}/2026/09/${scenario.objectId}.jpg`,
                },
                language,
                channel,
              },
              test.deps,
            );

            return { language, behaviour, outcome, recorded: test.recorded } as const;
          }),
        );

        /* ------------------------------------------------------------------ */
        /* Per-language: the name is there, verbatim, in Latin script          */
        /* ------------------------------------------------------------------ */

        for (const run of runs) {
          const label = `${kind} / ${condition} / ${run.language}`;
          const result = identifiedOf(run.outcome.result);

          // The structured name, and the language the answer claims to be in.
          expect(result.diseaseName, label).toBe(condition);
          expect(result.language, label).toBe(run.language);

          // Requirements 4.6 and 9.4 — the name a farmer reads is the canonical form, byte for
          // byte. `includes` is case-sensitive, which is what "unchanged" has to mean.
          expect(result.explanation, label).toContain(condition);

          // The persisted row carries the same identifier, so history and the detail screen agree
          // with the answer that was returned.
          const persisted = run.recorded.diagnosisRows[0];
          if (persisted === undefined) throw new Error('no diagnosis row was persisted');
          expect(persisted.disease_name, label).toBe(condition);
          expect(persisted.language, label).toBe(run.language);

          const audit = run.recorded.usageRows[0];
          if (audit === undefined) throw new Error('no audit row was appended');

          if (sourceOf(kind) === 'row_template') {
            // The row's own template. It leads with the canonical name in Latin script, so 4.6
            // holds on the degraded path by construction rather than by the model's cooperation.
            expect(result.explanation.split('\n')[0], label).toBe(condition);
            expect(result.explanation, label).toBe(staticExplanationFor(entry, run.language));
            expect(audit.outcome, label).toBe(
              kind === 'provider_failed' ? 'provider_error' : 'validation_rejected',
            );
            expect(audit.rejection_reason, label).toBe(
              kind === 'provider_failed' ? null : REPHRASE_REJECTED_REASON,
            );

            // Localized: this language's own heading for a column the row has content for.
            const { ui } = messages(run.language);
            const headings: Record<KbField, string> = {
              symptoms: ui.symptomsHeading,
              causes: ui.causesHeading,
              treatment: ui.treatmentHeading,
              prevention: ui.preventionHeading,
            };
            for (const field of nonEmptyFieldsOf(entry)) {
              expect(result.explanation, label).toContain(`${headings[field]}:`);
            }
          } else {
            // The model's prose was kept, and the run's own lead-in proves it is this language's.
            expect(audit.outcome, label).toBe('success');
            expect(audit.rejection_reason, label).toBeNull();
            expect(result.explanation, label).toContain(LOCALIZED_LEAD[run.language]);

            if ('fail' in run.behaviour) throw new Error('a kept path cannot have failed');

            if (REPAIRED_KINDS.includes(kind)) {
              // The model withheld the Latin canonical form; check 2 put it back, deterministically
              // and with no second model call, in front of the prose it repaired.
              expect(run.behaviour.text.includes(condition), label).toBe(false);
              expect(result.explanation.startsWith(`${condition}\n`), label).toBe(true);
            } else {
              // The model wrote it correctly, so nothing was prefixed and the prose is untouched.
              expect(run.behaviour.text.includes(condition), label).toBe(true);
              expect(result.explanation, label).toBe(run.behaviour.text.trim());
            }
          }
        }

        /* ------------------------------------------------------------------ */
        /* Across the three: the name is invariant, the surface is not         */
        /* ------------------------------------------------------------------ */

        const names = runs.map((run) => identifiedOf(run.outcome.result).diseaseName);
        expect(new Set(names).size, `${kind} / ${condition}: canonical name varied by language`).toBe(
          1,
        );
        expect(names, `${kind} / ${condition}`).toStrictEqual([condition, condition, condition]);

        const persistedNames = runs.map((run) => run.recorded.diagnosisRows[0]?.disease_name);
        expect(new Set(persistedNames).size, `${kind} / ${condition}`).toBe(1);

        // And the localization is real: three languages, three different renderings. Without this
        // the invariance above would also be satisfied by a pipeline that never localized anything.
        const explanations = runs.map((run) => identifiedOf(run.outcome.result).explanation);
        expect(
          new Set(explanations).size,
          `${kind} / ${condition}: the rendered text did not change with the language`,
        ).toBe(3);
      }),
      // 350 runs over seven provider behaviours and five conditions, each run covering all three
      // languages, so every cell is reached repeatedly.
      { numRuns: 350 },
    );

    /* ---------------------------------------------------------------------- */
    /* Non-vacuity                                                            */
    /* ---------------------------------------------------------------------- */

    expect([...kindsSeen].sort()).toStrictEqual([...NAME_KINDS].sort());
    expect([...conditionsSeen].sort()).toStrictEqual([...VERIFIED_CONDITIONS].sort());
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
    // Both the kept-prose path and the row-template path were exercised, so the property is not
    // resting on one of them alone.
    expect([...sourcesSeen].sort()).toStrictEqual(['model_prose', 'row_template']);
    // And check 2's repair both fired and did not: a run that only ever repaired would say nothing
    // about a name the model wrote correctly, and the reverse.
    expect([...repairsSeen].sort()).toStrictEqual([false, true]);
  });
});
