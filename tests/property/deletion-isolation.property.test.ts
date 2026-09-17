import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MEDIA_RETENTION_DAYS, RETENTION_SWEEP_BATCH_LIMIT } from '@/lib/config/media';
import { STORAGE_BUCKETS, type StorageBucket } from '@/lib/config/verified';
import { isAppError, type AppError } from '@/lib/errors';
import { isThumbPath, ownerSegmentOf, thumbPathFor } from '@/lib/storage';
import {
  assertPathOwnedByRow,
  orphanOwnerSegment,
  retentionCutoff,
  retentionStoreFrom,
  sweepFullImages,
  sweepOrphans,
  type FullImageCandidate,
  type OrphanObjectSource,
  type RetentionStore,
  type StoredObject,
} from '@/services/retention.service';
import type { ObjectRemoveClient } from '@/services/voice.service';
import type { Database } from '@/types/database';

import { TENANT_INDEPENDENT_STATEMENTS } from '../../scripts/check-secret-scope';

/**
 * ### Property 31: Tenant isolation holds over deletion
 *
 * =============================================================================
 * THE PROPERTY STATEMENT HAD TO BE RECONSTRUCTED — READ THIS FIRST
 * =============================================================================
 *
 * **`design.md` carries no body for Property 31.** Its "Correctness Properties" section ends at
 * Property 30; there is no `### Property 31` entry at all. The number was introduced by the
 * media-lifecycle amendment, which added the retention design and closed its RLS discussion with a
 * forward reference only:
 *
 *   > *"Tenant isolation during deletion is therefore the same predicate that Property 5 already
 *   > holds for reads, applied to a second verb. Property 31 states it over deletion."*
 *
 * `tasks.md` 35.2 supplies the title — *"Property 31: Tenant isolation holds over deletion"* — and
 * the one requirement it validates. So the statement asserted below was **derived from Requirement
 * 18.8 and the retention design section**, and deliberately not widened past them:
 *
 *   > **18.8** — *"THE Retention_Sweep SHALL delete an object only under the path prefix of the
 *   > Farmer who owns the row that references it."*
 *
 * and the design's three deletion anchors, which say how that predicate is met:
 *
 *   > *"Scan 1 deletes only `image_path` values read off a `diagnoses` row, and asserts the path's
 *   > first segment equals that row's `user_id` before issuing the delete. A mismatch is a hard
 *   > error, not a skipped row … Scan 2's candidates come from the storage schema rather than from a
 *   > row, so its `user_id` anchor is the path's own first segment; it deletes only under
 *   > `{first_segment}/` and never widens."*
 *
 * **The statement as implemented here:**
 *
 * *For any batch of retention candidates drawn from any number of distinct farmers, every object path
 * the sweep hands to a delete is a path it read off a row, under the path prefix of that row's own
 * `user_id`; a single candidate whose path is not under its own row's prefix ends the invocation with
 * no deletion issued at all and no row stamped; every deletion-instant stamp is anchored on both that
 * row's id and that row's `user_id` and writes no other column; and for a candidate that has no
 * owning row — the orphan backstop, whose only tenant anchor is the path's own first folder — a path
 * with no usable owner folder is refused rather than deleted, and no path outside the ones storage
 * reported is ever deleted.*
 *
 * Nothing beyond Requirement 18.8 is claimed. In particular this file asserts **nothing** about
 * *which* objects are due (18.3), about thumbnails surviving (18.5) beyond the fact that a retained
 * path is not a deleted one, about the row-preservation rule (18.6) beyond the seam surface, or about
 * the endpoint's 401 (18.12) — those are 35.1's own tests and other requirements' claims.
 *
 * =============================================================================
 * WHICH HALF IS HERE, AND WHICH HALF IS NOT
 * =============================================================================
 *
 * Requirement 18.8 is the one part of Jamee's tenant story that is **entirely the application's**,
 * and that is why it is fully assertable here. The sweep runs on the service-role client, which
 * bypasses RLS and bypasses the storage path policies, so — in the design's own words — *"neither of
 * them constrains the sweep"* and *"the application check is the boundary"*. There is nothing behind
 * it to defer to.
 *
 * What is still deferred to the integration project (real Postgres, gated behind
 * `JAMEE_TEST_DATABASE_URL` — `tests/integration/database.ts`) is the *other* isolation half that
 * deletion sits inside: that RLS and the storage policies deny a *farmer* the delete verb in the
 * first place, so the sweep is the only deleter. `0009` narrows the object policies to
 * `select, insert` for exactly that reason, and Property 27's file asserts the policy text;
 * `tests/integration/harness.test.ts` is where two real sessions confront the live policies. This
 * file asserts what the sweep does with the credential that bypasses them.
 *
 * =============================================================================
 * WHY THE STORE IS A TRIPWIRE AND NOT JUST A FAKE
 * =============================================================================
 *
 * `RetentionStore` has exactly two operations and `retention.service.ts` says the narrowness *is* the
 * enforcement: *"A `deleteRow`, a `purge`, or a generic `update` here would be the seam Requirement
 * 18.6 forbids."* So the store handed to the sweep below is wrapped in a `Proxy` that throws on any
 * property other than those two, and the remover throws for any bucket outside the two Jamee has.
 * A sweep that reached for a third operation fails the run rather than being caught by a reviewer.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const CROP_IMAGES = STORAGE_BUCKETS.cropImages;
const VOICE_MESSAGES = STORAGE_BUCKETS.voiceMessages;

/** Fixed, so the run owns its clock. `retentionCutoff()` derives the window from it. */
const NOW = new Date('2026-09-15T19:30:00.000Z');
const CUTOFF = retentionCutoff(NOW, MEDIA_RETENTION_DAYS);

/** Comfortably older than the window, so age is never the reason a candidate is skipped. */
const LONG_PAST = new Date(CUTOFF.getTime() - 30 * 24 * 60 * 60 * 1000);

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const farmerIdArb = fc.uuid();

/** Two to four *distinct* farmers, so a batch really is drawn from more than one tenant. */
const farmerPoolArb = fc
  .uniqueArray(farmerIdArb, { minLength: 2, maxLength: 4 })
  .filter((pool) => new Set(pool).size === pool.length);

const yearArb = fc.integer({ min: 2024, max: 2099 }).map(String);
const monthArb = fc.integer({ min: 1, max: 12 }).map((month) => String(month).padStart(2, '0'));
const extensionArb = fc.constantFrom('jpg', 'jpeg', 'png', 'webp');

interface PathParts {
  readonly year: string;
  readonly month: string;
  readonly objectId: string;
  readonly extension: string;
}

const pathPartsArb = fc.record({
  year: yearArb,
  month: monthArb,
  objectId: fc.uuid(),
  extension: extensionArb,
});

/** `{user_id}/{YYYY}/{MM}/{uuid}.{ext}` — the convention `0009` records and `buildStorageRef()` emits. */
function conformingPath(owner: string, parts: PathParts): string {
  return `${owner}/${parts.year}/${parts.month}/${parts.objectId}.${parts.extension}`;
}

/**
 * How a candidate row's `image_path` may relate to its own `user_id`.
 *
 * `owned` is the only one Requirement 18.8 permits a deletion for. The other four are the shapes a
 * corrupt row or a corrupt path convention can take, enumerated so the run proves it reached each —
 * a `oneof` branch that never generated would leave its expectation green rather than absent.
 */
const CANDIDATE_KINDS = [
  'owned',
  'other_farmer_prefix',
  'no_owner_segment',
  'bucket_root',
  'empty_owner_segment',
] as const;

type CandidateKind = (typeof CANDIDATE_KINDS)[number];

const CORRUPT_KINDS: readonly CandidateKind[] = CANDIDATE_KINDS.filter((kind) => kind !== 'owned');

interface PlannedCandidate {
  readonly kind: CandidateKind;
  /** The row's `user_id` — the farmer who owns the row that references the object. */
  readonly owner: string;
  readonly bucket: StorageBucket;
  readonly path: string;
}

/** A candidate row whose path really is under its own owner's prefix. */
function ownedCandidate(owner: string, bucket: StorageBucket, parts: PathParts): PlannedCandidate {
  return { kind: 'owned', owner, bucket, path: conformingPath(owner, parts) };
}

/** The same row with its path corrupted in one of the four ways it can lose its anchor. */
function corruptCandidate(
  kind: CandidateKind,
  owner: string,
  other: string,
  bucket: StorageBucket,
  parts: PathParts,
): PlannedCandidate {
  switch (kind) {
    case 'other_farmer_prefix':
      return { kind, owner, bucket, path: conformingPath(other, parts) };
    case 'no_owner_segment':
      return {
        kind,
        owner,
        bucket,
        path: `${parts.year}/${parts.month}/${parts.objectId}.${parts.extension}`,
      };
    case 'bucket_root':
      return { kind, owner, bucket, path: `${parts.objectId}.${parts.extension}` };
    case 'empty_owner_segment':
      return { kind, owner, bucket, path: `/${parts.year}/${parts.objectId}.${parts.extension}` };
    case 'owned':
      return ownedCandidate(owner, bucket, parts);
  }
}

const bucketArb = fc.constantFrom<StorageBucket>(CROP_IMAGES, VOICE_MESSAGES);

/* ========================================================================== */
/* The counting seams                                                          */
/* ========================================================================== */

interface RemoveCall {
  readonly bucket: string;
  readonly paths: readonly string[];
}

interface StampCall {
  readonly id: string;
  readonly userId: string;
  readonly deletedAt: string;
}

interface Harness {
  readonly store: RetentionStore;
  readonly remover: ObjectRemoveClient;
  readonly removes: readonly RemoveCall[];
  readonly stamps: readonly StampCall[];
}

/**
 * The two seams, counting, with two tripwires.
 *
 * `reportAbsent` models the one asymmetry Requirement 18.10 turns on: storage's `remove()` may not
 * report back a path that was already gone, and the sweep must treat that as deleted. It changes what
 * is *counted*, never what is *deleted*, which is why the isolation assertions below read
 * `removes` — the paths the sweep asked for — rather than the report.
 */
function harness(options: {
  readonly candidates: readonly (FullImageCandidate & { readonly bucket: string })[];
  readonly reportAbsent: boolean;
}): Harness {
  const removes: RemoveCall[] = [];
  const stamps: StampCall[] = [];

  const real: RetentionStore = {
    dueFullImages: () => Promise.resolve(options.candidates),
    stampFullImageDeleted: ({ id, userId, deletedAt }) => {
      stamps.push({ id, userId, deletedAt: deletedAt.toISOString() });
      return Promise.resolve(true);
    },
  };

  /**
   * Requirement 18.6 at the seam: there is no third operation to reach for, and reaching for one is
   * a failure rather than a `undefined is not a function` several frames away.
   */
  const store = new Proxy(real, {
    get(target, property) {
      if (property === 'dueFullImages' || property === 'stampFullImageDeleted') {
        return target[property as keyof RetentionStore];
      }
      throw new Error(
        `the sweep read "${String(property)}" off its store. RetentionStore has exactly two ` +
          'operations, and that narrowness is how Requirement 18.6 is enforced.',
      );
    },
  });

  const remover: ObjectRemoveClient = {
    storage: {
      from: (bucket: string) => {
        if (bucket !== CROP_IMAGES && bucket !== VOICE_MESSAGES) {
          throw new Error(`the sweep addressed the bucket "${bucket}", which Jamee does not have`);
        }
        return {
          remove: (paths: string[]) => {
            removes.push({ bucket, paths: [...paths] });
            return Promise.resolve({
              // V22: only `name` is read off the response, and a path missing from it counts as
              // already absent rather than as a failure.
              data: options.reportAbsent ? [] : paths.map((path) => ({ name: path })),
              error: null,
            });
          },
        };
      },
    },
  };

  return { store, remover, removes, stamps };
}

/** Every path the sweep asked storage to delete, in the order it asked. */
function requestedPaths(removes: readonly RemoveCall[]): readonly string[] {
  return removes.flatMap((call) => call.paths);
}

async function refusalOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('the corrupt candidate was accepted; Requirement 18.8 requires a refusal');
}

/* ========================================================================== */
/* Scan 1 — row-driven deletion                                                */
/* ========================================================================== */

describe('Property 31, scan 1: a deletion happens only under the owning row’s own prefix', () => {
  interface Batch {
    readonly pool: readonly string[];
    readonly planned: readonly PlannedCandidate[];
    readonly reportAbsent: boolean;
  }

  /** A batch every candidate of which is properly owned — possibly by several different farmers. */
  const ownedBatchArb: fc.Arbitrary<Batch> = fc
    .record({
      pool: farmerPoolArb,
      rows: fc.array(fc.tuple(fc.nat(), bucketArb, pathPartsArb), { minLength: 1, maxLength: 8 }),
      reportAbsent: fc.boolean(),
    })
    .map(({ pool, rows, reportAbsent }) => ({
      pool,
      reportAbsent,
      planned: rows.map(([index, bucket, parts]) =>
        ownedCandidate(pool[index % pool.length] as string, bucket, parts),
      ),
    }));

  it('asks storage for exactly the paths it read off the rows, each under its own row’s owner', async () => {
    const bucketsSeen = new Set<string>();
    const poolSizesSeen = new Set<number>();
    const absenceSeen = new Set<boolean>();

    await fc.assert(
      fc.asyncProperty(ownedBatchArb, async (batch) => {
        poolSizesSeen.add(batch.pool.length);
        absenceSeen.add(batch.reportAbsent);
        for (const candidate of batch.planned) bucketsSeen.add(candidate.bucket);

        const candidates = batch.planned.map((planned, index) => ({
          id: `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          userId: planned.owner,
          bucket: planned.bucket,
          path: planned.path,
        }));

        const test = harness({ candidates, reportAbsent: batch.reportAbsent });
        const report = await sweepFullImages({
          store: test.store,
          remover: test.remover,
          now: NOW,
          limit: RETENTION_SWEEP_BATCH_LIMIT,
        });

        /* ================================================================== */
        /* Requirement 18.8, stated as a set equality on both sides            */
        /* ================================================================== */

        const asked = requestedPaths(test.removes);
        const rowPaths = candidates.map((candidate) => candidate.path);

        // Nothing extra: every path asked for is a path a row supplied. This is the clause that
        // fails if the sweep ever derives, widens or invents a target — a prefix delete of
        // `{owner}/`, a thumbnail path derived from an original, a listed sibling.
        expect([...asked].sort()).toStrictEqual([...rowPaths].sort());

        // And nothing missing: an object left behind would be a retention bug rather than an
        // isolation one, but a sweep that deleted *nothing* would satisfy 18.8 vacuously, so the
        // positive direction is asserted too.
        expect(asked).toHaveLength(candidates.length);

        // The heart of it: each requested path lies under the prefix of the row that referenced it,
        // matched by identity of (bucket, path) rather than by position.
        for (const call of test.removes) {
          for (const path of call.paths) {
            const row = candidates.find(
              (candidate) => candidate.path === path && candidate.bucket === call.bucket,
            );
            expect(row, `no row referenced ${call.bucket}/${path}`).toBeDefined();
            expect(ownerSegmentOf(path)).toBe(row?.userId);
            expect(path.startsWith(`${row?.userId ?? ''}/`)).toBe(true);
          }
        }

        // One `remove()` call per bucket, addressed to the bucket the *row* named rather than to a
        // constant — so the sweep cannot address a bucket the row did not name.
        expect(test.removes.map((call) => call.bucket).sort()).toStrictEqual(
          [...new Set(candidates.map((candidate) => candidate.bucket))].sort(),
        );

        /* ================================================================== */
        /* The stamp is anchored on the same row, and writes one column        */
        /* ================================================================== */

        expect(test.stamps).toHaveLength(candidates.length);
        for (const stamp of test.stamps) {
          const row = candidates.find((candidate) => candidate.id === stamp.id);
          expect(row, `a stamp named the unknown row ${stamp.id}`).toBeDefined();
          // Requirement 18.7's row, plus `admin.ts`'s anchor: a corrupt candidate list still cannot
          // write across a tenant boundary, because the id alone is never the whole predicate.
          expect(stamp.userId).toBe(row?.userId);
          expect(stamp.deletedAt).toBe(NOW.toISOString());
        }

        // An already-absent object counts as deleted (18.10), so the row is still stamped either
        // way — which is what keeps a re-run from re-deleting.
        expect(report.stamped).toBe(candidates.length);
        expect(report.removed + report.alreadyAbsent).toBe(candidates.length);
        expect(report.failed).toBe(0);
      }),
      { numRuns: 200 },
    );

    expect([...bucketsSeen].sort()).toStrictEqual([CROP_IMAGES, VOICE_MESSAGES].sort());
    expect([...poolSizesSeen].sort()).toStrictEqual([2, 3, 4]);
    expect([...absenceSeen].sort()).toStrictEqual([false, true]);
  });

  /* ------------------------------------------------------------------------ */
  /* One corrupt candidate stops the whole invocation                          */
  /* ------------------------------------------------------------------------ */

  interface CorruptBatch {
    readonly pool: readonly string[];
    readonly planned: readonly PlannedCandidate[];
    readonly corruptKind: CandidateKind;
    readonly corruptAt: number;
  }

  /**
   * A batch of properly owned candidates with **one** corrupted, at a generated position — including
   * the last, which is the interesting one: the design says the whole batch is checked *before* the
   * first delete, so a corruption at the end must still prevent every earlier deletion.
   */
  const corruptBatchArb: fc.Arbitrary<CorruptBatch> = fc
    .record({
      pool: farmerPoolArb,
      rows: fc.array(fc.tuple(fc.nat(), bucketArb, pathPartsArb), { minLength: 1, maxLength: 6 }),
      corruptKind: fc.constantFrom<CandidateKind>(...CORRUPT_KINDS),
      corruptOffset: fc.nat(),
      corruptParts: pathPartsArb,
      corruptBucket: bucketArb,
    })
    .map(({ pool, rows, corruptKind, corruptOffset, corruptParts, corruptBucket }) => {
      const owned = rows.map(([index, bucket, parts]) =>
        ownedCandidate(pool[index % pool.length] as string, bucket, parts),
      );
      const owner = pool[0] as string;
      const other = pool[1] as string;
      const corrupt = corruptCandidate(corruptKind, owner, other, corruptBucket, corruptParts);
      const at = corruptOffset % (owned.length + 1);
      return {
        pool,
        corruptKind,
        corruptAt: at,
        planned: [...owned.slice(0, at), corrupt, ...owned.slice(at)],
      };
    });

  it('deletes nothing at all when one candidate’s path is not under its own row’s prefix', async () => {
    const kindsSeen = new Set<CandidateKind>();
    const positionsSeen = new Set<'first' | 'middle' | 'last'>();

    await fc.assert(
      fc.asyncProperty(corruptBatchArb, async (batch) => {
        kindsSeen.add(batch.corruptKind);
        positionsSeen.add(
          batch.corruptAt === 0
            ? 'first'
            : batch.corruptAt === batch.planned.length - 1
              ? 'last'
              : 'middle',
        );

        const candidates = batch.planned.map((planned, index) => ({
          id: `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          userId: planned.owner,
          bucket: planned.bucket,
          path: planned.path,
        }));

        const test = harness({ candidates, reportAbsent: false });
        const label = `${batch.corruptKind} at ${batch.corruptAt} of ${candidates.length}`;

        const error = await refusalOf(
          sweepFullImages({
            store: test.store,
            remover: test.remover,
            now: NOW,
            limit: RETENTION_SWEEP_BATCH_LIMIT,
          }),
        );

        // A hard error, not a skipped row — the design is explicit that continuing "would be one bad
        // row away from deleting across tenants".
        expect(error.code, label).toBe('INTERNAL_ERROR');
        expect(error.context?.reason, label).toBe('retention_path_owner_mismatch');

        // And the whole point of checking the batch before deleting anything: **zero** deletions and
        // **zero** stamps, however many well-formed candidates preceded the corrupt one.
        expect(test.removes, label).toStrictEqual([]);
        expect(test.stamps, label).toStrictEqual([]);

        // The same predicate, asserted directly on the exported guard, so a caller that used it
        // outside `sweepFullImages` gets the same answer.
        const corrupt = candidates[batch.corruptAt];
        if (corrupt === undefined) throw new Error('the corrupt candidate went missing');
        expect(() => assertPathOwnedByRow(corrupt), label).toThrow();
        expect(ownerSegmentOf(corrupt.path), label).not.toBe(corrupt.userId);
      }),
      { numRuns: 250 },
    );

    expect([...kindsSeen].sort()).toStrictEqual([...CORRUPT_KINDS].sort());
    expect([...positionsSeen].sort()).toStrictEqual(['first', 'last', 'middle']);
  });
});

/* ========================================================================== */
/* Scan 2 — the orphan backstop, whose only anchor is the path itself           */
/* ========================================================================== */

describe('Property 31, scan 2: an object with no owning row is deleted only under its own first folder', () => {
  /**
   * What scan 2's age surface may report. Only `owned_original` is deletable; the other four are the
   * reasons a reported object must survive, and each is a clause of the reconstructed statement or of
   * the design sentence it comes from.
   */
  const OBJECT_KINDS = [
    'owned_original',
    'thumbnail',
    'bucket_root',
    'empty_owner_segment',
    'inside_window',
  ] as const;

  type ObjectKind = (typeof OBJECT_KINDS)[number];

  interface PlannedObject {
    readonly kind: ObjectKind;
    readonly owner: string;
    readonly bucket: StorageBucket;
    readonly path: string;
    readonly createdAt: Date;
  }

  function plan(
    kind: ObjectKind,
    owner: string,
    bucket: StorageBucket,
    parts: PathParts,
  ): PlannedObject {
    const conforming = conformingPath(owner, parts);
    switch (kind) {
      case 'owned_original':
        return { kind, owner, bucket, path: conforming, createdAt: LONG_PAST };
      case 'thumbnail':
        // Built with `thumbPathFor()` — the single owner of the convention — rather than by writing
        // `.thumb.` here, which is exactly the second copy the service's header warns about.
        return { kind, owner, bucket, path: thumbPathFor(conforming), createdAt: LONG_PAST };
      case 'bucket_root':
        return {
          kind,
          owner,
          bucket,
          path: `${parts.objectId}.${parts.extension}`,
          createdAt: LONG_PAST,
        };
      case 'empty_owner_segment':
        return {
          kind,
          owner,
          bucket,
          path: `/${parts.objectId}.${parts.extension}`,
          createdAt: LONG_PAST,
        };
      case 'inside_window':
        // The surface is asked for objects older than the cutoff; it is not trusted to have honoured
        // that, and an object inside the window is not the sweep's to delete under any circumstance.
        return { kind, owner, bucket, path: conforming, createdAt: NOW };
    }
  }

  const plannedObjectsArb = fc
    .record({
      pool: farmerPoolArb,
      objects: fc.array(
        fc.tuple(
          fc.constantFrom<ObjectKind>(...OBJECT_KINDS),
          fc.nat(),
          bucketArb,
          pathPartsArb,
        ),
        { minLength: 1, maxLength: 10 },
      ),
    })
    .map(({ pool, objects }) => ({
      pool,
      planned: objects.map(([kind, index, bucket, parts]) =>
        plan(kind, pool[index % pool.length] as string, bucket, parts),
      ),
    }));

  it('never deletes a path it was not given, and never one with no owning folder', async () => {
    const kindsSeen = new Set<ObjectKind>();

    await fc.assert(
      fc.asyncProperty(plannedObjectsArb, async ({ planned }) => {
        for (const object of planned) kindsSeen.add(object.kind);

        const test = harness({ candidates: [], reportAbsent: false });
        const source: OrphanObjectSource = {
          olderThan: ({ bucket }) =>
            Promise.resolve(
              planned
                .filter((object) => object.bucket === bucket)
                .map<StoredObject>((object) => ({
                  bucket: object.bucket,
                  path: object.path,
                  createdAt: object.createdAt,
                })),
            ),
        };

        const report = await sweepOrphans({
          store: test.store,
          remover: test.remover,
          orphans: source,
          orphanScanEnabled: true,
          now: NOW,
          limit: RETENTION_SWEEP_BATCH_LIMIT,
        });

        const asked = requestedPaths(test.removes);
        const reported = planned.map((object) => object.path);

        // Never widens: every path asked for is a path storage reported. A `{owner}/` prefix delete,
        // or a path derived from a reported one, fails here.
        for (const path of asked) expect(reported).toContain(path);

        // Requirement 18.8 for a candidate with no row behind it: the anchor is the path's own first
        // folder, so a path that has none is refused rather than deleted.
        for (const path of asked) {
          const owner = orphanOwnerSegment(path);
          expect(owner, `${path} was deleted with no owning folder`).toBeDefined();
          expect(path.startsWith(`${owner ?? ''}/`)).toBe(true);
          // The folder really is one of the farmers whose objects were reported — the sweep deletes
          // under a segment it read, never under one it composed.
          expect(reported.some((candidate) => candidate.startsWith(`${owner ?? ''}/`))).toBe(true);
        }

        // The positive direction, so none of the assertions above can pass on an empty batch: an
        // orphaned original past the window under its own folder **is** deleted.
        for (const object of planned) {
          if (object.kind !== 'owned_original') continue;
          expect(asked, `an orphaned original under its own folder survived: ${object.path}`).toContain(
            object.path,
          );
        }

        // The four survivor classes, each checked by identity rather than by count.
        for (const object of planned) {
          if (object.kind === 'owned_original') continue;
          if (object.kind === 'thumbnail' && object.bucket === CROP_IMAGES) {
            expect(isThumbPath(object.path)).toBe(true);
            expect(asked, 'a Thumbnail_Derivative was deleted').not.toContain(object.path);
          }
          if (object.kind === 'bucket_root' || object.kind === 'empty_owner_segment') {
            expect(orphanOwnerSegment(object.path)).toBeUndefined();
            expect(asked, 'an object with no owning folder was deleted').not.toContain(object.path);
          }
        }

        if (!report.ran) {
          throw new Error('the orphan scan was asked to run and reported that it did not');
        }
        expect(report.removed + report.alreadyAbsent).toBe(asked.length);
        expect(report.failed).toBe(0);
        expect(report.scanned).toBe(planned.length);

        // The two counts that account for the survivors, so a class that stopped being recognised
        // would show up as a deletion *and* as a missing count rather than only as the former.
        // The thumbnail exclusion is scoped to `crop-images`, which is the bucket that has
        // derivatives — a `.thumb.` path in `voice-messages` is an ordinary object.
        expect(report.retainedThumbnails).toBe(
          planned.filter((object) => object.kind === 'thumbnail' && object.bucket === CROP_IMAGES)
            .length,
        );
        expect(report.refused).toBe(
          planned.filter(
            (object) => object.kind === 'bucket_root' || object.kind === 'empty_owner_segment',
          ).length,
        );
      }),
      { numRuns: 200 },
    );

    expect([...kindsSeen].sort()).toStrictEqual([...OBJECT_KINDS].sort());
  });

  it('reports that it did not run in the shipped configuration, deleting nothing', async () => {
    const test = harness({ candidates: [], reportAbsent: false });

    // U-V22b is open, so `RETENTION_ORPHAN_SCAN_ENABLED` is false and the scan is off. Asserted
    // because "the scan that does not run deletes nothing" is the shipped behaviour, and a flag
    // flipped without an `OrphanObjectSource` throws rather than sweeping silently.
    const report = await sweepOrphans({ store: test.store, remover: test.remover, now: NOW });

    expect(report).toStrictEqual({ ran: false, reason: 'disabled_pending_v22b' });
    expect(test.removes).toStrictEqual([]);
  });
});

/* ========================================================================== */
/* The two statements the sweep issues, as the real adapter composes them       */
/* ========================================================================== */

interface RecordedStatement {
  readonly table: string;
  readonly verb: 'select' | 'update';
  readonly columns: string;
  readonly predicates: readonly { readonly kind: string; readonly column: string; readonly value: unknown }[];
  readonly payload: unknown;
}

/**
 * A recording client for `retentionStoreFrom()`, so the predicates asserted below are the ones
 * production composes rather than a restatement of them. Same idiom as
 * `chat-context.property.test.ts`; narrow to the two chains this module issues.
 */
function recorder(rows: readonly Record<string, unknown>[]): {
  readonly client: SupabaseClient<Database>;
  readonly statements: readonly RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];

  const from = (table: string): unknown => {
    if (table !== 'diagnoses') {
      throw new Error(`the retention store addressed "${table}"; Requirement 18.6 forbids the rest`);
    }

    const predicates: { kind: string; column: string; value: unknown }[] = [];
    let columns = '';
    let verb: RecordedStatement['verb'] = 'select';
    let payload: unknown;

    const matched = (): readonly Record<string, unknown>[] =>
      rows.filter((row) =>
        predicates.every((predicate) =>
          predicate.kind === 'lt'
            ? String(row[predicate.column]) < String(predicate.value)
            : row[predicate.column] === predicate.value,
        ),
      );

    const settle = (): { data: unknown; error: null } => {
      const found = matched();
      statements.push({ table, verb, columns, predicates: [...predicates], payload });
      return { data: found, error: null };
    };

    const chain = {
      select: (list?: string) => {
        columns = list ?? '';
        return chain;
      },
      update: (values: unknown) => {
        verb = 'update';
        payload = values;
        return chain;
      },
      eq: (column: string, value: unknown) => {
        predicates.push({ kind: 'eq', column, value });
        return chain;
      },
      is: (column: string, value: unknown) => {
        predicates.push({ kind: 'is', column, value });
        return chain;
      },
      lt: (column: string, value: unknown) => {
        predicates.push({ kind: 'lt', column, value });
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      then: (resolve: (value: { data: unknown; error: null }) => unknown) => resolve(settle()),
    };

    return chain;
  };

  return { client: { from } as unknown as SupabaseClient<Database>, statements };
}

describe('Property 31: the stamp is anchored on the row’s own farmer, and the scan is declared', () => {
  it('anchors every stamp on id AND user_id, and writes exactly one column', async () => {
    const outcomesSeen = new Set<'stamped' | 'already_stamped'>();

    await fc.assert(
      fc.asyncProperty(
        fc.tuple(farmerIdArb, farmerIdArb).filter(([a, b]) => a !== b),
        fc.uuid(),
        fc.boolean(),
        async (farmers, rowId, alreadyStamped) => {
          const [owner, other] = farmers;
          outcomesSeen.add(alreadyStamped ? 'already_stamped' : 'stamped');

          const fake = recorder([
            // The row to stamp, plus the other farmer's row carrying the *same* id — impossible in
            // Postgres, and generated precisely so a statement anchored on `id` alone would pick up
            // a second row and be visible here.
            {
              id: rowId,
              user_id: owner,
              full_image_deleted_at: alreadyStamped ? '2026-09-01T00:00:00.000Z' : null,
            },
            { id: rowId, user_id: other, full_image_deleted_at: null },
          ]);

          const didStamp = await retentionStoreFrom(fake.client).stampFullImageDeleted({
            id: rowId,
            userId: owner,
            deletedAt: NOW,
          });

          // A row already stamped by an earlier run matches nothing and reports `false` — the
          // idempotency clause, and the reason the third predicate is there.
          expect(didStamp).toBe(!alreadyStamped);

          const statement = fake.statements[0];
          if (statement === undefined) throw new Error('the stamp issued no statement');
          expect(statement.verb).toBe('update');

          // Requirement 18.7: one column in the payload, so "leaves every other column unchanged" is
          // a property of the statement rather than a promise. `image_path` in particular survives,
          // because the thumbnail path is derived from it.
          expect(Object.keys(statement.payload as Record<string, unknown>)).toStrictEqual([
            'full_image_deleted_at',
          ]);

          // Requirement 18.8's write half: both anchors, with the row's own farmer in the second.
          const columnsUsed = statement.predicates.map((predicate) => predicate.column);
          expect(columnsUsed).toContain('id');
          expect(columnsUsed).toContain('user_id');
          expect(statement.predicates.find((p) => p.column === 'id')?.value).toBe(rowId);
          expect(statement.predicates.find((p) => p.column === 'user_id')?.value).toBe(owner);
          expect(statement.predicates.find((p) => p.column === 'full_image_deleted_at')?.value).toBe(
            null,
          );
        },
      ),
      { numRuns: 100 },
    );

    expect([...outcomesSeen].sort()).toStrictEqual(['already_stamped', 'stamped']);
  });

  it('declares the one unanchored statement it makes, and reads only the four columns it acts on', async () => {
    const fake = recorder([]);
    await retentionStoreFrom(fake.client).dueFullImages({ cutoff: CUTOFF, limit: 10 });

    const statement = fake.statements[0];
    if (statement === undefined) throw new Error('the candidate scan issued no statement');

    // No `user_id` predicate, deliberately: the scan ages media out for the whole deployment. What
    // makes that acceptable is that it is a *declared* exemption in the static gate, with the
    // per-row anchors that replace it named — so the exemption is reviewed rather than assumed.
    expect(statement.predicates.map((predicate) => predicate.column)).not.toContain('user_id');

    const declared = TENANT_INDEPENDENT_STATEMENTS.filter(
      (entry) => entry.path === 'src/services/retention.service.ts',
    );
    expect(declared).toHaveLength(1);
    expect(declared[0]?.table).toBe('diagnoses');
    expect(declared[0]?.verb).toBe('select');
    expect(declared[0]?.why).toContain('user_id');

    // And the columns: the four the sweep acts on rather than `*`, so a widening of the row cannot
    // widen what the sweep sees — `user_id` among them, since it is the anchor everything else uses.
    expect(statement.columns).toBe('id, user_id, image_bucket, image_path');
  });
});

/* ========================================================================== */
/* The endpoint cannot aim the sweep                                           */
/* ========================================================================== */

describe('Property 31: no caller-supplied value can reach a delete target', () => {
  /**
   * The ways a route handler could let a request influence what gets deleted. Enumerated rather than
   * described, so this is a closed check: the sweep's window, batch bound and candidate set are
   * configuration, and the design's reason is that *"a sweep that took its window from a caller would
   * be a way to delete newer media than the policy allows"*.
   */
  const REQUEST_READERS = [
    'request.json',
    'request.text',
    'request.formData',
    'request.arrayBuffer',
    'request.body',
    'searchParams',
    'nextUrl',
  ] as const;

  it('invokes the sweep with no arguments and reads nothing but one header', () => {
    const source = readFileSync(
      join(
        resolve(__dirname, '..', '..'),
        'src',
        'app',
        'api',
        'internal',
        'retention-sweep',
        'route.ts',
      ),
      'utf8',
    );
    // Comments stripped: this module's header discusses several of the expressions below in prose.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // The call carries nothing. Not a `deps` object, not a limit, not a window — so there is no
    // parameter for a caller's value to travel through even if one were read.
    expect(code).toContain('runRetentionSweep()');
    expect(code).not.toMatch(/runRetentionSweep\(\s*[^)\s]/);

    for (const reader of REQUEST_READERS) {
      expect(code, `the sweep route reads ${reader}`).not.toContain(reader);
    }

    // One header, and it is the credential. `headers.get` appears once, inside `authorizeSweep`.
    expect([...code.matchAll(/headers\.get\(/g)]).toHaveLength(1);
    expect(code).toContain("headers.get('authorization')");
  });
});
