import { afterEach, describe, expect, it, vi } from 'vitest';

import * as verified from '@/lib/config/verified';
import {
  ALL_ENV_KEYS,
  missingServerEnvKeys,
  OPTIONAL_SERVER_ENV_KEYS,
  PUBLIC_ENV_VARS,
  SERVER_ENV_KEYS,
  serverEnv,
  type ServerEnvKey,
} from '@/lib/env';
import {
  hasPublicEnv,
  razorpayPublicKeyId,
  telegramBotUsername,
} from '@/lib/env.public';

/**
 * Unit tests for the environment accessor (`src/lib/env.ts`, `src/lib/env.public.ts`) and for the
 * resolved-value constants (`src/lib/config/verified.ts`).
 *
 * Requirements: 13.7 (secrets are referenced only in server modules), 17.2 (every variable is
 *               documented, and a model identifier is a reviewed constant rather than an
 *               environment value)
 *
 * ### Amendment A3
 *
 * MongoDB replaces Supabase. The four Supabase names are gone; `MONGODB_URI`, `BETTER_AUTH_SECRET`,
 * `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` take their place, and the two
 * public Supabase names are replaced by the Telegram bot username and the Razorpay checkout key id.
 * These tests assert the new contract and that **no Supabase or WhatsApp env name survives** in the
 * schema, the completeness list, or the public names (task 51.5).
 *
 * ### What this file adds that Property 30 does not
 *
 * Property 30 reads `.env.example` and asserts it lists every key in `ALL_ENV_KEYS`. That is a claim
 * about the documentation and never calls `serverEnv()`. This file observes the accessor's own
 * behaviour: a missing variable throws at first use naming only the key that was read, and every
 * constant in `verified.ts` is populated (a placeholder in a model identifier would pass every one
 * of Property 30's `.env.example` checks).
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** Satisfies every server key's rule — `min(1)` for twelve of them and `min(16)` for `CRON_SECRET`. */
const SYNTHETIC = 'synthetic-test-value-not-a-secret';

function clearAllServerEnv(): void {
  for (const key of SERVER_ENV_KEYS) vi.stubEnv(key, undefined);
}

function setAllServerEnv(): void {
  for (const key of SERVER_ENV_KEYS) vi.stubEnv(key, SYNTHETIC);
}

function thrownBy(read: () => unknown): Error {
  try {
    read();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected the accessor to throw, but it returned');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ========================================================================== */
/* The key sets                                                                */
/* ========================================================================== */

describe('the environment key sets', () => {
  it('name thirteen required server variables and two public ones', () => {
    // Amendment A3: MongoDB replaces Supabase, so SUPABASE_SERVICE_ROLE_KEY is gone and MONGODB_URI
    // plus the four Better-Auth/Google names take its place. Amendment A1 already retired the
    // WHATSAPP_* names for Telegram + Razorpay.
    expect([...SERVER_ENV_KEYS].sort()).toStrictEqual([
      'BETTER_AUTH_SECRET',
      'BETTER_AUTH_URL',
      'CRON_SECRET',
      'GEMINI_API_KEY',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GROQ_API_KEY',
      'MONGODB_URI',
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_SECRET',
      'RAZORPAY_WEBHOOK_SECRET',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_WEBHOOK_SECRET_TOKEN',
    ]);
    expect(OPTIONAL_SERVER_ENV_KEYS).toStrictEqual([]);
    expect(PUBLIC_ENV_VARS).toHaveLength(2);
    // Every public name is prefixed, which is the half of Requirement 13.7 the bundler enforces.
    for (const name of PUBLIC_ENV_VARS) expect(name.startsWith('NEXT_PUBLIC_')).toBe(true);
    // The only public values are the Telegram bot username and the Razorpay checkout key id.
    expect([...PUBLIC_ENV_VARS].sort()).toStrictEqual([
      'NEXT_PUBLIC_RAZORPAY_KEY_ID',
      'NEXT_PUBLIC_TELEGRAM_BOT_USERNAME',
    ]);
  });

  it('carries no retired Supabase or WhatsApp name anywhere in the env contract', () => {
    // 51.1 / 51.5: no removed Supabase or WhatsApp name survives in env.ts or env.public.ts.
    const retired = [
      // Supabase (retired by A3)
      'SUPABASE_SERVICE_ROLE_KEY',
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      // WhatsApp (retired by A1)
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_VERIFY_TOKEN',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_API_VERSION',
    ];
    for (const name of retired) {
      expect(ALL_ENV_KEYS, `${name} still in ALL_ENV_KEYS`).not.toContain(name);
      expect(SERVER_ENV_KEYS as readonly string[], `${name} still in SERVER_ENV_KEYS`).not.toContain(
        name,
      );
    }
    for (const name of PUBLIC_ENV_VARS) {
      expect(name, `${name} mentions Supabase`).not.toMatch(/SUPABASE/i);
      expect(name, `${name} mentions WhatsApp`).not.toMatch(/WHATSAPP/i);
    }
    // The completeness list must not mention either family.
    for (const key of ALL_ENV_KEYS) {
      expect(key).not.toMatch(/SUPABASE/i);
      expect(key).not.toMatch(/WHATSAPP/i);
    }
  });

  it('keeps the key list free of duplicates', () => {
    expect(new Set(ALL_ENV_KEYS).size).toBe(ALL_ENV_KEYS.length);
  });
});

/* ========================================================================== */
/* Missing variables throw at first use, naming the variable                    */
/* ========================================================================== */

describe('serverEnv on a missing variable', () => {
  it('throws naming the variable, for every server key', () => {
    clearAllServerEnv();

    for (const key of SERVER_ENV_KEYS) {
      const error = thrownBy(() => serverEnv(key));
      expect(error.message, `${key} did not name itself`).toContain(key);
      expect(error.message).toContain('is not set');
      expect(error.message).toContain('.env.example');
    }
  });

  it('throws at first use rather than at import, and only for the key that was read', () => {
    // This module imported `serverEnv` at the top with nothing configured, and that import did not
    // throw — a module-scope parse() would have failed `next build`, where production secrets are
    // legitimately absent, for a reason unrelated to the build.
    clearAllServerEnv();
    vi.stubEnv('GEMINI_API_KEY', SYNTHETIC);

    expect(serverEnv('GEMINI_API_KEY')).toBe(SYNTHETIC);

    // A failure for a different key names that key alone. A whole-object parse would list every
    // absent variable, so `/api/diagnose` would report the Telegram and Razorpay names it never needs.
    const error = thrownBy(() => serverEnv('MONGODB_URI'));
    expect(error.message).toContain('MONGODB_URI');
    expect(error.message).not.toContain('BETTER_AUTH_SECRET');
    expect(error.message).not.toContain('CRON_SECRET');
  });

  it('treats an empty value as absent', () => {
    vi.stubEnv('GROQ_API_KEY', '');
    const error = thrownBy(() => serverEnv('GROQ_API_KEY'));
    expect(error.message).toContain('GROQ_API_KEY');
    expect(error.message).toContain('is not set');
  });

  it('returns the configured value once it is set', () => {
    setAllServerEnv();
    for (const key of SERVER_ENV_KEYS) expect(serverEnv(key)).toBe(SYNTHETIC);
  });
});

describe('serverEnv on a present but invalid variable', () => {
  it('names the variable and says it is set rather than absent', () => {
    // CRON_SECRET is the one key with a rule beyond presence: at least 16 characters (V21).
    vi.stubEnv('CRON_SECRET', 'short');

    const error = thrownBy(() => serverEnv('CRON_SECRET'));

    expect(error.message).toContain('CRON_SECRET');
    expect(error.message).toContain('is set but invalid');
    expect(error.message).not.toContain('is not set');
    expect(error.message).toContain('16 characters');
  });
});

/* ========================================================================== */
/* The non-throwing probe                                                       */
/* ========================================================================== */

describe('missingServerEnvKeys', () => {
  it('reports every gap at once, for a startup or health check', () => {
    clearAllServerEnv();
    expect([...missingServerEnvKeys()].sort()).toStrictEqual([...SERVER_ENV_KEYS].sort());

    setAllServerEnv();
    expect(missingServerEnvKeys()).toStrictEqual([]);

    vi.stubEnv('CRON_SECRET', 'short');
    expect(missingServerEnvKeys()).toStrictEqual<ServerEnvKey[]>(['CRON_SECRET']);
  });
});

/* ========================================================================== */
/* The public accessors                                                        */
/* ========================================================================== */

describe('the public accessors', () => {
  function clearPublic(): void {
    for (const name of PUBLIC_ENV_VARS) vi.stubEnv(name, undefined);
  }

  it('each throw naming their own missing variable', () => {
    clearPublic();

    expect(thrownBy(telegramBotUsername).message).toContain('NEXT_PUBLIC_TELEGRAM_BOT_USERNAME');
    expect(thrownBy(razorpayPublicKeyId).message).toContain('NEXT_PUBLIC_RAZORPAY_KEY_ID');
    expect(hasPublicEnv()).toBe(false);
  });

  it('return the configured values, and the probe passes once both are set', () => {
    clearPublic();
    vi.stubEnv('NEXT_PUBLIC_TELEGRAM_BOT_USERNAME', 'jamee_bot');
    vi.stubEnv('NEXT_PUBLIC_RAZORPAY_KEY_ID', 'rzp_test_synthetic');

    expect(telegramBotUsername()).toBe('jamee_bot');
    expect(razorpayPublicKeyId()).toBe('rzp_test_synthetic');
    expect(hasPublicEnv()).toBe(true);
  });

  it('reports a gap through the probe when only one is set', () => {
    clearPublic();
    vi.stubEnv('NEXT_PUBLIC_TELEGRAM_BOT_USERNAME', 'jamee_bot');
    expect(hasPublicEnv()).toBe(false);
  });
});

/* ========================================================================== */
/* The resolved-value constants                                                */
/* ========================================================================== */

/**
 * A marker means "someone left this to be filled in later". A plausible guess that lands in
 * `verified.ts` is indistinguishable from a fact, which is what the V-item discipline exists to
 * prevent. Word-boundary anchored so a legitimate value cannot trip a substring.
 */
const PLACEHOLDER_WORDS = /\b(TODO|TBD|FIXME|XXX|CHANGEME|PLACEHOLDER|UNKNOWN|REPLACE|YOUR)\b/i;
const ANGLE_PLACEHOLDER = /<[^>]*>/;
const PLACEHOLDER_FRAGMENTS = [/your[-_]/i, /example\.(com|org|net)/i, /\bhere\b/i];

function assertUsableString(value: string, at: string): void {
  expect(value.trim(), `${at} is empty`).not.toBe('');
  expect(value, `${at} carries a placeholder word`).not.toMatch(PLACEHOLDER_WORDS);
  expect(value, `${at} carries an angle-bracket placeholder`).not.toMatch(ANGLE_PLACEHOLDER);
  for (const fragment of PLACEHOLDER_FRAGMENTS) {
    expect(value, `${at} carries a placeholder fragment`).not.toMatch(fragment);
  }
}

/** Walk one exported constant, recording every leaf it reaches. */
function walk(value: unknown, at: string, leaves: string[]): void {
  if (typeof value === 'string') {
    assertUsableString(value, at);
    leaves.push(at);
    return;
  }
  if (typeof value === 'number') {
    // STORAGE_OWNER_PATH_SEGMENT_INDEX and GEMINI_GENERATION.temperature are legitimately 0.
    expect(Number.isFinite(value), `${at} is not a finite number`).toBe(true);
    expect(value, `${at} is negative`).toBeGreaterThanOrEqual(0);
    leaves.push(at);
    return;
  }
  if (typeof value === 'boolean') {
    leaves.push(at);
    return;
  }
  if (Array.isArray(value)) {
    expect(value, `${at} is an empty list`).not.toHaveLength(0);
    value.forEach((entry, index) => walk(entry, `${at}[${index}]`, leaves));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    expect(entries, `${at} is an empty object`).not.toHaveLength(0);
    for (const [key, nested] of entries) walk(nested, `${at}.${key}`, leaves);
    return;
  }
  // `null` reaches here only for VISION_FALLBACK_MODEL, whose null is the V9 withdrawal case.
  expect(
    at,
    `${at} is null or undefined; only VISION_FALLBACK_MODEL may be null`,
  ).toBe('VISION_FALLBACK_MODEL');
}

describe('the resolved-value constants in config/verified.ts', () => {
  it('are every one of them populated and free of placeholder markers', () => {
    const leaves: string[] = [];
    const exported = Object.entries(verified).filter(([, value]) => typeof value !== 'function');

    expect(exported.length).toBeGreaterThan(20);
    for (const [name, value] of exported) walk(value, name, leaves);

    // Non-vacuity: the walk really reached into the nested shapes. GEMINI_GENERATION alone
    // contributes several leaves.
    expect(leaves.length).toBeGreaterThan(exported.length);
    expect(leaves).toContain('GEMINI_GENERATION.thinkingLevel');
    expect(leaves).toContain('ACCEPTED_IMAGE_TYPES[0]');
    expect(leaves).toContain('DAILY_QUOTAS.image');
  });

  it('holds the model identifiers as constants rather than as environment variables', () => {
    const identifiers = [
      verified.GEMINI_MODEL,
      verified.GROQ_TEXT_MODEL,
      verified.GROQ_TRANSCRIBE_MODEL,
    ];

    for (const identifier of identifiers) assertUsableString(identifier, 'model identifier');
    expect(new Set(identifiers).size).toBe(identifiers.length);

    for (const key of ALL_ENV_KEYS) {
      expect(key).not.toMatch(/MODEL/);
    }
  });

  it('keeps the vision fallback expressible as null without being null today', () => {
    // V9 records both Groq vision candidates as Preview models that "may be discontinued at short
    // notice", so `null` has to stay assignable. Today it holds a real identifier.
    expect(verified.VISION_FALLBACK_MODEL).not.toBeNull();
    if (verified.VISION_FALLBACK_MODEL !== null) {
      assertUsableString(verified.VISION_FALLBACK_MODEL, 'VISION_FALLBACK_MODEL');
    }
  });

  it('lowers the voice size cap to 3 MB per Amendment A3', () => {
    // A3 §3: the upload leg carries the file and must stay under the 4.5 MB Request_Body_Ceiling,
    // so the voice cap drops from 10 MB to 3 MB while the 120-second duration limit is kept.
    expect(verified.MAX_AUDIO_BYTES).toBe(3 * 1024 * 1024);
    expect(verified.MAX_AUDIO_BYTES).toBeLessThan(verified.REQUEST_BODY_CEILING_BYTES);
    expect(verified.MAX_AUDIO_SECONDS).toBe(120);
  });
});
