import 'server-only';

import { authenticatedRoute } from '@/lib/api/authenticated-route';
import { accessData } from '@/lib/db/access';
import { entitlementStatus } from '@/services/entitlement.service';
import type { ProfileAccess } from '@/lib/access-schemas';

/**
 * `GET /api/profile/access` — the farmer's linking state and entitlement window, in one read.
 *
 * Requirements: 1.7 (no valid session ⇒ 401), 21.20 (the link card renders from the link state),
 *               22.18 (the recharge card renders from the entitlement window)
 * Design: D13, D14
 *
 * The profile server shell reads this once so the TelegramLinkCard and the BotUnlockCard both
 * render from a single round trip. The raw Telegram id is never exposed — only whether a link
 * exists — because a client screen needs the fact, not the chat account's numeric id.
 */

export const GET = authenticatedRoute(async (_request, session) => {
  const [isLinked, entitlement] = await Promise.all([
    accessData(session.userId).isTelegramLinked(),
    entitlementStatus(session.userId),
  ]);
  const body: ProfileAccess = { isLinked, entitlement };
  return Response.json(body);
});
