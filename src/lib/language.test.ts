import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE,
  languageCookie,
  languageOptions,
  parseLanguage,
  resolveLanguage,
} from '@/lib/language';
import { messages } from '@/lib/messages';
import { SUPPORTED_LANGUAGES } from '@/lib/schemas';

/**
 * Unit tests for what the switcher offers and how the active language is resolved.
 *
 * Requirements: 9.1 (English, Hindi and Marathi are the selectable Supported_Languages),
 *               9.2 (a selection survives to subsequent requests — the cookie half),
 *               9.5 (an unsupported code is refused, so Jamee's own client never sends one),
 *               1.8 (the Profile's preferred language is the standing default)
 */

describe('languageOptions', () => {
  /** Requirement 9.1 — exactly the three, and exactly the schema's three. */
  it('offers the three Supported_Languages from the schema enum', () => {
    expect(languageOptions().map((option) => option.code)).toEqual([...SUPPORTED_LANGUAGES]);
    expect(languageOptions()).toHaveLength(3);
    expect([...SUPPORTED_LANGUAGES]).toEqual(['en', 'hi', 'mr']);
  });

  /**
   * The label a farmer picks by has to be readable in the language it selects. `English` is
   * Latin; the other two must be Devanagari, or a Marathi speaker is being asked to read English
   * to escape English.
   */
  it('labels each language in its own script', () => {
    const labels = new Map(languageOptions().map((option) => [option.code, option.label]));
    const devanagari = /[\u0900-\u097F]/;

    expect(labels.get('en')).toBe('English');
    expect(labels.get('hi')).toBe('\u0939\u093F\u0928\u094D\u0926\u0940'); // हिन्दी
    expect(labels.get('mr')).toBe('\u092E\u0930\u093E\u0920\u0940'); // मराठी
    expect(devanagari.test(labels.get('hi') ?? '')).toBe(true);
    expect(devanagari.test(labels.get('mr') ?? '')).toBe(true);
  });

  /** The label comes from that option's own catalog, not from whichever one is active. */
  it('reads every label from the catalog of the language it names', () => {
    for (const { code, label } of languageOptions()) {
      expect(label).toBe(messages(code).languageNames[code]);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  /** Requirement 9.5: nothing outside the enum is offered, so no request can carry one. */
  it('offers no code the schema would reject', () => {
    for (const { code } of languageOptions()) {
      expect(parseLanguage(code)).toBe(code);
    }
    expect(languageOptions().map((option) => option.code)).not.toContain('fr');
  });
});

describe('parseLanguage', () => {
  it('accepts the three supported codes', () => {
    expect(parseLanguage('en')).toBe('en');
    expect(parseLanguage('hi')).toBe('hi');
    expect(parseLanguage('mr')).toBe('mr');
  });

  it('rejects anything else, including near-misses', () => {
    expect(parseLanguage('fr')).toBeNull();
    expect(parseLanguage('EN')).toBeNull();
    expect(parseLanguage('en-IN')).toBeNull();
    expect(parseLanguage('mar')).toBeNull();
    expect(parseLanguage('')).toBeNull();
    expect(parseLanguage(null)).toBeNull();
    expect(parseLanguage(undefined)).toBeNull();
    expect(parseLanguage(0)).toBeNull();
  });
});

describe('resolveLanguage', () => {
  /** Requirement 1.8's value is the default a farmer gets before they touch the switcher. */
  it('defaults to the profile value when nothing has been selected', () => {
    expect(resolveLanguage(undefined, 'hi')).toBe('hi');
    expect(resolveLanguage(null, 'mr')).toBe('mr');
    expect(resolveLanguage(undefined, 'en')).toBe('en');
  });

  /** Requirement 9.2: the selection is what subsequent renders and requests must use. */
  it('lets a selection outrank the profile default', () => {
    expect(resolveLanguage('en', 'mr')).toBe('en');
    expect(resolveLanguage('mr', 'en')).toBe('mr');
  });

  it('falls through an unsupported selection to the profile', () => {
    expect(resolveLanguage('fr', 'mr')).toBe('mr');
    expect(resolveLanguage('', 'hi')).toBe('hi');
  });

  it('falls back to en only when neither source says anything usable', () => {
    expect(resolveLanguage(null, null)).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage('fr', 'de')).toBe(DEFAULT_LANGUAGE);
    expect(DEFAULT_LANGUAGE).toBe('en');
  });

  /**
   * The pre-profile default and the column default have to be the same value, or a farmer's
   * first screen and their first saved Profile would disagree about a language they never chose.
   */
  it('shares its fallback with the profiles.language column default', () => {
    // `process.cwd()` rather than `import.meta.url`: the unit project runs in jsdom, where
    // `import.meta.url` is not a `file:` URL. Vitest's cwd is the project root.
    const migration = readFileSync(
      resolve(process.cwd(), 'supabase', 'migrations', '0002_profiles.sql'),
      'utf8',
    );
    const match = /language\s+text not null default '(\w+)'/.exec(migration);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(DEFAULT_LANGUAGE);
  });
});

describe('languageCookie', () => {
  it('writes a readable, site-wide, long-lived preference', () => {
    const cookie = languageCookie('mr');
    expect(cookie.startsWith(`${LANGUAGE_COOKIE}=mr;`)).toBe(true);
    expect(cookie).toContain('path=/');
    expect(cookie).toContain('samesite=lax');
    expect(cookie).toMatch(/max-age=\d+/);
    // Readable by `document.cookie` on purpose — a language code is a preference, not a secret.
    expect(cookie.toLowerCase()).not.toContain('httponly');
  });

  /** What the switcher writes is what the server shell will resolve on the next render. */
  it('round-trips through resolveLanguage for every supported language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const value = languageCookie(language).split(';')[0]?.split('=')[1];
      expect(resolveLanguage(value, 'en')).toBe(language);
    }
  });
});
