import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EXHAUSTED_CHAIN_CODE } from '@/lib/ai/gateway';
import {
  MAX_AUDIO_SECONDS,
  STORAGE_BUCKETS,
  TRANSCRIBE_ACCEPTED_CONTAINERS,
} from '@/lib/config/verified';
import { AppError, ERROR_SPECS, isAppError, toEnvelope } from '@/lib/errors';
import { messages } from '@/lib/messages';
import {
  SUPPORTED_LANGUAGES,
  voiceResponseSchema,
  type Channel,
  type ChatInput,
  type Language,
  type StorageRef,
  type VoiceInput,
} from '@/lib/schemas';
import type { StorageClientLike } from '@/lib/storage';
import {
  quotaStatusOf,
  reserveForRequest,
  type CounterRpc,
  type QuotaContext,
} from '@/services/quota.service';
import {
  transcribeAndAnswer,
  type ChatAnswerer,
  type NestedChatOutcome,
  type ObjectRemoveClient,
  type VoiceDeps,
  type VoiceStore,
} from '@/services/voice.service';
import type { Database, TablesInsert } from '@/types/database';

import {
  providerCallCount,
  providerRejection,
  providerStubs,
  RATE_LIMIT_STATUS,
  UNAVAILABLE_STATUS,
  type ProviderStubs,
  type TranscriptionPayload,
} from '../integration/providers';

/**
 * ### Property 18: The voice pipeline preserves the transcript and handles an empty one
 *
 * *"For any non-empty transcript, that exact text is passed to the chat service as the farmer
 * message and the response returns both the transcript and the text answer; for any transcript that
 * is empty or only whitespace, the response asks the farmer to record the question again in a
 * quieter place and no chat answer is produced."*
 *
 * **Validates: Requirements 8.4, 8.6, 8.7**
 *
 * =============================================================================
 * WHERE THE PROPERTY IS OBSERVED
 * =============================================================================
 *
 * Steps 6 to 8 of `transcribeAndAnswer()` — the transcription call, the empty-transcript branch,
 * and the nested `ChatService` call — driven through the service with every seam injected, so there
 * is no Supabase stack, no HTTP layer and no live provider.
 *
 * **Transcription is stubbed at the adapter seam** (`GroqTranscribeOptions.create`, through
 * `providerStubs()` in `tests/integration/providers.ts`), not at `VoiceDeps.transcribe`. That leaves
 * the whole of the path a transcript actually travels real: `transcriptionRequestBody()`'s
 * pre-flight guards, V11's error classification, `readTranscription()`'s structural read of the
 * `verbose_json` payload, and `gateway.run()`'s chain loop. Preservation is a claim about what
 * happens *between* the provider's bytes and the farmer message, so a seam above that machinery
 * would make the claim true by construction — the stub would hand the service the same string
 * object it hands the assertion.
 *
 * =============================================================================
 * WHAT "PRESERVES" IS ASSERTED AS
 * =============================================================================
 *
 * String equality between the text the seam returned and `ChatInput.message`, plus the same
 * equality against `VoiceOutcome.transcript`. Not "the transcriber was called" and not a
 * containment check: a pipeline that trimmed, truncated, collapsed newlines or re-normalized
 * Devanagari would still have called the transcriber, and would still *contain* most of the
 * transcript.
 *
 * Three shapes exist in the generator specifically because they are what a lossy step damages, and
 * each is a class the coverage assertion at the end proves was generated:
 *
 *  - **`surrounding_whitespace`** — Whisper reliably emits a leading space. A `trim()` that leaked
 *    from the emptiness *predicate* into the value would pass every containment assertion.
 *  - **`multiline` / `long`** — a newline is what a single-line normalizer eats, and ~1.5 kB of text
 *    is what a truncating one shortens. Both are compared whole.
 *  - **`devanagari`** — every Devanagari transcript carries `\u0958` (क़), a code point with a
 *    canonical decomposition that Unicode's composition exclusions keep NFC from recomposing. So
 *    `transcript.normalize('NFC') !== transcript` holds by construction, and it is asserted as a
 *    guard: any `.normalize()` anywhere on this path changes the string, and the equality below
 *    sees it. Requirement 9.4's canonical names are untranslated, but a farmer's own question is
 *    the farmer's bytes — Jamee has nothing to gain by rewriting them.
 *
 * =============================================================================
 * WHY THE EMPTY CASE IS ASSERTED AS AN OUTCOME AND A COUNT OF ZERO
 * =============================================================================
 *
 * Requirement 8.7 is two claims, and the second is a negative: the farmer is asked to record again
 * somewhere quieter, **and no chat answer is produced**. A blank farmer message sent onward would
 * satisfy the first claim on its own — it would spend a knowledge-base read and a model call to
 * answer nothing, and would persist an empty `messages` row — so the negative is asserted the only
 * way a negative can be: the chat seam's call list is empty, and `providerCallCount()` over the
 * adapter seams is exactly 1, the transcription round trip and nothing after it.
 *
 * The farmer-facing half is asserted at the API layer's own boundary rather than by re-reading the
 * catalog: `toEnvelope(error, language)` is what `/api/voice` returns through `withErrorHandling`,
 * and its message must be the `TRANSCRIPT_EMPTY` string for the request's language. Which sentence
 * that is, and that all three are non-empty and localized, is Property 29's claim; what is asserted
 * here is that *this branch reaches that code* rather than a generic failure.
 *
 * =============================================================================
 * REQUIREMENT 8.4's THIRD OUTCOME, AND WHY IT IS IN THIS PROPERTY
 * =============================================================================
 *
 * 8.4 gives a failed transcription its own code. The `provider_failed` class drives the transcribe
 * chain to exhaustion through a real V11 classification of a 429 or a 503, and asserts the result is
 * `TRANSCRIPTION_FAILED` — **not** `PROVIDERS_UNAVAILABLE`, which is what an exhausted
 * vision-or-text chain reports (Requirement 14.8). The two are different sentences with different
 * statuses, and the transcribe chain has one member, so the branch that tells them apart is
 * `EXHAUSTED_CHAIN_CODE` rather than a count of members. Included here because it is the third way
 * a transcript can fail to reach the answerer, and because "no chat call was made" has to hold for
 * it too.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const VOICE_BUCKET = STORAGE_BUCKETS.voiceMessages;

const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const FARMER_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const ANSWER_MESSAGE_ID = '66666666-6666-4666-8666-666666666666';

/** 2026-09-15T19:30:00Z. Fixed, so the run owns its clock and never reads the wall clock. */
const NOW_MS = Date.parse('2026-09-15T19:30:00.000Z');

/**
 * क़ — U+0958, whose canonical decomposition NFC does not recompose (Unicode composition
 * exclusions). Its presence is what makes "the transcript was not normalized" observable.
 */
const NFC_UNSTABLE = '\u0958';

/** Devanagari clauses a farmer might actually speak, in Hindi and Marathi. */
const DEVANAGARI_CLAUSES: readonly string[] = [
  `मेरे टमाटर के पत्तों पर भूरे धब़्बे हैं${NFC_UNSTABLE}`,
  `नीचे के पत्ते सूखकर गिर रहे हैं ${NFC_UNSTABLE}`,
  `बटाट्याच्या पानांवर काळे ठिपके दिसत आहेत ${NFC_UNSTABLE}`,
  `कोणते औषध फवारावे ${NFC_UNSTABLE}`,
];

const LATIN_CLAUSES: readonly string[] = [
  'my tomato leaves have brown spots near the ground',
  'the lower leaves are drying and dropping',
  'what should I spray, and how soon',
];

/** Whitespace runs, including the non-breaking space `trim()` also removes. */
const WHITESPACE_RUNS: readonly string[] = [' ', '  ', '\t', '\n', '\r\n', '\u00a0', ' \t\n '];

/* ========================================================================== */
/* The transcript shapes                                                       */
/* ========================================================================== */

/**
 * Every shape the generator produces, enumerated so the run can prove it produced each one.
 *
 * A property over a `oneof` can pass while a branch never generates, and an expectation stated for
 * a branch that never ran is green rather than absent.
 */
const SHAPES = [
  /** Latin script, one line. The plain case. */
  'latin',
  /** Devanagari, carrying the NFC-unstable code point. */
  'devanagari',
  /** Devanagari and Latin in one transcript, which is how a farmer names a pesticide. */
  'mixed_script',
  /** Newlines inside the transcript. */
  'multiline',
  /** Leading and trailing whitespace — Whisper's own leading space, exaggerated. */
  'surrounding_whitespace',
  /** ~1.5 kB across several lines: the truncation probe. */
  'long',
  /** Whitespace only — Requirement 8.7's branch, reached by the `trim()` predicate. */
  'whitespace_only',
  /** `''` — Requirement 8.7's branch, reached literally. */
  'empty',
  /** The transcribe chain is exhausted — Requirement 8.4's own code. */
  'provider_failed',
] as const;

type Shape = (typeof SHAPES)[number];

/** Which of the three outcomes a shape must produce. The coverage set ranges over these too. */
type Outcome = 'answered' | 'transcript_empty' | 'transcription_failed';

function outcomeOf(shape: Shape): Outcome {
  if (shape === 'provider_failed') return 'transcription_failed';
  return shape === 'empty' || shape === 'whitespace_only' ? 'transcript_empty' : 'answered';
}

interface Scenario {
  readonly shape: Shape;
  readonly language: Language;
  readonly channel: Channel;
  readonly userId: string;
  readonly objectId: string;
  readonly container: string;
  readonly durationSeconds: number;
  /** `VP18-1A2B` — a token present in no fixture but the transcript under test. */
  readonly marker: string;
  readonly clauseIndex: number;
  readonly lineCount: number;
  readonly leading: string;
  readonly trailing: string;
  readonly whitespaceRun: string;
  /** 429 or 503 — both fallback triggers under V11, on a chain with no fallback. */
  readonly failureStatus: number;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  shape: fc.constantFrom<Shape>(...SHAPES),
  language: fc.constantFrom<Language>(...SUPPORTED_LANGUAGES),
  channel: fc.constantFrom<Channel>('web', 'whatsapp'),
  userId: fc.uuid(),
  objectId: fc.uuid(),
  /** V10's accepted list, so the pre-flight container guard passes on what a recorder produces. */
  container: fc.constantFrom(...TRANSCRIBE_ACCEPTED_CONTAINERS),
  /**
   * Inside Requirement 8.2's 120 s and above V10's transcribable minimum, because this property is
   * about what happens to a transcript rather than about admission (Property 3's claim).
   */
  durationSeconds: fc
    .integer({ min: 10, max: MAX_AUDIO_SECONDS * 10 })
    .map((tenths) => tenths / 10),
  marker: fc.integer({ min: 0x1000, max: 0xffff }).map((raw) => `VP18-${raw.toString(16).toUpperCase()}`),
  clauseIndex: fc.integer({ min: 0, max: 100 }),
  lineCount: fc.integer({ min: 2, max: 4 }),
  leading: fc.constantFrom(...WHITESPACE_RUNS),
  trailing: fc.constantFrom(...WHITESPACE_RUNS),
  whitespaceRun: fc.constantFrom(...WHITESPACE_RUNS),
  failureStatus: fc.constantFrom(RATE_LIMIT_STATUS, UNAVAILABLE_STATUS),
});

/** One clause from a list, by a generated index that cannot fall off the end. */
function clauseAt(clauses: readonly string[], index: number): string {
  const clause = clauses[index % clauses.length];
  if (clause === undefined) throw new Error('the clause fixture list is empty');
  return clause;
}

/**
 * The exact string the provider will return.
 *
 * Built here rather than read back out of the request, so the assertions compare the service's
 * output against a value this file owns.
 */
function transcriptFor(scenario: Scenario): string {
  const { marker, shape, clauseIndex, lineCount } = scenario;
  const devanagari = clauseAt(DEVANAGARI_CLAUSES, clauseIndex);
  const latin = clauseAt(LATIN_CLAUSES, clauseIndex);

  switch (shape) {
    case 'latin':
      return `${marker} ${latin}.`;
    case 'devanagari':
      return `${marker} ${devanagari}।`;
    case 'mixed_script':
      return `${marker} ${devanagari} — ${latin} (Mancozeb 75% WP).`;
    case 'multiline':
      return [`${marker} ${devanagari}।`, latin, clauseAt(DEVANAGARI_CLAUSES, clauseIndex + 1)].join(
        '\n',
      );
    case 'surrounding_whitespace':
      return `${scenario.leading}${marker} ${devanagari}।${scenario.trailing}`;
    case 'long': {
      const lines: string[] = [`${marker} ${devanagari}।`];
      while (lines.join('\n').length < 1500) {
        lines.push(`${clauseAt(DEVANAGARI_CLAUSES, lines.length)} ${clauseAt(LATIN_CLAUSES, lines.length)}.`);
      }
      return lines.join('\n');
    }
    case 'whitespace_only':
      return scenario.whitespaceRun.repeat(lineCount);
    case 'empty':
      return '';
    case 'provider_failed':
      /** Never returned — the seam rejects instead. Present so the switch stays exhaustive. */
      return '';
  }
}

/* ========================================================================== */
/* The harness — every seam injected                                           */
/* ========================================================================== */

/**
 * A tripwire, not a stand-in: every seam is injected, so a read of the request client means the
 * service reached past its dependencies and nothing recorded below can be trusted.
 */
const unreachableSupabase = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `the request client was used (read of "${String(property)}"); every seam must be injected`,
      );
    },
  },
) as unknown as SupabaseClient<Database>;

/**
 * Fails the run if the nested chat call reserves anything of its own.
 *
 * The chat stub hands the coverage it was given to the **real** `reserveForRequest()`, which
 * performs no RPC at all on a `covered` context. So this object is untouched on the correct path,
 * and a nested reserve surfaces as a thrown error rather than as an invisible second unit. That is
 * Requirement 14.1 and Property 20's business; here it is a guard that keeps the chat stub honest.
 */
const unreachableRpc: CounterRpc = {
  tryIncrement: () => {
    throw new Error('the nested chat call reserved a unit of its own (Requirement 14.1)');
  },
  decrement: () => {
    throw new Error('the nested chat call refunded a unit of its own');
  },
  used: () => {
    throw new Error('the nested chat call read the counter');
  },
};

interface Recorded {
  /** Every nested chat call, in order. Exactly one on the answered path, none on the other two. */
  readonly chatCalls: { readonly input: ChatInput; readonly coverage: QuotaContext }[];
  /** Object paths handed to `remove()`. Empty means the recording was retained. */
  readonly removed: string[];
  readonly usage: TablesInsert<'usage_logs'>[];
}

interface Harness {
  readonly deps: VoiceDeps;
  readonly recorded: Recorded;
  readonly providers: ProviderStubs;
}

function harness(scenario: Scenario, transcript: string): Harness {
  const recorded: Recorded = { chatCalls: [], removed: [], usage: [] };

  const payload: TranscriptionPayload = {
    text: transcript,
    language: scenario.language,
    duration: scenario.durationSeconds,
    no_speech_prob: transcript.trim() === '' ? 0.94 : 0.01,
    avg_logprob: -0.21,
  };

  const providers = providerStubs({
    transcription: payload,
    ...(scenario.shape === 'provider_failed'
      ? { transcriptionRejection: providerRejection(scenario.failureStatus, { 'retry-after': '9' }) }
      : {}),
  });

  const storage: ObjectRemoveClient & StorageClientLike = {
    storage: {
      from: () => ({
        exists: () => Promise.resolve({ data: true, error: null }),
        createSignedUrl: (path: string) =>
          Promise.resolve({
            data: { signedUrl: `https://storage.test/${path}?token=abc` },
            error: null,
          }),
        remove: (paths: string[]) => {
          recorded.removed.push(...paths);
          return Promise.resolve({ data: paths, error: null });
        },
      }),
    },
  };

  /**
   * `ChatService`, doing the one thing this property needs it to do: record what it was handed.
   *
   * It answers with content that carries **no part of the transcript**, so "the response returns
   * both the transcript and the answer" cannot be satisfied by the answer happening to quote the
   * question.
   */
  const chat: ChatAnswerer = async (input, coverage) => {
    recorded.chatCalls.push({ input, coverage });
    const reserved = await reserveForRequest(coverage, { rpc: unreachableRpc });
    if (reserved.outcome === 'at_limit') throw new Error('the nested chat call was declined');

    const outcome: NestedChatOutcome = {
      conversationId: input.conversationId,
      farmerMessageId: FARMER_MESSAGE_ID,
      answer: {
        messageId: ANSWER_MESSAGE_ID,
        content: 'Early blight. Remove the affected lower leaves and water at the base.',
        language: input.language,
        groundedIn: ['Tomato Early Blight'],
        needsExpert: false,
      },
      quota: quotaStatusOf(reserved.reservation),
    };
    return outcome;
  };

  const store: VoiceStore = {
    insertUsageLog: (row) => {
      recorded.usage.push(row);
      return Promise.resolve();
    },
  };

  const rpc: CounterRpc = {
    tryIncrement: () => Promise.resolve(1),
    decrement: () => Promise.resolve(0),
    used: () => Promise.resolve(0),
  };

  return {
    recorded,
    providers,
    deps: {
      supabase: unreachableSupabase,
      chat,
      storage,
      deleter: storage,
      store,
      transcribe: providers.transcribe,
      quota: { rpc, now: new Date(NOW_MS) },
      now: () => NOW_MS,
      // `getDeadline()` answers `undefined` outside a platform invocation; stating it keeps the run
      // independent of whether the process happens to be inside one.
      platformDeadline: () => undefined,
    },
  };
}

function voiceInputFor(scenario: Scenario): VoiceInput {
  const path = `${scenario.userId}/2026/09/${scenario.objectId}.${scenario.container}`;
  const storageRef: StorageRef = { bucket: VOICE_BUCKET, path };
  return {
    userId: scenario.userId,
    storageRef,
    language: scenario.language,
    channel: scenario.channel,
    conversationId: CONVERSATION_ID,
    durationSeconds: scenario.durationSeconds,
  };
}

async function rejection(run: Promise<unknown>, label: string): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error(`${label}: expected the call to reject, and it resolved`);
}

/* ========================================================================== */
/* Property 18                                                                 */
/* ========================================================================== */

describe('Property 18: the voice pipeline preserves the transcript and handles an empty one', () => {
  it('hands every non-empty transcript to the chat service unaltered, and answers an empty one instead of forwarding it', async () => {
    const shapesSeen = new Set<Shape>();
    const outcomesSeen = new Set<Outcome>();
    const languagesSeen = new Set<Language>();
    const channelsSeen = new Set<Channel>();

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { shape, language, channel } = scenario;
        const expected = outcomeOf(shape);

        shapesSeen.add(shape);
        outcomesSeen.add(expected);
        languagesSeen.add(language);
        channelsSeen.add(channel);

        const transcript = transcriptFor(scenario);
        const input = voiceInputFor(scenario);
        const test = harness(scenario, transcript);
        const label = `${shape} / ${language} / ${channel}`;

        /* ================================================================== */
        /* The answered path (Requirements 8.4, 8.6)                           */
        /* ================================================================== */

        if (expected === 'answered') {
          const outcome = await transcribeAndAnswer(input, test.deps);

          // One transcription round trip, one nested answer. Nothing was retried and nothing
          // answered twice.
          expect(test.providers.calls.transcription, label).toHaveLength(1);
          expect(test.recorded.chatCalls, label).toHaveLength(1);

          const call = test.recorded.chatCalls[0];
          if (call === undefined) throw new Error(`${label}: the chat seam recorded no call`);

          /* ── Requirement 8.4: THE EXACT TEXT, as the farmer message ────── */
          expect(call.input.message, `${label}: the transcript was altered on the way to the chat service`).toBe(
            transcript,
          );
          // Code point by code point, so a failure report names where it diverged rather than
          // printing 1.5 kB twice.
          expect([...call.input.message], label).toStrictEqual([...transcript]);

          // A normalizing step anywhere on this path would have changed the string: every
          // Devanagari fixture carries a code point NFC does not leave alone.
          if (transcript.includes(NFC_UNSTABLE)) {
            expect(transcript.normalize('NFC'), `${label}: the fixture is already NFC-stable`).not.toBe(
              transcript,
            );
            expect(call.input.message, label).toContain(NFC_UNSTABLE);
          }

          // It arrived as a farmer message from the voice channel, pointing at the recording.
          expect(call.input.inputKind, label).toBe('voice');
          expect(call.input.transcriptOf, label).toBe(input.storageRef.path);
          expect(call.input.language, label).toBe(language);
          expect(call.input.channel, label).toBe(channel);
          expect(call.input.conversationId, label).toBe(CONVERSATION_ID);

          /* ── Requirement 8.6: BOTH the transcript and the text answer ──── */
          expect(outcome.transcript, label).toBe(transcript);
          expect(outcome.answer.messageId, label).toBe(ANSWER_MESSAGE_ID);
          expect(outcome.answer.content.trim().length, label).toBeGreaterThan(0);
          expect(outcome.answer.language, label).toBe(language);

          // The pair is present together in exactly the shape `/api/voice` serializes, so a route
          // cannot return one without the other.
          const wire = voiceResponseSchema.safeParse({
            transcript: outcome.transcript,
            answer: outcome.answer,
            conversationId: outcome.conversationId,
            quota: outcome.quota,
          });
          expect(wire.success, `${label}: the outcome is not a voice response`).toBe(true);
          expect(wire.success ? wire.data.transcript : '', label).toBe(transcript);

          // The answer is not a copy of the question, so the equality above is a real comparison
          // rather than one satisfied by an echo.
          expect(outcome.answer.content.includes(scenario.marker), label).toBe(false);

          // Requirement 8.8 — text only. No audio field exists to return, and the recording is
          // gone (8.9), which is the observable contrast with the two branches below.
          expect(outcome.audio.outcome, label).toBe('deleted');
          expect(test.recorded.removed, label).toStrictEqual([input.storageRef.path]);
          return;
        }

        /* ================================================================== */
        /* Requirement 8.7 — an empty transcript is its own outcome            */
        /* ================================================================== */

        const error = await rejection(transcribeAndAnswer(input, test.deps), label);

        if (expected === 'transcript_empty') {
          expect(error.code, label).toBe('TRANSCRIPT_EMPTY');
          expect(error.status, label).toBe(ERROR_SPECS.TRANSCRIPT_EMPTY.status);
          // Retryable, because the farmer can act: record again somewhere quieter.
          expect(error.retryable, label).toBe(true);

          // The sentence the API layer returns is the one Requirement 8.7 asks for, in the
          // request's own language.
          const envelope = toEnvelope(error, language);
          expect(envelope.error.message, label).toBe(messages(language).errors.TRANSCRIPT_EMPTY);
          expect(envelope.error.language, label).toBe(language);

          // Which of the two empty shapes it was is recorded server-side only.
          expect(error.context?.reason, label).toBe(
            transcript === '' ? 'provider_returned_empty' : 'provider_returned_whitespace',
          );
        } else {
          // Requirement 8.4's own code for a failed transcription — 502 and retryable over the
          // same object, and NOT the busy message an exhausted vision or text chain reports.
          expect(error.code, label).toBe('TRANSCRIPTION_FAILED');
          expect(error.code, label).toBe(EXHAUSTED_CHAIN_CODE.transcribe);
          expect(error.code, label).not.toBe('PROVIDERS_UNAVAILABLE');
          expect(error.status, label).toBe(ERROR_SPECS.TRANSCRIPTION_FAILED.status);
          expect(error.retryable, label).toBe(true);

          const envelope = toEnvelope(error, language);
          expect(envelope.error.message, label).toBe(messages(language).errors.TRANSCRIPTION_FAILED);
          expect(envelope.error.message, `${label}: the two provider outcomes read alike`).not.toBe(
            messages(language).errors.PROVIDERS_UNAVAILABLE,
          );
        }

        /* ── The negative half: nothing was answered ─────────────────────── */

        // No blank question reached the chat service...
        expect(test.recorded.chatCalls, `${label}: a chat answer was produced anyway`).toHaveLength(0);
        // ...and no provider call happened after the transcription attempt. One round trip on the
        // empty branch, one on the failed one — the transcribe chain has a single member.
        expect(providerCallCount(test.providers.calls), label).toBe(1);
        expect(test.providers.calls.geminiText, label).toHaveLength(0);
        expect(test.providers.calls.groqChat, label).toHaveLength(0);

        // Requirement 8.10 — no transcript was persisted, so the recording is retained. The
        // contrast with the answered path's `remove()` is what makes "its own case" observable.
        expect(test.recorded.removed, label).toStrictEqual([]);
      }),
      // 300 runs over nine shapes, three languages and two channels: every cell of the grid is
      // reached many times rather than probably.
      { numRuns: 300 },
    );

    /* ---------------------------------------------------------------------- */
    /* Non-vacuity: every shape and every outcome was actually generated       */
    /* ---------------------------------------------------------------------- */

    expect([...shapesSeen].sort()).toStrictEqual([...SHAPES].sort());
    expect([...outcomesSeen].sort()).toStrictEqual([
      'answered',
      'transcript_empty',
      'transcription_failed',
    ]);
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
    expect([...channelsSeen].sort()).toStrictEqual(['web', 'whatsapp']);
  });
});
