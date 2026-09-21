/**
 * IANA time zone conversion, built directly on `Intl.DateTimeFormat`.
 *
 * No timezone library dependency: Cloudflare Workers ship full ICU data, so
 * `Intl` already has complete IANA tz database support (verified: it resolves
 * aliases like `Asia/Kolkata` -> `Asia/Calcutta`). A small tz library would
 * only wrap this same platform API, so implementing the conversion directly
 * here keeps the dependency graph — and the supply-chain attack surface —
 * smaller, per CLAUDE.md's secrets/dependency discipline.
 *
 * Everything in this module is pure: no clock reads, no I/O.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

interface CalendarDateTime extends CalendarDate {
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** Weekday names in `Date#getUTCDay()` order: index 0 = Sunday. */
export const DAY_NAME_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayName = (typeof DAY_NAME_ORDER)[number];

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function readCalendarDateTime(utcMs: number, timeZone: string): CalendarDateTime {
  const parts = getFormatter(timeZone).formatToParts(new Date(utcMs));
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** True if `timeZone` is a name `Intl` can resolve (real IANA zone or alias). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    // eslint-disable-next-line no-new -- constructing is the check
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The UTC offset of `timeZone`, in minutes, at the instant `utcMs`. */
export function getUtcOffsetMinutes(utcMs: number, timeZone: string): number {
  const p = readCalendarDateTime(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - utcMs) / 60_000;
}

/**
 * Converts a local wall-clock date/time in `timeZone` to a UTC instant (ms
 * since epoch).
 *
 * Returns `null` if the wall-clock time does not exist (a spring-forward
 * DST gap). If the wall-clock time is ambiguous (a fall-back DST repeat),
 * returns the earlier of the two real instants — the first occurrence.
 *
 * Method: sample the zone's offset a full day either side of the naive
 * guess. Those two samples are always outside the transition instant itself
 * (real-world DST transitions are never a full calendar day apart), so they
 * reliably bracket the (at most one) transition that could affect this wall
 * time, giving both candidate offsets to test.
 */
export function zonedWallTimeToUtcMs(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const wallAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  const offsetBefore = getUtcOffsetMinutes(wallAsUtcMs - DAY_MS, timeZone);
  const offsetAfter = getUtcOffsetMinutes(wallAsUtcMs + DAY_MS, timeZone);

  const matchesTarget = (ms: number): boolean => {
    const p = readCalendarDateTime(ms, timeZone);
    return (
      p.year === year && p.month === month && p.day === day &&
      p.hour === hour && p.minute === minute
    );
  };

  if (offsetBefore === offsetAfter) {
    const candidate = wallAsUtcMs - offsetBefore * 60_000;
    return matchesTarget(candidate) ? candidate : null;
  }

  const candidateA = wallAsUtcMs - offsetBefore * 60_000;
  const candidateB = wallAsUtcMs - offsetAfter * 60_000;
  const aValid = matchesTarget(candidateA);
  const bValid = matchesTarget(candidateB);

  if (aValid && bValid) return Math.min(candidateA, candidateB); // ambiguous: first occurrence
  if (aValid) return candidateA;
  if (bValid) return candidateB;
  return null; // gap: wall time does not exist
}

/** The calendar date (Y/M/D) that the instant `utcMs` falls on in `timeZone`. */
export function calendarDateInZone(utcMs: number, timeZone: string): CalendarDate {
  const p = readCalendarDateTime(utcMs, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/**
 * Weekday index for a calendar date: 0 = Sunday .. 6 = Saturday. Pure
 * calendar arithmetic — once you have a Y/M/D date there is no timezone or
 * DST ambiguity left to resolve.
 */
export function weekdayIndex(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * Adds `days` (may be negative) to a calendar date using pure calendar
 * arithmetic. Never touches any specific timezone's wall clock or DST rules.
 */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function calendarDateKey(date: CalendarDate): string {
  const mm = String(date.month).padStart(2, '0');
  const dd = String(date.day).padStart(2, '0');
  return `${date.year}-${mm}-${dd}`;
}

export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  const ka = calendarDateKey(a);
  const kb = calendarDateKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
