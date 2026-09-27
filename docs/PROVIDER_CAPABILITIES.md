# Provider capabilities and budgets

Derived from `docs/VERIFIED_VALUES.md` (all rows checked 2026-09-14). **That file is the authority
for every third-party value.** This file asserts no new provider fact: each identifier, limit, header
name and error code below carries the V-item it came from, and nothing here restates a source URL —
follow the V-item instead. If a value this document needs is `UNRESOLVED` in `VERIFIED_VALUES.md`,
this document says so and states what the code must do in the meantime rather than substituting a
plausible number.

What this file decides, for the tasks that consume it:

| Decision | Consumed by |
| --- | --- |
| Capability → provider chain, with the vision fallback behind one config value | tasks 8.1, 8.2, 8.3 |
| Error signal → `RATE_LIMIT` / `UNAVAILABLE` / `OTHER` | tasks 8.1, 8.2, 8.3 |
| `maxDuration` export and the per-request soft budget | tasks 2.2, 8.1, 11.3, 22.3 |
| Telegram acknowledgement strategy | task 40 (was 22.3, retired with the WhatsApp channel) |
| Free-tier headroom and the retention constraint it implies | tasks 28.1, 28.2 (Requirement 17.7) |

---

## 1. Capability matrix

`AiGateway` routes by capability, never by provider name (design: *Provider strategy and fallback*).
Three capabilities, three chains.

| Capability | Primary (model id, tier) | Fallback (model id, tier) | Fallback trigger | Chain exhausted | Source |
| --- | --- | --- | --- | --- | --- |
| `vision-classify` | **Gemini** `gemini-3.8-flash` — **stable** | **Groq** `qwen/qwen3.8-27b` — **Preview** (evaluation only, may be withdrawn at short notice) | Primary classified `RATE_LIMIT` or `UNAVAILABLE` only | `PROVIDERS_UNAVAILABLE` (503) → the Requirement 14.5 busy message | V6, V9, V11 |
| `text-generate` | **Groq** `openai/gpt-oss-20b` — **not Preview** (see the tier note) | **Gemini** `gemini-3.8-flash` — **stable** | Primary classified `RATE_LIMIT` or `UNAVAILABLE` only | `PROVIDERS_UNAVAILABLE` (503) → the Requirement 14.5 busy message | V6, V8, V11 |
| `transcribe` | **Groq** `whisper-large-v3-turbo` — **not Preview** (see the tier note) | **none** | n/a — single-member chain | `TRANSCRIPTION_FAILED` (502, retryable). An empty transcript is a *different* case: `TRANSCRIPT_EMPTY` (422), Requirement 8.7 | V10, V11 |

`OTHER` never triggers a fallback. A validation failure, a malformed answer or a content refusal is
not a transport failure (design D4), so the gateway breaks out of the chain rather than doubling
provider spend on an error it does not recognise.

### Model selections, and the documented alternates

Each pick below is a choice among identifiers that V-items already resolved. The alternates are
recorded so a swap is a config edit against a known-good id rather than a fresh verification round.

- **`gemini-3.8-flash`** for both Gemini capabilities. V6 confirms it is stable, and it is the model
  in the official image-understanding examples, so one identifier covers `vision-classify` and
  `text-generate`. Documented stable alternate: `gemini-3.6-flash`, which V6 describes as balancing
  speed and multimodal capability. V6's instruction not to pin a `-preview` id is why no preview
  Gemini id appears anywhere in this matrix.
- **`openai/gpt-oss-20b`** for primary text generation — the model in Groq's official JS quickstart (V8).
  Documented alternate: `openai/gpt-oss-120b`, which V8 records as production-listed with published
  pricing and limits; both carry 131,072-token context and 65,536 max completion tokens. V8's finding that
  `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` are Enterprise / Contact Sales with no
  published price or limit rules them out for a zero-cost deployment.
- **`qwen/qwen3.8-27b`** for the vision fallback. V9 resolved two candidates and they are
  interchangeable for Jamee's purposes: same Preview tier, same 131K context, same 2048 input tokens
  per image, same OpenAI-style `image_url` content part. The per-request image count differs
  (3 images on 3.8, 5 on 3.6) but Jamee sends exactly one image, so that dimension does not
  discriminate. `qwen/qwen3.6-27b` is the documented alternate behind the same config value.
- **`whisper-large-v3-turbo`** for `transcribe`. V10 records that turbo supports transcription only,
  not translation — Jamee transcribes and then answers in the farmer's language through
  `text-generate`, so translation is not a capability this chain needs. `whisper-large-v3` is the
  documented alternate. Note it is **not a fallback**: it is on the same host, so a Groq outage takes
  both out. See the single-point-of-failure note below.

**Tier note — be precise about what `VERIFIED_VALUES.md` actually states.** V9 is explicit that the two
Qwen models sit under **Preview models**, "intended for evaluation purposes only", so *Preview* is a
quoted fact for those two. For the Groq text and Whisper models the evidence is indirect but
consistent: V9 names only the Qwen pair as Preview; V8 contrasts the gpt-oss models against the llama
models, which are Enterprise / Contact Sales with no published price or rate limit; and U-V19b records
published Developer-plan base limits for both gpt-oss models and both Whisper models. Hence **"not
Preview"** rather than a positive tier claim — no V-item states one in as many words. If a tier gate is
ever needed (for example to make the voice path fail loudly on a preview model the way
`VISION_FALLBACK_MODEL` handles vision), confirm the tier on Groq's models page and add it to V8/V10
rather than inferring it from here.

`gemini-3.8-flash` is a positive **stable** claim: V6 lists it among the current stable Flash models
and instructs against pinning a `-preview` id.

### The vision fallback is one config value (V9)

V9 resolved **YES**: Groq hosts vision-capable models accepting an OpenAI-style `image_url` content
part, so `vision-classify` has two chain members rather than one. The primary is stable; **the second
member is Preview**, and both of V9's candidates for that slot are Preview, so there is no
non-preview option for it.

The chain is therefore built from a single nullable constant in `src/lib/config/verified.ts`
(task 2.2), not from a branch:

- `VISION_FALLBACK_MODEL: string | null` — set to the Qwen identifier while the preview model exists,
  set to `null` when it is withdrawn.
- `providersFor('vision-classify')` appends the Groq vision adapter when that constant is non-null and
  returns a one-member chain when it is null. No other call site changes either way.

Requirement 14.8 is what makes this safe. The design's gateway loop reaches its
`PROVIDERS_UNAVAILABLE` throw by exactly one route, whether the chain had one member that failed or
two members that both failed, so the two situations are indistinguishable to callers. Task 8.5 tests
both shapes against that single branch, which is the regression guard for the risk below.

**Standing risk — the vision fallback can disappear without notice.** V9 records both Qwen models as
Preview: intended for evaluation only, not for production, and subject to discontinuation at short
notice. Mitigation, in three parts: (1) removal is setting `VISION_FALLBACK_MODEL` to `null`, with no
code change and no test change; (2) Requirement 14.8's single exhausted-chain branch means the
farmer-visible behaviour after removal is the same busy message it already is when both members fail;
(3) the constant is annotated with V9 in `verified.ts`, so the reason it exists is discoverable at the
point where someone would edit it.

**Second-order consequence worth knowing.** V9 records that Groq's JSON mode is
`response_format: {"type":"json_object"}` — a plain JSON-object mode, **not** a schema-enforced mode
like Gemini's `response_format` with a `schema` (V7). So during a Gemini outage the vision path loses
schema enforcement and D2's stage-1 shape validation carries the whole load. The expected effect of a
Gemini vision outage is therefore a **higher inconclusive rate**, not a wave of errors — the malformed
answers land in the existing single inconclusive shape (Requirement 6.1–6.5) with a logged
`rejection_reason`. That is a graceful degradation, but it means "diagnosis quality dropped" and
"Gemini is rate-limiting us" look the same to a farmer and are distinguishable only in `usage_logs`
via `used_fallback` and `rejection_reason` (D10). Worth remembering when reading logs.

**Single point of failure — voice transcription.** `transcribe` has no cross-provider member, by design
(design: *Fallback matrix*, "None in this release"). A Groq outage therefore takes transcription
offline, but text generation falls back to Gemini and image classification remains on Gemini. A
Gemini outage leaves text generation on Groq and moves image classification to its Groq fallback.
The remaining voice limitation is explicit: transcription itself has no second provider.

**No container hole on `transcribe` — the one the old channel opened closes with it (V26, V10).** An
inbound voice note now arrives on Telegram, and a Telegram `voice` message is **always OGG/Opus**:
`message.voice` is a `Voice` object whose `mime_type` is `audio/ogg` (V26). `ogg` is a member of
V10's accepted container list (`flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm`), so every voice
note this chain is handed is transcribable. The `audio/aac` and `audio/amr` gap that made
Requirement 10.6 unsatisfiable was a property of the *previous* channel's inbound audio set — those
two containers are absent from V10's list and this release adds no transcode step — so the gap
**closes with the channel that opened it**, not by widening V10's list. The conclusion Amendment A1
predicted (10.6 satisfiable) holds for a reason worth stating precisely: Telegram *fixes* the
container to OGG/Opus, it is not that a second transcription provider or a transcode step was added.
The adapter still checks the reported `mime_type` against V10's list before downloading — a
documented guarantee is one comparison away from a verified runtime fact, and whether
`voice.mime_type` is present on every client is UNRESOLVED (U-V26). A file arriving as `audio` or
`document` rather than `voice` is a different, arbitrary-container case (V26) and is out of this
chain's scope; it is handled as an unsupported inbound type by the adapter, not by the transcription
chain.

---

## 2. Error classification

The gateway needs one function per adapter — `classifyError()` — mapping a provider signal onto
`RATE_LIMIT` / `UNAVAILABLE` / `OTHER`. V11 resolved the signals for both providers. Classification
reads **status codes and documented status names only**; it never matches on message text, because
message text is not part of any provider's documented contract.

| Provider | Documented signal | Bucket | Fallback? | Notes (V-item) |
| --- | --- | --- | --- | --- |
| Groq | **429** Too Many Requests, with **`retry-after` in seconds** (set only on a 429) | `RATE_LIMIT` | yes | V11. `retry-after` is a real number to honour, subject to the budget rule below |
| Groq | **500** Internal Server Error | `UNAVAILABLE` | yes | V11 |
| Groq | **502** Bad Gateway | `UNAVAILABLE` | yes | V11 |
| Groq | **503** Service Unavailable | `UNAVAILABLE` | yes | V11 — documented as not charged |
| Groq | **413** Request Entity Too Large | `OTHER` | **no** | V11. Input validation, not a transport failure — see below |
| Groq | **422** Unprocessable Entity (explicitly including "model hallucinations") | `OTHER` | **no** | V11. Output-shape failure — see below |
| Gemini | **429 `RESOURCE_EXHAUSTED`** (both request-rate and spend-based) | `RATE_LIMIT` | yes | V11 |
| Gemini | **503 `UNAVAILABLE`** | `UNAVAILABLE` | yes | V11 |
| either | anything else, including a thrown non-HTTP error | `OTHER` | **no** | V11's default; design D4's conservative seam |

Groq's error body is `{ "error": { "message": string, "type": string } }` (V11). It is fine to log
`type` for diagnosis; it must not drive the bucket.

### The two Groq input-validation codes must not cross providers

**413** and **422** are the codes most likely to be misfiled as "the provider is having a bad day",
and both would be actively harmful as fallback triggers.

- **413 Request Entity Too Large** is Jamee's own fault: the request exceeded a provider input cap —
  V9's 20 MB image-URL request ceiling, or V10's 25 MB free-tier / 100 MB dev-tier audio attachment
  cap. Retrying the identical oversized payload on a second provider fails identically and spends a
  second call to learn nothing. It maps to `OTHER`, fails fast, and surfaces as an input error that
  names the limit (Requirements 2.4, 8.3 style) rather than as a provider outage.
- **422 Unprocessable Entity** is documented to include model hallucinations, which makes it an
  *output* problem. Jamee already has a path for that and it is not the fallback path: D2's two-stage
  validation collapses every malformed or out-of-knowledge-base answer into the single inconclusive
  shape with a distinct `rejection_reason`, no second model call (Requirement 6.6), and the rejected
  content discarded (Requirement 5.7). Routing 422 into a cross-provider retry would double spend and
  contradict D4.

Both stay `OTHER`, and task 8.5's "primary `OTHER` → no fallback attempted" case is the test that
holds this in place.

### Gaps and deliberate conservatism

- **U-V11 — no documented Gemini `retry-after`.** Groq's is confirmed; Gemini's docs prescribe
  client-side exponential backoff with jitter and name no header. So: Gemini backoff is **exponential
  with jitter and a bounded attempt count**, and the adapter reads a retry-after header only if one
  actually turns up at runtime. This is a backoff *hint* only — the fallback decision itself keys off
  status and status name, which are fully resolved, so U-V11 blocks nothing.
- **Google's SDKs retry internally.** V11 records that the official SDKs retry transient errors
  themselves — the Python SDK up to four attempts with ~1 s initial delay and a **60 s maximum**. That
  ceiling is larger than Jamee's entire per-request budget, so a single `interactions.create()` call
  can silently consume the whole budget in SDK-internal retries and return one aggregate failure. Two
  consequences the adapter must honour: pass an abort signal derived from the shared deadline into
  every provider call so the deadline cuts SDK-internal retries mid-loop, and treat every call as
  potentially multi-attempt when reasoning about latency rather than assuming one network round trip.
  V11's numbers are the Python SDK's; the `@google/genai` JS defaults are not recorded, so confirm
  them against the pinned package's types at task 8.2 and lower the internal retry count if the
  abort signal alone does not bound it.
- **Wider retry guidance than the classifier.** V11 records Gemini's documented retry set as 429, 408
  and 5xx, and notes 408 specifically — but the resolved classifier maps only 429 → `RATE_LIMIT` and
  503 → `UNAVAILABLE`, with everything else → `OTHER`. So a Gemini **408** and a Gemini **500** are
  `OTHER` today and do not fall back. That is intentional conservatism, not an oversight: widening the
  buckets changes when Jamee doubles provider spend, so it is a change to V11's resolved classifier
  and belongs in `VERIFIED_VALUES.md`, not in an adapter.
- **Rate-limited attempts probably still count.** Neither V11 nor V19 documents whether a 429'd
  attempt counts against a provider's own request accounting. Assume it does when sizing (section 5
  does), and do not build any logic that depends on it not counting.

---

## 3. Timeout budget

### The ceiling Jamee uses is its own 60 s, not the platform's 300 s

`VERIFIED_VALUES.md` records a discrepancy: the requirements assume a 60 s function ceiling, and
V16's documented Vercel Hobby maximum is **300 s** (300 s default *and* 300 s maximum with fluid
compute). Resolution, settled before this document was written:

- **Every Jamee route handler that can call a provider exports `maxDuration = 60`.** V17 gives the
  mechanism: `export const maxDuration = <number>` in the route segment, type `number`, unit
  **seconds**, on the Node.js runtime. V17 also records that the default is "set by deployment
  platform", which is precisely why the export cannot be omitted — without it the effective ceiling is
  300 s and invisible in the codebase.
- **300 s is recorded only as the documented platform hard ceiling that Jamee's 60 s stays under.** It
  is not an input to any budget arithmetic.

> **Do not derive the soft budget from 300 s.** Every fraction in this section is a fraction of
> **60 s**. Taking the same fraction of 300 s would produce a 225 s soft budget — a number no farmer
> would wait for, that would push memory-time past the Vercel Hobby allowance (section 5), and that
> would let a hung provider call occupy a function for nearly four minutes. If someone later reads
> "a fraction of the confirmed platform ceiling" and reaches for 300, this is the paragraph that says
> no. The routes are capped at 60 s; the platform permits more; Jamee declines to use it.

Task 11.3's wording ("route segment `maxDuration` set from the confirmed platform maximum") resolves
to **60**, not 300, for the same reason.

### `getDeadline()` is the runtime source; 45 s is the arithmetic

V18 confirms **`getDeadline()`** from `@vercel/functions`, which returns the shared invocation deadline
for the current invocation as a `Date`. That is the preferred source for the soft deadline, because it
reflects the deadline the platform will actually enforce rather than a number the codebase believes.
The budget arithmetic below is nevertheless stated against the 60 s export, so the figures are
reviewable without a running invocation and so local development has a defined value.

Soft budget as a fraction of Jamee's own ceiling:

```
soft budget  = 0.75 × maxDuration
             = 0.75 × 60 s
             = 45 s

terminal reserve = 60 s − 45 s = 15 s
```

Effective deadline for a request, one constant in `src/lib/ai/gateway.ts` (design: *Timeouts*):

```
deadline = min( getDeadline() − 15 s ,  requestStart + 45 s )
```

The 15 s terminal reserve is not slack. It is the time the request still needs *after* the budget
expires: build and localize the error envelope, write the `usage_logs` row with `outcome = 'timeout'`,
mark the `telegram_inbound` row on the Telegram path and send the farmer a message. V16 records that
`SIGTERM` grants only **~500 ms** of cleanup, so none of that work can be deferred to shutdown — it
has to happen inside the invocation, before the platform's own limit, which is exactly what the
reserve buys.

### Enforcement is one deadline, not a sum of per-call timeouts

One absolute deadline instant per request. Every provider call gets `deadline − now`, capped by a
per-attempt ceiling. This matters because a fallback adds an attempt without adding budget: if the
primary vision call burns its full ceiling and then returns 429, the fallback attempt gets what
remains, not a fresh ceiling. Summing per-call timeouts would over-commit the request by exactly the
fallback attempt.

| Attempt | Per-attempt ceiling | Minimum remaining required to start | Why |
| --- | --- | --- | --- |
| `vision-classify` | 20 s | 6 s | Largest payload and the thinking-enabled path |
| `text-generate` | 15 s | 5 s | Short prompt, bounded output tokens (V7 `max_output_tokens`) |
| `transcribe` | 20 s | 8 s | Audio upload to the provider dominates; up to 10 MB |

**The minimum-remaining guard is a spend rule, not an optimisation.** The gateway does not start a
provider attempt it cannot finish. Starting one would spend a provider call whose result arrives after
the deadline and is discarded — real cost, zero value, and on a rate-limited provider it consumes an
allowance that the *next* farmer needs. Below the minimum, the gateway goes straight to the timeout
branch.

### Where the 45 s goes on a diagnosis request

A diagnosis is the longest path: up to **two sequential model calls**, classify then rephrase, with
storage and database round trips around them (design: *DiagnosisService* pipeline order, task 11.2).

| Step | Planned | Notes |
| --- | --- | --- |
| Ownership check + media existence probe | 1.0 s | `assertOwnership` on the GridFS `metadata.ownerId`, before any spend (Property 5) |
| Quota reserve | 0.5 s | one Data_Access_Layer `findOneAndUpdate` counter reserve (V28, `returnDocument: 'after'`) |
| Read media bytes from GridFS | 0.5 s | `openDownloadStream` on the `Media_Reference` (V29); bytes are then sent **inline** to the provider (V34) — there is no signed-URL mint under A3 |
| `vision-classify` | 20.0 s | one attempt at its ceiling |
| Stage 1 + stage 2 validation, knowledge-base read | 0.5 s | shape check is local; the KB read is one indexed query |
| `text-generate` rephrase | 15.0 s | identified results only |
| Persistence: `diagnoses`, `messages`, `usage_logs` | 2.0 s | |
| **Planned total** | **39.5 s** | |
| Unallocated | 5.5 s | absorbs jitter, not a second attempt |

The plan fits one attempt per capability with 5.5 s spare. It does **not** fit a vision fallback plus a
rephrase: 2.0 s of pre-flight work, then a full-ceiling primary vision attempt and a full-ceiling
fallback, is `2 + 20 + 20 = 42 s` of the 45 s, leaving 3 s — below `text-generate`'s 5 s minimum, so
the rephrase call is never started. That is the intended arithmetic, not a flaw: the deadline is
shared, so the request degrades predictably instead of overrunning. What it means concretely,
**a diagnosis that needs the vision fallback may not have budget left to rephrase, and today that
returns `DIAGNOSIS_TIMEOUT`.**

> **Open item for tasks 9.2 / 11.2 — needs a decision, not an implementation.** Task 9.2 already
> builds a static localized template from the knowledge-base row as the fallback for a *failed
> post-generation check*. The same template could serve a *budget-exhausted* rephrase, turning the
> above timeout into a grounded, correctly-localized answer with plainer wording — the farmer gets
> their diagnosis instead of an error. The mechanism exists and the content stays grounded in the
> knowledge base either way. It is not adopted here because it changes observable behaviour on a
> path Requirement 3.7 currently specifies as a timeout, and that is the user's call. Flagged, not
> assumed.

Two latency facts that make the vision allowance the right place to spend the budget:

- **V6: Gemini 3.x has thinking enabled by default**, which raises latency and output-token spend.
  This is why `vision-classify` gets the largest ceiling.
- **V7 records `thinking_level` (`minimal` | `low` | `medium` | `high`) on `generation_config`.**
  `minimal` is the documented lever for pulling classification latency back down, and it points the
  same direction as D7's determinism goal. Relevant because U-V7 leaves it unconfirmed whether
  `temperature` is accepted on the Interactions API `generation_config` at all — if it is not,
  `thinking_level: 'minimal'` plus `seed` become D7's determinism levers *and* the latency lever.
  Settle U-V7 against the `@google/genai` types at task 8.2.

### On expiry

Uniform, and deliberately unforgiving about the quota:

1. Every in-flight provider call is aborted via the shared signal — which also cuts SDK-internal
   retries (section 2).
2. The service raises **`DIAGNOSIS_TIMEOUT`** → HTTP **504**, retryable, message naming the diagnosis
   operation (Requirement 3.7, design error taxonomy).
3. A `usage_logs` row is written with **`outcome = 'timeout'`**, plus `model_provider`,
   `used_fallback`, `channel` and `latency_ms` (Requirements 14.6, 14.7; D10).
4. **The quota unit stays spent — `quota_spent = true`, no refund.** The refund path in
   `QuotaService.refund()` exists only for failures occurring *before the first provider call is
   attempted*: an ownership rejection, a GridFS media-read failure, an unreadable object, a knowledge-base
   read failure (task 10.3). A timeout happens after a provider call was issued, so the call was real
   and the unit is consumed. Refunding it would let a farmer with a reliably slow connection or a
   pathological image spend unlimited provider calls for zero quota.
5. On the Telegram path the same deadline drives D11's soft-deadline branch — the farmer receives
   "Jamee is taking longer than usual on this photo — please send it again in a moment", the
   `telegram_inbound` row is marked `failed`, and the delivery is still acknowledged 200.

The routes that must export `maxDuration = 60`: `/api/diagnose`, `/api/chat`, `/api/voice`, and the
Telegram webhook. V17 also records that `runtime` and `preferredRegion` are deprecated on the same
config object and that `runtime = 'edge'` is unsupported from Next.js 16.3, so all four stay on the
Node.js runtime — which is also what `waitUntil()` and `getDeadline()` require (V18).

---

## 4. Telegram acknowledgement strategy

> Amended by Amendment A1 (2026-09-23): this section was *WhatsApp acknowledgement strategy*. The
> channel is now Telegram, so V13 and V15 are retired and V24 supplies their replacement. **D11's
> decision is unchanged in shape** — the `update_id` is claimed before anything billable, the reply
> is sent, `markProcessed` runs after the reply, the unit of work is one update, and processing is
> inline followed by acknowledgement. The reasoning below is re-argued on Telegram's facts, and one
> input to the old argument disappears entirely: Telegram has **no 24-hour customer-service window
> and no template requirement**, so a late or deferred reply is a latency problem and not an
> undeliverable message. Its replacement input is Telegram's own retry cadence on a non-200 (V24).

### What V18 resolved

**YES, a continuation primitive exists.** V18 confirms `waitUntil()` from `@vercel/functions`,
documented for work performed after the response is sent, on the **Node.js runtime**, with **no plan
restriction stated** on the page checked — so it appears usable on Hobby. Next.js `after` is
referenced for the same purpose.

This is the branch D11 was written to hedge against. D11's first stated reason for processing inline
was that a serverless function "cannot be relied on to keep working after the response is sent unless
a supported continuation primitive exists — VERIFY (V18)". V18 came back YES, so that reason no longer
holds and the decision genuinely has to be re-argued rather than inherited. V18 is unchanged by the
channel switch — the primitive and its caveat are platform facts, not WhatsApp facts.

### Recommendation: keep D11 — process inline, then acknowledge

Re-argued on the resolved facts, inline processing still wins for this release. Four reasons, in
order of weight.

**1. The problem a fast 200 solves is already solved somewhere better.** Telegram **redelivers the
same `update_id`** on any non-2xx response or timeout, with increasing back-off, until a 2xx is
returned or the update ages out (V24). That is the pressure for acknowledging fast. But migration
`0008_telegram_inbound` makes `update_id` the **primary key** of `telegram_inbound`, so the unique
violation *is* the duplicate signal and a redelivery is dropped before any service call or reply. The
cost of a slow 200 is therefore a wasted redelivery, not duplicated work or a duplicated reply.
Correctness does not depend on acknowledgement latency — which is exactly what D11 claimed, and V24
confirms the retry behaviour it now reasons about. (The precise age-out bound is UNRESOLVED —
U-V24 — but the acknowledgement decision does not depend on it: the `update_id` claim makes any
number of redeliveries harmless.)

**2. The work fits.** One `vision-classify` call, one `text-generate` call, and a couple of MongoDB
round trips (through the Data_Access_Layer). Section 3 allocates that at 39.5 s planned inside a 45 s budget under a 60 s ceiling,
for a single update. There is no capacity argument for deferring.

**3. `waitUntil` converts a visible failure into a silent one.** V18 records the caveat directly: with
request cancellation enabled, **any work not wrapped in `waitUntil` or `after` is lost, and a
serverless execution context can be reclaimed after cancellation.** Consider what each design does
when processing fails late:

- *Inline (D11):* the soft deadline fires inside the invocation. The farmer gets an explicit "taking
  longer than usual, please send it again in a moment". The row is marked **`failed`**, not
  `processed` — D11 is deliberate about this, and it keeps the audit honest. A non-2xx (or the
  failed row's own retry) means Telegram redelivers the same `update_id`; the farmer's next fresh
  send carries a new `update_id`, so either way it processes normally.
- *Deferred (`waitUntil`):* the 200 is already sent. If the context is reclaimed, the farmer receives
  nothing — no answer, no error, no explanation — and Telegram will not redeliver, because Jamee
  already returned 2xx. The `telegram_inbound` row is stranded mid-flight with no code path left
  running to mark it. The failure exists only as an absence.

Jamee's farmer-facing contract is honest interface states (Requirement 15, D5's static messages). A
mode whose failure signature is silence is the wrong trade for a plan whose worst case is a slower
reply.

**4. `waitUntil` does not buy more total time — only an earlier acknowledgement.** V18 describes
`waitUntil` as extending the handler's lifetime *for the duration of the promise*, and describes
`getDeadline()` as returning the **shared invocation deadline**. Neither statement says the extension
can exceed `maxDuration`, and "shared invocation deadline" reads as one deadline covering the whole
invocation including deferred work. Treat the total ceiling as unchanged by `waitUntil` until
confirmed otherwise. Under that conservative reading, adopting `waitUntil` changes *when* the 200 is
sent and changes nothing about how much time the work gets — so the choice is a UX and
observability trade-off, not a capacity one. Requirement 10.10 (whole invocation inside the ceiling)
is unaffected either way.

Requirement 10.11 (a 200 for every accepted delivery) is satisfied by both designs. It constrains
whether Jamee acknowledges, not how quickly.

### What would change if this were reversed

The reversal is contained, which is the strongest thing about D11 — it is a decision that costs
little to revisit. Per the design's own upgrade path, return 200 immediately after the idempotency
insert and move the remaining pipeline steps into the continuation. **No service changes**: they
already take `channel` as a parameter and are already idempotency-guarded. Concretely:

| Aspect | Inline (recommended) | Deferred via `waitUntil` |
| --- | --- | --- |
| 200 sent | after processing, or after the soft-deadline branch | immediately after the `telegram_inbound` insert |
| Soft deadline | still required, drives the "taking longer" reply | still required, now *inside* the continuation, and its reply is the only remaining signal |
| Late-failure signal to the farmer | explicit message | none unless the continuation itself sends one |
| Late-failure signal to operators | HTTP response + `usage_logs` + row status | `usage_logs` and the `telegram_inbound` status transition **only** — the response is long gone |
| New requirement introduced | none | a stranded-row check: rows left `received` past a threshold need a sweep, or late failures accumulate unnoticed |
| Failure mode | slow reply | silent non-reply |

So the trigger for reversing is not "`waitUntil` exists" — it does. It is either measured evidence
that inline processing overruns the budget in practice, or an operator-visible backlog surface that
makes a silent continuation failure loud. Neither exists yet.

### The batching hazard the old channel carried does not arise here

Under the retired WhatsApp channel this subsection recorded a real hazard: Meta could batch up to
1000 updates in one delivery (V13), and a handler that inserted idempotency rows for all N entries
and then ran out of budget mid-batch would silently discard the unprocessed tail, because the
acknowledged batch is never redelivered. **Telegram removes that hazard by construction:** it
delivers **one `Update` per webhook POST** and redelivers *that* `update_id` on a non-2xx (V24), so
the unit of work is one update, exactly as D11 states. There is no batch to partially process and no
tail to strand.

The `status` column of `telegram_inbound` still earns its place, for the single-update in-flight
failure rather than for batching:

- Insert the row as **`received`**, and transition it to `processed` only after the reply is sent —
  never at insert time. This is D11's `markProcessed`-after-reply ordering.
- A row left `received` (the invocation died after the claim and before completion) is an **honest,
  recoverable state**, not a silent drop: the row exists and is visible to an operator, and Telegram
  will redeliver the same `update_id` until a 2xx lands.
- The farmer-facing behaviour when the soft deadline fires before completion is D11's existing
  "taking longer than usual" message, after which the row is marked `failed`.

Because there is no batch, "process entries while the deadline allows" collapses to the single
budget check Section 3 already describes for one request; no per-entry loop is needed on this channel.

### Deadline source on this path

Use `getDeadline()` (V18) for the Telegram soft deadline too, with the section 3 constant as the
fallback when it is unavailable. Same constant, same arithmetic as the gateway — D11 specifies "a
fraction of the configured ceiling, same constant as the gateway budget", and there is no reason for
the two to drift.

---

## 5. Free-tier headroom for 6 farmers (Requirement 17.7)

Load is bounded by **Jamee's own** per-farmer daily limits (Requirement 14.1), not by any provider's
allowance. The design is explicit that provider free-tier numbers are never encoded in the routing
logic: Jamee reacts to a rate-limit *signal* (Requirement 14.4) and does not model a provider's quota.
This section is a sizing note, not an input to any code path.

> **Amended by Amendment A1 (Telegram) and Amendment A3 (MongoDB).** This section was first written
> against the pre-amendment stack, so its *storage* arithmetic below was sized against **Supabase**
> (500 MB database, separate 1 GB object storage, 5 GB monthly egress) and its second channel was
> **WhatsApp**. Both are superseded and the current substrate is:
> - **The second channel is Telegram, not WhatsApp** (A1). The shared-quota reasoning is unchanged —
>   one per-farmer quota counts both channels — but the media-relay and 24-hour-window paragraphs
>   below describe the retired WhatsApp channel and are kept only as the record of why the reasoning
>   held; Telegram file retrieval is a single `getFile` (V25) with a 20 MB bot-download ceiling.
> - **Records and media both live in MongoDB Atlas M0, not Supabase** (A3). There is no Supabase
>   database, no separate object-storage bucket, and no signed-URL egress: uploaded files are in
>   **GridFS inside the same M0 database**, and analysis reads those bytes and sends them **inline**
>   to the provider (V34) rather than handing over a signed URL. The binding limit is therefore the
>   **single M0 512 MB (0.5 GB) cluster budget shared by records *and* GridFS media** (V32), which is
>   *tighter* than the retired Supabase split of 500 MB records + 1 GB storage. The current retention
>   arithmetic against that 512 MB budget lives in
>   [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) step 10 and is the authority; the Supabase-era tables
>   below are retained as the prior analysis, not as current instruction.
> - The AI-call sizing (request load, model calls, Gemini/Groq allowances, Vercel Hobby) is
>   **unchanged by either amendment** — no provider that resolves those numbers was touched — so it
>   still stands as written.

### Request load

| Operation | Per farmer / day | × 6 farmers |
| --- | --- | --- |
| Image analyses | 20 | **120** |
| Chat messages | 50 | **300** |
| Voice messages | 20 | **120** |
| **Total requests** | 90 | **540 / day** → **16,200 / 30 days** |

One quota, both channels: Requirement 14.2 counts the web channel and the Telegram channel against one
shared per-farmer limit, and the counter key carries no channel component (task 10.1). Adding the
second channel adds no load above these numbers.

### Model calls, which is the number that matters

Requests are not calls. An identified diagnosis costs two model calls; an inconclusive one costs one.

| Outcome | Model calls | Breakdown |
| --- | --- | --- |
| Image — identified | **2** | `vision-classify` ×1 + `text-generate` ×1 (rephrase) |
| Image — inconclusive | **1** | `vision-classify` ×1. Requirement 6.6 forbids the second call; Requirement 6.7 still charges one quota unit |
| Chat — in coverage | **1** | `text-generate` ×1 |
| Chat — out of coverage | **0** | static localized referral, no model call (D5, task 15.2) |
| Voice — in coverage | **2** | `transcribe` ×1 + `text-generate` ×1 |
| Voice — empty transcript | **1** | `transcribe` ×1, then `TRANSCRIPT_EMPTY` (Requirement 8.7) |
| Voice — out of coverage | **1** | `transcribe` ×1; the referral itself is static, so no `text-generate` |
| Quota declined | **0** | Requirement 14.3 invokes no provider |

Worst case — every image identified, every question in coverage, every recording audible:

| Capability | Calls / day | Calls / 30 days | Normal host |
| --- | --- | --- | --- |
| `vision-classify` | 120 | 3,600 | Gemini |
| `text-generate` | 120 + 300 + 120 = **540** | 16,200 | Groq |
| `transcribe` | 120 | 3,600 | Groq |
| **Total** | **780 / day** | **23,400** | |

Best case for call volume — every image inconclusive and every question out of coverage — is
**240 calls/day** (120 vision + 120 transcribe). The honest range is **240–780 model calls/day**;
everything below uses 780.

By host under normal routing: **Gemini 120 calls/day** (3,600/month), **Groq 660 calls/day**
(19,800/month). A Groq text failure shifts text calls to Gemini; each rate-limited primary attempt
is an extra call on top.

Burst rate: 6 farmers cannot generate meaningful concurrency. All six submitting simultaneously is
6 concurrent requests → at most **12 model calls inside one minute**.

### Provider allowances: UNRESOLVED, and that is the finding

- **Gemini free-tier RPM / RPD — `UNRESOLVED` (U-V19a).** The rate-limits page defines the dimensions
  and confirms the Free tier exists, but the per-tier numeric table is no longer published; it
  redirects to an AI Studio page behind authentication.
- **Groq free-tier RPM / TPD — `UNRESOLVED` (U-V19b).** The published table is explicitly labelled
  Developer-plan base limits, and the speech-to-text page separately distinguishes a free tier (25 MB)
  from a dev tier (100 MB) — so free ≠ developer, and the free numbers are not published.

**No number is substituted for either.** There is no "Gemini row" and no "Groq free row" in a headroom
table below, because writing one would mean inventing it. What the code does in the meantime is
already correct and needs no change: Requirement 14.4 handles provider limits **reactively** through
the fallback path, and Jamee's own quotas are set independently of any provider allowance. The actual
figures get recorded from the authenticated dashboards during deployment (deployment doc step 4) and
added to V19 then.

#### Labelled upper-bound sanity check — Developer plan, *not* free tier

U-V19b records Developer-plan base limits for reference. **These are Developer-plan numbers and must
not be quoted as free-tier allowances** — free-tier limits are unpublished and are very likely lower.
Used here only to answer "is the shape of this load plausible at all?", against the worst case where
a full Gemini outage pushes vision *and* text onto Groq.

| Dimension | Developer-plan reference | Jamee worst case | Reading |
| --- | --- | --- | --- |
| Chat-completion RPD — **per-model** reading | 1,000 each | qwen 120/day, gpt-oss 540/day | 12% and 54% — fits |
| Chat-completion RPD — **per-account** reading | 1,000 | 660/day if Groq served all vision + text | ~66% — fits, with little room |
| Whisper RPD | 2,000 | 120/day | ~6% — wide |
| Whisper audio-seconds/day (ASD) | 28,800 | 120 × 120 s = 14,400 | 50% — fits |
| Whisper audio-seconds/hour (ASH) | 7,200 | 14,400 if a whole day's voice arrived in one hour | **~200% — would not fit** |
| Qwen vision TPD | 200,000 | 120 × 2,048 = **245,760** input tokens from images alone | **~123% — would not fit** |

Two readings appear above because **U-V19b's table does not state whether these limits are per-model
or per-account.** Both are shown rather than picked; both fit on the request-count dimension, so the
ambiguity does not change any conclusion here. Do not resolve it by assumption — it comes from the same
authenticated account page as the free-tier numbers, so it gets settled at deployment alongside them.

Two findings from this, both about the fallback rather than the primary:

1. **The vision fallback cannot absorb a full day of worst-case image load, even on the Developer
   plan.** V9 records each image as 2,048 input tokens; 200,000 TPD ÷ 2,048 ≈ **97 image requests**
   before prompt and output tokens are counted, against Jamee's worst-case 120. A day-long Gemini
   vision outage at maximum farmer activity is therefore **not** fully covered. This is not a defect
   and needs no code: the chain exhausts, Requirement 14.8's single branch returns
   `PROVIDERS_UNAVAILABLE`, and the farmer sees the busy message. It does mean the Qwen member is
   correctly understood as **burst cover, not a substitute for Gemini** — which sits well with its
   Preview tier.
2. **Audio-seconds are hourly-capped, and a burst can exceed the hourly figure while sitting
   comfortably under the daily one.** 20 two-minute voice notes per farmer inside a single hour is
   unlikely behaviour, but it is inside Jamee's own quota, so it is reachable without any limit being
   violated. The reactive path handles it — a 429 with `retry-after` (V11) on a chain with no fallback
   surfaces `TRANSCRIPTION_FAILED`, retryable.

### Vercel Hobby (V19)

| Dimension | Hobby allowance | Jamee worst case (30 days) | Headroom |
| --- | --- | --- | --- |
| Function invocations | 1,000,000 | 16,200 API requests + webhook deliveries + page loads | **~1.6%** even before overhead — wide |
| Edge requests | 1,000,000 | same order | wide |
| Fast Data Transfer | 100 GB | JSON responses ≈ 16,200 × ~4 KB ≈ **65 MB**, plus app-shell loads | wide — media bytes do **not** cross Vercel on the web path |
| Fast Origin Transfer | 10 GB | same order | wide |
| Active CPU | 4 CPU-hrs = 14,400 CPU-s | budget of **0.89 CPU-s per request** across 16,200 requests | wide *if* functions stay I/O-bound |
| Provisioned Memory | 360 GB-hrs | **see below** | **tightest dimension** |

**Provisioned memory is the Vercel dimension with the least headroom, and it scales with wall-clock
duration.** V16 records Hobby function memory as 2 GB, so 360 GB-hrs ≈ 180 function-hours ≈ 648,000
function-seconds per month:

```
realistic, ~8 s average:  16,200 × 8 s  = 129,600 s = 36 h × 2 GB =  72 GB-hrs  →  20% of 360
pathological, full 45 s:  16,200 × 45 s = 729,000 s = 202.5 h × 2 GB = 405 GB-hrs → 113% of 360 ✗
```

So if every request ran to the full soft budget, the monthly memory allowance would be **exceeded**.
At a realistic average it uses a fifth of it. Two things follow. First, **the section 3 timeout budget
is a cost control as well as a UX control** — this is a second, independent reason not to widen it
toward a fraction of 300 s. Second, average request duration is worth watching in `usage_logs`
(`latency_ms` is already recorded, D10); a rising average is a billing signal, not only a performance
one. If a smaller function memory size is configurable this scales down proportionally, but V16 does
not record that as configurable on Hobby, so it is not assumed here.

**Active CPU** cannot be computed from `VERIFIED_VALUES.md`, because it bills measured CPU time rather
than wall-clock, and Jamee's functions spend nearly all their wall-clock waiting on provider and
MongoDB I/O. The 0.89 CPU-s per-request budget is the figure to watch. JSON parsing, the
HMAC-SHA256 over a webhook body (the Razorpay payment webhook, V27) and Zod validation of a few KB
sit far below it. The path where bytes move through a function is the **media relay**: under Amendment
A3 the browser now uploads a re-encoded file to Jamee's authenticated Media_Endpoint, which writes it
to **GridFS** (there is no browser-reachable object store anymore), and the Telegram channel downloads
inbound media with a single `getFile` (V25, 20 MB bot-download ceiling) before writing it to the same
GridFS bucket. That relay is I/O-bound rather than CPU-bound, so it should be fine, but it is the path
worth measuring. Note V16's 4.5 MB limit binds the Media_Endpoint upload (which is why the A3 voice
cap is 3 MB), but the Telegram webhook POST body is JSON metadata only.

> *Retired detail (pre-A3/A1):* under the earlier stack this relay was the WhatsApp media path —
> V14's two-step retrieval downloaded media bytes and re-uploaded them to **Supabase** storage,
> bounded by Meta's inbound caps of 5 MB per image and 16 MB per audio. Both the WhatsApp retrieval
> and the Supabase object store are gone; the CPU concern (bytes crossing a function) survives the
> substrate change, which is why it is re-stated above on the current GridFS path.

The web path never handles media bytes in a plain analysis request: the browser uploads once to the
Media_Endpoint (which streams to GridFS), and the diagnosis/voice *analysis* requests then carry only
a small `Media_Reference` in their JSON body, so the analysis handlers stay tiny even though the media
now transits a Jamee function on the upload leg (design: *Amendment A3*, the Media_Endpoint).

### Storage budget — current substrate is Atlas M0, not Supabase (V19, V32)

> **The current storage constraint is the single MongoDB Atlas M0 512 MB (0.5 GB) cluster budget,
> shared by records *and* GridFS media** (V32, A3). The authoritative retention arithmetic against
> that number is in [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) step 10:
> `(media bytes/day) × (retention days) + thumbnails + records < 512 MB`, which at ~400 KB images
> plus small thumbnails and 3 MB-capped voice notes leaves a **7-day** window comfortably inside
> 512 MB for the ~6-farmer pilot. Because that budget is a *single shared* pool — tighter than the
> retired Supabase split of a 500 MB database plus a separate 1 GB object store — retention is more
> load-bearing under A3, not less (P8-2 flags `MEDIA_RETENTION_DAYS` for early review).
>
> The **Supabase Free** tables and arithmetic that follow are the **retired pre-A3 analysis**, kept
> because the *shape* of the reasoning — that media accumulation, not records, is the binding
> dimension, and that a fixed byte budget with no retention window is a deadline rather than a limit —
> carried directly across to the M0 substrate. Read them as the record of how the retention
> requirement was reached, not as current allowances: there is no Supabase database, egress meter, or
> object-storage bucket in the deployed system, and analysis sends bytes **inline** to the provider
> (V34) rather than minting a signed URL.

#### Retired pre-A3 analysis — Supabase Free (V19)

| Dimension | Free allowance | Jamee worst case | Reading |
| --- | --- | --- | --- |
| Database size | 500 MB / project | ~**1.25 MB/day** → ~37 MB/month | ~13 months at worst-case load |
| Egress | 5 GB / month | **see below** | binding on media size |
| Storage size | 1 GB | **see below** | **binding constraint** |
| Monthly active users | 50,000 | 6 | irrelevant |
| Realtime, Edge Functions | 2M msgs, 500K invocations | unused in this release | irrelevant |

**Database — comfortable.** Per image diagnosis ≈ 4 KB (a `diagnoses` row carrying the explanation
text, two `messages` rows, one `usage_logs` row); per chat ≈ 1.8 KB; per voice ≈ 2.1 KB. At worst-case
load: `120 × 4 + 300 × 1.8 + 120 × 2.1 = 1,272 KB/day ≈ 1.25 MB/day ≈ 37 MB/month`. Treat that as a
floor — the 500 MB includes indexes and Postgres overhead, and `messages` carries several indexes
(migration `0003`). Review at ~6 months rather than assuming 13.

**Egress — sets a hard ceiling on average media size.** 5 GB/month ≈ **170 MB/day**. Media bytes leave
Supabase once per model call that reads them, because both providers accept a URL: V6 (Gemini image
input by URI or public URL) and V10 (Groq transcription by `url`, and required over `file` above the
25 MB attachment cap). Worst case is 240 provider media reads/day — 120 images + 120 audio:

```
170 MB/day ÷ 240 reads ≈ 0.71 MB per object
```

**Worst-case load fits inside the free egress allowance only if the average media object is under
~700 KB**, and that ignores history and detail views, which read the *same objects again*. A 10 MB
image — the upload ceiling the design enforces (Requirement 2.4) — would blow the monthly allowance in
about four days at worst-case load. Consequences:

- **Client-side downscaling before upload is not optional at this tier.** Target well under 700 KB;
  ~400 KB leaves room for history views. This belongs in `ImageUploader` (task 12.1) and is currently
  not in its task description — flagged for the user, not silently added.
- **Keep passing signed URLs to providers rather than bytes.** Provider-fetches-URL costs one Supabase
  egress. Function-downloads-then-posts costs the same Supabase egress *plus* Vercel outbound transfer,
  for no benefit. The design already does the former; this is the quantitative reason to keep it.
- **History thumbnails read full originals.** Requirement 12.5 mints signed URLs for thumbnails, and
  no resized derivative exists, so one history screen showing 20 diagnoses egresses 20 full-size
  images. Short signed-URL expiry (V3, seconds) limits browser cache reuse, so repeat views re-fetch.
  Whether Supabase offers an image transformation or resize capability on the Free plan is **not
  recorded in `VERIFIED_VALUES.md`** — if egress becomes binding, that should be added as a V-item
  rather than guessed at. A stored small derivative at upload time is the alternative that needs no
  new platform capability.

**Storage — the binding constraint, exhausted in about a week at worst-case load.** Originals
accumulate; nothing in the current plan deletes them. Worst case is 240 new objects/day (120 images +
120 voice):

| Average object size | Accumulation / day | Days to fill 1 GB |
| --- | --- | --- |
| 700 KB (the egress ceiling) | 168 MB | **~6** |
| 500 KB | 120 MB | ~8.5 |
| 300 KB | 72 MB | ~14 |
| 150 KB | 36 MB | ~28 |

At a more realistic 20% of quota (48 objects/day) and 300 KB average: 14.4 MB/day → **~71 days**. So
even a modest pilot fills 1 GB inside a quarter, and a fully-active one fills it inside a week.
**A 1 GB allowance with no retention policy is a deadline, not a limit.** The arithmetic a retention
window has to satisfy is just `daily_bytes × retention_days ≤ 1 GB` — at 168 MB/day that is 6 days,
at 14.4 MB/day it is 71.

Three things need to be true, and none of them is currently in the plan:

1. **A retention window has to exist**, expressed in days, deleting media originals older than the
   window while keeping the `diagnoses` and `messages` rows — the database can hold the record for
   years (37 MB/month), only the bytes have to go.
2. **Retention collides with history.** Requirements 12.1–12.5 promise thumbnails and a detail view
   with the image. Deleting an original breaks both. Either history degrades gracefully to an
   image-less record past the window, or a small derivative is kept and the original alone is deleted.
   The second option also fixes the thumbnail egress amplifier above. This is a product decision.
3. **Voice originals may not need keeping at all.** Nothing in the requirements reads a voice recording
   back after transcription — Requirement 8.6 renders transcript above answer, and Requirement 8.8
   rules out audio playback in this release. The transcript is persisted as a message. So voice
   objects are candidates for deletion very shortly after a successful transcription, which removes
   half the accumulation rate.

Recorded here for tasks 28.1 / 28.2 to plan. **Not implemented, because no requirement currently
authorises deleting a farmer's media** and inventing one would be the wrong move — it needs the
user's decision.

### Summary

| Constraint | Status at worst-case 6-farmer load |
| --- | --- |
| Vercel invocations, edge requests, transfer | Wide headroom — ~1.6% of the invocation allowance |
| Vercel Active CPU | Expected wide; unmeasurable from documented values. Watch the GridFS media relay (the upload leg through the Media_Endpoint, and Telegram `getFile`) |
| Vercel Provisioned Memory | 20% at ~8 s average, **113% if every request ran the full 45 s budget** — duration is the lever |
| Atlas M0 cluster storage (records + GridFS media, one 512 MB pool) | **Binding.** Sized by the retention window in `docs/DEPLOYMENT.md` step 10; a 7-day window fits at pilot scale. Tighter than the retired Supabase split, so retention is load-bearing |
| Gemini free tier | **UNRESOLVED (U-V19a)** — record at deployment; code needs no change |
| Groq free tier | **UNRESOLVED (U-V19b)** — record at deployment; code needs no change |

Requirement 17.7 ("operate within the free tiers ... for a load of 6 Farmers") is satisfiable, with two
conditions: **downscale images client-side** (the ~400 KB Downscale_Target, now enforced in the browser
before the Media_Endpoint upload), and **a bounded media retention window** against the M0 512 MB
budget (default 7 days, `MEDIA_RETENTION_DAYS`).

---

## 6. Non-technical constraints for `docs/DEPLOYMENT.md`

Neither is a code concern; both bind the deployment and would be expensive to discover late.

**Vercel Hobby is restricted to non-commercial, personal use.** V19 records this from the fair use
guidelines — a licensing constraint on the deployment target, not a technical one. A 6-farmer pilot
must stay non-commercial while it is hosted on Hobby; the moment Jamee takes money or operates as a
business service, the plan is wrong and the numbers in section 5 no longer apply. V19 also notes that
exceeding a Hobby usage limit generally means waiting out a 30-day window, which matters given how
close provisioned memory can get.

**The Telegram channel has no reply window and needs no message template (A1).** The second channel is
Telegram (Amendment A1), and Telegram imposes **no 24-hour customer-service window and no template
requirement** — a reply is a plain `sendMessage` (V24), so a late reply is a latency problem, not an
undeliverable message. There is therefore **nothing to record in `docs/DEPLOYMENT.md` about reply
windows or template pre-approval**; the only send-side facts that matter are the 4096-character text
cap (V24), which the diagnosis formatter truncates or splits below, and Telegram's non-200 redelivery
of the same `update_id`, which the idempotency claim already handles (section 4).

> *Retired constraint (pre-A1 — WhatsApp).* The earlier stack's second channel was WhatsApp, whose
> **24-hour customer-service window** did bind replies: a timer started on each inbound user
> message/call and reset on the next, free-form service messages were allowed while it was open, and
> only pre-approved templates could be sent once it closed (V15, retired). Because every Jamee reply
> answered an inbound message, the window was open by construction and no template was needed for the
> normal flow — but a deferred reply beyond 24 hours would have needed one, a send could fail inside
> an apparently-open window, and a send 200 confirmed acceptance not delivery. All of this retired
> with the channel: it is kept only to explain why section 4's inline-processing decision never
> acquired a template dependency. On Telegram none of it applies.

---

## 7. Unresolved items this document depends on

Every item is `UNRESOLVED` in `VERIFIED_VALUES.md`. None is substituted with a plausible value here.

| Item | What is missing | What this document does instead | What code must do until resolved |
| --- | --- | --- | --- |
| **U-V19a** | Gemini free-tier RPM / RPD | Omits a Gemini provider row from the headroom tables | Nothing changes. Requirement 14.4 handles provider limits reactively; Jamee's own quotas are independent. Record from the AI Studio page at deployment |
| **U-V19b** | Groq free-tier RPM / TPD | Uses Developer-plan numbers **only** as an explicitly labelled upper-bound sanity check | Same as U-V19a. Never encode either set of numbers as a Jamee limit |
| **U-V11** | No documented Gemini `retry-after` | States exponential backoff with jitter as the Gemini policy | Exponential backoff with jitter, bounded attempts, bounded by the shared deadline. Read a retry-after header only if one is present at runtime |
| **U-V7** | Whether `temperature` is accepted on the Interactions API `generation_config` | Notes `thinking_level: 'minimal'` and `seed` as the documented alternatives for D7 determinism and for latency | Confirm against the `@google/genai` types at task 8.2. If `temperature` is unavailable, D7's parity definition cites `thinking_level` and `seed` instead |
| **U-V10** | No documented maximum audio duration for Groq transcription | Derives the transcribe budget from the size cap and the app's own 120 s recording rule | Never present a duration limit to a farmer as a provider limit. Derive the recording cap from size plus the app's own rule |
| **U-V20** | Which container/codec `MediaRecorder` actually records on target Android browsers | Treats audio size, not container, as the transcribe budget driver | Probe an ordered candidate list with `isTypeSupported()`, record the first supported type, send the observed `mimeType`, and validate it against V10's accepted container list |

Two items are noted rather than tabled because they touch this document only historically: **U-V12**
(inbound image/audio webhook field paths) and **U-V13** (the `X-Hub-Signature-256` byte encoding) both
gated the **retired** WhatsApp path that section 4 now discusses only as history — both are closed by
retirement (Amendment A1), not by resolution, and neither has any current code path. Telegram's
equivalents are resolved (V24–V26), and the payment webhook's signature encoding is resolved
(U-V27a, lowercase hex). Neither affects the acknowledgement decision.

### Gaps this document surfaced that are not yet V-items

Deriving the matrix and the budgets turned up four questions `VERIFIED_VALUES.md` does not currently
cover. None of them blocks a task, and none is answered by assumption above. They belong in V-items so
the next person does not rediscover them.

| Gap | Where it bites | Proposed home |
| --- | --- | --- |
| Whether `waitUntil` work can extend an invocation **past `maxDuration`** — V18 says the handler lifetime is extended for the promise's duration, and calls `getDeadline()` the *shared* invocation deadline, but does not reconcile the two | Section 4 assumes it cannot, which is the conservative reading and the one that keeps the acknowledgement question a UX question | V18 |
| The `@google/genai` JS SDK's **internal retry defaults** — V11 records the Python SDK's (4 attempts, ~1 s initial, 60 s max) but not the JS SDK's | Section 3's abort-signal requirement; a 60 s internal cap exceeds the whole 45 s budget | V11, at task 8.2 |
| Whether Groq's rate limits are **per-model or per-account** — U-V19b's table lists limits per model without saying which scope applies | Section 5's sanity check, shown both ways because both fit | V19 / U-V19b, at deployment |
| ~~Whether Supabase Free offers an image transformation or resize capability~~ — **moot under A3.** There is no Supabase and no per-read egress meter; analysis sends bytes inline (V34) and history thumbnails are a small derivative stored in GridFS at upload (`metadata.kind = 'thumbnail'`, D17), so no server-side resize capability is needed | Was section 5's history-thumbnail egress amplifier under Supabase; removed by the A3 substrate change | n/a — closed by A3 |

The Whisper models' **tier** (Preview vs. production) is a fifth, smaller gap, described in the tier
note in section 1. It matters only if a config gate is ever wanted for the voice path.
