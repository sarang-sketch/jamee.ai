import { describe, expect, it } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { GatewayResult } from '@/lib/ai/gateway';
import { DAILY_QUOTAS, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS } from '@/lib/config/verified';
import { AppError, isAppError } from '@/lib/errors';
import type { TranscribeRequest, TranscriptionResult } from '@/lib/groq';
import { voiceResponseSchema, type ChatInput, type StorageRef, type VoiceInput } from '@/lib/schemas';
import type { StorageClientLike } from '@/lib/storage';
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
  type NestedChatOutcome,
  type ObjectRemoveClient,
  type Transcriber,
  type VoiceDeps,
  type VoiceStore,
} from '@/services/voice.service';
import type { Database, TablesInsert } from '@/types/database';

/**
 * Unit tests for `src/services/voice.service.ts`, with the transcription and chat seams stubbed.
 *
 * Requirements: 8.3 (the duration limit, re-checked server-side), 8.4 (the transcript is passed to
 *               the Chat_Service as a Farmer message), 8.6 (the transcript AND the answer are both
 *               returned), 8.7 (an empty transcript asks the farmer to record again and produces no
 *               answer), 8.9 (the original is deleted once the transcript is persisted as a
 *               Message), 8.10 (a failed or empty transcript retains the object), 8.11 (a path
 *               outside the requesting farmer's prefix is never deleted), 14.1 (one voice message
 *               spends one voice unit, never also a chat unit), 14.3 (the decline states the limit
 *               and the reset time), 2.6 (an ownership rejection leaves the quota untouched)
 *
 * ### What these tests can and cannot decide
 *
 * They decide **order and attribution**: which seam was called, with what, in which sequence, and
 * what the service made of the answer. The strongest assertions are the negative ones — the chat
 * seam never reached after an empty transcript, `remove()` never called on a foreign prefix, the
 * counter touched exactly once across two nested services — because the pipeline order *is* the
 * contract and a negative is how an order is observed from outside.
 *
 * They do not decide provider behaviour (task 8.5 owns the fallback matrix), counter atomicity
 * (task 10.2, against a real Postgres), or whether Supabase Storage errors on removing an absent
 * object (V22). A stub asserting its own return value would be a test of the stub.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const OBJECT_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const FARMER_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const ANSWER_MESSAGE_ID = '66666666-6666-4666-8666-666666666666';

const AUDIO_REF: StorageRef = {
  bucket: 'voice-messages',
  path: `${USER}/2026/09/${OBJECT_ID}.webm`,
};

/** Another farmer's prefix, same bucket. The only thing wrong with it is who owns it. */
const FOREIGN_REF: StorageRef = {
  bucket: 'voice-messages',
  path: `${OTHER_USER}/2026/09/${OBJECT_ID}.webm`,
};

/**
 * A transcript with the leading space Whisper reliably produces, kept deliberately: "verbatim"
 * means the provider's string, and the assertions below compare against this exact value.
 */
const TRANSCRIPT = ' मेरे टमाटर के पत्तों पर भूरे धब्बे हैं';

function voiceInput(
  overrides: {
    readonly storageRef?: StorageRef;
    readonly durationSeconds?: number;
    readonly mimeType?: string;
    readonly language?: VoiceInput['language'];
    readonly channel?: VoiceInput['channel'];
    /** Absent by default, which is the shape of a caller that could not learn the size. */
    readonly bytes?: number;
  } = {},
): VoiceInput {
  return {
    userId: USER,
    storageRef: overrides.storageRef ?? AUDIO_REF,
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

/**
 * A tripwire, not a stand-in. Every seam is injected in a unit test, so touching the request client
 * is a defect and any property read throws.
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

interface StorageStub {
  readonly client: ObjectRemoveClient & StorageClientLike;
  readonly probed: string[];
  readonly signed: string[];
  readonly removed: string[];
}

function storageStub(
  options: { exists?: boolean; signable?: boolean; removeError?: unknown } = {},
): StorageStub {
  const probed: string[] = [];
  const signed: string[] = [];
  const removed: string[] = [];
  const exists = options.exists ?? true;
  const signable = options.signable ?? true;

  return {
    probed,
    signed,
    removed,
    client: {
      storage: {
        from: () => ({
          exists: (path: string) => {
            probed.push(path);
            return Promise.resolve({ data: exists, error: null });
          },
          createSignedUrl: (path: string) => {
            signed.push(path);
            return Promise.resolve(
              signable
                ? { data: { signedUrl: `https://storage.test/${path}?token=abc` }, error: null }
                : { data: null, error: { message: 'object not found' } },
            );
          },
          remove: (paths: string[]) => {
            removed.push(...paths);
            return Promise.resolve({ data: paths, error: options.removeError ?? null });
          },
        }),
      },
    },
  };
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
 *
 * `reserveForRequest()` on a `covered` context performs **no RPC at all**, not even a read, so on
 * the correct path this object is never touched. The chat stub below hands it to the real
 * `reserveForRequest()`, which means every test that reaches the chat seam is also asserting
 * Requirement 14.1.
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

/**
 * Stands in for `ChatService` doing the one thing the nesting rule depends on: taking the coverage
 * it was handed to the SAME reserve entry point every service uses.
 *
 * That is what makes these tests assert something real rather than restating the stub. `rpc`
 * defaults to the tripwire, so a coverage context that was not `covered` fails loudly; a caller
 * that wants to *count* reserves passes its own counting stub instead.
 */
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
  readonly storage: StorageStub;
  readonly transcription: TranscribeStub;
  readonly chat: ChatStub;
  readonly store: StoreStub;
  readonly counter: CounterStub;
}

function harness(
  options: {
    storage?: StorageStub;
    transcription?: TranscribeStub;
    chat?: ChatStub;
    counter?: CounterStub;
    rpc?: CounterRpc;
  } = {},
): Harness {
  const storage = options.storage ?? storageStub();
  const transcription = options.transcription ?? transcribeStub();
  const counter = options.counter ?? counterStub();
  const chat = options.chat ?? chatStub();
  const store = storeStub();

  return {
    storage,
    transcription,
    chat,
    store,
    counter,
    deps: {
      supabase: unreachableSupabase,
      chat: chat.chat,
      storage: storage.client,
      deleter: storage.client,
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
  it('hands the provider text over unchanged, as a voice farmer message carrying the audio path', async () => {
    const test = harness();

    const outcome = await transcribeAndAnswer(voiceInput(), test.deps);

    expect(test.chat.calls).toHaveLength(1);
    const call = test.chat.calls[0];
    // Verbatim: byte for byte, leading space and Devanagari intact. Requirement 8.4 passes the
    // transcript to the Chat_Service as a Farmer message, and an edited message is not the
    // farmer's message.
    expect(call?.input.message).toBe(TRANSCRIPT);
    expect(call?.input.inputKind).toBe('voice');
    expect(call?.input.transcriptOf).toBe(AUDIO_REF.path);
    expect(call?.input.conversationId).toBe(CONVERSATION_ID);
    expect(call?.input.userId).toBe(USER);
    expect(call?.input.language).toBe('hi');
    expect(call?.input.channel).toBe('web');
    // The boolean form of the nesting rule, as `schemas.ts` declares it.
    expect(call?.input.skipQuotaReserve).toBe(true);

    // Requirement 8.6 — both halves come back, and in the exact shape the route serializes.
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

  it('sends the resolved container and the farmer language to the provider', async () => {
    const test = harness();

    await transcribeAndAnswer(voiceInput({ mimeType: 'audio/webm;codecs=opus' }), test.deps);

    expect(test.transcription.calls).toHaveLength(1);
    expect(test.transcription.calls[0]?.container).toBe('audio/webm;codecs=opus');
    expect(test.transcription.calls[0]?.language).toBe('hi');
    expect(test.transcription.calls[0]?.audioUrl).toContain(AUDIO_REF.path);
    expect(test.store.usage[0]?.outcome).toBe('success');
    expect(test.store.usage[0]?.operation).toBe('voice');
    expect(test.store.usage[0]?.quota_spent).toBe(true);
  });
});

/* ========================================================================== */
/* THE NESTING RULE (Requirement 14.1)                                         */
/* ========================================================================== */

describe('transcribeAndAnswer — one voice message spends one unit', () => {
  it('touches the counter exactly once across both services', async () => {
    // The SAME counter stub serves this service's reserve and the nested chat's, so a nested
    // reserve would show up as a second increment rather than being invisible.
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
    // `reservedHere: false` is what makes a nested refund a no-op instead of handing back a unit
    // the outer request is still holding.
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
    // Retryable over the same object: the farmer can record again somewhere quieter.
    expect(error.retryable).toBe(true);
    expect(test.chat.calls).toHaveLength(0);
    // V10's signal is logged, because it separates "recorded silence" from "the provider produced
    // nothing" — which is why the bytes are worth keeping for the window.
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

    expect(test.storage.removed).toEqual([AUDIO_REF.path]);
    expect(outcome.audio).toEqual({ outcome: 'deleted' });
    expect(outcome.farmerMessageId).toBe(FARMER_MESSAGE_ID);
  });

  it('retains the original after an empty transcript (8.10)', async () => {
    const test = harness({ transcription: transcribeStub({ text: '' }) });

    await failure(transcribeAndAnswer(voiceInput(), test.deps));

    expect(test.storage.removed).toEqual([]);
  });

  it('retains the original after a failed transcription (8.10)', async () => {
    const test = harness({
      transcription: transcribeStub({ error: new AppError('TRANSCRIPTION_FAILED') }),
    });

    const error = await failure(transcribeAndAnswer(voiceInput(), test.deps));

    expect(error.code).toBe('TRANSCRIPTION_FAILED');
    expect(test.storage.removed).toEqual([]);
    expect(test.store.usage[0]?.outcome).toBe('provider_error');
    // Spent and not refunded: a provider call was attempted.
    expect(test.store.usage[0]?.quota_spent).toBe(true);
  });

  it('retains the original when the answer fails, because no message was persisted (8.10)', async () => {
    const test = harness({ chat: chatStub({ error: new AppError('PROVIDERS_UNAVAILABLE') }) });

    const error = await failure(transcribeAndAnswer(voiceInput(), test.deps));

    expect(error.code).toBe('PROVIDERS_UNAVAILABLE');
    expect(test.storage.removed).toEqual([]);
  });

  it('serves the answer even when the delete fails, and says so', async () => {
    const test = harness({ storage: storageStub({ removeError: { message: 'storage offline' } }) });

    const outcome = await transcribeAndAnswer(voiceInput(), test.deps);

    // The transcript is committed and the farmer has an answer; a retention problem must not cost
    // them a retry and another unit.
    expect(outcome.answer.content).toContain('Early blight');
    expect(outcome.audio).toEqual({ outcome: 'failed', reason: 'remove_failed' });
  });
});

describe('deleteVoiceOriginal — Requirement 8.11', () => {
  it('refuses a path outside the requesting farmer prefix, without calling remove', async () => {
    const storage = storageStub();

    const disposition = await deleteVoiceOriginal(FOREIGN_REF, USER, storage.client);

    expect(disposition).toEqual({ outcome: 'refused', reason: 'prefix_mismatch' });
    expect(storage.removed).toEqual([]);
    // Not even probed: comparing first means a cross-tenant path never reaches the network.
    expect(storage.probed).toEqual([]);
  });

  it('treats an object that is already gone as deleted, not as an error', async () => {
    const storage = storageStub({ exists: false });

    const disposition = await deleteVoiceOriginal(AUDIO_REF, USER, storage.client);

    expect(disposition).toEqual({ outcome: 'already_absent' });
    expect(storage.removed).toEqual([]);
  });

  it('deletes a path under the farmer own prefix', async () => {
    const storage = storageStub();

    const disposition = await deleteVoiceOriginal(AUDIO_REF, USER, storage.client);

    expect(disposition).toEqual({ outcome: 'deleted' });
    expect(storage.removed).toEqual([AUDIO_REF.path]);
  });
});

/* ========================================================================== */
/* Everything that must happen before a unit is spent                          */
/* ========================================================================== */

describe('transcribeAndAnswer — nothing is spent before the reserve', () => {
  it('rejects a reference under another farmer prefix with the counter untouched (2.6)', async () => {
    const test = harness({ rpc: forbiddenCounter });

    const error = await failure(
      transcribeAndAnswer(voiceInput({ storageRef: FOREIGN_REF }), test.deps),
    );

    expect(error.code).toBe('STORAGE_REF_FORBIDDEN');
    expect(error.status).toBe(403);
    expect(test.transcription.calls).toHaveLength(0);
    expect(test.chat.calls).toHaveLength(0);
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
    /**
     * The other half of Requirement 8.2, and until `/api/voice` learned to read the object's size
     * there was nothing server-side to check it with. The number reaches here as an input fact —
     * from Storage on the web path, from V14's media metadata on the WhatsApp path — and the
     * judgement is made once, here, before the reserve.
     */
    const test = harness({ rpc: forbiddenCounter });

    const error = await failure(
      transcribeAndAnswer(voiceInput({ bytes: MAX_AUDIO_BYTES + 1 }), test.deps),
    );

    expect(error.code).toBe('FILE_TOO_LARGE');
    expect(error.status).toBe(400);
    /** The sentence quotes the audio ceiling, not `MAX_IMAGE_BYTES`, whatever the two are worth. */
    expect(error.details?.maxBytes).toBe(MAX_AUDIO_BYTES);
    expect(test.transcription.calls).toHaveLength(0);
    expect(test.chat.calls).toHaveLength(0);
  });

  it('accepts a recording exactly at the size limit and forwards the size to the provider call', async () => {
    /**
     * V10's 25 MB provider cap in `groq.ts` only fires when `TranscribeRequest.bytes` has a value,
     * and nothing on the web path used to supply one. This is the assertion that the floor now has
     * a number under it: unreachable while Jamee's own 10 MB holds, and no longer dead.
     */
    const test = harness();

    await transcribeAndAnswer(voiceInput({ bytes: MAX_AUDIO_BYTES }), test.deps);

    expect(test.transcription.calls[0]?.bytes).toBe(MAX_AUDIO_BYTES);
  });

  it('proceeds with no size check when the size could not be learned', async () => {
    /**
     * A probe that cannot answer must not fail a request whose bytes are already in the bucket and
     * whose ownership has just been confirmed. The key is absent rather than zero, so the adapter
     * skips its own check too instead of comparing against a number nobody measured.
     */
    const test = harness();

    await transcribeAndAnswer(voiceInput(), test.deps);

    expect(test.transcription.calls).toHaveLength(1);
    expect(test.transcription.calls[0]).not.toHaveProperty('bytes');
  });

  it('refuses a container the transcription provider does not accept', async () => {
    // V14 lists `audio/aac` for inbound WhatsApp audio; it is NOT a member of V10's accepted list.
    // Refused here, before the reserve, rather than discovered as a provider rejection.
    const test = harness({ rpc: forbiddenCounter });

    const error = await failure(
      transcribeAndAnswer(voiceInput({ mimeType: 'audio/aac' }), test.deps),
    );

    // `AUDIO_FORMAT_UNSUPPORTED`, not `TRANSCRIPTION_FAILED`: the container is the recorder's
    // choice, so re-sending the identical object fails identically and Requirement 15.4's flag
    // must be false. Task 22.2 added the code for exactly this case.
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

  it('refunds the unit when the signed URL cannot be minted, before any provider call', async () => {
    const counter = counterStub();
    const test = harness({ counter, storage: storageStub({ signable: false }) });

    const error = await failure(transcribeAndAnswer(voiceInput(), test.deps));

    expect(error.code).toBe('INTERNAL_ERROR');
    expect(counter.increments).toBe(1);
    expect(counter.decrements).toBe(1);
    expect(test.transcription.calls).toHaveLength(0);
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

    // `DIAGNOSIS_TIMEOUT`'s message tells the farmer to send the photo again, which is wrong twice
    // over on this path. The audit keeps the distinction the farmer-facing sentence drops.
    expect(error.code).toBe('TRANSCRIPTION_FAILED');
    expect(test.store.usage[0]?.outcome).toBe('timeout');
    expect(test.store.usage[0]?.quota_spent).toBe(true);
    expect(test.storage.removed).toEqual([]);
  });
});

/* ========================================================================== */
/* Container resolution                                                        */
/* ========================================================================== */

describe('audioContainerOf', () => {
  it('prefers the recorder MIME type, which is more specific than the extension', () => {
    expect(audioContainerOf(voiceInput({ mimeType: 'audio/ogg;codecs=opus' }))).toBe(
      'audio/ogg;codecs=opus',
    );
  });

  it('falls back to the object extension when no MIME type was sent', () => {
    expect(audioContainerOf(voiceInput())).toBe('webm');
  });

  it('ignores a blank MIME type rather than declaring an empty container', () => {
    expect(audioContainerOf(voiceInput({ mimeType: '   ' }))).toBe('webm');
  });
});
