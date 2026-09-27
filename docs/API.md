# Jamee API reference

> **This document is generated against the code and cannot drift.**
> `tests/unit/api-docs.test.ts` binds every table below to a value in `src/lib/schemas.ts`,
> `src/lib/errors.ts`, or `src/lib/config/verified.ts` through the HTML-comment anchors, and fails
> on any divergence in either direction. Edit the code, then run `npm run test:unit` and update the
> tables the test names. The `Type` and `Notes` columns are prose and are not machine-checked; the
> field sets, statuses, flags, enum members, quotas, and constants are.
>
> **Amendment A3.** The backend is MongoDB Atlas with GridFS media, Better Auth (Google sign-in) for
> sessions, and a Data_Access_Layer in place of RLS. There is no WhatsApp channel and no Supabase
> storage path — the second channel is Telegram, and media is addressed by a **Media_Reference**
> (`{ fileId, kind }`), not a storage path.

## Endpoints

Every `route.ts` under `src/app` is listed here. The `Methods` column is the HTTP verbs the module
exports; the `Auth` column is the authentication mechanism, and `session` means the handler is built
from `authenticatedRoute` (a server-confirmed Better Auth session, HTTP 401 with `AUTH_REQUIRED`
otherwise). The two webhook routes and the multipart upload are documented **by their authentication
mechanism** rather than a request schema, because neither webhook body is Jamee's to define and the
upload is `multipart/form-data`.

<!-- routes -->

| Route module | Methods | Auth |
| --- | --- | --- |
| `src/app/api/auth/[...all]/route.ts` | `GET, POST` | `better-auth` |
| `src/app/api/chat/route.ts` | `POST` | `session` |
| `src/app/api/diagnose/route.ts` | `POST` | `session` |
| `src/app/api/internal/retention-sweep/route.ts` | `GET, POST` | `cron-secret` |
| `src/app/api/link/token/route.ts` | `DELETE, POST` | `session` |
| `src/app/api/media/[id]/route.ts` | `GET` | `owner-check` |
| `src/app/api/media/route.ts` | `POST` | `session` |
| `src/app/api/payment/confirm/route.ts` | `POST` | `session` |
| `src/app/api/payment/order/route.ts` | `POST` | `session` |
| `src/app/api/payment/webhook/route.ts` | `POST` | `signature` |
| `src/app/api/profile/access/route.ts` | `GET` | `session` |
| `src/app/api/profile/route.ts` | `POST` | `session` |
| `src/app/api/telegram/route.ts` | `POST` | `secret-token` |
| `src/app/api/voice/route.ts` | `POST` | `session` |

### Endpoint summaries

- **`/api/auth/[...all]`** — Better Auth's own catch-all: `GET`/`POST` serve the Google sign-in
  endpoints the app uses (`sign-in/social`, `callback/google`, `get-session`, `sign-out`). The
  library owns the request and response shapes; Jamee documents only that these are the endpoints it
  drives.
- **`/api/diagnose`** — a Media_Reference to a `crop-image` file plus a language; returns the
  diagnosis result and quota.
- **`/api/chat`** — a typed question in a conversation; returns the grounded answer and quota.
- **`/api/voice`** — a Media_Reference to a `voice` file plus the measured duration; returns the
  transcript, the answer, and quota.
- **`/api/media`** — **multipart upload** (`multipart/form-data`). Authenticated by session; the
  owner is taken from the session, never from client input. Returns a Media_Reference. Documented by
  its authentication mechanism rather than a JSON request schema.
- **`/api/media/[id]`** — owner-checked serve: streams a GridFS file back only after the
  Data_Access_Layer confirms `metadata.ownerId` equals the requesting farmer; a mismatch is
  `STORAGE_REF_FORBIDDEN` (403).
- **`/api/link/token`** — `POST` mints a Telegram link token for the session user; `DELETE` unlinks.
- **`/api/payment/order`** — creates a Razorpay order (amount server-side); returns checkout ids.
- **`/api/payment/confirm`** — the optimistic post-checkout confirmation; grants nothing on its own.
- **`/api/payment/webhook`** — **authenticated by the Razorpay signature over the raw body**
  (`WEBHOOK_SIGNATURE_INVALID`, 401, on a missing/failed/absent-secret verification). Documented by
  its authentication mechanism rather than a request schema — the body is Razorpay's.
- **`/api/telegram`** — **authenticated by the `X-Telegram-Bot-Api-Secret-Token` header**
  (`WEBHOOK_SECRET_TOKEN_INVALID`, 401, compared before the body is parsed). Documented by its
  authentication mechanism rather than a request schema — the body is a Telegram `Update`.
- **`/api/internal/retention-sweep`** — the media retention sweep, `GET` (scheduled) and `POST`
  (manual), behind a constant-time `CRON_SECRET` bearer (`SWEEP_UNAUTHORIZED`, 401).
- **`/api/profile`**, **`/api/profile/access`** — the profile save and the combined link/entitlement
  access state read.

### maxDuration

Every route that declares a segment `maxDuration` sets Jamee's own ceiling (V17), in seconds.

<!-- max-duration -->

| Route module | Seconds |
| --- | --- |
| `src/app/api/chat/route.ts` | `60` |
| `src/app/api/diagnose/route.ts` | `60` |
| `src/app/api/internal/retention-sweep/route.ts` | `60` |
| `src/app/api/media/[id]/route.ts` | `60` |
| `src/app/api/media/route.ts` | `60` |
| `src/app/api/payment/confirm/route.ts` | `60` |
| `src/app/api/payment/webhook/route.ts` | `60` |
| `src/app/api/telegram/route.ts` | `60` |
| `src/app/api/voice/route.ts` | `60` |

## Request and response bodies

Each table lists the fields of a Zod schema in `src/lib/schemas.ts`. `Required` is `no` when the
schema accepts `undefined` for the field, `yes` otherwise.

### Media_Reference — `mediaRefSchema`

The `{ fileId, kind }` pair Jamee's media contract is built on (D17). `fileId` is a GridFS `_id` as
its 24-character lowercase-hex string; `kind` is one of the three media kinds one bucket holds. It
carries no path and no `.thumb` infix, so a client cannot fabricate a derived object.

<!-- fields:mediaRefSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `fileId` | yes | string | 24-char lowercase-hex GridFS ObjectId |
| `kind` | yes | enum | `mediaKindSchema` |

### Quota status — `quotaStatusSchema`

Echoed on every successful diagnose/chat/voice response.

<!-- fields:quotaStatusSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `operation` | yes | enum | `operationSchema` |
| `used` | yes | integer | ≥ 0 |
| `limit` | yes | integer | > 0 |
| `resetsAt` | yes | string | ISO-8601, next Asia/Kolkata midnight |

### Identified result — `identifiedResultSchema`

The `status: 'identified'` branch of the diagnosis discriminated union.

<!-- fields:identifiedResultSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `status` | yes | literal | `'identified'` |
| `diseaseName` | yes | enum | canonical, Latin script, never translated |
| `confidence` | yes | number | 0–1 |
| `severity` | yes | enum | `severitySchema` |
| `explanation` | yes | string | knowledge-base grounded, localized |
| `knowledge` | yes | object | `knowledgePayloadSchema` |
| `needsExpert` | yes | literal | `false` |
| `language` | yes | enum | `languageSchema` |

### Inconclusive result — `inconclusiveResultSchema`

The single `status: 'unknown'` shape all rejection reasons collapse into (Requirement 6.4).

<!-- fields:inconclusiveResultSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `status` | yes | literal | `'unknown'` |
| `diseaseName` | yes | null | the rejected model's name is discarded |
| `confidence` | yes | null | discarded |
| `severity` | yes | literal | `'none'` |
| `explanation` | yes | string | static localized copy, never a model call |
| `knowledge` | yes | null | compiler forbids rendering treatment |
| `needsExpert` | yes | literal | `true` |
| `language` | yes | enum | `languageSchema` |

### Knowledge payload — `knowledgePayloadSchema`

Present only on an identified result.

<!-- fields:knowledgePayloadSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `symptoms` | yes | string[] | |
| `causes` | yes | string[] | |
| `treatment` | yes | string[] | empty for `Tomato Healthy` |
| `prevention` | yes | string[] | |
| `source` | yes | string | extension-service citation |

### Chat answer — `chatAnswerSchema`

Shared by `/api/chat` and `/api/voice`.

<!-- fields:chatAnswerSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `messageId` | yes | string (uuid) | |
| `content` | yes | string | |
| `language` | yes | enum | `languageSchema` |
| `groundedIn` | yes | enum[] | knowledge-base rows that fed the answer |
| `needsExpert` | yes | boolean | true for an out-of-scope referral |

### Error envelope — `errorEnvelopeSchema.error`

Every non-2xx response uses the one `{ error: { … } }` shape. The table documents the fields under
`error`.

<!-- fields:errorEnvelopeSchema.error -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `code` | yes | enum | stable, machine-readable |
| `message` | yes | string | localized |
| `language` | yes | enum | `languageSchema` |
| `retryable` | yes | boolean | drives the retry action |
| `details` | no | object | `errorDetailsSchema` |

### Error details — `errorDetailsSchema`

Structured, so a client renders a localized sentence and a precise number without parsing prose.

<!-- fields:errorDetailsSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `limit` | no | integer | quota limit |
| `used` | no | integer | quota used |
| `resetsAt` | no | string | ISO-8601 reset |
| `supportedLanguages` | no | string[] | on `LANGUAGE_UNSUPPORTED` |
| `acceptedTypes` | no | string[] | on a file-type rejection |
| `maxBytes` | no | integer | on a size rejection |
| `maxSeconds` | no | integer | on a duration rejection |
| `retryAfterSeconds` | no | integer | on a rate-limit |

### `POST /api/diagnose` request — `diagnoseRequestSchema`

Carries a Media_Reference, not a storage path. The body carries no bytes — the analysis reads the
image from GridFS and sends it to the model inline (V34).

<!-- fields:diagnoseRequestSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `image` | yes | object | Media_Reference refined `kind === 'crop-image'` |
| `thumbnail` | no | object | Media_Reference refined `kind === 'thumbnail'` |
| `language` | yes | enum | `languageSchema` |
| `conversationId` | no | string (uuid) | created when absent (Requirement 7.5) |

### `POST /api/diagnose` response — `diagnoseResponseSchema`

<!-- fields:diagnoseResponseSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `diagnosisId` | yes | string (uuid) | |
| `conversationId` | yes | string (uuid) | |
| `result` | yes | object | identified or inconclusive |
| `quota` | yes | object | `quotaStatusSchema` |

### `POST /api/chat` request — `chatRequestSchema`

<!-- fields:chatRequestSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `conversationId` | yes | string (uuid) | required — context is keyed on it |
| `message` | yes | string | 1–1000 chars |
| `language` | yes | enum | `languageSchema` |

### `POST /api/chat` response — `chatResponseSchema`

<!-- fields:chatResponseSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `conversationId` | yes | string (uuid) | |
| `farmerMessageId` | yes | string (uuid) | |
| `answer` | yes | object | `chatAnswerSchema` |
| `quota` | yes | object | `quotaStatusSchema` |

### `POST /api/voice` request — `voiceRequestSchema`

Carries a Media_Reference to a `voice` file (≤ 3 MB under A3). `durationSeconds` is re-checked
server-side against 120 s.

<!-- fields:voiceRequestSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `audio` | yes | object | Media_Reference refined `kind === 'voice'` |
| `language` | yes | enum | `languageSchema` |
| `conversationId` | yes | string (uuid) | |
| `durationSeconds` | yes | number | > 0, ≤ 120 |
| `mimeType` | no | string | the container `MediaRecorder` selected |

### `POST /api/voice` response — `voiceResponseSchema`

<!-- fields:voiceResponseSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `transcript` | yes | string | Requirement 8.6 — transcript AND answer |
| `answer` | yes | object | `chatAnswerSchema` |
| `conversationId` | yes | string (uuid) | |
| `quota` | yes | object | `quotaStatusSchema` |

## Enums

Every permitted value, taken from the schema's `.options`.

<!-- enums -->

| Enum | Members |
| --- | --- |
| `languageSchema` | `en, hi, mr` |
| `severitySchema` | `none, low, moderate, high` |
| `operationSchema` | `image, chat, voice` |
| `verifiedConditionSchema` | `Tomato Early Blight, Tomato Late Blight, Tomato Healthy, Potato Early Blight, Potato Late Blight` |
| `mediaKindSchema` | `crop-image, thumbnail, voice` |
| `channelSchema` | `web, telegram` |

## Verified constants

From `src/lib/config/verified.ts`. Byte and second limits, and the platform/duration ceilings.

<!-- constants -->

| Constant | Value |
| --- | --- |
| `JAMEE_MAX_DURATION_SECONDS` | `60` |
| `PLATFORM_MAX_DURATION_SECONDS` | `300` |
| `REQUEST_BODY_CEILING_BYTES` | `4718592` (4.5 MB) |
| `MAX_IMAGE_BYTES` | `10485760` (10 MB) |
| `MAX_AUDIO_BYTES` | `3145728` (3 MB) |
| `MAX_AUDIO_SECONDS` | `120` |

## Quotas

Daily quotas are per farmer and shared across the web and Telegram channels (Requirement 14.2).
Burst ceilings are per minute and independent of the daily quota (Requirement 13.8).

<!-- quotas -->

| Operation | Daily | Burst/min |
| --- | --- | --- |
| `image` | `20` | `3` |
| `chat` | `50` | `10` |
| `voice` | `20` | `3` |

## Error codes

Every code in the taxonomy, in `ERROR_CODES` order, with the status and retryable flag from
`ERROR_SPECS` in `src/lib/errors.ts` and the requirement it traces to.

<!-- error-specs -->

| Code | Status | Retryable | Requirement |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | `401` | no | `1.7` |
| `OAUTH_INCOMPLETE` | `401` | yes | `1.3` |
| `LANGUAGE_UNSUPPORTED` | `400` | no | `9.5` |
| `MESSAGE_INVALID` | `400` | no | `7.1, 15.3` |
| `STORAGE_REF_INVALID` | `400` | no | `2.2` |
| `STORAGE_REF_FORBIDDEN` | `403` | no | `2.6` |
| `FILE_TYPE_UNSUPPORTED` | `400` | no | `2.4` |
| `FILE_TOO_LARGE` | `400` | no | `2.4, 8.3` |
| `AUDIO_TOO_LONG` | `400` | no | `8.3` |
| `AUDIO_FORMAT_UNSUPPORTED` | `400` | no | `8.4, 10.6` |
| `RATE_LIMITED` | `429` | yes | `13.8` |
| `QUOTA_EXCEEDED` | `429` | no | `14.3` |
| `TRANSCRIPT_EMPTY` | `422` | yes | `8.7` |
| `TRANSCRIPTION_FAILED` | `502` | yes | `8.4` |
| `PROVIDERS_UNAVAILABLE` | `503` | yes | `14.5, 14.8` |
| `DIAGNOSIS_TIMEOUT` | `504` | yes | `3.7` |
| `WEBHOOK_SIGNATURE_INVALID` | `401` | no | `11.4, 22.6` |
| `WEBHOOK_SECRET_TOKEN_INVALID` | `401` | no | `11.3, 11.4` |
| `PAYMENT_ORDER_FAILED` | `502` | yes | `22.1` |
| `CONVERSATION_NOT_FOUND` | `404` | no | `7.1` |
| `DIAGNOSIS_NOT_FOUND` | `404` | no | `12.3` |
| `SWEEP_UNAUTHORIZED` | `401` | no | `18.12` |
| `INTERNAL_ERROR` | `500` | yes | `15.6` |

### Bodiless non-2xx responses

The two webhook routes and the retention sweep answer with a status code and no body. The status is
the taxonomy's, so it cannot drift from `ERROR_SPECS`.

<!-- bodiless -->

| Response | Status | Code |
| --- | --- | --- |
| `POST /api/telegram` without the secret-token header | `401` | `WEBHOOK_SECRET_TOKEN_INVALID` |
| `POST /api/payment/webhook` without a valid signature | `401` | `WEBHOOK_SIGNATURE_INVALID` |
| `GET /api/internal/retention-sweep` without the CRON_SECRET bearer | `401` | `SWEEP_UNAUTHORIZED` |

### Per-endpoint error codes

The codes each endpoint can return, with their status and retryable flag from `ERROR_SPECS`.

<!-- codes:diagnose -->

| Code | Status | Retryable |
| --- | --- | --- |
| `AUTH_REQUIRED` | `401` | no |
| `LANGUAGE_UNSUPPORTED` | `400` | no |
| `STORAGE_REF_INVALID` | `400` | no |
| `STORAGE_REF_FORBIDDEN` | `403` | no |
| `RATE_LIMITED` | `429` | yes |
| `QUOTA_EXCEEDED` | `429` | no |
| `PROVIDERS_UNAVAILABLE` | `503` | yes |
| `DIAGNOSIS_TIMEOUT` | `504` | yes |
| `INTERNAL_ERROR` | `500` | yes |

<!-- codes:chat -->

| Code | Status | Retryable |
| --- | --- | --- |
| `AUTH_REQUIRED` | `401` | no |
| `LANGUAGE_UNSUPPORTED` | `400` | no |
| `MESSAGE_INVALID` | `400` | no |
| `CONVERSATION_NOT_FOUND` | `404` | no |
| `RATE_LIMITED` | `429` | yes |
| `QUOTA_EXCEEDED` | `429` | no |
| `PROVIDERS_UNAVAILABLE` | `503` | yes |
| `INTERNAL_ERROR` | `500` | yes |

<!-- codes:voice -->

| Code | Status | Retryable |
| --- | --- | --- |
| `AUTH_REQUIRED` | `401` | no |
| `LANGUAGE_UNSUPPORTED` | `400` | no |
| `STORAGE_REF_INVALID` | `400` | no |
| `STORAGE_REF_FORBIDDEN` | `403` | no |
| `AUDIO_TOO_LONG` | `400` | no |
| `AUDIO_FORMAT_UNSUPPORTED` | `400` | no |
| `TRANSCRIPT_EMPTY` | `422` | yes |
| `TRANSCRIPTION_FAILED` | `502` | yes |
| `RATE_LIMITED` | `429` | yes |
| `QUOTA_EXCEEDED` | `429` | no |
| `INTERNAL_ERROR` | `500` | yes |

<!-- codes:media-upload -->

| Code | Status | Retryable |
| --- | --- | --- |
| `AUTH_REQUIRED` | `401` | no |
| `FILE_TYPE_UNSUPPORTED` | `400` | no |
| `FILE_TOO_LARGE` | `400` | no |
| `INTERNAL_ERROR` | `500` | yes |

<!-- codes:media-serve -->

| Code | Status | Retryable |
| --- | --- | --- |
| `AUTH_REQUIRED` | `401` | no |
| `STORAGE_REF_FORBIDDEN` | `403` | no |
| `INTERNAL_ERROR` | `500` | yes |

<!-- codes:link-token -->

| Code | Status | Retryable |
| --- | --- | --- |
| `AUTH_REQUIRED` | `401` | no |
| `INTERNAL_ERROR` | `500` | yes |

<!-- codes:payment-order -->

| Code | Status | Retryable |
| --- | --- | --- |
| `AUTH_REQUIRED` | `401` | no |
| `PAYMENT_ORDER_FAILED` | `502` | yes |
| `INTERNAL_ERROR` | `500` | yes |

<!-- codes:payment-webhook -->

| Code | Status | Retryable |
| --- | --- | --- |
| `WEBHOOK_SIGNATURE_INVALID` | `401` | no |
| `INTERNAL_ERROR` | `500` | yes |

<!-- codes:telegram -->

| Code | Status | Retryable |
| --- | --- | --- |
| `WEBHOOK_SECRET_TOKEN_INVALID` | `401` | no |

<!-- codes:retention-sweep -->

| Code | Status | Retryable |
| --- | --- | --- |
| `SWEEP_UNAUTHORIZED` | `401` | no |
| `INTERNAL_ERROR` | `500` | yes |

<!-- codes:auth-callback -->

| Code | Status | Retryable |
| --- | --- | --- |
| `OAUTH_INCOMPLETE` | `401` | yes |

## Quota semantics

### Retrying after an error spends a new unit

Every accepted request takes its own unit. Jamee has no client idempotency key, so a web retry after
an error spends a new unit — the reserve happens per request, and the daily counter is not refunded
for a failure that occurred after the first provider call. Three codes name failures that are **not**
refunded because they occur after the spend: `PROVIDERS_UNAVAILABLE`, `DIAGNOSIS_TIMEOUT`, and
`TRANSCRIPTION_FAILED`. A failure before the first provider call (a rejected Media_Reference, an
unreadable object, a knowledge-base read) is refunded to zero and logs `quotaSpent = false`.

The one delivery that costs nothing is a **Telegram redelivery**: Telegram redelivers on a non-200,
and the `update_id` claim makes a redelivery a no-op — it logs `outcome: 'duplicate_ignored'`,
returns 200, reserves nothing, and calls no provider. (This is the Telegram equivalent of the
duplicate-delivery rule the retired WhatsApp channel stated over `provider_message_id`.)

When a daily limit is reached, the request is declined with `QUOTA_EXCEEDED` (429) carrying
`details: { limit, used, resetsAt }`, and no provider is invoked.
