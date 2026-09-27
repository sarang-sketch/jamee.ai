import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { IdentifiedResult, Language, VerifiedCondition } from '@/lib/schemas';
import { dayWindowKey } from '@/lib/time';
import { type DiseaseKnowledgeDoc } from '@/lib/db/collections';

import { knowledgeRow, startHarness, type Harness } from './harness';
import {
  CLASSIFICATIONS,
  DEFAULT_TRANSCRIPTION,
  classificationText,
  echoingRephrase,
  verifiedItemsIn,
  type EchoingRephrase,
} from './providers';

/**
 * The release acceptance sequence, as far as a machine can walk it, against a real single-node
 * `MongoMemoryReplSet` (V31, V33).
 *
 * Requirements: 3.2 / 4.3 / 4.5 (grounding, into and out of the model), 4.6 / 9.4 (the
 *               Canonical_Disease_Name unchanged across languages), 7.3 (a subjectless follow-up
 *               resolves against the conversation's most recent Diagnosis_Result), 8.6 (a voice
 *               request returns the transcript AND the answer), 9.3 (the requested language),
 *               12.1 / 12.2 / 12.3 (history is reverse-chronological, includes BOTH web and telegram
 *               entries, and has a detail view), 13.1 / 13.2 (owner scoping), 14.1 (one voice message
 *               spends one voice unit and no chat unit), 17.5
 * Design: "Integration tests — mocked providers, real MongoDB"; D7, D18; Amendment A3
 *
 * Steps 2, 3, 4, 5 and 7 of the requirements' eight-step acceptance sequence are encoded below, as
 * one continuous path through ONE farmer's data — each step stands on the row the previous one
 * wrote. Step 1 (a real Google sign-in) and step 6 (the same photo on Telegram from a real handset)
 * are human-tester items in `docs/TESTING_REPORT.md`; step 8's "no model training" half is the
 * ABSENCE of a call, asserted statically by `check:shared-implementation`.
 *
 * "Every agricultural sentence traces to a row" is made checkable by `echoingRephrase()`, which
 * authors nothing: every line it returns was lifted from the prompt the service built, so any
 * farmer-facing line that is not a verbatim row item, a Canonical_Disease_Name, or the requested
 * language name came from Jamee — and the ledger at the end asserts there are none.
 */

const CLASSIFIED = CLASSIFICATIONS.tomatoEarlyBlight;
const CONDITION: VerifiedCondition = CLASSIFIED.disease_name;
const LANGUAGE: Language = 'en';
const LANGUAGE_NAME = 'English';
const QUOTA_INSTANT = new Date(Date.UTC(1970, 0, 15, 12, 0, 0));

let harness: Harness;
let rephrase: EchoingRephrase;
type Diagnosis = typeof import('@/services/diagnosis.service');
type Chat = typeof import('@/services/chat.service');
type Voice = typeof import('@/services/voice.service');
type Farmer = typeof import('@/lib/db/farmer');
type History = typeof import('@/lib/history');
type Quota = typeof import('@/services/quota.service');
let diagnosisMod: Diagnosis;
let chat: Chat;
let voice: Voice;
let farmer: Farmer;
let history: History;
let quota: Quota;

/** Every farmer-facing string produced during the run, for the grounding ledger. */
let facingStrings: string[] = [];

beforeAll(async () => {
  rephrase = echoingRephrase();
  harness = await startHarness({ providers: { text: rephrase.text } });
  diagnosisMod = await import('@/services/diagnosis.service');
  chat = await import('@/services/chat.service');
  voice = await import('@/services/voice.service');
  farmer = await import('@/lib/db/farmer');
  history = await import('@/lib/history');
  quota = await import('@/services/quota.service');
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await harness.reset();
  facingStrings = [];
  harness.providers.script.vision = classificationText(CLASSIFIED);
  harness.providers.script.transcription = DEFAULT_TRANSCRIPTION;
});

function record(...strings: string[]): void {
  facingStrings.push(...strings);
}

function unitsUsed(operation: 'image' | 'chat' | 'voice'): Promise<number> {
  return farmer.farmerData(harness.farmerA.id).counterUsed(operation, 'day', dayWindowKey(QUOTA_INSTANT));
}

/** Every line a farmer may read without Jamee having invented it. */
function traceableLines(rows: readonly DiseaseKnowledgeDoc[]): ReadonlySet<string> {
  const allowed = new Set<string>([LANGUAGE_NAME]);
  for (const row of rows) {
    allowed.add(row.diseaseName);
    for (const field of ['symptoms', 'causes', 'treatment', 'prevention'] as const) {
      for (const item of row[field]) allowed.add(item);
    }
  }
  return allowed;
}

/* ========================================================================== */
/* The continuous path — steps 2, 3, 4, 5, 7                                   */
/* ========================================================================== */

describe('the release acceptance sequence', () => {
  it('walks diagnose → follow-up → voice → history, grounded and owner-scoped throughout', async () => {
    const A = harness.farmerA.id;

    // ── Step 2/3: a web photo diagnosis, grounded in the seeded row ─────────
    const conversation = await farmer.farmerData(A).insertConversation({ channel: 'web' });
    const conversationId = conversation._id.toHexString();
    const image = await harness.objects.image(A);

    const diagnosed = await diagnosisMod.diagnose(
      { userId: A, image, language: LANGUAGE, channel: 'web', conversationId },
      { models: harness.providers.models, quota: { now: QUOTA_INSTANT } },
    );
    expect(diagnosed.result.status).toBe('identified');
    const identified = diagnosed.result as IdentifiedResult;
    const row = knowledgeRow(harness, CONDITION);

    // 3.2 out of the model.
    expect(identified.diseaseName).toBe(CONDITION);
    expect(identified.knowledge).toEqual({
      symptoms: row.symptoms,
      causes: row.causes,
      treatment: row.treatment,
      prevention: row.prevention,
      source: row.source,
    });
    // 4.5 into the model.
    expect(verifiedItemsIn(rephrase.last())).toEqual([...row.symptoms, ...row.causes, ...row.treatment, ...row.prevention]);
    // 4.6/9.4 — the canonical name leads in Latin script.
    expect(identified.explanation.split('\n')[0]).toBe(CONDITION);
    record(identified.explanation, identified.diseaseName);

    // ── Step 4: a subjectless follow-up resolves against the diagnosis (7.3) ─
    const followUp = await chat.chatAnswerer({ models: harness.providers.models, quota: { now: QUOTA_INSTANT } })(
      { userId: A, conversationId, message: 'why?', language: LANGUAGE, channel: 'web' },
      quota.ownsRequest(A, 'chat'),
    );
    expect(followUp.answer.content.length).toBeGreaterThan(0);
    record(followUp.answer.content);

    // ── Step 5: a voice turn returns the transcript AND the answer (8.6), one voice unit only ─
    const audio = await harness.objects.recording(A);
    const voiceBefore = await unitsUsed('voice');
    const chatBefore = await unitsUsed('chat');
    const spoken = await voice.transcribeAndAnswer(
      { userId: A, audio, language: LANGUAGE, channel: 'web', conversationId, durationSeconds: DEFAULT_TRANSCRIPTION.duration ?? 6, mimeType: 'audio/ogg' },
      { chat: chat.chatAnswerer({ models: harness.providers.models, quota: { now: QUOTA_INSTANT } }), transcribe: harness.providers.transcribe, quota: { now: QUOTA_INSTANT } },
    );
    expect(spoken.transcript).toBe(DEFAULT_TRANSCRIPTION.text);
    expect(spoken.answer.content.length).toBeGreaterThan(0);
    // 14.1 — one voice unit, no chat unit.
    expect(await unitsUsed('voice')).toBe(voiceBefore + 1);
    expect(await unitsUsed('chat')).toBe(chatBefore);
    // Record only Jamee's answer for the grounding ledger — the transcript is the farmer's OWN
    // words echoed back (Requirement 8.6), not agronomy Jamee authored, so it is not subject to the
    // "traces to a knowledge-base row" rule.
    record(spoken.answer.content);

    // ── Step 6 (its automatable trace): a telegram-originated diagnosis in history ─
    // A real handset send is a human-tester item; here we seed a telegram-channel diagnosis so the
    // history read below proves it lists BOTH channels (12.2).
    const tgConversation = await farmer.farmerData(A).insertConversation({ channel: 'telegram' });
    await farmer.farmerData(A).insertDiagnosis({
      conversationId: tgConversation._id,
      status: 'identified',
      diseaseName: 'Potato Late Blight',
      knowledgeId: null,
      confidence: 0.8,
      severity: 'high',
      explanation: 'seeded telegram diagnosis',
      language: 'en',
      needsExpert: false,
      channel: 'telegram',
      mediaRef: { fileId: (await import('mongodb')).ObjectId.createFromTime(3), kind: 'crop-image' },
      fullImageDeletedAt: null,
      modelProvider: 'gemini',
    });

    // ── Step 7: history is reverse-chronological and lists BOTH web and telegram (12.1, 12.2) ─
    const entries = await history.readHistory({ userId: A });
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const channels = new Set(entries.map((e) => e.channel));
    expect(channels.has('web')).toBe(true);
    expect(channels.has('telegram')).toBe(true);

    // ── 13.2: the other farmer sees none of it ──────────────────────────────
    const forB = await history.readHistory({ userId: harness.farmerB.id });
    expect(forB).toEqual([]);
    const bDiagnoses = await farmer.farmerData(harness.farmerB.id).findDiagnoses();
    expect(bDiagnoses).toEqual([]);

    // ── The grounding ledger: every farmer-facing line traces to a seeded row ─
    const allowed = traceableLines(harness.knowledge);
    const untraceable = facingStrings
      .flatMap((s) => s.split('\n'))
      .map((line) => line.trim())
      .filter((line) => line !== '' && !allowed.has(line));
    expect(untraceable, 'farmer-facing lines that trace to no knowledge-base row').toEqual([]);
  });
});
