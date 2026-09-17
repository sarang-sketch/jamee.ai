import { redirect } from 'next/navigation';

import { LanguageProvider } from '@/components/LanguageProvider';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { SignInForm } from '@/components/SignInForm';
import { activeLanguage } from '@/lib/language.server';
import { messages } from '@/lib/messages';
import { currentUserId } from '@/lib/supabase/server';

import styles from './page.module.css';

/**
 * The sign-in screen, and the redirect out of it.
 *
 * Requirements: 1.1, 1.2, 1.3 (delegated to `SignInForm`), and the session branch task 6.1
 *               specifies: a live session lands on `/diagnose` instead of a sign-in form
 * Design: "Frontend" — `/` is a server component, `SignInForm` is the client half
 *
 * Server component: no `'use client'`, no state, and the session is read with the RLS-scoped
 * server client. `currentUserId()` is `getUser()` underneath, which V1 records as the
 * server-confirmed call — a decoded cookie is not enough to skip a sign-in screen.
 */

/**
 * The session decides what renders, so this page must never be prerendered at build time.
 *
 * `cookies()` inside `createServerSupabase()` already makes the render dynamic, but the env
 * read that precedes it throws when `NEXT_PUBLIC_SUPABASE_URL` is absent — which would turn a
 * build without Supabase credentials into a build failure on a page whose output could not
 * have been reused anyway. Stating it here is the honest version of that.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  /**
   * Task 6.1's second clause. `redirect()` throws to unwind the render, so it is called
   * outside any `try` — nothing below it runs for a signed-in farmer.
   *
   * `/diagnose` DOES NOT EXIST YET: task 12.2 owns that route. The target is what this task
   * specifies, so it stays as written and the route 404s until 12.2 lands. A stub page here
   * would make a missing screen look like a finished one.
   */
  if ((await currentUserId()) !== null) redirect('/diagnose');

  /**
   * A visitor at `/` has no Profile yet, so there is no preferred language to read — this is the
   * one screen whose language cannot come from the farmer's own record. `activeLanguage(null)`
   * therefore resolves to the switcher's cookie if this visitor has already chosen, and `en`
   * only if nobody has said otherwise (Requirement 9.1).
   *
   * It matters that the switcher is on THIS screen and not only behind the sign-in: a farmer who
   * cannot read English has to be able to change the language before they can be asked for a
   * phone number.
   */
  const language = await activeLanguage(null);
  const { ui } = messages(language);

  return (
    /**
     * `lang` on the subtree rather than the document: the root layout is `lang="en"` and stays
     * that way (a later task owns it), so this is what tells a screen reader to pronounce the
     * Hindi and Marathi text with the right voice.
     */
    <main className={styles.page} lang={language}>
      {/**
       * The provider is what makes the switcher work AND what task 12.2's `/diagnose` shell will
       * mount for the same reason: `useJameeRequests()` is unreachable without it, so the
       * language cannot go missing from a request.
       */}
      <LanguageProvider initialLanguage={language}>
        <LanguageSwitcher />
        <h1 className={styles.appName}>{ui.appName}</h1>
        <p className={styles.tagline}>{ui.tagline}</p>
        <SignInForm language={language} />
      </LanguageProvider>
    </main>
  );
}
