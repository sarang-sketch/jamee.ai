import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  INBOUND_INITIAL_STATUS,
  adminWhatsappInboundStore,
  attachResolvedProfile,
  claimInbound,
  isUniqueViolation,
  markFailed,
  markProcessed,
  type InboundReceivedRow,
  type InboundStoreOptions,
} from '@/lib/db/whatsapp-inbound';
import { knowledgeReaderFrom } from '@/lib/knowledge';
import { dayWindowKey } from '@/lib/time';
import type { InboundMessage } from '@/lib/whatsapp';
import {
  adminProfileByPhoneStore,
  processInboundMessage,
  type WhatsappDiagnosisService,
  type WhatsappDispatchDeps,
  type WhatsappMediaStore,
  type WhatsappSender,
  type WhatsappVoiceService,
} from '@/lib/whatsapp-dispatch';
import { chatAnswerer, chatWriteStoreFrom } from '@/services/chat.service';
import type { CounterRpc } from '@/services/quota.service';
import type { TablesInsert, UsageLogRow } from '@/types/database';

import { anonClient } from './clients';
import { TEST_DATABASE_URL_VAR, describeIntegration } from './database';
import { startHarness, type Harness } from './harness';
import { providerCallCount } from './providers';

/**
 * Inbound idempotency and the duplicate spend rule, against the real primary key.
 *
 * Requirements: 11.5 (a delivery whose Provider_Message_Id was already processed is acknowledged,
 *               invokes no shared service, and leaves the Farmer's quota unchanged), 11.6 (the
 *               Provider_Message_Id is recorded for duplicate detection), 14.6 (the audit row),
 *               13.1 / 13.2 (RLS)
 * Design: "Inbound processing order" step 2; "Acknowledgement versus processing" (D11); D10
 * Migration: `0008_whatsapp_inbound.sql` — `provider_message_id` is the primary key, and RLS is
 *            enabled with no policies at all
 *
 * =============================================================================
 * WHY A STUB CANNOT MAKE ANY OF THESE CLAIMS
 * =============================================================================
 *
 * `src/lib/db/whatsapp-inbound.test.ts` and `tests/property/webhook.property.test.ts` both stub
 * `WhatsappInboundStore` with a `Map`. That establishes what the module *does with an answer* — a
 * `23505` becomes `already_seen`, a duplicate writes no second row, any other error throws rather
 * than acknowledging — and it cannot establish that the answer is right, because **a single-threaded
 * in-memory map serializes itself for free**. Two `Map.has` / `Map.set` pairs cannot interleave in
 * JavaScript, so the stub is idempotent whether or not the index is.
 *
 * The module's own header lists what has to be checked against real Postgres instead. All five are
 * below:
 *
 *  1. **True concurrency** — parallel claims for one WAMID from separate connections: exactly one
 *     `proceed`, exactly one row. Only the unique index makes that atomic.
 *  2. **A redelivery spends nothing** — the counter is unchanged and no provider was called.
 *  3. **The SQLSTATE really is `23505`**, arriving on `error.code` through PostgREST rather than only
 *     in the message text. Everything in the module follows from that one fact.
 *  4. **`transitionFromReceived`'s guard is atomic** — two terminal transitions racing leave one
 *     applied and the row in the first writer's state.
 *  5. **RLS holds** — neither the public key nor a farmer's session reaches this table, and no farmer
 *     can fabricate a `duplicate_ignored` audit row.
 *
 * =============================================================================
 * WHAT IS REAL IN THE PIPELINE TESTS
 * =============================================================================
 *
 * The two dispatch tests call `processInboundMessage()` — the real pipeline — with the real
 * `whatsapp_inbound` store, the real `profiles.phone` lookup (including the `wa_id` → E.164
 * normalization, driven from a number with no leading `+` exactly as Meta sends it), the real
 * conversation resolution, the real ChatService, the real quota reserve against `0007`, and the real
 * `usage_logs` writes. Two seams are stubs, and both are outside the claim:
 *
 *  - **`send`** counts replies instead of calling Meta. "No second reply" is a claim about how many
 *    times the pipeline reaches its sender, which is exactly what a counting sender observes.
 *  - **The provider SDK calls**, through `harness.providers` at the adapter seam, so "no provider
 *    call" is a count of real gateway round trips that reached a stubbed SDK method rather than a
 *    count of nothing.
 *
 * `diagnose`, `voice` and `media` are injected as functions that **throw**. A typed question must
 * reach none of them, and a throw makes that structural instead of implied by an absent assertion.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

/**
 * A question that grounds in exactly one seeded row.
 *
 * `matchConditions()` resolves "tomato" plus "late blight" on its first tier, so the turn is
 * grounded rather than referred — which matters because Requirement 4.7's referral answers **without
 * a model call**, and a fixture that took that path would make "no provider call on the duplicate"
 * true for the wrong reason.
 */
const QUESTION = 'My tomato has late blight. What should I do?';

/**
 * The quota window the chat reserves land in.
 *
 * Pinned, and in the past, for the reason `QuotaOptions.now` exists: a window key is a wall-clock
 * fact in Asia/Kolkata, and an assertion that read `dayWindowKey()` at its own moment could straddle
 * a Kolkata midnight and read a fresh row. Everything else about the reserve is real — the same
 * `counter_try_increment` from `0007`, called by the same service.
 */
const QUOTA_INSTANT = new Date(Date.UTC(1970, 0, 15, 12, 0, 0));

/** What the counting sender and the counting chat service record. */
interface Sink {
  /** One entry per shared-service invocation. Requirement 11.5's "invokes no shared service". */
  readonly serviceCalls: string[];
  /** One entry per reply handed to the sender. Requirement 11.5's "no second reply". */
  readonly replies: { readonly to: string; readonly body: string }[];
}

function sink(): Sink {
  return { serviceCalls: [], replies: [] };
}

function countingSender(into: Sink): WhatsappSender {
  return (options) => {
    into.replies.push({ to: options.to, body: options.body });
    return Promise.resolve({ ok: true, sentMessageId: 'wamid.integration.reply', bodyChars: options.body.length });
  };
}

/** A typed question reaches the ChatService and nothing else. These make "nothing else" a failure. */
const refuseDiagnose: WhatsappDiagnosisService = () => {
  throw new Error('a text delivery must not reach the DiagnosisService');
};
const refuseVoice: WhatsappVoiceService = () => {
  throw new Error('a text delivery must not reach the VoiceService');
};
const refuseMedia: WhatsappMediaStore = () => {
  throw new Error('a text delivery must not download media');
};

describeIntegration(`whatsapp inbound idempotency (requires ${TEST_DATABASE_URL_VAR})`, () => {
  let harness: Harness;
  let rpc: CounterRpc;
  let store: ReturnType<typeof adminWhatsappInboundStore>;
  let inboundOptions: InboundStoreOptions;
  /** Every WAMID this file wrote. `whatsapp_inbound` does not cascade with the farmer (0008). */
  const written: string[] = [];

  beforeAll(async () => {
    harness = await startHarness();
    if (harness.quota.rpc === undefined) {
      throw new Error('the harness did not bind a counter RPC, so no spend claim is checkable');
    }
    rpc = harness.quota.rpc;
    store = adminWhatsappInboundStore(harness.admin);
    inboundOptions = { store };
  }, 60_000);

  afterAll(async () => {
    // `whatsapp_inbound.user_id` is `on delete set null` by design (Requirement 11.5 needs the row to
    // outlive an unresolvable sender), so deleting the farmers does not take these rows with them.
    if (written.length > 0) {
      await harness?.admin.from('whatsapp_inbound').delete().in('provider_message_id', written);
    }
    await harness?.cleanup();
  });

  /* ====================================================================== */
  /* Helpers                                                                */
  /* ====================================================================== */

  /** A WAMID shaped like Meta's, unique per call, and registered for cleanup. */
  function wamid(label: string): string {
    const id = `wamid.jamee-integration.${label}.${crypto.randomUUID()}`;
    written.push(id);
    return id;
  }

  /**
   * One inbound text message from farmer A.
   *
   * `fromPhone` carries **no leading `+`**, which is how V12 says Meta delivers a `wa_id` and is the
   * single most likely place this channel fails silently: `profiles.phone` is strict E.164 *with* the
   * `+`, so the comparison only matches because `normalizeInboundPhone()` adds it. Passing the raw
   * form keeps that function on the real path instead of around it.
   */
  function textDelivery(providerMessageId: string): InboundMessage {
    return {
      providerMessageId,
      fromPhone: harness.farmerA.phone.replace(/^\+/, ''),
      timestamp: '1700000000',
      rawType: 'text',
      wabaId: 'jamee-integration-waba',
      phoneNumberId: 'jamee-integration-phone-number-id',
      displayPhoneNumber: '+1 555 0100',
      content: { kind: 'text', body: QUESTION },
    };
  }

  function dispatchDeps(into: Sink): WhatsappDispatchDeps {
    return {
      // Service role, necessarily: a webhook carries no cookies, so there is no session to scope.
      supabase: harness.admin,
      inbound: inboundOptions,
      profiles: adminProfileByPhoneStore(harness.admin),
      chat: (input, coverage) => {
        into.serviceCalls.push(`chat:${input.conversationId}`);
        return chatAnswerer({
          supabase: harness.admin,
          writes: chatWriteStoreFrom(harness.admin, harness.admin),
          knowledge: knowledgeReaderFrom(harness.admin),
          models: harness.providers.models,
          quota: { rpc, now: QUOTA_INSTANT },
        })(input, coverage);
      },
      send: countingSender(into),
      diagnose: refuseDiagnose,
      voice: refuseVoice,
      media: refuseMedia,
      // Off-platform `getDeadline()` has no answer; pinning it keeps D11's arithmetic the only input,
      // the same way `tests/property/webhook.property.test.ts` does.
      deadline: { platformDeadline: () => undefined },
    };
  }

  /** The rows in `whatsapp_inbound` for one WAMID. Zero or one, and that is part of the claim. */
  async function inboundRows(providerMessageId: string) {
    const { data, error } = await harness.admin
      .from('whatsapp_inbound')
      .select('*')
      .eq('provider_message_id', providerMessageId);

    expect(error).toBeNull();
    return data ?? [];
  }

  /** Farmer A's chat counter in the pinned window — the source of truth for what was spent. */
  function chatUnitsUsed(): Promise<number> {
    return rpc.used({
      userId: harness.farmerA.id,
      operation: 'chat',
      windowKind: 'day',
      windowKey: dayWindowKey(QUOTA_INSTANT),
    });
  }

  async function usageRowsFor(userId: string): Promise<readonly UsageLogRow[]> {
    const { data, error } = await harness.admin
      .from('usage_logs')
      .select('*')
      .eq('user_id', userId);

    expect(error).toBeNull();
    return data ?? [];
  }

  const duplicateRows = (rows: readonly UsageLogRow[]): readonly UsageLogRow[] =>
    rows.filter((row) => row.outcome === 'duplicate_ignored');

  /* ====================================================================== */
  /* 1 and 3 — the index, and the SQLSTATE everything rests on               */
  /* ====================================================================== */

  describe('the primary key is the duplicate signal (Requirements 11.5, 11.6)', () => {
    it('reports a repeated insert as SQLSTATE 23505 on error.code', async () => {
      const providerMessageId = wamid('sqlstate');
      const row: InboundReceivedRow = {
        provider_message_id: providerMessageId,
        from_phone: harness.farmerA.phone,
        message_type: 'text',
        status: INBOUND_INITIAL_STATUS,
      };

      const first = await store.insertReceived(row);
      expect(first.error).toBeNull();

      const second = await store.insertReceived(row);

      // The whole module classifies by this code and nothing else, on the argument that Postgres's
      // prose is not a contract. This is where that argument is checked against the real transport:
      // PostgREST must put `23505` on `code`, not only inside `message`.
      expect(second.error).not.toBeNull();
      expect(second.error?.code).toBe('23505');
      expect(isUniqueViolation(second.error ?? { code: '', message: '' })).toBe(true);

      expect(await inboundRows(providerMessageId)).toHaveLength(1);
    });

    it('lets exactly one of four concurrent claims proceed', async () => {
      const providerMessageId = wamid('concurrent-claim');
      const message = textDelivery(providerMessageId);

      // Four claims, one WAMID, no awaits between them: four PostgREST requests contending for one
      // index entry on four backends. A `select`-then-`insert` would let all four find nothing and
      // all four proceed, which is the race V13's retry behaviour makes likely rather than
      // theoretical.
      const claims = await Promise.all(
        Array.from({ length: 4 }, () => claimInbound(message, inboundOptions)),
      );

      expect(claims.filter((claim) => claim.outcome === 'proceed')).toHaveLength(1);
      expect(claims.filter((claim) => claim.outcome === 'already_seen')).toHaveLength(3);
      for (const claim of claims) expect(claim.providerMessageId).toBe(providerMessageId);

      const rows = await inboundRows(providerMessageId);
      expect(rows).toHaveLength(1);
      // The insert records arrival and nothing more: only completed work writes a terminal status.
      expect(rows[0]?.status).toBe(INBOUND_INITIAL_STATUS);
      expect(rows[0]?.message_type).toBe('text');
      expect(rows[0]?.completed_at).toBeNull();
      // Requirement 11.5's ordering, visible in the row: the claim ran before profile resolution, so
      // there is no `user_id` on it yet.
      expect(rows[0]?.user_id).toBeNull();
    });
  });

  /* ====================================================================== */
  /* 4 — the terminal-transition guard                                      */
  /* ====================================================================== */

  describe('the received-state guard is atomic', () => {
    it('applies exactly one of two racing terminal transitions', async () => {
      const providerMessageId = wamid('transition-race');
      const claim = await claimInbound(textDelivery(providerMessageId), inboundOptions);
      expect(claim.outcome).toBe('proceed');

      // D11's soft deadline racing the work it is timing: `markFailed` must not overwrite a
      // `processed` row, and `markProcessed` must not overwrite a `failed` one. The `eq('status',
      // 'received')` predicate lives in the statement precisely so this is decided by a row lock
      // rather than by a read-then-write in application code.
      const [processed, failed] = await Promise.all([
        markProcessed(providerMessageId, inboundOptions),
        markFailed(providerMessageId, inboundOptions),
      ]);

      const outcomes = [processed, failed];
      expect(outcomes.filter((transition) => transition.applied)).toHaveLength(1);
      expect(outcomes.filter((transition) => !transition.applied)).toHaveLength(1);
      expect(outcomes.find((transition) => !transition.applied)).toEqual({
        applied: false,
        reason: 'not_in_received_state',
      });

      const winner = outcomes.find((transition) => transition.applied);
      if (winner?.applied !== true) throw new Error('neither transition was applied');

      const rows = await inboundRows(providerMessageId);
      expect(rows).toHaveLength(1);
      // The first writer's state stands, whichever writer that was.
      expect(rows[0]?.status).toBe(winner.status);
      expect(rows[0]?.completed_at).not.toBeNull();
    });

    it('refuses a transition on a row that already reached a terminal status', async () => {
      const providerMessageId = wamid('transition-settled');
      await claimInbound(textDelivery(providerMessageId), inboundOptions);

      expect(await markProcessed(providerMessageId, inboundOptions)).toEqual({
        applied: true,
        status: 'processed',
      });
      expect(await markFailed(providerMessageId, inboundOptions)).toEqual({
        applied: false,
        reason: 'not_in_received_state',
      });

      expect((await inboundRows(providerMessageId))[0]?.status).toBe('processed');
    });
  });

  /* ====================================================================== */
  /* The task's two bullets, through the real pipeline                       */
  /* ====================================================================== */

  describe('one processing per WAMID, through the real pipeline', () => {
    it('answers a redelivery with nothing: no service, no reply, no provider, no unit', async () => {
      const providerMessageId = wamid('redelivery');
      const message = textDelivery(providerMessageId);
      const into = sink();
      const deps = dispatchDeps(into);

      const unitsBefore = await chatUnitsUsed();
      const providerCallsBefore = providerCallCount(harness.providers.calls);

      /* The first delivery: the whole pipeline runs. */
      const first = await processInboundMessage(message, deps);

      expect(first.disposition).toBe('processed');
      expect(first.replySent).toBe(true);
      expect(into.serviceCalls).toHaveLength(1);
      expect(into.replies).toHaveLength(1);
      // Meta's own `wa_id` is the recipient, verbatim — not the E.164 form the lookup used.
      expect(into.replies[0]?.to).toBe(message.fromPhone);
      expect(into.replies[0]?.body.trim()).not.toBe('');

      const unitsAfterFirst = await chatUnitsUsed();
      const providerCallsAfterFirst = providerCallCount(harness.providers.calls);
      expect(unitsAfterFirst).toBe(unitsBefore + 1);
      // Exactly one round trip: `validateRephrased`'s checks 2 and 4 both repair or fall back in
      // process, so a chat turn never re-asks a model (D4's no-repair-re-ask rule).
      expect(providerCallsAfterFirst).toBe(providerCallsBefore + 1);

      const processedRow = (await inboundRows(providerMessageId))[0];
      expect(processedRow?.status).toBe('processed');
      // Requirement 11.6, and the reason a later redelivery can be attributed at all.
      expect(processedRow?.user_id).toBe(harness.farmerA.id);

      const usageAfterFirst = await usageRowsFor(harness.farmerA.id);
      const spent = usageAfterFirst.filter((row) => row.quota_spent);
      expect(spent).toHaveLength(1);
      expect(spent[0]?.operation).toBe('chat');
      expect(spent[0]?.channel).toBe('whatsapp');
      expect(duplicateRows(usageAfterFirst)).toHaveLength(0);

      /* Two redeliveries of the very same WAMID, concurrently — V13's retry behaviour. */
      const redeliveries = await Promise.all([
        processInboundMessage(message, deps),
        processInboundMessage(message, deps),
      ]);

      for (const result of redeliveries) {
        expect(result.disposition).toBe('duplicate_ignored');
        expect(result.replySent).toBe(false);
        expect(result.detail).toBe('provider_message_id_already_recorded');
      }

      // Requirement 11.5, in the three ways it is observable. None of these steps *checked* for a
      // duplicate — the claim insert refused before any of them was reachable.
      expect(into.serviceCalls).toHaveLength(1);
      expect(into.replies).toHaveLength(1);
      expect(providerCallCount(harness.providers.calls)).toBe(providerCallsAfterFirst);
      expect(await chatUnitsUsed()).toBe(unitsAfterFirst);

      // Still one row, and still `processed` — a redelivery does not reopen a settled delivery.
      const rows = await inboundRows(providerMessageId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('processed');

      // The audit says what happened rather than leaving it to be inferred from the counter (D10).
      const duplicates = duplicateRows(await usageRowsFor(harness.farmerA.id));
      expect(duplicates).toHaveLength(2);
      for (const row of duplicates) {
        expect(row.quota_spent).toBe(false);
        expect(row.model_provider).toBe('none');
        expect(row.used_fallback).toBe(false);
        expect(row.channel).toBe('whatsapp');
        // The inbound `text` type maps to the `chat` operation, taken from the conflicting row.
        expect(row.operation).toBe('chat');
        expect(row.latency_ms ?? -1).toBeGreaterThanOrEqual(0);
      }
      // Still exactly one billable row for the whole episode.
      expect((await usageRowsFor(harness.farmerA.id)).filter((row) => row.quota_spent)).toHaveLength(1);
    });

    it('processes one delivery once when three arrive at the same instant', async () => {
      const providerMessageId = wamid('concurrent-dispatch');
      const message = textDelivery(providerMessageId);
      const into = sink();
      const deps = dispatchDeps(into);

      const unitsBefore = await chatUnitsUsed();
      const providerCallsBefore = providerCallCount(harness.providers.calls);
      const duplicatesBefore = duplicateRows(await usageRowsFor(harness.farmerA.id)).length;

      const results = await Promise.all(
        Array.from({ length: 3 }, () => processInboundMessage(message, deps)),
      );

      expect(results.filter((result) => result.disposition === 'processed')).toHaveLength(1);
      expect(results.filter((result) => result.disposition === 'duplicate_ignored')).toHaveLength(2);
      expect(results.filter((result) => result.replySent)).toHaveLength(1);

      // One service call, one reply, one provider round trip, one unit — for three deliveries.
      expect(into.serviceCalls).toHaveLength(1);
      expect(into.replies).toHaveLength(1);
      expect(providerCallCount(harness.providers.calls)).toBe(providerCallsBefore + 1);
      expect(await chatUnitsUsed()).toBe(unitsBefore + 1);

      const rows = await inboundRows(providerMessageId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('processed');

      /**
       * **The audit row of a duplicate that lands inside the claim window is deliberately absent, and
       * that is not a gap in this assertion.**
       *
       * The claim insert precedes profile resolution — the ordering Requirement 11.5 rests on — so a
       * redelivery that conflicts before the winner has attached `user_id` finds `null` there, and
       * `usage_logs.user_id` is `not null`. The module records that as
       * `conflicting_row_has_no_user_id` and writes no row rather than attributing a farmer's
       * activity to an invented id. Which of the two happens here depends on the interleaving, so the
       * assertion is on what must be true either way: every duplicate row that *was* written is
       * honest, and none of them spent anything. The deterministic form of the audit claim is the
       * previous test, where the redelivery arrives after the first delivery has completed.
       */
      const duplicates = duplicateRows(await usageRowsFor(harness.farmerA.id));
      expect(duplicates.length - duplicatesBefore).toBeLessThanOrEqual(2);
      expect(duplicates.length - duplicatesBefore).toBeGreaterThanOrEqual(0);
      for (const row of duplicates) {
        expect(row.quota_spent).toBe(false);
        expect(row.model_provider).toBe('none');
      }
    });
  });

  /* ====================================================================== */
  /* 5 — RLS over the idempotency store and its audit rows                  */
  /* ====================================================================== */

  describe('nothing but the service role reaches this table (Requirement 13.1)', () => {
    it('shows a farmer session and the public key no inbound rows at all', async () => {
      const providerMessageId = wamid('rls');
      await claimInbound(textDelivery(providerMessageId), inboundOptions);

      // 0008 enables RLS with **no policies**, so both roles match nothing. That is what keeps
      // `from_phone` — every number that has ever messaged Jamee — out of the data API.
      const asFarmer = await harness.farmerA.client.from('whatsapp_inbound').select('*');
      const asAnon = await anonClient(harness.config).from('whatsapp_inbound').select('*');

      expect(asFarmer.data ?? []).toEqual([]);
      expect(asAnon.data ?? []).toEqual([]);
      // And the row really was there to be missed.
      expect(await inboundRows(providerMessageId)).toHaveLength(1);
    });

    it('refuses a farmer session that tries to claim or clear an inbound row', async () => {
      const providerMessageId = wamid('rls-write');
      await claimInbound(textDelivery(providerMessageId), inboundOptions);

      const inserted = await harness.farmerA.client.from('whatsapp_inbound').insert({
        provider_message_id: wamid('rls-insert'),
        from_phone: harness.farmerA.phone,
        message_type: 'text',
      });
      expect(inserted.error).not.toBeNull();

      // A farmer who could delete a row here could have one message processed twice.
      const deleted = await harness.farmerA.client
        .from('whatsapp_inbound')
        .delete()
        .eq('provider_message_id', providerMessageId)
        .select('provider_message_id');
      expect(deleted.data ?? []).toEqual([]);
      expect(await inboundRows(providerMessageId)).toHaveLength(1);
    });

    it('refuses a fabricated duplicate_ignored audit row from a farmer session', async () => {
      // 0006 grants `authenticated` select-own and nothing else. A client that could insert here
      // could claim a spent unit was never spent, which is the one claim this table exists to make
      // checkable.
      const fabricated: TablesInsert<'usage_logs'> = {
        user_id: harness.farmerA.id,
        operation: 'chat',
        channel: 'whatsapp',
        outcome: 'duplicate_ignored',
        model_provider: 'none',
        quota_spent: false,
      };

      const { error } = await harness.farmerA.client.from('usage_logs').insert(fabricated);
      expect(error).not.toBeNull();
    });

    it('lets a farmer read their own duplicate_ignored rows and nobody else theirs', async () => {
      // Written here rather than relied on from the pipeline tests above, so this assertion does not
      // depend on their ordering — and so the audit attribution is asserted deterministically in a
      // second place: with `user_id` already attached, a redelivery *must* produce the row.
      const providerMessageId = wamid('audit-visibility');
      await claimInbound(textDelivery(providerMessageId), inboundOptions);
      await attachResolvedProfile(providerMessageId, harness.farmerA.id, inboundOptions);

      const duplicate = await claimInbound(textDelivery(providerMessageId), inboundOptions);
      expect(duplicate.outcome).toBe('already_seen');
      if (duplicate.outcome !== 'already_seen') throw new Error('the redelivery was not suppressed');
      expect(duplicate.audit).toEqual({ logged: true });

      const mine = await harness.farmerA.client
        .from('usage_logs')
        .select('user_id, outcome')
        .eq('outcome', 'duplicate_ignored');
      const theirs = await harness.farmerB.client
        .from('usage_logs')
        .select('user_id, outcome')
        .eq('outcome', 'duplicate_ignored');

      expect(mine.error).toBeNull();
      // Written by the earlier redelivery test, and readable by the farmer they belong to.
      expect(mine.data?.length ?? 0).toBeGreaterThan(0);
      expect(mine.data?.every((row) => row.user_id === harness.farmerA.id)).toBe(true);
      expect(theirs.data ?? []).toEqual([]);
    });
  });
});
