import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_IMAGE_TYPES,
  META_SIGNATURE_HEADER,
  META_SIGNATURE_PREFIX,
  STORAGE_BUCKETS,
  TRANSCRIBE_ACCEPTED_CONTAINERS,
  WHATSAPP_API_VERSION_PINNED,
  WHATSAPP_TEXT_BODY_MAX_CHARS,
} from '@/lib/config/verified';
import { AppError } from '@/lib/errors';
import { messages } from '@/lib/messages';
import { buildStorageRef, ownerSegmentOf } from '@/lib/storage';
import {
  acceptedSignatureEncodings,
  admitInboundMedia,
  buildTextMessage,
  challengeDecision,
  describeSignatureHeader,
  fetchMediaBinary,
  fetchMediaMetadata,
  inboundMediaCap,
  inboundMediaExtension,
  isAdmissibleInboundMime,
  isDeliveryReceiptOnly,
  isInboundMediaContent,
  META_AUTHORIZATION_HEADER,
  META_BEARER_PREFIX,
  META_SIGNATURE_ENCODING_CANDIDATES,
  META_SIGNATURE_ENCODING_CONFIRMED,
  mediaMetadataUrl,
  metaAuthHeaders,
  parseVerifiedInbound,
  readSignatureHeader,
  respondToChallenge,
  sendMessageUrl,
  sendWhatsappText,
  storeInboundMedia,
  truncateReplyBody,
  verifyInboundRequest,
  verifySignature,
  WHATSAPP_INBOUND_DOCUMENTED_MIME,
  WHATSAPP_INBOUND_MEDIA_SHAPE,
  WHATSAPP_MEDIA_BUCKETS,
  type FetchLike,
  type InboundMediaContent,
  type InboundParse,
  type MediaUploadClientLike,
  type MetaSignatureEncoding,
  type SendFetchLike,
  type StoreInboundMediaOptions,
  type VerifiedRawBody,
  type WhatsappMediaKind,
} from '@/lib/whatsapp';

/**
 * Unit tests for `src/lib/whatsapp.ts`.
 *
 * Requirements: 11.1 (echo the challenge with 200 on a matching verify token), 11.2 (403 on a
 *               differing token), 11.3 (verify the signature over the raw body before the payload
 *               is read as a message)
 * Design: "WhatsApp adapter" → *GET — webhook verification*, *POST — signature verification over
 *         the raw body*
 *
 * The load-bearing case in this file is `a re-serialized body fails`. Every other signature test
 * would also pass an implementation that verified against `JSON.stringify(JSON.parse(raw))`, and
 * that implementation would reject every real delivery from Meta.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const APP_SECRET = 'test-app-secret-9f2c4b';
const VERIFY_TOKEN = 'jamee-verify-token-4f8a1c2d';

/** A confirmed-shape text delivery (V12). Written as a literal string so the bytes are stable. */
const TEXT_DELIVERY_RAW = JSON.stringify({
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

function signatureFor(raw: string, encoding: MetaSignatureEncoding, secret = APP_SECRET): string {
  return `${META_SIGNATURE_PREFIX}${createHmac('sha256', secret).update(raw, 'utf8').digest(encoding)}`;
}

function headersWith(signature: string | null): Headers {
  const headers = new Headers();
  if (signature !== null) headers.set(META_SIGNATURE_HEADER, signature);
  return headers;
}

function challengeUrl(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

/** The only legitimate way to obtain a `VerifiedRawBody` — which is the point of the brand. */
function verified(raw: string): VerifiedRawBody {
  const proof = verifyInboundRequest(headersWith(signatureFor(raw, 'hex')), raw, APP_SECRET);
  if (proof === null) throw new Error('fixture failed to verify; the test setup is wrong');
  return proof;
}

/* ========================================================================== */
/* U-V13 — the encoding is open, and visibly so                                */
/* ========================================================================== */

describe('U-V13: the signature encoding is unresolved and the code says so', () => {
  it('has no confirmed encoding yet, so every candidate is accepted', () => {
    expect(META_SIGNATURE_ENCODING_CONFIRMED).toBeNull();
    expect(acceptedSignatureEncodings()).toEqual([...META_SIGNATURE_ENCODING_CANDIDATES]);
  });

  it.each(META_SIGNATURE_ENCODING_CANDIDATES)('accepts a valid %s digest', (encoding) => {
    expect(verifySignature(TEXT_DELIVERY_RAW, signatureFor(TEXT_DELIVERY_RAW, encoding), APP_SECRET)).toBe(
      true,
    );
  });

  it('reports the observed shape of a header without echoing the digest', () => {
    const hex = describeSignatureHeader(signatureFor(TEXT_DELIVERY_RAW, 'hex'));
    expect(hex).toMatchObject({ present: true, prefixPresent: true, digestLength: 64, looksHex: true });
    expect(hex.matchesEncodingLength).toEqual(['hex']);

    const base64 = describeSignatureHeader(signatureFor(TEXT_DELIVERY_RAW, 'base64'));
    expect(base64).toMatchObject({ present: true, prefixPresent: true, digestLength: 44 });
    expect(base64.matchesEncodingLength).toEqual(['base64']);

    expect(describeSignatureHeader(null)).toMatchObject({ present: false, prefixPresent: false });
  });
});

/* ========================================================================== */
/* Signature verification (Requirement 11.3)                                   */
/* ========================================================================== */

describe('verifySignature', () => {
  it('accepts a digest whose hex casing differs, since hex has two renderings of one value', () => {
    const upper = signatureFor(TEXT_DELIVERY_RAW, 'hex').toUpperCase();
    // The `sha256=` label is uppercased too, which must not matter either.
    expect(verifySignature(TEXT_DELIVERY_RAW, upper, APP_SECRET)).toBe(true);
  });

  it('verifies over raw bytes as well as a string', () => {
    const bytes = new TextEncoder().encode(TEXT_DELIVERY_RAW);
    expect(verifySignature(bytes, signatureFor(TEXT_DELIVERY_RAW, 'hex'), APP_SECRET)).toBe(true);
  });

  it('rejects a flipped byte in the body', () => {
    const signature = signatureFor(TEXT_DELIVERY_RAW, 'hex');
    const tampered = TEXT_DELIVERY_RAW.replace('peele', 'peela');
    expect(tampered).not.toBe(TEXT_DELIVERY_RAW);
    expect(verifySignature(tampered, signature, APP_SECRET)).toBe(false);
  });

  it('rejects a flipped character in the presented digest', () => {
    const signature = signatureFor(TEXT_DELIVERY_RAW, 'hex');
    const lastChar = signature.slice(-1);
    const flipped = `${signature.slice(0, -1)}${lastChar === '0' ? '1' : '0'}`;
    expect(flipped).not.toBe(signature);
    expect(verifySignature(TEXT_DELIVERY_RAW, flipped, APP_SECRET)).toBe(false);
  });

  it('rejects a truncated digest without throwing', () => {
    const signature = signatureFor(TEXT_DELIVERY_RAW, 'hex');
    expect(() => verifySignature(TEXT_DELIVERY_RAW, signature.slice(0, -8), APP_SECRET)).not.toThrow();
    expect(verifySignature(TEXT_DELIVERY_RAW, signature.slice(0, -8), APP_SECRET)).toBe(false);
  });

  it.each([
    ['absent', null],
    ['undefined', undefined],
    ['empty', ''],
    ['prefix only', META_SIGNATURE_PREFIX],
    ['whitespace', '   '],
    ['wrong algorithm label', `sha1=${createHmac('sha1', APP_SECRET).update(TEXT_DELIVERY_RAW).digest('hex')}`],
    ['unprefixed digest', createHmac('sha256', APP_SECRET).update(TEXT_DELIVERY_RAW).digest('hex')],
  ])('rejects a %s header', (_label, header) => {
    expect(verifySignature(TEXT_DELIVERY_RAW, header, APP_SECRET)).toBe(false);
  });

  it('rejects a digest computed with the wrong secret', () => {
    const wrong = signatureFor(TEXT_DELIVERY_RAW, 'hex', 'not-the-app-secret');
    expect(verifySignature(TEXT_DELIVERY_RAW, wrong, APP_SECRET)).toBe(false);
  });

  /**
   * The case that proves raw-body handling matters. The re-serialized body is semantically
   * identical and byte-different, so an implementation that verified against `request.json()`
   * output would pass every other test in this file and reject every real Meta delivery.
   */
  it('rejects a re-serialized body carrying the signature of the original bytes', () => {
    const signature = signatureFor(TEXT_DELIVERY_RAW, 'hex');
    const reSerialized = JSON.stringify(JSON.parse(TEXT_DELIVERY_RAW), null, 2);

    expect(reSerialized).not.toBe(TEXT_DELIVERY_RAW);
    expect(JSON.parse(reSerialized)).toEqual(JSON.parse(TEXT_DELIVERY_RAW));
    expect(verifySignature(reSerialized, signature, APP_SECRET)).toBe(false);
    expect(verifySignature(TEXT_DELIVERY_RAW, signature, APP_SECRET)).toBe(true);
  });

  it('treats an empty app secret as a configuration defect, not a failed signature', () => {
    expect(() => verifySignature(TEXT_DELIVERY_RAW, signatureFor(TEXT_DELIVERY_RAW, 'hex'), '')).toThrow(
      /empty appSecret/,
    );
  });
});

/**
 * ### How "the comparison is constant-time" is checked, and why not by measuring
 *
 * A timing measurement is the obvious test and the wrong one. The two implementations being
 * distinguished — `crypto.timingSafeEqual` over 32-byte digests versus a native string `===` —
 * differ by a handful of nanoseconds on inputs this short, well inside the noise of a JIT warming
 * up on a shared CI runner. A test like that fails randomly and, worse, *passes* randomly for an
 * implementation that leaks.
 *
 * So the property is checked two ways that are both deterministic:
 *
 *  - **Structurally**, in the same spirit as the design's static architecture check: the module
 *    funnels every comparison through one helper, and that helper is the only call site of
 *    `crypto.timingSafeEqual`. That is the invariant a reviewer actually wants — not "this one
 *    call was constant-time" but "no comparison bypasses the primitive".
 *  - **Behaviourally**: a near miss and a far miss are both rejected, and an unequal length is
 *    rejected rather than thrown, which is the observable consequence of the length guard that
 *    `timingSafeEqual` requires.
 */
describe('the digest and token comparisons are constant-time', () => {
  // Read off disk rather than through `import.meta.url`: under the jsdom test environment that
  // value is not a `file:` URL. Vitest runs with the project root as its working directory.
  const moduleSource = readFileSync(join(process.cwd(), 'src', 'lib', 'whatsapp.ts'), 'utf8');

  it('imports the constant-time primitive and calls it from exactly one place', () => {
    expect(moduleSource).toContain("import { createHmac, timingSafeEqual } from 'node:crypto';");

    // `timingSafeEqualStrings(` does not match this pattern, so the count is call sites of the
    // primitive itself. One means the helper is the only door.
    const primitiveCalls = moduleSource.match(/\btimingSafeEqual\(/g) ?? [];
    expect(primitiveCalls).toHaveLength(1);
  });

  it('routes the verify token and both digest candidates through that helper', () => {
    const helperUses = moduleSource.match(/\btimingSafeEqualStrings\(/g) ?? [];
    // The definition, the verify-token comparison, and one comparison per candidate encoding.
    expect(helperUses.length).toBeGreaterThanOrEqual(2 + META_SIGNATURE_ENCODING_CANDIDATES.length);
  });

  it('compares no digest with a plain string equality', () => {
    expect(moduleSource).not.toMatch(/presentedDigest\s*[!=]==/);
    expect(moduleSource).not.toMatch(/[!=]==\s*expected\b/);
    expect(moduleSource).not.toMatch(/presentedToken\s*[!=]==\s*expectedToken/);
  });

  it('rejects a near miss and a far miss alike', () => {
    const digest = signatureFor(TEXT_DELIVERY_RAW, 'hex').slice(META_SIGNATURE_PREFIX.length);
    const flip = (c: string): string => (c === 'a' ? 'b' : 'a');
    const firstCharWrong = `${META_SIGNATURE_PREFIX}${flip(digest[0] ?? 'a')}${digest.slice(1)}`;
    const lastCharWrong = `${META_SIGNATURE_PREFIX}${digest.slice(0, -1)}${flip(digest.slice(-1))}`;

    expect(verifySignature(TEXT_DELIVERY_RAW, firstCharWrong, APP_SECRET)).toBe(false);
    expect(verifySignature(TEXT_DELIVERY_RAW, lastCharWrong, APP_SECRET)).toBe(false);
  });

  it('rejects an unequal length instead of throwing, which is what the length guard is for', () => {
    // `timingSafeEqual` throws on different-length buffers; the leaked fact is the length of a
    // value the caller itself supplied, so guarding here reveals nothing.
    expect(() => verifySignature(TEXT_DELIVERY_RAW, `${META_SIGNATURE_PREFIX}abcd`, APP_SECRET)).not.toThrow();
    expect(verifySignature(TEXT_DELIVERY_RAW, `${META_SIGNATURE_PREFIX}abcd`, APP_SECRET)).toBe(false);
    expect(
      verifySignature(TEXT_DELIVERY_RAW, `${META_SIGNATURE_PREFIX}${'f'.repeat(200)}`, APP_SECRET),
    ).toBe(false);
  });
});

describe('verifyInboundRequest', () => {
  it('reads the V13 header name off the request headers', () => {
    const signature = signatureFor(TEXT_DELIVERY_RAW, 'hex');
    // `Headers` lookup is case-insensitive, which is why the constant is the lowercase form.
    const headers = new Headers({ 'X-Hub-Signature-256': signature });
    expect(readSignatureHeader(headers)).toBe(signature);
    expect(verifyInboundRequest(headers, TEXT_DELIVERY_RAW, APP_SECRET)).not.toBeNull();
  });

  it('returns null for an absent header and for a wrong secret', () => {
    expect(verifyInboundRequest(headersWith(null), TEXT_DELIVERY_RAW, APP_SECRET)).toBeNull();
    expect(
      verifyInboundRequest(
        headersWith(signatureFor(TEXT_DELIVERY_RAW, 'hex', 'other-secret')),
        TEXT_DELIVERY_RAW,
        APP_SECRET,
      ),
    ).toBeNull();
  });

  it('carries the verified bytes inside the proof, so a parse cannot be handed other bytes', () => {
    const proof = verified(TEXT_DELIVERY_RAW);
    expect(proof.raw).toBe(TEXT_DELIVERY_RAW);
  });
});

/* ========================================================================== */
/* GET handshake (Requirements 11.1, 11.2)                                     */
/* ========================================================================== */

describe('the GET verification handshake', () => {
  it('echoes the challenge with 200 on a matching verify token', async () => {
    const decision = challengeDecision(
      challengeUrl({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '1158201444',
      }),
      VERIFY_TOKEN,
    );
    expect(decision).toEqual({ ok: true, challenge: '1158201444' });

    const { response } = respondToChallenge(
      new Request(
        `https://jamee.test/api/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
      ),
      VERIFY_TOKEN,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('1158201444');
  });

  it('responds 403 with an empty body when the token differs', async () => {
    const { response, decision } = respondToChallenge(
      new Request(
        'https://jamee.test/api/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1158201444',
      ),
      VERIFY_TOKEN,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('');
    // The reason stays server-side: an unauthenticated caller learns only "no".
    expect(decision).toEqual({ ok: false, reason: 'verify_token_mismatch' });
  });

  it('rejects a token that differs only in its last character', () => {
    const nearMiss = `${VERIFY_TOKEN.slice(0, -1)}${VERIFY_TOKEN.endsWith('d') ? 'e' : 'd'}`;
    expect(
      challengeDecision(
        challengeUrl({ 'hub.mode': 'subscribe', 'hub.verify_token': nearMiss, 'hub.challenge': 'x' }),
        VERIFY_TOKEN,
      ),
    ).toEqual({ ok: false, reason: 'verify_token_mismatch' });
  });

  it('rejects a token that is a prefix of the configured value', () => {
    expect(
      challengeDecision(
        challengeUrl({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN.slice(0, 8),
          'hub.challenge': 'x',
        }),
        VERIFY_TOKEN,
      ),
    ).toEqual({ ok: false, reason: 'verify_token_mismatch' });
  });

  it.each([
    ['a mode other than subscribe', { 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'x' }, 'mode_not_subscribe'],
    ['an absent mode', { 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'x' }, 'mode_not_subscribe'],
    ['an absent token', { 'hub.mode': 'subscribe', 'hub.challenge': 'x' }, 'verify_token_absent'],
    ['an absent challenge', { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN }, 'challenge_absent'],
  ])('rejects %s', (_label, params, reason) => {
    expect(challengeDecision(challengeUrl(params), VERIFY_TOKEN)).toEqual({ ok: false, reason });
  });

  it('rejects a token of a different length without throwing', () => {
    // The verify token goes through the same length-guarded constant-time comparison as the
    // digest, so a longer or shorter presented token is a plain rejection.
    for (const token of ['', `${VERIFY_TOKEN}x`, VERIFY_TOKEN.slice(0, -1), 'नमस्ते']) {
      const decision = challengeDecision(
        challengeUrl({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': 'x' }),
        VERIFY_TOKEN,
      );
      expect(decision.ok).toBe(false);
    }
  });
});

/* ========================================================================== */
/* Inbound payload (V12 confirmed, U-V12 quarantined)                          */
/* ========================================================================== */

/** Wrap a `value` object in the confirmed envelope so each case states only what it varies. */
function deliveryWith(value: unknown, field = 'messages'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '102290129340398', changes: [{ field, value }] }],
  });
}

const METADATA = {
  display_phone_number: '15550001111',
  phone_number_id: '106540352242922',
} as const;

function messageValue(message: Record<string, unknown>): unknown {
  return {
    messaging_product: 'whatsapp',
    metadata: METADATA,
    contacts: [{ wa_id: '919876543210', profile: { name: 'Anita' } }],
    messages: [
      { from: '919876543210', id: 'wamid.TEST0001', timestamp: '1758000000', ...message },
    ],
  };
}

describe('parseVerifiedInbound — confirmed paths (V12)', () => {
  it('accepts a text message and exposes the WAMID, sender, and body', () => {
    const parse = parseVerifiedInbound(verified(TEXT_DELIVERY_RAW));
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;

    expect(parse.batch.messages).toHaveLength(1);
    const [message] = parse.batch.messages;
    expect(message).toMatchObject({
      providerMessageId: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgg',
      fromPhone: '919876543210',
      rawType: 'text',
      wabaId: '102290129340398',
      phoneNumberId: '106540352242922',
      displayPhoneNumber: '15550001111',
      contactName: 'Anita',
      content: { kind: 'text', body: 'mere tamatar ke patte peele ho rahe hain' },
    });
    expect(parse.batch.statusUpdateCount).toBe(0);
    expect(isDeliveryReceiptOnly(parse.batch)).toBe(false);
  });

  it('normalizes a numeric timestamp rather than rejecting the delivery', () => {
    const parse = parseVerifiedInbound(
      verified(deliveryWith(messageValue({ type: 'text', text: { body: 'hi' }, timestamp: 1758000000 }))),
    );
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.batch.messages[0]?.timestamp).toBe('1758000000');
  });

  it('distinguishes a statuses[] delivery receipt from a messages[] inbound', () => {
    // V12: `field` is "messages" for BOTH, so the discriminator is which array is present.
    const receipt = deliveryWith({
      messaging_product: 'whatsapp',
      metadata: METADATA,
      statuses: [
        { id: 'wamid.OUT0001', status: 'delivered', recipient_id: '919876543210', timestamp: '1758000001' },
      ],
    });
    const parse = parseVerifiedInbound(verified(receipt));
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;

    expect(parse.batch.messages).toEqual([]);
    expect(parse.batch.statusUpdateCount).toBe(1);
    expect(isDeliveryReceiptOnly(parse.batch)).toBe(true);
  });

  it('flattens messages across several entries, as a batched notification arrives', () => {
    const batched = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        { id: 'waba-1', changes: [{ field: 'messages', value: messageValue({ type: 'text', text: { body: 'one' } }) }] },
        { id: 'waba-1', changes: [{ field: 'messages', value: messageValue({ type: 'text', text: { body: 'two' } }) }] },
      ],
    });
    const parse = parseVerifiedInbound(verified(batched));
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.batch.entryCount).toBe(2);
    expect(parse.batch.messages.map((m) => m.content)).toEqual([
      { kind: 'text', body: 'one' },
      { kind: 'text', body: 'two' },
    ]);
  });

  it('skips a change whose field is not messages instead of sinking the delivery', () => {
    const mixed = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            { field: 'message_template_status_update', value: { event: 'APPROVED' } },
            { field: 'messages', value: messageValue({ type: 'text', text: { body: 'still here' } }) },
          ],
        },
      ],
    });
    const parse = parseVerifiedInbound(verified(mixed));
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.batch.ignoredChangeCount).toBe(1);
    expect(parse.batch.messages).toHaveLength(1);
  });

  it('reports an unsupported type separately from a missing confirmed field', () => {
    const sticker = parseVerifiedInbound(
      verified(deliveryWith(messageValue({ type: 'sticker', sticker: { id: '1' } }))),
    );
    expect(sticker.ok).toBe(true);
    if (sticker.ok) {
      expect(sticker.batch.messages[0]?.content).toEqual({
        kind: 'unsupported',
        type: 'sticker',
        reason: 'type_outside_supported_set',
      });
    }

    // A `text` message with no `text.body` contradicts a CONFIRMED path, so it is a payload
    // defect rather than Requirement 10.9's unsupported kind.
    const bodyless = parseVerifiedInbound(verified(deliveryWith(messageValue({ type: 'text' }))));
    expect(bodyless.ok).toBe(true);
    if (bodyless.ok) {
      expect(bodyless.batch.messages[0]?.content).toEqual({
        kind: 'unsupported',
        type: 'text',
        reason: 'confirmed_field_absent',
      });
    }
  });
});

describe('parseVerifiedInbound — malformed input', () => {
  it('reports a body that is not JSON', () => {
    const proof = verifyInboundRequest(
      headersWith(signatureFor('not json at all', 'hex')),
      'not json at all',
      APP_SECRET,
    );
    expect(proof).not.toBeNull();
    if (proof === null) return;
    expect(parseVerifiedInbound(proof)).toMatchObject({ ok: false, reason: 'body_not_json' });
  });

  it.each([
    ['a wrong object literal', { object: 'page', entry: [] }],
    ['an absent entry array', { object: 'whatsapp_business_account' }],
    ['an entry with no id', { object: 'whatsapp_business_account', entry: [{ changes: [] }] }],
  ])('rejects %s', (_label, payload) => {
    const raw = JSON.stringify(payload);
    const proof = verifyInboundRequest(headersWith(signatureFor(raw, 'hex')), raw, APP_SECRET);
    expect(proof).not.toBeNull();
    if (proof === null) return;
    expect(parseVerifiedInbound(proof)).toMatchObject({ ok: false, reason: 'envelope_rejected' });
  });

  it('rejects a messages change whose value is missing the confirmed metadata', () => {
    const raw = deliveryWith({ messaging_product: 'whatsapp', messages: [] });
    const proof = verifyInboundRequest(headersWith(signatureFor(raw, 'hex')), raw, APP_SECRET);
    expect(proof).not.toBeNull();
    if (proof === null) return;
    const parse = parseVerifiedInbound(proof);
    expect(parse.ok).toBe(false);
    if (parse.ok) return;
    expect(parse.reason).toBe('envelope_rejected');
    expect(parse.detail).toContain('metadata');
  });

  it('rejects a WAMID longer than the 128 characters V12 records', () => {
    const raw = deliveryWith(
      messageValue({ type: 'text', text: { body: 'hi' } }),
    ).replace('wamid.TEST0001', `wamid.${'x'.repeat(130)}`);
    const proof = verifyInboundRequest(headersWith(signatureFor(raw, 'hex')), raw, APP_SECRET);
    expect(proof).not.toBeNull();
    if (proof === null) return;
    expect(parseVerifiedInbound(proof)).toMatchObject({ ok: false, reason: 'envelope_rejected' });
  });
});

describe('U-V12: image and audio shapes are provisional and fail loudly', () => {
  it('records that the media shape is unconfirmed', () => {
    expect(WHATSAPP_INBOUND_MEDIA_SHAPE.confirmed).toBe(false);
    expect(WHATSAPP_INBOUND_MEDIA_SHAPE.unresolvedItem).toBe('U-V12');
  });

  it('marks a matching image as provisional rather than verified', () => {
    const parse = parseVerifiedInbound(
      verified(
        deliveryWith(
          messageValue({
            type: 'image',
            image: { id: '1234567890', mime_type: 'image/jpeg', sha256: 'abc', caption: 'patte' },
          }),
        ),
      ),
    );
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.batch.messages[0]?.content).toEqual({
      kind: 'image',
      mediaId: '1234567890',
      mimeType: 'image/jpeg',
      caption: 'patte',
      provisional: true,
    });
  });

  it('marks a matching audio as provisional and carries the voice flag when present', () => {
    const parse = parseVerifiedInbound(
      verified(
        deliveryWith(
          messageValue({ type: 'audio', audio: { id: '999', mime_type: 'audio/ogg', voice: true } }),
        ),
      ),
    );
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.batch.messages[0]?.content).toEqual({
      kind: 'audio',
      mediaId: '999',
      mimeType: 'audio/ogg',
      voice: true,
      provisional: true,
    });
  });

  it.each([
    ['a differently named id field', { media_id: '123', mime_type: 'image/jpeg' }],
    ['a nested media object', { media: { id: '123' } }],
    ['an absent sub-object', undefined],
    ['a bare string', 'image-id-123'],
  ])('fails loudly on %s, reporting the keys that were actually present', (_label, image) => {
    const parse = parseVerifiedInbound(
      verified(deliveryWith(messageValue({ type: 'image', ...(image === undefined ? {} : { image }) }))),
    );
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;

    const content = parse.batch.messages[0]?.content;
    expect(content?.kind).toBe('unconfirmed_media_shape');
    if (content?.kind !== 'unconfirmed_media_shape') return;
    expect(content.type).toBe('image');
    expect(content.issue).toContain('U-V12');
    expect(content.observedKeys).toEqual(
      typeof image === 'object' && image !== null ? Object.keys(image) : [],
    );
  });
});

/* ========================================================================== */
/* V14 — media retrieval, admission, and the service-role upload (task 22.1)    */
/* ========================================================================== */

/**
 * Requirements: 10.4 (download from the Cloud API, store in `crop-images`, hand on the reference),
 *               10.6 (the same for audio and `voice-messages`), 13.6 (the object stays under the
 *               owning farmer's path prefix, which is what makes it readable by that farmer's own
 *               session later)
 * Depends on: V14
 *
 * `fetch` is stubbed rather than mocked globally, through the `fetchImpl` seam, so each test can
 * assert **which requests were issued and with what headers** — which is the substance of V14: the
 * flow is two requests, and the second one carries the same Bearer token as the first.
 */

const ACCESS_TOKEN = 'EAAG-test-access-token';
const FARMER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
const OBJECT_ID = '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b';
const MEDIA_ID = '1554478744769234';
const MEDIA_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1554478744769234';

interface StubbedCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;
}

interface StubbedResponse {
  readonly status?: number;
  readonly json?: unknown;
  readonly body?: Uint8Array;
  readonly contentType?: string | null;
}

/** A `fetch` that answers a scripted queue and records every call it received. */
function stubFetch(script: readonly StubbedResponse[]): {
  fetchImpl: FetchLike;
  calls: StubbedCall[];
} {
  const calls: StubbedCall[] = [];
  let index = 0;

  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers });
    const step = script[index];
    index += 1;
    if (step === undefined) {
      throw new Error(`stubFetch received an unscripted call ${index} to ${url}`);
    }

    const status = step.status ?? 200;
    const headers = new Headers();
    if (step.contentType !== undefined && step.contentType !== null) {
      headers.set('content-type', step.contentType);
    }

    if (step.json !== undefined) {
      headers.set('content-type', 'application/json');
      return Promise.resolve(new Response(JSON.stringify(step.json), { status, headers }));
    }
    if (step.body !== undefined) {
      // A detached copy of the view's bytes: `Uint8Array<ArrayBufferLike>` is not a `BodyInit`,
      // and a `Uint8Array` built in a test always sits on a real `ArrayBuffer`.
      const buffer = step.body.buffer.slice(
        step.body.byteOffset,
        step.body.byteOffset + step.body.byteLength,
      ) as ArrayBuffer;
      return Promise.resolve(new Response(buffer, { status, headers }));
    }
    return Promise.resolve(new Response(null, { status, headers }));
  };

  return { fetchImpl, calls };
}

function metadataBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    id: MEDIA_ID,
    url: MEDIA_URL,
    mime_type: 'image/jpeg',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb924',
    file_size: 1024,
    ...overrides,
  };
}

interface RecordedUpload {
  readonly bucket: string;
  readonly path: string;
  readonly bytes: number;
  readonly contentType: string | undefined;
  readonly upsert: boolean | undefined;
}

function stubUploadClient(error: unknown = null): {
  client: MediaUploadClientLike;
  uploads: RecordedUpload[];
} {
  const uploads: RecordedUpload[] = [];
  const client: MediaUploadClientLike = {
    storage: {
      from: (bucket) => ({
        upload: (path, body, options) => {
          uploads.push({
            bucket,
            path,
            bytes: body.byteLength,
            contentType: options?.contentType,
            upsert: options?.upsert,
          });
          return Promise.resolve({ data: error === null ? { path } : null, error });
        },
      }),
    },
  };
  return { client, uploads };
}

function imageContent(overrides: Partial<InboundMediaContent> = {}): InboundMediaContent {
  return {
    kind: 'image',
    mediaId: MEDIA_ID,
    mimeType: 'image/jpeg',
    provisional: true,
    ...overrides,
  } as InboundMediaContent;
}

function audioContent(overrides: Record<string, unknown> = {}): InboundMediaContent {
  return {
    kind: 'audio',
    mediaId: MEDIA_ID,
    mimeType: 'audio/ogg',
    voice: true,
    provisional: true,
    ...overrides,
  } as InboundMediaContent;
}

function storeOptions(
  content: InboundMediaContent,
  fetchImpl: FetchLike,
  client: MediaUploadClientLike,
): StoreInboundMediaOptions {
  return {
    content,
    userId: FARMER_ID,
    language: 'en',
    accessToken: ACCESS_TOKEN,
    apiVersion: 'v26.0',
    fetchImpl,
    client,
    now: new Date('2026-09-14T08:30:00.000Z'),
    objectId: OBJECT_ID,
  };
}

describe('V14: the two-step retrieval carries the Bearer header on BOTH requests', () => {
  it('issues step 1 then step 2, each with Authorization: Bearer', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: metadataBody() },
      { body: new Uint8Array([0xff, 0xd8, 0xff, 0xdb]), contentType: 'image/jpeg' },
    ]);
    const { client, uploads } = stubUploadClient();

    const result = await storeInboundMedia(storeOptions(imageContent(), fetchImpl, client));

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);

    // Step 1 is the media id against the pinned Graph version.
    expect(calls[0]?.url).toBe(`https://graph.facebook.com/v26.0/${MEDIA_ID}`);
    // Step 2 is the URL step 1 handed back — never a URL this module constructed.
    expect(calls[1]?.url).toBe(MEDIA_URL);

    for (const call of calls) {
      expect(call.method).toBe('GET');
      expect(call.headers?.[META_AUTHORIZATION_HEADER]).toBe(
        `${META_BEARER_PREFIX}${ACCESS_TOKEN}`,
      );
    }
    expect(uploads).toHaveLength(1);
  });

  it('appends the V12-confirmed phone_number_id to step 1 when the delivery carried one', () => {
    expect(
      mediaMetadataUrl(MEDIA_ID, { apiVersion: 'v26.0', phoneNumberId: '106540352242922' }),
    ).toBe(`https://graph.facebook.com/v26.0/${MEDIA_ID}?phone_number_id=106540352242922`);

    expect(mediaMetadataUrl(MEDIA_ID, { apiVersion: 'v26.0' })).toBe(
      `https://graph.facebook.com/v26.0/${MEDIA_ID}`,
    );
  });

  it('refuses to build the header without a token, because step 2 fails without one', () => {
    expect(() => metaAuthHeaders('')).toThrow(/BOTH media steps/);
    expect(metaAuthHeaders(ACCESS_TOKEN)).toEqual({
      [META_AUTHORIZATION_HEADER]: `${META_BEARER_PREFIX}${ACCESS_TOKEN}`,
    });
  });

  /**
   * V14: *omitting the token fails*. A stub that answers 401 whenever the header is absent is the
   * only way a unit test can hold the real provider's rule, and the point is that the failure is
   * surfaced rather than swallowed as an empty download.
   */
  it('treats a step 2 request without the token as a failure', async () => {
    const calls: StubbedCall[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push({ url, method: init?.method, headers: init?.headers });
      const authorized = init?.headers?.[META_AUTHORIZATION_HEADER] !== undefined;
      if (url.startsWith('https://graph.facebook.com')) {
        return Promise.resolve(
          new Response(JSON.stringify(metadataBody()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: authorized ? 200 : 401 }));
    };

    // A caller that strips the header — which is exactly the mistake V14 warns about.
    const stripped: FetchLike = (url, init) =>
      url.startsWith('https://graph.facebook.com')
        ? fetchImpl(url, init)
        : fetchImpl(url, { method: 'GET' });

    await expect(
      fetchMediaBinary({ id: MEDIA_ID, url: MEDIA_URL, mimeType: 'image/jpeg', fileSize: 8 }, MEDIA_ID, {
        accessToken: ACCESS_TOKEN,
        apiVersion: 'v26.0',
        fetchImpl: stripped,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('V14: size is checked from step 1, so an oversized item costs no download', () => {
  it('refuses an oversized image on file_size alone, with no second request', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: metadataBody({ file_size: 6 * 1024 * 1024 }) },
    ]);
    const { client, uploads } = stubUploadClient();

    const result = await storeInboundMedia(storeOptions(imageContent(), fetchImpl, client));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('too_large');
    // The whole claim of this task's third bullet: one small JSON request, and nothing else.
    expect(calls).toHaveLength(1);
    expect(uploads).toHaveLength(0);
    // Meta's 5 MB inbound image cap is tighter than Jamee's 10 MB, so it is the one quoted.
    expect(result.refusal.capBytes).toBe(5 * 1024 * 1024);
    expect(result.refusal.capOwner).toBe('meta');
    expect(result.refusal.reply).toContain('5 MB');
  });

  it('admits an item at exactly the cap and refuses the byte above it', () => {
    const cap = inboundMediaCap('image').bytes;
    expect(
      admitInboundMedia({ kind: 'image', mimeType: 'image/jpeg', bytes: cap, language: 'en' }),
    ).toBeNull();
    expect(
      admitInboundMedia({ kind: 'image', mimeType: 'image/jpeg', bytes: cap + 1, language: 'en' }),
    ).toMatchObject({ reason: 'too_large' });
    // An unknown size cannot be refused for size — it is refused after the download instead.
    expect(
      admitInboundMedia({ kind: 'audio', mimeType: 'audio/ogg', bytes: undefined, language: 'en' }),
    ).toBeNull();
  });

  it('takes the tighter of Jamee\u2019s rule and V14\u2019s cap in each direction', () => {
    // image: V14's 5 MB beats Jamee's 10 MB.
    expect(inboundMediaCap('image')).toEqual({ bytes: 5 * 1024 * 1024, owner: 'meta' });
    // audio: Jamee's 10 MB beats V14's 16 MB.
    expect(inboundMediaCap('audio')).toEqual({ bytes: 10 * 1024 * 1024, owner: 'jamee' });
  });

  it('refuses an audio object over Jamee\u2019s own 10 MB rule even though Meta allows 16 MB', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: metadataBody({ mime_type: 'audio/ogg', file_size: 12 * 1024 * 1024 }) },
    ]);
    const { client, uploads } = stubUploadClient();

    const result = await storeInboundMedia(storeOptions(audioContent(), fetchImpl, client));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('too_large');
    expect(result.refusal.capOwner).toBe('jamee');
    expect(calls).toHaveLength(1);
    expect(uploads).toHaveLength(0);
  });

  it('re-checks the downloaded length, because file_size is a claim', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: metadataBody({ file_size: 1024 }) },
      {
        body: new Uint8Array(6 * 1024 * 1024),
        contentType: 'image/jpeg',
      },
    ]);
    const { client, uploads } = stubUploadClient();

    const result = await storeInboundMedia(storeOptions(imageContent(), fetchImpl, client));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('too_large');
    expect(calls).toHaveLength(2);
    expect(uploads).toHaveLength(0);
  });
});

describe('V14: an unsupported content type is refused with a plain-language reply', () => {
  it('refuses an image type outside the web path\u2019s accepted set', async () => {
    const { fetchImpl, calls } = stubFetch([{ json: metadataBody({ mime_type: 'image/gif' }) }]);
    const { client, uploads } = stubUploadClient();

    const result = await storeInboundMedia(storeOptions(imageContent(), fetchImpl, client));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('content_type_unsupported');
    expect(calls).toHaveLength(1);
    expect(uploads).toHaveLength(0);
    // The web path's own localized sentence, so the two channels cannot disagree on the limit.
    expect(result.refusal.reply).toBe(messages('en').errors.FILE_TYPE_UNSUPPORTED.replace('{maxMb}', '5'));
  });

  it('admits exactly the web path\u2019s image types and V10\u2019s audio containers', () => {
    for (const type of ACCEPTED_IMAGE_TYPES) {
      expect(isAdmissibleInboundMime('image', type)).toBe(true);
    }
    expect(isAdmissibleInboundMime('image', 'image/gif')).toBe(false);

    // V14's documented inbound image set is a SUBSET of Jamee's, so nothing is lost.
    for (const type of WHATSAPP_INBOUND_DOCUMENTED_MIME.image) {
      expect(isAdmissibleInboundMime('image', type)).toBe(true);
    }

    for (const container of TRANSCRIBE_ACCEPTED_CONTAINERS) {
      expect(isAdmissibleInboundMime('audio', `audio/${container}`)).toBe(true);
    }
  });

  /**
   * The V10-versus-V14 discrepancy, asserted rather than papered over: V14 says WhatsApp delivers
   * `aac` and `amr`, V10's accepted container list does not contain either, and this module refuses
   * them **before the download** rather than letting the transcription adapter refuse afterwards.
   */
  it.each(['audio/aac', 'audio/amr'])(
    'refuses %s before any byte is fetched, and tells the farmer to type instead',
    async (mimeType) => {
      const { fetchImpl, calls } = stubFetch([{ json: metadataBody({ mime_type: mimeType }) }]);
      const { client, uploads } = stubUploadClient();

      const result = await storeInboundMedia(storeOptions(audioContent(), fetchImpl, client));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.reason).toBe('voice_container_unsupported');
      expect(calls).toHaveLength(1);
      expect(uploads).toHaveLength(0);

      // Not Requirement 10.9's "Jamee accepts ... voice notes", which would be untrue here, and
      // not TRANSCRIPTION_FAILED, whose retryable flag would be a lie.
      expect(result.refusal.reply).toBe(messages('en').whatsapp.voiceNoteFormatUnsupported);
      expect(result.refusal.reply).not.toBe(messages('en').whatsapp.unsupportedType);
      expect(result.refusal.reply).not.toBe(messages('en').errors.TRANSCRIPTION_FAILED);

      // And V10's list is NOT widened to make V14's sentence true.
      expect(TRANSCRIBE_ACCEPTED_CONTAINERS as readonly string[]).not.toContain('aac');
      expect(TRANSCRIBE_ACCEPTED_CONTAINERS as readonly string[]).not.toContain('amr');
      expect(
        (WHATSAPP_INBOUND_DOCUMENTED_MIME.audio as readonly string[]).includes(mimeType),
      ).toBe(true);
    },
  );

  it('localizes the refusal reply from the resolved profile\u2019s language', async () => {
    const { fetchImpl } = stubFetch([{ json: metadataBody({ mime_type: 'audio/amr' }) }]);
    const { client } = stubUploadClient();

    const result = await storeInboundMedia({
      ...storeOptions(audioContent(), fetchImpl, client),
      language: 'mr',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reply).toBe(messages('mr').whatsapp.voiceNoteFormatUnsupported);
  });
});

describe('Requirement 13.6: the upload carries the farmer\u2019s prefix, derived by buildStorageRef', () => {
  it('writes crop-images under {user_id}/ with a path buildStorageRef produced', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);
    const { fetchImpl } = stubFetch([
      { json: metadataBody() },
      { body: bytes, contentType: 'image/jpeg' },
    ]);
    const { client, uploads } = stubUploadClient();

    const result = await storeInboundMedia(storeOptions(imageContent(), fetchImpl, client));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expected = buildStorageRef({
      bucket: STORAGE_BUCKETS.cropImages,
      userId: FARMER_ID,
      extension: 'jpg',
      now: new Date('2026-09-14T08:30:00.000Z'),
      objectId: OBJECT_ID,
    });

    // Not "a path that looks right": the same path the browser uploader's builder produces.
    expect(result.ref).toEqual(expected);
    expect(result.ref.bucket).toBe(STORAGE_BUCKETS.cropImages);
    // Requirement 13.6 / V4: the first segment is the owner, and it is what the RLS predicate
    // `(storage.foldername(name))[1]` compares — so a WhatsApp object is readable by its owner.
    expect(ownerSegmentOf(result.ref.path)).toBe(FARMER_ID);

    expect(uploads).toEqual([
      {
        bucket: STORAGE_BUCKETS.cropImages,
        path: expected.path,
        bytes: bytes.byteLength,
        contentType: 'image/jpeg',
        upsert: false,
      },
    ]);
  });

  it('writes an audio object to voice-messages under the same prefix', async () => {
    const { fetchImpl } = stubFetch([
      { json: metadataBody({ mime_type: 'audio/ogg', file_size: 4 }) },
      { body: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), contentType: 'audio/ogg' },
    ]);
    const { client, uploads } = stubUploadClient();

    const result = await storeInboundMedia(storeOptions(audioContent(), fetchImpl, client));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ref.bucket).toBe(STORAGE_BUCKETS.voiceMessages);
    expect(ownerSegmentOf(result.ref.path)).toBe(FARMER_ID);
    expect(result.ref.path.endsWith('.ogg')).toBe(true);
    expect(result.mimeType).toBe('audio/ogg');
    expect(uploads[0]?.bucket).toBe(STORAGE_BUCKETS.voiceMessages);
  });

  it('maps each kind to the bucket Requirements 10.4 and 10.6 name', () => {
    expect(WHATSAPP_MEDIA_BUCKETS).toEqual({
      image: STORAGE_BUCKETS.cropImages,
      audio: STORAGE_BUCKETS.voiceMessages,
    });
  });

  it('keeps step 1\u2019s mime_type when step 2 answers a generic octet-stream', async () => {
    const { fetchImpl } = stubFetch([
      { json: metadataBody({ mime_type: 'image/png' }) },
      { body: new Uint8Array([0x89, 0x50]), contentType: 'application/octet-stream' },
    ]);
    const { client, uploads } = stubUploadClient();

    const result = await storeInboundMedia(storeOptions(imageContent(), fetchImpl, client));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A generic type says nothing about the bytes, so it must not refuse a real photo.
    expect(result.mimeType).toBe('image/png');
    expect(result.ref.path.endsWith('.png')).toBe(true);
    expect(uploads[0]?.contentType).toBe('image/png');
  });

  it('surfaces an upload failure rather than reporting a stored object', async () => {
    const { fetchImpl } = stubFetch([
      { json: metadataBody() },
      { body: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' },
    ]);
    const { client } = stubUploadClient({ message: 'bucket not found' });

    await expect(
      storeInboundMedia(storeOptions(imageContent(), fetchImpl, client)),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('V14: a 404 follows the documented recovery', () => {
  it('re-requests the media URL once, then succeeds on the fresh URL', async () => {
    const freshUrl = `${MEDIA_URL}&retry=1`;
    const { fetchImpl, calls } = stubFetch([
      { json: metadataBody() },
      { status: 404 },
      { json: metadataBody({ url: freshUrl }) },
      { body: new Uint8Array([0xff, 0xd8]), contentType: 'image/jpeg' },
    ]);
    const { client, uploads } = stubUploadClient();

    const result = await storeInboundMedia(storeOptions(imageContent(), fetchImpl, client));

    expect(result.ok).toBe(true);
    // The recovery V14 documents: re-request the media URL. A 5-minute URL that expired between
    // the two steps is the likely cause, so the retry is on a freshly minted URL.
    expect(calls.map((call) => call.url)).toEqual([
      `https://graph.facebook.com/v26.0/${MEDIA_ID}`,
      MEDIA_URL,
      `https://graph.facebook.com/v26.0/${MEDIA_ID}`,
      freshUrl,
    ]);
    expect(uploads).toHaveLength(1);
  });

  it('surfaces a second 404 as a failure naming the token renewal, and stores nothing', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: metadataBody() },
      { status: 404 },
      { json: metadataBody() },
      { status: 404 },
    ]);
    const { client, uploads } = stubUploadClient();

    const failure = await storeInboundMedia(
      storeOptions(imageContent(), fetchImpl, client),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    if (!(failure instanceof AppError)) return;
    expect(failure.code).toBe('INTERNAL_ERROR');
    expect(failure.context?.reason).toBe('whatsapp_media_binary_not_found');
    // Exactly one re-request: a second 404 on a fresh URL is the token case, not a loop.
    expect(String(failure.context?.recovery)).toContain('WHATSAPP_ACCESS_TOKEN');
    expect(calls).toHaveLength(4);
    expect(uploads).toHaveLength(0);
  });

  it('does not retry a non-404 step 2 failure', async () => {
    const { fetchImpl, calls } = stubFetch([{ json: metadataBody() }, { status: 500 }]);
    const { client } = stubUploadClient();

    await expect(
      storeInboundMedia(storeOptions(imageContent(), fetchImpl, client)),
    ).rejects.toBeInstanceOf(AppError);
    expect(calls).toHaveLength(2);
  });

  it('surfaces a step 1 rejection without attempting a download', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 401 }]);

    await expect(
      fetchMediaMetadata(MEDIA_ID, {
        accessToken: ACCESS_TOKEN,
        apiVersion: 'v26.0',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(calls).toHaveLength(1);
  });

  it('accepts file_size as a number or a numeric string, per V14\u2019s confirmed field', async () => {
    for (const fileSize of [2048, '2048']) {
      const { fetchImpl } = stubFetch([{ json: metadataBody({ file_size: fileSize }) }]);
      const metadata = await fetchMediaMetadata(MEDIA_ID, {
        accessToken: ACCESS_TOKEN,
        apiVersion: 'v26.0',
        fetchImpl,
      });
      expect(metadata.fileSize).toBe(2048);
      expect(metadata.url).toBe(MEDIA_URL);
    }
  });

  it('rejects a step 1 body with no url or mime_type rather than guessing', async () => {
    const { fetchImpl } = stubFetch([{ json: { id: MEDIA_ID, file_size: 10 } }]);

    await expect(
      fetchMediaMetadata(MEDIA_ID, {
        accessToken: ACCESS_TOKEN,
        apiVersion: 'v26.0',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('U-V12: the download path runs only on a provisional media result', () => {
  it('narrows only the two provisional members', () => {
    expect(isInboundMediaContent(imageContent())).toBe(true);
    expect(isInboundMediaContent(audioContent())).toBe(true);
    expect(isInboundMediaContent({ kind: 'text', body: 'hello' })).toBe(false);
    expect(
      isInboundMediaContent({
        kind: 'unconfirmed_media_shape',
        type: 'image',
        observedKeys: ['media_id'],
        issue: 'U-V12',
      }),
    ).toBe(false);
    expect(
      isInboundMediaContent({
        kind: 'unsupported',
        type: 'sticker',
        reason: 'type_outside_supported_set',
      }),
    ).toBe(false);
  });

  it('fails loudly on an absent media id rather than requesting an empty path', async () => {
    const { fetchImpl, calls } = stubFetch([]);
    const { client } = stubUploadClient();

    await expect(
      storeInboundMedia(storeOptions(imageContent({ mediaId: '   ' }), fetchImpl, client)),
    ).rejects.toThrow(/U-V12/);
    // Nothing was requested: an unresolved field name is a capture signal, not a fetch.
    expect(calls).toHaveLength(0);
  });

  it('still records the media shape as unconfirmed, which is a precondition on this path', () => {
    expect(WHATSAPP_INBOUND_MEDIA_SHAPE.confirmed).toBe(false);
  });
});

describe('the storage extension is derived, not guessed', () => {
  it.each([
    ['image', 'image/jpeg', 'jpg'],
    ['image', 'image/png', 'png'],
    ['image', 'image/webp', 'webp'],
    ['audio', 'audio/ogg', 'ogg'],
    ['audio', 'audio/mpeg', 'mpeg'],
    ['audio', 'audio/mp4', 'mp4'],
    ['audio', 'audio/webm;codecs=opus', 'webm'],
  ])('maps %s %s to .%s', (kind, mimeType, extension) => {
    expect(inboundMediaExtension(kind as WhatsappMediaKind, mimeType)).toBe(extension);
  });

  it('throws on an image type with no extension mapping, because that is a Jamee defect', () => {
    expect(() => inboundMediaExtension('image', 'image/gif')).toThrow(/ACCEPTED_IMAGE_TYPES/);
  });
});

/* ========================================================================== */
/* V15 — the send-message call                                                 */
/* ========================================================================== */

interface SendCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** A `SendFetchLike` that records the request and answers with a canned response. */
function stubSendFetch(
  response: { status?: number; json?: unknown; text?: string } = {},
): { fetchImpl: SendFetchLike; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const status = response.status ?? 200;

  const fetchImpl: SendFetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });

    if (response.text !== undefined) {
      return new Response(response.text, { status });
    }
    return new Response(
      JSON.stringify(
        response.json ?? {
          messaging_product: 'whatsapp',
          contacts: [{ input: '919876543210', wa_id: '919876543210' }],
          messages: [{ id: 'wamid.OUTBOUND001' }],
        },
      ),
      { status, headers: { 'content-type': 'application/json' } },
    );
  };

  return { fetchImpl, calls };
}

const SEND_OPTIONS = {
  to: '919876543210',
  phoneNumberId: '106540352242922',
  accessToken: 'send-test-token',
} as const;

describe('V15: the send endpoint, headers and body', () => {
  it('POSTs to /{version}/{PHONE_NUMBER_ID}/messages with the Bearer and JSON headers', async () => {
    const { fetchImpl, calls } = stubSendFetch();

    const result = await sendWhatsappText({ ...SEND_OPTIONS, body: 'hello', fetchImpl });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(
      `https://graph.facebook.com/${WHATSAPP_API_VERSION_PINNED}/106540352242922/messages`,
    );
    // The same Bearer header the two media steps use, built by the same one function.
    expect(calls[0]?.headers[META_AUTHORIZATION_HEADER]).toBe(
      `${META_BEARER_PREFIX}send-test-token`,
    );
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('sends exactly V15\u2019s text body shape', () => {
    expect(buildTextMessage('919876543210', 'hello')).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'text',
      // `preview_url: false` is stated, not omitted: a citation can contain a URL and an
      // unrequested link preview is content Jamee did not write.
      text: { body: 'hello', preview_url: false },
    });
  });

  it('reads messages[].id back but does not require it', async () => {
    const withId = stubSendFetch();
    await expect(
      sendWhatsappText({ ...SEND_OPTIONS, body: 'hi', fetchImpl: withId.fetchImpl }),
    ).resolves.toEqual({ ok: true, sentMessageId: 'wamid.OUTBOUND001', bodyChars: 2 });

    // A 200 with a shape Jamee cannot read is still a handed-over message: reporting a failure
    // would mark a delivered reply as undelivered.
    const withoutId = stubSendFetch({ json: { messaging_product: 'whatsapp' } });
    await expect(
      sendWhatsappText({ ...SEND_OPTIONS, body: 'hi', fetchImpl: withoutId.fetchImpl }),
    ).resolves.toEqual({ ok: true, sentMessageId: null, bodyChars: 2 });
  });

  it('reports a rejected send instead of throwing, and keeps the payload out of the reply', async () => {
    const { fetchImpl } = stubSendFetch({
      status: 400,
      text: '{"error":{"message":"Recipient phone number not in allowed list"}}',
    });

    const result = await sendWhatsappText({ ...SEND_OPTIONS, body: 'hi', fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    // Meta's own text reaches the SERVER log, which is what an operator needs to act on. Nothing
    // in the pipeline renders this to a farmer — the reply copy comes from the catalogs.
    expect(result.detail).toContain('allowed list');
  });

  it('reports a transport failure rather than throwing', async () => {
    const fetchImpl: SendFetchLike = () => Promise.reject(new Error('ECONNRESET'));

    const result = await sendWhatsappText({ ...SEND_OPTIONS, body: 'hi', fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBeNull();
    expect(result.detail).toContain('ECONNRESET');
  });

  it('honours WHATSAPP_API_VERSION over the pinned version', async () => {
    const { fetchImpl, calls } = stubSendFetch();

    await sendWhatsappText({ ...SEND_OPTIONS, body: 'hi', apiVersion: 'v99.0', fetchImpl });

    expect(calls[0]?.url.startsWith('https://graph.facebook.com/v99.0/')).toBe(true);
  });
});

describe('V15: the 4096-character body cap', () => {
  it('leaves a body inside the cap untouched, to the character', () => {
    const exact = 'x'.repeat(WHATSAPP_TEXT_BODY_MAX_CHARS);

    expect(truncateReplyBody(exact)).toBe(exact);
    expect(truncateReplyBody('short')).toBe('short');
  });

  it('cuts an over-long body to the cap and marks the cut', () => {
    const long = 'x'.repeat(WHATSAPP_TEXT_BODY_MAX_CHARS + 500);
    const cut = truncateReplyBody(long);

    // Exceeding the cap would be answered with a rejected send, so the farmer would receive
    // NOTHING. A tail that is missing is strictly better than that.
    expect(cut).toHaveLength(WHATSAPP_TEXT_BODY_MAX_CHARS);
    expect(cut.endsWith('\u2026')).toBe(true);
  });

  it('applies the cap inside buildTextMessage, so no caller can forget it', () => {
    const message = buildTextMessage('919876543210', 'x'.repeat(WHATSAPP_TEXT_BODY_MAX_CHARS * 2));

    expect(message.text.body).toHaveLength(WHATSAPP_TEXT_BODY_MAX_CHARS);
  });

  it('cuts Devanagari copy by the same rule, because that is where the cap actually bites', () => {
    // Hindi and Marathi spend characters faster than English for the same content, so a grounded
    // diagnosis in Devanagari is the realistic over-cap case rather than a synthetic one.
    const long = '\u092A'.repeat(WHATSAPP_TEXT_BODY_MAX_CHARS + 1);

    expect(truncateReplyBody(long)).toHaveLength(WHATSAPP_TEXT_BODY_MAX_CHARS);
  });
});

describe('a send call that is a defect rather than a failure throws', () => {
  it('refuses an empty recipient, an empty body and an empty phone number id', () => {
    expect(() => buildTextMessage('', 'hi')).toThrow(/empty recipient/);
    // Every reply branch owes the farmer a sentence, so an empty one is a caller defect.
    expect(() => buildTextMessage('919876543210', '   ')).toThrow(/empty body/);
    expect(() => sendMessageUrl('  ')).toThrow(/empty phone number id/);
  });

  it('refuses an empty access token, so no send can be issued unauthenticated', () => {
    expect(() => metaAuthHeaders('')).toThrow(/empty access token/);
  });
});
/* ========================================================================== */
/* Task 21.4 — the forgery classes one body and one mutation cannot reach       */
/* ========================================================================== */

/**
 * A second confirmed-shape (V12) delivery, written as a literal for the same reason the first one
 * is: the bytes have to be stable, because a signature is computed over them.
 *
 * It exists so this file can state the one case a mutation test structurally cannot: **a signature
 * that is valid, over a different body**. Every rejection above is a variation on one payload, and
 * a verifier that ignored the body altogether — one comparing against `HMAC(secret, '')`, say —
 * would pass all of them. Only a second well-formed delivery separates "the digest is checked" from
 * "the digest is checked against *these* bytes".
 */
const OTHER_DELIVERY_RAW = JSON.stringify({
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
            contacts: [{ wa_id: '919876500011', profile: { name: 'Ravi' } }],
            messages: [
              {
                from: '919876500011',
                id: 'wamid.HBgMOTE5ODc2NTAwMDExFQIAEhgg',
                timestamp: '1758000900',
                type: 'text',
                text: { body: 'kapus pikavar kide disat aahet' },
              },
            ],
          },
        },
      ],
    },
  ],
});

const VALID_HEX_HEADER = signatureFor(TEXT_DELIVERY_RAW, 'hex');
const VALID_BASE64_HEADER = signatureFor(TEXT_DELIVERY_RAW, 'base64');
const VALID_HEX_DIGEST = VALID_HEX_HEADER.slice(META_SIGNATURE_PREFIX.length);
const VALID_BASE64_DIGEST = VALID_BASE64_HEADER.slice(META_SIGNATURE_PREFIX.length);

/**
 * The same 32 bytes rendered as unpadded base64url. Neither accepted candidate spells a digest this
 * way, and it is the rendering a caller reaching for "URL-safe base64" produces by accident.
 */
function asUnpaddedBase64Url(base64Digest: string): string {
  return base64Digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Re-case one letter of a base64 digest.
 *
 * This is the sharp end of "hex is compared case-insensitively, base64 exactly": hex has two
 * renderings of the same bytes and base64 does not, so a re-cased base64 digest names **different
 * bytes** and must be refused even though a re-cased hex digest is accepted.
 */
function withOneLetterRecased(digest: string): string {
  const index = [...digest].findIndex((char) => /[A-Za-z]/.test(char));
  if (index === -1) throw new Error('fixture: this base64 digest carries no letter to re-case');
  const char = digest[index] as string;
  const flipped = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
  return `${digest.slice(0, index)}${flipped}${digest.slice(index + 1)}`;
}

describe('Requirement 11.3: every signature a caller can choose is refused but the right one', () => {
  it.each([
    ['a valid hex signature over a different, equally well-formed delivery', signatureFor(OTHER_DELIVERY_RAW, 'hex')],
    ['a valid base64 signature over a different delivery', signatureFor(OTHER_DELIVERY_RAW, 'base64')],
    // The configuration mixup with a real chance of happening: both values are WhatsApp secrets,
    // and only one of them keys this HMAC.
    ['a digest keyed with the verify token instead of the app secret', signatureFor(TEXT_DELIVERY_RAW, 'hex', VERIFY_TOKEN)],
    ['a hex digest of the right length carrying the wrong bytes', `${META_SIGNATURE_PREFIX}${'0'.repeat(64)}`],
    ['a base64 digest of the right length carrying the wrong bytes', `${META_SIGNATURE_PREFIX}${'A'.repeat(43)}=`],
    ['the correct digest re-rendered as unpadded base64url', `${META_SIGNATURE_PREFIX}${asUnpaddedBase64Url(VALID_BASE64_DIGEST)}`],
    ['the correct base64 digest with one letter re-cased', `${META_SIGNATURE_PREFIX}${withOneLetterRecased(VALID_BASE64_DIGEST)}`],
    ['the correct digest behind a repeated prefix', `${META_SIGNATURE_PREFIX}${META_SIGNATURE_PREFIX}${VALID_HEX_DIGEST}`],
    ['the correct digest padded away from the prefix', `${META_SIGNATURE_PREFIX} ${VALID_HEX_DIGEST}`],
    // A header carrying two candidates is not a list to search: one correct member does not admit it.
    ['two comma-joined signatures, one of them correct', `${VALID_HEX_HEADER},${VALID_HEX_HEADER}`],
    ['the correct digest with four characters appended', `${VALID_HEX_HEADER}dead`],
  ])('refuses %s', (_label, header) => {
    expect(verifySignature(TEXT_DELIVERY_RAW, header, APP_SECRET)).toBe(false);
  });

  it.each([
    ['a trailing newline appended after signing', `${TEXT_DELIVERY_RAW}\n`],
    ['a WAMID mutated after signing', TEXT_DELIVERY_RAW.replace('FQIAEhgg', 'FQIAEhgh')],
    ['a different delivery entirely', OTHER_DELIVERY_RAW],
  ])('refuses a correct signature replayed against %s', (_label, body) => {
    expect(body).not.toBe(TEXT_DELIVERY_RAW);
    expect(verifySignature(body, VALID_HEX_HEADER, APP_SECRET)).toBe(false);
    // Non-vacuity: the same header still verifies over the bytes it was computed from, so the
    // rejection above is about the body and not about a broken fixture.
    expect(verifySignature(TEXT_DELIVERY_RAW, VALID_HEX_HEADER, APP_SECRET)).toBe(true);
  });

  it('accepts each rendering of the digest the secret really produces', () => {
    expect(verifySignature(TEXT_DELIVERY_RAW, VALID_HEX_HEADER, APP_SECRET)).toBe(true);
    expect(verifySignature(TEXT_DELIVERY_RAW, VALID_BASE64_HEADER, APP_SECRET)).toBe(true);
    // Whitespace around the header is stripped (`presented.trim()`), which a proxy or a hand-built
    // curl can introduce; whitespace *inside* it is not, per the padded case above.
    expect(verifySignature(TEXT_DELIVERY_RAW, `  ${VALID_HEX_HEADER}\t`, APP_SECRET)).toBe(true);
  });

  it('refuses a request whose header signs a different body, and admits the one it signs', () => {
    const otherSignature = signatureFor(OTHER_DELIVERY_RAW, 'hex');

    expect(
      verifyInboundRequest(headersWith(otherSignature), TEXT_DELIVERY_RAW, APP_SECRET),
    ).toBeNull();
    expect(
      verifyInboundRequest(headersWith(otherSignature), OTHER_DELIVERY_RAW, APP_SECRET),
    ).not.toBeNull();
  });
});

/**
 * ### Requirement 11.4's ordering, as this module can state it
 *
 * "Verification precedes parsing, profile resolution, and every service call" is two claims, and
 * they are checked in the two places they are decidable:
 *
 *  - **Nothing in this module can resolve a profile or call a service at all.** That is stronger
 *    than an ordering: admission imports no service and reads no `profiles` row, so there is no
 *    call site whose position could be wrong. The route's own ordering — verify, then dispatch — is
 *    driven end to end by `src/app/api/whatsapp/route.test.ts` and by
 *    `tests/property/webhook.property.test.ts`, which assert an empty service ledger on refusal.
 *  - **The payload cannot be read without the proof.** The brand is a module-private symbol
 *    constructed in exactly one place, after the signature check, and the webhook schema is not
 *    exported — so parsing before verifying is a compile error rather than a review comment.
 */
describe('Requirement 11.4: verification precedes parsing, profile resolution, and every service', () => {
  const moduleSource = readFileSync(join(process.cwd(), 'src', 'lib', 'whatsapp.ts'), 'utf8');

  it('imports no domain service, no dispatch, and reads no profile row', () => {
    // Anchored at a line start so the prose above `storeInboundMedia`, which names
    // `whatsapp-dispatch.ts` as the module that resolves a profile, is not read as an import.
    expect(moduleSource).not.toMatch(/^import .*'@\/services\//m);
    expect(moduleSource).not.toMatch(/^import .*whatsapp-dispatch/m);
    expect(moduleSource).not.toMatch(/\.from\('profiles'\)/);
  });

  it('keeps the proof brand module-private and constructs it in exactly one place', () => {
    expect(moduleSource).toMatch(/^const VERIFIED = Symbol\(/m);
    expect(moduleSource).not.toMatch(/export const VERIFIED/);

    // Two occurrences: the field on `VerifiedRawBody`, and the single construction site.
    const marks = moduleSource.match(/\[VERIFIED\]: true/g) ?? [];
    expect(marks).toHaveLength(2);
  });

  it('constructs the proof only after the signature check', () => {
    const guard = moduleSource.indexOf('if (!verifySignature(rawBody, header, appSecret)) return null;');
    const construction = moduleSource.indexOf('return { [VERIFIED]: true, raw: rawBody };');

    expect(guard).toBeGreaterThan(-1);
    expect(construction).toBeGreaterThan(guard);
  });

  it('exports no schema that could parse an unverified body', () => {
    expect(moduleSource).toMatch(/^const whatsappWebhookSchema = /m);
    expect(moduleSource).not.toMatch(/export const whatsappWebhookSchema/);
  });

  it('cannot be handed a hand-built proof, which is what makes the order a type error', () => {
    /**
     * Never invoked, and that is the point: the assertion is the `@ts-expect-error` directive
     * itself. `npm run typecheck` fails in both directions — if the illegal call starts compiling
     * (the brand stopped being required, so an unverified body could be parsed), and if the
     * directive becomes unused. A runtime expectation could not state either.
     */
    const parseWithoutVerifying = (): InboundParse =>
      // @ts-expect-error Requirement 11.3 — `VerifiedRawBody` carries a module-private brand, so
      // the only way to obtain one is `verifyInboundRequest`. If this line ever compiles, a caller
      // can read a payload whose signature was never checked.
      parseVerifiedInbound({ raw: TEXT_DELIVERY_RAW });

    expect(typeof parseWithoutVerifying).toBe('function');
  });
});
