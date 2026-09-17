import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, STORAGE_BUCKETS } from '@/lib/config/verified';
import { isAppError, toEnvelope, type AppError } from '@/lib/errors';
import { knowledgeReaderFrom } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import type { Language, StorageRef, VerifiedCondition, VoiceInput } from '@/lib/schemas';
import { dayWindowKey } from '@/lib/time';
import { chatAnswerer, chatWriteStoreFrom } from '@/services/chat.service';
import { diagnose, diagnosisStoreFrom } from '@/services/diagnosis.service';
import type { CounterRpc } from '@/services/quota.service';
import {
  transcribeAndAnswer,
  voiceStoreFrom,
  type ChatAnswerer,
  type VoiceDeps,
  type VoiceOutcome,
} from '@/services/voice.service';
import type { DiseaseKnowledgeRow, UsageLogRow } from '@/types/database';

import { TEST_DATABASE_URL_VAR, describeIntegration } from './database';
import { knowledgeRow, startHarness, type Harness } from './harness';
import { uploadedImage, uploadedRecording } from './objects';
import {
  CLASSIFICATIONS,
  DEFAULT_TRANSCRIPTION,
  RATE_LIMIT_STATUS,
  classificationText,
  echoingRephrase,
  providerCallCount,
  providerRejection,
  type EchoingRephrase,
  type TranscriptionPayload,
} from './providers';

/**
 * The voice path, scenario by scenario, against a real database.
 *
 * Requirements: 8.2 (up to 120 seconds and up to 10 MB), 8.3 (a recording over either limit is
 *               declined, stating both limits), 8.7 (an empty transcript asks the Farmer to record
 *               again somewhere quieter) — and, because every scenario passes through them: 8.4 (the
 *               transcript is passed to the Chat_Service as a Farmer message), 8.5 (the input
 *               language is supplied to the Transcription_Provider), 8.6 (the transcript **and** the
 *               answer come back together), 8.9 / 8.10 / 8.11 (the recording is deleted after a
 *               persisted transcript, retained otherwise, and only ever under the Farmer's own
 *               prefix), 14.1 (one voice message spends one voice unit and no chat unit), 14.5 /
 *               14.6 (the busy message and the audit row), 13.2 (RLS), 17.5
 * Design: "Integration tests — mocked providers, real Postgres"; "Voice sequence"; D10
 *
 * =============================================================================
 * WHAT MAKES THESE SCENARIOS AND NOT UNIT TESTS
 * =============================================================================
 *
 * `src/services/voice.service.test.ts` drives each branch with stubs. The four claims below need
 * more than that:
 *
 *  - **Requirement 8.9's precondition is a committed row.** "WHEN the API_Layer has persisted a
 *    transcript as a Message" is the trigger for the delete, and the only evidence the service has is
 *    the `farmerMessageId` the nested `ChatService` returned. Here that id comes from a real insert
 *    under a real policy, so "the transcript is durable, therefore the recording is gone" is checked
 *    end to end rather than asserted about a stub's return value.
 *  - **Requirement 14.1's nesting rule is two real counters.** One voice message must leave the
 *    `voice` counter one higher and the `chat` counter untouched, and that is `counter_try_increment`
 *    from `0007` twice — a boolean in a stubbed quota service cannot show it.
 *  - **Requirement 8.7's branch has to be distinguishable from a provider failure.** Both raise, both
 *    retain the object; what tells them apart is `usage_logs.outcome` (`inconclusive` versus
 *    `provider_error`) on an append-only table only the service role can write.
 *  - **The transcript reaches the conversation verbatim.** `messages.content` is where that is
 *    observable, and the padded-transcript scenario below is what makes "the trim is only a
 *    predicate, never the transcript" a fact about a stored row.
 *
 * The transcription provider is stubbed at the **adapter seam** (`GroqTranscribeOptions.create`), so
 * the real gateway, the real `groq.ts` request body, the real container guard and the real V11 error
 * classification all run — see `tests/integration/providers.ts` for why the seam is not higher.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const LANGUAGE: Language = 'en';
const CLASSIFIED = CLASSIFICATIONS.tomatoEarlyBlight;
const CONDITION: VerifiedCondition = CLASSIFIED.disease_name;

/**
 * The quota window every reserve in this file lands in. Pinned and in the past, for the reason
 * `QuotaOptions.now` exists — see the same note in `idempotency.test.ts`. This file makes six voice
 * reserves against a limit of twenty.
 */
const QUOTA_INSTANT = new Date(Date.UTC(1970, 0, 15, 12, 0, 0));

/** A short recording: the ordinary case, and the duration V10's `verbose_json` reports back. */
const SHORT_SECONDS = DEFAULT_TRANSCRIPTION.duration ?? 6.4;

/**
 * A transcript of a noisy recording: **non-empty, and padded**.
 *
 * The padding is the point. `transcribeAndAnswer` decides emptiness with `trim() === ''` and then
 * hands `result.text` onward *unchanged*, so a transcript Jamee has quietly tidied would be a farmer
 * message Jamee edited. Keeping the spaces makes the difference between the predicate and the value
 * observable in `messages.content`.
 *
 * It also carries no crop vocabulary, which is what makes the second half of that scenario real: a
 * noisy transcript in a thread with no diagnosis has no subject, so Jamee refers rather than
 * inventing — and the recording is still deleted, because a transcript *was* persisted.
 */
const NOISY_TRANSCRIPTION: TranscriptionPayload = {
  text: '  hmm ... aah ... hmm  ',
  language: 'en',
  duration: 4.2,
  // V10 surfaces this precisely because it separates "the farmer recorded silence" from "the
  // provider produced nothing". High here, and the transcript is still non-empty.
  no_speech_prob: 0.74,
  avg_logprob: -1.1,
};

/** V10's empty-transcript payload: a **successful** provider call that produced no words. */
const EMPTY_TRANSCRIPTION: TranscriptionPayload = {
  text: '',
  language: 'en',
  duration: 3.1,
  no_speech_prob: 0.98,
  avg_logprob: -1.9,
};

/** Whitespace only — Requirement 8.7's other spelling, and the reason the predicate trims. */
const WHITESPACE_TRANSCRIPTION: TranscriptionPayload = {
  ...EMPTY_TRANSCRIPTION,
  text: ' \n\t ',
};

describeIntegration(`voice scenarios (requires ${TEST_DATABASE_URL_VAR})`, () => {
  let harness: Harness;
  let rpc: CounterRpc;
  let rephrase: EchoingRephrase;
  let row: DiseaseKnowledgeRow;
  /** The conversation the opening diagnosis created — a voice question here has a subject. */
  let conversationId: string;
  /** A second thread with no diagnosis, for the noisy-transcript referral. */
  let emptyConversationId: string;
  /** One entry per nested `ChatService` invocation. Requirement 8.7 must produce none. */
  const chatCalls: string[] = [];

  beforeAll(async () => {
    rephrase = echoingRephrase();
    harness = await startHarness({
      providers: { vision: classificationText(CLASSIFIED), text: rephrase.text },
    });
    if (harness.quota.rpc === undefined) {
      throw new Error('the harness did not bind a counter RPC, so no spend claim is checkable');
    }
    rpc = harness.quota.rpc;
    row = knowledgeRow(harness, CONDITION);

    // The Diagnosis_Result a voice follow-up resolves against, written by the real service.
    const diagnosed = await diagnose(
      {
        userId: harness.farmerA.id,
        storageRef: uploadedImage(harness.objects, harness.farmerA.id),
        language: LANGUAGE,
        channel: 'web',
      },
      {
        supabase: harness.farmerA.client,
        storage: harness.objects,
        store: diagnosisStoreFrom(harness.farmerA.client, harness.admin),
        knowledge: knowledgeReaderFrom(harness.farmerA.client),
        models: harness.providers.models,
        quota: { rpc, now: QUOTA_INSTANT },
      },
    );
    if (diagnosed.result.status !== 'identified') {
      throw new Error(
        `the opening diagnosis was ${diagnosed.result.status}, so no voice question in this file has ` +
          'a subject to resolve against. Every failure here would be a consequence of that.',
      );
    }
    conversationId = diagnosed.conversationId;

    const empty = await harness.admin
      .from('conversations')
      .insert({ user_id: harness.farmerA.id, channel: 'web' })
      .select('id')
      .single();
    if (empty.error !== null || empty.data === null) {
      throw new Error(`could not create the diagnosis-free conversation: ${empty.error?.message}`);
    }
    emptyConversationId = empty.data.id;
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  /* ====================================================================== */
  /* Wiring and shared assertions                                           */
  /* ====================================================================== */

  /**
   * The nested `ChatService`, bound to farmer A's own session and counted.
   *
   * Counted rather than stubbed: Requirement 8.7's branch must reach **no** chat call, and the only
   * honest way to check that is to record every real invocation and assert the count did not move.
   * The service inside is the real `chatTurn` — the same one the web and WhatsApp text paths use
   * (Requirement 16.2) — so the answer, the writes and the coverage are all real.
   */
  function countingChat(): ChatAnswerer {
    const answer = chatAnswerer({
      supabase: harness.farmerA.client,
      writes: chatWriteStoreFrom(harness.farmerA.client, harness.admin),
      knowledge: knowledgeReaderFrom(harness.farmerA.client),
      models: harness.providers.models,
      quota: { rpc, now: QUOTA_INSTANT },
    });
    return (input, coverage) => {
      chatCalls.push(`chat:${input.conversationId}`);
      return answer(input, coverage);
    };
  }

  function voiceDeps(): VoiceDeps {
    return {
      supabase: harness.farmerA.client,
      chat: countingChat(),
      storage: harness.objects,
      /**
       * Requirement 8.11's client, passed explicitly. The default is `createAdminClient()`, which
       * would aim the delete at the real bucket and make the disposition an accident of whether an
       * object with that path happened to exist there. The harness store satisfies
       * `ObjectRemoveClient` directly, since `objects.ts` folded `remove()` into `storage.from()`.
       */
      deleter: harness.objects,
      store: voiceStoreFrom(harness.admin),
      transcribe: harness.providers.transcribe,
      quota: { rpc, now: QUOTA_INSTANT },
    };
  }

  /** One recording of farmer A's, present in `voice-messages` and owned by them. */
  function recording(): StorageRef {
    return uploadedRecording(harness.objects, harness.farmerA.id);
  }

  function speak(
    input: Omit<VoiceInput, 'userId' | 'language' | 'channel'>,
  ): Promise<VoiceOutcome> {
    return transcribeAndAnswer(
      { userId: harness.farmerA.id, language: LANGUAGE, channel: 'web', ...input },
      voiceDeps(),
    );
  }

  /** The error a refused or failed request raised, as an `AppError`. */
  async function refusalOf(call: Promise<unknown>): Promise<AppError> {
    try {
      await call;
    } catch (error) {
      if (isAppError(error)) return error;
      throw error;
    }
    throw new Error('the request was expected to be refused and was not');
  }

  function unitsUsed(operation: 'voice' | 'chat'): Promise<number> {
    return rpc.used({
      userId: harness.farmerA.id,
      operation,
      windowKind: 'day',
      windowKey: dayWindowKey(QUOTA_INSTANT),
    });
  }

  /** Every `voice` audit row for this farmer, read with their own session (migration 0006). */
  async function voiceAudit(): Promise<readonly UsageLogRow[]> {
    const { data, error } = await harness.farmerA.client
      .from('usage_logs')
      .select('*')
      .eq('operation', 'voice');

    expect(error).toBeNull();
    return data ?? [];
  }

  /** Requirements 13.1 / 13.2 — the owner reads the row and the other farmer reads nothing. */
  async function expectMessageVisibleToOwnerOnly(id: string): Promise<void> {
    const mine = await harness.farmerA.client.from('messages').select('id').eq('id', id);
    const theirs = await harness.farmerB.client.from('messages').select('id').eq('id', id);
    const serviceRole = await harness.admin.from('messages').select('id').eq('id', id);

    expect(mine.error).toBeNull();
    expect(mine.data).toHaveLength(1);
    expect(theirs.error).toBeNull();
    expect(theirs.data).toEqual([]);
    expect(serviceRole.data).toHaveLength(1);
  }

  /**
   * The farmer message a transcript became (Requirements 8.4, 7.4): the transcript verbatim, marked
   * as voice, and carrying the path it came from.
   */
  async function expectTranscriptMessage(
    outcome: VoiceOutcome,
    ref: StorageRef,
    transcript: string,
  ): Promise<void> {
    const stored = await harness.farmerA.client
      .from('messages')
      .select('content, role, input_kind, transcript_of, conversation_id, channel')
      .eq('id', outcome.farmerMessageId)
      .single();

    expect(stored.error).toBeNull();
    // Verbatim, padding and all. The trim in the service is a predicate, never the value.
    expect(stored.data?.content).toBe(transcript);
    expect(stored.data?.role).toBe('farmer');
    expect(stored.data?.input_kind).toBe('voice');
    // Requirement 8.9's provenance column, which by design usually points at an object already gone.
    expect(stored.data?.transcript_of).toBe(ref.path);
    expect(stored.data?.conversation_id).toBe(outcome.conversationId);
    expect(stored.data?.channel).toBe('web');

    await expectMessageVisibleToOwnerOnly(outcome.farmerMessageId);
  }

  /** The transcription request the adapter composed — Requirements 8.5 and 2.8 at the seam. */
  function expectTranscribeRequest(ref: StorageRef): void {
    const request = harness.providers.calls.transcription.at(-1);
    expect(request).toBeDefined();
    // Requirement 8.5 — the input language is always supplied; V10 records that it improves both
    // accuracy and latency, so its absence would be a silent quality regression.
    expect(request?.language).toBe(LANGUAGE);
    // A Signed_URL for the farmer's own object, never the bytes.
    expect(request?.url ?? '').toContain('/object/sign/');
    expect(request?.url ?? '').toContain(ref.path);
    expect(request?.response_format).toBe('verbose_json');
  }

  /* ====================================================================== */
  /* A short recording — the ordinary path                                  */
  /* ====================================================================== */

  describe('a short recording', () => {
    it('returns the transcript and an answer, spends one voice unit, and deletes the original', async () => {
      harness.providers.script.transcription = DEFAULT_TRANSCRIPTION;
      const ref = recording();
      const voiceBefore = await unitsUsed('voice');
      const chatBefore = await unitsUsed('chat');
      const callsBefore = providerCallCount(harness.providers.calls);
      const chatCallsBefore = chatCalls.length;

      const outcome = await speak({
        storageRef: ref,
        conversationId,
        durationSeconds: SHORT_SECONDS,
        mimeType: 'audio/webm;codecs=opus',
      });

      // Requirement 8.6 — the transcript AND the answer, together, from one call. Verbatim, which is
      // Requirement 8.4's "as a Farmer message" taken literally.
      expect(outcome.transcript).toBe(DEFAULT_TRANSCRIPTION.text);
      expect(outcome.answer.content.trim()).not.toBe('');
      expect(outcome.conversationId).toBe(conversationId);
      expect(outcome.provider).toBe('groq');
      expect(outcome.usedFallback).toBe(false);

      expectTranscribeRequest(ref);
      await expectTranscriptMessage(outcome, ref, DEFAULT_TRANSCRIPTION.text);

      // The answer is grounded: the transcript names a tomato, so scope resolution found rows and the
      // nested chat turn made one model call. Two provider round trips for the request — one
      // transcription, one rephrase.
      expect(outcome.answer.groundedIn.length).toBeGreaterThan(0);
      expect(providerCallCount(harness.providers.calls)).toBe(callsBefore + 2);
      expect(chatCalls.length).toBe(chatCallsBefore + 1);

      // Requirement 14.1's nesting rule, from the counter functions rather than the envelope (D10):
      // one voice unit, and the chat answer inside it spent none.
      expect(await unitsUsed('voice')).toBe(voiceBefore + 1);
      expect(await unitsUsed('chat')).toBe(chatBefore);
      expect(outcome.quota.operation).toBe('voice');

      // Requirements 8.9 / 8.11 — the transcript is durable, so the recording is gone, and the delete
      // was aimed at the voice bucket under this farmer's own prefix.
      expect(outcome.audio).toEqual({ outcome: 'deleted' });
      expect(harness.objects.has(ref)).toBe(false);
      const removal = harness.objects.removed.at(-1);
      expect(removal?.bucket).toBe(STORAGE_BUCKETS.voiceMessages);
      expect(removal?.paths).toEqual([ref.path]);
      expect(ref.path.startsWith(`${harness.farmerA.id}/`)).toBe(true);

      const audit = await voiceAudit();
      const latest = audit.filter((entry) => entry.conversation_id === conversationId);
      expect(latest.length).toBeGreaterThan(0);
      expect(latest.every((entry) => entry.channel === 'web')).toBe(true);
      expect(latest.some((entry) => entry.outcome === 'success' && entry.quota_spent)).toBe(true);
    });
  });

  /* ====================================================================== */
  /* The 120-second and 10 MB boundaries — Requirements 8.2, 8.3            */
  /* ====================================================================== */

  describe('the duration and size limits', () => {
    it('accepts a recording exactly at the 120 second boundary', async () => {
      harness.providers.script.transcription = DEFAULT_TRANSCRIPTION;
      const ref = recording();
      const before = await unitsUsed('voice');

      // Requirement 8.2 says "up to 120 seconds", so the boundary is inclusive and this is the case
      // that pins which side of it the check falls on. `MAX_AUDIO_SECONDS` is read from
      // `config/verified.ts` rather than written as `120`, so the assertion cannot outlive a change
      // to the limit.
      expect(MAX_AUDIO_SECONDS).toBe(120);
      const outcome = await speak({
        storageRef: ref,
        conversationId,
        durationSeconds: MAX_AUDIO_SECONDS,
        bytes: MAX_AUDIO_BYTES,
      });

      expect(outcome.transcript).toBe(DEFAULT_TRANSCRIPTION.text);
      expect(await unitsUsed('voice')).toBe(before + 1);
      // The size ceiling is inclusive on the same reading, and both bounds were exercised by this one
      // request — `MAX_AUDIO_BYTES` was forwarded to the adapter as V10's own floor.
      expect(MAX_AUDIO_BYTES).toBe(10 * 1024 * 1024);
      await expectTranscriptMessage(outcome, ref, DEFAULT_TRANSCRIPTION.text);
      expect(outcome.audio).toEqual({ outcome: 'deleted' });
    });

    it('declines one second past the boundary, states both limits, and spends nothing', async () => {
      const ref = recording();
      const voiceBefore = await unitsUsed('voice');
      const callsBefore = providerCallCount(harness.providers.calls);
      const removalsBefore = harness.objects.removed.length;
      const auditBefore = (await voiceAudit()).length;

      const error = await refusalOf(
        speak({ storageRef: ref, conversationId, durationSeconds: MAX_AUDIO_SECONDS + 1 }),
      );

      // Requirement 8.3's own code, and the sentence a farmer reads states **both** limits — the
      // catalog fills them from `config/verified.ts`, so the message cannot quote a limit the check
      // did not use.
      expect(error.code).toBe('AUDIO_TOO_LONG');
      const message = toEnvelope(error, LANGUAGE).error.message;
      expect(message).toContain(String(MAX_AUDIO_SECONDS));
      expect(message).toContain('10');

      // Refused **before** the reserve and before the provider, so nothing was spent and there is no
      // refund to make.
      expect(await unitsUsed('voice')).toBe(voiceBefore);
      expect(providerCallCount(harness.providers.calls)).toBe(callsBefore);
      /**
       * And no audit row, which is deliberate rather than an oversight: `assertAdmissibleAudio` runs
       * at step 2, above every `log()` call in the pipeline, and `usage_logs.outcome` has no value
       * meaning "the request was inadmissible". The refusal is a 400 the route reports; recording it
       * as a `provider_error` or an `inconclusive` would put a failure or a served-but-unjudgeable
       * request in the trail, and neither happened.
       */
      expect((await voiceAudit()).length).toBe(auditBefore);

      // Requirement 8.10's disposition by another route: no transcript was persisted, so the object
      // waits for its Retention_Window. No delete was even attempted.
      expect(harness.objects.has(ref)).toBe(true);
      expect(harness.objects.removed.length).toBe(removalsBefore);
    });

    it('declines one byte past the size ceiling with the size code, not the duration one', async () => {
      const ref = recording();
      const before = await unitsUsed('voice');

      const error = await refusalOf(
        speak({
          storageRef: ref,
          conversationId,
          durationSeconds: SHORT_SECONDS,
          bytes: MAX_AUDIO_BYTES + 1,
        }),
      );

      // Requirement 8.2's other half. A short recording over the size ceiling is `FILE_TOO_LARGE`,
      // not `AUDIO_TOO_LONG`: the two are different facts and a farmer trimming a recording that was
      // never too long would be following the wrong instruction.
      expect(error.code).toBe('FILE_TOO_LARGE');
      expect(toEnvelope(error, LANGUAGE).error.message).toContain('10');
      expect(await unitsUsed('voice')).toBe(before);
      expect(harness.objects.has(ref)).toBe(true);
    });
  });

  /* ====================================================================== */
  /* An empty transcript — Requirement 8.7                                   */
  /* ====================================================================== */

  describe('an empty transcript', () => {
    it('asks for a quieter recording, keeps the object, spends the unit, and calls no chat', async () => {
      harness.providers.script.transcription = EMPTY_TRANSCRIPTION;
      const ref = recording();
      const voiceBefore = await unitsUsed('voice');
      const chatBefore = await unitsUsed('chat');
      const chatCallsBefore = chatCalls.length;
      const removalsBefore = harness.objects.removed.length;

      const error = await refusalOf(
        speak({ storageRef: ref, conversationId, durationSeconds: EMPTY_TRANSCRIPTION.duration ?? 3 }),
      );

      // Requirement 8.7's own instruction, from the catalog.
      expect(error.code).toBe('TRANSCRIPT_EMPTY');
      expect(toEnvelope(error, LANGUAGE).error.message).toBe(
        messages(LANGUAGE).errors.TRANSCRIPT_EMPTY,
      );
      expect(toEnvelope(error, LANGUAGE).error.message).toContain('quieter');
      // The reason names which spelling of empty it was, which is what separates this from the
      // whitespace case below in the server log.
      expect(error.context?.reason).toBe('provider_returned_empty');

      // No chat call at all — this is the branch that must not reach the ChatService, and a count of
      // real invocations is what makes that structural rather than implied.
      expect(chatCalls.length).toBe(chatCallsBefore);
      expect(await unitsUsed('chat')).toBe(chatBefore);

      // The provider answered, so the unit is spent and not refunded.
      expect(await unitsUsed('voice')).toBe(voiceBefore + 1);

      // Requirement 8.10 — no transcript was persisted, so the object is RETAINED and no delete was
      // attempted. Deleting it here would strand a recording the sweep is meant to collect and would
      // make `TRANSCRIPT_EMPTY`'s retryability a lie.
      expect(harness.objects.has(ref)).toBe(true);
      expect(harness.objects.removed.length).toBe(removalsBefore);

      // The audit says the request *worked* and produced nothing to answer: `inconclusive`, spent.
      // `provider_error` would claim a failure that did not happen.
      const audit = await voiceAudit();
      const empties = audit.filter((entry) => entry.outcome === 'inconclusive');
      expect(empties.length).toBeGreaterThan(0);
      for (const entry of empties) {
        expect(entry.quota_spent).toBe(true);
        expect(entry.model_provider).toBe('groq');
        expect(entry.channel).toBe('web');
      }
    });

    it('treats a whitespace-only transcript as empty for the same reason', async () => {
      // `trim() === ''` rather than `text === ''` is the predicate, and this is the case that tells
      // them apart: spaces, tabs and newlines carry no question, and sending them onward would spend
      // a knowledge-base read and a model call to answer nothing — and persist a blank farmer
      // message in the conversation.
      harness.providers.script.transcription = WHITESPACE_TRANSCRIPTION;
      const ref = recording();
      const chatCallsBefore = chatCalls.length;

      const error = await refusalOf(
        speak({ storageRef: ref, conversationId, durationSeconds: SHORT_SECONDS }),
      );

      expect(error.code).toBe('TRANSCRIPT_EMPTY');
      // The two spellings are distinguishable in the log even though the farmer reads one sentence.
      expect(error.context?.reason).toBe('provider_returned_whitespace');
      expect(chatCalls.length).toBe(chatCallsBefore);
      expect(harness.objects.has(ref)).toBe(true);
    });
  });

  /* ====================================================================== */
  /* A noisy transcript — non-empty, and not the empty branch                */
  /* ====================================================================== */

  describe('a noisy-audio transcript', () => {
    it('preserves it verbatim, answers honestly, and still deletes the recording', async () => {
      harness.providers.script.transcription = NOISY_TRANSCRIPTION;
      const ref = recording();
      const voiceBefore = await unitsUsed('voice');
      const chatCallsBefore = chatCalls.length;

      // The diagnosis-free thread, so the noisy transcript has no subject anywhere: no vocabulary of
      // its own and no Diagnosis_Result to fall back on.
      const outcome = await speak({
        storageRef: ref,
        conversationId: emptyConversationId,
        durationSeconds: NOISY_TRANSCRIPTION.duration ?? 4,
      });

      // Verbatim, padding included. This is the assertion the padded fixture exists for.
      expect(outcome.transcript).toBe(NOISY_TRANSCRIPTION.text);
      expect(outcome.transcript).not.toBe(NOISY_TRANSCRIPTION.text.trim());
      await expectTranscriptMessage(outcome, ref, NOISY_TRANSCRIPTION.text);

      // A high `no_speech_prob` is not a reason to treat a real transcript as empty: it reached the
      // ChatService, which is Requirement 8.4.
      expect(NOISY_TRANSCRIPTION.no_speech_prob ?? 0).toBeGreaterThan(0.5);
      expect(chatCalls.length).toBe(chatCallsBefore + 1);

      // And the honest answer is the referral, not invented advice — Requirement 4.7's copy, with no
      // model call inside the nested turn.
      expect(outcome.answer.content).toBe(messages(LANGUAGE).chat.outOfScope);
      expect(outcome.answer.groundedIn).toEqual([]);
      expect(outcome.answer.needsExpert).toBe(true);

      // Requirement 8.9 turns on a persisted transcript, not on a *useful* one: the message row
      // exists, so the recording goes. That is the distinction this scenario exists to pin — an
      // implementation that deleted only on a grounded answer would retain bytes forever for every
      // farmer who recorded in a noisy field.
      expect(outcome.audio).toEqual({ outcome: 'deleted' });
      expect(harness.objects.has(ref)).toBe(false);

      // One voice unit, and the referral inside spent no chat unit — it was covered, and it refunded
      // nothing because it reserved nothing.
      expect(await unitsUsed('voice')).toBe(voiceBefore + 1);
      expect(outcome.quota.operation).toBe('voice');
    });
  });

  /* ====================================================================== */
  /* A transcription failure — Requirements 14.5, 8.10                       */
  /* ====================================================================== */

  describe('a transcription the provider could not deliver', () => {
    it('reports TRANSCRIPTION_FAILED rather than a diagnosis timeout, and retains the object', async () => {
      /**
       * The one-member chain exhausted, driven through the **real** V11 classification: the stub
       * rejects with a 429 and a `Headers`, `classifyGroqError` decides it is a fallback trigger,
       * `isFallbackTrigger` agrees, and `run()` finds no further member — so the failure below is the
       * gateway's own exhausted-chain exit and not a scripted error object.
       *
       * `EXHAUSTED_CHAIN_CODE` maps `transcribe` to `TRANSCRIPTION_FAILED`, which is deliberately
       * **not** `PROVIDERS_UNAVAILABLE`: 14.5's busy message is written for a model operation, and a
       * farmer whose recording could not be transcribed needs "try again" against the same object
       * rather than a sentence about Jamee being busy with a photo. The two codes stay distinct and
       * this is where that is observable.
       */
      harness.providers.script.transcriptionRejection = providerRejection(RATE_LIMIT_STATUS, {
        'retry-after': '9',
      });
      const ref = recording();
      const voiceBefore = await unitsUsed('voice');
      const chatCallsBefore = chatCalls.length;
      const removalsBefore = harness.objects.removed.length;

      try {
        const error = await refusalOf(
          speak({ storageRef: ref, conversationId, durationSeconds: SHORT_SECONDS }),
        );

        expect(error.code).toBe('TRANSCRIPTION_FAILED');
        expect(error.code).not.toBe('PROVIDERS_UNAVAILABLE');
        expect(error.code).not.toBe('DIAGNOSIS_TIMEOUT');

        // No answer was produced, so no transcript was persisted, so the object is retained
        // (Requirement 8.10) — `TRANSCRIPTION_FAILED` is retryable over the same object, and
        // deleting it would make that flag a lie.
        expect(chatCalls.length).toBe(chatCallsBefore);
        expect(harness.objects.has(ref)).toBe(true);
        expect(harness.objects.removed.length).toBe(removalsBefore);

        // A real provider call was attempted, so the unit is spent and stays spent — refunding it
        // would let a failing provider drain the free tier through retries.
        expect(await unitsUsed('voice')).toBe(voiceBefore + 1);

        const audit = await voiceAudit();
        const failures = audit.filter((entry) => entry.outcome === 'provider_error');
        expect(failures.length).toBeGreaterThan(0);
        for (const entry of failures) {
          expect(entry.quota_spent).toBe(true);
          // No provider served it, which is the positive statement migration 0006 permits.
          expect(entry.model_provider).toBe('none');
        }
      } finally {
        // Cleared here rather than in an `afterEach`, so the scripted rejection cannot leak into a
        // later test in this file and make it fail for the wrong reason.
        delete harness.providers.script.transcriptionRejection;
      }
    });
  });

  /* ====================================================================== */
  /* The whole file, seen from the audit trail                               */
  /* ====================================================================== */

  it('spent one voice unit per request that reached the provider and no chat unit at all', async () => {
    const audit = await voiceAudit();
    expect(audit.length).toBeGreaterThan(0);
    for (const entry of audit) {
      expect(entry.operation).toBe('voice');
      expect(entry.channel).toBe('web');
      expect(entry.user_id).toBe(harness.farmerA.id);
      // No voice request produces a diagnosis, so this column is `null` on every row here.
      expect(entry.diagnosis_id).toBeNull();
    }

    const spent = audit.filter((entry) => entry.quota_spent);
    expect(spent.length).toBeGreaterThan(0);
    expect(await unitsUsed('voice')).toBe(spent.length);

    /**
     * Requirement 14.1 for the file as a whole: every chat unit in this window belongs to the
     * *diagnosis* setup's follow-ups, of which there are none — so a voice-only file leaves the chat
     * counter at zero however many nested answers it produced.
     */
    expect(await unitsUsed('chat')).toBe(0);
    expect(chatCalls.length).toBeGreaterThan(0);

    // Requirement 13.2 — the other farmer's session reaches none of it.
    const theirs = await harness.farmerB.client.from('usage_logs').select('user_id');
    expect(theirs.error).toBeNull();
    expect(theirs.data ?? []).toEqual([]);

    // Nothing this file wrote is grounded in content the harness authored: the one seeded row every
    // grounded voice answer used is the migration's.
    expect(row.source.trim()).not.toBe('');
  });
});
