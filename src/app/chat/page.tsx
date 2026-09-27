import { AppShell } from '@/components/AppShell';
import { ChatComposer } from '@/components/ChatComposer';
import {
  CHAT_HEADING_ID,
  CHAT_MESSAGE_LIMIT,
  toChatTurns,
  type ChatMessageRow,
} from '@/components/ChatThread';
import { LanguageProvider } from '@/components/LanguageProvider';
import { requireFarmer } from '@/lib/auth/session';
import { farmerData } from '@/lib/db/farmer';
import { farmerReads } from '@/lib/db/reads';
import { AppError } from '@/lib/errors';
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
 * `/chat` — where a farmer types a question and reads Jamee's answer.
 *
 * Requirements: 1.6 (no session, no protected screen), 7.1 / 7.4 (the turn belongs to a
 *               Conversation, and both messages are persisted rows this screen reads back),
 *               9.1 / 9.2 (the active language is resolved here and every request carries it),
 *               13.2 (own rows only), 15.2 / 15.4 (the honest indicator and the returned error
 *               message are the composer's, bound to its real request)
 * Design: "Frontend" → screens table — `/chat` is a **server shell** that loads the conversation
 *          and its messages via the Data_Access_Layer plus a client `ChatComposer`
 *
 * =============================================================================
 * AMENDMENT A3 — THE DATA_ACCESS_LAYER REPLACES THE RETIRED RLS-SCOPED CLIENT
 * =============================================================================
 *
 * The retired design held an RLS-scoped `messages` query. Under A3 this shell holds no client: the
 * thread is read through the owner-scoped `farmerReads(userId).conversationMessages(...)` accessor
 * (D18), whose merged `ownerId` is the tenant boundary, and each `MessageDoc` is mapped to the
 * `ChatMessageRow` view the thread renders. The design's rule of thumb still applies literally — no
 * route handler is called just to read data a server component can query directly — so `/api/chat`
 * is only ever asked to *write* a turn, and it uses no database client.
 *
 * ### The conversation id is resolved here, and that is the point
 *
 * `/api/chat` requires a `conversationId` that this farmer owns; anything else is
 * `CONVERSATION_NOT_FOUND`. So the id cannot come from the browser, and it is resolved with
 * `findOrCreateActive(userId, 'web')` — the same find-or-create the diagnosis path uses, which
 * keeps a farmer's web thread one long-running conversation (Requirements 7.1, 7.2) and a
 * different row from any other channel's thread.
 */

/**
 * The session, the profile row and the farmer's messages decide the entire output, so this page
 * must never be prerendered. `requireFarmer()` (session) and `activeLanguage()` (language cookie)
 * already force a dynamic render. Same reasoning as `/`, `/diagnose`, `/history` and `/profile`.
 */
export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  /**
   * Requirement 1.6, as the second layer behind `src/proxy.ts`. `requireFarmer()` validates the
   * session against the store (not a decoded cookie) and `redirect()`s a signed-out visitor,
   * throwing to unwind the render. `userId` is the owner of the conversation resolved below and the
   * scope of the message read.
   */
  const userId = await requireFarmer();

  /**
   * The profile's preferred language is the standing default the switcher starts from (Requirement
   * 1.8). `null` means no profile row — which by construction should not happen — so the screen
   * falls back to the column default rather than failing. Read through the owner-scoped
   * Data_Access_Layer accessor.
   */
  const settings: ProfileSettings = (await readProfileSettings(async () => {
    const profile = await farmerData(userId).readProfile();
    return profile === null
      ? null
      : { displayName: profile.displayName ?? null, language: profile.language };
  })) ?? { displayName: null, language: DEFAULT_LANGUAGE };

  /**
   * The cookie if the farmer has chosen on this device, otherwise their profile's preference,
   * otherwise `en`. One function, so this screen cannot order those fallbacks differently from
   * `/diagnose` or `/history` (Requirement 9.2).
   */
  const language = await activeLanguage(settings.language);
  const { ui } = messages(language);

  /**
   * The active web thread. `conversationStoreFrom()` is the Data_Access_Layer store (its legacy
   * client parameter is ignored under A3), so the lookup and the create both run owner-scoped.
   */
  const conversation = await findOrCreateActive(userId, 'web', conversationStoreFrom());

  /**
   * The thread, read through the owner-scoped Data_Access_Layer. `conversationMessages` merges
   * `{ ownerId: userId }` (Requirement 13.2) and filters `conversationId`, newest-first with a cap
   * of `CHAT_MESSAGE_LIMIT` so the bound drops the oldest; `toChatTurns` reverses it for display.
   * The layer throws on a real failure, which surfaces as `INTERNAL_ERROR` rather than a blank
   * thread — a farmer must never be told their questions are gone because a read failed.
   */
  let rows: ChatMessageRow[];
  try {
    const docs = await farmerReads(userId).conversationMessages(conversation.id, CHAT_MESSAGE_LIMIT);
    rows = docs.map((doc) => ({
      id: doc._id.toHexString(),
      role: doc.role,
      content: doc.content,
      language: doc.language,
      inputKind: doc.inputKind,
      createdAt: doc.createdAt.toISOString(),
    }));
  } catch (cause) {
    throw new AppError('INTERNAL_ERROR', {
      cause,
      context: {
        reason: 'chat_messages_read_failed',
        conversationId: conversation.id,
        userId,
      },
    });
  }

  return (
    /**
     * `lang` on the landmark rather than on `<html>`: the root layout is language-agnostic and this
     * screen knows which language its furniture is in. Each message inside carries its own `lang`
     * from its stored language, which is what keeps a Marathi question pronounced as Marathi after
     * the farmer switches to English.
     */
    <LanguageProvider initialLanguage={language}>
      {/**
       * The provider is not optional furniture: `useJameeRequests()` is the only way to reach
       * `/api/chat`, it takes the language from this context, and it throws rather than defaulting
       * to `en` when the provider is missing (Requirement 9.2).
       */}
      <AppShell
        active="chat"
        description={ui.chatDescription}
        displayName={settings.displayName}
        headingId={CHAT_HEADING_ID}
        language={language}
        title={ui.navChat}
      >
        {/*
         * `ui.navChat` — "Ask a question" — is the nav label and this heading, the same way
         * `/diagnose` uses `ui.navDiagnose`. The id is what names the thread's live region, so the
         * accessible name a screen reader reads is the words a sighted farmer sees.
         */}

        <section className={styles.chatCard}>
          <div className={styles.channelHeader}>
            <span className={styles.statusDot} aria-hidden="true" />
            <span>{ui.channelWeb}</span>
          </div>
          <ChatComposer
            conversationId={conversation.id}
            initialTurns={toChatTurns(rows)}
            labelledBy={CHAT_HEADING_ID}
          />
        </section>
      </AppShell>
    </LanguageProvider>
  );
}
