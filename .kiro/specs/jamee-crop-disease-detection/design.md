# Design Document

## Overview

Jamee is a Next.js App Router application (TypeScript strict mode) deployed on Vercel, backed by Supabase for auth, Postgres, and private object storage. It reaches farmers through two channels — the browser and Telegram — and both channels are thin transports in front of the same three domain services: `DiagnosisService`, `ChatService`, `VoiceService` (Requirement 16). The browser channel is free to every signed-in farmer; the Telegram channel answers only a farmer who has linked a Telegram account and holds a one-time `Bot_Entitlement` (Requirements 21, 22).

Three design commitments shape everything below:

1. **No model training, no invented agronomy.** A general multimodal model only *classifies* an image into one of five verified conditions or `unknown`. Every symptom, cause, treatment, and prevention sentence a farmer reads is rephrased from a `disease_knowledge` row (Requirements 4.3–4.5). Nothing outside the knowledge base becomes agricultural advice.
2. **The verified-condition enum is the safety gate.** It lives in one place, is shared by the TypeScript types, the Zod schemas, and a Postgres check constraint. A model naming anything else fails validation and collapses into a single `Inconclusive_Result` shape (Requirements 5.6, 6.1, 6.4).
3. **The browser never sends bytes to the API.** Images and audio go browser → Supabase Storage directly; route handlers receive only a storage reference (Requirements 2.1, 8.1). This keeps request bodies far under the platform body limit (Requirement 2.7).

This design covers Phases 1–6, plus Requirements 21 and 22, which the Telegram channel turned out to require. Requirements 19 and 20 (video frames, expert calling) are deferred and appear only in the forward-compatibility note.

### Three kinds of limits, kept separate

The document is careful never to conflate these, because they have different owners and different failure modes:

| Kind | Examples | Who enforces | Status here |
| --- | --- | --- | --- |
| **Jamee application quotas** | 20 image / 50 chat / 20 voice per farmer per Asia/Kolkata day (Requirement 14.1) | Jamee's own `counters` table | Fixed by requirements, authoritative in this design |
| **Documented platform limits** | Vercel serverless request body ceiling (spec states 4.5 MB), function `maxDuration` (spec states 60 s) | Vercel | Treated as design inputs from the requirements; exact current values **VERIFY AT IMPLEMENTATION** |
| **Provider free-tier rate limits** | Gemini requests/minute and requests/day, Groq requests/minute and tokens/day, Supabase storage and egress allowances | Google / Groq / Supabase | Unknown at design time, **VERIFY AT IMPLEMENTATION**; Jamee's quotas are set below them by design, not by measurement |

Jamee's application quotas are the only limit this codebase enforces. Provider limits are handled reactively through the fallback path (Requirement 14.4), never by hardcoding a provider's numbers.

---

## Amendment A1 — Telegram channel, Google sign-in, linking, and payment

> Status: IN FORCE. This amendment tracks requirements Amendment A1 together with the two requirements added after it, 21 (Telegram Account Linking) and 22 (Payment And Bot Entitlement). It **supersedes** parts of this document rather than extending them, so a reader who implemented the earlier design should treat the following as replaced and re-read the sections named:
>
> 1. **The second channel is Telegram, and every WhatsApp mechanism in this document is withdrawn.** Gone: the Meta Graph API version pin, the `X-Hub-Signature-256` HMAC over the raw body, the GET verification handshake, the two-step media retrieval, the WAMID as the deduplication key, and the 24-hour customer-service window. The section formerly titled *WhatsApp adapter* is now *Telegram adapter*; the `whatsapp_inbound` table is now `telegram_inbound`, keyed on `update_id`; and the `channel` value is `'telegram'` everywhere it was `'whatsapp'`. The reason is cost rather than capability: WhatsApp conversation pricing sits outside the zero-cost footprint this release targets.
> 2. **Web sign-in is Google OAuth through `signInWithOAuth({ provider: 'google' })`.** Gone: phone OTP, the SMS provider, the `SignInForm` phone-and-code flow, the `OTP_INVALID` error code, the manual "real SMS delivery" test, and V2. Removing SMS removed this project's only standing bill; the Payment_Provider added below is not a replacement for it, because its charge is a per-transaction fee out of money a farmer pays rather than an amount Jamee owes (Requirements 1.10, 22.26).
> 3. **Identity is the Supabase auth user id, and `profiles.phone` is no longer an identity column.** It becomes nullable optional contact information with neither `NOT NULL` nor `UNIQUE`, and it takes part in no resolution of any kind. Inbound Telegram senders resolve through `profiles.telegram_user_id` (nullable, `UNIQUE`), which is written only by the linking flow. See **D8**, which is amended in place and explains why the E.164 normalizer disappears with the identity it existed for.
> 4. **Two capabilities are new and in scope:** account linking by single-use expiring token (**D13**) and a one-time payment that grants a permanent entitlement gating the bot (**D14**, **D15**). Both add tables, routes, and RLS policies; neither touches the three shared services.
> 5. **D7, D8, and D11 are amended in place and keep their numbers.** D12 through D16 are new. D1–D6, D9, and D10 are untouched. Properties 1–31 keep their numbers and their statements; the ones this amendment falsifies are listed at the head of *Correctness Properties* and restated by a follow-up task, not here.
> 6. **What this amendment does not change.** Supabase remains auth, database, and storage. The three shared services, the two-stage validation of D2, the single inconclusive shape of D3, the quota and counter design, the error-envelope shape, and the whole media-lifecycle and retention design are untouched in substance — only their channel names and their phone references are corrected. One thing improves: Requirement 10.6 becomes satisfiable, because Telegram voice notes are OGG/Opus and V10's accepted container list includes `ogg`, so the `audio/aac` and `audio/amr` hole recorded against V14 closes along with the channel that opened it.

---

## Values to verify before coding

Every item below depends on a third-party detail that changes over time. **No value in this table is asserted as fact anywhere else in this design.** The first implementation task resolves this table and records the findings in the API/deployment documentation.

| # | Value | Where it is used | Doc to check |
| --- | --- | --- | --- |
| V1 | Supabase JS client package name and version; browser vs. server client factory names; App Router cookie/session wiring | `src/lib/supabase/*` | Supabase JavaScript client and Next.js server-side auth guides |
| V2 | **RETIRED by Amendment A1.** Was: phone/SMS OTP enablement and which SMS provider to configure. Jamee registers no SMS provider at all. Superseded by **V23** | — | — |
| V3 | Signed URL creation call, its expiry argument, and units (seconds vs. ms) | Requirements 2.8, 12.5 | Supabase Storage signed URL reference |
| V4 | Storage RLS policy helper for path segments (the function that extracts the first folder of an object name) and the bucket-privacy setting name | Requirements 13.5, 13.6 | Supabase Storage access control docs |
| V5 | Whether a trigger on `auth.users` is the supported profile-bootstrap pattern, and the required `security definer` / `search_path` form | Requirement 1.4 | Supabase auth + Postgres function security docs |
| V6 | Google Gemini SDK package name, client initialization, and the **current multimodal model identifier** | `src/lib/gemini.ts` | Google Gemini API models documentation |
| V7 | Gemini structured/JSON output configuration: parameter names for response MIME type, response schema, temperature, max output tokens | `src/lib/prompts.ts`, `gemini.ts` | Gemini structured output documentation |
| V8 | Groq SDK package name, client initialization, and the **current text model identifier** for the fallback | `src/lib/groq.ts` | Groq models documentation |
| V9 | **Whether Groq currently hosts a vision-capable model**, and its identifier if so. This single fact decides whether an image-interpretation fallback exists at all (see Fallback matrix) | `src/lib/groq.ts` | Groq models documentation |
| V10 | Speech-to-text: which host serves Whisper, the exact model identifier, the endpoint/SDK method, accepted audio container/codec list, and the provider's own max file size and max duration | `src/lib/groq.ts` (or a dedicated transcription adapter) | Provider's audio transcription documentation |
| V11 | Provider error shapes: how a rate-limit condition and an unavailability condition are signalled (HTTP status, error code, header names for retry-after) for both Gemini and Groq | `AiGateway` fallback trigger | Both providers' error-handling docs |
| V12 | **RETIRED by Amendment A1.** Was: the Graph API version string to pin and the inbound WhatsApp field paths. Telegram publishes one unversioned Bot API surface, so there is no version to pin. Superseded by **V24** | — | — |
| V13 | **RETIRED by Amendment A1.** Was: Meta's signature header name and HMAC algorithm/encoding. Telegram authenticates by a shared secret token, so there is no digest and no hex-vs-base64 encoding question (**D12**). Superseded by **V24** | — | — |
| V14 | **RETIRED by Amendment A1.** Was: Meta's two-step media retrieval and its inbound audio container set — the row that recorded the unsatisfiable half of Requirement 10.6. Superseded by **V25** and **V26** | — | — |
| V15 | **RETIRED by Amendment A1.** Was: Meta's send-message endpoint and the 24-hour customer-service window. Telegram has no reply window and no template requirement (see **D11**). Superseded by **V24** | — | — |
| V16 | Vercel serverless **request body limit** (spec assumes 4.5 MB) and the **maximum `maxDuration`** permitted on the target plan (spec assumes 60 s) | Requirements 2.7, 3.6, 10.10 | Vercel functions limits documentation |
| V17 | Next.js route segment config for per-route duration (`maxDuration` export) and its accepted values | `src/app/api/*/route.ts` | Next.js route segment config documentation |
| V18 | Whether Vercel exposes a supported post-response continuation primitive (e.g. `waitUntil`) on the target plan/runtime | Telegram acknowledgement strategy (D11) | Vercel functions documentation |
| V19 | Free-tier allowances: Gemini RPM/RPD, Groq RPM/TPD, Supabase database size / storage / egress, Vercel invocation and duration allowances | Requirement 17.7 sizing note | Each provider's pricing/limits page |
| V20 | MediaRecorder MIME support on target Android browsers (which container/codec actually records) and whether it matches V10's accepted list | `src/components/VoiceRecorder.tsx` | MDN MediaRecorder compatibility data |
| V21 | Whether the deployment platform offers a **scheduled invocation** primitive on the target plan, its minimum interval, and how it authenticates the call it makes | Retention sweep trigger (Requirement 18.3, 18.4) | Deployment platform scheduled-jobs documentation |
| V22 | Storage object **deletion and age query** surface: the batch delete call and its path semantics, whether deleting an absent object errors, and whether `storage.objects` exposes a creation timestamp usable for age filtering | `src/lib/storage.ts`, `src/services/retention.service.ts` (Requirements 8.9, 18.3, 18.4, 18.10) | Supabase Storage delete reference and storage schema docs |
| V23 | Supabase Google OAuth: the `signInWithOAuth({ provider: 'google' })` call shape and its `redirectTo` option, the callback-route code-exchange helper name, where the Google client id and secret are configured, which redirect URLs must be registered, and which claim carries the Google email onto `auth.users` | `src/lib/supabase/*`, `src/app/auth/callback/route.ts` (Requirements 1.1–1.4) | Supabase social login (Google) and server-side auth docs |
| V24 | Telegram Bot API **method and update shapes**: `setWebhook` including its `secret_token` parameter and any length/character constraints on that token; the exact header name Telegram presents it in; the `Update` field paths for `update_id`, `message.from.id`, `message.text`, `message.photo[]`, `message.voice`, and the `/start` payload; `sendMessage` request shape and its text length cap; and Telegram's **retry behaviour on a non-200 response**, which D11's acknowledgement reasoning depends on | `src/lib/telegram.ts`, `src/app/api/telegram/route.ts` (Requirements 10.1–10.11, 11.1–11.8) | Telegram Bot API reference |
| V25 | Telegram **file retrieval**: `getFile(file_id)` → `file_path`, the download URL form built from the bot token and that path, the documented validity window of a `file_path`, and the bot-download size ceiling | Telegram adapter media fetch (Requirements 10.4, 10.6) | Telegram Bot API `getFile` reference |
| V26 | Telegram **inbound media facts**: that a `voice` message is always OGG/Opus and how it differs from `audio` and `document`, the `mime_type` and `file_size` fields actually present on each, and which entry of the `photo[]` size array to take for diagnosis. This row carries the fact that makes Requirement 10.6 satisfiable, so it is load-bearing rather than incidental | `src/lib/telegram.ts` (Requirements 10.4, 10.6, 10.9) | Telegram Bot API message-type reference |
| V27 | Razorpay: order-creation endpoint and request/response shape, which identifiers the browser checkout needs, the **webhook signature scheme** (header name, HMAC algorithm, encoding, and which secret keys it), the **event names** for a captured and a failed payment, the payload paths for the payment id, order id, amount, and status, and the difference between test and live mode credentials (requirements O22-3) | `src/lib/razorpay.ts`, `src/app/api/payment/*` (Requirements 22.1–22.11, 22.25) | Razorpay orders, checkout, and webhooks documentation |

Rule for implementation: if a V-item cannot be confirmed, the code must fail loudly at startup (missing env var / unsupported model) rather than fall back to a guessed value.

V21 and V22 were added by the media-lifecycle amendment. They are the only third-party facts the retention design depends on, and neither blocks the *deletion logic* — V21 blocks only the automatic trigger, for which a documented manual fallback exists (see *Media lifecycle and retention*).

V23 through V27 were added by Amendment A1, and V2 and V12–V15 were retired by it. The retired rows are left in place with their numbers rather than deleted, because `docs/VERIFIED_VALUES.md` resolved several of them with source URLs and dated notes, and a reader arriving from that file needs to find the number they came for and learn that it no longer applies. Note what the retirement costs: V14's resolved row is the only record of why Requirement 10.6 was unsatisfiable under the old channel, and V13's is the only record of the signature-encoding ambiguity Jamee had to accept. Both problems are now historical, and **D12** says why the replacement is not a downgrade.

---

## Design decisions that resolve requirement tensions

**D1 — `/api/diagnose` takes JSON, not multipart.** Requirement 2.2 mandates a JSON body carrying a storage reference, while Requirement 2.3 allows images up to 10 MB and Requirement 2.7 requires bodies under the platform ceiling (spec: 4.5 MB, V16). A multipart upload of a 10 MB image cannot satisfy both. The browser therefore uploads directly to Storage and posts a reference; the API reads bytes through a signed URL (Requirement 2.8). Consequence: request bodies are ~200 bytes regardless of image size, and the 10 MB allowance is real rather than nominal. The same reasoning applies to `/api/voice`.

**D2 — Validation is two-stage, so rejection reasons are distinguishable.** Requirement 5 wants a strict schema; Requirement 6.1 needs to know *specifically* that the rejection was an out-of-KB disease name. A single strict enum schema would report "parse failed" for both a malformed JSON blob and a real-but-unsupported disease. Stage 1 validates shape (`status`, `disease_name` as free string, `confidence`, `severity`, flags). Stage 2 checks knowledge-base membership. Both stages log a distinct `rejection_reason` (Requirement 5.7).

**D3 — Every validation failure produces the one inconclusive shape.** Requirement 6.1 only names the out-of-KB case. Requirements 5.2–5.5 (bad JSON, missing field, out-of-range confidence, bad severity) leave the farmer-facing outcome unstated. Decision: all of them map to `Inconclusive_Result` (Requirement 6.4's single shape), each with its own logged reason. A farmer never sees "the model returned malformed JSON"; they see an honest "Jamee could not judge this photo — consult an expert."

**D4 — No repair re-ask on validation failure.** We do not send a "your JSON was invalid, try again" second call. Requirement 6.6 forbids extra model calls once a result is inconclusive, and a repair loop would multiply free-tier consumption. One classification attempt per request (plus the provider fallback of Requirement 14.4, which is a *transport* retry, not a *content* retry).

**D5 — Inconclusive results, quota messages, and error messages are pre-translated static strings.** Requirement 6.6 forbids a model call for inconclusive results, Requirement 14.3 forbids provider calls when a quota is exhausted, and Requirement 15.3 requires localized messages. So en/hi/mr copy for these paths ships in the repository as static message catalogs. The model is used for translation only when rephrasing knowledge-base content for an *identified* condition.

**D6 — The "temporarily busy" literal is the English rendering of a coded error.** Requirement 14.5 specifies exact English text; Requirement 15.3 requires localization. Decision: error code `PROVIDERS_UNAVAILABLE` renders as exactly `Jamee is temporarily busy. Please try again shortly.` for `en`, with hi/mr equivalents in the catalog. Tests assert the English string byte-for-byte.

**D7 — Channel parity means one code path and identical structured fields, not identical prose — and it is asserted only where the farmer holds a Bot_Entitlement.** *Amended by Amendment A1.* Requirements 10.7 and 10.13 require the Telegram channel to agree with the web channel on the content of a Diagnosis_Result. Language models are not bit-deterministic, so parity is defined structurally: same `DiagnosisService` invocation, same knowledge-base row, identical `status`, `disease_name`, `severity`, and `needs_expert`. Explanation wording may differ between two runs of the same image on either channel. Classification runs at the lowest available temperature (V7) to maximize agreement.

The amendment adds a guard and takes nothing away. Under Requirement 22.13 an update from a linked farmer who holds no entitlement produces no Diagnosis_Result at all — the gate replies and returns before any service is invoked — so there is nothing on the Telegram side to compare, and an unguarded parity claim would be *unsatisfiable* for that farmer rather than merely unexercised. Parity is therefore stated as: **where the submitting farmer holds a Bot_Entitlement**, the two channels agree on those four fields. Where the guard does not hold, the correct Telegram outcome is the gated reply of 22.14, and that is not a parity failure. Note what the guard does not do: it does not weaken parity where it applies, and it introduces no entitlement-dependent branch inside `DiagnosisService`. The gate lives in the adapter, ahead of the service (**D14**), so the service still has exactly one behaviour and the parity test still exercises one code path.

**D8 — Profile creation uses a database trigger plus an idempotent server-side upsert, and it copies no phone number.** *Amended by Amendment A1.* Requirement 1.4 attributes profile creation to the Web_App. A purely client-driven insert can be skipped — the farmer closes the tab on the callback — and a farmer with no `profiles` row has no preferred language, no linking state, and nothing for an entitlement to hang off. So the obligation survives unchanged: an `on auth.users insert` trigger writes the row, and the post-sign-in server action upserts defensively. V5 records that Supabase documents the trigger as the supported pattern *and* warns that a failing trigger blocks sign-up, which is precisely why the upsert is the second half rather than the whole mechanism.

What changes is what gets copied. The trigger now writes `(id, email)` from the new `auth.users` row and writes **no** phone (Requirement 1.4 is explicit that the bootstrap stores no phone number). The `profiles.phone` column survives as nullable optional contact information with no constraint and no reader (Requirement 1.9).

**The E.164 normalizer goes away with it, and this is worth stating rather than leaving a reader to notice a deletion.** Under phone identity the bootstrap had a production-blocking defect: Supabase Auth stores `auth.users.phone` with the leading `+` stripped, while `profiles.phone` carried a `check (phone ~ '^\+[1-9][0-9]{7,14}$')` constraint and inbound WhatsApp senders arrived as a bare `wa_id`. The trigger, the constraint, and the adapter therefore disagreed about the same value's format, and every path that touched a phone needed a normalizer plus a test asserting the `+` was restored — a normalizer that, if it ever ran in only two of the three places, would have produced a sign-up that failed or a sender that resolved to nobody. None of that exists now. There is no format to reconcile, because the identity is a uuid the database generates and the trigger copies verbatim: `auth.users.id` → `profiles.id`. The normalizer is **not lost, it is unnecessary** — the problem it patched is gone with the identity that created it. Telegram senders resolve through `profiles.telegram_user_id`, a numeric id written only by the linking flow (**D13**), never parsed out of a message and never reformatted.

**D9 — Chat language follows the message, resolved by the model, not by a script detector.** Requirement 9.6 requires answering in the language of the submitted message. Hindi and Marathi share the Devanagari script and cannot be separated by a character-range check. The chat prompt receives the farmer's preferred language *and* an instruction to answer in the message's language when that language is en/hi/mr. Requirement 9.5 still rejects unsupported explicit language codes at the edge with HTTP 400.

**D10 — `usage_logs` is an append-only audit table and is not the quota source of truth.** The requirements rename the spec's `api_usage` to `usage_logs` (glossary) and require it to record fallbacks (14.7) and validation rejections (5.7) in addition to billable operations. Those rows are not 1:1 with quota units, so quota lives in a separate counter table (see Quota enforcement).

**D11 — The Telegram adapter processes inline and acknowledges after processing, guarded by a soft deadline.** *Amended by Amendment A1 — naming only; the reasoning is unchanged.* Discussed under *Telegram adapter*. The shape of the decision survives the channel change intact: the `update_id` is claimed before anything billable, the reply is sent, `markProcessed` runs after the reply, and the unit of work is one update rather than one batch. One input to the old reasoning disappears — Telegram has no 24-hour customer-service window and no template requirement, so a late or deferred reply is a latency problem and not a deliverability one (V15 is retired; V24 supplies Telegram's retry behaviour on a non-200).

**D12 — Webhook authenticity is a shared secret token compared in constant time, not an HMAC over the body.** Requirement 11.2 registers a `Webhook_Secret_Token` through `setWebhook` and has Telegram present it in the `X-Telegram-Bot-Api-Secret-Token` header of every delivery. Jamee compares that header against the configured value in constant time **before parsing the body**, answers 401 on a missing or mismatched value, and treats an unconfigured secret as a failed verification rather than a skipped one (Requirement 11.4). There is no GET handshake, because Telegram has no verification challenge: registration is an authenticated call Jamee makes outbound.

This reads like a weaker primitive than an HMAC and is not, for three reasons worth recording because the instinct is to assume otherwise. First, the threat the old HMAC defended against was a forged *body*, and the body is not what Jamee trusts here — the secret token is a bearer credential over TLS that Jamee itself generated and that only Telegram was ever told, so an attacker who cannot read the header cannot produce it, and one who can read it could equally have stolen an app secret. Second, the failure modes are strictly fewer: an HMAC has to be computed over the exact bytes the sender signed, which forced the old design to read the body as text, verify, and only then `JSON.parse` — a constraint a future refactor to `request.json()` would silently break. A header comparison has no such coupling to body bytes, so the ordering requirement of 11.2 ("before parsing") is a cheap invariant instead of a fragile one. Third, it retires a genuine unknown rather than trading it for another: V13 could not confirm from first-party documentation whether Meta's digest was hex or base64, and the design had to accept an ambiguity in the one comparison that must not be wrong. A fixed string has no encoding. What Jamee gives up is that the token does not attest to the *payload*, so a replayed body from a party who has the token is still accepted — which is exactly what the `update_id` claim of Requirement 11.7 exists to make harmless, and it is enforced by a `UNIQUE` primary key rather than by trust.

**D13 — Linking is proved by an explicit single-use expiring token, and the bind and the consume are one statement.** Requirement 21 has to bind one Telegram account to one Jamee account with no phone number anywhere in the picture. Three mechanisms were available and two are unsafe.

*Implicit matching is not available at all.* A Google identity carries no phone number, and a Telegram update carries no email, so there is no shared attribute to join on. Matching on a display name, or on "the most recently signed-in farmer", would bind an account on a coincidence. Requirement 21.2 forbids deriving any part of the token from an `Auth_User_Id`, a `Google_Email`, a `Telegram_User_Id`, or a timestamp, which closes the door on a "derive it deterministically and skip the storage" variant: anything derivable by Jamee from public-ish inputs is derivable by an attacker who can send `/start` to a public bot.

*So the binding is proved in both directions.* The farmer proves control of the Jamee account by minting the token inside an authenticated session, and proves control of the Telegram account by delivering that same token from it, as the payload of `/start` carried by a `https://t.me/<bot>?start=<token>` deep link. The token is a capability and nothing else: it authorizes exactly one binding and grants no session, no read, and no second use (Requirement 21.5).

*Single-use and expiring are not belt-and-braces, they bound distinct exposures.* The deep link travels through whatever the farmer used to open it — a browser history entry, a screenshot, a copied message — so a token's lifetime is the window in which a leaked link is still a binding. Expiry (a compile-time constant, minutes, Requirement 21.4) bounds that window in time; single-use bounds it in count, so a link that is leaked *after* a successful bind is already spent. Either one alone leaves a hole the other closes.

*The bind and the consume must be one atomic operation* (Requirement 21.7). Two concurrent `/start` deliveries of one token — trivially producible, since Telegram redelivers on a non-200 and a farmer can tap a link twice — would otherwise both read an unconsumed row, both write a `telegram_user_id`, and both reply "linked". The consequence is not a duplicate reply, it is that the second write can land a *different* sender's id on the profile. So the mechanism is a single conditional `update … where consumed_at is null and expires_at > now()` whose `RETURNING` clause is the authorization: if it returns no row, the token was not valid at the instant of the write, and no binding is attempted. There is no read-then-write, for the same reason the quota counter and the `update_id` claim have none.

*The replies for unknown, expired, and consumed are byte-identical* (Requirement 21.8). Distinguishing them would turn the bot into a token-validity oracle: a party who can send arbitrary `/start` payloads to a public bot could tell "no such token" from "that token existed and has expired", which leaks whether a guess was structurally right and makes enumeration measurably cheaper. The three cases share one message and one code path that never learns which of them it is in.

**D14 — The entitlement gate sits in the adapter, after the claim and the resolution, and is keyed to the auth user id.** Requirement 22.16 fixes the order, and each position earns its place. Secret-token verification is first because an unauthenticated request must not cost a database round trip (**D12**). The `update_id` claim is second because it must precede anything billable, and a database read to resolve a profile is the cheapest thing it must precede (Requirement 11.7). Profile resolution is third because the entitlement is a property of the profile, so there is nothing to check before one exists. The entitlement check is fourth and last, immediately before the first line of farmer-facing work. It therefore gates the photo, text, and voice handling of 10.4, 10.5, and 10.6, and exempts exactly three things: the `/start` exchange, the linking instructions of 10.3, and the gated reply of 22.14 itself (Requirement 22.15).

Putting the gate in the adapter rather than inside the services is what keeps **D7**'s parity claim testable and Requirement 22.17's "the web stays free" true by construction: the services have no entitlement parameter, cannot consult one, and so cannot accidentally start gating the web channel. A gated update reserves no quota unit, persists no row, and invokes no service (Requirement 22.13), which puts it in the same class as a duplicate delivery — acknowledged with 200 and audited by the `telegram_inbound` row alone.

**The entitlement is keyed to the `Auth_User_Id`, never to a `Telegram_User_Id`** (Requirements 22.12, 22.20). The farmer paid, not the chat account. Keying it to the chat account would mean that unlinking discards a purchase, that re-linking from a new phone requires paying twice, and that a farmer who loses access to a Telegram account loses a permanent entitlement — three support problems manufactured by a schema choice. With the auth user id as the key, `unlink` clears one nullable column and costs nothing (Requirement 21.15), the entitlement row is untouched, and the farmer's next binding is served without further payment (Requirement 22.19). It also makes the `UNIQUE` constraint the right one: at most one entitlement per farmer, which is exactly the "one-time, permanent" semantics, whereas a Telegram-keyed row would permit one farmer to accumulate several.

**D15 — The payment webhook is trusted only after a signature over the raw body, and its idempotency is a claim rather than a read.** This is the one Jamee write path reachable with no farmer session at all (Requirement 22.24), so three properties carry the whole boundary.

*The signature is verified over the exact raw bytes, before any parse* (Requirement 22.5). `request.json()` discards those bytes and re-serializing the parsed object will not reproduce them — key order, whitespace, and unicode escaping all differ — so the body is read once as text, verified, and only then parsed. This is the same discipline the retired WhatsApp POST path used, and it is the one thing from that path worth keeping: the argument was never about which provider signs, it was about what "the body" means.

*An absent secret is a failed verification, not a skipped one* (Requirement 22.6). The tempting implementation is `if (secret) verify(...)`, which is a deployment where someone forgot an environment variable turning into a deployment where anyone can grant themselves an entitlement by POSTing a JSON body. The check is written so the unconfigured case falls into the same 401 branch as a wrong signature, and `serverEnv` fails loudly at first use besides.

*Idempotency is a `UNIQUE` claim on the provider's payment id, not a read-then-write* (Requirement 22.11). Razorpay retries, and a retry that arrives while the first delivery is still inside the handler would pass a `select … where payment_id = ?` check twice. So the grant is an `insert … on conflict do nothing` on a column carrying a `UNIQUE` constraint, and a zero-row result **is** the duplicate signal — acknowledge 200, change nothing (Requirement 22.10). This is the third instance of the same pattern in this design (the quota counter, the `update_id` claim, this), and the reason is identical each time: under `read committed`, a check and a write in two statements is a race, and the database is the only thing that can make them one.

*Only the verified payload plus the recorded Payment_Order determine who paid what* (Requirement 22.7). The browser reports a checkout success too, and that report grants nothing — it only tells the UI to start showing an optimistic "confirming your payment" state. The amount, the currency, and the owning farmer are all server-side (Requirement 22.2), so a tampered request body cannot buy an entitlement for a different farmer or at a different price.

**D16 — The payment webhook is rate limited per caller, which needs a limiter that does not require a farmer.** Requirement 13.9 asks for a bound on the work one caller can drive on the payment webhook route, and this collides with the existing limiter: `counters` is keyed on `user_id` with a `not null` foreign key to `profiles`, and on this route there is no farmer to key on until a signature verifies — and a caller whose signatures never verify never produces one. Reusing `counters` is therefore impossible rather than merely awkward.

Decision: a separate `webhook_throttle` table keyed on an opaque caller key and a minute window, with no foreign key and no farmer column, incremented by the same single-statement `on conflict … where used < limit` pattern as `counter_try_increment` (see migration 0013). The caller key is a hash of the platform-reported client address, never the raw address, so the table holds no retained network identifier. This is stated with its limitation rather than oversold: a client address is shared behind NAT and forgeable at scale, so this bound is a cost control, not an authentication control. The actual defence is ordering — verification is one HMAC over an already-read body and precedes every database write and every allocation — so an unauthenticated flood costs an invocation and a hash, and the limiter's job is only to stop even that from consuming the free-tier invocation allowance. The same table serves the Telegram webhook route, which has the identical shape of problem for the same reason.

---

## Architecture

### Layers

| Layer | Responsibility | Must not |
| --- | --- | --- |
| **Route handlers** (`src/app/api/*`) | Session check, Zod-parse the request, resolve language, call one service, map result/error to HTTP | Contain agronomy, prompt text, provider calls, or SQL |
| **Domain services** (`src/services/*`) | Diagnosis, Chat, Voice orchestration: ownership check → quota reserve → provider call → validation → KB grounding → persistence. Accept `channel` as a parameter (Requirement 16.5) | Know anything about HTTP, cookies, or Telegram payloads; consult a Bot_Entitlement (D14) |
| **Access services** (`src/services/linking.service.ts`, `entitlement.service.ts`, `payment.service.ts`) | Mint and atomically consume a Link_Token, bind or clear a `telegram_user_id`, create a Payment_Order, grant a Bot_Entitlement, answer "does this farmer hold one" | Produce farmer-facing agronomy, call a model provider, or touch a quota counter |
| **AI gateway** (`src/lib/ai/gateway.ts`) | Capability-based provider selection, fallback policy (Requirement 14.4), returns raw provider text plus which provider served it | Interpret content or decide farmer-facing messaging |
| **Provider adapters** (`gemini.ts`, `groq.ts`) | One provider each: request shaping, error classification into `RATE_LIMIT` / `UNAVAILABLE` / `OTHER` | Retry across providers |
| **Repositories + storage** (`src/lib/db/*`, `src/lib/storage/*`) | Typed Supabase access, signed URLs, service-role isolation | Leak the service-role client toward the browser |

### System diagram

```mermaid
graph TB
    subgraph Clients
        BROWSER["Browser (Next.js client components)"]
        TG["Telegram (farmer's app)"]
    end

    subgraph Vercel["Vercel - Next.js App Router"]
        subgraph Routes["Route handlers (thin)"]
            RD["/api/diagnose"]
            RC["/api/chat"]
            RV["/api/voice"]
            RT["/api/telegram"]
            RL["/api/link/token"]
            RPO["/api/payment/order"]
            RPW["/api/payment/webhook"]
        end
        subgraph Domain["Shared domain services"]
            DS["DiagnosisService"]
            CS["ChatService"]
            VS["VoiceService"]
            QS["QuotaService"]
        end
        subgraph Access["Access services"]
            LS["LinkingService<br/>mint + atomic consume"]
            ES["EntitlementService<br/>gate lookup"]
            PS["PaymentService<br/>order + grant"]
        end
        TGA["TelegramAdapter<br/>secret token + update_id claim<br/>+ profile resolve + entitlement gate"]
        GW["AiGateway<br/>capability routing + fallback"]
        VAL["Validation_Layer (Zod)"]
        REPO["Repositories + Storage helpers"]
    end

    subgraph Providers["External providers"]
        GEM["Gemini multimodal - VERIFY model id"]
        GRQ["Groq text - VERIFY model id"]
        WHS["Whisper STT - VERIFY host + model id"]
        TAPI["Telegram Bot API - VERIFY method shapes"]
        RZP["Razorpay - VERIFY order + webhook scheme"]
    end

    subgraph Supabase
        AUTH["Auth - Google OAuth"]
        DB[("Postgres + RLS")]
        ST[("Private buckets<br/>crop-images / voice-messages")]
    end

    BROWSER -->|"signed direct upload"| ST
    BROWSER -->|"JSON: storage ref + language"| RD
    BROWSER --> RC
    BROWSER --> RV
    BROWSER -->|"Google sign-in"| AUTH
    BROWSER -->|"mint Link_Token"| RL
    BROWSER -->|"start checkout"| RPO
    BROWSER -->|"checkout"| RZP
    RZP -->|"signed webhook POST"| RPW
    TG --> TAPI
    TAPI -->|"webhook POST + secret token"| RT
    RT --> TGA
    TGA -->|"getFile + file download"| TAPI
    TGA -->|"sendMessage reply"| TAPI
    TGA -->|"service-role upload"| ST

    RD --> DS
    RC --> CS
    RV --> VS
    TGA --> DS
    TGA --> CS
    TGA --> VS
    TGA --> LS
    TGA --> ES
    RL --> LS
    RPO --> PS
    RPW --> PS

    DS --> QS
    CS --> QS
    VS --> QS
    VS --> CS

    DS --> GW
    CS --> GW
    VS --> GW
    GW --> GEM
    GW -.->|"fallback"| GRQ
    GW --> WHS
    GW --> VAL
    VAL --> REPO
    DS --> REPO
    CS --> REPO
    QS --> DB
    LS --> DB
    ES --> DB
    PS --> DB
    PS --> RZP
    REPO --> DB
    REPO --> ST
```

Two edges in that diagram are the whole access story. `TGA --> ES` is the gate: it resolves before any edge into `Domain` is taken, so a farmer with no entitlement never reaches a shared service (**D14**). `RPW --> PS` is the only path that grants one, and it is the only inbound edge in the diagram with no farmer session behind it, which is why **D15** treats its signature check as the entire boundary.

### Diagnosis sequence — both channels converge

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant T as Telegram Bot API
    participant RH as Route handler<br/>(/api/diagnose or /api/telegram)
    participant AD as TelegramAdapter
    participant ES as EntitlementService
    participant DS as DiagnosisService (shared)
    participant Q as QuotaService
    participant ST as Supabase Storage
    participant GW as AiGateway
    participant V as Validation_Layer
    participant DB as Postgres

    rect rgb(238,245,255)
    note over B,RH: Web path
    B->>ST: direct upload to crop-images/{user_id}/...
    ST-->>B: storage reference
    B->>RH: POST {bucket, path, language, conversationId?}
    RH->>RH: session check (401 if absent)
    note right of RH: no Bot_Entitlement check here (Req 22.17)
    end

    rect rgb(240,255,240)
    note over T,ES: Telegram path - order fixed by Req 22.16
    T->>RH: webhook POST + X-Telegram-Bot-Api-Secret-Token
    RH->>AD: constant-time secret token compare (401, body unparsed)
    AD->>DB: insert update_id (unique)
    note right of AD: duplicate -> 200, zero quota, no service call
    AD->>DB: resolve profiles.telegram_user_id -> profile
    note right of AD: no profile -> linking instructions, zero quota
    AD->>ES: holdsEntitlement(profile.id)
    ES-->>AD: yes / no
    note right of AD: no -> unlock reply (22.14), zero quota,<br/>no service call, no row persisted
    AD->>T: getFile(file_id) -> file_path
    AD->>T: GET file endpoint + file_path
    AD->>ST: service-role upload to crop-images/{user_id}/...
    end

    RH->>DS: diagnose({userId, storageRef, language, channel, conversationId?})
    AD->>DS: diagnose({userId, storageRef, language, channel:'telegram', conversationId})

    DS->>ST: verify bucket + {user_id}/ prefix ownership
    ST-->>DS: object metadata
    note over DS: mismatch -> 403, quota untouched
    DS->>Q: reserve('image') atomically
    Q-->>DS: allowed / at-limit
    note over DS: at-limit -> decline with limit + reset, no provider call
    DS->>ST: create signed URL
    DS->>GW: classify(image bytes, strict JSON schema)
    GW-->>DS: raw model output + provider used
    DS->>V: stage 1 shape, stage 2 KB membership
    alt validated verified condition
        DS->>DB: read disease_knowledge row
        DS->>GW: rephrase KB content into language
        GW-->>DS: localized explanation
    else unknown / blurry / non-plant / out-of-KB / malformed
        note over DS: static localized inconclusive copy,<br/>no further model call
    end
    DS->>DB: insert diagnoses row (+ conversation, channel)
    DS->>DB: insert usage_logs row (provider, outcome, fallback?)
    DS-->>RH: Diagnosis_Result
    DS-->>AD: Diagnosis_Result
    RH-->>B: JSON result
    AD->>T: sendMessage reply
    AD-->>T: HTTP 200
```

### Linking and payment sequences

Neither path reaches a shared service, reserves a quota unit, or calls a model provider (Requirements 21.18, 22.13).

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant RL as /api/link/token
    participant LS as LinkingService
    participant DB as Postgres
    participant T as Telegram Bot API
    participant AD as TelegramAdapter

    B->>RL: POST (authenticated session)
    RL->>LS: mint(authUserId)
    LS->>DB: insert link_tokens (token_hash, user_id, expires_at)
    LS-->>B: deep link - t.me/BOT?start=TOKEN
    B->>T: farmer opens the deep link, sends /start TOKEN
    T->>AD: webhook update (secret token verified, update_id claimed)
    AD->>DB: single UPDATE - consume token AND bind telegram_user_id
    note right of AD: RETURNING no row -> "link no longer valid",<br/>identical wording for unknown / expired / consumed (21.8)
    AD->>T: confirmation reply in the Profile's language (21.19)
```

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant RPO as /api/payment/order
    participant PS as PaymentService
    participant RZP as Razorpay
    participant RPW as /api/payment/webhook
    participant DB as Postgres

    B->>RPO: POST (authenticated session, empty body)
    RPO->>PS: createOrder(authUserId)
    note right of PS: amount, currency, owner all server-side (22.2)
    PS->>RZP: create order for BOT_UNLOCK_PRICE
    PS->>DB: insert payment_orders (provider_order_id, user_id, 'created')
    PS-->>B: checkout identifiers only
    B->>RZP: checkout
    RZP->>RPW: POST event + signature header
    RPW->>RPW: HMAC over RAW body, constant time; absent secret = fail (22.6)
    RPW->>PS: onVerifiedEvent(payload)
    PS->>DB: insert bot_entitlements (user_id, provider_payment_id) - UNIQUE claim
    note right of PS: zero rows claimed -> duplicate -> 200, no state change (22.10)
```

---

## Project structure

```
src/
  app/
    layout.tsx                     # locale + font shell
    page.tsx                       # sign-in / landing (server component)
    diagnose/page.tsx              # upload + result screen
    chat/page.tsx                  # conversation screen
    voice/page.tsx                 # hold-to-speak screen
    history/page.tsx               # server component, RLS-scoped list
    diagnosis/[id]/page.tsx        # detail view (Requirement 12.3)
    profile/page.tsx               # display name + preferred language (Requirement 1.8)
    auth/callback/route.ts         # OAuth code exchange + ensure-profile (D8, V23)
    api/
      diagnose/route.ts            # POST, JSON storage ref (D1)
      chat/route.ts                # POST
      voice/route.ts               # POST
      telegram/route.ts            # POST webhook only - secret token (D12)
      link/token/route.ts          # POST mint Link_Token (21.1), DELETE unlink (21.15)
      payment/order/route.ts       # POST create Payment_Order (22.1)
      payment/webhook/route.ts     # POST, no session, signature-authenticated (22.24)
  components/
    GoogleSignInButton.tsx         # signInWithOAuth({provider:'google'}), client
    ImageUploader.tsx              # validation + direct upload, client
    DiagnosisResultCard.tsx        # severity, confidence, needs_expert banner
    ChatThread.tsx / ChatComposer.tsx
    VoiceRecorder.tsx              # MediaRecorder, 120s / 10MB caps
    LanguageSwitcher.tsx
    HistoryList.tsx / EmptyState.tsx
    ErrorBanner.tsx                # code -> localized message + retry
    TelegramLinkCard.tsx           # linked state + link / unlink action (21.20)
    BotUnlockCard.tsx              # price, checkout, active-entitlement state (22.18)
  services/
    diagnosis.service.ts           # single image-analysis implementation (16.3)
    chat.service.ts                # single grounding/rephrase implementation (16.4)
    voice.service.ts
    quota.service.ts
    conversation.service.ts        # find-or-create per channel
    linking.service.ts             # mint + atomic consume-and-bind (D13)
    entitlement.service.ts         # holdsEntitlement + grant (D14)
    payment.service.ts             # order creation + verified-webhook grant (D15)
  lib/
    supabase/
      client.ts                    # browser client (anon key)
      server.ts                    # RLS-scoped server client (user session)
      admin.ts                     # service-role client, server-only guard
    ai/
      gateway.ts                   # capability routing + fallback (14.4)
      errors.ts                    # RATE_LIMIT | UNAVAILABLE | OTHER
    gemini.ts                      # primary adapter (V6, V7)
    groq.ts                        # text fallback + transcription (V8, V9, V10)
    telegram.ts                    # secret token, parse, getFile, sendMessage (V24-V26)
    razorpay.ts                    # order create + webhook signature (V27)
    prompts.ts                     # classification + rephrase + chat prompts
    schemas.ts                     # all Zod schemas (single source)
    knowledge.ts                   # KB lookup + verified-condition enum
    messages/                      # static en/hi/mr catalogs (D5)
      en.ts  hi.ts  mr.ts
    errors.ts                      # AppError + code -> status mapping
    storage.ts                     # path builder, signed URLs, ownership check
    rate-limit.ts                  # per-farmer burst limiter (13.8) + per-caller
                                   #   webhook throttle (13.9, D16)
    config/
      media.ts                     # MEDIA_RETENTION_DAYS (18.1)
      access.ts                    # LINK_TOKEN_TTL_MINUTES (21.4),
                                   #   BOT_UNLOCK_PRICE (22.4) - one place each,
                                   #   never an env var
    time.ts                        # Asia/Kolkata window keys + reset time
  types/
    domain.ts  api.ts  database.ts # generated Supabase types
supabase/
  migrations/
    0001_extensions.sql
    0002_profiles.sql
    0003_conversations_messages.sql
    0004_disease_knowledge.sql
    0005_diagnoses.sql
    0006_usage_logs.sql
    0007_counters_and_quota_fn.sql
    0008_telegram_inbound.sql
    0009_storage_buckets_policies.sql
    0010_seed_disease_knowledge.sql
    0011_link_tokens.sql                 # Requirement 21
    0012_payment_orders_entitlements.sql # Requirement 22
    0013_webhook_throttle.sql            # Requirement 13.9 (D16)
docs/
  API.md  DEPLOYMENT.md  TESTING_REPORT.md
.env.example
```

`src/services/*` and `src/lib/*` never import from `src/app/*`. That one-way rule is what keeps Requirement 16.3/16.4's "exactly one implementation" true over time.

---

## Data model and migrations

Six domain tables, three access tables (Requirements 21 and 22), and three operational tables. Enum-like columns are `text` with check constraints rather than Postgres enums, so a new severity or channel is a migration edit instead of a type alteration; the check constraint keeps the database as strict as the Zod layer.

`updated_at` is maintained by one shared trigger function so no route handler has to remember it.

**Amendment A1 edits migrations in place rather than shipping a column-altering follow-up.** Nothing in `supabase/migrations/` has been applied to a deployed project yet — this is a pre-pilot release — so `0002` is rewritten, `0003` / `0005` / `0006` have their `channel` check constraints corrected, and `0008` is renamed and re-keyed. Amending is the honest option here: an `alter table … drop constraint` follow-up would leave the original phone-identity schema readable as though it had once been real, and a future reader would have to replay two migrations to learn what the table is. Three new migrations, `0011`–`0013`, add the access tables. If a project has already been migrated, the corrections have to arrive as `0014` instead, and the in-place edits above become a documentation-only change.

### 0001–0002: extensions and profiles

```sql
-- 0001_extensions.sql
create extension if not exists pgcrypto;   -- gen_random_uuid()

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
```

```sql
-- 0002_profiles.sql
create table public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
                                                             -- Auth_User_Id IS the identity (Req 1.5)
  email            text,                                      -- Google_Email (Req 1.4)
  telegram_user_id bigint unique,                             -- nullable + UNIQUE (Req 21.16)
  phone            text,                                      -- optional contact info only (Req 1.9):
                                                              --   no not null, no unique, no check,
                                                              --   no reader anywhere in the codebase
  display_name     text,
  language         text not null default 'en'
                     check (language in ('en','hi','mr')),    -- Req 9.1
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Telegram sender resolution (Req 10.2). The UNIQUE constraint above already
-- creates the index this lookup uses, so no second index is declared.

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- D8: bootstrap on first session. Copies the email, never a phone (Req 1.4).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;
-- VERIFY AT IMPLEMENTATION (V5): trigger on auth.users is the supported bootstrap pattern
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;

create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
create policy profiles_insert_own on public.profiles
  for insert with check (auth.uid() = id);
```

The load-bearing constraint moved. It is now `telegram_user_id bigint unique`: Requirement 10.12 says one Telegram account belongs to at most one Profile, and Requirement 21.16 requires that rule to be enforced by the database rather than by application code alone — so the `/start` handler of **D13** does not have to defend the invariant, it only has to handle the unique violation, which is the case of Requirement 21.13 (this Telegram account is already linked elsewhere). The column is nullable because an unlinked farmer is the normal state, and Postgres treats nulls as distinct, so any number of unlinked profiles coexist.

`phone` keeps its column and loses everything else: no `not null`, no `unique`, no E.164 check constraint, and no index. **D8** records why the normalizer that used to accompany it is gone rather than misplaced. Nothing reads this column; it exists because Requirement 1.9 says it exists as optional contact information, and a CI check that greps for readers of `profiles.phone` outside a migration is the cheapest way to keep that true.

`email` is nullable rather than `not null` on purpose. It is copied from `auth.users` by a trigger that V5 warns can fail without blocking the row, so a hard constraint here would turn a missing claim into a sign-up that cannot complete. The identity does not depend on it.

### 0003: conversations and messages

```sql
create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  channel    text not null check (channel in ('web','telegram')),
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_user_recent_idx
  on public.conversations (user_id, updated_at desc);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  role            text not null check (role in ('farmer','jamee')),
  content         text not null,
  language        text not null check (language in ('en','hi','mr')),
  channel         text not null check (channel in ('web','telegram')),
  input_kind      text not null default 'text'
                    check (input_kind in ('text','voice','image')),
  transcript_of   text,                    -- storage path when input_kind='voice'
  created_at      timestamptz not null default now()
);

create index messages_conversation_idx
  on public.messages (conversation_id, created_at desc);   -- Conversation_Context window
```

`messages.user_id` is denormalized from the conversation purely so RLS can be a single-column predicate without a join, which keeps context reads cheap.

### 0004: disease_knowledge

```sql
create table public.disease_knowledge (
  id             uuid primary key default gen_random_uuid(),
  disease_name   text not null unique check (disease_name in (
                   'Tomato Early Blight','Tomato Late Blight','Tomato Healthy',
                   'Potato Early Blight','Potato Late Blight')),
  crop           text not null check (crop in ('tomato','potato')),
  scientific_name text,                       -- null for the healthy entry
  symptoms       text[] not null,
  causes         text[] not null,
  treatment      text[] not null,             -- empty array for the healthy entry
  prevention     text[] not null,
  default_severity text not null check (default_severity in ('none','low','moderate','high')),
  source         text not null,               -- Req 4.2: provenance per row
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint healthy_has_no_treatment check (
    disease_name <> 'Tomato Healthy' or cardinality(treatment) = 0
  )
);

create trigger disease_knowledge_set_updated_at
  before update on public.disease_knowledge
  for each row execute function public.set_updated_at();

alter table public.disease_knowledge enable row level security;

create policy dk_select_authenticated on public.disease_knowledge
  for select to authenticated using (true);                  -- Req 13.3
-- Req 13.4: no insert/update/delete policy exists for authenticated or anon.
-- Writes are possible only through the service role, which bypasses RLS.
```

Requirement 4.1 says the knowledge base holds *exactly* five entries. The `unique` constraint plus the name check constraint make five the maximum; the seed migration makes five the minimum. A deployment test asserts `count(*) = 5`.

### 0005: diagnoses

```sql
create table public.diagnoses (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  status          text not null check (status in ('identified','unknown')),
  disease_name    text check (disease_name in (
                    'Tomato Early Blight','Tomato Late Blight','Tomato Healthy',
                    'Potato Early Blight','Potato Late Blight')),  -- Req 4.1 / 5.6
  knowledge_id    uuid references public.disease_knowledge(id),
  confidence      numeric(4,3) check (confidence >= 0 and confidence <= 1),  -- Req 5.4
  severity        text not null check (severity in ('none','low','moderate','high')),
  explanation     text not null,
  language        text not null check (language in ('en','hi','mr')),
  needs_expert    boolean not null default false,
  channel         text not null check (channel in ('web','telegram')),  -- Req 16.5
  image_bucket    text not null check (image_bucket = 'crop-images'),
  image_path      text not null,
  -- Requirement 18.7: set by the retention sweep when the full-size original is deleted.
  -- image_path is left intact so the thumbnail path stays derivable from it.
  full_image_deleted_at timestamptz,
  model_provider  text not null check (model_provider in ('gemini','groq')),
  created_at      timestamptz not null default now(),

  -- Inconclusive_Result shape is enforced by the database, not just by code (Req 6.4, 6.5)
  constraint diagnoses_unknown_shape check (
    status <> 'unknown' or
    (disease_name is null and knowledge_id is null
     and needs_expert = true and severity = 'none')
  ),
  constraint diagnoses_identified_shape check (
    status <> 'identified' or (disease_name is not null and knowledge_id is not null)
  )
);

create index diagnoses_user_recent_idx on public.diagnoses (user_id, created_at desc);   -- Req 12.1
create index diagnoses_conversation_idx on public.diagnoses (conversation_id, created_at desc);

-- Retention sweep candidate scan: rows whose original has not yet been deleted,
-- oldest first. Partial so the index shrinks as the sweep does its job (Req 18.3).
create index diagnoses_retention_idx on public.diagnoses (created_at)
  where full_image_deleted_at is null;
```

Those two check constraints are the reason an inconclusive result cannot silently carry a disease name or treatment reference: a bug that tried to persist one fails the insert rather than reaching a farmer. `disease_knowledge` is created in 0004 so this foreign key resolves.

`full_image_deleted_at` exists so the history view can tell "deleted by policy" from "missing unexpectedly" with a column read instead of a storage probe per list row. Probing would cost one storage call per history entry on every render, which is exactly the egress-and-invocation cost the amendment set out to remove. The column is nullable and has no constraint tying it to `image_path`, because `image_path` is deliberately left intact: the thumbnail path is derived from it, so erasing it would take the surviving thumbnail with it.

### 0006: usage_logs (renamed from `api_usage`)

The glossary names this table `usage_logs`; earlier drafts called it `api_usage`. The rename is adopted here, and the table's job is wider than API accounting — it is the audit trail for Requirements 5.7, 14.6, 14.7, and 3.7.

```sql
create table public.usage_logs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  operation        text not null check (operation in ('image','chat','voice')),
  channel          text not null check (channel in ('web','telegram')),
  model_provider   text check (model_provider in ('gemini','groq','none')),
  outcome          text not null check (outcome in (
                     'success','inconclusive','validation_rejected',
                     'provider_error','timeout','quota_declined','duplicate_ignored'
                   )),
  used_fallback    boolean not null default false,        -- Req 14.7
  rejection_reason text,                                  -- Req 5.7 / D2
  quota_spent      boolean not null default true,         -- audit of the spend rule
  latency_ms       integer,
  prompt_version   text,                                   -- attributes a behavioural change
  conversation_id  uuid references public.conversations(id) on delete set null,
  diagnosis_id     uuid references public.diagnoses(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index usage_logs_user_day_idx on public.usage_logs (user_id, created_at desc);
create index usage_logs_outcome_idx  on public.usage_logs (outcome, created_at desc);
```

Columns carried, and why each exists: `user_id`, `operation`, `channel`, `model_provider`, `outcome` (Requirement 14.6); `used_fallback` (14.7); `rejection_reason` (5.7 and D2's distinguishable reasons); `quota_spent` so the spend rule is auditable against the counter table; `latency_ms` for the free-tier sizing note; `prompt_version` so a prompt change is attributable to the rows it produced (see Prompting and grounding); `conversation_id` / `diagnosis_id` for tracing a log row back to what the farmer saw.

### 0007: counters and the atomic quota function

```sql
create table public.counters (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  operation   text not null check (operation in ('image','chat','voice')),
  window_kind text not null check (window_kind in ('day','minute')),
  window_key  text not null,          -- 'YYYY-MM-DD' (Asia/Kolkata) or 'YYYY-MM-DDTHH:MM'
  used        integer not null default 0 check (used >= 0),
  updated_at  timestamptz not null default now(),
  primary key (user_id, operation, window_kind, window_key)
);

-- Atomic reserve. Returns the new count on success, null when already at the limit.
create or replace function public.counter_try_increment(
  p_user uuid, p_operation text, p_window_kind text, p_window_key text, p_limit int
) returns integer
language sql security definer set search_path = public as $$
  insert into public.counters (user_id, operation, window_kind, window_key, used)
  values (p_user, p_operation, p_window_kind, p_window_key, 1)
  on conflict (user_id, operation, window_kind, window_key) do update
    set used = public.counters.used + 1,
        updated_at = now()
    where public.counters.used < p_limit
  returning used;
$$;

-- Refund (see spend rule). Never goes below zero.
create or replace function public.counter_decrement(
  p_user uuid, p_operation text, p_window_kind text, p_window_key text
) returns integer
language sql security definer set search_path = public as $$
  update public.counters
     set used = used - 1, updated_at = now()
   where user_id = p_user and operation = p_operation
     and window_kind = p_window_kind and window_key = p_window_key
     and used > 0
  returning used;
$$;

create or replace function public.counter_used(
  p_user uuid, p_operation text, p_window_kind text, p_window_key text
) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((select used from public.counters
    where user_id = p_user and operation = p_operation
      and window_kind = p_window_kind and window_key = p_window_key), 0);
$$;

alter table public.counters enable row level security;
create policy counters_select_own on public.counters
  for select using (auth.uid() = user_id);
-- writes only via the security-definer functions, invoked with the service role
```

### 0008: Telegram inbound idempotency store

```sql
create table public.telegram_inbound (
  update_id        bigint primary key,               -- Req 11.6 - Telegram's update_id
  telegram_user_id bigint,                           -- null when the update carries no sender
  user_id          uuid references public.profiles(id) on delete set null,
  message_type     text not null,                    -- start | text | photo | voice | other
  status           text not null default 'received'
                     check (status in ('received','processed','failed',
                                       'rejected','unlinked','not_entitled')),
  received_at      timestamptz not null default now(),
  completed_at     timestamptz
);

create index telegram_inbound_received_idx on public.telegram_inbound (received_at desc);

-- RLS on with no policies at all: the table is unreachable for anon and
-- authenticated, and the service role bypasses RLS by design.
alter table public.telegram_inbound enable row level security;
```

The primary key *is* the idempotency mechanism (Requirements 11.5, 11.8): the adapter inserts before doing anything billable, and a unique violation is the duplicate signal. No `select`-then-`insert`, so two concurrent deliveries of the same update cannot both proceed. Requirement 11.8 states that ordering as an obligation rather than leaving it to the design, which is a tightening and not a change.

Two amendment notes. The key is `bigint` rather than `text`, because `update_id` is a number Telegram assigns per bot and per webhook registration — a narrower and cheaper key than the 128-character WAMID it replaces, with no format to validate. And the `status` set gains `unlinked` and `not_entitled`, which is how a gated update stays auditable without a `usage_logs` row: Requirements 21.17 and 22.13 both produce a reply and no billable operation, so there is nothing for the usage audit to record, and this column is the only trace that the delivery was handled deliberately rather than dropped.

The table holds no farmer-authored content. `telegram_user_id` is still an identifier for a person, so RLS is enabled with **no** policies rather than left off — a table in `public` with RLS disabled would be readable through the data API. Only the service role touches it.

### 0009: storage buckets and policies

```sql
insert into storage.buckets (id, name, public)
values ('crop-images','crop-images',false),
       ('voice-messages','voice-messages',false)
on conflict (id) do nothing;                       -- Req 13.5 (private)

-- Req 13.6: a farmer may read/write only under their own {user_id}/ prefix.
-- VERIFY AT IMPLEMENTATION (V4): the folder-extraction helper name and signature
create policy crop_images_rw_own on storage.objects
  for all to authenticated
  using (bucket_id = 'crop-images'
         and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'crop-images'
         and (storage.foldername(name))[1] = auth.uid()::text);

create policy voice_messages_rw_own on storage.objects
  for all to authenticated
  using (bucket_id = 'voice-messages'
         and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'voice-messages'
         and (storage.foldername(name))[1] = auth.uid()::text);
```

Object path convention, shared by both channels:

```
crop-images/{user_id}/{YYYY}/{MM}/{uuid}.{jpg|png|webp}            <- Full_Size_Image
crop-images/{user_id}/{YYYY}/{MM}/{uuid}.thumb.{jpg|png|webp}      <- Thumbnail_Derivative
voice-messages/{user_id}/{YYYY}/{MM}/{uuid}.{ext}
```

The `{user_id}` first segment does double duty: it is the storage RLS predicate, and it is what the API-side ownership check compares against the session user (Requirements 2.5, 2.6). Telegram media is uploaded with the service role but *still* under the resolved profile's `{user_id}/` prefix, so a farmer can later read their Telegram images from the web history through a normal signed URL. The prefix is the resolved `profiles.id`, never the `telegram_user_id` — the storage policy compares against `auth.uid()`, so a path keyed on a chat account would be unreadable by its owner's own session.

**Thumbnail path derivation (Requirement 2.13).** A thumbnail path is a pure function of its original's path: insert the literal `.thumb` immediately before the final extension. `thumbPathFor()` and `originalPathFor()` live in `src/lib/storage.ts` and are exact inverses, so no column stores a thumbnail path and nothing has to be kept in sync.

```
a/2026/09/b.jpg   ->  a/2026/09/b.thumb.jpg
a/2026/09/b.thumb.jpg  ->  a/2026/09/b.jpg
```

Three properties of this convention were the reason for choosing it over a sibling folder such as `{user_id}/{YYYY}/{MM}/thumbs/{uuid}.{ext}`:

- **The RLS predicate needs no change.** `(storage.foldername(name))[1]` is still `{user_id}`, so both objects are covered by the existing `crop_images_rw_own` policy with no new grant. Adding a path segment would also have worked here, but only because the *first* segment is what the policy reads; a convention that changed the first segment would have needed a policy edit, and this one is immune to that class of mistake.
- **Both derivatives share an extension**, because the browser produces both in one re-encode pass with one output MIME type (see *Browser-direct upload*). So the extension is not a second thing to derive.
- **The `.thumb.` infix is a single unambiguous predicate** for the retention sweep, which must delete originals and keep thumbnails while scanning one bucket.

`storageRefSchema` is deliberately *not* widened to accept a `.thumb.` path. Its regex allows exactly one dot before the extension, so a client cannot submit a thumbnail as the object to diagnose, and it cannot submit a fabricated derived path at all. The thumbnail path is only ever computed server-side from an original path that already passed validation and ownership.

No `video-inputs` bucket is created (Requirement 19 is deferred).

**Policy scope narrowed to the operations Jamee actually uses.** The two policies above are written `for all`, which grants a farmer session `delete` and `update` on their own objects. No Jamee code path uses either: paths carry a fresh `uuid` so nothing is ever upserted (V4 notes `upsert` would additionally need `SELECT` + `UPDATE`), and every deletion runs with the service role (see *Media lifecycle and retention*). Narrowing both policies to `select, insert` therefore costs nothing and removes a farmer's ability to orphan a `diagnoses` row's image out from under the history view. That narrowing is part of migration `0009` (task 4.8).

### 0010: seed the five verified conditions

One migration, five rows, `source` populated per row (Requirement 4.2). Content is drawn from public extension-service literature; the exact citation string per row is filled in during implementation and recorded verbatim in the `source` column — the design does not invent a citation.

```sql
insert into public.disease_knowledge
  (disease_name, crop, scientific_name, symptoms, causes, treatment, prevention,
   default_severity, source)
values
  ('Tomato Early Blight','tomato','Alternaria solani',
   array['Dark brown spots with concentric rings on older, lower leaves',
         'Yellow halo around each spot',
         'Affected leaves dry and drop, starting from the bottom of the plant'],
   array['Fungal infection by Alternaria solani',
         'Warm, humid weather with leaf wetness',
         'Spores surviving on crop debris and volunteer plants'],
   array['Remove and destroy affected lower leaves',
         'Apply a protectant fungicide labelled for early blight, following the label rate',
         'Avoid overhead irrigation late in the day'],
   array['Rotate away from tomato and potato for two seasons',
         'Stake plants for airflow and mulch to limit soil splash',
         'Use certified disease-free seed and clear crop debris after harvest'],
   'moderate','<extension-service citation - fill at implementation>'),

  ('Tomato Late Blight','tomato','Phytophthora infestans',
   array['Large greasy grey-green to brown patches on leaves',
         'White fuzzy growth on leaf undersides in humid conditions',
         'Firm brown lesions on stems and fruit; rapid collapse of foliage'],
   array['Oomycete infection by Phytophthora infestans',
         'Cool, wet, humid weather',
         'Spores carried by wind and rain from nearby infected plants or tubers'],
   array['Remove and destroy infected plants immediately, do not compost them',
         'Apply a fungicide labelled for late blight without delay, following the label rate',
         'Harvest healthy fruit early if spread is rapid'],
   array['Plant resistant varieties where available',
         'Avoid overhead irrigation and crowded spacing',
         'Destroy volunteer tomato and potato plants and cull piles'],
   'high','<extension-service citation - fill at implementation>'),

  ('Tomato Healthy','tomato',null,
   array['Uniform green leaves with no spots, lesions, or wilting',
         'Normal leaf shape and size for the growth stage'],
   array['No disease detected in the submitted photo'],
   array[]::text[],                                    -- Req 3.4: no treatment content
   array['Continue regular monitoring of lower leaves',
         'Keep foliage dry by watering at the base',
         'Maintain crop rotation and field sanitation'],
   'none','<extension-service citation - fill at implementation>'),

  ('Potato Early Blight','potato','Alternaria solani',
   array['Dark concentric-ringed lesions on older leaves',
         'Lesions bounded by leaf veins, giving an angular outline',
         'Progressive yellowing and death of lower foliage'],
   array['Fungal infection by Alternaria solani',
         'Warm temperatures with alternating wet and dry periods',
         'Inoculum surviving in soil and crop residue'],
   array['Remove severely affected foliage',
         'Apply a protectant fungicide labelled for early blight on potato, per label rate',
         'Maintain balanced nitrogen to avoid early senescence'],
   array['Rotate with non-solanaceous crops',
         'Plant certified seed tubers',
         'Bury or remove crop residue after harvest'],
   'moderate','<extension-service citation - fill at implementation>'),

  ('Potato Late Blight','potato','Phytophthora infestans',
   array['Water-soaked pale green patches that turn brown-black',
         'White sporulation at lesion margins on leaf undersides in humid weather',
         'Dark firm rot on tubers'],
   array['Oomycete infection by Phytophthora infestans',
         'Cool, wet, humid conditions',
         'Infected seed tubers and wind-blown spores'],
   array['Destroy infected plants and affected tubers',
         'Apply a fungicide labelled for potato late blight promptly, per label rate',
         'Kill the haulm before harvest in a severe outbreak to protect tubers'],
   array['Plant certified, disease-free seed tubers',
         'Hill soil well to cover tubers and improve drainage',
         'Remove cull piles and volunteer plants'],
   'high','<extension-service citation - fill at implementation>');
```

The seed is idempotent in practice because `disease_name` is unique; re-running adds an `on conflict (disease_name) do nothing` guard.

### 0011: link tokens (Requirement 21)

```sql
create table public.link_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  token_hash  text not null unique,          -- sha-256 of the token, never the token
  expires_at  timestamptz not null,          -- now() + LINK_TOKEN_TTL_MINUTES (Req 21.4)
  consumed_at timestamptz,                   -- null until consumed (Req 21.3)
  created_at  timestamptz not null default now()
);

create index link_tokens_user_idx on public.link_tokens (user_id, created_at desc);

alter table public.link_tokens enable row level security;

-- Req 21.3 / 13.1: a farmer reads only their own rows.
create policy link_tokens_select_own on public.link_tokens
  for select using (auth.uid() = user_id);
-- No insert/update/delete policy: minting and consuming run server-side with the
-- service role, so a farmer session cannot mint a token for another farmer, cannot
-- extend an expiry, and cannot un-consume one.
```

**The token is stored hashed, and the plaintext exists only in the deep link.** Requirement 21 does not demand this; it follows from what a Link_Token is. It is a bearer capability that binds a chat account to a Jamee account, so a snapshot of this table — a support query, a log, a backup — would otherwise be a list of live capabilities. Hashing costs one `sha256` on a path that runs twice per link and nothing on any hot path. The `unique` constraint sits on `token_hash` rather than on a plaintext column for the same reason, and lookup is by hash, so the plaintext is never compared in SQL.

`consumed_at` is a timestamp rather than a boolean because the single atomic statement of **D13** needs to distinguish "never consumed" from "consumed", and a timestamp additionally tells a support query *when* — for free, in the same column:

```sql
-- D13: one statement. Consume and bind together, or do neither.
update public.link_tokens
   set consumed_at = now()
 where token_hash = $1
   and consumed_at is null
   and expires_at > now()
returning user_id;
-- No returned row => unknown, expired, or already consumed. One reply for all
-- three (Req 21.8), and no binding is attempted.
```

The binding write that follows is bounded by the same transaction, so Requirement 21.7's "same atomic operation" holds: either the token is spent and the `telegram_user_id` is set, or neither happened. A unique violation on `profiles.telegram_user_id` inside that transaction rolls the consume back, which is exactly Requirement 21.13's "leave that Link_Token unconsumed".

### 0012: payment orders and bot entitlements (Requirement 22)

```sql
create table public.payment_orders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  provider_order_id text not null unique,             -- Razorpay order id (V27)
  amount_minor      integer not null check (amount_minor > 0),  -- server-side (Req 22.2)
  currency          text not null,
  status            text not null default 'created'
                      check (status in ('created','captured','failed','cancelled')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index payment_orders_user_idx on public.payment_orders (user_id, created_at desc);

create trigger payment_orders_set_updated_at
  before update on public.payment_orders
  for each row execute function public.set_updated_at();

create table public.bot_entitlements (
  user_id             uuid primary key references public.profiles(id) on delete cascade,
                                        -- PRIMARY KEY => at most one per farmer (Req 22.12)
  provider_payment_id text not null unique,   -- the idempotency claim (Req 22.11)
  payment_order_id    uuid references public.payment_orders(id) on delete set null,
  granted_at          timestamptz not null default now()      -- no expiry column (Req 22.9)
);

alter table public.payment_orders enable row level security;
alter table public.bot_entitlements enable row level security;

-- Req 22.23 / 13.1: read own rows only; every write is service-role.
create policy payment_orders_select_own on public.payment_orders
  for select using (auth.uid() = user_id);
create policy bot_entitlements_select_own on public.bot_entitlements
  for select using (auth.uid() = user_id);
-- No insert/update/delete policies on either table. A farmer session cannot
-- grant itself an entitlement, cannot mark an order captured, and cannot
-- change an amount.
```

Three column choices carry requirements rather than taste:

- **`user_id` is the primary key of `bot_entitlements`**, which is how Requirement 22.12's "at most one per Auth_User_Id" is enforced without a second constraint, and it is why **D14**'s "keyed to the farmer, not the chat account" is structural: there is no `telegram_user_id` column here to be tempted by, so unlinking cannot touch this table (Requirement 22.20).
- **`provider_payment_id` carries its own `unique`**, and that constraint is the idempotency mechanism of Requirement 22.11 — a replayed webhook loses the insert race and the zero-row result is the duplicate signal (**D15**). It is separate from the primary key because two different payment ids must not both grant, and one payment id must not grant twice; the two constraints answer two different questions.
- **There is no `expires_at`, and that absence is deliberate** (Requirement 22.9). A nullable expiry column would invite a future "just set it for trials" edit that silently converts a one-time purchase into a subscription. Adding expiry later should require a migration and a conversation, which is what its absence guarantees.

`payment_orders` retains failed and abandoned rows rather than deleting them (Requirement 22.22). They grant nothing — only `bot_entitlements` grants — and keeping them is what makes a reconciliation query against the provider possible. A farmer with three abandoned orders can still start a fourth, because nothing in the create path reads the previous ones.

### 0013: webhook throttle (Requirement 13.9, D16)

```sql
create table public.webhook_throttle (
  route       text not null check (route in ('payment','telegram')),
  caller_hash text not null,               -- sha-256 of the platform-reported address
  window_key  text not null,               -- 'YYYY-MM-DDTHH:MM'
  used        integer not null default 0 check (used >= 0),
  updated_at  timestamptz not null default now(),
  primary key (route, caller_hash, window_key)
);

-- Same single-statement pattern as counter_try_increment, and for the same reason.
create or replace function public.webhook_throttle_try_increment(
  p_route text, p_caller_hash text, p_window_key text, p_limit int
) returns integer
language sql security definer set search_path = '' as $$
  insert into public.webhook_throttle (route, caller_hash, window_key, used)
  values (p_route, p_caller_hash, p_window_key, 1)
  on conflict (route, caller_hash, window_key) do update
    set used = public.webhook_throttle.used + 1,
        updated_at = now()
    where public.webhook_throttle.used < p_limit
  returning used;
$$;

-- RLS on, no policies: no farmer session has any business here.
alter table public.webhook_throttle enable row level security;
```

This table exists because `counters.user_id` is `not null` with a foreign key to `profiles`, and neither webhook route has a farmer to key on — the payment route has none until a signature verifies, and the Telegram route has none until an update resolves (**D16**). It is not a second quota system: no farmer-facing limit is expressed here, nothing is ever refunded, and rows are pruned by the same periodic delete that prunes minute-window counter rows.

---

## Quota enforcement

### Choice: a dedicated counter table, not counted `usage_logs` rows

Both options were considered against the race requirement.

| | Count `usage_logs` in an atomic function | Dedicated `counters` table |
| --- | --- | --- |
| Atomicity | Needs `pg_advisory_xact_lock` or `serializable` around read-then-insert; a plain `count(*)` under `read committed` lets two concurrent requests both pass at the boundary | One statement: `insert … on conflict do update … where used < limit`. The conflicting row is locked by Postgres, so the second writer sees the first writer's value |
| Cost of a check | `count(*)` over a growing audit table per request | Primary-key lookup on one row |
| Semantic fit | Audit rows are not 1:1 with quota units — a fallback (14.7) and a validation rejection (5.7) each add rows without adding a billable unit | The counter counts exactly one thing: reserved units |
| Refund | Requires deleting or flagging audit rows, corrupting the audit trail | `used = used - 1` on a counter row; audit stays append-only |
| Log retention | Pruning old logs to stay inside the free tier would silently change quota answers | Retention and quota are independent |

**Decision: the dedicated `counters` table** (migration 0007). It is race-free in a single statement without advisory locks, constant-time, and it keeps `usage_logs` a pure append-only audit trail (D10). The trade-off accepted is one extra table and the need to refund explicitly rather than "just not logging".

Double-spend is prevented by three things together: the single-statement atomic increment; one reserve per request, taken exactly once at a defined point; and, on Telegram, the `update_id` claim that happens *before* the reserve so a redelivery cannot reach the counter at all (Requirement 11.7).

### When a unit is reserved, finalized, or refunded

The rule, stated as one sentence: **a unit is spent if and only if at least one provider call was attempted for that request.**

Order of operations in every service — the sequence is the contract:

1. Authenticated session resolved, else 401 — **no reserve** (Requirement 1.7).
2. Request body Zod-parsed; unsupported language → 400 — **no reserve** (Requirement 9.5).
3. Telegram only, in the order Requirement 22.16 fixes: secret token compared, then the `telegram_inbound` insert of the `update_id` (unique violation → acknowledge 200, log `duplicate_ignored`, **no reserve**, Requirements 11.5, 11.7), then profile resolution, then the Bot_Entitlement check. No entitlement → the unlock reply of 22.14 and **no reserve** (Requirement 22.13). No profile → linking instructions and **no reserve** (Requirement 21.17).
4. Storage reference checked: correct bucket and `{user_id}/` prefix owned by the caller. Mismatch → 403 — **no reserve** (Requirement 2.6, explicitly "quota unchanged").
5. Burst rate limit checked (Requirement 13.8, `window_kind='minute'`) → 429 — **no reserve**.
6. **Reserve**: `counter_try_increment(user, op, 'day', kolkataDay, limit)`. Null result → decline with the limit and the reset time, and **no provider call is made** (Requirement 14.3).
7. Provider work: signed URL, classification, validation, KB grounding, rephrase.
8. **Finalize**: persist the domain rows and append a `usage_logs` row with the provider, outcome, and `used_fallback`. The counter is not touched again.
9. **Refund** (`counter_decrement`) only when step 7 failed *before the first provider call was attempted* — signed-URL issuance failure, unreadable object, knowledge-base read failure, or an unhandled error thrown ahead of the gateway call. The `usage_logs` row records `quota_spent = false`.

The reserve is taken once per *request*, by whichever service owns that request's operation type. A `ChatService` invocation nested inside a `VoiceService` request therefore performs **no** reserve of its own: the voice unit taken at step 6 covers the answer that request produces, so one voice message never spends both a voice unit and a chat unit. `ChatService` reserves only when it is itself the entry point — the chat endpoint, or an inbound Telegram text message.

What this yields against the requirements:

- Accepted inconclusive diagnosis → exactly one unit (Requirement 6.7). The classification call happened; validation rejected the content. Spent.
- Ownership 403 → zero (Requirement 2.6).
- Duplicate webhook delivery → zero (Requirement 11.5).
- Quota already exhausted → zero, and no provider is called (Requirement 14.3).
- Update from an unlinked sender, or from a linked farmer holding no entitlement → zero, and no service is invoked (Requirements 21.17, 22.13). A `/start` command is zero on the same rule (Requirement 21.18).
- Provider fallback used → still one unit, plus a `used_fallback` audit row (Requirements 14.4, 14.7).
- Both providers failed, or the operation timed out → spent, no refund. This is deliberate: those requests consumed real provider capacity, and refunding them would let a failing provider drain the free tier through retries. The farmer is told honestly that Jamee is busy and can retry, and the retry costs a unit.

Web double-submit is not idempotent by request (the requirements define no client idempotency key). The uploader disables its submit control while a request is in flight, and a genuine retry after an error spends a new unit — documented in `docs/API.md` so it is not a surprise.

Cross-channel sharing (Requirement 14.2) is automatic: the counter key is `(user_id, operation, 'day', window_key)` with no channel component.

`window_key` comes from `src/lib/time.ts`, which formats "now" in Asia/Kolkata as `YYYY-MM-DD` and computes the next Asia/Kolkata midnight as the reset instant returned in the decline message (Requirement 14.3). The window is derived per request, so nothing needs resetting at midnight — a new key simply starts at zero.

### Rate limiting versus daily quota

Requirement 13.8's per-farmer rate limiting is a different control from Requirement 14.1's daily quota and is kept separate: same table, `window_kind = 'minute'`, its own per-operation ceiling (a small burst allowance chosen so a farmer cannot loop faster than a human works, and set independently of the daily quota), checked at step 5 and never refunded because it precedes the reserve. Minute rows are pruned by a periodic delete; at the 6-tester scale a prune is a convenience, not a requirement.

Requirement 13.8 also covers the Payment_Order endpoint, which has a session and therefore keys on the farmer like every other limited route. Requirement 13.9's payment-webhook limit is the one that cannot, because it has no farmer at all — see **D16** and migration `0013`.

---

## Media lifecycle and retention

Quotas bound how many *requests* a farmer makes. Nothing above bounds how many *bytes* accumulate, and bytes are the dimension that runs out first: V19 puts Supabase Free at **1 GB storage** and **5 GB monthly egress**, and at full worst-case load the unamended design wrote 240 objects a day and deleted none. Requirement 18 closes that, and Requirements 2.10–2.14, 8.9–8.11 and 12.6–12.11 are the surfaces that make it survivable for a farmer.

Three mechanisms, in the order the bytes meet them:

1. **Re-encode before upload** (Requirement 2.10). The browser downscales an admitted image toward ~400 KB, so both storage growth and per-read egress fall by roughly an order of magnitude against the 10 MB admission ceiling.
2. **Read a derivative for list views** (Requirements 2.13, 12.6). A history screen of 20 entries reads 20 thumbnails, not 20 full-size originals.
3. **Delete what nothing reads** (Requirements 8.9, 18.3, 18.4). Voice originals go as soon as their transcript is durable; full-size crop images go when the retention window elapses; thumbnails and every database row stay.

Note what mechanism 1 does *not* change: Requirements 2.3 and 2.4 still gate on the file the farmer **selects**. A 9 MB photo is still admitted, still gets the "accepted types and size limit" message only when it breaches 10 MB or the MIME list, and only then is re-encoded. The 10 MB allowance stays real; it is simply no longer the size of the object that lands in the bucket.

### What is deleted, when, and by whom

| Object | Written by | Deleted when | Deleted by | Requirement |
| --- | --- | --- | --- | --- |
| `voice-messages/{user_id}/…` original | Browser (web) or service role (Telegram) | Immediately after its transcript is persisted as a `messages` row | `VoiceService`, service-role client | 8.9 |
| `voice-messages/…` original, transcription failed or transcript empty | same | Retention sweep, once older than the window | `RetentionService`, service-role client | 8.10, 18.4 |
| `crop-images/…/{uuid}.{ext}` — Full_Size_Image | Browser (web) or service role (Telegram) | Retention sweep, once its `diagnoses` row is older than the window | `RetentionService`, service-role client | 18.3 |
| `crop-images/…/{uuid}.thumb.{ext}` — Thumbnail_Derivative | Browser only | Never | — | 18.5 |
| `diagnoses`, `messages`, `conversations`, `usage_logs` rows | Services | Never by this design | — | 18.6 |

**The browser never deletes.** Every deletion runs server-side with the service role, for one reason that applies to both paths: the Telegram path has no farmer session at all, so a session-scoped delete could not be the single implementation. Making the service role the only deleter keeps one code path and one audit story. It is also why the storage policies get narrowed to `select, insert` (see migration `0009` above) — a farmer session has no legitimate reason to hold `delete` on an object the history view depends on.

**Why voice originals go on success rather than on a timer.** Requirement 8.8 rules out synthesized speech and nothing in the requirements reads a recording back; the transcript is the durable artefact, persisted as a `messages` row with `input_kind = 'voice'`. So once that row is committed, the object has no reader. Deleting it there removes roughly half the accumulation rate at its source rather than deferring it to a sweep.

**Why a failed transcription keeps its bytes.** `TRANSCRIPTION_FAILED` is **502, retryable** in the error taxonomy — retryable *over the same object*. Deleting the object on failure would make the retryable flag a lie and force the farmer to re-record for what was a provider outage, contradicting Requirement 15.4's retry action. `TRANSCRIPT_EMPTY` (422) does ask the farmer to record again, so its object has no reader either, but it is retained on the same rule anyway, for two reasons: it makes the deletion rule a single testable biconditional — *a voice object is absent if and only if a transcript message exists for it* — rather than three cases with three triggers; and V10 records `no_speech_prob` and `avg_logprob` as available confidence signals, meaning an empty transcript can be a provider artefact rather than a silent recording, so keeping the bytes for a few days leaves something diagnosable behind. The grace period is not a separate constant: it is the same retention window, so there is exactly one number to configure and one sweep to run.

### How the sweep finds its work

Two scans per invocation, in this order, both bounded:

1. **Row-driven, for known originals.** `select id, user_id, image_bucket, image_path from diagnoses where full_image_deleted_at is null and created_at < now() - (retention_days || ' days')::interval order by created_at limit N`. Each row's `image_path` is deleted and `full_image_deleted_at` is stamped (Requirement 18.7). This is the scan that keeps the history view honest, and it is served by the partial index added to `0005`.
2. **Age-driven, as an orphan backstop.** A browser upload that succeeded before a diagnosis request failed leaves an object with no `diagnoses` row, and a failed transcription leaves a voice object with no `messages` row, so neither is reachable from scan 1. Scan 2 reads object names and ages from the `storage` schema for both buckets, excludes any `crop-images` path containing the `.thumb.` infix, and deletes the remainder past the window. Whether `storage.objects` exposes a usable creation timestamp is **V22** — until it resolves, scan 2 is the part of the sweep that does not run, and scan 1 alone still satisfies Requirements 18.3 and 18.7 for every object a farmer can see.

Deletion is idempotent by construction (Requirement 18.10): scan 1's `where full_image_deleted_at is null` predicate excludes anything a previous run already stamped, and an object that is already absent is treated as deleted rather than as an error — **V22** also covers whether the delete call errors on a missing path, and the service normalizes that outcome either way. Both scans take a `limit N` so one invocation stays inside the 60 s ceiling (Requirement 18.11); leftover work is simply picked up by the next run, which is safe precisely because the operation is idempotent.

### RLS, storage policies, and why the application check is the boundary

The service role bypasses RLS and bypasses the storage path policies, so neither of them constrains the sweep. That is the same situation as the Telegram adapter, the access services, and the quota functions, and it gets the same answer from *Security boundary → Defence in depth*: **every service-role operation carries an explicit `user_id` anchor, and one without it is a defect.**

Concretely, for deletion that means the sweep never deletes a path it invented or a path it found by listing a bucket root:

- Scan 1 deletes only `image_path` values read off a `diagnoses` row, and asserts the path's first segment equals that row's `user_id` before issuing the delete. A mismatch is a hard error, not a skipped row — it means either the path convention or the row is corrupt, and continuing would risk deleting across tenants (Requirement 18.8).
- Scan 2's candidates come from the storage schema rather than from a row, so its `user_id` anchor is the path's own first segment; it deletes only under `{first_segment}/` and never widens.
- `VoiceService`'s on-success delete reuses the existing `assertOwnership` seam against the requesting farmer before deleting (Requirement 8.11).

Tenant isolation during deletion is therefore the *same* predicate that Property 5 already holds for reads, applied to a second verb. Property 31 states it over deletion.

### Triggering a sweep with no always-on process

This is a serverless deployment. There is no daemon, no cron container, and nothing that survives a response. The sweep is therefore an ordinary route handler with a shared-secret gate:

```
POST /api/internal/retention-sweep
  header:  X-Retention-Sweep-Secret: <RETENTION_SWEEP_SECRET>
  export const maxDuration = 60
```

**This endpoint is network-exposed and it deletes data, so its authentication check is the entire security boundary.** Three properties it must have, and all three are Requirement 18.12 and 18.13 read strictly: the secret is compared in constant time; a missing, wrong, or absent header is 401 with no deletion attempted and no detail in the body; and a valid *farmer* session is explicitly **not** authorization for this route — the session check that guards `/api/diagnose` is not reused here, because a farmer must not be able to trigger a sweep at all. The route lives under `/api/internal/` so the boundary is visible in the path, and `scripts/check-secret-scope.ts` (task 27.1) already asserts that secrets appear only in server modules.

**What triggers the POST is not yet a verified capability — V21.** Whether the deployment platform offers a scheduled invocation on the target plan, at what minimum interval, and how it authenticates, is not recorded in `docs/VERIFIED_VALUES.md`, and this design does not assume it. Two consequences, deliberately arranged so V21 blocks nothing important:

- **If V21 resolves to a scheduled primitive:** point it at the route once a day, with the secret supplied the way V21 documents. Nothing in the sweep changes.
- **If V21 does not resolve, or the primitive is unavailable on the plan:** the sweep is invoked manually. `docs/DEPLOYMENT.md` carries it as a named operational step with the exact command, and because the operation is idempotent and bounded, running it twice, late, or several times in a row is harmless. A pilot of six farmers with a seven-day window tolerates a manual weekly run; what it does not tolerate is *no* mechanism, which is what the unamended plan had.

The honest reading: automation is a convenience here, and the correctness of Requirement 18 rests on the sweep's logic rather than on its schedule. What a missed schedule costs is bucket headroom, which is why the arithmetic below reserves 25%.

### The arithmetic that bounds the window

One configurable constant, `MEDIA_RETENTION_DAYS` in `src/lib/config/media.ts`, **default 7**. The constraint it has to satisfy:

```
(full_size_bytes_per_day + straggler_bytes_per_day) × MEDIA_RETENTION_DAYS
  + thumbnail_bytes_per_day × pilot_days
  ≤ 1 GB × 0.75
```

Worst-case load is Jamee's own quota: 6 farmers × 20 images and 20 voice notes a day = 120 of each. Substituting, with the three per-object figures labelled for what they are:

| Term | Figure | Basis |
| --- | --- | --- |
| `full_size_bytes_per_day` | 120 × ~400 KB ≈ **48 MB/day** | The Downscale_Target — a design target, not a measurement |
| `thumbnail_bytes_per_day` | 120 × ~25 KB ≈ **3 MB/day** | Planning estimate for a ~320 px longest-edge re-encode; **retained forever** |
| `straggler_bytes_per_day` | ≈ **5 MB/day** | Planning estimate: voice objects whose transcription did not succeed |
| Usable budget | 0.75 × 1 GB ≈ **768 MB** | V19's 1 GB, less 25% headroom for a missed sweep run |

```
day 0   of the pilot:  768        / 53 ≈ 14 days available
day 90  of the pilot: (768 − 270) / 53 ≈  9 days available
day 132 of the pilot: (768 − 396) / 53 ≈  7 days available   <- the default's limit
```

Read that top to bottom: **the safe window shrinks as thumbnails accumulate.** Thumbnails are never swept, so they are a slow permanent accumulation — 3 MB/day is ~1 GB in under a year at full quota. The default of 7 days holds for roughly the first **four months at maximum farmer activity**, and far longer at realistic activity (at 20% of quota the whole media footprint is under 300 MB after a year). This is the reason `MEDIA_RETENTION_DAYS` is configurable and the reason Requirement 18.2 puts the arithmetic in the deployment document: it is a number to review, not a number to set once. The amendment converts a six-day deadline into a multi-month runway; it does not make storage unbounded.

For contrast, the unamended figures: at the ~700 KB average that the egress allowance permits, 240 objects a day is 168 MB/day and fills 1 GB in about **6 days**, with nothing deleting anything.

### Egress after the amendment

5 GB/month is about 170 MB/day. Media leaves Supabase once per provider read, because both providers accept a URL (V6, V10), and again on every history or detail render — and signed-URL expiry is measured in seconds (V3), so browser cache reuse across renders is limited and repeat views really do re-fetch.

| Read path | Per day at worst-case load | Before the amendment |
| --- | --- | --- |
| Provider image reads | 120 × ~400 KB ≈ 48 MB | 120 × up to 10 MB |
| Provider audio reads | 120 × ~400 KB ≈ 48 MB | unchanged — voice is not re-encoded |
| History list renders | 20 thumbnails × ~25 KB ≈ **0.5 MB per render** | 20 originals ≈ **14 MB per render** |
| Detail views | one full-size original per open, while it exists | same |

The list-render line is the one that changes character rather than magnitude: at 14 MB a render, a farmer scrolling their history a few times a day was a genuine threat to a 170 MB/day budget; at 0.5 MB it is noise. Past the retention window it drops to zero, because the detail view has no original left to fetch.

### Residual exposures, stated rather than fixed

Three things the amendment does not solve. None is a defect against Requirement 18; all three would be expensive to rediscover.

- **A pathological voice day is not bounded by any window.** Requirement 8.2 admits recordings up to 10 MB, and 120 of those is 1.2 GB — past the whole allowance inside a single day, before any sweep could run, and none of it deleted on success if the transcriptions also fail. Reaching it needs all six pilot farmers to spend their full voice quota on maximum-size recordings, so it is abuse rather than use. The mechanisms that would actually bound it — a lower voice admission ceiling, or client-side audio re-encoding — are outside the approved scope of this amendment and are recorded here as the follow-up decision, not adopted.
- **Telegram-originated diagnoses have no thumbnail.** Requirement 2.13 puts thumbnail production in the browser, and the Telegram path has no browser: the adapter downloads bytes into a function and uploads them with the service role. Producing a thumbnail there would mean server-side image decoding in the one code path where bytes already move through a function, which V19's Active-CPU note flags as the path worth measuring. So those entries take Requirement 12.7's fallback and render the full-size original in the list until the window elapses, then Requirement 12.10's no-image state. That is why 12.7 exists as a first-class criterion rather than as retention-only degradation — it carries the Telegram channel too. One thing the channel change improves here: Telegram's `photo[]` array offers several server-side size variants (V26), so the adapter can *choose* a smaller variant for the stored original instead of decoding anything, which narrows the gap without adding CPU. Whether that is worth doing is an implementation call, not a design commitment.
- **Thumbnails accumulate without bound.** Covered in the arithmetic above. The alternative — sweeping thumbnails on a longer second window — would need a second configurable constant and would make history entries lose their image entirely, so it is not adopted here.

All schemas live in `src/lib/schemas.ts`; all types are inferred from them, never hand-declared twice. The verified-condition list is declared once and reused by the Zod enum, the TypeScript union, and the SQL check constraints above.

### Shared enums

```ts
// src/lib/schemas.ts
export const VERIFIED_CONDITIONS = [
  'Tomato Early Blight',
  'Tomato Late Blight',
  'Tomato Healthy',
  'Potato Early Blight',
  'Potato Late Blight',
] as const;                                        // Requirement 4.1 — exactly five

export const verifiedConditionSchema = z.enum(VERIFIED_CONDITIONS);
export const severitySchema = z.enum(['none', 'low', 'moderate', 'high']);
export const languageSchema  = z.enum(['en', 'hi', 'mr']);
export const channelSchema   = z.enum(['web', 'telegram']);

export type VerifiedCondition = z.infer<typeof verifiedConditionSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type Language = z.infer<typeof languageSchema>;
export type Channel  = z.infer<typeof channelSchema>;
```

### Vision model output — two stages (D2)

```ts
// Stage 1: shape only. disease_name stays a free string so that an out-of-KB
// name is a *distinguishable* rejection rather than an unparseable blob.
export const visionRawSchema = z.object({
  status: z.enum(['identified', 'unclear', 'no_plant']),
  disease_name: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1),            // Requirement 5.4
  severity: severitySchema,                        // Requirement 5.5
});
export type VisionRaw = z.infer<typeof visionRawSchema>;

// Stage 2: knowledge-base membership. This is the safety gate.
export const visionVerifiedSchema = visionRawSchema.extend({
  status: z.literal('identified'),
  disease_name: verifiedConditionSchema,           // Requirement 5.6
});

export type RejectionReason =
  | 'not_json'                 // 5.2
  | 'missing_field'            // 5.3
  | 'confidence_out_of_range'  // 5.4
  | 'invalid_severity'         // 5.5
  | 'unverified_condition'     // 5.6 -> 6.1
  | 'model_unclear'            // 6.2
  | 'model_no_plant';          // 6.3
```

How an out-of-KB name becomes the inconclusive shape, concretely. Suppose the model answers `{"status":"identified","disease_name":"Wheat Rust","confidence":0.88,"severity":"high"}`. Stage 1 passes — the shape is right. Stage 2 runs `visionVerifiedSchema.safeParse(raw)` and `disease_name` fails `z.enum(VERIFIED_CONDITIONS)`. The service maps that single failure path to `rejection_reason = 'unverified_condition'`, writes it to `usage_logs` (Requirement 5.7), discards the model's name and its confidence entirely (Requirement 6.5), and returns the one inconclusive object below (Requirements 6.1, 6.4). No second model call is made (Requirement 6.6). `status:'unclear'` and `status:'no_plant'` reach the same object by a different reason code (Requirements 6.2, 6.3), differing only in which static localized sentence is attached.

### Diagnosis result — a discriminated union with one inconclusive shape

```ts
export const identifiedResultSchema = z.object({
  status: z.literal('identified'),
  diseaseName: verifiedConditionSchema,            // canonical, never translated (Req 4.6, 9.4)
  confidence: z.number().min(0).max(1),
  severity: severitySchema,
  explanation: z.string().min(1),                  // KB-grounded, localized (Req 3.2)
  knowledge: z.object({
    symptoms: z.array(z.string()),
    causes: z.array(z.string()),
    treatment: z.array(z.string()),                // empty for Tomato Healthy (Req 3.4)
    prevention: z.array(z.string()),
    source: z.string(),
  }),
  needsExpert: z.literal(false),
  language: languageSchema,
});

export const inconclusiveResultSchema = z.object({
  status: z.literal('unknown'),                    // Requirement 6.4
  diseaseName: z.null(),                           // Requirement 6.5
  confidence: z.null(),
  severity: z.literal('none'),
  explanation: z.string().min(1),                  // static localized copy (D5)
  knowledge: z.null(),                             // no treatment content (Req 6.5)
  needsExpert: z.literal(true),
  language: languageSchema,
});

export const diagnosisResultSchema =
  z.discriminatedUnion('status', [identifiedResultSchema, inconclusiveResultSchema]);
export type DiagnosisResult = z.infer<typeof diagnosisResultSchema>;
```

Because `knowledge` is `null` in the inconclusive branch, TypeScript makes it impossible to render treatment text for an inconclusive result — the compiler enforces Requirement 6.5 at the UI layer, and the `diagnoses_unknown_shape` check constraint enforces it at the database layer.

### Storage references

```ts
export const storageRefSchema = z.object({
  bucket: z.enum(['crop-images', 'voice-messages']),
  path: z.string().min(1).max(512)
    .regex(/^[0-9a-f-]{36}\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/,
           'path must be {user_id}/{YYYY}/{MM}/{uuid}.{ext}'),
});
```

The regex enforces the shape; it does not prove ownership. Ownership is a runtime comparison of `path.split('/')[0]` against the session user id, plus an object-exists probe, executed before any quota reserve (Requirements 2.5, 2.6).

### API request and response contracts

```ts
// POST /api/diagnose   (D1: JSON, not multipart)
export const diagnoseRequestSchema = z.object({
  image: storageRefSchema.refine(r => r.bucket === 'crop-images'),   // Requirement 2.5
  language: languageSchema,
  conversationId: z.string().uuid().optional(),                      // Requirement 7.5
});
export const diagnoseResponseSchema = z.object({
  diagnosisId: z.string().uuid(),
  conversationId: z.string().uuid(),
  result: diagnosisResultSchema,
  quota: z.object({ operation: z.literal('image'), used: z.number().int(),
                    limit: z.number().int(), resetsAt: z.string().datetime() }),
});

// POST /api/chat
export const chatRequestSchema = z.object({
  conversationId: z.string().uuid(),               // Requirement 7.1/7.2 — context key
  message: z.string().min(1).max(1000),
  language: languageSchema,
});
export const chatResponseSchema = z.object({
  conversationId: z.string().uuid(),
  farmerMessageId: z.string().uuid(),
  answer: z.object({
    messageId: z.string().uuid(),
    content: z.string().min(1),
    language: languageSchema,
    groundedIn: z.array(verifiedConditionSchema),  // which KB rows fed the answer
    needsExpert: z.boolean(),                      // true for out-of-scope (Req 4.7, 7.6)
  }),
  quota: quotaStatusSchema,
});

// POST /api/voice
export const voiceRequestSchema = z.object({
  audio: storageRefSchema.refine(r => r.bucket === 'voice-messages'),
  language: languageSchema,
  conversationId: z.string().uuid(),
  durationSeconds: z.number().positive().max(120),  // Requirement 8.2, re-checked server-side
});
export const voiceResponseSchema = z.object({
  transcript: z.string(),                           // Requirement 8.6 — both returned
  answer: chatResponseSchema.shape.answer,
  conversationId: z.string().uuid(),
  quota: quotaStatusSchema,
});
```

Requirement 2.2 also permits a diagnosis request without a conversation id; Requirement 7.5 then requires the API to create one and attach the diagnosis, which is why `conversationId` is optional on diagnose and required on chat and voice.

### Access contracts — linking and payment

Both of these take **no request body at all**, and that is the contract rather than an omission. Requirement 21.1 binds the token to the session's farmer and Requirement 22.2 determines the amount, the currency, and the owner server-side, so there is nothing a client could legitimately send. An endpoint that accepted a `userId` or an `amount` would have to validate it against the session anyway, and the only outcome of accepting it is a field an attacker can try.

```ts
// POST /api/link/token       — mint (Requirement 21.1). No request body.
export const linkTokenResponseSchema = z.object({
  deepLink: z.string().url(),                       // https://t.me/<bot>?start=<token>
  expiresAt: z.string().datetime(),                 // so the UI can say "valid for N minutes"
});
// DELETE /api/link/token     — unlink (Requirement 21.15). No request body, no response body.

// GET  /api/profile/access   — what the profile screen renders (21.20, 22.18)
export const accessStateSchema = z.object({
  telegramLinked: z.boolean(),
  entitlementActive: z.boolean(),
  unlockPriceMinor: z.number().int(),               // from BOT_UNLOCK_PRICE (22.4)
  currency: z.string(),
});

// POST /api/payment/order    — create (Requirement 22.1). No request body.
export const paymentOrderResponseSchema = z.object({
  providerOrderId: z.string().min(1),
  providerKeyId: z.string().min(1),                 // publishable checkout key, not the secret
  amountMinor: z.number().int().positive(),
  currency: z.string(),
});
// POST /api/payment/webhook  — no schema is published for this route: its body is the
// provider's, it is authenticated by signature alone (22.24), and it is parsed only
// after verification (D15). Its shape is V27, not Jamee's.
```

The deep link is returned already assembled rather than as a bare token, so the bot username lives in exactly one place. `paymentOrderResponseSchema` returns the *publishable* key id and never the key secret; a `checkout key` that appears in a response body is fine by design, a secret that does is a leak. `accessStateSchema` returns `entitlementActive` as a boolean and not the entitlement row, because the browser has no use for the payment id and every reason not to hold it.

### Localized error envelope

Every non-2xx response from the API layer uses one shape (Requirement 15.3):

```ts
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),                    // stable, machine-readable
    message: z.string(),                 // localized, farmer-readable
    language: languageSchema,
    retryable: z.boolean(),              // drives the retry action (Req 15.4)
    details: z.object({                  // present only where the code defines it
      limit: z.number().int().optional(),
      used: z.number().int().optional(),
      resetsAt: z.string().datetime().optional(),
      supportedLanguages: z.array(z.string()).optional(),   // Requirement 9.5
      acceptedTypes: z.array(z.string()).optional(),
      maxBytes: z.number().int().optional(),
    }).optional(),
  }),
});
```

`details` is deliberately structured rather than baked into the message string, so the client can render a localized sentence *and* a precise number without string parsing. No stack trace, provider payload, or model text ever enters this envelope (Requirement 15.6).

### Service interfaces

```ts
export interface DiagnoseInput {
  userId: string;
  storageRef: StorageRef;
  language: Language;
  channel: Channel;                       // Requirement 16.5
  conversationId?: string;
}
export interface DiagnosisService {
  diagnose(input: DiagnoseInput): Promise<{ diagnosisId: string; conversationId: string;
                                            result: DiagnosisResult }>;
}
export interface ChatService {
  answer(input: { userId: string; conversationId: string; message: string;
                  language: Language; channel: Channel;
                  inputKind?: 'text' | 'voice' }): Promise<ChatAnswer>;
}
export interface VoiceService {
  handle(input: { userId: string; storageRef: StorageRef; language: Language;
                  channel: Channel; conversationId: string })
    : Promise<{ transcript: string; answer: ChatAnswer }>;
}
```

`channel` being a required parameter is what makes Requirement 16.5 structurally true — a caller cannot forget it, and both route handlers and the Telegram adapter pass literals.

Note what these three signatures do **not** carry: no entitlement flag, no linking state, and no Telegram identifier. That is **D14** expressed as a type. A service that cannot see an entitlement cannot gate on one, so Requirement 22.17's "the web stays free" cannot be broken by an edit inside a service, and **D7**'s parity claim stays a claim about one code path.

The access services are separate interfaces, and each returns a decision rather than a reply — the adapter owns wording and language selection (Requirements 21.19, 22.14):

```ts
export type BindOutcome =
  | { kind: 'bound' }                          // 21.6
  | { kind: 'already_bound_to_this_account' }  // 21.10 - token consumed, no write
  | { kind: 'replaced'; previousTelegramUserId: number }  // 21.11 + 21.12 notice
  | { kind: 'taken_by_other_account' }         // 21.13 - token left unconsumed
  | { kind: 'invalid' };                       // 21.8 - unknown | expired | consumed,
                                               //   one kind on purpose, never three

export interface LinkingService {
  mint(authUserId: string): Promise<{ deepLink: string; expiresAt: string }>;
  consumeAndBind(token: string, telegramUserId: number): Promise<BindOutcome>;  // one txn
  unlink(authUserId: string): Promise<void>;    // clears the column, invalidates tokens
}
export interface EntitlementService {
  holdsEntitlement(authUserId: string): Promise<boolean>;
  grant(input: { authUserId: string; providerPaymentId: string;
                 paymentOrderId: string }): Promise<'granted' | 'already_granted'>;
}
export interface PaymentService {
  createOrder(authUserId: string): Promise<PaymentOrderResponse>;
  handleVerifiedEvent(payload: unknown): Promise<'granted' | 'already_granted' | 'ignored'>;
}
```

`BindOutcome` collapses unknown, expired, and consumed into a single `invalid` variant at the *type* level, which is how **D13**'s no-oracle rule survives refactoring: a future contributor adding a friendlier message for "expired" would have to widen the union first, and widening it is a visible change with a reason attached in this document. `holdsEntitlement` returns a boolean rather than the row for the same reason `accessStateSchema` does — the gate needs a yes or no, and anything more is an invitation to branch on payment details in the adapter.

---

## Provider strategy and fallback

`AiGateway` routes by **capability**, not by provider name. Three capabilities: `vision-classify`, `text-generate` (rephrasing, chat), `transcribe`.

```ts
type Capability = 'vision-classify' | 'text-generate' | 'transcribe';
type ProviderId = 'gemini' | 'groq';
type ProviderFailure = 'RATE_LIMIT' | 'UNAVAILABLE' | 'OTHER';

interface GatewayResult<T> { value: T; provider: ProviderId; usedFallback: boolean; }
```

The fallback trigger is narrow by requirement: only a rate-limit or unavailability condition from the primary causes a retry on the fallback (Requirement 14.4). A validation failure, a malformed answer, or a content refusal is *not* a transport failure and does not trigger a provider retry (D4). Classifying a provider error into `RATE_LIMIT` / `UNAVAILABLE` / `OTHER` needs the providers' real error shapes — **VERIFY AT IMPLEMENTATION (V11)**; until then adapters expose a single `classifyError()` seam with a conservative default of `OTHER` (no fallback, fail fast) so an unrecognized error never silently doubles provider spend.

### Fallback matrix

| Capability | Primary | Fallback | On both failing |
| --- | --- | --- | --- |
| `vision-classify` (image → candidate condition) | Gemini multimodal — **VERIFY model id (V6)** | **Conditional.** Exists only if a currently vision-capable Groq model is available — **VERIFY (V9)**. If none, this capability has no fallback | `PROVIDERS_UNAVAILABLE` → the Requirement 14.5 busy message (Requirement 14.8) |
| `text-generate` (KB rephrase, chat answer) | Gemini text — **VERIFY model id (V6)** | Groq text model — **VERIFY model id (V8)** | `PROVIDERS_UNAVAILABLE` → busy message (Requirement 14.5) |
| `transcribe` (audio → text) | Whisper — **VERIFY host, model id, limits (V10)** | None in this release | `TRANSCRIPTION_FAILED` → retryable error; empty transcript is a separate case (Requirement 8.7) |

Requirement 14.8 says image interpretation must treat a both-provider failure as a failed operation returning the busy message. The code path is written so that the *absence* of a vision fallback is handled by exactly the same branch as a *failed* vision fallback:

```ts
// src/lib/ai/gateway.ts
async run<T>(capability: Capability, req: ProviderRequest<T>): Promise<GatewayResult<T>> {
  const chain = this.providersFor(capability);      // may legitimately have length 1
  let lastFailure: ProviderFailure | undefined;

  for (const [index, provider] of chain.entries()) {
    try {
      return { value: await provider.invoke(req), provider: provider.id, usedFallback: index > 0 };
    } catch (err) {
      lastFailure = provider.classifyError(err);
      const canFallback = lastFailure === 'RATE_LIMIT' || lastFailure === 'UNAVAILABLE';
      if (!canFallback) break;                     // content/other errors: fail fast
    }
  }
  // Reached when the chain is exhausted OR had a single member (no vision fallback).
  // One branch, so "no fallback configured" and "fallback also failed" are
  // indistinguishable to callers, satisfying Requirement 14.8.
  throw new AppError('PROVIDERS_UNAVAILABLE', { cause: lastFailure });
}
```

`providersFor('vision-classify')` reads a single configuration flag derived from V9. If V9 turns out to be false, the chain is `[gemini]` and nothing else in the codebase changes; if it later becomes true, adding the adapter to the chain is a one-line change. That is the whole point of the capability indirection.

Provider free-tier numbers are never encoded in this logic. Jamee reacts to a rate-limit *signal*; it does not model a provider's quota. Whether Jamee's own daily limits (Requirement 14.1) sit comfortably below the providers' free tiers for 6 farmers is a sizing question answered by V19 during implementation and recorded in `docs/DEPLOYMENT.md`.

### Timeouts

Every provider call carries an abort deadline derived from a single per-request soft budget below the platform function ceiling (spec: 60 s; **VERIFY V16/V17**). On expiry the service returns `DIAGNOSIS_TIMEOUT` naming the diagnosis operation and logs `outcome = 'timeout'` (Requirements 3.6, 3.7). The budget is one constant in `src/lib/ai/gateway.ts`, expressed as a fraction of the configured ceiling, so raising `maxDuration` does not require touching call sites.

---

## Prompting and grounding

Three prompts, all in `src/lib/prompts.ts`, all versioned by a `PROMPT_VERSION` constant recorded on `usage_logs` rows during development so a behavioral change is attributable.

### 1. Constrained vision classification

Contract with the model: emit only JSON matching `visionRawSchema`, choose `disease_name` only from the five verified conditions, and return a non-identified status rather than guessing.

```
You are an image classifier for a crop advisory tool. You classify ONLY these
five conditions:
  Tomato Early Blight | Tomato Late Blight | Tomato Healthy
  Potato Early Blight | Potato Late Blight

Return ONLY this JSON object, no prose, no markdown fence:
{"status":"identified"|"unclear"|"no_plant",
 "disease_name": <one of the five names, or null>,
 "confidence": <number 0..1>,
 "severity": "none"|"low"|"moderate"|"high"}

Rules:
- If the image is blurry, dark, or too low-resolution to judge -> status "unclear",
  disease_name null.                                        [Requirement 6.2]
- If the image contains no plant -> status "no_plant", disease_name null. [6.3]
- If the plant is not tomato or potato, or the condition is not one of the five
  -> status "unclear", disease_name null. Never invent or substitute a name. [4.7, 5.6]
- If several leaves are visible, judge the single most affected leaf and report
  exactly one condition.                                     [Requirement 3.5]
- A visibly healthy tomato plant -> "Tomato Healthy", severity "none".  [3.4]
- Do not give treatment advice. Do not explain. JSON only.
```

Structured-output enforcement (response MIME type, response schema, temperature) is configured on the request rather than trusted to the prompt — **VERIFY parameter names (V7)**. Lowest available temperature, for D7's parity reasoning.

Belt and braces: even with structured output configured, the response is still parsed by `visionRawSchema` then `visionVerifiedSchema` (Requirement 5.1). The prompt is a request; the schema is the enforcement.

### 2. Knowledge-base rephrasing (identified results only)

Called once, only after stage-2 validation succeeds. The request carries the knowledge-base row's arrays verbatim and instructs rephrase-only (Requirement 4.5):

```
Rephrase the VERIFIED CONTENT below into simple {en|hi|mr} for a smallholder
farmer with limited schooling. 4-6 short sentences.

VERIFIED CONTENT (the only facts you may use):
  disease: {canonical_name}         symptoms: {…}   causes: {…}
  treatment: {…}                    prevention: {…}

Rules:
- Use ONLY the facts above. Add no disease, symptom, cause, chemical, dose,
  brand, or timing that is not written above.                 [Requirement 4.3]
- Write the disease name exactly as "{canonical_name}" in Latin script. Do not
  translate or transliterate it.                              [Requirements 4.6, 9.4]
- If treatment is empty, do not mention treatment at all.     [Requirement 3.4]
- No greetings, no disclaimers, no markdown.
```

For `Tomato Healthy` the treatment array is empty by seed and by check constraint, so "report a healthy crop with no treatment content" (Requirement 3.4) holds by construction rather than by the model's cooperation.

### 3. Chat over conversation context

Input assembled by `ChatService`: the last N messages of the conversation (N as a constant, bounded by token budget), the most recent `Diagnosis_Result` of that conversation, and the knowledge-base rows for the conditions in scope.

```
Answer the farmer's question using ONLY the verified content supplied.

CURRENT DIAGNOSIS: {canonical_name | none}      RECENT MESSAGES: {…}
VERIFIED CONTENT: {kb rows}

Rules:
- If the question has no explicit subject (e.g. "why?", "how much?"), it refers
  to CURRENT DIAGNOSIS.                                        [Requirement 7.3]
- If the answer is not in VERIFIED CONTENT, reply exactly with the supplied
  fallback sentence and set nothing else.                      [Requirements 7.6, 4.7]
- Reply in the language of the farmer's message when it is English, Hindi, or
  Marathi; otherwise reply in {requested_language}.            [Requirements 9.6, 9.3]
- Keep the disease name in Latin script, untranslated.         [Requirements 4.6, 9.4]
- No new agricultural facts, no chemicals or doses not listed above.
```

Out-of-scope questions (Requirement 4.7) and unanswerable questions (Requirement 7.6) are *not* left to the model's judgement alone: `ChatService` first resolves which knowledge-base rows are in scope, and when the resolution set is empty it returns the static localized "Jamee covers tomato and potato conditions only — please consult an agricultural expert" message with `needsExpert: true` and makes no model call at all. The prompt rule is a second line of defence for the harder middle case where rows exist but do not contain the answer.

### Post-generation validation of rephrased text

Chat and rephrase output is checked before it reaches a farmer:

1. Non-empty, within a length ceiling.
2. If an identified condition is in play, the canonical name appears verbatim in Latin script (Requirements 4.6, 9.4). If it is missing or mangled, the service repairs it deterministically by prefixing the canonical name rather than re-calling the model.
3. A deny-list scan for the four other verified condition names when they are not in scope, catching a cross-contaminated answer.
4. Failure of check 1 → treat as a provider failure for that step: identified diagnoses fall back to a static localized "condition identified, consult the details" template built from the knowledge-base row itself, so the farmer still receives KB-grounded content. This keeps Requirement 3.2 true even when the language model is unhelpful.

Checks 2–4 are heuristics over *presentation*; the substantive guarantee is structural — the model only ever receives knowledge-base content to work from, so there is no unverified fact available for it to leak.

---

## Telegram adapter

*This section replaces the WhatsApp adapter section in full (Amendment A1).* One route, `src/app/api/telegram/route.ts`, with **one** verb. The route handler stays thin; all logic sits in `src/lib/telegram.ts`, the access services, and the shared services.

There is no GET handler. Telegram has no verification challenge: registration is an outbound `setWebhook` call Jamee makes once, supplying the `Webhook_Secret_Token` (Requirement 11.1), so there is no inbound handshake to answer and the old `WEBHOOK_VERIFY_TOKEN_INVALID` code retires with it.

### POST — secret token before anything else

```ts
export const maxDuration = 60;                          // Serverless_Duration_Ceiling

export async function POST(request: Request) {
  const presented = request.headers.get('X-Telegram-Bot-Api-Secret-Token');  // VERIFY (V24)
  const configured = serverEnv.TELEGRAM_WEBHOOK_SECRET_TOKEN;                // throws if absent

  // Req 11.2: constant time, and BEFORE the body is read as an update at all.
  // Req 11.4: an absent configured secret is a FAILED verification, not a skipped one —
  // serverEnv throwing lands here rather than allowing the request through.
  if (!timingSafeEqualStr(presented, configured)) {
    return json({ error: { code: 'WEBHOOK_SECRET_TOKEN_INVALID' } }, 401);   // Req 11.3
  }

  const update = telegramUpdateSchema.safeParse(await request.json());       // VERIFY (V24)
  if (!update.success) return new Response(null, { status: 200 });           // ack + ignore
  return handleInbound(update.data);
}
```

Three things about that shape. The comparison is over a header rather than a digest, so nothing couples it to the raw body bytes — **D12** explains why that is a simplification rather than a weakening, and why `request.json()` is safe here when it was forbidden on the retired WhatsApp path. `timingSafeEqualStr` handles the null case by comparing against a fixed-length dummy, so a missing header takes the same time as a wrong one. And the 401 is the one deliberate exception to Requirement 10.11's "acknowledge with 200": an unauthenticated request is not an accepted delivery, and Requirement 11.3 requires the body to go unparsed.

A well-formed request whose *payload* does not parse is acknowledged with 200 and dropped. That is not laxity: Telegram retries a non-200, and a payload Jamee cannot parse will not parse on the retry either, so answering anything else buys an infinite redelivery loop for an update Jamee was never going to handle.

### Inbound processing order

Requirement 22.16 fixes the first four steps as an ordering obligation, so this list is the contract rather than an implementation preference.

```
1. Parse update → { updateId, telegramUserId, type, textBody?, fileId?,
                    startPayload? }                            [VERIFY V24, V26]
2. INSERT INTO telegram_inbound (update_id, …)
     - unique violation → log duplicate_ignored, return 200, ZERO quota,
       no service call                          [Requirements 11.5, 11.6, 11.7, 11.8]
3. /start short-circuit                                        [Requirement 21]
     - with a token payload  → LinkingService.consumeAndBind (one txn), reply per
       BindOutcome, mark 'processed', 200, ZERO quota            [21.6–21.13, 21.18]
     - with no token payload → linking instructions, 200, zero quota        [21.9]
     - no shared service is invoked on this branch either way              [21.18]
4. Resolve profiles.telegram_user_id = telegramUserId           [Requirement 10.2]
     - no profile → linking instructions, mark 'unlinked', 200, zero quota
       (the reply is IN ADDITION TO the 200, not instead of it)      [10.3, 21.17]
5. EntitlementService.holdsEntitlement(profile.id)              [Requirement 22.13]
     - false → unlock reply naming the price and where to pay, in the Profile's
       language; mark 'not_entitled'; 200; zero quota; NO Message and NO
       Diagnosis_Result persisted                                    [22.13, 22.14]
6. Reject unsupported type (not text/photo/voice) → reply "photos, text, voice
   notes", mark 'rejected', 200, zero quota                    [Requirement 10.9]
7. Find-or-create the farmer's active Telegram conversation    [Requirements 10.5, 10.8]
8. Dispatch by type:
     photo → getFile + download → service-role upload → DiagnosisService  [10.4]
     text  → ChatService with the conversation id                         [10.5]
     voice → getFile + download → service-role upload → VoiceService      [10.6]
9. Send the reply via sendMessage
10. Mark telegram_inbound.status = 'processed', return 200      [Requirement 10.11]
```

Step 2 sitting above steps 3–8 is what makes Requirement 11.5 true in the strong sense, and Requirement 11.7 now says so directly: a redelivery cannot spend quota, cannot call a provider, cannot download media, and cannot produce a second reply, because the insert fails before any of that is reachable. It also protects the linking flow — a redelivered `/start` cannot produce a second binding attempt, which is a second guard over the same property **D13**'s atomic statement guarantees on its own.

Step 3 sits above resolution deliberately. A `/start` carrying a valid token arrives precisely *because* the sender resolves to nothing yet, so a resolution check ahead of it would reject the one update whose whole purpose is to create the resolution.

Steps 4 and 5 both reply and both spend nothing, and they are separate steps because they mean different things to the farmer: step 4 says "Jamee does not know who you are yet, here is how to link", step 5 says "Jamee knows exactly who you are, and the bot needs a one-time unlock". Collapsing them into one message would leave a farmer who has paid but not linked, or linked but not paid, with no idea which half is missing. Requirement 22.18 covers the same distinction from the web side.

One consequence of the ordering: step 2 precedes profile resolution, while `usage_logs.user_id` is `not null`. The `duplicate_ignored` row is therefore written with the `user_id` already stored on the conflicting `telegram_inbound` row. When that column is null — the original delivery came from an unlinked sender — the duplicate is recorded by the `telegram_inbound` status alone and no `usage_logs` row is written. Requirement 14.6 asks for a usage row per completed model operation, and a duplicate completes none, so the audit stays correct either way. Gated and unlinked updates are recorded the same way, through `status = 'not_entitled'` or `'unlinked'`, for the same reason: they complete no model operation.

### Media download and upload

Telegram's retrieval is also two calls, but they are not Meta's two calls, and the difference matters to the code. `getFile(file_id)` returns a `file_path`; the bytes are then fetched from the Bot API **file endpoint** with that path appended, and the bot token is part of the URL rather than an `Authorization` header — **VERIFY the exact URL form, the `file_path` validity window, and the bot-download size ceiling (V25)**. Consequences worth stating because they read as trivia until they bite:

- **The bot token appears in a URL.** So that URL is never logged, never put in an error message, and never returned to a farmer. The existing rule that no provider payload enters the error envelope (Requirement 15.6) already covers the farmer-facing half; the logging half is a review item on `src/lib/telegram.ts`.
- **A `file_path` expires.** It is fetched immediately before the download and never cached across invocations, which suits an inline handler (**D11**) and would not suit a deferred one.
- **The container question is answered rather than open.** A `voice` message is OGG/Opus (V26), which V10's accepted list includes, so Requirement 10.6 is satisfiable — this is the criterion the retired V14 row recorded as unsatisfiable. The adapter still checks the reported `mime_type` against V10's list before downloading, because "always OGG/Opus" is a documented guarantee and not a verified runtime fact, and the check is one comparison. A `voice` note and an `audio` file are different update types with different guarantees, so the adapter admits `voice` and treats `audio` and `document` as the unsupported type of Requirement 10.9.

The adapter then uploads the bytes with the **service-role** client, because a webhook carries no farmer session, writing to `crop-images/{profile.id}/{YYYY}/{MM}/{uuid}.{ext}`. Keeping the `{user_id}/` prefix means the object is readable later by that farmer's own session under the storage policy, which is what lets Telegram diagnoses appear in the web history (Requirements 12.2, 12.5) — through Requirement 12.7's full-size fallback, since this path produces no thumbnail.

Content type and size are checked against the same limits as the web path before upload; an oversized or unsupported media item gets a plain-language reply and spends nothing. Telegram reports no duration on a voice note either, so the web recorder's 120-second check has nothing to compare on this channel and the size cap is the operative bound — the same honest gap the retired V14 row recorded, carried forward because it is a property of inbound chat media rather than of any one provider.

### Conversation find-or-create

`ConversationService.findOrCreateActive(userId, 'telegram')` returns the most recently updated `channel = 'telegram'` conversation for that farmer, creating one when none exists. Because Requirement 10.8 requires follow-ups to resolve against the most recent diagnosis in *that* conversation, the Telegram channel deliberately keeps a single long-running thread rather than starting a new conversation per image — a new image simply appends a new diagnosis to the thread, and "why?" resolves to the latest one. Web conversations are separate rows (`channel = 'web'`), so a web thread and a Telegram thread never bleed into each other while still sharing one identity and one quota.

The conversation is keyed on the resolved `profiles.id`, not on the `telegram_user_id`. So a farmer who unlinks and re-links — from a different Telegram account, even — comes back to the same thread, and Requirement 21.15's "retain every Conversation, Message, and Diagnosis_Result" holds with no migration of rows. That is the same reasoning **D14** applies to the entitlement, applied to history.

### Acknowledgement versus processing

Requirement 10.11 wants a 200 for every accepted delivery; Requirement 10.10 wants the whole invocation inside the function duration ceiling. Telegram redelivers on a non-200, and a late 200 risks a redelivery that duplicates work.

**Decision (D11): process inline in one invocation, then acknowledge, with a soft deadline and an idempotency guard.** *Amended by Amendment A1 — the reasoning is unchanged; the provider names and one retired constraint are.* Reasoning:

- A serverless function on this platform cannot be relied on to keep working after the response is sent unless a supported continuation primitive exists — **VERIFY (V18)**. Designing on an unverified primitive would be the riskier choice.
- The observed work is one classification call plus one rephrase call plus two Supabase round trips. That fits comfortably inside the assumed 60 s ceiling for a single update.
- The `telegram_inbound` insert already happened, so even if Telegram redelivers after a slow 200, the redelivery is dropped as a duplicate. **Correctness does not depend on the acknowledgement being fast** — that is the load-bearing sentence in this decision, and it is why the claim precedes anything billable rather than merely preceding the reply.
- A soft deadline (a fraction of the configured ceiling, same constant as the gateway budget) fires before the platform kills the function: the adapter sends "Jamee is taking longer than usual on this photo — please send it again in a moment", marks the row `failed`, and returns 200. Marking it `failed` rather than `processed` is deliberate — it keeps the audit honest, and the farmer's next send carries a new `update_id` so it is processed normally.
- `markProcessed` runs **after** the reply is sent, not before. A row marked `processed` on an update whose reply never left the function would make a redelivery a silent no-op and lose the farmer's answer outright.
- The unit of work is **one update**, not one batch. Telegram delivers updates individually to a webhook, but even if a delivery carried several, each would be claimed and marked on its own `update_id` — a batch-level claim would make one slow item discard the rest.

One input to the old version of this decision is gone: there is no 24-hour customer-service window and no template requirement on this channel (V15 is retired), so a reply emitted late is a latency problem and not an undeliverable message. Telegram's own retry cadence on a non-200 is **V24**.

If V18 confirms a supported continuation primitive, the upgrade path is contained: return 200 immediately after step 2 and move steps 3–10 into the continuation. Nothing in the services changes, because they already take a `channel` and are already idempotent-guarded. The entitlement gate would move with the rest, which is safe because it reads state rather than writing it.

---

## Frontend

### Screens and component boundaries

| Route | Rendering | Notes |
| --- | --- | --- |
| `/` | Server component; `GoogleSignInButton` is client | One control, one provider (Requirement 1.1). Redirects to `/diagnose` when a session exists; shows the "sign-in did not complete" message and offers a retry when the callback returned no exchangeable authorization (Requirement 1.3) |
| `/diagnose` | Server shell (session + preferred language) + client `ImageUploader` and `DiagnosisResultCard` | Upload, progress, result |
| `/chat` | Server shell loads conversation + messages via RLS; client `ChatComposer` | Optimistic farmer bubble, server-confirmed answer |
| `/voice` | Server shell; client `VoiceRecorder` | Needs `MediaRecorder`, so client-only |
| `/history` | Server component; data via the RLS-scoped server client | Signed thumbnail URLs minted server-side (Requirement 12.5); `EmptyState` invites a first upload when the farmer has no diagnoses (Requirement 12.4) |
| `/diagnosis/[id]` | Server component | Image, condition or inconclusive label, confidence, severity, full explanation, conversation messages (Requirement 12.3) |
| `/profile` | Server shell + client form, plus `TelegramLinkCard` and `BotUnlockCard` | Display name + preferred language (Requirement 1.8). The server shell reads the access state so the two cards render from one round trip: linked or not, with the link or unlink action accordingly (Requirement 21.20); entitlement active with no further order offered, or the unlock action with the price (Requirement 22.18). A fresh Link_Token is minted by the action, never on page render, so opening the profile screen does not litter the table with unused capabilities |

Rule of thumb applied throughout: data fetching and signed-URL minting are server-side; anything touching `navigator`, `MediaRecorder`, or local component state is a client component. No route handler is called just to read data a server component can query directly under RLS.

### Browser-direct upload

`ImageUploader` validates MIME type against `image/jpeg | image/png | image/webp` and size against 10 MB, and on rejection states both the accepted types and the limit (Requirements 2.3, 2.4). It then uploads straight to `crop-images/{user_id}/{YYYY}/{MM}/{uuid}.{ext}` with the browser Supabase client — the storage policy independently enforces the prefix, so a tampered client cannot write into another farmer's folder. Only on a successful upload does it POST the reference (Requirement 15.5: an upload failure produces an upload error and **no** diagnosis request).

### Voice capture

`VoiceRecorder` is hold-to-speak: `MediaRecorder` starts on press, stops on release. It enforces a hard 120 s stop with a visible countdown from 100 s, and rejects a blob over 10 MB after stop, stating both limits (Requirements 8.2, 8.3). The recorded container/codec must be one the transcription provider accepts — **VERIFY (V10, V20)**; the component picks from a preference list of supported MIME types and surfaces a clear message if the browser offers none. Upload goes directly to `voice-messages/{user_id}/…`, then `/api/voice` receives the reference and the measured duration. The response renders transcript above answer (Requirement 8.6). No audio playback of answers in this release (Requirement 8.8).

### Honest loading states

Requirement 15.2 forbids simulated progress, so every indicator is bound to an actual request state:

| Observed state | Displayed |
| --- | --- |
| Direct upload in flight | "Uploading your photo…" with real byte progress if the upload API reports it, otherwise an indeterminate spinner — never a timed bar |
| `/api/diagnose` awaiting response | Exactly `Jamee is analyzing your crop image…` (Requirement 15.1) |
| Transcription in flight | "Jamee is listening to your recording…" (Requirement 15.7) |
| Chat awaiting response | "Jamee is thinking…" |
| Error | `ErrorBanner` with the localized message from the envelope plus a Retry action for that operation (Requirement 15.4) |

Indeterminate spinners are used wherever real progress is unavailable. No `setInterval` ever advances a percentage.

### Mobile layout and accessibility

Mobile-first, single column, tap targets at least 44×44 px, primary actions in thumb reach. Body text scales with the OS setting (relative units, no fixed `px` on text). Devanagari rendering is verified with a font stack that covers Hindi and Marathi.

Accessibility specifics: every control has a visible label plus an accessible name; the upload input is a real `<input type="file">` with a `<label>`, not a click-handled `<div>`; the result region is an `aria-live="polite"` landmark so a screen reader announces a diagnosis when it arrives; loading text is real text, not only a spinner; error banners are `role="alert"`; severity is conveyed by label text and icon, never colour alone; the recorder is operable by keyboard (press-and-hold has an equivalent tap-to-start/tap-to-stop path). Contrast targets WCAG 2.1 AA. Full WCAG conformance cannot be asserted from code alone — it needs manual testing with a screen reader and expert review, which is listed in the manual test plan.

---

## Security boundary

### Environment variables

| Variable | Exposure | Used by |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Public (browser) | Browser + server clients |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public (browser) | Browser client; RLS applies |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server only** | `lib/supabase/admin.ts` |
| `GEMINI_API_KEY` | **Server only** | `lib/gemini.ts` |
| `GROQ_API_KEY` | **Server only** | `lib/groq.ts` |
| `TELEGRAM_BOT_TOKEN` | **Server only** | `getFile`, file download, `sendMessage` (V24, V25) |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | **Server only** | Webhook authenticity (Requirements 11.1–11.4, D12) |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | Public (browser) | Assembling the Link_Deep_Link. Not a secret: it is in the link every farmer opens |
| `RAZORPAY_KEY_ID` | **Server only** | Order creation (V27) |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Public (browser) | Checkout only. Same value as above, deliberately duplicated under two names so the *secret-adjacent* one is never accidentally read from a client component |
| `RAZORPAY_KEY_SECRET` | **Server only** | Order creation signing |
| `RAZORPAY_WEBHOOK_SECRET` | **Server only** | Payment webhook signature (Requirement 22.5, D15) |
| `RETENTION_SWEEP_SECRET` | **Server only** | Retention sweep gate (Requirement 18.12) |

No SMS provider variable appears, and none is required (Requirement 1.10). The Google OAuth client id and secret are configured in the Supabase dashboard rather than in Jamee's environment, so they are not in this table — V23 confirms where they live and which redirect URLs must be registered.

The duplicated Razorpay key id deserves its note. A single `RAZORPAY_KEY_ID` read from both a server module and a client component would work right up until someone moved the read, at which point the build would silently ship `undefined` to checkout. Two names make the exposure a declaration instead of an accident, and a CI check asserts the unprefixed name never appears in a file containing `'use client'`. `BOT_UNLOCK_PRICE` and `LINK_TOKEN_TTL_MINUTES` are deliberately **not** in this table at all: Requirements 22.4 and 21.4 require them to be compile-time constants read from one place, reviewable in a diff, not values an environment can change without a code review.

Only `NEXT_PUBLIC_`-prefixed values can reach the browser bundle, which is the mechanical guarantee behind Requirement 13.7. Three further layers make an accidental leak hard:

1. `src/lib/supabase/admin.ts` begins with `import 'server-only'`, so importing it from a client component is a build error, not a runtime surprise.
2. The service-role client is created inside a function (never at module scope) and that function throws when `typeof window !== 'undefined'`.
3. Secrets are read through a small `serverEnv` accessor in a `server-only` module that validates presence at first use with Zod and fails loudly; no `process.env.X!` scattered through the codebase.

A CI grep asserts that `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` appear only under `src/lib/**` server modules and `src/app/api/**`, and never in a file containing `'use client'`. `scripts/check-secret-scope.ts` is the existing home for that check.

### Defence in depth

RLS is the primary authorization boundary and is enabled on all six farmer-facing tables plus the three access tables `link_tokens`, `payment_orders`, and `bot_entitlements` (Requirements 13.1, 21.3, 22.23), plus `counters`, `telegram_inbound`, and `webhook_throttle`. Route handlers additionally check the session (Requirement 1.7) and object ownership (Requirement 2.5) rather than relying on RLS alone, because service-role paths (the Telegram adapter, the access services, the quota functions, the retention sweep) bypass RLS by design — so for those paths the application check *is* the boundary. Every service-role query is written with an explicit `user_id` predicate for exactly that reason, and code review treats a service-role query without a `user_id` filter as a defect.

The three access tables carry a `select`-own policy and **no** write policy at all, which is Requirement 22.23's "restrict every write to server-side modules using the Service_Role_Key" expressed the way Postgres enforces it: with RLS enabled and no `insert`, `update`, or `delete` policy, those verbs are unreachable for `anon` and `authenticated`, and only the service role — which bypasses RLS — can write. A farmer session therefore cannot mint a token for someone else, extend an expiry, un-consume a token, mark an order captured, or grant itself an entitlement, and none of that depends on application code being careful.

Two service-role writes in this amendment are worth naming because their tenant anchor is not a `user_id` the caller supplied. The linking bind takes its `user_id` from the token row's own `RETURNING user_id`, never from anything in the Telegram update — a sender cannot nominate whose profile to bind to. The entitlement grant takes its `user_id` from the recorded `payment_orders` row, never from the webhook payload (Requirement 22.7) — a forged-but-somehow-verified payload cannot redirect a grant.

---

## Error taxonomy

One `AppError` type carrying a stable code; one mapping table to HTTP status and localized message key. Messages come from `src/lib/messages/{en,hi,mr}.ts` (D5) and are selected by the request's resolved language.

| Code | HTTP | Retryable | Message intent | Requirement |
| --- | --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | no | Sign in to continue | 1.7 |
| `OAUTH_INCOMPLETE` | 401 | yes | Sign-in did not complete; offers to sign in again. Replaces `OTP_INVALID`, retired with phone auth. One code for a cancelled authorization, a provider error, and a callback with nothing to exchange — the farmer's next action is identical in all three, and distinguishing them would only describe Google's internals | 1.3 |
| `LANGUAGE_UNSUPPORTED` | 400 | no | Names `en`, `hi`, `mr` in `details.supportedLanguages` | 9.5 |
| `MESSAGE_INVALID` | 400 | no | The question could not be read; type it again. The text counterpart of `STORAGE_REF_INVALID`, so `/api/chat`'s body-contract fallback does not name a photo | 7.1, 15.3 |
| `STORAGE_REF_INVALID` | 400 | no | Reference is not a usable object | 2.2 |
| `STORAGE_REF_FORBIDDEN` | 403 | no | Not your file | 2.6 (quota untouched) |
| `FILE_TYPE_UNSUPPORTED` | 400 | no | Lists accepted types and max size | 2.4 |
| `FILE_TOO_LARGE` | 400 | no | States the 10 MB limit | 2.4, 8.3 |
| `AUDIO_TOO_LONG` | 400 | no | States 120 s and 10 MB | 8.3 |
| `AUDIO_FORMAT_UNSUPPORTED` | 400 | no | The recording cannot be used; type the question instead. V10's accepted containers go in `details.acceptedTypes`, not into the sentence | 8.4, 10.6 |
| `RATE_LIMITED` | 429 | yes | Slow down, try again shortly | 13.8 |
| `QUOTA_EXCEEDED` | 429 | no (today) | States the limit and reset time via `details` | 14.3 |
| `TRANSCRIPT_EMPTY` | 422 | yes | Record again somewhere quieter | 8.7 |
| `TRANSCRIPTION_FAILED` | 502 | yes | Could not hear the recording | 8.4 |
| `PROVIDERS_UNAVAILABLE` | 503 | yes | `en` renders exactly `Jamee is temporarily busy. Please try again shortly.` | 14.5, 14.8, D6 |
| `DIAGNOSIS_TIMEOUT` | 504 | yes | Names the diagnosis operation | 3.7 |
| `WEBHOOK_SECRET_TOKEN_INVALID` | 401 | n/a | No body content. Missing header, wrong value, and unconfigured secret all land here (D12) | 11.3, 11.4 |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | n/a | No body content. Now the **payment** webhook's code: missing signature, failed verification, and unconfigured secret are one branch (D15) | 22.6 |
| `PAYMENT_ORDER_FAILED` | 502 | yes | The payment could not be started; try again shortly. The provider's error text never reaches the farmer | 22.1 |
| `CONVERSATION_NOT_FOUND` | 404 | no | The conversation could not be found — a `conversationId` that is not a uuid, or is not this farmer's. One code for one meaning, so the response is not an oracle | 7.1 |
| `DIAGNOSIS_NOT_FOUND` | 404 | no | The result could not be found. Raised by the diagnosis detail screen, a server component rather than an endpoint | 12.3 |
| `SWEEP_UNAUTHORIZED` | 401 | no | No body content; the sweep route has no human caller | 18.12 |
| `INTERNAL_ERROR` | 500 | yes | Generic message; no stack trace, no provider payload | 15.6 |

`Inconclusive_Result` is **not** in this table. An inconclusive diagnosis is a successful 200 response carrying `status: 'unknown'` — the request worked, the photo could not be judged. Modelling it as an error would break the single-shape rule (Requirement 6.4) and the quota rule (Requirement 6.7).

**Four Telegram outcomes are not in this table either, for the same kind of reason.** The linking instructions of Requirement 10.3, the invalid-link reply of 21.8, the already-linked-elsewhere reply of 21.13, and the unlock reply of 22.14 are all *successful* handling of a well-formed authenticated delivery. They are farmer-facing sentences from the message catalogs (D5), selected by the adapter and sent over `sendMessage`, and every one of them is accompanied by HTTP 200 to Telegram (Requirements 10.11, 21.17). Giving them error codes would put them in an envelope no farmer ever sees — Telegram is not an HTTP client reading Jamee's JSON — and would make the `webhook 200` rule look like it had exceptions it does not have. Their audit trail is the `telegram_inbound.status` column, not `usage_logs`.

A single `withErrorHandling` wrapper in the API layer catches `AppError` and maps it, and catches everything else as `INTERNAL_ERROR` after logging the real cause server-side only.

---

## Testing strategy

Unit and property tests are complementary: property tests cover the universal rules (see Correctness Properties), unit tests pin specific examples and edge cases, integration tests exercise wiring with mocked providers, and a short manual pass covers what only a human can judge.

### Unit tests (Vitest)

- **Zod schemas.** Malformed JSON, missing fields, confidence at `-0.1` / `0` / `1` / `1.1`, unknown severity, out-of-KB disease name — each maps to its expected `RejectionReason` (Requirements 5.2–5.6).
- **Grounding.** Rephrase requests contain the knowledge-base arrays and no other agronomic content; `Tomato Healthy` produces no treatment text; canonical names survive `en`/`hi`/`mr` untouched (Requirements 3.4, 4.6, 9.4).
- **Quota atomicity.** Against a real Postgres instance: fire the reserve concurrently at the limit boundary and assert the total never exceeds the limit and no reservation is lost; assert refund never drives `used` below zero.
- **Spend rule.** Ownership 403 → zero; duplicate delivery → zero; inconclusive → exactly one; pre-provider failure → refunded to zero.
- **Webhook secret token.** Matching header passes; absent header, wrong value, right value with a flipped byte, and an unconfigured secret all yield 401 with the body unparsed; the comparison is constant-time and takes the same time for an absent header as a wrong one (Requirements 11.2–11.4).
- **Payment signature.** Valid signature over the raw body passes; flipped byte, truncated digest, absent header, unconfigured secret, and a re-serialized body all fail; comparison is constant-time (Requirements 22.5, 22.6).
- **Idempotency.** Two concurrent inserts of the same `update_id`: one proceeds, one is dropped, no service call and no reply from the second. Two concurrent verified webhooks carrying the same `provider_payment_id`: one grants, one is dropped, exactly one `bot_entitlements` row exists (Requirements 22.10, 22.11).
- **Link token consume-and-bind.** Two concurrent `/start` deliveries of one token produce exactly one binding; an expired token and a consumed token and an unknown token produce byte-identical replies; a token whose target `telegram_user_id` is already on another profile leaves both profiles unchanged and the token unconsumed (Requirements 21.7, 21.8, 21.13).
- **Entitlement gate.** A linked farmer with no entitlement gets the unlock reply for a photo, a text, and a voice note, with zero quota spent, no `messages` row, and no `diagnoses` row; the same farmer's `/start` is still served; the same farmer's web requests are served unchanged (Requirements 22.13–22.15, 22.17).
- **Fallback matrix.** Primary `RATE_LIMIT` → fallback used and `used_fallback` recorded; primary `OTHER` → no fallback; single-member chain failing → `PROVIDERS_UNAVAILABLE` (Requirement 14.8).
- **Window keys.** Asia/Kolkata day boundary, including a UTC-evening timestamp that belongs to the next Kolkata day.
- **Error mapping.** Every code yields its status and a non-empty message in all three languages; the `en` `PROVIDERS_UNAVAILABLE` string matches Requirement 14.5 byte-for-byte.

### Static architecture check (CI)

The single-implementation claims are structural, not behavioural, so they are verified by a static check rather than by a property test: exactly one `DiagnosisService` module and one `ChatService` module exist; both the route handlers and the Telegram adapter import those modules rather than reimplementing image analysis, grounding, or rephrasing; and nothing under `src/services/**` or `src/lib/**` imports from `src/app/**`. That last rule is what keeps the first two true as the codebase grows (Requirements 3.8, 7.7, 16.1–16.4).

Two checks are added by Amendment A1, and both are structural for the same reason — they assert an *absence*, which no behavioural test can do convincingly. First, no module under `src/services/diagnosis|chat|voice` imports `entitlement.service`, which is **D14** and Requirement 22.17 enforced by the dependency graph rather than by vigilance. Second, `profiles.phone` has no reader outside `supabase/migrations/**`, which keeps Requirement 1.9's "takes part in no identity resolution" true as the codebase grows rather than only on the day it was written.

### Integration tests (mocked providers, real Postgres)

Providers are mocked at the adapter seam so the gateway, services, validation, persistence, and RLS are all real. Scenarios follow the requirements' own test matrix: healthy crop, clear diseased crop, blurry image, non-plant image, multiple leaves; chat in three languages plus a subject-less follow-up and an unknown question; voice with empty and noisy transcripts; Telegram text, photo, voice note, unsupported type, unlinked sender, **linked sender holding no entitlement**, duplicate update, timeout, and provider rate limit; account linking across a valid first-time link, an expired token, a consumed token, a Telegram account already linked elsewhere, and a `/start` with no payload; payment across an abandoned checkout, a replayed webhook, a forged signature, a captured payment opening a previously gated sender, and a flood of unauthenticated calls on the webhook route. RLS is verified by attempting cross-farmer reads with a second farmer's session and asserting zero rows — now including `link_tokens`, `payment_orders`, and `bot_entitlements`, and including a write attempt on each, which must fail rather than return zero rows.

### Manual tester validation

Some things cannot be automated honestly:

- Hindi and Marathi **transcription quality** on real farmer speech with field background noise. Automated tests can assert a non-empty transcript; only a human speaker can judge whether it is right.
- Hindi and Marathi **explanation readability** — whether a rephrased knowledge-base entry is actually plain language for a smallholder farmer.
- **Telegram end-to-end** from a real handset, in the order the release acceptance criteria fix: pay the one-time unlock, see the web app present the entitlement as active, open the deep link and link the account, send a photo, receive a diagnosis, ask a follow-up, and confirm the same content appears in the web history (Requirements 10.7, 12.2, 22.18, 22.19). The order is not a preference — a tester who sends the photo first sees the gated reply of 22.14, and that is correct behaviour rather than a defect.
- **Google sign-in on a real device**, including the cancel path, which must produce the "sign-in did not complete" message and a working retry (Requirement 1.3).
- **One real checkout**, in whichever provider mode the deployment is configured for. Requirements O22-1 (the price) and O22-3 (live versus test mode) are both undecided, so this step cannot be fully specified here; what the testing report records either way is which mode ran and whether a captured payment opened a previously gated sender.
- **Screen-reader and mobile-device accessibility** pass.

Results are recorded in `docs/TESTING_REPORT.md` (Requirement 17.5).

---

## Deployment

Ten steps for `docs/DEPLOYMENT.md` (Requirement 17.3), each with the V-items it must resolve:

1. Create the Supabase project; record URL, anon key, service-role key.
2. Configure the Google OAuth client and register the callback redirect URLs for local and deployed origins, then enable the Google provider in Supabase (V23). No SMS provider is configured, and none is needed (Requirement 1.10).
3. Run `supabase/migrations/*` in order; assert `select count(*) = 5 from disease_knowledge` (Requirement 4.1), that both buckets exist and are private (Requirement 13.5), and that RLS is enabled on all nine farmer-facing and access tables (Requirements 13.1, 21.3, 22.23).
4. Obtain `GEMINI_API_KEY` and `GROQ_API_KEY`; resolve model identifiers (V6, V8, V9, V10) and record them in `docs/API.md`.
5. Create the Telegram bot with BotFather; record `TELEGRAM_BOT_TOKEN` and the bot username; generate `TELEGRAM_WEBHOOK_SECRET_TOKEN` from a cryptographically secure source (V24).
6. Create the Razorpay account; record the key id, key secret, and webhook secret; register the payment webhook endpoint and subscribe it to the captured and failed payment events; record whether this environment is in test or live mode (Requirements 22.25, O22-3; V27).
7. Deploy to Vercel with all environment variables; confirm the permitted `maxDuration` on the plan (V16, V17).
8. Register the webhook with `setWebhook`, supplying the deployed route URL and the `secret_token` (Requirement 11.1); confirm a POST with no secret-token header returns 401 and that a real message from the bot reaches the route.
9. Smoke test the release acceptance sequence from the requirements, end to end, on a phone — payment before linking, linking before the photo, as step 6 of that sequence requires.
10. Record free-tier headroom for 6 farmers from the resolved V19 numbers.

TypeScript strict mode with zero errors is a release gate, enforced in CI (Requirement 17.8).

### Documentation deliverables (Requirement 17)

- `.env.example` — every variable name with a placeholder, no real secret, including the three Razorpay names (17.2, 22.25). `BOT_UNLOCK_PRICE` and `LINK_TOKEN_TTL_MINUTES` do **not** appear here; they are compile-time constants (Requirements 21.4, 22.4).
- `docs/API.md` — each endpoint's method, request schema, response schema, and error codes, generated from the Zod schemas so it cannot drift (17.4). The two webhook routes are documented with their authentication mechanism in place of a request schema, since neither body is Jamee's.
- `docs/DEPLOYMENT.md` — the ten steps above, the resolved values-to-verify table, the retention arithmetic (18.2), the recorded Bot_Unlock_Price (22.4), and the note that the Payment_Provider adds no fixed or recurring cost (22.26).
- `docs/TESTING_REPORT.md` — image, chat, voice, Telegram, account-linking, and payment scenario outcomes (17.5).
- `supabase/migrations/` — tables, RLS policies, buckets, and the five seed rows (17.6).

---

## Forward compatibility (deferred, not release work)

Two seams exist so the deferred requirements do not force a rewrite, and neither is built in this release:

- **Video frame analysis (Requirement 19).** `DiagnosisService` already separates "obtain image bytes" from "classify and ground". A future frame-sampling step would produce N images and reduce them to one `Diagnosis_Result` through the existing validation and grounding path. The `video-inputs` bucket is **not created** in this release.
- **Expert video calling (Requirement 20).** `needs_expert` is already persisted on every inconclusive diagnosis, so a future "request an expert" action has a query to hang off with no schema change.

*(These two were numbered 18 and 19 in the pre-amendment requirements. They are 19 and 20 now — 18 is Media Lifecycle And Retention, which this release implements.)*

Neither is designed here, tasked, or tested. They appear only to record that the release architecture does not block them.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Each property below survived a consolidation pass: overlapping acceptance criteria were merged so that no property is implied by another. Criteria classified as example, edge case, integration, or smoke during prework are covered by the testing strategy above rather than by a property here — notably transcription *quality* in Hindi and Marathi (Requirement 8.5), latency against the platform ceiling (Requirements 3.6, 10.10), the architectural single-implementation claims (Requirements 3.8, 7.7, 16.1–16.4, covered by the static architecture check), and free-tier headroom (Requirement 17.7).

Providers are stubbed at the adapter seam for every property test, so 100+ iterations cost nothing at a provider.

> **Amendment A1 — what it falsified, and how this set was repaired.** *Closed.* Every statement A1 falsified has been restated in place, keeping its number, and the four properties the amended requirements needed are now present as Properties 32 through 35. Nothing below is outstanding work. The history is kept because it explains why several of these statements read the way they do, and because a reader who meets the old wording in a test name or a commit should be able to find out what happened to it:
>
> - **Property 1** was asserted over "any valid E.164 phone number" and over resolving an inbound sender by phone. Both halves went with phone identity (**D8**). It is now stated over the Auth_User_Id as identity and `profiles.telegram_user_id` as the only resolution route (Requirements 1.4, 1.5, 1.8, 1.9, 10.2, 21.16).
> - **Property 23** asserted a GET verify-token challenge and an HMAC over the raw body. Telegram has neither (**D12**). It is now the constant-time secret-token comparison with the body unparsed, plus the `update_id` claim (Requirements 11.2–11.8).
> - **Property 24** routed by type from "a resolvable phone number" and sent "sign-in instructions" to an unresolvable one. It now uses the Telegram vocabulary and carries the third non-service outcome it lacked, the gated reply of Requirement 22.14.
> - **Property 25** asserted parity from "the WhatsApp entry point" with no entitlement guard, so as written it was unsatisfiable for a gated farmer rather than merely unexercised. It now carries the same guard **D7** took (Requirements 10.7, 10.13).
> - **Property 20** was correct in substance and wrong in vocabulary: the interleaving is web and Telegram. It is now stated that way, and over a farmer who holds a Bot_Entitlement, because a gated update reserves no quota unit at all and so cannot be one of the interleaved requests.
> - **Property 27**'s table list predated the access tables. Tenant isolation now holds over `link_tokens`, `payment_orders`, and `bot_entitlements` as well, and over *writes* on those three, which fail rather than return zero rows (Requirements 21.3, 22.23).
> - **Property 2** and **Property 28** were not falsified, only incomplete, and both are now complete: Property 2's protected surface includes the Link_Token and Payment_Order endpoints (Requirements 21.1, 22.3), and Property 28 carries the per-caller webhook bound of Requirement 13.9 (**D16**).
> - **Property 17** was listed here as wrong in vocabulary alongside Property 20, and on inspection it was not. Its statement says "either channel" and "the channel value supplied to the service", names no provider and no phone number, and needed no change. It is left exactly as written; this entry is kept so the correction is not silently lost.
>
> The four properties the amended requirements needed and this set did not contain are now present: **Property 32** (link-token single use), **Property 33** (entitlement-gate totality), **Property 34** (payment-webhook authenticity and idempotency), and **Property 35** (unlink preserves everything it should). Two linking criteria remain deliberately outside the property set and are covered by unit tests instead: the already-linked reply of Requirement 21.10 and the replacement path of Requirements 21.11 and 21.12, both of which are single named cases rather than claims over an input space.

### Property 1: Identity round-trip across channels

For any `auth.users` row, after a first authenticated session is established for it through Google sign-in, a Profile exists whose id equals that Auth_User_Id and whose email equals that account's Google email; for any Telegram user id bound to that Profile by the linking flow, resolving that Telegram user id the way an inbound Telegram update resolves its sender returns that same Profile, and a Telegram user id stored on no Profile resolves to no Profile at all; at most one Profile carries any given Telegram user id; and for any display name and any supported language written to that Profile, reading it back returns the same values. No phone value takes part in any of these resolutions, and the bootstrap stores none.

**Validates: Requirements 1.4, 1.5, 1.8, 1.9, 10.2, 21.16**

### Property 2: The authentication gate covers the whole protected surface

For any protected surface — the diagnosis, chat, voice, and history screens, and the diagnosis, chat, voice, history, Link_Token minting, and Payment_Order endpoints — and any request body, a request carrying no valid session results in the sign-in screen for a screen and HTTP 401 for an endpoint, with no domain service invoked, no Link_Token minted, and no Payment_Order created with the Payment_Provider or recorded. The payment webhook route is not on this surface and is the sole exception: it carries no session by design and is authenticated by signature verification alone (Property 34).

**Validates: Requirements 1.6, 1.7, 21.1, 22.3**

### Property 3: Client-side media admission is exactly the stated limits

For any candidate image characterized by (MIME type, byte size), the uploader accepts it if and only if the type is `image/jpeg`, `image/png`, or `image/webp` and the size is at most 10 MB; for any candidate recording characterized by (duration, byte size), the recorder accepts it if and only if the duration is at most 120 seconds and the size is at most 10 MB. Every rejection states the accepted types or duration limit and the size limit.

**Validates: Requirements 2.3, 2.4, 8.2, 8.3**

### Property 4: The upload boundary never carries media bytes and never runs ahead of a failed upload

For any accepted image or recording of any size within the limits, the request body subsequently sent to the API layer contains no media bytes, carries a storage reference, and stays below the platform request-body ceiling independently of the media size; and for any upload failure, an upload error is reported and no diagnosis or voice request is sent for that file.

**Validates: Requirements 2.1, 2.7, 8.1, 15.5**

### Property 5: Ownership is proven before anything is spent

For any storage reference and any authenticated caller, analysis begins only if the reference names the expected bucket and its first path segment equals the caller's user id; otherwise the response is HTTP 403, the caller's quota counter is unchanged, and no provider call is made.

**Validates: Requirements 2.5, 2.6**

### Property 6: Model output validation accepts exactly the well-formed, in-knowledge-base responses

For any provider response string, the validation layer accepts it if and only if it parses as JSON, contains every required field of the diagnosis schema, carries a confidence value within the closed interval 0 to 1, carries a severity within the defined severity values, and — when its status is identified — names one of the five verified conditions; nothing rejected is ever persisted or returned to a caller.

**Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6**

### Property 7: Every rejection is attributable and its content is discarded

For any rejected provider response, a usage log row records a rejection reason that distinguishes its cause, and no token originating from the rejected content appears anywhere in the response returned to the farmer.

**Validates: Requirement 5.7**

### Property 8: All non-identified outcomes collapse into one inconclusive shape

For any cause of a non-identified diagnosis — an out-of-knowledge-base condition name, an unclear image, an image with no plant, or a response that fails schema validation — the result has status `unknown`, `needs_expert` true, a null disease name, no knowledge payload, severity `none`, an explanation recommending an agricultural expert, and no treatment sentence from any knowledge base row.

**Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**

### Property 9: An inconclusive result costs exactly one unit and no extra model call

For any request that yields an inconclusive result, exactly one image-analysis unit is added to the farmer's daily counter, exactly one classification attempt is made, and no model call is issued after the result is determined inconclusive. A transport-level fallback retry of that single attempt (Requirement 14.4) is the one permitted second invocation, and it never re-asks the model for different content.

**Validates: Requirements 6.6, 6.7**

### Property 10: Identified results are grounded only in the matching knowledge base entry

For any verified condition and any supported language, an identified diagnosis reports exactly one condition, its explanation is generated from a request that contained only that condition's knowledge base row together with a rephrase-only instruction, and the explanation introduces no other verified condition name and no agricultural term absent from that row.

**Validates: Requirements 3.2, 3.5, 4.3, 4.5**

### Property 11: Chat answers are grounded only in resolved knowledge base entries

For any farmer question that resolves to a non-empty set of knowledge base rows, the answer is generated from a request containing only those rows plus a rephrase-only instruction, and the answer introduces no verified condition outside the resolved set.

**Validates: Requirements 4.4, 4.5**

### Property 12: A healthy classification carries no treatment content

For any diagnosis identified as Tomato Healthy, the result has severity `none`, reports a healthy crop, and contains no treatment sentence from any knowledge base row.

**Validates: Requirement 3.4**

### Property 13: The canonical disease name is language-invariant

For any verified condition and any supported language, the canonical disease name appears verbatim in its Latin-script canonical form in the farmer-facing output, unchanged across all three languages.

**Validates: Requirements 4.6, 9.4**

### Property 14: Questions outside verified knowledge yield an honest referral

For any question about a crop or condition outside the verified conditions, and for any question whose knowledge base resolution set is empty, the answer states the limits of Jamee's coverage or its lack of verified information, recommends consulting an agricultural expert, sets `needsExpert` true, and contains no treatment content.

**Validates: Requirements 4.7, 7.6**

### Property 15: Conversation context is complete for its conversation and isolated from every other

For any two conversations belonging to any farmers, with arbitrarily interleaved message and diagnosis timestamps, the context assembled for one conversation contains that conversation's most recent diagnosis and only messages belonging to that conversation.

**Validates: Requirements 7.1, 7.2**

### Property 16: Subject-less follow-ups resolve to the latest diagnosis on either channel

For any conversation on either channel that contains at least one diagnosis, and any follow-up question with no explicit subject, the resolved subject is the condition of the most recent diagnosis in that conversation.

**Validates: Requirements 7.3, 10.8**

### Property 17: Conversation and message persistence round-trips, carrying the channel

For any chat exchange, exactly one farmer message and one Jamee answer are persisted in the same conversation with the correct roles; for any diagnosis request submitted without a conversation identifier, a conversation is created and the diagnosis references it; and for any operation on either channel, every persisted row records the channel value supplied to the service.

**Validates: Requirements 3.3, 7.4, 7.5, 16.5**

### Property 18: The voice pipeline preserves the transcript and handles an empty one

For any non-empty transcript, that exact text is passed to the chat service as the farmer message and the response returns both the transcript and the text answer; for any transcript that is empty or only whitespace, the response asks the farmer to record the question again in a quieter place and no chat answer is produced.

**Validates: Requirements 8.4, 8.6, 8.7**

### Property 19: Language codes propagate, and unsupported codes are refused at the edge

For any request originating after a language selection, the selected supported language code is present in the request; for any response to such a request, the response's language field equals the requested code and its script class matches that language; and for any language code outside `en`, `hi`, `mr`, the API returns HTTP 400 naming the three supported codes.

**Validates: Requirements 9.2, 9.3, 9.5, 9.6**

### Property 20: Daily quotas are never exceeded and are shared across channels

For any interleaving of web and Telegram requests of one operation type by one farmer within one Asia/Kolkata day, including concurrent requests, the number of requests that reach a provider never exceeds that operation's daily limit; every request beyond the limit is declined with the limit and the reset time stated and invokes no provider; and the accepted count is identical regardless of how the requests were distributed between channels. The Telegram side of the interleaving is drawn from a farmer who is linked and holds a Bot_Entitlement, because a gated update reserves no quota unit at all (Property 33) and so is not a request this property can count.

**Validates: Requirements 14.1, 14.2, 14.3**

### Property 21: The fallback chain either serves the request or reports the busy message

For any operation whose primary provider fails with a rate-limit or unavailability error, the request is retried on the fallback provider when the capability has one; for any operation whose provider chain is exhausted — including an image-interpretation chain that has no vision fallback configured at all — the result is the `PROVIDERS_UNAVAILABLE` error, whose English rendering is exactly `Jamee is temporarily busy. Please try again shortly.`

**Validates: Requirements 14.4, 14.5, 14.8**

### Property 22: Every model operation leaves a complete audit row

For any completed model operation, exactly one usage log row records the farmer identifier, the operation type, the channel, the model provider used, and the outcome; and whenever the gateway served the request from the fallback provider, that row records the fallback.

**Validates: Requirements 14.6, 14.7**

### Property 23: The webhook rejects everything it cannot authenticate, and processes each delivery once

For any value presented in the `X-Telegram-Bot-Api-Secret-Token` header of a POST request on the webhook route, and any request body, no part of that body is parsed as an update until the header value has been compared in constant time against the configured Webhook_Secret_Token; a header that is absent, a header whose value differs from the configured token, and a configured token that is absent each yield HTTP 401 with no part of the body parsed as an update and no shared service invoked; and no other means of authenticating a delivery exists on that route. For any sequence of authenticated deliveries, including concurrent redeliveries of one `update_id`, that update is processed at most once: its `update_id` is claimed in `telegram_inbound` as a single write whose failure on an existing row *is* the duplicate signal, that claim precedes every media download, quota reservation, and shared service invocation, and every repeat is acknowledged with HTTP 200 with no service call and no quota change.

**Validates: Requirements 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8**

### Property 24: Inbound Telegram updates are routed by type and always acknowledged

For any authenticated, non-duplicate, well-formed inbound update whose sending Telegram user id resolves to a Profile holding a Bot_Entitlement, a photo is stored under that farmer's own prefix in `crop-images` and dispatched to the diagnosis service with that reference, a text message is dispatched to the chat service with the conversation identifier of that farmer's active Telegram conversation, a voice note is stored under that farmer's prefix in `voice-messages` and dispatched to the voice service, and any other message type receives a reply naming photos, text, and voice notes with no service call and no quota change. There are two further non-service outcomes: a sending Telegram user id stored on no Profile receives the linking instructions in English, no Profile having been resolved to take a preferred language from, with no service call and no quota change; and a resolved Profile holding no Bot_Entitlement receives the gated reply naming the unlock, its price, and where to pay, in that Profile's preferred supported language, also with no service call and no quota change. Every one of these deliveries is acknowledged with HTTP 200, and each reply is sent in addition to that acknowledgement rather than in place of it.

**Validates: Requirements 10.3, 10.4, 10.5, 10.6, 10.9, 10.11, 21.17, 21.19, 22.14**

### Property 25: Channel parity of diagnosis content

For any crop image and any fixed classification outcome, where the submitting farmer is linked and holds a Bot_Entitlement, a diagnosis produced through the Telegram entry point and a diagnosis produced through the web entry point carry identical status, disease name, severity, and `needs_expert` values, and are grounded in the same knowledge base row; explanation wording that differs between the two is parity and not a defect. Where the farmer holds no Bot_Entitlement the claim is not weakened, it does not apply: the gate replies and returns before the diagnosis service runs, so the Telegram side produces no Diagnosis_Result to compare, and the gated reply is the correct outcome rather than a parity failure.

**Validates: Requirements 10.7, 10.13**

### Property 26: History is complete, ordered, and detailed

For any set of diagnoses belonging to a farmer across both channels, the history list contains exactly that set, ordered by creation time descending, each entry carrying a thumbnail, the condition name or inconclusive label, the severity, the channel, and the timestamp; and for any entry selected, the detail view presents the image, the condition or inconclusive label, the confidence, the severity, the full explanation, and the related conversation messages.

**Validates: Requirements 12.1, 12.2, 12.3**

### Property 27: Tenant isolation holds across tables, storage, and the knowledge base

For any two distinct farmers, every attempt by one to read or write the other's rows in `profiles`, `conversations`, `messages`, `diagnoses`, `usage_logs`, `link_tokens`, `payment_orders`, or `bot_entitlements` returns no rows or fails; on the three access tables — `link_tokens`, `payment_orders`, `bot_entitlements` — every write attempt from a farmer session fails rather than returning zero rows, including a write against that farmer's own rows, writes there being reserved to server-side modules using the Service_Role_Key; every attempt to read or write an object under the other farmer's storage path prefix in either private bucket is denied; and for any authenticated farmer, reads of `disease_knowledge` succeed while every insert, update, and delete is denied.

**Validates: Requirements 13.2, 13.4, 13.6, 21.3, 22.23**

### Property 28: Burst rate limiting precedes any quota spend

For any burst of requests to the diagnosis, chat, voice, or Payment_Order endpoint by one farmer within one short window, requests beyond the burst allowance are refused with HTTP 429, and no refused request increments that farmer's daily quota counter, invokes a provider, or creates a Payment_Order. For any burst of requests to the payment webhook route from one caller within one window, including a burst whose signatures never verify and which therefore identifies no farmer at all, requests beyond the per-caller bound are refused, the bound is keyed on the caller rather than on a farmer, and no refused request records a Bot_Entitlement or changes any farmer's stored state.

**Validates: Requirements 13.8, 13.9**

### Property 29: The error envelope is total, localized, and leak-free

For any error code in the taxonomy and any supported language, the response carries that stable code with a non-empty farmer-readable message in that language and an accurate retryable flag that drives a retry action; and for any error thrown anywhere in the API layer, including errors carrying stack traces or provider payloads, the response body contains no stack trace fragment and no provider payload fragment.

**Validates: Requirements 15.3, 15.4, 15.6**

### Property 30: Deliverable completeness over the environment and endpoint sets

For every key in the server environment schema, `.env.example` lists that key with a placeholder and no live credential value; and for every registered API route, the API documentation records its HTTP method, request body schema, response body schema, and error codes.

**Validates: Requirements 17.2, 17.4**

### Property 31: Tenant isolation holds over deletion

For any batch of retention candidates drawn from any number of distinct farmers, every object path the sweep hands to a delete is a path it read off a row, under the path prefix of that row's own `user_id`; a single candidate whose path is not under its own row's prefix ends the invocation with no deletion issued at all and no row stamped; every deletion-instant stamp is anchored on both that row's id and that row's `user_id` and writes no other column; and for a candidate that has no owning row — the orphan backstop, whose only tenant anchor is the path's own first folder — a path with no usable owner folder is refused rather than deleted, and no path outside the ones storage reported is ever deleted.

**Validates: Requirement 18.8**

This statement was **reconstructed**, not originally authored here. The number entered the design with the media-lifecycle amendment, which closed its RLS discussion with a forward reference only ("Property 31 states it over deletion") and no entry; task 35.2 supplied the title. The statement above was derived from Requirement 18.8 and the three deletion anchors in "How the sweep finds its work", and claims nothing beyond them. The reconstruction and its reasoning are recorded in the header of `tests/property/deletion-isolation.property.test.ts` and in `docs/TESTING_REPORT.md` §1.1.

### Property 32: A link token binds at most once, and an invalid one binds not at all

For any minted Link_Token and any interleaving of `/start` deliveries carrying it — including two simultaneous deliveries of that one valid token, which Telegram's redelivery on a non-200 and a farmer's second tap both produce — at most one binding of a Telegram user id to that token's Profile occurs and the token ends consumed, the bind and the consume being one conditional write whose returned row *is* the authorization, so a delivery that loses the race writes no `telegram_user_id` and the profile never ends up carrying a different sender's id than the one that won. For any `/start` payload that matches no recorded token, matches an expired token, or matches an already consumed token, no `telegram_user_id` is stored, no Profile changes, and the reply is identical across all three cases, so the bot reveals nothing about which case it was in. For any valid token whose sending Telegram user id is already stored on a Profile other than that token's Profile, neither Profile changes, the token is left unconsumed, and the reply states that the Telegram account is linked elsewhere and has to be unlinked there first — a failed binding, never a transfer. Across every one of these outcomes, handling a `/start` command invokes no shared service, reserves no quota unit, and leaves that farmer's daily limits unchanged.

**Validates: Requirements 21.5, 21.6, 21.7, 21.8, 21.13, 21.14, 21.18**

### Property 33: The entitlement gate is total over update kinds

For every kind of inbound update the Telegram adapter can dispatch on, an authenticated, non-duplicate update whose sending Telegram user id resolves to a Profile whose Auth_User_Id holds no Bot_Entitlement invokes no shared service, reserves no quota unit, persists no Message and no Diagnosis_Result, and leaves that farmer's daily counters, Conversations, and Profile unchanged; the delivery is acknowledged with HTTP 200 and audited by its `telegram_inbound` row alone. The claim is stated over the adapter's own set of dispatchable update kinds rather than over a list of kinds written into the property, so a kind added to the adapter without a gate in front of it becomes a failing case rather than an unexercised one. Exactly three things are exempt from the gate and nothing else is: the `/start` exchange of Requirement 21, the linking instructions sent to a sender stored on no Profile, and the gated reply itself. For that same unentitled farmer, the web application and the diagnosis, chat, voice, and history endpoints behave exactly as they do for a farmer who holds a Bot_Entitlement.

**Validates: Requirements 22.13, 22.14, 22.15, 22.16, 22.17**

### Property 34: No entitlement without a verified signature, and one payment grants exactly once

For any raw body and any signature header presented on the payment webhook route, no part of that body is parsed as payment data and no Bot_Entitlement is recorded unless the signature verifies in constant time over the exact raw request body bytes against the configured payment webhook secret; a missing signature header, a signature that does not verify, and an absent configured secret each yield HTTP 401 with nothing parsed and nothing recorded, the absent configuration falling into the same failure branch as a wrong signature rather than into a skip; and no browser-reported checkout success records a Bot_Entitlement, the paying farmer, the amount, and the outcome being derived only from a verified payload together with the recorded Payment_Order. For any verified webhook reporting a captured payment against a recorded Payment_Order, and for any number of redeliveries of that one payment identifier in any order, including concurrent redeliveries and redeliveries interleaved with other payments' deliveries, exactly one Bot_Entitlement exists afterwards — recorded against that Payment_Order's Auth_User_Id, carrying the provider's payment identifier and the grant instant, and carrying no expiry — and every redelivery beyond the first is acknowledged with HTTP 200 and changes no stored state; the claim on the payment identifier is a single write whose failure is the duplicate signal, never a read followed by a write. For any number of distinct captured payment identifiers arriving for one Auth_User_Id, at most one Bot_Entitlement exists for that farmer. For any verified webhook reporting a failed payment, no Bot_Entitlement is recorded and that farmer's Profile, daily limits, Conversations, Messages, and Diagnosis_Results are unchanged.

**Validates: Requirements 22.5, 22.6, 22.7, 22.8, 22.9, 22.10, 22.11, 22.12, 22.21**

### Property 35: Unlink preserves everything it should

For any farmer whose Profile holds a Telegram user id, any set of that farmer's outstanding Link_Tokens, and any set of Conversations, Messages, and Diagnosis_Results that farmer created through either channel, an unlink performed from that farmer's authenticated session leaves `profiles.telegram_user_id` null, leaves every one of those outstanding Link_Tokens unusable for a later binding, and leaves that farmer's Bot_Entitlement and every one of those Conversations, Messages, and Diagnosis_Results exactly as they were, along with every other column of the Profile. After the unlink the Web_App presents that Bot_Entitlement as active and offers the linking action rather than a further Payment_Order; a subsequent binding under a fresh token — of the same Telegram user id or of a different one — is served under the photo, text, and voice handling of the Telegram channel with no further payment and no new Payment_Order; and the released Telegram user id, being stored on no Profile, is free to bind to any Profile. Unlinking followed by re-linking therefore costs nothing and loses nothing.

**Validates: Requirements 21.14, 21.15, 22.18, 22.19, 22.20**
