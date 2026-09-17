import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  MEDIA_RETENTION_DAYS,
  RETENTION_ORPHAN_SCAN_ENABLED,
  RETENTION_SWEEP_BATCH_LIMIT,
} from '@/lib/config/media';
import { STORAGE_BUCKETS, type StorageBucket } from '@/lib/config/verified';
import { AppError } from '@/lib/errors';
import { isThumbPath, ownerSegmentOf } from '@/lib/storage';
import type { Database } from '@/types/database';
import type { ObjectRemoveClient } from '@/services/voice.service';

/**
 * `RetentionService` — the Retention_Sweep. The only thing in Jamee that deletes an object a
 * farmer did not just replace, and the only thing that stamps `diagnoses.full_image_deleted_at`.
 *
 * Requirements: 18.1 (the Retention_Window is a whole number of days read from ONE place),
 *               18.3 (delete every Full_Size_Image whose owning Diagnosis_Result is older than the
 *               window), 18.4 (delete every `voice-messages` object written before the window),
 *               18.5 (retain every Thumbnail_Derivative), 18.6 (delete NO row of `diagnoses`,
 *               `messages`, `conversations`, or `usage_logs`), 18.7 (record the deletion instant on
 *               the owning row and leave every other column unchanged), 18.8 (delete only under the
 *               path prefix of the farmer who owns the referencing row), 18.9 (every deletion from a
 *               server-side module with the Service_Role_Key), 18.10 (idempotent: each object at
 *               most once, an already-absent object counts as deleted), 18.11 (bounded per
 *               invocation, inside the duration ceiling), 8.10 (a voice object whose transcription
 *               failed or came back empty ages out on this same window)
 * Design: "Media lifecycle and retention" → *What is deleted, when, and by whom*, *How the sweep
 *         finds its work*, *RLS, storage policies, and why the application check is the boundary*
 * Depends on: V21 (the trigger is a platform cron GET, best-effort in both directions),
 *             V22 (`remove(paths)` takes a batch and returns entries for the deleted files;
 *             U-V22a — its behaviour on an absent path is unresolved; U-V22b — no confirmed
 *             object-age surface, which is why scan 2 ships switched off)
 *
 * =============================================================================
 * `import 'server-only'` IS PART OF THE REQUIREMENT, NOT A CONVENTION
 * =============================================================================
 *
 * Requirement 18.9 says every deletion runs from a server-side module using the Service_Role_Key,
 * and Requirement 18.11's "only from a server-side module" is the same clause read again. Line 1
 * makes that mechanical: a `'use client'` module that imported this file would be a BUILD error, so
 * the sweep cannot be reached from a browser bundle even by mistake. `createAdminClient()` carries
 * the same marker; this module holds no secret of its own and reads no `process.env`.
 *
 * =============================================================================
 * TWO SCANS, AND ONLY ONE OF THEM RUNS TODAY
 * =============================================================================
 *
 * **Scan 1 — row-driven (`sweepFullImages`).** Reads candidate rows off `diagnoses` through the
 * partial `diagnoses_retention_idx` from migration 0005, deletes each row's Full_Size_Image, and
 * stamps `full_image_deleted_at`. This is the scan that keeps the history view honest, and it alone
 * satisfies Requirements 18.3 and 18.7 for **every object a farmer can surface**.
 *
 * **Scan 2 — age-driven orphan backstop (`sweepOrphans`).** An image uploaded before its diagnosis
 * request failed has no `diagnoses` row, and a voice object whose transcription failed has no
 * `messages` row, so neither is reachable from scan 1. Scan 2 reads object ages for both buckets,
 * keeps every Thumbnail_Derivative, and deletes the remainder past the window.
 *
 * **Scan 2 is switched off** behind `RETENTION_ORPHAN_SCAN_ENABLED` in `config/media.ts`, because
 * **U-V22b** could not confirm that the storage schema exposes a creation timestamp usable for age
 * filtering. It is implemented and tested here, and it is not called. Turning it on means resolving
 * V22, injecting an `OrphanObjectSource`, and flipping one flag — and if the flag is on with no
 * surface available, `runRetentionSweep` **throws** rather than reporting a clean sweep that swept
 * nothing (see `sweepOrphans`).
 *
 * =============================================================================
 * WHAT THIS MODULE CANNOT DO, BY CONSTRUCTION (Requirement 18.6)
 * =============================================================================
 *
 * No row of `diagnoses`, `messages`, `conversations` or `usage_logs` is deleted by any path here.
 * That is not a promise in a comment: `RetentionStore` exposes exactly two operations — a bounded
 * candidate read and a single-column stamp — so there is no seam a delete could travel through, and
 * `retention.service.test.ts` asserts structurally that this module contains no `.delete(` and no
 * `.rpc(` at all, and names no farmer-scoped table other than `diagnoses`. A row is only ever
 * *stamped*, and `image_path` is deliberately left intact so the surviving Thumbnail_Derivative stays
 * derivable (Requirements 18.5, 2.13).
 *
 * =============================================================================
 * WHY THE CANDIDATE READ IS THE ONE STATEMENT IN JAMEE WITHOUT A `user_id` PREDICATE
 * =============================================================================
 *
 * `admin.ts`'s rule is that every service-role query carries an explicit `user_id` predicate. The
 * sweep is the one operation in the product whose *purpose* is tenant-independent: it ages out media
 * for the whole deployment, so a farmer-scoped candidate read could not express it, and there is no
 * tenant-free source of farmer ids in this schema to loop over. The same class already exists on the
 * quota side — migration 0007's `counter_prune_minute_windows` prunes expired windows across all
 * farmers by age — so this is a known shape rather than a new one.
 *
 * What replaces the predicate is **two anchors on the acting end**, both of them per row:
 *
 *  1. **The path's first segment must equal the row's own `user_id`** (`assertPathOwnedByRow`), and
 *     a mismatch is a hard error that stops the scan rather than a skipped row — the design's words.
 *     A mismatch means the path convention or the row is corrupt, and continuing would risk deleting
 *     across tenants (Requirement 18.8).
 *  2. **The stamp is anchored on `id` AND `user_id`** (`retentionStoreFrom`), so even a corrupt
 *     candidate list cannot write to a row that does not belong to the farmer it was read for.
 *
 * `scripts/check-secret-scope.ts` sees the candidate read and declares it in
 * `TENANT_INDEPENDENT_STATEMENTS`, with the reason — so the exemption is printed in every CI run
 * instead of living here as a claim.
 */

/* ========================================================================== */
/* The window (Requirement 18.1)                                               */
/* ========================================================================== */

/**
 * The instant a row or an object must predate to be swept.
 *
 * `MEDIA_RETENTION_DAYS` is read from `config/media.ts` and from nowhere else in this module, which
 * is what keeps Requirement 18.1's "readable from one place" true — and it is the same window that
 * governs a voice object whose transcription failed or returned empty (Requirement 8.10,
 * `VOICE_FAILURE_GRACE_DAYS`, which is defined as this constant rather than as a second number).
 *
 * The design's SQL writes this as `now() - (retention_days || ' days')::interval`. Computing it here
 * instead, from an injectable `now`, buys two things and costs nothing measurable: the cutoff is a
 * plain value a unit test can pin without a database, and one invocation uses one instant for both
 * scans rather than re-reading a clock per statement. Both clocks are UTC — `toISOString()` by
 * definition, `now()` by Supabase's default — and a few seconds of skew is not observable against a
 * window measured in days.
 *
 * A day is 24 fixed hours here. Not `Asia/Kolkata` calendar arithmetic: `src/lib/time.ts` owns that
 * clock because the quota window is a *calendar* day a farmer experiences (Requirement 14.1),
 * whereas this is an elapsed-time window on stored bytes. Mixing the two would make a DST-free
 * timezone's midnight a factor in how long an image survives.
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
/* Seams                                                                       */
/* ========================================================================== */

/** One row of scan 1's candidate list — exactly the four columns the design's query names. */
export interface FullImageCandidate {
  readonly id: string;
  readonly userId: string;
  /** `image_bucket`, which migration 0005 constrains to `crop-images`. */
  readonly bucket: string;
  /** `image_path`: `{user_id}/{YYYY}/{MM}/{uuid}.{ext}`. */
  readonly path: string;
}

/**
 * The database seam. **Two operations, and deliberately no third.**
 *
 * A `deleteRow`, a `purge`, or a generic `update` here would be the seam Requirement 18.6 forbids,
 * so the narrowness is the enforcement rather than a convenience. `retentionStoreFrom()` binds both
 * to a real client; every test drives the sweep through a fake that records what it was asked.
 */
export interface RetentionStore {
  /**
   * Scan 1's candidate read: rows whose original is still stored and whose `created_at` predates
   * the cutoff, oldest first, at most `limit` of them.
   *
   * `full_image_deleted_at is null` is what makes a re-run harmless (Requirement 18.10): anything a
   * previous run stamped is already outside this result set.
   */
  dueFullImages(input: {
    readonly cutoff: Date;
    readonly limit: number;
  }): Promise<readonly FullImageCandidate[]>;

  /**
   * Requirement 18.7: record the deletion instant on the owning row, leaving every other column
   * unchanged. Returns `true` when a row was stamped and `false` when none matched — which is the
   * already-stamped case, not a failure.
   */
  stampFullImageDeleted(input: {
    readonly id: string;
    readonly userId: string;
    readonly deletedAt: Date;
  }): Promise<boolean>;
}

/** One object as scan 2's age surface reports it. */
export interface StoredObject {
  readonly bucket: StorageBucket;
  /** Bucket-relative, exactly as `remove()` takes it (V22): `{user_id}/…`, never `bucket/…`. */
  readonly path: string;
  readonly createdAt: Date;
}

/**
 * Scan 2's candidate surface — **U-V22b, and there is no implementation of it in Jamee.**
 *
 * No page could be found documenting the `storage.objects` column set or a `FileObject` creation
 * timestamp usable as a queryable age filter, so this interface states the shape the scan needs
 * without pretending to know how to satisfy it. When V22 resolves, one adapter implements this
 * against whatever the storage schema actually exposes, and nothing else changes.
 */
export interface OrphanObjectSource {
  olderThan(input: {
    readonly bucket: StorageBucket;
    readonly cutoff: Date;
    readonly limit: number;
  }): Promise<readonly StoredObject[]>;
}

/* ========================================================================== */
/* Reports                                                                     */
/* ========================================================================== */

export interface FullImageScanReport {
  /** Candidate rows read. `=== limit` means the batch was full and work remains for the next run. */
  readonly scanned: number;
  /** Objects storage reported as deleted by this run. */
  readonly removed: number;
  /** Requested paths storage did not report back: already gone, which counts as deleted (18.10). */
  readonly alreadyAbsent: number;
  /** Rows stamped with the deletion instant (Requirement 18.7). */
  readonly stamped: number;
  /** Rows already stamped by an earlier run — a doubled cron delivery, and harmless (V21). */
  readonly alreadyStamped: number;
  /** Rows whose object could not be deleted, or whose stamp failed. Retried by the next run. */
  readonly failed: number;
  readonly limit: number;
  readonly bounded: boolean;
}

export type OrphanScanReport =
  /** The shipped state: U-V22b is open, so the backstop does not run. */
  | { readonly ran: false; readonly reason: 'disabled_pending_v22b' }
  | {
      readonly ran: true;
      readonly scanned: number;
      /** Requirement 18.5 — Thumbnail_Derivatives seen and deliberately kept. */
      readonly retainedThumbnails: number;
      readonly removed: number;
      readonly alreadyAbsent: number;
      /** Paths with no usable owner segment. Never deleted (Requirement 18.8). */
      readonly refused: number;
      readonly failed: number;
      readonly limit: number;
      readonly bounded: boolean;
    };

export interface RetentionSweepReport {
  readonly retentionDays: number;
  readonly cutoff: string;
  readonly fullImages: FullImageScanReport;
  readonly orphans: OrphanScanReport;
}

export interface RetentionSweepDeps {
  /** Defaults to `retentionStoreFrom(createAdminClient())`, built on first use. */
  readonly store?: RetentionStore;
  /** The deleter. Defaults to the service-role client (Requirement 18.9). */
  readonly remover?: ObjectRemoveClient;
  /** Scan 2's age surface. Absent while U-V22b is open. */
  readonly orphans?: OrphanObjectSource;
  readonly now?: Date;
  readonly retentionDays?: number;
  /** Per-scan bound (Requirement 18.11). Defaults to `RETENTION_SWEEP_BATCH_LIMIT`. */
  readonly limit?: number;
  /** Defaults to `RETENTION_ORPHAN_SCAN_ENABLED`. A test turns scan 2 on without shipping it on. */
  readonly orphanScanEnabled?: boolean;
}

/* ========================================================================== */
/* Logging                                                                     */
/* ========================================================================== */

/**
 * `console.*`, for the reason `lib/errors.ts` and the WhatsApp route give: on the target platform
 * that is what reaches the runtime log.
 *
 * **No object path and no user id is ever logged.** A path's first segment *is* a farmer's auth id,
 * so a path in a log line is farmer PII by another name. Counts and buckets are enough to read a
 * sweep's outcome, and a mismatch — the one case where the shape of a path matters — reports the
 * row id instead, which is not PII on its own.
 */
function note(event: string, detail: Record<string, unknown>): void {
  console.info(`[jamee] retention.${event}`, JSON.stringify(detail));
}

function warn(event: string, detail: Record<string, unknown>): void {
  console.warn(`[jamee] retention.${event}`, JSON.stringify(detail));
}

/* ========================================================================== */
/* Deletion (Requirements 18.8, 18.9, 18.10)                                   */
/* ========================================================================== */

/**
 * Requirement 18.8, checked before anything reaches the network.
 *
 * The design is explicit that a mismatch is **a hard error, not a skipped row**: it means either the
 * path convention or the row is corrupt, and a sweep that shrugged and moved on would be one bad
 * row away from deleting across tenants. So this throws, `sweepFullImages` lets it propagate, and
 * the invocation ends having deleted nothing further — which the idempotent design makes safe to
 * repeat once the corruption is understood.
 *
 * The thrown `AppError` carries the row id and the offending segment in `context`, which
 * `src/lib/errors.ts` writes to the server log and structurally cannot put in a response body.
 */
export function assertPathOwnedByRow(candidate: FullImageCandidate): void {
  const owner = ownerSegmentOf(candidate.path);
  if (owner === candidate.userId) return;

  throw new AppError('INTERNAL_ERROR', {
    context: {
      reason: 'retention_path_owner_mismatch',
      diagnosisId: candidate.id,
      bucket: candidate.bucket,
      // The row's own two values, which are the evidence. Neither is another farmer's identifier:
      // a mismatch here means the row disagrees with itself.
      rowUserId: candidate.userId,
      pathOwnerSegment: owner ?? '(none)',
    },
  });
}

/**
 * Requirement 18.8 for scan 2, whose candidates come from storage rather than from a row, so the
 * only anchor available is the path's own first segment.
 *
 * A path is deletable only if it has a non-empty first segment **and** something after it. That
 * rules out a bucket-root object (`stray.jpg`) and a path whose owner segment is empty (`/a.jpg`) —
 * neither can be attributed to a farmer, and "delete only under `{first_segment}/`" has no meaning
 * for either. They are refused and counted, never deleted.
 */
export function orphanOwnerSegment(path: string): string | undefined {
  const owner = ownerSegmentOf(path);
  if (owner === undefined || owner === '') return undefined;
  const remainder = path.slice(owner.length + 1);
  return remainder.length > 0 ? owner : undefined;
}

/** The outcome of one batched `remove()` call, with U-V22a normalized away. */
interface RemoveOutcome {
  /** Paths storage reported back as deleted. */
  readonly removed: readonly string[];
  /** Requested paths storage did not report: already absent, which counts as deleted (18.10). */
  readonly absent: readonly string[];
  /** Set when the call itself failed. Nothing in the batch is treated as deleted. */
  readonly error?: unknown;
}

/**
 * The names in a `remove()` response, reading **only `name`** and nothing else.
 *
 * V22's reference page warns that deprecated `FileObject` fields such as `bucket_id` "may or may not
 * be present — do not rely on them", so this reads the one field the page documents for the deleted
 * entries and ignores the rest of the shape entirely. Anything that is not an array of objects with
 * a string `name` yields no names, which lands every requested path in `absent` — the
 * success-equivalent branch — rather than throwing on a response shape.
 */
function removedNamesOf(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const names: string[] = [];
  for (const entry of data) {
    if (entry !== null && typeof entry === 'object' && 'name' in entry) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === 'string' && name.length > 0) names.push(name);
    }
  }
  return names;
}

/**
 * Delete a batch of objects from one bucket with the service role, and normalize the outcome.
 *
 * **U-V22a — whether `remove()` errors on a path that does not exist — cannot change what happens
 * here.** A path missing from the returned entries is classified `absent`, which the callers treat
 * exactly as deleted, because Requirement 18.10 says an object that is already absent *is* deleted.
 * The response array is never required to be the same length as the request.
 *
 * A thrown or returned error, on the other hand, is a failure of the whole batch: nothing is
 * reported as deleted, no row is stamped, and the next run picks the work up again. That ordering —
 * delete first, stamp only what the delete accounted for — is what keeps a stamped row from ever
 * claiming an object is gone while it is still in the bucket.
 */
export async function removeObjects(
  remover: ObjectRemoveClient,
  bucket: string,
  paths: readonly string[],
): Promise<RemoveOutcome> {
  if (paths.length === 0) return { removed: [], absent: [] };

  try {
    const { data, error } = await remover.storage.from(bucket).remove([...paths]);
    if (error !== null && error !== undefined) {
      return { removed: [], absent: [], error };
    }
    const reported = new Set(removedNamesOf(data));
    return {
      removed: paths.filter((path) => reported.has(path)),
      absent: paths.filter((path) => !reported.has(path)),
    };
  } catch (cause) {
    return { removed: [], absent: [], error: cause };
  }
}

/* ========================================================================== */
/* Scan 1 — row-driven (Requirements 18.3, 18.7)                                */
/* ========================================================================== */

/**
 * Delete every Full_Size_Image whose `diagnoses` row predates the window, then stamp each row.
 *
 * The order within one invocation, and why each step is where it is:
 *
 *  1. **Read at most `limit` candidates**, oldest first, off the partial retention index.
 *  2. **Assert every candidate's path against its own `user_id`, before any delete is issued.**
 *     Checking the whole batch first means a corrupt row stops the run without a single deletion
 *     having happened — strictly stronger than Requirement 18.8, and cheaper to reason about than a
 *     half-swept batch.
 *  3. **One `remove()` call per bucket**, because V22 documents `remove` as taking a batch. 200
 *     candidates cost a handful of round trips rather than 200, which is what keeps the invocation
 *     inside the 60 s ceiling (Requirement 18.11).
 *  4. **Stamp each accounted-for row individually**, anchored on `id` and `user_id`. A row whose
 *     object could not be deleted is left unstamped on purpose: the next run will find it again.
 *
 * Every deletion runs on the caller's `remover`, which is the service-role client in production
 * (Requirement 18.9) — the browser never deletes, and this module never builds a farmer-scoped
 * client to try.
 */
export async function sweepFullImages(
  deps: RetentionSweepDeps & { store: RetentionStore; remover: ObjectRemoveClient },
): Promise<FullImageScanReport> {
  const now = deps.now ?? new Date();
  const limit = deps.limit ?? RETENTION_SWEEP_BATCH_LIMIT;
  const cutoff = retentionCutoff(now, deps.retentionDays ?? MEDIA_RETENTION_DAYS);

  const candidates = await deps.store.dueFullImages({ cutoff, limit });
  const empty: FullImageScanReport = {
    scanned: candidates.length,
    removed: 0,
    alreadyAbsent: 0,
    stamped: 0,
    alreadyStamped: 0,
    failed: 0,
    limit,
    bounded: candidates.length >= limit,
  };
  if (candidates.length === 0) return empty;

  // Step 2 — the whole batch, before the first delete.
  for (const candidate of candidates) assertPathOwnedByRow(candidate);

  // Step 3 — one call per bucket. Migration 0005 constrains `image_bucket` to `crop-images`, so
  // this is one group in practice; grouping by the row's own value rather than by that constant
  // means the sweep cannot address a bucket the row did not name.
  const byBucket = new Map<string, FullImageCandidate[]>();
  for (const candidate of candidates) {
    const group = byBucket.get(candidate.bucket);
    if (group === undefined) byBucket.set(candidate.bucket, [candidate]);
    else group.push(candidate);
  }

  let removed = 0;
  let alreadyAbsent = 0;
  let stamped = 0;
  let alreadyStamped = 0;
  let failed = 0;

  for (const [bucket, group] of byBucket) {
    const outcome = await removeObjects(
      deps.remover,
      bucket,
      group.map((candidate) => candidate.path),
    );

    if (outcome.error !== undefined) {
      failed += group.length;
      warn('remove_failed', { bucket, requested: group.length, scan: 'full_images' });
      console.error(
        '[jamee] retention.remove_failed_cause',
        outcome.error instanceof Error
          ? (outcome.error.stack ?? outcome.error.message)
          : String(outcome.error),
      );
      continue;
    }

    removed += outcome.removed.length;
    alreadyAbsent += outcome.absent.length;

    // Step 4 — every path in this group is now accounted for as gone, so every row in it gets its
    // instant. Requirement 18.7 is per row, which is why this is a loop and not one bulk update:
    // a bulk update would need a second unanchored predicate to select its rows.
    for (const candidate of group) {
      try {
        const didStamp = await deps.store.stampFullImageDeleted({
          id: candidate.id,
          userId: candidate.userId,
          deletedAt: now,
        });
        if (didStamp) stamped += 1;
        else alreadyStamped += 1;
      } catch (cause) {
        failed += 1;
        warn('stamp_failed', { bucket, diagnosisId: candidate.id });
        console.error(
          '[jamee] retention.stamp_failed_cause',
          cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
        );
      }
    }
  }

  return { ...empty, removed, alreadyAbsent, stamped, alreadyStamped, failed };
}

/* ========================================================================== */
/* Scan 2 — the orphan backstop (Requirements 18.4, 18.5) — OFF, U-V22b         */
/* ========================================================================== */

/**
 * Delete objects past the window that no row references, across both buckets, keeping every
 * Thumbnail_Derivative.
 *
 * **This does not run in the shipped configuration.** `RETENTION_ORPHAN_SCAN_ENABLED` is `false`
 * while U-V22b is open, and `runRetentionSweep` reports `disabled_pending_v22b` rather than calling
 * it. It is written and tested now so that resolving V22 is a flag flip and an adapter, not a design
 * exercise — and because the requirements it serves (18.4 for a failed transcription's object,
 * 18.5's retention rule) need to be visibly implemented somewhere.
 *
 * **The unresolved dependency fails loudly.** If the flag is on and no `OrphanObjectSource` was
 * injected, this throws with U-V22b named. Silently reporting a sweep that swept nothing is the one
 * outcome that would let the storage projection drift without a symptom.
 *
 * Two rules on what is deletable, both of them Requirement 18.5 and 18.8 read literally:
 *
 *  - **A `crop-images` path that `isThumbPath()` recognizes is kept, always.** The predicate comes
 *    from `src/lib/storage.ts` — the single owner of the thumbnail convention, alongside
 *    `thumbPathFor()` which produces those paths — rather than from a `.thumb.` string written here.
 *    A second copy of that convention is exactly how a sweep starts deleting thumbnails after
 *    someone changes the infix. `voice-messages` has no derivatives (only the browser makes one,
 *    and only for an image), so the exclusion is scoped to the bucket that has them.
 *  - **A path with no usable owner segment is refused**, never deleted, because scan 2's only
 *    tenant anchor is that segment and it deletes under `{owner}/` alone.
 */
export async function sweepOrphans(
  deps: RetentionSweepDeps & { remover: ObjectRemoveClient },
): Promise<OrphanScanReport> {
  const enabled = deps.orphanScanEnabled ?? RETENTION_ORPHAN_SCAN_ENABLED;
  if (!enabled) return { ran: false, reason: 'disabled_pending_v22b' };

  const source = deps.orphans;
  if (source === undefined) {
    throw new Error(
      'The retention orphan scan is enabled but no OrphanObjectSource was supplied. U-V22b is ' +
        'unresolved: no confirmed storage.objects creation-timestamp surface exists to filter ' +
        'objects by age. Resolve V22 in docs/VERIFIED_VALUES.md and inject a source, or set ' +
        'RETENTION_ORPHAN_SCAN_ENABLED = false in src/lib/config/media.ts. Refusing to report a ' +
        'sweep that swept nothing.',
    );
  }

  const now = deps.now ?? new Date();
  const limit = deps.limit ?? RETENTION_SWEEP_BATCH_LIMIT;
  const cutoff = retentionCutoff(now, deps.retentionDays ?? MEDIA_RETENTION_DAYS);

  let scanned = 0;
  let retainedThumbnails = 0;
  let refused = 0;
  let removed = 0;
  let alreadyAbsent = 0;
  let failed = 0;
  let budget = limit;

  for (const bucket of [STORAGE_BUCKETS.cropImages, STORAGE_BUCKETS.voiceMessages]) {
    if (budget <= 0) break;

    const objects = await source.olderThan({ bucket, cutoff, limit });
    scanned += objects.length;

    const deletable: string[] = [];
    for (const object of objects) {
      // The surface is asked for objects older than the cutoff; it is not trusted to have honoured
      // that. An object inside the window is not the sweep's to delete under any circumstances.
      if (object.createdAt.getTime() >= cutoff.getTime()) continue;

      if (bucket === STORAGE_BUCKETS.cropImages && isThumbPath(object.path)) {
        retainedThumbnails += 1;
        continue;
      }
      if (orphanOwnerSegment(object.path) === undefined) {
        refused += 1;
        warn('orphan_refused', { bucket, reason: 'no_owner_segment' });
        continue;
      }
      deletable.push(object.path);
      if (deletable.length >= budget) break;
    }

    // Spent whether or not the call succeeds. The bound is on the work one invocation takes on, not
    // on how much of it landed — a failing bucket must not hand its budget to the next one and turn
    // a bad run into a long one.
    budget -= deletable.length;

    const outcome = await removeObjects(deps.remover, bucket, deletable);
    if (outcome.error !== undefined) {
      failed += deletable.length;
      warn('remove_failed', { bucket, requested: deletable.length, scan: 'orphans' });
      console.error(
        '[jamee] retention.remove_failed_cause',
        outcome.error instanceof Error
          ? (outcome.error.stack ?? outcome.error.message)
          : String(outcome.error),
      );
      continue;
    }
    removed += outcome.removed.length;
    alreadyAbsent += outcome.absent.length;
  }

  return {
    ran: true,
    scanned,
    retainedThumbnails,
    removed,
    alreadyAbsent,
    refused,
    failed,
    limit,
    bounded: budget <= 0,
  };
}

/* ========================================================================== */
/* The invocation                                                              */
/* ========================================================================== */

/**
 * One sweep: scan 1, then scan 2 if it is enabled.
 *
 * **Safe to run late, twice, or several times in a row**, which V21 records as the platform's
 * documented contract rather than a nicety: Vercel's cron delivery can fire the same scheduled run
 * more than once, does not retry a failed one, and can skip one entirely. Nothing here accumulates
 * state between runs — the `full_image_deleted_at is null` predicate excludes what a previous run
 * stamped, and an absent object counts as deleted — so a doubled run does the second half of the
 * first run's work and a missed run costs bucket headroom, which the retention arithmetic reserves
 * 25 % for.
 *
 * Both scans are bounded by the same `limit`, so leftover work waits for the next invocation rather
 * than stretching this one (Requirement 18.11).
 */
export async function runRetentionSweep(
  deps: RetentionSweepDeps = {},
): Promise<RetentionSweepReport> {
  const now = deps.now ?? new Date();
  const retentionDays = deps.retentionDays ?? MEDIA_RETENTION_DAYS;
  const cutoff = retentionCutoff(now, retentionDays);

  // One client for both roles, built only if something is actually missing — so a fully injected
  // call (every unit test) never constructs one and never reads the service-role key.
  let store = deps.store;
  let remover = deps.remover;
  if (store === undefined || remover === undefined) {
    const admin = await defaultAdminClient();
    store ??= retentionStoreFrom(admin);
    remover ??= admin;
  }

  const resolved: RetentionSweepDeps & { store: RetentionStore; remover: ObjectRemoveClient } = {
    ...deps,
    now,
    retentionDays,
    store,
    remover,
  };

  const fullImages = await sweepFullImages(resolved);
  const orphans = await sweepOrphans(resolved);

  const report: RetentionSweepReport = {
    retentionDays,
    cutoff: cutoff.toISOString(),
    fullImages,
    orphans,
  };
  note('sweep_complete', { ...report });
  return report;
}

/* ========================================================================== */
/* The real store                                                              */
/* ========================================================================== */

/**
 * Bind the two statements to a real client — **the service-role client in production**, because
 * migration 0005 grants `authenticated` no update policy on `diagnoses` at all (the only column
 * anything updates is `full_image_deleted_at`, and Requirement 18.9 puts that write on the service
 * role by definition).
 *
 * A PostgREST `error` is never read as an empty result — the rule `knowledge.ts`,
 * `conversation.service.ts` and every store factory in `src/services` follow. A failed candidate
 * read that returned `[]` would look exactly like "nothing to sweep" and would quietly stop the
 * sweep for as long as the failure lasted, so both statements throw with the cause attached.
 */
export function retentionStoreFrom(client: SupabaseClient<Database>): RetentionStore {
  return {
    async dueFullImages({ cutoff, limit }) {
      /*
       * The design's scan-1 query, served by `diagnoses_retention_idx` — the partial index on
       * `(created_at) where full_image_deleted_at is null` from migration 0005, whose predicate is
       * the first `.is()` below. The index shrinks as the sweep works rather than growing with the
       * table, so this stays a bounded read for the life of the deployment.
       *
       * This is the one statement in Jamee with no `user_id` predicate, declared in
       * `scripts/check-secret-scope.ts`'s `TENANT_INDEPENDENT_STATEMENTS`; the module header
       * explains what anchors the deletions instead. It reads four columns — the ones the sweep
       * acts on — rather than `*`, so a widening of the row cannot widen what the sweep sees.
       */
      const { data, error } = await client
        .from('diagnoses')
        .select('id, user_id, image_bucket, image_path')
        .is('full_image_deleted_at', null)
        .lt('created_at', cutoff.toISOString())
        .order('created_at', { ascending: true })
        .limit(limit);

      if (error !== null) {
        throw new AppError('INTERNAL_ERROR', {
          cause: error,
          context: { reason: 'retention_candidate_read_failed' },
        });
      }

      return (data ?? []).map((row) => ({
        id: row.id,
        userId: row.user_id,
        bucket: row.image_bucket,
        path: row.image_path,
      }));
    },

    async stampFullImageDeleted({ id, userId, deletedAt }) {
      /*
       * Requirement 18.7, and every clause of it is in this one statement.
       *
       *  - **One column in the payload.** `full_image_deleted_at` and nothing else, so "leaves every
       *    other column of that row unchanged" is a property of the update rather than a promise —
       *    `image_path` in particular survives, because the Thumbnail_Derivative path is derived
       *    from it (Requirements 18.5, 2.13).
       *  - **Two anchors in the predicate.** `id` identifies the row; `user_id` is the explicit
       *    tenant predicate `admin.ts` requires of every service-role statement, and it means a
       *    corrupt candidate list still cannot write across a tenant boundary.
       *  - **`full_image_deleted_at is null` as a third predicate**, so two overlapping runs cannot
       *    both stamp one row: the second matches nothing and reports `false`. V21 documents that a
       *    long run can be overlapped by the next one, which is what makes this worth the clause.
       *  - **`select('id')` on the way out**, so "did this stamp a row?" is answered by the rows
       *    returned rather than by an assumption.
       */
      const { data, error } = await client
        .from('diagnoses')
        .update({ full_image_deleted_at: deletedAt.toISOString() })
        .eq('id', id)
        .eq('user_id', userId)
        .is('full_image_deleted_at', null)
        .select('id');

      if (error !== null) {
        throw new AppError('INTERNAL_ERROR', {
          cause: error,
          context: { reason: 'retention_stamp_failed', diagnosisId: id },
        });
      }
      return (data ?? []).length > 0;
    },
  };
}

/**
 * The service-role client, imported lazily so that merely importing this module reads no secret and
 * every unit test can drive the sweep without one.
 *
 * The same shape serves as the store's client and as the deleter, because both roles need the one
 * credential Requirement 18.9 names.
 */
async function defaultAdminClient(): Promise<SupabaseClient<Database>> {
  const { createAdminClient } = await import('@/lib/supabase/admin');
  return createAdminClient();
}
