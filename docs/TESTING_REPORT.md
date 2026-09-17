# Jamee testing report

Requirement 17.5 asks the deployment package for "a testing report recording the outcome of the
image, chat, voice, and WhatsApp test scenarios." This is that document.

**Two rules govern everything below.**

1. **A suite that was not written has no outcome, and a suite that was skipped did not pass.** Every
   row that has no result says so in those words, and names what does exist instead. Nothing in this
   file is inferred from a green `npm test` that never executed the code in question.
2. **The human-tester entries are deliberately empty.** They are the substantive deliverable of this
   document: the steps, the expected observation, and a blank result field for a tester to fill in.
   A coding agent cannot produce those observations, so it does not pretend to. Task 32 (release
   readiness) checks that every one of them is either completed or explicitly outstanding.

Automated results recorded at commit **`5d4aca2`**. The counts below are a snapshot: the repository
is under active development, and this section has now been superseded twice.

1. Sections 1.1 to 1.3 were rewritten on 2026-09-17 after tasks 29.2–29.5 (the four per-channel
   scenario suites), 28.5, 35.2 and 26.3 landed, all of which the earlier text recorded as
   unimplemented — the gap moved from *unwritten* to *unexecuted*.
2. The same sections were rewritten again at `5d4aca2`, which is **the first commit at which the
   integration suite has actually been executed against a live stack: 104 tests across 9 files, all
   passing.** The gap moved from *unexecuted* to *executed once, locally*. What that first run found
   is in section 1.2, and it is the most useful paragraph in this document.

Re-run the commands in section 1.1 before quoting a number.

---

## Part 1 — Automated results

### 1.1 The run

`npm test` (`vitest run`), all three projects, from the repository root. **The suite is 95 files and
1780 tests, and the outcome depends on one environment variable**, so both runs are recorded — a
number quoted without saying which run it came from is the mistake this table exists to prevent.

**With `JAMEE_TEST_DATABASE_URL` exported and a live local stack** — the complete result:

| | Files | Tests |
| --- | --- | --- |
| **Total** | **95** | **1780** |
| Passed | **95** | **1780** |
| Skipped | 0 | 0 |
| Failed | 0 | 0 |

Duration 23.92 s. Exit code 0.

**Without it** — what a clone with no stack sees, and what CI's job 1 sees:

| | Files | Tests |
| --- | --- | --- |
| **Total** | **95** | **1780** |
| Passed | 86 | 1676 |
| Skipped | 9 | 104 |
| Failed | 0 | 0 |

Duration 16.31 s. Exit code 0 — see the warning in section 1.3 about what that zero does and does
not mean.

Per project:

| Project | Command | Files | Tests | Result |
| --- | --- | --- | --- | --- |
| `unit` | `npm run test:unit` | 55 | 1559 | all passed |
| `property` | `npm run test:property` | 31 | 117 | all passed |
| `integration` | `npm run test:integration` | 9 | 104 | **all passed** against a live local stack; **all skipped** when `JAMEE_TEST_DATABASE_URL` is absent |

The integration project is the whole of the difference between the two runs: every one of the 9
files and 104 tests that can skip is its own. Section 1.3 lists them and gives the commands.

**Vitest does not read `.env.local` for this.** The gate in `tests/integration/database.ts` reads
`process.env`, and nothing in `vitest.config.ts` loads a dotenv file — so a `JAMEE_TEST_DATABASE_URL`
line sitting in `.env.local` is *not* enough, and a run that looks correctly configured still skips.
The variable has to be exported into the shell that invokes `npm test`. That is the single most
common way to get 1676 while believing you got 1780.

**All 31 correctness properties are now asserted.** The `property` project has grown from one wiring
smoke test to 31 files, and the mapping is one file per property with no gaps: Property 1 →
`identity`, 2 → `auth-gate`, 3 → `media-admission`, 4 → `upload-boundary`, 5 → `storage`,
6 → `schemas`, 7 → `rejection`, 8 and 9 → `inconclusive`, 10 → `grounding`, 11 → `chat-grounding`,
12 → `healthy`, 13 → `canonical-name`, 14 → `referral`, 15 → `chat-context`, 16 → `followup`,
17 → `persistence`, 18 → `voice`, 19 → `language`, 20 → `quota`, 21 → `gateway`, 22 → `audit`,
23 → `webhook`, 24 → `inbound-routing`, 25 → `channel-parity`, 26 → `history`,
27 → `tenant-isolation`, 28 → `burst-order`, 29 → `errors`, 30 → `deliverable`, 31 →
`deletion-isolation`. `tests/property/harness.test.ts` is still there and still just the wiring
smoke test.

What the property project does *not* do is exercise a database: the providers are stubbed at the
adapter seam and the stores are structural stand-ins, so a property holds over the pure logic and
says nothing about a policy evaluated in Postgres. That is section 1.3's territory.

**One property's provenance is worth recording, since a reader will hit it going the other way.**
`design.md` now carries `### Property 31: Tenant isolation holds over deletion`, immediately after
Property 30 and marked `**Validates: Requirement 18.8**`. The entry was missing when this section
was first written, and that gap is closed. What remains true is where the statement came from: it
was **reconstructed, not originally authored**. The number entered the design with the
media-lifecycle amendment, which closed its RLS discussion with a forward reference and nothing
else, and task 35.2 then named "Property 31: Tenant isolation holds over deletion" in `tasks.md`;
the statement itself was derived from **Requirement 18.8** and the sweep's deletion anchors. So it
is a faithful restatement of requirements already written down rather than an independently
specified one, and a reviewer should read it as such. The reconstruction and its reasoning are
recorded in `design.md` beneath the entry and in the header of
`tests/property/deletion-isolation.property.test.ts`.

### 1.2 The four per-channel scenario suites: all four are written, and all four have now passed

Task 30.1 asks this document to record "the outcomes of the image, chat, voice, and WhatsApp
automated scenario suites." Those suites are tasks 29.2–29.5, and **all four now exist and all four
pass.** This section has been rewritten twice, and the trajectory is the point:

| This section said | Was true | Bottom line then |
| --- | --- | --- |
| none of the four suites exists | before 29.2–29.5 landed | nothing to record |
| all four exist, none has been executed | after they landed, before `5d4aca2` | still nothing to record — the project self-skipped without a database URL |
| **all four exist and all four pass** | **at `5d4aca2`** | **41 of the 104 integration tests are these four suites, and all 104 passed** |

The distinction this section has always drawn still stands and is the reason the suites exist: unit
tests with stubbed collaborators are a different claim from the same scenarios through real
services, real validation, real persistence and real RLS. What changed at `5d4aca2` is that the
second kind has an outcome.

**What the first execution found, which is the lesson worth carrying forward.** These suites were
written, committed, and reported green for a long stretch without ever running a line — and that
stretch is exactly what let **two live defects survive inside the test code itself**, invisible to
every gate:

1. **A 73-byte bcrypt password in the test-farmer fixture.** bcrypt truncates at 72 bytes; the
   fixture's password was one byte over, so signing a test farmer in could not work. Nothing caught
   it because nothing had tried.
2. **A `from_phone` filter written in the `+`-prefixed E.164 form** in
   `whatsapp-scenarios.test.ts`, while `claimInbound()` stores Meta's `wa_id` verbatim, *without*
   the `+`. The predicate matched **zero rows**, so the assertion it guarded could never fail. It
   was not a failing test. It was an **unfalsifiable** one, which is worse: a failing test is a red
   tick, and an unfalsifiable one is a green tick that means nothing. `5d4aca2` fixed it with a
   single `inboundWaId()` binding.

Both defects were in test code, both were reachable only by running it, and both had been sitting
under a green `npm test` the whole time. **The generalisation: a suite that has never executed is
not coverage, and the number of tests in it tells you nothing about how many of them could ever
fail.** Read the third rule at the top of this document as being about this, and note that the same
reasoning still applies to everything in Parts 2, 3 and 5 — those are unexecuted procedures, and
their line counts are not evidence either.

A closely related instance of the same bug class **is still open** in
`tests/integration/idempotency.test.ts`, which writes `from_phone` in the `+` form at two places
while `claimInbound()` writes it without. It passes today only because those rows are inserted and
read back by primary key, so nothing filters on `from_phone` — the first predicate anyone adds will
match zero rows and look like a passing test. Fixing it is not a documentation change and is not
done here.

| Suite | File | Tests | Cases it covers |
| --- | --- | --- | --- |
| **29.2 image** | `tests/integration/image-scenarios.test.ts` | 10 | clear diseased crop grounded in its seeded row · healthy crop at severity `none` with no treatment content · blurry image the model declines → the inconclusive shape, one unit spent, no second model call · non-plant image → asks for a photo of the affected crop · a real condition the knowledge base does not cover → expert referral repeating none of the guessed name · tomato and potato grounded in their own rows · several leaves → exactly one condition asked for and reported, a two-condition classification refused · one image unit per scenario, every row attributed to this farmer |
| **29.3 chat** | `tests/integration/chat-scenarios.test.ts` | 10 | English question grounded through the conversation's diagnosis, with the earlier turn carried forward (Requirement 7.1) · Hindi and Marathi answered in kind with the canonical name unchanged across all three · subject-less follow-up resolved from the most recent diagnosis, and *referred* when there is no diagnosis to resolve against · a crop Jamee does not cover → coverage limit stated, expert recommended, no model call, nothing spent · knowledge base answering nothing → says it holds no verified information · one row per turn, only grounded turns spent, nothing leaked |
| **29.4 voice** | `tests/integration/voice-scenarios.test.ts` | 9 | short recording → transcript plus answer, one voice unit, original deleted · exactly 120 s accepted · one second past → declined with both limits stated and nothing spent · one byte past the ceiling → the size code, not the duration one · empty and whitespace-only transcripts → asks for a quieter recording, keeps the object, spends the unit, calls no chat · noisy transcript preserved verbatim and still answered · a transcription the provider could not deliver → `TRANSCRIPTION_FAILED` rather than a diagnosis timeout, object retained |
| **29.5 WhatsApp** | `tests/integration/whatsapp-scenarios.test.ts` | 12 | inbound image → downloaded, stored in `crop-images`, diagnosed, reply matched against the shared formatter · inbound text → answered through the ChatService in that farmer's active WhatsApp conversation · inbound audio → stored in `voice-messages`, transcribed, answered; `aac`/`amr` refused before a byte is downloaded · unsupported type → the accepts-photos-text-and-voice reply, nothing spent · redelivery → acknowledged with nothing downloaded, invoked or spent · expired soft deadline → send-again reply, timeout recorded, no work started, and every message of an expired batch answered · rate limit on the primary model → retried on the fallback and still answered · both providers failing → temporarily-busy reply and a recorded failed delivery · every delivery on the `whatsapp` channel, nothing leaked to the other farmer |

Every specific case this section once listed as "covered at the integration level nowhere" — the
blurry image, the non-plant image, multiple leaves, the unknown question, the 120 s boundary, the
noisy transcript, the invalid WhatsApp type, the duplicate delivery, the soft-deadline timeout, the
provider rate limit driving the fallback — is in the table above, and **all of them have now been
observed passing** in the `5d4aca2` run. Section 1.3 has the commands that reproduce it.

The unit-level coverage those channels also have is unchanged and still worth knowing about, because
it is the coverage that *did* execute: `src/services/diagnosis.service.test.ts` (32),
`src/services/chat.service.test.ts` (60), `src/services/voice.service.test.ts` (28),
`src/lib/whatsapp.test.ts` (124), `src/lib/whatsapp-dispatch.test.ts` (52),
`src/lib/ai/gateway.test.ts` (43), `src/lib/prompts.test.ts` (67), and the route and component tests
beside them. Providers are stubbed at the adapter seam in all of them, so they say nothing about
wiring or policy.

Also relevant, and also changed since this section was written:

- **Task 28.5** (Property 30, deliverable completeness) — **implemented**, as
  `tests/property/deliverable.property.test.ts` (5 tests, passing). It is a property test, not an
  integration one, so it ran.
- **Task 35.2** (Property 31, tenant isolation over deletion) — **implemented**, as
  `tests/property/deletion-isolation.property.test.ts` (7 tests, passing). Section 1.1 records that
  `design.md` now carries the Property 31 entry and that its statement is a reconstruction.
- **Task 31.1** (the automatable release-acceptance sequence) — implemented, and as of `5d4aca2`
  **its 7 tests have executed and passed.** It remains subject to section 1.3's gate, so it reports
  as skipped on a machine with no stack.
- Three further integration suites exist beyond the six named so far —
  `tests/integration/idempotency.test.ts` (10), `knowledge.test.ts` (22) and
  `quota-atomicity.test.ts` (11) — gated identically, and passing in the same run.

### 1.3 The integration project self-skips, and first ran against a live database at `5d4aca2`

`tests/integration/database.ts` gates every integration suite behind `describeIntegration`, which
is `describe` when `JAMEE_TEST_DATABASE_URL` is set and `describe.skip` otherwise. The reasoning is
sound — a developer with no local stack still gets a green run, and CI opts in — but it has a
consequence this document has to state plainly, and which does not go away now that the suite has
run once:

> **`npm test` reporting green on a machine with no local Supabase stack does not mean the
> integration suite passed. It means the suite did not execute.**

That warning held for the whole life of this record until `5d4aca2`, and section 1.2 records the two
defects it hid. **The state now: all 104 integration tests across all 9 files have been executed
against a live local Supabase stack and all 104 passed.** On a machine with no stack the same 104
still report as skipped, so the sentence above is still the one to read before quoting a green tick.

| File | Tests | Result at `5d4aca2` | What it asserts |
| --- | --- | --- | --- |
| `harness.test.ts` | 13 | passed | the seeded knowledge base, the profile trigger, and cross-farmer RLS on `profiles`, `diagnoses` and `usage_logs` (task 29.1) |
| `image-scenarios.test.ts` | 10 | passed | task 29.2's image matrix — see section 1.2 |
| `chat-scenarios.test.ts` | 10 | passed | task 29.3's chat matrix |
| `voice-scenarios.test.ts` | 9 | passed | task 29.4's voice matrix, boundaries included |
| `whatsapp-scenarios.test.ts` | 12 | passed | task 29.5's WhatsApp matrix, including redelivery and the fallback |
| `knowledge.test.ts` | 22 | passed | the five verified conditions, their sources, and grounded lookup against the real rows |
| `quota-atomicity.test.ts` | 11 | passed | the `0007` counter functions under concurrency — a race no stub can reproduce |
| `idempotency.test.ts` | 10 | passed | a redelivered WhatsApp message doing its work exactly once, at the database |
| `release-acceptance.test.ts` | 7 | passed | the automatable half of the release acceptance sequence (task 31.1) |
| **Total** | **104** | **104 passed** | |

**One execution against one local stack is one data point, not a standing guarantee.** Nothing
re-runs this automatically: CI has never executed (no git remote is configured), so the only thing
keeping this row green is a human remembering to export the variable. A regression here reports as
*skipped*, not as *failed*, on every machine that does not.

Three of these are only meaningful against a real Postgres and have no unit-level equivalent
anywhere: the cross-farmer RLS reads in `harness.test.ts`, the counter concurrency in
`quota-atomicity.test.ts`, and the exactly-once redelivery behaviour in `idempotency.test.ts`. A
policy and a race are properties of the database, not of the code that calls it.

**`tests/integration/harness.test.ts` — 13 tests, all passed.** It asserts: exactly the
five verified conditions seeded with sources (Requirements 4.1, 4.2), `Tomato Healthy` carrying no
treatment content (3.4), a farmer session failing to write `disease_knowledge` (13.4), a profile per
farmer keyed to the auth user id and carrying the E.164 phone (1.4), owner-reads-yes /
other-farmer-reads-zero on `profiles`, `diagnoses` and `usage_logs` (13.1, 13.2), a refused
cross-owner insert, and the 0007 quota counter functions round-tripping. **The cross-farmer RLS
reads are the assertions the whole harness exists for** — no fake client can stand in for a policy
evaluated in Postgres — and they are now observed, not assumed. Signing its test farmers in is also
what surfaced the 73-byte bcrypt password of section 1.2.

**`tests/integration/release-acceptance.test.ts` — 7 tests, all passed.** Task 31.1's suite: the
release acceptance sequence as far as a machine can walk it, as one continuous path through one
farmer's data rather than seven independent scenarios.

| Test | Acceptance step |
| --- | --- |
| grounds an uploaded crop image in the seeded row of the name it reported | 2 |
| answers a subject-less follow-up against that conversation diagnosis | 3 |
| returns Hindi and Marathi explanations with the canonical name unchanged | 4 |
| returns a transcript and a text answer for one voice unit | 5 |
| lists the web and WhatsApp diagnoses together, newest first | 7 |
| opens the detail view of one entry with every field it renders | 7 |
| traces every agricultural sentence of the whole run to a seeded row | 8 (observable half) |

Steps **1** and **6** are absent from it by design — they are the human-tester items in Part 5.
Step 8's "no model training" half is absent because it is the *absence* of a call, which nothing
observable at runtime can witness; `npm run check:shared-implementation` asserts it statically
(section 1.4).

This suite and the four scenario suites beside it were the largest single block of unverified
behaviour in the release: together they are the only automated checks that grounding, follow-up
resolution, language handling, the voice round trip, WhatsApp delivery, quota atomicity, redelivery
and cross-channel history work end to end. That block grew from 20 tests when this section was first
written to 104, and at `5d4aca2` it moved from *unexecuted* to *executed and green*. **On any machine
where the variable is not exported it reverts to unverified**, which is the whole reason the two
sub-tables in section 1.1 are kept side by side.

**To run it.** The sequence `tests/integration/database.ts` documents, with one correction it has not
yet absorbed — the repository **now ships `supabase/config.toml`**, so step 1 is a no-op on a fresh
clone and `supabase init` would only offer to overwrite a real config. Skip it unless `supabase
start` complains that the project is not initialized:

```sh
# 1. Only if supabase/config.toml is missing — it is committed, so normally it is not.
#    If you do run it, answer "N" to overwriting anything under supabase/ .
npx supabase init

# 2. Start Postgres, Auth, PostgREST and Storage, then apply supabase/migrations in order.
#    `db reset` is what seeds the five verified conditions (migration 0010).
npx supabase start
npx supabase db reset

# 3. Print the URL and keys the harness reads.
npx supabase status -o env
```

Then in `.env.local`:

```
JAMEE_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY from step 3>
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from step 3>
```

**Two corrections to that block, both learned from the run that produced this section's result.**

- **Take the ports from step 3's output, not from the two literals above.** They are the Supabase
  defaults and are right on a machine with no competing stack, but the committed
  `supabase/config.toml` may move them — read its header before assuming. Getting this wrong is not
  a test failure: the suite quietly talks to whichever stack owns the port, and a `db reset` against
  the wrong URL destroys that other project's data. `supabase/config.toml`'s header says this at
  length and is worth the two minutes.
- **`.env.local` alone does not arm the gate.** Nothing loads it into `process.env` for a vitest run
  (section 1.1). The variables have to be exported into the shell that invokes the command.

`npm run test:integration` then runs it. **Never set `JAMEE_TEST_DATABASE_URL` in production.**

Note the deliberate asymmetry in the gate: a *missing* database URL skips; a database URL *present
alongside missing keys* throws with instructions, because that is a half-finished setup rather than
a machine without a stack.

**CI is wired to run this suite for real, and has still not done so.** The first real run was local,
not automated. `.github/workflows/release-gates.yml` has a second job that installs the Supabase CLI,
initializes the project *only if no config is committed*, runs `supabase start`, exports the stack's
values into `JAMEE_TEST_DATABASE_URL` and the key variables, runs `npm run test:integration`, and then
**reads the JSON report and fails when zero tests executed** — so a broken stack cannot pass as
coverage. That job has never executed, because **no git remote is configured**, so no Actions run
exists to confirm it.

Two of that job's own comments are now behind the repository. They say the repo ships no
`supabase/config.toml`; it does, as of `5d4aca2`. And the first-run adjustment they anticipate — some
stacks refusing a phone on the admin create endpoint until the phone provider is enabled under
`[auth.sms]` — is **already applied in the committed config**, which sets `[auth.sms] enable_signup =
true` (with the Twilio provider left disabled, so nothing is ever sent). The job's conditional init
step steps aside when a config is present, so its behaviour is right even where its comments are not.
Honest status: **the mechanism that turns "skipped" into a real result works — it has been walked by
hand — and the CI copy of it is still unexecuted.**

Result of the gated run:

| Field | Value |
| --- | --- |
| Date executed | first passing run committed as **`5d4aca2`**; reconfirmed at that commit |
| Stack (local CLI version / hosted project) | local stack, Supabase CLI **2.117.0**, Postgres major 17, ports per the committed `supabase/config.toml` |
| Files / tests / passed / failed | **9 / 104 / 104 / 0** — exit code 0, 13.3 s |
| `harness.test.ts` — cross-farmer RLS reads returned zero rows | **yes** — the other farmer's `profiles`, `diagnoses` and `usage_logs` reads all returned zero, and the cross-owner insert was refused |
| `harness.test.ts` — five seeded conditions present, quota functions round-tripped | **yes** — all 13 tests in the file passed |
| `release-acceptance.test.ts` — steps 2, 3, 4, 5, 7, 7, 8 outcome each | **all 7 passed** |
| Notes | Two defects in the test code itself surfaced on the first execution and were fixed in `5d4aca2` — the 73-byte bcrypt fixture password and the `+`-prefixed `from_phone` filter (section 1.2). Neither was a defect in the application. `tests/integration/idempotency.test.ts` still carries the second pattern in a position where nothing filters on it yet. **This was one local run; nothing re-runs it automatically.** |

### 1.4 Static guards that did run

Two checks assert codebase properties rather than behaviour, and both are green (Part 6):

- `npm run check:secret-scope` — secrets stay server-side, one door to `process.env`, service-role
  queries anchored. Covered by `tests/unit/check-secret-scope.test.ts` (48 tests). It proves secret
  **variable names** stay on the server side; it cannot detect a service-role *value* pasted into a
  `NEXT_PUBLIC_` variable. That remains a human check — see `docs/DEPLOYMENT.md`, step 1 hazard note.
- `npm run check:shared-implementation` — one `DiagnosisService`, one `ChatService`, the one-way
  import rule, and no model-training calls anywhere. Covered by
  `tests/unit/check-shared-implementation.test.ts` (77 tests). This is the static half of release
  acceptance step 8: absence of a training call is a codebase property, so it is asserted here
  rather than at runtime.

`tests/unit/api-docs.test.ts` (88 tests) asserts `docs/API.md` against the route handlers, so the
API documentation cannot drift from the endpoints it describes (Requirement 17.4).

`tests/unit/mobile-layout.test.ts` (87 tests) is the static half of the device pass in Part 3.2. It
reads CSS declarations across `src/app` and `src/components` — a Devanagari leading floor of 1.35, a
tap-target floor of 2.75rem, relative units for body text, no time-based progress animation. It
cannot tell you that a control *renders* at 44 px on a handset, only that nothing in the codebase
expresses a floor in a unit that would stop scaling. Part 3.2 is what confirms the rendered result.

### 1.5 The automated accessibility scan (task 26.3)

`tests/unit/accessibility.test.tsx` (26 tests) runs **axe-core 4.13.0** over each screen's rendered
DOM, in all three languages, and fails on any violation. It is in the `unit` project, so
`npm run test:unit` is the gate and CI needs no separate step — `.github/workflows/release-gates.yml`
asserts the engine and the file are still there rather than running a second scan of its own.

Rules: WCAG 2.0/2.1 level A and AA plus axe's best-practice set. Scanned: the sign-in, diagnose,
chat, voice and history screens, each as its real components inside a reproduced `<main lang>` +
`<h1>` shell, plus the states a static render cannot reach through interaction (the identified and
inconclusive result cards, the voice answer card, the error banner, the empty history state).

**It found one real defect, which is the reason to have it.** `DiagnosisResultCard` opened at `<h3>`
under `/diagnose`'s `<h1>`, skipping a level in the document outline — a screen reader user
navigating by heading would infer a section that was not there. It read correctly until task 26.2
removed the panel's off-screen `<h2>`, which left the skip behind with no test able to see it. Fixed
in the same change: the card is now `<h2>` and its knowledge sections `<h3>`, with no visual change
because the sizes come from the CSS module rather than the tag.

**Four things a green scan here does not establish**, and the run prints them itself on every pass:

| Not established | Where it is covered instead |
| --- | --- |
| **Contrast.** The `color-contrast` rule is explicitly disabled: Vitest applies no CSS module styles and jsdom implements no canvas, so the rule would evaluate nothing and merely log noise. | M4 in Part 2, by eye, against the WCAG 2.1 AA target |
| **Rendered geometry** — tap-target size, Devanagari leading, OS text scaling | section 1.4's stylesheet assertions, then M4 on a handset |
| **Whether an announcement is *useful*** rather than merely present — the right sentence, at the right moment, without doubling up | M4, with a real screen reader |
| **The diagnosis detail screen**, which nothing scans | see below |

The detail screen is the one screen task 26.3 names that this scan does not reach. Its markup is
written inline in `src/app/diagnosis/[id]/page.tsx`, an `async` server component that resolves a
session, a row, a knowledge row, a signed URL and a message thread before rendering; scanning it
would take either standing in for Jamee's own modules or rebuilding its markup in the test, and a
scan of a rebuilt copy would stay green while the screen regressed. Extracting that screen's
presentation into a module the page renders — the shape every other screen already has — would make
it scannable with one added entry, and that is a change to the detail screen rather than to its test.
The scan asserts the gap is still real: it fails if a second `.tsx` module appears under
`src/app/diagnosis`, so the day someone extracts one, the test says to wire it in.

**An automated scan is not WCAG conformance and cannot become one.** Full conformance needs M4's
manual screen-reader pass plus expert review, and neither this file nor any CI job can perform it.

---

## Part 2 — Human-tester matrix (four items)

Each entry below **requires a human tester and cannot be executed by a coding agent.** The result
fields are empty by design. Fill them in place; do not delete the steps.

---

### M1 — Real SMS OTP delivery through the configured provider

**Evidences:** Requirement 1.1 (*WHEN a visitor submits a phone number in E.164 format on the
sign-in screen, THE Auth_Service SHALL request delivery of an OTP by SMS to that phone number*), and
1.2/1.3 as a by-product.

**Why a coding agent cannot do this.** Delivery leaves the system entirely: it depends on a
configured SMS provider account (`docs/DEPLOYMENT.md` step 2), on carrier routing, and on a real
handset receiving a real message. Nothing in the codebase can observe an SMS arriving. Note also
that **U-V2 is unresolved** — the exact `type` argument for `verifyOtp` on the *sign-in* path was
never confirmed against a retrievable Supabase page — so this run is the first place a wrong value
would surface, and it surfaces as "the code never verifies."

**What the tester does.**

1. Confirm phone auth is enabled and an SMS provider is configured on the Supabase project (one of
   MessageBird, Twilio, Vonage, TextLocal — per V2 an SMS provider is mandatory, not optional).
2. On a real handset, open the deployed sign-in screen and submit your own number in E.164 format
   (`+91XXXXXXXXXX`).
3. Time how long the SMS takes to arrive. Record the sender id shown.
4. Enter the received 6-digit code. Confirm a session is established and you land on a signed-in
   screen rather than back on sign-in.
5. Sign out. Request a code again and enter a **wrong** code. Confirm the message says the code is
   incorrect or expired (Requirement 1.3) and that no session is created.
6. Immediately request a second code for the same number and note whether it is throttled — V2
   documents one OTP request per 60 seconds per user.
7. In the Supabase dashboard, confirm a `profiles` row now exists for that number with the phone
   stored in E.164 (Requirement 1.4).

**Record.**

| Field | Result |
| --- | --- |
| Date / tester | _(empty)_ |
| SMS provider configured | _(empty)_ |
| Handset + carrier | _(empty)_ |
| Number tested (masked) | _(empty)_ |
| SMS arrived — yes/no | _(empty)_ |
| Time from submit to arrival | _(empty)_ |
| Sender id displayed | _(empty)_ |
| Correct code established a session | _(empty)_ |
| `verifyOtp` type value that worked (resolves U-V2) | _(empty)_ |
| Wrong code produced the incorrect-or-expired message | _(empty)_ |
| Re-request throttling observed | _(empty)_ |
| `profiles` row present with E.164 phone | _(empty)_ |
| Verdict — pass / fail | _(empty)_ |

---

### M2 — Hindi and Marathi transcription quality on real farmer speech with field background noise

**Evidences:** Requirement 8.5 (*THE Voice_Service SHALL transcribe recordings spoken in English,
Hindi, or Marathi*), plus 8.7 (empty transcript asks for a re-record in a quieter place) and 15.7.

**Why a coding agent cannot do this.** An automated test can assert that a transcript comes back
non-empty and that a non-empty transcript reaches the Chat_Service. Whether the transcript is *what
the farmer said* is a judgement only a speaker of the language can make, and the input that matters
— an actual farmer voice, in a field, with wind, livestock, a tractor, other voices — cannot be
synthesized honestly. Using clean studio audio here would produce a pass that means nothing.

**What the tester does.** Needs at least one native Hindi speaker and one native Marathi speaker,
recording outdoors on a real handset, not in a quiet room.

1. Prepare six questions per language — three about a visible leaf symptom, three general crop-care
   questions — phrased the way a farmer would actually say them, not in textbook register.
2. For each, record on the voice screen outdoors with audible background noise. Note the approximate
   noise source and level.
3. For each, write down **what was said** and **what the transcript shows**, then rate the
   transcript: *accurate* / *understandable but wrong words* / *wrong meaning* / *empty*.
4. Include one deliberately near-silent recording and confirm the empty-transcript path asks you to
   record again somewhere quieter (Requirement 8.7).
5. Include one recording at roughly the 120-second boundary and confirm the recorder stops itself
   and the countdown was visible from 100 seconds.
6. Separately judge **readability**: is the answer that comes back plain language a smallholder
   farmer would use, or does it read as translated? Note any sentence that reads as machine output.
7. Confirm the canonical condition name appears in **Latin script**, unchanged, inside the
   Devanagari answer (Requirements 4.6, 9.4).

**Record** (one row per recording; the table below is the header plus one empty row).

| # | Language | Noise source / level | What was said | Transcript returned | Rating | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | _(empty)_ | _(empty)_ | _(empty)_ | _(empty)_ | _(empty)_ | _(empty)_ |

| Summary field | Result |
| --- | --- |
| Date / testers (hi, mr) | _(empty)_ |
| Handset(s) + recorded container (see Part 3.3, U-V20) | _(empty)_ |
| Hindi: accurate / understandable / wrong / empty counts | _(empty)_ |
| Marathi: accurate / understandable / wrong / empty counts | _(empty)_ |
| Empty-transcript path behaved as specified | _(empty)_ |
| 120 s hard stop and countdown observed | _(empty)_ |
| Explanation readability verdict per language | _(empty)_ |
| Canonical name stayed Latin and unchanged | _(empty)_ |
| Verdict — pass / fail | _(empty)_ |

---

### M3 — WhatsApp end to end from a real handset, including a follow-up and web-history parity

**Evidences:** Requirement 10.7 (*THE WhatsApp_Adapter SHALL return the same Diagnosis_Result
content for a given crop image as the Web_App returns for that image*) and Requirement 12.2 (*THE
Web_App SHALL include Diagnosis_Results created through the WhatsApp channel in the history list*).
Also exercises 10.2, 10.3, 10.4, 10.8, 10.9, 11.3 and 12.1.

**Why a coding agent cannot do this.** The inbound path starts inside Meta's infrastructure. A real
webhook delivery, a real signed request, a real media id, and the container WhatsApp itself chooses
for a voice note are all outside the codebase. Two unresolved items are only resolvable here:
**U-V12** (the field paths inside `messages[].image` and `messages[].audio`) and **U-V13** (whether
the signature digest is hex or base64). A fabricated payload would confirm the parser against the
guess it was written from, which is worse than no test.

**What the tester does.** Use the same phone number as M1, already signed in on the web app.

1. From the handset, send a **crop photo** to the test business number. Confirm a diagnosis reply
   arrives, and record the wait.
2. Upload **the same photo file** on the web diagnose screen. Put the two results side by side:
   condition or inconclusive label, severity, confidence, explanation text. Requirement 10.7 asks
   for the same content — record any difference verbatim.
3. On WhatsApp, send a **subject-less follow-up** ("how much should I spray?"). Confirm it resolves
   against the photo you just sent rather than asking what crop you mean (Requirement 10.8).
4. Send a **plain text** question with no prior photo and confirm a grounded answer or an honest
   no-verified-information reply.
5. Send a **voice note**. Record what happens, and read Part 4 first — `aac` and `amr` are refused
   by design, and which container your handset produces is exactly what needs recording.
6. Send an **unsupported type** — a sticker, a location, a PDF. Confirm the reply states that Jamee
   accepts photos, text and voice notes (Requirement 10.9), in your interface language.
7. Open the web **history** screen. Confirm the WhatsApp diagnosis appears in the list with its
   thumbnail, condition or inconclusive label, severity, **channel shown as WhatsApp**, and
   timestamp; then open its detail view and confirm the conversation messages are the WhatsApp ones
   (Requirements 12.1, 12.2, 12.3).
8. From a **different** phone number with no profile, send a photo. Confirm the reply tells you to
   sign in on the web app with that number first (Requirement 10.3).
9. In the Vercel logs, look for `[jamee] whatsapp.media_shape.unconfirmed` and copy the logged shape
   into Part 3.3 (U-V12). Note the digest length of the `X-Hub-Signature-256` value — 64 characters
   is hex, 44 is base64 (U-V13).

**Record.**

| Field | Result |
| --- | --- |
| Date / tester | _(empty)_ |
| Handset, OS version, WhatsApp version | _(empty)_ |
| Photo reply arrived — wait time | _(empty)_ |
| WhatsApp result vs. web result for the same photo — identical? differences verbatim | _(empty)_ |
| Subject-less follow-up resolved to the photo | _(empty)_ |
| Text-only question outcome | _(empty)_ |
| Voice note: container sent, and outcome | _(empty)_ |
| Unsupported type reply correct and in the right language | _(empty)_ |
| History list shows the WhatsApp entry with channel + thumbnail | _(empty)_ |
| Detail view shows the WhatsApp conversation messages | _(empty)_ |
| Unknown number received the sign-in-first reply | _(empty)_ |
| Duplicate delivery observed (same reply twice?) | _(empty)_ |
| Verdict — pass / fail | _(empty)_ |

---

### M4 — Screen-reader and mobile-device accessibility pass

**Evidences:** Requirements 9.1 and 9.3 (all three Supported_Languages readable on the same
screens), 15.1, 15.2, 15.4 and 15.7 (honest, announced interface states), and the design's
"Frontend — Mobile layout and accessibility" section.

**Why a coding agent cannot do this.** `tests/unit/mobile-layout.test.ts` reads CSS text. It cannot
render a glyph, cannot measure a rendered pixel, cannot hear a screen reader, and cannot tell you
whether a control is inside thumb reach. Every failure mode in this category is silent and
device-only. Full WCAG conformance additionally needs expert review with assistive technology; this
pass is a targeted check of the known-risky surfaces, not a conformance claim.

The automated scan added by task 26.3 (section 1.5) narrows step 1 below but does not replace it: it
proves each control has an accessible name and each live region names something real, in all three
languages, and it says nothing about contrast, rendered geometry, or whether an announcement lands
usefully. It also does not cover the diagnosis detail screen, so that screen's line in step 1 is
entirely on this pass.

**What the tester does.** On a real Android handset with TalkBack and a real iPhone with VoiceOver,
in all three languages, and again at the largest OS font setting.

1. **Screen reader, every screen** — sign-in, diagnose, chat, voice, history, diagnosis detail,
   profile. Swipe through in order. Confirm: focus order matches visual order; every control has a
   name that says what it does; the image thumbnail announces its alt text; the severity value is
   announced as text and not conveyed by colour alone.
2. **Announced states** — start a diagnosis and confirm the analyzing state is announced, not just
   drawn; same for the voice transcribing state (15.7). Confirm no progress indicator moves on a
   timer with nothing behind it (15.2).
3. **Error and retry** — force an error (airplane mode mid-request). Confirm the message is
   announced and a retry action is reachable by screen reader (15.4).
4. **Devanagari renders unclipped.** Set Hindi, then Marathi. The two highest-risk spots, in order:
   - `HistoryList` `.missing` — the no-thumbnail placeholder text sits in a **fixed 5rem × 5rem
     box**, and the Devanagari string runs to 3–4 lines inside it. Confirm no matra is clipped at
     the top or bottom edge and nothing overflows the square.
   - `HistoryList` `.condition` — a long Devanagari condition line beside the fixed 5rem thumbnail,
     with `overflow-wrap: anywhere`. Confirm it wraps rather than pushing the row wide.
   Then check every other screen for a clipped upper matra (ि ी े ै ो ौ) or lower matra (ु ू ृ) and
   for conjuncts (क्त, द्ध) touching a container edge.
5. **The named Devanagari families are actually present** on the versions you tested. `globals.css`
   loads **no webfont** deliberately and names platform faces instead: **Noto Sans Devanagari**
   (Android), **Kohinoor Devanagari** (iOS 9.3+), **Devanagari Sangam MN** (older iOS/macOS). If
   none is present the text falls through to a Latin family and renders as tofu boxes. Confirm real
   Devanagari glyphs, not boxes, and record the OS versions you confirmed it on.
6. **Every control measures ≥44×44 rendered px** — at the default OS font size **and** at the
   largest. Measure, do not eyeball. `--tap-target-min` is `2.75rem` so it grows with the OS
   setting, but that only holds where it is used. Two to measure specifically:
   - `ImageUploader` `.file::file-selector-button` — a **UA-rendered pseudo-element**. It is the
     control a farmer actually taps, it was previously 32 px tall, and a browser can style it in
     ways the declaration does not fully control. Measure it on each browser you test.
   - `EmptyState` `.action` — the first control a new farmer meets on an empty history screen.
7. **No sideways scroll at 320 px.** With Hindi and then Marathi set, check every screen at a 320 px
   viewport, including a result whose explanation carries a **Latin canonical name inside a
   Devanagari sentence** (e.g. `Alternaria solani`) — one long unbreakable token is what widens a
   layout in practice.
8. **Thumb reach on a real 6.7" handset.** Hold it one-handed as a farmer would and confirm the
   primary action on each screen is reachable without shifting grip. A 6.7" device is the case that
   fails; a 6.1" one will not show it.
9. **Contrast as rendered** — measure the actual rendered colours (not the declared hex) for body
   text, the primary action, the severity labels, and the focus ring against its background.
10. **Keyboard-only** on the web app: reach and operate the voice recorder through its tap-to-start
    / tap-to-stop equivalent, and confirm a visible focus indicator throughout.

**Record.**

| Field | Result |
| --- | --- |
| Date / tester | _(empty)_ |
| Android device + OS + browser + TalkBack version | _(empty)_ |
| iOS device + OS + browser + VoiceOver version | _(empty)_ |
| Focus order and control names — per screen findings | _(empty)_ |
| Analyzing / transcribing states announced | _(empty)_ |
| Error announced and retry reachable | _(empty)_ |
| `HistoryList` `.missing` — clipping in hi / mr | _(empty)_ |
| `HistoryList` `.condition` beside the 5rem thumbnail | _(empty)_ |
| Other clipped matras or conjuncts found | _(empty)_ |
| Devanagari family actually used, per platform | _(empty)_ |
| Tofu boxes anywhere — yes/no | _(empty)_ |
| `.file::file-selector-button` measured px (default / enlarged) | _(empty)_ |
| `EmptyState` `.action` measured px (default / enlarged) | _(empty)_ |
| Any control below 44×44 at either font size | _(empty)_ |
| Sideways scroll at 320 px — which screens | _(empty)_ |
| Latin canonical name inside a Devanagari sentence — wrapped cleanly | _(empty)_ |
| Thumb reach on 6.7" — which screens failed | _(empty)_ |
| Measured contrast ratios | _(empty)_ |
| Keyboard-only operation of the recorder | _(empty)_ |
| Verdict — pass / fail | _(empty)_ |

---

## Part 3 — Review items other tasks handed to this document

These are not new test scenarios. They are open questions that earlier tasks deliberately deferred
here rather than guessing at, each with the reasoning that makes the answer cheap to act on.

### 3.1 Marathi and Hindi native-speaker review (from task 25.2)

Reviewers: one native Marathi speaker, one native Hindi speaker. Listed **in priority order** —
MR-1 first, because it is one decision spanning 15 strings and reversing it later is a sweep, while
reversing it after other edits have landed on top is not.

Judge each string as farmer-facing copy: would a smallholder farmer say it this way? Grammatically
correct but stilted is a finding.

---

**MR-1 — `फोटो` is treated as MASCULINE throughout `src/lib/messages/mr.ts`. Confirm or reverse.**

Agreement is masculine on every string that names a photo — the demonstrative, the adjective and
the verb ending: `हा फोटो`, `पिकाचा फोटो`, `फोटो सापडला नाही`. The file **previously agreed it as
feminine** (`ही फोटो सापडली नाही`), which was Hindi's treatment of the same loanword carried
across — the exact bleed-through `mr.ts`'s own header warns about, and the kind of thing that reads
as machine-translated to a Marathi speaker while looking fine to everyone else.

**This is one decision across roughly 15 strings.** A reviewer who disagrees reverses it in a single
sweep. That is why it is first: confirm it before spending time on any individual sentence.

| Field | Result |
| --- | --- |
| Masculine is correct for `फोटो` in Marathi | _(empty)_ |
| If not: correct gender, and any string where it differs | _(empty)_ |
| Reviewer / date | _(empty)_ |

---

**MR-2 — `mr` `errors.QUOTA_EXCEEDED`**

> `आजची {operation} पाठवण्याची मर्यादा {limit} आहे आणि ती पूर्ण झाली आहे. {resetsAt} नंतर पुन्हा पाठवू शकता.`

`मर्यादा संपली आहे` may be more idiomatic than `ती पूर्ण झाली आहे`.

**Constraint on any replacement.** The sentence is deliberately built around **`मर्यादा`** rather
than around the farmer, because a Marathi transitive past agrees with its **object**: `पाठवले आहेत`
would need a different ending for each of the three operation words (`फोटो`, `प्रश्न`,
`रेकॉर्डिंग`). Nominalizing to "the limit for sending X" makes `ती` agree with `मर्यादा`, which is
fixed — and that is what keeps **one template** correct for all three. A replacement must keep the
agreement anchored on `मर्यादा`, or it needs three templates instead of one.

| Field | Result |
| --- | --- |
| Current phrasing acceptable | _(empty)_ |
| Suggested replacement (agreement still on `मर्यादा`) | _(empty)_ |
| Reviewer / date | _(empty)_ |

---

**MR-3 — `mr` `inconclusive.unverified_condition`**

> `जामीने तपासलेल्या कोणत्याही रोगाशी हा फोटो जुळत नाही. जामी फक्त टोमॅटो आणि बटाट्याच्या रोगांकडे पाहते. कृपया हे पीक कृषी तज्ज्ञाला दाखवा.`

Requirement 6.1. Note the deliberate constraint: it names the **crops** (`टोमॅटो`, `बटाटा`) and no
condition name, because no canonical disease name may appear in Devanagari anywhere (Requirements
4.6, 9.4). Any rewrite must keep that true.

| Field | Result |
| --- | --- |
| Reads naturally to a Marathi farmer | _(empty)_ |
| Suggested replacement (no condition name in Devanagari) | _(empty)_ |
| Reviewer / date | _(empty)_ |

---

**MR-4 — `mr` `operations.voice` = `रेकॉर्डिंग`, and the recording strings agreeing it as feminine**

Confirm `रेकॉर्डिंग` is the word a Marathi farmer uses, and that feminine agreement is right across
the strings that carry it: `errors.AUDIO_TOO_LONG` (`रेकॉर्डिंग … असू शकते`),
`errors.AUDIO_FORMAT_UNSUPPORTED` (`ही रेकॉर्डिंग`), `errors.TRANSCRIPT_EMPTY`
(`या रेकॉर्डिंगमध्ये`), `errors.TRANSCRIPTION_FAILED` (`ही रेकॉर्डिंग ऐकता आली नाही`),
`loading.uploadingRecording` and `loading.listening` (`तुमची रेकॉर्डिंग`).

| Field | Result |
| --- | --- |
| `रेकॉर्डिंग` is the natural word | _(empty)_ |
| Feminine agreement correct in all six strings | _(empty)_ |
| Suggested alternative | _(empty)_ |
| Reviewer / date | _(empty)_ |

---

**MR-5 — Jamee's own agreement as NEUTER throughout `mr.ts`. Confirm neuter over masculine.**

`जामी … देते / पाहते / स्वीकारते` — e.g. `जामी फक्त इंग्रजी, हिंदी आणि मराठीत उत्तर देते.`,
`जामी तुमच्या पिकाचा फोटो पाहत आहे…`, `जामी फोटो, लिखित संदेश आणि व्हॉइस नोट स्वीकारते.`

A product name has no inherent gender, so this is a choice. Neuter is applied consistently; the
question is whether a Marathi speaker would expect **masculine** for a named agent instead. Like
MR-1 this is one decision across many strings, so settle it in one pass.

| Field | Result |
| --- | --- |
| Neuter is right for the product name | _(empty)_ |
| If not: preferred gender, and confirmation it applies everywhere | _(empty)_ |
| Reviewer / date | _(empty)_ |

---

**MR-6 — `mr` `errors.PROVIDERS_UNAVAILABLE` and `mr` `whatsapp.voiceNoteFormatUnsupported`**

> `जामी आता थोडा वेळ व्यस्त आहे. कृपया थोड्या वेळाने पुन्हा प्रयत्न करा.`
> `जामीला हा व्हॉइस नोट ऐकता आला नाही. कृपया आपला प्रश्न येथे लिहून पाठवा.`

Both are **meaning-equivalent to the English reference and phrasing-unverified**. Only the English
`PROVIDERS_UNAVAILABLE` is asserted byte-for-byte (Requirement 14.5, design D6); the Marathi one
must mean the same thing and be non-empty, which the tests check — nothing checks that it reads well.

| Field | Result |
| --- | --- |
| `PROVIDERS_UNAVAILABLE` — natural? replacement? | _(empty)_ |
| `voiceNoteFormatUnsupported` — natural? replacement? | _(empty)_ |
| Reviewer / date | _(empty)_ |

---

**HI-7 — `hi` `errors.QUOTA_EXCEEDED` reads slightly formal**

> `आज आप {limit} {operation} भेज चुके हैं, जो आज की पूरी सीमा है। {resetsAt} के बाद फिर भेज सकते हैं।`

**Constraint on any alternative.** This is built around **`आप`** on purpose, so the verb agrees with
the **farmer** rather than with the gendered operation word — `फोटो` and `रिकॉर्डिंग` are feminine
while `सवाल` is masculine, so a template whose verb agreed with the noun would be wrong for two of
the three. Any replacement must keep the agreement on `आप`, or it needs three templates.

| Field | Result |
| --- | --- |
| Current phrasing acceptable | _(empty)_ |
| Suggested replacement (agreement still on `आप`) | _(empty)_ |
| Reviewer / date | _(empty)_ |

---

### 3.2 Manual device pass (from task 26.1)

The static half runs on every commit (`tests/unit/mobile-layout.test.ts`, 87 tests, green). These
are the checks it structurally cannot make. They overlap M4 deliberately — do them in the same
session and record the findings once, here or there.

| # | Check | Why static analysis cannot see it | Result |
| --- | --- | --- | --- |
| D-1 | **Devanagari renders unclipped.** Highest risk in order: `HistoryList` `.missing` — 3–4 lines of Devanagari in a fixed **5rem × 5rem** box; and `HistoryList` `.condition` — a long Devanagari line beside a fixed 5rem thumbnail. | Clipping is a rendered-geometry outcome of a specific font's ascent and descent. The test can assert a `line-height` floor of 1.35; it cannot see a matra touch an edge. | _(empty)_ |
| D-2 | **The named Devanagari families are actually present** on the tested Android and iOS versions — Noto Sans Devanagari (Android), Kohinoor Devanagari (iOS 9.3+), Devanagari Sangam MN (older iOS/macOS). No webfont is loaded, by design. | A CSS scan reads the family *names*. Whether the OS ships the face — and whether the text therefore renders as glyphs or tofu — is a device fact. | _(empty)_ |
| D-3 | **Every control measures ≥44×44 rendered px at the default OS font size AND at the enlarged setting.** Measure `ImageUploader` `.file::file-selector-button` (a **UA-rendered pseudo-element**, previously 32 px, and the most-tapped control on that screen) and `EmptyState` `.action` specifically. | The test asserts declarations use `--tap-target-min` (2.75rem) and not a literal `44px`. A UA pseudo-element's rendered box is the browser's decision, and enlarged-font behaviour only shows up when the OS setting is actually changed. | _(empty)_ |
| D-4 | **No screen scrolls sideways at 320 px**, including a result carrying a **Latin canonical name inside a Devanagari sentence** (`Alternaria solani`). | One long unbreakable token widening a layout is a line-breaking outcome. `overflow-wrap: anywhere` is declared; whether it is sufficient is rendered behaviour. | _(empty)_ |
| D-5 | **Thumb reach on a real 6.7" handset**, held one-handed. | Reach is physical. No test has a thumb. A 6.1" device will not reveal it. | _(empty)_ |
| D-6 | **Contrast as rendered** — measure actual rendered colours for body text, primary actions, severity labels, and the focus ring against its background. | Declared hex values are not rendered values once opacity, overlay and device colour profile are involved. | _(empty)_ |

---

### 3.3 Empirical captures this pass must make

Five values can only be observed against live infrastructure. **`docs/DEPLOYMENT.md` owns the
procedure for each** — see its *"Empirical captures a first deployment must make"* section, Captures
A through E. The table below is a cross-reference and a record of who is expected to produce each,
not a duplicate of the steps.

**The observed values belong in `docs/VERIFIED_VALUES.md`**, on the row of the V-item they resolve,
not in this file. This table tracks whether that has happened.

| Item | What to observe | Procedure | Recorded in `VERIFIED_VALUES.md`? |
| --- | --- | --- | --- |
| **U-V20** (task 19.1) | **The container `MediaRecorder` actually produces on the target Android handset.** `VoiceRecorder` probes an ordered candidate list with `isTypeSupported()`, records the first supported type and reads back `MediaRecorder.mimeType`; the observed value must be written down during this pass. MDN publishes no per-Android-browser *recording* container list, which is why it is unresolved. | `docs/DEPLOYMENT.md`, **Capture C** | _(not recorded)_ |
| **U-V12** (task 28.1) | **The inbound image and audio field paths** — the real property names inside `messages[].image` and `messages[].audio`. Look for **`[jamee] whatsapp.media_shape.unconfirmed`** in the logs after M3; the adapter logs the shape it received rather than assuming one. | `docs/DEPLOYMENT.md`, **Capture A** | _(not recorded)_ |
| **U-V13** (task 28.1) | **The `X-Hub-Signature-256` digest encoding, hex or base64.** From a real signed delivery: **digest length 64 = hex, 44 = base64**. A wrong encoding rejects every legitimate webhook. | `docs/DEPLOYMENT.md`, **Capture B** | _(not recorded)_ |
| **U-V22b** (task 28.1) | **Whether the `storage` schema exposes a creation timestamp usable for age filtering.** This is what keeps retention **scan 2** (the orphan backstop) switched off behind `RETENTION_ORPHAN_SCAN_ENABLED = false`. Scan 1 runs and satisfies Requirements 18.3 and 18.7 for every object a farmer can see. | `docs/DEPLOYMENT.md`, **Capture D** | _(not recorded)_ |
| **U-V22a** (task 28.1) | **Whether `remove()` errors on a path that does not exist.** Free to capture on the first real sweep. `RetentionService` already normalizes both outcomes — absent means deleted, per Requirement 18.10 — so the answer can only turn an error branch into dead code, never change the sweep's behaviour. | `docs/DEPLOYMENT.md`, **Capture E** | _(not recorded)_ |

---

## Part 4 — Known limitation: Requirement 10.6 is not satisfied for `audio/aac` and `audio/amr`

Recorded here so a tester who hits it knows it is designed behaviour and not a defect to file.

Requirement 10.6 says the WhatsApp_Adapter shall store an inbound audio message and invoke the
Voice_Service with it. **For two containers it does not, and cannot today.**

WhatsApp accepts five inbound audio types (V14): `audio/aac`, `audio/amr`, `audio/mpeg`,
`audio/mp4`, `audio/ogg`. Groq's transcription endpoint accepts (V10): `flac, mp3, mp4, mpeg, mpga,
m4a, ogg, wav, webm`. **`aac` and `amr` are in neither intersection** — no first-party Groq page
lists either, so per this repository's fail-loud rule V10's list was **not** widened to cover them.
Task 22.2 corrected `docs/VERIFIED_VALUES.md`'s V14 cross-check accordingly; the earlier claim that
every WhatsApp inbound audio type was inside Groq's list was simply wrong.

What happens instead, by design:

- `isAdmissibleInboundMime` in `src/lib/whatsapp.ts` **refuses the message before downloading the
  media**.
- The farmer receives `whatsapp.voiceNoteFormatUnsupported` — a plain-language reply asking them to
  type the question instead.
- The delivery is marked `rejected`.
- The taxonomy code is `AUDIO_FORMAT_UNSUPPORTED` — **400, not retryable** — rather than
  `TRANSCRIPTION_FAILED` (502, retryable), because WhatsApp chooses the recording container and
  re-sending the identical voice note will fail identically forever.

Closing it needs real work — a transcode step, or a second transcription provider — not a constant
change. `docs/DEPLOYMENT.md`'s operational runbook has the same note under *"A WhatsApp voice note
in `aac` or `amr` is refused, by design."*

**For the tester:** in M3 step 5, record **which container your handset actually sent**. If a voice
note is refused, that is this limitation, and the container you observed is the useful datum. If
your handset sends `ogg`/`opus` or `mp4`, the path should work end to end.

---

## Part 5 — Release acceptance: human-tester steps

<!-- OWNED BY TASK 31.2 — DO NOT FILL IN FROM ANY OTHER TASK. -->
<!--
     Task 31.2 records release acceptance steps 1 and 6 here as tester-executed entries with the
     expected observation for each:
       - Step 1: signing in with a real SMS passcode (Requirement 1.1)
       - Step 6: sending a crop photo on WhatsApp from the same phone number and comparing the
                 result with the web output (Requirement 10.7)
     Requirements: 1.1, 10.7, 17.5.
     M1 and M3 in Part 2 are the broader manual coverage of the same surfaces; 31.2's entries are
     the two numbered acceptance steps specifically, and are what task 32 checks for completion.
     Append below this comment. No restructuring of this document is needed.
-->
<!--
     REFRESHED AT `5d4aca2` — machine rows only, and this is the boundary of the refresh.

     Sections 5.1 and 5.4 carried every automated row as "written, not executed", which stopped
     being true when `npm run test:integration` ran 104/104 against a live local stack (section 1.3).
     Those status cells, the count sentence under 5.1's table, and 5.4's verdict rows were updated
     from that run. Nothing else here moved: A-1 and A-6 remain **outstanding** with empty record
     tables, they are 31.2's own entries, and no other task may fill them in.

     The distinction worth keeping if this happens again: a machine row's status is a **report of a
     run** and goes stale on its own, while A-1 and A-6 are 31.2's authored procedure and only a
     human tester's result can change them.
-->

The requirements' **Release Acceptance Criteria** is not a test matrix. It is one sequence of eight
steps *"a tester completes without developer assistance"*, and the release is accepted when they
complete it. That makes it a different artifact from Part 2: Part 2 asks whether each requirement
holds, and its entries can be done in any order by whoever is available. This part asks whether one
person, in one sitting, on a real handset, can walk the release from sign-in to history — which is
the question a release decision actually turns on.

Two of the eight steps need a human. **Step 1** (a real SMS passcode) and **step 6** (the same crop
photo on WhatsApp, from the number that signed in) are recorded below as **A-1** and **A-6**. The
other six-and-a-half steps are machine-verified, and section 5.1 says by what. Task 32 reads the
verdicts in 5.4.

**Both entries below are outstanding as of 2026-09-16.** No tester has executed either. A-1 and A-6
carry no result at all: everything in 5.2 and 5.3 is a procedure and an expected observation. The
machine rows in 5.1 and 5.4 *do* now carry results, from the run recorded in section 1.3 — which is
exactly why the two human rows are the ones to read carefully before quoting this part.

**A-1 and A-6 do not replace M1 and M3, and do not repeat them.** M1 covers the whole
authentication surface — provider configuration, sender id, a wrong code, request throttling, the
`profiles` row. M3 covers the whole WhatsApp surface — text, voice, an unsupported type, an unknown
number, duplicate delivery, the log captures for U-V12 and U-V13. A-1 and A-6 are the two numbered
acceptance steps only: one action each, one expected observation each, one verdict each. **Do them
inside the same session as M1 and M3, with the same phone number**, and record the detail in M1 and
M3 rather than here. What belongs here is the verdict.

### 5.1 The whole sequence, and where each step is verified

The two entries below are only useful next to the other six steps, because a release is accepted or
not as a whole. This is the map.

| Step | What the sequence asks | Verified by | Status |
| --- | --- | --- | --- |
| **1** | Sign in with a phone number and an SMS one-time passcode | **Human tester — A-1 below** | **outstanding** |
| **2** | Upload a crop image and receive a possible disease result grounded in the Knowledge_Base | `tests/integration/release-acceptance.test.ts` — *step 2: grounds an uploaded crop image in the seeded row of the name it reported* | **passed** at `5d4aca2` (§1.3) |
| **3** | Ask a follow-up in the same Conversation that resolves against that diagnosis | *step 3: answers a subject-less follow-up against that conversation diagnosis* | **passed** at `5d4aca2` |
| **4** | Receive Hindi and Marathi explanations with the Canonical_Disease_Name unchanged | *step 4: returns Hindi and Marathi explanations with the canonical name unchanged* | **passed** at `5d4aca2` |
| **5** | Send a voice message in Hindi, Marathi or English and receive a text answer | *step 5: returns a transcript and a text answer for one voice unit* | **passed** at `5d4aca2` |
| **6** | Send a crop photo on WhatsApp from the same phone number and receive the same Diagnosis_Result content as the Web_App | **Human tester — A-6 below.** A partial machine proxy sits inside the step 7 test — see the note under this table | **outstanding** (the proxy passed; it is not the step) |
| **7** | Open history on the website and view both the Web_App and WhatsApp diagnoses, including a detail view for one entry | *step 7: lists the web and WhatsApp diagnoses together, newest first* and *step 7: opens the detail view of one entry with every field it renders* | **passed** at `5d4aca2`, both tests |
| **8a** | Every agricultural statement traces to a Knowledge_Base row | *step 8: traces every agricultural sentence of the whole run to a seeded row* | **passed** at `5d4aca2` |
| **8b** | Jamee performs no model training | `npm run check:shared-implementation` — static, because the absence of a call is a property of the codebase and not of a run | **PASS** (Part 6) |

Read that column honestly: **seven of the nine rows are green, and the two that are not are the two
that decide the release.** Six of the seven come from one command — `npm run test:integration`, 104
tests across 9 files, all passed against a live local Supabase stack at `5d4aca2` (§1.3 has the run
and the setup) — and the seventh is 8b's static check. Steps **1 and 6 are unstarted**, because both
need a human and one of them needs an SMS provider that is not yet configured anywhere.

**What that does and does not buy.** Every step of the sequence a machine can walk has now been
walked, which is a real change from "written and never run": the code paths behind steps 2, 3, 4, 5,
7 and 8a were the largest block of unverified behaviour in the release, and they are verified.
**It does not make the release acceptable.** Section 5.4 is unchanged in its verdict and the reason
is in the definition: the sequence is one tester's eight steps end to end, and steps 1 and 6 have no
substitute — a passing integration suite proves the services behave, not that a passcode arrives on
a handset or that a WhatsApp client renders the reply. The six run-sourced rows are also weaker than
they look on any other machine: **that run was one local execution and nothing re-runs it**
(CI has never executed — no git remote), and on a machine without `JAMEE_TEST_DATABASE_URL` the same
104 tests report as *skipped*. A skipped suite did not pass.

**The machine proxy for step 6, and its limit.** It passed in the `5d4aca2` run along with the rest
of the step 7 test, and step 6 is still outstanding — the two facts are compatible, and the paragraph
below is why. Inside *step 7: lists the web and WhatsApp
diagnoses together*, `diagnose()` is invoked a second time with `channel: 'whatsapp'` through the
service-role client — a webhook carries no session, and that single argument is what makes it the
WhatsApp path rather than a web request wearing a different label — and its `knowledge`,
`confidence` and `severity` are asserted equal to the web run's, with its explanation put through
the same grounding ledger. That is Requirement 10.7 as far as a machine can take it: *the same
service, over the same row, returns the same structured fields on both channels.* What it cannot
witness is everything between that service and the farmer — Meta's delivery, the signature, the
media download, the reply formatting, and what a WhatsApp client actually displays. A-6 is that
half, and it is the half 10.7 is written about.

---

### 5.2 A-1 — Acceptance step 1: sign in with a phone number and a real SMS passcode

**Evidences:** Requirement 1.1 (*WHEN a visitor submits a phone number in E.164 format on the
sign-in screen, THE Auth_Service SHALL request delivery of an OTP by SMS to that phone number*).
Steps 1.2 and 1.4 are exercised as a by-product and are recorded in M1, not here.

**Expected observation.** A visitor submits a phone number in E.164 format, **receives a one-time
passcode by SMS on that number**, enters it, and **reaches a signed-in screen** — the diagnose
screen, not the sign-in screen again and not an error. Nothing weaker counts: an OTP that does not
arrive, or a correct code that returns you to sign-in, is a failed step 1 and the sequence stops
there, because every remaining step needs the session this one creates.

**What the tester does.** No developer assistance, on the deployed app, on a real handset.

1. Open the deployed sign-in screen and submit your own number as `+91XXXXXXXXXX`.
2. Wait for the SMS. Enter the 6-digit code.
3. Confirm you land on a signed-in screen and that a reload keeps you signed in.
4. Keep this number. **Step 6 (A-6) is only step 6 if it uses the same number** — Requirement 1.5
   makes the `profiles.phone` value the single identity across both channels, so a different handset
   number tests Requirement 10.3's sign-in-first reply instead (that case is M3 step 8).

**U-V2 surfaces here, and it surfaces as silence.** The `type` argument passed to `verifyOtp` on the
*sign-in* path was resolved to **`type: 'sms'`** against the pinned SDK's types, and never confirmed
against a retrievable Supabase page. A wrong value does not warn at build time and does not warn on
send — the SMS still arrives. It shows up exactly here, as *the code never verifies*. **Record the
value that worked** in the row below, and copy it onto U-V2's row in `docs/VERIFIED_VALUES.md`;
that is the resolution of the item, and this run is the only place it can happen.

**Why a coding agent cannot do this.** Delivery leaves the system: it depends on a configured SMS
provider account, on carrier routing, and on a handset receiving a real message. Nothing in the
codebase can observe an SMS arriving. This is not an oversight in the harness — it is a recorded
decision. `tests/integration/farmers.ts` weighed phone OTP as the way to sign its test farmers in
and rejected it, because it needs the one paid third-party dependency in the whole deployment
(`docs/DEPLOYMENT.md` step 2) and *"a harness that cannot run without a paid third party is a
harness nobody runs."* Real OTP delivery was left here deliberately.

**Record.**

| Field | Result |
| --- | --- |
| Date / tester | _(empty)_ |
| Deployment URL tested | _(empty)_ |
| Number used, masked — **the number step 6 must reuse** | _(empty)_ |
| Passcode arrived by SMS — yes/no | _(empty)_ |
| Entering it reached a signed-in screen (not back to sign-in) | _(empty)_ |
| `verifyOtp` `type` value that worked — resolves U-V2 | _(empty)_ |
| If it failed: what appeared instead, verbatim | _(empty)_ |
| **Step 1 verdict — pass / fail** | _(empty)_ |

---

### 5.3 A-6 — Acceptance step 6: the same crop photo on WhatsApp, same content as the web

**Evidences:** Requirement 10.7 (*THE WhatsApp_Adapter SHALL return the same Diagnosis_Result
content for a given crop image as the Web_App returns for that image*).

**Expected observation.** The phone number that signed in at A-1 sends one crop photo to Jamee on
WhatsApp and receives back **the same Diagnosis_Result content the web app returns for that same
image file** — the condition name or the inconclusive label, the severity, and the explanation text.
**The comparison is the step.** A reply that arrives and reads plausibly is not a pass; a reply that
says the same thing *in different words* is a **fail**, because 10.7 is a same-content claim and a
paraphrase breaks it. Any difference goes into the record **verbatim, from both sides** — a
summarized difference is not a finding anyone can act on.

**What the tester does.** Same number as A-1, already signed in on the web app.

1. Send **one crop photo** to the test business number on WhatsApp. Keep the exact file.
2. Upload **that same file** on the web diagnose screen.
3. Put the two side by side and compare the three fields the WhatsApp reply carries: **condition
   name or inconclusive label**, **severity**, **explanation text**.
4. Record the verdict below. Everything else about the WhatsApp channel — the follow-up, text, the
   voice note, an unsupported type, history parity, the log captures — is M3, not this step.

**Four things that will otherwise be recorded as differences when they are not.**

- **Layout is not content.** The WhatsApp reply is one text body in a fixed order — canonical name,
  then the severity label, then the explanation, then the needs-expert banner only when the result
  is inconclusive. The web app renders a card. `formatDiagnosisReply` adds nothing and re-words
  nothing: both channels render the *same* service output, and the canonical name leads only so that
  a cut can never take it. Different arrangement of the same strings is not a difference. Different
  strings are.
- **Set the same language on both sides first.** The WhatsApp reply is written in the language stored
  on the Profile; the web result is written in the language the web screen sent with the request. If
  those differ you will receive a Hindi reply and an English card for the same photo and record a
  language mismatch as a content mismatch. Make them match before comparing.
- **Confidence is not in the WhatsApp reply at all.** The web card renders it as a whole percentage;
  the WhatsApp body has no confidence line, by design. So it cannot be compared on-screen — record
  the web value, and if any of the three comparable fields differ, compare the two `diagnoses` rows
  in the Supabase dashboard, which is where confidence is comparable. (The proxy in 5.1 already
  asserts the two channels' `confidence`, `severity` and `knowledge` are equal at the service level.)
- **A reply ending in `…` hit the 4096-character cap**, not a truncated diagnosis. That is V15's
  limit on a WhatsApp text body; the tail of the explanation is what is lost and never the condition
  or the severity. Note it, and compare the explanation up to the cut.

**Two spends to plan around.** The image quota is **shared across channels** (Requirement 14.2), and
the burst rule is **3 images per farmer per minute**. Sending on WhatsApp, uploading on the web, and
one repeat is exactly 3 — a fourth image inside the same clock minute comes back refused with a
rate-limit message, which is the rule working, not a defect. Space the sends across minutes. The
daily ceiling is 20 images, which this step will not approach.

**A useful extra send, if you have the quota.** Send the same photo on WhatsApp **twice** and compare
the two replies with each other. If the two WhatsApp replies differ from one another in wording, the
model is not deterministic for that image, and a WhatsApp-vs-web wording difference is that rather
than a channel disagreement. Record both observations — it is the one cheap measurement that tells
those two failures apart, and they have very different fixes.

**Step 6 is a photo, so Requirement 10.6 does not arise.** If you also send a voice note while you
are here, read Part 4 first: `aac` and `amr` are refused by design, and the refusal is not a defect
to file.

**Why a coding agent cannot do this.** The inbound path begins inside Meta's infrastructure. A real
signed webhook delivery, a real media id, a real download, and the rendering a WhatsApp client
chooses are all outside the codebase. A fabricated payload would compare the parser against the
guess it was written from — which is why the field paths (U-V12) and the signature encoding (U-V13)
are still open, and why they can only close on a real delivery (§3.3).

**Record.**

| Field | Result |
| --- | --- |
| Date / tester | _(empty)_ |
| Same number as A-1 — yes/no | _(empty)_ |
| Photo file used (name, or hash) | _(empty)_ |
| Profile language / web request language — matched? | _(empty)_ |
| WhatsApp reply arrived — yes/no, and the wait | _(empty)_ |
| Condition name or inconclusive label — WhatsApp / web | _(empty)_ |
| Severity — WhatsApp / web | _(empty)_ |
| Explanation text identical — yes/no | _(empty)_ |
| If not identical: both texts **verbatim** | _(empty)_ |
| Reply ended in `…` (hit the 4096-char cap) | _(empty)_ |
| Confidence on the web card (and both stored rows, if compared) | _(empty)_ |
| Same photo sent twice on WhatsApp — did the channel agree with itself? | _(empty)_ |
| **Step 6 verdict — pass / fail** | _(empty)_ |

---

### 5.4 Sequence verdict

This is the table task 32 reads. The release acceptance sequence is not passed while any row lacks a
result. The machine rows now have one; the two human rows do not, and that is the whole answer.

| Row | Verdict |
| --- | --- |
| Step 1 — A-1, human | **outstanding** — no tester has run it, and no SMS provider is configured to make it runnable |
| Steps 2, 3, 4, 5 — `release-acceptance.test.ts` | **PASS** — executed at `5d4aca2`, 4 of the file's 7 tests; the run is in §1.3's gated-run table |
| Step 6 — A-6, human | **outstanding** — no tester has run it. The step 7 machine proxy passed and is not a substitute (§5.1) |
| Step 7 — `release-acceptance.test.ts`, two tests | **PASS** — executed at `5d4aca2`, both tests |
| Step 8a — `release-acceptance.test.ts` | **PASS** — executed at `5d4aca2` |
| Step 8b — `npm run check:shared-implementation` | **PASS** |
| **Whole sequence accepted — yes / no** | **no** |
| If no: which step failed, and what was observed | **Nothing failed. Steps 1 and 6 have not been performed** — A-1 needs a real SMS passcode, which needs an SMS provider that does not exist in any environment yet (`docs/DEPLOYMENT.md` step 2), and A-6 needs the same crop photo compared through WhatsApp and a handset against the web result. Neither has a machine substitute. Every automated row above is also one local run behind an opt-in gate, so re-read §1.3 before treating them as standing |

**The release is not accepted.** Six acceptance steps moved from *not executed* to *PASS* at
`5d4aca2`, which is the largest single change this table has seen, and it moves the blocker rather
than removing it: what stands between the accepted row and a *yes* is now exactly three things, none
of them code — the two human steps A-1 and A-6, a deployed environment to perform them against
(`scripts/check-deployment.ts` has never run, so Requirement 17.6 is unevidenced too), and an SMS
provider account for step 1.
**104/104 does not mean shippable.** It means the services behave when a machine drives them; the
sequence asks whether a farmer can walk the product end to end, and nobody has tried.

---

## Part 6 — Release gate status

All six gates run locally from the repository root at commit **`5d4aca2`**. The same six are wired
into CI at `.github/workflows/release-gates.yml` (task 28.6), whose second job additionally runs the
integration suite against a real Supabase stack — **that workflow has never been executed**, because
no git remote is configured (section 1.3). Every status below is a local result.

| Gate | Command | Status |
| --- | --- | --- |
| TypeScript strict | `npm run typecheck` | PASS — zero errors |
| Lint | `npm run lint` | PASS — 0 errors, 0 warnings |
| Build | `npm run build` | PASS — 14 routes |
| Tests | `npm test` | PASS — **95 files / 1780 tests, all passed**, with `JAMEE_TEST_DATABASE_URL` exported against a live local stack. Without it: 86 files / 1676 tests passed and **9 files / 104 tests skipped** (every integration suite) |
| Secret scope | `npm run check:secret-scope` | PASS |
| Shared implementation | `npm run check:shared-implementation` | PASS |

The integration project is inside the fourth row rather than beside it, the same way the
accessibility scan is. Run on its own it is **`npm run test:integration` — PASS, 104 / 104 across 9
files** (section 1.3).

**Read the fourth row with the third rule of this document in mind.** The 1780-test figure is real,
but it is conditional: the same command on the same commit reports 1676 passed and 104 skipped when
the database URL is not exported into the environment, and **exits 0 either way**. So a green tick on
that row is evidence that RLS holds, that persistence works and that the scenarios pass end to end
*only if you know which of the two runs produced it*. Section 1.1 records both; section 1.3 has the
commands. And the run is manual — nothing re-executes it, so this row can go stale silently.

The accessibility scan task 28.6 also names among the gates is inside the `npm test` row, not beside
it: task 26.3 put it in the `unit` project (section 1.5), so the fourth row is what fails on an axe
violation. It is an automated scan and not a conformance claim — M4 remains outstanding.
