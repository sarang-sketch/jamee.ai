# Implementation Plan: Jamee Crop Disease Detection

## Overview

TypeScript (Next.js App Router, strict mode) with Vitest + fast-check for tests, and Zod as the single source of contracts. This line originally read "Supabase for auth/Postgres/storage"; **Amendment A3 replaced Supabase entirely with MongoDB Atlas (M0) for records, MongoDB GridFS for files, and an in-app auth library with a MongoDB adapter for Google sign-in — see Phase 8.** The original six-phase build order (foundation → image diagnosis → chat → voice → WhatsApp → production polish) describes how the code got here, not where it is going; the second channel is Telegram (A1) and the backend is MongoDB (A3).

Task 1 resolves the design's "Values to verify before coding" table (V1–V22) and records the findings in `docs/VERIFIED_VALUES.md`. Every later task that touches a third-party surface names the V-items it depends on. **Rule carried through the whole plan: if a V-item cannot be confirmed, the code fails loudly at startup rather than falling back to a guessed value.** No task may substitute an assumed SDK name, model identifier, header name, or platform limit for a resolved one.

Three structural notes on sequencing:

- The quota **counter primitives** (migration `0007` and `quota.service.ts`) land in Phase 2 because the diagnosis spend rule depends on them. Phase 6 completes the quota surface: burst rate limiting, decline messaging, audit completeness, and the cross-channel quota properties that only become testable once WhatsApp exists.
- The **media lifecycle** spans all six phases rather than sitting in one task, because bytes are created in three places and reclaimed in two. Requirement 2's re-encode and thumbnail land in the uploader (12.1), Requirement 12's read order lands in the history screens (13.1, 13.2), Requirement 8.9's on-success voice deletion lands in the VoiceService (18.2), and Requirement 18's sweep lands in Phase 6 as task 33. Migrations 4.4 and 4.8 carry the column, index, and policy narrowing the sweep depends on.
- External account and dashboard work (Supabase project creation, SMS provider enablement, Meta app and business verification, Vercel project setup) is **not** an implementation task. It is captured as written procedure in `docs/DEPLOYMENT.md` (task 28.1).

Task 33 sits in the file between tasks 28 and 29 while carrying a higher number than either. That is deliberate: the media-lifecycle amendment added an epic to Phase 6 after work was already in flight, and renumbering tasks 29–32 would have invalidated task references held elsewhere in the spec and in recorded execution history. Its position in the file and its waves in the dependency graph are where the work belongs; only its number is out of sequence. The same reasoning was applied again when the retention epic landed as task 35 between tasks 27 and 28.

**Read this before reading anything above task 36.** Amendment A1 replaced Requirements 1, 10, and 11 and added Requirements 21 and 22, so the second channel is Telegram rather than WhatsApp, web sign-in is Google OAuth rather than phone OTP, and the Telegram bot is gated behind a payment. **Then Amendment A3 replaced the entire Supabase backend with MongoDB** (Atlas M0 for records, GridFS for files, an in-app auth library with a MongoDB adapter for sessions, and a Data_Access_Layer in place of RLS), and **Amendment A2 turned the one-time unlock into a weekly ₹20 recharge.** **Phase 8 (tasks 50–64) is the current plan; task 64 is the release gate.** Phase 7 (tasks 36–48) is now itself largely history: it built the Telegram/Google/linking/payment layer on Supabase, and Phase 8 rebases that layer onto MongoDB and finishes the A2 recharge — the list at the head of Phase 8 names every Phase 7 task it supersedes and where the work moves. Tasks 1–49 are left unchanged as the record of what was built and when, and no task among them is to be re-run as written. Identity is the Auth_User_Id the in-app auth library assigns (A3), not the Supabase auth user id A1 named or the E.164 phone the original plan used.

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

### Phase 7 — Amendment A1: Telegram channel, Google sign-in, linking, and payment

This phase is **release work, not deferred**. It sits after the OPTIONAL / DEFERRED section only so that tasks 33 and 34 keep the file position and the numbers they already carry; nothing below is optional in the sense that section uses the word, and the `*` marker keeps its usual meaning of "a test task that a faster MVP may skip".

Amendment A1 replaces Requirements 1, 10, and 11 in full and adds Requirements 21 (Telegram Account Linking) and 22 (Payment And Bot Entitlement). Tasks 1–35 are left exactly as written, because they are the record of what was built and when, and because task references are held in commit messages, test headers, and `docs/`. **They are no longer a description of the target system.** The list below names every existing task a reader should now read as history rather than as current instruction, and where its work moves. No task in 1–35 is to be re-run as written.

- **1.1** (the V12–V15 Meta row) and **1.2** (the WhatsApp acknowledgement strategy) → 36.1, 36.2. V12–V15 and V2 are retired; V23–V27 replace them.
- **2.2** (`WHATSAPP_*` in `src/lib/env.ts`, the Meta API version in `src/lib/config/verified.ts`) → 37.1.
- **3.2** (message catalogs) and **3.3** (error taxonomy) → 37.3, 37.4. The catalogs gain the linking and gated copy; `OTP_INVALID` and `WEBHOOK_VERIFY_TOKEN_INVALID` retire.
- **4.1** (`0002_profiles.sql` with the E.164 check, `unique(phone)`, and the phone index) → 38.1. Phone is no longer an identity column.
- **4.2**, **4.4**, **4.5** (`channel in ('web','whatsapp')`) → 38.2.
- **4.7** (`0008_whatsapp_inbound.sql`, keyed on `provider_message_id`) → 38.3. The table is `telegram_inbound`, keyed on `update_id`.
- **6** in full — **6.1** (`SignInForm.tsx`, phone OTP), **6.2** (the E.164 upsert), **6.5** (Property 1 over phone identity) → 39.1, 39.2, 39.3, 45.1.
- **21** and **22** in full, the whole of *Phase 5 — WhatsApp channel*, including **21.1**–**21.6** and **22.1**–**22.5** → 40, 41, 45.4, 45.5, 45.6. The Meta GET handshake, the `X-Hub-Signature-256` HMAC, the two-step media retrieval, and the WAMID key all go with the channel.
- **23** (Phase 5 checkpoint) → 48.
- **27.1** ("every WhatsApp secret") and **27.3** (the WhatsApp adapter import assertion) → 47.5, which also adds the two structural checks Amendment A1 introduces.
- **28.1** (nine deployment steps including SMS provider enablement and the Meta app), **28.3**, **28.4** (`whatsapp_inbound` in the RLS list, the webhook GET assertion) → 47.1, 47.2, 47.4. There are ten steps now, no SMS provider, and no GET handshake to assert.
- **29.5** (WhatsApp scenario integration tests) → 46.1. **Task 31.1**'s "web and WhatsApp diagnoses" history assertion → 46.5.
- **30.1** and **31.2** (real SMS OTP delivery, WhatsApp from a handset) → 47.3. The manual matrix is now Google sign-in including the cancel path, one real checkout, and Telegram end to end in the fixed pay → link → photo order.
- **32** (release gate) → 48.

Two items in this phase are **BLOCKED on a product-owner decision** and are recorded as such below, outside the numbered release work: the Bot_Unlock_Price figure (O22-1) and the pilot payment mode (O22-3).

- [ ] 36. Resolve V23–V27 and retire V2 and V12–V15 before any Amendment A1 code is written
  - [x] 36.1 Append V23–V27 to `docs/VERIFIED_VALUES.md` and mark V2 and V12–V15 retired in place
    - V23 Supabase Google OAuth: the `signInWithOAuth({ provider: 'google' })` call shape and its `redirectTo` option, the callback-route code-exchange helper name, where the Google client id and secret are configured, which redirect URLs must be registered, and which claim carries the Google email onto `auth.users`
    - V24 Telegram Bot API: `setWebhook` including its `secret_token` parameter and any length or character constraint on that token, the exact header name Telegram presents it in, the `Update` field paths for `update_id`, `message.from.id`, `message.text`, `message.photo[]`, `message.voice`, and the `/start` payload, the `sendMessage` request shape and its text length cap, and Telegram's retry behaviour on a non-200
    - V25 Telegram file retrieval: `getFile(file_id)` → `file_path`, the download URL form built from the bot token and that path, the documented validity window of a `file_path`, and the bot-download size ceiling
    - V26 Telegram inbound media: that a `voice` message is always OGG/Opus and how it differs from `audio` and `document`, the `mime_type` and `file_size` fields actually present on each, and which entry of the `photo[]` size array to take for diagnosis
    - V27 Razorpay: the order-creation endpoint and its request/response shape, which identifiers the browser checkout needs, the webhook signature scheme (header name, HMAC algorithm, encoding, and which secret keys it), the event names for a captured and a failed payment, the payload paths for the payment id, order id, amount, and status, and the difference between test and live mode credentials
    - Retire V2 and V12–V15 **in place, keeping their numbers and their already-resolved findings**, each row naming the item that supersedes it — a reader arriving from a citation of V13 has to find V13 and learn that it no longer applies, rather than find nothing
    - Record against V26 that it carries the fact that makes Requirement 10.6 satisfiable, and against the retired V14 that its resolved row is the only remaining record of why 10.6 was unsatisfiable under the old channel
    - Mark any unresolvable item explicitly as UNRESOLVED — never as an assumed value
    - _Requirements: 10.6, 17.3_
    - _Design: Values to verify before coding_

  - [x] 36.2 Update `docs/PROVIDER_CAPABILITIES.md` for the channel change
    - Replace the WhatsApp acknowledgement section with the Telegram one: D11's inline-then-acknowledge default stands unchanged in shape, and its one retired input — the 24-hour customer-service window — is replaced by Telegram's own retry cadence on a non-200 (V24)
    - Record that the `transcribe` chain no longer has a container hole: a Telegram `voice` note is OGG/Opus, which V10's accepted list includes, so the `audio/aac` and `audio/amr` gap closes with the channel that opened it
    - Leave the capability→provider chains, the V9 vision-fallback flag, and the free-tier arithmetic as they are — no provider changed
    - _Requirements: 10.6, 14.4, 17.7_
    - _Design: D11; depends on V10, V18, V24, V26_

- [ ] 37. Amend the shared contracts: environment, compile-time constants, message catalogs, and the error taxonomy
  - [ ] 37.1 Amend `src/lib/env.ts`, `src/lib/env.public.ts`, and `.env.example`
    - Add to the `serverEnv` schema: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, each with the module that consumes it named in its comment
    - Remove `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, and the optional `WHATSAPP_API_VERSION` together with the Meta API version entry in `src/lib/config/verified.ts`
    - Add `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` and `NEXT_PUBLIC_RAZORPAY_KEY_ID` to `src/lib/env.public.ts`. The bot username is not a secret — it is in the deep link every farmer opens. The Razorpay key id is deliberately duplicated under two names so the unprefixed one is never read from a client component, and 47.5 asserts that
    - **No SMS variable is removed here, because none was ever in the environment**: phone OTP was configured in the Supabase dashboard, so Requirement 1.10's "no SMS delivery provider" is a `docs/DEPLOYMENT.md` change (47.1), not an `env.ts` one
    - `CRON_SECRET` keeps its name and its reason — the deployment platform injects that name — and the design's env table names the same secret `RETENTION_SWEEP_SECRET`
    - `.env.example` lists every new name with a placeholder and no real secret, and neither compile-time constant appears in it
    - _Requirements: 1.10, 13.7, 17.2, 22.25_
    - _Depends on: V23, V24, V25, V27_

  - [ ] 37.2 Create `src/lib/config/access.ts` for the two access constants
    - `LINK_TOKEN_TTL_MINUTES` — the Link_Token expiry as a whole number of minutes, readable from exactly one place and taken from no environment variable
    - `BOT_UNLOCK_PRICE` — **lands as an explicitly marked placeholder.** Requirements O22-1 leaves the amount undecided and forbids inventing one, so the constant ships carrying a `PRICE_UNDECIDED` marker with a comment naming O22-1, and the accessor that reads it throws rather than defaulting to a number. Naming the figure is 49.1 and is not this task's to complete
    - Follow the shape of `src/lib/config/media.ts` — the convention 18.1 established and the one 21.4 and 22.4 point at — and keep both values out of `.env.example` and out of the env schema, so a change to either is a reviewable diff
    - _Requirements: 21.4, 22.4_

  - [ ] 37.3 Add the Amendment A1 farmer-facing copy to `src/lib/messages/{en,hi,mr}.ts`
    - Linking instructions, used both for a sender stored on no Profile and for a `/start` with no token payload — what the farmer does on the web profile screen to link this Telegram account
    - The invalid-link reply: **one string serving unknown, expired, and consumed, worded identically for all three**, so a party who can send arbitrary `/start` payloads cannot use the bot as a token-validity oracle
    - The already-linked reply, the replacement reply naming the replacement, and the separate message sent to the Telegram_User_Id that was replaced telling it that it no longer reaches that Jamee account
    - The already-linked-elsewhere reply, stating that this Telegram account belongs to another Jamee account and has to be unlinked there first
    - The gated reply: this Telegram account is linked, the bot needs a one-time unlock, the Bot_Unlock_Price, and where in the Web_App to pay
    - All of it is **pre-translated static copy in all three languages and is not model output** — no catalog lookup can reach a model call (D5). Replies go out in the resolved Profile's language, and in English where no Profile was resolved
    - The gated reply renders its price from `BOT_UNLOCK_PRICE`, so it carries 37.2's placeholder until 49.1 lands
    - _Requirements: 10.3, 21.8, 21.9, 21.10, 21.11, 21.12, 21.13, 21.17, 21.19, 22.14_
    - _Design: D5, D13; Error taxonomy — the four Telegram outcomes that are not errors_

  - [ ] 37.4 Amend the error taxonomy in `src/lib/errors.ts`
    - Replace `OTP_INVALID` with `OAUTH_INCOMPLETE` (HTTP 401, retryable): one code for a cancelled authorization, a provider error, and a callback carrying nothing to exchange, because the farmer's next action is identical in all three and distinguishing them would only describe Google's internals
    - Rename the webhook codes — `WEBHOOK_SECRET_TOKEN_INVALID` for the Telegram route and `WEBHOOK_SIGNATURE_INVALID` for the payment route — and retire `WEBHOOK_VERIFY_TOKEN_INVALID` with the GET handshake that has no Telegram analogue
    - Add `PAYMENT_ORDER_FAILED` (HTTP 502, retryable) whose message never carries the provider's error text
    - Keep the four Telegram outcomes **out** of the taxonomy: the linking instructions, the invalid-link reply, the already-linked-elsewhere reply, and the gated reply are successful handling of a well-formed authenticated delivery, they are catalog sentences rather than error envelopes, and each is accompanied by HTTP 200 to Telegram. Their audit trail is `telegram_inbound.status`, not `usage_logs`
    - _Requirements: 1.3, 11.3, 11.4, 15.3, 15.4, 22.1, 22.6_
    - _Design: Error taxonomy_

  - [ ]* 37.5 Write unit tests for the amended contracts
    - Every new server variable throws at first use with its own name in the message; no removed WhatsApp name survives in `src/lib/env.ts`, `src/lib/config/verified.ts`, or `.env.example`
    - `BOT_UNLOCK_PRICE` read through its accessor throws while the placeholder marker is in place, so no build can quietly charge a guessed amount
    - The three invalid-token cases resolve to one byte-identical string within each of `en`, `hi`, and `mr`
    - Every amended taxonomy code yields its documented status, retryable flag, and a non-empty message in all three languages
    - _Requirements: 13.7, 15.3, 21.8, 22.4_

- [ ] 38. Amend the migrations in place and add the three access-table migrations
  - **Amending is the honest option here and the design says why.** Nothing in `supabase/migrations/` has been applied to a deployed project — this is pre-pilot — so an `alter table … drop constraint` follow-up would leave the original phone-identity schema readable as though it had once been real, and a future reader would have to replay two migrations to learn what the table is. If a project has already been migrated, these corrections have to arrive as a further migration instead and the in-place edits become documentation-only.
  - **The new migrations are numbered 0012–0014, not the design's 0011–0013.** `0011_usage_logs_audit_vocabulary.sql` is already committed, so the design's numbering collides with a real file. The order, the names, and the contents follow the design exactly; only the leading number shifts by one.

  - [ ] 38.1 Rewrite `0002_profiles.sql` for the Auth_User_Id identity
    - `email text` nullable, holding the Google_Email — nullable on purpose, because the trigger that copies it can fail without blocking the row and a hard constraint would turn a missing claim into a sign-up that cannot complete
    - `telegram_user_id bigint unique` nullable: the `UNIQUE` constraint is the load-bearing one now, so the `/start` handler does not defend the at-most-one-Profile rule but only handles the unique violation, and nulls being distinct means any number of unlinked profiles coexist. The constraint already creates the index the sender lookup uses, so declare no second index
    - `phone text` keeps its column and loses everything else: no `not null`, no `unique`, no E.164 check constraint, no index, and no reader anywhere in the codebase
    - `handle_new_user()` writes `(id, email)` from the new `auth.users` row with `on conflict (id) do nothing`, stores no phone, and keeps its `security definer` form with a pinned `search_path`; RLS and the own-row select/insert/update policies are unchanged
    - _Requirements: 1.4, 1.5, 1.9, 10.2, 13.1, 13.2, 21.16_
    - _Design: D8; depends on V5, V23_

  - [ ] 38.2 Correct the `channel` check constraints to `('web','telegram')`
    - `0003_conversations_messages.sql` on both `conversations.channel` and `messages.channel`, `0005_diagnoses.sql`, and `0006_usage_logs.sql`
    - Correct the comments that reason about the old channel in the same edit, so the migration text and the constraint agree
    - `counters` needs no edit and gets none: it has no `channel` column, which is why 14.2's cross-channel sharing is automatic rather than a rule someone has to remember
    - _Requirements: 14.2, 16.5_

  - [ ] 38.3 Rename `0008_whatsapp_inbound.sql` to `0008_telegram_inbound.sql` and re-key it on `update_id`
    - `update_id bigint primary key` — a number Telegram assigns per bot and per webhook registration, a narrower and cheaper key than the 128-character WAMID it replaces, with no format to validate. **The primary key is the idempotency mechanism**, so the insert precedes anything billable and the unique violation is the duplicate signal
    - `telegram_user_id bigint` nullable (an update can carry no sender), `user_id` referencing `profiles` with `on delete set null`, `message_type` in `start | text | photo | voice | other`
    - `status` gains `unlinked` and `not_entitled`: an unlinked sender and a gated farmer both produce a reply and no billable operation, so there is nothing for `usage_logs` to record and this column is the only trace that the delivery was handled deliberately rather than dropped
    - Keep the `received_at desc` index, RLS **enabled with no policies at all**, and a table comment carrying that reasoning
    - _Requirements: 11.5, 11.6, 11.8, 21.17, 22.13_

  - [ ] 38.4 Add `0012_link_tokens.sql` (the design's `0011`)
    - `link_tokens` with `user_id` referencing `profiles` on delete cascade, `token_hash text not null unique` — **the sha-256 of the token, never the token**, so a snapshot of this table is not a list of live capabilities — `expires_at`, `consumed_at` as a nullable timestamp rather than a boolean, and a `(user_id, created_at desc)` index
    - RLS enabled with a select-own policy and **no insert, update, or delete policy at all**, so a farmer session cannot mint a token for another farmer, extend an expiry, or un-consume one
    - Carry the consume-and-bind statement into the migration comment as the contract the service implements: `update … set consumed_at = now() where token_hash = $1 and consumed_at is null and expires_at > now() returning user_id`
    - _Requirements: 13.1, 13.2, 21.3, 21.7_
    - _Design: D13_

  - [ ] 38.5 Add `0013_payment_orders_entitlements.sql` (the design's `0012`)
    - `payment_orders` with `provider_order_id text not null unique`, `amount_minor integer` checked positive, `currency`, `status` in `created | captured | failed | cancelled`, the `updated_at` trigger, and a `(user_id, created_at desc)` index. Failed and abandoned rows are retained rather than deleted: they grant nothing, and keeping them is what makes a reconciliation query against the provider possible
    - `bot_entitlements` with `user_id` as the **primary key** (which is how at-most-one-per-farmer is enforced without a second constraint), `provider_payment_id text not null unique` as the idempotency claim, a nullable `payment_order_id`, and `granted_at`
    - **No `expires_at` column, and that absence is deliberate.** A nullable expiry would invite a future "just set it for trials" edit that silently converts a one-time purchase into a subscription; adding one should require a migration and a conversation
    - There is no `telegram_user_id` column on either table, which is what makes "keyed to the farmer, not the chat account" structural rather than a convention
    - RLS enabled on both with select-own policies and no write policies, so a farmer session cannot grant itself an entitlement, mark an order captured, or change an amount
    - _Requirements: 22.9, 22.11, 22.12, 22.20, 22.22, 22.23_
    - _Design: D14, D15_

  - [ ] 38.6 Add `0014_webhook_throttle.sql` (the design's `0013`)
    - `webhook_throttle` keyed on `(route, caller_hash, window_key)` with `route` checked in `('payment','telegram')`, a non-negative `used`, no foreign key, and no farmer column
    - `webhook_throttle_try_increment(route, caller_hash, window_key, limit)` as the same single `insert … on conflict do update … where used < limit` statement as `counter_try_increment`, for the same reason: under `read committed` a check and a write in two statements is a race
    - This exists because `counters.user_id` is `not null` with a foreign key to `profiles` and neither webhook route has a farmer to key on — the payment route has none until a signature verifies, and a caller whose signatures never verify never produces one
    - `caller_hash` is a hash of the platform-reported client address and never the raw address, so the table retains no network identifier. RLS enabled with no policies; rows pruned by the same periodic delete that prunes minute-window counter rows
    - _Requirements: 13.9_
    - _Design: D16_

  - [ ] 38.7 Regenerate `src/types/database.ts` from the amended schema
    - Run the Supabase type generator against the migrated database and commit the output, so `tsc --noEmit` is what catches a call site still reading `provider_message_id` or `profiles.phone`
    - _Requirements: 17.8_
    - _Depends on: V1_

  - [ ]* 38.8 Write integration tests for the amended and new tables
    - A second Profile cannot take a `telegram_user_id` already stored on another, and the violation is the case the `/start` handler treats as already-linked-elsewhere; any number of Profiles carry a null `telegram_user_id`; a Profile inserts with no phone at all
    - Two `bot_entitlements` rows for one `user_id` fail, and two rows carrying one `provider_payment_id` fail — the two constraints answer two different questions
    - On `link_tokens`, `payment_orders`, and `bot_entitlements`, a farmer session reads only its own rows and **every write attempt fails rather than returning zero rows**, including a write against that farmer's own row
    - `webhook_throttle_try_increment` returns the new count below the limit and null at it
    - _Requirements: 13.9, 21.16, 22.11, 22.12, 22.23_

- [ ] 39. Replace phone OTP sign-in with Google sign-in and rewrite the profile bootstrap
  - [ ] 39.1 Create `src/components/GoogleSignInButton.tsx` and update `src/app/page.tsx`
    - One control and one provider: `signInWithOAuth({ provider: 'google' })` with the `redirectTo` option pointing at the callback route
    - A live session redirects to `/diagnose`; a callback that returned no exchangeable authorization renders the `OAUTH_INCOMPLETE` message stating that sign-in did not complete and offering to sign in again
    - `SignInForm.tsx` and its stylesheet are replaced rather than edited; their deletion is 44.2
    - _Requirements: 1.1, 1.2, 1.3_
    - _Depends on: V23_

  - [ ] 39.2 Update `src/app/auth/callback/route.ts` for the OAuth code exchange
    - Exchange the authorization code for a session with the resolved helper, then run the profile bootstrap; a failed, cancelled, or unexchangeable return establishes **no session** and carries the `OAUTH_INCOMPLETE` state back to the sign-in screen
    - _Requirements: 1.2, 1.3, 1.4_
    - _Design: D8; depends on V23_

  - [ ] 39.3 Rewrite `src/app/auth/callback/ensure-profile.ts` to copy the email and no phone
    - The obligation survives unchanged: the `auth.users` insert trigger writes the row and this server-side upsert runs defensively on every sign-in, because a purely client-driven insert can be skipped when the farmer closes the tab and a farmer with no `profiles` row has no preferred language, no linking state, and nothing for an entitlement to hang off
    - The upsert writes `(id, email)` and no phone column at all. `email` stays nullable, so an absent claim is a Profile without an email rather than a sign-up that cannot complete
    - **Delete the E.164 normalizer rather than porting it.** D8 records why it is unnecessary rather than lost: under phone identity the trigger, the check constraint, and the inbound sender format disagreed about one value, so every path that touched a phone needed a normalizer plus a test asserting the `+` was restored. There is no format to reconcile now — the identity is a uuid the database generates and the trigger copies verbatim — so `toE164`, `E164_PHONE`, the two phone bootstrap failure reasons, and the test that reads the trigger's own regex out of `0002` all go with the problem they patched
    - _Requirements: 1.4, 1.5, 1.9_
    - _Design: D8; depends on V5, V23_

  - [ ]* 39.4 Write unit tests for the sign-in control and the bootstrap
    - The bootstrap writes `id` and `email` and passes no phone column in the payload at all; a second call for the same auth user is a no-op; an RLS denial and an absent email claim classify as distinct failures
    - The sign-in control calls `signInWithOAuth` exactly once with the google provider and the configured redirect, and renders the sign-in-did-not-complete message with a working retry for the cancelled return
    - _Requirements: 1.1, 1.3, 1.4_

- [ ] 40. Build `src/lib/telegram.ts` to replace `src/lib/whatsapp.ts`
  - [ ] 40.1 Add secret-token verification and update parsing
    - `timingSafeEqualStr(presented, configured)` comparing the `X-Telegram-Bot-Api-Secret-Token` header against the configured token in constant time, handling an absent header by comparing against a fixed-length dummy so a missing header takes the same time as a wrong one
    - An absent configured token is a **failed** verification and not a skipped one: `serverEnv` throwing lands in the same 401 branch rather than allowing the request through
    - There is no GET handler and no verify-token challenge. Telegram has no verification handshake — registration is an outbound `setWebhook` call Jamee makes once — so nothing here echoes a challenge
    - `telegramUpdateSchema` over the resolved field paths, producing `{ updateId, telegramUserId, type, textBody?, fileId?, startPayload? }`; nothing in this module couples the comparison to the raw body bytes, which is why the body may be read with `request.json()` after verification when the retired WhatsApp path could not
    - _Requirements: 11.1, 11.2, 11.3, 11.4_
    - _Design: D12; depends on V24_

  - [ ] 40.2 Add `getFile`, the file-endpoint download, and the service-role upload
    - `getFile(file_id)` returns a `file_path`; the bytes are then fetched from the Bot API **file endpoint** with that path appended and the bot token as part of the URL rather than an `Authorization` header
    - **That URL is never logged, never placed in an error message, and never returned to a farmer.** The no-provider-payload rule covers the farmer-facing half; the logging half is a review item on this module
    - A `file_path` expires, so it is fetched immediately before the download and never cached across invocations
    - Admit `voice` and treat `audio` and `document` as the unsupported type, and check the reported `mime_type` against the transcription provider's accepted list before downloading even though OGG/Opus is a documented guarantee — it is one comparison, and a documented guarantee is not a verified runtime fact. Take the `photo[]` entry V26 names
    - Upload with the service-role client under `crop-images/{profile.id}/…` or `voice-messages/{profile.id}/…`, because a webhook carries no farmer session and keeping the `{user_id}/` prefix is what lets a Telegram diagnosis appear later in that farmer's web history
    - Content type and size checked against the same limits as the web path before upload; Telegram reports no duration on a voice note, so the size cap is the operative bound and the recorder's 120-second check has nothing to compare on this channel
    - _Requirements: 10.4, 10.6, 10.9, 13.6, 15.6_
    - _Depends on: V10, V25, V26_

  - [ ] 40.3 Add `sendMessage`
    - The resolved request shape, with reply text bounded by the resolved length cap and no provider payload in anything a farmer sees
    - No reply window and no template requirement apply on this channel, so a late reply is a latency problem rather than an undeliverable message
    - _Requirements: 10.11, 15.6_
    - _Depends on: V24_

  - [ ]* 40.4 Write unit tests for secret-token verification
    - A matching header passes; an absent header, a wrong value, the right value with a flipped byte, and an unconfigured secret all yield 401 with the body unparsed
    - The comparison is constant-time and takes the same time for an absent header as for a wrong one, and verification precedes the parse, the profile resolution, and every service call
    - _Requirements: 11.2, 11.3, 11.4_

  - [ ]* 40.5 Write unit tests for update parsing and media admission
    - Each update kind parses to its dispatch shape; a `voice` is admitted while `audio` and `document` fall to the unsupported type; a well-formed request whose payload does not parse is acknowledged with 200 rather than answered with a status that buys an infinite redelivery loop
    - No log line, error message, or reply produced on the media path contains the bot token
    - _Requirements: 10.6, 10.9, 10.11_

- [ ] 41. Build the Telegram dispatch and the webhook route, replacing `src/lib/whatsapp-dispatch.ts` and `src/app/api/whatsapp/`
  - [ ] 41.1 Create `src/lib/db/telegram-inbound.ts` with insert-before-work idempotency
    - Insert the `update_id` before anything billable; treat the unique violation as the duplicate signal with no select-then-insert
    - A duplicate logs `duplicate_ignored`, returns 200, invokes no service, and leaves the counter unchanged
    - Because the insert precedes profile resolution and `usage_logs.user_id` is `not null`, the duplicate row takes its `user_id` from the conflicting `telegram_inbound` row; when that column is null the duplicate is recorded by the inbound status alone and no usage row is written
    - Status transitions to `processed`, `failed`, `rejected`, `unlinked`, or `not_entitled` as the outcome resolves
    - _Requirements: 11.5, 11.6, 11.7, 11.8, 14.6_

  - [ ] 41.2 Create `src/lib/telegram-dispatch.ts` with the ordered inbound pipeline
    - The order of the first four steps is an **ordering obligation, not an implementation preference**: secret-token verification, then the `update_id` claim, then profile resolution, then the entitlement check. Each position earns its place — an unauthenticated request must not cost a database round trip, the claim must precede anything billable, the entitlement is a property of a Profile so there is nothing to check before one exists, and the gate sits immediately before the first line of farmer-facing work
    - **`/start` is short-circuited above resolution**, because a `/start` carrying a valid token arrives precisely *because* the sender resolves to nothing yet, so a resolution check ahead of it would reject the one update whose whole purpose is to create the resolution. With a token payload it calls the linking service; with none it sends the linking instructions; either way it invokes no shared service and reserves no quota unit
    - A sender stored on no Profile gets the linking instructions, is marked `unlinked`, acknowledges 200, and spends nothing — the reply is **in addition to** the acknowledgement, not instead of it
    - A resolved Profile holding no Bot_Entitlement gets the gated reply in that Profile's language, is marked `not_entitled`, acknowledges 200, spends nothing, and persists **no Message and no Diagnosis_Result**. This step is kept separate from the unlinked step on purpose: one says "Jamee does not know who you are yet", the other says "Jamee knows exactly who you are and the bot needs a one-time unlock", and collapsing them would leave a farmer who has paid but not linked with no idea which half is missing
    - A type outside text, photo, and voice note gets the reply naming photos, text, and voice notes, is marked `rejected`, and spends nothing
    - Then find-or-create the farmer's active `channel = 'telegram'` conversation and dispatch: photo → DiagnosisService, text → ChatService with that conversation id, voice → VoiceService, each with `channel: 'telegram'` and each through the one shared implementation. The conversation is keyed on the resolved `profiles.id` and never on the `telegram_user_id`, so unlinking and re-linking returns to the same thread
    - The gate lives here and not in the services: they take no entitlement parameter and cannot consult one, which is what keeps the parity claim testable and "the web stays free" true by construction
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.8, 10.9, 10.11, 16.1, 16.2, 16.5, 21.17, 21.18, 22.13, 22.14, 22.15, 22.16_
    - _Design: D7, D14; Telegram adapter — Inbound processing order_

  - [ ] 41.3 Create `src/app/api/telegram/route.ts`
    - POST only, `maxDuration = 60`, with the header comparison before the body is read as an update at all
    - A failed comparison returns 401 and is the one deliberate exception to the acknowledge-with-200 rule: an unauthenticated request is not an accepted delivery, and the body has to go unparsed
    - Apply the per-caller webhook throttle on this route as well as the payment route — it has the identical shape of problem, with no farmer to key on until an update resolves
    - _Requirements: 10.10, 10.11, 11.2, 11.3, 13.9_
    - _Design: D12, D16_

  - [ ] 41.4 Add the soft deadline and the acknowledgement strategy
    - Process inline in one invocation and then acknowledge, using the same budget constant as the gateway. Correctness does not depend on the acknowledgement being fast, because the claim already happened — that is the load-bearing sentence in this decision
    - On deadline expiry, reply that Jamee is taking longer than usual and to send the photo again, mark the row `failed` rather than `processed`, and return 200 so the audit stays honest and the farmer's next send carries a new `update_id`
    - `markProcessed` runs **after** the reply is sent. A row marked `processed` on an update whose reply never left the function would make a redelivery a silent no-op and lose the farmer's answer outright
    - The unit of work is one update, never a batch. If the resolved values confirmed a continuation primitive, return 200 after the claim and move the remaining steps into the continuation — the gate moves with them safely, because it reads state rather than writing it
    - _Requirements: 10.10, 10.11_
    - _Design: D11; depends on V18, V24_

  - [ ]* 41.5 Write unit tests for the entitlement gate and the pipeline order
    - A linked farmer holding no entitlement receives the gated reply for a photo, a text, and a voice note, with zero quota spent, no `messages` row, and no `diagnoses` row; that same farmer's `/start` is still served, and that same farmer's web requests are served unchanged
    - The claim sits above profile resolution, resolution above the gate, and the gate immediately above the first farmer-facing work; a redelivery reaches no media download, no quota reservation, and no service call
    - _Requirements: 22.13, 22.14, 22.15, 22.16, 22.17_

- [ ] 42. Implement Telegram account linking
  - [ ] 42.1 Create `src/services/linking.service.ts` and the mint path
    - Mint from a cryptographically secure random source with enough entropy that a party able to send arbitrary `/start` commands to a public bot cannot guess or enumerate an outstanding token, and derive no part of it from an Auth_User_Id, a Google_Email, a Telegram_User_Id, or a timestamp
    - Store the sha-256 and never the plaintext; the plaintext exists only in the deep link. Lookup is by hash, so the plaintext is never compared in SQL
    - `expires_at = now() + LINK_TOKEN_TTL_MINUTES` from 37.2. Single-use and expiring are not belt-and-braces: expiry bounds a leaked link in time, single use bounds it in count, and either alone leaves a hole the other closes
    - Return the `https://t.me/<bot>?start=<token>` deep link assembled from `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5_
    - _Design: D13_

  - [ ] 42.2 Create `src/app/api/link/token/route.ts`
    - POST mints one token for the session user only, taking the owning Auth_User_Id from the session and never from the body; no session is 401 with nothing minted
    - DELETE unlinks: clear `telegram_user_id`, invalidate every outstanding Link_Token of that farmer, and touch no Conversation, Message, Diagnosis_Result, or Bot_Entitlement — the entitlement is keyed to the farmer, so unlinking clears one nullable column and costs nothing
    - A token is minted by the action and never on page render, so opening the profile screen does not litter the table with unused capabilities
    - _Requirements: 1.7, 21.1, 21.15, 22.20_

  - [ ] 42.3 Implement `consumeAndBind` as one atomic operation
    - One conditional `update … where token_hash = $1 and consumed_at is null and expires_at > now() returning user_id`, whose returned row **is** the authorization. No read-then-write: two concurrent deliveries of one token — trivially producible, since Telegram redelivers on a non-200 and a farmer can tap a link twice — would otherwise both read an unconsumed row and the second write could land a different sender's id on the Profile
    - The binding write is bounded by the same transaction, so either the token is spent and the `telegram_user_id` is set or neither happened
    - Four outcomes: bind and confirm; the sending id already equals the stored one → consume, leave the id unchanged, reply already-linked; the Profile holds a different id and the sender is on no Profile → replace, consume, reply naming the replacement, and send the replaced id a message that it no longer reaches that Jamee account; the sender is already stored on another Profile → the unique violation rolls the consume back, both Profiles are unchanged, the token is **left unconsumed**, and the reply says to unlink there first. That last case is a failed binding and never a transfer
    - Unknown, expired, and consumed share one reply and one code path that never learns which of them it is in
    - No shared service is invoked and no quota unit is reserved on any of these paths
    - _Requirements: 21.6, 21.7, 21.8, 21.10, 21.11, 21.12, 21.13, 21.14, 21.18, 21.19_
    - _Design: D13_

  - [ ] 42.4 Create `src/components/TelegramLinkCard.tsx` and wire the profile screen
    - The server shell reads the access state so this card and the unlock card render from one round trip
    - Show whether the Profile currently holds a Telegram_User_Id and offer the linking action or the unlink action accordingly
    - _Requirements: 1.8, 21.20, 22.18_

  - [ ]* 42.5 Write unit tests for the two named linking cases and the token shape
    - The already-linked reply and the replacement path including the message to the replaced id — the design keeps both outside the property set because they are single named cases rather than claims over an input space
    - The token is never stored in plaintext, no part of it is derived from a forbidden input, and an expired token is refused by the statement rather than by a prior read
    - _Requirements: 21.2, 21.10, 21.11, 21.12_

- [ ] 43. Implement the one-time payment and the Bot_Entitlement
  - [ ] 43.1 Create `src/lib/razorpay.ts`
    - Order creation against the resolved endpoint, returning only the identifiers the browser checkout needs
    - `verifyWebhookSignature(rawBody, header, secret)` using the resolved header name, algorithm, and encoding, with a constant-time comparison
    - No provider error text crosses into a farmer-facing message
    - _Requirements: 22.1, 22.5_
    - _Depends on: V27_

  - [ ] 43.2 Create `src/app/api/payment/order/route.ts` and the order half of `src/services/payment.service.ts`
    - The amount, the currency, and the owning Auth_User_Id are all determined server-side and **none of the three is read from the request body**, so a tampered body cannot buy an entitlement for another farmer or at another price
    - No session is 401 with no order created at the provider and none recorded
    - Insert `payment_orders` as `created` and return checkout identifiers only
    - A farmer holding orders in any state other than captured can always start another, and no earlier order is an obstacle to clear first, because nothing in the create path reads the previous ones
    - _Requirements: 22.1, 22.2, 22.3, 22.22_

  - [ ] 43.3 Create `src/app/api/payment/webhook/route.ts`
    - Read the body **once as text**, verify the signature over those exact bytes in constant time, and only then parse. `request.json()` discards those bytes and re-serializing will not reproduce them — key order, whitespace, and unicode escaping all differ
    - A missing signature header, a signature that does not verify, and an absent configured secret are **one 401 branch** with nothing parsed and nothing recorded. The tempting `if (secret) verify(...)` is a deployment where someone forgot a variable turning into a deployment where anyone can grant themselves an entitlement
    - No Supabase session is consulted: this route carries no farmer session by design and the signature check is the entire boundary
    - Apply the per-caller throttle keyed on a hash of the platform-reported address, never the raw address. State its limitation rather than overselling it: an address is shared behind NAT and forgeable at scale, so this is a cost control and not an authentication control — the actual defence is the ordering above
    - `maxDuration = 60`
    - _Requirements: 13.9, 22.5, 22.6, 22.24_
    - _Design: D15, D16_

  - [ ] 43.4 Create `src/services/entitlement.service.ts` and the grant half of `src/services/payment.service.ts`
    - Derive the paying farmer, the amount, and the outcome **only** from a verified payload together with the recorded `payment_orders` row. The grant takes its `user_id` from that row and never from the webhook payload, so a forged-but-somehow-verified payload cannot redirect a grant, and a browser-reported checkout success grants nothing at all
    - The grant is `insert … on conflict do nothing` on `provider_payment_id`, and a zero-row result **is** the duplicate signal: acknowledge 200 and change nothing. This is the third instance of the same pattern in this design, and the reason is identical each time
    - A verified webhook reporting a failed payment records nothing and leaves the Profile, the daily limits, the Conversations, the Messages, and the Diagnosis_Results unchanged; the channel stays gated
    - `holdsEntitlement(userId)` is the only read the adapter's gate needs. The entitlement is keyed to the Auth_User_Id and never to a Telegram_User_Id: the farmer paid, not the chat account, so unlinking discards nothing and a later re-link is served without further payment
    - _Requirements: 22.7, 22.8, 22.9, 22.10, 22.11, 22.12, 22.13, 22.19, 22.20, 22.21_
    - _Design: D14, D15_

  - [ ] 43.5 Create `src/components/BotUnlockCard.tsx`
    - Price from `BOT_UNLOCK_PRICE`, checkout on `NEXT_PUBLIC_RAZORPAY_KEY_ID`, and an optimistic "confirming your payment" state that grants nothing and only tells the UI what to show
    - An active entitlement is presented as active with the linking action offered and **no further order offered**, including for a farmer who has paid but not yet linked
    - Carries 37.2's placeholder price until 49.1 lands, so this card cannot be signed off before then
    - _Requirements: 22.4, 22.7, 22.18_

  - [ ]* 43.6 Write unit tests for payment signature verification and the grant
    - A valid signature over the raw body passes; a flipped byte, a truncated digest, an absent header, an unconfigured secret, and a re-serialized body all fail; the comparison is constant-time
    - Two concurrent verified webhooks carrying one `provider_payment_id` grant exactly once; a second distinct payment id for a farmer who already holds an entitlement grants nothing; a browser-reported success grants nothing
    - _Requirements: 22.5, 22.6, 22.7, 22.10, 22.11_

- [ ] 44. Delete the superseded WhatsApp and phone-identity modules
  - **This is not cleanup that can be left for later.** `npm run check:shared-implementation` fails on a second diagnosis or chat implementation, so a tree carrying both adapters does not pass the gates; and the WhatsApp tests import modules whose table no longer exists, so a half-migration fails the type check and the suites as well.

  - [ ] 44.1 Remove the ten WhatsApp-named files
    - `src/lib/whatsapp.ts` and `src/lib/whatsapp.test.ts` — replaced by 40
    - `src/lib/whatsapp-dispatch.ts` and `src/lib/whatsapp-dispatch.test.ts` — replaced by 41.2
    - `src/lib/db/whatsapp-inbound.ts` and `src/lib/db/whatsapp-inbound.test.ts` — replaced by 41.1
    - `src/app/api/whatsapp/route.ts` and `src/app/api/whatsapp/route.test.ts`, and the directory itself — replaced by 41.3
    - `tests/integration/whatsapp-scenarios.test.ts` — replaced by 46.1
    - `supabase/migrations/0008_whatsapp_inbound.sql` — removed by the rename in 38.3, so no tenth deletion is issued here
    - Then assert that no file name, identifier, import, route path, or comment under `src/`, `tests/`, or `supabase/` carries `whatsapp`, and that the only surviving mentions in the repository are the retired V-item rows in `docs/VERIFIED_VALUES.md` and the historical tasks in this plan
    - _Requirements: 16.1, 16.2, 16.3_

  - [ ] 44.2 Remove the phone-identity and OTP artifacts
    - `src/components/SignInForm.tsx`, `src/components/SignInForm.test.tsx`, and `src/components/SignInForm.module.css` — replaced by 39.1
    - The `toE164` / `E164_PHONE` block of `ensure-profile.ts` and the `toE164` and trigger-regex describe blocks of `ensure-profile.test.ts`, including the test that reads the migration's own regex back out to compare it — there is no longer a second copy of a format to keep in step
    - Any remaining reader of `profiles.phone` outside `supabase/migrations/**`; 47.5's structural check is what keeps that true as the codebase grows rather than only on the day it was written
    - _Requirements: 1.1, 1.9_
    - _Design: D8_

- [ ] 45. Restate the falsified property tests and add Properties 32–35
  - [ ]* 45.1 Restate the identity property over the Auth_User_Id
    - `tests/property/identity.property.test.ts`: the generator is no longer "any valid E.164 phone number" — it is any `auth.users` row, with resolution through `profiles.telegram_user_id` as the only route and no phone value taking part in any resolution
    - **Property 1: Identity round-trip across channels**
    - **Validates: Requirements 1.4, 1.5, 1.8, 1.9, 10.2, 21.16**

  - [ ]* 45.2 Extend the authentication-gate property to the two new endpoints
    - `tests/property/auth-gate.property.test.ts`: the protected surface now includes the Link_Token minting endpoint and the Payment_Order endpoint, with no token minted and no order created or recorded. The payment webhook route is the sole exception and is asserted by 45.11 instead
    - **Property 2: The authentication gate covers the whole protected surface**
    - **Validates: Requirements 1.6, 1.7, 21.1, 22.3**

  - [ ]* 45.3 Restate the quota property over the web and Telegram interleaving
    - `tests/property/quota.property.test.ts`: the Telegram side of the interleaving is drawn from a farmer who is linked **and** holds a Bot_Entitlement, because a gated update reserves no quota unit at all and so is not a request this property can count
    - **Property 20: Daily quotas are never exceeded and are shared across channels**
    - **Validates: Requirements 14.1, 14.2, 14.3**

  - [ ]* 45.4 Restate the webhook property over the secret token and the `update_id` claim
    - `tests/property/webhook.property.test.ts`: no GET challenge and no HMAC over the body. The generator ranges over presented header values and bodies, and asserts the constant-time comparison with the body unparsed, that no other means of authenticating a delivery exists, and that the claim precedes every download, reservation, and service call
    - **Property 23: The webhook rejects everything it cannot authenticate, and processes each delivery once**
    - **Validates: Requirements 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8**

  - [ ]* 45.5 Restate the inbound-routing property and add its third non-service outcome
    - `tests/property/inbound-routing.property.test.ts`: Telegram vocabulary throughout, routing asserted for a sender resolving to a Profile that **holds** an entitlement, plus the two non-service outcomes it lacked — the linking instructions in English where no Profile was resolved to take a language from, and the gated reply in the resolved Profile's language
    - **Property 24: Inbound Telegram updates are routed by type and always acknowledged**
    - **Validates: Requirements 10.3, 10.4, 10.5, 10.6, 10.9, 10.11, 21.17, 21.19, 22.14**

  - [ ]* 45.6 Restate the parity property with its entitlement guard
    - `tests/property/channel-parity.property.test.ts`: parity is asserted where the submitting farmer is linked and holds a Bot_Entitlement. Where the farmer holds none the claim does not apply rather than weakening — the gate replies and returns before the service runs, so there is no Telegram-side result to compare and the gated reply is the correct outcome
    - **Property 25: Channel parity of diagnosis content**
    - **Validates: Requirements 10.7, 10.13**

  - [ ]* 45.7 Extend tenant isolation to the three access tables
    - `tests/property/tenant-isolation.property.test.ts`: add `link_tokens`, `payment_orders`, and `bot_entitlements`, and assert that on those three **every write attempt from a farmer session fails rather than returning zero rows**, including a write against that farmer's own row
    - **Property 27: Tenant isolation holds across tables, storage, and the knowledge base**
    - **Validates: Requirements 13.2, 13.4, 13.6, 21.3, 22.23**

  - [ ]* 45.8 Extend the burst property with the per-caller webhook bound
    - `tests/property/burst-order.property.test.ts`: add the Payment_Order endpoint to the per-farmer burst, and add a burst on the payment webhook route whose signatures never verify and which therefore identifies no farmer at all — the bound is keyed on the caller, and no refused request records an entitlement or changes any farmer's state
    - **Property 28: Burst rate limiting precedes any quota spend**
    - **Validates: Requirements 13.8, 13.9**

  - [ ]* 45.9 Write property test for link-token single use
    - `tests/property/link-token.property.test.ts`, over interleavings of `/start` deliveries including two simultaneous deliveries of one valid token
    - **Property 32: A link token binds at most once, and an invalid one binds not at all**
    - **Validates: Requirements 21.5, 21.6, 21.7, 21.8, 21.13, 21.14, 21.18**

  - [ ]* 45.10 Write property test for entitlement-gate totality
    - `tests/property/entitlement-gate.property.test.ts`. State the claim over **the adapter's own set of dispatchable update kinds** rather than over a list of kinds written into the test, so a kind added to the adapter without a gate in front of it becomes a failing case rather than an unexercised one
    - **Property 33: The entitlement gate is total over update kinds**
    - **Validates: Requirements 22.13, 22.14, 22.15, 22.16, 22.17**

  - [ ]* 45.11 Write property test for payment-webhook authenticity and idempotency
    - `tests/property/payment-webhook.property.test.ts`, over arbitrary raw bodies and signature headers, and over any number of redeliveries of one payment identifier in any order including concurrent ones and ones interleaved with other payments
    - **Property 34: No entitlement without a verified signature, and one payment grants exactly once**
    - **Validates: Requirements 22.5, 22.6, 22.7, 22.8, 22.9, 22.10, 22.11, 22.12, 22.21**

  - [ ]* 45.12 Write property test for unlink preservation
    - `tests/property/unlink.property.test.ts`, over arbitrary sets of outstanding tokens and of Conversations, Messages, and Diagnosis_Results created through either channel
    - **Property 35: Unlink preserves everything it should**
    - **Validates: Requirements 21.14, 21.15, 22.18, 22.19, 22.20**

- [ ] 46. Update the integration suite for the amended channel and the two new capabilities
  - [ ]* 46.1 Create `tests/integration/telegram-scenarios.test.ts`, replacing `whatsapp-scenarios.test.ts`
    - Text, photo, voice note, unsupported type, duplicate update, soft-deadline timeout, and a provider rate limit driving the fallback, as before
    - Plus the two scenarios the old suite had no vocabulary for: an unlinked sender, and a **linked sender holding no entitlement**
    - _Requirements: 10.4, 10.5, 10.6, 10.9, 10.10, 11.5, 14.4, 14.5, 21.17, 22.13_

  - [ ]* 46.2 Re-key `tests/integration/idempotency.test.ts` to the `update_id`
    - Two concurrent claims of one `update_id`: one proceeds, one is dropped, with no second service call and no second reply; a redelivery spends zero quota and makes no provider call
    - _Requirements: 11.5, 11.6, 11.7, 11.8_

  - [ ]* 46.3 Write account-linking integration tests
    - A valid first-time link, an expired token, a consumed token, an unknown token, a `/start` with no payload, a Telegram account already linked to another Jamee account, and two concurrent deliveries of one token
    - Assert the three invalid cases are byte-identical replies and that the already-linked-elsewhere case leaves the token unconsumed
    - _Requirements: 21.6, 21.7, 21.8, 21.9, 21.13_

  - [ ]* 46.4 Write payment and gate integration tests
    - An abandoned checkout, a replayed webhook, a forged signature, a captured payment opening a previously gated sender, and a flood of unauthenticated calls on the webhook route
    - A gated farmer's photo, text, and voice updates persist no `messages` and no `diagnoses` row and leave the counters untouched, while that same farmer's web requests are served unchanged
    - _Requirements: 13.9, 22.10, 22.13, 22.17, 22.19, 22.21_

  - [ ]* 46.5 Update the shared integration fixtures and the release-acceptance test
    - `tests/integration/farmers.ts`: two farmers created through the Google path with no phone, which also retires the admin-create phone workaround and the `[auth.sms]` enablement in `supabase/config.toml` that existed only to make a phone acceptable
    - `tests/integration/release-acceptance.test.ts`: the history assertion reads `web` and `telegram`, and the Telegram half of the sequence runs for a farmer who is linked and entitled
    - _Requirements: 12.1, 12.2, 17.5_

- [ ] 47. Update the deployment package, the documentation, and the CI guards
  - [ ] 47.1 Rewrite `docs/DEPLOYMENT.md` as the ten ordered steps
    - Create the Supabase project and record the URL, anon key, and service-role key
    - Configure the Google OAuth client, register the callback redirect URLs for the local and deployed origins, and enable the Google provider in Supabase (V23). **No SMS provider is configured and none is needed**
    - Run `supabase/migrations/*` in order and assert the five knowledge-base rows, both buckets private, and RLS enabled on all nine farmer-facing and access tables
    - Obtain the provider keys and record the resolved model identifiers
    - Create the Telegram bot with BotFather; record the bot token and username, and generate the webhook secret token from a cryptographically secure source (V24)
    - Create the Razorpay account; record the key id, key secret, and webhook secret; register the payment webhook endpoint, subscribe it to the captured and failed payment events, and **record whether this environment is in test or live mode** (O22-3, 49.2)
    - Deploy with every environment variable and confirm the permitted `maxDuration`
    - Register the webhook with `setWebhook` supplying the route URL and the `secret_token`; confirm a POST with no secret-token header returns 401 and that a real message reaches the route
    - Smoke test the release acceptance sequence on a phone — **payment before linking, linking before the photo**, which is an ordering requirement and not a preference
    - Record free-tier headroom for 6 farmers
    - Also record the Bot_Unlock_Price (blocked on 49.1), the retention arithmetic, and that the Payment_Provider adds no fixed or recurring cost, its charge being a per-transaction fee deducted from a payment a farmer makes
    - _Requirements: 17.1, 17.3, 22.4, 22.25, 22.26_
    - _Depends on: V4, V16, V19, V23, V24, V27_

  - [ ] 47.2 Regenerate `docs/API.md`
    - Remove the WhatsApp route; add `/api/telegram`, `/api/link/token` (POST and DELETE), `/api/payment/order`, and `/api/payment/webhook`
    - Document the two webhook routes with their **authentication mechanism in place of a request schema**, since neither body is Jamee's: the Telegram route by the secret-token header, the payment route by the signature over the raw body
    - Keep the generation from `src/lib/schemas.ts` so the document cannot drift, and keep the quota semantics note
    - Property 30 needs no restatement: it derives the environment key set and the route set from the code, so it exercises the amended sets as soon as they change
    - _Requirements: 17.2, 17.4_

  - [ ] 47.3 Rewrite the manual matrix in `docs/TESTING_REPORT.md`
    - Record the outcomes of the image, chat, voice, **Telegram**, account-linking, and payment automated suites
    - Replace the real-SMS-OTP entry with **Google sign-in on a real device including the cancel path**, which must produce the sign-in-did-not-complete message and a working retry
    - Rewrite the handset entry as **Telegram end to end in the fixed order**: pay the one-time unlock, see the web app present the entitlement as active, open the deep link and link the account, send a photo, receive a diagnosis, ask a follow-up, and confirm the same content appears in the web history. Record that a tester who sends the photo first sees the gated reply, and that this is correct behaviour rather than a defect
    - Add **one real checkout** in whichever provider mode the deployment is configured for, recording which mode ran and whether a captured payment opened a previously gated sender. This entry cannot be fully specified while O22-1 and O22-3 are open (49.1, 49.2)
    - Keep the Hindi and Marathi transcription-quality and screen-reader entries unchanged
    - Each entry states what the tester does, what result to record, and which requirement it evidences
    - _Requirements: 1.3, 10.7, 12.2, 17.5, 22.18, 22.19_

  - [ ] 47.4 Update `scripts/check-deployment.ts`
    - Replace `whatsapp_inbound` with `telegram_inbound` in the RLS assertions and add `link_tokens`, `payment_orders`, `bot_entitlements`, and `webhook_throttle`
    - **Remove the webhook GET assertion**: there is no GET handler to assert, because Telegram has no verification challenge. Assert instead that a POST with no secret-token header returns 401
    - Keep it out of CI for the reason already recorded — it asserts facts about a live deployment
    - _Requirements: 4.1, 4.2, 13.1, 13.5, 17.6, 21.3, 22.23_

  - [ ] 47.5 Update the two CI guards and add the two structural checks Amendment A1 introduces
    - `scripts/check-secret-scope.ts`: assert `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` appear only under server modules in `src/lib/**` and `src/app/api/**` and never in a file containing `'use client'`, and that the unprefixed `RAZORPAY_KEY_ID` in particular never appears in a client component
    - `scripts/check-shared-implementation.ts`: the adapter it names is the Telegram one
    - **New check 1** — no module under `src/services/diagnosis|chat|voice` imports `entitlement.service`. This is the entitlement gate's placement and "the web stays free" enforced by the dependency graph rather than by vigilance
    - **New check 2** — `profiles.phone` has no reader outside `supabase/migrations/**`, which is how "takes part in no identity resolution" stays true as the codebase grows
    - Both are structural because they assert an **absence**, which no behavioural test can do convincingly
    - _Requirements: 1.9, 3.8, 7.7, 13.7, 16.1, 16.2, 16.3, 16.4, 22.17_
    - _Design: Static architecture check (CI)_

  - [ ] 47.6 Update `about-project.md`
    - The second channel is Telegram, sign-in is Google, identity is the Supabase auth user id, and the Telegram bot is gated behind a one-time payment while the web app stays free for every signed-in farmer
    - Keep the zero-cost claim and state why it survives: removing SMS removed the only standing bill, and the payment provider adds no fixed or recurring amount because its charge is a per-transaction fee out of money a farmer pays
    - _Requirements: 1.10, 17.1, 22.17, 22.26_

- [ ] 48. Final checkpoint — Amendment A1 release readiness
  - Ensure all tests pass, ask the user if questions arise.
  - Run all seven gates: `npm run typecheck`, `npm run lint`, `npm run check:secret-scope`, `npm run check:shared-implementation`, `npm run test:unit`, `npm run test:property`, `npm run test:integration`. `npm run build` is the eighth CI step and a free cross-check of the type gate; the accessibility scan rides inside the unit project rather than standing as its own command.
  - **The integration suite needs the live local stack with its environment exported** — `supabase start`, then `JAMEE_TEST_DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` read back out of `supabase status -o env`. Without them the integration project **self-skips and reports green**, which is a broken gate rather than passing coverage: a run that executed zero tests does not count as a pass.
  - Confirm no file under `src/`, `tests/`, or `supabase/` carries `whatsapp`, that `profiles.phone` has no reader outside the migrations, that no V-item among V23–V27 remains unresolved, and that `docs/TESTING_REPORT.md` shows every human-tester entry either completed or explicitly outstanding.
  - Confirm `BOT_UNLOCK_PRICE` still carries its placeholder, and that the release therefore **cannot be signed off** until 49.1 lands. This checkpoint reports that state rather than working around it.

### BLOCKED — awaiting a product-owner decision, not implementation work

Recorded here rather than left inside Phase 7 so that neither reads as work an agent can pick up. Both are excluded from the dependency graph for the same reason the deferred tasks are.

- [ ] 49. BLOCKED — two undecided product questions
  - [x] 49.1 BLOCKED on requirements **O22-1** — name the Bot_Unlock_Price
    - The amount is not decided, appears nowhere in the requirements, and is not to be invented in code. `BOT_UNLOCK_PRICE` therefore lands in 37.2 as an explicitly marked placeholder that throws when read
    - Once the product owner names the figure this is a one-line change in `src/lib/config/access.ts` plus the recording in `docs/DEPLOYMENT.md` — 22.4 requires the amount to live in exactly one reviewable constant precisely so that it is
    - Until then: **37.2 completes with the placeholder, and this task cannot complete at all.** The gated reply of 37.3 and the unlock card of 43.5 both render that placeholder, so neither can be signed off, and 48 reports the state rather than routing around it
    - _Requirements: 22.4, 22.14_

  - [x] 49.2 BLOCKED on requirements **O22-3** — decide test mode or live mode for the pilot
    - The 5 to 6 pilot testers cannot reach the Telegram channel without a captured payment, and this is undecided: real money in live mode at whatever figure O22-1 settles on, or the provider's test mode with test credentials and test cards, which exercises the whole webhook path without money moving
    - The trade is stated and not resolvable here — live mode is the only way to witness the real checkout a farmer will see, test mode is the only way to run the sequence repeatedly at no cost to a tester
    - Either way `docs/DEPLOYMENT.md` records which mode a given environment is configured for (47.1) and `docs/TESTING_REPORT.md` records which mode the one real checkout ran in (47.3). Neither document can be completed without the decision
    - _Requirements: 17.3, 22.25_

### Phase 8 — Amendment A3: MongoDB replaces Supabase, records and files alike

This phase is **release work, not deferred**, and it is now **the current plan** — the same standing Phase 7 held before it. Amendment A3 is a strict product-owner instruction: MongoDB Atlas (free M0) is the only backend, GridFS holds every uploaded file, an in-app auth library with a MongoDB adapter performs Google sign-in and sessions, and tenant isolation moves out of the database into a server-side Data_Access_Layer. Amendment A2 also lands here where it was not yet built: the entitlement becomes a weekly ₹20 (2000 paise) window renewed by recharge, not a one-time unlock. Jamee is an academic project, so throughout this phase prefer the smallest implementation that satisfies the requirements — the tests stay, production hardening (fixed egress IPs, private networking, paid tiers) does not.

Amendment A3 does **not** renumber any requirement, criterion, or correctness property, and it retires V1, V3, V4, V5, V22, and V23 in place while adding V28–V35. It leaves A1 (Telegram, Google sign-in as a flow, linking) and A2 (the weekly recharge and its arithmetic) in force and changes only what those things are *stored in* and *served from*. Tasks 1–49 stay exactly as written as the historical record; the list below names every Phase 7 task A3 supersedes and where its work moves. **No task in 1–49 is to be re-run as written, and none is renumbered or rewritten.**

- **36.1, 36.2** (resolve V23–V27, the Telegram capabilities doc) stand as done, and A3 adds a *new* resolve step rather than reopening them → **50** resolves V28–V35 and marks V1/V3/V4/V5/V22/V23 retired in place. V24–V27 are untouched by A3.
- **37.1** (`env.ts`, `env.public.ts`, `.env.example`, `verified.ts`) → 51.1. The Supabase variables were never removed; A3 removes `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`, and adds `MONGODB_URI` and the auth-library secret + Google client id/secret. This is the "several tests unfinished, env contract still carries Supabase" working-tree state finished on MongoDB.
- **37.2** (`src/lib/config/access.ts`) stands as done, but A2 resolves O22-1 (₹20) and O22-3 (test mode), so → 51.2 replaces the `BOT_UNLOCK_PRICE` placeholder with the A2 window constants (₹20 / 2000 paise, 7-day period, `nextExpiry` arithmetic). This is where task 49's O22-1/O22-3 work is *resolved*, not carried.
- **37.3, 37.4, 37.5** (message catalogs, error taxonomy, contract tests) → 51.3, 51.4, 51.5, finishing the working-tree edits (en/hi/mr bot copy and the error taxonomy were edited but incomplete) and adding the recharge copy A2 needs.
- **38.1–38.8** (the migration edits and the three new SQL migrations `0012`–`0014`) are **rebased onto MongoDB here.** Migrations `0012`–`0014` are now historical (written for Postgres); A3 turns every collection, index, and validator into the one idempotent `npm run db:setup` script → 53. The `profiles` identity, the `('web','telegram')` enums, `telegram_inbound` on `update_id`, `link_tokens`, `payment_orders`/`bot_entitlements` (with the A2 window column), and `webhook_throttle` all move to 53 as collections with `$jsonSchema` validators and unique/partial indexes. `38.7`'s generated-types step has no MongoDB analogue and does not carry.
- **39.1–39.4** (Google sign-in via Supabase `signInWithOAuth`, the callback code exchange, `ensure-profile.ts`) are **rebased onto the auth library here** → 55. The D8 bootstrap becomes the library's sign-in / user-created hook plus the idempotent upsert through the Data_Access_Layer.
- **40.1–40.5, 41.1–41.5** (Telegram library, `telegram-inbound`, dispatch, webhook route) → 57. The verification, parsing, `getFile`+download, and dispatch survive; the service-role GridFS upload becomes a Data_Access_Layer write, and the gate becomes an *unexpired-entitlement* check (A2).
- **42.1–42.5** (linking) → 58. The single-statement consume-and-bind becomes a multi-document transaction (D19, V33).
- **43.1–43.6** (one-time payment) are **rebased onto the A2 weekly recharge here** → 59. Razorpay order creation in paise from `access.ts`, raw-body signature verification, the claim-plus-extension in one transaction, the bot recharge command exempt from the gate, and the web recharge card showing the current expiry.
- **44.1, 44.2** (delete WhatsApp and phone-OTP artifacts) → 60, which A3 widens: it also deletes every Supabase client module and dependency, the `supabase/` directory, and the Supabase-only tests.
- **45.1–45.12** (restate falsified properties, add Properties 32–35) → 61, which restates the properties A3 re-vocabularises (RLS→Data_Access_Layer, Storage→GridFS) and adds the new **Property 36 (recharge extension arithmetic)** A2 requires; Properties 32–35 are re-stated for the window/no-double-extension change.
- **46.1–46.5** (integration suite on the amended channel) → 62, now on `mongodb-memory-server` in replica-set mode rather than the local Supabase stack.
- **47.1–47.6** (deployment package, docs, CI guards) → 63, rewritten for Atlas + auth library + `db:setup`, adding `scripts/check-data-access.ts` (D18) and `about-project.md`.
- **48** (Phase 7 release gate) → **64**, the Phase 8 final checkpoint, which becomes the release gate in its place.
- **49.1, 49.2** (BLOCKED on O22-1 and O22-3) are **RESOLVED by A2 and A3.** A2 sets the price at ₹20 in test-mode-compatible paise and A3 (point 6) resolves O22-3 to test mode for all pilot testers. Their items are therefore checked off below rather than carried: the `BOT_UNLOCK_PRICE` placeholder is replaced with the real window constants in 51.2, and the deployment/testing records that were blocked are written in 63. Neither remains a product-owner question.

Two items are **BLOCKED on a verification outcome, not a product decision**, and are recorded outside the numbered work at the end of this phase: the age-based orphan backstop still ships behind its flag until V29 confirms the GridFS `uploadDate` query (P8-1), and the retention window on M0 is a number to review early because the ~512 MB budget is tighter than Supabase's and now shared with records (P8-2).

- [x] 50. Resolve V28–V35 and retire V1, V3, V4, V5, V22, and V23 before any Amendment A3 code is written
  - [x] 50.1 Append V28–V35 to `docs/VERIFIED_VALUES.md` and mark V1, V3, V4, V5, V22, and V23 retired in place
    - Resolve each against the installed package and official docs, recording the exact value, the document consulted, and the date, exactly as task 1.1 did: **V28** the MongoDB Node.js driver — package name and exact version, `MongoClient` construction and options, the `globalThis`-cached reuse across serverless invocations within the M0 connection limit, the duplicate-key error code (`11000`) and where it sits on the thrown error, the `findOneAndUpdate` return shape (pre- vs post-update and under which option), and how a `$jsonSchema` validation failure is reported; **V29** GridFS — `GridFSBucket` upload and download streams, how `metadata` is written and read, whether `bucket.delete(id)` errors on an absent id, the `files` fields available for a query (notably `uploadDate`, `length`, `metadata`), and how a download stream pipes to a route `Response`; **V30** the auth library's Google-provider config, its MongoDB adapter package and how it is pointed at this database, the sign-in / user-created hook for the D8 bootstrap, the server-side session-read call that replaces `src/proxy.ts`'s Supabase check, where the library secret and Google client id/secret are configured, and which callback/redirect URLs to register; **V31** `mongodb-memory-server` — package and version, how to start it as a single-node replica set so multi-document transactions work, its startup cost and any binary download, and how the harness points the Data_Access_Layer at it; **V32** Atlas M0 limits — the ~512 MB cluster-storage allowance, the concurrent-connection cap the cached pool must stay under, and any operation/throughput caps at the 6-farmer scale; **V33** transactions on M0 — confirmation a multi-document transaction runs on the M0 replica set, the session/transaction API on the driver, and the retryable-write / transient-transaction-error semantics; **V34** the Gemini and Groq inline-byte limits for an image and for inline audio, since analysis now sends bytes inline rather than by URL
    - Retire V1, V3, V4, V5, V22, and V23 **in place, keeping their numbers and their already-resolved findings**, each row naming its successor (V1→V28/V30, V3→V29, V4→D18/V29, V5→D8/V30, V22→V29, V23→V30/V35), so a reader arriving from a `docs/VERIFIED_VALUES.md` citation finds the number and learns it no longer applies
    - Mark any unresolvable item explicitly as UNRESOLVED — never as an assumed value; the V-item rule holds unchanged (an unconfirmed value fails loudly at startup)
    - _Requirements: 17.3_
    - _Design: Amendment A3 — V-items; Values to verify before coding_

  - [x] 50.2 Resolve V35 (the auth-library choice) by reading the bundled Next.js docs first, and install the pinned packages
    - Read `node_modules/next/dist/docs` (resolved from `AGENTS.md`'s directory) to establish the installed Next.js major/minor **before** choosing, as AGENTS.md requires; then pick Auth.js (NextAuth v5) or Better Auth by which one's current release supports that version (D18a) and record the decision and the evidence in `docs/VERIFIED_VALUES.md` under V35
    - Exact-pinned installs, no open ranges: `mongodb` at the version resolved in V28; `mongodb-memory-server` as a **dev dependency** at the version resolved in V31; the chosen auth library and its MongoDB adapter at the versions resolved in V30/V35
    - Do not install until V28, V30, V31, and V35 are resolved — an unresolved package name or version is a blocker, not a guess
    - _Requirements: 17.8, 2.1_
    - _Design: D18a; depends on V28, V30, V31, V35_

- [x] 51. Finish the shared contracts from the working tree on MongoDB: environment, access constants, catalogs, error taxonomy
  - [x] 51.1 Finish `src/lib/env.ts`, `src/lib/env.public.ts`, `src/lib/config/verified.ts`, and `.env.example`
    - Continue the uncommitted working-tree edit to completion: the env contract still carries Supabase variables, and A3 removes `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from the `serverEnv`/public schemas and from `.env.example`
    - Add to `serverEnv`: `MONGODB_URI` and the auth library's secret plus `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (named per the chosen library, V30), each with its consuming module in the comment. Keep `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `GEMINI_API_KEY`, `GROQ_API_KEY`, and `RETENTION_SWEEP_SECRET` (the design's env table names the retention secret `RETENTION_SWEEP_SECRET`)
    - `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` and `NEXT_PUBLIC_RAZORPAY_KEY_ID` stay in `env.public.ts` as the only public values; there is no public database URL or key anymore
    - There is no Meta API version to carry, so no `verified.ts` entry replaces the removed Supabase ones; `verified.ts` holds the resolved model identifiers and platform limits only
    - `.env.example` lists every current name with a placeholder and no real secret, and neither `BOT_UNLOCK_PRICE` nor `LINK_TOKEN_TTL_MINUTES` appears in it
    - _Requirements: 1.10, 13.7, 17.2, 22.25_
    - _Design: Security boundary — Environment variables; depends on V28, V30_

  - [x] 51.2 Replace the `BOT_UNLOCK_PRICE` placeholder in `src/lib/config/access.ts` with the A2 window constants
    - O22-1 and O22-3 are resolved (A2, A3 point 6). Replace the `PRICE_UNDECIDED` placeholder that 37.2 shipped with the real values: the price as a single compile-time constant readable from one place — ₹20, expressed in **paise (2000)** because Razorpay takes minor units — and the recharge period as **7 days**, both constants and neither an environment variable
    - Add `nextExpiry(now, currentExpiry)` computing `max(now, currentExpiry) + 7 days` (A2 decision 3): recharging early loses no paid days, recharging after a lapse starts at payment. Keep `LINK_TOKEN_TTL_MINUTES`
    - Keep the shape of `src/lib/config/media.ts`; keep every value out of `.env.example` and the env schema so a change is a reviewable diff (22.4)
    - _Requirements: 21.4, 22.4_
    - _Design: Amendment A2 decisions 1 and 3; resolves 49.1, 49.2_

  - [x] 51.3 Finish the farmer-facing copy in `src/lib/messages/{en,hi,mr}.ts`
    - Complete the uncommitted en/hi/mr bot copy: the linking instructions (sender on no Profile, and `/start` with no payload), the one invalid-link reply serving unknown/expired/consumed identically in each language, the already-linked and replacement replies plus the message to the replaced Telegram_User_Id, and the already-linked-elsewhere reply
    - The **recharge** copy A2 adds: the gated reply now states an *expired or absent* window, the ₹20 recharge price from `BOT_UNLOCK_PRICE`, and where to recharge (the bot recharge command and the Web_App card); a confirmation after a successful recharge stating the new expiry
    - All static, pre-translated, no catalog lookup reaching a model call (D5); replies go out in the resolved Profile's language, English where none resolved
    - _Requirements: 10.3, 21.8, 21.9, 21.10, 21.11, 21.12, 21.13, 21.17, 21.19, 22.14_
    - _Design: D5, D13; Amendment A2 decision 5_

  - [x] 51.4 Finish the error taxonomy in `src/lib/errors.ts`
    - Complete the working-tree edit: `OAUTH_INCOMPLETE` (401, retryable) replacing `OTP_INVALID`; `WEBHOOK_SECRET_TOKEN_INVALID` (Telegram) and `WEBHOOK_SIGNATURE_INVALID` (payment) with `WEBHOOK_VERIFY_TOKEN_INVALID` retired; `PAYMENT_ORDER_FAILED` (502, retryable) whose message never carries provider text; `STORAGE_REF_INVALID`/`STORAGE_REF_FORBIDDEN` keep their stable code names but now mean a Media_Reference (`{fileId,kind}`) and a GridFS `metadata.ownerId` mismatch; `AUDIO_TOO_LONG`/`FILE_TOO_LARGE` state the 3 MB audio limit (A3)
    - Keep the four Telegram outcomes (linking instructions, invalid-link, already-linked-elsewhere, gated reply) **out** of the taxonomy — they are catalog sentences with HTTP 200 audited by `telegram_inbound.status`, not error envelopes
    - _Requirements: 1.3, 8.3, 11.3, 11.4, 15.3, 15.4, 22.1, 22.6_
    - _Design: Error taxonomy_

  - [x]* 51.5 Finish the unit tests for the amended contracts
    - Every new server variable throws at first use with its own name; no removed Supabase name survives in `env.ts`, `env.public.ts`, `verified.ts`, or `.env.example`
    - `BOT_UNLOCK_PRICE` now reads a real ₹20/2000-paise value and no longer throws; `nextExpiry` returns `max(now, currentExpiry) + 7 days` for an early recharge, a lapsed recharge, and a first grant
    - The three invalid-token cases resolve to one byte-identical string within each of en/hi/mr; every amended taxonomy code yields its status, retryable flag, and a non-empty message in all three languages
    - _Requirements: 13.7, 15.3, 21.8, 22.4_

- [x] 52. Build the Data_Access_Layer as the only holder of the driver
  - [x] 52.1 Create `src/lib/db/client.ts` — the cached server-only MongoClient
    - `import 'server-only'` at the top; a `globalThis`-cached `MongoClient` so serverless invocations reuse one pool within the M0 connection limit (D19, V28, V32); the factory throws when `typeof window !== 'undefined'`; `MONGODB_URI` read through `serverEnv`
    - This module and its siblings under `src/lib/db/**` are the **only** code that imports the `mongodb` driver or touches the raw handle
    - _Requirements: 13.7_
    - _Depends on: V28, V32_

  - [x] 52.2 Create the typed collection handles and `$jsonSchema`-validated accessors
    - Typed handles for `profiles`, `conversations`, `messages`, `diagnoses`, `usage_logs`, `disease_knowledge`, `link_tokens`, `payment_orders`, `bot_entitlements`, `counters`, `telegram_inbound`, `webhook_throttle`, plus whatever collections the auth adapter needs — types inferred from the existing Zod schemas in `src/lib/schemas.ts`, never hand-declared twice
    - Every accessor takes the owning Auth_User_Id as a **mandatory** argument and merges `{ ownerId }` into every filter, sets it on every insert, and cannot widen past it on update or delete; there is deliberately **no** unscoped `find(arbitraryFilter)` seam (D18)
    - The writing accessor sets `updatedAt` (there is no trigger); expose the atomic operations of D19 (`counter_try_increment` / decrement / used as `findOneAndUpdate`, the `telegram_inbound` `insertOne` claim, the `webhook_throttle` upsert, and the two transactional operations for linking and payment as session-bearing helpers)
    - _Requirements: 13.1, 13.2, 14.1, 14.2, 14.3_
    - _Design: D18, D19; depends on V28, V33_

  - [x] 52.3 Create `scripts/check-data-access.ts` as a CI guard
    - Fail the build if any file outside `src/lib/db/**` imports the `mongodb` driver or the raw database handle — the sibling of `check-secret-scope.ts`, turning "isolation is application-enforced" into a module boundary a static check proves (D18)
    - _Requirements: 13.7_
    - _Design: D18; Static architecture check (CI)_

  - [x]* 52.4 Write unit tests for the owner-id merge and the client isolation
    - Every accessor merges `{ ownerId }` into filters and sets it on inserts; an update or delete cannot escape the owner scope; there is no accessor that accepts a filter with no owner
    - The client factory throws when a browser global is present; importing `src/lib/db/client.ts` from a `'use client'` module fails the build
    - _Requirements: 13.2, 13.7_

- [x] 53. Create the idempotent `npm run db:setup` — collections, validators, indexes, seed
  - [x] 53.1 Create `scripts/db-setup.ts` (run as `npm run db:setup`) creating collections with `$jsonSchema` validators
    - Create all twelve Jamee collections idempotently (creating an existing collection or index is a no-op). Attach `$jsonSchema` validators pinning the enumerated fields the SQL CHECKs held: `profiles.language` ∈ en/hi/mr; `conversations.channel` and `messages.channel` ∈ web/telegram; `messages.role` ∈ farmer/jamee and `input_kind` ∈ text/voice/image; `disease_knowledge.disease_name` ∈ the five Verified_Conditions, `crop` ∈ tomato/potato, and the healthy-has-no-treatment invariant where `$jsonSchema` can express it; `diagnoses.status` ∈ identified/unknown, `severity`, `channel`, `model_provider`, and the unknown-shape / identified-shape constraints; `usage_logs.operation`/`outcome`/`channel`; `counters` and `webhook_throttle` enumerations; `payment_orders.status` ∈ created/captured/failed/cancelled; `telegram_inbound.message_type` and `status` (incl. `unlinked`, `not_entitled`)
    - `profiles._id` is the Auth_User_Id; `bot_entitlements._id` is the Auth_User_Id (at-most-one-per-farmer by primary key, D14); `telegram_inbound._id` is the `update_id` (the claim, D19)
    - _Requirements: 4.1, 4.2, 13.1, 13.3, 13.4, 17.6, 21.16, 22.12_
    - _Design: Data model and collection setup; D14, D19; depends on V28_

  - [x] 53.2 Create every index from design A3 in the same script
    - Unique indexes for every former `UNIQUE`, **partial or sparse where the field is nullable**: `profiles.telegram_user_id` partial (unique when present, any number of unlinked profiles), `disease_knowledge.disease_name`, `link_tokens.token_hash`, `payment_orders.provider_order_id`, `payment_orders.provider_payment_id` partial (the A3-called-out case), `bot_entitlements.provider_payment_id`
    - Query indexes: `conversations {user_id, updated_at desc}`, `messages {conversation_id, created_at desc}`, `diagnoses {user_id, created_at desc}` and `{conversation_id, created_at desc}`, the partial retention index `{createdAt: 1}` with `partialFilterExpression: { fullImageDeletedAt: null }`, `usage_logs {user_id, created_at desc}` and `{outcome, created_at desc}`, `telegram_inbound {received_at desc}`, `link_tokens {user_id, created_at desc}`, `payment_orders {user_id, created_at desc}`
    - The compound `counters {user_id, operation, window_kind, window_key}` and `webhook_throttle {route, caller_hash, window_key}` unique indexes that make the atomic upserts safe (D19)
    - A **TTL index of about 7 days on `telegram_inbound`** (per V24's retention reasoning — the dedup store need not grow without bound)
    - _Requirements: 11.5, 11.6, 13.9, 14.1, 21.7, 22.11_
    - _Design: D19; 0002–0013 collection notes; depends on V28_

  - [x] 53.3 Create the single GridFS bucket and its metadata indexes in the same script
    - One `GridFSBucket` (its `.files`/`.chunks` collections), files distinguished by `metadata.kind` ∈ crop-image/thumbnail/voice, owned by `metadata.ownerId`, linked by `metadata.sourceRef` (D17)
    - Indexes `{ 'metadata.ownerId': 1, 'metadata.kind': 1 }` for the owner-check and the retention kind-filter; rely on the built-in `uploadDate` for the age-based backstop. No `video` kind is written
    - _Requirements: 13.5, 13.6_
    - _Design: D17; depends on V29_

  - [x] 53.4 Seed the five verified conditions idempotently in the same script
    - One document each for Tomato Early Blight, Tomato Late Blight, Tomato Healthy, Potato Early Blight, Potato Late Blight with symptoms, causes, treatment, prevention, `default_severity`, and a verbatim extension-service `source` per row (replace the design's placeholder citations with real ones); Tomato Healthy carries an empty treatment array; upsert on `disease_name` so re-running is a no-op
    - _Requirements: 4.1, 4.2, 17.6_
    - _Design: 0010 seed_

  - [x]* 53.5 Write integration tests for the setup, the validators, and the invariants
    - `count = 5` on `disease_knowledge`; a `$jsonSchema` violation (bad severity, out-of-KB name, an `unknown` diagnosis carrying a disease name) is rejected by the validator; `db:setup` run twice changes nothing
    - A partial unique index lets any number of profiles omit `telegram_user_id` but rejects a second identical present value; two `bot_entitlements` for one `user_id` fail (primary key) and two rows carrying one `provider_payment_id` fail (unique index); `counter_try_increment` returns the new count below the limit and null/`11000` at it
    - _Requirements: 4.1, 6.4, 6.5, 13.3, 13.4, 21.16, 22.11, 22.12_

- [ ] 54. Build the GridFS media store, the Media_Endpoint, and the browser upload/record changes
  - [x] 54.1 Create `src/lib/media/*` — GridFS write, read, and delete through the Data_Access_Layer
    - Write an upload stream setting `metadata.kind`, `metadata.ownerId`, and `metadata.sourceRef`; a download stream that reads bytes for inline model sends and for the serve path; `bucket.delete(id)` normalized so an absent id is "already deleted" not an error (V29); an owner check comparing `metadata.ownerId` to the requesting Farmer
    - Replace `storageRefSchema`/`thumbPathFor` reasoning with `mediaRefSchema` = `{ fileId, kind }` already added to `src/lib/schemas.ts`; the diagnose request refines `kind === 'crop-image'`, voice refines `kind === 'voice'` — a client cannot submit a thumbnail or fabricate a path (there is no path)
    - _Requirements: 2.5, 2.6, 2.8, 12.5_
    - _Design: D17; depends on V29, V34_

  - [ ] 54.2 Create `src/app/api/media/route.ts` — the authenticated upload endpoint and the owner-checked serve
    - POST (multipart, under the 4.5 MB Request_Body_Ceiling): session check, write the file to GridFS with `metadata.ownerId` set from the **session** (never from client input), return a Media_Reference. GET/serve: stream a file back only after the Data_Access_Layer confirms `metadata.ownerId` equals the requesting Farmer; a mismatch is `STORAGE_REF_FORBIDDEN` (403)
    - No session ⇒ 401 and no write; `maxDuration = 60`
    - _Requirements: 1.7, 2.1, 2.5, 2.6, 2.7, 12.5_
    - _Design: D1 (amended), D18; depends on V29_

  - [ ] 54.3 Update the browser uploader and recorder for the upload-through-endpoint change
    - `ImageUploader`: keep the select-time admission (jpeg/png/webp, 10 MB, stating both on rejection) and the re-encode toward the ~400 KB Downscale_Target and the thumbnail; POST both the Full_Size_Image and the Thumbnail_Derivative to `/api/media`, then POST only the returned crop-image Media_Reference to `/api/diagnose`; an upload failure produces an upload error and no diagnosis request (15.5); a thumbnail upload failure after a successful full-size upload still sends the diagnosis (2.14)
    - `VoiceRecorder`: **3 MB** post-stop cap (A3, down from 10 MB) stated alongside the 120 s limit, MIME picked from the provider's accepted containers (V10, V20), upload to `/api/media` as a `voice` file, then POST the Media_Reference and measured duration to `/api/voice`
    - History thumbnails load through the owner-checked Media_Endpoint, not signed URLs; loading states stay bound to real request state (no timed bars)
    - _Requirements: 2.1, 2.3, 2.4, 2.7, 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 8.1, 8.2, 8.3, 12.5, 15.2, 15.5_
    - _Design: Frontend — Browser upload through the Media_Endpoint, Voice capture; depends on V10, V20, V29_

  - [ ]* 54.4 Write tests for the Media_Endpoint owner check and the client admission
    - The endpoint sets `ownerId` from the session and refuses to serve another farmer's file with 403; a diagnose request whose Media_Reference names a `thumbnail` or `voice` kind, or a file owned by another farmer, is rejected with the quota untouched
    - Image admission at the 10 MB boundary; voice admission at the 3 MB and 120 s boundaries stating both limits; a failed upload issues no analysis request; the analysis body carries a Media_Reference and no bytes
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 8.2, 8.3, 15.5_

- [x] 55. Replace Supabase auth with the chosen auth library
  - [x] 55.1 Create `src/lib/auth/*` — the auth library with Google and the MongoDB adapter
    - Configure the library chosen in 50.2 with the Google provider and its MongoDB adapter pointed at this database (V30); user and session records live in MongoDB; expose the server-side session-read helper that replaces the Supabase session check
    - Create `src/app/api/auth/*` route(s) as the library requires
    - _Requirements: 1.1, 1.2_
    - _Design: D18a; depends on V30, V35_

  - [x] 55.2 Rebuild `GoogleSignInButton` / `src/app/page.tsx` and the callback on the auth library
    - One control, one provider, starting authentication through the library; a live session redirects to `/diagnose`; a callback with no exchangeable authorization establishes **no** session and renders `OAUTH_INCOMPLETE` with a retry (1.3). Replace the Supabase `signInWithOAuth` and callback code-exchange with the library equivalents
    - _Requirements: 1.1, 1.2, 1.3_
    - _Design: D8; depends on V30_

  - [x] 55.3 Rewrite the profile bootstrap as the library's sign-in hook plus the idempotent upsert
    - The D8 obligation survives: the library's sign-in / user-created hook fires server-side on a first session and the defensive upsert runs on every authenticated request, both through the Data_Access_Layer, writing `(_id = Auth_User_Id, email = Google_Email)` and **no** phone. `email` stays optional so an absent claim is a Profile without an email, not a failed sign-up. The E.164 story stays retired (no `toE164`, no `E164_PHONE`)
    - _Requirements: 1.4, 1.5, 1.9_
    - _Design: D8; depends on V30_

  - [x] 55.4 Replace the Supabase session use in `src/proxy.ts` and re-establish the 401 gate
    - Replace every Supabase session read — including `src/proxy.ts`'s refresh — with the library's server-side session check; the screen gate redirects unauthenticated diagnosis/chat/voice/history to sign-in, and the API gate returns `AUTH_REQUIRED` (401) invoking no domain service
    - _Requirements: 1.6, 1.7_
    - _Design: D8; depends on V30_

  - [x]* 55.5 Write unit tests for the sign-in control and the bootstrap
    - The bootstrap writes `_id` and `email`, passes no phone column, is a no-op on a second call, and classifies an RLS-free write failure and an absent email claim distinctly; the control starts Google sign-in once with the configured redirect and renders the did-not-complete message with a working retry
    - _Requirements: 1.1, 1.3, 1.4_

- [ ] 56. Port every service off the Supabase client onto the Data_Access_Layer
  - [x] 56.1 Port the quota, conversation, and usage-log services
    - `quota.service.ts` onto the D19 `findOneAndUpdate` reserve / guarded decrement / read; `conversation.service.ts` `findOrCreateActive(userId, channel)` onto the owner-scoped accessors with `web` and `telegram` conversations as separate documents; usage-log writes through the layer with `channel` on every row
    - _Requirements: 7.5, 10.5, 10.8, 14.1, 14.2, 14.3, 14.6, 14.7_
    - _Design: D10, D19_

  - [ ] 56.2 Port the diagnosis, chat, voice, history, and profile read paths
    - `diagnosis.service.ts` reads the crop image **bytes directly from GridFS** by the Media_Reference and sends them inline to the model (V34); persists the Diagnosis_Result, the Media_Reference, and `channel` through the layer; the pipeline order (ownership → burst → reserve → read bytes → classify → validate → ground → persist → log) is unchanged. `chat.service.ts` and `voice.service.ts` reuse the one grounding/rephrase implementation and read/write only through the layer; voice reads GridFS bytes inline and deletes the voice file on a durable transcript. History and detail screens and the profile screen query through the owner-scoped accessors, not a browser DB client
    - `channel` stays a required service parameter; no service takes or consults an entitlement (D14)
    - _Requirements: 2.8, 3.2, 3.3, 7.1, 7.2, 8.4, 8.6, 8.9, 12.1, 12.2, 12.3, 12.5, 16.1, 16.3, 16.5_
    - _Design: D7, D14; depends on V29, V34_

  - [ ] 56.3 Port the retention sweep onto GridFS `uploadDate`
    - `retention.service.ts`: scan 1 document-driven over `diagnoses` where `fullImageDeletedAt is null and createdAt < now − window` (served by the partial index), deleting the `mediaRef.fileId` from GridFS after asserting `metadata.ownerId` matches, then stamping `fullImageDeletedAt`; scan 2 age-driven over the GridFS `files` collection filtered `metadata.kind in (crop-image, voice)` and `uploadDate < now − window`, keeping thumbnails, deleting under each file's own `metadata.ownerId`; both bounded by a batch limit inside the 60 s ceiling; idempotent by construction. The internal route keeps its constant-time `RETENTION_SWEEP_SECRET` gate (GET scheduled, POST manual), 401 on a missing/wrong/absent secret, and consults no session
    - Scan 2 is the backstop the retired V22 blocked and V29 unblocks via `uploadDate`; it ships behind `RETENTION_ORPHAN_SCAN_ENABLED` until V29 confirms the query (P8-1)
    - _Requirements: 8.9, 8.10, 18.1, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10, 18.11, 18.12, 18.13_
    - _Design: Media lifecycle and retention; depends on V29_

  - [ ]* 56.4 Write tests for the ported services
    - Diagnosis reads bytes from GridFS inline and persists the Media_Reference and channel; voice deletes its file only after a durable transcript and keeps it on `TRANSCRIPTION_FAILED`/`TRANSCRIPT_EMPTY`; the retention sweep deletes only owner-matched files and refuses a file whose owner metadata is missing (18.8); spend-rule cases (403→zero, inconclusive→one) hold on MongoDB
    - _Requirements: 2.6, 6.6, 6.7, 8.9, 8.10, 18.8_

- [ ] 57. Build the Telegram library, the claim, the dispatch pipeline, and the webhook route on MongoDB
  - [ ] 57.1 Port `src/lib/telegram.ts` and `src/lib/db/telegram-inbound.ts`
    - Secret-token verification, update parsing, `getFile` + file-endpoint download (token in the URL, never logged), and `sendMessage` are the Phase 7 tasks 40/41 content carried onto MongoDB; the media upload writes to GridFS through the Data_Access_Layer with `metadata.ownerId = profiles._id` and `metadata.kind` set, replacing the service-role bucket upload; `voice` admitted, `audio`/`document` unsupported (V26); the `telegram_inbound` claim is `insertOne` with `_id = update_id`, the `11000` duplicate-key error being the duplicate signal (D19)
    - _Requirements: 10.4, 10.6, 10.9, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 13.6, 15.6_
    - _Design: D11, D12, D19; depends on V24, V25, V26, V29_

  - [ ] 57.2 Port `src/lib/telegram-dispatch.ts` — the ordered inbound pipeline with the A2 gate
    - The fixed order (secret-token verify → `update_id` claim → `/start` short-circuit → profile resolution → **unexpired-entitlement** check → unsupported-type reject → find-or-create telegram conversation → dispatch photo/text/voice through the shared services with `channel: 'telegram'` → reply → mark processed) with the unlinked and not-entitled steps kept separate. The gate now means "holds an entitlement whose expiry is in the future" (A2 decision 4), and the **bot recharge command is exempt** like `/start` (A2 decision 5). The conversation is keyed on the resolved `profiles._id`, never `telegram_user_id`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.8, 10.9, 10.11, 16.1, 16.2, 16.5, 21.17, 21.18, 22.13, 22.14, 22.15, 22.16_
    - _Design: D7, D14; Telegram adapter — Inbound processing order; Amendment A2 decisions 4 and 5_

  - [ ] 57.3 Create `src/app/api/telegram/route.ts` with the soft deadline and the per-caller throttle
    - POST only, `maxDuration = 60`, header comparison before the body is read; 401 the sole exception to acknowledge-with-200; the `webhook_throttle` per-caller bound (D16) applied on this route; inline processing then acknowledge, `markProcessed` after the reply is sent, one update per unit of work; on deadline expiry reply "taking longer", mark `failed`, return 200
    - _Requirements: 10.10, 10.11, 11.2, 11.3, 13.9_
    - _Design: D11, D12, D16, D19; depends on V18, V24_

  - [ ]* 57.4 Write tests for the pipeline order and the unexpired gate
    - Secret-token verification (matching passes; absent header, wrong value, flipped byte, unconfigured secret all 401 body-unparsed, constant-time); a redelivered `update_id` reaches no download/reserve/service; a farmer whose window has lapsed gets the recharge/unlock reply for photo/text/voice with zero quota and no `messages`/`diagnoses` row, while `/start` and the recharge command are still served and web requests are unchanged
    - _Requirements: 11.2, 11.3, 11.4, 11.5, 11.6, 22.13, 22.14, 22.15, 22.16, 22.17_

- [ ] 58. Implement Telegram account linking with the consume-and-bind transaction
  - [ ] 58.1 Create `src/services/linking.service.ts` and `src/app/api/link/token/route.ts`
    - Mint from a cryptographically secure source with no part derived from an Auth_User_Id, Google_Email, Telegram_User_Id, or timestamp; store the sha-256, never the plaintext; `expires_at = now() + LINK_TOKEN_TTL_MINUTES`; return the `https://t.me/<bot>?start=<token>` deep link from `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`. POST mints for the session user only (no body); DELETE unlinks — clear `telegram_user_id`, invalidate outstanding tokens, touch no Conversation/Message/Diagnosis/entitlement; no session ⇒ 401
    - _Requirements: 1.7, 21.1, 21.2, 21.3, 21.4, 21.5, 21.15, 22.20_
    - _Design: D13; depends on V33_

  - [ ] 58.2 Implement `consumeAndBind` as one multi-document transaction
    - Inside a transaction (V33): `findOneAndUpdate` on `link_tokens` filtered `{ tokenHash, consumedAt: null, expiresAt: { $gt: now } }` setting `consumedAt`, whose returned document is the authorization; then the bind write on `profiles`. The four outcomes (bind-and-confirm; same id already stored → already-linked; different id, sender on no profile → replace + notify the replaced id; sender already on another profile → unique-key `11000` aborts the transaction, token left unconsumed, reply unlink-there-first). Unknown/expired/consumed share one reply and one path
    - _Requirements: 21.6, 21.7, 21.8, 21.10, 21.11, 21.12, 21.13, 21.14, 21.18, 21.19_
    - _Design: D13, D19; depends on V33_

  - [ ] 58.3 Create `src/components/TelegramLinkCard.tsx` and wire the profile screen
    - The server shell reads the access state (`GET /api/profile/access`) so this card and the recharge card render from one round trip; show whether the Profile holds a `telegram_user_id` and offer the link or unlink action
    - _Requirements: 1.8, 21.20, 22.18_

  - [ ]* 58.4 Write unit tests for the named linking cases and the token shape
    - The already-linked reply and the replacement path (incl. the message to the replaced id); the token is never stored in plaintext, derives from no forbidden input, and an expired token is refused by the statement not a prior read; two concurrent `/start` deliveries of one token bind exactly once
    - _Requirements: 21.2, 21.7, 21.10, 21.11, 21.12_

- [ ] 59. Implement the weekly recharge payment and the windowed Bot_Entitlement (Amendment A2 on MongoDB)
  - [ ] 59.1 Create `src/lib/razorpay.ts`
    - Order creation against the resolved endpoint in **paise** taken from `BOT_UNLOCK_PRICE` (2000), returning only the checkout identifiers; `verifyWebhookSignature(rawBody, header, secret)` with the resolved header/algorithm/encoding and a constant-time comparison; no provider error text crosses into a farmer-facing message
    - _Requirements: 22.1, 22.5_
    - _Depends on: V27_

  - [ ] 59.2 Create `src/app/api/payment/order/route.ts` and the order half of `src/services/payment.service.ts`
    - Amount (from `access.ts`), currency, and owning Auth_User_Id all server-side, none read from the body; no session ⇒ 401 with no order created; insert `payment_orders` as `created` and return checkout identifiers. A farmer whose window has lapsed or who holds any non-`captured` order can always start another — a further Payment_Order is the normal case (A2 supersedes 22.18)
    - _Requirements: 22.1, 22.2, 22.3, 22.22_
    - _Design: Amendment A2 decision 5_

  - [ ] 59.3 Create `src/app/api/payment/webhook/route.ts`
    - Read the body once as text, verify the signature over those exact bytes in constant time, only then parse; a missing header, a failed verification, and an absent secret are **one** 401 branch with nothing parsed or recorded; no session consulted; the per-caller `webhook_throttle` bound on a hash of the platform-reported address, stated as a cost control not authentication; `maxDuration = 60`
    - _Requirements: 13.9, 22.5, 22.6, 22.24_
    - _Design: D15, D16, D19_

  - [ ] 59.4 Create `src/services/entitlement.service.ts` and the grant-plus-extend half in one transaction
    - Derive the paying farmer, amount, and outcome only from the verified payload plus the recorded `payment_orders` row — the grant takes its `user_id` from that row, never the payload. In one transaction (V33): claim `provider_payment_id` via `insertOne` whose `11000` duplicate-key error is the "already granted/handled" signal, and **extend the window** to `nextExpiry(now, currentExpiry)` = `max(now, currentExpiry) + 7 days` in the *same* transaction so a redelivery cannot double-extend (A2 decision 3). A verified failed-payment webhook records nothing and leaves the window untouched. `holdsUnexpiredEntitlement(userId)` — an expiry-in-the-future check — is the only read the adapter gate needs (A2 decision 4); the entitlement is keyed to the Auth_User_Id, never the Telegram_User_Id
    - _Requirements: 22.7, 22.8, 22.9, 22.10, 22.11, 22.12, 22.13, 22.19, 22.20, 22.21_
    - _Design: D14, D15, D19; Amendment A2 decisions 3 and 4; depends on V33_

  - [ ] 59.5 Create `src/components/BotUnlockCard.tsx` as the web recharge card, and the bot recharge command
    - Web card: price from `BOT_UNLOCK_PRICE`, checkout on `NEXT_PUBLIC_RAZORPAY_KEY_ID`, an optimistic "confirming your payment" state granting nothing; **show the current expiry** and offer a recharge action even while active (a further order is normal under A2); render the price from the real constant. Bot recharge command: exempt from the gate (A2 decision 5), replies with a payment link so a lapsed farmer can recover from inside Telegram
    - _Requirements: 22.4, 22.7, 22.18_
    - _Design: Amendment A2 decision 5_

  - [ ]* 59.6 Write unit tests for signature verification, the grant, and the extension
    - Valid signature over the raw body passes; flipped byte, truncated digest, absent header, unconfigured secret, and a re-serialized body all fail, comparison constant-time; two concurrent verified webhooks with one `provider_payment_id` grant/extend exactly once; a browser-reported success grants nothing; the window extends by `max(now, currentExpiry) + 7 days` and a redelivery does not double-extend
    - _Requirements: 22.5, 22.6, 22.7, 22.10, 22.11_

- [ ] 60. Delete the Supabase, WhatsApp, and phone-OTP modules and the working-tree remnants
  - This is not deferrable cleanup: `npm run check:shared-implementation` fails on a second implementation, `scripts/check-data-access.ts` fails if a Supabase client survives, typecheck currently fails in ~12 files (mostly WhatsApp and phone-OTP code awaiting deletion), and a half-migration fails the suites.
  - [ ] 60.1 Remove the WhatsApp and phone-OTP artifacts
    - The ten WhatsApp-named files listed in task 44.1 and their directory; `SignInForm.tsx`/`.test.tsx`/`.module.css`; the `toE164`/`E164_PHONE`/trigger-regex blocks; then assert no `whatsapp` name/identifier/import/route/comment survives under `src/`, `tests/`, or the setup script, and `profiles.phone` has no reader outside `scripts/db-setup.ts`
    - _Requirements: 1.1, 1.9, 16.1, 16.2, 16.3_

  - [ ] 60.2 Remove every Supabase client module, dependency, directory, and Supabase-only test
    - Delete `src/lib/supabase/{client,server,admin}.ts` and every importer's Supabase path, `src/types/database.ts` (the Supabase-generated types), `src/lib/storage.ts`'s Supabase Storage/signed-URL helpers (`thumbPathFor`/`originalPathFor` and the bucket path builders) superseded by `src/lib/media/*`; remove `@supabase/*` from `package.json`; delete the `supabase/` directory (migrations `0001`–`0014`, `config.toml`, `[auth.sms]`) — it becomes historical, applied to nothing; delete Supabase-only tests (RLS-scoped fixtures, the admin-client isolation test, the migration-regex test)
    - Then assert no `@supabase`, `supabase.`, `createClient`, `SUPABASE_`, or `service_role` reference survives under `src/` or `tests/`, and that the only surviving mentions in the repo are the retired V-item rows and the historical tasks in this plan
    - _Requirements: 13.7, 16.1, 16.2, 16.3, 17.8_
    - _Design: Amendment A3 point 2; Security boundary_

- [ ] 61. Restate the property tests for the amended properties and add Property 36
  - [ ]* 61.1 Restate the properties A3 re-vocabularises and A2 re-scopes
    - Re-word every property still reading in Postgres/RLS/Storage/signed-URL terms to the MongoDB / Data_Access_Layer / GridFS substrate without changing what it asserts: **Property 5** (ownership before spend — now a `metadata.ownerId` read), **Property 20** (quotas shared across web/telegram — Telegram side drawn from a linked *and unexpired-entitled* farmer, A2), **Property 23** (webhook auth + single processing — secret token + `update_id` `insertOne` claim), **Property 27 / 31** (tenant isolation across collections/GridFS and over deletion — application-enforced by the layer, cross-farmer writes on the access collections fail rather than return zero), **Property 30** (deliverable completeness over the new env and endpoint sets)
    - _Requirements: 2.5, 2.6, 13.2, 13.4, 13.6, 14.1, 14.2, 14.3, 17.2, 17.4, 18.8_
    - _Design: Amendment A3; Correctness Properties_

  - [ ]* 61.2 Restate Properties 33–35 for the windowed entitlement and add Property 36
    - **Property 33** (entitlement gate total over update kinds) and **Property 34** (no entitlement without a verified signature, one payment grants once) re-stated so the entitlement carries a window and the grant is a claim-plus-extend transaction — Property 34 gains the window and a **no-double-extension** claim (A2 inverts its old "no expiry"); **Property 35** (unlink preserves everything) unchanged in intent on the new substrate; **Property 32** (link token binds at most once) over the transactional consume-and-bind
    - Add **Property 36: recharge extension arithmetic** — over arbitrary sequences of recharges at arbitrary times, the resulting expiry is always `max(now, previous_expiry) + 7 days` per recharge, an early recharge never loses paid days, a lapsed recharge starts at payment, and no redelivery of one payment extends twice
    - **Validates: Amendment A2 decision 3; Requirements 22.9 (as inverted by A2), 22.11**
    - _Requirements: 21.5, 21.6, 21.7, 21.8, 22.5, 22.6, 22.7, 22.10, 22.11, 22.13, 22.14, 22.15, 22.16, 22.17_

- [ ] 62. Update the integration suite for MongoDB and run it on `mongodb-memory-server` in replica-set mode
  - [ ]* 62.1 Point the integration harness at `mongodb-memory-server` in replica-set mode
    - Start it as a single-node replica set so the link and payment multi-document transactions work (V31, V33); point the Data_Access_Layer at it; mock providers at the adapter seam so the gateway, services, validation, persistence, and owner-scoping are real; retire the Supabase local-stack requirement and the `supabase status -o env` reads. Two farmers created through the Google path with no phone; the release-acceptance history assertion reads `web` and `telegram`
    - _Requirements: 12.1, 12.2, 17.5_
    - _Design: Integration tests; depends on V31, V33_

  - [ ]* 62.2 Rewrite the channel, linking, payment, and isolation integration tests on MongoDB
    - Telegram text/photo/voice/unsupported/duplicate/timeout/rate-limit-fallback plus an unlinked sender and a **lapsed-window** sender; the `update_id` idempotency test; linking across valid/expired/consumed/unknown/no-payload/already-linked-elsewhere and two concurrent deliveries; payment across an abandoned checkout, a replayed webhook, a forged signature, a captured payment opening a lapsed sender, a recharge extending the window, and an unauthenticated flood; tenant isolation attempting cross-farmer reads (zero documents) and cross-farmer writes on the access collections (fail) across all collections and GridFS
    - _Requirements: 10.4, 10.5, 10.6, 10.9, 10.10, 11.5, 13.9, 14.4, 14.5, 21.6, 21.7, 21.8, 22.10, 22.13, 22.17, 22.19, 22.21_

- [ ] 63. Update the deployment package, the documentation, and the CI guards
  - [ ] 63.1 Rewrite `docs/DEPLOYMENT.md` as the ten A3 steps
    - Create the Atlas M0 cluster and record `MONGODB_URI`, noting the accepted `0.0.0.0/0` academic trade-off and the M0 limits (V32); choose the auth library by reading `node_modules/next/dist/docs` first (V35, D18a), configure Google + MongoDB adapter, register callback redirects, record the library/Google secrets — no SMS provider; run `npm run db:setup` and assert count = 5, the GridFS bucket, and the indexes/validators across all collections; obtain provider keys and record model identifiers and inline-byte limits (V34); create the Telegram bot (BotFather) and generate the secret token; create the Razorpay account, register the webhook, subscribe to captured/failed events, and record **test mode** (O22-3 resolved by A3); deploy to Vercel with all variables and confirm `maxDuration`; `setWebhook` and confirm a no-secret-token POST returns 401; smoke-test the acceptance sequence pay→link→photo; record the ₹20 price, the retention arithmetic against the shared ~512 MB M0 budget, and that the Payment_Provider adds no fixed/recurring cost
    - _Requirements: 17.1, 17.3, 22.4, 22.25, 22.26_
    - _Depends on: V16, V19, V27, V30, V32, V34, V35_

  - [ ] 63.2 Regenerate `docs/API.md`
    - Generate from `src/lib/schemas.ts` so it cannot drift; add `/api/media` (upload + owner-checked serve), `/api/telegram`, `/api/link/token` (POST+DELETE), `/api/payment/order`, and `/api/payment/webhook`; document the two webhook routes and the multipart Media_Endpoint by their authentication mechanism in place of a request schema; keep the quota-semantics note
    - _Requirements: 17.2, 17.4_

  - [ ] 63.3 Rewrite `docs/TESTING_REPORT.md`
    - Record the image/chat/voice/Telegram/linking/payment automated outcomes; Google sign-in on a real device incl. the cancel path; Telegram end to end in the fixed pay→link→photo order (a photo-first tester correctly sees the gated reply); **one real checkout in test mode** (O22-3 resolved), recording that a captured payment opened a previously gated/lapsed sender; the Hindi/Marathi transcription-quality and screen-reader entries unchanged
    - _Requirements: 1.3, 10.7, 12.2, 17.5, 22.18, 22.19_

  - [ ] 63.4 Complete `.env.example` and `about-project.md`
    - `.env.example`: `MONGODB_URI`, the auth library secret and Google client id/secret, the Telegram and Razorpay names, `RETENTION_SWEEP_SECRET`, and the two public names — no Supabase names, no `BOT_UNLOCK_PRICE`/`LINK_TOKEN_TTL_MINUTES`. `about-project.md`: MongoDB Atlas + GridFS backend, Google sign-in via the in-app auth library, Telegram gated behind a weekly ₹20 recharge while the web app stays free, and the zero-standing-cost claim (SMS removed; the payment fee is per-transaction out of a farmer's money)
    - _Requirements: 1.10, 17.1, 17.2, 22.17, 22.26_

  - [ ] 63.5 Update the CI guards for MongoDB
    - `scripts/check-secret-scope.ts`: replace the Supabase secret names with `MONGODB_URI`, the auth library secret, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, and keep the Telegram/Razorpay/retention names, asserting they appear only under `src/lib/**` server modules and `src/app/api/**` and never in a `'use client'` file, and that the unprefixed `RAZORPAY_KEY_ID` never appears in a client component; `scripts/check-shared-implementation.ts` unchanged in intent (Telegram adapter, no service→entitlement import, `profiles.phone` reader-free — now outside `scripts/db-setup.ts`); `scripts/check-data-access.ts` (from 52.3) is the new third structural guard; update `scripts/check-deployment.ts` to assert MongoDB collections/indexes/validators and the GridFS bucket instead of Supabase RLS/buckets
    - _Requirements: 1.9, 3.8, 7.7, 13.7, 16.1, 16.2, 16.3, 16.4, 17.6, 22.17, 22.23_
    - _Design: Static architecture check (CI); D18_

- [ ] 64. Final checkpoint — Amendment A3 release readiness
  - Ensure all tests pass, ask the user if questions arise. This checkpoint **replaces task 48 as the release gate.**
  - Run the gates: `npm run typecheck` (currently failing in ~12 files awaiting the WhatsApp/OTP deletions of task 60 — must be clean here), `npm run lint`, `npm run check:secret-scope`, `npm run check:shared-implementation`, `npm run check:data-access`, `npm run test:unit`, `npm run test:property`, `npm run test:integration`, and `npm run build`.
  - The integration suite needs `mongodb-memory-server` in replica-set mode (V31); it no longer needs a local Supabase stack. A run that executed zero integration tests is a broken gate, not a pass.
  - Confirm no `whatsapp`, no `@supabase`/`SUPABASE_`/`service_role`, and no reader of `profiles.phone` outside `scripts/db-setup.ts` survive under `src/` or `tests/`; that no V-item among V28–V35 remains unresolved; that `BOT_UNLOCK_PRICE` now reads the real ₹20/2000-paise value (49.1/49.2 resolved); and that `docs/TESTING_REPORT.md` shows every human-tester entry either completed or explicitly outstanding.

### BLOCKED — awaiting a verification outcome, not implementation work (Phase 8)

Recorded outside the numbered work for the same reason the Phase 7 blocked items were, and excluded from the dependency graph. Neither is a product-owner question — O22-1 and O22-3 are resolved (49.1, 49.2 → 51.2, 63) — both are third-party facts a task cannot assert until it resolves them.

- [ ] P8-1. The age-based orphan backstop (scan 2 of the retention sweep, task 56.3) ships behind `RETENTION_ORPHAN_SCAN_ENABLED` until **V29** confirms the GridFS `files.uploadDate` query and whether `bucket.delete(id)` errors on an absent id. Until then only the document-driven scan runs, which alone satisfies Requirements 18.3 and 18.7 for every file a farmer can surface. This is the A3 successor to the Phase 1 V21/V22 arrangement, and it blocks nothing important because the operation is idempotent and bounded.
- [ ] P8-2. `MEDIA_RETENTION_DAYS` (default 7) is a number to review early rather than set once, because the Atlas M0 ~512 MB budget is roughly half the retired Supabase 1 GB and is now shared with records (V32). The arithmetic in 63.1 states this plainly; the review is an operational decision at deployment, not a coding task.

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

Notes added with Phase 7 (Amendment A1). The bullets above are left as written, because they describe tasks 1–32 accurately as of when those tasks ran; where one of them is now false, the correction is here rather than in an edit that would make the historical record disagree with itself.

- **Phase 7 supersedes rather than extends.** Tasks 1–35 are history, not instruction. The list at the head of Phase 7 names every one of them a reader should stop treating as current, and tasks 36–48 are the work. Task 48 replaces tasks 23 and 32 as the release gate.
- Task 32 is **no longer the release gate** — task 48 is, and it runs the same seven commands plus the assertions Amendment A1 added. The note above that names 32 predates the amendment.
- The plan now carries **35 correctness properties, not 31.** Eight of the original set were falsified or left incomplete by Amendment A1 and are restated in 45.1–45.8 keeping their numbers; Properties 32–35 are new and land in 45.9–45.12. The earlier note's "all 31" was true when it was written.
- Two linking criteria are deliberately **outside** the property set and are covered by unit tests in 42.5: the already-linked reply and the replacement path. Both are single named cases rather than claims over an input space.
- **Migration numbering diverges from the design by one.** The design names the three new migrations `0011`–`0013`; `0011_usage_logs_audit_vocabulary.sql` is already committed, so they land as `0012`–`0014` with the design's order, names, and contents unchanged. Migrations `0002`, `0003`, `0005`, `0006`, and `0008` are amended **in place**, which is sound only because nothing has been applied to a deployed project yet (task 38's own note carries the reasoning).
- **Deletions in task 44 are not optional and are not cleanup.** `npm run check:shared-implementation` fails on a second diagnosis or chat implementation, so a tree holding both adapters does not pass the gates; the WhatsApp tests also import a module whose table the migrations no longer create. A half-migration fails loudly, which is the intended behaviour.
- **Two items are blocked on the product owner, not on engineering.** O22-1 (the Bot_Unlock_Price figure) and O22-3 (test mode versus live money for the pilot) are recorded as tasks 49.1 and 49.2 and are excluded from the graph. `BOT_UNLOCK_PRICE` ships as a placeholder that throws when read, so nothing can quietly charge a guessed amount, and task 48 reports that the release cannot be signed off while it stands.
- The integration suite in tasks 46 and 48 needs the **live local Supabase stack with its environment exported**. Absent `JAMEE_TEST_DATABASE_URL` the integration project self-skips and the run reports green, so a skipped suite must be read as a broken gate rather than as coverage.

Notes added with Phase 8 (Amendment A3: MongoDB, and A2: weekly recharge). The bullets above are left as written, because they described tasks 1–49 accurately when they ran; where one of them is now false under A3/A2, the correction is here rather than in an edit that would make the record disagree with itself.

- **Phase 8 supersedes Phase 7's substrate, not its intent.** Tasks 1–49 are history. Phase 8 (tasks 50–64) rebases the Telegram/Google/linking/payment layer that Phase 7 built on Supabase onto MongoDB, and finishes the A2 weekly recharge that Phase 7 predates. The list at the head of Phase 8 names every Phase 7 task it supersedes and where the work moves. **Task 64 replaces task 48 as the release gate**, which had itself replaced tasks 23 and 32.
- **The migration tree is gone under A3.** The note above about "migration numbering diverges by one" and migrations amended in place was true for Phase 7. A3 replaces all 14 SQL migrations `0001`–`0014` with one idempotent `npm run db:setup` script (task 53); `supabase/migrations/` becomes historical, applied to nothing, and is deleted in task 60.2. Task 38.7's generated-types step has no MongoDB analogue.
- **The two product-owner blocks are resolved, so task 49 is no longer blocked.** A2 sets the price at ₹20 (2000 paise) and a 7-day window (resolving O22-1), and A3 point 6 resolves O22-3 to test mode for all pilot testers. `BOT_UNLOCK_PRICE`'s throwing placeholder is replaced with the real constants in task 51.2, and the deployment/testing records are written in task 63. What remains blocked in Phase 8 (P8-1, P8-2) is blocked on a **verification outcome** (the GridFS `uploadDate` query, V29) and an operational review (the M0 retention window), not on the product owner — both are excluded from the graph for the same reason the deferred tasks are.
- **The plan now carries 36 correctness properties, not 35.** A3 re-vocabularises several (RLS→Data_Access_Layer, Storage→GridFS) and A2 inverts Property 34's "no expiry"; those are restated in 61.1–61.2 keeping their numbers, and **Property 36 (recharge extension arithmetic)** is new and lands in 61.2.
- **Tenant isolation is application-enforced under A3.** RLS is gone; the Data_Access_Layer is the only holder of the driver (task 52) and `scripts/check-data-access.ts` (52.3) is the third structural CI guard beside secret-scope and shared-implementation. The isolation properties (27, 31) still hold, now proven by cross-farmer read/write attempts through the layer rather than by RLS.
- **The integration suite no longer needs Supabase.** Under A3 it runs on `mongodb-memory-server` in **replica-set mode** (needed for the link and payment transactions, V31/V33), so the `JAMEE_TEST_DATABASE_URL`/local-Supabase requirement in the note above is retired by task 62. The "a skipped suite is a broken gate" rule still stands — a run that executed zero integration tests does not count as a pass.
- **The typecheck is red until task 60 runs.** The working tree currently fails `npm run typecheck` in ~12 files (mostly WhatsApp and phone-OTP code awaiting deletion) and still carries Supabase env variables; task 60 removes those modules and task 51 finishes the env contract, so the type gate is expected to be red mid-phase and clean by task 64.

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
    { "id": 38, "tasks": ["31.1", "31.2"] },

    { "id": 39, "tasks": ["36.1"] },
    { "id": 40, "tasks": ["36.2", "37.1"] },
    { "id": 41, "tasks": ["37.2", "37.3", "37.4", "38.1"] },
    { "id": 42, "tasks": ["37.5", "38.2", "38.3", "38.4", "38.5", "38.6"] },
    { "id": 43, "tasks": ["38.7", "39.1", "39.2"] },
    { "id": 44, "tasks": ["38.8", "39.3", "40.1"] },
    { "id": 45, "tasks": ["39.4", "40.2", "40.3"] },
    { "id": 46, "tasks": ["40.4", "40.5", "41.1", "42.1", "43.1"] },
    { "id": 47, "tasks": ["42.2", "42.3", "43.2", "43.3", "43.4"] },
    { "id": 48, "tasks": ["41.2", "42.4", "43.5"] },
    { "id": 49, "tasks": ["41.3", "41.4"] },
    { "id": 50, "tasks": ["41.5", "42.5", "43.6", "44.1", "44.2"] },
    { "id": 51, "tasks": ["45.1", "45.2", "45.3", "45.4", "45.5", "45.6", "45.7", "45.8", "45.9", "45.10", "45.11", "45.12"] },
    { "id": 52, "tasks": ["46.1", "46.2", "46.3", "46.4", "46.5"] },
    { "id": 53, "tasks": ["47.1", "47.2", "47.3", "47.4", "47.5", "47.6"] },

    { "id": 54, "tasks": ["50.1"] },
    { "id": 55, "tasks": ["50.2"] },
    { "id": 56, "tasks": ["51.1", "51.2", "51.3", "51.4"] },
    { "id": 57, "tasks": ["51.5", "52.1"] },
    { "id": 58, "tasks": ["52.2", "52.3"] },
    { "id": 59, "tasks": ["52.4", "53.1"] },
    { "id": 60, "tasks": ["53.2", "53.3", "53.4"] },
    { "id": 61, "tasks": ["53.5", "54.1", "55.1"] },
    { "id": 62, "tasks": ["54.2", "55.2"] },
    { "id": 63, "tasks": ["54.3", "55.3", "55.4"] },
    { "id": 64, "tasks": ["54.4", "55.5", "56.1"] },
    { "id": 65, "tasks": ["56.2", "56.3", "58.1", "59.1"] },
    { "id": 66, "tasks": ["56.4", "58.2", "59.2", "59.3", "59.4"] },
    { "id": 67, "tasks": ["57.1", "58.3", "59.5"] },
    { "id": 68, "tasks": ["57.2"] },
    { "id": 69, "tasks": ["57.3", "58.4", "59.6"] },
    { "id": 70, "tasks": ["57.4", "60.1", "60.2"] },
    { "id": 71, "tasks": ["61.1", "61.2"] },
    { "id": 72, "tasks": ["62.1", "62.2"] },
    { "id": 73, "tasks": ["63.1", "63.2", "63.3", "63.4", "63.5"] }
  ]
}
```

Waves 39–53 are Phase 7 (Amendment A1). Task 48 is excluded as a checkpoint, and tasks 49.1 and 49.2 are excluded because they are product-owner decisions rather than work — nothing in the graph should schedule them. Two orderings there are obligations rather than conveniences: 38.7 follows every migration edit, because the generated types are what turn a surviving `provider_message_id` or `profiles.phone` read into a compile error; and 41.2 follows 42.3 and 43.4, because the adapter's pipeline calls the consume-and-bind and the entitlement read.

Waves 54–73 are Phase 8 (Amendment A3: MongoDB, and A2: weekly recharge). Task 64 is excluded as a checkpoint, and tasks P8-1 and P8-2 are excluded because they are a verification outcome and an operational review rather than work — nothing in the graph should schedule them. The obligatory orderings follow the same shape A3/A2 impose: 50.1/50.2 precede everything because no MongoDB code may be written against an unresolved V-item; 52 (the Data_Access_Layer) precedes 53–59 because it is the only holder of the driver they all reach through; 53 (`db:setup`) precedes the code that reads its collections and indexes; 55 (auth) precedes 56 because the ported services read the session it establishes; and — the A3 analogue of Phase 7's 41.2-after-42.3/43.4 — 57.2 (the dispatch pipeline) follows 58.2 (consume-and-bind) and 59.4 (the unexpired-entitlement read) because the pipeline calls both, which is why it sits in a wave of its own after them. 60 (the deletions) follows the replacements it depends on being in place (54–59), because `check:shared-implementation` and `check:data-access` fail while both the old and new implementations coexist.
