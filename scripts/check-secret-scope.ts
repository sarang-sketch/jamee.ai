/**
 * `check-secret-scope` — the CI gate that keeps Jamee's secrets on the server side of the
 * boundary, keeps `process.env` behind one door, and keeps service-role queries anchored.
 *
 * Requirements: 13.7 (the Service_Role_Key is referenced only in server-side modules and is
 *               excluded from every value sent to the browser)
 * Design: "Security boundary — Environment variables" (*"A CI grep asserts that
 *         `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, and the WhatsApp secrets
 *         appear only under `src/lib/**` server modules and `src/app/api/**`, and never in a file
 *         containing `'use client'`"*) and "Security boundary — Defence in depth" (*"Every
 *         service-role query is written with an explicit `user_id` predicate"*)
 * Wired into CI by task 28.6.
 *
 * Run it:  `npm run check:secret-scope`  (exits 0 clean, 1 on any violation)
 *
 * =============================================================================
 * WHY THIS IS NOT A GREP
 * =============================================================================
 *
 * The design calls this "a CI grep". A literal grep is not usable on this codebase: every secret
 * name and every `process.env` occurrence that matters is outnumbered by *prose* mentions of the
 * same identifier in module documentation. `rg 'process\.env' src` reports 17 hits, of which 6 are
 * real reads and 11 are sentences explaining that a module deliberately does not read it.
 *
 * So every rule below runs against a **comment-blanked** copy of each file: comments are replaced
 * with spaces, byte for byte, so line and column numbers in the report are the real ones while a
 * sentence about `SUPABASE_SERVICE_ROLE_KEY` can no longer masquerade as a use of it. String
 * literals are deliberately *kept* — `serverEnv('GEMINI_API_KEY')` and `.eq('user_id', userId)`
 * are both string-literal-carrying facts these rules need to see.
 *
 * =============================================================================
 * THE THREE ASSERTIONS
 * =============================================================================
 *
 * 1. **Secret scope.** Every name in `SERVER_SECRET_NAMES` appears only inside the server surface
 *    (`SERVER_SECRET_SURFACE`) and never in a module carrying a `'use client'` directive.
 *
 * 2. **One door to `process.env`,** plus the public/server split that makes the door safe:
 *    `src/lib/env.ts` and `src/lib/env.public.ts` are the only readers; only `env.public.ts` reads
 *    a literal `process.env.NEXT_PUBLIC_*`; `env.public.ts` names no server secret and carries no
 *    `server-only` marker; `env.ts` carries one.
 *
 * 3. **Service-role anchoring.** Every Supabase statement against a farmer-scoped table, and every
 *    `.rpc()` call to a database function that touches farmer rows, carries a visible tenant
 *    anchor. See the honesty note below for exactly what that can and cannot prove.
 *
 * =============================================================================
 * WHAT ASSERTION 3 PROVES, AND WHAT IT CANNOT — READ THIS BEFORE TRUSTING IT
 * =============================================================================
 *
 * `admin.ts`'s rule is about *service-role* queries. Deciding which queries those are is not
 * statically decidable in this codebase, and the reason is a deliberate design choice rather than
 * an accident: every store factory (`conversationStoreFrom`, `chatWriteStoreFrom`,
 * `diagnosisStoreFrom`, `voiceStoreFrom`, `adminCounterRpc`, `adminWhatsappInboundStore`,
 * `adminProfileByPhoneStore`) takes a **structurally typed** `SupabaseClient`, so the *same query
 * body* serves the farmer's RLS-scoped session on the web path and the service-role client on the
 * WhatsApp path. There is no expression anywhere that is "the service-role query".
 *
 * This check therefore does not try to identify them. It over-approximates: **every** statement
 * against a farmer-scoped table in a non-test module under `src/**` must be anchored, whichever
 * credential reaches it. That is strictly stronger than the rule as written, costs nothing (an
 * RLS-scoped query with an ownership predicate is the defence-in-depth the design already asks
 * for), and removes the undecidable step entirely.
 *
 * Within that scope there is exactly one class of statement whose anchor is **not visible**:
 *
 *     await client.from('usage_logs').insert(row)
 *
 * where `row` is a parameter rather than a literal. The anchoring column is inside a value this
 * script cannot see. Three things are true about that gap, and all three are stated in the report
 * rather than left implicit:
 *
 *   - It is confined to `insert` / `upsert` / `update` **payloads**. Every `select`, every `delete`
 *     and every predicate-carrying write is checked with no gap, so the check is complete for the
 *     verbs that can perform a cross-tenant *read* or *removal* — with one declared exception, the
 *     Retention_Sweep's candidate scan, which is tenant-independent by purpose and is listed in
 *     `TENANT_INDEPENDENT_STATEMENTS` with the per-row anchors that replace the predicate.
 *   - The payloads in question are typed `TablesInsert<'…'>`, whose `user_id` is required and
 *     non-nullable in `src/types/database.ts`. `npm run typecheck` — CI gate 1 — is what proves
 *     those rows carry a `user_id`. This script does not duplicate that proof; it records that the
 *     proof lives there.
 *   - Every such site must be listed in `OPAQUE_PAYLOAD_ALLOWANCES` with a justification. A site
 *     this script cannot see and that nobody has justified is a **violation**, not a pass. That is
 *     what stops the gap from growing silently: the check fails closed.
 *
 * Two further honest limits, both narrow:
 *
 *   - Test modules are exempt from assertions 2 and 3. A `*.test.ts` builds fake clients and sets
 *     variables to exercise the real accessor; neither ships, and neither is a second door. Their
 *     occurrences are printed as notes so the exemption is visible rather than assumed.
 *   - The scan root is `src/**`, the code that ships. `scripts/**` and the config files at the root
 *     legitimately read `process.env`, and nothing there reaches a browser bundle. A secret pasted
 *     into `scripts/` would not be caught here.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ========================================================================== */
/* The facts the rules are written against                                     */
/* ========================================================================== */

/**
 * Every server-only variable, taken from `serverEnvSchema` in `src/lib/env.ts` rather than from
 * the task text, so this list cannot drift from the accessor that reads them.
 *
 * `CRON_SECRET` is here although the design's grep sentence predates it: `env.ts` classifies it as
 * a required server secret, and a retention-sweep credential in a client bundle would be exactly
 * the failure Requirement 13.7 is about.
 *
 * `WHATSAPP_API_VERSION` is deliberately absent. It is server-side configuration but it is not a
 * secret — it is a Meta API version string with no privilege of its own (V12) — and treating it as
 * one would make the list about "where config lives" rather than about what must not leak.
 */
export const SERVER_SECRET_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
  'CRON_SECRET',
] as const;

/**
 * Where a server secret may appear, enumerated from the tree that exists rather than from the
 * design sentence alone.
 *
 * A trailing `/` means "this directory and everything under it"; anything else is one exact file.
 *
 *  - `src/lib/` — the accessor and the four adapters that consume credentials.
 *  - `src/app/api/` — route handlers, including `src/app/api/internal/**`, which the design places
 *    behind that path prefix precisely so the boundary is visible in the URL.
 *  - `src/proxy.ts` — V1's Next-16 session-refresh entry point (the file `middleware.ts` used to
 *    be). It runs on the server and is listed for that reason, not because it holds a secret today.
 *
 * `src/services/` is **not** on this list. Those modules are server-side, but they take their
 * credentials as injected clients and name no secret in code today; leaving them out keeps the
 * surface as narrow as the code actually needs.
 */
export const SERVER_SECRET_SURFACE = ['src/lib/', 'src/app/api/', 'src/proxy.ts'] as const;

/** The only two modules allowed to read `process.env`. See `env.ts`'s header. */
export const ENV_READER_MODULES = ['src/lib/env.ts', 'src/lib/env.public.ts'] as const;

/**
 * The one module allowed to read a literal `process.env.NEXT_PUBLIC_*`.
 *
 * Not a stylistic split. Next.js inlines `NEXT_PUBLIC_*` by static *textual* substitution, so a
 * computed `process.env[name]` reads as `undefined` in the browser — which is why `env.public.ts`
 * spells the names out and `env.ts` (whose server keys go through `process.env[key]`) does not.
 * The same asymmetry is what keeps `env.ts` `server-only` while `env.public.ts` stays importable
 * from a client component.
 */
export const PUBLIC_ENV_READER_MODULE = 'src/lib/env.public.ts';

/** Tables whose rows belong to one farmer, with the columns that count as a tenant anchor. */
export const FARMER_SCOPED_TABLES: Readonly<Record<string, readonly string[]>> = {
  /** `profiles.id` **is** the auth user id (0002), and `phone` is unique — the WhatsApp identity. */
  profiles: ['id', 'user_id', 'phone'],
  conversations: ['user_id'],
  messages: ['user_id'],
  diagnoses: ['user_id'],
  usage_logs: ['user_id'],
  counters: ['user_id'],
  /** `provider_message_id` is the primary key Meta supplied — `whatsapp-inbound.ts` says so. */
  whatsapp_inbound: ['user_id', 'provider_message_id'],
};

/**
 * `disease_knowledge` is intentionally absent from the table above: it holds no farmer data, so a
 * service-role read of it cannot cross a tenant boundary (`knowledge.ts` makes the same argument).
 * Naming it here documents the omission instead of leaving it looking like an oversight.
 */
export const TENANT_FREE_TABLES = ['disease_knowledge'] as const;

/**
 * An `.rpc()` argument key that names the farmer. Migration 0007's `counter_*` functions spell it
 * `p_user`; `user_id` is accepted so a future function using the column name is not a false alarm.
 */
const RPC_USER_ARG = /\b(p_user(_id)?|user_id)\s*:/;

/**
 * Database functions that touch no farmer-scoped row, so an `.rpc()` call needs no farmer argument.
 *
 * An allowlist rather than a denylist, for the same reason `OPAQUE_PAYLOAD_ALLOWANCES` is one: a
 * new quota or sweep function added without a farmer argument should fail this gate, not slip past
 * it. `counter_prune_minute_windows` deletes *expired window rows across all farmers* by age — its
 * whole purpose is to be tenant-independent (migration 0007).
 */
export const TENANT_FREE_FUNCTIONS = ['counter_prune_minute_windows'] as const;

/**
 * The statements whose anchor this script cannot see, each with the reason it is acceptable.
 *
 * Keyed by module + table + verb, never by line number, so ordinary edits inside a file do not
 * invalidate an entry. An unseen statement that is *not* on this list fails the run — the whole
 * point of the list is that the blind spot has a fixed, reviewed shape.
 */
export interface OpaquePayloadAllowance {
  readonly path: string;
  readonly table: string;
  readonly verb: string;
  readonly why: string;
}

export const OPAQUE_PAYLOAD_ALLOWANCES: readonly OpaquePayloadAllowance[] = [
  {
    path: 'src/lib/db/usage-log.ts',
    table: 'usage_logs',
    verb: 'insert',
    why: "usageLogWriterFrom(client).insertUsageLog(row: TablesInsert<'usage_logs'>) — row is a parameter rather than a literal, so the anchor is invisible here; TablesInsert<'usage_logs'> types user_id as non-nullable, so typecheck proves every row carries one. This is the shared audit writer every outcome goes through (task 24.3), so the four per-service copies of this same statement are the ones that had to be justified before it existed",
  },
  {
    path: 'src/lib/db/whatsapp-inbound.ts',
    table: 'whatsapp_inbound',
    verb: 'insert',
    why: "insertReceived(row: TablesInsert<'whatsapp_inbound'>) — provider_message_id is the PK and user_id is attached by attachUser(), which is predicate-anchored above",
  },
  {
    path: 'src/lib/db/whatsapp-inbound.ts',
    table: 'usage_logs',
    verb: 'insert',
    why: "insertUsageLog(row: TablesInsert<'usage_logs'>) — required non-nullable user_id, proven by typecheck",
  },
  {
    path: 'src/services/chat.service.ts',
    table: 'messages',
    verb: 'insert',
    why: "insertTurn(rows: readonly TablesInsert<'messages'>[]) — required non-nullable user_id on every row, proven by typecheck",
  },
  {
    path: 'src/services/chat.service.ts',
    table: 'usage_logs',
    verb: 'insert',
    why: "insertUsageLog(row: TablesInsert<'usage_logs'>) — required non-nullable user_id, proven by typecheck",
  },
  {
    path: 'src/services/diagnosis.service.ts',
    table: 'diagnoses',
    verb: 'insert',
    why: "insertDiagnosis(row: TablesInsert<'diagnoses'>) — required non-nullable user_id, proven by typecheck",
  },
  {
    path: 'src/services/diagnosis.service.ts',
    table: 'usage_logs',
    verb: 'insert',
    why: "insertUsageLog(row: TablesInsert<'usage_logs'>) — required non-nullable user_id, proven by typecheck",
  },
  {
    path: 'src/services/voice.service.ts',
    table: 'usage_logs',
    verb: 'insert',
    why: "insertUsageLog(row: TablesInsert<'usage_logs'>) — required non-nullable user_id, proven by typecheck",
  },
];

/**
 * Statements whose **purpose** is tenant-independent, so no `user_id` predicate could express them.
 *
 * The same idea as `TENANT_FREE_FUNCTIONS` above, applied to a table statement instead of an
 * `.rpc()` call: migration 0007's `counter_prune_minute_windows` deletes expired window rows across
 * all farmers by age, and Requirement 18's Retention_Sweep reads candidate rows across all farmers
 * by age. Neither is a farmer's operation, and an allowlist is what keeps that a reviewed exception
 * rather than a hole — an unanchored statement nobody has justified still fails the run.
 *
 * Keyed by module + table + verb like `OPAQUE_PAYLOAD_ALLOWANCES`, reported as a **note** so the
 * exemption is printed in every CI run, and tracked for staleness so an entry that no longer matches
 * any statement is listed rather than left to rot.
 *
 * **An entry here is only acceptable when the statement's tenant anchor exists somewhere else and is
 * named.** For the one entry below, `src/services/retention.service.ts` asserts per row that the
 * object path's first segment equals that row's own `user_id` before issuing any delete — a mismatch
 * is a hard error, not a skipped row — and the `full_image_deleted_at` stamp that follows is anchored
 * on both `id` and `user_id`. So the candidate read is a read of four columns the sweep then acts on
 * under a per-row anchor, not an unanchored write.
 */
export const TENANT_INDEPENDENT_STATEMENTS: readonly OpaquePayloadAllowance[] = [
  {
    path: 'src/services/retention.service.ts',
    table: 'diagnoses',
    verb: 'select',
    why: "Requirement 18.3's Retention_Sweep candidate scan — ages media out for the whole deployment, so it is tenant-independent by definition and no tenant-free source of farmer ids exists to loop over. Each deletion is anchored per row (path first segment === row user_id, a hard error on mismatch) and each stamp is anchored on id AND user_id",
  },
];

const tenantIndependentEntry = (
  path: string,
  table: string,
  verb: string,
): OpaquePayloadAllowance | undefined =>
  TENANT_INDEPENDENT_STATEMENTS.find(
    (entry) => entry.path === path && entry.table === table && entry.verb === verb,
  );

/* ========================================================================== */
/* Findings                                                                    */
/* ========================================================================== */

export type RuleId =
  | 'secret-in-client'
  | 'secret-out-of-surface'
  | 'env-door'
  | 'public-env-split'
  | 'service-role-anchor';

/**
 * `violation` fails the run. `note` does not — it is how an exemption or a static blind spot gets
 * printed instead of being applied in silence.
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
  /** Repository-relative, POSIX separators, so reports and allowances are platform-independent. */
  readonly path: string;
  readonly source: string;
}

export interface Report {
  readonly findings: readonly Finding[];
  readonly scannedFiles: number;
  /** Allowances that matched nothing — the list has drifted from the code, but nothing is unsafe. */
  readonly staleAllowances: readonly string[];
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
 * `.eq('user_id', userId)` out of them. Regular-expression literals are tracked so an escaped
 * slash inside one (`/^[0-9a-f-]{36}\/\d{4}/` in `schemas.ts`) is not mistaken for `//`.
 *
 * A template literal is skipped **whole**, `${…}` holes included. Recursing into holes to blank
 * comments inside them would need a brace-depth handshake between the template scanner and the
 * outer loop, and getting that handshake wrong is not a small error: the first version of this
 * function lost the closing backtick of `` `image/${extension}` `` and from there mis-scanned
 * 500 lines of `diagnosis.service.ts`, blanking real code and *un*-blanking a comment that named
 * `SUPABASE_SERVICE_ROLE_KEY`. Skipping the whole literal cannot get lost. The cost is that a
 * comment inside a `${…}` hole is not blanked — worth one hypothetical false positive.
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

    /* ── Comments ─────────────────────────────────────────────────────────── */
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

    /* ── Quoted forms: skipped over intact ────────────────────────────────── */
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

/** Past a `'…'` or `"…"` literal, honouring backslash escapes. Returns the index after it. */
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

/** Past a whole `` `…` `` literal, including every `${…}` hole. Returns the index after it. */
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

/** Past a `${…}` hole, to just after its closing brace. Nested strings and templates included. */
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

/** Past a `/…/flags` literal, honouring escapes and `[…]` classes (which may contain `/`). */
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

/** The standard division-versus-regex heuristic: what may precede a regex literal. */
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
 * A `'use client'` directive on its own line.
 *
 * Matched on the blanked source, so the sentence *"a client component importing this file is a
 * build error"* in `env.ts` cannot make `env.ts` look like a client component.
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

/* ========================================================================== */
/* Assertion 1 — secrets stay on the server                                    */
/* ========================================================================== */

/**
 * A server secret name may appear only inside `SERVER_SECRET_SURFACE`, and never in a module with
 * a `'use client'` directive.
 *
 * Both halves are checked for every file, and a client module inside the surface reports the
 * client violation as well: `src/lib/supabase/client.ts` is in `src/lib/` *and* is a client
 * component, so the surface alone would not protect it.
 */
export function checkSecretScope(file: SourceFile): Finding[] {
  const blanked = blankComments(file.source);
  const isClient = hasUseClientDirective(blanked);
  const withinSurface = isWithinServerSurface(file.path);
  const findings: Finding[] = [];

  for (const secret of SERVER_SECRET_NAMES) {
    for (const offset of offsetsOf(blanked, secret)) {
      const line = lineOf(blanked, offset);
      const excerpt = lineText(file.source, offset);

      if (isClient) {
        findings.push({
          rule: 'secret-in-client',
          severity: 'violation',
          path: file.path,
          line,
          message:
            `${secret} appears in a module carrying a 'use client' directive. Anything in a ` +
            'client module can be inlined into the browser bundle (Requirement 13.7).',
          excerpt,
        });
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
          'exists so client-safe values have a home outside the server-only accessor. Call ' +
          'publicEnv() instead.',
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
          `${PUBLIC_ENV_READER_MODULE} must NOT import 'server-only'. The browser Supabase client ` +
          'imports it; a server-only marker here would make the sign-in screen a build error.',
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
      for (const offset of offsetsOf(blanked, secret)) {
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
/* Assertion 3 — every farmer-scoped statement carries a tenant anchor         */
/* ========================================================================== */

export interface QueryStatement {
  readonly table: string;
  readonly offset: number;
  /** From `.from('table')` to the end of the chain. */
  readonly text: string;
}

/**
 * Cut each `.from('<table>')` chain out of the blanked source.
 *
 * Forward from the `.from` to the first `;` or `,` at depth zero, or to the bracket that closes
 * the expression the chain sits in — which covers both `const { data } = await client…;` and a
 * chain that is one element of a `Promise.all([…])`.
 */
export function extractQueryStatements(blanked: string): QueryStatement[] {
  const statements: QueryStatement[] = [];
  const pattern = /\.from\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\)/g;

  for (const match of blanked.matchAll(pattern)) {
    const table = match[2];
    if (table === undefined) continue;
    const offset = match.index;
    let depth = 0;
    let end = offset;

    for (let i = offset; i < blanked.length; i += 1) {
      const char = blanked[i];
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') {
        depth -= 1;
        if (depth < 0) {
          end = i;
          break;
        }
      } else if ((char === ';' || char === ',') && depth === 0) {
        end = i;
        break;
      }
      end = i + 1;
    }

    statements.push({ table, offset, text: blanked.slice(offset, end) });
  }

  return statements;
}

/** `.eq('user_id', …)`, `.in('user_id', …)`, `.match({ user_id: … })`, `.filter('user_id', …)`. */
function hasPredicateAnchor(statement: string, columns: readonly string[]): boolean {
  return columns.some((column) => {
    const quoted = new RegExp(`\\.(eq|in|filter|is|contains|match)\\(\\s*(['"])${column}\\2`);
    const inMatchObject = new RegExp(`\\.match\\(\\s*\\{[^}]*\\b${column}\\s*:`);
    return quoted.test(statement) || inMatchObject.test(statement);
  });
}

/** The write verb in the chain, if any. `select` is not a write and is not reported as one. */
function writeVerbOf(statement: string): string | undefined {
  const match = /\.(insert|upsert|update|delete)\(/.exec(statement);
  return match?.[1];
}

/**
 * The first argument of the write verb, as source text: an object literal, an array literal, or a
 * bare identifier. Returns `undefined` for `delete()`, which takes none.
 */
function writePayloadOf(statement: string, verb: string): string | undefined {
  const open = statement.indexOf(`.${verb}(`);
  if (open === -1) return undefined;
  const start = open + verb.length + 2;
  let depth = 0;

  for (let i = start; i < statement.length; i += 1) {
    const char = statement[i];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return statement.slice(start, i).trim();
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      return statement.slice(start, i).trim();
    }
  }
  return statement.slice(start).trim();
}

/**
 * Resolve a bare-identifier payload to a `const x = { … }` object literal **in the same module**.
 *
 * The one dataflow step this script takes, and it is deliberately the narrowest sound one: a
 * `const` initialised with an object literal cannot be reassigned, so a `user_id` key in that
 * literal really is on the row. `ensure-profile.ts`'s `const row: ProfileBootstrapRow = { id:
 * user.id, phone }` is the case it exists for.
 *
 * Two conditions, both of which the first version of this function lacked and was wrong without.
 * The declaration must *precede* the statement, and it must be the *only* such declaration of that
 * name before it. `whatsapp-inbound.ts` binds `const row` in two different functions and inserts a
 * `row` parameter in a third; picking the module's first `const row` there resolved an unrelated
 * literal 80 lines further down and reported a violation that did not exist. Ambiguity now
 * resolves to `undefined`, which the caller treats as *unseen* rather than as absent — the
 * conservative direction.
 */
function resolveConstObjectLiteral(
  blanked: string,
  identifier: string,
  before: number,
): string | undefined {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(identifier)) return undefined;
  const declaration = new RegExp(`\\bconst\\s+${identifier}\\b[^=;]*=\\s*\\{`, 'g');
  const preceding = [...blanked.matchAll(declaration)].filter((match) => match.index < before);
  if (preceding.length !== 1) return undefined;

  const only = preceding[0];
  if (only === undefined) return undefined;

  const open = blanked.indexOf('{', only.index);
  let depth = 0;
  for (let i = open; i < blanked.length; i += 1) {
    const char = blanked[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return blanked.slice(open, i + 1);
    }
  }
  return undefined;
}

function payloadCarriesAnchor(payload: string, columns: readonly string[]): boolean {
  return columns.some((column) => new RegExp(`\\b${column}\\s*:`).test(payload));
}

const allowanceKey = (path: string, table: string, verb: string): string =>
  `${path}::${table}::${verb}`;

/**
 * The same anchoring rule applied to `.rpc()`, which `.from()` scanning cannot see.
 *
 * `adminCounterRpc` in `quota.service.ts` is one of the three service-role paths the design names,
 * and it reaches its rows through `counter_try_increment` / `counter_decrement` / `counter_used`
 * rather than through a table. A call missing `p_user` would increment or read another farmer's
 * counter with nothing behind it, which is the same defect class as an unanchored select.
 *
 * The argument object is matched only as far as the call's closing parenthesis, so a `p_user` on an
 * unrelated later call cannot satisfy this one.
 */
export function checkRpcAnchors(file: SourceFile, blanked: string): Finding[] {
  const findings: Finding[] = [];
  const pattern = /\.rpc\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g;

  for (const match of blanked.matchAll(pattern)) {
    const fn = match[2];
    if (fn === undefined) continue;
    if ((TENANT_FREE_FUNCTIONS as readonly string[]).includes(fn)) continue;

    let depth = 1;
    let end = blanked.length;
    for (let i = match.index + match[0].length; i < blanked.length; i += 1) {
      const char = blanked[i];
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (RPC_USER_ARG.test(blanked.slice(match.index, end))) continue;

    findings.push({
      rule: 'service-role-anchor',
      severity: 'violation',
      path: file.path,
      line: lineOf(blanked, match.index),
      message:
        `rpc('${fn}') carries no farmer argument (p_user, p_user_id, or user_id). A quota or ` +
        'counter function called on the service-role client has no boundary behind it. If this ' +
        'function genuinely touches no farmer row, add it to TENANT_FREE_FUNCTIONS.',
      excerpt: lineText(file.source, match.index),
    });
  }

  return findings;
}

/**
 * Assertion 3 for one module. `usedAllowances` collects the keys that matched, so the runner can
 * report an allowance that no longer corresponds to any statement.
 */
export function checkServiceRoleAnchors(file: SourceFile, usedAllowances?: Set<string>): Finding[] {
  if (isTestModule(file.path)) return [];

  const blanked = blankComments(file.source);
  const findings: Finding[] = [...checkRpcAnchors(file, blanked)];

  for (const statement of extractQueryStatements(blanked)) {
    const columns = FARMER_SCOPED_TABLES[statement.table];
    if (columns === undefined) continue; // Not farmer-scoped, or a storage bucket.

    const line = lineOf(blanked, statement.offset);
    const excerpt = lineText(file.source, statement.offset);

    if (hasPredicateAnchor(statement.text, columns)) continue;

    const verb = writeVerbOf(statement.text);

    /* A declared tenant-independent statement: reported, never silent, and never a violation. */
    const independent = tenantIndependentEntry(file.path, statement.table, verb ?? 'select');
    if (independent !== undefined) {
      usedAllowances?.add(allowanceKey(independent.path, independent.table, independent.verb));
      findings.push({
        rule: 'service-role-anchor',
        severity: 'note',
        path: file.path,
        line,
        message: `TENANT-INDEPENDENT — ${verb ?? 'select'} on '${statement.table}': ${independent.why}`,
        excerpt,
      });
      continue;
    }

    if (verb === undefined || verb === 'delete') {
      findings.push({
        rule: 'service-role-anchor',
        severity: 'violation',
        path: file.path,
        line,
        message:
          `Unanchored ${verb ?? 'select'} on '${statement.table}'. Add an explicit predicate on ` +
          `one of: ${columns.join(', ')}. On the service-role client there is nothing behind this ` +
          'check (src/lib/supabase/admin.ts), so an unanchored statement is a cross-tenant read.',
        excerpt,
      });
      continue;
    }

    const payload = writePayloadOf(statement.text, verb);
    const resolved =
      payload !== undefined && payload.startsWith('{')
        ? payload
        : payload !== undefined
          ? resolveConstObjectLiteral(blanked, payload, statement.offset)
          : undefined;

    if (resolved !== undefined && payloadCarriesAnchor(resolved, columns)) continue;

    if (resolved !== undefined) {
      findings.push({
        rule: 'service-role-anchor',
        severity: 'violation',
        path: file.path,
        line,
        message:
          `${verb} on '${statement.table}' with a visible payload that sets none of: ` +
          `${columns.join(', ')}. The row would not be attributed to a farmer.`,
        excerpt,
      });
      continue;
    }

    /* The blind spot, named. Allowed only if somebody has justified this exact site. */
    const key = allowanceKey(file.path, statement.table, verb);
    const allowance = OPAQUE_PAYLOAD_ALLOWANCES.find(
      (entry) => allowanceKey(entry.path, entry.table, entry.verb) === key,
    );

    if (allowance === undefined) {
      findings.push({
        rule: 'service-role-anchor',
        severity: 'violation',
        path: file.path,
        line,
        message:
          `${verb} on '${statement.table}' with payload '${payload ?? '?'}', whose anchoring ` +
          'column this check cannot see. Either anchor it inline, or add the site to ' +
          'OPAQUE_PAYLOAD_ALLOWANCES in scripts/check-secret-scope.ts with the reason it is safe.',
        excerpt,
      });
      continue;
    }

    usedAllowances?.add(key);
    findings.push({
      rule: 'service-role-anchor',
      severity: 'note',
      path: file.path,
      line,
      message: `UNPROVEN — ${verb} on '${statement.table}' via '${payload ?? '?'}': ${allowance.why}`,
      excerpt,
    });
  }

  return findings;
}

/* ========================================================================== */
/* The run                                                                     */
/* ========================================================================== */

export function runRules(files: readonly SourceFile[]): Report {
  const usedAllowances = new Set<string>();
  const findings: Finding[] = [];

  for (const file of files) {
    findings.push(...checkSecretScope(file));
    findings.push(...checkEnvDoor(file));
    findings.push(...checkServiceRoleAnchors(file, usedAllowances));
  }

  const staleAllowances = [...OPAQUE_PAYLOAD_ALLOWANCES, ...TENANT_INDEPENDENT_STATEMENTS]
    .map((entry) => allowanceKey(entry.path, entry.table, entry.verb))
    .filter((key) => !usedAllowances.has(key));

  findings.sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule),
  );

  return { findings, scannedFiles: files.length, staleAllowances };
}

/** The only directory this gate reads. Everything reported is relative to the repository root. */
export const SCAN_ROOT = 'src';

/**
 * The repository root, taken from the working directory.
 *
 * Not derived from `import.meta.url`: this module is also imported by `tests/unit`, where Vite
 * serves it under a non-`file:` URL and `fileURLToPath` throws. `npm run check:secret-scope` and
 * `vitest` both run from the repository root, so the working directory is the one fact available
 * in both. It is validated rather than assumed, so a run from the wrong directory says so instead
 * of reporting an empty, passing scan.
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
  'service-role-anchor': 'farmer-scoped statement without a tenant anchor',
};

/** One block per finding, `path:line` first, so a CI log is greppable and clickable. */
export function formatReport(report: Report): string {
  const violations = report.findings.filter((f) => f.severity === 'violation');
  const notes = report.findings.filter((f) => f.severity === 'note');
  const lines: string[] = [];

  lines.push('check-secret-scope — Requirement 13.7, design "Security boundary"');
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
  lines.push(
    '  - Assertion 3 is complete for select/update/delete, for .rpc() calls, and for writes with a',
  );
  lines.push('    visible payload.');
  lines.push(
    "  - Insert payloads passed as a parameter are UNPROVEN here; their user_id is required and",
  );
  lines.push(
    '    non-nullable in src/types/database.ts, so `npm run typecheck` is what proves those rows',
  );
  lines.push(
    '    carry one. Each such site is listed above and must appear in OPAQUE_PAYLOAD_ALLOWANCES;',
  );
  lines.push('    an unlisted one fails this run.');
  lines.push(
    '  - A statement whose purpose is tenant-independent (the Retention_Sweep candidate scan) is',
  );
  lines.push(
    '    listed in TENANT_INDEPENDENT_STATEMENTS with the per-row anchors that replace the predicate,',
  );
  lines.push('    and is reported above as a note. An unlisted one fails this run.');
  lines.push(
    '  - Which queries run on the service-role client is not statically decidable (store factories',
  );
  lines.push(
    '    take a structurally typed client), so assertion 3 over-approximates and checks every',
  );
  lines.push('    farmer-scoped statement regardless of credential.');
  lines.push(`  - Scan root is ${SCAN_ROOT}/ only. scripts/ and root config files are not scanned.`);
  lines.push('  - Test modules are exempt from assertions 2 and 3 (see NOTES).');

  if (report.staleAllowances.length > 0) {
    lines.push('');
    lines.push('STALE ALLOWANCES — listed in the script but matching no statement any more:');
    for (const key of report.staleAllowances) lines.push(`  ${key}`);
  }

  lines.push('');
  lines.push(violations.length === 0 ? 'PASS' : `FAIL — ${violations.length} violation(s)`);

  return lines.join('\n');
}

export function main(): number {
  const report = runRules(collectSourceFiles());
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
