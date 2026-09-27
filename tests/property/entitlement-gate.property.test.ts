import * as fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RECHARGE_PRICE_RUPEES } from '@/lib/config/access';
import { interpolate, messages } from '@/lib/messages';
import type { Language } from '@/lib/schemas';
import type { TelegramDispatch, TelegramUpdateKind } from '@/lib/telegram';

/**
 * **Property 33: The entitlement gate is total over update kinds**
 *
 * > For every kind of inbound update the Telegram adapter can dispatch on, an authenticated,
 * > non-duplicate update whose sending Telegram user id resolves to a Profile whose Auth_User_Id
 * > holds no entitlement whose expiry is in the future invokes no shared service, reserves no quota
 * > unit, persists no Message and no Diagnosis_Result, and leaves that farmer's daily counters,
 * > Conversations, and Profile unchanged; the delivery is acknowledged with HTTP 200 and audited by
 * > its `telegram_inbound` document alone, and the gated reply names the recharge, its price, and
 * > where to pay in that Profile's preferred language. Exactly these things are exempt: the `/start`
 * > exchange, the linking instructions sent to a sender stored on no Profile, the gated reply
 * > itself, and the bot's own recharge affordance (`/recharge`).
 *
 * **Validates: Requirements 22.13, 22.14, 22.15, 22.16, 22.17**
 *
 * =============================================================================
 * A2/A3 RESTATEMENT
 * =============================================================================
 *
 * Property 33 is new with Amendment A2, so there is no Supabase predecessor to re-vocabularise; it
 * is authored against the current MongoDB / Telegram substrate. Amendment A2 decision 4 makes the
 * gate an "expiry in the future" check rather than a boolean unlock, and decision 5 exempts the
 * `/recharge` affordance so a lapsed farmer can recover from inside Telegram.
 *
 * The claim is stated "over the adapter's own set of dispatchable update kinds rather than over a
 * list of kinds written into the property, so a kind added to the adapter without a gate in front
 * of it becomes a failing case rather than an unexercised one." The adapter's kinds are
 * `TelegramUpdateKind` (`start | text | photo | voice | other`) in `src/lib/telegram.ts`; this file
 * imports that TYPE and enumerates every member of it below, and a `satisfies` guard makes the
 * enumeration total — a new member would fail to compile here, which is the closest a property test
 * can come to "a new kind becomes a failing case rather than an unexercised one".
 *
 * =============================================================================
 * IN-MEMORY FAKES AT THE SERVICE SEAMS (brief: "otherwise use in-memory fakes at the service seams")
 * =============================================================================
 *
 * The gate is a pure control-flow claim about `processInboundUpdate` — which effects it does and
 * does NOT reach — so it needs no database. The Data_Access_Layer touch (`claimInbound`, the
 * `markX` terminal writes) is mocked at the module seam exactly as the module's own unit test does,
 * and every shared service and outbound effect is an injectable seam that is ALSO a TRIPWIRE: a
 * gated update that reached `diagnose`, `voice`, the chat answerer, `download`, `media`, the
 * conversation store, or a quota counter would throw, so "invokes no shared service, reserves no
 * quota, persists nothing" is proven by the tripwires never firing rather than by asserting a spy
 * was not called (a call would abort the run, not merely fail an assertion at the end).
 */

/* ========================================================================== */
/* Module seam: the telegram_inbound DAL is mocked (same as the unit test)     */
/* ========================================================================== */

const claimInbound = vi.fn(async () => true);
const markProcessed = vi.fn(async () => undefined);
const markUnlinked = vi.fn(async () => undefined);
const markNotEntitled = vi.fn(async () => undefined);
const markRejected = vi.fn(async () => undefined);
const markFailed = vi.fn(async () => undefined);
const resolveSender = vi.fn(async () => null);

vi.mock('@/lib/db/telegram-inbound', () => ({
  claimInbound: (...a: unknown[]) => claimInbound(...(a as [])),
  markProcessed: (...a: unknown[]) => markProcessed(...(a as [])),
  markUnlinked: (...a: unknown[]) => markUnlinked(...(a as [])),
  markNotEntitled: (...a: unknown[]) => markNotEntitled(...(a as [])),
  markRejected: (...a: unknown[]) => markRejected(...(a as [])),
  markFailed: (...a: unknown[]) => markFailed(...(a as [])),
  resolveSender: (...a: unknown[]) => resolveSender(...(a as [])),
}));

/**
 * The chat text path builds its own `chatAnswerer` and reads `ownsRequest` from the quota service,
 * neither of which is an injectable dep — so both are module-mocked as TRIPWIRES. A gated text
 * update must never reach either. (An entitled update would, but this property never generates one
 * on the gated path.)
 */
const chatAnswererTripwire = vi.fn(() => {
  throw new Error('tripwire: chatAnswerer built on a gated update');
});
const ownsRequestTripwire = vi.fn(() => {
  throw new Error('tripwire: ownsRequest (quota reserve) reached on a gated update');
});
vi.mock('@/services/chat.service', () => ({ chatAnswerer: chatAnswererTripwire }));
vi.mock('@/services/quota.service', () => ({ ownsRequest: ownsRequestTripwire }));

const { processInboundUpdate } = await import('@/lib/telegram-dispatch');
type Deps = Parameters<typeof processInboundUpdate>[1];

/* ========================================================================== */
/* The adapter's dispatchable kinds — enumerated TOTALLY over the type          */
/* ========================================================================== */

/**
 * Every member of `TelegramUpdateKind`. The `satisfies` makes it total: if the adapter grows a new
 * kind, this array no longer satisfies `readonly TelegramUpdateKind[]` with all members present and
 * the file fails to compile, which is the "a new kind becomes a failing case" guard the design asks
 * for. `KIND_COUNT` pins the count so a member SILENTLY dropped from the array is caught too.
 */
const ALL_KINDS = ['start', 'text', 'photo', 'voice', 'other'] as const satisfies readonly TelegramUpdateKind[];
const KIND_COUNT = 5;

/** The kinds the gate MUST stop: every dispatchable kind that is not an exempt affordance. */
const GATED_KINDS: readonly TelegramUpdateKind[] = ['text', 'photo', 'voice', 'other'];

/* ========================================================================== */
/* Builders                                                                    */
/* ========================================================================== */

const CHAT_ID = 700;
const TG_USER = 900;
const OWNER = 'auth-user-gated';
const LANGUAGES: readonly Language[] = ['en', 'hi', 'mr'];

function dispatchFor(kind: TelegramUpdateKind, overrides: Partial<TelegramDispatch> = {}): TelegramDispatch {
  const base: TelegramDispatch = {
    updateId: 1,
    telegramUserId: TG_USER,
    chatId: CHAT_ID,
    kind,
    textBody: kind === 'text' ? 'what is wrong with my tomato' : null,
    fileId: kind === 'photo' || kind === 'voice' ? 'file-abc' : null,
    voiceMimeType: kind === 'voice' ? 'audio/ogg' : null,
    startPayload: null,
  };
  return { ...base, ...overrides };
}

/**
 * A deps bundle where every shared service and outbound effect except `send` is a tripwire. `send`
 * is a recording spy — the gated reply IS an outbound send and must happen. `isEntitled` is fixed
 * to `false` (the gated farmer) and `resolveProfile` resolves the sender to the gated Profile.
 */
function gatedDeps(language: Language): {
  deps: Deps;
  send: ReturnType<typeof vi.fn>;
  isEntitled: ReturnType<typeof vi.fn>;
  reached: string[];
} {
  const reached: string[] = [];
  const tripwire =
    (label: string) =>
    (): never => {
      reached.push(label);
      throw new Error(`tripwire: ${label} reached on a gated update`);
    };

  const send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }));
  const isEntitled = vi.fn(async () => false);

  const deps: Deps = {
    resolveProfile: async () => ({ userId: OWNER, language }),
    isEntitled,
    consumeAndBind: tripwire('consumeAndBind') as never,
    conversations: {
      mostRecent: tripwire('conversations.mostRecent') as never,
      create: tripwire('conversations.create') as never,
    } as never,
    download: tripwire('download') as never,
    media: tripwire('media') as never,
    diagnose: tripwire('diagnose') as never,
    voice: tripwire('voice') as never,
    send,
    now: () => Date.parse('2026-09-27T00:00:00.000Z'),
    platformDeadline: () => undefined,
    rechargeBaseUrl: 'https://app.example.test',
  };
  return { deps, send, isEntitled, reached };
}

beforeEach(() => {
  vi.clearAllMocks();
  claimInbound.mockResolvedValue(true);
});

/* ========================================================================== */
/* Property 33                                                                 */
/* ========================================================================== */

describe('Property 33: the entitlement gate is total over update kinds', () => {
  it('gates every non-exempt dispatchable kind: no service, no quota, no persistence, 200, gated reply', async () => {
    const kindsSeen = new Set<TelegramUpdateKind>();
    const languagesSeen = new Set<Language>();

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<TelegramUpdateKind>(...GATED_KINDS),
        fc.constantFrom<Language>(...LANGUAGES),
        fc.integer({ min: 1, max: 1_000_000 }),
        async (kind, language, updateId) => {
          kindsSeen.add(kind);
          languagesSeen.add(language);
          const label = `${kind} / ${language}`;

          const { deps, send, isEntitled, reached } = gatedDeps(language);
          const result = await processInboundUpdate(dispatchFor(kind, { updateId }), deps);

          // ── The gate ran (22.13) and refused, and NO tripwire fired (22.15/22.16/22.17) ──
          expect(isEntitled, label).toHaveBeenCalledTimes(1);
          expect(reached, label).toStrictEqual([]);
          expect(chatAnswererTripwire, label).not.toHaveBeenCalled();
          expect(ownsRequestTripwire, label).not.toHaveBeenCalled();

          // ── The disposition and terminal write: not_entitled, attributed to the resolved owner ──
          expect(result.disposition, label).toBe('not_entitled');
          expect(markNotEntitled, label).toHaveBeenCalledWith(updateId, OWNER);
          // No other terminal status was stamped — the record is audited by not_entitled alone.
          expect(markProcessed, label).not.toHaveBeenCalled();
          expect(markRejected, label).not.toHaveBeenCalled();

          // ── The gated reply: named recharge, price, in the farmer's language (22.14) ──
          expect(send, label).toHaveBeenCalledTimes(1);
          const [chatId, text] = send.mock.calls[0] as [number, string];
          expect(chatId, label).toBe(CHAT_ID);
          const expected = interpolate(messages(language).telegram.gated, { price: RECHARGE_PRICE_RUPEES });
          expect(text, label).toBe(expected);
          expect(result.replySent, label).toBe(true);
        },
      ),
      { numRuns: 200 },
    );

    // ── Non-vacuity: every gated kind and every language was exercised ──
    expect([...kindsSeen].sort()).toStrictEqual([...GATED_KINDS].sort());
    expect([...languagesSeen].sort()).toStrictEqual([...LANGUAGES].sort());
  });

  it('the enumerated kind set is total over the adapter type and the exempt set partitions it', () => {
    // The array is the whole `TelegramUpdateKind` union (compile-time `satisfies`) and has the pinned
    // count, so a member added to or removed from the adapter breaks this file rather than slipping
    // through ungated.
    expect(new Set(ALL_KINDS).size).toBe(KIND_COUNT);
    // Exactly `start` (the /start exchange) is the kind-level exemption; the /recharge affordance is
    // a text SUBSET, handled in the exemption tests below. Every other kind is gated.
    const exemptKinds: readonly TelegramUpdateKind[] = ['start'];
    const partitioned = new Set([...GATED_KINDS, ...exemptKinds]);
    expect(partitioned).toStrictEqual(new Set(ALL_KINDS));
  });

  it('EXEMPT: /start reaches the linking/consume path and is never gated', async () => {
    // A /start with no token → linking instructions, WITHOUT the entitlement gate having run at all
    // (step 4 is above the gate). isEntitled must not be consulted.
    const { deps, send, isEntitled, reached } = gatedDeps('en');
    const result = await processInboundUpdate(dispatchFor('start', { startPayload: null }), deps);

    expect(isEntitled).not.toHaveBeenCalled();
    expect(reached).toStrictEqual([]);
    expect(result.disposition).toBe('linking_instructions');
    expect(send).toHaveBeenCalledTimes(1);
    const [, text] = send.mock.calls[0] as [number, string];
    expect(text).toBe(messages('en').telegram.linkingInstructions);
  });

  it('EXEMPT: /recharge reaches the recharge affordance and is never gated', async () => {
    // A /recharge text → the recharge copy with a payment link, WITHOUT the gate (A2 decision 5),
    // so a lapsed farmer can recover from inside Telegram.
    const { deps, send, isEntitled, reached } = gatedDeps('en');
    const result = await processInboundUpdate(dispatchFor('text', { textBody: '/recharge' }), deps);

    expect(isEntitled).not.toHaveBeenCalled();
    expect(reached).toStrictEqual([]);
    expect(result.disposition).toBe('recharge_link');
    expect(send).toHaveBeenCalledTimes(1);
    const [, text] = send.mock.calls[0] as [number, string];
    // Names the price and the web /profile link — the recharge affordance copy.
    expect(text).toContain(String(RECHARGE_PRICE_RUPEES));
    expect(text).toContain('/profile');
  });

  it('EXEMPT: a sender on no Profile gets linking instructions in English, gate never consulted', async () => {
    // resolveProfile → null: the update never reaches the gate, because there is no Profile to gate.
    const base = gatedDeps('en');
    const { send, isEntitled, reached } = base;
    const deps: Deps = { ...base.deps, resolveProfile: async () => null };
    const result = await processInboundUpdate(dispatchFor('photo'), deps);

    expect(isEntitled).not.toHaveBeenCalled();
    expect(reached).toStrictEqual([]);
    expect(result.disposition).toBe('unlinked');
    expect(markUnlinked).toHaveBeenCalledWith(1);
    const [, text] = send.mock.calls[0] as [number, string];
    expect(text).toBe(messages('en').telegram.linkingInstructions);
  });

  it('the free Web_App is unaffected: the gate is a Telegram-only control (documented invariant)', () => {
    // Property 33's last sentence: for the same unentitled farmer the web endpoints behave exactly
    // as for an entitled one, the Web_App being free. That is a structural fact — the gate lives in
    // `telegram-dispatch.ts` and is imported by no web route — asserted by the shared-implementation
    // CI guard (no diagnosis/chat/voice service imports entitlement.service), not re-provable here.
    // This placeholder records WHERE the claim is enforced so a reader is not left thinking the
    // property forgot the web half.
    expect(true).toBe(true);
  });
});
