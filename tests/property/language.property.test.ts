import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import type { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { POST as chatRoute } from '@/app/api/chat/route';
import { POST as diagnoseRoute } from '@/app/api/diagnose/route';
import { POST as voiceRoute } from '@/app/api/voice/route';
import { jameeRequests, type FetchLike } from '@/components/LanguageProvider';
import type { CapabilityRunner } from '@/lib/ai/capabilities';
import { STORAGE_BUCKETS } from '@/lib/config/verified';
import { AppError, withErrorHandling } from '@/lib/errors';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import { DEFAULT_LANGUAGE, languageCookie, resolveLanguage } from '@/lib/language';
import { messages as catalogFor } from '@/lib/messages';
import {
  HEALTHY_CONDITION,
  SUPPORTED_LANGUAGES,
  VERIFIED_CONDITIONS,
  channelSchema,
  chatRequestSchema,
  diagnoseRequestSchema,
  errorEnvelopeSchema,
  voiceRequestSchema,
  type Channel,
  type Language,
  type VerifiedCondition,
} from '@/lib/schemas';
import {
  chatTurn,
  type ChatTurnDeps,
  type ChatWriteStore,
  type ContextStore,
} from '@/services/chat.service';
import type { CounterRpc } from '@/services/quota.service';
import type { Database, DiagnosisRow, MessageRow, TablesInsert } from '@/types/database';

/**
 * ### Property 19: Language codes propagate, and unsupported codes are refused at the edge
 *
 * *"For any request originating after a language selection, the selected supported language code is
 * present in the request; for any response to such a request, the response's language field equals
 * the requested code and its script class matches that language; and for any language code outside
 * `en`, `hi`, `mr`, the API returns HTTP 400 naming the three supported codes."*
 *
 * **Validates: Requirements 9.2, 9.3, 9.5, 9.6**
 *
 * =============================================================================
 * TWO HALVES THAT FAIL DIFFERENTLY, SO THEY ARE DRIVEN AT DIFFERENT LAYERS
 * =============================================================================
 *
 * **Propagation** is a claim about a value surviving a chain, and it fails by the value being
 * dropped or overwritten somewhere along it. So it is driven through the chain itself, one layer per
 * step, with nothing stubbed that could supply the answer: the selection (`resolveLanguage` over the
 * cookie the switcher writes), the request (`jameeRequests`, whose three bodies are typed
 * `Omit<…, 'language'>` precisely so the code can only come from the active one), the answer and the
 * two persisted rows (`chatTurn` with every seam injected), and the error envelope
 * (`withErrorHandling` over a real coded failure).
 *
 * **Refusal at the edge** is a claim about *where* something happens, and it fails by happening too
 * late — a code that is silently defaulted deeper in still produces an answer, just the wrong one.
 * A status assertion cannot see that, so it is driven through the three real route handlers with
 * every seam past the parse replaced by a recording tripwire, and the assertion is that the ledger
 * of those seams is **empty**.
 *
 * =============================================================================
 * WHY THE COMPLEMENT IS ASSERTED IN BOTH HALVES
 * =============================================================================
 *
 * Each half has a trivially-satisfiable reading, and each is closed by its opposite:
 *
 *  - Propagation would be satisfied perfectly by a pipeline that **ignored the language entirely**
 *    and answered in one language three times — every `language` field would still equal the
 *    requested code, because the field is copied, not rendered. So each generated case is run
 *    **three times, once per supported language**, and the rendered surface is asserted to be three
 *    *different* strings. That is the assertion a language-blind pipeline fails.
 *  - Refusal would be satisfied by an endpoint that returned 400 for everything. So the same routes
 *    are driven with a supported code and an otherwise-valid body, and must **not** answer
 *    `LANGUAGE_UNSUPPORTED` — and must reach the first seam past the parse, which is what proves the
 *    language check is genuinely upstream of it rather than merely present.
 *
 * =============================================================================
 * WHICH SEAMS ARE COUNTED, AND WHY THOSE
 * =============================================================================
 *
 * "Before any provider call or quota spend" is asserted by counting the doors, not by inspecting the
 * route bodies:
 *
 *  - **`gatewayRunner()`** — the only way any service reaches a model. Counted directly, so
 *    "no provider call" is a number rather than an inference.
 *  - **`createAdminClient()`** — the service-role credential, and therefore the only door to a quota
 *    spend: `QuotaService` takes the counter RPC as a seam and its default,
 *    `adminCounterRpc(createAdminClient())`, cannot reach `counter_try_increment` without it. The
 *    audit table is behind the same credential. **This is the seam counted rather than
 *    `adminCounterRpc` itself**, and the reason is worth writing down: `quota.service.ts` calls that
 *    factory through a module-internal reference, so replacing its export intercepts a cross-module
 *    caller and nothing else. A tripwire on it would have been unfirable — green, and saying nothing.
 *    `createAdminClient` is a genuine cross-module import from that module, and it is the narrower
 *    claim anyway: no credential, no counter.
 *  - **`createServerSupabase()`** — the request-scoped credential, and the first statement inside
 *    every one of the three handlers past the parse. Its ledger entry is what the supported-language
 *    complement asserts *is* present, which is how the two halves together pin the ordering.
 *  - **`burstLimiter()`** and **`objectSizeOf()`** — the two remaining seams the handler bodies
 *    touch, so the ledger covers everything reachable past the parse rather than a chosen subset.
 *
 * Each is a **partial** mock: the rest of every module is the real one, so the propagation half runs
 * against the shipped code and only these five factories are observable. Both of the two that carry
 * the load were confirmed to fire by removing the injection they stand in for.
 *
 * =============================================================================
 * WHAT THIS PROPERTY DELIBERATELY DOES NOT ASSERT
 * =============================================================================
 *
 * **`<html lang>`.** `layout.tsx` awaits `activeLanguage(null)` — the cookie answer — and
 * `LanguageProvider` writes `document.documentElement.lang` after hydration, which together close
 * the profile-only and post-switch cases. Both are DOM behaviour and belong to the component tests;
 * a node-environment property test has no document to read, and asserting it here would mean
 * re-describing the effect rather than observing it.
 *
 * **Envelope totality.** That every code renders in every language, with no leak, is Property 29's
 * claim. What is asserted here is narrower and is this property's: the code the *farmer selected*
 * reaches the envelope, and the sentence changes with it.
 */

/* ========================================================================== */
/* Seams — recorded, then tripped                                              */
/* ========================================================================== */

/**
 * The ledger the refusal half is decided on.
 *
 * Every entry records its own name before throwing, so a violation is reported as "which door was
 * opened" rather than as an opaque status mismatch — and a handler that got past the language edge
 * fails twice over: once on the recorded call, and once on the status, because the throw surfaces as
 * a 500 rather than a 400.
 */
const seams = vi.hoisted(() => {
  const opened: string[] = [];

  const tripwire = (label: string) =>
    vi.fn(() => {
      opened.push(label);
      throw new Error(`tripwire: ${label} was reached for a request that must not reach it`);
    });

  return {
    opened,
    currentUserId: vi.fn(),
    createServerSupabase: tripwire('supabase.createServerSupabase'),
    createAdminClient: tripwire('supabase.createAdminClient'),
    burstLimiter: tripwire('rateLimit.burstLimiter'),
    objectSizeOf: tripwire('storage.objectSizeOf'),
    gatewayRunner: tripwire('ai.gatewayRunner'),
  };
});

/** The identity resolver the wrapper was built over. The real guard stays under test. */
vi.mock('@/lib/supabase/server', () => ({
  currentUserId: seams.currentUserId,
  createServerSupabase: seams.createServerSupabase,
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: seams.createAdminClient }));

/**
 * Partial mocks from here down: one factory each, everything else the shipped module.
 *
 * That is what lets the propagation half exercise the real `ChatService`, the real `QuotaService`
 * reserve, and the real rate-limit helpers in the same file that counts these five doors.
 */
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  burstLimiter: seams.burstLimiter,
}));

vi.mock('@/lib/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage')>()),
  objectSizeOf: seams.objectSizeOf,
}));

vi.mock('@/lib/ai/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/capabilities')>()),
  gatewayRunner: seams.gatewayRunner,
}));

/**
 * The imports at the top of this file resolve **after** the mocks above, not before: `vi.mock` is
 * hoisted above every import by Vitest's transform, so the three route modules and the real
 * `ChatService` both see the stubs. Keeping the imports in one block rather than splitting them
 * around the `vi.mock` calls is safe for that reason, and it is the arrangement
 * `auth-gate.property.test.ts` and every route test in `src/` already use.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const ORIGIN = 'https://jamee.test';

const USER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';

const NOW_MS = Date.parse('2026-09-16T01:30:00.000Z');

/** Devanagari, the script `hi` and `mr` are written in. `en` is written without it. */
const DEVANAGARI = /[\u0900-\u097F]/;

const CROP_OF: Record<VerifiedCondition, KnowledgeEntry['crop']> = {
  'Tomato Early Blight': 'tomato',
  'Tomato Late Blight': 'tomato',
  'Tomato Healthy': 'tomato',
  'Potato Early Blight': 'potato',
  'Potato Late Blight': 'potato',
};

function uuidFor(prefix: string, serial: number): string {
  return `${prefix}-0000-4000-8000-${String(serial).padStart(12, '0')}`;
}

const KNOWLEDGE_ROWS: readonly KnowledgeEntry[] = VERIFIED_CONDITIONS.map((condition, index) => {
  const healthy = condition === HEALTHY_CONDITION;
  return {
    id: uuidFor('1000abcd', index + 1),
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

/**
 * A lead-in per language, so a kept rephrase is visibly not the same string in the three runs.
 *
 * The three are mutually distinct on purpose: Hindi and Marathi share Devanagari, so one Devanagari
 * sentence used for both would make the surface-varies assertion pass for `en` and say nothing about
 * `hi` against `mr`.
 */
const LOCALIZED_LEAD: Record<Language, string> = {
  en: 'Look closely at the lower leaves.',
  hi: 'नीचे की पत्तियों को ध्यान से देखें।',
  mr: 'खालच्या पानांकडे बारकाईने पहा।',
};

/** Questions carrying no verified vocabulary, so `resolveScope()` refers the farmer onward. */
const OUT_OF_SCOPE_QUESTIONS: readonly string[] = [
  'how much water does wheat need in summer',
  'which fertilizer suits sugarcane in this season',
];

/** Subject-less follow-ups: the scope comes from the conversation's own diagnosis (7.3). */
const FOLLOW_UP_QUESTIONS: readonly string[] = ['why?', 'what should I do now'];

/* ========================================================================== */
/* Script class                                                                */
/* ========================================================================== */

/**
 * Requirement 9.3's "its script class matches that language", as the one thing that is decidable
 * about rendered text without a translator: Hindi and Marathi are written in Devanagari and English
 * is not.
 *
 * Deliberately **not** a claim that the whole string is Devanagari. A canonical disease name stays
 * in Latin script in all three languages — that is Requirement 4.6, and Property 13 owns it — so a
 * Hindi answer legitimately mixes scripts. "Contains Devanagari" is the strongest statement that
 * stays true of a correct answer.
 */
function scriptClassHolds(text: string, language: Language): boolean {
  return language === 'en' ? !DEVANAGARI.test(text) : DEVANAGARI.test(text);
}

/* ========================================================================== */
/* The propagation harness — every seam injected                                */
/* ========================================================================== */

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

/** How the answer a farmer reads was produced. All three render text, in three different ways. */
const ANSWER_SOURCES = [
  /** The model's own localized prose, kept. */
  'model_prose',
  /** Nothing in scope, so the repository's own pre-translated copy and no model call (4.7). */
  'referral_copy',
  /** The chain was exhausted, so the knowledge row's own localized template. */
  'row_template',
] as const;
type AnswerSource = (typeof ANSWER_SOURCES)[number];

/** Which coded failure the envelope half renders. Two, so the claim is not one sentence's. */
const ENVELOPE_FAILURES = ['quota_declined', 'conversation_not_owned'] as const;
type EnvelopeFailure = (typeof ENVELOPE_FAILURES)[number];

interface TurnRecorded {
  readonly messageRows: TablesInsert<'messages'>[];
  readonly usageRows: TablesInsert<'usage_logs'>[];
  counts: { generate: number };
}

interface TurnHarness {
  readonly deps: ChatTurnDeps;
  readonly recorded: TurnRecorded;
}

function turnHarness(options: {
  readonly language: Language;
  readonly source: AnswerSource;
  readonly condition: VerifiedCondition;
  /** `false` makes `chatTurn` raise `CONVERSATION_NOT_FOUND` at step 1. */
  readonly owns?: boolean;
  /** `true` makes the counter answer at-limit, so step 3 raises `QUOTA_EXCEEDED`. */
  readonly atLimit?: boolean;
}): TurnHarness {
  const recorded: TurnRecorded = { messageRows: [], usageRows: [], counts: { generate: 0 } };
  const scope = { conversationId: CONVERSATION_ID, userId: USER };

  const store: ContextStore = {
    recentMessages: () => Promise.resolve([]),
    latestDiagnosis: () =>
      Promise.resolve(
        options.source === 'referral_copy' ? null : diagnosisRowFor(scope, options.condition),
      ),
  };

  const knowledge: KnowledgeReader = (names) =>
    Promise.resolve(KNOWLEDGE_ROWS.filter((row) => names.includes(row.disease_name)));

  const models: CapabilityRunner = {
    classify: () => Promise.reject(new Error('a chat turn asked for a vision judgement')),
    generate: () => {
      recorded.counts.generate += 1;
      if (options.source === 'row_template') {
        return Promise.reject(
          new AppError('PROVIDERS_UNAVAILABLE', { context: { reason: 'test_chain_exhausted' } }),
        );
      }
      const entry = entryFor(options.condition);
      return Promise.resolve({
        // The lead-in is this language's, which is what makes three runs three surfaces rather
        // than one string asserted three times.
        value: `${LOCALIZED_LEAD[options.language]} ${entry.disease_name}. ${entry.symptoms[0] ?? ''}`,
        provider: 'gemini' as const,
        usedFallback: false,
      });
    },
  };

  const writes: ChatWriteStore = {
    insertTurn: (rows) => {
      recorded.messageRows.push(...rows);
      const stored: MessageRow[] = rows.map((row, index) => ({
        id: uuidFor('9e55a9e0', recorded.messageRows.length - rows.length + index + 1),
        conversation_id: row.conversation_id,
        user_id: row.user_id,
        role: row.role,
        content: row.content,
        language: row.language,
        channel: row.channel,
        input_kind: row.input_kind ?? 'text',
        transcript_of: row.transcript_of ?? null,
        created_at: '2026-09-16T01:31:00.000Z',
      }));
      return Promise.resolve(stored);
    },
    insertUsageLog: (row) => {
      recorded.usageRows.push(row);
      return Promise.resolve();
    },
    ownsConversation: () => Promise.resolve(options.owns ?? true),
    touchConversation: () => Promise.resolve(true),
  };

  const rpc: CounterRpc = {
    tryIncrement: () => Promise.resolve(options.atLimit === true ? null : 1),
    decrement: () => Promise.resolve(0),
    used: () => Promise.resolve(options.atLimit === true ? 50 : 0),
  };

  return {
    recorded,
    deps: {
      supabase: unreachableSupabase,
      writes,
      store,
      knowledge,
      models,
      quota: { rpc, now: new Date(NOW_MS) },
      now: () => NOW_MS,
      platformDeadline: () => undefined,
    },
  };
}

function diagnosisRowFor(
  scope: { readonly conversationId: string; readonly userId: string },
  condition: VerifiedCondition,
): DiagnosisRow {
  return {
    id: uuidFor('d1a90515', 1),
    user_id: scope.userId,
    conversation_id: scope.conversationId,
    status: 'identified',
    disease_name: condition,
    knowledge_id: entryFor(condition).id,
    confidence: 0.87,
    severity: condition === HEALTHY_CONDITION ? 'none' : 'moderate',
    explanation: `${condition} explanation`,
    language: 'en',
    needs_expert: false,
    channel: 'web',
    image_bucket: STORAGE_BUCKETS.cropImages,
    image_path: `${scope.userId}/2026/09/${uuidFor('0b1ec700', 1)}.jpg`,
    full_image_deleted_at: null,
    model_provider: 'gemini',
    created_at: '2026-09-16T00:30:00.000Z',
  };
}

/* ========================================================================== */
/* Arbitraries — propagation                                                   */
/* ========================================================================== */

const CHANNELS = channelSchema.options;

interface PropagationCase {
  readonly source: AnswerSource;
  readonly condition: VerifiedCondition;
  readonly channel: Channel;
  readonly questionIndex: number;
  /**
   * A profile language that differs from the selection, so "the cookie outranks the profile" is a
   * claim with something to outrank rather than two sources that happen to agree.
   */
  readonly profileOffset: number;
}

const propagationArb: fc.Arbitrary<PropagationCase> = fc.record({
  source: fc.constantFrom<AnswerSource>(...ANSWER_SOURCES),
  condition: fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS),
  channel: fc.constantFrom<Channel>(...CHANNELS),
  questionIndex: fc.integer({ min: 0, max: 1 }),
  profileOffset: fc.integer({ min: 1, max: SUPPORTED_LANGUAGES.length - 1 }),
});

interface EnvelopeCase {
  readonly failure: EnvelopeFailure;
  readonly condition: VerifiedCondition;
  readonly channel: Channel;
}

const envelopeArb: fc.Arbitrary<EnvelopeCase> = fc.record({
  failure: fc.constantFrom<EnvelopeFailure>(...ENVELOPE_FAILURES),
  condition: fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS),
  channel: fc.constantFrom<Channel>(...CHANNELS),
});

function questionFor(source: AnswerSource, index: number): string {
  const pool = source === 'referral_copy' ? OUT_OF_SCOPE_QUESTIONS : FOLLOW_UP_QUESTIONS;
  return pool[index % pool.length] ?? 'why?';
}

function otherLanguage(language: Language, offset: number): Language {
  const at = SUPPORTED_LANGUAGES.indexOf(language);
  const next = SUPPORTED_LANGUAGES[(at + offset) % SUPPORTED_LANGUAGES.length];
  if (next === undefined || next === language) {
    throw new Error('the profile-language fixture collided with the selection');
  }
  return next;
}

/* ========================================================================== */
/* Arbitraries — refusal at the edge                                           */
/* ========================================================================== */

/**
 * The shapes an unsupported language arrives in, enumerated so the run can prove it reached every
 * one. A class that never generated would leave a mis-stated expectation green.
 */
const UNSUPPORTED_SHAPES = [
  /** A real ISO code for a language Jamee does not cover. */
  'other_indian_language',
  /** A real ISO code from outside the region. */
  'other_language',
  /** Present and empty. Distinct from absent, and neither is `en`. */
  'empty_string',
  /** A long run of junk, so the refusal is not a property of short inputs. */
  'garbage',
  /**
   * A well-formed BCP-47 tag whose **primary subtag is supported**. The sharpest case: it looks
   * valid, `Accept-Language` resolution would accept it, and the body contract still refuses it,
   * because the wire contract is the three codes and not a language range.
   */
  'bcp47_supported_primary',
  /** A well-formed BCP-47 tag for a language Jamee does not cover. */
  'bcp47_unsupported',
  /** The right letters, the wrong case. `parseLanguage` is case-sensitive by design. */
  'wrong_case',
] as const;
type UnsupportedShape = (typeof UNSUPPORTED_SHAPES)[number];

const GARBAGE = 'zz'.repeat(64);

function unsupportedValueFor(shape: UnsupportedShape, pick: number): string {
  switch (shape) {
    case 'other_indian_language':
      return (['ta', 'bn', 'te'] as const)[pick % 3] ?? 'ta';
    case 'other_language':
      return (['fr', 'de', 'es'] as const)[pick % 3] ?? 'fr';
    case 'empty_string':
      return '';
    case 'garbage':
      return GARBAGE;
    case 'bcp47_supported_primary':
      return (['hi-IN', 'mr-IN', 'en-IN'] as const)[pick % 3] ?? 'hi-IN';
    case 'bcp47_unsupported':
      return (['ta-IN', 'fr-FR', 'bn-BD'] as const)[pick % 3] ?? 'ta-IN';
    case 'wrong_case':
      return (['EN', 'HI', 'MR'] as const)[pick % 3] ?? 'EN';
  }
}

const ROUTES = ['chat', 'diagnose', 'voice'] as const;
type RouteName = (typeof ROUTES)[number];

const HANDLERS: Record<RouteName, (request: NextRequest) => Promise<Response>> = {
  chat: chatRoute,
  diagnose: diagnoseRoute,
  voice: voiceRoute,
};

/**
 * A body that satisfies its endpoint's contract in every respect except the `language` field, which
 * the caller supplies.
 *
 * `alsoInvalid` breaks a second field as well. That case is not padding: `edgeErrorFor` consults the
 * language branch first, so a body naming both an unsupported language and an over-long recording
 * must still be `LANGUAGE_UNSUPPORTED` — the language is the thing Jamee will not do at all, and an
 * endpoint-specific branch must not shadow it.
 */
function bodyFor(route: RouteName, language: unknown, alsoInvalid: boolean): Record<string, unknown> {
  switch (route) {
    case 'chat':
      return {
        conversationId: CONVERSATION_ID,
        ...(alsoInvalid ? {} : { message: 'why?' }),
        language,
      };
    case 'diagnose':
      return {
        image: {
          bucket: alsoInvalid ? STORAGE_BUCKETS.voiceMessages : STORAGE_BUCKETS.cropImages,
          path: `${USER}/2026/09/${uuidFor('0b1ec700', 2)}.jpg`,
        },
        language,
      };
    case 'voice':
      return {
        audio: {
          bucket: STORAGE_BUCKETS.voiceMessages,
          path: `${USER}/2026/09/${uuidFor('0b1ec700', 3)}.webm`,
        },
        conversationId: CONVERSATION_ID,
        // Past `MAX_AUDIO_SECONDS`, which is `AUDIO_TOO_LONG`'s own `too_big` issue.
        durationSeconds: alsoInvalid ? 9_999 : 12,
        language,
      };
  }
}

interface EdgeCase {
  readonly route: RouteName;
  readonly shape: UnsupportedShape;
  readonly pick: number;
  readonly alsoInvalid: boolean;
  /** `?language=` on the URL, the envelope's first source. */
  readonly languageQuery: Language | null;
  readonly acceptLanguage: string | null;
}

const edgeArb: fc.Arbitrary<EdgeCase> = fc.record({
  route: fc.constantFrom<RouteName>(...ROUTES),
  shape: fc.constantFrom<UnsupportedShape>(...UNSUPPORTED_SHAPES),
  pick: fc.integer({ min: 0, max: 2 }),
  alsoInvalid: fc.boolean(),
  languageQuery: fc.constantFrom<Language | null>(null, ...SUPPORTED_LANGUAGES),
  acceptLanguage: fc.constantFrom(null, 'hi-IN,hi;q=0.9', 'mr,en;q=0.5', 'fr-FR,de;q=0.8'),
});

function requestFor(edge: EdgeCase, body: Record<string, unknown>): NextRequest {
  const url = new URL(`${ORIGIN}/api/${edge.route}`);
  if (edge.languageQuery !== null) url.searchParams.set('language', edge.languageQuery);

  const headers = new Headers({ 'content-type': 'application/json' });
  if (edge.acceptLanguage !== null) headers.set('accept-language', edge.acceptLanguage);

  const request = new Request(url, { method: 'POST', headers, body: JSON.stringify(body) });
  // Every route reads only `url`, `headers` and the body; `route.test.ts` in `src/` casts the same
  // way, for the same reason — a plain `Request` carries everything a handler consults.
  return request as NextRequest;
}

async function envelopeOf(response: Response) {
  return errorEnvelopeSchema.parse(await response.json());
}

/* ========================================================================== */
/* Property 19 — propagation                                                   */
/* ========================================================================== */

describe('Property 19: the selected language propagates to every layer that renders text', () => {
  it('carries the selection into the request, the answer, both persisted rows, and renders a different surface in each language', async () => {
    const sourcesSeen = new Set<AnswerSource>();
    const languagesSeen = new Set<Language>();
    const channelsSeen = new Set<Channel>();
    const conditionsSeen = new Set<VerifiedCondition>();

    await fc.assert(
      fc.asyncProperty(propagationArb, async (test) => {
        sourcesSeen.add(test.source);
        channelsSeen.add(test.channel);
        conditionsSeen.add(test.condition);

        const message = questionFor(test.source, test.questionIndex);

        /* ------------------------------------------------------------------ */
        /* One run per supported language, over the same case                 */
        /* ------------------------------------------------------------------ */

        const runs = await Promise.all(
          SUPPORTED_LANGUAGES.map(async (language) => {
            languagesSeen.add(language);

            /* --- Layer 1: the selection (Requirement 9.2's antecedent) ----- */

            // What the switcher writes, read back the way the next server render reads it. The
            // profile says something else, so a resolver that let the profile win would fail here.
            const cookieValue = languageCookie(language).split(';')[0]?.split('=')[1] ?? '';
            const profileLanguage = otherLanguage(language, test.profileOffset);
            const selected = resolveLanguage(cookieValue, profileLanguage);

            /* --- Layer 2: the request body (Requirement 9.2) --------------- */

            const sent: { readonly url: string; readonly body: unknown }[] = [];
            const recorder: FetchLike = (url, init) => {
              sent.push({ url, body: JSON.parse(String(init.body)) as unknown });
              return Promise.resolve(new Response('{}', { status: 200 }));
            };
            const requests = jameeRequests(selected, recorder);

            await requests.chat({ conversationId: CONVERSATION_ID, message });
            await requests.diagnose({
              image: {
                bucket: STORAGE_BUCKETS.cropImages,
                path: `${USER}/2026/09/${uuidFor('0b1ec700', 4)}.jpg`,
              },
            });
            await requests.voice({
              audio: {
                bucket: STORAGE_BUCKETS.voiceMessages,
                path: `${USER}/2026/09/${uuidFor('0b1ec700', 5)}.webm`,
              },
              conversationId: CONVERSATION_ID,
              durationSeconds: 12,
            });

            /* --- Layers 3 and 4: the answer and the rows ------------------- */

            const harness = turnHarness({
              language: selected,
              source: test.source,
              condition: test.condition,
            });

            const result = await chatTurn(
              {
                userId: USER,
                conversationId: CONVERSATION_ID,
                message,
                language: selected,
                channel: test.channel,
                inputKind: 'text',
              },
              harness.deps,
            );

            return { language, selected, sent, result, recorded: harness.recorded } as const;
          }),
        );

        /* ------------------------------------------------------------------ */
        /* Per-language: the code survived every layer                        */
        /* ------------------------------------------------------------------ */

        for (const run of runs) {
          const label = `${test.source} / ${test.condition} / ${run.language}`;

          /* The selection resolved to the code the farmer chose, not to their profile's. */
          expect(run.selected, label).toBe(run.language);

          /* Requirement 9.2 — every one of the three endpoints, body and query string. Three
             requests were issued and all three carry it; a helper that stamped one and forgot
             another would fail here rather than in whichever screen shipped last. */
          expect(run.sent, label).toHaveLength(3);
          const [chatSent, diagnoseSent, voiceSent] = run.sent;
          if (chatSent === undefined || diagnoseSent === undefined || voiceSent === undefined) {
            throw new Error('a request was not recorded');
          }
          expect(chatRequestSchema.parse(chatSent.body).language, label).toBe(run.language);
          expect(diagnoseRequestSchema.parse(diagnoseSent.body).language, label).toBe(run.language);
          expect(voiceRequestSchema.parse(voiceSent.body).language, label).toBe(run.language);
          for (const sent of run.sent) {
            expect(sent.url, label).toContain(`language=${run.language}`);
          }

          /* Requirement 9.3 — the answer's own field, and its script class. */
          expect(run.result.answer.language, label).toBe(run.language);
          expect(
            scriptClassHolds(run.result.answer.content, run.language),
            `${label}: the answer's script class does not match its language`,
          ).toBe(true);

          /* The persisted rows, read off the insert payloads. D9 has the answer's language follow
             the message rather than the request, which is why the two rows are checked separately
             rather than against one source. */
          expect(run.recorded.messageRows, label).toHaveLength(2);
          const farmer = run.recorded.messageRows.find((row) => row.role === 'farmer');
          const jamee = run.recorded.messageRows.find((row) => row.role === 'jamee');
          if (farmer === undefined || jamee === undefined) {
            throw new Error('the turn did not persist both rows');
          }
          expect(farmer.language, label).toBe(run.language);
          expect(jamee.language, label).toBe(run.result.answer.language);
          expect(jamee.content, label).toBe(run.result.answer.content);

          /* Which branch rendered it, read off the model counter rather than assumed. */
          expect(run.recorded.counts.generate, label).toBe(
            test.source === 'referral_copy' ? 0 : 1,
          );
          if (test.source === 'referral_copy') {
            /* Requirement 4.7's copy ships pre-translated precisely because this path calls no
               model, so the localization cannot come from one. */
            expect(run.result.answer.content, label).toBe(
              catalogFor(run.language).chat.outOfScope,
            );
            expect(run.result.answer.needsExpert, label).toBe(true);
          }
        }

        /* ------------------------------------------------------------------ */
        /* Across the three: the surface actually changed                     */
        /* ------------------------------------------------------------------ */

        const answers = runs.map((run) => run.result.answer.content);
        expect(
          new Set(answers).size,
          `${test.source} / ${test.condition}: the answer did not change with the language`,
        ).toBe(3);

        // And the row a farmer's history will render carries that difference too, rather than the
        // difference living only in the response.
        const persisted = runs.map(
          (run) => run.recorded.messageRows.find((row) => row.role === 'jamee')?.content,
        );
        expect(new Set(persisted).size, `${test.source} / ${test.condition}`).toBe(3);
      }),
      { numRuns: 120 },
    );

    expect([...sourcesSeen].sort()).toStrictEqual([...ANSWER_SOURCES].sort());
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
    expect([...channelsSeen].sort()).toStrictEqual([...CHANNELS].sort());
    expect([...conditionsSeen].sort()).toStrictEqual([...VERIFIED_CONDITIONS].sort());
  });

  it('renders the error envelope of a failed request in the selected language', async () => {
    const failuresSeen = new Set<EnvelopeFailure>();
    const languagesSeen = new Set<Language>();

    await fc.assert(
      fc.asyncProperty(envelopeArb, async (test) => {
        failuresSeen.add(test.failure);

        const runs = await Promise.all(
          SUPPORTED_LANGUAGES.map(async (language) => {
            languagesSeen.add(language);

            const harness = turnHarness({
              language,
              source: 'model_prose',
              condition: test.condition,
              owns: test.failure !== 'conversation_not_owned',
              atLimit: test.failure === 'quota_declined',
            });

            /**
             * The route's own arrangement: the parsed language is in scope of the envelope that
             * renders whatever the service raises. `withErrorHandling` resolves the language before
             * running the handler, which is exactly why the routes nest a second one.
             */
            const response = await withErrorHandling(
              async () => {
                await chatTurn(
                  {
                    userId: USER,
                    conversationId: CONVERSATION_ID,
                    message: 'why?',
                    language,
                    channel: test.channel,
                    inputKind: 'text',
                  },
                  harness.deps,
                );
                throw new Error('the turn was expected to fail and did not');
              },
              () => language,
            );

            return { language, response, envelope: await envelopeOf(response) } as const;
          }),
        );

        for (const run of runs) {
          const label = `${test.failure} / ${run.language}`;

          /* Requirement 15.3's language field, carrying the code the farmer selected. */
          expect(run.envelope.error.language, label).toBe(run.language);
          expect(run.envelope.error.code, label).toBe(
            test.failure === 'quota_declined' ? 'QUOTA_EXCEEDED' : 'CONVERSATION_NOT_FOUND',
          );
          expect(
            scriptClassHolds(run.envelope.error.message, run.language),
            `${label}: the envelope's script class does not match its language`,
          ).toBe(true);
          /* And the sentence is the catalog's, so nothing composed it from a template at runtime. */
          expect(run.envelope.error.message.length, label).toBeGreaterThan(0);
        }

        /* The complement, again: three languages, three sentences. */
        const sentences = runs.map((run) => run.envelope.error.message);
        expect(
          new Set(sentences).size,
          `${test.failure}: the envelope did not change with the language`,
        ).toBe(3);
      }),
      { numRuns: 60 },
    );

    expect([...failuresSeen].sort()).toStrictEqual([...ENVELOPE_FAILURES].sort());
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
  });
});

/* ========================================================================== */
/* Property 19 — refusal at the edge                                           */
/* ========================================================================== */

describe('Property 19: an unsupported language code is refused at the request boundary', () => {
  it('answers 400 LANGUAGE_UNSUPPORTED naming the three codes, opening no door past the parse', async () => {
    const routesSeen = new Set<RouteName>();
    const shapesSeen = new Set<UnsupportedShape>();
    const alsoInvalidSeen = new Set<boolean>();
    const envelopeLanguagesSeen = new Set<Language>();

    await fc.assert(
      fc.asyncProperty(edgeArb, async (edge) => {
        routesSeen.add(edge.route);
        shapesSeen.add(edge.shape);
        alsoInvalidSeen.add(edge.alsoInvalid);

        seams.opened.length = 0;
        seams.currentUserId.mockResolvedValue(USER);

        const value = unsupportedValueFor(edge.shape, edge.pick);
        const body = bodyFor(edge.route, value, edge.alsoInvalid);
        const handler = HANDLERS[edge.route];

        const response = await handler(requestFor(edge, body));
        const envelope = await envelopeOf(response);
        const where = `${edge.route} / ${edge.shape} / ${JSON.stringify(value).slice(0, 24)}`;

        /* Requirement 9.5's status and code, on every endpoint and every shape — including the
           bodies that are also invalid in a second way, where an endpoint-specific branch must
           not shadow the language refusal. */
        expect(response.status, `${where} was not refused with 400`).toBe(400);
        expect(envelope.error.code, `${where} carried the wrong code`).toBe('LANGUAGE_UNSUPPORTED');

        /* "Naming the three supported codes": structured, so a client renders the list without
           parsing prose, and filled from the same array the parse rejected against. */
        expect(envelope.error.details?.supportedLanguages, where).toStrictEqual([
          ...SUPPORTED_LANGUAGES,
        ]);

        /* Not retryable: sending the same unsupported code again fails identically. */
        expect(envelope.error.retryable, where).toBe(false);

        /* The refusal is written in a language Jamee can render — never in the code it just
           refused — and `?language=` is its first source. */
        expect(SUPPORTED_LANGUAGES, where).toContain(envelope.error.language);
        envelopeLanguagesSeen.add(envelope.error.language);
        if (edge.languageQuery !== null) {
          expect(envelope.error.language, where).toBe(edge.languageQuery);
        }

        /* ================================================================== */
        /* "At the edge" — the clause a status cannot see                      */
        /* ================================================================== */

        /**
         * Not one door was opened: no provider runner, neither credential, no burst slot, no storage
         * probe. A code defaulted deeper in would have had to pass at least the request client to get
         * anywhere; a provider call would have had to pass `gatewayRunner`; and a quota spend would
         * have had to pass the service-role credential, which is the only way to the counter.
         */
        expect(seams.opened, `${where} reached past the request boundary`).toStrictEqual([]);
      }),
      { numRuns: 400 },
    );

    expect([...routesSeen].sort()).toStrictEqual([...ROUTES].sort());
    expect([...shapesSeen].sort()).toStrictEqual([...UNSUPPORTED_SHAPES].sort());
    // Both the language-only body and the doubly-invalid one were generated, so the precedence
    // claim is exercised rather than stated.
    expect([...alsoInvalidSeen].sort()).toStrictEqual([false, true]);
    // The refusal was rendered in more than one language, so `envelopeLanguage`'s sources are
    // reached rather than every run falling back to the default.
    expect(envelopeLanguagesSeen.size, 'every refusal fell back to one language').toBeGreaterThan(1);
    expect(envelopeLanguagesSeen, 'the default fallback was never exercised').toContain(
      DEFAULT_LANGUAGE,
    );
  });

  it('does not refuse a supported code, and reaches the first door only after the language is accepted', async () => {
    /**
     * The complement, and the half that pins the *ordering*. A body carrying a supported code and
     * satisfying its contract must get past the language edge — which on these three routes means
     * reaching `createServerSupabase()`, the first statement inside each handler past the parse.
     *
     * That tripwire then throws, so the response is a 500. What matters is the pair: the ledger is
     * non-empty here and empty above, which is what makes "before any provider call or quota spend"
     * a statement about order rather than about presence.
     */
    const routesSeen = new Set<RouteName>();
    const languagesSeen = new Set<Language>();

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          route: fc.constantFrom<RouteName>(...ROUTES),
          language: fc.constantFrom<Language>(...SUPPORTED_LANGUAGES),
        }),
        async ({ route, language }) => {
          routesSeen.add(route);
          languagesSeen.add(language);

          seams.opened.length = 0;
          seams.currentUserId.mockResolvedValue(USER);

          const body = bodyFor(route, language, false);
          const handler = HANDLERS[route];
          const response = await handler(
            requestFor(
              { route, shape: 'other_language', pick: 0, alsoInvalid: false, languageQuery: null, acceptLanguage: null },
              body,
            ),
          );
          const envelope = await envelopeOf(response);
          const where = `${route} / ${language}`;

          /* A supported code is not what this endpoint refuses. */
          expect(envelope.error.code, `${where} was refused as an unsupported language`).not.toBe(
            'LANGUAGE_UNSUPPORTED',
          );
          expect(response.status, where).not.toBe(400);

          /* And it got past the parse: the first door was opened, and it was that one. */
          expect(seams.opened, `${where} never reached the request client`).toStrictEqual([
            'supabase.createServerSupabase',
          ]);
        },
      ),
      { numRuns: 120 },
    );

    expect([...routesSeen].sort()).toStrictEqual([...ROUTES].sort());
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
  });
});
