# Jamee — engineering handoff

Read this once, then work from `.kiro/specs/jamee-crop-disease-detection/{requirements.md,design.md,tasks.md}`. Those three are the authority; this file is the map. Where they disagree with each other, this document says so.

Everything below was checked against the repository on the date of writing. Claims that could not be verified are marked **UNVERIFIED**.

---

## 1. What Jamee is

AI-assisted crop disease guidance for smallholder farmers, reachable from two channels — a Next.js web app and WhatsApp — behind one identity.

A farmer signs in with a phone number and an SMS one-time passcode, photographs a diseased tomato or potato leaf, and gets back a possible condition, a severity, a confidence value, and a plain-language explanation in English, Hindi, or Marathi. They can then ask follow-up questions by text or by voice note, in the same conversation, and the answer resolves against the photo they just sent. The same three things work by messaging the business WhatsApp number from the same phone, and both channels appear in one history list on the web.

Two constraints shape almost every design decision:

- **Nothing agricultural is invented.** Jamee trains no model. A general-purpose multimodal model proposes a candidate condition from the image; a five-row, human-verified knowledge base (`disease_knowledge`) supplies every symptom, cause, treatment and prevention statement a farmer reads; the model is used only to rephrase verified rows into the farmer's language. A candidate outside those five rows is discarded and the farmer gets an inconclusive result recommending an agricultural expert. The five rows are Tomato Early Blight, Tomato Late Blight, Tomato Healthy, Potato Early Blight, Potato Late Blight (Requirement 4.1).
- **₹0-first.** Free tiers of Vercel and Supabase, sized for 5–6 pilot testers. Gemini is primary for vision and text, Groq is the fallback and the only transcriber. A 1 GB storage allowance and a 5 GB monthly egress allowance are the binding dimensions, which is why images are re-encoded in the browser toward ~400 KB, why list views read a thumbnail derivative, and why Requirement 18 defines a 7-day retention window after which full-size originals are deleted and the diagnosis row is kept.

Supabase provides auth (phone OTP), Postgres with RLS, and two private storage buckets. Requirement 17.7's free-tier claim is stated **conditionally** on browser re-encoding and a bounded retention window — do not quote it unconditionally.

---

## 2. Getting it running

Node `^22.12.0 || >=24.0.0`. Docker Desktop must be running before the Supabase step.

```powershell
npm install

# Local Supabase stack. Applies supabase/migrations in order on a fresh container.
npx supabase start
npx supabase db reset      # re-applies migrations + seeds; safe on a stack you own

# Fill in .env.local. Copy .env.example and read it — it documents every value's source.
# Regenerate the Supabase values verbatim with:
npx supabase status -o env

npm run dev                # http://localhost:3000
```

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | `next dev` |
| `npm run build` | `next build`. Succeeds with zero environment configured — every page and route is dynamic and `env.ts` validates on first use |
| `npm start` | `next start` |
| `npm run lint` | `eslint .` |
| `npm run typecheck` | `tsc --noEmit`, strict mode. Requirement 17.8's literal gate |
| `npm test` | `vitest run` — all three projects |
| `npm run test:unit` | the `unit` project (jsdom): `src/**/*.test.{ts,tsx}` + `tests/unit/**` |
| `npm run test:property` | the `property` project (node): `tests/property/**` |
| `npm run test:integration` | the `integration` project (node, serial): `tests/integration/**`. Self-skips without `JAMEE_TEST_DATABASE_URL` |
| `npm run check:secret-scope` | static guard: secrets stay server-side, `process.env` behind one door, service-role queries anchored |
| `npm run check:shared-implementation` | static guard: exactly one diagnosis and one chat implementation, one-way layering, no-training denylist |
| `npm run check:deployment` | asserts a **live** deployment is correct. Exits 1 on an unconfigured machine by design. Never run against a real project — see §6 |

### Three environment traps

Each of these cost real debugging time. None of them is discoverable from the code alone.

**1. Vitest does not read `.env.local`.** Vite's `loadEnv` filters by `envPrefix`, which defaults to `VITE_`, so nothing in `.env.local` reaches `process.env` during a test run. The integration project needs the variables exported into the shell first:

```powershell
Get-Content .env.local |
  Where-Object { $_ -match '^\s*[A-Z_]+=' } |
  ForEach-Object { $n,$v = $_ -split '=',2; [Environment]::SetEnvironmentVariable($n.Trim(), $v.Trim()) }

npm test
```

Without it, `npm test` is still green — the integration project reports 104 tests **skipped**, which looks like coverage and is not. That is exactly the failure mode the CI workflow's zero-tests assertion exists to catch.

**2. This repo's local stack runs on `553xx`, not the documented `543xx`.** Another local Supabase project (`accmount`) owned the whole default range on the original machine, so Jamee moved: every port is its default with the leading `543` rewritten to `553`. `[api] 55321`, `[db] 55322`, `[studio] 55323`, mail `55324`, analytics `55327`, shadow `55320`.

`supabase/config.toml` is committed with those ports. (Its own header comment describes the file as "untracked by default" — that was true of the CLI's default behaviour, not of this repository. The file is tracked.) `docs/DEPLOYMENT.md` and `.env.example` document the standard port and are correct for a normal machine.

A fresh machine can move the ports back. The only hard requirement is that `config.toml` and `.env.local` agree:

| `.env.local` | must match |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` port | `[api] port` |
| `JAMEE_TEST_DATABASE_URL` port | `[db] port` |

If they disagree, nothing errors and nothing warns — the tests quietly talk to whatever stack owns that port, and a `db reset` against a wrong `JAMEE_TEST_DATABASE_URL` destroys another project's data.

**3. `supabase/config.toml` sets `[auth.sms] enable_signup = true`.** `auth.admin.createUser` refuses a `phone` on some stacks unless the phone provider is on, and every integration fixture needs one: `profiles.phone` is `not null` and 0002's trigger copies it from the auth user. `[auth.sms.twilio] enabled` stays `false`, so nothing is ever sent. This is local only — the hosted project needs the phone provider enabled in the Supabase dashboard separately (`docs/DEPLOYMENT.md` step 2), and that is a paid dependency.

---

## 3. Architecture

### Layout

```
src/
  app/                     routes; server components by default
    page.tsx               sign-in / landing
    diagnose/  chat/  voice/  history/  profile/
    diagnosis/[id]/        detail view (Requirement 12.3)
    diagnosis/detail.ts    its data loading, extracted so it is testable
    auth/callback/         route.ts (session exchange) + ensure-profile.ts (D8, toE164)
    api/diagnose  api/chat  api/voice  api/whatsapp
    api/internal/retention-sweep       GET (cron) + POST (manual), CRON_SECRET only
  components/              client components; one .module.css and one .test.tsx each
  services/                the shared, channel-agnostic business logic
    diagnosis.service.ts   the ONE image-analysis implementation (Req 16.3)
    chat.service.ts        the ONE grounding/rephrase implementation (Req 16.4)
    voice.service.ts  quota.service.ts  conversation.service.ts  retention.service.ts
  lib/
    ai/gateway.ts          capability routing, fallback chain, deadline arithmetic
    ai/capabilities.ts  ai/errors.ts
    api/                   authenticated-route.ts (the 401 gate), request-body.ts
    auth/protected-paths.ts
    config/verified.ts     compile-time constants, each tied to a V-item
    config/media.ts        retention days, downscale targets, sweep flags
    db/                    whatsapp-inbound.ts (idempotency), usage-log.ts
    supabase/              client.ts (browser) · server.ts (RLS session) · admin.ts (service role)
    messages/              static en/hi/mr catalogs (D5) + types.ts
    gemini.ts  groq.ts     provider adapters — the mocking seam
    whatsapp.ts            verify, parse, media, send (V12–V15)
    whatsapp-dispatch.ts   inbound routing, budget, reply formatting
    schemas.ts  knowledge.ts  prompts.ts  storage.ts  errors.ts  rate-limit.ts
    time.ts  language.ts  language.server.ts  history.ts  profile.ts  severity.ts
    env.ts                 the only door to process.env (server); env.public.ts is the other
  types/database.ts        generated Supabase types
  proxy.ts                 Next 16's middleware equivalent — the coarse auth redirect
supabase/migrations/       0001…0011, applied in order
tests/property/            31 files, one per correctness property (+ a harness smoke test)
tests/integration/         9 test files + harness modules (harness/clients/farmers/objects/providers/database)
tests/unit/                cross-cutting suites: accessibility, mobile-layout, api-docs, the check scripts
scripts/                   the three check:* gates
docs/                      API · DEPLOYMENT · PROVIDER_CAPABILITIES · TESTING_REPORT · VERIFIED_VALUES
```

Responsibilities, one line each: `app/api/*` validates the edge and owns HTTP; `services/*` owns business rules and is the only place a channel is a parameter; `lib/*` is stateless mechanism; `lib/db/*` and `lib/supabase/*` own persistence. **`src/services/**` and `src/lib/**` never import from `src/app/**`** — `check:shared-implementation` enforces that, and it is what keeps "exactly one implementation" true over time.

> Note: `design.md`'s *Project structure* tree is partly aspirational. `src/types/domain.ts` and `src/types/api.ts` do not exist; `src/lib/config/`, `src/lib/db/`, `src/lib/api/`, `src/lib/auth/`, `src/app/api/internal/retention-sweep/`, `src/proxy.ts` and migration `0011` are all real and absent from it. Trust the listing above.

### Path A — a web photo diagnosis

1. **`src/components/ImageUploader.tsx`** — `admissionCode()` checks the *selected* file against Requirement 2.3/2.4 (jpeg/png/webp, ≤10 MB) **before** any re-encoding. Then `encodeCropImage()` re-encodes toward `DOWNSCALE_TARGET_BYTES` (400 KB) with a quality ladder capped at 1600 px, and produces a `.thumb` derivative at 320 px.
2. `submitCropImage()` uploads both objects with `browserObjectUploader()` straight to the `crop-images` bucket at `{user_id}/{YYYY}/{MM}/{uuid}.{ext}`. A failed thumbnail does not block the diagnosis (Requirement 2.14); a failed full-size upload sends no request at all (Requirement 15.5).
3. **`POST /api/diagnose`** (`src/app/api/diagnose/route.ts`) — `authenticatedRoute()` supplies the 401 gate and the RLS-scoped client; `parseJsonBody()` validates against `diagnoseRequestSchema`. Body is ~200 bytes: a storage reference, a language code, an optional conversation id. `request.formData()` is never called anywhere in this file.
4. **`diagnose()` in `src/services/diagnosis.service.ts`** — ownership (`assertOwnership` in `lib/storage.ts`) → burst limit (`lib/rate-limit.ts`) → quota reserve (`quota.service.ts`) → signed URL → `run()` in `lib/ai/gateway.ts` for `vision-classify` → `interpret()` + the two-stage validation in `lib/schemas.ts` → knowledge-base lookup in `lib/knowledge.ts` → `text-generate` rephrase → persist the `diagnoses` row and the `usage_logs` row.
5. The route copies four fields onto the wire (`diagnosisId`, `conversationId`, `result`, `quota`) and returns `Response.json(payload)`. `provider`, `usedFallback` and `rejectionReason` stay off the wire deliberately.
6. **`src/app/history/page.tsx`** reads through `lib/history.ts` (`readHistory`, `resolveHistoryImage`), which prefers the thumbnail and falls back to the full-size original; `src/app/diagnosis/[id]/page.tsx` + `diagnosis/detail.ts` render the detail view.

### Path B — an inbound WhatsApp photo

`src/app/api/whatsapp/route.ts` has `GET` (the verify-token challenge) and `POST` (deliveries). The `POST` order is fixed and the ordering *is* the correctness argument:

1. `verifySignature()` in `lib/whatsapp.ts` — HMAC-SHA256 over the **raw** body, before any JSON parse. Fails → 401, no service invoked (Requirement 11.4). Hex and base64 are both accepted in constant time because U-V13 leaves the encoding undocumented.
2. `parseInboundPayload()` → `InboundMessage[]`. Meta may batch up to 1000 entries.
3. **Per entry**: `claimInbound()` in `src/lib/db/whatsapp-inbound.ts` inserts `whatsapp_inbound` with `status: 'received'`. A `23505` on the primary key is the duplicate signal → acknowledge, write a `duplicate_ignored` audit row, spend nothing, call nothing. This runs *before* profile resolution, and `InboundReceivedRow` structurally omits `user_id` so it cannot be reordered.
4. `resolveProfileByPhone()` in `lib/whatsapp-dispatch.ts` → `normalizeInboundPhone()` → `profiles.phone`. No profile → sign-in instructions, `rejected`, 200. Then `attachResolvedProfile()`.
5. Type outside text/image/audio → the "photos, text and voice notes" reply, `rejected`, 200.
6. `ConversationService.findOrCreateActive(userId, 'whatsapp')` — one long-running thread per farmer on this channel, so "why?" resolves to the latest diagnosis in it.
7. `processInboundMessage()` dispatches: image → `storeInboundMedia` (media id → media URL → authenticated fetch → service-role upload into `crop-images/{profile.id}/…`) → the same `diagnose()`. Text → `chat.service.ts`. Audio → `voice.service.ts`.
8. `formatDiagnosisReply()` → `sendReply()` (V15), **then** `markProcessed()`, then 200.

`processInboundBatch()` walks entries with one shared invocation budget, checking `canStartWithin()` before each.

---

## 4. Decisions that will bite you

Non-obvious choices where the natural instinct is wrong. Each was checked against the code.

**`/api/diagnose` takes a JSON storage reference, not multipart (D1).** Requirement 2.3 allows a 10 MB image; Requirement 2.7 keeps every request body under the platform's documented 4.5 MB ceiling (V16). A multipart upload cannot satisfy both. The browser uploads to Storage and posts a reference; the service reads bytes through a signed URL (Requirement 2.8). Making it multipart reintroduces an unsatisfiable pair. Same reasoning for `/api/voice`.

**`maxDuration = 60` is Jamee's budget, not the platform's.** `PLATFORM_MAX_DURATION_SECONDS = 300` is recorded in `config/verified.ts` purely as the ceiling Jamee stays under, and is never an input. `SOFT_BUDGET_FRACTION = 0.75` gives `SOFT_BUDGET_MS = 45_000`, with a 15 s terminal reserve for the audit write and the reply. Deriving a budget from 300 s would produce a 225 s wait no farmer accepts. The literal `60` is repeated in each route because Next reads segment config by static analysis; each route's test asserts the literal equals `JAMEE_MAX_DURATION_SECONDS`.

**WhatsApp is inline-then-acknowledge (D11).** `markProcessed()` runs **after** the reply is sent, **per entry**, never batch-wide, and the claim always inserts `received`. A `waitUntil` deferral or a batch-wide terminal write silently discards entries — Meta will not redeliver an acknowledged delivery, and the primary key would drop it if it did. Entries still `received` when the budget runs out are a recoverable backlog that `whatsapp_inbound_received_idx` finds. `src/lib/db/whatsapp-inbound.ts` documents the contract at length; read it before touching the batch loop.

**Phone identity — this already caused a production-blocking bug.** E.164 *with* a leading `+` in `profiles.phone` is the single cross-channel identity (Requirement 1.5), enforced by `profiles_phone_e164 check (phone ~ '^\+[1-9][0-9]{7,14}$')`. Supabase Auth stores the number **without** the `+`, and Meta's `wa_id` also has no `+`. Three places must agree:

| Place | Function |
| --- | --- |
| `supabase/migrations/0002_profiles.sql` | `handle_new_user()` trigger |
| `src/app/auth/callback/ensure-profile.ts` | `toE164()` |
| `src/lib/whatsapp-dispatch.ts` | `normalizeInboundPhone()` |

The worked example, from commit `5d4aca2`: `handle_new_user()` copied `auth.users.phone` verbatim. A signup sent `+919876500011`; GoTrue stored `919876500011`; the check constraint refused it; the trigger raised *inside GoTrue's own insert transaction* and aborted it. **Every phone-OTP signup would have failed** — Requirement 1.1, the first step of the release acceptance sequence. 1,676 unit and property tests could not see it, because it lives in the seam between two systems neither of them runs. It surfaced on the first integration run, and even then it was masked: the harness's test password was two UUIDs joined by a hyphen, 73 bytes, one over bcrypt's 72-byte ceiling, which panicked the auth container into a bare 500. The fix normalizes in the trigger rather than widening the constraint, because a `+`-less number is not E.164 and two disagreeing normalizers would give one farmer two identities. `ensure-profile.test.ts` reads the separator class and the E.164 pattern back out of the `.sql` file, so a divergence is a failing test.

**Inconclusive is a success.** A 200 carrying `result.status: 'unknown'`, `diseaseName: null`, `confidence: null`, `severity: 'none'`, `needsExpert: true`, `knowledge: null`, and static localized copy. It has no error code. All seven rejection reasons (bad JSON, missing field, out-of-range confidence, bad severity, out-of-KB name, unclear photo, no plant) collapse into that one shape (D3, Requirement 6.4), each with its own logged `rejection_reason`. It **spends its image unit** (Requirement 6.7) and issues **no additional model call** (Requirement 6.6). Modelling it as an error breaks both the single-shape rule and the quota rule.

**Model ids and platform limits are compile-time constants**, in `src/lib/config/verified.ts`, each annotated with the V-item in `docs/VERIFIED_VALUES.md` that resolved it. Never environment variables — a model id in an env var is an unversioned, unreviewable change to Jamee's behaviour. `VISION_FALLBACK_MODEL` is typed `string | null` on purpose: Groq's vision models are Preview tier, so running with no vision fallback has to stay expressible, and Requirement 14.8's single exhausted-chain branch keeps farmer-visible behaviour identical either way. The only permitted override is `WHATSAPP_API_VERSION`, an escape hatch for Meta deprecating the pinned `v26.0` faster than a code change can ship.

**Quota is reserve-then-refund.** The rule is a biconditional: a unit is spent **iff** at least one provider call was attempted. An out-of-scope or unanswerable chat question is answered from the repository's own pre-translated copy with zero provider calls, so step 4's referral branch refunds the reservation and the audit row records `quota_spent = false`. `chat.service.ts` flags that this is read off the biconditional rather than off an explicit acceptance criterion, and that the design's step 9 enumerates only failures as refundable — the disagreement is recorded, not silently resolved. The control for cheap out-of-scope questions is Requirement 13.8's burst limiter, not the daily counter. A refund is a no-op on an inherited reservation, so a referral produced *inside* a voice request hands back nothing (a transcription really happened).

**Providers are mocked at the ADAPTER seam, never at the gateway.** Three seams: `GeminiAdapterDeps.create`, `GroqAdapterOptions.create`, `GroqTranscribeOptions.create` (`tests/integration/providers.ts`). Everything above them stays real — request construction, the fallback chain, deadline arithmetic, validation, persistence, RLS. Mocking the gateway would make the Requirement 14.4/14.8 fallback assertions statements about the harness instead of about the code.

**Storage buckets are private and the path's first folder is the owner's user id.** `0009_storage_buckets_policies.sql` inserts `crop-images` and `voice-messages` with `public = false`, asserts loudly if either already exists as public, and predicates all four policies on `(storage.foldername(name))[1] = auth.uid()::text`. That is why the object path convention `{user_id}/{YYYY}/{MM}/{uuid}.{ext}` is load-bearing rather than cosmetic — including on the WhatsApp path, where the service-role upload keeps the `{profile.id}/` prefix so the object is readable later by that farmer's own web session.

Others worth knowing:

- **`usage_logs` is append-only audit, not the quota source of truth (D10).** Quota lives in a separate counter table with an atomic function (`0007`). Rows are not 1:1 with quota units — validation rejections and fallbacks are recorded there too.
- **`src/lib/env.ts` is the only server door to `process.env`**, `src/lib/env.public.ts` the only browser one. `env.ts` opens with `import 'server-only'`, so importing it from a client component is a build error, and it validates per-key at **first use** rather than at import — a module-scope parse would fail `next build`, where production secrets are legitimately absent. `check:secret-scope` fails CI on `process.env` in any third file. `env.public.ts` must use literal `process.env.NEXT_PUBLIC_X` reads because Next inlines them by static textual substitution; a computed lookup reads `undefined` in the browser.
- **Inconclusive, quota and error copy are pre-translated static strings (D5)**, because Requirement 6.6 forbids a model call for an inconclusive result and 14.3 forbids one when a quota is exhausted. `messages(language)` has no `?? en` fallback — a silent fallback would show a Marathi farmer English and read as working software.
- **Channel parity means one code path and identical structured fields, not identical prose (D7).** `status`, `diseaseName`, `severity`, `needsExpert` must match; explanation wording may differ between two runs of the same image on either channel.
- **`DIAGNOSIS_TIMEOUT` never reaches a chat or voice farmer.** Its copy tells them to resend a photo. `chat.service.ts` degrades to the grounded static template and records `timeout` in the audit; `voice.service.ts` translates it to `TRANSCRIPTION_FAILED`. Adding a code path that surfaces it on those routes is a regression with tests guarding it.
- **The retention sweep is `GET` **and** `POST` behind one secret.** V21 found the Vercel scheduler only issues `GET` and only injects `Authorization: Bearer <CRON_SECRET>`, so the design's sketched `POST` + custom header could not have been triggered at all. `GET` is the cron path, `POST` the documented manual one. A valid farmer session grants nothing here (Requirement 18.13).

---

## 5. What is done

**107 of 109 task items in `tasks.md` are complete.** The two open ones are tasks 33 and 34, both deferred by the requirements. (Top-level tasks are numbered 1–35 — 35 sits out of order between 27 and 28 — plus 74 sub-tasks.)

> **If the Kiro task tooling shows you 161 items, 155 complete, 6 remaining, this document is not wrong.** The two counts measure different things and both are correct under their own definition. `tasks.md` marks a test sub-task with a `*` immediately after the checkbox — `- [x]* 3.5 Write property test for …` — and because there is no space after the `]`, GitHub-flavoured Markdown does **not** render those as checkboxes. There are 52 of them (48 complete, 4 open), and the tooling counts them as entries while the rendered document does not: 161 − 52 = **109**, and 155 − 48 = **107**. The 4 open ones are `33.1`, `33.2`, `34.1` and `34.2` — the optional sub-items of the two deferred tasks — which is the whole of the difference between "6 remaining" and "2 open". Neither number needs correcting; quote whichever one you say you are quoting.

- **All non-deferred requirement scope is implemented.** `requirements.md` contains **20** requirements; 1–18 are release scope and 19–20 are marked DEFERRED.
- **All 31 correctness properties in `design.md` are asserted**, one file per property in `tests/property/` with no gaps, plus `harness.test.ts`. Property 31 was reconstructed from Requirement 18.8 rather than independently authored — `design.md` says so beneath the entry.
- **Six checkpoint tasks passed**: phases 1–5 (tasks 7, 14, 17, 20, 23) and a final release-readiness gate (task 32).

### Gates, measured on this machine

| Gate | Command | Result |
| --- | --- | --- |
| TypeScript strict | `npm run typecheck` | **exit 0**, zero errors |
| Lint | `npm run lint` | **exit 0**, zero errors, zero warnings |
| Build | `npm run build` | **exit 0**; 14 routes, all dynamic, plus the proxy |
| Tests | `npm test` | **95 files / 1780 tests, all passing**, 23 s |
| Secret scope | `npm run check:secret-scope` | **PASS** |
| Shared implementation | `npm run check:shared-implementation` | **PASS** |
| Integration | `npm run test:integration` | **104/104 across 9 files** |

Per project:

| Project | Files | Tests |
| --- | --- | --- |
| `unit` | 55 | 1559 |
| `property` | 31 | 117 |
| `integration` | 9 | 104 |
| **total** | **95** | **1780** |

The integration run requires the live local stack **and** the exported-env one-liner from §2.

**The integration suite passed for the first time only in commit `5d4aca2`.** Before that it self-skipped for want of a `JAMEE_TEST_DATABASE_URL`, and a green `npm test` meant "the integration project did not run". That is exactly why it still carried two live defects of its own: the 73-byte bcrypt password described in §4, and a `whatsapp_inbound` filter in `whatsapp-scenarios.test.ts` written in the `+`-prefixed E.164 form while `claimInbound()` stores Meta's `wa_id` verbatim — it matched zero rows and was therefore unfalsifiable rather than failing. Treat "written but never executed" as uncovered.

---

## 6. What remains, and how to add it

Ordered by what blocks a release.

### 6.1 Deployment configuration — blocker

Ten required variables. The authority is `serverEnvSchema` + `OPTIONAL_SERVER_ENV_KEYS` + `ALL_ENV_KEYS` in `src/lib/env.ts` and `PUBLIC_ENV_VARS` in `src/lib/env.public.ts`, not this table and not `.env.example`'s prose. `ALL_ENV_KEYS` is exported so Property 30 compares against the schema.

| Variable | Scope | Where it comes from |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | **browser** | Supabase → Project Settings → Data API → Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | **browser** | Supabase → Project Settings → API keys. Set this *or* the legacy name below |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser | Legacy name (V1). Only needed when the publishable name is unset; `publicEnv()` prefers publishable |
| `SUPABASE_SERVICE_ROLE_KEY` | server | Supabase → Project Settings → API keys → `service_role` |
| `GEMINI_API_KEY` | server | Google AI Studio → Get API key. The `@google/genai` SDK reads this exact name itself (V6) |
| `GROQ_API_KEY` | server | Groq Console → API Keys. Real keys start `gsk_` |
| `WHATSAPP_ACCESS_TOKEN` | server | Meta App Dashboard → WhatsApp → API Setup. A deployment needs a long-lived System User token, not the test token |
| `WHATSAPP_PHONE_NUMBER_ID` | server | Same page → "Phone number ID". Numeric id, not the display number |
| `WHATSAPP_VERIFY_TOKEN` | server | You invent it, then paste the same string into Meta → WhatsApp → Configuration → Webhook |
| `WHATSAPP_APP_SECRET` | server | Meta App Dashboard → App Settings → Basic → App secret |
| `CRON_SECRET` | server | You invent it, ≥16 chars (schema-enforced, V21). The platform injects it as `Authorization: Bearer …` |

Optional: `WHATSAPP_API_VERSION` (server config, not a secret — overrides the V12-pinned `v26.0`). Test-only: `JAMEE_TEST_DATABASE_URL`, never set in production.

**Two are browser-exposed by design**: the Supabase URL and the public key. Neither carries privilege; RLS is what authorizes requests made with them.

> **The one mistake with no automated check.** The `anon`/publishable key and the `service_role` key are the same JWT shape — the difference is a role claim inside. Pasting the service-role value into a `NEXT_PUBLIC_`-prefixed variable publishes an RLS-bypassing credential to every browser. Nothing fails, nothing warns, and `check:secret-scope` cannot see it: it scans source files for secret *names*, and this is a deployment-platform value under a different name. Verify which key you copied.

### 6.2 An SMS provider — blocker, and the only paid dependency

Requirement 1.1 does not work without one. Configure it in Supabase Auth (`docs/DEPLOYMENT.md` step 2) — `[auth.sms.twilio]` in the local config is deliberately off and sends nothing. Sign-in is step 1 of the release acceptance sequence, so nothing downstream is testable until this exists. Note that **U-V2 is still open** — the exact `type` argument for `verifyOtp` on the *sign-in* path was never confirmed against a retrievable page — and this is the first place a wrong value surfaces, as "the code never verifies".

### 6.3 Pushing the schema to hosted Supabase

```
npx supabase link --project-ref <ref>
npx supabase db push
```

Three migrations to be deliberate about:

- **`0009_storage_buckets_policies.sql`** creates both private buckets and all four owner-prefix policies. It raises rather than proceeding if a bucket already exists as public — do not suppress that.
- **`0010_seed_disease_knowledge.sql`** seeds the five verified conditions with `source` populated (Requirement 4.2). The grounding logic has nothing to ground in without it, and every identified diagnosis becomes inconclusive.
- **`0002_profiles.sql` must be at the current version** — it carries the E.164 normalization in `handle_new_user()`. The pre-fix version fails every phone-OTP signup (§4).

Then run `npm run check:deployment` per `docs/DEPLOYMENT.md` step 3 (and again after step 7's webhook registration). See §6.7.

### 6.4 Tasks 33 and 34 — deferred features

Both were **deliberately deferred by the requirements**, not forgotten. `requirements.md` marks each with an explicit `> Status: DEFERRED` note and states they form no part of release acceptance.

> **Numbering conflict — read this first.** `requirements.md` numbers video frame analysis **Requirement 19** and expert video calling **Requirement 20**. `tasks.md` labels task 33 "(Requirement 18)" and task 34 "(Requirement 19)", and its sub-tasks cite `_Requirements: 18.1, 18.2_` and `19.1, 19.2`. Those are stale from an earlier numbering — Requirement 18 is Media Lifecycle And Retention, which is fully implemented. `requirements.md` is the authority.

**Task 33 — video frame analysis (Requirement 19).** Two sub-tasks: a `video-inputs` private bucket migration plus browser-direct video upload (19.1), and frame sampling ahead of the **existing** classification and grounding path, reducing N sampled frames to one `Diagnosis_Result` (19.2). The `video-inputs` bucket is deliberately not created in this release. The reuse is the point — this is a new front end onto `diagnose()`, not a second analysis implementation, and `check:shared-implementation` will fail a build that forks one.

What a new engineer has to decide: where frames are extracted (browser vs. server — the 4.5 MB body ceiling and D1's reasoning both argue for browser-side extraction with a storage reference), how many frames N is, and how N per-frame classifications reduce to one result without breaking Requirement 3.5's "exactly one primary condition" or the quota rule's "one unit per analysis". None of that is settled anywhere in the spec.

**Task 34 — expert video calling (Requirement 20).** Two sub-tasks: a peer-to-peer video session between a farmer and an available expert (20.1), and an expert-session action offered on results carrying `needs_expert` (20.2). The `needs_expert` flag persisted on every inconclusive diagnosis is **the only seam this release provides** — there is no expert model, no availability data, and no signalling anywhere in the codebase.

This is not a small job. A new engineer has to decide, at minimum: the signalling channel (Supabase Realtime is already a dependency and is the obvious candidate); whether TURN relays are needed and who pays for them, which is a real cost against a ₹0-first product; what an "available agricultural expert" *is* as a data model, including identity, authentication, scheduling and no-show handling; and how a live video session interacts with the retention and privacy rules the rest of the product is built around. Do not scope this as "wire up WebRTC".

### 6.5 Requirement 10.6 is unsatisfied for `audio/aac` and `audio/amr`

WhatsApp delivers five inbound audio containers (V14): `aac`, `amr`, `mpeg`, `mp4`, `ogg`. Groq's transcription endpoint accepts `flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm` (V10). `aac` and `amr` are in neither intersection, and no first-party Groq page says otherwise, so the accepted list was **not widened on a guess**.

Consequence, recorded rather than hidden in three places (`VERIFIED_VALUES.md`, `DEPLOYMENT.md`, `TESTING_REPORT.md` Part 4): such a voice note is refused **before the media download**, the farmer is told to type the question instead, the row is marked `rejected`, and nothing is spent.

Fixing it properly means one of: (a) finding a first-party Groq page that confirms either container and widening the V10 list with a dated citation; (b) transcoding to an accepted container server-side, which adds an ffmpeg-class dependency to a serverless function inside a 45 s budget and needs its own arithmetic; or (c) a second transcription provider for those two containers, which adds a paid dependency and a second fallback chain. What is *not* acceptable is widening the accepted list without a source — that is the exact failure the V-item rule exists to prevent.

### 6.6 Human-verification items — nothing automated can close these

`docs/TESTING_REPORT.md` is the register. Its result fields are empty by design; fill them in place.

| Group | Count | What |
| --- | --- | --- |
| Part 2, M1–M4 | 4 | real SMS passcode delivery (M1) · hi/mr transcription quality on real farmer speech with field noise (M2) · WhatsApp end-to-end from a handset including a follow-up and web-history parity (M3) · screen-reader and mobile-device pass (M4) |
| Part 3.1, MR-1…MR-6 + HI-7 | 7 | native-speaker copy review. **Do MR-1 first** — whether `फोटो` is masculine is one decision spanning ~15 strings, and reversing it later is a sweep |
| Part 3.2, D-1…D-6 | 6 | manual device pass: Devanagari clipping, font presence, 44 px tap targets at enlarged OS font, no sideways scroll at 320 px, thumb reach on a 6.7" handset, rendered contrast |
| Part 3.3, Captures A–E | 5 | empirical values that can only be observed live; procedures live in `DEPLOYMENT.md` |
| Part 5, A-1 and A-6 | 2 | acceptance steps 1 (sign in with a real SMS passcode) and 6 (the same photo through WhatsApp and web, same content) |

`tests/unit/accessibility.test.tsx` runs axe-core over sign-in, diagnose, chat, voice and history in all three languages, and prints its own limits on every run: no contrast evaluation under jsdom, tap targets and Devanagari leading only checked as declarations, and **the diagnosis detail screen is not scanned at all** because its markup is inline in an async server component. Extracting that markup into a component the scan can render is the fix, and it is a small, self-contained task.

> **`docs/TESTING_REPORT.md` is the current register, and it agrees with §5's table.** Its automated sections were regenerated against the measured run: 95 files / 1780 tests, the four scenario suites executed and green, and all 104 integration tests passed against a live local stack. What is still empty is every **human-verification result field** in Parts 2, 3 and 5 — not because the document is behind the repository, but because nobody has performed those steps. Read an empty field there as unperformed, never as unrecorded.

### 6.7 Open V-items

`docs/VERIFIED_VALUES.md` records **12** open sub-items. No V-item came back wholly unresolved; every value needed to *write* code — package names, model identifiers, endpoints, header names, error shapes, platform limits — is resolved.

| Item | What is missing | Needs |
| --- | --- | --- |
| U-V2 | the `verifyOtp` `type` for the sign-in path | the SDK's local TypeScript types, or a real sign-in |
| U-V5 | whether the canonical Supabase bootstrap function is `security definer` | Supabase's security advisor against the applied migration |
| U-V7 | whether `temperature` is accepted on the Interactions API `generation_config` | the `@google/genai` types |
| U-V10 | a maximum audio duration for Groq transcription | possibly none exists; size is the operative bound |
| U-V11 | whether Gemini sends a `retry-after` on a 429 | a real 429. Non-blocking — a backoff hint only |
| U-V12 | the field paths inside `messages[].image` / `messages[].audio` | **a real inbound delivery** (Capture A). The adapter logs `[jamee] whatsapp.media_shape.unconfirmed` rather than assuming |
| U-V13 | the `X-Hub-Signature-256` digest encoding, hex or base64 | **a real signed delivery** (Capture B). Digest length 64 = hex, 44 = base64. Both are accepted today |
| U-V19a | Gemini free-tier RPM/RPD | **an authenticated AI Studio dashboard** |
| U-V19b | Groq free-tier RPM/TPD | **an authenticated Groq account page.** The published table is Developer-plan; do not quote it as free-tier |
| U-V20 | the container `MediaRecorder` actually produces on the target Android browser | **a real handset** (Capture C) |
| U-V22a | whether `remove()` errors on a path that does not exist | **the first real sweep** (Capture E). Cannot change behaviour — only turn an error branch into dead code |
| U-V22b | whether the `storage` schema exposes a queryable object-creation timestamp | **a live project** (Capture D) |

**U-V22b is the one that leaks.** Scan 2 of the retention sweep — the age-driven orphan backstop — ships switched **off** behind `RETENTION_ORPHAN_SCAN_ENABLED = false` in `src/lib/config/media.ts`. Scan 1 is row-driven off the `diagnoses` partial index and fully satisfies Requirements 18.3 and 18.7 for every object a farmer can see. What accumulates unreclaimed is the orphan class only: an image uploaded before its diagnosis request failed, and a voice object whose transcription failed — roughly 5 MB/day, already carried as a term in the retention arithmetic, so the storage projection does not change. Resolve by reading the `storage.objects` column set on a live project, then flip one flag.

### 6.8 Smaller known issues

All verified against the repository.

- **CI has never executed.** `.github/workflows/release-gates.yml` is complete and correct-looking but there is **no git remote configured**, so no run exists. Two jobs: `Static, unit and property gates` and `Integration suite (real Supabase stack)`. A failing run does not block a merge on its own — making these gates requires a branch protection rule or ruleset on the default branch naming **both** job names as required status checks. That is a repository setting no workflow file can assert.
- **`scripts/check-deployment.ts` has never run against a live deployment** (task 28.4). With nothing configured it reports all ten assertions UNVERIFIED and exits 1 — by design, since it never reports PASS unverified. Requirement 17.6 stays unevidenced until it runs. It is deliberately not a CI gate: it needs a real project, a deployed HTTPS origin, `psql`, and `CRON_SECRET`.
- **The diagnosis detail screen is not accessibility-scanned.** See §6.6.
- **The `DIAGNOSIS_TIMEOUT` copy problem is narrower than it looks.** Chat and voice already avoid it — `chat.service.ts` degrades to the grounded template and `voice.service.ts` translates to `TRANSCRIPTION_FAILED`, both with tests. What remains open is on the **diagnosis** path: a diagnosis that needs the vision fallback may have no budget left to rephrase (`2 + 20 + 20 = 42 s` of 45 s, below `text-generate`'s 5 s floor), and today that returns `DIAGNOSIS_TIMEOUT`. `docs/PROVIDER_CAPABILITIES.md` §3 carries this as an explicit open item: the static localized knowledge-base template that already backs a failed post-generation check could serve a budget-exhausted rephrase instead, turning the timeout into a grounded answer. It was not adopted because it changes observable behaviour on a path Requirement 3.7 currently specifies as a timeout. **That is a product decision, not an implementation gap.**
- **`tests/integration/idempotency.test.ts` writes `from_phone` in the `+` form** (`harness.farmerA.phone`, lines 272 and 535) while `claimInbound()` stores Meta's `wa_id` verbatim, without the `+`. This is the same class of bug that made `whatsapp-scenarios.test.ts` unfalsifiable and was fixed there in `5d4aca2` via a single `inboundWaId()` binding. Here the rows are only inserted and read back by primary key, so nothing currently filters on `from_phone` and no assertion is silently passing — but the fixture does not match what production writes, and the moment someone adds a `from_phone` predicate it will match zero rows and look like a passing test.
- **WhatsApp-originated diagnoses have no thumbnail** (no browser on that path), so the history list renders the full-size original until the retention window elapses. Recorded, not fixed.
- **CI runs Node 24 only.** `engines` allows `^22.12.0`; a regression that appears only on 22 would pass.

---

## 7. Conventions

Match these and your code will look native.

**Comments explain WHY, and cite their authority.** Nearly every module opens with a header naming the requirements it implements, the design decision it follows, and the V-items it depends on:

```ts
/**
 * Requirements: 11.5 (a delivery whose Provider_Message_Id was already processed …),
 *               11.6 (record the Provider_Message_Id for duplicate detection)
 * Design: "Inbound processing order" step 2; "Acknowledgement versus processing" (D11)
 * Migration: `0008_whatsapp_inbound.sql` — the primary key IS the mechanism
 */
```

Inline comments justify the non-obvious choice and name the alternative that was rejected and why. A comment restating what the line does is not the house style; a comment explaining why a `select` is absent, or why detection is by SQLSTATE rather than message text, is. Where a requirement and a design note disagree, the code records the disagreement rather than resolving it silently — see the biconditional discussion in `chat.service.ts`. Property tests carry `**Validates: Requirements X.Y**`.

**Test placement.** Colocated `.test.ts` / `.test.tsx` next to the source for everything under `src/`. Separate directories for the two kinds that are not about one module: `tests/property/` (one file per numbered correctness property) and `tests/integration/` (real Postgres). `tests/unit/` holds the cross-cutting suites — accessibility, mobile layout, the API-doc consistency check, and tests of the check scripts themselves.

**Three vitest projects** (`vitest.config.ts`), each with its own environment and glob:

| Project | Env | Include | Notes |
| --- | --- | --- | --- |
| `unit` | jsdom | `tests/unit/**`, `src/**/*.test.{ts,tsx}` | fast, no I/O |
| `property` | node | `tests/property/**` | fast-check; 30 s timeout for 100+ iterations |
| `integration` | node | `tests/integration/**` | real Postgres; serial (`fileParallelism: false`); **gated, not failed**, when `JAMEE_TEST_DATABASE_URL` is absent |

`server-only` is aliased to Next's own `empty.js` so `server-only` modules are testable — without it, logic would migrate out of those modules for a tooling reason.

**Two custom gate scripts**, both in CI and both run under `node --experimental-strip-types`:

- **`check:secret-scope`** — secret names appear only in server modules and never in a file containing `'use client'`; `process.env` is read in exactly two files (`env.ts`, `env.public.ts`); every farmer-scoped service-role statement carries an explicit `user_id` predicate. Exceptions are explicit allowlists (`OPAQUE_PAYLOAD_ALLOWANCES`, `TENANT_INDEPENDENT_STATEMENTS`) — an unlisted one fails the run. Its output states its own limits, including that it defers some insert payloads to the type system, which is why it and `typecheck` must both be gates or neither proves anything.
- **`check:shared-implementation`** — exactly one `DiagnosisService` module and one `ChatService` module; route handlers and the WhatsApp adapter import them rather than reimplementing analysis, grounding or rephrasing; nothing under `src/services/**` or `src/lib/**` imports from `src/app/**`; and a denylist of provider training surfaces and training vocabulary. It also states its limits: the no-training scan is a denylist, so a hand-rolled fetch to a runtime-assembled URL would not match, and no scan can establish the provider-side fact that Gemini and Groq do not train on Jamee's requests — that lives in `docs/PROVIDER_CAPABILITIES.md`.

**One more rule that is easy to violate accidentally:** a value resolved from third-party documentation belongs in `src/lib/config/verified.ts` with its V-item, not in an environment variable. If you find yourself adding an env var for a model id, an API version, a header name, or a platform limit, you are working against the grain.
