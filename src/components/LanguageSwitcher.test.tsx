import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LanguageContext, type LanguageContextValue } from '@/components/LanguageProvider';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { resolveLanguage } from '@/lib/language';
import { messages } from '@/lib/messages';
import { SUPPORTED_LANGUAGES, type Language } from '@/lib/schemas';

/**
 * Unit tests for the control itself: which options it offers, how they are labelled, and which
 * one is selected.
 *
 * Requirements: 9.1 (English, Hindi and Marathi are the selectable Supported_Languages),
 *               1.8 (the Profile's preferred language is the default a farmer starts from)
 * Design: "Mobile layout and accessibility" — a real labelled form control rather than
 *          click-handled divs
 *
 * Rendered to static markup rather than mounted: the questions here are about what the DOM says,
 * and a static render answers them without a stand-in router. The context value is supplied
 * directly for the same reason — `LanguageProvider` calls `useRouter()`, which needs an app
 * router, and substituting one would prove nothing about the options.
 *
 * Interaction (a change event writing the cookie and refreshing the server tree) is not asserted
 * here; it needs a mounted tree with a real router, and it belongs to the manual pass and task
 * 26.2's accessibility review.
 */

function render(language: Language): string {
  const value: LanguageContextValue = { language, setLanguage: () => {} };
  return renderToStaticMarkup(
    <LanguageContext.Provider value={value}>
      <LanguageSwitcher />
    </LanguageContext.Provider>,
  );
}

interface RenderedOption {
  code: string;
  lang: string | undefined;
  selected: boolean;
  text: string;
}

/**
 * Read the options out of the markup rather than asserting on a substring, so the assertions do
 * not depend on the order the renderer happens to emit attributes in.
 */
function optionsIn(markup: string): RenderedOption[] {
  return [...markup.matchAll(/<option ([^>]*)>([^<]*)<\/option>/g)].map((match) => {
    const attributes = match[1] ?? '';
    return {
      code: /value="([^"]*)"/.exec(attributes)?.[1] ?? '',
      lang: /lang="([^"]*)"/.exec(attributes)?.[1],
      selected: attributes.includes('selected'),
      text: match[2] ?? '',
    };
  });
}

describe('LanguageSwitcher', () => {
  /** Requirement 9.1 — three options, each carrying the schema's own code, in schema order. */
  it('offers exactly the three Supported_Languages', () => {
    const options = optionsIn(render('en'));

    expect(options.map((option) => option.code)).toEqual([...SUPPORTED_LANGUAGES]);
    expect(options).toHaveLength(3);
  });

  /**
   * The endonyms have to be in the markup, in their own script and marked with their own `lang`:
   * this is the control a farmer uses when they cannot read the language the screen is in.
   */
  it('labels each option in its own language', () => {
    const options = optionsIn(render('en'));

    for (const code of SUPPORTED_LANGUAGES) {
      const option = options.find((candidate) => candidate.code === code);
      expect(option?.text).toBe(messages(code).languageNames[code]);
      expect(option?.lang).toBe(code);
    }
    // Marathi is recognisable without reading English, which is the whole requirement.
    expect(options.map((option) => option.text)).toContain('\u092E\u0930\u093E\u0920\u0940');
  });

  it('offers no code outside the enum, and is one real select', () => {
    const markup = render('mr');

    expect(markup).not.toContain('value="fr"');
    expect(markup).not.toContain('value="en-IN"');
    // A `<select>`, not a pile of clickable divs (design: "Mobile layout and accessibility").
    expect([...markup.matchAll(/<select/g)]).toHaveLength(1);
    expect(markup).not.toContain('<div role="listbox"');
  });

  /**
   * Requirement 1.8's stored preference is what a farmer sees selected before they touch
   * anything. Resolved through the same function the server shell uses, so this asserts the real
   * path from a `profiles.language` value to the rendered control.
   */
  it('defaults to the language on the profile', () => {
    for (const profileLanguage of SUPPORTED_LANGUAGES) {
      const options = optionsIn(render(resolveLanguage(null, profileLanguage)));
      const selected = options.filter((option) => option.selected);

      expect(selected).toHaveLength(1);
      expect(selected[0]?.code).toBe(profileLanguage);
    }
  });

  /** A selection outranks the profile default, and the control shows the selection. */
  it('shows the active selection rather than the profile default', () => {
    const selected = optionsIn(render(resolveLanguage('en', 'mr'))).filter(
      (option) => option.selected,
    );

    expect(selected.map((option) => option.code)).toEqual(['en']);
  });

  /**
   * A visible label AND an accessible name, from one `<label for>` bound to the select's id.
   * The label text is localized, so the assertion runs per language rather than on one string.
   */
  it('binds a visible localized label to the select', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const markup = render(language);
      const label = /<label[^>]*for="([^"]+)"[^>]*>([^<]*)<\/label>/.exec(markup);
      const select = /<select[^>]*id="([^"]+)"/.exec(markup);

      expect(label).not.toBeNull();
      expect(select).not.toBeNull();
      expect(label?.[1]).toBe(select?.[1]);
      expect(label?.[2]).toBe(messages(language).ui.preferredLanguageLabel);
    }
  });
});
