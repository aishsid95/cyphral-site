import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarDateInZone,
  calendarDateKey,
  compareCalendarDates,
  getUtcOffsetMinutes,
  isValidTimeZone,
  weekdayIndex,
  zonedWallTimeToUtcMs,
} from './timezone';

describe('isValidTimeZone', () => {
  it('accepts real IANA zones and aliases', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Asia/Riyadh')).toBe(true);
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true); // alias for Asia/Calcutta
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('rejects nonsense zones', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('getUtcOffsetMinutes', () => {
  it('reports BST (+60) in summer and GMT (+0) in winter for Europe/London', () => {
    expect(getUtcOffsetMinutes(Date.UTC(2026, 6, 15, 12, 0), 'Europe/London')).toBe(60);
    expect(getUtcOffsetMinutes(Date.UTC(2027, 0, 15, 12, 0), 'Europe/London')).toBe(0);
  });

  it('reports fixed non-DST offsets correctly', () => {
    expect(getUtcOffsetMinutes(Date.UTC(2026, 6, 15, 12, 0), 'Asia/Riyadh')).toBe(180);
    expect(getUtcOffsetMinutes(Date.UTC(2026, 6, 15, 12, 0), 'Asia/Kolkata')).toBe(330);
  });
});

describe('zonedWallTimeToUtcMs', () => {
  it('converts an ordinary BST wall time correctly', () => {
    // 2026-07-20 10:00 London (BST, UTC+1) = 09:00 UTC
    const ms = zonedWallTimeToUtcMs(2026, 7, 20, 10, 0, 'Europe/London');
    expect(new Date(ms!).toISOString()).toBe('2026-07-20T09:00:00.000Z');
  });

  it('converts an ordinary GMT wall time correctly', () => {
    // 2027-01-18 10:00 London (GMT, UTC+0) = 10:00 UTC
    const ms = zonedWallTimeToUtcMs(2027, 1, 18, 10, 0, 'Europe/London');
    expect(new Date(ms!).toISOString()).toBe('2027-01-18T10:00:00.000Z');
  });

  it('converts a fixed-offset zone with no DST', () => {
    // 17:00 Riyadh (UTC+3, year-round) = 14:00 UTC
    const ms = zonedWallTimeToUtcMs(2026, 3, 2, 17, 0, 'Asia/Riyadh');
    expect(new Date(ms!).toISOString()).toBe('2026-03-02T14:00:00.000Z');
  });

  it('returns null for a wall time that does not exist (spring-forward gap)', () => {
    // UK clocks spring forward at 01:00 -> 02:00 on 2026-03-29; 01:30 never happens.
    expect(zonedWallTimeToUtcMs(2026, 3, 29, 1, 30, 'Europe/London')).toBeNull();
  });

  it('returns the first (earlier) occurrence for an ambiguous wall time (fall-back)', () => {
    // UK clocks fall back at 02:00 BST -> 01:00 GMT on 2026-10-25; 01:30 happens
    // twice: first as 01:30 BST (00:30 UTC), then as 01:30 GMT (01:30 UTC).
    const ms = zonedWallTimeToUtcMs(2026, 10, 25, 1, 30, 'Europe/London');
    expect(new Date(ms!).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('leaves times well away from any transition unaffected', () => {
    const ms = zonedWallTimeToUtcMs(2026, 10, 25, 10, 0, 'Europe/London'); // after the fall-back, GMT
    expect(new Date(ms!).toISOString()).toBe('2026-10-25T10:00:00.000Z');
  });
});

describe('calendar helpers', () => {
  it('calendarDateInZone reads the correct local calendar date near a UTC day boundary', () => {
    // 23:30 UTC on 2026-07-20 is 00:30 the next day in BST.
    const d = calendarDateInZone(Date.UTC(2026, 6, 20, 23, 30), 'Europe/London');
    expect(d).toEqual({ year: 2026, month: 7, day: 21 });
  });

  it('weekdayIndex matches JS Date convention (0 = Sunday)', () => {
    expect(weekdayIndex({ year: 2026, month: 7, day: 20 })).toBe(1); // Monday
    expect(weekdayIndex({ year: 2026, month: 7, day: 26 })).toBe(0); // Sunday
  });

  it('addDays and compareCalendarDates handle month/year rollover', () => {
    const d = addDays({ year: 2026, month: 12, day: 30 }, 3);
    expect(d).toEqual({ year: 2027, month: 1, day: 2 });
    expect(compareCalendarDates({ year: 2026, month: 12, day: 30 }, d)).toBe(-1);
  });

  it('calendarDateKey formats with zero-padding', () => {
    expect(calendarDateKey({ year: 2026, month: 1, day: 5 })).toBe('2026-01-05');
  });
});
