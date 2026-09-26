/**
 * `check-data-access` — the CI gate that keeps the MongoDB driver, and the raw database handle,
 * behind the one door the Data_Access_Layer is supposed to be.
 *
 * Requirements: 13.7 (the MongoDB connection credential and every direct database handle live only
 *               in server-side modules within the Data_Access_Layer)
 * Design: D18 (*"a CI check fails the build if any file outside `src/lib/db/**` imports `mongodb`
 *         or the raw handle … the sibling of the existing `check-secret-scope.ts`"*),
 *         "Static architecture check (CI)"
 * Wired into CI by task 63.5; run standalone with `npm run check:data-access`.
 *
 * Run it:  `npm run check:data-access`  (exits 0 clean, 1 on any violation)
 *
 * =============================================================================
 * WHAT THIS PROVES, AND WHY IT HAS TO BE A STATIC CHECK
 * =============================================================================
 *
 * D18 makes tenant isolation application-enforced: one module holds the `MongoClient`, exposes only
 * owner-scoped accessors, and never offers a `find(arbitraryFilter)` seam. That guarantee is only
 * as strong as the claim that NOTHING ELSE reaches the driver — because a route handler that
 * imported `mongodb` directly could write the unscoped query the accessors refuse to express, and
 * no behavioural test can prove such a query is *un-writable*, only that the ones that exist happen
 * to be scoped. Proving an ABSENCE is what a static check is for, which is exactly why the design
 * pairs this with `check-secret-scope.ts` (secrets are server-only) and the `profiles.phone`
 * reader-free check: three absences, each enforced by a grep-that-understands-comments rather than
 * by reviewer vigilance.
 *
 * The rule, stated once: no file under `src/**` OTHER than `src/lib/db/**` may import the `mongodb`
 * package, or `@/lib/db/client` (the raw `MongoClient`/`Db` handle). The allowlist adds
 * `scripts/db-setup.ts` — the setup entry point legitimately drives collection and index creation
 * through the driver — and test modules, which build fixtures against the layer. Everything else
 * reaches data through `src/lib/db/farmer.ts`'s owner-scoped accessors.
 *
 * =============================================================================
 * WHY THIS IS NOT A LITERAL GREP
 * =============================================================================
 *
 * The same reason `check-secret-scope.ts` is not: the identifiers this rule bans by NAME appear far
 * more often in prose than in code. `src/lib/db/farmer.ts`'s own header explains, in a comment, that
 * "nothing outside `src/lib/db/**` imports the `mongodb` driver" — a literal grep for `'mongodb'`
 * would flag that sentence. So every file is scanned through a **comment-blanked** copy: comments
 * become spaces byte-for-byte (line and column numbers stay real), while string literals are kept,
 * because an import specifier IS a string literal (`from 'mongodb'`) and is exactly what the rule
 * must see.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ========================================================================== */
/* The facts the rule is written against                                       */
/* ========================================================================== */

/**
 * Import specifiers that mean "this module reached the driver or the raw handle".
 *
 *  - `mongodb` — the driver package itself, including deep imports like `mongodb/lib/...`.
 *  - `@/lib/db/client` — the module that constructs and caches the `MongoClient` and exposes the
 *    raw `Db`. Reaching it from outside the layer is reaching the handle by a different name, so it
 *    is banned on the same footing as the package.
 *
 * `@/lib/db/farmer`, `@/lib/db/collections`, and `@/lib/media/*` are deliberately NOT here: those
 * are the layer's public surface (owner-scoped accessors, document types, GridFS-by-metadata), and
 * importing them is the correct thing every service and route does.
 */
export const BANNED_IMPORTS = ['mongodb', '@/lib/db/client'] as const;

/** The directory whose files ARE the Data_Access_Layer and so may hold the driver. */
export const DATA_ACCESS_DIR = 'src/lib/db/';

/**
 * Files outside `src/lib/db/**` that may still import the driver, each for a stated reason.
 *
 *  - `scripts/db-setup.ts` — the `npm run db:setup` entry point. It creates collections, indexes,
 *    `$jsonSchema` validators and the GridFS bucket, which is raw-driver work by nature (D18 names
 *    it explicitly as the one script allowed to). It is scanned only when the scan root includes
 *    `scripts/`; listed here so that, wherever the root reaches it, it is an allowance and not a
 *    violation.
 *
 * Test modules (`*.test.ts` / `*.test.tsx`) are exempt as a class rather than by name: a test builds
 * fixtures and drives the real accessors, neither ships, and enumerating every test file would be a
 * maintenance tax with no safety gain. Their imports are reported as notes so the exemption is
 * visible rather than silent.
 */
export const ALLOWLIST = ['scripts/db-setup.ts'] as const;

/** The scan root — the code that ships. `scripts/**` is not scanned here (see the honesty note). */
export const SCAN_ROOTS = ['src'] as const;

/* ========================================================================== */
/* Types                                                                       */
/* ========================================================================== */

export interface SourceFile {
  /** POSIX-style path relative to the repo root, e.g. `src/services/diagnosis.service.ts`. */
  readonly path: string;
  readonly source: string;
}

export interface Finding {
  readonly severity: 'violation' | 'note';
  readonly rule: string;
  readonly path: string;
  readonly line: number;
  readonly detail: string;
}

/* ========================================================================== */
/* Comment blanking — the rule is only as good as this                         */
/* ========================================================================== */

/**
 * Replace every comment with spaces, byte-for-byte, keeping newlines so reported line numbers are
 * the real ones. String and template literals are preserved, because an import specifier is a
 * string literal the rule must see. A compact single-purpose scanner — enough to tell a comment
 * from a string in TypeScript, which is all this rule needs.
 */
export function blankComments(source: string): string {
  const out: string[] = new Array(source.length);
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let quote: string | null = null;
  let inTemplate = false;

  const put = (index: number, keep: boolean): void => {
    const ch = source[index]!;
    out[index] = keep ? ch : ch === '\n' ? '\n' : ' ';
  };

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (inLine) {
      put(i, false);
      if (ch === '\n') inLine = false;
      i += 1;
      continue;
    }
    if (inBlock) {
      put(i, false);
      if (ch === '*' && next === '/') {
        put(i + 1, false);
        i += 2;
        inBlock = false;
        continue;
      }
      i += 1;
      continue;
    }
    if (quote !== null) {
      out[i] = ch;
      if (ch === '\\') {
        if (i + 1 < source.length) out[i + 1] = source[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === quote || ch === '\n') quote = null;
      i += 1;
      continue;
    }
    if (inTemplate) {
      out[i] = ch;
      if (ch === '\\') {
        if (i + 1 < source.length) out[i + 1] = source[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '`') inTemplate = false;
      i += 1;
      continue;
    }

    // Not currently inside anything.
    if (ch === '/' && next === '/') {
      inLine = true;
      put(i, false);
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      put(i, false);
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out[i] = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      out[i] = ch;
      i += 1;
      continue;
    }
    out[i] = ch;
    i += 1;
  }

  return out.join('');
}

/* ========================================================================== */
/* The rule                                                                    */
/* ========================================================================== */

const IMPORT_OR_REQUIRE = /(?:import\b[^'"]*?from\s*|import\s*|require\s*\(\s*|import\s*\(\s*)(['"])([^'"]+)\1/g;

/** Does `specifier` name a banned target? `mongodb` matches `mongodb` and any `mongodb/...` subpath. */
export function isBannedSpecifier(specifier: string): boolean {
  return BANNED_IMPORTS.some((banned) => specifier === banned || specifier.startsWith(`${banned}/`));
}

export function isWithinDataAccessLayer(path: string): boolean {
  return path.startsWith(DATA_ACCESS_DIR);
}

export function isAllowlisted(path: string): boolean {
  return ALLOWLIST.includes(path as (typeof ALLOWLIST)[number]);
}

export function isTestModule(path: string): boolean {
  return /\.test\.(?:ts|tsx)$/.test(path);
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/**
 * The single assertion: a non-test, non-allowlisted file outside `src/lib/db/**` that imports a
 * banned specifier is a violation. The same import inside the layer, in the allowlist, or in a test
 * is a note (or nothing), so a passing run still shows WHERE the driver legitimately lives.
 */
export function checkDataAccess(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const blanked = blankComments(file.source);
    IMPORT_OR_REQUIRE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = IMPORT_OR_REQUIRE.exec(blanked)) !== null) {
      const specifier = match[2]!;
      if (!isBannedSpecifier(specifier)) continue;

      const line = lineOf(blanked, match.index);
      const inLayer = isWithinDataAccessLayer(file.path);
      const allowed = isAllowlisted(file.path);
      const test = isTestModule(file.path);

      if (inLayer || allowed || test) {
        findings.push({
          severity: 'note',
          rule: 'data-access-driver-import',
          path: file.path,
          line,
          detail: `imports '${specifier}' — allowed (${inLayer ? 'Data_Access_Layer' : allowed ? 'allowlisted' : 'test module'})`,
        });
        continue;
      }

      findings.push({
        severity: 'violation',
        rule: 'data-access-driver-import',
        path: file.path,
        line,
        detail: `imports '${specifier}' outside src/lib/db/** — reach data through @/lib/db/farmer's owner-scoped accessors (D18)`,
      });
    }
  }

  return findings;
}

/* ========================================================================== */
/* File collection                                                             */
/* ========================================================================== */

const IGNORED_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage']);

export function collectSourceFiles(root: string, repoRoot: string): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') {
        if (IGNORED_DIRS.has(entry.name)) continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!/\.(?:ts|tsx)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      files.push({
        path: relative(repoRoot, full).split('\\').join('/'),
        source: readFileSync(full, 'utf8'),
      });
    }
  };

  if (existsSync(root)) walk(root);
  return files;
}

/* ========================================================================== */
/* Report + entry point                                                        */
/* ========================================================================== */

export function formatReport(findings: readonly Finding[]): string {
  const violations = findings.filter((f) => f.severity === 'violation');
  const notes = findings.filter((f) => f.severity === 'note');
  const lines: string[] = [];

  lines.push('check-data-access — the mongodb driver may live only under src/lib/db/**');
  lines.push('');

  if (notes.length > 0) {
    lines.push(`Allowed driver imports (${notes.length}):`);
    for (const n of notes) lines.push(`  note  ${n.path}:${n.line}  ${n.detail}`);
    lines.push('');
  }

  if (violations.length === 0) {
    lines.push('PASS — no module outside the Data_Access_Layer imports the driver or the raw handle.');
    return lines.join('\n');
  }

  lines.push(`FAIL — ${violations.length} violation(s):`);
  for (const v of violations) lines.push(`  ${v.path}:${v.line}  ${v.detail}`);
  return lines.join('\n');
}

/** Collect every scan root's files and run the rule. Exposed so the test can drive the real tree. */
export function runOnRepo(repoRoot: string): Finding[] {
  const files = SCAN_ROOTS.flatMap((r) => collectSourceFiles(resolve(repoRoot, r), repoRoot));
  return checkDataAccess(files);
}

function main(): void {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const findings = runOnRepo(repoRoot);
  const report = formatReport(findings);
  const failed = findings.some((f) => f.severity === 'violation');

  process.stdout.write(`${report}\n`);
  process.exit(failed ? 1 : 0);
}

/** Run only as a script, never on import (the test imports the pure functions above). */
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/');
  } catch {
    return false;
  }
})();

if (isMain || process.argv[1]?.endsWith('check-data-access.ts')) {
  main();
}
