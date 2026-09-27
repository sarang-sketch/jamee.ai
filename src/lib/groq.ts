import 'server-only';

import { Buffer } from 'node:buffer';

import Groq, { toFile } from 'groq-sdk';

import {
  classifySignal,
  ProviderError,
  retryAfterFromHeaders,
  retryAfterSecondsOf,
  type ClassifyError,
  type FailureClassification,
  type HeaderReader,
  type ProviderErrorSignal,
} from '@/lib/ai/errors';
import type { AdapterSet, ProviderAdapter, ProviderCall } from '@/lib/ai/gateway';
import {
  GROQ_JSON_RESPONSE_FORMAT,
  GROQ_TEXT_MODEL,
  GROQ_TRANSCRIBE_MODEL,
  GROQ_VISION_MAX_REQUEST_BYTES,
  MAX_AUDIO_SECONDS,
  PROVIDER_RATE_LIMIT_STATUSES,
  PROVIDER_UNAVAILABLE_STATUSES,
  TRANSCRIBE_ACCEPTED_CONTAINERS,
  TRANSCRIBE_MIN_SECONDS,
  TRANSCRIBE_PROVIDER_MAX_BYTES,
  TRANSCRIBE_RESPONSE_FORMAT,
  VISION_FALLBACK_MODEL,
} from '@/lib/config/verified';
import { serverEnv } from '@/lib/env';
import type { Language } from '@/lib/schemas';

/**
 * The Groq provider: the primary `text-generate` member, the `vision-classify` fallback that only
 * exists while a vision-capable model does, and the sole `transcribe` member.
 *
 * Requirements: 8.4 (a valid voice request is transcribed through the Transcription_Provider),
 *               8.5 (English, Hindi and Marathi are transcribed), 14.4 (a rate-limit or
 *               unavailability condition from the primary is what causes a retry on the fallback —
 *               and nothing else does), 14.8 (image interpretation treats a both-provider failure
 *               as a failed operation returning the busy message)
 * Design: "Provider strategy and fallback", "Fallback matrix"
 * Depends on: V8 (package, client init, text model id, `max_completion_tokens`), V9 (whether a
 *             vision member exists, the `image_url` content part, the image limits), V10 (the
 *             transcription model, endpoint, containers and caps), V11 (the error table)
 * Authority: `docs/VERIFIED_VALUES.md` rows V8/V9/V10/V11, `docs/PROVIDER_CAPABILITIES.md`
 *            sections 1–2
 *
 * ### WHAT THIS MODULE IS NOT ALLOWED TO KNOW
 *
 * It shapes a request, returns raw output, and classifies transport errors. It does not parse a
 * completion, consult the knowledge base, or produce a farmer-facing sentence — the same
 * content-blindness the gateway keeps, for the same reason (D2's two-stage validation is the one
 * place an answer is judged, and D4 forbids a second provider call over a bad answer).
 *
 * ### THE VISION MEMBER IS A CONFIG READ, NEVER A BRANCH
 *
 * V9 resolved YES — Groq hosts vision-capable models accepting an OpenAI-style `image_url` content
 * part — but **both candidates are Preview models**, documented as evaluation-only and withdrawable
 * at short notice. So the member is registered from `VISION_FALLBACK_MODEL`, which is nullable:
 * `groqVisionMember()` returns `{}` when it is `null`, `providersFor('vision-classify')` returns a
 * one-member chain, and nothing else in the codebase moves. Requirement 14.8 is what makes that
 * safe — the gateway reaches its exhausted-chain throw by exactly one route, so a one-member chain
 * and a failed two-member chain are indistinguishable to callers. Read the constant; never hardcode
 * the identifier.
 *
 * ### GROQ'S JSON MODE IS NOT SCHEMA-ENFORCED
 *
 * V9: `response_format: { type: 'json_object' }` is a plain JSON-object mode, unlike Gemini's
 * schema-enforced structured output (V7). On the Groq vision path there is therefore no provider
 * -side guarantee that a well-formed answer matches `visionRawSchema`, so **D2's stage-1 shape
 * validation carries the whole load**. The expected effect of a Gemini vision outage is a higher
 * *inconclusive* rate — malformed answers landing in the existing single inconclusive shape with a
 * logged `rejection_reason` (Requirements 6.1–6.5) — and not a wave of errors. Worth knowing when
 * reading logs: "diagnosis quality dropped" and "Gemini is rate-limiting us" look the same to a
 * farmer and are distinguishable only through `used_fallback` and `rejection_reason` (D10).
 *
 * ### TRANSCRIPTION HAS NO SECOND MEMBER, AND THAT IS NOT AN OVERSIGHT
 *
 * V10 puts Whisper on this same host, so `transcribe` is a one-member chain — design:
 * *Fallback matrix*, "None in this release". `whisper-large-v3` is a documented *alternate*, not a
 * fallback: same host, so a Groq outage takes both out. The consequence is recorded rather than
 * hidden: a Groq outage takes voice offline while image and chat continue on Gemini. An exhausted
 * chain therefore surfaces as `TRANSCRIPTION_FAILED` (502, retryable) through
 * `EXHAUSTED_CHAIN_CODE` in the gateway, which this module neither reads nor duplicates.
 *
 * ### WHAT LIVES HERE VERSUS IN `ai/errors.ts`
 *
 * `ai/errors.ts` owns the vocabulary, the conservative `OTHER` default and the table-driven
 * matcher. This module owns the one thing only it can know: how to read a status and a
 * `retry-after` off a `groq-sdk` rejection, and which statuses V11 put in which bucket.
 */

/* ========================================================================== */
/* The client — shared with the transcription adapter (task 18.1)              */
/* ========================================================================== */

/**
 * SDK-internal retries, disabled.
 *
 * `groq-sdk` retries a network error or a 5xx twice by default, and its own docs note that a
 * request timeout is retried too — so one `create()` can be three attempts. That is the same
 * hazard `PROVIDER_CAPABILITIES.md` section 2 records for Google's SDKs, and it matters for two
 * reasons here: the gateway owns retry policy (a 429 or a 503 is supposed to move to the *next
 * chain member*, not be re-sent to the provider that just refused), and the retries would spend
 * the request's shared budget invisibly. The abort signal alone would cut them mid-loop; setting
 * this to 0 means they never start.
 */
export const GROQ_SDK_MAX_RETRIES = 0;

let cached: { apiKey: string; client: Groq } | undefined;

/**
 * The shared client. **V8:** `new Groq({ apiKey })`.
 *
 * Exported because V10 puts Whisper on this same host, so task 18.1's transcription adapter needs
 * a client and should not construct a second one — one client, one set of connection defaults, one
 * place the retry decision above is made.
 *
 * Constructed on first call rather than at import, for the reason `env.ts` defers validation: a
 * module-scope read would run during `next build`, where the key is legitimately absent, and fail
 * the build for the wrong reason. Keyed on the api key so a changed value during a dev hot reload
 * rebuilds rather than serving a stale client.
 */
export function groqClient(): Groq {
  const apiKey = serverEnv('GROQ_API_KEY');
  if (cached === undefined || cached.apiKey !== apiKey) {
    cached = { apiKey, client: new Groq({ apiKey, maxRetries: GROQ_SDK_MAX_RETRIES }) };
  }
  return cached.client;
}

/* ========================================================================== */
/* The narrow SDK surface these adapters use                                   */
/* ========================================================================== */

export type GroqChatMessage = Groq.Chat.ChatCompletionMessageParam;
export type GroqContentPart = Groq.Chat.ChatCompletionContentPart;

/**
 * The request body, narrowed to the fields V8 resolved.
 *
 * **`max_completion_tokens`, not `max_tokens`** — V8 is explicit, and the wrong one is silently
 * ignored rather than rejected, which is the worst failure mode available: a request that looks
 * accepted and is unbounded. The field name is asserted in the co-located test against
 * `GROQ_MAX_COMPLETION_TOKENS_PARAM` so the V-item and the wire format cannot drift apart.
 */
export interface GroqChatRequest {
  model: string;
  messages: GroqChatMessage[];
  temperature: number;
  max_completion_tokens: number;
  response_format?: typeof GROQ_JSON_RESPONSE_FORMAT;
}

/** Per-request options. `signal` is not optional to honour — see `invokeChat()`. */
export interface GroqRequestOptions {
  signal: AbortSignal;
  timeout: number;
  maxRetries: number;
}

/**
 * `groq.chat.completions.create` (V8), as a function type.
 *
 * The seam every adapter factory takes, so a unit test stubs one function instead of mocking a
 * module — the same injection style `chainOrderFor()` uses for the vision-model constant.
 */
export type GroqChatCreate = (
  body: GroqChatRequest,
  options: GroqRequestOptions,
) => Promise<Groq.Chat.ChatCompletion>;

function sdkChatCreate(
  body: GroqChatRequest,
  options: GroqRequestOptions,
): Promise<Groq.Chat.ChatCompletion> {
  return groqClient().chat.completions.create(body, options);
}

/* ========================================================================== */
/* Error classification (V11)                                                  */
/* ========================================================================== */

/**
 * V11's Groq table, exactly.
 *
 * **413 and 422 are absent on purpose**, so both fall through to `OTHER` and neither can trigger a
 * fallback:
 *  - **413** Request Entity Too Large is Jamee's own oversized payload. A second provider fails on
 *    the same bytes, so retrying spends a call to learn nothing.
 *  - **422** Unprocessable Entity is documented to include *model hallucinations*, which makes it
 *    an output problem. Jamee's path for that is D2's two-stage validation collapsing it into the
 *    single inconclusive shape with no second model call (Requirement 6.6) — not the fallback path.
 *
 * Both name lists are empty because Groq publishes no status *names*. Its error body carries
 * `{ error: { message, type } }`, and neither field reaches this table: `message` is prose that is
 * not part of any documented contract, and `type` is explicitly recorded as safe to log but not to
 * classify on. The untouched SDK rejection stays available as `cause`.
 */
export const GROQ_FAILURE_CLASSIFICATION: FailureClassification = {
  rateLimitStatuses: PROVIDER_RATE_LIMIT_STATUSES,
  unavailableStatuses: PROVIDER_UNAVAILABLE_STATUSES,
  rateLimitStatusNames: [],
  unavailableStatusNames: [],
};

function readStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/**
 * The rejection's response headers, when it has any that read like headers.
 *
 * `Groq.APIError` exposes `headers` as a `Headers` object, but `APIConnectionError` and
 * `APIUserAbortError` extend the same class with `undefined` — so this is a structural probe rather
 * than an `instanceof` narrowing, which also means a test's stub error works without constructing
 * an SDK internal.
 */
function readHeaders(error: unknown): HeaderReader | undefined {
  if (typeof error !== 'object' || error === null || !('headers' in error)) return undefined;
  const headers = (error as { headers?: unknown }).headers;
  if (typeof headers !== 'object' || headers === null) return undefined;
  return typeof (headers as { get?: unknown }).get === 'function'
    ? (headers as HeaderReader)
    : undefined;
}

/**
 * Read a `groq-sdk` rejection into the signal `classifySignal()` consumes.
 *
 * **V11: `retry-after` is in SECONDS**, and Groq sets it only on a 429. It is read unconditionally
 * anyway — a header that is absent parses to `undefined`, so keying the read on the status would
 * add a branch that changes nothing. The value is advisory: `retryAfterSecondsOf()` explains why
 * the gateway logs it and never sleeps on it.
 */
export function groqErrorSignal(error: unknown): ProviderErrorSignal {
  const status = readStatus(error);
  const headers = readHeaders(error);
  const retryAfterSeconds =
    (headers === undefined ? undefined : retryAfterFromHeaders(headers)) ??
    retryAfterSecondsOf(error);

  return {
    ...(status === undefined ? {} : { status }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

/**
 * The `classifyError()` seam for both Groq adapters.
 *
 * Anything without a recognised status — a socket reset, an abort, a `TypeError` from this
 * module's own code — is `OTHER`, which stops the chain. That default is D4's conservatism: an
 * unrecognized error must never silently double provider spend.
 */
export const classifyGroqError: ClassifyError = (error) =>
  classifySignal(groqErrorSignal(error), GROQ_FAILURE_CLASSIFICATION);

/**
 * Normalize an SDK rejection into a `ProviderError`, classified once.
 *
 * Adapters throw this rather than re-throwing the SDK error, for two concrete gains: the
 * classification happens where the shape is known instead of twice, and `retryAfterSecondsOf()` —
 * which the gateway calls to put a rate-limit window into its server-side log context — only reads
 * a `ProviderError`. The original rejection is preserved as `cause` and the message is built from
 * the status alone, so no provider payload fragment reaches a log line (Requirement 15.6).
 */
export function toGroqProviderError(error: unknown): ProviderError {
  const signal = groqErrorSignal(error);
  return new ProviderError({
    failure: classifySignal(signal, GROQ_FAILURE_CLASSIFICATION),
    ...signal,
    cause: error,
  });
}

/* ========================================================================== */
/* Request shaping                                                             */
/* ========================================================================== */

/**
 * Lowest temperature, for D7's determinism goal. V8 records `temperature` among the
 * OpenAI-compatible parameters Groq accepts, so unlike Gemini's (U-V7) this one is not in doubt.
 *
 * `seed` is deliberately not set: the SDK accepts one, but no V-item records Groq honouring it, and
 * a parameter asserted without a source is exactly what the V-item rule exists to prevent.
 */
export const GROQ_TEMPERATURE = 0;

/**
 * Default output caps. Jamee's own numbers, not provider limits — V8 records the model ceiling at
 * 65,536 completion tokens, far above anything Jamee asks for.
 *
 * They match `GEMINI_GENERATION`'s pair on purpose: a fallback answer should be the same length
 * class as a primary answer, or a farmer would see the outage in the shape of the reply.
 */
export const GROQ_MAX_COMPLETION_TOKENS = { classify: 256, generate: 1024 } as const;

/** What the `text-generate` adapter takes. Opaque to the gateway. */
export interface TextGenerateRequest {
  /** The prompt. Words come from `prompts.ts` (tasks 8.4, 9.2); this module never authors any. */
  readonly prompt: string;
  /** Optional `system` instruction, sent as a `system` message. */
  readonly system?: string;
  /** Defaults to `GROQ_MAX_COMPLETION_TOKENS.generate`. */
  readonly maxCompletionTokens?: number;
  /** Ask for JSON-object mode. Off by default — a rephrase is prose. */
  readonly json?: boolean;
}

/** What the conditional `vision-classify` adapter takes. */
export interface VisionClassifyRequest {
  /**
   * **V9:** a public URL or a `data:image/jpeg;base64,…` URI. Under A3 there is no Storage and no
   * signed URL to mint, so Jamee passes the Full_Size_Image bytes as a base64 data URI read from
   * GridFS through the Data_Access_Layer (V34).
   *
   * Exactly one image, which is inside both candidate models' per-request cap (3 on
   * `qwen/qwen3.8-27b`, 5 on `qwen/qwen3.6-27b`) and costs one `GROQ_VISION_IMAGE_INPUT_TOKENS`
   * unit of the 131K context.
   */
  readonly imageUrl: string;
  readonly prompt: string;
  readonly system?: string;
  /** Defaults to `GROQ_MAX_COMPLETION_TOKENS.classify`. */
  readonly maxCompletionTokens?: number;
  /**
   * JSON-object mode, **on by default**: this member exists only as the fallback for D2's
   * constrained classification, whose contract is JSON-only. Set `false` to opt out.
   */
  readonly json?: boolean;
}

function messagesFor(
  system: string | undefined,
  content: string | GroqContentPart[],
): GroqChatMessage[] {
  const messages: GroqChatMessage[] = [];
  if (system !== undefined && system.trim() !== '') messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content });
  return messages;
}

/**
 * Bytes this request will put on the wire, near enough to compare against a 20 MB ceiling.
 *
 * The image reference dominates and is ASCII by construction — a URL, or base64 in a data URI — so
 * its `length` *is* its byte count. Only the prompt can carry multi-byte text, and it is small
 * enough to measure exactly. Encoding the whole thing to count bytes would allocate a second copy
 * of a 13 MB string on every call, which on a metered platform is real CPU for no extra accuracy.
 */
export function visionRequestBytes(input: VisionClassifyRequest): number {
  const encoder = new TextEncoder();
  return (
    input.imageUrl.length +
    encoder.encode(input.prompt).length +
    (input.system === undefined ? 0 : encoder.encode(input.system).length)
  );
}

/**
 * V9's 20 MB ceiling on a request containing an image, enforced before the call.
 *
 * Thrown as a `ProviderError` carrying the **413** the provider would have answered with, which
 * per V11 classifies as `OTHER`: it fails fast and spends nothing, and it must not reach the
 * fallback path because a second provider fails on the same bytes.
 *
 * This is a defensive floor, not the farmer-facing check. Requirements 2.4 and 8.3 own the message
 * that names a limit, and `MAX_IMAGE_BYTES` (10 MB → ~13.4 MB base64) already keeps an admitted
 * image under this ceiling — so reaching here means an earlier guard was bypassed, which is worth
 * failing on rather than discovering as a provider 400.
 */
export function assertVisionRequestWithinCeiling(input: VisionClassifyRequest): void {
  const bytes = visionRequestBytes(input);
  if (bytes <= GROQ_VISION_MAX_REQUEST_BYTES) return;
  throw new ProviderError({
    failure: 'OTHER',
    status: 413,
    cause: new Error(
      `jamee: Groq vision request is ${bytes} bytes, over the documented ${GROQ_VISION_MAX_REQUEST_BYTES}-byte ceiling (V9)`,
    ),
  });
}

export function textRequestBody(model: string, input: TextGenerateRequest): GroqChatRequest {
  return {
    model,
    messages: messagesFor(input.system, input.prompt),
    temperature: GROQ_TEMPERATURE,
    max_completion_tokens: input.maxCompletionTokens ?? GROQ_MAX_COMPLETION_TOKENS.generate,
    ...(input.json === true ? { response_format: GROQ_JSON_RESPONSE_FORMAT } : {}),
  };
}

export function visionRequestBody(model: string, input: VisionClassifyRequest): GroqChatRequest {
  assertVisionRequestWithinCeiling(input);
  const content: GroqContentPart[] = [
    { type: 'text', text: input.prompt },
    // V9: the OpenAI-style image content part, taking a public URL or a data URI.
    { type: 'image_url', image_url: { url: input.imageUrl } },
  ];
  return {
    model,
    messages: messagesFor(input.system, content),
    temperature: GROQ_TEMPERATURE,
    max_completion_tokens: input.maxCompletionTokens ?? GROQ_MAX_COMPLETION_TOKENS.classify,
    ...(input.json === false ? {} : { response_format: GROQ_JSON_RESPONSE_FORMAT }),
  };
}

/* ========================================================================== */
/* The adapters                                                                */
/* ========================================================================== */

/**
 * One call, and the two bounds on it.
 *
 * **`call.signal` reaches the SDK** — this is the whole point of the gateway handing one over. It
 * fires at `min(per-attempt ceiling, remaining budget)`, so a provider that stops responding cannot
 * hold the invocation past the shared deadline. `timeout` is the SDK's own per-request bound,
 * passed as well because it produces a clean SDK rejection where the signal produces an abort, and
 * two independent bounds cost nothing.
 *
 * **A missing choice or a null content becomes `''`, not an error.** The adapter does not judge
 * content: D2's stage-1 validation is the one place an answer is called unusable, and routing an
 * empty completion through it keeps it on the inconclusive path (Requirements 6.1–6.5) instead of
 * dressing it up as a provider outage. Which is the same reason V9's plain JSON mode is acceptable
 * here at all.
 */
async function invokeChat(
  create: GroqChatCreate,
  body: GroqChatRequest,
  call: ProviderCall,
): Promise<string> {
  try {
    const completion = await create(body, {
      signal: call.signal,
      timeout: call.timeoutMs,
      maxRetries: GROQ_SDK_MAX_RETRIES,
    });
    return completion.choices[0]?.message.content ?? '';
  } catch (error) {
    throw toGroqProviderError(error);
  }
}

export interface GroqAdapterOptions {
  /**
   * Injection seam. Defaults to `groq.chat.completions.create` against the shared client, resolved
   * at invoke time so no client is constructed — and no key is read — merely by building an
   * adapter.
   */
  readonly create?: GroqChatCreate;
}

function createOf(options: GroqAdapterOptions): GroqChatCreate {
  return options.create ?? sdkChatCreate;
}

/**
 * The `text-generate` adapter. **V8:** `openai/gpt-oss-20b`, read from config.
 *
 * This adapter is the primary for text generation; the capability gateway falls back to Gemini
 * when Groq reports a rate limit or documented unavailability.
 */
export function groqTextAdapter(
  options: GroqAdapterOptions = {},
): ProviderAdapter<TextGenerateRequest, string> {
  const create = createOf(options);
  return {
    id: 'groq',
    model: GROQ_TEXT_MODEL,
    classifyError: classifyGroqError,
    // `async` so a body-shaping failure arrives as a rejection like every other failure. The
    // gateway would catch a synchronous throw either way; a caller reading the `Promise<string>`
    // signature would not, and an adapter that fails in two different ways is a trap.
    invoke: async (input, call) => invokeChat(create, textRequestBody(GROQ_TEXT_MODEL, input), call),
  };
}

/**
 * The `vision-classify` fallback, for a caller that already has a non-null model id.
 *
 * Prefer `groqVisionMember()`, which is the shape that makes the withdrawal case a config edit.
 */
export function groqVisionAdapter(
  model: string,
  options: GroqAdapterOptions = {},
): ProviderAdapter<VisionClassifyRequest, string> {
  const create = createOf(options);
  return {
    id: 'groq',
    model,
    classifyError: classifyGroqError,
    // `async` for the reason above, and it matters more here: the V9 size guard in
    // `visionRequestBody()` is a pre-flight throw on the happy path's own code.
    invoke: async (input, call) => invokeChat(create, visionRequestBody(model, input), call),
  };
}

/**
 * The conditional vision member, as a spreadable `AdapterSet` fragment:
 *
 * ```ts
 * providersFor('vision-classify', { gemini: geminiVisionAdapter(), ...groqVisionMember() });
 * ```
 *
 * `{ groq: adapter }` while `VISION_FALLBACK_MODEL` names a model, `{}` once it is `null`. A
 * fragment rather than a nullable adapter because `AdapterSet` is a `Partial<Record<…>>` and
 * `exactOptionalPropertyTypes` rejects `{ groq: undefined }` — so the type system pushes the caller
 * towards the one form where the absent case needs no branch of its own.
 *
 * **Withdrawal of the Preview model is this constant going `null` and nothing else.** No call site
 * moves, no test changes, and the farmer-visible behaviour afterwards is the same busy message it
 * already is when both members fail (Requirement 14.8).
 *
 * The parameter exists so both chain shapes are testable without mocking a module, and defaults to
 * the config value, which is what every production call site uses.
 */
export function groqVisionMember(
  model: string | null = VISION_FALLBACK_MODEL,
  options: GroqAdapterOptions = {},
): AdapterSet<VisionClassifyRequest, string> {
  return model === null ? {} : { groq: groqVisionAdapter(model, options) };
}
/* ========================================================================== */
/* Transcription — the sole `transcribe` member (V10)                          */
/* ========================================================================== */

/**
 * V10's temperature guidance: the parameter accepts 0–1 and **0 is the recommended default**.
 *
 * Deliberately the same choice `GROQ_TEMPERATURE` makes for the chat surface, for the same D7
 * reason: a farmer who records the same question twice should not get two different transcripts
 * because the decoder felt creative.
 */
export const GROQ_TRANSCRIBE_TEMPERATURE = 0;

/**
 * What the `transcribe` adapter takes.
 *
 * **Amendment A3: the audio goes as bytes in the `file` parameter, never by URL.** Under A3 there
 * is no Supabase Storage and therefore no signed URL to hand the provider (V34) — the analysis
 * reads the recording's bytes from GridFS through the Data_Access_Layer and Jamee sends them as
 * `file`. V10 makes `file` and `url` mutually exclusive with one required; this adapter now always
 * sends `file`, built with the SDK's own `toFile()` helper. The 25 MB free-tier attachment cap
 * (V10, `TRANSCRIBE_PROVIDER_MAX_BYTES`) is the relevant bound, checked before the call — Jamee's
 * own 3 MB voice cap (A3) sits far below it.
 */
export interface TranscribeRequest {
  /**
   * The recording's bytes — the `file` upload the provider transcribes (V34).
   *
   * The successor to the retired `audioUrl` field: A3 removed Supabase Storage, so there is no URL
   * to fetch and the bytes travel in the request. `mimeType` names the container to the SDK's
   * `toFile()` so the multipart part carries the right `Content-Type`.
   */
  readonly audioBytes: Buffer;
  /**
   * The container, as either a file extension (`webm`, `.ogg`, `M4A`) or a MIME type
   * (`audio/webm;codecs=opus`). Checked against V10's accepted list **before** the call.
   *
   * Required rather than optional so the check cannot be skipped by omission. Every caller has
   * one for free: the web path reads `MediaRecorder.mimeType` back into the media reference's
   * stored MIME type — sent rather than assumed because U-V20 leaves the recorded container
   * unresolved on the target Android browsers — and the Telegram path gets `mime_type` from V26's
   * media-metadata step.
   */
  readonly container: string;
  /**
   * ISO-639-1, which Jamee's three `Supported_Languages` already are (Requirement 8.5).
   *
   * **Always sent.** V10 records that supplying the input language improves accuracy *and*
   * latency, and latency is budget on a path with a 20 s attempt ceiling. `whisper-large-v3-turbo`
   * is transcription-only (no translation), which is exactly the capability Jamee needs: the
   * transcript stays in the farmer's language and `text-generate` answers in it.
   */
  readonly language: Language;
  /**
   * Object size in bytes, checked against V10's tier cap when the caller knows it.
   *
   * **Optional because the caller may pass the byte length separately from the buffer.** With the
   * bytes in hand the length is `audioBytes.byteLength`, so a caller need not supply this; it stays
   * for the Telegram path, where V26's media-metadata step returns `file_size` before the bytes are
   * fetched, and for callers that want the size checked against the provider cap explicitly.
   */
  readonly bytes?: number;
  /**
   * Measured duration in seconds, checked when supplied.
   *
   * **U-V10 is unresolved: no maximum duration is documented.** So there is no provider duration
   * cap to enforce and none is invented here. What is enforced is V10's documented *minimum*
   * (0.01 s) and Jamee's *own* 120 s recording rule (Requirement 8.2, `MAX_AUDIO_SECONDS`) —
   * see `assertTranscribableAudio()` for why the two are kept distinguishable.
   */
  readonly durationSeconds?: number;
  /** V10: `prompt` guides style only, ≤224 tokens. Unused today; no V-item asks for one. */
  readonly prompt?: string;
}

/**
 * The `verbose_json` confidence signals V10 names: `avg_logprob`, `no_speech_prob` and
 * `compression_ratio`.
 *
 * Every field is `| undefined` rather than optional so a caller destructures without
 * `exactOptionalPropertyTypes` friction, and so "the provider did not send this" is one shape
 * rather than two.
 */
export interface TranscriptionSignals {
  readonly avgLogprob: number | undefined;
  readonly noSpeechProb: number | undefined;
  readonly compressionRatio: number | undefined;
}

/**
 * What the adapter returns.
 *
 * **`text` is handed back exactly as the provider produced it, including `''`.** An empty
 * transcript is a *successful* provider call, not a failure: Requirement 8.7 gives it its own code
 * (`TRANSCRIPT_EMPTY`, 422, "record again somewhere quieter") and the gateway's own comment is
 * explicit that this module never sees that case. Judging emptiness here would collapse it into
 * `TRANSCRIPTION_FAILED` (502, retryable over the same object) and tell a farmer who recorded
 * silence to retry the silence. Trimming is likewise the caller's call — 18.2 owns the
 * whitespace-only test.
 */
export interface TranscriptionResult {
  readonly text: string;
  /** The language the provider reported, when `verbose_json` carried one. Not validated here. */
  readonly language: string | undefined;
  /** The duration the provider measured, when it reported one. */
  readonly durationSeconds: number | undefined;
  /**
   * Signals read from the **top level** of the payload.
   *
   * V10 names the three fields without stating whether they sit at the top level or on each
   * segment, so both places are surfaced as found (see `segments`) and **neither is aggregated**.
   * An aggregation rule — mean, max, first — would be a judgement about content, and this module
   * does not make those; D2's validation and 18.2's empty-transcript test are where content is
   * judged. `no_speech_prob` is the signal the design cares about: it distinguishes "the farmer
   * recorded silence" from "the provider produced nothing", which is why a voice object is
   * RETAINED after an empty transcript (Requirement 8.10) rather than deleted.
   */
  readonly signals: TranscriptionSignals;
  /** The same signals per segment, when the payload carries them there instead. */
  readonly segments: readonly TranscriptionSignals[];
}

/**
 * The request body, narrowed to the V10 fields Jamee sends.
 *
 * `file` rather than `url` (A3, V34): there are no public URLs, so the bytes travel as a `File`
 * built with the SDK's `toFile()`. No `timestamp_granularities`: V10 records that word-level
 * timestamps add latency, and nothing in Requirement 8 reads a timestamp.
 */
export interface GroqTranscriptionRequest {
  model: string;
  file: File;
  language: string;
  response_format: typeof TRANSCRIBE_RESPONSE_FORMAT;
  temperature: number;
  prompt?: string;
}

/**
 * `client.audio.transcriptions.create` (V10), as a function type — the same injection seam
 * `GroqChatCreate` is, for the same reason.
 *
 * The return type is `unknown` rather than the SDK's `Transcription`, and that is deliberate:
 * `groq-sdk@1.6.0` types the response as `{ text: string }` only, so the `verbose_json` fields V10
 * documents are **not** in the SDK's type. Typing this as `Transcription` would force a cast at
 * every read; typing it `unknown` puts the one defensive read in `readTranscription()`.
 */
export type GroqTranscriptionCreate = (
  body: GroqTranscriptionRequest,
  options: GroqRequestOptions,
) => Promise<unknown>;

function sdkTranscriptionCreate(
  body: GroqTranscriptionRequest,
  options: GroqRequestOptions,
): Promise<unknown> {
  // V10's endpoint is POST https://api.groq.com/openai/v1/audio/transcriptions, which is exactly
  // what this SDK method resolves to against the client's default base URL. Under A3 the audio
  // travels as the `file` multipart part (V34) rather than a `url`. The co-located test asserts
  // that composition against `GROQ_TRANSCRIBE_ENDPOINT` with an injected `fetch`, so the V-item
  // and the URL actually requested cannot drift apart unnoticed.
  return groqClient().audio.transcriptions.create(body, options);
}

/* -------------------------------------------------------------------------- */
/* Container admission (V10)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reduce a file extension or a MIME type to the bare container name V10 lists, or `undefined`.
 *
 * Four normalization steps, none of which is a V-item — V10 supplies the *list*, this supplies the
 * spelling tolerance a real caller needs:
 *
 * ```
 * 'audio/webm;codecs=opus'  ->  'webm'      parameters dropped
 * 'audio/ogg'               ->  'ogg'       subtype taken
 * 'audio/x-m4a'             ->  'm4a'       RFC 6838 legacy `x-` tree marker dropped
 * '.WEBM'                   ->  'webm'      leading dot and case
 * ```
 *
 * Exported so the recorder's candidate probe and this guard agree on what "the same container"
 * means. Note the recorder is a client component and cannot import from this `server-only` module
 * — it intersects its preference list against `TRANSCRIBE_ACCEPTED_CONTAINERS` in
 * `config/verified.ts`, which is client-importable for exactly that reason (task 19.1).
 */
export function normalizeAudioContainer(value: string): string | undefined {
  const base = value.trim().toLowerCase().split(';')[0]?.trim() ?? '';
  if (base === '') return undefined;
  const subtype = base.includes('/') ? (base.split('/')[1] ?? '') : base;
  const bare = subtype.replace(/^\./, '').replace(/^x-/, '');
  return bare === '' ? undefined : bare;
}

/**
 * Whether V10 accepts this container.
 *
 * **A cross-check worth knowing about, not papered over here.** A messaging channel can deliver
 * audio in a container outside V10's accepted list of `flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav,
 * webm`. Rather than widen the list to accommodate one, this function refuses an unknown container
 * — inventing a container Groq may not accept would turn a loud pre-flight refusal into a provider
 * 400 discovered in production.
 */
export function isAcceptedAudioContainer(value: string): boolean {
  const container = normalizeAudioContainer(value);
  return (
    container !== undefined &&
    (TRANSCRIBE_ACCEPTED_CONTAINERS as readonly string[]).includes(container)
  );
}

/**
 * A pre-flight refusal, shaped as the `ProviderError` an adapter would have thrown after the call.
 *
 * `failure` is always `OTHER`, which per V11 means the gateway stops rather than retrying — and on
 * a one-member chain there is nothing to retry anyway. `status` is passed **only** where V11
 * documents the status the provider would actually have answered with (413 Request Entity Too
 * Large); the container and duration guards pass none, because no V-item records a status for
 * either and a fabricated one would be indistinguishable from a fact in a log line.
 */
function transcribeRefusal(reason: string, status?: number): ProviderError {
  return new ProviderError({
    failure: 'OTHER',
    ...(status === undefined ? {} : { status }),
    cause: new Error(`jamee: ${reason}`),
  });
}

/**
 * Refuse an audio reference the provider would refuse — or that Jamee's own rules refuse — before
 * spending the call.
 *
 * Three guards, and the third is the one to read carefully.
 *
 *  1. **Container** — V10's accepted list. This is defence in depth: task 19.1's recorder picks its
 *     MIME type from a preference list *intersected* with that same list and says so plainly when
 *     the browser offers none, which is where a farmer is meant to learn about this. Reaching here
 *     means a hand-built request or an unexpected `MediaRecorder.mimeType`, and failing with the
 *     accepted list named beats a provider rejection with no context.
 *  2. **Size** — V10's 25 MB free-tier cap, carrying the **413** V11 documents. It must not become
 *     a fallback trigger and cannot: 413 is `OTHER`, and a second provider would fail on the same
 *     object.
 *  3. **Duration** — and here the two bounds have *different owners*, which is why they are not
 *     collapsed into one range check:
 *      - The lower bound, `TRANSCRIBE_MIN_SECONDS` (0.01 s), is **V10's**, documented.
 *      - There is **no documented maximum (U-V10)**. The upper bound is `MAX_AUDIO_SECONDS` —
 *        Jamee's own 120 s recording rule from Requirement 8.2 — and the effective provider
 *        ceiling is the size cap plus the audio-seconds rate limits, not a duration. So a message
 *        derived from this bound may never be presented to a farmer as a provider limit; it is
 *        Jamee's product rule, and Requirement 8.3 is where the farmer-facing wording lives.
 *
 * V10 also records a **minimum billed length of 10 s**, which is *not* a gate — 120 short
 * recordings bill as 120 ten-second ones, which is arithmetic for the free-tier sizing note and
 * nothing this function should refuse over.
 */
export function assertTranscribableAudio(input: TranscribeRequest): void {
  if (!isAcceptedAudioContainer(input.container)) {
    throw transcribeRefusal(
      `audio container "${input.container}" is not one of the containers the transcription ` +
        `provider accepts (${TRANSCRIBE_ACCEPTED_CONTAINERS.join(', ')}) — V10`,
    );
  }

  const bytes = input.bytes ?? input.audioBytes.byteLength;
  if (bytes > TRANSCRIBE_PROVIDER_MAX_BYTES) {
    throw transcribeRefusal(
      `audio object is ${bytes} bytes, over the documented ${TRANSCRIBE_PROVIDER_MAX_BYTES}-byte ` +
        'transcription cap (V10)',
      413,
    );
  }

  const { durationSeconds } = input;
  if (durationSeconds !== undefined) {
    if (durationSeconds < TRANSCRIBE_MIN_SECONDS) {
      throw transcribeRefusal(
        `audio is ${durationSeconds} s, under the documented ${TRANSCRIBE_MIN_SECONDS} s minimum ` +
          'transcribable length (V10)',
      );
    }
    if (durationSeconds > MAX_AUDIO_SECONDS) {
      throw transcribeRefusal(
        `audio is ${durationSeconds} s, over Jamee's own ${MAX_AUDIO_SECONDS} s recording rule ` +
          '(Requirement 8.2). This is not a provider limit — no maximum duration is documented ' +
          '(U-V10) — so it must not be reported to a farmer as one',
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Request shaping and response reading                                        */
/* -------------------------------------------------------------------------- */

export async function transcriptionRequestBody(
  model: string,
  input: TranscribeRequest,
): Promise<GroqTranscriptionRequest> {
  assertTranscribableAudio(input);
  // A3, V34: the bytes travel as the `file` multipart part. `toFile()` is the SDK's own helper for
  // turning a Buffer into the `File` the multipart upload wants; the container is passed as the
  // MIME type and as a plausible filename so the provider reads the right `Content-Type`. The
  // filename is non-identifying — nothing looks a recording up by name.
  const container = normalizeAudioContainer(input.container) ?? 'audio';
  const file = await toFile(input.audioBytes, `voice.${container}`, {
    type: mimeForContainer(input.container),
  });
  return {
    model,
    // V10: `file` | `url`, mutually exclusive, one required. Always `file` — see `TranscribeRequest`.
    file,
    language: input.language,
    response_format: TRANSCRIBE_RESPONSE_FORMAT,
    temperature: GROQ_TRANSCRIBE_TEMPERATURE,
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
  };
}

/**
 * The `Content-Type` for the multipart `file` part. When the caller handed a MIME type
 * (`audio/webm;codecs=opus`) its bare form is used; when it handed a bare container (`webm`) it is
 * prefixed to `audio/<container>`. Best-effort — the provider reads the bytes, not the label — so a
 * value that cannot be normalized falls back to `application/octet-stream`.
 */
function mimeForContainer(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.includes('/')) return trimmed.split(';')[0]?.trim() ?? 'application/octet-stream';
  const bare = normalizeAudioContainer(value);
  return bare === undefined ? 'application/octet-stream' : `audio/${bare}`;
}

function numberAt(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function signalsOf(source: Record<string, unknown>): TranscriptionSignals {
  return {
    avgLogprob: numberAt(source, 'avg_logprob'),
    noSpeechProb: numberAt(source, 'no_speech_prob'),
    compressionRatio: numberAt(source, 'compression_ratio'),
  };
}

/**
 * Read a `verbose_json` payload into `TranscriptionResult`, tolerating every field except `text`.
 *
 * Written as a structural probe rather than a cast because the pinned SDK types the response as
 * `{ text: string }` and nothing more, so every field V10 documents beyond `text` is unverifiable
 * against the types and has to be verified against the value. A payload with no usable `text`
 * yields `''` — the same "raw output, no judgement" rule the chat path follows, and the input to
 * Requirement 8.7's empty-transcript branch rather than a manufactured provider failure.
 */
export function readTranscription(raw: unknown): TranscriptionResult {
  if (typeof raw !== 'object' || raw === null) {
    return { text: '', language: undefined, durationSeconds: undefined, signals: signalsOf({}), segments: [] };
  }
  const payload = raw as Record<string, unknown>;
  const text = payload['text'];
  const language = payload['language'];
  const rawSegments = payload['segments'];

  return {
    text: typeof text === 'string' ? text : '',
    language: typeof language === 'string' && language !== '' ? language : undefined,
    durationSeconds: numberAt(payload, 'duration'),
    signals: signalsOf(payload),
    segments: Array.isArray(rawSegments)
      ? rawSegments
          .filter((segment): segment is Record<string, unknown> =>
            typeof segment === 'object' && segment !== null)
          .map(signalsOf)
      : [],
  };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                 */
/* -------------------------------------------------------------------------- */

export interface GroqTranscribeOptions {
  /**
   * Injection seam. Defaults to `audio.transcriptions.create` against the shared client, resolved
   * at invoke time so building an adapter constructs no client and reads no key.
   */
  readonly create?: GroqTranscriptionCreate;
}

/** One call, bounded the same two ways `invokeChat()` is, and for the same reasons. */
async function invokeTranscription(
  create: GroqTranscriptionCreate,
  body: GroqTranscriptionRequest,
  call: ProviderCall,
): Promise<TranscriptionResult> {
  try {
    const raw = await create(body, {
      signal: call.signal,
      timeout: call.timeoutMs,
      maxRetries: GROQ_SDK_MAX_RETRIES,
    });
    return readTranscription(raw);
  } catch (error) {
    throw toGroqProviderError(error);
  }
}

/**
 * The `transcribe` adapter. **V10:** `whisper-large-v3-turbo`, read from config.
 *
 * Unconditional, and with no sibling. `whisper-large-v3` is the documented alternate behind the
 * same constant — a config edit, not a chain member, because it sits on the same host.
 */
export function groqTranscribeAdapter(
  options: GroqTranscribeOptions = {},
): ProviderAdapter<TranscribeRequest, TranscriptionResult> {
  const create = options.create ?? sdkTranscriptionCreate;
  return {
    id: 'groq',
    model: GROQ_TRANSCRIBE_MODEL,
    classifyError: classifyGroqError,
    // `async` so a pre-flight refusal in `transcriptionRequestBody()` arrives as a rejection like
    // every other failure, rather than as a synchronous throw a typed caller would not expect.
    invoke: async (input, call) =>
      invokeTranscription(create, await transcriptionRequestBody(GROQ_TRANSCRIBE_MODEL, input), call),
  };
}

/**
 * The `transcribe` chain, as the `AdapterSet` the gateway takes:
 *
 * ```ts
 * const { value } = await run('transcribe', groqTranscribeMember(), request, { deadlineMs });
 * ```
 *
 * **No fallback key, ever** (design: *Fallback matrix*, "None in this release"). Unlike
 * `groqVisionMember()` this takes no nullable model, because there is no second member whose
 * withdrawal it would have to absorb — the shape is a one-key set by design and not by
 * configuration. If both members of that set ever had to fail, `EXHAUSTED_CHAIN_CODE.transcribe`
 * is already `TRANSCRIPTION_FAILED` and the gateway reaches it through its single exit, so adding
 * one later needs no change here or at any call site.
 */
export function groqTranscribeMember(
  options: GroqTranscribeOptions = {},
): AdapterSet<TranscribeRequest, TranscriptionResult> {
  return { groq: groqTranscribeAdapter(options) };
}
