import { describe, expect, it } from 'vitest';

import {
  QUOTA_TIME_ZONE,
  dayWindowKey,
  minuteWindowKey,
  nextResetAt,
  nextResetAtIso,
} from '@/lib/time';

/**
 * Unit tests for the Asia/Kolkata quota windows: `dayWindowKey`, `minuteWindowKey`, `nextResetAt`.
 *
 * Requirements: 14.1 (a Quota_Window is one calendar day in Asia/Kolkata), 14.3 (the decline states
 *               the reset time)
 *
 * ### What this file adds that the property suite does not
 *
 * `tests/property/quota.property.test.ts` generates three clocks **inside one** Asia/Kolkata day and
 * asserts that a declined request reports `nextResetAtIso(clock)`. That makes the reset instant vary
 * with the clock, but it never crosses a boundary — all three clocks share one day key, so the
 * arithmetic that produces the key is held constant rather than exercised. `burst-order.property.test.ts`
 * and `rate-limit.test.ts` compare minute keys for equality without asserting their shape or offset.
 *
 * So the boundaries themselves are unowned, and they are where this module can actually be wrong:
 *
 *  - a UTC-**evening** instant belongs to the *next* Kolkata day, which is the +05:30 bug in its
 *    only observable form;
 *  - the day and minute keys must flip at exactly one instant, not one either side of it;
 *  - `nextResetAt()` must land on Kolkata midnight — not midnight plus the seconds on the clock —
 *    for every instant in a year, including month, year and leap-day rollovers.
 *
 * ### +05:30, stated once
 *
 * Asia/Kolkata is UTC+05:30 with no DST since 1945, so Kolkata midnight is **18:30 UTC on the
 * previous day**. Every fixture below is written as the UTC instant with the IST wall clock named in
 * a comment, because that is the direction the bug runs: a value that looks obviously right in IST
 * is the one a UTC-derived key gets wrong.
 */

/** Kolkata midnight, as an offset from UTC midnight. */
const IST_OFFSET_MINUTES = 330;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The UTC time-of-day at which every Kolkata day begins. */
const KOLKATA_MIDNIGHT_UTC_SUFFIX = 'T18:30:00.000Z';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function at(iso: string): Date {
  return new Date(iso);
}

/**
 * The calendar day after `YYYY-MM-DD`, derived independently of the module under test.
 *
 * Plain UTC arithmetic on a date-only value: `Date.UTC` handles month lengths, year rollover and
 * leap years, and no time zone is involved because the input carries no time. Deriving the expected
 * next key through `dayWindowKey` instead would let one bug satisfy both sides.
 */
function nextCalendarDay(key: string): string {
  const [year, month, day] = key.split('-').map((part) => Number.parseInt(part, 10)) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day) + DAY_MS).toISOString().slice(0, 10);
}

/* ========================================================================== */
/* The zone                                                                    */
/* ========================================================================== */

describe('the quota time zone', () => {
  it('is Asia/Kolkata, and the platform knows it', () => {
    expect(QUOTA_TIME_ZONE).toBe('Asia/Kolkata');

    // `Intl` reads the platform's IANA database, so an *unrecognised* zone would fall back to the
    // host zone and every key below would be wrong by 5½ hours. What the check is really after is
    // that the name resolved to something, not to what spelling: ICU resolves `Asia/Kolkata` to the
    // pre-1996 alias `Asia/Calcutta` on some builds, and the two name the same zone. The offset
    // itself is asserted for every instant of a year further down, which is the load-bearing claim.
    const resolved = new Intl.DateTimeFormat('en-CA', {
      timeZone: QUOTA_TIME_ZONE,
    }).resolvedOptions().timeZone;
    expect(['Asia/Kolkata', 'Asia/Calcutta']).toContain(resolved);
  });
});

/* ========================================================================== */
/* A UTC evening belongs to the next Kolkata day                               */
/* ========================================================================== */

describe('dayWindowKey on a UTC-evening instant', () => {
  it('gives the NEXT day’s key, not the UTC date', () => {
    // 2026-09-15T19:30Z is 2026-09-16T01:00 in Kolkata. `toISOString().slice(0, 10)` would say the
    // 15th — which is the bug: a farmer in Pune would get a fresh 20 image analyses at 5:30 a.m.
    // and be cut off at 5:29 the next morning.
    const utcEvening = at('2026-09-15T19:30:00.000Z');

    expect(dayWindowKey(utcEvening)).toBe('2026-09-16');
    expect(dayWindowKey(utcEvening)).not.toBe(utcEvening.toISOString().slice(0, 10));
    expect(minuteWindowKey(utcEvening)).toBe('2026-09-16T01:00');
  });

  it('holds across the whole UTC evening, and the two keys agree', () => {
    const table: ReadonlyArray<[string, string, string]> = [
      // UTC instant            | day key      | minute key
      ['2026-09-15T18:29:59.999Z', '2026-09-15', '2026-09-15T23:59'], // 23:59:59.999 IST
      ['2026-09-15T18:30:00.000Z', '2026-09-16', '2026-09-16T00:00'], // 00:00:00 IST, next day
      ['2026-09-15T20:15:30.000Z', '2026-09-16', '2026-09-16T01:45'],
      ['2026-09-15T23:59:59.000Z', '2026-09-16', '2026-09-16T05:29'],
      ['2026-09-16T00:00:00.000Z', '2026-09-16', '2026-09-16T05:30'], // UTC midnight, mid-IST-day
    ];

    for (const [iso, expectedDay, expectedMinute] of table) {
      expect(dayWindowKey(at(iso)), iso).toBe(expectedDay);
      expect(minuteWindowKey(at(iso)), iso).toBe(expectedMinute);
      // The minute key's date half is the day key, so a burst row and a daily row can never
      // disagree about which Kolkata day a request landed in.
      expect(minuteWindowKey(at(iso)).slice(0, 10), iso).toBe(expectedDay);
    }
  });
});

/* ========================================================================== */
/* The day boundary                                                            */
/* ========================================================================== */

describe('the day boundary', () => {
  it('flips at exactly 18:30:00.000Z and nowhere either side of it', () => {
    const midnightIst = Date.parse('2026-09-15T18:30:00.000Z');

    expect(dayWindowKey(new Date(midnightIst - 1))).toBe('2026-09-15');
    expect(dayWindowKey(new Date(midnightIst))).toBe('2026-09-16');
    // One millisecond is the whole width of the boundary: a request at 23:59:59.999 IST spends
    // yesterday's allowance and one at 00:00:00.000 IST spends today's.
    expect(dayWindowKey(new Date(midnightIst - 1))).not.toBe(dayWindowKey(new Date(midnightIst)));
  });

  it('rolls the month, the year, and a leap day', () => {
    const table: ReadonlyArray<[string, string]> = [
      ['2026-09-30T18:29:59.999Z', '2026-09-30'],
      ['2026-09-30T18:30:00.000Z', '2026-10-01'], // month rollover
      ['2026-12-31T18:29:59.999Z', '2026-12-31'],
      ['2026-12-31T18:30:00.000Z', '2027-01-01'], // year rollover
      ['2028-02-28T18:30:00.000Z', '2028-02-29'], // 2028 is a leap year
      ['2028-02-29T18:30:00.000Z', '2028-03-01'],
      ['2027-02-28T18:30:00.000Z', '2027-03-01'], // 2027 is not
    ];

    for (const [iso, expected] of table) expect(dayWindowKey(at(iso)), iso).toBe(expected);
  });

  it('is lexicographically sortable, which is what the counter key relies on', () => {
    const keys = [
      '2026-09-09T18:30:00.000Z',
      '2026-09-10T18:30:00.000Z',
      '2026-10-01T18:30:00.000Z',
      '2027-01-01T18:30:00.000Z',
    ].map((iso) => dayWindowKey(at(iso)));

    expect(keys).toStrictEqual([...keys].sort());
    for (const key of keys) expect(key).toMatch(DAY_KEY);
  });
});

/* ========================================================================== */
/* The minute boundary                                                         */
/* ========================================================================== */

describe('the minute boundary', () => {
  it('flips at the second, and holds for the whole minute', () => {
    const base = Date.parse('2026-09-16T06:00:00.000Z'); // 11:30:00 IST

    expect(minuteWindowKey(new Date(base))).toBe('2026-09-16T11:30');
    expect(minuteWindowKey(new Date(base + 59_999))).toBe('2026-09-16T11:30');
    expect(minuteWindowKey(new Date(base + MINUTE_MS))).toBe('2026-09-16T11:31');
    expect(minuteWindowKey(new Date(base - 1))).toBe('2026-09-16T11:29');
  });

  it('rolls the hour and the day in the same key', () => {
    const table: ReadonlyArray<[string, string]> = [
      ['2026-09-16T06:29:59.999Z', '2026-09-16T11:59'],
      ['2026-09-16T06:30:00.000Z', '2026-09-16T12:00'], // hour rollover
      ['2026-09-16T18:29:00.000Z', '2026-09-16T23:59'],
      ['2026-09-16T18:30:00.000Z', '2026-09-17T00:00'], // day rollover inside the minute key
    ];

    for (const [iso, expected] of table) {
      expect(minuteWindowKey(at(iso)), iso).toMatch(MINUTE_KEY);
      expect(minuteWindowKey(at(iso)), iso).toBe(expected);
    }
  });

  it('uses a 24-hour clock, so midnight is 00 rather than 24', () => {
    // `hourCycle: 'h23'`. Without it `Intl` yields `24:00` for Kolkata midnight, and the burst key
    // for the first minute of a day would sort after the last minute of it.
    expect(minuteWindowKey(at('2026-09-16T18:30:00.000Z'))).toBe('2026-09-17T00:00');
    expect(minuteWindowKey(at('2026-09-16T06:30:00.000Z'))).toBe('2026-09-16T12:00');
    expect(minuteWindowKey(at('2026-09-16T18:29:00.000Z'))).toBe('2026-09-16T23:59');
  });
});

/* ========================================================================== */
/* nextResetAt                                                                 */
/* ========================================================================== */

describe('nextResetAt', () => {
  it('drops the seconds and milliseconds on the clock', () => {
    // Without the seconds-and-milliseconds term a farmer declined at 23:59:59.750 IST would be told
    // to wait until 00:00:59.750 — a minute of nothing, reported as the reset.
    expect(nextResetAt(at('2026-09-15T18:29:59.750Z')).toISOString()).toBe(
      '2026-09-15T18:30:00.000Z',
    );
    expect(nextResetAt(at('2026-09-15T18:30:00.000Z')).toISOString()).toBe(
      '2026-09-16T18:30:00.000Z',
    );
    expect(nextResetAt(at('2026-09-15T19:30:00.000Z')).toISOString()).toBe(
      '2026-09-16T18:30:00.000Z',
    );
  });

  it('is the same instant as nextResetAtIso, which is what the envelope carries', () => {
    const now = at('2026-09-15T19:30:00.000Z');
    expect(nextResetAtIso(now)).toBe(nextResetAt(now).toISOString());
  });

  it('is a full day away at Kolkata midnight and a millisecond away just before it', () => {
    const midnightIst = at('2026-09-15T18:30:00.000Z');
    const justBefore = new Date(midnightIst.getTime() - 1);

    expect(nextResetAt(midnightIst).getTime() - midnightIst.getTime()).toBe(DAY_MS);
    expect(nextResetAt(justBefore).getTime() - justBefore.getTime()).toBe(1);
  });
});

/* ========================================================================== */
/* A whole DST-free year                                                       */
/* ========================================================================== */

/**
 * Sweep 2026 at a stride of 1 h 1 min 1.137 s.
 *
 * Deliberately not a whole number of hours or minutes: a stride of exactly one hour would only ever
 * present `:00:00.000`, so the seconds-and-milliseconds term in `nextResetAt()` would go unexercised
 * for the entire year. The stride is under 24 h, so no Kolkata day is skipped, and it walks the
 * time-of-day slowly enough to visit every hour many times over.
 */
const SWEEP_STRIDE_MS = 3_661_137;
const SWEEP_FROM = Date.parse('2026-01-01T00:00:00.000Z');
const SWEEP_TO = Date.parse('2027-01-01T00:00:00.000Z');

describe('across a DST-free year', () => {
  it('holds the +05:30 offset at every instant, so no day is 23 or 25 hours long', () => {
    // The premise the whole module rests on, asserted rather than cited. `minuteWindowKey` is the
    // Kolkata wall clock truncated to the minute; read as UTC it must sit exactly 330 minutes ahead
    // of the same instant truncated to the minute. A DST transition would break this on two days.
    let samples = 0;

    for (let ms = SWEEP_FROM; ms < SWEEP_TO; ms += SWEEP_STRIDE_MS) {
      const now = new Date(ms);
      const wallMs = Date.parse(`${minuteWindowKey(now)}:00.000Z`);
      const utcMinuteMs = Math.floor(ms / MINUTE_MS) * MINUTE_MS;

      expect((wallMs - utcMinuteMs) / MINUTE_MS, now.toISOString()).toBe(IST_OFFSET_MINUTES);
      samples += 1;
    }

    expect(samples).toBeGreaterThan(8_000);
  });

  it('resets at Kolkata midnight, once per day, opening exactly the next window', () => {
    const dayKeys = new Set<string>();
    const hoursSeen = new Set<string>();
    let previousKey = '';

    for (let ms = SWEEP_FROM; ms < SWEEP_TO; ms += SWEEP_STRIDE_MS) {
      const now = new Date(ms);
      const key = dayWindowKey(now);
      const reset = nextResetAt(now);
      const label = now.toISOString();

      expect(key, label).toMatch(DAY_KEY);
      // The sweep is monotone, so the keys it produces must be too — a key that went backwards
      // would mean the formatter and the instant had come apart.
      expect(key >= previousKey, `${label} produced ${key} after ${previousKey}`).toBe(true);
      previousKey = key;
      dayKeys.add(key);
      hoursSeen.add(minuteWindowKey(now).slice(11, 13));

      /* ── It is a Kolkata midnight, every time ─────────────────────────────── */
      expect(reset.toISOString().endsWith(KOLKATA_MIDNIGHT_UTC_SUFFIX), label).toBe(true);

      /* ── It is ahead of now, by no more than one day ─────────────────────── */
      expect(reset.getTime() - ms, label).toBeGreaterThan(0);
      expect(reset.getTime() - ms, label).toBeLessThanOrEqual(DAY_MS);

      /* ── It is the boundary of THIS window: the last instant before it still
            belongs to today, and the reset instant itself opens tomorrow ────── */
      expect(dayWindowKey(new Date(reset.getTime() - 1)), label).toBe(key);
      expect(dayWindowKey(reset), label).toBe(nextCalendarDay(key));
      expect(nextResetAtIso(now), label).toBe(reset.toISOString());
    }

    // Non-vacuity: the sweep really covered a year of distinct Kolkata days, and really did visit
    // every hour of the day rather than one slice of it.
    expect(dayKeys.size).toBeGreaterThanOrEqual(365);
    expect(hoursSeen.size).toBe(24);
    expect([...dayKeys][0]).toBe('2026-01-01');
  });
});
