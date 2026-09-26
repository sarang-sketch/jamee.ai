import { describe, expect, it } from 'vitest';

import {
  ALLOWLIST,
  BANNED_IMPORTS,
  blankComments,
  checkDataAccess,
  formatReport,
  isBannedSpecifier,
  isTestModule,
  isWithinDataAccessLayer,
  runOnRepo,
  type Finding,
  type SourceFile,
} from '../../scripts/check-data-access';

/**
 * Tests for the CI guard that keeps the mongodb driver behind the Data_Access_Layer door (task
 * 52.3, D18).
 *
 * Requirements: 13.7
 *
 * Most cases are inline fixtures rather than the real tree, for the reason `check-secret-scope`'s
 * own tests give: a guard asserted only against a passing repository proves it can say "PASS", not
 * that it can catch anything. One case uses the real tree — the guard must pass against `src/**`
 * with the four db-layer modules present and nothing else importing the driver.
 */

const fixture = (path: string, source: string): SourceFile => ({ path, source });

const violationRules = (findings: readonly Finding[]): string[] =>
  findings.filter((f) => f.severity === 'violation').map((f) => f.path);

const repoRoot = process.cwd();

/* ========================================================================== */
/* Comment blanking — the rule is only as good as this                         */
/* ========================================================================== */

describe('blankComments', () => {
  it('blanks a line comment mentioning the driver but keeps an import string literal', () => {
    const blanked = blankComments(
      ["import { MongoClient } from 'mongodb'; // never import mongodb elsewhere"].join('\n'),
    );
    expect(blanked).toContain("'mongodb'");
    expect(blanked).not.toContain('never import');
  });

  it('blanks a block comment that names the banned specifier as prose', () => {
    const source = ['/* nothing outside src/lib/db imports mongodb */', 'const a = 1;'].join('\n');
    const blanked = blankComments(source);
    expect(blanked.split('\n')[0]?.trim()).toBe('');
    expect(blanked).toContain('const a = 1;');
  });

  it('preserves length and every newline offset, so reported line numbers are real', () => {
    const source = ['// one', "import x from 'mongodb'; /* two", 'three */ const b = 2;', ''].join('\n');
    const blanked = blankComments(source);
    expect(blanked).toHaveLength(source.length);
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] === '\n') expect(blanked[i]).toBe('\n');
    }
  });

  it('keeps a template literal that contains a slash-slash sequence', () => {
    const blanked = blankComments('const u = `https://x`; // trailing');
    expect(blanked).toContain('`https://x`');
    expect(blanked).not.toContain('trailing');
  });
});

/* ========================================================================== */
/* Specifier classification                                                    */
/* ========================================================================== */

describe('isBannedSpecifier', () => {
  it('bans the driver package and its subpaths', () => {
    expect(isBannedSpecifier('mongodb')).toBe(true);
    expect(isBannedSpecifier('mongodb/lib/foo')).toBe(true);
  });

  it('bans the raw client module', () => {
    expect(isBannedSpecifier('@/lib/db/client')).toBe(true);
  });

  it('allows the layer public surface and unrelated packages', () => {
    expect(isBannedSpecifier('@/lib/db/farmer')).toBe(false);
    expect(isBannedSpecifier('@/lib/db/collections')).toBe(false);
    expect(isBannedSpecifier('@/lib/media/gridfs')).toBe(false);
    expect(isBannedSpecifier('mongodb-memory-server')).toBe(false);
    expect(isBannedSpecifier('zod')).toBe(false);
  });

  it('every declared banned import is recognised', () => {
    for (const banned of BANNED_IMPORTS) expect(isBannedSpecifier(banned)).toBe(true);
  });
});

describe('path classification', () => {
  it('recognises the Data_Access_Layer directory', () => {
    expect(isWithinDataAccessLayer('src/lib/db/farmer.ts')).toBe(true);
    expect(isWithinDataAccessLayer('src/lib/db/client.ts')).toBe(true);
    expect(isWithinDataAccessLayer('src/services/diagnosis.service.ts')).toBe(false);
  });

  it('recognises test modules', () => {
    expect(isTestModule('tests/unit/x.test.ts')).toBe(true);
    expect(isTestModule('src/lib/db/farmer.test.ts')).toBe(true);
    expect(isTestModule('src/services/diagnosis.service.ts')).toBe(false);
  });
});

/* ========================================================================== */
/* The rule                                                                    */
/* ========================================================================== */

describe('checkDataAccess', () => {
  it('flags a driver import in a service module as a violation', () => {
    const findings = checkDataAccess([
      fixture('src/services/diagnosis.service.ts', "import { ObjectId } from 'mongodb';\n"),
    ]);
    expect(violationRules(findings)).toEqual(['src/services/diagnosis.service.ts']);
  });

  it('flags a raw-client import in a route handler as a violation', () => {
    const findings = checkDataAccess([
      fixture('src/app/api/diagnose/route.ts', "import { getDb } from '@/lib/db/client';\n"),
    ]);
    expect(violationRules(findings)).toEqual(['src/app/api/diagnose/route.ts']);
  });

  it('allows the driver inside the Data_Access_Layer (a note, not a violation)', () => {
    const findings = checkDataAccess([
      fixture('src/lib/db/client.ts', "import { MongoClient } from 'mongodb';\n"),
      fixture('src/lib/db/farmer.ts', "import { type Collection } from 'mongodb';\n"),
    ]);
    expect(violationRules(findings)).toEqual([]);
    expect(findings.every((f) => f.severity === 'note')).toBe(true);
  });

  it('allows the allowlisted setup script', () => {
    const findings = checkDataAccess([
      fixture(ALLOWLIST[0], "import { GridFSBucket } from 'mongodb';\n"),
    ]);
    expect(violationRules(findings)).toEqual([]);
  });

  it('allows a test module to import the driver', () => {
    const findings = checkDataAccess([
      fixture('src/lib/db/farmer.test.ts', "import { ObjectId } from 'mongodb';\n"),
      fixture('src/services/quota.service.test.ts', "import { ObjectId } from 'mongodb';\n"),
    ]);
    expect(violationRules(findings)).toEqual([]);
  });

  it('does not flag the layer public surface imported from a service', () => {
    const findings = checkDataAccess([
      fixture(
        'src/services/diagnosis.service.ts',
        "import { farmerData } from '@/lib/db/farmer';\nimport { COLLECTIONS } from '@/lib/db/collections';\n",
      ),
    ]);
    expect(findings).toEqual([]);
  });

  it('does not mistake a prose mention of the driver for an import', () => {
    const findings = checkDataAccess([
      fixture(
        'src/services/chat.service.ts',
        '// This module never touches mongodb directly; it goes through farmerData.\nexport const x = 1;\n',
      ),
    ]);
    expect(findings).toEqual([]);
  });

  it('catches a dynamic import() of the driver', () => {
    const findings = checkDataAccess([
      fixture('src/lib/rate-limit.ts', "const m = await import('mongodb');\n"),
    ]);
    expect(violationRules(findings)).toEqual(['src/lib/rate-limit.ts']);
  });
});

/* ========================================================================== */
/* The real tree                                                               */
/* ========================================================================== */

describe('the guard passes against src/** as it stands', () => {
  it('reports no violations', () => {
    const findings = runOnRepo(repoRoot);
    const violations = findings.filter((f) => f.severity === 'violation');
    expect(violations, formatReport(findings)).toEqual([]);
  });

  it('confirms the Data_Access_Layer is where the driver lives', () => {
    const findings = runOnRepo(repoRoot);
    const layerNotes = findings.filter(
      (f) => f.severity === 'note' && isWithinDataAccessLayer(f.path),
    );
    // client.ts imports the driver; farmer.ts imports its types — at least one note expected.
    expect(layerNotes.length).toBeGreaterThan(0);
  });
});
