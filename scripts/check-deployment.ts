/**
 * `check-deployment` — the guard that turns "db:setup reported success and the app is deployed"
 * into "this deployment is actually correct", for the Amendment A3 stack (MongoDB Atlas + GridFS +
 * Better Auth + Telegram + Razorpay).
 *
 * Requirements: 4.1 (the Knowledge_Base holds exactly the five Verified_Conditions), 4.2 (every
 *               row's `source` is populated), 13.1 (the collections the Data_Access_Layer scopes
 *               exist with their validators and indexes), 13.5 (the single GridFS media bucket
 *               exists), 17.6 (`db:setup` creates every collection, index, validator and seed row —
 *               this script is the evidence that it did), 21.3 / 22.23 (the access collections
 *               exist), 11.2 / 11.3 (the Telegram route rejects an unsigned delivery), 22.6 (the
 *               payment webhook rejects an unsigned delivery), 18.12 (the retention route rejects
 *               a call with no `CRON_SECRET` bearer)
 * Design: "Data model and collection setup", D17 (the single GridFS bucket), D18/D19; Amendment A3
 *         point 2 (MongoDB replaces Supabase — no RLS, no Storage buckets, no GET webhook
 *         handshake); "Static architecture check (CI)" (this is NOT that — see below)
 * Procedure: `docs/DEPLOYMENT.md` names this script by the command below. It is run TWICE — once
 *            after `npm run db:setup` (the database half, with `MONGODB_URI`) and again after the
 *            app is deployed and `setWebhook` registered (the HTTP half, with a deployed origin).
 *
 * Run it:  `npm run check:deployment`
 *          (`node --env-file-if-exists=.env.local --experimental-strip-types scripts/check-deployment.ts [ORIGIN]`)
 *
 * Exit 0 only when every part that had its inputs is **verified and passing**. Exit 1 on any failed
 * assertion, because a failure must never read as "fine". A part whose input is absent is SKIPPED
 * with a stated reason — a skip is not a failure and does not set the exit code, but the report
 * says plainly that the part did not run.
 *
 * =============================================================================
 * HOW THIS DIFFERS FROM THE OTHER THREE GUARDS — READ THIS FIRST
 * =============================================================================
 *
 * `check-secret-scope.ts`, `check-shared-implementation.ts` and `check-data-access.ts` are static
 * scans: they read the repository, and their answer is a property of the source, so they run in
 * CI. **This one is not, and does not.** It asserts facts about a *running* deployment — documents
 * and indexes in a live MongoDB database, the GridFS bucket, and the HTTP behaviour of three
 * deployed routes. There is nothing in the repository that can make these assertions true or false,
 * so the release workflow (`.github/workflows/release-gates.yml`) does NOT run it; an operator runs
 * it against the real deployment at the two points in `docs/DEPLOYMENT.md` that produce its facts.
 *
 * =============================================================================
 * WHY THIS IS SELF-CONTAINED AND MAY IMPORT `mongodb` DIRECTLY
 * =============================================================================
 *
 * Like `scripts/db-setup.ts`, this runs under bare `node --experimental-strip-types`, which
 * resolves neither the `@/*` tsconfig alias nor Next's `server-only` shim. So it imports nothing
 * from `src/**` — it reads `process.env` directly and imports `mongodb` directly, exactly as
 * `db-setup.ts` does. Both are on `check-data-access.ts`'s allowlist for that reason: this script
 * legitimately holds the driver.
 *
 * The compensating discipline that replaces `check-secret-scope`'s protection is explicit and
 * absolute: **no secret value is ever written to the output.** The CONFIGURATION section prints
 * `set` or `absent` and never a value; the connection string, the bot token, and the cron secret
 * are used and never printed; and the HTTP probes assert only status codes, never response bodies.
 *
 * =============================================================================
 * THE THREE PARTS, EACH SKIPPED WHEN ITS INPUT IS ABSENT
 * =============================================================================
 *
 * 1. **Database** (needs `MONGODB_URI`). Asserts that the `jamee` database has every collection,
 *    index and `$jsonSchema` validator `scripts/db-setup.ts` creates, the single GridFS media
 *    bucket, and exactly five `disease_knowledge` rows each with a non-empty `source`.
 *
 * 2. **HTTP** (needs a deployed https origin as the first CLI argument). Asserts the three
 *    unauthenticated-rejection facts A3 leaves — there is no GET webhook handshake anymore:
 *      - `POST /api/telegram` with no `X-Telegram-Bot-Api-Secret-Token` header → 401
 *      - `POST /api/payment/webhook` with no valid signature → 401
 *      - `GET /api/internal/retention-sweep` with no `CRON_SECRET` bearer → 401
 *
 * 3. **Telegram webhook** (needs `TELEGRAM_BOT_TOKEN` and the origin). Asserts `getWebhookInfo`
 *    reports the deployed origin + `/api/telegram` as the registered URL.
 *
 * =============================================================================
 * WHAT THIS SCRIPT CANNOT DO — the full list is in the report's LIMITS section
 * =============================================================================
 *
 * A validator's presence is not proof it rejects every malformed document (the integration suite
 * proves that); a 401 from a route proves the route rejects THAT unauthenticated shape, not that
 * every authenticated shape is handled; `getWebhookInfo` reports what Telegram was told, which is
 * what this asserts; and every answer is a point-in-time snapshot.
 */

import { MongoClient, type Db } from 'mongodb';

/* ========================================================================== */
/* The facts the assertions are written against — duplicated from db-setup     */
/* ========================================================================== */

/**
 * The twelve Jamee collections, the GridFS bucket, and the five condition count, declared LOCALLY
 * here for the same reason `scripts/db-setup.ts` declares them locally: this file runs under bare
 * `node --experimental-strip-types` and cannot import the `@/`-aliased `@/lib/db/names`. The
 * `check-deployment` test asserts these equal the canonical names, so the copy cannot drift.
 */
export const EXPECTED_COLLECTIONS = [
  'profiles',
  'conversations',
  'messages',
  'diagnoses',
  'usage_logs',
  'counters',
  'disease_knowledge',
  'telegram_inbound',
  'link_tokens',
  'payment_orders',
  'bot_entitlements',
  'webhook_throttle',
] as const;

/** The single GridFS bucket (D17). Its collections are `media.files` / `media.chunks`. */
export const MEDIA_BUCKET = 'media';

/** The exact number of seeded conditions (Requirement 4.1). */
export const EXPECTED_CONDITION_COUNT = 5;

/**
 * One representative index per collection whose absence would break a load-bearing invariant. Not
 * every index db-setup creates — a full mirror would duplicate `names.ts` and drift — but the
 * unique/partial ones the former SQL `UNIQUE`/PK constraints became, since those are the ones a
 * silent setup failure would drop. Keyed by collection → the index NAME db-setup assigns.
 */
export const REQUIRED_INDEXES: Readonly<Record<string, readonly string[]>> = {
  profiles: ['telegramUserId_partial_unique'],
  counters: ['counter_key_unique'],
  disease_knowledge: ['diseaseName_unique'],
  link_tokens: ['tokenHash_unique'],
  payment_orders: ['providerOrderId_unique', 'providerPaymentId_partial_unique'],
  bot_entitlements: ['providerPaymentId_unique'],
  webhook_throttle: ['throttle_key_unique'],
  diagnoses: ['retention_pending'],
  [`${MEDIA_BUCKET}.files`]: ['owner_kind'],
};

/** Collections whose `$jsonSchema` validator must be present (the enumerated-field invariants). */
export const VALIDATED_COLLECTIONS = [
  'profiles',
  'conversations',
  'messages',
  'diagnoses',
  'usage_logs',
  'counters',
  'disease_knowledge',
  'telegram_inbound',
  'link_tokens',
  'payment_orders',
  'bot_entitlements',
  'webhook_throttle',
] as const;

export const DATABASE_NAME = 'jamee';

/** The three routes whose unauthenticated rejection this script probes. */
export const TELEGRAM_WEBHOOK_PATH = '/api/telegram';
export const PAYMENT_WEBHOOK_PATH = '/api/payment/webhook';
export const RETENTION_SWEEP_PATH = '/api/internal/retention-sweep';

/* ========================================================================== */
/* Observations and assertions — pure functions of injected inputs             */
/* ========================================================================== */

export type Status = 'pass' | 'fail' | 'skip';

export interface Assertion {
  readonly part: 'database' | 'http' | 'telegram';
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

/** What a database probe reports back. All plain data, so assertions are pure and testable. */
export interface DatabaseObservation {
  /** Collection names present in the `jamee` database (including `media.files`/`media.chunks`). */
  readonly collections: readonly string[];
  /** collection name → index names present. */
  readonly indexes: Readonly<Record<string, readonly string[]>>;
  /** collection name → whether a `$jsonSchema` validator is attached. */
  readonly validators: Readonly<Record<string, boolean>>;
  /** Number of `disease_knowledge` documents. */
  readonly conditionCount: number;
  /** Number of `disease_knowledge` documents whose `source` is a non-empty string. */
  readonly conditionsWithSource: number;
}

/** An HTTP probe result: the status code, or `null` when the request could not be made. */
export interface HttpObservation {
  readonly status: number | null;
  /** Present only when the request itself failed (network, DNS); never a response body. */
  readonly error?: string;
}

/** `getWebhookInfo` reduced to the one fact this asserts: the registered URL. */
export interface WebhookInfoObservation {
  readonly url: string | null;
  readonly error?: string;
}

/* -------------------------------------------------------------------------- */
/* Part 1 — database                                                          */
/* -------------------------------------------------------------------------- */

export function assertDatabase(obs: DatabaseObservation): Assertion[] {
  const out: Assertion[] = [];
  const present = new Set(obs.collections);

  // Collections.
  const missingCollections = EXPECTED_COLLECTIONS.filter((c) => !present.has(c));
  out.push({
    part: 'database',
    name: 'collections',
    status: missingCollections.length === 0 ? 'pass' : 'fail',
    detail:
      missingCollections.length === 0
        ? `all ${EXPECTED_COLLECTIONS.length} Jamee collections present`
        : `missing: ${missingCollections.join(', ')} — re-run npm run db:setup`,
  });

  // The GridFS bucket (its `.files` collection is created up front by db-setup).
  const bucketPresent = present.has(`${MEDIA_BUCKET}.files`);
  out.push({
    part: 'database',
    name: 'gridfs-bucket',
    status: bucketPresent ? 'pass' : 'fail',
    detail: bucketPresent
      ? `GridFS bucket '${MEDIA_BUCKET}' present (${MEDIA_BUCKET}.files)`
      : `GridFS bucket '${MEDIA_BUCKET}' absent (${MEDIA_BUCKET}.files not found)`,
  });

  // Validators.
  const missingValidators = VALIDATED_COLLECTIONS.filter((c) => obs.validators[c] !== true);
  out.push({
    part: 'database',
    name: 'validators',
    status: missingValidators.length === 0 ? 'pass' : 'fail',
    detail:
      missingValidators.length === 0
        ? `every collection carries its $jsonSchema validator`
        : `no validator on: ${missingValidators.join(', ')}`,
  });

  // Required unique/partial indexes.
  const indexProblems: string[] = [];
  for (const [collection, names] of Object.entries(REQUIRED_INDEXES)) {
    const have = new Set(obs.indexes[collection] ?? []);
    for (const name of names) {
      if (!have.has(name)) indexProblems.push(`${collection}.${name}`);
    }
  }
  out.push({
    part: 'database',
    name: 'indexes',
    status: indexProblems.length === 0 ? 'pass' : 'fail',
    detail:
      indexProblems.length === 0
        ? 'every required unique/partial index present'
        : `missing index: ${indexProblems.join(', ')}`,
  });

  // Exactly five conditions.
  out.push({
    part: 'database',
    name: 'disease-knowledge-count',
    status: obs.conditionCount === EXPECTED_CONDITION_COUNT ? 'pass' : 'fail',
    detail: `disease_knowledge has ${obs.conditionCount} rows (want exactly ${EXPECTED_CONDITION_COUNT})`,
  });

  // Every condition has a source.
  out.push({
    part: 'database',
    name: 'disease-knowledge-source',
    status: obs.conditionsWithSource === obs.conditionCount ? 'pass' : 'fail',
    detail:
      obs.conditionsWithSource === obs.conditionCount
        ? 'every disease_knowledge row has a non-empty source'
        : `${obs.conditionCount - obs.conditionsWithSource} row(s) have an empty source`,
  });

  return out;
}

/* -------------------------------------------------------------------------- */
/* Part 2 — HTTP unauthenticated-rejection                                    */
/* -------------------------------------------------------------------------- */

function assertRejects401(
  name: string,
  obs: HttpObservation,
  what: string,
): Assertion {
  if (obs.error !== undefined) {
    return { part: 'http', name, status: 'fail', detail: `request failed: ${obs.error}` };
  }
  return {
    part: 'http',
    name,
    status: obs.status === 401 ? 'pass' : 'fail',
    detail:
      obs.status === 401
        ? `${what} → 401 as required`
        : `${what} → ${obs.status ?? 'no response'} (want 401)`,
  };
}

export function assertHttp(obs: {
  telegramNoToken: HttpObservation;
  paymentNoSignature: HttpObservation;
  retentionNoBearer: HttpObservation;
}): Assertion[] {
  return [
    assertRejects401(
      'telegram-no-secret-token',
      obs.telegramNoToken,
      'POST /api/telegram without the secret-token header',
    ),
    assertRejects401(
      'payment-no-signature',
      obs.paymentNoSignature,
      'POST /api/payment/webhook without a valid signature',
    ),
    assertRejects401(
      'retention-no-bearer',
      obs.retentionNoBearer,
      'GET /api/internal/retention-sweep without the CRON_SECRET bearer',
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/* Part 3 — Telegram webhook registration                                     */
/* -------------------------------------------------------------------------- */

export function assertWebhook(obs: WebhookInfoObservation, expectedOrigin: string): Assertion {
  if (obs.error !== undefined) {
    return { part: 'telegram', name: 'webhook-url', status: 'fail', detail: `getWebhookInfo failed: ${obs.error}` };
  }
  const expected = `${expectedOrigin.replace(/\/+$/, '')}${TELEGRAM_WEBHOOK_PATH}`;
  return {
    part: 'telegram',
    name: 'webhook-url',
    status: obs.url === expected ? 'pass' : 'fail',
    detail:
      obs.url === expected
        ? `setWebhook points at ${expected}`
        : `getWebhookInfo reports ${obs.url ?? '(none)'} (want ${expected})`,
  };
}

/* ========================================================================== */
/* Live probes — the only code that touches the network or the database        */
/* ========================================================================== */

/** Read the database facts `assertDatabase` needs. The one place the driver is used for reads. */
export async function probeDatabase(db: Db): Promise<DatabaseObservation> {
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

  const indexes: Record<string, string[]> = {};
  for (const collection of Object.keys(REQUIRED_INDEXES)) {
    if (!collections.includes(collection)) {
      indexes[collection] = [];
      continue;
    }
    const list = await db.collection(collection).indexes();
    indexes[collection] = list.map((i) => String(i.name));
  }

  const validators: Record<string, boolean> = {};
  const withValidator = await db
    .listCollections({}, {})
    .toArray();
  for (const info of withValidator) {
    const options = (info as { options?: { validator?: unknown } }).options;
    validators[info.name] = options?.validator !== undefined && options.validator !== null;
  }

  let conditionCount = 0;
  let conditionsWithSource = 0;
  if (collections.includes('disease_knowledge')) {
    const dk = db.collection('disease_knowledge');
    conditionCount = await dk.countDocuments({});
    conditionsWithSource = await dk.countDocuments({ source: { $type: 'string', $ne: '' } });
  }

  return { collections, indexes, validators, conditionCount, conditionsWithSource };
}

/** POST/GET a route and report only its status code — never its body. */
export async function probeStatus(
  method: 'GET' | 'POST',
  url: string,
  init?: RequestInit,
): Promise<HttpObservation> {
  try {
    const response = await fetch(url, { method, ...init });
    return { status: response.status };
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Ask Telegram what URL it has registered, via `getWebhookInfo`. The bot token is never printed. */
export async function probeWebhookInfo(botToken: string): Promise<WebhookInfoObservation> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
    const body = (await response.json()) as { ok?: boolean; result?: { url?: string } };
    if (body.ok !== true) return { url: null, error: 'Telegram returned ok=false' };
    return { url: body.result?.url ?? '' };
  } catch (error) {
    return { url: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/* ========================================================================== */
/* The run                                                                     */
/* ========================================================================== */

export interface RunInputs {
  readonly mongoUri: string | undefined;
  readonly origin: string | undefined;
  readonly botToken: string | undefined;
}

export interface RunResult {
  readonly assertions: readonly Assertion[];
  readonly skips: readonly { readonly part: string; readonly reason: string }[];
}

/**
 * Read the operator inputs from the environment and the first CLI argument. `process.env` is read
 * directly (this script cannot use `src/lib/env.ts` — see the header). `MONGODB_URI`, the origin,
 * and `TELEGRAM_BOT_TOKEN` are all optional here: an absent one skips its part with a reason.
 */
export function readInputs(argv: readonly string[], env: NodeJS.ProcessEnv): RunInputs {
  const origin = argv[2]?.trim();
  return {
    mongoUri: nonEmpty(env.MONGODB_URI),
    origin: origin !== undefined && origin !== '' ? origin : undefined,
    botToken: nonEmpty(env.TELEGRAM_BOT_TOKEN),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Run the parts whose inputs are present, skip the rest with a stated reason. The probes are
 * injected so the test can drive the assertions with fixtures and no live services.
 */
export async function run(
  inputs: RunInputs,
  probes: {
    database?: (uri: string) => Promise<DatabaseObservation>;
    http?: (origin: string) => Promise<{
      telegramNoToken: HttpObservation;
      paymentNoSignature: HttpObservation;
      retentionNoBearer: HttpObservation;
    }>;
    webhook?: (botToken: string) => Promise<WebhookInfoObservation>;
  },
): Promise<RunResult> {
  const assertions: Assertion[] = [];
  const skips: { part: string; reason: string }[] = [];

  if (inputs.mongoUri !== undefined && probes.database) {
    assertions.push(...assertDatabase(await probes.database(inputs.mongoUri)));
  } else {
    skips.push({ part: 'database', reason: 'MONGODB_URI is not set' });
  }

  if (inputs.origin !== undefined && probes.http) {
    assertions.push(...assertHttp(await probes.http(inputs.origin)));
  } else {
    skips.push({ part: 'http', reason: 'no deployed https origin given as the first argument' });
  }

  if (inputs.origin !== undefined && inputs.botToken !== undefined && probes.webhook) {
    assertions.push(assertWebhook(await probes.webhook(inputs.botToken), inputs.origin));
  } else {
    skips.push({
      part: 'telegram',
      reason:
        inputs.botToken === undefined
          ? 'TELEGRAM_BOT_TOKEN is not set'
          : 'no deployed https origin given as the first argument',
    });
  }

  return { assertions, skips };
}

export function formatReport(inputs: RunInputs, result: RunResult): string {
  const lines: string[] = [];
  lines.push('check-deployment — MongoDB Atlas + GridFS + Telegram/Razorpay (Amendment A3)');
  lines.push('');
  lines.push('CONFIGURATION (value never printed, only presence):');
  lines.push(`  MONGODB_URI:         ${inputs.mongoUri !== undefined ? 'set' : 'absent'}`);
  lines.push(`  deployed origin arg: ${inputs.origin !== undefined ? 'set' : 'absent'}`);
  lines.push(`  TELEGRAM_BOT_TOKEN:  ${inputs.botToken !== undefined ? 'set' : 'absent'}`);
  lines.push('');

  for (const skip of result.skips) {
    lines.push(`  SKIP  [${skip.part}] ${skip.reason}`);
  }
  if (result.skips.length > 0) lines.push('');

  for (const a of result.assertions) {
    const tag = a.status === 'pass' ? 'PASS' : 'FAIL';
    lines.push(`  ${tag}  [${a.part}] ${a.name}: ${a.detail}`);
  }
  lines.push('');

  lines.push('LIMITS OF THIS CHECK');
  lines.push('  - A validator being present is not proof it rejects every malformed document;');
  lines.push('    the integration suite proves that.');
  lines.push('  - A 401 proves a route rejects THAT unauthenticated shape, not that every');
  lines.push('    authenticated shape is handled.');
  lines.push('  - getWebhookInfo reports the URL Telegram was told, which is what this asserts.');
  lines.push('  - Every answer is a point-in-time snapshot of a live deployment.');
  lines.push('  - A part whose input is absent is SKIPPED, not passed — see the SKIP lines above.');
  lines.push('');

  const failed = result.assertions.filter((a) => a.status === 'fail');
  lines.push(failed.length === 0 ? 'PASS' : `FAIL — ${failed.length} failed assertion(s)`);
  return lines.join('\n');
}

/** The process exits 1 on any failed assertion. A skip alone does not fail the run. */
export function exitCode(result: RunResult): number {
  return result.assertions.some((a) => a.status === 'fail') ? 1 : 0;
}

async function main(): Promise<void> {
  const inputs = readInputs(process.argv, process.env);

  const result = await run(inputs, {
    database: async (uri) => {
      const client = new MongoClient(uri);
      try {
        await client.connect();
        return await probeDatabase(client.db(DATABASE_NAME));
      } finally {
        await client.close();
      }
    },
    http: async (origin) => {
      const base = origin.replace(/\/+$/, '');
      return {
        telegramNoToken: await probeStatus('POST', `${base}${TELEGRAM_WEBHOOK_PATH}`, {
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        paymentNoSignature: await probeStatus('POST', `${base}${PAYMENT_WEBHOOK_PATH}`, {
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        retentionNoBearer: await probeStatus('GET', `${base}${RETENTION_SWEEP_PATH}`),
      };
    },
    webhook: (botToken) => probeWebhookInfo(botToken),
  });

  process.stdout.write(`${formatReport(inputs, result)}\n`);
  process.exit(exitCode(result));
}

/** Run only as a script, never on import (the test imports the pure functions above). */
const invokedAsScript = (() => {
  const entry = process.argv[1];
  return entry !== undefined && entry.replace(/\\/g, '/').endsWith('check-deployment.ts');
})();

if (invokedAsScript) {
  void main();
}
