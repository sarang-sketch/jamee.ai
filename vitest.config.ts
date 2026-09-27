import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

/**
 * `server-only` is not a standalone dependency — Next.js aliases the bare specifier onto its own
 * compiled copy, whose `react-server` export condition is a no-op (`empty.js`). Vite has no such
 * alias, so a test importing any `import 'server-only'` module fails to resolve rather than failing
 * a test. Pointing at the same `empty.js` gives a unit test exactly the semantics the server build
 * has: the marker imports, and the guard stays a build-time guard for client components. Without
 * this, every `server-only` module in `src/lib` would be untestable, which would push logic out of
 * those modules for a tooling reason rather than a design one.
 */
const serverOnlyStub = fileURLToPath(
  new URL('./node_modules/next/dist/compiled/server-only/empty.js', import.meta.url),
);

/**
 * Three named projects so each layer of the testing strategy runs on its own:
 *
 *   npm run test:unit         fast, no I/O — schemas, catalogs, pure helpers, components
 *   npm run test:property     fast-check properties (providers stubbed at the adapter seam)
 *   npm run test:integration  real MongoDB via mongodb-memory-server in replica-set mode (V31)
 *
 * `npm run test` runs all three. Under Amendment A3 the integration project no longer gates on a
 * `JAMEE_TEST_DATABASE_URL`/local-Supabase stack and no longer self-skips: it starts an in-memory
 * replica set (needed for the link and payment multi-document transactions, V33), and a failed
 * start fails the run loudly — a run that executed zero integration tests is a broken gate, not a
 * pass (see tests/integration/mongo.ts).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': srcDir,
      'server-only': serverOnlyStub,
    },
  },
  test: {
    // Zero test files in a project is not a failure — projects fill up over later tasks.
    passWithNoTests: true,
    // Each integration file spins up its OWN `MongoMemoryReplSet` (a real MongoDB child process).
    // Twenty of them started and stopped inside ONE long-lived worker fork accumulated native
    // handles until the fork faulted (Windows 0xC0000409). `forks` with isolation gives each test
    // FILE a fresh child process, so its replica set — and every handle the driver held — is
    // reclaimed with the fork before the next file starts. Set at the root so `extends: true`
    // merges it into every project (unit/property already run cleanly under forks); the per-project
    // `test` config type does not accept `pool`, so this is its correct home.
    pool: 'forks',
    isolate: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['tests/unit/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'property',
          environment: 'node',
          include: ['tests/property/**/*.test.ts'],
          // Property runs do 100+ iterations per case; give them room.
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          // Real MongoDB round trips against a single-node `MongoMemoryReplSet` (Amendment A3, V31),
          // run serially against one in-memory server per file.
          testTimeout: 30_000,
          // The harness `beforeAll` starts a replica set, runs `setupDatabase`, and creates two
          // farmers; the first run may also download the MongoDB binary. The default 10s hook
          // timeout is too tight for that, so give hooks the same 120s the per-file `beforeAll`
          // callbacks request explicitly (a belt-and-braces floor for any that forget).
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
