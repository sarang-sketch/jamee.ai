import 'server-only';

import type { ObjectId } from 'mongodb';

import type {
  Channel,
  InputKind,
  Language,
  MessageRole,
  ModelProvider,
  Operation,
  Severity,
  UsageOutcome,
  UsageRejectionReason,
  VerifiedCondition,
  WindowKind,
} from '@/lib/schemas';

/**
 * Collection names and the typed document shape of every Jamee collection.
 *
 * Requirements: 13.1, 13.2 (the collections the Data_Access_Layer scopes to a Farmer), 14.1–14.3
 *               (the counters collection the quota reserve keys on)
 * Design: "Data model and collection setup" (the 0002–0013 collection blocks, read under the A3
 *         mapping), D17 (one GridFS bucket by `metadata.kind`), D18 (the accessors that own these),
 *         D19 (the atomic operations built on `_id`/unique-index shapes); V28
 *
 * =============================================================================
 * WHY THE TYPES ARE INFERRED FROM `schemas.ts` RATHER THAN HAND-DECLARED
 * =============================================================================
 *
 * Every enumerated field below is typed from the Zod enum in `src/lib/schemas.ts` — `Language`,
 * `Severity`, `Channel`, `MessageRole`, `InputKind`, `Operation`, `ModelProvider`, `UsageOutcome`,
 * `UsageRejectionReason`, `WindowKind`, `VerifiedCondition`. That is the same single-source-of-
 * contracts discipline `schemas.ts` documents: a document interface that re-spelled `'web' |
 * 'telegram'` as a literal would drift from the schema the moment the schema changed, and the
 * compiler would not notice because both still typecheck. Reusing the inferred type makes that
 * impossible — the `$jsonSchema` validators in `scripts/db-setup.ts` (task 53.1) pin the same
 * vocabulary at the database, and the Zod schemas pin it at the wire, so all three agree by
 * construction.
 *
 * One enum is declared HERE rather than reused: `TelegramInboundStatus`. The status vocabulary A3
 * requires for `telegram_inbound` — `received | processed | failed | rejected | unlinked |
 * not_entitled` — is wider than the `whatsappInboundStatusSchema` still sitting in `schemas.ts`
 * (that schema, and the WhatsApp channel it served, are retired by tasks 60/51 which are not this
 * task's to run). So the current, correct vocabulary lives here next to the collection it belongs
 * to, and `scripts/db-setup.ts` pins the same set in the collection validator.
 *
 * =============================================================================
 * IDENTITY FIELDS — WHY SOME `_id`s ARE NOT ObjectIds
 * =============================================================================
 *
 *  - `profiles._id` is the Auth_User_Id the auth library assigns (a string), so identity is the
 *    primary key (D8).
 *  - `bot_entitlements._id` is the Auth_User_Id too, which is how "at most one entitlement per
 *    farmer" holds by primary-key uniqueness alone (D14) with no second constraint.
 *  - `telegram_inbound._id` is the Telegram `update_id` (a number), so the insert-before-work
 *    claim's duplicate-key error IS the duplicate-delivery signal (D19) with no secondary index.
 *
 * Every other collection uses a driver-assigned `ObjectId` `_id`.
 */

/**
 * Collection names, the media bucket, and the A3 enum vocabularies live in the dependency-free
 * `@/lib/db/names` so the node-run setup script can share them (see that module's header). They are
 * re-exported here so app code keeps one import site for the whole Data_Access_Layer surface.
 */
export {
  COLLECTIONS,
  MEDIA_BUCKET,
  MEDIA_KINDS,
  TELEGRAM_INBOUND_STATUSES,
  TELEGRAM_MESSAGE_TYPES,
  PAYMENT_ORDER_STATUSES,
  WEBHOOK_ROUTES,
} from '@/lib/db/names';
export type {
  CollectionName,
  MediaKind,
  PaymentOrderStatus,
  TelegramInboundStatus,
  TelegramMessageType,
  WebhookRoute,
} from '@/lib/db/names';

import type {
  MediaKind,
  PaymentOrderStatus,
  TelegramInboundStatus,
  TelegramMessageType,
  WebhookRoute,
} from '@/lib/db/names';

/* ========================================================================== */
/* Document shapes                                                             */
/* ========================================================================== */

/**
 * A Media_Reference as stored on a domain document — the `{ fileId, kind }` pair that replaces the
 * Supabase storage path (D17). `fileId` is the GridFS file `_id`.
 */
export interface MediaRefDoc {
  fileId: ObjectId;
  kind: MediaKind;
}

/** `profiles` — `_id` is the Auth_User_Id (D8). `phone` is optional contact info with no reader (1.9). */
export interface ProfileDoc {
  _id: string;
  email?: string | null;
  /** Nullable + partial-unique index (21.16); written only by the linking flow (D13). */
  telegramUserId?: number | null;
  /** Optional contact info only — no constraint, no reader (Requirement 1.9). */
  phone?: string | null;
  displayName?: string | null;
  language: Language;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationDoc {
  _id: ObjectId;
  /** The owning Auth_User_Id — the tenant anchor every accessor merges (D18). */
  ownerId: string;
  channel: Channel;
  title?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageDoc {
  _id: ObjectId;
  ownerId: string;
  conversationId: ObjectId;
  role: MessageRole;
  content: string;
  language: Language;
  channel: Channel;
  inputKind: InputKind;
  /** The GridFS voice file this message transcribes, when `inputKind === 'voice'`. */
  transcriptOf?: MediaRefDoc | null;
  createdAt: Date;
}

export interface DiagnosisDoc {
  _id: ObjectId;
  ownerId: string;
  conversationId: ObjectId;
  status: 'identified' | 'unknown';
  /** Present only when identified (the unknown-shape constraint forbids it otherwise). */
  diseaseName?: VerifiedCondition | null;
  knowledgeId?: ObjectId | null;
  confidence?: number | null;
  severity: Severity;
  explanation: string;
  language: Language;
  needsExpert: boolean;
  channel: Channel;
  /** The Full_Size_Image in GridFS (D17). */
  mediaRef: MediaRefDoc;
  /** Set by the retention sweep when the Full_Size_Image is deleted (18.7). */
  fullImageDeletedAt?: Date | null;
  modelProvider: ModelProvider;
  createdAt: Date;
}

export interface UsageLogDoc {
  _id: ObjectId;
  ownerId: string;
  operation: Operation;
  channel: Channel;
  modelProvider?: ModelProvider | 'none' | null;
  outcome: UsageOutcome;
  usedFallback: boolean;
  rejectionReason?: UsageRejectionReason | null;
  quotaSpent: boolean;
  latencyMs?: number | null;
  promptVersion?: string | null;
  conversationId?: ObjectId | null;
  diagnosisId?: ObjectId | null;
  createdAt: Date;
}

export interface DiseaseKnowledgeDoc {
  _id: ObjectId;
  diseaseName: VerifiedCondition;
  crop: 'tomato' | 'potato';
  scientificName?: string | null;
  symptoms: string[];
  causes: string[];
  /** Empty array for Tomato Healthy — the healthy-has-no-treatment invariant (3.4). */
  treatment: string[];
  prevention: string[];
  defaultSeverity: Severity;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `counters` — the quota + burst counter. The compound `{ ownerId, operation, windowKind,
 * windowKey }` is the unique index the atomic reserve keys on (D19). No channel component, which
 * is what makes 14.2's cross-channel sharing automatic.
 */
export interface CounterDoc {
  _id: ObjectId;
  ownerId: string;
  operation: Operation;
  windowKind: WindowKind;
  windowKey: string;
  used: number;
  updatedAt: Date;
}

/** `telegram_inbound` — `_id` is the `update_id`, so the primary key IS the idempotency claim (D19). */
export interface TelegramInboundDoc {
  _id: number;
  telegramUserId?: number | null;
  ownerId?: string | null;
  messageType: TelegramMessageType;
  status: TelegramInboundStatus;
  receivedAt: Date;
  completedAt?: Date | null;
}

/** `link_tokens` — the sha-256 is stored, never the plaintext (D13). */
export interface LinkTokenDoc {
  _id: ObjectId;
  ownerId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt?: Date | null;
  createdAt: Date;
}

export interface PaymentOrderDoc {
  _id: ObjectId;
  ownerId: string;
  providerOrderId: string;
  amountMinor: number;
  currency: string;
  status: PaymentOrderStatus;
  /** The captured payment id, present once a webhook grants; partial-unique (D19, 22.11). */
  providerPaymentId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `bot_entitlements` — `_id` is the Auth_User_Id, so one-per-farmer holds by the primary key (D14).
 * Under Amendment A2 the entitlement is a validity window: `expiresAt` lapses and is renewed by a
 * recharge, extended to `nextExpiry(now, currentExpiry)` in the same transaction as the claim (D19).
 */
export interface BotEntitlementDoc {
  _id: string;
  /** The idempotency claim — unique index; a duplicate key is the "already granted" signal (D19). */
  providerPaymentId: string;
  paymentOrderId?: ObjectId | null;
  /** Amendment A2 — the window end. `null`/past is unentitled (see `isEntitlementActive`). */
  expiresAt: Date;
  grantedAt: Date;
  updatedAt: Date;
}

/** `webhook_throttle` — no farmer, no foreign key (D16). Compound key `{ route, callerHash, windowKey }`. */
export interface WebhookThrottleDoc {
  _id: ObjectId;
  route: WebhookRoute;
  callerHash: string;
  windowKey: string;
  used: number;
  updatedAt: Date;
}
