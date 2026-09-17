import type { NextConfig } from 'next';

/**
 * Minimal by design.
 *
 * Requirement 17.8: the codebase must compile under TypeScript strict mode with no type
 * errors, which means a type error has to FAIL the build. Do not add
 * `typescript.ignoreBuildErrors` or `eslint.ignoreDuringBuilds` here — their absence is
 * the mechanism that makes 17.8 enforceable rather than aspirational.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
