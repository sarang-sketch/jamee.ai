/**
 * @vitest-environment node
 *
 * `src/lib/groq.ts` is a `server-only` module, so its tests belong in the environment it actually
 * runs in. The unit project defaults to jsdom for the component tests, and that default produced a
 * false negative here rather than a preference: `groq-sdk` probes whether the ambient `Response`
 * can serialize a `FormData` before it will build a multipart request, and jsdom's cannot — so the
 * transcription endpoint test failed on a DOM shim limitation that no Jamee runtime has. V17 pins
 * every route handler to the Node.js runtime, which is what this line matches.
 */
import Groq, { APIError } from 'groq-sdk';
import { describe, expect, it } from 'vitest';

import { isFallbackTrigger, isProviderError, retryAfterSecondsOf } from '@/lib/ai/errors';
import { providersFor, run, type ProviderCall } from '@/lib/ai/gateway';
import {
  GROQ_MAX_COMPLETION_TOKENS_PARAM,
  GROQ_TEXT_MODEL,
  GROQ_TRANSCRIBE_ENDPOINT,
  GROQ_TRANSCRIBE_MODEL,
  GROQ_VISION_MAX_REQUEST_BYTES,
  MAX_AUDIO_SECONDS,
  TRANSCRIBE_ACCEPTED_CONTAINERS,
  TRANSCRIBE_MIN_SECONDS,
  TRANSCRIBE_PROVIDER_MAX_BYTES,
  TRANSCRIBE_RESPONSE_FORMAT,
} from '@/lib/config/verified';
import { isAppError, type AppError } from '@/lib/errors';
import {
  assertTranscribableAudio,
  classifyGroqError,
  groqTextAdapter,
  groqTranscribeAdapter,
  groqTranscribeMember,
  groqVisionMember,
  isAcceptedAudioContainer,
  normalizeAudioContainer,
  GROQ_MAX_COMPLETION_TOKENS,
  GROQ_SDK_MAX_RETRIES,
  GROQ_TEMPERATURE,
  GROQ_TRANSCRIBE_TEMPERATURE,
  toGroqProviderError,
  visionRequestBytes,
  type GroqChatCreate,
  type GroqChatRequest,
  type GroqRequestOptions,
  type GroqTranscriptionCreate,
  type GroqTranscriptionRequest,
  type TranscribeRequest,
} from '@/lib/groq';
import { SUPPORTED_LANGUAGES } from '@/lib/schemas';

/**
 * Unit tests for the Groq adapters, with the SDK call stubbed at the `create` seam.
 *
 * Nothing here reaches the network and nothing reads `GROQ_API_KEY`: every test injects a `create`
 * function, which is the seam that exists so an adapter is testable without mocking a module. The
 * one test that builds a real `Groq` client injects `fetch` instead, because the fact it asserts —
 * which URL the SDK method actually posts to — cannot be observed at the `create` seam.
 *
 * Requirements: 8.4, 8.5, 14.4, 14.8
 * Depends on: V8 (model id, `max_completion_tokens`), V9 (the conditional vision member, the 20 MB
 *             request ceiling), V10 (the transcription model, endpoint, containers and caps, and
 *             U-V10's missing duration cap), V11 (the error table)
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function providerCall(overrides: Partial<ProviderCall> = {}): ProviderCall {
  return {
    signal: new AbortController().signal,
    timeoutMs: 15_000,
    deadlineMs: 1_700_000_045_000,
    capability: 'text-generate',
    attempt: 1,
    ...overrides,
  };
}

function completion(content: string | null): Groq.Chat.ChatCompletion {
  return {
    id: 'chatcmpl-stub',
    created: 1,
    model: 'stub',
    object: 'chat.completion',
    choices: [{ finish_reason: 'stop', index: 0, logprobs: null, message: { role: 'assistant', content } }],
  };
}

function completionWithNoChoices(): Groq.Chat.ChatCompletion {
  return { id: 'chatcmpl-stub', created: 1, model: 'stub', object: 'chat.completion', choices: [] };
}

interface Recorded {
  body: GroqChatRequest;
  options: GroqRequestOptions;
}

/** A `create` stub that records what it was handed and answers with `content`. */
function recordingCreate(content: string | null = '{"ok":true}'): {
  create: GroqChatCreate;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const create: GroqChatCreate = (body, options) => {
    calls.push({ body, options });
    return Promise.resolve(content === null ? completionWithNoChoices() : completion(content));
  };
  return { create, calls };
}

function rejectingCreate(error: unknown): GroqChatCreate {
  return () => Promise.reject(error);
}

/** The shape `groq-sdk` rejects with: a numeric `status` and a `Headers` object. */
function sdkRejection(status: number, headers: Record<string, string> = {}): unknown {
  return { status, headers: new Headers(headers), error: { message: 'provider prose', type: 'x' } };
}

/* -------------------------------------------------------------------------- */
/* Error classification — V11                                                  */
/* -------------------------------------------------------------------------- */

describe('classifyGroqError', () => {
  it('maps 429 to RATE_LIMIT and 500/502/503 to UNAVAILABLE', () => {
    expect(classifyGroqError(sdkRejection(429))).toBe('RATE_LIMIT');
    expect(classifyGroqError(sdkRejection(500))).toBe('UNAVAILABLE');
    expect(classifyGroqError(sdkRejection(502))).toBe('UNAVAILABLE');
    expect(classifyGroqError(sdkRejection(503))).toBe('UNAVAILABLE');
  });

  it('keeps 413 and 422 out of the fallback path', () => {
    // 413 is Jamee's own oversized payload; 422 is documented to include model hallucinations.
    // Either one retried on a second provider fails identically and spends a call to learn nothing.
    for (const status of [413, 422]) {
      const failure = classifyGroqError(sdkRejection(status));
      expect(failure).toBe('OTHER');
      expect(isFallbackTrigger(failure)).toBe(false);
    }
  });

  it('classifies an unrecognized signal as OTHER', () => {
    expect(classifyGroqError(new Error('socket hang up'))).toBe('OTHER');
    expect(classifyGroqError(sdkRejection(418))).toBe('OTHER');
    expect(classifyGroqError({ status: 'gateway timeout' })).toBe('OTHER');
    expect(classifyGroqError(undefined)).toBe('OTHER');
    // An abort carries no status, which is also how the SDK's own abort error arrives.
    expect(classifyGroqError(new DOMException('aborted', 'AbortError'))).toBe('OTHER');
  });

  it('reads a real groq-sdk APIError, not just a stub of one', () => {
    const error = new APIError(
      503,
      { error: { message: 'service unavailable', type: 'internal_server_error' } },
      'service unavailable',
      new Headers(),
    );
    expect(classifyGroqError(error)).toBe('UNAVAILABLE');
  });
});

describe('toGroqProviderError', () => {
  it('parses retry-after as seconds off a 429', () => {
    const normalized = toGroqProviderError(sdkRejection(429, { 'retry-after': '30' }));

    expect(normalized.failure).toBe('RATE_LIMIT');
    expect(normalized.status).toBe(429);
    // V11: seconds, not milliseconds and not an HTTP date.
    expect(normalized.retryAfterSeconds).toBe(30);
    expect(retryAfterSecondsOf(normalized)).toBe(30);
  });

  it('reads retry-after off a real APIError and rounds up a fractional value', () => {
    const error = new APIError(
      429,
      { error: { message: 'rate limit reached', type: 'rate_limit_exceeded' } },
      'rate limit reached',
      new Headers({ 'retry-after': '2.4' }),
    );
    expect(toGroqProviderError(error).retryAfterSeconds).toBe(3);
  });

  it('leaves retry-after absent when the header is missing or unusable', () => {
    expect(toGroqProviderError(sdkRejection(429)).retryAfterSeconds).toBeUndefined();
    expect(
      toGroqProviderError(sdkRejection(429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))
        .retryAfterSeconds,
    ).toBeUndefined();
    expect(toGroqProviderError(new Error('boom')).retryAfterSeconds).toBeUndefined();
  });

  it('keeps the provider message text out of its own message and holds it only as the cause', () => {
    const rejection = sdkRejection(500);
    const normalized = toGroqProviderError(rejection);

    expect(normalized.message).toBe('provider failure UNAVAILABLE (HTTP 500)');
    expect(normalized.message).not.toContain('provider prose');
    expect(normalized.cause).toBe(rejection);
  });
});

/* -------------------------------------------------------------------------- */
/* The text adapter — V8                                                       */
/* -------------------------------------------------------------------------- */

describe('groqTextAdapter', () => {
  it('sends the resolved model id and max_completion_tokens, never max_tokens', async () => {
    const { create, calls } = recordingCreate('Spray in the evening.');
    const adapter = groqTextAdapter({ create });

    const answer = await adapter.invoke({ prompt: 'Rephrase this.' }, providerCall());

    expect(answer).toBe('Spray in the evening.');
    expect(adapter.id).toBe('groq');
    expect(adapter.model).toBe(GROQ_TEXT_MODEL);

    const recorded = calls[0];
    expect(recorded).toBeDefined();
    const body = recorded?.body as unknown as Record<string, unknown>;
    expect(body.model).toBe(GROQ_TEXT_MODEL);
    // V8: the official examples use `max_completion_tokens`. `max_tokens` is silently ignored
    // rather than rejected, which is why its absence is asserted rather than assumed.
    expect(body[GROQ_MAX_COMPLETION_TOKENS_PARAM]).toBe(GROQ_MAX_COMPLETION_TOKENS.generate);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.temperature).toBe(GROQ_TEMPERATURE);
    // A rephrase is prose, so JSON mode is off unless the caller asks for it.
    expect(body).not.toHaveProperty('response_format');
    expect(recorded?.body.messages).toEqual([{ role: 'user', content: 'Rephrase this.' }]);
  });

  it('passes the call signal, the attempt timeout, and no SDK-internal retries to the SDK', async () => {
    const { create, calls } = recordingCreate();
    const controller = new AbortController();
    const call = providerCall({ signal: controller.signal, timeoutMs: 12_345 });

    await groqTextAdapter({ create }).invoke({ prompt: 'hi' }, call);

    // The shared deadline can only cut a hung provider call if the signal actually arrives.
    expect(calls[0]?.options.signal).toBe(controller.signal);
    expect(calls[0]?.options.timeout).toBe(12_345);
    expect(calls[0]?.options.maxRetries).toBe(GROQ_SDK_MAX_RETRIES);
  });

  it('carries a system instruction and an explicit token cap and JSON mode when asked', async () => {
    const { create, calls } = recordingCreate('{}');

    await groqTextAdapter({ create }).invoke(
      { prompt: 'question', system: 'answer briefly', maxCompletionTokens: 64, json: true },
      providerCall(),
    );

    expect(calls[0]?.body.messages).toEqual([
      { role: 'system', content: 'answer briefly' },
      { role: 'user', content: 'question' },
    ]);
    expect(calls[0]?.body.max_completion_tokens).toBe(64);
    // V9: a plain JSON-object mode, not a schema-enforced one.
    expect(calls[0]?.body.response_format).toEqual({ type: 'json_object' });
  });

  it('returns raw output, including an empty string, rather than judging content', async () => {
    // Not an error: D2's stage-1 validation is the one place an answer is called unusable, so an
    // empty completion stays on the inconclusive path instead of looking like a provider outage.
    const nullContent = recordingCreate(null);
    await expect(
      groqTextAdapter({ create: nullContent.create }).invoke({ prompt: 'x' }, providerCall()),
    ).resolves.toBe('');
  });

  it('normalizes an SDK rejection into a classified ProviderError', async () => {
    const adapter = groqTextAdapter({ create: rejectingCreate(sdkRejection(429, { 'retry-after': '7' })) });

    await expect(adapter.invoke({ prompt: 'x' }, providerCall())).rejects.toSatisfy(
      (error: unknown) =>
        isProviderError(error) && error.failure === 'RATE_LIMIT' && error.retryAfterSeconds === 7,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The conditional vision member — V9                                          */
/* -------------------------------------------------------------------------- */

describe('groqVisionMember', () => {
  it('registers no member when the config constant is null', () => {
    const member = groqVisionMember(null);

    expect(member).toEqual({});
    expect(member.groq).toBeUndefined();
    expect(Object.keys(member)).toHaveLength(0);
  });

  it('registers the member carrying the configured model id when the constant is set', () => {
    const member = groqVisionMember('qwen/qwen3.8-27b');

    expect(member.groq?.id).toBe('groq');
    expect(member.groq?.model).toBe('qwen/qwen3.8-27b');
  });

  it('sends the configured model, one image_url content part, and JSON mode', async () => {
    const { create, calls } = recordingCreate('{"disease_name":"Tomato Early Blight"}');
    const adapter = groqVisionMember('qwen/qwen3.6-27b', { create }).groq;
    expect(adapter).toBeDefined();

    const raw = await adapter?.invoke(
      { imageUrl: 'https://example.test/signed/leaf.jpg', prompt: 'Classify.' },
      providerCall({ capability: 'vision-classify' }),
    );

    expect(raw).toBe('{"disease_name":"Tomato Early Blight"}');
    const body = calls[0]?.body;
    expect(body?.model).toBe('qwen/qwen3.6-27b');
    expect(body?.max_completion_tokens).toBe(GROQ_MAX_COMPLETION_TOKENS.classify);
    expect(body?.response_format).toEqual({ type: 'json_object' });
    expect(body?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Classify.' },
          { type: 'image_url', image_url: { url: 'https://example.test/signed/leaf.jpg' } },
        ],
      },
    ]);
  });

  it('refuses a request over V9 20 MB ceiling without spending the call', async () => {
    const { create, calls } = recordingCreate();
    const adapter = groqVisionMember('qwen/qwen3.8-27b', { create }).groq;
    const oversized = {
      imageUrl: `data:image/jpeg;base64,${'A'.repeat(GROQ_VISION_MAX_REQUEST_BYTES)}`,
      prompt: 'Classify.',
    };

    expect(visionRequestBytes(oversized)).toBeGreaterThan(GROQ_VISION_MAX_REQUEST_BYTES);
    await expect(
      adapter?.invoke(oversized, providerCall({ capability: 'vision-classify' })),
    ).rejects.toSatisfy(
      // The 413 the provider would have answered with — and V11 puts 413 on OTHER, so it fails
      // fast instead of asking a second provider about the same bytes.
      (error: unknown) => isProviderError(error) && error.status === 413 && error.failure === 'OTHER',
    );
    expect(calls).toHaveLength(0);
  });

  it('measures a data URI without re-encoding it', () => {
    expect(visionRequestBytes({ imageUrl: 'data:image/png;base64,AAAA', prompt: 'ab' })).toBe(28);
    // A multi-byte prompt counts its UTF-8 bytes, not its characters.
    expect(visionRequestBytes({ imageUrl: 'x', prompt: 'टमाटर' })).toBe(1 + 15);
  });
});

/* -------------------------------------------------------------------------- */
/* The transcription adapter — V10                                             */
/* -------------------------------------------------------------------------- */

interface RecordedTranscription {
  body: GroqTranscriptionRequest;
  options: GroqRequestOptions;
}

/** A `verbose_json`-shaped payload. Only `text` is typed by the SDK; the rest is V10's. */
function verbosePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: 'मेरे टमाटर के पत्तों पर धब्बे हैं',
    language: 'hindi',
    duration: 6.24,
    ...overrides,
  };
}

function recordingTranscribe(payload: unknown = verbosePayload()): {
  create: GroqTranscriptionCreate;
  calls: RecordedTranscription[];
} {
  const calls: RecordedTranscription[] = [];
  const create: GroqTranscriptionCreate = (body, options) => {
    calls.push({ body, options });
    return Promise.resolve(payload);
  };
  return { create, calls };
}

function transcribeRequest(overrides: Partial<TranscribeRequest> = {}): TranscribeRequest {
  return {
    audioBytes: Buffer.from('fake-opus-bytes'),
    container: 'audio/webm;codecs=opus',
    language: 'hi',
    ...overrides,
  };
}

function transcribeCall(overrides: Partial<ProviderCall> = {}): ProviderCall {
  return providerCall({ capability: 'transcribe', timeoutMs: 20_000, attempt: 0, ...overrides });
}

/**
 * The developer-facing reason a pre-flight refusal carries.
 *
 * It lives on `cause`, not on `ProviderError.message`, and that is deliberate rather than
 * incidental: `ProviderError` builds its own message from the status and status name alone so no
 * provider payload fragment reaches a log line (Requirement 15.6). Reading through `cause` is what
 * a test — and an operator — has to do, so the test does it the same way.
 */
function refusalReason(input: TranscribeRequest): string {
  try {
    assertTranscribableAudio(input);
  } catch (error) {
    if (isProviderError(error) && error.cause instanceof Error) return error.cause.message;
    throw error;
  }
  throw new Error('expected assertTranscribableAudio to refuse this request');
}

describe('groqTranscribeAdapter', () => {
  it('registers the V10 model id under the groq provider', () => {
    const adapter = groqTranscribeAdapter();

    expect(adapter.id).toBe('groq');
    expect(adapter.model).toBe(GROQ_TRANSCRIBE_MODEL);
    // V10 records turbo as transcription-only, which is the capability Jamee needs — it transcribes
    // and then answers in the farmer's language through `text-generate`.
    expect(GROQ_TRANSCRIBE_MODEL).toBe('whisper-large-v3-turbo');
  });

  it('sends the resolved model, verbose_json, temperature 0, and the audio by file not url (A3)', async () => {
    const { create, calls } = recordingTranscribe();

    const result = await groqTranscribeAdapter({ create }).invoke(
      transcribeRequest(),
      transcribeCall(),
    );

    const body = calls[0]?.body as unknown as Record<string, unknown>;
    expect(body?.['model']).toBe(GROQ_TRANSCRIBE_MODEL);
    // Amendment A3, V34: `file` | `url` are mutually exclusive with one required. There are no
    // public URLs any more, so Jamee always sends `file` — the recording's bytes as an uploadable
    // File built with the SDK's `toFile()`. `url` must not travel.
    expect(body).toHaveProperty('file');
    expect(body).not.toHaveProperty('url');
    // V10: verbose_json is what carries the confidence signals; temperature 0 is the recommendation.
    expect(body?.['response_format']).toBe(TRANSCRIBE_RESPONSE_FORMAT);
    expect(TRANSCRIBE_RESPONSE_FORMAT).toBe('verbose_json');
    expect(body?.['temperature']).toBe(GROQ_TRANSCRIBE_TEMPERATURE);
    // No `timestamp_granularities`: V10 records word timestamps as additional latency, and nothing
    // in Requirement 8 reads a timestamp.
    expect(body).not.toHaveProperty('timestamp_granularities');
    expect(body).not.toHaveProperty('prompt');

    expect(result.text).toBe('मेरे टमाटर के पत्तों पर धब्बे हैं');
    expect(result.durationSeconds).toBe(6.24);
    expect(result.language).toBe('hindi');
  });

  /** Requirement 8.5 — English, Hindi and Marathi, and V10 records that sending it helps. */
  it('passes each Supported_Language as its ISO-639-1 code', async () => {
    expect([...SUPPORTED_LANGUAGES]).toEqual(['en', 'hi', 'mr']);

    for (const language of SUPPORTED_LANGUAGES) {
      const { create, calls } = recordingTranscribe();
      await groqTranscribeAdapter({ create }).invoke(
        transcribeRequest({ language }),
        transcribeCall(),
      );
      // V10: ISO-639-1, and it improves accuracy AND latency — latency being budget on a path with
      // a 20 s attempt ceiling.
      expect(calls[0]?.body.language).toBe(language);
    }
  });

  it('resolves to V10 documented endpoint through the SDK method it calls', async () => {
    const requested: string[] = [];
    const client = new Groq({
      apiKey: 'test-key-not-a-secret',
      maxRetries: GROQ_SDK_MAX_RETRIES,
      // The unit project runs in jsdom, and the SDK refuses to construct in a browser-like
      // environment to stop a key leaking to a page. Set here only because this client holds a
      // fake key, never leaves this process, and its `fetch` is the recorder below. Production
      // never reaches it: `groqClient()` runs on the Node.js runtime that V17 pins every route to.
      dangerouslyAllowBrowser: true,
      fetch: (input) => {
        requested.push(input instanceof Request ? input.url : String(input));
        return Promise.resolve(
          new Response(JSON.stringify({ text: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });

    await client.audio.transcriptions.create({
      model: GROQ_TRANSCRIBE_MODEL,
      url: 'https://example.test/note.webm',
    });

    // The adapter calls `client.audio.transcriptions.create`, so this is the URL it actually hits.
    // Asserting it against the V-item is what keeps `GROQ_TRANSCRIBE_ENDPOINT` from drifting into
    // decoration while the SDK quietly posts somewhere else.
    // `data:` entries are the SDK's own multipart-support probe, not a request to the provider.
    expect(requested.filter((url) => url.startsWith('http'))).toEqual([GROQ_TRANSCRIBE_ENDPOINT]);
    expect(GROQ_TRANSCRIBE_ENDPOINT).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  });

  it('passes the call signal, the attempt timeout, and no SDK-internal retries', async () => {
    const { create, calls } = recordingTranscribe();
    const controller = new AbortController();

    await groqTranscribeAdapter({ create }).invoke(
      transcribeRequest(),
      transcribeCall({ signal: controller.signal, timeoutMs: 18_000 }),
    );

    expect(calls[0]?.options.signal).toBe(controller.signal);
    expect(calls[0]?.options.timeout).toBe(18_000);
    expect(calls[0]?.options.maxRetries).toBe(GROQ_SDK_MAX_RETRIES);
  });

  it('returns an empty transcript as a successful call rather than a failure', async () => {
    // Requirement 8.7 owns the empty case (`TRANSCRIPT_EMPTY`, 422, "record somewhere quieter").
    // Raising here would collapse it into TRANSCRIPTION_FAILED — 502, retryable over the same
    // object — and tell a farmer who recorded silence to retry the silence.
    const { create } = recordingTranscribe(verbosePayload({ text: '' }));
    const result = await groqTranscribeAdapter({ create }).invoke(
      transcribeRequest(),
      transcribeCall(),
    );

    expect(result.text).toBe('');
    expect(result.segments).toEqual([]);
  });

  it('surfaces V10 confidence signals from wherever the payload carries them', async () => {
    const { create } = recordingTranscribe(
      verbosePayload({
        no_speech_prob: 0.91,
        avg_logprob: -0.42,
        compression_ratio: 1.7,
        segments: [
          { no_speech_prob: 0.88, avg_logprob: -0.4, compression_ratio: 1.6 },
          { no_speech_prob: 0.94 },
          'not a segment',
        ],
      }),
    );

    const result = await groqTranscribeAdapter({ create }).invoke(
      transcribeRequest(),
      transcribeCall(),
    );

    // `no_speech_prob` is the signal the design cares about: it separates "the farmer recorded
    // silence" from "the provider produced nothing", which is why a voice object is RETAINED after
    // an empty transcript (Requirement 8.10).
    expect(result.signals).toEqual({
      noSpeechProb: 0.91,
      avgLogprob: -0.42,
      compressionRatio: 1.7,
    });
    // Both placements are surfaced and neither is aggregated — an aggregation rule would be a
    // judgement about content.
    expect(result.segments).toEqual([
      { noSpeechProb: 0.88, avgLogprob: -0.4, compressionRatio: 1.6 },
      { noSpeechProb: 0.94, avgLogprob: undefined, compressionRatio: undefined },
    ]);
  });

  it('normalizes a provider failure per V11', async () => {
    const rateLimited = groqTranscribeAdapter({
      create: () => Promise.reject(sdkRejection(429, { 'retry-after': '12' })),
    });
    await expect(rateLimited.invoke(transcribeRequest(), transcribeCall())).rejects.toSatisfy(
      (error: unknown) =>
        isProviderError(error) && error.failure === 'RATE_LIMIT' && error.retryAfterSeconds === 12,
    );

    const down = groqTranscribeAdapter({ create: () => Promise.reject(sdkRejection(503)) });
    await expect(down.invoke(transcribeRequest(), transcribeCall())).rejects.toSatisfy(
      (error: unknown) => isProviderError(error) && error.failure === 'UNAVAILABLE',
    );

    // 413 and 422 stay OTHER on this path too — an oversized or unprocessable object fails on any
    // provider, so neither may trigger a retry.
    for (const status of [413, 422]) {
      const other = groqTranscribeAdapter({ create: () => Promise.reject(sdkRejection(status)) });
      await expect(other.invoke(transcribeRequest(), transcribeCall())).rejects.toSatisfy(
        (error: unknown) => isProviderError(error) && error.failure === 'OTHER',
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Pre-flight admission (V10, U-V10)                                           */
/* -------------------------------------------------------------------------- */

describe('normalizeAudioContainer', () => {
  it('reduces an extension or a MIME type to the bare container V10 lists', () => {
    expect(normalizeAudioContainer('audio/webm;codecs=opus')).toBe('webm');
    expect(normalizeAudioContainer('audio/ogg; codecs=opus')).toBe('ogg');
    expect(normalizeAudioContainer('audio/x-m4a')).toBe('m4a');
    expect(normalizeAudioContainer('.WEBM')).toBe('webm');
    expect(normalizeAudioContainer('  wav ')).toBe('wav');
    expect(normalizeAudioContainer('')).toBeUndefined();
    expect(normalizeAudioContainer('audio/')).toBeUndefined();
  });

  it('accepts exactly V10 nine containers', () => {
    expect([...TRANSCRIBE_ACCEPTED_CONTAINERS]).toEqual([
      'flac',
      'mp3',
      'mp4',
      'mpeg',
      'mpga',
      'm4a',
      'ogg',
      'wav',
      'webm',
    ]);
    for (const container of TRANSCRIBE_ACCEPTED_CONTAINERS) {
      expect(isAcceptedAudioContainer(container)).toBe(true);
      expect(isAcceptedAudioContainer(`audio/${container}`)).toBe(true);
    }
    // V14 lists these two among WhatsApp inbound audio types and asserts they are inside V10's
    // list. They are not literal members of it, so they are refused rather than assumed — see
    // `isAcceptedAudioContainer`.
    expect(isAcceptedAudioContainer('audio/aac')).toBe(false);
    expect(isAcceptedAudioContainer('audio/amr')).toBe(false);
    expect(isAcceptedAudioContainer('video/mp4')).toBe(true);
  });
});

describe('assertTranscribableAudio', () => {
  it('refuses a container outside V10 list without spending the call', async () => {
    const { create, calls } = recordingTranscribe();

    await expect(
      groqTranscribeAdapter({ create }).invoke(
        transcribeRequest({ container: 'audio/aac' }),
        transcribeCall(),
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isProviderError(error) &&
        error.failure === 'OTHER' &&
        // No V-item records the status a bad container returns, so none is fabricated.
        error.status === undefined,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses an object over V10 size cap without spending the call, carrying the 413', async () => {
    const { create, calls } = recordingTranscribe();

    await expect(
      groqTranscribeAdapter({ create }).invoke(
        transcribeRequest({ bytes: TRANSCRIBE_PROVIDER_MAX_BYTES + 1 }),
        transcribeCall(),
      ),
    ).rejects.toSatisfy(
      // V11 puts 413 on OTHER: a second provider fails on the same object, so it must fail fast.
      (error: unknown) =>
        isProviderError(error) && error.status === 413 && error.failure === 'OTHER',
    );
    expect(calls).toHaveLength(0);

    // Exactly at the cap is fine, and a caller that does not know the size is not blocked.
    expect(() =>
      assertTranscribableAudio(transcribeRequest({ bytes: TRANSCRIBE_PROVIDER_MAX_BYTES })),
    ).not.toThrow();
    expect(() => assertTranscribableAudio(transcribeRequest())).not.toThrow();
  });

  it('bounds duration by V10 documented minimum and by Jamee own 120 s rule', () => {
    // Lower bound: V10's, documented.
    expect(refusalReason(transcribeRequest({ durationSeconds: TRANSCRIBE_MIN_SECONDS / 2 }))).toMatch(
      /minimum transcribable length \(V10\)/,
    );

    // Upper bound: NOT a provider limit. U-V10 documents no maximum duration, so the cap is
    // Requirement 8.2's own 120 s and the refusal says so in as many words — which is what stops a
    // farmer-facing message from ever presenting 120 s as something the provider imposed.
    const tooLong = refusalReason(transcribeRequest({ durationSeconds: MAX_AUDIO_SECONDS + 1 }));
    expect(tooLong).toMatch(/not a provider limit/);
    expect(tooLong).toMatch(/U-V10/);
    expect(tooLong).toContain(`${MAX_AUDIO_SECONDS} s recording rule (Requirement 8.2)`);

    for (const durationSeconds of [TRANSCRIBE_MIN_SECONDS, 1, 45, MAX_AUDIO_SECONDS]) {
      expect(() => assertTranscribableAudio(transcribeRequest({ durationSeconds }))).not.toThrow();
    }
    // A recording shorter than the 10 s minimum BILLED length is not refused — that is billing
    // arithmetic (V10), not an admission rule.
    expect(() => assertTranscribableAudio(transcribeRequest({ durationSeconds: 2 }))).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* The chain: one member, and an exhausted one surfaces TRANSCRIPTION_FAILED   */
/* -------------------------------------------------------------------------- */

describe('groqTranscribeMember', () => {
  it('is a one-member chain with no fallback', () => {
    const member = groqTranscribeMember();

    expect(Object.keys(member)).toEqual(['groq']);
    expect(member.gemini).toBeUndefined();
    expect(providersFor('transcribe', member).map((adapter) => adapter.model)).toEqual([
      GROQ_TRANSCRIBE_MODEL,
    ]);
  });

  it('surfaces TRANSCRIPTION_FAILED, retryable, when the chain is exhausted', async () => {
    const attempts: number[] = [];
    const member = groqTranscribeMember({
      create: () => {
        attempts.push(1);
        return Promise.reject(sdkRejection(503));
      },
    });

    const failure = await run('transcribe', member, transcribeRequest(), {
      now: () => 1_000,
      deadlineMs: 41_000,
      platformDeadline: () => undefined,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isAppError(failure)).toBe(true);
    // Requirement 8.4's own retryable code, reached through the gateway's single exit — an
    // UNAVAILABLE on a one-member chain has nowhere to fall back to, so it is exhausted at once.
    expect((failure as AppError).code).toBe('TRANSCRIPTION_FAILED');
    expect((failure as AppError).status).toBe(502);
    // Retryable over the SAME object, which is why the voice bytes are retained (Requirement 8.10).
    expect((failure as AppError).retryable).toBe(true);
    expect(attempts).toHaveLength(1);
  });

  it('does not start an attempt it cannot finish, and never reports that as a provider verdict', async () => {
    const { create, calls } = recordingTranscribe();
    // 4 s left against `transcribe`'s 8 s minimum-remaining guard: the spend rule refuses to issue
    // a call whose result would arrive after the deadline.
    const failure = await run('transcribe', groqTranscribeMember({ create }), transcribeRequest(), {
      now: () => 1_000,
      deadlineMs: 5_000,
      platformDeadline: () => undefined,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(calls).toHaveLength(0);
    expect((failure as AppError).code).toBe('DIAGNOSIS_TIMEOUT');
  });

  it('returns the transcript with the provider that produced it and no fallback flag', async () => {
    const { create } = recordingTranscribe();

    const result = await run('transcribe', groqTranscribeMember({ create }), transcribeRequest(), {
      now: () => 1_000,
      deadlineMs: 41_000,
      platformDeadline: () => undefined,
    });

    expect(result.provider).toBe('groq');
    expect(result.usedFallback).toBe(false);
    expect(result.value.text).toBe('मेरे टमाटर के पत्तों पर धब्बे हैं');
  });
});
