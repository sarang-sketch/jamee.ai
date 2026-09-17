import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { offersRetryControl } from '@/components/ErrorBanner';
import { ProviderError } from '@/lib/ai/errors';
import {
  ALL_ERROR_CODES,
  AppError,
  ERROR_SPECS,
  toEnvelope,
  withErrorHandling,
  type AppErrorOptions,
} from '@/lib/errors';
import { messages } from '@/lib/messages';
import {
  ERROR_CODES,
  SUPPORTED_LANGUAGES,
  errorEnvelopeSchema,
  modelProviderSchema,
  operationSchema,
  type ErrorCode,
  type Language,
} from '@/lib/schemas';

/**
 * ### Property 29: The error envelope is total, localized, and leak-free
 *
 * **Validates: Requirements 15.3, 15.4, 15.6**
 *
 * Three claims, asserted separately because they fail in different ways:
 *
 *  - **total** — every code in the taxonomy renders, in every supported language, with the code
 *    that was raised and the retryable flag the taxonomy decided.
 *  - **localized** — the message is non-empty, written in that language's script, carries no
 *    unfilled `{placeholder}`, and is a different sentence in each of the three languages.
 *  - **leak-free** — for an error thrown anywhere behind `withErrorHandling`, including one
 *    carrying a stack trace or a provider payload, none of that material reaches the response.
 *
 * ### The domain is read out of the source, never copied into this file
 *
 * `ERROR_CODES` is the union's own array and it is what the loops iterate. A hand-written list here
 * would pass forever after the day a code is added — which is the one failure a totality property
 * exists to catch — so the first test pins the three source tables (`ERROR_SPECS`, the catalogs'
 * `errors` records, and `ALL_ERROR_CODES`) against that array, and every later assertion ranges over
 * the whole of it rather than over a sample. The code/language cross product is 22 × 3, small enough
 * to enumerate exhaustively on every fast-check run; what is *generated* is the data the sentences
 * interpolate and the shape of the adversarial cause.
 *
 * ### Every leak fixture is synthetic, and says so in its own text
 *
 * No value below resembles a real credential closely enough to be mistaken for one:
 * `sk-SYNTHETIC-PLACEHOLDER-…` names itself, and the canary token carries this file's name. The
 * fixtures are still adversarial in *shape* — a stack with file:line:column frames, a provider error
 * JSON body, a rejection thrown as a bare string, a rejection thrown as a plain object — because
 * that shape is what the leak boundary has to survive.
 */

/* ========================================================================== */
/* Recognisers                                                                 */
/* ========================================================================== */

/** Devanagari, the script `hi` and `mr` are written in. */
const DEVANAGARI = /[\u0900-\u097F]/;

/** `interpolate`'s own placeholder shape: an unfilled one reaches a farmer as `{limit}`. */
const PLACEHOLDER = /\{\w+\}/;

/**
 * A stack frame's source location — `diagnosis.service.ts:128:11`. The generic marker `at ` is
 * deliberately not used: `INTERNAL_ERROR`'s English sentence contains "at Jamee's end", so a rule
 * written that way would report the taxonomy's own copy as a stack trace.
 */
const STACK_FRAME_LOCATION = /\.[cm]?tsx?:\d+:\d+/;

/** Every key the envelope is allowed to carry. Anything else is a leak by construction. */
const ENVELOPE_ERROR_KEYS: readonly string[] = [
  'code',
  'message',
  'language',
  'retryable',
  'details',
];

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

/**
 * Details covering every key any template interpolates, so a rendered sentence that still shows a
 * `{placeholder}` is a real defect rather than an artefact of a thin fixture.
 *
 * Caller-supplied details win over `impliedDetails` key by key, so these are what the messages
 * render. `maxBytes` starts at one mebibyte because the sentence says `{maxMb} MB` and "0 MB" is a
 * distraction rather than a finding.
 */
const detailsArb = fc.record({
  limit: fc.integer({ min: 1, max: 500 }),
  used: fc.integer({ min: 0, max: 500 }),
  maxBytes: fc.integer({ min: 1024 * 1024, max: 64 * 1024 * 1024 }),
  maxSeconds: fc.integer({ min: 1, max: 600 }),
  retryAfterSeconds: fc.integer({ min: 0, max: 3600 }),
  /**
   * Built from an epoch second rather than from `fc.date`, so the instant is always valid and the
   * ISO string is always the one `errorDetailsSchema` accepts.
   */
  resetsAt: fc
    .integer({
      min: Math.trunc(Date.UTC(2024, 0, 1) / 1000),
      max: Math.trunc(Date.UTC(2035, 11, 31) / 1000),
    })
    .map((seconds) => new Date(seconds * 1000).toISOString()),
});

const operationArb = fc.constantFrom(...operationSchema.options);
const languageArb = fc.constantFrom(...SUPPORTED_LANGUAGES);
const codeArb = fc.constantFrom(...ERROR_CODES);

/** How the rejection reached `withErrorHandling`. Each shape hides the canaries somewhere else. */
type ThrownShape =
  | 'error-with-stack'
  | 'provider-error-cause'
  | 'nested-cause'
  | 'thrown-string'
  | 'thrown-object';

const leakFixtureArb = fc.record({
  code: codeArb,
  language: languageArb,
  shape: fc.constantFrom<ThrownShape>(
    'error-with-stack',
    'provider-error-cause',
    'nested-cause',
    'thrown-string',
    'thrown-object',
  ),
  provider: fc.constantFrom(...modelProviderSchema.options),
  status: fc.integer({ min: 400, max: 599 }),
  token: fc.integer({ min: 0x100000, max: 0xffffff }).map((value) => value.toString(16)),
  /** The language thunk itself can throw — the body parse it reads from is a request. */
  resolverThrows: fc.boolean(),
  retryAfterSeconds: fc.option(fc.integer({ min: 1, max: 3600 }), { nil: null }),
});

interface LeakFixture {
  readonly code: ErrorCode;
  readonly language: Language;
  readonly shape: ThrownShape;
  readonly provider: string;
  readonly status: number;
  readonly token: string;
  readonly resolverThrows: boolean;
  readonly retryAfterSeconds: number | null;
}

/* ========================================================================== */
/* The adversary                                                               */
/* ========================================================================== */

interface Adversary {
  /** What the handler throws. */
  readonly thrown: unknown;
  /** Server-side context, which `AppError` carries and the envelope may not. */
  readonly context: Readonly<Record<string, unknown>>;
  /** Strings that must not appear anywhere in the response. */
  readonly canaries: readonly string[];
}

function adversaryFor(fixture: LeakFixture): Adversary {
  const { provider, status, token } = fixture;

  const canary = `JAMEE-ERRORS-PROPERTY-CANARY-${token}`;
  const secret = `sk-SYNTHETIC-PLACEHOLDER-${canary}`;
  const frame = `    at callProvider (/var/task/src/lib/${provider}.ts:412:19)`;
  const payload = `{"error":{"code":${status},"status":"RESOURCE_EXHAUSTED","message":"${provider}: quota exhausted for key ${secret}"}}`;
  const stack = [
    `Error: ${payload}`,
    frame,
    '    at diagnose (/var/task/src/services/diagnosis.service.ts:128:11)',
  ].join('\n');

  const withStack = (message: string): Error => {
    const error = new Error(message);
    error.stack = stack;
    return error;
  };

  const thrown: unknown = ((): unknown => {
    switch (fixture.shape) {
      case 'error-with-stack':
        return withStack(payload);
      case 'provider-error-cause':
        /**
         * `ProviderError`'s own message is built from the status and the status name only, so the
         * payload sits one level down in `cause` — the case a leak boundary that only inspected the
         * top-level error would let through.
         */
        return new ProviderError({
          failure: 'RATE_LIMIT',
          status,
          statusName: 'RESOURCE_EXHAUSTED',
          retryAfterSeconds: 30,
          cause: withStack(payload),
        });
      case 'nested-cause':
        return new Error('upstream call failed', { cause: withStack(payload) });
      case 'thrown-string':
        /** Not every rejection is an `Error`. `logCause` stringifies this one. */
        return stack;
      case 'thrown-object':
        return { apiKey: secret, response: { body: payload }, stack };
    }
  })();

  return {
    thrown,
    /**
     * `operation` is the one context key `toEnvelope` reads. Setting it to the canary is the sharper
     * test: the value goes through `operationSchema`, so it must leave `{operation}` unfilled rather
     * than reach the sentence.
     */
    context: {
      operation: canary,
      apiKey: secret,
      providerPayload: payload,
      stack: frame,
    },
    canaries: [canary, secret, payload, frame, provider],
  };
}

/**
 * Everything a rejection carries, flattened — used to prove the fixture really *is* adversarial
 * before asserting that the response is clean. Without this guard a builder that quietly dropped
 * its canaries would make every leak assertion pass vacuously.
 */
function leakMaterial(value: unknown, depth = 0): string {
  if (depth > 4) return '';
  if (value instanceof Error) {
    return [value.message, value.stack ?? '', leakMaterial(value.cause, depth + 1)].join('\n');
  }
  /**
   * Walked value by value rather than `JSON.stringify`d: stringifying escapes the quotes inside a
   * nested provider payload, so the raw canary would no longer be a substring of it and this guard
   * would report a fixture that is in fact carrying it.
   */
  if (typeof value === 'object' && value !== null) {
    return Object.values(value)
      .map((nested) => leakMaterial(nested, depth + 1))
      .join('\n');
  }
  return String(value);
}

/* ========================================================================== */
/* Shared assertions                                                           */
/* ========================================================================== */

function expectLeakFree(
  response: Response,
  body: unknown,
  canaries: readonly string[],
  expected: { readonly code: ErrorCode; readonly language: Language },
): void {
  const parsed = errorEnvelopeSchema.safeParse(body);
  expect(parsed.success, `envelope did not parse: ${JSON.stringify(body)}`).toBe(true);
  if (!parsed.success) return;

  expect(parsed.data.error.code).toBe(expected.code);
  expect(parsed.data.error.language).toBe(expected.language);
  expect(parsed.data.error.message.trim().length).toBeGreaterThan(0);

  // Structural: the body is the envelope and nothing else, so a cause has nowhere to sit.
  expect(Object.keys(body as object)).toEqual(['error']);
  for (const key of Object.keys((body as { error: object }).error)) {
    expect(ENVELOPE_ERROR_KEYS, `unexpected envelope key ${key}`).toContain(key);
  }

  const serialized = JSON.stringify(body);
  for (const canary of canaries) {
    expect(serialized, `envelope leaked ${canary}`).not.toContain(canary);
  }
  expect(serialized).not.toMatch(STACK_FRAME_LOCATION);

  // A header is part of the response too, and `errorResponse` sets one from the details.
  for (const [name, value] of response.headers) {
    for (const canary of canaries) {
      expect(value, `header ${name} leaked ${canary}`).not.toContain(canary);
    }
  }
}

/* ========================================================================== */
/* The property                                                                */
/* ========================================================================== */

describe('Property 29: the error envelope is total, localized, and leak-free', () => {
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
   * The anchor for everything below: the taxonomy the loops range over is the source's own array,
   * and the two tables plus the three catalogs agree with it exactly. A code added to `ERROR_CODES`
   * with no spec or no translation fails here, not silently in production.
   */
  it('is exhaustive by construction: every source table agrees with ERROR_CODES', () => {
    const codes = [...ERROR_CODES].sort();

    expect(Object.keys(ERROR_SPECS).sort()).toEqual(codes);
    expect([...ALL_ERROR_CODES].sort()).toEqual(codes);
    for (const language of SUPPORTED_LANGUAGES) {
      expect(Object.keys(messages(language).errors).sort(), language).toEqual(codes);
    }
  });

  /**
   * Claim 1 and 2 — total, localized, and an accurate flag that gates the retry control.
   *
   * The flag is checked twice on purpose: once as the value on the wire (Requirement 15.3's stable
   * contract) and once through `offersRetryControl`, which is what the banner uses to decide whether
   * a retry button exists at all (Requirement 15.4). A code the taxonomy calls unretryable must not
   * be able to produce one.
   */
  it('renders every code in every language with an accurate retryable flag', () => {
    fc.assert(
      fc.property(detailsArb, operationArb, (details, operation) => {
        for (const code of ERROR_CODES) {
          const spec = ERROR_SPECS[code];
          const error = new AppError(code, { details, context: { operation } });
          const rendered = new Set<string>();

          for (const language of SUPPORTED_LANGUAGES) {
            const envelope = toEnvelope(error, language);
            const parsed = errorEnvelopeSchema.safeParse(envelope);
            expect(parsed.success, `${code}/${language} did not parse`).toBe(true);

            const { error: body } = envelope;
            expect(body.code).toBe(code);
            expect(body.language).toBe(language);
            expect(body.message.trim().length).toBeGreaterThan(0);
            expect(body.message, `${code}/${language} left a placeholder unfilled`).not.toMatch(
              PLACEHOLDER,
            );

            // Localized: the sentence is written in the script that language uses.
            if (language === 'en') {
              expect(body.message, `${code}/en is not in Latin script`).not.toMatch(DEVANAGARI);
            } else {
              expect(body.message, `${code}/${language} is not in Devanagari`).toMatch(DEVANAGARI);
            }

            // Requirement 15.4 — the flag is the taxonomy's decision, and it gates the control.
            expect(body.retryable).toBe(spec.retryable);
            expect(offersRetryControl(body, { kind: 'action', onRetry: () => undefined })).toBe(
              spec.retryable,
            );
            expect(offersRetryControl(body, { kind: 'control' })).toBe(false);
            expect(offersRetryControl(body, { kind: 'none' })).toBe(false);

            rendered.add(body.message);
          }

          // Three languages, three sentences — not one string echoed three times.
          expect(rendered.size, `${code} is not distinct across the three languages`).toBe(
            SUPPORTED_LANGUAGES.length,
          );
        }
      }),
      { numRuns: 25 },
    );
  });

  /**
   * Claim 3 — leak-freedom, through the wrapper every route handler leaves by.
   *
   * Both branches are exercised on every fixture: an `AppError` (a decision Jamee made, keeping its
   * own status) and an unhandled rejection (a bug, which must become HTTP 500 `INTERNAL_ERROR` —
   * Requirement 15.6). The same canaries are asserted absent from both.
   */
  it('never lets a stack trace or a provider payload reach the response', async () => {
    await fc.assert(
      fc.asyncProperty(leakFixtureArb, async (fixture) => {
        const { thrown, context, canaries } = adversaryFor(fixture);

        // Guard against a vacuous pass: the fixture must actually carry every canary.
        const material = `${leakMaterial(thrown)}\n${leakMaterial(context)}`;
        for (const canary of canaries) {
          expect(material, `fixture ${fixture.shape} does not carry ${canary}`).toContain(canary);
        }

        const expectedLanguage: Language = fixture.resolverThrows ? 'en' : fixture.language;
        const resolveLanguage = (): Language => {
          // Carries the canaries too: a thunk that throws is itself an error in the API layer.
          if (fixture.resolverThrows) throw new Error(`body parse failed: ${canaries.join(' ')}`);
          return fixture.language;
        };

        /* ── The AppError branch: Jamee's own decision, its own status ────── */
        const options: AppErrorOptions = { cause: thrown, context };
        if (fixture.retryAfterSeconds !== null) {
          options.details = { retryAfterSeconds: fixture.retryAfterSeconds };
        }

        const before = logged.length;
        const decided = await withErrorHandling(async () => {
          throw new AppError(fixture.code, options);
        }, resolveLanguage);

        expect(decided.status).toBe(ERROR_SPECS[fixture.code].status);
        expectLeakFree(decided, await decided.json(), canaries, {
          code: fixture.code,
          language: expectedLanguage,
        });

        /* ── The unhandled branch: a bug, generic 500 outward ─────────────── */
        const unhandled = await withErrorHandling(async () => {
          throw thrown;
        }, resolveLanguage);

        expect(unhandled.status).toBe(500);
        expectLeakFree(unhandled, await unhandled.json(), canaries, {
          code: 'INTERNAL_ERROR',
          language: expectedLanguage,
        });

        // The cause is recorded server-side rather than dropped — the log is why the body can be bare.
        expect(logged.length).toBeGreaterThan(before);
      }),
      { numRuns: 60 },
    );
  });
});
