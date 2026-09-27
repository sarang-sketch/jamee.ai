import * as fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RECHARGE_PRICE_RUPEES } from '@/lib/config/access';
import {
  formatChatReply,
  formatDiagnosisReply,
  formatVoiceReply,
} from '@/lib/channel-reply';
import { interpolate, messages } from '@/lib/messages';
import {
  HEALTHY_CONDITION,
  VERIFIED_CONDITIONS,
  type DiagnosisResult,
  type Language,
  type Severity,
  type VerifiedCondition,
} from '@/lib/schemas';
import type { TelegramDispatch } from '@/lib/telegram';

/**
 * **Property 25: Channel parity of diagnosis content**
 *
 * > For any crop image and any fixed classification outcome, where the submitting farmer is linked
 * > and holds an entitlement whose expiry is in the future, a diagnosis produced through the
 * > Telegram entry point and one produced through the web entry point carry identical status,
 * > disease name, severity, and `needs_expert` values, and are grounded in the same knowledge base
 * > document; explanation wording that differs is parity, not a defect. Where the farmer holds no
 * > unexpired entitlement the claim does not apply: the gate replies and returns before the
 * > diagnosis service runs, so the Telegram side produces no Diagnosis_Result to compare.
 *
 * **Validates: Requirements 10.7, 10.13**
 *
 * **Property 24 (the channel slice carried here): inbound updates route by kind, formatted by the
 * shared `channel-reply.ts` formatters** — a photo → the diagnosis reply, text → the chat reply,
 * voice → the voice reply, each rendered by the SAME formatter the Web_App uses (D7).
 *
 * **Validates: Requirements 10.4, 10.5, 10.6, 10.7, 10.13**
 *
 * =============================================================================
 * A3 RESTATEMENT — PARITY IS NOW A CLAIM ABOUT `src/lib/channel-reply.ts`
 * =============================================================================
 *
 * The Supabase/WhatsApp predecessor drove a signed Meta webhook into the real `diagnose()` and
 * compared its reply to a web `diagnose()` run over the same Supabase seams. Under Amendment A3 the
 * WhatsApp channel is deleted and the messaging channel is Telegram, and D7's parity is restated as
 * a structural fact: **both channels render a service result through the ONE formatter module
 * `src/lib/channel-reply.ts`** (`formatDiagnosisReply` / `formatChatReply` / `formatVoiceReply`),
 * which the Telegram adapter imports. So "the two channels carry identical content" is exactly "the
 * Telegram adapter renders through the same formatter over the same service result", and the way to
 * falsify it is a Telegram reply that differs from `formatDiagnosisReply(result, language)`.
 *
 * This file therefore proves parity two ways, without a Supabase client or a WhatsApp route:
 *
 *  1. **The formatter is a pure function of `(result, language)`** — so the web path and the Telegram
 *     path, both calling it, cannot disagree for the same result. And it adds nothing of its own:
 *     every block of a reply is a catalog string or a service field (the non-vacuity guard the old
 *     file carried, restated over the MongoDB `DiagnosisResult` shape).
 *  2. **The real Telegram entry (`processInboundUpdate`) renders through that formatter** — driven
 *     with an injected `diagnose`/`voice`/chat seam returning a fixed result, the reply the adapter
 *     sends is asserted byte-equal to `formatDiagnosisReply(result, language)` (and the chat/voice
 *     analogues), which is what makes the parity claim a claim about one code path.
 *  3. **The gated farmer produces no Diagnosis_Result to compare** — an unentitled Telegram photo
 *     replies with the gate copy and never reaches the diagnosis formatter (Property 25's "does not
 *     apply" clause, and Property 33's gate).
 *
 * The seams at the service level are in-memory fakes (brief: "otherwise use in-memory fakes at the
 * service seams"); the diagnosis SERVICE'S OWN grounding/parity of fields is Property 10's claim on
 * the real `diagnose`, not re-proved here — this property owns the CHANNEL rendering.
 */

/* ========================================================================== */
/* Module seams: the telegram_inbound DAL + chat/quota (same as the unit test) */
/* ========================================================================== */

const claimInbound = vi.fn(async () => true);
const markProcessed = vi.fn(async () => undefined);
const markUnlinked = vi.fn(async () => undefined);
const markNotEntitled = vi.fn(async () => undefined);
const markRejected = vi.fn(async () => undefined);
const markFailed = vi.fn(async () => undefined);
const resolveSender = vi.fn(async () => null);

vi.mock('@/lib/db/telegram-inbound', () => ({
  claimInbound: (...a: unknown[]) => claimInbound(...(a as [])),
  markProcessed: (...a: unknown[]) => markProcessed(...(a as [])),
  markUnlinked: (...a: unknown[]) => markUnlinked(...(a as [])),
  markNotEntitled: (...a: unknown[]) => markNotEntitled(...(a as [])),
  markRejected: (...a: unknown[]) => markRejected(...(a as [])),
  markFailed: (...a: unknown[]) => markFailed(...(a as [])),
  resolveSender: (...a: unknown[]) => resolveSender(...(a as [])),
}));

/** The text path builds its own chatAnswerer + reads ownsRequest; both are module-mocked. */
const chatAnswer = vi.fn();
vi.mock('@/services/chat.service', () => ({ chatAnswerer: () => chatAnswer }));
vi.mock('@/services/quota.service', () => ({ ownsRequest: (u: string, o: string) => ({ u, o }) }));

const { processInboundUpdate } = await import('@/lib/telegram-dispatch');
type Deps = Parameters<typeof processInboundUpdate>[1];

/* ========================================================================== */
/* Generators — the diagnosis outcome shapes                                   */
/* ========================================================================== */

const LANGUAGES: readonly Language[] = ['en', 'hi', 'mr'];
const REPORTABLE: readonly Exclude<Severity, 'none'>[] = ['low', 'moderate', 'high'];

interface Shape {
  readonly identified: boolean;
  readonly condition: VerifiedCondition;
  readonly severity: Exclude<Severity, 'none'>;
  readonly language: Language;
}

/** Build the `DiagnosisResult` a fixed classification outcome would produce. */
function resultFor(shape: Shape): DiagnosisResult {
  const { identified, condition, severity, language } = shape;
  if (!identified) {
    return {
      status: 'unknown',
      diseaseName: null,
      confidence: null,
      severity: 'none',
      explanation: `An inconclusive explanation in ${language}.`,
      knowledge: null,
      needsExpert: true,
      language,
    };
  }
  const healthy = condition === HEALTHY_CONDITION;
  return {
    status: 'identified',
    diseaseName: condition,
    confidence: 0.82,
    severity: healthy ? 'none' : severity,
    explanation: `A grounded explanation for ${condition} in ${language}.`,
    knowledge: {
      symptoms: [`${condition} symptom`],
      causes: [`${condition} cause`],
      treatment: healthy ? [] : [`${condition} treatment`],
      prevention: [`${condition} prevention`],
      source: `${condition} bulletin`,
    },
    needsExpert: false,
    language,
  };
}

const shapeArb: fc.Arbitrary<Shape> = fc.record({
  identified: fc.boolean(),
  condition: fc.constantFrom<VerifiedCondition>(...VERIFIED_CONDITIONS),
  severity: fc.constantFrom<Exclude<Severity, 'none'>>(...REPORTABLE),
  language: fc.constantFrom<Language>(...LANGUAGES),
});

/* ========================================================================== */
/* Telegram entry driver                                                       */
/* ========================================================================== */

const CHAT_ID = 808;
const OWNER = 'entitled-farmer';

function dispatchFor(kind: 'photo' | 'text' | 'voice'): TelegramDispatch {
  return {
    updateId: 1,
    telegramUserId: 55,
    chatId: CHAT_ID,
    kind,
    textBody: kind === 'text' ? 'why are my leaves spotted' : null,
    fileId: kind === 'photo' || kind === 'voice' ? 'file-1' : null,
    voiceMimeType: kind === 'voice' ? 'audio/ogg' : null,
    startPayload: null,
  };
}

/** Deps for an ENTITLED farmer: the service seams return fixed outcomes; `send` records the reply. */
function entitledDeps(
  language: Language,
  result: DiagnosisResult,
  transcript: string,
  chatContent: string,
): { deps: Deps; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }));

  chatAnswer.mockResolvedValue({
    answer: { content: chatContent },
    conversationId: 'c1',
    farmerMessageId: 'm1',
    quota: {},
  });

  const deps: Deps = {
    resolveProfile: async () => ({ userId: OWNER, language }),
    isEntitled: async () => true,
    conversations: {
      mostRecent: async () => ({ id: 'c1', user_id: OWNER, channel: 'telegram', title: null, created_at: '2026-09-27T00:00:00.000Z', updated_at: '2026-09-27T00:00:00.000Z' }),
      create: async () => ({ id: 'c1', user_id: OWNER, channel: 'telegram', title: null, created_at: '2026-09-27T00:00:00.000Z', updated_at: '2026-09-27T00:00:00.000Z' }),
    } as never,
    download: (async () => ({ bytes: new Uint8Array([1, 2, 3]), size: 3, mimeType: 'image/jpeg' })) as never,
    media: (async () => ({ fileId: { toHexString: () => 'a'.repeat(24) }, kind: 'crop-image' })) as never,
    diagnose: (async () => ({
      result,
      conversationId: 'c1',
      quota: {},
      diagnosisId: 'd1',
      provider: 'gemini',
      usedFallback: false,
    })) as never,
    voice: (async () => ({
      transcript,
      answer: { content: chatContent },
      conversationId: 'c1',
      quota: {},
      farmerMessageId: 'm1',
      provider: 'groq',
      usedFallback: false,
      audio: {},
    })) as never,
    send,
    now: () => Date.parse('2026-09-27T00:00:00.000Z'),
    platformDeadline: () => undefined,
  };
  return { deps, send };
}

beforeEach(() => {
  vi.clearAllMocks();
  claimInbound.mockResolvedValue(true);
});

/* ========================================================================== */
/* Property 25 — the formatter is the parity                                   */
/* ========================================================================== */

describe('Property 25: channel parity of diagnosis content', () => {
  it('the diagnosis reply is a pure function of (result, language): both channels render identically', () => {
    fc.assert(
      fc.property(shapeArb, (shape) => {
        const result = resultFor(shape);
        // Two independent calls — standing in for the two channels, which both call this one
        // function over the same service result — must be byte-identical.
        const a = formatDiagnosisReply(result, shape.language);
        const b = formatDiagnosisReply(result, shape.language);
        expect(a).toBe(b);

        // Field-level parity, stated explicitly: the reply carries the canonical name, the severity
        // label from the shared catalog, and the explanation verbatim for an identified result; the
        // inconclusive label and expert banner otherwise.
        const catalog = messages(shape.language);
        if (result.status === 'identified') {
          expect(a).toContain(result.diseaseName);
          expect(a).toContain(catalog.ui.severityLabel);
          expect(a).toContain(catalog.severity[result.severity]);
        } else {
          expect(a).toContain(catalog.ui.inconclusiveLabel);
          expect(a).toContain(catalog.ui.needsExpertBanner);
        }
        expect(a).toContain(result.explanation);
      }),
      { numRuns: 200 },
    );
  });

  it('the formatter adds nothing of its own: every block is a catalog string or a service field', () => {
    fc.assert(
      fc.property(shapeArb, (shape) => {
        const result = resultFor(shape);
        const body = formatDiagnosisReply(result, shape.language);
        const catalog = messages(shape.language);
        const permitted = new Set<string>([
          result.explanation,
          catalog.ui.severityLabel,
          catalog.ui.inconclusiveLabel,
          catalog.ui.needsExpertBanner,
          ...Object.values(catalog.severity),
          ...VERIFIED_CONDITIONS,
        ]);
        for (const block of body.split('\n\n')) {
          for (const piece of block.split(': ')) {
            expect(permitted.has(piece.trim()), `unexpected reply content: "${piece}"`).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('the entitled Telegram photo path renders through the shared formatter, byte for byte', async () => {
    const seen = new Set<string>();
    await fc.assert(
      fc.asyncProperty(shapeArb, async (shape) => {
        const result = resultFor(shape);
        seen.add(result.status);
        const { deps, send } = entitledDeps(shape.language, result, 'transcript', 'chat answer');
        const outcome = await processInboundUpdate(dispatchFor('photo'), deps);

        expect(outcome.disposition).toBe('processed');
        expect(send).toHaveBeenCalledTimes(1);
        const [chatId, text] = send.mock.calls[0] as unknown as [number, string];
        expect(chatId).toBe(CHAT_ID);
        // The Telegram reply IS the shared formatter's output over the service result — the parity.
        expect(text).toBe(formatDiagnosisReply(result, shape.language));
      }),
      { numRuns: 150 },
    );
    // Non-vacuity: both an identified and an inconclusive result were rendered.
    expect([...seen].sort()).toStrictEqual(['identified', 'unknown']);
  });

  it('a gated (unentitled) Telegram photo produces the gate reply, never a Diagnosis_Result', async () => {
    const send = vi.fn(async () => ({ ok: true as const, sentMessageId: 1 }));
    const diagnoseTripwire = vi.fn(() => {
      throw new Error('tripwire: diagnose ran for a gated farmer');
    });
    const deps: Deps = {
      resolveProfile: async () => ({ userId: OWNER, language: 'hi' }),
      isEntitled: async () => false,
      diagnose: diagnoseTripwire as never,
      send,
      now: () => Date.parse('2026-09-27T00:00:00.000Z'),
      platformDeadline: () => undefined,
    };
    const outcome = await processInboundUpdate(dispatchFor('photo'), deps);
    expect(outcome.disposition).toBe('not_entitled');
    expect(diagnoseTripwire).not.toHaveBeenCalled();
    const [, text] = send.mock.calls[0] as unknown as [number, string];
    expect(text).toBe(interpolate(messages('hi').telegram.gated, { price: RECHARGE_PRICE_RUPEES }));
  });
});

/* ========================================================================== */
/* Property 24 — routing by kind, each through its shared formatter            */
/* ========================================================================== */

describe('Property 24 (channel slice): each kind renders through its shared formatter', () => {
  it('text → formatChatReply, voice → formatVoiceReply, over the same service outputs', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<Language>(...LANGUAGES), async (language) => {
        const result = resultFor({ identified: true, condition: 'Tomato Late Blight', severity: 'high', language });
        const transcript = `spoken question in ${language}`;
        const chatContent = `a grounded chat answer in ${language}`;

        // ── text ──
        {
          const { deps, send } = entitledDeps(language, result, transcript, chatContent);
          const outcome = await processInboundUpdate(dispatchFor('text'), deps);
          expect(outcome.disposition).toBe('processed');
          const [, text] = send.mock.calls[0] as unknown as [number, string];
          expect(text).toBe(formatChatReply(chatContent));
        }

        // ── voice ──
        {
          const { deps, send } = entitledDeps(language, result, transcript, chatContent);
          const outcome = await processInboundUpdate(dispatchFor('voice'), deps);
          expect(outcome.disposition).toBe('processed');
          const [, text] = send.mock.calls[0] as unknown as [number, string];
          expect(text).toBe(formatVoiceReply(transcript, chatContent, language));
        }
      }),
      { numRuns: 30 },
    );
  });
});


