import { redirect } from 'next/navigation';

import { EmptyState } from '@/components/EmptyState';
import { HistoryList } from '@/components/HistoryList';
import { LanguageProvider } from '@/components/LanguageProvider';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { SIGN_IN_PATH } from '@/lib/auth/protected-paths';
import {
  DIAGNOSE_PATH,
  HISTORY_PAGE_SIZE,
  HISTORY_SELECT,
  readHistory,
  storageImageSource,
} from '@/lib/history';
import { activeLanguage } from '@/lib/language.server';
import { messages } from '@/lib/messages';
import {
  DEFAULT_LANGUAGE,
  PROFILE_SETTINGS_SELECT,
  readProfileSettings,
  type ProfileSettings,
} from '@/lib/profile';
import { createServerSupabase, currentUserId } from '@/lib/supabase/server';

import styles from './page.module.css';

/**
 * `/history` — every diagnosis this farmer has, newest first.
 *
 * Requirements: 12.1 (reverse-chronological, with thumbnail, condition or inconclusive label,
 *               Severity_Value, channel and creation timestamp), 12.2 (WhatsApp-originated
 *               Diagnosis_Results included), 12.4 (an empty list invites a first upload),
 *               12.5 (every image loads through a Signed_URL), 12.6 / 12.7 / 12.10 (which
 *               derivative, and what to say when neither survives), 1.6 (no session, no protected
 *               screen), 13.2 (own rows only), 9.1 / 9.2 (the active language)
 * Design: "Frontend" → screens table — `/history` is a **server component**, data via the
 *          RLS-scoped server client, signed thumbnail URLs minted server-side, `EmptyState` when
 *          the farmer has no diagnoses; "Media lifecycle and retention" → mechanism 2
 *
 * Server component: no `'use client'`, no state, no route handler in the middle. The design's rule
 * of thumb applies literally here — *no route handler is called just to read data a server
 * component can query directly under RLS* — so this page holds the query and the URL minting, and
 * `HistoryList` receives entries that are already resolved.
 *
 * ### Why the whole screen is server-rendered
 *
 * Requirement 12.5 makes every image a Signed_URL, and a signed URL can only be minted by
 * something holding a session (or the service role). A client component would have had to ask an
 * endpoint for one URL per entry, which is 20 round trips to replace one server render — and it
 * would have put the fallback decision (Requirements 12.6, 12.7, 12.10) in the browser, where the
 * `full_image_deleted_at` column it depends on is not in hand.
 *
 * The only client component on the screen is the language switcher, which holds no data.
 */

/**
 * The session and the farmer's rows decide what renders, so this page must never be prerendered.
 *
 * `cookies()` inside `createServerSupabase()` and `activeLanguage()` already forces a dynamic
 * render, and the signed URLs expire in minutes, so a cached copy of this page would be a page of
 * broken images. Same reasoning as `/`, `/diagnose` and `/profile`.
 */
export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  /**
   * Requirement 1.6, as the second layer. The first is `src/proxy.ts`, which gates `/history`
   * before this file runs. This check is here anyway because `currentUserId()` is `getUser()`
   * underneath — server-confirmed rather than a decoded cookie — and because `userId` is a value
   * this render needs: it is the `user_id` predicate below and the value the log carries if the
   * read fails.
   *
   * `redirect()` throws to unwind the render, so nothing below runs without a session.
   */
  const userId = await currentUserId();
  if (userId === null) redirect(SIGN_IN_PATH);

  const supabase = await createServerSupabase();

  /**
   * The profile's preferred language is the standing default the switcher starts from
   * (Requirement 1.8); `null` means no profile row, so the screen falls back to the column default
   * rather than failing. Read with the RLS-scoped client, like everything else here.
   */
  const settings: ProfileSettings = (await readProfileSettings(
    () =>
      supabase.from('profiles').select(PROFILE_SETTINGS_SELECT).eq('id', userId).maybeSingle(),
    userId,
  )) ?? { displayName: null, language: DEFAULT_LANGUAGE };

  const language = await activeLanguage(settings.language);
  const { ui } = messages(language);

  /**
   * The one read this screen makes.
   *
   * **RLS is the authorization boundary** — the cookie-scoped client carries the farmer's session,
   * so PostgREST returns their rows and no others (Requirement 13.2). `.eq('user_id', userId)` is
   * the explicit second layer the design's *Defence in depth* note asks for, not the thing that
   * makes this safe.
   *
   * **No channel filter, deliberately.** That absence *is* Requirement 12.2: a WhatsApp-originated
   * diagnosis is a `diagnoses` row with `channel = 'whatsapp'` and the same `user_id`, so it
   * appears here by construction rather than by a rule someone has to remember. Its image is under
   * the same `{user_id}/` prefix even though the service role uploaded it, which is what lets this
   * session sign a URL for it.
   *
   * The two `order` clauses match `readHistory`'s own sort, which re-applies them (Requirement
   * 12.1's ordering is a property of that module, not of this statement — see its comment).
   */
  const entries = await readHistory({
    userId,
    source: storageImageSource(supabase),
    query: () =>
      supabase
        .from('diagnoses')
        .select(HISTORY_SELECT)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(HISTORY_PAGE_SIZE),
  });

  return (
    /**
     * `lang` on the landmark rather than on `<html>`: the root layout is language-agnostic and this
     * screen knows which language its text is in, which is what a screen reader needs to pronounce
     * Devanagari correctly. The stored condition names stay Latin script inside it (Requirement
     * 9.4) — a name is not translated, and `overflow-wrap` in the list's CSS is what keeps one from
     * widening the layout.
     */
    <main className={styles.page} lang={language}>
      {/**
       * The provider is here for the switcher, which is the only client component on this screen.
       * Nothing on `/history` issues a diagnosis, chat or voice request, so `useJameeRequests()`
       * is unused — but the switcher's `router.refresh()` is what re-runs this server render in
       * the new language, which is the whole of Requirement 9.2 for a read-only screen.
       */}
      <LanguageProvider initialLanguage={language}>
        <LanguageSwitcher />
        {/* `ui.historyHeading` and `ui.navHistory` are the same words; the heading key is used. */}
        <h1 className={styles.heading}>{ui.historyHeading}</h1>

        {/*
          Requirement 12.4. An empty array is a real, observed state — the farmer has sent nothing
          yet — and `readHistory` throws rather than returning one for a failed read, so this branch
          cannot be reached by an error pretending to be an empty history.
        */}
        {entries.length === 0 ? (
          <EmptyState
            message={ui.historyEmpty}
            actionLabel={ui.historyEmptyAction}
            actionHref={DIAGNOSE_PATH}
          />
        ) : (
          <HistoryList entries={entries} language={language} />
        )}
      </LanguageProvider>
    </main>
  );
}
