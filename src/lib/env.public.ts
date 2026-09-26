/**
 * The public environment variables, readable from the browser AND the server.
 *
 * Requirements: 13.7 (only `NEXT_PUBLIC_`-prefixed values reach the browser)
 * Depends on: V24 (the Telegram bot username), V27 (the Razorpay checkout key id)
 *
 * ### Why this is a separate file from `src/lib/env.ts`
 *
 * `env.ts` begins with `import 'server-only'`, which makes importing it from a client component a
 * BUILD error — that is the mechanical guarantee behind Requirement 13.7 and must not be weakened.
 * But two non-secret values legitimately need to be read from the browser. Putting them here keeps
 * both properties: secrets are unreachable from the browser, and the two non-secrets are reachable
 * without a `server-only` escape hatch.
 *
 * ### Amendment A3 — there is no public database value anymore
 *
 * Under Supabase this file also exported the public project URL and the anon/publishable key,
 * because the browser Supabase client needed them. A3 removes Supabase entirely: the browser never
 * opens a database connection and holds no database credential, so `NEXT_PUBLIC_SUPABASE_URL`,
 * `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are gone, along with
 * the `publicEnv()` accessor and `PublicEnv` type that read them. The only public values left are
 * the Telegram bot username (in every deep link a farmer opens) and the Razorpay checkout key id
 * (a public identifier, not a secret).
 *
 * ### Why these are literal `process.env.X` reads
 *
 * Next.js inlines `NEXT_PUBLIC_*` into the client bundle by **static textual substitution** at
 * build time. A computed lookup (`process.env[name]`) is not substituted, so it reads as
 * `undefined` in the browser. That is why the names appear as literals below.
 *
 * `scripts/check-secret-scope.ts` allows `process.env` in exactly two files — this one and
 * `env.ts` — and fails CI on any other occurrence.
 */

/**
 * The Telegram bot username, e.g. `jamee_bot`. NOT a secret: it is the `<bot>` in the
 * `https://t.me/<bot>?start=<token>` deep link every farmer opens, so it is public by
 * construction (V24, Requirement 21.6). The Web_App reads it to build the Link_Deep_Link.
 */
const TELEGRAM_BOT_USERNAME_VAR = 'NEXT_PUBLIC_TELEGRAM_BOT_USERNAME';

/**
 * The Razorpay key id the browser checkout needs (V27). It is the SAME value as the server
 * `RAZORPAY_KEY_ID`, duplicated under a `NEXT_PUBLIC_` name on purpose: the unprefixed one is
 * never read from a client component, and `scripts/check-secret-scope.ts` asserts that separation.
 * It carries no secret — the key SECRET, which signs orders, stays server-only.
 */
const RAZORPAY_KEY_ID_VAR = 'NEXT_PUBLIC_RAZORPAY_KEY_ID';

export const PUBLIC_ENV_VARS = [
  TELEGRAM_BOT_USERNAME_VAR,
  RAZORPAY_KEY_ID_VAR,
] as const;

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * The Telegram bot username for the Link_Deep_Link, throwing — naming the variable — when it is
 * absent (Requirement 21.6, V24).
 *
 * A literal `process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` read, not a computed lookup: Next.js
 * inlines `NEXT_PUBLIC_*` into the client bundle by static textual substitution, and a computed
 * lookup reads as `undefined` in the browser.
 */
export function telegramBotUsername(): string {
  const value = nonEmpty(process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME);
  if (value === undefined) {
    throw new Error(
      `Missing environment variable ${TELEGRAM_BOT_USERNAME_VAR}. See .env.example and docs/DEPLOYMENT.md.`,
    );
  }
  return value;
}

/**
 * The public Razorpay key id the browser checkout initializes with, throwing — naming the
 * variable — when it is absent (V27).
 *
 * A literal read for the same static-substitution reason as above. This is the SAME value as the
 * server `RAZORPAY_KEY_ID`; the duplication under a `NEXT_PUBLIC_` name is what keeps the
 * unprefixed one out of every client component.
 */
export function razorpayPublicKeyId(): string {
  const value = nonEmpty(process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID);
  if (value === undefined) {
    throw new Error(
      `Missing environment variable ${RAZORPAY_KEY_ID_VAR}. See .env.example and docs/DEPLOYMENT.md.`,
    );
  }
  return value;
}

/**
 * Non-throwing probe, for a health check that wants to report every gap at once. Reports whether
 * both public values are present.
 */
export function hasPublicEnv(): boolean {
  try {
    telegramBotUsername();
    razorpayPublicKeyId();
    return true;
  } catch {
    return false;
  }
}
