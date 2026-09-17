import { redirect } from 'next/navigation';

import { ChatComposer } from '@/components/ChatComposer';
import {
  CHAT_HEADING_ID,
  CHAT_MESSAGE_LIMIT,
  CHAT_MESSAGES_SELECT,
  toChatTurns,
} from '@/components/ChatThread';
import { LanguageProvider } from '@/components/LanguageProvider';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { SIGN_IN_PATH } from '@/lib/auth/protected-paths';
import { AppError } from '@/lib/errors';
import { activeLanguage } from '@/lib/language.server';
import { messages } from '@/lib/messages';
import {
  DEFAULT_LANGUAGE,
  PROFILE_SETTINGS_SELECT,
  readProfileSettings,
  type ProfileSettings,
} from '@/lib/profile';
import { createServerSupabase, currentUserId } from '@/lib/supabase/server';
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
 *          and its messages via RLS plus a client `ChatComposer`
 *
 * Server component: no `'use client'`, no state, no `fetch`. The design's rule of thumb applies
 * literally — *no route handler is called just to read data a server component can query directly
 * under RLS* — so the thread is read here and `/api/chat` is only ever asked to *write* a turn.
 *
 * ### The conversation id is resolved here, and that is the point
 *
 * `/api/chat` requires a `conversationId` that is a uuid this farmer owns; anything else is
 * `CONVERSATION_NOT_FOUND`. So the id cannot come from the browser, and it is resolved with
 * `findOrCreateActive(userId, 'web')` — the same find-or-create the diagnosis path and the
 * WhatsApp adapter use, which is what keeps a farmer's web thread one long-running conversation
 * (Requirements 7.1, 7.2) and keeps it a *different row* from their WhatsApp thread.
 *
 * A consequence worth stating: loading this screen creates a conversation row for a farmer who has
 * none, before any question is asked. That is `conversations` doing what Requirement 7.5 already
 * has it do for a diagnosis started without one — an empty thread is not farmer-visible anywhere,
 * and the alternative (create on first send) would mean either the client inventing an id or a
 * round trip added to the first question of every session.
 */

/**
 * The session, the profile row and the farmer's messages decide the entire output, so this page
 * must never be prerendered. `cookies()` inside `createServerSupabase()` and `activeLanguage()`
 * already force a dynamic render; saying so is the honest version of that, and it keeps a build
 * without Supabase credentials from failing on a page whose output could not have been reused.
 * Same reasoning as `/`, `/diagnose`, `/history` and `/profile`.
 */
export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  /**
   * Requirement 1.6, as the second layer. The first is `src/proxy.ts`, which gates every path in
   * `PROTECTED_SCREEN_PATHS` — `/chat` among them — before this file runs at all. The check is
   * here anyway because `currentUserId()` is `getUser()` underneath (server-confirmed, not a
   * decoded cookie) and because `userId` is a value this render genuinely needs: it is the owner
   * of the conversation resolved below and the `user_id` predicate on the message read.
   *
   * `redirect()` throws to unwind the render, so nothing below runs without a session.
   */
  const userId = await currentUserId();
  if (userId === null) redirect(SIGN_IN_PATH);

  const supabase = await createServerSupabase();

  /**
   * The profile's preferred language is the standing default the switcher starts from
   * (Requirement 1.8). `null` means the farmer has no profile row, which by construction should
   * not happen, so the screen falls back to the column default rather than failing. Read with the
   * RLS-scoped client, like everything else here.
   */
  const settings: ProfileSettings = (await readProfileSettings(
    () =>
      supabase.from('profiles').select(PROFILE_SETTINGS_SELECT).eq('id', userId).maybeSingle(),
    userId,
  )) ?? { displayName: null, language: DEFAULT_LANGUAGE };

  /**
   * The cookie if the farmer has chosen on this device, otherwise their profile's preference,
   * otherwise `en`. One function, so this screen cannot order those fallbacks differently from
   * `/diagnose` or `/history` (Requirement 9.2).
   */
  const language = await activeLanguage(settings.language);
  const { ui } = messages(language);

  /**
   * The active web thread. The store is built from **this page's** RLS-scoped client rather than
   * left to the default, so the lookup, the insert and the message read below all run under the
   * same session — one client per render instead of three.
   */
  const conversation = await findOrCreateActive(userId, 'web', conversationStoreFrom(supabase));

  const { data: rows, error } = await supabase
    .from('messages')
    .select(CHAT_MESSAGES_SELECT)
    .eq('conversation_id', conversation.id)
    /**
     * RLS is the authorization boundary — the cookie-scoped client carries the farmer's session,
     * so PostgREST returns their rows and no others (Requirement 13.2). This predicate is the
     * explicit second layer the design's *Defence in depth* note asks for, and `messages.user_id`
     * is denormalized from the conversation for exactly that reason (migration 0003).
     */
    .eq('user_id', userId)
    /**
     * Newest first at the read so `CHAT_MESSAGE_LIMIT` drops the oldest, then reversed for display
     * by `toChatTurns`. `id` breaks a timestamp tie so the order is total and two renders agree.
     * Served by `messages_conversation_idx` on `(conversation_id, created_at desc)`.
     */
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(CHAT_MESSAGE_LIMIT);

  if (error !== null) {
    /**
     * A failed read is not an empty conversation. Rendering a blank thread because a query failed
     * would tell a farmer their questions are gone, so this fails loudly instead — the same
     * distinction `conversation.service.ts` makes for its own read, and the same one the diagnosis
     * detail screen makes for this table.
     */
    throw new AppError('INTERNAL_ERROR', {
      cause: error,
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
    <main className={styles.page} lang={language}>
      {/**
       * The provider is not optional furniture: `useJameeRequests()` is the only way to reach
       * `/api/chat`, it takes the language from this context, and it throws rather than defaulting
       * to `en` when the provider is missing (Requirement 9.2).
       */}
      <LanguageProvider initialLanguage={language}>
        <LanguageSwitcher />
        {/*
         * `ui.navChat` — "Ask a question" — is the nav label and this heading, the same way
         * `/diagnose` uses `ui.navDiagnose`. The id is what names the thread's live region, so the
         * accessible name a screen reader reads is the words a sighted farmer sees.
         */}
        <h1 className={styles.heading} id={CHAT_HEADING_ID}>
          {ui.navChat}
        </h1>
        <ChatComposer
          conversationId={conversation.id}
          initialTurns={toChatTurns(rows ?? [])}
          labelledBy={CHAT_HEADING_ID}
        />
      </LanguageProvider>
    </main>
  );
}
