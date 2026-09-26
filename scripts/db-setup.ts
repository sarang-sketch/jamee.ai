/**
 * `db-setup` — the `npm run db:setup` entry point. Connects with `MONGODB_URI`, runs the idempotent
 * collection/validator/index/GridFS/seed setup, and exits.
 *
 * Requirements: 4.1, 4.2 (seed the five conditions), 13.1, 13.3, 13.4, 13.9, 14.1-14.3, 17.6,
 *               21.7, 21.16, 22.11, 22.12
 * Design: "Data model and collection setup" (A3 replaces the 14 SQL migrations with this one
 *         idempotent script), D17, D18, D19; V28
 *
 * Run it:  `npm run db:setup`   (node --experimental-strip-types scripts/db-setup.ts)
 *
 * =============================================================================
 * WHY THE SETUP LOGIC LIVES IN A MODULE UNDER src/lib/db AND THIS FILE ONLY CALLS IT
 * =============================================================================
 *
 * Task 53 requires the collection/index setup to be a function a test can call against an in-memory
 * server. So the whole of it is `setupDatabase(db)` in `src/lib/db/setup.ts`, and this script does
 * exactly two things the function cannot: it reads `MONGODB_URI` and builds the `MongoClient`
 * (`setup.ts` is deliberately free of the `server-only` client so it stays importable both here,
 * under bare `node --experimental-strip-types`, and in vitest), and it owns process lifecycle
 * (connect, run, close, exit-code). `setup.ts` imports only `mongodb` and the dependency-free
 * `src/lib/db/names.ts` — no `@/` alias and no `server-only` — which is what lets this node-run
 * script import it by a relative path. This script is on `scripts/check-data-access.ts`'s allowlist
 * for that reason: it legitimately holds the driver (D18).
 *
 * Idempotent by construction (see `setup.ts`): safe to re-run after a partial failure, which is
 * what `docs/DEPLOYMENT.md` tells an operator to do.
 */

import { MongoClient } from 'mongodb';

/**
 * The setup logic lives in `src/lib/db/setup.ts`. It is imported by a COMPUTED specifier rather than
 * a literal one on purpose: `node --experimental-strip-types` requires the explicit `.ts` extension
 * to resolve a TypeScript file, but `tsc` rejects a literal `.ts` import path unless
 * `allowImportingTsExtensions` is set (and this script must not force a tsconfig change). A computed
 * specifier is not statically resolved by `tsc`, so it typechecks, while node resolves it at
 * runtime. `setupDatabase` is therefore `any` here — acceptable for a thin lifecycle script whose
 * real logic and types live in the imported module.
 */
const SETUP_MODULE = '../src/lib/db/setup.ts';

const DATABASE_NAME = 'jamee';

function requireMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || uri.trim() === '') {
    throw new Error(
      'MONGODB_URI is not set. Set it to your Atlas connection string (Atlas -> Connect -> Drivers), ' +
        'including the database name. See .env.example and docs/DEPLOYMENT.md.',
    );
  }
  return uri;
}

async function main(): Promise<void> {
  const { setupDatabase } = (await import(SETUP_MODULE)) as {
    setupDatabase: (db: unknown) => Promise<{ collections: string[]; gridfsBucket: string; seededConditions: number }>;
  };
  const client = new MongoClient(requireMongoUri());
  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const result = await setupDatabase(db);

    process.stdout.write('db:setup complete\n');
    process.stdout.write(`  database:   ${DATABASE_NAME}\n`);
    process.stdout.write(`  collections: ${result.collections.length} (${result.collections.join(', ')})\n`);
    process.stdout.write(`  GridFS bucket: ${result.gridfsBucket}\n`);
    process.stdout.write(`  seeded conditions: ${result.seededConditions}\n`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`db:setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
