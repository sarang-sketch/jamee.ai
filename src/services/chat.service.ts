import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { gatewayRunner, type CapabilityRunner } from '@/lib/ai/capabilities';
import type { GatewayResult, RunOptions } from '@/lib/ai/gateway';
import {
  DEGRADATION_OUTCOME as SHARED_DEGRADATION_OUTCOME,
  rejectionReasonForDegradation,
  writeUsageLog,
  type UsageFacts,
} from '@/lib/db/usage-log';
import { AppError, isAppError } from '@/lib/errors';
import {
  knowledgeReaderFrom,
  resolveScope,
  rlsScopedReader,
  type KnowledgeEntry,
  type KnowledgeReader,
  type KnowledgeScope,
  type ReferralReason,
} from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import { PROMPT_VERSION, chatPrompt, staticExplanationFor, validateRephrased } from '@/lib/prompts';
import { checkBurstForRequest, noBurstCheck, type BurstCheck } from '@/lib/rate-limit';
import type {
  ChatAnswer,
  ChatInput,
  Language,
  ModelProvider,
  Operation,
  QuotaStatus,
  UsageOutcome,
  VerifiedCondition,
} from '@/lib/schemas';
import {
  ownsRequest,
  quotaExceededError,
  quotaStatusOf,
  refundReservation,
  reserveForRequest,
  type QuotaContext,
  type QuotaOptions,
  type QuotaReservation,
} from '@/services/quota.service';
import type { ChatAnswerer } from '@/services/voice.service';
import type { Database, DiagnosisRow, MessageRow, TablesInsert } from '@/types/database';

/**
 * Conversation_Context assembly — the read half of `ChatService`.
 *
 * Requirements: 7.1 (context is built from the recent Messages **and** the most recent
 *               Diagnosis_Result of that Conversation), 7.2 (context is keyed on the Conversation
 *               identifier), 7.7 (one implementation serves the Web_App and the WhatsApp channel)
 * Design: "Chat over conversation context"; "0003: conversations and messages"; "0005: diagnoses"
 * Depends on: `messages_conversation_idx` (0003), `diagnoses_conversation_idx` (0005)
 *
 * ### KEYED ON THE CONVERSATION. NOT ON THE FARMER, NOT ON THE CHANNEL.
 *
 * Requirement 7.2 is a statement about the key, and `ConversationScope` below is that statement in
 * the type system: the only identifier a caller can ask a window for is a conversation id. The
 * farmer id travels alongside it as an **authorization predicate**, never as a grouping key — a
 * read keyed on the farmer would pull that farmer's WhatsApp thread into their web thread's window
 * (Requirement 10.5 keeps those separate rows, `conversation.service.ts`), and a read keyed on the
 * channel would do the same thing one level up. Both are the failure Property 15 names: a message
 * from another conversation entering the window.
 *
 * ### WHY THE DIAGNOSIS IS PART OF THE CONTEXT AND NOT AN AFTERTHOUGHT
 *
 * Requirement 7.3's "why?" carries no subject. The messages cannot supply one reliably — the
 * previous turn may itself have been subject-less — so the subject comes from
 * `latestDiagnosis.disease_name`, surfaced here as `condition`. That single field is what makes a
 * subject-less follow-up resolvable in task 15.2: it is what `resolveScope({ condition })` in
 * `knowledge.ts` matches on when the question contributes no vocabulary of its own, which is also
 * every Hindi and Marathi question (that module's `tokenize` matches Latin letters only, and says
 * so). Ship the window without the diagnosis and "why?" becomes an out-of-scope referral.
 *
 * ### WHY THE CLIENT IS A PARAMETER
 *
 * Same reasoning as `conversation.service.ts`, `knowledge.ts` and `storage.ts`, and Requirement 7.7
 * is the reason it matters here: one implementation serves both channels because the credential is
 * injected rather than constructed.
 *
 *  - The **web** path has a farmer session and passes the RLS-scoped server client, so RLS is a
 *    second boundary behind the predicates. That is the default (`rlsScopedContextStore`).
 *  - The **WhatsApp webhook** has no session at all and passes
 *    `contextStoreFrom(createAdminClient())`. There is nothing behind the service-role client, so
 *    `admin.ts`'s rule applies with full force: every query below carries an explicit `user_id`
 *    predicate, and `assertInScope()` re-checks every row that comes back.
 *
 * ### THE ORDERING AND THE WINDOW ARE THE INDEX'S JOB
 *
 * `messages_conversation_idx` on `(conversation_id, created_at desc)` and
 * `diagnoses_conversation_idx` on `(conversation_id, created_at desc)` exist in 0003 and 0005
 * precisely to serve these two reads, so both are `eq → eq → order → limit` in SQL and **nothing
 * here fetches a conversation and sorts it in application code**. 0003's own comment calls the
 * context read "the hottest path in the product", which is why the two reads also go out
 * concurrently: they are independent, and paying two serial round trips for them would be a
 * self-inflicted latency floor on every chat turn.
 *
 * The one array operation that remains is a `reverse()` of at most `CONTEXT_MESSAGE_LIMIT` rows.
 * That is not a sort: "the last N messages" is only expressible in SQL as newest-first with a
 * limit, while a transcript reads oldest-first, so exactly one of the two has to flip. Flipping a
 * bounded list once is cheaper than the sub-select that would let the database do it.
 */

/* ========================================================================== */
/* The bound on the window                                                     */
/* ========================================================================== */

/**
 * **N — the row cap on the read.** Twelve messages, i.e. six farmer/Jamee turns.
 *
 * This is the cap that keeps the query cost constant in the length of a conversation: a WhatsApp
 * thread is deliberately long-lived (`conversation.service.ts`), so an uncapped read would grow
 * without limit for the farmers who use Jamee most. Six turns covers a complete exchange about one
 * photo, which is what the window is for — Requirement 7.3's subject travels in `condition`, not in
 * the transcript, so length is not what makes a follow-up resolvable.
 */
export const CONTEXT_MESSAGE_LIMIT = 12;

/**
 * **The token budget the window is bounded by**, applied newest-first over the rows N returned.
 *
 * =============================================================================
 * HOW 2000 IS COMPUTED, AND WHY IT IS THAT NUMBER
 * =============================================================================
 *
 * From Jamee's own per-message ceilings, at the four-characters-per-token approximation below:
 *
 *  - a farmer message is at most **1000 characters** (`chatRequestSchema.message` in `schemas.ts`),
 *    so ~250 tokens;
 *  - a Jamee answer is at most **1200 characters** (`REPHRASE_MAX_CHARS` in `prompts.ts`), so
 *    ~300 tokens;
 *  - therefore one **worst-case turn ≈ 550 tokens**, and a typical turn — a short question plus the
 *    four to six short sentences the rephrase prompt asks for — is nearer 120.
 *
 * 2000 tokens holds **three worst-case turns and all twelve typical ones**. So the budget binds
 * only on an unusually verbose thread, which is exactly when a bound should bind and never on the
 * ordinary path. Both numbers are Jamee's, derived from Jamee's own contracts.
 *
 * One asymmetry worth naming rather than assuming away: the 1000-character figure is the **web**
 * contract, and the WhatsApp adapter invokes `ChatService` directly rather than through
 * `chatRequestSchema`, so an inbound text can be longer than any web question. That is what the
 * newest-first trim and the floor of one message in `applyTokenBudget()` are for — a verbose
 * inbound turn shortens the window instead of overrunning the budget.
 *
 * **Why bound at all, and why not larger?** Not because of the context window: the smaller of the
 * two `text-generate` chain members carries 131,072 tokens (V8), some 65x this budget, so the
 * window is a sanity check rather than the binding constraint. The three real reasons:
 *
 *  1. **Latency.** `text-generate` gets a 15 s per-attempt ceiling
 *     (`docs/PROVIDER_CAPABILITIES.md` section 3, a fraction of Jamee's own 60 s), and input
 *     tokens cost time inside it.
 *  2. **Grounding.** Requirements 4.4 and 4.5 require the answer to come from the resolved
 *     knowledge-base rows. A long transcript competing with five rows for the model's attention
 *     works against that, and no prompt rule compensates for a diluted input.
 *  3. **Provider allowances are UNRESOLVED** (U-V19a, U-V19b), and
 *     `docs/PROVIDER_CAPABILITIES.md` is explicit that neither set of numbers may be encoded as a
 *     Jamee limit. So this budget is deliberately **not** computed against a provider's
 *     tokens-per-day figure; the honest posture with an unknown allowance is to spend few tokens.
 *
 * Raising it trades latency and grounding for history. It cannot break correctness, which is why
 * it is a constant here and not a V-item.
 */
export const CONTEXT_TOKEN_BUDGET = 2000;

/**
 * The estimator: four characters per token.
 *
 * A documented rule of thumb, and **no tokenizer dependency is added for it** — this number bounds
 * growth, it does not measure a bill. The direction of its error is stated rather than hidden:
 * byte-pair encoders split Devanagari into more pieces per character than Latin, so a Hindi or
 * Marathi window costs **more** real tokens than this estimate says. With the budget sitting ~65x
 * below the smaller provider's context window, an underestimate by even a factor of four is
 * absorbed; if that headroom ever narrows, replace the estimator rather than the budget.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * `Math.ceil`, so an empty-ish message still costs one token. A floor of zero would make a long
 * tail of one-character messages free, and "free" is the one thing a bound cannot allow.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/* ========================================================================== */
/* The shape handed to task 15.2                                               */
/* ========================================================================== */

/**
 * The key (Requirement 7.2) plus the authorization predicate every read carries.
 *
 * `userId` is not a grouping key and must never become one — see the module header. It is here so
 * that a service-role read, which has no RLS behind it, still cannot return another farmer's rows.
 */
export interface ConversationScope {
  readonly conversationId: string;
  readonly userId: string;
}

/**
 * A message in the window, exactly as `messages` stores it.
 *
 * The row rather than a projection, following `Conversation` in `conversation.service.ts` and
 * `KnowledgeEntry` in `knowledge.ts`: task 15.2's prompt needs `role`, `content` and `language`,
 * and a hand-written projection of three of nine columns is a second shape to keep in step with
 * 0003 for no gain.
 */
export type ContextMessage = MessageRow;

/** Which bound stopped the window, and what it cost. */
export type ContextBoundedBy =
  /** Every message of the conversation is in the window; neither bound was reached. */
  | 'complete'
  /** The read returned a full page of `CONTEXT_MESSAGE_LIMIT` rows, so older messages may exist. */
  | 'message_limit'
  /** The token budget dropped at least one row the read had returned. The tighter of the two. */
  | 'token_budget';

export interface ContextBound {
  /** Rows the read returned, before the token budget was applied. */
  readonly rowsRead: number;
  /** Estimated tokens of the messages actually kept — see `estimateTokens`. */
  readonly estimatedTokens: number;
  readonly boundedBy: ContextBoundedBy;
}

/**
 * Conversation_Context: the recent messages of one conversation and that conversation's most
 * recent Diagnosis_Result (Requirement 7.1), keyed on the conversation identifier (7.2).
 */
export interface ConversationContext {
  readonly conversationId: string;
  readonly userId: string;
  /** **Chronological, oldest → newest**, and bounded — see `bound`. */
  readonly messages: readonly ContextMessage[];
  /**
   * The most recent diagnosis of THIS conversation, or `null` when it has none yet.
   *
   * "Most recent" full stop, with no reaching back past an inconclusive one: Requirements 7.1 and
   * 7.3 both say the most recent Diagnosis_Result, and skipping over it to find an older
   * identified row would answer a follow-up about a different photo than the one the farmer just
   * sent.
   */
  readonly latestDiagnosis: DiagnosisRow | null;
  /**
   * The subject a subject-less follow-up resolves against (Requirement 7.3), ready to hand to
   * `resolveScope()`.
   *
   * `null` in two distinguishable-but-equivalent situations, and the equivalence is deliberate:
   * the conversation has no diagnosis at all, or its most recent diagnosis was inconclusive and
   * therefore carries no name (`diagnoses_unknown_shape`, Requirement 6.5). An inconclusive
   * diagnosis is a diagnosis with no subject, so both reach 15.2's referral path by the same
   * route and neither invents one.
   */
  readonly condition: VerifiedCondition | null;
  readonly bound: ContextBound;
}

/* ========================================================================== */
/* The read seam                                                               */
/* ========================================================================== */

/**
 * The two reads this module makes.
 *
 * Two **functions** rather than a mirrored PostgREST builder, following `ConversationStore` and
 * `KnowledgeReader`: the real queries are five- and six-link chains, and mirroring them
 * structurally would force a unit test to reproduce a builder chain in order to assert something
 * about a window. The queries live once, in `contextStoreFrom()`, typed against the real client so
 * the compiler still checks the column names.
 */
export interface ContextStore {
  /**
   * Up to `limit` messages of this conversation, **newest first** — index order, not reversed.
   *
   * Newest-first is load-bearing rather than incidental: it is the only order in which "the last
   * N" is a `limit`, and it is the order the token budget has to trim in.
   */
  recentMessages(scope: ConversationScope, limit: number): Promise<readonly ContextMessage[]>;
  /** The most recent diagnosis of this conversation, or `null`. */
  latestDiagnosis(scope: ConversationScope): Promise<DiagnosisRow | null>;
}

function readFailure(
  table: 'messages' | 'diagnoses',
  cause: unknown,
  scope: ConversationScope,
): AppError {
  return new AppError('INTERNAL_ERROR', {
    cause,
    context: {
      reason: 'context_read_failed',
      table,
      conversationId: scope.conversationId,
      userId: scope.userId,
    },
  });
}

/**
 * Adapt a Supabase client — RLS-scoped or service-role — into a store.
 *
 * A PostgREST `error` is **not** an empty result and is never treated as one. Empty means the
 * conversation has no messages or no diagnosis yet, which is a legitimate first turn; an error
 * means Jamee could not find out, and answering a follow-up against a silently empty context would
 * turn a read failure into a confidently context-free answer — Requirement 7.3's subject would
 * vanish and the farmer would get a referral for a question Jamee could have answered. So an error
 * throws, the cause is logged server-side, and the farmer sees `INTERNAL_ERROR`.
 */
export function contextStoreFrom(client: SupabaseClient<Database>): ContextStore {
  return {
    async recentMessages(scope, limit) {
      const { data, error } = await client
        .from('messages')
        .select('*')
        // Both predicates are load-bearing. `conversation_id` is the key of Requirement 7.2 and
        // the leading column of `messages_conversation_idx`. `user_id` is the tenant boundary —
        // the ONLY boundary on the service-role client (admin.ts) — and it is a column on
        // `messages` precisely so this read needs no join (0003's denormalization note).
        .eq('conversation_id', scope.conversationId)
        .eq('user_id', scope.userId)
        // The equality on `conversation_id` plus this key is what `messages_conversation_idx`
        // serves; the two keys after it only order rows that tie on the instant.
        .order('created_at', { ascending: false })
        // A tie is real, not theoretical: `created_at` defaults to `now()`, which is
        // transaction-scoped in Postgres, so the farmer message and the Jamee answer that task
        // 15.3 persists for one turn can land on the identical timestamp. `role` descending puts
        // `jamee` before `farmer` in this newest-first read, which reverses to question-then-answer
        // in the transcript — the order the turn actually happened in.
        .order('role', { ascending: false })
        // Final tiebreak, so the order is total and the token trim below is repeatable across two
        // runs of the same conversation.
        .order('id', { ascending: false })
        .limit(limit);

      if (error !== null) throw readFailure('messages', error, scope);
      return data ?? [];
    },

    async latestDiagnosis(scope) {
      const { data, error } = await client
        .from('diagnoses')
        .select('*')
        .eq('conversation_id', scope.conversationId)
        .eq('user_id', scope.userId)
        // Served by `diagnoses_conversation_idx`, which 0005 created for exactly this read.
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error !== null) throw readFailure('diagnoses', error, scope);
      return data;
    },
  };
}

/**
 * The default store: the farmer's own session, through RLS.
 *
 * `createServerSupabase()` is imported **lazily** because it reads the App Router cookie store,
 * which exists only inside a request. A static import would make this module unloadable outside a
 * request scope — including in a unit test — for a dependency the WhatsApp adapter never uses.
 */
async function serverStore(): Promise<ContextStore> {
  const { createServerSupabase } = await import('@/lib/supabase/server');
  return contextStoreFrom(await createServerSupabase());
}

export const rlsScopedContextStore: ContextStore = {
  recentMessages: async (scope, limit) => (await serverStore()).recentMessages(scope, limit),
  latestDiagnosis: async (scope) => (await serverStore()).latestDiagnosis(scope),
};

/* ========================================================================== */
/* Assembly                                                                    */
/* ========================================================================== */

export interface ContextOptions {
  /** The read seam. Defaults to the farmer's session through RLS. */
  readonly store?: ContextStore | undefined;
  /** Override N. Defaults to `CONTEXT_MESSAGE_LIMIT`; present so a test can pin the boundary. */
  readonly messageLimit?: number | undefined;
  /** Override the token budget. Defaults to `CONTEXT_TOKEN_BUDGET`. */
  readonly tokenBudget?: number | undefined;
}

/**
 * Build Conversation_Context for one conversation.
 *
 * Requirement 7.1's two halves in one call, and the only entry point task 15.2 needs. Both reads
 * are scoped by conversation **and** farmer, both are index-served, and every row that comes back
 * is re-checked against the scope before it can reach a prompt.
 *
 * ### What this function deliberately does NOT decide
 *
 * Whether `conversationId` is a conversation this farmer owns. `conversation.service.ts` states the
 * division: `CONVERSATION_NOT_FOUND` exists for a caller that was *given* an identifier, and
 * resolving that identifier is the requesting route's job (task 15.3). The consequence is worth
 * saying out loud: a conversation id belonging to someone else produces an **empty** context here,
 * not an error, because both predicates simply match nothing. That leaks nothing — an empty window
 * and a bogus id are indistinguishable in the direction that matters — and it is why 15.3 resolves
 * the id before calling this rather than reading the emptiness as an answer.
 */
export async function assembleContext(
  scope: ConversationScope,
  options: ContextOptions = {},
): Promise<ConversationContext> {
  const store = options.store ?? rlsScopedContextStore;
  const messageLimit = options.messageLimit ?? CONTEXT_MESSAGE_LIMIT;
  const tokenBudget = options.tokenBudget ?? CONTEXT_TOKEN_BUDGET;

  // Independent reads on the hottest path in the product (0003), so they go out together. Both
  // promises are subscribed by `Promise.all`, so a rejection from the slower one is handled rather
  // than surfacing as an unhandled rejection after the first has already failed.
  const [read, diagnosisRow] = await Promise.all([
    store.recentMessages(scope, messageLimit),
    store.latestDiagnosis(scope),
  ]);

  const newestFirst = assertAllInScope(read, scope, 'messages');
  const latestDiagnosis =
    diagnosisRow === null ? null : assertInScope(diagnosisRow, scope, 'diagnoses');

  const { kept, estimatedTokens, trimmed } = applyTokenBudget(newestFirst, tokenBudget);

  return {
    conversationId: scope.conversationId,
    userId: scope.userId,
    // The single flip from index order to transcript order. See the module header.
    messages: [...kept].reverse(),
    latestDiagnosis,
    condition: latestDiagnosis?.disease_name ?? null,
    bound: {
      rowsRead: newestFirst.length,
      estimatedTokens,
      boundedBy: trimmed
        ? 'token_budget'
        : messageLimit > 0 && newestFirst.length >= messageLimit
          ? 'message_limit'
          : 'complete',
    },
  };
}

/**
 * Trim a newest-first list to the token budget, dropping the OLDEST messages.
 *
 * Two decisions in eight lines, both about what a farmer's next answer reads like:
 *
 *  1. **It stops at the first message that would exceed the budget and keeps nothing older.** The
 *     alternative — skip the oversized message and keep smaller older ones — would punch a hole in
 *     the middle of a transcript, and a conversation with a gap reads to a model as a
 *     non-sequitur. A shorter window is honest; a discontinuous one is not.
 *  2. **The newest message is kept unconditionally**, even if it alone exceeds the budget. Nothing
 *     writing to `messages` today can produce one that does — 1000 characters for a question,
 *     1200 for an answer, against a budget of 2000 tokens — but a future writer with a different
 *     ceiling would otherwise hit a cliff where the window silently empties. A floor of one
 *     message is bounded by the largest single message every writer already caps.
 */
function applyTokenBudget(
  newestFirst: readonly ContextMessage[],
  tokenBudget: number,
): { kept: readonly ContextMessage[]; estimatedTokens: number; trimmed: boolean } {
  const kept: ContextMessage[] = [];
  let estimatedTokens = 0;

  for (const message of newestFirst) {
    const cost = estimateTokens(message.content);
    if (kept.length > 0 && estimatedTokens + cost > tokenBudget) break;
    kept.push(message);
    estimatedTokens += cost;
  }

  return { kept, estimatedTokens, trimmed: kept.length < newestFirst.length };
}

/**
 * Post-condition: every row handed onward belongs to this conversation and this farmer.
 *
 * Not redundant with the `.eq()` predicates, for the same two reasons `assertBelongsTo` gives in
 * `conversation.service.ts`. On the WhatsApp path the application check *is* the boundary and there
 * is nothing behind it (`admin.ts`), so a predicate dropped in a refactor would otherwise surface
 * as another farmer's message inside a prompt rather than as a loud failure. And `ContextStore` is
 * an injectable seam — a store that filters incorrectly cannot leak past this point.
 *
 * `INTERNAL_ERROR` because this is a defect in Jamee, not something a farmer did: the mismatch goes
 * to the server log through `AppError.context`, which structurally cannot reach the response body
 * (`toEnvelope` in `errors.ts`), and the farmer sees the generic 500 of Requirement 15.6.
 */
interface ScopedRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly user_id: string;
}

function assertInScope<T extends ScopedRow>(
  row: T,
  scope: ConversationScope,
  table: 'messages' | 'diagnoses',
): T {
  if (row.conversation_id !== scope.conversationId || row.user_id !== scope.userId) {
    throw new AppError('INTERNAL_ERROR', {
      context: {
        reason: 'context_scope_mismatch',
        table,
        rowId: row.id,
        requestedConversation: scope.conversationId,
        requestedBy: scope.userId,
        // Neither the row's own `user_id` nor its `conversation_id` is logged: copying another
        // farmer's identifiers into this line would spread the leak the check just stopped.
      },
    });
  }
  return row;
}

function assertAllInScope<T extends ScopedRow>(
  rows: readonly T[],
  scope: ConversationScope,
  table: 'messages' | 'diagnoses',
): readonly T[] {
  for (const row of rows) assertInScope(row, scope, table);
  return rows;
}

/* ========================================================================== */
/* The answer half: scope first, then one grounded model call                   */
/* ========================================================================== */

/**
 * Turning Conversation_Context into a chat answer.
 *
 * Requirements: 4.4 (every agricultural statement in an answer is composed from Knowledge_Base
 *               entries), 4.5 (the request supplies those entries and asks for a rephrase only),
 *               4.7 (a question about a crop or condition Jamee does not cover is answered with the
 *               coverage statement and an expert referral), 7.3 (a subject-less follow-up resolves
 *               against the conversation's most recent Diagnosis_Result), 7.6 (a question with no
 *               verified content behind it is answered honestly), 7.7 (one implementation serves
 *               both channels), 9.3 (the answer is returned in the requested language), 9.6 (a
 *               question written in a Supported_Language is answered in that language), 16.4 (the
 *               codebase holds exactly ONE grounding-and-rephrase implementation)
 * Design: "Prompting and grounding" → *3. Chat over conversation context*; "Post-generation
 *         validation of rephrased text"; D9
 *
 * =============================================================================
 * SCOPE IS RESOLVED FIRST, AND THAT ORDER IS THE REQUIREMENT
 * =============================================================================
 *
 * Requirements 4.7 and 7.6 are not "the model should decline politely". They are: Jamee decides
 * whether it has verified content **before** it spends a provider call, and when it does not, the
 * farmer gets a static localized sentence and no model is asked anything. `resolveScope()` in
 * `knowledge.ts` makes that structural rather than remembered — its `referral` variant carries
 * `entries: readonly []`, so this module cannot reach a row without having handled the empty case,
 * and `chatPrompt()` cannot be called with nothing to ground in.
 *
 * The prompt's own "reply with the FALLBACK SENTENCE" rule is the **second** line of defence, for
 * the middle case scope resolution cannot see: rows are in scope, and they still do not answer the
 * question.
 *
 * =============================================================================
 * REQUIREMENT 16.4 — ONE GROUNDING AND REPHRASE FLOW, NOT TWO
 * =============================================================================
 *
 * Everything between "a model returned a string" and "a farmer reads it" is
 * `validateRephrased()` in `prompts.ts`, unchanged and unwrapped: the length and emptiness check,
 * the deterministic canonical-name repair (never a re-ask — D4), the out-of-scope deny-list scan,
 * and the fall back to `staticExplanationFor()` built from the row itself. `RephraseCheckTarget`
 * was given its `inScope` parameter for exactly this caller: a question like "what is late blight?"
 * grounds in two rows, so the second name is in scope rather than contamination.
 *
 * What this module adds is only what the diagnosis path also adds locally — the provider-failure
 * branch, which the gateway raises as a throw and `validateRephrased()` therefore never sees.
 *
 * =============================================================================
 * WHY A PROVIDER FAILURE DEGRADES HERE INSTEAD OF SURFACING
 * =============================================================================
 *
 * `diagnosis.service.ts` re-throws a timeout and degrades everything else. This path degrades on
 * **both**, and the reason is copy, not convenience: `DIAGNOSIS_TIMEOUT` is the taxonomy's only
 * timeout code, and its `en` rendering is *"Looking at your crop photo took longer than usual.
 * Please send the photo again."* Showing that to a farmer who typed a question would tell them to
 * resend a photo they never sent. The gateway anticipates this — it says a non-diagnosis caller
 * that wants different wording translates the code — and the honest translation for a chat turn is
 * the grounded knowledge-base template, which is content the farmer can act on rather than an
 * error. Adding a chat-specific timeout code would mean changing the taxonomy in `schemas.ts`,
 * which is a contract change and not this task's.
 *
 * The degradation is **reported, never hidden**: `ChatTurnOutcome.degradation` names which of the
 * three causes it was, so task 15.3's usage-log row records `provider_error` or `timeout` truthfully
 * even though the farmer received an answer.
 */

/**
 * The chat answer as this module can produce it — everything `chatAnswerSchema` needs except the
 * identifier of the row it will be persisted as.
 *
 * `Omit` rather than a hand-written shape, so the field list stays tied to the contract in
 * `schemas.ts`. `messageId` is assigned by the insert in task 15.3: this module never writes, so
 * inventing a uuid here would be inventing a row id for a row that does not exist yet.
 */
export type PendingChatAnswer = Omit<ChatAnswer, 'messageId'>;

/** Why the farmer read a static template instead of the model's prose. Audit, not farmer-facing. */
export type ChatDegradation =
  /** The request's budget was gone before or during the one model call (gateway: `starved`). */
  | 'budget_exhausted'
  /** The chain was exhausted, or failed for a reason that is not a fallback trigger. */
  | 'provider_failed'
  /** The model answered and `validateRephrased()` rejected the answer. */
  | 'checks_failed';

export interface ChatQuestion extends ConversationScope {
  /** The farmer's message, verbatim — a typed question, or a transcript on the voice path (8.4). */
  readonly message: string;
  /** The requested/preferred language. D9's other half is resolved by the model. */
  readonly language: Language;
}

export interface ChatDeps {
  /**
   * The request's Supabase client, used for BOTH reads: the context window and the knowledge base.
   *
   * Optional, matching `assembleContext`'s default in this module: absent means the farmer's own
   * session through RLS, which is the web path. **Any caller with no session must pass one** —
   * `contextStoreFrom(createAdminClient())` is what the WhatsApp webhook has, since a webhook
   * carries no cookies and the RLS default would try to read a cookie store outside a request.
   */
  readonly supabase?: SupabaseClient<Database> | undefined;
  /** Read seams, for a test or a caller that already built them. Default: derived from `supabase`. */
  readonly store?: ContextStore | undefined;
  readonly knowledge?: KnowledgeReader | undefined;
  /** The one model call. Defaults to the real gateway over the real adapter sets. */
  readonly models?: CapabilityRunner | undefined;
  /** Overrides for `assembleContext`'s two bounds; present so a test can pin the boundary. */
  readonly messageLimit?: number | undefined;
  readonly tokenBudget?: number | undefined;
  /**
   * The request's budget and abort, passed to the gateway **unchanged**.
   *
   * Not narrowed and not defaulted, because the caller that owns the request owns the deadline. It
   * matters most on the voice path (task 18.2): transcription and this answer share one budget, so
   * the voice service passes the same `deadlineMs` to both rather than letting each compute a fresh
   * 45 s of its own.
   */
  readonly runOptions?: RunOptions | undefined;
}

export interface ChatTurnOutcome {
  /** What the farmer reads. Never empty, and grounded in `answer.groundedIn` or in nothing at all. */
  readonly answer: PendingChatAnswer;
  /** The window this answer was produced from, so task 15.3 need not read it a second time. */
  readonly context: ConversationContext;
  /** Set exactly when no model was called: which honest referral was returned (4.7 vs 7.6). */
  readonly referralReason: ReferralReason | null;
  /** Which provider served the answer, or `null` when no model call was made at all. */
  readonly provider: ModelProvider | null;
  /** Requirement 14.7 — true when a fallback chain member served or was attempted. */
  readonly usedFallback: boolean;
  /** `null` when the farmer received the model's own prose. */
  readonly degradation: ChatDegradation | null;
  /** Check 3's finding. Non-empty only alongside `degradation: 'checks_failed'`. */
  readonly outOfScopeMentions: readonly VerifiedCondition[];
  /** `usage_logs.prompt_version` (Requirement 14.6). `null` when no prompt was sent. */
  readonly promptVersion: string | null;
}

/**
 * Which static sentence a referral renders.
 *
 * `Record<ReferralReason, …>` is exhaustive, so a third reason added to `knowledge.ts` breaks this
 * object until it has copy — the same structural-completeness move the message catalogs make for
 * error codes. Both strings ship pre-translated in the repository (D5) precisely because this path
 * may not call a model.
 */
const REFERRAL_COPY = {
  out_of_scope: 'outOfScope',
  no_verified_content: 'noVerifiedInfo',
} as const satisfies Record<ReferralReason, 'outOfScope' | 'noVerifiedInfo'>;

/**
 * Answer one chat turn: assemble the context, resolve scope, and — only if there is something to
 * ground in — make exactly one model call.
 *
 * One implementation for both channels (Requirements 7.7, 16.2): the credential and the runner are
 * parameters, so the web route and the WhatsApp adapter differ in what they pass, not in what runs.
 *
 * ### What this function deliberately does NOT do
 *
 * It does not authorize `conversationId` (the route resolves it — see `assembleContext`), does not
 * reserve quota, does not persist a thing, and takes no `channel`. All four are task 15.3's, and
 * the closing comment of this module lists them.
 */
export async function answerQuestion(
  question: ChatQuestion,
  deps: ChatDeps = {},
): Promise<ChatTurnOutcome> {
  const scope: ConversationScope = {
    conversationId: question.conversationId,
    userId: question.userId,
  };
  const knowledge =
    deps.knowledge ??
    (deps.supabase === undefined ? rlsScopedReader : knowledgeReaderFrom(deps.supabase));

  const context = await assembleContext(scope, {
    store: deps.store ?? (deps.supabase === undefined ? undefined : contextStoreFrom(deps.supabase)),
    messageLimit: deps.messageLimit,
    tokenBudget: deps.tokenBudget,
  });

  // Requirement 7.3 lives in this one argument list: the question supplies its own vocabulary when
  // it has any, and `context.condition` — the conversation's most recent Diagnosis_Result — supplies
  // it when the question does not. A Hindi or Marathi question always takes the second route, which
  // `knowledge.ts`'s `tokenize()` states rather than hides.
  const resolved = await resolveScope(
    { condition: context.condition, question: question.message },
    knowledge,
  );

  // Requirements 4.7 and 7.6. The return is above every line that could reach a provider, which is
  // what "makes no model call at all" means as code rather than as a rule.
  if (resolved.kind === 'referral') {
    return {
      answer: {
        content: messages(question.language).chat[REFERRAL_COPY[resolved.reason]],
        language: question.language,
        groundedIn: [],
        needsExpert: true,
      },
      context,
      referralReason: resolved.reason,
      provider: null,
      usedFallback: false,
      degradation: null,
      outOfScopeMentions: [],
      promptVersion: null,
    };
  }

  return await groundedAnswer({ question, context, resolved, deps });
}

interface GroundedInput {
  readonly question: ChatQuestion;
  readonly context: ConversationContext;
  readonly resolved: Extract<KnowledgeScope, { kind: 'grounded' }>;
  readonly deps: ChatDeps;
}

/**
 * The grounded path: one model call, then the shared post-generation checks.
 *
 * The gateway owns the budget arithmetic — `run()` refuses to start an attempt that cannot finish,
 * and reports that as a throw with `budgetExhausted` in its context — so nothing here re-derives a
 * deadline or re-implements the minimum-remaining guard. One capability call, one place it can fail.
 */
async function groundedAnswer(input: GroundedInput): Promise<ChatTurnOutcome> {
  const { question, context, resolved, deps } = input;
  const { language } = question;
  const models = deps.models ?? gatewayRunner();

  // The row the answer is *about*: the conversation's own condition when it is in scope, else the
  // first resolved row in canonical order. It decides two things and only two — which canonical name
  // check 2 requires verbatim, and which row the static template is built from. Every resolved row
  // is in the prompt and in `groundedIn` regardless.
  const entry = primaryEntry(resolved, context.condition);

  const prompt = chatPrompt({
    question: question.message,
    entries: resolved.entries,
    condition: context.condition,
    // The transcript BEFORE this turn: task 15.3 persists the farmer message after the answer
    // exists (Requirement 7.4's "when the Chat_Service produces an answer"), so the question is not
    // in this window and is not passed twice.
    recentMessages: context.messages,
    language,
  });

  let generated: GatewayResult<string>;
  try {
    generated = await models.generate({ prompt }, deps.runOptions ?? {});
  } catch (error) {
    return {
      answer: {
        content: staticExplanationFor(entry, language),
        language,
        groundedIn: [...resolved.conditions],
        // Still grounded content from a verified row, so this is not a referral: Requirement 4.4
        // holds and the farmer has something to act on.
        needsExpert: false,
      },
      context,
      referralReason: null,
      provider: null,
      usedFallback: usedFallbackOf(error),
      degradation: isBudgetExhausted(error) ? 'budget_exhausted' : 'provider_failed',
      outOfScopeMentions: [],
      // A prompt was built but never sent, so no row may claim this version produced anything.
      promptVersion: null,
    };
  }

  // Requirement 16.4 — the one grounding-and-rephrase implementation, reused rather than mirrored.
  // `inScope` is every resolved condition, so a second late-blight row named in an answer about late
  // blight is in scope; a sixth name from nowhere is not.
  const checked = validateRephrased(generated.value, {
    entry,
    language,
    inScope: resolved.conditions,
  });

  return {
    answer: {
      content: checked.text,
      language,
      groundedIn: [...resolved.conditions],
      needsExpert: false,
    },
    context,
    referralReason: null,
    provider: generated.provider,
    usedFallback: generated.usedFallback,
    degradation: checked.source === 'static_template' ? 'checks_failed' : null,
    outOfScopeMentions: checked.outOfScopeMentions,
    promptVersion: PROMPT_VERSION,
  };
}

/**
 * The row a subject-less follow-up is really about.
 *
 * `entries` is a non-empty tuple by construction (`KnowledgeScope`), so the fallback needs no
 * defensive check — index 0 is typed as present. The `find` matters when the question widened the
 * scope: "is this blight?" after a Tomato Early Blight diagnosis resolves to four rows, and the
 * farmer's own condition is the one the answer should keep naming.
 */
function primaryEntry(
  resolved: Extract<KnowledgeScope, { kind: 'grounded' }>,
  condition: VerifiedCondition | null,
): KnowledgeEntry {
  if (condition === null) return resolved.entries[0];
  return resolved.entries.find((row) => row.disease_name === condition) ?? resolved.entries[0];
}

/**
 * Whether the gateway declined to start, or aborted, on the request's own budget.
 *
 * Read from the error rather than recomputed: `run()` sets `budgetExhausted` on the context of the
 * `DIAGNOSIS_TIMEOUT` it throws, and asking it is how this module stays out of the deadline
 * arithmetic it deliberately delegates.
 */
function isBudgetExhausted(error: unknown): boolean {
  return isAppError(error) && error.code === 'DIAGNOSIS_TIMEOUT';
}

/**
 * Whether a fallback member was involved in a failed attempt (Requirement 14.7).
 *
 * The same two-line reading of `AppError.context.usedFallback` that `diagnosis.service.ts` does, and
 * deliberately not shared with it: it is an audit-attribution detail about a gateway convention, not
 * part of the grounding flow Requirement 16.4 is about, and exporting a private helper across two
 * services to save two lines would couple them for nothing. An error without the field means
 * "unknown", which is recorded as `false` rather than as an invented `true`.
 */
function usedFallbackOf(error: unknown): boolean {
  return isAppError(error) && error.context?.usedFallback === true;
}

/**
 * ### What `answerQuestion` deliberately does NOT do, and where it lands
 *
 * **No persistence, no quota reserve, no channel.** All three belong to `chatTurn()` below —
 * `answerQuestion` is the pure read-and-answer half, and keeping it free of writes is what lets the
 * whole grounding path be exercised without a counter, a store, or a channel. It takes no `channel`
 * parameter on purpose: a channel argument on a read keyed by conversation would be either
 * redundant (the conversation already has one, 0003) or a second grouping key contradicting
 * Requirement 7.2.
 *
 * **No `messageId`.** `PendingChatAnswer` gains it from the insert in `chatTurn()`; a read half that
 * minted a uuid would be inventing a row id for a row that does not exist yet.
 *
 * **No usage-log row.** `ChatTurnOutcome` carries every fact one needs — `provider`,
 * `usedFallback`, `degradation`, `referralReason`, `promptVersion` — because D10's audit row is
 * written once per request by the code that knows the operation and the channel, not once per
 * function that participated.
 *
 * **No language-code rejection.** Requirement 9.5's HTTP 400 naming the three supported codes is an
 * edge concern (`src/app/api/chat/route.ts`); `ChatQuestion.language` is typed `Language`, so an
 * unsupported code cannot reach this function at all.
 */

/* ========================================================================== */
/* The turn: the ordered spend, one answer, exactly two messages                */
/* ========================================================================== */

/**
 * One chat turn as a *request*: ownership, the ordered spend, one answer, two persisted messages,
 * one audit row.
 *
 * Requirements: 7.4 (when the Chat_Service produces an answer, the farmer message AND the Jamee
 *               answer are persisted as Messages in the same Conversation), 7.7 / 16.2 (one
 *               implementation serves the Web_App and the WhatsApp channel), 14.1 (one chat message
 *               spends exactly one chat unit — and a chat answer produced inside a voice request
 *               spends none), 14.2 (both channels count against one shared limit), 14.3 (an
 *               at-limit farmer is declined, told the limit and the reset time, and no provider is
 *               called), 14.6 / 14.7 (the audit row records provider, outcome and fallback),
 *               16.5 (`channel` is an input parameter and is recorded on every persisted row)
 * Design: "Quota enforcement" → *When a unit is reserved, finalized, or refunded*; "0003:
 *         conversations and messages"; D9, D10
 *
 * =============================================================================
 * THE ORDER OF OPERATIONS IS THE CONTRACT — THE SAME ONE, NOT A SECOND COPY
 * =============================================================================
 *
 * `diagnosis.service.ts` is the reference implementation of the design's ordered spend rule, and
 * this is that same sequence with the chat steps in place of the image ones. Each step satisfies
 * its criterion *by being where it is*:
 *
 *  1. **Conversation ownership** — Requirement 7.1's identifier, resolved before anything is spent,
 *     so a request naming someone else's thread costs nothing because nothing was taken.
 *  2. **Burst check** — Requirement 13.8, `src/lib/rate-limit.ts`. Before the reserve, so a refused
 *     burst never touches the daily counter and there is nothing to hand back — and **skipped
 *     entirely when this turn is covered**, on the same coverage fact step 3 reads, so one voice
 *     message cannot consume a chat burst slot as well as its own.
 *  3. **Quota reserve** — Requirements 14.1–14.3, and **nothing** when this turn is covered by an
 *     outer reservation (see the nesting rule below). An at-limit farmer is declined here and no
 *     provider is called.
 *  4. **The answer** — `answerQuestion()` above: the context window, scope resolution, and *at most
 *     one* model call. The last refundable step, because everything it can throw is thrown before
 *     the gateway is reached.
 *  5. **Persistence** — Requirement 7.4. Exactly one farmer message and one Jamee answer, in one
 *     statement.
 *  6. **The activity bump** — `conversations.updated_at`, which `conversation.service.ts` assigns to
 *     "the code that persists a message". That is this code.
 *  7. **Usage log** — Requirements 14.6, 14.7.
 *
 * =============================================================================
 * THE NESTING RULE (REQUIREMENT 14.1), AND WHY THERE IS NO SECOND FLAG
 * =============================================================================
 *
 * `ChatInput.skipQuotaReserve` is the boolean form of "this turn is covered"; `QuotaContext` is the
 * load-bearing form. `quota.service.ts` is explicit that the boolean must be mapped **once, at the
 * top of this service**, and that a boolean cannot be turned into coverage — a `QuotaReservation` is
 * branded with a module-private symbol, so the only source of one is a real reserve.
 *
 * So this function takes the coverage as a parameter, `quotaContextFor()` below reconciles it with
 * the boolean, and **a `skipQuotaReserve: true` that arrives without coverage is a defect, not a
 * discount** — it fails loudly rather than silently letting a caller opt out of the counter. No
 * second, differently-named flag is introduced anywhere.
 *
 * The refund inherits the same guarantee for free: `refundReservation()` is a no-op on an inherited
 * reservation (`reservedHere === false`), so a referral produced *inside* a voice request hands back
 * nothing — the voice unit stays spent, because a transcription call really happened.
 *
 * =============================================================================
 * AN OUT-OF-SCOPE REFERRAL SPENDS NOTHING, AND THAT IS AN INFERENCE — SAY SO
 * =============================================================================
 *
 * The design's spend rule is a biconditional: *a unit is spent if and only if at least one provider
 * call was attempted for that request.* Requirements 4.7 and 7.6 answer an out-of-scope or
 * unanswerable question from the repository's own pre-translated copy and make **no model call at
 * all** — `answerQuestion()` returns above every line that could reach a provider. Zero provider
 * calls attempted, so by the rule's own "only if", the unit is not spent: step 4's referral branch
 * refunds it and the audit row records `quota_spent = false`.
 *
 * **This is read off the biconditional, not off an explicit acceptance criterion.** The design's
 * step 9 enumerates only *failures* as refundable (signed-URL issuance, an unreadable object, a
 * knowledge-base read failure, an unhandled error ahead of the gateway call), and a referral is a
 * success. The two readings disagree, and the biconditional is the one stated as the rule — so it
 * wins here, and the disagreement is recorded rather than resolved silently. The cost of the choice
 * is bounded and named: a farmer can ask out-of-scope questions without spending a daily unit, and
 * the control for that is Requirement 13.8's burst limiter at step 2, not the daily counter.
 *
 * =============================================================================
 * A MODEL FAILURE DEGRADES; IT DOES NOT SURFACE AS A TIMEOUT
 * =============================================================================
 *
 * `answerQuestion()` states this at length and owns it: a provider failure, an exhausted budget, or
 * a rejected rephrase all return the grounded static template rather than throwing, because
 * `DIAGNOSIS_TIMEOUT`'s copy tells a farmer to resend a photo they never sent. What this function
 * adds is the **audit half** of that decision — `DEGRADATION_OUTCOME` below writes `timeout` or
 * `provider_error` on the row even though the farmer received an answer, so a degradation is
 * visible in `usage_logs` instead of being flattened into a success.
 */

/** This function reserves, and audits, exactly one operation type. */
const OPERATION: Operation = 'chat';

/* ========================================================================== */
/* The write seam                                                              */
/* ========================================================================== */

/**
 * The four database operations a turn performs.
 *
 * Named `ChatWriteStore` — and reached through `deps.writes` rather than `deps.store` — because
 * `ContextStore` above already owns the *reads*. Two seams rather than one because they hold
 * different credentials on the same request (`chatWriteStoreFrom` explains why) and because a test
 * that wants to pin the window has no business stubbing an audit insert.
 */
export interface ChatWriteStore {
  /**
   * Requirement 7.4, in **one statement**: the farmer message and the Jamee answer.
   *
   * A tuple rather than an array, so "exactly one of each" is in the type. A single multi-row
   * insert rather than two calls, so the pair cannot half-commit: two sequential inserts would let
   * a failure leave a farmer's question in the thread with no answer under it, and there is no
   * transaction available across two PostgREST calls.
   *
   * Both rows land on the same `created_at` — `now()` is transaction-scoped in Postgres — which is
   * exactly the tie `recentMessages()` above breaks with `role desc`, so the transcript still reads
   * question-then-answer.
   */
  insertTurn(
    rows: readonly [TablesInsert<'messages'>, TablesInsert<'messages'>],
  ): Promise<readonly MessageRow[]>;
  /** Requirements 14.6, 14.7. Append-only (D10). */
  insertUsageLog(row: TablesInsert<'usage_logs'>): Promise<void>;
  /**
   * Whether the supplied conversation id is this farmer's.
   *
   * `conversation.service.ts` declines to resolve a client-supplied identifier, and `assembleContext`
   * above declines to authorize one — a conversation belonging to someone else simply produces an
   * empty window there. That is why the check is here and why it is not optional: without it a
   * farmer could append their question, and Jamee's answer, to another farmer's thread. The
   * `messages` RLS policy would not catch it, because it constrains `user_id`, not
   * `conversation_id`.
   */
  ownsConversation(conversationId: string, userId: string): Promise<boolean>;
  /**
   * Bump `conversations.updated_at`. **Reports rather than throws** — see `chatTurn`.
   *
   * Returns whether the bump landed.
   */
  touchConversation(conversationId: string, userId: string): Promise<boolean>;
}

/**
 * Bind the write seam to the request's client, with the audit write on the service role.
 *
 * The same two-client split `diagnosisStoreFrom()` makes, and for the same reason — the policy set,
 * not a preference:
 *
 *  - **`messages`** has `messages_insert_own` (`auth.uid() = user_id`, migration 0003), so on the
 *    web path the insert is written with the farmer's own session and **RLS is a second boundary**
 *    behind the `user_id` this function supplies. On the WhatsApp path `client` *is* the service-role
 *    client and the application check is the only boundary — which is why every row's `user_id` is
 *    the resolved farmer and never anything derived from a payload.
 *  - **`conversations`** has `conversations_update_own`, so the activity bump works with either
 *    credential.
 *  - **`usage_logs`** has a select policy and nothing else (migration 0006). The audit row is
 *    therefore unwritable with a farmer session, by design, so it goes through `auditClient`.
 *
 * A PostgREST `error` is never read as an empty result, the rule `knowledge.ts`,
 * `conversation.service.ts` and `contextStoreFrom` above all state: the cause is logged server-side
 * and the farmer sees `INTERNAL_ERROR` (Requirement 15.6).
 */
export function chatWriteStoreFrom(
  client: SupabaseClient<Database>,
  auditClient: SupabaseClient<Database>,
): ChatWriteStore {
  return {
    async insertTurn(rows) {
      const { data, error } = await client.from('messages').insert([...rows]).select('*');
      if (error !== null || data === null) {
        throw new AppError('INTERNAL_ERROR', {
          cause: error,
          context: {
            reason: 'messages_insert_failed',
            userId: rows[0].user_id,
            conversationId: rows[0].conversation_id,
          },
        });
      }
      return data;
    },

    async insertUsageLog(row) {
      const { error } = await auditClient.from('usage_logs').insert(row);
      if (error !== null) {
        throw new AppError('INTERNAL_ERROR', {
          cause: error,
          context: { reason: 'usage_log_insert_failed', userId: row.user_id, outcome: row.outcome },
        });
      }
    },

    async ownsConversation(conversationId, userId) {
      const { data, error } = await client
        .from('conversations')
        .select('id')
        // Both predicates matter: `id` selects the row, `user_id` is the tenant boundary — the only
        // boundary when `client` is the service-role client (admin.ts).
        .eq('id', conversationId)
        .eq('user_id', userId)
        .maybeSingle();

      if (error !== null) {
        throw new AppError('INTERNAL_ERROR', {
          cause: error,
          context: { reason: 'conversation_lookup_failed', conversationId, userId },
        });
      }
      return data !== null;
    },

    async touchConversation(conversationId, userId) {
      // The value sent is overwritten by 0003's `conversations_set_updated_at` trigger, which sets
      // `now()` on every update. It is sent anyway so the *intent* of the statement is legible in
      // the code rather than only in the migration.
      const { error } = await client
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversationId)
        .eq('user_id', userId);

      return error === null;
    },
  };
}

/* ========================================================================== */
/* Dependencies and the result                                                 */
/* ========================================================================== */

export interface ChatTurnDeps extends ChatDeps {
  /**
   * The request's Supabase client: RLS-scoped for the web path, service-role for WhatsApp.
   *
   * **Required** here although `ChatDeps.supabase` is optional, for the reason
   * `DiagnosisDeps.supabase` states: a default would be one credential, and the caller needing the
   * other would have to remember to override it — on the WhatsApp path that mistake surfaces as a
   * cookie read outside a request scope, which is a confusing failure for a straightforward
   * omission. A turn writes rows, so the credential decision is made visible at every call site.
   */
  readonly supabase: SupabaseClient<Database>;
  /** Defaults to `chatWriteStoreFrom(supabase, createAdminClient())`, built on first use. */
  readonly writes?: ChatWriteStore | undefined;
  /**
   * Step 2, Requirement 13.8. `/api/chat` binds `burstLimiter()` from `src/lib/rate-limit.ts`.
   *
   * The default is `noBurstCheck`, and on this service that default carries a second meaning beyond
   * "a unit test opens no connection": `/api/voice` binds **no** limiter to the nested
   * `chatAnswerer()`, so a chat answer produced inside a voice request has nothing to call even
   * before `checkBurstForRequest()` declines to call it (module header of `rate-limit.ts`).
   */
  readonly burst?: BurstCheck | undefined;
  /** The counter RPC seam and the quota clock. Both default inside `quota.service.ts`. */
  readonly quota?: QuotaOptions | undefined;
  /** Injected clock, epoch ms. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** The caller's abort, linked into the model attempt when `runOptions` is not supplied. */
  readonly signal?: AbortSignal | undefined;
  /** Source of the platform deadline. Defaults to V18's `getDeadline()` inside the gateway. */
  readonly platformDeadline?: (() => Date | undefined) | undefined;
}

/**
 * What a turn returns: exactly `chatResponseSchema`'s four fields.
 *
 * So the route serializes them without reshaping, and — because the field list is the wire
 * contract's — `voice.service.ts`'s `NestedChatOutcome` is satisfied structurally rather than
 * through an adapter. `chatAnswerer()` below is where the compiler checks that.
 */
export interface ChatTurnResult {
  readonly conversationId: string;
  readonly farmerMessageId: string;
  readonly answer: ChatAnswer;
  readonly quota: QuotaStatus;
}

/* ========================================================================== */
/* The audit vocabulary                                                        */
/* ========================================================================== */

/**
 * Which `usage_logs.outcome` a degradation is — **the shared mapping**, not a chat-local one.
 *
 * `satisfies Record<ChatDegradation, UsageOutcome>` is what makes borrowing it safe: `ChatDegradation`
 * and `src/lib/db/usage-log.ts`'s `RephraseDegradation` are the same three causes, and if this file
 * ever adds a fourth the assertion fails until the shared mapping decides how it is audited.
 *
 *  - **`timeout`** for an exhausted budget, which is the request's own clock talking (Requirement
 *    3.7's outcome value, on a row whose operation is `chat`).
 *  - **`provider_error`** for an exhausted or failed chain (Requirement 14.5).
 *  - **`validation_rejected`** when the model answered and `validateRephrased()` refused its prose
 *    (Requirement 5.7's outcome value), now carrying `rejection_reason: 'rephrase_rejected'`.
 *
 * ### What task 24.3 changed here
 *
 * Two recorded gaps closed, both of them "the same event, audited two ways":
 *
 *  - **`rejection_reason` was `null` on this row.** 0006's seven reasons are all D2 vision-stage
 *    values, so a rejected rephrase had no reason to be attributed to — a `validation_rejected` row
 *    with a null reason, which is Requirement 5.7's letter unmet. Migration 0011 added
 *    `rephrase_rejected`, deliberately as an *audit-only* value: the farmer receives the
 *    knowledge-base static template, so there is no inconclusive sentence to localize and
 *    `MessageCatalog.inconclusive` stays exhaustive over the seven farmer-facing reasons.
 *  - **`diagnosis.service.ts` wrote the coarse `provider_error` for the same event.** It now shares
 *    this mapping. The finer split was the correct one — this path degrades on three distinguishable
 *    causes and collapsing them claims a chain failure that did not happen — so reconciling meant
 *    the diagnosis path adopting it, not this one giving it up.
 */
const DEGRADATION_OUTCOME = SHARED_DEGRADATION_OUTCOME satisfies Record<
  ChatDegradation,
  UsageOutcome
>;

/**
 * The outcome for a turn that made no model call at all (Requirements 4.7, 7.6).
 *
 * **`inconclusive`**, which 0006 glosses as "a SUCCESSFUL request, unjudgeable photo". The request
 * worked and Jamee answered honestly that it holds no verified content for the question — that is
 * the same shape of fact, and `voice.service.ts` already extends the value the same way for an empty
 * transcript. `success` would claim the question was answered; `provider_error` would claim a
 * failure that did not happen.
 */
const REFERRAL_OUTCOME: UsageOutcome = 'inconclusive';

/* ========================================================================== */
/* chatTurn                                                                    */
/* ========================================================================== */

/**
 * Answer one chat turn and persist it.
 *
 * `input.channel` is required by `ChatInput` (Requirement 16.5), so a caller cannot forget it and
 * both persisted rows carry it. `input.language` is already validated at the edge (Requirement
 * 9.5), which is why it is a `Language` here and not a string.
 *
 * `coverage` is the third parameter rather than a field of `deps` because it is a fact about *this
 * request*, while `deps` is the wiring: `chatAnswerer()` closes over the wiring once and passes the
 * coverage per call, which is exactly the shape `voice.service.ts`'s `ChatAnswerer` declares.
 */
export async function chatTurn(
  input: ChatInput,
  deps: ChatTurnDeps,
  coverage?: QuotaContext,
): Promise<ChatTurnResult> {
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const { userId, conversationId, language, channel } = input;

  const writes = deps.writes ?? (await defaultWriteStore(deps.supabase));
  const burst = deps.burst ?? noBurstCheck;
  const quotaOptions: QuotaOptions = deps.quota ?? {};

  /** The audit write, which never throws — see `writeUsageLog` in `src/lib/db/usage-log.ts`. */
  const log = async (facts: ChatUsageFacts): Promise<void> => {
    await writeUsageLog(writes, {
      userId,
      operation: OPERATION,
      channel,
      conversationId,
      latencyMs: now() - startedMs,
      ...facts,
    });
  };

  // ── 1. Conversation ownership (Requirement 7.1) — nothing has been spent ───
  if (!(await writes.ownsConversation(conversationId, userId))) {
    // The same code an unparseable id gets at the edge. A client cannot tell "malformed" from "not
    // yours" from the outside, and it should not be able to: both mean "you may not write to that
    // thread", and one code for one meaning keeps the response from being an oracle.
    throw new AppError('CONVERSATION_NOT_FOUND', {
      context: { reason: 'conversation_not_owned', conversationId, userId },
    });
  }

  /**
   * Whose request this is, resolved once and used twice — by the burst check and by the reserve, in
   * that order. Resolving it here rather than at step 3 is what lets **one** fact ("this turn
   * entered somewhere else") govern both controls, instead of a boolean for one and a context for
   * the other. It also means `quotaContextFor`'s wiring-defect throw (`skipQuotaReserve` with no
   * coverage) is raised one step earlier, which changes nothing a farmer can observe: both steps are
   * before the reserve, and nothing has been spent at either.
   */
  const quotaContext = quotaContextFor(input, coverage);

  // ── 2. Burst check (Requirement 13.8) — still nothing spent ───────────────
  // Skipped entirely on a `covered` context: a chat answer produced inside a voice request was
  // burst-checked by the voice endpoint, and checking again would refuse a farmer for a request they
  // made once. See `checkBurstForRequest` in `rate-limit.ts`.
  try {
    await checkBurstForRequest(quotaContext, burst);
  } catch (error) {
    // Requirement 13.8's refusal, audited (migration 0011's `rate_limited`). Nothing is reserved at
    // this point, so `quota_spent: false` and there is no refund to make. A nested turn never
    // reaches this catch: `checkBurstForRequest` returns without calling anything on a `covered`
    // context, so a voice request cannot produce two `rate_limited` rows for one refusal.
    if (isRateLimited(error)) {
      await log({ outcome: 'rate_limited', provider: 'none', usedFallback: false, quotaSpent: false });
    }
    throw error;
  }

  // ── 3. Reserve, or inherit an outer reservation (Requirements 14.1–14.3) ──
  const reserved = await reserveForRequest(quotaContext, quotaOptions);
  if (reserved.outcome === 'at_limit') {
    await log({ outcome: 'quota_declined', provider: 'none', usedFallback: false, quotaSpent: false });
    // Requirement 14.3: states the limit and the reset time, and no provider was called.
    throw quotaExceededError(reserved.status);
  }
  const reservation: QuotaReservation = reserved.reservation;

  // ── 4. The answer: context, scope, and AT MOST one model call ─────────────
  let turn: ChatTurnOutcome;
  try {
    turn = await answerQuestion(
      { conversationId, userId, message: input.message, language },
      answerDepsFor(deps, now, startedMs),
    );
  } catch (error) {
    /**
     * Everything reachable here is pre-provider, which is what makes the refund correct rather
     * than generous: `answerQuestion()` **degrades** on every provider outcome instead of throwing,
     * so a throw is a context read failure, a knowledge-base read failure, or an unhandled error
     * ahead of the gateway — the design's step 9 list, verbatim.
     *
     * `quota_spent = false` on the audit row is what distinguishes a pre-provider failure from a
     * provider one; the outcome vocabulary has no value for "a read failed", and `provider_error`
     * with `quota_spent = false` says exactly that without inventing one.
     */
    await refundReservation(reservation, quotaOptions);
    await log({ outcome: 'provider_error', provider: 'none', usedFallback: false, quotaSpent: false });
    throw error;
  }

  /**
   * The spend question, asked once. A referral is the **only** path on which no provider call was
   * attempted — every other path went through `groundedAnswer()`, which either called the model or
   * had the gateway refuse to start on an exhausted budget, and the design is explicit that a
   * timeout stays spent.
   */
  const providerAttempted = turn.referralReason === null;

  // ── 5. Persistence — Requirement 7.4, one farmer message and one answer ───
  let persisted: PersistedTurn;
  try {
    persisted = await persistTurn(writes, input, turn.answer);
  } catch (error) {
    if (!providerAttempted) await refundReservation(reservation, quotaOptions);
    await log({
      outcome: 'provider_error',
      provider: turn.provider ?? 'none',
      usedFallback: turn.usedFallback,
      quotaSpent: providerAttempted,
    });
    throw error;
  }

  // ── 6. The activity bump — conversation.service.ts's ordering depends on it ─
  if (!(await writes.touchConversation(conversationId, userId))) {
    /**
     * Logged, never thrown. Both messages are committed and the farmer has an answer; turning a
     * missed `updated_at` into HTTP 500 would cost them a retry and another unit for a problem they
     * cannot act on. The consequence is bounded and already documented in `conversation.service.ts`:
     * the find-or-create ordering degrades to "most recently created", which is the same row
     * whenever a farmer has one thread on the channel.
     */
    console.error(
      '[jamee] conversation_touch_failed',
      JSON.stringify({ conversationId, userId, channel }),
    );
  }

  // ── The referral refund (see the header) ──────────────────────────────────
  const quota = providerAttempted
    ? quotaStatusOf(reservation)
    : await refundedStatus(reservation, quotaOptions);

  // ── 7. Usage log (Requirements 5.7, 14.6, 14.7) ───────────────────────────
  await log({
    outcome: providerAttempted ? outcomeFor(turn.degradation) : REFERRAL_OUTCOME,
    provider: turn.provider ?? 'none',
    usedFallback: turn.usedFallback,
    quotaSpent: providerAttempted,
    /**
     * Requirement 5.7, closed. A `checks_failed` degradation now carries `rephrase_rejected`, so a
     * `validation_rejected` row is attributable rather than a rejection recorded without its reason.
     * Every other degradation — and a referral, which never reached the model — carries none, which
     * `usageLogRow()` writes as an explicit `null`.
     */
    ...(providerAttempted
      ? { rejectionReason: rejectionReasonForDegradation(turn.degradation) }
      : {}),
  });

  return {
    conversationId,
    farmerMessageId: persisted.farmerMessageId,
    // The answer as the wire contract wants it: everything `answerQuestion()` produced, plus the id
    // of the row it was actually stored as.
    answer: { ...turn.answer, messageId: persisted.answerMessageId },
    quota,
  };
}

/**
 * `ChatService`, bound to one set of dependencies — the shape `voice.service.ts` consumes.
 *
 * Its `ChatAnswerer` is declared with **no default** because the answer half of this service did not
 * exist when task 18.2 landed. This is that default: task 18.3 passes
 * `chat: chatAnswerer({ supabase, runOptions })` and the nested call inherits both the credential
 * and the voice request's own budget, which is how one deadline comes to cover transcription *and*
 * the answer — `ChatAnswerer` has no parameter for a deadline, so the closure is the only channel
 * for it.
 *
 * The return annotation is the load-bearing part: it makes the compiler check that a turn's result
 * still satisfies `NestedChatOutcome`, so the two cannot drift without a build failure. The import
 * is type-only and creates no runtime edge (and no cycle — `voice.service.ts` imports nothing from
 * here).
 */
export function chatAnswerer(deps: ChatTurnDeps): ChatAnswerer {
  return (input, coverage) => chatTurn(input, deps, coverage);
}

/* ========================================================================== */
/* Step 3's mapping — the boolean, and the coverage that outranks it            */
/* ========================================================================== */

/**
 * Reconcile `ChatInput.skipQuotaReserve` with the coverage a caller passed.
 *
 * Three cases, and the middle one is the point:
 *
 *  1. **Coverage that is real** (`role: 'covered'`) wins, whatever the boolean says. A
 *     `QuotaReservation` is unforgeable proof that a unit is already spent for this request, so
 *     honouring it is what keeps a farmer from being charged twice — and a caller that passed the
 *     reservation but forgot the boolean has still told the truth.
 *  2. **`skipQuotaReserve: true` with no coverage is a defect**, and fails loudly. A boolean cannot
 *     be turned into coverage (`quota.service.ts`), so treating it as one would be a client-settable
 *     discount on Requirement 14.1's limit. `INTERNAL_ERROR` because this is Jamee's own wiring
 *     mistake, not something a farmer did: the detail goes to the server log through
 *     `AppError.context`, which structurally cannot reach the response body.
 *  3. Otherwise this turn is the entry point for its own operation type, and takes the reserve.
 */
function quotaContextFor(input: ChatInput, coverage: QuotaContext | undefined): QuotaContext {
  if (coverage?.role === 'covered') return coverage;

  if (input.skipQuotaReserve === true) {
    throw new AppError('INTERNAL_ERROR', {
      context: {
        reason: 'skip_quota_reserve_without_coverage',
        userId: input.userId,
        conversationId: input.conversationId,
      },
    });
  }

  return coverage ?? ownsRequest(input.userId, OPERATION);
}

/**
 * The quota block for a turn whose unit was handed back.
 *
 * The refund's own post-decrement count is used rather than the reservation's, so the number the
 * farmer's client shows is the one the counter holds. A no-op refund — an inherited reservation
 * (Requirement 14.1's nesting rule) or a counter already at zero — reports the reservation
 * unchanged, which is then the outer request's true count.
 */
async function refundedStatus(
  reservation: QuotaReservation,
  options: QuotaOptions,
): Promise<QuotaStatus> {
  const status = quotaStatusOf(reservation);
  const refund = await refundReservation(reservation, options);
  return refund.refunded ? { ...status, used: refund.used } : status;
}

/**
 * The read half's dependencies, from the turn's.
 *
 * `deps` is spread wholesale because `ChatTurnDeps extends ChatDeps` — the extra keys are inert
 * there, and listing the seven shared ones by hand would be a list to keep in step for no gain.
 *
 * `runOptions` is the one field that gains a default. Absent, the gateway is handed this request's
 * start instant and clock so that `run()` computes the budget from **when the request began** rather
 * than from when the model call happens to be reached — the reserve and two reads sit in between.
 * A caller with its own budget (the voice path, whose transcription and answer share one deadline)
 * passes `runOptions` and this default never applies.
 */
function answerDepsFor(deps: ChatTurnDeps, now: () => number, startedMs: number): ChatDeps {
  return {
    ...deps,
    runOptions:
      deps.runOptions ??
      {
        now,
        requestStartMs: startedMs,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        ...(deps.platformDeadline === undefined ? {} : { platformDeadline: deps.platformDeadline }),
      },
  };
}

/* ========================================================================== */
/* Step 5 — Requirement 7.4                                                    */
/* ========================================================================== */

interface PersistedTurn {
  readonly farmerMessageId: string;
  readonly answerMessageId: string;
}

/**
 * Persist exactly one farmer message and one Jamee answer in the same conversation.
 *
 * Requirement 7.4 is a statement about a *pair*, so it is written as one insert of two rows — see
 * `ChatWriteStore.insertTurn` for why that matters. What is worth reading closely is the four
 * columns the task names:
 *
 *  - **`role`** — `farmer` for the question, `jamee` for the answer. Nothing else writes either.
 *  - **`language`** — the farmer's row carries the language the request declared; the answer's
 *    carries `answer.language`. They are read from **different sources on purpose**: D9 has the
 *    answer's language follow the message, resolved by the model, so a Hindi question inside a
 *    request that declared `mr` can legitimately produce an `hi` answer. Copying the request's code
 *    onto both rows would overwrite the very fact D9 exists to capture.
 *  - **`channel`** — `input.channel`, on both rows (Requirement 16.5).
 *  - **`input_kind`** — the farmer's row carries what actually arrived: `voice` on the voice path,
 *    where Requirement 8.4 has the transcript enter the conversation as a normal farmer message
 *    distinguished only by this column, and `text` otherwise. The answer's row is **always `text`**:
 *    Requirement 8.8 rules out synthesized speech, so a Jamee message is text on every channel and
 *    for every kind of question. It is written explicitly rather than left to 0003's default so it
 *    cannot be read as an omission.
 *
 * `transcript_of` is set only when the caller supplied one (the voice path), which is the provenance
 * of an object Requirement 8.9 is about to delete.
 *
 * The rows are matched back by `role` rather than by position: two rows with distinct roles are
 * unambiguous, and nothing here needs to assume PostgREST returns a multi-row insert in the order it
 * was given.
 */
async function persistTurn(
  writes: ChatWriteStore,
  input: ChatInput,
  answer: PendingChatAnswer,
): Promise<PersistedTurn> {
  const shared = {
    conversation_id: input.conversationId,
    user_id: input.userId,
    channel: input.channel,
  } as const;

  const stored = await writes.insertTurn([
    {
      ...shared,
      role: 'farmer',
      content: input.message,
      language: input.language,
      input_kind: input.inputKind ?? 'text',
      ...(input.transcriptOf === undefined ? {} : { transcript_of: input.transcriptOf }),
    },
    {
      ...shared,
      role: 'jamee',
      content: answer.content,
      language: answer.language,
      input_kind: 'text',
    },
  ]);

  const farmer = stored.find((row) => row.role === 'farmer');
  const jamee = stored.find((row) => row.role === 'jamee');

  if (farmer === undefined || jamee === undefined) {
    // The insert reported success, so both rows exist; a store that returned something else is a
    // defect in Jamee, and the farmer sees the generic 500 of Requirement 15.6.
    throw new AppError('INTERNAL_ERROR', {
      context: {
        reason: 'turn_rows_missing',
        conversationId: input.conversationId,
        userId: input.userId,
        returned: stored.length,
      },
    });
  }

  return { farmerMessageId: farmer.id, answerMessageId: jamee.id };
}

/* ========================================================================== */
/* Step 7 — the audit row (Requirements 14.6, 14.7; D10)                       */
/* ========================================================================== */

/** `null` degradation is a success: the farmer read the model's own grounded prose. */
function outcomeFor(degradation: ChatDegradation | null): UsageOutcome {
  return degradation === null ? 'success' : DEGRADATION_OUTCOME[degradation];
}

/**
 * The facts a chat call site supplies. The five this service already knows — the farmer, the
 * operation, the channel, the conversation and the elapsed time — are filled in by the `log`
 * closure, so a call site cannot get them wrong and cannot omit them.
 *
 * Derived from the shared `UsageFacts` by subtraction rather than re-declared, which is what makes
 * "one audit vocabulary" compiler-checked: a column added to `usage_logs` appears here
 * automatically, and this service stops compiling until every branch decides what to write in it.
 *
 * `diagnosis_id` is deliberately not offered: a chat turn produces messages, not a diagnosis, so
 * `usageLogRow()` writes it as `null`. The never-throw rule and the `prompt_version`-on-every-row
 * rule live in `src/lib/db/usage-log.ts` now, once, instead of in a near-copy per service.
 */
type ChatUsageFacts = Omit<
  UsageFacts,
  'userId' | 'operation' | 'channel' | 'conversationId' | 'diagnosisId' | 'latencyMs'
>;

/**
 * Whether the burst limiter refused this turn (Requirement 13.8), as opposed to failing.
 *
 * Read off the code rather than caught by position, because `burst` is an injected seam: a limiter
 * whose counter RPC failed raises `INTERNAL_ERROR`, and auditing that as a `rate_limited` refusal
 * would record a refusal that never happened.
 */
function isRateLimited(error: unknown): boolean {
  return isAppError(error) && error.code === 'RATE_LIMITED';
}

/**
 * The default write store, built on first use.
 *
 * `createAdminClient()` is imported **lazily** so a caller that injects its own store — every unit
 * test — never reads `SUPABASE_SERVICE_ROLE_KEY`. Same reasoning as the lazy `createServerSupabase`
 * import in `serverStore()` above, applied to the other credential.
 */
async function defaultWriteStore(client: SupabaseClient<Database>): Promise<ChatWriteStore> {
  const { createAdminClient } = await import('@/lib/supabase/admin');
  return chatWriteStoreFrom(client, createAdminClient());
}
