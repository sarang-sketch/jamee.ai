import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import {
  BURST_QUOTAS,
  DAILY_QUOTAS,
  JAMEE_MAX_DURATION_SECONDS,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  MAX_IMAGE_BYTES,
  PLATFORM_MAX_DURATION_SECONDS,
  REQUEST_BODY_CEILING_BYTES,
} from '@/lib/config/verified';
import { ERROR_SPECS } from '@/lib/errors';
import {
  ERROR_CODES,
  chatAnswerSchema,
  chatRequestSchema,
  chatResponseSchema,
  diagnoseRequestSchema,
  diagnoseResponseSchema,
  errorDetailsSchema,
  errorEnvelopeSchema,
  identifiedResultSchema,
  inconclusiveResultSchema,
  knowledgePayloadSchema,
  languageSchema,
  operationSchema,
  quotaStatusSchema,
  severitySchema,
  storageRefSchema,
  verifiedConditionSchema,
  voiceRequestSchema,
  voiceResponseSchema,
  type ErrorCode,
} from '@/lib/schemas';

/**
 * `docs/API.md` cannot drift, and this file is the mechanism.
 *
 * Requirements: 17.4 (the Deployment_Package includes API documentation describing each API_Layer
 *               endpoint with the HTTP method, the request body schema, the response body schema and
 *               the error codes)
 * Task: 28.2
 *
 * ### Why a test and not a generator
 *
 * Task 28.2 says the document is "generated from `src/lib/schemas.ts` so the document cannot drift",
 * and the strongest reading of that is `scripts/generate-api-docs.ts` plus a CI check that the
 * committed file matches a fresh run. **That reading is not available here, for a mechanical
 * reason.** The three existing guards run as `node --experimental-strip-types scripts/*.ts`, and
 * under that loader:
 *
 *  - `src/lib/schemas.ts` fails at module load, because it imports `@/lib/config/verified` and Node
 *    resolves neither the `@/*` alias nor a tsconfig `paths` entry (verified: the import throws
 *    `ERR_MODULE_NOT_FOUND` for `@/lib`);
 *  - `src/lib/errors.ts` additionally begins with `import 'server-only'`, a bare specifier that only
 *    Next.js and Vite alias.
 *
 * `scripts/check-deployment.ts` records the same constraint in its own header and imports nothing
 * from `src/` for the same reason. A generator that cannot import the schemas would have to *parse*
 * them as text, which is a second, weaker model of the contract — precisely the drift the task is
 * trying to prevent, relocated.
 *
 * A Vitest test has no such problem: `vitest.config.ts` maps `@` to `src/` and stubs `server-only`,
 * so this file imports **the real schemas, the real `ERROR_SPECS` and the real verified constants**
 * and compares the document against them. That satisfies "cannot drift" the way the task means it —
 * the check is real, it runs in `npm test`, and it fails on any divergence in either direction.
 *
 * ### What is checked
 *
 * Every assertion below binds a table in the document to a value in the code, and the binding is an
 * HTML comment anchor (`<!-- fields:chatRequestSchema -->`) rather than a heading, so re-wording a
 * heading cannot silently detach a table from its schema. Set comparisons run in **both**
 * directions: a field added to a schema and not to the document fails, and so does a documented
 * field that no longer exists.
 *
 * Prose is deliberately not checked. The `Type` and `Notes` columns are prose and can still go
 * stale; the shapes, statuses, flags, enum members and numbers cannot.
 */

/* ========================================================================== */
/* Reading the document                                                        */
/* ========================================================================== */

const REPO_ROOT = resolve(__dirname, '..', '..');
const DOC_PATH = join(REPO_ROOT, 'docs', 'API.md');
const DOC = readFileSync(DOC_PATH, 'utf8');

/** A markdown row split into trimmed cells, with backticks stripped. */
type Row = readonly string[];

/**
 * A cell may legitimately contain a pipe — `'crop-images' \| 'voice-messages'` is a union type, and
 * `GET \| POST` is two verbs on one route — and markdown escapes it as `\|`. Splitting on a raw `|`
 * would shift every later column of that row, so the escaped form is parked on a character that
 * cannot appear in the document and restored afterwards.
 */
const ESCAPED_PIPE = '\u0000';

function cells(line: string): Row {
  return line
    .trim()
    .replaceAll('\\|', ESCAPED_PIPE)
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim().replace(/`/g, '').replaceAll(ESCAPED_PIPE, '|'));
}

/**
 * The table immediately following an anchor comment.
 *
 * The header row and the `---` separator are dropped, so what comes back is the body. A missing
 * anchor is an explicit failure rather than an empty result, because "the table is gone" and "the
 * table is empty" must not read the same.
 */
function tableAfter(anchor: string): Row[] {
  const marker = `<!-- ${anchor} -->`;
  const at = DOC.indexOf(marker);
  expect(at, `docs/API.md is missing the anchor ${marker}`).toBeGreaterThanOrEqual(0);

  const lines = DOC.slice(at + marker.length).split('\n');
  const rows: Row[] = [];
  let started = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (started) break;
      continue;
    }
    started = true;
    if (/^\|[\s|:-]+\|$/.test(trimmed)) continue; // the --- separator
    rows.push(cells(trimmed));
  }

  expect(rows.length, `the table after ${marker} has no rows`).toBeGreaterThan(1);
  return rows.slice(1); // drop the header
}

/** Every anchor the document actually carries, so an orphan anchor is visible. */
function anchorsInDoc(prefix: string): string[] {
  return [...DOC.matchAll(/<!--\s*([^\s]+)\s*-->/g)]
    .map((match) => match[1] ?? '')
    .filter((anchor) => anchor.startsWith(prefix));
}

/* ========================================================================== */
/* Endpoint completeness — the route table names every route module            */
/* ========================================================================== */

/** Every `route.ts` under `src/app`, as a repository-relative POSIX path. */
function routeModules(): string[] {
  const base = join(REPO_ROOT, 'src', 'app');
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'route.ts')
    .map((entry) =>
      relative(REPO_ROOT, join(entry.parentPath, entry.name)).split(sep).join(posix.sep),
    )
    .sort();
}

function sourceOf(routeModule: string): string {
  return readFileSync(join(REPO_ROOT, ...routeModule.split(posix.sep)), 'utf8');
}

const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** The HTTP verbs a route module exports, however it exports them. */
function exportedVerbs(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(
    /export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
  )) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found].sort();
}

describe('docs/API.md documents every endpoint that exists', () => {
  const documented = tableAfter('routes');

  it('names exactly the route modules under src/app', () => {
    expect(documented.map((row) => row[0]).sort()).toEqual(routeModules());
  });

  it.each(documented)('documents the exported verbs of %s', (module, methods) => {
    const listed = String(methods)
      .split(',')
      .map((verb) => verb.trim())
      .sort();

    expect(listed.every((verb) => (HTTP_VERBS as readonly string[]).includes(verb))).toBe(true);
    expect(listed).toEqual(exportedVerbs(sourceOf(String(module))));
  });

  /**
   * The `session` label is a claim about the code, so it is checked against the code: a
   * session-authenticated route is one built from `authenticatedRoute`, and nothing else may be
   * labelled that way. This is the same property `authenticated-route.test.ts` asserts from the
   * other side — it fails a farmer-facing handler exported in any other form — restated here so the
   * document cannot describe an auth model the route does not implement.
   *
   * Matched on the **import statement** rather than on the identifier anywhere in the file. The
   * WhatsApp and retention-sweep routes both explain in their headers that they are deliberately not
   * wrapped in `authenticatedRoute`, so a substring search finds the word in exactly the two files
   * whose prose says they do not use it.
   */
  const IMPORTS_WRAPPER = /^import\s*\{[^}]*\bauthenticatedRoute\b[^}]*\}\s*from/m;

  it.each(documented)('states the real auth model of %s', (module, _methods, auth) => {
    const source = sourceOf(String(module));
    expect(IMPORTS_WRAPPER.test(source)).toBe(auth === 'session');
  });
});

/* ========================================================================== */
/* maxDuration — V17                                                           */
/* ========================================================================== */

describe('docs/API.md records the real maxDuration of every route that declares one', () => {
  const documented = tableAfter('max-duration');

  function declaredMaxDuration(source: string): number | null {
    const match = /export\s+const\s+maxDuration\s*=\s*(\d+)/.exec(source);
    return match?.[1] === undefined ? null : Number(match[1]);
  }

  it('lists exactly the route modules that declare one', () => {
    const declaring = routeModules()
      .filter((module) => declaredMaxDuration(sourceOf(module)) !== null)
      .sort();

    expect(documented.map((row) => row[0]).sort()).toEqual(declaring);
  });

  it.each(documented)('matches the literal in %s, and V17', (module, value) => {
    const declared = declaredMaxDuration(sourceOf(String(module)));
    expect(declared).toBe(Number(value));
    expect(declared).toBe(JAMEE_MAX_DURATION_SECONDS);
  });
});

/* ========================================================================== */
/* Field tables — both directions                                              */
/* ========================================================================== */

/**
 * Anchor name → the schema its table is generated from.
 *
 * Keyed by the export name so a reader can go from the document straight to the declaration. The
 * one dotted key is the error envelope's inner object: the wire shape is `{ error: { … } }`, and the
 * table documents the fields under `error`.
 */
const FIELD_SCHEMAS = {
  storageRefSchema,
  quotaStatusSchema,
  identifiedResultSchema,
  inconclusiveResultSchema,
  knowledgePayloadSchema,
  chatAnswerSchema,
  'errorEnvelopeSchema.error': errorEnvelopeSchema.shape.error,
  errorDetailsSchema,
  diagnoseRequestSchema,
  diagnoseResponseSchema,
  chatRequestSchema,
  chatResponseSchema,
  voiceRequestSchema,
  voiceResponseSchema,
} as const;

/**
 * Whether a field is optional, asked of the schema rather than read from the document.
 *
 * `undefined` is the only value that distinguishes an optional field from a required one across
 * every shape used here — including `z.null()`, which is required and rejects `undefined`.
 */
function isOptional(field: ZodType): boolean {
  return field.safeParse(undefined).success;
}

describe('docs/API.md field tables match the schemas', () => {
  it('has an anchor for every documented schema and no orphans', () => {
    expect(anchorsInDoc('fields:').sort()).toEqual(
      Object.keys(FIELD_SCHEMAS)
        .map((name) => `fields:${name}`)
        .sort(),
    );
  });

  it.each(Object.entries(FIELD_SCHEMAS))('documents exactly the fields of %s', (name, schema) => {
    const shape = schema.shape as Record<string, ZodType>;
    const rows = tableAfter(`fields:${name}`);

    // Both directions: a field missing from the table fails, and so does a table row for a field
    // the schema no longer has.
    expect(rows.map((row) => row[0]).sort()).toEqual(Object.keys(shape).sort());

    for (const row of rows) {
      const field = row[0] ?? '';
      const required = row[1];
      expect(required, `${name}.${field}: Required must be yes or no`).toMatch(/^(yes|no)$/);

      const declared = shape[field];
      expect(declared, `${name}.${field} is not in the schema`).toBeDefined();
      expect(required === 'no', `${name}.${field}: Required disagrees with the schema`).toBe(
        isOptional(declared as ZodType),
      );
    }
  });
});

/* ========================================================================== */
/* Enums and constants                                                         */
/* ========================================================================== */

const ENUM_OPTIONS: Record<string, readonly string[]> = {
  languageSchema: languageSchema.options,
  severitySchema: severitySchema.options,
  operationSchema: operationSchema.options,
  verifiedConditionSchema: verifiedConditionSchema.options,
  'storageRefSchema.shape.bucket': storageRefSchema.shape.bucket.options,
};

describe('docs/API.md states the real permitted values', () => {
  const rows = tableAfter('enums');

  it('covers exactly the enums it claims to', () => {
    expect(rows.map((row) => row[0]).sort()).toEqual(Object.keys(ENUM_OPTIONS).sort());
  });

  it.each(rows)('lists every member of %s', (schemaName, values) => {
    const expected = ENUM_OPTIONS[String(schemaName)];
    expect(expected, `${String(schemaName)} is not a known enum`).toBeDefined();

    const listed = String(values)
      .split(',')
      .map((value) => value.trim());
    expect(listed).toEqual([...(expected as readonly string[])]);
  });
});

describe('docs/API.md states the real verified constants', () => {
  const EXPECTED: Record<string, number> = {
    JAMEE_MAX_DURATION_SECONDS,
    PLATFORM_MAX_DURATION_SECONDS,
    REQUEST_BODY_CEILING_BYTES,
    MAX_IMAGE_BYTES,
    MAX_AUDIO_BYTES,
    MAX_AUDIO_SECONDS,
  };
  const rows = tableAfter('constants');

  it('covers exactly the constants it claims to', () => {
    expect(rows.map((row) => row[0]).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(rows)('quotes the real value of %s', (name, value) => {
    const expected = EXPECTED[String(name)];
    expect(expected, `${String(name)} is not a documented constant`).toBeDefined();
    expect(String(value)).toContain(String(expected));
  });
});

describe('docs/API.md states the real quotas', () => {
  const rows = tableAfter('quotas');

  it('covers exactly the three operations', () => {
    expect(rows.map((row) => row[0]).sort()).toEqual(Object.keys(DAILY_QUOTAS).sort());
  });

  it.each(rows)('quotes the daily limit and burst ceiling for %s', (operation, daily, burst) => {
    const key = String(operation) as keyof typeof DAILY_QUOTAS;
    expect(Number(daily)).toBe(DAILY_QUOTAS[key]);
    expect(Number(burst)).toBe(BURST_QUOTAS[key]);
  });
});

/* ========================================================================== */
/* Error codes                                                                 */
/* ========================================================================== */

function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}

describe('docs/API.md documents every error code exactly as the taxonomy declares it', () => {
  const rows = tableAfter('error-specs');

  it('carries every code in ERROR_CODES order, with no extras', () => {
    expect(rows.map((row) => row[0])).toEqual([...ERROR_CODES]);
  });

  it.each(rows)('states the real status, flag and requirement for %s', (code, status, retryable, requirement) => {
    const name = String(code);
    expect(isErrorCode(name), `${name} is not in ERROR_CODES`).toBe(true);

    const spec = ERROR_SPECS[name as ErrorCode];
    expect(Number(status)).toBe(spec.status);
    expect(String(retryable)).toMatch(/^(yes|no)$/);
    expect(retryable === 'yes').toBe(spec.retryable);
    expect(String(requirement)).toBe(spec.requirement);
  });
});

/**
 * The bodiless non-2xx responses. The point of the assertion is the third column: the status is a
 * literal in two of those three route handlers, and the taxonomy is supposed to be the one place an
 * HTTP code for the condition is written down. If someone changes `ERROR_SPECS`, the number in the
 * document stops matching.
 */
describe('docs/API.md bodiless responses take their status from ERROR_SPECS', () => {
  it.each(tableAfter('bodiless'))('%s', (_response, status, code) => {
    const name = String(code);
    expect(isErrorCode(name), `${name} is not in ERROR_CODES`).toBe(true);
    expect(Number(status)).toBe(ERROR_SPECS[name as ErrorCode].status);
  });
});

/** The per-endpoint code tables, keyed by the anchor suffix. */
const ENDPOINT_CODE_ANCHORS = [
  'codes:diagnose',
  'codes:chat',
  'codes:voice',
  'codes:whatsapp-get',
  'codes:whatsapp-post',
  'codes:retention-sweep',
  'codes:auth-callback',
] as const;

describe('docs/API.md per-endpoint error tables agree with the taxonomy', () => {
  it('has an anchor for every endpoint and no orphans', () => {
    expect(anchorsInDoc('codes:').sort()).toEqual([...ENDPOINT_CODE_ANCHORS].sort());
  });

  it.each(ENDPOINT_CODE_ANCHORS)('%s names only real codes, with real statuses', (anchor) => {
    const rows = tableAfter(anchor);
    const seen = new Set<string>();

    for (const row of rows) {
      const name = row[0] ?? '';
      expect(isErrorCode(name), `${anchor}: ${name} is not in ERROR_CODES`).toBe(true);
      expect(seen.has(name), `${anchor}: ${name} is listed twice`).toBe(false);
      seen.add(name);

      const spec = ERROR_SPECS[name as ErrorCode];
      expect(Number(row[1]), `${anchor}: ${name} status`).toBe(spec.status);
      expect(row[2], `${anchor}: ${name} retryable`).toBe(spec.retryable ? 'yes' : 'no');
    }
  });
});

/* ========================================================================== */
/* The quota-semantics note (task 24.2)                                        */
/* ========================================================================== */

describe('docs/API.md carries the quota-semantics note task 24.2 produced', () => {
  it('states that a retry after an error spends a new unit', () => {
    expect(DOC).toContain('### Retrying after an error spends a new unit');
    expect(DOC).toContain('Every accepted request takes its own unit.');
  });

  it('names the three codes whose failures are not refunded', () => {
    const note = DOC.slice(DOC.indexOf('### Retrying after an error spends a new unit'));
    for (const code of ['PROVIDERS_UNAVAILABLE', 'DIAGNOSIS_TIMEOUT', 'TRANSCRIPTION_FAILED']) {
      expect(note).toContain(code);
    }
  });

  it('records the WhatsApp exception and the daily decline', () => {
    expect(DOC).toContain("outcome: 'duplicate_ignored'");
    expect(DOC).toContain('details: { limit, used, resetsAt }');
  });
});
