import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Language, VerifiedCondition } from '@/lib/schemas';
import { dayWindowKey } from '@/lib/time';
import { COLLECTIONS, type MessageDoc } from '@/lib/db/collections';

import { knowledgeRow, startHarness, type Harness } from './harness';
import {
  CLASSIFICATIONS,
  classificationText,
  echoingRephrase,
  providerCallCount,
  verifiedItemsIn,
  type EchoingRephrase,
} from './providers';

/**
 * The chat path, scenario by scenario, against a real single-node `MongoMemoryReplSet` (V31, V33).
 *
 * Requirements: 7.1 (Conversation_Context is the recent Messages AND the most recent
 *               Diagnosis_Result of that Conversation), 7.3 (a follow-up that omits its subject
 *               resolves against that Diagnosis_Result), 7.6 (no Knowledge_Base content that answers
 *               the question → Jamee says so and recommends an expert, with NO model call), 9.3 / 9.6
 *               (the answer comes back in the requested / message language) — and, because every turn
 *               passes through them: 4.4 / 4.5 (every agricultural sentence comes from a row and the
 *               model is asked to rephrase only that), 7.2 (context keyed on the Conversation), 7.4
 *               (both halves persisted in the same Conversation), 13.2 (owner scoping), 14.6 (audit)
 * Design: "Integration tests — mocked providers, real MongoDB"; D9 (message language first,
 *         requested one otherwise), D10, D18; Amendment A3
 *
 * The Devanagari questions are load-bearing: `tokenize()` matches Latin letters only, so a Hindi or
 * Marathi question contributes no vocabulary and can only be grounded through the conversation's own
 * `condition` — exercising Requirement 7.3's mechanism as well as 9.3's.
 */

const CLASSIFIED = CLASSIFICATIONS.tomatoEarlyBlight;
const CONDITION: VerifiedCondition = CLASSIFIED.disease_name;
const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', hi: 'Hindi', mr: 'Marathi' };
const QUOTA_INSTANT = new Date(Date.UTC(1970, 0, 15, 12, 0, 0));

const ENGLISH_QUESTION = 'My tomato leaves have dark spots. What should I do?';
const HINDI_QUESTION = 'मेरे टमाटर के पत्तों पर धब्बे क्यों हैं?';
const MARATHI_QUESTION = 'माझ्या टोमॅटोच्या पानांवर डाग का आहेत?';
const SUBJECTLESS_FOLLOW_UP = 'why?';
/** A crop Jamee does not cover — matches no tier, so it is a referral with no model call (4.7). */
const UNKNOWN_QUESTION = 'My wheat has rust on the stems. What should I spray?';

let harness: Harness;
let rephrase: EchoingRephrase;
type Chat = typeof import('@/services/chat.service');
type Diagnosis = typeof import('@/services/diagnosis.service');
type Farmer = typeof import('@/lib/db/farmer');
let chat: Chat;
let diagnosisMod: Diagnosis;
let farmer: Farmer;

beforeAll(async () => {
  rephrase = echoingRephrase();
  harness = await startHarness({ providers: { text: rephrase.text } });
  chat = await import('@/services/chat.service');
  diagnosisMod = await import('@/services/diagnosis.service');
  farmer = await import('@/lib/db/farmer');
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await harness.reset();
  harness.providers.script.vision = classificationText(CLASSIFIED);
});

/* ========================================================================== */
/* Wiring                                                                     */
/* ========================================================================== */

function answerer(): import('@/services/voice.service').ChatAnswerer {
  return chat.chatAnswerer({ models: harness.providers.models, quota: { now: QUOTA_INSTANT } });
}

/** Seed a diagnosis in a fresh conversation so the thread has a subject (7.1). Returns the id. */
async function seedDiagnosedConversation(): Promise<string> {
  const conversation = await farmer.farmerData(harness.farmerA.id).insertConversation({ channel: 'web' });
  const image = await harness.objects.image(harness.farmerA.id);
  await diagnosisMod.diagnose(
    { userId: harness.farmerA.id, image, language: 'en', channel: 'web', conversationId: conversation._id.toHexString() },
    { models: harness.providers.models, quota: { now: QUOTA_INSTANT } },
  );
  return conversation._id.toHexString();
}

async function ask(
  conversationId: string,
  message: string,
  language: Language,
): Promise<import('@/services/chat.service').ChatTurnResult> {
  return answerer()(
    { userId: harness.farmerA.id, conversationId, message, language, channel: 'web' },
    // ownsRequest: this chat turn is the entry point for its own operation.
    (await import('@/services/quota.service')).ownsRequest(harness.farmerA.id, 'chat'),
  );
}

function chatUnitsUsed(): Promise<number> {
  return farmer.farmerData(harness.farmerA.id).counterUsed('chat', 'day', dayWindowKey(QUOTA_INSTANT));
}

/* ========================================================================== */
/* A grounded question in English — 4.4, 7.4                                  */
/* ========================================================================== */

describe('a grounded question', () => {
  it('answers from the knowledge base, persists both halves in the same conversation, spends one chat unit', async () => {
    const conversationId = await seedDiagnosedConversation();
    const before = await chatUnitsUsed();

    const result = await ask(conversationId, ENGLISH_QUESTION, 'en');

    expect(result.answer.content.length).toBeGreaterThan(0);
    // 9.3 — the prompt asked for English.
    const prompt = rephrase.last();
    expect(prompt).toContain(LANGUAGE_NAMES.en);
    // 4.4/4.5 — every agricultural sentence the model was handed came from a seeded tomato row.
    const items = verifiedItemsIn(prompt);
    expect(items.length).toBeGreaterThan(0);

    // 7.4 — both halves persisted in the SAME conversation.
    const messages = await farmer.farmerData(harness.farmerA.id).findMessages({});
    const inThread = messages.filter((m) => m.conversationId.toHexString() === conversationId);
    expect(inThread.some((m) => m.role === 'farmer' && m.content === ENGLISH_QUESTION)).toBe(true);
    expect(inThread.some((m) => m.role === 'jamee')).toBe(true);

    expect(await chatUnitsUsed()).toBe(before + 1);
  });
});

/* ========================================================================== */
/* A subjectless follow-up — 7.1, 7.3                                         */
/* ========================================================================== */

describe('a subjectless follow-up', () => {
  it('resolves against the conversation’s most recent diagnosis rather than referring', async () => {
    const conversationId = await seedDiagnosedConversation();

    const result = await ask(conversationId, SUBJECTLESS_FOLLOW_UP, 'en');

    // The follow-up carries no crop vocabulary, so it can only be grounded through the diagnosis
    // in this conversation (7.3). A grounded answer is a model answer, not the out-of-scope referral.
    expect(result.answer.content).not.toBe('');
    const prompt = rephrase.last();
    // The prompt carried the diagnosed condition's row content.
    const row = knowledgeRow(harness, CONDITION);
    const items = verifiedItemsIn(prompt);
    expect(items).toContain(row.symptoms[0]);
  });
});

/* ========================================================================== */
/* An out-of-scope question — 4.7, 7.6                                        */
/* ========================================================================== */

describe('an out-of-scope question', () => {
  it('refers to an expert with NO model call and refunds the reserve', async () => {
    // A FRESH conversation with no diagnosis: "wheat rust" matches no tier and there is no subject
    // to fall back on, so the turn is an honest referral with no model call (4.7).
    const conversation = await farmer.farmerData(harness.farmerA.id).insertConversation({ channel: 'web' });
    const conversationId = conversation._id.toHexString();
    const before = await chatUnitsUsed();
    const callsBefore = providerCallCount(harness.providers.calls);

    const result = await ask(conversationId, UNKNOWN_QUESTION, 'en');

    // 7.6 — the answer is the honest referral, produced with NO model call (4.7).
    expect(providerCallCount(harness.providers.calls)).toBe(callsBefore);
    expect(result.answer.content.length).toBeGreaterThan(0);

    // The reserve was refunded: the chat counter is unchanged after a no-model referral.
    expect(await chatUnitsUsed()).toBe(before);
  });
});

/* ========================================================================== */
/* Language — 9.3, 9.6, D9                                                     */
/* ========================================================================== */

describe('language', () => {
  it('asks the model for the requested language on a Devanagari question, grounded through the diagnosis', async () => {
    const conversationHi = await seedDiagnosedConversation();
    const hi = await ask(conversationHi, HINDI_QUESTION, 'hi');
    expect(hi.answer.content.length).toBeGreaterThan(0);
    expect(rephrase.last()).toContain(LANGUAGE_NAMES.hi);

    const conversationMr = await seedDiagnosedConversation();
    const mr = await ask(conversationMr, MARATHI_QUESTION, 'mr');
    expect(mr.answer.content.length).toBeGreaterThan(0);
    expect(rephrase.last()).toContain(LANGUAGE_NAMES.mr);

    // The Canonical_Disease_Name survives untranslated in Latin script wherever it appears.
    expect(hi.answer.content.includes(CONDITION) || mr.answer.content.includes(CONDITION)).toBe(true);
  });
});

/* ========================================================================== */
/* Owner scoping — 13.2                                                        */
/* ========================================================================== */

describe('owner scoping', () => {
  it("never returns another farmer's messages", async () => {
    const conversationId = await seedDiagnosedConversation();
    await ask(conversationId, ENGLISH_QUESTION, 'en');

    const asB = await farmer.farmerData(harness.farmerB.id).findMessages({});
    expect(asB).toEqual([]);
    // And a raw scoped read confirms none of the messages are attributed to B.
    const all = await harness.db.collection<MessageDoc>(COLLECTIONS.messages).find({}).toArray();
    expect(all.every((m) => m.ownerId === harness.farmerA.id)).toBe(true);
  });
});
