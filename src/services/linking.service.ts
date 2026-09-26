import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import { LINK_TOKEN_TTL_MINUTES } from '@/lib/config/access';
import { accessData, consumeAndBind as consumeAndBindDal } from '@/lib/db/access';
import { withTransaction } from '@/lib/db/farmer';
import { telegramBotUsername } from '@/lib/env.public';
import type { BindOutcome, LinkTokenResponse } from '@/lib/access-schemas';

/**
 * Telegram account linking — the mint path, the consume-and-bind, and the unlink.
 *
 * Requirements: 21.1–21.5 (mint a single-use, time-bounded token from a secure source and return
 *               the deep link), 21.6 (the `https://t.me/<bot>?start=<token>` form), 21.7, 21.8,
 *               21.10–21.14, 21.18, 21.19 (the four bind outcomes and the one indistinguishable
 *               invalid variant), 21.15 (unlink keeps the entitlement and every conversation)
 * Design: D13 (only the sha-256 is stored; expiry bounds a leaked link in time, single use bounds
 *         it in count), D19 (consume-and-bind is one multi-document transaction)
 *
 * =============================================================================
 * THE TOKEN: SECURE, HASHED, AND DERIVED FROM NOTHING
 * =============================================================================
 *
 * The plaintext is `randomBytes(32)` rendered as url-safe base64 — 256 bits from Node's CSPRNG, so
 * a party able to send arbitrary `/start` payloads to a public bot cannot guess or enumerate an
 * outstanding token (21.5). No part of it is derived from an Auth_User_Id, a Google_Email, a
 * Telegram_User_Id, or a timestamp (21.2), because any such derivation would let someone who knows
 * one of those narrow the search.
 *
 * Only the sha-256 of the plaintext is stored (D13). The plaintext exists solely inside the deep
 * link returned to the farmer; the lookup on the way back is by hash, so the plaintext is never
 * compared in a query and a snapshot of `link_tokens` is not a list of live capabilities.
 *
 * `consumeAndBind` is exported because the Telegram dispatch (a later worker) calls it: a `/start`
 * carrying a token hands the plaintext here, this module hashes it and runs the transaction, and
 * the dispatch switches on the returned `BindOutcome.kind` to choose the reply. That is the
 * published contract — documented on `BindOutcome` in `src/lib/access-schemas.ts`.
 */

/** The bytes of entropy in a minted token. 32 bytes = 256 bits — well past any enumeration. */
const TOKEN_ENTROPY_BYTES = 32;

/** sha-256 hex of the plaintext. THE only form stored, and the lookup key on the way back (D13). */
export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** A url-safe base64 token from the CSPRNG. Derived from nothing (21.2). */
function mintPlaintext(): string {
  return randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');
}

/**
 * Mint one link token for `ownerId` and return the deep link plus its expiry.
 *
 * Stores only the hash, with `expiresAt = now + LINK_TOKEN_TTL_MINUTES` (21.4) and `consumedAt`
 * null. The token is minted by this action and never on a page render, so opening the profile
 * screen does not litter the table with unused capabilities.
 */
export async function mintLinkToken(
  ownerId: string,
  now: Date = new Date(),
): Promise<LinkTokenResponse> {
  const plaintext = mintPlaintext();
  const expiresAt = new Date(now.getTime() + LINK_TOKEN_TTL_MINUTES * 60 * 1000);

  await accessData(ownerId).insertLinkToken({
    tokenHash: hashToken(plaintext),
    expiresAt,
  });

  const bot = telegramBotUsername();
  return {
    deepLink: `https://t.me/${bot}?start=${plaintext}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Consume a `/start` token and bind the sending Telegram id to the owning Profile.
 *
 * `plaintextToken` is what arrived in the `/start` payload; it is hashed here and looked up by hash
 * (D13). The whole consume-and-bind runs in ONE transaction (D19) inside the Data_Access_Layer;
 * this function only hashes, delegates, and re-shapes the DAL result into the published
 * `BindOutcome`.
 *
 * No shared service is invoked and no quota unit is reserved on any of these paths (21.18).
 */
export async function consumeAndBind(
  plaintextToken: string,
  telegramUserId: number,
  now: Date = new Date(),
): Promise<BindOutcome> {
  const result = await consumeAndBindDal(hashToken(plaintextToken), telegramUserId, withTransaction, now);

  switch (result.kind) {
    case 'bound':
      return { kind: 'bound', ownerId: result.ownerId };
    case 'already_linked':
      return { kind: 'already_linked', ownerId: result.ownerId };
    case 'replaced':
      return { kind: 'replaced', ownerId: result.ownerId, replacedTelegramUserId: result.replacedTelegramUserId };
    case 'already_linked_elsewhere':
      return { kind: 'already_linked_elsewhere', ownerId: result.ownerId };
    case 'invalid':
      return { kind: 'invalid' };
  }
}

/**
 * Unlink this farmer's Telegram account: clear `telegram_user_id` and invalidate every outstanding
 * token, keeping the entitlement and every conversation, message, and diagnosis (21.15).
 *
 * The entitlement is keyed to the farmer (D14), so unlinking clears one nullable column and costs
 * nothing — a later re-link is served without further payment.
 */
export async function unlink(ownerId: string, now: Date = new Date()): Promise<void> {
  const data = accessData(ownerId);
  await data.clearTelegramLink();
  await data.invalidateOutstandingLinkTokens(now);
}
