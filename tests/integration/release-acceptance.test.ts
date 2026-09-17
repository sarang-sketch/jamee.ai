import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  DETAIL_MESSAGE_LIMIT,
  DIAGNOSIS_DETAIL_SELECT,
  DIAGNOSIS_MESSAGES_SELECT,
  resolveDetailImage,
  toDiagnosisDetail,
} from '@/app/diagnosis/detail';
import {
  HISTORY_PAGE_SIZE,
  HISTORY_SELECT,
  readHistory,
  storageImageSource,
  type HistoryEntry,
} from '@/lib/history';
import { knowledgePayloadOf, knowledgeReaderFrom, lookupCondition } from '@/lib/knowledge';
import type { IdentifiedResult, Language, VerifiedCondition } from '@/lib/schemas';
import { dayWindowKey } from '@/lib/time';
import { chatAnswerer, chatTurn, chatWriteStoreFrom } from '@/services/chat.service';
import {
  diagnose,
  diagnosisStoreFrom,
  type DiagnosisDeps,
  type DiagnosisOutcome,
} from '@/services/diagnosis.service';
import { transcribeAndAnswer, voiceStoreFrom } from '@/services/voice.service';
import type { DiseaseKnowledgeRow } from '@/types/database';

import { TEST_DATABASE_URL_VAR, describeIntegration } from './database';
import { knowledgeRow, startHarness, type Harness } from './harness';
import { uploadedImage, uploadedRecording } from './objects';
import { CLASSIFICATIONS, DEFAULT_TRANSCRIPTION, classificationText } from './providers';

/**
 * The release acceptance sequence, as far as a machine can walk it.
 *
 * Requirements: 3.2 (an identified result's explanation is composed only from the matching
 *               Knowledge_Base entry), 4.3 (every symptom, cause, treatment and prevention sentence
 *               a farmer reads comes from a `disease_knowledge` row), 4.5 (the model is given that
 *               content and asked to rephrase only it), 4.6 / 9.4 (the Canonical_Disease_Name is
 *               unchanged in every Supported_Language), 7.3 (a subject-less follow-up resolves
 *               against the conversation's most recent Diagnosis_Result), 8.6 (a voice request
 *               returns the transcript **and** the text answer), 9.3 (the explanation comes back in
 *               the requested language), 12.1 / 12.2 / 12.3 (history is reverse-chronological,
 *               includes WhatsApp-originated diagnoses, and has a detail view), 13.1 / 13.2 (RLS,
 *               and each farmer restricted to their own rows), 14.1 (one voice message spends one
 *               voice unit and no chat unit), 17.5
 * Design: "Integration tests — mocked providers, real Postgres"
 *
 * =============================================================================
 * WHICH ACCEPTANCE STEPS ARE HERE, AND WHICH CANNOT BE
 * =============================================================================
 *
 * The requirements' *Release Acceptance Criteria* is an eight-step sequence a tester walks without
 * developer assistance. Steps **2, 3, 4, 5 and 7** are encoded below, in that order, as one
 * continuous path through one farmer's data — not five independent scenarios, because the sequence's
 * value is that each step stands on the row the previous one wrote.
 *
 * Three items are deliberately absent:
 *
 *  - **Step 1 (sign in with a real SMS passcode)** and **step 6 (the same photo on WhatsApp from a
 *    real handset)** are human-tester items. `tests/integration/farmers.ts` records why OTP delivery
 *    is not automatable here — it needs the one paid dependency in the whole deployment — and task
 *    31.2 records both in `docs/TESTING_REPORT.md`.
 *  - **Step 8's "no model training" half** is a property of the codebase rather than of a run: it is
 *    the *absence* of a call, which nothing observable at runtime can witness. It is asserted
 *    statically by `npm run check:shared-implementation` (task 27.3), whose `no-training` rule scans
 *    every source file — including this one — for training and fine-tuning surfaces. Step 8's other
 *    half, "every agricultural statement traces to a Knowledge_Base row", *is* observable and is the
 *    last test below.
 *
 * =============================================================================
 * HOW "EVERY AGRICULTURAL SENTENCE TRACES TO A ROW" IS MADE INTO AN ASSERTION
 * =============================================================================
 *
 * A stubbed model cannot prove that Jamee does not invent agronomy — the stub *is* the model, so a
 * fixture that returned invented sentences would only be testing the fixture. What makes the claim
 * checkable is the stub's construction: **`groundedRephrase()` authors nothing.** Every line it
 * returns was lifted out of the prompt the service itself built, so it is structurally incapable of
 * introducing a sentence the knowledge base did not supply. Anything in the farmer-facing text that
 * is *not* a verbatim row item therefore came from Jamee, and that is exactly what the ledger below
 * inspects: every non-empty line of every farmer-facing string produced during the run must be a
 * verbatim item of a seeded row, a Canonical_Disease_Name, or the language name the service asked
 * the model to write in.
 *
 * Two assertions sit either side of that one, because grounding is a claim about a round trip:
 *
 *  - **Into the model** — the rephrase prompt's verified-content block is compared to the seeded
 *    row's own four arrays, in order, so Requirement 4.5's "supply the relevant content and instruct
 *    the model to rephrase only it" is checked as a fact about the request.
 *  - **Out of the model** — `result.knowledge` is compared to `knowledgePayloadOf(row)`, so the
 *    structured half of Requirement 3.2 is checked against the row rather than against strings this
 *    file authored. Nothing here writes an agricultural sentence of its own, and that is the point:
 *    the harness never seeds `disease_knowledge` either (see `assertMigrationsApplied`).
 *
 * =============================================================================
 * THE LANGUAGE STEP, AND THE ONE THING IT CANNOT ASSERT
 * =============================================================================
 *
 * Step 4 wants Hindi and Marathi explanations with the canonical name unchanged. The stub cannot
 * translate — no fixture can, without a translation engine or hand-written agronomy in three
 * languages, and hand-written agronomy is the thing Requirement 4.3 forbids. So what the stub *can*
 * do is echo back the language the service asked for, which makes three facts observable: the
 * request named the right language, the three explanations differ, and the canonical name survives
 * all three verbatim in Latin script. That the returned prose is genuinely fluent Hindi or Marathi
 * is a **provider-quality** question, and it stays a human-tester item (task 30.1 already records
 * transcription quality the same way).
 */

/* ========================================================================== */
/* The condition this sequence is about                                        */
/* ========================================================================== */

/**
 * One scripted classification, read for both the fixture and the expectation.
 *
 * Taken from `CLASSIFICATIONS` rather than written twice: the name the stub reports and the name the
 * assertions look up are the same value, so they cannot drift into a test that passes while
 * describing a different row.
 */
const CLASSIFIED = CLASSIFICATIONS.tomatoEarlyBlight;
const CONDITION: VerifiedCondition = CLASSIFIED.disease_name;

/** The three languages step 4 walks, English first because step 2 established it. */
const LANGUAGES: readonly Language[] = ['en', 'hi', 'mr'];

/**
 * The language names as the prompts spell them.
 *
 * `prompts.ts` keeps its own `LANGUAGE_NAMES` private, and importing it would make this file a
 * consumer of a prompt internal for no gain. This copy exists only to *read a prompt back*, and the
 * assertions below fail loudly if the two ever disagree — a prompt that stopped naming the language
 * would leave `languageAskedFor()` with nothing to find.
 */
const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
};

/* ========================================================================== */
/* The provider stub that cannot invent a sentence                             */
/* ========================================================================== */

/** `    - item` — the indentation `verifiedContentBlock()` gives a knowledge-base item. */
const VERIFIED_ITEM_LINE = /^ {4}- (.+)$/;

/**
 * The language the prompt asked for: `into simple Hindi` (rephrase) or `otherwise reply in Hindi`
 * (chat). One pattern for both, because both prompts state it and neither states it twice.
 */
const ASKED_LANGUAGE = /(?:into simple|otherwise reply in) (English|Hindi|Marathi)\b/;

/**
 * How much of the verified content the stub echoes back, in UTF-16 code units.
 *
 * Well under `REPHRASE_MAX_CHARS` (1200), which matters: a chat answer can be grounded in three
 * rows at once — "my tomato leaves have dark spots" resolves to all three tomato rows — and echoing
 * every item of all three would trip check 1 and land the run on the static template. That is a real
 * production path, but it is not the path this sequence is walking, and a fixture that silently took
 * it would make the language step assert headings instead of prose. 600 leaves the stub at roughly
 * the four-to-six short sentences the prompt asks for.
 */
const ECHO_BUDGET_CHARS = 600;

/** Every knowledge-base item the prompt supplied, in the order it supplied them. */
function verifiedItemsIn(prompt: string): string[] {
  const items: string[] = [];
  for (const line of prompt.split('\n')) {
    const matched = VERIFIED_ITEM_LINE.exec(line);
    if (matched?.[1] !== undefined) items.push(matched[1]);
  }
  return items;
}

/** The language name the prompt named, or a failure that says the prompt stopped naming one. */
function languageAskedFor(prompt: string): string {
  const matched = ASKED_LANGUAGE.exec(prompt);
  if (matched?.[1] === undefined) {
    throw new Error(
      'the prompt named no language, so Requirement 9.3 is unobservable from it. Both ' +
        'rephrasePrompt() and chatPrompt() state the requested language; if the wording changed, ' +
        'ASKED_LANGUAGE in this file has to change with it.',
    );
  }
  return matched[1];
}

/** Every `text-generate` prompt the services built, in order. */
const textPrompts: string[] = [];

/**
 * The stubbed rephrase: the language the prompt asked for, then the content the prompt supplied.
 *
 * **It authors nothing.** Both lines come out of `prompt`, which is why the ledger's "every line
 * traces to a row" assertion says something about Jamee rather than about this function. It also
 * names no condition, so `validateRephrased()`'s check 2 prefixes the Canonical_Disease_Name — a
 * real production path (a model that answered without repeating the name), and the reason every
 * explanation below starts with that name in Latin script.
 */
function groundedRephrase(prompt: string): string {
  textPrompts.push(prompt);

  const language = languageAskedFor(prompt);
  const lines: string[] = [language];
  let size = language.length;

  for (const item of verifiedItemsIn(prompt)) {
    if (size + item.length + 1 > ECHO_BUDGET_CHARS) break;
    lines.push(item);
    size += item.length + 1;
  }

  return lines.join('\n');
}

/** The prompt of the most recent `text-generate` call. */
function lastTextPrompt(): string {
  const prompt = textPrompts.at(-1);
  if (prompt === undefined) throw new Error('no text-generate call has been made yet');
  return prompt;
}

/* ========================================================================== */
/* The grounding ledger                                                        */
/* ========================================================================== */

/** One farmer-facing string, with the rows it is allowed to have come from. */
interface LedgerEntry {
  /** Which acceptance step produced it, for a failure that names the step. */
  readonly step: string;
  readonly text: string;
  readonly rows: readonly DiseaseKnowledgeRow[];
}

const ledger: LedgerEntry[] = [];

/**
 * Every line a farmer may read without Jamee having invented it: the four content arrays of each
 * row in scope, each Canonical_Disease_Name, and the language names — the one non-agronomic line the
 * stub echoes, which the model would have replaced with prose in that language.
 */
function traceableLines(rows: readonly DiseaseKnowledgeRow[]): ReadonlySet<string> {
  const allowed = new Set<string>(Object.values(LANGUAGE_NAMES));

  for (const row of rows) {
    allowed.add(row.disease_name);
    for (const field of ['symptoms', 'causes', 'treatment', 'prevention'] as const) {
      for (const item of row[field]) allowed.add(item);
    }
  }

  return allowed;
}

/** The lines of `text` that trace to no row — empty is the assertion (Requirement 4.3). */
function untraceableLines(text: string, rows: readonly DiseaseKnowledgeRow[]): string[] {
  const allowed = traceableLines(rows);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !allowed.has(line));
}

/** Record a farmer-facing string and check it immediately, so a failure names its own step. */
function grounded(step: string, text: string, rows: readonly DiseaseKnowledgeRow[]): void {
  ledger.push({ step, text, rows });
  expect(untraceableLines(text, rows), `${step}: lines that trace to no knowledge-base row`).toEqual(
    [],
  );
}

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/**
 * A value an earlier step in the sequence was supposed to produce.
 *
 * The acceptance sequence is ordered by nature — step 3 asks a follow-up about step 2's diagnosis —
 * so a later test cannot be made independent of an earlier one without ceasing to be the sequence.
 * This turns "the previous step did not run" into a sentence instead of a `undefined` dereference.
 */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(
      `${what} is missing, so this step of the acceptance sequence cannot run. An earlier step ` +
        'in this file failed — fix that failure first; this one is a consequence of it.',
    );
  }
  return value;
}

/** The outcome's result, narrowed to the identified branch. */
function identifiedResultOf(outcome: DiagnosisOutcome): IdentifiedResult {
  expect(outcome.result.status).toBe('identified');
  if (outcome.result.status !== 'identified') {
    throw new Error(`expected an identified result, received ${outcome.result.status}`);
  }
  return outcome.result;
}

describeIntegration(`release acceptance sequence (requires ${TEST_DATABASE_URL_VAR})`, () => {
  let harness: Harness;

  /** What each step hands the next. */
  let row: DiseaseKnowledgeRow;
  let conversationId: string | undefined;
  let webDiagnosisId: string | undefined;
  let followUpMessageId: string | undefined;
  let followUpAnswer: string | undefined;
  const explanations = new Map<Language, string>();

  beforeAll(async () => {
    harness = await startHarness({ providers: { text: groundedRephrase } });
    row = knowledgeRow(harness, CONDITION);
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  /* ====================================================================== */
  /* Step 2 — upload a crop image, receive a grounded result                 */
  /* ====================================================================== */

  it('step 2: grounds an uploaded crop image in the seeded row of the name it reported', async () => {
    const { farmerA, farmerB, objects, providers } = harness;
    providers.script.vision = classificationText(CLASSIFIED);

    const outcome = await diagnose(
      {
        userId: farmerA.id,
        storageRef: uploadedImage(objects, farmerA.id),
        language: 'en',
        channel: 'web',
      },
      webDiagnosisDeps(harness),
    );

    const result = identifiedResultOf(outcome);
    expect(result.diseaseName).toBe(CONDITION);
    expect(result.confidence).toBe(CLASSIFIED.confidence);
    expect(result.severity).toBe(CLASSIFIED.severity);
    expect(result.needsExpert).toBe(false);

    // Requirement 4.5, into the model: the request carried this row's four arrays, in order, and
    // nothing else agronomic.
    expect(verifiedItemsIn(lastTextPrompt())).toEqual([
      ...row.symptoms,
      ...row.causes,
      ...row.treatment,
      ...row.prevention,
    ]);

    // Requirement 3.2, out of the model: the structured payload is the row's own arrays.
    expect(result.knowledge).toEqual(knowledgePayloadOf(row));
    expect(result.knowledge.source).toBe(row.source);

    // Requirements 4.6 / 9.4 — the canonical name leads, in Latin script.
    expect(result.explanation.split('\n')[0]).toBe(CONDITION);
    grounded('step 2 explanation', result.explanation, [row]);

    // The rephrase was the model's prose, not the degraded static template: a `success` audit row is
    // the only outcome `outcomeForDegradation(null)` writes, so this pins the path the rest of the
    // sequence is walking rather than trusting it.
    const audit = await farmerA.client
      .from('usage_logs')
      .select('operation, channel, outcome, quota_spent, diagnosis_id')
      .eq('diagnosis_id', outcome.diagnosisId);
    expect(audit.error).toBeNull();
    expect(audit.data).toHaveLength(1);
    expect(audit.data?.[0]?.outcome).toBe('success');
    expect(audit.data?.[0]?.operation).toBe('image');
    expect(audit.data?.[0]?.channel).toBe('web');
    expect(audit.data?.[0]?.quota_spent).toBe(true);

    // Requirements 13.1 / 13.2. Written with the farmer's own session, so RLS is the second
    // boundary here; the assertion that it is a boundary at all is the *other* farmer's read.
    await expectDiagnosisVisibleToOwnerOnly(outcome.diagnosisId);
    const theirLogs = await farmerB.client.from('usage_logs').select('user_id');
    expect(theirLogs.data?.some((entry) => entry.user_id === farmerA.id)).toBe(false);

    conversationId = outcome.conversationId;
    webDiagnosisId = outcome.diagnosisId;
    explanations.set('en', result.explanation);
  });

  /* ====================================================================== */
  /* Step 3 — a follow-up in the same conversation resolves against it       */
  /* ====================================================================== */

  it('step 3: answers a subject-less follow-up against that conversation diagnosis', async () => {
    const { farmerA } = harness;
    const conversation = required(conversationId, "step 2's conversation");

    const turn = await chatTurn(
      {
        userId: farmerA.id,
        conversationId: conversation,
        // Requirement 7.3's own example. It contributes no vocabulary at all — `matchConditions()`
        // returns nothing for it — so the only way this turn can be grounded is through
        // `ConversationContext.condition`, which is the conversation's most recent Diagnosis_Result.
        message: 'why?',
        language: 'en',
        channel: 'web',
      },
      {
        supabase: farmerA.client,
        writes: chatWriteStoreFrom(farmerA.client, harness.admin),
        knowledge: knowledgeReaderFrom(farmerA.client),
        models: harness.providers.models,
        quota: harness.quota,
      },
    );

    expect(turn.conversationId).toBe(conversation);
    // The subject came from the diagnosis, not from the question.
    expect(turn.answer.groundedIn).toEqual([CONDITION]);
    expect(turn.answer.needsExpert).toBe(false);
    expect(lastTextPrompt()).toContain(`CURRENT DIAGNOSIS: ${CONDITION}`);
    expect(lastTextPrompt()).toContain('QUESTION: why?');

    expect(turn.answer.content.split('\n')[0]).toBe(CONDITION);
    grounded('step 3 answer', turn.answer.content, [row]);

    // Requirement 7.4 — both halves of the turn are rows in the same conversation.
    const thread = await farmerA.client
      .from('messages')
      .select('id, role, content, conversation_id')
      .eq('conversation_id', conversation);
    expect(thread.error).toBeNull();
    const turnRows = thread.data ?? [];
    expect(turnRows).toHaveLength(2);
    // Matched by role rather than by position, for the reason `persistTurn` gives: both rows are
    // written by one statement inside one transaction, so they carry the *same* `created_at` and no
    // ordering clause can separate them.
    expect(turnRows.find((message) => message.role === 'farmer')?.content).toBe('why?');
    expect(turnRows.find((message) => message.role === 'jamee')?.content).toBe(turn.answer.content);

    await expectMessageVisibleToOwnerOnly(turn.farmerMessageId);

    followUpMessageId = turn.farmerMessageId;
    followUpAnswer = turn.answer.content;
  });

  /* ====================================================================== */
  /* Step 4 — Hindi and Marathi, canonical name unchanged                    */
  /* ====================================================================== */

  it('step 4: returns Hindi and Marathi explanations with the canonical name unchanged', async () => {
    const { farmerA, objects, providers } = harness;
    const conversation = required(conversationId, "step 2's conversation");
    providers.script.vision = classificationText(CLASSIFIED);

    for (const language of ['hi', 'mr'] as const) {
      const outcome = await diagnose(
        {
          userId: farmerA.id,
          storageRef: uploadedImage(objects, farmerA.id),
          language,
          channel: 'web',
          conversationId: conversation,
        },
        webDiagnosisDeps(harness),
      );

      const result = identifiedResultOf(outcome);
      expect(result.language).toBe(language);

      // Requirement 9.3 — the request asked for this language by name.
      expect(lastTextPrompt()).toContain(`into simple ${LANGUAGE_NAMES[language]}`);

      // Requirements 4.6 / 9.4 — the Canonical_Disease_Name is Latin script and byte-identical in
      // every Supported_Language. `split('\n')[0]` rather than `includes()`, so a transliteration
      // sitting alongside the real name could not satisfy it.
      expect(result.explanation.split('\n')[0]).toBe(CONDITION);
      // The same verified content, whatever the language: translation happens in the prose, never in
      // the row (Requirement 4.3).
      expect(result.knowledge).toEqual(knowledgePayloadOf(row));

      grounded(`step 4 ${language} explanation`, result.explanation, [row]);

      // The row records the language it was written in (Requirement 9.3 at the persistence layer).
      const stored = await farmerA.client
        .from('diagnoses')
        .select('language, disease_name, explanation')
        .eq('id', outcome.diagnosisId)
        .single();
      expect(stored.error).toBeNull();
      expect(stored.data?.language).toBe(language);
      expect(stored.data?.disease_name).toBe(CONDITION);
      expect(stored.data?.explanation).toBe(result.explanation);

      await expectDiagnosisVisibleToOwnerOnly(outcome.diagnosisId);
      explanations.set(language, result.explanation);
    }

    // Three languages, three different explanations, one unchanged name. The name is what the
    // requirement pins; the difference is what shows the language reached the model.
    const texts = LANGUAGES.map((language) =>
      required(explanations.get(language), `the ${language} explanation`),
    );
    expect(new Set(texts).size).toBe(LANGUAGES.length);
    for (const text of texts) expect(text).toContain(CONDITION);
  });

  /* ====================================================================== */
  /* Step 5 — a voice message returns a text answer                          */
  /* ====================================================================== */

  it('step 5: returns a transcript and a text answer for one voice unit', async () => {
    const { farmerA, objects, providers } = harness;
    const conversation = required(conversationId, "step 2's conversation");
    const rpc = required(harness.quota.rpc, 'the harness counter RPC');
    const recording = uploadedRecording(objects, farmerA.id);

    const windowKey = dayWindowKey();
    const chatBefore = await rpc.used({
      userId: farmerA.id,
      operation: 'chat',
      windowKind: 'day',
      windowKey,
    });

    const outcome = await transcribeAndAnswer(
      {
        userId: farmerA.id,
        storageRef: recording,
        language: 'en',
        channel: 'web',
        conversationId: conversation,
        durationSeconds: DEFAULT_TRANSCRIPTION.duration ?? 6,
      },
      {
        supabase: farmerA.client,
        // Requirement 8.4 / 16.2 — the transcript is answered by the same ChatService the web and
        // WhatsApp text paths use, bound to this farmer's credential.
        chat: chatAnswerer({
          supabase: farmerA.client,
          writes: chatWriteStoreFrom(farmerA.client, harness.admin),
          knowledge: knowledgeReaderFrom(farmerA.client),
          models: providers.models,
          quota: harness.quota,
        }),
        storage: objects,
        /**
         * Passed explicitly rather than defaulted, because the default is `createAdminClient()` —
         * which would point the delete at the real bucket and make Requirement 8.9's disposition an
         * accident of whether an object with that path happened to exist there. The harness store
         * satisfies `ObjectRemoveClient` directly since `tests/integration/objects.ts` folded
         * `remove()` into its `storage.from()` surface.
         */
        deleter: objects,
        store: voiceStoreFrom(harness.admin),
        transcribe: providers.transcribe,
        quota: harness.quota,
      },
    );

    // Requirement 8.6 — the transcript AND the answer, together, from one call.
    expect(outcome.transcript).toBe(DEFAULT_TRANSCRIPTION.text);
    expect(outcome.answer.content.trim()).not.toBe('');
    expect(outcome.conversationId).toBe(conversation);

    grounded(
      'step 5 voice answer',
      outcome.answer.content,
      outcome.answer.groundedIn.map((condition) => knowledgeRow(harness, condition)),
    );

    // Requirement 14.1's nesting rule: one voice message spends one **voice** unit, and the chat
    // answer produced inside it spends none. Read from the counter functions, which are the source
    // of truth (D10), not from the response envelope.
    const voiceUsed = await rpc.used({
      userId: farmerA.id,
      operation: 'voice',
      windowKind: 'day',
      windowKey,
    });
    const chatAfter = await rpc.used({
      userId: farmerA.id,
      operation: 'chat',
      windowKind: 'day',
      windowKey,
    });
    expect(voiceUsed).toBe(1);
    expect(chatAfter).toBe(chatBefore);
    expect(outcome.quota.operation).toBe('voice');
    expect(outcome.quota.used).toBe(1);

    // Requirements 8.9 / 8.11 — the transcript is persisted, so the recording is gone.
    expect(outcome.audio).toEqual({ outcome: 'deleted' });
    expect(objects.has(recording)).toBe(false);
    const transcriptRow = await farmerA.client
      .from('messages')
      .select('content, input_kind, transcript_of')
      .eq('id', outcome.farmerMessageId)
      .single();
    expect(transcriptRow.data?.content).toBe(DEFAULT_TRANSCRIPTION.text);
    expect(transcriptRow.data?.input_kind).toBe('voice');
    expect(transcriptRow.data?.transcript_of).toBe(recording.path);

    await expectMessageVisibleToOwnerOnly(outcome.farmerMessageId);
  });

  /* ====================================================================== */
  /* Step 7 — history holds both channels, and one detail view               */
  /* ====================================================================== */

  it('step 7: lists the web and WhatsApp diagnoses together, newest first', async () => {
    const { farmerA, farmerB, objects, providers } = harness;
    providers.script.vision = classificationText(CLASSIFIED);

    // The WhatsApp half of the list, produced the way the WhatsApp channel produces it: the
    // service-role client, because a webhook carries no session. That single argument is what makes
    // this the WhatsApp path rather than a web request wearing a different `channel` value.
    const whatsapp = await diagnose(
      {
        userId: farmerA.id,
        storageRef: uploadedImage(objects, farmerA.id),
        language: 'en',
        channel: 'whatsapp',
      },
      {
        supabase: harness.admin,
        storage: objects,
        store: diagnosisStoreFrom(harness.admin, harness.admin),
        knowledge: knowledgeReaderFrom(harness.admin),
        models: providers.models,
        quota: harness.quota,
      },
    );

    const whatsappResult = identifiedResultOf(whatsapp);
    expect(whatsappResult.diseaseName).toBe(CONDITION);
    grounded('step 7 WhatsApp explanation', whatsappResult.explanation, [row]);

    // Requirement 10.7 read as far as an automated test can: the same service, the same row, and
    // identical structured fields on both channels. The prose is compared by the ledger above; the
    // human-tester item in `docs/TESTING_REPORT.md` compares what a real handset displays.
    expect(whatsappResult.knowledge).toEqual(knowledgePayloadOf(row));
    expect(whatsappResult.confidence).toBe(CLASSIFIED.confidence);
    expect(whatsappResult.severity).toBe(CLASSIFIED.severity);

    // Written with the service role, so the application's own `user_id` is the only boundary at the
    // insert — and the farmer's session is still the only session that can read it back.
    await expectDiagnosisVisibleToOwnerOnly(whatsapp.diagnosisId);

    const entries = await readHistory({
      userId: farmerA.id,
      source: storageImageSource(objects),
      query: () =>
        farmerA.client
          .from('diagnoses')
          .select(HISTORY_SELECT)
          .eq('user_id', farmerA.id)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(HISTORY_PAGE_SIZE),
    });

    // Requirement 12.2 — both channels, one list, no filter.
    const web = required(webDiagnosisId, "step 2's diagnosis");
    expect(entries.map((entry) => entry.id)).toContain(web);
    expect(entries.map((entry) => entry.id)).toContain(whatsapp.diagnosisId);
    expect(new Set(entries.map((entry) => entry.channel))).toEqual(new Set(['web', 'whatsapp']));

    // Requirement 12.1 — reverse chronological, and every field the list screen renders.
    expect(entries).toEqual([...entries].sort(newestFirst));
    for (const entry of entries) {
      expect(entry.condition).toBe(CONDITION);
      expect(entry.severity).toBe(CLASSIFIED.severity);
      expect(entry.createdAt).not.toBe('');
      // Requirement 12.5 / 12.7 — a Signed_URL for the full-size original, since no thumbnail
      // derivative exists for either channel in this run (a WhatsApp upload never has one).
      expect(entry.image?.kind).toBe('full');
      expect(entry.image?.url ?? '').toContain('/object/sign/');
    }

    // Requirement 13.2 on the read side: the other farmer's history is not a filtered view of this
    // one, it is empty.
    const theirs = await readHistory({
      userId: farmerB.id,
      source: storageImageSource(objects),
      query: () =>
        farmerB.client
          .from('diagnoses')
          .select(HISTORY_SELECT)
          .eq('user_id', farmerB.id)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(HISTORY_PAGE_SIZE),
    });
    expect(theirs).toEqual([]);
  });

  it('step 7: opens the detail view of one entry with every field it renders', async () => {
    const { farmerA, objects } = harness;
    const web = required(webDiagnosisId, "step 2's diagnosis");
    const conversation = required(conversationId, "step 2's conversation");

    const stored = await farmerA.client
      .from('diagnoses')
      .select(DIAGNOSIS_DETAIL_SELECT)
      .eq('id', web)
      .eq('user_id', farmerA.id)
      .maybeSingle();
    expect(stored.error).toBeNull();
    const detailRow = required(stored.data ?? undefined, 'the stored diagnosis row');

    // The screen's own read of the knowledge base — the shared `lookupCondition`, not a second
    // query — because `diagnoses` stores the grounded explanation but not the four arrays.
    const lookup = await lookupCondition(CONDITION, knowledgeReaderFrom(farmerA.client));
    expect(lookup.found).toBe(true);
    const payload = lookup.found ? knowledgePayloadOf(lookup.entry) : null;

    const detail = toDiagnosisDetail(detailRow, payload);
    const view = required(detail ?? undefined, 'the detail view model');

    // Requirement 12.3's field list, every one of them.
    expect(view.status).toBe('identified');
    if (view.status !== 'identified') throw new Error('the detail view lost its identified branch');
    expect(view.diseaseName).toBe(CONDITION);
    expect(view.confidence).toBe(CLASSIFIED.confidence);
    expect(view.severity).toBe(CLASSIFIED.severity);
    expect(view.channel).toBe('web');
    expect(view.knowledge).toEqual(knowledgePayloadOf(row));
    expect(view.explanation).toBe(required(explanations.get('en'), 'the English explanation'));
    grounded('step 7 detail explanation', view.explanation, [row]);

    // Requirement 12.3's last field: the related Conversation messages, which are step 3's turn.
    const thread = await farmerA.client
      .from('messages')
      .select(DIAGNOSIS_MESSAGES_SELECT)
      .eq('conversation_id', view.conversationId)
      .eq('user_id', farmerA.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(DETAIL_MESSAGE_LIMIT);
    expect(thread.error).toBeNull();
    expect(view.conversationId).toBe(conversation);
    const contents = (thread.data ?? []).map((message) => message.content);
    expect(contents).toContain('why?');
    expect(contents).toContain(required(followUpAnswer, "step 3's answer"));
    expect((thread.data ?? []).map((message) => message.id)).toContain(
      required(followUpMessageId, "step 3's farmer message"),
    );

    // Requirements 12.5 / 12.8 — the full-size original, through a Signed_URL.
    const image = await resolveDetailImage(detailRow, objects);
    expect(image.kind).toBe('full');
  });

  /* ====================================================================== */
  /* Step 8 — the knowledge-base half                                        */
  /* ====================================================================== */

  it('step 8: traces every agricultural sentence of the whole run to a seeded row', () => {
    // Six farmer-facing strings: the English explanation, the follow-up answer, Hindi, Marathi, the
    // voice answer, the WhatsApp explanation, and the detail view's copy of the first. Asserted as a
    // count so this test cannot pass by having recorded nothing.
    expect(ledger.map((entry) => entry.step)).toEqual([
      'step 2 explanation',
      'step 3 answer',
      'step 4 hi explanation',
      'step 4 mr explanation',
      'step 5 voice answer',
      'step 7 WhatsApp explanation',
      'step 7 detail explanation',
    ]);

    /**
     * Re-checked against **all five seeded rows** rather than each step's own scope, which is
     * Requirement 4.3 stated at its widest: `disease_knowledge` as the migrations seeded it is the
     * only permitted source of an agricultural sentence anywhere in the run. The per-step assertions
     * inside `grounded()` are the stricter ones — they pin each string to the row it should have
     * come from — and this one is the claim step 8 actually makes.
     */
    for (const entry of ledger) {
      expect(
        untraceableLines(entry.text, harness.knowledge),
        `${entry.step}: lines outside the seeded knowledge base`,
      ).toEqual([]);
    }

    // And the harness never seeded that content: `assertMigrationsApplied()` reads the five rows the
    // migrations wrote and refuses to run against a database without them, so a green run here is a
    // statement about `0010`'s content rather than about a fixture.
    expect(harness.knowledge).toHaveLength(5);
    for (const seeded of harness.knowledge) expect(seeded.source.trim()).not.toBe('');
  });

  /* ====================================================================== */
  /* Shared assertions                                                       */
  /* ====================================================================== */

  /** The owner reads the row, the other farmer reads nothing, the service role proves it is there. */
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
});

/* ========================================================================== */
/* Wiring shared by every web-path call                                        */
/* ========================================================================== */

/**
 * The web channel's dependencies: the farmer's own RLS-scoped session everywhere except the
 * append-only audit row, which migration `0006` grants `authenticated` no insert policy for.
 *
 * Passed explicitly rather than left to default so nothing in this file constructs a client from an
 * environment variable — the same reason the harness passes `quota` explicitly.
 */
function webDiagnosisDeps(harness: Harness): DiagnosisDeps {
  return {
    supabase: harness.farmerA.client,
    storage: harness.objects,
    store: diagnosisStoreFrom(harness.farmerA.client, harness.admin),
    knowledge: knowledgeReaderFrom(harness.farmerA.client),
    models: harness.providers.models,
    quota: harness.quota,
  };
}

/**
 * `readHistory`'s own order, restated so the assertion checks the property rather than the query.
 *
 * Requirement 12.1's ordering is a fact about the returned list, and `readHistory` re-sorts what
 * PostgREST gave it precisely so the caller's `order` clauses are not the only thing making it true.
 *
 * The two keys and the two comparisons are `history.ts`'s, deliberately — `Date.parse` rather than a
 * string compare, `localeCompare` rather than `<` on the id. A comparator that agreed about the
 * timestamps but disagreed about a tie-break would report a correctly ordered list as unordered.
 */
function newestFirst(left: HistoryEntry, right: HistoryEntry): number {
  const byTime = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return right.id.localeCompare(left.id);
}
