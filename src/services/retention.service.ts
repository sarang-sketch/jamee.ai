import 'server-only';

import { MEDIA_RETENTION_DAYS, RETENTION_SWEEP_BATCH_LIMIT } from '@/lib/config/media';
import {
  deleteMediaById,
  deleteMediaForOwner,
  listMediaOfKindOlderThan,
} from '@/lib/db/media';
import { dueFullImageDiagnoses, stampFullImageDeleted } from '@/lib/db/retention';
import type { MediaKind } from '@/lib/db/names';

/**
 * `RetentionService` — the Retention_Sweep, ported off Supabase onto MongoDB / GridFS by Amendment
 * A3. The only thing in Jamee that deletes media a farmer did not just replace, and the only thing
 * that stamps `diagnoses.fullImageDeletedAt`.
 *
 * Requirements: 18.1 (the Retention_Window is a whole number of days read from ONE place), 18.3
 *               (delete every Full_Size_Image whose owning Diagnosis_Result predates the window),
 *               18.4 (delete every voice file older than the window), 18.5 (retain every
 *               Thumbnail_Derivative), 18.6 (delete NO row of `diagnoses`, `messages`,
 *               `conversations`, or `usage_logs`), 18.7 (record the deletion instant on the owning
 *               row and leave every other field unchanged), 18.8 (delete only files the owning row
 *               owns / whose own `metadata.ownerId` is present), 18.9 (deletions run server-side
 *               through the Data_Access_Layer), 18.10 (idempotent: each file at most once, an
 *               already-absent file counts as deleted), 18.11 (bounded per invocation), 8.10 (a
 *               voice file whose transcription failed ages out on this same window)
 * Design: "Media lifecycle and retention" → *How the sweep finds its work* (two scans), *Tenant
 *         isolation during deletion*; D17, D18, D19; Amendment A3; V29 (GridFS `uploadDate`,
 *         `bucket.delete`); Properties 31, 37
 *
 * =============================================================================
 * `import 'server-only'` IS PART OF THE REQUIREMENT, NOT A CONVENTION
 * =============================================================================
 *
 * Requirement 18.9's "every deletion runs from a server-side module" and 18.11's "only from a
 * server-side module" are the same clause read twice. Line 1 makes it mechanical: a `'use client'`
 * module that imported this file would be a BUILD error, so the sweep cannot be reached from a
 * browser bundle even by mistake. This module holds no secret and reads no `process.env`; every
 * deletion goes through the Data_Access_Layer (`src/lib/db/media.ts`, `src/lib/db/retention.ts`),
 * which under A3 is the ONLY holder of the driver (D18) — a stronger form of the old service-role
 * boundary, since a farmer session has no path to a GridFS delete at all.
 *
 * =============================================================================
 * TWO SCANS, AND UNDER A3 BOTH OF THEM RUN
 * =============================================================================
 *
 * **Scan 1 — document-driven (`sweepFullImages`).** Reads `diagnoses` documents where
 * `fullImageDeletedAt` is null and `createdAt` predates the window, deletes each document's
 * `mediaRef.fileId` from GridFS through the OWNER-SCOPED `deleteMediaForOwner` (which is itself the
 * Requirement 18.8 check — a file whose `metadata.ownerId` is not the row's owner is not deleted),
 * and stamps `fullImageDeletedAt`. This is the scan that keeps the history view honest and alone
 * satisfies 18.3 / 18.7 for every object a farmer can surface.
 *
 * **Scan 2 — age-driven orphan backstop (`sweepOrphans`).** A `crop-image` uploaded before its
 * diagnosis request failed has no `diagnoses` row, and a `voice` file whose transcription failed
 * has no `messages` row, so neither is reachable from scan 1. Scan 2 lists GridFS files of kind
 * `crop-image` and `voice` (never `thumbnail`, which is kept — Requirement 18.5) with
 * `uploadDate < cutoff`, re-reads each file's own `metadata.ownerId`, and deletes the remainder.
 *
 * **Scan 2 RUNS under A3.** The retired Supabase design shipped it switched off because U-V22b
 * could not confirm a usable object-age surface. GridFS files carry a built-in `uploadDate` (V29),
 * so the age filter is guaranteed present and scan 2 runs from day one — the whole reason A3
 * unblocks it. There is no feature flag and no injected age source anymore: the source is GridFS.
 *
 * =============================================================================
 * WHAT THIS MODULE CANNOT DO, BY CONSTRUCTION (Requirement 18.6)
 * =============================================================================
 *
 * No `diagnoses`, `messages`, `conversations`, or `usage_logs` DOCUMENT is deleted by any path
 * here. The Data_Access_Layer surface this module imports exposes exactly a bounded candidate read
 * and a single-field stamp on `diagnoses` (`src/lib/db/retention.ts`) and GridFS file deletes
 * (`src/lib/db/media.ts`) — there is no document-delete seam to travel through. A row is only ever
 * STAMPED, and `mediaRef` is left intact so the surviving Thumbnail_Derivative stays derivable.
 */

/* ========================================================================== */
/* The window (Requirement 18.1)                                               */
/* ========================================================================== */

/**
 * The instant a row or a file must predate to be swept.
 *
 * `MEDIA_RETENTION_DAYS` is read from `config/media.ts` and from nowhere else in this module, which
 * keeps Requirement 18.1's "readable from one place" true — and it is the same window that governs
 * a voice file whose transcription failed or returned empty (Requirement 8.10). One invocation uses
 * one instant for both scans rather than re-reading a clock per operation.
 *
 * A day is 24 fixed hours here — an elapsed-time window on stored bytes, not a calendar day (which
 * `src/lib/time.ts` owns for the quota window). Both instants are UTC and a few seconds of skew is
 * not observable against a window measured in days.
 */
export function retentionCutoff(now: Date, retentionDays: number = MEDIA_RETENTION_DAYS): Date {
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new Error(
      `retention window must be a whole number of days (Requirement 18.1); received ${retentionDays}. ` +
        'Change MEDIA_RETENTION_DAYS in src/lib/config/media.ts.',
    );
  }
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/* ========================================================================== */
/* Logging                                                                     */
/* ========================================================================== */

/**
 * `console.*`, for the reason `lib/errors.ts` gives: on the target platform that is what reaches the
 * runtime log. **No file id and no owner id is ever logged** — a `metadata.ownerId` is a farmer's
 * auth id, so it is PII. Counts and kinds are enough to read a sweep's outcome; the one case where
 * a specific document matters (a corrupt reference) reports the diagnosis id, which is not PII on
 * its own.
 */
function note(event: string, detail: Record<string, unknown>): void {
  console.info(`[jamee] retention.${event}`, JSON.stringify(detail));
}

function warn(event: string, detail: Record<string, unknown>): void {
  console.warn(`[jamee] retention.${event}`, JSON.stringify(detail));
}

/* ========================================================================== */
/* Reports                                                                     */
/* ========================================================================== */

export interface FullImageScanReport {
  /** Candidate documents read. `=== limit` means the batch was full and work remains. */
  readonly scanned: number;
  /** Full_Size_Images deleted from GridFS (an already-absent file counts here too — 18.10). */
  readonly removed: number;
  /** Rows stamped with the deletion instant (Requirement 18.7). */
  readonly stamped: number;
  /** Rows already stamped by an earlier/overlapping run — harmless (V21). */
  readonly alreadyStamped: number;
  /** Documents whose delete or stamp failed. Retried by the next run. */
  readonly failed: number;
  readonly limit: number;
  readonly bounded: boolean;
}

export interface OrphanScanReport {
  /** Files inspected across both kinds. */
  readonly scanned: number;
  /** Files deleted from GridFS. */
  readonly removed: number;
  /** Files whose own `metadata.ownerId` was missing — never deleted (Requirement 18.8). */
  readonly refused: number;
  /** Files whose delete failed. Retried by the next run. */
  readonly failed: number;
  readonly limit: number;
  readonly bounded: boolean;
}

export interface RetentionSweepReport {
  readonly retentionDays: number;
  readonly cutoff: string;
  readonly fullImages: FullImageScanReport;
  readonly orphans: OrphanScanReport;
}

/**
 * The Data_Access_Layer seams the sweep drives, all defaulting to the real GridFS / `diagnoses`
 * accessors. A test injects fakes so the sweep's logic runs with no live MongoDB; every default
 * here is a function `src/lib/db/**` exports, so this module imports no driver.
 */
export interface RetentionSweepDeps {
  /** Scan 1's candidate read. Defaults to `dueFullImageDiagnoses`. */
  readonly dueFullImages?: typeof dueFullImageDiagnoses;
  /** Scan 1's owner-scoped Full_Size_Image delete (the 18.8 check). Defaults to `deleteMediaForOwner`. */
  readonly deleteOwnedFile?: typeof deleteMediaForOwner;
  /** Scan 1's stamp. Defaults to `stampFullImageDeleted`. */
  readonly stamp?: typeof stampFullImageDeleted;
  /** Scan 2's age listing. Defaults to `listMediaOfKindOlderThan`. */
  readonly listAged?: typeof listMediaOfKindOlderThan;
  /** Scan 2's unscoped delete (after its own owner re-check). Defaults to `deleteMediaById`. */
  readonly deleteFileById?: typeof deleteMediaById;
  readonly now?: Date;
  readonly retentionDays?: number;
  /** Per-scan bound (Requirement 18.11). Defaults to `RETENTION_SWEEP_BATCH_LIMIT`. */
  readonly limit?: number;
}

type ResolvedDeps = Required<
  Pick<RetentionSweepDeps, 'dueFullImages' | 'deleteOwnedFile' | 'stamp' | 'listAged' | 'deleteFileById'>
> & { readonly now: Date; readonly retentionDays: number; readonly limit: number };

function resolve(deps: RetentionSweepDeps): ResolvedDeps {
  return {
    dueFullImages: deps.dueFullImages ?? dueFullImageDiagnoses,
    deleteOwnedFile: deps.deleteOwnedFile ?? deleteMediaForOwner,
    stamp: deps.stamp ?? stampFullImageDeleted,
    listAged: deps.listAged ?? listMediaOfKindOlderThan,
    deleteFileById: deps.deleteFileById ?? deleteMediaById,
    now: deps.now ?? new Date(),
    retentionDays: deps.retentionDays ?? MEDIA_RETENTION_DAYS,
    limit: deps.limit ?? RETENTION_SWEEP_BATCH_LIMIT,
  };
}

/* ========================================================================== */
/* Scan 1 — document-driven (Requirements 18.3, 18.7, 18.8, 18.10, 18.11)      */
/* ========================================================================== */

/**
 * Delete every Full_Size_Image whose `diagnoses` row predates the window, then stamp each row.
 *
 * Per candidate, in this order:
 *  1. **Delete the file OWNER-SCOPED** through `deleteMediaForOwner(ownerId, fileId)`. That call IS
 *     the Requirement 18.8 boundary: the owner is part of the GridFS lookup filter, so a file whose
 *     `metadata.ownerId` is not the row's owner is never deleted, and an already-absent file returns
 *     `false` too (indistinguishable — the idempotence property). Both a real delete and an
 *     already-absent file count as "the object is gone" (Requirement 18.10), which is what lets the
 *     row be stamped.
 *  2. **Stamp the row**, anchored on `_id` AND `ownerId` (Requirement 18.7). A row already stamped
 *     by an overlapping run reports `alreadyStamped`. A stamp that throws leaves the row unstamped
 *     so the next run finds it again.
 *
 * Delete-first / stamp-second is deliberate: a row stamped before its file was gone would tell the
 * history view "no longer stored" about a file still present.
 */
export async function sweepFullImages(deps: RetentionSweepDeps = {}): Promise<FullImageScanReport> {
  const d = resolve(deps);
  const cutoff = retentionCutoff(d.now, d.retentionDays);
  const candidates = await d.dueFullImages(cutoff, d.limit);

  let removed = 0;
  let stamped = 0;
  let alreadyStamped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      // Owner-scoped delete — the 18.8 check and the 18.10 idempotence in one call.
      await d.deleteOwnedFile(candidate.ownerId, candidate.fileId);
      removed += 1;
    } catch (cause) {
      failed += 1;
      warn('full_image_delete_failed', { diagnosisId: candidate.diagnosisId.toHexString() });
      console.error(
        '[jamee] retention.full_image_delete_failed_cause',
        cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
      );
      continue;
    }

    try {
      const didStamp = await d.stamp(candidate.diagnosisId, candidate.ownerId, d.now);
      if (didStamp) stamped += 1;
      else alreadyStamped += 1;
    } catch (cause) {
      failed += 1;
      warn('stamp_failed', { diagnosisId: candidate.diagnosisId.toHexString() });
      console.error(
        '[jamee] retention.stamp_failed_cause',
        cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
      );
    }
  }

  return {
    scanned: candidates.length,
    removed,
    stamped,
    alreadyStamped,
    failed,
    limit: d.limit,
    bounded: candidates.length >= d.limit,
  };
}

/* ========================================================================== */
/* Scan 2 — the age-driven orphan backstop (Requirements 18.4, 18.5, 18.8)     */
/* ========================================================================== */

/** The kinds scan 2 sweeps. `thumbnail` is deliberately ABSENT — it is kept forever (18.5). */
const ORPHAN_KINDS: readonly MediaKind[] = ['crop-image', 'voice'];

/**
 * Delete GridFS files of kind `crop-image` and `voice` older than the window that no scan-1 stamp
 * reached — the orphan backstop (Requirements 18.4, 8.10).
 *
 *  - **`thumbnail` is never listed**, so every Thumbnail_Derivative is kept (Requirement 18.5).
 *  - **A file with no `metadata.ownerId` is refused, never deleted** (Requirement 18.8): scan 2's
 *    only tenant anchor is the file's own owner metadata, and a file that cannot be attributed to a
 *    farmer is left in place and counted.
 *  - **The listing already filters `uploadDate < cutoff`**, and this defensively re-checks it, so a
 *    file inside the window is never deleted even if the listing returned it.
 *  - **Deletion is by id after the owner re-check**, through `deleteMediaById`; an already-absent
 *    file is normalized to "deleted" (Requirement 18.10).
 *
 * Bounded by `limit` across both kinds together (Requirement 18.11): once the budget is spent the
 * scan stops and the next run picks up the rest.
 */
export async function sweepOrphans(deps: RetentionSweepDeps = {}): Promise<OrphanScanReport> {
  const d = resolve(deps);
  const cutoff = retentionCutoff(d.now, d.retentionDays);

  let scanned = 0;
  let removed = 0;
  let refused = 0;
  let failed = 0;
  let budget = d.limit;

  for (const kind of ORPHAN_KINDS) {
    if (budget <= 0) break;

    const files = await d.listAged(kind, cutoff, budget);
    scanned += files.length;

    for (const file of files) {
      if (budget <= 0) break;
      // The listing is asked for files older than the cutoff; it is not trusted to have honoured it.
      if (file.uploadDate.getTime() >= cutoff.getTime()) continue;
      // Requirement 18.8: no owner anchor ⇒ not deletable.
      if (file.ownerId === null || file.ownerId === '') {
        refused += 1;
        warn('orphan_refused', { kind, reason: 'no_owner_metadata' });
        continue;
      }

      budget -= 1;
      try {
        await d.deleteFileById(file.fileId);
        removed += 1;
      } catch (cause) {
        failed += 1;
        warn('orphan_delete_failed', { kind });
        console.error(
          '[jamee] retention.orphan_delete_failed_cause',
          cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
        );
      }
    }
  }

  return { scanned, removed, refused, failed, limit: d.limit, bounded: budget <= 0 };
}

/* ========================================================================== */
/* The invocation                                                              */
/* ========================================================================== */

/**
 * One sweep: scan 1, then scan 2.
 *
 * **Safe to run late, twice, or several times in a row** (V21 records this as the platform's cron
 * contract, not a nicety): nothing accumulates state between runs — scan 1's `fullImageDeletedAt:
 * null` predicate excludes what a previous run stamped, and an already-absent GridFS delete counts
 * as deleted — so a doubled run does the leftover half and a missed run costs bucket headroom,
 * which the retention arithmetic reserves 25% for.
 *
 * Both scans are bounded by the same `limit`, so leftover work waits for the next invocation rather
 * than stretching this one (Requirement 18.11).
 */
export async function runRetentionSweep(deps: RetentionSweepDeps = {}): Promise<RetentionSweepReport> {
  const d = resolve(deps);
  const cutoff = retentionCutoff(d.now, d.retentionDays);

  const fullImages = await sweepFullImages(d);
  const orphans = await sweepOrphans(d);

  const report: RetentionSweepReport = {
    retentionDays: d.retentionDays,
    cutoff: cutoff.toISOString(),
    fullImages,
    orphans,
  };
  note('sweep_complete', { ...report });
  return report;
}
