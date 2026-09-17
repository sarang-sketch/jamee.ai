import { describe, expect, it } from 'vitest';

import {
  CHANNEL_ENTRY_POINTS,
  FLOW_SEAMS,
  SERVICE_ENTRY_POINTS,
  TRAINING_SCAN_EXEMPT,
  blankComments,
  blankSqlComments,
  checkChannelEntryPoints,
  checkLayering,
  checkNoTraining,
  checkSeamConsumers,
  checkSeamDefinitions,
  checkSeamTypes,
  checkServiceModules,
  checkTrainingDependencies,
  collectCodebaseFiles,
  collectModules,
  exportedNames,
  extractImports,
  formatReport,
  moduleKey,
  parseImportClause,
  resolveSpecifier,
  runRules,
  type Finding,
  type SourceFile,
} from '../../scripts/check-shared-implementation';

/**
 * Tests for the architecture guard itself.
 *
 * Requirements: 3.8, 7.7, 16.1, 16.2, 16.3, 16.4
 *
 * Almost every case is a **fixture** written inline rather than the real tree, for the reason
 * `check-secret-scope.test.ts` gives: a guard asserted only against a passing repository proves
 * that it can say "PASS", not that it can say anything else. Each rule's catch case is pinned here
 * so a later refactor of a matcher cannot quietly stop catching it.
 *
 * The real tree appears in four places, because those are the claims it is the evidence for: the
 * guard passes as the codebase stands, no seam consumer is stale, the comment blanker keeps its
 * place across 100-odd real modules, and — the one that would have been missed without it — the
 * word "constraint" appears 90 times in this repository and trips no training rule.
 *
 * This file is on `TRAINING_SCAN_EXEMPT` and has to be: several fixtures below exist precisely to
 * spell a forbidden identifier.
 */

const fixture = (path: string, source: string): SourceFile => ({ path, source });

const rulesOf = (findings: readonly Finding[]): string[] =>
  findings.filter((f) => f.severity === 'violation').map((f) => f.rule);

const messagesOf = (findings: readonly Finding[]): string[] =>
  findings.filter((f) => f.severity === 'violation').map((f) => f.message);

/**
 * A minimal tree that satisfies `checkServiceModules`, `checkChannelEntryPoints` and
 * `checkSeamTypes` at once.
 *
 * Whole-tree rules need a whole tree: asserting on one broken entry point against a two-file
 * fixture would drown the finding under "no module exports chatTurn" for every other row of the
 * table. Each test overrides one member of this set and asserts on what changes.
 */
const happyTree = (overrides: Readonly<Record<string, string>> = {}): SourceFile[] => {
  const modules: Record<string, string> = {
    'src/services/diagnosis.service.ts': 'export async function diagnose() {}',
    'src/services/chat.service.ts': [
      'export async function chatTurn() {}',
      'export async function answerQuestion() {}',
      'export function chatAnswerer() {}',
    ].join('\n'),
    'src/services/voice.service.ts': 'export async function transcribeAndAnswer() {}',
    'src/app/api/diagnose/route.ts': "import { diagnose } from '@/services/diagnosis.service';",
    'src/app/api/chat/route.ts': "import { chatTurn } from '@/services/chat.service';",
    'src/app/api/voice/route.ts': [
      "import { chatAnswerer } from '@/services/chat.service';",
      "import { transcribeAndAnswer } from '@/services/voice.service';",
    ].join('\n'),
    'src/app/api/whatsapp/route.ts':
      "import { processInboundBatch } from '@/lib/whatsapp-dispatch';",
    'src/lib/whatsapp-dispatch.ts': [
      "import { chatAnswerer } from '@/services/chat.service';",
      "import { diagnose } from '@/services/diagnosis.service';",
      "import { transcribeAndAnswer, type ChatAnswerer } from '@/services/voice.service';",
      'export function processInboundBatch() {}',
      'export type WhatsappDiagnosisService = typeof diagnose;',
      'export type WhatsappVoiceService = typeof transcribeAndAnswer;',
      'export type WhatsappChatService = ChatAnswerer;',
    ].join('\n'),
    ...overrides,
  };

  return Object.entries(modules).map(([path, source]) => fixture(path, source));
};

/* ========================================================================== */
/* Comment blanking — every rule is only as good as this                       */
/* ========================================================================== */

describe('blankComments', () => {
  it('blanks prose that names a seam but keeps the import that uses it', () => {
    const blanked = blankComments(
      [
        '// diagnosis.service.ts owns CLASSIFICATION_PROMPT',
        "import { CLASSIFICATION_PROMPT } from '@/lib/prompts';",
        '/* rephrasePrompt lives there too */',
      ].join('\n'),
    );

    expect(blanked).toContain("import { CLASSIFICATION_PROMPT } from '@/lib/prompts';");
    expect(blanked).not.toContain('owns');
    expect(blanked).not.toContain('rephrasePrompt');
  });

  it('preserves length and every newline offset, so reported line numbers are real', () => {
    const source = ['// one', 'const a = 1; /* two', 'three */ const b = 2;', ''].join('\n');
    const blanked = blankComments(source);

    expect(blanked).toHaveLength(source.length);
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] === '\n') expect(blanked[i]).toBe('\n');
    }
  });

  it('does not lose the closing backtick of a template literal with a hole', () => {
    const source = [
      "const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;",
      '/** never imports rephrasePrompt */',
      'const after = 1;',
    ].join('\n');
    const blanked = blankComments(source);

    expect(blanked).not.toContain('rephrasePrompt');
    expect(blanked).toContain('const after = 1;');
  });

  it('keeps its place across every real module under src/', () => {
    for (const file of collectModules()) {
      const blanked = blankComments(file.source);
      expect(blanked, file.path).toHaveLength(file.source.length);
      expect(blanked.split('\n').length, file.path).toBe(file.source.split('\n').length);
    }
  });
});

describe('blankSqlComments', () => {
  it('blanks `--` prose and keeps the DDL', () => {
    const blanked = blankSqlComments(
      ['-- the healthy_has_no_treatment constraint', 'create table x (id uuid primary key);'].join(
        '\n',
      ),
    );

    expect(blanked).not.toContain('healthy_has_no_treatment');
    expect(blanked).toContain('create table x (id uuid primary key);');
  });

  it('skips a dollar-quoted function body whole rather than losing its place', () => {
    const source = ['$$', '-- inside a body', '$$', '-- outside', 'select 1;'].join('\n');
    const blanked = blankSqlComments(source);

    expect(blanked).toHaveLength(source.length);
    expect(blanked).toContain('select 1;');
    expect(blanked).not.toContain('outside');
  });
});

/* ========================================================================== */
/* Imports and exports                                                         */
/* ========================================================================== */

describe('parseImportClause', () => {
  it('resolves an alias to the source name', () => {
    expect(parseImportClause(' { diagnose as run, type DiagnosisDeps } ').names).toEqual([
      'diagnose',
      'DiagnosisDeps',
    ]);
  });

  it('reads a default binding alongside a named one', () => {
    expect(parseImportClause(' Groq, { type ChatMessage } ').names).toEqual(['ChatMessage', 'Groq']);
  });

  it('flags a namespace binding and reports no names for it', () => {
    expect(parseImportClause(' * as prompts ')).toEqual({ names: [], namespace: true });
  });

  it('drops a leading type keyword on the whole clause', () => {
    expect(parseImportClause(' type { ChatAnswerer } ').names).toEqual(['ChatAnswerer']);
  });
});

describe('extractImports', () => {
  it('reads a multi-line clause', () => {
    const [statement] = extractImports(
      ['import {', '  diagnose,', '  type DiagnosisDeps,', "} from '@/services/diagnosis.service';"].join(
        '\n',
      ),
    );

    expect(statement?.specifier).toBe('@/services/diagnosis.service');
    expect(statement?.names).toEqual(['diagnose', 'DiagnosisDeps']);
  });

  it('does not let an `export type X = Y;` statement swallow the next import', () => {
    // The regression the `[^;=]` clause restriction exists for: without it the non-greedy match
    // runs from this `export` to the *next* `from`, and the alias is attributed to that specifier.
    const statements = extractImports(
      [
        'export type WhatsappChatService = ChatAnswerer;',
        "import { diagnose } from '@/services/diagnosis.service';",
      ].join('\n'),
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]?.specifier).toBe('@/services/diagnosis.service');
    expect(statements[0]?.names).toEqual(['diagnose']);
  });

  it('reads a side-effect import, a re-export, and a dynamic import', () => {
    const specifiers = extractImports(
      [
        "import 'server-only';",
        "export { toDiagnosisDetail } from '@/app/diagnosis/detail';",
        "const mod = await import('@/app/history/page');",
      ].join('\n'),
    ).map((statement) => statement.specifier);

    expect(specifiers).toContain('server-only');
    expect(specifiers).toContain('@/app/diagnosis/detail');
    expect(specifiers).toContain('@/app/history/page');
  });
});

describe('resolveSpecifier', () => {
  it('maps the @ alias onto src/', () => {
    expect(resolveSpecifier('src/lib/x.ts', '@/services/chat.service')).toBe(
      'src/services/chat.service',
    );
  });

  it('resolves a relative specifier against the importing module', () => {
    expect(resolveSpecifier('src/app/diagnosis/[id]/page.tsx', '../detail')).toBe(
      'src/app/diagnosis/detail',
    );
    expect(resolveSpecifier('src/lib/db/whatsapp-inbound.ts', '../../app/history/page')).toBe(
      'src/app/history/page',
    );
  });

  it('has no opinion about a bare package specifier', () => {
    expect(resolveSpecifier('src/lib/x.ts', 'groq-sdk')).toBeNull();
  });
});

describe('moduleKey', () => {
  it('makes a specifier and a file path comparable', () => {
    expect(moduleKey('src/lib/knowledge.ts')).toBe(moduleKey('src/lib/knowledge'));
    expect(moduleKey('src/lib/messages/index.ts')).toBe(moduleKey('src/lib/messages'));
  });
});

describe('exportedNames', () => {
  it('reads every declaration form', () => {
    const names = exportedNames(
      [
        'export async function diagnose() {}',
        'export const PROMPT_VERSION = 1;',
        'export interface DiagnosisDeps {}',
        'export type ChatAnswerer = () => void;',
        'export class Thing {}',
      ].join('\n'),
    );

    expect([...names].sort()).toEqual([
      'ChatAnswerer',
      'DiagnosisDeps',
      'PROMPT_VERSION',
      'Thing',
      'diagnose',
    ]);
  });

  it('reads a re-export clause by its exported alias', () => {
    expect([...exportedNames('export { inner as diagnose } from "./inner";')]).toEqual(['diagnose']);
  });

  it('does not count a name that only appears in prose', () => {
    expect(exportedNames(blankComments('/** export function diagnose() */')).size).toBe(0);
  });
});

/* ========================================================================== */
/* Assertion 1 — one module per service entry point                            */
/* ========================================================================== */

describe('checkServiceModules', () => {
  it('accepts the happy tree', () => {
    expect(rulesOf(checkServiceModules(happyTree()))).toEqual([]);
  });

  it('flags a second module exporting a service entry point', () => {
    const findings = checkServiceModules([
      ...happyTree(),
      fixture('src/lib/rogue-diagnose.ts', 'export async function diagnose() {}'),
    ]);

    expect(rulesOf(findings)).toEqual(['service-module', 'service-module']);
    expect(messagesOf(findings)[0]).toContain('exported by 2 modules');
  });

  it('flags a service entry point nobody exports, rather than passing vacuously', () => {
    const findings = checkServiceModules(
      happyTree({ 'src/services/diagnosis.service.ts': 'export async function analyse() {}' }),
    );

    expect(rulesOf(findings)).toEqual(['service-module']);
    expect(messagesOf(findings)[0]).toContain("No module under src/ exports 'diagnose'");
  });

  it('flags a service entry point that moved to another module', () => {
    const moved = happyTree({ 'src/services/diagnosis.service.ts': 'export const x = 1;' });
    moved.push(fixture('src/lib/diagnose.ts', 'export async function diagnose() {}'));

    expect(messagesOf(checkServiceModules(moved))[0]).toContain(
      "'diagnose' is exported by src/lib/diagnose.ts",
    );
  });

  it('ignores a test module, whose stubs are not the service', () => {
    const findings = checkServiceModules([
      ...happyTree(),
      fixture('src/services/fake.test.ts', 'export async function diagnose() {}'),
    ]);

    expect(rulesOf(findings)).toEqual([]);
  });
});

/* ========================================================================== */
/* Assertion 2 — every channel entry point imports the shared service          */
/* ========================================================================== */

describe('checkChannelEntryPoints', () => {
  it('accepts the happy tree', () => {
    expect(rulesOf(checkChannelEntryPoints(happyTree()))).toEqual([]);
  });

  it('flags a channel that stopped importing the shared service', () => {
    const findings = checkChannelEntryPoints(
      happyTree({ 'src/app/api/diagnose/route.ts': 'export async function POST() {}' }),
    );

    expect(rulesOf(findings)).toEqual(['channel-entry']);
    expect(messagesOf(findings)[0]).toContain(
      'does not import src/services/diagnosis.service.ts',
    );
  });

  it('flags an import of the right module without the required name', () => {
    const findings = checkChannelEntryPoints(
      happyTree({
        'src/app/api/chat/route.ts': "import type { ChatTurnDeps } from '@/services/chat.service';",
      }),
    );

    expect(rulesOf(findings)).toEqual(['channel-entry']);
    expect(messagesOf(findings)[0]).toContain('but not chatTurn');
  });

  it('flags an entry point that is no longer in the tree', () => {
    const withoutVoice = happyTree().filter((file) => file.path !== 'src/app/api/voice/route.ts');
    const findings = checkChannelEntryPoints(withoutVoice);

    expect(rulesOf(findings)).toEqual(['channel-entry']);
    expect(messagesOf(findings)[0]).toContain('is not in the tree');
  });

  it('accepts a namespace import, which cannot be checked name by name', () => {
    const findings = checkChannelEntryPoints(
      happyTree({
        'src/app/api/chat/route.ts': "import * as chat from '@/services/chat.service';",
      }),
    );

    expect(rulesOf(findings)).toEqual([]);
  });
});

/* ========================================================================== */
/* Assertion 3 — the WhatsApp adapter's seams are the service functions         */
/* ========================================================================== */

describe('checkSeamTypes', () => {
  it('accepts the happy tree', () => {
    expect(rulesOf(checkSeamTypes(happyTree()))).toEqual([]);
  });

  it('flags a dispatch seam retyped as a hand-written shape', () => {
    // How a parallel implementation begins: the import stays (so assertion 2 is still green) but
    // the seam no longer requires the service function.
    const findings = checkSeamTypes(
      happyTree({
        'src/lib/whatsapp-dispatch.ts': [
          "import { diagnose } from '@/services/diagnosis.service';",
          'export type WhatsappDiagnosisService = (ref: string) => Promise<unknown>;',
          'export type WhatsappVoiceService = typeof transcribeAndAnswer;',
          'export type WhatsappChatService = ChatAnswerer;',
        ].join('\n'),
      }),
    );

    expect(rulesOf(findings)).toEqual(['seam-type']);
    expect(messagesOf(findings)[0]).toContain("no longer declared as 'typeof diagnose'");
  });

  it('is not satisfied by a sentence describing the seam', () => {
    const findings = checkSeamTypes(
      happyTree({
        'src/lib/whatsapp-dispatch.ts': [
          '/** WhatsappChatService = ChatAnswerer, by design. */',
          'export type WhatsappDiagnosisService = typeof diagnose;',
          'export type WhatsappVoiceService = typeof transcribeAndAnswer;',
        ].join('\n'),
      }),
    );

    expect(rulesOf(findings)).toEqual(['seam-type']);
  });
});

/* ========================================================================== */
/* Assertion 4 — one definition per flow seam                                  */
/* ========================================================================== */

describe('checkSeamDefinitions', () => {
  const seamTree = (overrides: Readonly<Record<string, string>> = {}): SourceFile[] => {
    const byModule = new Map<string, string[]>();
    for (const seam of FLOW_SEAMS) {
      const lines = byModule.get(seam.definedIn) ?? [];
      lines.push(`export const ${seam.name} = 1;`);
      byModule.set(seam.definedIn, lines);
    }
    const modules: Record<string, string> = Object.fromEntries(
      [...byModule].map(([path, lines]) => [path, lines.join('\n')]),
    );
    return Object.entries({ ...modules, ...overrides }).map(([path, source]) =>
      fixture(path, source),
    );
  };

  it('accepts a tree where every seam is defined once, where it belongs', () => {
    expect(rulesOf(checkSeamDefinitions(seamTree()))).toEqual([]);
  });

  it('flags a second implementation of the grounding flow', () => {
    const findings = checkSeamDefinitions([
      ...seamTree(),
      fixture('src/lib/whatsapp-grounding.ts', 'export function rephrasePrompt() {}'),
    ]);

    expect(rulesOf(findings)).toEqual(['seam-definition', 'seam-definition']);
    expect(messagesOf(findings)[0]).toContain('Requirement 16.4');
  });

  it('flags a second implementation of the image analysis flow', () => {
    const findings = checkSeamDefinitions([
      ...seamTree(),
      fixture('src/lib/whatsapp-vision.ts', "export const CLASSIFICATION_PROMPT = 'ask again';"),
    ]);

    expect(messagesOf(findings)[0]).toContain('Requirement 16.3');
  });

  it('flags a seam that has disappeared, rather than passing vacuously', () => {
    const findings = checkSeamDefinitions(
      seamTree({ 'src/lib/schemas.ts': 'export const somethingElse = 1;' }),
    );

    expect(rulesOf(findings)).toEqual(['seam-definition']);
    expect(messagesOf(findings)[0]).toContain("No module exports 'visionRawSchema'");
  });
});

/* ========================================================================== */
/* Assertion 5 — only a recorded owner imports a flow seam                     */
/* ========================================================================== */

describe('checkSeamConsumers', () => {
  it('accepts a recorded consumer', () => {
    const findings = checkSeamConsumers(
      fixture(
        'src/services/diagnosis.service.ts',
        "import { CLASSIFICATION_PROMPT } from '@/lib/prompts';",
      ),
    );

    expect(rulesOf(findings)).toEqual([]);
  });

  it('flags a route handler reaching for the classification prompt', () => {
    const findings = checkSeamConsumers(
      fixture('src/app/api/diagnose/route.ts', "import { CLASSIFICATION_PROMPT } from '@/lib/prompts';"),
    );

    expect(rulesOf(findings)).toEqual(['seam-consumer']);
    expect(messagesOf(findings)[0]).toContain('Requirement 16.3');
  });

  it('flags the WhatsApp adapter reaching for the rephrase prompt', () => {
    const findings = checkSeamConsumers(
      fixture('src/lib/whatsapp-dispatch.ts', "import { rephrasePrompt } from '@/lib/prompts';"),
    );

    expect(rulesOf(findings)).toEqual(['seam-consumer']);
    expect(findings[0]?.line).toBe(1);
  });

  it('flags a namespace import of a seam-defining module, which would hide every seam', () => {
    const findings = checkSeamConsumers(
      fixture('src/app/api/chat/route.ts', "import * as prompts from '@/lib/prompts';"),
    );

    expect(rulesOf(findings)).toEqual(['seam-consumer']);
    expect(messagesOf(findings)[0]).toContain('Namespace import');
  });

  it('does not flag a same-named symbol imported from somewhere else', () => {
    const findings = checkSeamConsumers(
      fixture('src/lib/machine.ts', "import { interpret } from 'xstate';"),
    );

    expect(rulesOf(findings)).toEqual([]);
  });

  it('does not flag a seam named only in prose', () => {
    const findings = checkSeamConsumers(
      fixture(
        'src/app/api/chat/route.ts',
        '/** The ChatService owns chatPrompt and validateRephrased; this route owns neither. */',
      ),
    );

    expect(rulesOf(findings)).toEqual([]);
  });

  it('exempts a test module, which reads the one implementation rather than building a second', () => {
    expect(
      checkSeamConsumers(
        fixture('src/lib/prompts.test.ts', "import { rephrasePrompt } from '@/lib/prompts';"),
      ),
    ).toEqual([]);
  });

  it('records which consumers it saw, so a stale entry can be reported', () => {
    const used = new Set<string>();
    checkSeamConsumers(
      fixture('src/services/chat.service.ts', "import { chatPrompt } from '@/lib/prompts';"),
      used,
    );

    expect([...used]).toEqual(['chatPrompt::src/services/chat.service.ts']);
  });
});

/* ========================================================================== */
/* Assertion 6 — the one-way layering rule                                     */
/* ========================================================================== */

describe('checkLayering', () => {
  it('flags a lib module importing a screen', () => {
    const findings = checkLayering(
      fixture('src/lib/history.ts', "import { toDiagnosisDetail } from '@/app/diagnosis/detail';"),
    );

    expect(rulesOf(findings)).toEqual(['layering']);
    expect(messagesOf(findings)[0]).toContain('one-way');
  });

  it('flags a service module importing a route handler', () => {
    expect(
      rulesOf(
        checkLayering(fixture('src/services/chat.service.ts', "import { POST } from '@/app/api/chat/route';")),
      ),
    ).toEqual(['layering']);
  });

  it('flags a relative path that escapes into src/app', () => {
    expect(
      rulesOf(
        checkLayering(
          fixture('src/lib/db/whatsapp-inbound.ts', "import { x } from '../../app/history/page';"),
        ),
      ),
    ).toEqual(['layering']);
  });

  it('flags a dynamic import into src/app just as a static one', () => {
    expect(
      rulesOf(
        checkLayering(
          fixture('src/lib/history.ts', "const m = await import('@/app/diagnosis/detail');"),
        ),
      ),
    ).toEqual(['layering']);
  });

  it('says nothing about a screen importing a shared module — the permitted direction', () => {
    expect(
      checkLayering(
        fixture(
          'src/app/diagnosis/[id]/page.tsx',
          "import { lookupCondition } from '@/lib/knowledge';",
        ),
      ),
    ).toEqual([]);
  });

  it('says nothing about a screen importing another screen', () => {
    // The real near-miss: src/app/diagnosis/detail.ts is screen-local and imported by that screen.
    expect(
      checkLayering(
        fixture('src/app/diagnosis/[id]/page.tsx', "import { toDiagnosisDetail } from '@/app/diagnosis/detail';"),
      ),
    ).toEqual([]);
  });

  it('does not flag a sentence that names a screen module', () => {
    expect(
      checkLayering(
        fixture(
          'src/lib/history.ts',
          '/** These live in `src/app/diagnosis/detail.ts` because nothing else reads them. */',
        ),
      ),
    ).toEqual([]);
  });

  it('notes rather than fails a test module under a shared root', () => {
    const findings = checkLayering(
      fixture('src/lib/history.test.ts', "import { toDiagnosisDetail } from '@/app/diagnosis/detail';"),
    );

    expect(rulesOf(findings)).toEqual([]);
    expect(findings.map((f) => f.severity)).toEqual(['note']);
  });
});

/* ========================================================================== */
/* Assertion 7 — no training or fine-tuning call                               */
/* ========================================================================== */

describe('checkNoTraining', () => {
  it('flags a fine-tuning call', () => {
    const findings = checkNoTraining(
      fixture('src/lib/gemini.ts', 'await client.fineTuning.jobs.create({ model });'),
    );

    expect(rulesOf(findings)).toEqual(['no-training']);
    expect(messagesOf(findings)[0]).toContain('fine-tuning');
  });

  it("flags a snake_case fine_tuning surface and a purpose: 'fine-tune' upload", () => {
    expect(rulesOf(checkNoTraining(fixture('src/lib/x.ts', 'client.fine_tuning.create();')))).toEqual([
      'no-training',
    ]);
    expect(
      rulesOf(checkNoTraining(fixture('src/lib/x.ts', "files.create({ purpose: 'fine-tune' });"))),
    ).toEqual(['no-training']);
  });

  it('flags the @google/genai tuning surface', () => {
    expect(
      rulesOf(checkNoTraining(fixture('src/lib/gemini.ts', 'await ai.tunings.tune(config);'))),
    ).toEqual(['no-training']);
    expect(
      rulesOf(checkNoTraining(fixture('src/lib/gemini.ts', "const m = tunedModels['jamee'];"))),
    ).toEqual(['no-training']);
  });

  it('flags a training job and its data', () => {
    expect(
      rulesOf(checkNoTraining(fixture('src/lib/x.ts', 'const trainingData = rows.map(toExample);'))),
    ).toEqual(['no-training']);
    expect(rulesOf(checkNoTraining(fixture('src/lib/x.ts', 'await createTrainingJob(spec);')))).toEqual(
      ['no-training'],
    );
  });

  it('flags a .train() or .fit() call', () => {
    expect(rulesOf(checkNoTraining(fixture('src/lib/x.ts', 'await model.train(batch);')))).toEqual([
      'no-training',
    ]);
    expect(rulesOf(checkNoTraining(fixture('src/lib/x.ts', 'net.fit(xs, ys);')))).toEqual([
      'no-training',
    ]);
  });

  it('flags training-loop configuration', () => {
    expect(
      rulesOf(checkNoTraining(fixture('src/lib/x.ts', 'const learningRate = 3e-4;'))),
    ).toEqual(['no-training']);
  });

  it('does NOT flag the word "constraint", of which this repository has ninety', () => {
    // The reason this rule is not `rg train`. Every one of those ninety is "constraint".
    const findings = checkNoTraining(
      fixture(
        'src/lib/knowledge.ts',
        [
          "const message = 'new row violates check constraint';",
          'export const constrained = true;',
        ].join('\n'),
      ),
    );

    expect(findings).toEqual([]);
  });

  it('does NOT flag "epoch ms", which is how every deadline in this codebase is documented', () => {
    expect(
      checkNoTraining(fixture('src/lib/ai/gateway.ts', 'const deadlineMs = epochMsAt(start);')),
    ).toEqual([]);
  });

  it('does NOT flag a linear-gradient in a style value', () => {
    expect(
      checkNoTraining(fixture('src/components/Card.tsx', "const bg = 'linear-gradient(red, blue)';")),
    ).toEqual([]);
  });

  it('reads a migration through SQL comment blanking', () => {
    const findings = checkNoTraining(
      fixture(
        'supabase/migrations/0004_disease_knowledge.sql',
        '-- no fine-tuning happens here, and no training data is stored',
      ),
    );

    expect(findings).toEqual([]);
  });

  it('notes the two exempt files instead of scanning them', () => {
    for (const path of TRAINING_SCAN_EXEMPT) {
      const findings = checkNoTraining(fixture(path, 'const p = /fineTuning/;'));
      expect(rulesOf(findings), path).toEqual([]);
      expect(findings.map((f) => f.severity), path).toEqual(['note']);
    }
  });

  it('does not exempt an ordinary test module', () => {
    expect(
      rulesOf(checkNoTraining(fixture('src/lib/gemini.test.ts', 'stub.fineTuning.jobs.create();'))),
    ).toEqual(['no-training']);
  });
});

describe('checkTrainingDependencies', () => {
  it('flags a model-training dependency', () => {
    const findings = checkTrainingDependencies(
      fixture('package.json', JSON.stringify({ dependencies: { '@tensorflow/tfjs': '4.0.0' } })),
    );

    expect(rulesOf(findings)).toEqual(['no-training']);
    expect(messagesOf(findings)[0]).toContain('@tensorflow/tfjs');
  });

  it('flags a training dependency in devDependencies too', () => {
    expect(
      rulesOf(
        checkTrainingDependencies(
          fixture('package.json', JSON.stringify({ devDependencies: { 'brain.js': '2.0.0' } })),
        ),
      ),
    ).toEqual(['no-training']);
  });

  it("accepts Jamee's real manifest", () => {
    const manifest = collectCodebaseFiles().find((file) => file.path === 'package.json');

    expect(manifest).toBeDefined();
    expect(checkTrainingDependencies(manifest as SourceFile)).toEqual([]);
  });

  it('says nothing about any other file', () => {
    expect(checkTrainingDependencies(fixture('tsconfig.json', '{}'))).toEqual([]);
  });
});

/* ========================================================================== */
/* The run, against the tree it gates                                          */
/* ========================================================================== */

describe('runRules against the real repository', () => {
  const report = runRules({ modules: collectModules(), codebase: collectCodebaseFiles() });

  it('finds no violation in the current tree', () => {
    const violations = report.findings.filter((f) => f.severity === 'violation');

    expect(violations).toEqual([]);
    expect(formatReport(report)).toContain('PASS');
  });

  it('scans a plausible number of modules and files', () => {
    expect(report.scannedModules).toBeGreaterThan(50);
    expect(report.scannedCodebaseFiles).toBeGreaterThan(report.scannedModules);
  });

  it('has no stale seam consumer', () => {
    expect(report.staleSeamConsumers).toEqual([]);
  });

  it('justifies every seam, entry point and exemption', () => {
    for (const seam of FLOW_SEAMS) {
      expect(seam.why.length, seam.name).toBeGreaterThan(20);
    }
    for (const entry of CHANNEL_ENTRY_POINTS) {
      expect(entry.why.length, entry.path).toBeGreaterThan(20);
    }
    expect(TRAINING_SCAN_EXEMPT.length).toBe(2);
  });

  it('covers both services the design names, and every channel', () => {
    const services = new Set(SERVICE_ENTRY_POINTS.map((entry) => entry.service));
    expect(services.has('DiagnosisService')).toBe(true);
    expect(services.has('ChatService')).toBe(true);

    const channels = new Set(CHANNEL_ENTRY_POINTS.map((entry) => entry.channel));
    expect([...channels].sort()).toEqual(['web', 'whatsapp']);
  });
});

describe('formatReport', () => {
  it('names the file, the line and the rule of every violation, and ends in FAIL', () => {
    const output = formatReport(
      runRules({
        modules: [
          ...happyTree(),
          fixture('src/lib/rogue.ts', "import { chatPrompt } from '@/lib/prompts';"),
        ],
      }),
    );

    expect(output).toContain('src/lib/rogue.ts:1');
    expect(output).toContain('seam-consumer');
    expect(output).toContain('FAIL');
  });

  it('always prints the limits of the check, pass or fail', () => {
    const output = formatReport(runRules({ modules: happyTree() }));

    expect(output).toContain('LIMITS OF THIS CHECK');
    expect(output).toContain('DENYLIST');
  });

  it('reports a stale seam consumer without failing the run', () => {
    const report = runRules({ modules: [fixture('src/lib/noop.ts', 'export const x = 1;')] });

    expect(report.staleSeamConsumers.length).toBeGreaterThan(0);
    expect(formatReport(report)).toContain('STALE SEAM CONSUMERS');
  });
});
