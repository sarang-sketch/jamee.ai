import { type ProtectedScreenPath } from '@/lib/auth/protected-paths';
import { AppError } from '@/lib/errors';
import type { StorageRef } from '@/lib/schemas';
import {
  signedUrlOrNull,
  thumbRefFor,
  type StorageClientLike,
} from '@/lib/storage';
import type { DiagnosisRow } from '@/types/database';

/**
 * Everything the history screen decides, separated from how it renders.
 *
 * Requirements: 12.1 (an authenticated Farmer's Diagnosis_Results listed reverse-chronologically
 *               with the crop image thumbnail, the reported condition or the inconclusive label,
 *               the Severity_Value, the channel, and the creation timestamp), 12.2 (WhatsApp
 *               Diagnosis_Results are in that list), 12.4 (an empty list invites a first upload),
 *               12.5 (a stored image or thumbnail is loaded through a Signed_URL), 12.6 (an entry
 *               whose Thumbnail_Derivative is present loads that derivative and NO
 *               Full_Size_Image), 12.7 (an entry with no derivative and a present original renders
 *               the original), 12.10 (an entry with neither renders without an image and says so),
 *               13.2 (own rows only), 9.4 (a Canonical_Disease_Name is never translated)
 * Design: "Frontend" — `/history` is a server component reading through the RLS-scoped client;
 *          "Media lifecycle and retention" — mechanism 2, *read a derivative for list views*
 *
 * ### Why this is a module in `lib/` and not the page body
 *
 * Two of the three decisions here are worth asserting directly, and neither needs React to be
 * true: which image each entry reads, and what order the entries come back in. An `async` server
 * component is not a unit-testable function, so the page builds one statement and hands the rows
 * to `readHistory`, and `history.test.ts` covers the branches without a request, a cookie store,
 * or a Supabase client.
 *
 * It lives here rather than in `src/app/history/` because `HistoryList` lives in
 * `src/components/` and consumes `HistoryEntry`. A component reaching into `src/app/**` would
 * invert the layering the design sets out; the diagnosis detail view keeps its own decisions in
 * `src/app/diagnosis/detail.ts` precisely because nothing outside that screen reads them.
 *
 * ### Why the list's image rule is NOT the detail view's image rule
 *
 * They are two different requirements pointing opposite ways, and collapsing them into one
 * "resolve an image" helper would break whichever one lost:
 *
 *  - **The list prefers the thumbnail** (Requirement 12.6) and is forbidden from loading the
 *    original when a derivative exists. That is mechanism 2 of the media-lifecycle amendment: 20
 *    entries at ~25 KB instead of 20 at ~400 KB, measured against V19's 5 GB/month egress.
 *  - **The detail view prefers the original** (Requirement 12.8), because that screen is where a
 *    farmer looks closely at a lesion.
 *
 * What the two share is the primitives — `thumbRefFor()` for the derived path,
 * `signedUrlOrNull()` for the URL, `exists()` for presence — and all three come from
 * `src/lib/storage.ts`, which is the single source of the path convention (Requirement 2.13).
 */

/* ========================================================================== */
/* Paths                                                                       */
/* ========================================================================== */

/**
 * Both hrefs are typed `ProtectedScreenPath`, so a path that left
 * `PROTECTED_SCREEN_PATHS` would break this file rather than quietly become a link into an
 * ungated screen (Requirement 1.6). That is the whole reason for the annotation — the strings
 * themselves are unremarkable.
 */
const DIAGNOSIS_DETAIL_BASE: ProtectedScreenPath = '/diagnosis';

/** Where the empty state sends a farmer who has nothing to look at yet (Requirement 12.4). */
export const DIAGNOSE_PATH: ProtectedScreenPath = '/diagnose';

/**
 * The detail view of one entry (Requirement 12.3, task 13.2's screen).
 *
 * `encodeURIComponent` on a value that is always a uuid is not defensive theatre about the
 * database — it is what keeps this function correct if it is ever handed an id from somewhere
 * other than a `diagnoses` row.
 */
export function diagnosisDetailHref(id: string): string {
  return `${DIAGNOSIS_DETAIL_BASE}/${encodeURIComponent(id)}`;
}

/* ========================================================================== */
/* The read                                                                    */
/* ========================================================================== */

/**
 * How many entries one render of the list carries.
 *
 * 20 is the figure the design's egress arithmetic is written against ("a history screen of 20
 * entries reads 20 thumbnails, not 20 full-size originals"), and it is also one day of image
 * quota (Requirement 14.1) — so a farmer's most recent day of work fits on the screen without
 * paging. It bounds two costs at once: the thumbnails the browser fetches, and the presence
 * probes this module issues.
 */
export const HISTORY_PAGE_SIZE = 20;

/**
 * The `diagnoses` columns the list reads.
 *
 * Enumerated rather than `*`, and `as const` for the reason `PROFILE_SETTINGS_SELECT` gives:
 * PostgREST parses the select string at the **type** level, so this literal is what makes the row
 * type below checkable at the call site. It also keeps `explanation`, `confidence`,
 * `knowledge_id` and `model_provider` off a screen that has no field for them.
 *
 * `full_image_deleted_at` is the load-bearing one. The design chose a column read over a storage
 * probe so "deleted by policy" is distinguishable from "missing unexpectedly" without paying a
 * round trip per row, and Requirement 12.10's copy turns on that distinction.
 */
/*
 * One unbroken literal rather than a concatenation, because `as const` cannot be applied to a
 * `+` expression — and without `as const` PostgREST's type-level parser receives the wide `string`
 * type and the row type at the call site collapses. The line is long for a reason.
 */
export const HISTORY_SELECT =
  'id, status, disease_name, severity, channel, created_at, image_bucket, image_path, full_image_deleted_at' as const;

export type HistoryRow = Pick<
  DiagnosisRow,
  | 'id'
  | 'status'
  | 'disease_name'
  | 'severity'
  | 'channel'
  | 'created_at'
  | 'image_bucket'
  | 'image_path'
  | 'full_image_deleted_at'
>;

/** The slice of a PostgREST error this module reads. `PostgrestError` satisfies it. */
export interface HistoryQueryError {
  code: string;
  message: string;
}

/**
 * The read, as a function the caller supplies:
 *
 *     () =>
 *       supabase
 *         .from('diagnoses')
 *         .select(HISTORY_SELECT)
 *         .eq('user_id', userId)
 *         .order('created_at', { ascending: false })
 *         .order('id', { ascending: false })
 *         .limit(HISTORY_PAGE_SIZE)
 *
 * A function rather than a client-shaped interface, for the reason `profile.ts` records at
 * length: relating a Supabase query builder to a hand-written interface makes the compiler
 * evaluate PostgREST's own generic machinery and can fail with TS2589. The statement stays checked
 * by supabase-js against the real schema at the call site; its *result* is checked against the
 * shape declared here.
 *
 * `PromiseLike` rather than `Promise` because a PostgREST builder is thenable, not a `Promise`.
 */
export type HistoryQuery = () => PromiseLike<{
  data: HistoryRow[] | null;
  error: HistoryQueryError | null;
}>;

/* ========================================================================== */
/* The view model                                                              */
/* ========================================================================== */

/**
 * Which derivative an entry's thumbnail slot is showing.
 *
 * Rendered nowhere — the two look identical in the list, by design. It exists so the unit test
 * can assert Requirement 12.6 as a fact about *which object was signed* rather than by inspecting
 * a URL string, and so a future change that started loading originals for every row would break a
 * test instead of an egress budget.
 */
export type HistoryImageKind = 'thumbnail' | 'full';

export interface HistoryImage {
  readonly kind: HistoryImageKind;
  /** Requirement 12.5 — always a Signed_URL; both buckets are private (Requirement 13.5). */
  readonly url: string;
}

/**
 * One row of the list, with every field Requirement 12.1 enumerates.
 *
 * `condition: null` is the inconclusive branch. The label a farmer reads for it comes from the
 * catalog (`ui.inconclusiveLabel`), not from here: this module knows the row is inconclusive, and
 * the component knows what that is called in the active language. Storing the rendered label here
 * would put farmer-facing English in a module with no language parameter.
 *
 * `image: null` is Requirement 12.10 — neither derivative is present, which is an ordinary state
 * for a WhatsApp-originated entry past the retention window.
 */
export interface HistoryEntry {
  readonly id: string;
  /** Canonical, Latin script, never translated (Requirements 4.6, 9.4). */
  readonly condition: HistoryRow['disease_name'];
  readonly severity: HistoryRow['severity'];
  /** Requirement 12.2 — `whatsapp` entries are in this list on the same footing as `web` ones. */
  readonly channel: HistoryRow['channel'];
  /** The stored `timestamptz`, formatted for display by the component. */
  readonly createdAt: string;
  readonly image: HistoryImage | null;
}

/* ========================================================================== */
/* Storage seam                                                                */
/* ========================================================================== */

/**
 * The two storage operations the list needs, as functions.
 *
 * Split out from the client so the unit test states presence as data — "the thumbnail is there,
 * the original is not" — rather than assembling a stand-in Supabase client to say the same thing.
 * `storageImageSource()` below is the production implementation and the only caller that touches
 * a client.
 */
export interface HistoryImageSource {
  /** Whether the object is actually in the bucket. */
  probe: (ref: StorageRef) => Promise<boolean>;
  /** A Signed_URL, or `null` when one cannot be minted (Requirement 12.5). */
  sign: (ref: StorageRef) => Promise<string | null>;
}

/**
 * The production source, over the RLS-scoped server client.
 *
 * ### Why presence is probed at all
 *
 * Because nothing records it. No column stores a thumbnail path — the path is derived
 * (Requirement 2.13) — and no column records whether the derivative landed. Three ordinary
 * situations produce a row with no thumbnail:
 *
 *  - a **WhatsApp-originated** diagnosis, because the derivative is produced in the browser and
 *    that path has no browser (design: *What is deleted, when, and by whom*);
 *  - a **web upload whose thumbnail upload failed** after the original succeeded, which
 *    Requirement 2.14 says must still produce a diagnosis;
 *  - a row **written before the media-lifecycle amendment**, which had no derivative at all.
 *
 * Requirement 12.7 is written for exactly those rows, so the list has to be able to tell.
 *
 * ### Why the probe and not a signing failure
 *
 * `createSignedUrl` signs a *path*. V3 records the call and its units and does **not** say it
 * fails for a missing object, so a fallback built on "signing returned null" would rest on
 * unverified behaviour — and when it was wrong, the entry would render a broken-image icon
 * instead of Requirement 12.10's sentence. `exists()`'s three-way outcome was read off the pinned
 * SDK and is documented in `storage.ts`, which is why it is the presence question's answer.
 *
 * The cost is bounded and it is not egress: one `exists()` per entry, at most
 * `HISTORY_PAGE_SIZE` per render, issued concurrently. That is the trade the design's objection to
 * probing was about avoiding *for the original* — and there a column already answers it, so this
 * module never probes for one.
 */
export function storageImageSource(client: StorageClientLike): HistoryImageSource {
  return {
    async probe(ref: StorageRef): Promise<boolean> {
      try {
        const { data } = await client.storage.from(ref.bucket).exists(ref.path);
        return data;
      } catch {
        /**
         * A transport failure or a misconfigured policy is not evidence of presence, and it is
         * not evidence of absence either. Reported as absent because this view has honest copy
         * for absence and a fallback for it, so the failure degrades one entry's picture rather
         * than the screen. `assertOwnership()` makes the opposite choice for the same call,
         * because there a failed probe must not be reported as "you do not own this".
         */
        return false;
      }
    },
    sign: (ref: StorageRef) => signedUrlOrNull(ref, client),
  };
}

/* ========================================================================== */
/* Which image an entry reads (Requirements 12.5, 12.6, 12.7, 12.10)           */
/* ========================================================================== */

/**
 * `thumbRefFor` throws on a path with no extension, which every stored path has by
 * `storageRefSchema`. A row that somehow does not is a corrupt row, not a reason to fail the
 * render — it simply has no derivable thumbnail, which leaves it on Requirement 12.7 or 12.10.
 */
function thumbnailRefOrNull(ref: StorageRef): StorageRef | null {
  try {
    return thumbRefFor(ref);
  } catch {
    return null;
  }
}

type ImageRowFields = Pick<
  HistoryRow,
  'image_bucket' | 'image_path' | 'full_image_deleted_at'
>;

/**
 * The one object this entry's thumbnail slot loads, or `null`.
 *
 * ### The order, and what each step is allowed to conclude
 *
 * 1. **The derivative is probed first, and a hit ends it.** Requirement 12.6 is not a preference,
 *    it is a prohibition: load the derivative and load *no* Full_Size_Image for that entry. So the
 *    original is never signed on this branch — the browser cannot fetch a URL that was not minted.
 * 2. **`full_image_deleted_at !== null` ends it too.** The sweep stamped the row (Requirement
 *    18.7), so the original is gone by policy and probing for it would spend a round trip
 *    confirming what the row already states. This is the column read the design chose over a
 *    probe per list row.
 * 3. **Otherwise the original is the fallback** (Requirement 12.7), and it is *not* probed. A
 *    `diagnoses` row exists only because an upload succeeded first — the uploader posts the
 *    reference after the object lands, and the service inserts the row after that — so
 *    `full_image_deleted_at === null` is the row's own statement that the object is there. That
 *    is precisely the statement the column was added to make, and taking it at its word is what
 *    keeps this at one probe per entry rather than two.
 * 4. **A signing failure collapses into `null`.** `signedUrlOrNull` returns `null` for a
 *    transport failure as well as a missing object, and the view's question is "can this be
 *    shown". It already has copy for "no" (Requirement 12.10), so a fourth state with a fourth
 *    sentence in three catalogs would buy nothing a reload does not fix.
 */
export async function resolveHistoryImage(
  row: ImageRowFields,
  source: HistoryImageSource,
): Promise<HistoryImage | null> {
  const original: StorageRef = { bucket: row.image_bucket, path: row.image_path };

  const thumbnail = thumbnailRefOrNull(original);
  if (thumbnail !== null && (await source.probe(thumbnail))) {
    const url = await source.sign(thumbnail);
    /** Requirement 12.6: signed, or nothing. The original is not reached from here. */
    return url === null ? null : { kind: 'thumbnail', url };
  }

  /** Requirement 12.10 — swept by policy, and no derivative survived it. */
  if (row.full_image_deleted_at !== null) return null;

  /** Requirement 12.7 — no derivative, original present. */
  const url = await source.sign(original);
  return url === null ? null : { kind: 'full', url };
}

/* ========================================================================== */
/* Ordering                                                                    */
/* ========================================================================== */

/**
 * Newest first (Requirement 12.1), with the id as a tie-break.
 *
 * The statement already orders on the same two keys, so this sort is normally a no-op — and it is
 * here anyway, because the statement lives at the call site. A caller that forgot `.order()`
 * would otherwise produce a list in whatever order PostgREST happened to return, which reads as
 * working software and is the one defect in this screen a farmer could not detect. Requirement
 * 12.1's ordering is therefore a property of this module rather than of a query written elsewhere.
 *
 * The id tie-break makes the order **total**: two rows written in the same microsecond would
 * otherwise sort differently between renders, and `sort` is stable only with respect to the input
 * order, which is not a thing this module controls.
 */
function newestFirst(left: HistoryRow, right: HistoryRow): number {
  const byTime = Date.parse(right.created_at) - Date.parse(left.created_at);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return right.id.localeCompare(left.id);
}

/* ========================================================================== */
/* Read                                                                        */
/* ========================================================================== */

export interface ReadHistoryInput {
  query: HistoryQuery;
  source: HistoryImageSource;
  /** The signed-in farmer. Logged on a failure; never used to authorize — RLS does that. */
  userId: string;
}

/**
 * The farmer's history, newest first, each entry carrying a signed URL for the object it should
 * load.
 *
 * An empty array is a **state, not an absence**: Requirement 12.4's empty screen is what the
 * caller renders for it, and it is the correct answer for a farmer who has sent nothing yet.
 *
 * A **query failure throws** rather than degrading to an empty list. The two are indistinguishable
 * on the screen, and "you have no results yet, send your first photo" is a lie to a farmer with
 * twenty results and a failed read — the one dishonest state available on this screen
 * (Requirement 15's whole subject). `INTERNAL_ERROR` carries the real cause to the server log,
 * where `toEnvelope` structurally cannot leak it (Requirement 15.6).
 *
 * The per-entry image work runs concurrently. Serially it would be up to `HISTORY_PAGE_SIZE`
 * round trips end to end, which is a visibly slow screen for a farmer on a rural connection; in
 * parallel it is one round trip's latency and the same number of calls.
 */
export async function readHistory({
  query,
  source,
  userId,
}: ReadHistoryInput): Promise<HistoryEntry[]> {
  const { data, error } = await query();

  if (error !== null) {
    throw new AppError('INTERNAL_ERROR', {
      cause: error,
      context: { reason: 'history_read_failed', userId },
    });
  }

  const rows = [...(data ?? [])].sort(newestFirst);

  return await Promise.all(
    rows.map(async (row): Promise<HistoryEntry> => ({
      id: row.id,
      /**
       * Requirement 6.5 and the `diagnoses_unknown_shape` constraint agree that an inconclusive
       * row carries no name, so `status` is what decides — and `disease_name` is read only on the
       * identified branch. Reading the name first and treating `null` as inconclusive would give
       * the same answer today and would silently mislabel a row if the two ever disagreed.
       */
      condition: row.status === 'unknown' ? null : row.disease_name,
      severity: row.severity,
      channel: row.channel,
      createdAt: row.created_at,
      image: await resolveHistoryImage(row, source),
    })),
  );
}

/**
 * ### What is deliberately NOT here
 *
 * **No retention arithmetic, and no import of `MEDIA_RETENTION_DAYS`.** The list never computes
 * whether an image *should* be gone; it reads whether it *is*. A view that recomputed the cutoff
 * would disagree with the sweep the first time the constant changed, and
 * `full_image_deleted_at` is the record of what actually happened (Requirement 18.7).
 *
 * **No paging cursor.** `HISTORY_PAGE_SIZE` bounds one render and Requirement 12 asks for a list,
 * not a pager. A cursor would need a farmer-facing control, its own copy in three catalogs, and a
 * decision about what "older" means across the retention boundary — none of which any requirement
 * calls for at six farmers.
 */
