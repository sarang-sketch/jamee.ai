import { describe, expect, it } from 'vitest';

import { config } from '@/proxy';

import {
  PROTECTED_SCREEN_PATHS,
  SIGN_IN_PATH,
  isProtectedScreenPath,
} from './protected-paths';

/**
 * Unit tests for the screen half of the auth gate: which paths it covers, and — through the
 * Proxy's own matcher — which paths it is even asked about.
 *
 * Requirements: 1.6 (the diagnosis, chat, voice and history screens are restricted without a
 *               session), 1.7 (the API surface answers with 401 instead, so the Proxy must not
 *               redirect it)
 * Design: "Frontend"; "Security boundary"
 *
 * The Proxy function itself is not exercised here. Driving it would mean standing up a Supabase
 * client, a cookie jar and an Auth response — three mocks deep, testing the mocks rather than the
 * gate. What *is* testable without any of that is the pair of decisions the Proxy delegates: the
 * matcher regex (does this request reach the Proxy at all) and the path predicate (once here, is
 * this path gated). Task 29.1's harness is where a real unauthenticated request to `/history`
 * belongs.
 */

/* ========================================================================== */
/* The predicate                                                               */
/* ========================================================================== */

describe('isProtectedScreenPath', () => {
  it("gates each of Requirement 1.6's four screens", () => {
    expect(isProtectedScreenPath('/diagnose')).toBe(true);
    expect(isProtectedScreenPath('/chat')).toBe(true);
    expect(isProtectedScreenPath('/voice')).toBe(true);
    expect(isProtectedScreenPath('/history')).toBe(true);
  });

  it('gates the same data reached by another URL', () => {
    /** The detail view of one diagnosis (Requirement 12.3) and the profile screen (1.8). */
    expect(isProtectedScreenPath('/diagnosis/8f14e45f-ceea-467a-a3f3-4c9e2c0b9e11')).toBe(true);
    expect(isProtectedScreenPath('/profile')).toBe(true);
  });

  it('leaves the sign-in screen open, or a gated visitor would have nowhere to land', () => {
    expect(isProtectedScreenPath(SIGN_IN_PATH)).toBe(false);
    expect(isProtectedScreenPath('/')).toBe(false);
  });

  it('does not gate the Better Auth callback, since it is what establishes the session', () => {
    /**
     * Better Auth's OAuth callback is `/api/auth/callback/google` (task A1/A3). It lives under
     * `/api/**`, so it is not a protected screen path — the API half of the gate governs it, and a
     * visitor mid-sign-in must be able to reach it without a session.
     */
    expect(isProtectedScreenPath('/api/auth/callback/google')).toBe(false);
  });

  it('does not claim the API surface', () => {
    /**
     * Requirement 1.7 wants HTTP 401 with the `AUTH_REQUIRED` envelope on these paths, not a
     * redirect to an HTML page. `lib/api/authenticated-route.ts` owns them.
     */
    expect(isProtectedScreenPath('/api/diagnose')).toBe(false);
    expect(isProtectedScreenPath('/api/chat')).toBe(false);
    expect(isProtectedScreenPath('/api/voice')).toBe(false);
    expect(isProtectedScreenPath('/api/telegram')).toBe(false);
  });

  it('matches on whole segments rather than raw prefixes', () => {
    expect(isProtectedScreenPath('/diagnose-later')).toBe(false);
    expect(isProtectedScreenPath('/chatter')).toBe(false);
    expect(isProtectedScreenPath('/voices')).toBe(false);
  });

  it('is not fooled by a trailing slash', () => {
    expect(isProtectedScreenPath('/history/')).toBe(true);
    expect(isProtectedScreenPath('/diagnose//')).toBe(true);
  });
});

/* ========================================================================== */
/* The matcher                                                                 */
/* ========================================================================== */

/**
 * The Proxy only sees what its matcher admits, so a gated path the matcher excludes is not gated
 * at all — and the matcher has to stay a literal in `proxy.ts` because Next reads it statically at
 * build time, which puts it out of reach of the list above.
 *
 * So this anchors the pattern as a plain `RegExp` and asks it about the paths that matter. That is
 * a reconstruction, not the framework's own compilation: `next@16.3.5` runs the same source through
 * `path-to-regexp`, which escapes the separators and matches case-insensitively. Checked against
 * the pinned build for every path asserted below — same answers — so what these tests pin is the
 * pattern's intent, and a change that inverted any line here would be a real change.
 */
describe('proxy matcher', () => {
  const patterns = config.matcher.map((source) => new RegExp(`^${source}$`));

  function matched(pathname: string): boolean {
    return patterns.some((pattern) => pattern.test(pathname));
  }

  it('admits every protected screen, so the gate can act on it', () => {
    for (const path of PROTECTED_SCREEN_PATHS) {
      expect(matched(path)).toBe(true);
    }
    expect(matched('/diagnosis/8f14e45f-ceea-467a-a3f3-4c9e2c0b9e11')).toBe(true);
  });

  it('admits the unprotected landing page too, because that is where a session gets refreshed', () => {
    /**
     * V1's reason for the Proxy existing: a Server Component render cannot write a rotated
     * session cookie, so the Better Auth session refresh has to happen in front of `/` as well.
     */
    expect(matched('/')).toBe(true);
  });

  it('excludes the API surface, so exactly one half of the gate answers a given request', () => {
    expect(matched('/api/diagnose')).toBe(false);
    expect(matched('/api/telegram')).toBe(false);
    // Better Auth's OAuth callback lives under /api/auth/**, so the Proxy never sees it.
    expect(matched('/api/auth/callback/google')).toBe(false);
  });

  it('excludes framework assets and static files', () => {
    expect(matched('/_next/static/chunks/main.js')).toBe(false);
    expect(matched('/_next/image')).toBe(false);
    expect(matched('/favicon.ico')).toBe(false);
    expect(matched('/leaf.png')).toBe(false);
    expect(matched('/fonts/devanagari.woff2')).toBe(false);
  });
});
