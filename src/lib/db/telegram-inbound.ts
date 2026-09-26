import 'server-only';

import {
  claimTelegramUpdate,
  resolveProfileByTelegramUserId,
  setTelegramInboundStatus,
} from '@/lib/db/farmer';
import type { ProfileDoc, TelegramInboundStatus, TelegramMessageType } from '@/lib/db/collections';

/**
 * The `telegram_inbound` inbound record, as the dispatch pipeline uses it — the ordered-pipeline
 * half of task 57.1.
 *
 * Requirements: 11.5, 11.6, 11.7, 11.8 (the `update_id` claim is the idempotency guard, and it sits
 *               above anything billable so a redelivery spends nothing), 10.2, 10.3 (the sender is
 *               resolved through the Telegram user id), 10.11 (the record reaches a terminal status
 *               only after the reply is sent — `markProcessed`), 13.6 (the record is reachable only
 *               through the Data_Access_Layer)
 * Design: D11 (claim before anything billable; `markProcessed` after the reply), D13 (sender
 *         resolution is the one legitimate cross-farmer read), D18/D19 (the driver lives in
 *         `src/lib/db`, and the claim's duplicate-key error is the duplicate-delivery signal)
 *
 * =============================================================================
 * WHY THIS MODULE IS THIN, AND WHY IT IS UNDER src/lib/db
 * =============================================================================
 *
 * The three primitives it needs — the `insertOne`-with-`_id = update_id` claim, the terminal-status
 * write, and the sender resolution by `telegram_user_id` — are the NAMED SYSTEM ACCESSORS in
 * `src/lib/db/farmer.ts` (`claimTelegramUpdate`, `setTelegramInboundStatus`,
 * `resolveProfileByTelegramUserId`). Those are ownerless by nature: the claim runs *before* a
 * sender is resolved (11.7), so there is no owner to key on yet, and resolution is precisely how the
 * request acquires one (10.2). `farmer.ts` documents each as a deliberate, greppable exception to
 * the owner-scoped rule, and this task's brief forbids editing `farmer.ts` — so this module does not
 * re-implement them. It re-exports them behind names the dispatch reads as intent (`claimInbound`,
 * `markProcessed`, …), keeping the driver and the raw collection handle inside `src/lib/db`
 * (D18/D13.6) while giving the pipeline a vocabulary that matches the design's ten-step order.
 *
 * There is no farmer-scoped accessor here and therefore no `owned()`/`stampOwner()` call: every
 * function below is an explicitly named SYSTEM path, because the Telegram inbound record has no
 * owner at claim time and its owner (once resolved) is written as the terminal status's `ownerId`
 * argument, not merged into a query filter. That is the same discipline `farmer.ts` applies to the
 * payment-webhook and retention paths.
 */

/**
 * Step 2 of the inbound order (design "Inbound processing order"): claim the `update_id` by
 * `insertOne` with `_id = update_id`, whose `11000` duplicate-key error IS the duplicate-delivery
 * signal (D19). Runs before anything billable (11.5–11.7). Returns `true` on a fresh claim, `false`
 * on a duplicate — a duplicate is logged and answered 200 with zero quota and no service call.
 *
 * `telegramUserId` is `null` when the update carried no sender (the `other` kind); `messageType`
 * records what the update was, so a duplicate's row already says which kind it claimed.
 */
export async function claimInbound(
  updateId: number,
  telegramUserId: number | null,
  messageType: TelegramMessageType,
): Promise<boolean> {
  return claimTelegramUpdate(updateId, telegramUserId, messageType);
}

/**
 * Step 4: resolve the sending Telegram user id to a Profile (10.2). The one legitimate cross-farmer
 * read — at this point the request has no owner and resolution is how it acquires one (D13). Returns
 * `null` for an unlinked sender, which the pipeline turns into the linking instructions + the
 * `unlinked` terminal status.
 */
export async function resolveSender(telegramUserId: number): Promise<ProfileDoc | null> {
  return resolveProfileByTelegramUserId(telegramUserId);
}

/**
 * Step 10: move the claimed record to `processed` — called ONLY after the reply is sent (D11), so a
 * row marked `processed` is a row whose farmer got an answer. `ownerId` is the resolved farmer's id
 * (a processed update always has one), recorded on the record so a later redelivery's
 * `duplicate_ignored` audit line can be attributed.
 */
export async function markProcessed(updateId: number, ownerId: string): Promise<void> {
  await setTelegramInboundStatus(updateId, 'processed', ownerId);
}

/**
 * The unlinked terminal status (step 4): the sender resolved to no Profile. The reply is the linking
 * instructions and no shared service ran, so `ownerId` is `null` — there is no farmer to attribute
 * it to, which is exactly what "unlinked" records.
 */
export async function markUnlinked(updateId: number): Promise<void> {
  await setTelegramInboundStatus(updateId, 'unlinked', null);
}

/**
 * The not-entitled terminal status (step 5): the farmer is linked but holds no unexpired
 * entitlement. `ownerId` is the resolved farmer — the gate ran after resolution — so the record is
 * attributable even though no model operation completed (design: "gated and unlinked updates are
 * recorded through the status alone").
 */
export async function markNotEntitled(updateId: number, ownerId: string): Promise<void> {
  await setTelegramInboundStatus(updateId, 'not_entitled', ownerId);
}

/**
 * The rejected terminal status (step 6): an authenticated, entitled delivery whose content is a
 * type Jamee does not act on (not text/photo/voice — Requirement 10.9). `ownerId` is the resolved
 * farmer.
 */
export async function markRejected(updateId: number, ownerId: string): Promise<void> {
  await setTelegramInboundStatus(updateId, 'rejected', ownerId);
}

/**
 * The failed terminal status (D11's soft-deadline branch, and any dispatch failure after the claim):
 * the record is marked `failed` rather than `processed`, which keeps the audit honest and lets the
 * farmer's next send — carrying a new `update_id` — be processed normally. `ownerId` may be `null`
 * when the failure occurred before resolution, or the resolved farmer's id when it occurred after.
 */
export async function markFailed(updateId: number, ownerId: string | null): Promise<void> {
  await setTelegramInboundStatus(updateId, 'failed', ownerId);
}

export type { TelegramInboundStatus, TelegramMessageType };
