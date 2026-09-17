import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MEDIA_RETENTION_DAYS,
  RETENTION_ORPHAN_SCAN_ENABLED,
  RETENTION_SWEEP_BATCH_LIMIT,
  VOICE_FAILURE_GRACE_DAYS,
} from '@/lib/config/media';
import { STORAGE_BUCKETS } from '@/lib/config/verified';
import { thumbPathFor } from '@/lib/storage';
import type { Database } from '@/types/database';
import type { ObjectRemoveClient } from '@/services/voice.service';

import { blankComments } from '../../scripts/check-secret-scope';
import {
  assertPathOwnedByRow,
  orphanOwnerSegment,
  removeObjects,
  retentionCutoff,
  retentionStoreFrom,
  runRetentionSweep,
  sweepFullImages,
  sweepOrphans,
  type FullImageCandidate,
  type OrphanObjectSource,
  type RetentionStore,
  type StoredObject,
} from './retention.service';

/**
 * `RetentionService` — the sweep's logic, driven through injected seams with no live Supabase.
 *
 * Requirements: 18.1 (one window, whole days), 18.3 (delete every Full_Size_Image past the window),
 *               18.4 (voice objects past the window), 18.5 (retain every Thumbnail_Derivative),
 *               18.6 (delete no row), 18.7 (stamp the instant, leave every other column alone),
 *               18.8 (delete only under the owning farmer's prefix), 18.10 (idempotent; an absent
 *               object counts as deleted), 18.11 (bounded per invocation)
 * Design: "Media lifecycle and retention" → *How the sweep finds its work*
 *
 * Two conventions this file follows deliberately:
 *
 *  - **The store fake mirrors the real query rather than stubbing its result.** It applies the same
 *    three clauses the design's scan-1 statement does — `full_image_deleted_at is null`,
 *    `created_at < cutoff`, oldest first, `limit N` — so "a second run deletes nothing" is a
 *    statement about the sweep against a table that behaves like the real one, not about a stub that
 *    was told to return `[]`.
 *  - **`retentionStoreFrom()` IS exercised here**, unlike the other store factories in
 *    `src/services`, which are deliberately left to a live database. The two properties under test —
 *    Requirement 18.7's "every other column unchanged" and the second `user_id` anchor on the stamp —
 *    are facts about the statement Jamee *constructs*, not about whether PostgREST executes it.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const FARMER_A = '11111111-1111-4111-8111-111111111111';
const FARMER_B = '22222222-2222-4222-8222-222222222222';

/** `2026-09-20T10:00:00Z`, so a 7-day window cuts at `2026-09-13T10:00:00Z`. */
const NOW = new Date('2026-09-20T10:00:00.000Z');

interface StoredRow {
  readonly id: string;
  readonly userId: string;
  readonly bucket: string;
  readonly path: string;
  readonly createdAt: string;
  fullImageDeletedAt: string | null;
}

function row(overrides: Partial<StoredRow> = {}): StoredRow {
  const id = overrides.id ?? 'd0000000-0000-4000-8000-000000000001';
  const userId = overrides.userId ?? FARMER_A;
  return {
    id,
    userId,
    bucket: STORAGE_BUCKETS.cropImages,
    path: `${userId}/2026/09/${id}.jpg`,
    createdAt: '2026-09-01T00:00:00.000Z',
    fullImageDeletedAt: null,
    ...overrides,
  };
}

interface StampCall {
  readonly id: string;
  readonly userId: string;
  readonly deletedAt: Date;
}

interface FakeStore extends RetentionStore {
  readonly rows: StoredRow[];
  readonly reads: { cutoff: Date; limit: number }[];
  readonly stamps: StampCall[];
}

/**
 * An in-memory `diagnoses` that applies scan 1's three clauses, plus the stamp's own
 * `full_image_deleted_at is null` guard — which is what makes a doubled run observably a no-op.
 */
function fakeStore(rows: StoredRow[]): FakeStore {
  const reads: { cutoff: Date; limit: number }[] = [];
  const stamps: StampCall[] = [];

  return {
    rows,
    reads,
    stamps,
    async dueFullImages({ cutoff, limit }) {
      reads.push({ cutoff, limit });
      return rows
        .filter((r) => r.fullImageDeletedAt === null)
        .filter((r) => new Date(r.createdAt).getTime() < cutoff.getTime())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit)
        .map(
          (r): FullImageCandidate => ({
            id: r.id,
            userId: r.userId,
            bucket: r.bucket,
            path: r.path,
          }),
        );
    },
    async stampFullImageDeleted({ id, userId, deletedAt }) {
      stamps.push({ id, userId, deletedAt });
      const target = rows.find(
        (r) => r.id === id && r.userId === userId && r.fullImageDeletedAt === null,
      );
      if (target === undefined) return false;
      target.fullImageDeletedAt = deletedAt.toISOString();
      return true;
    },
  };
}

interface RemoveCall {
  readonly bucket: string;
  readonly paths: readonly string[];
}

interface FakeRemover {
  readonly client: ObjectRemoveClient;
  readonly calls: RemoveCall[];
}

/**
 * A storage deleter. `present` is the set of paths that actually exist, because V22 documents
 * `remove()` as returning entries **for the deleted files** — so a requested path outside this set
 * comes back missing from the response, which is U-V22a's unresolved case and Requirement 18.10's
 * "already absent counts as deleted".
 *
 * `present: null` means "everything requested exists", the ordinary case.
 */
function fakeRemover(options: { present?: Set<string> | null; error?: unknown } = {}): FakeRemover {
  const calls: RemoveCall[] = [];
  const present = options.present ?? null;

  return {
    calls,
    client: {
      storage: {
        from: (bucket: string) => ({
          remove: async (paths: string[]) => {
            calls.push({ bucket, paths: [...paths] });
            if (options.error !== undefined) return { data: null, error: options.error };
            const deleted = paths
              .filter((path) => present === null || present.has(path))
              .map((name) => ({ name, id: 'ignored', bucket_id: 'deprecated' }));
            return { data: deleted, error: null };
          },
        }),
      },
    },
  };
}

function orphanSource(objects: readonly StoredObject[]): OrphanObjectSource & {
  readonly asked: { bucket: string; cutoff: Date; limit: number }[];
} {
  const asked: { bucket: string; cutoff: Date; limit: number }[] = [];
  return {
    asked,
    async olderThan({ bucket, cutoff, limit }) {
      asked.push({ bucket, cutoff, limit });
      return objects.filter((object) => object.bucket === bucket).slice(0, limit);
    },
  };
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
/* Scan 1 (Requirements 18.3, 18.7, 18.8, 18.10, 18.11)                        */
/* ========================================================================== */

describe('scan 1 — the row-driven sweep', () => {
  it('deletes the original and stamps the row, and does so in that order', async () => {
    const store = fakeStore([row({ id: 'd0000000-0000-4000-8000-00000000000a' })]);
    const remover = fakeRemover();
    const order: string[] = [];
    const wrapped: RetentionStore = {
      dueFullImages: store.dueFullImages,
      stampFullImageDeleted: async (input) => {
        order.push('stamp');
        return store.stampFullImageDeleted(input);
      },
    };
    const removerSpy: ObjectRemoveClient = {
      storage: {
        from: (bucket) => ({
          remove: async (paths) => {
            order.push('remove');
            return remover.client.storage.from(bucket).remove(paths);
          },
        }),
      },
    };

    const report = await sweepFullImages({ store: wrapped, remover: removerSpy, now: NOW });

    expect(report).toMatchObject({ scanned: 1, removed: 1, alreadyAbsent: 0, stamped: 1, failed: 0 });
    expect(remover.calls).toEqual([
      { bucket: STORAGE_BUCKETS.cropImages, paths: [store.rows[0]?.path] },
    ]);
    expect(store.rows[0]?.fullImageDeletedAt).toBe(NOW.toISOString());
    // Delete first, stamp second: a row stamped before its object was gone would tell the history
    // view "no longer stored" about an object still in the bucket.
    expect(order).toEqual(['remove', 'stamp']);
  });

  it('leaves a row inside the window alone', async () => {
    const store = fakeStore([
      row({ id: 'd0000000-0000-4000-8000-00000000000b', createdAt: '2026-09-19T00:00:00.000Z' }),
    ]);
    const remover = fakeRemover();

    const report = await sweepFullImages({ store, remover: remover.client, now: NOW });

    expect(report.scanned).toBe(0);
    expect(remover.calls).toEqual([]);
    expect(store.rows[0]?.fullImageDeletedAt).toBeNull();
  });

  it('is idempotent: a second run over stamped rows deletes nothing (Requirement 18.10)', async () => {
    const store = fakeStore([
      row({ id: 'd0000000-0000-4000-8000-00000000000c' }),
      row({ id: 'd0000000-0000-4000-8000-00000000000d' }),
    ]);
    const remover = fakeRemover();

    const first = await sweepFullImages({ store, remover: remover.client, now: NOW });
    const second = await sweepFullImages({ store, remover: remover.client, now: NOW });

    expect(first).toMatchObject({ scanned: 2, removed: 2, stamped: 2 });
    expect(second).toMatchObject({ scanned: 0, removed: 0, stamped: 0, failed: 0 });
    // The platform can fire the same scheduled run twice (V21). The second run must not reach
    // storage at all — not merely delete nothing.
    expect(remover.calls).toHaveLength(1);
    expect(store.stamps).toHaveLength(2);
  });

  it('treats a path absent from the response as deleted, not as a failure (U-V22a)', async () => {
    const store = fakeStore([row({ id: 'd0000000-0000-4000-8000-00000000000e' })]);
    const remover = fakeRemover({ present: new Set() });

    const report = await sweepFullImages({ store, remover: remover.client, now: NOW });

    expect(report).toMatchObject({ removed: 0, alreadyAbsent: 1, stamped: 1, failed: 0 });
    expect(store.rows[0]?.fullImageDeletedAt).toBe(NOW.toISOString());
  });

  it('stamps nothing when the delete call itself fails, so the next run retries', async () => {
    const store = fakeStore([row({ id: 'd0000000-0000-4000-8000-00000000000f' })]);
    const remover = fakeRemover({ error: { message: 'storage unavailable' } });

    const report = await sweepFullImages({ store, remover: remover.client, now: NOW });

    expect(report).toMatchObject({ scanned: 1, removed: 0, stamped: 0, failed: 1 });
    expect(store.stamps).toEqual([]);
    expect(store.rows[0]?.fullImageDeletedAt).toBeNull();
  });

  it('refuses a row whose path is not under its own user_id, and deletes nothing (Requirement 18.8)', async () => {
    const store = fakeStore([
      row({ id: 'd0000000-0000-4000-8000-000000000010' }),
      // The corrupt one: owned by A, path under B.
      row({
        id: 'd0000000-0000-4000-8000-000000000011',
        userId: FARMER_A,
        path: `${FARMER_B}/2026/09/d0000000-0000-4000-8000-000000000011.jpg`,
      }),
    ]);
    const remover = fakeRemover();

    await expect(sweepFullImages({ store, remover: remover.client, now: NOW })).rejects.toMatchObject(
      { code: 'INTERNAL_ERROR', context: { reason: 'retention_path_owner_mismatch' } },
    );

    // A hard error, not a skipped row: the whole batch is refused before any delete is issued, so
    // the healthy row's object is still there too.
    expect(remover.calls).toEqual([]);
    expect(store.stamps).toEqual([]);
  });

  it('reports the mismatch without copying another farmer id into the log', () => {
    const corrupt: FullImageCandidate = {
      id: 'd0000000-0000-4000-8000-000000000012',
      userId: FARMER_A,
      bucket: STORAGE_BUCKETS.cropImages,
      path: `${FARMER_B}/2026/09/x.jpg`,
    };

    expect(() => assertPathOwnedByRow(corrupt)).toThrow();
    expect(() =>
      assertPathOwnedByRow({ ...corrupt, path: `${FARMER_A}/2026/09/x.jpg` }),
    ).not.toThrow();
  });

  it('bounds one invocation and says when work remains (Requirement 18.11)', async () => {
    const store = fakeStore([
      row({ id: 'd0000000-0000-4000-8000-000000000013', createdAt: '2026-09-01T00:00:00.000Z' }),
      row({ id: 'd0000000-0000-4000-8000-000000000014', createdAt: '2026-09-02T00:00:00.000Z' }),
      row({ id: 'd0000000-0000-4000-8000-000000000015', createdAt: '2026-09-03T00:00:00.000Z' }),
    ]);
    const remover = fakeRemover();

    const report = await sweepFullImages({ store, remover: remover.client, now: NOW, limit: 2 });

    expect(store.reads[0]).toMatchObject({ limit: 2 });
    expect(report).toMatchObject({ scanned: 2, removed: 2, bounded: true });
    // Oldest first, so a backlog drains in order rather than starving its oldest entries.
    expect(remover.calls[0]?.paths).toHaveLength(2);
    expect(store.rows[2]?.fullImageDeletedAt).toBeNull();
  });

  it('defaults the bound to the configured batch limit', async () => {
    const store = fakeStore([]);
    const remover = fakeRemover();

    await sweepFullImages({ store, remover: remover.client, now: NOW });

    expect(store.reads[0]).toMatchObject({ limit: RETENTION_SWEEP_BATCH_LIMIT });
  });

  it('deletes each bucket in one batched call', async () => {
    const store = fakeStore([
      row({ id: 'd0000000-0000-4000-8000-000000000016' }),
      row({ id: 'd0000000-0000-4000-8000-000000000017', userId: FARMER_B }),
    ]);
    const remover = fakeRemover();

    await sweepFullImages({ store, remover: remover.client, now: NOW });

    expect(remover.calls).toHaveLength(1);
    expect(remover.calls[0]?.paths).toHaveLength(2);
  });
});

/* ========================================================================== */
/* Scan 2 — off pending U-V22b (Requirements 18.4, 18.5, 18.8)                  */
/* ========================================================================== */

describe('scan 2 — the orphan backstop', () => {
  const stale = new Date('2026-09-01T00:00:00.000Z');

  it('does not run in the shipped configuration', async () => {
    const remover = fakeRemover();

    expect(RETENTION_ORPHAN_SCAN_ENABLED).toBe(false);
    await expect(sweepOrphans({ remover: remover.client, now: NOW })).resolves.toEqual({
      ran: false,
      reason: 'disabled_pending_v22b',
    });
    expect(remover.calls).toEqual([]);
  });

  it('fails loudly when it is switched on with no object-age surface', async () => {
    const remover = fakeRemover();

    await expect(
      sweepOrphans({ remover: remover.client, now: NOW, orphanScanEnabled: true }),
    ).rejects.toThrow(/U-V22b/);
    expect(remover.calls).toEqual([]);
  });

  it('retains every Thumbnail_Derivative and deletes the original (Requirement 18.5)', async () => {
    const original = `${FARMER_A}/2026/09/aaaa.jpg`;
    const source = orphanSource([
      { bucket: STORAGE_BUCKETS.cropImages, path: original, createdAt: stale },
      { bucket: STORAGE_BUCKETS.cropImages, path: thumbPathFor(original), createdAt: stale },
    ]);
    const remover = fakeRemover();

    const report = await sweepOrphans({
      remover: remover.client,
      orphans: source,
      now: NOW,
      orphanScanEnabled: true,
    });

    expect(report).toMatchObject({ ran: true, scanned: 2, retainedThumbnails: 1, removed: 1 });
    expect(remover.calls[0]?.paths).toEqual([original]);
    expect(remover.calls.flatMap((call) => call.paths)).not.toContain(thumbPathFor(original));
  });

  it('sweeps voice originals past the window (Requirements 18.4, 8.10)', async () => {
    const voicePath = `${FARMER_A}/2026/09/bbbb.webm`;
    const source = orphanSource([
      { bucket: STORAGE_BUCKETS.voiceMessages, path: voicePath, createdAt: stale },
    ]);
    const remover = fakeRemover();

    const report = await sweepOrphans({
      remover: remover.client,
      orphans: source,
      now: NOW,
      orphanScanEnabled: true,
    });

    expect(report).toMatchObject({ ran: true, removed: 1 });
    expect(remover.calls).toEqual([
      { bucket: STORAGE_BUCKETS.voiceMessages, paths: [voicePath] },
    ]);
  });

  it('refuses a path with no owner segment to delete under (Requirement 18.8)', async () => {
    const source = orphanSource([
      { bucket: STORAGE_BUCKETS.cropImages, path: 'stray.jpg', createdAt: stale },
      { bucket: STORAGE_BUCKETS.voiceMessages, path: '/leading.webm', createdAt: stale },
    ]);
    const remover = fakeRemover();

    const report = await sweepOrphans({
      remover: remover.client,
      orphans: source,
      now: NOW,
      orphanScanEnabled: true,
    });

    expect(report).toMatchObject({ ran: true, refused: 2, removed: 0 });
    expect(remover.calls.flatMap((call) => call.paths)).toEqual([]);
    expect(orphanOwnerSegment('stray.jpg')).toBeUndefined();
    expect(orphanOwnerSegment(`${FARMER_A}/2026/09/ok.jpg`)).toBe(FARMER_A);
  });

  it('keeps an object the surface returned that is not actually past the window', async () => {
    const source = orphanSource([
      {
        bucket: STORAGE_BUCKETS.cropImages,
        path: `${FARMER_A}/2026/09/fresh.jpg`,
        createdAt: new Date('2026-09-19T00:00:00.000Z'),
      },
    ]);
    const remover = fakeRemover();

    const report = await sweepOrphans({
      remover: remover.client,
      orphans: source,
      now: NOW,
      orphanScanEnabled: true,
    });

    expect(report).toMatchObject({ ran: true, scanned: 1, removed: 0 });
    expect(remover.calls.flatMap((call) => call.paths)).toEqual([]);
  });

  it('bounds itself with the same per-invocation limit', async () => {
    const source = orphanSource([
      { bucket: STORAGE_BUCKETS.cropImages, path: `${FARMER_A}/2026/09/c1.jpg`, createdAt: stale },
      { bucket: STORAGE_BUCKETS.cropImages, path: `${FARMER_A}/2026/09/c2.jpg`, createdAt: stale },
      { bucket: STORAGE_BUCKETS.voiceMessages, path: `${FARMER_A}/2026/09/v1.webm`, createdAt: stale },
    ]);
    const remover = fakeRemover();

    const report = await sweepOrphans({
      remover: remover.client,
      orphans: source,
      now: NOW,
      orphanScanEnabled: true,
      limit: 2,
    });

    expect(report).toMatchObject({ ran: true, removed: 2, bounded: true });
    expect(source.asked.every((ask) => ask.limit === 2)).toBe(true);
    // The voice bucket is not reached: the budget was spent on the older bucket, and the next run
    // picks it up.
    expect(remover.calls.map((call) => call.bucket)).toEqual([STORAGE_BUCKETS.cropImages]);
  });
});

/* ========================================================================== */
/* One invocation                                                              */
/* ========================================================================== */

describe('runRetentionSweep', () => {
  it('runs scan 1, reports scan 2 as disabled, and constructs no client when both seams are given', async () => {
    const store = fakeStore([row({ id: 'd0000000-0000-4000-8000-000000000018' })]);
    const remover = fakeRemover();

    const report = await runRetentionSweep({ store, remover: remover.client, now: NOW });

    expect(report).toMatchObject({
      retentionDays: MEDIA_RETENTION_DAYS,
      cutoff: retentionCutoff(NOW).toISOString(),
      fullImages: { scanned: 1, removed: 1, stamped: 1 },
      orphans: { ran: false, reason: 'disabled_pending_v22b' },
    });
  });
});

/* ========================================================================== */
/* The two statements (Requirements 18.6, 18.7)                                */
/* ========================================================================== */

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * A chainable PostgREST stand-in. Every builder method records itself and returns the builder, and
 * the builder is a thenable, so `await client.from(…)…limit(n)` resolves to `result`.
 */
function fakeClient(result: { data: unknown; error: unknown }): {
  client: SupabaseClient<Database>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const builder: Record<string, unknown> = {};

  for (const method of ['select', 'update', 'eq', 'is', 'lt', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder['then'] = (resolve: (value: unknown) => unknown) => resolve(result);

  const client = {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] });
      return builder;
    },
  };

  return { client: client as unknown as SupabaseClient<Database>, calls };
}

const argsOf = (calls: readonly RecordedCall[], method: string): readonly unknown[][] =>
  calls.filter((call) => call.method === method).map((call) => [...call.args]);

describe('retentionStoreFrom', () => {
  it('reads the four columns the sweep acts on, with the window clauses and the bound', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });

    await retentionStoreFrom(client).dueFullImages({ cutoff: NOW, limit: 25 });

    expect(argsOf(calls, 'from')).toEqual([['diagnoses']]);
    expect(argsOf(calls, 'select')).toEqual([['id, user_id, image_bucket, image_path']]);
    // The partial index's own predicate (migration 0005), which is also what makes a re-run a no-op.
    expect(argsOf(calls, 'is')).toEqual([['full_image_deleted_at', null]]);
    expect(argsOf(calls, 'lt')).toEqual([['created_at', NOW.toISOString()]]);
    expect(argsOf(calls, 'order')).toEqual([['created_at', { ascending: true }]]);
    expect(argsOf(calls, 'limit')).toEqual([[25]]);
  });

  it('maps rows onto the candidate shape', async () => {
    const { client } = fakeClient({
      data: [
        {
          id: 'd1',
          user_id: FARMER_A,
          image_bucket: STORAGE_BUCKETS.cropImages,
          image_path: `${FARMER_A}/2026/09/d1.jpg`,
        },
      ],
      error: null,
    });

    await expect(
      retentionStoreFrom(client).dueFullImages({ cutoff: NOW, limit: 1 }),
    ).resolves.toEqual([
      {
        id: 'd1',
        userId: FARMER_A,
        bucket: STORAGE_BUCKETS.cropImages,
        path: `${FARMER_A}/2026/09/d1.jpg`,
      },
    ]);
  });

  it('never reads a failed candidate query as an empty result', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });

    await expect(
      retentionStoreFrom(client).dueFullImages({ cutoff: NOW, limit: 1 }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      context: { reason: 'retention_candidate_read_failed' },
    });
  });

  it('stamps exactly one column, anchored on id AND user_id (Requirements 18.7, 18.8)', async () => {
    const { client, calls } = fakeClient({ data: [{ id: 'd1' }], error: null });

    const stamped = await retentionStoreFrom(client).stampFullImageDeleted({
      id: 'd1',
      userId: FARMER_A,
      deletedAt: NOW,
    });

    expect(stamped).toBe(true);

    const payloads = argsOf(calls, 'update');
    expect(payloads).toHaveLength(1);
    // Requirement 18.7's "leaves every other column of that row unchanged", mechanically: one key.
    // `image_path` in particular survives, because the thumbnail path is derived from it.
    expect(Object.keys(payloads[0]?.[0] as object)).toEqual(['full_image_deleted_at']);
    expect(payloads[0]?.[0]).toEqual({ full_image_deleted_at: NOW.toISOString() });

    expect(argsOf(calls, 'eq')).toEqual([
      ['id', 'd1'],
      ['user_id', FARMER_A],
    ]);
    // The third predicate: two overlapping runs cannot both stamp one row (V21 allows an overlap).
    expect(argsOf(calls, 'is')).toEqual([['full_image_deleted_at', null]]);
  });

  it('reports an already-stamped row as not stamped rather than as an error', async () => {
    const { client } = fakeClient({ data: [], error: null });

    await expect(
      retentionStoreFrom(client).stampFullImageDeleted({
        id: 'd1',
        userId: FARMER_A,
        deletedAt: NOW,
      }),
    ).resolves.toBe(false);
  });
});

/* ========================================================================== */
/* Requirements 18.6 and 18.9, structurally                                     */
/* ========================================================================== */

describe('the sweep cannot delete a database row (Requirement 18.6)', () => {
  // Read off disk rather than through `import.meta.url`: under the jsdom test environment that
  // value is not a `file:` URL. Vitest runs with the project root as its working directory.
  const raw = readFileSync(join(process.cwd(), 'src', 'services', 'retention.service.ts'), 'utf8');

  /**
   * Comments blanked with the CI guard's own function, for the reason that guard exists: this
   * module's header *documents* that it issues no `.delete(` and no `.rpc(`, and a sentence about a
   * thing must not read as a use of it. Blanking preserves every offset, so the `server-only`
   * assertion below still reads the real first line.
   */
  const moduleSource = blankComments(raw);

  it('issues no PostgREST delete and no rpc', () => {
    // `.remove(` is the storage verb and is expected; `.delete(` is the table verb and must not
    // appear at all. No `.rpc(` either: a database function could delete rows out of sight.
    expect(moduleSource).not.toMatch(/\.delete\(/);
    expect(moduleSource).not.toMatch(/\.rpc\(/);
    expect(moduleSource).toMatch(/\.remove\(/);
  });

  it('names only `diagnoses` among the farmer-scoped tables', () => {
    for (const table of ['messages', 'conversations', 'usage_logs', 'counters', 'profiles']) {
      expect(moduleSource).not.toContain(`from('${table}')`);
    }
    expect(moduleSource).toContain("from('diagnoses')");
  });

  it('offers exactly two database operations, neither of which removes a row', () => {
    const { client } = fakeClient({ data: [], error: null });

    // A bounded read and a single-column stamp. A third operation is where a row deletion would
    // have to arrive, so the seam's width is the enforcement of Requirement 18.6.
    expect(Object.keys(retentionStoreFrom(client)).sort()).toEqual([
      'dueFullImages',
      'stampFullImageDeleted',
    ]);
  });

  it('is a server-only module (Requirements 18.9, 18.11)', () => {
    expect(moduleSource.startsWith("import 'server-only';")).toBe(true);
  });
});

describe('removeObjects', () => {
  it('makes no call for an empty batch', async () => {
    const remover = fakeRemover();

    await expect(removeObjects(remover.client, STORAGE_BUCKETS.cropImages, [])).resolves.toEqual({
      removed: [],
      absent: [],
    });
    expect(remover.calls).toEqual([]);
  });

  it('reads only `name` from the response and ignores the deprecated fields', async () => {
    const path = `${FARMER_A}/2026/09/only-name.jpg`;
    const client: ObjectRemoveClient = {
      storage: {
        from: () => ({
          remove: async () => ({
            data: [{ bucket_id: 'crop-images', id: 'x' }, { name: path }],
            error: null,
          }),
        }),
      },
    };

    await expect(
      removeObjects(client, STORAGE_BUCKETS.cropImages, [path, `${FARMER_A}/2026/09/other.jpg`]),
    ).resolves.toEqual({ removed: [path], absent: [`${FARMER_A}/2026/09/other.jpg`] });
  });

  it('treats a thrown storage call as a batch failure rather than a deletion', async () => {
    const client: ObjectRemoveClient = {
      storage: {
        from: () => ({
          remove: async () => {
            throw new Error('network');
          },
        }),
      },
    };

    const outcome = await removeObjects(client, STORAGE_BUCKETS.cropImages, ['a/b.jpg']);

    expect(outcome.removed).toEqual([]);
    expect(outcome.error).toBeInstanceOf(Error);
  });
});
