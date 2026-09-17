import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminWhatsappInboundStore, type InboundStoreOptions } from '@/lib/db/whatsapp-inbound';
import { STORAGE_BUCKETS } from '@/lib/config/verified';
import { knowledgePayloadOf, knowledgeReaderFrom } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import type { Language, VerifiedCondition } from '@/lib/schemas';
import { dayWindowKey } from '@/lib/time';
import {
  isAdmissibleInboundMime,
  storeInboundMedia,
  type FetchLike,
  type InboundContent,
  type InboundMessage,
} from '@/lib/whatsapp';
import {
  SOFT_DEADLINE_DETAIL,
  adminProfileByPhoneStore,
  formatChatReply,
  formatDiagnosisReply,
  formatVoiceReply,
  processInboundBatch,
  processInboundMessage,
  type WhatsappDiagnosisService,
  type WhatsappDispatchDeps,
  type WhatsappMediaStore,
  type WhatsappSender,
  type WhatsappVoiceService,
} from '@/lib/whatsapp-dispatch';
import { chatAnswerer, chatWriteStoreFrom } from '@/services/chat.service';
import { diagnose, diagnosisStoreFrom } from '@/services/diagnosis.service';
import type { CounterRpc } from '@/services/quota.service';
import { transcribeAndAnswer, voiceStoreFrom } from '@/services/voice.service';
import type { UsageLogRow, WhatsappInboundRow } from '@/types/database';

import { TEST_DATABASE_URL_VAR, describeIntegration } from './database';
import { knowledgeRow, startHarness, type Harness } from './harness';
import {
  CLASSIFICATIONS,
  DEFAULT_TRANSCRIPTION,
  RATE_LIMIT_STATUS,
  UNAVAILABLE_STATUS,
  classificationText,
  echoingRephrase,
  providerCallCount,
  providerRejection,
  respondsAfterPrimaryRateLimit,
  type EchoingRephrase,
} from './providers';

/**
 * The WhatsApp channel, scenario by scenario, against a real database.
 *
 * Requirements: 10.4 (an inbound image is downloaded from Meta, stored in `crop-images`, and handed
 *               to the DiagnosisService), 10.5 (an inbound text message goes to the ChatService with
 *               that Farmer's active WhatsApp Conversation), 10.6 (an inbound audio message is stored
 *               in `voice-messages` and handed to the VoiceService), 10.9 (a type outside text, image
 *               and audio is answered with what Jamee accepts), 10.10 (the invocation completes inside
 *               the Serverless_Duration_Ceiling), 11.5 (a redelivered Provider_Message_Id is
 *               acknowledged, invokes no shared service and leaves the quota unchanged), 14.4 (a
 *               rate-limited Primary_Model is retried on the Fallback_Model), 14.5 (both providers
 *               failing produces the temporarily-busy message) — and, because every delivery passes
 *               through them: 10.2 / 10.3 (phone resolution), 10.7 / 10.8 (parity and follow-ups),
 *               10.11 (every accepted delivery is acknowledged), 14.1 / 14.2 / 14.6 / 14.7 (one shared
 *               limit, the audit row and the fallback flag), 13.2 (RLS), 17.5
 * Design: "Integration tests — mocked providers, real Postgres"; "Inbound processing order";
 *         D7 (channel parity is one code path), D10, D11 (inline, then acknowledge)
 *
 * =============================================================================
 * WHAT IS REAL HERE, AND WHAT IS NOT
 * =============================================================================
 *
 * Real: the claim insert against `whatsapp_inbound`'s primary key, the `profiles.phone` lookup
 * including the `wa_id` → E.164 normalization, `findOrCreateActive` on the farmer's single WhatsApp
 * thread, **the whole media flow** (`storeInboundMedia`: metadata, the authenticated binary fetch,
 * admission against Jamee's own limits, the extension derivation, `buildStorageRef`, and the
 * service-role upload), all three shared services, the gateway's chain order and fallback loop, both
 * adapters' request bodies and error classification, the quota reserves against `0007`, every insert,
 * and RLS underneath all of it.
 *
 * Stubbed, and each at the narrowest seam available:
 *
 *  - **`fetch`, through `MediaFetchOptions.fetchImpl`.** Not `storeInboundMedia` itself — that is the
 *    function Requirements 10.4 and 10.6 are *about*, and replacing it would leave "the media is
 *    stored in the right bucket under the farmer's own prefix" an assertion about a fixture. The fake
 *    Meta below answers step 1 and step 2 and counts both, which is what makes "refused before the
 *    media download" checkable.
 *  - **`send`.** A counting sender: "one reply, and no second one" is a claim about how many times
 *    the pipeline reaches its sender.
 *  - **The three provider SDK calls**, through `harness.providers` at the adapter seam.
 *
 * The services are injected only to redirect their **storage** and **audit** seams at the harness —
 * they are the real `diagnose`, `chatTurn` and `transcribeAndAnswer`, and `WhatsappDiagnosisService`
 * / `WhatsappVoiceService` are `typeof` those functions, so a parallel implementation could not
 * satisfy them (Requirement 16.1). The adapter's own `deadlineMs` and `now` are forwarded unchanged,
 * which is what keeps D11's budget arithmetic real rather than restarting a 45 s clock per service.
 *
 * =============================================================================
 * A RECORDED SHORTFALL THIS SUITE ASSERTS RATHER THAN HIDES
 * =============================================================================
 *
 * **Requirement 10.6 is not satisfied for `audio/aac` and `audio/amr`.** V14 lists both as inbound
 * WhatsApp audio types and asserts they are inside V10's accepted container list; they are not —
 * V10's list is `flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm`. `isAcceptedAudioContainer` refuses
 * them rather than widening the list, because inventing a container the provider may reject turns a
 * loud pre-flight refusal into a provider 400 discovered in production. So such a voice note is
 * refused **before the media download**, with the one instruction a farmer can act on ("type your
 * question instead"). The scenario below asserts that refusal and the fact that the list was not
 * widened; closing the gap needs V10 resolved, not a test change.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const LANGUAGE: Language = 'en';
const CLASSIFIED = CLASSIFICATIONS.tomatoEarlyBlight;
const CONDITION: VerifiedCondition = CLASSIFIED.disease_name;

/** The quota window every reserve in this file lands in. Pinned, for `idempotency.test.ts`'s reason. */
const QUOTA_INSTANT = new Date(Date.UTC(1970, 0, 15, 12, 0, 0));

/** Meta's own identifiers, as the delivery envelope carries them (V12). */
const PHONE_NUMBER_ID = 'jamee-integration-phone-number-id';
const WABA_ID = 'jamee-integration-waba';

/** Pinned so nothing in this file reads `WHATSAPP_API_VERSION` from the environment. */
const API_VERSION = 'v23.0';
const ACCESS_TOKEN = 'jamee-integration-access-token';

/** The prefix the fake Meta hands back as a media URL, so a download is recognizable by its URL. */
const DOWNLOAD_PREFIX = 'https://jamee-integration.invalid/whatsapp/media/download/';

/** A tiny JPEG and a tiny Ogg. Nothing inspects magic bytes; these keep the fixtures honest-looking. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);

/**
 * What the fake Meta answers for the next media request.
 *
 * `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`: a `Response` body may not be backed by a
 * `SharedArrayBuffer`, so the narrower form is what the constructor accepts. It is still assignable
 * to the plain `Uint8Array` the upload seam takes.
 */
interface MetaMedia {
  readonly mimeType: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** One request the fake Meta received. */
interface MetaRequest {
  readonly url: string;
  readonly authorized: boolean;
}

interface FakeMeta {
  readonly fetchImpl: FetchLike;
  /** Step 1 — the media id becomes a short-lived URL plus the size and type gates' input. */
  readonly metadata: MetaRequest[];
  /** Step 2 — the authenticated binary fetch. The count is what "before the download" means. */
  readonly downloads: MetaRequest[];
  media: MetaMedia;
}

/**
 * Meta's two media endpoints, as one `fetch`.
 *
 * The two are told apart by URL rather than by call order, so a scenario that refuses before step 2
 * and one that fails during it are distinguishable — and `downloads.length` is a fact about which
 * requests were actually issued rather than about how many times the fake was called.
 */
function fakeMeta(media: MetaMedia): FakeMeta {
  const state: FakeMeta = {
    media,
    metadata: [],
    downloads: [],
    fetchImpl: (input, init) => {
      const authorized = (init?.headers?.['authorization'] ?? '').startsWith('Bearer ');

      if (input.startsWith(DOWNLOAD_PREFIX)) {
        state.downloads.push({ url: input, authorized });
        return Promise.resolve(
          new Response(state.media.bytes, {
            status: 200,
            headers: { 'content-type': state.media.mimeType },
          }),
        );
      }

      state.metadata.push({ url: input, authorized });
      const mediaId = input.split('?')[0]?.split('/').pop() ?? 'media';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            messaging_product: 'whatsapp',
            id: mediaId,
            url: `${DOWNLOAD_PREFIX}${mediaId}`,
            mime_type: state.media.mimeType,
            // V14's `file_size`, which is what makes the size gate free — reported before a byte
            // moves, and read by admission on the claim.
            file_size: state.media.bytes.byteLength,
            sha256: 'jamee-integration-sha256',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    },
  };
  return state;
}

/** What the counting sender recorded, including the inbound state at the moment it was called. */
interface SentReply {
  readonly to: string;
  readonly body: string;
  readonly phoneNumberId: string | undefined;
  /**
   * How many `whatsapp_inbound` rows that same query saw **at all**, whatever their status.
   *
   * Recorded because a wrong `from_phone` filter and a wrong write ordering both drive
   * `openInboundRows` to zero, and this file once filtered on the `+`-prefixed E.164 form — which
   * matches nothing, since `claimInbound()` stores `message.fromPhone` (Meta's `wa_id`) verbatim.
   * That made D11's assertion unfalsifiable rather than failing loudly. Zero here means the query is
   * pointed at the wrong value; a non-zero count with no open row is a real ordering regression.
   */
  readonly claimedInboundRows: number;
  /**
   * How many `whatsapp_inbound` rows were still `received` **while the reply was being sent** — D11's
   * assertion.
   *
   * A count rather than one row's status, because a reply carries no WAMID (`SendReplyOptions` has
   * `to` and `body`, deliberately) and picking "the newest row" would be a guess about a timestamp.
   * Exactly one open row means the delivery now being answered is the open one: every earlier
   * delivery in this file reached a terminal status before the next one claimed.
   */
  readonly openInboundRows: number;
}

describeIntegration(`whatsapp scenarios (requires ${TEST_DATABASE_URL_VAR})`, () => {
  let harness: Harness;
  let rpc: CounterRpc;
  let rephrase: EchoingRephrase;
  let inboundOptions: InboundStoreOptions;
  let meta: FakeMeta;

  /** Every reply handed to the sender, across the whole file. */
  const replies: SentReply[] = [];
  /** One entry per nested `ChatService` invocation. */
  const chatCalls: string[] = [];
  /** One entry per `DiagnosisService` invocation, and one per `VoiceService` invocation. */
  const diagnoseCalls: string[] = [];
  const voiceCalls: string[] = [];
  /** Every WAMID this file wrote. `whatsapp_inbound` does not cascade with the farmer (0008). */
  const written: string[] = [];

  beforeAll(async () => {
    rephrase = echoingRephrase();
    harness = await startHarness({
      providers: { vision: classificationText(CLASSIFIED), text: rephrase.text },
    });
    if (harness.quota.rpc === undefined) {
      throw new Error('the harness did not bind a counter RPC, so no spend claim is checkable');
    }
    rpc = harness.quota.rpc;
    inboundOptions = { store: adminWhatsappInboundStore(harness.admin) };
    meta = fakeMeta({ mimeType: 'image/jpeg', bytes: JPEG_BYTES });
  }, 60_000);

  afterAll(async () => {
    if (written.length > 0) {
      await harness?.admin.from('whatsapp_inbound').delete().in('provider_message_id', written);
    }
    await harness?.cleanup();
  });

  /* ====================================================================== */
  /* The delivery envelope                                                  */
  /* ====================================================================== */

  /** A WAMID shaped like Meta's, unique per call, and registered for cleanup. */
  function wamid(label: string): string {
    const id = `wamid.jamee-integration.${label}.${crypto.randomUUID()}`;
    written.push(id);
    return id;
  }

  /**
   * Farmer A's number as Meta delivers it: the `wa_id`, digits only, **no leading `+`** (V12).
   *
   * The single source for that value in this file. Every delivery below is sent with it, so it is
   * also what `claimInbound()` stores in `whatsapp_inbound.from_phone` — verbatim, since the row is
   * built as `from_phone: message.fromPhone` — and what Meta is handed back as `to`. Re-deriving it
   * per call site is what let the sender's query filter on the `+`-prefixed E.164 form and silently
   * match zero rows; a function called from all three cannot drift.
   *
   * A function rather than a `const` only because `harness` is assigned in `beforeAll`.
   */
  const inboundWaId = (): string => harness.farmerA.phone.replace(/^\+/, '');

  /**
   * One inbound delivery from farmer A.
   *
   * `fromPhone` carries **no leading `+`**, which is how V12 says Meta delivers a `wa_id` and is the
   * single most likely place this channel fails silently: `profiles.phone` is strict E.164 *with* the
   * `+`, so the comparison only matches because `normalizeInboundPhone()` adds it. Passing the raw
   * form keeps that function on the real path instead of around it.
   */
  function delivery(providerMessageId: string, content: InboundContent): InboundMessage {
    return {
      providerMessageId,
      fromPhone: inboundWaId(),
      timestamp: '1700000000',
      rawType:
        content.kind === 'unsupported' || content.kind === 'unconfirmed_media_shape'
          ? content.type
          : content.kind,
      wabaId: WABA_ID,
      phoneNumberId: PHONE_NUMBER_ID,
      displayPhoneNumber: '+1 555 0100',
      content,
    };
  }

  const textContent = (body: string): InboundContent => ({ kind: 'text', body });

  const imageContent = (mediaId: string, mimeType = 'image/jpeg'): InboundContent => ({
    kind: 'image',
    mediaId,
    mimeType,
    provisional: true,
  });

  const audioContent = (mediaId: string, mimeType = 'audio/ogg'): InboundContent => ({
    kind: 'audio',
    mediaId,
    mimeType,
    voice: true,
    provisional: true,
  });

  /* ====================================================================== */
  /* Wiring                                                                 */
  /* ====================================================================== */

  /**
   * The reply sender, counted — and reading the inbound row on the way past.
   *
   * The read is D11's assertion, not decoration: "inline, then acknowledge" means the work and the
   * reply happen *inside* the invocation and the terminal status is written after the reply, not that
   * the delivery is acknowledged and the work deferred to a continuation. The row is therefore still
   * `received` at this moment, and `processed` by the time the call returns — two observations that
   * a `waitUntil`-style deferral could not both produce.
   */
  function countingSender(): WhatsappSender {
    return async (options) => {
      /**
       * `inboundWaId()`, not `harness.farmerA.phone`: the claim row stores `message.fromPhone`
       * unchanged, and that is the `wa_id` this file sends. The status is filtered in memory rather
       * than in a second `.eq()` so one round trip answers both questions — how many rows this
       * filter matched at all, and how many of them were still open.
       */
      const claimed = await harness.admin
        .from('whatsapp_inbound')
        .select('provider_message_id, status')
        .eq('from_phone', inboundWaId());

      const rows = claimed.data ?? [];

      replies.push({
        to: options.to,
        body: options.body,
        phoneNumberId: options.phoneNumberId,
        claimedInboundRows: rows.length,
        openInboundRows: rows.filter((row) => row.status === 'received').length,
      });
      return {
        ok: true,
        sentMessageId: 'wamid.jamee-integration.reply',
        bodyChars: options.body.length,
      };
    };
  }

  /** The real media flow with Meta's HTTP replaced and the upload aimed at the harness store. */
  function countingMedia(): WhatsappMediaStore {
    return (options) =>
      storeInboundMedia({
        ...options,
        client: harness.objects,
        fetchImpl: meta.fetchImpl,
        accessToken: ACCESS_TOKEN,
        apiVersion: API_VERSION,
      });
  }

  /**
   * The real `DiagnosisService`, with its storage, persistence and model seams pointed at the harness.
   *
   * `deps` is whatever the adapter passed — the service-role client, the invocation's `deadlineMs`
   * and its `now` — and it is spread **first** so those three survive. Overriding them would replace
   * D11's budget with a fresh one and make the soft-deadline scenarios untestable.
   */
  function countingDiagnose(models = harness.providers.models): WhatsappDiagnosisService {
    return (input, deps) => {
      diagnoseCalls.push(`diagnose:${input.conversationId ?? 'new'}`);
      return diagnose(input, {
        ...deps,
        storage: harness.objects,
        store: diagnosisStoreFrom(harness.admin, harness.admin),
        knowledge: knowledgeReaderFrom(harness.admin),
        models,
        quota: { rpc, now: QUOTA_INSTANT },
      });
    };
  }

  /** The real `VoiceService`, likewise. `deps.chat` is the adapter's own composed ChatService. */
  function countingVoice(): WhatsappVoiceService {
    return (input, deps) => {
      voiceCalls.push(`voice:${input.conversationId}`);
      return transcribeAndAnswer(input, {
        ...deps,
        storage: harness.objects,
        deleter: harness.objects,
        store: voiceStoreFrom(harness.admin),
        transcribe: harness.providers.transcribe,
        quota: { rpc, now: QUOTA_INSTANT },
      });
    };
  }

  /**
   * Every seam the adapter needs, with the service-role client throughout.
   *
   * Service role necessarily: a webhook carries no cookies, so there is no session to scope, and
   * `admin.ts`'s rule — every service-role query carries an explicit `user_id` anchor — is what
   * stands in for RLS here. The resolved `userId` is that anchor on every call, which is why the
   * cross-farmer reads below are still worth making: the *reads* prove RLS is a boundary even where
   * the writes did not go through it.
   */
  function dispatchDeps(
    overrides: {
      readonly deadlineMs?: number;
      readonly now?: () => number;
      readonly models?: typeof harness.providers.models;
      readonly diagnose?: WhatsappDiagnosisService;
      readonly voice?: WhatsappVoiceService;
    } = {},
  ): WhatsappDispatchDeps {
    const models = overrides.models ?? harness.providers.models;
    return {
      supabase: harness.admin,
      inbound: inboundOptions,
      profiles: adminProfileByPhoneStore(harness.admin),
      chat: (input, coverage) => {
        chatCalls.push(`chat:${input.conversationId}`);
        return chatAnswerer({
          supabase: harness.admin,
          writes: chatWriteStoreFrom(harness.admin, harness.admin),
          knowledge: knowledgeReaderFrom(harness.admin),
          models,
          quota: { rpc, now: QUOTA_INSTANT },
        })(input, coverage);
      },
      diagnose: overrides.diagnose ?? countingDiagnose(models),
      voice: overrides.voice ?? countingVoice(),
      media: countingMedia(),
      send: countingSender(),
      /**
       * D11's budget. Off-platform `getDeadline()` has no answer, so pinning it keeps the arithmetic
       * the only input — the same thing `tests/property/webhook.property.test.ts` does. Omitting
       * `deadlineMs` leaves `resolveInvocationBudget` to derive one from the gateway's own default,
       * which is the ordinary case; supplying one is how the expiry scenarios are made deterministic.
       */
      deadline: {
        platformDeadline: () => undefined,
        ...(overrides.deadlineMs === undefined ? {} : { deadlineMs: overrides.deadlineMs }),
        ...(overrides.now === undefined ? {} : { now: overrides.now }),
      },
    };
  }

  /* ====================================================================== */
  /* Shared assertions                                                      */
  /* ====================================================================== */

  function unitsUsed(operation: 'image' | 'chat' | 'voice'): Promise<number> {
    return rpc.used({
      userId: harness.farmerA.id,
      operation,
      windowKind: 'day',
      windowKey: dayWindowKey(QUOTA_INSTANT),
    });
  }

  async function inboundRow(providerMessageId: string): Promise<WhatsappInboundRow | null> {
    const { data, error } = await harness.admin
      .from('whatsapp_inbound')
      .select('*')
      .eq('provider_message_id', providerMessageId)
      .maybeSingle();

    expect(error).toBeNull();
    return data;
  }

  async function usageRows(): Promise<readonly UsageLogRow[]> {
    const { data, error } = await harness.admin
      .from('usage_logs')
      .select('*')
      .eq('user_id', harness.farmerA.id);

    expect(error).toBeNull();
    return data ?? [];
  }

  /** The farmer's single long-running WhatsApp conversation (Requirements 10.5, 10.8). */
  async function whatsappConversationId(): Promise<string> {
    const { data, error } = await harness.admin
      .from('conversations')
      .select('id')
      .eq('user_id', harness.farmerA.id)
      .eq('channel', 'whatsapp');

    expect(error).toBeNull();
    // One thread on this channel, which is what makes Requirement 10.8's "the Conversation
    // identified for that Farmer" unambiguous — and what `findOrCreateActive` is for.
    expect(data).toHaveLength(1);
    const id = data?.[0]?.id;
    if (id === undefined) throw new Error('no WhatsApp conversation was created for this farmer');
    return id;
  }

  /** Requirements 13.1 / 13.2 — the row was written with the service role and is still tenant-bound. */
  async function expectDiagnosisVisibleToOwnerOnly(id: string): Promise<void> {
    const mine = await harness.farmerA.client.from('diagnoses').select('id').eq('id', id);
    const theirs = await harness.farmerB.client.from('diagnoses').select('id').eq('id', id);
    const serviceRole = await harness.admin.from('diagnoses').select('id').eq('id', id);

    expect(mine.error).toBeNull();
    expect(mine.data).toHaveLength(1);
    expect(theirs.error).toBeNull();
    expect(theirs.data).toEqual([]);
    expect(serviceRole.data).toHaveLength(1);
  }

  const lastReply = (): SentReply => {
    const reply = replies.at(-1);
    if (reply === undefined) throw new Error('no reply has been handed to the sender yet');
    return reply;
  };

  /* ====================================================================== */
  /* An inbound image — Requirement 10.4                                    */
  /* ====================================================================== */

  describe('an inbound image message', () => {
    it('downloads the media, stores it in crop-images, and diagnoses it', async () => {
      meta.media = { mimeType: 'image/jpeg', bytes: JPEG_BYTES };
      const providerMessageId = wamid('image');
      const mediaId = `media-${crypto.randomUUID()}`;
      const imageUnitsBefore = await unitsUsed('image');
      const metadataBefore = meta.metadata.length;
      const downloadsBefore = meta.downloads.length;

      const result = await processInboundMessage(
        delivery(providerMessageId, imageContent(mediaId)),
        dispatchDeps(),
      );

      expect(result.disposition).toBe('processed');
      expect(result.replySent).toBe(true);
      expect(result.detail).toBe('ok');

      // Requirement 10.4's first clause: the media came from Meta's API, in two authenticated steps.
      // V14 states outright that omitting the Bearer token fails, so the header is asserted on both.
      expect(meta.metadata.length).toBe(metadataBefore + 1);
      expect(meta.downloads.length).toBe(downloadsBefore + 1);
      expect(meta.metadata.at(-1)?.authorized).toBe(true);
      expect(meta.downloads.at(-1)?.authorized).toBe(true);
      expect(meta.metadata.at(-1)?.url ?? '').toContain(mediaId);
      expect(meta.metadata.at(-1)?.url ?? '').toContain(API_VERSION);

      // Its second clause: stored in `crop-images`, under this farmer's own prefix, with the type the
      // bytes actually carried.
      const upload = harness.objects.uploaded.at(-1);
      expect(upload?.bucket).toBe(STORAGE_BUCKETS.cropImages);
      expect(upload?.path.startsWith(`${harness.farmerA.id}/`)).toBe(true);
      expect(upload?.path.endsWith('.jpg')).toBe(true);
      expect(upload?.contentType).toBe('image/jpeg');
      expect(upload?.bytes).toBe(JPEG_BYTES.byteLength);

      // Its third: the DiagnosisService was invoked — the real one, by its own type — and produced a
      // `whatsapp` row grounded in the seeded knowledge base.
      expect(diagnoseCalls.length).toBeGreaterThan(0);
      const conversationId = await whatsappConversationId();
      const stored = await harness.admin
        .from('diagnoses')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('status', 'identified');
      expect(stored.error).toBeNull();
      expect(stored.data).toHaveLength(1);
      const row = stored.data?.[0];
      expect(row?.channel).toBe('whatsapp');
      expect(row?.user_id).toBe(harness.farmerA.id);
      expect(row?.disease_name).toBe(CONDITION);
      expect(row?.image_bucket).toBe(STORAGE_BUCKETS.cropImages);
      expect(row?.image_path).toBe(upload?.path);
      expect(row?.knowledge_id).toBe(knowledgeRow(harness, CONDITION).id);

      // Requirement 10.7 as far as an automated test reaches: the reply is the shared formatter over
      // the shared service's result, so the two channels cannot come to disagree about what a photo
      // showed. The prose comparison is `release-acceptance.test.ts`'s; the handset comparison is a
      // human-tester item.
      const reply = lastReply();
      expect(reply.body).toContain(CONDITION);
      expect(reply.body).toContain(messages(LANGUAGE).ui.severityLabel);
      // Meta's own `wa_id` is the recipient, verbatim — not the E.164 form the lookup used.
      expect(reply.to).toBe(inboundWaId());
      expect(reply.phoneNumberId).toBe(PHONE_NUMBER_ID);

      // Requirement 14.2 — one shared per-farmer limit, spent from the WhatsApp channel.
      expect(await unitsUsed('image')).toBe(imageUnitsBefore + 1);

      /**
       * Requirement 10.11 plus D11, in the two observations a deferred continuation could not both
       * produce: the delivery was still open while its reply was going out, and it was terminal by the
       * time this call returned. "Inline, then acknowledge" is that ordering — the work happens inside
       * the invocation and the status transition follows the reply, rather than the delivery being
       * acknowledged and the work handed to a `waitUntil`.
       *
       * The first assertion separates the two ways the count can be zero: the claim row was visible
       * to that query at all, so a `from_phone` filter that stops matching fails here — with its own
       * message — rather than masquerading as an ordering regression on the line below.
       */
      expect(reply.claimedInboundRows).toBeGreaterThan(0);
      expect(reply.openInboundRows).toBe(1);
      const inbound = await inboundRow(providerMessageId);
      expect(inbound?.status).toBe('processed');
      expect(inbound?.message_type).toBe('image');
      // Requirement 11.6 — attributable, which is what makes a later redelivery auditable.
      expect(inbound?.user_id).toBe(harness.farmerA.id);

      if (row?.id !== undefined) await expectDiagnosisVisibleToOwnerOnly(row.id);
    });

    it('matches the reply to the shared formatter rather than composing its own', async () => {
      /**
       * D7's parity claim, stated as an equality rather than as a substring: the body handed to Meta
       * is exactly `formatDiagnosisReply()` over the persisted result. A channel that summarized or
       * re-worded would pass the `toContain` checks above and fail this one.
       */
      const conversationId = await whatsappConversationId();
      const stored = await harness.admin
        .from('diagnoses')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('status', 'identified')
        .single();
      expect(stored.error).toBeNull();

      // Rebuilt from the persisted row and the seeded knowledge row, so nothing in the expectation is
      // authored here — `formatDiagnosisReply` reads the status, the name, the severity, the
      // explanation and `needsExpert`, and all five come from the database.
      const expected = formatDiagnosisReply(
        {
          status: 'identified',
          diseaseName: CONDITION,
          confidence: CLASSIFIED.confidence,
          severity: CLASSIFIED.severity,
          explanation: stored.data?.explanation ?? '',
          knowledge: knowledgePayloadOf(knowledgeRow(harness, CONDITION)),
          needsExpert: false,
          language: LANGUAGE,
        },
        LANGUAGE,
      );

      const imageReply = replies.find((entry) => entry.body.includes(CONDITION));
      expect(imageReply?.body).toBe(expected);
    });
  });

  /* ====================================================================== */
  /* An inbound text message — Requirements 10.5, 10.8                      */
  /* ====================================================================== */

  describe('an inbound text message', () => {
    it('answers it through the ChatService in that farmer active WhatsApp conversation', async () => {
      const providerMessageId = wamid('text');
      const conversationId = await whatsappConversationId();
      const chatUnitsBefore = await unitsUsed('chat');
      const chatCallsBefore = chatCalls.length;
      const downloadsBefore = meta.downloads.length;

      // Requirement 10.8's own case: a follow-up with no subject of its own, which can only resolve
      // against the most recent Diagnosis_Result in this conversation — the photo sent above.
      const result = await processInboundMessage(
        delivery(providerMessageId, textContent('why?')),
        dispatchDeps(),
      );

      expect(result.disposition).toBe('processed');
      expect(result.replySent).toBe(true);
      expect(chatCalls.length).toBe(chatCallsBefore + 1);
      // Requirement 10.5 — the ChatService, with *this* conversation's identifier. No new thread.
      expect(chatCalls.at(-1)).toBe(`chat:${conversationId}`);
      expect(await whatsappConversationId()).toBe(conversationId);
      // A typed question downloads no media and touches no bucket.
      expect(meta.downloads.length).toBe(downloadsBefore);

      // The answer resolved against the diagnosis, so it is grounded rather than referred.
      const reply = lastReply();
      expect(reply.body).toContain(CONDITION);
      expect(reply.body).not.toBe(messages(LANGUAGE).chat.outOfScope);
      // Requirement 7.4 on this channel: both halves persisted, with `channel = 'whatsapp'`.
      const thread = await harness.admin
        .from('messages')
        .select('role, content, channel, input_kind')
        .eq('conversation_id', conversationId);
      expect(thread.error).toBeNull();
      const farmerMessages = (thread.data ?? []).filter((message) => message.role === 'farmer');
      const jameeMessages = (thread.data ?? []).filter((message) => message.role === 'jamee');
      expect(farmerMessages.some((message) => message.content === 'why?')).toBe(true);
      expect(jameeMessages.length).toBeGreaterThan(0);
      for (const message of thread.data ?? []) expect(message.channel).toBe('whatsapp');

      // The reply is the shared formatter over the answer, with nothing added around it.
      const answer = jameeMessages.at(-1)?.content ?? '';
      expect(reply.body).toBe(formatChatReply(answer));

      // One chat unit, shared with the web channel's limit (Requirement 14.2).
      expect(await unitsUsed('chat')).toBe(chatUnitsBefore + 1);
      expect((await inboundRow(providerMessageId))?.status).toBe('processed');
      expect((await inboundRow(providerMessageId))?.message_type).toBe('text');
    });
  });

  /* ====================================================================== */
  /* An inbound audio message — Requirement 10.6                            */
  /* ====================================================================== */

  describe('an inbound audio message', () => {
    it('stores it in voice-messages, transcribes it, and answers with the transcript', async () => {
      meta.media = { mimeType: 'audio/ogg', bytes: OGG_BYTES };
      const providerMessageId = wamid('audio');
      const mediaId = `media-${crypto.randomUUID()}`;
      const voiceBefore = await unitsUsed('voice');
      const chatBefore = await unitsUsed('chat');
      const voiceCallsBefore = voiceCalls.length;

      const result = await processInboundMessage(
        delivery(providerMessageId, audioContent(mediaId)),
        dispatchDeps(),
      );

      expect(result.disposition).toBe('processed');
      expect(result.replySent).toBe(true);
      expect(voiceCalls.length).toBe(voiceCallsBefore + 1);

      // Requirement 10.6's first clause: stored in `voice-messages`, under the farmer's own prefix,
      // with the container V10 accepts.
      const upload = harness.objects.uploaded.at(-1);
      expect(upload?.bucket).toBe(STORAGE_BUCKETS.voiceMessages);
      expect(upload?.path.startsWith(`${harness.farmerA.id}/`)).toBe(true);
      expect(upload?.path.endsWith('.ogg')).toBe(true);
      expect(upload?.contentType).toBe('audio/ogg');

      // Its second: the VoiceService was invoked with that reference, and the reply carries what
      // Jamee heard as well as the answer — Requirement 8.6's pair, on this channel.
      const transcript = harness.providers.calls.transcription.at(-1);
      expect(transcript?.url ?? '').toContain(upload?.path ?? 'no path');
      const reply = lastReply();
      expect(reply.body).toContain(messages(LANGUAGE).ui.transcriptLabel);

      const conversationId = await whatsappConversationId();
      const voiceMessage = await harness.admin
        .from('messages')
        .select('content, input_kind, transcript_of')
        .eq('conversation_id', conversationId)
        .eq('input_kind', 'voice')
        .single();
      expect(voiceMessage.error).toBeNull();
      // Requirement 8.4 — the transcript entered the conversation as a farmer message, verbatim, and
      // the row records which object it came from (an object that is gone moments later).
      const heard = voiceMessage.data?.content ?? '';
      expect(heard).toBe(DEFAULT_TRANSCRIPTION.text);
      expect(voiceMessage.data?.transcript_of).toBe(upload?.path);

      // The reply is the shared formatter over the two stored halves — asserted as an equality
      // against rows rather than by re-splitting the body, so a channel that re-worded either half
      // would fail here.
      const answered = await harness.admin
        .from('messages')
        .select('content')
        .eq('conversation_id', conversationId)
        .eq('role', 'jamee')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .single();
      expect(answered.error).toBeNull();
      expect(reply.body).toBe(formatVoiceReply(heard, answered.data?.content ?? '', LANGUAGE));

      // Requirement 14.1 on this channel: one voice unit, and the nested chat answer spent none —
      // the adapter hands the VoiceService the *same* composed ChatService, which passes coverage.
      expect(await unitsUsed('voice')).toBe(voiceBefore + 1);
      expect(await unitsUsed('chat')).toBe(chatBefore);

      // Requirement 8.9 — the transcript is durable, so the recording is gone.
      const removal = harness.objects.removed.at(-1);
      expect(removal?.bucket).toBe(STORAGE_BUCKETS.voiceMessages);
      expect(removal?.paths).toEqual([upload?.path]);
      expect((await inboundRow(providerMessageId))?.status).toBe('processed');
      expect((await inboundRow(providerMessageId))?.message_type).toBe('audio');
    });

    it('refuses an aac or amr voice note before downloading a single byte', async () => {
      /**
       * =====================================================================
       * REQUIREMENT 10.6's RECORDED SHORTFALL, ASSERTED RATHER THAN PAPERED OVER
       * =====================================================================
       *
       * V14 lists `audio/aac` and `audio/amr` as inbound WhatsApp audio and asserts they are inside
       * V10's accepted container list. They are not, and the list is deliberately **not widened
       * here**: inventing a container Groq may reject would turn a loud pre-flight refusal into a
       * provider 400 discovered in production. So Jamee refuses, and the refusal is placed where the
       * fact already is — admission, on Meta's *claimed* `mime_type` from step 1 — rather than in the
       * transcription adapter, which would cost a 16 MB download and leave a retained object for the
       * whole Retention_Window to reach the same answer.
       *
       * The farmer reads the one instruction they can act on. They cannot change what WhatsApp
       * records in, so "type your question instead" is the accurate advice and the code behind it is
       * not retryable.
       */
      expect(isAdmissibleInboundMime('audio', 'audio/ogg')).toBe(true);
      expect(isAdmissibleInboundMime('audio', 'audio/aac')).toBe(false);
      expect(isAdmissibleInboundMime('audio', 'audio/amr')).toBe(false);

      for (const mimeType of ['audio/aac', 'audio/amr'] as const) {
        meta.media = { mimeType, bytes: OGG_BYTES };
        const providerMessageId = wamid(`audio-${mimeType.replace('/', '-')}`);
        const voiceBefore = await unitsUsed('voice');
        const downloadsBefore = meta.downloads.length;
        const uploadsBefore = harness.objects.uploaded.length;
        const voiceCallsBefore = voiceCalls.length;

        const result = await processInboundMessage(
          delivery(providerMessageId, audioContent(`media-${crypto.randomUUID()}`, mimeType)),
          dispatchDeps(),
        );

        // `rejected_media`, not `failed`: Jamee decided not to act, which is a different fact from
        // Jamee being unable to finish (migration `0008`'s status machine keeps them apart).
        expect(result.disposition).toBe('rejected_media');
        expect(result.detail).toBe('media:voice_container_unsupported');
        expect(result.replySent).toBe(true);
        expect(lastReply().body).toBe(messages(LANGUAGE).whatsapp.voiceNoteFormatUnsupported);

        // Before the download, and therefore before anything was stored or spent. Step 1 ran — that
        // is where the type came from — and step 2 did not.
        expect(meta.downloads.length).toBe(downloadsBefore);
        expect(harness.objects.uploaded.length).toBe(uploadsBefore);
        expect(voiceCalls.length).toBe(voiceCallsBefore);
        expect(await unitsUsed('voice')).toBe(voiceBefore);
        expect((await inboundRow(providerMessageId))?.status).toBe('rejected');
      }

      meta.media = { mimeType: 'image/jpeg', bytes: JPEG_BYTES };
    });
  });

  /* ====================================================================== */
  /* A type Jamee does not act on — Requirement 10.9                        */
  /* ====================================================================== */

  describe('an inbound message of an unsupported type', () => {
    it('replies that Jamee accepts photos, text and voice notes, and spends nothing', async () => {
      const providerMessageId = wamid('sticker');
      const callsBefore = providerCallCount(harness.providers.calls);
      const downloadsBefore = meta.downloads.length;
      const usageBefore = (await usageRows()).length;

      const result = await processInboundMessage(
        delivery(providerMessageId, {
          kind: 'unsupported',
          type: 'sticker',
          reason: 'type_outside_supported_set',
        }),
        dispatchDeps(),
      );

      expect(result.disposition).toBe('rejected_unsupported_type');
      expect(result.detail).toBe('type_outside_supported_set');
      expect(result.replySent).toBe(true);
      // Requirement 10.9 names exactly what Jamee accepts, from the catalog, in the farmer's own
      // language — so this path ships pre-translated and needs no model (D5).
      expect(lastReply().body).toBe(messages(LANGUAGE).whatsapp.unsupportedType);

      // No service, no provider, no media, no unit, and no audit row: nothing happened that the audit
      // vocabulary has a value for. `rejected` is the record.
      expect(providerCallCount(harness.providers.calls)).toBe(callsBefore);
      expect(meta.downloads.length).toBe(downloadsBefore);
      expect((await usageRows()).length).toBe(usageBefore);
      expect((await inboundRow(providerMessageId))?.status).toBe('rejected');
      expect((await inboundRow(providerMessageId))?.message_type).toBe('sticker');
    });
  });

  /* ====================================================================== */
  /* A duplicate delivery — Requirement 11.5                                */
  /* ====================================================================== */

  describe('a redelivered image', () => {
    it('acknowledges it, downloads nothing, invokes nothing, and spends nothing', async () => {
      /**
       * `idempotency.test.ts` establishes the primary key, the SQLSTATE and the concurrency for a
       * **text** delivery, with `diagnose`, `voice` and `media` injected as functions that throw. This
       * is the same requirement over the expensive path: a redelivered *photo* must not re-download
       * 16 MB from Meta, must not re-upload it, and must not re-diagnose it.
       */
      meta.media = { mimeType: 'image/jpeg', bytes: JPEG_BYTES };
      const providerMessageId = wamid('image-redelivery');
      const message = delivery(providerMessageId, imageContent(`media-${crypto.randomUUID()}`));
      const deps = dispatchDeps();

      const first = await processInboundMessage(message, deps);
      expect(first.disposition).toBe('processed');

      const imageUnits = await unitsUsed('image');
      const downloads = meta.downloads.length;
      const uploads = harness.objects.uploaded.length;
      const providerCalls = providerCallCount(harness.providers.calls);
      const diagnoses = diagnoseCalls.length;
      const repliesSent = replies.length;

      // Two redeliveries of the very same WAMID, concurrently — V13's retry behaviour.
      const redeliveries = await Promise.all([
        processInboundMessage(message, deps),
        processInboundMessage(message, deps),
      ]);

      for (const result of redeliveries) {
        expect(result.disposition).toBe('duplicate_ignored');
        expect(result.replySent).toBe(false);
        expect(result.detail).toBe('provider_message_id_already_recorded');
      }

      // Requirement 11.5 in every way it is observable here. None of these steps *checked* for a
      // duplicate — the claim insert refused before any of them was reachable.
      expect(meta.downloads.length).toBe(downloads);
      expect(harness.objects.uploaded.length).toBe(uploads);
      expect(providerCallCount(harness.providers.calls)).toBe(providerCalls);
      expect(diagnoseCalls.length).toBe(diagnoses);
      expect(replies.length).toBe(repliesSent);
      expect(await unitsUsed('image')).toBe(imageUnits);

      // Still one row, still `processed` — a redelivery does not reopen a settled delivery.
      expect((await inboundRow(providerMessageId))?.status).toBe('processed');

      // The audit says what happened rather than leaving it to be inferred from the counter (D10),
      // and every duplicate row states that nothing was spent.
      const duplicates = (await usageRows()).filter((row) => row.outcome === 'duplicate_ignored');
      expect(duplicates.length).toBeGreaterThan(0);
      for (const row of duplicates) {
        expect(row.quota_spent).toBe(false);
        expect(row.model_provider).toBe('none');
        expect(row.used_fallback).toBe(false);
        expect(row.channel).toBe('whatsapp');
        // The inbound `image` type maps to the `image` operation, taken from the conflicting row.
        expect(row.operation).toBe('image');
      }
    });
  });

  /* ====================================================================== */
  /* The soft deadline — Requirement 10.10, D11                             */
  /* ====================================================================== */

  describe('an invocation whose soft deadline has passed', () => {
    it('tells the farmer to send again, records a timeout, and starts no work', async () => {
      const providerMessageId = wamid('deadline');
      const now = QUOTA_INSTANT.getTime();
      const callsBefore = providerCallCount(harness.providers.calls);
      const downloadsBefore = meta.downloads.length;
      const diagnosesBefore = diagnoseCalls.length;
      const imageBefore = await unitsUsed('image');

      const result = await processInboundMessage(
        delivery(providerMessageId, imageContent(`media-${crypto.randomUUID()}`)),
        // Already expired against a pinned clock, so the gate's decision is arithmetic rather than
        // a race with the suite's own wall clock.
        dispatchDeps({ deadlineMs: now - 1_000, now: () => now }),
      );

      // `failed`, not `rejected`: Jamee could not finish, which is the honest record when the
      // invocation ran out of room before the work could start.
      expect(result.disposition).toBe('failed');
      expect(result.detail).toBe(SOFT_DEADLINE_DETAIL);
      expect(result.replySent).toBe(true);
      expect(lastReply().body).toBe(messages(LANGUAGE).whatsapp.takingLonger);

      // Nothing started: no media download, no service, no provider, no unit. The gate sits above all
      // four, which is what makes Requirement 10.10 a refusal rather than a cancellation.
      expect(meta.downloads.length).toBe(downloadsBefore);
      expect(diagnoseCalls.length).toBe(diagnosesBefore);
      expect(providerCallCount(harness.providers.calls)).toBe(callsBefore);
      expect(await unitsUsed('image')).toBe(imageBefore);
      expect((await inboundRow(providerMessageId))?.status).toBe('failed');

      /**
       * Requirement 3.7's audit row, on the WhatsApp channel and pre-flight: `timeout`, no provider,
       * nothing spent. Migration `0011` commits to `'timeout'` meaning a budget expiry "pre-flight or
       * in-flight", so this row is the earlier of the two and is not a different outcome.
       */
      const timeouts = (await usageRows()).filter((row) => row.outcome === 'timeout');
      expect(timeouts.length).toBeGreaterThan(0);
      for (const row of timeouts) {
        expect(row.quota_spent).toBe(false);
        expect(row.model_provider).toBe('none');
        expect(row.used_fallback).toBe(false);
        expect(row.channel).toBe('whatsapp');
        expect(row.latency_ms ?? -1).toBeGreaterThanOrEqual(0);
      }
    });

    it('answers every message of an expired batch instead of leaving the rest at received', async () => {
      /**
       * D11's other half, and the reason the batch loop is not short-circuited: Meta will not
       * redeliver an acknowledged delivery, so a batch that expires on entry 1 must still leave
       * entries 2..N with a terminal status and a farmer-visible explanation — not sitting at
       * `received` where nothing will ever collect them. The cost is stated rather than hidden: N
       * expired messages produce N replies.
       */
      const first = wamid('batch-a');
      const second = wamid('batch-b');
      const now = QUOTA_INSTANT.getTime();
      const repliesBefore = replies.length;

      const results = await processInboundBatch(
        [delivery(first, textContent('why?')), delivery(second, textContent('and how much?'))],
        dispatchDeps({ deadlineMs: now - 1_000, now: () => now }),
      );

      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.disposition).toBe('failed');
        expect(result.detail).toBe(SOFT_DEADLINE_DETAIL);
        expect(result.replySent).toBe(true);
      }
      expect(replies.length).toBe(repliesBefore + 2);
      expect((await inboundRow(first))?.status).toBe('failed');
      expect((await inboundRow(second))?.status).toBe('failed');
    });
  });

  /* ====================================================================== */
  /* Provider fallback and both-provider failure — Requirements 14.4, 14.5  */
  /* ====================================================================== */

  describe('a rate limit on the primary model', () => {
    it('retries on the fallback and still answers the photo', async () => {
      /**
       * The seam choice earning its extra lines. Nothing in the harness decides that a 429 means "try
       * the next member": the stub rejects with a numeric `status` and a `Headers`, the **real**
       * `classifyGeminiError` and `isFallbackTrigger` (V11) decide it is a fallback trigger, and the
       * **real** `run()` acts on it. A `CapabilityRunner` stub would have replaced that loop with a
       * promise and made this assertion about the harness rather than about Jamee.
       */
      meta.media = { mimeType: 'image/jpeg', bytes: JPEG_BYTES };
      const fallbackStubs = respondsAfterPrimaryRateLimit({
        vision: classificationText(CLASSIFICATIONS.potatoLateBlight),
        text: rephrase.text,
      });
      const providerMessageId = wamid('fallback');
      const imageBefore = await unitsUsed('image');

      const result = await processInboundMessage(
        delivery(providerMessageId, imageContent(`media-${crypto.randomUUID()}`)),
        dispatchDeps({ models: fallbackStubs.models }),
      );

      expect(result.disposition).toBe('processed');
      expect(result.replySent).toBe(true);

      // Requirement 14.4 — the primary was attempted and the fallback served. Both are visible in the
      // call log the adapters wrote, one entry per real SDK round trip.
      expect(fallbackStubs.calls.geminiVision).toHaveLength(1);
      expect(fallbackStubs.calls.groqChat.length).toBeGreaterThanOrEqual(1);

      // And the farmer got an answer despite the rate limit, which is the point of the requirement.
      const reply = lastReply();
      expect(reply.body).toContain('Potato Late Blight');

      const conversationId = await whatsappConversationId();
      const stored = await harness.admin
        .from('diagnoses')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('disease_name', 'Potato Late Blight')
        .single();
      expect(stored.error).toBeNull();
      expect(stored.data?.model_provider).toBe('groq');

      // Requirement 14.7 — the fallback is recorded, not just survived.
      const audit = (await usageRows()).filter((row) => row.used_fallback);
      expect(audit.length).toBeGreaterThan(0);
      for (const row of audit) {
        expect(row.model_provider).toBe('groq');
        expect(row.quota_spent).toBe(true);
        expect(row.channel).toBe('whatsapp');
      }
      expect(await unitsUsed('image')).toBe(imageBefore + 1);
    });
  });

  describe('both providers failing on one operation', () => {
    it('replies with the temporarily-busy message and records a failed delivery', async () => {
      meta.media = { mimeType: 'image/jpeg', bytes: JPEG_BYTES };
      const providerMessageId = wamid('both-down');
      const imageBefore = await unitsUsed('image');

      // Both members refuse, each with a documented fallback trigger, so the chain is exhausted for
      // real — `EXHAUSTED_CHAIN_CODE` maps `vision-classify` to `PROVIDERS_UNAVAILABLE`.
      harness.providers.script.geminiRejection = providerRejection(RATE_LIMIT_STATUS);
      harness.providers.script.groqChatRejection = providerRejection(UNAVAILABLE_STATUS);

      try {
        const result = await processInboundMessage(
          delivery(providerMessageId, imageContent(`media-${crypto.randomUUID()}`)),
          dispatchDeps(),
        );

        expect(result.disposition).toBe('failed');
        expect(result.detail).toBe('service_failed:PROVIDERS_UNAVAILABLE');
        expect(result.replySent).toBe(true);
        // Requirement 14.5's sentence, verbatim from the catalog and routed through `toEnvelope` —
        // the leak boundary, so no provider payload can reach a WhatsApp reply (Requirement 15.6).
        expect(lastReply().body).toBe(messages(LANGUAGE).errors.PROVIDERS_UNAVAILABLE);
        expect(lastReply().body).toContain('temporarily busy');

        // Requirement 14.8 — a both-provider failure on image interpretation is a *failed* operation,
        // and the unit stays spent: real provider capacity was consumed, and refunding it would let a
        // failing provider drain the free tier through retries.
        expect(await unitsUsed('image')).toBe(imageBefore + 1);
        const failures = (await usageRows()).filter(
          (row) => row.outcome === 'provider_error' && row.operation === 'image',
        );
        expect(failures.length).toBeGreaterThan(0);
        for (const row of failures) {
          expect(row.quota_spent).toBe(true);
          expect(row.channel).toBe('whatsapp');
          // No diagnosis exists for a classification that never happened, so nothing was persisted
          // to point at — which is how "failed" stays distinguishable from "degraded but served".
          expect(row.diagnosis_id).toBeNull();
        }

        expect((await inboundRow(providerMessageId))?.status).toBe('failed');
      } finally {
        // Cleared here rather than in an `afterEach`, so a scripted rejection cannot leak into a later
        // test in this file and make it fail for the wrong reason.
        delete harness.providers.script.geminiRejection;
        delete harness.providers.script.groqChatRejection;
      }
    });
  });

  /* ====================================================================== */
  /* The whole file, seen from the audit trail                              */
  /* ====================================================================== */

  it('recorded every delivery on the whatsapp channel and leaked none to the other farmer', async () => {
    const rows = await usageRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Requirement 14.6 — every row on this channel says so, whatever the outcome.
      expect(row.channel).toBe('whatsapp');
      expect(row.user_id).toBe(harness.farmerA.id);
    }

    // The three unspent outcomes this file produced, and nothing else may be unspent: a duplicate
    // (Requirement 11.5) and a pre-flight soft-deadline refusal (Requirement 3.7 / D11).
    const unspent = rows.filter((row) => !row.quota_spent);
    expect(unspent.length).toBeGreaterThan(0);
    for (const row of unspent) {
      expect(['duplicate_ignored', 'timeout']).toContain(row.outcome);
      expect(row.model_provider).toBe('none');
    }

    // Requirement 13.1 — `whatsapp_inbound` has RLS enabled with no policies at all, so neither the
    // farmer's session nor anyone else's reaches the numbers that have messaged Jamee.
    const asFarmer = await harness.farmerA.client.from('whatsapp_inbound').select('*');
    expect(asFarmer.data ?? []).toEqual([]);

    // Requirement 13.2 — and the other farmer sees none of this farmer's audit trail.
    const theirs = await harness.farmerB.client.from('usage_logs').select('user_id');
    expect(theirs.error).toBeNull();
    expect(theirs.data ?? []).toEqual([]);
  });
});
