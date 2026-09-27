import type { NextRequest } from 'next/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  JAMEE_MAX_DURATION_SECONDS,
  PLATFORM_MAX_DURATION_SECONDS,
} from '@/lib/config/verified';
import { AppError } from '@/lib/errors';
import { messages } from '@/lib/messages';
import {
  SUPPORTED_LANGUAGES,
  diagnoseResponseSchema,
  errorEnvelopeSchema,
  type DiagnoseInput,
  type InconclusiveResult,
  type MediaRef,
  type QuotaStatus,
} from '@/lib/schemas';
import type { DiagnosisDeps, DiagnosisOutcome } from '@/services/diagnosis.service';

import { POST, maxDuration } from './route';

/**
 * Wiring tests for `src/app/api/diagnose/route.ts` (Amendment A3).
 *
 * Requirements: 1.7 (no session → 401 and no domain service invoked), 2.2 (the JSON body carries a
 *               Media_Reference, not a storage path), 3.7 (a budget expiry surfaces as the timeout
 *               the taxonomy defines), 9.5 (a language outside en/hi/mr is 400 naming the supported
 *               codes), 15.3 (one localized envelope)
 * Design: D1 (amended — the request carries a Media_Reference and no bytes)
 *
 * `diagnosis.service.test.ts` decides what a diagnosis *is*. What only this file decides is what the
 * **route** does with it, so the service is a spy here and the assertions are about the boundary:
 * was it reached, how many times, with whose identity, and what came back on the wire. Under A3 the
 * route holds no database client — the service reads the image from GridFS through the
 * Data_Access_Layer — so `deps` is `{ burst }` alone.
 */

/* -------------------------------------------------------------------------- */
/* Seams                                                                       */
/* -------------------------------------------------------------------------- */

const spies = vi.hoisted(() => ({
  currentUserId: vi.fn(),
  diagnose: vi.fn(),
}));

/**
 * Amendment A3: `authenticatedRoute` resolves identity through `@/lib/auth/session`'s
 * `currentUserId` (Better Auth). Mocking the module rather than the wrapper keeps the real guard
 * under test — the route imports the real `authenticatedRoute`, and only "who is signed in" is
 * stubbed.
 */
vi.mock('@/lib/auth/session', () => ({
  currentUserId: spies.currentUserId,
}));

/**
 * The service, as a tripwire by default. Every test that expects a refusal leaves this rejecting,
 * so a route that reached the service would fail twice: on the recorded call and on the status.
 */
vi.mock('@/services/diagnosis.service', () => ({ diagnose: spies.diagnose }));

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const USER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const DIAGNOSIS_ID = '55555555-5555-4555-8555-555555555555';

/** A3: the body carries a `{ fileId, kind }` Media_Reference — a 24-hex ObjectId and a kind. */
const IMAGE_REF: MediaRef = { fileId: 'a'.repeat(24), kind: 'crop-image' };
const THUMB_REF: MediaRef = { fileId: 'b'.repeat(24), kind: 'thumbnail' };

const QUOTA: QuotaStatus = {
  operation: 'image',
  used: 3,
  limit: 20,
  resetsAt: '2026-09-16T18:30:00.000Z',
};

const INCONCLUSIVE: InconclusiveResult = {
  status: 'unknown',
  diseaseName: null,
  confidence: null,
  severity: 'none',
  explanation: messages('hi').inconclusive.model_unclear,
  knowledge: null,
  needsExpert: true,
  language: 'hi',
};

const OUTCOME: DiagnosisOutcome = {
  diagnosisId: DIAGNOSIS_ID,
  conversationId: CONVERSATION_ID,
  result: INCONCLUSIVE,
  quota: QUOTA,
  provider: 'gemini',
  usedFallback: false,
  rejectionReason: 'model_unclear',
};

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { image: IMAGE_REF, language: 'hi', conversationId: CONVERSATION_ID, ...overrides };
}

/** The handler takes a `NextRequest`; a plain `Request` carries everything this route reads. */
function post(body: unknown, options: { raw?: string } = {}): Promise<Response> {
  const request = new Request('https://jamee.test/api/diagnose', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: options.raw ?? JSON.stringify(body),
  });
  return POST(request as NextRequest);
}

async function envelopeOf(response: Response) {
  return errorEnvelopeSchema.parse(await response.json());
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.currentUserId.mockResolvedValue(USER);
  spies.diagnose.mockRejectedValue(
    new Error('tripwire: DiagnosisService.diagnose was reached for a request that must not reach it'),
  );
});

/* ========================================================================== */
/* Requirement 1.7 — the gate                                                  */
/* ========================================================================== */

describe('POST /api/diagnose with no session', () => {
  it('returns 401 and invokes no service', async () => {
    spies.currentUserId.mockResolvedValue(null);

    const response = await post(validBody());
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(401);
    expect(envelope.error.code).toBe('AUTH_REQUIRED');
    expect(spies.diagnose).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* Requirement 2.2 — a valid body reaches the service once                     */
/* ========================================================================== */

describe('POST /api/diagnose with a valid body', () => {
  it('calls the service exactly once with the session user id and burst-only deps', async () => {
    spies.diagnose.mockResolvedValue(OUTCOME);

    const response = await post(validBody());

    expect(response.status).toBe(200);
    expect(spies.diagnose).toHaveBeenCalledTimes(1);

    /**
     * Deep equality on the input, which makes this a contract test:
     *  - `userId` is the resolved session id, never read from the body (Requirement 13.2).
     *  - `image` is the Media_Reference the body carried (A3).
     *  - `channel: 'web'` populates Requirement 16.5's column.
     * `deps` is `{ burst }` and nothing else — under A3 the service holds no database client, so
     * there is no client to pass; `burst` is Requirement 13.8's limiter the API_Layer binds.
     */
    const expectedInput: DiagnoseInput = {
      userId: USER,
      image: IMAGE_REF,
      language: 'hi',
      channel: 'web',
      conversationId: CONVERSATION_ID,
    };
    const [input, deps] = spies.diagnose.mock.calls[0] ?? [];
    expect(input).toEqual(expectedInput);
    expect(Object.keys(deps as DiagnosisDeps)).toEqual(['burst']);
    expect(typeof (deps as DiagnosisDeps).burst).toBe('function');
  });

  it('passes the optional thumbnail reference through when the body carries one', async () => {
    spies.diagnose.mockResolvedValue(OUTCOME);

    await post(validBody({ thumbnail: THUMB_REF }));

    const expectedInput: DiagnoseInput = {
      userId: USER,
      image: IMAGE_REF,
      thumbnail: THUMB_REF,
      language: 'hi',
      channel: 'web',
      conversationId: CONVERSATION_ID,
    };
    expect(spies.diagnose).toHaveBeenCalledWith(expectedInput, expect.anything());
  });

  it('serializes exactly the four response fields, with no audit facts on the wire', async () => {
    spies.diagnose.mockResolvedValue(OUTCOME);

    const response = await post(validBody());
    const payload: unknown = await response.json();

    expect(response.headers.get('content-type')).toContain('application/json');
    expect(diagnoseResponseSchema.parse(payload)).toEqual({
      diagnosisId: DIAGNOSIS_ID,
      conversationId: CONVERSATION_ID,
      result: INCONCLUSIVE,
      quota: QUOTA,
    });
    expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual([
      'conversationId',
      'diagnosisId',
      'quota',
      'result',
    ]);
  });

  it('omits conversationId and thumbnail from the service input when the body carries neither', async () => {
    spies.diagnose.mockResolvedValue(OUTCOME);

    await post({ image: IMAGE_REF, language: 'hi' });

    const expectedInput: DiagnoseInput = {
      userId: USER,
      image: IMAGE_REF,
      language: 'hi',
      channel: 'web',
    };
    /** Requirement 7.5: absent, not `undefined` — the service find-or-creates the thread. */
    expect(spies.diagnose).toHaveBeenCalledWith(expectedInput, expect.anything());
  });
});

/* ========================================================================== */
/* Requirement 9.5 — an unsupported language                                   */
/* ========================================================================== */

describe('POST /api/diagnose with an unsupported language', () => {
  it('returns 400 naming the three supported codes, and calls no service', async () => {
    const response = await post(validBody({ language: 'ta' }));
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(400);
    expect(envelope.error.code).toBe('LANGUAGE_UNSUPPORTED');
    expect(envelope.error.details?.supportedLanguages).toEqual([...SUPPORTED_LANGUAGES]);
    expect(envelope.error.details?.supportedLanguages).toEqual(['en', 'hi', 'mr']);
    expect(spies.diagnose).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* Requirement 2.2 — a malformed body                                          */
/* ========================================================================== */

describe('POST /api/diagnose with a malformed body', () => {
  it('returns 400 for a missing reference, a bad fileId, the wrong kind, and non-JSON', async () => {
    const cases: { label: string; send: () => Promise<Response> }[] = [
      { label: 'no image', send: () => post({ language: 'hi' }) },
      {
        label: 'fileId not a 24-hex ObjectId',
        send: () => post(validBody({ image: { fileId: 'not-hex', kind: 'crop-image' } })),
      },
      {
        label: 'wrong kind (voice submitted as the image)',
        send: () => post(validBody({ image: { fileId: 'a'.repeat(24), kind: 'voice' } })),
      },
      {
        label: 'thumbnail kind on the image slot',
        send: () => post(validBody({ image: { fileId: 'a'.repeat(24), kind: 'thumbnail' } })),
      },
      { label: 'not JSON at all', send: () => post(null, { raw: 'not json' }) },
    ];

    for (const { label, send } of cases) {
      const response = await send();
      const envelope = await envelopeOf(response);

      expect(response.status, label).toBe(400);
      expect(envelope.error.code, label).toBe('STORAGE_REF_INVALID');
    }

    expect(spies.diagnose).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* Requirement 3.7 — the timeout                                               */
/* ========================================================================== */

describe('POST /api/diagnose when the diagnosis budget expires', () => {
  it("surfaces the service's DIAGNOSIS_TIMEOUT as 504, localized to the requested language", async () => {
    spies.diagnose.mockRejectedValue(new AppError('DIAGNOSIS_TIMEOUT'));

    const response = await post(validBody({ language: 'mr' }));
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(504);
    expect(envelope.error.code).toBe('DIAGNOSIS_TIMEOUT');
    expect(envelope.error.retryable).toBe(true);
    expect(envelope.error.language).toBe('mr');
    expect(envelope.error.message).toBe(messages('mr').errors.DIAGNOSIS_TIMEOUT);
  });
});

/* ========================================================================== */
/* V17 — the declared ceiling                                                  */
/* ========================================================================== */

describe("the route declares Jamee's own duration ceiling", () => {
  it('exports maxDuration as the resolved 60 s, not the platform maximum', () => {
    expect(maxDuration).toBe(JAMEE_MAX_DURATION_SECONDS);
    expect(maxDuration).toBeLessThan(PLATFORM_MAX_DURATION_SECONDS);
  });
});
