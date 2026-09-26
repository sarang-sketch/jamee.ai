import { describe, expect, it, vi } from 'vitest';

import { isAppError } from '@/lib/errors';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_OPTIONS,
  normalizeDisplayName,
  parseProfileSettings,
  readProfileSettings,
  saveProfileSettings,
} from '@/lib/profile';

/**
 * Unit tests for `src/lib/profile.ts` — pure validation plus the read/write seams (no DAL, no
 * driver, so it needs no `server-only` and no mock of Mongo).
 *
 * Requirements: 1.8 (both values persisted), 9.1 (the three languages), 13.2 (own-row only — the
 *               write goes through the seam the caller binds to `farmerData(userId)`)
 * Design: "Frontend"; D18
 */

describe('normalizeDisplayName', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeDisplayName('  Asha  ')).toBe('Asha');
  });
  it('an empty or whitespace-only name becomes null (the field is optional)', () => {
    expect(normalizeDisplayName('')).toBeNull();
    expect(normalizeDisplayName('   ')).toBeNull();
    expect(normalizeDisplayName(null)).toBeNull();
    expect(normalizeDisplayName(undefined)).toBeNull();
  });
});

describe('LANGUAGE_OPTIONS / DEFAULT_LANGUAGE', () => {
  it('offers exactly the three supported languages (9.1)', () => {
    expect([...LANGUAGE_OPTIONS].sort()).toEqual(['en', 'hi', 'mr']);
  });
  it('defaults to en (the collection default)', () => {
    expect(DEFAULT_LANGUAGE).toBe('en');
  });
});

describe('parseProfileSettings', () => {
  it('accepts each supported language and normalizes the name', () => {
    for (const language of LANGUAGE_OPTIONS) {
      expect(parseProfileSettings({ displayName: '  Ravi ', language })).toEqual({ displayName: 'Ravi', language });
    }
  });

  it('rejects an unsupported language with LANGUAGE_UNSUPPORTED (9.5)', () => {
    try {
      parseProfileSettings({ displayName: 'Ravi', language: 'fr' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) expect(error.code).toBe('LANGUAGE_UNSUPPORTED');
    }
  });
});

describe('readProfileSettings', () => {
  it('maps a row to the settings shape', async () => {
    const settings = await readProfileSettings(async () => ({ displayName: 'Asha', language: 'hi' }));
    expect(settings).toEqual({ displayName: 'Asha', language: 'hi' });
  });
  it('a null row returns null (no profile yet — a state, not an error)', async () => {
    expect(await readProfileSettings(async () => null)).toBeNull();
  });
  it('a missing displayName becomes null', async () => {
    expect(await readProfileSettings(async () => ({ language: 'mr' }))).toEqual({ displayName: null, language: 'mr' });
  });
});

describe('saveProfileSettings', () => {
  it('validates then writes exactly displayName + language, and echoes what was stored (1.8)', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const result = await saveProfileSettings(write, { displayName: '  Asha ', language: 'hi' });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ displayName: 'Asha', language: 'hi' });
    // Never phone, never _id.
    const written = write.mock.calls[0]![0];
    expect(Object.keys(written).sort()).toEqual(['displayName', 'language']);
    expect(result).toEqual({ displayName: 'Asha', language: 'hi' });
  });

  it('does not write when validation fails', async () => {
    const write = vi.fn();
    await expect(saveProfileSettings(write, { displayName: 'x', language: 'de' })).rejects.toSatisfy((e: unknown) => {
      return isAppError(e) && e.code === 'LANGUAGE_UNSUPPORTED';
    });
    expect(write).not.toHaveBeenCalled();
  });
});
