/**
 * `check-shared-implementation` — the CI gate that keeps Jamee's *single* implementation single.
 *
 * Requirements: 3.8 (the Diagnosis_Service serves both channels from one implementation),
 *               7.7 (the Chat_Service serves both channels from one implementation),
 *               16.1 (the Web_App and the WhatsApp_Adapter obtain every Diagnosis_Result from the
 *               Diagnosis_Service), 16.2 (…every chat answer from the Chat_Service),
 *               16.3 (exactly one implementation of the crop image analysis flow),
 *               16.4 (exactly one implementation of the Knowledge_Base grounding and rephrasing
 *               flow)
 * Design: "Static architecture check (CI)" — *"exactly one `DiagnosisService` module and one
 *         `ChatService` module exist; both the route handlers and the WhatsApp adapter import those
 *         modules rather than reimplementing image analysis, grounding, or rephrasing; and nothing
 *         under `src/services/**` or `src/lib/**` imports from `src/app/**`"*
 *
 * The no-training rule below traces to a different place in the spec, and the difference is worth
 * stating rather than glossing: the task lists Requirement 3.8 for it, but 3.8 is the
 * one-implementation clause. "Jamee performs no model training" is the requirements'
 * **Introduction** and **Release Acceptance step 8**, and design commitment 1 ("No model training,
 * no invented agronomy"). `tasks.md` 31.1 records that step 8's no-training half is asserted here
 * rather than at runtime, "since absence of a call is a codebase property".
 *
 * Wired into CI by task 28.6.
 *
 * Run it:  `npm run check:shared-implementation`  (exits 0 clean, 1 on any violation)
 *
 * =============================================================================
 * WHY THIS IS NOT A GREP — THE SAME REASON `check-secret-scope` ISN'T
 * =============================================================================
 *
 * Every identifier these rules look for is named more often in *prose* than in code. `rg
 * 'rephrasePrompt' src` finds one import and one call against a dozen sentences explaining which
 * module owns it. Worse, the naive spelling of the no-training rule — `rg train` — returns 90 hits
 * in this repository, **every one of them the word "constraint"**, and none of them a training call.
 *
 * So, as in `check-secret-scope`, every rule runs against a **comment-blanked** copy of each file:
 * comments become spaces, byte for byte, so reported line numbers are the real ones while a
 * sentence about `CLASSIFICATION_PROMPT` can no longer masquerade as an import of it. String and
 * template literals are kept — `from '@/services/diagnosis.service'` is a string-literal-carrying
 * fact these rules exist to read. `.sql` files get `--` blanking too, since the migrations are
 * mostly commentary.
 *
 * =============================================================================
 * THE SEVEN ASSERTIONS
 * =============================================================================
 *
 * 1. **`service-module`** — each service entry point is exported by exactly one module under
 *    `src/**`, and it is the expected module. Zero exporters fails as loudly as two: a renamed
 *    entry point would otherwise turn assertions 2 and 4 vacuous rather than red.
 *
 * 2. **`channel-entry`** — every channel entry point *imports* the shared service it must use.
 *    This is Requirements 16.1 and 16.2 read as a fact about the module graph rather than as an
 *    intention.
 *
 * 3. **`seam-type`** — the WhatsApp adapter's three dispatch seams are typed as the service
 *    functions themselves (`typeof diagnose`, `typeof transcribeAndAnswer`, `ChatAnswerer`). Its own
 *    header says why this is checkable: *"a parallel implementation would have to change these types
 *    to exist, which is what task 27.3's static architecture check looks for."*
 *
 * 4. **`seam-definition`** — each flow seam symbol (the classification prompt, the vision response
 *    schema, the raw-vision parse, the rephrase and chat prompts, the rephrase validator, the static
 *    fallback, the knowledge lookup and scope resolution) is exported by exactly one module, at its
 *    recorded home. This is 16.3 and 16.4 stated directly: a second `export function rephrasePrompt`
 *    anywhere in `src/**` **is** a second grounding implementation.
 *
 * 5. **`seam-consumer`** — only a recorded owner may import a flow seam from its defining module.
 *    A route handler or the WhatsApp adapter reaching for `CLASSIFICATION_PROMPT` is the drift
 *    Requirement 16.3 forbids, caught at the import rather than after the second copy is written.
 *
 * 6. **`layering`** — nothing under `src/services/**` or `src/lib/**` imports from `src/app/**`.
 *    The design calls this the rule "that keeps the first two true as the codebase grows", and it
 *    is the only rule here that needs no allowlist: the direction is simply one-way.
 *
 * 7. **`no-training`** — no training or fine-tuning call anywhere in the scanned codebase, and no
 *    training-capable dependency in `package.json`.
 *
 * =============================================================================
 * THE ONE-WAY RULE HAS A LEGITIMATE-LOOKING NEAR-MISS. IT IS NOT A VIOLATION
 * =============================================================================
 *
 * `src/app/diagnosis/detail.ts` holds screen-local decisions — which fields the detail view shows,
 * how it degrades a row it cannot classify — and lives under `src/app/**` on purpose, because
 * nothing outside that screen reads them (`src/lib/history.ts` says so in its own header). It is
 * imported by `src/app/diagnosis/[id]/page.tsx` and by its own test, both inside `src/app/**`.
 *
 * That direction is fine, and this rule does not look at it. **`src/app/**` may import anything.**
 * What assertion 6 forbids is the reverse: a shared module reaching *up* into a screen. Verified
 * against the real tree, there is no such import today — `src/lib/**` and `src/services/**` name
 * `src/app/diagnosis/detail.ts` only in sentences, which is exactly the case comment blanking
 * exists to tell apart from an import.
 *
 * =============================================================================
 * WHAT THE NO-TRAINING RULE PROVES, AND WHAT IT CANNOT — READ BEFORE TRUSTING IT
 * =============================================================================
 *
 * A static scan cannot prove a negative about behaviour. It can only prove that the *named*
 * surfaces through which training happens do not appear. Four honest limits:
 *
 *  - **It is a denylist.** `TRAINING_CALL_PATTERNS` enumerates the surfaces of the two SDKs this
 *    codebase actually depends on (`@google/genai`, `groq-sdk`) plus the OpenAI-compatible
 *    `fineTuning` shape Groq's API mirrors. A training endpoint reached by hand-rolled `fetch` to a
 *    URL assembled at runtime would not match, and neither would a provider surface invented after
 *    this list was written.
 *  - **It says nothing about the models themselves.** That Gemini and Groq do not train on Jamee's
 *    requests is a *provider* property, recorded in `docs/PROVIDER_CAPABILITIES.md`, not something
 *    any amount of source scanning can establish.
 *  - **Two files are exempt, by exact path, and both are printed as notes on every run**:
 *    this script and its test. A guard that enumerates forbidden identifiers has to be allowed to
 *    spell them, and a test that pins each catch case has to contain a fixture that trips it.
 *    Nothing else is exempt — including ordinary `*.test.ts` modules, because a training call in a
 *    test is still a training call in the codebase.
 *  - **`docs/**` and `.kiro/**` are not scanned.** They are prose, and their prose says "no model
 *    training" — scanning them would report the sentence that states the rule as a breach of it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ========================================================================== */
/* The facts the rules are written against                                     */
/* ========================================================================== */

/**
 * The service entry points, each with the one module that may export it.
 *
 * Taken from the code that exists, not from the design sentence: `chatTurn` (the composed turn the
 * web route calls), `chatAnswerer` (the same turn bound for a caller that supplies its own
 * credential — the voice route and the WhatsApp adapter) and `answerQuestion` (the ungrounded inner
 * step) are three names for one ChatService, and all three must stay in one module or "one
 * implementation" stops meaning anything.
 */
export interface ServiceEntryPoint {
  /** The exported symbol. */
  readonly name: string;
  /** The only module under `src/**` allowed to export it. */
  readonly module: string;
  /** Which of the two services the design names this belongs to. */
  readonly service: 'DiagnosisService' | 'ChatService' | 'VoiceService';
}

export const SERVICE_ENTRY_POINTS: readonly ServiceEntryPoint[] = [
  { name: 'diagnose', module: 'src/services/diagnosis.service.ts', service: 'DiagnosisService' },
  { name: 'chatTurn', module: 'src/services/chat.service.ts', service: 'ChatService' },
  { name: 'chatAnswerer', module: 'src/services/chat.service.ts', service: 'ChatService' },
  { name: 'answerQuestion', module: 'src/services/chat.service.ts', service: 'ChatService' },
  /**
   * The VoiceService is not one of the design's two "exactly one" claims, but it is the third thing
   * the WhatsApp adapter dispatches to, and Requirement 8.4 routes its transcript *into* the
   * ChatService. If `transcribeAndAnswer` ever forked, the ChatService would be reached twice by two
   * different paths, so it is pinned here too.
   */
  {
    name: 'transcribeAndAnswer',
    module: 'src/services/voice.service.ts',
    service: 'VoiceService',
  },
];

/**
 * Every module that is a *channel* entry point, with the shared imports it must carry.
 *
 * A missing file is a **violation**, not a skip. A route renamed or moved without this table being
 * updated would otherwise silently stop being checked, which is the failure mode that makes a
 * green architecture gate worse than none.
 */
export interface ChannelEntryPoint {
  readonly path: string;
  readonly channel: 'web' | 'whatsapp';
  /** Specifier → the names that must be imported from it. */
  readonly requires: readonly { readonly module: string; readonly names: readonly string[] }[];
  readonly why: string;
}

export const CHANNEL_ENTRY_POINTS: readonly ChannelEntryPoint[] = [
  {
    path: 'src/app/api/diagnose/route.ts',
    channel: 'web',
    requires: [{ module: 'src/services/diagnosis.service.ts', names: ['diagnose'] }],
    why: 'Requirement 16.1 — the web channel obtains every Diagnosis_Result from the DiagnosisService',
  },
  {
    path: 'src/app/api/chat/route.ts',
    channel: 'web',
    requires: [{ module: 'src/services/chat.service.ts', names: ['chatTurn'] }],
    why: 'Requirement 16.2 — the web channel obtains every chat answer from the ChatService',
  },
  {
    path: 'src/app/api/voice/route.ts',
    channel: 'web',
    requires: [
      { module: 'src/services/voice.service.ts', names: ['transcribeAndAnswer'] },
      /**
       * Requirement 8.4: the transcript is passed to the ChatService as a Farmer message. The route
       * binds `chatAnswerer` and hands it to the VoiceService rather than the VoiceService reaching
       * for the ChatService itself, so the credential stays with the caller.
       */
      { module: 'src/services/chat.service.ts', names: ['chatAnswerer'] },
    ],
    why: 'Requirements 16.2 and 8.4 — a voice question is answered by the same ChatService',
  },
  {
    path: 'src/app/api/whatsapp/route.ts',
    channel: 'whatsapp',
    /**
     * The webhook admits a delivery and hands it on; it imports the *adapter*, not the services.
     * That is the seam the route's own header defends ("nothing in it that decides anything a farmer
     * sees"), so requiring a service import here would be requiring the wrong shape.
     */
    requires: [{ module: 'src/lib/whatsapp-dispatch.ts', names: ['processInboundBatch'] }],
    why: 'Requirement 10.11 — the webhook hands every admitted delivery to the one adapter pipeline',
  },
  {
    path: 'src/lib/whatsapp-dispatch.ts',
    channel: 'whatsapp',
    requires: [
      { module: 'src/services/diagnosis.service.ts', names: ['diagnose'] },
      { module: 'src/services/chat.service.ts', names: ['chatAnswerer'] },
      { module: 'src/services/voice.service.ts', names: ['transcribeAndAnswer'] },
    ],
    why: 'Requirements 16.1 and 16.2 — the WhatsApp adapter calls the shared services, not its own',
  },
];

/**
 * The dispatch seams the WhatsApp adapter must express in terms of the service functions.
 *
 * This is the one assertion written *because a source file asked for it*. `whatsapp-dispatch.ts`
 * §"REQUIREMENT 16 IS SATISFIED BY IMPORTS, NOT BY DISCIPLINE" types its three seams as the service
 * functions rather than as hand-written shapes precisely so a static check has something structural
 * to hold on to. Hand-writing a compatible interface is how a parallel implementation would begin,
 * and it would pass assertion 2 (the import would still be there, unused) while failing this one.
 */
export interface SeamTypeAssertion {
  readonly path: string;
  readonly alias: string;
  readonly pattern: RegExp;
  readonly expected: string;
  readonly why: string;
}

export const SEAM_TYPE_ASSERTIONS: readonly SeamTypeAssertion[] = [
  {
    path: 'src/lib/whatsapp-dispatch.ts',
    alias: 'WhatsappDiagnosisService',
    pattern: /\bWhatsappDiagnosisService\s*=\s*typeof\s+diagnose\b/,
    expected: 'typeof diagnose',
    why: 'the image seam is the DiagnosisService function itself, so no parallel shape can satisfy it',
  },
  {
    path: 'src/lib/whatsapp-dispatch.ts',
    alias: 'WhatsappVoiceService',
    pattern: /\bWhatsappVoiceService\s*=\s*typeof\s+transcribeAndAnswer\b/,
    expected: 'typeof transcribeAndAnswer',
    why: 'the audio seam is the VoiceService function itself',
  },
  {
    path: 'src/lib/whatsapp-dispatch.ts',
    alias: 'WhatsappChatService',
    /**
     * `ChatAnswerer` rather than `typeof chatTurn`: the type is declared by
     * `src/services/voice.service.ts` for its own nested call and imported here, so there is one
     * definition of "the composed ChatService" instead of two spellings of it.
     */
    pattern: /\bWhatsappChatService\s*=\s*ChatAnswerer\b/,
    expected: 'ChatAnswerer',
    why: 'the text seam is the composed ChatService type the VoiceService already declares',
  },
];

/**
 * The flow seams: the symbols that *are* the image-analysis flow and the grounding/rephrasing flow.
 *
 * `definedIn` is the "exactly one implementation" claim (assertion 4). `consumers` is who may
 * import it (assertion 5) — enumerated from the tree that exists, each with the reason it is a
 * legitimate consumer rather than a second implementation. Test modules are implicitly allowed and
 * are not listed; every other importer must appear here or the run fails.
 */
export interface FlowSeam {
  readonly name: string;
  readonly flow: 'image-analysis' | 'grounding-rephrasing';
  readonly definedIn: string;
  readonly consumers: readonly string[];
  readonly why: string;
}

export const FLOW_SEAMS: readonly FlowSeam[] = [
  /* ── Requirement 16.3 — the crop image analysis flow ───────────────────── */
  {
    name: 'CLASSIFICATION_PROMPT',
    flow: 'image-analysis',
    definedIn: 'src/lib/prompts.ts',
    consumers: ['src/services/diagnosis.service.ts'],
    why: 'the five-name-only classification request; a second caller is a second analysis flow',
  },
  {
    name: 'VISION_RESPONSE_JSON_SCHEMA',
    flow: 'image-analysis',
    definedIn: 'src/lib/prompts.ts',
    consumers: ['src/services/diagnosis.service.ts'],
    why: 'the request-side schema that makes the classification constrained rather than requested',
  },
  {
    name: 'visionRawSchema',
    flow: 'image-analysis',
    definedIn: 'src/lib/schemas.ts',
    consumers: [
      /** `prompts.ts` cross-checks the JSON Schema against it so the two cannot drift. */
      'src/lib/prompts.ts',
      'src/services/diagnosis.service.ts',
    ],
    why: 'stage-1 validation of a model response (Requirement 5.1)',
  },
  {
    name: 'interpret',
    flow: 'image-analysis',
    definedIn: 'src/services/diagnosis.service.ts',
    consumers: [],
    why: 'raw model text → Interpretation; internal to the service and imported by nothing',
  },

  /* ── Requirement 16.4 — the grounding and rephrasing flow ──────────────── */
  {
    name: 'rephrasePrompt',
    flow: 'grounding-rephrasing',
    definedIn: 'src/lib/prompts.ts',
    consumers: ['src/services/diagnosis.service.ts'],
    why: 'the rephrase-only-what-is-supplied request for a diagnosis explanation (Requirement 4.5)',
  },
  {
    name: 'chatPrompt',
    flow: 'grounding-rephrasing',
    definedIn: 'src/lib/prompts.ts',
    consumers: ['src/services/chat.service.ts'],
    why: 'the same rephrase-only contract for a chat answer (Requirement 4.4)',
  },
  {
    name: 'validateRephrased',
    flow: 'grounding-rephrasing',
    definedIn: 'src/lib/prompts.ts',
    consumers: ['src/services/diagnosis.service.ts', 'src/services/chat.service.ts'],
    why: 'the gate that rejects model text carrying content the knowledge base did not supply',
  },
  {
    name: 'staticExplanationFor',
    flow: 'grounding-rephrasing',
    definedIn: 'src/lib/prompts.ts',
    consumers: ['src/services/diagnosis.service.ts', 'src/services/chat.service.ts'],
    why: 'the knowledge-base-only fallback used when a rephrase is rejected or unavailable',
  },
  {
    name: 'lookupCondition',
    flow: 'grounding-rephrasing',
    definedIn: 'src/lib/knowledge.ts',
    consumers: [
      'src/services/diagnosis.service.ts',
      /**
       * The detail screen, and the first thing this rule caught. It is a consumer, not a second
       * implementation, and the distinction is the whole point of Requirement 16.4.
       *
       * `diagnoses` stores the disease name and the explanation the service already grounded; it
       * does **not** store the symptom / cause / treatment / prevention arrays. So Requirement
       * 12.3's detail view has to read the row itself, and it does that by calling this shared
       * lookup — no second query, no second knowledge model, no rephrasing. The screen composes no
       * agronomic sentence: `GroundedSections` renders the arrays verbatim (Requirement 4.3), which
       * is why an empty `treatment` for `Tomato Healthy` renders as no section rather than as
       * invented text.
       */
      'src/app/diagnosis/[id]/page.tsx',
    ],
    why: 'canonical name → the one verified row every diagnosis sentence is composed from',
  },
  {
    name: 'resolveScope',
    flow: 'grounding-rephrasing',
    definedIn: 'src/lib/knowledge.ts',
    consumers: ['src/services/chat.service.ts'],
    why: 'question → the verified rows in scope, or the referral branch (Requirements 4.7, 7.6)',
  },
  {
    name: 'knowledgePayloadOf',
    flow: 'grounding-rephrasing',
    definedIn: 'src/lib/knowledge.ts',
    consumers: [
      'src/services/diagnosis.service.ts',
      /** Same screen, same reason: it renders the payload, it does not compose one. */
      'src/app/diagnosis/[id]/page.tsx',
    ],
    why: 'the row reduced to what a farmer may be shown, in one place',
  },
];

/**
 * The two directories whose modules may not import from `src/app/**`.
 *
 * `src/components/**` is deliberately absent: a component is part of the app shell, and a component
 * importing a screen helper is a UI question rather than a layering breach. `src/types/**` is absent
 * because it imports nothing.
 */
export const SHARED_LAYER_ROOTS = ['src/lib/', 'src/services/'] as const;

/** The directory a shared module may not reach into. */
export const APP_LAYER_ROOT = 'src/app/';

/**
 * Training and fine-tuning surfaces, as identifiers rather than as words.
 *
 * Every pattern is anchored on a word boundary, because the *substring* spellings are unusable
 * here: `train` appears 90 times in this repository and every occurrence is "constraint".
 *
 * The list covers the two SDKs in `package.json` and the OpenAI-compatible shape Groq's REST API
 * mirrors. It is a denylist, and the module header says what that costs.
 */
export interface TrainingPattern {
  readonly id: string;
  readonly pattern: RegExp;
  readonly surface: string;
}

export const TRAINING_CALL_PATTERNS: readonly TrainingPattern[] = [
  {
    id: 'fine-tuning',
    pattern: /\bfine[_-]?tun(e|ed|es|ing)\b/i,
    surface: "any fine-tuning surface: fineTuning, fine_tuning, purpose: 'fine-tune'",
  },
  {
    id: 'genai-tunings',
    /**
     * Case-insensitive on purpose. The first spelling of this pattern was case-sensitive and missed
     * `tunedModels` — the actual camelCase name in `@google/genai` — while matching the snake_case
     * spelling nobody writes in TypeScript. There is no identifier in this codebase that a
     * case-insensitive `tunings` or `tunedModel` could collide with.
     */
    pattern: /\btunings\b|\btuned[_-]?models?\b|\btuning[_-]?jobs?\b/i,
    surface: '@google/genai model tuning: ai.tunings.tune(), tunedModels, TuningJob',
  },
  {
    id: 'training-job',
    pattern: /\btraining[_-]?(job|data|file|set|run)s?\b|\btrainModel\b|\bcreateTrainingJob\b/i,
    surface: 'a training job, its data, or its file',
  },
  {
    id: 'train-call',
    pattern: /\.\s*(train|fit)\s*\(/,
    surface: 'a .train() or .fit() call — the local-training shape',
  },
  {
    id: 'training-loop',
    /**
     * Compounds only, never the bare words. `\bepochs?\b` was the first spelling of this pattern
     * and it was wrong for this codebase: every deadline in `gateway.ts`,
     * `whatsapp-dispatch.ts` and the three services is documented as "epoch ms", so the rule would
     * have fired twelve times on the clock arithmetic that makes Requirement 10.10 hold. Same for a
     * bare `gradient`, which `\b` would find inside `linear-gradient` in any style value.
     */
    pattern:
      /\blearning[_-]?rate\b|\bnum[_-]?epochs?\b|\bepoch[_-]?count\b|\bloss[_-]?function\b|\bmodel[_-]?checkpoints?\b|\bbackprop\w*\b/i,
    surface: 'training-loop configuration: learning rate, epoch count, loss function, checkpoints',
  },
];

/** Packages that exist to train models. A denylist, for the reason the header gives. */
export const TRAINING_PACKAGE_PATTERNS: readonly RegExp[] = [
  /^@tensorflow\//,
  /^onnxruntime/,
  /^@huggingface\//,
  /^brain\.js$/,
  /^synaptic$/,
  /^convnetjs$/,
  /^ml5$/,
  /^keras/,
  /^(py)?torch/,
];

/**
 * The only two files exempt from the no-training scan, by exact path.
 *
 * A guard that enumerates forbidden identifiers must be able to spell them, and its test must be
 * able to contain a fixture that trips each rule. Both are printed as notes on every run so the
 * exemption is visible rather than assumed, and the list is closed: no `*.test.ts` glob, no
 * directory, no pattern.
 */
export const TRAINING_SCAN_EXEMPT = [
  'scripts/check-shared-implementation.ts',
  'tests/unit/check-shared-implementation.test.ts',
] as const;

/* ========================================================================== */
/* Findings                                                                    */
/* ========================================================================== */

export type RuleId =
  | 'service-module'
  | 'channel-entry'
  | 'seam-type'
  | 'seam-definition'
  | 'seam-consumer'
  | 'layering'
  | 'no-training';

/** `violation` fails the run. `note` does not — it is how an exemption gets printed. */
export type Severity = 'violation' | 'note';

export interface Finding {
  readonly rule: RuleId;
  readonly severity: Severity;
  readonly path: string;
  readonly line: number;
  readonly message: string;
  readonly excerpt: string;
}

export interface SourceFile {
  /** Repository-relative, POSIX separators, so reports are platform-independent. */
  readonly path: string;
  readonly source: string;
}

export interface Report {
  readonly findings: readonly Finding[];
  readonly scannedModules: number;
  readonly scannedCodebaseFiles: number;
  /** Seam consumers listed here that no longer import the seam. Drift, not danger. */
  readonly staleSeamConsumers: readonly string[];
}

/* ========================================================================== */
/* Comment blanking                                                            */
/* ========================================================================== */

const REGEX_MAY_START_AFTER = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<',
  '>', '\n',
]);

const REGEX_MAY_START_AFTER_KEYWORD =
  /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;

/**
 * Replace every comment with spaces, keeping length, newlines, and therefore every line number.
 *
 * The same scanner as `check-secret-scope`'s, deliberately: it has already been through the
 * template-literal regression that made an earlier version lose a closing backtick and mis-scan
 * 500 lines of a real module. Duplicating it rather than importing it keeps each guard a
 * self-contained file that CI can run on its own, and the shared behaviour is pinned by both test
 * suites.
 *
 * String and template literals survive, because `from '@/services/chat.service'` is the fact these
 * rules read. Regular-expression literals survive too, and that is load-bearing here: the
 * no-training patterns in *this* file are regex literals, which is why this file is on
 * `TRAINING_SCAN_EXEMPT`.
 */
export function blankComments(source: string): string {
  const out = source.split('');
  let index = 0;
  let lastMeaningful = '\n';

  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (char === "'" || char === '"') {
      index = skipQuoted(source, index, char);
      lastMeaningful = char;
      continue;
    }
    if (char === '`') {
      index = skipTemplateLiteral(source, index);
      lastMeaningful = '`';
      continue;
    }
    if (char === '/' && canStartRegex(lastMeaningful, source, index)) {
      index = skipRegex(source, index);
      lastMeaningful = '/';
      continue;
    }

    if (char === '\n') lastMeaningful = '\n';
    else if (!/\s/.test(char)) lastMeaningful = char;
    index += 1;
  }

  return out.join('');
}

/**
 * The SQL dialect of the same idea: `--` line comments as well as block comments.
 *
 * Migration files are more commentary than DDL — `0005_diagnoses.sql` explains each check
 * constraint at length — so scanning them raw would make the no-training rule an essay reader.
 * Dollar-quoted bodies (`$$ … $$`, used by the `counter_*` functions in `0007`) are skipped whole
 * for the same reason template literals are: a partial skip that loses its place is worse than no
 * skip at all.
 */
export function blankSqlComments(source: string): string {
  const out = source.split('');
  let index = 0;

  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '-' && next === '-') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "'") {
      index = skipQuoted(source, index, "'");
      continue;
    }
    if (char === '$' && next === '$') {
      const end = source.indexOf('$$', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    index += 1;
  }

  return out.join('');
}

/** Blank comments the way this file's extension requires. */
export function blankFor(file: SourceFile): string {
  return file.path.endsWith('.sql') ? blankSqlComments(file.source) : blankComments(file.source);
}

function skipQuoted(source: string, openIndex: number, quote: string): number {
  let i = openIndex + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === quote || char === '\n') return i + 1;
    i += 1;
  }
  return i;
}

function skipTemplateLiteral(source: string, openIndex: number): number {
  let i = openIndex + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '`') return i + 1;
    if (char === '$' && source[i + 1] === '{') {
      i = skipTemplateHole(source, i + 2);
      continue;
    }
    i += 1;
  }
  return i;
}

function skipTemplateHole(source: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      i = skipQuoted(source, i, char);
      continue;
    }
    if (char === '`') {
      i = skipTemplateLiteral(source, i);
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

function skipRegex(source: string, openIndex: number): number {
  let i = openIndex + 1;
  let inClass = false;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '\n') return i;
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) return i + 1;
    i += 1;
  }
  return i;
}

function canStartRegex(lastMeaningful: string, source: string, index: number): boolean {
  if (REGEX_MAY_START_AFTER.has(lastMeaningful)) return true;
  return REGEX_MAY_START_AFTER_KEYWORD.test(source.slice(Math.max(0, index - 24), index).trimEnd());
}

/* ========================================================================== */
/* Small helpers                                                               */
/* ========================================================================== */

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function lineText(source: string, offset: number): string {
  const start = source.lastIndexOf('\n', offset) + 1;
  const end = source.indexOf('\n', offset);
  return source.slice(start, end === -1 ? source.length : end).trim();
}

export function isTestModule(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
}

/** `src/lib/x.ts` and `src/lib/x` compare equal, and so do `src/lib/x/index.ts` and `src/lib/x`. */
export function moduleKey(path: string): string {
  const withoutExtension = path.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
  return withoutExtension.replace(/\/index$/, '');
}

/* ========================================================================== */
/* Imports and exports                                                         */
/* ========================================================================== */

export interface ImportStatement {
  /** As written: `@/services/chat.service`, `./detail`, `server-only`. */
  readonly specifier: string;
  /** Named and default bindings, aliases resolved to the **source** name. */
  readonly names: readonly string[];
  /** `import * as ns from …`, which hides every name behind one binding. */
  readonly namespace: boolean;
  readonly offset: number;
}

/**
 * Every import and re-export in a blanked module.
 *
 * The clause between `import`/`export` and `from` is matched as `[^;=]*?` rather than `[\s\S]*?`,
 * and that restriction is not cosmetic. An import clause never contains `;` or `=`; a *declaration*
 * always does. Without it, `export type WhatsappChatService = ChatAnswerer;` — a statement this
 * codebase has three of in one file — lets the non-greedy match run forward to the next module's
 * `from`, and the result is an import attributed to the wrong specifier.
 *
 * Side-effect imports (`import 'server-only'`), dynamic `import()` and `require()` are collected
 * too. They carry no names, but the layering rule reads specifiers, and a dynamic import into
 * `src/app/**` from a shared module would be the same breach as a static one.
 */
export function extractImports(blanked: string): ImportStatement[] {
  const statements: ImportStatement[] = [];

  const withClause = /(?:^|\n)[ \t]*(?:import|export)\b([^;=]*?)\bfrom\s*(['"])([^'"\n]+)\2/g;
  for (const match of blanked.matchAll(withClause)) {
    const clause = match[1];
    const specifier = match[3];
    if (clause === undefined || specifier === undefined) continue;
    const parsed = parseImportClause(clause);
    statements.push({ specifier, ...parsed, offset: match.index });
  }

  const sideEffect = /(?:^|\n)[ \t]*import\s*(['"])([^'"\n]+)\1/g;
  for (const match of blanked.matchAll(sideEffect)) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    statements.push({ specifier, names: [], namespace: false, offset: match.index });
  }

  const deferred = /\b(?:import|require)\(\s*(['"])([^'"\n]+)\1/g;
  for (const match of blanked.matchAll(deferred)) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    statements.push({ specifier, names: [], namespace: false, offset: match.index });
  }

  return statements.sort((a, b) => a.offset - b.offset);
}

/** `type { a, b as c }` → `['a', 'b']`. `* as ns` → `namespace: true`. */
export function parseImportClause(clause: string): { names: string[]; namespace: boolean } {
  const withoutTypeKeyword = clause.replace(/^\s*type\b/, ' ');
  const namespace = /\*\s*as\s+[A-Za-z_$][\w$]*/.test(withoutTypeKeyword);

  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(withoutTypeKeyword);
  if (braces?.[1] !== undefined) {
    for (const raw of braces[1].split(',')) {
      const source = raw.replace(/^\s*type\b/, '').split(/\bas\b/)[0]?.trim();
      if (source !== undefined && /^[A-Za-z_$][\w$]*$/.test(source)) names.push(source);
    }
  }

  const outside = withoutTypeKeyword
    .replace(/\{[^}]*\}/g, '')
    .replace(/\*\s*as\s+[A-Za-z_$][\w$]*/g, '');
  for (const raw of outside.split(',')) {
    const token = raw.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(token)) names.push(token);
  }

  return { names, namespace };
}

/**
 * `@/x` → `src/x`; `./x` and `../x` → resolved against the importing module's directory.
 *
 * `null` for a bare package specifier, which no rule here has an opinion about.
 */
export function resolveSpecifier(fromPath: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return `src/${specifier.slice(2)}`;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;

  const base = fromPath.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') base.pop();
    else base.push(segment);
  }
  return base.join('/');
}

/**
 * Every name a blanked module exports, declarations and re-export clauses alike.
 *
 * Read on the blanked source, so the sentence *"`validateRephrased()` is what happens when this
 * instruction is not followed"* in `prompts.ts` cannot register as a second export of it.
 */
export function exportedNames(blanked: string): Set<string> {
  const names = new Set<string>();

  const declaration =
    /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class|interface|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of blanked.matchAll(declaration)) {
    if (match[1] !== undefined) names.add(match[1]);
  }

  for (const match of blanked.matchAll(/\bexport\s+type\s+([A-Za-z_$][\w$]*)/g)) {
    if (match[1] !== undefined) names.add(match[1]);
  }

  /* `export { a, b as c }` — the exported name is the alias when there is one. */
  for (const match of blanked.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    const body = match[1];
    if (body === undefined) continue;
    for (const raw of body.split(',')) {
      const parts = raw.replace(/^\s*type\b/, '').split(/\bas\b/);
      const exported = (parts[1] ?? parts[0])?.trim();
      if (exported !== undefined && /^[A-Za-z_$][\w$]*$/.test(exported)) names.add(exported);
    }
  }

  return names;
}

/* ========================================================================== */
/* Assertion 1 — one module per service entry point                            */
/* ========================================================================== */

/**
 * Each service entry point is exported by exactly one non-test module, and it is the expected one.
 *
 * Whole-tree rather than per-file, because "exactly one" is not a property any single file has.
 * Zero exporters is a violation for the reason a missing channel entry point is: a rename that
 * nobody noticed would leave assertions 2 and 5 checking for a symbol that no longer exists, and
 * they would pass by having nothing to say.
 */
export function checkServiceModules(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  const exportsByModule = new Map<string, Set<string>>();

  for (const file of files) {
    if (isTestModule(file.path)) continue;
    exportsByModule.set(file.path, exportedNames(blankComments(file.source)));
  }

  for (const entry of SERVICE_ENTRY_POINTS) {
    const exporters = [...exportsByModule]
      .filter(([, names]) => names.has(entry.name))
      .map(([path]) => path)
      .sort();

    if (exporters.length === 0) {
      findings.push({
        rule: 'service-module',
        severity: 'violation',
        path: entry.module,
        line: 1,
        message:
          `No module under src/ exports '${entry.name}', the ${entry.service} entry point. Either ` +
          'it was renamed — in which case update SERVICE_ENTRY_POINTS, because the import and seam ' +
          'assertions are now checking for a symbol that does not exist — or the service is gone.',
        excerpt: '',
      });
      continue;
    }

    if (exporters.length > 1) {
      for (const path of exporters) {
        findings.push({
          rule: 'service-module',
          severity: 'violation',
          path,
          line: 1,
          message:
            `'${entry.name}' is exported by ${exporters.length} modules (${exporters.join(', ')}). ` +
            `Requirements 3.8 / 7.7 / 16.1 / 16.2 want one ${entry.service}; two exporters of its ` +
            'entry point is two implementations, whichever one each caller happens to reach.',
          excerpt: '',
        });
      }
      continue;
    }

    const only = exporters[0];
    if (only !== entry.module) {
      findings.push({
        rule: 'service-module',
        severity: 'violation',
        path: only ?? entry.module,
        line: 1,
        message:
          `'${entry.name}' is exported by ${only}, but the ${entry.service} lives at ` +
          `${entry.module}. Move it back, or update SERVICE_ENTRY_POINTS and the seam tables that ` +
          'name the old path.',
        excerpt: '',
      });
    }
  }

  return findings;
}

/* ========================================================================== */
/* Assertion 2 — every channel entry point imports the shared service          */
/* ========================================================================== */

/**
 * Requirements 16.1 and 16.2 as a fact about the import graph.
 *
 * An entry point in the table that is not in the tree is a violation, so a route that moves takes
 * the gate red with it instead of quietly leaving the channel unchecked.
 */
export function checkChannelEntryPoints(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  const byPath = new Map(files.map((file) => [file.path, file]));

  for (const entry of CHANNEL_ENTRY_POINTS) {
    const file = byPath.get(entry.path);

    if (file === undefined) {
      findings.push({
        rule: 'channel-entry',
        severity: 'violation',
        path: entry.path,
        line: 1,
        message:
          `Channel entry point ${entry.path} (${entry.channel}) is not in the tree. ${entry.why}. ` +
          'If it moved, update CHANNEL_ENTRY_POINTS — an entry point nobody checks is how the two ' +
          'channels drift apart.',
        excerpt: '',
      });
      continue;
    }

    const imports = extractImports(blankComments(file.source));

    for (const required of entry.requires) {
      const matching = imports.filter(
        (statement) =>
          moduleKey(resolveSpecifier(entry.path, statement.specifier) ?? '') ===
          moduleKey(required.module),
      );

      if (matching.length === 0) {
        findings.push({
          rule: 'channel-entry',
          severity: 'violation',
          path: entry.path,
          line: 1,
          message:
            `${entry.path} does not import ${required.module}. ${entry.why}. A channel that does ` +
            'not import the shared module is either reimplementing it or reaching it by a path ' +
            'this check cannot see.',
          excerpt: '',
        });
        continue;
      }

      if (matching.some((statement) => statement.namespace)) continue;

      const imported = new Set(matching.flatMap((statement) => statement.names));
      const missing = required.names.filter((name) => !imported.has(name));

      if (missing.length > 0) {
        const first = matching[0];
        findings.push({
          rule: 'channel-entry',
          severity: 'violation',
          path: entry.path,
          line: first === undefined ? 1 : lineOf(file.source, first.offset),
          message:
            `${entry.path} imports ${required.module} but not ${missing.join(', ')}. ${entry.why}.`,
          excerpt: first === undefined ? '' : lineText(file.source, first.offset),
        });
      }
    }
  }

  return findings;
}

/* ========================================================================== */
/* Assertion 3 — the WhatsApp adapter's seams are the service functions         */
/* ========================================================================== */

export function checkSeamTypes(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  const byPath = new Map(files.map((file) => [file.path, file]));

  for (const assertion of SEAM_TYPE_ASSERTIONS) {
    const file = byPath.get(assertion.path);

    if (file === undefined) {
      findings.push({
        rule: 'seam-type',
        severity: 'violation',
        path: assertion.path,
        line: 1,
        message: `${assertion.path} is not in the tree, so its dispatch seams cannot be checked.`,
        excerpt: '',
      });
      continue;
    }

    if (assertion.pattern.test(blankComments(file.source))) continue;

    findings.push({
      rule: 'seam-type',
      severity: 'violation',
      path: assertion.path,
      line: 1,
      message:
        `${assertion.alias} is no longer declared as '${assertion.expected}'. ${assertion.why}. ` +
        "This file's own header calls that out: Requirement 16 is satisfied by imports, not by " +
        'discipline — a hand-written compatible shape here is where a parallel implementation ' +
        'starts, and it would still satisfy the import check.',
      excerpt: '',
    });
  }

  return findings;
}

/* ========================================================================== */
/* Assertion 4 — one definition per flow seam                                  */
/* ========================================================================== */

/**
 * Requirements 16.3 and 16.4 at their most direct: each seam symbol is exported once, from the
 * module that owns it.
 *
 * Matched by exported **name**. That is the limit of this rule and it cuts both ways: a second
 * `export function rephrasePrompt` is caught wherever it appears, and an unrelated future export
 * that happens to share a seam name is a false positive. `interpret` is the one seam here generic
 * enough for that to be plausible; the fix in that case is a rename or a seam-table entry, not a
 * looser rule.
 */
export function checkSeamDefinitions(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  const exportsByModule = new Map<string, Set<string>>();

  for (const file of files) {
    if (isTestModule(file.path)) continue;
    exportsByModule.set(file.path, exportedNames(blankComments(file.source)));
  }

  for (const seam of FLOW_SEAMS) {
    const exporters = [...exportsByModule]
      .filter(([, names]) => names.has(seam.name))
      .map(([path]) => path)
      .sort();

    if (exporters.length === 0) {
      findings.push({
        rule: 'seam-definition',
        severity: 'violation',
        path: seam.definedIn,
        line: 1,
        message:
          `No module exports '${seam.name}' — the ${seam.flow} seam recorded at ${seam.definedIn} ` +
          `(${seam.why}). A seam that no longer exists makes the consumer rule vacuous, so this ` +
          'fails rather than passes: update FLOW_SEAMS if the flow was reshaped.',
        excerpt: '',
      });
      continue;
    }

    if (exporters.length > 1) {
      for (const path of exporters) {
        findings.push({
          rule: 'seam-definition',
          severity: 'violation',
          path,
          line: 1,
          message:
            `'${seam.name}' is exported by ${exporters.length} modules (${exporters.join(', ')}). ` +
            `It is part of the ${seam.flow} flow, which Requirement ` +
            `${seam.flow === 'image-analysis' ? '16.3' : '16.4'} says exists exactly once.`,
          excerpt: '',
        });
      }
      continue;
    }

    const only = exporters[0];
    if (only !== seam.definedIn) {
      findings.push({
        rule: 'seam-definition',
        severity: 'violation',
        path: only ?? seam.definedIn,
        line: 1,
        message:
          `'${seam.name}' is exported by ${only}, but the ${seam.flow} flow puts it in ` +
          `${seam.definedIn}. Move it back, or update FLOW_SEAMS.`,
        excerpt: '',
      });
    }
  }

  return findings;
}

/* ========================================================================== */
/* Assertion 5 — only a recorded owner imports a flow seam                     */
/* ========================================================================== */

/**
 * A flow seam may be imported only by its recorded consumers, from its defining module.
 *
 * Two deliberate narrowings. The import must **resolve to the seam's defining module**, so an
 * unrelated `interpret` from a third-party package is not a false alarm. And a namespace import of
 * a seam-defining module is a violation in its own right: `import * as prompts from '@/lib/prompts'`
 * makes every seam in that module invisible to this rule, so the hole is closed at the import
 * rather than left to be found later.
 *
 * Test modules are exempt. A test importing `staticExplanationFor` to assert what the fallback
 * produces is reading the one implementation, not building a second.
 */
export function checkSeamConsumers(file: SourceFile, usedConsumers?: Set<string>): Finding[] {
  if (isTestModule(file.path)) return [];

  const findings: Finding[] = [];
  const seamModules = new Set(FLOW_SEAMS.map((seam) => moduleKey(seam.definedIn)));

  for (const statement of extractImports(blankComments(file.source))) {
    const resolved = resolveSpecifier(file.path, statement.specifier);
    if (resolved === null) continue;
    const target = moduleKey(resolved);
    if (target === moduleKey(file.path)) continue;

    if (statement.namespace && seamModules.has(target)) {
      findings.push({
        rule: 'seam-consumer',
        severity: 'violation',
        path: file.path,
        line: lineOf(file.source, statement.offset),
        message:
          `Namespace import of ${resolved}, which defines flow seams. A namespace binding hides ` +
          'which seams this module reaches, so the single-implementation rules cannot see it. ' +
          'Import the named symbols instead.',
        excerpt: lineText(file.source, statement.offset),
      });
      continue;
    }

    for (const name of statement.names) {
      const seam = FLOW_SEAMS.find(
        (candidate) => candidate.name === name && moduleKey(candidate.definedIn) === target,
      );
      if (seam === undefined) continue;

      const key = `${seam.name}::${file.path}`;
      if (seam.consumers.includes(file.path)) {
        usedConsumers?.add(key);
        continue;
      }

      findings.push({
        rule: 'seam-consumer',
        severity: 'violation',
        path: file.path,
        line: lineOf(file.source, statement.offset),
        message:
          `${file.path} imports '${seam.name}' from ${seam.definedIn}. That symbol is the ` +
          `${seam.flow} flow (${seam.why}), and Requirement ` +
          `${seam.flow === 'image-analysis' ? '16.3' : '16.4'} puts it in exactly one place: ` +
          `${seam.consumers.length === 0 ? 'nothing outside its own module' : seam.consumers.join(', ')}. ` +
          'Call the service instead, or add this module to the seam\'s consumers with the reason ' +
          'it is a consumer rather than a second implementation.',
        excerpt: lineText(file.source, statement.offset),
      });
    }
  }

  return findings;
}

/* ========================================================================== */
/* Assertion 6 — the one-way layering rule                                     */
/* ========================================================================== */

/**
 * Nothing under `src/services/**` or `src/lib/**` imports from `src/app/**`.
 *
 * The design calls this the rule that keeps the other two true as the codebase grows, and it needs
 * no allowlist: `src/app/**` may import a shared module freely, and a shared module may never
 * import a screen. `src/app/diagnosis/detail.ts` is the near-miss the header describes — screen-
 * local decisions living under `src/app/**` and imported only from that screen, which is the
 * permitted direction.
 *
 * A test module under a shared root gets a **note**, not a violation. It does not ship, so it
 * cannot make a shared module depend on a screen at runtime; printing it keeps the exemption
 * visible.
 */
export function checkLayering(file: SourceFile): Finding[] {
  if (!SHARED_LAYER_ROOTS.some((root) => file.path.startsWith(root))) return [];

  const findings: Finding[] = [];

  for (const statement of extractImports(blankComments(file.source))) {
    const resolved = resolveSpecifier(file.path, statement.specifier);
    if (resolved === null || !resolved.startsWith(APP_LAYER_ROOT)) continue;

    const line = lineOf(file.source, statement.offset);
    const excerpt = lineText(file.source, statement.offset);

    if (isTestModule(file.path)) {
      findings.push({
        rule: 'layering',
        severity: 'note',
        path: file.path,
        line,
        message:
          `A test under a shared root imports ${resolved}. Exempt: a test's import graph does not ` +
          'ship, so it cannot make a shared module depend on a screen at runtime.',
        excerpt,
      });
      continue;
    }

    findings.push({
      rule: 'layering',
      severity: 'violation',
      path: file.path,
      line,
      message:
        `${file.path} imports ${resolved}. The dependency between the shared layer and ` +
        `${APP_LAYER_ROOT} is one-way: screens import services and lib, never the reverse. This is ` +
        'the rule the design names as what keeps the single-implementation claims true as the ' +
        'codebase grows — move the shared part down into src/lib/ or src/services/.',
      excerpt,
    });
  }

  return findings;
}

/* ========================================================================== */
/* Assertion 7 — no training or fine-tuning call                               */
/* ========================================================================== */

/**
 * No training or fine-tuning surface appears in this file.
 *
 * Runs on the blanked source, which is the whole reason the rule is usable: the migrations and the
 * service headers are full of the word "constraint", and a substring match on `train` reports all
 * 90 of them.
 */
export function checkNoTraining(file: SourceFile): Finding[] {
  if ((TRAINING_SCAN_EXEMPT as readonly string[]).includes(file.path)) {
    return [
      {
        rule: 'no-training',
        severity: 'note',
        path: file.path,
        line: 1,
        message:
          'Exempt from the no-training scan: this file exists to enumerate the forbidden surfaces, ' +
          'so it has to be able to spell them. The exemption is by exact path and covers no other ' +
          'file, including other tests.',
        excerpt: '',
      },
    ];
  }

  const blanked = blankFor(file);
  const findings: Finding[] = [];

  for (const { id, pattern, surface } of TRAINING_CALL_PATTERNS) {
    const scanner = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of blanked.matchAll(scanner)) {
      findings.push({
        rule: 'no-training',
        severity: 'violation',
        path: file.path,
        line: lineOf(blanked, match.index),
        message:
          `'${match[0]}' matches the ${id} surface (${surface}). Jamee performs no model training: ` +
          'a general multimodal model classifies an image into one of five verified conditions, and ' +
          'the knowledge base supplies every agricultural fact (requirements Introduction, release ' +
          'acceptance step 8, design commitment 1).',
        excerpt: lineText(file.source, match.index),
      });
    }
  }

  return findings;
}

/** No dependency whose purpose is to train a model. */
export function checkTrainingDependencies(file: SourceFile): Finding[] {
  if (file.path !== 'package.json') return [];

  let manifest: { dependencies?: unknown; devDependencies?: unknown };
  try {
    manifest = JSON.parse(file.source) as typeof manifest;
  } catch (cause) {
    return [
      {
        rule: 'no-training',
        severity: 'violation',
        path: file.path,
        line: 1,
        message: `package.json is not valid JSON, so its dependencies cannot be checked: ${String(cause)}`,
        excerpt: '',
      },
    ];
  }

  const named = [manifest.dependencies, manifest.devDependencies]
    .filter((section): section is Record<string, unknown> => typeof section === 'object' && section !== null)
    .flatMap((section) => Object.keys(section));

  return named
    .filter((name) => TRAINING_PACKAGE_PATTERNS.some((pattern) => pattern.test(name)))
    .map((name) => ({
      rule: 'no-training' as const,
      severity: 'violation' as const,
      path: file.path,
      line: 1,
      message:
        `'${name}' is a model-training dependency. Jamee trains nothing; remove it, or if it is ` +
        'here for an unrelated reason, record that reason and narrow TRAINING_PACKAGE_PATTERNS.',
      excerpt: '',
    }));
}

/* ========================================================================== */
/* The run                                                                     */
/* ========================================================================== */

export interface RunInput {
  /** `.ts`/`.tsx` under `src/` — the module graph the architecture rules are about. */
  readonly modules: readonly SourceFile[];
  /** The wider codebase, for the no-training rule. Defaults to `modules`. */
  readonly codebase?: readonly SourceFile[];
}

export function runRules(input: RunInput): Report {
  const codebase = input.codebase ?? input.modules;
  const usedConsumers = new Set<string>();
  const findings: Finding[] = [];

  findings.push(...checkServiceModules(input.modules));
  findings.push(...checkChannelEntryPoints(input.modules));
  findings.push(...checkSeamTypes(input.modules));
  findings.push(...checkSeamDefinitions(input.modules));

  for (const file of input.modules) {
    findings.push(...checkSeamConsumers(file, usedConsumers));
    findings.push(...checkLayering(file));
  }

  for (const file of codebase) {
    findings.push(...checkNoTraining(file));
    findings.push(...checkTrainingDependencies(file));
  }

  const staleSeamConsumers = FLOW_SEAMS.flatMap((seam) =>
    seam.consumers.map((consumer) => `${seam.name}::${consumer}`),
  ).filter((key) => !usedConsumers.has(key));

  findings.sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule),
  );

  return {
    findings,
    scannedModules: input.modules.length,
    scannedCodebaseFiles: codebase.length,
    staleSeamConsumers,
  };
}

/** The module graph these rules are about. */
export const MODULE_ROOT = 'src';

/**
 * Directories the no-training scan does not enter.
 *
 * `docs` and `.kiro` are prose whose prose *states* the no-training rule, so scanning them would
 * report the sentence as a breach of itself. The rest are build output and vendored code.
 */
export const CODEBASE_SKIP_DIRECTORIES = [
  'node_modules',
  '.next',
  '.git',
  '.kiro',
  '.vercel',
  'docs',
  'coverage',
] as const;

/** Extensions the no-training scan reads. */
export const CODEBASE_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs|sql|json)$/;

/** Files skipped by name: generated, enormous, or both. */
export const CODEBASE_SKIP_FILES = ['package-lock.json', 'tsconfig.tsbuildinfo'] as const;

/**
 * The repository root, taken from the working directory.
 *
 * Not derived from `import.meta.url`, for the reason `check-secret-scope` records: this module is
 * also imported by `tests/unit`, where Vite serves it under a non-`file:` URL and `fileURLToPath`
 * throws. It is validated rather than assumed, so a run from the wrong directory says so instead of
 * reporting an empty, passing scan.
 */
export function repoRoot(): string {
  const root = resolve(process.cwd());
  if (!existsSync(join(root, MODULE_ROOT))) {
    throw new Error(
      `check-shared-implementation must run from the repository root: no ${MODULE_ROOT}/ under ${root}.`,
    );
  }
  return root;
}

const toPosix = (root: string, absolute: string): string =>
  relative(root, absolute).split(/[\\/]/).join('/');

/** Every `.ts`/`.tsx` module under `src/`. */
export function collectModules(root = repoRoot()): SourceFile[] {
  const base = join(root, MODULE_ROOT);
  return readdirSync(base, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      return { path: toPosix(root, absolute), source: readFileSync(absolute, 'utf8') };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The wider codebase the no-training rule scans: source, scripts, tests, migrations, manifests. */
export function collectCodebaseFiles(root = repoRoot()): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if ((CODEBASE_SKIP_DIRECTORIES as readonly string[]).includes(entry.name)) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if ((CODEBASE_SKIP_FILES as readonly string[]).includes(entry.name)) continue;
      if (!CODEBASE_EXTENSIONS.test(entry.name)) continue;
      files.push({ path: toPosix(root, absolute), source: readFileSync(absolute, 'utf8') });
    }
  };

  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const RULE_TITLES: Readonly<Record<RuleId, string>> = {
  'service-module': 'a service entry point is not exported by exactly one expected module',
  'channel-entry': 'a channel entry point does not import the shared service',
  'seam-type': "the WhatsApp adapter's dispatch seam is no longer the service function's type",
  'seam-definition': 'a flow seam is defined more than once, or not where it belongs',
  'seam-consumer': 'a flow seam is imported by a module that does not own it',
  layering: 'a shared module imports from src/app/**',
  'no-training': 'a training or fine-tuning surface appears in the codebase',
};

/** One block per finding, `path:line` first, so a CI log is greppable and clickable. */
export function formatReport(report: Report): string {
  const violations = report.findings.filter((f) => f.severity === 'violation');
  const notes = report.findings.filter((f) => f.severity === 'note');
  const lines: string[] = [];

  lines.push(
    'check-shared-implementation — Requirements 3.8, 7.7, 16.1–16.4, design "Static architecture check (CI)"',
  );
  lines.push(
    `scanned ${report.scannedModules} modules under ${MODULE_ROOT}/ for the architecture rules, ` +
      `${report.scannedCodebaseFiles} files for the no-training rule`,
  );
  lines.push('');

  if (violations.length > 0) {
    lines.push(`VIOLATIONS (${violations.length})`);
    lines.push('');
    for (const finding of violations) {
      lines.push(`  ${finding.path}:${finding.line}`);
      lines.push(`    rule: ${finding.rule} — ${RULE_TITLES[finding.rule]}`);
      lines.push(`    ${finding.message}`);
      if (finding.excerpt !== '') lines.push(`    > ${finding.excerpt}`);
      lines.push('');
    }
  } else {
    lines.push('VIOLATIONS: none');
    lines.push('');
  }

  lines.push(`NOTES (${notes.length}) — not failures; printed so no exemption is silent`);
  lines.push('');
  for (const finding of notes) {
    lines.push(`  ${finding.path}:${finding.line}  [${finding.rule}] ${finding.message}`);
  }
  if (notes.length > 0) lines.push('');

  lines.push('LIMITS OF THIS CHECK');
  lines.push(
    '  - Every rule reads the import graph and the export list. It proves which modules CAN reach',
  );
  lines.push(
    '    the shared services and which symbols exist once; it does not execute anything, so it',
  );
  lines.push(
    '    cannot prove the two channels produce the same answer. Requirement 10.7 is covered by the',
  );
  lines.push('    integration tests, not here.');
  lines.push(
    '  - The seam-consumer rule matches named imports resolved to a seam\'s defining module. A',
  );
  lines.push(
    '    seam reached by dynamic property access on a namespace object would evade it, which is why',
  );
  lines.push('    a namespace import of a seam-defining module is itself a violation.');
  lines.push(
    '  - The seam-definition rule matches by exported NAME. An unrelated future export sharing a',
  );
  lines.push(
    "    seam name is a false positive; the fix is a rename or a FLOW_SEAMS entry, not a looser",
  );
  lines.push('    rule.');
  lines.push(
    '  - src/app/** may import anything. The one-way rule forbids only the reverse direction, so',
  );
  lines.push(
    '    src/app/diagnosis/detail.ts holding screen-local decisions and being imported by that',
  );
  lines.push('    screen is correct rather than tolerated.');
  lines.push(
    '  - The no-training rule is a DENYLIST of provider SDK surfaces and training vocabulary. A',
  );
  lines.push(
    '    training endpoint reached by hand-rolled fetch to a runtime-assembled URL would not match,',
  );
  lines.push(
    '    and no scan can establish the provider-side fact that Gemini and Groq do not train on',
  );
  lines.push(
    '    Jamee\'s requests — that lives in docs/PROVIDER_CAPABILITIES.md.',
  );
  lines.push(
    `  - The no-training scan skips ${CODEBASE_SKIP_DIRECTORIES.join(', ')} and the files listed in`,
  );
  lines.push(
    '    CODEBASE_SKIP_FILES. docs/ and .kiro/ are prose that states the no-training rule; scanning',
  );
  lines.push('    them would report the sentence as a breach of itself.');
  lines.push(
    `  - Exactly ${TRAINING_SCAN_EXEMPT.length} files are exempt from the no-training scan, by exact path (see NOTES).`,
  );
  lines.push(
    '  - Test modules are exempt from the seam-consumer rule and get a note from the layering rule.',
  );

  if (report.staleSeamConsumers.length > 0) {
    lines.push('');
    lines.push('STALE SEAM CONSUMERS — listed in FLOW_SEAMS but importing the seam no longer:');
    for (const key of report.staleSeamConsumers) lines.push(`  ${key}`);
  }

  lines.push('');
  lines.push(violations.length === 0 ? 'PASS' : `FAIL — ${violations.length} violation(s)`);

  return lines.join('\n');
}

export function main(): number {
  const report = runRules({ modules: collectModules(), codebase: collectCodebaseFiles() });
  process.stdout.write(`${formatReport(report)}\n`);
  return report.findings.some((f) => f.severity === 'violation') ? 1 : 0;
}

/**
 * Run only when this file *is* the process entry point, so importing it from a test neither scans
 * nor exits. The `file:` guard is for the test environment, where `import.meta.url` is an http URL.
 */
function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || !import.meta.url.startsWith('file:')) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedAsScript()) {
  process.exit(main());
}
