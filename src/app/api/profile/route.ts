import 'server-only';

import { authenticatedRoute } from '@/lib/api/authenticated-route';
import { farmerData } from '@/lib/db/farmer';
import { AppError } from '@/lib/errors';
import { saveProfileSettings, type ProfileSettings } from '@/lib/profile';

/**
 * `POST /api/profile` — persist the session farmer's display name and preferred language.
 *
 * Requirements: 1.7 (no valid session ⇒ 401), 1.8 (both values are persisted on that Farmer's
 *               Profile), 9.1 / 9.5 (the language must be one of the three), 13.2 (own-row only)
 * Design: "Frontend" — the client `ProfileForm` posts here; D18 (the write lands through the
 *         Data_Access_Layer)
 *
 * Under Amendment A3 the profile write is a route rather than a browser database call: there is no
 * browser database client. `authenticatedRoute` supplies the server-confirmed farmer id, and the
 * write goes through `farmerData(userId).setProfileFields`, which merges the owner into the
 * `updateOne` by construction — so the write reaches exactly this farmer's row and can express no
 * other. Only `displayName` and `language` are written; never `phone`, never `_id`.
 */

export const POST = authenticatedRoute(async (request, session) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch (cause) {
    throw new AppError('MESSAGE_INVALID', { cause, context: { reason: 'profile_body_not_json' } });
  }

  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const input = {
    displayName: typeof record.displayName === 'string' ? record.displayName : '',
    language: typeof record.language === 'string' ? record.language : '',
  };

  const saved: ProfileSettings = await saveProfileSettings(
    (fields) => farmerData(session.userId).setProfileFields(fields),
    input,
  );

  return Response.json(saved);
});
