import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS } from '@/lib/config/verified';
import {
  ALL_ERROR_CODES,
  AppError,
  ERROR_SPECS,
  errorResponse,
  toEnvelope,
  withErrorHandling,
} from '@/lib/errors';
import { messages } from '@/lib/messages';
import {
  ERROR_CODES,
  SUPPORTED_LANGUAGES,
  errorEnvelopeSchema,
  type ErrorCode,
  type ErrorEnvelope,
  type Language,
} from '@/lib/schemas';

/**
 * Unit tests for the error mapping in `src/lib/errors.ts` — task 25.3.
 *
 * Requirements: 14.5 (`PROVIDERS_UNAVAILABLE` renders in `en` as exactly the busy sentence),
 *               15.3 (one envelope, stable code, localized message), 15.4 (an accurate retryable
 *               flag), 15.6 (no stack trace and no provider payload in the body)
 * Design: "Error taxonomy" — the code → HTTP status → message table; D6
 *
 * =============================================================================
 * WHAT THIS FILE ASSERTS THAT `tests/property/errors.property.test.ts` DOES NOT
 * =============================================================================
 *
 * Property 29 already ranges over the whole code × language cross product and asserts totality,
 * localization, an accurate flag, and leak-freedom generatively. Repeating that here would add a
 * second copy of one claim rather than a second claim, so this file is deliberately the complement:
 *
 *  - **The statuses are literals here.** Property 29 asserts `response.status === ERROR_SPECS[code]
 *    .status`, which is the table checked against itself: an edit to `ERROR_SPECS` moves both sides
 *    and the property stays green. `tests/unit/api-docs.test.ts` compares `docs/API.md` against the
 *    same table, so it too moves with an edit to both. `DOCUMENTED` below is the third and
 *    independent copy — transcribed from the design's own taxonomy table — and it is compared
 *    against **the rendered response** rather than against the table that produced it. A status
 *    changed in the source and in the document still fails here, which is the point: the spec is the
 *    authority on what a code means, and a test is where that authority is written down.
 *  - **The `en` busy sentence is pinned byte for byte** (Requirement 14.5, D6). Property 29 asserts
 *    every message is non-empty, placeholder-free and distinct across the three languages; it never
 *    asserts *which* sentence any code renders. This does, for the one code whose exact English text
 *    is a requirement rather than a copy decision.
 *  - **The named mappings are named.** The taxonomy's "message intent" column makes four specific
 *    promises a farmer acts on — the three supported language codes in `details`, the two audio
 *    limits in the sentence, a localized operation word in the quota sentence, and three different
 *    sentences for the three ways a voice request can fail. Each is asserted as itself.
 *  - **The leak boundary is asserted at `errorResponse()`**, with a real captured stack rather than
 *    a synthetic one. Property 29 goes through `withErrorHandling`; the two exits are different
 *    functions, and every route reaches the first one through the second.
 *
 * Nothing here reads `ERROR_SPECS` to decide what to expect. It is read once, at the end, only to
 * prove the literal table below is exhaustive over `ERROR_CODES` — so a code added without a
 * documented status fails this file rather than passing it by omission.
 */

/* ========================================================================== */
/* The documented taxonomy, as literals                                        */
/* ========================================================================== */

interface DocumentedCode {
  readonly status: number;
  readonly retryable: boolean;
}

/**
 * Every code's documented HTTP status and retryable flag.
 *
 * **Transcribed by hand from the design's "Error taxonomy" table**, which is the authority, and from
 * `docs/API.md`'s `error-specs` table for the five codes the design's table predates:
 * `MESSAGE_INVALID`, `AUDIO_FORMAT_UNSUPPORTED`, `CONVERSATION_NOT_FOUND`, `DIAGNOSIS_NOT_FOUND` and
 * `SWEEP_UNAUTHORIZED`. That gap is real and is recorded rather than papered over — the design's
 * table has 17 rows against the taxonomy's 22 — and the five missing rows are each documented in
 * `docs/API.md` with a status, a flag and a requirement, which is why they are usable here.
 *
 * The design table writes the two webhook flags as `n/a` because both responses are bodiless. `false`
 * is the value the taxonomy has to carry for them — a flag is a boolean on the wire — and `docs/API
 * .md` records it as `no` for exactly that reason.
 */
const DOCUMENTED: Record<ErrorCode, DocumentedCode> = {
  AUTH_REQUIRED: { status: 401, retryable: false },
  OAUTH_INCOMPLETE: { status: 401, retryable: true },
  LANGUAGE_UNSUPPORTED: { status: 400, retryable: false },
  MESSAGE_INVALID: { status: 400, retryable: false },
  STORAGE_REF_INVALID: { status: 400, retryable: false },
  STORAGE_REF_FORBIDDEN: { status: 403, retryable: false },
  FILE_TYPE_UNSUPPORTED: { status: 400, retryable: false },
  FILE_TOO_LARGE: { status: 400, retryable: false },
  AUDIO_TOO_LONG: { status: 400, retryable: false },
  AUDIO_FORMAT_UNSUPPORTED: { status: 400, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  QUOTA_EXCEEDED: { status: 429, retryable: false },
  TRANSCRIPT_EMPTY: { status: 422, retryable: true },
  TRANSCRIPTION_FAILED: { status: 502, retryable: true },
  PROVIDERS_UNAVAILABLE: { status: 503, retryable: true },
  DIAGNOSIS_TIMEOUT: { status: 504, retryable: true },
  WEBHOOK_SIGNATURE_INVALID: { status: 401, retryable: false },
  WEBHOOK_SECRET_TOKEN_INVALID: { status: 401, retryable: false },
  PAYMENT_ORDER_FAILED: { status: 502, retryable: true },
  CONVERSATION_NOT_FOUND: { status: 404, retryable: false },
  DIAGNOSIS_NOT_FOUND: { status: 404, retryable: false },
  SWEEP_UNAUTHORIZED: { status: 401, retryable: false },
  INTERNAL_ERROR: { status: 500, retryable: true },
};

/**
 * Requirement 14.5's exact English text, and D6's decision that it is the English *rendering of a
 * code* rather than a literal at a call site.
 *
 * Written with `\u2019`-free ASCII on purpose: the requirement's sentence contains no typographic
 * punctuation, and a smart apostrophe or a non-breaking space slipped into the catalog is precisely
 * the kind of edit a byte-for-byte assertion exists to catch.
 */
const BUSY_EN = 'Jamee is temporarily busy. Please try again shortly.';

/** Details rich enough that every template renders without leaving a `{placeholder}` behind. */
const FULL_DETAILS = {
  limit: 20,
  used: 20,
  resetsAt: '2026-09-16T18:30:00.000Z',
  maxBytes: MAX_AUDIO_BYTES,
  maxSeconds: MAX_AUDIO_SECONDS,
  retryAfterSeconds: 30,
} as const;

async function envelopeOf(response: Response): Promise<ErrorEnvelope> {
  const body: unknown = await response.json();
  const parsed = errorEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`the response body is not an error envelope: ${JSON.stringify(body)}`);
  }
  return parsed.data;
}

/* ========================================================================== */
/* Every code, every language                                                  */
/* ========================================================================== */

describe('error mapping — the documented status, flag and message for every code', () => {
  const cases = ERROR_CODES.map((code) => [code, DOCUMENTED[code]] as const);

  it.each(cases)(
    '%s renders its documented status and flag, with a message in all three languages',
    async (code, documented) => {
      const error = new AppError(code, { details: FULL_DETAILS, context: { operation: 'voice' } });

      // What a service reads off the error it is about to throw.
      expect(error.status, `${code} status`).toBe(documented.status);
      expect(error.retryable, `${code} retryable`).toBe(documented.retryable);

      for (const language of SUPPORTED_LANGUAGES) {
        const response = errorResponse(error, language);
        expect(response.status, `${code}/${language} HTTP status`).toBe(documented.status);
        expect(response.headers.get('content-type')).toBe('application/json');

        const { error: body } = await envelopeOf(response);
        expect(body.code, `${code}/${language} code`).toBe(code);
        expect(body.language, `${code}/${language} language`).toBe(language);
        expect(body.retryable, `${code}/${language} retryable`).toBe(documented.retryable);
        expect(body.message.trim().length, `${code}/${language} message is empty`).toBeGreaterThan(0);
      }
    },
  );

  /**
   * The table above is a hand-written copy, which is the one thing that makes it worth having and
   * the one thing that can rot. This is the guard: a code added to the taxonomy has no documented
   * status until someone writes one here.
   */
  it('documents every code in the taxonomy, and no code outside it', () => {
    const codes = [...ERROR_CODES].sort();
    expect(Object.keys(DOCUMENTED).sort()).toEqual(codes);
    expect([...ALL_ERROR_CODES].sort()).toEqual(codes);
    for (const language of SUPPORTED_LANGUAGES) {
      expect(Object.keys(messages(language).errors).sort(), language).toEqual(codes);
    }
  });

  /**
   * And the mapping table in the source agrees with the documented one. Stated as its own assertion
   * rather than folded into the loop above so a divergence names which side moved: a failure here is
   * `ERROR_SPECS` drifting from the spec, while a failure above is the *rendering* drifting from
   * `ERROR_SPECS`.
   */
  it('carries the documented status and flag in ERROR_SPECS itself', () => {
    for (const code of ERROR_CODES) {
      expect({ status: ERROR_SPECS[code].status, retryable: ERROR_SPECS[code].retryable }, code).toEqual(
        DOCUMENTED[code],
      );
    }
  });
});

/* ========================================================================== */
/* Requirement 14.5 / D6 — the one sentence that is a requirement              */
/* ========================================================================== */

describe('PROVIDERS_UNAVAILABLE renders Requirement 14.5 byte for byte in en', () => {
  it('is the requirement text exactly, in the catalog and on the wire', async () => {
    expect(messages('en').errors.PROVIDERS_UNAVAILABLE).toBe(BUSY_EN);
    expect(toEnvelope(new AppError('PROVIDERS_UNAVAILABLE'), 'en').error.message).toBe(BUSY_EN);

    const response = errorResponse(new AppError('PROVIDERS_UNAVAILABLE'), 'en');
    expect(response.status).toBe(503);
    const { error: body } = await envelopeOf(response);
    expect(body.message).toBe(BUSY_EN);
    expect(body.retryable).toBe(true);

    // Byte for byte, not sentence for sentence: a smart apostrophe, a non-breaking space, a double
    // space or a dropped final period all survive `toBe` on a normalized comparison and none of them
    // survives this.
    expect([...body.message].map((character) => character.codePointAt(0))).toEqual(
      [...BUSY_EN].map((character) => character.codePointAt(0)),
    );
    expect(body.message).toHaveLength(BUSY_EN.length);
    expect(body.message.trim()).toBe(body.message);
    expect(/^[\u0020-\u007e]+$/.test(body.message)).toBe(true);
  });

  it('carries its own sentence in hi and mr rather than borrowing the English one', () => {
    for (const language of ['hi', 'mr'] as const) {
      const message = toEnvelope(new AppError('PROVIDERS_UNAVAILABLE'), language).error.message;
      expect(message.trim().length, language).toBeGreaterThan(0);
      expect(message, language).not.toBe(BUSY_EN);
      // Devanagari, which is what "localized" means for these two (Requirement 15.3).
      expect(message, language).toMatch(/[\u0900-\u097f]/);
    }
  });
});

/* ========================================================================== */
/* The named mappings the taxonomy promises a farmer                           */
/* ========================================================================== */

describe('error mapping — the specific promises the taxonomy makes', () => {
  /** Requirement 9.5: the refusal names the three supported codes in `details`. */
  it('LANGUAGE_UNSUPPORTED names en, hi and mr in details.supportedLanguages', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const { error } = toEnvelope(new AppError('LANGUAGE_UNSUPPORTED'), language);
      expect(error.details?.supportedLanguages, language).toEqual(['en', 'hi', 'mr']);
      expect(error.retryable, language).toBe(false);
    }
  });

  /**
   * Requirement 8.3: the sentence states both limits, and it states the numbers the check used —
   * `impliedDetails()` fills them from `config/verified.ts` rather than from the call site, so the
   * message cannot quote a limit nobody enforces.
   */
  it('AUDIO_TOO_LONG states 120 seconds and 10 MB in every language', () => {
    const megabytes = String(Math.round(MAX_AUDIO_BYTES / (1024 * 1024)));
    for (const language of SUPPORTED_LANGUAGES) {
      const { error } = toEnvelope(new AppError('AUDIO_TOO_LONG'), language);
      expect(error.details?.maxSeconds, language).toBe(MAX_AUDIO_SECONDS);
      expect(error.details?.maxBytes, language).toBe(MAX_AUDIO_BYTES);
      expect(error.message, language).toContain(String(MAX_AUDIO_SECONDS));
      expect(error.message, language).toContain(megabytes);
    }
  });

  /**
   * Requirement 14.3 and 15.3: the limit and the reset time are in the sentence, and the operation
   * is named in the farmer's own language. The English token `chat` in the middle of a Devanagari
   * sentence is the defect this pins.
   */
  it('QUOTA_EXCEEDED states the limit, the reset time and a localized operation word', () => {
    const error = new AppError('QUOTA_EXCEEDED', {
      details: { limit: 20, used: 20, resetsAt: '2026-09-16T18:30:00.000Z' },
      context: { operation: 'chat' },
    });

    for (const language of SUPPORTED_LANGUAGES) {
      const { error: body } = toEnvelope(error, language);
      const label = `QUOTA_EXCEEDED/${language}`;

      expect(body.message, label).toContain('20');
      // The reset instant as an Asia/Kolkata wall clock: 18:30 UTC is midnight, the next day.
      expect(body.message, label).toContain('12:00');
      expect(body.message, label).toContain(messages(language).operations.chat);
      expect(body.message, label).not.toMatch(/\{\w+\}/);
      expect(body.details?.resetsAt, label).toBe('2026-09-16T18:30:00.000Z');
      // Not retryable today, and the reset instant is why a client does not need a button.
      expect(body.retryable, label).toBe(false);
    }

    // The English token never reaches a Devanagari sentence.
    expect(toEnvelope(error, 'hi').error.message).not.toContain('chat');
    expect(toEnvelope(error, 'mr').error.message).not.toContain('chat');
  });

  /**
   * Three ways a voice request fails, three sentences. `TRANSCRIPT_EMPTY` asks for a quieter place
   * (Requirement 8.7), `TRANSCRIPTION_FAILED` is the provider's own failure (Requirement 8.4) and
   * `PROVIDERS_UNAVAILABLE` is an exhausted chain elsewhere (Requirement 14.8) — a farmer told the
   * wrong one of the three acts on the wrong thing.
   */
  it('gives the three voice outcomes three different sentences and three different statuses', () => {
    const codes: readonly ErrorCode[] = [
      'TRANSCRIPT_EMPTY',
      'TRANSCRIPTION_FAILED',
      'PROVIDERS_UNAVAILABLE',
    ];

    for (const language of SUPPORTED_LANGUAGES) {
      const rendered = codes.map((code) => toEnvelope(new AppError(code), language).error.message);
      expect(new Set(rendered).size, language).toBe(codes.length);
    }

    expect(codes.map((code) => DOCUMENTED[code].status)).toEqual([422, 502, 503]);
  });
});

/* ========================================================================== */
/* Requirement 15.6 — the body carries neither a stack nor a provider payload  */
/* ========================================================================== */

describe('error mapping — a cause reaches the log and not the body', () => {
  const logged: string[] = [];

  beforeEach(() => {
    logged.length = 0;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The stack is **captured here** rather than written as a fixture string, so it carries this
   * file's real frames — the shape a production failure actually has, including the
   * `errors.test.ts:NN:NN` locations a naive serializer would emit.
   */
  function providerFailure(canary: string): Error {
    const payload = `{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota exhausted for key sk-SYNTHETIC-PLACEHOLDER-${canary}"}}`;
    return new Error(payload);
  }

  it('omits the cause, the context and every frame of the stack from an AppError response', async () => {
    const canary = 'JAMEE-ERRORS-UNIT-CANARY';
    const cause = providerFailure(canary);
    expect(cause.stack ?? '', 'the fixture carries no stack to leak').toMatch(/errors\.test\.ts:\d+:\d+/);

    const error = new AppError('TRANSCRIPTION_FAILED', {
      cause,
      context: { reason: 'transcription_budget_exhausted', providerPayload: cause.message },
    });

    const response = errorResponse(error, 'hi');
    const body: unknown = await response.json();

    expect(response.status).toBe(502);
    expect(Object.keys(body as object)).toEqual(['error']);
    expect(Object.keys((body as { error: object }).error).sort()).toEqual([
      'code',
      'language',
      'message',
      'retryable',
    ]);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('transcription_budget_exhausted');
    expect(serialized).not.toContain('RESOURCE_EXHAUSTED');
    // No source location anywhere. The generic `at ` marker is deliberately not the rule:
    // `INTERNAL_ERROR`'s English sentence contains "at Jamee's end".
    expect(serialized).not.toMatch(/\.[cm]?tsx?:\d+:\d+/);
    // The message is the farmer's, and it is the code's own sentence.
    expect((body as ErrorEnvelope).error.message).toBe(messages('hi').errors.TRANSCRIPTION_FAILED);
  });

  it('turns an unhandled provider failure into a generic 500 and logs the cause once', async () => {
    const canary = 'JAMEE-ERRORS-UNIT-UNHANDLED';
    const cause = providerFailure(canary);

    const response = await withErrorHandling(
      () => Promise.reject(cause),
      () => 'mr' as Language,
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(500);
    expect((body as ErrorEnvelope).error.code).toBe('INTERNAL_ERROR');
    expect((body as ErrorEnvelope).error.message).toBe(messages('mr').errors.INTERNAL_ERROR);
    expect(JSON.stringify(body)).not.toContain(canary);
    expect(JSON.stringify(body)).not.toMatch(/\.[cm]?tsx?:\d+:\d+/);

    // The body can be bare because the record exists server-side. Both halves matter: a boundary
    // that dropped the cause would pass every assertion above and leave nothing to debug with.
    expect(logged).toHaveLength(1);
    expect(logged[0] ?? '').toContain(canary);
    expect(logged[0] ?? '').toContain('INTERNAL_ERROR');
  });
});
