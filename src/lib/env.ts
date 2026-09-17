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
 * model identifiers, the Meta API version, header names, platform limits — are compile-time
 * constants in `src/lib/config/verified.ts`, not environment variables. A model id in an env
 * var is an unversioned, unreviewable change to Jamee's behaviour; a constant annotated with
 * its V-item is a reviewable one.
 */

/* -------------------------------------------------------------------------- */
/* Public variables — re-exported, not re-implemented                          */
/* -------------------------------------------------------------------------- */

/**
 * The two `NEXT_PUBLIC_` values live in `src/lib/env.public.ts`, which has no `server-only` guard
 * because the browser Supabase client legitimately needs them.
 *
 * They are re-exported here so a server module has one import for "environment", while the
 * separation that makes Requirement 13.7 mechanical stays intact: a client component importing
 * `env.public` is fine, and a client component importing THIS file is a build error.
 */
export { publicEnv, hasPublicEnv, PUBLIC_ENV_VARS, type PublicEnv } from '@/lib/env.public';

/* -------------------------------------------------------------------------- */
/* Server-only variables                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every server secret, with the module that consumes it.
 *
 * `WHATSAPP_API_VERSION` is deliberately OPTIONAL and absent from this schema: it defaults
 * to the V12-pinned constant in `config/verified.ts`. It is an override for the case where
 * Meta deprecates the pinned version faster than a code change can ship, not a value an
 * operator is expected to supply.
 */
const serverEnvSchema = z.object({
  /** Service-role key. RLS-bypassing; `lib/supabase/admin.ts` only. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  /** Gemini API key. `lib/gemini.ts` only. V6 records that the SDK reads this name itself. */
  GEMINI_API_KEY: z.string().min(1),

  /** Groq API key — text fallback, vision fallback, and transcription. `lib/groq.ts` only. */
  GROQ_API_KEY: z.string().min(1),

  /** Meta Cloud API bearer token: media download (V14) and send (V15). */
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),

  /** Business phone number id — the path segment of the send endpoint (V15). */
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),

  /** Compared against `hub.verify_token` on the webhook GET challenge (Requirement 11.1). */
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),

  /** HMAC-SHA256 key for `X-Hub-Signature-256` over the raw body (Requirement 11.3, V13). */
  WHATSAPP_APP_SECRET: z.string().min(1),

  /**
   * Retention-sweep secret (Requirement 18.12).
   *
   * Named `CRON_SECRET` because that is the name the deployment platform injects: V21
   * records that Vercel automatically sends this variable's value as
   * `Authorization: Bearer <CRON_SECRET>` on every cron invocation. A differently named
   * variable could not be used for automatic triggering at all, so there is one secret here
   * rather than two.
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
 */
export const OPTIONAL_SERVER_ENV_KEYS = ['WHATSAPP_API_VERSION'] as const;

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
 * request needed. A whole-object parse in a repository with no WhatsApp credentials
 * configured would fail `/api/diagnose`, which needs none of them, and the error would list
 * four unrelated names.
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
