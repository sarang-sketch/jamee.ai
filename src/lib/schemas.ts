import { z } from 'zod';

import {
  ACCEPTED_IMAGE_TYPES,
  MAX_AUDIO_SECONDS,
  STORAGE_BUCKETS,
} from '@/lib/config/verified';

/**
 * The single source of contracts. Every Zod schema in Jamee lives here, and every domain type
 * is INFERRED from a schema rather than hand-declared alongside one.
 *
 * Requirements: 4.1, 5.1–5.6, 6.4, 6.5, 9.1
 * Design: "Data models and contracts", D2 (two-stage validation), D3 (one inconclusive shape);
 *         "Object path convention"
 *
 * Why one file. A type declared next to a schema drifts from it silently — the schema gains a
 * field, the type does not, and the compiler is satisfied because both still typecheck. Every
 * `export type X = z.infer<typeof xSchema>` below makes that impossible. This is the same
 * discipline as `verified.ts` applied to shapes instead of values.
 *
 * This module imports only `config/verified.ts`, so it stays importable from both client and
 * server code.
 */

/* ========================================================================== */
/* Shared enums — declared once, reused by types, schemas, and SQL             */
/* ========================================================================== */

/**
 * Requirement 4.1 — the knowledge base holds EXACTLY these five conditions.
 *
 * This is the safety gate, and it is replicated in exactly two other places, both SQL check
 * constraints: `disease_knowledge.disease_name` in `0004_disease_knowledge.sql` and
 * `diagnoses.disease_name` in `0005_diagnoses.sql`. All three lists must stay
 * character-for-character identical, capitalisation included. A divergence is not a style
 * problem — it surfaces as an insert failure or a knowledge-base lookup miss, i.e. as a
 * farmer receiving an inconclusive result for a condition Jamee actually knows.
 *
 * `as const` is load-bearing twice over: it gives `z.enum` a literal union rather than
 * `string[]`, and it makes the tuple length checkable, which is how the unit test asserts
 * "exactly five" rather than "at least the five I remembered".
 */
export const VERIFIED_CONDITIONS = [
  'Tomato Early Blight',
  'Tomato Late Blight',
  'Tomato Healthy',
  'Potato Early Blight',
  'Potato Late Blight',
] as const;

export const verifiedConditionSchema = z.enum(VERIFIED_CONDITIONS);
export const severitySchema = z.enum(['none', 'low', 'moderate', 'high']);
export const languageSchema = z.enum(['en', 'hi', 'mr']);
export const channelSchema = z.enum(['web', 'whatsapp']);

export type VerifiedCondition = z.infer<typeof verifiedConditionSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type Language = z.infer<typeof languageSchema>;
export type Channel = z.infer<typeof channelSchema>;

/** Requirement 9.1's three codes, as a plain array for `details.supportedLanguages`. */
export const SUPPORTED_LANGUAGES = languageSchema.options;

/** `Tomato Healthy` is referenced by name in three rules; naming it avoids typos. */
export const HEALTHY_CONDITION: VerifiedCondition = 'Tomato Healthy';

/* -------------------------------------------------------------------------- */
/* Persistence-adjacent enums                                                  */
/* -------------------------------------------------------------------------- */

export const messageRoleSchema = z.enum(['farmer', 'jamee']);
export const inputKindSchema = z.enum(['text', 'voice', 'image']);
export const operationSchema = z.enum(['image', 'chat', 'voice']);
export const modelProviderSchema = z.enum(['gemini', 'groq']);
export const windowKindSchema = z.enum(['day', 'minute']);

/**
 * `usage_logs.outcome` — mirrors the check constraint in `0006_usage_logs.sql`, as amended by
 * `0011_usage_logs_audit_vocabulary.sql`.
 *
 * `rate_limited` is the value 0011 added, and it exists because the glossary defines a Usage_Log as
 * a row recording "one billable **or rate-limited** operation". Before it, a Requirement 13.8 burst
 * refusal had no honest outcome to be written with: `quota_declined` is Requirement 14.3's *daily*
 * decline, and writing it for a burst refusal would make the audit claim a farmer hit their daily
 * limit when they did not — the one question that column exists to answer.
 */
export const usageOutcomeSchema = z.enum([
  'success',
  'inconclusive',
  'validation_rejected',
  'provider_error',
  'timeout',
  'quota_declined',
  'rate_limited',
  'duplicate_ignored',
]);

/** `whatsapp_inbound.status` — mirrors `0008_whatsapp_inbound.sql`. */
export const whatsappInboundStatusSchema = z.enum([
  'received',
  'processed',
  'failed',
  'rejected',
]);

export type MessageRole = z.infer<typeof messageRoleSchema>;
export type InputKind = z.infer<typeof inputKindSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type WindowKind = z.infer<typeof windowKindSchema>;
export type UsageOutcome = z.infer<typeof usageOutcomeSchema>;
export type WhatsappInboundStatus = z.infer<typeof whatsappInboundStatusSchema>;

/* ========================================================================== */
/* Vision model output — two stages (D2)                                       */
/* ========================================================================== */

/**
 * **Stage 1: shape only.**
 *
 * `disease_name` stays a FREE STRING here, which is the entire point of splitting validation
 * in two (D2). A single strict enum schema would report the same "parse failed" for a
 * malformed JSON blob and for a real-but-unsupported disease, and Requirement 6.1 needs to
 * know specifically that the rejection was an out-of-knowledge-base name so it can log a
 * distinguishable `rejection_reason` (Requirement 5.7).
 *
 * Ranges are enforced here rather than trusted to the provider: Requirement 5.4's confidence
 * interval is CLOSED at both ends, so `0` and `1` are valid and `-0.1` and `1.1` are not.
 * V7 records that Gemini's structured output is syntactically valid JSON but semantically
 * unvalidated — the schema, not the response format, is the enforcement.
 */
export const visionRawSchema = z.object({
  status: z.enum(['identified', 'unclear', 'no_plant']),
  disease_name: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  severity: severitySchema,
});
export type VisionRaw = z.infer<typeof visionRawSchema>;

/**
 * **Stage 2: knowledge-base membership.** This is the safety gate.
 *
 * Run only when stage 1 passed AND `status === 'identified'`. A failure here means the model
 * named something real and well-formed that Jamee has no verified content for — e.g.
 * `{"status":"identified","disease_name":"Wheat Rust","confidence":0.88,"severity":"high"}`.
 * The service maps that single failure path to `rejection_reason: 'unverified_condition'`,
 * discards the model's name AND its confidence entirely (Requirement 6.5), and returns the one
 * inconclusive shape. No second model call is made (Requirement 6.6, D4).
 */
export const visionVerifiedSchema = visionRawSchema.extend({
  status: z.literal('identified'),
  disease_name: verifiedConditionSchema,
});
export type VisionVerified = z.infer<typeof visionVerifiedSchema>;

/**
 * Why a diagnosis was not identified. Every value maps to exactly one acceptance criterion,
 * which is what makes Requirement 5.7's audit trail attributable rather than decorative.
 *
 * The first four are schema failures (Requirements 5.2–5.5), the fifth is the safety gate
 * (5.6 → 6.1), and the last two are the model reporting honestly rather than failing
 * (6.2, 6.3). All seven produce the SAME farmer-facing shape (D3) and differ only in which
 * static localized sentence is attached and which reason is logged.
 */
export const REJECTION_REASONS = [
  'not_json', //                 5.2 — response was not parseable JSON
  'missing_field', //            5.3 — a required field of the diagnosis schema was absent
  'confidence_out_of_range', //  5.4 — confidence outside the closed interval [0, 1]
  'invalid_severity', //         5.5 — severity outside the four defined values
  'unverified_condition', //     5.6 → 6.1 — a name outside the five verified conditions
  'model_unclear', //            6.2 — the model reported the image too unclear to judge
  'model_no_plant', //           6.3 — the model reported no plant in the image
] as const;

export const rejectionReasonSchema = z.enum(REJECTION_REASONS);
export type RejectionReason = z.infer<typeof rejectionReasonSchema>;

/**
 * `usage_logs.rejection_reason` — the seven vision-stage reasons **plus the audit-only ones**.
 *
 * A superset of `RejectionReason` rather than the same vocabulary, and the split is load-bearing in
 * two directions:
 *
 *  - **Every `RejectionReason` is farmer-facing.** `MessageCatalog.inconclusive` is
 *    `Record<RejectionReason, string>`, an exhaustive mapped type, so a value added there must have
 *    a real localized sentence in `en`, `hi` and `mr`. That is correct for the seven: each is a
 *    reason a *diagnosis* came back inconclusive, and the farmer reads copy chosen by it.
 *  - **`rephrase_rejected` reaches no farmer.** `validateRephrased()`'s post-generation checks
 *    refusing the model's prose is answered by serving the knowledge-base static template — the
 *    farmer gets grounded content, not an inconclusive result — so there is no sentence to
 *    translate. What Requirement 5.7 still wants is the *reason* on the audit row, and this is it.
 *
 * Widening `rejectionReasonSchema` instead would have forced three catalog entries for copy no
 * farmer can ever read. Mirrors the check constraint as amended by
 * `0011_usage_logs_audit_vocabulary.sql`.
 */
export const USAGE_REJECTION_REASONS = [
  ...REJECTION_REASONS,
  /** 5.7 — the model answered and the post-generation checks refused its prose (chat and rephrase). */
  'rephrase_rejected',
] as const;

export const usageRejectionReasonSchema = z.enum(USAGE_REJECTION_REASONS);
export type UsageRejectionReason = z.infer<typeof usageRejectionReasonSchema>;

/* ========================================================================== */
/* Diagnosis result — a discriminated union with ONE inconclusive shape         */
/* ========================================================================== */

/** The knowledge-base payload, present only on an identified result. */
export const knowledgePayloadSchema = z.object({
  symptoms: z.array(z.string()),
  causes: z.array(z.string()),
  /** Empty for `Tomato Healthy`, by seed AND by the `healthy_has_no_treatment` constraint. */
  treatment: z.array(z.string()),
  prevention: z.array(z.string()),
  source: z.string(),
});
export type KnowledgePayload = z.infer<typeof knowledgePayloadSchema>;

export const identifiedResultSchema = z.object({
  status: z.literal('identified'),
  /** Canonical, Latin script, never translated (Requirements 4.6, 9.4). */
  diseaseName: verifiedConditionSchema,
  confidence: z.number().min(0).max(1),
  severity: severitySchema,
  /** Knowledge-base grounded and localized (Requirement 3.2). */
  explanation: z.string().min(1),
  knowledge: knowledgePayloadSchema,
  needsExpert: z.literal(false),
  language: languageSchema,
});

/**
 * Requirement 6.4's single inconclusive shape, reached by all seven rejection reasons.
 *
 * Every field that could carry a guess is pinned to a literal, and that is what enforces
 * Requirement 6.5 at the type level rather than by convention:
 *  - `diseaseName: null` and `confidence: null` — the rejected model's name and confidence are
 *    discarded, not carried through in a weaker form.
 *  - `knowledge: null` — because this is `null` rather than an empty payload, **TypeScript
 *    makes it impossible to render treatment text for an inconclusive result**. The compiler
 *    enforces 6.5 at the UI layer, and the `diagnoses_unknown_shape` check constraint enforces
 *    the same thing at the database layer. Two independent boundaries, neither relying on a
 *    developer remembering.
 *  - `severity: 'none'` and `needsExpert: true` — Requirement 6.4's stated shape.
 *
 * `explanation` is still `min(1)`: an inconclusive result is not a silent one. It carries
 * static localized copy from the message catalogs (D5), never a model call (6.6).
 */
export const inconclusiveResultSchema = z.object({
  status: z.literal('unknown'),
  diseaseName: z.null(),
  confidence: z.null(),
  severity: z.literal('none'),
  explanation: z.string().min(1),
  knowledge: z.null(),
  needsExpert: z.literal(true),
  language: languageSchema,
});

export const diagnosisResultSchema = z.discriminatedUnion('status', [
  identifiedResultSchema,
  inconclusiveResultSchema,
]);

export type IdentifiedResult = z.infer<typeof identifiedResultSchema>;
export type InconclusiveResult = z.infer<typeof inconclusiveResultSchema>;
export type DiagnosisResult = z.infer<typeof diagnosisResultSchema>;

/* ========================================================================== */
/* Storage references                                                          */
/* ========================================================================== */

/**
 * `{user_id}/{YYYY}/{MM}/{uuid}.{ext}` — the object path convention both channels share.
 *
 * **The regex enforces SHAPE ONLY. It does not prove ownership.** Ownership is a runtime
 * comparison of the first path segment against the session user id, plus an object-exists
 * probe, and it runs before any quota reserve (Requirements 2.5, 2.6; Property 5). Treating
 * this schema as an authorization check would be the classic mistake: the shape is
 * client-supplied.
 *
 * **The single-dot rule is deliberate and must not be relaxed.** `[a-z0-9]{2,5}` after exactly
 * one `\.` means a path containing the `.thumb` infix FAILS this schema. Two consequences,
 * both wanted:
 *  - a client cannot submit a Thumbnail_Derivative as the object to diagnose, and
 *  - a client cannot submit a fabricated derived path at all.
 *
 * A thumbnail path is only ever computed server-side by `thumbPathFor()` in
 * `src/lib/storage.ts`, from an original path that has already passed this schema AND the
 * ownership check. Widening the regex to "accommodate thumbnails" would remove both
 * protections to solve a problem that does not exist.
 *
 * The uuid character classes are `[0-9a-f-]{36}` rather than a strict UUID grammar, matching
 * the design verbatim. That is intentionally permissive about dash placement: `auth.users.id`
 * is a real uuid, so a stricter pattern would gain nothing while adding a way for a
 * legitimate path to be rejected.
 */
export const STORAGE_PATH_REGEX =
  /^[0-9a-f-]{36}\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

export const storageRefSchema = z.object({
  bucket: z.enum([STORAGE_BUCKETS.cropImages, STORAGE_BUCKETS.voiceMessages]),
  path: z
    .string()
    .min(1)
    .max(512)
    .regex(STORAGE_PATH_REGEX, 'path must be {user_id}/{YYYY}/{MM}/{uuid}.{ext}'),
});
export type StorageRef = z.infer<typeof storageRefSchema>;

/* ========================================================================== */
/* Quota status, echoed on every successful response                            */
/* ========================================================================== */

export const quotaStatusSchema = z.object({
  operation: operationSchema,
  used: z.int().nonnegative(),
  limit: z.int().positive(),
  /** Next Asia/Kolkata midnight, ISO-8601 (Requirement 14.3). */
  resetsAt: z.iso.datetime(),
});
export type QuotaStatus = z.infer<typeof quotaStatusSchema>;

/* ========================================================================== */
/* API request and response contracts                                          */
/* ========================================================================== */

/**
 * `POST /api/diagnose` — JSON, not multipart (D1).
 *
 * Requirement 2.2 mandates a JSON body carrying a storage reference; Requirement 2.3 allows
 * images up to 10 MB; Requirement 2.7 requires bodies under the 4.5 MB platform ceiling (V16).
 * A multipart upload of a 10 MB image cannot satisfy all three. So the browser uploads
 * directly to Storage and posts a reference, and the request body stays ~200 bytes regardless
 * of image size — which is what makes the 10 MB allowance real rather than nominal.
 *
 * `conversationId` is optional here and required on chat and voice: Requirement 2.2 permits a
 * diagnosis with no conversation, and Requirement 7.5 then requires the API to create one and
 * attach the diagnosis to it.
 */
export const diagnoseRequestSchema = z.object({
  image: storageRefSchema.refine((r) => r.bucket === STORAGE_BUCKETS.cropImages, {
    error: `image reference must name the ${STORAGE_BUCKETS.cropImages} bucket`,
  }),
  language: languageSchema,
  conversationId: z.uuid().optional(),
});
export type DiagnoseRequest = z.infer<typeof diagnoseRequestSchema>;

export const diagnoseResponseSchema = z.object({
  diagnosisId: z.uuid(),
  conversationId: z.uuid(),
  result: diagnosisResultSchema,
  quota: quotaStatusSchema,
});
export type DiagnoseResponse = z.infer<typeof diagnoseResponseSchema>;

/** The answer payload, shared by `/api/chat` and `/api/voice` so the two cannot drift. */
export const chatAnswerSchema = z.object({
  messageId: z.uuid(),
  content: z.string().min(1),
  language: languageSchema,
  /** Which knowledge-base rows fed this answer. Empty for an out-of-scope referral. */
  groundedIn: z.array(verifiedConditionSchema),
  /** True for an out-of-scope or unanswerable question (Requirements 4.7, 7.6). */
  needsExpert: z.boolean(),
});
export type ChatAnswer = z.infer<typeof chatAnswerSchema>;

/**
 * `POST /api/chat`.
 *
 * `conversationId` is REQUIRED: Requirements 7.1 and 7.2 key Conversation_Context on the
 * conversation identifier, and a chat turn with no conversation has no context to resolve a
 * subject-less follow-up against.
 */
export const chatRequestSchema = z.object({
  conversationId: z.uuid(),
  message: z.string().min(1).max(1000),
  language: languageSchema,
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const chatResponseSchema = z.object({
  conversationId: z.uuid(),
  farmerMessageId: z.uuid(),
  answer: chatAnswerSchema,
  quota: quotaStatusSchema,
});
export type ChatResponse = z.infer<typeof chatResponseSchema>;

/**
 * `POST /api/voice`.
 *
 * `durationSeconds` is measured by the browser and **re-checked server-side** against
 * Requirement 8.2's 120 s. Client-side enforcement alone would be a client-side check on a
 * server-side spend rule: the recorder stops at 120 s, but a hand-built request need not.
 */
export const voiceRequestSchema = z.object({
  audio: storageRefSchema.refine((r) => r.bucket === STORAGE_BUCKETS.voiceMessages, {
    error: `audio reference must name the ${STORAGE_BUCKETS.voiceMessages} bucket`,
  }),
  language: languageSchema,
  conversationId: z.uuid(),
  durationSeconds: z.number().positive().max(MAX_AUDIO_SECONDS),
  /**
   * The container `MediaRecorder` actually selected, read back from `MediaRecorder.mimeType`.
   *
   * Sent rather than assumed because **U-V20** leaves the recorded container unresolved on the
   * target Android browsers. The transcription adapter validates it against V10's accepted
   * list, so an unexpected container produces a named error instead of a provider rejection.
   */
  mimeType: z.string().min(1).max(128).optional(),
});
export type VoiceRequest = z.infer<typeof voiceRequestSchema>;

export const voiceResponseSchema = z.object({
  /** Requirement 8.6 — the transcript AND the answer are both returned. */
  transcript: z.string(),
  answer: chatAnswerSchema,
  conversationId: z.uuid(),
  quota: quotaStatusSchema,
});
export type VoiceResponse = z.infer<typeof voiceResponseSchema>;

/* ========================================================================== */
/* Localized error envelope (Requirement 15.3)                                 */
/* ========================================================================== */

/**
 * Every non-2xx response from the API layer uses this one shape.
 *
 * `details` is deliberately STRUCTURED rather than baked into the message string, so a client
 * can render a localized sentence AND a precise number without parsing prose — and so a
 * translation can put the number wherever that language puts it.
 *
 * No stack trace, provider payload, or model text ever enters this envelope
 * (Requirement 15.6). `withErrorHandling` in `src/lib/errors.ts` is what enforces that: it
 * logs the real cause server-side and emits `INTERNAL_ERROR` outward.
 *
 * `Inconclusive_Result` is deliberately NOT an error. An inconclusive diagnosis is a
 * successful 200 carrying `status: 'unknown'` — the request worked, the photo could not be
 * judged. Modelling it as an error would break Requirement 6.4's single-shape rule and
 * Requirement 6.7's quota rule at the same time.
 */
export const errorDetailsSchema = z.object({
  limit: z.int().optional(),
  used: z.int().optional(),
  resetsAt: z.iso.datetime().optional(),
  supportedLanguages: z.array(z.string()).optional(),
  acceptedTypes: z.array(z.string()).optional(),
  maxBytes: z.int().optional(),
  maxSeconds: z.int().optional(),
  retryAfterSeconds: z.int().optional(),
});
export type ErrorDetails = z.infer<typeof errorDetailsSchema>;

/**
 * Every stable error code in the taxonomy.
 *
 * It lives HERE rather than in `src/lib/errors.ts` to break what would otherwise be a cycle:
 * the message catalogs need the code list to be exhaustive over it, and `errors.ts` needs the
 * catalogs to render a message. With the list in the contracts module, both depend on this and
 * neither depends on the other.
 *
 * `errors.ts` owns what each code MEANS — its HTTP status, its retryable flag, its details
 * shape. `messages/{en,hi,mr}.ts` own what each code SAYS. This array owns only the fact that
 * the code exists, which is the part both need.
 */
export const ERROR_CODES = [
  'AUTH_REQUIRED', //               401  1.7
  /**
   * 401 1.3 (retryable) — Google sign-in did not complete.
   *
   * Amendment A1 replaced phone OTP with `signInWithOAuth({ provider: 'google' })`, so the old
   * `OTP_INVALID` retired with the SMS path. This ONE code covers a cancelled authorization, a
   * provider error, and a callback that returned nothing exchangeable, because the farmer's next
   * action is identical in all three — sign in again — and distinguishing them would only
   * describe Google's internals. Retryable because that next action is a retry.
   */
  'OAUTH_INCOMPLETE', //            401  1.3
  'LANGUAGE_UNSUPPORTED', //        400  9.5
  /**
   * 400 7.1, 15.3 — the request body does not carry a usable Farmer message.
   *
   * The text counterpart of `STORAGE_REF_INVALID`, added because that code was standing in for it
   * on `/api/chat`: its sentence is "That photo could not be found. Please upload it again.", which
   * names a photo an endpoint that takes a typed question never received. The status and the
   * retryable flag were already right; only the sentence was wrong, and a wrong sentence is the
   * part a farmer reads (Requirement 15.3).
   *
   * Covers an absent, empty or over-long `message` and a body that is not JSON at all. It does NOT
   * cover a malformed *storage reference* — on `/api/voice` the body's substance IS the reference,
   * so `STORAGE_REF_INVALID` stays accurate there.
   */
  'MESSAGE_INVALID', //             400  7.1, 15.3
  'STORAGE_REF_INVALID', //         400  2.2
  'STORAGE_REF_FORBIDDEN', //       403  2.6  — quota untouched
  'FILE_TYPE_UNSUPPORTED', //       400  2.4
  'FILE_TOO_LARGE', //              400  2.4, 8.3
  'AUDIO_TOO_LONG', //              400  8.3
  /**
   * 400 8.4, 10.6 — the recording's CONTAINER is outside V10's accepted list.
   *
   * The audio counterpart of `FILE_TYPE_UNSUPPORTED`, added because the alternative was
   * `TRANSCRIPTION_FAILED`, which is `retryable: true`: re-sending the identical bytes in the
   * identical container fails identically forever, so that flag was a lie every time it was
   * reached. WhatsApp is what makes the case routine rather than theoretical — V14 has Meta
   * delivering `audio/aac` and `audio/amr`, and neither is in V10's list, and the farmer does not
   * choose what WhatsApp records in.
   */
  'AUDIO_FORMAT_UNSUPPORTED', //    400  8.4, 10.6
  'RATE_LIMITED', //                429  13.8
  'QUOTA_EXCEEDED', //              429  14.3
  'TRANSCRIPT_EMPTY', //            422  8.7
  'TRANSCRIPTION_FAILED', //        502  8.4
  'PROVIDERS_UNAVAILABLE', //       503  14.5, 14.8, D6
  'DIAGNOSIS_TIMEOUT', //           504  3.7
  /**
   * 401 15.4, 22.6 (D15) — the payment webhook's raw-body signature did not verify, or the
   * signing secret is unconfigured. An unconfigured secret falls into THIS branch on purpose:
   * a deployment that forgot the variable must not become one where anyone can grant an
   * entitlement by POSTing a body. Not retryable and the body carries no content — the caller
   * is a payment provider reading a status, not a farmer reading prose.
   */
  'WEBHOOK_SIGNATURE_INVALID', //   401  11.4, 22.6
  /**
   * 401 11.3, 11.4 (D12) — the Telegram webhook's `X-Telegram-Bot-Api-Secret-Token` header was
   * absent or did not match the configured token, compared in constant time before the body is
   * parsed. An unconfigured token is a FAILED verification here for the same reason as above.
   * Replaces the retired `WEBHOOK_VERIFY_TOKEN_INVALID`: Telegram has no GET verification
   * handshake, so there is no verify-token challenge to model — registration is an outbound
   * `setWebhook` call Jamee makes once.
   */
  'WEBHOOK_SECRET_TOKEN_INVALID', // 401 11.3, 11.4
  /**
   * 502 22.1 (retryable) — creating a Payment_Order with the provider failed. Its message never
   * carries the provider's error text (D15): a provider payload in a farmer-facing message is a
   * leak, and the farmer's action is the same whatever the provider said — try the payment
   * again.
   */
  'PAYMENT_ORDER_FAILED', //        502  22.1
  'CONVERSATION_NOT_FOUND', //      404  — a conversation id that is not this farmer's
  'DIAGNOSIS_NOT_FOUND', //         404  — a diagnosis id that is not this farmer's
  'SWEEP_UNAUTHORIZED', //          401  18.12
  'INTERNAL_ERROR', //              500  15.6
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    /** Stable and machine-readable; the client keys its retry action off this. */
    code: errorCodeSchema,
    /** Localized and farmer-readable. */
    message: z.string().min(1),
    language: languageSchema,
    /** Drives the retry action (Requirement 15.4). Accurate, not optimistic. */
    retryable: z.boolean(),
    details: errorDetailsSchema.optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/* ========================================================================== */
/* Client-side media admission (Requirements 2.3, 2.4, 8.2, 8.3)               */
/* ========================================================================== */

/**
 * Requirement 2.9 is explicit that 2.3 and 2.4 are evaluated against **the file the farmer
 * selects, before any re-encoding**. So this schema describes the SELECTED file, and the
 * re-encode in `ImageUploader` happens only after it passes.
 *
 * Kept as a schema rather than an `if` so Property 3 can drive it over generated
 * (type, size) pairs and assert the boundary is exactly 10 MB inclusive.
 */
export const imageCandidateSchema = z.object({
  type: z.enum(ACCEPTED_IMAGE_TYPES),
  bytes: z.int().positive().max(10 * 1024 * 1024),
});

export const audioCandidateSchema = z.object({
  seconds: z.number().positive().max(MAX_AUDIO_SECONDS),
  bytes: z.int().positive().max(10 * 1024 * 1024),
});

/* ========================================================================== */
/* Service interfaces (Requirement 16.5)                                       */
/* ========================================================================== */

/**
 * `channel` is a REQUIRED parameter on all three service inputs, which is what makes
 * Requirement 16.5 structurally true rather than a convention: a caller cannot forget it, and
 * both the route handlers and the WhatsApp adapter pass a literal.
 *
 * These are interfaces rather than schemas because they describe an in-process call, not a
 * wire format. Nothing crosses a trust boundary here — the wire formats above already did the
 * validating.
 */
export interface DiagnoseInput {
  userId: string;
  storageRef: StorageRef;
  language: Language;
  channel: Channel;
  conversationId?: string;
}

export interface ChatInput {
  userId: string;
  conversationId: string;
  message: string;
  language: Language;
  channel: Channel;
  inputKind?: Exclude<InputKind, 'image'>;
  /**
   * Set by `VoiceService`. When true the ChatService performs **no quota reserve of its own**:
   * the voice unit already reserved covers the answer this request produces, so one voice
   * message never spends both a voice unit and a chat unit (design: *When a unit is reserved*).
   */
  skipQuotaReserve?: boolean;
  /** Storage path of the recording, recorded on the farmer message when `inputKind` is voice. */
  transcriptOf?: string;
}

export interface VoiceInput {
  userId: string;
  storageRef: StorageRef;
  language: Language;
  channel: Channel;
  conversationId: string;
  durationSeconds: number;
  mimeType?: string;
  /**
   * The recording's size in bytes, when the caller knows it — Requirement 8.2's other half.
   *
   * **Not on `voiceRequestSchema`, deliberately.** A byte count in the request body is the
   * client's claim about the object, and the object is the authority on its own size, so
   * `/api/voice` reads it from Storage (`objectSizeOf()`) and passes it here as a measured fact —
   * the same shape `durationSeconds` has, one step more trustworthy. The WhatsApp path has the
   * number for free: V14's media-metadata step returns `file_size` before a byte is fetched.
   *
   * Optional because a probe can legitimately come back empty (see `objectSizeOf()`), and a
   * recording that reached the bucket must not be refused over a metadata read. `VoiceService`
   * skips the size check when it has no number, so absence costs the guard rather than the farmer.
   */
  bytes?: number;
}
