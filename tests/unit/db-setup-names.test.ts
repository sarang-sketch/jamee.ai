import { describe, expect, it } from 'vitest';

import { COLLECTIONS, MEDIA_BUCKET, VERIFIED_CONDITION_NAMES } from '@/lib/db/names';
import { SETUP_NAMES } from '@/lib/db/setup';

/**
 * `src/lib/db/setup.ts` declares the collection names, the GridFS bucket, and the five condition
 * names LOCALLY rather than importing them from `@/lib/db/names`, so that the node-run
 * `scripts/db-setup.ts` (which resolves neither the `@/` alias nor an extensionless relative import)
 * can load it. This test is the guard that keeps that duplication from drifting from the canonical
 * source — the same discipline the verified-condition list uses (Requirement 4.1's safety gate).
 */

describe('db setup names stay in step with the canonical @/lib/db/names', () => {
  it('collection names match', () => {
    expect(SETUP_NAMES.collections).toEqual(COLLECTIONS);
  });

  it('the GridFS bucket name matches', () => {
    expect(SETUP_NAMES.mediaBucket).toBe(MEDIA_BUCKET);
  });

  it('the five verified-condition names match', () => {
    expect([...SETUP_NAMES.verifiedConditionNames]).toEqual([...VERIFIED_CONDITION_NAMES]);
  });
});
