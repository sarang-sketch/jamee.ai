/**
 * `check-secret-scope` — the CI gate that keeps Jamee's secrets on the server side of the
 * boundary and keeps `process.env` behind one door.
 *
 * Requirements: 13.7 (the guarded server credentials are referenced only in server-side modules
 *               and are excluded from every value sent to the browser)
 * Design: "Security boundary — Environment variables"; "Static architecture check (CI)"
 * Wired into CI by `.github/workflows/release-gates.yml` (the static job).
 *
 * Run it:  `npm run check:secret-scope`  (exits 0 clean, 1 on any violation)
 *
 * =============================================================================
 * AMENDMENT A3 — WHAT CHANGED, AND WHY ASSERTION 3 IS GONE
 * =============================================================================
 *
 * Under Supabase this guard had three assertions. The third — "every service-role query carries an
 * explicit `user_id` predicate" — existed because RLS was bypassed by the service-role client, so a
 * defence-in-depth predicate had to be proven on every `.from('table')` chain. **A3 removes
 * Supabase entirely.** There is no service-role key, no RLS to bypass, and no `.from()` query
 * builder: tenant isolation is now the Data_Access_Layer (D18), whose owner-scoped accessors merge
 * `{ ownerId }` into every filter, and whose module boundary is proven by the SEPARATE guard
 * `scripts/check-data-access.ts`. So assertion 3 has no subject anymore and is deleted rather than
 * ported — restating it against MongoDB would be inventing a rule the design does not have. The two
 * assertions that remain are the two that still have a subject:
 *
 * 1. **Secret scope.** Every name in `SERVER_SECRET_NAMES` appears only inside the server surface
 *    (`SERVER_SECRET_SURFACE`) and never in a module carrying a `'use client'` directive. The
 *    A3 names are MONGODB_URI, BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, the
 *    Telegram and Razorpay secrets, GEMINI/GROQ, and CRON_SECRET. The unprefixed RAZORPAY_KEY_ID is
 *    in the list specifically so the check proves it never appears in a client component (its
 *    NEXT_PUBLIC_ twin is the only spelling a client may read — V27, task 63.5).
 *
 * 2. **One door to `process.env`,** plus the public/server split that makes the door safe:
 *    `src/lib/env.ts` and `src/lib/env.public.ts` are the only readers; only `env.public.ts` reads
 *    a literal `process.env.NEXT_PUBLIC_*`; `env.public.ts` names no server secret and carries no
 *    `server-only` marker; `env.ts` carries one.
 *
 * =============================================================================
 * WHY THIS IS NOT A GREP
 * =============================================================================
 *
 * The design calls this "a CI grep". A literal grep is unusable here: every secret name and every
 * `process.env` occurrence that matters is outnumbered by *prose* mentions of the same identifier
 * in module documentation — `env.ts`'s own header names `MONGODB_URI` a dozen times in comments
 * explaining that it is the only holder of it. So every rule below runs against a
 * **comment-blanked** copy of each file: comments become spaces, byte for byte, so line and column
 * numbers stay real while a sentence about `RAZORPAY_KEY_SECRET` can no longer masquerade as a use
 * of it. String literals are deliberately KEPT — `serverEnv('GEMINI_API_KEY')` and
 * `process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID` are both string-literal-carrying facts these rules read.
 *
 * =============================================================================
 * HONEST LIMITS
 * =============================================================================
 *
 *  - Test modules are exempt from assertion 2. A `*.test.ts` sets a variable to exercise the real
 *    accessor; it does not ship and is not a second door. Its occurrences are printed as notes so
 *    the exemption is visible.
 *  - The scan root is `src/**`, the code that ships. `scripts/**` and the root config files
 *    legitimately read `process.env` and reach no browser bundle; a secret pasted into `scripts/`
 *    would not be caught here.
 *  - This guard says nothing about tenant isolation — that is `check-data-access.ts`'s job under
 *    A3. The two guards are siblings, each proving one absence.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ========================================================================== */
/* The facts the rules are written against                                     */
/* ========================================================================== */

/**
 * Every guarded server credential, taken from `serverEnvSchema` in `src/lib/env.ts` (the A3 stack)
 * rather than from prose, so the list cannot drift from the accessor that reads them.
 *
 * `MONGODB_URI` is the only database credential — there is no service-role key under A3, because
 * there is no RLS to bypass (the Data_Access_Layer is the boundary, D18). `BETTER_AUTH_SECRET` and
 * the two Google client credentials are the auth library's own (V30). The Telegram and Razorpay
 * secrets and `GEMINI`/`GROQ` are unchanged from A1. `CRON_SECRET` is the retention-sweep
 * credential (the platform-injected name; the design's env table calls it `RETENTION_SWEEP_SECRET`).
 *
 * `RAZORPAY_KEY_ID` (the unprefixed one) is here on purpose. It is not itself a secret — its value
 * is the same as the `NEXT_PUBLIC_RAZORPAY_KEY_ID` twin the browser reads — but the invariant task
 * 63.5 asks for is that the UNPREFIXED name never appears in a client component, so a client that
 * needs the id reads the public twin. Listing it here is exactly that assertion.
 *
 * `BETTER_AUTH_URL` is deliberately absent: it is a base URL, not a credential, and treating it as
 * a secret would make the list about "where config lives" rather than about what must not leak.
 */
export const SERVER_SECRET_NAMES = [
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
] as const;

/**
 * The one name whose UNPREFIXED spelling must never appear in a client component, even though its
 * value is public through the `NEXT_PUBLIC_` twin. Separated out only so the report can name the
 * reason precisely; it is also in `SERVER_SECRET_NAMES` so the client-component rule covers it.
 */
export const CLIENT_FORBIDDEN_UNPREFIXED = 'RAZORPAY_KEY_ID';

/**
 * Where a server secret may appear. A trailing `/` means "this directory and everything under it";
 * anything else is one exact file.
 *
 *  - `src/lib/` — the accessor and the adapters that consume credentials (auth, telegram, razorpay,
 *    gemini, groq, and the Data_Access_Layer's `client.ts` which holds `MONGODB_URI`).
 *  - `src/app/api/` — route handlers, including `src/app/api/internal/**` and `src/app/api/auth/**`.
 *  - `src/proxy.ts` — the Next session-refresh entry point; it runs on the server.
 *
 * `src/services/` is not on this list: those modules take injected clients and name no secret in
 * code today, so leaving them out keeps the surface as narrow as the code actually needs.
 */
export const SERVER_SECRET_SURFACE = ['src/lib/', 'src/app/api/', 'src/proxy.ts'] as const;

/** The only two modules allowed to read `process.env`. See `env.ts`'s header. */
export const ENV_READER_MODULES = ['src/lib/env.ts', 'src/lib/env.public.ts'] as const;

/**
 * The one module allowed to read a literal `process.env.NEXT_PUBLIC_*`.
 *
 * Not a stylistic split. Next.js inlines `NEXT_PUBLIC_*` by static textual substitution, so a
 * computed `process.env[name]` reads as `undefined` in the browser — which is why `env.public.ts`
 * spells the two public names out and `env.ts` (whose server keys go through `process.env[key]`)
 * does not. The same asymmetry keeps `env.ts` `server-only` while `env.public.ts` stays importable
 * from a client component.
 */
export const PUBLIC_ENV_READER_MODULE = 'src/lib/env.public.ts';

/* ========================================================================== */
/* Findings                                                                    */
/* ========================================================================== */

export type RuleId = 'secret-in-client' | 'secret-out-of-surface' | 'env-door' | 'public-env-split';

/**
 * `violation` fails the run. `note` does not — it is how an exemption gets printed instead of being
 * applied in silence.
 */
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
  readonly scannedFiles: number;
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
 * String and template literals survive: the rules below read `serverEnv('GROQ_API_KEY')` and
 * `process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID` out of them. Regular-expression literals are tracked so
 * an escaped slash inside one is not mistaken for `//`. A template literal is skipped WHOLE,
 * `${…}` holes included, for the reason the earlier version learned the hard way: a partial skip
 * that loses the closing backtick mis-scans the rest of the file.
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

export function isWithinServerSurface(path: string): boolean {
  return SERVER_SECRET_SURFACE.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : path === entry,
  );
}

/**
 * A `'use client'` directive on its own line, matched on the blanked source so a sentence about a
 * "use client" module cannot make a server module look like a client one.
 */
export function hasUseClientDirective(blanked: string): boolean {
  return /(^|\n)\s*(['"])use client\2\s*;?\s*(\n|$)/.test(blanked);
}

/** Every offset at which `needle` occurs. */
function offsetsOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    found.push(at);
    at = haystack.indexOf(needle, at + needle.length);
  }
  return found;
}

const IDENT_CHAR = /[A-Za-z0-9_]/;

/**
 * Offsets at which `secret` occurs as a WHOLE identifier, not as a fragment of a longer one.
 *
 * A plain substring scan is wrong for the A3 names because `RAZORPAY_KEY_ID` is a substring of both
 * the identifier `RAZORPAY_KEY_ID_VAR` and the twin literal `NEXT_PUBLIC_RAZORPAY_KEY_ID`. So:
 *  - the character AFTER the match must not be an identifier char (rejects `..._VAR`, `..._KEY`);
 *  - the character BEFORE the match must not be an identifier char, EXCEPT that a leading
 *    `NEXT_PUBLIC_` is allowed through so the twin is still surfaced and then classified as a twin
 *    by `isPrefixedTwin` rather than silently dropped here.
 */
function secretOccurrences(blanked: string, secret: string): number[] {
  return offsetsOf(blanked, secret).filter((offset) => {
    const after = blanked[offset + secret.length];
    if (after !== undefined && IDENT_CHAR.test(after)) return false;

    const before = blanked[offset - 1];
    if (before === undefined || !IDENT_CHAR.test(before)) return true;

    // Preceded by an identifier char: allowed only when that run is exactly `NEXT_PUBLIC_`.
    return blanked.slice(Math.max(0, offset - 'NEXT_PUBLIC_'.length), offset) === 'NEXT_PUBLIC_';
  });
}

/**
 * Does the offset at which `secret` was found actually name the UNPREFIXED variable, rather than
 * being the tail of the `NEXT_PUBLIC_` twin? `RAZORPAY_KEY_ID` is a substring of
 * `NEXT_PUBLIC_RAZORPAY_KEY_ID`, so a naive `indexOf` on `env.public.ts` would report the public
 * name as a use of the server one. A preceding `NEXT_PUBLIC_` means this occurrence is the twin.
 */
function isPrefixedTwin(blanked: string, secret: string, offset: number): boolean {
  const before = blanked.slice(Math.max(0, offset - 'NEXT_PUBLIC_'.length), offset);
  return secret !== 'MONGODB_URI' && before.endsWith('NEXT_PUBLIC_');
}

/* ========================================================================== */
/* Assertion 1 — secrets stay on the server                                    */
/* ========================================================================== */

/**
 * A server secret name may appear only inside `SERVER_SECRET_SURFACE`, and never in a module with a
 * `'use client'` directive. Both halves are checked for every file, so a client module INSIDE the
 * surface still reports the client violation.
 *
 * An occurrence that is really the `NEXT_PUBLIC_` twin (`NEXT_PUBLIC_RAZORPAY_KEY_ID`) is skipped:
 * the twin is a public value, and the rule is specifically about the UNPREFIXED spelling never
 * reaching a client. `env.public.ts` reads the twin legitimately.
 */
export function checkSecretScope(file: SourceFile): Finding[] {
  const blanked = blankComments(file.source);
  const isClient = hasUseClientDirective(blanked);
  const withinSurface = isWithinServerSurface(file.path);
  const findings: Finding[] = [];

  for (const secret of SERVER_SECRET_NAMES) {
    for (const offset of secretOccurrences(blanked, secret)) {
      if (isPrefixedTwin(blanked, secret, offset)) continue;

      const line = lineOf(blanked, offset);
      const excerpt = lineText(file.source, offset);

      if (isClient) {
        const reason =
          secret === CLIENT_FORBIDDEN_UNPREFIXED
            ? `The unprefixed ${secret} must never appear in a client component — read the ` +
              'NEXT_PUBLIC_RAZORPAY_KEY_ID twin from the browser instead (V27, task 63.5).'
            : `${secret} appears in a module carrying a 'use client' directive. Anything in a ` +
              'client module can be inlined into the browser bundle (Requirement 13.7).';
        findings.push({ rule: 'secret-in-client', severity: 'violation', path: file.path, line, message: reason, excerpt });
      }

      if (!withinSurface) {
        findings.push({
          rule: 'secret-out-of-surface',
          severity: 'violation',
          path: file.path,
          line,
          message:
            `${secret} appears outside the server surface (${SERVER_SECRET_SURFACE.join(', ')}). ` +
            'Read it through serverEnv() in src/lib/env.ts from a server module instead.',
          excerpt,
        });
      }
    }
  }

  return findings;
}

/* ========================================================================== */
/* Assertion 2 — one door to process.env, and the public/server split          */
/* ========================================================================== */

export function checkEnvDoor(file: SourceFile): Finding[] {
  const blanked = blankComments(file.source);
  const findings: Finding[] = [];
  const allowed = (ENV_READER_MODULES as readonly string[]).includes(file.path);

  for (const offset of offsetsOf(blanked, 'process.env')) {
    const line = lineOf(blanked, offset);
    const excerpt = lineText(file.source, offset);

    if (allowed) continue;

    if (isTestModule(file.path)) {
      findings.push({
        rule: 'env-door',
        severity: 'note',
        path: file.path,
        line,
        message:
          'process.env in a test module — exempt. A test that sets a variable to exercise the ' +
          'real accessor is not a second configuration door, and it does not ship.',
        excerpt,
      });
      continue;
    }

    findings.push({
      rule: 'env-door',
      severity: 'violation',
      path: file.path,
      line,
      message:
        `process.env is read outside ${ENV_READER_MODULES.join(' and ')}. Add the variable to ` +
        "serverEnvSchema and read it with serverEnv('NAME'), so a missing value fails by name.",
      excerpt,
    });
  }

  /* The split itself. Each clause is a structural fact of how env.ts and env.public.ts divide the
     work; inverting any of them would break either the client bundle or Requirement 13.7. */
  const literalPublicReads = offsetsOf(blanked, 'process.env.NEXT_PUBLIC_');
  if (file.path !== PUBLIC_ENV_READER_MODULE && !isTestModule(file.path)) {
    for (const offset of literalPublicReads) {
      findings.push({
        rule: 'public-env-split',
        severity: 'violation',
        path: file.path,
        line: lineOf(blanked, offset),
        message:
          `A literal process.env.NEXT_PUBLIC_* read belongs in ${PUBLIC_ENV_READER_MODULE}, which ` +
          'exists so client-safe values have a home outside the server-only accessor.',
        excerpt: lineText(file.source, offset),
      });
    }
  }

  if (file.path === PUBLIC_ENV_READER_MODULE) {
    if (offsetsOf(blanked, "'server-only'").length > 0 || offsetsOf(blanked, '"server-only"').length > 0) {
      findings.push({
        rule: 'public-env-split',
        severity: 'violation',
        path: file.path,
        line: 1,
        message:
          `${PUBLIC_ENV_READER_MODULE} must NOT import 'server-only'. A client component reads its ` +
          'public values; a server-only marker here would make that a build error.',
        excerpt: '',
      });
    }
    if (literalPublicReads.length === 0) {
      findings.push({
        rule: 'public-env-split',
        severity: 'violation',
        path: file.path,
        line: 1,
        message:
          `${PUBLIC_ENV_READER_MODULE} no longer reads a literal process.env.NEXT_PUBLIC_*. Next.js ` +
          'inlines those names by textual substitution, so a computed lookup reads as undefined in ' +
          'the browser — the literal reads are load-bearing.',
        excerpt: '',
      });
    }
  }

  if (file.path === 'src/lib/env.ts') {
    const marked =
      offsetsOf(blanked, "'server-only'").length > 0 || offsetsOf(blanked, '"server-only"').length > 0;
    if (!marked) {
      findings.push({
        rule: 'public-env-split',
        severity: 'violation',
        path: file.path,
        line: 1,
        message:
          "src/lib/env.ts must begin with import 'server-only'. That marker is the mechanical half " +
          'of Requirement 13.7: it turns a client import of the secret accessor into a build error.',
        excerpt: '',
      });
    }
  }

  if (file.path === PUBLIC_ENV_READER_MODULE) {
    for (const secret of SERVER_SECRET_NAMES) {
      for (const offset of secretOccurrences(blanked, secret)) {
        if (isPrefixedTwin(blanked, secret, offset)) continue;
        findings.push({
          rule: 'public-env-split',
          severity: 'violation',
          path: file.path,
          line: lineOf(blanked, offset),
          message:
            `${secret} is a server secret and ${PUBLIC_ENV_READER_MODULE} is importable from the ` +
            'browser. It belongs in serverEnvSchema in src/lib/env.ts.',
          excerpt: lineText(file.source, offset),
        });
      }
    }
  }

  return findings;
}

/* ========================================================================== */
/* The run                                                                     */
/* ========================================================================== */

export function runRules(files: readonly SourceFile[]): Report {
  const findings: Finding[] = [];

  for (const file of files) {
    findings.push(...checkSecretScope(file));
    findings.push(...checkEnvDoor(file));
  }

  findings.sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule),
  );

  return { findings, scannedFiles: files.length };
}

/** The only directory this gate reads. Everything reported is relative to the repository root. */
export const SCAN_ROOT = 'src';

/**
 * The repository root, taken from the working directory (not from `import.meta.url`, which throws
 * under Vite's non-`file:` URL when the test imports this module). Validated so a run from the
 * wrong directory says so rather than reporting an empty, passing scan.
 */
export function repoRoot(): string {
  const root = resolve(process.cwd());
  if (!existsSync(join(root, SCAN_ROOT))) {
    throw new Error(
      `check-secret-scope must run from the repository root: no ${SCAN_ROOT}/ under ${root}.`,
    );
  }
  return root;
}

/** Every `.ts`/`.tsx` module under `src/`, with POSIX-separated repository-relative paths. */
export function collectSourceFiles(root = repoRoot()): SourceFile[] {
  const base = join(root, SCAN_ROOT);
  const entries = readdirSync(base, { withFileTypes: true, recursive: true });

  return entries
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      return {
        path: relative(root, absolute).split(/[\\/]/).join('/'),
        source: readFileSync(absolute, 'utf8'),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

const RULE_TITLES: Readonly<Record<RuleId, string>> = {
  'secret-in-client': "server secret in a 'use client' module",
  'secret-out-of-surface': 'server secret outside the server surface',
  'env-door': 'process.env read outside src/lib/env{,.public}.ts',
  'public-env-split': 'public/server env split broken',
};

/** One block per finding, `path:line` first, so a CI log is greppable and clickable. */
export function formatReport(report: Report): string {
  const violations = report.findings.filter((f) => f.severity === 'violation');
  const notes = report.findings.filter((f) => f.severity === 'note');
  const lines: string[] = [];

  lines.push('check-secret-scope — Requirement 13.7 (Amendment A3: MongoDB / Better Auth stack)');
  lines.push(`scanned ${report.scannedFiles} modules under ${SCAN_ROOT}/`);
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
  lines.push('  - Scans src/ only. scripts/ and root config files legitimately read process.env');
  lines.push('    and reach no browser bundle; a secret in scripts/ is not caught here.');
  lines.push('  - Tenant isolation is NOT this guard\'s subject under A3 — the Data_Access_Layer is');
  lines.push('    the boundary and scripts/check-data-access.ts is the guard that proves it.');
  lines.push('  - Test modules are exempt from the process.env door (see NOTES).');

  lines.push('');
  lines.push(violations.length === 0 ? 'PASS' : `FAIL — ${violations.length} violation(s)`);

  return lines.join('\n');
}

export function main(): number {
  const report = runRules(collectSourceFiles());
  process.stdout.write(`${formatReport(report)}\n`);
  return report.findings.some((f) => f.severity === 'violation') ? 1 : 0;
}

/** Run only when this file *is* the process entry point, so importing it from a test is inert. */
function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || !import.meta.url.startsWith('file:')) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedAsScript()) {
  process.exit(main());
}
