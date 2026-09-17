/**
 * Every third-party value Jamee codes against, resolved once in `docs/VERIFIED_VALUES.md`
 * and asserted here exactly once.
 *
 * Requirements: 17.2, 17.7 (the free-tier claim is measured against the recorded allowances),
 *               and the V-item rule that runs through the whole implementation plan.
 * Design: "Values to verify before coding"; `docs/PROVIDER_CAPABILITIES.md` sections 1–4.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. Every constant below carries the V-item that resolved
 * it. If you are about to add a model identifier, a header name, an endpoint, a provider
 * limit, or a platform limit and you cannot write a `V<n>` next to it, it is not verified and
 * it does not belong here — resolve it in `docs/VERIFIED_VALUES.md` first. A plausible guess
 * that lands in this file is indistinguishable from a fact, which is exactly the failure mode
 * the V-item discipline exists to prevent.
 *
 * Conversely, nothing here is a secret. Secrets come from `serverEnv()` in `src/lib/env.ts`.
 *
 * **This module must stay importable from a client component**, because `ImageUploader` and
 * `VoiceRecorder` quote `ACCEPTED_IMAGE_TYPES`, `MAX_IMAGE_BYTES`, `MAX_AUDIO_BYTES` and
 * `MAX_AUDIO_SECONDS` in the same rejection messages the server-side checks use
 * (Requirements 2.4, 8.3). So it imports NOTHING — in particular not `src/lib/env.ts`, whose
 * `import 'server-only'` would make every client component that reads a limit a build error.
 * Anything needing an environment variable belongs in the server module that consumes it.
 */

/* ========================================================================== */
/* Supabase                                                                    */
/* ========================================================================== */

/** The two private buckets. No `video-inputs` bucket exists — Requirement 19 is deferred. */
export const STORAGE_BUCKETS = {
  cropImages: 'crop-images',
  voiceMessages: 'voice-messages',
} as const;

export type StorageBucket = (typeof STORAGE_BUCKETS)[keyof typeof STORAGE_BUCKETS];

/**
 * `createSignedUrl(path, expiresIn)` — **V3: `expiresIn` is a number of SECONDS**, not
 * milliseconds. Getting the unit wrong by a factor of 1000 fails in the forgiving direction
 * (a URL that lives 10 minutes instead of 0.6 seconds), which is exactly why it needs to be
 * stated rather than inferred.
 *
 * 600 s is Jamee's choice, not a documented value. It has to outlive the longest thing that
 * reads the object: a provider fetching image bytes inside the 45 s request budget
 * (`docs/PROVIDER_CAPABILITIES.md` section 3), and a farmer's history page finishing its
 * render. Ten minutes clears both with room, and stays short enough that a leaked URL from a
 * shared screenshot is stale by the time anyone tries it.
 */
export const SIGNED_URL_EXPIRY_SECONDS = 600;

/**
 * Storage RLS extracts the first path segment with `(storage.foldername(name))[1]` — **V4**,
 * and Postgres arrays are 1-indexed, which is why the migration says `[1]` and not `[0]`.
 * Recorded here because the application-side ownership check in `src/lib/storage.ts` must
 * compare the SAME segment the database policy compares; a mismatch would leave one of the
 * two boundaries checking a different thing.
 */
export const STORAGE_OWNER_PATH_SEGMENT_INDEX = 0 as const; // 0-based in JS; `[1]` in SQL

/* ========================================================================== */
/* Gemini — primary for `vision-classify` and `text-generate`                  */
/* ========================================================================== */

/**
 * **V6.** `gemini-3.8-flash` is a current *stable* Flash model and is the model in the
 * official image-understanding examples, so one identifier serves both capabilities.
 * Documented stable alternate: `gemini-3.6-flash`. V6 instructs against pinning any
 * `-preview` id, which is why none appears here.
 */
export const GEMINI_MODEL = 'gemini-3.8-flash';

/**
 * **V6.** The current GA surface is the Interactions API (`client.interactions.create`);
 * `generateContent` still works but is documented as legacy. Recorded so a reader can tell
 * which of the two SDK surfaces `src/lib/gemini.ts` is written against.
 */
export const GEMINI_API_SURFACE = 'interactions' as const;

/**
 * **V7.** Structured-output configuration, set on the REQUEST rather than trusted to the
 * prompt (design: *Constrained vision classification*, "The prompt is a request; the schema
 * is the enforcement").
 *
 * `thinkingLevel: 'minimal'` carries two jobs at once and is not a performance tweak:
 *  - **Latency.** V6 records that Gemini 3.x has thinking enabled by default, which is why
 *    `vision-classify` gets the largest per-attempt ceiling in the budget table.
 *  - **Determinism, for D7.** U-V7 could not confirm that `temperature` is accepted on the
 *    Interactions API `generation_config` — two official pages say it is, the reference
 *    field list omits it. So D7's channel-parity argument does not rest on temperature
 *    alone: `thinking_level: 'minimal'` plus a fixed `seed` are the documented levers, and
 *    `GEMINI_TEMPERATURE` below is applied only if the pinned SDK's types accept it.
 */
export const GEMINI_GENERATION = {
  /** Lowest documented value. Applied only where the SDK accepts it — see U-V7. */
  temperature: 0,
  /** V7: `minimal` | `low` | `medium` | `high`. */
  thinkingLevel: 'minimal',
  /** V7: fixed seed, for reproducibility across two runs of the same image (D7). */
  seed: 7,
  /** Classification output is one small JSON object; a rephrase is 4–6 short sentences. */
  maxOutputTokensClassify: 256,
  maxOutputTokensGenerate: 1024,
  /** V7: JSON output is requested with this MIME type on `response_format`. */
  jsonMimeType: 'application/json',
} as const;

/* ========================================================================== */
/* Groq — text fallback, conditional vision fallback, and transcription        */
/* ========================================================================== */

/**
 * **V8.** The model in Groq's official JS quickstart. Documented alternate:
 * `openai/gpt-oss-120b`. V8 records that `llama-3.1-8b-instant` and
 * `llama-3.3-70b-versatile` are Enterprise / Contact Sales with no published price or rate
 * limit, so neither is viable for a zero-cost deployment.
 */
export const GROQ_TEXT_MODEL = 'openai/gpt-oss-20b';

/**
 * **V9 — the single value that decides whether `vision-classify` has a fallback at all.**
 *
 * V9 resolved YES: Groq hosts vision-capable models taking an OpenAI-style `image_url`
 * content part. So this is the Qwen identifier rather than `null`, and
 * `providersFor('vision-classify')` returns a two-member chain.
 *
 * **Set this to `null` when the preview model is withdrawn.** V9 records both candidates as
 * *Preview* models — "intended for evaluation purposes only… may be discontinued at short
 * notice" — so withdrawal is expected, not hypothetical. Setting it to `null` is the whole
 * change: the gateway returns a one-member chain, and Requirement 14.8's single
 * exhausted-chain branch means the farmer-visible behaviour is the same busy message it
 * already is when both members fail. No other call site moves. `qwen/qwen3.6-27b` is the
 * documented alternate behind this same constant.
 *
 * The type is `string | null` rather than `string` on purpose: the `null` case has to stay
 * expressible so the withdrawal edit cannot be blocked by a type error.
 */
export const VISION_FALLBACK_MODEL: string | null = 'qwen/qwen3.8-27b';

/**
 * **V9.** Groq's JSON mode is a plain JSON-object mode, NOT a schema-enforced mode like
 * Gemini's. Consequence, recorded in `PROVIDER_CAPABILITIES.md` section 1: during a Gemini
 * outage the vision path loses schema enforcement and D2's stage-1 shape validation carries
 * the whole load, so the expected effect is a higher inconclusive rate rather than a wave of
 * errors.
 */
export const GROQ_JSON_RESPONSE_FORMAT = { type: 'json_object' } as const;

/**
 * **V8.** Groq is OpenAI-compatible but the output-token parameter is
 * `max_completion_tokens`, **not** `max_tokens`. Recorded because the wrong one is silently
 * ignored rather than rejected.
 */
export const GROQ_MAX_COMPLETION_TOKENS_PARAM = 'max_completion_tokens' as const;

/**
 * **V9.** A request containing an image URL is capped at 20 MB; above it the provider returns
 * 400. Checked in `src/lib/groq.ts` BEFORE the call, because an oversized request spends a
 * provider call to learn a fact Jamee already had.
 *
 * Jamee's own 10 MB image ceiling (`MAX_IMAGE_BYTES`) keeps a compliant request under this
 * even as a base64 data URI (10 MB → ~13.4 MB encoded), so the guard is defence rather than a
 * routine path. `PROVIDER_CAPABILITIES.md` section 2 is why it must not become a fallback
 * trigger: a second provider fails on the same bytes.
 */
export const GROQ_VISION_MAX_REQUEST_BYTES = 20 * 1024 * 1024;

/**
 * **V9.** Each image counts as 2048 INPUT tokens against the 131K context. Not a request-size
 * limit and not enforceable client-side — recorded because it is the number that makes "one
 * image per request" the right shape for Jamee: the per-request image cap differs between the
 * two candidate models (3 on `qwen/qwen3.8-27b`, 5 on `qwen/qwen3.6-27b`), and sending exactly
 * one image is inside both and costs one unit of this.
 */
export const GROQ_VISION_IMAGE_INPUT_TOKENS = 2048;

/* -------------------------------------------------------------------------- */
/* Transcription (V10)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * **V10.** Host is Groq. `whisper-large-v3-turbo` supports transcription only, not
 * translation — which is the capability Jamee needs, because it transcribes and then answers
 * in the farmer's language through `text-generate`. Documented alternate:
 * `whisper-large-v3`. Note the alternate is NOT a fallback: same host, so a Groq outage takes
 * both out. `transcribe` has no cross-provider member by design.
 */
export const GROQ_TRANSCRIBE_MODEL = 'whisper-large-v3-turbo';

/** **V10.** `client.audio.transcriptions.create` posts here. */
export const GROQ_TRANSCRIBE_ENDPOINT =
  'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * **V10.** Containers the provider accepts. Checked before upload, and cross-checked against
 * whatever `MediaRecorder` actually produced (V20 leaves the recorded container unresolved,
 * so the recorder probes and reports rather than assuming).
 */
export const TRANSCRIBE_ACCEPTED_CONTAINERS = [
  'flac',
  'mp3',
  'mp4',
  'mpeg',
  'mpga',
  'm4a',
  'ogg',
  'wav',
  'webm',
] as const;

/**
 * **V10.** 25 MB on the free tier (100 MB on dev). Jamee's own 10 MB recording ceiling
 * (Requirement 8.2) sits well below it, so this is a guard against a WhatsApp-sourced audio
 * object rather than a browser recording — V14 caps inbound WhatsApp audio at 16 MB, which
 * is under 25 MB but over Jamee's 10 MB.
 */
export const TRANSCRIBE_PROVIDER_MAX_BYTES = 25 * 1024 * 1024;

/**
 * **V10.** Minimum audio length 0.01 s; minimum *billed* length 10 s. The billing floor is
 * recorded because it means 120 short recordings cost the same as 120 ten-second ones, which
 * is the arithmetic the free-tier sizing note uses.
 *
 * **No maximum duration is documented (U-V10).** Jamee's 120 s cap is its own product rule
 * (Requirement 8.2) and must never be presented to a farmer as a provider limit.
 */
export const TRANSCRIBE_MIN_SECONDS = 0.01;
export const TRANSCRIBE_MIN_BILLED_SECONDS = 10;

/**
 * **V10.** `verbose_json` additionally returns `avg_logprob`, `no_speech_prob` and
 * `compression_ratio`. Requested because `no_speech_prob` is what distinguishes "the farmer
 * recorded silence" from "the provider produced nothing", which is the distinction behind the
 * design's decision to RETAIN a voice object after an empty transcript rather than delete it.
 */
export const TRANSCRIBE_RESPONSE_FORMAT = 'verbose_json' as const;

/* -------------------------------------------------------------------------- */
/* Provider error classification (V11)                                         */
/* -------------------------------------------------------------------------- */

/**
 * **V11.** The gateway classifies on documented status codes and status names ONLY, never on
 * message text — message text is not part of any provider's documented contract.
 *
 * The two Groq input-validation codes are deliberately absent from both lists and therefore
 * fall through to `OTHER`, which does not trigger a fallback:
 *  - **413** Request Entity Too Large is Jamee's own oversized payload. Retrying it on a
 *    second provider fails identically and spends a call to learn nothing.
 *  - **422** Unprocessable Entity is documented to include model hallucinations, making it an
 *    *output* problem. Jamee already has a path for that, and it is not the fallback path:
 *    D2's two-stage validation collapses it into the single inconclusive shape.
 *
 * Also deliberate: Gemini **408** and **500** are `OTHER` here even though V11 records
 * Gemini's own documented retry set as 429/408/5xx. Widening these lists changes when Jamee
 * doubles provider spend, so it is a change to V11's resolved classifier and belongs in
 * `docs/VERIFIED_VALUES.md` — not in an adapter, and not here without a V-item edit.
 */
export const PROVIDER_RATE_LIMIT_STATUSES: readonly number[] = [429];
export const PROVIDER_UNAVAILABLE_STATUSES: readonly number[] = [500, 502, 503];

/** **V11.** Gemini signals these as status *names* alongside the numeric status. */
export const GEMINI_RATE_LIMIT_STATUS_NAME = 'RESOURCE_EXHAUSTED';
export const GEMINI_UNAVAILABLE_STATUS_NAME = 'UNAVAILABLE';

/**
 * **V11.** Groq sets `retry-after`, in seconds, and only on a 429. Gemini documents no such
 * header (U-V11), so the Gemini adapter uses exponential backoff with jitter and reads this
 * header only if one actually turns up at runtime.
 */
export const RETRY_AFTER_HEADER = 'retry-after';

/* ========================================================================== */
/* Meta WhatsApp Business Cloud API                                            */
/* ========================================================================== */

/**
 * **V12.** Pinned Graph API version.
 *
 * `src/lib/whatsapp.ts` reads the optional `WHATSAPP_API_VERSION` environment variable and
 * falls back to this value — the override is an escape hatch for the case where Meta
 * deprecates this version faster than a code change can ship, not a value an operator is
 * expected to set. The override lives in that server module rather than here so this file
 * stays free of `process.env` and therefore client-importable.
 */
export const WHATSAPP_API_VERSION_PINNED = 'v26.0';

/** **V12/V14/V15.** Base for the media-metadata, media-binary, and send endpoints. */
export function graphApiBase(apiVersion: string = WHATSAPP_API_VERSION_PINNED): string {
  return `https://graph.facebook.com/${apiVersion}`;
}

/**
 * **V13.** Header name, value prefix, and HMAC algorithm for POST verification.
 *
 * The **byte encoding of the digest is UNRESOLVED (U-V13)** — the docs give the header name,
 * the `sha256=` prefix, SHA-256, and the app-secret key, and say to compare "everything after
 * `sha256=`", but never say hex or base64. `src/lib/whatsapp.ts` therefore accepts EITHER
 * encoding by comparing against both candidate digests in constant time, rather than picking
 * one and rejecting every legitimate delivery if the guess is wrong. Once a real signed
 * delivery confirms the encoding, narrow it here and record the observation in V13.
 */
export const META_SIGNATURE_HEADER = 'x-hub-signature-256';
export const META_SIGNATURE_PREFIX = 'sha256=';
export const META_SIGNATURE_ALGORITHM = 'sha256';

/** **V13.** Query parameter names on the webhook GET challenge (Requirements 11.1, 11.2). */
export const META_CHALLENGE_PARAMS = {
  mode: 'hub.mode',
  challenge: 'hub.challenge',
  verifyToken: 'hub.verify_token',
} as const;
export const META_CHALLENGE_SUBSCRIBE_MODE = 'subscribe';

/**
 * **V15.** `text.body` caps at 4096 characters, so the reply formatter must fit inside it.
 * Jamee truncates on a sentence boundary rather than splitting into several messages: a
 * multi-message reply would arrive out of order often enough to be confusing, and the
 * knowledge-base explanation is 4–6 short sentences by prompt design, so truncation is a
 * guard rather than a routine path.
 */
export const WHATSAPP_TEXT_BODY_MAX_CHARS = 4096;

/**
 * **V14.** Inbound media caps Meta enforces before Jamee sees the message. Recorded because
 * they are TIGHTER than Jamee's own 10 MB admission ceiling for images (5 MB) and looser for
 * audio (16 MB), so the WhatsApp path cannot simply reuse the web numbers in both directions.
 * V14 also records that an oversized inbound file arrives as error code 131052 rather than as
 * a message at all.
 */
export const WHATSAPP_INBOUND_MAX_BYTES = {
  image: 5 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
} as const;

/**
 * **V14.** The media URL returned by step 1 is valid for 5 minutes, and the binary fetch in
 * step 2 fails without the `Authorization: Bearer` header. Recorded as a number so the
 * adapter does not cache a media URL across invocations.
 */
export const WHATSAPP_MEDIA_URL_TTL_SECONDS = 300;

/* ========================================================================== */
/* Deployment platform                                                         */
/* ========================================================================== */

/**
 * **V16.** Documented request/response body ceiling, 4.5 MB, over which the platform returns
 * 413 `FUNCTION_PAYLOAD_TOO_LARGE`. This matches the requirements' own assumption exactly, so
 * Requirement 2.7 needs no adjustment.
 *
 * Jamee stays ~200 bytes per request regardless of media size because of D1 — the browser
 * uploads to Storage and posts a reference. This constant is the thing that claim is measured
 * against, not a limit any Jamee code path approaches.
 */
export const REQUEST_BODY_CEILING_BYTES = 4.5 * 1024 * 1024;

/**
 * **V16.** The documented platform maximum on the target plan, 300 s.
 *
 * **THIS IS NOT AN INPUT TO ANY BUDGET.** It is recorded only as the hard ceiling that
 * Jamee's own 60 s stays under. Every soft timeout in Jamee is a fraction of
 * `JAMEE_MAX_DURATION_SECONDS` below, per the Requirements glossary
 * (Serverless_Duration_Ceiling) and `docs/PROVIDER_CAPABILITIES.md` section 3: *"Do not
 * derive the soft budget from 300 s… The routes are capped at 60 s; the platform permits
 * more; Jamee declines to use it."* Taking 75% of 300 s would give a 225 s budget — a number
 * no farmer would wait for, and one that would push provisioned-memory usage past the free
 * allowance.
 */
export const PLATFORM_MAX_DURATION_SECONDS = 300;

/**
 * Jamee's own declared ceiling, exported as `maxDuration` by every route handler that can
 * reach a provider (V17: `export const maxDuration = <number>`, unit seconds, Node.js
 * runtime). V17 records that the default is "set by deployment platform", which is exactly
 * why the export cannot be omitted — without it the effective ceiling is 300 s and invisible
 * in the codebase.
 */
export const JAMEE_MAX_DURATION_SECONDS = 60;

/**
 * **V17.** `runtime = 'edge'` is unsupported from Next.js 16.3, and `runtime` /
 * `preferredRegion` are deprecated on the route segment config. So every Jamee route handler
 * stays on the Node.js runtime — which is also what `waitUntil()` and `getDeadline()` require
 * (V18).
 */
export const ROUTE_RUNTIME = 'nodejs' as const;

/**
 * **V18.** `getDeadline()` from `@vercel/functions` returns the shared invocation deadline as
 * a `Date`. Preferred source for the soft deadline because it reflects what the platform will
 * actually enforce rather than what the codebase believes. `waitUntil()` also exists, and
 * `docs/PROVIDER_CAPABILITIES.md` section 4 re-argued D11 on that finding and kept inline
 * processing — a deferred design converts a visible failure into a silent one.
 */
export const HAS_PLATFORM_DEADLINE_API = true;

/* ========================================================================== */
/* Media admission — Jamee's own product rules, not provider limits            */
/* ========================================================================== */

/**
 * These four are Requirements 2.3, 2.4, 8.2 and 8.3 — Jamee's own rules. They are in this
 * file because the uploader, the recorder, the WhatsApp adapter and the error messages must
 * all quote the SAME numbers, and a farmer-facing message that disagrees with the check that
 * produced it is a defect. They are NOT V-items and carry no V annotation.
 */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 120;

/** Requirement 8.2 asks for a visible countdown; the design starts it at 100 s. */
export const AUDIO_COUNTDOWN_FROM_SECONDS = 100;

export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

/** Requirement 14.1 — Jamee's own daily quotas, shared across channels (14.2). */
export const DAILY_QUOTAS = { image: 20, chat: 50, voice: 20 } as const;

/**
 * Requirement 13.8 — burst allowance per minute, a control distinct from the daily quota and
 * set independently of it (design: *Rate limiting versus daily quota*). Chosen so a farmer
 * cannot loop faster than a human works: an image takes time to photograph, and a chat turn
 * takes time to read.
 */
export const BURST_QUOTAS = { image: 3, chat: 10, voice: 3 } as const;

export type Operation = keyof typeof DAILY_QUOTAS;
