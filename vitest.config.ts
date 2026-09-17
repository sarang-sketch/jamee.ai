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
 *   npm run test:integration  real Postgres; skipped when JAMEE_TEST_DATABASE_URL is absent
 *
 * `npm run test` runs all three. The integration project is *gated, not failed*, when no
 * database URL is present — see tests/integration/database.ts.
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
          // Real Postgres round trips, and these run serially against one database.
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
