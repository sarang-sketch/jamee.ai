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
 * A hand-copied list of eleven variables and six routes would pass today and rot silently, which is
 * precisely the failure Requirement 17.2 and 17.4 are about — a deployment package that no longer
 * describes the deployment.
 *
 * The **coverage assertions** after each run are what make the derivation load-bearing rather than
 * decorative: they assert that the run visited *every* member of the derived set, so a generator that
 * silently stopped producing one would fail rather than shrink the claim.
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
 * what keeps the file's long prose comments out of the result: a sentence mentioning
 * `SUPABASE_SERVICE_ROLE_KEY` carries no `=` in that position, so it is not an assignment. Both
 * directions of the completeness claim read this one parse.
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
 * Variables `.env.example` documents that are deliberately **not** in the application's schema.
 *
 * One member, and its absence from `serverEnvSchema` is a decision recorded in two places:
 * `tests/integration/database.ts` reads it directly because it is test scaffolding that never ships,
 * and `scripts/check-deployment.ts`'s header gives the same reasoning for its own operator inputs —
 * adding them to the server schema *"would make `.env.example` list variables the deployment does not
 * need"*. Asserted against that reader below rather than merely declared here.
 */
const TEST_ONLY_KEYS = ['JAMEE_TEST_DATABASE_URL'] as const;

/**
 * The one documented variable that is **configuration rather than a credential**, so no placeholder
 * rule applies to it: `env.ts` classifies it as *"an override for the case where Meta deprecates the
 * pinned version faster than a code change can ship, not a value an operator is expected to supply"*,
 * and `check-secret-scope.ts` deliberately keeps it out of `SERVER_SECRET_NAMES` because *"an API
 * version string carries no privilege"*. Its committed value is therefore a real version, on purpose.
 */
const NON_SECRET_CONFIGURATION = OPTIONAL_SERVER_ENV_KEYS;

/**
 * The alternative spelling of the public key, taken from `PUBLIC_ENV_VARS` **by position** rather
 * than by name so a rename in `env.public.ts` follows automatically.
 *
 * V1: current Supabase docs name the key `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` while older projects
 * issue an anon JWT under the older name, and `publicEnv()` accepts either, publishable first. So the
 * third entry is an alternative to the second, not a twelfth thing to configure — which is why its
 * line is commented out and why a commented line is the *correct* shape for it.
 */
const ALTERNATIVE_PUBLIC_KEY = PUBLIC_ENV_VARS[2];

/** A key whose line must be **active**, because copying the file has to yield a usable template. */
function mustBeActive(key: string): boolean {
  return (
    !(NON_SECRET_CONFIGURATION as readonly string[]).includes(key) && key !== ALTERNATIVE_PUBLIC_KEY
  );
}

/**
 * The shapes that read as "fill this in". A key that must not carry a live value has to match one.
 *
 * Enumerated, and every one of them is proven to occur in the file by the coverage assertion after
 * the run — a marker nothing matches would be a rule that had quietly stopped applying.
 */
const PLACEHOLDER_MARKERS = {
  /** `replace-with-your-…`, `REPLACE_WITH_SIGNATURE`, `gsk_replace_with_…`. */
  replace: /replace/i,
  /** `your-project-ref`, `REPLACE_WITH_YOUR_ANON_KEY_PAYLOAD`. */
  your: /your[-_]/i,
  /** `invent-a-long-random-string-…` — the two secrets the operator makes up. */
  invent: /invent/i,
  /** `generate-a-random-string-…`. */
  generate: /generate/i,
  /** A run of zeros, which is how an id-shaped or key-shaped placeholder is written. */
  zeros: /0{4,}/,
} as const;

type MarkerName = keyof typeof PLACEHOLDER_MARKERS;

const MARKER_NAMES = Object.keys(PLACEHOLDER_MARKERS) as readonly MarkerName[];

function markersMatching(value: string): readonly MarkerName[] {
  return MARKER_NAMES.filter((name) => PLACEHOLDER_MARKERS[name].test(value));
}

/**
 * The "no live credential" half, as seven rules over the *shape* of a value.
 *
 * Each rule is a **precondition plus a requirement**: the precondition says which values the rule
 * looks at, and the requirement says what such a value must be. That structure is what lets the
 * coverage assertion prove the rules engage with this file's real content rather than passing because
 * nothing matched them.
 *
 * The rules are aimed at the realistic accident — someone pastes a working value into the committed
 * example while getting their own environment running — which is why each names the credential family
 * it guards and says what a live one looks like.
 */
interface CredentialRule {
  readonly id: string;
  readonly why: string;
  applies(assignment: Assignment): boolean;
  safe(assignment: Assignment): boolean;
}

const JWT_SHAPE = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The one rule whose credential family appears **only** on the documented test-only line, so it
 * cannot engage in a run over the schema's own keys.
 *
 * Named here rather than left to be noticed: `JAMEE_TEST_DATABASE_URL` is deliberately outside
 * `serverEnvSchema` (it is test scaffolding), so the connection-string rule is exercised by the
 * whole-file scan below instead. Every other rule must engage in both.
 */
const TEST_ONLY_RULE_ID = 'database_url_must_be_local';

const CREDENTIAL_RULES: readonly CredentialRule[] = [
  {
    id: 'jwt_must_be_marked',
    why: 'a Supabase anon or service-role key is a three-segment JWT; a live one carries a real base64url payload and signature, and the committed placeholder must say REPLACE_WITH in both',
    applies: ({ value }) => JWT_SHAPE.test(value),
    safe: ({ value }) => {
      const [, payload = '', signature = ''] = value.split('.');
      return payload.includes('REPLACE_WITH') && signature.includes('REPLACE_WITH');
    },
  },
  {
    id: 'supabase_host_must_be_placeholder',
    why: 'a live project URL carries a 20-character project ref, which identifies a real deployment even though the URL itself is public',
    applies: ({ value }) => /^https:\/\/[^/]+\.supabase\.co\/?$/.test(value),
    safe: ({ value }) => markersMatching(value.replace('.supabase.co', '')).length > 0,
  },
  {
    id: 'publishable_key_must_be_marked',
    why: "Supabase's publishable keys are `sb_publishable_` plus real entropy",
    applies: ({ value }) => value.startsWith('sb_publishable_'),
    safe: ({ value }) => markersMatching(value.slice('sb_publishable_'.length)).length > 0,
  },
  {
    id: 'groq_key_must_be_marked',
    why: '`.env.example` itself records that real Groq keys start `gsk_`',
    applies: ({ value }) => value.startsWith('gsk_'),
    safe: ({ value }) => PLACEHOLDER_MARKERS.replace.test(value.slice('gsk_'.length)),
  },
  {
    id: 'database_url_must_be_local',
    why: 'a connection string is a credential in URL form; the only one that may be committed is the local default',
    applies: ({ value }) => /^postgres(ql)?:\/\//.test(value),
    safe: ({ value }) => /@(127\.0\.0\.1|localhost)[:/]/.test(value),
  },
  {
    id: 'numeric_value_must_be_zeros',
    why: 'a real WhatsApp phone number id is a numeric identifier, so a numeric value that is not a zero run is somebody’s real one',
    applies: ({ value }) => /^\d+$/.test(value),
    safe: ({ value }) => /^0+$/.test(value),
  },
  {
    id: 'operator_invented_secret_must_read_as_an_instruction',
    /**
     * The two secrets nobody issues — the operator makes them up — so there is no vendor prefix or
     * JWT shape to recognise them by, and a pasted real value would look like any other string. The
     * committed value therefore has to read as an instruction. Both are in `SERVER_SECRET_NAMES`,
     * which is asserted below so this pair cannot drift out of the secret list.
     */
    why: 'a value the operator invents has no recognisable shape, so the placeholder must be an instruction rather than a string',
    applies: ({ key }) => key === 'WHATSAPP_VERIFY_TOKEN' || key === 'CRON_SECRET',
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
    expect(PUBLIC_ENV_VARS).toHaveLength(3);
    expect(ALTERNATIVE_PUBLIC_KEY).toBeDefined();

    // The two operator-invented secrets rule 7 is keyed on are really in the secret list, so the
    // rule cannot go on guarding a name that stopped being a secret.
    for (const key of ['WHATSAPP_VERIFY_TOKEN', 'CRON_SECRET']) {
      expect(SERVER_SECRET_NAMES as readonly string[]).toContain(key);
    }

    // And the one documented extra really is read by the module that justifies its absence from the
    // schema, so `TEST_ONLY_KEYS` is anchored to a reader rather than to this file's opinion.
    const databaseModule = readFileSync(
      join(REPO_ROOT, 'tests', 'integration', 'database.ts'),
      'utf8',
    );
    for (const key of TEST_ONLY_KEYS) expect(databaseModule).toContain(key);
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

        // Required keys are active lines; the two documented alternatives/overrides are commented,
        // which is the shape their own comments describe.
        expect(!assignment.commented, `${key} is on the wrong side of the comment marker`).toBe(
          mustBeActive(key),
        );

        // Requirement 17.2's second clause, first half: a placeholder. Skipped for the one variable
        // classified as configuration rather than a credential.
        if (!(NON_SECRET_CONFIGURATION as readonly string[]).includes(key)) {
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
      // Twelve keys, so this many runs visits each one dozens of times; the coverage assertion is
      // what turns that into a guarantee.
      { numRuns: 300 },
    );

    // Every key in the schema was actually visited — the completeness claim, not a sample of it.
    expect([...keysSeen].sort()).toStrictEqual([...ALL_ENV_KEYS].sort());
    // Every placeholder shape the rules recognise occurs in the file, so none of them is dead.
    expect([...markersSeen].sort()).toStrictEqual([...MARKER_NAMES].sort());
    // And both line shapes occur, so the active/commented split was exercised in both directions.
    expect([...shapesSeen].sort()).toStrictEqual(['active', 'commented']);

    // Every credential rule that guards a schema key engaged with at least one committed value. A
    // rule that matched nothing would be a guard that had stopped guarding — the file's shape having
    // drifted out from under it.
    expect([...rulesApplied].sort()).toStrictEqual(
      CREDENTIAL_RULES.map((rule) => rule.id)
        .filter((id) => id !== TEST_ONLY_RULE_ID)
        .sort(),
    );
  });

  it('documents no variable the code does not read', () => {
    const documented = ASSIGNMENTS.map((assignment) => assignment.key).sort();
    const expected = [...ALL_ENV_KEYS, ...TEST_ONLY_KEYS].sort();

    // The other direction of completeness: an orphan line is drift too. An operator who sets a
    // variable nothing reads has been given a false instruction.
    expect(documented).toStrictEqual(expected);

    // And the credential rules run over the whole file rather than only over the schema's keys, so
    // the test-only line is covered as well — which is where the connection-string rule engages.
    const applied = new Set<string>();
    for (const assignment of ASSIGNMENTS) {
      for (const rule of CREDENTIAL_RULES) {
        if (!rule.applies(assignment)) continue;
        applied.add(rule.id);
        expect(rule.safe(assignment), `${assignment.key}: ${rule.id}`).toBe(true);
      }
    }

    // Over the whole file, all seven engage.
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

interface DocSection {
  /** The verbs named in the heading — `GET|POST` is two. */
  readonly verbs: readonly string[];
  readonly path: string;
  readonly body: string;
}

/**
 * The per-endpoint sections of `docs/API.md`, keyed by the URL in their own heading.
 *
 * A section runs from its `## \`VERB /path\`` heading to the next `## `. Parsed from the headings
 * rather than from the route table, deliberately: `api-docs.test.ts` already checks the table against
 * the module list, so reading the table here would make this claim depend on that one. The headings
 * are the part of the document a reader navigates by.
 */
function docSections(): readonly DocSection[] {
  const lines = API_DOC.split('\n');
  const sections: DocSection[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##\s+`([A-Z|]+)\s+(\/\S*)`/.exec(lines[index] ?? '');
    if (heading === null) continue;

    const end = lines.findIndex((line, at) => at > index && /^##\s/.test(line));
    sections.push({
      verbs: (heading[1] ?? '').split('|').sort(),
      path: heading[2] ?? '',
      body: lines.slice(index + 1, end === -1 ? lines.length : end).join('\n'),
    });
  }

  return sections;
}

const DOC_SECTIONS = docSections();

/**
 * Requirement 17.4's four facets, one per clause of the sentence.
 *
 * `method` is checked against the module's real exports; the other three are checked for presence in
 * the endpoint's own section, in any of the forms the document legitimately uses.
 */
const ENDPOINT_FACETS = ['method', 'request_body', 'response_body', 'error_codes'] as const;

type EndpointFacet = (typeof ENDPOINT_FACETS)[number];

/**
 * The accepted forms of a facet.
 *
 * Two forms rather than one because two endpoints have **no** body to describe, and Requirement 17.4
 * is satisfied by saying so rather than by omitting the section: the webhook's GET carries a query
 * string and echoes a challenge, and the sweep reads no body *"not even on `POST`"*. A rule that
 * demanded a `### Request body` heading everywhere would push the document into documenting a body
 * that does not exist.
 *
 * Each form is proven to occur somewhere in the document by the coverage assertion after the run, so
 * a form nobody uses cannot sit here weakening the check.
 */
const FACET_FORMS = {
  request_body: {
    /** `### Request body` — optionally followed by the schema it is generated from. */
    heading: /^###\s+Request body\b(.*)$/m,
    /** `- **Request body:** none` — a bullet in the endpoint's summary list. */
    bullet: /^-\s+\*\*Request body:\*\*\s*(.+)$/m,
    /** The webhook GET's sentence: there is no body, and no response schema either. */
    sentence: /There is no request body\b/,
  },
  response_body: {
    heading: /^###\s+Response body\b(.*)$/m,
    /** `### Responses` — the redirect route answers with statuses rather than one body. */
    table: /^###\s+Responses\b/m,
    /** `- **Success:** \`200\` with …` */
    bullet: /^-\s+\*\*Success:\*\*\s*(.+)$/m,
  },
} as const;

/** Every `fields:` anchor the document carries — the tables `api-docs.test.ts` checks. */
const FIELD_ANCHORS = new Set(
  [...API_DOC.matchAll(/<!--\s*fields:([^\s]+)\s*-->/g)].map((match) => match[1] ?? ''),
);

/** Every `codes:` anchor, likewise. */
const CODE_ANCHORS = new Set(
  [...API_DOC.matchAll(/<!--\s*codes:([^\s]+)\s*-->/g)].map((match) => match[1] ?? ''),
);

/** The schema a facet heading names, if it names one: `### Request body — \`chatRequestSchema\``. */
function schemaNamedIn(headingTail: string): string | undefined {
  const match = /`([A-Za-z][A-Za-z0-9.]*Schema)`/.exec(headingTail);
  return match?.[1];
}

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

describe('Property 30, part two: docs/API.md documents all four facets of every route', () => {
  it('derives its endpoint set from the tree, and every module has a section', () => {
    expect(ROUTE_MODULES.length).toBeGreaterThan(0);

    for (const routeModule of ROUTE_MODULES) {
      const path = urlPathOf(routeModule);
      const sections = DOC_SECTIONS.filter((section) => section.path === path);
      expect(sections.length, `docs/API.md documents no endpoint at ${path}`).toBeGreaterThan(0);

      // The verbs in the headings, across however many sections the endpoint is split into, are
      // exactly the verbs the module exports. A handler added without a section fails here, and so
      // does a section for a verb that no longer exists.
      const documented = [...new Set(sections.flatMap((section) => section.verbs))].sort();
      expect(documented, `${path}: documented verbs disagree with ${routeModule}`).toStrictEqual([
        ...exportedVerbs(routeModule),
      ]);
    }

    // No section for a path that has no route module.
    const paths = new Set(ROUTE_MODULES.map(urlPathOf));
    for (const section of DOC_SECTIONS) {
      expect(paths, `docs/API.md documents ${section.path}, which has no route module`).toContain(
        section.path,
      );
    }
  });

  it('records the method, request body, response body and error codes of every endpoint', () => {
    const pairsSeen = new Set<string>();
    const formsSeen = new Set<string>();

    fc.assert(
      fc.property(
        fc.constantFrom(...ROUTE_MODULES),
        fc.constantFrom<EndpointFacet>(...ENDPOINT_FACETS),
        (routeModule, facet) => {
          pairsSeen.add(`${routeModule}|${facet}`);

          const path = urlPathOf(routeModule);
          const sections = DOC_SECTIONS.filter((section) => section.path === path);

          for (const section of sections) {
            const label = `${section.verbs.join('|')} ${path} / ${facet}`;

            switch (facet) {
              case 'method': {
                // Named in the summary bullet as well as in the heading, because the heading is a
                // title and the bullet is the statement. Either singular or plural, since one
                // section covers two verbs.
                const bullet = /^-\s+\*\*Methods?:\*\*\s*(.+)$/m.exec(section.body);
                expect(bullet, `${label}: no Method bullet`).not.toBeNull();
                for (const verb of section.verbs) {
                  expect(bullet?.[1] ?? '', label).toContain(verb);
                }
                formsSeen.add(`method:${section.verbs.length === 1 ? 'singular' : 'plural'}`);
                break;
              }

              case 'request_body':
              case 'response_body': {
                const forms = FACET_FORMS[facet];
                const matched = Object.entries(forms).filter(([, pattern]) =>
                  pattern.test(section.body),
                );
                expect(
                  matched.length,
                  `${label}: the section describes no request/response body in any accepted form`,
                ).toBeGreaterThan(0);

                for (const [name] of matched) formsSeen.add(`${facet}:${name}`);

                // Where a facet names a schema, that schema must be one of the anchor-bound tables
                // `api-docs.test.ts` checks against the real Zod object. That is how this file stays
                // a completeness claim while the accuracy claim stays where it already is.
                const headingMatch = forms.heading.exec(section.body);
                const named = schemaNamedIn(headingMatch?.[1] ?? '');
                if (named !== undefined) {
                  expect(FIELD_ANCHORS, `${label}: ${named} has no fields: anchor`).toContain(named);
                  formsSeen.add(`${facet}:named_schema`);
                }
                break;
              }

              case 'error_codes': {
                expect(
                  /^###\s+Error codes\b/m.test(section.body),
                  `${label}: no Error codes section`,
                ).toBe(true);

                const anchor = /<!--\s*codes:([^\s]+)\s*-->/.exec(section.body);
                expect(anchor, `${label}: the Error codes section carries no codes: anchor`).not.toBeNull();

                const name = anchor?.[1] ?? '';
                expect(CODE_ANCHORS, label).toContain(name);
                // A table with rows. An empty one would document the *facet* and no codes.
                expect(tableAfter(`codes:${name}`).length, label).toBeGreaterThan(0);
                formsSeen.add('error_codes:anchored_table');
                break;
              }
            }
          }
        },
      ),
      { numRuns: 300 },
    );

    // Every module × every facet: Requirement 17.4 is a claim about all four for each endpoint, so
    // the coverage set is the cross product rather than either axis alone.
    expect([...pairsSeen].sort()).toStrictEqual(
      ROUTE_MODULES.flatMap((routeModule) =>
        ENDPOINT_FACETS.map((facet) => `${routeModule}|${facet}`),
      ).sort(),
    );

    // And every accepted form occurs somewhere, so none of the alternatives above is dead weight.
    expect([...formsSeen].sort()).toStrictEqual(
      [
        'error_codes:anchored_table',
        'method:plural',
        'method:singular',
        'request_body:bullet',
        'request_body:heading',
        'request_body:named_schema',
        'request_body:sentence',
        'response_body:bullet',
        'response_body:heading',
        'response_body:named_schema',
        'response_body:table',
      ].sort(),
    );
  });
});
