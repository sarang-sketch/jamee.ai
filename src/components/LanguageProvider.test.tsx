import { describe, expect, it } from 'vitest';

import {
  API_ENDPOINTS,
  jameeRequests,
  type FetchLike,
} from '@/components/LanguageProvider';
import { envelopeLanguage } from '@/lib/api/authenticated-route';
import { isAppError } from '@/lib/errors';
import {
  SUPPORTED_LANGUAGES,
  chatRequestSchema,
  diagnoseRequestSchema,
  voiceRequestSchema,
  type Language,
} from '@/lib/schemas';

/**
 * Unit tests for the propagation half of the switcher: whatever language is active must reach
 * the body of every diagnosis, chat and voice request.
 *
 * Requirements: 9.2 (the selected code is included in **every subsequent** diagnosis, chat and
 *               voice request), 2.2 / D1 amended (the diagnosis body is a Media_Reference, not
 *               media bytes — Amendment A3)
 *
 * `fetch` is supplied as a recorder rather than stubbed globally: the assertion that matters is
 * what is in the request body, and a recorder observes the real one the helper built. Nothing
 * else here is substituted — the bodies are validated by the same schemas the route handlers
 * use, so a body that passes this test is a body those handlers accept.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures — real shapes, not placeholders                                    */
/* -------------------------------------------------------------------------- */

const CONVERSATION = '7d1a4c2e-5b6f-4a8d-9c3e-2f1b0a9d8c7b';

/**
 * Media_References under Amendment A3 (D1 amended): a GridFS `{ fileId, kind }` pair, where
 * `fileId` is a 24-character lowercase-hex ObjectId. The old `{ bucket, path }` storage reference
 * predates GridFS — there is no path to fabricate here, only a hex id and a kind,
 * and `diagnoseRequestSchema`/`voiceRequestSchema` refine which kind each endpoint accepts.
 */
const IMAGE_REF = {
  fileId: '9a2b3c4d5e6f4a1b8c2d3e4f',
  kind: 'crop-image',
} as const;

const AUDIO_REF = {
  fileId: '1b2c3d4e5f60471882930a1b',
  kind: 'voice',
} as const;

interface Recorded {
  endpoint: string;
  init: RequestInit;
}

/** A fetch that records and answers, so the helper's own `Response` handling stays real. */
function recorder(): { calls: Recorded[]; fetchImpl: FetchLike } {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = (endpoint, init) => {
    calls.push({ endpoint, init });
    return Promise.resolve(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };
  return { calls, fetchImpl };
}

function sentBody(call: Recorded | undefined): unknown {
  expect(call).toBeDefined();
  expect(call?.init.method).toBe('POST');
  const body = call?.init.body;
  expect(typeof body).toBe('string');
  return JSON.parse(String(body));
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('jameeRequests', () => {
  /**
   * Requirement 9.2, stated as the test it deserves: not "diagnose carries a language" but
   * "each of the three endpoints carries the active code, for each of the three languages".
   * Nine combinations, because a mechanism that only works for the endpoint someone remembered
   * to check is the failure this design was chosen to prevent.
   */
  it('stamps the active language onto every diagnosis, chat and voice request', async () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const { calls, fetchImpl } = recorder();
      const requests = jameeRequests(language, fetchImpl);

      await requests.diagnose({ image: IMAGE_REF });
      await requests.chat({ conversationId: CONVERSATION, message: 'What is this?' });
      await requests.voice({
        audio: AUDIO_REF,
        conversationId: CONVERSATION,
        durationSeconds: 12.5,
      });

      expect(calls.map((call) => call.endpoint.split('?')[0])).toEqual([
        API_ENDPOINTS.diagnose,
        API_ENDPOINTS.chat,
        API_ENDPOINTS.voice,
      ]);

      for (const call of calls) {
        const body = sentBody(call);
        expect((body as { language: Language }).language).toBe(language);
      }
    }
  });

  /**
   * The error path reads the language before the body exists. `envelopeLanguage` refuses a request
   * without parsing its body, so an `AUTH_REQUIRED` for an expired session would otherwise be
   * written from `Accept-Language` — a different language from the farmer's selection on any
   * shared or second-hand phone. Asserted against that function itself rather than against a
   * remembered parameter name.
   */
  it('puts the language where a refusal made before the body parse can read it', async () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const { calls, fetchImpl } = recorder();
      await jameeRequests(language, fetchImpl).diagnose({ image: IMAGE_REF });

      const url = `https://jamee.test${calls[0]?.endpoint ?? ''}`;
      expect(envelopeLanguage({ url, headers: new Headers({ 'accept-language': 'fr-FR' }) })).toBe(
        language,
      );
    }
  });

  /** The bodies are the wire contracts, so they are asserted against the wire schemas. */
  it('sends bodies the route handlers will accept', async () => {
    const { calls, fetchImpl } = recorder();
    const requests = jameeRequests('mr', fetchImpl);

    await requests.diagnose({ image: IMAGE_REF, conversationId: CONVERSATION });
    await requests.chat({ conversationId: CONVERSATION, message: '\u0939\u0947 \u0915\u093E\u092F?' });
    await requests.voice({
      audio: AUDIO_REF,
      conversationId: CONVERSATION,
      durationSeconds: 30,
      mimeType: 'audio/webm;codecs=opus',
    });

    expect(diagnoseRequestSchema.parse(sentBody(calls[0])).language).toBe('mr');
    expect(chatRequestSchema.parse(sentBody(calls[1])).language).toBe('mr');
    expect(voiceRequestSchema.parse(sentBody(calls[2])).language).toBe('mr');

    for (const call of calls) {
      expect(new Headers(call.init.headers).get('content-type')).toBe('application/json');
    }
  });

  /** D1 amended: the body is a Media_Reference. A request that carried bytes would breach Requirement 2.7. */
  it('posts a media reference and no media bytes', async () => {
    const { calls, fetchImpl } = recorder();
    await jameeRequests('en', fetchImpl).diagnose({ image: IMAGE_REF });

    const body = sentBody(calls[0]);
    expect(body).toEqual({ image: IMAGE_REF, language: 'en' });
    expect(String(calls[0]?.init.body).length).toBeLessThan(400);
  });

  /**
   * The type-level half of Requirement 9.2. `@ts-expect-error` makes this a compile-time
   * assertion: if `language` ever becomes accepted here, `npm run typecheck` fails on this line,
   * because a second source for the value is exactly what would let a screen disagree with the
   * switcher. At runtime the active code still wins.
   */
  it('gives a caller no way to supply a language of its own', async () => {
    const { calls, fetchImpl } = recorder();
    const requests = jameeRequests('mr', fetchImpl);

    // @ts-expect-error `language` is not part of DiagnoseBody — the helper is its only source.
    await requests.diagnose({ image: IMAGE_REF, language: 'en' });

    expect((sentBody(calls[0]) as { language: Language }).language).toBe('mr');
  });

  /** A body Jamee itself built wrongly is a bug: it fails before spending a request. */
  it('refuses an invalid body without issuing a request', () => {
    const { calls, fetchImpl } = recorder();
    const requests = jameeRequests('hi', fetchImpl);

    expect(() =>
      requests.diagnose({
        // A thumbnail Media_Reference: `diagnoseRequestSchema.image` refines `kind === 'crop-image'`,
        // so a `thumbnail` ref is refused on purpose — a client cannot submit the Thumbnail_Derivative
        // as the object to diagnose. (Under A3 there is no path to fabricate, only a hex id and a kind.)
        image: {
          fileId: '9a2b3c4d5e6f4a1b8c2d3e4f',
          kind: 'thumbnail',
        },
      }),
    ).toThrow();

    try {
      requests.chat({ conversationId: 'not-a-uuid', message: 'hello' });
      expect.unreachable('an invalid conversation id must not reach the network');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect(isAppError(error) ? error.code : null).toBe('INTERNAL_ERROR');
    }

    expect(calls).toHaveLength(0);
  });

  it('reports the language it is carrying', () => {
    expect(jameeRequests('hi').language).toBe('hi');
  });
});
