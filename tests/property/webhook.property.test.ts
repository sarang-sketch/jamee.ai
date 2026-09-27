import * as fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { COLLECTIONS, type TelegramInboundDoc } from '@/lib/db/collections';
import { TELEGRAM_SECRET_TOKEN_HEADER, verifySecretToken } from '@/lib/telegram';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from '../integration/mongo';

/**
 * **Property 23: The webhook rejects everything it cannot authenticate, and processes each delivery once**
 *
 * > For any value in the `X-Telegram-Bot-Api-Secret-Token` header and any body, no part of that body
 * > is parsed as an update until the header has been compared in constant time against the
 * > configured Webhook_Secret_Token; an absent header, a wrong value, and an unconfigured token each
 * > yield 401 with no part of the body parsed and no shared service invoked; and no other means of
 * > authenticating a delivery exists. For any sequence of authenticated deliveries, including
 * > concurrent redeliveries of one `update_id`, that update is processed at most once: its
 * > `update_id` is claimed in `telegram_inbound` as a single `insertOne` with `_id` equal to the
 * > `update_id`, whose duplicate-key error (11000) on an already-claimed id *is* the duplicate
 * > signal — never a read-then-write — and every repeat is acknowledged 200 with no service call and
 * > no quota change.
 *
 * **Validates: Requirements 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8**
 *
 * =============================================================================
 * A3 RESTATEMENT — WHAT THIS FILE USED TO ASSERT, AND WHAT IT NOW ASSERTS
 * =============================================================================
 *
 * Amendment A1 already moved this property off WhatsApp's Meta webhook (a GET verify-token challenge
 * plus an HMAC over the raw body) onto Telegram's `X-Telegram-Bot-Api-Secret-Token` (D12): there is
 * NO body digest, so authenticity is a constant-time secret-token comparison and the body may be
 * read with `request.json()` AFTER it. Amendment A3 then re-expresses the single-processing claim
 * over MongoDB: the `update_id` idempotency is an `insertOne` with `_id = update_id` whose `11000`
 * duplicate-key error is the duplicate signal (`claimTelegramUpdate` in `src/lib/db/farmer.ts`),
 * replacing the Supabase `usage_logs`/`whatsapp_inbound` unique-row claim.
 *
 * This file therefore has two halves, each over the substrate the brief names:
 *
 *  - **Secret-token-before-parse** is a claim about `dispatchTelegramRequest` in
 *    `src/lib/telegram-dispatch.ts` and `verifySecretToken` in `src/lib/telegram.ts`. It is pure
 *    (no database): every failing header value must produce `authenticated: false` WITHOUT the
 *    request body ever being read — proven by a `Request` whose `.json()`/`.text()` are tripwires
 *    that throw if touched, so a parse-before-auth aborts the run rather than merely failing a spy
 *    assertion.
 *
 *  - **The `update_id` insertOne claim** is a claim about a real unique `_id` and concurrent inserts,
 *    which only a real MongoDB can establish (an in-memory Map serialises itself). The brief permits
 *    the update_id-idempotency half to run against the real layer; this file does, at numRuns ≈ 25.
 */

let harness: MongoHarness | undefined;
type Farmer = typeof import('@/lib/db/farmer');
let farmer: Farmer;
let setupDatabase: typeof import('@/lib/db/setup').setupDatabase;

const REAL_LAYER_RUNS = 25;

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  farmer = await import('@/lib/db/farmer');
  ({ setupDatabase } = await import('@/lib/db/setup'));
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  if (harness) await clearDatabase(harness.db);
});

function db() {
  if (harness === undefined) throw new Error('harness not started');
  return harness.db;
}

/* ========================================================================== */
/* The secret-token-before-parse half (pure)                                   */
/* ========================================================================== */

const CONFIGURED = 'the-one-configured-webhook-secret-token';

/**
 * A `Request` whose body readers are TRIPWIRES: reading the body before the header has been checked
 * throws, so a parse-before-auth defect aborts the run. `dispatchTelegramRequest` is imported here
 * (it reads no env when the header check fails first) and driven with the header set to each value.
 */
function tripwireRequest(headerValue: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (headerValue !== null) headers.set(TELEGRAM_SECRET_TOKEN_HEADER, headerValue);
  const req = new Request('https://jamee.test/api/telegram', { method: 'POST', headers, body: '{}' });
  // Shadow the body readers on the instance with tripwires — an own property overrides the
  // prototype method, and `req.headers` (a private-field getter) is left untouched, so the auth
  // check reads the header normally but any body read throws.
  const tripwire = (name: string) => () => {
    throw new Error(`tripwire: request.${name}() was called before the secret token was verified`);
  };
  Object.defineProperties(req, {
    json: { value: tripwire('json'), configurable: true },
    text: { value: tripwire('text'), configurable: true },
    arrayBuffer: { value: tripwire('arrayBuffer'), configurable: true },
    formData: { value: tripwire('formData'), configurable: true },
    blob: { value: tripwire('blob'), configurable: true },
  });
  return req;
}

describe('Property 23 (auth): the secret token is compared before the body is parsed', () => {
  it('an absent, wrong, or byte-flipped header yields authenticated:false with the body never read', async () => {
    // Mock the inbound DAL so an accidental fall-through to the pipeline cannot touch the database;
    // but the point is the tripwire request body: on a failed auth, dispatch returns before parsing.
    vi.resetModules();
    process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = CONFIGURED;
    const { dispatchTelegramRequest } = await import('@/lib/telegram-dispatch');

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'absent' | 'wrong' | 'flip' | 'empty'>('absent', 'wrong', 'flip', 'empty'),
        fc.string({ maxLength: 40 }),
        async (variant, noise) => {
          let header: string | null;
          if (variant === 'absent') header = null;
          else if (variant === 'empty') header = '';
          else if (variant === 'wrong') header = `not-the-token-${noise}`;
          else {
            // flip the last char of the configured token
            const last = CONFIGURED.at(-1) as string;
            header = CONFIGURED.slice(0, -1) + (last === 'n' ? 'm' : 'n');
          }

          const outcome = await dispatchTelegramRequest(tripwireRequest(header));
          expect(outcome.authenticated, variant).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('verifySecretToken itself: only the exact configured token passes; absent and empty fail', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (candidate) => {
        const headers = new Headers();
        headers.set(TELEGRAM_SECRET_TOKEN_HEADER, candidate);
        const expected = candidate === CONFIGURED;
        expect(verifySecretToken(headers, CONFIGURED)).toBe(expected);
      }),
      { numRuns: 200 },
    );

    // Absent header and unconfigured (empty) secret both fail.
    expect(verifySecretToken(new Headers(), CONFIGURED)).toBe(false);
    const withHeader = new Headers();
    withHeader.set(TELEGRAM_SECRET_TOKEN_HEADER, CONFIGURED);
    expect(verifySecretToken(withHeader, '')).toBe(false);
  });
});

/* ========================================================================== */
/* The update_id insertOne claim half (real layer)                            */
/* ========================================================================== */

describe('Property 23 (idempotency): the update_id insertOne claim processes each delivery once', () => {
  it('any number of concurrent claims of one update_id succeed exactly once; one telegram_inbound row', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 2, max: 6 }),
        fc.constantFrom<'text' | 'photo' | 'voice' | 'other'>('text', 'photo', 'voice', 'other'),
        async (updateId, deliveries, messageType) => {
          await clearDatabase(db());

          // Fire N concurrent claims of the SAME update_id — Telegram redelivers on a non-200.
          const claims = await Promise.all(
            Array.from({ length: deliveries }, () =>
              farmer.claimTelegramUpdate(updateId, 12345, messageType),
            ),
          );

          // Exactly one claim wins; the rest see the 11000 duplicate-key and return false.
          const wonCount = claims.filter((c) => c === true).length;
          expect(wonCount, 'exactly one claim wins the insertOne').toBe(1);

          // Exactly one telegram_inbound document, keyed on _id = the update_id.
          const rows = await db()
            .collection<TelegramInboundDoc>(COLLECTIONS.telegramInbound)
            .find({ _id: updateId })
            .toArray();
          expect(rows.length).toBe(1);
          expect(rows[0]?._id).toBe(updateId);
          expect(rows[0]?.messageType).toBe(messageType);
          expect(rows[0]?.status).toBe('received');
        },
      ),
      { numRuns: REAL_LAYER_RUNS },
    );
  });

  it('distinct update_ids each claim independently; a re-claim of a settled id still returns false', async () => {
    await clearDatabase(db());
    // Two distinct ids both claim.
    expect(await farmer.claimTelegramUpdate(1, 1, 'text')).toBe(true);
    expect(await farmer.claimTelegramUpdate(2, 1, 'photo')).toBe(true);
    // A settled id (moved to a terminal status) is STILL a duplicate on re-claim — the claim is the
    // insertOne, and the row already exists whatever its status.
    await farmer.setTelegramInboundStatus(1, 'processed', 'owner-1');
    expect(await farmer.claimTelegramUpdate(1, 1, 'text')).toBe(false);
    expect(await db().collection(COLLECTIONS.telegramInbound).countDocuments({})).toBe(2);
  });
});
