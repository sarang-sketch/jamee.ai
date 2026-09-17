import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

/**
 * Harness smoke test: proves the property project runs and fast-check is wired.
 * The design's numbered correctness properties land in their own files in later tasks.
 */
describe('property harness', () => {
  it('runs a fast-check property', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect([...value].length).toBeLessThanOrEqual(value.length);
      }),
    );
  });
});
