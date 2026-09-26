/**
 * Dependency-free names and enumerations shared by the Data_Access_Layer's typed accessors
 * (`collections.ts`, a `server-only` module) AND the setup module + script (`setup.ts`,
 * `scripts/db-setup.ts`, which run under bare `node --experimental-strip-types`).
 *
 * Requirements: 13.1 (the collections the layer scopes), 4.1 (the five verified conditions)
 * Design: "Data model and collection setup", D17
 *
 * =============================================================================
 * WHY THIS MODULE HAS NO IMPORTS
 * =============================================================================
 *
 * `scripts/db-setup.ts` runs under `node --experimental-strip-types`, which resolves neither the
 * `@/*` tsconfig path alias nor Next's `server-only` shim. So the single source of the collection
 * names and enum vocabularies has to be a module the script can import by a relative path with no
 * further alias or `server-only` in its chain — this one. `collections.ts` re-exports these so the
 * app keeps one import site, and `setup.ts` imports them relatively so the setup logic and the
 * typed accessors cannot disagree about a collection name or an enum member.
 *
 * The five verified-condition NAMES live here too, mirroring `VERIFIED_CONDITIONS` in
 * `src/lib/schemas.ts` character-for-character (the safety gate, Requirement 4.1). A unit test
 * asserts the two lists are identical, so this copy cannot drift from the schema's copy — the
 * duplication buys node-resolvability without weakening the single-source guarantee.
 */

/** Every Jamee collection name. */
export const COLLECTIONS = {
  profiles: 'profiles',
  conversations: 'conversations',
  messages: 'messages',
  diagnoses: 'diagnoses',
  usageLogs: 'usage_logs',
  counters: 'counters',
  diseaseKnowledge: 'disease_knowledge',
  telegramInbound: 'telegram_inbound',
  linkTokens: 'link_tokens',
  paymentOrders: 'payment_orders',
  botEntitlements: 'bot_entitlements',
  webhookThrottle: 'webhook_throttle',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/** The single GridFS bucket (D17). Its collections are `media.files` / `media.chunks`. */
export const MEDIA_BUCKET = 'media';

export const MEDIA_KINDS = ['crop-image', 'thumbnail', 'voice'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const TELEGRAM_INBOUND_STATUSES = [
  'received',
  'processed',
  'failed',
  'rejected',
  'unlinked',
  'not_entitled',
] as const;
export type TelegramInboundStatus = (typeof TELEGRAM_INBOUND_STATUSES)[number];

export const TELEGRAM_MESSAGE_TYPES = ['start', 'text', 'photo', 'voice', 'other'] as const;
export type TelegramMessageType = (typeof TELEGRAM_MESSAGE_TYPES)[number];

export const PAYMENT_ORDER_STATUSES = ['created', 'captured', 'failed', 'cancelled'] as const;
export type PaymentOrderStatus = (typeof PAYMENT_ORDER_STATUSES)[number];

export const WEBHOOK_ROUTES = ['payment', 'telegram'] as const;
export type WebhookRoute = (typeof WEBHOOK_ROUTES)[number];

/**
 * The five verified conditions, mirroring `VERIFIED_CONDITIONS` in `src/lib/schemas.ts`. Kept here
 * so the node-run setup script can validate and seed without importing the `@/`-aliased schema
 * chain; `tests/unit/*` assert the two lists are byte-identical (Requirement 4.1's safety gate).
 */
export const VERIFIED_CONDITION_NAMES = [
  'Tomato Early Blight',
  'Tomato Late Blight',
  'Tomato Healthy',
  'Potato Early Blight',
  'Potato Late Blight',
] as const;
export type VerifiedConditionName = (typeof VERIFIED_CONDITION_NAMES)[number];
