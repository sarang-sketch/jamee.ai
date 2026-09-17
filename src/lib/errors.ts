import {
  ACCEPTED_IMAGE_TYPES,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  MAX_IMAGE_BYTES,
  TRANSCRIBE_ACCEPTED_CONTAINERS,
} from '@/lib/config/verified';
import { interpolate, messages } from '@/lib/messages';
import {
  ERROR_CODES,
  SUPPORTED_LANGUAGES,
  operationSchema,
  type ErrorCode,
  type ErrorDetails,
  type ErrorEnvelope,
  type Language,
} from '@/lib/schemas';

/**
 * One error type, one mapping table, one wrapper.
 *
 * Requirements: 15.3 (a stable code plus a localized farmer-readable message), 15.4 (an accurate
 *               retryable flag that drives a retry action), 15.6 (HTTP 500 with a generic
 *               message; no stack traces or provider payloads in the body)
 * Design: "Error taxonomy", D6
 *
 * `Inconclusive_Result` is deliberately absent from this file. An inconclusive diagnosis is a
 * successful **200** carrying `status: 'unknown'` — the request worked, the photo could not be
 * judged. Modelling it as an error would break Requirement 6.4's single-shape rule and
 * Requirement 6.7's quota rule at once.
 */

/* ========================================================================== */
/* The taxonomy table                                                          */
/* ========================================================================== */

interface CodeSpec {
  status: number;
  /**
   * Whether the SAME request, retried unchanged, could plausibly succeed.
   *
   * Requirement 15.4 turns this into a retry BUTTON, so an optimistic value is a lie the
   * interface tells. `QUOTA_EXCEEDED` is the instructive case: it is `false` even though the
   * request will succeed tomorrow, because a retry button that does nothing for hours is worse
   * than no button. `TRANSCRIPT_EMPTY` is `true` because the farmer can act — record again
   * somewhere quieter — over the same object.
   */
  retryable: boolean;
  /** Requirement, for traceability from the table to the spec. */
  requirement: string;
}

/**
 * Every code's HTTP status and retryable flag. Exhaustive over `ERROR_CODES` by type, so a new
 * code cannot be added to the contract without deciding both here.
 */
export const ERROR_SPECS: Record<ErrorCode, CodeSpec> = {
  AUTH_REQUIRED: { status: 401, retryable: false, requirement: '1.7' },
  OTP_INVALID: { status: 400, retryable: true, requirement: '1.3' },
  LANGUAGE_UNSUPPORTED: { status: 400, retryable: false, requirement: '9.5' },

  /**
   * **Not retryable, because the body is what is wrong.** The same request, re-sent unchanged,
   * carries the same unusable message — the farmer has to type something else, which is what the
   * sentence asks for. 400 rather than 422 for the same reason `STORAGE_REF_INVALID` is: the
   * request never satisfied its contract, so nothing was attempted and no unit was spent.
   *
   * The text counterpart of `STORAGE_REF_INVALID`, and the code that closes the gap `/api/chat`
   * recorded: that code's sentence names a photo, which is the wrong noun on an endpoint that
   * takes a typed question.
   */
  MESSAGE_INVALID: { status: 400, retryable: false, requirement: '7.1, 15.3' },

  STORAGE_REF_INVALID: { status: 400, retryable: false, requirement: '2.2' },

  /** 403 AND the quota counter untouched — Requirement 2.6 is explicit about both. */
  STORAGE_REF_FORBIDDEN: { status: 403, retryable: false, requirement: '2.6' },

  FILE_TYPE_UNSUPPORTED: { status: 400, retryable: false, requirement: '2.4' },
  FILE_TOO_LARGE: { status: 400, retryable: false, requirement: '2.4, 8.3' },
  AUDIO_TOO_LONG: { status: 400, retryable: false, requirement: '8.3' },

  /**
   * **Not retryable, and that is the whole point of the code existing.**
   *
   * The container a recording arrived in is a property of the recorder, not of the request: on
   * WhatsApp, Meta chooses it (V14 documents `audio/aac` and `audio/amr`, neither of which is in
   * V10's accepted list), and in a browser the recorder already picked from the intersection.
   * Either way, re-sending the identical bytes fails identically, so Requirement 15.4's flag has
   * to be `false` — which is exactly what `TRANSCRIPTION_FAILED` (502, retryable) got wrong when
   * it stood in for this case. 400 rather than 502 for the same reason
   * `FILE_TYPE_UNSUPPORTED` is: the input is unusable, no provider was reached, and nothing
   * failed at Jamee's end.
   */
  AUDIO_FORMAT_UNSUPPORTED: { status: 400, retryable: false, requirement: '8.4, 10.6' },

  /** Burst limiting. Retryable in seconds, unlike the daily quota. */
  RATE_LIMITED: { status: 429, retryable: true, requirement: '13.8' },

  /** Not retryable *today*: the reset instant is in `details.resetsAt`. */
  QUOTA_EXCEEDED: { status: 429, retryable: false, requirement: '14.3' },

  TRANSCRIPT_EMPTY: { status: 422, retryable: true, requirement: '8.7' },

  /**
   * Retryable **over the same object**, which is why a failed transcription does NOT delete its
   * recording: deleting it would make this flag a lie and force the farmer to re-record for what
   * was a provider outage (design: *Why a failed transcription keeps its bytes*).
   */
  TRANSCRIPTION_FAILED: { status: 502, retryable: true, requirement: '8.4' },

  PROVIDERS_UNAVAILABLE: { status: 503, retryable: true, requirement: '14.5, 14.8' },
  DIAGNOSIS_TIMEOUT: { status: 504, retryable: true, requirement: '3.7' },

  /**
   * The one deliberate exception to Requirement 10.11's "acknowledge with 200": an unsigned
   * request is not an accepted delivery. Body carries no content.
   */
  WEBHOOK_SIGNATURE_INVALID: { status: 401, retryable: false, requirement: '11.4' },
  WEBHOOK_VERIFY_TOKEN_INVALID: { status: 403, retryable: false, requirement: '11.2' },

  CONVERSATION_NOT_FOUND: { status: 404, retryable: false, requirement: '7.1' },
  DIAGNOSIS_NOT_FOUND: { status: 404, retryable: false, requirement: '12.3' },

  /** Requirement 18.12. No human caller, so nothing is rendered from this. */
  SWEEP_UNAUTHORIZED: { status: 401, retryable: false, requirement: '18.12' },

  INTERNAL_ERROR: { status: 500, retryable: true, requirement: '15.6' },
};

/* ========================================================================== */
/* AppError                                                                    */
/* ========================================================================== */

export interface AppErrorOptions {
  /** Structured numbers for the envelope. Never interpolated into the code. */
  details?: ErrorDetails;
  /**
   * The real cause, for the server log ONLY. Requirement 15.6 keeps it out of the response
   * body, and `toEnvelope()` structurally cannot include it — it reads `code`, `details` and the
   * catalog, and never touches this field.
   */
  cause?: unknown;
  /** Extra server-side context for the log line. Never serialized outward. */
  context?: Readonly<Record<string, unknown>>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: ErrorDetails | undefined;
  readonly context: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const spec = ERROR_SPECS[code];
    // The Error `message` is the developer-facing string: it reaches logs and never a farmer.
    // The farmer-facing text comes from the catalogs, resolved at envelope time by language.
    super(`${code} (HTTP ${spec.status}, requirement ${spec.requirement})`);
    this.name = 'AppError';
    this.code = code;
    this.status = spec.status;
    this.retryable = spec.retryable;
    this.details = options.details;
    this.context = options.context;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/* ========================================================================== */
/* Details that the code itself implies                                        */
/* ========================================================================== */

/**
 * Some codes carry numbers that are properties of the CODE rather than of the request, and a
 * caller that has to remember them will eventually state a limit that disagrees with the check
 * that produced it — which Requirement 2.4 and 8.3 make a farmer-visible defect.
 *
 * So those are filled in here, from `config/verified.ts`, and caller-supplied details win on a
 * key-by-key basis (a `QUOTA_EXCEEDED` knows its own `used` and `resetsAt`; only the code knows
 * `acceptedTypes`).
 */
function impliedDetails(code: ErrorCode): ErrorDetails | undefined {
  switch (code) {
    case 'LANGUAGE_UNSUPPORTED':
      return { supportedLanguages: [...SUPPORTED_LANGUAGES] };
    case 'FILE_TYPE_UNSUPPORTED':
      return { acceptedTypes: [...ACCEPTED_IMAGE_TYPES], maxBytes: MAX_IMAGE_BYTES };
    case 'FILE_TOO_LARGE':
      return { maxBytes: MAX_IMAGE_BYTES };
    case 'AUDIO_TOO_LONG':
      return { maxSeconds: MAX_AUDIO_SECONDS, maxBytes: MAX_AUDIO_BYTES };
    /**
     * The containers come from `TRANSCRIBE_ACCEPTED_CONTAINERS` (V10) rather than being restated,
     * so a client that lists them and the check that refused cannot disagree — the same reasoning
     * `FILE_TYPE_UNSUPPORTED` uses for `ACCEPTED_IMAGE_TYPES`. The farmer-facing sentence does not
     * quote the list: "flac, mpga, m4a…" is not something a farmer can act on, and the actionable
     * instruction is to type the question instead.
     */
    case 'AUDIO_FORMAT_UNSUPPORTED':
      return { acceptedTypes: [...TRANSCRIBE_ACCEPTED_CONTAINERS], maxBytes: MAX_AUDIO_BYTES };
    default:
      return undefined;
  }
}

/**
 * Values the message template may reference. Derived from the details rather than passed
 * separately, so the sentence and the structured number can never disagree.
 *
 * `maxMb` exists because "10 MB" is what a farmer reads while `maxBytes` is what a client
 * checks — the same limit, expressed for two different readers, computed from one source.
 *
 * The `language` is read by exactly one value — `resetsAt`, whose month name is a word rather than
 * a number. Every other value here is a number and therefore language-independent.
 */
function templateValues(
  details: ErrorDetails | undefined,
  language: Language,
): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  if (details === undefined) return values;

  if (details.maxBytes !== undefined) {
    values.maxBytes = details.maxBytes;
    values.maxMb = Math.round(details.maxBytes / (1024 * 1024));
  }
  if (details.maxSeconds !== undefined) values.maxSeconds = details.maxSeconds;
  if (details.limit !== undefined) values.limit = details.limit;
  if (details.used !== undefined) values.used = details.used;
  if (details.retryAfterSeconds !== undefined) {
    values.retryAfterSeconds = details.retryAfterSeconds;
  }
  if (details.resetsAt !== undefined) {
    values.resetsAt = formatResetInstant(details.resetsAt, language);
  }

  // `operation` is deliberately NOT filled here: it arrives through `context`, not `details`, and it
  // is resolved against the catalog in `toEnvelope`. Absent, `interpolate` leaves the template's own
  // `{operation}` visible rather than rendering the word "undefined".
  return values;
}

/**
 * `resetsAt` reaches the envelope as an ISO instant, which is right for a machine and wrong for
 * a sentence. Rendered as an Asia/Kolkata wall-clock time, because that is the timezone the
 * quota window is defined in (Requirement 14.1) and therefore the only one in which the reset
 * time means what it says to a farmer.
 *
 * **Formatted in the farmer's own language, for the same reason `{operation}` is** (Requirement
 * 15.3). `QUOTA_EXCEEDED` is the one code whose sentence carries a date, and rendering it as
 * `en-IN` put the English month name `Mar` in the middle of a Devanagari sentence — the same
 * class of defect as the English token `chat`, and in the same message.
 *
 * **Numerals are forced to `latn`, deliberately.** CLDR's default numbering system for `mr` is
 * `deva`, so an unpinned formatter renders `१२ मार्च` while `{limit}` and `{used}` — which are
 * JavaScript numbers stringified by `interpolate` — stay `20`. Two numbering systems in one
 * sentence is harder to read than either alone, and the limit is the number the farmer is being
 * told about. One system for every number in the message; the month name is what localization
 * buys here.
 */
function formatResetInstant(iso: string, language: Language): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat(`${language}-IN-u-nu-latn`, {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  }).format(parsed);
}

/* ========================================================================== */
/* Envelope                                                                    */
/* ========================================================================== */

/**
 * Build the wire envelope for an error in a language.
 *
 * **This function is the leak boundary** (Requirement 15.6, Property 29). It never reads
 * `error.message`, `error.stack`, or `error.cause` — which is what makes "no stack trace fragment
 * and no provider payload fragment" a structural guarantee rather than a promise to be careful. Any
 * future change that reads one of those fields breaks that guarantee.
 *
 * What it does read: the code, the merged details, the retryable flag, the catalog string, and
 * `context.operation` — the last one **through `operationSchema`**, so what reaches the sentence is
 * one of three enum members mapped to a static catalog word, never a caller's string. No other key
 * of `context` is read, and no value from `context` is placed in the envelope.
 */
export function toEnvelope(error: AppError, language: Language): ErrorEnvelope {
  const implied = impliedDetails(error.code);
  const merged: ErrorDetails | undefined =
    implied === undefined && error.details === undefined
      ? undefined
      : { ...implied, ...error.details };

  const catalog = messages(language);
  const template = catalog.errors[error.code];
  const values = templateValues(merged, language);

  /**
   * `QUOTA_EXCEEDED`'s `{operation}`, which `QuotaService` supplies through `context`.
   *
   * **Resolved against the catalog rather than interpolated raw.** The value in `context` is the
   * database's — `usage_logs.operation` is `'image' | 'chat' | 'voice'` — and passing it straight
   * into the template put the English token `chat` in the middle of a Devanagari sentence, which
   * Requirement 15.3 does not admit as a localized message. `catalog.operations` is the same three
   * keys in the farmer's language.
   *
   * Validated through `operationSchema` rather than by a `typeof` check, so the only strings that
   * can reach the sentence are the three the contract declares. Anything else leaves `{operation}`
   * unfilled and therefore visible in review, which is the same choice `interpolate` makes for a
   * missing value — a wrong word in front of a farmer is worse than an obvious placeholder.
   *
   * This reads `context`, and it does not weaken the leak boundary above: one enum-validated key is
   * mapped to a static catalog string, and no value from `context` is ever serialized.
   */
  const operation = operationSchema.safeParse(error.context?.operation);
  if (operation.success) values.operation = catalog.operations[operation.data];

  return {
    error: {
      code: error.code,
      message: interpolate(template, values),
      language,
      retryable: error.retryable,
      ...(merged === undefined ? {} : { details: merged }),
    },
  };
}

/** A JSON `Response` carrying the envelope and the code's HTTP status. */
export function errorResponse(error: AppError, language: Language): Response {
  const body = toEnvelope(error, language);
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  // Advisory only. The retryable flag, not this header, drives the interface.
  if (error.details?.retryAfterSeconds !== undefined) {
    headers['retry-after'] = String(error.details.retryAfterSeconds);
  }

  return new Response(JSON.stringify(body), { status: error.status, headers });
}

/* ========================================================================== */
/* withErrorHandling                                                           */
/* ========================================================================== */

/**
 * Server-side log of the real cause. The ONLY place a cause is written anywhere.
 *
 * Deliberately `console.error`: on the target platform that is what reaches the runtime log,
 * and adding a logging dependency would put a second thing between an error and its record.
 */
function logCause(error: unknown, code: ErrorCode, context?: Readonly<Record<string, unknown>>): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(
    `[jamee] ${code}`,
    context === undefined ? '' : JSON.stringify(context),
    detail,
  );
}

/**
 * Wrap a route handler so every failure leaves through the single envelope.
 *
 * The `language` argument is a THUNK rather than a value because the language is parsed from the
 * request body, and the body parse itself can throw — at which point there is no resolved
 * language and the envelope still has to render. The thunk is called inside a `try`, and a
 * failure to resolve it falls back to `en`.
 *
 * Two branches, and the difference between them is the whole point:
 *  - An `AppError` is a decision Jamee made. Its code, status and details are already correct,
 *    and it is logged at info level only if it carries a cause.
 *  - Anything else is a bug. It becomes `INTERNAL_ERROR` (HTTP 500) with a generic message, and
 *    the real cause is logged server-side and nowhere else (Requirement 15.6).
 */
export async function withErrorHandling(
  handler: () => Promise<Response>,
  resolveLanguage: () => Language = () => 'en',
): Promise<Response> {
  const language = ((): Language => {
    try {
      return resolveLanguage();
    } catch {
      return 'en';
    }
  })();

  try {
    return await handler();
  } catch (error) {
    if (isAppError(error)) {
      if (error.cause !== undefined) logCause(error.cause, error.code, error.context);
      return errorResponse(error, language);
    }

    logCause(error, 'INTERNAL_ERROR');
    return errorResponse(new AppError('INTERNAL_ERROR', { cause: error }), language);
  }
}

/** Convenience for a caller that needs the code list without importing the schema module. */
export const ALL_ERROR_CODES: readonly ErrorCode[] = ERROR_CODES;
