import { describe, expect, it } from 'vitest';

import { AppError, isAppError, toEnvelope } from '@/lib/errors';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_OPTIONS,
  classifyProfileWriteError,
  normalizeDisplayName,
  parseProfileSettings,
  readProfileSettings,
  saveProfileSettings,
  type ProfileSettingsMutation,
  type ProfileSettingsQuery,
  type ProfileSettingsWrite,
} from '@/lib/profile';
import { SUPPORTED_LANGUAGES, type Language } from '@/lib/schemas';

/**
 * Unit tests for the decisions the profile screen makes without a database: what the submitted
 * values normalize to, whether the language is one Jamee supports, what the write payload contains,
 * and which coded error a failed write becomes.
 *
 * Requirements: 1.8 (both values persisted on the farmer's own Profile), 9.1 (English, Hindi and
 *               Marathi are the selectable languages)
 * Design: "Frontend" (`/profile` = server shell + client form), "Error taxonomy"
 *
 * The fake `profiles` table below is not a yes-man. It applies `profiles_update_own`'s
 * `auth.uid() = id` as a **filter** rather than as an error, because that is what RLS does to an
 * UPDATE whose `using` predicate does not match, and it is what lets the zero-rows test assert
 * something real rather than assert a stub.
 *
 * What it does **not** stage is the `language in ('en','hi','mr')` check constraint: the write seam
 * is typed, so a value outside the enum cannot reach a `profiles` update through this module at all.
 * That branch of the taxonomy is tested directly against `classifyProfileWriteError` instead.
 *
 * ### Why there is no DOM test for `ProfileForm`
 *
 * Two reasons, and neither is convenience. The repository has no DOM testing library, and every
 * assertion worth making about this form is about a **network effect**: that a save writes exactly
 * two columns, that a rejected language never reaches the database, that a write which changed no
 * row is not reported as saved. Reaching those through a rendered form needs a stand-in Supabase
 * client, and a stand-in that returns whatever the test wants proves nothing about saving a profile
 * — so the decisions are tested here, at the seam the component calls, and the component keeps no
 * logic of its own beyond binding them to inputs. This is the same line `SignInForm.test.tsx` draws.
 *
 * What that leaves for the integration harness (task 29.1), against a real database and a real
 * session — including the one thing these tests deliberately cannot claim, that the statement each
 * call site builds selects these two columns and filters on the caller's own id:
 *  - a signed-in farmer saves a name and `mr`, and a fresh read of their row returns both;
 *  - the values survive a second sign-in, which is the pairing with the callback's `id`+`phone`
 *    upsert this module's header describes;
 *  - the same save attempted against **another** farmer's id updates zero rows and leaves that row
 *    untouched, which is `profiles_update_own` doing the authorizing rather than this code;
 *  - `phone` is byte-identical before and after a save.
 *
 * The rendered form's labels, focus order and `role="alert"` region belong to the manual
 * accessibility pass in task 26.2.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

/* ========================================================================== */
/* normalizeDisplayName                                                        */
/* ========================================================================== */

describe('normalizeDisplayName', () => {
  it('keeps the name the farmer typed', () => {
    expect(normalizeDisplayName('Asha')).toBe('Asha');
    expect(normalizeDisplayName('आशा पाटील')).toBe('आशा पाटील');
  });

  it('strips surrounding whitespace, which is not part of a name', () => {
    expect(normalizeDisplayName('  Asha  ')).toBe('Asha');
    expect(normalizeDisplayName('\nAsha\t')).toBe('Asha');
    // Interior spacing is left alone: it is how the name is written.
    expect(normalizeDisplayName('  Asha  Patil ')).toBe('Asha  Patil');
  });

  it('turns a cleared field into null rather than a blank string', () => {
    // The column is nullable and its absence means "not set" — a blank string would be a third
    // state every reader then has to handle.
    expect(normalizeDisplayName('')).toBeNull();
    expect(normalizeDisplayName('   ')).toBeNull();
    expect(normalizeDisplayName(null)).toBeNull();
    expect(normalizeDisplayName(undefined)).toBeNull();
  });

  it('applies no length rule of its own', () => {
    // `display_name` is unconstrained `text` in 0002_profiles.sql. A ceiling invented here would be
    // a rejection the database would not make, with no catalog sentence to explain it.
    const long = 'अ'.repeat(500);
    expect(normalizeDisplayName(long)).toBe(long);
  });
});

/* ========================================================================== */
/* parseProfileSettings                                                        */
/* ========================================================================== */

describe('parseProfileSettings', () => {
  it('accepts every language Requirement 9.1 offers, and only those', () => {
    expect(LANGUAGE_OPTIONS).toEqual(['en', 'hi', 'mr']);
    // The form's option list and the validation enum are the same list, not two copies of it.
    expect([...LANGUAGE_OPTIONS]).toEqual([...SUPPORTED_LANGUAGES]);

    for (const language of LANGUAGE_OPTIONS) {
      expect(parseProfileSettings({ displayName: 'Asha', language })).toEqual({
        displayName: 'Asha',
        language,
      });
    }
  });

  it('normalizes the display name on the way through', () => {
    expect(parseProfileSettings({ displayName: '  Asha ', language: 'hi' })).toEqual({
      displayName: 'Asha',
      language: 'hi',
    });
    expect(parseProfileSettings({ displayName: '   ', language: 'hi' }).displayName).toBeNull();
  });

  it('rejects a language outside the supported set', () => {
    for (const language of ['', 'EN', 'en-IN', 'ta', 'english', 'mr ', 'null']) {
      const error = failureOf(() => parseProfileSettings({ displayName: 'Asha', language }));

      expect(error.code).toBe('LANGUAGE_UNSUPPORTED');
      expect(error.context?.reason).toBe('language_outside_supported_set');
    }
  });

  it('names the three supported codes when it rejects one', () => {
    // Requirement 9.5's shape: the envelope carries the codes, so no call site has to list them.
    const error = failureOf(() => parseProfileSettings({ displayName: 'Asha', language: 'ta' }));
    const { error: envelope } = toEnvelope(error, DEFAULT_LANGUAGE);

    expect(envelope.details?.supportedLanguages).toEqual(['en', 'hi', 'mr']);
    expect(envelope.message).toBe('Jamee answers in English, Hindi and Marathi only.');
  });
});

/* ========================================================================== */
/* classifyProfileWriteError                                                   */
/* ========================================================================== */

describe('classifyProfileWriteError', () => {
  it('treats a refused session as something the farmer can fix', () => {
    // Signing in again is the remedy for both, and AUTH_REQUIRED is the message that says so.
    expect(classifyProfileWriteError({ code: 'PGRST301', message: 'JWT expired' })).toEqual({
      code: 'AUTH_REQUIRED',
      reason: 'session_rejected_by_postgrest',
    });
    expect(
      classifyProfileWriteError({ code: '42501', message: 'row-level security policy' }),
    ).toEqual({ code: 'AUTH_REQUIRED', reason: 'update_denied_by_rls' });
  });

  it('treats a refused value as a defect on Jamee\u2019s side', () => {
    // parseProfileSettings only emits a member of the enum, so reaching these means the enum and
    // the check constraint have drifted apart.
    expect(classifyProfileWriteError({ code: '23514', message: 'check constraint' })).toEqual({
      code: 'INTERNAL_ERROR',
      reason: 'value_rejected_by_column_constraint',
    });
    expect(classifyProfileWriteError({ code: '23502', message: 'null value' })).toEqual({
      code: 'INTERNAL_ERROR',
      reason: 'value_rejected_by_column_constraint',
    });
  });

  it('does not guess at a code it does not know', () => {
    expect(classifyProfileWriteError({ code: '08006', message: 'connection failure' })).toEqual({
      code: 'INTERNAL_ERROR',
      reason: 'profile_update_failed',
    });
    expect(classifyProfileWriteError({ code: '', message: '' })).toEqual({
      code: 'INTERNAL_ERROR',
      reason: 'profile_update_failed',
    });
  });

  it('maps every code it returns to a message a farmer can read', () => {
    // The mapping is only worth as much as the copy behind it, in all three languages.
    for (const raw of ['PGRST301', '42501', '23514', '08006']) {
      const { code } = classifyProfileWriteError({ code: raw, message: '' });
      for (const language of LANGUAGE_OPTIONS) {
        const { error } = toEnvelope(new AppError(code), language);
        expect(error.message.length).toBeGreaterThan(0);
      }
    }
  });
});

/* ========================================================================== */
/* A profiles table that behaves like the migration                             */
/* ========================================================================== */

interface FakeProfile {
  id: string;
  phone: string;
  display_name: string | null;
  /**
   * `Language`, not `string`, and that is a finding rather than a convenience: the write seam is
   * typed `ProfileSettingsWrite`, so a value outside the enum cannot reach a `profiles` update
   * through this module at all. The `language in ('en','hi','mr')` check constraint is therefore
   * unreachable from here, and the `23514` branch is tested directly against
   * `classifyProfileWriteError` instead of being staged through a fake that could not receive it.
   */
  language: Language;
}

interface FakeTable {
  /** The statement a caller would build: read this farmer's row. */
  query(userId: string): ProfileSettingsQuery;
  /** The statement a caller would build: update this farmer's row and return it. */
  mutate(userId: string): ProfileSettingsMutation;
  rows: Map<string, FakeProfile>;
  /** Every payload the module handed to a statement, in order. */
  payloads: ProfileSettingsWrite[];
}

/**
 * `session` is the id `auth.uid()` would return. It is what makes `profiles_update_own` a real
 * predicate here rather than a comment: a statement naming any other row matches nothing, exactly as
 * RLS would, and the update then reports zero rows instead of failing.
 */
function fakeProfiles(options: {
  session: string;
  seed?: readonly FakeProfile[];
  failWith?: { code: string; message: string };
}): FakeTable {
  const rows = new Map<string, FakeProfile>(
    (options.seed ?? []).map((row) => [row.id, { ...row }]),
  );
  const payloads: ProfileSettingsWrite[] = [];

  /** `profiles_select_own` / `profiles_update_own`: own row only, nothing for anyone else's. */
  function visible(userId: string): FakeProfile | undefined {
    return userId === options.session ? rows.get(userId) : undefined;
  }

  return {
    rows,
    payloads,

    query(userId) {
      return () => {
        if (options.failWith !== undefined) {
          return Promise.resolve({ data: null, error: options.failWith });
        }
        const row = visible(userId);
        return Promise.resolve({
          data:
            row === undefined
              ? null
              : { display_name: row.display_name, language: row.language },
          error: null,
        });
      };
    },

    mutate(userId) {
      return (values) => {
        payloads.push({ ...values });

        if (options.failWith !== undefined) {
          return Promise.resolve({ data: null, error: options.failWith });
        }

        /**
         * `using (auth.uid() = id)` FILTERS. A row that does not match is not visible to the
         * statement, so the update succeeds with no rows rather than raising.
         */
        const row = visible(userId);
        if (row === undefined) return Promise.resolve({ data: [], error: null });

        /** `set` touches the payload's columns and nothing else — `phone` is not in the payload. */
        row.display_name = values.display_name;
        row.language = values.language;

        return Promise.resolve({
          data: [{ display_name: row.display_name, language: row.language }],
          error: null,
        });
      };
    },
  };
}

/** A statement that is a tripwire rather than a stand-in: reaching it fails the test. */
function unreachableMutation(): ProfileSettingsMutation {
  return () => {
    throw new Error('the profiles table was reached; the submitted values should have been refused');
  };
}

function farmer(overrides: Partial<FakeProfile> = {}): FakeProfile {
  return {
    id: USER,
    phone: '+919876543210',
    display_name: null,
    language: 'en',
    ...overrides,
  };
}

/** The `AppError` a synchronous call threw. Anything else is a real failure and is rethrown. */
function failureOf(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to throw');
}

async function asyncFailureOf(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to throw');
}

/* ========================================================================== */
/* readProfileSettings                                                         */
/* ========================================================================== */

describe('readProfileSettings', () => {
  it('reads back what the farmer saved', async () => {
    const table = fakeProfiles({
      session: USER,
      seed: [farmer({ display_name: 'Asha', language: 'mr' })],
    });

    await expect(readProfileSettings(table.query(USER), USER)).resolves.toEqual({
      displayName: 'Asha',
      language: 'mr',
    });
  });

  it('returns null when the farmer has no profile row', async () => {
    const table = fakeProfiles({ session: USER });

    await expect(readProfileSettings(table.query(USER), USER)).resolves.toBeNull();
  });

  it('sees nothing for a row the session does not own', async () => {
    // RLS, not this function, is what makes that true — the fake enforces it the same way.
    const table = fakeProfiles({ session: USER, seed: [farmer({ id: OTHER_USER })] });

    await expect(readProfileSettings(table.query(OTHER_USER), OTHER_USER)).resolves.toBeNull();
  });

  it('fails loudly rather than rendering defaults it did not read', async () => {
    const table = fakeProfiles({
      session: USER,
      failWith: { code: '08006', message: 'connection failure' },
    });

    const error = await asyncFailureOf(() => readProfileSettings(table.query(USER), USER));

    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.context?.reason).toBe('profile_read_failed');
  });
});

/* ========================================================================== */
/* saveProfileSettings                                                         */
/* ========================================================================== */

describe('saveProfileSettings', () => {
  it('persists both values on the farmer\u2019s own row (Requirement 1.8)', async () => {
    const table = fakeProfiles({ session: USER, seed: [farmer()] });

    const settings = await saveProfileSettings(table.mutate(USER), USER, {
      displayName: 'Asha',
      language: 'mr',
    });

    expect(settings).toEqual({ displayName: 'Asha', language: 'mr' });
    expect(table.rows.get(USER)).toMatchObject({ display_name: 'Asha', language: 'mr' });
  });

  it('writes only display_name and language, so a phone cannot be overwritten', async () => {
    // The other half of the arrangement in ensure-profile.ts: that upsert carries only id+phone, so
    // a sign-in cannot reset these two; this write carries only these two, so the screen cannot
    // reset the identity Requirement 1.5 depends on.
    const table = fakeProfiles({ session: USER, seed: [farmer()] });

    await saveProfileSettings(table.mutate(USER), USER, { displayName: 'Asha', language: 'hi' });

    expect(table.payloads).toHaveLength(1);
    const payload = table.payloads[0];
    expect(payload === undefined ? [] : Object.keys(payload).sort()).toEqual([
      'display_name',
      'language',
    ]);
    expect(table.rows.get(USER)?.phone).toBe('+919876543210');
  });

  it('returns what the database holds, not what the form hoped', async () => {
    const table = fakeProfiles({ session: USER, seed: [farmer()] });

    const settings = await saveProfileSettings(table.mutate(USER), USER, {
      displayName: '   ',
      language: 'en',
    });

    // The read-back carries the normalization, so the screen shows the stored state.
    expect(settings.displayName).toBeNull();
    expect(table.rows.get(USER)?.display_name).toBeNull();
  });

  it('attempts no write when the submitted language is unsupported', async () => {
    const error = await asyncFailureOf(() =>
      saveProfileSettings(unreachableMutation(), USER, { displayName: 'Asha', language: 'ta' }),
    );

    expect(error.code).toBe('LANGUAGE_UNSUPPORTED');
  });

  it('does not report a save when no row was updated', async () => {
    // A session that no longer owns the row, and the farmer with no profile row at all: RLS filters
    // both to zero rows, and "Saved" would be the one dishonest thing available here.
    const table = fakeProfiles({ session: USER, seed: [farmer({ id: OTHER_USER })] });

    const error = await asyncFailureOf(() =>
      saveProfileSettings(table.mutate(OTHER_USER), OTHER_USER, { displayName: 'Asha', language: 'hi' }),
    );

    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.context?.reason).toBe('profile_row_not_visible_to_session');
    // The other farmer's row is untouched.
    expect(table.rows.get(OTHER_USER)).toMatchObject({ display_name: null, language: 'en' });
  });

  it('maps a refused write onto the taxonomy', async () => {
    const table = fakeProfiles({
      session: USER,
      seed: [farmer()],
      failWith: { code: 'PGRST301', message: 'JWT expired' },
    });

    const error = await asyncFailureOf(() =>
      saveProfileSettings(table.mutate(USER), USER, { displayName: 'Asha', language: 'hi' }),
    );

    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.context?.reason).toBe('session_rejected_by_postgrest');
  });

  it('keeps the farmer\u2019s name and phone out of the log context', async () => {
    // A display name is farmer-authored content and a phone is the identity itself. The user id
    // names the row just as precisely.
    const table = fakeProfiles({
      session: USER,
      seed: [farmer()],
      failWith: { code: '08006', message: 'connection failure' },
    });

    const error = await asyncFailureOf(() =>
      saveProfileSettings(table.mutate(USER), USER, { displayName: 'Asha', language: 'hi' }),
    );

    const context = JSON.stringify(error.context);
    expect(context).not.toContain('Asha');
    expect(context).not.toContain('9876543210');
    expect(context).toContain(USER);
  });
});
