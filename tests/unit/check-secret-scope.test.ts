import { describe, expect, it } from 'vitest';

import {
  OPAQUE_PAYLOAD_ALLOWANCES,
  blankComments,
  checkEnvDoor,
  checkSecretScope,
  checkServiceRoleAnchors,
  collectSourceFiles,
  extractQueryStatements,
  formatReport,
  hasUseClientDirective,
  isWithinServerSurface,
  runRules,
  type Finding,
  type SourceFile,
} from '../../scripts/check-secret-scope';

/**
 * Tests for the CI guard itself.
 *
 * Requirements: 13.7
 *
 * Almost every case is a **fixture** — a small `SourceFile` written inline — rather than the real
 * tree, for two reasons. A guard asserted only against a passing repository proves that it says
 * "PASS", not that it can say anything else; and a fixture pins the exact shape each rule is
 * supposed to catch, so a later refactor of the matcher cannot quietly stop catching it.
 *
 * Three cases do use the real tree, because that is the claim they make: the guard passes against
 * `src/**` as it stands, every allowance still corresponds to a real statement, and the comment
 * blanker survives 90-odd real TypeScript modules without losing its place.
 */

const fixture = (path: string, source: string): SourceFile => ({ path, source });

const rulesOf = (findings: readonly Finding[]): string[] =>
  findings.filter((f) => f.severity === 'violation').map((f) => f.rule);

/* ========================================================================== */
/* Comment blanking — the rules are only as good as this                       */
/* ========================================================================== */

describe('blankComments', () => {
  it('blanks line and block comments but keeps string literals', () => {
    const blanked = blankComments(
      ["const key = 'GEMINI_API_KEY'; // reads GEMINI_API_KEY", '/* GEMINI_API_KEY */'].join('\n'),
    );

    expect(blanked).toContain("'GEMINI_API_KEY'");
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
    // The exact regression that made an earlier version mis-scan 500 lines of a real module and
    // report a comment that mentions SUPABASE_SERVICE_ROLE_KEY as a use of it.
    const source = [
      "const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;",
      '/** never reads `SUPABASE_SERVICE_ROLE_KEY` */',
      'const after = 1;',
    ].join('\n');
    const blanked = blankComments(source);

    expect(blanked).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(blanked).toContain('const after = 1;');
  });

  it('treats an escaped slash inside a regex literal as regex, not as a comment', () => {
    const source = "const re = /^[0-9a-f-]{36}\\/\\d{4}$/; const secret = 'GROQ_API_KEY';";

    expect(blankComments(source)).toContain("'GROQ_API_KEY'");
  });

  it('keeps its place across every real module under src/', () => {
    for (const file of collectSourceFiles()) {
      const blanked = blankComments(file.source);
      expect(blanked, file.path).toHaveLength(file.source.length);
      // A lost scanner state shows up first as a mangled newline map, which is what would make
      // every reported line number in that file wrong.
      const originalLines = file.source.split('\n').length;
      expect(blanked.split('\n').length, file.path).toBe(originalLines);
    }
  });
});

/* ========================================================================== */
/* Assertion 1 — secret scope                                                  */
/* ========================================================================== */

describe('checkSecretScope', () => {
  it('accepts a secret named inside the server surface', () => {
    const findings = checkSecretScope(
      fixture('src/lib/gemini.ts', "const key = serverEnv('GEMINI_API_KEY');"),
    );

    expect(rulesOf(findings)).toEqual([]);
  });

  it("flags a secret in a 'use client' module", () => {
    const findings = checkSecretScope(
      fixture('src/lib/leaky.ts', ["'use client';", "const k = 'GEMINI_API_KEY';"].join('\n')),
    );

    expect(rulesOf(findings)).toContain('secret-in-client');
  });

  it('flags a secret outside the server surface', () => {
    const findings = checkSecretScope(
      fixture('src/services/leaky.service.ts', "serverEnv('SUPABASE_SERVICE_ROLE_KEY');"),
    );

    expect(rulesOf(findings)).toEqual(['secret-out-of-surface']);
    expect(findings[0]?.line).toBe(1);
  });

  it('does not flag a secret named only in prose', () => {
    const findings = checkSecretScope(
      fixture(
        'src/components/Uploader.tsx',
        ['/** This component never reads SUPABASE_SERVICE_ROLE_KEY. */', 'export const x = 1;'].join(
          '\n',
        ),
      ),
    );

    expect(rulesOf(findings)).toEqual([]);
  });

  it('reports the real line number after a multi-line comment', () => {
    const findings = checkSecretScope(
      fixture(
        'src/components/Uploader.tsx',
        ['/**', ' * prose', ' */', "const k = 'GROQ_API_KEY';"].join('\n'),
      ),
    );

    expect(findings[0]?.line).toBe(4);
  });

  it('places src/proxy.ts and src/app/api/internal inside the server surface', () => {
    expect(isWithinServerSurface('src/proxy.ts')).toBe(true);
    expect(isWithinServerSurface('src/app/api/internal/retention/route.ts')).toBe(true);
    expect(isWithinServerSurface('src/components/SignInForm.tsx')).toBe(false);
  });

  it("recognises a 'use client' directive only as a directive", () => {
    expect(hasUseClientDirective("'use client';\nexport const x = 1;")).toBe(true);
    expect(hasUseClientDirective('/** importing from a "use client" module fails */')).toBe(false);
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
        checkEnvDoor(
          fixture('src/lib/env.public.ts', 'const u = process.env.NEXT_PUBLIC_SUPABASE_URL;'),
        ),
      ),
    ).toEqual([]);
  });

  it('flags process.env anywhere else', () => {
    const findings = checkEnvDoor(
      fixture('src/services/quota.service.ts', 'const k = process.env.SOMETHING;'),
    );

    expect(rulesOf(findings)).toEqual(['env-door']);
  });

  it('exempts a test module with a note rather than a violation', () => {
    const findings = checkEnvDoor(
      fixture('src/app/api/whatsapp/route.test.ts', "process.env.WHATSAPP_APP_SECRET = 's';"),
    );

    expect(rulesOf(findings)).toEqual([]);
    expect(findings.map((f) => f.severity)).toEqual(['note']);
  });

  it('flags a literal NEXT_PUBLIC read outside env.public.ts', () => {
    const findings = checkEnvDoor(
      fixture('src/lib/supabase/client.ts', 'const u = process.env.NEXT_PUBLIC_SUPABASE_URL;'),
    );

    expect(rulesOf(findings)).toEqual(['env-door', 'public-env-split']);
  });

  it("flags env.public.ts if it ever imports 'server-only'", () => {
    const findings = checkEnvDoor(
      fixture(
        'src/lib/env.public.ts',
        ["import 'server-only';", 'const u = process.env.NEXT_PUBLIC_SUPABASE_URL;'].join('\n'),
      ),
    );

    expect(rulesOf(findings)).toEqual(['public-env-split']);
  });

  it('flags a server secret named in env.public.ts', () => {
    const findings = checkEnvDoor(
      fixture(
        'src/lib/env.public.ts',
        [
          'const u = process.env.NEXT_PUBLIC_SUPABASE_URL;',
          "const s = process.env.SUPABASE_SERVICE_ROLE_KEY;",
        ].join('\n'),
      ),
    );

    expect(rulesOf(findings)).toEqual(['public-env-split']);
  });

  it("flags env.ts if it loses its 'server-only' marker", () => {
    const findings = checkEnvDoor(fixture('src/lib/env.ts', 'const raw = process.env[key];'));

    expect(rulesOf(findings)).toEqual(['public-env-split']);
  });

  it('flags env.public.ts if its literal NEXT_PUBLIC reads become computed', () => {
    const findings = checkEnvDoor(
      fixture('src/lib/env.public.ts', 'const u = process.env[PUBLIC_ENV_VARS[0]];'),
    );

    expect(rulesOf(findings)).toEqual(['public-env-split']);
  });
});

/* ========================================================================== */
/* Assertion 3 — tenant anchors on farmer-scoped statements                    */
/* ========================================================================== */

describe('extractQueryStatements', () => {
  it('cuts the chain out to the end of the statement', () => {
    const [statement] = extractQueryStatements(
      "const { data } = await client.from('messages').select('*').eq('user_id', id);\nnext();",
    );

    expect(statement?.table).toBe('messages');
    expect(statement?.text).toBe(".from('messages').select('*').eq('user_id', id)");
  });

  it('stops at a comma when the chain is one element of an array', () => {
    const [statement] = extractQueryStatements(
      "await Promise.all([supabase.from('profiles').select('*').eq('id', u).maybeSingle(), other()]);",
    );

    expect(statement?.text).toBe(".from('profiles').select('*').eq('id', u).maybeSingle()");
  });
});

describe('checkServiceRoleAnchors', () => {
  const at = (source: string, path = 'src/services/fixture.service.ts'): Finding[] =>
    checkServiceRoleAnchors(fixture(path, source));

  it('accepts a user_id predicate', () => {
    expect(rulesOf(at("await client.from('messages').select('*').eq('user_id', id);"))).toEqual([]);
  });

  it('accepts id on profiles, whose primary key is the auth user id', () => {
    expect(rulesOf(at("await client.from('profiles').select('*').eq('id', userId);"))).toEqual([]);
  });

  it('accepts provider_message_id on whatsapp_inbound, its primary key', () => {
    expect(
      rulesOf(
        at("await client.from('whatsapp_inbound').update({ status }).eq('provider_message_id', m);"),
      ),
    ).toEqual([]);
  });

  it('accepts a .match({ user_id }) predicate', () => {
    expect(rulesOf(at("await client.from('diagnoses').select('*').match({ user_id: id });"))).toEqual(
      [],
    );
  });

  it('flags an unanchored select', () => {
    const findings = at("const { data } = await client.from('diagnoses').select('*').limit(10);");

    expect(rulesOf(findings)).toEqual(['service-role-anchor']);
    expect(findings[0]?.message).toContain('Unanchored select');
  });

  it('flags an unanchored delete', () => {
    const findings = at("await client.from('messages').delete().lt('created_at', cutoff);");

    expect(rulesOf(findings)).toEqual(['service-role-anchor']);
  });

  it('flags an unanchored update', () => {
    expect(rulesOf(at("await client.from('conversations').update({ title });"))).toEqual([
      'service-role-anchor',
    ]);
  });

  it('accepts an insert whose literal payload sets user_id', () => {
    expect(
      rulesOf(at("await client.from('conversations').insert({ user_id: userId, channel });")),
    ).toEqual([]);
  });

  it('flags an insert whose literal payload sets no anchor', () => {
    const findings = at("await client.from('messages').insert({ role: 'farmer', body });");

    expect(rulesOf(findings)).toEqual(['service-role-anchor']);
    expect(findings[0]?.message).toContain('visible payload that sets none of');
  });

  it('resolves a preceding const object literal', () => {
    const findings = at(
      [
        'const row: ProfileBootstrapRow = { id: user.id, phone };',
        "await writer.from('profiles').upsert(row, { onConflict: 'id' });",
      ].join('\n'),
    );

    expect(rulesOf(findings)).toEqual([]);
  });

  it('treats an ambiguous const binding as unseen rather than resolving the wrong one', () => {
    // Two `const row = { … }` bindings before the statement: which one reaches it is a scope
    // question this script does not answer, so it must fall through to the allowance check.
    const findings = at(
      [
        'const row = { user_id: a };',
        'const row = { user_id: b };',
        "await client.from('messages').insert(row);",
      ].join('\n'),
    );

    expect(rulesOf(findings)).toEqual(['service-role-anchor']);
    expect(findings[0]?.message).toContain('cannot see');
  });

  it('fails closed on an unlisted opaque payload', () => {
    const findings = at("await client.from('usage_logs').insert(row);");

    expect(rulesOf(findings)).toEqual(['service-role-anchor']);
    expect(findings[0]?.message).toContain('OPAQUE_PAYLOAD_ALLOWANCES');
  });

  it('downgrades a listed opaque payload to a note that names the reason', () => {
    const findings = checkServiceRoleAnchors(
      fixture('src/services/voice.service.ts', "await auditClient.from('usage_logs').insert(row);"),
    );

    expect(rulesOf(findings)).toEqual([]);
    expect(findings[0]?.severity).toBe('note');
    expect(findings[0]?.message).toContain('UNPROVEN');
  });

  it('ignores disease_knowledge, which holds no farmer data', () => {
    expect(rulesOf(at("await client.from('disease_knowledge').select('*');"))).toEqual([]);
  });

  it('ignores a storage bucket, which is not a table', () => {
    expect(rulesOf(at("await client.storage.from('crop-images').remove([path]);"))).toEqual([]);
  });

  it('accepts an rpc call carrying p_user', () => {
    expect(
      rulesOf(at("await client.rpc('counter_try_increment', { p_user: id, p_limit: n });")),
    ).toEqual([]);
  });

  it('flags an rpc call with no farmer argument', () => {
    const findings = at("await client.rpc('counter_used', { p_operation: op });");

    expect(rulesOf(findings)).toEqual(['service-role-anchor']);
    expect(findings[0]?.message).toContain('no farmer argument');
  });

  it('does not let a later call satisfy an earlier unanchored one', () => {
    const findings = at(
      [
        "await client.rpc('counter_used', { p_operation: op });",
        "await client.rpc('counter_decrement', { p_user: id });",
      ].join('\n'),
    );

    expect(rulesOf(findings)).toEqual(['service-role-anchor']);
    expect(findings[0]?.line).toBe(1);
  });

  it('exempts a function listed as tenant-free', () => {
    expect(rulesOf(at("await client.rpc('counter_prune_minute_windows', { p_older_than: 60 });"))).toEqual(
      [],
    );
  });

  it('skips test modules, whose fake clients are not queries', () => {
    expect(
      checkServiceRoleAnchors(
        fixture('src/services/fixture.service.test.ts', "stub.from('messages').select('*');"),
      ),
    ).toEqual([]);
  });
});

/* ========================================================================== */
/* The run, against the tree it gates                                          */
/* ========================================================================== */

describe('runRules against src/', () => {
  const report = runRules(collectSourceFiles());

  it('finds no violation in the current tree', () => {
    const violations = report.findings.filter((f) => f.severity === 'violation');

    expect(formatReport(report)).toContain('PASS');
    expect(violations).toEqual([]);
  });

  it('scans a plausible number of modules', () => {
    expect(report.scannedFiles).toBeGreaterThan(50);
  });

  it('has no stale opaque-payload allowance', () => {
    expect(report.staleAllowances).toEqual([]);
  });

  it('justifies every allowance', () => {
    for (const allowance of OPAQUE_PAYLOAD_ALLOWANCES) {
      expect(allowance.why.length, `${allowance.path}::${allowance.table}`).toBeGreaterThan(20);
    }
  });
});

describe('formatReport', () => {
  it('names the file, the line and the rule of every violation, and ends in FAIL', () => {
    const output = formatReport(
      runRules([fixture('src/services/leaky.service.ts', "process.env.GROQ_API_KEY;")]),
    );

    expect(output).toContain('src/services/leaky.service.ts:1');
    expect(output).toContain('secret-out-of-surface');
    expect(output).toContain('env-door');
    expect(output).toContain('FAIL');
  });

  it('always prints the limits of the check, pass or fail', () => {
    const output = formatReport(runRules([fixture('src/lib/noop.ts', 'export const x = 1;')]));

    expect(output).toContain('LIMITS OF THIS CHECK');
    expect(output).toContain('PASS');
  });
});
