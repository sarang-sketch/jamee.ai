import { describe, expect, it } from 'vitest';

import {
  CHANNEL_ENTRY_POINTS,
  ENTITLEMENT_FORBIDDEN_IMPORTERS,
  ENTITLEMENT_SERVICE_MODULE,
  FLOW_SEAMS,
  PHONE_READER_ALLOWLIST,
  SERVICE_ENTRY_POINTS,
  TRAINING_SCAN_EXEMPT,
  blankComments,
  blankSqlComments,
  checkChannelEntryPoints,
  checkEntitlementIsolation,
  checkLayering,
  checkNoTraining,
  checkPhoneReaderFree,
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
  parseImportClause,
  resolveSpecifier,
  runRules,
  type Finding,
  type SourceFile,
} from '../../scripts/check-shared-implementation';

/**
 * Tests for the architecture guard itself, Amendment A1/A3 (the adapter is Telegram; two new
 * structural checks — entitlement isolation and phone-reader-free).
 *
 * Requirements: 3.8, 7.7, 16.1, 16.2, 16.3, 16.4, 22.17, 1.9
 *
 * Almost every case is a **fixture** written inline rather than the real tree, for the reason the
 * guard's header gives: a guard asserted only against a passing repository proves it can say
 * "PASS", not anything else. The real tree appears in the run-against-the-repository block, because
 * those are the claims it is the evidence for: the guard passes as the codebase stands, no seam
 * consumer is stale, and the word "constraint" (90 occurrences) trips no training rule.
 *
 * This file is on `TRAINING_SCAN_EXEMPT` and has to be: several fixtures spell a forbidden
 * identifier.
 */

const fixture = (path: string, source: string): SourceFile => ({ path, source });

const rulesOf = (findings: readonly Finding[]): string[] =>
  findings.filter((f) => f.severity === 'violation').map((f) => f.rule);

const messagesOf = (findings: readonly Finding[]): string[] =>
  findings.filter((f) => f.severity === 'violation').map((f) => f.message);

/**
 * A minimal tree that satisfies the whole-tree rules at once, on the Telegram substrate. Each test
 * overrides one member and asserts on what changes.
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
    'src/app/api/telegram/route.ts':
      "import { dispatchTelegramRequest } from '@/lib/telegram-dispatch';",
    'src/lib/telegram-dispatch.ts': [
      "import { chatAnswerer } from '@/services/chat.service';",
      "import { diagnose as realDiagnose } from '@/services/diagnosis.service';",
      "import { transcribeAndAnswer as realTranscribeAndAnswer } from '@/services/voice.service';",
      'export async function dispatchTelegramRequest() {}',
      'export type DiagnoseFn = typeof realDiagnose;',
      'export type TranscribeAndAnswerFn = typeof realTranscribeAndAnswer;',
    ].join('\n'),
    ...overrides,
  };

  return Object.entries(modules).map(([path, source]) => fixture(path, source));
};

/* ========================================================================== */
/* Comment blanking                                                            */
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

  it('preserves length and every newline offset', () => {
    const source = ['// one', 'const a = 1; /* two', 'three */ const b = 2;', ''].join('\n');
    const blanked = blankComments(source);

    expect(blanked).toHaveLength(source.length);
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] === '\n') expect(blanked[i]).toBe('\n');
    }
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
      ['-- the constraint', 'create table x (id uuid primary key);'].join('\n'),
    );
    expect(blanked).not.toContain('the constraint');
    expect(blanked).toContain('create table x (id uuid primary key);');
  });
});

/* ========================================================================== */
/* Imports and exports                                                         */
/* ========================================================================== */

describe('parseImportClause', () => {
  it('resolves an alias to the source name', () => {
    expect(parseImportClause(' { diagnose as realDiagnose, type DiagnosisDeps } ').names).toEqual([
      'diagnose',
      'DiagnosisDeps',
    ]);
  });

  it('flags a namespace binding', () => {
    expect(parseImportClause(' * as prompts ')).toEqual({ names: [], namespace: true });
  });
});

describe('extractImports', () => {
  it('does not let an `export type X = Y;` statement swallow the next import', () => {
    const statements = extractImports(
      [
        'export type DiagnoseFn = typeof realDiagnose;',
        "import { diagnose } from '@/services/diagnosis.service';",
      ].join('\n'),
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]?.specifier).toBe('@/services/diagnosis.service');
  });

  it('reads a side-effect import and a dynamic import', () => {
    const specifiers = extractImports(
      ["import 'server-only';", "const m = await import('@/app/history/page');"].join('\n'),
    ).map((s) => s.specifier);
    expect(specifiers).toContain('server-only');
    expect(specifiers).toContain('@/app/history/page');
  });
});

describe('resolveSpecifier', () => {
  it('maps the @ alias onto src/', () => {
    expect(resolveSpecifier('src/lib/x.ts', '@/services/chat.service')).toBe('src/services/chat.service');
  });
});

describe('exportedNames', () => {
  it('reads every declaration form', () => {
    const names = exportedNames(
      ['export async function diagnose() {}', 'export type DiagnoseFn = () => void;'].join('\n'),
    );
    expect([...names].sort()).toEqual(['DiagnoseFn', 'diagnose']);
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
  });

  it('flags a service entry point nobody exports', () => {
    const findings = checkServiceModules(
      happyTree({ 'src/services/diagnosis.service.ts': 'export async function analyse() {}' }),
    );
    expect(messagesOf(findings)[0]).toContain("No module under src/ exports 'diagnose'");
  });
});

/* ========================================================================== */
/* Assertion 2 — every channel entry point imports the shared service          */
/* ========================================================================== */

describe('checkChannelEntryPoints', () => {
  it('accepts the happy tree', () => {
    expect(rulesOf(checkChannelEntryPoints(happyTree()))).toEqual([]);
  });

  it('flags the telegram route if it stops importing the dispatch pipeline', () => {
    const findings = checkChannelEntryPoints(
      happyTree({ 'src/app/api/telegram/route.ts': 'export async function POST() {}' }),
    );
    expect(rulesOf(findings)).toEqual(['channel-entry']);
    expect(messagesOf(findings)[0]).toContain('src/lib/telegram-dispatch.ts');
  });

  it('flags the telegram adapter if it stops importing a shared service', () => {
    const findings = checkChannelEntryPoints(
      happyTree({
        'src/lib/telegram-dispatch.ts': [
          "import { chatAnswerer } from '@/services/chat.service';",
          "import { transcribeAndAnswer as realTranscribeAndAnswer } from '@/services/voice.service';",
          'export async function dispatchTelegramRequest() {}',
        ].join('\n'),
      }),
    );
    expect(rulesOf(findings)).toContain('channel-entry');
    expect(messagesOf(findings).join(' ')).toContain('src/services/diagnosis.service.ts');
  });

  it('accepts the aliased diagnose import in the adapter (alias resolves to the source name)', () => {
    // `diagnose as realDiagnose` still satisfies a requirement for `diagnose`.
    expect(rulesOf(checkChannelEntryPoints(happyTree()))).toEqual([]);
  });
});

/* ========================================================================== */
/* Assertion 3 — the Telegram adapter's seams are the service functions         */
/* ========================================================================== */

describe('checkSeamTypes', () => {
  it('accepts the happy tree', () => {
    expect(rulesOf(checkSeamTypes(happyTree()))).toEqual([]);
  });

  it('flags a dispatch seam retyped as a hand-written shape', () => {
    const findings = checkSeamTypes(
      happyTree({
        'src/lib/telegram-dispatch.ts': [
          "import { diagnose as realDiagnose } from '@/services/diagnosis.service';",
          'export type DiagnoseFn = (ref: string) => Promise<unknown>;',
          'export type TranscribeAndAnswerFn = typeof realTranscribeAndAnswer;',
        ].join('\n'),
      }),
    );
    expect(rulesOf(findings)).toEqual(['seam-type']);
    expect(messagesOf(findings)[0]).toContain('DiagnoseFn');
  });

  it('is not satisfied by a sentence describing the seam', () => {
    const findings = checkSeamTypes(
      happyTree({
        'src/lib/telegram-dispatch.ts': [
          '/** DiagnoseFn = typeof realDiagnose, by design. */',
          'export type TranscribeAndAnswerFn = typeof realTranscribeAndAnswer;',
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
    return Object.entries({ ...modules, ...overrides }).map(([path, source]) => fixture(path, source));
  };

  it('accepts a tree where every seam is defined once', () => {
    expect(rulesOf(checkSeamDefinitions(seamTree()))).toEqual([]);
  });

  it('flags a second implementation of the grounding flow', () => {
    const findings = checkSeamDefinitions([
      ...seamTree(),
      fixture('src/lib/telegram-grounding.ts', 'export function rephrasePrompt() {}'),
    ]);
    expect(messagesOf(findings)[0]).toContain('Requirement 16.4');
  });

  it('flags a seam that has disappeared', () => {
    const findings = checkSeamDefinitions(
      seamTree({ 'src/lib/schemas.ts': 'export const somethingElse = 1;' }),
    );
    expect(messagesOf(findings)[0]).toContain("No module exports 'visionRawSchema'");
  });
});

/* ========================================================================== */
/* Assertion 5 — only a recorded owner imports a flow seam                     */
/* ========================================================================== */

describe('checkSeamConsumers', () => {
  it('accepts a recorded consumer', () => {
    expect(
      rulesOf(
        checkSeamConsumers(
          fixture('src/services/diagnosis.service.ts', "import { CLASSIFICATION_PROMPT } from '@/lib/prompts';"),
        ),
      ),
    ).toEqual([]);
  });

  it('flags a route handler reaching for the classification prompt', () => {
    expect(
      rulesOf(
        checkSeamConsumers(
          fixture('src/app/api/diagnose/route.ts', "import { CLASSIFICATION_PROMPT } from '@/lib/prompts';"),
        ),
      ),
    ).toEqual(['seam-consumer']);
  });

  it('flags the Telegram adapter reaching for the rephrase prompt', () => {
    expect(
      rulesOf(
        checkSeamConsumers(fixture('src/lib/telegram-dispatch.ts', "import { rephrasePrompt } from '@/lib/prompts';")),
      ),
    ).toEqual(['seam-consumer']);
  });

  it('flags a namespace import of a seam-defining module', () => {
    expect(
      rulesOf(checkSeamConsumers(fixture('src/app/api/chat/route.ts', "import * as prompts from '@/lib/prompts';"))),
    ).toEqual(['seam-consumer']);
  });

  it('does not flag a same-named symbol imported from somewhere else', () => {
    expect(
      rulesOf(checkSeamConsumers(fixture('src/lib/machine.ts', "import { interpret } from 'xstate';"))),
    ).toEqual([]);
  });

  it('exempts a test module', () => {
    expect(
      checkSeamConsumers(fixture('src/lib/prompts.test.ts', "import { rephrasePrompt } from '@/lib/prompts';")),
    ).toEqual([]);
  });
});

/* ========================================================================== */
/* Assertion 6 — the one-way layering rule                                     */
/* ========================================================================== */

describe('checkLayering', () => {
  it('flags a lib module importing a screen', () => {
    expect(
      rulesOf(checkLayering(fixture('src/lib/history.ts', "import { x } from '@/app/diagnosis/detail';"))),
    ).toEqual(['layering']);
  });

  it('says nothing about a screen importing a shared module', () => {
    expect(
      checkLayering(fixture('src/app/diagnosis/[id]/page.tsx', "import { lookupCondition } from '@/lib/knowledge';")),
    ).toEqual([]);
  });

  it('notes rather than fails a test module under a shared root', () => {
    const findings = checkLayering(
      fixture('src/lib/history.test.ts', "import { x } from '@/app/diagnosis/detail';"),
    );
    expect(rulesOf(findings)).toEqual([]);
    expect(findings.map((f) => f.severity)).toEqual(['note']);
  });
});

/* ========================================================================== */
/* Assertion 7 — no training                                                   */
/* ========================================================================== */

describe('checkNoTraining', () => {
  it('flags a fine-tuning call', () => {
    expect(
      rulesOf(checkNoTraining(fixture('src/lib/gemini.ts', 'await client.fineTuning.jobs.create({ model });'))),
    ).toEqual(['no-training']);
  });

  it('does NOT flag the word "constraint"', () => {
    expect(
      checkNoTraining(fixture('src/lib/knowledge.ts', "const m = 'violates check constraint';")),
    ).toEqual([]);
  });

  it('notes the two exempt files instead of scanning them', () => {
    for (const path of TRAINING_SCAN_EXEMPT) {
      const findings = checkNoTraining(fixture(path, 'const p = /fineTuning/;'));
      expect(rulesOf(findings), path).toEqual([]);
      expect(findings.map((f) => f.severity), path).toEqual(['note']);
    }
  });
});

describe('checkTrainingDependencies', () => {
  it('flags a model-training dependency', () => {
    expect(
      rulesOf(
        checkTrainingDependencies(
          fixture('package.json', JSON.stringify({ dependencies: { '@tensorflow/tfjs': '4.0.0' } })),
        ),
      ),
    ).toEqual(['no-training']);
  });

  it("accepts Jamee's real manifest", () => {
    const manifest = collectCodebaseFiles().find((file) => file.path === 'package.json');
    expect(manifest).toBeDefined();
    expect(checkTrainingDependencies(manifest as SourceFile)).toEqual([]);
  });
});

/* ========================================================================== */
/* Assertion 8 — the entitlement gate stays out of the services (A1/A3)        */
/* ========================================================================== */

describe('checkEntitlementIsolation', () => {
  it('flags the diagnosis service importing the entitlement service', () => {
    const findings = checkEntitlementIsolation(
      fixture('src/services/diagnosis.service.ts', "import { isActive } from '@/services/entitlement.service';"),
    );
    expect(rulesOf(findings)).toEqual(['entitlement-isolation']);
    expect(messagesOf(findings)[0]).toContain('22.17');
  });

  it('flags the chat and voice services too', () => {
    for (const path of ['src/services/chat.service.ts', 'src/services/voice.service.ts']) {
      expect(
        rulesOf(checkEntitlementIsolation(fixture(path, "import { isActive } from '@/services/entitlement.service';"))),
      ).toEqual(['entitlement-isolation']);
    }
  });

  it('does not flag the Telegram adapter, which is where the gate belongs', () => {
    expect(
      checkEntitlementIsolation(
        fixture('src/lib/telegram-dispatch.ts', "import { isActive } from '@/services/entitlement.service';"),
      ),
    ).toEqual([]);
  });

  it('does not flag a service that names the entitlement service only in prose', () => {
    expect(
      checkEntitlementIsolation(
        fixture('src/services/chat.service.ts', '/** The entitlement gate lives in the adapter, not here. */'),
      ),
    ).toEqual([]);
  });

  it('does not flag the entitlement service itself', () => {
    expect(
      checkEntitlementIsolation(fixture(ENTITLEMENT_SERVICE_MODULE, "import { getDb } from '@/lib/db/farmer';")),
    ).toEqual([]);
  });

  it('names all three forbidden importers', () => {
    expect([...ENTITLEMENT_FORBIDDEN_IMPORTERS].sort()).toEqual([
      'src/services/chat.service.ts',
      'src/services/diagnosis.service.ts',
      'src/services/voice.service.ts',
    ]);
  });
});

/* ========================================================================== */
/* Assertion 9 — profiles.phone is reader-free outside db-setup (A3)           */
/* ========================================================================== */

describe('checkPhoneReaderFree', () => {
  it('flags a member read of .phone in a shipping module', () => {
    const findings = checkPhoneReaderFree(
      fixture('src/lib/telegram-dispatch.ts', 'const p = profile.phone;'),
    );
    expect(rulesOf(findings)).toEqual(['phone-reader-free']);
    expect(messagesOf(findings)[0]).toContain('1.9');
  });

  it('does NOT flag the field declaration phone?: on ProfileDoc', () => {
    expect(
      checkPhoneReaderFree(fixture('src/lib/db/collections.ts', 'phone?: string | null;')),
    ).toEqual([]);
  });

  it("does NOT flag the DAL accessor's Pick<..., 'phone'> parameter type", () => {
    expect(
      checkPhoneReaderFree(
        fixture(
          'src/lib/db/farmer.ts',
          "setProfileFields(fields: Partial<Pick<ProfileDoc, 'displayName' | 'language' | 'phone'>>): Promise<void>;",
        ),
      ),
    ).toEqual([]);
  });

  it('does NOT flag prose about a mobile phone', () => {
    expect(
      checkPhoneReaderFree(
        fixture('src/components/ImageUploader.tsx', '/** no bytes leave the phone; a phone camera. */'),
      ),
    ).toEqual([]);
  });

  it('allowlists scripts/db-setup.ts', () => {
    expect(PHONE_READER_ALLOWLIST).toContain('scripts/db-setup.ts');
    expect(checkPhoneReaderFree(fixture('scripts/db-setup.ts', 'const p = doc.phone;'))).toEqual([]);
  });

  it('notes rather than fails a test module reading .phone', () => {
    const findings = checkPhoneReaderFree(fixture('src/lib/profile.test.ts', 'expect(p.phone).toBeUndefined();'));
    expect(rulesOf(findings)).toEqual([]);
    expect(findings.map((f) => f.severity)).toEqual(['note']);
  });

  it('does NOT flag phoneme or telephone (word boundary)', () => {
    expect(checkPhoneReaderFree(fixture('src/lib/x.ts', 'const a = obj.phoneme; const b = obj.telephoneNo;'))).toEqual(
      [],
    );
  });
});

/* ========================================================================== */
/* The run, against the tree it gates                                          */
/* ========================================================================== */

describe('runRules against the real repository', () => {
  const report = runRules({ modules: collectModules(), codebase: collectCodebaseFiles() });

  it('finds no violation in the current tree', () => {
    const violations = report.findings.filter((f) => f.severity === 'violation');
    expect(violations, formatReport(report)).toEqual([]);
    expect(formatReport(report)).toContain('PASS');
  });

  it('scans a plausible number of modules and files', () => {
    expect(report.scannedModules).toBeGreaterThan(50);
    expect(report.scannedCodebaseFiles).toBeGreaterThan(report.scannedModules);
  });

  it('has no stale seam consumer', () => {
    expect(report.staleSeamConsumers).toEqual([]);
  });

  it('covers both services the design names, and the web and telegram channels', () => {
    const services = new Set(SERVICE_ENTRY_POINTS.map((entry) => entry.service));
    expect(services.has('DiagnosisService')).toBe(true);
    expect(services.has('ChatService')).toBe(true);

    const channels = new Set(CHANNEL_ENTRY_POINTS.map((entry) => entry.channel));
    expect([...channels].sort()).toEqual(['telegram', 'web']);
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

  it('always prints the limits of the check', () => {
    const output = formatReport(runRules({ modules: happyTree() }));
    expect(output).toContain('LIMITS OF THIS CHECK');
    expect(output).toContain('DENYLIST');
  });
});
