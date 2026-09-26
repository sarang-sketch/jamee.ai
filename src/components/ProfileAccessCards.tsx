'use client';

import { useRouter } from 'next/navigation';

import { BotUnlockCard } from '@/components/BotUnlockCard';
import { TelegramLinkCard } from '@/components/TelegramLinkCard';
import type { EntitlementStatus } from '@/lib/access-schemas';
import type { Language } from '@/lib/schemas';

/**
 * The client composition of the two access cards on the profile screen.
 *
 * Requirements: 21.20 (the link card renders from the link state and offers link/unlink), 22.18
 *               (the recharge card shows the window and offers a recharge)
 * Design: "Frontend" — `/profile` is a server shell plus client islands
 *
 * =============================================================================
 * WHY THIS WRAPPER EXISTS
 * =============================================================================
 *
 * `TelegramLinkCard` and `BotUnlockCard` each take an `onChanged` CALLBACK — a link/unlink or a
 * webhook-observed grant should re-read the server's access state so the cards flip to the new
 * truth. A server component cannot pass a function across the server/client boundary, so the
 * callback is created HERE, in a client component, as `router.refresh()` — which re-runs the
 * server shell's `GET`-equivalent render (the `page.tsx` read) and streams the fresh props down.
 *
 * The initial `isLinked` and `entitlement` come from the ONE server-side access read in `page.tsx`
 * (a single database round trip), so the first paint is correct without a client fetch; the cards
 * only fetch on an action or while polling for a webhook-written grant.
 */

export interface ProfileAccessCardsProps {
  /** Whether a Telegram account is currently linked — from the server-side access read. */
  isLinked: boolean;
  /** The entitlement window — from the same server-side access read. */
  entitlement: EntitlementStatus;
  /** The language every label on both cards is rendered in — the farmer's saved preference. */
  language: Language;
}

export function ProfileAccessCards({ isLinked, entitlement, language }: ProfileAccessCardsProps) {
  const router = useRouter();
  const onChanged = (): void => router.refresh();

  return (
    <>
      <TelegramLinkCard isLinked={isLinked} language={language} onChanged={onChanged} />
      <BotUnlockCard entitlement={entitlement} language={language} onChanged={onChanged} />
    </>
  );
}
