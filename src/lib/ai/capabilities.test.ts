/**
 * @vitest-environment node
 *
 * `capabilities.ts` pulls in both provider adapters, and `groq-sdk` probes the ambient `Response`
 * for `FormData` support at import time — which jsdom's cannot serialize. Same reasoning as
 * `groq.test.ts`: V17 pins every route handler to the Node.js runtime, so the tests run there.
 */
import Groq from 'groq-sdk';
import { describe, expect, it } from 'vitest';

import { textAdapters, visionAdapters, type TextCall, type VisionCall } from '@/lib/ai/capabilities';
import type { ProviderCall } from '@/lib/ai/gateway';
import { GEMINI_MODEL, GROQ_TEXT_MODEL } from '@/lib/config/verified';
import type {
  GeminiInteractionRequest,
  GeminiInteractionResponse,
  InteractionCreate,
} from '@/lib/gemini';
import type { GroqChatCreate, GroqChatRequest } from '@/lib/groq';

/**
 * Unit tests for the one shared call shape per capability.
 *
 * What this file is for: the two adapters were written independently and agreed on neither the input
 * nor the output type for either capability (`capabilities.ts` carries the table). These tests assert
 * that **one `VisionCall` and one `TextCall` really do drive both members**, because that is what
 * `AdapterSet<TInput, TOutput>` requires of a chain and therefore what Requirement 14.4's fallback
 * depends on: a fallback that does not type-check against the same input is not a fallback.
 *
 * Requirements: 14.4, 14.8 (the vision chain's second member is a config read, never a branch)
 * Depends on: V6/V7 (the Interactions request shape), V8/V9 (the Groq chat shape, the conditional
 *             vision member)
 */

const VISION_MODEL = 'qwen/qwen3.8-27b';

function providerCall(overrides: Partial<ProviderCall> = {}): ProviderCall {
  return {
    signal: new AbortController().signal,
    timeoutMs: 20_000,
    deadlineMs: 1_700_000_045_000,
    capability: 'vision-classify',
    attempt: 0,
    ...overrides,
  };
}

const VISION_CALL: VisionCall = {
  imageUrl: 'https://storage.test/crop.jpg?token=abc',
  imageMimeType: 'image/jpeg',
  prompt: 'classify this leaf',
  responseSchema: { type: 'object' },
};

const TEXT_CALL: TextCall = { prompt: 'rephrase this row', system: 'answer plainly' };

/** A Gemini `create` stub: records the request and answers with `output_text`. */
function geminiCreate(text: string): {
  create: InteractionCreate;
  calls: GeminiInteractionRequest[];
} {
  const calls: GeminiInteractionRequest[] = [];
  const create: InteractionCreate = (request) => {
    calls.push(request);
    const response: GeminiInteractionResponse = { output_text: text, status: 'completed' };
    return Promise.resolve(response);
  };
  return { create, calls };
}

/** A Groq `create` stub, same shape `groq.test.ts` uses. */
function groqCreate(content: string): { create: GroqChatCreate; calls: GroqChatRequest[] } {
  const calls: GroqChatRequest[] = [];
  const create: GroqChatCreate = (body) => {
    calls.push(body);
    const completion: Groq.Chat.ChatCompletion = {
      id: 'chatcmpl-stub',
      created: 1,
      model: 'stub',
      object: 'chat.completion',
      choices: [
        { finish_reason: 'stop', index: 0, logprobs: null, message: { role: 'assistant', content } },
      ],
    };
    return Promise.resolve(completion);
  };
  return { create, calls };
}

/* ========================================================================== */

describe('visionAdapters', () => {
  it('registers both members while a vision fallback model is configured', () => {
    const adapters = visionAdapters({ visionFallbackModel: VISION_MODEL });

    expect(adapters.gemini?.model).toBe(GEMINI_MODEL);
    expect(adapters.groq?.model).toBe(VISION_MODEL);
  });

  it('registers one member once the preview model is withdrawn (V9)', () => {
    const adapters = visionAdapters({ visionFallbackModel: null });

    expect(adapters.gemini).toBeDefined();
    expect(adapters.groq).toBeUndefined();
  });

  it('drives the Gemini member from the shared call and returns its text alone', async () => {
    const gemini = geminiCreate('{"status":"unclear","disease_name":null}');
    const adapters = visionAdapters({ gemini: { create: gemini.create } });

    const answer = await adapters.gemini?.invoke(VISION_CALL, providerCall());

    // `GeminiOutput.status` is dropped: nothing above this layer may branch on a transport fact.
    expect(answer).toBe('{"status":"unclear","disease_name":null}');
    expect(gemini.calls[0]?.input).toEqual([
      { type: 'image', uri: VISION_CALL.imageUrl, mime_type: 'image/jpeg' },
      { type: 'text', text: VISION_CALL.prompt },
    ]);
    expect(gemini.calls[0]?.response_format.schema).toEqual(VISION_CALL.responseSchema);
  });

  it('drives the Groq member from the same call, dropping what that surface has no use for', async () => {
    const groq = groqCreate('{"status":"identified"}');
    const adapters = visionAdapters({
      visionFallbackModel: VISION_MODEL,
      groq: { create: groq.create },
    });

    const answer = await adapters.groq?.invoke(VISION_CALL, providerCall());

    expect(answer).toBe('{"status":"identified"}');
    expect(groq.calls[0]?.model).toBe(VISION_MODEL);
    expect(groq.calls[0]?.messages[0]?.content).toEqual([
      { type: 'text', text: VISION_CALL.prompt },
      { type: 'image_url', image_url: { url: VISION_CALL.imageUrl } },
    ]);
    // V9: the request is JSON-object mode, not schema-enforced — so `responseSchema` cannot travel,
    // and D2's stage-1 shape validation is the first check of any kind on this member.
    expect(groq.calls[0]?.response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(groq.calls[0])).not.toContain('image/jpeg');
  });
});

describe('textAdapters', () => {
  it('registers both members unconditionally (V8: the Groq text model is GA)', () => {
    const adapters = textAdapters();

    expect(adapters.gemini?.model).toBe(GEMINI_MODEL);
    expect(adapters.groq?.model).toBe(GROQ_TEXT_MODEL);
  });

  it('maps the shared call onto each provider’s own field names', async () => {
    const gemini = geminiCreate('Gemini prose.');
    const groq = groqCreate('Groq prose.');
    const adapters = textAdapters({
      gemini: { create: gemini.create },
      groq: { create: groq.create },
    });

    await expect(adapters.gemini?.invoke(TEXT_CALL, providerCall({ capability: 'text-generate' })))
      .resolves.toBe('Gemini prose.');
    await expect(adapters.groq?.invoke(TEXT_CALL, providerCall({ capability: 'text-generate' })))
      .resolves.toBe('Groq prose.');

    expect(gemini.calls[0]?.input).toBe(TEXT_CALL.prompt);
    expect(gemini.calls[0]?.system_instruction).toBe(TEXT_CALL.system);
    // A rephrase is prose, so neither member asks for JSON on this capability.
    expect(gemini.calls[0]?.response_format.schema).toBeUndefined();
    expect(groq.calls[0]?.messages).toEqual([
      { role: 'system', content: TEXT_CALL.system },
      { role: 'user', content: TEXT_CALL.prompt },
    ]);
    expect(groq.calls[0]?.response_format).toBeUndefined();
  });

  it('omits an absent system instruction rather than sending undefined', async () => {
    const gemini = geminiCreate('prose');
    const groq = groqCreate('prose');
    const adapters = textAdapters({
      gemini: { create: gemini.create },
      groq: { create: groq.create },
    });

    await adapters.gemini?.invoke({ prompt: 'p' }, providerCall({ capability: 'text-generate' }));
    await adapters.groq?.invoke({ prompt: 'p' }, providerCall({ capability: 'text-generate' }));

    expect(gemini.calls[0] && 'system_instruction' in gemini.calls[0]).toBe(false);
    expect(groq.calls[0]?.messages).toEqual([{ role: 'user', content: 'p' }]);
  });
});
