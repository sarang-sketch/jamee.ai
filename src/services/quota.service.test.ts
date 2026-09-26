import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type { CapabilityRunner } from '@/lib/ai/capabilities';
import { DAILY_QUOTAS } from '@/lib/config/verified';
import type { MessageRecord } from '@/lib/db/reads';
import { AppError, errorResponse, isAppError, toEnvelope } from '@/lib/errors';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import {
  SUPPORTED_LANGUAGES,
  operationSchema,
  quotaStatusSchema,
  type MediaRef,
  type Operation,
  type VerifiedCondition,
} from '@/lib/schemas';
import { dayWindowKey } from '@/lib/time';
import { failureReply } from '@/lib/whatsapp-dispatch';
import { chatTurn, type ChatTurnDeps, type ChatWriteStore, type MessageInsert } from '@/services/chat.service';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import { diagnose, type DiagnosisDeps, type DiagnosisStore } from '@/services/diagnosis.service';
import {
  adminCounterRpc,
  coveredBy,
  limitFor,
  ownsRequest,
  quotaExceededError,
  quotaStatusOf,
  refund,
  refundReservation,
  reserve,
  reserveForRequest,
  status,
  type CounterRpc,
  type CounterRpcClient,
  type CounterRpcResponse,
  type QuotaReservation,
} from '@/services/quota.service';
import type { TablesInsert } from '@/types/database';

/**
 * Unit tests for `src/services/quota.service.ts` with the RPC layer stubbed.
 *
 * Requirements: 14.1 (20 / 50 / 20 per window), 14.2 (one shared limit across channels),
 *               14.3 (the decline states the limit and the reset time)
 *
 * What these can and cannot decide. Everything below is a fact about the SERVICE: which function
 * it calls, with which key, and what it makes of the answer. The atomicity of
 * `counter_try_increment` at the limit boundary and the `used > 0` guard on `counter_decrement`
 * are facts about Postgres, and they are task 10.2 against a real database — a stub that returned
 * "null at the limit" here would be asserting its own behaviour.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const USER = '11111111-1111-4111-8111-111111111111';

/**
 * 2026-09-15T19:30:00Z is **2026-09-16T01:00 in Asia/Kolkata**, so the day key is the 16th and
 * not the 15th. Pinned deliberately on the far side of the +05:30 offset: a UTC-derived key would
 * make every assertion below read `2026-09-15` and the timezone bug would pass its own test.
 */
const EARLY_IST = new Date('2026-09-15T19:30:00.000Z');
/** Next Asia/Kolkata midnight after `EARLY_IST`: 2026-09-17T00:00 IST. */
const EARLY_IST_RESET = '2026-09-16T18:30:00.000Z';

/** 23:59:59 IST on the 15th, and 00:00:01 IST on the 16th — one Kolkata day apart, two seconds. */
const JUST_BEFORE_MIDNIGHT_IST = new Date('2026-09-15T18:29:59.000Z');
const JUST_AFTER_MIDNIGHT_IST = new Date('2026-09-15T18:30:01.000Z');

interface Recorded {
  readonly fn: keyof CounterRpc;
  readonly args: unknown;
}

interface StubResults {
  readonly tryIncrement?: number | null | undefined;
  readonly decrement?: number | null | undefined;
  readonly used?: number | undefined;
}

/** A stub that answers with fixed values and records exactly what it was asked. */
function recordingRpc(results: StubResults = {}): { rpc: CounterRpc; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const rpc: CounterRpc = {
    tryIncrement: (args) => {
      calls.push({ fn: 'tryIncrement', args: { ...args } });
      return Promise.resolve(results.tryIncrement ?? null);
    },
    decrement: (args) => {
      calls.push({ fn: 'decrement', args: { ...args } });
      return Promise.resolve(results.decrement ?? null);
    },
    used: (args) => {
      calls.push({ fn: 'used', args: { ...args } });
      return Promise.resolve(results.used ?? 0);
    },
  };
  return { rpc, calls };
}

/**
 * A tripwire rather than a stand-in: it answers nothing and fakes nothing, so touching it fails
 * the test. That is what lets the nesting cases assert something real — not "the right count came
 * back", but "no counter function was called at all".
 */
const unreachableRpc: CounterRpc = {
  tryIncrement: () => {
    throw new Error('counter_try_increment was called; this path must reserve nothing');
  },
  decrement: () => {
    throw new Error('counter_decrement was called; this path must refund nothing');
  },
  used: () => {
    throw new Error('counter_used was called; this path needs no read');
  },
};

function onlyCall(calls: readonly Recorded[]): Recorded {
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (call === undefined) throw new Error('no RPC call was recorded');
  return call;
}

async function reservationFor(
  operation: Parameters<typeof reserve>[1],
  used: number,
  now: Date,
): Promise<QuotaReservation> {
  const { rpc } = recordingRpc({ tryIncrement: used });
  const outcome = await reserve(USER, operation, { rpc, now });
  if (outcome.outcome !== 'allowed') throw new Error('fixture expected an allowed reserve');
  return outcome.reservation;
}

/* ========================================================================== */
/* The limits (Requirement 14.1)                                               */
/* ========================================================================== */

describe('daily limits', () => {
  it('are 20 image / 50 chat / 20 voice', () => {
    expect(limitFor('image')).toBe(20);
    expect(limitFor('chat')).toBe(50);
    expect(limitFor('voice')).toBe(20);
  });

  it('are declared in exactly one place', () => {
    // `limitFor` reads `DAILY_QUOTAS` and the SQL takes the limit as a parameter, so this object
    // is the only copy of 20/50/20 in the system. A second copy is what this asserts against.
    expect(DAILY_QUOTAS).toEqual({ image: 20, chat: 50, voice: 20 });
    for (const operation of ['image', 'chat', 'voice'] as const) {
      expect(limitFor(operation)).toBe(DAILY_QUOTAS[operation]);
    }
  });
});

/* ========================================================================== */
/* reserve                                                                     */
/* ========================================================================== */

describe('reserve', () => {
  it('returns allowed with the new count', async () => {
    const { rpc, calls } = recordingRpc({ tryIncrement: 7 });

    const outcome = await reserve(USER, 'image', { rpc, now: EARLY_IST });

    expect(outcome.outcome).toBe('allowed');
    if (outcome.outcome !== 'allowed') return;
    expect(outcome.reservation.used).toBe(7);
    expect(outcome.reservation.limit).toBe(20);
    expect(outcome.reservation.resetsAt).toBe(EARLY_IST_RESET);
    expect(outcome.reservation.reservedHere).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('sends the operation, the day window, and the operation limit', async () => {
    const { rpc, calls } = recordingRpc({ tryIncrement: 1 });

    await reserve(USER, 'chat', { rpc, now: EARLY_IST });

    expect(onlyCall(calls)).toEqual({
      fn: 'tryIncrement',
      args: {
        userId: USER,
        operation: 'chat',
        windowKind: 'day',
        windowKey: '2026-09-16',
        limit: 50,
      },
    });
  });

  it('keys the counter with no channel component, so channels share one limit', async () => {
    // Requirement 14.2 is satisfied by OMISSION: there is no channel argument to pass, no channel
    // key in what reaches the RPC, and no channel column in the primary key (migration 0007). A
    // web request and a WhatsApp request are indistinguishable here, which is the point.
    const web = recordingRpc({ tryIncrement: 1 });
    const whatsapp = recordingRpc({ tryIncrement: 2 });

    await reserve(USER, 'image', { rpc: web.rpc, now: EARLY_IST });
    await reserve(USER, 'image', { rpc: whatsapp.rpc, now: EARLY_IST });

    const webArgs = onlyCall(web.calls).args;
    expect(webArgs).toEqual(onlyCall(whatsapp.calls).args);
    expect(Object.keys(webArgs as object).sort()).toEqual([
      'limit',
      'operation',
      'userId',
      'windowKey',
      'windowKind',
    ]);
    expect(JSON.stringify(webArgs)).not.toContain('channel');
  });

  it('derives the window key in Asia/Kolkata, not UTC', async () => {
    const { rpc, calls } = recordingRpc({ tryIncrement: 1 });

    await reserve(USER, 'voice', { rpc, now: JUST_BEFORE_MIDNIGHT_IST });

    // 18:29:59Z is 23:59:59 IST on the 15th. A UTC-derived key would also say the 15th here,
    // which is why the EARLY_IST case above carries the timezone assertion.
    expect(onlyCall(calls).args).toMatchObject({ windowKey: '2026-09-15' });
  });

  it('reports at-limit distinguishably, carrying the limit and the reset instant', async () => {
    const { rpc, calls } = recordingRpc({ tryIncrement: null });

    const outcome = await reserve(USER, 'chat', { rpc, now: EARLY_IST });

    expect(outcome.outcome).toBe('at_limit');
    if (outcome.outcome !== 'at_limit') return;
    expect(outcome.status).toEqual({
      operation: 'chat',
      used: 50,
      limit: 50,
      resetsAt: EARLY_IST_RESET,
    });
    // Requirement 14.3's "invoke no model provider" is the caller's ordering, but the decline has
    // to be usable without a second round trip — hence one call, and everything the message needs.
    expect(calls).toHaveLength(1);
    expect(quotaStatusSchema.safeParse(outcome.status).success).toBe(true);
  });

  it('produces a response-envelope quota block with no further I/O', async () => {
    const reservation = await reservationFor('image', 3, EARLY_IST);

    expect(quotaStatusOf(reservation)).toEqual({
      operation: 'image',
      used: 3,
      limit: 20,
      resetsAt: EARLY_IST_RESET,
    });
    expect(quotaStatusSchema.safeParse(quotaStatusOf(reservation)).success).toBe(true);
  });
});

/* ========================================================================== */
/* The decline (Requirement 14.3)                                              */
/* ========================================================================== */

describe('quotaExceededError', () => {
  it('states the limit and the reset time, and is not retryable today', async () => {
    const { rpc } = recordingRpc({ tryIncrement: null });
    const outcome = await reserve(USER, 'image', { rpc, now: EARLY_IST });
    if (outcome.outcome !== 'at_limit') throw new Error('expected at_limit');

    const error = quotaExceededError(outcome.status);

    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ limit: 20, used: 20, resetsAt: EARLY_IST_RESET });
    // The message template reads `{operation}` from context, not from details.
    expect(error.context).toEqual({ operation: 'image' });
  });
});

/* ========================================================================== */
/* One reserve per request, never per nested call                              */
/* ========================================================================== */

describe('reserveForRequest', () => {
  it('reserves when the service owns the request', async () => {
    const { rpc, calls } = recordingRpc({ tryIncrement: 1 });

    const outcome = await reserveForRequest(ownsRequest(USER, 'voice'), { rpc, now: EARLY_IST });

    expect(outcome.outcome).toBe('allowed');
    expect(onlyCall(calls)).toMatchObject({ fn: 'tryIncrement', args: { operation: 'voice' } });
  });

  it('touches no counter when the request already reserved', async () => {
    // The nesting case: ChatService inside a VoiceService request. One voice message must not
    // spend both a voice unit and a chat unit, so the nested call reaches no RPC at all.
    const voiceUnit = await reservationFor('voice', 4, EARLY_IST);

    const outcome = await reserveForRequest(coveredBy(voiceUnit), {
      rpc: unreachableRpc,
      now: EARLY_IST,
    });

    expect(outcome.outcome).toBe('allowed');
    if (outcome.outcome !== 'allowed') return;
    expect(outcome.reservation.operation).toBe('voice');
    expect(outcome.reservation.used).toBe(4);
    expect(outcome.reservation.reservedHere).toBe(false);
  });
});

/* ========================================================================== */
/* refund                                                                      */
/* ========================================================================== */

describe('refund', () => {
  it('decrements the day counter and reports the new count', async () => {
    const { rpc, calls } = recordingRpc({ decrement: 4 });

    const outcome = await refund(USER, 'image', { rpc, now: EARLY_IST });

    expect(outcome).toEqual({ refunded: true, used: 4 });
    expect(onlyCall(calls)).toEqual({
      fn: 'decrement',
      args: {
        userId: USER,
        operation: 'image',
        windowKind: 'day',
        windowKey: '2026-09-16',
      },
    });
  });

  it('is a no-op when the counter is already at zero', async () => {
    // `counter_decrement` matches no row when `used = 0`, returning NULL. Reported as
    // `refunded: false` rather than raised: the table's `used >= 0` constraint stays unreachable,
    // so a duplicate refund is harmless instead of a 500.
    const { rpc } = recordingRpc({ decrement: null });

    expect(await refund(USER, 'chat', { rpc, now: EARLY_IST })).toEqual({
      refunded: false,
      used: 0,
    });
  });
});

describe('refundReservation', () => {
  it('refunds the window key that was reserved, not the current one', async () => {
    const reservation = await reservationFor('image', 2, JUST_BEFORE_MIDNIGHT_IST);
    const { rpc, calls } = recordingRpc({ decrement: 1 });

    // The request began at 23:59:59 IST and failed at 00:00:01 IST. Re-deriving the key would
    // decrement TOMORROW's row: a spare unit tomorrow, and yesterday's spend left in place.
    await refundReservation(reservation, { rpc, now: JUST_AFTER_MIDNIGHT_IST });

    expect(onlyCall(calls).args).toMatchObject({ windowKey: '2026-09-15' });

    const byClock = recordingRpc({ decrement: 1 });
    await refund(USER, 'image', { rpc: byClock.rpc, now: JUST_AFTER_MIDNIGHT_IST });
    expect(onlyCall(byClock.calls).args).toMatchObject({ windowKey: '2026-09-16' });
  });

  it('refunds nothing when the reservation was inherited from an outer request', async () => {
    const voiceUnit = await reservationFor('voice', 5, EARLY_IST);
    const nested = coveredBy(voiceUnit);
    if (nested.role !== 'covered') throw new Error('expected a covered context');

    const outcome = await refundReservation(nested.reservation, { rpc: unreachableRpc });

    expect(outcome).toEqual({ refunded: false, used: 5 });
  });
});

/* ========================================================================== */
/* status                                                                      */
/* ========================================================================== */

describe('status', () => {
  it('returns used, limit, and resetsAt for the envelope', async () => {
    const { rpc, calls } = recordingRpc({ used: 3 });

    const result = await status(USER, 'voice', { rpc, now: EARLY_IST });

    expect(result).toEqual({
      operation: 'voice',
      used: 3,
      limit: 20,
      resetsAt: EARLY_IST_RESET,
    });
    expect(quotaStatusSchema.safeParse(result).success).toBe(true);
    expect(onlyCall(calls)).toEqual({
      fn: 'used',
      args: {
        userId: USER,
        operation: 'voice',
        windowKind: 'day',
        windowKey: '2026-09-16',
      },
    });
  });

  it('reads zero on a farmer first request of the day', async () => {
    const { rpc } = recordingRpc({ used: 0 });

    expect(await status(USER, 'chat', { rpc, now: EARLY_IST })).toMatchObject({
      used: 0,
      limit: 50,
    });
  });
});

/* ========================================================================== */
/* The admin adapter — DAL-backed, and the classifier that keeps a transport    */
/* failure from looking like at-limit                                           */
/* ========================================================================== */

/**
 * Under Amendment A3 `adminCounterRpc()` forwards to the Data_Access_Layer's owner-scoped counter
 * helpers (`farmerData(userId).counterTryIncrement / counterDecrement / counterUsed`). The layer is
 * mocked here so this file stays a unit test: it opens no connection and reads no `MONGODB_URI`.
 *
 * The mock is hoisted (a real `vi.mock` factory runs before the module graph loads), so the shared
 * spies come from `vi.hoisted`. Only `adminCounterRpc()` with NO argument reaches `farmerData`;
 * every other test in this file injects its own `CounterRpc` and never touches the layer, so the
 * mock is inert for them.
 */
const dalMock = vi.hoisted(() => ({
  counterTryIncrement: vi.fn<(...args: unknown[]) => Promise<number | null>>(),
  counterDecrement: vi.fn<(...args: unknown[]) => Promise<number | null>>(),
  counterUsed: vi.fn<(...args: unknown[]) => Promise<number>>(),
}));

vi.mock('@/lib/db/farmer', () => ({
  farmerData: (ownerId: string) => ({
    ownerId,
    counterTryIncrement: dalMock.counterTryIncrement,
    counterDecrement: dalMock.counterDecrement,
    counterUsed: dalMock.counterUsed,
  }),
  pruneMinuteCounters: vi.fn(async () => 0),
}));

/** A legacy PostgREST-shaped client, the compatibility seam a restatement-pending test still uses. */
interface FakeCall {
  readonly fn: string;
  readonly args: unknown;
}

function fakeSupabase(
  response: CounterRpcResponse,
  calls: FakeCall[] = [],
): CounterRpcClient {
  return {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return Promise.resolve(response);
    },
  };
}

describe('adminCounterRpc — the Data_Access_Layer path (A3)', () => {
  it('forwards a reserve to the owner-scoped counter helper with the day key and limit', async () => {
    dalMock.counterTryIncrement.mockReset().mockResolvedValue(5);
    const rpc = adminCounterRpc();

    await reserve(USER, 'chat', { rpc, now: EARLY_IST });

    // The owner is bound by `farmerData(USER)`; the accessor is called with operation, window kind,
    // the Asia/Kolkata day key, and the limit — no channel component (Requirement 14.2).
    expect(dalMock.counterTryIncrement).toHaveBeenCalledTimes(1);
    expect(dalMock.counterTryIncrement).toHaveBeenCalledWith('chat', 'day', '2026-09-16', 50);
  });

  it('reads the layer\'s null as at-limit rather than as an error', async () => {
    // The layer returns `null` when the conditional upsert matched nothing at the boundary (or the
    // duplicate-key race was caught inside it) — the one signal `reserve` reads as declined.
    dalMock.counterTryIncrement.mockReset().mockResolvedValue(null);
    const rpc = adminCounterRpc();

    const outcome = await reserve(USER, 'image', { rpc, now: EARLY_IST });
    expect(outcome.outcome).toBe('at_limit');
  });

  it('lets a real database failure propagate rather than reading it as at-limit', async () => {
    // Any OTHER failure throws out of the layer, so it can never arrive looking like the null the
    // at-limit branch reads — a farmer nowhere near their limit is not declined.
    dalMock.counterTryIncrement.mockReset().mockRejectedValue(new Error('replica set unreachable'));
    const rpc = adminCounterRpc();

    await expect(reserve(USER, 'image', { rpc, now: EARLY_IST })).rejects.toThrow(
      'replica set unreachable',
    );
  });

  it('reads an absent counter row as zero', async () => {
    dalMock.counterUsed.mockReset().mockResolvedValue(0);
    const rpc = adminCounterRpc();

    expect(await status(USER, 'image', { rpc, now: EARLY_IST })).toMatchObject({ used: 0 });
    expect(dalMock.counterUsed).toHaveBeenCalledWith('image', 'day', '2026-09-16');
  });
});

describe('adminCounterRpc — the legacy PostgREST-shaped compatibility seam', () => {
  it('classifies a call carrying an error as INTERNAL_ERROR, never as at-limit', async () => {
    // A PostgREST-shaped `{ data: null, error }` also arrives with `data: null`. Treating it as the
    // at-limit signal would decline a farmer nowhere near their limit. This seam is kept only so a
    // restatement-pending property test compiles; the classifier it exercises is preserved.
    const rpc = adminCounterRpc(fakeSupabase({ data: null, error: { message: 'boom' } }));

    await expect(reserve(USER, 'image', { rpc, now: EARLY_IST })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    });
  });

  it('forwards the documented p_ argument names when a legacy client is injected', async () => {
    const calls: FakeCall[] = [];
    const rpc = adminCounterRpc(fakeSupabase({ data: 5, error: null }, calls));

    await reserve(USER, 'chat', { rpc, now: EARLY_IST });

    expect(calls).toEqual([
      {
        fn: 'counter_try_increment',
        args: { p_user: USER, p_operation: 'chat', p_window_kind: 'day', p_window_key: '2026-09-16', p_limit: 50 },
      },
    ]);
  });
});

/* ========================================================================== */
/* The decline a farmer actually reads (Requirement 14.3, D5)                  */
/* ========================================================================== */

/**
 * The block above proves the decline *carries* the limit and the reset instant. This block proves
 * the farmer is *told* them, in their own language, from a static catalog.
 *
 * Why it lives here rather than beside the catalogs: `quotaExceededError()` is the only production
 * constructor of `QUOTA_EXCEEDED` in the codebase, so this file owns the whole path from "the
 * counter said no" to "the sentence on the screen". The three services already assert that no
 * provider seam is reached on this path (`diagnosis.service.test.ts`, `chat.service.test.ts`'s
 * `tripwireModels`, `voice.service.test.ts`); what none of them asserted is that the sentence
 * renders — a missing `{operation}` or an ISO timestamp dumped into Devanagari would have passed
 * every one of them.
 *
 * D5 is what makes this checkable at all: the copy is a static string in the repository, so there
 * is no model call anywhere between the at-limit answer and the rendered message.
 */

/**
 * `EARLY_IST_RESET` is `2026-09-16T18:30:00.000Z`, which is **17 September, 00:00 in Kolkata** and
 * **16 September** in UTC. Those two dates disagreeing is the whole point of the fixture: a
 * sentence quoting `17` is quoting the Kolkata midnight Requirement 14.3 asks for, and one quoting
 * the ISO instant or a UTC date is not.
 */
const KOLKATA_RESET_DAY = '17';

/** Anything `interpolate` left unfilled stays visible as `{name}` — so this must never match. */
const UNFILLED_PLACEHOLDER = /\{[A-Za-z]\w*\}/;

async function declineFor(
  operation: Parameters<typeof reserve>[1],
): Promise<ReturnType<typeof quotaExceededError>> {
  const { rpc } = recordingRpc({ tryIncrement: null });
  const outcome = await reserve(USER, operation, { rpc, now: EARLY_IST });
  if (outcome.outcome !== 'at_limit') throw new Error('fixture expected an at-limit reserve');
  return quotaExceededError(outcome.status);
}

describe('the QUOTA_EXCEEDED envelope', () => {
  it('is HTTP 429 carrying the limit, the used count, and the reset instant', async () => {
    for (const operation of operationSchema.options) {
      const error = await declineFor(operation);

      for (const language of SUPPORTED_LANGUAGES) {
        const { error: envelope } = toEnvelope(error, language);

        expect(envelope.code).toBe('QUOTA_EXCEEDED');
        expect(envelope.language).toBe(language);
        expect(envelope.retryable).toBe(false);
        // All three, on every operation and every language. `used` is here because 14.3's decline
        // has to be checkable against the counter, even though no template sentence reads it.
        expect(envelope.details).toEqual({
          limit: DAILY_QUOTAS[operation],
          used: DAILY_QUOTAS[operation],
          resetsAt: EARLY_IST_RESET,
        });
      }

      expect(error.status).toBe(429);
    }
  });

  it('renders a complete sentence in every supported language', async () => {
    for (const operation of operationSchema.options) {
      const error = await declineFor(operation);

      for (const language of SUPPORTED_LANGUAGES) {
        const { error: envelope } = toEnvelope(error, language);
        const catalog = messages(language);

        // Requirement 14.3's two facts, in the farmer's own words.
        expect(envelope.message).toContain(String(DAILY_QUOTAS[operation]));
        expect(envelope.message).toContain(catalog.operations[operation]);
        // Requirement 15.3: nothing left unfilled, so no `{resetsAt}` reaches a farmer.
        expect(envelope.message).not.toMatch(UNFILLED_PLACEHOLDER);
        expect(envelope.message).not.toBe(catalog.errors.QUOTA_EXCEEDED);
      }
    }
  });

  it('states the reset as the next Kolkata midnight, not as the stored instant', async () => {
    const error = await declineFor('image');

    for (const language of SUPPORTED_LANGUAGES) {
      const { error: envelope } = toEnvelope(error, language);

      // 17 September in Kolkata; the machine-readable instant is 16 September in UTC.
      expect(envelope.message).toContain(KOLKATA_RESET_DAY);
      expect(envelope.message).not.toContain(EARLY_IST_RESET);
      expect(envelope.message).not.toContain('2026-09-16');
      // The instant itself still travels structured, for a client that wants to compute with it.
      expect(envelope.details?.resetsAt).toBe(EARLY_IST_RESET);
    }
  });

  it('reads its copy from the static catalogs, so no model call is on this path', async () => {
    // D5: the decline copy ships in the repository. `interpolate` over a frozen template string is
    // the entire rendering step — there is nothing here that could reach a provider.
    for (const language of SUPPORTED_LANGUAGES) {
      const template = messages(language).errors.QUOTA_EXCEEDED;

      expect(typeof template).toBe('string');
      expect(template).toContain('{limit}');
      expect(template).toContain('{operation}');
      expect(template).toContain('{resetsAt}');
    }

    const error = await declineFor('chat');
    const rendered = SUPPORTED_LANGUAGES.map((language) => toEnvelope(error, language).error.message);
    // Three distinct sentences, not one English string echoed three times.
    expect(new Set(rendered).size).toBe(SUPPORTED_LANGUAGES.length);
  });

  it('carries no retry-after header, because the wait is until tomorrow', async () => {
    const error = await declineFor('voice');
    const response = errorResponse(error, 'hi');

    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toBe('application/json');
    /**
     * `RATE_LIMITED` sets `retry-after` from `details.retryAfterSeconds` because a burst refusal
     * clears within the minute. A daily quota does not, so advertising a retry delay here would be
     * a number no client should act on — the reset instant in `details` is the honest form.
     */
    expect(response.headers.get('retry-after')).toBeNull();
    expect(error.retryable).toBe(false);
  });
});

/**
 * The fourth writer. `diagnose`, `chatTurn` and `transcribeAndAnswer` each assert their own
 * decline (and their own untouched provider seam) in their own suites; the WhatsApp adapter adds no
 * reserve and no provider call of its own — it forwards whatever the shared service raised.
 *
 * What that leaves worth checking is the *rendering*, because this channel has no HTTP envelope:
 * `failureReply` is the only thing between `QUOTA_EXCEEDED` and the message Meta delivers. It goes
 * through the same `toEnvelope` leak boundary, so the assertion is that the sentence is complete
 * there too — an unfilled `{resetsAt}` would reach a farmer as a WhatsApp message rather than as a
 * JSON field nobody reads.
 */
describe('the decline on the channel with no HTTP envelope', () => {
  it('renders the same complete sentence for a WhatsApp reply', async () => {
    const error = await declineFor('image');

    for (const language of SUPPORTED_LANGUAGES) {
      const reply = failureReply(error, language);

      expect(reply).toBe(toEnvelope(error, language).error.message);
      expect(reply).toContain(String(DAILY_QUOTAS.image));
      expect(reply).toContain(messages(language).operations.image);
      expect(reply).toContain(KOLKATA_RESET_DAY);
      expect(reply).not.toMatch(UNFILLED_PLACEHOLDER);
    }
  });
});

/* ========================================================================== */
/* ========================================================================== */
/* Task 10.3 — the spend rule's pre-provider cases                             */
/* ========================================================================== */
/* ========================================================================== */

/**
 * **A unit is spent if and only if at least one provider call was attempted for that request.**
 *
 * Requirements: 2.6 (an ownership rejection is 403 *and* the counter is untouched), 14.3 (a request
 *               past the limit is declined stating the limit and the reset time, and invokes no model
 *               provider)
 * Design: "Quota enforcement" — step 9's refund list; and the biconditional above, which is the rule
 *         the module header states.
 *
 * ### What this section adds that the per-service suites and Property 20 do not
 *
 * Every individual exit below is already asserted *somewhere*: `diagnosis.service.test.ts` owns the
 * ownership 403, the burst refusal, the at-limit decline and the signed-URL refund for the image
 * operation; `chat.service.test.ts` owns the conversation rejection, the at-limit decline, the
 * knowledge-base refund and the referral for the chat operation; Property 20 owns "the limit is never
 * exceeded across any channel distribution", and `referral.property.test.ts` owns the referral's
 * grounding. Re-asserting any of those here would be a second copy.
 *
 * What none of them makes is the claim the **rule** makes, which is a claim about the *set*:
 *
 *  1. **The enumeration is closed and the verdict is uniform.** Each service test checks its own
 *     exit in its own file, so one service drifting from the rule reads as a local change rather than
 *     as an inconsistency. The table below drives every pre-provider exit of two operations against
 *     **one shared counter** and asserts one verdict for all of them: nothing spent, nothing reached
 *     a provider, and the audit says so.
 *
 *  2. **Never-reserve and reserve-then-refund are different mechanisms with the same result.** Both
 *     leave `used` at zero, so a final-count assertion cannot tell them apart — and the existing
 *     tests assert the final count. Counting the RPC traffic can: a never-reserve exit issues **no**
 *     `counter_try_increment` at all, and a refunded exit issues one and then one
 *     `counter_decrement`. That distinction is the only observable difference between the design's
 *     step 9 and the biconditional, and it is what settles the referral (see below).
 *
 *  3. **The counter and the `quota_spent` flag never disagree.** The biconditional's audit half:
 *     `used === 0` ⟺ `quota_spent === false`, asserted on the same run rather than in two files.
 *
 * ### A recorded design-versus-code disagreement, resolved by counting
 *
 * Design step 9 enumerates only *failures* as refundable — signed-URL issuance, an unreadable object,
 * a knowledge-base read failure, an unhandled error ahead of the gateway. An **out-of-scope chat
 * referral** is none of those: it is a *success* that never reached a provider. The two readings
 * disagree about it, and the biconditional wins in the code — `chatTurn()` reserves and then refunds
 * rather than never reserving. The row for it below is marked `reserve_then_refund` and the counted
 * traffic is what shows which of the two mechanisms actually ran, rather than inferring it from a
 * count of zero that both would produce.
 *
 * A second, smaller one: step 9's "a knowledge-base read failure" is refundable only where the read
 * is **pre**-provider, which is `chatTurn()`. On the diagnosis path the knowledge lookup happens at
 * step 8, *after* the classification call, so a missing row there is not refunded and is not an error
 * at all — it returns the inconclusive shape with a spent unit (Requirement 6.7). Same clause in the
 * design, two positions in the pipeline, two correct answers. Asserted as the last case here so the
 * asymmetry is visible rather than surprising.
 */

/* -------------------------------------------------------------------------- */
/* One counters table, with migration 0007's semantics and its traffic counted  */
/* -------------------------------------------------------------------------- */

interface Ledger {
  /** `user::operation::window_kind::window_key` — **no channel component** (Requirement 14.2). */
  readonly rows: Map<string, number>;
  /** `counter_try_increment` calls, granted or refused. Zero means "never reserved". */
  attempted: number;
  /** Those that returned a count rather than NULL. */
  granted: number;
  /** `counter_decrement` calls. One means "reserved, then handed back". */
  decrements: number;
}

function ledger(): Ledger {
  return { rows: new Map<string, number>(), attempted: 0, granted: 0, decrements: 0 };
}

function ledgerKey(args: {
  userId: string;
  operation: Operation;
  windowKind: string;
  windowKey: string;
}): string {
  return `${args.userId}::${args.operation}::${args.windowKind}::${args.windowKey}`;
}

/**
 * The three counter functions as one in-memory row set, with the read and the write separated by no
 * `await` — the atomicity a single Postgres UPDATE has. The `used > 0` guard on `decrement` is
 * migration 0007's, which is what makes a duplicate refund harmless rather than a constraint
 * violation. Real atomicity is task 10.2's, against a real database.
 */
function ledgerRpc(state: Ledger): CounterRpc {
  return {
    tryIncrement(args) {
      state.attempted += 1;
      const key = ledgerKey(args);
      const used = state.rows.get(key) ?? 0;
      if (used >= args.limit) return Promise.resolve(null);
      state.granted += 1;
      state.rows.set(key, used + 1);
      return Promise.resolve(used + 1);
    },
    decrement(args) {
      state.decrements += 1;
      const key = ledgerKey(args);
      const used = state.rows.get(key) ?? 0;
      if (used === 0) return Promise.resolve(null);
      state.rows.set(key, used - 1);
      return Promise.resolve(used - 1);
    },
    used(args) {
      return Promise.resolve(state.rows.get(ledgerKey(args)) ?? 0);
    },
  };
}

/** `used` on the one row this farmer and operation can touch inside the pinned Kolkata day. */
function usedIn(state: Ledger, operation: Operation): number {
  return state.rows.get(`${USER}::${operation}::day::${dayWindowKey(EARLY_IST)}`) ?? 0;
}

/** Fill the row to its ceiling, as a farmer who has already used their day would leave it. */
function fillToLimit(state: Ledger, operation: Operation): void {
  state.rows.set(
    `${USER}::${operation}::day::${dayWindowKey(EARLY_IST)}`,
    DAILY_QUOTAS[operation],
  );
  // The fixture is not traffic: the counts below must reflect only what the service did.
  state.attempted = 0;
  state.granted = 0;
  state.decrements = 0;
}

/* -------------------------------------------------------------------------- */
/* Provider and client tripwires                                              */
/* -------------------------------------------------------------------------- */

/**
 * A model runner that cannot be called. "Invokes no model provider" is asserted by making the call
 * impossible rather than by counting zero: a miscounted seam reads as a pass, a thrown tripwire does
 * not. Requirement 14.3 says this in as many words.
 */
const unreachableModels: CapabilityRunner = {
  classify: () => {
    throw new Error('a provider call was attempted; every exit here is before the first one');
  },
  generate: () => {
    throw new Error('a provider call was attempted; every exit here is before the first one');
  },
};

/* -------------------------------------------------------------------------- */
/* Media reference (Amendment A3 — GridFS, no storage path, no signed URL)     */
/* -------------------------------------------------------------------------- */

const OBJECT_ID_HEX = '3333333333334333833300aa';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';

/**
 * The crop image to diagnose, as a Media_Reference (A3, D1 amended) — a `{ fileId, kind }` pair,
 * not a `{ bucket, path }` storage reference. There is no owner segment: ownership is proven by the
 * owner-scoped media read (`readMedia`) returning `null` for a stranger's or a missing file, not by
 * parsing a prefix. So the "foreign" and "not there" cases below are the *same* `readMedia: null`,
 * exactly as the store makes them indistinguishable (Requirement 2.6).
 */
const IMAGE_REF: MediaRef = { fileId: OBJECT_ID_HEX, kind: 'crop-image' };

/* -------------------------------------------------------------------------- */
/* The knowledge base                                                          */
/* -------------------------------------------------------------------------- */

const CONDITION: VerifiedCondition = 'Tomato Early Blight';

const KNOWLEDGE_ROWS: readonly KnowledgeEntry[] = [
  {
    id: '55555555-5555-4555-8555-555555555555',
    disease_name: CONDITION,
    crop: 'tomato',
    scientific_name: 'Alternaria synthetica',
    symptoms: [`${CONDITION} symptom line`],
    causes: [`${CONDITION} cause line`],
    treatment: [`${CONDITION} treatment line`],
    prevention: [`${CONDITION} prevention line`],
    default_severity: 'moderate',
    source: `${CONDITION} extension bulletin`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

const knowledge: KnowledgeReader = (names) =>
  Promise.resolve(KNOWLEDGE_ROWS.filter((row) => names.includes(row.disease_name)));

const failingKnowledge: KnowledgeReader = () =>
  Promise.reject(new AppError('INTERNAL_ERROR', { context: { reason: 'knowledge_read_failed' } }));

/* -------------------------------------------------------------------------- */
/* The two services, wired to one ledger                                       */
/* -------------------------------------------------------------------------- */

interface Audit {
  readonly rows: TablesInsert<'usage_logs'>[];
}

/**
 * The owner-checked media read seam (Amendment A3). Defaults to returning bytes — a file this
 * farmer owns — so the pipeline advances to the reserve. `present: false` returns `null`, which is
 * both "not this farmer's" and "not there" (Requirement 2.6): the service maps it to
 * `STORAGE_REF_FORBIDDEN` before the reserve, so nothing is spent. There is no signed-URL step under
 * A3 — the bytes are the input to the model — so the pre-A3 "signing failed" refundable exit no
 * longer exists on this path.
 */
function readMediaStub(
  options: { present?: boolean } = {},
): (userId: string, ref: MediaRef) => Promise<{ bytes: Buffer; mimeType: string } | null> {
  return () =>
    Promise.resolve(
      options.present === false
        ? null
        : { bytes: Buffer.from('synthetic-crop-image-bytes'), mimeType: 'image/jpeg' },
    );
}

function diagnosisDeps(
  state: Ledger,
  audit: Audit,
  options: { present?: boolean; burst?: () => Promise<void> } = {},
): DiagnosisDeps {
  const store: DiagnosisStore = {
    insertDiagnosis: () => {
      throw new Error('a diagnosis row was inserted; every exit here is before persistence');
    },
    insertUsageLog: (row) => {
      audit.rows.push(row);
      return Promise.resolve();
    },
    ownsConversation: () => Promise.resolve(true),
  };

  const conversation: Conversation = {
    id: CONVERSATION,
    user_id: USER,
    channel: 'web',
    title: null,
    created_at: '2026-09-16T00:05:00.000Z',
    updated_at: '2026-09-16T00:05:00.000Z',
  };

  const conversations: ConversationStore = {
    mostRecent: () => Promise.resolve(conversation),
    create: () => Promise.resolve(conversation),
  };

  return {
    // Amendment A3: no `supabase` client and no `storage` client — the service reads the image
    // bytes through the owner-scoped Data_Access_Layer seam and sends them to the model inline.
    readMedia: readMediaStub({ present: options.present ?? true }),
    store,
    conversations,
    knowledge,
    models: unreachableModels,
    ...(options.burst === undefined ? {} : { burst: options.burst }),
    quota: { rpc: ledgerRpc(state), now: EARLY_IST },
    now: () => EARLY_IST.getTime(),
    deadlineMs: EARLY_IST.getTime() + 45_000,
    platformDeadline: () => undefined,
  };
}

function chatDeps(
  state: Ledger,
  audit: Audit,
  options: { knowledge?: KnowledgeReader; ownsConversation?: boolean } = {},
): ChatTurnDeps {
  const writes: ChatWriteStore = {
    insertTurn: () => {
      throw new Error('a turn was persisted; the failing exits here are before persistence');
    },
    insertUsageLog: (row) => {
      audit.rows.push(row);
      return Promise.resolve();
    },
    // Amendment A3: the ownership check and the activity bump are owner-scoped by the layer, so
    // both take `(conversationId, userId)`.
    ownsConversation: () => Promise.resolve(options.ownsConversation ?? true),
    touchConversation: () => Promise.resolve(true),
  };

  return {
    // Amendment A3: no `supabase` client — the context read and the writes go through the
    // owner-scoped Data_Access_Layer, scoped by the `userId` on the input.
    writes,
    store: {
      recentMessages: () => Promise.resolve([]),
      latestDiagnosis: () => Promise.resolve(null),
    },
    knowledge: options.knowledge ?? knowledge,
    models: unreachableModels,
    quota: { rpc: ledgerRpc(state), now: EARLY_IST },
    now: () => EARLY_IST.getTime(),
    platformDeadline: () => undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `never_reserved` — no `counter_try_increment` was issued at all, so there was nothing to hand back.
 * `reserve_refused` — one was issued and the atomic statement declined it at the ceiling.
 * `reserve_then_refund` — one was granted and then decremented.
 */
type Mechanism = 'never_reserved' | 'reserve_refused' | 'reserve_then_refund';

interface ExitCase {
  readonly name: string;
  readonly operation: Operation;
  readonly mechanism: Mechanism;
  /** The taxonomy code the farmer's request fails with, or `null` for an exit that succeeded. */
  readonly code: string | null;
  readonly httpStatus?: number;
  /** The `usage_logs.outcome` written, or `null` when the exit is before the first audit write. */
  readonly outcome: string | null;
  /** Runs the exit against the shared ledger. Resolves for a success, rejects for a failure. */
  run: (state: Ledger, audit: Audit) => Promise<unknown>;
}

const PRE_PROVIDER_EXITS: readonly ExitCase[] = [
  {
    // Requirement 2.6, in as many words: 403 AND the counter untouched. The owner-scoped media read
    // is step 1 and the reserve is step 3, so there is no reservation in existence to refund. Under
    // A3 "not this farmer's file" is the owner-scoped read returning `null` — there is no path prefix
    // to parse — which is indistinguishable from "not there" (the next case).
    name: 'an image reference this farmer does not own',
    operation: 'image',
    mechanism: 'never_reserved',
    code: 'STORAGE_REF_FORBIDDEN',
    httpStatus: 403,
    outcome: null,
    run: (state, audit) =>
      diagnose(
        {
          userId: USER,
          image: IMAGE_REF,
          language: 'en',
          channel: 'web',
          conversationId: CONVERSATION,
        },
        diagnosisDeps(state, audit, { present: false }),
      ),
  },
  {
    // Same code as an unowned reference, deliberately: a client cannot tell "not yours" from "not
    // there", so the response is not an oracle for which objects exist. What matters for the spend
    // rule is that both are the same `readMedia: null` at step 1, so neither reaches the counter.
    name: 'an image object that is not there',
    operation: 'image',
    mechanism: 'never_reserved',
    code: 'STORAGE_REF_FORBIDDEN',
    httpStatus: 403,
    outcome: null,
    run: (state, audit) =>
      diagnose(
        {
          userId: USER,
          image: IMAGE_REF,
          language: 'en',
          channel: 'web',
          conversationId: CONVERSATION,
        },
        diagnosisDeps(state, audit, { present: false }),
      ),
  },
  {
    // Requirement 13.8's refusal, which the design's Property 28 places BEFORE the reserve. The row
    // is written by the service rather than by `checkBurst()`, because this is where the request's
    // channel and start instant are known. The image bytes are readable (the farmer owns the file),
    // so the burst check is the exit — not the media read.
    name: 'a burst refusal on the image path',
    operation: 'image',
    mechanism: 'never_reserved',
    code: 'RATE_LIMITED',
    outcome: 'rate_limited',
    run: (state, audit) =>
      diagnose(
        {
          userId: USER,
          image: IMAGE_REF,
          language: 'en',
          channel: 'web',
          conversationId: CONVERSATION,
        },
        diagnosisDeps(state, audit, {
          burst: () => Promise.reject(new AppError('RATE_LIMITED')),
        }),
      ),
  },
  {
    name: 'a chat turn against another farmer’s conversation',
    operation: 'chat',
    mechanism: 'never_reserved',
    code: 'CONVERSATION_NOT_FOUND',
    outcome: null,
    run: (state, audit) =>
      chatTurn(
        {
          userId: USER,
          conversationId: CONVERSATION,
          message: `what should I do about ${CONDITION}`,
          language: 'en',
          channel: 'web',
          inputKind: 'text',
        },
        chatDeps(state, audit, { ownsConversation: false }),
      ),
  },
  {
    // Requirement 14.3. The increment IS attempted — that is how the limit is discovered atomically
    // — and refused, so nothing was taken and nothing is handed back.
    name: 'an image request at the daily limit',
    operation: 'image',
    mechanism: 'reserve_refused',
    code: 'QUOTA_EXCEEDED',
    httpStatus: 429,
    outcome: 'quota_declined',
    run: (state, audit) => {
      fillToLimit(state, 'image');
      return diagnose(
        {
          userId: USER,
          image: IMAGE_REF,
          language: 'en',
          channel: 'web',
          conversationId: CONVERSATION,
        },
        diagnosisDeps(state, audit),
      );
    },
  },
  {
    name: 'a chat request at the daily limit',
    operation: 'chat',
    mechanism: 'reserve_refused',
    code: 'QUOTA_EXCEEDED',
    httpStatus: 429,
    outcome: 'quota_declined',
    run: (state, audit) => {
      fillToLimit(state, 'chat');
      return chatTurn(
        {
          userId: USER,
          conversationId: CONVERSATION,
          message: `what should I do about ${CONDITION}`,
          language: 'en',
          channel: 'web',
          inputKind: 'text',
        },
        chatDeps(state, audit),
      );
    },
  },
  {
    // The one post-reserve pre-provider refundable case that survives Amendment A3. On the image
    // path A3 removed BOTH of the design's first two refundable steps — signed-URL issuance and an
    // unreadable object — because ownership and the bytes are established at step 1 by the
    // owner-scoped media read, BEFORE the reserve, so a failure there is `never_reserved` rather than
    // `reserve_then_refund` (there is no signed URL to mint under A3). The chat path's pre-provider
    // knowledge-base read is still after the reserve, so it remains the `reserve_then_refund`
    // mechanism: reserved, then handed back.
    name: 'a knowledge-base read failure on the chat path',
    operation: 'chat',
    mechanism: 'reserve_then_refund',
    code: 'INTERNAL_ERROR',
    outcome: 'provider_error',
    run: (state, audit) =>
      chatTurn(
        {
          userId: USER,
          conversationId: CONVERSATION,
          message: `what should I do about ${CONDITION}`,
          language: 'en',
          channel: 'web',
          inputKind: 'text',
        },
        chatDeps(state, audit, { knowledge: failingKnowledge }),
      ),
  },
];

/* ========================================================================== */
/* The uniform verdict                                                         */
/* ========================================================================== */

describe('the spend rule over every pre-provider exit', () => {
  it.each(PRE_PROVIDER_EXITS.map((exit) => [exit.name, exit] as const))(
    '%s spends nothing',
    async (_name, exit) => {
      const state = ledger();
      const audit: Audit = { rows: [] };

      await expect(exit.run(state, audit)).rejects.toMatchObject({
        code: exit.code,
        // Requirement 2.6 names the status as well as the untouched counter, so where the taxonomy
        // pins one the row carries it.
        ...(exit.httpStatus === undefined ? {} : { status: exit.httpStatus }),
      });

      // The counter is where it started. For `reserve_refused` that is the ceiling the fixture set;
      // for the others it is zero, which is also where the row began.
      const expectedUsed = exit.mechanism === 'reserve_refused' ? DAILY_QUOTAS[exit.operation] : 0;
      expect(usedIn(state, exit.operation), `${exit.name}: used`).toBe(expectedUsed);

      // Exactly one counter row was ever touched, and it carries no channel component — so an exit
      // cannot quietly spend against a second allowance on the way out.
      expect([...state.rows.keys()].length, `${exit.name}: rows`).toBeLessThanOrEqual(1);

      // …and the audit, where there is one, says the same thing the counter says.
      if (exit.outcome === null) {
        // Before the first audit write: nothing was spent, so there is nothing to attribute.
        expect(audit.rows, `${exit.name}: audit`).toHaveLength(0);
        return;
      }

      expect(audit.rows, `${exit.name}: audit`).toHaveLength(1);
      const row = audit.rows[0] as TablesInsert<'usage_logs'>;
      expect(row.outcome, exit.name).toBe(exit.outcome);
      expect(row.quota_spent, exit.name).toBe(false);
      expect(row.model_provider, exit.name).toBe('none');
      expect(row.operation, exit.name).toBe(exit.operation);
    },
  );

  it.each(PRE_PROVIDER_EXITS.map((exit) => [exit.name, exit] as const))(
    '%s reaches its verdict by the mechanism the rule says',
    async (_name, exit) => {
      const state = ledger();
      const audit: Audit = { rows: [] };

      await expect(exit.run(state, audit)).rejects.toBeInstanceOf(AppError);

      // The distinction a final count of zero cannot make. `never_reserved` issues no
      // `counter_try_increment` at all; `reserve_refused` issues one the statement declines;
      // `reserve_then_refund` issues one and then a `counter_decrement`.
      const traffic = {
        attempted: state.attempted,
        granted: state.granted,
        decrements: state.decrements,
      };

      switch (exit.mechanism) {
        case 'never_reserved':
          expect(traffic, exit.name).toEqual({ attempted: 0, granted: 0, decrements: 0 });
          break;
        case 'reserve_refused':
          expect(traffic, exit.name).toEqual({ attempted: 1, granted: 0, decrements: 0 });
          break;
        case 'reserve_then_refund':
          expect(traffic, exit.name).toEqual({ attempted: 1, granted: 1, decrements: 1 });
          break;
      }
    },
  );

  it('covers all three mechanisms and both operations, so the table is not one case repeated', () => {
    const mechanisms = new Set(PRE_PROVIDER_EXITS.map((exit) => exit.mechanism));
    const operations = new Set(PRE_PROVIDER_EXITS.map((exit) => exit.operation));

    expect([...mechanisms].sort()).toStrictEqual([
      'never_reserved',
      'reserve_refused',
      'reserve_then_refund',
    ]);
    expect([...operations].sort()).toStrictEqual(['chat', 'image']);
    // Every audited outcome the pre-provider set can produce, named once.
    expect(
      [...new Set(PRE_PROVIDER_EXITS.map((exit) => exit.outcome).filter((o) => o !== null))].sort(),
    ).toStrictEqual(['provider_error', 'quota_declined', 'rate_limited']);
  });
});

/* ========================================================================== */
/* Requirement 14.3's decline, end to end from the counter                     */
/* ========================================================================== */

describe('the at-limit decline, as a service produces it', () => {
  it('states the limit and the reset instant the counter itself was keyed on', async () => {
    const state = ledger();
    const audit: Audit = { rows: [] };
    fillToLimit(state, 'image');

    const error = await diagnose(
      {
        userId: USER,
        image: IMAGE_REF,
        language: 'en',
        channel: 'web',
        conversationId: CONVERSATION,
      },
      diagnosisDeps(state, audit),
    ).then(
      () => {
        throw new Error('expected the at-limit reserve to decline');
      },
      (caught: unknown) => caught,
    );

    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) return;

    // The blocks earlier in this file prove `quotaExceededError()` carries these from a `QuotaStatus`.
    // What this adds is that the values a *service* sends outward are the ones its own reserve
    // derived — same clock, same window, no second derivation that could disagree.
    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.status).toBe(429);
    expect(error.details).toEqual({
      limit: DAILY_QUOTAS.image,
      used: DAILY_QUOTAS.image,
      resetsAt: EARLY_IST_RESET,
    });
    expect(quotaStatusSchema.safeParse({ operation: 'image', ...error.details }).success).toBe(true);
  });
});

/* ========================================================================== */
/* The exit that SUCCEEDED before any provider call                            */
/* ========================================================================== */

describe('an out-of-scope chat referral', () => {
  it('reserves and then refunds, rather than never reserving', async () => {
    const state = ledger();
    const audit: Audit = { rows: [] };
    const deps = chatDeps(state, audit);

    // A referral persists both messages, so `insertTurn` has to work on this one path.
    const writes: ChatWriteStore = {
      ...deps.writes,
      insertTurn: (rows) =>
        Promise.resolve([
          messageRowFor(rows[0], '66666666-6666-4666-8666-666666666666'),
          messageRowFor(rows[1], '77777777-7777-4777-8777-777777777777'),
        ]),
    } as ChatWriteStore;

    const result = await chatTurn(
      {
        userId: USER,
        conversationId: CONVERSATION,
        message: 'how is the weather today',
        language: 'en',
        channel: 'web',
        inputKind: 'text',
      },
      { ...deps, writes },
    );

    // The disagreement, settled by counting. Design step 9 lists only failures as refundable, so on
    // its reading this success should never have reserved at all; the biconditional says a unit is
    // spent iff a provider call was attempted, so reserving and handing back is equally correct and
    // is what the code does. `attempted: 1` with `decrements: 1` is the observable difference.
    expect({
      attempted: state.attempted,
      granted: state.granted,
      decrements: state.decrements,
    }).toEqual({ attempted: 1, granted: 1, decrements: 1 });

    // Net effect: nothing spent — a farmer is not charged for being told Jamee does not cover their
    // question — and the count the answer reports agrees with the row.
    expect(usedIn(state, 'chat')).toBe(0);
    expect(result.quota.used).toBe(0);
    expect(result.quota.limit).toBe(DAILY_QUOTAS.chat);
    expect(result.quota.resetsAt).toBe(EARLY_IST_RESET);

    // The audit's half of the biconditional: no provider was reached, so nothing was spent — and the
    // outcome is not a failure, because the request worked.
    expect(audit.rows).toHaveLength(1);
    const row = audit.rows[0] as TablesInsert<'usage_logs'>;
    expect(row.quota_spent).toBe(false);
    expect(row.model_provider).toBe('none');
    expect(row.outcome).toBe('inconclusive');
  });
});

/**
 * The `MessageRecord` (`WithId<MessageDoc>`) a Data_Access_Layer write would have returned, for the
 * referral's persistence seam. Amendment A3: `insertTurn` takes string-shaped `ChatTurnInsert` rows
 * and returns stored documents whose `_id` and `conversationId` are `ObjectId`s. `persistTurn` reads
 * only `role` and `_id.toHexString()`, so the id fields are modelled as the hex-bearing objects the
 * service calls `.toHexString()` on — the test does not import the driver (`check:data-access`).
 */
function messageRowFor(row: MessageInsert, id: string): MessageRecord {
  const objectIdOf = (hex: string) => ({
    toHexString: () => hex,
    toString: () => hex,
  });
  return {
    _id: objectIdOf(id),
    ownerId: row.ownerId,
    conversationId: objectIdOf(row.conversationId),
    role: row.role,
    content: row.content,
    language: row.language,
    channel: row.channel,
    inputKind: row.inputKind,
    transcriptOf: null,
    createdAt: new Date('2026-09-16T01:00:00.000Z'),
  } as unknown as MessageRecord;
}

/* ========================================================================== */
/* The same design clause, one step later in the pipeline                      */
/* ========================================================================== */

describe('a knowledge-base miss on the diagnosis path', () => {
  it('is NOT refunded, because the classification call already happened', async () => {
    const state = ledger();
    const audit: Audit = { rows: [] };

    // The one place in this section where a provider IS called, and it is the point: on the diagnosis
    // path the knowledge lookup is step 8, *after* the classification. Design step 9 lists "a
    // knowledge-base read failure" as refundable without saying where in the pipeline the read sits,
    // and here the biconditional decides again — a provider call was attempted, so the unit stays
    // spent, and Requirement 6.7 makes the resulting inconclusive result cost exactly one.
    const models: CapabilityRunner = {
      classify: () =>
        Promise.resolve({
          value: JSON.stringify({
            status: 'identified',
            disease_name: CONDITION,
            confidence: 0.86,
            severity: 'moderate',
          }),
          provider: 'gemini',
          usedFallback: false,
        }),
      generate: () => {
        throw new Error('no rephrase is reachable without a knowledge-base row');
      },
    };

    const deps: DiagnosisDeps = {
      ...diagnosisDeps(state, audit),
      models,
      // An unseeded deployment: the row for a condition the model named is absent.
      knowledge: () => Promise.resolve([]),
      store: {
        // Amendment A3: `insertDiagnosis` takes a `DiagnosisInsert` document and returns the stored
        // diagnosis id as a hex string (the response and the audit need it), through the
        // owner-scoped Data_Access_Layer — no Supabase row shape, no image_bucket/image_path.
        insertDiagnosis: () => Promise.resolve('8888888888884888a8880011'),
        insertUsageLog: (row) => {
          audit.rows.push(row);
          return Promise.resolve();
        },
        ownsConversation: () => Promise.resolve(true),
      },
    };

    const outcome = await diagnose(
      {
        userId: USER,
        image: IMAGE_REF,
        language: 'en',
        channel: 'web',
        conversationId: CONVERSATION,
      },
      deps,
    );

    expect(outcome.result.status).toBe('unknown');
    // Reserved once, never handed back — the opposite verdict from the chat path's read failure, on
    // the same design clause, because the position in the pipeline is different.
    expect({
      attempted: state.attempted,
      granted: state.granted,
      decrements: state.decrements,
    }).toEqual({ attempted: 1, granted: 1, decrements: 0 });
    expect(usedIn(state, 'image')).toBe(1);

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.quota_spent).toBe(true);
  });
});
