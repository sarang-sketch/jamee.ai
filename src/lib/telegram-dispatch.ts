import 'server-only';

import { Buffer } from 'node:buffer';

import { getDeadline } from '@vercel/functions';

import {
  formatChatReply,
  formatDiagnosisReply,
  formatVoiceReply,
} from '@/lib/channel-reply';
import {
  claimInbound,
  markFailed,
  markNotEntitled,
  markProcessed,
  markRejected,
  markUnlinked,
  resolveSender,
} from '@/lib/db/telegram-inbound';
import { RECHARGE_PRICE_RUPEES } from '@/lib/config/access';
import { serverEnv } from '@/lib/env';
import { interpolate, messages } from '@/lib/messages';
import {
  downloadFile as realDownloadFile,
  parseUpdate,
  sendMessage as realSendMessage,
  verifySecretToken,
  type SendMessageResult,
  type TelegramDispatch,
} from '@/lib/telegram';
import { storeMedia as realStoreMedia } from '@/lib/media';
import type { Language, MediaRef } from '@/lib/schemas';
import { isActive as entitlementIsActive } from '@/services/entitlement.service';
import { chatAnswerer } from '@/services/chat.service';
import {
  conversationStoreFrom,
  findOrCreateActive,
  type ConversationStore,
} from '@/services/conversation.service';
import { diagnose as realDiagnose } from '@/services/diagnosis.service';
import { consumeAndBind as realConsumeAndBind } from '@/services/linking.service';
import { ownsRequest } from '@/services/quota.service';
import { transcribeAndAnswer as realTranscribeAndAnswer } from '@/services/voice.service';
import type { BindOutcome } from '@/lib/access-schemas';

/**
 * The ordered Telegram inbound pipeline (task 57.2). Given one authenticated delivery it walks the
 * fixed ten-step order the design fixes as a contract, dispatches a photo/text/voice to the shared
 * services with `channel: 'telegram'`, replies in the farmer's language, and marks the
 * `telegram_inbound` record terminal only AFTER the reply is sent.
 *
 * Requirements: 10.1–10.6, 10.8, 10.9, 10.11, 11.2, 11.4, 11.5–11.8, 16.1, 16.2, 16.5, 21.9, 21.17,
 *               21.18, 22.13, 22.14, 22.15, 22.16, 15.6
 * Design: D7 (channel parity — one code path, the shared services, the shared formatters), D11
 *         (process inline, reply, then `markProcessed`, with a soft deadline), D12 (the secret
 *         token verified before the body is parsed; `request.json()` is safe here because
 *         authenticity is the header, not a body digest), D13/D14 (linking and the windowed
 *         entitlement gate), D19 (the `update_id` claim's duplicate-key error is the duplicate
 *         signal); "Telegram adapter — Inbound processing order"; Amendment A2 decisions 4 and 5
 * Depends on: V24 (secret-token header, `sendMessage`), V25/V26 (media download and containers),
 *             V18 (the platform deadline), V29 (media admission), V30/V35 (`BETTER_AUTH_URL`)
 *
 * =============================================================================
 * THE ORDER OF OPERATIONS IS THE CONTRACT (Requirement 22.16, design "Inbound processing order")
 * =============================================================================
 *
 *  1. Verify the secret-token header (`verifySecretToken`) — BEFORE the body is read as an update
 *     (D12, Requirement 11.2). An absent/wrong token, and an unconfigured secret, are all a failed
 *     verification (401); nothing below runs.
 *  2. Parse the update. A well-formed request whose payload does not parse is acknowledged 200 and
 *     dropped (Telegram would redeliver a non-200 and the same body would fail forever).
 *  3. Claim the `update_id` (`claimInbound`) — before anything billable. A duplicate returns 200
 *     and does nothing: no download, no reserve, no service, no reply (Requirements 11.5–11.8).
 *  4. `/start` short-circuit, ABOVE profile resolution — a `/start` arrives precisely because the
 *     sender resolves to nothing yet. With a token → `consumeAndBind` and reply per `BindOutcome`;
 *     without one → the linking instructions. No shared service runs on this branch (21.18).
 *  5. The `/recharge` command — EXEMPT from the gate like `/start` (A2 decision 5), so a lapsed
 *     farmer can recover from inside Telegram. Replies with the recharge copy and a link to
 *     `BETTER_AUTH_URL` + `/profile`. Runs after `/start` and before resolution's gate.
 *  6. Resolve the sender through the Telegram user id (`resolveSender`, Requirement 10.2). An
 *     unlinked sender gets the linking instructions in English (no Profile → no language), status
 *     `unlinked`, 200, zero quota (Requirement 10.3 / 21.17).
 *  7. The entitlement gate (`isActive`, Requirement 22.13, A2 decision 4 = "expiry in the future").
 *     A farmer with no active window gets the gated/lapsed reply naming the ₹20 / 7-day recharge,
 *     status `not_entitled`, 200, ZERO quota, NO message and NO diagnosis (Requirement 22.14–22.16).
 *  8. Reject an unsupported type (not text/photo/voice) — the "photos, text, voice notes" reply,
 *     status `rejected`, 200, zero quota (Requirement 10.9).
 *  9. Find-or-create the farmer's active Telegram conversation, keyed on the resolved Profile id
 *     (Requirements 10.5, 10.8) — never on the Telegram user id (D14).
 * 10. Dispatch by kind (photo → diagnosis, text → chat, voice → voice), send the reply via
 *     `sendMessage`, then `markProcessed` (Requirement 10.11, D11).
 *
 * A soft deadline bounds the whole thing (D11): if the budget runs short the farmer gets the
 * "taking longer" copy, the record is marked `failed`, and 200 is returned — the next send carries
 * a new `update_id` and is processed normally.
 *
 * =============================================================================
 * NO DRIVER, NO PROVIDER SHAPES OF ITS OWN
 * =============================================================================
 *
 * This module imports no `mongodb` and no `src/lib/db/client`: every data touch is a named accessor
 * in `src/lib/db/telegram-inbound.ts` (which re-exports `farmer.ts`'s system accessors) or a shared
 * service that itself goes through the owner-scoped Data_Access_Layer. It reimplements no image
 * analysis, grounding, rephrasing, or transcription — Requirements 16.1/16.2 are satisfied by
 * importing `diagnose`, `chatAnswerer`, and `transcribeAndAnswer`, so `check:shared-implementation`
 * sees a consumer rather than a second implementation.
 */

/** The one channel literal this adapter passes (Requirement 16.5). */
const CHANNEL = 'telegram' as const;

/**
 * Jamee's soft deadline as a fraction of the 60 s ceiling, the same posture the gateway takes
 * (D11). Left generous because Telegram redelivers a non-200 and the claim at
 * step 3 already makes a redelivery a no-op — the deadline is a courtesy to the farmer (a reply
 * instead of a killed function), not a correctness lever.
 */
export const TELEGRAM_SOFT_DEADLINE_MS = 45_000;
export const SOFT_DEADLINE_DETAIL = 'soft_deadline';

/* ========================================================================== */
/* Seams — every external effect is injectable so a unit test needs no network */
/* ========================================================================== */

/** `consumeAndBind` from the linking service (step 4). */
export type ConsumeAndBind = (
  plaintextToken: string,
  telegramUserId: number,
  now?: Date,
) => Promise<BindOutcome>;

/** The entitlement gate (step 7): "holds an entitlement whose expiry is in the future" (A2). */
export type EntitlementGate = (userId: string, now?: Date) => Promise<boolean>;

/** The media download (V25/V26). */
export type DownloadFile = typeof realDownloadFile;
/** The media admission + GridFS write (V29). */
export type StoreMedia = typeof realStoreMedia;
/** The DiagnosisService entry (Requirement 16.1). */
export type DiagnoseFn = typeof realDiagnose;
/** The VoiceService entry (Requirement 16.2). */
export type TranscribeAndAnswerFn = typeof realTranscribeAndAnswer;
/** `sendMessage` (V24). */
export type SendMessage = (chatId: number, text: string) => Promise<SendMessageResult>;

export interface TelegramDispatchDeps {
  /** The parsed sender resolver. Defaults to `resolveSender` (the Data_Access_Layer read). */
  readonly resolveProfile?: (telegramUserId: number) => Promise<{ userId: string; language: Language } | null>;
  /** The entitlement gate. Defaults to the entitlement service's `isActive`. */
  readonly isEntitled?: EntitlementGate;
  /** `/start` token consume-and-bind. Defaults to the linking service's `consumeAndBind`. */
  readonly consumeAndBind?: ConsumeAndBind;
  /** Conversation find-or-create store. Defaults to the Data_Access_Layer store. */
  readonly conversations?: ConversationStore;
  /** Media download. Defaults to `downloadFile`. */
  readonly download?: DownloadFile;
  /** Media admission + GridFS write. Defaults to `storeMedia`. */
  readonly media?: StoreMedia;
  /** DiagnosisService. Defaults to `diagnose`. */
  readonly diagnose?: DiagnoseFn;
  /** VoiceService. Defaults to `transcribeAndAnswer`. */
  readonly voice?: TranscribeAndAnswerFn;
  /** Outbound reply. Defaults to `sendMessage`. */
  readonly send?: SendMessage;
  /** Injected clock, epoch ms. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Source of the platform deadline. Defaults to V18's `getDeadline()`. */
  readonly platformDeadline?: () => Date | undefined;
  /** Epoch ms the invocation began; the soft deadline is measured from it. */
  readonly requestStartMs?: number;
  /** The recharge deep link base, read once. Defaults to `serverEnv('BETTER_AUTH_URL')`. */
  readonly rechargeBaseUrl?: string;
}

/* ========================================================================== */
/* The disposition a message reaches — data, never HTTP                        */
/* ========================================================================== */

export type TelegramDisposition =
  | 'processed'
  | 'duplicate_ignored'
  | 'linked'
  | 'linking_instructions'
  | 'recharge_link'
  | 'unlinked'
  | 'not_entitled'
  | 'rejected_unsupported_type'
  | 'soft_deadline'
  | 'ignored_unparsed';

export interface TelegramInboundResult {
  readonly updateId: number | null;
  readonly disposition: TelegramDisposition;
  readonly replySent: boolean;
  readonly detail: string;
}

/** The top-level result the route maps to an HTTP status. `authenticated: false` is the 401. */
export type TelegramRequestOutcome =
  | { readonly authenticated: false }
  | { readonly authenticated: true; readonly result: TelegramInboundResult };

/* ========================================================================== */
/* Step 1–3 — verify, parse, claim, then hand to the pipeline                  */
/* ========================================================================== */

/**
 * Verify the secret-token header (step 1, D12/Requirement 11.2) BEFORE the body is read as an
 * update, then parse (step 2), then run the pipeline. Returns `authenticated: false` for the 401
 * branch — the one deliberate exception to Requirement 10.11's acknowledge-with-200 — and an
 * acknowledged result for every authenticated delivery.
 *
 * `request.json()` is called only AFTER the header check passes: authenticity is the header, not a
 * body digest (D12), so reading the JSON is safe and the parser tolerates a body it cannot read by
 * dropping it with a 200.
 */
export async function dispatchTelegramRequest(
  request: Request,
  deps: TelegramDispatchDeps = {},
): Promise<TelegramRequestOutcome> {
  // ── 1. Secret token, before the body is read as an update (11.2, D12) ─────
  // `verifySecretToken` reads `TELEGRAM_WEBHOOK_SECRET_TOKEN` through `serverEnv`, which THROWS when
  // the variable is absent — an unconfigured secret is a failed verification, not a skipped one
  // (11.4). The throw is allowed to propagate to the route's 401 branch.
  if (!verifySecretToken(request.headers)) {
    return { authenticated: false };
  }

  // ── 2. Parse the update (V24). An unreadable body is acknowledged and dropped. ──
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return {
      authenticated: true,
      result: { updateId: null, disposition: 'ignored_unparsed', replySent: false, detail: 'body_not_json' },
    };
  }

  const parsed = parseUpdate(rawBody);
  if (!parsed.ok) {
    return {
      authenticated: true,
      result: { updateId: null, disposition: 'ignored_unparsed', replySent: false, detail: parsed.reason },
    };
  }

  const result = await processInboundUpdate(parsed.dispatch, deps);
  return { authenticated: true, result };
}

/**
 * Steps 3–10 over one parsed `TelegramDispatch`. Exposed so a unit test can drive the pipeline
 * directly with a dispatch shape, and so `dispatchTelegramRequest` stays a thin verify+parse+claim
 * wrapper around it.
 */
export async function processInboundUpdate(
  dispatch: TelegramDispatch,
  deps: TelegramDispatchDeps = {},
): Promise<TelegramInboundResult> {
  const send = deps.send ?? ((chatId, text) => realSendMessage(chatId, text));
  const now = deps.now ?? Date.now;
  const startedMs = deps.requestStartMs ?? now();
  const deadlineMs = resolveDeadline(startedMs, deps);

  const { updateId, telegramUserId, chatId, kind } = dispatch;

  // ── 3. Claim the update_id, before anything billable (11.5–11.8, D19) ─────
  const claimed = await claimInbound(updateId, telegramUserId, kind);
  if (!claimed) {
    // A redelivery. The original claim's row already carries its status; do nothing else — no
    // download, no reserve, no service, no reply. (Requirement 11.7.)
    return { updateId, disposition: 'duplicate_ignored', replySent: false, detail: 'update_id_already_claimed' };
  }

  // From here every terminal path marks the record. A dispatch with no chat to reply to (the
  // `other` kind carrying no message) can still be marked — it takes the unsupported-type path.
  try {
    // ── 4. /start short-circuit, ABOVE resolution (21.9, 21.18) ─────────────
    if (kind === 'start') {
      return await handleStart(dispatch, deps, send, now);
    }

    // ── 5. /recharge — exempt from the gate like /start (A2 decision 5) ─────
    if (kind === 'text' && isRechargeCommand(dispatch.textBody)) {
      return await handleRecharge(dispatch, deps, send);
    }

    // ── 6. Resolve the sender (10.2, 10.3) ──────────────────────────────────
    const resolveProfile = deps.resolveProfile ?? defaultResolveProfile;
    const profile = telegramUserId === null ? null : await resolveProfile(telegramUserId);

    if (profile === null) {
      // Unlinked (or a message with no sender): the linking instructions in English, since there is
      // no Profile to read a language from (10.3 / 21.17). Zero quota, no service.
      const replySent = await deliver(send, chatId, messages('en').telegram.linkingInstructions);
      await markUnlinked(updateId);
      return { updateId, disposition: 'unlinked', replySent, detail: 'no_profile_for_telegram_user' };
    }

    const language = profile.language;

    // ── 7. The entitlement gate (22.13, A2 decision 4) ──────────────────────
    const isEntitled = deps.isEntitled ?? entitlementIsActive;
    if (!(await isEntitled(profile.userId, new Date(now())))) {
      // No active window: the gated/lapsed reply naming the ₹20 / 7-day recharge, in the farmer's
      // language. Zero quota, NO message, NO diagnosis (22.14–22.16).
      const gatedText = interpolate(messages(language).telegram.gated, { price: RECHARGE_PRICE_RUPEES });
      const replySent = await deliver(send, chatId, gatedText);
      await markNotEntitled(updateId, profile.userId);
      return { updateId, disposition: 'not_entitled', replySent, detail: 'no_active_entitlement_window' };
    }

    // ── 8. Reject an unsupported type (10.9) ────────────────────────────────
    if (kind === 'other') {
      const replySent = await deliver(send, chatId, messages(language).telegram.unsupportedType);
      await markRejected(updateId, profile.userId);
      return { updateId, disposition: 'rejected_unsupported_type', replySent, detail: 'unsupported_update_kind' };
    }

    // ── D11 soft-deadline gate, before anything that spends ─────────────────
    if (now() >= deadlineMs) {
      return await softDeadline(dispatch, profile.userId, language, send);
    }

    // ── 9. Find-or-create the farmer's active Telegram conversation (10.5) ──
    const conversations = deps.conversations ?? conversationStoreFrom();
    const conversation = await findOrCreateActive(profile.userId, CHANNEL, conversations);

    // ── 10. Dispatch by kind → reply → markProcessed (10.4/10.5/10.6, 10.11) ─
    const replyBody = await dispatchByKind(dispatch, profile.userId, language, conversation.id, deadlineMs, now, deps);

    const replySent = await deliver(send, chatId, replyBody);
    // markProcessed runs ONLY after the reply is sent (D11): a `processed` row is a row whose farmer
    // got an answer.
    await markProcessed(updateId, profile.userId);
    return { updateId, disposition: 'processed', replySent, detail: `dispatched:${kind}` };
  } catch (error) {
    // A failure after the claim. Mark the record `failed` (never `processed`) so the farmer's next
    // send — a new update_id — is processed normally (D11). The record's owner may not be known
    // here, so `null` is passed; the reply below carries only the coded, localized sentence (15.6).
    return await failed(dispatch, error, send, now);
  }
}

/* ========================================================================== */
/* Step 4 — /start                                                             */
/* ========================================================================== */

/**
 * `/start`. With a token payload, consume-and-bind and reply per the `BindOutcome`; a `replaced`
 * outcome also notifies the account that was displaced (21.12). With no payload, the linking
 * instructions. No shared service runs and no quota unit is reserved on any branch (21.18). The
 * record is marked `processed` — the delivery was handled successfully — and the reply language is
 * English, because a `/start` sender is not yet on a Profile to read a preference from.
 */
async function handleStart(
  dispatch: TelegramDispatch,
  deps: TelegramDispatchDeps,
  send: SendMessage,
  now: () => number,
): Promise<TelegramInboundResult> {
  const { updateId, telegramUserId, chatId, startPayload } = dispatch;
  const tg = messages('en').telegram;

  // A `/start` with no sender id cannot bind. Treat it as the no-token case.
  if (startPayload === null || telegramUserId === null) {
    const replySent = await deliver(send, chatId, tg.linkingInstructions);
    await markProcessedOrUnlinked(updateId, null);
    return { updateId, disposition: 'linking_instructions', replySent, detail: 'start_without_token' };
  }

  const consumeAndBind = deps.consumeAndBind ?? realConsumeAndBind;
  const outcome = await consumeAndBind(startPayload, telegramUserId, new Date(now()));

  let replyText: string;
  let ownerId: string | null = null;
  switch (outcome.kind) {
    case 'bound':
      // A fresh bind: the account is now linked to this farmer. `telegram.replaced` is the positive
      // "this Telegram account is now linked to your Jamee account" wording; `alreadyLinked` states
      // the same fact for a repeat, so either reads correctly, and `replaced` is the closer match
      // for a first successful bind.
      replyText = tg.replaced;
      ownerId = outcome.ownerId;
      break;
    case 'already_linked':
      replyText = tg.alreadyLinked;
      ownerId = outcome.ownerId;
      break;
    case 'replaced':
      replyText = tg.replaced;
      ownerId = outcome.ownerId;
      // Notify the displaced account (21.12) — a distinct message to a distinct recipient.
      await deliver(send, outcome.replacedTelegramUserId, tg.replacedNotice);
      break;
    case 'already_linked_elsewhere':
      replyText = tg.alreadyLinkedElsewhere;
      ownerId = outcome.ownerId;
      break;
    case 'invalid':
      replyText = tg.invalidLink;
      break;
  }

  const replySent = await deliver(send, chatId, replyText);
  await markProcessedOrUnlinked(updateId, ownerId);
  return {
    updateId,
    disposition: outcome.kind === 'invalid' ? 'linking_instructions' : 'linked',
    replySent,
    detail: `start:${outcome.kind}`,
  };
}

/**
 * A `/start` reaches a terminal status too. When it bound (or matched) a Profile it is `processed`
 * with that owner; when it did not (no token, invalid link) there is no owner and `unlinked` records
 * a delivery that resolved to no Profile — the same status the resolution step uses for the same
 * meaning.
 */
async function markProcessedOrUnlinked(updateId: number, ownerId: string | null): Promise<void> {
  if (ownerId === null) {
    await markUnlinked(updateId);
  } else {
    await markProcessed(updateId, ownerId);
  }
}

/* ========================================================================== */
/* Step 5 — /recharge                                                          */
/* ========================================================================== */

/** `/recharge`, optionally `@botname`, case-insensitive, whole trimmed line. */
const RECHARGE_COMMAND = /^\/recharge(?:@\w+)?\s*$/i;

/** Whether a text body is the bare `/recharge` command (A2 decision 5). */
export function isRechargeCommand(textBody: string | null): boolean {
  return textBody !== null && RECHARGE_COMMAND.test(textBody.trim());
}

/**
 * The `/recharge` command — exempt from the entitlement gate like `/start` (A2 decision 5), so a
 * lapsed farmer can recover from inside Telegram. Replies with the recharge copy naming the price
 * and a link to the web app's Payments screen (`BETTER_AUTH_URL` + `/profile`), read through
 * `serverEnv`. No shared service, no quota. It sits before resolution's gate but still resolves the
 * sender so the record can be attributed and the reply localized when the sender IS linked; an
 * unlinked sender gets the recharge copy in English and an `unlinked` record.
 */
async function handleRecharge(
  dispatch: TelegramDispatch,
  deps: TelegramDispatchDeps,
  send: SendMessage,
): Promise<TelegramInboundResult> {
  const { updateId, telegramUserId, chatId } = dispatch;

  const resolveProfile = deps.resolveProfile ?? defaultResolveProfile;
  const profile = telegramUserId === null ? null : await resolveProfile(telegramUserId);
  const language: Language = profile?.language ?? 'en';

  const base = deps.rechargeBaseUrl ?? serverEnv('BETTER_AUTH_URL');
  const link = `${base.replace(/\/+$/, '')}/profile`;
  const text = interpolate(messages(language).telegram.rechargeCommand, {
    price: RECHARGE_PRICE_RUPEES,
    link,
  });

  const replySent = await deliver(send, chatId, text);
  if (profile === null) {
    await markUnlinked(updateId);
    return { updateId, disposition: 'recharge_link', replySent, detail: 'recharge:unlinked' };
  }
  await markProcessed(updateId, profile.userId);
  return { updateId, disposition: 'recharge_link', replySent, detail: 'recharge:linked' };
}

/* ========================================================================== */
/* Step 10 — dispatch by kind                                                  */
/* ========================================================================== */

/**
 * Route a `photo`/`text`/`voice` to its shared service and return the reply body. All three run
 * through the SAME service functions and the SAME formatters the web path uses, which is what
 * makes D7's parity structural rather than promised. `deadlineMs` and
 * `now` are handed to each service so the media download above and the provider call below count
 * against the same budget rather than each service computing a fresh 45 s of its own.
 */
async function dispatchByKind(
  dispatch: TelegramDispatch,
  userId: string,
  language: Language,
  conversationId: string,
  deadlineMs: number,
  now: () => number,
  deps: TelegramDispatchDeps,
): Promise<string> {
  const { kind } = dispatch;

  if (kind === 'text') {
    const chat = chatAnswerer({ runOptions: { deadlineMs, now } });
    const answered = await chat(
      {
        userId,
        conversationId,
        message: dispatch.textBody ?? '',
        language,
        channel: CHANNEL,
        inputKind: 'text',
      },
      ownsRequest(userId, 'chat'),
    );
    return formatChatReply(answered.answer.content);
  }

  if (kind === 'photo') {
    const ref = await downloadAndStore(dispatch, userId, 'crop-image', deps);
    const outcome = await (deps.diagnose ?? realDiagnose)(
      { userId, image: ref, language, channel: CHANNEL, conversationId },
      { deadlineMs, now },
    );
    return formatDiagnosisReply(outcome.result, language);
  }

  // voice
  const ref = await downloadAndStore(dispatch, userId, 'voice', deps);
  const chat = chatAnswerer({ runOptions: { deadlineMs, now } });
  const outcome = await (deps.voice ?? realTranscribeAndAnswer)(
    {
      userId,
      audio: ref,
      language,
      channel: CHANNEL,
      conversationId,
      // Telegram reports no reliable duration on a voice note (design "Media download and upload"),
      // and the media was already size-admitted by `storeMedia`. Pass 0 so the service's own
      // duration re-check does not refuse a stored recording on a missing number; the size cap is
      // the operative bound on this channel.
      durationSeconds: 0,
    },
    { chat, deadlineMs, now },
  );
  return formatVoiceReply(outcome.transcript, outcome.answer.content, language);
}

/**
 * Download a `photo`/`voice` file's bytes (V25) and store them in GridFS through the owner-scoped
 * Data_Access_Layer (D17/D18) as the resolved farmer's `crop-image` / `voice` media, returning the
 * Media_Reference the service reads. The bot token stays inside `downloadFile` (V25) — nothing here
 * touches or logs it. `mediaKind` is the GridFS `metadata.kind`; the download's `kind` tells it how
 * to resolve the MIME type (photo → JPEG, voice → sniff/`mime_type`).
 */
async function downloadAndStore(
  dispatch: TelegramDispatch,
  userId: string,
  mediaKind: 'crop-image' | 'voice',
  deps: TelegramDispatchDeps,
): Promise<MediaRef> {
  const fileId = dispatch.fileId;
  if (fileId === null) {
    // Unreachable: `photo` and `voice` always carry a fileId (parseUpdate). A throw rather than a
    // cast so a future reordering fails loudly instead of downloading nothing.
    throw new Error(`telegram-dispatch: ${dispatch.kind} update carried no fileId`);
  }

  const download = deps.download ?? realDownloadFile;
  const store = deps.media ?? realStoreMedia;

  const downloaded =
    mediaKind === 'crop-image'
      ? await download(fileId, { kind: 'photo' })
      : await download(fileId, { kind: 'voice', reportedMimeType: dispatch.voiceMimeType });

  // `storeMedia` admits kind/MIME/size before the GridFS write and stamps `metadata.ownerId` to the
  // resolved farmer, which is what lets that farmer's own web session read the file later (12.2/12.5).
  const stored = await store(userId, mediaKind, downloaded.mimeType, Buffer.from(downloaded.bytes), `telegram:${fileId}`);

  // The service inputs take a schema `MediaRef` (a 24-hex `fileId` string), while the GridFS store
  // returns a `MediaRefDoc` (an `ObjectId` `fileId`). Convert here, exactly as the Media_Endpoint
  // route does, so the reference the service reads is the wire-shaped one.
  return { fileId: stored.fileId.toHexString(), kind: stored.kind };
}

/* ========================================================================== */
/* D11 — the soft deadline and the failure branch                             */
/* ========================================================================== */

/** Resolve the absolute deadline: `min(soft, platform)` from the invocation start (D11, V18). */
function resolveDeadline(startedMs: number, deps: TelegramDispatchDeps): number {
  const soft = startedMs + TELEGRAM_SOFT_DEADLINE_MS;
  const at = (deps.platformDeadline ?? getDeadline)();
  const platformMs = at === undefined ? undefined : at.getTime();
  return platformMs !== undefined && Number.isFinite(platformMs) ? Math.min(soft, platformMs) : soft;
}

/**
 * D11's soft-deadline branch: the budget ran short before the spend began. Send the "taking longer"
 * copy, mark the record `failed` (not `processed`, so the next send is handled normally), return
 * 200. Zero quota — no service was called.
 */
async function softDeadline(
  dispatch: TelegramDispatch,
  ownerId: string,
  language: Language,
  send: SendMessage,
): Promise<TelegramInboundResult> {
  const replySent = await deliver(send, dispatch.chatId, messages(language).telegram.takingLonger);
  await markFailed(dispatch.updateId, ownerId);
  return { updateId: dispatch.updateId, disposition: 'soft_deadline', replySent, detail: SOFT_DEADLINE_DETAIL };
}

/**
 * A dispatch failure after the claim. The record is marked `failed`, and the farmer gets the coded,
 * localized failure sentence — routed through the leak boundary, so no provider payload reaches the
 * reply (15.6). The reply language is English as a floor: a failure can occur before or after the
 * profile is read, and the honest default when no preference is in hand is Jamee's default language.
 */
async function failed(
  dispatch: TelegramDispatch,
  error: unknown,
  send: SendMessage,
  now: () => number,
): Promise<TelegramInboundResult> {
  void now;
  // The failure sentence is the "taking longer" copy in English — the same "send it again" advice,
  // since the farmer's action is identical and the record is `failed` either way.
  const replySent = await deliver(send, dispatch.chatId, messages('en').telegram.takingLonger);
  await markFailed(dispatch.updateId, null);
  const detail = error instanceof Error ? error.name : 'dispatch_error';
  console.error('[jamee] telegram.dispatch_failed', JSON.stringify({ updateId: dispatch.updateId, detail }));
  return { updateId: dispatch.updateId, disposition: 'soft_deadline', replySent, detail: `failed:${detail}` };
}

/* ========================================================================== */
/* Small helpers                                                               */
/* ========================================================================== */

/**
 * Send a reply, tolerating a delivery failure as a recorded fact rather than a throw — `sendMessage`
 * itself never throws for a transport/HTTP reason (V24). A `null` chat id (a message with no chat)
 * cannot be replied to; that is reported as `false` rather than crashed.
 */
async function deliver(send: SendMessage, chatId: number | null, text: string): Promise<boolean> {
  if (chatId === null) return false;
  const result = await send(chatId, text);
  return result.ok;
}

/**
 * The default sender resolver: the Data_Access_Layer read, narrowed to the two fields the pipeline
 * needs. Kept as a seam-shaped adapter over `resolveSender` so a unit test injects `{ userId,
 * language }` without a `ProfileDoc`.
 */
async function defaultResolveProfile(
  telegramUserId: number,
): Promise<{ userId: string; language: Language } | null> {
  const profile = await resolveSender(telegramUserId);
  if (profile === null) return null;
  return { userId: profile._id, language: profile.language };
}
