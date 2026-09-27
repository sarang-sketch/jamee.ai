import 'server-only';

import { z } from 'zod';

import { PUBLIC_ENV_VARS } from '@/lib/env.public';

/**
 * The ONE place in the codebase that reads `process.env`.
 *
 * Requirements: 13.7 (the Service_Role_Key is referenced only in server-side modules and
 *               never reaches the browser), 17.2 (`.env.example` lists every variable)
 * Design: "Security boundary — Environment variables", layer 3: *"Secrets are read through a
 *         small `serverEnv` accessor in a `server-only` module that validates presence at
 *         first use with Zod and fails loudly; no `process.env.X!` scattered through the
 *         codebase."*
 *
 * Three mechanisms, each doing a distinct job:
 *
 *  1. `import 'server-only'` on line 1. Importing this module from a `'use client'`
 *     module is a BUILD error, not a runtime surprise. This is the mechanical half of
 *     Requirement 13.7 — a secret cannot leak into the client bundle through this file
 *     because the file cannot be in the client bundle.
 *
 *  2. Validation at FIRST USE, not at import. A module-scope `parse()` would run during
 *     `next build`, where the production secrets are legitimately absent, and would fail
 *     the build for the wrong reason. Deferring to first access means a missing variable
 *     fails the request that needed it, naming the variable — which is the fail-loud
 *     behaviour the V-item rule asks for, applied to configuration.
 *
 *  3. `scripts/check-secret-scope.ts` (task 27.1) asserts that no OTHER file reads
 *     `process.env`. That check is what keeps this module the only door rather than the
 *     preferred one.
 *
 * NOTE ON WHAT DOES *NOT* BELONG HERE. Values resolved from third-party documentation —
 * model identifiers, header names, platform limits — are compile-time constants in
 * `src/lib/config/verified.ts`, not environment variables. A model id in an env var is an
 * unversioned, unreviewable change to Jamee's behaviour; a constant annotated with its V-item is
 * a reviewable one. There is no Meta API version constant anymore (Telegram publishes one
 * unversioned surface), so nothing in `verified.ts` replaces the removed Supabase names.
 */

/* -------------------------------------------------------------------------- */
/* Public variables — re-exported, not re-implemented                          */
/* -------------------------------------------------------------------------- */

/**
 * The two `NEXT_PUBLIC_` values live in `src/lib/env.public.ts`, which has no `server-only` guard
 * because the browser legitimately needs them (the Telegram deep-link bot username and the
 * Razorpay checkout key id). *Amendment A3:* there is no public database URL or key anymore — the
 * two retired Supabase public names are gone, so the only public values are those two.
 *
 * They are re-exported here so a server module has one import for "environment", while the
 * separation that makes Requirement 13.7 mechanical stays intact: a client component importing
 * `env.public` is fine, and a client component importing THIS file is a build error.
 */
export {
  hasPublicEnv,
  telegramBotUsername,
  razorpayPublicKeyId,
  PUBLIC_ENV_VARS,
} from '@/lib/env.public';

/* -------------------------------------------------------------------------- */
/* Server-only variables                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every server secret, with the module that consumes it.
 *
 * Amendment A1 replaced the WhatsApp channel with Telegram and added the Razorpay payment gate.
 * **Amendment A3 then replaced Supabase entirely with MongoDB:** the four Supabase names
 * (`SUPABASE_SERVICE_ROLE_KEY`, and the two public Supabase names in `env.public.ts`) are gone,
 * and `MONGODB_URI` plus the in-app auth library's own secrets take their place. There is no
 * service-role key because there is no RLS to bypass — tenant isolation is the Data_Access_Layer
 * (D18), and the only database credential is `MONGODB_URI`, held solely by `src/lib/db/client.ts`.
 *
 * No SMS variable was ever here: phone OTP was configured in the Supabase dashboard, so
 * Requirement 1.10's "no SMS delivery provider" is a `docs/DEPLOYMENT.md` change, not an
 * `env.ts` one — and Supabase is gone now regardless.
 */
const serverEnvSchema = z.object({
  /**
   * MongoDB Atlas connection string — the ONLY database credential, and the only holder is
   * `src/lib/db/client.ts` (D18, D19, V28). Carries credentials; never `NEXT_PUBLIC_`. The
   * Data_Access_Layer caches one `MongoClient` on `globalThis` within the M0 connection limit
   * (V32). The URI must include the database name (from Atlas → Connect → Drivers).
   */
  MONGODB_URI: z.string().min(1),

  /**
   * Better Auth session signing/encryption secret (V30, V35). The library reads this exact name
   * itself. `src/lib/auth/*` only. Long random string.
   */
  BETTER_AUTH_SECRET: z.string().min(1),

  /**
   * Better Auth base URL (V30). Used to build the Google callback; without it the callback may
   * default to localhost, which breaks a deployed sign-in. `src/lib/auth/*` only.
   */
  BETTER_AUTH_URL: z.string().min(1),

  /** Google OAuth client id for the Better Auth Google provider (V30). `src/lib/auth/*` only. */
  GOOGLE_CLIENT_ID: z.string().min(1),

  /** Google OAuth client secret for the Better Auth Google provider (V30). `src/lib/auth/*` only. */
  GOOGLE_CLIENT_SECRET: z.string().min(1),

  /** Gemini API key. `lib/gemini.ts` only. V6 records that the SDK reads this name itself. */
  GEMINI_API_KEY: z.string().min(1),

  /** Groq API key — primary text generation, vision fallback, and transcription. `lib/groq.ts` only. */
  GROQ_API_KEY: z.string().min(1),

  /**
   * Telegram bot token (V24). The outbound `setWebhook` and `sendMessage` calls, and the
   * download URL of the `getFile` file retrieval, are all built from it. `lib/telegram.ts` only.
   */
  TELEGRAM_BOT_TOKEN: z.string().min(1),

  /**
   * The secret string Jamee registered through `setWebhook`, which Telegram presents in the
   * `X-Telegram-Bot-Api-Secret-Token` header of every delivery (V24, D12). Compared in constant
   * time before the body is parsed; an absent value is a FAILED verification, not a skipped one,
   * because this accessor throws and that lands in the same 401 branch. `lib/telegram.ts` only.
   */
  TELEGRAM_WEBHOOK_SECRET_TOKEN: z.string().min(1),

  /**
   * Razorpay key id — the public identifier the browser checkout also needs (V27). It is
   * deliberately duplicated as the `NEXT_PUBLIC_RAZORPAY_KEY_ID` public var so the unprefixed
   * one here is never read from a client component. Order creation, `services/payment.service.ts`.
   */
  RAZORPAY_KEY_ID: z.string().min(1),

  /** Razorpay key secret — signs order creation and never reaches the browser (V27). `services/payment.service.ts`. */
  RAZORPAY_KEY_SECRET: z.string().min(1),

  /**
   * HMAC-SHA256 key for the Razorpay webhook signature over the raw body (V27, D15). The
   * payment webhook route verifies with it before any parse; an absent value is a failed
   * verification, not a skipped one. `app/api/payment/webhook/route.ts`.
   */
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),

  /**
   * Retention-sweep secret (Requirement 18.12).
   *
   * Named `CRON_SECRET` because that is the name the deployment platform injects: V21
   * records that Vercel automatically sends this variable's value as
   * `Authorization: Bearer <CRON_SECRET>` on every cron invocation. A differently named
   * variable could not be used for automatic triggering at all, so there is one secret here
   * rather than two. (The design's env table names the same secret `RETENTION_SWEEP_SECRET`;
   * the platform-injected name wins, so it stays `CRON_SECRET` here.)
   */
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters (V21)'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type ServerEnvKey = keyof ServerEnv;

/** Every server variable name, for `.env.example` completeness checks (Property 30). */
export const SERVER_ENV_KEYS = Object.keys(serverEnvSchema.shape) as ServerEnvKey[];

/**
 * Optional server variables. Absence is a supported configuration, so they are read through
 * a separate accessor that returns `undefined` rather than throwing.
 *
 * Empty: there is no optional server variable in this release. The accessor below is kept for
 * the next optional variable that appears.
 */
export const OPTIONAL_SERVER_ENV_KEYS = [] as const;

/** Every variable name `.env.example` must list — public, required server, and optional. */
export const ALL_ENV_KEYS: readonly string[] = [
  ...PUBLIC_ENV_VARS,
  ...SERVER_ENV_KEYS,
  ...OPTIONAL_SERVER_ENV_KEYS,
];

/**
 * Read one server variable, validated, throwing with the variable's name when it is absent
 * or fails its rule.
 *
 * Per-key rather than whole-object because the failure should name the variable the CURRENT
 * request needed. A whole-object parse in a repository with only some credentials configured
 * would fail `/api/diagnose`, which needs none of the Telegram or Razorpay names, and the
 * error would list several unrelated names.
 *
 * No caching: `process.env` reads are cheap, and a cache would hold a stale value across a
 * hot reload during development.
 */
export function serverEnv<K extends ServerEnvKey>(key: K): ServerEnv[K] {
  const raw = process.env[key];
  const parsed = serverEnvSchema.shape[key].safeParse(raw);

  if (!parsed.success) {
    const reason =
      raw === undefined || raw.trim() === ''
        ? 'is not set'
        : `is set but invalid: ${parsed.error.issues[0]?.message ?? 'failed validation'}`;
    throw new Error(
      `Environment variable ${key} ${reason}. See .env.example and docs/DEPLOYMENT.md.`,
    );
  }

  return parsed.data as ServerEnv[K];
}

/**
 * Read one optional server variable. Returns `undefined` when unset or empty — an empty
 * string is treated as unset, because a platform UI that saves a cleared field as `''`
 * should behave the same as never setting it.
 */
export function optionalServerEnv(
  key: (typeof OPTIONAL_SERVER_ENV_KEYS)[number],
): string | undefined {
  const raw = process.env[key];
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : undefined;
}

/**
 * Non-throwing presence probe, for a startup check or a health endpoint that wants to report
 * every missing variable at once instead of the first one.
 */
export function missingServerEnvKeys(): ServerEnvKey[] {
  return SERVER_ENV_KEYS.filter((key) => !serverEnvSchema.shape[key].safeParse(process.env[key]).success);
}
