/**
 * `check-shared-implementation` — the CI gate that keeps Jamee's *single* implementation single,
 * and (Amendment A1/A3) that keeps the entitlement gate out of the services and `profiles.phone`
 * reader-free.
 *
 * Requirements: 3.8 (the Diagnosis_Service serves both channels from one implementation),
 *               7.7 (the Chat_Service serves both channels from one implementation),
 *               16.1 (the Web_App and the Telegram adapter obtain every Diagnosis_Result from the
 *               Diagnosis_Service), 16.2 (…every chat answer from the Chat_Service),
 *               16.3 (exactly one implementation of the crop image analysis flow),
 *               16.4 (exactly one implementation of the Knowledge_Base grounding and rephrasing
 *               flow), 22.17 (the entitlement gate lives in the adapter, not the services — "the
 *               web stays free" by construction), 1.9 (`profiles.phone` takes part in no identity
 *               resolution)
 * Design: "Static architecture check (CI)"; Amendment A1 task 47.5 (the two new structural checks);
 *         Amendment A3 (the adapter is Telegram, `profiles.phone`'s only writer is
 *         `scripts/db-setup.ts`)
 *
 * The no-training rule traces to the requirements' Introduction, Release Acceptance step 8, and
 * design commitment 1 ("No model training, no invented agronomy"); `tasks.md` records that step 8's
 * no-training half is asserted here rather than at runtime, "since absence of a call is a codebase
 * property".
 *
 * Run it:  `npm run check:shared-implementation`  (exits 0 clean, 1 on any violation)
 *
 * =============================================================================
 * AMENDMENT A1/A3 — WHAT CHANGED
 * =============================================================================
 *
 * The adapter the design names is now the **Telegram** adapter (`src/lib/telegram-dispatch.ts`),
 * not the retired WhatsApp one. The channel entry points, the dispatch-seam assertions, and the
 * consumer allowlists are restated for it: the webhook route imports `dispatchTelegramRequest`, and
 * the dispatch module imports `diagnose`, `chatAnswerer`, and `transcribeAndAnswer` and types its
 * image/audio dispatch seams as `typeof diagnose` / `typeof transcribeAndAnswer` (via its aliased
 * imports), exactly the shape a parallel implementation would have to break.
 *
 * Two structural checks are added, both asserting an ABSENCE — which is what a static check is for:
 *
 *  - **`entitlement-isolation`** — no module under `src/services/{diagnosis,chat,voice}.service.ts`
 *    imports `@/services/entitlement.service`. The gate lives in the Telegram adapter; the services
 *    take no entitlement parameter and cannot consult one, which is what keeps the channel-parity
 *    claim testable and "the web stays free" true by the dependency graph rather than by vigilance
 *    (Requirement 22.17, design D14).
 *  - **`phone-reader-free`** — `profiles.phone` has no reader anywhere except `scripts/db-setup.ts`.
 *    Under A3 the identity is the Auth_User_Id and phone takes part in no resolution (Requirement
 *    1.9); this keeps that true as the codebase grows. The `phone` token is matched as a whole word
 *    in comment-blanked code, so a sentence about phones is not a reader.
 *
 * =============================================================================
 * THE NINE ASSERTIONS
 * =============================================================================
 *
 * 1. **`service-module`** — each service entry point is exported by exactly one expected module.
 * 2. **`channel-entry`** — every channel entry point imports the shared service it must use.
 * 3. **`seam-type`** — the Telegram adapter's dispatch seams are typed as the service functions.
 * 4. **`seam-definition`** — each flow seam symbol is exported by exactly one module, at its home.
 * 5. **`seam-consumer`** — only a recorded owner imports a flow seam from its defining module.
 * 6. **`layering`** — nothing under `src/services/**` or `src/lib/**` imports from `src/app/**`.
 * 7. **`no-training`** — no training/fine-tuning call, and no training dependency.
 * 8. **`entitlement-isolation`** — no service imports the entitlement service. (A1/A3, new)
 * 9. **`phone-reader-free`** — `profiles.phone` has no reader outside `scripts/db-setup.ts`. (new)
 *
 * =============================================================================
 * WHY THIS IS NOT A GREP, AND THE ONE-WAY NEAR-MISS
 * =============================================================================
 *
 * Every identifier these rules look for is named more often in *prose* than in code, and a naive
 * `rg train` returns 90 hits in this repository, every one the word "constraint". So every rule
 * runs against a **comment-blanked** copy: comments become spaces byte-for-byte (line numbers stay
 * real), string and regex literals survive (an import specifier is a string literal). `.sql` files
 * get `--` blanking too — though A3 has no migrations left, the setup script and any residual `.sql`
 * are handled the same way.
 *
 * `src/app/**` may import anything. The one-way rule (assertion 6) forbids only the reverse: a
 * shared module reaching UP into a screen. `src/app/diagnosis/detail.ts` being imported by its own
 * screen is the permitted direction and is not looked at.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ========================================================================== */
/* The facts the rules are written against                                     */
/* ========================================================================== */

export interface ServiceEntryPoint {
  readonly name: string;
  readonly module: string;
  readonly service: 'DiagnosisService' | 'ChatService' | 'VoiceService';
}

/**
 * The service entry points. `chatTurn` (the composed turn the web route calls), `chatAnswerer` (the
 * same turn bound for a caller that supplies its own credential — the voice route and the Telegram
 * adapter), and `answerQuestion` (the ungrounded inner step) are three names for one ChatService.
 */
export const SERVICE_ENTRY_POINTS: readonly ServiceEntryPoint[] = [
  { name: 'diagnose', module: 'src/services/diagnosis.service.ts', service: 'DiagnosisService' },
  { name: 'chatTurn', module: 'src/services/chat.service.ts', service: 'ChatService' },
  { name: 'chatAnswerer', module: 'src/services/chat.service.ts', service: 'ChatService' },
  { name: 'answerQuestion', module: 'src/services/chat.service.ts', service: 'ChatService' },
  { name: 'transcribeAndAnswer', module: 'src/services/voice.service.ts', service: 'VoiceService' },
];

export interface ChannelEntryPoint {
  readonly path: string;
  readonly channel: 'web' | 'telegram';
  readonly requires: readonly { readonly module: string; readonly names: readonly string[] }[];
  readonly why: string;
}

/**
 * Every channel entry point, with the shared imports it must carry. A missing file is a VIOLATION,
 * not a skip: a route renamed without this table being updated would silently stop being checked.
 *
 * Aliased imports resolve to the SOURCE name (`parseImportClause`), so `diagnose as realDiagnose` in
 * the Telegram adapter satisfies a requirement for `diagnose`.
 */
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
      { module: 'src/services/chat.service.ts', names: ['chatAnswerer'] },
    ],
    why: 'Requirements 16.2 and 8.4 — a voice question is answered by the same ChatService',
  },
  {
    path: 'src/app/api/telegram/route.ts',
    channel: 'telegram',
    /**
     * The webhook admits a delivery and hands it on; it imports the *adapter*, not the services.
     * That is the seam the route defends (it decides nothing a farmer sees), so requiring a service
     * import here would be requiring the wrong shape.
     */
    requires: [{ module: 'src/lib/telegram-dispatch.ts', names: ['dispatchTelegramRequest'] }],
    why: 'Requirement 10.11 — the webhook hands every admitted delivery to the one adapter pipeline',
  },
  {
    path: 'src/lib/telegram-dispatch.ts',
    channel: 'telegram',
    requires: [
      { module: 'src/services/diagnosis.service.ts', names: ['diagnose'] },
      { module: 'src/services/chat.service.ts', names: ['chatAnswerer'] },
      { module: 'src/services/voice.service.ts', names: ['transcribeAndAnswer'] },
    ],
    why: 'Requirements 16.1 and 16.2 — the Telegram adapter calls the shared services, not its own',
  },
];

export interface SeamTypeAssertion {
  readonly path: string;
  readonly alias: string;
  readonly pattern: RegExp;
  readonly expected: string;
  readonly why: string;
}

/**
 * The dispatch seams the Telegram adapter expresses in terms of the service functions. Hand-writing
 * a compatible interface is how a parallel implementation would begin, and it would pass assertion 2
 * (the import would still be there) while failing this one.
 *
 * The adapter aliases its service imports (`diagnose as realDiagnose`, `transcribeAndAnswer as
 * realTranscribeAndAnswer`) and types the dispatch seams `DiagnoseFn = typeof realDiagnose` /
 * `TranscribeAndAnswerFn = typeof realTranscribeAndAnswer`; the chat seam is the imported
 * `chatAnswerer` bound directly. So the two typed seams are what a static check can hold onto.
 */
export const SEAM_TYPE_ASSERTIONS: readonly SeamTypeAssertion[] = [
  {
    path: 'src/lib/telegram-dispatch.ts',
    alias: 'DiagnoseFn',
    pattern: /\bDiagnoseFn\s*=\s*typeof\s+realDiagnose\b/,
    expected: 'typeof realDiagnose (the DiagnosisService function)',
    why: 'the image seam is the DiagnosisService function itself, so no parallel shape can satisfy it',
  },
  {
    path: 'src/lib/telegram-dispatch.ts',
    alias: 'TranscribeAndAnswerFn',
    pattern: /\bTranscribeAndAnswerFn\s*=\s*typeof\s+realTranscribeAndAnswer\b/,
    expected: 'typeof realTranscribeAndAnswer (the VoiceService function)',
    why: 'the audio seam is the VoiceService function itself',
  },
];

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
    consumers: ['src/lib/prompts.ts', 'src/services/diagnosis.service.ts'],
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
      /** The detail screen — a consumer, not a second implementation. */
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
      'src/app/diagnosis/[id]/page.tsx',
    ],
    why: 'the row reduced to what a farmer may be shown, in one place',
  },
];

/**
 * The two directories whose modules may not import from `src/app/**`. `src/components/**` is absent
 * (a component is part of the app shell); `src/types/**` is absent (it imports nothing).
 */
export const SHARED_LAYER_ROOTS = ['src/lib/', 'src/services/'] as const;
export const APP_LAYER_ROOT = 'src/app/';

/* ── Assertion 8 — the entitlement gate stays out of the services ────────── */

/**
 * The three service modules that must NOT import the entitlement service, and the module that is
 * the gate. Under A1/A3 the entitlement check lives in the Telegram adapter alone (D14, 22.17); a
 * service reaching for it would let the gate leak into a path the web channel also runs, breaking
 * "the web stays free by construction".
 */
export const ENTITLEMENT_SERVICE_MODULE = 'src/services/entitlement.service.ts';
export const ENTITLEMENT_FORBIDDEN_IMPORTERS = [
  'src/services/diagnosis.service.ts',
  'src/services/chat.service.ts',
  'src/services/voice.service.ts',
] as const;

/* ── Assertion 9 — profiles.phone is reader-free outside db-setup ────────── */

/**
 * `profiles.phone` may be read only by `scripts/db-setup.ts` (under A3 it is not even there, so in
 * practice `phone` should appear nowhere — but the allowance keeps the rule honest if a setup-time
 * use ever returns). The `phone` token is matched as a whole word in comment-blanked code, so a
 * sentence mentioning a phone is not a reader.
 */
export const PHONE_READER_ALLOWLIST = ['scripts/db-setup.ts'] as const;

/* ── Assertion 7 — no training ───────────────────────────────────────────── */

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
    pattern:
      /\blearning[_-]?rate\b|\bnum[_-]?epochs?\b|\bepoch[_-]?count\b|\bloss[_-]?function\b|\bmodel[_-]?checkpoints?\b|\bbackprop\w*\b/i,
    surface: 'training-loop configuration: learning rate, epoch count, loss function, checkpoints',
  },
];

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
  | 'no-training'
  | 'entitlement-isolation'
  | 'phone-reader-free';

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
  readonly path: string;
  readonly source: string;
}

export interface Report {
  readonly findings: readonly Finding[];
  readonly scannedModules: number;
  readonly scannedCodebaseFiles: number;
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

export function moduleKey(path: string): string {
  const withoutExtension = path.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
  return withoutExtension.replace(/\/index$/, '');
}

/* ========================================================================== */
/* Imports and exports                                                         */
/* ========================================================================== */

export interface ImportStatement {
  readonly specifier: string;
  readonly names: readonly string[];
  readonly namespace: boolean;
  readonly offset: number;
}

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
/* Assertion 3 — the Telegram adapter's seams are the service functions         */
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
        'A hand-written compatible shape here is where a parallel implementation starts, and it ' +
        'would still satisfy the import check — so this typed seam is what the static check holds.',
      excerpt: '',
    });
  }

  return findings;
}

/* ========================================================================== */
/* Assertion 4 — one definition per flow seam                                  */
/* ========================================================================== */

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
        `${APP_LAYER_ROOT} is one-way: screens import services and lib, never the reverse.`,
      excerpt,
    });
  }

  return findings;
}

/* ========================================================================== */
/* Assertion 7 — no training or fine-tuning call                               */
/* ========================================================================== */

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
          'the knowledge base supplies every agricultural fact.',
        excerpt: lineText(file.source, match.index),
      });
    }
  }

  return findings;
}

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
/* Assertion 8 — the entitlement gate stays out of the services (A1/A3)        */
/* ========================================================================== */

/**
 * No diagnosis/chat/voice service imports the entitlement service. The gate lives in the Telegram
 * adapter; a service that could consult an entitlement would let the gate leak onto a path the web
 * channel also runs, breaking "the web stays free by construction" (Requirement 22.17, D14).
 */
export function checkEntitlementIsolation(file: SourceFile): Finding[] {
  if (!(ENTITLEMENT_FORBIDDEN_IMPORTERS as readonly string[]).includes(file.path)) return [];

  const findings: Finding[] = [];
  for (const statement of extractImports(blankComments(file.source))) {
    const resolved = resolveSpecifier(file.path, statement.specifier);
    if (resolved === null) continue;
    if (moduleKey(resolved) !== moduleKey(ENTITLEMENT_SERVICE_MODULE)) continue;

    findings.push({
      rule: 'entitlement-isolation',
      severity: 'violation',
      path: file.path,
      line: lineOf(file.source, statement.offset),
      message:
        `${file.path} imports ${ENTITLEMENT_SERVICE_MODULE}. The entitlement gate must live only in ` +
        'the Telegram adapter (D14): the services take no entitlement parameter and cannot consult ' +
        'one, which is what keeps channel parity testable and the web free by the dependency graph ' +
        '(Requirement 22.17).',
      excerpt: lineText(file.source, statement.offset),
    });
  }

  return findings;
}

/* ========================================================================== */
/* Assertion 9 — profiles.phone is reader-free outside db-setup (A3)           */
/* ========================================================================== */

const PHONE_MEMBER_READ = /\.\s*phone(?![A-Za-z0-9_])/g;

/**
 * `profiles.phone` has no READER outside `scripts/db-setup.ts`. Under A3 the identity is the
 * Auth_User_Id and phone takes part in no resolution (Requirement 1.9).
 *
 * A "reader" is a MEMBER ACCESS of the value — `profile.phone`, `doc.phone`, `row.phone` — matched
 * as `.phone` (word-bounded) in comment-blanked code. It is deliberately NOT the whole word
 * `phone`, because:
 *  - the field's DECLARATION (`phone?: string | null` in `collections.ts`) and the DAL accessor's
 *    parameter type (`Pick<ProfileDoc, … | 'phone'>` in `farmer.ts`) are the layer's legitimate
 *    surface, not readers of a value — those are owned by another wave and carry comments saying
 *    the field has "no reader"; flagging them would be flagging the very thing that documents the
 *    rule;
 *  - prose about a farmer's mobile phone (in comments) is blanked and never a reader.
 *
 * Scanned over `src/**` shipping modules, with test modules exempt (a fixture is not a reader and
 * does not ship) and `scripts/db-setup.ts` allowlisted. This mirrors `check-data-access.ts`'s
 * scope: the rule is about the code that ships.
 */
export function checkPhoneReaderFree(file: SourceFile): Finding[] {
  if ((PHONE_READER_ALLOWLIST as readonly string[]).includes(file.path)) return [];

  const blanked = blankFor(file);
  const findings: Finding[] = [];

  for (const match of blanked.matchAll(PHONE_MEMBER_READ)) {
    const line = lineOf(blanked, match.index);
    const excerpt = lineText(file.source, match.index);

    if (isTestModule(file.path)) {
      findings.push({
        rule: 'phone-reader-free',
        severity: 'note',
        path: file.path,
        line,
        message:
          "a test module reads '.phone' — exempt. A test fixture is not a shipping reader of the " +
          'profile field.',
        excerpt,
      });
      continue;
    }

    findings.push({
      rule: 'phone-reader-free',
      severity: 'violation',
      path: file.path,
      line,
      message:
        `${file.path} reads '.phone'. Under A3 profiles.phone takes part in no identity resolution ` +
        `(Requirement 1.9) and has no reader outside ${PHONE_READER_ALLOWLIST.join(', ')}. Remove ` +
        'the read, or (if it is a legitimate setup-time use) add the file to PHONE_READER_ALLOWLIST.',
      excerpt,
    });
  }

  return findings;
}

/* ========================================================================== */
/* The run                                                                     */
/* ========================================================================== */

export interface RunInput {
  readonly modules: readonly SourceFile[];
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
    findings.push(...checkEntitlementIsolation(file));
    findings.push(...checkPhoneReaderFree(file));
  }

  /* Assertion 7 scans the wider codebase (no-training). */
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

export const MODULE_ROOT = 'src';

/**
 * Directories the no-training / phone scan does not enter. `docs` and `.kiro` are prose whose prose
 * states these rules, so scanning them would report the sentence as a breach. The rest are build
 * output and vendored code.
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

export const CODEBASE_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs|sql|json)$/;
export const CODEBASE_SKIP_FILES = ['package-lock.json', 'tsconfig.tsbuildinfo'] as const;

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
  'seam-type': "the Telegram adapter's dispatch seam is no longer the service function's type",
  'seam-definition': 'a flow seam is defined more than once, or not where it belongs',
  'seam-consumer': 'a flow seam is imported by a module that does not own it',
  layering: 'a shared module imports from src/app/**',
  'no-training': 'a training or fine-tuning surface appears in the codebase',
  'entitlement-isolation': 'a service imports the entitlement service',
  'phone-reader-free': "profiles.phone has a reader outside scripts/db-setup.ts",
};

export function formatReport(report: Report): string {
  const violations = report.findings.filter((f) => f.severity === 'violation');
  const notes = report.findings.filter((f) => f.severity === 'note');
  const lines: string[] = [];

  lines.push(
    'check-shared-implementation — Requirements 3.8, 7.7, 16.1–16.4, 22.17, 1.9 (Amendment A1/A3)',
  );
  lines.push(
    `scanned ${report.scannedModules} modules under ${MODULE_ROOT}/ for the architecture rules, ` +
      `${report.scannedCodebaseFiles} files for the no-training/phone rules`,
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
  lines.push('  - Every rule reads the import graph and the export list; it does not execute, so it');
  lines.push('    cannot prove the two channels produce the same answer (the integration tests do).');
  lines.push('  - The no-training rule is a DENYLIST of provider SDK surfaces and training');
  lines.push('    vocabulary; a hand-rolled fetch to a runtime-assembled URL would not match.');
  lines.push("  - The phone rule matches a '.phone' member READ in src/ shipping code; the field's");
  lines.push('    declaration and the DAL accessor type are surface, not readers, and are not flagged.');
  lines.push('  - src/app/** may import anything; the one-way rule forbids only the reverse.');

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

function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || !import.meta.url.startsWith('file:')) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedAsScript()) {
  process.exit(main());
}
