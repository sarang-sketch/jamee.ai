import { messages } from '@/lib/messages';
import { SUPPORTED_LANGUAGES, languageSchema, type Language } from '@/lib/schemas';

/**
 * Which language is active, and how that answer is carried between a server render and the
 * browser.
 *
 * Requirements: 9.1 (English, Hindi and Marathi are the selectable Supported_Languages),
 *               9.2 (the selected code reaches every subsequent diagnosis, chat and voice
 *               request), 1.8 (the *profile* screen is what persists a preferred language)
 * Design: "Frontend" — the server shell resolves session + preferred language; anything
 *          holding local state is a client component
 *
 * ### Why a cookie rather than component state alone
 *
 * Requirement 9.2 says **every subsequent** request. React state does not survive a navigation
 * from `/diagnose` to `/chat`, so a selection held only in state would silently revert to the
 * profile value halfway through a session and the next request would carry a language the
 * farmer had already changed. A cookie survives the navigation AND is readable by the server
 * component that renders the next screen, which is what keeps the text a farmer reads and the
 * code the next request carries in agreement — a value kept only in the browser would render
 * the screen in one language and ask the API for another.
 *
 * It is a plain, readable cookie on purpose: a language code is a preference, not a
 * credential, and `document.cookie` is what lets the switcher write it without a round trip.
 * Nothing authorizes off it.
 *
 * ### Why this module imports no server API
 *
 * `parseLanguage` and `resolveLanguage` are used on both sides of the boundary — by the server
 * shell resolving the initial value and by the switcher validating what a `<select>` produced.
 * Reading `next/headers` here would make the module unimportable from a client component, so
 * that one line lives in `language.server.ts` instead.
 */

/**
 * The language for a reader Jamee knows nothing about: a visitor at the sign-in screen, who has
 * no profile yet and has not chosen.
 *
 * The same value as `profiles.language`'s `default 'en'` in migration 0002, so the pre-profile
 * default and the post-profile default agree.
 */
export const DEFAULT_LANGUAGE: Language = 'en';

/** The cookie the switcher writes and the server shell reads. */
export const LANGUAGE_COOKIE = 'jamee_language';

/**
 * A year. The preference is worth remembering across sessions, and an expiry short enough to
 * lapse mid-project would look like the switcher forgetting.
 */
export const LANGUAGE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/* ========================================================================== */
/* The offered set                                                             */
/* ========================================================================== */

export interface LanguageOption {
  readonly code: Language;
  readonly label: string;
}

/**
 * The three Supported_Languages, each labelled in its OWN language.
 *
 * Two things are load-bearing here:
 *
 *  - The codes come from `SUPPORTED_LANGUAGES` (i.e. `languageSchema.options`), never from a
 *    retyped list. A fourth language added to the schema appears in the switcher with no edit
 *    here, and — more usefully — a switcher offering a code the schema does not accept cannot
 *    be written, because the code would not typecheck. Requirement 9.5's HTTP 400 is therefore
 *    unreachable from Jamee's own client.
 *  - The label is read from **that option's own catalog** (`messages(code).languageNames[code]`)
 *    rather than the active one. A Marathi speaker looking at an English screen sees `मराठी`,
 *    not "Marathi": the one control they need before they can read anything else is the one
 *    control that must not require reading the current language first.
 */
export function languageOptions(): readonly LanguageOption[] {
  return SUPPORTED_LANGUAGES.map((code) => ({
    code,
    label: messages(code).languageNames[code],
  }));
}

/* ========================================================================== */
/* Resolution                                                                  */
/* ========================================================================== */

/**
 * A supported code, or `null` for anything else.
 *
 * Deliberately `null` rather than a fallback to `en`: the CALLER decides what an unsupported
 * value falls back to, and the two callers want different things. `resolveLanguage` falls
 * through to the next source; the switcher's change handler ignores the value entirely.
 * Baking `?? 'en'` in here would turn a cookie a farmer had never set into an English screen
 * for a Marathi profile.
 */
export function parseLanguage(value: unknown): Language | null {
  const parsed = languageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The active language for one render: the cookie the farmer's last selection wrote, else the
 * preferred language on their Profile, else `en`.
 *
 * **The cookie outranks the profile, and that ordering is the point.** The profile is a
 * standing default (Requirement 1.8); the cookie is what the farmer said most recently. A
 * profile that outranked the switcher would make the switcher a control that visibly does
 * nothing on the next navigation.
 *
 * The corollary is the profile screen's obligation, not this function's: when task 15.x saves a
 * new preferred language it must also call `setLanguage` from `LanguageProvider`, so the cookie
 * stops carrying the older answer. Persisting one without the other is what would make the two
 * fight.
 *
 * Both arguments are widened to `string | null | undefined` because both arrive as untyped
 * strings — one from a cookie jar, one from a `profiles` row — and validating them here is
 * cheaper than making every caller remember to.
 */
export function resolveLanguage(
  cookieValue: string | null | undefined,
  profileLanguage: string | null | undefined,
): Language {
  return parseLanguage(cookieValue) ?? parseLanguage(profileLanguage) ?? DEFAULT_LANGUAGE;
}

/**
 * The `document.cookie` assignment string for a selection.
 *
 * `path=/` because every screen reads it. `samesite=lax` because nothing authorizes off this
 * value and a top-level navigation should still arrive in the farmer's language. No `secure`
 * flag: it would silently drop the cookie over plain-http local development while protecting a
 * value that is already public. No `httponly` — impossible from `document.cookie`, and the
 * switcher needs to write it.
 */
export function languageCookie(language: Language): string {
  return `${LANGUAGE_COOKIE}=${language}; path=/; max-age=${LANGUAGE_COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}
