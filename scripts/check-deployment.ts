/**
 * `check-deployment` — the guard that turns "the migrations reported success" into "this
 * deployment is actually correct".
 *
 * Requirements: 4.1 (the Knowledge_Base holds exactly the five Verified_Conditions), 4.2 (every
 *               row's `source` is populated), 13.1 (RLS is enabled on every farmer-scoped table),
 *               13.5 (the `crop-images` and `voice-messages` buckets are private), 17.6 (the
 *               migrations create every table, RLS policy, storage bucket, and seed row — this
 *               script is the evidence that they did)
 * Design: "Database schema", "Security boundary — Row Level Security", "WhatsApp adapter → GET —
 *         webhook verification"
 * Procedure: `docs/DEPLOYMENT.md` **step 3** (knowledge base, buckets, RLS) and **step 7** (the
 *            webhook GET). Step 3 names this script by the command below and lists the four
 *            assertions; the webhook one belongs to step 7, so the script is run **twice** — once
 *            after the migrations and again after the webhook is registered.
 *
 * Run it:  `npm run check:deployment`
 *          (`node --experimental-strip-types scripts/check-deployment.ts` — the exact command
 *           docs/DEPLOYMENT.md step 3 promises)
 *
 * Exit 0 only when every assertion is **verified and passing**. Exit 1 on any failure *and* on any
 * assertion that could not be verified, because "I could not check" must never read as "fine".
 *
 * =============================================================================
 * HOW THIS DIFFERS FROM THE OTHER TWO GUARDS — READ THIS FIRST
 * =============================================================================
 *
 * `check-secret-scope.ts` and `check-shared-implementation.ts` are static scans: they read the
 * repository, and their answer is a property of the source. **This one is not.** It asserts facts
 * about a *running* deployment — rows in a Postgres database, buckets in a Storage project, and the
 * HTTP behaviour of a deployed webhook. There is nothing in the repository that can make these
 * assertions true or false.
 *
 * Three consequences shape everything below.
 *
 * 1. **An unconfigured environment is a refusal, not a crash and not a pass.** Every probe reports
 *    its own missing inputs by name, the report opens with a CONFIGURATION section listing each
 *    variable as `set` or `absent`, and the run exits 1 with the substitute SQL from
 *    `docs/DEPLOYMENT.md` step 3 so an operator can complete the check by hand. Running this with
 *    an empty environment prints instructions; it does not throw on an undefined variable.
 *
 * 2. **Every assertion is a pure function of an observation.** The probe seam
 *    (`DeploymentProbe`) is the only thing that touches the network, and it is injected. The
 *    assertion functions take plain observation records, so `tests/unit/check-deployment.test.ts`
 *    pins both the passing and the failing shape of each one against fixtures with **no live
 *    project, no database, and no network**. That is the same seam discipline
 *    `retention.service.test.ts` and `whatsapp-dispatch.test.ts` use for their services.
 *
 * 3. **`tests/integration/` is not where this belongs.** That suite self-skips without
 *    `JAMEE_TEST_DATABASE_URL` and its dependency is a *Postgres connection*. Two of these four
 *    assertions need more than a database — a Storage project and a deployed HTTPS origin — so a
 *    gated integration test could only cover a fragment while implying it covered the whole. The
 *    script itself is the integration test, and it is run by an operator against the real
 *    deployment at the two points in the procedure that produce the facts it checks.
 *
 * =============================================================================
 * WHY THIS FILE READS `process.env` DIRECTLY INSTEAD OF `serverEnv()`
 * =============================================================================
 *
 * `src/lib/env.ts` is the only door to `process.env` for everything under `src/**`, and that rule
 * is enforced by `check-secret-scope.ts`. This file cannot use that door, for two mechanical
 * reasons rather than a stylistic one:
 *
 *   - `env.ts` begins with `import 'server-only'` and imports `@/lib/env.public`. Both the bare
 *     `server-only` specifier and the `@/*` alias are resolved by Next.js and by Vite — they are
 *     build-time facts, not Node ones. `node --experimental-strip-types` resolves neither, so
 *     importing it here would fail at module load. `check-secret-scope.ts` imports nothing from
 *     `src/` for the same reason.
 *   - This script also needs two variables that deliberately do **not** exist in `serverEnvSchema`:
 *     a database connection string and a deployment origin. They are operator inputs to a
 *     command-line check, never read by the application, and adding them to the server schema
 *     would make `.env.example` list variables the deployment does not need — the same reasoning
 *     `tests/integration/database.ts` applies to `JAMEE_TEST_DATABASE_URL`.
 *
 * `scripts/**` is outside `check-secret-scope.ts`'s scan root, so nothing here is enforced by it.
 * The compensating discipline is explicit: **no secret value is ever written to the output.** The
 * CONFIGURATION section prints `set` or `absent` and never a value; the database password is passed
 * to `psql` through the child process environment rather than `argv`, so it does not appear in the
 * host's process list; and the verify token is sent to the deployment but never printed.
 *
 * =============================================================================
 * THE FIVE THINGS THIS SCRIPT CANNOT DO — the full list is in the report's LIMITS section
 * =============================================================================
 *
 * Read `LIMITS` in the printed report. The short version: RLS needs real SQL against `pg_class`
 * and therefore `psql`; a private bucket flag is not a correct policy; a non-placeholder `source`
 * is not a *true* citation; the webhook check proves the deployed token matches the one this script
 * was handed, not that Meta holds the same string; and every answer is a point-in-time snapshot.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

/* ========================================================================== */
/* The facts the assertions are written against                                */
/* ========================================================================== */

/**
 * Requirement 4.1 is **"exactly the five Verified_Conditions"**, and the two halves of that live in
 * different migrations: `0004_disease_knowledge.sql` carries the check constraint and unique index
 * that make five the *maximum*, `0010_seed_disease_knowledge.sql` supplies the *minimum*. So the
 * assertion is `count === 5`, never `count >= 5` — a sixth row means 0004's constraint is not on
 * this deployment, which is exactly the kind of "migration reported success" failure this script
 * exists to catch.
 */
export const KNOWLEDGE_ROW_COUNT = 5;

/** The Verified_Conditions, verbatim from the requirements glossary and from migration 0010. */
export const VERIFIED_CONDITIONS = [
  'Potato Early Blight',
  'Potato Late Blight',
  'Tomato Early Blight',
  'Tomato Healthy',
  'Tomato Late Blight',
] as const;

export const KNOWLEDGE_TABLE = 'disease_knowledge';

/**
 * Requirement 13.5. The names are duplicated from `STORAGE_BUCKETS` in `src/lib/config/verified.ts`
 * because this file cannot import through the `@/*` alias (see the header). The duplication is not
 * left to trust: `tests/unit/check-deployment.test.ts` imports both and asserts they are equal, so
 * a rename in `verified.ts` fails that test rather than silently checking the wrong buckets.
 */
export const REQUIRED_BUCKETS = ['crop-images', 'voice-messages'] as const;

/**
 * Requirement 13.1's tables — the seven farmer-scoped ones.
 *
 * Requirement 13.1's own sentence names five; `counters` (migration 0007) and `whatsapp_inbound`
 * (0008) arrived with later requirements and carry farmer rows just the same, which is why the task
 * text lists seven. The same seven are the keys of `FARMER_SCOPED_TABLES` in
 * `check-secret-scope.ts`, and the unit test asserts the two lists agree: one definition of "holds
 * one farmer's rows" across both guards.
 *
 * `disease_knowledge` is deliberately absent. It holds no farmer data, and 13.3 *grants* every
 * authenticated farmer read access to it.
 */
export const RLS_TABLES = [
  'conversations',
  'counters',
  'diagnoses',
  'messages',
  'profiles',
  'usage_logs',
  'whatsapp_inbound',
] as const;

/**
 * V13's three query parameters and the subscribe mode, mirroring `META_CHALLENGE_PARAMS` and
 * `META_CHALLENGE_SUBSCRIBE_MODE` in `src/lib/config/verified.ts` — again with an equality test
 * rather than trust. `respondToChallenge` in `src/lib/whatsapp.ts` is the code on the other end:
 * mode must be `subscribe`, the token is compared in constant time, and a match echoes
 * `hub.challenge` with 200 while anything else is a bodiless 403.
 */
export const CHALLENGE_PARAMS = {
  mode: 'hub.mode',
  challenge: 'hub.challenge',
  verifyToken: 'hub.verify_token',
} as const;

export const CHALLENGE_SUBSCRIBE_MODE = 'subscribe';

/** The webhook route's path. `src/app/api/whatsapp/route.ts` is the handler. */
export const WEBHOOK_PATH = '/api/whatsapp';

/**
 * `docs/DEPLOYMENT.md` step 3's RLS query, built from `RLS_TABLES` so the list cannot drift from
 * the one this script asserts on. `relrowsecurity` on `pg_class` is the flag `alter table … enable
 * row level security` sets; there is no other honest source for it.
 */
export const RLS_SQL = [
  'select relname, relrowsecurity from pg_class',
  " where relnamespace = 'public'::regnamespace",
  `   and relname in (${RLS_TABLES.map((table) => `'${table}'`).join(',')})`,
  ' order by relname;',
].join('\n');

/**
 * The by-hand substitutes `docs/DEPLOYMENT.md` step 3 already documents, reprinted in the report
 * whenever an assertion could not be verified. An operator who cannot run this script still has to
 * be able to complete the step, and a check that says only "unverified" would leave them stuck.
 */
export const SUBSTITUTE_SQL = [
  'select count(*) from public.disease_knowledge;                        -- expect 5',
  "select count(*) from public.disease_knowledge where coalesce(source,'') = '';  -- expect 0",
  'select id, public from storage.buckets order by id;                   -- expect crop-images/false, voice-messages/false',
  RLS_SQL.replace(' order by relname;', ' order by relname;   -- expect relrowsecurity = true for all seven'),
].join('\n');

/**
 * Placeholder shapes that must never survive into a live `source`.
 *
 * The design carried `<extension-service citation - fill at implementation>` in its seed sketch on
 * purpose, and instructed that the design "does not invent a citation". Migration 0010 replaced all
 * five with real, dated extension-service citations — but this script reads the **database**, not
 * the migration, so a project seeded from an older copy of that file, or a row edited by hand, can
 * still carry the placeholder. `source` would be non-empty and Requirement 4.2 would still be
 * broken, which is why this is its own assertion rather than a footnote on the non-empty one.
 */
export const PLACEHOLDER_SOURCE_PATTERNS: readonly RegExp[] = [
  /<[^>]*>/,
  /fill at implementation/i,
  /\bplaceholder\b/i,
  /\btodo\b/i,
  /\btbd\b/i,
  /\bxxx+\b/i,
];

/* ========================================================================== */
/* Observations — what a probe reports, and what the assertions read            */
/* ========================================================================== */

/** One row of `disease_knowledge`, reduced to the two columns Requirements 4.1 and 4.2 are about. */
export interface KnowledgeRow {
  readonly diseaseName: string;
  readonly source: string;
}

/** One `storage.buckets` row. `isPublic` is V4's `public` boolean; private means `false`. */
export interface BucketRecord {
  readonly id: string;
  readonly isPublic: boolean;
}

/** One `pg_class` row: the table name and its `relrowsecurity` flag. */
export interface RlsRecord {
  readonly table: string;
  readonly rowSecurityEnabled: boolean;
}

/**
 * What the publishable-key probe saw per table: a row count, or the error the database returned.
 *
 * `count` is fetched `head: true`, so **no row data crosses the wire** — this script must not pull
 * farmer records onto an operator's laptop to prove they are protected.
 */
export interface AnonVisibilityRecord {
  readonly table: string;
  readonly visibleRows: number | null;
  readonly error?: string;
}

export interface HttpObservation {
  readonly status: number;
  readonly body: string;
  readonly contentType: string | null;
}

/** Both halves of the handshake, plus the nonce the correct-token response must echo. */
export interface ChallengeObservation {
  readonly url: string;
  readonly challenge: string;
  readonly withConfiguredToken: HttpObservation;
  readonly withWrongToken: HttpObservation;
}

/**
 * A probe result. `ok: false` carries the reason as prose an operator can act on — a missing
 * variable, a refused connection, a `psql` that is not installed — and becomes an `unverified`
 * assertion rather than an exception.
 */
export type Probed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export interface DeploymentProbe {
  /** Human-readable description of where the observations come from, printed in the report. */
  readonly describe: string;
  knowledge(): Promise<Probed<readonly KnowledgeRow[]>>;
  buckets(): Promise<Probed<readonly BucketRecord[]>>;
  rls(): Promise<Probed<readonly RlsRecord[]>>;
  anonVisibility(): Promise<Probed<readonly AnonVisibilityRecord[]>>;
  webhook(): Promise<Probed<ChallengeObservation>>;
}

/* ========================================================================== */
/* Assertions                                                                  */
/* ========================================================================== */

/**
 * `unverified` is deliberately distinct from `fail`: it says the deployment might be correct and
 * this run could not tell. Both exit 1 — the difference is what the operator has to do next.
 */
export type AssertionStatus = 'pass' | 'fail' | 'unverified';

export interface Assertion {
  readonly id: string;
  readonly requirement: string;
  readonly title: string;
  readonly status: AssertionStatus;
  readonly detail: string;
  /** Observed facts, printed under the assertion so a pass is auditable and not just a word. */
  readonly evidence: readonly string[];
}

const unverified = (
  id: string,
  requirement: string,
  title: string,
  reason: string,
): Assertion => ({ id, requirement, title, status: 'unverified', detail: reason, evidence: [] });

/** Trimmed-empty counts as empty: `not null` in 0004 is not the same as populated (4.2). */
const isBlank = (value: string): boolean => value.trim() === '';

export function placeholderPatternIn(source: string): RegExp | undefined {
  return PLACEHOLDER_SOURCE_PATTERNS.find((pattern) => pattern.test(source));
}

/**
 * Requirements 4.1 and 4.2 over the rows of `disease_knowledge`: three assertions, reported
 * separately because they fail for different reasons and are fixed by different edits.
 */
export function assertKnowledgeBase(probed: Probed<readonly KnowledgeRow[]>): Assertion[] {
  if (!probed.ok) {
    return [
      unverified('knowledge-count', '4.1', `exactly ${KNOWLEDGE_ROW_COUNT} rows in ${KNOWLEDGE_TABLE}`, probed.reason),
      unverified('knowledge-conditions', '4.1', 'the rows are the five Verified_Conditions', probed.reason),
      unverified('knowledge-source', '4.2', 'every row carries a non-empty source', probed.reason),
      unverified('knowledge-source-real', '4.2', 'no source is still a design placeholder', probed.reason),
    ];
  }

  const rows = probed.value;
  const names = [...rows.map((row) => row.diseaseName)].sort((a, b) => a.localeCompare(b));
  const expected: readonly string[] = [...VERIFIED_CONDITIONS];
  const blank = rows.filter((row) => isBlank(row.source));
  const placeheld = rows
    .map((row) => ({ row, pattern: placeholderPatternIn(row.source) }))
    .filter((entry): entry is { row: KnowledgeRow; pattern: RegExp } => entry.pattern !== undefined);

  const countPasses = rows.length === KNOWLEDGE_ROW_COUNT;
  const namesPass = names.length === expected.length && names.every((name, i) => name === expected[i]);

  return [
    {
      id: 'knowledge-count',
      requirement: '4.1',
      title: `exactly ${KNOWLEDGE_ROW_COUNT} rows in ${KNOWLEDGE_TABLE}`,
      status: countPasses ? 'pass' : 'fail',
      detail: countPasses
        ? `count(*) = ${KNOWLEDGE_ROW_COUNT}`
        : `count(*) = ${rows.length}, expected exactly ${KNOWLEDGE_ROW_COUNT}. ` +
          (rows.length < KNOWLEDGE_ROW_COUNT
            ? '0010_seed_disease_knowledge.sql did not apply, or a row was deleted.'
            : "0004_disease_knowledge.sql's row-count constraint is not on this deployment — five is supposed to be the maximum."),
      evidence: [`rows: ${rows.length}`],
    },
    {
      id: 'knowledge-conditions',
      requirement: '4.1',
      title: 'the rows are the five Verified_Conditions',
      status: namesPass ? 'pass' : 'fail',
      detail: namesPass
        ? 'every Verified_Condition is present and nothing else is'
        : `disease_name set differs from the Verified_Conditions. missing: [${expected
            .filter((name) => !names.includes(name))
            .join(', ')}]  unexpected: [${names.filter((name) => !expected.includes(name)).join(', ')}]`,
      evidence: names.map((name) => `disease_name: ${name}`),
    },
    {
      id: 'knowledge-source',
      requirement: '4.2',
      title: 'every row carries a non-empty source',
      status: blank.length === 0 ? 'pass' : 'fail',
      detail:
        blank.length === 0
          ? 'no row has a blank source'
          : `${blank.length} row(s) have a blank source: ${blank.map((row) => row.diseaseName).join(', ')}. ` +
            'Requirement 4.2 is the provenance of advice a farmer may act on in a field — a blank source is a release blocker.',
      evidence: rows.map((row) => `${row.diseaseName}: source ${isBlank(row.source) ? 'BLANK' : `${row.source.trim().length} chars`}`),
    },
    {
      id: 'knowledge-source-real',
      requirement: '4.2',
      title: 'no source is still a design placeholder',
      status: placeheld.length === 0 ? 'pass' : 'fail',
      detail:
        placeheld.length === 0
          ? 'no source matches a placeholder shape; each reads as a citation'
          : `${placeheld.length} row(s) carry placeholder text rather than a citation: ` +
            `${placeheld.map((entry) => `${entry.row.diseaseName} (matched ${String(entry.pattern)})`).join(', ')}. ` +
            'Re-apply 0010_seed_disease_knowledge.sql from this repository — its five citations are real, dated ' +
            'extension-service publications; the design left `<extension-service citation - fill at implementation>` ' +
            'and a project seeded from that sketch is a Requirement 4.2 blocker.',
      evidence: placeheld.map((entry) => `${entry.row.diseaseName}: PLACEHOLDER`),
    },
  ];
}

/** Requirement 13.5: both buckets exist, and `public` is `false` on both (V4). */
export function assertBuckets(probed: Probed<readonly BucketRecord[]>): Assertion[] {
  if (!probed.ok) {
    return [
      unverified('buckets-exist', '13.5', `${REQUIRED_BUCKETS.join(' and ')} exist`, probed.reason),
      unverified('buckets-private', '13.5', 'both buckets are private', probed.reason),
    ];
  }

  const buckets = probed.value;
  const byId = new Map(buckets.map((bucket) => [bucket.id, bucket]));
  const missing = REQUIRED_BUCKETS.filter((id) => !byId.has(id));
  const publicOnes = REQUIRED_BUCKETS.map((id) => byId.get(id)).filter(
    (bucket): bucket is BucketRecord => bucket !== undefined && bucket.isPublic,
  );

  return [
    {
      id: 'buckets-exist',
      requirement: '13.5',
      title: `${REQUIRED_BUCKETS.join(' and ')} exist`,
      status: missing.length === 0 ? 'pass' : 'fail',
      detail:
        missing.length === 0
          ? 'both buckets are present'
          : `missing bucket(s): ${missing.join(', ')}. 0009_storage_buckets_policies.sql did not apply.`,
      evidence: buckets.map((bucket) => `${bucket.id}: public = ${String(bucket.isPublic)}`),
    },
    {
      id: 'buckets-private',
      requirement: '13.5',
      title: 'both buckets are private',
      status: missing.length > 0 ? 'unverified' : publicOnes.length === 0 ? 'pass' : 'fail',
      detail:
        missing.length > 0
          ? `cannot judge privacy of a bucket that does not exist: ${missing.join(', ')}`
          : publicOnes.length === 0
            ? 'public = false on both, so every read goes through a signed URL'
            : `public = true on: ${publicOnes.map((bucket) => bucket.id).join(', ')}. This is a RELEASE BLOCKER — ` +
              "a public bucket publishes every farmer's crop photos to anyone with the object path.",
      evidence: REQUIRED_BUCKETS.map((id) => {
        const bucket = byId.get(id);
        return `${id}: ${bucket === undefined ? 'ABSENT' : `public = ${String(bucket.isPublic)}`}`;
      }),
    },
  ];
}

/**
 * Requirement 13.1 from `pg_class.relrowsecurity`, plus the publishable-key cross-check.
 *
 * The cross-check is **one-directional and says so**: rows visible to the anonymous key prove RLS
 * is off or a policy is wrong, but zero visible rows prove nothing — on a fresh deployment every
 * one of these tables is empty, and an empty table looks identical through RLS and around it. That
 * asymmetry is why it can never stand in for the `pg_class` read, and why it is reported as its own
 * assertion instead of being folded into it.
 */
export function assertRls(
  probed: Probed<readonly RlsRecord[]>,
  anon: Probed<readonly AnonVisibilityRecord[]>,
): Assertion[] {
  const flagAssertion: Assertion = !probed.ok
    ? unverified('rls-enabled', '13.1', `RLS enabled on all ${RLS_TABLES.length} farmer-scoped tables`, probed.reason)
    : (() => {
        const byTable = new Map(probed.value.map((record) => [record.table, record]));
        const absent = RLS_TABLES.filter((table) => !byTable.has(table));
        const disabled = RLS_TABLES.filter((table) => byTable.get(table)?.rowSecurityEnabled === false);

        return {
          id: 'rls-enabled',
          requirement: '13.1',
          title: `RLS enabled on all ${RLS_TABLES.length} farmer-scoped tables`,
          status: absent.length === 0 && disabled.length === 0 ? 'pass' : 'fail',
          detail:
            absent.length === 0 && disabled.length === 0
              ? 'relrowsecurity = true on every table'
              : [
                  absent.length > 0 ? `table(s) not found in the public schema: ${absent.join(', ')}` : '',
                  disabled.length > 0 ? `relrowsecurity = false on: ${disabled.join(', ')}` : '',
                  'This is a RELEASE BLOCKER — a farmer-scoped table without RLS is readable with the ' +
                    'publishable key that ships to every browser.',
                ]
                  .filter((line) => line !== '')
                  .join(' '),
          evidence: RLS_TABLES.map((table) => {
            const record = byTable.get(table);
            return `${table}: ${record === undefined ? 'NOT FOUND' : `relrowsecurity = ${String(record.rowSecurityEnabled)}`}`;
          }),
        } satisfies Assertion;
      })();

  const anonAssertion: Assertion = !anon.ok
    ? unverified('rls-anon-visibility', '13.1', 'no farmer row is visible to the publishable key', anon.reason)
    : (() => {
        const leaking = anon.value.filter((record) => (record.visibleRows ?? 0) > 0);
        return {
          id: 'rls-anon-visibility',
          requirement: '13.1',
          title: 'no farmer row is visible to the publishable key',
          status: leaking.length === 0 ? 'pass' : 'fail',
          detail:
            leaking.length === 0
              ? 'the anonymous role sees zero rows in every table. NOTE: this cannot prove RLS is ON — ' +
                'an empty table looks the same either way. rls-enabled above is the assertion that proves it.'
              : `the anonymous role can read rows of: ${leaking
                  .map((record) => `${record.table} (${String(record.visibleRows)})`)
                  .join(', ')}. RLS is off or a policy is wrong. RELEASE BLOCKER.`,
          evidence: anon.value.map(
            (record) =>
              `${record.table}: ${record.visibleRows === null ? `refused (${record.error ?? 'no detail'})` : `${String(record.visibleRows)} row(s) visible`}`,
          ),
        } satisfies Assertion;
      })();

  return [flagAssertion, anonAssertion];
}

/**
 * The step 7 half: the webhook GET echoes the challenge with 200 for the configured token
 * (Requirement 11.1) and answers 403 with an empty body for a wrong one (Requirement 11.2).
 *
 * Split into two assertions because the two failures mean opposite things. A failed 200 is usually
 * a token mismatch between this script's environment and the deployment's (a trailing newline from
 * a copy-paste is the classic cause). A failed 403 is far worse: an endpoint that accepts *any*
 * token lets anyone complete Meta's handshake and re-point the subscription.
 */
export function assertWebhookChallenge(probed: Probed<ChallengeObservation>): Assertion[] {
  if (!probed.ok) {
    return [
      unverified('webhook-verify-accepts', '11.1', 'the webhook GET echoes the challenge with 200', probed.reason),
      unverified('webhook-verify-rejects', '11.2', 'a wrong verify token gets 403 with an empty body', probed.reason),
    ];
  }

  const { withConfiguredToken: good, withWrongToken: bad, challenge, url } = probed.value;
  const echoed = good.body === challenge;
  const acceptsPasses = good.status === 200 && echoed;
  const rejectsPasses = bad.status === 403 && bad.body === '';
  const schemeNote = url.startsWith('https://')
    ? []
    : [`scheme is not https — V13 requires HTTPS with a non-self-signed certificate, so Meta cannot verify ${url}`];

  return [
    {
      id: 'webhook-verify-accepts',
      requirement: '11.1',
      title: 'the webhook GET echoes the challenge with 200',
      status: acceptsPasses ? 'pass' : 'fail',
      detail: acceptsPasses
        ? 'status 200 with the challenge echoed verbatim'
        : `status ${String(good.status)}${echoed ? '' : ', body did not echo hub.challenge'}. ` +
          "The token this script sent does not match the deployment's WHATSAPP_VERIFY_TOKEN, or the route is not deployed. " +
          'Check for a trailing newline picked up from a copy-paste — it is the usual cause.',
      evidence: [
        `GET ${url}`,
        `status: ${String(good.status)}`,
        `challenge echoed: ${String(echoed)}`,
        `content-type: ${good.contentType ?? 'absent'}`,
        ...schemeNote,
      ],
    },
    {
      id: 'webhook-verify-rejects',
      requirement: '11.2',
      title: 'a wrong verify token gets 403 with an empty body',
      status: rejectsPasses ? 'pass' : 'fail',
      detail: rejectsPasses
        ? 'status 403 with no body, so nothing leaks which part of the handshake failed'
        : `status ${String(bad.status)} with a ${bad.body === '' ? 'empty' : `${String(bad.body.length)}-character`} body. ` +
          (bad.status === 200
            ? 'The endpoint accepted a token it has never seen — anyone could complete the handshake and re-point the subscription. RELEASE BLOCKER.'
            : 'Expected exactly 403 and an empty body (Requirement 11.2).'),
      evidence: [`status: ${String(bad.status)}`, `body length: ${String(bad.body.length)}`],
    },
  ];
}

/* ========================================================================== */
/* Configuration                                                               */
/* ========================================================================== */

/**
 * Every variable this script reads, what it unblocks, and whether it is required.
 *
 * Printed as a table with `set`/`absent` — never a value. The first three are already in
 * `.env.example`; the last three are operator inputs to this command and are documented here
 * rather than added to the application's schema (see the header).
 */
export const CONFIG_VARS = [
  {
    name: 'NEXT_PUBLIC_SUPABASE_URL',
    unblocks: 'knowledge base, buckets, publishable-key cross-check',
  },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', unblocks: 'knowledge base, buckets' },
  {
    name: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)',
    unblocks: 'publishable-key cross-check',
  },
  { name: 'WHATSAPP_VERIFY_TOKEN', unblocks: 'webhook GET (step 7)' },
  {
    name: 'JAMEE_DEPLOYMENT_URL',
    unblocks: 'webhook GET (step 7) — the deployed origin, e.g. https://jamee.vercel.app',
  },
  {
    name: 'JAMEE_DEPLOYMENT_DATABASE_URL',
    unblocks: 'RLS flags — a Postgres connection string; needs psql on PATH',
  },
] as const;

export interface DeploymentEnvironment {
  readonly supabaseUrl?: string;
  readonly serviceRoleKey?: string;
  readonly publishableKey?: string;
  readonly verifyToken?: string;
  readonly deploymentUrl?: string;
  readonly databaseUrl?: string;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

const trimmed = (value: string | undefined): string | undefined => {
  const clean = value?.trim();
  return clean !== undefined && clean !== '' ? clean : undefined;
};

/**
 * Read the environment into one record, treating an empty string as unset — a platform UI that
 * saves a cleared field as `''` should behave the same as never setting it, which is the rule
 * `src/lib/env.ts` applies to the application's own variables.
 *
 * Both spellings of the public key are accepted, publishable first, exactly as
 * `src/lib/env.public.ts` does: V1 records the rename, and a correctly configured project should
 * not fail here for a naming reason.
 */
export function readEnvironment(source: EnvSource = process.env): DeploymentEnvironment {
  const entries: [keyof DeploymentEnvironment, string | undefined][] = [
    ['supabaseUrl', trimmed(source.NEXT_PUBLIC_SUPABASE_URL)],
    ['serviceRoleKey', trimmed(source.SUPABASE_SERVICE_ROLE_KEY)],
    [
      'publishableKey',
      trimmed(source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) ?? trimmed(source.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    ],
    ['verifyToken', trimmed(source.WHATSAPP_VERIFY_TOKEN)],
    ['deploymentUrl', trimmed(source.JAMEE_DEPLOYMENT_URL)],
    ['databaseUrl', trimmed(source.JAMEE_DEPLOYMENT_DATABASE_URL)],
  ];

  // Built by omission rather than by assigning `undefined`, which `exactOptionalPropertyTypes`
  // treats as a different thing from an absent key.
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined)) as DeploymentEnvironment;
}

/** True when nothing at all is configured — the case that must print instructions, not a stack. */
export function isUnconfigured(env: DeploymentEnvironment): boolean {
  return Object.keys(env).length === 0;
}

/* ========================================================================== */
/* The live probe                                                              */
/* ========================================================================== */

/** `psql` argv. The connection string is NOT here — see `psqlEnvFromUrl`. */
export function psqlArgs(sql: string): string[] {
  return ['-X', '-q', '-A', '-t', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql];
}

/**
 * Translate a connection string into libpq environment variables.
 *
 * The point is the password. `psql 'postgresql://user:pw@host/db'` puts the credential in the
 * host's process list, where any other user can read it; the libpq variables keep it inside the
 * child's environment. `sslmode` defaults to `require` because a Supabase connection is over TLS
 * and a silent plaintext fallback would be worse than a connection error.
 */
export function psqlEnvFromUrl(databaseUrl: string): Probed<Record<string, string>> {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { ok: false, reason: 'JAMEE_DEPLOYMENT_DATABASE_URL is not a URL. Expected postgresql://user:password@host:5432/postgres' };
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return {
      ok: false,
      reason: `JAMEE_DEPLOYMENT_DATABASE_URL has scheme '${parsed.protocol}'; expected postgres: or postgresql:`,
    };
  }

  const database = parsed.pathname.replace(/^\//, '');
  const env: Record<string, string> = {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port === '' ? '5432' : parsed.port,
    PGDATABASE: database === '' ? 'postgres' : database,
    PGSSLMODE: parsed.searchParams.get('sslmode') ?? 'require',
    PGCONNECT_TIMEOUT: '15',
  };
  if (parsed.username !== '') env.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password !== '') env.PGPASSWORD = decodeURIComponent(parsed.password);

  return { ok: true, value: env };
}

/** A SQL runner: injected so `rls()` is testable without a database or a `psql` binary. */
export type SqlRunner = (sql: string) => Probed<string>;

export function psqlRunner(databaseUrl: string): SqlRunner {
  return (sql) => {
    const pgEnv = psqlEnvFromUrl(databaseUrl);
    if (!pgEnv.ok) return pgEnv;

    try {
      const stdout = execFileSync('psql', psqlArgs(sql), {
        encoding: 'utf8',
        env: { ...process.env, ...pgEnv.value },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      return { ok: true, value: stdout };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason:
          `psql failed: ${detail.split('\n')[0] ?? detail}. ` +
          'RLS lives in pg_class, which PostgREST does not expose, so this assertion needs psql on PATH ' +
          'and a connection string in JAMEE_DEPLOYMENT_DATABASE_URL. Run the SQL below by hand instead.',
      };
    }
  };
}

/** Parse `-A -t -F '|'` output: one `relname|t` or `relname|f` per line. */
export function parseRlsOutput(stdout: string): Probed<readonly RlsRecord[]> {
  const records: RlsRecord[] = [];

  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    const [table, flag] = text.split('|');
    if (table === undefined || flag === undefined) {
      return { ok: false, reason: `could not read a relname|relrowsecurity pair from psql output line: ${text}` };
    }
    if (flag !== 't' && flag !== 'f') {
      return { ok: false, reason: `expected 't' or 'f' for relrowsecurity, got '${flag}' for ${table}` };
    }
    records.push({ table, rowSecurityEnabled: flag === 't' });
  }

  return { ok: true, value: records };
}

/**
 * Read the `disease_knowledge` rows through PostgREST with the service-role key.
 *
 * The response is validated rather than trusted: it is data from outside this process, and a
 * `select` that silently returned a different shape should say so instead of throwing a
 * `TypeError` three functions later.
 */
export function parseKnowledgeRows(value: unknown): Probed<readonly KnowledgeRow[]> {
  if (!Array.isArray(value)) return { ok: false, reason: `expected an array of rows, got ${typeof value}` };

  const rows: KnowledgeRow[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, reason: 'a row in the disease_knowledge response was not an object' };
    }
    const record = entry as Record<string, unknown>;
    const diseaseName = record.disease_name;
    const source = record.source;
    if (typeof diseaseName !== 'string') {
      return { ok: false, reason: 'a disease_knowledge row has no string disease_name' };
    }
    rows.push({ diseaseName, source: typeof source === 'string' ? source : '' });
  }

  return { ok: true, value: rows };
}

const missing = (...names: string[]): { ok: false; reason: string } => ({
  ok: false,
  reason: `not configured: ${names.join(', ')} — see the CONFIGURATION section above`,
});

/**
 * Turn any throw inside a probe into an `unverified` assertion.
 *
 * Not defensive padding: `createClient` validates the URL and **throws** on a malformed one, and a
 * mistyped `NEXT_PUBLIC_SUPABASE_URL` is a first-deployment mistake, not an exotic one. Without this
 * the script would answer a typo with a stack trace out of the SDK — the crash this guard is
 * specifically not allowed to produce.
 */
const guarded = async <T,>(what: string, run: () => Promise<Probed<T>>): Promise<Probed<T>> => {
  try {
    return await run();
  } catch (error) {
    return { ok: false, reason: `${what} threw: ${error instanceof Error ? error.message : String(error)}` };
  }
};

/**
 * The one place that talks to the network.
 *
 * Every method resolves its own inputs and reports the ones it lacks by name, so a partially
 * configured environment produces a partial report rather than a crash, and the two step-3
 * assertions still run for an operator who has not reached step 7 yet.
 */
export function liveProbe(
  env: DeploymentEnvironment,
  deps: { readonly fetchImpl?: typeof fetch; readonly runSql?: SqlRunner } = {},
): DeploymentProbe {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const serviceClient = (): ReturnType<typeof createClient> | undefined =>
    env.supabaseUrl !== undefined && env.serviceRoleKey !== undefined
      ? createClient(env.supabaseUrl, env.serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : undefined;

  return {
    describe:
      'PostgREST + Storage API with the service-role key, psql for pg_class, and one HTTPS GET to the webhook',

    knowledge: () =>
      guarded<readonly KnowledgeRow[]>(`select on ${KNOWLEDGE_TABLE}`, async () => {
        const client = serviceClient();
        if (client === undefined) return missing('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');

        const { data, error } = await client.from(KNOWLEDGE_TABLE).select('disease_name, source');
        if (error !== null) return { ok: false, reason: `select on ${KNOWLEDGE_TABLE} failed: ${error.message}` };
        return parseKnowledgeRows(data);
      }),

    buckets: () =>
      guarded<readonly BucketRecord[]>('storage.listBuckets()', async () => {
        const client = serviceClient();
        if (client === undefined) return missing('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');

        const { data, error } = await client.storage.listBuckets();
        if (error !== null || data === null) {
          return { ok: false, reason: `storage.listBuckets() failed: ${error?.message ?? 'no data returned'}` };
        }
        return { ok: true, value: data.map((bucket) => ({ id: bucket.id, isPublic: bucket.public })) };
      }),

    rls: () =>
      guarded<readonly RlsRecord[]>('the RLS query', async () => {
        const runner = deps.runSql ?? (env.databaseUrl !== undefined ? psqlRunner(env.databaseUrl) : undefined);
        if (runner === undefined) return missing('JAMEE_DEPLOYMENT_DATABASE_URL');

        const stdout = runner(RLS_SQL);
        if (!stdout.ok) return stdout;
        return parseRlsOutput(stdout.value);
      }),

    anonVisibility: () =>
      guarded<readonly AnonVisibilityRecord[]>('the publishable-key cross-check', async () => {
        if (env.supabaseUrl === undefined || env.publishableKey === undefined) {
          return missing('NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
        }

        const anon = createClient(env.supabaseUrl, env.publishableKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const records: AnonVisibilityRecord[] = [];

        for (const table of RLS_TABLES) {
          // `head: true` — a count and no rows. Nothing about a farmer crosses the wire.
          const { count, error } = await anon.from(table).select('*', { count: 'exact', head: true });
          records.push(
            error === null
              ? { table, visibleRows: count ?? 0 }
              : { table, visibleRows: null, error: error.message },
          );
        }

        return { ok: true, value: records };
      }),

    webhook: () =>
      guarded<ChallengeObservation>('the webhook GET', async () => {
        if (env.deploymentUrl === undefined || env.verifyToken === undefined) {
          return missing('JAMEE_DEPLOYMENT_URL', 'WHATSAPP_VERIFY_TOKEN');
        }

        const challenge = randomUUID();
        // A synthetic token that cannot collide with the real one. It is never printed either.
        const wrongToken = `not-the-verify-token-${randomUUID()}`;
        const base = /^https?:\/\//.test(env.deploymentUrl) ? env.deploymentUrl : `https://${env.deploymentUrl}`;

        const challengeUrl = (token: string): string => {
          const url = new URL(WEBHOOK_PATH, base);
          url.searchParams.set(CHALLENGE_PARAMS.mode, CHALLENGE_SUBSCRIBE_MODE);
          url.searchParams.set(CHALLENGE_PARAMS.verifyToken, token);
          url.searchParams.set(CHALLENGE_PARAMS.challenge, challenge);
          return url.toString();
        };

        const get = async (token: string): Promise<HttpObservation> => {
          const response = await fetchImpl(challengeUrl(token), {
            method: 'GET',
            // A 3xx is a finding, not a hop: Meta does not follow redirects on the handshake.
            redirect: 'manual',
            signal: AbortSignal.timeout(15_000),
          });
          return {
            status: response.status,
            body: await response.text(),
            contentType: response.headers.get('content-type'),
          };
        };

        try {
          return {
            ok: true,
            value: {
              // The printed URL carries the path only — never a token and never the nonce.
              url: new URL(WEBHOOK_PATH, base).toString(),
              challenge,
              withConfiguredToken: await get(env.verifyToken),
              withWrongToken: await get(wrongToken),
            },
          };
        } catch (error) {
          return {
            ok: false,
            reason: `GET ${new URL(WEBHOOK_PATH, base).toString()} failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  };
}

/* ========================================================================== */
/* The run                                                                     */
/* ========================================================================== */

export interface Report {
  readonly probeDescription: string;
  readonly configuration: readonly { readonly name: string; readonly present: boolean; readonly unblocks: string }[];
  readonly assertions: readonly Assertion[];
}

export function configurationRows(env: DeploymentEnvironment): Report['configuration'] {
  const present: Record<string, boolean> = {
    'NEXT_PUBLIC_SUPABASE_URL': env.supabaseUrl !== undefined,
    'SUPABASE_SERVICE_ROLE_KEY': env.serviceRoleKey !== undefined,
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)': env.publishableKey !== undefined,
    'WHATSAPP_VERIFY_TOKEN': env.verifyToken !== undefined,
    'JAMEE_DEPLOYMENT_URL': env.deploymentUrl !== undefined,
    'JAMEE_DEPLOYMENT_DATABASE_URL': env.databaseUrl !== undefined,
  };

  return CONFIG_VARS.map((variable) => ({
    name: variable.name,
    present: present[variable.name] ?? false,
    unblocks: variable.unblocks,
  }));
}

export async function runChecks(probe: DeploymentProbe, env: DeploymentEnvironment = {}): Promise<Report> {
  const [knowledge, buckets, rls, anon, webhook] = await Promise.all([
    probe.knowledge(),
    probe.buckets(),
    probe.rls(),
    probe.anonVisibility(),
    probe.webhook(),
  ]);

  return {
    probeDescription: probe.describe,
    configuration: configurationRows(env),
    assertions: [
      ...assertKnowledgeBase(knowledge),
      ...assertBuckets(buckets),
      ...assertRls(rls, anon),
      ...assertWebhookChallenge(webhook),
    ],
  };
}

/** 1 on any failure **and** on any assertion that could not be verified. */
export function exitCode(report: Report): number {
  return report.assertions.some((assertion) => assertion.status !== 'pass') ? 1 : 0;
}

const STATUS_LABEL: Readonly<Record<AssertionStatus, string>> = {
  pass: 'PASS      ',
  fail: 'FAIL      ',
  unverified: 'UNVERIFIED',
};

export function formatReport(report: Report): string {
  const lines: string[] = [];
  const failed = report.assertions.filter((assertion) => assertion.status === 'fail');
  const notVerified = report.assertions.filter((assertion) => assertion.status === 'unverified');

  lines.push('check-deployment — Requirements 4.1, 4.2, 13.1, 13.5, 17.6');
  lines.push('docs/DEPLOYMENT.md step 3 (knowledge base, buckets, RLS) and step 7 (webhook GET)');
  lines.push(`source of observations: ${report.probeDescription}`);
  lines.push('');

  lines.push('CONFIGURATION — values are never printed, only whether each variable is set');
  lines.push('');
  for (const variable of report.configuration) {
    lines.push(`  ${variable.present ? 'set   ' : 'absent'}  ${variable.name}`);
    lines.push(`          unblocks: ${variable.unblocks}`);
  }
  lines.push('');

  lines.push(`ASSERTIONS (${report.assertions.length})`);
  lines.push('');
  for (const assertion of report.assertions) {
    lines.push(`  ${STATUS_LABEL[assertion.status]}  ${assertion.id} — ${assertion.title}  [Requirement ${assertion.requirement}]`);
    lines.push(`              ${assertion.detail}`);
    for (const line of assertion.evidence) lines.push(`              > ${line}`);
    lines.push('');
  }

  if (notVerified.length > 0) {
    lines.push('COULD NOT BE VERIFIED — run these in the Supabase SQL editor instead, per');
    lines.push('docs/DEPLOYMENT.md step 3, and record the results:');
    lines.push('');
    for (const line of SUBSTITUTE_SQL.split('\n')) lines.push(`  ${line}`);
    lines.push('');
  }

  lines.push('LIMITS OF THIS CHECK');
  lines.push('  - This is the one guard that needs a LIVE deployment. Nothing here is a source scan, so');
  lines.push('    a green repository says nothing about it and a green run here says nothing about the');
  lines.push('    next deployment.');
  lines.push('  - RLS is read from pg_class.relrowsecurity, which PostgREST does not expose. That');
  lines.push('    assertion therefore needs psql on PATH plus JAMEE_DEPLOYMENT_DATABASE_URL; without');
  lines.push('    them it reports UNVERIFIED and this run exits 1. It never reports PASS unverified.');
  lines.push('  - The publishable-key cross-check is ONE-DIRECTIONAL. Visible rows disprove RLS; zero');
  lines.push('    visible rows prove nothing, because every one of these tables is empty on a fresh');
  lines.push('    deployment. It can never substitute for the pg_class read.');
  lines.push('  - `public = false` is the bucket FLAG (V4). It is not the per-farmer path-prefix');
  lines.push("    policies 0009 writes on storage.objects: proving those needs two farmers' sessions and");
  lines.push('    an object each, which is step 8 acceptance ground, not a script.');
  lines.push('  - The knowledge assertions read the DATABASE, not migration 0010. A hand-edited row that');
  lines.push('    is well-formed passes, and the placeholder rule is a textual match against known');
  lines.push('    placeholder shapes — whether a citation is TRUE is human review of 0010, not a check.');
  lines.push('  - The webhook assertions prove the deployed instance agrees with the token THIS SCRIPT');
  lines.push('    was given. They do not prove Meta holds the same string, and they do not prove the');
  lines.push('    `messages` field subscription exists (docs/DEPLOYMENT.md step 7, item 5) — an endpoint');
  lines.push('    that verifies and then receives nothing is a separate failure.');
  lines.push('  - One deliberate 403 is left in the deployment log by the wrong-token probe.');
  lines.push('  - Read-only: nothing here inserts, updates, deletes, or uploads.');
  lines.push('');

  if (failed.length === 0 && notVerified.length === 0) {
    lines.push('PASS — every assertion verified');
  } else {
    const parts = [
      failed.length > 0 ? `${failed.length} failure(s)` : '',
      notVerified.length > 0 ? `${notVerified.length} unverified` : '',
    ].filter((part) => part !== '');
    lines.push(`FAIL — ${parts.join(', ')}`);
  }

  return lines.join('\n');
}

export async function main(source: EnvSource = process.env): Promise<number> {
  const env = readEnvironment(source);
  const report = await runChecks(liveProbe(env), env);
  process.stdout.write(`${formatReport(report)}\n`);

  if (isUnconfigured(env)) {
    process.stdout.write(
      '\nNothing was configured, so nothing could be checked. Set the variables listed under\n' +
        'CONFIGURATION above and run this again. `.env.local` is not loaded automatically — either\n' +
        'export the variables, or run:\n\n' +
        '  node --env-file-if-exists=.env.local --experimental-strip-types scripts/check-deployment.ts\n',
    );
  }

  return exitCode(report);
}

/**
 * Run only when this file *is* the process entry point, so importing it from a test neither probes
 * nor exits. The `file:` guard is for the test environment, where `import.meta.url` is an http URL.
 * Same shape as `check-secret-scope.ts`.
 */
function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || !import.meta.url.startsWith('file:')) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedAsScript()) {
  process.exit(await main());
}
