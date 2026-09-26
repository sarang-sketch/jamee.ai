import 'server-only';

import {
  type ClientSession,
  type Collection,
  type Filter,
  type OptionalUnlessRequiredId,
  type WithId,
  type WithoutId,
} from 'mongodb';

import { getDb } from '@/lib/db/client';
import {
  COLLECTIONS,
  type BotEntitlementDoc,
  type LinkTokenDoc,
  type PaymentOrderDoc,
  type PaymentOrderStatus,
  type ProfileDoc,
} from '@/lib/db/collections';
import { owned, stampOwner, isDuplicateKeyError } from '@/lib/db/farmer';

/**
 * The Data_Access_Layer for the access flow — linking, payment orders, and the bot entitlement.
 *
 * Requirements: 13.1, 13.2 (every farmer-scoped read/write/delete of `link_tokens`,
 *               `payment_orders`, and `bot_entitlements` is scoped to the owning Farmer), 13.7 (the
 *               driver lives only under `src/lib/db/**`), 21 (linking), 22 (payment and the
 *               entitlement window, as amended by A2)
 * Design: D13 (the token: only the sha-256 is stored), D14 (one entitlement per farmer by primary
 *         key; a validity window under A2), D15 (the grant derives the farmer from the recorded
 *         order, never the webhook payload), D18 (this module is inside the layer and merges the
 *         owner into every farmer-scoped query), D19 (the two multi-document transactions and the
 *         duplicate-key idempotency claims)
 *
 * =============================================================================
 * WHY THIS SITS BESIDE `farmer.ts` RATHER THAN INSIDE IT
 * =============================================================================
 *
 * `src/lib/db/farmer.ts` is a committed building block owned by another wave and must not be
 * edited. The wave-4 split gives the access collections their own accessor module here, which
 * REUSES `owned()` and `stampOwner()` from `farmer.ts` (both exported for exactly this) so the
 * owner-merge is still THE one place it happens — a farmer-scoped read here cannot forget the merge
 * any more than one in `farmer.ts` can, because it routes through the same helper. `isDuplicateKeyError`
 * is reused too, so the `11000` "already claimed / already granted" signal is read identically
 * everywhere.
 *
 * The few ownerless paths the webhook and the linking bind legitimately need — a lookup by the
 * provider's order id (no farmer session on that route, D15), the entitlement read by farmer id for
 * the transaction, the Telegram-id bind — are NAMED system functions, following the same convention
 * `farmer.ts` uses: an unscoped operation is a deliberate, greppable exception rather than an
 * accident hiding behind a generic `find`.
 *
 * =============================================================================
 * WHY THE TWO TRANSACTIONS LIVE HERE
 * =============================================================================
 *
 * D19 hands two operations that span two documents to a multi-document transaction: the linking
 * consume-and-bind (spend the token, set `telegram_user_id`) and the payment grant-plus-extend
 * (claim the payment id, extend the entitlement window). Both use `withTransaction` from
 * `farmer.ts`, which opens a session on the SAME cached client — so every collection operation
 * inside passes `{ session }`. The services (`linking.service.ts`, `payment.service.ts`) call these
 * helpers; the transaction body never leaves the Data_Access_Layer.
 */

/* ========================================================================== */
/* Typed collection handles — internal to this module                         */
/* ========================================================================== */

function linkTokens(): Collection<LinkTokenDoc> {
  return getDb().collection<LinkTokenDoc>(COLLECTIONS.linkTokens);
}
function paymentOrders(): Collection<PaymentOrderDoc> {
  return getDb().collection<PaymentOrderDoc>(COLLECTIONS.paymentOrders);
}
function botEntitlements(): Collection<BotEntitlementDoc> {
  return getDb().collection<BotEntitlementDoc>(COLLECTIONS.botEntitlements);
}
function profiles(): Collection<ProfileDoc> {
  return getDb().collection<ProfileDoc>(COLLECTIONS.profiles);
}

/* ========================================================================== */
/* Farmer-scoped accessors                                                     */
/* ========================================================================== */

export interface AccessData {
  readonly ownerId: string;

  /* link_tokens — the farmer mints and reads their own */
  insertLinkToken(doc: Omit<LinkTokenDoc, '_id' | 'ownerId' | 'createdAt' | 'consumedAt'>): Promise<WithId<LinkTokenDoc>>;
  /** Invalidate every outstanding (unconsumed) token of this farmer — the unlink step (21.15). */
  invalidateOutstandingLinkTokens(now: Date): Promise<number>;

  /* payment_orders — the farmer's own rows */
  insertPaymentOrder(doc: Omit<PaymentOrderDoc, '_id' | 'ownerId' | 'createdAt' | 'updatedAt' | 'providerPaymentId'>): Promise<WithId<PaymentOrderDoc>>;
  findPaymentOrders(filter?: Filter<PaymentOrderDoc>): Promise<WithId<PaymentOrderDoc>[]>;

  /* bot_entitlements — keyed by _id = the auth user id, so own-row by construction (D14) */
  readEntitlement(): Promise<BotEntitlementDoc | null>;

  /* profile linking state */
  isTelegramLinked(): Promise<boolean>;
  /** Unlink: clear `telegram_user_id`, keeping the entitlement and every other field (21.15). */
  clearTelegramLink(): Promise<void>;
}

/**
 * Bind every access-collection accessor to one Auth_User_Id. The returned bundle is the only way a
 * route or service touches this farmer's linking, order, or entitlement rows: every read merges
 * `owned(ownerId, …)`, every insert stamps `ownerId`, and no method accepts an owner override.
 */
export function accessData(ownerId: string): AccessData {
  const now = (): Date => new Date();

  return {
    ownerId,

    /* ---- link_tokens ---------------------------------------------------- */
    async insertLinkToken(doc) {
      const full = stampOwner<WithoutId<LinkTokenDoc>>(ownerId, {
        ...doc,
        consumedAt: null,
        createdAt: now(),
      });
      const res = await linkTokens().insertOne(full as OptionalUnlessRequiredId<LinkTokenDoc>);
      return { ...full, _id: res.insertedId } as WithId<LinkTokenDoc>;
    },
    async invalidateOutstandingLinkTokens(when) {
      /**
       * Mark every still-usable token spent. `owned()` scopes it to this farmer, and the extra
       * `consumedAt: null` predicate means an already-consumed token is left as it was — so an
       * unlink cannot un-record a past bind, only close what is still open.
       */
      const res = await linkTokens().updateMany(
        owned<LinkTokenDoc>(ownerId, { consumedAt: null }),
        { $set: { consumedAt: when } },
      );
      return res.modifiedCount ?? 0;
    },

    /* ---- payment_orders ------------------------------------------------- */
    async insertPaymentOrder(doc) {
      const ts = now();
      const full = stampOwner<WithoutId<PaymentOrderDoc>>(ownerId, {
        ...doc,
        providerPaymentId: null,
        createdAt: ts,
        updatedAt: ts,
      });
      const res = await paymentOrders().insertOne(full as OptionalUnlessRequiredId<PaymentOrderDoc>);
      return { ...full, _id: res.insertedId } as WithId<PaymentOrderDoc>;
    },
    async findPaymentOrders(filter = {}) {
      return paymentOrders().find(owned(ownerId, filter)).sort({ createdAt: -1 }).toArray();
    },

    /* ---- bot_entitlements ----------------------------------------------- */
    async readEntitlement() {
      /* `_id` IS the auth user id (D14), so this reads exactly this farmer's row. */
      return botEntitlements().findOne({ _id: ownerId });
    },

    /* ---- profile linking state ------------------------------------------ */
    async isTelegramLinked() {
      /* profiles._id is the auth user id; a numeric telegram_user_id means linked (21.16). */
      const profile = await profiles().findOne({ _id: ownerId });
      return typeof profile?.telegramUserId === 'number';
    },
    async clearTelegramLink() {
      /**
       * Unlink clears exactly one nullable column. `$set: { telegramUserId: null }` touches no
       * conversation, message, diagnosis, or entitlement — the entitlement is keyed to the farmer,
       * so unlinking discards nothing and a later re-link is free (22.20, D14).
       */
      await profiles().updateOne({ _id: ownerId }, { $set: { telegramUserId: null, updatedAt: now() } });
    },
  };
}

/* ========================================================================== */
/* NAMED system accessors — the ownerless paths the webhook and bind need      */
/* ========================================================================== */

/**
 * Look up a payment order by the PROVIDER's order id — the payment webhook route carries no farmer
 * session (22.24, D15), so who paid is derived from the recorded order rather than from the session
 * or the webhook payload. `farmer.ts` exports `findPaymentOrderByProviderId` for the non-transactional
 * read; this one reads WITHIN a transaction, keyed the same way, for the grant-plus-extend below.
 * System-scoped by necessity and named for exactly that.
 */
async function findPaymentOrderByProviderIdInSession(
  providerOrderId: string,
  session: ClientSession,
): Promise<PaymentOrderDoc | null> {
  return paymentOrders().findOne({ providerOrderId }, { session });
}

/* ========================================================================== */
/* The linking consume-and-bind transaction (D13, D19)                         */
/* ========================================================================== */

/** The four terminal states the transaction reports; the service maps them to a `BindOutcome`. */
export type ConsumeBindResult =
  | { readonly kind: 'bound'; readonly ownerId: string }
  | { readonly kind: 'already_linked'; readonly ownerId: string }
  | { readonly kind: 'replaced'; readonly ownerId: string; readonly replacedTelegramUserId: number }
  | { readonly kind: 'already_linked_elsewhere'; readonly ownerId: string }
  | { readonly kind: 'invalid' };

/**
 * Consume a link token by its sha-256 hash and bind `telegramUserId` to the owning Profile, all in
 * ONE multi-document transaction (D19). `work` must be `withTransaction` from `farmer.ts`, which
 * opens the session on the cached client; it is passed in rather than imported so this module holds
 * no second transaction entry point.
 *
 * The single conditional `findOneAndUpdate` on `link_tokens` — filtered
 * `{ tokenHash, consumedAt: null, expiresAt: { $gt: now } }`, setting `consumedAt` — is the
 * authorization: its returned document IS the proof the token was live, and there is no read-then-
 * write, so two concurrent deliveries of one token (Telegram redelivers on a non-200, a farmer can
 * tap a link twice) cannot both see it unconsumed. Unknown, expired, and consumed all fail that one
 * filter identically and collapse into `invalid` (21.8).
 *
 * Then the bind, by the four outcomes (21.10–21.13):
 *  - the Profile holds no id, or the same id → set it (or leave it) and confirm;
 *  - the Profile holds a different id and the sender is on no other Profile → replace and return
 *    the replaced id;
 *  - the sender is already on ANOTHER Profile → the partial-unique `telegram_user_id` index raises
 *    `11000`; the transaction aborts, so the consume rolls back and the token is left unconsumed
 *    (21.13) — a failed binding, never a transfer.
 */
export async function consumeAndBind(
  tokenHash: string,
  telegramUserId: number,
  runInTransaction: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>,
  now: Date = new Date(),
): Promise<ConsumeBindResult> {
  return runInTransaction<ConsumeBindResult>(async (session) => {
    const consumed = await linkTokens().findOneAndUpdate(
      { tokenHash, consumedAt: null, expiresAt: { $gt: now } },
      { $set: { consumedAt: now } },
      { session, returnDocument: 'after' },
    );

    // Unknown, expired, or already consumed — one indistinguishable variant (21.8).
    if (consumed === null) return { kind: 'invalid' };

    const ownerId = consumed.ownerId;
    const profile = await profiles().findOne({ _id: ownerId }, { session });
    const currentId = typeof profile?.telegramUserId === 'number' ? profile.telegramUserId : null;

    // Already bound to this same Telegram id — consume (done above), leave the id, confirm (21.10).
    if (currentId === telegramUserId) {
      return { kind: 'already_linked', ownerId };
    }

    // Bind or replace. The partial-unique index on `telegram_user_id` is what enforces 21.13: if
    // the sender is already stored on another Profile, this update raises 11000 and the whole
    // transaction — including the consume — aborts, leaving the token unconsumed.
    try {
      await profiles().updateOne(
        { _id: ownerId },
        { $set: { telegramUserId, updatedAt: now } },
        { session },
      );
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        // Sender already on another Profile. Abort by throwing so the consume rolls back; the
        // caller's transaction wrapper turns the abort into a rejected promise, which we translate
        // to the terminal variant. Re-throw a sentinel and catch it just outside the transaction is
        // awkward; instead we signal via a thrown marker the outer function recognises.
        throw new AlreadyLinkedElsewhere(ownerId);
      }
      throw error;
    }

    if (currentId === null) {
      // Fresh bind — the Profile held no id (21.7).
      return { kind: 'bound', ownerId };
    }
    // The Profile held a DIFFERENT id and the sender was on no other Profile — replacement (21.11).
    return { kind: 'replaced', ownerId, replacedTelegramUserId: currentId };
  }).catch((error: unknown) => {
    if (error instanceof AlreadyLinkedElsewhere) {
      return { kind: 'already_linked_elsewhere', ownerId: error.ownerId } as const;
    }
    throw error;
  });
}

/** Internal marker so the `11000` abort surfaces as the `already_linked_elsewhere` variant. */
class AlreadyLinkedElsewhere extends Error {
  readonly ownerId: string;
  constructor(ownerId: string) {
    super('telegram id already bound to another profile');
    this.name = 'AlreadyLinkedElsewhere';
    this.ownerId = ownerId;
  }
}

/* ========================================================================== */
/* The payment grant-plus-extend transaction (D14, D15, D19, A2)               */
/* ========================================================================== */

/** What the grant reports back so the caller can log and confirm without a second read. */
export type GrantResult =
  | { readonly kind: 'granted'; readonly ownerId: string; readonly expiresAt: Date }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'order_not_found' };

/**
 * Claim a captured payment and extend the farmer's entitlement window, in ONE transaction (D19, A2).
 *
 * The paying farmer, the amount, and the outcome are derived ONLY from the verified webhook's order
 * id plus the recorded `payment_orders` row — the grant takes its `ownerId` from that row and never
 * from the webhook payload (D15), so a forged-but-somehow-verified payload cannot redirect a grant
 * and a browser-reported success grants nothing.
 *
 * The claim is a `findOneAndUpdate` upsert on `bot_entitlements` keyed by `_id = ownerId`, guarded
 * so it fires exactly once per `providerPaymentId`: the same payment redelivered five times extends
 * the window ONCE (22.10, 22.11, Property 36). The extension is `nextExpiry(now, currentExpiry)` —
 * `max(now, currentExpiry) + RECHARGE_PERIOD_DAYS` — computed by the caller and passed in, so the
 * arithmetic is a pure function a property test checks directly.
 *
 * @param providerPaymentId the captured payment id — the idempotency claim.
 * @param providerOrderId   the order the payment settled, used to resolve the paying farmer.
 * @param computeExpiry     given the farmer's current expiry (or null), the new window end.
 */
export async function grantAndExtend(
  providerPaymentId: string,
  providerOrderId: string,
  computeExpiry: (currentExpiry: Date | null) => Date,
  runInTransaction: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>,
  now: Date = new Date(),
): Promise<GrantResult> {
  return runInTransaction<GrantResult>(async (session) => {
    // A redelivery of an already-granted payment is the duplicate signal. The `providerPaymentId`
    // unique index makes this authoritative; we read it inside the transaction so a concurrent
    // grant of the same payment cannot both pass.
    const existing = await botEntitlements().findOne({ providerPaymentId }, { session });
    if (existing !== null) return { kind: 'duplicate' };

    const order = await findPaymentOrderByProviderIdInSession(providerOrderId, session);
    if (order === null) return { kind: 'order_not_found' };

    const ownerId = order.ownerId;

    const current = await botEntitlements().findOne({ _id: ownerId }, { session });
    const currentExpiry = current?.expiresAt ?? null;
    const newExpiry = computeExpiry(currentExpiry);

    // Mark the order captured and stamp the payment id on it (partial-unique — 22.11).
    await paymentOrders().updateOne(
      { _id: order._id },
      { $set: { status: 'captured' satisfies PaymentOrderStatus, providerPaymentId, updatedAt: now } },
      { session },
    );

    // Grant or extend the window. `_id = ownerId` makes one-per-farmer hold by primary key (D14);
    // `providerPaymentId` is the unique idempotency claim (22.11). A duplicate delivery was already
    // caught above; the unique index is the backstop if two distinct deliveries race.
    try {
      await botEntitlements().updateOne(
        { _id: ownerId },
        {
          $set: { providerPaymentId, expiresAt: newExpiry, paymentOrderId: order._id, updatedAt: now },
          $setOnInsert: { _id: ownerId, grantedAt: now },
        },
        { upsert: true, session },
      );
    } catch (error) {
      if (isDuplicateKeyError(error)) return { kind: 'duplicate' };
      throw error;
    }

    return { kind: 'granted', ownerId, expiresAt: newExpiry };
  });
}

/**
 * Mark a payment order failed — the `payment.failed` webhook path. Records nothing else and leaves
 * the entitlement untouched (22.19). System-scoped: the webhook has no farmer session, and the
 * order carries its own owner. Returns whether an order was matched.
 */
export async function markPaymentOrderFailed(providerOrderId: string, now: Date = new Date()): Promise<boolean> {
  const res = await paymentOrders().updateOne(
    { providerOrderId },
    { $set: { status: 'failed' satisfies PaymentOrderStatus, updatedAt: now } },
  );
  return (res.matchedCount ?? 0) > 0;
}
