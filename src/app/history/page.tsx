import { EmptyState } from '@/components/EmptyState';
import { HistoryList } from '@/components/HistoryList';
import { LanguageProvider } from '@/components/LanguageProvider';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { requireFarmer } from '@/lib/auth/session';
import { farmerData } from '@/lib/db/farmer';
import { DIAGNOSE_PATH, readHistory } from '@/lib/history';
import { activeLanguage } from '@/lib/language.server';
import { messages } from '@/lib/messages';
import {
  DEFAULT_LANGUAGE,
  readProfileSettings,
  type ProfileSettings,
} from '@/lib/profile';

import styles from './page.module.css';

/**
 * `/history` — every diagnosis this farmer has, newest first.
 *
 * Requirements: 12.1 (reverse-chronological, with thumbnail, condition or inconclusive label,
 *               Severity_Value, channel and creation timestamp), 12.2 (Telegram-originated
 *               Diagnosis_Results included), 12.4 (an empty list invites a first upload),
 *               12.5 (every image loads through the Media_Endpoint, Amendment A3), 12.6 / 12.7 /
 *               12.10 (which derivative, and what to say when neither survives), 1.6 (no session,
 *               no protected screen), 13.2 (own rows only), 9.1 / 9.2 (the active language)
 * Design: "Frontend" → screens table — `/history` is a **server component**, data via the
 *          owner-scoped Data_Access_Layer (D18), Media_Endpoint URLs built server-side,
 *          `EmptyState` when the farmer has no diagnoses; "Media lifecycle and retention" →
 *          mechanism 2
 *
 * =============================================================================
 * AMENDMENT A3 — THE DATA_ACCESS_LAYER REPLACES THE RLS-SCOPED SUPABASE CLIENT
 * =============================================================================
 *
 * Under Supabase this page held an RLS-scoped query and minted a Signed_URL per image. Under A3 the
 * page holds no query and no client: `readHistory({ userId })` reads through the owner-scoped
 * Data_Access_Layer (`src/lib/history.ts` → `farmerReads(userId)`), which merges the owner into
 * every filter (D18), and every image is the constant `/api/media/<fileId>` built by `mediaUrl`
 * (no minting, no expiry). The design's rule of thumb still applies literally — no route handler is
 * called just to read data a server component can query directly — so `HistoryList` receives
 * entries that are already resolved.
 *
 * The only client component on the screen is the language switcher, which holds no data.
 */

/**
 * The session and the farmer's rows decide what renders, so this page must never be prerendered.
 * `requireFarmer()` reads the session (cookies) and `activeLanguage()` reads the language cookie,
 * both of which already force a dynamic render; saying so is the honest version of that. Same
 * reasoning as `/`, `/diagnose` and `/profile`.
 */
export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  /**
   * Requirement 1.6, as the second layer behind `src/proxy.ts`. `requireFarmer()` validates the
   * session against the store (not a decoded cookie) and `redirect()`s a signed-out visitor,
   * throwing to unwind the render — so nothing below runs without a session. `userId` is the owner
   * every read here is scoped to.
   */
  const userId = await requireFarmer();

  /**
   * The profile's preferred language is the standing default the switcher starts from (Requirement
   * 1.8); `null` means no profile row, so the screen falls back to the column default rather than
   * failing. Read through the owner-scoped Data_Access_Layer accessor, mapped to the narrow
   * `ProfileReadback` the reader seam takes.
   */
  const settings: ProfileSettings = (await readProfileSettings(async () => {
    const profile = await farmerData(userId).readProfile();
    return profile === null
      ? null
      : { displayName: profile.displayName ?? null, language: profile.language };
  })) ?? { displayName: null, language: DEFAULT_LANGUAGE };

  const language = await activeLanguage(settings.language);
  const { ui } = messages(language);

  /**
   * The one read this screen makes, through the owner-scoped Data_Access_Layer.
   *
   * The owner is the whole scope — `readHistory({ userId })` binds `farmerReads(userId)`, which
   * merges `ownerId` into the diagnoses read and every thumbnail lookup (Requirement 13.2). **No
   * channel filter, deliberately**: that absence *is* Requirement 12.2 — a Telegram-originated
   * diagnosis is this owner's row and comes back on the same footing as a web one. Newest-first
   * (Requirement 12.1) is a property of the `owner_recent` index the accessor sorts on, not of a
   * statement here.
   */
  const entries = await readHistory({ userId });

  return (
    /**
     * `lang` on the landmark rather than on `<html>`: the root layout is language-agnostic and this
     * screen knows which language its text is in. The stored condition names stay Latin script
     * inside it (Requirement 9.4) — a name is not translated, and `overflow-wrap` in the list's CSS
     * is what keeps one from widening the layout.
     */
    <main className={styles.page} lang={language}>
      {/**
       * The provider is here for the switcher, which is the only client component on this screen.
       * Its `router.refresh()` is what re-runs this server render in the new language, which is the
       * whole of Requirement 9.2 for a read-only screen.
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
