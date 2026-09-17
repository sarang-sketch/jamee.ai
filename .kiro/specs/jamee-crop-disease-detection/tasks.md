# Implementation Plan: Jamee Crop Disease Detection

## Overview

TypeScript (Next.js App Router, strict mode) with Vitest + fast-check for tests, Supabase for auth/Postgres/storage, and Zod as the single source of contracts. The build order follows the product spec's six phases: foundation → image diagnosis → chat → voice → WhatsApp → production polish.

Task 1 resolves the design's "Values to verify before coding" table (V1–V22) and records the findings in `docs/VERIFIED_VALUES.md`. Every later task that touches a third-party surface names the V-items it depends on. **Rule carried through the whole plan: if a V-item cannot be confirmed, the code fails loudly at startup rather than falling back to a guessed value.** No task may substitute an assumed SDK name, model identifier, header name, or platform limit for a resolved one.

Three structural notes on sequencing:

- The quota **counter primitives** (migration `0007` and `quota.service.ts`) land in Phase 2 because the diagnosis spend rule depends on them. Phase 6 completes the quota surface: burst rate limiting, decline messaging, audit completeness, and the cross-channel quota properties that only become testable once WhatsApp exists.
- The **media lifecycle** spans all six phases rather than sitting in one task, because bytes are created in three places and reclaimed in two. Requirement 2's re-encode and thumbnail land in the uploader (12.1), Requirement 12's read order lands in the history screens (13.1, 13.2), Requirement 8.9's on-success voice deletion lands in the VoiceService (18.2), and Requirement 18's sweep lands in Phase 6 as task 33. Migrations 4.4 and 4.8 carry the column, index, and policy narrowing the sweep depends on.
- External account and dashboard work (Supabase project creation, SMS provider enablement, Meta app and business verification, Vercel project setup) is **not** an implementation task. It is captured as written procedure in `docs/DEPLOYMENT.md` (task 28.1).

Task 33 sits in the file between tasks 28 and 29 while carrying a higher number than either. That is deliberate: the media-lifecycle amendment added an epic to Phase 6 after work was already in flight, and renumbering tasks 29–32 would have invalidated task references held elsewhere in the spec and in recorded execution history. Its position in the file and its waves in the dependency graph are where the work belongs; only its number is out of sequence.

## Tasks

### Phase 1 — Foundation

- [x] 1. Resolve the values-to-verify table (V1–V22) before any code is written
  - [x] 1.1 Create `docs/VERIFIED_VALUES.md` resolving every V-item against official documentation
    - Record, per item: the exact value found, the official document consulted, and the date checked
    - V1–V5 Supabase: client package name and version, browser vs. server client factories, App Router cookie/session wiring, phone/SMS OTP enablement and required SMS provider, signed-URL call and expiry units, storage RLS folder-extraction helper and bucket-privacy setting, supported `auth.users` profile-bootstrap trigger form
    - V6–V11 providers: Gemini SDK package and current multimodal model identifier, structured/JSON output parameter names (response MIME type, response schema, temperature, max output tokens), Groq SDK and current text model identifier, **whether Groq currently hosts a vision-capable model (V9)**, speech-to-text host + model identifier + endpoint + accepted audio containers + provider size/duration caps, and the rate-limit vs. unavailability error shapes for both providers
    - V12–V15 Meta: API version string to pin, inbound webhook field paths for text/image/audio plus the message id, signature header name and HMAC algorithm/encoding, two-step media retrieval and its auth header, send-message endpoint shape and any 24-hour customer-service-window constraint
    - V16–V18 platform: Vercel request body limit, maximum permitted `maxDuration` on the target plan, Next.js route segment `maxDuration` config, and whether a supported post-response continuation primitive exists
    - V19–V20: free-tier allowances (Gemini RPM/RPD, Groq RPM/TPD, Supabase database/storage/egress, Vercel invocations/duration) and MediaRecorder container/codec support on target Android browsers
    - V21–V22 media lifecycle: whether the deployment platform offers a scheduled invocation primitive on the target plan, its minimum interval, and how it authenticates the call it makes; and the storage object **deletion and age-query surface** — the batch delete call and its path semantics, whether deleting an absent object errors, and whether `storage.objects` exposes a creation timestamp usable for age filtering
    - `docs/VERIFIED_VALUES.md` already exists from the first pass over V1–V20: **append** V21 and V22 to it and leave the resolved V1–V20 findings in place rather than regenerating the file
    - Record the consequence of each media-lifecycle outcome, because neither item blocks the deletion logic: an unresolved V21 leaves the sweep on the documented manual trigger (task 33.2), and an unresolved V22 leaves the sweep's orphan scan switched off with the row-driven scan still running (task 33.1)
    - Mark any unresolvable item explicitly as UNRESOLVED — never as an assumed value
    - _Requirements: 17.3, 17.7, 18.3, 18.4_

  - [x] 1.2 Create `docs/PROVIDER_CAPABILITIES.md` deriving the capability matrix from the resolved values
    - Capability → provider chain for `vision-classify`, `text-generate`, `transcribe`, with the V9 outcome stated as the single flag that decides whether a vision fallback chain member exists at all
    - Per-request soft timeout budget expressed as a fraction of the confirmed platform duration ceiling (V16, V17)
    - The WhatsApp acknowledgement strategy selected from the V18 outcome, with D11's inline-then-acknowledge default recorded as the choice when no continuation primitive is confirmed
    - Free-tier headroom arithmetic for 6 farmers against Jamee's own daily limits of 20 image / 50 chat / 20 voice
    - _Requirements: 14.4, 14.8, 17.7_
    - _Design: Fallback matrix, Timeouts, D11_

- [x] 2. Scaffold the Next.js App Router project, toolchain, and fail-loud configuration
  - [x] 2.1 Initialize the project with strict TypeScript and the test harness
    - `package.json`, `tsconfig.json` (strict, no implicit any, `noUncheckedIndexedAccess`), `next.config.ts`, ESLint config
    - `vitest.config.ts` with Vitest, fast-check, and separate unit / integration / property test projects
    - `src/app/layout.tsx` locale and font shell with a font stack covering Devanagari for Hindi and Marathi
    - Pin the Supabase, Gemini, and Groq packages to the exact versions resolved in 1.1 (V1, V6, V8)
    - _Requirements: 17.8, 9.1_

  - [x] 2.2 Add the server-only environment accessor and the resolved-value constants
    - `src/lib/env.ts` with `import 'server-only'`, a Zod-validated `serverEnv` accessor that throws on first use when a variable is absent, and no `process.env.X!` anywhere else in the codebase
    - `src/lib/config/verified.ts` holding the model identifiers, Meta API version, header names, and platform limits resolved in 1.1, each annotated with its V-item
    - `.env.example` listing every variable name with a placeholder and no real secret
    - _Requirements: 13.7, 17.2_
    - _Depends on: V1, V6, V8, V10, V12, V13, V16, V17_

  - [x]* 2.3 Write unit tests for the environment accessor and constants
    - Missing variable throws at first use with the variable name in the message
    - Every constant in `verified.ts` is non-empty and carries no placeholder marker
    - _Requirements: 13.7, 17.2_

- [x] 3. Build the shared contracts: enums, schemas, message catalogs, errors, time windows
  - [x] 3.1 Create `src/lib/schemas.ts` as the single source of contracts
    - `VERIFIED_CONDITIONS` declared once (exactly five names), with `verifiedConditionSchema`, `severitySchema`, `languageSchema`, `channelSchema` and inferred types
    - Two-stage vision schemas per D2: `visionRawSchema` (shape only, `disease_name` a free string) and `visionVerifiedSchema` (knowledge-base membership), plus the `RejectionReason` union
    - `identifiedResultSchema` / `inconclusiveResultSchema` discriminated union, with `knowledge: null` and `confidence: null` on the inconclusive branch
    - `storageRefSchema` with the `{user_id}/{YYYY}/{MM}/{uuid}.{ext}` path regex, and the diagnose/chat/voice request and response schemas
    - The `storageRefSchema` regex allows exactly one dot before the extension, so it keeps **rejecting** any `.thumb.` path: a client cannot submit a Thumbnail_Derivative as the object to diagnose, and cannot submit a fabricated derived path at all. Do not widen the regex to accommodate thumbnails — a thumbnail path is only ever computed server-side by `thumbPathFor()` (task 5.2) from an original path that already passed validation and ownership
    - _Requirements: 4.1, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.4, 6.5, 9.1_
    - _Design: D2, D3; Object path convention_

  - [x] 3.2 Create the static localized message catalogs `src/lib/messages/{en,hi,mr}.ts`
    - Inconclusive copy for each rejection reason, quota decline copy, transcription and upload copy, and every error-taxonomy message
    - The `en` rendering of `PROVIDERS_UNAVAILABLE` is exactly `Jamee is temporarily busy. Please try again shortly.` with hi/mr equivalents
    - No model call is reachable from any catalog lookup
    - _Requirements: 6.1, 6.2, 6.3, 14.3, 14.5, 15.3_
    - _Design: D5, D6_

  - [x] 3.3 Create `src/lib/errors.ts` with `AppError` and the taxonomy mapping
    - Every code from the design's error taxonomy mapped to its HTTP status, retryable flag, and message key
    - The `errorEnvelopeSchema` shape with structured `details` (limit, used, resetsAt, supportedLanguages, acceptedTypes, maxBytes)
    - A `withErrorHandling` wrapper that maps `AppError` and converts everything else to `INTERNAL_ERROR` after logging the cause server-side only
    - _Requirements: 15.3, 15.4, 15.6_

  - [x] 3.4 Create `src/lib/time.ts` for Asia/Kolkata quota windows
    - `dayWindowKey()` formatting now as `YYYY-MM-DD` in Asia/Kolkata, `minuteWindowKey()` for burst windows, and `nextResetAt()` returning the next Asia/Kolkata midnight
    - _Requirements: 14.1, 14.3_

  - [x]* 3.5 Write property test for model output validation
    - **Property 6: Model output validation accepts exactly the well-formed, in-knowledge-base responses**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6**

  - [x]* 3.6 Write unit tests for schema rejection reasons
    - Non-JSON, missing required field, confidence at `-0.1` / `0` / `1` / `1.1`, unknown severity, and an out-of-knowledge-base disease name each map to their distinct `RejectionReason`
    - The inconclusive branch cannot be constructed with a non-null `knowledge` or `diseaseName`
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 6.5_

  - [x]* 3.7 Write property test for the error envelope
    - **Property 29: The error envelope is total, localized, and leak-free**
    - **Validates: Requirements 15.3, 15.4, 15.6**

  - [x]* 3.8 Write unit tests for Asia/Kolkata window keys
    - A UTC-evening timestamp that belongs to the next Kolkata day produces the next day's key
    - Day boundary, minute boundary, and `nextResetAt()` correctness across a DST-free year
    - _Requirements: 14.1, 14.3_

- [x] 4. Write the database migrations under `supabase/migrations/`
  - [x] 4.1 `0001_extensions.sql` and `0002_profiles.sql`
    - `pgcrypto`, the shared `set_updated_at()` trigger function
    - `profiles` with the E.164 check constraint, `unique(phone)`, the `phone` index for WhatsApp resolution, the language check, RLS enabled, and own-row select/insert/update policies
    - `handle_new_user()` as a `security definer` function with a pinned `search_path`, plus the `auth.users` insert trigger
    - _Requirements: 1.4, 1.5, 13.1, 13.2_
    - _Design: D8; depends on V5_

  - [x] 4.2 `0003_conversations_messages.sql`
    - `conversations` with the channel check and the `(user_id, updated_at desc)` index
    - `messages` with role/language/channel/`input_kind` checks, the denormalized `user_id`, the `(conversation_id, created_at desc)` context index, RLS enabled, and own-row policies on both tables
    - _Requirements: 7.1, 7.2, 7.4, 13.1, 13.2, 16.5_

  - [x] 4.3 `0004_disease_knowledge.sql`
    - The five-name check constraint, `unique(disease_name)`, the `source` column as `not null`, and the `healthy_has_no_treatment` constraint
    - RLS enabled with a read policy for `authenticated` and **no** insert/update/delete policy for `authenticated` or `anon`
    - _Requirements: 4.1, 4.2, 13.3, 13.4_

  - [x] 4.4 `0005_diagnoses.sql`
    - Column set including `channel`, `model_provider`, and the storage reference columns
    - `diagnoses_unknown_shape` and `diagnoses_identified_shape` check constraints so an inconclusive row cannot carry a disease name or knowledge reference
    - The `(user_id, created_at desc)` history index and the conversation index, RLS enabled with own-row policies
    - _Requirements: 3.3, 6.4, 6.5, 12.1, 13.1, 13.2, 16.5_

  - [x] 4.5 `0006_usage_logs.sql`
    - Append-only audit columns: `operation`, `channel`, `model_provider`, `outcome`, `used_fallback`, `rejection_reason`, `quota_spent`, `latency_ms`, `prompt_version`, and the conversation/diagnosis references
    - RLS enabled with an own-row read policy
    - _Requirements: 5.7, 13.1, 13.2, 14.6, 14.7_
    - _Design: D10_

  - [x] 4.6 `0007_counters_and_quota_fn.sql`
    - `counters` keyed on `(user_id, operation, window_kind, window_key)` with a non-negative check
    - `counter_try_increment` as a single `insert … on conflict do update … where used < limit` statement returning the new count or null
    - `counter_decrement` with a `used > 0` guard, and `counter_used` as a stable read
    - RLS enabled with an own-row read policy; writes reachable only through the security-definer functions
    - _Requirements: 14.1, 14.2, 14.3_

  - [x] 4.7 `0008_whatsapp_inbound.sql`
    - `provider_message_id` as the primary key so the unique violation *is* the duplicate signal, plus `from_phone`, `user_id`, `message_type`, `status`, and timestamps
    - RLS **enabled with no policies at all**, so the table is unreachable for `anon` and `authenticated` while the service role bypasses RLS — `from_phone` is farmer PII, and a `public` table with RLS off is readable through the data API
    - _Requirements: 11.5, 11.6_

  - [x] 4.8 `0009_storage_buckets_policies.sql`
    - Create `crop-images` and `voice-messages` as private buckets
    - Per-bucket policies restricting `authenticated` read and write to objects whose first path segment equals the caller's user id
    - Do **not** create a `video-inputs` bucket
    - _Requirements: 13.5, 13.6_
    - _Depends on: V4_

  - [x] 4.9 `0010_seed_disease_knowledge.sql` seeding the five verified conditions
    - One row each for Tomato Early Blight, Tomato Late Blight, Tomato Healthy, Potato Early Blight, Potato Late Blight with symptoms, causes, treatment, prevention, and `default_severity` arrays
    - `source` populated per row with the verbatim extension-service citation — replace the design's `<extension-service citation - fill at implementation>` placeholders with real citations
    - Tomato Healthy carries an empty treatment array
    - `on conflict (disease_name) do nothing` so re-running is idempotent
    - _Requirements: 4.1, 4.2, 17.6_

  - [x] 4.10 Generate `src/types/database.ts` from the migrated schema
    - Run the Supabase type generator against the migrated database and commit the output
    - _Requirements: 17.8_
    - _Depends on: V1_

  - [x]* 4.11 Write integration tests for the knowledge base invariants
    - `select count(*) = 5 from disease_knowledge`
    - Tomato Healthy has an empty treatment array; the `healthy_has_no_treatment` constraint rejects a violating update
    - An authenticated (non-service-role) insert, update, and delete on `disease_knowledge` is denied
    - A `diagnoses` insert with `status = 'unknown'` and a non-null `disease_name` fails the check constraint
    - _Requirements: 4.1, 6.4, 6.5, 13.3, 13.4_

- [x] 5. Build the Supabase clients and storage helpers
  - [x] 5.1 Create `src/lib/supabase/{client,server,admin}.ts`
    - Browser client on the anon key, RLS-scoped server client wired to App Router cookies, and a service-role client that begins with `import 'server-only'`, is constructed inside a function, and throws when `typeof window !== 'undefined'`
    - _Requirements: 13.7_
    - _Depends on: V1_

  - [x] 5.2 Create `src/lib/storage.ts`
    - Path builder producing `{bucket}/{user_id}/{YYYY}/{MM}/{uuid}.{ext}`
    - `assertOwnership(ref, userId)` comparing the first path segment against the session user and probing object existence, throwing `STORAGE_REF_FORBIDDEN` on mismatch
    - Signed-URL minting with the expiry argument and units taken from the resolved value, used for both diagnosis reads and history thumbnails
    - _Requirements: 2.5, 2.6, 2.8, 12.5_
    - _Depends on: V3_

  - [x]* 5.3 Write property test for the ownership gate
    - **Property 5: Ownership is proven before anything is spent**
    - **Validates: Requirements 2.5, 2.6**

  - [x]* 5.4 Write unit tests for the service-role isolation
    - The admin client factory throws when a browser global is present
    - Importing the admin module from a `'use client'` module fails the build
    - _Requirements: 13.7_

- [x] 6. Implement phone OTP authentication, the profile bootstrap, and the auth gate
  - [x] 6.1 Build `src/components/SignInForm.tsx` and `src/app/page.tsx`
    - E.164 phone submission requesting an SMS OTP, then OTP verification establishing a session
    - A mismatched or expired code renders the `OTP_INVALID` message; a live session redirects to `/diagnose`
    - _Requirements: 1.1, 1.2, 1.3_
    - _Depends on: V2_

  - [x] 6.2 Implement `src/app/auth/callback/route.ts` with the idempotent profile upsert
    - Exchange the session, then upsert the profile defensively so the row exists even if the database trigger did not fire
    - Store the phone in E.164 form on the row whose `id` references `auth.users`
    - _Requirements: 1.4, 1.5_
    - _Design: D8; depends on V1 for the session-exchange call and the App Router cookie wiring_

  - [x] 6.3 Add the authentication gate over the protected surface
    - Session check redirecting the diagnosis, chat, voice, and history screens to sign-in
    - Session check in the API layer returning `AUTH_REQUIRED` with HTTP 401 and invoking no domain service
    - _Requirements: 1.6, 1.7_

  - [x] 6.4 Build `src/app/profile/page.tsx` with the display name and language form
    - Persist display name and preferred language to the farmer's profile and read them back on load
    - _Requirements: 1.8, 9.1_

  - [x]* 6.5 Write property test for cross-channel identity
    - **Property 1: Identity round-trip across channels**
    - **Validates: Requirements 1.4, 1.5, 1.8, 10.2**

  - [x]* 6.6 Write property test for the authentication gate
    - **Property 2: The authentication gate covers the whole protected surface**
    - **Validates: Requirements 1.6, 1.7**

- [x] 7. Checkpoint — Phase 1 foundation
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm `tsc --noEmit` is clean under strict mode and that every third-party call site references a resolved V-item.

### Phase 2 — Image diagnosis

- [x] 8. Build the AI gateway, provider adapters, and the classification prompt
  - [x] 8.1 Create `src/lib/ai/errors.ts` and `src/lib/ai/gateway.ts`
    - Capability-based routing for `vision-classify`, `text-generate`, `transcribe`, returning the value, the provider that served it, and a `usedFallback` flag
    - Fallback only on `RATE_LIMIT` or `UNAVAILABLE`; `OTHER` fails fast so an unrecognized error never doubles provider spend
    - A single exhausted-chain branch throwing `PROVIDERS_UNAVAILABLE`, so "no vision fallback configured" and "vision fallback also failed" are indistinguishable to callers
    - One per-request soft timeout budget constant expressed as a fraction of the confirmed duration ceiling, applied as an abort deadline on every provider call
    - _Requirements: 3.6, 14.4, 14.8_
    - _Depends on: V11, V16, V17_

  - [x] 8.2 Create `src/lib/gemini.ts`
    - Client initialization from `serverEnv`, the resolved multimodal model identifier, structured/JSON output configuration (response MIME type, response schema, lowest available temperature, max output tokens) set on the request rather than trusted to the prompt
    - `classifyError()` mapping the provider's real rate-limit and unavailability signals, defaulting to `OTHER`
    - _Requirements: 3.1, 14.4_
    - _Depends on: V6, V7, V11_

  - [x] 8.3 Create `src/lib/groq.ts` with the text fallback and the conditional vision member
    - Text model adapter for the `text-generate` chain and its `classifyError()`
    - Register a vision chain member **only** if V9 confirmed a vision-capable model; otherwise `providersFor('vision-classify')` returns a single-member chain and no other code changes
    - _Requirements: 14.4, 14.8_
    - _Depends on: V8, V9, V11_

  - [x] 8.4 Create `src/lib/prompts.ts` with the constrained classification prompt
    - Five-name-only contract, JSON-only output matching `visionRawSchema`, `unclear` for blurry or unjudgeable images, `no_plant` for images with no plant, `unclear` for any crop or condition outside the five, one condition for multi-leaf images, `Tomato Healthy` with severity `none`, and no treatment advice
    - A `PROMPT_VERSION` constant recorded on usage log rows
    - _Requirements: 3.1, 3.4, 3.5, 4.7, 5.6, 6.2, 6.3_

  - [x]* 8.5 Write unit tests for the fallback matrix
    - Primary `RATE_LIMIT` → fallback used and `usedFallback` true; primary `UNAVAILABLE` → fallback used
    - Primary `OTHER` → no fallback attempted
    - Single-member chain failing → `PROVIDERS_UNAVAILABLE`; exhausted two-member chain → the same error and the same branch
    - Abort deadline expiry surfaces `DIAGNOSIS_TIMEOUT`
    - _Requirements: 3.7, 14.4, 14.8_

  - [x]* 8.6 Write property test for the fallback chain outcome
    - **Property 21: The fallback chain either serves the request or reports the busy message**
    - **Validates: Requirements 14.4, 14.5, 14.8**

- [x] 9. Implement knowledge-base grounding and the rephrase path
  - [x] 9.1 Create `src/lib/knowledge.ts`
    - Lookup by canonical name returning the row's symptoms, causes, treatment, prevention, and source
    - Scope resolution helper returning the set of rows relevant to a condition or question, reusing `VERIFIED_CONDITIONS` from `schemas.ts` rather than redeclaring the list
    - _Requirements: 4.1, 4.3_

  - [x] 9.2 Add the rephrase prompt and post-generation validation to `src/lib/prompts.ts`
    - Request carries the knowledge-base arrays verbatim plus a rephrase-only instruction, with no agronomic content from any other source
    - Canonical name written in Latin script and never translated; treatment omitted entirely when the array is empty
    - Post-generation checks: non-empty within a length ceiling, canonical name present verbatim (repaired deterministically by prefixing rather than by re-calling the model), and a deny-list scan for out-of-scope condition names
    - On a failed length or emptiness check, fall back to a static localized template built from the knowledge-base row itself so the farmer still receives grounded content
    - _Requirements: 3.2, 4.3, 4.5, 4.6, 9.3, 9.4_

  - [x]* 9.3 Write property test for identified-result grounding
    - **Property 10: Identified results are grounded only in the matching knowledge base entry**
    - **Validates: Requirements 3.2, 3.5, 4.3, 4.5**

  - [x]* 9.4 Write property test for canonical name invariance
    - **Property 13: The canonical disease name is language-invariant**
    - **Validates: Requirements 4.6, 9.4**

- [x] 10. Implement the quota reserve/refund primitives the spend rule depends on
  - [x] 10.1 Create `src/services/quota.service.ts`
    - `reserve(userId, operation)` calling `counter_try_increment` with the Asia/Kolkata day key and the operation's limit (20 image / 50 chat / 20 voice), returning allowed-with-count or at-limit-with-reset
    - `refund(userId, operation)` calling `counter_decrement`, used only for failures that occur before the first provider call is attempted
    - `status(userId, operation)` returning used, limit, and `resetsAt` for the API response envelope
    - No channel component in the counter key, so web and WhatsApp share one limit
    - _Requirements: 14.1, 14.2, 14.3_

  - [x]* 10.2 Write quota atomicity tests against a real Postgres instance
    - Fire concurrent reserves at the limit boundary and assert the accepted total never exceeds the limit and no reservation is lost
    - Assert `counter_decrement` never drives `used` below zero
    - Assert a new window key starts at zero without any reset job
    - _Requirements: 14.1, 14.2_

  - [x]* 10.3 Write unit tests for the spend rule's pre-provider cases
    - Ownership rejection (HTTP 403) leaves the counter unchanged and calls no provider
    - A failure before the first provider call (signed-URL issuance, unreadable object, knowledge-base read) is refunded to zero and logs `quota_spent = false`
    - Quota already exhausted declines with the limit and reset time and calls no provider
    - _Requirements: 2.6, 14.3_

- [x] 11. Implement the DiagnosisService and the diagnose endpoint
  - [x] 11.1 Create `src/services/conversation.service.ts`
    - `findOrCreateActive(userId, channel)` returning the most recently updated conversation for that channel, creating one when none exists
    - Web and WhatsApp conversations are separate rows so the two threads never bleed into each other
    - _Requirements: 7.5, 10.5, 10.8_

  - [x] 11.2 Create `src/services/diagnosis.service.ts` as the single image-analysis implementation
    - Ordered pipeline: ownership check → burst check seam → quota reserve → signed URL → `vision-classify` → stage 1 shape validation → stage 2 knowledge-base membership → grounding and rephrase for identified results → persistence → usage log
    - All non-identified causes (out-of-knowledge-base name, `unclear`, `no_plant`, and every schema failure) collapse into the one inconclusive shape with a distinct logged `rejection_reason`, static localized copy, and no further model call
    - Discard the rejected model's disease name and confidence entirely; never re-ask the model to repair its output
    - `channel` is a required input parameter and is written to every persisted row
    - _Requirements: 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.8, 5.1, 5.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 16.1, 16.3, 16.5_
    - _Design: D2, D3, D4, D7_

  - [x] 11.3 Create `src/app/api/diagnose/route.ts`
    - JSON body carrying a storage reference, language, and optional conversation id — no multipart, no media bytes
    - Session check → Zod parse → language validation → single service call → result or localized error envelope
    - Route segment `maxDuration` set from the confirmed platform maximum; a budget expiry returns `DIAGNOSIS_TIMEOUT` and logs `outcome = 'timeout'`
    - _Requirements: 1.7, 2.2, 3.7, 9.5, 15.3_
    - _Design: D1; depends on V16, V17_

  - [x]* 11.4 Write property test for the single inconclusive shape
    - **Property 8: All non-identified outcomes collapse into one inconclusive shape**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**

  - [x]* 11.5 Write property test for the inconclusive spend rule
    - **Property 9: An inconclusive result costs exactly one unit and no extra model call**
    - **Validates: Requirements 6.6, 6.7**

  - [x]* 11.6 Write property test for rejection attribution
    - **Property 7: Every rejection is attributable and its content is discarded**
    - **Validates: Requirement 5.7**

  - [x]* 11.7 Write property test for the healthy classification
    - **Property 12: A healthy classification carries no treatment content**
    - **Validates: Requirement 3.4**

- [x] 12. Build the upload flow and result rendering
  - [x] 12.1 Create `src/components/ImageUploader.tsx`
    - A real `<input type="file">` with a `<label>`, validating MIME against `image/jpeg | image/png | image/webp` and size against 10 MB, stating both the accepted types and the limit on rejection
    - Direct browser upload to `crop-images/{user_id}/{YYYY}/{MM}/{uuid}.{ext}`, then POST of the reference only
    - An upload failure reports the upload error and sends no diagnosis request; the submit control is disabled while a request is in flight
    - _Requirements: 2.1, 2.3, 2.4, 2.7, 15.5_

  - [x] 12.2 Create `src/components/DiagnosisResultCard.tsx` and `src/app/diagnose/page.tsx`
    - Server shell resolving session and preferred language; client result card rendering severity, confidence, and the needs-expert banner
    - Because `knowledge` is `null` on the inconclusive branch, the compiler prevents rendering treatment text for an inconclusive result
    - Honest loading states bound to real request state: exactly `Jamee is analyzing your crop image…` while the diagnosis request is open, indeterminate spinners where real progress is unavailable, and no interval-driven percentage anywhere
    - Result region as an `aria-live="polite"` landmark
    - _Requirements: 6.4, 6.5, 15.1, 15.2_

  - [x] 12.3 Create `src/components/LanguageSwitcher.tsx` and wire language propagation
    - Offer English, Hindi, Marathi; default from the profile's preferred language
    - Include the selected code in every diagnosis, chat, and voice request
    - _Requirements: 9.1, 9.2_

  - [x]* 12.4 Write unit tests for image admission and upload sequencing
    - Accepted and rejected type/size combinations at the 10 MB boundary, each rejection naming the accepted types and the limit
    - A failed upload produces an upload error and issues no diagnosis request
    - The posted request body contains a storage reference and no media bytes
    - _Requirements: 2.1, 2.3, 2.4, 2.7, 15.5_

- [x] 13. Build the diagnosis history screens
  - [x] 13.1 Create `src/app/history/page.tsx` with `HistoryList` and `EmptyState`
    - Server component querying under RLS, listing reverse-chronologically with thumbnail, condition or inconclusive label, severity, channel, and timestamp
    - Thumbnails loaded through server-minted signed URLs; WhatsApp-originated diagnoses included
    - Empty state inviting a first upload
    - _Requirements: 12.1, 12.2, 12.4, 12.5_

  - [x] 13.2 Create `src/app/diagnosis/[id]/page.tsx`
    - Detail view with the image, condition or inconclusive label, confidence, severity, full explanation, and the related conversation messages
    - _Requirements: 12.3, 12.5_

  - [x]* 13.3 Write property test for history completeness and ordering
    - **Property 26: History is complete, ordered, and detailed**
    - **Validates: Requirements 12.1, 12.2, 12.3**

- [x] 14. Checkpoint — Phase 2 image diagnosis
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm a diagnosis request body stays at reference size regardless of image size, and that no inconclusive path issues a second model call.

### Phase 3 — Chat with conversation context

- [x] 15. Implement the ChatService and the chat endpoint
  - [x] 15.1 Build conversation context assembly in `src/services/chat.service.ts`
    - Context keyed on the conversation identifier: the last N messages bounded by a token budget plus that conversation's most recent diagnosis
    - Reads scoped by conversation and farmer so no other conversation's messages can enter the window
    - _Requirements: 7.1, 7.2_

  - [x] 15.2 Add the chat prompt, scope resolution, and the honest-referral path
    - Resolve the in-scope knowledge-base rows first; when the resolution set is empty, return the static localized coverage message with `needsExpert: true` and make **no** model call
    - Chat prompt supplies only the resolved rows, resolves subject-less questions against the current diagnosis, answers in the language of the farmer's message when it is en/hi/mr, keeps the canonical name in Latin script, and adds no new agricultural facts
    - Reuse the same grounding and rephrase implementation as the diagnosis path — one implementation, not a parallel copy
    - _Requirements: 4.4, 4.5, 4.7, 7.3, 7.6, 7.7, 9.3, 9.6, 16.4_
    - _Design: D9_

  - [x] 15.3 Create `src/app/api/chat/route.ts` and message persistence
    - Session check, Zod parse, language validation, single service call
    - The same ordered spend rule as the diagnosis path — burst check seam, then a `chat` reserve — taken here because chat is the entry point for this request; a chat answer produced inside a voice request reserves nothing
    - Persist exactly one farmer message and one Jamee answer in the same conversation with the correct roles, language, channel, and `input_kind`
    - _Requirements: 1.7, 7.4, 9.5, 14.1, 16.2, 16.5_

  - [x]* 15.4 Write property test for conversation context isolation
    - **Property 15: Conversation context is complete for its conversation and isolated from every other**
    - **Validates: Requirements 7.1, 7.2**

  - [x]* 15.5 Write property test for subject-less follow-ups
    - **Property 16: Subject-less follow-ups resolve to the latest diagnosis on either channel**
    - **Validates: Requirements 7.3, 10.8**

  - [x]* 15.6 Write property test for chat answer grounding
    - **Property 11: Chat answers are grounded only in resolved knowledge base entries**
    - **Validates: Requirements 4.4, 4.5**

  - [x]* 15.7 Write property test for out-of-scope referrals
    - **Property 14: Questions outside verified knowledge yield an honest referral**
    - **Validates: Requirements 4.7, 7.6**

  - [x]* 15.8 Write property test for conversation and message persistence
    - **Property 17: Conversation and message persistence round-trips, carrying the channel**
    - **Validates: Requirements 3.3, 7.4, 7.5, 16.5**

- [x] 16. Build the chat interface and complete multilingual output
  - [x] 16.1 Create `src/components/ChatThread.tsx`, `src/components/ChatComposer.tsx`, and `src/app/chat/page.tsx`
    - Server shell loading the conversation and messages under RLS; client composer with an optimistic farmer bubble and a server-confirmed answer
    - "Jamee is thinking…" bound to the open request, never to a timer
    - _Requirements: 15.2, 15.4_

  - [x] 16.2 Enforce language handling at the API edge and in responses
    - Reject any code outside `en`, `hi`, `mr` with HTTP 400 naming the three supported codes in `details.supportedLanguages`
    - Echo the resolved language on every response; render explanations in that language with the canonical name untranslated
    - _Requirements: 9.2, 9.3, 9.4, 9.5_

  - [x]* 16.3 Write property test for language propagation and refusal
    - **Property 19: Language codes propagate, and unsupported codes are refused at the edge**
    - **Validates: Requirements 9.2, 9.3, 9.5, 9.6**

- [x] 17. Checkpoint — Phase 3 chat
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm a subject-less follow-up resolves against the latest diagnosis in its own conversation and that an out-of-scope question makes no model call.

### Phase 4 — Voice input

- [x] 18. Implement transcription and the VoiceService
  - [x] 18.1 Add the transcription adapter for the `transcribe` capability
    - Client, endpoint or SDK method, and model identifier from the resolved values; accepted container/codec list and the provider's own size and duration caps enforced before upload
    - English, Hindi, and Marathi supported; no fallback provider in this release, so an exhausted chain surfaces `TRANSCRIPTION_FAILED` as retryable
    - _Requirements: 8.4, 8.5_
    - _Depends on: V10_

  - [x] 18.2 Create `src/services/voice.service.ts`
    - Ownership check → quota reserve → signed URL → transcription → non-empty transcript handed to the ChatService verbatim as the farmer message with `input_kind = 'voice'` and the audio path recorded
    - An empty or whitespace-only transcript returns `TRANSCRIPT_EMPTY` asking the farmer to record again somewhere quieter, and produces no chat answer
    - The nested ChatService call performs **no** reserve of its own: the voice unit already reserved covers the answer, so one voice message never spends both a voice unit and a chat unit
    - Text answers only; no synthesized speech
    - _Requirements: 8.4, 8.6, 8.7, 8.8, 14.1_

  - [x] 18.3 Create `src/app/api/voice/route.ts`
    - JSON body carrying a `voice-messages` storage reference, language, conversation id, and the measured duration re-checked server-side against 120 seconds
    - Response returns both the transcript and the answer
    - _Requirements: 8.1, 8.2, 8.3, 8.6, 9.5_

  - [x]* 18.4 Write property test for the voice pipeline
    - **Property 18: The voice pipeline preserves the transcript and handles an empty one**
    - **Validates: Requirements 8.4, 8.6, 8.7**

- [x] 19. Build the voice recorder and voice screen
  - [x] 19.1 Create `src/components/VoiceRecorder.tsx`
    - Hold-to-speak with `MediaRecorder`, a hard 120 second stop, a visible countdown from 100 seconds, and a 10 MB post-stop rejection stating both limits
    - Pick the recording MIME type from a preference list intersected with the transcription provider's accepted containers, with a clear message when the browser offers none
    - Keyboard-operable equivalent (tap to start, tap to stop) alongside press-and-hold
    - Direct upload to `voice-messages/{user_id}/…`, then POST of the reference and measured duration only
    - _Requirements: 8.1, 8.2, 8.3_
    - _Depends on: V10, V20_

  - [x] 19.2 Create `src/app/voice/page.tsx`
    - Transcript rendered above the answer; a listening state indicating that Jamee is listening to the recording while transcription is in flight
    - _Requirements: 8.6, 8.8, 15.7_

  - [x]* 19.3 Write property test for media admission across both input kinds
    - **Property 3: Client-side media admission is exactly the stated limits**
    - **Validates: Requirements 2.3, 2.4, 8.2, 8.3**

  - [x]* 19.4 Write property test for the upload boundary across both input kinds
    - **Property 4: The upload boundary never carries media bytes and never runs ahead of a failed upload**
    - **Validates: Requirements 2.1, 2.7, 8.1, 15.5**

- [x] 20. Checkpoint — Phase 4 voice
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm the recorded container matches the transcription provider's accepted list from the resolved values.

### Phase 5 — WhatsApp channel

- [x] 21. Implement webhook verification, signature checking, and idempotency
  - [x] 21.1 Create `src/lib/whatsapp.ts` verification helpers
    - GET challenge: timing-safe comparison of the presented verify token against the configured value, echoing the challenge with 200 on match and 403 on mismatch
    - `verifySignature(rawBody, header, appSecret)` using the resolved header name, HMAC algorithm, and encoding, with a constant-time digest comparison
    - Inbound payload Zod schema using the resolved field paths for text, image, audio, and the message id
    - _Requirements: 11.1, 11.2, 11.3_
    - _Depends on: V12, V13_

  - [x] 21.2 Create `src/app/api/whatsapp/route.ts`
    - POST reads the body **once as text**, verifies the signature over those exact bytes, and only then parses — never `request.json()` before verification
    - A failing signature returns HTTP 401 and invokes no shared service; an unparseable but signed payload is acknowledged with 200 and ignored
    - _Requirements: 11.3, 11.4_

  - [x] 21.3 Create `src/lib/db/whatsapp-inbound.ts` with insert-before-work idempotency
    - Insert the `provider_message_id` before anything billable; treat the unique violation as the duplicate signal with no select-then-insert
    - A duplicate logs `duplicate_ignored`, returns 200, invokes no service, and leaves the counter unchanged
    - Because the insert precedes profile resolution and `usage_logs.user_id` is `not null`, the duplicate row takes its `user_id` from the conflicting `whatsapp_inbound` row; when that column is null the duplicate is recorded by the inbound status alone and no usage row is written
    - Status transitions to `processed`, `failed`, or `rejected` as the outcome resolves
    - _Requirements: 11.5, 11.6_

  - [x]* 21.4 Write unit tests for HMAC signature verification
    - A valid signature passes; a flipped byte, a truncated digest, an absent header, a wrong secret, and a re-serialized body all fail
    - Comparison is constant-time and verification precedes parsing, profile resolution, and every service call
    - _Requirements: 11.3, 11.4_

  - [x]* 21.5 Write concurrency tests for idempotency and the duplicate spend rule
    - Two concurrent inserts of the same `provider_message_id`: one proceeds, one is dropped, with no second service call and no second reply
    - A redelivery spends zero quota and produces no provider call
    - _Requirements: 11.5, 11.6_

  - [x]* 21.6 Write property test for webhook authentication and single processing
    - **Property 23: The webhook rejects everything it cannot authenticate, and processes each delivery once**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6**

- [x] 22. Implement inbound routing, media handling, and replies
  - [x] 22.1 Add media download and service-role upload to `src/lib/whatsapp.ts`
    - Two-step retrieval (media id → media URL → authenticated binary fetch) using the resolved auth header
    - Upload with the service-role client under `crop-images/{profile.id}/…` or `voice-messages/{profile.id}/…` so the object stays readable later by that farmer's own session
    - Content type and size checked against the same limits as the web path before upload; an oversized or unsupported item gets a plain-language reply and spends nothing
    - _Requirements: 10.4, 10.6, 13.6_
    - _Depends on: V14_

  - [x] 22.2 Implement dispatch, replies, and the ordered inbound pipeline
    - Resolve `profiles.phone` to a profile; an unresolvable number receives sign-in instructions, is marked `rejected`, acknowledges 200, and spends nothing
    - A type outside text, image, and audio receives a reply naming photos, text, and voice notes, with no service call and no quota change
    - Image → DiagnosisService, text → ChatService with the active WhatsApp conversation, audio → VoiceService, each with `channel: 'whatsapp'`
    - Send the reply text through the resolved send-message endpoint, then mark the inbound row `processed` and acknowledge 200
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.11, 16.1, 16.2, 16.5_
    - _Depends on: V15_

  - [x] 22.3 Add the soft deadline and the acknowledgement strategy
    - Process inline in one invocation then acknowledge, using the same budget constant as the gateway
    - On deadline expiry, reply that Jamee is taking longer than usual and to send the photo again, mark the row `failed`, and return 200 so the audit stays honest
    - If the resolved values confirmed a supported continuation primitive, acknowledge immediately after the idempotency insert and move the remaining steps into the continuation — no service change either way
    - _Requirements: 10.10, 10.11_
    - _Design: D11; depends on V16, V18_

  - [x]* 22.4 Write property test for inbound routing and acknowledgement
    - **Property 24: Inbound WhatsApp messages are routed by type and always acknowledged**
    - **Validates: Requirements 10.3, 10.4, 10.5, 10.6, 10.9, 10.11**

  - [x]* 22.5 Write property test for channel parity
    - **Property 25: Channel parity of diagnosis content**
    - **Validates: Requirement 10.7**

- [x] 23. Checkpoint — Phase 5 WhatsApp
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm the idempotency insert sits above profile resolution, quota reserve, and every provider call.

### Phase 6 — Production polish

- [x] 24. Complete the quota surface, burst rate limiting, and usage auditing
  - [x] 24.1 Create `src/lib/rate-limit.ts` and wire it ahead of every reserve
    - Minute-window burst limiter using `counters` with `window_kind = 'minute'` and its own per-operation ceiling, independent of the daily quota
    - Applied to the diagnosis, chat, and voice endpoints at the step before the reserve, returning `RATE_LIMITED` with HTTP 429 and never incrementing the daily counter
    - A periodic prune of minute rows
    - _Requirements: 13.8_

  - [x] 24.2 Complete the quota decline path
    - `QUOTA_EXCEEDED` with HTTP 429 carrying the limit, used count, and Asia/Kolkata reset time in `details`, rendered from the static catalogs in all three languages
    - No provider is invoked once a limit is reached; document in `docs/API.md` that a web retry after an error spends a new unit since no client idempotency key exists
    - _Requirements: 14.1, 14.2, 14.3_
    - _Design: D5_

  - [x] 24.3 Complete usage-log writes across every outcome
    - One row per completed model operation recording farmer, operation, channel, provider, and outcome; `used_fallback` set whenever the gateway served from the fallback
    - `rejection_reason` for validation rejections, `quota_spent` for the spend-rule audit, `latency_ms`, `outcome = 'timeout'` on budget expiry, and `duplicate_ignored` for redeliveries
    - _Requirements: 3.7, 5.7, 14.6, 14.7_
    - _Design: D10_

  - [x]* 24.4 Write property test for daily quotas across channels
    - **Property 20: Daily quotas are never exceeded and are shared across channels**
    - **Validates: Requirements 14.1, 14.2, 14.3**

  - [x]* 24.5 Write property test for burst limiting order
    - **Property 28: Burst rate limiting precedes any quota spend**
    - **Validates: Requirement 13.8**

  - [x]* 24.6 Write property test for audit completeness
    - **Property 22: Every model operation leaves a complete audit row**
    - **Validates: Requirements 14.6, 14.7**

- [x] 25. Complete the error taxonomy end to end
  - [x] 25.1 Wire `withErrorHandling` across every route and add `src/components/ErrorBanner.tsx`
    - Every non-2xx response uses the single envelope with a stable code, localized message, accurate retryable flag, and structured details
    - `ErrorBanner` as `role="alert"` rendering the returned message and offering a retry action for the failed operation
    - Unhandled errors return HTTP 500 with a generic message, logging the real cause server-side only
    - _Requirements: 15.3, 15.4, 15.6_

  - [x] 25.2 Complete localization of every taxonomy code in `src/lib/messages/{en,hi,mr}.ts`
    - Every code in the taxonomy has a non-empty message in all three languages
    - `PROVIDERS_UNAVAILABLE` renders in `en` as exactly `Jamee is temporarily busy. Please try again shortly.`
    - Inconclusive results stay a successful 200 carrying `status: 'unknown'` and are absent from the error taxonomy
    - _Requirements: 6.4, 14.5, 15.3_
    - _Design: D6_

  - [x]* 25.3 Write unit tests for error mapping in all three languages
    - Every code yields its documented HTTP status, retryable flag, and a non-empty message in `en`, `hi`, and `mr`
    - The `en` `PROVIDERS_UNAVAILABLE` string matches byte-for-byte
    - An error carrying a stack trace or a provider payload produces a body containing neither
    - _Requirements: 14.5, 15.3, 15.4, 15.6_

- [x] 26. Complete mobile layout and accessibility
  - [x] 26.1 Apply the mobile-first layout across every screen
    - Single column, tap targets at least 44×44 px, primary actions in thumb reach, body text in relative units so it scales with the OS setting
    - Verify Devanagari rendering for Hindi and Marathi against the layout font stack
    - _Requirements: 9.1, 9.3_
    - _Design: Frontend — Mobile layout and accessibility_

  - [x] 26.2 Apply the accessibility specifics across components
    - Visible label plus accessible name on every control; the upload input a real labelled file input rather than a click-handled div
    - `aria-live="polite"` result region, `role="alert"` error banners, loading state as real text and not only a spinner
    - Severity conveyed by label text and icon, never colour alone; contrast targeting WCAG 2.1 AA; the recorder keyboard-operable
    - _Requirements: 15.1, 15.2, 15.4_
    - _Design: Frontend — Mobile layout and accessibility_

  - [x]* 26.3 Add automated accessibility checks to the test suite
    - Run an automated accessibility scan over the sign-in, diagnose, chat, voice, history, and detail screens and fail on violations
    - Record in the test output that full WCAG conformance also requires the manual screen-reader pass tracked in task 30.1
    - _Requirements: 15.1, 15.4_

- [x] 27. Harden and verify the security boundary
  - [x] 27.1 Create `scripts/check-secret-scope.ts` as a CI guard
    - Assert `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, and every WhatsApp secret appear only under server modules in `src/lib/**` and `src/app/api/**`, and never in a file containing `'use client'`
    - Assert no `process.env` access outside `src/lib/env.ts`, and that every service-role query carries an explicit `user_id` predicate
    - _Requirements: 13.7_

  - [x]* 27.2 Write property test for tenant isolation
    - **Property 27: Tenant isolation holds across tables, storage, and the knowledge base**
    - **Validates: Requirements 13.2, 13.4, 13.6**

  - [x] 27.3 Create `scripts/check-shared-implementation.ts` as a CI guard
    - Assert exactly one `DiagnosisService` module and one `ChatService` module exist, and that both the route handlers and the WhatsApp adapter import them rather than reimplementing image analysis, grounding, or rephrasing
    - Assert nothing under `src/services/**` or `src/lib/**` imports from `src/app/**`, which is the one-way rule that keeps the single-implementation claims true as the codebase grows
    - Assert no training or fine-tuning call exists anywhere in the codebase
    - _Requirements: 3.8, 7.7, 16.1, 16.2, 16.3, 16.4_
    - _Design: Static architecture check (CI)_

- [x] 35. Implement the retention sweep and its scheduled trigger
  - [x] 35.1 Create `src/services/retention.service.ts` and its scheduled entry point
    - Read the Retention_Window from `MEDIA_RETENTION_DAYS` in `src/lib/config/media.ts` — a whole number of days declared in exactly one place, and the same window that governs a voice object whose transcription failed or returned empty
    - Scan 1, row-driven: `select id, user_id, image_bucket, image_path from diagnoses where full_image_deleted_at is null and created_at < now() - (retention_days || ' days')::interval order by created_at limit N`, served by the partial retention index from 4.4; per row assert the path's first segment equals that row's `user_id`, delete the Full_Size_Image, then stamp `full_image_deleted_at` leaving every other column of the row unchanged
    - Scan 2, the age-driven orphan backstop over `storage.objects` for both buckets: exclude any `crop-images` path carrying the `.thumb.` infix so every Thumbnail_Derivative is retained, and delete the remainder past the window under its own first path segment only
    - Idempotent by construction, because the platform's scheduled delivery can fire the same run more than once and does not retry a failed one: the `full_image_deleted_at is null` predicate excludes anything a previous run stamped, and a path absent from the delete call's returned entries counts as already deleted rather than as a failure, so a doubled, late, or missed run is harmless
    - Both scans bounded per invocation by `RETENTION_SWEEP_BATCH_LIMIT` inside the duration ceiling, every deletion issued from a server-side module with the service role, and no row of `diagnoses`, `messages`, `conversations`, or `usage_logs` deleted by any path
    - Entry point `src/app/api/internal/retention-sweep/route.ts` exporting `maxDuration = 60` and both verbs behind one constant-time secret comparison — `GET` for the platform's scheduled invocation, `POST` for the manual run — where a missing, wrong, or absent secret is HTTP 401 with no deletion attempted and no detail in the body, and the route consults no Supabase session, so a valid farmer session grants nothing on this path
    - Scan 2 depends on V22's object-age surface and ships switched off behind `RETENTION_ORPHAN_SCAN_ENABLED`: until V22 resolves, only the row-driven scan runs, and the row-driven scan alone satisfies Requirements 18.3 and 18.7 for every object a farmer can surface
    - Record the manual trigger in `docs/DEPLOYMENT.md` (task 28.1) as a named operational step with the exact request, so an unavailable schedule or a missed run still leaves the sweep runnable by hand
    - _Requirements: 18.1, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10, 18.11, 18.12, 18.13_
    - _Depends on: V21, V22_
    - _Design: Media lifecycle and retention_

  - [x]* 35.2 Write property test for tenant isolation over deletion
    - **Property 31: Tenant isolation holds over deletion**
    - **Validates: Requirement 18.8**

- [x] 28. Produce the deployment package
  - [x] 28.1 Write `docs/DEPLOYMENT.md`
    - The nine ordered steps: create the Supabase project and record keys; enable phone OTP and configure the SMS provider; run the migrations and assert the knowledge-base and bucket checks; obtain provider keys and record the resolved model identifiers; create the Meta app and WhatsApp number and pin the API version; deploy to Vercel with all variables and confirm the permitted `maxDuration`; register the webhook callback and verify token; run the release acceptance sequence on a phone; record free-tier headroom for 6 farmers
    - Every external account, dashboard, and business-verification step lives here as written procedure — none of it is an implementation task
    - Append the resolved values-to-verify table by reference to `docs/VERIFIED_VALUES.md`
    - _Requirements: 17.1, 17.3_
    - _Depends on: V2, V4, V16, V19_

  - [x] 28.2 Generate `docs/API.md` from the Zod schemas
    - Per endpoint: HTTP method, request body schema, response body schema, and error codes, generated from `src/lib/schemas.ts` so the document cannot drift
    - Include the quota semantics note from 24.2
    - _Requirements: 17.4_

  - [x] 28.3 Complete `.env.example`
    - Every key in the server environment schema listed with a placeholder and no live credential
    - _Requirements: 17.2_

  - [x] 28.4 Create `scripts/check-deployment.ts`
    - Assert `select count(*) = 5 from disease_knowledge` and that every row has a non-empty `source`
    - Assert both `crop-images` and `voice-messages` exist and are private, and that RLS is enabled on `profiles`, `conversations`, `messages`, `diagnoses`, `usage_logs`, `counters`, and `whatsapp_inbound`
    - Assert the webhook GET returns 200 for the configured token and 403 for a wrong one
    - _Requirements: 4.1, 4.2, 13.1, 13.5, 17.6_

  - [x]* 28.5 Write property test for deliverable completeness
    - **Property 30: Deliverable completeness over the environment and endpoint sets**
    - **Validates: Requirements 17.2, 17.4**

  - [x] 28.6 Add the CI release gates
    - `tsc --noEmit` under strict mode with zero errors, the unit/property/integration suites, `scripts/check-secret-scope.ts`, `scripts/check-shared-implementation.ts`, and the accessibility scan
    - _Requirements: 17.8_

- [x] 29. Build the integration test suite over the requirements' scenario matrix
  - [x] 29.1 Create the integration test harness
    - Mock providers at the adapter seam so the gateway, services, validation, persistence, and RLS are all real against a real Postgres instance
    - Fixtures for two farmers with RLS-scoped clients, a service-role client, seeded knowledge-base rows, and deterministic classification stubs
    - _Requirements: 17.5_

  - [x]* 29.2 Write image scenario integration tests
    - Healthy crop, clear diseased crop, blurry image, non-plant image, tomato and potato crops, multiple leaves in one image
    - _Requirements: 3.2, 3.4, 3.5, 6.1, 6.2, 6.3_

  - [x]* 29.3 Write chat scenario integration tests
    - English, Hindi, Marathi, a subject-less follow-up, and an unknown question
    - _Requirements: 7.1, 7.3, 7.6, 9.3, 9.6_

  - [x]* 29.4 Write voice scenario integration tests
    - Short recording, long recording at the 120 second boundary, empty transcript, and a noisy-audio transcript
    - _Requirements: 8.2, 8.3, 8.7_

  - [x]* 29.5 Write WhatsApp scenario integration tests
    - Text, image, audio, invalid message type, duplicate delivery, soft-deadline timeout, and a provider rate limit driving the fallback
    - _Requirements: 10.4, 10.5, 10.6, 10.9, 10.10, 11.5, 14.4, 14.5_

- [x] 30. Create the manual validation record
  - [x] 30.1 Create `docs/TESTING_REPORT.md` with the automated results and the manual matrix
    - Record the outcomes of the image, chat, voice, and WhatsApp automated scenario suites
    - Add structured, empty-result entries for the four items that **require human testers and cannot be executed by a coding agent**: real SMS OTP delivery through the configured provider (Requirement 1.1); Hindi and Marathi transcription quality on real farmer speech with field background noise (Requirement 8.5); WhatsApp end to end from a real handset including a follow-up and confirmation that the same content appears in web history (Requirements 10.7, 12.2); and a screen-reader and mobile-device accessibility pass
    - Each manual entry states what the tester does, what result to record, and which requirement it evidences
    - _Requirements: 17.5_

- [x] 31. Verify the release acceptance sequence
  - [x] 31.1 Encode the automatable release acceptance steps as an end-to-end test
    - With mocked providers and a real database: upload a crop image and receive a knowledge-base-grounded result; ask a follow-up in the same conversation that resolves against that diagnosis; receive Hindi and Marathi explanations with the canonical name unchanged; submit a voice message and receive a text answer; open history and see both web and WhatsApp diagnoses plus one detail view; assert every agricultural sentence traces to a knowledge-base row
    - Release acceptance step 8's "no model training" half is asserted statically by `scripts/check-shared-implementation.ts` (task 27.3) rather than at runtime, since absence of a call is a codebase property
    - _Requirements: 3.2, 4.6, 7.3, 8.6, 9.3, 12.1, 12.2, 12.3_

  - [x] 31.2 Record the human-tester acceptance steps in `docs/TESTING_REPORT.md`
    - Steps 1 and 6 of the release acceptance sequence — signing in with a real SMS passcode, and sending a crop photo on WhatsApp from the same phone number and comparing the result with the web output — recorded as tester-executed entries with the expected observation for each
    - _Requirements: 1.1, 10.7, 17.5_

- [x] 32. Final checkpoint — release readiness
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm `tsc --noEmit` is clean, `scripts/check-deployment.ts` and `scripts/check-secret-scope.ts` pass, no V-item remains unresolved in `docs/VERIFIED_VALUES.md`, and `docs/TESTING_REPORT.md` shows every human-tester entry either completed or explicitly outstanding.

### OPTIONAL / DEFERRED — not part of release acceptance

- [ ] 33. OPTIONAL / DEFERRED — Video frame analysis (Requirement 18)
  - Deferred by the requirements. Not release work, not part of the release acceptance criteria, and not to be implemented as part of this plan. The `video-inputs` bucket is deliberately not created in this release.
  - [ ]* 33.1 Add a `video-inputs` private bucket migration and browser-direct video upload
    - _Requirements: 18.1_
  - [ ]* 33.2 Add frame sampling ahead of the existing classification and grounding path, reducing N frames to one result
    - _Requirements: 18.2_

- [ ] 34. OPTIONAL / DEFERRED — Expert video calling (Requirement 19)
  - Deferred by the requirements. Not release work and not part of the release acceptance criteria. The `needs_expert` flag persisted on every inconclusive diagnosis is the only seam this release provides.
  - [ ]* 34.1 Add a peer-to-peer video session between a farmer and an available expert
    - _Requirements: 19.1_
  - [ ]* 34.2 Offer an expert-session action on results carrying `needs_expert`
    - _Requirements: 19.2_

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. Every property and unit test task is marked optional; every implementation task is not.
- **The V-item rule holds for the whole plan.** Task 1 resolves V1–V20 into `docs/VERIFIED_VALUES.md`, and each later task names the V-items it depends on. No task may code against a guessed SDK name, model identifier, header name, error shape, or platform limit — an unresolved item must fail loudly at startup instead.
- V9 (whether a vision-capable Groq model exists) is the single fact that decides whether the `vision-classify` chain has a fallback member. Task 8.1's exhausted-chain branch is written so a one-member chain and a failed two-member chain are indistinguishable to callers, which is what makes Requirement 14.8 hold either way.
- Quota counter primitives ship in Phase 2 (tasks 4.6 and 10.1) because the diagnosis spend rule depends on them. Phase 6 completes the surface: burst limiting, decline messaging, audit completeness, and the cross-channel quota properties that only become testable once WhatsApp exists.
- All 31 correctness properties from the design have exactly one property-test sub-task, placed next to the code they constrain. Properties 3, 4, 17, 20, and 27 sit later than their first implementation because they span two channels or two media paths and are only meaningful once both exist.
- Spend-rule coverage is split across three tasks by what each can observe: 403-leaves-zero in 5.3 and 10.3, inconclusive-costs-exactly-one in 11.5, duplicate-delivery-costs-zero in 21.5.
- External setup work — Supabase project creation, SMS provider enablement, Meta app and business verification, Vercel project configuration — appears only as written procedure in `docs/DEPLOYMENT.md` (task 28.1), never as an implementation task.
- Manual validation items in task 30.1 and 31.2 require human testers. The coding work is creating and structuring `docs/TESTING_REPORT.md`; the observations themselves cannot be produced by a coding agent.
- Tasks 33 and 34 are deferred by the requirements and form no part of release acceptance. Task 32 is the release gate.
- The dependency graph below covers the release plan only. Checkpoint tasks (7, 14, 17, 20, 23, 32) are excluded because they are gates rather than work, and the deferred tasks (33, 34) are excluded because they are not release work — nothing in the graph should schedule them.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2", "4.1", "4.3"] },
    { "id": 3, "tasks": ["2.3", "3.1", "4.2", "4.4", "4.5"] },
    { "id": 4, "tasks": ["3.2", "3.3", "4.6", "4.7", "4.8"] },
    { "id": 5, "tasks": ["3.4", "3.5", "4.9", "5.1"] },
    { "id": 6, "tasks": ["3.6", "3.7", "4.10", "5.2"] },
    { "id": 7, "tasks": ["3.8", "4.11", "5.3", "5.4", "6.1"] },
    { "id": 8, "tasks": ["6.2", "6.3"] },
    { "id": 9, "tasks": ["6.4", "6.5", "6.6", "8.1"] },
    { "id": 10, "tasks": ["8.2", "8.3", "8.4", "9.1"] },
    { "id": 11, "tasks": ["8.5", "8.6", "9.2", "10.1"] },
    { "id": 12, "tasks": ["9.3", "9.4", "10.2", "11.1"] },
    { "id": 13, "tasks": ["10.3", "11.2"] },
    { "id": 14, "tasks": ["11.3", "12.1"] },
    { "id": 15, "tasks": ["11.4", "11.5", "11.6", "11.7", "12.2", "12.3"] },
    { "id": 16, "tasks": ["12.4", "13.1"] },
    { "id": 17, "tasks": ["13.2", "15.1"] },
    { "id": 18, "tasks": ["13.3", "15.2"] },
    { "id": 19, "tasks": ["15.3", "16.1"] },
    { "id": 20, "tasks": ["15.4", "15.5", "15.6", "15.7", "15.8", "16.2"] },
    { "id": 21, "tasks": ["16.3", "18.1"] },
    { "id": 22, "tasks": ["18.2", "19.1"] },
    { "id": 23, "tasks": ["18.3", "19.2"] },
    { "id": 24, "tasks": ["18.4", "19.3", "19.4", "21.1"] },
    { "id": 25, "tasks": ["21.2", "21.3"] },
    { "id": 26, "tasks": ["21.4", "21.5", "21.6", "22.1"] },
    { "id": 27, "tasks": ["22.2"] },
    { "id": 28, "tasks": ["22.3", "24.1"] },
    { "id": 29, "tasks": ["22.4", "22.5", "24.2"] },
    { "id": 30, "tasks": ["24.3", "25.1"] },
    { "id": 31, "tasks": ["24.4", "24.5", "24.6", "25.2"] },
    { "id": 32, "tasks": ["25.3", "26.1"] },
    { "id": 33, "tasks": ["26.2", "27.1", "35.1"] },
    { "id": 34, "tasks": ["26.3", "27.2", "27.3", "28.1", "35.2"] },
    { "id": 35, "tasks": ["28.2", "28.3", "28.4"] },
    { "id": 36, "tasks": ["28.5", "28.6", "29.1"] },
    { "id": 37, "tasks": ["29.2", "29.3", "29.4", "29.5", "30.1"] },
    { "id": 38, "tasks": ["31.1", "31.2"] }
  ]
}
```
