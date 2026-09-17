import { createHmac } from 'node:crypto';

import * as fc from 'fast-check';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCEPTED_IMAGE_TYPES,
  META_SIGNATURE_HEADER,
  META_SIGNATURE_PREFIX,
  STORAGE_BUCKETS,
  WHATSAPP_INBOUND_MAX_BYTES,
  type StorageBucket,
} from '@/lib/config/verified';
import type {
  ExistingInbound,
  InboundReceivedRow,
  TerminalInboundStatus,
  WhatsappInboundStore,
} from '@/lib/db/whatsapp-inbound';
import { isAcceptedAudioContainer } from '@/lib/groq';
import { messages as catalogFor } from '@/lib/messages';
import type { ChatAnswer, DiagnosisResult, Language, QuotaStatus } from '@/lib/schemas';
import {
  WHATSAPP_INBOUND_DOCUMENTED_MIME,
  isAdmissibleInboundMime,
  storeInboundMedia,
  type FetchLike,
  type InboundMediaResult,
  type MediaUploadClientLike,
  type SendReplyOptions,
  type SendReplyResult,
  type StoreInboundMediaOptions,
} from '@/lib/whatsapp';
import type {
  InboundDisposition,
  InboundResult,
  ProfileByPhoneStore,
  WhatsappChatService,
  WhatsappDispatchDeps,
} from '@/lib/whatsapp-dispatch';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import type { DiagnosisOutcome } from '@/services/diagnosis.service';
import { reserve, type CounterRpc } from '@/services/quota.service';
import type { NestedChatOutcome, VoiceOutcome } from '@/services/voice.service';
import type { TablesInsert } from '@/types/database';

/**
 * **Property 24: Inbound WhatsApp messages are routed by type and always acknowledged**
 *
 * > For any signed, well-formed inbound delivery from a resolvable phone number, an image is stored
 * > under that farmer's own prefix in `crop-images` and dispatched to the diagnosis service with
 * > that reference, a text message is dispatched to the chat service with that farmer's active
 * > WhatsApp conversation identifier, an audio message is stored under that farmer's prefix in
 * > `voice-messages` and dispatched to the voice service, any other message type receives a reply
 * > naming photos, text, and voice notes with no service call and no quota change, an unresolvable
 * > phone number receives sign-in instructions with no service call and no quota change, and every
 * > one of these deliveries is acknowledged with HTTP 200.
 *
 * **Validates: Requirements 10.3, 10.4, 10.5, 10.6, 10.9, 10.11**
 *
 * ### What is real here, and what is not
 *
 * The **real route handler** is driven (`POST` from `src/app/api/whatsapp/route.ts`) over a real
 * HMAC-signed body, and behind it the real admission module, the real inbound pipeline
 * (`processInboundBatch` → `processInboundMessage` → `dispatch`), the real profile resolution
 * (`normalizeInboundPhone`, `resolveProfileByPhone`), the real idempotency claim, and — the part
 * that matters most for this property — the **real `storeInboundMedia`**. Nothing decides a bucket,
 * an object path, a routing branch, or a reply sentence that the shipped code would not decide.
 *
 * `storeInboundMedia` being real is what turns "stored under that farmer's own prefix in
 * `crop-images`" into an observation instead of a restatement. Only its two leaf edges are
 * replaced: the Meta media `fetch` (metadata, then bytes) and the service-role upload. The bucket
 * comes from `WHATSAPP_MEDIA_BUCKETS`, the path from `buildStorageRef`, and the admission decision
 * from `admitInboundMedia` — so the assertion reads the values the shipped code produced. A media
 * seam that returned a hand-built `StorageRef` would have asserted the fixture.
 *
 * What else is replaced: the three domain services, the profile and conversation reads, the
 * `whatsapp_inbound` store, the audit writer, and the Meta sender. Every one of them records what
 * it was handed.
 *
 * ### "Always" is the load-bearing word, so the generator includes what cannot be routed
 *
 * `ROUTE_CLASSES` enumerates fifteen delivery classes and only four of them are routable. The rest
 * are the ways a real delivery fails to be a photo, a question or a voice note: a type outside the
 * supported set (six spellings, from a sticker to an unknown future one), a `text` message with no
 * `text.body` (a payload defect against a V12-**confirmed** path, which must *not* get Requirement
 * 10.9's sentence), a media sub-object that does not match the provisional U-V12 shape, media
 * outside the accepted type or over the effective cap, a number with no profile, and a `from` value
 * that is not E.164 at all. Every one of them must still be acknowledged with 200, and the property
 * asserts that on every iteration rather than on the happy path.
 *
 * ### The recorded gap: Requirement 10.6 is NOT satisfied for `audio/aac` and `audio/amr`
 *
 * V14 lists both as inbound WhatsApp audio types and asserts they sit inside V10's accepted
 * container list. They do not, no first-party source says they do, and
 * `docs/VERIFIED_VALUES.md` (V14 and its discrepancy note) records the decision: the accepted list
 * is **not** widened, and a voice note in either container is refused before the media download.
 *
 * This file asserts that refusal rather than papering over it, and it asserts the discrepancy from
 * source — `WHATSAPP_INBOUND_DOCUMENTED_MIME.audio` contains both, `isAdmissibleInboundMime` admits
 * neither — so the day V10 is resolved and the list widens, the pinned expectation fails and this
 * comment gets revisited instead of rotting. The refusal's cost is asserted too: exactly one
 * metadata request, **zero** binary requests, zero uploads. Requirement 10.6 remains unsatisfied
 * for those two containers, and that is the recorded intentional state, not a defect this property
 * is hiding.
 *
 * ### "No quota change" is a counted zero on a counter that really moves
 *
 * The refusal branches return before any service function is called, so nothing above them could
 * spend a unit — which is exactly the sort of claim that passes vacuously when every spender is
 * stubbed out. So the three service stubs take a real `reserve()` from `src/services/quota.service`
 * against an in-memory `CounterRpc`, as the shipped services do at their own step 3. The counter
 * therefore reads **1** on every routed delivery and **0** on every refusal, in all three
 * directions it can be touched, and a pipeline that started spending before it routed would move a
 * number this property watches.
 *
 * ### Non-vacuity
 *
 * Four guards. Every one of the fifteen classes must be generated (a `Set` asserted after
 * `fc.assert` against the declared enumeration); every declared disposition must be observed; all
 * three languages must be exercised, because the refusal sentences are read from the farmer's own
 * catalog; and the set of observed HTTP statuses must be exactly `{200}` — which is the property's
 * own claim, stated as a coverage fact so "acknowledged" cannot be satisfied by a run that
 * generated nothing.
 *
 * ### Relationship to the example-based tests
 *
 * `src/lib/whatsapp-dispatch.test.ts` pins each branch on one named delivery, `src/lib/whatsapp.test.ts`
 * pins admission and the path builder on named inputs, and `tests/property/webhook.property.test.ts`
 * owns authentication and idempotency (Property 23) with a stubbed media seam. None of them
 * generates the unroutable classes against the real media pipeline, and none of them counts the
 * quota in the same run as the routing.
 */

/* ========================================================================== */
/* Seams                                                                       */
/* ========================================================================== */

/**
 * The module-level defaults, as tripwires: reaching one means the pipeline used a real dependency
 * instead of the injected seam, which would make every count below meaningless. `reached` is
 * asserted empty on every iteration.
 *
 * `@/lib/whatsapp` is a **partial** mock that replaces only `sendWhatsappText`. `storeInboundMedia`
 * stays the shipped function, because this property is about what it stores and where.
 */
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

    diagnose: tripwire('DiagnosisService.diagnose'),
    chatAnswerer: tripwire('ChatService.chatAnswerer'),
    chatTurn: tripwire('ChatService.chatTurn'),
    transcribeAndAnswer: tripwire('VoiceService.transcribeAndAnswer'),
    createAdminClient: tripwire('supabase.createAdminClient'),
    sendWhatsappText: tripwire('WhatsappAdapter.sendWhatsappText'),
  };
});

vi.mock('@/lib/whatsapp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp')>();
  return { ...actual, sendWhatsappText: seams.sendWhatsappText };
});

/**
 * The pipeline stays **real** and is reached through the route exactly as it ships; the wrapper only
 * adds this file's seams to the deps the route composed. The route cannot be handed seams — it
 * passes only the invocation's start instant, deliberately — so a wrapper is the one place a test
 * can bind an in-memory store to the real pipeline without re-describing its behaviour.
 */
vi.mock('@/lib/whatsapp-dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp-dispatch')>();

  const throughHarness: typeof actual.processInboundBatch = async (inbound, deps) => {
    const harness = seams.harness.current;
    if (harness === null) throw new Error('the harness was not installed before a POST');

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
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: seams.createAdminClient }));

/** The route handler, imported after the mocks above — `vi.mock` is hoisted over every import. */
import { POST } from '@/app/api/whatsapp/route';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

/** Synthetic, and obviously so. The app secret is Meta's HMAC key, not a credential shape. */
const APP_SECRET = 'property-inbound-routing-app-secret-not-a-real-credential';
const ACCESS_TOKEN = 'property-inbound-routing-access-token-not-a-real-credential';

const ORIGIN = 'https://jamee.test/api/whatsapp';
const USER_ID = '3f6c1a7e-9b2d-4c8f-8e15-7a0d4b3c9e21';
const OTHER_USER_ID = '9a1b2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d';
/** The farmer's single long-running WhatsApp thread (Requirement 10.5). */
const WHATSAPP_CONVERSATION_ID = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
/** A web thread for the same farmer, so "the WhatsApp conversation" is a choice and not the only id. */
const WEB_CONVERSATION_ID = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f60';

const WABA_ID = '102290129340398';
const PHONE_NUMBER_ID = '106540352242922';
/** Meta's `wa_id`: digits, no leading `+`. `normalizeInboundPhone` closes that gap. */
const WA_ID = '919876543210';
const TIMESTAMP = '1758000000';
const API_VERSION = 'v23.0';

vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);

const LANGUAGES: readonly Language[] = ['en', 'hi', 'mr'];

const IMAGE_CAP_BYTES = WHATSAPP_INBOUND_MAX_BYTES.image;

/* ========================================================================== */
/* The delivery classes                                                        */
/* ========================================================================== */

/**
 * Every shape an inbound delivery can take that this property makes a claim about.
 *
 * Four routable, eleven not. A property over a `oneof` can pass while a branch never generates, so
 * the enumeration is declared here and asserted after the run.
 */
const ROUTE_CLASSES = [
  /* Requirement 10.5 */
  'text',
  /* Requirement 10.4 */
  'image_jpeg',
  'image_png',
  /* Requirement 10.6 */
  'audio_ogg',
  /* Requirement 10.6, unsatisfied for these two containers — see the header */
  'audio_aac',
  'audio_amr',
  /* Requirement 2.4's type set and the effective cap, applied to this channel */
  'image_type_unsupported',
  'image_too_large',
  /* Requirement 10.9 */
  'unsupported_sticker',
  'unsupported_location',
  'unsupported_contacts',
  'unsupported_document',
  'unsupported_reaction',
  'unsupported_unknown_future_type',
  /* A CONFIRMED path contradicted, and the provisional media shape not matched (U-V12) */
  'text_without_body',
  'media_shape_unconfirmed',
  /* Requirement 10.3, in its two forms */
  'sender_without_profile',
  'sender_phone_not_e164',
] as const;

type RouteClass = (typeof ROUTE_CLASSES)[number];

type RoutedService = 'diagnose' | 'chat' | 'voice';

/** Which farmer-facing sentence a refusal must be, read from the farmer's own catalog. */
type RefusalCopy =
  | 'whatsapp.signInFirst'
  | 'whatsapp.unsupportedType'
  | 'whatsapp.voiceNoteFormatUnsupported'
  | 'media.file_type_unsupported'
  | 'media.file_too_large'
  /** A coded failure's localized sentence — the payload defects, which are not farmer mistakes. */
  | 'error.internal'
  /** The reply is the service's own output; asserted by containment instead. */
  | 'service_output';

interface Expectation {
  readonly disposition: InboundDisposition;
  /** The service the delivery must reach, or `null` for every branch that must reach none. */
  readonly service: RoutedService | null;
  /** The bucket the bytes must land in, or `null` when nothing may be stored. */
  readonly bucket: StorageBucket | null;
  readonly copy: RefusalCopy;
  /** Requirement 10.3 / 10.9's "no quota change", as the number of units the delivery may spend. */
  readonly units: 0 | 1;
  /** Meta media requests: step 1 (metadata) and step 2 (the bytes). */
  readonly metadataRequests: number;
  readonly binaryRequests: number;
  readonly uploads: number;
  /** Whether `profiles.phone` was consulted at all — a non-E.164 `from` is refused above the read. */
  readonly profileRead: boolean;
}

const ROUTED_IMAGE: Expectation = {
  disposition: 'processed',
  service: 'diagnose',
  bucket: STORAGE_BUCKETS.cropImages,
  copy: 'service_output',
  units: 1,
  metadataRequests: 1,
  binaryRequests: 1,
  uploads: 1,
  profileRead: true,
};

const REFUSED_MEDIA_BEFORE_DOWNLOAD: Omit<Expectation, 'copy'> = {
  disposition: 'rejected_media',
  service: null,
  bucket: null,
  units: 0,
  metadataRequests: 1,
  binaryRequests: 0,
  uploads: 0,
  profileRead: true,
};

const REFUSED_UNSUPPORTED_TYPE: Expectation = {
  disposition: 'rejected_unsupported_type',
  service: null,
  bucket: null,
  copy: 'whatsapp.unsupportedType',
  units: 0,
  metadataRequests: 0,
  binaryRequests: 0,
  uploads: 0,
  profileRead: true,
};

const PAYLOAD_DEFECT: Expectation = {
  disposition: 'failed',
  service: null,
  bucket: null,
  copy: 'error.internal',
  units: 0,
  metadataRequests: 0,
  binaryRequests: 0,
  uploads: 0,
  profileRead: true,
};

const UNRESOLVED_SENDER: Expectation = {
  disposition: 'rejected_unresolved_sender',
  service: null,
  bucket: null,
  copy: 'whatsapp.signInFirst',
  units: 0,
  metadataRequests: 0,
  binaryRequests: 0,
  uploads: 0,
  profileRead: true,
};

const EXPECTED: Readonly<Record<RouteClass, Expectation>> = {
  text: {
    disposition: 'processed',
    service: 'chat',
    bucket: null,
    copy: 'service_output',
    units: 1,
    metadataRequests: 0,
    binaryRequests: 0,
    uploads: 0,
    profileRead: true,
  },
  image_jpeg: ROUTED_IMAGE,
  image_png: ROUTED_IMAGE,
  audio_ogg: {
    disposition: 'processed',
    service: 'voice',
    bucket: STORAGE_BUCKETS.voiceMessages,
    copy: 'service_output',
    units: 1,
    metadataRequests: 1,
    binaryRequests: 1,
    uploads: 1,
    profileRead: true,
  },
  audio_aac: { ...REFUSED_MEDIA_BEFORE_DOWNLOAD, copy: 'whatsapp.voiceNoteFormatUnsupported' },
  audio_amr: { ...REFUSED_MEDIA_BEFORE_DOWNLOAD, copy: 'whatsapp.voiceNoteFormatUnsupported' },
  image_type_unsupported: {
    ...REFUSED_MEDIA_BEFORE_DOWNLOAD,
    copy: 'media.file_type_unsupported',
  },
  image_too_large: { ...REFUSED_MEDIA_BEFORE_DOWNLOAD, copy: 'media.file_too_large' },
  unsupported_sticker: REFUSED_UNSUPPORTED_TYPE,
  unsupported_location: REFUSED_UNSUPPORTED_TYPE,
  unsupported_contacts: REFUSED_UNSUPPORTED_TYPE,
  unsupported_document: REFUSED_UNSUPPORTED_TYPE,
  unsupported_reaction: REFUSED_UNSUPPORTED_TYPE,
  unsupported_unknown_future_type: REFUSED_UNSUPPORTED_TYPE,
  text_without_body: PAYLOAD_DEFECT,
  media_shape_unconfirmed: PAYLOAD_DEFECT,
  sender_without_profile: UNRESOLVED_SENDER,
  sender_phone_not_e164: { ...UNRESOLVED_SENDER, profileRead: false },
};

/** Every disposition the enumeration above claims to produce. Asserted as observed, after the run. */
const EXPECTED_DISPOSITIONS: readonly InboundDisposition[] = [
  'processed',
  'rejected_media',
  'rejected_unsupported_type',
  'rejected_unresolved_sender',
  'failed',
];

/* -------------------------------------------------------------------------- */
/* One delivery, built from its class                                          */
/* -------------------------------------------------------------------------- */

interface Delivery {
  readonly routeClass: RouteClass;
  readonly language: Language;
  readonly wamid: string;
  readonly textBody: string;
}

/** `messages[].from`. Only the non-E.164 class differs, and it differs before the profile read. */
function fromPhoneFor(routeClass: RouteClass): string {
  return routeClass === 'sender_phone_not_e164' ? `0${WA_ID}` : WA_ID;
}

/** Meta's `mime_type` for a media class — the claim step 1 reports, before any byte moves. */
function mediaMimeFor(routeClass: RouteClass): string {
  switch (routeClass) {
    case 'image_jpeg':
    case 'image_too_large':
      return 'image/jpeg';
    case 'image_png':
      return 'image/png';
    case 'image_type_unsupported':
      // Outside `ACCEPTED_IMAGE_TYPES`, and outside V14's documented inbound image set too.
      return 'image/gif';
    case 'audio_ogg':
      return 'audio/ogg';
    case 'audio_aac':
      return 'audio/aac';
    case 'audio_amr':
      return 'audio/amr';
    default:
      throw new Error(`${routeClass} is not a media class`);
  }
}

function mediaFileSizeFor(routeClass: RouteClass): number {
  return routeClass === 'image_too_large' ? IMAGE_CAP_BYTES + 1 : 120_000;
}

const UNSUPPORTED_RAW_TYPE: Readonly<Partial<Record<RouteClass, string>>> = {
  unsupported_sticker: 'sticker',
  unsupported_location: 'location',
  unsupported_contacts: 'contacts',
  unsupported_document: 'document',
  unsupported_reaction: 'reaction',
  // A type V12 does not enumerate at all: the branch must be total over `messages[].type`.
  unsupported_unknown_future_type: 'crop_scan_beta',
};

/** `messages[].type` verbatim, which is also what `whatsapp_inbound.message_type` records. */
function rawTypeFor(routeClass: RouteClass): string {
  if (routeClass === 'text' || routeClass === 'text_without_body') return 'text';
  if (routeClass === 'media_shape_unconfirmed') return 'audio';
  if (routeClass.startsWith('image')) return 'image';
  if (routeClass.startsWith('audio')) return 'audio';
  if (routeClass.startsWith('unsupported')) return UNSUPPORTED_RAW_TYPE[routeClass] as string;
  // The two sender classes carry a real photo; what is wrong with them is the number.
  return 'image';
}

function messageObject(delivery: Delivery): Record<string, unknown> {
  const { routeClass, wamid } = delivery;
  const envelope = {
    from: fromPhoneFor(routeClass),
    id: wamid,
    timestamp: TIMESTAMP,
    type: rawTypeFor(routeClass),
  };

  if (routeClass === 'text') return { ...envelope, text: { body: delivery.textBody } };
  /** A `text` message with no `text.body` — a CONFIRMED V12 path contradicted. */
  if (routeClass === 'text_without_body') return envelope;

  if (routeClass === 'media_shape_unconfirmed') {
    /** U-V12: an audio sub-object with no media id under any name Jamee's provisional shape knows. */
    return { ...envelope, audio: { audio_reference: `media-${wamid}`, mime_type: 'audio/ogg' } };
  }

  if (routeClass.startsWith('unsupported')) {
    // No sub-object Jamee reads: the type alone decides Requirement 10.9's branch.
    return { ...envelope, [`${envelope.type}_payload`]: { id: `x-${wamid}` } };
  }

  const kind = envelope.type === 'audio' ? 'audio' : 'image';
  const media = {
    id: `media-${wamid}`,
    ...(routeClass === 'sender_without_profile' || routeClass === 'sender_phone_not_e164'
      ? { mime_type: 'image/jpeg' }
      : { mime_type: mediaMimeFor(routeClass) }),
    ...(kind === 'audio' ? { voice: true } : {}),
  };
  return { ...envelope, [kind]: media };
}

/**
 * One notification, as a **string**. The bytes are what get signed, so the body is built once and
 * both the signature and the request read the same value.
 */
function deliveryRaw(delivery: Delivery): string {
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
              contacts: [{ wa_id: fromPhoneFor(delivery.routeClass), profile: { name: 'Anita' } }],
              messages: [messageObject(delivery)],
            },
          },
        ],
      },
    ],
  });
}

function signatureFor(raw: string): string {
  return `${META_SIGNATURE_PREFIX}${createHmac('sha256', APP_SECRET).update(raw, 'utf8').digest('hex')}`;
}

function post(raw: string): Request {
  return new Request(ORIGIN, {
    method: 'POST',
    body: raw,
    headers: new Headers({
      'content-type': 'application/json',
      [META_SIGNATURE_HEADER]: signatureFor(raw),
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* What the farmer must read                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The expected reply for a refusal, resolved from the same catalogs and the same coded messages the
 * shipped code reads — never from a copy of the sentence.
 *
 * `media.*` go through `admitInboundMedia`'s own construction (the web path's `FILE_TOO_LARGE` /
 * `FILE_TYPE_UNSUPPORTED` copy, quoting the **effective** cap), which is why the expectation is
 * built by calling the real thing rather than by re-deriving a template.
 */
async function expectedRefusalBody(
  copy: RefusalCopy,
  language: Language,
  routeClass: RouteClass,
): Promise<string> {
  const catalog = catalogFor(language);
  const { admitInboundMedia } = await import('@/lib/whatsapp');
  const { AppError, toEnvelope } = await import('@/lib/errors');

  switch (copy) {
    case 'whatsapp.signInFirst':
      // Requirement 10.3's branch has no profile to read a preference from, so it is the default.
      return catalogFor('en').whatsapp.signInFirst;
    case 'whatsapp.unsupportedType':
      return catalog.whatsapp.unsupportedType;
    case 'whatsapp.voiceNoteFormatUnsupported':
      return catalog.whatsapp.voiceNoteFormatUnsupported;
    case 'media.file_type_unsupported':
    case 'media.file_too_large': {
      const refusal = admitInboundMedia({
        kind: routeClass.startsWith('audio') ? 'audio' : 'image',
        mimeType: mediaMimeFor(routeClass),
        bytes: mediaFileSizeFor(routeClass),
        language,
      });
      if (refusal === null) throw new Error(`${routeClass} was expected to be refused`);
      return refusal.reply;
    }
    case 'error.internal':
      return toEnvelope(new AppError('INTERNAL_ERROR'), language).error.message;
    case 'service_output':
      throw new Error('a routed delivery is asserted by containment, not by an expected body');
  }
}

/* ========================================================================== */
/* The harness                                                                 */
/* ========================================================================== */

interface StoredRow {
  user_id: string | null;
  status: string;
  message_type: string;
}

interface ServiceCall {
  readonly service: RoutedService;
  readonly channel: string;
  readonly conversationId: string | undefined;
  readonly bucket: string | null;
  readonly path: string | null;
  readonly message: string | null;
  readonly language: string;
}

interface Upload {
  readonly bucket: string;
  readonly path: string;
  readonly contentType: string | null;
  readonly bytes: number;
}

interface Counters {
  increments: number;
  decrements: number;
  reads: number;
}

interface MediaRequests {
  metadata: number;
  binary: number;
}

interface Harness {
  readonly depsFor: (routeDeps: WhatsappDispatchDeps) => WhatsappDispatchDeps;
  readonly results: InboundResult[];
  readonly rows: Map<string, StoredRow>;
  readonly serviceCalls: ServiceCall[];
  readonly replies: SendReplyOptions[];
  readonly profileReads: string[];
  readonly conversationRequests: { readonly userId: string; readonly channel: string }[];
  readonly uploads: Upload[];
  readonly usageRows: TablesInsert<'usage_logs'>[];
  readonly counters: Counters;
  readonly mediaRequests: MediaRequests;
  /** Which farmer the profile lookup resolves to, or `null` for Requirement 10.3's branch. */
  readonly profile: { readonly id: string; readonly language: Language } | null;
  /** The class under test, so the media fetch can answer with that class's claimed metadata. */
  readonly currentClass: () => RouteClass;
  /** Bound after construction, because the counter records into this same harness. */
  rpc: CounterRpc | null;
}

/** A client object that is never dereferenced: every seam that would use one is injected. */
const SUPABASE_STUB = {
  __jameePropertyClient: true,
} as unknown as NonNullable<WhatsappDispatchDeps['supabase']>;

function inboundStore(harness: Harness): WhatsappInboundStore {
  return {
    async insertReceived(row: InboundReceivedRow) {
      const wamid = row.provider_message_id;
      if (harness.rows.has(wamid)) {
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
      harness.usageRows.push(row);
      return { error: null };
    },
  };
}

/**
 * The counter behind the real `reserve()`. One in-memory row per
 * `(user, operation, window_kind, window_key)`, refusing the increment at the limit exactly as
 * `counter_try_increment` does.
 */
function counterRpc(harness: Harness): CounterRpc {
  const rows = new Map<string, number>();
  const key = (args: { userId: string; operation: string; windowKind: string; windowKey: string }) =>
    `${args.userId}::${args.operation}::${args.windowKind}::${args.windowKey}`;

  return {
    async tryIncrement(args) {
      harness.counters.increments += 1;
      const at = key(args);
      const used = rows.get(at) ?? 0;
      if (used >= args.limit) return null;
      rows.set(at, used + 1);
      return used + 1;
    },
    async decrement(args) {
      harness.counters.decrements += 1;
      const at = key(args);
      const used = rows.get(at) ?? 0;
      if (used === 0) return null;
      rows.set(at, used - 1);
      return used - 1;
    },
    async used(args) {
      harness.counters.reads += 1;
      return rows.get(key(args)) ?? 0;
    },
  };
}

/** Meta's two media requests, answered from memory and counted. */
function mediaFetch(harness: Harness): FetchLike {
  return async (input) => {
    if (input.startsWith('https://lookaside.test/')) {
      harness.mediaRequests.binary += 1;
      const wamid = input.slice(input.lastIndexOf('/') + 1);
      return new Response(new TextEncoder().encode(`jamee-property-bytes-${wamid}`), {
        status: 200,
        // V14: the response `content-type` gives the MIME type. Left generic so the *claimed*
        // type from step 1 is what the stored object records, which is the shipped behaviour for
        // an `application/octet-stream` download.
        headers: { 'content-type': 'application/octet-stream' },
      });
    }

    harness.mediaRequests.metadata += 1;
    const mediaId = input.slice(input.lastIndexOf('/') + 1).split('?')[0] ?? '';
    const wamid = mediaId.replace(/^media-/, '');
    const routeClass = harness.currentClass();
    return Response.json({
      id: mediaId,
      url: `https://lookaside.test/${wamid}`,
      mime_type:
        routeClass === 'sender_without_profile' || routeClass === 'sender_phone_not_e164'
          ? 'image/jpeg'
          : mediaMimeFor(routeClass),
      file_size: mediaFileSizeFor(routeClass),
    });
  };
}

/** The service-role upload, recorded rather than performed. */
function uploadClient(harness: Harness): MediaUploadClientLike {
  return {
    storage: {
      from: (bucket: string) => ({
        upload: async (
          path: string,
          body: Uint8Array,
          options?: { readonly contentType?: string; readonly upsert?: boolean },
        ) => {
          harness.uploads.push({
            bucket,
            path,
            contentType: options?.contentType ?? null,
            bytes: body.byteLength,
          });
          return { data: { path }, error: null };
        },
      }),
    },
  };
}

function conversationFor(userId: string, channel: Conversation['channel']): Conversation {
  return {
    id: channel === 'whatsapp' ? WHATSAPP_CONVERSATION_ID : WEB_CONVERSATION_ID,
    user_id: userId,
    channel,
    created_at: '2026-03-10T04:00:00.000Z',
    updated_at: '2026-03-10T04:00:00.000Z',
    title: null,
  };
}

const QUOTA: QuotaStatus = {
  operation: 'image',
  limit: 20,
  used: 1,
  resetsAt: '2026-03-11T18:30:00.000Z',
};

function answerFor(marker: string): ChatAnswer {
  return {
    messageId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
    content: `chat answer ${marker}`,
    language: 'en',
    groundedIn: ['Tomato Early Blight'],
    needsExpert: false,
  };
}

function diagnosisFor(marker: string): DiagnosisResult {
  return {
    status: 'identified',
    diseaseName: 'Tomato Early Blight',
    confidence: 0.82,
    severity: 'moderate',
    explanation: `diagnosis explanation ${marker}`,
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
}

/**
 * The seams added to whatever the route composed.
 *
 * `deadline` is merged rather than replaced: `requestStartMs` is the one fact the route contributes,
 * and overwriting it would discard it. Only `platformDeadline` is pinned — `getDeadline()` has no
 * answer off-platform.
 *
 * The three service stubs take a **real** `reserve()` against the in-memory counter, which is what
 * makes "no quota change" a counted zero rather than a consequence of stubbing the spenders out.
 */
function injected(harness: Harness, routeDeps: WhatsappDispatchDeps): WhatsappDispatchDeps {
  const spend = async (operation: 'image' | 'chat' | 'voice'): Promise<void> => {
    const rpc = harness.rpc;
    if (rpc === null) throw new Error('the counter seam was not bound before a service call');
    const outcome = await reserve(USER_ID, operation, { rpc });
    if (outcome.outcome !== 'allowed') {
      throw new Error('the in-memory counter refused a reserve this property does not exercise');
    }
  };

  const chat: WhatsappChatService = async (input): Promise<NestedChatOutcome> => {
    await spend('chat');
    harness.serviceCalls.push({
      service: 'chat',
      channel: input.channel,
      conversationId: input.conversationId,
      bucket: null,
      path: null,
      message: input.message ?? null,
      language: input.language,
    });
    return {
      conversationId: input.conversationId,
      farmerMessageId: 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f',
      answer: answerFor(input.message ?? ''),
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
    profiles: {
      async byPhone(e164Phone) {
        harness.profileReads.push(e164Phone);
        return { data: harness.profile, error: null };
      },
    } satisfies ProfileByPhoneStore,
    conversations: {
      async mostRecent(userId, channel) {
        harness.conversationRequests.push({ userId, channel });
        return conversationFor(userId, channel);
      },
      async create(userId, channel) {
        harness.conversationRequests.push({ userId, channel });
        return conversationFor(userId, channel);
      },
    } satisfies ConversationStore,
    chat,
    diagnose: async (input): Promise<DiagnosisOutcome> => {
      await spend('image');
      harness.serviceCalls.push({
        service: 'diagnose',
        channel: input.channel,
        conversationId: input.conversationId,
        bucket: input.storageRef.bucket,
        path: input.storageRef.path,
        message: null,
        language: input.language,
      });
      return {
        diagnosisId: 'd4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f80',
        conversationId: input.conversationId ?? WHATSAPP_CONVERSATION_ID,
        result: diagnosisFor(input.storageRef.path),
        quota: QUOTA,
        provider: 'gemini',
        usedFallback: false,
      };
    },
    voice: async (input): Promise<VoiceOutcome> => {
      await spend('voice');
      harness.serviceCalls.push({
        service: 'voice',
        channel: input.channel,
        conversationId: input.conversationId,
        bucket: input.storageRef.bucket,
        path: input.storageRef.path,
        message: null,
        language: input.language,
      });
      return {
        transcript: `transcript ${input.storageRef.path}`,
        answer: answerFor(input.storageRef.path),
        conversationId: input.conversationId ?? WHATSAPP_CONVERSATION_ID,
        quota: { ...QUOTA, operation: 'voice' },
        farmerMessageId: 'e5f6a7b8-c9d0-4e1f-8a3b-4c5d6e7f8091',
        provider: 'groq',
        usedFallback: false,
        audio: { outcome: 'deleted' },
      };
    },
    /**
     * **The real `storeInboundMedia`**, with only its two leaf edges replaced. Everything the
     * property asserts about a bucket, a path prefix, an extension and an admission decision is
     * therefore the shipped code's answer.
     */
    media: async (options: StoreInboundMediaOptions): Promise<InboundMediaResult> =>
      storeInboundMedia({
        ...options,
        accessToken: ACCESS_TOKEN,
        apiVersion: API_VERSION,
        fetchImpl: mediaFetch(harness),
        client: uploadClient(harness),
      }),
    send: async (options): Promise<SendReplyResult> => {
      harness.replies.push(options);
      return { ok: true, sentMessageId: 'wamid.OUT001', bodyChars: options.body.length };
    },
  };
}

function harnessFor(delivery: Delivery): Harness {
  const resolvable =
    delivery.routeClass !== 'sender_without_profile' &&
    delivery.routeClass !== 'sender_phone_not_e164';

  const harness: Harness = {
    results: [],
    rows: new Map<string, StoredRow>(),
    serviceCalls: [],
    replies: [],
    profileReads: [],
    conversationRequests: [],
    uploads: [],
    usageRows: [],
    counters: { increments: 0, decrements: 0, reads: 0 },
    mediaRequests: { metadata: 0, binary: 0 },
    profile: resolvable ? { id: USER_ID, language: delivery.language } : null,
    currentClass: () => delivery.routeClass,
    rpc: null,
    depsFor: (routeDeps: WhatsappDispatchDeps) => injected(harness, routeDeps),
  };

  harness.rpc = counterRpc(harness);
  return harness;
}

let harness: Harness;

beforeAll(() => {
  // The route and the pipeline log every decision, and a property run makes hundreds. Silenced
  // rather than asserted: the route and dispatch tests own the log content.
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

beforeEach(() => {
  seams.reached.length = 0;
  seams.processInboundBatch.mockClear();
});

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const routeClassArb = fc.constantFrom<RouteClass>(...ROUTE_CLASSES);
const languageArb = fc.constantFrom<Language>(...LANGUAGES);

/** A WAMID shaped like Meta's and inside V12's 128-character cap. */
const wamidArb = fc
  .tuple(fc.integer({ min: 1, max: 9_999 }), fc.constantFrom('A', 'B', 'C'))
  .map(([serial, suffix]) => `wamid.HBgMOTE5ODc2NTQzMjEw${suffix}${serial}`);

const deliveryArb: fc.Arbitrary<Delivery> = fc.record({
  routeClass: routeClassArb,
  language: languageArb,
  wamid: wamidArb,
  textBody: fc.constantFrom(
    'patte peele ho rahe hain',
    'my tomato leaves have dark rings',
    'पानांवर काळे डाग आहेत',
  ),
});

/* ========================================================================== */
/* The facts the property rests on                                             */
/* ========================================================================== */

describe('the V10-versus-V14 audio discrepancy this property pins, read from source', () => {
  it('documents aac and amr as inbound types while admitting neither', () => {
    /**
     * The recorded intentional state (`docs/VERIFIED_VALUES.md`, V14 and its discrepancy note):
     * V14 lists both containers, no first-party V10 source does, so the accepted list was NOT
     * widened. Asserted from the two sources rather than described, so widening the list turns this
     * red instead of silently changing what a farmer is told.
     */
    for (const mime of ['audio/aac', 'audio/amr'] as const) {
      expect(WHATSAPP_INBOUND_DOCUMENTED_MIME.audio).toContain(mime);
      expect(isAcceptedAudioContainer(mime)).toBe(false);
      expect(isAdmissibleInboundMime('audio', mime)).toBe(false);
    }

    /** And the complement, so this is a statement about those two and not about audio. */
    for (const mime of ['audio/ogg', 'audio/mpeg', 'audio/mp4'] as const) {
      expect(isAdmissibleInboundMime('audio', mime)).toBe(true);
    }
    for (const mime of ACCEPTED_IMAGE_TYPES) {
      expect(isAdmissibleInboundMime('image', mime)).toBe(true);
    }
  });
});

/* ========================================================================== */
/* Property 24                                                                 */
/* ========================================================================== */

describe('Property 24: inbound messages are routed by type, and every delivery is acknowledged', () => {
  it('routes each type to its service, refuses the rest with the right sentence, and always answers 200', async () => {
    const exercised = new Set<RouteClass>();
    const dispositions = new Set<InboundDisposition>();
    const languagesSeen = new Set<Language>();
    const statuses = new Set<number>();

    await fc.assert(
      fc.asyncProperty(deliveryArb, async (delivery) => {
        const { routeClass, language, wamid } = delivery;
        const expected = EXPECTED[routeClass];
        const label = `${routeClass} / ${language}`;

        exercised.add(routeClass);
        languagesSeen.add(language);

        harness = harnessFor(delivery);
        seams.harness.current = harness;
        seams.reached.length = 0;

        const response = await POST(post(deliveryRaw(delivery)));

        /* ── Requirement 10.11 — every one of these deliveries is acknowledged ── */
        statuses.add(response.status);
        expect(response.status, `${label} was not acknowledged`).toBe(200);
        expect(await response.text()).toBe('');

        /** One message in, one result out, with the disposition its class calls for. */
        expect(harness.results.map((result) => result.disposition), label).toStrictEqual([
          expected.disposition,
        ]);
        dispositions.add(expected.disposition);

        /** Requirement 11.6 — the id is recorded, and the row reaches a terminal status. */
        expect(harness.rows.get(wamid)?.message_type, label).toBe(rawTypeFor(routeClass));
        expect(harness.rows.get(wamid)?.status, label).not.toBe('received');

        /* ── Requirement 10.2 / 10.3 — the number, and whether it was looked up ── */
        if (expected.profileRead) {
          // The `+` is added once, by `normalizeInboundPhone`; `profiles.phone` is strict E.164.
          expect(harness.profileReads, label).toStrictEqual([`+${WA_ID}`]);
        } else {
          expect(harness.profileReads, `${label} queried a number that cannot be in the table`)
            .toStrictEqual([]);
        }

        /* ── Requirements 10.4, 10.5, 10.6 — the routing itself ──────────────── */
        const calls = harness.serviceCalls;
        expect(calls.map((call) => call.service), label).toStrictEqual(
          expected.service === null ? [] : [expected.service],
        );

        if (expected.service !== null) {
          const call = calls[0] as ServiceCall;
          /** Requirement 16.5 — the channel this adapter passes, on every service call. */
          expect(call.channel, label).toBe('whatsapp');
          /** Requirement 15.3 — and the farmer's own language. */
          expect(call.language, label).toBe(language);
          /**
           * Requirement 10.5 — the conversation identifier of that farmer's **active WhatsApp**
           * conversation. The store answers with a different id for `web`, so this is a choice the
           * pipeline made rather than the only value available.
           */
          expect(call.conversationId, label).toBe(WHATSAPP_CONVERSATION_ID);
          expect(harness.conversationRequests, label).toStrictEqual([
            { userId: USER_ID, channel: 'whatsapp' },
          ]);
          expect(WHATSAPP_CONVERSATION_ID).not.toBe(WEB_CONVERSATION_ID);
        }

        if (expected.service === 'chat') {
          /** Requirement 10.5 — the message text, verbatim. */
          expect(call0(calls).message, label).toBe(delivery.textBody);
        }

        /* ── The Storage_Reference the service received, and where the bytes went ─ */
        if (expected.bucket === null) {
          expect(harness.uploads, `${label} stored bytes it should not have`).toStrictEqual([]);
        } else {
          expect(harness.uploads.map((upload) => upload.bucket), label).toStrictEqual([
            expected.bucket,
          ]);
          const upload = harness.uploads[0] as Upload;
          /**
           * Requirement 13.6 — under **that farmer's own prefix**. The service role is outside the
           * boundary the storage policies describe, so the prefix is the mechanism that makes a
           * WhatsApp upload readable by its owner later (Requirements 12.2, 12.5).
           */
          expect(upload.path.startsWith(`${USER_ID}/`), `${label} stored outside the farmer's prefix`)
            .toBe(true);
          expect(upload.path).toMatch(
            new RegExp(`^${USER_ID}/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.(jpg|png|ogg)$`),
          );
          expect(upload.path.startsWith(`${OTHER_USER_ID}/`)).toBe(false);

          /** And the reference the service was handed **is** the object that was stored. */
          const call = call0(calls);
          expect(call.bucket, label).toBe(expected.bucket);
          expect(call.path, label).toBe(upload.path);
        }

        /* ── Requirements 10.3, 10.9 — the sentence a refused farmer reads ────── */
        expect(harness.replies.map((reply) => reply.to), label).toStrictEqual([
          fromPhoneFor(routeClass),
        ]);
        const body = (harness.replies[0] as SendReplyOptions).body;

        if (expected.copy === 'service_output') {
          /**
           * A routed delivery's reply is the service's own content, marker-tagged so containment is
           * attributable to *this* call. Requirement 10.7's parity is Property 25's claim; what is
           * asserted here is that the reply came from the service rather than from the adapter.
           */
          const marker =
            expected.service === 'chat' ? delivery.textBody : (call0(calls).path as string);
          expect(body, label).toContain(marker);
        } else {
          expect(body, label).toBe(await expectedRefusalBody(expected.copy, language, routeClass));
        }

        /* ── "No service call and no quota change", as counted zeros ──────────── */
        expect(harness.counters.increments, `${label} touched the daily counter`).toBe(
          expected.units,
        );
        expect(harness.counters.decrements, label).toBe(0);
        expect(harness.counters.reads, label).toBe(0);

        /* ── The media requests a refusal is allowed to have made ─────────────── */
        expect(harness.mediaRequests.metadata, label).toBe(expected.metadataRequests);
        expect(
          harness.mediaRequests.binary,
          `${label} downloaded media bytes it did not need`,
        ).toBe(expected.binaryRequests);
        expect(harness.uploads, label).toHaveLength(expected.uploads);

        /** No default seam was used, so nothing reached a real provider or a real credential. */
        expect(seams.reached, label).toStrictEqual([]);
      }),
      { numRuns: 300 },
    );

    /* ── Non-vacuity ─────────────────────────────────────────────────────────── */
    expect([...exercised].sort()).toStrictEqual([...ROUTE_CLASSES].sort());
    expect([...dispositions].sort()).toStrictEqual([...EXPECTED_DISPOSITIONS].sort());
    expect([...languagesSeen].sort()).toStrictEqual([...LANGUAGES].sort());
    /** The property's own claim, as a coverage fact: 200 was observed, and nothing else was. */
    expect([...statuses]).toStrictEqual([200]);
  });

  it('refuses an aac or amr voice note before the download, and says what does work', async () => {
    /**
     * The recorded gap, as its own case. Requirement 10.6 asks for a voice note to reach the
     * VoiceService; for these two containers it does not, deliberately, and the farmer is told the
     * one thing that works instead of being invited to resend a recording that will fail
     * identically forever.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          routeClass: fc.constantFrom<RouteClass>('audio_aac', 'audio_amr'),
          language: languageArb,
          wamid: wamidArb,
        }),
        async ({ routeClass, language, wamid }) => {
          harness = harnessFor({ routeClass, language, wamid, textBody: '' });
          seams.harness.current = harness;
          seams.reached.length = 0;

          const response = await POST(post(deliveryRaw({ routeClass, language, wamid, textBody: '' })));

          /** Acknowledged, like every other delivery. */
          expect(response.status).toBe(200);
          expect(harness.results[0]?.disposition).toBe('rejected_media');

          /** Refused on Meta's *claim*: one metadata request, and not one media byte. */
          expect(harness.mediaRequests.metadata).toBe(1);
          expect(harness.mediaRequests.binary).toBe(0);
          expect(harness.uploads).toStrictEqual([]);

          /** No service, no unit. */
          expect(harness.serviceCalls).toStrictEqual([]);
          expect(harness.counters.increments).toBe(0);

          /** Requirement 10.9's sentence is NOT the one used: a voice note is not an unsupported type. */
          const body = harness.replies[0]?.body;
          expect(body).toBe(catalogFor(language).whatsapp.voiceNoteFormatUnsupported);
          expect(body).not.toBe(catalogFor(language).whatsapp.unsupportedType);
          expect(seams.reached).toStrictEqual([]);
        },
      ),
      { numRuns: 60 },
    );
  });
});

/** The first service call, narrowed. A missing one is a failure the callers above have asserted. */
function call0(calls: readonly ServiceCall[]): ServiceCall {
  const call = calls[0];
  if (call === undefined) throw new Error('no service call was recorded');
  return call;
}
