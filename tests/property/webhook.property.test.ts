import { createHmac } from 'node:crypto';

import * as fc from 'fast-check';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  META_CHALLENGE_PARAMS,
  META_CHALLENGE_SUBSCRIBE_MODE,
  META_SIGNATURE_HEADER,
  META_SIGNATURE_PREFIX,
} from '@/lib/config/verified';
import type {
  ExistingInbound,
  InboundReceivedRow,
  TerminalInboundStatus,
  WhatsappInboundStore,
} from '@/lib/db/whatsapp-inbound';
import { ERROR_SPECS } from '@/lib/errors';
import type { ChatAnswer, DiagnosisResult, QuotaStatus, StorageRef } from '@/lib/schemas';
import type { InboundMediaResult, SendReplyOptions, SendReplyResult } from '@/lib/whatsapp';
import type {
  InboundResult,
  ProfileByPhoneStore,
  WhatsappChatService,
  WhatsappDispatchDeps,
} from '@/lib/whatsapp-dispatch';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import type { DiagnosisOutcome } from '@/services/diagnosis.service';
import type { NestedChatOutcome, VoiceOutcome } from '@/services/voice.service';
import type { TablesInsert } from '@/types/database';

/**
 * **Property 23: The webhook rejects everything it cannot authenticate, and processes each delivery
 * once**
 *
 * > For any verify token presented on the webhook GET route, the challenge is echoed with HTTP 200
 * > if and only if the token equals the configured value, and HTTP 403 otherwise; for any request
 * > body and signature presented on the POST route, the payload is read as a message only after the
 * > signature verifies against the app secret over the raw body bytes, and a failing signature
 * > yields HTTP 401 with no shared service invoked; and for any sequence of deliveries, including
 * > concurrent redeliveries of one provider message id, the message is processed at most once, every
 * > repeat is acknowledged with HTTP 200 with no service call and no quota change, and the provider
 * > message id is recorded.
 *
 * **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6**
 *
 * ### What is real here, and what is not
 *
 * The **real route handlers** are driven — `GET` and `POST` from `src/app/api/whatsapp/route.ts` —
 * and behind them the **real** admission module (`verifySignature`, `verifyInboundRequest`,
 * `parseVerifiedInbound`, `respondToChallenge`), the **real** inbound pipeline
 * (`processInboundBatch` → `processInboundMessage`) and the **real** idempotency logic
 * (`claimInbound`, `attachResolvedProfile`, `markProcessed`). No HMAC is stubbed, no status code is
 * re-described, and nothing decides an outcome that the shipped code would not decide.
 *
 * What is replaced is the leaf edge of the world: the three domain services, the quota primitives,
 * the Meta sender, the media retrieval, the service-role client, and the store behind
 * `whatsapp_inbound` and `usage_logs`. The
 * store is an in-memory map whose `insertReceived` performs its existence check and its write with
 * **no `await` between them**, which is exactly the atomicity a primary-key insert has in Postgres.
 * That the real index is atomic is not this file's claim to make — `whatsapp-inbound.test.ts` says
 * the same, and task 21.5 owns it against a real database.
 *
 * ### The two clauses, and how each is asserted
 *
 * **"Rejects everything it cannot authenticate."** The webhook carries no farmer session at all
 * (Requirement 11.3 — it is authenticated by an HMAC over the raw body), so the adversary chooses
 * both the body and the header and may retry forever. `FORGERY_CLASSES` enumerates eighteen ways to
 * present something other than the digest the app secret produces, including the two that a
 * single-body test structurally cannot reach: a **valid signature over a different delivery**, and a
 * **valid signature replayed against a mutated body**. A verifier that ignored the body would pass
 * every other class and fail those two.
 *
 * Each refusal is checked for more than its status. Everything the POST path could reach — the
 * parse, the dispatch, the three services, the quota reserve, the claim insert, the profile read,
 * the sender, the audit writer, the service-role client — is a tripwire that records its own name
 * before throwing, and the ledger must be **empty**. A guard that let a handler run would therefore
 * fail twice: once on the recorded call, and once on the status, because the throw would surface as
 * a 500 rather than a 401. The generated request also has `json()`, `text()`, `formData()` and
 * `blob()` replaced with throws, so a handler that interpreted the body any way other than once as
 * bytes fails here rather than in production.
 *
 * **"Processes each delivery once."** Redeliveries are generated with repeats and driven in four
 * orders — sequential, shuffled, batched inside one notification, and **concurrently**, with every
 * POST in flight at the same time. Exactly one claim, one service call, one reply and one terminal
 * transition may exist per distinct WAMID; every repeat must be acknowledged with 200 and recorded
 * as `duplicate_ignored` rather than silently dropped.
 *
 * ### Non-vacuity
 *
 * Three guards, because "everything was refused" is also what a broken fixture produces:
 *
 *  - Every forgery class must be **generated at least once** across the run; the property collects
 *    the classes it saw and the assertion after `fc.assert` fails if any is missing.
 *  - The complement is asserted in the same file: a correctly signed delivery is admitted, parsed,
 *    dispatched, answered and marked `processed`.
 *  - Every mutation is checked to have actually changed the bytes it mutated, so a `replace()` that
 *    silently matched nothing cannot pass as a rejection.
 *
 * ### Relationship to the example-based tests
 *
 * `src/lib/whatsapp.test.ts` pins the digest primitives and the constant-time comparison on named
 * inputs, `src/app/api/whatsapp/route.test.ts` pins the route's ordering on one delivery, and
 * `src/lib/db/whatsapp-inbound.test.ts` pins the claim's three outcomes. None of them generates
 * adversarial headers, and none drives concurrent redeliveries through the real handler.
 */

/* ========================================================================== */
/* Seams                                                                       */
/* ========================================================================== */

/**
 * Every door on the far side of authentication, plus the two spies the ordering claim needs.
 *
 * `reached` is the ledger Requirement 11.4's second clause is asserted against: each tripwire
 * records its own name before throwing, so a violation is reported as "which service ran" rather
 * than as an opaque status mismatch.
 */
const seams = vi.hoisted(() => {
  const reached: string[] = [];

  const tripwire = (label: string) =>
    vi.fn(() => {
      reached.push(label);
      throw new Error(`tripwire: ${label} ran for a delivery the webhook had not authenticated`);
    });

  return {
    reached,

    /** The real parse behind a counter — "not parsed" is Requirement 11.3's ordering. */
    parseVerifiedInbound: vi.fn(),
    /** The real pipeline behind a wrapper that injects the harness's seams. */
    processInboundBatch: vi.fn(),
    /** Set by the module factory below, read by the wrapper on every call. */
    harness: { current: null as Harness | null },

    diagnose: tripwire('DiagnosisService.diagnose'),
    chatAnswerer: tripwire('ChatService.chatAnswerer'),
    chatTurn: tripwire('ChatService.chatTurn'),
    transcribeAndAnswer: tripwire('VoiceService.transcribeAndAnswer'),
    reserve: tripwire('QuotaService.reserve'),
    reserveForRequest: tripwire('QuotaService.reserveForRequest'),
    refund: tripwire('QuotaService.refund'),
    refundReservation: tripwire('QuotaService.refundReservation'),
    createAdminClient: tripwire('supabase.createAdminClient'),
    sendWhatsappText: tripwire('WhatsappAdapter.sendWhatsappText'),
    storeInboundMedia: tripwire('WhatsappAdapter.storeInboundMedia'),
  };
});

/**
 * Partial mock: every export stays the real implementation. `parseVerifiedInbound` is the real
 * function behind a spy, and the two seams the pipeline defaults to when nothing is injected become
 * tripwires — so an un-injected default is a recorded violation rather than a real network call.
 *
 * Nothing about verification is touched. `verifySignature`, `verifyInboundRequest` and
 * `respondToChallenge` are the shipped functions, which is what makes a passing run a statement
 * about the code.
 */
vi.mock('@/lib/whatsapp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp')>();
  seams.parseVerifiedInbound.mockImplementation(actual.parseVerifiedInbound);
  return {
    ...actual,
    parseVerifiedInbound: seams.parseVerifiedInbound,
    sendWhatsappText: seams.sendWhatsappText,
    storeInboundMedia: seams.storeInboundMedia,
  };
});

/**
 * The pipeline stays **real** and is reached through the route exactly as it ships; the wrapper only
 * adds this file's injected seams to the deps the route composed.
 *
 * That is what lets one property cover both clauses. The route cannot be handed seams — it passes
 * only the invocation's start instant, deliberately — so a wrapper is the one place a test can bind
 * an in-memory store to the real `claimInbound` without re-describing the route's behaviour. The
 * deps the route itself supplied are recorded and asserted rather than discarded.
 */
vi.mock('@/lib/whatsapp-dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp-dispatch')>();

  const throughHarness: typeof actual.processInboundBatch = async (inbound, deps) => {
    const harness = seams.harness.current;
    if (harness === null) throw new Error('the harness was not installed before a POST');

    harness.routeDeps.push(deps);
    const results = await actual.processInboundBatch(inbound, harness.depsFor(deps));
    harness.results.push(...results);
    return results;
  };

  seams.processInboundBatch.mockImplementation(throughHarness);
  return { ...actual, processInboundBatch: seams.processInboundBatch };
});

vi.mock('@/services/diagnosis.service', () => ({ diagnose: seams.diagnose }));
vi.mock('@/services/chat.service', () => ({
  chatAnswerer: seams.chatAnswerer,
  chatTurn: seams.chatTurn,
}));
vi.mock('@/services/voice.service', () => ({
  transcribeAndAnswer: seams.transcribeAndAnswer,
}));

/**
 * Partial mock: `ownsRequest` and `coveredBy` are pure brand constructors the pipeline uses to say
 * *who* reserves, and they stay real. Everything that could actually move a counter is a tripwire,
 * so "no quota change" (Requirements 11.5, 11.4) is a ledger assertion rather than an inference from
 * the fact that the services were stubbed.
 */
vi.mock('@/services/quota.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/quota.service')>();
  return {
    ...actual,
    reserve: seams.reserve,
    reserveForRequest: seams.reserveForRequest,
    refund: seams.refund,
    refundReservation: seams.refundReservation,
  };
});

/** No service-role key is read on any path in this file, and reaching for one is recorded. */
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: seams.createAdminClient }));

/**
 * The route handlers, imported after the mocks above — `vi.mock` is hoisted over every import, so
 * the module graph the handlers see is the one composed here.
 */
import { GET, POST } from '@/app/api/whatsapp/route';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

/**
 * Synthetic, and obviously so. Neither value is a credential shape: the app secret is Meta's HMAC
 * key and the verify token is a handshake string, and both are read through `serverEnv` here purely
 * so the real `verifyInboundRequest` and `respondToChallenge` defaults are exercised.
 */
const APP_SECRET = 'property-app-secret-not-a-real-credential';
const VERIFY_TOKEN = 'property-verify-token-not-a-real-credential';

const ORIGIN = 'https://jamee.test/api/whatsapp';
const USER_ID = '7f3a3c58-1a3d-4c1f-9f4e-2b5c8d0e1a22';
const CONVERSATION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const WABA_ID = '102290129340398';
const PHONE_NUMBER_ID = '106540352242922';
/** Meta's `wa_id`: digits, no leading `+`. `normalizeInboundPhone` closes that gap. */
const WA_ID = '919876543210';
/** Fixed so a mutation can target it by exact string and be checked for having landed. */
const TIMESTAMP = '1758000000';

vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
vi.stubEnv('WHATSAPP_VERIFY_TOKEN', VERIFY_TOKEN);

type MessageKind = 'text' | 'image' | 'audio';

interface MessageSpec {
  readonly wamid: string;
  readonly kind: MessageKind;
}

/** The confirmed (V12) per-type shape, plus the provisional (U-V12) media sub-objects. */
function messageObject(spec: MessageSpec): Record<string, unknown> {
  const envelope = {
    from: WA_ID,
    id: spec.wamid,
    timestamp: TIMESTAMP,
    type: spec.kind,
  };

  if (spec.kind === 'text') {
    return { ...envelope, text: { body: `${spec.wamid} :: patte peele ho rahe hain` } };
  }
  if (spec.kind === 'image') {
    return { ...envelope, image: { id: `media-${spec.wamid}`, mime_type: 'image/jpeg' } };
  }
  return { ...envelope, audio: { id: `media-${spec.wamid}`, mime_type: 'audio/ogg', voice: true } };
}

/**
 * One notification, as a **string**. The bytes are what get signed, so the body is built once and
 * both the signature and the request read the same value — the re-serialization trap
 * `src/lib/whatsapp.ts` documents is a real one, and a test that stringified twice could hide it.
 */
function deliveryRaw(specs: readonly MessageSpec[]): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ wa_id: WA_ID, profile: { name: 'Anita' } }],
              messages: specs.map(messageObject),
            },
          },
        ],
      },
    ],
  });
}

function digestOf(raw: string, encoding: 'hex' | 'base64', secret = APP_SECRET): string {
  return createHmac('sha256', secret).update(raw, 'utf8').digest(encoding);
}

function signatureFor(raw: string, encoding: 'hex' | 'base64' = 'hex', secret = APP_SECRET): string {
  return `${META_SIGNATURE_PREFIX}${digestOf(raw, encoding, secret)}`;
}

/**
 * A POST whose only usable body reader is `arrayBuffer()`.
 *
 * The four replaced readers are the ways a handler could interpret a payload it has not verified.
 * Requirement 11.3 is an ordering requirement, and this is what makes a violation of it a failure
 * rather than a review comment.
 */
function post(raw: string, signature: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (signature !== null) headers.set(META_SIGNATURE_HEADER, signature);

  const request = new Request(ORIGIN, { method: 'POST', body: raw, headers });

  for (const reader of ['json', 'text', 'formData', 'blob'] as const) {
    Object.defineProperty(request, reader, {
      configurable: true,
      value: () => {
        throw new Error(
          `the route called request.${reader}() — the raw bytes must be read once, as bytes, ` +
            'before the signature is verified (Requirement 11.3)',
        );
      },
    });
  }
  return request;
}

function challengeGet(params: Readonly<Record<string, string>>): Request {
  const url = new URL(ORIGIN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url, { method: 'GET' });
}

/* -------------------------------------------------------------------------- */
/* Service results                                                             */
/* -------------------------------------------------------------------------- */

const QUOTA: QuotaStatus = {
  operation: 'image',
  limit: 20,
  used: 1,
  resetsAt: '2026-03-11T18:30:00.000Z',
};

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

const ANSWER: ChatAnswer = {
  messageId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
  content: 'Remove the affected leaves and keep the foliage dry.',
  language: 'en',
  groundedIn: ['Tomato Early Blight'],
  needsExpert: false,
};

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

/** The ref the media seam hands back. The WAMID is in the path so a call can be attributed to one. */
function refFor(wamid: string, kind: 'image' | 'audio'): StorageRef {
  return kind === 'image'
    ? { bucket: 'crop-images', path: `${USER_ID}/2026/03/${wamid}.jpg` }
    : { bucket: 'voice-messages', path: `${USER_ID}/2026/03/${wamid}.ogg` };
}

/** `media-wamid.X` → `wamid.X`, and `…/wamid.X.jpg` → `wamid.X`. */
function wamidFromMediaId(mediaId: string): string {
  return mediaId.replace(/^media-/, '');
}

function wamidFromPath(path: string): string {
  return path.replace(/^.*\//, '').replace(/\.(jpg|ogg)$/, '');
}

/* ========================================================================== */
/* The harness: an in-memory whatsapp_inbound, and one recorder per service     */
/* ========================================================================== */

interface StoredRow {
  user_id: string | null;
  status: string;
  message_type: string;
}

interface ServiceCall {
  readonly service: 'diagnose' | 'chat' | 'voice';
  readonly wamid: string;
}

interface Harness {
  readonly depsFor: (routeDeps: WhatsappDispatchDeps) => WhatsappDispatchDeps;
  /** The deps the **route** composed, kept so what it supplies can be asserted. */
  readonly routeDeps: WhatsappDispatchDeps[];
  readonly results: InboundResult[];
  /** WAMIDs whose claim insert succeeded — the "processed at most once" ledger. */
  readonly claimed: string[];
  /** Every rejected claim, with whether the conflicting row was already attributed. */
  readonly conflicts: { readonly wamid: string; readonly attributed: boolean }[];
  readonly rows: Map<string, StoredRow>;
  readonly attached: string[];
  readonly transitionAttempts: { readonly wamid: string; readonly status: TerminalInboundStatus }[];
  readonly transitionsApplied: { readonly wamid: string; readonly status: TerminalInboundStatus }[];
  readonly usageRows: TablesInsert<'usage_logs'>[];
  readonly serviceCalls: ServiceCall[];
  readonly replies: SendReplyOptions[];
  readonly profileReads: string[];
}

/**
 * The `whatsapp_inbound` table as a map, with the one behaviour Requirements 11.5 and 11.6 turn on:
 * the primary key refuses the second insert.
 *
 * `insertReceived` reads the map and writes it with **no `await` in between**, so two overlapping
 * deliveries of one WAMID cannot both see an empty slot — which is what a primary-key insert
 * guarantees in Postgres. `transitionFromReceived` keeps the real `status = 'received'` guard, so a
 * second transition attempt returns zero rows exactly as the shipped statement does.
 */
function inboundStore(harness: Harness): WhatsappInboundStore {
  return {
    async insertReceived(row: InboundReceivedRow) {
      const wamid = row.provider_message_id;
      const existing = harness.rows.get(wamid);

      if (existing !== undefined) {
        harness.conflicts.push({ wamid, attributed: existing.user_id !== null });
        return {
          error: {
            code: '23505',
            message: 'duplicate key value violates unique constraint "whatsapp_inbound_pkey"',
          },
        };
      }

      harness.rows.set(wamid, {
        user_id: null,
        status: row.status,
        message_type: row.message_type,
      });
      harness.claimed.push(wamid);
      return { error: null };
    },

    async readExisting(providerMessageId: string) {
      const row = harness.rows.get(providerMessageId);
      if (row === undefined) return { data: null, error: null };
      const existing: ExistingInbound = {
        user_id: row.user_id,
        status: row.status as ExistingInbound['status'],
        message_type: row.message_type,
      };
      return { data: existing, error: null };
    },

    async attachUser(providerMessageId: string, userId: string) {
      const row = harness.rows.get(providerMessageId);
      if (row !== undefined) row.user_id = userId;
      harness.attached.push(providerMessageId);
      return { error: null };
    },

    async transitionFromReceived(providerMessageId: string, status: TerminalInboundStatus) {
      harness.transitionAttempts.push({ wamid: providerMessageId, status });
      const row = harness.rows.get(providerMessageId);
      if (row === undefined || row.status !== 'received') return { data: [], error: null };

      row.status = status;
      harness.transitionsApplied.push({ wamid: providerMessageId, status });
      return { data: [{ status }], error: null };
    },

    async insertUsageLog(row: TablesInsert<'usage_logs'>) {
      harness.usageRows.push(row);
      return { error: null };
    },
  };
}

/** A client object that is never dereferenced: every seam that would use one is injected. */
const SUPABASE_STUB = {
  __jameePropertyClient: true,
} as unknown as NonNullable<WhatsappDispatchDeps['supabase']>;

function harnessFor(): Harness {
  const harness: Harness = {
    routeDeps: [],
    results: [],
    claimed: [],
    conflicts: [],
    rows: new Map<string, StoredRow>(),
    attached: [],
    transitionAttempts: [],
    transitionsApplied: [],
    usageRows: [],
    serviceCalls: [],
    replies: [],
    profileReads: [],
    depsFor: (routeDeps) => injected(harness, routeDeps),
  };
  return harness;
}

const profiles = (harness: Harness): ProfileByPhoneStore => ({
  async byPhone(e164Phone) {
    harness.profileReads.push(e164Phone);
    return { data: { id: USER_ID, language: 'en' }, error: null };
  },
});

const conversations = (): ConversationStore => ({
  async mostRecent() {
    return conversation();
  },
  async create() {
    return conversation();
  },
});

/**
 * The seams added to whatever the route composed.
 *
 * `deadline` is merged rather than replaced: `requestStartMs` is the one fact the route contributes
 * to D11's budget, read at the top of the handler, and overwriting it would discard the thing worth
 * asserting. Only `platformDeadline` is pinned — `getDeadline()` has no answer off-platform, and a
 * property should not depend on what it returns under a test runner.
 */
function injected(harness: Harness, routeDeps: WhatsappDispatchDeps): WhatsappDispatchDeps {
  const chat: WhatsappChatService = async (input): Promise<NestedChatOutcome> => {
    harness.serviceCalls.push({
      service: 'chat',
      wamid: (input.message ?? '').split(' :: ')[0] ?? '',
    });
    return {
      conversationId: CONVERSATION_ID,
      farmerMessageId: 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f',
      answer: ANSWER,
      quota: { ...QUOTA, operation: 'chat', limit: 50 },
    };
  };

  return {
    ...routeDeps,
    deadline: { ...routeDeps.deadline, platformDeadline: () => undefined },
    supabase: SUPABASE_STUB,
    inbound: { store: inboundStore(harness) },
    usage: {
      insertUsageLog: async (row) => {
        harness.usageRows.push(row);
      },
    },
    profiles: profiles(harness),
    conversations: conversations(),
    chat,
    diagnose: async (input): Promise<DiagnosisOutcome> => {
      harness.serviceCalls.push({ service: 'diagnose', wamid: wamidFromPath(input.storageRef.path) });
      return {
        diagnosisId: 'd4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f80',
        conversationId: CONVERSATION_ID,
        result: IDENTIFIED,
        quota: QUOTA,
        provider: 'gemini',
        usedFallback: false,
      };
    },
    voice: async (input): Promise<VoiceOutcome> => {
      harness.serviceCalls.push({ service: 'voice', wamid: wamidFromPath(input.storageRef.path) });
      return {
        transcript: 'patte peele ho rahe hain',
        answer: ANSWER,
        conversationId: CONVERSATION_ID,
        quota: { ...QUOTA, operation: 'voice' },
        farmerMessageId: 'e5f6a7b8-c9d0-4e1f-8a3b-4c5d6e7f8091',
        provider: 'groq',
        usedFallback: false,
        audio: { outcome: 'deleted' },
      };
    },
    media: async (input): Promise<InboundMediaResult> => {
      const kind = input.content.kind;
      return {
        ok: true,
        ref: refFor(wamidFromMediaId(input.content.mediaId), kind),
        kind,
        mimeType: kind === 'image' ? 'image/jpeg' : 'audio/ogg',
        bytes: 120_000,
      };
    },
    send: async (options): Promise<SendReplyResult> => {
      harness.replies.push(options);
      return { ok: true, sentMessageId: 'wamid.OUT001', bodyChars: options.body.length };
    },
  };
}

/**
 * Everything a refused request must not have touched, in one list.
 *
 * Two sources, and both are needed. `seams.reached` catches a **default** seam — a real service, the
 * real sender, the service-role client — because those are tripwires at the module boundary. The
 * harness ledger catches an **injected** seam, which is the door the pipeline actually uses on an
 * admitted delivery: if only the tripwires were consulted, a handler that ran the whole pipeline
 * against the injected stubs would look clean.
 */
function ledger(state: Harness): readonly string[] {
  return [
    ...seams.reached,
    ...state.results.map((result) => `dispatch:${result.disposition}`),
    ...state.claimed.map((wamid) => `claim:${wamid}`),
    ...state.serviceCalls.map((call) => `service:${call.service}`),
    ...state.replies.map(() => 'send:reply'),
    ...state.profileReads.map(() => 'profiles:byPhone'),
    ...state.usageRows.map(() => 'usage:insert'),
  ];
}

let harness: Harness;

beforeAll(() => {
  // The route and the pipeline log every decision, and a property run makes hundreds. Silenced
  // rather than asserted: `route.test.ts` owns the log content.
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

beforeEach(() => {
  seams.reached.length = 0;
  seams.parseVerifiedInbound.mockClear();
  seams.processInboundBatch.mockClear();
  harness = harnessFor();
  seams.harness.current = harness;
});

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const kindArb = fc.constantFrom<MessageKind>('text', 'image', 'audio');

/** A WAMID shaped like Meta's and inside V12's 128-character cap. */
const wamidArb = fc
  .tuple(fc.integer({ min: 1, max: 9_999 }), fc.constantFrom('A', 'B', 'C'))
  .map(([serial, suffix]) => `wamid.HBgMOTE5ODc2NTQzMjEw${suffix}${serial}`);

const specArb: fc.Arbitrary<MessageSpec> = fc.record({ wamid: wamidArb, kind: kindArb });

/**
 * Eighteen ways to present something that is not the digest the app secret produces over these
 * bytes.
 *
 * The two that carry the most weight are `valid_over_a_different_body` and
 * `valid_replayed_against_a_mutated_body`: a verifier that computed the HMAC over the wrong bytes —
 * a re-serialized body, an empty string, a parsed-then-restringified object — would refuse every
 * other class here and admit those two.
 */
const FORGERY_CLASSES = [
  'header_absent',
  'header_empty',
  'header_whitespace_only',
  'prefix_only',
  'digest_without_prefix',
  'wrong_algorithm_label',
  'wrong_secret',
  'keyed_with_the_verify_token',
  'valid_over_a_different_body',
  'valid_replayed_against_a_mutated_body',
  'truncated_digest',
  'extended_digest',
  'right_length_wrong_bytes',
  'right_length_wrong_bytes_base64',
  'unpadded_base64url_rendering',
  'base64_digest_recased',
  'two_signatures_one_valid',
  'padded_away_from_the_prefix',
] as const;

type ForgeryClass = (typeof FORGERY_CLASSES)[number];

const forgeryArb = fc.constantFrom<ForgeryClass>(...FORGERY_CLASSES);

interface ForgedRequest {
  /** The bytes actually sent. Differs from the signed body only for the replay class. */
  readonly body: string;
  readonly header: string | null;
  /** What this case is claimed to have changed, checked inside the property. */
  readonly mutatedFrom: string | null;
}

function recase(digest: string): string {
  const index = [...digest].findIndex((char) => /[A-Za-z]/.test(char));
  if (index === -1) throw new Error('fixture: this base64 digest carries no letter to re-case');
  const char = digest[index] as string;
  const flipped = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
  return `${digest.slice(0, index)}${flipped}${digest.slice(index + 1)}`;
}

/**
 * Build the forged request for one class.
 *
 * `signed` is the delivery the attacker holds a signature for; `other` is a different, equally
 * well-formed delivery. Both are real V12 envelopes, so a refusal cannot be explained away as "the
 * payload was malformed anyway" — the only thing wrong with these requests is the signature.
 */
function forge(forgery: ForgeryClass, signed: string, other: string): ForgedRequest {
  const hexHeader = signatureFor(signed, 'hex');
  const hexDigest = digestOf(signed, 'hex');
  const base64Digest = digestOf(signed, 'base64');
  const plain = (header: string | null): ForgedRequest => ({
    body: signed,
    header,
    mutatedFrom: null,
  });

  switch (forgery) {
    case 'header_absent':
      return plain(null);
    case 'header_empty':
      return plain('');
    case 'header_whitespace_only':
      return plain('   ');
    case 'prefix_only':
      return plain(META_SIGNATURE_PREFIX);
    case 'digest_without_prefix':
      return plain(hexDigest);
    case 'wrong_algorithm_label':
      return plain(`sha1=${createHmac('sha1', APP_SECRET).update(signed, 'utf8').digest('hex')}`);
    case 'wrong_secret':
      return plain(signatureFor(signed, 'hex', 'not-the-configured-app-secret'));
    case 'keyed_with_the_verify_token':
      return plain(signatureFor(signed, 'hex', VERIFY_TOKEN));
    case 'valid_over_a_different_body':
      return plain(signatureFor(other, 'hex'));
    case 'valid_replayed_against_a_mutated_body': {
      // A mutation that keeps the payload a valid V12 delivery: if the parse ran before the
      // signature check, this case would be processed rather than refused.
      const mutated = signed.replace(`"timestamp":"${TIMESTAMP}"`, '"timestamp":"1758000001"');
      return { body: mutated, header: hexHeader, mutatedFrom: signed };
    }
    case 'truncated_digest':
      return plain(`${META_SIGNATURE_PREFIX}${hexDigest.slice(0, -8)}`);
    case 'extended_digest':
      return plain(`${hexHeader}dead`);
    case 'right_length_wrong_bytes':
      return plain(`${META_SIGNATURE_PREFIX}${'0'.repeat(64)}`);
    case 'right_length_wrong_bytes_base64':
      return plain(`${META_SIGNATURE_PREFIX}${'A'.repeat(43)}=`);
    case 'unpadded_base64url_rendering':
      return plain(
        `${META_SIGNATURE_PREFIX}${base64Digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`,
      );
    case 'base64_digest_recased':
      return plain(`${META_SIGNATURE_PREFIX}${recase(base64Digest)}`);
    case 'two_signatures_one_valid':
      return plain(`${hexHeader},${hexHeader}`);
    case 'padded_away_from_the_prefix':
      return plain(`${META_SIGNATURE_PREFIX} ${hexDigest}`);
  }
}

/* ========================================================================== */
/* The facts the property rests on                                             */
/* ========================================================================== */

describe('the statuses Property 23 names come from the taxonomy, not from a literal', () => {
  it('answers a failed signature with 401 and a failed handshake with 403', () => {
    expect(ERROR_SPECS.WEBHOOK_SIGNATURE_INVALID.status).toBe(401);
    expect(ERROR_SPECS.WEBHOOK_VERIFY_TOKEN_INVALID.status).toBe(403);
  });
});

/* ========================================================================== */
/* Property 23, clause 1 — the GET handshake (Requirements 11.1, 11.2)          */
/* ========================================================================== */

type TokenClass =
  | 'configured'
  | 'absent'
  | 'empty'
  | 'last_character_changed'
  | 'prefix_of_configured'
  | 'configured_with_a_suffix'
  | 'recased'
  | 'unrelated';

const TOKEN_CLASSES: readonly TokenClass[] = [
  'configured',
  'absent',
  'empty',
  'last_character_changed',
  'prefix_of_configured',
  'configured_with_a_suffix',
  'recased',
  'unrelated',
];

function presentedToken(tokenClass: TokenClass, unrelated: string): string | null {
  switch (tokenClass) {
    case 'configured':
      return VERIFY_TOKEN;
    case 'absent':
      return null;
    case 'empty':
      return '';
    case 'last_character_changed':
      return `${VERIFY_TOKEN.slice(0, -1)}${VERIFY_TOKEN.endsWith('l') ? 'm' : 'l'}`;
    case 'prefix_of_configured':
      return VERIFY_TOKEN.slice(0, -3);
    case 'configured_with_a_suffix':
      return `${VERIFY_TOKEN}x`;
    case 'recased':
      return VERIFY_TOKEN.toUpperCase();
    case 'unrelated':
      return unrelated;
  }
}

describe('Property 23: the handshake echoes the challenge exactly when the token is the configured one', () => {
  it('answers 200 with the challenge for the configured token and 403 for every other', async () => {
    const seen = new Set<TokenClass>();
    const statuses = new Set<number>();

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          tokenClass: fc.constantFrom<TokenClass>(...TOKEN_CLASSES),
          unrelated: fc.string({ minLength: 0, maxLength: 40 }),
          challenge: fc.integer({ min: 0, max: 9_999_999 }).map(String),
        }),
        async ({ tokenClass, unrelated, challenge }) => {
          seen.add(tokenClass);
          const token = presentedToken(tokenClass, unrelated);
          const matches = token === VERIFY_TOKEN;

          const params: Record<string, string> = {
            [META_CHALLENGE_PARAMS.mode]: META_CHALLENGE_SUBSCRIBE_MODE,
            [META_CHALLENGE_PARAMS.challenge]: challenge,
          };
          if (token !== null) params[META_CHALLENGE_PARAMS.verifyToken] = token;

          const response = await GET(challengeGet(params));
          const body = await response.text();
          statuses.add(response.status);

          if (matches) {
            /** Requirement 11.1 — the challenge value echoed, verbatim. */
            expect(response.status, `${tokenClass} was refused`).toBe(200);
            expect(body).toBe(challenge);
          } else {
            /** Requirement 11.2 — and no body, so the caller learns nothing about which half failed. */
            expect(response.status, `${tokenClass} was accepted`).toBe(403);
            expect(body).toBe('');
          }

          /** A handshake is not a delivery: nothing on the far side of authentication may run. */
          expect(ledger(harness)).toEqual([]);
          expect(seams.parseVerifiedInbound).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 300 },
    );

    /** Non-vacuity, both ways: every token class was generated, and both answers were observed. */
    expect([...seen].sort()).toEqual([...TOKEN_CLASSES].sort());
    expect([...statuses].sort()).toEqual([200, 403]);
  });

  it('refuses a well-formed token when the rest of the handshake is not Meta\u2019s', async () => {
    /**
     * The design's sentence reads as a biconditional on the token alone. It holds for a handshake
     * that is otherwise well-formed, which is the case generated above; these are the two remaining
     * shapes, and both are 403 with the configured token present. `mode` is compared exactly, so its
     * upper-case spelling is a mismatch rather than a lenient match.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          mode: fc.constantFrom('unsubscribe', 'SUBSCRIBE', '', 'subscribed'),
          challenge: fc.constantFrom('', '1158201444'),
        }),
        async ({ mode, challenge }) => {
          const response = await GET(
            challengeGet({
              [META_CHALLENGE_PARAMS.mode]: mode,
              [META_CHALLENGE_PARAMS.verifyToken]: VERIFY_TOKEN,
              [META_CHALLENGE_PARAMS.challenge]: challenge,
            }),
          );

          expect(response.status).toBe(403);
          expect(await response.text()).toBe('');
          expect(ledger(harness)).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/* ========================================================================== */
/* Property 23, clause 2 — the POST refuses what it cannot authenticate         */
/* ========================================================================== */

describe('Property 23: an unauthenticated delivery is refused with 401 before anything runs', () => {
  it('refuses every forged signature, with no parse, no service, and no quota touched', async () => {
    const seen = new Set<ForgeryClass>();

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          forgery: forgeryArb,
          specs: fc.array(specArb, { minLength: 1, maxLength: 3 }),
          otherSpec: specArb,
        }),
        async ({ forgery, specs, otherSpec }) => {
          seen.add(forgery);
          harness = harnessFor();
          seams.harness.current = harness;
          seams.reached.length = 0;
          // Cleared per run, not per test: the call counters below are assertions about *this*
          // delivery, and an accumulator would report a neighbouring run's dispatch as this one's.
          seams.parseVerifiedInbound.mockClear();
          seams.processInboundBatch.mockClear();

          const signed = deliveryRaw(specs);
          const other = deliveryRaw([otherSpec]);
          const forged = forge(forgery, signed, other);

          if (forged.mutatedFrom !== null) {
            /** The mutation must have landed, or the "replay" case would be a valid delivery. */
            expect(forged.body, `${forgery} mutated nothing`).not.toBe(forged.mutatedFrom);
          }
          /** And the forged header must not be the one the secret produces over the bytes sent. */
          expect(forged.header, `${forgery} presented the correct signature`).not.toBe(
            signatureFor(forged.body, 'hex'),
          );

          const response = await POST(post(forged.body, forged.header));

          /** Requirement 11.4's status. */
          expect(response.status, `${forgery} was not refused`).toBe(401);
          /** Bodiless: naming the failure would tell an unauthenticated caller which half it failed. */
          expect(await response.text()).toBe('');

          /** Requirement 11.3's ordering — the payload was never read as a message. */
          expect(seams.parseVerifiedInbound, `${forgery} reached the parse`).not.toHaveBeenCalled();
          expect(seams.processInboundBatch, `${forgery} reached the dispatch`).not.toHaveBeenCalled();

          /**
           * Requirement 11.4's second clause, and the one a status cannot see: no service, no
           * claim, no profile read, no reply, no quota, no audit row.
           */
          expect(ledger(harness), `${forgery} reached something`).toEqual([]);
          expect(harness.rows.size, `${forgery} recorded a row`).toBe(0);
        },
      ),
      { numRuns: 400 },
    );

    /** Non-vacuity: every enumerated forgery class really was generated. */
    expect([...seen].sort()).toEqual([...FORGERY_CLASSES].sort());
  });

  it('admits, parses, dispatches and answers the same delivery once it is correctly signed', async () => {
    /**
     * The complement, and the reason the refusals above mean something. A route that refused
     * *everything* would satisfy the property above and take the channel down.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          specs: fc.uniqueArray(specArb, {
            minLength: 1,
            maxLength: 3,
            selector: (spec) => spec.wamid,
          }),
          encoding: fc.constantFrom<'hex' | 'base64'>('hex', 'base64'),
        }),
        async ({ specs, encoding }) => {
          harness = harnessFor();
          seams.harness.current = harness;
          seams.reached.length = 0;
          seams.parseVerifiedInbound.mockClear();
          seams.processInboundBatch.mockClear();

          const raw = deliveryRaw(specs);
          const response = await POST(post(raw, signatureFor(raw, encoding)));

          /** Requirement 10.11 — one acknowledgement for the delivery. */
          expect(response.status).toBe(200);
          expect(seams.parseVerifiedInbound).toHaveBeenCalledTimes(1);

          /** One claim, one service call and one reply per message in the batch. */
          expect(harness.claimed).toEqual(specs.map((spec) => spec.wamid));
          expect(harness.serviceCalls.map((call) => call.wamid)).toEqual(
            specs.map((spec) => spec.wamid),
          );
          expect(harness.serviceCalls.map((call) => call.service)).toEqual(
            specs.map((spec) => (spec.kind === 'text' ? 'chat' : spec.kind === 'image' ? 'diagnose' : 'voice')),
          );
          expect(harness.replies).toHaveLength(specs.length);
          expect(harness.results.map((result) => result.disposition)).toEqual(
            specs.map(() => 'processed'),
          );

          /** Requirement 11.6 — the provider message id is recorded, and reaches a terminal status. */
          for (const spec of specs) {
            expect(harness.rows.get(spec.wamid)?.status).toBe('processed');
          }

          /** No tripwire: every default seam was replaced, so nothing reached a real provider. */
          expect(seams.reached).toEqual([]);
        },
      ),
      { numRuns: 120 },
    );
  });

  it("hands the pipeline the invocation's start instant, read before the signature check", async () => {
    const raw = deliveryRaw([{ wamid: 'wamid.HBgMOTE5ODc2NTQzMjEwA1', kind: 'text' }]);
    const before = Date.now();

    await POST(post(raw, signatureFor(raw)));

    const supplied = harness.routeDeps[0]?.deadline?.requestStartMs;
    expect(typeof supplied).toBe('number');
    expect(supplied ?? 0).toBeGreaterThanOrEqual(before);
    expect(supplied ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(Date.now());
  });
});

/* ========================================================================== */
/* Property 23, clause 3 — each delivery is processed once (11.5, 11.6)         */
/* ========================================================================== */

type DeliveryOrder = 'sequential' | 'shuffled' | 'concurrent' | 'batched';

const ORDERS: readonly DeliveryOrder[] = ['sequential', 'shuffled', 'concurrent', 'batched'];

interface Redeliveries {
  readonly specs: readonly MessageSpec[];
  readonly repeats: readonly number[];
  readonly order: DeliveryOrder;
  readonly permutation: readonly number[];
}

const redeliveriesArb: fc.Arbitrary<Redeliveries> = fc
  .record({
    specs: fc.uniqueArray(specArb, { minLength: 1, maxLength: 3, selector: (spec) => spec.wamid }),
    order: fc.constantFrom<DeliveryOrder>(...ORDERS),
    seed: fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 9, maxLength: 9 }),
  })
  .chain(({ specs, order, seed }) =>
    fc
      .array(fc.integer({ min: 1, max: 3 }), { minLength: specs.length, maxLength: specs.length })
      .map((repeats) => ({ specs, repeats, order, permutation: seed })),
  );

/** The deliveries to send: one entry per repeat, ordered by the generated mode. */
function plan(input: Redeliveries): readonly (readonly MessageSpec[])[] {
  const flat: MessageSpec[] = [];
  input.specs.forEach((spec, index) => {
    const repeats = input.repeats[index] ?? 1;
    for (let i = 0; i < repeats; i += 1) flat.push(spec);
  });

  if (input.order === 'batched') {
    /**
     * Every repeat inside **one** notification. V13 records that Meta may batch up to 1000 updates,
     * so a duplicate arriving next to its original in a single delivery is a real shape — and the
     * claim is per message rather than per delivery precisely so this case is handled.
     */
    return [flat];
  }
  if (input.order === 'sequential' || input.order === 'concurrent') {
    return flat.map((spec) => [spec]);
  }

  const shuffled = [...flat];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = (input.permutation[i % input.permutation.length] ?? 0) % (i + 1);
    const a = shuffled[i] as MessageSpec;
    const b = shuffled[j] as MessageSpec;
    shuffled[i] = b;
    shuffled[j] = a;
  }
  return shuffled.map((spec) => [spec]);
}

describe('Property 23: a redelivered provider message id is processed once and recorded', () => {
  it('processes each distinct id exactly once, in any order, and ignores every repeat', async () => {
    const seenOrders = new Set<DeliveryOrder>();
    let duplicatesSeen = 0;

    await fc.assert(
      fc.asyncProperty(redeliveriesArb, async (input) => {
        seenOrders.add(input.order);
        harness = harnessFor();
        seams.harness.current = harness;
        seams.reached.length = 0;

        const deliveries = plan(input);
        const requests = deliveries.map((specs) => {
          const raw = deliveryRaw(specs);
          return post(raw, signatureFor(raw));
        });

        const responses =
          input.order === 'concurrent'
            ? // Every POST in flight at once. The claims interleave at the pipeline's awaits, which
              // is the ordering a sequential loop cannot produce.
              await Promise.all(requests.map((request) => POST(request)))
            : await (async () => {
                const collected: Response[] = [];
                for (const request of requests) collected.push(await POST(request));
                return collected;
              })();

        const distinct = input.specs.map((spec) => spec.wamid);
        const total = input.repeats.reduce((sum, repeats) => sum + repeats, 0);
        const duplicates = total - distinct.length;
        duplicatesSeen += duplicates;

        /** Requirement 11.5 / 10.11 — every delivery, original or repeat, is acknowledged. */
        for (const response of responses) expect(response.status).toBe(200);

        /** Processed at most once: one claim, one service call, one reply, one transition per id. */
        expect([...harness.claimed].sort()).toEqual([...distinct].sort());
        expect(harness.claimed).toHaveLength(distinct.length);
        expect([...harness.serviceCalls.map((call) => call.wamid)].sort()).toEqual(
          [...distinct].sort(),
        );
        expect(harness.replies).toHaveLength(distinct.length);
        expect([...harness.transitionsApplied.map((entry) => entry.wamid)].sort()).toEqual(
          [...distinct].sort(),
        );
        for (const entry of harness.transitionsApplied) expect(entry.status).toBe('processed');

        /** Requirement 11.6 — the id is recorded, and stays recorded across the repeats. */
        for (const wamid of distinct) {
          expect(harness.rows.get(wamid)?.status).toBe('processed');
        }

        /** Every repeat is *ignored*, not dropped: it is refused by the key and reported as such. */
        expect(harness.conflicts).toHaveLength(duplicates);
        const dispositions = harness.results.map((result) => result.disposition);
        expect(dispositions.filter((value) => value === 'duplicate_ignored')).toHaveLength(
          duplicates,
        );
        expect(dispositions.filter((value) => value === 'processed')).toHaveLength(distinct.length);
        expect(dispositions).toHaveLength(total);

        /**
         * And the audit says so. A duplicate whose conflicting row was already attributed writes a
         * `duplicate_ignored` row; one that raced ahead of `attachResolvedProfile` writes none,
         * because `usage_logs.user_id` is `not null` and inventing a farmer would be worse than an
         * honest absence (`whatsapp-inbound.ts` argues this at length). Both are counted here rather
         * than assumed, so a duplicate can never be silently unrecorded.
         */
        const attributed = harness.conflicts.filter((entry) => entry.attributed).length;
        expect(harness.usageRows).toHaveLength(attributed);
        for (const row of harness.usageRows) {
          expect(row.outcome).toBe('duplicate_ignored');
          /** Requirement 11.5 — the quota is unchanged, stated in the audit rather than inferred. */
          expect(row.quota_spent).toBe(false);
          expect(row.model_provider).toBe('none');
        }

        /** No quota primitive and no real provider was reached on any of these paths. */
        expect(seams.reached).toEqual([]);
      }),
      { numRuns: 150 },
    );

    /** Non-vacuity: all four orders were exercised, and repeats really occurred. */
    expect([...seenOrders].sort()).toEqual([...ORDERS].sort());
    expect(duplicatesSeen).toBeGreaterThan(0);
  });

  it('spends nothing and calls nothing on a redelivery, even when the first is still in flight', async () => {
    /**
     * The sharpest ordering: N identical deliveries dispatched with no `await` between them, so
     * every claim is attempted before the first one's work completes. Exactly one may proceed.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.record({ spec: specArb, copies: fc.integer({ min: 2, max: 6 }) }),
        async ({ spec, copies }) => {
          harness = harnessFor();
          seams.harness.current = harness;
          seams.reached.length = 0;

          const raw = deliveryRaw([spec]);
          const signature = signatureFor(raw);

          const responses = await Promise.all(
            Array.from({ length: copies }, () => POST(post(raw, signature))),
          );

          for (const response of responses) expect(response.status).toBe(200);
          expect(harness.claimed).toEqual([spec.wamid]);
          expect(harness.serviceCalls).toHaveLength(1);
          expect(harness.replies).toHaveLength(1);
          expect(harness.conflicts).toHaveLength(copies - 1);
          expect(
            harness.results.filter((result) => result.disposition === 'duplicate_ignored'),
          ).toHaveLength(copies - 1);
          /** One terminal transition. The `status = 'received'` guard refuses any second writer. */
          expect(harness.transitionsApplied).toHaveLength(1);
          expect(harness.usageRows.every((row) => row.quota_spent === false)).toBe(true);
          expect(seams.reached).toEqual([]);
        },
      ),
      { numRuns: 60 },
    );
  });
});
