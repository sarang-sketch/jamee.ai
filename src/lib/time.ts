import type { Language } from '@/lib/schemas';

/**
 * Asia/Kolkata quota windows, and the one place a stored instant becomes text a farmer reads.
 *
 * Requirements: 14.1 (a Quota_Window is one calendar day in Asia/Kolkata), 14.3 (the decline
 *               states the reset time), 13.8 (the burst window is a different control on the
 *               same table)
 * Design: "Quota enforcement" — *"The window is derived per request, so nothing needs resetting
 *         at midnight — a new key simply starts at zero."*
 *
 * ### Why this is not `toISOString().slice(0, 10)`
 *
 * The server runs in UTC. `2026-09-15T19:30:00Z` is already **16 September** in Kolkata
 * (UTC+5:30), so a UTC-derived key would give a farmer in Pune a fresh 20 image analyses at
 * 5:30 a.m. and cut them off at 5:29 a.m. the next morning. Every function below formats in
 * `Asia/Kolkata` explicitly.
 *
 * ### Why `Intl`, and why that is safe here
 *
 * `Intl.DateTimeFormat` with `timeZone: 'Asia/Kolkata'` reads the platform's own IANA database,
 * so it needs no offset table in this repository and cannot go stale. India has observed no DST
 * since 1945 and has a single time zone, so the offset is a constant +05:30 — which means the
 * usual pitfall of `Intl`-based date arithmetic (a day that is 23 or 25 hours long) does not
 * arise for this zone. That is a property of Asia/Kolkata specifically; the same code would need
 * more care for a DST zone.
 *
 * No `Date` mutation anywhere below. Every function takes an optional `now` so the unit tests can
 * pin an instant instead of waiting for one.
 */

export const QUOTA_TIME_ZONE = 'Asia/Kolkata';

/**
 * `en-CA` yields `YYYY-MM-DD` from `formatToParts`-free formatting, which is exactly the shape
 * the counter key needs and is lexicographically sortable. The locale is a formatting detail, not
 * a user-facing one — no farmer sees this string.
 */
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: QUOTA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: QUOTA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface KolkataParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function kolkataParts(now: Date): KolkataParts {
  const parts = partsFormatter.formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) {
      throw new Error(`Intl did not return a ${type} part for ${QUOTA_TIME_ZONE}`);
    }
    return Number.parseInt(found.value, 10);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

/**
 * The daily counter key: `YYYY-MM-DD` in Asia/Kolkata.
 *
 * This is the whole of Requirement 14.2's cross-channel sharing, by omission — there is no
 * channel component anywhere in the key, so a web request and a WhatsApp request land on the same
 * counter row automatically rather than by a rule someone has to remember.
 */
export function dayWindowKey(now: Date = new Date()): string {
  return dayFormatter.format(now);
}

/**
 * The burst counter key: `YYYY-MM-DDTHH:MM` in Asia/Kolkata.
 *
 * A separate `window_kind` on the same `counters` table (Requirement 13.8). Minute rows are
 * pruned periodically; at the 6-tester scale the prune is a convenience, not a requirement.
 */
export function minuteWindowKey(now: Date = new Date()): string {
  const { year, month, day, hour, minute } = kolkataParts(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

/**
 * The next Asia/Kolkata midnight, as an absolute instant — the `resetsAt` a declined request
 * reports (Requirement 14.3).
 *
 * Computed by subtracting the elapsed Kolkata wall-clock time from `now` and adding one day,
 * rather than by constructing a local `Date` and hoping the runtime's zone is Kolkata. The
 * seconds-and-milliseconds term matters: without it the result would be the next midnight plus
 * however many seconds are on the clock, so a farmer declined at 23:59:59 would be told to wait
 * until 00:00:59.
 */
export function nextResetAt(now: Date = new Date()): Date {
  const { hour, minute } = kolkataParts(now);
  const secondsInto = now.getUTCSeconds();
  const msInto = now.getUTCMilliseconds();

  const elapsedMs =
    hour * 3_600_000 + minute * 60_000 + secondsInto * 1000 + msInto;

  const DAY_MS = 86_400_000;
  return new Date(now.getTime() - elapsedMs + DAY_MS);
}

/** `nextResetAt` as the ISO string the envelope and `quotaStatusSchema` carry. */
export function nextResetAtIso(now: Date = new Date()): string {
  return nextResetAt(now).toISOString();
}

/**
 * The cutoff instant for the retention sweep: `days` whole days before now.
 *
 * Requirement 18.3 counts the window from the creation timestamp of the ROW that references an
 * object, and rows carry `timestamptz`, so this is plain absolute-time arithmetic and needs no
 * timezone at all. It lives here rather than in the retention service because this is the module
 * that owns "what does N days mean", and having two answers to that in one codebase is how a
 * sweep ends up deleting a day early.
 */
export function retentionCutoff(days: number, now: Date = new Date()): Date {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`retention window must be a whole number of days >= 1, received ${days}`);
  }
  return new Date(now.getTime() - days * 86_400_000);
}

/* ========================================================================== */
/* Display                                                                     */
/* ========================================================================== */

/**
 * A stored `timestamptz` as a date and time a farmer can place, in Asia/Kolkata.
 *
 * Requirements: 12.1 (a history entry carries its creation timestamp), 12.3 (so does the detail
 *               view), 9.1 (in the farmer's language)
 *
 * ### Why a display formatter lives in the quota-window module
 *
 * For the same reason `retentionCutoff` does: this is the module that owns *what clock Jamee is
 * on*, and Jamee has exactly one answer to that. Two spellings of `Asia/Kolkata` in two files
 * would be two answers, and the one that drifted would be the one nobody was looking at.
 *
 * A rendered date takes no part in quota accounting — nothing here derives a window from it. What
 * it shares with the quota window is the zone, and a server render has no access to the browser's
 * zone, so a fixed regional zone is the honest choice over UTC: after 18:30 local, a UTC render
 * shows yesterday's date for a photo sent minutes ago.
 *
 * `language` — `en`, `hi` or `mr` — is passed straight to `Intl` as the locale, so month names and
 * digit shaping follow the text around them rather than sitting in English inside a Devanagari
 * sentence.
 *
 * An unparseable value is returned unchanged rather than throwing. A screen whose subject is a
 * diagnosis should not fail over its timestamp, and Requirements 12.1 and 12.11 both want the
 * remaining fields on the page regardless.
 */
export function formatInstant(iso: string, language: Language): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;

  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: QUOTA_TIME_ZONE,
  }).format(parsed);
}
