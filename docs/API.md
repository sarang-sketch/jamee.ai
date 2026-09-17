# Jamee — API reference

Requirement 17.4: every API_Layer endpoint, with its HTTP method, its request body schema, its
response body schema, and its error codes.

## This document is checked against the code, not maintained beside it

Task 28.2 asks for a document that "cannot drift". The strongest reading of that is a generator that
imports `src/lib/schemas.ts` and emits this file. **That is not available here**, and the reason is
mechanical rather than stylistic: `src/lib/schemas.ts` imports `@/lib/config/verified`, and
`src/lib/errors.ts` additionally begins with `import 'server-only'`. Both specifiers are resolved by
Next.js and by Vite as build-time facts. `node --experimental-strip-types` — the way every other
guard in `scripts/` runs, and the only way a plain Node script could run TypeScript here — resolves
neither, so a generator script would fail at module load. `scripts/check-deployment.ts` records the
same constraint for the same reason.

So the drift protection is a **test** rather than a generator, because a Vitest test *can* import
through the alias (`vitest.config.ts` maps `@` to `src/` and stubs `server-only`).
`tests/unit/api-docs.test.ts` imports the real schemas, the real `ERROR_SPECS`, and the real
`src/lib/config/verified.ts`, then reads this file and asserts:

- **Endpoint completeness.** The route table below lists exactly the `route.ts` modules that exist
  under `src/app/`, with exactly the HTTP verbs each one exports. A new endpoint that is not
  documented here fails the test.
- **Field completeness, both directions.** Every field table below is compared as a *set* against
  its schema's top-level keys — a field added to a schema and not to the table fails, and a field in
  a table that no longer exists in the schema fails too. The `Required` column is checked against
  the schema, not trusted.
- **Error-code completeness.** The master table carries every member of `ERROR_CODES`, in that
  array's order, and each row's HTTP status, retryable flag and requirement are compared against
  `ERROR_SPECS`. Every per-endpoint code table is checked the same way.
- **Enums and constants.** The permitted-values table is compared against each schema's `.options`;
  the constants table against `src/lib/config/verified.ts`; the quota table against `DAILY_QUOTAS`
  and `BURST_QUOTAS`; and each route's `maxDuration` against the literal in its own source file.

The `<!-- … -->` comments before each table are the test's anchors. They name the schema or constant
the table is generated from. Do not remove them, and do not hand-edit a value in an anchored table
without changing the code it comes from — the test will catch it either way.

What the test does **not** check is prose, and the `Type` and `Notes` columns are prose. Those can
still go stale; the shapes, statuses, flags and numbers cannot.

---

## Conventions

### One request shape: JSON carrying a storage reference (D1)

Every request body in Jamee is `application/json`. **No endpoint accepts `multipart/form-data`, and
no endpoint receives media bytes.** Requirement 2.3 allows a 10 MB image and Requirement 2.7 keeps
request bodies under the platform's documented 4.5 MB body ceiling (V16); a multipart upload of a
10 MB image cannot satisfy both. So the browser uploads directly to Supabase Storage and posts a
*reference* — a bucket name and an object path — which keeps a diagnose or voice request body at
roughly **200 bytes** regardless of how large the media is. That is what makes the 10 MB allowance
real rather than nominal, and it is why the 4.5 MB ceiling is a fact recorded against the platform
rather than a limit any Jamee code path approaches.

The object path convention is `{user_id}/{YYYY}/{MM}/{uuid}.{ext}`, enforced by
`STORAGE_PATH_REGEX`. The regex constrains **shape only**. Ownership is a separate runtime
comparison of the first path segment against the session user id, plus an object-exists probe, and
it runs before any quota reserve.

### One duration ceiling: 60 seconds (V17)

<!-- max-duration -->

| Route module | `maxDuration` |
| --- | --- |
| `src/app/api/diagnose/route.ts` | 60 |
| `src/app/api/chat/route.ts` | 60 |
| `src/app/api/voice/route.ts` | 60 |
| `src/app/api/whatsapp/route.ts` | 60 |
| `src/app/api/internal/retention-sweep/route.ts` | 60 |

Sixty seconds is **Jamee's own ceiling, deliberately not the platform's 300**
(`PLATFORM_MAX_DURATION_SECONDS`). Every soft timeout in the codebase is a fraction of 60, so
raising it is a deliberate act with arithmetic consequences — `docs/PROVIDER_CAPABILITIES.md`
section 3. Each route writes the number as a literal because Next.js reads route segment config by
static analysis and cannot follow an imported constant; each route's own `route.test.ts` asserts the
literal equals `JAMEE_MAX_DURATION_SECONDS`, and the test behind this document asserts it again
against the value in the table.

`src/app/auth/callback/route.ts` declares no `maxDuration`. It performs one Auth call and one
upsert, so it takes the framework default.

### One error shape

Every non-2xx response from a farmer-facing endpoint carries `errorEnvelopeSchema` — one shape, one
place that can leak. The envelope never contains a stack trace, a provider payload, or model text
(Requirement 15.6); `toEnvelope()` in `src/lib/errors.ts` structurally cannot include them, because
it reads the code, the merged details, the retryable flag and the catalog string, and never touches
`error.message`, `error.stack` or `error.cause`.

Three responses are **deliberately bodiless** and are documented in their own section below.

An `Inconclusive_Result` is **not** an error. It is a successful **200** carrying
`result.status: 'unknown'` — the request worked, the photo could not be judged.

### Constants

<!-- constants -->

| Constant | Value | What it is |
| --- | --- | --- |
| `JAMEE_MAX_DURATION_SECONDS` | 60 | Jamee's serverless duration ceiling, in seconds (V17) |
| `PLATFORM_MAX_DURATION_SECONDS` | 300 | the platform's documented maximum. Recorded, never used as a budget input |
| `REQUEST_BODY_CEILING_BYTES` | 4718592 (4.5 MB) | the platform's request/response body ceiling (V16). Over it the platform returns 413 `FUNCTION_PAYLOAD_TOO_LARGE` before Jamee sees the request |
| `MAX_IMAGE_BYTES` | 10485760 (10 MB) | Requirement 2.3, measured on the file the farmer selects, before re-encoding |
| `MAX_AUDIO_BYTES` | 10485760 (10 MB) | Requirement 8.2, re-checked server-side against the object's real size |
| `MAX_AUDIO_SECONDS` | 120 | Requirement 8.2, re-checked server-side twice |

### Permitted values

<!-- enums -->

| Schema | Permitted values |
| --- | --- |
| `languageSchema` | `en`, `hi`, `mr` |
| `severitySchema` | `none`, `low`, `moderate`, `high` |
| `operationSchema` | `image`, `chat`, `voice` |
| `verifiedConditionSchema` | `Tomato Early Blight`, `Tomato Late Blight`, `Tomato Healthy`, `Potato Early Blight`, `Potato Late Blight` |
| `storageRefSchema.shape.bucket` | `crop-images`, `voice-messages` |

`verifiedConditionSchema` is the safety gate, not a convenience enum. A disease name outside these
five is discarded along with the model's confidence, and the farmer gets the one inconclusive shape
(Requirements 4.1, 6.1, 6.5). `diseaseName` is canonical, Latin script, and never translated —
Requirements 4.6 and 9.4 — even when the surrounding `explanation` is Hindi or Marathi.

---

## Authentication

Three mechanisms, and they are not interchangeable. Each endpoint uses exactly one.

<!-- routes -->

| Route module | Methods | Auth |
| --- | --- | --- |
| `src/app/api/chat/route.ts` | `POST` | session |
| `src/app/api/diagnose/route.ts` | `POST` | session |
| `src/app/api/internal/retention-sweep/route.ts` | `GET`, `POST` | bearer |
| `src/app/api/voice/route.ts` | `POST` | session |
| `src/app/api/whatsapp/route.ts` | `GET`, `POST` | hmac |
| `src/app/auth/callback/route.ts` | `GET` | redirect |

### `session` — the farmer-facing endpoints (Requirement 1.7)

`/api/diagnose`, `/api/chat` and `/api/voice` are built from `authenticatedRoute`, which resolves the
identity through `currentUserId()` → Supabase `getUser()`. That is V1's **server-confirmed** call:
the identity is verified against the Auth service rather than decoded from a cookie the caller
supplied, so a forged or edited cookie resolves to `null` and gets `AUTH_REQUIRED` (401).

The wrapper *owns the call to the handler*. The handler body is a callback that only runs after a
non-null user id has been resolved, so "the session check precedes any domain service call, any
quota reserve and any provider call" is the only order the control flow permits. The
`FarmerSession` a handler receives carries a brand keyed by a symbol the wrapper module does not
export, so a handler cannot fabricate one.

The language a 401 is written in comes from `?language=` and then `Accept-Language`, **never from
the body** — consuming up to 4.5 MB of attacker-supplied JSON before deciding whether the caller is
allowed to be here at all would be the wrong order.

### `hmac` — the WhatsApp webhook (Requirement 11.3, V13)

`/api/whatsapp` carries no session. Meta is the caller, so `currentUserId()` is `null` for every
legitimate delivery and gating on it would take the channel down permanently. The route is
deliberately **not** wrapped in `authenticatedRoute`; `authenticated-route.test.ts` names the four
protected endpoint groups and excludes this one for exactly that reason.

- **`POST`** is authenticated by an **HMAC-SHA256 signature over the raw request body**, keyed with
  `WHATSAPP_APP_SECRET`, presented in Meta's `sha256=`-prefixed signature header and compared in
  constant time. The body is read once as an `ArrayBuffer` — never `request.json()` or
  `request.text()` — because the signature covers the exact bytes Meta signed and a UTF-8 round trip
  is lossless only for well-formed UTF-8. Requirement 11.4's "invokes no shared service on a failed
  signature" is structural: every line that can reach a service sits behind `parseVerifiedInbound`,
  which accepts only a `VerifiedRawBody` proof obtainable from the verification function alone.
- **`GET`** is the one-time verification handshake: `hub.mode=subscribe`, `hub.verify_token`,
  `hub.challenge`. The presented token is compared in constant time against
  `WHATSAPP_VERIFY_TOKEN`; on a match the challenge is echoed with 200 and
  `content-type: text/plain; charset=utf-8`.

### `bearer` — the retention sweep (Requirement 18.12, V21)

`/api/internal/retention-sweep` is authenticated by `Authorization: Bearer <CRON_SECRET>` and
nothing else. V21 settled two details that are read strictly:

- the platform's scheduler issues **`GET`**, so `GET` is the automatic path and `POST` is the
  documented manual run — both behind the same function, so they cannot drift into two
  authorization stories;
- the credential arrives as `Authorization: Bearer …` because that is the header the platform
  injects automatically. Requirement 18.12's "retention sweep secret" therefore *is* `CRON_SECRET`,
  and there is one secret rather than two.

The scheme label is matched case-insensitively (it is a fixed public string) and the token exactly,
through the codebase's single constant-time string comparison. **This route consults no Supabase
session** — it does not import `createServerSupabase`, does not call `currentUserId()`, and is not
wrapped in `authenticatedRoute` — which is the whole of Requirement 18.13: a valid farmer session
grants nothing here, even while signed in. `route.test.ts` asserts that absence structurally.

### `redirect` — `/auth/callback`

Not an authenticated endpoint and not an API in the JSON sense. It confirms a session that the
browser has already established and redirects. See its section below.

---

## Quotas, burst limiting, and what a retry costs

<!-- quotas -->

| Operation | Daily limit | Burst ceiling (per minute) |
| --- | --- | --- |
| `image` | 20 | 3 |
| `chat` | 50 | 10 |
| `voice` | 20 | 3 |

The **daily limits** are Requirement 14.1's, and per Requirement 14.2 they are **shared across
channels**: a farmer's 20 image units are the same 20 whether they arrive from the web app or from
WhatsApp. The window is a calendar day in **Asia/Kolkata** (Requirement 14.1), which is why
`quota.resetsAt` is the next Asia/Kolkata midnight expressed as a UTC ISO-8601 instant.

The **burst ceiling** is Requirement 13.8's, and it is a distinct control set independently of the
daily quota — chosen so a farmer cannot loop faster than a human works, since photographing a leaf
takes time and reading an answer takes time. **These numbers are Jamee's own and are not a provider
limit.** U-V19a and U-V19b — the free-tier request-per-minute allowances of the two model providers
— are unresolved, so `BURST_QUOTAS` is not derived from them and must not be read as a claim about
them. A refusal is `RATE_LIMITED` (429, retryable), carrying `details.retryAfterSeconds` and an
advisory `retry-after` header; the counter is never refunded, because a refused request never
reserved a unit in the first place.

### Retrying after an error spends a new unit

A web request carries no client idempotency key — the requirements define none — so Jamee cannot
tell a retry of a failed request from a new request. Every accepted request takes its own unit.

Concretely: if a diagnosis, chat, or voice request fails after Jamee has attempted at least one
provider call (`PROVIDERS_UNAVAILABLE`, `DIAGNOSIS_TIMEOUT`, `TRANSCRIPTION_FAILED`), the unit is
spent and is **not** refunded. Pressing retry spends a second unit. This is deliberate: those
requests consumed real provider capacity, and refunding them would let a failing provider drain the
free tier through retries. Failures *before* the first provider call — an unreadable object, a
signed-URL failure, a knowledge-base read failure — are refunded, and their `usage_logs` row records
`quota_spent = false`.

The uploader disables its submit control while a request is in flight, so an accidental
double-submit is prevented in the interface rather than in the counter.

**WhatsApp differs.** Meta's `provider_message_id` is the primary key of `whatsapp_inbound`, and the
idempotency insert happens *before* the quota reserve. A Meta redelivery of a message Jamee already
processed is therefore free: it is acknowledged with HTTP 200, audited as
`outcome: 'duplicate_ignored'` / `quota_spent: false`, and reaches neither the counter nor a provider
(Requirement 11.5). The web channel has no equivalent identifier, which is the whole of the
difference.

A request declined at the daily limit spends nothing and invokes no provider (Requirement 14.3). It
returns `QUOTA_EXCEEDED` with HTTP 429 and `details: { limit, used, resetsAt }`, where `resetsAt` is
the next Asia/Kolkata midnight as an ISO-8601 instant. `retryable` is `false` — the request will
succeed after `resetsAt`, but a retry button that does nothing for hours is worse than no button.

### One voice message spends one voice unit

A voice request reserves a `voice` unit and hands the nested chat answer a *covered* reservation, so
one recording never spends both a voice unit and a chat unit (Requirement 14.1). For the same reason
the nested turn takes no second burst slot. `voiceResponseSchema.quota` is therefore always the
**voice** counter.

---

## Shared shapes

These objects appear inside more than one response, and they are declared once in
`src/lib/schemas.ts` so two endpoints cannot drift apart.

### `StorageRef`

<!-- fields:storageRefSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `bucket` | yes | `'crop-images' \| 'voice-messages'` | `/api/diagnose` additionally refines this to `crop-images`; `/api/voice` to `voice-messages` |
| `path` | yes | `string`, 1–512 chars, `STORAGE_PATH_REGEX` | `{user_id}/{YYYY}/{MM}/{uuid}.{ext}` |

**The single-dot rule in the regex is deliberate and must not be relaxed.** Exactly one `.` followed
by 2–5 characters means a path containing the `.thumb` infix fails the schema, so a client can
submit neither a thumbnail derivative as the object to diagnose nor any fabricated derived path. A
thumbnail path is only ever computed server-side from an original that has already passed both this
schema and the ownership check.

### `QuotaStatus`

Echoed on every successful diagnose, chat and voice response.

<!-- fields:quotaStatusSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `operation` | yes | `'image' \| 'chat' \| 'voice'` | which counter this is |
| `used` | yes | `integer >= 0` | units spent in the current Asia/Kolkata day, **including this request** |
| `limit` | yes | `integer > 0` | from `DAILY_QUOTAS` |
| `resetsAt` | yes | ISO-8601 datetime | the next Asia/Kolkata midnight |

### `DiagnosisResult`

A discriminated union on `status` with exactly two members. Requirement 6.4 is one inconclusive
shape reached by all seven rejection reasons, which is why the second table has no room for a guess.

`status: 'identified'`:

<!-- fields:identifiedResultSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `status` | yes | `'identified'` | the union discriminant |
| `diseaseName` | yes | one of the five verified conditions | canonical, Latin script, never translated |
| `confidence` | yes | `number` in the closed interval `[0, 1]` | `0` and `1` are both valid |
| `severity` | yes | `'none' \| 'low' \| 'moderate' \| 'high'` | |
| `explanation` | yes | non-empty `string` | knowledge-base grounded and localized (Requirement 3.2) |
| `knowledge` | yes | `KnowledgePayload` | |
| `needsExpert` | yes | `false` | literal |
| `language` | yes | `'en' \| 'hi' \| 'mr'` | the language `explanation` is written in |

`status: 'unknown'`:

<!-- fields:inconclusiveResultSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `status` | yes | `'unknown'` | the union discriminant |
| `diseaseName` | yes | `null` | the rejected model's name is discarded, not weakened (Requirement 6.5) |
| `confidence` | yes | `null` | so is its confidence |
| `severity` | yes | `'none'` | literal |
| `explanation` | yes | non-empty `string` | static localized copy from the message catalogs. An inconclusive result is not a silent one, and it costs no model call (Requirement 6.6) |
| `knowledge` | yes | `null` | `null` rather than an empty payload, so TypeScript makes rendering treatment text for an inconclusive result impossible |
| `needsExpert` | yes | `true` | literal |
| `language` | yes | `'en' \| 'hi' \| 'mr'` | |

An inconclusive diagnosis **is a 200 and does spend its image unit** (Requirement 6.7). It is not an
error and has no error code.

### `KnowledgePayload`

Present only on an identified result.

<!-- fields:knowledgePayloadSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `symptoms` | yes | `string[]` | |
| `causes` | yes | `string[]` | |
| `treatment` | yes | `string[]` | empty for `Tomato Healthy`, by seed and by database constraint |
| `prevention` | yes | `string[]` | |
| `source` | yes | `string` | the citation Requirement 4.2 requires on every row |

### `ChatAnswer`

Shared by `/api/chat` and `/api/voice` so the two cannot drift.

<!-- fields:chatAnswerSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `messageId` | yes | uuid | the persisted Jamee message |
| `content` | yes | non-empty `string` | |
| `language` | yes | `'en' \| 'hi' \| 'mr'` | |
| `groundedIn` | yes | array of verified conditions | which knowledge-base rows fed this answer. **Empty** for an out-of-scope referral |
| `needsExpert` | yes | `boolean` | true for an out-of-scope or unanswerable question (Requirements 4.7, 7.6) |

### `ErrorEnvelope`

<!-- fields:errorEnvelopeSchema.error -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `code` | yes | one of `ERROR_CODES` | stable and machine-readable; the client keys its retry action off this |
| `message` | yes | non-empty `string` | localized and farmer-readable (Requirement 15.3) |
| `language` | yes | `'en' \| 'hi' \| 'mr'` | the language `message` is written in |
| `retryable` | yes | `boolean` | drives the retry action (Requirement 15.4). Accurate, not optimistic |
| `details` | no | `ErrorDetails` | absent when the code implies no numbers |

The envelope is `{ "error": { … } }` — the fields above are nested under the single `error` key.

### `ErrorDetails`

Structured rather than baked into the message string, so a client can render a localized sentence
**and** a precise number without parsing prose, and so a translation can put the number wherever
that language puts it. Every field is optional; which ones appear is a property of the code.

<!-- fields:errorDetailsSchema -->

| Field | Required | Type | Appears on |
| --- | --- | --- | --- |
| `limit` | no | `integer` | `QUOTA_EXCEEDED` |
| `used` | no | `integer` | `QUOTA_EXCEEDED` |
| `resetsAt` | no | ISO-8601 datetime | `QUOTA_EXCEEDED` |
| `supportedLanguages` | no | `string[]` | `LANGUAGE_UNSUPPORTED` — filled from `SUPPORTED_LANGUAGES`, so the codes named cannot disagree with the enum that rejected |
| `acceptedTypes` | no | `string[]` | `FILE_TYPE_UNSUPPORTED` (image MIME types), `AUDIO_FORMAT_UNSUPPORTED` (V10's accepted containers) |
| `maxBytes` | no | `integer` | `FILE_TYPE_UNSUPPORTED`, `FILE_TOO_LARGE`, `AUDIO_TOO_LONG`, `AUDIO_FORMAT_UNSUPPORTED` |
| `maxSeconds` | no | `integer` | `AUDIO_TOO_LONG` |
| `retryAfterSeconds` | no | `integer` | `RATE_LIMITED`. Also emitted as an advisory `retry-after` header; the `retryable` flag, not the header, drives the interface |

Some of these are properties of the **code** rather than of the request, and are filled in from
`src/lib/config/verified.ts` rather than by the caller — a caller that had to remember a limit would
eventually state one that disagreed with the check that produced it.

---

## Error codes

Every stable code in the taxonomy, with the HTTP status and retryable flag `ERROR_SPECS` assigns.

**`retryable` answers exactly one question: could the *same* request, re-sent unchanged, plausibly
succeed?** Requirement 15.4 turns it into a retry button, so an optimistic value is a lie the
interface tells. `QUOTA_EXCEEDED` is the instructive case — `false` even though the request will
succeed tomorrow, because a button that does nothing for hours is worse than no button.

<!-- error-specs -->

| Code | HTTP | Retryable | Requirement | Where it is raised |
| --- | --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | no | 1.7 | `authenticatedRoute`, on the three farmer-facing endpoints |
| `OTP_INVALID` | 400 | yes | 1.3 | **not an API_Layer code.** Sign-in runs in the browser against Supabase Auth; `SignInForm` maps a rejected code to this and renders it. No endpoint below returns it |
| `LANGUAGE_UNSUPPORTED` | 400 | no | 9.5 | the shared request-body edge, on all three farmer-facing endpoints |
| `MESSAGE_INVALID` | 400 | no | 7.1, 15.3 | `/api/chat`'s body contract fallback |
| `STORAGE_REF_INVALID` | 400 | no | 2.2 | `/api/diagnose` and `/api/voice` body contract fallback; also the storage layer |
| `STORAGE_REF_FORBIDDEN` | 403 | no | 2.6 | the ownership gate, **before** any quota reserve — the counter is untouched |
| `FILE_TYPE_UNSUPPORTED` | 400 | no | 2.4 | `DiagnosisService` (object extension) and the WhatsApp media store |
| `FILE_TOO_LARGE` | 400 | no | 2.4, 8.3 | `VoiceService` (the object's real size) and the WhatsApp media store |
| `AUDIO_TOO_LONG` | 400 | no | 8.3 | `/api/voice`'s endpoint-specific body branch, and again inside `VoiceService` |
| `AUDIO_FORMAT_UNSUPPORTED` | 400 | no | 8.4, 10.6 | `VoiceService`, when the container is outside V10's accepted list |
| `RATE_LIMITED` | 429 | yes | 13.8 | the burst limiter, on all three farmer-facing endpoints |
| `QUOTA_EXCEEDED` | 429 | no | 14.3 | `QuotaService`, before any provider call |
| `TRANSCRIPT_EMPTY` | 422 | yes | 8.7 | `VoiceService`. Retryable because the farmer can act — record again somewhere quieter |
| `TRANSCRIPTION_FAILED` | 502 | yes | 8.4 | the model gateway's transcribe chain. Retryable **over the same object**, which is why a failed transcription does not delete its recording |
| `PROVIDERS_UNAVAILABLE` | 503 | yes | 14.5, 14.8 | the model gateway, when a capability's provider chain is exhausted |
| `DIAGNOSIS_TIMEOUT` | 504 | yes | 3.7 | the model gateway's deadline check, and the rephrase budget |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | no | 11.4 | `POST /api/whatsapp`. **Bodiless** |
| `WEBHOOK_VERIFY_TOKEN_INVALID` | 403 | no | 11.2 | `GET /api/whatsapp`. **Bodiless** |
| `CONVERSATION_NOT_FOUND` | 404 | no | 7.1 | the body edge (a `conversationId` that is not a uuid) and the services (an id that is not this farmer's) |
| `DIAGNOSIS_NOT_FOUND` | 404 | no | 12.3 | **not an API_Layer code.** The diagnosis detail screen is a server component, not an endpoint; it raises this for an id that is not this farmer's |
| `SWEEP_UNAUTHORIZED` | 401 | no | 18.12 | the retention-sweep gate. **Bodiless**, and the status is this row's |
| `INTERNAL_ERROR` | 500 | yes | 15.6 | `withErrorHandling`, for anything that is not an `AppError`. Generic message; the real cause is logged server-side and nowhere else |

Two codes above are reachable in the product but not from any endpoint in this document, and they
are marked as such rather than omitted: the taxonomy is one closed vocabulary shared by the API
layer and the screens, and a code list that silently dropped the two screen-only members would read
as a claim that they do not exist.

`Inconclusive_Result` is deliberately absent from this table. See `DiagnosisResult` above.

### The three bodiless non-2xx responses

The WhatsApp and retention-sweep routes return **non-2xx responses with no body at all**, on
purpose. The status still comes from `ERROR_SPECS` — the taxonomy stays the one place an HTTP code
for these conditions is written down — but nothing is serialized.

<!-- bodiless -->

| Response | Status | Status comes from |
| --- | --- | --- |
| `GET /api/whatsapp`, handshake refused | 403 | `WEBHOOK_VERIFY_TOKEN_INVALID` |
| `POST /api/whatsapp`, signature invalid | 401 | `WEBHOOK_SIGNATURE_INVALID` |
| `GET\|POST /api/internal/retention-sweep`, no valid bearer secret | 401 | `SWEEP_UNAUTHORIZED` |

Why no body. There is no farmer on any of these paths and nothing to localize, so an envelope could
carry only one extra thing: a machine-readable statement of *which* part of the check failed. That
is an oracle for an unauthenticated caller — it separates "your token is wrong" from "your request
was malformed", and on the sweep it would separate "the server has no secret configured" from "your
guess was wrong", telling an anonymous caller whether the sweep is armed. The reason is logged
server-side instead, where the operator is.

`POST /api/whatsapp` reads the status directly as
`ERROR_SPECS.WEBHOOK_SIGNATURE_INVALID.status`. The other two write the number as a literal, and
their own `route.test.ts` files assert it against `ERROR_SPECS`; the test behind this document
asserts the numbers in the table above against `ERROR_SPECS` as well.

---

## `POST /api/diagnose`

Requirement 2.2. The web channel's entry to the shared `DiagnosisService` — the same service the
WhatsApp adapter calls, which is what makes Requirements 3.8 and 16.1 structural rather than a
promise that two handlers agree.

- **Method:** `POST`
- **Auth:** session (`AUTH_REQUIRED` → 401)
- **Content type:** `application/json`, roughly 200 bytes. Never multipart; `request.formData()` is
  never called
- **`maxDuration`:** 60 s
- **Success:** `200` with `diagnoseResponseSchema`

### Request body — `diagnoseRequestSchema`

<!-- fields:diagnoseRequestSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `image` | yes | `StorageRef` | additionally refined: `bucket` must be `crop-images` |
| `language` | yes | `'en' \| 'hi' \| 'mr'` | the language the answer is written in |
| `conversationId` | no | uuid | **optional here and required on chat and voice.** Requirement 2.2 permits a diagnosis with no conversation, and Requirement 7.5 then requires the API to create one and attach the diagnosis to it |

### Response body — `diagnoseResponseSchema`

<!-- fields:diagnoseResponseSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `diagnosisId` | yes | uuid | the persisted `diagnoses` row |
| `conversationId` | yes | uuid | the one supplied, or the one Requirement 7.5 created |
| `result` | yes | `DiagnosisResult` | identified or inconclusive — both are 200 |
| `quota` | yes | `QuotaStatus` | the `image` counter |

The four fields are copied off the service's outcome unchanged. The outcome's remaining fields —
`provider`, `usedFallback`, `rejectionReason` — are audit facts and are deliberately left off the
wire: which provider served a request is not a farmer's business, and a client that could see it
could start depending on it.

### Error codes

<!-- codes:diagnose -->

| Code | HTTP | Retryable | When |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | no | no valid session. No service, no reserve, no provider call |
| `LANGUAGE_UNSUPPORTED` | 400 | no | `language` outside the three supported codes. `details.supportedLanguages` names them |
| `STORAGE_REF_INVALID` | 400 | no | the body contract failed in no more specific way: absent `image`, a path outside the convention, the wrong bucket, a body that is not an object, a body that is not JSON at all |
| `CONVERSATION_NOT_FOUND` | 404 | no | `conversationId` is not a uuid, or is not this farmer's. One code for one meaning, so the response is not an oracle |
| `STORAGE_REF_FORBIDDEN` | 403 | no | the path's first segment is not this farmer's, or the object does not exist. Checked before the reserve, so the counter is untouched (Requirement 2.6) |
| `FILE_TYPE_UNSUPPORTED` | 400 | no | the object's extension is outside `ACCEPTED_IMAGE_TYPES`. Decided before the reserve |
| `RATE_LIMITED` | 429 | yes | more than 3 image requests in one minute |
| `QUOTA_EXCEEDED` | 429 | no | the day's 20 image units are spent. No provider is invoked |
| `PROVIDERS_UNAVAILABLE` | 503 | yes | the vision or text chain is exhausted. The unit is spent and not refunded |
| `DIAGNOSIS_TIMEOUT` | 504 | yes | the request's budget expired. `usage_logs` records `outcome = 'timeout'` before the throw |
| `INTERNAL_ERROR` | 500 | yes | anything else |

`FILE_TOO_LARGE` is **not** on this list, and that is accurate rather than an omission: on the web
image path Requirement 2.3's 10 MB is enforced on the file the farmer selects, before re-encoding,
by `imageCandidateSchema` in the uploader — the object that reaches Storage is already downscaled.
The WhatsApp image path enforces the same limit server-side at media-store time, where the size
arrives in Meta's metadata.

---

## `POST /api/chat`

Requirements 7.1, 7.2, 7.4. The web channel's entry to the shared `ChatService` — the same service
the WhatsApp adapter and the voice path call (Requirements 7.7, 16.2).

- **Method:** `POST`
- **Auth:** session
- **Content type:** `application/json`
- **`maxDuration`:** 60 s
- **Success:** `200` with `chatResponseSchema`

### Request body — `chatRequestSchema`

<!-- fields:chatRequestSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `conversationId` | yes | uuid | **required, unlike on diagnose.** Requirements 7.1 and 7.2 key conversation context on this id, and a chat turn with no conversation has no context to resolve a subject-less follow-up against |
| `message` | yes | `string`, 1–1000 chars | the farmer's typed question |
| `language` | yes | `'en' \| 'hi' \| 'mr'` | |

### Response body — `chatResponseSchema`

<!-- fields:chatResponseSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `conversationId` | yes | uuid | |
| `farmerMessageId` | yes | uuid | the persisted farmer turn. Requirement 7.4 persists both sides |
| `answer` | yes | `ChatAnswer` | |
| `quota` | yes | `QuotaStatus` | the `chat` counter |

### Error codes

<!-- codes:chat -->

| Code | HTTP | Retryable | When |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | no | no valid session |
| `LANGUAGE_UNSUPPORTED` | 400 | no | `language` outside the three supported codes |
| `MESSAGE_INVALID` | 400 | no | an absent, empty or over-long `message`, a body that is not an object, a body that is not JSON |
| `CONVERSATION_NOT_FOUND` | 404 | no | `conversationId` is not a uuid, or is not this farmer's |
| `RATE_LIMITED` | 429 | yes | more than 10 chat requests in one minute |
| `QUOTA_EXCEEDED` | 429 | no | the day's 50 chat units are spent |
| `INTERNAL_ERROR` | 500 | yes | anything else |

**No provider code appears on this list, and that is the design rather than an omission.** When the
model chain fails or the budget expires, `ChatService` degrades to the grounded knowledge-base
template and returns 200 — it does not surface `PROVIDERS_UNAVAILABLE` or `DIAGNOSIS_TIMEOUT`, whose
copy would tell a farmer who typed a question to resend a photo. The degradation is recorded in
`usage_logs` (`used_fallback`, `rejection_reason`), which is where it belongs.

`MESSAGE_INVALID` exists because this endpoint used to borrow `STORAGE_REF_INVALID` as its
catch-all. The status and the flag were right; the *sentence* was not — its English rendering names
a photo, and the sentence is the part a farmer reads (Requirement 15.3). `/api/diagnose` and
`/api/voice` keep `STORAGE_REF_INVALID` because Requirements 2.2 and 8.1 make the storage reference
the substance of their bodies. One shared edge, three endpoint-specific catch-alls: the rule that is
the same everywhere is written once, and the code that differs per endpoint is stated at the
endpoint.

---

## `POST /api/voice`

Requirements 8.1, 8.2, 8.3, 8.6. Transcribes a recording already in Storage and answers it through
the same `ChatService` the text path uses.

- **Method:** `POST`
- **Auth:** session
- **Content type:** `application/json`. **The body carries a reference, never the audio bytes**
  (Requirement 8.1)
- **`maxDuration`:** 60 s
- **Success:** `200` with `voiceResponseSchema`

### Request body — `voiceRequestSchema`

<!-- fields:voiceRequestSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `audio` | yes | `StorageRef` | additionally refined: `bucket` must be `voice-messages` |
| `language` | yes | `'en' \| 'hi' \| 'mr'` | |
| `conversationId` | yes | uuid | required, as on chat |
| `durationSeconds` | yes | `number`, `> 0` and `<= 120` | measured by the browser and **re-checked server-side**. Client-side enforcement alone would be a client-side check on a server-side spend rule: the recorder stops at 120 s, but a hand-built request need not |
| `mimeType` | no | `string`, 1–128 chars | the container `MediaRecorder` actually selected, read back from `MediaRecorder.mimeType`. Sent rather than assumed because U-V20 leaves the recorded container unresolved on the target Android browsers |

**There is no `bytes` field, deliberately.** Requirement 8.2's size half is enforced from the
object, not from the body: a byte count on the wire is the client's claim about the bytes it
uploaded, and a hand-built request — the case the server-side re-check exists for — can put any
number in it. The route reads the real size from Storage before the reserve and passes it to the
service as a measured fact. When Storage does not answer with a size the check is skipped and the
request proceeds: failing a recording that is already in the bucket would turn a metadata hiccup
into a farmer's lost recording.

### Response body — `voiceResponseSchema`

<!-- fields:voiceResponseSchema -->

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `transcript` | yes | `string` | **Requirement 8.6 is this field and `answer` being present together** |
| `answer` | yes | `ChatAnswer` | produced by the same `ChatService` a typed question reaches |
| `conversationId` | yes | uuid | |
| `quota` | yes | `QuotaStatus` | the **voice** counter. One recording never spends a voice unit and a chat unit |

The outcome's `farmerMessageId`, `provider`, `usedFallback` and `audio` fields are audit facts and
are left off the wire: what became of the recording is not a farmer's business, and a client that
could see it could start depending on it.

### Error codes

<!-- codes:voice -->

| Code | HTTP | Retryable | When |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | no | no valid session |
| `LANGUAGE_UNSUPPORTED` | 400 | no | `language` outside the three supported codes. Checked **before** the duration branch, because the language is the thing Jamee will not do at all |
| `STORAGE_REF_INVALID` | 400 | no | absent `audio`, a path outside the convention, a reference naming `crop-images`, an over-long `mimeType`, a body that is not an object, a body that is not JSON |
| `AUDIO_TOO_LONG` | 400 | no | `durationSeconds` over 120. `details` carries `maxSeconds` and `maxBytes` |
| `CONVERSATION_NOT_FOUND` | 404 | no | `conversationId` is not a uuid, or is not this farmer's |
| `STORAGE_REF_FORBIDDEN` | 403 | no | the object is not under this farmer's prefix, or does not exist. Before the reserve |
| `FILE_TOO_LARGE` | 400 | no | the object's real size exceeds 10 MB. Read from Storage, decided before the reserve |
| `AUDIO_FORMAT_UNSUPPORTED` | 400 | no | the container is outside V10's accepted list. **Not retryable, and that is the point of the code:** re-sending identical bytes in an identical container fails identically forever |
| `RATE_LIMITED` | 429 | yes | more than 3 voice requests in one minute |
| `QUOTA_EXCEEDED` | 429 | no | the day's 20 voice units are spent |
| `TRANSCRIPT_EMPTY` | 422 | yes | the provider returned no words. Retryable because the farmer can act; the recording is **retained** so a retry has something to work on (Requirement 8.10) |
| `TRANSCRIPTION_FAILED` | 502 | yes | the transcribe chain failed, or its budget expired. Retryable **over the same object**, which is why a failed transcription does not delete its recording |
| `INTERNAL_ERROR` | 500 | yes | anything else |

As on `/api/chat`, the *answer* half degrades rather than failing, so `PROVIDERS_UNAVAILABLE` and
`DIAGNOSIS_TIMEOUT` are not on this list. A gateway timeout inside transcription surfaces as
`TRANSCRIPTION_FAILED`, because that is the operation the farmer was waiting on.

On success the recording is deleted from Storage once the transcript is a durable `messages` row
(Requirements 8.9, 8.11), server-side with the service role.

---

## `GET /api/whatsapp` — verification handshake

Requirements 11.1, 11.2. Called once by Meta when the callback URL is registered, and again whenever
the subscription is re-verified.

- **Method:** `GET`
- **Auth:** hmac (the shared verify token, compared in constant time)
- **Query parameters:** `hub.mode` (must be `subscribe`), `hub.verify_token`, `hub.challenge`
- **`maxDuration`:** 60 s
- **Success:** `200` with the `hub.challenge` value echoed as `text/plain; charset=utf-8`,
  `cache-control: no-store`. **Not JSON** — this is the one endpoint whose success body is not a
  JSON document

There is no request body and no response schema.

### Error codes

<!-- codes:whatsapp-get -->

| Code | HTTP | Retryable | When |
| --- | --- | --- | --- |
| `WEBHOOK_VERIFY_TOKEN_INVALID` | 403 | no | `hub.mode` is not `subscribe`, the token is absent, the token does not match, or there is no challenge to echo. **Bodiless** — one answer for all four, so the caller learns only "no" |
| `INTERNAL_ERROR` | 500 | yes | `WHATSAPP_VERIFY_TOKEN` is not configured. A JSON envelope, and deliberately **not** a 403: a missing token is a configuration defect, not a caller with the wrong one, and Meta's dashboard should show a failed verification rather than Jamee silently refusing a correct token |

---

## `POST /api/whatsapp` — inbound delivery

Requirements 11.3, 11.4, 10.11, 11.5.

- **Method:** `POST`
- **Auth:** hmac over the raw body
- **Content type:** `application/json`, but **Jamee never parses it as JSON before verifying the
  signature.** The body is read once as bytes; `request.json()` and `request.text()` are never called
  in the route, and its `route.test.ts` drives the handler with a request whose `json()` and `text()`
  throw, so calling one is a test failure rather than a review comment
- **`maxDuration`:** 60 s
- **Success:** `200` with **no body**, `cache-control: no-store`

### Request body

Meta's webhook envelope (V12), not a Jamee schema, and it is deliberately not exported from
`src/lib/whatsapp.ts` — only the verification function can hand the parser a proof that the bytes
were signed. A delivery may batch up to 1000 updates (V13). Both farmer messages and
business-originated status updates arrive with `field: 'messages'`, so the discriminator is the
presence of `value.statuses[]` rather than the field name.

### Response body

None, on every path. Meta reads the status code and nothing else, so a body describing which of ten
messages was rejected would have no reader. Per-message outcomes live in `whatsapp_inbound.status`
(`received`, `processed`, `failed`, `rejected`) and in `usage_logs`.

**A 200 is almost always the right answer** (Requirement 10.11). All of these are acknowledged with
200 and no body:

- a signed payload Jamee cannot read — the signature proves it came from Meta, so it is a genuine
  delivery rather than an attack, and the same bytes would fail a redelivery the same way;
- a delivery-receipt-only batch — nothing spent, nothing recorded;
- a duplicate of a message already processed — audited as `outcome: 'duplicate_ignored'` with
  `quota_spent: false`, reaching neither the counter nor a provider (Requirement 11.5);
- a message Jamee refuses on its merits, such as an unsupported media type. **The farmer is told in
  a WhatsApp reply, not in an HTTP status** — the taxonomy code chosen for the refusal selects the
  localized sentence that is sent back over WhatsApp, and the HTTP response stays a bodiless 200.

### Error codes

<!-- codes:whatsapp-post -->

| Code | HTTP | Retryable | When |
| --- | --- | --- | --- |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | no | the signature header is absent, malformed, or does not match the HMAC over the raw body. Returned **before** the payload is parsed and before any service is reached (Requirement 11.4). **Bodiless** |
| `INTERNAL_ERROR` | 500 | yes | a bug in the handler. A JSON envelope with no reader — the *status* is the point: Meta redelivers on a non-2xx, and a redelivery is the correct outcome for work that did not happen. The idempotency row makes that safe |

V13 records that Meta retries a non-200 immediately and then with decreasing frequency over
36 hours, dropping unacknowledged events after that.

---

## `GET|POST /api/internal/retention-sweep`

Requirements 18.11, 18.12, 18.13. **This endpoint is network-exposed and it deletes data.** The
bearer comparison is its entire security boundary.

- **Methods:** `GET` (the platform's scheduled invocation, V21) and `POST` (the documented manual
  run for a missed or unavailable schedule). One implementation behind both
- **Auth:** `Authorization: Bearer <CRON_SECRET>`. **No Supabase session is consulted**
- **Request body:** none, and **nothing reads one — not even on `POST`.** The window and the batch
  bound are configuration, not request input; a sweep that took its window from a caller would be a
  way to delete newer media than the policy allows
- **`maxDuration`:** 60 s. The per-scan batch bound is what keeps an invocation inside it; leftover
  work is picked up by the next run, which is safe because the sweep is idempotent
- **`cache-control`:** `no-store` on every response

### Response body

`200` carries the run's counts as JSON — how many rows were due, how many objects went, how many
were already absent, and whether the batch was full, so an operator reading a cron log knows whether
another run is owed. **No object path and no user id appears in it**, because a path's first segment
is a farmer's auth id.

There is no Zod schema for this shape and deliberately no field table here: it is an operator
report, not a farmer-facing contract, and `src/lib/schemas.ts` holds wire formats that cross a trust
boundary. `RetentionService`'s own types are the source for it.

### Error codes

<!-- codes:retention-sweep -->

| Code | HTTP | Retryable | When |
| --- | --- | --- | --- |
| `SWEEP_UNAUTHORIZED` | 401 | no | a missing header, a non-bearer scheme, an absent token, a wrong token, **or an unconfigured `CRON_SECRET`** — all one bodiless 401, so an anonymous caller cannot learn whether the sweep is armed. No object is deleted |

A failed sweep is a **bodiless 500 with no envelope and no code** — the one non-2xx in Jamee that
carries neither. There is no human caller to localize for, and the cause is logged server-side. The
platform does not retry a failed cron invocation (V21), so the next scheduled run is the retry,
which is exactly what an idempotent, bounded sweep makes safe.

---

## `GET /auth/callback`

Requirements 1.4, 1.5. The post-sign-in stop: confirm the session, assert the profile row, continue
into the app. Not a JSON API — it always answers with a redirect or an error envelope.

- **Method:** `GET`
- **Auth:** none of the three mechanisms above. The browser arrives holding a session that
  `SignInForm` already established with `verifyOtp`; this route **verifies** it against the Auth
  service with `getUser()` (V1 warns against trusting the user object decoded from a cookie) and,
  because a route handler may write cookies, persists any token refresh that call performs
- **Query parameters:** `next` — where to land afterwards. Attacker-controlled, so it is reduced to
  a same-origin path before use
- **Request body:** none
- **`maxDuration`:** not declared; the framework default applies

**There is no code to exchange, and this route does not pretend otherwise.**
`exchangeCodeForSession` belongs to the PKCE flows — OAuth and email magic links — where the browser
lands holding a `?code=`. Jamee has one authentication method, phone OTP, completed in the browser.
Writing a `?code=` branch for a parameter no Jamee flow produces would be dead code guarding an
imaginary path.

### Responses

| Outcome | Status | Body |
| --- | --- | --- |
| session confirmed, profile asserted | `303 See Other` → the sanitized `next` path | none |
| no valid session | `303 See Other` → the sign-in path | none |
| the profile upsert failed | `500` | error envelope, in `en` |

`303` rather than the default `307`: the browser performed a GET, the work is done, and the thing to
look at is at another URL. 307 would promise method preservation that nothing here needs.

The profile upsert is the defensive half of a database trigger — idempotent, run on the farmer's own
RLS-scoped client, so the row it writes is theirs by construction.

### Error codes

<!-- codes:auth-callback -->

| Code | HTTP | Retryable | When |
| --- | --- | --- | --- |
| `INTERNAL_ERROR` | 500 | yes | the profile upsert failed — a residual failure mode of the `0002_profiles.sql` trigger. Generic message in `en`, with the real cause logged server-side |

`AUTH_REQUIRED` is **not** returned here. A visitor who reaches this URL without signing in has
simply arrived somewhere that has no meaning for them, so they are redirected to sign in rather than
refused. The language is `en` because the only place a farmer's preference is recorded is the
profile row this route may have just failed to write.
