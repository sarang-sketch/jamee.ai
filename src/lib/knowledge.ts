import 'server-only';

import type { DiseaseKnowledgeDoc } from '@/lib/db/collections';
import { knowledgeReads } from '@/lib/db/reads';
import { AppError } from '@/lib/errors';
import {
  VERIFIED_CONDITIONS,
  type VerifiedCondition,
  type KnowledgePayload,
  type Severity,
} from '@/lib/schemas';

/**
 * The knowledge base, read side. Canonical-name lookup and scope resolution over the five
 * `disease_knowledge` rows — nothing else.
 *
 * Requirements: 4.1 (the base holds exactly the five Verified_Conditions), 4.3 / 4.4 (every
 *               symptom, cause, treatment and prevention sentence a farmer reads is composed from
 *               a row here), 4.7 (a question outside the Verified_Conditions gets the honest
 *               referral), 7.6 (a question with no verified content behind it gets the same),
 *               13.3 (authenticated read on this collection), 13.4 (read-only to the application)
 * Design: "0004: disease_knowledge" (read under the Amendment A3 mapping); "Prompting and
 *         grounding" → scope resolution and the static referral; D17, D18
 *
 * ### WHAT THIS MODULE IS NOT ALLOWED TO DO
 *
 * It supplies **verified facts and one decision**. It does not call a model, does not compose
 * prose, and does not localize a single character. Those three belong to `prompts.ts` (task 9.2)
 * and the message catalogs (D5), and keeping them out of here is what makes "every agricultural
 * sentence traces to a knowledge-base row" checkable: there is exactly one place rows come from,
 * and it cannot invent one.
 *
 * ### THE FIVE NAMES ARE IMPORTED, NEVER RETYPED
 *
 * `VERIFIED_CONDITIONS` comes from `schemas.ts`. The list already exists in a small number of
 * pinned places by design (the Zod enum, the collection `$jsonSchema` validators in `setup.ts`,
 * the `names.ts` copy the node-run setup script shares), and a unit test asserts those copies are
 * byte-identical. A fresh copy in this file would be that guard's failure waiting to happen, so the
 * scope vocabulary below is **derived** from the imported list rather than written out.
 *
 * =============================================================================
 * THE READER GOES THROUGH THE DATA_ACCESS_LAYER (Amendment A3)
 * =============================================================================
 *
 * The knowledge base is reached only through the Data_Access_Layer's read-only `knowledgeReads()`
 * accessor (`src/lib/db/reads.ts`), which is the ONE holder of the driver for this collection (D18)
 * and exposes a read and no write at all (Requirement 13.4).
 *
 * The base belongs to no farmer, so the accessor is deliberately NOT owner-scoped — and that is
 * safe for exactly the reason the owner-scoping discipline exists: `disease_knowledge` holds no
 * tenant data, so a read of it cannot cross a tenant boundary. There is one accessor, it reads the
 * five shared rows, and every caller — the web screen, the chat turn, the Telegram adapter — uses
 * it.
 *
 * ### THE SEAM IS UNCHANGED, SO ITS CALLERS AND TESTS ARE UNCHANGED
 *
 * `KnowledgeReader` is still a plain `(names) => Promise<KnowledgeEntry[]>`, and `KnowledgeEntry`
 * is still the same row shape. The read lives entirely in the DEFAULT reader
 * (`defaultKnowledgeReader`) and in `knowledgeReaderFrom`, which maps the layer's document
 * to the seam's row shape. `resolveScope`, `lookupCondition`, `knowledgePayloadOf`,
 * `matchConditions` and `hasTreatmentContent` are byte-for-byte the same decisions over the same
 * shape, which is why the unit tests that stub `KnowledgeReader` need no change.
 */

/* ========================================================================== */
/* The read seam                                                               */
/* ========================================================================== */

/**
 * A knowledge-base row, in the shape every consumer already reads.
 *
 * This local interface has the exact field names `resolveScope`, `knowledgePayloadOf` and the
 * detail screen read — `disease_name`, `symptoms`, `causes`, `treatment`, `prevention`, `source`,
 * … — so the seam, its consumers and its tests are untouched by the A3 storage change. Its
 * enumerated fields are typed from the `schemas.ts` domain unions rather than re-spelled as
 * literals, the same single-source discipline `collections.ts` follows. The Data_Access_Layer
 * stores a `DiseaseKnowledgeDoc` (camelCase, `_id`); `docToEntry()` below is the one place that
 * maps the layer's document to this row shape, so the mapping lives once.
 */
export interface KnowledgeEntry {
  readonly id: string;
  readonly disease_name: VerifiedCondition;
  readonly crop: 'tomato' | 'potato';
  readonly scientific_name: string | null;
  readonly symptoms: string[];
  readonly causes: string[];
  readonly treatment: string[];
  readonly prevention: string[];
  readonly default_severity: Severity;
  readonly source: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * The only read this module makes: given canonical names, return their rows.
 *
 * A **function** rather than a mirrored driver builder, deliberately: there is one read, and
 * mirroring the accessor structurally would mean a test had to reproduce it to assert something
 * about scope resolution. The real read lives once in `defaultKnowledgeReader` below.
 */
export type KnowledgeReader = (
  names: readonly VerifiedCondition[],
) => Promise<readonly KnowledgeEntry[]>;

/**
 * Map a Data_Access_Layer `DiseaseKnowledgeDoc` to the `KnowledgeEntry` row shape the consumers
 * read. THE one place the camelCase document becomes the snake_case row — `_id` becomes the string
 * `id`, and the arrays and provenance are copied verbatim (Requirement 4.3 forbids composing or
 * altering them). `scientificName` is written as `scientific_name`, coalescing an absent value to
 * `null` to match the nullable column shape.
 */
function docToEntry(doc: DiseaseKnowledgeDoc): KnowledgeEntry {
  return {
    id: doc._id.toHexString(),
    disease_name: doc.diseaseName,
    crop: doc.crop,
    scientific_name: doc.scientificName ?? null,
    symptoms: [...doc.symptoms],
    causes: [...doc.causes],
    treatment: [...doc.treatment],
    prevention: [...doc.prevention],
    default_severity: doc.defaultSeverity,
    source: doc.source,
    created_at: doc.createdAt.toISOString(),
    updated_at: doc.updatedAt.toISOString(),
  };
}

/**
 * Adapt the Data_Access_Layer's read-only knowledge accessor into a `KnowledgeReader`.
 *
 * `legacyClient` is an IGNORED optional legacy parameter, kept so callers written against the
 * former data-client signature (`knowledgeReaderFrom(deps.supabase)`) still compile through the
 * port without every call site changing at once — the same shape the quota port kept for its
 * counter RPC. The Data_Access_Layer is the only source of rows; nothing here reads the argument.
 *
 * A failure THROWS rather than reading as "no rows": an empty result means the row is not there, an
 * error means Jamee could not find out, and reporting "no verified content" for a database failure
 * would turn an outage into a confident, wrong referral. The layer throws on any real failure; this
 * wrapper turns that into the taxonomy `INTERNAL_ERROR` with the cause logged server-side.
 */
export function knowledgeReaderFrom(legacyClient?: unknown): KnowledgeReader {
  void legacyClient;
  return async (names) => {
    if (names.length === 0) return [];
    try {
      const docs = await knowledgeReads().byNames(names);
      return docs.map(docToEntry);
    } catch (cause) {
      throw new AppError('INTERNAL_ERROR', {
        cause,
        context: { reason: 'knowledge_read_failed', requested: [...names] },
      });
    }
  };
}

/**
 * The default reader: the read-only knowledge accessor.
 *
 * The DEFAULT reader. There is one accessor for the one shared, farmer-less collection, so this is
 * simply `knowledgeReaderFrom()` with no argument.
 */
export const defaultKnowledgeReader: KnowledgeReader = knowledgeReaderFrom();

/* ========================================================================== */
/* Lookup by canonical name (Requirement 4.3)                                  */
/* ========================================================================== */

/**
 * A lookup outcome. **A miss and a row with no treatment are different things**, and this union is
 * what keeps them different.
 *
 * `Tomato Healthy` carries `treatment: []` by seed AND by the setup validator (Requirement 3.4),
 * so "there is deliberately no treatment to show" is a *successful* lookup whose `treatment` array
 * is empty. Collapsing that into the same value as "no such row" would let a healthy result render
 * as a failure, or — worse — let a genuine miss render as "healthy, nothing to do".
 */
export type KnowledgeLookup =
  | { readonly found: true; readonly entry: KnowledgeEntry }
  | { readonly found: false };

/**
 * The row for one Canonical_Disease_Name: symptoms, causes, treatment, prevention, source,
 * scientific name and default severity.
 *
 * The parameter is a `VerifiedCondition`, not a `string`, so a name outside the five is
 * unrepresentable here — the safety gate is `visionVerifiedSchema` in `schemas.ts` and this module
 * does not re-litigate it (Requirement 5.6). `{ found: false }` therefore means the row is absent
 * from a database that Requirement 4.1 says should hold all five: an unseeded or partially seeded
 * deployment. It is reported rather than thrown because the caller's answer is the same either way
 * — an inconclusive result or a referral, not a crash.
 */
export async function lookupCondition(
  name: VerifiedCondition,
  read: KnowledgeReader = defaultKnowledgeReader,
): Promise<KnowledgeLookup> {
  const rows = await read([name]);
  const entry = rows.find((row) => row.disease_name === name);
  return entry === undefined ? { found: false } : { found: true, entry };
}

/**
 * The row content in the shape `identifiedResultSchema.knowledge` takes.
 *
 * A projection, not a transformation: the five arrays and the citation are copied across verbatim,
 * which is what Requirement 4.3 means by "composed from the Knowledge_Base entry". Kept here so
 * `prompts.ts` and the diagnosis path read the same field names off the same row and cannot drift
 * into two spellings of "grounded".
 */
export function knowledgePayloadOf(entry: KnowledgeEntry): KnowledgePayload {
  return {
    symptoms: [...entry.symptoms],
    causes: [...entry.causes],
    treatment: [...entry.treatment],
    prevention: [...entry.prevention],
    source: entry.source,
  };
}

/**
 * Whether this entry has treatment content to render at all.
 *
 * Reads as a question about the row rather than as `length > 0` at four call sites, and gives the
 * rephrase prompt's "if treatment is empty, do not mention treatment at all" rule (Requirement
 * 3.4) one place to ask. False for `Tomato Healthy`, always, by seed and validator.
 */
export function hasTreatmentContent(entry: KnowledgeEntry): boolean {
  return entry.treatment.length > 0;
}

/* ========================================================================== */
/* Scope resolution (Requirements 4.7, 7.6)                                    */
/* ========================================================================== */

type NonEmpty<T> = readonly [T, ...T[]];

/** Why a question resolved to no rows. Each value names the copy the caller renders. */
export type ReferralReason =
  /** 4.7 — nothing in the question matched the verified vocabulary → `chat.outOfScope`. */
  | 'out_of_scope'
  /** 7.6 — names matched, but the base returned no rows for them → `chat.noVerifiedInfo`. */
  | 'no_verified_content';

/**
 * The rows a chat turn may be grounded in — or the instruction to refer the farmer onward.
 *
 * **The empty case is a distinct variant, on purpose.** The design is explicit that `ChatService`
 * resolves scope FIRST and, when the set is empty, returns the static localized referral with
 * `needsExpert: true` and **makes no model call at all** (Requirements 4.7, 7.6). A bare
 * `KnowledgeEntry[]` return would have left that as a rule someone has to remember, and a
 * forgotten `if (rows.length === 0)` spends a provider call to ask a model about a crop Jamee
 * does not cover. With `kind: 'referral'` the caller cannot reach `entries[0]` without handling
 * it, and with `entries: NonEmpty<…>` the grounded branch needs no defensive index check.
 */
export type KnowledgeScope =
  | {
      readonly kind: 'grounded';
      readonly entries: NonEmpty<KnowledgeEntry>;
      readonly conditions: NonEmpty<VerifiedCondition>;
    }
  | {
      readonly kind: 'referral';
      readonly reason: ReferralReason;
      readonly entries: readonly [];
      readonly conditions: readonly [];
    };

export interface ScopeQuery {
  /**
   * The condition already established for this conversation, from the most recent
   * Diagnosis_Result. This is how a subject-less follow-up — "why?", "how much?" — stays in scope
   * (Requirement 7.3): the question contributes no vocabulary, and the diagnosis supplies it.
   *
   * `null` and `undefined` are both accepted and mean the same thing, because the value usually
   * arrives as a diagnosis's `diseaseName`, which is nullable on the inconclusive branch.
   */
  readonly condition?: VerifiedCondition | null | undefined;
  /** The farmer's question, matched against the vocabulary derived from the five names. */
  readonly question?: string | undefined;
}

/**
 * Resolve which knowledge-base rows are in scope for a condition, a question, or both.
 *
 * Order matters: the vocabulary match happens with no I/O, and the database is touched only once
 * something is in scope. So an out-of-scope question costs zero queries and zero provider calls.
 */
export async function resolveScope(
  query: ScopeQuery,
  read: KnowledgeReader = defaultKnowledgeReader,
): Promise<KnowledgeScope> {
  const wanted = new Set<VerifiedCondition>();
  if (query.condition !== null && query.condition !== undefined) wanted.add(query.condition);
  if (query.question !== undefined) {
    for (const condition of matchConditions(query.question)) wanted.add(condition);
  }

  if (wanted.size === 0) return referral('out_of_scope');

  const names = orderCanonically([...wanted]);
  const rows = await read(names);

  // Ordered by the shared list rather than by whatever order the read returned, so the same
  // question produces byte-identical prompt content on two runs (D7's parity reasoning) and the
  // `groundedIn` array a farmer's client receives is stable.
  const entries = [...rows].sort(
    (a, b) => canonicalIndexOf(a.disease_name) - canonicalIndexOf(b.disease_name),
  );

  const [first, ...rest] = entries;
  if (first === undefined) {
    // In scope by vocabulary, but the base has no row for it. Requirement 4.1 says this cannot
    // happen in a seeded deployment; if it does, the honest answer is 7.6's "no verified
    // information" rather than an invented one, and still no model call.
    return referral('no_verified_content');
  }

  return {
    kind: 'grounded',
    entries: [first, ...rest],
    conditions: [first.disease_name, ...rest.map((row) => row.disease_name)],
  };
}

function referral(reason: ReferralReason): KnowledgeScope {
  return { kind: 'referral', reason, entries: [], conditions: [] };
}

/* -------------------------------------------------------------------------- */
/* The vocabulary, derived from VERIFIED_CONDITIONS                            */
/* -------------------------------------------------------------------------- */

/**
 * Each canonical name split into the crop word and the qualifier that follows it:
 * `Tomato Early Blight` → crop `tomato`, qualifier `['early','blight']`.
 *
 * Derived, so `crop` here is the same word as the `crop` validator enum without either being
 * written down twice, and adding a sixth condition to `VERIFIED_CONDITIONS` extends the matcher
 * with no edit to this file.
 */
const VOCABULARY: readonly {
  readonly condition: VerifiedCondition;
  readonly crop: string;
  readonly qualifier: readonly string[];
}[] = VERIFIED_CONDITIONS.map((condition) => {
  const [crop = '', ...qualifier] = condition.toLowerCase().split(' ');
  return { condition, crop, qualifier };
});

const CANONICAL_ORDER: ReadonlyMap<string, number> = new Map(
  VERIFIED_CONDITIONS.map((name, index) => [name, index]),
);

function canonicalIndexOf(name: string): number {
  return CANONICAL_ORDER.get(name) ?? VERIFIED_CONDITIONS.length;
}

function orderCanonically(names: readonly VerifiedCondition[]): readonly VerifiedCondition[] {
  return [...names].sort((a, b) => canonicalIndexOf(a) - canonicalIndexOf(b));
}

/**
 * The words of a question, lowercased, plus a singular form for a plural one.
 *
 * The plural strip is one line and is not the beginning of a synonym table: "my tomatoes" and "my
 * tomato" are the same question to a farmer, and a scope decision that turned on the letter `s`
 * would be a referral for no reason a farmer could see. Anything beyond that — synonyms, spelling
 * variants, transliterations — is vocabulary, which is localization, which this module does not do.
 *
 * ### Devanagari, stated rather than hidden
 *
 * `[a-z]+` matches Latin letters only, so a Hindi or Marathi question contributes **no** tokens
 * and resolves on `query.condition` alone. That is correct for the common path — Requirement 7.1
 * builds Conversation_Context from the conversation's most recent Diagnosis_Result, so a follow-up
 * in any language already has its subject — and it is honest for the uncommon one: a Devanagari
 * question with no established diagnosis gets the referral (Requirements 4.7, 7.6) rather than a
 * guess. Fixing that properly needs localized condition vocabulary, which belongs with the message
 * catalogs; faking it with a hand-written translation table here would be the very copy this module
 * exists to avoid.
 */
function tokenize(question: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const raw of question.toLowerCase().match(/[a-z]+/g) ?? []) {
    tokens.add(raw);
    if (raw.endsWith('es')) tokens.add(raw.slice(0, -2));
    else if (raw.endsWith('s')) tokens.add(raw.slice(0, -1));
  }
  return tokens;
}

/**
 * The conditions a question is about, widest-match-last.
 *
 * Three tiers, tried in order and stopping at the first that matches anything, so a specific
 * question stays specific and a vague one still lands somewhere useful:
 *
 *  1. **Crop and qualifier** — "my tomato has late blight" → `Tomato Late Blight` alone.
 *  2. **Crop, or qualifier, on its own** — "spots on my potato leaves" → the three potato rows;
 *     "what is late blight?" → both late blight rows, tomato and potato.
 *  3. **Any qualifier word** — "is this blight?" → the four blight rows.
 *
 * Anything else returns empty, which is the whole point: "my wheat has rust" matches no tier, and
 * the empty set is what `resolveScope` turns into the no-model-call referral of Requirement 4.7.
 *
 * Exported because it is pure and decides a farmer-visible outcome, so it is worth testing
 * directly rather than only through a stubbed database.
 */
export function matchConditions(question: string): readonly VerifiedCondition[] {
  const tokens = tokenize(question);
  if (tokens.size === 0) return [];

  const exact = VOCABULARY.filter(
    (entry) =>
      tokens.has(entry.crop) && entry.qualifier.every((word) => tokens.has(word)),
  );
  if (exact.length > 0) return orderCanonically(exact.map((entry) => entry.condition));

  const partial = VOCABULARY.filter(
    (entry) =>
      tokens.has(entry.crop) || entry.qualifier.every((word) => tokens.has(word)),
  );
  if (partial.length > 0) return orderCanonically(partial.map((entry) => entry.condition));

  const loose = VOCABULARY.filter((entry) =>
    entry.qualifier.some((word) => tokens.has(word)),
  );
  return orderCanonically(loose.map((entry) => entry.condition));
}
