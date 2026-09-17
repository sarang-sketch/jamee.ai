import { createHmac, randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CapabilityRunner } from '@/lib/ai/capabilities';
import {
  META_SIGNATURE_HEADER,
  META_SIGNATURE_PREFIX,
  STORAGE_BUCKETS,
} from '@/lib/config/verified';
import type {
  ExistingInbound,
  InboundReceivedRow,
  TerminalInboundStatus,
  WhatsappInboundStore,
} from '@/lib/db/whatsapp-inbound';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import { messages as catalogFor } from '@/lib/messages';
import {
  HEALTHY_CONDITION,
  VERIFIED_CONDITIONS,
  diagnoseResponseSchema,
  type DiagnoseResponse,
  type DiagnosisResult,
  type Language,
  type Severity,
  type StorageRef,
  type VerifiedCondition,
} from '@/lib/schemas';
import type { StorageClientLike } from '@/lib/storage';
import type {
  InboundMediaResult,
  SendReplyOptions,
  SendReplyResult,
  StoreInboundMediaOptions,
} from '@/lib/whatsapp';
import { formatDiagnosisReply, type WhatsappDispatchDeps } from '@/lib/whatsapp-dispatch';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import {
  diagnose,
  type DiagnosisDeps,
  type DiagnosisOutcome,
  type DiagnosisStore,
} from '@/services/diagnosis.service';
import type { CounterRpc } from '@/services/quota.service';
import type { Database, DiagnosisRow, TablesInsert } from '@/types/database';

/**
 * **Property 25: Channel parity of diagnosis content**
 *
 * > For any crop image and any fixed classification outcome, a diagnosis produced through the
 * > WhatsApp entry point and a diagnosis produced through the web entry point carry identical
 * > status, disease name, severity, and `needs_expert` values, and are grounded in the same
 * > knowledge base row.
 *
 * **Validates: Requirement 10.7**
 *
 * ### Both channels are driven, and the WhatsApp one from its own front door
 *
 * The WhatsApp side runs the **real** webhook `POST`, over a real HMAC-signed V12 delivery, through
 * the real inbound pipeline, into the **real `diagnose()`**, and out through the real
 * `formatDiagnosisReply` to the body the Meta sender is handed. Nothing about the WhatsApp path is
 * described here; it is executed.
 *
 * The web side calls the **same real `diagnose()`** with `channel: 'web'` and the **same leaf
 * seams** — the same classification payload, the same knowledge row, the same clock. The route
 * itself (`src/app/api/diagnose/route.ts`) is not driven, and the boundary is worth stating
 * plainly: that handler parses a body, calls `diagnose` once, and copies four fields onto the wire
 * (`diagnosisId`, `conversationId`, `result`, `quota`) with no reshaping —
 * `src/app/api/diagnose/route.test.ts` owns that copy. What this property owns is the claim the copy
 * cannot fix or break: that the *content* the two channels produce for one image agrees. The web
 * outcome is nonetheless put through `diagnoseResponseSchema` here, so the thing being compared is
 * the payload shape a farmer's browser receives rather than an internal object.
 *
 * ### What "identical" is asserted over, and why it is more than four fields
 *
 * The design names status, disease name, severity and `needs_expert`. Those four are asserted
 * individually, and then the **whole `DiagnosisResult`** is compared — explanation, confidence and
 * knowledge payload included — because the requirement it validates (10.7) says "the same
 * Diagnosis_Result content", and a channel that agreed on four fields while rewording the
 * explanation would satisfy the design sentence and break the requirement.
 *
 * "Grounded in the same knowledge base row" is asserted three ways, none of which is the fixture:
 *
 *  - the names the **knowledge reader** was asked for, per channel;
 *  - `knowledge_id` on the two persisted `diagnoses` rows;
 *  - the **rephrase prompt** each channel's model call carried, byte for byte. Two channels that
 *    read the same row but composed different requests from it are not grounded in it the same way,
 *    and this is the assertion that would notice.
 *
 * ### Transport formatting is allowed for, and is the only difference permitted
 *
 * A WhatsApp reply is text, so the comparison against it is containment: the farmer-visible body
 * must carry the canonical name, the severity label from the **same catalog entry** the web screen
 * reads, and the explanation verbatim. It must also carry nothing the service did not produce —
 * `formatDiagnosisReply` is asserted to be exactly the concatenation of catalog strings and service
 * fields, so "the transport formats" cannot quietly become "the transport writes agronomy".
 *
 * ### Non-vacuity: parity is trivially satisfied by two identically broken channels
 *
 * So each generated class also pins the *shape* the outcome must have — an identified class must
 * report the generated condition and the generated severity, an inconclusive class must report
 * `unknown` with a null name, `none` severity and `needsExpert` true. Ten classification outcomes
 * are enumerated (three identified, seven ways of not being identified, one of which is the healthy
 * normalization), every one must be generated, and all three languages must be exercised — the
 * severity label and the inconclusive label are catalog reads, and a parity claim over one language
 * would say nothing about the other two.
 */

/* ========================================================================== */
/* Seams                                                                       */
/* ========================================================================== */

const seams = vi.hoisted(() => {
  const reached: string[] = [];

  const tripwire = (label: string) =>
    vi.fn(() => {
      reached.push(label);
      throw new Error(`tripwire: ${label} ran instead of the injected seam`);
    });

  return {
    reached,
    processInboundBatch: vi.fn(),
    harness: { current: null as Harness | null },
    createAdminClient: tripwire('supabase.createAdminClient'),
    sendWhatsappText: tripwire('WhatsappAdapter.sendWhatsappText'),
    storeInboundMedia: tripwire('WhatsappAdapter.storeInboundMedia'),
    gatewayRunner: tripwire('ai.gatewayRunner'),
  };
});

vi.mock('@/lib/whatsapp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp')>();
  return {
    ...actual,
    sendWhatsappText: seams.sendWhatsappText,
    storeInboundMedia: seams.storeInboundMedia,
  };
});

/**
 * The pipeline stays real; the wrapper adds this file's seams to the deps the route composed — and,
 * critically, binds the **real `diagnose`** as the image seam so the WhatsApp path reaches the
 * shared service rather than a stand-in.
 */
vi.mock('@/lib/whatsapp-dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp-dispatch')>();

  const throughHarness: typeof actual.processInboundBatch = async (inbound, deps) => {
    const harness = seams.harness.current;
    if (harness === null) throw new Error('the harness was not installed before a POST');
    return actual.processInboundBatch(inbound, harness.depsFor(deps));
  };

  seams.processInboundBatch.mockImplementation(throughHarness);
  return { ...actual, processInboundBatch: seams.processInboundBatch };
});

/** Partial mock: the gateway factory is a tripwire, so no run can reach a real provider. */
vi.mock('@/lib/ai/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/capabilities')>()),
  gatewayRunner: seams.gatewayRunner,
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: seams.createAdminClient }));

import { POST } from '@/app/api/whatsapp/route';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const APP_SECRET = 'property-channel-parity-app-secret-not-a-real-credential';

const ORIGIN = 'https://jamee.test/api/whatsapp';
const USER_ID = '5c8e2f1a-3b4d-4e6f-8a9b-0c1d2e3f4a5b';
const WHATSAPP_CONVERSATION_ID = 'aa11bb22-cc33-4d44-8e55-ff6677889900';
const WEB_CONVERSATION_ID = 'bb22cc33-dd44-4e55-8f66-001122334455';
const KNOWLEDGE_ID_PREFIX = '10a0';

const WABA_ID = '102290129340398';
const PHONE_NUMBER_ID = '106540352242922';
const WA_ID = '919876543210';
const TIMESTAMP = '1758000000';

/** 2026-09-15T19:30:00Z is 2026-09-16T01:00 in Asia/Kolkata — the far side of the +05:30 offset. */
const NOW_MS = Date.parse('2026-09-15T19:30:00.000Z');
/** One budget for both channels, so neither can differ by having had more time than the other. */
const DEADLINE_MS = NOW_MS + 45_000;

vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);

const LANGUAGES: readonly Language[] = ['en', 'hi', 'mr'];

const CROP_OF: Readonly<Record<VerifiedCondition, KnowledgeEntry['crop']>> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

/** One row per verified condition, so the "same row" claim has other rows to be wrong about. */
const KNOWLEDGE_ROWS: readonly KnowledgeEntry[] = VERIFIED_CONDITIONS.map((condition, index) => {
  const healthy = condition === HEALTHY_CONDITION;
  return {
    id: `${KNOWLEDGE_ID_PREFIX}abcd-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    disease_name: condition,
    crop: CROP_OF[condition],
    scientific_name: healthy ? null : `${condition} pathogen`,
    symptoms: [`${condition} symptom line`],
    causes: [`${condition} cause line`],
    treatment: healthy ? [] : [`${condition} treatment line`],
    prevention: [`${condition} prevention line`],
    default_severity: healthy ? 'none' : 'moderate',
    source: `${condition} extension bulletin`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
});

function entryFor(condition: VerifiedCondition): KnowledgeEntry {
  const found = KNOWLEDGE_ROWS.find((row) => row.disease_name === condition);
  if (found === undefined) throw new Error(`no generated row for "${condition}"`);
  return found;
}

/* ========================================================================== */
/* The classification outcomes                                                 */
/* ========================================================================== */

/**
 * The ten fixed classification outcomes this property runs both channels over.
 *
 * Three identified shapes — including the healthy one, where the service overrides the model's
 * severity (Requirement 3.4) and both channels must therefore report `none` — and the seven ways a
 * diagnosis is not identified, which Requirement 6.4 collapses into one shape. A channel that
 * disagreed with the other on any of them would be a parity break.
 */
const OUTCOME_CLASSES = [
  'identified',
  'identified_high_severity',
  'identified_healthy_severity_overridden',
  'model_unclear',
  'model_no_plant',
  'not_json',
  'missing_field',
  'confidence_out_of_range',
  'invalid_severity',
  'unverified_condition',
] as const;

type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

const IDENTIFIED_CLASSES: readonly OutcomeClass[] = [
  'identified',
  'identified_high_severity',
  'identified_healthy_severity_overridden',
];

/** `severitySchema`'s three non-`none` values. `mild`/`severe` are catalog *labels*, not values. */
const REPORTABLE_SEVERITIES: readonly Exclude<Severity, 'none'>[] = ['low', 'moderate', 'high'];

interface Scenario {
  readonly outcomeClass: OutcomeClass;
  readonly language: Language;
  readonly condition: VerifiedCondition;
  readonly severity: Exclude<Severity, 'none'>;
  readonly confidence: number;
  readonly provider: 'gemini' | 'groq';
  readonly usedFallback: boolean;
}

/** What the classification call returns — the "fixed classification outcome" of the statement. */
function classificationFor(scenario: Scenario): string {
  const { outcomeClass } = scenario;
  const condition =
    outcomeClass === 'identified_healthy_severity_overridden' ? HEALTHY_CONDITION : scenario.condition;

  switch (outcomeClass) {
    case 'identified':
    case 'identified_healthy_severity_overridden':
      return JSON.stringify({
        status: 'identified',
        disease_name: condition,
        confidence: scenario.confidence,
        severity: scenario.severity,
      });
    /** The top of the vocabulary, pinned rather than generated, so the label lookup is exercised. */
    case 'identified_high_severity':
      return JSON.stringify({
        status: 'identified',
        disease_name: condition,
        confidence: scenario.confidence,
        severity: 'high',
      });
    case 'model_unclear':
      return JSON.stringify({
        status: 'unclear',
        disease_name: null,
        confidence: 0.1,
        severity: 'none',
      });
    case 'model_no_plant':
      return JSON.stringify({
        status: 'no_plant',
        disease_name: null,
        confidence: 0.05,
        severity: 'none',
      });
    case 'not_json':
      return 'the leaves look unwell — this is prose, not JSON';
    case 'missing_field':
      return JSON.stringify({ status: 'identified', disease_name: condition, severity: 'moderate' });
    case 'confidence_out_of_range':
      return JSON.stringify({
        status: 'identified',
        disease_name: condition,
        confidence: 1.4,
        severity: 'moderate',
      });
    case 'invalid_severity':
      return JSON.stringify({
        status: 'identified',
        disease_name: condition,
        confidence: 0.7,
        severity: 'catastrophic',
      });
    case 'unverified_condition':
      // Well-formed, and a real disease — of a crop Jamee holds no verified content for.
      return JSON.stringify({
        status: 'identified',
        disease_name: 'Wheat Rust',
        confidence: 0.9,
        severity: 'moderate',
      });
  }
}

/** The condition an identified class must report. `null` when the class cannot be identified. */
function reportedCondition(scenario: Scenario): VerifiedCondition | null {
  if (!IDENTIFIED_CLASSES.includes(scenario.outcomeClass)) return null;
  return scenario.outcomeClass === 'identified_healthy_severity_overridden'
    ? HEALTHY_CONDITION
    : scenario.condition;
}

/** Requirement 3.4 — a healthy crop reports `none` whatever the model said. */
function reportedSeverity(scenario: Scenario): Severity {
  const condition = reportedCondition(scenario);
  if (condition === null) return 'none';
  if (condition === HEALTHY_CONDITION) return 'none';
  return scenario.outcomeClass === 'identified_high_severity' ? 'high' : scenario.severity;
}

/* ========================================================================== */
/* The shared leaf seams                                                       */
/* ========================================================================== */

/** The audit row shape, named for readability at the two dozen places it is referenced. */
type AuditRow = TablesInsert<'usage_logs'>;

interface ChannelRecord {
  /** The names the knowledge reader was asked for, in order. */
  readonly knowledgeLookups: string[][];
  /** Every prompt the two capability calls carried. */
  readonly classifyPrompts: string[];
  readonly generatePrompts: string[];
  readonly diagnosisRows: TablesInsert<'diagnoses'>[];
  readonly usageRows: AuditRow[];
  readonly signedPaths: string[];
  counters: { increments: number; decrements: number };
}

function emptyRecord(): ChannelRecord {
  return {
    knowledgeLookups: [],
    classifyPrompts: [],
    generatePrompts: [],
    diagnosisRows: [],
    usageRows: [],
    signedPaths: [],
    counters: { increments: 0, decrements: 0 },
  };
}

/** A tripwire, not a stand-in: every seam is injected, so a read here means one was missed. */
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

function conversationFor(userId: string, channel: Conversation['channel']): Conversation {
  return {
    id: channel === 'whatsapp' ? WHATSAPP_CONVERSATION_ID : WEB_CONVERSATION_ID,
    user_id: userId,
    channel,
    title: null,
    created_at: '2026-09-16T00:59:00.000Z',
    updated_at: '2026-09-16T00:59:00.000Z',
  };
}

/**
 * The dependency set both channels share, differing only in which recorder it writes to.
 *
 * Every value a diagnosis could be derived from is the same object on both sides: one classification
 * payload, one knowledge table, one clock, one deadline. That is what makes a difference in the
 * output attributable to the channel rather than to the fixture.
 */
function leafSeams(scenario: Scenario, record: ChannelRecord, diagnosisId: string): DiagnosisDeps {
  const classification = classificationFor(scenario);

  const storage: StorageClientLike = {
    storage: {
      from: () => ({
        exists: () => Promise.resolve({ data: true, error: null }),
        createSignedUrl: (path: string) => {
          record.signedPaths.push(path);
          return Promise.resolve({
            data: { signedUrl: `https://storage.test/${path}?token=synthetic` },
            error: null,
          });
        },
      }),
    },
  };

  const models: CapabilityRunner = {
    classify: (call) => {
      record.classifyPrompts.push(call.prompt);
      return Promise.resolve({
        value: classification,
        provider: scenario.provider,
        usedFallback: scenario.usedFallback,
      });
    },
    generate: (call) => {
      record.generatePrompts.push(call.prompt);
      const condition = reportedCondition(scenario);
      const entry = condition === null ? null : entryFor(condition);
      return Promise.resolve({
        // Composed only from the row that was supplied, so `validateRephrased` has something it can
        // legitimately keep. Whether it keeps it or falls back to the template, both channels get
        // the same answer — which is the point.
        value:
          entry === null
            ? 'no row was supplied'
            : `${entry.disease_name}: ${entry.symptoms[0] ?? ''}`,
        provider: scenario.provider,
        usedFallback: scenario.usedFallback,
      });
    },
  };

  const store: DiagnosisStore = {
    insertDiagnosis: (row) => {
      record.diagnosisRows.push(row);
      const stored: DiagnosisRow = {
        id: diagnosisId,
        user_id: row.user_id,
        conversation_id: row.conversation_id,
        status: row.status,
        disease_name: row.disease_name ?? null,
        knowledge_id: row.knowledge_id ?? null,
        confidence: row.confidence ?? null,
        severity: row.severity,
        explanation: row.explanation,
        language: row.language,
        needs_expert: row.needs_expert ?? false,
        channel: row.channel,
        image_bucket: row.image_bucket,
        image_path: row.image_path,
        full_image_deleted_at: null,
        model_provider: row.model_provider,
        created_at: '2026-09-16T01:00:00.000Z',
      };
      return Promise.resolve(stored);
    },
    insertUsageLog: (row) => {
      record.usageRows.push(row);
      return Promise.resolve();
    },
    ownsConversation: () => Promise.resolve(true),
  };

  const conversations: ConversationStore = {
    mostRecent: (userId, channel) => Promise.resolve(conversationFor(userId, channel)),
    create: (userId, channel) => Promise.resolve(conversationFor(userId, channel)),
  };

  const knowledge: KnowledgeReader = (names) => {
    record.knowledgeLookups.push([...names]);
    return Promise.resolve(KNOWLEDGE_ROWS.filter((row) => names.includes(row.disease_name)));
  };

  const rpc: CounterRpc = {
    tryIncrement: () => {
      record.counters.increments += 1;
      return Promise.resolve(1);
    },
    decrement: () => {
      record.counters.decrements += 1;
      return Promise.resolve(0);
    },
    used: () => Promise.resolve(1),
  };

  return {
    supabase: unreachableSupabase,
    storage,
    store,
    conversations,
    knowledge,
    models,
    quota: { rpc, now: new Date(NOW_MS) },
    now: () => NOW_MS,
    deadlineMs: DEADLINE_MS,
    platformDeadline: () => undefined,
  };
}

/* ========================================================================== */
/* The WhatsApp entry point                                                    */
/* ========================================================================== */

interface StoredRow {
  user_id: string | null;
  status: string;
  message_type: string;
}

interface Harness {
  readonly depsFor: (routeDeps: WhatsappDispatchDeps) => WhatsappDispatchDeps;
  readonly record: ChannelRecord;
  readonly rows: Map<string, StoredRow>;
  readonly replies: SendReplyOptions[];
  readonly outcomes: DiagnosisOutcome[];
  readonly refs: StorageRef[];
  readonly scenario: Scenario;
  readonly diagnosisId: string;
}

const SUPABASE_STUB = {
  __jameePropertyClient: true,
} as unknown as NonNullable<WhatsappDispatchDeps['supabase']>;

function inboundStore(harness: Harness): WhatsappInboundStore {
  return {
    async insertReceived(row: InboundReceivedRow) {
      const wamid = row.provider_message_id;
      if (harness.rows.has(wamid)) {
        return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
      }
      harness.rows.set(wamid, { user_id: null, status: row.status, message_type: row.message_type });
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
      return { error: null };
    },
    async transitionFromReceived(providerMessageId: string, status: TerminalInboundStatus) {
      const row = harness.rows.get(providerMessageId);
      if (row === undefined || row.status !== 'received') return { data: [], error: null };
      row.status = status;
      return { data: [{ status }], error: null };
    },
    async insertUsageLog(row: TablesInsert<'usage_logs'>) {
      harness.record.usageRows.push(row);
      return { error: null };
    },
  };
}

/**
 * The WhatsApp media stop, as a recorded stub.
 *
 * Deliberately not the real `storeInboundMedia` here: which bucket and which prefix a WhatsApp
 * upload lands in is **Property 24's** claim and is asserted against the real function there. What
 * this property needs from it is a reference under the farmer's own prefix with the same extension
 * the web reference carries, so that the only difference between the two runs is the channel.
 */
function mediaStub(harness: Harness): (options: StoreInboundMediaOptions) => Promise<InboundMediaResult> {
  return async (options) => {
    const ref: StorageRef = {
      bucket: STORAGE_BUCKETS.cropImages,
      path: `${options.userId}/2026/09/${randomUUID()}.jpg`,
    };
    harness.refs.push(ref);
    return { ok: true, ref, kind: 'image', mimeType: 'image/jpeg', bytes: 120_000 };
  };
}

function injected(harness: Harness, routeDeps: WhatsappDispatchDeps): WhatsappDispatchDeps {
  return {
    ...routeDeps,
    /**
     * One instant and one budget, shared with the web run. `deadlineMs` is supplied so the two
     * channels cannot differ by having had different amounts of time.
     */
    deadline: { deadlineMs: DEADLINE_MS, now: () => NOW_MS, platformDeadline: () => undefined },
    supabase: SUPABASE_STUB,
    inbound: { store: inboundStore(harness) },
    usage: {
      insertUsageLog: async (row) => {
        harness.record.usageRows.push(row);
      },
    },
    profiles: {
      async byPhone() {
        return { data: { id: USER_ID, language: harness.scenario.language }, error: null };
      },
    },
    conversations: {
      mostRecent: (userId, channel) => Promise.resolve(conversationFor(userId, channel)),
      create: (userId, channel) => Promise.resolve(conversationFor(userId, channel)),
    },
    media: mediaStub(harness),
    /**
     * **The shared service itself.** The adapter's seam is typed `typeof diagnose`, so this is the
     * same function the web run calls, handed the same leaf seams — which is exactly the shape
     * Requirement 16.1 asks for and what makes the parity claim a claim about one implementation.
     */
    diagnose: async (input) => {
      const outcome = await diagnose(
        input,
        leafSeams(harness.scenario, harness.record, harness.diagnosisId),
      );
      harness.outcomes.push(outcome);
      return outcome;
    },
    send: async (options): Promise<SendReplyResult> => {
      harness.replies.push(options);
      return { ok: true, sentMessageId: 'wamid.OUT001', bodyChars: options.body.length };
    },
  };
}

function harnessFor(scenario: Scenario, diagnosisId: string): Harness {
  const harness: Harness = {
    record: emptyRecord(),
    rows: new Map<string, StoredRow>(),
    replies: [],
    outcomes: [],
    refs: [],
    scenario,
    diagnosisId,
    depsFor: (routeDeps) => injected(harness, routeDeps),
  };
  return harness;
}

/* -------------------------------------------------------------------------- */
/* The signed delivery                                                         */
/* -------------------------------------------------------------------------- */

function deliveryRaw(wamid: string): string {
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
              messages: [
                {
                  from: WA_ID,
                  id: wamid,
                  timestamp: TIMESTAMP,
                  type: 'image',
                  image: { id: `media-${wamid}`, mime_type: 'image/jpeg' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

function post(raw: string): Request {
  const digest = createHmac('sha256', APP_SECRET).update(raw, 'utf8').digest('hex');
  return new Request(ORIGIN, {
    method: 'POST',
    body: raw,
    headers: new Headers({
      'content-type': 'application/json',
      [META_SIGNATURE_HEADER]: `${META_SIGNATURE_PREFIX}${digest}`,
    }),
  });
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  outcomeClass: fc.constantFrom<OutcomeClass>(...OUTCOME_CLASSES),
  language: fc.constantFrom<Language>(...LANGUAGES),
  condition: fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS),
  severity: fc.constantFrom<Exclude<Severity, 'none'>>(...REPORTABLE_SEVERITIES),
  confidence: fc.integer({ min: 50, max: 99 }).map((percent) => percent / 100),
  provider: fc.constantFrom<'gemini' | 'groq'>('gemini', 'groq'),
  usedFallback: fc.boolean(),
});

const wamidArb = fc
  .tuple(fc.integer({ min: 1, max: 9_999 }), fc.constantFrom('A', 'B', 'C'))
  .map(([serial, suffix]) => `wamid.HBgMOTE5ODc2NTQzMjEw${suffix}${serial}`);

/* ========================================================================== */
/* Setup                                                                       */
/* ========================================================================== */

beforeAll(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

beforeEach(() => {
  seams.reached.length = 0;
  seams.processInboundBatch.mockClear();
});

/** The columns two channels' audit rows must agree on. `channel` is the one that must differ. */
const AUDIT_COLUMNS_THAT_MUST_AGREE = [
  'user_id',
  'operation',
  'outcome',
  'model_provider',
  'used_fallback',
  'quota_spent',
  'rejection_reason',
  'prompt_version',
] as const;

/* ========================================================================== */
/* Property 25                                                                 */
/* ========================================================================== */

describe('Property 25: the two channels carry identical diagnosis content', () => {
  it('produces the same result, from the same knowledge row, for the same image on either channel', async () => {
    const exercised = new Set<OutcomeClass>();
    const languagesSeen = new Set<Language>();
    const statusesSeen = new Set<DiagnosisResult['status']>();

    await fc.assert(
      fc.asyncProperty(scenarioArb, wamidArb, async (scenario, wamid) => {
        const { language, outcomeClass } = scenario;
        const label = `${outcomeClass} / ${language}`;
        exercised.add(outcomeClass);
        languagesSeen.add(language);

        /* ── The WhatsApp entry point: a signed delivery, driven through the route ── */
        const whatsapp = harnessFor(scenario, 'd1111111-1111-4111-8111-111111111111');
        seams.harness.current = whatsapp;

        const response = await POST(post(deliveryRaw(wamid)));
        /** Requirement 10.11, still true on every one of these runs. */
        expect(response.status, label).toBe(200);
        expect(whatsapp.outcomes, `${label} did not reach the shared service`).toHaveLength(1);
        const whatsappOutcome = whatsapp.outcomes[0] as DiagnosisOutcome;

        /* ── The web entry point: the same service, the same seams, channel 'web' ── */
        const webRecord = emptyRecord();
        const webRef: StorageRef = {
          bucket: STORAGE_BUCKETS.cropImages,
          path: `${USER_ID}/2026/09/${randomUUID()}.jpg`,
        };
        const webOutcome = await diagnose(
          { userId: USER_ID, storageRef: webRef, language, channel: 'web' },
          leafSeams(scenario, webRecord, 'd2222222-2222-4222-8222-222222222222'),
        );

        /** What the browser is handed: the four fields the route copies, through the wire schema. */
        const webPayload: DiagnoseResponse = diagnoseResponseSchema.parse({
          diagnosisId: webOutcome.diagnosisId,
          conversationId: webOutcome.conversationId,
          result: webOutcome.result,
          quota: webOutcome.quota,
        });

        const whatsappResult = whatsappOutcome.result;
        const webResult = webPayload.result;
        statusesSeen.add(webResult.status);

        /* ── The four fields the design names ─────────────────────────────────── */
        expect(whatsappResult.status, label).toBe(webResult.status);
        expect(
          whatsappResult.status === 'identified' ? whatsappResult.diseaseName : null,
          label,
        ).toBe(webResult.status === 'identified' ? webResult.diseaseName : null);
        expect(whatsappResult.severity, label).toBe(webResult.severity);
        expect(whatsappResult.needsExpert, label).toBe(webResult.needsExpert);

        /* ── And the whole content, which is what Requirement 10.7 asks for ───── */
        expect(whatsappResult, label).toStrictEqual(webResult);
        expect(whatsappOutcome.provider, label).toBe(webOutcome.provider);
        expect(whatsappOutcome.usedFallback, label).toBe(webOutcome.usedFallback);
        expect(whatsappOutcome.rejectionReason, label).toBe(webOutcome.rejectionReason);

        /* ── Grounded in the same knowledge base row ──────────────────────────── */
        expect(whatsapp.record.knowledgeLookups, label).toStrictEqual(webRecord.knowledgeLookups);
        expect(rowOf(whatsapp.record).knowledge_id, label).toBe(rowOf(webRecord).knowledge_id);
        /** Same row, same rephrase request — byte for byte, including the language instruction. */
        expect(whatsapp.record.generatePrompts, label).toStrictEqual(webRecord.generatePrompts);
        expect(whatsapp.record.classifyPrompts, label).toStrictEqual(webRecord.classifyPrompts);

        /* ── The persisted rows agree on the diagnosis and differ on the channel ─ */
        const whatsappRow = rowOf(whatsapp.record);
        const webRow = rowOf(webRecord);
        expect(whatsappRow.status, label).toBe(webRow.status);
        expect(whatsappRow.disease_name, label).toBe(webRow.disease_name);
        expect(whatsappRow.severity, label).toBe(webRow.severity);
        expect(whatsappRow.needs_expert, label).toBe(webRow.needs_expert);
        expect(whatsappRow.explanation, label).toBe(webRow.explanation);
        expect(whatsappRow.confidence, label).toBe(webRow.confidence);
        /** Requirement 16.5 — the channel each service call was given, on its own row. */
        expect(whatsappRow.channel).toBe('whatsapp');
        expect(webRow.channel).toBe('web');

        /* ── The audit rows agree on everything except the channel ────────────── */
        const whatsappAudit = auditOf(whatsapp.record);
        const webAudit = auditOf(webRecord);
        for (const column of AUDIT_COLUMNS_THAT_MUST_AGREE) {
          expect(whatsappAudit[column], `${label} disagreed on usage_logs.${column}`).toStrictEqual(
            webAudit[column],
          );
        }
        expect(whatsappAudit.channel).toBe('whatsapp');
        expect(webAudit.channel).toBe('web');

        /* ── The transport's own formatting, and nothing more ─────────────────── */
        expect(whatsapp.replies, label).toHaveLength(1);
        const body = (whatsapp.replies[0] as SendReplyOptions).body;
        const catalog = catalogFor(language);

        /** The reply is exactly the shared formatter's output over the shared service's result. */
        expect(body, label).toBe(formatDiagnosisReply(webResult, language));
        /** And what that means for the farmer, stated field by field rather than by that identity. */
        expect(body, label).toContain(webResult.explanation);
        if (webResult.status === 'identified') {
          expect(body, label).toContain(webResult.diseaseName);
          expect(body, label).toContain(catalog.ui.severityLabel);
          expect(body, label).toContain(catalog.severity[webResult.severity]);
        } else {
          expect(body, label).toContain(catalog.ui.inconclusiveLabel);
          expect(body, label).toContain(catalog.ui.needsExpertBanner);
        }

        /* ── Non-vacuity per class: the shape each outcome must have ──────────── */
        const condition = reportedCondition(scenario);
        if (condition === null) {
          expect(webResult.status, label).toBe('unknown');
          expect(webResult.needsExpert, label).toBe(true);
          expect(webResult.severity, label).toBe('none');
          expect(webRow.disease_name, label).toBeNull();
          expect(webRow.knowledge_id, label).toBeNull();
        } else {
          expect(webResult.status, label).toBe('identified');
          expect(webRow.disease_name, label).toBe(condition);
          expect(webRow.knowledge_id, label).toBe(entryFor(condition).id);
          expect(webResult.severity, label).toBe(reportedSeverity(scenario));
        }

        /** Each channel spent its own unit against its own request, and neither refunded. */
        expect(whatsapp.record.counters.increments, label).toBe(1);
        expect(webRecord.counters.increments, label).toBe(1);
        expect(whatsapp.record.counters.decrements, label).toBe(0);
        expect(webRecord.counters.decrements, label).toBe(0);

        expect(seams.reached, label).toStrictEqual([]);
      }),
      { numRuns: 240 },
    );

    /* ── Non-vacuity ─────────────────────────────────────────────────────────── */
    expect([...exercised].sort()).toStrictEqual([...OUTCOME_CLASSES].sort());
    expect([...languagesSeen].sort()).toStrictEqual([...LANGUAGES].sort());
    /** Both halves of the union were produced, so parity is not a statement about one shape. */
    expect([...statusesSeen].sort()).toStrictEqual(['identified', 'unknown']);
  });

  it('adds nothing of its own to a WhatsApp reply beyond catalog strings and service fields', async () => {
    /**
     * The complement of "transport formatting is allowed for": every line of the reply is either a
     * string from the message catalog or a field the service produced. Without this, "the transport
     * may format" would be an unbounded licence, and a channel could add a sentence a farmer would
     * read as advice.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          language: fc.constantFrom<Language>(...LANGUAGES),
          condition: fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS),
          severity: fc.constantFrom<Severity>('none', ...REPORTABLE_SEVERITIES),
          identified: fc.boolean(),
        }),
        async ({ language, condition, severity, identified }) => {
          const catalog = catalogFor(language);
          const explanation = `explanation for ${condition} in ${language}`;

          const result: DiagnosisResult = identified
            ? {
                status: 'identified',
                diseaseName: condition,
                confidence: 0.8,
                severity,
                explanation,
                knowledge: {
                  symptoms: ['symptom'],
                  causes: ['cause'],
                  treatment: ['treatment'],
                  prevention: ['prevention'],
                  source: 'bulletin',
                },
                needsExpert: false,
                language,
              }
            : {
                status: 'unknown',
                diseaseName: null,
                confidence: null,
                severity: 'none',
                explanation,
                knowledge: null,
                needsExpert: true,
                language,
              };

          const body = formatDiagnosisReply(result, language);
          const permitted = new Set<string>([
            explanation,
            catalog.ui.severityLabel,
            catalog.ui.inconclusiveLabel,
            catalog.ui.needsExpertBanner,
            ...Object.values(catalog.severity),
            ...VERIFIED_CONDITIONS,
          ]);

          /**
           * Every block of the reply, once the one `label: value` join is split, is a permitted
           * string. A formatter that composed a sentence of its own would leave a block that is
           * neither a catalog entry nor a service field.
           */
          for (const block of body.split('\n\n')) {
            for (const piece of block.split(': ')) {
              expect(permitted.has(piece.trim()), `unexpected reply content: "${piece}"`).toBe(true);
            }
          }
        },
      ),
      { numRuns: 120 },
    );
  });
});

/** The one `diagnoses` row the run produced. */
function rowOf(record: ChannelRecord): TablesInsert<'diagnoses'> {
  const row = record.diagnosisRows[0];
  if (row === undefined) throw new Error('no diagnoses row was persisted');
  return row;
}

/** The one `usage_logs` row the run produced. */
function auditOf(record: ChannelRecord): AuditRow {
  const rows = record.usageRows;
  if (rows.length !== 1) {
    throw new Error(`expected exactly one usage_logs row, saw ${String(rows.length)}`);
  }
  return rows[0] as AuditRow;
}
