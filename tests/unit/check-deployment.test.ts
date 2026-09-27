import { describe, expect, it } from 'vitest';

import {
  DATABASE_NAME,
  EXPECTED_COLLECTIONS,
  EXPECTED_CONDITION_COUNT,
  MEDIA_BUCKET,
  REQUIRED_INDEXES,
  TELEGRAM_WEBHOOK_PATH,
  VALIDATED_COLLECTIONS,
  assertDatabase,
  assertHttp,
  assertWebhook,
  exitCode,
  formatReport,
  readInputs,
  run,
  type Assertion,
  type DatabaseObservation,
  type HttpObservation,
  type RunResult,
} from '../../scripts/check-deployment';

import { COLLECTIONS, MEDIA_BUCKET as CANON_BUCKET } from '../../src/lib/db/names';

/**
 * Tests for the A3 post-deployment guard. It asserts facts about a running MongoDB deployment and
 * three deployed routes, so — as the script's own header says — every assertion is a pure function
 * of an injected observation, and every case here drives those functions with FIXTURES: no live
 * database, no network. Two cases wire the `run()` orchestrator with fake probes to prove the
 * skip-when-absent behaviour and the injection seam.
 *
 * Requirements: 4.1, 4.2, 13.1, 13.5, 17.6, 11.2, 11.3, 22.6, 18.12
 */

/* ========================================================================== */
/* The local name copies cannot drift from the canonical ones                  */
/* ========================================================================== */

describe('the local name copies mirror the canonical Data_Access_Layer names', () => {
  it('lists exactly the twelve canonical collections', () => {
    expect([...EXPECTED_COLLECTIONS].sort()).toEqual([...Object.values(COLLECTIONS)].sort());
  });

  it('names the same GridFS bucket', () => {
    expect(MEDIA_BUCKET).toBe(CANON_BUCKET);
  });

  it('validates every collection it expects to exist', () => {
    expect([...VALIDATED_COLLECTIONS].sort()).toEqual([...EXPECTED_COLLECTIONS].sort());
  });
});

/* ========================================================================== */
/* A fully-correct database observation, which each test then breaks in one way */
/* ========================================================================== */

const goodDatabase = (): DatabaseObservation => {
  const collections = [...EXPECTED_COLLECTIONS, `${MEDIA_BUCKET}.files`, `${MEDIA_BUCKET}.chunks`];
  const indexes: Record<string, string[]> = {};
  for (const [collection, names] of Object.entries(REQUIRED_INDEXES)) {
    indexes[collection] = [...names, '_id_'];
  }
  const validators: Record<string, boolean> = {};
  for (const collection of VALIDATED_COLLECTIONS) validators[collection] = true;

  return {
    collections,
    indexes,
    validators,
    conditionCount: EXPECTED_CONDITION_COUNT,
    conditionsWithSource: EXPECTED_CONDITION_COUNT,
  };
};

const failed = (assertions: readonly Assertion[]): string[] =>
  assertions.filter((a) => a.status === 'fail').map((a) => a.name);

/* ========================================================================== */
/* Part 1 — database                                                          */
/* ========================================================================== */

describe('assertDatabase', () => {
  it('passes a fully-correct database', () => {
    expect(failed(assertDatabase(goodDatabase()))).toEqual([]);
  });

  it('fails when a collection is missing', () => {
    const obs = goodDatabase();
    const collections = obs.collections.filter((c) => c !== 'bot_entitlements');
    expect(failed(assertDatabase({ ...obs, collections }))).toContain('collections');
  });

  it('fails when the GridFS bucket is absent', () => {
    const obs = goodDatabase();
    const collections = obs.collections.filter((c) => c !== `${MEDIA_BUCKET}.files`);
    expect(failed(assertDatabase({ ...obs, collections }))).toContain('gridfs-bucket');
  });

  it('fails when a collection carries no validator', () => {
    const obs = goodDatabase();
    expect(
      failed(assertDatabase({ ...obs, validators: { ...obs.validators, diagnoses: false } })),
    ).toContain('validators');
  });

  it('fails when a required unique index is missing', () => {
    const obs = goodDatabase();
    const indexes = { ...obs.indexes, payment_orders: ['providerOrderId_unique', '_id_'] };
    expect(failed(assertDatabase({ ...obs, indexes }))).toContain('indexes');
  });

  it('fails when disease_knowledge does not hold exactly five rows', () => {
    expect(failed(assertDatabase({ ...goodDatabase(), conditionCount: 4, conditionsWithSource: 4 }))).toContain(
      'disease-knowledge-count',
    );
  });

  it('fails when a condition row has an empty source', () => {
    expect(
      failed(assertDatabase({ ...goodDatabase(), conditionsWithSource: EXPECTED_CONDITION_COUNT - 1 })),
    ).toContain('disease-knowledge-source');
  });
});

/* ========================================================================== */
/* Part 2 — HTTP unauthenticated rejection                                    */
/* ========================================================================== */

describe('assertHttp', () => {
  const ok = (): {
    telegramNoToken: HttpObservation;
    paymentNoSignature: HttpObservation;
    retentionNoBearer: HttpObservation;
  } => ({
    telegramNoToken: { status: 401 },
    paymentNoSignature: { status: 401 },
    retentionNoBearer: { status: 401 },
  });

  it('passes when all three routes reject with 401', () => {
    expect(failed(assertHttp(ok()))).toEqual([]);
  });

  it('fails the telegram route when it returns 200 instead of 401', () => {
    expect(failed(assertHttp({ ...ok(), telegramNoToken: { status: 200 } }))).toEqual([
      'telegram-no-secret-token',
    ]);
  });

  it('fails the payment route when it returns 400 instead of 401', () => {
    expect(failed(assertHttp({ ...ok(), paymentNoSignature: { status: 400 } }))).toEqual([
      'payment-no-signature',
    ]);
  });

  it('fails the retention route when it returns 200 instead of 401', () => {
    expect(failed(assertHttp({ ...ok(), retentionNoBearer: { status: 200 } }))).toEqual([
      'retention-no-bearer',
    ]);
  });

  it('fails a route whose request could not be made at all', () => {
    expect(
      failed(assertHttp({ ...ok(), telegramNoToken: { status: null, error: 'ECONNREFUSED' } })),
    ).toEqual(['telegram-no-secret-token']);
  });
});

/* ========================================================================== */
/* Part 3 — Telegram webhook registration                                     */
/* ========================================================================== */

describe('assertWebhook', () => {
  const origin = 'https://jamee.example.com';

  it('passes when the registered URL is the origin + the telegram path', () => {
    const a = assertWebhook({ url: `${origin}${TELEGRAM_WEBHOOK_PATH}` }, origin);
    expect(a.status).toBe('pass');
  });

  it('tolerates a trailing slash on the origin', () => {
    const a = assertWebhook({ url: `${origin}${TELEGRAM_WEBHOOK_PATH}` }, `${origin}/`);
    expect(a.status).toBe('pass');
  });

  it('fails when Telegram has a different URL registered', () => {
    const a = assertWebhook({ url: 'https://old.example.com/api/telegram' }, origin);
    expect(a.status).toBe('fail');
  });

  it('fails when no webhook is registered', () => {
    expect(assertWebhook({ url: '' }, origin).status).toBe('fail');
  });

  it('fails when getWebhookInfo itself errored', () => {
    expect(assertWebhook({ url: null, error: 'timeout' }, origin).status).toBe('fail');
  });
});

/* ========================================================================== */
/* readInputs                                                                  */
/* ========================================================================== */

describe('readInputs', () => {
  it('reads MONGODB_URI and TELEGRAM_BOT_TOKEN from the environment and the origin from argv[2]', () => {
    const inputs = readInputs(['node', 'check-deployment.ts', 'https://jamee.example.com'], {
      MONGODB_URI: 'mongodb+srv://x',
      TELEGRAM_BOT_TOKEN: 't',
    } as unknown as NodeJS.ProcessEnv);

    expect(inputs.mongoUri).toBe('mongodb+srv://x');
    expect(inputs.origin).toBe('https://jamee.example.com');
    expect(inputs.botToken).toBe('t');
  });

  it('treats an empty or missing variable as absent', () => {
    const inputs = readInputs(['node', 'check-deployment.ts'], { MONGODB_URI: '  ' } as unknown as NodeJS.ProcessEnv);
    expect(inputs.mongoUri).toBeUndefined();
    expect(inputs.origin).toBeUndefined();
    expect(inputs.botToken).toBeUndefined();
  });
});

/* ========================================================================== */
/* The run — skip-when-absent and the injected probe seam                      */
/* ========================================================================== */

describe('run', () => {
  it('skips every part when nothing is configured, and never fails on a skip', async () => {
    const result = await run({ mongoUri: undefined, origin: undefined, botToken: undefined }, {});
    expect(result.assertions).toEqual([]);
    expect(result.skips.map((s) => s.part).sort()).toEqual(['database', 'http', 'telegram']);
    expect(exitCode(result)).toBe(0);
  });

  it('runs only the database part when only MONGODB_URI is present, via the injected probe', async () => {
    const result = await run(
      { mongoUri: 'mongodb+srv://x', origin: undefined, botToken: undefined },
      { database: async () => goodDatabase() },
    );

    expect(result.assertions.every((a) => a.part === 'database')).toBe(true);
    expect(result.assertions.some((a) => a.status === 'fail')).toBe(false);
    expect(result.skips.map((s) => s.part).sort()).toEqual(['http', 'telegram']);
  });

  it('runs the http and telegram parts when the origin and bot token are present', async () => {
    const result = await run(
      { mongoUri: undefined, origin: 'https://jamee.example.com', botToken: 't' },
      {
        http: async () => ({
          telegramNoToken: { status: 401 },
          paymentNoSignature: { status: 401 },
          retentionNoBearer: { status: 401 },
        }),
        webhook: async () => ({ url: `https://jamee.example.com${TELEGRAM_WEBHOOK_PATH}` }),
      },
    );

    expect(result.assertions.some((a) => a.part === 'http')).toBe(true);
    expect(result.assertions.some((a) => a.part === 'telegram')).toBe(true);
    expect(exitCode(result)).toBe(0);
  });

  it('sets a non-zero exit code when an injected probe reports a failure', async () => {
    const result = await run(
      { mongoUri: 'mongodb+srv://x', origin: undefined, botToken: undefined },
      { database: async () => ({ ...goodDatabase(), conditionCount: 3, conditionsWithSource: 3 }) },
    );
    expect(exitCode(result)).toBe(1);
  });
});

/* ========================================================================== */
/* Reporting                                                                   */
/* ========================================================================== */

describe('formatReport', () => {
  const inputs = { mongoUri: 'mongodb+srv://x', origin: undefined, botToken: undefined };

  it('prints presence only, never a secret value', () => {
    const result: RunResult = { assertions: assertDatabase(goodDatabase()), skips: [] };
    const output = formatReport(inputs, result);
    expect(output).toContain('MONGODB_URI:         set');
    expect(output).not.toContain('mongodb+srv://x');
  });

  it('lists a skip and ends in PASS when nothing failed', () => {
    const result: RunResult = {
      assertions: assertDatabase(goodDatabase()),
      skips: [{ part: 'http', reason: 'no deployed https origin given as the first argument' }],
    };
    const output = formatReport(inputs, result);
    expect(output).toContain('SKIP  [http]');
    expect(output.trimEnd().endsWith('PASS')).toBe(true);
  });

  it('ends in FAIL and prints the limits when an assertion failed', () => {
    const bad = assertDatabase({ ...goodDatabase(), conditionCount: 4, conditionsWithSource: 4 });
    const output = formatReport(inputs, { assertions: bad, skips: [] });
    expect(output).toContain('LIMITS OF THIS CHECK');
    expect(output).toContain('FAIL');
  });

  it('names the jamee database', () => {
    expect(DATABASE_NAME).toBe('jamee');
  });
});
