import 'server-only';

import {
  run,
  type AdapterSet,
  type GatewayResult,
  type ProviderAdapter,
  type RunOptions,
} from '@/lib/ai/gateway';
import { VISION_FALLBACK_MODEL } from '@/lib/config/verified';
import {
  geminiTextAdapter,
  geminiVisionAdapter,
  type GeminiAdapterDeps,
  type GeminiOutput,
  type GeminiTextInput,
  type GeminiVisionInput,
  type JsonSchema,
} from '@/lib/gemini';
import {
  groqTextAdapter,
  groqVisionMember,
  type GroqAdapterOptions,
  type TextGenerateRequest,
  type VisionClassifyRequest,
} from '@/lib/groq';

/**
 * One request shape and one answer shape per capability, so a chain can hold two providers that
 * were written independently.
 *
 * Requirements: 14.4 (a rate-limit or unavailability condition from the primary retries on the
 *               fallback), 14.8 (a both-provider failure on image interpretation is one failed
 *               operation), 16.3 / 16.4 (exactly one implementation of the image-analysis and of
 *               the grounding/rephrase flow — which needs exactly one call shape for each)
 * Design: "Fallback matrix"; "Layers" — the gateway returns raw provider output and interprets
 *         nothing
 *
 * =============================================================================
 * WHY THIS FILE EXISTS: THE TWO ADAPTERS DISAGREED
 * =============================================================================
 *
 * `AdapterSet<TInput, TOutput>` requires every member of a chain to take the same input and return
 * the same output — the gateway is generic over both and inspects neither. The two adapters written
 * at tasks 8.2 and 8.3 do not agree on either half:
 *
 * | | Gemini (`gemini.ts`) | Groq (`groq.ts`) |
 * | --- | --- | --- |
 * | `vision-classify` in | `GeminiVisionInput` — `imageUrl`, `imageMimeType`, `prompt`, `responseSchema`, `systemInstruction?` | `VisionClassifyRequest` — `imageUrl`, `prompt`, `system?`, `json?` |
 * | `text-generate` in | `GeminiTextInput` — `prompt`, `systemInstruction?`, `responseSchema?` | `TextGenerateRequest` — `prompt`, `system?`, `json?` |
 * | out | `GeminiOutput` — `{ text, status }` | `string` |
 *
 * Neither is wrong: they describe two real provider surfaces (V6/V7's Interactions API with
 * schema-enforced structured output; V8/V9's OpenAI-compatible chat completions with a plain
 * JSON-object mode). What was missing was the declaration a *caller* codes against.
 *
 * **Resolution: `VisionCall` and `TextCall` below are that one shared declaration, and the two
 * adapters are wrapped into it here rather than edited.** Wrapping rather than editing keeps each
 * adapter honest about its own provider — `GeminiOutput.status` is real and is worth logging where
 * it exists — and keeps the mapping in one reviewable place instead of at every call site. The two
 * fields Groq has no use for (`imageMimeType`, `responseSchema`) are dropped by `toGroqVision()`,
 * which is not a loss: V9 records that Groq's JSON mode is not schema-enforced, so on that member
 * D2's stage-1 shape validation is the first check of any kind. That is stated in `groq.ts` and is
 * the expected consequence of a Gemini outage — a higher inconclusive rate, not a wave of errors.
 *
 * ### WHAT THIS FILE STILL MAY NOT KNOW
 *
 * Nothing about agronomy, prompts, the knowledge base, or farmer-facing wording. `prompt` and
 * `responseSchema` arrive as opaque values from `src/lib/prompts.ts`; the answer goes back as an
 * uninterpreted string. A module that could read a classification result would eventually be asked
 * to retry a bad one, which is exactly the spend D4 forbids.
 */

/* ========================================================================== */
/* The two shared call shapes                                                  */
/* ========================================================================== */

/**
 * One image classification.
 *
 * **Amendment A3: the image travels inline as bytes, not by URL** (V34). `imageBase64` is the
 * Full_Size_Image the analysis read from GridFS, base64-encoded; the Gemini member sends it as the
 * inline `{ type: 'image', data, mime_type }` content part and the Groq member wraps it in a
 * `data:<mime>;base64,<bytes>` URL. There is no Supabase Storage under A3 and therefore no signed
 * URL to mint, so the bytes are the only form. `responseSchema` is honoured by the member that
 * supports one and ignored by the member that does not — see the table above.
 *
 * `system` is declared without `| undefined` deliberately: under `exactOptionalPropertyTypes` that
 * is what keeps this type assignable to the adapters' own optional fields, so an absent system
 * instruction is an absent property rather than an explicit `undefined`.
 */
export interface VisionCall {
  readonly imageBase64: string;
  readonly imageMimeType: string;
  readonly prompt: string;
  readonly responseSchema: JsonSchema;
  readonly system?: string;
}

/** One text generation: the knowledge-base rephrase (task 9.2) and, later, the chat answer. */
export interface TextCall {
  readonly prompt: string;
  readonly system?: string;
}

/* ========================================================================== */
/* Wrapping an adapter into the shared shape                                   */
/* ========================================================================== */

/**
 * Re-express one adapter in the shared call shape.
 *
 * `classifyError` is carried across **unchanged**, which is the point of doing this by wrapping: a
 * mapped adapter still classifies its own provider's rejections, so Requirement 14.4's fallback
 * trigger is decided by the code that knows the SDK rather than by this file.
 */
function adapt<TShared, TIn, TOut>(
  adapter: ProviderAdapter<TIn, TOut>,
  mapInput: (input: TShared) => TIn,
  mapOutput: (output: TOut) => string,
): ProviderAdapter<TShared, string> {
  return {
    id: adapter.id,
    model: adapter.model,
    classifyError: adapter.classifyError,
    async invoke(input, call) {
      return mapOutput(await adapter.invoke(mapInput(input), call));
    },
  };
}

/**
 * Gemini's `{ text, status }` down to `text`.
 *
 * `status` is dropped rather than surfaced, because there is nothing above this layer that may
 * branch on it: a terminal interaction status is a transport fact, and every content decision
 * belongs to D2's two stages. `gemini.ts` already rejects a *missing* `output_text` as a protocol
 * failure, so an empty string here is the provider's actual answer and is passed on untouched —
 * stage 1 is where "the model said nothing usable" becomes the single inconclusive shape.
 */
function textOf(output: GeminiOutput): string {
  return output.text;
}

function identity(value: string): string {
  return value;
}

function toGeminiVision(input: VisionCall): GeminiVisionInput {
  return {
    imageBase64: input.imageBase64,
    imageMimeType: input.imageMimeType,
    prompt: input.prompt,
    responseSchema: input.responseSchema,
    ...(input.system === undefined ? {} : { systemInstruction: input.system }),
  };
}

function toGeminiText(input: TextCall): GeminiTextInput {
  return {
    prompt: input.prompt,
    // No `responseSchema`: a rephrase is prose, and `gemini.ts` then requests `text/plain`
    // explicitly rather than leaving the output contract to a default.
    ...(input.system === undefined ? {} : { systemInstruction: input.system }),
  };
}

function toGroqVision(input: VisionCall): VisionClassifyRequest {
  return {
    // A3, V34: Groq takes the image as a `data:<mime>;base64,<bytes>` URL. The 20 MB request cap is
    // enforced inside `groq.ts` before the call; Jamee's ~400 KB re-encode is far below it.
    imageUrl: `data:${input.imageMimeType};base64,${input.imageBase64}`,
    prompt: input.prompt,
    // `json` is left at its default, which `groq.ts` sets to ON for this member: it exists only as
    // the fallback for a JSON-only classification contract.
    ...(input.system === undefined ? {} : { system: input.system }),
  };
}

function toGroqText(input: TextCall): TextGenerateRequest {
  return {
    prompt: input.prompt,
    ...(input.system === undefined ? {} : { system: input.system }),
  };
}

/* ========================================================================== */
/* The adapter sets                                                            */
/* ========================================================================== */

export interface CapabilityDeps {
  /** Injection seam for the Gemini SDK call. Absent in production. */
  readonly gemini?: GeminiAdapterDeps;
  /** Injection seam for the Groq SDK call. Absent in production. */
  readonly groq?: GroqAdapterOptions;
  /**
   * Overrides `VISION_FALLBACK_MODEL`. `null` means "no vision fallback member", which is the
   * withdrawal case V9 records as expected — and `undefined` means "read the config value", so a
   * caller cannot accidentally resurrect a withdrawn model by passing `null` through a `??`.
   */
  readonly visionFallbackModel?: string | null;
}

/**
 * `vision-classify`: Gemini, then the conditional Groq member.
 *
 * The conditionality is `groqVisionMember()`'s, unchanged — a config read, never a branch. When
 * `VISION_FALLBACK_MODEL` goes `null` this returns a one-member set, `providersFor()` returns a
 * one-member chain, and Requirement 14.8's single exhausted-chain exit means callers cannot tell
 * that from a fallback that also failed.
 */
export function visionAdapters(deps: CapabilityDeps = {}): AdapterSet<VisionCall, string> {
  const model =
    deps.visionFallbackModel === undefined ? VISION_FALLBACK_MODEL : deps.visionFallbackModel;
  const fallback = groqVisionMember(model, deps.groq ?? {}).groq;

  return {
    gemini: adapt(geminiVisionAdapter(deps.gemini ?? {}), toGeminiVision, textOf),
    ...(fallback === undefined ? {} : { groq: adapt(fallback, toGroqVision, identity) }),
  };
}

/** `text-generate`: Gemini, then Groq. Unconditional — V8 lists the Groq text model as GA. */
export function textAdapters(deps: CapabilityDeps = {}): AdapterSet<TextCall, string> {
  return {
    gemini: adapt(geminiTextAdapter(deps.gemini ?? {}), toGeminiText, textOf),
    groq: adapt(groqTextAdapter(deps.groq ?? {}), toGroqText, identity),
  };
}

/* ========================================================================== */
/* The runner a service depends on                                             */
/* ========================================================================== */

/**
 * The two model calls a domain service can make, as one injectable seam.
 *
 * Services depend on this rather than on `run()` plus two adapter sets, for one reason worth the
 * indirection: **a unit test stubs two functions instead of four SDK shapes**, and the stub is the
 * gateway boundary — so a test can assert "no second model call was issued after a rejection"
 * (Requirement 6.6) directly, rather than inferring it from provider traffic.
 *
 * `options` is the gateway's own `RunOptions`, unnarrowed, because the caller that owns the request
 * owns the deadline: a service making two calls passes the SAME `deadlineMs` to both, so a fallback
 * on the first call spends budget the second one will not have (design: *Timeouts*).
 */
export interface CapabilityRunner {
  classify(input: VisionCall, options?: RunOptions): Promise<GatewayResult<string>>;
  generate(input: TextCall, options?: RunOptions): Promise<GatewayResult<string>>;
}

/**
 * The production runner: the real gateway over the real adapter sets.
 *
 * Adapters are built once per runner and hold no client — `gemini.ts` and `groq.ts` both resolve
 * their SDK call lazily at invoke time — so constructing this reads no environment variable and
 * touches no network.
 */
export function gatewayRunner(deps: CapabilityDeps = {}): CapabilityRunner {
  const vision = visionAdapters(deps);
  const text = textAdapters(deps);

  return {
    classify: (input, options = {}) => run('vision-classify', vision, input, options),
    generate: (input, options = {}) => run('text-generate', text, input, options),
  };
}
