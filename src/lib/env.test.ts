import { afterEach, describe, expect, it, vi } from 'vitest';

import * as verified from '@/lib/config/verified';
import {
  ALL_ENV_KEYS,
  missingServerEnvKeys,
  OPTIONAL_SERVER_ENV_KEYS,
  optionalServerEnv,
  PUBLIC_ENV_VARS,
  SERVER_ENV_KEYS,
  serverEnv,
  type ServerEnvKey,
} from '@/lib/env';
import { hasPublicEnv, publicEnv } from '@/lib/env.public';

/**
 * Unit tests for the environment accessor (`src/lib/env.ts`, `src/lib/env.public.ts`) and for the
 * resolved-value constants (`src/lib/config/verified.ts`).
 *
 * Requirements: 13.7 (the Service_Role_Key is referenced only in server modules), 17.2 (every
 *               variable is documented, and a model identifier is a reviewed constant rather than
 *               an environment value)
 *
 * ### What this file adds that Property 30 does not
 *
 * `tests/property/deliverable.property.test.ts` (Property 30) reads `.env.example` off the
 * filesystem and asserts it lists every key in `ALL_ENV_KEYS`, each with a placeholder rather than
 * a live credential. That is a claim about the **documentation**. It never calls `serverEnv()`, so
 * nothing there observes:
 *
 *  - that a missing variable throws **at first use** rather than at import, or ever;
 *  - that the thrown message names the variable the *current* call needed, and not the others;
 *  - that `verified.ts`'s constants are populated — Property 30's placeholder rules are pointed at
 *     `.env.example`, and a `TODO` sitting in a model identifier would pass every one of them.
 *
 * Those three are this file's subject. Every value stubbed below is obviously synthetic; the
 * accessor only checks presence and length, so a realistic shape would buy nothing and would put a
 * credential-looking string in the repository.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A value that satisfies every server key's rule — `min(1)` for seven of them and `min(16)` for
 * `CRON_SECRET` — while reading as scaffolding to anyone who finds it in a log.
 */
const SYNTHETIC = 'synthetic-test-value-not-a-secret';

/** `vi.stubEnv(key, undefined)` deletes the variable, which is the "operator forgot it" case. */
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
  it('name eight required server variables and three public ones', () => {
    expect([...SERVER_ENV_KEYS].sort()).toStrictEqual([
      'CRON_SECRET',
      'GEMINI_API_KEY',
      'GROQ_API_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_VERIFY_TOKEN',
    ]);
    expect(OPTIONAL_SERVER_ENV_KEYS).toStrictEqual(['WHATSAPP_API_VERSION']);
    expect(PUBLIC_ENV_VARS).toHaveLength(3);
    // Every public name is prefixed, which is the half of Requirement 13.7 the bundler enforces.
    for (const name of PUBLIC_ENV_VARS) expect(name.startsWith('NEXT_PUBLIC_')).toBe(true);
  });

  it('keeps the required and optional sets disjoint', () => {
    // `WHATSAPP_API_VERSION` is optional *because* it defaults to the V12-pinned constant. Listing
    // it in both places would make an absent override a hard failure for every WhatsApp request.
    for (const optional of OPTIONAL_SERVER_ENV_KEYS) {
      expect(SERVER_ENV_KEYS as readonly string[]).not.toContain(optional);
    }
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

      // The whole point of the accessor: the message says which variable, so an operator reading a
      // 500 in the platform log knows what to set without opening the codebase.
      expect(error.message, `${key} did not name itself`).toContain(key);
      expect(error.message).toContain('is not set');
      // And it points at where the answer lives, which is the other half of Requirement 17.2.
      expect(error.message).toContain('.env.example');
    }
  });

  it('throws at first use rather than at import, and only for the key that was read', () => {
    // This module imported `serverEnv` at the top of the file with nothing configured, and that
    // import did not throw — a module-scope `parse()` would have failed `next build`, where the
    // production secrets are legitimately absent, for a reason unrelated to the build.
    clearAllServerEnv();
    vi.stubEnv('GEMINI_API_KEY', SYNTHETIC);

    // A request that needs only the Gemini key succeeds while seven others are unset.
    expect(serverEnv('GEMINI_API_KEY')).toBe(SYNTHETIC);

    // And the failure for a different key names that key alone. A whole-object parse would list
    // every absent variable, so `/api/diagnose` would report four WhatsApp names it never needed.
    const error = thrownBy(() => serverEnv('WHATSAPP_APP_SECRET'));
    expect(error.message).toContain('WHATSAPP_APP_SECRET');
    expect(error.message).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(error.message).not.toContain('CRON_SECRET');
  });

  it('treats an empty value as absent', () => {
    // A platform UI that saves a cleared field as `''` must behave the same as never setting it;
    // otherwise the SDK receives an empty credential and fails several frames from the cause.
    vi.stubEnv('GROQ_API_KEY', '');

    const error = thrownBy(() => serverEnv('GROQ_API_KEY'));
    expect(error.message).toContain('GROQ_API_KEY');
    expect(error.message).toContain('is not set');
  });

  /**
   * **A divergence between the three accessors, pinned rather than fixed.**
   *
   * `optionalServerEnv()` and `publicEnv()`'s `nonEmpty()` both treat a whitespace-only value as
   * unset, and both trim what they return. `serverEnv()` does neither: its rule is `z.string().min(1)`,
   * which `'   '` satisfies, so a cleared-then-spaced field is handed to the SDK verbatim. The
   * `raw.trim() === ''` branch in its own error message anticipates the case, but that branch is
   * unreachable for a value `min(1)` accepts — only `''` gets there.
   *
   * Asserted as it behaves, not as it arguably should. Changing `env.ts` is outside this task, and
   * leaving the case untested would make a later fix look like a regression instead of a fix: this
   * expectation is what a fix should flip, with the reason written next to it.
   */
  it('currently accepts a whitespace-only value, unlike the optional and public accessors', () => {
    vi.stubEnv('GROQ_API_KEY', '   ');
    vi.stubEnv('WHATSAPP_API_VERSION', '   ');

    expect(serverEnv('GROQ_API_KEY')).toBe('   ');
    expect(optionalServerEnv('WHATSAPP_API_VERSION')).toBeUndefined();
  });

  it('returns the configured value once it is set', () => {
    setAllServerEnv();

    for (const key of SERVER_ENV_KEYS) expect(serverEnv(key)).toBe(SYNTHETIC);
  });
});

describe('serverEnv on a present but invalid variable', () => {
  it('names the variable and says it is set rather than absent', () => {
    // `CRON_SECRET` is the one key with a rule beyond presence: at least 16 characters (V21). A
    // too-short value is a different operator mistake from an absent one, and conflating them
    // would send someone looking for a variable they had already set.
    vi.stubEnv('CRON_SECRET', 'short');

    const error = thrownBy(() => serverEnv('CRON_SECRET'));

    expect(error.message).toContain('CRON_SECRET');
    expect(error.message).toContain('is set but invalid');
    expect(error.message).not.toContain('is not set');
    expect(error.message).toContain('16 characters');
  });
});

/* ========================================================================== */
/* The optional variable, and the non-throwing probe                           */
/* ========================================================================== */

describe('optionalServerEnv', () => {
  it('returns undefined when unset or blank, and the trimmed value otherwise', () => {
    vi.stubEnv('WHATSAPP_API_VERSION', undefined);
    expect(optionalServerEnv('WHATSAPP_API_VERSION')).toBeUndefined();

    vi.stubEnv('WHATSAPP_API_VERSION', '   ');
    expect(optionalServerEnv('WHATSAPP_API_VERSION')).toBeUndefined();

    // Absence is a supported configuration: the caller falls back to `WHATSAPP_API_VERSION_PINNED`,
    // so this accessor reports rather than throws.
    vi.stubEnv('WHATSAPP_API_VERSION', '  v99.0  ');
    expect(optionalServerEnv('WHATSAPP_API_VERSION')).toBe('v99.0');
  });
});

describe('missingServerEnvKeys', () => {
  it('reports every gap at once, for a startup or health check', () => {
    clearAllServerEnv();
    expect([...missingServerEnvKeys()].sort()).toStrictEqual([...SERVER_ENV_KEYS].sort());

    setAllServerEnv();
    expect(missingServerEnvKeys()).toStrictEqual([]);

    // Including a key that is set but fails its own rule — "missing" here means "unusable".
    vi.stubEnv('CRON_SECRET', 'short');
    expect(missingServerEnvKeys()).toStrictEqual<ServerEnvKey[]>(['CRON_SECRET']);
  });
});

/* ========================================================================== */
/* The public accessor                                                         */
/* ========================================================================== */

const [PUBLIC_URL_VAR, PUBLISHABLE_KEY_VAR, ANON_KEY_VAR] = PUBLIC_ENV_VARS;

describe('publicEnv', () => {
  function clearPublic(): void {
    for (const name of PUBLIC_ENV_VARS) vi.stubEnv(name, undefined);
  }

  it('throws naming the missing variable', () => {
    clearPublic();

    // `createBrowserClient(undefined, undefined)` throws about a malformed URL from inside the SDK,
    // in the browser console of a farmer's phone. Naming the variable here is what avoids that.
    expect(thrownBy(publicEnv).message).toContain(PUBLIC_URL_VAR);

    vi.stubEnv(PUBLIC_URL_VAR, 'https://synthetic.supabase.test');
    const keyError = thrownBy(publicEnv);
    expect(keyError.message).toContain(PUBLISHABLE_KEY_VAR);
    // Both spellings are named, so an operator on either side of the V1 rename knows what to set.
    expect(keyError.message).toContain(ANON_KEY_VAR);
  });

  it('accepts either spelling of the public key, publishable first', () => {
    clearPublic();
    vi.stubEnv(PUBLIC_URL_VAR, 'https://synthetic.supabase.test');

    // V1: current docs name it `…PUBLISHABLE_KEY`; older projects issue it under `…ANON_KEY`. A
    // project created on either side of that rename must work unchanged.
    vi.stubEnv(ANON_KEY_VAR, 'synthetic-anon-key');
    expect(publicEnv().supabaseAnonKey).toBe('synthetic-anon-key');

    vi.stubEnv(PUBLISHABLE_KEY_VAR, 'synthetic-publishable-key');
    expect(publicEnv().supabaseAnonKey).toBe('synthetic-publishable-key');

    expect(publicEnv().supabaseUrl).toBe('https://synthetic.supabase.test');
    expect(hasPublicEnv()).toBe(true);
  });

  it('probes without throwing', () => {
    clearPublic();
    expect(hasPublicEnv()).toBe(false);
  });
});

/* ========================================================================== */
/* The resolved-value constants                                                */
/* ========================================================================== */

/**
 * A marker means "someone left this to be filled in later". A plausible guess that lands in
 * `verified.ts` is indistinguishable from a fact, which is what the V-item discipline exists to
 * prevent — and an unfilled marker is the visible half of that failure.
 *
 * Word-boundary anchored so a legitimate value cannot trip a substring: `x-hub-signature-256`
 * contains no whole word from this list, and neither does any model identifier.
 */
const PLACEHOLDER_WORDS = /\b(TODO|TBD|FIXME|XXX|CHANGEME|PLACEHOLDER|UNKNOWN|REPLACE|YOUR)\b/i;
/** `<your-key-here>`, the other common shape. */
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

/**
 * Walk one exported constant, recording every leaf it reaches.
 *
 * Recursive because the module exports nested objects (`GEMINI_GENERATION`, `META_CHALLENGE_PARAMS`,
 * `DAILY_QUOTAS`) and arrays (`ACCEPTED_IMAGE_TYPES`, the status lists). Checking only the top level
 * would leave every one of those unexamined, which is most of the file.
 */
function walk(value: unknown, at: string, leaves: string[]): void {
  if (typeof value === 'string') {
    assertUsableString(value, at);
    leaves.push(at);
    return;
  }
  if (typeof value === 'number') {
    // `STORAGE_OWNER_PATH_SEGMENT_INDEX` and `GEMINI_GENERATION.temperature` are legitimately 0, so
    // the claim is "a real, finite, non-negative number", not "truthy".
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
  // `null` reaches here only for `VISION_FALLBACK_MODEL`, whose `null` is the V9 withdrawal case
  // and must stay expressible. Anything else null-ish is unresolved and fails.
  expect(
    at,
    `${at} is null or undefined; only VISION_FALLBACK_MODEL may be null`,
  ).toBe('VISION_FALLBACK_MODEL');
}

describe('the resolved-value constants in config/verified.ts', () => {
  it('are every one of them populated and free of placeholder markers', () => {
    const leaves: string[] = [];
    const exported = Object.entries(verified).filter(([, value]) => typeof value !== 'function');

    expect(exported.length).toBeGreaterThan(30);
    for (const [name, value] of exported) walk(value, name, leaves);

    // Non-vacuity: the walk really did reach into the nested shapes rather than stopping at the
    // top level. `GEMINI_GENERATION` alone contributes six leaves.
    expect(leaves.length).toBeGreaterThan(exported.length);
    expect(leaves).toContain('GEMINI_GENERATION.thinkingLevel');
    expect(leaves).toContain('ACCEPTED_IMAGE_TYPES[0]');
    expect(leaves).toContain('DAILY_QUOTAS.image');
    expect(leaves).toContain('WHATSAPP_INBOUND_MAX_BYTES.audio');
  });

  it('holds the model identifiers as constants rather than as environment variables', () => {
    // Requirement 17.2's other half, and the note at the top of `env.ts`: a model id in an env var
    // is an unversioned, unreviewable change to Jamee's behaviour. So none of these names is a key
    // the accessor knows about, and reading one requires editing a reviewed file.
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

  it('derives the Graph API base from the pinned version', () => {
    // `graphApiBase` is the module's one exported function, so the walk above skips it. Its default
    // argument is the V12 pin, and that is the value every WhatsApp call site gets.
    assertUsableString(verified.graphApiBase(), 'graphApiBase()');
    expect(verified.graphApiBase()).toContain(verified.WHATSAPP_API_VERSION_PINNED);
    expect(verified.graphApiBase('v99.0')).toContain('v99.0');
  });

  it('keeps the vision fallback expressible as null without being null today', () => {
    // V9 records both Groq vision candidates as Preview models that "may be discontinued at short
    // notice", so `null` has to stay assignable — that edit is the whole withdrawal change. Today
    // it holds a real identifier, which is why the vision chain has two members.
    expect(verified.VISION_FALLBACK_MODEL).not.toBeNull();
    if (verified.VISION_FALLBACK_MODEL !== null) {
      assertUsableString(verified.VISION_FALLBACK_MODEL, 'VISION_FALLBACK_MODEL');
    }
  });
});
