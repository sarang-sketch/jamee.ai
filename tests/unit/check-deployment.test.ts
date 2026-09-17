import { describe, expect, it } from 'vitest';

import {
  META_CHALLENGE_PARAMS,
  META_CHALLENGE_SUBSCRIBE_MODE,
  STORAGE_BUCKETS,
} from '@/lib/config/verified';

import {
  CHALLENGE_PARAMS,
  CHALLENGE_SUBSCRIBE_MODE,
  CONFIG_VARS,
  KNOWLEDGE_ROW_COUNT,
  REQUIRED_BUCKETS,
  RLS_SQL,
  RLS_TABLES,
  VERIFIED_CONDITIONS,
  assertBuckets,
  assertKnowledgeBase,
  assertRls,
  assertWebhookChallenge,
  configurationRows,
  exitCode,
  formatReport,
  isUnconfigured,
  liveProbe,
  parseKnowledgeRows,
  parseRlsOutput,
  placeholderPatternIn,
  psqlArgs,
  psqlEnvFromUrl,
  readEnvironment,
  runChecks,
  type AnonVisibilityRecord,
  type Assertion,
  type AssertionStatus,
  type BucketRecord,
  type ChallengeObservation,
  type DeploymentProbe,
  type KnowledgeRow,
  type Probed,
  type RlsRecord,
} from '../../scripts/check-deployment';
import { FARMER_SCOPED_TABLES } from '../../scripts/check-secret-scope';

/**
 * Tests for the deployment guard.
 *
 * Requirements: 4.1, 4.2, 13.1, 13.5, 17.6
 *
 * **Not one of these tests touches a live project, a database, or the network**, which is the whole
 * reason `check-deployment.ts` is built around an injected `DeploymentProbe`. Every assertion is a
 * pure function of an observation record, so both the passing shape and each failing shape can be
 * pinned against a fixture — the same seam discipline `retention.service.test.ts` and
 * `whatsapp-dispatch.test.ts` use. A guard asserted only against a healthy fixture would prove it
 * can say "PASS" and nothing else.
 *
 * The one place the real world appears is `liveProbe` with an unconfigured environment, where the
 * claim under test is precisely that it *refuses by name* instead of crashing on an undefined
 * variable.
 */

const knowledgeRow = (diseaseName: string, source = 'Some Extension Service, "Title", https://example.org (checked 2026-09-15)'): KnowledgeRow => ({
  diseaseName,
  source,
});

const healthyKnowledge: KnowledgeRow[] = VERIFIED_CONDITIONS.map((name) => knowledgeRow(name));

const healthyBuckets: BucketRecord[] = REQUIRED_BUCKETS.map((id) => ({ id, isPublic: false }));

const healthyRls: RlsRecord[] = RLS_TABLES.map((table) => ({ table, rowSecurityEnabled: true }));

const healthyAnon: AnonVisibilityRecord[] = RLS_TABLES.map((table) => ({ table, visibleRows: 0 }));

const healthyChallenge = (challenge = 'nonce-1'): ChallengeObservation => ({
  url: 'https://jamee.example.app/api/whatsapp',
  challenge,
  withConfiguredToken: { status: 200, body: challenge, contentType: 'text/plain; charset=utf-8' },
  withWrongToken: { status: 403, body: '', contentType: null },
});

const ok = <T,>(value: T): Probed<T> => ({ ok: true, value });
const failed = <T,>(reason: string): Probed<T> => ({ ok: false, reason });

const statusOf = (assertions: readonly Assertion[], id: string): AssertionStatus | undefined =>
  assertions.find((assertion) => assertion.id === id)?.status;

const detailOf = (assertions: readonly Assertion[], id: string): string =>
  assertions.find((assertion) => assertion.id === id)?.detail ?? '';

/* ========================================================================== */
/* Drift guards — the constants this script cannot import through the @/ alias  */
/* ========================================================================== */

describe('constants agree with the modules they are copied from', () => {
  it('REQUIRED_BUCKETS is STORAGE_BUCKETS from src/lib/config/verified.ts', () => {
    expect([...REQUIRED_BUCKETS].sort()).toEqual(Object.values(STORAGE_BUCKETS).sort());
  });

  it('CHALLENGE_PARAMS and the subscribe mode are V13s, from config/verified.ts', () => {
    expect(CHALLENGE_PARAMS).toEqual(META_CHALLENGE_PARAMS);
    expect(CHALLENGE_SUBSCRIBE_MODE).toBe(META_CHALLENGE_SUBSCRIBE_MODE);
  });

  it('RLS_TABLES is exactly check-secret-scope.ts FARMER_SCOPED_TABLES', () => {
    expect([...RLS_TABLES].sort()).toEqual(Object.keys(FARMER_SCOPED_TABLES).sort());
  });

  it('RLS_SQL names every table it asserts on, and reads relrowsecurity from pg_class', () => {
    expect(RLS_SQL).toContain('relrowsecurity from pg_class');
    expect(RLS_SQL).toContain("relnamespace = 'public'::regnamespace");
    for (const table of RLS_TABLES) expect(RLS_SQL).toContain(`'${table}'`);
    expect(RLS_SQL).not.toContain("'disease_knowledge'");
  });
});

/* ========================================================================== */
/* Requirement 4.1 / 4.2 — the knowledge base                                  */
/* ========================================================================== */

describe('assertKnowledgeBase', () => {
  it('passes on the five seeded Verified_Conditions with real citations', () => {
    const assertions = assertKnowledgeBase(ok(healthyKnowledge));
    expect(assertions.map((assertion) => assertion.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
  });

  it('fails on four rows — the seed migration did not apply', () => {
    const assertions = assertKnowledgeBase(ok(healthyKnowledge.slice(0, 4)));
    expect(statusOf(assertions, 'knowledge-count')).toBe('fail');
    expect(detailOf(assertions, 'knowledge-count')).toContain('0010_seed_disease_knowledge.sql');
    expect(statusOf(assertions, 'knowledge-conditions')).toBe('fail');
  });

  it('fails on six rows: Requirement 4.1 is equality, not a minimum', () => {
    const assertions = assertKnowledgeBase(ok([...healthyKnowledge, knowledgeRow('Tomato Mosaic Virus')]));
    expect(statusOf(assertions, 'knowledge-count')).toBe('fail');
    expect(detailOf(assertions, 'knowledge-count')).toContain('0004_disease_knowledge.sql');
    expect(detailOf(assertions, 'knowledge-conditions')).toContain('Tomato Mosaic Virus');
  });

  it('fails when a row name is not a Verified_Condition even though the count is five', () => {
    const swapped = [...healthyKnowledge.slice(0, 4), knowledgeRow('Wheat Rust')];
    const assertions = assertKnowledgeBase(ok(swapped));
    expect(statusOf(assertions, 'knowledge-count')).toBe('pass');
    expect(statusOf(assertions, 'knowledge-conditions')).toBe('fail');
    expect(detailOf(assertions, 'knowledge-conditions')).toContain('Tomato Late Blight');
  });

  it('fails on a blank or whitespace-only source — not null is not populated', () => {
    const rows = [...healthyKnowledge.slice(0, 4), knowledgeRow('Tomato Late Blight', '   ')];
    const assertions = assertKnowledgeBase(ok(rows));
    expect(statusOf(assertions, 'knowledge-source')).toBe('fail');
    expect(detailOf(assertions, 'knowledge-source')).toContain('Tomato Late Blight');
  });

  it("fails when a source is still the design's placeholder", () => {
    const rows = [
      ...healthyKnowledge.slice(0, 4),
      knowledgeRow('Tomato Late Blight', '<extension-service citation - fill at implementation>'),
    ];
    const assertions = assertKnowledgeBase(ok(rows));
    expect(statusOf(assertions, 'knowledge-source')).toBe('pass');
    expect(statusOf(assertions, 'knowledge-source-real')).toBe('fail');
    expect(detailOf(assertions, 'knowledge-source-real')).toContain('0010_seed_disease_knowledge.sql');
  });

  it('reports every knowledge assertion as unverified when the probe could not read the table', () => {
    const assertions = assertKnowledgeBase(failed<readonly KnowledgeRow[]>('not configured: SUPABASE_SERVICE_ROLE_KEY'));
    expect(assertions).toHaveLength(4);
    for (const assertion of assertions) {
      expect(assertion.status).toBe('unverified');
      expect(assertion.detail).toContain('SUPABASE_SERVICE_ROLE_KEY');
    }
  });
});

describe('placeholderPatternIn', () => {
  it('matches the placeholder shapes and leaves a real citation alone', () => {
    expect(placeholderPatternIn('<extension-service citation - fill at implementation>')).toBeDefined();
    expect(placeholderPatternIn('TODO: add citation')).toBeDefined();
    expect(placeholderPatternIn('TBD')).toBeDefined();
    expect(placeholderPatternIn('placeholder')).toBeDefined();
    expect(
      placeholderPatternIn(
        'Virginia Cooperative Extension, publication ANR-6, "Late Blight of Tomato and Potato", https://pubs.ext.vt.edu/ANR/ANR-6.html (checked 2026-09-15)',
      ),
    ).toBeUndefined();
  });
});

describe('parseKnowledgeRows', () => {
  it('reads the two columns and defaults a null source to empty, so 4.2 still fails loudly', () => {
    expect(parseKnowledgeRows([{ disease_name: 'Tomato Healthy', source: null }])).toEqual({
      ok: true,
      value: [{ diseaseName: 'Tomato Healthy', source: '' }],
    });
  });

  it('refuses a response that is not an array of rows rather than throwing later', () => {
    expect(parseKnowledgeRows(null).ok).toBe(false);
    expect(parseKnowledgeRows([{ source: 'x' }]).ok).toBe(false);
  });
});

/* ========================================================================== */
/* Requirement 13.5 — the buckets                                              */
/* ========================================================================== */

describe('assertBuckets', () => {
  it('passes when both buckets exist with public = false', () => {
    const assertions = assertBuckets(ok(healthyBuckets));
    expect(assertions.map((assertion) => assertion.status)).toEqual(['pass', 'pass']);
  });

  it('fails, and cannot judge privacy, when a bucket is absent', () => {
    const assertions = assertBuckets(ok([{ id: 'crop-images', isPublic: false }]));
    expect(statusOf(assertions, 'buckets-exist')).toBe('fail');
    expect(detailOf(assertions, 'buckets-exist')).toContain('voice-messages');
    expect(statusOf(assertions, 'buckets-private')).toBe('unverified');
  });

  it('fails on a public bucket and calls it a release blocker', () => {
    const assertions = assertBuckets(
      ok([
        { id: 'crop-images', isPublic: true },
        { id: 'voice-messages', isPublic: false },
      ]),
    );
    expect(statusOf(assertions, 'buckets-exist')).toBe('pass');
    expect(statusOf(assertions, 'buckets-private')).toBe('fail');
    expect(detailOf(assertions, 'buckets-private')).toContain('RELEASE BLOCKER');
  });

  it('ignores buckets Jamee does not own', () => {
    const assertions = assertBuckets(ok([...healthyBuckets, { id: 'avatars', isPublic: true }]));
    expect(assertions.map((assertion) => assertion.status)).toEqual(['pass', 'pass']);
  });
});

/* ========================================================================== */
/* Requirement 13.1 — RLS                                                      */
/* ========================================================================== */

describe('assertRls', () => {
  it('passes when relrowsecurity is true on all seven tables', () => {
    const assertions = assertRls(ok(healthyRls), ok(healthyAnon));
    expect(assertions.map((assertion) => assertion.status)).toEqual(['pass', 'pass']);
  });

  it('fails when one table has RLS off', () => {
    const rls = healthyRls.map((record) =>
      record.table === 'diagnoses' ? { table: 'diagnoses', rowSecurityEnabled: false } : record,
    );
    const assertions = assertRls(ok(rls), ok(healthyAnon));
    expect(statusOf(assertions, 'rls-enabled')).toBe('fail');
    expect(detailOf(assertions, 'rls-enabled')).toContain('diagnoses');
  });

  it('fails when a table is missing from the public schema entirely', () => {
    const assertions = assertRls(
      ok(healthyRls.filter((record) => record.table !== 'whatsapp_inbound')),
      ok(healthyAnon),
    );
    expect(statusOf(assertions, 'rls-enabled')).toBe('fail');
    expect(detailOf(assertions, 'rls-enabled')).toContain('whatsapp_inbound');
  });

  it('fails the cross-check when the publishable key can count farmer rows', () => {
    const anon = healthyAnon.map((record) =>
      record.table === 'profiles' ? { table: 'profiles', visibleRows: 3 } : record,
    );
    const assertions = assertRls(ok(healthyRls), ok(anon));
    expect(statusOf(assertions, 'rls-enabled')).toBe('pass');
    expect(statusOf(assertions, 'rls-anon-visibility')).toBe('fail');
    expect(detailOf(assertions, 'rls-anon-visibility')).toContain('profiles (3)');
  });

  it('states in its own detail that a clean cross-check cannot prove RLS is on', () => {
    const assertions = assertRls(ok(healthyRls), ok(healthyAnon));
    expect(detailOf(assertions, 'rls-anon-visibility')).toContain('cannot prove RLS is ON');
  });

  it('treats a refused anonymous read as no visibility rather than a failure', () => {
    const anon: AnonVisibilityRecord[] = RLS_TABLES.map((table) => ({
      table,
      visibleRows: null,
      error: 'permission denied for table',
    }));
    expect(statusOf(assertRls(ok(healthyRls), ok(anon)), 'rls-anon-visibility')).toBe('pass');
  });

  it('is unverified — never a pass — when no SQL runner was available', () => {
    const assertions = assertRls(
      failed<readonly RlsRecord[]>('not configured: JAMEE_DEPLOYMENT_DATABASE_URL'),
      ok(healthyAnon),
    );
    expect(statusOf(assertions, 'rls-enabled')).toBe('unverified');
    expect(detailOf(assertions, 'rls-enabled')).toContain('JAMEE_DEPLOYMENT_DATABASE_URL');
  });
});

describe('parseRlsOutput', () => {
  it("reads psql's -A -t -F| tuples into records", () => {
    expect(parseRlsOutput('conversations|t\ncounters|f\n\n')).toEqual({
      ok: true,
      value: [
        { table: 'conversations', rowSecurityEnabled: true },
        { table: 'counters', rowSecurityEnabled: false },
      ],
    });
  });

  it('refuses output it cannot read instead of guessing a boolean', () => {
    expect(parseRlsOutput('profiles|maybe').ok).toBe(false);
    expect(parseRlsOutput('profiles').ok).toBe(false);
  });
});

describe('psql invocation', () => {
  it('keeps the password out of argv and puts it in the child environment', () => {
    const url = 'postgresql://postgres:s3cr3t@db.abcdefgh.supabase.co:5432/postgres';
    const args = psqlArgs(RLS_SQL);
    expect(args.join(' ')).not.toContain('s3cr3t');
    expect(args.join(' ')).not.toContain(url);

    const env = psqlEnvFromUrl(url);
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.value).toMatchObject({
      PGHOST: 'db.abcdefgh.supabase.co',
      PGPORT: '5432',
      PGDATABASE: 'postgres',
      PGUSER: 'postgres',
      PGPASSWORD: 's3cr3t',
      PGSSLMODE: 'require',
    });
  });

  it('defaults the port and database, and honours an explicit sslmode', () => {
    const env = psqlEnvFromUrl('postgres://user@host/?sslmode=verify-full');
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.value.PGPORT).toBe('5432');
    expect(env.value.PGDATABASE).toBe('postgres');
    expect(env.value.PGSSLMODE).toBe('verify-full');
    expect(env.value.PGPASSWORD).toBeUndefined();
  });

  it('refuses a value that is not a Postgres URL', () => {
    expect(psqlEnvFromUrl('not-a-url').ok).toBe(false);
    expect(psqlEnvFromUrl('https://db.example.com/postgres').ok).toBe(false);
  });
});

/* ========================================================================== */
/* Requirements 11.1 / 11.2 — the webhook GET (step 7)                          */
/* ========================================================================== */

describe('assertWebhookChallenge', () => {
  it('passes on 200-with-echo and 403-empty', () => {
    const assertions = assertWebhookChallenge(ok(healthyChallenge()));
    expect(assertions.map((assertion) => assertion.status)).toEqual(['pass', 'pass']);
  });

  it('fails when the 200 does not echo the challenge verbatim', () => {
    const observation = healthyChallenge();
    const assertions = assertWebhookChallenge(
      ok({ ...observation, withConfiguredToken: { status: 200, body: 'something else', contentType: 'text/plain' } }),
    );
    expect(statusOf(assertions, 'webhook-verify-accepts')).toBe('fail');
    expect(detailOf(assertions, 'webhook-verify-accepts')).toContain('did not echo');
  });

  it('fails when the configured token is refused, and names the trailing-newline cause', () => {
    const observation = healthyChallenge();
    const assertions = assertWebhookChallenge(
      ok({ ...observation, withConfiguredToken: { status: 403, body: '', contentType: null } }),
    );
    expect(statusOf(assertions, 'webhook-verify-accepts')).toBe('fail');
    expect(detailOf(assertions, 'webhook-verify-accepts')).toContain('trailing newline');
  });

  it('calls a wrong token accepted with 200 a release blocker', () => {
    const observation = healthyChallenge();
    const assertions = assertWebhookChallenge(
      ok({ ...observation, withWrongToken: { status: 200, body: observation.challenge, contentType: 'text/plain' } }),
    );
    expect(statusOf(assertions, 'webhook-verify-rejects')).toBe('fail');
    expect(detailOf(assertions, 'webhook-verify-rejects')).toContain('RELEASE BLOCKER');
  });

  it('fails a 403 that carries a body — Requirement 11.2 is bodiless', () => {
    const observation = healthyChallenge();
    const assertions = assertWebhookChallenge(
      ok({ ...observation, withWrongToken: { status: 403, body: '{"error":"bad token"}', contentType: 'application/json' } }),
    );
    expect(statusOf(assertions, 'webhook-verify-rejects')).toBe('fail');
  });

  it('notes a non-https origin, which Meta cannot verify at all', () => {
    const assertions = assertWebhookChallenge(
      ok({ ...healthyChallenge(), url: 'http://localhost:3000/api/whatsapp' }),
    );
    expect(assertions[0]?.evidence.join(' ')).toContain('V13 requires HTTPS');
  });

  it('is unverified when the deployment could not be reached', () => {
    const assertions = assertWebhookChallenge(failed<ChallengeObservation>('GET https://x/api/whatsapp failed: fetch failed'));
    expect(assertions.map((assertion) => assertion.status)).toEqual(['unverified', 'unverified']);
  });
});

/* ========================================================================== */
/* The run, the verdict, and the report                                        */
/* ========================================================================== */

const fakeProbe = (overrides: Partial<DeploymentProbe> = {}): DeploymentProbe => ({
  describe: 'fixtures',
  knowledge: () => Promise.resolve(ok<readonly KnowledgeRow[]>(healthyKnowledge)),
  buckets: () => Promise.resolve(ok<readonly BucketRecord[]>(healthyBuckets)),
  rls: () => Promise.resolve(ok<readonly RlsRecord[]>(healthyRls)),
  anonVisibility: () => Promise.resolve(ok<readonly AnonVisibilityRecord[]>(healthyAnon)),
  webhook: () => Promise.resolve(ok(healthyChallenge())),
  ...overrides,
});

describe('runChecks', () => {
  it('exits 0 and prints PASS only when every assertion is verified and passing', async () => {
    const report = await runChecks(fakeProbe());
    expect(report.assertions.every((assertion) => assertion.status === 'pass')).toBe(true);
    expect(exitCode(report)).toBe(0);
    expect(formatReport(report)).toContain('PASS — every assertion verified');
  });

  it('exits 1 on a failure', async () => {
    const report = await runChecks(
      fakeProbe({ buckets: () => Promise.resolve(ok<readonly BucketRecord[]>([{ id: 'crop-images', isPublic: true }])) }),
    );
    expect(exitCode(report)).toBe(1);
    expect(formatReport(report)).toContain('FAIL —');
  });

  it('exits 1 on an unverified assertion, so "could not check" never reads as fine', async () => {
    const report = await runChecks(
      fakeProbe({ rls: () => Promise.resolve(failed<readonly RlsRecord[]>('no psql on PATH')) }),
    );
    expect(exitCode(report)).toBe(1);
    const text = formatReport(report);
    expect(text).toContain('UNVERIFIED');
    expect(text).toContain('1 unverified');
    // The substitute SQL from docs/DEPLOYMENT.md step 3 is offered whenever something is unverified.
    expect(text).toContain('relrowsecurity from pg_class');
    expect(text).toContain('select count(*) from public.disease_knowledge;');
  });

  it('names every assertion and always prints the limits', async () => {
    const text = formatReport(await runChecks(fakeProbe()));
    for (const id of [
      'knowledge-count',
      'knowledge-conditions',
      'knowledge-source',
      'knowledge-source-real',
      'buckets-exist',
      'buckets-private',
      'rls-enabled',
      'rls-anon-visibility',
      'webhook-verify-accepts',
      'webhook-verify-rejects',
    ]) {
      expect(text).toContain(id);
    }
    expect(text).toContain('LIMITS OF THIS CHECK');
  });
});

/* ========================================================================== */
/* An unconfigured environment refuses by name instead of crashing              */
/* ========================================================================== */

describe('configuration', () => {
  it('reads nothing out of an empty environment and reports it as unconfigured', () => {
    const env = readEnvironment({});
    expect(env).toEqual({});
    expect(isUnconfigured(env)).toBe(true);
  });

  it('treats an empty string as unset, like src/lib/env.ts does', () => {
    expect(readEnvironment({ SUPABASE_SERVICE_ROLE_KEY: '   ' })).toEqual({});
  });

  it('accepts either spelling of the public key, publishable first (V1)', () => {
    expect(readEnvironment({ NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' }).publishableKey).toBe('anon');
    expect(
      readEnvironment({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pub', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' })
        .publishableKey,
    ).toBe('pub');
  });

  it('lists every variable with what it unblocks, and never a value', () => {
    const rows = configurationRows(readEnvironment({ SUPABASE_SERVICE_ROLE_KEY: 'super-secret-value' }));
    expect(rows).toHaveLength(CONFIG_VARS.length);
    expect(rows.find((row) => row.name === 'SUPABASE_SERVICE_ROLE_KEY')?.present).toBe(true);
    expect(rows.find((row) => row.name === 'JAMEE_DEPLOYMENT_URL')?.present).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('super-secret-value');
  });

  it('refuses every assertion by name — without crashing — when nothing is configured', async () => {
    const env = readEnvironment({});
    const report = await runChecks(liveProbe(env), env);

    expect(report.assertions).toHaveLength(10);
    expect(report.assertions.every((assertion) => assertion.status === 'unverified')).toBe(true);
    expect(exitCode(report)).toBe(1);

    const text = formatReport(report);
    expect(text).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(text).toContain('JAMEE_DEPLOYMENT_DATABASE_URL');
    expect(text).toContain('JAMEE_DEPLOYMENT_URL');
    expect(text).toContain('WHATSAPP_VERIFY_TOKEN');
    expect(text).toContain('COULD NOT BE VERIFIED');
    expect(text).toContain(`expect ${KNOWLEDGE_ROW_COUNT}`);
  });

  it('answers a mistyped NEXT_PUBLIC_SUPABASE_URL with UNVERIFIED, not a stack trace', async () => {
    // createClient validates the URL and throws synchronously, so nothing here reaches the network.
    const env = readEnvironment({ NEXT_PUBLIC_SUPABASE_URL: 'db.abcdefgh.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    const report = await runChecks(liveProbe(env), env);

    expect(statusOf(report.assertions, 'knowledge-count')).toBe('unverified');
    expect(detailOf(report.assertions, 'knowledge-count')).toContain('threw');
    expect(statusOf(report.assertions, 'buckets-exist')).toBe('unverified');
    expect(exitCode(report)).toBe(1);
  });

  it('runs the step-3 checks for an operator who has not reached step 7 yet', async () => {
    const env = readEnvironment({ JAMEE_DEPLOYMENT_DATABASE_URL: 'postgresql://u:p@h:5432/postgres' });
    const probe = liveProbe(env, { runSql: () => ok(healthyRls.map((r) => `${r.table}|t`).join('\n')) });
    const report = await runChecks(probe, env);

    expect(statusOf(report.assertions, 'rls-enabled')).toBe('pass');
    expect(statusOf(report.assertions, 'webhook-verify-accepts')).toBe('unverified');
    expect(detailOf(report.assertions, 'webhook-verify-accepts')).toContain('JAMEE_DEPLOYMENT_URL');
  });
});

/* ========================================================================== */
/* The live webhook probe, against an injected fetch                            */
/* ========================================================================== */

describe('liveProbe webhook', () => {
  it('sends hub.mode, hub.verify_token and hub.challenge, and reads both responses', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url = String(input);
      seen.push(url);
      const params = new URL(url).searchParams;
      const challenge = params.get(CHALLENGE_PARAMS.challenge) ?? '';
      return Promise.resolve(
        params.get(CHALLENGE_PARAMS.verifyToken) === 'the-real-token'
          ? new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
          : new Response(null, { status: 403 }),
      );
    };

    const env = readEnvironment({
      JAMEE_DEPLOYMENT_URL: 'jamee.example.app',
      WHATSAPP_VERIFY_TOKEN: 'the-real-token',
    });
    const probed = await liveProbe(env, { fetchImpl }).webhook();

    expect(probed.ok).toBe(true);
    if (!probed.ok) return;
    expect(assertWebhookChallenge(probed).map((assertion) => assertion.status)).toEqual(['pass', 'pass']);

    // A bare host is upgraded to https, both halves carry mode=subscribe, and the reported URL
    // carries no token at all.
    expect(seen).toHaveLength(2);
    for (const url of seen) {
      expect(url.startsWith('https://jamee.example.app/api/whatsapp?')).toBe(true);
      expect(new URL(url).searchParams.get(CHALLENGE_PARAMS.mode)).toBe(CHALLENGE_SUBSCRIBE_MODE);
    }
    expect(probed.value.url).not.toContain('the-real-token');
    expect(probed.value.withWrongToken.status).toBe(403);
  });

  it('reports an unreachable deployment as unverified rather than throwing', async () => {
    const env = readEnvironment({ JAMEE_DEPLOYMENT_URL: 'https://down.example.app', WHATSAPP_VERIFY_TOKEN: 't' });
    const probed = await liveProbe(env, { fetchImpl: () => Promise.reject(new Error('fetch failed')) }).webhook();

    expect(probed.ok).toBe(false);
    if (probed.ok) return;
    expect(probed.reason).toContain('fetch failed');
  });
});
