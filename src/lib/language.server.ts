import 'server-only';

import { cookies } from 'next/headers';

import { LANGUAGE_COOKIE, resolveLanguage } from '@/lib/language';
import type { Language } from '@/lib/schemas';

/**
 * The one line a server shell needs to know the active language.
 *
 * Requirements: 9.1, 9.2; 1.8 (the profile value is the standing default)
 * Design: "Frontend" — `/diagnose`, `/chat`, `/voice`, `/history` and `/profile` are server
 *          shells that resolve session and preferred language before any client component
 *          mounts
 *
 * Kept in its own module because of the `next/headers` import: `src/lib/language.ts` is read by
 * the switcher in the browser, and pulling a server API into it would make every client
 * component that resolves a language a build error.
 *
 * The reason this exists rather than each screen reading the cookie itself: tasks 12.2, 16.1 and
 * 19.2 all need the same three lines, and three copies of "read the cookie, fall back to the
 * profile, fall back to `en`" is three chances for one screen to order the fallbacks
 * differently — which a farmer would experience as the switcher working on some screens and not
 * others.
 *
 * Usage in a server component:
 *
 * ```tsx
 * const language = await activeLanguage(profile?.language ?? null);
 * return (
 *   <LanguageProvider initialLanguage={language}>
 *     <LanguageSwitcher />
 *     {children}
 *   </LanguageProvider>
 * );
 * ```
 */
export async function activeLanguage(
  profileLanguage: string | null | undefined,
): Promise<Language> {
  /** `cookies()` is async from Next 15; awaiting it also marks the render dynamic. */
  const store = await cookies();
  return resolveLanguage(store.get(LANGUAGE_COOKIE)?.value, profileLanguage);
}
