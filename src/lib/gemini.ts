import 'server-only';

import { GoogleGenAI } from '@google/genai';

import {
  classifySignal,
  isProviderError,
  ProviderError,
  retryAfterFromHeaders,
  type ClassifyError,
  type FailureClassification,
  type ProviderErrorSignal,
} from '@/lib/ai/errors';
import type { ProviderAdapter, ProviderCall } from '@/lib/ai/gateway';
import {
  GEMINI_GENERATION,
  GEMINI_MODEL,
  GEMINI_RATE_LIMIT_STATUS_NAME,
  GEMINI_UNAVAILABLE_STATUS_NAME,
  PROVIDER_RATE_LIMIT_STATUSES,
} from '@/lib/config/verified';
import { serverEnv } from '@/lib/env';

/**
 * The Gemini adapter: `vision-classify` and `text-generate`, plus the V11 classification table.
 *
 * Requirements: 3.1 (image interpretation runs against the configured multimodal model with the
 *               constrained request), 14.4 (a rate-limit or unavailability condition is what the
 *               gateway retries on the fallback — so the classification here decides when Jamee
 *               spends a second provider call)
 * Design: "Provider strategy and fallback"; "Constrained vision classification" — *the prompt is a
 *         request; the schema is the enforcement*; D4 (`OTHER` fails fast); D7 (classification runs
 *         as deterministically as the surface allows)
 * Depends on: V6 (package, client init, model id, Interactions API), V7 (structured-output
 *             parameter names), V11 (error shapes) — and it RESOLVES U-V7, see below.
 * Authority: `docs/VERIFIED_VALUES.md`, `docs/PROVIDER_CAPABILITIES.md` sections 1–3.
 *
 * ### WHAT THIS MODULE IS NOT ALLOWED TO KNOW
 *
 * It shapes a request and hands back raw output. It does not parse the diagnosis JSON, consult the
 * knowledge base, or choose a farmer-facing sentence. The response *schema* arrives as a parameter
 * precisely so that the adapter can enforce JSON without knowing what the JSON means — validation
 * is D2's two stages, elsewhere, and every farmer-facing sentence comes from the message catalogs.
 *
 * ### U-V7 RESOLVED: `temperature` IS NOT ON THE INTERACTIONS API
 *
 * `VERIFIED_VALUES.md` left U-V7 open — the Interactions API guide and the troubleshooting page
 * both mention `temperature`, the Interactions API reference's `GenerationConfig` field list omits
 * it — and instructed resolving it against the pinned SDK's types. Read at task 8.2 in
 * `node_modules/@google/genai/dist/genai.d.ts` (package version 2.22.0, pinned in `package.json`):
 *
 *  - `CreateModelInteraction.generation_config` is typed `GenerationConfig_2`.
 *  - `GenerationConfig_2`'s complete field list is: `image_config` (deprecated),
 *    `max_output_tokens`, `seed`, `speech_config`, `stop_sequences`, `thinking_level`,
 *    `thinking_summaries`, `tool_choice`, `transcription_config`, `video_config`.
 *  - **There is no `temperature`** — nor `top_p` or `top_k`. The reference field list is right and
 *    the guide prose is stale.
 *
 * So `GEMINI_GENERATION.temperature` is deliberately NOT applied here, and D7's channel-parity
 * argument rests on the two levers that do exist on this surface: `thinking_level: 'minimal'` and a
 * fixed `seed`. Both are set on every request below. `thinking_level: 'minimal'` carries a second
 * job at the same time — V6 records that Gemini 3.x has thinking enabled by default, which is why
 * `vision-classify` holds the largest per-attempt ceiling in the budget table.
 *
 * ### THE SDK'S OWN RETRY LOOP IS RECONFIGURED, NOT TRUSTED
 *
 * `PROVIDER_CAPABILITIES.md` section 2 flagged that the JS SDK's retry defaults were unrecorded and
 * asked for them to be read at this task and lowered if the abort signal alone does not bound them.
 * Read from the pinned package's `dist/node/index.mjs` (the `CreateInteraction` operation and the
 * shared `retryAttemptCountBackoff` helper):
 *
 *  - Default retry config: `strategy: 'attempt-count-backoff'`, `maxRetries: 4`,
 *    `backoff: { initialInterval: 500, maxInterval: 8000, exponent: 2, maxElapsedTime: 30000 }`,
 *    `retryConnectionErrors: true`, and `retry_codes: ['408', '409', '429', '5XX']`.
 *  - The backoff *is* exponential with jitter (`initialInterval × exponent^attempt × (1 − rand×0.25)`),
 *    which is what U-V11 prescribes for Gemini.
 *  - **`maxElapsedTime` is not consulted by the attempt-count strategy** — only `maxRetries` and
 *    `maxInterval` are. So the recorded 30 s is inert, and the default per-call bound is really
 *    five HTTP attempts with up to 7.5 s of sleep between them.
 *  - The abort signal *does* cut the loop: an aborted `fetch` rejection is neither a connection
 *    error nor a timeout error by the SDK's own predicates, so it becomes a `PermanentError` and
 *    terminates the loop on the spot rather than being retried.
 *
 * That last point is the good news, and it is not sufficient. The signal fires at Jamee's
 * per-attempt ceiling — 20 s for vision — and inside that window the default config would retry a
 * **429** up to four times, sleeping on `retry-after` when the provider sends one. A rate limit
 * would then reach the gateway as an expired deadline instead of as `RATE_LIMIT`, and the gateway
 * records an aborted attempt as `OTHER` on purpose, so **the Groq fallback would never be tried**.
 * Hence `GEMINI_SDK_RETRY_CODES` is empty: every documented status surfaces immediately so the
 * gateway can decide, which is the only place Requirement 14.4 is allowed to be decided.
 * `retryConnectionErrors` stays on with `maxRetries: 1`, because a reset socket is the one failure
 * a single sub-second retry genuinely fixes and Jamee's classifier maps it to `OTHER` (no fallback).
 */

/* ========================================================================== */
/* Error classification (V11)                                                  */
/* ========================================================================== */

/**
 * Gemini's V11 table.
 *
 * **`unavailableStatuses` is `[503]` and deliberately NOT `PROVIDER_UNAVAILABLE_STATUSES`.** That
 * shared constant is `[500, 502, 503]`, which is *Groq's* documented set. V11 resolved Gemini's
 * unavailability signal as `503 UNAVAILABLE` alone, and records Gemini's own documented retry set
 * (429/408/5xx) as wider than the classifier Jamee runs. A Gemini **408** and a Gemini **500** are
 * therefore `OTHER` here and do not fall back. That is intentional conservatism, not an oversight:
 * widening this list changes when Jamee doubles its provider spend, so it is a change to V11's
 * resolved classifier and belongs in `docs/VERIFIED_VALUES.md`, not in this file.
 */
export const GEMINI_FAILURE_CLASSIFICATION: FailureClassification = {
  rateLimitStatuses: PROVIDER_RATE_LIMIT_STATUSES,
  unavailableStatuses: [503],
  rateLimitStatusNames: [GEMINI_RATE_LIMIT_STATUS_NAME],
  unavailableStatusNames: [GEMINI_UNAVAILABLE_STATUS_NAME],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstNumber(candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function firstNonEmptyString(candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return undefined;
}

/** `retry-after` off anything that exposes a `Headers`-shaped `get()`. */
function retryAfterFrom(candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const get = candidate['get'];
    if (typeof get !== 'function') continue;
    const seconds = retryAfterFromHeaders(candidate as { get(name: string): string | null });
    if (seconds !== undefined) return seconds;
  }
  return undefined;
}

/**
 * Read a status, a status name and a retry-after off a Gemini rejection.
 *
 * Read structurally rather than with `instanceof`, because the pinned SDK rejects with **three**
 * unrelated error shapes and only one of them is exported. From the same types and bundle read
 * above:
 *
 *  - `CreateInteractionClientError` / `CreateInteractionServerError` (the Interactions path) carry
 *    `statusCode`, a `headers` `Headers`, a `rawResponse` `Response`, and an `error` payload typed
 *    `{ code?: string; message?: string }`.
 *  - `APIError` (the shared client path) carries both `status` and `statusCode`, plus `headers`.
 *  - The exported `ApiError` carries `status` only.
 *  - `RequestTimeoutError`, `RequestAbortedError` and `ConnectionError` carry no status at all —
 *    which is the case that has to reach `OTHER`, and does, because every field stays absent.
 *
 * Numbers feed `status` and strings feed `statusName`, which is what makes one extractor cover all
 * of them: the wire payload's `error.code` is the numeric `429` while the SDK's own type declares
 * `code` as a string URI, and `error.status` is where `RESOURCE_EXHAUSTED` appears. Sorting by
 * runtime type instead of by field name means neither shape has to be guessed at.
 *
 * **No message text is read.** `ProviderErrorSignal` has no field for it, which is the enforcement
 * rather than the convention: a classifier that matched on prose would be one provider copy-edit
 * away from silently changing when Jamee falls back.
 */
export function geminiErrorSignal(error: unknown): ProviderErrorSignal {
  if (!isRecord(error)) return {};

  const payload = isRecord(error['error']) ? error['error'] : undefined;
  const rawResponse = isRecord(error['rawResponse']) ? error['rawResponse'] : undefined;

  const status = firstNumber([
    error['status'],
    error['statusCode'],
    payload?.['code'],
    payload?.['status'],
    rawResponse?.['status'],
  ]);
  const statusName = firstNonEmptyString([
    payload?.['status'],
    error['statusName'],
    payload?.['code'],
    error['status'],
  ]);
  const retryAfterSeconds = retryAfterFrom([error['headers'], rawResponse?.['headers']]);

  return {
    ...(status === undefined ? {} : { status }),
    ...(statusName === undefined ? {} : { statusName }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

/**
 * The `classifyError()` seam for both Gemini adapters.
 *
 * A `ProviderError` short-circuits: the adapter already classified it once at the point where the
 * SDK's shape was known, so reading `failure` back off it is both cheaper and exact. Everything
 * else goes through the table, and anything the table does not recognise is `OTHER` — D4's
 * conservative default, which stops the chain rather than spending a second provider call to learn
 * nothing.
 */
export const classifyGeminiError: ClassifyError = (error) =>
  isProviderError(error)
    ? error.failure
    : classifySignal(geminiErrorSignal(error), GEMINI_FAILURE_CLASSIFICATION);

/** Normalize any rejection into a `ProviderError`, classifying exactly once. */
function asProviderError(error: unknown): ProviderError {
  if (isProviderError(error)) return error;
  const signal = geminiErrorSignal(error);
  return new ProviderError({
    failure: classifySignal(signal, GEMINI_FAILURE_CLASSIFICATION),
    ...signal,
    cause: error,
  });
}

/* ========================================================================== */
/* The request shape (V6, V7)                                                  */
/* ========================================================================== */

/** A JSON Schema, opaque here. V7's supported subset is the caller's concern, not this module's. */
export type JsonSchema = Record<string, unknown>;

/**
 * One content block of an Interactions API input.
 *
 * V6 records three ways to pass an image: a Files API `uri` + `mime_type`, inline base64, or a
 * public URL. Jamee uses the `uri` form with the signed URL `storage.ts` mints, so the image bytes
 * are fetched provider-side and **never read into this process** — the whole point of D1's
 * upload-then-post-a-reference shape, and what keeps a 10 MB photo away from a 4.5 MB request body
 * ceiling (V16).
 */
export type GeminiContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly uri: string; readonly mime_type: string };

/** V7: JSON output is requested with a `response_format` carrying the MIME type and the schema. */
export interface GeminiResponseFormat {
  readonly type: 'text';
  readonly mime_type: string;
  readonly schema?: JsonSchema;
}

/**
 * Exactly the request fields Jamee sets, checked against the SDK's `CreateModelInteraction` at the
 * one call site in `sdkInteractionCreate()`.
 *
 * Narrower than the SDK type on purpose: a request this module cannot express is a request nobody
 * can add without editing this file, and `response_format` being non-optional is what makes
 * "structured output is set on the request, not trusted to the prompt" a type error to skip rather
 * than a convention to remember.
 */
export interface GeminiInteractionRequest {
  readonly model: string;
  readonly input: string | GeminiContentPart[];
  readonly generation_config: {
    readonly max_output_tokens: number;
    readonly thinking_level: string;
    readonly seed: number;
  };
  readonly response_format: GeminiResponseFormat;
  readonly store: boolean;
  readonly system_instruction?: string;
}

/**
 * Per-call SDK options.
 *
 * `signal` is not optional. V11 records that Google's SDKs retry internally, and the gateway's
 * `ProviderCall` contract says plainly that an adapter which drops the signal re-opens the hole the
 * shared deadline exists to close.
 */
export interface GeminiRequestOptions {
  readonly signal: AbortSignal;
  readonly retries: typeof GEMINI_SDK_RETRIES;
  readonly retry_codes: string[];
}

/** The subset of the interaction Jamee reads back. Everything else is the provider's business. */
export interface GeminiInteractionResponse {
  /** SDK-added convenience: the concatenated text of the last model output. */
  readonly output_text?: string | undefined;
  readonly status?: string | undefined;
}

/**
 * The one SDK method this module calls, as a function type.
 *
 * This is the test seam. Stubbing here rather than mocking the `@google/genai` module keeps the
 * production path type-checked against the real SDK — `sdkInteractionCreate()` below is the single
 * place where `GeminiInteractionRequest` has to be assignable to the SDK's own
 * `CreateModelInteractionParamsNonStreaming`, so a shape that drifts from the pinned package fails
 * `tsc` instead of failing in front of a farmer.
 */
export type InteractionCreate = (
  request: GeminiInteractionRequest,
  options: GeminiRequestOptions,
) => Promise<GeminiInteractionResponse>;

/**
 * SDK-internal retry policy, lowered from the defaults read off the pinned bundle (see the header).
 *
 * `maxRetries: 1` with a sub-second jittered interval, `retryConnectionErrors: true`, and an empty
 * `retry_codes` list: connection resets get one cheap retry, every documented HTTP status reaches
 * the gateway immediately. `maxElapsedTime` is stated for completeness and is **not** the bound —
 * the attempt-count strategy ignores it, which is exactly why it must not be relied on.
 */
export const GEMINI_SDK_RETRIES = {
  strategy: 'attempt-count-backoff',
  maxRetries: 1,
  backoff: {
    initialInterval: 250,
    maxInterval: 1_000,
    exponent: 2,
    maxElapsedTime: 2_000,
  },
  retryConnectionErrors: true,
} as const;

/**
 * No status code is retried inside the SDK.
 *
 * The default is `['408', '409', '429', '5XX']`. Every one of those either has to reach the gateway
 * to trigger a fallback (429, 503) or has to fail fast under D4 (408, 409, 500, 502). A retry here
 * would convert a rate limit into an expired deadline, and the gateway classifies an aborted
 * attempt as `OTHER` without consulting `classifyError()` — so the fallback would silently never
 * be tried. Empty rather than absent: the SDK falls back to its own defaults on a falsy value, and
 * an empty array is truthy.
 */
export const GEMINI_SDK_RETRY_CODES: readonly string[] = [];

/** V7's JSON output request. The schema is the enforcement; the prompt is only a request. */
export function jsonResponseFormat(schema: JsonSchema): GeminiResponseFormat {
  return { type: 'text', mime_type: GEMINI_GENERATION.jsonMimeType, schema };
}

/**
 * Plain-prose output, stated rather than left to the default.
 *
 * `text/plain` is one of the two MIME types the pinned SDK's `TextResponseFormatMimeType` names
 * (read alongside the U-V7 resolution above). Setting it makes the rephrase path's *absence* of a
 * schema deliberate and reviewable, instead of looking like a forgotten parameter.
 */
export const TEXT_RESPONSE_FORMAT: GeminiResponseFormat = {
  type: 'text',
  mime_type: 'text/plain',
};

/* ========================================================================== */
/* The client (V6)                                                             */
/* ========================================================================== */

let cachedClient: GoogleGenAI | undefined;

/**
 * The Gemini client, constructed once per process on first use.
 *
 * **The key is passed explicitly, not left to the SDK.** V6 records that `new GoogleGenAI({})`
 * reads `GEMINI_API_KEY` from the environment by itself — which would put a second `process.env`
 * reader in the codebase, outside the one accessor `scripts/check-secret-scope.ts` allows, and
 * would fail with the SDK's wording rather than with `env.ts`'s "Environment variable
 * GEMINI_API_KEY is not set. See .env.example and docs/DEPLOYMENT.md." Reading it through
 * `serverEnv()` keeps both properties.
 *
 * Constructed lazily for the reason `env.ts` validates lazily: a module-scope client would demand
 * the key during `next build`, where production secrets are legitimately absent, and fail the build
 * for the wrong reason.
 */
function geminiClient(): GoogleGenAI {
  cachedClient ??= new GoogleGenAI({ apiKey: serverEnv('GEMINI_API_KEY') });
  return cachedClient;
}

/** Test-only: drop the cached client so a following test can observe a fresh construction. */
export function resetGeminiClient(): void {
  cachedClient = undefined;
}

/**
 * The real seam implementation — and the only place the SDK's types constrain Jamee's.
 *
 * The two arguments are handed over unchanged: `request` must satisfy the SDK's
 * `CreateModelInteractionParamsNonStreaming`, and `options` its `GoogleGenAIRequestOptions`, whose
 * `RequestOptions` half extends `Omit<RequestInit, 'method' | 'body'>` — which is how a top-level
 * `signal` reaches the underlying `fetch`.
 *
 * `timeout_ms` is deliberately not passed alongside it. The pinned bundle only applies `timeout_ms`
 * when no `signal` is present (`if (!fetchOptions.signal && conf.timeout_ms > 0)`), so passing both
 * would read as two bounds where only one exists. `call.timeoutMs` is already the number the
 * gateway used to arm this signal.
 */
function sdkInteractionCreate(
  request: GeminiInteractionRequest,
  options: GeminiRequestOptions,
): Promise<GeminiInteractionResponse> {
  return geminiClient().interactions.create(request, options);
}

/* ========================================================================== */
/* The adapters                                                                */
/* ========================================================================== */

/** The signed image URL and the prompt for one classification. Bytes are never read here. */
export interface GeminiVisionInput {
  /** A signed, time-limited URL from `storage.ts` (V3). */
  readonly imageUrl: string;
  /** The object's MIME type, from the admission check (`ACCEPTED_IMAGE_TYPES`). */
  readonly imageMimeType: string;
  readonly prompt: string;
  /**
   * The JSON Schema the response must conform to. **Required**, because Requirement 3.1's
   * constrained request is the schema and not the prompt — and opaque, because what the schema
   * describes is the caller's knowledge, not this module's.
   */
  readonly responseSchema: JsonSchema;
  readonly systemInstruction?: string;
  /** Defaults to `GEMINI_GENERATION.maxOutputTokensClassify`. */
  readonly maxOutputTokens?: number;
}

/** One text generation. A schema is optional here: the rephrase path returns prose, not JSON. */
export interface GeminiTextInput {
  readonly prompt: string;
  readonly systemInstruction?: string;
  /** When present the response is requested as JSON against it; when absent, as plain text. */
  readonly responseSchema?: JsonSchema;
  /** Defaults to `GEMINI_GENERATION.maxOutputTokensGenerate`. */
  readonly maxOutputTokens?: number;
}

/**
 * What both adapters return: the model's own output, uninterpreted.
 *
 * `text` is handed on exactly as it arrived — not trimmed, not parsed, not judged. An empty string
 * is a legitimate value to return: D2's stage-1 shape check is where "the model said nothing
 * usable" becomes the single inconclusive shape with a logged `rejection_reason`, and making that
 * decision here would put agronomic judgement in the transport layer.
 */
export interface GeminiOutput {
  readonly text: string;
  /** The interaction's terminal status, carried for logging. Never branched on here. */
  readonly status: string | undefined;
}

/** Injection seam. Absent in production, where the real SDK call is used. */
export interface GeminiAdapterDeps {
  readonly create?: InteractionCreate;
}

function generationConfig(maxOutputTokens: number): GeminiInteractionRequest['generation_config'] {
  return {
    max_output_tokens: maxOutputTokens,
    // U-V7: `temperature` does not exist on this surface. These two are D7's determinism levers,
    // and `thinking_level` is also V6's latency lever for a thinking-by-default model.
    thinking_level: GEMINI_GENERATION.thinkingLevel,
    seed: GEMINI_GENERATION.seed,
  };
}

/**
 * Issue one interaction and return its raw text.
 *
 * V6 records that free-tier interaction records are retained for a day and that `store: false` opts
 * out, so every request sets it: a farmer's photo URL and prompt have no reason to sit in provider
 * storage, and Requirement 18's retention posture would be odd to hold on Jamee's own buckets while
 * leaving a copy elsewhere.
 *
 * A missing `output_text` is a `ProviderError` rather than an empty answer. That is a protocol
 * failure — the SDK's own convenience field was absent — and it classifies as `OTHER`, so it fails
 * fast instead of spending the fallback. An `output_text` that is present but empty is the
 * provider's answer and is returned untouched.
 */
async function invokeInteraction(
  request: GeminiInteractionRequest,
  call: ProviderCall,
  create: InteractionCreate,
): Promise<GeminiOutput> {
  try {
    const interaction = await create(request, {
      signal: call.signal,
      retries: GEMINI_SDK_RETRIES,
      retry_codes: [...GEMINI_SDK_RETRY_CODES],
    });

    if (typeof interaction.output_text !== 'string') {
      throw new ProviderError({
        failure: 'OTHER',
        ...(interaction.status === undefined ? {} : { statusName: interaction.status }),
      });
    }

    return { text: interaction.output_text, status: interaction.status };
  } catch (error) {
    throw asProviderError(error);
  }
}

/**
 * `vision-classify` on Gemini — the primary member of that chain.
 *
 * The image part comes first and the prompt second, and the response format is JSON against the
 * caller's schema. Requirement 3.1 is satisfied by the request, not by the wording: V7 records that
 * Gemini's structured output is schema-enforced, and also that the output is only *syntactically*
 * guaranteed — which is why D2 still validates twice downstream.
 */
export function geminiVisionAdapter(
  deps: GeminiAdapterDeps = {},
): ProviderAdapter<GeminiVisionInput, GeminiOutput> {
  const create = deps.create ?? sdkInteractionCreate;

  return {
    id: 'gemini',
    model: GEMINI_MODEL,
    classifyError: classifyGeminiError,
    invoke(input, call) {
      const request: GeminiInteractionRequest = {
        model: GEMINI_MODEL,
        input: [
          { type: 'image', uri: input.imageUrl, mime_type: input.imageMimeType },
          { type: 'text', text: input.prompt },
        ],
        generation_config: generationConfig(
          input.maxOutputTokens ?? GEMINI_GENERATION.maxOutputTokensClassify,
        ),
        response_format: jsonResponseFormat(input.responseSchema),
        store: false,
        ...(input.systemInstruction === undefined
          ? {}
          : { system_instruction: input.systemInstruction }),
      };
      return invokeInteraction(request, call, create);
    },
  };
}

/**
 * `text-generate` on Gemini — the primary member of that chain.
 *
 * Same model identifier as the vision adapter (V6: `gemini-3.8-flash` is stable and multimodal, so
 * one id serves both capabilities) and the same classification table. The difference is the output
 * contract: prose by default, JSON when the caller supplies a schema.
 */
export function geminiTextAdapter(
  deps: GeminiAdapterDeps = {},
): ProviderAdapter<GeminiTextInput, GeminiOutput> {
  const create = deps.create ?? sdkInteractionCreate;

  return {
    id: 'gemini',
    model: GEMINI_MODEL,
    classifyError: classifyGeminiError,
    invoke(input, call) {
      const request: GeminiInteractionRequest = {
        model: GEMINI_MODEL,
        input: input.prompt,
        generation_config: generationConfig(
          input.maxOutputTokens ?? GEMINI_GENERATION.maxOutputTokensGenerate,
        ),
        response_format:
          input.responseSchema === undefined
            ? TEXT_RESPONSE_FORMAT
            : jsonResponseFormat(input.responseSchema),
        store: false,
        ...(input.systemInstruction === undefined
          ? {}
          : { system_instruction: input.systemInstruction }),
      };
      return invokeInteraction(request, call, create);
    },
  };
}
