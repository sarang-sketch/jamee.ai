'use client';

import { useId } from 'react';

import { useLanguage } from '@/components/LanguageProvider';
import { languageOptions, parseLanguage } from '@/lib/language';
import { messages } from '@/lib/messages';

import styles from './LanguageSwitcher.module.css';

/**
 * The language control: English, Hindi, Marathi.
 *
 * Requirements: 9.1 (the three selectable Supported_Languages), 9.2 (a selection reaches every
 *               subsequent diagnosis, chat and voice request — via `LanguageProvider`)
 * Design: "Mobile layout and accessibility" — a real labelled form control, a visible label plus
 *          an accessible name, tap targets at least 44×44 px in relative units, keyboard
 *          operable, no colour-only signalling
 *
 * ### Why a native `<select>`
 *
 * It is keyboard operable, screen-reader announced, and on a phone it opens the platform's own
 * picker — which is the widest, highest-contrast target the device has, and it is rendered by
 * the OS with the OS's own font stack. That last part matters here specifically: the options are
 * Devanagari, and a custom listbox would render them in whatever the page's font stack resolves
 * to. Anything built out of divs and click handlers would have to reimplement all of that and
 * would get it slightly wrong.
 *
 * ### What this component does not do
 *
 * It holds no state and reads no profile. The active value and the setter both come from
 * `useLanguage()`, so this file cannot become a second source of truth for the language, and it
 * never writes the Profile — Requirement 1.8 gives that to the profile screen.
 *
 * It also touches no result content. Requirement 9.4's canonical disease name is not translated
 * by anything here: this component renders three static labels and nothing else.
 */
export function LanguageSwitcher() {
  const { language, setLanguage } = useLanguage();
  const { ui } = messages(language);
  const fieldId = useId();

  return (
    <div className={styles.field}>
      {/**
       * A real `<label for>`: visible text AND the accessible name, from one element. The label
       * is in the ACTIVE language ("Language" / "भाषा") while the options are each in their own —
       * the label describes the control to someone already reading the page, the options have to
       * be recognisable to someone who is not.
       */}
      <label className={styles.label} htmlFor={fieldId}>
        {ui.preferredLanguageLabel}
      </label>

      <select
        className={styles.select}
        id={fieldId}
        name="language"
        value={language}
        onChange={(event) => {
          /**
           * A native select can only emit one of the three option values, so this parse is
           * defence rather than a branch that runs: it exists so that no path from a DOM string
           * to a `Language` skips validation. An unrecognized value is ignored rather than
           * defaulted — silently switching a farmer to English would be worse than doing
           * nothing.
           */
          const next = parseLanguage(event.target.value);
          if (next !== null && next !== language) setLanguage(next);
        }}
      >
        {languageOptions().map(({ code, label }) => (
          /**
           * `lang` per option so a screen reader pronounces `हिन्दी` with Hindi phonetics rather
           * than reading Devanagari through an English voice, and so the browser picks a font
           * that actually covers the script.
           */
          <option key={code} value={code} lang={code}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}
