import 'server-only';

import { isEntitlementActive } from '@/lib/config/access';
import { accessData } from '@/lib/db/access';
import type { EntitlementStatus } from '@/lib/access-schemas';

/**
 * The bot entitlement — the farmer's current validity window and the single active check.
 *
 * Requirements: 22.13 (the Telegram gate reads whether the farmer holds an unexpired entitlement),
 *               22.18 (the web card shows the current window), 22.20 (the entitlement is keyed to
 *               the Auth_User_Id, so unlinking discards nothing)
 * Design: D14 (one entitlement per farmer by primary key; under Amendment A2 a validity window that
 *         a recharge extends); Amendment A2 decision 4 (the gate is "expiry in the future")
 *
 * =============================================================================
 * ONE PREDICATE, TWO SURFACES
 * =============================================================================
 *
 * `isEntitlementActive(expiresAt, now)` (from `src/lib/config/access.ts`) is the ONE definition of
 * "the window still grants access", read by the Telegram gate and by the web recharge card alike,
 * so "active" cannot come to mean two different things on two surfaces. A `null` expiry — a farmer
 * with no entitlement row — is not access; a past expiry is not access. Both collapse into the same
 * predicate, so neither is a special case anywhere else.
 *
 * The entitlement is keyed to the Auth_User_Id and never to a Telegram_User_Id: the farmer paid,
 * not the chat account, so `isActive(userId)` answers the same whether or not a Telegram account is
 * currently linked (D14).
 */

/**
 * The farmer's window as data — the expiry (or `null`) and the active flag — for the profile
 * screen's access read and any caller that wants to display the window.
 */
export async function entitlementStatus(
  userId: string,
  now: Date = new Date(),
): Promise<EntitlementStatus> {
  const entitlement = await accessData(userId).readEntitlement();
  const expiresAt = entitlement?.expiresAt ?? null;
  return {
    expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
    isActive: isEntitlementActive(expiresAt, now),
  };
}

/**
 * Whether the farmer holds an entitlement whose window is still open — the ONLY read the Telegram
 * gate needs (22.13, A2 decision 4). Keyed to the Auth_User_Id (D14), so a linked-but-lapsed farmer
 * answers `false` and a linked-and-current one answers `true`, independent of which Telegram account
 * is bound.
 */
export async function isActive(userId: string, now: Date = new Date()): Promise<boolean> {
  const entitlement = await accessData(userId).readEntitlement();
  return isEntitlementActive(entitlement?.expiresAt ?? null, now);
}
