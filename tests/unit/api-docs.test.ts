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
  channelSchema,
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
  mediaKindSchema,
  mediaRefSchema,
  operationSchema,
  quotaStatusSchema,
  severitySchema,
  verifiedConditionSchema,
  voiceRequestSchema,
  voiceResponseSchema,
  type ErrorCode,
} from '@/lib/schemas';

/**
 * `docs/API.md` cannot drift, and this file is the mechanism (task 63.2).
 *
 * Requirements: 17.4 (the Deployment_Package documents each endpoint with the HTTP method, the
 *               request/response body schemas, and the error codes)
 *
 * ### Why a test and not a generator
 *
 * The three `scripts/check-*.ts` guards and `scripts/db-setup.ts` run as
 * `node --experimental-strip-types scripts/*.ts`, under which `src/lib/schemas.ts` fails at module
 * load (it imports `@/lib/config/verified`, and Node resolves neither the `@/*` alias nor a tsconfig
 * `paths` entry) and `src/lib/errors.ts` additionally begins with the bare `server-only` specifier
 * only Next/Vite alias. A generator that cannot import the schemas would have to *parse* them as
 * text — a second, weaker model of the contract, i.e. the drift the task is trying to prevent,
 * relocated. A Vitest test has no such problem: `vitest.config.ts` maps `@` to `src/` and stubs
 * `server-only`, so this file imports the REAL schemas, `ERROR_SPECS` and verified constants and
 * compares the document against them.
 *
 * ### Amendment A3
 *
 * The storage-path contract is gone: `storageRefSchema` retired and `mediaRefSchema`
 * (`{ fileId, kind }`) replaced it, so the field and enum tables bind to the Media_Reference now.
 * The channel enum is `web, telegram`. The two webhook routes are documented by their
 * authentication mechanism rather than a request schema, and there is no GET webhook handshake to
 * document — so the endpoint code anchors are the A3 route set, not the retired WhatsApp pair.
 *
 * ### What is checked
 *
 * Every assertion binds a table to a value in the code through an HTML-comment anchor
 * (`<!-- fields:chatRequestSchema -->`), so re-wording a heading cannot detach a table from its
 * schema. Set comparisons run in both directions. Prose (the `Type`/`Notes` columns) is not checked.
 */

/* ========================================================================== */
/* Reading the document                                                        */
/* ========================================================================== */

const REPO_ROOT = resolve(__dirname, '..', '..');
const DOC_PATH = join(REPO_ROOT, 'docs', 'API.md');
const DOC = readFileSync(DOC_PATH, 'utf8');

type Row = readonly string[];

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

function anchorsInDoc(prefix: string): string[] {
  return [...DOC.matchAll(/<!--\s*([^\s]+)\s*-->/g)]
    .map((match) => match[1] ?? '')
    .filter((anchor) => anchor.startsWith(prefix));
}

/* ========================================================================== */
/* Endpoint completeness — the route table names every route module            */
/* ========================================================================== */

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
   * The `session` label is a claim about the code. A session-authenticated route is one built from
   * `authenticatedRoute`; every other auth mechanism (better-auth's own catch-all, the Telegram
   * secret token, the payment signature, the cron bearer, the media owner-check) is labelled by its
   * mechanism and must NOT import the wrapper. Matched on the import statement rather than the
   * identifier anywhere, so a header that names the wrapper in prose (the telegram/webhook/sweep
   * routes explain they are deliberately not wrapped) is not mistaken for a use.
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

const FIELD_SCHEMAS = {
  mediaRefSchema,
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
  mediaKindSchema: mediaKindSchema.options,
  channelSchema: channelSchema.options,
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
 * The bodiless non-2xx responses. The point is the third column: the status is a literal in those
 * route handlers, and the taxonomy is the one place the HTTP code for the condition is written down.
 */
describe('docs/API.md bodiless responses take their status from ERROR_SPECS', () => {
  it.each(tableAfter('bodiless'))('%s', (_response, status, code) => {
    const name = String(code);
    expect(isErrorCode(name), `${name} is not in ERROR_CODES`).toBe(true);
    expect(Number(status)).toBe(ERROR_SPECS[name as ErrorCode].status);
  });
});

/** The per-endpoint code tables, keyed by the anchor suffix — the A3 route set. */
const ENDPOINT_CODE_ANCHORS = [
  'codes:diagnose',
  'codes:chat',
  'codes:voice',
  'codes:media-upload',
  'codes:media-serve',
  'codes:link-token',
  'codes:payment-order',
  'codes:payment-webhook',
  'codes:telegram',
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
/* The quota-semantics note (task 24.2, restated for Telegram)                 */
/* ========================================================================== */

describe('docs/API.md carries the quota-semantics note', () => {
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

  it('records the Telegram update_id duplicate exception and the daily decline', () => {
    // Amendment A3: the WhatsApp provider_message_id exception is now the Telegram update_id one.
    expect(DOC).toContain("outcome: 'duplicate_ignored'");
    expect(DOC).toContain('update_id');
    expect(DOC).toContain('details: { limit, used, resetsAt }');
  });
});
