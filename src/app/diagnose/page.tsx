import { DIAGNOSE_HEADING_ID, DiagnosisPanel } from '@/components/DiagnosisResultCard';
import { LanguageProvider } from '@/components/LanguageProvider';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { requireFarmer } from '@/lib/auth/session';
import { farmerData } from '@/lib/db/farmer';
import { activeLanguage } from '@/lib/language.server';
import { messages } from '@/lib/messages';
import {
  DEFAULT_LANGUAGE,
  readProfileSettings,
  type ProfileSettings,
} from '@/lib/profile';

import styles from './page.module.css';

/**
 * `/diagnose` — the screen a signed-in farmer lands on: send a crop photo, read the result.
 *
 * Requirements: 1.6 (no session, no protected screen), 9.1 / 9.2 (the active language is
 *               resolved here and every request carries it), 15.1 / 15.2 (the honest indicator is
 *               the uploader's, bound to its real request), 6.4 / 6.5 (the result shape is
 *               rendered by `DiagnosisResultCard`)
 * Design: "Frontend" → screens table — `/diagnose` is a **server shell** (session + preferred
 *          language) plus the client `ImageUploader` and `DiagnosisResultCard`
 *
 * Server component: no `'use client'`, no state, no `fetch`. Its whole job is to resolve the two
 * facts the client subtree cannot resolve for itself — who is signed in, and which language they
 * read — and then get out of the way.
 */

/**
 * The session and the profile row decide what renders, so this page must never be prerendered.
 *
 * `cookies()` inside `createServerSupabase()` and `activeLanguage()` already forces a dynamic
 * render; stating it is the honest version of that, and it keeps a build without Supabase
 * credentials from failing on a page whose output could not have been reused anyway. Same
 * reasoning as `/` and `/profile`.
 */
export const dynamic = 'force-dynamic';

export default async function DiagnosePage() {
  /**
   * Requirement 1.6, as the second layer. The first is `src/proxy.ts`, which gates every path in
   * `PROTECTED_SCREEN_PATHS` — `/diagnose` among them — before this file runs at all. `requireFarmer()`
   * is the real check: it validates the session against the store (Better Auth's server-confirmed
   * `getSession`, V30) and `redirect()`s a signed-out visitor, so nothing below runs without a
   * session. `userId` is a value this render genuinely needs — it is the owner every uploaded media
   * file is stamped with and the id the Data_Access_Layer scopes every read to (D18).
   */
  const userId = await requireFarmer();

  /**
   * The profile's preferred language is the standing default the switcher starts from
   * (Requirement 1.8). `null` means the farmer has no profile row, which by construction should not
   * happen — the D8 bootstrap upsert writes it on every authenticated request — so the screen falls
   * back to the column default rather than failing. Read through the owner-scoped Data_Access_Layer
   * (D18): `farmerData(userId).readProfile()` returns only this farmer's row.
   */
  const settings: ProfileSettings = (await readProfileSettings(() =>
    farmerData(userId).readProfile(),
  )) ?? { displayName: null, language: DEFAULT_LANGUAGE };

  /**
   * The cookie if the farmer has chosen on this device, otherwise their profile's preference,
   * otherwise `en`. One function so this screen cannot order those fallbacks differently from
   * `/chat` or `/voice` (Requirement 9.2).
   */
  const language = await activeLanguage(settings.language);
  const { ui } = messages(language);

  return (
    /**
     * `lang` on the landmark rather than on `<html>`: the root layout is language-agnostic, and
     * this screen knows which language its text is in. It matters for pronunciation — Devanagari
     * under `lang="en"` is mispronounced or skipped — and the switcher's `router.refresh()` is
     * what keeps this attribute in step with a selection.
     */
    <main className={styles.page} lang={language}>
      {/**
       * The provider is not optional furniture here: `useJameeRequests()` is the only way to
       * reach `/api/diagnose`, it takes the language from this context, and it throws rather
       * than defaulting to `en` when the provider is missing (Requirement 9.2).
       */}
      <LanguageProvider initialLanguage={language}>
        <LanguageSwitcher />
        {/*
         * `ui.navDiagnose` — "Check a crop" — is the nav label and this heading. One string.
         *
         * The id is what names the result region below, the same way `/chat` and `/voice` name
         * theirs: the accessible name a screen reader reads is the words a sighted farmer sees, with
         * no off-screen duplicate heading to keep translated.
         */}
        <h1 className={styles.heading} id={DIAGNOSE_HEADING_ID}>
          {ui.navDiagnose}
        </h1>
        {/*
         * The uploader and the `aria-live="polite"` result region, in one client subtree. The
         * callback wiring is why that pair is a client component: a server component cannot hand
         * `ImageUploader` a function.
         *
         * No `conversationId`: Requirement 2.2 permits a diagnosis with no conversation, and
         * Requirement 7.5 then makes the API create one and attach the result to it. Threading a
         * conversation through this screen belongs to the chat work, not here.
         */}
        <DiagnosisPanel userId={userId} labelledBy={DIAGNOSE_HEADING_ID} />
      </LanguageProvider>
    </main>
  );
}
