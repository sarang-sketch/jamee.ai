import { AppError } from '@/lib/errors';
import { languageSchema, type Language } from '@/lib/schemas';

/**
 * The farmer's own profile settings: the display name and the preferred language.
 *
 * Requirements: 1.8 (a submitted display name and preferred Supported_Language are persisted on
 *               that Farmer's Profile), 9.1 (English, Hindi and Marathi are the selectable
 *               languages), 13.2 (own-row only)
 * Design: "Frontend" — `/profile` is a server shell plus a client form; D18 (tenant isolation is
 *         the Data_Access_Layer, not RLS)
 *
 * =============================================================================
 * AMENDMENT A3 — THE WRITE GOES THROUGH THE DATA_ACCESS_LAYER, NOT SUPABASE
 * =============================================================================
 *
 * Under Supabase this module built PostgREST statements and classified PostgREST error codes, and
 * the write ran from the browser under RLS. A3 removes Supabase entirely: there is no browser
 * database client, no RLS, and no service-role client. Tenant isolation is the Data_Access_Layer
 * (D18), whose `farmerData(userId)` accessors merge the owning Auth_User_Id into every query by
 * construction — so a profile read or write reaches exactly one farmer's row and cannot express an
 * unscoped one.
 *
 * The functions here are therefore pure validation plus thin read/save steps taking a DAL-shaped
 * SEAM (a `ProfileReader` / `ProfileWriter`), not a database client. The `/profile` server shell
 * and the `POST /api/profile` route bind the real `farmerData(userId)` accessors; a unit test binds
 * an in-memory stub. This keeps the module free of `import 'server-only'` — it touches no driver —
 * while the write still lands only through the layer.
 *
 * ### What this module must never write
 *
 * `phone` and `_id`. Requirement 1.5 (and A3's identity model) makes the Auth_User_Id the identity;
 * `phone` is optional contact info with no reader (1.9) and is not this screen's to touch. The DAL
 * accessor `setProfileFields` accepts only `displayName`, `language`, and `phone`, and this module
 * passes only the first two — the bootstrap upsert owns nothing this screen writes, and this screen
 * writes nothing the bootstrap owns.
 */

/* ========================================================================== */
/* The two values, in application terms                                        */
/* ========================================================================== */

/** The saved settings. `null` display name means the farmer has not set one. */
export interface ProfileSettings {
  displayName: string | null;
  language: Language;
}

/**
 * The Profile column defaults, stated here so a screen with no Profile row to read renders the same
 * language the database would have given it. The setup validator declares `language` with an `en`
 * default on the collection; this is the application-side mirror of that.
 */
export const DEFAULT_LANGUAGE: Language = 'en';

/** Requirement 9.1's three options, in the order the form offers them. */
export const LANGUAGE_OPTIONS: readonly Language[] = languageSchema.options;

/* ========================================================================== */
/* The DAL seams                                                               */
/* ========================================================================== */

/**
 * The slice of a Profile document this module reads back. A `Pick`-like shape rather than the whole
 * `ProfileDoc`, so a screen that does not read an identity column cannot leak one.
 */
export interface ProfileReadback {
  displayName?: string | null;
  language: Language;
}

/**
 * The read seam: return the farmer's Profile fields, or `null` when there is no Profile row. Bound
 * to `farmerData(userId).readProfile()` in production (mapped to this narrow shape by the caller),
 * and to an in-memory stub in tests.
 */
export type ProfileReader = () => Promise<ProfileReadback | null>;

/**
 * The write seam: persist the two fields on the farmer's own Profile. Bound to
 * `farmerData(userId).setProfileFields(...)` in production. It returns nothing — the DAL accessor
 * is a scoped `updateOne` — so `saveProfileSettings` echoes back the values it validated and wrote,
 * which is what the database now holds (the accessor merges no other field).
 */
export type ProfileWriter = (fields: { displayName: string | null; language: Language }) => Promise<void>;

/* ========================================================================== */
/* Validating what the form submitted                                          */
/* ========================================================================== */

/** What arrives from the form: two strings, neither trusted. */
export interface ProfileSettingsInput {
  displayName: string;
  /** A `<select>` value, so a string until the enum says otherwise. */
  language: string;
}

/**
 * The display name as it should be stored, or `null`.
 *
 * Surrounding whitespace is stripped, and a name empty after that becomes `null` (the field is
 * optional and its absence means "not set", so clearing it returns the row to that state rather
 * than storing a blank string every reader then has to treat as blank). No length rule — the
 * collection validator does not constrain `displayName`, and inventing a ceiling here would create
 * a rejection with no catalog sentence to render.
 */
export function normalizeDisplayName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The submitted values, validated and normalized — or `LANGUAGE_UNSUPPORTED`.
 *
 * The language is checked against `languageSchema`, the one enum `schemas.ts` declares and the
 * setup validator mirrors, never re-listed here. A `<select>` cannot normally produce anything
 * else, which is exactly why this check exists: the value that reaches a write is whatever the DOM
 * held, and a stale bundle or a tampered page is the case worth being correct about.
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
/* Read                                                                        */
/* ========================================================================== */

/**
 * The farmer's saved settings, or `null` when they have no Profile row.
 *
 * "No row" is a state rather than an error (the bootstrap upsert makes it rare, but a screen must
 * still render). The DAL read is owner-scoped by construction, so the result is either the caller's
 * own row or nothing.
 */
export async function readProfileSettings(read: ProfileReader): Promise<ProfileSettings | null> {
  const row = await read();
  if (row === null) return null;
  return { displayName: row.displayName ?? null, language: row.language };
}

/* ========================================================================== */
/* Write                                                                       */
/* ========================================================================== */

/**
 * Persist both values on the farmer's own Profile and return what was stored (Requirement 1.8).
 *
 * Exactly two fields — never `phone`, never `_id` (see the module header). The returned value is the
 * validated, normalized pair, which is what the owner-scoped `updateOne` wrote; the DAL accessor
 * merges no other field, so echoing the input back is faithful to the row.
 */
export async function saveProfileSettings(
  write: ProfileWriter,
  input: ProfileSettingsInput,
): Promise<ProfileSettings> {
  const settings = parseProfileSettings(input);
  await write({ displayName: settings.displayName, language: settings.language });
  return settings;
}
