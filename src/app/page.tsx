import { redirect } from 'next/navigation';

import { GoogleSignInButton } from '@/components/GoogleSignInButton';
import { LanguageProvider } from '@/components/LanguageProvider';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { currentUserId } from '@/lib/auth/session';
import { activeLanguage } from '@/lib/language.server';
import { messages } from '@/lib/messages';

import styles from './page.module.css';

/**
 * The sign-in screen, and the redirect out of it.
 *
 * Requirements: 1.1 (Google sign-in, delegated to `GoogleSignInButton`), 1.2 / 1.3 (the callback
 *               and its failure message live in the auth library and the button), 1.6 (a live
 *               session lands on `/diagnose` instead of a sign-in screen)
 * Design: "Frontend" — `/` is a server component, `GoogleSignInButton` is the client half; D8,
 *         D18a; V30
 *
 * Server component: no `'use client'`, no state. The session is read with Better Auth's
 * server-confirmed `getSession` (via `currentUserId`), which V30 records as validated against the
 * store — a decoded cookie is not enough to skip a sign-in screen.
 */

/**
 * The session decides what renders, so this page must never be prerendered.
 *
 * `getSession` reads `headers()` (request-time), which already makes the render dynamic; and
 * `getAuth()` reads secrets through `serverEnv` at request time, so a build without those secrets
 * neither prerenders this page nor fails on it. Stating it is the honest version of that.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  /**
   * A live session belongs on `/diagnose`, not on a sign-in screen (Requirement 1.6). `redirect()`
   * throws to unwind the render, so nothing below runs for a signed-in farmer.
   */
  if ((await currentUserId()) !== null) redirect('/diagnose');

  /**
   * A visitor at `/` has no Profile yet, so there is no preferred language to read from a record.
   * `activeLanguage(null)` resolves to the switcher's cookie if this visitor has already chosen,
   * and `en` only if nobody has (Requirement 9.1). The switcher is on THIS screen so a farmer who
   * cannot read English can change the language before signing in.
   */
  const language = await activeLanguage(null);
  const { ui } = messages(language);

  return (
    <main className={styles.page} lang={language}>
      <LanguageProvider initialLanguage={language}>
        <LanguageSwitcher />
        <h1 className={styles.appName}>{ui.appName}</h1>
        <p className={styles.tagline}>{ui.tagline}</p>
        {/* One control, one provider (Requirement 1.1): Google is the only sign-in. */}
        <GoogleSignInButton language={language} />
      </LanguageProvider>
    </main>
  );
}
