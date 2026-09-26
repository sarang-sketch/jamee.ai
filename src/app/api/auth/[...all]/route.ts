import { toNextJsHandler } from 'better-auth/next-js';

import { getAuth } from '@/lib/auth/auth';

/**
 * The Better Auth catch-all handler — Google sign-in, the OAuth callback, sign-out, session.
 *
 * Requirements: 1.1 (start Google authentication), 1.2 (establish the session on a successful
 *               callback at `/api/auth/callback/google`)
 * Design: D8, D18a; V30 (the `app/api/auth/[...all]/route.ts` shape and `toNextJsHandler(auth)`)
 *
 * =============================================================================
 * WHY THE HANDLER IS BUILT AT REQUEST TIME, NOT AT IMPORT
 * =============================================================================
 *
 * `toNextJsHandler` takes the auth instance and returns `{ GET, POST }`. Building it as
 * `export const { GET, POST } = toNextJsHandler(getAuth())` at module scope would call `getAuth()`
 * — and therefore `betterAuth({...})`, which reads secrets through `serverEnv` — during `next
 * build`, where the secrets are legitimately absent. So the exported `GET`/`POST` are thin
 * functions that call `toNextJsHandler(getAuth())` only when a request arrives. `getAuth()` caches
 * the instance, so this is one construction per isolate, not one per request.
 *
 * The bundled Next.js Route Handlers guide (`node_modules/next/dist/docs/01-app/01-getting-started/
 * 15-route-handlers.md`) confirms the shape: route handlers use the Web `Request`/`Response` APIs,
 * are exported by HTTP method, and are NOT cached by default — so no `dynamic`/`force-static` is
 * needed here, and Better Auth's own reads (`headers()`, cookies) keep it request-time anyway.
 */

export async function GET(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth()).POST(request);
}
