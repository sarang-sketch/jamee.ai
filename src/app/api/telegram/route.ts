import { createHash } from 'node:crypto';

import type { NextRequest } from 'next/server';

import { webhookThrottleTryIncrement } from '@/lib/db/farmer';
import { dispatchTelegramRequest } from '@/lib/telegram-dispatch';
import { minuteWindowKey } from '@/lib/time';

/**
 * `POST /api/telegram` — the Telegram webhook. One verb, and a handler thin enough that it decides
 * nothing a farmer sees: it throttles, hands the request to the dispatch pipeline, and turns the
 * pipeline's one authentication verdict into an HTTP status.
 *
 * Requirements: 10.10 (the whole invocation stays inside the duration ceiling — `maxDuration`, and
 *               the soft deadline the pipeline measures from `requestStartMs`), 10.11 (every
 *               authenticated delivery is acknowledged with 200), 11.2 / 11.3 (the secret-token
 *               header is compared before the body is read, and a bad or missing token is the sole
 *               exception to acknowledge-with-200 — a 401 with the body unparsed), 13.9 (a
 *               per-caller throttle keyed on a hash of the caller address)
 * Design: D11 (process inline, then acknowledge; the record is marked terminal after the reply),
 *         D12 (the secret token, not a body digest, is the authenticity boundary — so
 *         `request.json()` is safe and lives inside the pipeline after the header check), D16 (the
 *         per-caller `webhook_throttle` bound as a cost control, not authentication), D19 (the
 *         `update_id` claim inside the pipeline is the idempotency guard)
 * Depends on: V17/V18 (`maxDuration`, the platform deadline), V24 (the secret-token header)
 *
 * ### This route is deliberately NOT wrapped in `authenticatedRoute`
 *
 * Requirement 1.7's session gate covers the diagnosis, chat, voice and history endpoints. This one
 * carries a secret-token header and no farmer session at all — Telegram is the caller — so gating
 * on `currentUserId()` would take the channel down permanently. The authentication here is the
 * constant-time header comparison inside `dispatchTelegramRequest`, and it is no weaker for being a
 * different mechanism.
 *
 * ### The order of operations is the contract
 *
 *  1. Read the invocation start instant, before anything else, so the pipeline's soft deadline
 *     (D11) is measured from the earliest moment the handler can observe (Requirement 10.10).
 *  2. Throttle by a hash of the platform-reported caller address (D16). A cost control, not an
 *     authentication control — an address is shared behind NAT and forgeable at scale — so it sits
 *     alongside the real defence (the secret token), not instead of it. A throttled caller gets 429
 *     with nothing parsed.
 *  3. Hand the request to `dispatchTelegramRequest`, which verifies the secret token BEFORE reading
 *     the body (Requirement 11.3, D12), then parses, claims the `update_id`, and runs the pipeline.
 *     `authenticated: false` is the 401; every authenticated delivery is acknowledged 200.
 */

/** **V17.** Jamee's own ceiling in seconds — the same the payment webhook route uses. */
export const maxDuration = 60;

/** A webhook is never a cached read: every delivery is dynamic. */
export const dynamic = 'force-dynamic';

/** The per-caller throttle ceiling per minute (D16), matching the payment route's posture. */
const THROTTLE_LIMIT_PER_MINUTE = 60;

/**
 * A sha-256 of the platform-reported caller address — the table retains no raw network identifier
 * (D16). `x-forwarded-for`'s first hop, falling back to `x-real-ip`, then a constant.
 */
function callerHash(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const address = (forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown').toLowerCase();
  return createHash('sha256').update(address, 'utf8').digest('hex');
}

export async function POST(request: NextRequest): Promise<Response> {
  // 1. The invocation start instant — the floor the pipeline's soft deadline is measured from (D11).
  const requestStartMs = Date.now();

  // 2. Per-caller throttle (13.9, D16). A refused caller gets 429 with nothing verified or parsed.
  const allowed = await webhookThrottleTryIncrement(
    'telegram',
    callerHash(request),
    minuteWindowKey(new Date(requestStartMs)),
    THROTTLE_LIMIT_PER_MINUTE,
  );
  if (allowed === null) {
    return new Response(null, { status: 429, headers: { 'cache-control': 'no-store' } });
  }

  // 3. Verify (secret token before the body), parse, claim, dispatch — all inside the pipeline so
  //    the ten-step order lives in one place (D12). The 401 is the sole exception to 200 (11.3).
  const outcome = await dispatchTelegramRequest(request, { requestStartMs });

  if (!outcome.authenticated) {
    return new Response(null, { status: 401, headers: { 'cache-control': 'no-store' } });
  }

  // Requirement 10.11: one 200 for the delivery, after the pipeline reached a terminal status.
  // Per-update outcomes live in `telegram_inbound.status`, not in this body — Telegram reads the
  // status code and nothing else.
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}
