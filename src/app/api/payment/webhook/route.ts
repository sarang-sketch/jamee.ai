import 'server-only';

import { createHash } from 'node:crypto';

import type { NextRequest } from 'next/server';

import { webhookThrottleTryIncrement } from '@/lib/db/farmer';
import { serverEnv } from '@/lib/env';
import { minuteWindowKey } from '@/lib/time';
import {
  RAZORPAY_SIGNATURE_HEADER,
  parsePaymentWebhook,
  verifyWebhookSignature,
} from '@/lib/razorpay';
import { processVerifiedWebhook } from '@/services/payment.service';

/**
 * `POST /api/payment/webhook` — the Razorpay payment webhook.
 *
 * Requirements: 13.9 (a per-caller throttle keyed on a hash of the caller address), 22.5 (the
 *               signature is verified over the RAW body before any parse), 22.6 (a missing header
 *               or an unconfigured secret is a 401 — never a skipped check), 22.7–22.12 (a captured
 *               payment grants and extends exactly once; a redelivery is a verified duplicate
 *               answered 200), 22.19 (a failed payment records nothing), 22.24 (no farmer session
 *               is consulted — the signature is the whole boundary)
 * Design: D15 (signature over raw bytes; an absent secret is a failed verification; who paid comes
 *         from the recorded order, never the payload), D16 (the per-caller throttle), D19 (the
 *         grant-plus-extend transaction)
 *
 * `maxDuration = 60` — the same ceiling the other webhook route uses.
 *
 * =============================================================================
 * THE ORDER OF OPERATIONS IS THE CONTRACT
 * =============================================================================
 *
 *  1. Read the body ONCE as text. `request.json()` would discard the exact bytes Razorpay signed;
 *     re-serialising the parsed object does not reproduce them (key order, whitespace, unicode
 *     escaping all differ), so the raw string is the only thing that can verify.
 *  2. Throttle by a hash of the platform-reported caller address (D16). This is a cost control, not
 *     an authentication control — an address is shared behind NAT and forgeable at scale — so it
 *     sits alongside the real defence (the signature), not instead of it. A throttled caller gets
 *     429 with nothing parsed.
 *  3. Verify the signature over the raw body in constant time. A missing header returns `false`; an
 *     unconfigured secret makes `serverEnv` throw, which lands in the SAME 401 branch — there is no
 *     `if (secret) verify(...)` path, so a forgotten variable cannot become a deployment where
 *     anyone can grant an entitlement.
 *  4. Only now parse, and process. The grant derives the paying farmer from the recorded order, not
 *     the payload (D15); a verified duplicate changes nothing and is answered 200.
 */

export const maxDuration = 60;

const THROTTLE_LIMIT_PER_MINUTE = 60;

/** A sha-256 of the platform-reported caller address — the table retains no raw network identifier (D16). */
function callerHash(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const address = (forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown').toLowerCase();
  return createHash('sha256').update(address, 'utf8').digest('hex');
}

export async function POST(request: NextRequest): Promise<Response> {
  // 1. Raw body first, before any parse (22.5).
  const rawBody = await request.text();

  // 2. Per-caller throttle (13.9, D16). A refused caller gets 429 with nothing parsed.
  const now = new Date();
  const allowed = await webhookThrottleTryIncrement(
    'payment',
    callerHash(request),
    minuteWindowKey(now),
    THROTTLE_LIMIT_PER_MINUTE,
  );
  if (allowed === null) {
    return new Response(null, { status: 429 });
  }

  // 3. Verify the signature over the raw bytes (22.5, 22.6). A missing header, a wrong signature,
  //    and an unconfigured secret all land here as 401 — the unconfigured-secret case because
  //    `serverEnv` throws, which this catch turns into the same refusal.
  let verified = false;
  try {
    const secret = serverEnv('RAZORPAY_WEBHOOK_SECRET');
    verified = verifyWebhookSignature(rawBody, request.headers.get(RAZORPAY_SIGNATURE_HEADER), secret);
  } catch {
    verified = false;
  }
  if (!verified) {
    return new Response(null, { status: 401 });
  }

  // 4. Parse the now-trusted body and process. A body Jamee does not act on (an event outside
  //    captured/failed, or a shape mismatch) is acknowledged 200 and ignored — it is a verified
  //    delivery Jamee simply has no work for.
  const parsed = parsePaymentWebhook(rawBody, request.headers);
  if (!parsed.ok) {
    return new Response(null, { status: 200 });
  }

  await processVerifiedWebhook(parsed.webhook, now);

  // Every verified delivery — a fresh grant, a duplicate, an unmatched order, a failure — is
  // answered 200 so the provider does not redeliver (22.10, 22.11).
  return new Response(null, { status: 200 });
}
