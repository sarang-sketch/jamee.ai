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
  type QuotaStatus,
  type StorageRef,
} from '@/lib/schemas';
import type { DiagnosisDeps, DiagnosisOutcome } from '@/services/diagnosis.service';

import { POST, maxDuration } from './route';

/**
 * Wiring tests for `src/app/api/diagnose/route.ts`.
 *
 * Requirements: 1.7 (no session → 401 and no domain service invoked), 2.2 (the JSON body contract),
 *               3.7 (a budget expiry surfaces as the timeout the taxonomy defines), 9.5 (a language
 *               outside en/hi/mr is 400 naming the supported codes), 15.3 (one localized envelope)
 * Design: D1
 *
 * `diagnosis.service.test.ts` already decides what a diagnosis *is* — pipeline order, the spend
 * rule, the single inconclusive shape. What only this file can decide is what the **route** does
 * with it, so the service is a spy here and the assertions are about the boundary: was it reached,
 * how many times, with whose identity, with which client, and what came back on the wire.
 *
 * The two strongest tests are negative. A 401 that also proves `diagnose` was never entered is
 * Requirement 1.7's actual claim; a 400 that proves the same is Requirement 9.5's.
 */

/* -------------------------------------------------------------------------- */
/* Seams                                                                       */
/* -------------------------------------------------------------------------- */

const spies = vi.hoisted(() => ({
  currentUserId: vi.fn(),
  createServerSupabase: vi.fn(),
  diagnose: vi.fn(),
}));

/**
 * The identity resolver the route's wrapper was built over. Mocking the module rather than the
 * wrapper keeps the real guard under test — the route imports the real `authenticatedRoute`, and
 * only the answer to "who is signed in" is stubbed.
 */
vi.mock('@/lib/supabase/server', () => ({
  currentUserId: spies.currentUserId,
  createServerSupabase: spies.createServerSupabase,
}));

/**
 * The service, as a tripwire by default. Every test that expects a refusal leaves this rejecting,
 * so a route that reached the service would fail twice: once on the recorded call and once on the
 * status, because the throw would have become a 500.
 */
vi.mock('@/services/diagnosis.service', () => ({ diagnose: spies.diagnose }));

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const USER = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const DIAGNOSIS_ID = '55555555-5555-4555-8555-555555555555';

const IMAGE_REF: StorageRef = { bucket: 'crop-images', path: `${USER}/2026/09/${OBJECT_ID}.jpg` };

/** A sentinel, so "the RLS-scoped server client was passed through" is an identity assertion. */
const SUPABASE = { tag: 'rls-scoped-server-client' };

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
  spies.createServerSupabase.mockResolvedValue(SUPABASE);
  spies.diagnose.mockRejectedValue(
    new Error('tripwire: DiagnosisService.diagnose was reached for a request that must not reach it'),
  );
});

/* ========================================================================== */
/* Requirement 1.7 — the gate                                                  */
/* ========================================================================== */

describe('POST /api/diagnose with no session', () => {
  it('returns 401 and invokes no service, not even the Supabase client factory', async () => {
    spies.currentUserId.mockResolvedValue(null);

    const response = await post(validBody());
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(401);
    expect(envelope.error.code).toBe('AUTH_REQUIRED');

    /** The clause that matters: no domain service, and no request-scoped client either. */
    expect(spies.diagnose).not.toHaveBeenCalled();
    expect(spies.createServerSupabase).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* Requirement 2.2 — a valid body reaches the service once                     */
/* ========================================================================== */

describe('POST /api/diagnose with a valid body', () => {
  it('calls the service exactly once with the session user id and the RLS-scoped client', async () => {
    spies.diagnose.mockResolvedValue(OUTCOME);

    const response = await post(validBody());

    expect(response.status).toBe(200);
    expect(spies.diagnose).toHaveBeenCalledTimes(1);

    /**
     * Deep equality on both arguments, which is what makes this a contract test rather than a
     * smoke test:
     *  - `userId` is the resolved session id. A route that read an id out of the body would fail
     *    here, and Requirement 13.2 is exactly that distinction.
     *  - `channel: 'web'` is on the input, so Requirement 16.5's column is populated.
     *  - `deps` is `{ supabase, burst }` and nothing else — no store, no admin client. The
     *    `usage_logs` audit client is the service's own business (migration 0006 grants
     *    `authenticated` no insert policy), and an extra key here would fail this assertion.
     *    `burst` is Requirement 13.8's limiter: the API_Layer binds it because that requirement is
     *    written about the API_Layer's endpoints, while the *position* of the check — before the
     *    reserve, so a refusal costs nothing — stays the service's.
     */
    const expectedInput: DiagnoseInput = {
      userId: USER,
      storageRef: IMAGE_REF,
      language: 'hi',
      channel: 'web',
      conversationId: CONVERSATION_ID,
    };
    const [input, deps] = spies.diagnose.mock.calls[0] ?? [];
    expect(input).toEqual(expectedInput);
    expect(Object.keys(deps as DiagnosisDeps).sort()).toEqual(['burst', 'supabase']);
    expect((deps as DiagnosisDeps).supabase).toBe(SUPABASE);
    expect(typeof (deps as DiagnosisDeps).burst).toBe('function');
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
    /** `provider`, `usedFallback` and `rejectionReason` are audit facts, not farmer-facing. */
    expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual([
      'conversationId',
      'diagnosisId',
      'quota',
      'result',
    ]);
  });

  it('omits conversationId from the service input when the body carries none', async () => {
    spies.diagnose.mockResolvedValue(OUTCOME);

    await post({ image: IMAGE_REF, language: 'hi' });

    const expectedInput: DiagnoseInput = {
      userId: USER,
      storageRef: IMAGE_REF,
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
  it('returns 400 for a missing reference, a bad path, the wrong bucket, and non-JSON', async () => {
    const cases: { label: string; send: () => Promise<Response> }[] = [
      { label: 'no image', send: () => post({ language: 'hi' }) },
      {
        label: 'path outside the convention',
        send: () => post(validBody({ image: { bucket: 'crop-images', path: 'photo.jpg' } })),
      },
      {
        label: 'wrong bucket',
        send: () =>
          post(
            validBody({
              image: { bucket: 'voice-messages', path: `${USER}/2026/09/${OBJECT_ID}.jpg` },
            }),
          ),
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

    /** The status comes from the taxonomy, so the route holds no HTTP code of its own. */
    expect(response.status).toBe(504);
    expect(envelope.error.code).toBe('DIAGNOSIS_TIMEOUT');
    expect(envelope.error.retryable).toBe(true);
    /**
     * Requirement 15.3, and the reason the handler nests a second envelope: the language a farmer
     * reads the failure in is the one their body asked for, not the `Accept-Language` this request
     * never sent.
     */
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
