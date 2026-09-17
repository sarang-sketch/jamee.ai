import { describe, expect, it, vi } from 'vitest';

import {
  attachResolvedProfile,
  claimInbound,
  isUniqueViolation,
  markFailed,
  markProcessed,
  markRejected,
  operationForMessageType,
  TERMINAL_INBOUND_STATUSES,
  UNIQUE_VIOLATION_SQLSTATE,
  type ExistingInbound,
  type InboundClaimInput,
  type InboundDbError,
  type InboundReceivedRow,
  type WhatsappInboundStore,
} from '@/lib/db/whatsapp-inbound';
import { PROMPT_VERSION } from '@/lib/prompts';
import type { TablesInsert } from '@/types/database';

/**
 * Unit tests for `src/lib/db/whatsapp-inbound.ts` with the database stubbed at the
 * `WhatsappInboundStore` seam.
 *
 * Requirements: 11.5 (a redelivery is acknowledged, invokes no shared service, and leaves the
 *               quota unchanged), 11.6 (the Provider_Message_Id is recorded)
 *
 * ### What these tests decide, and what they cannot
 *
 * Everything here is a fact about the MODULE: that the insert is issued before anything else and
 * carries `received` with no `user_id`, that a `23505` becomes `already_seen` with no second
 * insert, that any other SQLSTATE does not, that a duplicate writes at most one audit row and
 * never a quota change, and that the terminal transitions carry the guard.
 *
 * They cannot decide that two truly concurrent inserts collide — the stub below is a `Map`, and
 * JavaScript's single thread serializes it for free. `whatsappInboundStub` models the unique index
 * faithfully (the check-and-set is synchronous, exactly as Postgres's index makes it atomic), which
 * is enough to prove the module's *branching* and nothing about the database's atomicity. Real
 * concurrency, the SQLSTATE itself, and the transition guard's atomicity are task 21.5 against real
 * Postgres — see the module header's list.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A WAMID-shaped id. 0008 stores it verbatim; nothing here parses it. */
const WAMID = 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhggMEE3RkE0RkI4NUQ5';
const PHONE = '+919876543210';
const USER = '11111111-1111-4111-8111-111111111111';
const COMPLETED_AT = new Date('2026-09-15T19:30:00.000Z');

const IMAGE_MESSAGE: InboundClaimInput = {
  providerMessageId: WAMID,
  fromPhone: PHONE,
  rawType: 'image',
};

/** Postgres's real prose for a primary-key conflict, so the classifier is tested against it. */
const PK_CONFLICT: InboundDbError = {
  code: UNIQUE_VIOLATION_SQLSTATE,
  message: 'duplicate key value violates unique constraint "whatsapp_inbound_pkey"',
};

interface StubRow {
  user_id: string | null;
  message_type: string;
  status: ExistingInbound['status'];
}

interface Stub {
  readonly store: WhatsappInboundStore;
  /** Every claim insert attempted, in order — including the ones the index refused. */
  readonly inserts: InboundReceivedRow[];
  readonly usageRows: TablesInsert<'usage_logs'>[];
  readonly reads: string[];
  readonly transitions: { id: string; status: string; completedAt: string }[];
  readonly rows: Map<string, StubRow>;
}

interface StubOptions {
  /** Rows already in the table, i.e. deliveries already claimed. */
  readonly seed?: readonly (StubRow & { readonly provider_message_id: string })[];
  /** Force an error out of one method, to exercise a branch the happy path cannot reach. */
  readonly insertError?: InboundDbError;
  readonly readError?: InboundDbError;
  readonly usageLogError?: InboundDbError;
  /** Drop the conflicting row between the insert and the read back. */
  readonly deleteAfterConflict?: boolean;
}

/**
 * A store backed by a `Map`, standing in for `whatsapp_inbound` plus `usage_logs`.
 *
 * The check-and-set in `insertReceived` is deliberately **synchronous** before any `await`. That is
 * what makes it a model of a unique index rather than a model of a select-then-insert: splitting it
 * with an `await` would let two callers both find the key absent and both succeed, which is the bug
 * the primary key exists to prevent — and a stub that reproduced it would be testing itself.
 */
function whatsappInboundStub(options: StubOptions = {}): Stub {
  const rows = new Map<string, StubRow>();
  for (const seeded of options.seed ?? []) {
    const { provider_message_id: id, ...rest } = seeded;
    rows.set(id, { ...rest });
  }

  const inserts: InboundReceivedRow[] = [];
  const usageRows: TablesInsert<'usage_logs'>[] = [];
  const reads: string[] = [];
  const transitions: { id: string; status: string; completedAt: string }[] = [];

  const store: WhatsappInboundStore = {
    insertReceived(row) {
      inserts.push(row);
      if (options.insertError !== undefined) {
        return Promise.resolve({ error: options.insertError });
      }
      if (rows.has(row.provider_message_id)) {
        if (options.deleteAfterConflict === true) rows.delete(row.provider_message_id);
        return Promise.resolve({ error: PK_CONFLICT });
      }
      rows.set(row.provider_message_id, {
        user_id: null,
        message_type: row.message_type,
        status: row.status,
      });
      return Promise.resolve({ error: null });
    },

    readExisting(providerMessageId) {
      reads.push(providerMessageId);
      if (options.readError !== undefined) {
        return Promise.resolve({ data: null, error: options.readError });
      }
      const row = rows.get(providerMessageId);
      return Promise.resolve({
        data:
          row === undefined
            ? null
            : { user_id: row.user_id, status: row.status, message_type: row.message_type },
        error: null,
      });
    },

    attachUser(providerMessageId, userId) {
      const row = rows.get(providerMessageId);
      if (row !== undefined) row.user_id = userId;
      return Promise.resolve({ error: null });
    },

    transitionFromReceived(providerMessageId, status, completedAt) {
      transitions.push({ id: providerMessageId, status, completedAt });
      const row = rows.get(providerMessageId);
      // The `status = 'received'` predicate, in the statement rather than in the caller.
      if (row === undefined || row.status !== 'received') {
        return Promise.resolve({ data: [], error: null });
      }
      row.status = status;
      return Promise.resolve({ data: [{ status }], error: null });
    },

    insertUsageLog(row) {
      if (options.usageLogError !== undefined) {
        return Promise.resolve({ error: options.usageLogError });
      }
      usageRows.push(row);
      return Promise.resolve({ error: null });
    },
  };

  return { store, inserts, usageRows, reads, transitions, rows };
}

/* -------------------------------------------------------------------------- */
/* The first delivery                                                          */
/* -------------------------------------------------------------------------- */

describe('claimInbound — first delivery', () => {
  it('inserts the provider message id and returns proceed', async () => {
    const stub = whatsappInboundStub();

    const result = await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    expect(result).toEqual({ outcome: 'proceed', providerMessageId: WAMID });
    expect(stub.inserts).toHaveLength(1);
    expect(stub.inserts[0]).toEqual({
      provider_message_id: WAMID,
      from_phone: PHONE,
      message_type: 'image',
      status: 'received',
    });
  });

  it('inserts as received, never as a terminal status, and transitions nothing', async () => {
    // The batching hazard: a claim that recorded `processed` would make a budget overrun a silent
    // drop, because the id is the idempotency key and Meta will not redeliver.
    const stub = whatsappInboundStub();

    await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    expect(stub.rows.get(WAMID)?.status).toBe('received');
    expect(stub.transitions).toHaveLength(0);
  });

  it('carries no user_id, because the claim precedes profile resolution', async () => {
    const stub = whatsappInboundStub();

    await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    // Requirement 11.5 holds *because* step 2 sits above step 3. An insert that knew the user
    // would have had to resolve a profile first.
    expect(stub.inserts[0]).not.toHaveProperty('user_id');
    expect(stub.rows.get(WAMID)?.user_id).toBeNull();
  });

  it('records an unsupported message type verbatim rather than dropping the delivery', async () => {
    // Requirement 10.9's sticker still gets a row, and later a `rejected` status.
    const stub = whatsappInboundStub();

    const result = await claimInbound(
      { ...IMAGE_MESSAGE, rawType: 'sticker' },
      { store: stub.store },
    );

    expect(result.outcome).toBe('proceed');
    expect(stub.inserts[0]?.message_type).toBe('sticker');
  });

  it('writes no usage row and reads nothing back', async () => {
    const stub = whatsappInboundStub();

    await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    expect(stub.usageRows).toEqual([]);
    expect(stub.reads).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The redelivery                                                              */
/* -------------------------------------------------------------------------- */

describe('claimInbound — redelivery', () => {
  it('returns already_seen without a second insert succeeding', async () => {
    const stub = whatsappInboundStub({
      seed: [{ provider_message_id: WAMID, user_id: USER, message_type: 'image', status: 'processed' }],
    });

    const result = await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    expect(result.outcome).toBe('already_seen');
    // One statement was issued and the index refused it. There is no select-then-insert: the
    // module did not ask whether the id existed before trying.
    expect(stub.inserts).toHaveLength(1);
    expect(stub.rows.size).toBe(1);
    expect(stub.rows.get(WAMID)?.status).toBe('processed');
  });

  it('reports the conflicting row and leaves its status untouched', async () => {
    const stub = whatsappInboundStub({
      seed: [{ provider_message_id: WAMID, user_id: USER, message_type: 'image', status: 'processed' }],
    });

    const result = await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    expect(result).toMatchObject({
      outcome: 'already_seen',
      existing: { user_id: USER, status: 'processed', message_type: 'image' },
    });
    expect(stub.transitions).toHaveLength(0);
  });

  it('logs duplicate_ignored against the conflicting row user, spending nothing', async () => {
    const stub = whatsappInboundStub({
      seed: [{ provider_message_id: WAMID, user_id: USER, message_type: 'image', status: 'processed' }],
    });

    // A pinned instant, which `claimInbound` reads at both ends of the claim — so `latency_ms` is
    // exactly 0 and this assertion can be an exact-shape one. See the note on `startedMs` there.
    const result = await claimInbound(IMAGE_MESSAGE, { store: stub.store, now: COMPLETED_AT });

    expect(result).toMatchObject({ audit: { logged: true } });
    expect(stub.usageRows).toHaveLength(1);
    /**
     * `toEqual` on the whole row rather than `toMatchObject` on the interesting keys, and that is
     * the assertion task 24.3 came for: this row used to omit `used_fallback`, `latency_ms` and
     * `prompt_version` entirely, so those three columns came from the database default on the
     * duplicate path and from the application on every other one — which is what made
     * `group by prompt_version` silently drop redeliveries. An exact shape is what stops a future
     * edit reintroducing a partial row.
     */
    expect(stub.usageRows[0]).toEqual({
      // Borrowed from the conflicting row: `usage_logs.user_id` is `not null` and the claim
      // precedes profile resolution, so the duplicate has no user of its own.
      user_id: USER,
      operation: 'image',
      channel: 'whatsapp',
      // 0006 permits 'none' precisely because a duplicate reaches no provider.
      model_provider: 'none',
      outcome: 'duplicate_ignored',
      // Requirement 14.7, stated rather than left to the column default: no provider was reached,
      // so there was no fallback to serve from.
      used_fallback: false,
      // Not a validation rejection, so Requirement 5.7 has nothing to record here.
      rejection_reason: null,
      // Requirement 11.5's "leaves the quota unchanged", stated rather than inferred.
      quota_spent: false,
      // The time it took to *detect* the duplicate — small, and measured like every other row, so a
      // `latency_ms is null` scan means "not measured" everywhere rather than "not measured, or a
      // duplicate".
      latency_ms: 0,
      // Written even though this path composed no prompt: it records the revision the request would
      // have used, which is what keeps the column groupable across a deployment's rows.
      prompt_version: PROMPT_VERSION,
      // A duplicate is suppressed before any conversation is touched and produces no diagnosis.
      conversation_id: null,
      diagnosis_id: null,
    });
  });

  it('maps the message type on the conflicting row to its operation', async () => {
    const stub = whatsappInboundStub({
      seed: [{ provider_message_id: WAMID, user_id: USER, message_type: 'text', status: 'processed' }],
    });

    await claimInbound({ ...IMAGE_MESSAGE, rawType: 'text' }, { store: stub.store });

    expect(stub.usageRows[0]?.operation).toBe('chat');
  });

  it('writes no usage row when the conflicting row has no user_id', async () => {
    // The original delivery came from an unresolvable number (Requirement 10.3). The duplicate is
    // recorded by the inbound status alone; a placeholder user would attribute it to the wrong farmer.
    const stub = whatsappInboundStub({
      seed: [{ provider_message_id: WAMID, user_id: null, message_type: 'image', status: 'rejected' }],
    });

    const result = await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    expect(result).toMatchObject({
      outcome: 'already_seen',
      audit: { logged: false, reason: 'conflicting_row_has_no_user_id' },
    });
    expect(stub.usageRows).toEqual([]);
  });

  it('writes no usage row when the message type has no operation', async () => {
    // `usage_logs.operation` is `not null` with a three-value check; a sticker is none of them.
    const stub = whatsappInboundStub({
      seed: [{ provider_message_id: WAMID, user_id: USER, message_type: 'sticker', status: 'rejected' }],
    });

    const result = await claimInbound({ ...IMAGE_MESSAGE, rawType: 'sticker' }, { store: stub.store });

    expect(result).toMatchObject({
      audit: { logged: false, reason: 'message_type_has_no_operation' },
    });
    expect(stub.usageRows).toEqual([]);
  });

  it('still reports already_seen when the conflicting row cannot be read', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = whatsappInboundStub({
      seed: [{ provider_message_id: WAMID, user_id: USER, message_type: 'image', status: 'processed' }],
      readError: { code: '08006', message: 'connection failure' },
    });

    // The suppression was settled by the unique violation. A failed read must not promote a
    // correctly dropped duplicate into a 500 that invites a pointless redelivery.
    const result = await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    expect(result).toMatchObject({
      outcome: 'already_seen',
      existing: null,
      audit: { logged: false, reason: 'conflicting_row_unreadable' },
    });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('still reports already_seen when the audit write fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = whatsappInboundStub({
      seed: [{ provider_message_id: WAMID, user_id: USER, message_type: 'image', status: 'processed' }],
      usageLogError: { code: '08006', message: 'connection failure' },
    });

    const result = await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    expect(result).toMatchObject({
      outcome: 'already_seen',
      audit: { logged: false, reason: 'usage_log_write_failed' },
    });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('reports the conflicting row as absent when it raced a delete', async () => {
    const stub = whatsappInboundStub({
      seed: [{ provider_message_id: WAMID, user_id: USER, message_type: 'image', status: 'processed' }],
      deleteAfterConflict: true,
    });

    const result = await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    expect(result).toMatchObject({
      outcome: 'already_seen',
      existing: null,
      audit: { logged: false, reason: 'conflicting_row_absent' },
    });
    expect(stub.usageRows).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Two deliveries of the same message                                          */
/* -------------------------------------------------------------------------- */

describe('claimInbound — concurrent deliveries of one message', () => {
  it('lets exactly one proceed', async () => {
    const stub = whatsappInboundStub();

    const results = await Promise.all([
      claimInbound(IMAGE_MESSAGE, { store: stub.store }),
      claimInbound(IMAGE_MESSAGE, { store: stub.store }),
    ]);

    const outcomes = results.map((result) => result.outcome).sort();
    expect(outcomes).toEqual(['already_seen', 'proceed']);
    expect(stub.inserts).toHaveLength(2);
    expect(stub.rows.size).toBe(1);
  });

  it('lets exactly one proceed across many parallel redeliveries', async () => {
    const stub = whatsappInboundStub();

    const results = await Promise.all(
      Array.from({ length: 12 }, () => claimInbound(IMAGE_MESSAGE, { store: stub.store })),
    );

    expect(results.filter((result) => result.outcome === 'proceed')).toHaveLength(1);
    // No duplicate spent anything: the claimed row has no user yet, so no audit row is attributable.
    expect(stub.usageRows).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* A database error is not a duplicate                                         */
/* -------------------------------------------------------------------------- */

describe('claimInbound — a failed insert that is not a conflict', () => {
  it('throws instead of returning already_seen', async () => {
    // Acknowledging this with 200 would silently discard the message: Meta does not redeliver an
    // acknowledged delivery. A 500 invites the redelivery that recovers it.
    const stub = whatsappInboundStub({
      insertError: { code: '42501', message: 'new row violates row-level security policy' },
    });

    await expect(claimInbound(IMAGE_MESSAGE, { store: stub.store })).rejects.toMatchObject({
      name: 'AppError',
      code: 'INTERNAL_ERROR',
      context: { reason: 'whatsapp_inbound_claim_failed', sqlstate: '42501' },
    });
    expect(stub.reads).toEqual([]);
    expect(stub.usageRows).toEqual([]);
  });

  it('does not read the duplicate signal out of the error message text', async () => {
    // A foreign-key violation whose prose mentions a duplicate key. Classification is on SQLSTATE,
    // so this is a failure and not a redelivery.
    const stub = whatsappInboundStub({
      insertError: { code: '23503', message: 'duplicate key value violates unique constraint' },
    });

    await expect(claimInbound(IMAGE_MESSAGE, { store: stub.store })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('never leaks the phone number into the log context', async () => {
    const stub = whatsappInboundStub({ insertError: { code: '42501', message: 'denied' } });

    await claimInbound(IMAGE_MESSAGE, { store: stub.store }).then(
      () => {
        throw new Error('claimInbound resolved on an unexpected database error');
      },
      (error: unknown) => {
        const context = (error as { context?: Record<string, unknown> }).context ?? {};
        expect(Object.values(context)).not.toContain(PHONE);
        expect(context).toMatchObject({ providerMessageId: WAMID });
      },
    );
  });
});

describe('isUniqueViolation', () => {
  it('is true for 23505 and false for every other SQLSTATE', () => {
    expect(isUniqueViolation({ code: '23505', message: '' })).toBe(true);
    expect(isUniqueViolation({ code: '23503', message: '' })).toBe(false);
    expect(isUniqueViolation({ code: '23502', message: '' })).toBe(false);
    expect(isUniqueViolation({ code: '42501', message: '' })).toBe(false);
    expect(isUniqueViolation({ code: 'PGRST301', message: '' })).toBe(false);
    expect(isUniqueViolation({ code: '', message: '' })).toBe(false);
  });

  it('ignores the message text entirely', () => {
    // Postgres's prose is not part of any contract, and a locale change must not reclassify.
    expect(isUniqueViolation({ code: '23505', message: 'भिन्न भाषा' })).toBe(true);
    expect(
      isUniqueViolation({ code: '42501', message: 'duplicate key value violates unique constraint' }),
    ).toBe(false);
  });
});

describe('operationForMessageType', () => {
  it('maps the three supported types and nothing else', () => {
    expect(operationForMessageType('image')).toBe('image');
    expect(operationForMessageType('text')).toBe('chat');
    expect(operationForMessageType('audio')).toBe('voice');
    expect(operationForMessageType('sticker')).toBeNull();
    expect(operationForMessageType('location')).toBeNull();
    expect(operationForMessageType('')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Attaching the resolved profile                                              */
/* -------------------------------------------------------------------------- */

describe('attachResolvedProfile', () => {
  it('records the profile resolved after the claim', async () => {
    const stub = whatsappInboundStub();
    await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    await attachResolvedProfile(WAMID, USER, { store: stub.store });

    expect(stub.rows.get(WAMID)?.user_id).toBe(USER);
  });

  it('makes the next redelivery attributable', async () => {
    const stub = whatsappInboundStub();
    await claimInbound(IMAGE_MESSAGE, { store: stub.store });
    await attachResolvedProfile(WAMID, USER, { store: stub.store });

    const redelivery = await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    expect(redelivery).toMatchObject({ outcome: 'already_seen', audit: { logged: true } });
    expect(stub.usageRows[0]?.user_id).toBe(USER);
  });
});

/* -------------------------------------------------------------------------- */
/* Terminal transitions                                                        */
/* -------------------------------------------------------------------------- */

describe('terminal transitions', () => {
  it('moves a claimed row to processed with a completion instant', async () => {
    const stub = whatsappInboundStub();
    await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    const transition = await markProcessed(WAMID, { store: stub.store, now: COMPLETED_AT });

    expect(transition).toEqual({ applied: true, status: 'processed' });
    expect(stub.transitions).toEqual([
      { id: WAMID, status: 'processed', completedAt: COMPLETED_AT.toISOString() },
    ]);
    expect(stub.rows.get(WAMID)?.status).toBe('processed');
  });

  it('moves a claimed row to failed on the soft deadline', async () => {
    const stub = whatsappInboundStub();
    await claimInbound(IMAGE_MESSAGE, { store: stub.store });

    expect(await markFailed(WAMID, { store: stub.store })).toEqual({
      applied: true,
      status: 'failed',
    });
    expect(stub.rows.get(WAMID)?.status).toBe('failed');
  });

  it('moves a claimed row to rejected for an unsupported type or unknown phone', async () => {
    const stub = whatsappInboundStub();
    await claimInbound({ ...IMAGE_MESSAGE, rawType: 'sticker' }, { store: stub.store });

    expect(await markRejected(WAMID, { store: stub.store })).toEqual({
      applied: true,
      status: 'rejected',
    });
    expect(stub.rows.get(WAMID)?.status).toBe('rejected');
  });

  it('refuses to overwrite a row that already reached a terminal status', async () => {
    // The soft deadline racing completed work. The first outcome stands, so the audit keeps saying
    // what actually happened.
    const stub = whatsappInboundStub();
    await claimInbound(IMAGE_MESSAGE, { store: stub.store });
    await markProcessed(WAMID, { store: stub.store });

    const late = await markFailed(WAMID, { store: stub.store });

    expect(late).toEqual({ applied: false, reason: 'not_in_received_state' });
    expect(stub.rows.get(WAMID)?.status).toBe('processed');
  });

  it('reports a transition on a row that is not there as not applied', async () => {
    const stub = whatsappInboundStub();

    expect(await markProcessed(WAMID, { store: stub.store })).toEqual({
      applied: false,
      reason: 'not_in_received_state',
    });
  });

  it('covers exactly the three terminal statuses', () => {
    // `received` is absent on purpose: a transition back to it would erase the one honest fact the
    // status column records.
    expect([...TERMINAL_INBOUND_STATUSES].sort()).toEqual(['failed', 'processed', 'rejected']);
  });
});
