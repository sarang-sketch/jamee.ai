import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MAX_AUDIO_SECONDS } from '@/lib/config/verified';
import { isAppError } from '@/lib/errors';
import type { Language, VoiceInput } from '@/lib/schemas';
import { dayWindowKey } from '@/lib/time';
import { COLLECTIONS, type UsageLogDoc } from '@/lib/db/collections';

import { startHarness, type Harness } from './harness';
import {
  CLASSIFICATIONS,
  DEFAULT_TRANSCRIPTION,
  classificationText,
  echoingRephrase,
  type EchoingRephrase,
  type TranscriptionPayload,
} from './providers';

/**
 * The voice path, scenario by scenario, against a real single-node `MongoMemoryReplSet` (V31, V33).
 *
 * Requirements: 8.2 / 8.3 (up to 120 s; a recording over the limit is declined), 8.4 (the transcript
 *               is passed to the Chat_Service as a Farmer message), 8.5 (the input language reaches
 *               the provider), 8.6 (the transcript AND the answer come back together), 8.7 (an empty
 *               transcript asks the Farmer to record again), 8.9 / 8.10 / 8.11 (the recording is
 *               deleted through the owner-scoped Data_Access_Layer after a persisted transcript,
 *               retained otherwise), 14.1 (one voice message spends one voice unit and no chat unit),
 *               13.2 (owner scoping), 17.5
 * Design: "Integration tests — mocked providers, real MongoDB"; "Voice sequence"; D10, D17, D18;
 *         Amendment A3 (the recording is a GridFS file read/deleted by Media_Reference)
 *
 * =============================================================================
 * WHAT MAKES THESE SCENARIOS AND NOT UNIT TESTS — RESTATED FOR A3
 * =============================================================================
 *
 *  - **8.9's precondition is a committed message.** "the transcript is persisted, therefore the
 *    recording is gone" is checked end to end: the recording is a real GridFS file, the transcript
 *    message is a real insert, and the delete is `removeMediaForOwner` through the DAL — so a real
 *    read confirms the GridFS file is absent afterward.
 *  - **14.1's nesting rule is two real counters.** One voice message leaves the `voice` counter one
 *    higher and the `chat` counter untouched — the real `counters` conditional upsert, twice.
 *  - **8.7's branch is distinguishable from a provider failure** by `usage_logs.outcome`, on the
 *    real collection its validator admits.
 *
 * The transcription provider is stubbed at the adapter seam, so the real gateway, request body, and
 * container guard all run.
 */

const LANGUAGE: Language = 'en';
const CLASSIFIED = CLASSIFICATIONS.tomatoEarlyBlight;

/** The quota window every reserve lands in — pinned and in the past (see image-scenarios). */
const QUOTA_INSTANT = new Date(Date.UTC(1970, 0, 15, 12, 0, 0));
const SHORT_SECONDS = DEFAULT_TRANSCRIPTION.duration ?? 6.4;

/** V10's empty-transcript payload: a SUCCESSFUL provider call that produced no words (8.7). */
const EMPTY_TRANSCRIPTION: TranscriptionPayload = {
  text: '',
  language: 'en',
  duration: 3.1,
  no_speech_prob: 0.98,
  avg_logprob: -1.6,
};

let harness: Harness;
let rephrase: EchoingRephrase;
type Voice = typeof import('@/services/voice.service');
type Chat = typeof import('@/services/chat.service');
type Diagnosis = typeof import('@/services/diagnosis.service');
type Farmer = typeof import('@/lib/db/farmer');
let voice: Voice;
let chat: Chat;
let diagnosisMod: Diagnosis;
let farmer: Farmer;

beforeAll(async () => {
  rephrase = echoingRephrase();
  harness = await startHarness({ providers: { text: rephrase.text } });
  voice = await import('@/services/voice.service');
  chat = await import('@/services/chat.service');
  diagnosisMod = await import('@/services/diagnosis.service');
  farmer = await import('@/lib/db/farmer');
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await harness.reset();
  harness.providers.script.transcription = DEFAULT_TRANSCRIPTION;
  harness.providers.script.vision = classificationText(CLASSIFIED);
});

/* ========================================================================== */
/* Wiring                                                                     */
/* ========================================================================== */

/** The voice deps: a real nested chat answerer, the real transcriber seam, and the pinned clock. */
function voiceDeps(): import('@/services/voice.service').VoiceDeps {
  return {
    chat: chat.chatAnswerer({ models: harness.providers.models, quota: { now: QUOTA_INSTANT } }),
    transcribe: harness.providers.transcribe,
    quota: { now: QUOTA_INSTANT },
  };
}

/** Run one voice request from farmer A over an owned GridFS recording, in a fresh conversation. */
async function voiceAs(
  overrides: Partial<VoiceInput> = {},
): Promise<import('@/services/voice.service').VoiceOutcome> {
  const audio = await harness.objects.recording(harness.farmerA.id);
  const conversation = await farmer.farmerData(harness.farmerA.id).insertConversation({ channel: 'web' });
  const input: VoiceInput = {
    userId: harness.farmerA.id,
    audio,
    language: LANGUAGE,
    channel: 'web',
    conversationId: conversation._id.toHexString(),
    durationSeconds: SHORT_SECONDS,
    mimeType: 'audio/ogg',
    ...overrides,
  };
  return voice.transcribeAndAnswer(input, voiceDeps());
}

function unitsUsed(operation: 'voice' | 'chat'): Promise<number> {
  return farmer.farmerData(harness.farmerA.id).counterUsed(operation, 'day', dayWindowKey(QUOTA_INSTANT));
}

/* ========================================================================== */
/* A clear voice question — 8.4, 8.6, 14.1, 8.9                               */
/* ========================================================================== */

describe('a clear voice question after a diagnosis', () => {
  it('transcribes, answers as a chat turn, deletes the recording, and spends one voice unit only', async () => {
    // Seed a diagnosis in the conversation so the follow-up has a subject (7.1/7.3).
    const image = await harness.objects.image(harness.farmerA.id);
    const conversation = await farmer.farmerData(harness.farmerA.id).insertConversation({ channel: 'web' });
    await diagnosisMod.diagnose(
      { userId: harness.farmerA.id, image, language: LANGUAGE, channel: 'web', conversationId: conversation._id.toHexString() },
      { models: harness.providers.models, quota: { now: QUOTA_INSTANT } },
    );

    const audio = await harness.objects.recording(harness.farmerA.id);
    const voiceBefore = await unitsUsed('voice');
    const chatBefore = await unitsUsed('chat');

    const outcome = await voice.transcribeAndAnswer(
      {
        userId: harness.farmerA.id,
        audio,
        language: LANGUAGE,
        channel: 'web',
        conversationId: conversation._id.toHexString(),
        durationSeconds: SHORT_SECONDS,
        mimeType: 'audio/ogg',
      },
      voiceDeps(),
    );

    // 8.6 — the transcript AND the answer are both present.
    expect(outcome.transcript).toBe(DEFAULT_TRANSCRIPTION.text);
    expect(outcome.answer.content.length).toBeGreaterThan(0);

    // 8.4 — a farmer message carrying the transcript verbatim was persisted, tagged input voice.
    const messages = await farmer.farmerData(harness.farmerA.id).findMessages({});
    const farmerMsg = messages.find((m) => m.role === 'farmer' && m.content === DEFAULT_TRANSCRIPTION.text);
    expect(farmerMsg).toBeDefined();
    expect(farmerMsg?.inputKind).toBe('voice');
    expect(farmerMsg?.channel).toBe('web');

    // 14.1 — one voice unit, no chat unit.
    expect(await unitsUsed('voice')).toBe(voiceBefore + 1);
    expect(await unitsUsed('chat')).toBe(chatBefore);

    // 8.9 (A3) — the recording is gone from GridFS, and its owner can no longer read it.
    expect(await harness.objects.ownerCanRead(harness.farmerA.id, audio)).toBe(false);
    expect(outcome.audio.outcome).toBe('deleted');

    // 13.2 — the other farmer sees none of the messages.
    const asB = await farmer.farmerData(harness.farmerB.id).findMessages({});
    expect(asB).toEqual([]);
  });
});

/* ========================================================================== */
/* An empty transcript — 8.7, 8.10                                            */
/* ========================================================================== */

describe('an empty transcript', () => {
  it('asks the farmer to record again, retains the recording, and records inconclusive', async () => {
    harness.providers.script.transcription = EMPTY_TRANSCRIPTION;
    const audio = await harness.objects.recording(harness.farmerA.id);
    const conversation = await farmer.farmerData(harness.farmerA.id).insertConversation({ channel: 'web' });

    let threw = false;
    try {
      await voice.transcribeAndAnswer(
        {
          userId: harness.farmerA.id,
          audio,
          language: LANGUAGE,
          channel: 'web',
          conversationId: conversation._id.toHexString(),
          durationSeconds: SHORT_SECONDS,
          mimeType: 'audio/ogg',
        },
        voiceDeps(),
      );
    } catch (error) {
      threw = true;
      expect(isAppError(error)).toBe(true);
    }
    expect(threw).toBe(true);

    // 8.10 — the recording is RETAINED (a failed/empty transcript keeps the object).
    expect(await harness.objects.ownerCanRead(harness.farmerA.id, audio)).toBe(true);

    // 8.7 versus a provider failure: the audit row says `inconclusive`, not `provider_error`.
    const logs = await harness.db
      .collection<UsageLogDoc>(COLLECTIONS.usageLogs)
      .find({ ownerId: harness.farmerA.id, operation: 'voice' })
      .toArray();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.outcome === 'inconclusive')).toBe(true);
  });
});

/* ========================================================================== */
/* Audio admission — 8.2, 8.3                                                 */
/* ========================================================================== */

describe('audio admission', () => {
  it('declines a recording longer than the limit and spends nothing', async () => {
    const voiceBefore = await unitsUsed('voice');
    let threw = false;
    try {
      await voiceAs({ durationSeconds: MAX_AUDIO_SECONDS + 1 });
    } catch (error) {
      threw = true;
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) expect(error.code).toBe('AUDIO_TOO_LONG');
    }
    expect(threw).toBe(true);
    // The refusal is BEFORE the reserve — nothing was spent.
    expect(await unitsUsed('voice')).toBe(voiceBefore);
  });

  it('supplies the input language to the transcription provider (8.5)', async () => {
    await voiceAs({ language: 'hi' });
    const lastTranscribe = harness.providers.calls.transcription.at(-1);
    expect(lastTranscribe?.language).toBe('hi');
  });
});

/* ========================================================================== */
/* Ownership — 8.11, 2.6                                                      */
/* ========================================================================== */

describe('ownership', () => {
  it("refuses a recording owned by another farmer before spending anything", async () => {
    // A recording owned by farmer B, referenced by farmer A.
    const foreign = await harness.objects.recording(harness.farmerB.id);
    const conversation = await farmer.farmerData(harness.farmerA.id).insertConversation({ channel: 'web' });
    const voiceBefore = await unitsUsed('voice');

    let threw = false;
    try {
      await voice.transcribeAndAnswer(
        {
          userId: harness.farmerA.id,
          audio: foreign,
          language: LANGUAGE,
          channel: 'web',
          conversationId: conversation._id.toHexString(),
          durationSeconds: SHORT_SECONDS,
          mimeType: 'audio/ogg',
        },
        voiceDeps(),
      );
    } catch (error) {
      threw = true;
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) expect(error.code).toBe('STORAGE_REF_FORBIDDEN');
    }
    expect(threw).toBe(true);
    // 2.6 — the owner-scoped read failed before the reserve, so nothing was spent, and B's file
    // survives (A's request never reached a delete).
    expect(await unitsUsed('voice')).toBe(voiceBefore);
    expect(await harness.objects.ownerCanRead(harness.farmerB.id, foreign)).toBe(true);
  });
});
