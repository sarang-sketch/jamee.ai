import { ProfileAccessCards } from '@/components/ProfileAccessCards';
import { ProfileForm } from '@/components/ProfileForm';
import { requireFarmer } from '@/lib/auth/session';
import { accessData } from '@/lib/db/access';
import { farmerData } from '@/lib/db/farmer';
import { messages } from '@/lib/messages';
import { DEFAULT_LANGUAGE, readProfileSettings, type ProfileSettings } from '@/lib/profile';
import { entitlementStatus } from '@/services/entitlement.service';

import styles from './page.module.css';

/**
 * The profile screen: the farmer's display name and language, the Telegram link card, and the bot
 * recharge card — one server shell reading everything once, then handing it to the client islands.
 *
 * Requirements: 1.6 (no session ⇒ sign-in screen), 1.8 (display name and preferred language are
 *               persisted on that Farmer's Profile — read back here on load), 9.1 (the three
 *               languages), 21.20 (the link card renders from the link state), 22.18 (the recharge
 *               card renders from the entitlement window)
 * Design: "Frontend" — `/profile` is a server shell plus client forms/cards; D8, D13, D14, D18
 *
 * =============================================================================
 * AMENDMENT A3 — THE READ GOES THROUGH THE DATA_ACCESS_LAYER, NOT SUPABASE
 * =============================================================================
 *
 * Under Supabase this page read the row with an RLS-scoped browser-shaped client and let the
 * database decide which row was visible. A3 removes Supabase: there is no RLS. `requireFarmer()`
 * validates the session against the store (never a decoded cookie) and `redirect()`s a signed-out
 * visitor; the reads then go through the owner-scoped Data_Access_Layer (`farmerData(userId)` and
 * `accessData(userId)`), which merges the owning Auth_User_Id into every query by construction (D18)
 * — so this page can read exactly one farmer's profile, link state, and entitlement, and can
 * express no unscoped read.
 */

/**
 * The session and the profile row decide what renders, so this page is never prerendered.
 * `requireFarmer()` reads `headers()`/`cookies()` underneath, which already forces a dynamic render;
 * stating it is the honest version of that.
 */
export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  /**
   * Requirement 1.6. `requireFarmer()` validates the session against the store and `redirect()`s a
   * signed-out visitor — `redirect()` throws to unwind the render, so nothing below runs without a
   * session. This is the local check this screen needs to have a farmer whose rows it can read; the
   * gate over the whole protected surface is the proxy's.
   */
  const userId = await requireFarmer();

  const data = farmerData(userId);
  const access = accessData(userId);

  /**
   * Read everything in one pass. The profile fields decide the language every label renders in; the
   * link state and entitlement window feed the two access cards. `readProfileSettings` maps the
   * `ProfileDoc` to the narrow readback shape, so an identity column cannot leak into this screen.
   *
   * A `null` profile — a farmer with no row, which the D8 bootstrap makes rare — renders the column
   * defaults rather than crashing; a save then re-runs the bootstrap through the auth path.
   */
  const [settings, isLinked, entitlement] = await Promise.all([
    readProfileSettings(async () => {
      const profile = await data.readProfile();
      return profile === null ? null : { displayName: profile.displayName ?? null, language: profile.language };
    }),
    access.isTelegramLinked(),
    entitlementStatus(userId),
  ]);

  const resolved: ProfileSettings = settings ?? { displayName: null, language: DEFAULT_LANGUAGE };

  /**
   * `ui.navProfile` — "My details" — is the heading as well as the nav label. A separate heading key
   * would be a fourth string saying the same thing in three catalogs.
   */
  const { ui } = messages(resolved.language);

  return (
    /**
     * `lang` on the landmark rather than on `<html>`: the root layout is language-agnostic, and this
     * screen knows which language its text is in. It matters for pronunciation — a screen reader
     * given Devanagari under `lang="en"` will mispronounce or skip it. The form asks for a refresh
     * after a language change, which keeps this attribute and the labels in step.
     */
    <main className={styles.page} lang={resolved.language}>
      <h1 className={styles.heading}>{ui.navProfile}</h1>
      <ProfileForm initial={resolved} />
      <ProfileAccessCards isLinked={isLinked} entitlement={entitlement} language={resolved.language} />
    </main>
  );
}
