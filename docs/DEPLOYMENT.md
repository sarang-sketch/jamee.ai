# Deploying Jamee

Requirement 17.1 (Vercel for the Web_App and the API_Layer, Supabase for auth, database and
storage) and Requirement 17.3 (Supabase project setup, SMS provider configuration, migration
execution, storage bucket creation, WhatsApp Business Cloud API configuration, and Vercel
environment variable configuration) are satisfied by this document.

**What this document is.** Nine ordered steps, plus an operational runbook and the empirical
captures a first deployment has to make. Every external account, dashboard and business-verification
step lives here as written procedure — none of it is an implementation task, and none of it can be
performed by a coding agent.

**What this document is not.** It asserts no third-party fact of its own. Every provider identifier,
endpoint, header name, platform limit and free-tier allowance below carries the V-item in
[`docs/VERIFIED_VALUES.md`](./VERIFIED_VALUES.md) that resolved it. Where a V-item is `UNRESOLVED`,
this document says so and names the step that resolves it empirically, rather than substituting a
plausible number. That file is the authority; if it and this document disagree, that file wins and
this one is wrong.

**Read [`docs/PROVIDER_CAPABILITIES.md`](./PROVIDER_CAPABILITIES.md) alongside step 4.** It holds the
capability→provider chains, the error classification, and the timeout budget arithmetic.

---

## Before you start: where secrets go, and one silent-failure hazard to know about

### Put every secret in `.env.local`, and nowhere else

Copy [`.env.example`](../.env.example) to `.env.local` and fill it in there. `.env.example` itself is
committed and must never hold a live credential.

**`.gitignore` covers every env file Next.js loads. This was once a real gap and no longer is.**
The current file is:

```
.env*
!.env.example
```

`.env*` covers every name Next.js loads — `.env`, `.env.local`, `.env.production`,
`.env.development`, `.env.test` and any `*.local` variant — and the negation keeps `.env.example`
committed, which Requirement 17.2 depends on.

**What this document used to warn about, and why the history matters.** `.gitignore` previously
listed variants (`.env`, `.env.local`, `.env*.local`) instead of using a wildcard, which left
`.env.production`, `.env.development` and `.env.test` **committable** — a secret written into any of
them was a file `git status` would offer to commit, with nothing to warn you. That is fixed, and
`.gitignore`'s own comment records why the variant-listing approach was the gap. The lesson survives
the fix: an ignore rule that enumerates names is only as good as the enumeration, and the tool that
loads those files does not consult it.

**The advice around it is unchanged.** Put every secret in `.env.local`. `.env.example` is committed
and must never hold a live credential. If you create an env file under any other name — a tool's
own convention, a nested directory, anything outside the repository root — confirm `git status` does
not offer it before you commit, because `.env*` at the root does not follow a file into a
subdirectory.

### Step 1 has a silent-failure hazard worth reading twice

Supabase's anon/publishable key and the service-role key are **both JWTs**. They look identical:
three dot-separated base64url segments. The only thing that distinguishes them is a role claim
*inside* the token, which you cannot see by looking at it.

Pasting the service-role key into `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or
`NEXT_PUBLIC_SUPABASE_ANON_KEY`) publishes an RLS-bypassing credential to every browser that loads
the app. **Nothing fails.** The app works. Sign-in works. Every query works — better than it should,
because RLS is being bypassed. There is no error to notice.

So when you copy from the API keys page, check *which row you copied from* before you paste, and
check it again after. `SUPABASE_SERVICE_ROLE_KEY` is the only variable that key belongs in. There is
no automated check for this: `scripts/check-secret-scope.ts` proves the service-role **variable
name** never reaches a client module, which is a different claim — it cannot tell that the *value*
in a `NEXT_PUBLIC_` variable is the wrong key.

---

## Step 1 — Create the Supabase project and record the keys

1. Create an organization and a project at [supabase.com](https://supabase.com). The **Free plan**
   allows 2 projects per organization (V19).
2. Choose a region close to your testers and record the database password shown at creation — it is
   not shown again.
3. **Project Settings → Data API → Project URL** → `NEXT_PUBLIC_SUPABASE_URL`.
4. **Project Settings → API keys**:
   - the publishable/anon key → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (V1 records that current
     Supabase docs use this name; a project issued before the rename gives you an anon JWT, which
     goes in `NEXT_PUBLIC_SUPABASE_ANON_KEY` instead — Jamee accepts either, publishable first);
   - `service_role`, revealed on click → `SUPABASE_SERVICE_ROLE_KEY`.

   **Re-read the hazard note above before pasting either one.**

Record all three in `.env.local`. You will paste the same three into Vercel at step 6.

---

## Step 2 — Enable phone OTP and configure the SMS provider

Jamee has exactly one authentication method: a phone number and an SMS one-time passcode
(Requirements 1.1–1.3). Phone auth on Supabase **does not work without an SMS provider** — this
step is not optional configuration, it is the step that makes sign-in possible at all.

1. **Authentication → Providers → Phone** in the dashboard, and enable it (V2). On a self-hosted or
   local stack the equivalent lives in the `auth.sms` config variables.
2. Configure one SMS provider. V2 records the supported set as **MessageBird, Twilio, Vonage and
   TextLocal** — TextLocal is community-supported. Create an account with whichever you choose,
   obtain its credentials, and enter them on the same dashboard page. This is a paid third-party
   service in every case; it is the one cost outside the free tiers, and there is no way around it
   while phone OTP is the authentication method.
3. Leave the delivery channel as SMS. V2 records that OTP can also be delivered over WhatsApp as a
   channel — Jamee does not use that: `SignInForm` calls `signInWithOtp({ phone, options: { channel:
   'sms' } })`.
4. Note the documented defaults so you do not report them as bugs: **one OTP request per 60 seconds
   per user**. V2 also records that the phone-login page states both "OTPs expire after 1 hour" and
   "must be verified within 60 seconds" without reconciling them — treat 60 s as the practical UX
   budget. Neither number is hardcoded anywhere in Jamee.

**U-V2 is resolved and needs nothing from you.** The `verifyOtp` `type` value for a sign-in OTP was
not documented; it was resolved against the pinned `@supabase/supabase-js` types as **`type: 'sms'`**
and is what `src/components/SignInForm.tsx` calls. A wrong value here would have failed immediately
and visibly at sign-in, which is why this was safe to settle in code.

**Verify before moving on:** request a code to your own phone from the dashboard's test facility or
from a local run. If no SMS arrives, the provider credentials are wrong — every later step assumes a
farmer can sign in.

---

## Step 3 — Run the migrations, then assert the knowledge base and the buckets

Ten migrations, in this order. Each depends on the ones before it, so do not reorder or skip:

| File | What it creates |
| --- | --- |
| `0001_extensions.sql` | `pgcrypto`, and the one shared `set_updated_at()` trigger function every later migration reuses |
| `0002_profiles.sql` | `public.profiles` — one row per auth user, E.164 phone as the single cross-channel identity, RLS on |
| `0003_conversations_messages.sql` | `conversations` and `messages`, with the channel recorded on persisted rows |
| `0004_disease_knowledge.sql` | the knowledge-base table, plus the constraint and unique index that make **five** the *maximum* number of rows |
| `0005_diagnoses.sql` | one row per completed image analysis, and the partial `diagnoses_retention_idx` the retention sweep scans |
| `0006_usage_logs.sql` | the append-only audit trail (not the quota source of truth) |
| `0007_counters_and_quota_fn.sql` | the `counters` table and the three functions that are the only way it is written |
| `0008_whatsapp_inbound.sql` | inbound duplicate suppression — `provider_message_id` **is** the primary key |
| `0009_storage_buckets_policies.sql` | the two private buckets `crop-images` and `voice-messages`, and the path-prefix policies |
| `0010_seed_disease_knowledge.sql` | the five verified knowledge-base rows — the *minimum* half of Requirement 4.1's "exactly five" |

Apply them with the Supabase CLI against your project, or paste each file into the dashboard's SQL
editor in numeric order.

### What 0009 creates, and why the privacy setting matters

Both buckets are created **private**. V4 records that the bucket-privacy setting is the boolean
`public` and that buckets are private by default, so "private" here means `public` is false and
every read goes through a signed URL (V3: `createSignedUrl(path, expiresIn)`, `expiresIn` in
**seconds**).

The per-farmer policies are written on `storage.objects` and key off the first path segment via
`(storage.foldername(name))[1]` — V4, and Postgres arrays are 1-indexed, which is why the migration
says `[1]` and not `[0]`. That is what makes the `{user_id}/…` object path convention enforceable at
the database. V4 also records that Storage allows **no** uploads without a policy, so if an upload
401s after this step, the policy did not apply.

Note the narrowing: farmer-facing storage policies grant `select, insert` only. Every deletion in
Jamee runs server-side with the service role. A farmer session holding `delete` on an object the
history view depends on has no legitimate use.

### The two assertions this step owes you

**`scripts/check-deployment.ts` has landed** (task 28.4). It is the thing that turns this step from
"the migrations reported success" into "the deployment is actually correct". Run it:

```
npm run check:deployment
```

which is `node --experimental-strip-types scripts/check-deployment.ts`, matching the invocation
style of the two other guards in `package.json`. It asserts:

- `select count(*) = 5 from disease_knowledge`, and a non-empty `source` on every row
  (Requirements 4.1, 4.2);
- both `crop-images` and `voice-messages` exist and are **private** (Requirement 13.5);
- RLS is enabled on `profiles`, `conversations`, `messages`, `diagnoses`, `usage_logs`, `counters`
  and `whatsapp_inbound` (Requirement 13.1);
- the webhook GET returns 200 for the configured verify token and 403 for a wrong one — which is a
  step 7 check, so run the script again after step 7.

It exits 0 only when every assertion is **verified and passing**, and exits 1 both on a failure and
on any assertion it could not verify, because "I could not check" must never read as "fine". An
unconfigured environment is a refusal rather than a crash: the report opens with a CONFIGURATION
section listing each variable it needed as `set` or `absent`, and reprints the SQL below so you can
complete the step by hand. No secret value is ever written to its output.

**The by-hand substitutes**, for an assertion the script reported as unverified, or for a check
without `psql` on the machine. In the SQL editor:

```sql
select count(*) from public.disease_knowledge;                        -- expect 5
select count(*) from public.disease_knowledge where coalesce(source,'') = '';  -- expect 0
select id, public from storage.buckets order by id;                   -- expect crop-images/false, voice-messages/false
select relname, relrowsecurity from pg_class
 where relnamespace = 'public'::regnamespace
   and relname in ('profiles','conversations','messages','diagnoses',
                   'usage_logs','counters','whatsapp_inbound')
 order by relname;                                                    -- expect relrowsecurity = true for all seven
```

A `false` in either of the last two queries is a **release blocker**, not a warning: a public bucket
publishes every farmer's crop photos, and a table without RLS is readable with the publishable key
that ships to the browser.

---

## Step 4 — Obtain the provider keys and record the resolved model identifiers

### The keys

| Variable | Where | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | Google AI Studio → Get API key | V6 records that the `@google/genai` client reads this exact name itself, which is why it is not renamed |
| `GROQ_API_KEY` | Groq Console → API Keys | Real keys start `gsk_`. One key serves text fallback, vision fallback and transcription |

### The model identifiers are already pinned — do not put them in environment variables

They are compile-time constants in `src/lib/config/verified.ts`, each annotated with its V-item. A
model id in an environment variable is an unversioned, unreviewable change to what Jamee tells a
farmer. Recorded here so you can confirm what a deployment is actually running:

| Capability | Primary | Fallback | V-item |
| --- | --- | --- | --- |
| `vision-classify` | Gemini `gemini-3.8-flash` — **stable** | Groq `qwen/qwen3.8-27b` — **Preview tier** | V6, V9 |
| `text-generate` | Gemini `gemini-3.8-flash` — **stable** | Groq `openai/gpt-oss-20b` | V6, V8 |
| `transcribe` | Groq `whisper-large-v3-turbo` | **none** — single-member chain | V10 |

Three consequences to carry into operations:

- **The vision fallback can disappear without notice.** V9 records both candidate Qwen models as
  *Preview* — "evaluation purposes only… may be discontinued at short notice". If it is withdrawn,
  the whole change is setting `VISION_FALLBACK_MODEL` to `null` in `src/lib/config/verified.ts`.
  That is **a code edit, not an environment variable**, and there is deliberately no
  `VISION_FALLBACK_MODEL` in `.env.example`. Running with a one-member vision chain is a **supported
  configuration**: Requirement 14.8's single exhausted-chain branch makes a failed one-member chain
  and a failed two-member chain indistinguishable to a farmer — the same busy message either way.
- **Voice has no cross-provider fallback.** A Groq outage takes voice offline while image and chat
  continue on Gemini. A Gemini outage takes text offline while transcription still works but cannot
  produce an answer. Neither is a defect; both are the documented shape.
- **A Gemini vision outage looks like "diagnosis quality dropped", not like an error.** V9 records
  Groq's JSON mode as a plain JSON-object mode rather than a schema-enforced one, so the fallback
  path loses schema enforcement and the expected effect is a **higher inconclusive rate**. It is
  distinguishable only in `usage_logs` via `used_fallback` and `rejection_reason`.

### Record the free-tier request rates — they are UNRESOLVED and only you can see them

**U-V19a (Gemini free-tier RPM/RPD) and U-V19b (Groq free-tier RPM/TPD) are both unresolved**,
because the numeric tables now live behind an authenticated dashboard. You are the first person who
can read them.

- **Gemini:** AI Studio → the rate-limit page for your project. Record RPM, TPM and RPD. V19 records
  that RPD resets at midnight Pacific and that limits are per project.
- **Groq:** Groq Console → your account's limits page. Record RPM, TPM, RPD and TPD for
  `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` and `whisper-large-v3-turbo`, plus the audio-seconds
  limits for Whisper.

Write both sets into `docs/VERIFIED_VALUES.md` under U-V19a and U-V19b with the date, then compare
them against the demand figures in step 9. **Do not use the numbers U-V19b prints for reference** —
those are explicitly labelled **Developer-plan** base limits, and V10 separately distinguishes a
free tier (25 MB audio) from a dev tier (100 MB), so free ≠ developer.

This blocks no code. Requirement 14.4 handles provider limits reactively through the fallback path,
and Jamee's own quotas are set independently of any provider rate.

---

## Step 5 — Create the Meta app and the WhatsApp number, and pin the API version

This is the longest step and the one with a business-verification dependency you cannot rush.

1. Create a Meta developer account at [developers.facebook.com](https://developers.facebook.com) and
   create an app with the **WhatsApp** product added.
2. **WhatsApp → API Setup** gives you a test business phone number and its **Phone number ID**.
   That numeric id — *not* the display phone number — is `WHATSAPP_PHONE_NUMBER_ID` (V15: it is the
   path segment of the send endpoint).
3. **App Settings → Basic → App secret** (Show) → `WHATSAPP_APP_SECRET`. This is the HMAC-SHA256 key
   for `X-Hub-Signature-256` (V13), verified over the raw request body before any JSON parsing.
4. Invent a long random string → `WHATSAPP_VERIFY_TOKEN`. You paste the same string into Meta at
   step 7.
5. **Get the right kind of access token — this is where a first deployment usually goes wrong.**
   The API Setup page issues a **short-lived** token, useful for a curl test and nothing else. A
   deployment needs a **long-lived System User token**: Business Settings → System Users → create or
   select a system user → assign the app with full control → Generate new token → select the app,
   choose a long-lived expiry, and grant `whatsapp_business_messaging` and
   `whatsapp_business_management`. That token is `WHATSAPP_ACCESS_TOKEN`.

   If you deploy with the short-lived token, everything works until it expires, and then **every**
   media download and **every** reply fails at once. See the token-renewal runbook below.
6. Add your own phone number as a recipient in the API Setup page's allow-list while the app is in
   development mode. Messaging requires prior opt-in (V15) and an unlisted number receives nothing.
7. **Business verification** is required before the number can message the general public. For a
   6-farmer pilot on the test number with allow-listed recipients you do not need it — but it is a
   multi-day Meta review when you do, so start it early if the pilot is meant to grow.
8. **The API version is already pinned and needs nothing from you.** V12 resolves it to **`v26.0`**,
   asserted once as `WHATSAPP_API_VERSION_PINNED` in `src/lib/config/verified.ts`. Confirm on Meta's
   Graph API changelog that `v26.0` is still available. The optional `WHATSAPP_API_VERSION`
   environment variable exists **only** as an escape hatch for the case where Meta deprecates the
   pinned version faster than a code change can ship. Leave it unset; unset is the normal
   configuration.

### Two things about the 24-hour window, so you do not misread a rejection

V15 records a 24-hour customer service window that starts when a WhatsApp user messages or calls the
business and **resets on each subsequent message**. Inside it, free-form replies need no
pre-approval. Outside it, only pre-approved template messages may be sent.

Every Jamee reply is a direct answer to a farmer's inbound message, so the window is open by
construction and **no message template is required for the normal flow**. The one exposure is a
reply emitted more than 24 h after the last inbound message — that would be rejected without a
template. V15 also records a known issue where a reply can occasionally fail inside an apparently
open window, so a send failure is a handled case rather than an impossible one.

---

## Step 6 — Deploy to Vercel with all variables, and confirm the permitted `maxDuration`

### Licensing constraint, stated before the technical steps

**V19 records that the Vercel Hobby plan is restricted to non-commercial, personal use** by the fair
use guidelines. That is a licensing constraint on the deployment target, not a technical one, and no
error will ever tell you about it. A 6-farmer pilot that is genuinely evaluation is inside it. The
moment Jamee is commercial — charged for, or run as part of a business — Hobby is the wrong plan and
you need Pro. Decide this before you deploy, not after.

### The deploy

1. Import the repository into Vercel. The framework preset is Next.js and needs no adjustment.
2. Set **every** variable from `.env.example` as a **project** environment variable, for Production
   (and Preview, if you intend to test there):

   Public — these reach the browser by design:
   `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` **or**
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

   Server-only secrets:
   `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `WHATSAPP_ACCESS_TOKEN`,
   `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `CRON_SECRET`.

   Optional: `WHATSAPP_API_VERSION` — leave unset.

   **Never set `JAMEE_TEST_DATABASE_URL` in production.** It is read by
   `tests/integration/database.ts`, never by `serverEnv()`, and it never ships. Its absence is what
   makes `npm test` green on a machine with no database; its presence in a production environment
   would put a database connection string with a password into the deployment's environment for no
   reason at all.

3. **`CRON_SECRET` must be a project environment variable on Vercel — not only in `.env.local`.**
   V21 records that Vercel injects this variable's value as `Authorization: Bearer <CRON_SECRET>` on
   every cron invocation. That injection reads the **project** variable. A value that exists only in
   `.env.local` gives you a manual run that works perfectly and a scheduled run that **401s
   silently** — the endpoint returns a bodiless 401, the cron log shows a 401, and nothing explains
   why. Use at least 16 random characters (V21's recommendation, enforced by the Zod schema).

4. Deploy, and confirm the build is green. Then open the app on a phone and sign in — that proves
   steps 1, 2 and 6 together.

### Confirm the permitted `maxDuration` — do not assume it

Jamee's route handlers export **`maxDuration = 60`**, deliberately. V16 records the documented
platform maximum on Hobby as **300 s**, and Jamee declines to use it: every soft timeout in the
codebase is a fraction of 60 s, not of 300 s. Taking the same 75% fraction of 300 s would give a
225 s budget — a number no farmer waits for, and one that pushes provisioned memory past the free
allowance (see step 9).

**Your job here is to confirm the permitted value on your actual plan, not to assume it.** V17
records that the route-segment default is "set by deployment platform", so the effective ceiling is
a platform fact:

1. After deploying, open **Project → Functions** (or the function's detail view) in the Vercel
   dashboard and read the configured **Max Duration** for `/api/diagnose`, `/api/chat`, `/api/voice`,
   `/api/whatsapp` and `/api/internal/retention-sweep`. It should read **60 s** for all five.
2. Confirm your plan's documented maximum on the plan page. It should be **at least 60**.
3. If the dashboard shows something other than 60 s, the export did not take effect — check that the
   route file still has `export const maxDuration = 60` as a **literal** (Next.js reads route segment
   config by static analysis, so an imported constant does not work there).
4. **If the permitted maximum is below 60, stop.** That is a genuine blocker, not a tuning question:
   the 45 s soft budget, the 15 s terminal reserve, and the per-attempt ceilings in
   `docs/PROVIDER_CAPABILITIES.md` §3 are all derived from 60. Lowering the ceiling means re-deriving
   the whole budget and changing `JAMEE_MAX_DURATION_SECONDS`, the five `maxDuration` literals, and
   the arithmetic in that document — a code change with a review, not an environment variable.

Two V16 facts worth carrying: the request/response body ceiling is **4.5 MB** (Jamee stays ~200 bytes
per request because the browser uploads to Storage and posts a reference, so nothing approaches it),
and `SIGTERM` grants only **~500 ms** of cleanup, which is why nothing important is deferred to
shutdown.

### The scheduled retention sweep

`vercel.json` now exists in the repository root and registers the cron:

```json
{
  "crons": [
    { "path": "/api/internal/retention-sweep", "schedule": "0 2 * * *" }
  ]
}
```

**Why this is a committed file rather than a step you perform.** Without it the automatic trigger
does not exist at all — the route exports `GET` specifically for the platform scheduler (V21), and
that export would be dead code. Asking a deployer to hand-author the file would reintroduce exactly
the guesswork Requirement 17.3 exists to remove, and it has a foot-gun: V21 records that a schedule
**more frequent than once per day fails deployment on Hobby**, so a hand-written `0 */6 * * *` breaks
the deploy rather than warning. It is also the last unowned piece of task 35.1's trigger — task 35.1
shipped the route and left the schedule to this document.

Three V21 constraints the expression above respects, and that you should not "fix":

- **Once per day maximum on Hobby.** A more frequent expression fails the deployment.
- **UTC always.** `0 2 * * *` is 02:00 UTC. Named alternatives (`MON`, `JAN`) are unsupported, and
  day-of-month and day-of-week cannot both be set.
- **It fires anywhere inside the hour.** `0 2 * * *` runs somewhere in `02:00:00`–`02:59:59`. This is
  harmless because the sweep is idempotent and bounded.

Confirm after deploying: **Project → Settings → Cron Jobs** should list one job. V21 records that
cron jobs do not follow redirects (a 3xx ends the invocation) and that a path which 404s still counts
as an execution — so a listed job is not proof of a working one. The proof is a 200 in the cron log,
or the manual run below.

---

## Step 7 — Register the webhook callback and the verify token

1. **WhatsApp → Configuration → Webhook → Edit** in the Meta App Dashboard.
2. **Callback URL:** `https://<production-domain>/api/whatsapp`
3. **Verify token:** the exact string you put in `WHATSAPP_VERIFY_TOKEN` at step 5, character for
   character. It is compared in constant time against `hub.verify_token` (Requirement 11.1, V13).
4. Click **Verify and save**. Meta issues a GET with `hub.mode=subscribe`, `hub.challenge` and
   `hub.verify_token`; Jamee matches the token and echoes the challenge. A failure here is almost
   always a token mismatch — including a trailing newline picked up from a copy-paste.
5. **Subscribe to the `messages` field.** Without this subscription the endpoint verifies
   successfully and then receives nothing, which is a confusing failure to debug.
6. V13 requires **HTTPS with a non-self-signed certificate**. A Vercel production domain satisfies
   this; `localhost` does not, which is why the webhook cannot be tested against a local dev server
   without a tunnel.

Re-run the step 3 assertions (`npm run check:deployment`, which has landed — see step 3) — the
webhook GET check belongs to this step.

### What to expect in the logs, and why 200 is almost always the right answer

V13 records that Meta retries a non-200 immediately and then with decreasing frequency **over
36 hours**, dropping unacknowledged events after that, and that a delivery may batch **up to 1000
updates**. Jamee is built to that: `provider_message_id` is the primary key of `whatsapp_inbound`
(migration 0008), so a redelivery is dropped before any service call or reply.

Log lines you will see, all prefixed `[jamee] whatsapp.`:

| Line | Meaning |
| --- | --- |
| `signature.accepted` | a verified delivery; the digest itself is never logged |
| `signature.rejected` | 401 — wrong `WHATSAPP_APP_SECRET`, or a request that is not from Meta |
| `delivery.accepted` | parsed, with message *kinds* only — never contents |
| `delivery_receipt.ignored` | a business-originated status update, not a farmer message. V12: `field` is `messages` for both, so the discriminator is the presence of `value.statuses[]` |
| `payload.ignored` | a correctly signed body Jamee could not read as a message — a run of these means the envelope changed |
| `media_shape.unconfirmed` | **the U-V12 capture. See the next section.** |

---

## Step 8 — Run the release acceptance sequence on a phone

Requirement 17.3's procedure ends here, and this is the release gate (task 32). Run it on a real
Android handset, on mobile data rather than office wifi, **without developer assistance** — that
last clause is part of the criterion.

1. Sign in with a phone number and an SMS one-time passcode.
2. Upload a crop image and receive a possible-disease result grounded in the knowledge base.
3. Ask a follow-up question in the same conversation, and get an answer that resolves against that
   diagnosis.
4. Receive an explanation in Hindi and in Marathi with the canonical disease name unchanged.
5. Send a voice message in Hindi, Marathi or English and receive a text answer.
6. Send a crop photo to Jamee on WhatsApp **from the same phone number**, and receive the same
   diagnosis content the web app produces.
7. Open the history screen on the website and view both the web and WhatsApp diagnoses, including a
   detail view for one entry.
8. Confirm Jamee performs no model training and that every agricultural statement traces to a
   knowledge-base row. `npm run check:shared-implementation` asserts the no-training half
   mechanically.

Record the outcomes in `docs/TESTING_REPORT.md` (task 30.1).

**Step 6 of that sequence is also the U-V12 and U-V13 capture.** Do the captures in the next section
while you are here — a real inbound image and a real inbound voice note are exactly what they need,
and you will not have a cheaper opportunity.

---

## Step 9 — Free-tier headroom for 6 farmers

Requirement 17.7 makes the free-tier claim **conditional**, and Requirement 17.9 requires this
document to say so plainly:

> The free-tier claim holds only while **(a)** every uploaded crop image is re-encoded to the
> Downscale_Target (Requirement 2.10) and **(b)** the Retention_Window is configured within the
> bound recorded under Requirement 18.2. It is measured against V19's **Supabase Free: 1 GB
> storage and 5 GB/month egress**, and **Vercel Hobby: 1,000,000 function invocations, 4 CPU-hrs
> Active CPU, 360 GB-hrs provisioned memory, 100 GB fast data transfer, 10 GB fast origin
> transfer, 1,000,000 edge requests** — all per month.

If either condition stops holding, the claim stops holding with it. Turn the re-encode off and the
storage figures below multiply by roughly an order of magnitude; raise `MEDIA_RETENTION_DAYS` past
the bound and the rotating set grows linearly with it.

### The load being measured

Worst case is Jamee's own daily quota, spent in full by every farmer:

```
6 farmers × 20 image  = 120 image diagnoses / day
6 farmers × 50 chat   = 300 chat turns      / day
6 farmers × 20 voice  = 120 voice notes     / day
                        ─────────────────────
                        540 API requests    / day
```

Real pilot activity is a fraction of this. Every figure below is the ceiling, not a forecast.

### Supabase storage — 371 MB of a 768 MB reserved budget, and ~132 days of runway

Per-object figures and the reserve come from the design's media-lifecycle arithmetic and are also
asserted in `src/lib/config/media.ts`:

| Term | Figure | Retained for |
| --- | --- | --- |
| `full_size_bytes_per_day` | 120 × ~400 KB ≈ **48 MB/day** | `MEDIA_RETENTION_DAYS` = 7 |
| `straggler_bytes_per_day` | ≈ **5 MB/day** (voice objects whose transcription failed) | 7 days |
| `thumbnail_bytes_per_day` | 120 × ~25 KB ≈ **3 MB/day** | **forever** — never swept |
| Voice objects that transcribe successfully | ~0 | deleted as soon as the transcript row commits (Requirement 8.9) |
| Usable budget | 0.75 × 1 GB = **768 MB** | V19's 1 GB, less 25% headroom for a missed sweep |

The rotating set reaches a steady state and stops growing:

```
(48 + 5) MB/day × 7 days = 53 × 7 = 371 MB          constant from day 7 onward
```

**Headroom on day 7 and every day after: 768 − 371 = 397 MB**, i.e. the rotating media set occupies
**48%** of the reserved budget. The permanent set is what consumes the rest:

```
371 + 3 MB/day × d ≤ 768
                3d ≤ 397
                 d ≤ 132 days
```

**So the 7-day window holds for about 132 days — roughly four and a half months — at maximum farmer
activity.** Measured against the full 1 GB rather than the 75% reserve it is ~218 days; the
difference is the missed-sweep insurance, and spending it is a decision rather than an accident. At a
realistic 20% of quota the entire media footprint is under 300 MB after a full year (rotating set
74 MB + a year of thumbnails at 0.6 MB/day ≈ 219 MB).

**What runs out is thumbnails, not originals.** Requirement 18.5 retains every thumbnail derivative,
so 3 MB/day is a permanent accumulation — about 1 GB in under a year at full quota. This is why
`MEDIA_RETENTION_DAYS` is a number to *review* rather than to set once: re-run the division above at
day 90 with the storage figure the dashboard actually reports, and shorten the window before the
reserve is gone rather than after.

The 500 MB **database** allowance is not a constraint here: rows are text and uuids, and 540
requests/day produces on the order of a few thousand small rows per day.

### Supabase egress — the tighter constraint, at 56% consumed before a farmer opens anything

5 GB/month is about **170 MB/day**. Media leaves Supabase once per provider read, because both
providers accept a URL (V6, V10), and again on every history or detail render — and V3 puts signed
URL expiry in seconds, so browser cache reuse across renders is limited and repeat views really do
re-fetch.

| Read path | Per day at worst-case load |
| --- | --- |
| Provider image reads | 120 × ~400 KB ≈ **48 MB** |
| Provider audio reads | 120 × ~400 KB ≈ **48 MB** |
| **Provider subtotal** | **96 MB/day = 2.88 GB/month** |
| Remaining for farmer-facing reads | **74 MB/day ≈ 2.1 GB/month** |

**Provider reads alone consume 56% of the monthly egress allowance before a farmer opens a single
screen.** That is the honest headline: at full quota, egress is tighter than storage.

What the remaining 74 MB/day buys, across all six farmers:

- history list renders at 20 thumbnails × ~25 KB ≈ **0.5 MB per render** → ~148 renders/day, about
  **24 per farmer per day**;
- or detail views at one ~400 KB original per open → ~185 opens/day, about **30 per farmer per day**;
- a realistic mix — 10 list renders and 10 detail opens each — is 6 × (5 + 4) = **54 MB/day**, for a
  150 MB/day total that stays inside 170.

Comfortable, but not unlimited, and it is the thumbnail derivative that makes it so. Before
Requirement 2.13 a 20-entry list render was ~8 MB of originals; a farmer scrolling history a few
times a day was a genuine threat to a 170 MB/day budget. At 0.5 MB it is noise. Past the retention
window it drops to zero, because a detail view has no original left to fetch.

### Vercel Hobby — invocations are trivial; provisioned memory is the one to watch

| Meter | Allowance | Jamee at worst case | Headroom |
| --- | --- | --- | --- |
| Function invocations | 1,000,000/mo | 540 API + ~1 cron + page loads ≈ **600/day ≈ 18,000/mo** | **~98%** unused |
| Edge requests | 1,000,000/mo | same order | ample |
| Fast data transfer | 100 GB/mo | JSON responses are ~200 bytes (D1: the browser posts a reference, not bytes) | ample |
| Provisioned memory | 360 GB-hrs/mo | **see below** | **can be exceeded at the pathological ceiling** |
| Active CPU | 4 CPU-hrs/mo | **not computable without measurement** | unknown |

**Provisioned memory, worked through.** Hobby gives 2 GB per function (V16). If every one of the 540
daily requests ran its full 45 s soft budget:

```
540 × 45 s = 24,300 s/day = 6.75 h/day
6.75 × 30  = 202.5 function-hours/month
202.5 × 2 GB = 405 GB-hrs   >   360 GB-hrs allowed
```

**The pathological ceiling exceeds the allowance by about 13%.** At realistic latencies it does not:
120 diagnoses at ~25 s, 300 chats at ~8 s and 120 voice requests at ~20 s is ~7,800 s/day → 65
function-hours/month → **130 GB-hrs, or 36% of the allowance**. So there is real headroom, and it is
headroom in *latency* rather than in request count — which means the thing to watch on the dashboard
is average function duration, not invocation count. This is a second, independent reason not to raise
`maxDuration` toward the platform's 300 s.

**Active CPU is the one figure this document cannot compute, and it should not pretend to.** 4 CPU-hrs
is 14,400 CPU-seconds/month, and Vercel bills actual CPU rather than wall time. Jamee's functions are
overwhelmingly I/O-bound — waiting on a provider or on Supabase — so actual CPU should be a small
fraction of the wall-clock hours above. But V19 flags one path worth measuring: the **WhatsApp
adapter moves media bytes through a function** (it downloads from Meta and uploads to Supabase with
the service role, because there is no browser on that path). At the V14 inbound image cap of 5 MB and
no re-encode, a WhatsApp-heavy day moves real bytes through compute. Read Active CPU off the Vercel
usage dashboard after the first week of the pilot and record it. Which transfer meter those bytes
land in is also not resolved by V19 — record that from the dashboard rather than reasoning about it.

### Provider free tiers — demand computed, allowance UNRESOLVED

U-V19a and U-V19b leave both providers' free-tier rates unpublished, so the headroom is one
subtraction away rather than stated. The demand side, computed here so step 4's capture completes it:

| Capability | Requests/day at full quota | Peak requests/minute |
| --- | --- | --- |
| `vision-classify` | 120, plus up to 120 more if the fallback fires | 6 farmers × 3 burst = **18** |
| `text-generate` | 120 diagnosis rephrases + 300 chat + 120 voice answers = **up to 540** | 6 × 10 = **60** |
| `transcribe` | 120 | 6 × 3 = **18** |

Transcription audio-seconds: 120 recordings at Jamee's 120 s ceiling is **14,400 audio-seconds/day**
worst case; V10's 10 s minimum billed length puts the floor at **1,200 audio-seconds/day** even for
120 very short recordings.

**One finding to record while capturing the numbers.** Jamee's own burst allowance is 10 chat
requests per farmer per minute (`BURST_QUOTAS` in `src/lib/config/verified.ts`), which is **60
chat requests per minute** across six farmers. U-V19b prints, for reference only, a
**Developer-plan** figure of 30 RPM for `openai/gpt-oss-20b` — and 60 > 30. So a synchronized chat
burst can exceed a documented provider rate on the fallback path, and if Gemini's free RPM is also
below 60 it can exceed both. What happens then is designed for and not a defect: Requirement 14.4
falls back, and an exhausted chain produces Requirement 14.5's busy message. But it means "Jamee is
busy" is a reachable state at full burst rather than a theoretical one, and the fix if it shows up in
practice is lowering `BURST_QUOTAS.chat`, not raising a provider limit.

### One exposure the arithmetic above does not bound

**A pathological voice day.** Requirement 8.2 admits recordings up to 10 MB, and 120 of those is
**1.2 GB** — past the entire storage allowance inside a single day, before any sweep could run, and
none of it deleted on success if the transcriptions also fail. Reaching it takes all six farmers
spending their full voice quota on maximum-size recordings, so it is abuse rather than use. The
mechanisms that would bound it — a lower voice admission ceiling, or client-side audio re-encoding —
are outside the current scope and are recorded here rather than assumed away.

---

## Operational runbook

### Run the retention sweep by hand

```
curl -i -X POST "https://<production-domain>/api/internal/retention-sweep" \
  -H "Authorization: Bearer $CRON_SECRET"
```

**`POST` is the manual verb; `GET` is the platform cron's** (V21), and both sit behind the same
constant-time secret comparison. There is one secret, not two: V21 records that Vercel injects
`Authorization: Bearer <CRON_SECRET>` automatically, so Requirement 18.12's "retention sweep secret"
**is** `CRON_SECRET`.

Reading the response:

| Response | What it means | What to do |
| --- | --- | --- |
| **200** with a JSON report | the sweep ran. The report carries the retention days, the cutoff, and per-scan counts — scanned, removed, already-absent, failed, the limit, and `bounded`. No path and no user id appears in it, because a path's first segment is a farmer's auth id | if `fullImages.bounded === true` the batch was **full** and work remains — **run it again**, and keep running it until `bounded` is false |
| **401**, empty body | a missing or wrong secret, **or** `CRON_SECRET` not set on the server at all. All four refusal reasons return the same bodiless 401 on purpose: a body could only tell an unauthenticated caller which half it failed, including whether the sweep is armed | check the header, then check the project variable on Vercel. **The reason is in the server log only** — look for `[jamee] retention.unauthorized` or `[jamee] retention.secret_not_configured` |
| **500**, empty body | the sweep failed; the cause is in the log as `[jamee] retention.sweep_failed` | **the next scheduled run is the retry** — V21 records that the platform does not retry a failed cron invocation. Re-run by hand if you do not want to wait |

**Re-running is always safe.** The sweep is idempotent and bounded: scan 1's
`where full_image_deleted_at is null` predicate excludes anything a previous run stamped, and a path
absent from the delete call's returned entries counts as already-deleted rather than as a failure. A
doubled, late or missed run is harmless — which is exactly what V21's best-effort delivery (in both
directions) requires.

**There is no `next dev` cron support** (V21), so locally you request the URL directly with the same
command against `http://localhost:3000`. That is the same request the scheduler makes, minus the
verb.

Two things the sweep does not do, worth knowing before you read a report as a problem: it deletes no
row of `diagnoses`, `messages`, `conversations` or `usage_logs` (Requirement 18.6), and it retains
every thumbnail derivative (Requirement 18.5). And **scan 2 — the age-driven orphan backstop — does
not run at all** in this release; see the U-V22b capture below.

### Renew `WHATSAPP_ACCESS_TOKEN`

**This is a recurring operational event, not a one-time setup detail.** V14 documents the recovery
for a media download that returns **404**, and it is a two-step escalation:

1. **Re-request the media URL.** V14 records that the URL returned by step 1 of media retrieval is
   valid for **5 minutes only**, so a stale URL is the common cause and a fresh metadata request is
   the cheap fix. Jamee never caches a media URL across invocations
   (`WHATSAPP_MEDIA_URL_TTL_SECONDS`).
2. **If it still 404s, renew the token.** Generate a new long-lived System User token exactly as in
   step 5, update `WHATSAPP_ACCESS_TOKEN` in the Vercel project environment, and **redeploy** —
   environment variable changes do not reach a running deployment.

The symptom of an expired token is that **every** media download and **every** reply fails at once,
across all farmers, while text-only inbound messages still parse and log fine. If you deployed with
the short-lived API Setup token, this is what you will see, and it will happen within hours.

One boundary that is not a token problem: V14 records that inbound media ids received via webhook are
downloadable for **7 days**. A download failing on a message older than that is expiry, and renewing
the token will not fix it.

### A WhatsApp voice note in `aac` or `amr` is refused, by design

V14 lists `audio/aac` and `audio/amr` among the containers WhatsApp delivers. **Neither is in V10's
accepted container list**, and no first-party Groq page says otherwise, so the list is not widened on
a guess. Consequence, recorded rather than hidden: such a voice note is **refused before the media
download**, the farmer is told to type the question instead, the delivery is marked `rejected`, and
nothing is spent. **Requirement 10.6 is therefore not satisfied for those two containers.**

The error is `AUDIO_FORMAT_UNSUPPORTED` — **400, not retryable** — because WhatsApp chooses the
recording container, so re-sending the identical voice note fails identically forever.

**If a deployment capture shows Meta sending `aac` for most voice notes, this becomes the priority
follow-up**, and closing it needs real work: a transcode step ahead of transcription, or a second
transcription provider whose accepted list covers them. It is not a constant edit. Watch for it while
running step 8 item 5 over WhatsApp.

---

## Empirical captures a first deployment must make

Four unresolved items can only be settled by observing a live deployment. Each is a named step with
what to look for, where, and what to change afterwards. **None of them blocks the deploy**; each is
written to fail loudly or degrade visibly rather than produce a wrong answer for a farmer.

### Capture A — U-V12: the inbound image and audio field paths

**What is unresolved.** The per-type sub-object field paths inside `messages[].image` and
`messages[].audio` — whether it is `messages[].image.id` / `.mime_type` / `.sha256` and
`messages[].audio.id` / `.mime_type` / `.voice`. The common envelope is fully confirmed (V12); these
sub-objects are not, because Meta's per-type reference pages could not be retrieved. Jamee's shape is
marked **PROVISIONAL** at the type level and requires only `id`.

**How to capture it.** During step 8, send one real image and one real voice note from WhatsApp.

**What to look for.** In the Vercel function logs for `/api/whatsapp`:

- **`[jamee] whatsapp.media_shape.unconfirmed`** — the provisional shape did **not** match. The line
  carries `type`, `observedKeys` (field *names* only, never values — a caption is farmer content) and
  `issue`. Those observed keys are the answer.
- **No such line, and the diagnosis completes** — the provisional shape matched. Confirmed by
  observation rather than by documentation, which is still the resolution.

**What to change.** Record the observed keys under V12 in `docs/VERIFIED_VALUES.md`, update
`provisionalMediaSchema` in `src/lib/whatsapp.ts` if they differ, and set
`WHATSAPP_INBOUND_MEDIA_SHAPE.confirmed` to `true` once **both** an image and an audio delivery have
been seen.

**Why it is safe to deploy unresolved.** A media object that does not match resolves to
`unconfirmed_media_shape` and is logged; a media id that cannot be found throws an `Error` naming
U-V12 rather than issuing a request for `/{version}/`. The failure is loud and self-describing.

### Capture B — U-V13: the signature digest encoding, hex or base64

**What is unresolved.** Whether the `X-Hub-Signature-256` value after `sha256=` is hexadecimal or
base64. Meta's docs give the header name, the prefix, SHA-256, the app-secret key and the
constant-time comparison instruction — but never the encoding. Jamee **accepts both**, comparing
against each candidate in constant time, rather than guessing one and rejecting every legitimate
delivery.

**How to capture it.** The first real signed delivery in step 8 does it.

**What to look for.** `[jamee] whatsapp.signature.accepted` (or `.rejected` — both branches log it)
carries a `header` shape summary. The digest length settles it: **64 characters is hex**, **44
characters is base64** (32 raw bytes = 64 hex chars, or 43 base64 chars plus one `=` pad). The digest
itself is never logged, deliberately.

**What to change.** Record the observation under V13, then narrow
`META_SIGNATURE_ENCODING_CONFIRMED` in `src/lib/whatsapp.ts` from `null` to `'hex'` or `'base64'`.

**Why it matters that this is not left open forever.** While it is `null`, verification accepts two
candidate digests instead of one. That is the correct trade before the encoding is known — the
alternative is rejecting every legitimate webhook on a coin flip — but it is a marginally wider
acceptance surface than the final state, so narrow it once you have the observation.

### Capture C — U-V20: the container `MediaRecorder` actually produces on the target Android browser

**What is unresolved.** Which container and codec `MediaRecorder` actually *records* on the Android
browsers your testers use. MDN documents the API, the `isTypeSupported()` probe and per-container
*playback* support, but publishes no per-Android-browser list of supported *recording* containers.

**How to capture it.** Step 8 item 5, on the real handset. Do not use a desktop browser — a desktop
Chrome result tells you nothing about the target.

**What to look for.** `VoiceRecorder` probes an ordered candidate list, all of whose members are
inside V10's accepted containers:

```
audio/webm;codecs=opus → audio/webm → audio/ogg;codecs=opus → audio/ogg
                       → audio/mp4 → audio/mpeg → audio/wav
```

It then reads back `MediaRecorder.mimeType` — what the browser actually selected wins over what was
asked for — and **sends that value with the upload** as the request body's `mimeType`. So the
observed container is visible in three places, easiest first:

1. the `mimeType` field on the `/api/voice` request body, in the function log or a network trace;
2. the uploaded object's extension in the `voice-messages` bucket, which is derived from the same
   container;
3. `[jamee] recorded container not accepted: <mimeType>` in the **browser** console — this appears
   only in the failure case, when the recorded container falls outside V10's list, and it means the
   recorder refused to record rather than uploading something the provider would reject.

**What to change.** Record the observed value under V20 in `docs/VERIFIED_VALUES.md`. **No code
change is needed** — the probe-and-report design is robust to the unresolved part, which is exactly
why it is built that way. What must never happen is hardcoding a single assumed container.

**Also record what did *not* get chosen**, if the first preference was skipped. That is the datum a
future reader needs.

### Capture D — U-V22b: the storage object-age surface, which keeps scan 2 switched off

**What is unresolved.** Whether the `storage` schema exposes a creation timestamp usable for age
filtering. No retrievable page documents the `storage.objects` column set as a queryable age filter.

**What it costs right now.** `RETENTION_ORPHAN_SCAN_ENABLED` is **`false`** in
`src/lib/config/media.ts`, so **scan 2 — the age-driven orphan backstop — does not run**. Scan 1, the
row-driven scan off the `diagnoses` partial index, runs and fully satisfies Requirements 18.3 and
18.7 **for every object a farmer can surface**. What stays uncollected is the orphan class only: an
image uploaded before its diagnosis request failed, and a voice object whose transcription failed.
Those are the `straggler_bytes_per_day ≈ 5 MB/day` term already carried in the step 9 arithmetic, so
**the storage projection above does not change** — but that 5 MB/day accumulates with nothing
reclaiming it until this is resolved.

**How to capture it.** On the live project, in the SQL editor:

```sql
select column_name, data_type
  from information_schema.columns
 where table_schema = 'storage' and table_name = 'objects'
 order by ordinal_position;
```

**What to look for.** A timestamp column you can filter on — a `created_at`, or an equivalent — and
whether it is actually populated for objects the app uploaded. A column that exists but is null is
not a usable age surface.

**What to change.** Record the finding under V22 in `docs/VERIFIED_VALUES.md`, then flip
`RETENTION_ORPHAN_SCAN_ENABLED` to `true`. Nothing else changes — the scan is implemented and tested,
it is simply not called. Run the sweep by hand immediately afterwards and read the `orphans` section
of the report.

### Capture E — U-V22a, free: does `remove()` error on a path that does not exist?

Not a required step, but the first sweep answers it for nothing. `RetentionService` normalizes the
outcome either way — a path absent from the returned array counts as already-deleted, not as a
failure — so the answer cannot change behaviour, only whether one error branch is dead code. Read the
first 200's report and record the observation under U-V22a.

---

## The values-to-verify table

Every third-party value Jamee codes against is resolved in
**[`docs/VERIFIED_VALUES.md`](./VERIFIED_VALUES.md)** — V1 through V22, each with a source URL and a
date, plus the twelve `U-V<n>` sub-items that could not be confirmed against a retrievable
first-party page. This document does not restate that table; it **references** it, so there is
exactly one place a provider fact can be wrong.

The rows a deployment touches directly:

| V-item | What it resolves | Where it lands in this document |
| --- | --- | --- |
| V1 | Supabase packages, client factories, the `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` name | step 1 |
| **V2** | Phone/SMS OTP enablement and the required SMS provider set | **step 2** |
| V3 | `createSignedUrl(path, expiresIn)`, expiry in **seconds** | step 3, and the egress figures in step 9 |
| **V4** | `(storage.foldername(name))[1]` and the bucket `public` boolean | **step 3** |
| V5 | The `auth.users` profile-bootstrap trigger form | step 3 (migration 0002) |
| V6–V11 | Provider SDKs, model identifiers, error shapes | step 4 |
| V12–V15 | Meta API version `v26.0`, webhook paths, signature, media retrieval, send endpoint | steps 5 and 7, and the runbook |
| **V16** | 4.5 MB body limit; documented 300 s platform maximum | **step 6** |
| V17 | `export const maxDuration = <number>`, in seconds | step 6 |
| V18 | `waitUntil()` and `getDeadline()` exist; inline processing was kept anyway | not a deployment step; see `PROVIDER_CAPABILITIES.md` §4 |
| **V19** | Free-tier allowances, **and the Hobby non-commercial restriction** | **steps 6 and 9** |
| V20 | `MediaRecorder` API and the `isTypeSupported()` probe | capture C |
| V21 | Vercel cron: **GET**, `Authorization: Bearer <CRON_SECRET>`, once-daily on Hobby, UTC | step 6 and the runbook |
| V22 | `remove(paths)` batch delete; the age-query surface | capture D |

Two discrepancies recorded there that a deployer will otherwise trip over:

- **The 60 s vs. 300 s duration ceiling.** The requirements assume 60 s; V16 documents 300 s on
  Hobby. Neither was silently adopted: 60 s is Jamee's own `maxDuration` and the basis of every soft
  timeout, and 300 s is recorded only as the hard ceiling 60 stays under. Step 6 is where you confirm
  the platform permits at least 60.
- **V14 vs. V10 on inbound audio containers.** Resolved in favour of not widening V10's list, with
  the cost recorded rather than hidden. See the `aac`/`amr` note in the runbook.

---

## Release gates

Run all six from the repository root. All must be green before the release is accepted
(Requirement 17.8, task 28.6):

```
npm run typecheck                   # tsc --noEmit, strict mode, zero errors
npm run lint                        # eslint
npm run build                       # next build
npm test                            # vitest run — unit, property, and integration projects
npm run check:secret-scope          # secrets stay server-side; one door to process.env; service-role queries anchored
npm run check:shared-implementation # one DiagnosisService, one ChatService, the one-way import rule, no training calls
```

Notes on two of them:

- **`npm test`** runs three projects. The integration project **skips** rather than fails when
  `JAMEE_TEST_DATABASE_URL` is absent, so a green run on a machine with no database does not mean the
  integration suite passed — it means it did not run. Set that variable against a local Supabase
  instance to actually exercise it, and never in production.
- **`npm run check:secret-scope`** proves that secret **variable names** stay on the server side of
  the boundary. It cannot detect a service-role *value* pasted into a `NEXT_PUBLIC_` variable — see
  the step 1 hazard note. That check is yours.

---

## What this document could not settle, and what is a genuine blocker

**Depends on a live account, and cannot be written down in advance:**

- The SMS provider account and its credentials (step 2). Which provider, what it costs, and whether
  delivery to your testers' numbers actually works.
- Gemini and Groq free-tier request rates (step 4) — U-V19a and U-V19b are behind authenticated
  dashboards.
- Meta business verification timing (step 5), which is a Meta review rather than a configuration.
- The four empirical captures (A–D), each of which needs a real delivery, a real handset, or a live
  project.
- Vercel **Active CPU** actuals (step 9), and which transfer meter WhatsApp media bytes land in.

**Genuine release blockers, in the order they would bite:**

1. **No SMS provider configured.** Sign-in is impossible; nothing downstream is testable.
2. **`scripts/check-deployment.ts` has never been run against a live deployment** (task 28.4). The
   script exists and step 3 shows the invocation, but with none of its variables configured it
   reports all ten assertions UNVERIFIED and exits 1 — by design, since it never reports PASS
   unverified. Requirement 17.6 stays unevidenced until it runs against the real project; the SQL in
   step 3 substitutes for it, and a manual check is not a gate.
3. **A public bucket or a table with RLS disabled**, found by those assertions. Either publishes
   farmer data.
4. **A platform-permitted `maxDuration` below 60 s.** Re-deriving the whole timeout budget is a code
   change with a review, not a setting.
5. **The service-role key in a `NEXT_PUBLIC_` variable.** Nothing fails, nothing warns, and RLS is
   bypassed for every browser. There is no automated check for it.

**Known gaps that are recorded rather than fixed** — not blockers, but do not rediscover them:

- `Requirement 10.6` is not satisfied for WhatsApp voice notes delivered as `aac` or `amr`.
- Scan 2 of the retention sweep does not run while U-V22b is open, so ~5 MB/day of orphans
  accumulate unreclaimed.
- WhatsApp-originated diagnoses have no thumbnail (no browser on that path), so the history list
  renders the full-size original until the retention window elapses.
- A pathological voice day is not bounded by any window.
