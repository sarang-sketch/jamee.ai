import 'server-only';

import { type Collection, type ObjectId } from 'mongodb';

import { getDb } from '@/lib/db/client';
import { COLLECTIONS, type DiagnosisDoc } from '@/lib/db/collections';

/**
 * The Data_Access_Layer for the Retention_Sweep's scan 1 — the two `diagnoses` operations the
 * age-driven sweep needs, ported off Supabase onto MongoDB by Amendment A3.
 *
 * Requirements: 18.3 (delete every Full_Size_Image whose owning Diagnosis_Result predates the
 *               window), 18.6 (delete NO row of `diagnoses`, `messages`, `conversations`, or
 *               `usage_logs`), 18.7 (record the deletion instant on the owning row and leave every
 *               other field unchanged), 18.8 (the stamp is anchored on the row's own owner), 18.10
 *               (idempotent: the `fullImageDeletedAt: null` predicate excludes what a previous run
 *               stamped), 13.7 (the driver lives only under `src/lib/db/**`)
 * Design: "Media lifecycle and retention" → *How the sweep finds its work* (scan 1); D17, D18, D19;
 *         Amendment A3 (MongoDB / GridFS; the partial index on `{ createdAt: 1 }` with
 *         `partialFilterExpression: { fullImageDeletedAt: null }`)
 *
 * =============================================================================
 * WHY THIS SITS BESIDE `farmer.ts` AND WHY ITS READS ARE NAMED SYSTEM FUNCTIONS
 * =============================================================================
 *
 * `src/lib/db/farmer.ts` is a committed building block owned by another wave and must not be
 * edited, and the sweep's candidate read is the one operation in the product whose PURPOSE is
 * tenant-independent — it ages out media for the whole deployment, so a farmer-scoped read could
 * not express it and there is no tenant-free source of farmer ids to loop over. So, exactly as
 * `farmer.ts` does for the Telegram claim and the payment-webhook lookup, the two operations here
 * are NAMED SYSTEM FUNCTIONS: `dueFullImageDiagnoses` is unscoped by necessity and named for it,
 * and the deletions it drives are anchored on the acting end instead —
 *
 *  1. **The GridFS file's own `metadata.ownerId` is asserted against the row's `ownerId`** before
 *     the delete (the RetentionService does this, Requirement 18.8), and
 *  2. **`stampFullImageDeleted` is anchored on `_id` AND `ownerId`**, so even a corrupt candidate
 *     list cannot write to a row that does not belong to the farmer it was read for.
 *
 * There is deliberately no delete of any `diagnoses` document here — only a bounded read and a
 * single-field stamp — so Requirement 18.6 is a property of the module's surface, not a promise:
 * a row is only ever STAMPED, and `mediaRef` is left intact so the surviving Thumbnail_Derivative
 * (`metadata.sourceRef`) stays reachable (Requirements 18.5, 2.13).
 */

function diagnoses(): Collection<DiagnosisDoc> {
  return getDb().collection<DiagnosisDoc>(COLLECTIONS.diagnoses);
}

/** One scan-1 candidate: the row's id, its owner (the anchor scan 1 has), and its Full_Size_Image. */
export interface DueFullImage {
  readonly diagnosisId: ObjectId;
  readonly ownerId: string;
  readonly fileId: ObjectId;
}

/**
 * Scan 1's candidate read (Requirement 18.3): `diagnoses` documents whose Full_Size_Image is still
 * stored (`fullImageDeletedAt: null`) and whose `createdAt` predates the cutoff, oldest first, at
 * most `limit`.
 *
 * `fullImageDeletedAt: null` is what makes a re-run harmless (Requirement 18.10): anything a
 * previous run stamped is already outside this result set — the same predicate as the partial
 * index the design's scan-1 statement is served by. This is a NAMED SYSTEM FUNCTION: it is
 * unscoped across all farmers by nature (it ages out the whole deployment's media), and each
 * returned row carries its own `ownerId` so the caller re-checks ownership before deleting.
 */
export async function dueFullImageDiagnoses(cutoff: Date, limit: number): Promise<DueFullImage[]> {
  const docs = await diagnoses()
    .find({ fullImageDeletedAt: null, createdAt: { $lt: cutoff } })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();

  return docs.map((doc) => ({
    diagnosisId: doc._id,
    ownerId: doc.ownerId,
    fileId: doc.mediaRef.fileId,
  }));
}

/**
 * Requirement 18.7: record the deletion instant on the owning `diagnoses` document, leaving every
 * other field unchanged. Returns `true` when a row was stamped and `false` when none matched — the
 * already-stamped case (a doubled/overlapping run), not a failure.
 *
 * Three predicates, and every clause of Requirement 18.7 / 18.8 is in this one update:
 *  - **`_id` identifies the row** and **`ownerId` is the tenant anchor** (18.8) — a corrupt
 *    candidate list still cannot write across a tenant boundary.
 *  - **`fullImageDeletedAt: null`** so two overlapping runs cannot both stamp one row: the second
 *    matches nothing and reports `false`.
 *  - **`$set` carries exactly one field** — `fullImageDeletedAt` — so "leaves every other field
 *    unchanged" is a property of the update, not a promise; `mediaRef` in particular survives.
 */
export async function stampFullImageDeleted(
  diagnosisId: ObjectId,
  ownerId: string,
  deletedAt: Date,
): Promise<boolean> {
  const res = await diagnoses().updateOne(
    { _id: diagnosisId, ownerId, fullImageDeletedAt: null },
    { $set: { fullImageDeletedAt: deletedAt } },
  );
  return (res.matchedCount ?? 0) > 0;
}
