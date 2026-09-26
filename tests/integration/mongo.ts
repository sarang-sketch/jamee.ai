import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * The in-memory MongoDB harness for integration tests — one `MongoMemoryReplSet` per test file,
 * started before the file's tests and stopped after.
 *
 * Design: Testing strategy under Amendment A3; V31 (`mongodb-memory-server` in replica-set mode),
 *         V33 (transactions need a replica set)
 *
 * =============================================================================
 * WHY A REPLICA SET, NOT A PLAIN SERVER
 * =============================================================================
 *
 * The linking consume-and-bind and the payment grant-plus-extend run inside multi-document
 * transactions (D19), and MongoDB transactions require a replica set (V33). A single-node
 * `MongoMemoryReplSet` (`replSet: { count: 1 }`) is enough — it is a replica set, so `withTransaction`
 * works, and one node keeps startup cheap. `mongodb-memory-server` downloads a real MongoDB binary
 * on first run and caches it (V31); the download is a one-time cost, not per test.
 *
 * =============================================================================
 * WHY A FAILED DOWNLOAD IS REPORTED, NEVER SKIPPED
 * =============================================================================
 *
 * The Supabase integration harness gated itself on an env var and self-skipped when absent, and the
 * plan calls a self-skipping suite a *broken gate* — a run that executed zero tests read as green.
 * This harness does not gate: it always tries to start the server. If the first-run binary download
 * fails or times out (no network in CI, a blocked mirror), `start()` throws, and `startMongo()`
 * rethrows with an explicit message saying the download failed — so the suite goes RED with a clear
 * reason rather than quietly reporting a pass it never earned. Task 53.5 requires exactly this.
 */

export interface MongoHarness {
  readonly replSet: MongoMemoryReplSet;
  readonly client: MongoClient;
  readonly db: Db;
}

/** The database name the app uses, so tests exercise the same handle production does. */
export const TEST_DATABASE_NAME = 'jamee';

/**
 * Start one single-node replica set and connect a client to it. Throws with an explicit,
 * actionable message if the binary download fails or times out — the run must fail loudly, not skip.
 */
export async function startMongo(): Promise<MongoHarness> {
  let replSet: MongoMemoryReplSet;
  try {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      'mongodb-memory-server could not start its replica set. The first run downloads a MongoDB ' +
        'binary; if the download failed or timed out (no network, a blocked mirror, or a slow ' +
        'connection), that is the cause. This is reported rather than skipped so the integration ' +
        `gate stays honest (V31). Underlying error: ${detail}`,
    );
  }

  const uri = replSet.getUri();
  const client = new MongoClient(uri);
  try {
    await client.connect();
  } catch (error) {
    await replSet.stop().catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not connect to the in-memory replica set at ${uri}. ${detail}`);
  }

  return { replSet, client, db: client.db(TEST_DATABASE_NAME) };
}

/** Stop the client and the replica set. Safe to call in an `afterAll` even if start partially failed. */
export async function stopMongo(harness: MongoHarness | undefined): Promise<void> {
  if (harness === undefined) return;
  await harness.client.close().catch(() => undefined);
  await harness.replSet.stop().catch(() => undefined);
}

/** Drop every non-system collection so each test file (or test) starts from a known-empty database. */
export async function clearDatabase(db: Db): Promise<void> {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of collections) {
    if (name.startsWith('system.')) continue;
    await db.collection(name).deleteMany({});
  }
}
