import { describe, expect, it } from 'vitest';

import { metadata } from '@/app/layout';

/**
 * Harness smoke test: proves the unit project runs, the `@/*` alias resolves, and TSX
 * modules transform. Behavioural tests arrive with the modules they cover.
 */
describe('unit harness', () => {
  it('resolves the @/* path alias', () => {
    expect(metadata.title).toBe('Jamee');
  });

  it('runs in a DOM environment', () => {
    expect(typeof document).toBe('object');
  });
});
