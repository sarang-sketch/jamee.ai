# About Jamee

A short, plain-language guide for a teacher or reviewer. It explains what Jamee is,
what it is built from, how the small weekly payment works, and how to run it. The
full engineering detail lives in the specification folder
`.kiro/specs/jamee-crop-disease-detection/` (`requirements.md`, `design.md`,
`tasks.md`); this file is the friendly overview.

> One-line history note: this project began on Supabase and was moved to MongoDB
> partway through, at the teacher's instruction. Everything below describes the
> current MongoDB version — the earlier Supabase version is history, not a feature.

---

## What Jamee does

Jamee helps a farmer find out what disease might be affecting a tomato or potato
plant, and what to do about it — in English, Hindi, or Marathi.

A farmer signs in with their Google account, takes a photo of a diseased leaf, and
Jamee replies with:

- a likely disease (or an honest "not sure — please see an expert"),
- how serious it looks,
- a confidence level, and
- a plain-language explanation they can act on.

They can then ask follow-up questions by text or by a short voice note, and the
answer stays connected to the photo they just sent. All of a farmer's past
diagnoses are kept in a history list they can scroll back through.

Two ideas guide the whole design:

- **Nothing about farming is made up.** Jamee does not train its own AI. A
  general-purpose AI model looks at the photo and suggests a candidate disease, but
  every symptom, cause, treatment, and prevention sentence a farmer reads comes from
  a small, human-checked knowledge base of five conditions (Tomato Early Blight,
  Tomato Late Blight, Tomato Healthy, Potato Early Blight, Potato Late Blight). If
  the AI suggests anything outside those five, Jamee discards it and tells the
  farmer to consult an expert. The AI is only ever used to translate and reword
  verified facts into the farmer's language.
- **It costs almost nothing to run.** Jamee runs on free tiers, sized for a small
  pilot of about six farmers. There is no standing bill.

---

## The stack — what Jamee is built from

| Piece | What it is | What it does in Jamee |
| --- | --- | --- |
| **Next.js** (React) | The web framework | The website farmers use, and the small server-side API behind it. Hosted on Vercel. |
| **MongoDB Atlas (free M0)** | A cloud database | Stores every farmer's profile, diagnoses, and messages. The single free cluster holds about 512 MB. |
| **MongoDB GridFS** | File storage inside that same database | Stores the crop photos and voice recordings farmers send. |
| **Better Auth with Google sign-in** | An authentication library | Lets a farmer sign in with their Google account. No passwords, and no phone numbers. Its records live in the same MongoDB database. |
| **Google Gemini** | An AI model | The main model that looks at photos and writes explanations. |
| **Groq** | A second AI service | The **fallback** when Gemini is busy, and the service that turns voice notes into text. |
| **Telegram bot** | A chat bot | A second way for a farmer to reach Jamee — they can message the bot instead of opening the website. |
| **Razorpay (test mode)** | A payment service | Handles the small weekly payment that unlocks the Telegram bot. It runs in **test mode**, so no real money moves during the pilot. |

Because Jamee is an academic project, Razorpay is configured in **test mode**
everywhere: testers use test cards and no real money is charged. Razorpay only ever
charges a small per-transaction fee out of a payment a farmer actually makes — it
adds no fixed or monthly cost to Jamee.

---

## The website is free; the Telegram bot needs a small weekly recharge

The **website is completely free**. A farmer can sign in with Google and use every
feature — photos, chat, voice, history — without paying anything, ever.

The **Telegram bot** is the only part behind a small payment: a farmer pays
**₹20 (twenty rupees) for 7 days** of bot access. When the seven days are up, they
recharge again for another ₹20. Recharging early simply adds seven more days on top
of the days they already have, so nobody loses time they paid for.

To use the bot, a farmer first links their Telegram account to their Jamee (Google)
account from the website, then recharges. After that, messaging the bot works just
like the website.

---

## How to run it on your own laptop

You need Node.js version 22.12 or newer (or 24+).

```powershell
# 1. Install the dependencies
npm install

# 2. Create your settings file
#    Copy .env.example to .env.local, then fill in each value.
#    .env.example explains, line by line, where every value comes from.
#    Never put a real key or password into .env.example itself — only into .env.local.

# 3. Set up the database (creates the collections, indexes, and the five knowledge rows)
npm run db:setup

# 4. Start the website
npm run dev            # then open http://localhost:3000
```

**Signing in on a laptop.** Google sign-in needs two things set up in the Google
Cloud Console: the redirect address
`http://localhost:3000/api/auth/callback/google`, and your own Google account added
as a **test user** on the OAuth consent screen. Without the test-user step Google
will refuse to sign you in.

**Using the Telegram bot on a laptop.** Telegram cannot send messages to a laptop
directly (a laptop has no public web address). So in a **second terminal** you run:

```powershell
npm run telegram:poll
```

This little program fetches the bot's messages and feeds them to your local website,
so the bot works during development.

**Recharging on a laptop.** In test mode the Razorpay checkout finishes on the
laptop, and Jamee's server then confirms the payment by asking Razorpay's API
directly — so the ₹20 recharge works locally without any extra setup. (On a real
deployed website Razorpay also sends a confirmation message called a "webhook", but
that is only needed in production, not on a laptop.)

The full, step-by-step deployment instructions — including putting Jamee on the
internet with Vercel — are in `docs/DEPLOYMENT.md`.

---

## Where to read more

| Document | What is in it |
| --- | --- |
| `docs/DEPLOYMENT.md` | Step-by-step instructions to run Jamee locally and to deploy it to the internet. |
| `docs/TESTING_REPORT.md` | The record of what was tested and what still needs a human tester. |
| `docs/VERIFIED_VALUES.md` | The facts about each outside service (Google, Gemini, Groq, Telegram, Razorpay, MongoDB) that Jamee's code relies on, each with its source. |
| `docs/API.md` | A technical description of the website's API endpoints. |
| `.env.example` | Every setting Jamee needs, with a note on where to get each one. |
| `.kiro/specs/jamee-crop-disease-detection/` | The full requirements, design, and task plan — the authority for everything. |
