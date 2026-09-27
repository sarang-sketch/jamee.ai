# Jamee testing report

Requirement 17.5 asks the deployment package for "a testing report recording the
outcome of the image, chat, voice, and Telegram test scenarios." This is that
document, rewritten under Amendment A3 (MongoDB, Google sign-in, Telegram, Razorpay)
and Amendment A2 (the weekly ₹20 recharge).

**Two rules govern everything below.**

1. **No number is invented here.** The automated-outcome sections are deliberately
   left as clearly-marked **placeholders** to be filled at **task 64** (the release
   gate), when the full suite is run against `mongodb-memory-server` in replica-set
   mode. A suite that has not been run at task 64 has no outcome, and nothing in this
   file is inferred from a green `npm test` that did not execute the code in question.
2. **The human-tester entries are the substantive deliverable, and every one is
   marked `OUTSTANDING`.** They give the steps and the expected observation, with a
   blank result field for a real tester to fill in. A coding agent cannot produce
   those observations, so it does not pretend to. Task 64 checks that every entry is
   either completed or explicitly outstanding.

> **Historical note.** An earlier version of this report carried automated counts
> from the Supabase/WhatsApp version of Jamee. Those are obsolete: the channel is now
> Telegram (not WhatsApp), the database is MongoDB (not Supabase), sign-in is Google
> (not phone OTP), and the integration suite runs on an in-memory MongoDB replica set
> (not a local Supabase stack). This report is reset to placeholders for the A3
> release rather than carrying forward numbers that no longer describe the code.

---

## Part 1 — Automated results (PLACEHOLDER — to be filled at task 64)

> **These tables are placeholders. Do not quote them as results.** They are filled in
> at task 64 by running the suite and pasting the measured counts. Until then every
> result cell reads `TO BE FILLED AT TASK 64`.

### 1.1 The run

The command is `npm test` (`vitest run`), all three projects, from the repository
root. Record the exact counts the run prints — never a remembered or estimated
number.

| | Files | Tests | Passed | Skipped | Failed | Duration | Exit code |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Total** | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 |

Per project:

| Project | Command | Files | Tests | Result |
| --- | --- | --- | --- | --- |
| `unit` | `npm run test:unit` | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 |
| `property` | `npm run test:property` | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 |
| `integration` | `npm run test:integration` | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 |

**The integration suite runs on `mongodb-memory-server` in replica-set mode (V31,
V33)** — a single-node replica set started in-process, needed because the linking and
payment operations use multi-document transactions. It no longer needs Docker or a
local Supabase stack, and it no longer reads `JAMEE_TEST_DATABASE_URL`. **A run that
executed zero integration tests is a broken gate, not a pass** (the first-run binary
download aside): record it as a failure to configure, not as coverage.

### 1.2 The per-scenario automated suites (PLACEHOLDER)

Task 63.3 asks this document to record the automated outcomes of the **image, chat,
voice, Telegram, linking, and payment** scenario suites. Fill each result at task 64
from the actual run; do not infer an outcome.

| Scenario suite | What it exercises (through real services, validation, persistence, owner-scoping) | Result |
| --- | --- | --- |
| Image diagnosis | photo → analysis → knowledge grounding → persisted diagnosis; inconclusive path; quota spend | TO BE FILLED AT TASK 64 |
| Chat | follow-up questions grounded to the prior diagnosis; out-of-scope refund path | TO BE FILLED AT TASK 64 |
| Voice | voice note → transcription (Groq) → answer in the farmer's language | TO BE FILLED AT TASK 64 |
| Telegram channel | text / photo / voice / unsupported / duplicate (`update_id` claim) / timeout / rate-limit fallback; unlinked sender; lapsed-window sender | TO BE FILLED AT TASK 64 |
| Linking | valid / expired / consumed / unknown / no-payload / already-linked-elsewhere; two concurrent deliveries of one token | TO BE FILLED AT TASK 64 |
| Payment | abandoned checkout; replayed webhook; forged signature; captured payment opening a lapsed sender; a recharge extending the window; unauthenticated flood | TO BE FILLED AT TASK 64 |
| Tenant isolation | cross-farmer reads return nothing and cross-farmer writes fail, across every collection and GridFS | TO BE FILLED AT TASK 64 |

### 1.3 Correctness properties (PLACEHOLDER)

The property project asserts the 36 correctness properties (A3 re-vocabularised
several from RLS/Storage terms to the Data_Access_Layer / GridFS substrate, A2
inverted Property 34's "no expiry", and Property 36 — recharge extension arithmetic —
is new). Record the file/test counts and the pass result at task 64.

| | Files | Tests | Result |
| --- | --- | --- | --- |
| `property` | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 | TO BE FILLED AT TASK 64 |

---

## Part 2 — Human-tester checklist (every entry OUTSTANDING)

These observations can only be made by a person on a real device. Each entry names
the steps and what a passing result looks like; the **Result** field is left blank and
the **Status** is **OUTSTANDING** until a tester fills it in. Task 64 requires every
entry to be either completed or explicitly outstanding — an outstanding entry is a
valid release-gate state, an *empty* one is not.

### H-1 — Google sign-in, including the cancel path — OUTSTANDING

- **Steps:** On a real device, sign in with a Google test-user account and confirm a
  session is established and the profile screen loads. Then sign out, start sign-in
  again, and **cancel** at Google's consent screen.
- **Expected:** the successful sign-in lands the farmer in the app; the **cancelled**
  sign-in returns to Jamee with no session, a clear "sign-in was cancelled" state, and
  no half-created profile.
- **Result:** _(to be filled by tester)_
- **Status:** OUTSTANDING

### H-2 — Telegram end to end, in the fixed order pay → link → photo — OUTSTANDING

- **Steps:** As one farmer, in this order: (1) recharge ₹20 on the website in test
  mode; (2) link Telegram via the profile deep link and `/start`; (3) send a photo to
  the bot. Separately, confirm the gate: as a farmer who has **not** yet linked and
  recharged, send a photo **first** and observe the reply.
- **Expected:** after pay → link, the photo returns a diagnosis; a photo sent before
  linking/recharging correctly returns the **gated** reply (link first, then the
  one-recharge-needed message with the ₹20 price and where to pay), not a diagnosis,
  and spends nothing.
- **Result:** _(to be filled by tester)_
- **Status:** OUTSTANDING

### H-3 — One real checkout in test mode — OUTSTANDING

- **Steps:** Complete **one** Razorpay checkout in **test mode** with a test card, for
  a farmer whose Telegram sender was previously gated or whose 7-day window had lapsed.
- **Expected:** the captured payment records the entitlement, extends the window by 7
  days from `max(now, current expiry)`, and **opens the previously gated/lapsed
  sender** so the next Telegram message is served. A redelivery of the same payment
  does not extend the window twice. No real money moves.
- **Result:** _(to be filled by tester)_
- **Status:** OUTSTANDING

### H-4 — Hindi and Marathi transcription quality — OUTSTANDING

- **Steps:** Record real voice notes in **Hindi** and in **Marathi**, including some
  with background/field noise, and send them through the voice path (web and Telegram).
- **Expected:** the transcription is faithful enough that the grounded answer is
  correct and in the same language; note any systematic mishearing.
- **Result:** _(to be filled by tester)_
- **Status:** OUTSTANDING

### H-5 — Screen-reader and accessibility pass — OUTSTANDING

- **Steps:** Navigate sign-in, diagnose, chat, voice, history, and the profile/link/pay
  screens with a screen reader on a real mobile device, in all three languages.
- **Expected:** every control is reachable and announced; images have meaningful
  labels; the diagnosis result and the recharge/link status are announced; nothing is
  keyboard/focus-trapped; Devanagari text is not clipped.
- **Result:** _(to be filled by tester)_
- **Status:** OUTSTANDING

---

## Part 3 — How to read this report

- **Part 1 is placeholders until task 64.** Fill each cell from a real run; never
  quote a placeholder as a result, and never invent a count.
- **Part 2 stays outstanding until a human performs it.** An empty result field means
  the step was not performed — not that it was performed and not recorded.
- The authority for what must pass is the task-64 release gate in `tasks.md`; this
  document records the outcomes, it does not define the bar.
