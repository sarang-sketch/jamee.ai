import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { edgeErrorFor, parseJsonBody, type BodyContract } from '@/lib/api/request-body';
import { isAppError, toEnvelope } from '@/lib/errors';
import { SUPPORTED_LANGUAGES, languageSchema } from '@/lib/schemas';

/**
 * The request-body edge: Requirement 9.5, in the one place it is now decided.
 *
 * Requirements: 9.5 (a language code outside the Supported_Languages is rejected with HTTP 400 and
 *               the supported codes are named), 9.2 (every supported code is accepted so the
 *               Web_App can send the farmer's selection on every request), 15.6 (the real parse
 *               failure stays server-side)
 * Design: *Ordered checks* step 2 — *"Request body Zod-parsed; unsupported language → 400 — no
 *          reserve"*
 *
 * `diagnose/route.test.ts`, `chat/route.test.ts` and `voice/route.test.ts` each already assert that
 * their endpoint returns 400 naming the three codes and reaches no service. What only this file can
 * assert is the thing that used to be untestable because it existed three times: that there is
 * **one** implementation of the rule, that its branch order is fixed, and that the list of codes in
 * the response is the same array the parse rejected against rather than a second copy of it.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A stand-in for the three request schemas, carrying only the fields the shared edge branches on.
 *
 * Deliberately not one of the real schemas: this file is testing the *edge*, and using
 * `chatRequestSchema` here would make every assertion also a statement about that endpoint's
 * contract — which is what the route tests are for. `language` is the real `languageSchema`, because
 * "the enum `schemas.ts` declares once" is the part under test.
 */
const bodySchema = z.object({
  language: languageSchema,
  conversationId: z.uuid(),
  size: z.number().max(10),
});

const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';

const CONTRACT: BodyContract = { fallback: 'STORAGE_REF_INVALID' };

/** An endpoint-specific branch, in the shape `/api/voice` contributes for Requirement 8.3. */
const CONTRACT_WITH_EXTRA: BodyContract = {
  fallback: 'STORAGE_REF_INVALID',
  endpointSpecific: (issues) =>
    issues.some((issue) => issue.path[0] === 'size' && issue.code === 'too_big')
      ? 'AUDIO_TOO_LONG'
      : null,
};

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { language: 'hi', conversationId: CONVERSATION_ID, size: 5, ...overrides };
}

function post(body: unknown, options: { raw?: string } = {}): Request {
  return new Request('https://jamee.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: options.raw ?? JSON.stringify(body),
  });
}

/** The thrown value as an `AppError`, so a plain `Error` escaping is a failure rather than a cast. */
async function refusalOf(request: Request, contract = CONTRACT) {
  try {
    await parseJsonBody(request, bodySchema, contract);
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected the edge to refuse this body');
}

/** The issue list a rejected body produces, as the edge receives it. */
function issuesFor(payload: unknown) {
  const parsed = bodySchema.safeParse(payload);
  if (parsed.success) throw new Error('expected this payload to be rejected');
  return parsed.error.issues;
}

/* ========================================================================== */
/* Requirement 9.5 — the refusal                                               */
/* ========================================================================== */

describe('the language branch', () => {
  it('refuses every code outside en, hi and mr with LANGUAGE_UNSUPPORTED and HTTP 400', async () => {
    /**
     * `ta` and `bn` are real language codes Jamee does not support, `en-IN` is a well-formed tag
     * whose primary subtag *is* supported — and it is still a refusal, because Requirement 9.5 is
     * about the codes the contract names and not about tag negotiation. `EN` covers the case a
     * client upper-cases the value it read back.
     */
    for (const language of ['ta', 'bn', 'en-IN', 'EN', 'english', '', 'en,hi']) {
      const error = await refusalOf(post(validBody({ language })));

      expect(error.code, language).toBe('LANGUAGE_UNSUPPORTED');
      expect(error.status, language).toBe(400);
      expect(error.retryable, language).toBe(false);
    }
  });

  it('refuses an absent language, and a non-string one', async () => {
    for (const body of [{ conversationId: CONVERSATION_ID, size: 5 }, validBody({ language: 3 })]) {
      const error = await refusalOf(post(body));
      expect(error.code).toBe('LANGUAGE_UNSUPPORTED');
    }
  });

  it('names the three supported codes from the array the parse rejected against', async () => {
    /**
     * The claim that matters: no caller writes the list. `LANGUAGE_UNSUPPORTED`'s implied details
     * come from `SUPPORTED_LANGUAGES`, which is `languageSchema.options` — the same enum the parse
     * above rejected against — so the response cannot name a code the schema would refuse, or omit
     * one it would accept.
     */
    const error = await refusalOf(post(validBody({ language: 'ta' })));
    const { error: envelope } = toEnvelope(error, 'en');

    expect(envelope.details?.supportedLanguages).toEqual([...SUPPORTED_LANGUAGES]);
    expect(envelope.details?.supportedLanguages).toEqual(['en', 'hi', 'mr']);
  });

  it('keeps the rejected field names server-side and out of the envelope', () => {
    /** Requirement 15.6: `context` is for the log line, and `toEnvelope` cannot read it. */
    const error = edgeErrorFor(issuesFor(validBody({ language: 'ta' })), CONTRACT);

    expect(error.context).toEqual({ reason: 'schema_rejected', paths: ['language'] });
    expect(JSON.stringify(toEnvelope(error, 'en'))).not.toContain('schema_rejected');
  });
});

/* ========================================================================== */
/* Requirement 9.2 — every supported code is accepted                          */
/* ========================================================================== */

describe('a body that satisfies the contract', () => {
  it('accepts each of the three supported codes and returns them typed', async () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const body = await parseJsonBody(post(validBody({ language })), bodySchema, CONTRACT);

      /**
       * The return type is the schema's output, which is why a route can hand `body.language` to a
       * service typed `Language` without re-validating: Requirement 9.5 is enforced exactly once,
       * here, and every layer behind it is closed to an unsupported code by the compiler.
       */
      expect(body.language).toBe(language);
      expect(body.conversationId).toBe(CONVERSATION_ID);
    }
  });
});

/* ========================================================================== */
/* Branch order                                                                */
/* ========================================================================== */

describe('the branch order', () => {
  it('puts the language refusal ahead of the conversation, the endpoint branch and the fallback', () => {
    /**
     * A body that is wrong in every way at once is `LANGUAGE_UNSUPPORTED`, because the language is
     * the thing Jamee will not do at all — telling a farmer their recording is too long, in a
     * language Jamee cannot write, would answer the wrong question twice.
     */
    const issues = issuesFor({ language: 'ta', conversationId: 'thread-1', size: 99 });

    expect(edgeErrorFor(issues, CONTRACT_WITH_EXTRA).code).toBe('LANGUAGE_UNSUPPORTED');
  });

  it('puts the conversation branch ahead of the endpoint branch and the fallback', () => {
    const issues = issuesFor(validBody({ conversationId: 'thread-1', size: 99 }));

    expect(edgeErrorFor(issues, CONTRACT_WITH_EXTRA).code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('consults the endpoint branch before the fallback, and falls through when it declines', () => {
    /** The mapper's own discrimination: `too_big` is its case, and anything else is not. */
    expect(edgeErrorFor(issuesFor(validBody({ size: 99 })), CONTRACT_WITH_EXTRA).code).toBe(
      'AUDIO_TOO_LONG',
    );
    expect(edgeErrorFor(issuesFor(validBody({ size: 'loud' })), CONTRACT_WITH_EXTRA).code).toBe(
      'STORAGE_REF_INVALID',
    );
  });

  it('takes the endpoint fallback for a body that fails in no more specific way', () => {
    /**
     * `fallback` is a parameter rather than a branch in the shared module because it is the one part
     * of the mapping that legitimately differs per endpoint — `/api/chat` names the farmer's
     * question, the other two name the storage reference.
     */
    const issues = issuesFor(validBody({ size: 'loud' }));

    expect(edgeErrorFor(issues, CONTRACT).code).toBe('STORAGE_REF_INVALID');
    expect(edgeErrorFor(issues, { fallback: 'MESSAGE_INVALID' }).code).toBe('MESSAGE_INVALID');
  });
});

/* ========================================================================== */
/* A body that is not JSON                                                     */
/* ========================================================================== */

describe('a body that is not JSON at all', () => {
  it("is the endpoint's 400 rather than a 500, with the parse failure logged not rendered", async () => {
    /**
     * A malformed body is the caller's fault, and letting `request.json()` throw into
     * `withErrorHandling` would report Jamee's fault for it — `INTERNAL_ERROR`, HTTP 500, retryable
     * true, over a request that will fail identically forever.
     */
    const error = await refusalOf(post(null, { raw: 'not json' }));

    expect(error.code).toBe('STORAGE_REF_INVALID');
    expect(error.status).toBe(400);
    expect(error.context).toEqual({ reason: 'body_not_json' });
    /** Requirement 15.6: the real cause is carried for the log and never for the wire. */
    expect(error.cause).toBeDefined();
    expect(JSON.stringify(toEnvelope(error, 'en'))).not.toContain('JSON');
  });

  it('takes the same endpoint fallback a schema rejection would', async () => {
    const error = await refusalOf(post(null, { raw: '{' }), { fallback: 'MESSAGE_INVALID' });

    expect(error.code).toBe('MESSAGE_INVALID');
  });
});
