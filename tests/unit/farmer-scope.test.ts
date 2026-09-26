import { describe, expect, it } from 'vitest';

import { owned, stampOwner } from '@/lib/db/farmer';
import { VERIFIED_CONDITION_NAMES } from '@/lib/db/names';
import { VERIFIED_CONDITIONS } from '@/lib/schemas';

/**
 * Unit proof that the Data_Access_Layer's owner merge and owner stamp cannot be bypassed (task
 * 52.4), at the pure-function level. The DB-backed half — that farmer A's rows are invisible to
 * farmer B through the live accessors — is in `tests/integration/data-access.test.ts`; these are
 * the fast, I/O-free assertions the unit project runs.
 *
 * Requirements: 13.1, 13.2 (every read/write is scoped to the owning Farmer, never unscoped)
 * Design: D18 (`owned`/`stampOwner` are the single merge/stamp sites every accessor routes through)
 */

describe('owned() — the filter merge', () => {
  it('injects the bound owner into an empty filter', () => {
    expect(owned('farmer-A', {})).toEqual({ ownerId: 'farmer-A' });
  });

  it('preserves the caller filter while adding the owner', () => {
    expect(owned('farmer-A', { channel: 'web' })).toEqual({ channel: 'web', ownerId: 'farmer-A' });
  });

  it('the bound owner WINS over an ownerId the caller tried to smuggle in', () => {
    // Even if a caller casts around the type and passes ownerId, the merge overrides it.
    const merged = owned('farmer-A', { ownerId: 'farmer-B' } as unknown as Record<string, unknown>);
    expect((merged as { ownerId: string }).ownerId).toBe('farmer-A');
  });
});

describe('stampOwner() — the insert stamp', () => {
  it('stamps the bound owner onto a document with no owner', () => {
    expect(stampOwner<{ ownerId: string; channel: string }>('farmer-A', { channel: 'web' })).toEqual({
      channel: 'web',
      ownerId: 'farmer-A',
    });
  });

  it('the bound owner WINS over an ownerId the caller tried to smuggle in', () => {
    const doc = stampOwner<{ ownerId: string; channel: string }>(
      'farmer-A',
      { channel: 'web', ownerId: 'farmer-B' } as unknown as { channel: string },
    );
    expect(doc.ownerId).toBe('farmer-A');
  });

  it('leaves the rest of the document untouched', () => {
    const doc = stampOwner<{ ownerId: string; channel: string; createdAt: Date }>('farmer-A', {
      channel: 'telegram',
      createdAt: new Date(0),
    });
    expect(doc.channel).toBe('telegram');
    expect(doc.createdAt).toEqual(new Date(0));
  });
});

describe('the verified-condition names cannot drift from the schema', () => {
  it('names.ts VERIFIED_CONDITION_NAMES equals schemas.ts VERIFIED_CONDITIONS byte-for-byte', () => {
    // The node-run setup script copies the names into names.ts; this keeps that copy honest (4.1).
    expect([...VERIFIED_CONDITION_NAMES]).toEqual([...VERIFIED_CONDITIONS]);
  });
});
