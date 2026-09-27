import { AppShell } from '@/components/AppShell';
import { LanguageProvider } from '@/components/LanguageProvider';
import { VoicePanel } from '@/components/VoiceAnswerCard';
import { requireFarmer } from '@/lib/auth/session';
import { farmerData } from '@/lib/db/farmer';
import { activeLanguage } from '@/lib/language.server';
import { messages } from '@/lib/messages';
import {
  DEFAULT_LANGUAGE,
  readProfileSettings,
  type ProfileSettings,
} from '@/lib/profile';
import { conversationStoreFrom, findOrCreateActive } from '@/services/conversation.service';

import styles from './page.module.css';

/**
 * `/voice` — where a farmer speaks a question and reads the transcript and the answer.
 *
 * Requirements: 1.6 (no session, no protected screen), 8.6 (the transcript and the answer are both
 *               displayed, transcript first), 8.8 (text answers only — nothing on this screen
 *               plays audio), 9.1 / 9.2 (the active language is resolved here and every request
 *               carries it), 15.7 (the listening state while transcription is in flight, rendered
 *               by the component that holds the request), 7.1 (the voice turn belongs to a
 *               Conversation resolved server-side)
 * Design: "Frontend" → screens table — `/voice` is a **server shell** plus a client
 *          `VoiceRecorder`, which *needs `MediaRecorder`, so it is client-only*; "Voice capture"
 *
 * Server component: no `'use client'`, no state, no `fetch`. Its whole job is to resolve the three
 * facts the client subtree cannot resolve for itself — who is signed in, which conversation this
 * question belongs to, and which language they read — and then get out of the way.
 *
 * ### The conversation id is resolved here, and it is required
 *
 * `voiceRequestSchema` requires a `conversationId`, and `/api/voice` answers
 * `CONVERSATION_NOT_FOUND` for anything that is not a uuid this farmer owns. So it cannot come
 * from the browser, and it is resolved with `findOrCreateActive(userId, 'web')` — the same
 * find-or-create `/chat`, the diagnosis path and the Telegram adapter use. A spoken question **is**
 * a chat turn (`voice.service.ts` hands the transcript to the ChatService verbatim), so it belongs
 * in the farmer's one long-running web thread rather than in a thread of its own: ask a question
 * aloud, then type a follow-up on `/chat`, and Requirement 7.1's Conversation_Context resolves it.
 *
 * A consequence worth stating, the same one `/chat` records: loading this screen creates a
 * conversation row for a farmer who has none, before any question is asked. An empty thread is not
 * farmer-visible anywhere, and the alternative (create on first send) would mean either the client
 * inventing an id or a round trip added to the first question of every session.
 *
 * ### What this screen does not render
 *
 * No loading indicator and no playback control. Every state line belongs to `VoiceRecorder`, which
 * holds the recording, the upload and the POST — including Requirement 15.7's
 * `loading.listening` — and Requirement 8.8 rules out synthesized speech in this release, so there
 * is no `<audio>` element anywhere in this subtree.
 */

/**
 * The session, the profile row and the farmer's conversation decide the entire output, so this page
 * must never be prerendered. `cookies()` inside the auth-session read and `activeLanguage()`
 * already force a dynamic render; saying so is the honest version of that, and it keeps a build
 * without runtime credentials from failing on a page whose output could not have been reused.
 * Same reasoning as `/`, `/diagnose`, `/chat`, `/history` and `/profile`.
 */
export const dynamic = 'force-dynamic';

/**
 * The IDREF that names the result region.
 *
 * A `<section>` with no accessible name is not a landmark, so the region a screen reader announces
 * into points at this screen's own visible `<h1>` — the name it reads is the words a sighted farmer
 * sees, with no off-screen duplicate heading to maintain (the reading `ChatThread` records for
 * `CHAT_HEADING_ID`). A module constant rather than `useId()` because the two ends of the reference
 * live in different components — this server shell renders the heading, the client panel renders
 * the region — and the screen renders exactly one of each.
 *
 * Deliberately **not exported**: Next.js validates a page module's export surface, and nothing
 * outside this file needs the string.
 */
const VOICE_HEADING_ID = 'jamee-voice-heading';

export default async function VoicePage() {
  /**
   * Requirement 1.6, as the second layer. The first is `src/proxy.ts`, which gates every path in
   * `PROTECTED_SCREEN_PATHS` — `/voice` among them — before this file runs at all. `requireFarmer()`
   * validates the session against the store (Better Auth's server-confirmed `getSession`, V30) and
   * `redirect()`s a signed-out visitor, so nothing below runs without a session. `userId` is a value
   * this render needs — the owner every uploaded recording is stamped with and the id the
   * Data_Access_Layer scopes every read to (D18).
   */
  const userId = await requireFarmer();

  /**
   * The profile's preferred language is the standing default the switcher starts from
   * (Requirement 1.8). `null` means the farmer has no profile row, which by construction should not
   * happen, so the screen falls back to the column default rather than failing. Read through the
   * owner-scoped Data_Access_Layer (D18).
   */
  const settings: ProfileSettings = (await readProfileSettings(() =>
    farmerData(userId).readProfile(),
  )) ?? { displayName: null, language: DEFAULT_LANGUAGE };

  /**
   * The cookie if the farmer has chosen on this device, otherwise their profile's preference,
   * otherwise `en`. One function, so this screen cannot order those fallbacks differently from
   * `/chat` or `/diagnose` (Requirement 9.2). It is also the language the recording is transcribed
   * into: `useJameeRequests()` stamps it onto the voice request from context.
   */
  const language = await activeLanguage(settings.language);
  const { ui } = messages(language);

  /**
   * The active web thread — the same row `/chat` resolves, through the owner-scoped Data_Access_Layer
   * (`conversationStoreFrom()` binds to `farmerData(userId)` per call under A3, so the lookup and any
   * insert are scoped to this farmer by construction — no client to pass).
   */
  const conversation = await findOrCreateActive(userId, 'web', conversationStoreFrom());

  return (
    /**
     * `lang` on the landmark rather than on `<html>`: the root layout is language-agnostic and this
     * screen knows which language its furniture is in. The transcript and the answer inside carry
     * their own `lang` from the language they were produced in, which is what keeps a Marathi
     * answer pronounced as Marathi after the farmer switches to English.
     */
    <LanguageProvider initialLanguage={language}>
      {/**
       * The provider is not optional furniture: `useJameeRequests()` is the only way to reach
       * `/api/voice`, it takes the language from this context, and it throws rather than defaulting
       * to `en` when the provider is missing (Requirement 9.2).
       */}
      <AppShell
        active="voice"
        description={ui.voiceDescription}
        displayName={settings.displayName}
        headingId={VOICE_HEADING_ID}
        language={language}
        title={ui.navVoice}
      >
        {/*
         * `ui.navVoice` — "Speak a question" — is the nav label and this heading, the same way
         * `/chat` uses `ui.navChat`. The id is what names the result region, so the accessible name
         * a screen reader reads is the words a sighted farmer sees.
         */}

        {/*
         * The recorder and the `aria-live="polite"` result region, in one client subtree. The
         * callback wiring is why that pair is a client component: a server component cannot hand
         * `VoiceRecorder` a function.
         */}
        <section className={styles.voiceCard}>
          <div className={styles.microphone} aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
            </svg>
          </div>
          <VoicePanel
            userId={userId}
            conversationId={conversation.id}
            labelledBy={VOICE_HEADING_ID}
          />
        </section>
      </AppShell>
    </LanguageProvider>
  );
}
