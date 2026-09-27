import type { RunOptions } from '@/lib/ai/gateway';
import { authenticatedRoute } from '@/lib/api/authenticated-route';
import { parseJsonBody, type IssueMapper } from '@/lib/api/request-body';
import { withErrorHandling } from '@/lib/errors';
import { burstLimiter } from '@/lib/rate-limit';
import { voiceRequestSchema, type Language, type VoiceResponse } from '@/lib/schemas';
import { chatAnswerer } from '@/services/chat.service';
import { transcribeAndAnswer, voiceRequestDeadline } from '@/services/voice.service';

/**
 * `POST /api/voice` — the web channel's entry to the shared `VoiceService`.
 *
 * Requirements: 1.7 (no valid session → HTTP 401 and no domain service invoked), 8.1 (the body
 *               carries only a `voice` Media_Reference, never the audio bytes), 8.2 /
 *               8.3 (the 120 s and 3 MB limits, re-checked server-side), 8.6 (the transcript AND
 *               the text answer are both returned), 9.5 (a language code outside the
 *               Supported_Languages is HTTP 400 naming the supported codes), 14.1 (one voice
 *               message spends exactly one voice unit — never a voice unit and a chat unit), 15.3
 *               (every failure leaves through the one localized error envelope), 16.5 (`channel` is
 *               an input parameter)
 * Design: "Route handlers (thin)"; "Voice capture"; "Quota enforcement" → *When a unit is reserved,
 *         finalized, or refunded*
 * Depends on: V10 (the transcription caps), V17 (the duration ceiling and the route segment config
 *             that declares it), V18 (the platform deadline behind `voiceRequestDeadline`)
 *
 * ### The same five steps as `/api/chat` and `/api/diagnose`
 *
 * Session check (the wrapper) → read the body → parse it → **one** service call → serialize the
 * result. No transcription, no prompt text, no provider call, no SQL, and no quota arithmetic:
 * every judgement a farmer sees was made by `VoiceService`, which is what keeps the web and
 * Telegram channels answering identically (Requirement 16.2) rather than by agreement between two
 * handlers.
 *
 * The ordering that matters is not maintained here either — it is the wrapper's. The handler body is
 * a callback that only runs after a non-null user id has been resolved, so "the session check
 * precedes any domain service call, any quota reserve and any provider call" is the only order the
 * control flow permits (Requirement 1.7).
 *
 * ### What this route reserves: nothing
 *
 * `transcribeAndAnswer()` takes the `voice` unit itself and hands `coveredBy(reservation)` to the
 * nested chat call, so one voice message never spends both a voice unit and a chat unit
 * (Requirement 14.1). This route therefore passes **no `QuotaContext`** and no `skipQuotaReserve` —
 * there is no code path from this file that could opt a request out of the counter, and none that
 * could charge it twice.
 *
 * ### The one thing this route contributes that the service cannot
 *
 * A *fact about this request*, not a decision about a farmer's recording:
 *
 *  1. **One deadline for the whole request.** `voiceRequestDeadline()` is called once and handed to
 *     both halves — to `VoiceService` as `deadlineMs`, and to the nested `ChatService` through
 *     `chatAnswerer({ runOptions })`. `ChatAnswerer` has no deadline parameter, so the
 *     closure is the only channel there is; without it the nested turn would compute a fresh 45 s
 *     budget partway into a request that already spent part of its own on transcription.
 *
 * ### What this route rate-limits: the voice request, once
 *
 * Requirement 13.8 names this endpoint, so `burstLimiter()` is bound to `VoiceService` here and takes
 * one slot against the `voice` minute ceiling before the reserve. It is **not** bound to the nested
 * `chatAnswerer()`: that answer is covered by this request's voice unit and by this request's burst
 * slot, and charging it a chat slot as well would let a farmer's voice message eat an allowance they
 * never spent. See the call site below.
 *
 * ### What the service is given, and what it is not
 *
 * *Amendment A3:* the route builds and passes no database client. Under A3 there is no relational
 * RLS layer; `VoiceService` reads and writes through the owner-scoped Data_Access_Layer, scoped by the
 * `userId` the service supplies, which is the sole tenant boundary. The conversation-ownership
 * lookup, the two `messages` writes and the GridFS reads all run through that layer. The `usage_logs`
 * audit write and the on-success deletion of the recording are likewise the service's own business
 * through the same layer — this route neither builds nor holds a credential for them. Requirement
 * 8.11's "only from a server-side module" is satisfied by the delete living in the service rather
 * than here.
 */

/**
 * **V17.** Jamee's own ceiling, in seconds — not the platform's documented 300
 * (`PLATFORM_MAX_DURATION_SECONDS`). Every soft timeout in Jamee is a fraction of this number, so
 * raising it is a deliberate act with arithmetic consequences (`docs/PROVIDER_CAPABILITIES.md`
 * section 3).
 *
 * Written as a literal because Next.js reads route segment config by static analysis, so an imported
 * constant is not usable here. `route.test.ts` asserts this literal equals
 * `JAMEE_MAX_DURATION_SECONDS`, which is what stops the two drifting apart — the same guard the
 * chat, diagnose and Telegram routes carry.
 */
export const maxDuration = 60;

/* ========================================================================== */
/* Reading the body                                                            */
/* ========================================================================== */

/**
 * **Requirement 8.3's own code, and the one branch that is genuinely this endpoint's.**
 *
 * `AUDIO_TOO_LONG` is meaningless on a request that carries no audio, so it is contributed to the
 * shared edge as an `endpointSpecific` mapper rather than living in it. The mapper is consulted
 * after Requirement 9.5 and the conversation branch and before the fallback, which is the order the
 * three routes already had — a body naming both an unsupported language and an over-long recording
 * is `LANGUAGE_UNSUPPORTED`, because the language is the thing Jamee will not do at all.
 *
 * `code` is read here and nowhere else at the edge: `too_big` is a recording past
 * `MAX_AUDIO_SECONDS`, while `too_small` or a missing value is a malformed request and must not be
 * told "that recording is too long". `errors.ts` fills `maxSeconds` and `maxBytes` into both the
 * sentence and `details` from `config/verified.ts`, so the message cannot quote a limit the check
 * did not use.
 *
 * This is the server-side half of Requirement 8.2 that the recorder's own 120 s stop cannot
 * provide: the stop is a client-side check on a server-side spend rule, and a hand-built request
 * need not have a recorder in it at all. `assertAdmissibleAudio()` re-checks the same bound inside
 * the service for callers that never pass through this schema — the Telegram path, whose duration
 * comes from provider metadata.
 */
const audioDurationIssue: IssueMapper = (issues) =>
  issues.some((issue) => issue.path[0] === 'durationSeconds' && issue.code === 'too_big')
    ? 'AUDIO_TOO_LONG'
    : null;

/**
 * Requirement 8.1's contract, and the single edge that applies it.
 *
 * `parseJsonBody` reads the JSON, parses it against `voiceRequestSchema` and names the coded
 * failure — including Requirement 9.5's `LANGUAGE_UNSUPPORTED`, whose branch lives in
 * `src/lib/api/request-body.ts` rather than here because it is *one* rule and this is one of three
 * endpoints stating it. That module also records why `languageSchema` is the check and why
 * `language.server.ts`'s `activeLanguage()` is not: handed an unsupported code it falls back to
 * `en`, where Requirement 9.5 wants a refusal. A `conversationId` that is not a uuid gets
 * `CONVERSATION_NOT_FOUND` there too, the same code the nested `ChatService` raises for an id that
 * is not this farmer's.
 *
 * `fallback: 'STORAGE_REF_INVALID'` is a good fit here rather than a borrowed one — Requirement 8.1
 * makes the Media_Reference the substance of the body, so an absent `audio`, a reference that is not
 * a valid `{ fileId, kind }` pair, a reference whose `kind` is not `voice`, an over-long `mimeType`, a
 * body that is not an object and a body that is not JSON at all all describe the same thing going
 * wrong.
 */
const BODY_CONTRACT = {
  fallback: 'STORAGE_REF_INVALID',
  endpointSpecific: audioDurationIssue,
} as const;

/* ========================================================================== */
/* The handler                                                                 */
/* ========================================================================== */

export const POST = authenticatedRoute(async (request, session) => {
  /**
   * This throws coded 400s, and they are rendered by the wrapper's envelope — whose language comes
   * from `?language=` or `Accept-Language`, because at this point the body's language code is either
   * unread or the very thing being refused. Rendering a `LANGUAGE_UNSUPPORTED` in the unsupported
   * language would be the one obviously wrong choice.
   */
  const body = await parseJsonBody(request, voiceRequestSchema, BODY_CONTRACT);
  const language: Language = body.language;

  /**
   * A second envelope, and not a redundant one: from here on the farmer's requested language is
   * known, and Requirement 15.3 wants the failure written in it. The wrapper's thunk cannot supply
   * that — `withErrorHandling` resolves the language **before** running the handler, so there is no
   * later assignment it could pick up. Nesting is what puts the parsed language in scope of the
   * envelope that will render `QUOTA_EXCEEDED`, `TRANSCRIPT_EMPTY` or `TRANSCRIPTION_FAILED`.
   */
  return withErrorHandling(
    async () => {
      /**
       * One deadline, computed once, for transcription *and* the answer it produces. See the module
       * header; `runOptions` is the nested turn's only channel for it.
       */
      const deadlineMs = voiceRequestDeadline({ requestStartMs: Date.now() });
      const runOptions: RunOptions = { deadlineMs };

      /**
       * The one service call.
       *
       * `channel: 'web'` is a literal because `VoiceInput.channel` is required (Requirement 16.5)
       * and this route is only ever the web channel. Under Amendment A3 the body carries a `voice`
       * Media_Reference, not a storage path: the service reads the recording's bytes from GridFS
       * through the Data_Access_Layer and sends them to the transcription provider as `file` — this
       * route holds no client and passes no bytes (D1). The recording's size was already admitted at
       * the Media_Endpoint against `MAX_AUDIO_BYTES` (A3), so there is no size probe here; the
       * service re-checks the byte length it read against the same cap. `mimeType` is spread
       * conditionally rather than passed as `undefined`, which `exactOptionalPropertyTypes`
       * distinguishes.
       *
       * `chat: chatAnswerer({ runOptions })` is the nested `ChatService`, bound to this request's
       * budget. The reservation travels separately — the service hands the nested call `coveredBy()`
       * on the voice unit it took — so nothing here can turn one voice message into two spent units.
       */
      const outcome = await transcribeAndAnswer(
        {
          userId: session.userId,
          audio: body.audio,
          language,
          channel: 'web',
          conversationId: body.conversationId,
          durationSeconds: body.durationSeconds,
          ...(body.mimeType === undefined ? {} : { mimeType: body.mimeType }),
        },
        {
          /**
           * **No `burst` here, deliberately.** Requirement 13.8's slot for this request is taken by
           * the limiter below, against the `voice` ceiling; the answer this request produces is
           * covered by it, exactly as it is covered by the voice quota unit.
           */
          chat: chatAnswerer({ runOptions }),
          burst: burstLimiter(),
          deadlineMs,
        },
      );

      /**
       * Exactly `voiceResponseSchema`, and nothing more. **Requirement 8.6 is this pair being
       * present together** — the transcript the provider produced and the answer the ChatService
       * wrote — and both are copied off the outcome unchanged, so the wire contract and the
       * service's answer cannot drift apart. The annotation is the check: a service that returned a
       * shape outside the contract would fail to compile here.
       *
       * `quota` is the **voice** counter, from the reservation the service took. The outcome's
       * remaining fields (`farmerMessageId`, `provider`, `usedFallback`, `audio`) are audit facts and
       * are deliberately left off the wire: which provider transcribed, and what became of the
       * recording, are not a farmer's business, and a client that could see them could start
       * depending on them.
       */
      const payload: VoiceResponse = {
        transcript: outcome.transcript,
        answer: outcome.answer,
        conversationId: outcome.conversationId,
        quota: outcome.quota,
      };

      return Response.json(payload);
    },
    () => language,
  );
});
