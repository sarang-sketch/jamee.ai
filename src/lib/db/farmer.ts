import 'server-only';

import {
  type ClientSession,
  type Collection,
  type Document,
  type Filter,
  type OptionalUnlessRequiredId,
  type WithId,
  type WithoutId,
} from 'mongodb';

import { getDb, getMongoClient } from '@/lib/db/client';
import {
  COLLECTIONS,
  type BotEntitlementDoc,
  type ConversationDoc,
  type CounterDoc,
  type DiagnosisDoc,
  type LinkTokenDoc,
  type MessageDoc,
  type PaymentOrderDoc,
  type ProfileDoc,
  type TelegramInboundDoc,
  type TelegramInboundStatus,
  type TelegramMessageType,
  type UsageLogDoc,
  type WebhookRoute,
  type WebhookThrottleDoc,
} from '@/lib/db/collections';
import type { Operation, WindowKind } from '@/lib/schemas';

/**
 * The Data_Access_Layer entry point — every farmer-scoped read, write, and delete of a Jamee
 * collection passes through here, and the owning Auth_User_Id is merged into the filter and
 * stamped on the document so a route handler or a service CANNOT express an unscoped query.
 *
 * Requirements: 13.1 (scope every read/write/delete of profiles, conversations, messages,
 *               diagnoses, usage_logs, link_tokens, payment_orders, bot_entitlements to the owning
 *               Farmer), 13.2 (attach the Auth_User_Id to every query, never issue an unscoped one
 *               from a Farmer-facing path), 13.7 (the driver lives only here), 14.1–14.3 (the
 *               atomic quota counter)
 * Design: D18 (this layer is the isolation boundary that replaces RLS, and the CI check makes it
 *         the only holder of the driver), D19 (every Postgres single-statement atomicity guarantee
 *         mapped to a specific MongoDB operation, none a read-then-write); V28, V33
 *
 * =============================================================================
 * THE SHAPE THAT MAKES ISOLATION STRUCTURAL, NOT A CONVENTION
 * =============================================================================
 *
 * `farmerData(authUserId)` returns a bundle of accessors bound to ONE farmer. Every accessor it
 * exposes takes its filter WITHOUT an owner field and merges `{ ownerId }` itself; every insert it
 * exposes stamps `ownerId` from the bound id; no accessor lets a caller widen past that owner on an
 * update or a delete. There is deliberately **no** `find(arbitraryFilter)` seam, because a seam that
 * accepted a raw filter would let a caller hand one with no owner in it — which is the single defect
 * D18 says the design must make unexpressible. This is the structural analogue of the retired RLS
 * rule "a farmer sees only their own rows": under Postgres the database refused an unscoped read;
 * here the API has no method that performs one.
 *
 * The honest weakness D18 names: a defect *inside this module* — an accessor that forgot to merge
 * the owner — would breach isolation, and no behavioural test outside can see that because the
 * offending code is in the layer the test trusts. So the layer is small, `owned()` is the ONE place
 * the merge happens (every read accessor routes through it), and `tests/unit/*` prove the merge and
 * the stamp for each accessor (task 52.4).
 *
 * A small set of explicitly NAMED system accessors handle the few server paths that legitimately
 * have no farmer yet — the Telegram claim (before a sender is resolved), payment-webhook lookups by
 * provider id (no session at all), the retention sweep. Each is named for exactly what it does and
 * documented with why it is allowed to be unscoped, so an unscoped operation is a deliberate,
 * greppable exception rather than an accident hiding behind a generic `find`.
 */

/* ========================================================================== */
/* Typed collection handles — internal to this module                         */
/* ========================================================================== */

function profiles(): Collection<ProfileDoc> {
  return getDb().collection<ProfileDoc>(COLLECTIONS.profiles);
}
function conversations(): Collection<ConversationDoc> {
  return getDb().collection<ConversationDoc>(COLLECTIONS.conversations);
}
function messages(): Collection<MessageDoc> {
  return getDb().collection<MessageDoc>(COLLECTIONS.messages);
}
function diagnoses(): Collection<DiagnosisDoc> {
  return getDb().collection<DiagnosisDoc>(COLLECTIONS.diagnoses);
}
function usageLogs(): Collection<UsageLogDoc> {
  return getDb().collection<UsageLogDoc>(COLLECTIONS.usageLogs);
}
function counters(): Collection<CounterDoc> {
  return getDb().collection<CounterDoc>(COLLECTIONS.counters);
}
function telegramInbound(): Collection<TelegramInboundDoc> {
  return getDb().collection<TelegramInboundDoc>(COLLECTIONS.telegramInbound);
}
function paymentOrders(): Collection<PaymentOrderDoc> {
  return getDb().collection<PaymentOrderDoc>(COLLECTIONS.paymentOrders);
}
function botEntitlements(): Collection<BotEntitlementDoc> {
  return getDb().collection<BotEntitlementDoc>(COLLECTIONS.botEntitlements);
}
function webhookThrottle(): Collection<WebhookThrottleDoc> {
  return getDb().collection<WebhookThrottleDoc>(COLLECTIONS.webhookThrottle);
}

/** Collections carrying an `ownerId` tenant anchor. The union the owner merge is written against. */
type OwnedDoc =
  | ConversationDoc
  | MessageDoc
  | DiagnosisDoc
  | UsageLogDoc
  | CounterDoc
  | LinkTokenDoc
  | PaymentOrderDoc;

/**
 * Merge the bound owner into a caller-supplied filter. THE one place the merge happens, so a read
 * accessor cannot forget it: a spread of the caller's filter followed by `ownerId` last means even
 * a caller who tried to pass their own `ownerId` cannot override the bound one.
 *
 * Exported so `tests/unit/farmer-scope.test.ts` (task 52.4) can prove the merge in isolation: the
 * bound owner always wins, whatever the caller's filter carried.
 */
export function owned<T extends OwnedDoc>(ownerId: string, filter: Filter<T>): Filter<T> {
  return { ...filter, ownerId } as Filter<T>;
}

/**
 * Stamp the bound owner onto an insert document. THE one place the stamp happens — the caller's
 * doc first, then `ownerId` last, so a caller who tried to pass a different `ownerId` cannot
 * override the bound one. Exported for the same task-52.4 proof as `owned()`.
 */
export function stampOwner<T extends { ownerId: string }>(ownerId: string, doc: Omit<T, 'ownerId'>): T {
  return { ...doc, ownerId } as T;
}

export interface FarmerData {
  readonly ownerId: string;

  /* profiles — keyed by _id = the auth user id, which IS this farmer, so no ownerId field */
  readProfile(): Promise<ProfileDoc | null>;
  upsertProfileBootstrap(email: string | null): Promise<void>;
  setProfileFields(fields: Partial<Pick<ProfileDoc, 'displayName' | 'language' | 'phone'>>): Promise<void>;

  /* conversations */
  findConversations(filter?: Filter<ConversationDoc>): Promise<WithId<ConversationDoc>[]>;
  findOneConversation(filter: Filter<ConversationDoc>): Promise<WithId<ConversationDoc> | null>;
  insertConversation(doc: Omit<ConversationDoc, '_id' | 'ownerId' | 'createdAt' | 'updatedAt'>): Promise<WithId<ConversationDoc>>;

  /* messages */
  findMessages(filter?: Filter<MessageDoc>): Promise<WithId<MessageDoc>[]>;
  insertMessage(doc: Omit<MessageDoc, '_id' | 'ownerId' | 'createdAt'>): Promise<WithId<MessageDoc>>;

  /* diagnoses */
  findDiagnoses(filter?: Filter<DiagnosisDoc>): Promise<WithId<DiagnosisDoc>[]>;
  findOneDiagnosis(filter: Filter<DiagnosisDoc>): Promise<WithId<DiagnosisDoc> | null>;
  insertDiagnosis(doc: Omit<DiagnosisDoc, '_id' | 'ownerId' | 'createdAt'>): Promise<WithId<DiagnosisDoc>>;

  /* usage_logs — append only */
  insertUsageLog(doc: Omit<UsageLogDoc, '_id' | 'ownerId' | 'createdAt'>): Promise<void>;

  /* payment_orders / bot_entitlements — this farmer's own rows */
  findPaymentOrders(filter?: Filter<PaymentOrderDoc>): Promise<WithId<PaymentOrderDoc>[]>;
  insertPaymentOrder(doc: Omit<PaymentOrderDoc, '_id' | 'ownerId' | 'createdAt' | 'updatedAt'>): Promise<WithId<PaymentOrderDoc>>;
  readEntitlement(): Promise<BotEntitlementDoc | null>;

  /* atomic quota (D19) */
  counterTryIncrement(operation: Operation, windowKind: WindowKind, windowKey: string, limit: number): Promise<number | null>;
  counterDecrement(operation: Operation, windowKind: WindowKind, windowKey: string): Promise<number | null>;
  counterUsed(operation: Operation, windowKind: WindowKind, windowKey: string): Promise<number>;
}

/**
 * Bind every farmer-scoped accessor to one Auth_User_Id.
 *
 * The returned bundle is the ONLY way a route handler or a shared service touches farmer data.
 * Every read merges `owned(ownerId, …)`; every insert stamps `ownerId` and `createdAt`/`updatedAt`
 * (there is no database trigger, so the writing accessor owns those — Data model note); no method
 * accepts an owner override.
 */
export function farmerData(ownerId: string): FarmerData {
  const now = (): Date => new Date();

  return {
    ownerId,

    /* ---- profiles ------------------------------------------------------- */
    async readProfile() {
      return profiles().findOne({ _id: ownerId });
    },

    /**
     * The D8 bootstrap upsert — idempotent, defensive, runs on every authenticated request. Writes
     * `(_id, email)` and NO phone (Requirement 1.4). `$setOnInsert` keeps a first sign-in from
     * clobbering a language the farmer later chose, while still guaranteeing the document exists.
     */
    async upsertProfileBootstrap(email) {
      const ts = now();
      await profiles().updateOne(
        { _id: ownerId },
        {
          $setOnInsert: {
            _id: ownerId,
            language: 'en',
            createdAt: ts,
          },
          $set: { email, updatedAt: ts },
        },
        { upsert: true },
      );
    },

    async setProfileFields(fields) {
      await profiles().updateOne({ _id: ownerId }, { $set: { ...fields, updatedAt: now() } });
    },

    /* ---- conversations -------------------------------------------------- */
    async findConversations(filter = {}) {
      return conversations().find(owned(ownerId, filter)).sort({ updatedAt: -1 }).toArray();
    },
    async findOneConversation(filter) {
      return conversations().findOne(owned(ownerId, filter));
    },
    async insertConversation(doc) {
      const ts = now();
      const full = stampOwner<WithoutId<ConversationDoc>>(ownerId, { ...doc, createdAt: ts, updatedAt: ts });
      const res = await conversations().insertOne(full as OptionalUnlessRequiredId<ConversationDoc>);
      return { ...full, _id: res.insertedId } as WithId<ConversationDoc>;
    },

    /* ---- messages ------------------------------------------------------- */
    async findMessages(filter = {}) {
      return messages().find(owned(ownerId, filter)).sort({ createdAt: -1 }).toArray();
    },
    async insertMessage(doc) {
      const full = stampOwner<WithoutId<MessageDoc>>(ownerId, { ...doc, createdAt: now() });
      const res = await messages().insertOne(full as OptionalUnlessRequiredId<MessageDoc>);
      return { ...full, _id: res.insertedId } as WithId<MessageDoc>;
    },

    /* ---- diagnoses ------------------------------------------------------ */
    async findDiagnoses(filter = {}) {
      return diagnoses().find(owned(ownerId, filter)).sort({ createdAt: -1 }).toArray();
    },
    async findOneDiagnosis(filter) {
      return diagnoses().findOne(owned(ownerId, filter));
    },
    async insertDiagnosis(doc) {
      const full = stampOwner<WithoutId<DiagnosisDoc>>(ownerId, { ...doc, createdAt: now() });
      const res = await diagnoses().insertOne(full as OptionalUnlessRequiredId<DiagnosisDoc>);
      return { ...full, _id: res.insertedId } as WithId<DiagnosisDoc>;
    },

    /* ---- usage_logs ----------------------------------------------------- */
    async insertUsageLog(doc) {
      const full = stampOwner<WithoutId<UsageLogDoc>>(ownerId, { ...doc, createdAt: now() });
      await usageLogs().insertOne(full as OptionalUnlessRequiredId<UsageLogDoc>);
    },

    /* ---- payment_orders / bot_entitlements ------------------------------ */
    async findPaymentOrders(filter = {}) {
      return paymentOrders().find(owned(ownerId, filter)).sort({ createdAt: -1 }).toArray();
    },
    async insertPaymentOrder(doc) {
      const ts = now();
      const full = stampOwner<WithoutId<PaymentOrderDoc>>(ownerId, { ...doc, createdAt: ts, updatedAt: ts });
      const res = await paymentOrders().insertOne(full as OptionalUnlessRequiredId<PaymentOrderDoc>);
      return { ...full, _id: res.insertedId } as WithId<PaymentOrderDoc>;
    },
    async readEntitlement() {
      /* bot_entitlements._id IS the auth user id (D14), so this reads exactly this farmer's row. */
      return botEntitlements().findOne({ _id: ownerId });
    },

    /* ---- atomic quota (D19) --------------------------------------------- */
    async counterTryIncrement(operation, windowKind, windowKey, limit) {
      /**
       * The MongoDB form of migration 0007's `counter_try_increment`: one conditional upsert whose
       * filter carries `used < limit`, `$inc` the count, and `returnDocument: 'after'` reads back
       * the new value (V28). At the boundary the filter no longer matches, so `findOneAndUpdate`
       * returns `null` — OR the upsert races another reserve and raises a duplicate-key error on the
       * unique compound index. Both mean "declined": no read-then-write anywhere.
       */
      try {
        const ts = now();
        const doc = await counters().findOneAndUpdate(
          { ownerId, operation, windowKind, windowKey, used: { $lt: limit } },
          { $inc: { used: 1 }, $set: { updatedAt: ts }, $setOnInsert: { ownerId, operation, windowKind, windowKey } },
          { upsert: true, returnDocument: 'after' },
        );
        return doc?.used ?? null;
      } catch (error) {
        if (isDuplicateKeyError(error)) return null;
        throw error;
      }
    },
    async counterDecrement(operation, windowKind, windowKey) {
      /* Guarded `used > 0` decrement — the refund. Never drives the count below zero (14.x). */
      const doc = await counters().findOneAndUpdate(
        { ownerId, operation, windowKind, windowKey, used: { $gt: 0 } },
        { $inc: { used: -1 }, $set: { updatedAt: now() } },
        { returnDocument: 'after' },
      );
      return doc?.used ?? null;
    },
    async counterUsed(operation, windowKind, windowKey) {
      const doc = await counters().findOne({ ownerId, operation, windowKind, windowKey });
      return doc?.used ?? 0;
    },
  };
}

/* ========================================================================== */
/* Duplicate-key detection (D19, V28)                                          */
/* ========================================================================== */

/**
 * A MongoDB duplicate-key error carries `code === 11000` on the thrown error (V28). This is the
 * "already claimed / already granted" signal for the counter upsert race, the `telegram_inbound`
 * claim, and the payment grant — a value the atomic-helper callers test rather than a read they do
 * first.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

/* ========================================================================== */
/* NAMED system accessors — the few paths that legitimately have no farmer     */
/* ========================================================================== */

/**
 * The Telegram inbound claim — `insertOne` with `_id = update_id`, whose duplicate-key error IS the
 * duplicate-delivery signal (D19, D11). This is unscoped by nature: it runs BEFORE the sender is
 * resolved to a Profile (11.7), so there is no owner to key on yet, and its whole job is to be the
 * first billable-preceding step. Returns `true` on a fresh claim, `false` on a duplicate.
 */
export async function claimTelegramUpdate(
  updateId: number,
  telegramUserId: number | null,
  messageType: TelegramMessageType,
): Promise<boolean> {
  try {
    await telegramInbound().insertOne({
      _id: updateId,
      telegramUserId,
      ownerId: null,
      messageType,
      status: 'received',
      receivedAt: new Date(),
    });
    return true;
  } catch (error) {
    if (isDuplicateKeyError(error)) return false;
    throw error;
  }
}

/** Move a claimed inbound update to its terminal status (D11: `markProcessed` after the reply). */
export async function setTelegramInboundStatus(
  updateId: number,
  status: TelegramInboundStatus,
  ownerId: string | null,
): Promise<void> {
  await telegramInbound().updateOne(
    { _id: updateId },
    { $set: { status, ownerId, completedAt: new Date() } },
  );
}

/**
 * Resolve a Telegram sender to a Profile — the one legitimate cross-farmer read, because at this
 * point the request has no owner and resolution is precisely how it acquires one (10.2). Reads by
 * the `telegram_user_id` partial-unique index (D13).
 */
export async function resolveProfileByTelegramUserId(telegramUserId: number): Promise<ProfileDoc | null> {
  return profiles().findOne({ telegramUserId });
}

/**
 * Payment-webhook lookup by the provider's order id — no farmer session exists on that route
 * (22.24), so who paid is derived from the recorded order rather than from the session or the
 * webhook payload (D15). System-scoped by necessity and named for exactly that.
 */
export async function findPaymentOrderByProviderId(providerOrderId: string): Promise<PaymentOrderDoc | null> {
  return paymentOrders().findOne({ providerOrderId });
}

/**
 * The per-caller webhook throttle upsert (D16, D19) — the same single conditional-upsert pattern as
 * the quota counter, on a collection with no farmer to key on. Returns the new count, or `null` at
 * the limit (including the duplicate-key race). Not part of `FarmerData` because it has no farmer.
 */
export async function webhookThrottleTryIncrement(
  route: WebhookRoute,
  callerHash: string,
  windowKey: string,
  limit: number,
): Promise<number | null> {
  try {
    const doc = await webhookThrottle().findOneAndUpdate(
      { route, callerHash, windowKey, used: { $lt: limit } },
      { $inc: { used: 1 }, $set: { updatedAt: new Date() }, $setOnInsert: { route, callerHash, windowKey } },
      { upsert: true, returnDocument: 'after' },
    );
    return doc?.used ?? null;
  } catch (error) {
    if (isDuplicateKeyError(error)) return null;
    throw error;
  }
}

/**
 * Delete `minute`-window counter rows whose last write is older than `olderThan` — the burst
 * limiter's periodic housekeeping (Requirement 13.8, task 24.1's prune). System-scoped by nature:
 * it is age-scoped across all farmers, exactly like the retired `counter_prune_minute_windows`
 * database function, and it NEVER touches a `day` row (deleting one would hand a farmer a fresh
 * daily allowance — the invariant migration 0007 kept inside the function, now kept inside this
 * filter). Returns how many rows were removed, so a caller can log what housekeeping achieved.
 *
 * Not part of `FarmerData` because it has no farmer and must not be reachable from a farmer-scoped
 * path — it is a named system accessor beside the others, so an unscoped delete is a deliberate,
 * greppable exception rather than an accident.
 */
export async function pruneMinuteCounters(olderThan: Date): Promise<number> {
  const result = await counters().deleteMany({
    windowKind: 'minute',
    updatedAt: { $lt: olderThan },
  });
  return result.deletedCount ?? 0;
}

/* ========================================================================== */
/* Transactions (D19, V33)                                                     */
/* ========================================================================== */

/**
 * Run `work` inside one multi-document transaction on the cached client's session, retrying on the
 * driver's transient-transaction / retryable-write errors per its defaults (V33). Atlas M0 is a
 * replica set, so transactions are available (V32, V33); the integration harness exercises them on
 * a single-node `MongoMemoryReplSet` (V31).
 *
 * This is the atomicity boundary D19 hands the two operations that genuinely span two documents:
 * the linking consume-and-bind (consume the token, then set `telegram_user_id`) and the payment
 * grant-plus-extend (claim `providerPaymentId`, then extend the entitlement window). Either both
 * writes land or neither does, so a crash between them cannot leave a half-state and a redelivery
 * cannot double-apply. `work` receives the session; every collection operation inside it must pass
 * `{ session }` to take part in the transaction.
 */
export async function withTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = getMongoClient().startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    // `withTransaction` resolves only after a committed body ran, so `result` is assigned.
    return result!;
  } finally {
    await session.endSession();
  }
}

/**
 * The raw `Db` handle, exposed ONLY to sibling `src/lib/db/**` modules (the setup script, the
 * GridFS media store) that legitimately need it. It is re-exported here rather than importing
 * `client.ts` all over the layer, and it is not part of `FarmerData` — nothing outside `src/lib/db`
 * can reach it, which is what `scripts/check-data-access.ts` proves.
 */
export { getDb, getMongoClient } from '@/lib/db/client';

/** Re-exported for the transaction-bearing access services and the setup script. */
export type { ClientSession, Document };
