import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import type { GatewayResult } from '@/lib/ai/gateway';
import { DAILY_QUOTAS, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS } from '@/lib/config/verified';
import { AppError, isAppError } from '@/lib/errors';
import type { TranscribeRequest, TranscriptionResult } from '@/lib/groq';
import { voiceResponseSchema, type ChatInput, type MediaRef, type VoiceInput } from '@/lib/schemas';
import {
  quotaStatusOf,
  reserveForRequest,
  type CounterRpc,
  type QuotaContext,
} from '@/services/quota.service';
import {
  audioContainerOf,
  deleteVoiceOriginal,
  transcribeAndAnswer,
  type ChatAnswerer,
  type MediaRemover,
  type NestedChatOutcome,
  type Transcriber,
  type VoiceDeps,
  type VoiceStore,
} from '@/services/voice.service';
import type { TablesInsert } from '@/types/database';

/**
 * Unit tests for `src/services/voice.service.ts` (Amendment A3), with the media read, transcription,
 * chat and delete seams stubbed.
 *
 * Requirements: 2.6 (an ownership rejection leaves the quota untouched), 8.3 (the duration limit,
 *               re-checked server-side), 8.4 (the transcript is passed to the Chat_Service as a
 *               Farmer message), 8.6 (the transcript AND the answer are both returned), 8.7 (an
 *               empty transcript asks the farmer to record again and produces no answer), 8.9 (the
 *               original is deleted once the transcript is persisted), 8.10 (a failed or empty
 *               transcript retains the object), 8.11 (deletion is owner-scoped through the
 *               Data_Access_Layer), 14.1 (one voice message spends one voice unit), 14.3 (the
 *               decline states the limit and reset)
 *
 * The strongest assertions are the negative ones — the chat seam never reached after an empty
 * transcript, `remove()` never called on a non-owned reference, the counter touched exactly once
 * across two nested services — because the pipeline order IS the contract.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const USER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const FARMER_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const ANSWER_MESSAGE_ID = '66666666-6666-4666-8666-666666666666';

/** A3: the input carries a `{ fileId, kind: 'voice' }` Media_Reference, not a storage path. */
const AUDIO_REF: MediaRef = { fileId: 'c'.repeat(24), kind: 'voice' };

/** The bytes the owner-checked read yields, and the stored MIME type. */
const AUDIO_BYTES = Buffer.from('fake-opus-bytes');
const AUDIO_MIME = 'audio/webm;codecs=opus';

const TRANSCRIPT = ' मेरे टमाटर के पत्तों पर भूरे धब्बे हैं';

function voiceInput(
  overrides: {
    readonly audio?: MediaRef;
    readonly durationSeconds?: number;
    readonly mimeType?: string;
    readonly language?: VoiceInput['language'];
    readonly channel?: VoiceInput['channel'];
    readonly bytes?: number;
  } = {},
): VoiceInput {
  return {
    userId: USER,
    audio: overrides.audio ?? AUDIO_REF,
    language: overrides.language ?? 'hi',
    channel: overrides.channel ?? 'web',
    conversationId: CONVERSATION_ID,
    durationSeconds: overrides.durationSeconds ?? 6.5,
    ...(overrides.mimeType === undefined ? {} : { mimeType: overrides.mimeType }),
    ...(overrides.bytes === undefined ? {} : { bytes: overrides.bytes }),
  };
}

/* -------------------------------------------------------------------------- */
/* Seams                                                                       */
/* -------------------------------------------------------------------------- */

interface MediaReadStub {
  readonly read: (userId: string, ref: MediaRef) => Promise<{ bytes: Buffer; mimeType: string } | null>;
  readonly readsFor: string[];
}

function mediaReadStub(options: { owned?: boolean; mimeType?: string } = {}): MediaReadStub {
  const readsFor: string[] = [];
  const owned = options.owned ?? true;
  return {
    readsFor,
    read: (_userId, ref) => {
      readsFor.push(ref.fileId);
      return Promise.resolve(
        owned ? { bytes: AUDIO_BYTES, mimeType: options.mimeType ?? AUDIO_MIME } : null,
      );
    },
  };
}

interface RemoveStub {
  readonly remove: MediaRemover;
  readonly removed: string[];
}

function removeStub(options: { removed?: boolean; error?: unknown } = {}): RemoveStub {
  const removed: string[] = [];
  const remove: MediaRemover = (_userId, fileId) => {
    removed.push(fileId);
    if (options.error !== undefined) return Promise.reject(options.error);
    return Promise.resolve(options.removed ?? true);
  };
  return { remove, removed };
}

interface TranscribeStub {
  readonly transcribe: Transcriber;
  readonly calls: TranscribeRequest[];
}

function transcribeStub(
  options: { text?: string; error?: unknown; noSpeechProb?: number } = {},
): TranscribeStub {
  const calls: TranscribeRequest[] = [];

  const transcribe: Transcriber = (request) => {
    calls.push(request);
    if (options.error !== undefined) return Promise.reject(options.error);

    const value: TranscriptionResult = {
      text: options.text ?? TRANSCRIPT,
      language: 'hi',
      durationSeconds: 6.5,
      signals: {
        avgLogprob: -0.21,
        noSpeechProb: options.noSpeechProb,
        compressionRatio: 1.4,
      },
      segments: [],
    };
    const result: GatewayResult<TranscriptionResult> = {
      value,
      provider: 'groq',
      usedFallback: false,
    };
    return Promise.resolve(result);
  };

  return { transcribe, calls };
}

/**
 * Fails the test if any counter function is reached — the tripwire the nesting rule needs.
 * `reserveForRequest()` on a `covered` context performs no RPC, so on the correct path this is
 * never touched; the chat stub hands its coverage to the real `reserveForRequest()`.
 */
const unreachableRpc: CounterRpc = {
  tryIncrement: () => {
    throw new Error('counter_try_increment was called by the nested chat call (Requirement 14.1)');
  },
  decrement: () => {
    throw new Error('counter_decrement was called by the nested chat call');
  },
  used: () => {
    throw new Error('counter_used was called by the nested chat call');
  },
};

interface ChatStub {
  readonly chat: ChatAnswerer;
  readonly calls: { readonly input: ChatInput; readonly coverage: QuotaContext }[];
}

function chatStub(options: { error?: unknown; rpc?: CounterRpc } = {}): ChatStub {
  const calls: { input: ChatInput; coverage: QuotaContext }[] = [];

  const chat: ChatAnswerer = async (input, coverage) => {
    calls.push({ input, coverage });
    if (options.error !== undefined) throw options.error;

    const reserved = await reserveForRequest(coverage, { rpc: options.rpc ?? unreachableRpc });
    if (reserved.outcome === 'at_limit') throw new Error('the nested chat call was declined');

    const outcome: NestedChatOutcome = {
      conversationId: input.conversationId,
      farmerMessageId: FARMER_MESSAGE_ID,
      answer: {
        messageId: ANSWER_MESSAGE_ID,
        content: 'Early blight. Remove affected leaves and avoid overhead watering.',
        language: input.language,
        groundedIn: ['Tomato Early Blight'],
        needsExpert: false,
      },
      quota: quotaStatusOf(reserved.reservation),
    };
    return outcome;
  };

  return { chat, calls };
}

interface StoreStub {
  readonly store: VoiceStore;
  readonly usage: TablesInsert<'usage_logs'>[];
}

function storeStub(): StoreStub {
  const usage: TablesInsert<'usage_logs'>[] = [];
  return {
    usage,
    store: {
      insertUsageLog: (row) => {
        usage.push(row);
        return Promise.resolve();
      },
    },
  };
}

interface CounterStub {
  readonly rpc: CounterRpc;
  readonly increments: number;
  readonly decrements: number;
}

function counterStub(options: { tryIncrement?: number | null } = {}): CounterStub {
  const state = { increments: 0, decrements: 0 };
  const rpc: CounterRpc = {
    tryIncrement: () => {
      state.increments += 1;
      return Promise.resolve(options.tryIncrement === undefined ? 1 : options.tryIncrement);
    },
    decrement: () => {
      state.decrements += 1;
      return Promise.resolve(0);
    },
    used: () => Promise.resolve(0),
  };
  return {
    rpc,
    get increments() {
      return state.increments;
    },
    get decrements() {
      return state.decrements;
    },
  };
}

/** Fails the test if the daily counter is reached at all — the pre-reserve cases' real assertion. */
const forbiddenCounter: CounterRpc = {
  tryIncrement: () => {
    throw new Error('counter_try_increment was called; this path must reserve nothing');
  },
  decrement: () => {
    throw new Error('counter_decrement was called; this path must refund nothing');
  },
  used: () => {
    throw new Error('counter_used was called; this path needs no read');
  },
};

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly deps: VoiceDeps;
  readonly media: MediaReadStub;
  readonly remover: RemoveStub;
  readonly transcription: TranscribeStub;
  readonly chat: ChatStub;
  readonly store: StoreStub;
  readonly counter: CounterStub;
}

function harness(
  options: {
    media?: MediaReadStub;
    remover?: RemoveStub;
    transcription?: TranscribeStub;
    chat?: ChatStub;
    counter?: CounterStub;
    rpc?: CounterRpc;
  } = {},
): Harness {
  const media = options.media ?? mediaReadStub();
  const remover = options.remover ?? removeStub();
  const transcription = options.transcription ?? transcribeStub();
  const counter = options.counter ?? counterStub();
  const chat = options.chat ?? chatStub();
  const store = storeStub();

  return {
    media,
    remover,
    transcription,
    chat,
    store,
    counter,
    deps: {
      chat: chat.chat,
      readMedia: media.read,
      remove: remover.remove,
      store: store.store,
      transcribe: transcription.transcribe,
      quota: { rpc: options.rpc ?? counter.rpc, now: new Date('2026-09-15T19:30:00.000Z') },
      now: () => Date.parse('2026-09-15T19:30:00.000Z'),
    },
  };
}

async function failure(run: Promise<unknown>): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to reject, and it resolved');
}

/* ========================================================================== */
/* The happy path (Requirements 8.4, 8.6)                                      */
/* ========================================================================== */

describe('transcribeAndAnswer — the transcript reaches ChatService verbatim', () => {
  it('hands the provider text over unchanged, as a voice farmer message carrying the media reference', async () => {
    const test = harness();

    const outcome = await transcribeAndAnswer(voiceInput(), test.deps);

    expect(test.chat.calls).toHaveLength(1);
    const call = test.chat.calls[0];
    expect(call?.input.message).toBe(TRANSCRIPT);
    expect(call?.input.inputKind).toBe('voice');
    // A3: `transcriptOf` is the recording's Media_Reference, not a storage path.
    expect(call?.input.transcriptOf).toEqual(AUDIO_REF);
    expect(call?.input.conversationId).toBe(CONVERSATION_ID);
    expect(call?.input.userId).toBe(USER);
    expect(call?.input.language).toBe('hi');
    expect(call?.input.channel).toBe('web');
    expect(call?.input.skipQuotaReserve).toBe(true);

    expect(outcome.transcript).toBe(TRANSCRIPT);
    expect(outcome.answer.content).toContain('Early blight');
    expect(
      voiceResponseSchema.safeParse({
        transcript: outcome.transcript,
        answer: outcome.answer,
        conversationId: outcome.conversationId,
        quota: outcome.quota,
      }).success,
    ).toBe(true);
  });

  it('reports the voice quota it spent, not the chat counter', async () => {
    const test = harness({ counter: counterStub({ tryIncrement: 4 }) });

    const outcome = await transcribeAndAnswer(voiceInput(), test.deps);

    expect(outcome.quota.operation).toBe('voice');
    expect(outcome.quota.used).toBe(4);
    expect(outcome.quota.limit).toBe(DAILY_QUOTAS.voice);
  });

  it('sends the resolved container, the bytes and the farmer language to the provider (A3)', async () => {
    const test = harness();

    await transcribeAndAnswer(voiceInput({ mimeType: 'audio/webm;codecs=opus' }), test.deps);

    expect(test.transcription.calls).toHaveLength(1);
    expect(test.transcription.calls[0]?.container).toBe('audio/webm;codecs=opus');
    expect(test.transcription.calls[0]?.language).toBe('hi');
    // A3, V34: the bytes travel as `audioBytes`, not by URL.
    expect(test.transcription.calls[0]?.audioBytes).toBe(AUDIO_BYTES);
    expect(test.media.readsFor).toEqual([AUDIO_REF.fileId]);
    expect(test.store.usage[0]?.outcome).toBe('success');
    expect(test.store.usage[0]?.operation).toBe('voice');
    expect(test.store.usage[0]?.quota_spent).toBe(true);
  });

  it('falls back to the stored MIME type for the container when the request carries none', async () => {
    const test = harness({ media: mediaReadStub({ mimeType: 'audio/ogg' }) });

    await transcribeAndAnswer(voiceInput(), test.deps);

    expect(test.transcription.calls[0]?.container).toBe('audio/ogg');
  });
});

/* ========================================================================== */
/* THE NESTING RULE (Requirement 14.1)                                         */
/* ========================================================================== */

describe('transcribeAndAnswer — one voice message spends one unit', () => {
  it('touches the counter exactly once across both services', async () => {
    const counter = counterStub();
    const test = harness({ counter, chat: chatStub({ rpc: counter.rpc }) });

    await transcribeAndAnswer(voiceInput(), test.deps);

    expect(counter.increments).toBe(1);
    expect(counter.decrements).toBe(0);
  });

  it('hands the nested call inherited coverage rather than a fresh reservation', async () => {
    const test = harness();

    await transcribeAndAnswer(voiceInput(), test.deps);

    const coverage = test.chat.calls[0]?.coverage;
    expect(coverage?.role).toBe('covered');
    if (coverage?.role !== 'covered') throw new Error('expected covered coverage');
    expect(coverage.reservation.reservedHere).toBe(false);
    expect(coverage.reservation.operation).toBe('voice');
    expect(coverage.reservation.userId).toBe(USER);
  });
});

/* ========================================================================== */
/* The empty transcript (Requirement 8.7)                                      */
/* ========================================================================== */

describe('transcribeAndAnswer — an empty transcript produces no answer', () => {
  it('returns TRANSCRIPT_EMPTY for an empty string and never calls ChatService', async () => {
    const test = harness({ transcription: transcribeStub({ text: '', noSpeechProb: 0.93 }) });

    const error = await failure(transcribeAndAnswer(voiceInput(), test.deps));

    expect(error.code).toBe('TRANSCRIPT_EMPTY');
    expect(error.status).toBe(422);
    expect(error.retryable).toBe(true);
    expect(test.chat.calls).toHaveLength(0);
    expect(error.context?.noSpeechProb).toBe(0.93);
  });

  it('returns TRANSCRIPT_EMPTY for a whitespace-only transcript and never calls ChatService', async () => {
    const test = harness({ transcription: transcribeStub({ text: '  \n\t \u00a0 ' }) });

    const error = await failure(transcribeAndAnswer(voiceInput(), test.deps));

    expect(error.code).toBe('TRANSCRIPT_EMPTY');
    expect(test.chat.calls).toHaveLength(0);
    expect(error.context?.reason).toBe('provider_returned_whitespace');
  });

  it('still spends the unit, because the provider call was made', async () => {
    const counter = counterStub();
    const test = harness({ counter, transcription: transcribeStub({ text: '' }) });

    await failure(transcribeAndAnswer(voiceInput(), test.deps));

    expect(counter.increments).toBe(1);
    expect(counter.decrements).toBe(0);
    expect(test.store.usage[0]?.outcome).toBe('inconclusive');
    expect(test.store.usage[0]?.quota_spent).toBe(true);
  });
});

/* ========================================================================== */
/* Deletion and retention (Requirements 8.9, 8.10, 8.11)                       */
/* ========================================================================== */

describe('transcribeAndAnswer — the recording is deleted only once its transcript is durable', () => {
  it('deletes the original after the transcript is persisted as a message (8.9)', async () => {
    const test = harness();

    const outcome = await transcribeAndAnswer(voiceInput(), test.deps);

    expect(test.remover.removed).toEqual([AUDIO_REF.fileId]);
    expect(outcome.audio).toEqual({ outcome: 'deleted' });
    expect(outcome.farmerMessageId).toBe(FARMER_MESSAGE_ID);
  });

  it('retains the original after an empty transcript (8.10)', async () => {
    const test = harness({ transcription: transcribeStub({ text: '' }) });

    await failure(transcribeAndAnswer(voiceInput(), test.deps));

    expect(test.remover.removed).toEqual([]);
  });

  it('retains the original after a failed transcription (8.10)', async () => {
    const test = harness({
      transcription: transcribeStub({ error: new AppError('TRANSCRIPTION_FAILED') }),
    });

    const error = await failure(transcribeAndAnswer(voiceInput(), test.deps));

    expect(error.code).toBe('TRANSCRIPTION_FAILED');
    expect(test.remover.removed).toEqual([]);
    expect(test.store.usage[0]?.outcome).toBe('provider_error');
    expect(test.store.usage[0]?.quota_spent).toBe(true);
  });

  it('retains the original when the answer fails, because no message was persisted (8.10)', async () => {
    const test = harness({ chat: chatStub({ error: new AppError('PROVIDERS_UNAVAILABLE') }) });

    const error = await failure(transcribeAndAnswer(voiceInput(), test.deps));

    expect(error.code).toBe('PROVIDERS_UNAVAILABLE');
    expect(test.remover.removed).toEqual([]);
  });

  it('serves the answer even when the delete fails, and says so', async () => {
    const test = harness({ remover: removeStub({ error: new Error('gridfs offline') }) });

    const outcome = await transcribeAndAnswer(voiceInput(), test.deps);

    expect(outcome.answer.content).toContain('Early blight');
    expect(outcome.audio).toEqual({ outcome: 'failed', reason: 'remove_failed' });
  });
});

describe('deleteVoiceOriginal — Requirement 8.11 (owner-scoped through the Data_Access_Layer)', () => {
  it('deletes the recording through removeMediaForOwner and reports it deleted', async () => {
    const remover = removeStub({ removed: true });

    const disposition = await deleteVoiceOriginal(AUDIO_REF, USER, remover.remove);

    expect(disposition).toEqual({ outcome: 'deleted' });
    expect(remover.removed).toEqual([AUDIO_REF.fileId]);
  });

  it('treats a not-owned or already-absent file as already_absent, idempotently', async () => {
    // The owner-scoped delete returns false for both — indistinguishable (Requirement 2.6).
    const remover = removeStub({ removed: false });

    const disposition = await deleteVoiceOriginal(AUDIO_REF, USER, remover.remove);

    expect(disposition).toEqual({ outcome: 'already_absent' });
  });

  it('reports a delete that threw as failed, for the sweep to retry', async () => {
    const remover = removeStub({ error: new Error('gridfs offline') });

    const disposition = await deleteVoiceOriginal(AUDIO_REF, USER, remover.remove);

    expect(disposition).toEqual({ outcome: 'failed', reason: 'remove_failed' });
  });
});

/* ========================================================================== */
/* Everything that must happen before a unit is spent                          */
/* ========================================================================== */

describe('transcribeAndAnswer — nothing is spent before the reserve', () => {
  it('rejects a recording that is not owned with the counter untouched (2.6)', async () => {
    const test = harness({ media: mediaReadStub({ owned: false }), rpc: forbiddenCounter });

    const error = await failure(transcribeAndAnswer(voiceInput(), test.deps));

    expect(error.code).toBe('STORAGE_REF_FORBIDDEN');
    expect(error.status).toBe(403);
    expect(test.transcription.calls).toHaveLength(0);
    expect(test.chat.calls).toHaveLength(0);
    expect(test.remover.removed).toEqual([]);
  });

  it('rejects a recording over the duration limit with AUDIO_TOO_LONG (8.3)', async () => {
    const test = harness({ rpc: forbiddenCounter });

    const error = await failure(
      transcribeAndAnswer(voiceInput({ durationSeconds: MAX_AUDIO_SECONDS + 1 }), test.deps),
    );

    expect(error.code).toBe('AUDIO_TOO_LONG');
    expect(error.status).toBe(400);
    expect(test.transcription.calls).toHaveLength(0);
  });

  it('rejects a recording over the 10 MB size limit with FILE_TOO_LARGE (8.2, 8.3)', async () => {
    const test = harness({ rpc: forbiddenCounter });

    const error = await failure(
      transcribeAndAnswer(voiceInput({ bytes: MAX_AUDIO_BYTES + 1 }), test.deps),
    );

    expect(error.code).toBe('FILE_TOO_LARGE');
    expect(error.status).toBe(400);
    expect(error.details?.maxBytes).toBe(MAX_AUDIO_BYTES);
    expect(test.transcription.calls).toHaveLength(0);
    expect(test.chat.calls).toHaveLength(0);
  });

  it('forwards an explicit byte count to the provider call when the caller supplied one', async () => {
    const test = harness();

    await transcribeAndAnswer(voiceInput({ bytes: MAX_AUDIO_BYTES }), test.deps);

    expect(test.transcription.calls[0]?.bytes).toBe(MAX_AUDIO_BYTES);
  });

  it('forwards the read byte length when the caller supplied none (A3)', async () => {
    // Under A3 the service always has the bytes (it read them), so it forwards their length as the
    // provider-cap floor even when the caller passed no explicit size.
    const test = harness();

    await transcribeAndAnswer(voiceInput(), test.deps);

    expect(test.transcription.calls[0]?.bytes).toBe(AUDIO_BYTES.byteLength);
  });

  it('refuses a container the transcription provider does not accept', async () => {
    const test = harness({ rpc: forbiddenCounter });

    const error = await failure(
      transcribeAndAnswer(voiceInput({ mimeType: 'audio/aac' }), test.deps),
    );

    expect(error.code).toBe('AUDIO_FORMAT_UNSUPPORTED');
    expect(error.status).toBe(400);
    expect(error.retryable).toBe(false);
    expect(error.context?.reason).toBe('container_not_accepted');
    expect(test.transcription.calls).toHaveLength(0);
  });

  it('declines an at-limit farmer with the limit and the reset time, calling no provider (14.3)', async () => {
    const test = harness({ counter: counterStub({ tryIncrement: null }) });

    const error = await failure(transcribeAndAnswer(voiceInput(), test.deps));

    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.details?.limit).toBe(DAILY_QUOTAS.voice);
    expect(error.details?.resetsAt).toBe('2026-09-16T18:30:00.000Z');
    expect(test.transcription.calls).toHaveLength(0);
    expect(test.chat.calls).toHaveLength(0);
    expect(test.store.usage[0]?.outcome).toBe('quota_declined');
    expect(test.store.usage[0]?.quota_spent).toBe(false);
  });
});

/* ========================================================================== */
/* Timeout wording                                                             */
/* ========================================================================== */

describe('transcribeAndAnswer — a transcription timeout is not reported as a photo timeout', () => {
  it('translates the gateway timeout into TRANSCRIPTION_FAILED while auditing it as a timeout', async () => {
    const test = harness({
      transcription: transcribeStub({ error: new AppError('DIAGNOSIS_TIMEOUT') }),
    });

    const error = await failure(transcribeAndAnswer(voiceInput(), test.deps));

    expect(error.code).toBe('TRANSCRIPTION_FAILED');
    expect(test.store.usage[0]?.outcome).toBe('timeout');
    expect(test.store.usage[0]?.quota_spent).toBe(true);
    expect(test.remover.removed).toEqual([]);
  });
});

/* ========================================================================== */
/* Container resolution                                                        */
/* ========================================================================== */

describe('audioContainerOf', () => {
  it('prefers the recorder MIME type when one was sent', () => {
    expect(audioContainerOf('audio/ogg;codecs=opus')).toBe('audio/ogg;codecs=opus');
  });

  it('falls back to a bare "audio" container when no MIME type was sent', () => {
    expect(audioContainerOf(undefined)).toBe('audio');
  });

  it('ignores a blank MIME type rather than declaring an empty container', () => {
    expect(audioContainerOf('   ')).toBe('audio');
  });
});
