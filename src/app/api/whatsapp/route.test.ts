import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  JAMEE_MAX_DURATION_SECONDS,
  META_SIGNATURE_HEADER,
  META_SIGNATURE_PREFIX,
  PLATFORM_MAX_DURATION_SECONDS,
} from '@/lib/config/verified';
import { ERROR_SPECS } from '@/lib/errors';

import { GET, POST, maxDuration } from './route';

/**
 * Wiring tests for `src/app/api/whatsapp/route.ts`.
 *
 * Requirements: 11.1, 11.2 (the GET handshake), 11.3 (verification precedes the parse), 11.4 (a
 *               failed signature is 401 and invokes nothing), 10.11 (an accepted delivery is
 *               acknowledged with 200)
 * Design: "WhatsApp adapter" → *POST — signature verification over the raw body*
 *
 * `src/lib/whatsapp.test.ts` already covers the primitives — digest encodings, a flipped byte, a
 * re-serialized body, the envelope contract. What can only be tested here is the **route's
 * ordering**, so that is what this file tests, with two tripwires rather than assertions about
 * status codes alone:
 *
 *  1. `parseVerifiedInbound` is spied on. Everything the POST path will ever reach — the
 *     idempotency insert (21.3), media download (22.1), dispatch (22.2) — sits behind it, so
 *     "not parsed" is "no shared service invoked" and stays that way as those tasks land.
 *  2. The request handed to the handler has `json()`, `text()`, `formData()` and `blob()` replaced
 *     with throws. A handler that reads the body any way other than once as bytes fails here
 *     instead of failing in production against a real Meta payload.
 */

/* -------------------------------------------------------------------------- */
/* The parse tripwire                                                          */
/* -------------------------------------------------------------------------- */

const spies = vi.hoisted(() => ({
  parseVerifiedInbound: vi.fn(),
  processInboundBatch: vi.fn(),
}));

/**
 * Partial mock: every export is the real implementation, and `parseVerifiedInbound` is the real
 * implementation behind a counter. Nothing is faked — the module still verifies real HMACs and
 * parses real payloads, so a passing test here is a statement about the code and not about a stub.
 */
vi.mock('@/lib/whatsapp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp')>();
  spies.parseVerifiedInbound.mockImplementation(actual.parseVerifiedInbound);
  return { ...actual, parseVerifiedInbound: spies.parseVerifiedInbound };
});

/**
 * The pipeline is stubbed here, and only here. It writes to Postgres, calls Meta and calls the
 * shared services, so a route test that ran it would be testing `whatsapp-dispatch.ts` through a
 * layer of HTTP — and would need a database to say anything about a status code.
 * `whatsapp-dispatch.test.ts` drives the real pipeline against injected seams.
 *
 * What the stub buys this file is the **second** Requirement 11.4 tripwire: it is the single door
 * to every shared service on this path, so "the dispatch was not called" is a direct statement
 * that no service was invoked, one step closer to the services than the parse spy.
 */
vi.mock('@/lib/whatsapp-dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp-dispatch')>();
  return { ...actual, processInboundBatch: spies.processInboundBatch };
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const APP_SECRET = 'route-test-app-secret-1a2b3c';
const VERIFY_TOKEN = 'route-test-verify-token-9z8y7x';
const CHALLENGE = '1158201444';

/** A confirmed-shape (V12) text delivery, as a literal string so the signed bytes are stable. */
const DELIVERY_RAW = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '102290129340398',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: '106540352242922' },
            contacts: [{ wa_id: '919876543210', profile: { name: 'Anita' } }],
            messages: [
              {
                from: '919876543210',
                id: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgg',
                timestamp: '1758000000',
                type: 'text',
                text: { body: 'mere tamatar ke patte peele ho rahe hain' },
              },
            ],
          },
        },
      ],
    },
  ],
});

/** A signed delivery carrying only a status update — a receipt, not a farmer message (V12). */
const RECEIPT_RAW = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '102290129340398',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: '106540352242922' },
            statuses: [{ id: 'wamid.SENT0001', status: 'delivered' }],
          },
        },
      ],
    },
  ],
});

function signatureFor(raw: string, secret = APP_SECRET): string {
  return `${META_SIGNATURE_PREFIX}${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`;
}

/**
 * A POST request whose only usable body reader is `arrayBuffer()`. The four replaced methods are
 * the ways a handler could interpret a payload it has not verified.
 */
function tripwirePost(raw: string, signature: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (signature !== null) headers.set(META_SIGNATURE_HEADER, signature);

  const request = new Request('https://jamee.test/api/whatsapp', {
    method: 'POST',
    body: raw,
    headers,
  });

  for (const reader of ['json', 'text', 'formData', 'blob'] as const) {
    Object.defineProperty(request, reader, {
      configurable: true,
      value: () => {
        throw new Error(
          `the route called request.${reader}() — the raw bytes must be read once, as bytes, ` +
            'before the signature is verified (Requirement 11.3)',
        );
      },
    });
  }
  return request;
}

function challengeGet(params: Record<string, string>): Request {
  const url = new URL('https://jamee.test/api/whatsapp');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url, { method: 'GET' });
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

let logged: { info: string[]; warn: string[] };

beforeEach(() => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
  spies.parseVerifiedInbound.mockClear();
  spies.processInboundBatch.mockReset();
  spies.processInboundBatch.mockResolvedValue([]);

  // Captured rather than silenced: the handshake rejection reason is required to be logged.
  logged = { info: [], warn: [] };
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    logged.info.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    logged.warn.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_VERIFY_TOKEN;
  vi.restoreAllMocks();
});

/* ========================================================================== */
/* Route segment config                                                        */
/* ========================================================================== */

describe("the route declares Jamee's own duration ceiling", () => {
  it('exports maxDuration as the resolved 60 s, not the platform maximum', () => {
    expect(maxDuration).toBe(JAMEE_MAX_DURATION_SECONDS);
    expect(maxDuration).toBeLessThan(PLATFORM_MAX_DURATION_SECONDS);
  });
});

/* ========================================================================== */
/* GET — the handshake (Requirements 11.1, 11.2)                               */
/* ========================================================================== */

describe('GET /api/whatsapp', () => {
  it('echoes the challenge with 200 when the verify token matches', async () => {
    const response = await GET(
      challengeGet({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': CHALLENGE,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(CHALLENGE);
  });

  it('responds 403 with an empty body and logs the reason when the token differs', async () => {
    const response = await GET(
      challengeGet({
        'hub.mode': 'subscribe',
        'hub.verify_token': `${VERIFY_TOKEN}-wrong`,
        'hub.challenge': CHALLENGE,
      }),
    );

    expect(response.status).toBe(ERROR_SPECS.WEBHOOK_VERIFY_TOKEN_INVALID.status);
    expect(response.status).toBe(403);
    // The caller learns only "no"; the reason is server-side.
    expect(await response.text()).toBe('');
    expect(logged.warn.join('\n')).toContain('verify_token_mismatch');
  });
});

/* ========================================================================== */
/* POST — verification before the parse (Requirements 11.3, 11.4, 10.11)       */
/* ========================================================================== */

describe('POST /api/whatsapp', () => {
  it('reaches the parse, dispatches the farmer message, and acknowledges with 200', async () => {
    const response = await POST(tripwirePost(DELIVERY_RAW, signatureFor(DELIVERY_RAW)));

    expect(response.status).toBe(200);
    expect(spies.parseVerifiedInbound).toHaveBeenCalledTimes(1);
    // The parse ran on the verified bytes, so the delivery's one message was seen.
    expect(logged.info.join('\n')).toContain('"messages":1');

    // Requirement 10.2's input reached the pipeline: the parsed message, not the raw body.
    expect(spies.processInboundBatch).toHaveBeenCalledTimes(1);
    const [batch, deps] = spies.processInboundBatch.mock.calls[0] as [
      readonly { readonly providerMessageId: string; readonly rawType: string }[],
      Record<string, unknown>,
    ];
    expect(batch).toHaveLength(1);
    expect(batch[0]?.rawType).toBe('text');
    expect(batch[0]?.providerMessageId).toBe('wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgg');

    /**
     * **No service seam is overridden.** Requirements 16.1 and 16.2 want the route to have no
     * opinion about how a diagnosis or a chat answer is produced, so the absence of every service
     * key is the assertion: each one the pipeline calls is the pipeline's own default, which is the
     * shared implementation the web routes call.
     *
     * `deadline` is the single exception and it is not a service: it carries *when the invocation
     * started* (D11, Requirement 10.10), a fact only this file can observe, and no implementation
     * choice. The exact key list is asserted rather than a subset, so a future task that quietly
     * injects a `diagnose` here fails this test.
     */
    expect(Object.keys(deps)).toEqual(['deadline']);
    expect(Object.keys(deps.deadline as Record<string, unknown>)).toEqual(['requestStartMs']);
  });

  it("hands the dispatch the invocation's start instant, read before anything else", async () => {
    const request = tripwirePost(DELIVERY_RAW, signatureFor(DELIVERY_RAW));

    /**
     * A counting clock, installed immediately before the call. Asserting the handed-over instant is
     * the clock's **first** reading is what proves it was taken at the top of the handler — ahead of
     * the body read, the HMAC and the parse — rather than wherever the dispatch happens to begin.
     * Requirement 10.10 is about the whole invocation, so a budget that started after verification
     * would be measuring the wrong thing.
     */
    const base = 1_700_000_000_000;
    let tick = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => base + ++tick);

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [, deps] = spies.processInboundBatch.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(deps.deadline).toEqual({ requestStartMs: base + 1 });
    // And the clock was read again on the way out, which is the `elapsedMs` line in the log.
    expect(tick).toBeGreaterThan(1);
  });

  it('returns 401 and invokes nothing when the signature does not verify', async () => {
    const forged = `${META_SIGNATURE_PREFIX}${'0'.repeat(64)}`;
    const response = await POST(tripwirePost(DELIVERY_RAW, forged));

    expect(response.status).toBe(ERROR_SPECS.WEBHOOK_SIGNATURE_INVALID.status);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
    // Requirement 11.4: nothing downstream of verification ran, and the parse is the door to it.
    expect(spies.parseVerifiedInbound).not.toHaveBeenCalled();
    // And the dispatch — the single door to DiagnosisService, ChatService and VoiceService.
    expect(spies.processInboundBatch).not.toHaveBeenCalled();
  });

  it.each([
    ['an absent signature header', null],
    ['a valid digest computed with a different secret', signatureFor(DELIVERY_RAW, 'other-secret')],
    ['a truncated digest', signatureFor(DELIVERY_RAW).slice(0, 40)],
    ['a digest with no sha256= prefix', createHmac('sha256', APP_SECRET).update(DELIVERY_RAW).digest('hex')],
  ])('returns 401 for %s', async (_label, signature) => {
    const response = await POST(tripwirePost(DELIVERY_RAW, signature));

    expect(response.status).toBe(401);
    expect(spies.parseVerifiedInbound).not.toHaveBeenCalled();
  });

  it('acknowledges a signed body that is not JSON with 200 and ignores it', async () => {
    const raw = 'this is signed, and it is not JSON';
    const response = await POST(tripwirePost(raw, signatureFor(raw)));

    // Requirement 10.11: a genuine Meta delivery Jamee cannot act on is still an accepted one.
    expect(response.status).toBe(200);
    expect(spies.parseVerifiedInbound).toHaveBeenCalledTimes(1);
    expect(logged.warn.join('\n')).toContain('body_not_json');
  });

  it('acknowledges a signed payload that is JSON but not the confirmed envelope', async () => {
    const raw = JSON.stringify({ object: 'page', entry: [] });
    const response = await POST(tripwirePost(raw, signatureFor(raw)));

    expect(response.status).toBe(200);
    expect(logged.warn.join('\n')).toContain('envelope_rejected');
  });

  it('acknowledges a delivery receipt without treating it as a farmer message', async () => {
    const response = await POST(tripwirePost(RECEIPT_RAW, signatureFor(RECEIPT_RAW)));

    expect(response.status).toBe(200);
    expect(logged.info.join('\n')).toContain('delivery_receipt.ignored');
    // No claim, no quota, no reply: a receipt has no farmer message id to key any of them on.
    expect(spies.processInboundBatch).not.toHaveBeenCalled();
  });

  it('acknowledges a signed payload Jamee cannot read without dispatching it', async () => {
    const raw = 'signed, and not JSON';
    const response = await POST(tripwirePost(raw, signatureFor(raw)));

    expect(response.status).toBe(200);
    expect(spies.processInboundBatch).not.toHaveBeenCalled();
  });
});
