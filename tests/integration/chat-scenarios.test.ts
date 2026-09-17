import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { knowledgeReaderFrom, matchConditions, resolveScope } from '@/lib/knowledge';
import { messages } from '@/lib/messages';
import { VERIFIED_CONDITIONS, type Language, type VerifiedCondition } from '@/lib/schemas';
import { dayWindowKey } from '@/lib/time';
import {
  chatTurn,
  chatWriteStoreFrom,
  type ChatTurnDeps,
  type ChatTurnResult,
} from '@/services/chat.service';
import { diagnose, diagnosisStoreFrom } from '@/services/diagnosis.service';
import type { CounterRpc } from '@/services/quota.service';
import type { DiseaseKnowledgeRow, UsageLogRow } from '@/types/database';

import { anonClient } from './clients';
import { TEST_DATABASE_URL_VAR, describeIntegration } from './database';
import { knowledgeRow, startHarness, type Harness } from './harness';
import { uploadedImage } from './objects';
import {
  CLASSIFICATIONS,
  classificationText,
  echoingRephrase,
  providerCallCount,
  verifiedItemsIn,
  type EchoingRephrase,
} from './providers';

/**
 * The chat path, scenario by scenario, against a real database.
 *
 * Requirements: 7.1 (Conversation_Context is built from the recent Messages **and** the most recent
 *               Diagnosis_Result of that Conversation), 7.3 (a follow-up that omits its subject
 *               resolves against that Diagnosis_Result), 7.6 (no Knowledge_Base content that answers
 *               the question → Jamee says so and recommends an expert), 9.3 (the answer comes back in
 *               the requested language), 9.6 (a question written in a Supported_Language is answered
 *               in the language of the message) — and, because every turn passes through them: 4.4 /
 *               4.5 (every agricultural sentence comes from a row, and the model is asked to rephrase
 *               only that), 4.7 (an out-of-scope question is referred with **no** model call), 7.2
 *               (context keyed on the Conversation identifier), 7.4 (both halves of the turn are
 *               persisted in the same Conversation), 13.2 (RLS), 14.6 (the audit row), 17.5
 * Design: "Integration tests — mocked providers, real Postgres"; D9 (the message's language first,
 *         the requested one otherwise), D10 (`usage_logs` is audit, not the quota source of truth)
 *
 * =============================================================================
 * WHAT MAKES THESE SCENARIOS AND NOT UNIT TESTS
 * =============================================================================
 *
 *  - **Requirement 7.1 is two real reads of two real tables.** `src/services/chat.service.test.ts`
 *    stubs `ContextStore` with arrays, so what it establishes is that the module uses whatever it is
 *    handed. Whether the *queries* find the conversation's newest diagnosis and its recent messages —
 *    the ordering, the tie-break, the `user_id` anchor, and RLS underneath all three — is only
 *    answerable against Postgres. Here the diagnosis is written by `diagnose()` and the messages by
 *    an earlier turn in the same file, so the context is assembled from rows the suite did not insert
 *    by hand.
 *  - **Requirement 7.3's subject comes from a nullable column.** `diagnoses.disease_name` is `null`
 *    on the inconclusive branch by check constraint, so "the most recent Diagnosis_Result" is a
 *    database fact rather than a fixture's field.
 *  - **Requirement 7.4's two rows share one `created_at`.** They are written by one statement inside
 *    one transaction, which is why the assertions below match on `role` rather than on position — a
 *    detail no in-memory store reproduces.
 *  - **The referral refund is `counter_decrement` from `0007`.** An out-of-scope question reserves
 *    and then gives the unit back; only the real counter can show `quota_spent = false` alongside an
 *    unchanged count.
 *
 * =============================================================================
 * THE LANGUAGE SCENARIOS, AND THE ONE THING THEY CANNOT ASSERT
 * =============================================================================
 *
 * The stub cannot translate — no fixture can, without a translation engine or hand-written agronomy
 * in three languages, and hand-written agronomy is the thing Requirement 4.3 forbids. What it *can*
 * do is echo back the language the prompt asked for, which makes the checkable half of Requirements
 * 9.3 and 9.6 observable: the request named the right language, it also carried D9's
 * message-language-first rule, the three answers differ, and the Canonical_Disease_Name survives all
 * three verbatim in Latin script. That the returned prose is genuinely fluent Hindi or Marathi is a
 * **provider-quality** question and stays a human-tester item in `docs/TESTING_REPORT.md`.
 *
 * The Devanagari questions are load-bearing rather than decorative. `tokenize()` matches Latin
 * letters only, so a Hindi or Marathi question contributes **no** vocabulary and can only be grounded
 * through `ConversationContext.condition` — which means these two scenarios exercise Requirement
 * 7.3's mechanism as well as 9.3's, and a regression in the context read would surface here as a
 * referral rather than as a wrong language.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const CLASSIFIED = CLASSIFICATIONS.tomatoEarlyBlight;
const CONDITION: VerifiedCondition = CLASSIFIED.disease_name;

/** The language names the prompts spell, so an assertion can read a prompt back. */
const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', hi: 'Hindi', mr: 'Marathi' };

/** D9's first half, which every prompt states identically whatever language was requested. */
const MESSAGE_LANGUAGE_RULE = "Reply in the language of the farmer's message when it is";

/**
 * An English question that carries its own vocabulary.
 *
 * `matchConditions()` resolves it on tier 2 — `tomato` matches the crop word and no qualifier pair
 * is complete — so it grounds in all three tomato rows. That matters for Requirement 4.4: the prompt
 * has to carry every resolved row, not just the conversation's own condition.
 */
const ENGLISH_QUESTION = 'My tomato leaves have dark spots. What should I do?';

/** "Why are there spots on my tomato leaves?" — no Latin letters, so no vocabulary of its own. */
const HINDI_QUESTION = 'मेरे टमाटर के पत्तों पर धब्बे क्यों हैं?';

/** "Why are there spots on my tomato leaves?" in Marathi. Also contributes no vocabulary. */
const MARATHI_QUESTION = 'माझ्या टोमॅटोच्या पानांवर डाग का आहेत?';

/** Requirement 7.3's own example. Contributes nothing, so only the diagnosis can supply a subject. */
const SUBJECTLESS_FOLLOW_UP = 'why?';

/** A crop Jamee does not cover. Matches no tier, which is what makes it a referral (4.7). */
const UNKNOWN_QUESTION = 'My wheat has rust on the stems. What should I spray?';

/**
 * The quota window every reserve in this file lands in. Pinned and in the past, for the reason
 * `QuotaOptions.now` exists — a window key is a wall-clock fact in Asia/Kolkata, and an assertion
 * that read `dayWindowKey()` at its own moment could straddle a Kolkata midnight and read a fresh
 * row. This file makes seven chat reserves against a limit of fifty.
 */
const QUOTA_INSTANT = new Date(Date.UTC(1970, 0, 15, 12, 0, 0));

describeIntegration(`chat scenarios (requires ${TEST_DATABASE_URL_VAR})`, () => {
  let harness: Harness;
  let rpc: CounterRpc;
  let rephrase: EchoingRephrase;
  let row: DiseaseKnowledgeRow;
  /** The conversation the opening diagnosis created. Every grounded scenario below runs in it. */
  let conversationId: string;
  /** A second conversation with no diagnosis at all — the referral scenarios need one. */
  let emptyConversationId: string;
  /** The answers, per language, for the "three differ, one name survives" assertion. */
  const answers = new Map<Language, string>();

  beforeAll(async () => {
    rephrase = echoingRephrase();
    harness = await startHarness({
      providers: { vision: classificationText(CLASSIFIED), text: rephrase.text },
    });
    if (harness.quota.rpc === undefined) {
      throw new Error('the harness did not bind a counter RPC, so no spend claim is checkable');
    }
    rpc = harness.quota.rpc;
    row = knowledgeRow(harness, CONDITION);

    /**
     * The Diagnosis_Result every follow-up below resolves against, produced by the real service
     * rather than by `seedDiagnosis()`.
     *
     * Deliberately: `harness.ts` says that helper exists for assertions needing a row to *exist*,
     * and Requirement 7.1 is about the conversation's most recent diagnosis as the diagnosis path
     * actually writes it — the `conversation_id` it chose, the `disease_name` it verified, the
     * `created_at` the newest-first read orders on.
     */
    const diagnosed = await diagnose(
      {
        userId: harness.farmerA.id,
        storageRef: uploadedImage(harness.objects, harness.farmerA.id),
        language: 'en',
        channel: 'web',
      },
      {
        supabase: harness.farmerA.client,
        storage: harness.objects,
        store: diagnosisStoreFrom(harness.farmerA.client, harness.admin),
        knowledge: knowledgeReaderFrom(harness.farmerA.client),
        models: harness.providers.models,
        quota: { rpc, now: QUOTA_INSTANT },
      },
    );
    if (diagnosed.result.status !== 'identified') {
      throw new Error(
        `the opening diagnosis was ${diagnosed.result.status}, so no follow-up in this file has a ` +
          'subject to resolve against. Fix that first — every failure here is a consequence of it.',
      );
    }
    conversationId = diagnosed.conversationId;

    // A second thread on the same channel, so the referral scenarios have a conversation whose
    // `latestDiagnosis` is genuinely `null` rather than one this file emptied.
    const empty = await harness.admin
      .from('conversations')
      .insert({ user_id: harness.farmerA.id, channel: 'web' })
      .select('id')
      .single();
    if (empty.error !== null || empty.data === null) {
      throw new Error(`could not create the diagnosis-free conversation: ${empty.error?.message}`);
    }
    emptyConversationId = empty.data.id;
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  /* ====================================================================== */
  /* Wiring and shared assertions                                           */
  /* ====================================================================== */

  /**
   * The web channel's dependencies: farmer A's own RLS-scoped session for both reads and the message
   * writes, and the service role for the append-only audit row that migration `0006` grants
   * `authenticated` no insert policy for.
   *
   * `knowledge` is overridable because one scenario needs a reader that cannot see the base — see
   * the Requirement 7.6 test for why that is the only honest way to reach its branch.
   */
  function webDeps(overrides: Partial<ChatTurnDeps> = {}): ChatTurnDeps {
    return {
      supabase: harness.farmerA.client,
      writes: chatWriteStoreFrom(harness.farmerA.client, harness.admin),
      knowledge: knowledgeReaderFrom(harness.farmerA.client),
      models: harness.providers.models,
      quota: { rpc, now: QUOTA_INSTANT },
      ...overrides,
    };
  }

  function ask(
    message: string,
    language: Language,
    options: { readonly conversationId?: string; readonly deps?: Partial<ChatTurnDeps> } = {},
  ): Promise<ChatTurnResult> {
    return chatTurn(
      {
        userId: harness.farmerA.id,
        conversationId: options.conversationId ?? conversationId,
        message,
        language,
        channel: 'web',
        inputKind: 'text',
      },
      webDeps(options.deps ?? {}),
    );
  }

  /** Farmer A's chat counter in the pinned window — the source of truth for what was spent (D10). */
  function chatUnitsUsed(): Promise<number> {
    return rpc.used({
      userId: harness.farmerA.id,
      operation: 'chat',
      windowKind: 'day',
      windowKey: dayWindowKey(QUOTA_INSTANT),
    });
  }

  /** The `chat` audit rows for one conversation, read with the farmer's own session. */
  async function chatAuditFor(conversation: string): Promise<readonly UsageLogRow[]> {
    const { data, error } = await harness.farmerA.client
      .from('usage_logs')
      .select('*')
      .eq('conversation_id', conversation)
      .eq('operation', 'chat');

    expect(error).toBeNull();
    return data ?? [];
  }

  /** Every line a farmer may read without Jamee having invented it (Requirement 4.4). */
  function traceableLines(
    rows: readonly DiseaseKnowledgeRow[],
    language: Language,
  ): ReadonlySet<string> {
    const allowed = new Set<string>([LANGUAGE_NAMES[language]]);
    for (const entry of rows) {
      allowed.add(entry.disease_name);
      for (const field of ['symptoms', 'causes', 'treatment', 'prevention'] as const) {
        for (const item of entry[field]) allowed.add(item);
      }
    }
    return allowed;
  }

  function untraceableLines(
    text: string,
    rows: readonly DiseaseKnowledgeRow[],
    language: Language,
  ): string[] {
    const allowed = traceableLines(rows, language);
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !allowed.has(line));
  }

  /** The rows a turn said it was grounded in, in the order the answer reported them. */
  function groundingRowsOf(turn: ChatTurnResult): readonly DiseaseKnowledgeRow[] {
    return turn.answer.groundedIn.map((condition) => knowledgeRow(harness, condition));
  }

  /** Every item of every row a prompt should have carried, in `verifiedContentBlock`'s order. */
  function expectedPromptItems(rows: readonly DiseaseKnowledgeRow[]): string[] {
    return rows.flatMap((entry) => [
      ...entry.symptoms,
      ...entry.causes,
      ...entry.treatment,
      ...entry.prevention,
    ]);
  }

  /**
   * The assertions every grounded turn shares: the prompt carried the resolved rows and the
   * requested language, the answer is grounded in those rows and nothing else, the canonical name
   * leads in Latin script, and both halves of the turn are rows in the same conversation.
   */
  async function expectGroundedTurn(
    turn: ChatTurnResult,
    language: Language,
    expected: {
      readonly conditions: readonly VerifiedCondition[];
      readonly question: string;
      readonly conversationId: string;
    },
  ): Promise<void> {
    expect(turn.conversationId).toBe(expected.conversationId);
    expect(turn.answer.groundedIn).toEqual(expected.conditions);
    expect(turn.answer.needsExpert).toBe(false);
    expect(turn.answer.language).toBe(language);
    expect(turn.answer.content.trim()).not.toBe('');

    const prompt = rephrase.last();
    // Requirement 4.5, into the model: every resolved row's four arrays, in order, and nothing else
    // agronomic.
    expect(verifiedItemsIn(prompt)).toEqual(expectedPromptItems(groundingRowsOf(turn)));
    expect(prompt).toContain(`QUESTION: ${expected.question}`);
    // Requirement 9.3 — the request asked for this language by name.
    expect(prompt).toContain(`otherwise reply in ${LANGUAGE_NAMES[language]}`);
    // Requirement 9.6 — and it asked for the *message's* language first. D9's pair, in one prompt.
    expect(prompt).toContain(MESSAGE_LANGUAGE_RULE);

    // Requirement 4.4, out of the model: nothing a farmer reads traces outside the resolved rows.
    expect(
      untraceableLines(turn.answer.content, groundingRowsOf(turn), language),
      'answer lines that trace to no knowledge-base row',
    ).toEqual([]);

    // Requirement 7.4 — one farmer message and one Jamee answer, in this conversation.
    const both = await harness.farmerA.client
      .from('messages')
      .select('id, role, content, conversation_id, input_kind')
      .in('id', [turn.farmerMessageId, turn.answer.messageId]);
    expect(both.error).toBeNull();
    const rows = both.data ?? [];
    expect(rows).toHaveLength(2);
    for (const message of rows) expect(message.conversation_id).toBe(expected.conversationId);
    // Matched by role rather than by position, for the reason `persistTurn` gives: both rows are
    // written by one statement inside one transaction, so they carry the same `created_at` and no
    // ordering clause can separate them.
    expect(rows.find((message) => message.role === 'farmer')?.content).toBe(expected.question);
    expect(rows.find((message) => message.role === 'jamee')?.content).toBe(turn.answer.content);

    await expectMessageVisibleToOwnerOnly(turn.farmerMessageId);
  }

  /** Requirements 13.1 / 13.2 — the owner reads the row and the other farmer reads nothing. */
  async function expectMessageVisibleToOwnerOnly(id: string): Promise<void> {
    const mine = await harness.farmerA.client.from('messages').select('id').eq('id', id);
    const theirs = await harness.farmerB.client.from('messages').select('id').eq('id', id);
    const serviceRole = await harness.admin.from('messages').select('id').eq('id', id);

    expect(mine.error).toBeNull();
    expect(mine.data).toHaveLength(1);
    expect(theirs.error).toBeNull();
    expect(theirs.data).toEqual([]);
    expect(serviceRole.data).toHaveLength(1);
  }

  /* ====================================================================== */
  /* English — Requirements 7.1, 9.3, 9.6                                    */
  /* ====================================================================== */

  describe('an English question in a conversation that already has a diagnosis', () => {
    it('grounds in every tomato row the question resolves to and answers in English', async () => {
      const unitsBefore = await chatUnitsUsed();
      const callsBefore = providerCallCount(harness.providers.calls);

      // The vocabulary tier this question lands on, asserted directly so the expectation below is a
      // consequence of the matcher rather than a list this file guessed.
      expect(matchConditions(ENGLISH_QUESTION)).toEqual([
        'Tomato Early Blight',
        'Tomato Late Blight',
        'Tomato Healthy',
      ]);

      const turn = await ask(ENGLISH_QUESTION, 'en');

      await expectGroundedTurn(turn, 'en', {
        // Canonical order, which `resolveScope` imposes so two runs produce byte-identical prompts.
        conditions: ['Tomato Early Blight', 'Tomato Late Blight', 'Tomato Healthy'],
        question: ENGLISH_QUESTION,
        conversationId,
      });

      // Requirement 7.1's second half, read off the prompt: the conversation's most recent
      // Diagnosis_Result reached the model as the current subject, even though this question named
      // its own.
      expect(rephrase.last()).toContain(`CURRENT DIAGNOSIS: ${CONDITION}`);

      // One round trip. `validateRephrased`'s repairs all happen in process, so a chat turn never
      // re-asks a model (D4's no-repair-re-ask rule).
      expect(providerCallCount(harness.providers.calls)).toBe(callsBefore + 1);
      expect(await chatUnitsUsed()).toBe(unitsBefore + 1);
      expect(turn.quota.operation).toBe('chat');

      answers.set('en', turn.answer.content);
    });

    it('carries the earlier turn forward as recent messages (Requirement 7.1)', async () => {
      const earlier = answers.get('en');
      expect(earlier).toBeDefined();

      // The transcript this turn should see: everything already in the conversation, and nothing from
      // the farmer's other thread. Counted before the turn, because the turn adds two rows of its own.
      const before = await harness.farmerA.client
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId);
      expect(before.error).toBeNull();
      const turnsBefore = (before.data ?? []).length;
      expect(turnsBefore).toBeGreaterThan(0);

      const turn = await ask('And how do I stop it spreading?', 'en');
      const prompt = rephrase.last();

      // The transcript block exists and holds the previous turn — both halves of it. This is the
      // half of Requirement 7.1 that a stubbed context store cannot establish: these lines came
      // from a `messages` read of rows an earlier turn committed.
      expect(prompt).toContain('RECENT MESSAGES:');
      expect(prompt).toContain(`  farmer: ${ENGLISH_QUESTION}`);
      expect(prompt).toContain('  jamee: ');

      /**
       * Requirement 7.2 — the window is keyed on the Conversation identifier, so it holds exactly the
       * turns of *this* conversation and nothing from the farmer's other thread. Counted rather than
       * spot-checked: a context read anchored on `user_id` alone would pass a `toContain` check and
       * fail this one.
       */
      const transcriptTurns = (prompt.match(/^ {2}(farmer|jamee): /gm) ?? []).length;
      expect(transcriptTurns).toBe(turnsBefore);
      // The question itself is NOT in the window: task 15.3 persists the farmer message after the
      // answer exists, so the newest turn reaches the model once, as `QUESTION:`, and not twice.
      expect(prompt).toContain('QUESTION: And how do I stop it spreading?');

      expect(turn.answer.groundedIn.length).toBeGreaterThan(0);
      expect(
        untraceableLines(turn.answer.content, groundingRowsOf(turn), 'en'),
        'answer lines that trace to no knowledge-base row',
      ).toEqual([]);
    });
  });

  /* ====================================================================== */
  /* Hindi and Marathi — Requirements 9.3, 9.6, and 7.3's mechanism           */
  /* ====================================================================== */

  describe('a question written in Devanagari', () => {
    it('answers a Hindi question in Hindi, grounded through the conversation diagnosis', async () => {
      // The load-bearing fact: this question contributes no vocabulary at all, so the only possible
      // subject is `ConversationContext.condition`.
      expect(matchConditions(HINDI_QUESTION)).toEqual([]);

      const turn = await ask(HINDI_QUESTION, 'hi');

      await expectGroundedTurn(turn, 'hi', {
        conditions: [CONDITION],
        question: HINDI_QUESTION,
        conversationId,
      });
      expect(rephrase.last()).toContain(`CURRENT DIAGNOSIS: ${CONDITION}`);
      // Requirements 4.6 / 9.4 — the Canonical_Disease_Name is Latin script and byte-identical
      // whatever the language. `split('\n')[0]` rather than `includes()`, so a transliteration
      // sitting alongside the real name could not satisfy it.
      expect(turn.answer.content.split('\n')[0]).toBe(CONDITION);

      answers.set('hi', turn.answer.content);
    });

    it('answers a Marathi question in Marathi, with the same canonical name', async () => {
      expect(matchConditions(MARATHI_QUESTION)).toEqual([]);

      const turn = await ask(MARATHI_QUESTION, 'mr');

      await expectGroundedTurn(turn, 'mr', {
        conditions: [CONDITION],
        question: MARATHI_QUESTION,
        conversationId,
      });
      expect(turn.answer.content.split('\n')[0]).toBe(CONDITION);

      answers.set('mr', turn.answer.content);
    });

    it('produced three different answers with one unchanged canonical name', () => {
      const texts = (['en', 'hi', 'mr'] as const).map((language) => {
        const text = answers.get(language);
        if (text === undefined) {
          throw new Error(
            `the ${language} answer is missing, so this assertion cannot run. An earlier test in ` +
              'this file failed — fix that first; this one is a consequence of it.',
          );
        }
        return text;
      });

      // The name is what Requirements 4.6 / 9.4 pin; the difference is what shows the requested
      // language reached the model at all.
      expect(new Set(texts).size).toBe(3);
      for (const text of texts) expect(text).toContain(CONDITION);

      // And all three trace to the same seeded row: translation happens in the prose, never in the
      // row (Requirement 4.3). The English answer resolved two further tomato rows from its own
      // vocabulary, so it is checked against those as well — the Devanagari pair could only reach
      // this one.
      for (const language of ['hi', 'mr'] as const) {
        const text = answers.get(language) ?? '';
        expect(untraceableLines(text, [row], language)).toEqual([]);
      }
    });
  });

  /* ====================================================================== */
  /* A subject-less follow-up — Requirement 7.3                              */
  /* ====================================================================== */

  describe('a follow-up that omits its subject', () => {
    it('resolves the subject from the conversation most recent diagnosis', async () => {
      expect(matchConditions(SUBJECTLESS_FOLLOW_UP)).toEqual([]);

      const unitsBefore = await chatUnitsUsed();
      const turn = await ask(SUBJECTLESS_FOLLOW_UP, 'en');

      await expectGroundedTurn(turn, 'en', {
        conditions: [CONDITION],
        question: SUBJECTLESS_FOLLOW_UP,
        conversationId,
      });

      const prompt = rephrase.last();
      expect(prompt).toContain(`QUESTION: ${SUBJECTLESS_FOLLOW_UP}`);
      expect(prompt).toContain(`CURRENT DIAGNOSIS: ${CONDITION}`);
      // The prompt also states the rule the model is meant to apply, which is what makes this a
      // resolution rather than a coincidence.
      expect(prompt).toContain('it refers');
      expect(prompt).toContain('to CURRENT DIAGNOSIS.');

      expect(await chatUnitsUsed()).toBe(unitsBefore + 1);
    });

    it('refers the same question when the conversation has no diagnosis to resolve against', async () => {
      /**
       * The other side of Requirement 7.3, and the reason the diagnosis-free conversation exists: the
       * subject comes from the *conversation*, not from the farmer's history. `why?` in a thread with
       * no Diagnosis_Result has no subject anywhere, so Jamee refers rather than reaching back to
       * another thread's diagnosis — which is exactly what a context read keyed on the wrong column
       * would do.
       */
      const unitsBefore = await chatUnitsUsed();
      const callsBefore = providerCallCount(harness.providers.calls);

      const turn = await ask(SUBJECTLESS_FOLLOW_UP, 'en', {
        conversationId: emptyConversationId,
      });

      expect(turn.conversationId).toBe(emptyConversationId);
      expect(turn.answer.groundedIn).toEqual([]);
      expect(turn.answer.needsExpert).toBe(true);
      expect(turn.answer.content).toBe(messages('en').chat.outOfScope);
      // No model call at all: the referral returns above every line that could reach a provider.
      expect(providerCallCount(harness.providers.calls)).toBe(callsBefore);
      // And no unit: reserved, then refunded (Requirement 14.1's biconditional read backwards).
      expect(await chatUnitsUsed()).toBe(unitsBefore);
    });
  });

  /* ====================================================================== */
  /* An unknown question — Requirements 4.7 and 7.6                          */
  /* ====================================================================== */

  describe('a question about a crop Jamee does not cover', () => {
    it('states the coverage limit, recommends an expert, calls no model and spends nothing', async () => {
      expect(matchConditions(UNKNOWN_QUESTION)).toEqual([]);

      const unitsBefore = await chatUnitsUsed();
      const callsBefore = providerCallCount(harness.providers.calls);

      const turn = await ask(UNKNOWN_QUESTION, 'en', { conversationId: emptyConversationId });

      // Requirement 4.7 — the coverage limit and the expert recommendation, from the catalog, so the
      // copy ships pre-translated rather than being produced on a path that calls no model (D5).
      expect(turn.answer.content).toBe(messages('en').chat.outOfScope);
      expect(turn.answer.content).toContain('tomato and potato');
      expect(turn.answer.content).toContain('agricultural expert');
      expect(turn.answer.groundedIn).toEqual([]);
      expect(turn.answer.needsExpert).toBe(true);

      // Nothing reached a provider, and nothing was spent — the counter is the source of truth here,
      // not the response envelope.
      expect(providerCallCount(harness.providers.calls)).toBe(callsBefore);
      expect(await chatUnitsUsed()).toBe(unitsBefore);
      expect(turn.quota.used).toBe(unitsBefore);

      // Requirement 7.4 still holds: an honest referral is a turn, so both halves are persisted.
      const both = await harness.farmerA.client
        .from('messages')
        .select('id, role, content')
        .in('id', [turn.farmerMessageId, turn.answer.messageId]);
      expect(both.data).toHaveLength(2);
      expect(both.data?.find((message) => message.role === 'farmer')?.content).toBe(UNKNOWN_QUESTION);

      // Requirement 14.6 — the audit records that this was a *successful* request that Jamee could
      // not answer, with `quota_spent = false`. `inconclusive` rather than `provider_error`: nothing
      // failed.
      const audit = await chatAuditFor(emptyConversationId);
      const referrals = audit.filter((entry) => !entry.quota_spent);
      expect(referrals.length).toBeGreaterThan(0);
      for (const entry of referrals) {
        expect(entry.outcome).toBe('inconclusive');
        expect(entry.model_provider).toBe('none');
        expect(entry.used_fallback).toBe(false);
        expect(entry.channel).toBe('web');
      }
    });

    it('says it holds no verified information when the knowledge base answers nothing', async () => {
      /**
       * =====================================================================
       * REQUIREMENT 7.6's OWN BRANCH, AND WHY IT TAKES A BLIND READER TO REACH
       * =====================================================================
       *
       * `ReferralReason` has two members and they are **not** interchangeable: `out_of_scope` is
       * Requirement 4.7 (nothing in the question matched the verified vocabulary) and renders
       * `chat.outOfScope`; `no_verified_content` is Requirement 7.6 (names matched, and the base
       * returned no rows for them) and renders `chat.noVerifiedInfo`. The test above is 4.7's.
       *
       * 7.6's branch is unreachable in a *correctly seeded* deployment, by Requirement 4.1's own
       * guarantee — which the assertion below states as a fact about this database rather than as a
       * belief. So the only honest way to drive it is a reader that genuinely returns nothing, and
       * RLS supplies exactly one: `dk_select_authenticated` in `0004` grants the read to
       * `authenticated` alone, so a **session-less** client matches no policy and sees zero rows with
       * no error. That is Requirement 4.1's failure state reproduced through a real policy rather
       * than through a fake reader — and it is worth having, because it is the branch a partially
       * applied migration would put every farmer on.
       *
       * Everything else in the turn stays real and stays the farmer's: the context read, the writes
       * and the audit row all still go through `farmerA.client`.
       */
      const seeded = await resolveScope(
        { condition: CONDITION },
        knowledgeReaderFrom(harness.farmerA.client),
      );
      expect(seeded.kind).toBe('grounded');

      const blind = knowledgeReaderFrom(anonClient(harness.config));
      // The premise, checked rather than assumed: this reader really does see nothing, and reports
      // it as an empty result rather than as an error (which `knowledge.ts` would have thrown).
      expect(await blind([...VERIFIED_CONDITIONS])).toEqual([]);

      const unitsBefore = await chatUnitsUsed();
      const callsBefore = providerCallCount(harness.providers.calls);

      const turn = await ask(SUBJECTLESS_FOLLOW_UP, 'en', { deps: { knowledge: blind } });

      // Requirement 7.6 — Jamee lacks verified information for that question, and recommends an
      // expert. A *different* sentence from 4.7's, which is the whole reason the two reasons exist.
      expect(turn.answer.content).toBe(messages('en').chat.noVerifiedInfo);
      expect(turn.answer.content).not.toBe(messages('en').chat.outOfScope);
      expect(turn.answer.content).toContain('agricultural expert');
      expect(turn.answer.groundedIn).toEqual([]);
      expect(turn.answer.needsExpert).toBe(true);

      // Still no model call, and still nothing spent: an empty base is not a reason to invent an
      // answer, and Jamee does not charge for admitting it.
      expect(providerCallCount(harness.providers.calls)).toBe(callsBefore);
      expect(await chatUnitsUsed()).toBe(unitsBefore);
    });
  });

  /* ====================================================================== */
  /* The whole file, seen from the audit trail                               */
  /* ====================================================================== */

  it('recorded one chat row per turn, spent only the grounded ones, and leaked none', async () => {
    const { data, error } = await harness.farmerA.client
      .from('usage_logs')
      .select('operation, channel, outcome, quota_spent, user_id')
      .eq('operation', 'chat');

    expect(error).toBeNull();
    const rows = data ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const entry of rows) {
      expect(entry.channel).toBe('web');
      expect(entry.user_id).toBe(harness.farmerA.id);
    }

    // Three referrals in this file — the subject-less question in the empty thread, the unknown
    // crop, and the blind-reader turn — and each one spent nothing.
    const unspent = rows.filter((entry) => !entry.quota_spent);
    expect(unspent).toHaveLength(3);
    for (const entry of unspent) expect(entry.outcome).toBe('inconclusive');

    // Every spent row was a grounded turn, and the counter agrees with the count of them (D10: the
    // counter is the source of truth, and this is the audit reconciling with it).
    const spent = rows.filter((entry) => entry.quota_spent);
    expect(spent.length).toBeGreaterThan(0);
    for (const entry of spent) expect(entry.outcome).toBe('success');
    expect(await chatUnitsUsed()).toBe(spent.length);

    // Requirement 13.2 on the audit table: the other farmer's session sees none of it.
    const theirs = await harness.farmerB.client.from('usage_logs').select('user_id');
    expect(theirs.error).toBeNull();
    expect(theirs.data ?? []).toEqual([]);
  });
});
