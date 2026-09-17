import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ATTEMPT_BUDGETS,
  SOFT_BUDGET_FRACTION,
  SOFT_BUDGET_MS,
  TERMINAL_RESERVE_MS,
} from '@/lib/ai/gateway';
import {
  JAMEE_MAX_DURATION_SECONDS,
  MAX_AUDIO_BYTES,
  TRANSCRIBE_MIN_SECONDS,
} from '@/lib/config/verified';
import type {
  ExistingInbound,
  InboundReceivedRow,
  TerminalInboundStatus,
  WhatsappInboundStore,
} from '@/lib/db/whatsapp-inbound';
import { AppError } from '@/lib/errors';
import { messages } from '@/lib/messages';
import { PROMPT_VERSION } from '@/lib/prompts';
import type {
  ChatAnswer,
  DiagnoseInput,
  DiagnosisResult,
  Language,
  QuotaStatus,
  StorageRef,
  VoiceInput,
} from '@/lib/schemas';
import type {
  InboundMediaResult,
  InboundMessage,
  SendReplyOptions,
  SendReplyResult,
  StoreInboundMediaOptions,
} from '@/lib/whatsapp';
import {
  canStartWithin,
  capabilityFloorFor,
  formatDiagnosisReply,
  formatVoiceReply,
  normalizeInboundPhone,
  processInboundBatch,
  processInboundMessage,
  resolveInvocationBudget,
  resolveProfileByPhone,
  SOFT_DEADLINE_DETAIL,
  UNRESOLVED_SENDER_LANGUAGE,
  WHATSAPP_AUDIO_UNMEASURED_DURATION_SECONDS,
  type ProfileByPhoneStore,
  type WhatsappChatService,
  type WhatsappDispatchDeps,
} from '@/lib/whatsapp-dispatch';
import type { ChatTurnDeps } from '@/services/chat.service';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import type { DiagnosisDeps, DiagnosisOutcome } from '@/services/diagnosis.service';
import type { QuotaContext } from '@/services/quota.service';
import type { NestedChatOutcome, VoiceDeps, VoiceOutcome } from '@/services/voice.service';
import type { Database, TablesInsert } from '@/types/database';

/**
 * Unit tests for the WhatsApp inbound pipeline.
 *
 * Requirements: 10.2, 10.3 (phone → Profile, and the sign-in reply when there is none), 10.4, 10.5,
 *               10.6 (image → DiagnosisService, text → ChatService with the active WhatsApp
 *               conversation, audio → VoiceService, each with `channel: 'whatsapp'`), 10.7 (the
 *               reply carries the service's own Diagnosis_Result content), 10.9 (a type outside
 *               text/image/audio), 10.10 (D11's soft deadline — the invocation's budget, the
 *               per-capability floors, and what an expired batch leaves behind), 10.11 (every
 *               accepted delivery ends in a terminal status), 11.5 (a duplicate spends nothing and
 *               calls nothing), 16.1, 16.2, 16.5
 *
 * Every seam is injected, so nothing here reads an environment variable, opens a socket, or needs
 * Postgres. What that CAN establish is the pipeline's decisions and its ORDER — which service was
 * called, with which channel, what the farmer was sent, which terminal status was written, and what
 * was NOT reached. What it cannot establish is that `claimInbound`'s unique violation is atomic;
 * `whatsapp-inbound.test.ts` says the same, and task 21.5 owns it against real Postgres.
 *
 * The deadline tests inject a clock for the reason `resolveInvocationBudget` exposes one: asserting
 * a 45 s budget against a real wall clock is a test that takes 45 seconds.
 */

/**
 * A partial mock, and only for one assertion: `chatAnswerer` stays the real function everywhere
 * except the test that needs to read the deps the dispatch bound into it. `runOptions` is invisible
 * from outside the closure — `ChatAnswerer` takes an input and a `QuotaContext` and nothing else —
 * so the only way to state "the invocation's deadline reached the ChatService" is to look at the
 * binding call. Every other test injects `deps.chat` directly and never reaches this.
 */
const chatServiceSpy = vi.hoisted(() => ({ chatAnswerer: vi.fn() }));

vi.mock('@/services/chat.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/chat.service')>();
  chatServiceSpy.chatAnswerer.mockImplementation(actual.chatAnswerer);
  return { ...actual, chatAnswerer: chatServiceSpy.chatAnswerer };
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const USER_ID = '7f3a3c58-1a3d-4c1f-9f4e-2b5c8d0e1a22';
const CONVERSATION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const WAMID = 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgg';
/** Meta's `wa_id`: digits, and **no** leading `+`. That gap is what `normalizeInboundPhone` closes. */
const WA_ID = '919876543210';

const IMAGE_REF: StorageRef = {
  bucket: 'crop-images',
  path: `${USER_ID}/2026/03/8f14e45f-ea0f-4d0f-9f2a-1c3b5d7e9f01.jpg`,
};
const AUDIO_REF: StorageRef = {
  bucket: 'voice-messages',
  path: `${USER_ID}/2026/03/8f14e45f-ea0f-4d0f-9f2a-1c3b5d7e9f02.ogg`,
};

const QUOTA: QuotaStatus = { operation: 'image', limit: 20, used: 1, resetsAt: '2026-03-11T18:30:00.000Z' };

/**
 * The injected credential. Never dereferenced — every seam that would use it is stubbed — so what
 * it establishes is that the pipeline threads **one** client through to the service rather than
 * constructing a second, and that a unit test of this module reads no service-role key.
 *
 * Its presence is also what proves the lazy construction works: the branches that return before a
 * service call never ask for it, which is why the refusal tests below can omit it entirely.
 */
const SUPABASE_STUB = { __jameeTestClient: true } as unknown as SupabaseClient<Database>;

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    providerMessageId: WAMID,
    fromPhone: WA_ID,
    timestamp: '1758000000',
    rawType: 'text',
    wabaId: '102290129340398',
    phoneNumberId: '106540352242922',
    displayPhoneNumber: '15550001111',
    content: { kind: 'text', body: 'mere tamatar ke patte peele ho rahe hain' },
    ...overrides,
  };
}

function textMessage(body = 'why?'): InboundMessage {
  return inbound({ rawType: 'text', content: { kind: 'text', body } });
}

function imageMessage(): InboundMessage {
  return inbound({
    rawType: 'image',
    content: { kind: 'image', mediaId: 'media-1', mimeType: 'image/jpeg', provisional: true },
  });
}

function audioMessage(): InboundMessage {
  return inbound({
    rawType: 'audio',
    content: { kind: 'audio', mediaId: 'media-2', mimeType: 'audio/ogg', voice: true, provisional: true },
  });
}

function conversation(): Conversation {
  return {
    id: CONVERSATION_ID,
    user_id: USER_ID,
    channel: 'whatsapp',
    title: null,
    created_at: '2026-03-10T04:00:00.000Z',
    updated_at: '2026-03-10T04:00:00.000Z',
  };
}

const IDENTIFIED: DiagnosisResult = {
  status: 'identified',
  diseaseName: 'Tomato Early Blight',
  confidence: 0.82,
  severity: 'moderate',
  explanation: 'Dark spots with rings are appearing on the lower leaves.',
  knowledge: {
    symptoms: ['dark concentric spots'],
    causes: ['Alternaria solani'],
    treatment: ['remove affected leaves'],
    prevention: ['rotate crops'],
    source: 'extension service',
  },
  needsExpert: false,
  language: 'en',
};

const INCONCLUSIVE: DiagnosisResult = {
  status: 'unknown',
  diseaseName: null,
  confidence: null,
  severity: 'none',
  explanation: 'Jamee could not judge this photo.',
  knowledge: null,
  needsExpert: true,
  language: 'en',
};

function chatAnswer(content: string): ChatAnswer {
  return {
    messageId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
    content,
    language: 'en',
    groundedIn: ['Tomato Early Blight'],
    needsExpert: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Stubs                                                                       */
/* -------------------------------------------------------------------------- */

interface InboundStoreStub {
  readonly store: WhatsappInboundStore;
  readonly inserted: InboundReceivedRow[];
  readonly attached: { readonly providerMessageId: string; readonly userId: string }[];
  readonly transitions: TerminalInboundStatus[];
  readonly usage: unknown[];
}

/**
 * A `whatsapp_inbound` store backed by a map. `duplicate` makes the first insert conflict, which is
 * the only way to reach Requirement 11.5's branch without a real unique index.
 */
function inboundStoreStub(options: { duplicate?: ExistingInbound } = {}): InboundStoreStub {
  const inserted: InboundReceivedRow[] = [];
  const attached: { providerMessageId: string; userId: string }[] = [];
  const transitions: TerminalInboundStatus[] = [];
  const usage: unknown[] = [];
  const duplicate = options.duplicate;

  const store: WhatsappInboundStore = {
    async insertReceived(row) {
      if (duplicate !== undefined) {
        return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
      }
      inserted.push(row);
      return { error: null };
    },
    async readExisting() {
      return { data: duplicate ?? null, error: null };
    },
    async attachUser(providerMessageId, userId) {
      attached.push({ providerMessageId, userId });
      return { error: null };
    },
    async transitionFromReceived(_providerMessageId, status) {
      transitions.push(status);
      return { data: [{ status }], error: null };
    },
    async insertUsageLog(row) {
      usage.push(row);
      return { error: null };
    },
  };

  return { store, inserted, attached, transitions, usage };
}

function profileStub(profile: { id: string; language: string } | null): ProfileByPhoneStore {
  return {
    async byPhone() {
      return { data: profile, error: null };
    },
  };
}

interface ConversationStub {
  readonly store: ConversationStore;
  readonly created: number;
}

function conversationStub(): ConversationStub {
  const state = { created: 0 };
  const store: ConversationStore = {
    async mostRecent() {
      return conversation();
    },
    async create() {
      state.created += 1;
      return conversation();
    },
  };
  return {
    store,
    get created() {
      return state.created;
    },
  };
}

interface Harness {
  readonly deps: WhatsappDispatchDeps;
  readonly inboundStore: InboundStoreStub;
  readonly conversations: ConversationStub;
  readonly sent: SendReplyOptions[];
  readonly diagnoseCalls: DiagnoseInput[];
  readonly diagnoseDeps: DiagnosisDeps[];
  readonly chatCalls: { readonly input: Parameters<WhatsappChatService>[0]; readonly coverage: QuotaContext }[];
  readonly voiceCalls: VoiceInput[];
  readonly voiceDeps: VoiceDeps[];
  readonly mediaCalls: StoreInboundMediaOptions[];
  /**
   * Rows written through `deps.usage`, which on this channel is the pre-flight soft-deadline row and
   * nothing else. Every other audit row is written by the service that did the work, so a
   * `processed` delivery leaves this empty here even though rows exist in the real database.
   */
  readonly usageRows: TablesInsert<'usage_logs'>[];
}

/**
 * The pipeline with every seam injected and every service **succeeding**. Each test then replaces
 * exactly the one seam whose behaviour it is about, so a failure names the branch it broke.
 *
 * `forbidden*` helpers below are the other half: a seam that must not be reached at all is bound to
 * a function that fails the test if it is, which is how "spends nothing" and "invokes no shared
 * service" are asserted rather than assumed.
 */
function harness(
  options: {
    readonly profile?: { id: string; language: string } | null;
    readonly duplicate?: ExistingInbound;
    readonly diagnosisResult?: DiagnosisResult;
    readonly media?: InboundMediaResult;
    readonly send?: SendReplyResult;
    readonly diagnoseError?: unknown;
    readonly voiceError?: unknown;
    readonly chatError?: unknown;
  } = {},
): Harness {
  const inboundStore = inboundStoreStub(
    options.duplicate === undefined ? {} : { duplicate: options.duplicate },
  );
  const conversations = conversationStub();
  const sent: SendReplyOptions[] = [];
  const diagnoseCalls: DiagnoseInput[] = [];
  const diagnoseDeps: DiagnosisDeps[] = [];
  const chatCalls: { input: Parameters<WhatsappChatService>[0]; coverage: QuotaContext }[] = [];
  const voiceCalls: VoiceInput[] = [];
  const voiceDeps: VoiceDeps[] = [];
  const mediaCalls: StoreInboundMediaOptions[] = [];
  const usageRows: TablesInsert<'usage_logs'>[] = [];

  const chat: WhatsappChatService = async (input, coverage): Promise<NestedChatOutcome> => {
    chatCalls.push({ input, coverage });
    if (options.chatError !== undefined) throw options.chatError;
    return {
      conversationId: CONVERSATION_ID,
      farmerMessageId: 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f',
      answer: chatAnswer('Remove the affected leaves and keep the foliage dry.'),
      quota: { ...QUOTA, operation: 'chat', limit: 50 },
    };
  };

  const deps: WhatsappDispatchDeps = {
    chat,
    supabase: SUPABASE_STUB,
    inbound: { store: inboundStore.store },
    usage: {
      insertUsageLog: async (row) => {
        usageRows.push(row);
      },
    },
    profiles: profileStub(
      options.profile === undefined ? { id: USER_ID, language: 'en' } : options.profile,
    ),
    conversations: conversations.store,
    diagnose: async (input, serviceDeps): Promise<DiagnosisOutcome> => {
      diagnoseCalls.push(input);
      diagnoseDeps.push(serviceDeps);
      if (options.diagnoseError !== undefined) throw options.diagnoseError;
      return {
        diagnosisId: 'd4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f80',
        conversationId: CONVERSATION_ID,
        result: options.diagnosisResult ?? IDENTIFIED,
        quota: QUOTA,
        provider: 'gemini',
        usedFallback: false,
      };
    },
    voice: async (input, serviceDeps): Promise<VoiceOutcome> => {
      voiceCalls.push(input);
      voiceDeps.push(serviceDeps);
      if (options.voiceError !== undefined) throw options.voiceError;
      return {
        transcript: 'mere tamatar ke patte peele ho rahe hain',
        answer: chatAnswer('Remove the affected leaves and keep the foliage dry.'),
        conversationId: CONVERSATION_ID,
        quota: { ...QUOTA, operation: 'voice' },
        farmerMessageId: 'e5f6a7b8-c9d0-4e1f-8a3b-4c5d6e7f8091',
        provider: 'groq',
        usedFallback: false,
        audio: { outcome: 'deleted' },
      };
    },
    media: async (input): Promise<InboundMediaResult> => {
      mediaCalls.push(input);
      return (
        options.media ?? {
          ok: true,
          ref: input.content.kind === 'image' ? IMAGE_REF : AUDIO_REF,
          kind: input.content.kind,
          mimeType: input.content.kind === 'image' ? 'image/jpeg' : 'audio/ogg',
          bytes: 120_000,
        }
      );
    },
    send: async (input): Promise<SendReplyResult> => {
      sent.push(input);
      return options.send ?? { ok: true, sentMessageId: 'wamid.OUT001', bodyChars: input.body.length };
    },
  };

  return {
    deps,
    inboundStore,
    conversations,
    sent,
    diagnoseCalls,
    diagnoseDeps,
    chatCalls,
    voiceCalls,
    voiceDeps,
    mediaCalls,
    usageRows,
  };
}

/** A seam that must not be reached. Reaching it throws, which fails the test that bound it. */
function forbidden(name: string): never {
  throw new Error(`${name} was called on a path that must reach no service`);
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

/* ========================================================================== */
/* Requirement 10.2 — the `wa_id` → E.164 normalization                         */
/* ========================================================================== */

describe('normalizeInboundPhone: the wa_id is not what profiles.phone stores', () => {
  it("adds the leading + Meta omits, because profiles_phone_e164 requires it", () => {
    // The whole channel turns on this line. Without it every farmer is told to sign in.
    expect(normalizeInboundPhone('919876543210')).toBe('+919876543210');
  });

  it('leaves an already-E.164 number alone and tolerates surrounding whitespace', () => {
    expect(normalizeInboundPhone('+919876543210')).toBe('+919876543210');
    expect(normalizeInboundPhone('  919876543210  ')).toBe('+919876543210');
  });

  it.each([
    ['empty', ''],
    ['leading zero after the +', '019876543210'],
    ['too short', '1234567'],
    ['too long', '1234567890123456'],
    ['non-digits', '91987-654-3210'],
  ])('returns null for %s rather than querying a value the check constraint forbids', (_label, raw) => {
    expect(normalizeInboundPhone(raw)).toBeNull();
  });

  it('never queries when the number cannot satisfy E.164', async () => {
    let queries = 0;
    const store: ProfileByPhoneStore = {
      async byPhone() {
        queries += 1;
        return { data: null, error: null };
      },
    };

    expect(await resolveProfileByPhone('not-a-number', store)).toBeNull();
    expect(queries).toBe(0);
  });

  it('queries with the normalized number and returns the profile', async () => {
    const queried: string[] = [];
    const store: ProfileByPhoneStore = {
      async byPhone(phone) {
        queried.push(phone);
        return { data: { id: USER_ID, language: 'mr' }, error: null };
      },
    };

    expect(await resolveProfileByPhone(WA_ID, store)).toEqual({ userId: USER_ID, language: 'mr' });
    expect(queried).toEqual(['+919876543210']);
  });

  it('throws rather than reporting "no profile" when the lookup itself fails', async () => {
    // `null` would send a registered farmer sign-in instructions and mark the row `rejected`, which
    // Meta never redelivers past. A throw becomes a 500, and V13 says Meta redelivers on that.
    const store: ProfileByPhoneStore = {
      async byPhone() {
        return { data: null, error: { code: '57014', message: 'statement timeout' } };
      },
    };

    await expect(resolveProfileByPhone(WA_ID, store)).rejects.toThrow(AppError);
  });

  it('falls back to the default language rather than throwing on an unparseable language column', async () => {
    const store = profileStub({ id: USER_ID, language: 'fr' });
    const resolved = await resolveProfileByPhone(WA_ID, store);

    expect(resolved).toEqual({ userId: USER_ID, language: UNRESOLVED_SENDER_LANGUAGE });
  });
});

/* ========================================================================== */
/* Requirement 11.5 — a duplicate spends nothing and calls nothing              */
/* ========================================================================== */

describe('Requirement 11.5: a redelivery is dropped before anything is reachable', () => {
  it('sends no reply, resolves no profile, calls no service, and writes no transition', async () => {
    const test = harness({ duplicate: { user_id: USER_ID, status: 'processed', message_type: 'image' } });
    const deps: WhatsappDispatchDeps = {
      ...test.deps,
      profiles: { byPhone: () => forbidden('profiles.byPhone') },
      diagnose: () => forbidden('diagnose'),
      chat: () => forbidden('chat'),
      voice: () => forbidden('transcribeAndAnswer'),
      media: () => forbidden('storeInboundMedia'),
      send: () => forbidden('sendWhatsappText'),
    };

    const result = await processInboundMessage(imageMessage(), deps);

    expect(result.disposition).toBe('duplicate_ignored');
    expect(result.replySent).toBe(false);
    expect(test.inboundStore.transitions).toEqual([]);
    // The `duplicate_ignored` audit row records `quota_spent: false` explicitly.
    expect(test.inboundStore.usage).toHaveLength(1);
  });
});

/* ========================================================================== */
/* Requirement 10.3 — an unresolvable number                                   */
/* ========================================================================== */

describe('Requirement 10.3: a phone number with no Profile', () => {
  it('sends sign-in instructions, marks rejected, and reaches no service', async () => {
    const test = harness({ profile: null });
    const deps: WhatsappDispatchDeps = {
      ...test.deps,
      diagnose: () => forbidden('diagnose'),
      chat: () => forbidden('chat'),
      voice: () => forbidden('transcribeAndAnswer'),
      media: () => forbidden('storeInboundMedia'),
    };

    const result = await processInboundMessage(imageMessage(), deps);

    expect(result.disposition).toBe('rejected_unresolved_sender');
    expect(result.replySent).toBe(true);
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]?.body).toBe(messages(UNRESOLVED_SENDER_LANGUAGE).whatsapp.signInFirst);
    // The reply goes back to the `wa_id` Meta supplied, not to a number derived from a database row.
    expect(test.sent[0]?.to).toBe(WA_ID);
    expect(test.inboundStore.transitions).toEqual(['rejected']);
    // No profile means nothing to attach, and `usage_logs.user_id` is not null — so no audit row.
    expect(test.inboundStore.attached).toEqual([]);
  });
});

/* ========================================================================== */
/* Requirement 10.9 — a type outside text, image and audio                     */
/* ========================================================================== */

describe('Requirement 10.9: an unsupported message type', () => {
  it('names photos, text and voice notes, marks rejected, and calls nothing', async () => {
    const test = harness();
    const deps: WhatsappDispatchDeps = {
      ...test.deps,
      diagnose: () => forbidden('diagnose'),
      chat: () => forbidden('chat'),
      voice: () => forbidden('transcribeAndAnswer'),
      media: () => forbidden('storeInboundMedia'),
    };

    const result = await processInboundMessage(
      inbound({
        rawType: 'sticker',
        content: { kind: 'unsupported', type: 'sticker', reason: 'type_outside_supported_set' },
      }),
      deps,
    );

    expect(result.disposition).toBe('rejected_unsupported_type');
    expect(test.sent[0]?.body).toBe(messages('en').whatsapp.unsupportedType);
    expect(test.inboundStore.transitions).toEqual(['rejected']);
    // The conversation is not created for a message Jamee will not act on.
    expect(test.conversations.created).toBe(0);
  });

  it('does NOT use 10.9 sentence for a text message missing its confirmed text.body', async () => {
    const test = harness();

    const result = await processInboundMessage(
      inbound({
        rawType: 'text',
        content: { kind: 'unsupported', type: 'text', reason: 'confirmed_field_absent' },
      }),
      test.deps,
    );

    // A `text` message with no `text.body` contradicts a path V12 CONFIRMS. Telling a farmer who
    // sent text that Jamee does not accept text would be false.
    expect(result.disposition).toBe('failed');
    expect(result.detail).toBe('confirmed_field_absent');
    expect(test.sent[0]?.body).not.toBe(messages('en').whatsapp.unsupportedType);
    expect(test.sent[0]?.body).toBe(messages('en').errors.INTERNAL_ERROR);
    expect(test.inboundStore.transitions).toEqual(['failed']);
  });

  it('fails loudly on the U-V12 unconfirmed media shape instead of answering 10.9', async () => {
    const test = harness();

    const result = await processInboundMessage(
      inbound({
        rawType: 'image',
        content: {
          kind: 'unconfirmed_media_shape',
          type: 'image',
          observedKeys: ['media_id', 'mimetype'],
          issue: 'id: Required',
        },
      }),
      test.deps,
    );

    // A photo IS a photo, so 10.9's sentence would be untrue. `failed` plus the logged keys is the
    // deployment capture U-V12 asks for.
    expect(result.disposition).toBe('failed');
    expect(result.detail).toBe('unconfirmed_media_shape');
    expect(test.sent[0]?.body).not.toBe(messages('en').whatsapp.unsupportedType);
    expect(test.inboundStore.transitions).toEqual(['failed']);
  });
});

/* ========================================================================== */
/* Requirements 10.4, 10.5, 10.6, 16.1, 16.2, 16.5 — the dispatch table          */
/* ========================================================================== */

describe('the three kinds reach the three shared services with channel: whatsapp', () => {
  it('image → DiagnosisService with the uploaded Storage_Reference (10.4)', async () => {
    const test = harness();

    const result = await processInboundMessage(imageMessage(), test.deps);

    expect(test.mediaCalls).toHaveLength(1);
    expect(test.mediaCalls[0]?.userId).toBe(USER_ID);
    expect(test.diagnoseCalls).toEqual([
      {
        userId: USER_ID,
        storageRef: IMAGE_REF,
        language: 'en',
        channel: 'whatsapp',
        conversationId: CONVERSATION_ID,
      },
    ]);
    expect(result.disposition).toBe('processed');
    expect(test.inboundStore.transitions).toEqual(['processed']);
    // The service-role client, threaded through rather than built a second time inside the service.
    expect(test.diagnoseDeps[0]?.supabase).toBe(SUPABASE_STUB);
    // Neither of the other two services was involved.
    expect(test.chatCalls).toEqual([]);
    expect(test.voiceCalls).toEqual([]);
  });

  it('text → ChatService with the active WhatsApp conversation, owning its chat unit (10.5)', async () => {
    const test = harness();

    const result = await processInboundMessage(textMessage('why is this happening?'), test.deps);

    expect(test.chatCalls).toHaveLength(1);
    expect(test.chatCalls[0]?.input).toEqual({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      message: 'why is this happening?',
      language: 'en',
      channel: 'whatsapp',
      inputKind: 'text',
    });
    /**
     * The reserve decision, carried as a branded `QuotaContext`: a typed WhatsApp question is the
     * entry point for its own request, so the ChatService takes the `chat` unit. A voice request's
     * nested chat call gets `coveredBy(...)` instead and reserves nothing.
     */
    expect(test.chatCalls[0]?.coverage).toEqual({
      role: 'owns_request',
      userId: USER_ID,
      operation: 'chat',
    });
    expect(result.disposition).toBe('processed');
    expect(test.mediaCalls).toEqual([]);
  });

  it('audio → VoiceService with the uploaded reference and the observed container (10.6)', async () => {
    const test = harness();

    const result = await processInboundMessage(audioMessage(), test.deps);

    expect(test.voiceCalls).toEqual([
      {
        userId: USER_ID,
        storageRef: AUDIO_REF,
        language: 'en',
        channel: 'whatsapp',
        conversationId: CONVERSATION_ID,
        durationSeconds: WHATSAPP_AUDIO_UNMEASURED_DURATION_SECONDS,
        mimeType: 'audio/ogg',
      },
    ]);
    // WhatsApp reports no duration, so the adapter declares V10's documented minimum and lets the
    // size cap — already enforced before the reserve — be the operative bound.
    expect(WHATSAPP_AUDIO_UNMEASURED_DURATION_SECONDS).toBe(TRANSCRIBE_MIN_SECONDS);
    expect(result.disposition).toBe('processed');
    // The nested chat call belongs to the VoiceService, not to this module — the binding is handed
    // over so the voice unit covers the answer and no `chat` unit is reserved.
    expect(test.chatCalls).toEqual([]);
    expect(test.voiceDeps[0]?.chat).toBe(test.deps.chat);
  });

  it('uses one long-running WhatsApp thread rather than a new one per message (10.8)', async () => {
    const test = harness();

    await processInboundBatch([imageMessage(), textMessage()], test.deps);

    expect(test.conversations.created).toBe(0);
    expect(test.diagnoseCalls[0]?.conversationId).toBe(CONVERSATION_ID);
    expect(test.chatCalls[0]?.input.conversationId).toBe(CONVERSATION_ID);
  });
});

/* ========================================================================== */
/* Media refusal — spends nothing, before any service                          */
/* ========================================================================== */

describe('a media item outside the accepted type or size', () => {
  it('sends the refusal verbatim, marks rejected, and calls no service', async () => {
    const refusalReply = messages('en').whatsapp.voiceNoteFormatUnsupported;
    const test = harness({
      media: {
        ok: false,
        refusal: {
          reason: 'voice_container_unsupported',
          kind: 'audio',
          reply: refusalReply,
          mimeType: 'audio/aac',
          bytes: 40_000,
          capBytes: MAX_AUDIO_BYTES,
          capOwner: 'jamee',
        },
      },
    });
    const deps: WhatsappDispatchDeps = {
      ...test.deps,
      diagnose: () => forbidden('diagnose'),
      voice: () => forbidden('transcribeAndAnswer'),
    };

    const result = await processInboundMessage(audioMessage(), deps);

    expect(result.disposition).toBe('rejected_media');
    // The refusal's own localized sentence, built from the web path's copy — not re-worded here.
    expect(test.sent[0]?.body).toBe(refusalReply);
    expect(test.inboundStore.transitions).toEqual(['rejected']);
  });
});

/* ========================================================================== */
/* A failing service                                                           */
/* ========================================================================== */

describe('a service failure becomes a localized reply and a `failed` row', () => {
  it('renders the coded error in the farmer\u2019s language and leaks nothing', async () => {
    const test = harness({
      profile: { id: USER_ID, language: 'mr' },
      diagnoseError: new AppError('QUOTA_EXCEEDED', {
        details: { limit: 20, used: 20, resetsAt: '2026-03-11T18:30:00.000Z' },
        cause: new Error('gemini says: internal trace 0xdeadbeef'),
      }),
    });

    const result = await processInboundMessage(imageMessage(), test.deps);

    expect(result.disposition).toBe('failed');
    expect(result.detail).toBe('service_failed:QUOTA_EXCEEDED');
    const body = test.sent[0]?.body ?? '';
    // Requirement 14.3's limit and reset, in Marathi. Requirement 15.6: no cause, no stack.
    expect(body).toContain('20');
    expect(body).not.toContain('deadbeef');
    expect(body).not.toContain('gemini');
    expect(test.inboundStore.transitions).toEqual(['failed']);
  });

  it('answers a non-AppError throw with the generic internal message', async () => {
    const test = harness({ diagnoseError: new TypeError('undefined is not a function') });

    const result = await processInboundMessage(imageMessage(), test.deps);

    expect(result.disposition).toBe('failed');
    expect(test.sent[0]?.body).toBe(messages('en').errors.INTERNAL_ERROR);
    expect(test.sent[0]?.body).not.toContain('undefined is not a function');
  });
});

/* ========================================================================== */
/* Step 7 before step 8                                                        */
/* ========================================================================== */

describe('the reply is sent before the row is marked processed', () => {
  it('marks `failed`, not `processed`, when Meta rejects the send', async () => {
    const test = harness({ send: { ok: false, status: 400, detail: 'outside the 24-hour window' } });

    const result = await processInboundMessage(imageMessage(), test.deps);

    // V15 records that a send can fail inside an apparently open window. Marking this `processed`
    // would assert a reply the farmer never received.
    expect(result.disposition).toBe('failed');
    expect(result.detail).toBe('reply_send_failed');
    expect(result.replySent).toBe(false);
    expect(test.inboundStore.transitions).toEqual(['failed']);
    // The work really did happen, so the unit is spent and is not refunded here.
    expect(test.diagnoseCalls).toHaveLength(1);
  });

  it('claims the row before resolving the profile', async () => {
    const order: string[] = [];
    const test = harness();
    const deps: WhatsappDispatchDeps = {
      ...test.deps,
      inbound: {
        store: {
          ...test.deps.inbound?.store as WhatsappInboundStore,
          async insertReceived(row) {
            order.push('claim');
            return (test.deps.inbound?.store as WhatsappInboundStore).insertReceived(row);
          },
        },
      },
      profiles: {
        async byPhone() {
          order.push('profile');
          return { data: { id: USER_ID, language: 'en' }, error: null };
        },
      },
    };

    await processInboundMessage(imageMessage(), deps);

    expect(order).toEqual(['claim', 'profile']);
  });
});

/* ========================================================================== */
/* The batch                                                                   */
/* ========================================================================== */

describe('a batched delivery', () => {
  it('gives every message its own terminal status rather than one for the batch', async () => {
    const test = harness();

    const results = await processInboundBatch(
      [
        imageMessage(),
        inbound({
          providerMessageId: 'wamid.SECOND',
          rawType: 'location',
          content: { kind: 'unsupported', type: 'location', reason: 'type_outside_supported_set' },
        }),
        textMessage('and what about the fruit?'),
      ],
      test.deps,
    );

    expect(results.map((result) => result.disposition)).toEqual([
      'processed',
      'rejected_unsupported_type',
      'processed',
    ]);
    // V13 allows up to 1000 updates in one notification; a batch-wide mark would have discarded
    // the entries it did not reach.
    expect(test.inboundStore.transitions).toEqual(['processed', 'rejected', 'processed']);
    expect(test.sent).toHaveLength(3);
  });
});

/* ========================================================================== */
/* Requirement 10.7 — the reply carries the service's own content               */
/* ========================================================================== */

describe('Requirement 10.7: the reply is the service\u2019s Diagnosis_Result, unaltered', () => {
  it('leads with the canonical name in Latin script and carries the explanation verbatim', () => {
    const reply = formatDiagnosisReply(IDENTIFIED, 'en');

    expect(reply.startsWith('Tomato Early Blight')).toBe(true);
    expect(reply).toContain(IDENTIFIED.explanation);
    expect(reply).toContain(messages('en').severity.moderate);
    // `needsExpert` is `false` by type on an identified result, so the banner must not appear.
    expect(reply).not.toContain(messages('en').ui.needsExpertBanner);
  });

  it('keeps the canonical name in Latin script when the language is Marathi (4.6, 9.4)', () => {
    const reply = formatDiagnosisReply({ ...IDENTIFIED, language: 'mr' }, 'mr');

    expect(reply).toContain('Tomato Early Blight');
    expect(reply).toContain(messages('mr').severity.moderate);
  });

  it('labels an inconclusive result and appends the expert banner (6.4)', () => {
    const reply = formatDiagnosisReply(INCONCLUSIVE, 'hi');

    expect(reply).toContain(messages('hi').ui.inconclusiveLabel);
    expect(reply).toContain(INCONCLUSIVE.explanation);
    expect(reply).toContain(messages('hi').ui.needsExpertBanner);
    // Requirement 6.5: nothing about treatment can be rendered — `knowledge` is `null` by type.
    expect(reply).not.toContain(messages('hi').ui.treatmentHeading);
  });

  it('shows the farmer what Jamee heard above the answer on the voice path (8.6)', () => {
    const reply = formatVoiceReply('patte peele ho rahe hain', 'Remove the affected leaves.', 'en');

    expect(reply.indexOf('patte peele')).toBeLessThan(reply.indexOf('Remove the affected leaves.'));
    expect(reply).toContain(messages('en').ui.transcriptLabel);
  });
});

/* ========================================================================== */
/* Every reply is in the farmer's own language                                 */
/* ========================================================================== */

describe('Requirement 15.3: replies are written in the profile\u2019s preferred language', () => {
  it.each<Language>(['en', 'hi', 'mr'])('answers an unsupported type in %s', async (language) => {
    const test = harness({ profile: { id: USER_ID, language } });

    await processInboundMessage(
      inbound({
        rawType: 'contacts',
        content: { kind: 'unsupported', type: 'contacts', reason: 'type_outside_supported_set' },
      }),
      test.deps,
    );

    expect(test.sent[0]?.body).toBe(messages(language).whatsapp.unsupportedType);
  });
});

/* ========================================================================== */
/* Requirement 10.10 — D11's soft deadline (task 22.3)                          */
/* ========================================================================== */

describe('resolveInvocationBudget: the gateway\u2019s budget, not a second opinion', () => {
  it('derives the deadline from the invocation start and the gateway\u2019s soft budget', () => {
    const start = 1_700_000_000_000;
    const budget = resolveInvocationBudget({
      now: () => start,
      requestStartMs: start,
      // No platform deadline: local development and this test. The 45 s arithmetic stands in.
      platformDeadline: () => undefined,
    });

    expect(budget.deadlineMs).toBe(start + SOFT_BUDGET_MS);
    // D11: "a fraction of the configured ceiling, same constant as the gateway budget". This is the
    // assertion that there is no second number — 0.75 × 60 s, and 60 s is Jamee's own ceiling.
    expect(SOFT_BUDGET_MS).toBe(SOFT_BUDGET_FRACTION * JAMEE_MAX_DURATION_SECONDS * 1000);
    expect(SOFT_BUDGET_MS).toBe(45_000);
  });

  it('takes the platform deadline minus the terminal reserve when it is tighter (V18)', () => {
    const start = 1_700_000_000_000;
    // A warm invocation with 20 s of platform life left: less than 45 s, so it wins.
    const budget = resolveInvocationBudget({
      now: () => start,
      requestStartMs: start,
      platformDeadline: () => new Date(start + 20_000),
    });

    expect(budget.deadlineMs).toBe(start + 20_000 - TERMINAL_RESERVE_MS);
    // The reserve is what pays for the reply, the `markFailed` and the `usage_logs` row after expiry.
    expect(TERMINAL_RESERVE_MS).toBe(15_000);
  });

  it('keeps Jamee\u2019s 45 s when the platform would allow more', () => {
    const start = 1_700_000_000_000;
    const budget = resolveInvocationBudget({
      now: () => start,
      requestStartMs: start,
      // V16 records 300 s as the plan maximum. Jamee declines to use it.
      platformDeadline: () => new Date(start + 300_000),
    });

    expect(budget.deadlineMs).toBe(start + SOFT_BUDGET_MS);
  });

  it('uses an already-resolved deadline as given, which is how a batch shares one', () => {
    const budget = resolveInvocationBudget({ now: () => 5_000, deadlineMs: 42_000 });

    expect(budget.deadlineMs).toBe(42_000);
  });

  it('tolerates a platform deadline that is not a usable instant', () => {
    const start = 1_700_000_000_000;
    const budget = resolveInvocationBudget({
      now: () => start,
      requestStartMs: start,
      platformDeadline: () => new Date(Number.NaN),
    });

    expect(budget.deadlineMs).toBe(start + SOFT_BUDGET_MS);
  });
});

describe('canStartWithin: a spend rule, taken from the gateway\u2019s own floors', () => {
  const budgetWith = (remainingMs: number) =>
    resolveInvocationBudget({ now: () => 1_000, deadlineMs: 1_000 + remainingMs });

  it('maps each message kind onto the capability it will reach', () => {
    expect(capabilityFloorFor({ kind: 'text', body: 'why?' })).toBe('text-generate');
    expect(
      capabilityFloorFor({ kind: 'image', mediaId: 'm', mimeType: 'image/jpeg', provisional: true }),
    ).toBe('vision-classify');
    expect(
      capabilityFloorFor({
        kind: 'audio',
        mediaId: 'm',
        mimeType: 'audio/ogg',
        voice: true,
        provisional: true,
      }),
    ).toBe('transcribe');
    // No provider is reachable, so no floor applies.
    expect(
      capabilityFloorFor({ kind: 'unsupported', type: 'location', reason: 'type_outside_supported_set' }),
    ).toBeNull();
  });

  it('refuses a photo below vision-classify\u2019s minimum even though the deadline has not passed', () => {
    const floor = ATTEMPT_BUDGETS['vision-classify'].minimumRemainingMs;
    const content = imageMessage().content;

    expect(canStartWithin(content, budgetWith(floor))).toBe(true);
    expect(canStartWithin(content, budgetWith(floor - 1))).toBe(false);
  });

  it('applies a lower floor to a typed question than to a photo, because the work differs', () => {
    const remaining = ATTEMPT_BUDGETS['vision-classify'].minimumRemainingMs - 1;

    // 5 999 ms: enough to begin a `text-generate` (5 000 ms floor), not a classification.
    expect(canStartWithin(textMessage().content, budgetWith(remaining))).toBe(true);
    expect(canStartWithin(imageMessage().content, budgetWith(remaining))).toBe(false);
    // And audio has the highest floor of the three — the upload dominates it.
    expect(canStartWithin(audioMessage().content, budgetWith(remaining))).toBe(false);
    expect(ATTEMPT_BUDGETS.transcribe.minimumRemainingMs).toBeGreaterThan(
      ATTEMPT_BUDGETS['text-generate'].minimumRemainingMs,
    );
  });

  it('still answers a refusal past the deadline, because a refusal spends nothing', () => {
    const sticker = inbound({
      rawType: 'sticker',
      content: { kind: 'unsupported', type: 'sticker', reason: 'type_outside_supported_set' },
    }).content;

    // Requirement 10.9's sentence is more use to that farmer than "taking longer on this photo",
    // and it costs the same single send the deadline branch would have cost.
    expect(canStartWithin(sticker, budgetWith(-60_000))).toBe(true);
  });
});

describe('the soft-deadline branch: told, marked failed, and still acknowledged', () => {
  it('replies in the farmer\u2019s language, marks the row failed, and reaches no service', async () => {
    const test = harness({ profile: { id: USER_ID, language: 'mr' } });
    const deps: WhatsappDispatchDeps = {
      ...test.deps,
      // Requirement 10.10's whole point: an expired budget spends nothing further. `storeInboundMedia`
      // is on this list because it is the step that would fetch Meta's media bytes, and it reads no
      // clock of its own.
      diagnose: () => forbidden('diagnose'),
      media: () => forbidden('storeInboundMedia'),
      deadline: { now: () => 10_000, deadlineMs: 10_000 },
    };

    const result = await processInboundMessage(imageMessage(), deps);

    expect(result.disposition).toBe('failed');
    expect(result.detail).toBe(SOFT_DEADLINE_DETAIL);
    expect(result.replySent).toBe(true);
    expect(test.sent[0]?.body).toBe(messages('mr').whatsapp.takingLonger);
    // `failed`, not `processed`: D11 is explicit that the audit stays honest.
    expect(test.inboundStore.transitions).toEqual(['failed']);
    // And the row is attributable — the profile read above the gate is what buys that, and the
    // localized sentence.
    expect(test.inboundStore.attached).toEqual([{ providerMessageId: WAMID, userId: USER_ID }]);
  });

  it('records the pre-flight refusal as a timeout that spent nothing (3.7)', async () => {
    /**
     * The audit gap task 22.3 left open and task 24.3 closed.
     *
     * The gate wrote no `usage_logs` row, on the argument that nothing reached a provider. That
     * argument answers Requirement 14.6 — no model operation completed — and it answers 14.7, since a
     * request that made no gateway call has no fallback to record. It does **not** answer Requirement
     * 3.7, which asks for the outcome to be recorded whenever the duration ceiling is reached before a
     * result exists, and does not distinguish reaching it before the first provider call from reaching
     * it during one. D11's soft deadline is a fraction of that same ceiling, so this branch is 3.7's
     * antecedent.
     */
    const test = harness();
    const deps: WhatsappDispatchDeps = {
      ...test.deps,
      diagnose: () => forbidden('diagnose'),
      media: () => forbidden('storeInboundMedia'),
      // One pinned instant for the start and the refusal, so `latency_ms` is exactly 0.
      deadline: { now: () => 10_000, deadlineMs: 10_000 },
    };

    await processInboundMessage(imageMessage(), deps);

    expect(test.usageRows).toHaveLength(1);
    expect(test.usageRows[0]).toEqual({
      // Attributable because step 3b attached the profile one line above the gate.
      user_id: USER_ID,
      // Keyed on the parsed `content.kind`, so a payload Jamee never routed cannot be audited as an
      // operation it did.
      operation: 'image',
      channel: 'whatsapp',
      // 0006's positive statement that no provider served this row.
      model_provider: 'none',
      // Requirement 3.7's value. 0011 documents it as "a budget expiry, pre-flight or in-flight".
      outcome: 'timeout',
      used_fallback: false,
      rejection_reason: null,
      /**
       * The spend rule's biconditional in the direction it is usually not read: **no** provider call
       * was attempted, so no unit is spent. The reserve lives inside the service this gate refuses to
       * call, so there is nothing to refund either — unlike an in-flight timeout, which is
       * `quota_spent: true` and deliberately not refunded because a call really was issued.
       */
      quota_spent: false,
      latency_ms: 0,
      prompt_version: PROMPT_VERSION,
      conversation_id: null,
      diagnosis_id: null,
    });
  });

  it('writes the same timeout row for a typed question, not only for a photo', async () => {
    // A `group by outcome` answering "how often did Jamee run out of time" for photos only would be
    // answering a different question from the one an operator asked.
    const test = harness();

    await processInboundMessage(textMessage(), {
      ...test.deps,
      chat: () => forbidden('chatTurn'),
      deadline: { now: () => 10_000, deadlineMs: 10_000 },
    });

    expect(test.usageRows[0]).toMatchObject({ operation: 'chat', outcome: 'timeout', quota_spent: false });
  });

  it('writes no row for a message the gate never refuses', async () => {
    /**
     * A sticker has no capability floor, so `canStartWithin` admits it past an expired deadline and it
     * is answered from the message catalog for the cost of one send. There is no timeout to record
     * because there was no work to run out of time — and `usage_logs.operation` is `not null` with a
     * three-value constraint, so a row would have to invent an operation Jamee never routed.
     */
    const test = harness();

    const result = await processInboundMessage(
      inbound({
        rawType: 'sticker',
        content: { kind: 'unsupported', type: 'sticker', reason: 'type_outside_supported_set' },
      }),
      { ...test.deps, deadline: { now: () => 10_000, deadlineMs: 10_000 } },
    );

    expect(result.disposition).toBe('rejected_unsupported_type');
    expect(test.usageRows).toEqual([]);
  });

  it('answers a mid-flight expiry with the same sentence as the pre-flight gate', async () => {
    // The likelier path: `runOptions` carried the deadline into the service, so the gateway's own
    // budget check raised `DIAGNOSIS_TIMEOUT` rather than the gate catching it first.
    const test = harness({ diagnoseError: new AppError('DIAGNOSIS_TIMEOUT'), profile: { id: USER_ID, language: 'hi' } });

    const result = await processInboundMessage(imageMessage(), test.deps);

    expect(result.disposition).toBe('failed');
    expect(result.detail.startsWith(SOFT_DEADLINE_DETAIL)).toBe(true);
    expect(test.sent[0]?.body).toBe(messages('hi').whatsapp.takingLonger);
    // NOT the taxonomy's own timeout copy: that sentence names the diagnosis operation, which is
    // wrong for a typed question on the same channel.
    expect(test.sent[0]?.body).not.toBe(messages('hi').errors.DIAGNOSIS_TIMEOUT);
    expect(test.inboundStore.transitions).toEqual(['failed']);
  });

  it('binds the ChatService to this invocation\u2019s budget rather than a fresh one', async () => {
    const test = harness();
    const now = (): number => 7_000;
    let bound: ChatTurnDeps | undefined;

    const answerer: WhatsappChatService = async () => ({
      conversationId: CONVERSATION_ID,
      farmerMessageId: 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f',
      answer: chatAnswer('Remove the affected leaves.'),
      quota: { ...QUOTA, operation: 'chat', limit: 50 },
    });

    chatServiceSpy.chatAnswerer.mockImplementationOnce((deps: ChatTurnDeps) => {
      bound = deps;
      return answerer;
    });

    // `chat` omitted on purpose: this is the one test that exercises the default binding.
    const deps: WhatsappDispatchDeps = {
      ...test.deps,
      chat: undefined,
      deadline: { now, deadlineMs: 100_000 },
    };

    await processInboundMessage(textMessage(), deps);

    expect(bound?.runOptions?.deadlineMs).toBe(100_000);
    // The clock travels with the instant. A deadline without it is half a budget.
    expect(bound?.runOptions?.now).toBe(now);
    expect(bound?.now).toBe(now);
  });

  it('hands the same instant to the DiagnosisService instead of letting it derive one', async () => {
    const test = harness();
    const now = (): number => 3_000;

    await processInboundMessage(imageMessage(), {
      ...test.deps,
      deadline: { now, deadlineMs: 250_000 },
    });

    expect(test.diagnoseDeps[0]?.deadlineMs).toBe(250_000);
    expect(test.diagnoseDeps[0]?.now).toBe(now);
  });

  it('hands the same instant to the VoiceService, so transcription and the answer share it', async () => {
    const test = harness();
    const now = (): number => 3_000;

    await processInboundMessage(audioMessage(), {
      ...test.deps,
      deadline: { now, deadlineMs: 250_000 },
    });

    expect(test.voiceDeps[0]?.deadlineMs).toBe(250_000);
    expect(test.voiceDeps[0]?.now).toBe(now);
  });
});

describe('a batch shares one deadline, and its remainder is not silently dropped', () => {
  it('processes while the budget allows and gives every later entry an honest terminal status', async () => {
    const test = harness();
    // One clock for the invocation, advanced by the work itself: each answered message costs 30 s.
    let clock = 0;
    const chat: WhatsappChatService = async () => {
      clock += 30_000;
      return {
        conversationId: CONVERSATION_ID,
        farmerMessageId: 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f',
        answer: chatAnswer('Remove the affected leaves.'),
        quota: { ...QUOTA, operation: 'chat', limit: 50 },
      };
    };

    const results = await processInboundBatch(
      [
        textMessage('why are the leaves yellow?'),
        inbound({ providerMessageId: 'wamid.SECOND', content: { kind: 'text', body: 'and the fruit?' } }),
        inbound({ providerMessageId: 'wamid.THIRD', content: { kind: 'text', body: 'what about water?' } }),
      ],
      { ...test.deps, chat, deadline: { now: () => clock, deadlineMs: SOFT_BUDGET_MS } },
    );

    // 45 s of budget, 30 s a message: two are answered, the third is past the floor.
    expect(results.map((result) => result.disposition)).toEqual(['processed', 'processed', 'failed']);
    expect(results[2]?.detail).toBe(SOFT_DEADLINE_DETAIL);
    /**
     * The point of the whole task. Entry three is `failed` with a reply, NOT left at `received` —
     * Meta will not redeliver a delivery Jamee acknowledged, and the idempotency guard would drop it
     * if it did, so a row left `received` here is a message that vanished.
     */
    expect(test.inboundStore.transitions).toEqual(['processed', 'processed', 'failed']);
    expect(test.sent).toHaveLength(3);
    expect(test.sent[2]?.body).toBe(messages('en').whatsapp.takingLonger);
  });

  it('resolves the budget once, so message two does not believe the invocation just started', async () => {
    const test = harness();
    let clock = 1_000;
    // The first message eats the whole budget. With a per-message budget, the second would compute
    // `clock + 45 s` and sail through; with one invocation budget it cannot.
    const chat: WhatsappChatService = async () => {
      clock += SOFT_BUDGET_MS;
      return {
        conversationId: CONVERSATION_ID,
        farmerMessageId: 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f',
        answer: chatAnswer('Remove the affected leaves.'),
        quota: { ...QUOTA, operation: 'chat', limit: 50 },
      };
    };

    const results = await processInboundBatch(
      [
        textMessage('first'),
        inbound({ providerMessageId: 'wamid.SECOND', content: { kind: 'text', body: 'second' } }),
      ],
      // Only the clock and the start instant are given; the budget is derived exactly as production
      // derives it, which is what makes this an assertion about the arithmetic and not about a stub.
      {
        ...test.deps,
        chat,
        deadline: { now: () => clock, requestStartMs: 1_000, platformDeadline: () => undefined },
      },
    );

    expect(results.map((result) => result.disposition)).toEqual(['processed', 'failed']);
    expect(results[1]?.detail).toBe(SOFT_DEADLINE_DETAIL);
  });
});
