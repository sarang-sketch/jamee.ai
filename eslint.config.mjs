import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

/**
 * Flat config built on eslint-config-next: the Next.js rules plus core-web-vitals, then
 * the TypeScript rule set.
 *
 * Requirement 17.8 lives in `npm run typecheck` / `next build`, not here — ESLint is the
 * style and correctness net on top of it, and `next.config.ts` deliberately does not
 * suppress either.
 *
 * Two toolchain pins are forced by this config, both verified by running the commands:
 *
 * - `typescript` is on the 6.0.x line, not 7.x. eslint-config-next parses TypeScript via
 *   typescript-eslint, whose peer range is `typescript >=4.8.4 <6.1.0`; under TS 7 it
 *   exits with "typescript-eslint does not support TS 7.0". 6.0.x is the newest release
 *   that `next build`, `tsc --noEmit`, and `eslint` all accept at once.
 * - `eslint` is on 9.x, not 10.x. eslint-config-next depends on eslint-plugin-react
 *   ^7.37.0, whose newest release (7.37.5) declares `eslint: ... || ^9.7` and calls the
 *   context APIs ESLint 10 removed ("contextOrFilename.getFilename is not a function").
 *
 * Revisit both pins when eslint-config-next ships support for TS 7 / ESLint 10.
 */
const config = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    ignores: [
      '.next/**',
      'out/**',
      'build/**',
      'coverage/**',
      'node_modules/**',
      'next-env.d.ts',
    ],
  },
];

export default config;
