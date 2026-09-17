import { ERROR_SPECS, withErrorHandling } from '@/lib/errors';
import {
  describeSignatureHeader,
  isDeliveryReceiptOnly,
  parseVerifiedInbound,
  readSignatureHeader,
  respondToChallenge,
  verifyInboundRequest,
} from '@/lib/whatsapp';
import { processInboundBatch, SOFT_DEADLINE_DETAIL } from '@/lib/whatsapp-dispatch';

/**
 * The WhatsApp webhook. Two verbs, one route, and nothing in it that decides anything a farmer
 * sees — this handler admits or refuses a request and hands the admitted ones onward.
 *
 * Requirements: 11.1 (a GET carrying the configured verify token echoes the challenge with 200),
 *               11.2 (a differing verify token gets 403), 11.3 (the POST signature is verified
 *               against `WHATSAPP_APP_SECRET` **before** the payload is read as a message),
 *               11.4 (a failed signature is 401 and invokes no shared service), 10.10 (the whole
 *               invocation stays inside the duration ceiling — `maxDuration` below, and D11's soft
 *               deadline measured from the top of the handler), 10.11 (every accepted delivery is
 *               acknowledged with 200)
 * Design: "WhatsApp adapter" → *GET — webhook verification*, *POST — signature verification over
 *         the raw body*, *Inbound processing order*; D11 (process inline, then acknowledge)
 * Depends on: V13 (header name, `sha256=` prefix, HMAC-SHA256 keyed with the App Secret),
 *             V12 (the confirmed inbound envelope), V17 (`export const maxDuration`, seconds)
 *
 * ### This route is deliberately NOT wrapped in `authenticatedRoute`
 *
 * Requirement 1.7's gate covers the diagnosis, chat, voice and history endpoints, which carry a
 * farmer session. This one carries an HMAC signature over the raw body and no session at all —
 * Meta is the caller — so `currentUserId()` is `null` for every legitimate delivery and gating on
 * it would take the channel down permanently. `authenticated-route.test.ts` names the four
 * protected groups and excludes `whatsapp` for exactly this reason; the authentication here is
 * `verifyInboundRequest`, and it is no weaker for being a different mechanism.
 *
 * ### Where the work happens, and what keeps Requirement 11.4 true
 *
 * The POST path admits a delivery and hands it to `processInboundBatch` — the claim, the profile
 * resolution, the type routing, the service calls, the reply and the terminal status all live in
 * `src/lib/whatsapp-dispatch.ts`, because "the route handler stays thin" is the design's own rule
 * and because none of those decisions is an HTTP status code.
 *
 * Requirement 11.4's "invokes no shared service on a failed signature" is structural rather than
 * reviewed: every line that can reach a service sits behind `parseVerifiedInbound`, which accepts
 * only the `VerifiedRawBody` proof, and the proof is obtainable only from `verifyInboundRequest`.
 * The 401 below returns before the parse, so there is no ordering to get wrong.
 *
 * ### D11, and the one thing this handler contributes to it
 *
 * The soft deadline itself lives in `whatsapp-dispatch.ts`, next to the work it bounds. What the
 * route owns is the **instant the invocation began** — read on the first line of the handler, before
 * the body is read, before the HMAC, before the parse. Requirement 10.10 is about the whole
 * invocation, and a budget started where the dispatch happens to begin would quietly exclude
 * whatever the verification and parse cost. Nothing here defers work: **`waitUntil` is deliberately
 * unused** even though V18 confirmed it exists — see the D11 section at the top of
 * `whatsapp-dispatch.ts` for the reasoning, which is that a deferred pipeline's failure signature is
 * silence.
 */

/**
 * **V17.** Jamee's own ceiling, in seconds. The platform permits 300 s
 * (`PLATFORM_MAX_DURATION_SECONDS`); Jamee declines to use it, and every soft timeout in the
 * codebase is a fraction of this number rather than of the platform's — see
 * `docs/PROVIDER_CAPABILITIES.md` section 3 and the comment on `JAMEE_MAX_DURATION_SECONDS`.
 *
 * Written as a literal because Next.js reads route segment config by static analysis, so an
 * imported constant is not usable here. `route.test.ts` asserts this literal equals
 * `JAMEE_MAX_DURATION_SECONDS`, which is what stops the two drifting apart.
 */
export const maxDuration = 60;

/**
 * A webhook is never a cached read. The GET echoes a challenge value that differs per request and
 * the POST is a delivery; serving either from a cache would be a defect, so it is stated rather
 * than left to whatever the framework infers.
 */
export const dynamic = 'force-dynamic';

/* -------------------------------------------------------------------------- */
/* Server-side log                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `console.*` for the same reason `lib/errors.ts` uses it: on the target platform that is what
 * reaches the runtime log, and a logging dependency would put one more thing between an event and
 * its record.
 *
 * **Nothing here logs `fromPhone`, a message body, or a digest.** The sender's number is farmer
 * PII (migration `0008` keeps `whatsapp_inbound` unreachable through the data API for that
 * reason), and a signature digest belongs in no log line — `describeSignatureHeader` exists to
 * report a header's *shape* without echoing it.
 */
function note(event: string, detail: Record<string, unknown>): void {
  console.info(`[jamee] whatsapp.${event}`, JSON.stringify(detail));
}

function warn(event: string, detail: Record<string, unknown>): void {
  console.warn(`[jamee] whatsapp.${event}`, JSON.stringify(detail));
}

/**
 * Requirement 10.11's acknowledgement. Bodyless: Meta reads the status and redelivers on anything
 * that is not a 2xx, and there is no other reader to write a body for.
 */
function acknowledge(): Response {
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}

/* ========================================================================== */
/* GET — the verification handshake (Requirements 11.1, 11.2)                   */
/* ========================================================================== */

export async function GET(request: Request): Promise<Response> {
  /**
   * `respondToChallenge` reads `WHATSAPP_VERIFY_TOKEN` through `serverEnv`, which throws when the
   * variable is absent. That throw must not become a 403: a missing token is a configuration
   * defect, not a caller with the wrong one, and the two need different answers. The wrapper turns
   * it into a 500 with the cause logged server-side and nothing leaked outward, which is the
   * honest report — Meta's dashboard then shows a failed verification instead of Jamee silently
   * refusing a correct token.
   */
  return withErrorHandling(async () => {
    const { response, decision } = respondToChallenge(request);

    if (decision.ok) {
      note('handshake.accepted', { status: response.status });
    } else {
      /**
       * The reason is logged and NOT returned. `respondToChallenge` gives the 403 an empty body on
       * purpose: telling an unauthenticated caller *which* part of the handshake failed separates
       * "your token is wrong" from "your request was malformed", which is an oracle. Server-side it
       * is the one line that distinguishes a misconfigured token from a probe.
       */
      warn('handshake.rejected', { status: response.status, reason: decision.reason });
    }
    return response;
  });
}

/* ========================================================================== */
/* POST — verify, then parse (Requirements 11.3, 11.4, 10.11)                  */
/* ========================================================================== */

export async function POST(request: Request): Promise<Response> {
  /**
   * A bug in here becomes a 500 rather than a 200. That is deliberate: Meta redelivers on a
   * non-2xx, and a redelivery is the correct outcome for work that did not happen. Once task 21.3
   * lands, a redelivery that arrives *after* the idempotency insert is dropped as a duplicate, so
   * this cannot double-spend a farmer's quota either.
   */
  /**
   * **Step 0 — the invocation's start instant, D11's only input from this file.**
   *
   * Outside `withErrorHandling` and above every other statement on purpose: this is the earliest
   * moment the handler can observe, and `processInboundBatch` subtracts everything that follows from
   * the same 45 s. `getDeadline()` (V18) is consulted inside the dispatch and wins when it is
   * tighter, so this number is the floor rather than the whole story — see `resolveInvocationBudget`.
   */
  const requestStartMs = Date.now();

  return withErrorHandling(async () => {
    /**
     * **Step 1 — the body, read ONCE, before anything interprets it.**
     *
     * `arrayBuffer()` rather than `text()`, per the tradeoff `lib/whatsapp.ts` documents. The
     * signature is an HMAC over the exact bytes Meta signed: `text()` decodes UTF-8, and
     * re-encoding is lossless only for well-formed UTF-8 — an invalid byte sequence would already
     * have become U+FFFD, so the digest would be computed over bytes Meta never sent and a
     * legitimate delivery would be rejected. Reading the bytes removes that failure mode
     * entirely, and `verifyInboundRequest` and `parseVerifiedInbound` both accept a `Uint8Array`.
     *
     * `request.json()` is never called anywhere in this file. That is Requirement 11.3's whole
     * point, and `route.test.ts` drives this handler with a request whose `json()` and `text()`
     * throw, so calling one is a test failure rather than a review comment.
     */
    const raw = new Uint8Array(await request.arrayBuffer());

    /**
     * **Step 2 — verification.** `verifyInboundRequest` reads the header by its V13-resolved name,
     * computes the HMAC over exactly the bytes above, compares in constant time, and returns a
     * `VerifiedRawBody` or `null`. Nothing else in this handler can interpret the payload, because
     * `parseVerifiedInbound` accepts only that proof and the webhook schema is not exported.
     */
    const verifiedBody = verifyInboundRequest(request.headers, raw);

    /**
     * The U-V13 deployment capture, logged on both branches. The digest's byte encoding (hex vs.
     * base64) is not stated in Meta's documentation, so `verifySignature` currently accepts
     * either; `matchesEncodingLength` on one real delivery settles it, after which
     * `META_SIGNATURE_ENCODING_CONFIRMED` can be narrowed. The digest itself is never logged.
     */
    const headerShape = describeSignatureHeader(readSignatureHeader(request.headers));

    if (verifiedBody === null) {
      /**
       * Requirement 11.4. 401, and the handler returns here — before the parse, before any
       * profile resolution, before any service. The body is empty for the same reason the
       * handshake's 403 is: there is no farmer on this path to localize for, and naming the
       * failure would tell an unauthenticated caller which half of the check it failed.
       * `WEBHOOK_SIGNATURE_INVALID` still supplies the status, so the taxonomy stays the one
       * place an HTTP code for this condition is written down.
       */
      warn('signature.rejected', { bytes: raw.byteLength, header: headerShape });
      return new Response(null, { status: ERROR_SPECS.WEBHOOK_SIGNATURE_INVALID.status });
    }

    note('signature.accepted', { bytes: raw.byteLength, header: headerShape });

    /** **Step 3 — and only now** is the payload read as a message. */
    const parsed = parseVerifiedInbound(verifiedBody);

    if (!parsed.ok) {
      /**
       * A signed body Jamee cannot read. The signature proves it came from Meta, so it is a
       * genuine delivery rather than an attack, and there is nothing to act on and nothing a
       * redelivery would fix — the same bytes would fail the same way. Acknowledged with 200 and
       * ignored (Requirement 10.11), with the reason kept server-side where a real envelope change
       * would show up as a run of these lines.
       */
      warn('payload.ignored', { reason: parsed.reason, detail: parsed.detail });
      return acknowledge();
    }

    const { batch } = parsed;

    if (isDeliveryReceiptOnly(batch)) {
      /**
       * A business-originated status update, not a farmer message. **V12: `field` is `messages`
       * for both**, so the discriminator is the presence of `value.statuses[]` rather than the
       * field name. Nothing is spent and nothing is recorded: task 21.3's idempotency row keys on
       * a farmer's message id, and a receipt has none.
       */
      note('delivery_receipt.ignored', {
        statusUpdates: batch.statusUpdateCount,
        entries: batch.entryCount,
      });
      return acknowledge();
    }

    /**
     * The U-V12 deployment capture. The per-type sub-object paths for inbound image and audio are
     * unconfirmed, so `parseVerifiedInbound` resolves a media object that does not match Jamee's
     * provisional shape to `unconfirmed_media_shape` carrying the keys that were actually present.
     * This is the line that turns that into something a person can act on: without it, a real
     * image delivery would be acknowledged in silence and the mismatch would only surface as a
     * missing media id inside task 22.1. Field *names*, never values — a caption is farmer content.
     */
    for (const message of batch.messages) {
      if (message.content.kind === 'unconfirmed_media_shape') {
        warn('media_shape.unconfirmed', {
          type: message.content.type,
          observedKeys: message.content.observedKeys,
          issue: message.content.issue,
        });
      }
    }

    note('delivery.accepted', {
      entries: batch.entryCount,
      messages: batch.messages.length,
      statusUpdates: batch.statusUpdateCount,
      ignoredChanges: batch.ignoredChangeCount,
      /** Kinds, not contents. Enough to see what the channel is actually receiving. */
      kinds: batch.messages.map((message) => message.content.kind),
    });

    /* ====================================================================== *
     * Steps 3–8 of the inbound pipeline (design: "Inbound processing order"). *
     *                                                                        *
     *   claim the WAMID  → 21.3, and it is INSIDE processInboundBatch so     *
     *                      nothing above it can be reordered below it        *
     *   resolve profile  → 10.2, 10.3                                        *
     *   route by type    → 10.9's refusal, then the conversation             *
     *   dispatch         → DiagnosisService / ChatService / VoiceService,     *
     *                      each of which takes its own quota reserve         *
     *   send the reply   → V15                                               *
     *   mark terminal    → processed / rejected / failed                     *
     *                                                                        *
     * All of it inside D11's soft deadline, resolved once for the invocation  *
     * from `requestStartMs` above and V18's `getDeadline()`.                  *
     * ====================================================================== */
    /**
     * **No service seam is passed, and that is still the point.**
     *
     * `processInboundBatch` defaults every seam to the real thing — `diagnose`,
     * `chatAnswerer({ supabase, runOptions })`, `transcribeAndAnswer`, `storeInboundMedia`,
     * `sendWhatsappText`, and the service-role client each of them needs. Overriding one here would
     * mean this route had an opinion about how a diagnosis is produced, which is the drift
     * Requirements 16.1 and 16.2 forbid. The seams exist so a unit test can inject stubs, not so a
     * route can choose an implementation.
     *
     * `deadline` is the one thing that *is* passed, and it is not a seam in that sense: it carries a
     * fact only this file knows — when the invocation started — and no implementation choice. The
     * budget arithmetic, the `getDeadline()` call and the per-capability floors all stay in the
     * dispatch, which is where the gateway's constants already are.
     */
    const results = await processInboundBatch(batch.messages, { deadline: { requestStartMs } });

    note('batch.completed', {
      messages: results.length,
      dispositions: results.map((result) => result.disposition),
      repliesSent: results.filter((result) => result.replySent).length,
      /**
       * D11's branch, counted. A non-zero value here on a normal delivery is the signal the section
       * 3 budget no longer fits the observed work — the measured evidence
       * `docs/PROVIDER_CAPABILITIES.md` section 4 names as the trigger for revisiting inline
       * processing. `startsWith` because the pre-flight gate and a mid-flight expiry report the same
       * condition with different suffixes.
       */
      softDeadlineExpired: results.filter((result) => result.detail.startsWith(SOFT_DEADLINE_DETAIL))
        .length,
      elapsedMs: Date.now() - requestStartMs,
    });

    /**
     * Requirement 10.11: one 200 for the delivery, after every message in it has reached a terminal
     * status. Per-message outcomes live in `whatsapp_inbound.status` rather than in this response,
     * because Meta reads the status code and nothing else — a body describing which of ten messages
     * was rejected has no reader.
     */
    return acknowledge();
  });
}
