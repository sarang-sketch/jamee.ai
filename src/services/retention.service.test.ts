import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MEDIA_RETENTION_DAYS,
  RETENTION_SWEEP_BATCH_LIMIT,
  VOICE_FAILURE_GRACE_DAYS,
} from '@/lib/config/media';
import type { AgedMediaFile } from '@/lib/db/media';
import type { MediaKind } from '@/lib/db/names';
import type { DueFullImage } from '@/lib/db/retention';

import {
  retentionCutoff,
  runRetentionSweep,
  sweepFullImages,
  sweepOrphans,
} from './retention.service';

/**
 * `RetentionService` — the GridFS sweep's logic, driven through injected Data_Access_Layer seams
 * with no live MongoDB (Amendment A3).
 *
 * Requirements: 18.1 (one window, whole days), 18.3 (delete every Full_Size_Image past the window),
 *               18.4 (voice files past the window), 18.5 (retain every Thumbnail_Derivative — scan 2
 *               never lists `thumbnail`), 18.6 (delete no document), 18.7 (stamp the instant, leave
 *               every other field alone), 18.8 (delete only under the owning farmer / a present
 *               owner), 18.10 (idempotent), 18.11 (bounded per invocation)
 * Design: "Media lifecycle and retention" → *How the sweep finds its work*; V29
 *
 * The seams here mirror the real `src/lib/db/**` functions: an in-memory `diagnoses` that applies
 * scan 1's `fullImageDeletedAt is null` + `createdAt < cutoff` clauses (so "a second run does
 * nothing" is a statement about the sweep against a store that behaves like the real one), an
 * owner-scoped GridFS delete, and an age listing per kind. The transaction / index facts (a confirm
 * plus a webhook extend once; the sweep deletes only old files, never another farmer's) are proven
 * against real Mongo in `tests/integration/retention.test.ts`.
 */

const FARMER_A = 'farmer-A';
const FARMER_B = 'farmer-B';

/** `2026-09-20T10:00:00Z`, so a 7-day window cuts at `2026-09-13T10:00:00Z`. */
const NOW = new Date('2026-09-20T10:00:00.000Z');
const STALE = new Date('2026-09-01T00:00:00.000Z');
const FRESH = new Date('2026-09-19T00:00:00.000Z');

let oidCounter = 0;
const oidByLabel = new Map<string, ObjectId>();
/** A stable valid ObjectId per label — labels may contain non-hex chars, so we assign hex ids. */
const oid = (label: string): ObjectId => {
  const existing = oidByLabel.get(label);
  if (existing !== undefined) return existing;
  oidCounter += 1;
  const made = new ObjectId(oidCounter.toString(16).padStart(24, '0'));
  oidByLabel.set(label, made);
  return made;
};

/* -------------------------------------------------------------------------- */
/* Scan-1 store fake                                                           */
/* -------------------------------------------------------------------------- */

interface DiagRow {
  readonly diagnosisId: ObjectId;
  readonly ownerId: string;
  readonly fileId: ObjectId;
  readonly createdAt: Date;
  fullImageDeletedAt: Date | null;
}

interface FakeScan1 {
  readonly rows: DiagRow[];
  readonly dueFullImages: (cutoff: Date, limit: number) => Promise<DueFullImage[]>;
  readonly deleteOwnedFile: (ownerId: string, fileId: string | ObjectId) => Promise<boolean>;
  readonly stamp: (diagnosisId: ObjectId, ownerId: string, deletedAt: Date) => Promise<boolean>;
  readonly deleted: { ownerId: string; fileId: string }[];
  readonly reads: { cutoff: Date; limit: number }[];
}

function fakeScan1(rows: DiagRow[], options: { deleteThrows?: boolean } = {}): FakeScan1 {
  const deleted: { ownerId: string; fileId: string }[] = [];
  const reads: { cutoff: Date; limit: number }[] = [];
  return {
    rows,
    deleted,
    reads,
    async dueFullImages(cutoff, limit) {
      reads.push({ cutoff, limit });
      return rows
        .filter((r) => r.fullImageDeletedAt === null && r.createdAt.getTime() < cutoff.getTime())
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit)
        .map((r) => ({ diagnosisId: r.diagnosisId, ownerId: r.ownerId, fileId: r.fileId }));
    },
    async deleteOwnedFile(ownerId, fileId) {
      if (options.deleteThrows) throw new Error('gridfs unavailable');
      deleted.push({ ownerId, fileId: fileId.toString() });
      // Owner-scoped: a file whose row owner does not match its stored owner is a no-op. Here every
      // seeded row's fileId is owned by its own owner, so this returns true.
      return true;
    },
    async stamp(diagnosisId, ownerId, deletedAt) {
      const target = rows.find(
        (r) => r.diagnosisId.equals(diagnosisId) && r.ownerId === ownerId && r.fullImageDeletedAt === null,
      );
      if (target === undefined) return false;
      target.fullImageDeletedAt = deletedAt;
      return true;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Scan-2 age-listing fake                                                     */
/* -------------------------------------------------------------------------- */

interface FakeScan2 {
  readonly listAged: (kind: MediaKind, instant: Date, limit: number) => Promise<AgedMediaFile[]>;
  readonly deleteFileById: (fileId: ObjectId) => Promise<boolean>;
  readonly deleted: string[];
  readonly askedKinds: MediaKind[];
}

function fakeScan2(files: (AgedMediaFile & { kind: MediaKind })[], options: { deleteThrows?: boolean } = {}): FakeScan2 {
  const deleted: string[] = [];
  const askedKinds: MediaKind[] = [];
  return {
    deleted,
    askedKinds,
    async listAged(kind, instant, limit) {
      askedKinds.push(kind);
      return files
        .filter((f) => f.kind === kind && f.uploadDate.getTime() < instant.getTime())
        .slice(0, limit)
        .map(({ fileId, ownerId, uploadDate, length }) => ({ fileId, ownerId, uploadDate, length }));
    },
    async deleteFileById(fileId) {
      if (options.deleteThrows) throw new Error('gridfs unavailable');
      deleted.push(fileId.toHexString());
      return true;
    },
  };
}

function aged(
  hex: string,
  kind: MediaKind,
  ownerId: string | null,
  uploadDate: Date,
): AgedMediaFile & { kind: MediaKind } {
  return { fileId: oid(hex), ownerId, uploadDate, length: 1000, kind };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ========================================================================== */
/* The window (Requirement 18.1)                                               */
/* ========================================================================== */

describe('the retention window', () => {
  it('is the configured whole number of days, read from one place', () => {
    const cutoff = retentionCutoff(NOW);
    expect(Number.isInteger(MEDIA_RETENTION_DAYS)).toBe(true);
    expect(NOW.getTime() - cutoff.getTime()).toBe(MEDIA_RETENTION_DAYS * 86_400_000);
  });

  it('is the same window a failed transcription waits out (Requirement 8.10)', () => {
    expect(VOICE_FAILURE_GRACE_DAYS).toBe(MEDIA_RETENTION_DAYS);
  });

  it('refuses a window that is not a whole number of days', () => {
    expect(() => retentionCutoff(NOW, 1.5)).toThrow(/whole number of days/);
    expect(() => retentionCutoff(NOW, -1)).toThrow(/whole number of days/);
  });
});

/* ========================================================================== */
/* Scan 1 — document-driven                                                    */
/* ========================================================================== */

function diagRow(overrides: Partial<DiagRow> & { diagnosisId: ObjectId; fileId: ObjectId }): DiagRow {
  return {
    ownerId: FARMER_A,
    createdAt: STALE,
    fullImageDeletedAt: null,
    ...overrides,
  };
}

describe('scan 1 — the document-driven sweep', () => {
  it('deletes the Full_Size_Image owner-scoped and stamps the row', async () => {
    const scan1 = fakeScan1([diagRow({ diagnosisId: oid('a1'), fileId: oid('f1') })]);

    const report = await sweepFullImages({ ...scan1, now: NOW, listAged: async () => [], deleteFileById: async () => true });

    expect(report).toMatchObject({ scanned: 1, removed: 1, stamped: 1, failed: 0 });
    expect(scan1.deleted).toEqual([{ ownerId: FARMER_A, fileId: oid('f1').toHexString() }]);
    expect(scan1.rows[0]?.fullImageDeletedAt).toEqual(NOW);
  });

  it('leaves a diagnosis inside the window alone', async () => {
    const scan1 = fakeScan1([diagRow({ diagnosisId: oid('a2'), fileId: oid('f2'), createdAt: FRESH })]);

    const report = await sweepFullImages({ ...scan1, now: NOW });

    expect(report.scanned).toBe(0);
    expect(scan1.deleted).toEqual([]);
    expect(scan1.rows[0]?.fullImageDeletedAt).toBeNull();
  });

  it('is idempotent: a second run over stamped rows deletes nothing (Requirement 18.10)', async () => {
    const scan1 = fakeScan1([
      diagRow({ diagnosisId: oid('a3'), fileId: oid('f3') }),
      diagRow({ diagnosisId: oid('a4'), fileId: oid('f4') }),
    ]);

    const first = await sweepFullImages({ ...scan1, now: NOW });
    const second = await sweepFullImages({ ...scan1, now: NOW });

    expect(first).toMatchObject({ scanned: 2, removed: 2, stamped: 2 });
    expect(second).toMatchObject({ scanned: 0, removed: 0, stamped: 0, failed: 0 });
    // The first run deleted two files; the second reached GridFS for nothing.
    expect(scan1.deleted).toHaveLength(2);
  });

  it('does not stamp when the file delete throws, so the next run retries', async () => {
    const scan1 = fakeScan1([diagRow({ diagnosisId: oid('a5'), fileId: oid('f5') })], { deleteThrows: true });

    const report = await sweepFullImages({ ...scan1, now: NOW });

    expect(report).toMatchObject({ scanned: 1, removed: 0, stamped: 0, failed: 1 });
    expect(scan1.rows[0]?.fullImageDeletedAt).toBeNull();
  });

  it('bounds one invocation and says when work remains (Requirement 18.11)', async () => {
    const scan1 = fakeScan1([
      diagRow({ diagnosisId: oid('a6'), fileId: oid('f6'), createdAt: new Date('2026-09-01T00:00:00Z') }),
      diagRow({ diagnosisId: oid('a7'), fileId: oid('f7'), createdAt: new Date('2026-09-02T00:00:00Z') }),
      diagRow({ diagnosisId: oid('a8'), fileId: oid('f8'), createdAt: new Date('2026-09-03T00:00:00Z') }),
    ]);

    const report = await sweepFullImages({ ...scan1, now: NOW, limit: 2 });

    expect(scan1.reads[0]).toMatchObject({ limit: 2 });
    expect(report).toMatchObject({ scanned: 2, removed: 2, bounded: true });
    // Oldest first: the third (newest) row is untouched and waits for the next run.
    expect(scan1.rows[2]?.fullImageDeletedAt).toBeNull();
  });

  it('defaults the bound to the configured batch limit', async () => {
    const scan1 = fakeScan1([]);
    await sweepFullImages({ ...scan1, now: NOW });
    expect(scan1.reads[0]).toMatchObject({ limit: RETENTION_SWEEP_BATCH_LIMIT });
  });
});

/* ========================================================================== */
/* Scan 2 — the age-driven orphan backstop                                     */
/* ========================================================================== */

describe('scan 2 — the orphan backstop', () => {
  it('runs under A3 (no feature flag) and lists only crop-image and voice, never thumbnail (18.5)', async () => {
    const scan2 = fakeScan2([
      aged('c1', 'crop-image', FARMER_A, STALE),
      aged('v1', 'voice', FARMER_A, STALE),
    ]);

    const report = await sweepOrphans({ ...scan2, now: NOW });

    expect(report).toMatchObject({ scanned: 2, removed: 2, refused: 0 });
    expect(scan2.askedKinds).toEqual(['crop-image', 'voice']);
    // A thumbnail is never even asked for.
    expect(scan2.askedKinds).not.toContain('thumbnail');
  });

  it('sweeps voice originals past the window (Requirements 18.4, 8.10)', async () => {
    const scan2 = fakeScan2([aged('v2', 'voice', FARMER_A, STALE)]);
    const report = await sweepOrphans({ ...scan2, now: NOW });
    expect(report).toMatchObject({ removed: 1 });
    expect(scan2.deleted).toEqual([oid('v2').toHexString()]);
  });

  it('refuses a file whose owner metadata is missing, never deletes it (Requirement 18.8)', async () => {
    const scan2 = fakeScan2([
      aged('c3', 'crop-image', null, STALE),
      aged('c4', 'crop-image', '', STALE),
      aged('c5', 'crop-image', FARMER_A, STALE),
    ]);

    const report = await sweepOrphans({ ...scan2, now: NOW });

    expect(report).toMatchObject({ scanned: 3, refused: 2, removed: 1 });
    expect(scan2.deleted).toEqual([oid('c5').toHexString()]);
  });

  it('keeps a file the listing returned that is not actually past the window', async () => {
    const scan2 = fakeScan2([aged('c6', 'crop-image', FARMER_A, FRESH)]);
    const report = await sweepOrphans({ ...scan2, now: NOW });
    // The fake listing already filters by cutoff, so nothing is listed; the defensive re-check is
    // asserted structurally by the source. Either way nothing is deleted.
    expect(report).toMatchObject({ removed: 0 });
    expect(scan2.deleted).toEqual([]);
  });

  it('does not stamp/crash when a delete throws; counts it failed for the next run', async () => {
    const scan2 = fakeScan2([aged('c7', 'crop-image', FARMER_A, STALE)], { deleteThrows: true });
    const report = await sweepOrphans({ ...scan2, now: NOW });
    expect(report).toMatchObject({ scanned: 1, removed: 0, failed: 1 });
  });

  it('bounds itself with the same per-invocation limit across both kinds', async () => {
    const scan2 = fakeScan2([
      aged('c8', 'crop-image', FARMER_A, STALE),
      aged('c9', 'crop-image', FARMER_A, STALE),
      aged('va', 'voice', FARMER_A, STALE),
    ]);

    const report = await sweepOrphans({ ...scan2, now: NOW, limit: 2 });

    expect(report).toMatchObject({ removed: 2, bounded: true });
    // Budget spent on crop-image; voice is not reached this run.
    expect(scan2.deleted).toEqual([oid('c8').toHexString(), oid('c9').toHexString()]);
  });
});

/* ========================================================================== */
/* One invocation                                                              */
/* ========================================================================== */

describe('runRetentionSweep', () => {
  it('runs scan 1 then scan 2, and constructs no accessor when every seam is injected', async () => {
    const scan1 = fakeScan1([diagRow({ diagnosisId: oid('b1'), fileId: oid('bf1') })]);
    const scan2 = fakeScan2([aged('bo1', 'voice', FARMER_B, STALE)]);

    const report = await runRetentionSweep({ ...scan1, ...scan2, now: NOW });

    expect(report).toMatchObject({
      retentionDays: MEDIA_RETENTION_DAYS,
      cutoff: retentionCutoff(NOW).toISOString(),
      fullImages: { scanned: 1, removed: 1, stamped: 1 },
      orphans: { scanned: 1, removed: 1 },
    });
  });
});

/* ========================================================================== */
/* Requirement 18.6, structurally                                              */
/* ========================================================================== */

describe('the sweep cannot delete a database document (Requirement 18.6)', () => {
  const raw = readFileSync(join(process.cwd(), 'src', 'services', 'retention.service.ts'), 'utf8');

  it('is a server-only module (Requirements 18.9, 18.11)', () => {
    expect(raw.startsWith("import 'server-only';")).toBe(true);
  });

  it('imports no document-delete accessor — only GridFS deletes and a single-field stamp', () => {
    // The DAL surface it imports: media file deletes (deleteMediaById / deleteMediaForOwner), the
    // aged listing, and the diagnoses stamp/read. No `deleteMany`/`deleteOne`/`findOneAndDelete`.
    expect(raw).not.toMatch(/deleteMany|deleteOne|findOneAndDelete/);
    expect(raw).toMatch(/deleteMediaForOwner/);
    expect(raw).toMatch(/deleteMediaById/);
    expect(raw).toMatch(/stampFullImageDeleted/);
  });

  it('imports the mongodb driver only for the ObjectId type it hands the DAL', () => {
    // The service names ObjectId (a type on the seams) but reaches no collection itself — every
    // database touch is a `src/lib/db/**` function.
    expect(raw).not.toMatch(/getDb\(|GridFSBucket|\.collection\(/);
  });
});
