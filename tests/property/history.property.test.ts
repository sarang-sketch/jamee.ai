import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DIAGNOSIS_MESSAGES_SELECT,
  formatConfidence,
  formatTimestamp,
  resolveDetailImage,
  toDiagnosisDetail,
  type DiagnosisDetailRow,
} from '@/app/diagnosis/detail';
import { STORAGE_BUCKETS } from '@/lib/config/verified';
import {
  diagnosisDetailHref,
  readHistory,
  type HistoryImageSource,
  type HistoryRow,
} from '@/lib/history';
import { messages } from '@/lib/messages';
import {
  SUPPORTED_LANGUAGES,
  VERIFIED_CONDITIONS,
  type Channel,
  type KnowledgePayload,
  type Language,
  type Severity,
  type StorageRef,
  type VerifiedCondition,
} from '@/lib/schemas';
import { thumbPathFor, type StorageClientLike } from '@/lib/storage';
import { dayWindowKey } from '@/lib/time';

/**
 * ### Property 26: History is complete, ordered, and detailed
 *
 * *"For any set of diagnoses belonging to a farmer across both channels, the history list contains
 * exactly that set, ordered by creation time descending, each entry carrying a thumbnail, the
 * condition name or inconclusive label, the severity, the channel, and the timestamp; and for any
 * entry selected, the detail view presents the image, the condition or inconclusive label, the
 * confidence, the severity, the full explanation, and the related conversation messages."*
 *
 * **Validates: Requirements 12.1, 12.2, 12.3**
 *
 * =============================================================================
 * THREE CLAIMS, THREE DIFFERENT FAILURE MODES — SO THREE SETS OF ASSERTIONS
 * =============================================================================
 *
 * **Complete** fails by dropping a row: a filter that excludes the WhatsApp channel (Requirement
 * 12.2), a de-duplication that collapses two diagnoses with the same instant, a `map` that returns
 * fewer entries than it received. So completeness is asserted as a **bijection** — the id sets are
 * equal *and* the lengths are equal, which a count-only or a subset-only check would both miss —
 * and the per-channel counts are asserted too, because a list that dropped every WhatsApp entry and
 * duplicated a web one would have the right length.
 *
 * Completeness is a claim about `readHistory` dropping nothing from what it was handed. The *page*
 * additionally bounds one render at `HISTORY_PAGE_SIZE` (20), which is a paging decision rather than
 * a filter — so the generated sets stay under that bound and the property says nothing about the
 * 21st diagnosis, which no render of this screen claims to show.
 *
 * **Ordered** fails on ties and on the order the rows arrived in. `readHistory` re-sorts what the
 * query returned, deliberately (its own header: the statement lives at the call site, so a caller
 * that forgot `.order()` must not be what makes Requirement 12.1 true). Two claims follow, and the
 * second is the one that needs generated ties:
 *
 *  1. every consecutive pair is non-increasing **by parsed instant**;
 *  2. the id sequence is **invariant under permutation of the input** — the same set fed in a
 *     different order comes back in the same order.
 *
 * Claim 2 is how "a tie-break that varies run to run" is caught. A comparator that returned `0` for
 * equal timestamps would satisfy claim 1 and fail claim 2, because `Array.prototype.sort` is stable
 * only with respect to the input order — and the input order is PostgREST's, which is not a thing
 * this module controls. Restating `history.ts`'s own tie-break here instead would assert that the
 * code equals itself.
 *
 * **Detailed** fails by losing a field, or by presenting one that must not exist. The list's five
 * fields are checked against the source row; the detail view's six are checked through
 * `toDiagnosisDetail()` and `resolveDetailImage()`, including on the branch where **no image
 * survives** — which is Requirement 12.11 and the reason the field assertions are unconditional on
 * the image state.
 *
 * =============================================================================
 * THE TIMESTAMPS ARE ADVERSARIAL ON PURPOSE
 * =============================================================================
 *
 * `INSTANT_POOL` is five values and every row draws from it, so a generated set routinely contains:
 *
 *  - **ties** — several diagnoses stamped with the same instant, which is ordinary: one WhatsApp
 *    image and one web upload can land in the same millisecond, and `timestamptz` will store both;
 *  - **creation times out of insertion order** — the array handed to `readHistory` is in generation
 *    order, not in time order, which is what the re-sort exists for;
 *  - **instants either side of the Asia/Kolkata day boundary** — `…T18:29:59.999Z` and
 *    `…T18:30:00.000Z` are one millisecond apart and fall on *different local days*. A sort that
 *    reached for the rendered date instead of the instant would reverse that pair, and the local-day
 *    split is asserted as covered using `dayWindowKey()` — Jamee's own answer to which day an
 *    instant belongs to, rather than a second spelling of `Asia/Kolkata` in this file.
 *
 * Each of those classes is recorded while the property runs and asserted afterwards. A generator
 * that stopped producing ties — or a run that happened to produce only single-entry sets, which
 * would make the ordering claim vacuous — fails the test rather than passing it quietly.
 *
 * =============================================================================
 * WHAT IS OBSERVED HERE, AND WHAT IS OBSERVED IN THE INTEGRATION SUITE
 * =============================================================================
 *
 * Both screens are `async` server components, which are not unit-testable functions — so each one
 * keeps its decisions in a module and the page hands it rows: `src/lib/history.ts` for the list,
 * `src/app/diagnosis/detail.ts` for the detail view. Those modules are what this file exercises,
 * with presence stated as data through `HistoryImageSource` and `StorageClientLike`. No Supabase
 * stack, no cookie store, no network.
 *
 * The two things a module-level run cannot reach are the PostgREST predicates themselves — the
 * `user_id` scoping that makes the set "belonging to a farmer" (Requirement 13.2), and the
 * `conversation_id` filter that fetches a thread. Both are exercised against real Postgres in
 * `tests/integration/release-acceptance.test.ts` step 7. What *is* asserted here about the thread is
 * the fact those predicates are built from: the detail view carries the diagnosis's **own**
 * conversation id, and the column list it reads names every field the thread renders — a column that
 * left `DIAGNOSIS_MESSAGES_SELECT` would make its field structurally unpresentable.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const FARMER = '11111111-1111-4111-8111-111111111111';

/**
 * Three conversations for one farmer, so a generated set spreads its diagnoses across threads —
 * which is what makes "the **related** conversation messages" a claim with something to fail
 * against rather than a tautology over a single thread.
 */
const CONVERSATIONS = [
  '21111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '23333333-3333-4333-8333-333333333333',
] as const;

/**
 * Five instants, drawn from by every row.
 *
 * The middle pair is one millisecond apart and straddles 18:30 UTC — midnight in Asia/Kolkata — so
 * the earlier instant renders on 15 September and the later one on 16 September. The pool is small
 * on purpose: that is what makes ties ordinary rather than rare.
 */
const INSTANT_POOL = [
  '2026-09-14T06:15:00.000Z',
  '2026-09-15T18:29:59.999Z',
  '2026-09-15T18:30:00.000Z',
  '2026-09-16T02:45:30.500Z',
  '2026-09-16T02:45:30.500Z',
] as const;

const KNOWLEDGE: KnowledgePayload = {
  symptoms: ['Water-soaked patches on leaves'],
  causes: ['Phytophthora infestans'],
  treatment: ['Remove and destroy infected plants immediately, do not compost them'],
  prevention: ['Plant resistant varieties where available'],
  source: 'Virginia Cooperative Extension, publication ANR-6',
};

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the fixture lost ${what}`);
  return value;
}

/* ========================================================================== */
/* One generated diagnosis, in the two shapes the two screens read              */
/* ========================================================================== */

/**
 * A diagnosis as this test states it: the stored facts, plus what storage would answer for its two
 * objects. One record feeds both the `HistoryRow` and the `DiagnosisDetailRow`, so the list and the
 * detail view are asserted against the same diagnosis rather than against two fixtures that could
 * disagree.
 */
interface Diagnosis {
  readonly id: string;
  readonly status: 'identified' | 'unknown';
  /** `null` exactly on the inconclusive branch (`diagnoses_unknown_shape`, migration 0005). */
  readonly condition: VerifiedCondition | null;
  readonly confidence: number | null;
  readonly severity: Severity;
  readonly channel: Channel;
  readonly createdAt: string;
  readonly conversationId: string;
  readonly explanation: string;
  readonly language: Language;
  /** Whether the Full_Size_Image is in the bucket. */
  readonly originalPresent: boolean;
  /** Whether the Thumbnail_Derivative is. A WhatsApp-originated row never has one. */
  readonly thumbnailPresent: boolean;
  /** Whether the retention sweep has stamped `full_image_deleted_at` (Requirement 18.7). */
  readonly swept: boolean;
}

/** Unique per diagnosis, so no two rows can sign or probe each other's objects. */
function imagePathOf(diagnosis: Diagnosis): string {
  return `${FARMER}/2026/09/${diagnosis.id}.jpg`;
}

const SWEPT_AT = '2026-09-30T00:00:00.000Z';

function historyRowOf(diagnosis: Diagnosis): HistoryRow {
  return {
    id: diagnosis.id,
    status: diagnosis.status,
    disease_name: diagnosis.condition,
    severity: diagnosis.severity,
    channel: diagnosis.channel,
    created_at: diagnosis.createdAt,
    image_bucket: STORAGE_BUCKETS.cropImages,
    image_path: imagePathOf(diagnosis),
    full_image_deleted_at: diagnosis.swept ? SWEPT_AT : null,
  };
}

function detailRowOf(diagnosis: Diagnosis): DiagnosisDetailRow {
  return {
    id: diagnosis.id,
    user_id: FARMER,
    conversation_id: diagnosis.conversationId,
    status: diagnosis.status,
    disease_name: diagnosis.condition,
    confidence: diagnosis.confidence,
    severity: diagnosis.severity,
    explanation: diagnosis.explanation,
    language: diagnosis.language,
    needs_expert: diagnosis.status === 'unknown',
    channel: diagnosis.channel,
    image_bucket: STORAGE_BUCKETS.cropImages,
    image_path: imagePathOf(diagnosis),
    full_image_deleted_at: diagnosis.swept ? SWEPT_AT : null,
    created_at: diagnosis.createdAt,
  };
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const languageArb = fc.constantFrom<Language>(...SUPPORTED_LANGUAGES);
const channelArb = fc.constantFrom<Channel>('web', 'whatsapp');
const severityArb = fc.constantFrom<Severity>('none', 'low', 'moderate', 'high');
const conditionArb = fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS);
const instantArb = fc.constantFrom(...INSTANT_POOL);
const conversationArb = fc.constantFrom(...CONVERSATIONS);

/**
 * A stored explanation. Requirement 12.3 asks for the **full** explanation, so the generator
 * includes a multi-paragraph value and a Devanagari one — the two shapes a real row carries, and the
 * two a truncating or re-encoding view model would spoil.
 */
const explanationArb = fc.oneof(
  fc.constant('Dark patches are spreading on the leaves. Remove the worst ones today.'),
  fc.constant('पानांवर तपकिरी डाग दिसतात.\n\nप्रभावित पाने काढून टाका.'),
  fc.constant('Line one.\nLine two.\n\nA second paragraph, after a blank line.'),
  fc.string({ minLength: 1, maxLength: 120 }).filter((text) => text.trim().length > 0),
);

/**
 * One diagnosis, in one of the two shapes migration `0005`'s check constraints allow.
 *
 * The inconclusive branch is pinned to `severity: 'none'`, `confidence: null` and no name because
 * `diagnoses_unknown_shape` refuses anything else — generating a row the database cannot hold would
 * test a state no farmer's history can contain.
 */
const diagnosisArb: fc.Arbitrary<Diagnosis> = fc
  .record({
    id: fc.uuid(),
    identified: fc.boolean(),
    condition: conditionArb,
    confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    severity: severityArb,
    channel: channelArb,
    createdAt: instantArb,
    conversationId: conversationArb,
    explanation: explanationArb,
    language: languageArb,
    originalPresent: fc.boolean(),
    thumbnailPresent: fc.boolean(),
    swept: fc.boolean(),
  })
  .map((draft) => ({
    id: draft.id,
    status: draft.identified ? ('identified' as const) : ('unknown' as const),
    condition: draft.identified ? draft.condition : null,
    confidence: draft.identified ? draft.confidence : null,
    severity: draft.identified ? draft.severity : ('none' as const),
    channel: draft.channel,
    createdAt: draft.createdAt,
    conversationId: draft.conversationId,
    explanation: draft.explanation,
    language: draft.language,
    originalPresent: draft.originalPresent,
    thumbnailPresent: draft.thumbnailPresent,
    swept: draft.swept,
  }));

/**
 * A farmer's set of diagnoses, and a permutation of it.
 *
 * `minLength: 2` is the non-vacuity floor for the ordering claim: a one-entry list is trivially
 * ordered, and a run that only ever produced one would report an unordered list as ordered. Unique
 * by `id`, because a bijection between "what was stored" and "what came back" is only stateable when
 * the ids identify rows — which they do, `diagnoses.id` being the primary key.
 *
 * The permutation is a full-length shuffle of the *same* records, so the second ordering claim
 * compares two readings of one set rather than two different sets.
 */
const diagnosesArb = fc
  .uniqueArray(diagnosisArb, {
    minLength: 2,
    maxLength: 12,
    selector: (diagnosis) => diagnosis.id,
  })
  .chain((diagnoses) =>
    fc.record({
      diagnoses: fc.constant(diagnoses),
      permuted: fc.shuffledSubarray(diagnoses, {
        minLength: diagnoses.length,
        maxLength: diagnoses.length,
      }),
    }),
  );

/* ========================================================================== */
/* The two storage seams, stated as data                                       */
/* ========================================================================== */

/**
 * The list's image source over a set of present paths, recording every signature.
 *
 * Recording is what makes Requirement 12.6's *prohibition* assertable: "load the derivative and load
 * no Full_Size_Image for that entry" is a claim about which object was **not** signed.
 */
function listSourceOver(present: ReadonlySet<string>): HistoryImageSource & {
  readonly signed: string[];
} {
  const signed: string[] = [];
  return {
    signed,
    probe: (ref: StorageRef) => Promise.resolve(present.has(ref.path)),
    sign: (ref: StorageRef) => {
      signed.push(ref.path);
      return Promise.resolve(`https://signed.test/${ref.bucket}/${ref.path}?token=t`);
    },
  };
}

/** The detail view's client, answering `exists()` from the same set of present paths. */
function detailClientOver(present: ReadonlySet<string>): StorageClientLike {
  return {
    storage: {
      from: (bucket: string) => ({
        exists: (path: string) => Promise.resolve({ data: present.has(path), error: null }),
        createSignedUrl: (path: string) =>
          Promise.resolve({
            data: { signedUrl: `https://signed.test/${bucket}/${path}?token=t` },
            error: null,
          }),
      }),
    },
  };
}

function presentPathsOf(diagnoses: readonly Diagnosis[]): ReadonlySet<string> {
  const present = new Set<string>();
  for (const diagnosis of diagnoses) {
    const path = imagePathOf(diagnosis);
    if (diagnosis.originalPresent) present.add(path);
    if (diagnosis.thumbnailPresent) present.add(thumbPathFor(path));
  }
  return present;
}

/* ========================================================================== */
/* Coverage — the non-vacuity guard                                            */
/* ========================================================================== */

const COVERAGE_CLASSES = [
  /** Two or more diagnoses stamped with the same instant. */
  'timestamp_tie',
  /** A set whose rows fall on more than one Asia/Kolkata day. */
  'kolkata_day_split',
  /** The order rows arrived in was not the order they came back in. */
  'resorted',
  /** Both channels in one list (Requirement 12.2). */
  'both_channels',
  /** A list of WhatsApp-originated diagnoses only. */
  'whatsapp_only',
  /** At least one inconclusive row, which renders the label instead of a condition. */
  'inconclusive_entry',
  /** At least one entry whose image is gone (Requirement 12.10). */
  'image_absent',
  /** At least one entry reading a Thumbnail_Derivative (Requirement 12.6). */
  'thumbnail_read',
] as const;

type CoverageClass = (typeof COVERAGE_CLASSES)[number];

/* ========================================================================== */
/* Property 26, first and second claims: complete and ordered                   */
/* ========================================================================== */

describe('Property 26: history is complete, ordered, and detailed', () => {
  it('returns exactly the farmer’s diagnoses, newest first, in an order that does not depend on how they arrived', async () => {
    const exercised = new Set<CoverageClass>();

    await fc.assert(
      fc.asyncProperty(diagnosesArb, async ({ diagnoses, permuted }) => {
        const present = presentPathsOf(diagnoses);
        const source = listSourceOver(present);

        const entries = await readHistory({
          userId: FARMER,
          source,
          query: () => Promise.resolve({ data: diagnoses.map(historyRowOf), error: null }),
        });

        /* ── Coverage, recorded before the assertions that depend on it ──── */

        const instants = diagnoses.map((diagnosis) => diagnosis.createdAt);
        if (new Set(instants).size < instants.length) exercised.add('timestamp_tie');
        if (new Set(instants.map((iso) => dayWindowKey(new Date(iso)))).size > 1) {
          exercised.add('kolkata_day_split');
        }
        if (entries.map((entry) => entry.id).join() !== diagnoses.map((row) => row.id).join()) {
          exercised.add('resorted');
        }
        const channels = new Set(diagnoses.map((diagnosis) => diagnosis.channel));
        if (channels.size > 1) exercised.add('both_channels');
        else if (channels.has('whatsapp')) exercised.add('whatsapp_only');
        if (diagnoses.some((diagnosis) => diagnosis.status === 'unknown')) {
          exercised.add('inconclusive_entry');
        }

        /* ── Complete: a bijection, not a count ──────────────────────────── */

        // Equal lengths AND equal id sets. Either alone would admit a defect: a duplicated entry
        // keeps the set, and a swapped-in row of another farmer keeps the length.
        expect(entries).toHaveLength(diagnoses.length);
        expect(new Set(entries.map((entry) => entry.id))).toStrictEqual(
          new Set(diagnoses.map((diagnosis) => diagnosis.id)),
        );

        /**
         * Requirement 12.2 as a count rather than as a membership: a list that dropped every
         * WhatsApp-originated diagnosis and duplicated a web one would satisfy the length assertion
         * above. Nothing in `readHistory` filters by channel — this is what says so.
         */
        for (const channel of ['web', 'whatsapp'] as const) {
          expect(
            entries.filter((entry) => entry.channel === channel).length,
            `${channel} entries`,
          ).toBe(diagnoses.filter((diagnosis) => diagnosis.channel === channel).length);
        }

        /* ── Ordered: by instant, and independent of the input order ─────── */

        for (let index = 1; index < entries.length; index += 1) {
          const newer = required(entries[index - 1], `entry ${index - 1}`);
          const older = required(entries[index], `entry ${index}`);
          expect(
            Date.parse(newer.createdAt),
            `entry ${index - 1} (${newer.createdAt}) before ${index} (${older.createdAt})`,
          ).toBeGreaterThanOrEqual(Date.parse(older.createdAt));
        }

        /**
         * The same set, shuffled, read again. Equal id sequences means the order is **total**: it is
         * decided by the rows, not by the sequence they arrived in. This is the assertion generated
         * ties exist for — a comparator that treated equal timestamps as equal would pass the loop
         * above and fail here.
         */
        const again = await readHistory({
          userId: FARMER,
          source: listSourceOver(present),
          query: () => Promise.resolve({ data: permuted.map(historyRowOf), error: null }),
        });
        expect(again.map((entry) => entry.id)).toStrictEqual(entries.map((entry) => entry.id));

        /* ── Detailed: the five fields Requirement 12.1 enumerates ───────── */

        const byId = new Map(diagnoses.map((diagnosis) => [diagnosis.id, diagnosis]));

        for (const entry of entries) {
          const diagnosis = required(byId.get(entry.id), `the source row for ${entry.id}`);
          const label = `${entry.id} (${diagnosis.status}, ${diagnosis.channel})`;

          /**
           * The condition **or** the inconclusive label. `condition` is the stored canonical name,
           * untranslated (Requirement 9.4); `null` is the inconclusive branch, and the label a
           * farmer reads for it comes from the catalog, because this module has no language.
           */
          expect(entry.condition, label).toBe(diagnosis.condition);
          expect(entry.severity, label).toBe(diagnosis.severity);
          expect(entry.channel, label).toBe(diagnosis.channel);
          expect(entry.createdAt, label).toBe(diagnosis.createdAt);

          /* The thumbnail slot, in the three states the list has for it. */
          const path = imagePathOf(diagnosis);
          const thumb = thumbPathFor(path);

          if (diagnosis.thumbnailPresent) {
            exercised.add('thumbnail_read');
            expect(entry.image?.kind, label).toBe('thumbnail');
            expect(entry.image?.url, label).toContain(thumb);
            // Requirement 12.6's prohibition: no Full_Size_Image is loaded for this entry.
            expect(source.signed, `${label}: signed the original anyway`).not.toContain(path);
          } else if (diagnosis.swept) {
            // Requirement 12.10 — stamped by the sweep, and no derivative survived it.
            exercised.add('image_absent');
            expect(entry.image, label).toBeNull();
            expect(source.signed, `${label}: signed a swept original`).not.toContain(path);
          } else {
            /**
             * Requirement 12.7 — no derivative, and the row's own `full_image_deleted_at === null`
             * is its statement that the original is there. The list takes that at its word and does
             * **not** probe, which is why this branch is `full` even when the generated
             * `originalPresent` is false. The detail view probes instead (Requirement 12.8), and the
             * second property below asserts the other side of that deliberate asymmetry.
             */
            expect(entry.image?.kind, label).toBe('full');
            expect(entry.image?.url, label).toContain(path);
          }

          // Requirement 12.3's entry point: selecting an entry opens its own detail view.
          expect(diagnosisDetailHref(entry.id), label).toContain(entry.id);
        }
      }),
      { numRuns: 200 },
    );

    /**
     * The non-vacuity guard. Each class is an assumption the assertions above rest on, and a run
     * that never produced one would be green for the wrong reason — most of all `timestamp_tie`,
     * without which the permutation claim is a restatement of the first ordering loop.
     */
    expect([...exercised].sort()).toStrictEqual([...COVERAGE_CLASSES].sort());
  });

  /* ======================================================================== */
  /* Third claim: the detail view of any entry                                 */
  /* ======================================================================== */

  it('presents the image, the condition or label, the confidence, the severity, the full explanation, and its own conversation', async () => {
    await fc.assert(
      fc.asyncProperty(diagnosisArb, languageArb, async (diagnosis, viewing) => {
        const row = detailRowOf(diagnosis);
        const present = presentPathsOf([diagnosis]);
        const path = imagePathOf(diagnosis);
        const thumb = thumbPathFor(path);

        const knowledge = diagnosis.status === 'identified' ? KNOWLEDGE : null;
        const detail = toDiagnosisDetail(row, knowledge);

        const label = `${diagnosis.id} (${diagnosis.status}, viewed in ${viewing})`;

        // A row shaped as the database allows is always renderable; `null` is reserved for a row
        // that contradicts its own status, which `diagnoses_unknown_shape` makes unwritable.
        expect(detail, label).not.toBeNull();
        if (detail === null) return;

        /* ── The fields shared by both branches ──────────────────────────── */

        expect(detail.severity, label).toBe(diagnosis.severity);
        expect(detail.channel, label).toBe(diagnosis.channel);
        expect(detail.createdAt, label).toBe(diagnosis.createdAt);

        // Requirement 12.3's "full explanation": the stored string, verbatim — every paragraph,
        // every line break, every Devanagari character.
        expect(detail.explanation, label).toBe(diagnosis.explanation);

        /**
         * Requirement 12.3's last field. The thread is read by `conversation_id`, so carrying the
         * diagnosis's **own** conversation is what makes the messages on the screen *related* to it;
         * a view model that lost this would render another thread under this diagnosis.
         */
        expect(detail.conversationId, label).toBe(diagnosis.conversationId);

        /**
         * …and the column list that read is built from names every field the thread renders. A
         * column missing here is a field the screen structurally cannot present, whatever the query
         * predicate does.
         */
        for (const column of ['id', 'role', 'content', 'language', 'input_kind', 'created_at']) {
          expect(DIAGNOSIS_MESSAGES_SELECT, `messages select: ${column}`).toContain(column);
        }

        // A timestamp a farmer can place, on the Asia/Kolkata clock (Requirement 12.3's context).
        expect(formatTimestamp(detail.createdAt, viewing).length, label).toBeGreaterThan(0);

        /* ── The condition or the label, and the confidence ──────────────── */

        if (detail.status === 'identified') {
          // Canonical, Latin script, never translated (Requirements 4.6, 9.4).
          expect(detail.diseaseName, label).toBe(diagnosis.condition);
          expect(detail.confidence, label).toBe(diagnosis.confidence);
          // The confidence as a farmer reads it: a whole-number percentage, never a bare fraction.
          expect(formatConfidence(detail.confidence), label).toMatch(/^\d{1,3}%$/);
          expect(detail.knowledge, label).toStrictEqual(KNOWLEDGE);
        } else {
          /**
           * Requirement 6.5, and the reason the union exists: the rejected model's name and
           * confidence are `null` at the type level, so no render can reach them — and `knowledge`
           * is `null` even though a payload was available, so no treatment text is reachable either.
           * What the farmer reads instead is the catalog's label, which every language has.
           */
          expect(detail.diseaseName, label).toBeNull();
          expect(detail.confidence, label).toBeNull();
          expect(detail.knowledge, label).toBeNull();
          expect(detail.needsExpert, label).toBe(true);
          expect(messages(viewing).ui.inconclusiveLabel.length, label).toBeGreaterThan(0);
        }

        /* ── The image, and Requirement 12.11 ────────────────────────────── */

        const image = await resolveDetailImage(row, detailClientOver(present));

        /**
         * The detail view prefers the **original** (Requirement 12.8) — the opposite of the list's
         * rule, because this is the screen where a farmer looks closely at a lesion — and unlike the
         * list it probes for it, so a row whose object is missing lands on the derivative
         * (Requirement 12.9) or on the no-image sentence (Requirement 12.10) rather than on a broken
         * image.
         */
        if (!diagnosis.swept && diagnosis.originalPresent) {
          expect(image.kind, label).toBe('full');
          if (image.kind !== 'none') expect(image.url, label).toContain(path);
        } else if (diagnosis.thumbnailPresent) {
          expect(image.kind, label).toBe('thumbnail');
          if (image.kind !== 'none') expect(image.url, label).toContain(thumb);
        } else {
          expect(image.kind, label).toBe('none');
        }

        /**
         * Requirement 12.11 — with no image at all, every remaining field Requirement 12.3 lists is
         * still on the screen. Asserted by re-reading them *after* the image resolution rather than
         * by trusting that the two are independent.
         */
        expect(detail.explanation, label).toBe(diagnosis.explanation);
        expect(detail.severity, label).toBe(diagnosis.severity);
        expect(detail.conversationId, label).toBe(diagnosis.conversationId);
      }),
      { numRuns: 300 },
    );
  });
});
