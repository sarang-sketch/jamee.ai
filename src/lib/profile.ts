import { AppError } from '@/lib/errors';
import { languageSchema, type ErrorCode, type Language } from '@/lib/schemas';
import type { Database } from '@/types/database';

/**
 * The farmer's own profile settings: the display name and the preferred language.
 *
 * Requirements: 1.8 (a submitted display name and preferred Supported_Language are persisted on
 *               that Farmer's Profile), 9.1 (English, Hindi and Marathi are the selectable
 *               languages), 13.2 (own-row only)
 * Design: "Frontend" — `/profile` is a server shell plus a client form; "Defence in depth" — RLS
 *          is the authorization boundary and the application check is a second layer, not the only
 *          one
 *
 * ### Why this is a module in `lib/` rather than code inside `app/profile/page.tsx`
 *
 * The saved language is not this screen's private state — it is what every other screen defaults
 * to. Requirement 9.2's switcher (task 12.3) needs the same read to know which option to preselect,
 * and the `/diagnose`, `/chat` and `/voice` server shells each need it to pick a catalog. So the
 * read lives here, takes the statement as an argument, and is callable from any server component:
 *
 *     const supabase = await createServerSupabase();
 *     const settings = await readProfileSettings(
 *       () => supabase.from('profiles').select(PROFILE_SETTINGS_SELECT).eq('id', userId).maybeSingle(),
 *       userId,
 *     );
 *
 * ### No `import 'server-only'`, on purpose
 *
 * `readProfileSettings` runs on the server and `saveProfileSettings` runs in the browser, and both
 * are the same two columns under the same policies — so marking this module server-only would
 * force the write to be duplicated in a client file. What keeps that safe is that this module
 * touches **no client at all**: the caller passes in a statement it built from its own client, so
 * the browser's is the anon-key one (RLS applies) and the server's is the cookie-scoped one (RLS
 * applies). Neither can be the service-role client, because `createAdminClient()` lives behind its
 * own `server-only` marker and nothing here reaches for it — `profiles_update_own` already checks
 * `auth.uid() = id`, so bypassing RLS would move this write outside Jamee's authorization boundary
 * for no capability at all.
 *
 * ### What this module must never write
 *
 * `phone` and `id`. Requirement 1.5 makes `phone` the single cross-channel identity, and
 * `src/app/auth/callback/ensure-profile.ts` owns it: that upsert deliberately carries **only**
 * `id` and `phone`, because PostgREST builds `on conflict do update` from the keys present in the
 * payload — which is what stops a sign-in from resetting the two values this screen saves. The
 * symmetry is what makes the pair safe, so it holds in both directions: this write carries only
 * `display_name` and `language`, and a change that added `phone` here would let this screen
 * overwrite a farmer's identity.
 */

/* ========================================================================== */
/* The two columns, and the shape they take in the application                 */
/* ========================================================================== */

type ProfileRow = Database['public']['Tables']['profiles']['Row'];
type ProfileUpdate = Database['public']['Tables']['profiles']['Update'];

/**
 * The row slice this module reads, as a `Pick` of the generated row type so it cannot drift from
 * the table. `phone`, `id`, `created_at` and `updated_at` are deliberately absent: a screen that
 * does not select an identity column cannot leak one into a client bundle.
 */
export type ProfileSettingsRow = Pick<ProfileRow, 'display_name' | 'language'>;

/**
 * The payload of the update, with both columns **required**.
 *
 * `Required<Pick<…>>` rather than a hand-written interface: `Update` makes every column optional,
 * and `Required` both ties this to the generated type and states that a save always carries both
 * values. A partial write would silently leave whichever field the form did not send at its old
 * value, which is not what "persist both values" means.
 */
export type ProfileSettingsWrite = Required<Pick<ProfileUpdate, 'display_name' | 'language'>>;

/**
 * The column list, in one place, so the read and the write's `returning` cannot disagree.
 *
 * `as const` matters to the compiler, not just to the reader: PostgREST parses a select string at
 * the **type** level to work out the row shape, and handing that parser the wide `string` type
 * instead of this literal makes it instantiate over every shape a select could take. Drop the
 * `as const` and the call sites stop compiling.
 */
export const PROFILE_SETTINGS_SELECT = 'display_name, language' as const;

/** The same two values in application terms. `null` display name means the farmer has not set one. */
export interface ProfileSettings {
  displayName: string | null;
  language: Language;
}

/**
 * `language not null default 'en'` in `0002_profiles.sql`. Stated here so a screen with no profile
 * row to read renders the same language the database would have given it, rather than a second
 * opinion about what the default is.
 */
export const DEFAULT_LANGUAGE: Language = 'en';

/** Requirement 9.1's three options, in the order the form offers them. */
export const LANGUAGE_OPTIONS: readonly Language[] = languageSchema.options;

/* ========================================================================== */
/* The statement seams                                                         */
/* ========================================================================== */

/** The slice of a PostgREST error this module reads. `PostgrestError` satisfies it. */
export interface ProfileQueryError {
  code: string;
  message: string;
}

/**
 * The read, as a function the caller supplies:
 *
 *     () => supabase.from('profiles').select(PROFILE_SETTINGS_SELECT).eq('id', userId).maybeSingle()
 *
 * `PromiseLike` rather than `Promise` because a PostgREST builder is thenable, not a `Promise`.
 */
export type ProfileSettingsQuery = () => PromiseLike<{
  data: ProfileSettingsRow | null;
  error: ProfileQueryError | null;
}>;

/**
 * The write, as a function the caller supplies. This module builds the payload; the caller builds
 * the statement around it:
 *
 *     (values) =>
 *       supabase.from('profiles').update(values).eq('id', userId).select(PROFILE_SETTINGS_SELECT)
 *
 * The trailing `select` is not decoration. A PostgREST `update` whose `using` predicate matches no
 * row **succeeds with zero rows** — RLS filters rather than errors — so without asking for the
 * updated rows back, a write that changed nothing is indistinguishable from a write that saved. It
 * also means the value returned to the screen is what the database now holds rather than what the
 * form hoped it would.
 *
 * ### Why a function rather than a client-shaped interface
 *
 * `lib/storage.ts` and `auth/callback/ensure-profile.ts` both take a **structural slice of a
 * client** (`StorageClientLike`, `ProfileWriterLike`), and this module was written that way first.
 * It does not survive contact with the browser client: relating
 * `ReturnType<typeof createBrowserClient<Database>>` to an interface declaring
 * `from(table: 'profiles') → { update … }` makes the compiler evaluate PostgREST's generic query
 * machinery — `RejectExcessProperties`, the select-string parser, the builder's own `then` — and it
 * fails with TS2589, "type instantiation is excessively deep". Verified both ways: the same seam
 * shape compiles against the RLS-scoped **server** client and fails against the browser client, for
 * reads as well as writes, which is why both seams here are functions and not one of each.
 *
 * The function seam is not a workaround with a cost — it type-checks *more*. The statement at the
 * call site is checked by supabase-js's own types against the real schema, and its result type is
 * checked against the shape declared here. What moves out of this module is the statement's shape:
 * that it selects these two columns and filters on the caller's id. The compiler still checks it at
 * each call site, and RLS — not the filter — is what confines the write to one row.
 */
export type ProfileSettingsMutation = (values: ProfileSettingsWrite) => PromiseLike<{
  data: ProfileSettingsRow[] | null;
  error: ProfileQueryError | null;
}>;

/* ========================================================================== */
/* Validating what the form submitted                                          */
/* ========================================================================== */

/** What arrives from the form: two strings, neither of them trusted. */
export interface ProfileSettingsInput {
  displayName: string;
  /** A `<select>` value, so a string until the enum says otherwise. */
  language: string;
}

/**
 * The display name as it should be stored, or `null`.
 *
 * Two normalizations, and **no length rule**:
 *  - surrounding whitespace is stripped, because it is not part of a name;
 *  - a name that is empty after that becomes `null`, not `''`. The column is nullable and its
 *    absence means "not set", so a farmer clearing the field should return the row to that state
 *    rather than store a blank string that every reader then has to treat as blank.
 *
 * There is no maximum length here because `display_name` is unconstrained `text` in
 * `0002_profiles.sql`. Inventing a ceiling would create a rejection the database would not make,
 * and it would need a farmer-facing sentence that exists in no catalog — the same reasoning that
 * keeps `ensure-profile.ts`'s E.164 regex identical to the check constraint rather than stricter
 * than it. If a limit is wanted, it belongs in the migration first.
 */
export function normalizeDisplayName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The submitted values, validated and normalized — or `LANGUAGE_UNSUPPORTED`.
 *
 * The language is checked against `languageSchema`, the enum `schemas.ts` declares once and the
 * `language in ('en','hi','mr')` check constraint mirrors. It is not re-listed here: a fourth
 * language would then be supported in one place and refused in another, and Requirement 9.1's set
 * would have two owners.
 *
 * A `<select>` cannot normally produce anything else, which is exactly why this check exists — the
 * value that reaches a write is whatever the DOM was holding, and a stale bundle or a tampered
 * page is the case worth being correct about. `LANGUAGE_UNSUPPORTED` is Requirement 9.5's code and
 * its envelope already names the three supported codes, so the farmer-facing sentence comes from
 * the catalog rather than from here.
 */
export function parseProfileSettings(input: ProfileSettingsInput): ProfileSettings {
  const language = languageSchema.safeParse(input.language);
  if (!language.success) {
    throw new AppError('LANGUAGE_UNSUPPORTED', {
      context: { reason: 'language_outside_supported_set' },
    });
  }

  return {
    displayName: normalizeDisplayName(input.displayName),
    language: language.data,
  };
}

/* ========================================================================== */
/* Mapping a failed write onto the taxonomy                                    */
/* ========================================================================== */

/** Why a save failed, in one word, for the server log. Never rendered to a farmer. */
export type ProfileWriteReason =
  | 'session_rejected_by_postgrest'
  | 'update_denied_by_rls'
  | 'value_rejected_by_column_constraint'
  | 'profile_row_not_visible_to_session'
  | 'profile_read_failed'
  | 'profile_update_failed';

export interface ProfileWriteFailure {
  code: ErrorCode;
  reason: ProfileWriteReason;
}

/**
 * Which coded error a failed `profiles` update is.
 *
 * Classification is on the error code alone, never on the message text — Postgres's own prose can
 * be reworded or localized between versions, and a classifier that read it would quietly decay into
 * the default branch.
 *
 * The two farmer-actionable branches map to `AUTH_REQUIRED`, and that is a deliberate reading of
 * both: `42501` is the policy refusing this row, and `PGRST301` is PostgREST refusing the JWT. In
 * either case the farmer's session no longer proves ownership of the row they are editing, and the
 * remedy is to sign in again — which is exactly what `AUTH_REQUIRED`'s message says. The
 * alternative, `INTERNAL_ERROR`, would tell a farmer with an expired session that Jamee is broken
 * and leave them retrying a request that cannot succeed.
 *
 * `23514` / `23502` are the opposite: the value this module built was refused by the column. Since
 * `parseProfileSettings` only ever emits a member of `languageSchema`, reaching one of them means
 * the enum and the check constraint have drifted apart — a deployment defect, not something the
 * farmer did, so it is a logged `INTERNAL_ERROR` rather than a message about their input.
 */
export function classifyProfileWriteError(error: ProfileQueryError): ProfileWriteFailure {
  switch (error.code) {
    /** PostgREST's own code for an absent, malformed or expired JWT. */
    case 'PGRST301':
      return { code: 'AUTH_REQUIRED', reason: 'session_rejected_by_postgrest' };

    case '42501':
      return { code: 'AUTH_REQUIRED', reason: 'update_denied_by_rls' };

    case '23514':
    case '23502':
      return { code: 'INTERNAL_ERROR', reason: 'value_rejected_by_column_constraint' };

    default:
      return { code: 'INTERNAL_ERROR', reason: 'profile_update_failed' };
  }
}

/**
 * A coded failure carrying its reason in the log context and nothing farmer-identifying in it.
 *
 * The user id names the row; the display name and the phone do not go in, because a name is
 * farmer-authored content and the phone is the identity itself (Requirement 1.5). The farmer-facing
 * text is rendered from the catalog by `toEnvelope`, which never reads this context.
 */
function failure(
  { code, reason }: ProfileWriteFailure,
  userId: string,
  cause?: unknown,
): AppError {
  return new AppError(code, {
    context: { reason, userId },
    ...(cause === undefined ? {} : { cause }),
  });
}

/* ========================================================================== */
/* Read                                                                        */
/* ========================================================================== */

/**
 * The farmer's saved settings, or `null` when they have no profile row.
 *
 * `maybeSingle()` because "no row" is a state rather than an error here, and RLS makes the result
 * either the caller's own row or nothing — `.eq('id', userId)` is the second layer the design's
 * defence-in-depth note asks for, not the thing that makes this safe.
 *
 * A **query** failure throws instead of degrading to defaults. This screen's entire content is
 * these two values, and rendering `en` with an empty name because a read failed would show a farmer
 * settings they do not have and invite them to overwrite the ones they do.
 */
export async function readProfileSettings(
  query: ProfileSettingsQuery,
  userId: string,
): Promise<ProfileSettings | null> {
  const { data, error } = await query();

  if (error !== null) {
    throw failure(
      { code: 'INTERNAL_ERROR', reason: 'profile_read_failed' },
      userId,
      error,
    );
  }

  if (data === null) return null;

  return { displayName: data.display_name, language: data.language };
}

/* ========================================================================== */
/* Write                                                                       */
/* ========================================================================== */

/**
 * Persist both values on the farmer's own profile and return what the database now holds.
 *
 * Requirement 1.8 in one statement. The returned value is read back from the row rather than echoed
 * from the input, so the screen shows what was actually stored — including the normalization this
 * module applied on the way in.
 *
 * Zero updated rows is treated as `AUTH_REQUIRED` rather than as success. It means one of two
 * things, and the same remedy fixes both: the session no longer owns the row, or the profile row
 * does not exist — and signing in again runs the callback's bootstrap upsert, which creates it.
 * Reporting "Saved" for a write that changed nothing would be the one dishonest outcome available
 * here.
 */
export async function saveProfileSettings(
  mutate: ProfileSettingsMutation,
  userId: string,
  input: ProfileSettingsInput,
): Promise<ProfileSettings> {
  const settings = parseProfileSettings(input);

  /** Exactly two columns. Never `phone`, never `id` — see the module header. */
  const values: ProfileSettingsWrite = {
    display_name: settings.displayName,
    language: settings.language,
  };

  const { data, error } = await mutate(values);

  if (error !== null) {
    throw failure(classifyProfileWriteError(error), userId, error);
  }

  const saved = data === null ? undefined : data[0];
  if (saved === undefined) {
    throw failure(
      { code: 'AUTH_REQUIRED', reason: 'profile_row_not_visible_to_session' },
      userId,
    );
  }

  return { displayName: saved.display_name, language: saved.language };
}
