import 'server-only';

import type { ConversationDoc } from '@/lib/db/collections';
import { farmerData } from '@/lib/db/farmer';
import { AppError } from '@/lib/errors';
import type { Channel } from '@/lib/schemas';
import type { ConversationRow } from '@/types/database';

/**
 * Conversation find-or-create. One function, one decision: which thread does this farmer's next
 * message belong to on this channel.
 *
 * Requirements: 7.5 (a diagnosis started without a Conversation identifier gets a Conversation
 *               created and the Diagnosis_Result attached to it), 10.5 (an inbound WhatsApp text is
 *               answered in that Farmer's active WhatsApp Conversation), 10.8 (a follow-up resolves
 *               against the most recent Diagnosis_Result in the Conversation identified for that
 *               Farmer), 16.5 (`channel` is an input parameter and is recorded on the persisted row)
 * Design: "0003: conversations and messages"; "Conversation find-or-create"
 *
 * ### ONE LONG-RUNNING THREAD PER CHANNEL, AND THAT IS THE POINT
 *
 * `findOrCreateActive` returns the **most recently updated** conversation for `(userId, channel)`
 * and creates one only when there is none. For WhatsApp that deliberately keeps a single
 * long-running thread rather than starting a new conversation per image: Requirement 10.8 resolves
 * a follow-up against the most recent Diagnosis_Result *in that conversation*, so a new photo
 * appends a new diagnosis to the thread and "why?" resolves to the latest one. A
 * conversation-per-image would make "why?" ambiguous the moment a farmer sent two photos.
 *
 * Web conversations are **separate rows** (`channel = 'web'`), never the same row as the WhatsApp
 * thread. The two never bleed into each other while still sharing one identity (Requirement 1.5)
 * and one quota (Requirement 14.2), because the channel is a column on `conversations` (0003) and
 * every read here filters on it.
 *
 * ### WHY THE CLIENT IS A PARAMETER
 *
 * Both channels call this, and they hold different credentials:
 *
 *  - The **web** path has a farmer session, so it passes the RLS-scoped server client and RLS is
 *    the authorization boundary. That is the default (`rlsScopedConversationStore`).
 *  - The **WhatsApp webhook** has no session at all, so it passes `conversationStoreFrom(
 *    createAdminClient())`. There is no second boundary behind the service-role client, so
 *    `admin.ts`'s rule applies with full force: every query below carries an explicit
 *    `user_id` predicate, and `assertBelongsTo()` re-checks the row that comes back.
 *
 * Same reasoning as `storage.ts` and `knowledge.ts`: one implementation serves both channels
 * because the credential is injected rather than constructed.
 *
 * ### THE ORDERING IS THE INDEX'S JOB
 *
 * `conversations_user_recent_idx` on `(user_id, updated_at desc)` exists in 0003 precisely to serve
 * this lookup, so the read is `order(updated_at desc).limit(1)` in SQL and **nothing here sorts
 * conversations in application code**. A fetch-all-then-sort would grow with a farmer's history and
 * would leave the index unused.
 *
 * `updated_at` only tracks *activity* if something bumps it when a message is appended — the 0003
 * trigger fires on `update`, not on an insert into `messages`. Bumping it belongs to the code that
 * persists a message (tasks 11.2 / 12.x), not here. Until then the ordering degrades to "most
 * recently created", which is the same row whenever a farmer has one thread on the channel, so
 * find-or-create stays correct either way.
 */

/* ========================================================================== */
/* The store seam                                                              */
/* ========================================================================== */

/** A conversation row, exactly as the database defines it. */
export type Conversation = ConversationRow;

/**
 * The two database operations this module makes.
 *
 * A pair of **functions** rather than a mirrored PostgREST builder, following `KnowledgeReader` in
 * `knowledge.ts`. The real queries are a six-link chain (`from → select → eq → eq → order →
 * limit`); mirroring that structurally, as `storage.ts` does for its two flat storage calls, would
 * force a unit test to reproduce the chain in order to assert something about find-or-create. The
 * queries live once, in `conversationStoreFrom()`, typed against the real client so the compiler
 * still checks the column names and the channel union.
 */
export interface ConversationStore {
  /**
   * The most recently updated conversation for this farmer on this channel, or `null`.
   *
   * The order must be **total**: `findOrCreateActive` relies on two concurrent callers picking the
   * same row from the same row set (see the race note below), and `updated_at` alone can tie.
   */
  mostRecent(userId: string, channel: Channel): Promise<Conversation | null>;
  /** Insert a new conversation for this farmer on this channel and return the stored row. */
  create(userId: string, channel: Channel): Promise<Conversation>;
}

/**
 * Adapt the Data_Access_Layer into a store.
 *
 * *Amended by Amendment A3:* this was `conversationStoreFrom(client: SupabaseClient)`, a pair of
 * PostgREST queries on an RLS-scoped or service-role client. Under A3 there is no RLS and no
 * service-role client — `conversations` is reachable only through the owner-scoped `FarmerData`
 * accessors (D18), which merge the owning Auth_User_Id into every filter and stamp it on every
 * insert. So the store is built from `farmerData(userId)` per call rather than from a client, and
 * the two predicates that were load-bearing under RLS are now structural: `ownerId` is merged by
 * the layer (it cannot be forgotten), and `channel` is the one filter this store adds to keep the
 * web thread and the Telegram thread from bleeding into each other.
 *
 * The optional `_legacyClient` parameter is accepted and ignored purely so the call sites that
 * still pass `deps.supabase` (the diagnosis service and the Telegram/WhatsApp adapter, ported in a
 * later wave) keep compiling through this port — it selects no behaviour. Production callers pass
 * nothing.
 *
 * A driver error is **not** an empty result and is never treated as one: the layer throws on a real
 * failure, so an error propagates and is surfaced as `INTERNAL_ERROR` rather than being read as
 * "no thread yet" — the split-history outcome Requirement 10.8 cannot tolerate.
 */
export function conversationStoreFrom(_legacyClient?: unknown): ConversationStore {
  void _legacyClient; // accepted for call-site compatibility during the port; selects no behaviour.
  return {
    async mostRecent(userId, channel) {
      // `findConversations` merges `{ ownerId: userId }` and sorts by `updatedAt` descending. The
      // `channel` filter is what this store adds. The result is already newest-first; a total order
      // (breaking a timestamp tie by id) is applied here so two concurrent callers agree on one
      // winner, the same guarantee the old `.order('id')` gave.
      const rows = await farmerData(userId).findConversations({ channel });
      if (rows.length === 0) return null;

      const winner = rows.reduce((best, row) => {
        if (row.updatedAt.getTime() !== best.updatedAt.getTime()) {
          return row.updatedAt.getTime() > best.updatedAt.getTime() ? row : best;
        }
        // Tie on updatedAt: the larger id wins, so the order is total.
        return row._id.toString() > best._id.toString() ? row : best;
      });
      return toConversation(winner);
    },

    async create(userId, channel) {
      // Requirement 16.5: the channel supplied to the service is recorded on the row. `title` is
      // left absent on purpose — nothing renders a conversation title, and inventing one here would
      // put a farmer-visible string in the one module with no access to the message catalogs. The
      // layer stamps `ownerId`, `createdAt`, and `updatedAt`.
      const created = await farmerData(userId).insertConversation({ channel });
      return toConversation(created);
    },
  };
}

/**
 * Map a stored conversation document to the `Conversation` (Supabase-row-shaped) view its consumers
 * still read — `id` as the `_id` hex string, `user_id` as `ownerId`, and the timestamps as ISO
 * strings. Kept until the consumers migrate to the document shape in a later wave; one place the
 * translation lives.
 */
function toConversation(doc: ConversationDoc & { _id: unknown }): Conversation {
  const id = (doc._id as { toString(): string }).toString();
  return {
    id,
    user_id: doc.ownerId,
    channel: doc.channel,
    title: doc.title ?? null,
    created_at: doc.createdAt.toISOString(),
    updated_at: doc.updatedAt.toISOString(),
  };
}

/**
 * The default store: the farmer's own data through the Data_Access_Layer.
 *
 * *Amended by A3:* this was an RLS-scoped store built from the App Router session's Supabase client,
 * imported lazily so the module stayed loadable outside a request. Under A3 the store binds to
 * `farmerData(userId)` per call and reads the cookies through nothing — the owner id the caller
 * passes is the whole scope — so there is no lazy client import to make and this is simply
 * `conversationStoreFrom()`.
 */
export const rlsScopedConversationStore: ConversationStore = conversationStoreFrom();

/* ========================================================================== */
/* find-or-create                                                              */
/* ========================================================================== */

/**
 * The active conversation for this farmer on this channel, creating one when none exists.
 *
 * Requirement 7.5's "create a Conversation and attach the Diagnosis_Result to it" and Requirement
 * 10.5's "the Conversation identifier of that Farmer's active WhatsApp Conversation" are the same
 * question asked by two channels, so they get one answer here rather than two lookups that could
 * drift.
 *
 * =============================================================================
 * THE RACE: TWO CONCURRENT REQUESTS, NO EXISTING CONVERSATION
 * =============================================================================
 *
 * Both requests read "no thread", both insert, and the farmer ends up with two threads on one
 * channel. That matters more than a duplicate row usually would: Requirement 10.8 resolves a
 * follow-up against the most recent diagnosis **in the conversation identified for that farmer**,
 * so two WhatsApp threads split the history that "why?" resolves against — one photo's diagnosis
 * lands in thread A, the next in thread B, and the answer to "why?" depends on which thread the
 * ordering happens to pick.
 *
 * **Decision: converge on a read-back, and accept a duplicate empty row in the residual window.**
 * The three candidates, and why the other two were rejected:
 *
 *  1. **A unique constraint on `(user_id, channel)` — rejected, and it would be wrong, not merely
 *     out of scope.** It would forbid a farmer from ever having a second web conversation, but
 *     Requirement 7.5 creates a conversation per diagnosis started without one, so a returning web
 *     farmer legitimately accumulates threads. Both the design and 0003 say "the most recently
 *     updated conversation", never "the conversation" — the plural is deliberate. A partial index
 *     limited to `channel = 'whatsapp'` would avoid that objection, but it is a change to an
 *     already-written migration and it would encode a WhatsApp-only invariant in a table both
 *     channels share.
 *  2. **Retry on conflict — rejected as a consequence of 1.** With no constraint there is no
 *     conflict to retry: both inserts succeed. `upsert(onConflict)` needs the same constraint and
 *     inherits the same objection.
 *  3. **Read back after the insert (below).** After creating, re-read the most recent row for
 *     `(userId, channel)` and return *that* rather than the row just inserted. Whenever the two
 *     inserts are ordered — one commits before the other reads back, which is the overwhelmingly
 *     common interleaving — both callers see both rows, both pick the same winner under the total
 *     order, and **both messages land in one thread**. The loser stays empty, never wins a later
 *     lookup (its `updated_at` is fixed at creation while the winner's only moves forward), and is
 *     invisible to a farmer: nothing lists conversations, and the history screen lists diagnoses.
 *
 * The residual, stated plainly rather than papered over: if both inserts are still uncommitted when
 * both callers read back, each returns its own row and the history really is split for that pair of
 * messages. The window is one farmer's first two *simultaneous* messages on a channel — every
 * message after the first finds an existing thread and never reaches the create path at all — and
 * on WhatsApp the `whatsapp_inbound` idempotency insert already serializes the redelivery case,
 * which is the realistic source of same-instant duplicates (Requirement 11.5). Closing it properly
 * needs a database-side guarantee, i.e. option 1 done as a migration with the web semantics thought
 * through; until then a bounded, empty-row residual is the honest trade rather than a lock this
 * module cannot hold across two serverless invocations.
 *
 * The extra read costs one round trip **on the create path only** — never on the hot path, where
 * the first read already found the thread — so Requirement 10.10's duration ceiling is untouched.
 */
export async function findOrCreateActive(
  userId: string,
  channel: Channel,
  store: ConversationStore = rlsScopedConversationStore,
): Promise<Conversation> {
  const existing = await store.mostRecent(userId, channel);
  if (existing !== null) return assertBelongsTo(existing, userId, channel);

  const created = assertBelongsTo(await store.create(userId, channel), userId, channel);

  const settled = await store.mostRecent(userId, channel);
  // `null` here would mean the row this call just inserted is not readable back. The insert
  // returned it, so it exists and belongs to this farmer; returning it keeps the function total
  // rather than failing a farmer's first message over a convergence optimization.
  if (settled === null) return created;

  return assertBelongsTo(settled, userId, channel);
}

/**
 * Post-condition: the row handed back is this farmer's, on the requested channel.
 *
 * Not redundant with the `.eq()` predicates, for two reasons. On the service-role path the
 * application check *is* the boundary and there is nothing behind it (`admin.ts`), so a predicate
 * that was dropped in a refactor would otherwise surface as a cross-tenant read rather than as a
 * loud failure. And `ConversationStore` is an injectable seam — a store implementation that filters
 * incorrectly cannot leak past this point.
 *
 * `INTERNAL_ERROR` because this is a defect in Jamee, not something a farmer did: the mismatch goes
 * to the server log through `AppError.context`, which structurally cannot reach the response body
 * (`toEnvelope` in `errors.ts`), and the farmer sees the generic 500 of Requirement 15.6.
 */
function assertBelongsTo(
  conversation: Conversation,
  userId: string,
  channel: Channel,
): Conversation {
  if (conversation.user_id !== userId || conversation.channel !== channel) {
    throw new AppError('INTERNAL_ERROR', {
      context: {
        reason: 'conversation_scope_mismatch',
        conversationId: conversation.id,
        requestedBy: userId,
        requestedChannel: channel,
        // The row's own `user_id` is deliberately not logged: copying another farmer's id into
        // this line would spread the leak the check just stopped.
        rowChannel: conversation.channel,
      },
    });
  }
  return conversation;
}

/**
 * ### What is deliberately NOT here
 *
 * **No `touch()` / `updated_at` bump.** The ordering above depends on one, but the moment to bump
 * is "a message was persisted", which belongs to the code that persists messages (Requirement 7.4)
 * — and doing it here would mean either a second write on every lookup or a function nobody calls.
 *
 * **No message reads, and no Conversation_Context.** Requirements 7.1 and 7.2 build context from
 * the recent messages and the most recent diagnosis of a conversation; that read is keyed on
 * `conversation_id` and served by `messages_conversation_idx`, and it belongs with the chat path
 * that consumes it. This module answers only "which conversation", which is what lets both the
 * diagnosis path and the chat path share it.
 *
 * **No conversation-by-id lookup.** `CONVERSATION_NOT_FOUND` exists in the taxonomy for a caller
 * that was *given* an identifier (Requirement 7.1); resolving and validating that identifier is the
 * requesting route's job, and mixing it in here would blur "find the active thread" with "trust
 * this client-supplied id".
 */
