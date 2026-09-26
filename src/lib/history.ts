import 'server-only';

import { type ProtectedScreenPath } from '@/lib/auth/protected-paths';
import type { DiagnosisDoc } from '@/lib/db/collections';
import { farmerReads, type DiagnosisRecord, type FarmerReads } from '@/lib/db/reads';
import { AppError } from '@/lib/errors';
import { mediaUrl } from '@/lib/media/url';
import type { Channel, Severity, VerifiedCondition } from '@/lib/schemas';

/**
 * Everything the history screen decides, separated from how it renders.
 *
 * Requirements: 12.1 (an authenticated Farmer's Diagnosis_Results listed reverse-chronologically
 *               with the crop image thumbnail, the reported condition or the inconclusive label,
 *               the Severity_Value, the channel, and the creation timestamp), 12.2 (Telegram
 *               Diagnosis_Results are in that list), 12.4 (an empty list invites a first upload),
 *               12.5 (a stored image or thumbnail is loaded through the Media_Endpoint, Amendment
 *               A3), 12.6 (an entry whose Thumbnail_Derivative is present loads that derivative
 *               and NO Full_Size_Image), 12.7 (an entry with no derivative and a present original
 *               renders the original), 12.10 (an entry whose original was swept and has no
 *               derivative renders without an image and says so), 13.2 (own rows only),
 *               9.4 (a Canonical_Disease_Name is never translated)
 * Design: "Frontend" — `/history` is a server component reading through the Data_Access_Layer
 *          (D18); "Media lifecycle and retention" — mechanism 2, *read a derivative for list views*;
 *          D17, D18
 *
 * =============================================================================
 * AMENDMENT A3 — THE READ AND THE IMAGE URL BOTH CHANGE SUBSTRATE
 * =============================================================================
 *
 * Under Supabase this screen read `diagnoses` through the RLS-scoped client and minted a
 * Signed_URL per image over a private bucket, deriving the thumbnail path by convention and
 * probing storage for presence. Under A3 there is neither RLS nor Storage:
 *
 *  - **The read is one owner-scoped Data_Access_Layer accessor.** `farmerReads(userId)` binds the
 *    owner and `listDiagnoses(HISTORY_PAGE_SIZE)` returns this farmer's newest diagnoses; the
 *    owner merge is `farmer.ts`'s single point, so this module cannot express an unscoped read
 *    (D18). No `.eq('user_id', …)` to remember and no channel filter — that absence IS Requirement
 *    12.2, a `telegram` diagnosis is this owner's row and comes back on the same footing as a
 *    `web` one.
 *  - **The image URL is `mediaUrl(fileId)`**, the constant `/api/media/<fileId>` (`src/lib/media/url.ts`),
 *    not a minted, expiring Signed_URL. The owner check moved to the Media_Endpoint, which
 *    confirms `metadata.ownerId` before it streams a byte (Requirement 2.6), so this module builds
 *    URLs for a whole page with no I/O and no secret.
 *  - **Thumbnail presence is a stored link, not a derived path + a probe.** A Thumbnail_Derivative
 *    is a separate GridFS file whose `metadata.sourceRef` points at its Full_Size_Image
 *    (Requirement 2.13, A3). `FarmerReads.thumbnailFileIdFor(fullImageFileId)` resolves it, owner-
 *    scoped, returning the derivative's file id or `null`. That replaces both `thumbRefFor()` and
 *    the per-row `exists()` probe.
 *
 * ### Why this is a module in `lib/` and not the page body
 *
 * Two of the three decisions here are worth asserting directly, and neither needs React to be
 * true: which image each entry reads, and what order the entries come back in. An `async` server
 * component is not a unit-testable function, so the page hands `readHistory` the reads and takes
 * back resolved entries, and `history.test.ts` covers the branches without a request, a cookie
 * store, or a database.
 *
 * ### Why the list's image rule is NOT the detail view's image rule
 *
 * They are two different requirements pointing opposite ways, and collapsing them into one
 * "resolve an image" helper would break whichever one lost:
 *
 *  - **The list prefers the thumbnail** (Requirement 12.6) and is forbidden from loading the
 *    original when a derivative exists — mechanism 2 of the media-lifecycle amendment: 20 entries
 *    at ~25 KB instead of 20 at ~400 KB, measured against Atlas M0's ~512 MB cluster storage.
 *  - **The detail view prefers the original** (Requirement 12.8), because that screen is where a
 *    farmer looks closely at a lesion.
 *
 * What the two share is the primitive — `mediaUrl(fileId)` from `src/lib/media/url.ts`, the single
 * source of the `/api/media/<fileId>` convention (Requirement 2.13, A3).
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
 * `encodeURIComponent` on a value that is always a diagnosis id is not defensive theatre about the
 * database — it is what keeps this function correct if it is ever handed an id from somewhere
 * other than a `diagnoses` document's `_id`.
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
 * 20 is the figure the design's storage arithmetic is written against ("a history screen of 20
 * entries reads 20 thumbnails, not 20 full-size originals"), and it is also one day of image
 * quota (Requirement 14.1) — so a farmer's most recent day of work fits on the screen without
 * paging. It bounds the thumbnails the browser fetches and the thumbnail lookups this module
 * issues.
 */
export const HISTORY_PAGE_SIZE = 20;

/* ========================================================================== */
/* The view model                                                              */
/* ========================================================================== */

/**
 * Which derivative an entry's thumbnail slot is showing.
 *
 * Rendered nowhere — the two look identical in the list, by design. It exists so the unit test can
 * assert Requirement 12.6 as a fact about *which file was addressed* rather than by inspecting a
 * URL string, and so a future change that started loading originals for every row would break a
 * test instead of a storage budget.
 */
export type HistoryImageKind = 'thumbnail' | 'full';

export interface HistoryImage {
  readonly kind: HistoryImageKind;
  /** Requirement 12.5 — always the Media_Endpoint URL, `/api/media/<fileId>` (Amendment A3). */
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
 * `image: null` is Requirement 12.10 — the original was swept and no derivative survives, which is
 * an ordinary state for a Telegram-originated entry past the retention window.
 */
export interface HistoryEntry {
  readonly id: string;
  /** Canonical, Latin script, never translated (Requirements 4.6, 9.4). */
  readonly condition: VerifiedCondition | null;
  readonly severity: Severity;
  /** Requirement 12.2 — `telegram` entries are in this list on the same footing as `web` ones. */
  readonly channel: Channel;
  /** The stored creation instant as ISO-8601, formatted for display by the component. */
  readonly createdAt: string;
  readonly image: HistoryImage | null;
}

/* ========================================================================== */
/* Which image an entry reads (Requirements 12.5, 12.6, 12.7, 12.10)           */
/* ========================================================================== */

/**
 * The one file this entry's thumbnail slot loads, or `null`.
 *
 * ### The order, and what each step is allowed to conclude
 *
 * 1. **The thumbnail is resolved first, and a hit ends it.** Requirement 12.6 is not a preference,
 *    it is a prohibition: load the derivative and load *no* Full_Size_Image for that entry. The
 *    derivative is found by its stored `metadata.sourceRef` link (Amendment A3), owner-scoped, so
 *    the original's URL is never built on this branch — the browser cannot fetch a URL that was
 *    not produced. This holds even after the sweep, since a thumbnail is never deleted
 *    (Requirement 18.5).
 * 2. **`fullImageDeletedAt != null` ends it too.** The sweep stamped the document (Requirement
 *    18.7), so the original is gone by policy and there is nothing to address — Requirement 12.10.
 * 3. **Otherwise the original is the fallback** (Requirement 12.7). A `diagnoses` document exists
 *    only because an upload succeeded first, and `fullImageDeletedAt == null` is the document's own
 *    statement that the Full_Size_Image is still there, so its URL is built from `mediaRef.fileId`.
 *    No probe: the Media_Endpoint is the one owner check, and a URL to a file that briefly cannot
 *    be read degrades to that endpoint's own answer rather than to a fourth state here.
 */
export async function resolveHistoryImage(
  row: Pick<DiagnosisDoc, 'mediaRef' | 'fullImageDeletedAt'>,
  reads: Pick<FarmerReads, 'thumbnailFileIdFor'>,
): Promise<HistoryImage | null> {
  const fullImageFileId = row.mediaRef.fileId.toHexString();

  const thumbnailFileId = await reads.thumbnailFileIdFor(fullImageFileId);
  if (thumbnailFileId !== null) {
    /** Requirement 12.6: the derivative, and the original is not addressed from here. */
    return { kind: 'thumbnail', url: mediaUrl(thumbnailFileId) };
  }

  /** Requirement 12.10 — swept by policy, and no derivative survived it. */
  if (row.fullImageDeletedAt !== null && row.fullImageDeletedAt !== undefined) return null;

  /** Requirement 12.7 — no derivative, original present. */
  return { kind: 'full', url: mediaUrl(fullImageFileId) };
}

/* ========================================================================== */
/* Read                                                                        */
/* ========================================================================== */

export interface ReadHistoryInput {
  /**
   * The owner-scoped read bundle. Defaults to `farmerReads(userId)` — the production path — so a
   * caller passes only `userId`; a unit test passes its own `reads` and states thumbnail presence
   * as data.
   */
  reads?: Pick<FarmerReads, 'listDiagnoses' | 'thumbnailFileIdFor'> | undefined;
  /** The signed-in farmer. The owner every read is scoped to, and logged on a failure. */
  userId: string;
}

/**
 * The farmer's history, newest first, each entry carrying the Media_Endpoint URL for the file it
 * should load.
 *
 * An empty array is a **state, not an absence**: Requirement 12.4's empty screen is what the caller
 * renders for it, and it is the correct answer for a farmer who has sent nothing yet.
 *
 * A **read failure throws** rather than degrading to an empty list. The two are indistinguishable
 * on the screen, and "you have no results yet, send your first photo" is a lie to a farmer with
 * twenty results and a failed read — the one dishonest state available on this screen (Requirement
 * 15's whole subject). `INTERNAL_ERROR` carries the real cause to the server log, where
 * `toEnvelope` structurally cannot leak it (Requirement 15.6). The Data_Access_Layer throws on a
 * real failure, so this wrapper turns that into the taxonomy code with the cause logged server-side.
 *
 * The per-entry thumbnail lookups run concurrently. Serially they would be up to `HISTORY_PAGE_SIZE`
 * round trips end to end, which is a visibly slow screen on a rural connection; in parallel it is
 * one round trip's latency and the same number of calls.
 */
export async function readHistory({
  reads,
  userId,
}: ReadHistoryInput): Promise<HistoryEntry[]> {
  const bundle = reads ?? farmerReads(userId);

  let rows: readonly DiagnosisRecord[];
  try {
    rows = await bundle.listDiagnoses(HISTORY_PAGE_SIZE);
  } catch (cause) {
    throw new AppError('INTERNAL_ERROR', {
      cause,
      context: { reason: 'history_read_failed', userId },
    });
  }

  return await Promise.all(
    rows.map(async (row): Promise<HistoryEntry> => ({
      id: row._id.toHexString(),
      /**
       * Requirement 6.5 and the `diagnoses_unknown_shape` validator agree that an inconclusive
       * document carries no name, so `status` is what decides — and `diseaseName` is read only on
       * the identified branch. Reading the name first and treating a nullish value as inconclusive
       * would give the same answer today and would silently mislabel a document if the two ever
       * disagreed.
       */
      condition: row.status === 'unknown' ? null : (row.diseaseName ?? null),
      severity: row.severity,
      channel: row.channel,
      createdAt: row.createdAt.toISOString(),
      image: await resolveHistoryImage(row, bundle),
    })),
  );
}

/**
 * ### What is deliberately NOT here
 *
 * **No retention arithmetic, and no import of `MEDIA_RETENTION_DAYS`.** The list never computes
 * whether an image *should* be gone; it reads whether it *is*. A view that recomputed the cutoff
 * would disagree with the sweep the first time the constant changed, and `fullImageDeletedAt` is
 * the record of what actually happened (Requirement 18.7).
 *
 * **No ordering re-sort.** `listDiagnoses` orders `createdAt` desc with `_id` desc as the total
 * tiebreak, served by the `owner_recent` index (`setup.ts`), so newest-first (Requirement 12.1) is
 * a property of the accessor rather than of a sort re-applied here.
 *
 * **No paging cursor.** `HISTORY_PAGE_SIZE` bounds one render and Requirement 12 asks for a list,
 * not a pager. A cursor would need a farmer-facing control, its own copy in three catalogs, and a
 * decision about what "older" means across the retention boundary — none of which any requirement
 * calls for at six farmers.
 */
