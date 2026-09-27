/**
 * The protected screen surface, as data, plus the one predicate over it.
 *
 * Requirements: 1.6 (while a visitor holds no authenticated session, access to the diagnosis,
 *               chat, voice, and history screens is restricted and the sign-in screen is
 *               presented instead)
 * Design: "Frontend" — screens and component boundaries; "Security boundary" — defence in depth
 *
 * ### Why the list lives here and not in the Proxy
 *
 * `src/proxy.ts` is a Next.js convention file: its export surface is `proxy` plus `config`, so
 * anything exported from it for a test to read would be a export the framework does not expect.
 * Keeping the list and the predicate in a module with **no imports at all** also means the whole
 * decision is unit-testable without a request, a cookie store, or an auth client — see
 * `protected-paths.test.ts`.
 *
 * ### Why a list rather than a check inside each page
 *
 * Most of the screens named below do not exist yet (tasks 12.2, 13.1, 16.1, 19.2 own them). A
 * per-page `if (userId === null) redirect('/')` would make the gate a **convention** those tasks
 * have to remember, and Requirement 1.6 would then be satisfied only for as long as everyone
 * remembers it. One list, read by one Proxy that runs before any of those pages render, makes the
 * gate something those pages inherit whether or not their authors know it exists.
 */

/**
 * Where a gated visitor lands. `/` renders the sign-in screen (task 6.1), which is what
 * Requirement 1.6's "present the sign-in screen instead" means concretely.
 *
 * Better Auth establishes the profile in its own bootstrap (`src/lib/auth/bootstrap.ts`) rather
 * than in an app-route callback, so no module under `src/app/**` re-declares this constant. Even
 * if one did, it would not be imported here: `src/lib/**` never imports from `src/app/**` (design,
 * project structure), and that rule is worth more than deduplicating the string `'/'`.
 */
export const SIGN_IN_PATH = '/login';

/**
 * Every screen that requires a server-confirmed session. `/app` covers the new unified workspace
 * and all nested conversation, history, connect, and profile routes; the legacy screens remain
 * protected for backward-compatible bookmarks.
 */
export const PROTECTED_SCREEN_PATHS = [
  '/app',
  '/diagnose',
  '/diagnosis',
  '/chat',
  '/voice',
  '/history',
  '/profile',
] as const;

export type ProtectedScreenPath = (typeof PROTECTED_SCREEN_PATHS)[number];

/**
 * Trailing slashes carry no meaning here. Next normalizes `/history/` to `/history` for the
 * *route*, but the Proxy sees the path as requested — so the predicate normalizes rather than
 * letting `/history/` slip past a gate `/history` is behind.
 */
function normalize(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Whether this pathname is part of the protected screen surface.
 *
 * Prefix matching is bounded at a segment: `/diagnosis/abc` is inside `/diagnosis`, while
 * `/diagnose-later` is a different path and is **not** gated by `/diagnose`. Matching on a raw
 * `startsWith` would silently gate paths nobody listed, which is the kind of over-reach that gets
 * a gate loosened later.
 */
export function isProtectedScreenPath(pathname: string): boolean {
  const path = normalize(pathname);
  return PROTECTED_SCREEN_PATHS.some(
    (protectedPath) => path === protectedPath || path.startsWith(`${protectedPath}/`),
  );
}
