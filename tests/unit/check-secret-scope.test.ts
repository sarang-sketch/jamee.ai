import { describe, expect, it } from 'vitest';

import {
  CLIENT_FORBIDDEN_UNPREFIXED,
  SERVER_SECRET_NAMES,
  blankComments,
  checkEnvDoor,
  checkSecretScope,
  collectSourceFiles,
  formatReport,
  hasUseClientDirective,
  isWithinServerSurface,
  runRules,
  type Finding,
  type SourceFile,
} from '../../scripts/check-secret-scope';

import { SERVER_ENV_KEYS } from '../../src/lib/env';

/**
 * Tests for the A3 secret-scope guard.
 *
 * Requirements: 13.7
 *
 * Almost every case is a **fixture** — a small `SourceFile` written inline — rather than the real
 * tree, for the reason the guard's own header gives: a guard asserted only against a passing
 * repository proves it can say "PASS", not that it can catch anything. A fixture pins the exact
 * shape each rule catches, so a later refactor cannot quietly stop catching it.
 *
 * Two cases use the real tree, because those are the claims they make: the guard passes against
 * `src/**` as it stands under A3, and the comment blanker survives every real TypeScript module
 * without losing its place. And one case asserts the guarded name list agrees with the actual
 * `serverEnvSchema`, so the two cannot drift.
 *
 * Amendment A3 removed the Supabase service-role anchoring assertion entirely (there is no RLS and
 * no `.from()` query builder anymore — the Data_Access_Layer is the boundary, proven by
 * `check-data-access.ts`), so this file has no service-role-anchor cases.
 */

const fixture = (path: string, source: string): SourceFile => ({ path, source });

const rulesOf = (findings: readonly Finding[]): string[] =>
  findings.filter((f) => f.severity === 'violation').map((f) => f.rule);

/* ========================================================================== */
/* The guarded name list agrees with the real serverEnvSchema                  */
/* ========================================================================== */

describe('the guarded names are drawn from the real env schema', () => {
  it('names only variables that exist in serverEnvSchema (A3 stack)', () => {
    for (const name of SERVER_SECRET_NAMES) {
      expect(SERVER_ENV_KEYS as readonly string[], name).toContain(name);
    }
  });

  it('guards MONGODB_URI, the Better Auth secret, the Google client credentials, and the payment/telegram secrets', () => {
    for (const expected of [
      'MONGODB_URI',
      'BETTER_AUTH_SECRET',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_WEBHOOK_SECRET_TOKEN',
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_SECRET',
      'RAZORPAY_WEBHOOK_SECRET',
      'GEMINI_API_KEY',
      'GROQ_API_KEY',
      'CRON_SECRET',
    ]) {
      expect(SERVER_SECRET_NAMES as readonly string[], expected).toContain(expected);
    }
  });

  it('no longer guards any Supabase or WhatsApp name', () => {
    for (const gone of [
      'SUPABASE_SERVICE_ROLE_KEY',
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_VERIFY_TOKEN',
    ]) {
      expect(SERVER_SECRET_NAMES as readonly string[], gone).not.toContain(gone);
    }
  });
});

/* ========================================================================== */
/* Comment blanking — the rules are only as good as this                       */
/* ========================================================================== */

describe('blankComments', () => {
  it('blanks line and block comments but keeps string literals', () => {
    const blanked = blankComments(
      ["const key = 'MONGODB_URI'; // reads MONGODB_URI", '/* MONGODB_URI */'].join('\n'),
    );

    expect(blanked).toContain("'MONGODB_URI'");
    expect(blanked.split('\n')[0]).not.toContain('reads');
    expect(blanked.split('\n')[1]?.trim()).toBe('');
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
      '/** never reads `RAZORPAY_KEY_SECRET` */',
      'const after = 1;',
    ].join('\n');
    const blanked = blankComments(source);

    expect(blanked).not.toContain('RAZORPAY_KEY_SECRET');
    expect(blanked).toContain('const after = 1;');
  });

  it('keeps its place across every real module under src/', () => {
    for (const file of collectSourceFiles()) {
      const blanked = blankComments(file.source);
      expect(blanked, file.path).toHaveLength(file.source.length);
      expect(blanked.split('\n').length, file.path).toBe(file.source.split('\n').length);
    }
  });
});

/* ========================================================================== */
/* Assertion 1 — secret scope                                                  */
/* ========================================================================== */

describe('checkSecretScope', () => {
  it('accepts a secret named inside the server surface', () => {
    expect(
      rulesOf(checkSecretScope(fixture('src/lib/gemini.ts', "const key = serverEnv('GEMINI_API_KEY');"))),
    ).toEqual([]);
  });

  it('accepts MONGODB_URI in the Data_Access_Layer client', () => {
    expect(
      rulesOf(checkSecretScope(fixture('src/lib/db/client.ts', "const uri = serverEnv('MONGODB_URI');"))),
    ).toEqual([]);
  });

  it("flags a secret in a 'use client' module", () => {
    const findings = checkSecretScope(
      fixture('src/lib/leaky.ts', ["'use client';", "const k = 'BETTER_AUTH_SECRET';"].join('\n')),
    );

    expect(rulesOf(findings)).toContain('secret-in-client');
  });

  it('flags the unprefixed RAZORPAY_KEY_ID in a client component, naming the public twin', () => {
    const findings = checkSecretScope(
      fixture(
        'src/components/BotUnlockCard.tsx',
        ["'use client';", "const id = process.env.RAZORPAY_KEY_ID;"].join('\n'),
      ),
    );

    expect(rulesOf(findings)).toContain('secret-in-client');
    expect(findings.find((f) => f.rule === 'secret-in-client')?.message).toContain(
      'NEXT_PUBLIC_RAZORPAY_KEY_ID',
    );
  });

  it('does NOT flag the NEXT_PUBLIC_RAZORPAY_KEY_ID twin in a client component', () => {
    const findings = checkSecretScope(
      fixture(
        'src/components/BotUnlockCard.tsx',
        ["'use client';", 'const id = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;'].join('\n'),
      ),
    );

    expect(rulesOf(findings)).toEqual([]);
  });

  it('flags a secret outside the server surface', () => {
    const findings = checkSecretScope(
      fixture('src/components/Uploader.tsx', "const k = 'GROQ_API_KEY';"),
    );

    expect(rulesOf(findings)).toEqual(['secret-out-of-surface']);
  });

  it('does not flag a secret named only in prose', () => {
    const findings = checkSecretScope(
      fixture(
        'src/components/Uploader.tsx',
        ['/** This component never reads BETTER_AUTH_SECRET. */', 'export const x = 1;'].join('\n'),
      ),
    );

    expect(rulesOf(findings)).toEqual([]);
  });

  it('reports the real line number after a multi-line comment', () => {
    const findings = checkSecretScope(
      fixture('src/components/Uploader.tsx', ['/**', ' * prose', ' */', "const k = 'GROQ_API_KEY';"].join('\n')),
    );

    expect(findings[0]?.line).toBe(4);
  });

  it('places src/proxy.ts, api/internal and api/auth inside the server surface', () => {
    expect(isWithinServerSurface('src/proxy.ts')).toBe(true);
    expect(isWithinServerSurface('src/app/api/internal/retention-sweep/route.ts')).toBe(true);
    expect(isWithinServerSurface('src/app/api/auth/[...all]/route.ts')).toBe(true);
    expect(isWithinServerSurface('src/components/BotUnlockCard.tsx')).toBe(false);
  });

  it("recognises a 'use client' directive only as a directive", () => {
    expect(hasUseClientDirective("'use client';\nexport const x = 1;")).toBe(true);
    expect(hasUseClientDirective('/** importing from a "use client" module fails */')).toBe(false);
  });

  it('names the client-forbidden unprefixed constant', () => {
    expect(CLIENT_FORBIDDEN_UNPREFIXED).toBe('RAZORPAY_KEY_ID');
  });
});

/* ========================================================================== */
/* Assertion 2 — one door to process.env, and the public/server split          */
/* ========================================================================== */

describe('checkEnvDoor', () => {
  it('allows process.env in the two env modules', () => {
    expect(
      rulesOf(checkEnvDoor(fixture('src/lib/env.ts', "import 'server-only';\nprocess.env[key];"))),
    ).toEqual([]);
    expect(
      rulesOf(
        checkEnvDoor(fixture('src/lib/env.public.ts', 'const u = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;')),
      ),
    ).toEqual([]);
  });

  it('flags process.env anywhere else', () => {
    expect(
      rulesOf(checkEnvDoor(fixture('src/services/quota.service.ts', 'const k = process.env.SOMETHING;'))),
    ).toEqual(['env-door']);
  });

  it('exempts a test module with a note rather than a violation', () => {
    const findings = checkEnvDoor(
      fixture('src/app/api/telegram/route.test.ts', "process.env.TELEGRAM_BOT_TOKEN = 't';"),
    );

    expect(rulesOf(findings)).toEqual([]);
    expect(findings.map((f) => f.severity)).toEqual(['note']);
  });

  it('flags a literal NEXT_PUBLIC read outside env.public.ts', () => {
    expect(
      rulesOf(
        checkEnvDoor(fixture('src/components/BotUnlockCard.tsx', 'const u = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;')),
      ),
    ).toEqual(['env-door', 'public-env-split']);
  });

  it("flags env.public.ts if it ever imports 'server-only'", () => {
    const findings = checkEnvDoor(
      fixture(
        'src/lib/env.public.ts',
        ["import 'server-only';", 'const u = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;'].join('\n'),
      ),
    );

    expect(rulesOf(findings)).toEqual(['public-env-split']);
  });

  it('flags a server secret named in env.public.ts', () => {
    const findings = checkEnvDoor(
      fixture(
        'src/lib/env.public.ts',
        [
          'const u = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;',
          'const s = process.env.BETTER_AUTH_SECRET;',
        ].join('\n'),
      ),
    );

    expect(rulesOf(findings)).toEqual(['public-env-split']);
  });

  it('does NOT flag NEXT_PUBLIC_RAZORPAY_KEY_ID in env.public.ts as a server secret', () => {
    const findings = checkEnvDoor(
      fixture('src/lib/env.public.ts', 'const id = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;'),
    );

    expect(rulesOf(findings)).toEqual([]);
  });

  it("flags env.ts if it loses its 'server-only' marker", () => {
    expect(rulesOf(checkEnvDoor(fixture('src/lib/env.ts', 'const raw = process.env[key];')))).toEqual([
      'public-env-split',
    ]);
  });

  it('flags env.public.ts if its literal NEXT_PUBLIC reads become computed', () => {
    expect(
      rulesOf(checkEnvDoor(fixture('src/lib/env.public.ts', 'const u = process.env[PUBLIC_ENV_VARS[0]];'))),
    ).toEqual(['public-env-split']);
  });
});

/* ========================================================================== */
/* The run, against the tree it gates                                          */
/* ========================================================================== */

describe('runRules against src/', () => {
  const report = runRules(collectSourceFiles());

  it('finds no violation in the current tree', () => {
    const violations = report.findings.filter((f) => f.severity === 'violation');

    expect(formatReport(report), formatReport(report)).toContain('PASS');
    expect(violations).toEqual([]);
  });

  it('scans a plausible number of modules', () => {
    expect(report.scannedFiles).toBeGreaterThan(50);
  });
});

describe('formatReport', () => {
  it('names the file, the line and the rule of every violation, and ends in FAIL', () => {
    const output = formatReport(
      runRules([fixture('src/services/leaky.service.ts', 'process.env.GROQ_API_KEY;')]),
    );

    expect(output).toContain('src/services/leaky.service.ts:1');
    expect(output).toContain('env-door');
    expect(output).toContain('FAIL');
  });

  it('always prints the limits of the check, pass or fail', () => {
    const output = formatReport(runRules([fixture('src/lib/noop.ts', 'export const x = 1;')]));

    expect(output).toContain('LIMITS OF THIS CHECK');
    expect(output).toContain('PASS');
  });
});
