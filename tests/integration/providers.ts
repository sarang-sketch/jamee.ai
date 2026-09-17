import type Groq from 'groq-sdk';

import { gatewayRunner, type CapabilityDeps, type CapabilityRunner } from '@/lib/ai/capabilities';
import type {
  GeminiContentPart,
  GeminiInteractionRequest,
  InteractionCreate,
} from '@/lib/gemini';
import type {
  GroqChatCreate,
  GroqChatRequest,
  GroqTranscribeOptions,
  GroqTranscriptionCreate,
  GroqTranscriptionRequest,
} from '@/lib/groq';
import type { VisionRaw } from '@/lib/schemas';
import { gatewayTranscriber, type Transcriber } from '@/services/voice.service';

/**
 * Providers, stubbed at the **adapter seam** — one function per SDK call, and nothing above it.
 *
 * Requirements: 17.5 (the testing report records the outcome of the image, chat, voice and WhatsApp
 *               scenarios), 5.1–5.6 (the two validation stages), 6.1–6.6 (the one inconclusive
 *               shape), 14.4 / 14.8 (the fallback matrix)
 * Design: "Integration tests — mocked providers, real Postgres": *"Providers are mocked at the
 *         adapter seam so the gateway, services, validation, persistence, and RLS are all real."*
 *
 * =============================================================================
 * WHERE THE SEAM IS, AND WHY IT IS NOT THE GATEWAY
 * =============================================================================
 *
 * Three injection points exist, all of them the same kind of thing — a single function standing for
 * one SDK method:
 *
 * | capability | seam | production default |
 * | --- | --- | --- |
 * | `vision-classify`, `text-generate` on Gemini | `GeminiAdapterDeps.create` | `interactions.create` |
 * | `text-generate`, `vision-classify` on Groq | `GroqAdapterOptions.create` | `chat.completions.create` |
 * | `transcribe` | `GroqTranscribeOptions.create` | `audio.transcriptions.create` |
 *
 * Stubbing there leaves **everything above it real**: request-body construction and V9's size
 * ceiling in `groq.ts`, V11 error classification in both adapters, the shared-deadline arithmetic,
 * the minimum-remaining spend guard, chain order and the fallback loop in `gateway.ts`, the two
 * validation stages, `validateRephrased`, the knowledge-base reads, the inserts, and RLS.
 *
 * **A `CapabilityRunner` stub would have been easier and would have proved much less.** It is the
 * right seam for a *unit* test — `diagnosis.service.test.ts` uses it, because a service test should
 * not also be a gateway test — but at this level it would replace the fallback loop with a promise,
 * so Requirement 14.4's "a rate limit on the primary retries on the fallback" and 14.8's
 * "both-provider failure is one failed operation" would be assertions about the harness rather than
 * about Jamee. The stubs below make a rate limit a *rejection from the SDK function*, which the real
 * adapter classifies and the real gateway acts on. `respondsAfterPrimaryRateLimit()` is that case as
 * a one-liner.
 *
 * Nothing here reads `GEMINI_API_KEY` or `GROQ_API_KEY`: both adapters resolve their SDK call at
 * invoke time, so an injected `create` means no client is ever constructed and no key is ever read.
 */

/* ========================================================================== */
/* Deterministic classification results                                        */
/* ========================================================================== */

/**
 * One scripted result per branch a scenario needs to drive.
 *
 * The shape is `visionRawSchema`'s four fields — `status`, `disease_name`, `confidence`,
 * `severity` — because that is what stage 1 parses. Which branch each one lands on, through the real
 * `interpret()` in `diagnosis.service.ts`:
 *
 * | entry | branch | `usage_logs` |
 * | --- | --- | --- |
 * | `tomatoEarlyBlight`, `potatoLateBlight` | identified, grounded in the row of that name | `success` |
 * | `tomatoHealthy` | identified, and Requirement 3.4 gives it no treatment content | `success` |
 * | `unclear` | the model declined to judge (Requirement 6.2) | `inconclusive` |
 * | `noPlant` | the photo is not a plant (Requirement 6.3) | `inconclusive` |
 * | `outsideKnowledgeBase` | stage 2 rejects a real-but-unverified name (Requirement 5.6) | `validation_rejected` |
 *
 * All five collapse into one farmer-facing inconclusive shape for the last three (Requirement 6.4),
 * so a scenario asserting the difference reads `usage_logs.rejection_reason`, not the response.
 *
 * `confidence` values are arbitrary but fixed: a scenario asserting a persisted confidence should be
 * able to name the number it expects.
 */
export const CLASSIFICATIONS = {
  tomatoEarlyBlight: {
    status: 'identified',
    disease_name: 'Tomato Early Blight',
    confidence: 0.92,
    severity: 'moderate',
  },
  potatoLateBlight: {
    status: 'identified',
    disease_name: 'Potato Late Blight',
    confidence: 0.87,
    severity: 'high',
  },
  tomatoHealthy: {
    status: 'identified',
    disease_name: 'Tomato Healthy',
    confidence: 0.96,
    severity: 'none',
  },
  unclear: { status: 'unclear', disease_name: null, confidence: 0.31, severity: 'none' },
  noPlant: { status: 'no_plant', disease_name: null, confidence: 0.12, severity: 'none' },
  /** A real disease Jamee has no verified row for — stage 2's only failure (Requirement 5.6). */
  outsideKnowledgeBase: {
    status: 'identified',
    disease_name: 'Wheat Rust',
    confidence: 0.88,
    severity: 'high',
  },
} as const satisfies Record<string, VisionRaw>;

/**
 * A classification as the raw text a provider returns.
 *
 * `JSON.stringify` and no fence, because that is what both configured members actually produce —
 * Gemini through V7's request-level `response_format`, Groq through V9's JSON mode. `interpret()`
 * treats a fenced block as `not_json` on purpose, so a fenced fixture would test a case production
 * cannot reach.
 */
export function classificationText(raw: VisionRaw): string {
  return JSON.stringify(raw);
}

/** Not JSON at all — Requirement 5.2's `not_json`. */
export const UNPARSEABLE_CLASSIFICATION = 'I am not able to look at that photo.';

/* ========================================================================== */
/* Deterministic rephrase results                                              */
/* ========================================================================== */

/**
 * The default `text-generate` answer: non-empty, short, and naming no verified condition.
 *
 * `validateRephrased`'s check 2 therefore fires and prefixes the canonical name, which is a real
 * production path (a model that answered without repeating the name) and keeps the fixture
 * independent of which condition a scenario classified. Use `rephraseNaming()` for the
 * no-repair path, or `''` to drive check 1 into the knowledge-base-only static fallback.
 */
export const DEFAULT_REPHRASE =
  'Dark patches are spreading on the older leaves near the ground. Remove the affected leaves and keep the plants dry.';

/** A rephrase that already carries the canonical name, so no repair is needed. */
export function rephraseNaming(condition: string): string {
  return `${condition}\n${DEFAULT_REPHRASE}`;
}

/* -------------------------------------------------------------------------- */
/* The rephrase stub that cannot invent a sentence                             */
/* -------------------------------------------------------------------------- */

/** `    - item` — the indentation `verifiedContentBlock()` gives a knowledge-base item. */
const VERIFIED_ITEM_LINE = /^ {4}- (.+)$/;

/**
 * The language the prompt asked for: `into simple Hindi` (rephrase) or `otherwise reply in Hindi`
 * (chat). One pattern for both, because both prompts state it and neither states it twice.
 */
const ASKED_LANGUAGE = /(?:into simple|otherwise reply in) (English|Hindi|Marathi)\b/;

/**
 * How much of the verified content the stub echoes back, in UTF-16 code units.
 *
 * Well under `REPHRASE_MAX_CHARS` (1200), which matters: a chat answer can be grounded in three rows
 * at once — "my tomato leaves have dark spots" resolves to all three tomato rows — and echoing every
 * item of all three would trip `validateRephrased()`'s check 1 and land the run on the static
 * knowledge-base template. That is a real production path, but a fixture that took it *silently*
 * would make a language assertion read headings instead of prose.
 */
const ECHO_BUDGET_CHARS = 600;

/** Every knowledge-base item a prompt supplied, in the order it supplied them. */
export function verifiedItemsIn(prompt: string): string[] {
  const items: string[] = [];
  for (const line of prompt.split('\n')) {
    const matched = VERIFIED_ITEM_LINE.exec(line);
    if (matched?.[1] !== undefined) items.push(matched[1]);
  }
  return items;
}

/** The language name a prompt named, or a failure saying the prompt stopped naming one. */
export function languageAskedFor(prompt: string): string {
  const matched = ASKED_LANGUAGE.exec(prompt);
  if (matched?.[1] === undefined) {
    throw new Error(
      'jamee integration harness: the prompt named no language, so Requirement 9.3 is unobservable ' +
        'from it. Both rephrasePrompt() and chatPrompt() state the requested language; if the ' +
        'wording changed, ASKED_LANGUAGE in tests/integration/providers.ts has to change with it.',
    );
  }
  return matched[1];
}

/** A `text-generate` stub that authors nothing, plus the prompts it was given. */
export interface EchoingRephrase {
  /** Bind as `ProviderScript.text`. */
  readonly text: (prompt: string) => string;
  /** Every prompt this stub answered, in order. */
  readonly prompts: string[];
  /** The most recent prompt, or a failure if no `text-generate` call has been made. */
  last(): string;
}

/**
 * The rephrase as an **echo**: the language the prompt asked for, then the content the prompt
 * supplied, and not one word of its own.
 *
 * =============================================================================
 * WHY A STUB THAT AUTHORS NOTHING IS THE ONLY USEFUL ONE HERE
 * =============================================================================
 *
 * A stubbed model cannot prove Jamee invents no agronomy — the stub *is* the model, so a fixture
 * that returned invented sentences would only be testing the fixture. What makes the claim checkable
 * is this function's construction: every line it returns was lifted out of the prompt the service
 * itself built, so it is structurally incapable of introducing a sentence the knowledge base did not
 * supply. Anything in the farmer-facing text that is **not** a verbatim row item therefore came from
 * Jamee — which is what turns "the explanation is grounded" and Requirement 3.4's "contains no
 * treatment content" into assertions about the service rather than about the fixture.
 *
 * It also names no condition, so `validateRephrased()`'s check 2 prefixes the Canonical_Disease_Name.
 * That is a real production path (a model that answered without repeating the name) and it is why
 * every explanation produced through this stub starts with that name in Latin script.
 *
 * `release-acceptance.test.ts` composes its own copy of this, from before the scenario suites
 * existed. Deliberately not folded in: that file is the release acceptance sequence, and rewriting it
 * to import a helper is a change to a passing suite for no gain in what it asserts.
 */
export function echoingRephrase(): EchoingRephrase {
  const prompts: string[] = [];

  return {
    prompts,
    text(prompt: string): string {
      prompts.push(prompt);

      const language = languageAskedFor(prompt);
      const lines: string[] = [language];
      let size = language.length;

      for (const item of verifiedItemsIn(prompt)) {
        if (size + item.length + 1 > ECHO_BUDGET_CHARS) break;
        lines.push(item);
        size += item.length + 1;
      }

      return lines.join('\n');
    },
    last(): string {
      const prompt = prompts.at(-1);
      if (prompt === undefined) {
        throw new Error('jamee integration harness: no text-generate call has been made yet');
      }
      return prompt;
    },
  };
}

/* ========================================================================== */
/* Deterministic transcription results                                         */
/* ========================================================================== */

/**
 * V10's `verbose_json` payload, as far as `readTranscription()` reads it.
 *
 * `''` is a legitimate value and is Requirement 8.7's empty-transcript branch — a *successful*
 * provider call, which is why it is scripted here rather than as a rejection.
 */
export interface TranscriptionPayload {
  readonly text: string;
  readonly language?: string;
  readonly duration?: number;
  readonly no_speech_prob?: number;
  readonly avg_logprob?: number;
}

export const DEFAULT_TRANSCRIPTION: TranscriptionPayload = {
  text: 'My tomato leaves have dark spots. What should I do?',
  language: 'en',
  duration: 6.4,
  no_speech_prob: 0.01,
  avg_logprob: -0.2,
};

/* ========================================================================== */
/* Provider rejections                                                         */
/* ========================================================================== */

/**
 * The shape both SDKs reject with: a numeric `status` and a `Headers`.
 *
 * Deliberately **not** a `ProviderError`. Handing the adapters a pre-classified failure would skip
 * the one thing worth exercising here — V11's table deciding, per provider, whether this is a
 * fallback trigger — and Requirement 14.4 is exactly that decision.
 */
export function providerRejection(status: number, headers: Record<string, string> = {}): unknown {
  return {
    status,
    headers: new Headers(headers),
    error: { message: 'jamee integration harness: scripted provider failure', type: 'stub' },
  };
}

/** 429. A fallback trigger on both providers (V11). */
export const RATE_LIMIT_STATUS = 429;
/** 503. Also a fallback trigger. */
export const UNAVAILABLE_STATUS = 503;
/** 422. Documented to include model output problems, so it must NOT trigger a fallback (V11). */
export const UNPROCESSABLE_STATUS = 422;

/* ========================================================================== */
/* The script                                                                  */
/* ========================================================================== */

/**
 * What each seam answers. Mutable, so one test can change an answer between two calls in the same
 * request — the voice path's "transcribe, then answer" is two provider round trips.
 */
export interface ProviderScript {
  /** Raw text the `vision-classify` chain returns, from either member. */
  vision: string | (() => string | Promise<string>);
  /** Raw text the `text-generate` chain returns. Receives the prompt the service built. */
  text: string | ((prompt: string) => string | Promise<string>);
  transcription: TranscriptionPayload | (() => TranscriptionPayload);
  /** Rejected by the Gemini seam before it answers. Both capabilities, since it is one SDK call. */
  geminiRejection?: unknown;
  /** Rejected by the Groq chat seam — the fallback member for both text and vision. */
  groqChatRejection?: unknown;
  transcriptionRejection?: unknown;
}

/** Every provider round trip the request made, in order, as the adapters composed it. */
export interface ProviderCalls {
  readonly geminiVision: GeminiInteractionRequest[];
  readonly geminiText: GeminiInteractionRequest[];
  readonly groqChat: GroqChatRequest[];
  readonly transcription: GroqTranscriptionRequest[];
}

export interface ProviderStubs {
  /**
   * The real gateway over the real adapters over the stubbed SDK calls. Pass as a service's
   * `models` dependency.
   */
  readonly models: CapabilityRunner;
  /** The real gateway over the real transcription adapter. Pass as `VoiceDeps.transcribe`. */
  readonly transcribe: Transcriber;
  /** For a test that needs to build its own runner — e.g. to pin a one-member vision chain. */
  readonly capabilityDeps: CapabilityDeps;
  readonly transcribeOptions: GroqTranscribeOptions;
  readonly script: ProviderScript;
  readonly calls: ProviderCalls;
}

/**
 * Total provider round trips.
 *
 * The assertion Requirement 6.6 needs ("no second model call after a rejected classification") is a
 * count, and counting one number is harder to get wrong than comparing four arrays.
 */
export function providerCallCount(calls: ProviderCalls): number {
  return (
    calls.geminiVision.length +
    calls.geminiText.length +
    calls.groqChat.length +
    calls.transcription.length
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Vision requests carry content parts; a text generation carries a bare string (`gemini.ts`). */
function isVisionInteraction(request: GeminiInteractionRequest): boolean {
  return Array.isArray(request.input);
}

function textPartsOf(input: string | GeminiContentPart[]): string {
  if (typeof input === 'string') return input;
  const parts: string[] = [];
  for (const part of input) {
    if (part.type === 'text') parts.push(part.text);
  }
  return parts.join('\n');
}

/**
 * The prompt text of a logged Gemini request, for a scenario asserting what the model was *asked*.
 *
 * Requirement 3.5 is the case that needs it: "a multi-leaf image yields exactly one condition" is
 * half a fact about the request (the classification prompt says to report one) and half a fact about
 * the response handling (a response naming two is refused). The first half is only observable here.
 */
export function promptTextOf(request: GeminiInteractionRequest): string {
  return textPartsOf(request.input);
}

/** The image parts of a logged Gemini vision request — Requirement 2.8's URL and MIME type. */
export function imagePartsOf(
  request: GeminiInteractionRequest,
): readonly { readonly uri: string; readonly mime_type: string }[] {
  if (typeof request.input === 'string') return [];
  return request.input.filter(
    (part): part is Extract<GeminiContentPart, { type: 'image' }> => part.type === 'image',
  );
}

/** A Groq vision request is the one whose message content is an array holding an `image_url`. */
function isVisionChat(body: GroqChatRequest): boolean {
  return body.messages.some((message) => {
    const content: unknown = isRecord(message) ? message['content'] : undefined;
    return (
      Array.isArray(content) &&
      content.some((part: unknown) => isRecord(part) && part['type'] === 'image_url')
    );
  });
}

function promptOfChat(body: GroqChatRequest): string {
  const parts: string[] = [];
  for (const message of body.messages) {
    const content: unknown = isRecord(message) ? message['content'] : undefined;
    if (typeof content === 'string') {
      parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
        parts.push(part['text']);
      }
    }
  }
  return parts.join('\n');
}

/** The completion envelope the Groq SDK returns, with the stub's text as its only content. */
function completionOf(content: string): Groq.Chat.ChatCompletion {
  return {
    id: 'chatcmpl-jamee-integration',
    created: 1,
    model: 'jamee-integration-stub',
    object: 'chat.completion',
    choices: [
      { finish_reason: 'stop', index: 0, logprobs: null, message: { role: 'assistant', content } },
    ],
  };
}

/**
 * The gateway hands every attempt an `AbortSignal` and both adapters are required to pass it to the
 * SDK. Asserting it arrived here is cheap, and it is the only place that contract is observable
 * without a real provider: an adapter that dropped it would still pass every unit test.
 */
function assertDeadlineReachedTheCall(signal: unknown, seam: string): void {
  if (!(signal instanceof AbortSignal)) {
    throw new Error(
      `jamee integration harness: the ${seam} seam was called without an AbortSignal. The gateway's ` +
        'per-attempt deadline reaches a provider only if the adapter forwards it (gateway.ts, ' +
        'ProviderCall.signal).',
    );
  }
}

async function resolveVision(script: ProviderScript): Promise<string> {
  return typeof script.vision === 'function' ? await script.vision() : script.vision;
}

async function resolveText(script: ProviderScript, prompt: string): Promise<string> {
  return typeof script.text === 'function' ? await script.text(prompt) : script.text;
}

function resolveTranscription(script: ProviderScript): TranscriptionPayload {
  return typeof script.transcription === 'function'
    ? script.transcription()
    : script.transcription;
}

/**
 * Build the three seam functions, the runners over them, and the call log.
 *
 * ```ts
 * const providers = providerStubs({ vision: classificationText(CLASSIFICATIONS.tomatoHealthy) });
 * const outcome = await diagnose(input, { supabase: farmer.client, models: providers.models });
 * expect(providers.calls.geminiVision).toHaveLength(1);
 * ```
 */
export function providerStubs(overrides: Partial<ProviderScript> = {}): ProviderStubs {
  const script: ProviderScript = {
    vision: overrides.vision ?? classificationText(CLASSIFICATIONS.tomatoEarlyBlight),
    text: overrides.text ?? DEFAULT_REPHRASE,
    transcription: overrides.transcription ?? DEFAULT_TRANSCRIPTION,
    ...(overrides.geminiRejection === undefined
      ? {}
      : { geminiRejection: overrides.geminiRejection }),
    ...(overrides.groqChatRejection === undefined
      ? {}
      : { groqChatRejection: overrides.groqChatRejection }),
    ...(overrides.transcriptionRejection === undefined
      ? {}
      : { transcriptionRejection: overrides.transcriptionRejection }),
  };

  const calls: ProviderCalls = {
    geminiVision: [],
    geminiText: [],
    groqChat: [],
    transcription: [],
  };

  const geminiCreate: InteractionCreate = async (request, options) => {
    assertDeadlineReachedTheCall(options.signal, 'Gemini interactions.create');
    const vision = isVisionInteraction(request);
    (vision ? calls.geminiVision : calls.geminiText).push(request);

    if (script.geminiRejection !== undefined) throw script.geminiRejection;

    const text = vision
      ? await resolveVision(script)
      : await resolveText(script, textPartsOf(request.input));
    return { output_text: text, status: 'completed' };
  };

  const groqChatCreate: GroqChatCreate = async (body, options) => {
    assertDeadlineReachedTheCall(options.signal, 'Groq chat.completions.create');
    calls.groqChat.push(body);

    if (script.groqChatRejection !== undefined) throw script.groqChatRejection;

    const text = isVisionChat(body)
      ? await resolveVision(script)
      : await resolveText(script, promptOfChat(body));
    return completionOf(text);
  };

  const transcriptionCreate: GroqTranscriptionCreate = async (body, options) => {
    assertDeadlineReachedTheCall(options.signal, 'Groq audio.transcriptions.create');
    calls.transcription.push(body);

    if (script.transcriptionRejection !== undefined) throw script.transcriptionRejection;

    return await Promise.resolve(resolveTranscription(script));
  };

  const capabilityDeps: CapabilityDeps = {
    gemini: { create: geminiCreate },
    groq: { create: groqChatCreate },
  };
  const transcribeOptions: GroqTranscribeOptions = { create: transcriptionCreate };

  return {
    models: gatewayRunner(capabilityDeps),
    transcribe: gatewayTranscriber(transcribeOptions),
    capabilityDeps,
    transcribeOptions,
    script,
    calls,
  };
}

/**
 * Stubs whose primary member rate-limits, so the **real** fallback loop runs and the Groq member
 * answers (Requirement 14.4).
 *
 * This is the shape that makes the seam choice worth its extra lines: nothing in the harness decides
 * that a 429 means "try the next member" — `classifyGroqError` / `classifyGeminiError` and
 * `isFallbackTrigger` do, and `run()` acts on it.
 */
export function respondsAfterPrimaryRateLimit(
  overrides: Partial<ProviderScript> = {},
): ProviderStubs {
  return providerStubs({
    ...overrides,
    geminiRejection: providerRejection(RATE_LIMIT_STATUS, { 'retry-after': '12' }),
  });
}
