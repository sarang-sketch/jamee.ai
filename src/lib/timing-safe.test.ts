import { describe, expect, it } from 'vitest';

import { timingSafeEqualStrings } from '@/lib/timing-safe';

/**
 * Unit tests for `src/lib/timing-safe.ts` — the one constant-time string comparison in the
 * codebase, shared by the Telegram webhook secret (Requirement 11.2) and the retention-sweep
 * `CRON_SECRET` (Requirement 18.12).
 */

const SECRET = 'timing-safe-unit-secret-9a8b7c6d5e';

describe('timingSafeEqualStrings', () => {
  it('handles null and undefined as non-matches without throwing', () => {
    expect(timingSafeEqualStrings(null, SECRET)).toBe(false);
    expect(timingSafeEqualStrings(undefined, SECRET)).toBe(false);
  });

  it('matches identical strings', () => {
    expect(timingSafeEqualStrings(SECRET, SECRET)).toBe(true);
  });

  it('rejects a different value of the same length', () => {
    expect(timingSafeEqualStrings(SECRET.slice(0, -1) + 'X', SECRET)).toBe(false);
  });

  it('rejects a different-length value', () => {
    expect(timingSafeEqualStrings(SECRET + 'x', SECRET)).toBe(false);
    expect(timingSafeEqualStrings(SECRET.slice(0, -1), SECRET)).toBe(false);
  });

  it('rejects the empty string against a non-empty secret', () => {
    expect(timingSafeEqualStrings('', SECRET)).toBe(false);
  });
});
