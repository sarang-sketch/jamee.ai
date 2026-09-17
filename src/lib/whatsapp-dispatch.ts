import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { getDeadline } from '@vercel/functions';

import {
  ATTEMPT_BUDGETS,
  computeDeadline,
  type Capability,
  type RunOptions,
} from '@/lib/ai/gateway';
import { TRANSCRIBE_MIN_SECONDS } from '@/lib/config/verified';
import {
  usageLogWriterFrom,
  writeUsageLog,
  type UsageLogWriter,
} from '@/lib/db/usage-log';
import {
  attachResolvedProfile,
  claimInbound,
  markFailed,
  markProcessed,
  markRejected,
  type InboundStoreOptions,
} from '@/lib/db/whatsapp-inbound';
import { AppError, isAppError, toEnvelope } from '@/lib/errors';
import { messages } from '@/lib/messages';
import { DEFAULT_LANGUAGE } from '@/lib/profile';
import {
  languageSchema,
  type DiagnosisResult,
  type Language,
  type Operation,
} from '@/lib/schemas';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  isInboundMediaContent,
  sendWhatsappText,
  storeInboundMedia,
  type InboundContent,
  type InboundMediaResult,
  type InboundMessage,
  type SendReplyOptions,
  type SendReplyResult,
  type StoreInboundMediaOptions,
} from '@/lib/whatsapp';
import { chatAnswerer } from '@/services/chat.service';
import {
  conversationStoreFrom,
  findOrCreateActive,
  type ConversationStore,
} from '@/services/conversation.service';
import { diagnose } from '@/services/diagnosis.service';
import { ownsRequest } from '@/services/quota.service';
import { transcribeAndAnswer, type ChatAnswerer } from '@/services/voice.service';
import type { Database } from '@/types/database';

/**
 * The WhatsApp inbound pipeline: resolve the farmer, route by message type, call the **shared**
 * services, reply, and move the audit row.
 *
 * Requirements: 10.1 (every exchange goes through the official Cloud API), 10.2 (the sender's
 *               number resolves to a Profile through `profiles.phone`), 10.3 (an unresolvable
 *               number gets sign-in instructions), 10.4 / 10.5 / 10.6 (image → DiagnosisService,
 *               text → ChatService with the active WhatsApp conversation, audio → VoiceService),
 *               10.7 (the same Diagnosis_Result content as the web app for a given image),
 *               10.8 (a follow-up resolves against the most recent diagnosis in that
 *               conversation), 10.9 (a type outside text/image/audio gets the "photos, text and
 *               voice notes" reply), 10.10 (the whole invocation stays inside the duration
 *               ceiling — the soft deadline below), 10.11 (every accepted delivery is acknowledged
 *               with 200), 16.1, 16.2 (both channels obtain every Diagnosis_Result and every chat
 *               answer from the shared services), 16.5 (`channel` is a required input and reaches
 *               every persisted row)
 * Design: "WhatsApp adapter" → *Inbound processing order* steps 3–8, *Conversation find-or-create*,
 *         *Acknowledgement versus processing* (D11)
 * Depends on: V15 (the send endpoint and its 24-hour window), V14 (media retrieval, via
 *             `storeInboundMedia`), V12 / U-V12 (the inbound envelope and the provisional media
 *             shape), V16 / V17 (the duration ceiling the soft budget is a fraction of), V18
 *             (`getDeadline()`, and the `waitUntil` caveat D11 was re-argued against)
 *
 * =============================================================================
 * WHY THIS IS A SEPARATE FILE FROM `src/lib/whatsapp.ts`
 * =============================================================================
 *
 * `whatsapp.ts` is the *admission* module: it decides whether a request is Meta's, what Meta said,
 * and whether Jamee will accept the bytes. It takes no dependency on a service, a conversation, or
 * a quota, which is what lets every check in it be unit-tested with no database and no provider.
 * This module is the part that *acts*, so it imports the three services — and keeping the two
 * apart is what stops an admission check from quietly acquiring a service dependency.
 *
 * =============================================================================
 * REQUIREMENT 16 IS SATISFIED BY IMPORTS, NOT BY DISCIPLINE
 * =============================================================================
 *
 * The three dispatch seams are typed as `typeof diagnose`, `typeof transcribeAndAnswer` and
 * `ChatAnswerer` — the service functions themselves, not hand-written shapes — and the defaults are
 * those same functions. So there is **no WhatsApp-specific analysis, grounding, or rephrasing code
 * anywhere in this file**: it chooses a service, hands it `channel: 'whatsapp'`, and formats what
 * comes back into a WhatsApp message. A parallel implementation would have to change these types to
 * exist, which is what task 27.3's static architecture check looks for.
 *
 * The formatting is the one thing this file does own, and it is deliberately dumb: it concatenates
 * fields the service already produced, in the farmer's language, using headings from the same
 * message catalogs the web screens use. It adds no agricultural content — there is no sentence in
 * here that a farmer could mistake for advice.
 *
 * =============================================================================
 * WHO RESERVES A QUOTA UNIT, AND WHO DOES NOT
 * =============================================================================
 *
 * Nothing in this module reserves anything. That is not an omission — it is the reservation
 * -coverage rule of `quota.service.ts` applied to this channel:
 *
 *  - **image** → `diagnose()` reserves the `image` unit itself, as it does for the web route.
 *  - **audio** → `transcribeAndAnswer()` reserves the `voice` unit and passes
 *    `coveredBy(reservation)` to its nested chat call, so one voice note never spends both a voice
 *    and a chat unit.
 *  - **text** → `chatTurn()` reserves the `chat` unit, because a typed question is the entry point
 *    for its own request. This module says so by passing `ownsRequest(userId, 'chat')` — a branded
 *    `QuotaContext` the service cannot fabricate, and which `quotaContextFor()` inside the service
 *    reconciles against `ChatInput.skipQuotaReserve`.
 *
 * And the paths that spend **nothing** spend nothing structurally rather than by rule: an
 * unresolvable number, an unsupported type, and a refused media item all return before any service
 * function is called at all. `storeInboundMedia` — which has no quota dependency — runs *before*
 * the service call for exactly that reason.
 *
 * =============================================================================
 * THE ORDER IS THE REQUIREMENT
 * =============================================================================
 *
 * Steps 1 and 2 (verify the signature over the raw bytes, then parse) belong to the route and
 * `whatsapp.ts`, and `parseVerifiedInbound` cannot be reached without the verification proof.
 * `processInboundMessage` picks up at step 2's idempotency insert and runs 3–8 in one direction:
 *
 *   claim → resolve profile → attach profile → classify type → find-or-create conversation →
 *   dispatch (media admission, then the service, which reserves) → send the reply → mark terminal
 *
 * Every early return between `claim` and `dispatch` is a path that reached no provider and spent no
 * unit, and each one still sends a reply and still ends in a terminal status. The function is
 * therefore total over the outcomes migration `0008` models: a message that got this far ends
 * `processed`, `rejected` or `failed`, never `received`.
 *
 * =============================================================================
 * THE SOFT DEADLINE (task 22.3, D11) — AND WHY THE WORK STAYS INLINE
 * =============================================================================
 *
 * **V18 came back YES: `waitUntil()` from `@vercel/functions` exists, on the Node.js runtime, with
 * no plan restriction stated. D11 was re-argued on that finding and kept inline processing, and
 * this file implements the inline path deliberately rather than for want of a primitive.**
 *
 * The reason is recorded in `docs/PROVIDER_CAPABILITIES.md` section 4 and it is a single sentence:
 * `waitUntil`'s own documented caveat is that with request cancellation enabled, any work not
 * wrapped in it is lost and the execution context can be reclaimed — so a deferred pipeline's
 * late-failure signature is **silence**. The farmer gets no answer, no error and no explanation;
 * Meta will not redeliver, because Jamee already acknowledged; and the `whatsapp_inbound` row is
 * stranded at `received` with no code path left running to move it. Inline, the same failure is
 * visible from three sides at once: the farmer is told, the row says `failed`, and the response is
 * still a 200 so nothing is redelivered into a quota unit that was already spent.
 *
 * Nothing about the acknowledgement is at risk either way — Requirement 10.11 constrains *whether*
 * Jamee acknowledges, not how quickly, and `provider_message_id` is the primary key of
 * `whatsapp_inbound`, so a redelivery caused by a slow 200 is dropped before any service call.
 *
 * So `getDeadline()` (V18) is used for the *deadline*, and `waitUntil()` is not used at all.
 *
 * **The budget is the gateway's, not a second opinion.** `computeDeadline()` and `ATTEMPT_BUDGETS`
 * are imported from `src/lib/ai/gateway.ts`; there is no number in this file expressing how long a
 * delivery may take. Raising `JAMEE_MAX_DURATION_SECONDS` moves the gateway's 45 s soft budget, the
 * 15 s terminal reserve, and this path, in one edit.
 *
 * **One deadline covers the invocation, not each nested call.** `processInboundBatch` resolves the
 * budget once and hands the same instant to every message; each message hands it to the service it
 * calls (`runOptions` for the ChatService closure, `deadlineMs` for Diagnosis and Voice). Without
 * that threading a batch of three would grant itself three fresh 45 s budgets inside one 60 s
 * invocation, which is Requirement 10.10 read backwards.
 */

/* ========================================================================== */
/* Step 3 — `profiles.phone` → a Profile (Requirement 10.2)                     */
/* ========================================================================== */

/**
 * What the pipeline needs from a resolved Profile: who the farmer is, and which language to write
 * in (Requirement 15.3).
 *
 * `display_name` is deliberately absent. No reply addresses the farmer by name, so selecting it
 * would pull identity data into a service-role read that has no use for it — the same reasoning
 * `PROFILE_SETTINGS_SELECT` and `EXISTING_INBOUND_SELECT` give.
 */
export interface WhatsappProfile {
  readonly userId: string;
  readonly language: Language;
}

/** One place for the column list, so the seam's type and the statement cannot disagree. */
export const WHATSAPP_PROFILE_SELECT = 'id, language' as const;

/** The slice of a PostgREST error this module reads. `PostgrestError` satisfies it. */
export interface ProfileLookupError {
  readonly code: string;
  readonly message: string;
}

/**
 * The one read this module makes directly. A function seam rather than a mirrored PostgREST
 * builder, for the reason `ConversationStore` gives: a unit test should be able to state "this
 * number has no profile" without reproducing a query chain.
 */
export interface ProfileByPhoneStore {
  byPhone(e164Phone: string): Promise<{
    data: { readonly id: string; readonly language: string } | null;
    error: ProfileLookupError | null;
  }>;
}

/**
 * Adapt a Supabase client into the lookup.
 *
 * **Service role, and `admin.ts`'s rule is satisfied by the predicate itself:** `phone` is
 * `unique` in migration `0002`, so `.eq('phone', …)` addresses at most one row, named by the number
 * Meta delivered. That uniqueness is what makes Requirement 10.2 a function rather than a guess,
 * and it is why `maybeSingle()` is correct here — two rows would be a database-level impossibility,
 * not a case to handle.
 */
export function adminProfileByPhoneStore(
  client: SupabaseClient<Database> = createAdminClient(),
): ProfileByPhoneStore {
  return {
    async byPhone(e164Phone) {
      const { data, error } = await client
        .from('profiles')
        .select(WHATSAPP_PROFILE_SELECT)
        .eq('phone', e164Phone)
        // `maybeSingle`, not `single`: "no such farmer" is Requirement 10.3, not an error.
        .maybeSingle();
      return { data, error };
    },
  };
}

/**
 * Migration `0002`'s constraint, restated as a predicate: `^\+[1-9][0-9]{7,14}$`.
 *
 * It is here so a number that could not possibly be in the table is recognised **without a round
 * trip**, and so the normalizer below has something to be checked against.
 */
const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

/**
 * Turn Meta's `wa_id` into the string stored in `profiles.phone`.
 *
 * **This is load-bearing, and it is the single most likely place for the WhatsApp channel to fail
 * silently.** V12's `messages[].from` carries the sender as a `wa_id` — digits, **no leading `+`**
 * (`919876543210`). `profiles.phone` is constrained to strict E.164 **with** the `+`
 * (`profiles_phone_e164` in migration `0002`). Comparing the two as delivered matches nothing, and
 * the symptom is not an error: it is *every* farmer being told to sign in on a website they already
 * signed in on. So the `+` is added here, once, in a named function with a test.
 *
 * A value that still does not satisfy E.164 after normalization is returned as `null` rather than
 * queried. It cannot be in the table — the check constraint forbids it — so the round trip would
 * only confirm what the pattern already said, and Requirement 10.3's reply is the correct outcome
 * either way.
 */
export function normalizeInboundPhone(fromPhone: string): string | null {
  const trimmed = fromPhone.trim();
  if (trimmed === '') return null;

  const candidate = trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
  return E164_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Requirement 10.2. `null` means Requirement 10.3's branch.
 *
 * A lookup error **throws** rather than resolving to `null`. The two are not interchangeable:
 * `null` sends the farmer sign-in instructions, which for a farmer who *is* registered would be a
 * false statement caused by a database hiccup, and the delivery would be marked `rejected` — a
 * terminal status Meta will never redeliver past. An `INTERNAL_ERROR` becomes a 500, and V13 records
 * that Meta redelivers on a non-2xx, so the message survives.
 *
 * The `language` column is re-parsed through `languageSchema` instead of being trusted. Migration
 * `0002` has a check constraint on it, so a value outside `en | hi | mr` should be impossible — but
 * this is a service-role read with no RLS behind it, and every reply below is selected by this
 * value. An unparseable one falls back to `DEFAULT_LANGUAGE`, because a farmer reading English is
 * a far better outcome than a thrown lookup on a valid registration.
 */
export async function resolveProfileByPhone(
  fromPhone: string,
  store: ProfileByPhoneStore,
): Promise<WhatsappProfile | null> {
  const e164Phone = normalizeInboundPhone(fromPhone);
  if (e164Phone === null) return null;

  const { data, error } = await store.byPhone(e164Phone);

  if (error !== null) {
    throw new AppError('INTERNAL_ERROR', {
      cause: error,
      // The number itself is farmer PII and is the reason `0008` enables RLS with no policies;
      // only its shape is recorded.
      context: {
        reason: 'whatsapp_profile_lookup_failed',
        phoneDigits: e164Phone.length - 1,
        sqlstate: error.code,
      },
    });
  }

  if (data === null) return null;

  const language = languageSchema.safeParse(data.language);
  return {
    userId: data.id,
    language: language.success ? language.data : DEFAULT_LANGUAGE,
  };
}

/* ========================================================================== */
/* Reply copy — localized, and composed only from what a service produced       */
/* ========================================================================== */

/**
 * The language a reply is written in when there is **no profile to ask** (Requirement 10.3).
 *
 * `DEFAULT_LANGUAGE` rather than a literal, so Jamee has one opinion about its default. This is the
 * only branch in the whole pipeline that does not use the farmer's own preference, and it is
 * unavoidable: preference lives on the Profile, and this is the branch where there isn't one.
 */
export const UNRESOLVED_SENDER_LANGUAGE: Language = DEFAULT_LANGUAGE;

/** Blank line between blocks. WhatsApp renders `\n` literally, so paragraphs are explicit. */
const BLOCK = '\n\n';

/**
 * A `Diagnosis_Result` as a WhatsApp message.
 *
 * **Requirement 10.7 is why this function adds nothing.** "The same Diagnosis_Result content for a
 * given crop image as the Web_App returns" holds because both channels render the *same* service
 * output: `explanation` is already knowledge-base grounded and already localized by the service,
 * the canonical name is already in Latin script (Requirements 4.6, 9.4), and the severity label
 * comes from the same catalog entry the results screen uses. Nothing is summarized, re-worded, or
 * dropped, so the two channels cannot come to disagree about what a photo showed.
 *
 * The canonical name leads because it is the one string a farmer may want to search for or repeat
 * to an expert, and V15 caps a reply at 4096 characters — so if anything is lost to
 * `truncateReplyBody`, it is the tail of the explanation and never the diagnosis.
 */
export function formatDiagnosisReply(result: DiagnosisResult, language: Language): string {
  const { ui, severity } = messages(language);

  const heading =
    result.status === 'identified'
      ? `${result.diseaseName}${BLOCK}${ui.severityLabel}: ${severity[result.severity]}`
      : ui.inconclusiveLabel;

  const blocks = [heading, result.explanation];
  // Requirements 6.4 and 12.1: an inconclusive result says so, and says what to do next. An
  // identified result has `needsExpert: false` by type, so this cannot double up on it.
  if (result.needsExpert) blocks.push(ui.needsExpertBanner);

  return blocks.join(BLOCK);
}

/**
 * A chat answer as a WhatsApp message: the answer, and nothing around it.
 *
 * No heading and no expert banner. `content` is the whole answer the ChatService produced — and
 * when `needsExpert` is true it *is* the referral sentence (Requirements 4.7, 7.6), so appending
 * `needsExpertBanner` would tell the farmer to consult an expert twice in two different wordings.
 */
export function formatChatReply(content: string): string {
  return content;
}

/**
 * A voice answer as a WhatsApp message: what Jamee heard, then the answer.
 *
 * The transcript is included for the reason Requirement 8.6 gives it to the web path — a farmer who
 * can see the transcription can tell a wrong answer from a misheard question, which on a voice
 * channel is the difference between "Jamee is wrong" and "say it again". It is labelled with the
 * same catalog string the web screen uses.
 */
export function formatVoiceReply(
  transcript: string,
  content: string,
  language: Language,
): string {
  const { ui } = messages(language);
  return `${ui.transcriptLabel}: ${transcript}${BLOCK}${content}`;
}

/**
 * The farmer-facing sentence for a failure, in their language.
 *
 * Routed through `toEnvelope`, which is the codebase's leak boundary (Requirement 15.6): it reads
 * the code, the details and the catalog, and structurally never touches `message`, `stack` or
 * `cause`. So a provider payload or a stack fragment cannot reach a WhatsApp reply, for the same
 * reason it cannot reach an HTTP response body.
 */
export function failureReply(error: unknown, language: Language): string {
  const appError = isAppError(error) ? error : new AppError('INTERNAL_ERROR', { cause: error });
  return toEnvelope(appError, language).error.message;
}

/* ========================================================================== */
/* The soft deadline (task 22.3, D11 — Requirement 10.10)                       */
/* ========================================================================== */

/**
 * How the invocation's deadline is obtained, or the one already obtained.
 *
 * Every field is a seam, and the reason is testability rather than configurability: a deadline
 * asserted with a real 45 s wall clock is a test that takes 45 seconds. `now` and `platformDeadline`
 * are the same two seams `diagnosis.service.ts` and `voice.service.ts` expose for the same reason,
 * named identically so a reader moving between them does not have to translate. The pattern is
 * `InboundStoreOptions`'s: a small options bag with a real default behind it.
 */
export interface InboundDeadlineOptions {
  /** Injected clock, epoch ms. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /**
   * **V18's `getDeadline()`**, which returns the shared invocation deadline as a `Date`. Defaults to
   * the real one, and its absence is tolerated exactly as the gateway tolerates it — locally and
   * under test there is no platform deadline, and the 45 s arithmetic stands in.
   */
  readonly platformDeadline?: (() => Date | undefined) | undefined;
  /**
   * Epoch ms the invocation began. The webhook route reads it at the **top of the handler**, before
   * the signature check and the parse, because Requirement 10.10 is about the whole invocation and
   * not about the part of it that happens after the payload is understood.
   */
  readonly requestStartMs?: number | undefined;
  /**
   * A deadline already computed for this invocation. Set by `processInboundBatch` so that a batch of
   * N messages shares one instant instead of resolving N of them — the hazard
   * `docs/PROVIDER_CAPABILITIES.md` section 4 carries forward to this task.
   */
  readonly deadlineMs?: number | undefined;
}

/** The resolved form: one instant, and the clock it is compared against. */
export interface InvocationBudget {
  /** Epoch ms after which no further work starts on this invocation. */
  readonly deadlineMs: number;
  readonly now: () => number;
}

/**
 * Resolve the one deadline for this invocation.
 *
 * The arithmetic is **not** here — `computeDeadline()` in `src/lib/ai/gateway.ts` owns it, and it
 * reads `min(platformDeadline − 15 s, requestStart + 45 s)` from `SOFT_BUDGET_MS` and
 * `TERMINAL_RESERVE_MS`, both fractions of `JAMEE_MAX_DURATION_SECONDS`. That import is the whole
 * point of this function: D11 says "a fraction of the configured ceiling, **same constant as the
 * gateway budget**", and the only way to keep two numbers from drifting is to have one number.
 *
 * The platform deadline wins when it is tighter, because it is the limit that will actually be
 * enforced; the 45 s arithmetic wins when it is tighter, because Jamee declines to use the
 * platform's full 300 s (V16, and `docs/PROVIDER_CAPABILITIES.md` section 3's blockquote).
 */
export function resolveInvocationBudget(options: InboundDeadlineOptions = {}): InvocationBudget {
  const now = options.now ?? Date.now;
  if (options.deadlineMs !== undefined) return { deadlineMs: options.deadlineMs, now };

  const requestStartMs = options.requestStartMs ?? now();
  const at = (options.platformDeadline ?? getDeadline)();
  const platformMs = at === undefined ? undefined : at.getTime();

  return {
    deadlineMs: computeDeadline({
      requestStartMs,
      ...(platformMs === undefined || !Number.isFinite(platformMs)
        ? {}
        : { platformDeadlineMs: platformMs }),
    }),
    now,
  };
}

/** Milliseconds left before the soft deadline. Negative once it has passed. */
export function remainingBudgetMs(budget: InvocationBudget): number {
  return budget.deadlineMs - budget.now();
}

/**
 * The gateway capability a message of this kind will reach, or `null` when it reaches none.
 *
 * This is what turns the deadline check into a **spend rule** rather than a stopwatch. The gateway
 * already refuses to start a provider attempt below `ATTEMPT_BUDGETS[capability].minimumRemainingMs`
 * — a call whose result lands after the deadline is real cost for no value, and on a rate-limited
 * provider it consumes an allowance the next farmer needs. The same question has to be asked one
 * level up on this channel, because the work that happens *before* the service call is not free:
 * `storeInboundMedia` fetches Meta's media metadata and then the bytes, and neither reads a clock.
 *
 * `null` is the interesting case and it is deliberate. A sticker, a location, a contact card, a
 * `text` message with no `text.body`, or a media object that did not match the provisional U-V12
 * shape all reach **no provider at all** — `dispatch` answers them from a message catalog and
 * returns. They cost exactly one send, which is the same one send the deadline branch would cost, so
 * they are answered even past the deadline: telling a farmer who sent a sticker "Jamee is taking
 * longer than usual on this photo" would be both wrong and less useful than Requirement 10.9's
 * actual sentence.
 */
export function capabilityFloorFor(content: InboundContent): Capability | null {
  switch (content.kind) {
    // Requirement 10.5 — `chatTurn` → `text-generate`.
    case 'text':
      return 'text-generate';
    // Requirement 10.4 — `diagnose` → `vision-classify`, then a rephrase inside the same budget.
    case 'image':
      return 'vision-classify';
    // Requirement 10.6 — `transcribeAndAnswer` → `transcribe`, then the nested chat answer.
    case 'audio':
      return 'transcribe';
    // Refusals and payload defects. No provider, no media fetch, no reserve.
    case 'unsupported':
    case 'unconfirmed_media_shape':
      return null;
  }
}

/**
 * `usage_logs.operation` for a message this adapter is about to work on, or `null` when the message
 * reaches no operation at all.
 *
 * Keyed on `content.kind` rather than on `rawType`, unlike `operationForMessageType()` in
 * `whatsapp-inbound.ts`, and the difference is the point: that function classifies a *conflicting
 * row* read back from the database, where `message_type` is the only surviving evidence. Here the
 * payload has already been parsed, so `kind` is the stronger fact — a `text` message with no
 * `text.body` is `unsupported`, and auditing it as a `chat` operation on the strength of its raw
 * type would put an operation in the trail that Jamee never routed.
 *
 * `null` exactly where `capabilityFloorFor()` returns `null`, which is what makes the pre-flight gate
 * below total: every message the gate can refuse has an operation, because a message with no
 * capability floor is never refused for want of budget.
 */
export function operationForContent(content: InboundContent): Operation | null {
  switch (content.kind) {
    case 'text':
      return 'chat';
    case 'image':
      return 'image';
    case 'audio':
      return 'voice';
    case 'unsupported':
    case 'unconfirmed_media_shape':
      return null;
  }
}

/**
 * Whether this message's work may start.
 *
 * Note what is compared: the capability's **minimum remaining**, not the deadline itself. A photo
 * with 3 s left is not startable even though the deadline has not passed, because
 * `vision-classify` needs 6 s to be worth beginning — so the message reaches D11's branch with the
 * farmer told and the row honest, instead of spending a media download and a quota unit on a
 * classification whose answer arrives after the invocation is gone.
 *
 * **The floor is the first provider attempt's, not the whole pipeline's**, and that is a limit worth
 * naming. `ATTEMPT_BUDGETS` says nothing about the media fetch that precedes a photo or the rephrase
 * that follows it, and inventing a number for either would be the guess
 * `docs/VERIFIED_VALUES.md`'s fail-loud rule forbids. So a photo that starts with just over 6 s left
 * will usually run out *inside* the service instead — which lands on the same `failed` row and the
 * same farmer-facing sentence (see the `DIAGNOSIS_TIMEOUT` branch in `dispatch`), one media download
 * later. Tightening this needs a measured figure for the pre-flight work, not a plausible one.
 */
export function canStartWithin(content: InboundContent, budget: InvocationBudget): boolean {
  const capability = capabilityFloorFor(content);
  if (capability === null) return true;
  return remainingBudgetMs(budget) >= ATTEMPT_BUDGETS[capability].minimumRemainingMs;
}

/**
 * The `detail` on an `InboundResult` that D11's branch produced. Exported so the route can count
 * them in one log line without either side re-typing the string.
 */
export const SOFT_DEADLINE_DETAIL = 'soft_deadline_expired';

/* ========================================================================== */
/* Seams                                                                       */
/* ========================================================================== */

/**
 * The `ChatService` entry point, as this module needs it — **the same type
 * `src/services/voice.service.ts` already declares** for its nested call, imported rather than
 * re-stated so there is one definition of "the composed ChatService" in the codebase.
 *
 * "Composed" means: takes the `QuotaContext`, reserves when it owns the request, calls
 * `answerQuestion`, and persists the farmer message and Jamee's answer — which is exactly
 * `chatTurn`, bound by `chatAnswerer()`. `answerQuestion` alone is **not** this: it reserves nothing
 * and writes nothing, and calling it directly from here would put a second copy of the chat
 * spend-and-persist rule in the WhatsApp adapter, which is the drift Requirement 16.2 exists to
 * prevent. The default below is `chatAnswerer`, so the web route and this adapter differ only in
 * which credential they bind.
 */
export type WhatsappChatService = ChatAnswerer;

/** `DiagnosisService`, by its own type. A parallel implementation cannot satisfy this. */
export type WhatsappDiagnosisService = typeof diagnose;

/** `VoiceService`, by its own type. */
export type WhatsappVoiceService = typeof transcribeAndAnswer;

/** Media retrieval and the service-role upload (task 22.1), by its own type. */
export type WhatsappMediaStore = (options: StoreInboundMediaOptions) => Promise<InboundMediaResult>;

/** The V15 send call, by its own type. */
export type WhatsappSender = (options: SendReplyOptions) => Promise<SendReplyResult>;

/**
 * What the adapter declares for `VoiceInput.durationSeconds` on this channel.
 *
 * **WhatsApp does not tell Jamee how long a voice note is.** V12 confirms the inbound envelope and
 * the text path; no duration field is documented for `messages[].audio`, and the provisional U-V12
 * media shape deliberately does not invent one. `VoiceInput.durationSeconds` is nonetheless
 * required, because the *web* path measures it in the browser and Requirement 8.2's 120 s recording
 * rule is re-checked server-side against it.
 *
 * So this value asserts the weakest thing Jamee can honestly assert: exactly V10's documented
 * **minimum** transcribable length. Two consequences, both intended:
 *
 *  - `assertAdmissibleAudio`'s two duration checks become no-ops on this channel, which is correct.
 *    Jamee has not measured a duration and must not refuse a real voice note over a number it
 *    invented, nor report an invented one in a log line as though it had been observed.
 *  - The operative bound becomes the **size** cap, `inboundMediaCap('audio')` — the tighter of
 *    Jamee's 10 MB and V14's 16 MB — which `storeInboundMedia` has already enforced *before* the
 *    reserve. That is the one limit this channel can enforce truthfully.
 *
 * **Recorded limitation.** A WhatsApp voice note longer than Requirement 8.2's 120 s is therefore
 * admitted where the web recorder would have stopped, and is bounded by 10 MB instead. Closing that
 * gap needs a duration Jamee can measure — a confirmed Meta field (a V12 follow-up) or probing the
 * decoded audio — and inventing one here is the guess `docs/VERIFIED_VALUES.md`'s fail-loud rule
 * forbids.
 */
export const WHATSAPP_AUDIO_UNMEASURED_DURATION_SECONDS = TRANSCRIBE_MIN_SECONDS;

export interface WhatsappDispatchDeps {
  /**
   * The credential every service call and every read on this path uses.
   *
   * **Service role, necessarily.** A webhook carries no cookies, so there is no RLS-scoped client
   * to build; `admin.ts`'s rule — every service-role query carries an explicit `user_id` anchor —
   * is what stands in for RLS here, and the resolved `userId` is that anchor on every call below.
   * Defaulted lazily so an injected set of seams reads no secret.
   */
  readonly supabase?: SupabaseClient<Database> | undefined;

  /**
   * The composed `ChatService`. Defaults to `chatAnswerer({ supabase, runOptions, now })`, built
   * lazily so an injected seam reads no secret — the same binding task 15.3's route makes with its
   * own RLS-scoped client.
   *
   * **`runOptions` is how the invocation's deadline reaches a nested chat answer.** `ChatAnswerer`
   * takes an input and a `QuotaContext` and has no parameter for a deadline, so the closure is the
   * only channel for one; without it the model call inside a WhatsApp voice note would compute a
   * fresh 45 s budget from the moment it was reached, which on a batched delivery is how a single
   * 60 s invocation comes to believe it has several minutes.
   */
  readonly chat?: WhatsappChatService | undefined;

  readonly profiles?: ProfileByPhoneStore | undefined;
  readonly conversations?: ConversationStore | undefined;
  /** The `whatsapp_inbound` seam and clock, forwarded to every status transition. */
  readonly inbound?: InboundStoreOptions | undefined;
  /**
   * The audit seam for the **one** row this module writes itself: the pre-flight soft-deadline
   * refusal (Requirement 3.7). Every other row on this channel is written by the service that did
   * the work, because only it knows the provider and the fallback flag.
   *
   * Defaults to `usageLogWriterFrom(supabase())`, built lazily so an injected set of seams reads no
   * secret — the same discipline every other default here follows.
   */
  readonly usage?: UsageLogWriter | undefined;
  /**
   * D11's soft deadline. Omitted, `processInboundBatch` resolves one from `getDeadline()` and the
   * gateway's budget; supplied with `deadlineMs`, it *is* the resolved one and is used as given —
   * which is how the batch hands every message the same instant.
   */
  readonly deadline?: InboundDeadlineOptions | undefined;
  readonly diagnose?: WhatsappDiagnosisService | undefined;
  readonly voice?: WhatsappVoiceService | undefined;
  readonly media?: WhatsappMediaStore | undefined;
  readonly send?: WhatsappSender | undefined;
}

/* ========================================================================== */
/* Outcomes                                                                    */
/* ========================================================================== */

export type InboundDisposition =
  /** Requirement 11.5 — the claim found the id already recorded. No reply, nothing spent. */
  | 'duplicate_ignored'
  /** Requirement 10.3 — no Profile for this number. Sign-in instructions, `rejected`. */
  | 'rejected_unresolved_sender'
  /** Requirement 10.9 — a sticker, a location, a contact card. `rejected`. */
  | 'rejected_unsupported_type'
  /** Media outside the accepted type or size (Requirement 2.4 / 8.3's limits). `rejected`. */
  | 'rejected_media'
  /** The delivery was answered and the reply was handed to Meta. `processed`. */
  | 'processed'
  /**
   * Jamee could not finish: a service failed, the payload contradicted a confirmed V12 path, the
   * provisional media shape did not match (U-V12), the reply could not be sent, or **the soft
   * deadline left too little of the invocation to start the work** (D11, `detail`
   * `soft_deadline_expired`). `failed` — which is a different fact from `rejected`'s "Jamee decided
   * not to act".
   */
  | 'failed';

export interface InboundResult {
  readonly providerMessageId: string;
  readonly disposition: InboundDisposition;
  /** Whether a reply reached Meta. `false` on a duplicate and on a failed send. */
  readonly replySent: boolean;
  /** Server-side only. A reason code, never farmer content and never a phone number. */
  readonly detail: string;
}

/* ========================================================================== */
/* Logging                                                                     */
/* ========================================================================== */

/**
 * Same channel and prefix as `src/lib/errors.ts` and the route, for the same reason: on the target
 * platform `console.*` is what reaches the runtime log.
 *
 * **No `fromPhone`, no message body, no transcript, no caption.** The WAMID identifies the delivery
 * and is not farmer content; everything else here is a reason code or a count.
 */
function note(event: string, detail: Record<string, unknown>): void {
  console.info(`[jamee] whatsapp.${event}`, JSON.stringify(detail));
}

function warn(event: string, detail: Record<string, unknown>): void {
  console.warn(`[jamee] whatsapp.${event}`, JSON.stringify(detail));
}

/* ========================================================================== */
/* The pipeline                                                                */
/* ========================================================================== */

/**
 * What the dispatch produced. Three kinds rather than two, because `rejected` and `failed` are
 * different facts in migration `0008`'s status machine: Jamee **decided not to act** versus Jamee
 * **could not finish**. Every kind carries a farmer-facing body, so there is no branch that
 * acknowledges a delivery in silence.
 */
type DispatchOutcome =
  | { readonly kind: 'reply'; readonly body: string }
  | { readonly kind: 'refusal'; readonly body: string; readonly detail: string }
  | { readonly kind: 'failure'; readonly body: string; readonly detail: string };

/**
 * Run steps 3–8 for **one** inbound message.
 *
 * Per message rather than per delivery, deliberately: V13 records that Meta may batch up to 1000
 * updates in one notification, and `provider_message_id` is the idempotency key — so a batch-wide
 * claim or a batch-wide `markProcessed` would silently discard the entries that were never worked
 * (`whatsapp-inbound.ts` documents that contract at length). Each message claims, works, replies
 * and reaches its own terminal status.
 *
 * Never throws for a farmer-visible condition. It throws only when the *audit* cannot be trusted —
 * a claim insert that failed for an unknown reason, a profile lookup that errored, an
 * `attachResolvedProfile` that failed — because those are the cases where a 500 and Meta's
 * redelivery is the recovery, and a 200 would discard the message for good.
 */
/**
 * The audit row for a pre-flight soft-deadline refusal (task 22.3's gate, D11's branch).
 *
 * =============================================================================
 * WHY THIS ROW EXISTS AT ALL — TASK 22.3 LEFT IT OPEN, TASK 24.3 CLOSED IT
 * =============================================================================
 *
 * The gate used to write nothing, on the argument that nothing reached a provider. Re-checked
 * against the criteria, that argument holds for one of them and fails for the other:
 *
 *  - **Requirement 14.6** asks for a row "when the AI_Gateway completes a model operation". This
 *    path completes none, so 14.6 alone would not require a row — and that is exactly the reasoning
 *    the duplicate guard still relies on to write nothing when it cannot attribute a farmer.
 *  - **Requirement 14.7** has nothing to record: no gateway call means no fallback, which is why
 *    `used_fallback` here is a stated `false` rather than an omission.
 *  - **Requirement 3.7 is the one that settles it.** "IF the Diagnosis_Service reaches the
 *    Serverless_Duration_Ceiling before a Diagnosis_Result exists, THEN THE API_Layer SHALL return a
 *    timeout error … and SHALL record the outcome in the Usage_Log." D11's soft deadline **is**
 *    Jamee's reading of that ceiling on this channel — `computeDeadline()` derives it from
 *    `JAMEE_MAX_DURATION_SECONDS`, the same ceiling — and this branch is precisely "reached it before
 *    a result existed". 3.7 does not distinguish reaching it *before* the first provider call from
 *    reaching it *during* one; it asks for the outcome, and refusing to record the earlier case would
 *    make `outcome = 'timeout'` mean "expired late" rather than "expired".
 *
 * So the row is written, and 0011's comment already commits to it: `'timeout'` is documented there as
 * "a budget expiry, **pre-flight or in-flight**".
 *
 * ### The columns, and why each value is the honest one
 *
 *  - `outcome: 'timeout'` — Requirement 3.7's value, on all three operations rather than only on the
 *    image path. A typed question refused by the same gate expired for the same reason, and giving it
 *    a different outcome would make a `group by outcome` answer "how often did Jamee run out of time"
 *    for photos only.
 *  - `provider: 'none'` — the positive statement 0006 permits: no provider served this row.
 *  - `quotaSpent: false` — the spend rule's biconditional read in the direction it is usually not:
 *    **no** provider call was attempted, so no unit is spent. The reserve lives *inside* the service
 *    this gate refuses to call, so there is nothing to refund either. (An in-flight timeout is the
 *    opposite — `true`, no refund — because a call was really issued.)
 *  - `latencyMs` — the time it took to refuse, measured from the top of this message's work rather
 *    than from the batch's start, so a batch of three does not report the third refusal as though it
 *    had spent the whole invocation on itself.
 *
 * ### Why it is written here and not by a service
 *
 * Because no service was called. This is the one audit row this module owns, and the gate is the one
 * place that knows both facts it needs: the farmer (attached one line above at step 3b, which is
 * what makes the row attributable rather than an orphan) and that the work never started.
 *
 * A message with no operation cannot reach this function: `canStartWithin()` returns `true` whenever
 * `capabilityFloorFor()` is `null`, so a sticker is answered rather than refused. The `null` branch
 * below is therefore unreachable today and is written as a skip rather than a throw — `operation` is
 * `not null` with a three-value constraint in 0006, and inventing a fourth to satisfy a case that
 * cannot happen would put a fictional operation in the trail if it ever did.
 *
 * Never throws: `writeUsageLog` swallows and logs. The farmer has already been told to send again and
 * the `whatsapp_inbound` row already says `failed`; turning a missed audit line into a non-200 would
 * ask Meta to redeliver a message whose outcome is settled.
 */
async function auditSoftDeadline(
  message: InboundMessage,
  profile: WhatsappProfile,
  deps: WhatsappDispatchDeps,
  supabase: () => SupabaseClient<Database>,
  latencyMs: number,
): Promise<void> {
  const operation = operationForContent(message.content);
  if (operation === null) return;

  const writer = deps.usage ?? usageLogWriterFrom(supabase());

  await writeUsageLog(writer, {
    userId: profile.userId,
    operation,
    channel: 'whatsapp',
    outcome: 'timeout',
    provider: 'none',
    usedFallback: false,
    quotaSpent: false,
    latencyMs: Math.max(0, latencyMs),
  });
}

export async function processInboundMessage(
  message: InboundMessage,
  deps: WhatsappDispatchDeps,
): Promise<InboundResult> {
  const { providerMessageId } = message;
  const inboundOptions: InboundStoreOptions = deps.inbound ?? {};
  /**
   * The instant this message's work began, for `latency_ms` on the pre-flight audit row below.
   *
   * Taken from `deps.deadline?.now` rather than `Date.now` directly so it is the *same* clock
   * `resolveInvocationBudget` will compare the deadline against. A test that pins one and not the
   * other would be measuring an interval between two different clocks, which is how a fixed-clock
   * test comes to report a latency of several hours.
   */
  const clock = deps.deadline?.now ?? Date.now;
  const startedMs = clock();

  /* ── Step 2. The claim, before anything billable is reachable (11.5, 11.6) ── */
  const claim = await claimInbound(message, inboundOptions);
  if (claim.outcome === 'already_seen') {
    note('duplicate.ignored', {
      providerMessageId,
      existingStatus: claim.existing?.status ?? null,
      auditLogged: claim.audit.logged,
    });
    return {
      providerMessageId,
      disposition: 'duplicate_ignored',
      replySent: false,
      detail: 'provider_message_id_already_recorded',
    };
  }

  const send = deps.send ?? sendWhatsappText;

  /**
   * The credential, built **lazily and at most once per message**.
   *
   * Lazy because a delivery Jamee refuses before step 3 never needs one, and `createAdminClient()`
   * reads `SUPABASE_SERVICE_ROLE_KEY`. Memoized because the profile lookup, the conversation read
   * and the service call must share one client rather than open three — `admin.ts` deliberately does
   * not memoize, so the caller has to.
   */
  let client = deps.supabase;
  const supabase = (): SupabaseClient<Database> => (client ??= createAdminClient());

  /* ── Step 3. `profiles.phone` → a Profile (10.2, 10.3) ────────────────────── */
  const profiles = deps.profiles ?? adminProfileByPhoneStore(supabase());
  const profile = await resolveProfileByPhone(message.fromPhone, profiles);

  if (profile === null) {
    /**
     * Requirement 10.3, and every clause of it: the instructions go out, the row becomes
     * `rejected`, 200 is returned by the caller, and **nothing was spent** — no service function
     * exists above this line to spend it. The reply is in `UNRESOLVED_SENDER_LANGUAGE` because
     * there is no profile to read a preference from.
     */
    const signInFirst = messages(UNRESOLVED_SENDER_LANGUAGE).whatsapp.signInFirst;
    const replySent = await deliver(send, message, signInFirst);
    await markRejected(providerMessageId, inboundOptions);
    warn('sender.unresolved', { providerMessageId, replySent, type: message.rawType });
    return {
      providerMessageId,
      disposition: 'rejected_unresolved_sender',
      replySent,
      detail: 'no_profile_for_sender_phone',
    };
  }

  /**
   * Step 3b. The claim was inserted before the profile was known, so the row carries no `user_id`
   * yet — and without this write no future redelivery of this message could ever be attributed to
   * a farmer in the audit. It throws on failure for that reason.
   */
  await attachResolvedProfile(providerMessageId, profile.userId, inboundOptions);

  /* ── Step 3c. D11's soft deadline, before anything that spends (10.10) ────── */
  /**
   * **Why here and not before the profile lookup.** The reply has to be in the farmer's own
   * language (Requirement 15.3), and the preference lives on the Profile — so the branch that says
   * "not now" needs the one indexed read above it to say it in Marathi. That read also attaches the
   * `user_id`, which is what makes the `failed` row attributable rather than an orphan an operator
   * cannot trace. Two cheap reads is the price of an honest audit line and a comprehensible
   * sentence; both fit inside the 15 s terminal reserve the budget deliberately leaves.
   *
   * **What happens to the rest of a batch.** Nothing here stops the loop, and it must not: every
   * remaining message re-asks this question, fails it, and reaches `failed` with its own reply. A
   * batch that expires on entry 3 therefore ends with entries 3..N marked `failed` and each of
   * those farmers told to send again — not with entries 4..N left at `received`, which is the
   * silent drop `docs/PROVIDER_CAPABILITIES.md` section 4 carries forward to this task: Meta will
   * not redeliver an acknowledged delivery, and the idempotency guard would drop it if it did.
   *
   * The cost of that choice, stated rather than hidden: N expired messages produce N replies. The
   * alternative — one "taking longer" reply for the whole invocation — was rejected because it
   * answers a farmer's second question with silence, and silence is the failure mode D11 rejected
   * `waitUntil` over. V13's 1000-update ceiling makes the noisy case theoretical; a 6-farmer pilot
   * batches one message.
   */
  const budget = resolveInvocationBudget(deps.deadline ?? {});
  if (!canStartWithin(message.content, budget)) {
    const replySent = await deliver(send, message, messages(profile.language).whatsapp.takingLonger);
    await markFailed(providerMessageId, inboundOptions);
    await auditSoftDeadline(message, profile, deps, supabase, clock() - startedMs);
    warn('budget.expired', {
      providerMessageId,
      type: message.rawType,
      kind: message.content.kind,
      remainingMs: remainingBudgetMs(budget),
      capability: capabilityFloorFor(message.content),
      replySent,
    });
    return { providerMessageId, disposition: 'failed', replySent, detail: SOFT_DEADLINE_DETAIL };
  }

  /* ── Steps 4–7. Classify, dispatch, reply ─────────────────────────────────── */
  const outcome = await dispatch(message, profile, supabase, deps, budget);

  const replySent = await deliver(send, message, outcome.body);

  /* ── Step 8. The terminal status, AFTER the reply (10.11) ─────────────────── */
  if (outcome.kind === 'refusal') {
    await markRejected(providerMessageId, inboundOptions);
    note('delivery.rejected', { providerMessageId, reason: outcome.detail, replySent });
    return {
      providerMessageId,
      disposition: outcome.detail === 'type_outside_supported_set'
        ? 'rejected_unsupported_type'
        : 'rejected_media',
      replySent,
      detail: outcome.detail,
    };
  }

  if (outcome.kind === 'failure') {
    await markFailed(providerMessageId, inboundOptions);
    warn('delivery.failed', { providerMessageId, reason: outcome.detail, replySent });
    return { providerMessageId, disposition: 'failed', replySent, detail: outcome.detail };
  }

  if (!replySent) {
    /**
     * The work completed and the farmer received nothing. `failed` rather than `processed` is the
     * honest record: V15 notes that a send can fail even inside an apparently open 24-hour window,
     * and marking this `processed` would assert a reply that never arrived. The quota unit is
     * already spent and is not refunded — the provider call really happened — and the farmer's next
     * message carries a new `provider_message_id`, so it is processed normally.
     */
    await markFailed(providerMessageId, inboundOptions);
    warn('reply.send_failed', { providerMessageId });
    return { providerMessageId, disposition: 'failed', replySent: false, detail: 'reply_send_failed' };
  }

  await markProcessed(providerMessageId, inboundOptions);
  note('delivery.processed', { providerMessageId, type: message.rawType });
  return { providerMessageId, disposition: 'processed', replySent: true, detail: 'ok' };
}

/**
 * Send one reply and report whether Meta accepted it.
 *
 * `to` is the delivery's own `messages[].from` **verbatim** — the `wa_id` Meta itself supplied for
 * this sender. The E.164 form built by `normalizeInboundPhone` is for the `profiles.phone` lookup
 * and is deliberately not reused here: the value Meta gave is the value Meta will accept, and
 * re-deriving a recipient from a database column would let a reply go somewhere the message did not
 * come from.
 *
 * A failure is logged and returned, never thrown. The pipeline's answer to a failed send is a
 * status transition, not a 500 — the work is done and the unit is spent, so a redelivery would
 * repeat neither.
 */
async function deliver(
  send: WhatsappSender,
  message: InboundMessage,
  body: string,
): Promise<boolean> {
  const result = await send({ to: message.fromPhone, body, phoneNumberId: message.phoneNumberId });

  if (!result.ok) {
    warn('reply.rejected', {
      providerMessageId: message.providerMessageId,
      status: result.status,
      detail: result.detail,
    });
    return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Steps 4–7                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Classify the message, find the conversation, and call the one service that answers it.
 *
 * The two "not text, image or audio" cases are answered differently on purpose, and
 * `whatsapp.ts`'s `InboundContent` is what makes the distinction available:
 *
 *  - `type_outside_supported_set` is **Requirement 10.9** — a sticker, a location, a contact card.
 *    It gets the sentence that names photos, text and voice notes.
 *  - `confirmed_field_absent` is a `text` message with no `text.body`. That contradicts a path V12
 *    **confirms**, so it is a payload defect, not an unsupported kind. Answering it with 10.9's
 *    sentence would tell a farmer who sent text that Jamee does not accept text.
 *  - `unconfirmed_media_shape` is U-V12: Meta sent an image or audio message whose sub-object did
 *    not match Jamee's *provisional* field names. Also not 10.9 — a photo is a photo. It fails
 *    loudly (`failed`, with the observed keys logged), because the fix is a one-line schema edit
 *    once a real delivery is captured, not a message to the farmer about what Jamee accepts.
 */
async function dispatch(
  message: InboundMessage,
  profile: WhatsappProfile,
  supabase: () => SupabaseClient<Database>,
  deps: WhatsappDispatchDeps,
  budget: InvocationBudget,
): Promise<DispatchOutcome> {
  const { content } = message;
  const { language } = profile;

  /* ── Step 4. A type Jamee does not act on (10.9), and its two lookalikes ─── */
  if (content.kind === 'unsupported') {
    if (content.reason === 'type_outside_supported_set') {
      return {
        kind: 'refusal',
        body: messages(language).whatsapp.unsupportedType,
        detail: 'type_outside_supported_set',
      };
    }
    warn('payload.confirmed_field_absent', {
      providerMessageId: message.providerMessageId,
      type: content.type,
    });
    return {
      kind: 'failure',
      body: failureReply(new AppError('INTERNAL_ERROR'), language),
      detail: 'confirmed_field_absent',
    };
  }

  if (content.kind === 'unconfirmed_media_shape') {
    warn('media_shape.unconfirmed', {
      providerMessageId: message.providerMessageId,
      type: content.type,
      observedKeys: content.observedKeys,
      issue: content.issue,
    });
    return {
      kind: 'failure',
      body: failureReply(new AppError('INTERNAL_ERROR'), language),
      detail: 'unconfirmed_media_shape',
    };
  }

  /**
   * The invocation's deadline in the gateway's own vocabulary, so it can be handed to a service
   * unchanged. `now` travels with it because a deadline without the clock it is compared against is
   * only half a budget — an injected clock in a test would otherwise be ignored the moment the value
   * crossed a service boundary.
   */
  const runOptions: RunOptions = { deadlineMs: budget.deadlineMs, now: budget.now };

  /**
   * The ChatService, bound to the service-role client **and to this invocation's budget** — one
   * binding for both paths that need it. A typed question calls it directly and owns the `chat`
   * reserve; a voice note hands the *same* binding to `transcribeAndAnswer`, which passes
   * `coveredBy(reservation)` so the nested answer reserves nothing. That is why it is resolved once
   * here rather than twice at the call sites — and it is also why the deadline goes in here: one
   * closure means transcription and the answer that follows it share the remaining time instead of
   * each starting a 45 s clock.
   */
  const chat: WhatsappChatService =
    deps.chat ?? chatAnswerer({ supabase: supabase(), runOptions, now: budget.now });

  /* ── Step 5. The farmer's single long-running WhatsApp thread (10.5, 10.8) ── */
  const conversations = deps.conversations ?? conversationStoreFrom(supabase());
  const conversation = await findOrCreateActive(profile.userId, 'whatsapp', conversations);

  /* ── Steps 6–7. One service call, then the reply ──────────────────────────── */
  try {
    if (content.kind === 'text') {
      return await answerText(message, profile, conversation.id, chat);
    }
    return await answerMedia(message, profile, conversation.id, supabase, chat, deps, budget);
  } catch (error) {
    /**
     * Requirement 15.3 on a channel with no HTTP envelope: the coded failure the service raised
     * becomes the farmer's sentence, in their language, through the same leak boundary an API
     * response uses. `QUOTA_EXCEEDED` is the case worth naming — a farmer at their daily limit
     * reads the limit and the reset time (Requirement 14.3) rather than silence.
     */
    const code = isAppError(error) ? error.code : 'INTERNAL_ERROR';
    warn('service.failed', {
      providerMessageId: message.providerMessageId,
      kind: content.kind,
      code,
      remainingMs: remainingBudgetMs(budget),
      context: isAppError(error) ? error.context : undefined,
    });

    /**
     * **The same deadline, discovered one level down.** Because `runOptions` carried this
     * invocation's instant into the service, the gateway's own budget check is the *likely* place an
     * expiry surfaces — it raises `DIAGNOSIS_TIMEOUT` mid-flight rather than the pre-flight gate in
     * `processInboundMessage` catching it first. Both are D11's branch, so both get D11's sentence
     * and both report `soft_deadline_expired`: a farmer should not read a different explanation
     * depending on whether the clock ran out before or during the work.
     *
     * The taxonomy's own `DIAGNOSIS_TIMEOUT` copy is not reused here for one reason — it names the
     * diagnosis operation ("Looking at your crop photo…"), which is right for `/api/diagnose` and
     * wrong for a typed question. `whatsapp.takingLonger` is the channel's wording for all three
     * types, and it is the sentence D11 specifies.
     */
    if (code === 'DIAGNOSIS_TIMEOUT') {
      return {
        kind: 'failure',
        body: messages(language).whatsapp.takingLonger,
        detail: `${SOFT_DEADLINE_DETAIL}:in_service`,
      };
    }

    return { kind: 'failure', body: failureReply(error, language), detail: `service_failed:${code}` };
  }
}

/**
 * Requirement 10.5 — a typed question goes to the **ChatService**, with the conversation identifier
 * of that farmer's active WhatsApp conversation.
 *
 * `ownsRequest(userId, 'chat')` is the reserve decision, stated as a branded `QuotaContext` rather
 * than a boolean: a typed WhatsApp question is the entry point for its own request, so the `chat`
 * unit is taken by the service that owns it. Requirement 10.8 needs no code here — the answer
 * resolves against the most recent diagnosis in this conversation because the ChatService assembles
 * its context from the conversation id, and this channel deliberately keeps one thread.
 */
async function answerText(
  message: InboundMessage,
  profile: WhatsappProfile,
  conversationId: string,
  chat: WhatsappChatService,
): Promise<DispatchOutcome> {
  if (message.content.kind !== 'text') {
    // Unreachable: `dispatch` narrows it. Kept as a throw rather than a cast so a future reordering
    // fails loudly instead of sending a farmer an empty reply.
    throw new AppError('INTERNAL_ERROR', {
      context: { reason: 'answer_text_called_without_text_content' },
    });
  }

  const answered = await chat(
    {
      userId: profile.userId,
      conversationId,
      message: message.content.body,
      language: profile.language,
      channel: 'whatsapp',
      inputKind: 'text',
    },
    ownsRequest(profile.userId, 'chat'),
  );

  return { kind: 'reply', body: formatChatReply(answered.answer.content) };
}

/**
 * Requirements 10.4 and 10.6 — an image goes to the **DiagnosisService** and audio to the
 * **VoiceService**, each with the `Storage_Reference` the upload produced and `channel: 'whatsapp'`.
 *
 * `storeInboundMedia` runs first and is the reason a refused photo spends nothing: it reads Meta's
 * `file_size` and `mime_type` from step 1 of the media flow — **before a single media byte is
 * fetched** — and it holds no quota dependency at all, so there is nothing above the reserve that
 * could spend a unit. Its refusal already carries a localized sentence built from the web path's own
 * `FILE_TOO_LARGE` / `FILE_TYPE_UNSUPPORTED` copy, so the two channels cannot state different
 * limits; it is sent verbatim.
 */
async function answerMedia(
  message: InboundMessage,
  profile: WhatsappProfile,
  conversationId: string,
  supabase: () => SupabaseClient<Database>,
  chat: WhatsappChatService,
  deps: WhatsappDispatchDeps,
  budget: InvocationBudget,
): Promise<DispatchOutcome> {
  const { content } = message;
  if (!isInboundMediaContent(content)) {
    throw new AppError('INTERNAL_ERROR', {
      context: { reason: 'answer_media_called_without_media_content', kind: content.kind },
    });
  }

  const storeMedia = deps.media ?? storeInboundMedia;
  const stored = await storeMedia({
    content,
    userId: profile.userId,
    language: profile.language,
    phoneNumberId: message.phoneNumberId,
  });

  if (!stored.ok) {
    note('media.refused', {
      providerMessageId: message.providerMessageId,
      reason: stored.refusal.reason,
      kind: stored.refusal.kind,
      capBytes: stored.refusal.capBytes,
      capOwner: stored.refusal.capOwner,
    });
    return { kind: 'refusal', body: stored.refusal.reply, detail: `media:${stored.refusal.reason}` };
  }

  /**
   * `deadlineMs` and `now` rather than `platformDeadline`: both services would otherwise call
   * `getDeadline()` themselves and compute a budget from *their* start instant, which on this channel
   * is after the claim, the profile read, the media download and the upload. Handing them the
   * already-resolved instant is what makes the media fetch above count against the same 45 s as the
   * provider call below — and on a batched delivery it is what stops message two from believing the
   * invocation just started.
   */
  if (stored.kind === 'image') {
    const outcome = await (deps.diagnose ?? diagnose)(
      {
        userId: profile.userId,
        storageRef: stored.ref,
        language: profile.language,
        channel: 'whatsapp',
        conversationId,
      },
      { supabase: supabase(), deadlineMs: budget.deadlineMs, now: budget.now },
    );
    return { kind: 'reply', body: formatDiagnosisReply(outcome.result, profile.language) };
  }

  const outcome = await (deps.voice ?? transcribeAndAnswer)(
    {
      userId: profile.userId,
      storageRef: stored.ref,
      language: profile.language,
      channel: 'whatsapp',
      conversationId,
      durationSeconds: WHATSAPP_AUDIO_UNMEASURED_DURATION_SECONDS,
      mimeType: stored.mimeType,
    },
    { supabase: supabase(), chat, deadlineMs: budget.deadlineMs, now: budget.now },
  );

  return {
    kind: 'reply',
    body: formatVoiceReply(outcome.transcript, outcome.answer.content, profile.language),
  };
}

/* ========================================================================== */
/* The batch                                                                   */
/* ========================================================================== */

/**
 * Process a delivery's messages **in order**, one at a time.
 *
 * Sequential rather than concurrent, and that is a correctness choice rather than a throughput one.
 * Two messages from the same farmer in one batch both reach `findOrCreateActive`, and running them
 * in parallel is precisely the interleaving that module documents as the residual window where a
 * farmer's thread can split. Running them in order means every message after the first finds the
 * thread the previous one settled.
 *
 * One message's failure does not stop the batch: each has its own claim, its own reply and its own
 * terminal status, so a batch of ten with one bad payload leaves nine answered and one `failed`
 * rather than nine unprocessed.
 *
 * ### The deadline is per INVOCATION, and this is the function that makes that true
 *
 * D11's budget is resolved **once, here**, and the same instant is handed to every message. Letting
 * each message resolve its own would give a batch of three 45 s each inside one 60 s invocation —
 * the arithmetic Requirement 10.10 forbids, and the gap `docs/PROVIDER_CAPABILITIES.md` section 4
 * records in D11's own reasoning ("the observed work … *for a single message*", against V13's
 * documented ceiling of 1000 updates per delivery).
 *
 * The loop is not short-circuited when the budget runs out, deliberately. Every remaining message
 * still enters `processInboundMessage`, still claims, and still reaches `failed` with the "taking
 * longer" reply — so entries 3..N of an expired batch are a *stated* outcome with a farmer-visible
 * explanation, not rows left at `received` that Meta will never redeliver because the delivery was
 * already acknowledged. Breaking out of the loop here would recreate exactly the silent drop the
 * `status` column in migration `0008` exists to prevent.
 */
export async function processInboundBatch(
  inbound: readonly InboundMessage[],
  deps: WhatsappDispatchDeps,
): Promise<readonly InboundResult[]> {
  const budget = resolveInvocationBudget(deps.deadline ?? {});
  const perMessage: WhatsappDispatchDeps = {
    ...deps,
    deadline: { deadlineMs: budget.deadlineMs, now: budget.now },
  };

  const results: InboundResult[] = [];

  for (const message of inbound) {
    results.push(await processInboundMessage(message, perMessage));
  }

  return results;
}
