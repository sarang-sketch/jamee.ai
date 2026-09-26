import 'server-only';

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { serverEnv } from '@/lib/env';

/**
 * The Telegram Bot API provider — the pure half.
 *
 * This module decides three things and nothing else: whether an inbound request is Telegram's
 * (the secret-token header), what Telegram said (the `Update` → dispatch shape parse), and how
 * to move bytes and text over the Bot API (`getFile` + download, and `sendMessage`). It talks to
 * no database, imports nothing from `src/lib/supabase` or a MongoDB module, resolves no profile,
 * consults no entitlement, and picks no farmer-facing copy. Storage is the caller's job, and so
 * is dispatch — this is task 57.1's `src/lib/telegram.ts` half, and the ordered inbound pipeline
 * (task 57.2) lives in `src/lib/telegram-dispatch.ts`.
 *
 * Requirements: 11.1–11.4 (the `Webhook_Secret_Token` compared in constant time before the body
 *               is read, an absent header and an unconfigured secret both failures), 10.4 / 10.6
 *               / 10.9 (photo and voice retrieval, and the unsupported-type boundary), 10.11 and
 *               15.6 (a reply the caller sends, with no provider payload in it)
 * Design: "Telegram adapter" → *POST — secret token before anything else*, *Media download and
 *         upload*; D11 (inline retrieval, a `file_path` fetched immediately before download);
 *         D12 (the shared secret token replaces the HMAC, and why `request.json()` is safe here)
 * Depends on: V24 (the secret-token header name and constraints, the `Update` field paths, the
 *             `sendMessage` shape and its 4096-character cap), V25 (`getFile` → `file_path`, the
 *             token-in-URL download form, the 1-hour-minimum validity, the 20 MB ceiling), V26
 *             (a `voice` note may be OGG/Opus, MP3 or M4A; read `mime_type` when present and
 *             otherwise detect the container from the bytes; take the last `photo[]` entry)
 *
 * ### THE BOT TOKEN NEVER LEAVES THIS MODULE IN A FORM ANYTHING CAN READ
 *
 * V25's download URL embeds the bot token as a path segment rather than an `Authorization`
 * header, which is the single most surprising thing about this channel. So the invariant this
 * module holds is that the token appears only in a request URL and never in a log line, an error
 * message, a thrown value, or a return value. Every function that builds a token-bearing URL
 * keeps that URL local; every error this module raises names the operation and the `file_id`,
 * never the URL. `TelegramApiError` carries no URL and no token, and its unit tests assert that.
 *
 * ### SECRETS ARE READ LAZILY, AND EVERY FUNCTION ACCEPTS THEM AS A PARAMETER
 *
 * The bot token and the webhook secret default to `serverEnv(...)`, evaluated only when the
 * argument is omitted, exactly as `src/lib/whatsapp.ts` did for the Meta credentials. A test
 * passes them explicitly and never touches the environment; production omits them and reads
 * through the one accessor that fails loudly on an absent value.
 */

/* ========================================================================== */
/* V24 — the secret-token header                                               */
/* ========================================================================== */

/** **V24.** The header Telegram presents the `secret_token` in on every delivery. */
export const TELEGRAM_SECRET_TOKEN_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * Constant-time string comparison that does not reveal where two values first differ.
 *
 * **Why a webhook secret needs this (Requirement 11.2).** The route is public and infinitely
 * retriable, and the secret token is a bearer credential Jamee generated. A byte-at-a-time
 * comparison that returns early answers "how many leading characters did I get right?", which
 * turns guessing the token from one infeasible search into many short ones. One comparison
 * removes that oracle.
 *
 * **An absent header takes the same time as a wrong one.** `presented === null` is compared
 * against a fixed-length dummy so a missing header does not short-circuit to a faster `false`
 * than a mismatch would — the timing of the two cases must not differ either. The length guard
 * that `timingSafeEqual` requires still returns early on a length mismatch, and that is fine: the
 * only fact it leaks is the length of a value the caller itself supplied.
 */
export function timingSafeEqualStr(presented: string | null | undefined, configured: string): boolean {
  // A dummy of the configured length keeps the absent-header path from being observably faster
  // than a wrong-value path; the boolean is discarded, only the work matters.
  if (presented === null || presented === undefined) {
    const dummy = 'x'.repeat(configured.length);
    timingSafeEqualStr(dummy, configured);
    return false;
  }
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(configured, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify the `X-Telegram-Bot-Api-Secret-Token` header against the configured token.
 *
 * **An unconfigured secret is a FAILED verification, not a skipped one (Requirement 11.4).**
 * `serverEnv('TELEGRAM_WEBHOOK_SECRET_TOKEN')` throws when the variable is absent, and that throw
 * is allowed to propagate to the route's 401 branch — there is no `if (secret) verify(...)` path
 * by which a deployment that forgot the variable becomes a deployment that accepts every request.
 * The one way to disable the check is to remove the call, which is a reviewable diff.
 *
 * `configured` defaults to the environment value, evaluated only when omitted, so a test supplies
 * its own token and never reads the environment.
 */
export function verifySecretToken(
  headers: Headers,
  configured: string = serverEnv('TELEGRAM_WEBHOOK_SECRET_TOKEN'),
): boolean {
  return timingSafeEqualStr(headers.get(TELEGRAM_SECRET_TOKEN_HEADER), configured);
}

/* ========================================================================== */
/* V24 — the Update → dispatch shape                                           */
/* ========================================================================== */

/** **V24.** `message.from` — the sender's Telegram user id is an int64; `chat.id` is the reply target. */
const fromSchema = z.object({ id: z.number().int() });
const chatSchema = z.object({ id: z.number().int() });

/** **V26.** A `PhotoSize`: `file_id`, dimensions, `file_size`; no `mime_type` (JPEG by convention). */
const photoSizeSchema = z.object({
  file_id: z.string().min(1),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  file_size: z.number().int().optional(),
});

/**
 * **V26.** A `Voice` object: `file_id`, `duration` (seconds), an optional sender-set `mime_type`,
 * and `file_size`. `mime_type` is optional per U-V26 — read it when present, detect the container
 * from the bytes otherwise.
 */
const voiceSchema = z.object({
  file_id: z.string().min(1),
  duration: z.number().int().optional(),
  mime_type: z.string().min(1).optional(),
  file_size: z.number().int().optional(),
});

/**
 * **V24.** The `Message` fields Jamee reads. Everything is optional because an update carries
 * exactly one kind of content and the classifier below decides which. `photo` is an array in
 * ascending size order; `voice`, `audio` and `document` are distinct objects (V26).
 */
const messageSchema = z.object({
  from: fromSchema.optional(),
  chat: chatSchema,
  text: z.string().optional(),
  photo: z.array(photoSizeSchema).optional(),
  voice: voiceSchema.optional(),
  audio: z.unknown().optional(),
  document: z.unknown().optional(),
});

/**
 * **V24.** The top-level `Update`. `update_id` is the idempotency key the caller claims on; the
 * message may be absent (an update can carry an edited message, a callback query, etc., none of
 * which Jamee handles), which the classifier maps to `other`.
 */
const updateSchema = z.object({
  update_id: z.number().int(),
  message: messageSchema.optional(),
});

/** The kinds the dispatch pipeline branches on. `start` is `/start`; `other` is everything Jamee cannot act on. */
export type TelegramUpdateKind = 'start' | 'text' | 'photo' | 'voice' | 'other';

/**
 * The small shape the caller dispatches on — the only thing this module exposes about an update.
 *
 * `telegramUserId` and `chatId` are `null` when the update carried no message/sender (the `other`
 * kind), so a caller cannot mistake a structural absence for a real id. `fileId` is set for
 * `photo` (the largest size) and `voice`; `startPayload` is the `/start <payload>` argument, or
 * `null` for a bare `/start`.
 */
export interface TelegramDispatch {
  readonly updateId: number;
  readonly telegramUserId: number | null;
  readonly chatId: number | null;
  readonly kind: TelegramUpdateKind;
  /** `message.text` verbatim for a `text` update; the raw `/start …` line for a `start` update. */
  readonly textBody: string | null;
  /** The `file_id` for the largest photo size or the voice note; `null` otherwise. */
  readonly fileId: string | null;
  /** For a `voice` update, the sender-reported `mime_type` when present (V26); `null` otherwise. */
  readonly voiceMimeType: string | null;
  /** The `/start` argument, or `null` for a bare `/start`. */
  readonly startPayload: string | null;
}

export type TelegramParse =
  | { readonly ok: true; readonly dispatch: TelegramDispatch }
  | { readonly ok: false; readonly reason: string };

/** `/start` optionally followed by whitespace and a payload. Matched against the whole trimmed text. */
const START_COMMAND = /^\/start(?:@\w+)?(?:\s+(.*))?$/s;

/**
 * Parse a raw JSON `Update` into the dispatch shape.
 *
 * Returns a result rather than throwing: a well-formed request whose payload does not parse is
 * acknowledged with 200 and dropped by the caller (Requirement 10.11), because Telegram would
 * redeliver a non-200 and the same body would fail identically forever.
 *
 * The body may be passed straight from `request.json()` — nothing here is coupled to the raw
 * bytes, because authenticity is the secret-token header and not a digest over the body (D12).
 */
export function parseUpdate(raw: unknown): TelegramParse {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: issue === undefined ? 'update did not match the V24 shape' : `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    };
  }

  const update = parsed.data;
  const message = update.message;
  const base = {
    updateId: update.update_id,
    telegramUserId: message?.from?.id ?? null,
    chatId: message?.chat.id ?? null,
  } as const;

  const none = (kind: TelegramUpdateKind): TelegramDispatch => ({
    ...base,
    kind,
    textBody: null,
    fileId: null,
    voiceMimeType: null,
    startPayload: null,
  });

  if (message === undefined) return { ok: true, dispatch: none('other') };

  // `/start` is recognised from the text before a plain text message is, because the dispatch
  // pipeline short-circuits it above profile resolution (design "Inbound processing order").
  if (message.text !== undefined) {
    const startMatch = START_COMMAND.exec(message.text.trim());
    if (startMatch !== null) {
      const payload = startMatch[1]?.trim();
      return {
        ok: true,
        dispatch: {
          ...none('start'),
          textBody: message.text,
          startPayload: payload === undefined || payload === '' ? null : payload,
        },
      };
    }
    return { ok: true, dispatch: { ...none('text'), textBody: message.text } };
  }

  // V26: the largest photo is the last entry of the ascending-size array.
  if (message.photo !== undefined && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    if (largest !== undefined) {
      return { ok: true, dispatch: { ...none('photo'), fileId: largest.file_id } };
    }
  }

  if (message.voice !== undefined) {
    return {
      ok: true,
      dispatch: {
        ...none('voice'),
        fileId: message.voice.file_id,
        voiceMimeType: message.voice.mime_type ?? null,
      },
    };
  }

  // A photo array that was present but empty, an `audio` file, a `document`, or any other content
  // Jamee does not act on. The caller replies "photos, text, voice notes" (Requirement 10.9).
  return { ok: true, dispatch: none('other') };
}

/* ========================================================================== */
/* V25 / V26 — media retrieval and container detection                          */
/* ========================================================================== */

/**
 * **V25.** The bot-download ceiling is 20 MB, and it sits above Jamee's own 10 MB image / 3 MB
 * voice admission limits, so this refusal only fires on a file the app would reject anyway — but
 * it is checked here so no oversized download is ever attempted regardless of the caller's own
 * admission logic.
 */
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** The MIME types this module reports for the media it retrieves. */
export const TELEGRAM_PHOTO_MIME = 'image/jpeg';
export const VOICE_MIME_OGG = 'audio/ogg';
export const VOICE_MIME_MP3 = 'audio/mpeg';
export const VOICE_MIME_M4A = 'audio/mp4';

/**
 * The container detected from a voice note's leading bytes when `mime_type` is absent (U-V26), or
 * `null` when the bytes match none of the three permitted containers.
 *
 * **V26.** A `voice` note may be OGG/Opus, MP3, or M4A. The signatures:
 *  - **OGG/Opus** — the file starts with the ASCII bytes `OggS` (`4F 67 67 53`).
 *  - **MP3** — either an `ID3` tag (`49 44 33`) at the start, or a raw MPEG audio frame sync:
 *    the first byte is `0xFF` and the top three bits of the second are set (`(b & 0xE0) === 0xE0`).
 *  - **M4A** — the ISO Base Media `ftyp` box: bytes 4–7 are the ASCII `ftyp` (`66 74 79 70`).
 *
 * Anything else is refused before download by returning `null`, which the caller turns into the
 * "type the question instead" reply — a documented container guarantee is not a verified runtime
 * fact, so an unrecognised container is rejected rather than assumed.
 */
export function detectVoiceContainerMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return VOICE_MIME_OGG; // "OggS"
  }
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return VOICE_MIME_MP3; // "ID3"
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    return VOICE_MIME_MP3; // MPEG frame sync
  }
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return VOICE_MIME_M4A; // "....ftyp"
  }
  return null;
}

/** The three MIME types a voice note may legitimately arrive as (V26). */
export const ACCEPTED_VOICE_MIMES: readonly string[] = [VOICE_MIME_OGG, VOICE_MIME_MP3, VOICE_MIME_M4A];

/** `fetch`, narrowed to the two shapes this module issues (a GET, and a POST with a JSON body). */
export type TelegramFetch = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<Response>;

/**
 * An error from a Bot API call.
 *
 * **Carries no URL and no token — by design and by test.** The message names the operation and
 * (where relevant) the `file_id`, so a log line answers "what failed" without ever printing the
 * token-bearing download URL. `status` is the Bot API's HTTP status when there was one.
 */
export class TelegramApiError extends Error {
  readonly operation: string;
  readonly status: number | undefined;

  constructor(operation: string, options: { status?: number; cause?: unknown } = {}) {
    super(`Telegram ${operation} failed${options.status === undefined ? '' : ` (HTTP ${options.status})`}`);
    this.name = 'TelegramApiError';
    this.operation = operation;
    if (options.status !== undefined) this.status = options.status;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export interface TelegramClientOptions {
  /** Defaults to `TELEGRAM_BOT_TOKEN`, evaluated only when omitted. Never returned or logged. */
  readonly botToken?: string;
  readonly fetchImpl?: TelegramFetch;
}

const API_BASE = 'https://api.telegram.org';

function resolveClient(options: TelegramClientOptions): { token: string; fetchImpl: TelegramFetch } {
  return {
    token: options.botToken ?? serverEnv('TELEGRAM_BOT_TOKEN'),
    fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
  };
}

/**
 * **V25.** `getFile(file_id)` → the `file_path` needed to build the download URL.
 *
 * The result carries `file_size` when Telegram reported it, so the caller can refuse an oversized
 * file before the download is even attempted. A non-2xx or an `ok: false` body throws a
 * `TelegramApiError` that names the operation and the `file_id` and never the token.
 */
export async function getFile(
  fileId: string,
  options: TelegramClientOptions = {},
): Promise<{ readonly filePath: string; readonly fileSize: number | undefined }> {
  const { token, fetchImpl } = resolveClient(options);
  const url = `${API_BASE}/bot${token}/getFile`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });
  } catch (cause) {
    throw new TelegramApiError(`getFile(${fileId})`, { cause });
  }

  if (!response.ok) {
    throw new TelegramApiError(`getFile(${fileId})`, { status: response.status });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new TelegramApiError(`getFile(${fileId}) returned an unreadable body`, { cause });
  }

  const parsed = z
    .object({
      ok: z.boolean(),
      result: z.object({ file_path: z.string().min(1), file_size: z.number().int().optional() }).optional(),
    })
    .safeParse(body);

  if (!parsed.success || !parsed.data.ok || parsed.data.result === undefined) {
    throw new TelegramApiError(`getFile(${fileId}) returned no file_path`);
  }

  return { filePath: parsed.data.result.file_path, fileSize: parsed.data.result.file_size };
}

export interface DownloadedFile {
  readonly bytes: Uint8Array;
  readonly size: number;
  /** The detected MIME type: the reported `mime_type` when the caller supplied one, else sniffed. */
  readonly mimeType: string;
}

export interface DownloadFileOptions extends TelegramClientOptions {
  /** For a photo, `image/jpeg`; for a voice note, the sender-reported `mime_type` when present (V26). */
  readonly reportedMimeType?: string | null;
  /** How to resolve the MIME type when none was reported: photo → JPEG, voice → sniff the bytes. */
  readonly kind: 'photo' | 'voice';
}

/**
 * **V25 / V26.** Fetch a file's bytes, refuse anything above 20 MB, and resolve its MIME type.
 *
 * The flow is `getFile` (fetched immediately, because a `file_path` expires — D11) then a single
 * GET of `https://api.telegram.org/file/bot<token>/<file_path>`. **That URL embeds the token, so
 * it is built locally, never logged, never returned, and never placed in a thrown error.**
 *
 * MIME resolution (V26):
 *  - **photo** → `image/jpeg` (a `PhotoSize` carries no `mime_type` and Telegram photos are JPEG).
 *  - **voice** → the reported `mime_type` when the caller passed one; otherwise the container is
 *    detected from the leading bytes. A voice note whose bytes match none of OGG/Opus, MP3 or M4A
 *    throws — the caller treats that as the unsupported-type reply rather than guessing OGG/Opus.
 *
 * The 20 MB refusal is checked twice: against `getFile`'s reported `file_size` before the download
 * (free), and against the actual byte length after it (in case the report was absent or wrong).
 */
export async function downloadFile(fileId: string, options: DownloadFileOptions): Promise<DownloadedFile> {
  const { token, fetchImpl } = resolveClient(options);

  const file = await getFile(fileId, options);
  if (file.fileSize !== undefined && file.fileSize > TELEGRAM_MAX_DOWNLOAD_BYTES) {
    throw new TelegramApiError(
      `download(${fileId}): reported size ${file.fileSize} exceeds the ${TELEGRAM_MAX_DOWNLOAD_BYTES}-byte ceiling`,
    );
  }

  // Local only. Contains the bot token; nothing below lets it escape into a log, an error or a return.
  const downloadUrl = `${API_BASE}/file/bot${token}/${file.filePath}`;

  let response: Response;
  try {
    response = await fetchImpl(downloadUrl, { method: 'GET' });
  } catch (cause) {
    // `cause` is re-raised as the TelegramApiError's cause. A transport error's message can
    // itself echo the URL, so it is deliberately NOT interpolated into this module's message; the
    // caller logs `error.operation`, and if it logs the cause it owns that decision.
    throw new TelegramApiError(`download(${fileId})`, { cause });
  }

  if (!response.ok) {
    throw new TelegramApiError(`download(${fileId})`, { status: response.status });
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > TELEGRAM_MAX_DOWNLOAD_BYTES) {
    throw new TelegramApiError(
      `download(${fileId}): downloaded ${bytes.byteLength} bytes exceeds the ${TELEGRAM_MAX_DOWNLOAD_BYTES}-byte ceiling`,
    );
  }

  const mimeType = resolveMimeType(fileId, options.kind, options.reportedMimeType ?? null, bytes);
  return { bytes, size: bytes.byteLength, mimeType };
}

function resolveMimeType(
  fileId: string,
  kind: 'photo' | 'voice',
  reported: string | null,
  bytes: Uint8Array,
): string {
  if (kind === 'photo') return TELEGRAM_PHOTO_MIME;

  if (reported !== null) {
    const normalized = reported.split(';')[0]?.trim().toLowerCase() ?? '';
    if ((ACCEPTED_VOICE_MIMES as readonly string[]).includes(normalized)) return normalized;
    // A reported type outside the three permitted containers is not trusted; fall through to
    // sniffing, so a mislabelled-but-valid container still resolves and a genuinely unsupported
    // one is refused by the bytes.
  }

  const detected = detectVoiceContainerMime(bytes);
  if (detected === null) {
    throw new TelegramApiError(
      `download(${fileId}): voice container is none of OGG/Opus, MP3 or M4A (V26) and is refused`,
    );
  }
  return detected;
}

/* ========================================================================== */
/* V24 — sendMessage                                                           */
/* ========================================================================== */

/** **V24.** The `sendMessage` text cap, in UTF-8 characters. */
export const TELEGRAM_TEXT_MAX_CHARS = 4096;
export const TELEGRAM_TRUNCATION_MARKER = '\u2026';

/**
 * Fit a reply inside the 4096-character cap (V24), replacing the last character with an ellipsis
 * rather than appending past the cap, so the result is always `<= TELEGRAM_TEXT_MAX_CHARS`.
 *
 * A grounded diagnosis plus a knowledge-base explanation can exceed the cap, especially in
 * Devanagari; a message over the cap is rejected by Telegram, so a truncated answer beats no
 * answer. Measured in UTF-16 code units (`String.length`), the conservative reading of "4096
 * characters".
 */
export function truncateText(text: string, maxChars: number = TELEGRAM_TEXT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - TELEGRAM_TRUNCATION_MARKER.length)) + TELEGRAM_TRUNCATION_MARKER;
}

export type SendMessageResult =
  | { readonly ok: true; readonly sentMessageId: number | null }
  | { readonly ok: false; readonly status: number | null };

/**
 * **V24.** `POST .../bot<token>/sendMessage` with `{ chat_id, text }`.
 *
 * Never throws for a transport or HTTP reason — a failed send is a result the caller can record
 * against the `telegram_inbound` row, not a 500. It does throw for a defect in the call (an empty
 * `text`), because that is a bug in the branch that produced it rather than something to send.
 *
 * The response body is not echoed anywhere farmer-facing (Requirement 15.6); only the message id
 * is read, and even that is optional so a documentation drift cannot turn a delivered reply into
 * a reported failure.
 */
export async function sendMessage(
  chatId: number,
  text: string,
  options: TelegramClientOptions = {},
): Promise<SendMessageResult> {
  if (text.trim().length === 0) {
    throw new Error('sendMessage was called with an empty text. Every reply branch owes the farmer a sentence.');
  }
  const { token, fetchImpl } = resolveClient(options);
  const url = `${API_BASE}/bot${token}/sendMessage`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: truncateText(text) }),
    });
  } catch {
    return { ok: false, status: null };
  }

  if (!response.ok) return { ok: false, status: response.status };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Delivered with a body Jamee could not read. The reply left the function, so this is a
    // success — reporting a failure would mark a delivered answer as undelivered.
    return { ok: true, sentMessageId: null };
  }

  const parsed = z
    .object({ ok: z.boolean(), result: z.object({ message_id: z.number().int() }).optional() })
    .safeParse(body);
  const sentMessageId = parsed.success && parsed.data.ok ? (parsed.data.result?.message_id ?? null) : null;
  return { ok: true, sentMessageId };
}
