import { z } from 'zod';

/**
 * The Zod schemas for account linking, payment, and the bot entitlement — the wire and outcome
 * contracts owned by the linking / payment / entitlement services and their routes.
 *
 * Requirements: 21 (Telegram Account Linking, as amended by A3), 22 (Payment And Bot Entitlement,
 *               as amended by A2 into a weekly recharge)
 * Design: D13 (the linking token), D14 (the entitlement window), D15 (the payment grant), D19 (the
 *         two multi-document transactions); Amendment A2 (the ₹20 / 7-day recharge), Amendment A3
 *         (MongoDB, the Data_Access_Layer)
 *
 * =============================================================================
 * WHY THESE LIVE HERE AND NOT IN `src/lib/schemas.ts`
 * =============================================================================
 *
 * `src/lib/schemas.ts` is the single source of the core contracts (the diagnosis/chat/voice wire
 * shapes, the error taxonomy, the media reference) and is shared across every worker. Amendment
 * A3's wave-4 split gives the linking / payment / entitlement surface its own schema module so a
 * worker can add the access-flow shapes without rewriting the shared file. These schemas import
 * only `zod`, so this module — like `schemas.ts` — stays importable from both client and server
 * code, which is what lets `BotUnlockCard` and `TelegramLinkCard` (client components) type their
 * fetch payloads against the same contracts the routes validate.
 *
 * The domain types are INFERRED from the schemas (`z.infer`), never hand-declared beside them, so a
 * schema change cannot silently drift from a type — the same discipline `schemas.ts` documents.
 */

/* ========================================================================== */
/* Linking — the token mint response and the bind outcome                      */
/* ========================================================================== */

/**
 * What `POST /api/link/token` returns: the deep link the farmer opens to bind this Telegram
 * account, plus the instant the underlying token expires.
 *
 * The token itself is NEVER returned in isolation and never stored in plaintext (D13): the
 * plaintext exists only inside `deepLink`, and only its sha-256 is stored. `expiresAt` is echoed so
 * the card can tell the farmer how long the link stays usable.
 */
export const linkTokenResponseSchema = z.object({
  /** `https://t.me/<bot>?start=<token>` — the Link_Deep_Link (Requirement 21.6). */
  deepLink: z.string().url(),
  /** ISO-8601 instant the token stops working (Requirement 21.4). */
  expiresAt: z.iso.datetime(),
});
export type LinkTokenResponse = z.infer<typeof linkTokenResponseSchema>;

/**
 * The seven distinguishable outcomes of `consumeAndBind(token, telegramUserId)`.
 *
 * Requirement 21.8 collapses `unknown`, `expired`, and `consumed` into ONE indistinguishable
 * variant (`invalid`) so the bot cannot be used as a token-validity oracle — the caller that
 * produces the farmer-facing reply learns only `invalid`, never which of the three it was.
 *
 * The remaining variants are each a distinct, nameable case:
 *  - `bound` — a fresh bind: the token was spent and `telegram_user_id` is now set (21.7).
 *  - `already_linked` — the sending id already equals the stored one; the token is consumed, the
 *    id is left unchanged (21.10).
 *  - `replaced` — the Profile held a DIFFERENT id and the sender is on no Profile; the token is
 *    consumed, the id is replaced, and the previously-bound id is returned so the caller can send
 *    it the "you no longer reach this account" notice (21.11, 21.12).
 *  - `already_linked_elsewhere` — the sending id is already bound to ANOTHER Profile; the unique
 *    index rolls the consume back, both Profiles are unchanged, and the token is LEFT UNCONSUMED
 *    (21.13). This is a failed binding, never a transfer.
 */
export const BIND_OUTCOME_KINDS = [
  'bound',
  'already_linked',
  'replaced',
  'already_linked_elsewhere',
  'invalid',
] as const;
export const bindOutcomeKindSchema = z.enum(BIND_OUTCOME_KINDS);
export type BindOutcomeKind = z.infer<typeof bindOutcomeKindSchema>;

/**
 * The full `BindOutcome`. `ownerId` is the farmer the token bound to, present on every non-`invalid`
 * variant; `replacedTelegramUserId` is set only on `replaced` and carries the id to notify (21.12).
 *
 * This is documented as the contract because the Telegram dispatch (a later worker) calls
 * `consumeAndBind` and switches on `kind` to choose the reply, so the shape is a published seam.
 */
export type BindOutcome =
  | { readonly kind: 'bound'; readonly ownerId: string }
  | { readonly kind: 'already_linked'; readonly ownerId: string }
  | {
      readonly kind: 'replaced';
      readonly ownerId: string;
      readonly replacedTelegramUserId: number;
    }
  | { readonly kind: 'already_linked_elsewhere'; readonly ownerId: string }
  | { readonly kind: 'invalid' };

/* ========================================================================== */
/* Payment — the order response                                                */
/* ========================================================================== */

/**
 * What `POST /api/payment/order` returns — exactly the four identifiers the browser Razorpay
 * Standard Checkout needs, and nothing more (Requirement 22.2, D15).
 *
 * The key SECRET, the paying farmer's id, and the recorded order document are all absent on
 * purpose: the checkout script needs the public `keyId` and the `orderId`, and echoes `amountMinor`
 * and `currency` only so the card renders the checkout without re-deriving them. The amount is the
 * server's `RECHARGE_PRICE_PAISE`, never the caller's — there is no amount field on the request.
 */
export const paymentOrderResponseSchema = z.object({
  orderId: z.string().min(1),
  keyId: z.string().min(1),
  amountMinor: z.int().positive(),
  currency: z.string().min(1),
});
export type PaymentOrderResponse = z.infer<typeof paymentOrderResponseSchema>;

/**
 * What `POST /api/payment/confirm` takes — the provider order id and nothing else (D20).
 *
 * The confirm route exists because Razorpay cannot deliver a webhook to `localhost`: the browser's
 * checkout success handler posts this so the SERVER can ask Razorpay whether the order settled. The
 * browser's success report is never trusted as proof of payment (Requirement 22.7); the order id is
 * only the handle the server-side check keys on, and the paying farmer is derived from the recorded
 * order and the session, never from this body.
 */
export const paymentConfirmRequestSchema = z.object({
  orderId: z.string().min(1),
});
export type PaymentConfirmRequest = z.infer<typeof paymentConfirmRequestSchema>;

/* ========================================================================== */
/* Entitlement — the farmer's current window                                   */
/* ========================================================================== */

/**
 * The farmer's entitlement window, as the entitlement service exposes it and the profile screen's
 * access read returns it.
 *
 * Amendment A2 makes the entitlement a validity WINDOW rather than a one-time flag: `expiresAt` is
 * the window end (`null` when the farmer has never recharged), and `isActive` is the single
 * `isEntitlementActive(expiresAt, now)` predicate the Telegram gate and the web card both read, so
 * "active" cannot come to mean two different things on two surfaces (D14).
 */
export const entitlementStatusSchema = z.object({
  /** ISO-8601 window end, or `null` for a farmer who has never recharged. */
  expiresAt: z.iso.datetime().nullable(),
  /** `isEntitlementActive(expiresAt, now)` — an expiry strictly in the future. */
  isActive: z.boolean(),
});
export type EntitlementStatus = z.infer<typeof entitlementStatusSchema>;

/* ========================================================================== */
/* The profile access read — link state + entitlement, in one round trip       */
/* ========================================================================== */

/**
 * What the profile screen's server shell reads once so the TelegramLinkCard and the BotUnlockCard
 * both render from a single database round trip (Requirement 21.20, 22.18).
 *
 * `isLinked` is whether the Profile currently holds a `telegram_user_id`; the raw id is
 * deliberately NOT exposed — the card needs only whether a link exists, not the chat account's
 * numeric id, which is farmer-adjacent identity a client screen has no use for.
 */
export const profileAccessSchema = z.object({
  isLinked: z.boolean(),
  entitlement: entitlementStatusSchema,
});
export type ProfileAccess = z.infer<typeof profileAccessSchema>;
