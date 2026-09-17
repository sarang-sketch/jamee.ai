import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner, TextCall } from '@/lib/ai/capabilities';
import { STORAGE_BUCKETS } from '@/lib/config/verified';
import { REPHRASE_REJECTED_REASON } from '@/lib/db/usage-log';
import { AppError } from '@/lib/errors';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import {
  REPHRASE_MAX_CHARS,
  outOfScopeConditionsIn,
  staticExplanationFor,
} from '@/lib/prompts';
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
 * ### Property 10: Identified results are grounded only in the matching knowledge base entry
 *
 * *"For any verified condition and any supported language, an identified diagnosis reports exactly
 * one condition, its explanation is generated from a request that contained only that condition's
 * knowledge base row together with a rephrase-only instruction, and the explanation introduces no
 * other verified condition name and no agricultural term absent from that row."*
 *
 * **Validates: Requirements 3.2, 3.5, 4.3, 4.5**
 *
 * =============================================================================
 * WHERE THE PROPERTY IS OBSERVED
 * =============================================================================
 *
 * Step 8 of `diagnose()` — `lookupCondition()`, then `rephrasePrompt()`, then
 * `validateRephrased()`, with `staticExplanationFor()` behind them. The whole step is exercised
 * through `diagnose()` with every seam injected, so there is no Supabase stack and no provider, and
 * the two things the property is *about* are directly observable: the exact string handed to the
 * text-generation seam, and the exact result handed back to the caller.
 *
 * The knowledge reader is stocked with **all five** rows, not just the one under test. A grounding
 * step that read more than it needed, or that mixed a second row into the request, would therefore
 * have material available to leak — and the assertions below would see it. A reader holding one row
 * would have made "only that condition's row" true by fixture rather than by code.
 *
 * =============================================================================
 * HOW "ONLY THAT ROW" AND "NO TERM ABSENT FROM THAT ROW" ARE ASSERTED
 * =============================================================================
 *
 * Every generated row is built from **tagged statements**: each array item begins with a token that
 * names its row, its column and its index (`KB1A2B-symptoms-0 dark rings on the older leaves`). The
 * five rows of a run get five distinct tags. That turns both halves of the property into containment
 * assertions rather than existence ones:
 *
 *  - **The request.** The block under `VERIFIED CONTENT` is decomposed back into label lines and
 *    item lines. The item lines must equal this row's four arrays concatenated in column order,
 *    string for string; the label lines must be the canonical name plus one label per non-empty
 *    column; and no line may be anything else. A request carrying a second row, a reordered array,
 *    a re-punctuated sentence, or a stray severity would fail one of those three.
 *  - **The answer.** Every tagged statement found in the farmer's explanation must be one of *this*
 *    row's items, and must appear verbatim rather than merely by its token. A decoy row's tag
 *    anywhere in either the request or the answer fails the run.
 *
 * The structured half of the answer is checked against the row **field by field** rather than
 * against `knowledgePayloadOf()`: comparing the projection with itself would pass for any
 * projection, including one that dropped a column.
 *
 * =============================================================================
 * THE THIRD CLAUSE'S BOUNDARY, STATED RATHER THAN QUIETLY NARROWED
 * =============================================================================
 *
 * "No agricultural term absent from that row" is enforced **structurally, on the request side**, and
 * the design says so in the same section it states the property: *"Checks 2–4 are heuristics over
 * presentation; the substantive guarantee is structural — the model only ever receives
 * knowledge-base content to work from, so there is no unverified fact available for it to leak."*
 *
 * So the clause is asserted where it is decidable — the request contains this row and nothing else,
 * and the structured payload a farmer acts on is the row verbatim — and the `invents_agronomy` class
 * below exists to *show* that boundary rather than to hide it: a provider that fabricates a
 * non-condition statement anyway has its prose kept, because no code can tell an invented agronomic
 * sentence from a rephrased one. What that class asserts is the part that is Jamee's to guarantee:
 * the fabricated token was never in the request, and the row's own content reaches the farmer
 * unaltered. A fabricated *condition name* is a different matter — it is detectable, `outOfScope`
 * catches it, and the `names_other_condition` class asserts the farmer gets the row's own template
 * instead.
 *
 * =============================================================================
 * REQUIREMENT 3.5 — "EXACTLY ONE"
 * =============================================================================
 *
 * Read as a claim about the result rather than about the photo, because the photo never reaches this
 * test: one `diseaseName`, one knowledge row requested (`[condition]`, nothing else), one
 * `knowledge_id` persisted, one grounding call, and exactly one verified condition name present in
 * everything the farmer reads. A pipeline that reported a primary and a secondary condition would
 * fail the last of those even if the first four held.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const CROP_IMAGES = STORAGE_BUCKETS.cropImages;

const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const DIAGNOSIS_ID = '55555555-5555-4555-8555-555555555555';

/** 2026-09-15T19:30:00Z. Fixed so the run owns its clock and never reads the wall clock. */
const NOW_MS = Date.parse('2026-09-15T19:30:00.000Z');

/** The four agronomic columns, in the order a farmer needs them and the prompt renders them. */
const KB_FIELDS = ['symptoms', 'causes', 'treatment', 'prevention'] as const;
type KbField = (typeof KB_FIELDS)[number];

/**
 * Clause tails for the generated statements.
 *
 * Realistic agronomy, and deliberately free of three things: any verified condition name (which
 * would make the deny-list scan fire on the row's own content), any severity word (`yellow` already
 * contains `low`, which is why severity is not scanned for at all below), and any digit (so the
 * generated confidence value can be searched for in the request without a false positive).
 */
const TAILS: string[] = [
  'dark rings on the older leaves',
  'a yellow halo around each spot',
  'affected leaves dry and drop from the bottom upward',
  'warm humid weather with long leaf wetness',
  'spores surviving on crop debris in the field',
  'remove and destroy the affected lower leaves',
  'water at the base and keep the foliage dry',
  'rotate away from solanaceous crops for two seasons',
];

/** Every tagged statement, whichever row it came from. */
const TAGGED_STATEMENT = /KB[0-9A-F]{4}-(?:symptoms|causes|treatment|prevention)-\d+/g;

/**
 * `disease_knowledge.crop`, which the database constrains to two values.
 *
 * A `Record<VerifiedCondition, …>` rather than the first word of the name: exhaustive, so a sixth
 * verified condition breaks this fixture until it has a crop instead of silently generating a row
 * the `crop` check constraint would reject.
 */
const CROP_OF: Record<VerifiedCondition, KnowledgeEntry['crop']> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

const CONTENT_HEADER = 'VERIFIED CONTENT (the only facts you may use):';
const RULES_HEADER = 'Rules:';

/**
 * The rephrase-only instruction, in the design's own words (design: *2. Knowledge-base
 * rephrasing*). Requirement 4.5 asks for two things in one request — the content, and the
 * instruction to rephrase only it — so the second is asserted as literally as the first.
 */
const REPHRASE_ONLY_INSTRUCTION = [
  'Use ONLY the facts above. Add no disease, symptom, cause, chemical, dose,',
  '  brand, or timing that is not written above.',
].join('\n');

/* ========================================================================== */
/* Row construction                                                            */
/* ========================================================================== */

/** `KB1A2B` — one tag per row, distinct across the five rows of a run. */
function tagFor(seed: number, index: number): string {
  return `KB${(seed + index).toString(16).toUpperCase()}`;
}

function statementsFor(tag: string, field: KbField, tails: readonly string[]): string[] {
  return tails.map((tail, index) => `${tag}-${field}-${index} ${tail}`);
}

type Tails = Record<KbField, readonly string[]>;

function rowFor(condition: VerifiedCondition, tag: string, tails: Tails): KnowledgeEntry {
  const healthy = condition === HEALTHY_CONDITION;
  return {
    id: `00000000-0000-4000-8000-${tag.slice(2).padStart(12, '0')}`,
    disease_name: condition,
    crop: CROP_OF[condition],
    scientific_name: healthy ? null : `${tag} pathogen`,
    symptoms: statementsFor(tag, 'symptoms', tails.symptoms),
    causes: statementsFor(tag, 'causes', tails.causes),
    // Requirement 3.4 and the `healthy_has_no_treatment` check constraint: the healthy row's
    // treatment array is empty. Generated that way so the column-omission path in the prompt is
    // exercised by a row shape the database actually admits. What the empty array *means* for a
    // farmer is Property 12's claim, not this one; nothing here asserts it.
    treatment: healthy ? [] : statementsFor(tag, 'treatment', tails.treatment),
    prevention: statementsFor(tag, 'prevention', tails.prevention),
    default_severity: healthy ? 'none' : 'moderate',
    source: `${tag} extension bulletin`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/** The row's four arrays concatenated in column order — the whole of what it may contribute. */
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
const languageArb = fc.constantFrom<Language>(...SUPPORTED_LANGUAGES);
const channelArb = fc.constantFrom<Channel>('web', 'whatsapp');
const severityArb = fc.constantFrom<Severity>('low', 'moderate', 'high');

/**
 * Four decimal places, never ending in zero, so `String(confidence)` is a distinctive digit run
 * that can be searched for in the request. `0.8237` appears in no prompt Jamee composes; `0.7`
 * would be a weaker probe because a shortened decimal is easier to collide with.
 */
const confidenceArb = fc
  .integer({ min: 7001, max: 9999 })
  .filter((raw) => raw % 10 !== 0)
  .map((raw) => raw / 10_000);

/** One to two statements per column: enough for order and containment, short enough to stay terse. */
const tailsArb = fc.subarray([...TAILS], { minLength: 1, maxLength: 2 });

const tailsRecordArb: fc.Arbitrary<Tails> = fc.record({
  symptoms: tailsArb,
  causes: tailsArb,
  treatment: tailsArb,
  prevention: tailsArb,
});

/**
 * `seed + 4` stays inside four hex digits, so all five tags of a run are four uppercase hex
 * characters and all five are distinct.
 */
const seedArb = fc.integer({ min: 0x1000, max: 0xfff0 });

/* -------------------------------------------------------------------------- */
/* What the rephrase provider does                                             */
/* -------------------------------------------------------------------------- */

/**
 * The provider behaviours, enumerated so the run can prove it exercised every one.
 *
 * A property over a `oneof` can pass while a branch never generates, and a mis-stated expectation
 * for that branch is then green rather than absent. The predicate records the kind it saw and the
 * coverage assertion after the run turns "these were covered" into a claim.
 */
const MODEL_KINDS = [
  /** Prose built from this row's statements, with the canonical name. Kept. */
  'faithful',
  /** The same prose with the name dropped — check 2 prefixes it back on. Kept. */
  'omits_canonical_name',
  /** The same prose naming a second verified condition — check 3 refuses it. Template. */
  'names_other_condition',
  /** Nothing, or nothing but whitespace — check 1. Template. */
  'empty',
  /** Past `REPHRASE_MAX_CHARS` — check 1. Template. */
  'too_long',
  /** A fabricated non-condition statement. Kept — see the header's boundary note. */
  'invents_agronomy',
  /** The text chain is exhausted. Template, and audited as a provider error. */
  'provider_failed',
] as const;

type ModelKind = (typeof MODEL_KINDS)[number];

const modelKindArb = fc.constantFrom<ModelKind>(...MODEL_KINDS);

/** `INV1A2B-0` — a token shape that appears in no row, so its provenance is unambiguous. */
const inventionTagArb = fc
  .integer({ min: 0x1000, max: 0xffff })
  .map((raw) => `INV${raw.toString(16).toUpperCase()}`);

interface Scenario {
  readonly kind: ModelKind;
  readonly condition: VerifiedCondition;
  readonly seed: number;
  readonly tails: Tails;
  readonly confidence: number;
  readonly severity: Severity;
  readonly language: Language;
  readonly channel: Channel;
  readonly caller: string;
  readonly objectId: string;
  /** Which other verified condition the `names_other_condition` class drags in. */
  readonly otherOffset: number;
  readonly inventionTag: string;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  kind: modelKindArb,
  condition: fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS),
  seed: seedArb,
  tails: tailsRecordArb,
  confidence: confidenceArb,
  severity: severityArb,
  language: languageArb,
  channel: channelArb,
  caller: farmerIdArb,
  objectId: fc.uuid(),
  otherOffset: fc.integer({ min: 1, max: VERIFIED_CONDITIONS.length - 1 }),
  inventionTag: inventionTagArb,
});

/* ========================================================================== */
/* The prose a provider returns                                                */
/* ========================================================================== */

/**
 * Prose assembled from the row the test already holds — never from the prompt.
 *
 * Reading the prompt to build the answer would make containment circular: any request would produce
 * a "grounded" answer. Building from `entry` means the answer is grounded because the *test* knows
 * the row, and the request is checked separately.
 */
function faithfulProse(entry: KnowledgeEntry, withName: boolean): string {
  const sentences = statementsOf(entry).map((statement) => `${statement}.`);
  return (withName ? [entry.disease_name, ...sentences] : sentences).join(' ');
}

function overlongProse(entry: KnowledgeEntry): string {
  const sentences = statementsOf(entry).map((statement) => `${statement}.`);
  const parts: string[] = [entry.disease_name];
  while (parts.join(' ').length <= REPHRASE_MAX_CHARS) parts.push(...sentences);
  return parts.join(' ');
}

/** What the text seam does for this scenario: a string to return, or a chain failure to raise. */
function providerBehaviour(
  scenario: Scenario,
  entry: KnowledgeEntry,
  other: VerifiedCondition,
): { readonly text: string } | { readonly fail: true } {
  switch (scenario.kind) {
    case 'faithful':
      return { text: faithfulProse(entry, true) };
    case 'omits_canonical_name':
      return { text: faithfulProse(entry, false) };
    case 'names_other_condition':
      return { text: `${faithfulProse(entry, true)} Compare with ${other}.` };
    case 'empty':
      return { text: '  \n\t ' };
    case 'too_long':
      return { text: overlongProse(entry) };
    case 'invents_agronomy':
      return {
        text: `${faithfulProse(entry, true)} ${scenario.inventionTag}-0 spray a copper fungicide at the first sign.`,
      };
    case 'provider_failed':
      return { fail: true };
  }
}

/** Which branch of step 8 the result came from, read off the audit row rather than guessed. */
type ExpectedPath = 'model_prose' | 'row_template';

function expectedPathOf(kind: ModelKind): ExpectedPath {
  return kind === 'faithful' || kind === 'omits_canonical_name' || kind === 'invents_agronomy'
    ? 'model_prose'
    : 'row_template';
}

/* ========================================================================== */
/* The harness — every seam injected, the request captured                     */
/* ========================================================================== */

interface Recorded {
  /** Every prompt the text seam was handed, in order. Exactly one, on every path that reaches it. */
  readonly rephraseRequests: string[];
  /** Every name set the knowledge reader was asked for. */
  readonly knowledgeReads: VerifiedCondition[][];
  readonly diagnosisRows: TablesInsert<'diagnoses'>[];
  readonly usageRows: TablesInsert<'usage_logs'>[];
  counts: { classify: number; generate: number };
}

/**
 * A tripwire, not a stand-in: every seam is injected, so a read of the request client means the
 * service reached past its dependencies and nothing recorded below can be trusted.
 */
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
  /** All five rows, so a step that read too much has something to leak. */
  readonly rows: readonly KnowledgeEntry[];
  readonly condition: VerifiedCondition;
  readonly confidence: number;
  readonly severity: Severity;
  readonly behaviour: { readonly text: string } | { readonly fail: true };
}): Harness {
  const recorded: Recorded = {
    rephraseRequests: [],
    knowledgeReads: [],
    diagnosisRows: [],
    usageRows: [],
    counts: { classify: 0, generate: 0 },
  };

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
    classify: () => {
      recorded.counts.classify += 1;
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
      recorded.counts.generate += 1;
      recorded.rephraseRequests.push(call.prompt);
      if ('fail' in options.behaviour) {
        // Requirement 14.5's exhausted chain. Not a timeout, so step 8 degrades to the row's own
        // template rather than propagating (design: *Post-generation validation*, check 4).
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

  const knowledge: KnowledgeReader = (names) => {
    recorded.knowledgeReads.push([...names]);
    return Promise.resolve(options.rows.filter((row) => names.includes(row.disease_name)));
  };

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
      // `getDeadline()` answers `undefined` outside a platform invocation; stating it keeps the run
      // independent of whether the process happens to be inside one.
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

/* ========================================================================== */
/* Readers over what came back                                                 */
/* ========================================================================== */

function identifiedOf(result: DiagnosisResult): IdentifiedResult {
  if (result.status !== 'identified') {
    throw new Error(`Property 10 needs an identified result; got "${result.status}"`);
  }
  return result;
}

/** The lines between the content header and the rules block, blanks dropped. */
function verifiedContentLines(prompt: string): readonly string[] {
  const lines = prompt.split('\n');
  const from = lines.indexOf(CONTENT_HEADER);
  const to = lines.indexOf(RULES_HEADER);
  if (from < 0 || to <= from) {
    throw new Error('the rephrase request has no VERIFIED CONTENT block ahead of its rules');
  }
  return lines.slice(from + 1, to).filter((line) => line.trim().length > 0);
}

/** Every tagged statement token present in a string, in order of appearance. */
function tokensIn(text: string): readonly string[] {
  return text.match(TAGGED_STATEMENT) ?? [];
}

/** The token that opens a statement — `KB1A2B-symptoms-0`. */
function tokenOf(statement: string): string {
  return statement.split(' ')[0] ?? statement;
}

/* ========================================================================== */
/* Property 10                                                                 */
/* ========================================================================== */

describe('Property 10: identified results are grounded only in the matching knowledge base entry', () => {
  it('grounds every identified diagnosis in exactly one row, and carries nothing else into the request or the answer', async () => {
    const kindsSeen = new Set<ModelKind>();
    const conditionsSeen = new Set<VerifiedCondition>();
    const languagesSeen = new Set<Language>();
    const pathsSeen = new Set<ExpectedPath>();
    const treatmentShapesSeen = new Set<'empty' | 'populated'>();

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const {
          condition,
          language,
          channel,
          caller,
          confidence,
          severity,
          kind,
        } = scenario;

        kindsSeen.add(kind);
        conditionsSeen.add(condition);
        languagesSeen.add(language);
        pathsSeen.add(expectedPathOf(kind));

        // All five rows exist, each with its own tag. Only one of them is the condition the model
        // named; the other four are decoys the grounding step must never reach for.
        const rows = VERIFIED_CONDITIONS.map((name, index) =>
          rowFor(name, tagFor(scenario.seed, index), scenario.tails),
        );
        const entry = rows[VERIFIED_CONDITIONS.indexOf(condition)];
        if (entry === undefined) throw new Error(`no generated row for "${condition}"`);
        const decoys = rows.filter((row) => row.disease_name !== condition);

        treatmentShapesSeen.add(entry.treatment.length === 0 ? 'empty' : 'populated');

        const other =
          VERIFIED_CONDITIONS[
            (VERIFIED_CONDITIONS.indexOf(condition) + scenario.otherOffset) %
              VERIFIED_CONDITIONS.length
          ];
        if (other === undefined || other === condition) {
          throw new Error('the second-condition fixture collided with the condition under test');
        }

        const test = harness({
          rows,
          condition,
          confidence,
          severity,
          behaviour: providerBehaviour(scenario, entry, other),
        });

        const outcome = await diagnose(
          {
            userId: caller,
            storageRef: { bucket: CROP_IMAGES, path: `${caller}/2026/09/${scenario.objectId}.jpg` },
            language,
            channel,
          },
          test.deps,
        );

        const label = `${kind} / ${condition} / ${language}`;
        const result = identifiedOf(outcome.result);

        /* ================================================================== */
        /* 1. Exactly one condition (Requirement 3.5)                          */
        /* ================================================================== */

        expect(result.diseaseName, label).toBe(condition);

        // One row requested, by name, and nothing else — so "the matching entry" is what the
        // service asked for rather than what the fixture happened to hold.
        expect(test.recorded.knowledgeReads, label).toStrictEqual([[condition]]);

        // One classification, one grounding call. A pipeline that grounded a second condition
        // would need a second call or a second read; both are counted.
        expect(test.recorded.counts.classify, label).toBe(1);
        expect(test.recorded.counts.generate, label).toBe(1);

        const persisted = test.recorded.diagnosisRows[0];
        if (persisted === undefined) throw new Error('no diagnosis row was persisted');
        expect(persisted.disease_name, label).toBe(condition);
        expect(persisted.knowledge_id, label).toBe(entry.id);
        expect(persisted.explanation, label).toBe(result.explanation);

        // The whole of what a farmer reads names this condition and no other.
        expect(
          VERIFIED_CONDITIONS.filter((name) => result.explanation.includes(name)),
          label,
        ).toStrictEqual([condition]);
        expect(outOfScopeConditionsIn(result.explanation, [condition]), label).toStrictEqual([]);

        /* ================================================================== */
        /* 2. The request was this row plus the rephrase-only instruction       */
        /*    (Requirements 4.5, 4.3)                                          */
        /* ================================================================== */

        const request = test.recorded.rephraseRequests[0];
        if (request === undefined) throw new Error('the text seam was never handed a request');

        const blockLines = verifiedContentLines(request);
        const itemLines = blockLines
          .filter((line) => line.startsWith('    - '))
          .map((line) => line.slice('    - '.length));
        const labelLines = blockLines.filter((line) => !line.startsWith('    - '));

        // Every statement of this row, verbatim, in column order — and no statement that is not
        // one of them. This is the containment claim: a request that added, dropped, reordered or
        // re-punctuated a single item fails here.
        expect(itemLines, label).toStrictEqual([...statementsOf(entry)]);

        // The canonical name, then one label per column that has content. Nothing else is labelled,
        // so an empty column cannot appear as an invitation to fill it.
        expect(labelLines, label).toStrictEqual([
          `  disease: ${entry.disease_name}`,
          ...nonEmptyFieldsOf(entry).map((field) => `  ${field}:`),
        ]);

        // No third kind of line in the block at all.
        const allowed = new Set<string>([
          `  disease: ${entry.disease_name}`,
          ...KB_FIELDS.map((field) => `  ${field}:`),
        ]);
        for (const line of blockLines) {
          expect(
            line.startsWith('    - ') || allowed.has(line),
            `${label}: unexpected line in the verified-content block: ${JSON.stringify(line)}`,
          ).toBe(true);
        }

        // Requirement 4.5's second half: the instruction to rephrase only the supplied content.
        expect(request, label).toContain(REPHRASE_ONLY_INSTRUCTION);

        // Nothing from another row reached the request, and no other condition is named in it.
        expect(outOfScopeConditionsIn(request, [condition]), label).toStrictEqual([]);
        for (const decoy of decoys) {
          for (const statement of statementsOf(decoy)) {
            expect(request.includes(tokenOf(statement)), `${label}: decoy row in the request`).toBe(
              false,
            );
          }
        }

        // Nor did the classification's own output: the request carries verified content, not the
        // model's judgement about the photo.
        expect(request.includes(String(confidence)), `${label}: confidence in the request`).toBe(
          false,
        );

        /* ================================================================== */
        /* 3. The answer's agricultural content is this row's                  */
        /*    (Requirements 3.2, 4.3)                                          */
        /* ================================================================== */

        // The structured payload, checked against the row column by column rather than against the
        // projection that built it.
        expect(result.knowledge?.symptoms, label).toStrictEqual(entry.symptoms);
        expect(result.knowledge?.causes, label).toStrictEqual(entry.causes);
        expect(result.knowledge?.treatment, label).toStrictEqual(entry.treatment);
        expect(result.knowledge?.prevention, label).toStrictEqual(entry.prevention);
        expect(result.knowledge?.source, label).toBe(entry.source);

        // Every tagged statement in the explanation is one of this row's, and appears whole.
        const ownTokens = new Set(statementsOf(entry).map(tokenOf));
        for (const token of tokensIn(result.explanation)) {
          expect(ownTokens.has(token), `${label}: foreign statement "${token}" in the answer`).toBe(
            true,
          );
          const statement = statementsOf(entry).find((item) => tokenOf(item) === token);
          if (statement === undefined) throw new Error(`no statement for token "${token}"`);
          expect(result.explanation, label).toContain(statement);
        }

        /* ================================================================== */
        /* 4. Which branch produced it, and what that branch guarantees        */
        /* ================================================================== */

        const audit = test.recorded.usageRows[0];
        if (audit === undefined) throw new Error('no audit row was appended');

        if (expectedPathOf(kind) === 'row_template') {
          // Checks 1 and 3, and an exhausted chain, all land on the row's own template — which is
          // what keeps Requirement 3.2 true when the model is unhelpful.
          const { ui } = messages(language);
          const headings: Record<KbField, string> = {
            symptoms: ui.symptomsHeading,
            causes: ui.causesHeading,
            treatment: ui.treatmentHeading,
            prevention: ui.preventionHeading,
          };
          const permitted = new Set<string>([
            entry.disease_name,
            ...nonEmptyFieldsOf(entry).map((field) => `${headings[field]}:`),
            ...statementsOf(entry).map((statement) => `  ${statement}`),
          ]);
          for (const line of result.explanation.split('\n')) {
            expect(
              permitted.has(line),
              `${label}: template line that is not this row's content: ${JSON.stringify(line)}`,
            ).toBe(true);
          }
          // And it is the shared fallback rather than a second rendering of the same idea.
          expect(result.explanation, label).toBe(staticExplanationFor(entry, language));

          expect(audit.outcome, label).toBe(
            kind === 'provider_failed' ? 'provider_error' : 'validation_rejected',
          );
          expect(audit.rejection_reason, label).toBe(
            kind === 'provider_failed' ? null : REPHRASE_REJECTED_REASON,
          );
        } else {
          // The model's prose was kept. It still carries the canonical name — check 2 prefixes it
          // when the model dropped it — and it still names no second condition.
          expect(result.explanation, label).toContain(entry.disease_name);
          expect(audit.outcome, label).toBe('success');
          expect(audit.rejection_reason, label).toBeNull();

          if (kind === 'invents_agronomy') {
            // The boundary the header states. The fabrication is the provider's: it was never in
            // the request, and the row's own content reached the farmer unaltered. No check in
            // Jamee can tell an invented agronomic sentence from a rephrased one — the design says
            // so, and says the guarantee is the request's content instead.
            expect(
              request.includes(scenario.inventionTag),
              `${label}: the fabricated statement came from Jamee's own request`,
            ).toBe(false);
          }
        }
      }),
      // 400 runs over seven provider behaviours, five conditions and three languages, so each cell
      // of the grid is reached many times over rather than probably.
      { numRuns: 400 },
    );

    /* ---------------------------------------------------------------------- */
    /* Non-vacuity: the generators actually produced every class               */
    /* ---------------------------------------------------------------------- */

    expect([...kindsSeen].sort()).toStrictEqual([...MODEL_KINDS].sort());
    expect([...conditionsSeen].sort()).toStrictEqual([...VERIFIED_CONDITIONS].sort());
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
    // Both halves of step 8 ran: the model's prose was kept on some runs and refused on others. A
    // run that only ever fell back would assert nothing about a kept answer, and the reverse.
    expect([...pathsSeen].sort()).toStrictEqual(['model_prose', 'row_template']);
    // And both row shapes were grounded: one with treatment content, one without — so the request's
    // column-omission path is exercised rather than assumed.
    expect([...treatmentShapesSeen].sort()).toStrictEqual(['empty', 'populated']);
  });
});
