# Deploying Jamee

This guide takes a student from an empty machine to a working Jamee — first on a
laptop, then deployed to the internet on Vercel. It satisfies Requirement 17.1
(Vercel for the web app and API, MongoDB Atlas free M0 for the database and media,
Better Auth with Google for sign-in) and Requirement 17.3 (Atlas setup, the network
rule, the connection string, Google OAuth, database setup, GridFS, Telegram
`setWebhook`, and Vercel environment configuration).

> **This project moved from Supabase to MongoDB partway through.** Everything here
> describes the current MongoDB version. There is no Supabase step, no SMS provider,
> and no phone one-time-passcode: sign-in is Google only.

**Where facts come from.** Every provider identifier, limit, and header name below
carries the V-item in [`docs/VERIFIED_VALUES.md`](./VERIFIED_VALUES.md) that resolved
it. That file is the authority; if it and this document disagree, that file wins.
Read [`docs/PROVIDER_CAPABILITIES.md`](./PROVIDER_CAPABILITIES.md) alongside step 5
for the AI provider chains, error handling, and timeout budget.

---

## Before you start: where secrets go

Copy [`.env.example`](../.env.example) to `.env.local` and fill in the values there.
`.env.example` is committed and must **never** hold a real key, token, password, or
connection string — only placeholders. `.env.local` is gitignored.

`.gitignore` uses `.env*` with `!.env.example`, so every env file Next.js loads is
ignored while the example stays committed. If you ever create an env file under
another name or in a subdirectory, check `git status` does not offer it before you
commit.

`.env.example` documents, line by line, where each value comes from. Every variable
is read through one small accessor in `src/lib/env.ts`, which throws — naming the
missing variable — the first time something needs a value that is not set. There is
no silent default: a missing setting fails loudly rather than producing a wrong
answer.

---

## The ten deployment steps

### Step 1 — Create the MongoDB Atlas M0 cluster and record `MONGODB_URI`

1. Create a free account at [mongodb.com/atlas](https://www.mongodb.com/atlas), then
   create a project and a **free M0 cluster** (one free cluster per project, V32).
   Pick a region close to your testers.
2. Create a database user (username + password) under **Database Access**.
3. **Network access:** add the rule **`0.0.0.0/0`** (allow access from anywhere).
   Vercel's serverless functions have no fixed outbound IP address to allow-list, so
   this is the only rule that works for a Vercel deployment. Amendment A3 point 7
   records this as an **accepted academic trade-off** for a pilot project — a
   production system with a fixed egress would narrow it.
4. **Connect → Drivers** and copy the `mongodb+srv://…` connection string. Put your
   database user and password into it, and **add the database name `jamee`** in the
   path, like `…mongodb.net/jamee?retryWrites=true&w=majority`. Without the database
   name the driver has no default database and every query fails.
5. Record it as `MONGODB_URI` in `.env.local`. It is the **only** database
   credential, held solely by `src/lib/db/client.ts`.

**M0 limits worth knowing (V32):** total storage **512 MB (0.5 GB), including
indexes**, shared between records *and* the GridFS media files (they live in the same
database); **500 connections** (Jamee caches a single connection to stay well under
this); a 3-node replica set (which is what lets Jamee use transactions); 100
databases and 500 collections; no backups. The 512 MB is the binding limit and is
why the retention window at step 10 matters.

### Step 2 — Choose and configure the authentication library (Better Auth + Google)

`AGENTS.md` requires reading the bundled Next.js guides in
`node_modules/next/dist/docs` before writing Next.js code; that reading (task 50.2)
established the installed line is **Next.js 16** (middleware is now called *Proxy*,
and the proxy does only an optimistic cookie check). On that basis the library was
chosen: **Better Auth 1.7.6** (V35, decision D18a), because its peer dependencies
accept `next ^16` and `react ^19`, it ships a first-party MongoDB adapter that needs
no schema migration, and Auth.js itself now points new projects at Better Auth.

There is **no SMS provider and no phone number** — a Google identity is the only
sign-in.

1. In the **Google Cloud Console**, create an OAuth 2.0 Client ID (**APIs &
   Services → Credentials**).
2. Register the redirect URIs (V30):
   - `http://localhost:3000/api/auth/callback/google` (local development)
   - `https://<your-domain>/api/auth/callback/google` (production)
3. On the **OAuth consent screen**, add the Google accounts of your testers as
   **test users** (a consent screen in "testing" status refuses anyone not listed).
4. Record the credentials in `.env.local`:
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — from the OAuth client;
   - `BETTER_AUTH_SECRET` — a long random string you generate (the library's session
     signing secret);
   - `BETTER_AUTH_URL` — the site's own origin (`http://localhost:3000` locally, the
     deployed `https://<domain>` in production). If this is wrong the Google callback
     can default to localhost and break a deployed sign-in.

Better Auth stores its `user`, `session`, `account`, and `verification` records in the
same MongoDB database; no separate schema step is needed.

### Step 3 — Run the database setup and check it

With `MONGODB_URI` set in `.env.local`, run:

```powershell
npm run db:setup
```

This is idempotent (safe to re-run after a partial failure). It creates every
collection, the unique indexes, the MongoDB `$jsonSchema` validators, the single
GridFS media bucket, and seeds the knowledge base. Confirm the printed summary:

- **seeded conditions: 5** — the five verified conditions (Tomato Early Blight,
  Tomato Late Blight, Tomato Healthy, Potato Early Blight, Potato Late Blight). Not
  four, not six.
- **GridFS bucket** — reported by name.
- **collections** — the list, with their indexes and validators applied.

If the count is not 5, or a collection is missing, re-run it and read the error; do
not proceed with a partial database.

### Step 4 — Obtain the AI provider keys

1. **Google Gemini** — Google AI Studio → *Get API key* → `GEMINI_API_KEY`. Gemini
   is the primary model for looking at photos and writing explanations. The model id
   `gemini-3.8-flash` is pinned in code (V6), not configured here.
2. **Groq** — Groq Console → *API Keys* (real keys start `gsk_`) → `GROQ_API_KEY`.
   Groq is the fallback when Gemini is busy, and it transcribes voice notes.

**Inline media limits (V34):** analysis sends the image bytes to the model inline.
Gemini's documented inline limit is **100 MB per request** (plan against a
conservative **20 MB**); Groq's request-with-image cap is **20 MB** and is enforced
in code before the call. Jamee's own photos target ~400 KB and voice notes are capped
at 3 MB, so neither limit is ever approached.

### Step 5 — Create the Telegram bot

1. Message **@BotFather** on Telegram, `/newbot`, and follow the prompts. Record:
   - the **bot token** → `TELEGRAM_BOT_TOKEN` (looks like `123456789:AA…`);
   - the **bot username** (without the leading `@`) →
     `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` — this is public; it is the `<bot>` in the
     `https://t.me/<bot>?start=<token>` link a farmer opens to connect their account.
2. Invent a **webhook secret token** → `TELEGRAM_WEBHOOK_SECRET_TOKEN` (V24 allows
   1–256 characters of `A–Z a–z 0–9 _ -`; use a long random string). Telegram sends
   this back in the `X-Telegram-Bot-Api-Secret-Token` header on every delivery, and
   Jamee compares it before doing anything. An absent or wrong token is a **failed**
   check (HTTP 401), never a skipped one. You register it at step 8.

### Step 6 — Create the Razorpay account (test mode)

1. Create a [Razorpay](https://razorpay.com) account and stay in **Test mode**.
   Amendment A3 (resolving open question O22-3) sets **test mode everywhere** for the
   pilot: testers use test cards and **no real money moves**.
2. **Settings → API Keys** — generate a key pair. Record:
   - the **key id** (test ids start `rzp_test_`) → both `RAZORPAY_KEY_ID` and
     `NEXT_PUBLIC_RAZORPAY_KEY_ID` (the same value; the public copy is what the
     browser checkout uses, and the duplication keeps the unprefixed one server-only);
   - the **key secret** (shown once) → `RAZORPAY_KEY_SECRET`.
3. The webhook and its secret are registered at step 8 (they need the deployed URL).

Razorpay adds **no fixed and no recurring cost** to Jamee — its only charge is a
per-transaction fee taken out of a payment a farmer makes (Requirement 22.26).

### Step 7 — Deploy to Vercel

1. Import the repository into [Vercel](https://vercel.com) as a Next.js project.
2. Add **every** environment variable from `.env.example` in **Project Settings →
   Environment Variables** (see the full list below). In particular:
   - `BETTER_AUTH_URL` must be set to the **deployed** URL, e.g.
     `https://jamee.example.com` — not localhost.
   - `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` and `NEXT_PUBLIC_RAZORPAY_KEY_ID` are the
     only browser-exposed values; both are public identifiers, not secrets.
3. Deploy. Each API route declares `maxDuration = 60` seconds (V17) — Jamee's own
   ceiling, well under the platform maximum of 300 s; confirm the deployment reports
   the routes as serverless (Node.js) functions.

**Every Vercel environment variable:**

| Variable | What it is |
| --- | --- |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | Public. The bot username in link deep links. |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Public. The Razorpay key id the checkout uses. |
| `MONGODB_URI` | The Atlas connection string, including `/jamee`. |
| `BETTER_AUTH_SECRET` | Better Auth session signing secret. |
| `BETTER_AUTH_URL` | The deployed origin (`https://<domain>`). |
| `GOOGLE_CLIENT_ID` | Google OAuth client id. |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. |
| `GEMINI_API_KEY` | Google Gemini key. |
| `GROQ_API_KEY` | Groq key (fallback + transcription). |
| `TELEGRAM_BOT_TOKEN` | The bot token from BotFather. |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | The secret Telegram echoes on every delivery. |
| `RAZORPAY_KEY_ID` | Razorpay key id (same value as the public one). |
| `RAZORPAY_KEY_SECRET` | Razorpay key secret (signs orders). |
| `RAZORPAY_WEBHOOK_SECRET` | The webhook signing secret (step 8). |
| `CRON_SECRET` | Retention-sweep secret, ≥16 chars (step 10). |

### Step 8 — Register the Telegram webhook and the Razorpay webhook

**Telegram.** Once deployed, point the bot at your site (Telegram cannot reach a
laptop — see the laptop section for local development):

```powershell
npm run telegram:webhook -- https://<your-domain>
```

The script appends `/api/telegram` itself, registers your
`TELEGRAM_WEBHOOK_SECRET_TOKEN`, and prints a confirmation. To confirm the guard
works, send a POST to `https://<your-domain>/api/telegram` **without** the secret
header — it must return **HTTP 401** and do nothing.

**Razorpay.** In the Razorpay dashboard (test mode), **Settings → Webhooks → Add New
Webhook**:

- URL: **`https://<your-domain>/api/payment/webhook`**
- Subscribe to the events **`payment.captured`** and **`payment.failed`**.
- Set a webhook secret, and record the same value as `RAZORPAY_WEBHOOK_SECRET` in
  Vercel.

Jamee verifies each webhook by computing an HMAC-SHA256 of the exact raw request body
with that secret and comparing it, in **lowercase hexadecimal**, against the
`X-Razorpay-Signature` header — before parsing any of the body (V27, U-V27a resolved,
D15). An absent secret is a failed verification (401), never skipped.

**What `RAZORPAY_WEBHOOK_SECRET` actually is.** It is **a value you choose**, not one
Razorpay issues. You type it into the "Secret" field when you add the webhook in the
Razorpay dashboard, and you set the *same* string as the `RAZORPAY_WEBHOOK_SECRET`
environment variable so Jamee's HMAC matches the one Razorpay signs with. It is
**distinct from `RAZORPAY_KEY_SECRET`** (which signs order creation); the two are
different secrets used on different code paths, and mixing them makes every webhook
fail its signature check.

- **On a laptop it can be any random string, or left empty.** No webhook ever reaches
  `localhost` (see the laptop section below), because a local recharge is confirmed
  through the Razorpay API directly (decision D20). So the value you put here has
  nothing to verify against locally — pick any random string, or leave it empty, and
  the ₹20 recharge still completes. It matters locally *only* if you deliberately
  exercise the webhook path through a tunnel (zrok, below), in which case set it to
  match the string you gave the tunnelled webhook.
- **In production the same string goes in both places.** Whatever you type into the
  dashboard's webhook "Secret" field is exactly what you set as the Vercel
  `RAZORPAY_WEBHOOK_SECRET` variable. If they differ, every real webhook is rejected
  401 and no entitlement is ever granted through the webhook path.

### Step 9 — Smoke-test the acceptance sequence: pay → link → photo

On the deployed site, run through the fixed order once:

1. **Sign in** with a Google test-user account.
2. **Recharge** ₹20 on the website (test-mode checkout with a Razorpay test card).
3. **Link Telegram**: open the deep link from the profile screen and send `/start`
   to the bot; it confirms the link.
4. **Send a photo** to the bot and confirm you get a diagnosis back.

A tester who sends a photo *before* linking or recharging should correctly get the
gated reply (link first, then recharge), not a diagnosis — that gate is part of what
this step verifies.

### Step 10 — Record the price, the budget arithmetic, and the retention window

**The price (Requirement 22.4, Amendment A2):** a recharge is **₹20 = 2000 paise**
and buys **7 days** of Telegram bot access. Recharging early stacks another 7 days on
top of the remaining days, so no paid time is lost. The website stays free
regardless. The price lives in one compile-time constant
(`src/lib/config/access.ts`), read from no environment variable.

**The storage budget (Requirements 17.9, 18.2):** the free-tier claim holds only
while photos are re-encoded small (~400 KB) and the retention window is bounded. The
binding limit is the Atlas **M0 512 MB cluster storage**, now shared between records
and media (GridFS is in the same database) — roughly half the retired Supabase 1 GB
storage. The arithmetic that must stay below 512 MB, after reserving headroom, is:

> (projected media bytes per day) × (retention window in days) + (accumulated
> thumbnail bytes) + (records) < 512 MB.

At the ~6-farmer pilot scale, with ~400 KB full-size images plus small thumbnails and
3 MB-capped voice notes, a **7-day** retention window sits comfortably inside 512 MB.
Because the shared budget is tighter than under Supabase, `MEDIA_RETENTION_DAYS`
(default 7) is a number to review early rather than set once (P8-2). The retention
sweep deletes full-size images and voice files past the window, keeps thumbnails, and
never deletes a record.

**The retention cron:** the sweep endpoint is protected by `CRON_SECRET`. Vercel's
scheduler automatically sends this value as `Authorization: Bearer <CRON_SECRET>` on
each scheduled run; a request without it is rejected 401 and deletes nothing, and no
farmer session can trigger it.

---

## Running Jamee on a laptop

You do not need Vercel or a public URL to develop locally.

1. Install Node.js 22.12+ (or 24+), then:

   ```powershell
   npm install
   ```

2. **Fill in `.env.local`** (copy from `.env.example`). Every variable, and where to
   get it:

   | Variable | Where to obtain it (never a real value in `.env.example`) |
   | --- | --- |
   | `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | The username you gave @BotFather (no `@`). |
   | `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Razorpay → Settings → API Keys (test id, `rzp_test_…`). Same value as `RAZORPAY_KEY_ID`. |
   | `MONGODB_URI` | Atlas → your M0 cluster → Connect → Drivers; include `/jamee`. |
   | `BETTER_AUTH_SECRET` | Generate a long random string yourself. |
   | `BETTER_AUTH_URL` | `http://localhost:3000` for local development. |
   | `GOOGLE_CLIENT_ID` | Google Cloud Console → Credentials → OAuth 2.0 Client ID. |
   | `GOOGLE_CLIENT_SECRET` | The same OAuth client. |
   | `GEMINI_API_KEY` | Google AI Studio → Get API key. |
   | `GROQ_API_KEY` | Groq Console → API Keys (`gsk_…`). |
   | `TELEGRAM_BOT_TOKEN` | @BotFather → your bot → API token. |
   | `TELEGRAM_WEBHOOK_SECRET_TOKEN` | Invent a long random string. |
   | `RAZORPAY_KEY_ID` | Razorpay → Settings → API Keys (same as the public one). |
   | `RAZORPAY_KEY_SECRET` | Razorpay → Settings → API Keys (shown once). |
   | `RAZORPAY_WEBHOOK_SECRET` | Invent it; needed only if you test webhooks locally (see below). |
   | `CRON_SECRET` | Invent it, ≥16 characters. |

3. **Set up the database:**

   ```powershell
   npm run db:setup
   ```

4. **Start the app:**

   ```powershell
   npm run dev            # http://localhost:3000
   ```

5. **Google sign-in locally** needs the redirect URI
   `http://localhost:3000/api/auth/callback/google` registered in the Google Cloud
   Console, and your Google account added as a **test user** on the OAuth consent
   screen. Without the test-user step, Google refuses to sign you in.

6. **The Telegram bot locally.** Telegram cannot reach `localhost`, so instead of a
   webhook, run the poller in a **second terminal**:

   ```powershell
   npm run telegram:poll
   ```

   It fetches the bot's messages and forwards each to your local `/api/telegram`
   route with the same secret header Telegram would send, so the exact same code runs.
   Leave it running alongside `npm run dev`.

7. **Recharging locally.** In test mode the Razorpay checkout finishes on the laptop,
   and Jamee's server then confirms the order by calling the Razorpay API directly
   (decision D20). So a local recharge works **without a webhook** — you do not need to
   expose your laptop to the internet just to test the ₹20 recharge.

   If you *do* want to exercise the webhook path locally, you need a public tunnel to
   your laptop — but **Razorpay blacklists `localhost`, `ngrok.io`, and `loca.lt`** as
   webhook URLs. Razorpay's own documentation suggests **[zrok](https://zrok.io)** for
   tunnelling to a laptop; point the test-mode webhook at the zrok URL plus
   `/api/payment/webhook` and set `RAZORPAY_WEBHOOK_SECRET` to match.

---

## Troubleshooting

### Google sign-in: "Error 400: redirect_uri_mismatch"

This is the most common sign-in failure, and it is always a configuration mismatch,
never a code bug. Google shows it when the redirect URI Jamee sends does **not exactly
match** any URI listed under **Authorized redirect URIs** on the OAuth client. Check,
in order:

1. **The URI must be listed, character for character.** The exact value Better Auth
   uses is:
   - locally: **`http://localhost:3000/api/auth/callback/google`**
   - in production: **`https://<your-domain>/api/auth/callback/google`**

   It must appear verbatim under **APIs & Services → Credentials → your OAuth client →
   Authorized redirect URIs**. `http` vs `https`, a trailing slash, `127.0.0.1` instead
   of `localhost`, or the wrong port all count as a mismatch. Add the local URI *and*
   the production URI to the same client (both can be listed).
2. **It must be the client whose id is in `GOOGLE_CLIENT_ID`.** If you have more than
   one OAuth client, editing the wrong one changes nothing. Confirm the client id shown
   in the console matches the `GOOGLE_CLIENT_ID` value in your environment.
3. **The client must be of type "Web application".** A "Desktop", "Android", or other
   client type does not accept these web redirect URIs. If the client is the wrong
   type, create a new **Web application** client and use its id/secret.
4. **Saved changes take a few minutes to apply.** After editing the authorized URIs,
   Google can take several minutes to propagate the change — wait and retry before
   assuming the URI is still wrong.

### Google sign-in: a tester cannot sign in at all (consent screen in Testing)

While the OAuth consent screen is in **Testing** status, **only the Google accounts
listed as test users can sign in** — everyone else is refused before reaching Jamee.
Add each tester's Google account under **OAuth consent screen → Test users**. This is
expected for a pilot; publishing the app is not required to let a listed test user in.

### The name and support email a farmer sees on the Google screen

The application name and the support email shown on Google's own consent/sign-in screen
come from the **Branding** page of that Google Cloud project (**APIs & Services →
OAuth consent screen → Branding**), not from anything in Jamee's code or environment.
If a farmer sees the wrong app name or a missing support email on the Google screen,
edit it there.

---

## Verifying a deployment

- `npm run db:setup` prints **5 seeded conditions**, the GridFS bucket, and the
  collections with their indexes and validators.
- A POST to `/api/telegram` without the secret header returns **401**.
- The pay → link → photo sequence at step 9 completes, and a photo sent before
  linking/recharging is correctly gated.
- The retention sweep endpoint rejects any request without the `CRON_SECRET` bearer.
