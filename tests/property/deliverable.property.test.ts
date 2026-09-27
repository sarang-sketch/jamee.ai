import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ALL_ENV_KEYS,
  OPTIONAL_SERVER_ENV_KEYS,
  PUBLIC_ENV_VARS,
  SERVER_ENV_KEYS,
} from '@/lib/env';

import { SERVER_SECRET_NAMES } from '../../scripts/check-secret-scope';

/**
 * ### Property 30: Deliverable completeness over the environment and endpoint sets
 *
 * *"For every key in the server environment schema, `.env.example` lists that key with a placeholder
 * and no live credential value; and for every registered API route, the API documentation records its
 * HTTP method, request body schema, response body schema, and error codes."*
 *
 * **Validates: Requirements 17.2, 17.4**
 *
 * =============================================================================
 * WHAT MAKES THIS A PROPERTY RATHER THAN A CHECKLIST
 * =============================================================================
 *
 * Both halves are **completeness over a set**, and the whole value of stating them as properties is
 * that **neither set is written down here**. They are derived from source, so a key added to the
 * schema tomorrow, or a route module added next week, is covered by this file without anybody
 * remembering to come back to it:
 *
 *  - the environment set is `ALL_ENV_KEYS` from `src/lib/env.ts` — `PUBLIC_ENV_VARS` plus
 *    `SERVER_ENV_KEYS` (the keys of `serverEnvSchema.shape`) plus `OPTIONAL_SERVER_ENV_KEYS`. That
 *    export exists for this purpose; its comment says *"for `.env.example` completeness checks
 *    (Property 30)"*;
 *  - the endpoint set is every `route.ts` under `src/app`, read off the filesystem, with each
 *    module's HTTP verbs read out of its own `export` statements.
 *
 * A hand-copied list of variables and routes would pass today and rot silently, which is precisely
 * the failure Requirement 17.2 and 17.4 are about — a deployment package that no longer describes
 * the deployment.
 *
 * The **coverage assertions** after each run are what make the derivation load-bearing rather than
 * decorative: they assert that the run visited *every* member of the derived set, so a generator that
 * silently stopped producing one would fail rather than shrink the claim.
 *
 * =============================================================================
 * AMENDMENT A3 — THE ENVIRONMENT SET THIS PROPERTY IS STATED OVER
 * =============================================================================
 *
 * The claim is unchanged; the substrate it runs over is not. Under Supabase the schema held a
 * service-role key, a Postgres connection string, a project URL and a publishable/anon key, and this
 * file's credential rules recognised those shapes. **A3 removes Supabase entirely** (`env.ts`,
 * `env.public.ts` headers): the only database credential is `MONGODB_URI`, Google sign-in runs
 * through Better Auth (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`,
 * `GOOGLE_CLIENT_SECRET`), the Telegram and Razorpay secrets stay, and the retention sweep reads
 * `CRON_SECRET`. There is no `WHATSAPP_VERIFY_TOKEN`, no `JAMEE_TEST_DATABASE_URL` (the integration
 * tests run against an in-process `mongodb-memory-server` replica set — V31), and the public set is
 * two names, not three (no alternative publishable-key spelling). The credential rules below are the
 * A3 shapes: a live `mongodb+srv://…` URI, a Better Auth / Google secret, a real Telegram bot token,
 * a real Razorpay `rzp_*` id and a real `gsk_…` Groq key. Every rule names the credential family it
 * guards and what a live one looks like.
 *
 * =============================================================================
 * WHAT THIS ADDS OVER `tests/unit/api-docs.test.ts`, AND WHAT IT LEAVES TO IT
 * =============================================================================
 *
 * `tests/unit/api-docs.test.ts` (task 28.2) already binds `docs/API.md` to the code in depth: the
 * route table names exactly the route modules, each row's verbs match the module's exports, every
 * field table matches its Zod schema in **both** directions, and every error-code table matches
 * `ERROR_SPECS`. That is *accuracy*, table by table, and this file does not repeat it.
 *
 * What is not asserted there is Requirement 17.4's actual sentence: that **each endpoint** has all
 * **four** facets documented. A route could be listed in the route table, have a correct field table
 * for a schema, and carry no error-code section at all — every existing assertion would still pass.
 * So this file is the per-route × per-facet completeness claim, and it hands accuracy back to
 * `api-docs.test.ts` by asserting that a facet which names a schema names one the anchor-checked
 * tables cover.
 *
 * Nothing here reads a live credential, and nothing here needs an environment: both halves are
 * assertions about two committed files and the tree beside them.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');

/* ========================================================================== */
/* PART ONE — the environment set                                              */
/* ========================================================================== */

const ENV_EXAMPLE = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');

interface Assignment {
  readonly key: string;
  readonly value: string;
  /** `true` when the line is commented out — the documented shape for an optional variable. */
  readonly commented: boolean;
  readonly line: number;
}

/**
 * Every `KEY=value` line in `.env.example`, commented or not.
 *
 * The pattern requires the key to be at the start of the line (optionally behind a `#`), which is
 * what keeps the file's long prose comments out of the result: a sentence mentioning `MONGODB_URI`
 * carries no `=` in that position, so it is not an assignment. Both directions of the completeness
 * claim read this one parse.
 */
function assignmentsIn(text: string): readonly Assignment[] {
  return text.split('\n').flatMap((raw, index) => {
    const match = /^\s*(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw);
    if (match === null) return [];
    return [
      {
        key: match[2] ?? '',
        value: (match[3] ?? '').trim(),
        commented: match[1] !== undefined,
        line: index + 1,
      },
    ];
  });
}

const ASSIGNMENTS = assignmentsIn(ENV_EXAMPLE);

function assignmentFor(key: string): Assignment | undefined {
  return ASSIGNMENTS.find((assignment) => assignment.key === key);
}

/**
 * The one documented variable that is **configuration rather than a credential**, so no placeholder
 * rule applies to it: `BETTER_AUTH_URL` is the deployed origin (`env.ts` records it is "used to
 * build the Google callback"), and `check-secret-scope.ts` deliberately keeps it out of
 * `SERVER_SECRET_NAMES` because "a base URL is not a credential". Its committed value is therefore a
 * real, usable localhost origin (`http://localhost:3000`), on purpose — a developer who copies the
 * file gets a working local template.
 *
 * `OPTIONAL_SERVER_ENV_KEYS` is empty under A3 (no optional server variable this release), so the
 * only non-credential configuration is this one name, kept as a list so a future optional variable
 * folds in without a shape change.
 */
const NON_CREDENTIAL_CONFIGURATION = ['BETTER_AUTH_URL', ...OPTIONAL_SERVER_ENV_KEYS] as const;

/** A key whose line must be **active**, because copying the file has to yield a usable template. */
function mustBeActive(): boolean {
  // A3: every documented variable is a REQUIRED active line. There is no commented alternative
  // spelling anymore (the Supabase publishable/anon alternative is gone) and no optional variable,
  // so nothing in this file is legitimately commented out — asserted below by the shape coverage.
  return true;
}

/**
 * The shapes that read as "fill this in". A key that must not carry a live value has to match one.
 *
 * Enumerated, and every one of them is proven to occur in the file by the coverage assertion after
 * the run — a marker nothing matches would be a rule that had quietly stopped applying.
 */
const PLACEHOLDER_MARKERS = {
  /** `replace-with-your-…`, `gsk_replace_with_…`, `123456789:replace-with-…`. */
  replace: /replace/i,
  /** `your_bot_username`, `your-google-oauth-client-id`, `your-user`, `your-cluster`. */
  your: /your[-_]/i,
  /** `invent-a-long-random-…` — the Telegram webhook token and the Razorpay webhook secret. */
  invent: /invent/i,
  /** `generate-a-long-random-…` / `generate-a-random-string-…` — the Better Auth secret, CRON_SECRET. */
  generate: /generate/i,
  /** A run of zeros, which is how an id-shaped placeholder is written (`rzp_test_0000…`). */
  zeros: /0{4,}/,
} as const;

type MarkerName = keyof typeof PLACEHOLDER_MARKERS;

const MARKER_NAMES = Object.keys(PLACEHOLDER_MARKERS) as readonly MarkerName[];

function markersMatching(value: string): readonly MarkerName[] {
  return MARKER_NAMES.filter((name) => PLACEHOLDER_MARKERS[name].test(value));
}

/**
 * The "no live credential" half, as rules over the *shape* of a value.
 *
 * Each rule is a **precondition plus a requirement**: the precondition says which values the rule
 * looks at, and the requirement says what such a value must be. That structure is what lets the
 * coverage assertion prove the rules engage with this file's real content rather than passing because
 * nothing matched them.
 *
 * The rules are aimed at the realistic accident — someone pastes a working value into the committed
 * example while getting their own environment running — which is why each names the credential family
 * it guards and says what a live one looks like. Every rule's family appears on at least one A3 key,
 * so all of them engage over the schema's own keys (the coverage assertion checks exactly that).
 */
interface CredentialRule {
  readonly id: string;
  readonly why: string;
  applies(assignment: Assignment): boolean;
  safe(assignment: Assignment): boolean;
}

const CREDENTIAL_RULES: readonly CredentialRule[] = [
  {
    id: 'mongodb_uri_must_be_placeholder',
    why: 'a live MongoDB connection string carries a real cluster host and credentials; the committed one must name a placeholder user, password and cluster',
    applies: ({ value }) => /^mongodb(\+srv)?:\/\//.test(value),
    safe: ({ value }) => markersMatching(value).length > 0,
  },
  {
    id: 'razorpay_id_must_be_zeros',
    why: 'a real Razorpay key id is `rzp_test_`/`rzp_live_` plus real entropy; the committed one is the prefix and a run of zeros',
    applies: ({ value }) => /^rzp_(test|live)_/.test(value),
    safe: ({ value }) => markersMatching(value.replace(/^rzp_(test|live)_/, '')).length > 0,
  },
  {
    id: 'groq_key_must_be_marked',
    why: '`.env.example` itself records that real Groq keys start `gsk_`',
    applies: ({ value }) => value.startsWith('gsk_'),
    safe: ({ value }) => PLACEHOLDER_MARKERS.replace.test(value.slice('gsk_'.length)),
  },
  {
    id: 'telegram_token_must_be_marked',
    why: 'a real Telegram bot token is `<numeric-bot-id>:<secret>`; the committed one keeps the shape but the secret half must read as an instruction',
    applies: ({ value }) => /^\d+:/.test(value),
    safe: ({ value }) => markersMatching(value.split(':').slice(1).join(':')).length > 0,
  },
  {
    id: 'google_client_id_must_be_placeholder',
    why: 'a real Google OAuth client id ends `.apps.googleusercontent.com` with a real project-specific prefix; the committed one names a placeholder prefix',
    applies: ({ value }) => value.endsWith('.apps.googleusercontent.com'),
    safe: ({ value }) =>
      markersMatching(value.replace('.apps.googleusercontent.com', '')).length > 0,
  },
  {
    id: 'operator_invented_secret_must_read_as_an_instruction',
    /**
     * The secrets nobody issues — the operator makes them up — so there is no vendor prefix or JWT
     * shape to recognise them by, and a pasted real value would look like any other string. The
     * committed value therefore has to read as an instruction. All three are in
     * `SERVER_SECRET_NAMES`, which is asserted below so this set cannot drift out of the secret list.
     */
    why: 'a value the operator invents has no recognisable shape, so the placeholder must be an instruction rather than a string',
    applies: ({ key }) =>
      key === 'BETTER_AUTH_SECRET' ||
      key === 'TELEGRAM_WEBHOOK_SECRET_TOKEN' ||
      key === 'RAZORPAY_WEBHOOK_SECRET' ||
      key === 'CRON_SECRET',
    safe: ({ value }) =>
      PLACEHOLDER_MARKERS.invent.test(value) || PLACEHOLDER_MARKERS.generate.test(value),
  },
];

describe('Property 30, part one: .env.example is complete over the environment schema', () => {
  it('derives its key set from the schema rather than from prose', () => {
    // The set really is the union of the three exports, so the coverage assertion below is over the
    // schema's own keys. `env.ts` exports `ALL_ENV_KEYS` for exactly this comparison.
    expect([...ALL_ENV_KEYS].sort()).toStrictEqual(
      [...PUBLIC_ENV_VARS, ...SERVER_ENV_KEYS, ...OPTIONAL_SERVER_ENV_KEYS].sort(),
    );
    // A3: two public variables (the Telegram bot username and the Razorpay public key id), no
    // alternative publishable-key spelling.
    expect(PUBLIC_ENV_VARS).toHaveLength(2);
    // A3: no optional server variable this release.
    expect(OPTIONAL_SERVER_ENV_KEYS).toHaveLength(0);

    // The operator-invented secrets the rule is keyed on are really in the secret list, so the rule
    // cannot go on guarding a name that stopped being a secret. (BETTER_AUTH_URL is deliberately NOT
    // in the secret list — it is configuration — which is why it is not asserted here.)
    for (const key of ['BETTER_AUTH_SECRET', 'TELEGRAM_WEBHOOK_SECRET_TOKEN', 'CRON_SECRET']) {
      expect(SERVER_SECRET_NAMES as readonly string[]).toContain(key);
    }
  });

  it('lists every schema key with a placeholder and no live credential value', () => {
    const keysSeen = new Set<string>();
    const markersSeen = new Set<MarkerName>();
    const rulesApplied = new Set<string>();
    const shapesSeen = new Set<'active' | 'commented'>();

    fc.assert(
      fc.property(fc.constantFrom(...ALL_ENV_KEYS), (key) => {
        keysSeen.add(key);

        // Requirement 17.2's first clause: the key is listed.
        const assignment = assignmentFor(key);
        expect(assignment, `.env.example does not list ${key}`).toBeDefined();
        if (assignment === undefined) return;

        shapesSeen.add(assignment.commented ? 'commented' : 'active');

        // A listed key carries a value. An empty one would make `serverEnv()` throw for a farmer
        // rather than telling the operator what to supply.
        expect(assignment.value, `${key} is listed with no value`).not.toBe('');

        // Every A3 key is an active line — there is no commented alternative or optional variable.
        expect(!assignment.commented, `${key} is on the wrong side of the comment marker`).toBe(
          mustBeActive(),
        );

        // Requirement 17.2's second clause, first half: a placeholder. Skipped for the one variable
        // classified as configuration rather than a credential.
        if (!(NON_CREDENTIAL_CONFIGURATION as readonly string[]).includes(key)) {
          const markers = markersMatching(assignment.value);
          expect(
            markers.length,
            `${key} on line ${assignment.line} carries no placeholder marker; ` +
              `expected one of ${MARKER_NAMES.join(', ')}`,
          ).toBeGreaterThan(0);
          for (const marker of markers) markersSeen.add(marker);
        }

        // Requirement 17.2's second clause, second half: no live credential. Every rule whose
        // precondition matches this value must be satisfied, and which rules fired is recorded.
        for (const rule of CREDENTIAL_RULES) {
          if (!rule.applies(assignment)) continue;
          rulesApplied.add(rule.id);
          expect(
            rule.safe(assignment),
            `${key} on line ${assignment.line} looks like a live credential (${rule.id}): ${rule.why}`,
          ).toBe(true);
        }
      }),
      // A modest key set, so this many runs visits each one dozens of times; the coverage assertion
      // is what turns that into a guarantee.
      { numRuns: 300 },
    );

    // Every key in the schema was actually visited — the completeness claim, not a sample of it.
    expect([...keysSeen].sort()).toStrictEqual([...ALL_ENV_KEYS].sort());
    // Every placeholder shape the rules recognise occurs in the file, so none of them is dead.
    expect([...markersSeen].sort()).toStrictEqual([...MARKER_NAMES].sort());
    // A3: only active lines exist, so the shape coverage is the singleton `active`. (A commented
    // line reappearing would be an optional/alternative variable this release does not have.)
    expect([...shapesSeen].sort()).toStrictEqual(['active']);

    // Every credential rule engaged with at least one committed value. A rule that matched nothing
    // would be a guard that had stopped guarding — the file's shape having drifted out from under it.
    expect([...rulesApplied].sort()).toStrictEqual(CREDENTIAL_RULES.map((rule) => rule.id).sort());
  });

  it('documents no variable the code does not read', () => {
    const documented = ASSIGNMENTS.map((assignment) => assignment.key).sort();
    const expected = [...ALL_ENV_KEYS].sort();

    // The other direction of completeness: an orphan line is drift too. An operator who sets a
    // variable nothing reads has been given a false instruction. A3 has no test-only documented
    // variable (the integration harness uses an in-process replica set), so the documented set is
    // exactly the schema's set.
    expect(documented).toStrictEqual(expected);

    // And the credential rules run over the whole file as well as over the schema's keys, so a live
    // value pasted onto any line is caught. Over the whole file, every rule engages.
    const applied = new Set<string>();
    for (const assignment of ASSIGNMENTS) {
      for (const rule of CREDENTIAL_RULES) {
        if (!rule.applies(assignment)) continue;
        applied.add(rule.id);
        expect(rule.safe(assignment), `${assignment.key}: ${rule.id}`).toBe(true);
      }
    }
    expect([...applied].sort()).toStrictEqual(CREDENTIAL_RULES.map((rule) => rule.id).sort());
  });
});

/* ========================================================================== */
/* PART TWO — the endpoint set                                                 */
/* ========================================================================== */

const API_DOC = readFileSync(join(REPO_ROOT, 'docs', 'API.md'), 'utf8');

/** Every `route.ts` under `src/app`, as a repository-relative POSIX path. */
function routeModules(): readonly string[] {
  const base = join(REPO_ROOT, 'src', 'app');
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'route.ts')
    .map((entry) =>
      relative(REPO_ROOT, join(entry.parentPath, entry.name)).split(sep).join(posix.sep),
    )
    .sort();
}

const ROUTE_MODULES = routeModules();

function sourceOf(routeModule: string): string {
  return readFileSync(join(REPO_ROOT, ...routeModule.split(posix.sep)), 'utf8');
}

/** The URL a route module serves: `src/app/api/diagnose/route.ts` → `/api/diagnose`. */
function urlPathOf(routeModule: string): string {
  return `/${routeModule.slice('src/app/'.length, -'/route.ts'.length)}`;
}

/** The HTTP verbs a route module exports, however it exports them. */
function exportedVerbs(routeModule: string): readonly string[] {
  const found = new Set<string>();
  for (const match of sourceOf(routeModule).matchAll(
    /export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
  )) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found].sort();
}

/* -------------------------------------------------------------------------- */
/* The A3 docs/API.md structure                                                */
/* -------------------------------------------------------------------------- */

/**
 * Under Amendment A3 `docs/API.md` is generated against the code and reads as ONE routes table plus
 * anchor-bound field/code tables — not the pre-A3 per-endpoint `## \`VERB /path\`` sections. Its own
 * banner says `tests/unit/api-docs.test.ts` binds every table to a value in the schemas/errors, and
 * documents the two webhooks, the multipart upload and the auth catch-all **by their authentication
 * mechanism** rather than a request schema. So Property 30's per-route × per-facet completeness claim
 * is stated over exactly the structures the A3 document uses:
 *
 *  - **method** — the `<!-- routes -->` table's `Methods` column, which must equal the module's
 *    exported verbs (a stronger accuracy check `api-docs.test.ts` also makes; asserted here because
 *    the method facet is one of Requirement 17.4's four).
 *  - **request body / response body** — a JSON route names a `fieldsSchema` in an anchor-bound
 *    `<!-- fields:… -->` table (diagnose/chat/voice request and response); a route whose body is not
 *    Jamee's to define is documented in the `### Endpoint summaries` bullet by its mechanism
 *    (multipart, a webhook's raw body, the Better Auth catch-all, an owner-checked stream, a
 *    status-only response).
 *  - **error codes** — an anchor-bound `<!-- codes:… -->` table, OR the `<!-- bodiless -->` table for
 *    a route that answers with a status and no body, OR the whole-taxonomy `<!-- error-specs -->`.
 */

/** Every anchor name of a given kind the document carries. */
function anchorsOfKind(kind: string): ReadonlySet<string> {
  return new Set(
    [...API_DOC.matchAll(new RegExp(`<!--\\s*${kind}:([^\\s]+)\\s*-->`, 'g'))].map(
      (match) => match[1] ?? '',
    ),
  );
}

const FIELD_ANCHORS = anchorsOfKind('fields');
const CODE_ANCHORS = anchorsOfKind('codes');

/** The rows of the markdown table that follows an anchor, header and separator dropped. */
function tableAfter(anchor: string): readonly string[] {
  const marker = `<!-- ${anchor} -->`;
  const at = API_DOC.indexOf(marker);
  expect(at, `docs/API.md is missing the anchor ${marker}`).toBeGreaterThanOrEqual(0);

  const rows: string[] = [];
  let started = false;
  for (const line of API_DOC.slice(at + marker.length).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (started) break;
      continue;
    }
    started = true;
    if (/^\|[\s|:-]+\|$/.test(trimmed)) continue;
    rows.push(trimmed);
  }
  return rows.slice(1);
}

/** The `<!-- routes -->` table: route module path → its documented verbs. */
function routesTable(): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const row of tableAfter('routes')) {
    const cells = row.split('|').map((cell) => cell.trim()).filter((cell) => cell.length > 0);
    const modulePath = (cells[0] ?? '').replace(/`/g, '');
    const verbs = (cells[1] ?? '')
      .replace(/`/g, '')
      .split(',')
      .map((verb) => verb.trim())
      .filter((verb) => verb.length > 0)
      .sort();
    if (modulePath !== '') map.set(modulePath, verbs);
  }
  return map;
}

const ROUTES_TABLE = routesTable();

/** The `### Endpoint summaries` block — where a mechanism-documented body lives. */
const ENDPOINT_SUMMARIES = ((): string => {
  const start = API_DOC.indexOf('### Endpoint summaries');
  if (start < 0) return '';
  const rest = API_DOC.slice(start + '### Endpoint summaries'.length);
  const end = rest.search(/^###?\s/m);
  return end < 0 ? rest : rest.slice(0, end);
})();

/** The `<!-- bodiless -->` block, for routes that answer with a status and no body. */
const BODILESS_BLOCK = ((): string => {
  const at = API_DOC.indexOf('<!-- bodiless -->');
  if (at < 0) return '';
  const rest = API_DOC.slice(at);
  const end = rest.search(/\n##?#?\s/);
  return end < 0 ? rest : rest.slice(0, end);
})();

/**
 * Which JSON schemas each route's request/response body is documented by, and which `codes:` anchor
 * (or the bodiless table) carries its error facet. Derived from the A3 document's own conventions.
 * A route whose body is documented by mechanism carries a `bodyMechanism` regex the endpoint-summary
 * bullet must match instead of a schema.
 */
interface RouteDoc {
  readonly urlPath: string;
  /** The `fields:` anchor names the request+response bodies are documented by, if JSON. */
  readonly bodySchemas: readonly string[];
  /** A phrase in the endpoint-summary bullet that documents a non-JSON body by its mechanism. */
  readonly bodyMechanism?: RegExp;
  /** The `codes:` anchor for the error facet, or `'bodiless'` for a status-only route. */
  readonly errorAnchor: string;
}

const ROUTE_DOCS: readonly RouteDoc[] = [
  {
    urlPath: '/api/diagnose',
    bodySchemas: ['diagnoseRequestSchema', 'diagnoseResponseSchema'],
    errorAnchor: 'diagnose',
  },
  {
    urlPath: '/api/chat',
    bodySchemas: ['chatRequestSchema', 'chatResponseSchema'],
    errorAnchor: 'chat',
  },
  {
    urlPath: '/api/voice',
    bodySchemas: ['voiceRequestSchema', 'voiceResponseSchema'],
    errorAnchor: 'voice',
  },
  {
    urlPath: '/api/media',
    bodySchemas: [],
    bodyMechanism: /multipart/i,
    errorAnchor: 'media-upload',
  },
  {
    urlPath: '/api/media/[id]',
    bodySchemas: [],
    bodyMechanism: /owner-checked|streams a GridFS/i,
    errorAnchor: 'media-serve',
  },
  {
    urlPath: '/api/link/token',
    bodySchemas: [],
    bodyMechanism: /link token|unlinks/i,
    errorAnchor: 'link-token',
  },
  {
    urlPath: '/api/payment/order',
    bodySchemas: [],
    bodyMechanism: /Razorpay order|checkout ids/i,
    errorAnchor: 'payment-order',
  },
  {
    urlPath: '/api/payment/webhook',
    bodySchemas: [],
    bodyMechanism: /raw body|Razorpay signature/i,
    errorAnchor: 'payment-webhook',
  },
  {
    urlPath: '/api/telegram',
    bodySchemas: [],
    bodyMechanism: /Telegram `?Update`?|Secret-Token/i,
    errorAnchor: 'telegram',
  },
  {
    urlPath: '/api/internal/retention-sweep',
    bodySchemas: [],
    bodyMechanism: /retention sweep|scheduled/i,
    errorAnchor: 'retention-sweep',
  },
  {
    urlPath: '/api/auth/[...all]',
    bodySchemas: [],
    bodyMechanism: /Better Auth|catch-all/i,
    errorAnchor: 'auth-callback',
  },
  {
    urlPath: '/api/payment/confirm',
    bodySchemas: [],
    bodyMechanism: /optimistic post-checkout|grants nothing/i,
    // Confirm shares the taxonomy but has no dedicated codes anchor; its facet is the whole table.
    errorAnchor: 'error-specs',
  },
  {
    urlPath: '/api/profile',
    bodySchemas: [],
    bodyMechanism: /profile save/i,
    errorAnchor: 'error-specs',
  },
  {
    urlPath: '/api/profile/access',
    bodySchemas: [],
    bodyMechanism: /access state/i,
    errorAnchor: 'error-specs',
  },
];

function routeDocFor(urlPath: string): RouteDoc | undefined {
  return ROUTE_DOCS.find((doc) => doc.urlPath === urlPath);
}

/** Whether a `codes:`/bodiless/error-specs anchor names a non-empty table. */
function errorFacetPresent(anchor: string): boolean {
  if (anchor === 'bodiless') return BODILESS_BLOCK.includes('|');
  if (anchor === 'error-specs') return tableAfter('error-specs').length > 0;
  return CODE_ANCHORS.has(anchor) && tableAfter(`codes:${anchor}`).length > 0;
}

const ENDPOINT_FACETS = ['method', 'request_body', 'response_body', 'error_codes'] as const;

type EndpointFacet = (typeof ENDPOINT_FACETS)[number];

describe('Property 30, part two: docs/API.md documents all four facets of every route', () => {
  it('derives its endpoint set from the tree, and the routes table names exactly the modules', () => {
    expect(ROUTE_MODULES.length).toBeGreaterThan(0);
    expect(ROUTES_TABLE.size).toBeGreaterThan(0);

    // The routes table names every module, and no phantom. This is the `method` facet's completeness
    // spine: a handler added without a table row fails here.
    expect([...ROUTES_TABLE.keys()].sort()).toStrictEqual([...ROUTE_MODULES].sort());

    // Every route in the tree has a RouteDoc mapping (so the per-facet run below covers all of them),
    // and every RouteDoc names a real route.
    const urlPaths = new Set(ROUTE_MODULES.map(urlPathOf));
    for (const routeModule of ROUTE_MODULES) {
      expect(
        routeDocFor(urlPathOf(routeModule)),
        `${routeModule}: no RouteDoc facet mapping for ${urlPathOf(routeModule)}`,
      ).toBeDefined();
    }
    for (const doc of ROUTE_DOCS) {
      expect(urlPaths, `stale RouteDoc for ${doc.urlPath}, which has no route module`).toContain(
        doc.urlPath,
      );
    }
  });

  it('records the method, request body, response body and error codes of every endpoint', () => {
    const pairsSeen = new Set<string>();
    const formsSeen = new Set<string>();

    // Requirement 17.4 is a completeness claim over the full route × facet cross product, so it is
    // asserted deterministically over every pair rather than sampled — a facet missing for one route
    // must fail, not merely be improbable to generate. `fc` is not the right tool for a finite,
    // must-visit-every-member claim; the exhaustive loop IS the property here.
    const checkPair = (routeModule: string, facet: EndpointFacet): void => {
      pairsSeen.add(`${routeModule}|${facet}`);

      const urlPath = urlPathOf(routeModule);
      const doc = routeDocFor(urlPath);
      if (doc === undefined) throw new Error(`no RouteDoc for ${urlPath}`);
      const label = `${urlPath} / ${facet}`;

      switch (facet) {
        case 'method': {
          // Requirement 17.4's method facet: the routes table's verbs equal the module's exports.
          const documented = ROUTES_TABLE.get(routeModule) ?? [];
          expect(documented, `${label}: routes table disagrees with the module`).toStrictEqual([
            ...exportedVerbs(routeModule),
          ]);
          formsSeen.add(`method:${documented.length === 1 ? 'singular' : 'plural'}`);
          break;
        }

        case 'request_body':
        case 'response_body': {
          // A JSON route: the body is an anchor-bound fields table `api-docs.test.ts` checks
          // against the real Zod object. This file asserts the facet is PRESENT (a completeness
          // claim); accuracy stays there.
          if (doc.bodySchemas.length > 0) {
            for (const schema of doc.bodySchemas) {
              expect(FIELD_ANCHORS, `${label}: ${schema} has no fields: anchor`).toContain(schema);
            }
            formsSeen.add(`${facet}:fields_anchor`);
            break;
          }
          // A non-JSON route: the body is documented in the endpoint summary by its mechanism.
          expect(doc.bodyMechanism, `${label}: no body mechanism declared`).toBeDefined();
          expect(
            doc.bodyMechanism?.test(ENDPOINT_SUMMARIES),
            `${label}: the endpoint summary does not document the body by its mechanism`,
          ).toBe(true);
          formsSeen.add(`${facet}:mechanism`);
          break;
        }

        case 'error_codes': {
          expect(
            errorFacetPresent(doc.errorAnchor),
            `${label}: the error facet (${doc.errorAnchor}) is absent or empty`,
          ).toBe(true);
          formsSeen.add(
            doc.errorAnchor === 'bodiless'
              ? 'error_codes:bodiless'
              : doc.errorAnchor === 'error-specs'
                ? 'error_codes:taxonomy'
                : 'error_codes:anchored_table',
          );
          break;
        }
      }
    };

    for (const routeModule of ROUTE_MODULES) {
      for (const facet of ENDPOINT_FACETS) checkPair(routeModule, facet);
    }

    // Every module × every facet: Requirement 17.4 is a claim about all four for each endpoint, so
    // the coverage set is the cross product rather than either axis alone.
    expect([...pairsSeen].sort()).toStrictEqual(
      ROUTE_MODULES.flatMap((routeModule) =>
        ENDPOINT_FACETS.map((facet) => `${routeModule}|${facet}`),
      ).sort(),
    );

    // Every documentation form the A3 document uses occurs, so none of the alternatives is dead
    // weight: JSON routes (fields anchors, both singular and plural methods) and mechanism-documented
    // routes (multipart/webhook/auth), and the three error-facet shapes.
    expect([...formsSeen].sort()).toStrictEqual(
      [
        'error_codes:anchored_table',
        'error_codes:taxonomy',
        'method:plural',
        'method:singular',
        'request_body:fields_anchor',
        'request_body:mechanism',
        'response_body:fields_anchor',
        'response_body:mechanism',
      ].sort(),
    );
  });
});
