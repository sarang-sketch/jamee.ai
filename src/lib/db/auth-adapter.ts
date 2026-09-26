import 'server-only';

import { mongodbAdapter } from '@better-auth/mongo-adapter';

import { getDb, getMongoClient } from '@/lib/db/client';

/**
 * The Better Auth MongoDB adapter, built inside the Data_Access_Layer.
 *
 * Requirements: 1.1, 1.2 (Google sign-in and session establishment run through this library and
 *               its records live in MongoDB), 13.7 (the `mongodb` driver and the raw handle are
 *               held only under `src/lib/db/**`)
 * Design: D18 (the Data_Access_Layer is the only holder of the driver — this module lives here,
 *         NOT under `src/lib/auth/**`, precisely so that `scripts/check-data-access.ts` still
 *         passes: the auth config in `src/lib/auth/auth.ts` imports THIS, and never `mongodb`),
 *         D18a (the chosen library is Better Auth 1.7.6), D19 (passing the `MongoClient` ENABLES
 *         transactions); V28 (the driver), V30 (`mongodbAdapter(db, { client })`), V33 (M0 is a
 *         replica set, so transactions are available)
 *
 * =============================================================================
 * WHY THE ADAPTER IS BUILT HERE AND NOT IN `src/lib/auth/auth.ts`
 * =============================================================================
 *
 * `mongodbAdapter` takes a `Db` and, to enable transactions, a `MongoClient` (V30). Both of those
 * come from `@/lib/db/client`, which is `server-only` and — by D18 — importable only from within
 * `src/lib/db/**`. `scripts/check-data-access.ts` (task 52.3) fails the build if any module
 * outside `src/lib/db/**` imports the `mongodb` driver or the raw handle. `getDb()` /
 * `getMongoClient()` return driver types, so the module that calls them is, in the check's eyes, a
 * driver holder — and the only place that is allowed to be is here. So the auth *config* in
 * `src/lib/auth/auth.ts` imports THIS factory, which hands it a ready adapter, and never touches
 * `getDb`, `getMongoClient`, or `mongodb` itself.
 *
 * =============================================================================
 * WHY THE `client` ARGUMENT IS LOAD-BEARING
 * =============================================================================
 *
 * `@better-auth/mongo-adapter`'s own types say it plainly: "If not provided, Database transactions
 * won't be enabled", and `transaction` "Defaults to `true` when a MongoDB client is provided."
 * Jamee's linking consume-and-bind and payment grant-plus-extend both span two documents and run
 * inside a multi-document transaction (D19), and Atlas M0 is a three-node replica set that
 * supports them (V32, V33). Passing the cached `MongoClient` here is what lets the auth library's
 * own multi-document writes take part in that same transactional capability rather than silently
 * falling back to non-transactional writes.
 *
 * Better Auth manages its own `user`, `session`, `account`, and `verification` collections through
 * this adapter and needs no schema migration (V30) — so those collections are NOT declared in
 * `scripts/db-setup.ts`; the library owns them.
 */

/**
 * Build the Better Auth database adapter over the cached `MongoClient` and `jamee` database.
 *
 * Returns the adapter factory Better Auth's `database` option expects. Called lazily from
 * `getAuth()` (see `src/lib/auth/auth.ts`), so constructing it never forces a connection at import
 * or build time — the driver connects on first use, exactly as `getDb()` documents.
 */
export function authDatabaseAdapter(): ReturnType<typeof mongodbAdapter> {
  return mongodbAdapter(getDb(), { client: getMongoClient() });
}
