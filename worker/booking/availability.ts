/**
 * The availability engine. `computeAvailableSlots` is a pure function: given
 * a config, an injected `now`, bank holiday data and live booking intervals,
 * it returns the sorted list of bookable slot starts. No clock reads, no
 * network, no database access — those all happen in the caller.
 */

import type { BookingConfigShape, RecurringBlock } from './config';
import {
  DAY_NAME_ORDER,
  addDays,
  calendarDateInZone,
  calendarDateKey,
  compareCalendarDates,
  getUtcOffsetMinutes,
  weekdayIndex,
  zonedWallTimeToUtcMs,
} from './timezone';
import { LOCAL_DATETIME_RE, parseLocalDateTime, parseTime } from './time';

export interface LiveBookingInterval {
  /** UTC ISO instant the booking's slot starts. */
  startUtc: string;
  /** UTC ISO instant the booking's slot ends. */
  endUtc: string;
}

export interface ComputeAvailableSlotsInput {
  config: BookingConfigShape;
  /** Injected "now" — never read from the system clock inside this module. */
  now: Date;
  /** Known bank holiday dates ("YYYY-MM-DD", England & Wales), any order. */
  bankHolidayDates: string[];
  /** Currently held or confirmed bookings. */
  liveBookings: LiveBookingInterval[];
}

interface Interval {
  start: number; // UTC ms, inclusive
  end: number; // UTC ms, exclusive
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Generates UTC intervals for every occurrence of `block` that could fall
 * within [windowStartUtcMs, windowEndUtcMs], iterating calendar dates in the
 * block's OWN time zone (padded by one day either side, since a date in the
 * block's zone can straddle the boundary of the query window expressed in
 * UTC or in the business zone).
 */
function generateBlockOccurrences(
  block: RecurringBlock,
  windowStartUtcMs: number,
  windowEndUtcMs: number,
): Interval[] {
  const startInBlockTz = addDays(calendarDateInZone(windowStartUtcMs, block.timeZone), -1);
  const endInBlockTz = addDays(calendarDateInZone(windowEndUtcMs, block.timeZone), 1);

  const blockDays = new Set(block.days);
  const startTime = parseTime(block.start);
  const endTime = parseTime(block.end);
  const intervals: Interval[] = [];

  for (
    let d = startInBlockTz;
    compareCalendarDates(d, endInBlockTz) <= 0;
    d = addDays(d, 1)
  ) {
    const weekday = DAY_NAME_ORDER[weekdayIndex(d)];
    if (!blockDays.has(weekday)) continue;

    const startMs = zonedWallTimeToUtcMs(d.year, d.month, d.day, startTime.hour, startTime.minute, block.timeZone);
    const endMs = zonedWallTimeToUtcMs(d.year, d.month, d.day, endTime.hour, endTime.minute, block.timeZone);
    if (startMs === null || endMs === null) continue; // occurrence falls in a DST gap

    if (block.ukSeason) {
      const londonOffset = getUtcOffsetMinutes(startMs, 'Europe/London');
      const season = londonOffset === 60 ? 'bst' : londonOffset === 0 ? 'gmt' : null;
      if (season !== block.ukSeason) continue;
    }

    intervals.push({ start: startMs, end: endMs });
  }

  return intervals;
}

function blockedRangesToIntervals(config: BookingConfigShape): Interval[] {
  const tz = config.businessTimeZone;
  const intervals: Interval[] = [];
  for (const range of config.blockedRanges) {
    if (!LOCAL_DATETIME_RE.test(range.start) || !LOCAL_DATETIME_RE.test(range.end)) continue;
    const s = parseLocalDateTime(range.start);
    const e = parseLocalDateTime(range.end);
    const startMs = zonedWallTimeToUtcMs(s.year, s.month, s.day, s.hour, s.minute, tz);
    const endMs = zonedWallTimeToUtcMs(e.year, e.month, e.day, e.hour, e.minute, tz);
    if (startMs !== null && endMs !== null) intervals.push({ start: startMs, end: endMs });
  }
  return intervals;
}

export function computeAvailableSlots(input: ComputeAvailableSlotsInput): string[] {
  const { config, now, bankHolidayDates, liveBookings } = input;
  const tz = config.businessTimeZone;

  const nowMs = now.getTime();
  const earliestStart = nowMs + config.minNoticeHours * 60 * 60 * 1000;
  const latestStart = nowMs + config.horizonDays * DAY_MS;

  // Bank holiday data coverage: beyond the furthest known date, fail closed
  // for every day (not just holidays) rather than risk offering a slot on an
  // undocumented holiday.
  const maxKnownHolidayDate = bankHolidayDates.reduce((max, d) => (d > max ? d : max), '');
  const bankHolidaySet = new Set(bankHolidayDates);
  const blockedDateSet = new Set(config.blockedDates);

  const bookingIntervals: Interval[] = liveBookings.map((b) => ({
    start: Date.parse(b.startUtc),
    end: Date.parse(b.endUtc),
  }));
  const liveBookingsPerLondonDay = new Map<string, number>();
  for (const b of liveBookings) {
    const day = calendarDateKey(calendarDateInZone(Date.parse(b.startUtc), tz));
    liveBookingsPerLondonDay.set(day, (liveBookingsPerLondonDay.get(day) ?? 0) + 1);
  }

  const blockIntervals: Interval[] = blockedRangesToIntervals(config);
  for (const block of config.recurringBlocks) {
    blockIntervals.push(...generateBlockOccurrences(block, nowMs, latestStart));
  }

  const windowStartDay = calendarDateInZone(nowMs, tz);
  const windowEndDay = calendarDateInZone(latestStart, tz);

  const results: number[] = [];

  for (let d = windowStartDay; compareCalendarDates(d, windowEndDay) <= 0; d = addDays(d, 1)) {
    const dayKey = calendarDateKey(d);

    if (maxKnownHolidayDate !== '' && dayKey > maxKnownHolidayDate) {
      console.warn(`booking: ${dayKey} is beyond known bank-holiday data; excluding all slots (fail closed)`);
      continue;
    }
    if (bankHolidaySet.has(dayKey)) continue;
    if (blockedDateSet.has(dayKey)) continue;
    if ((liveBookingsPerLondonDay.get(dayKey) ?? 0) >= config.maxCallsPerDay) continue;

    const weekday = DAY_NAME_ORDER[weekdayIndex(d)];
    const windows = config.weekly[weekday] ?? [];

    for (const [winStart, winEnd] of windows) {
      const winStartMin = toMinutes(winStart);
      const winEndMin = toMinutes(winEnd);

      for (
        let startMin = winStartMin;
        startMin + config.durationMinutes <= winEndMin;
        startMin += config.slotStepMinutes
      ) {
        const hour = Math.floor(startMin / 60);
        const minute = startMin % 60;
        const startUtcMs = zonedWallTimeToUtcMs(d.year, d.month, d.day, hour, minute, tz);
        if (startUtcMs === null) continue; // DST spring-forward gap
        const endUtcMs = startUtcMs + config.durationMinutes * 60_000;

        if (startUtcMs < earliestStart || startUtcMs > latestStart) continue;

        const slotWithBlockBuffer: Interval = {
          start: startUtcMs - config.blockBufferMinutes * 60_000,
          end: endUtcMs + config.blockBufferMinutes * 60_000,
        };
        if (blockIntervals.some((b) => overlaps(slotWithBlockBuffer, b))) continue;

        const slotWithBookingBuffer: Interval = {
          start: startUtcMs - config.bookingBufferMinutes * 60_000,
          end: endUtcMs + config.bookingBufferMinutes * 60_000,
        };
        if (bookingIntervals.some((b) => overlaps(slotWithBookingBuffer, b))) continue;

        results.push(startUtcMs);
      }
    }
  }

  results.sort((a, b) => a - b);
  return results.map(formatSlotIso);
}

function toMinutes(time: string): number {
  const { hour, minute } = parseTime(time);
  return hour * 60 + minute;
}

/** Formats a whole-minute UTC instant as "YYYY-MM-DDTHH:mm:00Z" (no milliseconds). Exported for reuse by the API routes. */
export function formatSlotIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
