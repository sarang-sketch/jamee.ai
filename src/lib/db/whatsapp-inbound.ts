import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { usageLogRow } from '@/lib/db/usage-log';
import { AppError } from '@/lib/errors';
import type { Operation, WhatsappInboundStatus } from '@/lib/schemas';
import { createAdminClient } from '@/lib/supabase/admin';
import type { InboundMessage } from '@/lib/whatsapp';
import type { Database, TablesInsert, WhatsappInboundRow } from '@/types/database';

/**
 * Inbound WhatsApp idempotency: claim the delivery **before** anything billable, then move its
 * status as the outcome resolves.
 *
 * Requirements: 11.5 (a delivery whose Provider_Message_Id was already processed is acknowledged,
 *               invokes no shared service, and leaves the Farmer's quota unchanged),
 *               11.6 (record the Provider_Message_Id for duplicate detection)
 * Design: "Inbound processing order" step 2; "Acknowledgement versus processing" (D11)
 * Migration: `0008_whatsapp_inbound.sql` — the primary key IS the mechanism, RLS is enabled with
 *            no policies, so the service role is the only thing that reaches this table
 *
 * =============================================================================
 * THE INSERT COMES FIRST. THAT ORDERING *IS* REQUIREMENT 11.5
 * =============================================================================
 *
 * `claimInbound()` runs at step 2 of the inbound pipeline: after signature verification and the
 * payload parse, and **before** profile resolution (step 3), before the quota reserve, and before
 * every provider call and reply. A redelivery therefore cannot spend quota, cannot call a
 * provider, and cannot produce a second reply — not because those steps check for a duplicate,
 * but because they are unreachable. `already_seen` is returned before any of them exists.
 *
 * The type system carries that ordering rather than a comment: `InboundReceivedRow` **omits**
 * `user_id`, so the claim structurally cannot wait for a profile. The resolved profile is attached
 * afterwards by `attachResolvedProfile()`.
 *
 * =============================================================================
 * NO SELECT-THEN-INSERT. THE UNIQUE VIOLATION IS THE SIGNAL
 * =============================================================================
 *
 * There is deliberately no "have I seen this id?" read ahead of the insert. Two concurrent
 * deliveries of the same message would both find nothing and both proceed, and V13 records that
 * Meta retries immediately on a non-200 and then with decreasing frequency over 36 hours — so the
 * race is likely rather than theoretical. The insert is issued unconditionally and SQLSTATE
 * `23505` on the primary key is the duplicate signal.
 *
 * Detection is **by SQLSTATE and nothing else** (`isUniqueViolation`). Postgres's own prose can be
 * reworded or localized between versions, and a classifier that read the message text would decay
 * into "not a duplicate" exactly when correctness depends on it — the same reasoning
 * `classifyProfileWriteError` in `src/lib/profile.ts` documents.
 *
 * The duplicate branch does read the conflicting row, and that is not the pattern this module
 * refuses: the read happens *after* the insert already decided, so it cannot change the decision.
 * It only answers "which farmer, if any, does the audit row belong to".
 *
 * =============================================================================
 * WHAT A STUB CANNOT PROVE — FOR TASK 21.5
 * =============================================================================
 *
 * The co-located tests stub `WhatsappInboundStore`, so they establish what this MODULE does with
 * an answer: which statement it issues, that a `23505` becomes `already_seen`, that any other
 * database error does not, that a duplicate writes no second insert and no quota change. They
 * cannot establish that the answer is right, because a single-threaded in-memory map serializes
 * itself for free.
 *
 * **Task 21.5 must run these against real Postgres, where a stub proves nothing:**
 *
 *  1. **True concurrency.** Two `claimInbound()` calls for one `provider_message_id` issued in
 *     parallel from two connections: exactly one `proceed`, exactly one `already_seen`, one row in
 *     the table. Only Postgres's unique index makes that atomic — JS's event loop does not.
 *  2. **The redelivery spends nothing.** Claim, process, then redeliver: `counters.used` for that
 *     farmer is unchanged and no provider was called (Requirement 11.5 in full).
 *  3. **The SQLSTATE really is `23505`** for a primary-key conflict through PostgREST, and it
 *     arrives on `error.code` rather than only in the message. Everything here follows from that.
 *  4. **`transitionFromReceived`'s guard is atomic:** two terminal transitions racing leave one
 *     applied and one not, with the row in the first writer's state.
 *  5. **RLS holds.** The anon and authenticated keys reach neither `whatsapp_inbound` nor a
 *     `duplicate_ignored` row (0008 enables RLS with no policies; 0006 grants no insert).
 */

/* ========================================================================== */
/* Statuses                                                                    */
/* ========================================================================== */

/**
 * The three states a claim can end in. `received` is deliberately excluded: it is the state the
 * insert *starts* in, and a function that could "transition" a row back to `received` would undo
 * the one fact this table records honestly.
 */
export type TerminalInboundStatus = Exclude<WhatsappInboundStatus, 'received'>;

export const TERMINAL_INBOUND_STATUSES: readonly TerminalInboundStatus[] = [
  'processed', //  the entry's work completed and the reply was sent (Requirement 10.11)
  'failed', //     D11's soft-deadline branch — the audit stays honest, the farmer resends
  'rejected', //   Requirement 10.3 (no profile) and 10.9 (unsupported type); both spend nothing
];

/** The status every claim is inserted with. Never written by a transition. */
export const INBOUND_INITIAL_STATUS = 'received' as const;

/* ========================================================================== */
/* Rows                                                                        */
/* ========================================================================== */

/**
 * The claim payload, derived from the table's own `Insert` type with four columns removed:
 *
 *  - **`user_id`** — the load-bearing omission. The claim precedes profile resolution, so there is
 *    no user to record yet, and a caller that wanted to supply one would have to resolve a profile
 *    first and break the ordering Requirement 11.5 rests on. `attachResolvedProfile()` fills it in
 *    at step 3.
 *  - **`status`** — pinned to `received` below, not a caller's choice. Inserting `processed`
 *    directly is the batching hazard `docs/PROVIDER_CAPABILITIES.md` raises, made unavailable.
 *  - **`received_at`** — the database's `now()` is the honest arrival time.
 *  - **`completed_at`** — nothing has completed at claim time.
 */
export type InboundReceivedRow = Omit<
  TablesInsert<'whatsapp_inbound'>,
  'user_id' | 'status' | 'received_at' | 'completed_at'
> & { readonly status: typeof INBOUND_INITIAL_STATUS };

/**
 * The three fields of a parsed inbound message a claim needs, as a `Pick` of `InboundMessage` so
 * this module cannot drift from `src/lib/whatsapp.ts`. Type-only, so there is no runtime coupling
 * between admission and persistence.
 */
export type InboundClaimInput = Pick<
  InboundMessage,
  'providerMessageId' | 'fromPhone' | 'rawType'
>;

/**
 * What the duplicate branch reads back from the conflicting row.
 *
 * `from_phone` is deliberately **not** selected. It is the farmer PII that made 0008 enable RLS
 * with no policies, and nothing on the duplicate path needs it — the same reasoning that keeps
 * identity columns out of `PROFILE_SETTINGS_SELECT`.
 */
export type ExistingInbound = Pick<WhatsappInboundRow, 'user_id' | 'status' | 'message_type'>;

/** One place for the column list, so the seam's type and the statement cannot disagree. */
export const EXISTING_INBOUND_SELECT = 'user_id, status, message_type' as const;

/* ========================================================================== */
/* Error classification — SQLSTATE only                                        */
/* ========================================================================== */

/** The slice of a PostgREST error this module reads. `PostgrestError` satisfies it. */
export interface InboundDbError {
  readonly code: string;
  readonly message: string;
}

/** Postgres `unique_violation`. On this table it can only be the primary key. */
export const UNIQUE_VIOLATION_SQLSTATE = '23505';

/**
 * Is this the duplicate signal?
 *
 * `code` and nothing else. Not `message.includes('duplicate key')`: that string is Postgres's
 * prose, it is not part of any contract, and a locale or version that reworded it would turn every
 * redelivery into a 500 — which Meta answers by redelivering.
 *
 * `whatsapp_inbound` has exactly one unique index (the primary key on `provider_message_id`), so a
 * `23505` from the claim insert cannot be anything else. That is a fact about migration 0008, and
 * it is why no constraint-name check is needed here.
 */
export function isUniqueViolation(error: InboundDbError): boolean {
  return error.code === UNIQUE_VIOLATION_SQLSTATE;
}

/* ========================================================================== */
/* The store seam                                                              */
/* ========================================================================== */

/**
 * The database operations this module makes, as five functions rather than a mirrored PostgREST
 * builder — the same choice `ConversationStore` and `CounterRpc` make, for the same reason: the
 * real statements are multi-link chains, and a unit test should assert something about idempotency
 * rather than reproduce a chain in order.
 *
 * Every method returns `{ error }` **without throwing**, because classification is this module's
 * job: `insertReceived` returning a `23505` is a normal, expected, correct outcome, and a seam that
 * threw on it would put the duplicate decision inside the adapter where no unit test reaches it.
 */
export interface WhatsappInboundStore {
  /** Insert the claim as `received`. A `23505` in `error` is the duplicate signal, not a failure. */
  insertReceived(row: InboundReceivedRow): Promise<{ error: InboundDbError | null }>;

  /** The conflicting row, read **after** a duplicate has already been established. */
  readExisting(
    providerMessageId: string,
  ): Promise<{ data: ExistingInbound | null; error: InboundDbError | null }>;

  /** Record the profile resolved at step 3 on an already-claimed row. */
  attachUser(
    providerMessageId: string,
    userId: string,
  ): Promise<{ error: InboundDbError | null }>;

  /**
   * Move a row from `received` to a terminal status. The `received` predicate belongs in the
   * statement, not in application code: a read-then-write would race the soft deadline against the
   * work it is timing.
   *
   * Returns the updated rows, so zero rows means "the guard did not match".
   */
  transitionFromReceived(
    providerMessageId: string,
    status: TerminalInboundStatus,
    completedAt: string,
  ): Promise<{
    data: readonly Pick<WhatsappInboundRow, 'status'>[] | null;
    error: InboundDbError | null;
  }>;

  /** Append one `usage_logs` row. Only ever called with `outcome: 'duplicate_ignored'` here. */
  insertUsageLog(row: TablesInsert<'usage_logs'>): Promise<{ error: InboundDbError | null }>;
}

/**
 * Adapt a Supabase client into a store.
 *
 * **Service role only, and there is no second boundary behind it.** 0008 enables RLS with no
 * policies, so `anon` and `authenticated` reach nothing here; the service role bypasses RLS by
 * design. `admin.ts`'s rule — every service-role query carries an explicit predicate — is
 * satisfied by `provider_message_id`, which is the primary key: each statement below addresses
 * exactly one row, named by the id Meta supplied.
 *
 * The client is a parameter with a lazy default so that a caller injecting a store (every unit
 * test) never reads `SUPABASE_SERVICE_ROLE_KEY`.
 */
export function adminWhatsappInboundStore(
  client: SupabaseClient<Database> = createAdminClient(),
): WhatsappInboundStore {
  return {
    async insertReceived(row) {
      // No `.select()`: the inserted values are already known, and asking for them back would
      // add a round trip to the one statement that sits in front of every delivery.
      const { error } = await client.from('whatsapp_inbound').insert(row);
      return { error };
    },

    async readExisting(providerMessageId) {
      const { data, error } = await client
        .from('whatsapp_inbound')
        .select(EXISTING_INBOUND_SELECT)
        .eq('provider_message_id', providerMessageId)
        // `maybeSingle`, not `single`: the row raced with a delete is a state, not an error.
        .maybeSingle();
      return { data, error };
    },

    async attachUser(providerMessageId, userId) {
      const { error } = await client
        .from('whatsapp_inbound')
        .update({ user_id: userId })
        .eq('provider_message_id', providerMessageId);
      return { error };
    },

    async transitionFromReceived(providerMessageId, status, completedAt) {
      const { data, error } = await client
        .from('whatsapp_inbound')
        .update({ status, completed_at: completedAt })
        .eq('provider_message_id', providerMessageId)
        // The guard. Without it, D11's soft deadline could overwrite a `processed` row with
        // `failed` after the work had in fact completed.
        .eq('status', INBOUND_INITIAL_STATUS)
        .select('status');
      return { data, error };
    },

    async insertUsageLog(row) {
      const { error } = await client.from('usage_logs').insert(row);
      return { error };
    },
  };
}

export interface InboundStoreOptions {
  /** The database seam. Defaults to the service-role client, built on first use. */
  readonly store?: WhatsappInboundStore | undefined;
  /** The instant a `completed_at` is stamped with. Defaults to now. */
  readonly now?: Date | undefined;
}

function storeOf(options: InboundStoreOptions): WhatsappInboundStore {
  return options.store ?? adminWhatsappInboundStore();
}

/**
 * A swallowed failure still has to be visible. Same `[jamee]` prefix and same `console.error`
 * channel as `src/lib/errors.ts`, for the same reason: on the target platform that is what reaches
 * the runtime log.
 */
function logSwallowed(reason: string, providerMessageId: string, cause: unknown): void {
  console.error(`[jamee] whatsapp_inbound ${reason}`, providerMessageId, cause);
}

/* ========================================================================== */
/* Claim (step 2)                                                              */
/* ========================================================================== */

/** Why a duplicate wrote no `usage_logs` row. Server-side only; no farmer reads these. */
export type DuplicateAuditSkip =
  | 'conflicting_row_has_no_user_id'
  | 'message_type_has_no_operation'
  | 'conflicting_row_absent'
  | 'conflicting_row_unreadable'
  | 'usage_log_write_failed';

export type DuplicateAudit =
  | { readonly logged: true }
  | { readonly logged: false; readonly reason: DuplicateAuditSkip };

export type InboundClaimResult =
  /** First delivery: the row is now `received` and the pipeline may continue. */
  | { readonly outcome: 'proceed'; readonly providerMessageId: string }
  /**
   * Already seen. Acknowledge with 200 and do nothing else — no profile resolution, no reserve, no
   * provider call, no reply. `existing` is the conflicting row, or `null` when it could not be read.
   */
  | {
      readonly outcome: 'already_seen';
      readonly providerMessageId: string;
      readonly existing: ExistingInbound | null;
      readonly audit: DuplicateAudit;
    };

/**
 * Claim a delivery, or discover it is a redelivery.
 *
 * The **only** entry point to this table for a new delivery, and the first thing the inbound
 * pipeline does after the payload parses. Call it once per message in a batched delivery, and run
 * that message's work only on `proceed`.
 *
 * ### The three outcomes
 *
 *  - **inserted** → `proceed`. The row is `received`. The caller now owns the obligation to reach
 *    a terminal status; see `markProcessed`.
 *  - **`23505`** → `already_seen`. Requirement 11.5, in one branch: acknowledge 200, invoke no
 *    service, leave the counter untouched. A `duplicate_ignored` audit row is written here when it
 *    can be attributed (below), so a caller cannot forget it.
 *  - **any other error** → **throws**. This is the one case that must not be answered with 200. An
 *    insert that failed for an unknown reason means idempotency is not established, so proceeding
 *    risks a double spend and acknowledging silently discards the message — Meta will not
 *    redeliver an acknowledged delivery. A 500 invites the redelivery that recovers it (V13).
 */
export async function claimInbound(
  message: InboundClaimInput,
  options: InboundStoreOptions = {},
): Promise<InboundClaimResult> {
  const store = storeOf(options);
  const { providerMessageId } = message;
  /**
   * `latency_ms` for a `duplicate_ignored` row (Requirement 14.6's column set, via
   * `usageLogRow()`). Measured from the top of the claim so the number covers the insert that
   * conflicted plus the read that attributed it — which is exactly the work this path did.
   *
   * `options.now` is honoured when supplied so a test can pin the number; `Date.now()` otherwise.
   * `now` is a `Date` on this options bag rather than a `() => number` clock, so a supplied instant
   * pins the latency to zero, which is what a fixed clock should mean.
   */
  const nowMs = (): number => (options.now ?? new Date()).getTime();
  const startedMs = nowMs();

  const row: InboundReceivedRow = {
    provider_message_id: providerMessageId,
    from_phone: message.fromPhone,
    // Verbatim from `messages[].type`, including a type Jamee does not support: 0008 types this
    // column as plain `text` precisely so an unsupported delivery is recorded rather than lost,
    // and Requirement 10.9's rejection is a status, not an absent row.
    message_type: message.rawType,
    // Never `processed`. The insert records arrival; only completed work records completion.
    status: INBOUND_INITIAL_STATUS,
  };

  const { error } = await store.insertReceived(row);

  if (error === null) return { outcome: 'proceed', providerMessageId };

  if (!isUniqueViolation(error)) {
    throw new AppError('INTERNAL_ERROR', {
      cause: error,
      // `from_phone` is deliberately absent from the log context: it is the PII 0008's RLS note is
      // about, and the WAMID already identifies the delivery.
      context: { reason: 'whatsapp_inbound_claim_failed', providerMessageId, sqlstate: error.code },
    });
  }

  const existing = await readConflicting(store, providerMessageId);
  // Measured across the whole claim attempt: the insert that conflicted plus the read that
  // attributed it. See the note on `startedMs` above for why a pinned `options.now` yields zero.
  const audit = await recordDuplicateIgnored(
    store,
    providerMessageId,
    existing,
    nowMs() - startedMs,
  );

  return { outcome: 'already_seen', providerMessageId, existing: existing.data, audit };
}

interface ConflictingRead {
  readonly data: ExistingInbound | null;
  readonly skip: DuplicateAuditSkip | null;
}

/**
 * Read the conflicting row, and never let that read change the decision.
 *
 * A failure here is logged and swallowed rather than thrown. The safety-critical fact — *do not
 * process this delivery* — was settled by the unique violation, and turning a correctly suppressed
 * duplicate into a 500 would buy nothing: Meta's redelivery would conflict again, read again, and
 * fail again, while the audit row was attempted once per attempt.
 */
async function readConflicting(
  store: WhatsappInboundStore,
  providerMessageId: string,
): Promise<ConflictingRead> {
  const { data, error } = await store.readExisting(providerMessageId);

  if (error !== null) {
    logSwallowed('duplicate_row_unreadable', providerMessageId, error);
    return { data: null, skip: 'conflicting_row_unreadable' };
  }
  if (data === null) {
    // The row that caused the conflict is gone — it raced a delete between the insert and this
    // read. Still a duplicate: the insert already refused.
    return { data: null, skip: 'conflicting_row_absent' };
  }
  return { data, skip: null };
}

/**
 * `usage_logs.operation` for a raw inbound message type, or `null` when there is none.
 *
 * The mapping is the dispatch table of Requirements 10.4–10.6 read backwards: an image becomes an
 * `image` operation, a text becomes `chat`, a voice note becomes `voice`. Anything else —
 * Requirement 10.9's sticker, location or contact card — has **no** operation, because `operation`
 * is `not null` with a three-value check constraint in 0006 and inventing a value to satisfy it
 * would put a fictional operation in the audit trail.
 */
export function operationForMessageType(messageType: string): Operation | null {
  switch (messageType) {
    case 'image':
      return 'image';
    case 'text':
      return 'chat';
    case 'audio':
      return 'voice';
    default:
      return null;
  }
}

/**
 * The `duplicate_ignored` audit row (Requirement 11.5, design D10).
 *
 * ### Where `user_id` comes from, and why it can be missing
 *
 * The claim precedes profile resolution while `usage_logs.user_id` is `not null`, so the duplicate
 * has no user of its own — it borrows the one already stored on the conflicting row. When that
 * column is `null` the original delivery came from an unresolvable number (Requirement 10.3) and
 * **no usage row is written at all**: the duplicate is recorded by the `whatsapp_inbound` status
 * alone. Requirement 14.6 asks for a row per *completed model operation*, and a duplicate
 * completes none, so the audit is correct either way. Inventing a placeholder user to satisfy the
 * `not null` would attribute a farmer's activity to a row that is not theirs.
 *
 * **Task 24.3 re-checked that reading against 14.6 and 14.7 and kept it.** Both criteria are about
 * an operation the gateway *completed*; a suppressed redelivery completes none and reaches no
 * provider, so there is no fallback to record and nothing billable to attribute. The alternative —
 * a synthetic or nullable farmer id — would trade a correct absence for an incorrect row, and the
 * suppression itself is never invisible: `whatsapp_inbound.status`, the `DuplicateAudit` returned
 * here, and the adapter's `duplicate.ignored` log line all record it.
 *
 * The columns that make the row honest:
 *  - `model_provider: 'none'` — 0006 permits it precisely because a `duplicate_ignored` reached no
 *    provider.
 *  - `quota_spent: false` — Requirement 11.5's "leaves the quota unchanged", stated in the audit
 *    rather than inferred from the counter.
 *  - `used_fallback: false` — Requirement 14.7, stated rather than left to the column default. This
 *    row used to omit the key entirely, which meant the value came from the database default on this
 *    path and from the application on every other one.
 *  - `latency_ms` — the time it took to detect the duplicate. Small, and honest: this path is
 *    measured like every other, so a `latency_ms is null` scan means "not measured" everywhere
 *    rather than "not measured, or a duplicate".
 *  - `prompt_version` — written even though no prompt was composed, which is the rule the three
 *    services already followed. This row omitting it was the reason `group by prompt_version`
 *    silently dropped redeliveries.
 *
 * All five now come from `usageLogRow()` in `src/lib/db/usage-log.ts`, so this call site supplies
 * facts and no longer spells a row.
 *
 * A failed write is logged and swallowed. The suppression already happened and the row in
 * `whatsapp_inbound` already records it; failing the request over a missing audit line would
 * trigger a redelivery that changes nothing.
 */
async function recordDuplicateIgnored(
  store: WhatsappInboundStore,
  providerMessageId: string,
  existing: ConflictingRead,
  latencyMs: number,
): Promise<DuplicateAudit> {
  if (existing.skip !== null) return { logged: false, reason: existing.skip };

  const row = existing.data;
  if (row === null) return { logged: false, reason: 'conflicting_row_absent' };

  if (row.user_id === null) {
    return { logged: false, reason: 'conflicting_row_has_no_user_id' };
  }

  const operation = operationForMessageType(row.message_type);
  if (operation === null) {
    return { logged: false, reason: 'message_type_has_no_operation' };
  }

  const { error } = await store.insertUsageLog(
    usageLogRow({
      userId: row.user_id,
      operation,
      channel: 'whatsapp',
      outcome: 'duplicate_ignored',
      provider: 'none',
      usedFallback: false,
      quotaSpent: false,
      latencyMs,
    }),
  );

  if (error !== null) {
    logSwallowed('duplicate_audit_write_failed', providerMessageId, error);
    return { logged: false, reason: 'usage_log_write_failed' };
  }
  return { logged: true };
}

/* ========================================================================== */
/* Attaching the resolved profile (step 3)                                     */
/* ========================================================================== */

/**
 * Record the profile resolved at step 3 on a row claimed at step 2.
 *
 * This is what makes the duplicate rule above work at all: without it `user_id` would always be
 * `null` and no redelivery could ever be attributed. Call it immediately after
 * `profiles.phone = fromPhone` resolves, and before the dispatch (task 22.2).
 *
 * A failure throws. The row is the audit record for this delivery, and continuing with an
 * unattributed row would silently cost the next redelivery its `duplicate_ignored` line.
 */
export async function attachResolvedProfile(
  providerMessageId: string,
  userId: string,
  options: InboundStoreOptions = {},
): Promise<void> {
  const { error } = await storeOf(options).attachUser(providerMessageId, userId);

  if (error !== null) {
    throw new AppError('INTERNAL_ERROR', {
      cause: error,
      context: { reason: 'whatsapp_inbound_attach_user_failed', providerMessageId, userId },
    });
  }
}

/* ========================================================================== */
/* Terminal transitions (steps 4 and 8, and D11's deadline)                    */
/* ========================================================================== */

export type InboundTransition =
  | { readonly applied: true; readonly status: TerminalInboundStatus }
  /**
   * The row was not `received` — it had already reached a terminal status, or (impossible after a
   * `proceed`) it does not exist. Either way the first writer's outcome stands, and the caller
   * should not retry: see the note on the guard in `transitionFromReceived`.
   */
  | { readonly applied: false; readonly reason: 'not_in_received_state' };

/**
 * =============================================================================
 * THE CONTRACT FOR TASK 22.3 — READ THIS BEFORE WIRING THE BATCH LOOP
 * =============================================================================
 *
 * `docs/PROVIDER_CAPABILITIES.md` records a hazard D11's arithmetic does not cover: V13 says Meta
 * may batch **up to 1000 updates** in one delivery, and because `provider_message_id` is the
 * idempotency key, a handler that claims rows for all N entries and then runs out of budget on
 * entry 3 has **silently discarded entries 4..N** — Meta will not redeliver an acknowledged
 * delivery, and the primary key would drop it if it did.
 *
 * The status column is the whole answer, and it only works if it is used in this order:
 *
 *  1. `claimInbound()` per entry, which inserts `received` — **never** a terminal status.
 *  2. Do that entry's work, checking the remaining budget before starting it.
 *  3. `markProcessed()` **after** the reply is sent, not before, and per entry rather than once
 *     for the batch.
 *  4. Entries still `received` when the budget runs out are a **recoverable backlog**, not a
 *     silent drop: the row exists, its state is honest, and
 *     `whatsapp_inbound_received_idx` is the operator query that finds them.
 *
 * A batch-wide `markProcessed` at the end, or a claim that inserted `processed` directly, would
 * reintroduce exactly the silent discard the column exists to prevent.
 */
async function transition(
  providerMessageId: string,
  status: TerminalInboundStatus,
  options: InboundStoreOptions,
): Promise<InboundTransition> {
  const completedAt = (options.now ?? new Date()).toISOString();
  const { data, error } = await storeOf(options).transitionFromReceived(
    providerMessageId,
    status,
    completedAt,
  );

  if (error !== null) {
    throw new AppError('INTERNAL_ERROR', {
      cause: error,
      context: { reason: 'whatsapp_inbound_transition_failed', providerMessageId, status },
    });
  }

  // Zero updated rows is the guard refusing, not a failure. PostgREST reports a `where` that
  // matched nothing as a success with an empty array.
  if (data === null || data.length === 0) {
    return { applied: false, reason: 'not_in_received_state' };
  }
  return { applied: true, status };
}

/**
 * The entry's work completed and the reply was sent (Requirement 10.11, step 8).
 *
 * **Only after the reply.** Marking `processed` before the work is what turns a budget overrun
 * into a silent drop — see the contract above.
 */
export function markProcessed(
  providerMessageId: string,
  options: InboundStoreOptions = {},
): Promise<InboundTransition> {
  return transition(providerMessageId, 'processed', options);
}

/**
 * D11's soft-deadline branch: Jamee ran out of budget, told the farmer so, and returned 200.
 *
 * `failed` rather than `processed` is deliberate — it keeps the audit honest, and the farmer's next
 * send carries a new `provider_message_id`, so it processes normally.
 */
export function markFailed(
  providerMessageId: string,
  options: InboundStoreOptions = {},
): Promise<InboundTransition> {
  return transition(providerMessageId, 'failed', options);
}

/**
 * The two paths that spend nothing and call no service: an unresolvable phone number
 * (Requirement 10.3) and a message type outside text, image and audio (Requirement 10.9).
 *
 * Both still send a farmer-facing reply and acknowledge with 200. `rejected` records that Jamee
 * decided not to act, which is a different fact from `failed`'s "Jamee could not finish".
 */
export function markRejected(
  providerMessageId: string,
  options: InboundStoreOptions = {},
): Promise<InboundTransition> {
  return transition(providerMessageId, 'rejected', options);
}
