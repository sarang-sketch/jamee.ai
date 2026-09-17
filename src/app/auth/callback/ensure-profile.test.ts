import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AFTER_SIGN_IN_PATH } from '@/components/SignInForm';
import { isAppError, type AppError } from '@/lib/errors';

import {
  DEFAULT_NEXT_PATH,
  E164_PHONE,
  classifyProfileWriteError,
  ensureProfile,
  safeNextPath,
  toE164,
  type ProfileWriterLike,
} from './ensure-profile';

/**
 * Unit tests for the three decisions the callback route makes without a network: what E.164 form
 * the auth user's phone takes, what the profile upsert writes and how it reacts to each residual
 * failure of the trigger in `0002_profiles.sql`, and where the browser is allowed to go next.
 *
 * Requirements: 1.4, 1.5
 * Design: D8
 *
 * The fake `profiles` table below is not a yes-man. It enforces the two constraints the migration
 * declares — `profiles_phone_e164` and the unique index on `phone` — and it applies
 * `on conflict (id) do update` to **only the columns in the payload**, which is Postgres's actual
 * behaviour. That is what lets the conflict test assert something real: the 23505 is *derived* from
 * a seeded row holding the same phone, not handed to the code by a stub. What these tests cannot
 * cover is whether Postgres agrees — that the policies admit the write, that the constraint names
 * match, that concurrent sign-ins serialize. Task 29.1's harness runs against a real database and
 * is where the round trip belongs: sign in twice as one farmer and assert a single row with a
 * preserved `display_name` and `language`; sign in as a farmer whose phone another profile already
 * holds and assert the coded failure rather than a 500 with a stack.
 *
 * Property 1 (identity round-trip across channels) is task 6.5's and is not written here.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const PHONE = '+919876543210';

/* ========================================================================== */
/* toE164                                                                      */
/* ========================================================================== */

describe('toE164', () => {
  it('leaves a number that already carries its + alone', () => {
    expect(toE164(PHONE)).toBe(PHONE);
    expect(toE164('+14155552671')).toBe('+14155552671');
  });

  it('restores a stripped + over the same digits', () => {
    /**
     * The digits are taken as the WHOLE number, which is the only correct reading: what reaches
     * here is `auth.users.phone`, and Auth validated it as an E.164 number — including its country
     * code — before storing it. Prefixing `+` re-expresses that value in the form the
     * `profiles_phone_e164` check requires and changes no digit.
     */
    expect(toE164('919876543210')).toBe(PHONE);
    expect(toE164('14155552671')).toBe('+14155552671');
  });

  it('strips separators, which carry no meaning', () => {
    expect(toE164('+91 98765 43210')).toBe(PHONE);
    expect(toE164('+91-98765-43210')).toBe(PHONE);
    expect(toE164(' (+91) 98765 43210 ')).toBe(PHONE);
    expect(toE164('91\u201198765\u201143210')).toBe(PHONE);
  });

  it('returns null for an absent phone rather than inventing one', () => {
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
    expect(toE164('')).toBeNull();
    expect(toE164('   ')).toBeNull();
  });

  it('returns null for anything the database check would refuse', () => {
    // A country code cannot begin with zero.
    expect(toE164('+0919876543210')).toBeNull();
    // Seven digits: one short of E.164's minimum of eight.
    expect(toE164('+1234567')).toBeNull();
    // Sixteen digits: one past E.164's maximum of fifteen.
    expect(toE164('+1234567890123456')).toBeNull();
    expect(toE164('not-a-number')).toBeNull();
    expect(toE164('+91-98765-4321x')).toBeNull();
    // A second + is not a separator, so it survives the strip and fails the check.
    expect(toE164('++919876543210')).toBeNull();
  });
});

/* ========================================================================== */
/* The trigger in 0002 must normalize the same way this module does             */
/* ========================================================================== */

/**
 * `handle_new_user()` writes `profiles.phone` at signup; `ensureProfile` writes it again on every
 * later session. Requirement 1.5 makes that column the single cross-channel Farmer identity, so two
 * normalizers that disagreed would give one farmer two identities — a worse outcome than the
 * `+`-less phone the trigger used to copy verbatim (GoTrue stores the number without its leading
 * `+`; `profiles_phone_e164` requires it).
 *
 * So the trigger's own literals are read back out of the migration and checked against this
 * module's, the way `SignInForm.test.tsx` checks the browser's copy of the E.164 pattern against
 * the check constraint. A divergence fails here rather than being discovered as a misrouted
 * WhatsApp conversation.
 *
 * Requirements: 1.4, 1.5
 * Design: D8
 */
describe('handle_new_user() normalizes the same way toE164 does', () => {
  const migration = readFileSync(
    resolve(process.cwd(), 'supabase', 'migrations', '0002_profiles.sql'),
    'utf8',
  );

  /** The pattern the trigger rejects against — the `!~` literal in its body. */
  const triggerE164 = /v_candidate !~ '([^']+)'/.exec(migration)?.[1];

  /** The separator class it strips — the second argument to its `regexp_replace`. */
  const triggerSeparators = /regexp_replace\(\s*new\.phone,\s*'([^']+)'/.exec(migration)?.[1];

  it('rejects against the same E.164 pattern this module and the constraint use', () => {
    expect(triggerE164).toBe(E164_PHONE.source);
  });

  /**
   * `SEPARATORS` is `/[\s()\u2010-\u2015-]/`. The SQL spells the dash range out character by
   * character because a bracket-expression range in Postgres is collating-sequence dependent, so
   * the two literals are equivalent rather than identical — which is exactly why this is pinned.
   */
  it('strips the same separator set', () => {
    expect(triggerSeparators).toBe('[\\s()\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015-]');
  });

  it('names no separator this module would keep', () => {
    const escaped = [...(triggerSeparators ?? '').matchAll(/\\u([0-9a-f]{4})/g)].map((match) =>
      String.fromCodePoint(Number.parseInt(match[1]!, 16)),
    );
    // The class's literal members, plus two characters standing in for its `\s`.
    const separators = [...escaped, '(', ')', '-', ' ', '\t'];

    expect(escaped).toHaveLength(6);
    for (const separator of separators) {
      expect(toE164(`+91${separator}98765${separator}43210`)).toBe(PHONE);
    }
  });
});

/* ========================================================================== */
/* A profiles table that behaves like the migration                            */
/* ========================================================================== */

interface FakeProfile {
  id: string;
  phone: string;
  display_name: string | null;
  language: 'en' | 'hi' | 'mr';
  /** Stands in for `updated_at`, which the `profiles_set_updated_at` trigger moves on update. */
  revision: number;
}

interface UpsertCall {
  values: { id: string; phone: string };
  options: { onConflict: string; ignoreDuplicates: boolean };
}

interface FakeTable {
  writer: ProfileWriterLike;
  rows: Map<string, FakeProfile>;
  calls: UpsertCall[];
}

function fakeProfiles(seed: readonly FakeProfile[] = []): FakeTable {
  const rows = new Map<string, FakeProfile>(seed.map((row) => [row.id, { ...row }]));
  const calls: UpsertCall[] = [];
  let revision = seed.length;

  const writer: ProfileWriterLike = {
    from() {
      return {
        upsert(values, options) {
          calls.push({ values: { ...values }, options: { ...options } });

          /** `profiles_phone_e164`. */
          if (!/^\+[1-9][0-9]{7,14}$/.test(values.phone)) {
            return Promise.resolve({
              error: {
                code: '23514',
                message: 'new row violates check constraint "profiles_phone_e164"',
              },
            });
          }

          /**
           * The unique index on `phone` — and the whole reason this module exists. `on conflict
           * (id)` below does NOT absorb this, exactly as `0002_profiles.sql` documents.
           */
          for (const row of rows.values()) {
            if (row.id !== values.id && row.phone === values.phone) {
              return Promise.resolve({
                error: {
                  code: '23505',
                  message: 'duplicate key value violates unique constraint "profiles_phone_key"',
                },
              });
            }
          }

          revision += 1;
          const existing = rows.get(values.id);

          if (existing === undefined) {
            rows.set(values.id, {
              id: values.id,
              phone: values.phone,
              display_name: null,
              language: 'en',
              revision,
            });
          } else if (!options.ignoreDuplicates) {
            /** `do update set` covers the payload's columns and nothing else. */
            existing.phone = values.phone;
            existing.revision = revision;
          }

          return Promise.resolve({ error: null });
        },
      };
    },
  };

  return { writer, rows, calls };
}

/**
 * A table that is a tripwire rather than a stand-in: touching it fails the test. That is what makes
 * the no-phone case assert something worth asserting — not "the right error came back", but that no
 * write was attempted at all.
 */
function unreachableWriter(): ProfileWriterLike {
  return {
    from() {
      throw new Error('the profiles table was reached; ensureProfile should have refused first');
    },
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected ensureProfile to throw');
}

/* ========================================================================== */
/* ensureProfile                                                               */
/* ========================================================================== */

describe('ensureProfile', () => {
  it('creates the row Requirement 1.4 describes when the trigger left none', async () => {
    const table = fakeProfiles();

    const row = await ensureProfile(table.writer, { id: USER, phone: PHONE });

    expect(row).toEqual({ id: USER, phone: PHONE });
    expect(table.rows.get(USER)?.phone).toBe(PHONE);
    expect(table.rows.get(USER)?.id).toBe(USER);
  });

  it('writes only id and phone, so nothing else on the row can be reset', async () => {
    // Guarding the payload's SHAPE, because it is what keeps task 6.4's values safe.
    const table = fakeProfiles();

    await ensureProfile(table.writer, { id: USER, phone: PHONE });

    expect(table.calls).toHaveLength(1);
    const call = table.calls[0];
    expect(call === undefined ? [] : Object.keys(call.values).sort()).toEqual(['id', 'phone']);
    expect(call?.options).toEqual({ onConflict: 'id', ignoreDuplicates: false });
  });

  it('is safe on every sign-in: a repeat leaves the farmer\u2019s own values intact', async () => {
    const table = fakeProfiles();
    await ensureProfile(table.writer, { id: USER, phone: PHONE });

    // What task 6.4's profile screen writes, between two sign-ins.
    const saved = table.rows.get(USER);
    expect(saved).toBeDefined();
    if (saved !== undefined) {
      saved.display_name = 'Asha';
      saved.language = 'mr';
    }

    await ensureProfile(table.writer, { id: USER, phone: PHONE });

    expect(table.rows.size).toBe(1);
    expect(table.rows.get(USER)).toMatchObject({
      id: USER,
      phone: PHONE,
      display_name: 'Asha',
      language: 'mr',
    });
  });

  it('brings a stale phone back in line with the auth user', async () => {
    // Requirement 1.5: a profile phone that no longer matches Auth misroutes the WhatsApp channel.
    const table = fakeProfiles([
      { id: USER, phone: '+919999999999', display_name: 'Asha', language: 'hi', revision: 1 },
    ]);

    await ensureProfile(table.writer, { id: USER, phone: PHONE });

    expect(table.rows.get(USER)).toMatchObject({
      phone: PHONE,
      display_name: 'Asha',
      language: 'hi',
    });
  });

  it('stores the E.164 form even when Auth handed over bare digits', async () => {
    const table = fakeProfiles();

    await ensureProfile(table.writer, { id: USER, phone: '919876543210' });

    expect(table.rows.get(USER)?.phone).toBe(PHONE);
  });

  it('refuses without a write when the auth user has no usable phone', async () => {
    // Residual mode one from `0002_profiles.sql`: an auth user created with a null phone.
    for (const user of [{ id: USER }, { id: USER, phone: null }, { id: USER, phone: '  ' }]) {
      const error = await failureOf(() => ensureProfile(unreachableWriter(), user));

      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.context?.reason).toBe('auth_user_has_no_e164_phone');
      expect(error.context?.userId).toBe(USER);
    }
  });

  it('names the conflict when another profile already holds the phone', async () => {
    // Residual mode two: the unique violation `on conflict (id)` cannot catch.
    const table = fakeProfiles([
      { id: OTHER_USER, phone: PHONE, display_name: null, language: 'en', revision: 1 },
    ]);

    const error = await failureOf(() => ensureProfile(table.writer, { id: USER, phone: PHONE }));

    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.context?.reason).toBe('profile_phone_owned_by_another_user');
    // The other farmer's row is untouched, and no half-written row appeared for this one.
    expect(table.rows.size).toBe(1);
    expect(table.rows.get(OTHER_USER)?.phone).toBe(PHONE);
  });

  it('keeps the phone out of the log context', async () => {
    // A phone is the farmer's identity (Requirement 1.5). The user id names the row just as well.
    const table = fakeProfiles([
      { id: OTHER_USER, phone: PHONE, display_name: null, language: 'en', revision: 1 },
    ]);

    const error = await failureOf(() => ensureProfile(table.writer, { id: USER, phone: PHONE }));

    expect(JSON.stringify(error.context)).not.toContain('9876543210');
  });
});

describe('classifyProfileWriteError', () => {
  it('maps each SQLSTATE the profiles upsert can return', () => {
    expect(classifyProfileWriteError({ code: '23505', message: 'duplicate key' })).toBe(
      'profile_phone_owned_by_another_user',
    );
    expect(classifyProfileWriteError({ code: '23514', message: 'check constraint' })).toBe(
      'profile_phone_rejected_by_e164_check',
    );
    expect(classifyProfileWriteError({ code: '23502', message: 'null value' })).toBe(
      'profile_phone_rejected_by_e164_check',
    );
    expect(classifyProfileWriteError({ code: '42501', message: 'row-level security' })).toBe(
      'profile_upsert_denied_by_rls',
    );
  });

  it('does not guess at a code it does not know', () => {
    expect(classifyProfileWriteError({ code: '08006', message: 'connection failure' })).toBe(
      'profile_upsert_failed',
    );
    expect(classifyProfileWriteError({ code: '', message: '' })).toBe('profile_upsert_failed');
  });
});

/* ========================================================================== */
/* safeNextPath                                                                */
/* ========================================================================== */

describe('safeNextPath', () => {
  it('keeps a same-origin path', () => {
    expect(safeNextPath('/diagnose')).toBe('/diagnose');
    expect(safeNextPath('/history?page=2')).toBe('/history?page=2');
  });

  it('falls back to the default when nothing was asked for', () => {
    expect(safeNextPath(null)).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath(undefined)).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('')).toBe(DEFAULT_NEXT_PATH);
  });

  it('sends nobody off-origin', () => {
    // An open redirect from Jamee's own domain, one query parameter away.
    expect(safeNextPath('https://not-jamee.example/steal')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('//not-jamee.example/steal')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('/\\not-jamee.example/steal')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('javascript:alert(1)')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('diagnose')).toBe(DEFAULT_NEXT_PATH);
  });

  it('agrees with where the sign-in form sends a verified farmer', () => {
    // The wiring between task 6.1 and this route, pinned so it cannot rot silently.
    const url = new URL(AFTER_SIGN_IN_PATH, 'https://jamee.example');
    expect(url.pathname).toBe('/auth/callback');
    expect(safeNextPath(url.searchParams.get('next'))).toBe(DEFAULT_NEXT_PATH);
  });
});
