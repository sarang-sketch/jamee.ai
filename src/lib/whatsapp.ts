import 'server-only';

import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import {
  ACCEPTED_IMAGE_TYPES,
  graphApiBase,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  META_CHALLENGE_PARAMS,
  META_CHALLENGE_SUBSCRIBE_MODE,
  META_SIGNATURE_ALGORITHM,
  META_SIGNATURE_HEADER,
  META_SIGNATURE_PREFIX,
  STORAGE_BUCKETS,
  WHATSAPP_API_VERSION_PINNED,
  WHATSAPP_INBOUND_MAX_BYTES,
  WHATSAPP_TEXT_BODY_MAX_CHARS,
  type AcceptedImageType,
  type StorageBucket,
} from '@/lib/config/verified';
import { optionalServerEnv, serverEnv } from '@/lib/env';
import { AppError, ERROR_SPECS, toEnvelope } from '@/lib/errors';
import { isAcceptedAudioContainer, normalizeAudioContainer } from '@/lib/groq';
import { messages } from '@/lib/messages';
import type { Language, StorageRef } from '@/lib/schemas';
import { buildStorageRef } from '@/lib/storage';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * WhatsApp webhook admission: the GET handshake, the POST signature, and the inbound payload
 * contract. Nothing in this module talks to a farmer, a provider, or the database — it decides
 * only whether a request is Meta's, and what Meta said.
 *
 * Requirements: 11.1 (a GET carrying the configured verify token echoes the challenge with 200),
 *               11.2 (a differing verify token gets 403),
 *               11.3 (a POST signature is verified against `WHATSAPP_APP_SECRET` **before** the
 *               payload is read as a message)
 * Design: "WhatsApp adapter" → *GET — webhook verification*, *POST — signature verification over
 *         the raw body*, *Inbound processing order* step 1
 * Depends on: V12 (pinned Meta version and the confirmed inbound field paths), V13 (header name,
 *             `sha256=` prefix, HMAC-SHA256 keyed with the App Secret, constant-time compare)
 *
 * ### THE ORDER IS ENFORCED BY THE TYPES, NOT BY A COMMENT
 *
 * Requirement 11.3 is an *ordering* requirement and Requirement 11.4 is its consequence: on a
 * signature failure, no shared service may be invoked. A comment saying "verify first" is worth
 * nothing on the day someone adds a second POST path. So the only function in this module that
 * interprets a payload — `parseVerifiedInbound` — takes a `VerifiedRawBody`, and the only way to
 * obtain one is `verifyInboundRequest`. The brand is a module-private symbol, so a caller cannot
 * construct the proof without going through the check, and no schema is exported that would let
 * one parse an unverified body instead. Getting the order wrong is a type error.
 *
 * ### TWO THINGS ARE NOT RESOLVED, AND NEITHER IS GUESSED HERE
 *
 * **U-V13 — the digest's byte encoding (hex vs. base64) is not stated in Meta's documentation.**
 * A wrong encoding rejects **every legitimate webhook**: the HMAC would be right and the string
 * comparison would still fail, so the symptom is a webhook that never works while every log line
 * says "invalid signature". Rather than pick one silently, the accepted encodings are a single
 * named constant (`META_SIGNATURE_ENCODING_CONFIRMED`) which is `null` until a real delivery
 * settles it, and while it is `null` both candidates are compared. Narrowing it later is a
 * one-line edit. See `describeSignatureHeader` for the deployment-time capture.
 *
 * **U-V12 — the per-type sub-object paths for inbound IMAGE and AUDIO are not confirmed.** The
 * envelope and the text path are (V12). Meta's per-type reference pages 404, so the media shape
 * below is marked PROVISIONAL, every media result carries `provisional: true` at the type level,
 * and a media object that does not match the provisional shape resolves to
 * `unconfirmed_media_shape` carrying the keys that were actually present — which is the one log
 * line the deployment capture needs. Nothing here pretends `messages[].image.id` is verified.
 *
 * ### THE SECOND HALF OF THIS MODULE IS MEDIA RETRIEVAL (V14)
 *
 * Everything above decides whether a request is Meta's and what Meta said. Everything below
 * *acts* on what Meta said, for the two message kinds that carry bytes rather than text: the
 * two-step media retrieval, the admission checks, and the service-role upload under the resolved
 * farmer's prefix. It is in the same file because it reads the same provisional media shape — see
 * `storeInboundMedia` for how U-V12 stays quarantined on that path too.
 */

/* ========================================================================== */
/* Confirmed inbound envelope constants (V12)                                  */
/* ========================================================================== */

/**
 * These three live here rather than in `config/verified.ts` on purpose: they are the *shape* of
 * one server-only payload, read by this module alone, and `verified.ts` is deliberately
 * client-importable and shared by every other adapter. Each still carries its V-item, because the
 * rule that matters is that a third-party value is traceable to the row that resolved it — not
 * which file it sits in.
 */

/** **V12.** `object` is exactly this on an inbound WhatsApp webhook. */
export const META_WEBHOOK_OBJECT = 'whatsapp_business_account';

/**
 * **V12.** `entry[].changes[].field` is `messages` for BOTH a farmer-originated message and a
 * business-originated status update, so the field value cannot be the discriminator. The
 * discriminator is the presence of `value.messages[]` versus `value.statuses[]` — see
 * `isDeliveryReceiptOnly`.
 */
export const META_WEBHOOK_FIELD_MESSAGES = 'messages';

/** **V12.** The WAMID at `value.messages[].id` is capped at 128 characters. */
export const WAMID_MAX_CHARS = 128;

/* ========================================================================== */
/* U-V13 — the digest encoding                                                 */
/* ========================================================================== */

export const META_SIGNATURE_ENCODING_CANDIDATES = ['hex', 'base64'] as const;
export type MetaSignatureEncoding = (typeof META_SIGNATURE_ENCODING_CANDIDATES)[number];

/**
 * **The single visible place where U-V13 is open.**
 *
 * `null` means: *not confirmed against a real signed delivery yet*. While it is `null`,
 * `verifySignature` compares the presented digest against every candidate in
 * `META_SIGNATURE_ENCODING_CANDIDATES`.
 *
 * **Set this to the observed encoding during deployment, before enforcement is relied on.** The
 * type is `MetaSignatureEncoding | null` rather than `null` so that narrowing is a value edit and
 * not a type change.
 *
 * Accepting two encodings until then is not a weakened check. Both candidates are renderings of
 * the *same* HMAC-SHA256 digest keyed with the App Secret; producing either still requires the
 * secret, so the work an attacker must do is unchanged. What it buys is that the wrong guess
 * cannot silently reject every legitimate delivery.
 */
export const META_SIGNATURE_ENCODING_CONFIRMED: MetaSignatureEncoding | null = null;

/** The encodings `verifySignature` will accept: the confirmed one, or every candidate. */
export function acceptedSignatureEncodings(): readonly MetaSignatureEncoding[] {
  return META_SIGNATURE_ENCODING_CONFIRMED === null
    ? META_SIGNATURE_ENCODING_CANDIDATES
    : [META_SIGNATURE_ENCODING_CONFIRMED];
}

/* ========================================================================== */
/* U-V12 — the media sub-object shape                                          */
/* ========================================================================== */

/**
 * Status of the unconfirmed media paths, exported so a reader — and task 22.1's media download —
 * can see the state of U-V12 without reading a comment.
 *
 * `confirmed: false` is the honest value. `provisionalFields` records exactly what this module
 * *tries*, so the deployment capture has something to compare a real webhook against.
 */
export const WHATSAPP_INBOUND_MEDIA_SHAPE = {
  /** Flip to `true` only after a real inbound image and a real inbound audio webhook are seen. */
  confirmed: false,
  unresolvedItem: 'U-V12',
  /** PROVISIONAL. Not verified. Named here so a mismatch is reportable rather than mysterious. */
  provisionalFields: {
    mediaId: 'id',
    mimeType: 'mime_type',
    sha256: 'sha256',
    caption: 'caption',
    voice: 'voice',
  },
} as const;

/* ========================================================================== */
/* Constant-time comparison                                                    */
/* ========================================================================== */

/**
 * Compare two strings in time that does not depend on *where* they first differ.
 *
 * **Why the verify token needs this (Requirement 11.1/11.2).** `WHATSAPP_VERIFY_TOKEN` is a
 * credential, and the GET endpoint is public and unauthenticated by construction — anyone may
 * call it as often as they like. A byte-at-a-time comparison that returns early answers "how many
 * leading characters did I get right?", which turns guessing a 32-character token from an
 * infeasible search into 32 short ones. Whoever holds the token can complete Meta's handshake
 * against Jamee's endpoint and re-point the subscription. One function call removes the oracle.
 *
 * **Why the digest needs this (Requirement 11.3).** This is the sharper case. An attacker chooses
 * the body *and* the presented digest, and can retry indefinitely. An early-exit comparison leaks
 * the length of the matching prefix, which is the classic HMAC forgery: recover the correct digest
 * one byte at a time, then POST a forged webhook that verifies — **without ever knowing the App
 * Secret**. Constant-time comparison is the only thing standing between the app secret and a
 * forged delivery, because everything else about the digest is attacker-visible.
 *
 * **A length mismatch does return early, and that is fine.** `timingSafeEqual` throws on
 * different-length buffers, so the guard is required; and the leaked fact is the length of a value
 * the caller itself supplied. Nothing about the secret or the expected digest is revealed.
 *
 * UTF-8 bytes rather than code units because `timingSafeEqual` works on bytes. Both inputs here
 * are ASCII in practice (a hex or base64 digest, a configured token), so the encoding step is a
 * formality that keeps a multi-byte token from throwing.
 *
 * **Exported for the retention-sweep route (Requirement 18.12), which compares `CRON_SECRET`
 * against an `Authorization: Bearer` token on a public, unauthenticated, infinitely retriable
 * endpoint that deletes data.** It lives here rather than in a module of its own because
 * `whatsapp.test.ts` asserts structurally that this file is the ONLY call site of
 * `crypto.timingSafeEqual` — one primitive, one helper, one place to review. A second copy next to
 * the second caller is exactly the drift that assertion exists to prevent.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* ========================================================================== */
/* GET — the verification handshake (Requirements 11.1, 11.2)                   */
/* ========================================================================== */

export type ChallengeRejection =
  | 'mode_not_subscribe'
  | 'verify_token_absent'
  | 'verify_token_mismatch'
  | 'challenge_absent';

export type ChallengeDecision =
  | { readonly ok: true; readonly challenge: string }
  | { readonly ok: false; readonly reason: ChallengeRejection };

/**
 * Decide the handshake. Pure: no environment read, no `Response`, so a test can state the
 * decision directly.
 *
 * **V13.** The handshake is `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`: match the
 * token, then echo the challenge. Parameter names come from `META_CHALLENGE_PARAMS` so the three
 * literals live in one place with the row that resolved them.
 *
 * The token comparison runs through `timingSafeEqualStrings` for the reason documented there.
 */
export function challengeDecision(
  params: URLSearchParams,
  expectedToken: string,
): ChallengeDecision {
  const mode = params.get(META_CHALLENGE_PARAMS.mode);
  const presentedToken = params.get(META_CHALLENGE_PARAMS.verifyToken);
  const challenge = params.get(META_CHALLENGE_PARAMS.challenge);

  if (mode !== META_CHALLENGE_SUBSCRIBE_MODE) return { ok: false, reason: 'mode_not_subscribe' };
  if (presentedToken === null || presentedToken === '') {
    return { ok: false, reason: 'verify_token_absent' };
  }
  if (!timingSafeEqualStrings(presentedToken, expectedToken)) {
    return { ok: false, reason: 'verify_token_mismatch' };
  }
  // Checked after the token so a caller with the wrong token learns nothing about which parameter
  // was missing; and a matching token with nothing to echo is still not a completed handshake.
  if (challenge === null || challenge === '') return { ok: false, reason: 'challenge_absent' };

  return { ok: true, challenge };
}

/**
 * The handshake response: the challenge echoed with 200 (Requirement 11.1), or 403 with an empty
 * body (Requirement 11.2).
 *
 * **The 403 carries no body on purpose.** There is no farmer on this path and nothing to
 * localize, so `errorResponse()`'s envelope would add only one thing: a machine-readable
 * statement of *which* part of the handshake failed. That is an oracle — it separates "your token
 * is wrong" from "your request was malformed" for an unauthenticated caller. The reason stays
 * server-side in the returned decision, which the route logs.
 *
 * `expectedToken` defaults to `WHATSAPP_VERIFY_TOKEN` and is a parameter so tests need no
 * environment. The default is evaluated only when the argument is omitted, so a repository with
 * no WhatsApp credentials configured can still exercise the decision.
 */
export function respondToChallenge(
  request: Request,
  expectedToken: string = serverEnv('WHATSAPP_VERIFY_TOKEN'),
): { response: Response; decision: ChallengeDecision } {
  const decision = challengeDecision(new URL(request.url).searchParams, expectedToken);

  if (!decision.ok) {
    /**
     * The status comes from `WEBHOOK_VERIFY_TOKEN_INVALID` in `ERROR_SPECS`, not from a literal, so
     * the taxonomy stays the one place an HTTP code for this condition is written down — the same
     * arrangement the POST path's bodiless 401 already uses. Only the *body* is withheld, for the
     * oracle reason above.
     */
    return {
      response: new Response(null, { status: ERROR_SPECS.WEBHOOK_VERIFY_TOKEN_INVALID.status }),
      decision,
    };
  }
  return {
    response: new Response(decision.challenge, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    }),
    decision,
  };
}

/* ========================================================================== */
/* POST — signature verification over the RAW body (Requirement 11.3)          */
/* ========================================================================== */

/** Read the signature header by its resolved name (**V13**), so no caller retypes it. */
export function readSignatureHeader(headers: Headers): string | null {
  return headers.get(META_SIGNATURE_HEADER);
}

/**
 * What the presented header looks like, without echoing the digest.
 *
 * **This exists to close U-V13.** During deployment, log this for one real delivery: a 64-character
 * hex-looking digest settles the encoding as `hex`, a 44-character base64-looking one settles it as
 * `base64`. Then set `META_SIGNATURE_ENCODING_CONFIRMED` and record the observation in V13.
 *
 * The digest itself is deliberately not returned. It is not a secret, but a log line is the wrong
 * place for it and the length plus the alphabet is all the answer needs.
 */
export function describeSignatureHeader(header: string | null | undefined): {
  present: boolean;
  prefixPresent: boolean;
  digestLength: number;
  looksHex: boolean;
  looksBase64: boolean;
  matchesEncodingLength: readonly MetaSignatureEncoding[];
} {
  const raw = (header ?? '').trim();
  const prefixPresent = raw.toLowerCase().startsWith(META_SIGNATURE_PREFIX);
  const digest = prefixPresent ? raw.slice(META_SIGNATURE_PREFIX.length) : '';
  // 32 raw bytes render as 64 hex characters or 44 base64 characters (43 + one '=' pad).
  const matchesEncodingLength = META_SIGNATURE_ENCODING_CANDIDATES.filter((encoding) =>
    encoding === 'hex' ? digest.length === 64 : digest.length === 44,
  );

  return {
    present: raw.length > 0,
    prefixPresent,
    digestLength: digest.length,
    looksHex: digest.length > 0 && /^[0-9a-fA-F]+$/.test(digest),
    looksBase64: digest.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(digest),
    matchesEncodingLength,
  };
}

/**
 * Verify `X-Hub-Signature-256` over the raw body (**V13**).
 *
 * ### The bytes must be the bytes Meta signed
 *
 * `rawBody` is the body as read *once*, before any parse. `request.json()` discards the original
 * bytes and re-serializing the parsed object does not reproduce them — key order, whitespace and
 * unicode escaping all differ — so a re-serialized body fails verification even when it is
 * semantically identical. There is a unit test for exactly that case, because it is the one
 * mistake that looks correct in review.
 *
 * Prefer a `Uint8Array` from `request.arrayBuffer()` when byte-exactness must be provable:
 * `request.text()` decodes UTF-8, and re-encoding is lossless only for well-formed UTF-8 (an
 * invalid sequence would already have become U+FFFD). Meta sends UTF-8 JSON over HTTPS, so
 * `text()` is fine in practice and is what the design's sketch uses.
 *
 * ### What is compared
 *
 * HMAC-SHA256 over the body, keyed with the App Secret, compared against everything after
 * `sha256=` — all four of those are V13-resolved. The comparison runs for **every** accepted
 * encoding (U-V13) and the results are combined without short-circuiting, so which encoding
 * matched is not observable from the outside.
 *
 * The `sha256=` label is matched case-insensitively: it is a fixed public string, so leniency
 * there leaks nothing. The digest is not: hex is compared case-insensitively because hex has two
 * renderings of the same bytes, base64 exactly because it does not.
 *
 * An empty `appSecret` throws rather than returning `false`. Returning `false` would present a
 * configuration defect as a stream of forged deliveries; `serverEnv` already refuses to hand out
 * an empty value, so this only fires when a caller passes one explicitly.
 */
export function verifySignature(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (appSecret.length === 0) {
    throw new Error(
      'verifySignature was called with an empty appSecret. That is a configuration defect, ' +
        'not a failed signature — read WHATSAPP_APP_SECRET through serverEnv().',
    );
  }

  const presented = (header ?? '').trim();
  if (!presented.toLowerCase().startsWith(META_SIGNATURE_PREFIX)) return false;

  const presentedDigest = presented.slice(META_SIGNATURE_PREFIX.length);
  if (presentedDigest.length === 0) return false;

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;

  let matched = false;
  for (const encoding of acceptedSignatureEncodings()) {
    const expected = createHmac(META_SIGNATURE_ALGORITHM, appSecret).update(body).digest(encoding);
    const candidateMatched =
      encoding === 'hex'
        ? timingSafeEqualStrings(presentedDigest.toLowerCase(), expected)
        : timingSafeEqualStrings(presentedDigest, expected);
    // `candidateMatched || matched`, not `matched || candidateMatched`: the left operand is already
    // evaluated, so no comparison is skipped once one has succeeded.
    matched = candidateMatched || matched;
  }
  return matched;
}

/* -------------------------------------------------------------------------- */
/* The proof a payload may be read                                             */
/* -------------------------------------------------------------------------- */

/** Module-private brand. Not exported, so `VerifiedRawBody` cannot be built elsewhere. */
const VERIFIED = Symbol('jamee.whatsapp.verifiedRawBody');

/**
 * A body whose signature has been verified. Carrying the bytes *inside* the proof is what makes
 * the ordering airtight: `parseVerifiedInbound` cannot be handed different bytes than the ones
 * that were checked.
 */
export interface VerifiedRawBody {
  readonly [VERIFIED]: true;
  readonly raw: string | Uint8Array;
}

/**
 * The route-facing entry point: read the header by its resolved name, verify over the raw body,
 * and return the proof — or `null`, which the route turns into 401 with no shared service
 * invoked (Requirement 11.4).
 *
 * `appSecret` defaults to `WHATSAPP_APP_SECRET` through `serverEnv`, because the design's sketch
 * of `process.env.WHATSAPP_APP_SECRET!` is not available to Jamee: `src/lib/env.ts` is the only
 * module that reads `process.env`.
 */
export function verifyInboundRequest(
  headers: Headers,
  rawBody: string | Uint8Array,
  appSecret: string = serverEnv('WHATSAPP_APP_SECRET'),
): VerifiedRawBody | null {
  const header = readSignatureHeader(headers);
  if (!verifySignature(rawBody, header, appSecret)) return null;
  return { [VERIFIED]: true, raw: rawBody };
}

/* ========================================================================== */
/* The inbound payload contract (V12, with U-V12 quarantined)                   */
/* ========================================================================== */

/** **V12** — `value.metadata`. `phone_number_id` is what task 22.1's media call needs. */
const metadataSchema = z.object({
  display_phone_number: z.string().min(1),
  phone_number_id: z.string().min(1),
});

/** **V12** — `value.contacts[]`. `wa_id` is the sender; `profile.name` is the display name. */
const contactSchema = z.object({
  wa_id: z.string().min(1),
  profile: z.object({ name: z.string() }).optional(),
});

/** **V12** — `value.messages[].text.body`. The one per-type path that IS confirmed. */
const textSchema = z.object({ body: z.string() });

/**
 * **PROVISIONAL — U-V12. These names are NOT verified.**
 *
 * Applied to `messages[].image` / `messages[].audio` only at normalization time, never as part of
 * the confirmed envelope, so the two levels of certainty stay visibly separate in the code. A
 * media object that does not match becomes `unconfirmed_media_shape` with its real keys attached
 * — the failure is loud and self-describing rather than a silently absent media id.
 *
 * Only `id` is required, because a media id is the one field the download step cannot work
 * without. Everything else is optional: guessing more required fields would convert an
 * unconfirmed *name* into a rejected *delivery*.
 */
const provisionalMediaSchema = z.object({
  id: z.string().min(1),
  mime_type: z.string().min(1).optional(),
  sha256: z.string().min(1).optional(),
  caption: z.string().optional(),
  voice: z.boolean().optional(),
});

/**
 * **V12** — the confirmed common envelope of `value.messages[]`.
 *
 * `image` and `audio` are `unknown` **deliberately**: their inner shape is U-V12, and typing them
 * as anything else here would be the guess this module refuses to make. `timestamp` accepts a
 * string or a number because V12 confirms the path and not the wire type, and rejecting a whole
 * delivery over that would be the wrong failure.
 */
const messageSchema = z.object({
  id: z.string().min(1).max(WAMID_MAX_CHARS),
  from: z.string().min(1),
  timestamp: z.union([z.string().min(1), z.number()]),
  type: z.string().min(1),
  text: textSchema.optional(),
  image: z.unknown().optional(),
  audio: z.unknown().optional(),
  errors: z.array(z.unknown()).optional(),
});

/**
 * **V12** — `entry[].changes[].value`.
 *
 * `messaging_product` is a plain string, not `z.literal('whatsapp')`. V12 confirms the *path*; it
 * does not assert the value, and asserting one here would risk rejecting every delivery to make a
 * point about a field Jamee does not branch on.
 *
 * `statuses[]` is `unknown[]`: V12 confirms where business-originated status updates arrive, and
 * all Jamee needs from them is that they are **not** farmer messages. Naming inner fields that
 * V12 did not confirm would be the same mistake as guessing the media paths.
 */
const changeValueSchema = z.object({
  messaging_product: z.string().min(1),
  metadata: metadataSchema,
  contacts: z.array(contactSchema).optional(),
  messages: z.array(messageSchema).optional(),
  statuses: z.array(z.unknown()).optional(),
  errors: z.array(z.unknown()).optional(),
});

/**
 * **V12** — the top-level envelope. `object` is the one literal V12 states outright.
 *
 * `changes[].value` is `unknown` here and parsed with `changeValueSchema` only for changes whose
 * `field` is `messages`. A subscription that also delivers some other field would otherwise sink
 * an entire delivery — including any real farmer message batched alongside it — because
 * `changeValueSchema` requires `metadata`, which another field's value need not carry.
 *
 * Not exported. Exporting it would reopen the door Requirement 11.3 closes: a caller could parse
 * an unverified body with it. The only way in is `parseVerifiedInbound`.
 */
const whatsappWebhookSchema = z.object({
  object: z.literal(META_WEBHOOK_OBJECT),
  entry: z.array(
    z.object({
      id: z.string().min(1),
      changes: z.array(
        z.object({
          field: z.string().min(1),
          value: z.unknown(),
        }),
      ),
    }),
  ),
});

/* -------------------------------------------------------------------------- */
/* Normalized shapes                                                           */
/* -------------------------------------------------------------------------- */

export type InboundContent =
  /** CONFIRMED (V12): `messages[].text.body`. */
  | { readonly kind: 'text'; readonly body: string }
  /**
   * PROVISIONAL (U-V12). `provisional: true` is part of the type so a consumer cannot treat a
   * guessed media id as a verified one without the flag being in front of them.
   */
  | {
      readonly kind: 'image';
      readonly mediaId: string;
      readonly mimeType?: string;
      readonly caption?: string;
      readonly provisional: true;
    }
  | {
      readonly kind: 'audio';
      readonly mediaId: string;
      readonly mimeType?: string;
      readonly voice?: boolean;
      readonly provisional: true;
    }
  /**
   * The loud failure U-V12 demands: Meta sent an image or audio message and the provisional shape
   * did not fit. `observedKeys` is the deployment capture — the real field names, ready to be
   * recorded in V12.
   */
  | {
      readonly kind: 'unconfirmed_media_shape';
      readonly type: 'image' | 'audio';
      readonly observedKeys: readonly string[];
      readonly issue: string;
    }
  /**
   * `type_outside_supported_set` is Requirement 10.9 (a sticker, a location, a contact card) and
   * gets the "photos, text, and voice notes" reply. `confirmed_field_absent` is different: a
   * `text` message with no `text.body` contradicts a CONFIRMED path, so it is a payload defect
   * rather than an unsupported kind, and task 22.2 must not answer it with 10.9's sentence.
   */
  | {
      readonly kind: 'unsupported';
      readonly type: string;
      readonly reason: 'type_outside_supported_set' | 'confirmed_field_absent';
    };

export interface InboundMessage {
  /** The WAMID at `messages[].id` — the idempotency key for Requirements 11.5 and 11.6 (V12). */
  readonly providerMessageId: string;
  /** `messages[].from`. Resolved against `profiles.phone` by Requirement 10.2 (task 22.2). */
  readonly fromPhone: string;
  /** `messages[].timestamp`, normalized to a string. Nothing derives a deadline from it. */
  readonly timestamp: string;
  /** `messages[].type` verbatim, kept for the `whatsapp_inbound.message_type` column. */
  readonly rawType: string;
  readonly wabaId: string;
  readonly phoneNumberId: string;
  readonly displayPhoneNumber: string;
  readonly contactName?: string;
  readonly content: InboundContent;
}

export interface InboundBatch {
  /**
   * Farmer-originated messages across every entry and change, in delivery order.
   *
   * V13 records that a notification may batch up to 1000 updates, so this is a list and each item
   * is handled individually (migration `0008`'s status machine is what keeps a partially
   * processed batch honest rather than silently dropped).
   */
  readonly messages: readonly InboundMessage[];
  /** How many `value.statuses[]` entries arrived. Delivery receipts, not farmer messages. */
  readonly statusUpdateCount: number;
  readonly entryCount: number;
  /** Changes whose `field` was not `messages`. Counted so an ignored delivery is not invisible. */
  readonly ignoredChangeCount: number;
}

export type InboundParse =
  | { readonly ok: true; readonly batch: InboundBatch }
  | {
      readonly ok: false;
      readonly reason: 'body_not_json' | 'envelope_rejected';
      readonly detail: string;
    };

/**
 * A delivery that carries only status updates.
 *
 * **V12: `field` is `messages` for both**, so this presence check — not the field value — is what
 * separates a farmer's message from a delivery receipt. Task 22.2 acknowledges a receipt with 200
 * and does nothing else: no idempotency row, no quota, no service call.
 */
export function isDeliveryReceiptOnly(batch: InboundBatch): boolean {
  return batch.messages.length === 0 && batch.statusUpdateCount > 0;
}

/**
 * Interpret a **verified** body.
 *
 * Returns a result rather than throwing because the route's two failure branches are different
 * responses, not one: an unsigned request is 401 (Requirement 11.4), while a signed body that
 * does not parse is a genuine Meta delivery Jamee cannot act on — acknowledged with 200 and
 * ignored, per Requirement 10.11 and task 21.2.
 */
export function parseVerifiedInbound(body: VerifiedRawBody): InboundParse {
  const text =
    typeof body.raw === 'string' ? body.raw : Buffer.from(body.raw).toString('utf8');

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: 'body_not_json',
      detail: error instanceof Error ? error.message : 'unparseable body',
    };
  }

  const parsed = whatsappWebhookSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: 'envelope_rejected',
      detail:
        issue === undefined
          ? 'payload did not match the confirmed V12 envelope'
          : `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    };
  }

  const messages: InboundMessage[] = [];
  let statusUpdateCount = 0;
  let ignoredChangeCount = 0;

  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      // V12: `field` is `messages` for both inbound messages and status updates. Any other field
      // belongs to a subscription Jamee does not act on, and its `value` has a shape V12 says
      // nothing about — so it is counted and skipped rather than validated against this contract.
      if (change.field !== META_WEBHOOK_FIELD_MESSAGES) {
        ignoredChangeCount += 1;
        continue;
      }

      const parsedValue = changeValueSchema.safeParse(change.value);
      if (!parsedValue.success) {
        const issue = parsedValue.error.issues[0];
        return {
          ok: false,
          reason: 'envelope_rejected',
          detail:
            `entry[].changes[].value (field="${META_WEBHOOK_FIELD_MESSAGES}"): ` +
            (issue === undefined
              ? 'did not match the confirmed V12 value shape'
              : `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        };
      }
      const value = parsedValue.data;
      statusUpdateCount += value.statuses?.length ?? 0;

      for (const message of value.messages ?? []) {
        // `contacts[]` and `messages[]` are parallel lists rather than nested, so the name is
        // matched on `wa_id` = `from`. An absent contact is not an error: V12 marks the array
        // optional and nothing downstream requires a display name.
        const contactName = value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name;

        messages.push({
          providerMessageId: message.id,
          fromPhone: message.from,
          timestamp: String(message.timestamp),
          rawType: message.type,
          wabaId: entry.id,
          phoneNumberId: value.metadata.phone_number_id,
          displayPhoneNumber: value.metadata.display_phone_number,
          ...(contactName === undefined ? {} : { contactName }),
          content: classifyContent(message),
        });
      }
    }
  }

  return {
    ok: true,
    batch: {
      messages,
      statusUpdateCount,
      entryCount: parsed.data.entry.length,
      ignoredChangeCount,
    },
  };
}

/** The keys a value actually carries, for the U-V12 capture. */
function observedKeysOf(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.keys(value as Record<string, unknown>);
}

function classifyMedia(type: 'image' | 'audio', raw: unknown): InboundContent {
  const parsed = provisionalMediaSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: 'unconfirmed_media_shape',
      type,
      observedKeys: observedKeysOf(raw),
      issue:
        `messages[].${type} did not match Jamee's PROVISIONAL shape (U-V12): ` +
        `${issue === undefined ? 'no media id found' : `${issue.path.join('.') || '(root)'}: ${issue.message}`}. ` +
        `Expected at least "${WHATSAPP_INBOUND_MEDIA_SHAPE.provisionalFields.mediaId}". ` +
        'Record the observed keys in docs/VERIFIED_VALUES.md (V12) and update provisionalMediaSchema.',
    };
  }

  const media = parsed.data;
  if (type === 'image') {
    return {
      kind: 'image',
      mediaId: media.id,
      ...(media.mime_type === undefined ? {} : { mimeType: media.mime_type }),
      ...(media.caption === undefined ? {} : { caption: media.caption }),
      provisional: true,
    };
  }
  return {
    kind: 'audio',
    mediaId: media.id,
    ...(media.mime_type === undefined ? {} : { mimeType: media.mime_type }),
    ...(media.voice === undefined ? {} : { voice: media.voice }),
    provisional: true,
  };
}

/**
 * Map one message onto the three things Jamee can act on — text, image, audio — plus the two
 * honest failures.
 *
 * The `image`/`audio` branches carry the media object through `classifyMedia` rather than reading
 * a field directly, which is what keeps the confirmed envelope and the unconfirmed sub-object
 * separable when U-V12 is finally resolved: one schema changes and nothing else does.
 */
function classifyContent(message: z.infer<typeof messageSchema>): InboundContent {
  switch (message.type) {
    case 'text':
      return message.text === undefined
        ? { kind: 'unsupported', type: message.type, reason: 'confirmed_field_absent' }
        : { kind: 'text', body: message.text.body };
    case 'image':
      return classifyMedia('image', message.image);
    case 'audio':
      return classifyMedia('audio', message.audio);
    default:
      return { kind: 'unsupported', type: message.type, reason: 'type_outside_supported_set' };
  }
}

/* ========================================================================== */
/* V14 — inbound media retrieval, admission, and the service-role upload        */
/* ========================================================================== */

/**
 * Requirements: 10.4 (an inbound image is downloaded from the Cloud API, stored in `crop-images`,
 *               and the resulting Storage_Reference is what the Diagnosis_Service receives),
 *               10.6 (the same for an inbound audio message and `voice-messages`),
 *               13.6 (a farmer's read and write access is confined to objects under that
 *               farmer's own path prefix — which is why a service-role upload still writes under
 *               `{user_id}/`)
 * Design: "WhatsApp adapter" → *Media download and upload*; "Inbound processing order" step 6;
 *         "0009: storage buckets and policies" → *Object path convention*
 * Depends on: V14 (the two steps, the auth header on BOTH of them, the 5-minute URL TTL, the
 *             inbound type and size caps, the 404 recovery), V12 (`metadata.phone_number_id`),
 *             V4 (the `(storage.foldername(name))[1]` predicate the prefix satisfies)
 *
 * ### THE PREFIX IS THE WHOLE POINT OF THE UPLOAD (Requirement 13.6)
 *
 * A webhook carries no farmer session, so there is no RLS-scoped client to upload with and the
 * service role is the only option. But the service role is *outside* the boundary Requirement
 * 13.6 describes, so writing outside `{user_id}/` would produce an object no farmer session could
 * ever read — the WhatsApp diagnosis would appear in the web history with a broken thumbnail
 * (Requirements 12.2, 12.5). The prefix is therefore not a convention this path happens to
 * follow; it is the mechanism that makes a WhatsApp upload readable by its owner later. That is
 * also why the path comes from `buildStorageRef()` rather than a template string here: one
 * builder, validated against `storageRefSchema`, shared with the browser uploader.
 *
 * ### THE ORDER OF THE CHECKS IS WHAT MAKES "SPENDS NOTHING" TRUE
 *
 * Step 1 returns `file_size` and `mime_type` **before a single media byte is fetched**, so
 * admission runs on the metadata first. An oversized or unusable item therefore costs one small
 * JSON request: no binary download, no upload, no storage object to sweep later, and — because
 * this module takes no quota dependency at all and calls no provider — no quota and no provider
 * spend. Task 22.2 must call this **before** the reserve for that to hold end to end.
 */

/** The two message kinds that carry bytes. */
export type WhatsappMediaKind = 'image' | 'audio';

/**
 * The only `InboundContent` members this path accepts, derived rather than restated.
 *
 * `Extract<…, { readonly provisional: true }>` resolves to exactly the `image` and `audio`
 * members, which is **finding 1 enforced by the type system**: `unconfirmed_media_shape` carries
 * no `provisional` field, so it cannot be passed here at all. A caller holding a general
 * `InboundContent` narrows with `isInboundMediaContent()` and handles the unconfirmed branch
 * itself (the route already logs it) instead of this module guessing at a media id.
 */
export type InboundMediaContent = Extract<InboundContent, { readonly provisional: true }>;

/** Runtime narrowing for a caller holding a general `InboundContent`. */
export function isInboundMediaContent(content: InboundContent): content is InboundMediaContent {
  return (content.kind === 'image' || content.kind === 'audio') && content.provisional === true;
}

/** Requirements 10.4 and 10.6 name the bucket per kind; nothing else chooses one. */
export const WHATSAPP_MEDIA_BUCKETS: Readonly<Record<WhatsappMediaKind, StorageBucket>> = {
  image: STORAGE_BUCKETS.cropImages,
  audio: STORAGE_BUCKETS.voiceMessages,
};

/**
 * **V14.** The inbound MIME types Meta documents per kind, recorded for the cross-check below
 * rather than used as the admission list. Admission is Jamee's own set intersected with V10's —
 * see `admitInboundMedia`.
 */
export const WHATSAPP_INBOUND_DOCUMENTED_MIME = {
  image: ['image/jpeg', 'image/png'],
  audio: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
} as const;

/**
 * **V14, and the header is required on BOTH steps.** Omitting it on step 2 fails — the media URL
 * is not a pre-signed URL, which is the single most surprising thing about this flow and the
 * mistake that produces a 401 on a URL that looks like it should just work.
 */
export const META_AUTHORIZATION_HEADER = 'authorization';
export const META_BEARER_PREFIX = 'Bearer ';

/** The one place the Bearer header is constructed, so neither step can be written without it. */
export function metaAuthHeaders(accessToken: string): Readonly<Record<string, string>> {
  if (accessToken.trim().length === 0) {
    throw new Error(
      'metaAuthHeaders was called with an empty access token. V14 requires ' +
        'Authorization: Bearer on BOTH media steps — read WHATSAPP_ACCESS_TOKEN through ' +
        'serverEnv() rather than passing an empty string.',
    );
  }
  return { [META_AUTHORIZATION_HEADER]: `${META_BEARER_PREFIX}${accessToken}` };
}

/**
 * The pinned Graph API version (**V12**) unless `WHATSAPP_API_VERSION` overrides it.
 *
 * The override is an escape hatch for Meta deprecating the pinned version faster than a code
 * change can ship, not a value an operator is expected to set — which is why it lives in
 * `OPTIONAL_SERVER_ENV_KEYS` and reads through `optionalServerEnv`.
 */
export function whatsappApiVersion(): string {
  return optionalServerEnv('WHATSAPP_API_VERSION') ?? WHATSAPP_API_VERSION_PINNED;
}

/* -------------------------------------------------------------------------- */
/* Step 1 — media id → media URL                                               */
/* -------------------------------------------------------------------------- */

/**
 * **V14.** `GET https://graph.facebook.com/{version}/{MEDIA_ID}`, with `phone_number_id` as an
 * optional query parameter.
 *
 * That parameter is supplied from the delivery's own `value.metadata.phone_number_id`, which V12
 * confirms — not from `WHATSAPP_PHONE_NUMBER_ID`. Two reasons: it is the number that actually
 * received this message, and it needs no environment read on a path that works without one.
 */
export function mediaMetadataUrl(
  mediaId: string,
  options: { readonly apiVersion?: string; readonly phoneNumberId?: string } = {},
): string {
  const base = `${graphApiBase(options.apiVersion ?? whatsappApiVersion())}/${encodeURIComponent(mediaId)}`;
  const phoneNumberId = options.phoneNumberId;
  return phoneNumberId === undefined || phoneNumberId === ''
    ? base
    : `${base}?phone_number_id=${encodeURIComponent(phoneNumberId)}`;
}

/**
 * **V14** — the step 1 response body: `{ messaging_product, url, mime_type, sha256, file_size, id }`.
 *
 * `file_size` accepts a numeric string as well as a number for the same reason
 * `messageSchema.timestamp` does: V14 confirms the field and what it means, not its wire type,
 * and rejecting a delivery over a JSON number arriving quoted would be the wrong failure. It is
 * still coerced to a number, because the size gate has to compare it.
 *
 * `messaging_product` and `sha256` are optional: they are documented but nothing here branches on
 * them, and requiring a field this module does not use would turn a documentation drift into a
 * refused photo.
 */
const mediaMetadataSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  mime_type: z.string().min(1),
  file_size: z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number),
  sha256: z.string().min(1).optional(),
  messaging_product: z.string().min(1).optional(),
});

export interface MetaMediaMetadata {
  readonly id: string;
  /** **Valid for 5 minutes (V14)**, which is why nothing caches it across invocations. */
  readonly url: string;
  readonly mimeType: string;
  /** The size Meta reports *before* any byte is fetched — the reason the size gate is free. */
  readonly fileSize: number;
  readonly sha256?: string;
}

/** The slice of `fetch` this module uses, so a test needs no network and no global patch. */
export type FetchLike = (
  input: string,
  init?: { readonly method?: string; readonly headers?: Readonly<Record<string, string>> },
) => Promise<Response>;

export interface MediaFetchOptions {
  /** Defaults to `WHATSAPP_ACCESS_TOKEN`, evaluated only when omitted. */
  readonly accessToken?: string;
  /** From the delivery's V12-confirmed `metadata.phone_number_id`. Optional per V14. */
  readonly phoneNumberId?: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: FetchLike;
}

interface ResolvedMediaFetch {
  readonly headers: Readonly<Record<string, string>>;
  readonly phoneNumberId?: string;
  readonly apiVersion: string;
  readonly fetchImpl: FetchLike;
}

function resolveMediaFetch(options: MediaFetchOptions): ResolvedMediaFetch {
  return {
    headers: metaAuthHeaders(options.accessToken ?? serverEnv('WHATSAPP_ACCESS_TOKEN')),
    ...(options.phoneNumberId === undefined ? {} : { phoneNumberId: options.phoneNumberId }),
    apiVersion: options.apiVersion ?? whatsappApiVersion(),
    fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
  };
}

/**
 * V14's documented recovery, carried in the log context of every media failure so an operator
 * reads the fix rather than inferring it: re-request the media URL, then renew the access token
 * if it still fails.
 */
const MEDIA_RECOVERY_NOTE =
  'V14 recovery: the media URL was re-requested once and still failed. Media ids from a webhook ' +
  'are downloadable for 7 days; if this id is inside that window, renew WHATSAPP_ACCESS_TOKEN.';

function mediaFailure(
  reason: string,
  context: Readonly<Record<string, unknown>>,
  cause?: unknown,
): AppError {
  return new AppError('INTERNAL_ERROR', {
    ...(cause === undefined ? {} : { cause }),
    context: { reason, ...context },
  });
}

/**
 * Step 1: the media id becomes a short-lived media URL plus the metadata the size and type gates
 * read.
 *
 * A non-2xx throws rather than returning a result. A farmer whose photo Jamee could not fetch has
 * not sent an unsupported photo — reporting it as one would be a lie in the reply and would also
 * mean the delivery was marked `rejected` instead of `failed`. `INTERNAL_ERROR` carries the
 * honest, retryable "something went wrong at Jamee's end" sentence, and the real status stays in
 * the server log.
 */
export async function fetchMediaMetadata(
  mediaId: string,
  options: MediaFetchOptions = {},
): Promise<MetaMediaMetadata> {
  const resolved = resolveMediaFetch(options);
  const url = mediaMetadataUrl(mediaId, {
    apiVersion: resolved.apiVersion,
    ...(resolved.phoneNumberId === undefined ? {} : { phoneNumberId: resolved.phoneNumberId }),
  });

  let response: Response;
  try {
    response = await resolved.fetchImpl(url, { method: 'GET', headers: resolved.headers });
  } catch (cause) {
    throw mediaFailure('whatsapp_media_metadata_unreachable', { mediaId }, cause);
  }

  if (!response.ok) {
    throw mediaFailure('whatsapp_media_metadata_rejected', {
      mediaId,
      status: response.status,
      // A 404 here means the id itself is gone (V14: webhook ids live 7 days), and a 401 means
      // the token. Both are named so the log line answers "what now".
      ...(response.status === 404 || response.status === 401
        ? { recovery: MEDIA_RECOVERY_NOTE }
        : {}),
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw mediaFailure('whatsapp_media_metadata_not_json', { mediaId }, cause);
  }

  const parsed = mediaMetadataSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw mediaFailure('whatsapp_media_metadata_shape_rejected', {
      mediaId,
      detail:
        issue === undefined
          ? 'did not match the V14 media metadata shape'
          : `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    });
  }

  const data = parsed.data;
  return {
    id: data.id,
    url: data.url,
    mimeType: data.mime_type,
    fileSize: data.file_size,
    ...(data.sha256 === undefined ? {} : { sha256: data.sha256 }),
  };
}

/* -------------------------------------------------------------------------- */
/* Step 2 — media URL → authenticated binary fetch                             */
/* -------------------------------------------------------------------------- */

export interface MediaBinary {
  readonly bytes: Uint8Array;
  /** **V14:** the response `content-type` gives the MIME type. `null` when absent. */
  readonly contentType: string | null;
}

/**
 * Step 2: `GET <MEDIA_URL>` with the **same** Bearer header.
 *
 * The header is not optional and not a convenience. V14 states outright that omitting the token
 * fails, so this function has no code path that issues the request without it — `metaAuthHeaders`
 * is the only way the headers object is built, and it throws on an empty token.
 */
async function fetchMediaBinaryOnce(
  mediaUrl: string,
  resolved: ResolvedMediaFetch,
): Promise<{ readonly ok: true; readonly binary: MediaBinary } | { readonly ok: false; readonly status: number }> {
  const response = await resolved.fetchImpl(mediaUrl, {
    method: 'GET',
    headers: resolved.headers,
  });

  if (!response.ok) return { ok: false, status: response.status };

  const buffer = await response.arrayBuffer();
  return {
    ok: true,
    binary: {
      bytes: new Uint8Array(buffer),
      contentType: response.headers.get('content-type'),
    },
  };
}

/**
 * Step 2 with **V14's documented recovery**: a failed download returns 404, and the recovery is to
 * re-request the media URL, then renew the access token if it still fails.
 *
 * So a 404 re-runs step 1 once — which is the whole point, because a media URL is valid for only
 * 5 minutes and the most likely cause of a 404 is a URL that expired between the two steps, not a
 * media id that vanished. Exactly one retry: a second 404 on a freshly minted URL is the token
 * case, and looping would spend requests to relearn that.
 *
 * `onFreshMetadata` lets the caller re-run admission against the re-requested metadata rather than
 * trusting the first response's claims after a retry.
 */
export async function fetchMediaBinary(
  metadata: MetaMediaMetadata,
  mediaId: string,
  options: MediaFetchOptions = {},
  onFreshMetadata?: (fresh: MetaMediaMetadata) => void,
): Promise<MediaBinary> {
  const resolved = resolveMediaFetch(options);

  let attempt: Awaited<ReturnType<typeof fetchMediaBinaryOnce>>;
  try {
    attempt = await fetchMediaBinaryOnce(metadata.url, resolved);
  } catch (cause) {
    throw mediaFailure('whatsapp_media_binary_unreachable', { mediaId }, cause);
  }
  if (attempt.ok) return attempt.binary;

  if (attempt.status !== 404) {
    throw mediaFailure('whatsapp_media_binary_rejected', {
      mediaId,
      status: attempt.status,
      // 401 on step 2 is the "omitting the token fails" case V14 names, so the note applies to it
      // as well as to a 404 — but only after the re-request below has been tried for a 404.
      ...(attempt.status === 401 ? { recovery: MEDIA_RECOVERY_NOTE } : {}),
    });
  }

  const fresh = await fetchMediaMetadata(mediaId, options);
  onFreshMetadata?.(fresh);

  let retried: Awaited<ReturnType<typeof fetchMediaBinaryOnce>>;
  try {
    retried = await fetchMediaBinaryOnce(fresh.url, resolved);
  } catch (cause) {
    throw mediaFailure('whatsapp_media_binary_unreachable', { mediaId, afterRecovery: true }, cause);
  }
  if (retried.ok) return retried.binary;

  throw mediaFailure('whatsapp_media_binary_not_found', {
    mediaId,
    status: retried.status,
    recovery: MEDIA_RECOVERY_NOTE,
  });
}

/* -------------------------------------------------------------------------- */
/* Admission — the same limits as the web path, before any byte is fetched      */
/* -------------------------------------------------------------------------- */

export type InboundMediaRefusalReason =
  /** An image whose MIME type is outside `ACCEPTED_IMAGE_TYPES` (Requirement 2.4's set). */
  | 'content_type_unsupported'
  /** An audio container V10's accepted list does not contain — see the discrepancy note below. */
  | 'voice_container_unsupported'
  /** Over the effective cap (Requirement 2.4 / 8.3's number, or V14's, whichever is tighter). */
  | 'too_large';

export interface InboundMediaRefusal {
  readonly reason: InboundMediaRefusalReason;
  readonly kind: WhatsappMediaKind;
  /** The farmer-facing sentence, already localized. Task 22.2 sends it verbatim. */
  readonly reply: string;
  readonly mimeType: string;
  readonly bytes: number | undefined;
  readonly capBytes: number;
  /** Whose limit bound: Jamee's own product rule, or Meta's documented inbound cap (V14). */
  readonly capOwner: 'jamee' | 'meta';
}

/**
 * The effective byte cap for a kind: **the tighter of Jamee's own rule and V14's inbound cap.**
 *
 * | kind | Jamee (Req 2.4 / 8.3) | Meta inbound (V14) | effective |
 * | --- | --- | --- | --- |
 * | image | 10 MB | 5 MB  | **5 MB** — Meta's is tighter |
 * | audio | 10 MB | 16 MB | **10 MB** — Jamee's is tighter |
 *
 * Taking the minimum rather than picking one is what keeps the reply honest in both directions. A
 * 12 MB voice note is inside what Meta will deliver and outside what Jamee accepts, and quoting
 * 16 MB at the farmer would state a limit Jamee does not honour; a 7 MB photo cannot arrive at
 * all, and quoting 10 MB would describe a ceiling this channel never reaches. `capOwner` records
 * which bound applied, for the log rather than for the farmer.
 */
export function inboundMediaCap(kind: WhatsappMediaKind): {
  readonly bytes: number;
  readonly owner: 'jamee' | 'meta';
} {
  const jamee = kind === 'image' ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
  const meta = WHATSAPP_INBOUND_MAX_BYTES[kind];
  return meta < jamee ? { bytes: meta, owner: 'meta' } : { bytes: jamee, owner: 'jamee' };
}

/**
 * Is this MIME type one Jamee can act on for this kind?
 *
 * **Images** use `ACCEPTED_IMAGE_TYPES` — literally the web path's set (Requirement 2.4), so a
 * WhatsApp photo is admitted on exactly the terms a browser upload is. V14's documented inbound
 * set (`image/jpeg`, `image/png`) is a subset of it, so nothing is lost by using Jamee's.
 *
 * ### AUDIO: THE V10-versus-V14 DISCREPANCY, RESOLVED RATHER THAN HIDDEN
 *
 * V14 lists WhatsApp inbound audio as `audio/aac`, `audio/amr`, `audio/mpeg`, `audio/mp4` and
 * `audio/ogg`, and asserts all of them sit inside V10's accepted container list. **They do not.**
 * V10's list is `flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm` — `mpeg`, `mp4` and `ogg` are
 * members; `aac` and `amr` are not. `src/lib/groq.ts` already refuses the two rather than widening
 * the list, and names this task as the place the discrepancy is resolved.
 *
 * **Resolved in task 22.2, in the only direction the fail-loud rule allows: the list is NOT
 * widened, the refusal stands, and V14's cross-check sentence is corrected as wrong.** Widening
 * would mean asserting that Groq accepts `aac`/`amr`, and no first-party Groq page says so — the
 * accepted-container list on the V10 source page does not contain either. Under
 * `docs/VERIFIED_VALUES.md`'s own rule ("a guess that looks right is a defect"), the honest output
 * is a refusal a farmer can act on plus a recorded limitation, not a third-hand assumption about a
 * provider's decoder. V14's note now says so, and V10's list is unchanged.
 *
 * The consequence is stated rather than buried: **a WhatsApp voice note that arrives as `aac` or
 * `amr` is refused, and Requirement 10.6 is therefore not satisfied for those two containers.**
 * The farmer is told the one thing that works (type the question), the reply is accurate, and the
 * limitation is recorded in V14's notes. If a real deployment shows Meta sending `aac` for most
 * voice notes, the fix is a transcode step or a second provider — both real work, neither a
 * comment.
 *
 * Refusing **here**, before the download, rather than letting the transcription adapter refuse
 * pre-flight, for three concrete reasons:
 *
 *  1. **The reply stays accurate and the farmer is not invited to retry.** Task 22.2 also closed
 *     the taxonomy gap that made this awkward: a container outside V10's list is now
 *     `AUDIO_FORMAT_UNSUPPORTED` (400, **not** retryable) rather than `TRANSCRIPTION_FAILED`
 *     (502, retryable), because WhatsApp chooses the recording container and re-sending the
 *     identical voice note fails identically forever.
 *     `whatsapp.voiceNoteFormatUnsupported` is the channel-specific rendering of the same fact.
 *  2. **It would cost bytes to learn something already known.** Passing through means a 16 MB
 *     download, an upload, and a storage object that Requirement 8.10 then retains for the whole
 *     Retention_Window because its transcription failed — straggler bytes against a 1 GB
 *     allowance, spent to reach a refusal available before the first byte.
 *  3. **The refusal belongs where the fact is.** The transcription adapter's guard is about what
 *     the provider accepts. Whether Jamee accepts this *channel's* media is an admission
 *     question, and admission is this function.
 *
 * The check delegates to `isAcceptedAudioContainer` rather than restating a list, so **V10's list
 * is not widened here and cannot drift from it**: if V10 is ever resolved to include `aac`, the
 * one edit in `config/verified.ts` widens this path too, with nothing to remember.
 */
export function isAdmissibleInboundMime(kind: WhatsappMediaKind, mimeType: string): boolean {
  if (kind === 'image') {
    return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(mimeType.trim().toLowerCase());
  }
  return isAcceptedAudioContainer(mimeType);
}

/**
 * Admit or refuse, with the refusal carrying its own farmer-facing sentence.
 *
 * `bytes` is `undefined` only where the size is genuinely not known yet; every call site here has
 * it, either from step 1's `file_size` or from the downloaded length.
 *
 * The two size/type sentences are the **web path's own localized strings**, resolved through
 * `toEnvelope` from `FILE_TOO_LARGE` and `FILE_TYPE_UNSUPPORTED`. That is deliberate: the task
 * asks for the same limits as the web path, and reusing the same coded messages means the WhatsApp
 * reply and the browser rejection cannot come to disagree about what the limit is. The caller
 * supplies `maxBytes` so the sentence quotes the *effective* cap rather than
 * `impliedDetails`' 10 MB web figure.
 */
export function admitInboundMedia(input: {
  readonly kind: WhatsappMediaKind;
  readonly mimeType: string;
  readonly bytes: number | undefined;
  readonly language: Language;
}): InboundMediaRefusal | null {
  const { kind, mimeType, bytes, language } = input;
  const cap = inboundMediaCap(kind);

  const base = {
    kind,
    mimeType,
    bytes,
    capBytes: cap.bytes,
    capOwner: cap.owner,
  } as const;

  if (!isAdmissibleInboundMime(kind, mimeType)) {
    return kind === 'audio'
      ? {
          ...base,
          reason: 'voice_container_unsupported',
          reply: messages(language).whatsapp.voiceNoteFormatUnsupported,
        }
      : {
          ...base,
          reason: 'content_type_unsupported',
          reply: toEnvelope(
            new AppError('FILE_TYPE_UNSUPPORTED', {
              details: { maxBytes: cap.bytes, acceptedTypes: [...ACCEPTED_IMAGE_TYPES] },
            }),
            language,
          ).error.message,
        };
  }

  if (bytes !== undefined && bytes > cap.bytes) {
    return {
      ...base,
      reason: 'too_large',
      reply: toEnvelope(
        new AppError('FILE_TOO_LARGE', { details: { maxBytes: cap.bytes } }),
        language,
      ).error.message,
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* The object path                                                             */
/* -------------------------------------------------------------------------- */

/** `image/jpeg` → `jpg`. Only the three types `ACCEPTED_IMAGE_TYPES` admits appear here. */
const IMAGE_EXTENSIONS: Readonly<Record<AcceptedImageType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * The file extension for an already-admitted MIME type.
 *
 * Audio reuses `normalizeAudioContainer` — every member of V10's list (`flac`, `mp3`, `mp4`,
 * `mpeg`, `mpga`, `m4a`, `ogg`, `wav`, `webm`) is already a legal 2–5 character extension under
 * `storageRefSchema`, so there is no second table to keep in step.
 *
 * A type that passed admission but has no extension here is a **defect in Jamee**, not a farmer's
 * bad upload, so it throws a plain `Error` naming the type — the same reasoning `buildStorageRef`
 * gives for not raising `STORAGE_REF_INVALID` on its own bad output.
 */
export function inboundMediaExtension(kind: WhatsappMediaKind, mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();

  if (kind === 'image') {
    // Widened for the lookup only. The declaration stays keyed by `AcceptedImageType` so a new
    // accepted image type is a compile error here rather than a runtime throw.
    const extension: string | undefined = (IMAGE_EXTENSIONS as Readonly<Record<string, string>>)[
      normalized
    ];
    if (extension === undefined) {
      throw new Error(
        `no storage extension is defined for the admitted image type "${mimeType}". ` +
          'IMAGE_EXTENSIONS in src/lib/whatsapp.ts must cover every member of ' +
          'ACCEPTED_IMAGE_TYPES.',
      );
    }
    return extension;
  }

  const container = normalizeAudioContainer(normalized);
  if (container === undefined) {
    throw new Error(
      `no storage extension could be derived from the admitted audio type "${mimeType}". ` +
        'Admission passed, so this is a defect in inboundMediaExtension, not a bad delivery.',
    );
  }
  return container;
}

/* -------------------------------------------------------------------------- */
/* The service-role upload                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The narrow slice of a Supabase client the upload needs.
 *
 * Structural rather than nominal for the same reason `StorageClientLike` in `src/lib/storage.ts`
 * is: `AdminClient` satisfies it without being named in a test, so a unit test uploads into a
 * stub and never reads `SUPABASE_SERVICE_ROLE_KEY`.
 */
export interface MediaUploadClientLike {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Uint8Array,
        options?: { readonly contentType?: string; readonly upsert?: boolean },
      ): Promise<{ data: unknown; error: unknown }>;
    };
  };
}

/**
 * Write the bytes under the resolved farmer's prefix with the service role.
 *
 * `upsert: false` is deliberate even though the path ends in a fresh uuid and a collision is
 * therefore not a real scenario: it turns the impossible case into a loud error instead of a
 * silent overwrite of a farmer's object, and it keeps this write inside the `select, insert`
 * grant migration `0009` narrowed the farmer policies to (an upsert needs `update` as well).
 */
async function uploadInboundMedia(
  ref: StorageRef,
  bytes: Uint8Array,
  contentType: string,
  client: MediaUploadClientLike,
): Promise<void> {
  let error: unknown;
  try {
    ({ error } = await client.storage
      .from(ref.bucket)
      .upload(ref.path, bytes, { contentType, upsert: false }));
  } catch (cause) {
    throw mediaFailure(
      'whatsapp_media_upload_threw',
      { bucket: ref.bucket, path: ref.path },
      cause,
    );
  }

  if (error !== null && error !== undefined) {
    throw mediaFailure('whatsapp_media_upload_failed', { bucket: ref.bucket, path: ref.path }, error);
  }
}

/* -------------------------------------------------------------------------- */
/* The whole flow                                                              */
/* -------------------------------------------------------------------------- */

export type InboundMediaResult =
  | {
      readonly ok: true;
      /** What `DiagnosisService` (10.4) or `VoiceService` (10.6) receives. */
      readonly ref: StorageRef;
      readonly kind: WhatsappMediaKind;
      /** The stored object's content type — also the `container` the transcribe call needs. */
      readonly mimeType: string;
      readonly bytes: number;
      /** Present when Meta's `sha256` was returned; nothing here verifies it. */
      readonly sha256?: string;
    }
  | { readonly ok: false; readonly refusal: InboundMediaRefusal };

export interface StoreInboundMediaOptions extends MediaFetchOptions {
  /** Narrowed to the two `provisional: true` members — see `InboundMediaContent`. */
  readonly content: InboundMediaContent;
  /** The resolved profile's `auth.users.id`. Becomes the first path segment, and nothing else may. */
  readonly userId: string;
  /** The resolved profile's preferred language, for the refusal reply (Requirement 15.3). */
  readonly language: Language;
  /** Defaults to the service-role client, constructed only when omitted. */
  readonly client?: MediaUploadClientLike;
  /** Injectable for tests, forwarded to `buildStorageRef`. */
  readonly now?: Date;
  readonly objectId?: string;
}

/**
 * Requirements 10.4 and 10.6 end to end: media id → media URL → authenticated binary fetch →
 * admission → service-role upload under `{user_id}/` → a `StorageRef` for the service.
 *
 * ### Finding 1 (U-V12) is handled twice, and neither time by guessing
 *
 * The parameter type admits only a `provisional: true` media result, so an
 * `unconfirmed_media_shape` cannot reach here at all. And because the media id itself is a
 * PROVISIONAL field name, an empty one throws a loud `Error` naming U-V12 and
 * `WHATSAPP_INBOUND_MEDIA_SHAPE` rather than issuing a request for `/{version}/`. That is a
 * defect-shaped failure on purpose: a media id Jamee could not find is a signal that the
 * provisional shape needs the deployment capture, not something to tell a farmer about.
 *
 * ### Admission runs twice, on a claim and then on a fact
 *
 * Step 1's `mime_type` and `file_size` are Meta's *claims*, and they are enough to refuse for
 * free. After the download, the observed byte length and the observed `content-type` (which V14
 * says gives the MIME type) are the *facts*, and they are checked again — a mismatch would
 * otherwise store an object that no downstream check looks at twice. A generic
 * `application/octet-stream` is treated as "no useful answer" rather than as a contradiction,
 * because it says nothing about the bytes and refusing a real photo over it would be wrong.
 */
export async function storeInboundMedia(
  options: StoreInboundMediaOptions,
): Promise<InboundMediaResult> {
  const { content, userId, language } = options;
  const kind: WhatsappMediaKind = content.kind;
  const mediaId = content.mediaId.trim();

  if (mediaId.length === 0) {
    throw new Error(
      `inbound ${kind} message carried no media id. The media id field name is PROVISIONAL ` +
        `(${WHATSAPP_INBOUND_MEDIA_SHAPE.unresolvedItem}, ` +
        `confirmed=${String(WHATSAPP_INBOUND_MEDIA_SHAPE.confirmed)}), so this is the capture ` +
        'signal, not a farmer-facing problem: record the real keys in docs/VERIFIED_VALUES.md ' +
        '(V12) and update provisionalMediaSchema.',
    );
  }

  let metadata = await fetchMediaMetadata(mediaId, options);

  // Free refusal: step 1 already reported the size and type, and no media byte has moved.
  const claimRefusal = admitInboundMedia({
    kind,
    mimeType: metadata.mimeType,
    bytes: metadata.fileSize,
    language,
  });
  if (claimRefusal !== null) return { ok: false, refusal: claimRefusal };

  const binary = await fetchMediaBinary(metadata, mediaId, options, (fresh) => {
    metadata = fresh;
  });

  const observed = usableContentType(binary.contentType);
  const storedMime =
    observed !== undefined && isAdmissibleInboundMime(kind, observed) ? observed : metadata.mimeType;

  const factRefusal = admitInboundMedia({
    kind,
    // When the observed type is usable it describes the bytes, so it is what gets judged.
    mimeType: observed ?? metadata.mimeType,
    bytes: binary.bytes.byteLength,
    language,
  });
  if (factRefusal !== null) return { ok: false, refusal: factRefusal };

  const ref = buildStorageRef({
    bucket: WHATSAPP_MEDIA_BUCKETS[kind],
    userId,
    extension: inboundMediaExtension(kind, storedMime),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.objectId === undefined ? {} : { objectId: options.objectId }),
  });

  await uploadInboundMedia(ref, binary.bytes, storedMime, options.client ?? createAdminClient());

  return {
    ok: true,
    ref,
    kind,
    mimeType: storedMime,
    bytes: binary.bytes.byteLength,
    ...(metadata.sha256 === undefined ? {} : { sha256: metadata.sha256 }),
  };
}

/** Generic binary content types carry no information, so they are read as "not stated". */
const GENERIC_CONTENT_TYPES: readonly string[] = [
  'application/octet-stream',
  'binary/octet-stream',
];

function usableContentType(header: string | null): string | undefined {
  if (header === null) return undefined;
  const base = header.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === '' || GENERIC_CONTENT_TYPES.includes(base)) return undefined;
  return base;
}

/* ========================================================================== */
/* V15 — the send-message call (every farmer-facing reply leaves through here)   */
/* ========================================================================== */

/**
 * Requirements: 10.1 (messages are exchanged exclusively through the official Meta WhatsApp
 *               Business Cloud API), 10.3, 10.9 and every other reply the adapter emits, 15.3
 *               (the text is already localized by the caller — this function never picks copy)
 * Design: "Inbound processing order" step 7
 * Depends on: V15 (endpoint, headers, the text body shape, the 4096-character `body` cap, the
 *             24-hour customer-service window, and the documented fact that a 200 confirms
 *             ACCEPTANCE and not delivery)
 *
 * ### The 24-hour window is open by construction, and that is a claim worth stating
 *
 * V15: a 24-hour service window opens on each inbound user message and resets on the next one;
 * while it is open, free-form text needs no pre-approved template. **Every reply Jamee sends is a
 * direct answer to the inbound message currently being processed**, so the window is open by
 * construction and no template is required for the normal flow. What that argument does *not*
 * cover is a reply emitted long after its inbound message — which is precisely why D11's soft
 * deadline (task 22.3) exists, and why `sendWhatsappText` reports a failure rather than assuming
 * one is impossible: V15 records a known issue where a send can fail inside an apparently open
 * window.
 *
 * ### This function chooses no words
 *
 * `body` arrives already localized, from the caller that knows the farmer's language. Nothing here
 * reads a message catalog, so there is no path by which the send step could put English in front
 * of a Marathi speaker.
 */

/** **V15.** The path segment after the business phone number id. */
export const WHATSAPP_MESSAGES_PATH = 'messages';

/**
 * **V15.** `POST https://graph.facebook.com/{version}/{PHONE_NUMBER_ID}/messages`.
 *
 * The phone number id is the *business* number (`WHATSAPP_PHONE_NUMBER_ID`) rather than the
 * delivery's `metadata.phone_number_id` by default — but the caller may pass the delivery's,
 * which is what the pipeline does: replying from the number that received the message is the
 * behaviour a farmer expects when a business runs more than one, and it needs no environment read.
 */
export function sendMessageUrl(
  phoneNumberId: string,
  options: { readonly apiVersion?: string } = {},
): string {
  const id = phoneNumberId.trim();
  if (id.length === 0) {
    throw new Error(
      'sendMessageUrl was called with an empty phone number id. V15 puts it in the path, so an ' +
        'empty value would POST to /{version}//messages — read WHATSAPP_PHONE_NUMBER_ID through ' +
        'serverEnv() or pass the delivery\u2019s metadata.phone_number_id.',
    );
  }
  return `${graphApiBase(options.apiVersion ?? whatsappApiVersion())}/${encodeURIComponent(id)}/${WHATSAPP_MESSAGES_PATH}`;
}

/** **V15.** The text-message request body, field for field. */
export interface WhatsappTextMessage {
  readonly messaging_product: 'whatsapp';
  readonly recipient_type: 'individual';
  readonly to: string;
  readonly type: 'text';
  readonly text: { readonly body: string; readonly preview_url: false };
}

/**
 * The marker appended to a reply that had to be cut. Localized copy is deliberately NOT used: this
 * is punctuation, not a sentence, so it needs no translation and adding a catalog key for it would
 * put a farmer-facing string in a path that must never fail.
 */
export const WHATSAPP_TRUNCATION_MARKER = '\u2026';

/**
 * Fit a reply inside V15's 4096-character `body` cap.
 *
 * **A cut is a real possibility, not a formality.** A grounded diagnosis carries an explanation
 * plus symptoms, causes, treatment and prevention lists from the knowledge base, and Devanagari
 * text spends its characters faster than the English equivalent for the same content. Exceeding
 * the cap would be answered by Meta with a rejected send, so the farmer would receive **nothing**
 * — strictly worse than a long answer whose tail is missing.
 *
 * The marker replaces the last character rather than being appended past the cap, so the result is
 * always `<= WHATSAPP_TEXT_BODY_MAX_CHARS`. Measured in UTF-16 code units, which is what
 * `String.length` counts; V15 states the cap in "characters" without defining the unit, so the
 * conservative reading is used (a code-unit count is never *lower* than a code-point count, so
 * this cannot overshoot).
 */
export function truncateReplyBody(
  body: string,
  maxChars: number = WHATSAPP_TEXT_BODY_MAX_CHARS,
): string {
  if (body.length <= maxChars) return body;
  return body.slice(0, Math.max(0, maxChars - WHATSAPP_TRUNCATION_MARKER.length)) +
    WHATSAPP_TRUNCATION_MARKER;
}

/**
 * Build the V15 body.
 *
 * `preview_url: false` is stated rather than omitted: Jamee's replies quote knowledge-base
 * citations that can contain a URL, and an unrequested link preview in a farmer's chat is content
 * Jamee did not write and cannot vouch for.
 *
 * An empty `body` throws. Meta would reject it, and a reply with nothing in it is a defect in
 * whichever branch produced it — surfacing that as a send failure would hide the real cause.
 */
export function buildTextMessage(to: string, body: string): WhatsappTextMessage {
  const recipient = to.trim();
  if (recipient.length === 0) {
    throw new Error('buildTextMessage was called with an empty recipient. V15 requires `to`.');
  }
  if (body.trim().length === 0) {
    throw new Error(
      'buildTextMessage was called with an empty body. Every reply branch owes the farmer a ' +
        'sentence, so an empty one is a defect in the caller rather than something to send.',
    );
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'text',
    text: { body: truncateReplyBody(body), preview_url: false },
  };
}

/**
 * **V15** — the send response. Only `messages[].id` is read, and even that is optional: the id is
 * useful in a log line and nothing branches on it, so a documentation drift must not turn a
 * delivered reply into a reported failure.
 */
const sendMessageResponseSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).optional(),
  contacts: z.array(z.unknown()).optional(),
  messaging_product: z.string().min(1).optional(),
});

export type SendReplyResult =
  /**
   * Meta **accepted** the message. V15 is explicit that a 200 is acceptance and not delivery —
   * delivery arrives later as a `statuses[]` webhook, which this codebase acknowledges and
   * ignores. So `ok: true` means "handed over", and `whatsapp_inbound.status = 'processed'`
   * records exactly that and no more.
   */
  | { readonly ok: true; readonly sentMessageId: string | null; readonly bodyChars: number }
  /**
   * The send failed. Handled rather than thrown, because the pipeline's response to it is a
   * status transition and a log line, not a 500: the work is already done and the farmer's quota
   * is already spent, so a redelivery would repeat neither.
   */
  | { readonly ok: false; readonly status: number | null; readonly detail: string };

export interface SendReplyOptions {
  /** The farmer's number. Pass the delivery's own `messages[].from` (the `wa_id`) verbatim. */
  readonly to: string;
  /** Already localized by the caller. Truncated to V15's cap here, never re-worded. */
  readonly body: string;
  /** Defaults to `WHATSAPP_PHONE_NUMBER_ID`, evaluated only when omitted. */
  readonly phoneNumberId?: string;
  /** Defaults to `WHATSAPP_ACCESS_TOKEN`, evaluated only when omitted. */
  readonly accessToken?: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: SendFetchLike;
}

/**
 * `fetch`, narrowed to what a POST with a JSON body needs. Separate from `FetchLike` above because
 * the media steps are GETs and carry no body — widening that type would let a media call be
 * written with a body by accident.
 */
export type SendFetchLike = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
) => Promise<Response>;

/**
 * Send one text reply (**V15**).
 *
 * Never throws for a transport or HTTP reason — see `SendReplyResult`. It *does* throw for a
 * defect in the call itself (an empty recipient, an empty body, an empty phone number id or
 * access token), because those are not conditions a retry or a status transition can address.
 *
 * The response body is read on failure so the log line carries Meta's own error text, and it is
 * truncated: a provider payload belongs in a log, and an unbounded one belongs nowhere. It never
 * reaches a farmer — Requirement 15.6 — because the pipeline's reply copy comes from the catalogs.
 */
export async function sendWhatsappText(options: SendReplyOptions): Promise<SendReplyResult> {
  const payload = buildTextMessage(options.to, options.body);
  const url = sendMessageUrl(options.phoneNumberId ?? serverEnv('WHATSAPP_PHONE_NUMBER_ID'), {
    ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
  });
  const headers = {
    ...metaAuthHeaders(options.accessToken ?? serverEnv('WHATSAPP_ACCESS_TOKEN')),
    'content-type': 'application/json',
  };
  const fetchImpl: SendFetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    return {
      ok: false,
      status: null,
      detail: `send unreachable: ${cause instanceof Error ? cause.message : 'unknown transport error'}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      detail: await describeSendFailure(response),
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Accepted with a body Jamee could not read. The message is handed over either way, and
    // reporting a failure here would mark a delivered reply as undelivered.
    return { ok: true, sentMessageId: null, bodyChars: payload.text.body.length };
  }

  const parsed = sendMessageResponseSchema.safeParse(body);
  const sentMessageId = parsed.success ? (parsed.data.messages?.[0]?.id ?? null) : null;
  return { ok: true, sentMessageId, bodyChars: payload.text.body.length };
}

/** The failure body, bounded. Meta's error text is useful; an unbounded payload in a log is not. */
const SEND_FAILURE_DETAIL_MAX_CHARS = 500;

async function describeSendFailure(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > SEND_FAILURE_DETAIL_MAX_CHARS
      ? `${text.slice(0, SEND_FAILURE_DETAIL_MAX_CHARS)}\u2026`
      : text;
  } catch {
    return 'send rejected and the error body could not be read';
  }
}

/**
 * ### What is deliberately NOT here
 *
 * - **The route** (task 21.2). This module hands back a `Response` for the GET handshake only,
 *   because the handshake's status codes *are* Requirements 11.1 and 11.2. Everything else is a
 *   decision the route renders.
 * - **The idempotency insert** (task 21.3). It writes to Postgres; this module has no database
 *   dependency beyond the storage upload, which is what lets every check above be tested without
 *   one.
 * - **Dispatch, profile resolution, and the reply copy** (task 22.2, in
 *   `src/lib/whatsapp-dispatch.ts`). `storeInboundMedia` returns a `StorageRef` or a refusal
 *   carrying its own reply; `sendWhatsappText` sends a string it is handed. Neither chooses a
 *   service, resolves a profile, touches quota, or moves the `whatsapp_inbound` status.
 *   Requirement 15's "spends nothing" holds because this module has no quota dependency to spend —
 *   which only stays true because the dispatch calls `storeInboundMedia` **before** any reserve.
 * - **The soft deadline** (task 22.3). Nothing here derives a budget or a deadline from anything.
 * - **A confirmed media shape.** `WHATSAPP_INBOUND_MEDIA_SHAPE.confirmed` is still `false`, and
 *   the download path above is written to that: it runs only on a `provisional: true` result and
 *   fails loudly on an absent media id. Resolving U-V12 from a real inbound image and audio
 *   webhook is a deployment step, not a code change here.
 */
