import 'server-only';

import { authenticatedRoute } from '@/lib/api/authenticated-route';
import { mintLinkToken, unlink } from '@/services/linking.service';

/**
 * `POST /api/link/token` — mint a Link_Token for the session farmer.
 * `DELETE /api/link/token` — unlink this farmer's Telegram account.
 *
 * Requirements: 1.7 (no valid session ⇒ 401, nothing minted), 21.1 (the mint is an action, never a
 *               page render), 21.15 (unlink clears `telegram_user_id` and invalidates outstanding
 *               tokens while keeping the entitlement and every conversation), 22.20 (the entitlement
 *               survives unlink because it is keyed to the farmer)
 * Design: D13
 *
 * Both verbs go through `authenticatedRoute`, so the owning Auth_User_Id comes from the
 * server-confirmed session and NEVER from the request body (there is no body to read on either).
 * A handler cannot fabricate the `FarmerSession` it receives, so "mints for the session user only"
 * is a control-flow guarantee rather than a convention.
 */

export const POST = authenticatedRoute(async (_request, session) => {
  const token = await mintLinkToken(session.userId);
  return Response.json(token, { status: 201 });
});

export const DELETE = authenticatedRoute(async (_request, session) => {
  await unlink(session.userId);
  return new Response(null, { status: 204 });
});
