import { redirect } from 'next/navigation';

import { SIGN_IN_PATH } from '@/app/auth/callback/ensure-profile';
import { ProfileForm } from '@/components/ProfileForm';
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
 * The profile screen: read the farmer's saved display name and language, hand them to the form.
 *
 * Requirements: 1.8 (a submitted display name and preferred Supported_Language are persisted on
 *               that Farmer's Profile — read back here on load), 9.1 (the three languages),
 *               1.6 (no session, no protected screen)
 * Design: "Frontend" — `/profile` is a server shell plus a client form
 *
 * Server component: no `'use client'`, no state, and the row is read with the RLS-scoped server
 * client so the database, not this file, decides which row is visible.
 */

/**
 * The session and the profile row decide what renders, so this page must never be prerendered.
 * `cookies()` inside `createServerSupabase()` already forces a dynamic render; stating it is the
 * honest version of that, and it keeps a build without Supabase credentials from failing on a page
 * whose output could not have been reused anyway.
 */
export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  /**
   * Requirement 1.6. `currentUserId()` is `getUser()` underneath — server-confirmed, not a decoded
   * cookie. `redirect()` throws to unwind the render, so nothing below runs without a session.
   *
   * The gate over the whole protected surface is task 6.3's; this is the local check this screen
   * needs to have a farmer whose row it can read, and it is not a substitute for that task.
   *
   * `SIGN_IN_PATH` is imported rather than written as `'/'` because the auth callback already
   * declares it for exactly this case — a visit carrying no session — and a second copy of a path is
   * a second thing to keep in step.
   */
  const userId = await currentUserId();
  if (userId === null) redirect(SIGN_IN_PATH);

  const supabase = await createServerSupabase();

  /**
   * `null` means the farmer has no profile row, which by construction should not happen: the trigger
   * in `0002_profiles.sql` writes it at signup and the auth callback upserts it defensively on every
   * sign-in. If it does happen, the screen renders the column defaults rather than a crash — and a
   * save then reports `AUTH_REQUIRED`, whose remedy (sign in again) is what re-runs that bootstrap.
   */
  const settings: ProfileSettings = (await readProfileSettings(
    () =>
      supabase.from('profiles').select(PROFILE_SETTINGS_SELECT).eq('id', userId).maybeSingle(),
    userId,
  )) ?? { displayName: null, language: DEFAULT_LANGUAGE };

  /**
   * `ui.navProfile` — "My details" — is the heading as well as the nav label. A separate heading key
   * would be a fourth string saying the same thing in three catalogs.
   */
  const { ui } = messages(settings.language);

  return (
    /**
     * `lang` on the landmark rather than on `<html>`: the root layout is language-agnostic, and this
     * screen knows which language its text is in. It matters for pronunciation — a screen reader
     * given Devanagari under `lang="en"` will mispronounce or skip it. The form asks for a refresh
     * after a language change, which is what keeps this attribute and the form's labels in step.
     */
    <main className={styles.page} lang={settings.language}>
      <h1 className={styles.heading}>{ui.navProfile}</h1>
      <ProfileForm userId={userId} initial={settings} />
    </main>
  );
}
