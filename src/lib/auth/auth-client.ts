'use client';

import { createAuthClient } from 'better-auth/react';

/**
 * The browser-side Better Auth client.
 *
 * Requirements: 1.1 (the Google sign-in control starts authentication through the library)
 * Design: D8, D18a; V30 (`createAuthClient` from `better-auth/react`, `signIn.social`)
 *
 * `createAuthClient()` with no `baseURL` uses the current origin, which is what a same-origin
 * Next.js app wants — the client talks to `/api/auth/**`, the catch-all handler. It is a client
 * module (`'use client'`) because `authClient.signIn.social(...)` runs in the browser from
 * `GoogleSignInButton`; nothing server-side imports it (server code reads sessions through
 * `src/lib/auth/session.ts` instead).
 *
 * This carries NO secret: the Google client id/secret and the Better Auth secret are all
 * server-only (they live in `getAuth()` behind `serverEnv`), and the browser client only ever
 * initiates a redirect flow and reads its own session cookie.
 */
export const authClient = createAuthClient();
