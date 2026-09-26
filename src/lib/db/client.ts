import 'server-only';

import { MongoClient, type Db } from 'mongodb';

import { serverEnv } from '@/lib/env';

/**
 * The single holder of the MongoDB connection — one cached `MongoClient`, one `getDb()`.
 *
 * Requirements: 13.7 (the MongoDB connection credential lives only in server-side modules within
 *               the Data_Access_Layer, and is excluded from every value sent to the browser)
 * Design: D18 (the Data_Access_Layer is the only holder of the driver and the raw handle),
 *         D19 (one `MongoClient` cached on `globalThis` so serverless invocations reuse the pool
 *         within the M0 connection limit); V28 (the driver), V32 (the M0 500-connection cap that
 *         makes the caching load-bearing)
 *
 * =============================================================================
 * WHY THIS MODULE IS `server-only` AND WHY NOTHING ELSE IMPORTS THE DRIVER
 * =============================================================================
 *
 * `import 'server-only'` on line 1 makes importing this module from a `'use client'` component a
 * build error — the same guard `src/lib/env.ts` uses for `serverEnv`. `MONGODB_URI` is the only
 * database credential (there is no service-role key, because there is no RLS to bypass — tenant
 * isolation is the Data_Access_Layer, D18), so a client bundle that could reach this module could
 * leak the credential, which is exactly what Requirement 13.7 forbids.
 *
 * This file, and its siblings under `src/lib/db/**`, are the ONLY code in the repository that
 * imports the `mongodb` driver or touches the raw `Db`/`MongoClient` handle. `scripts/check-data-
 * access.ts` (task 52.3) fails the build if any module outside `src/lib/db/**` imports `mongodb`
 * or this module — turning "isolation is application-enforced" (D18) into a module boundary a
 * static check proves rather than a rule reviewers must remember.
 *
 * =============================================================================
 * WHY ONE CLIENT IS CACHED ON `globalThis`
 * =============================================================================
 *
 * A serverless function is created and torn down per request family, but a warm invocation reuses
 * the module scope of the previous one. A `MongoClient` constructed at module load would still be
 * recreated whenever the module is re-evaluated (a hot reload in dev, a new isolate in prod), and
 * every recreation opens a fresh connection pool. Atlas M0 caps concurrent connections at 500
 * (V32), so leaking a pool per invocation is not a micro-optimisation to skip — it is the
 * difference between staying inside the cap and exhausting it at the 6-farmer scale.
 *
 * So the client is stashed on `globalThis` under a unique symbol and reused across every
 * re-evaluation that shares the same global. `MongoClient.connect()` is lazy about the actual
 * TCP work, and the driver's own pooling means one client is the correct shape to share — the
 * `client` handle is also what the auth library's MongoDB adapter needs to enable transactions
 * (V30, V33), and what the linking and payment services open sessions from (D19).
 */

/** The database name Jamee's collections live in. The URI may also carry a default db; this wins. */
export const DATABASE_NAME = 'jamee';

/**
 * A unique global slot. A plain string key on `globalThis` risks colliding with another library's
 * cache; a `Symbol.for` keyed on a Jamee-specific string is unique to this module across every
 * re-evaluation that shares the realm, which is exactly the reuse we want.
 */
const CLIENT_CACHE_KEY = Symbol.for('jamee.mongo.client');

interface GlobalWithMongo {
  [CLIENT_CACHE_KEY]?: MongoClient;
}

const globalForMongo = globalThis as unknown as GlobalWithMongo;

/**
 * The one `MongoClient`, created on first use and reused thereafter.
 *
 * `new MongoClient(uri)` does not open a socket; the pool connects lazily on the first operation,
 * so constructing the client here is cheap and safe to do at first `getDb()`/`getMongoClient()`.
 * Reads `MONGODB_URI` through `serverEnv`, which throws with the variable's name when it is absent
 * — the fail-loud rule, so a missing credential is a named startup error rather than a silent
 * connect-to-nothing.
 */
function client(): MongoClient {
  const cached = globalForMongo[CLIENT_CACHE_KEY];
  if (cached !== undefined) return cached;

  const created = new MongoClient(serverEnv('MONGODB_URI'));
  globalForMongo[CLIENT_CACHE_KEY] = created;
  return created;
}

/**
 * The cached `MongoClient`.
 *
 * Exposed for the two things that legitimately need the client rather than a database handle: the
 * auth library's MongoDB adapter (`mongodbAdapter(db, { client })`, which needs the client to
 * enable transactions — V30, V33) and the session-bearing helpers that run the linking consume-
 * and-bind and the payment grant inside a multi-document transaction (D19). Ordinary reads and
 * writes take `getDb()` instead.
 */
export function getMongoClient(): MongoClient {
  return client();
}

/**
 * The `jamee` database handle.
 *
 * This is the handle the owner-scoped accessors and the GridFS bucket are built on. It is derived
 * from the cached client, so it reuses the same pool.
 */
export function getDb(): Db {
  return client().db(DATABASE_NAME);
}
