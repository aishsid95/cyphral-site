/**
 * ============================================================================
 * BOOKING CONFIG — how to change your hours
 * ============================================================================
 *
 * Edit the `BOOKING` object below, commit, and push to `main`. The
 * git-connected Cloudflare Workers build takes it live — no admin panel,
 * no database-stored schedule. This file is the *only* source of truth for
 * your availability.
 *
 * Common edits:
 *
 * - Add a one-off blocked morning (e.g. a dentist appointment):
 *     blockedRanges: [{ start: "2026-11-03T09:00", end: "2026-11-03T12:00" }]
 *   Times are Europe/London local, 24-hour clock, no timezone suffix.
 *
 * - Block a week's holiday:
 *     blockedDates: ["2026-12-22", "2026-12-23", "2026-12-24", "2026-12-29", "2026-12-30", "2026-12-31"]
 *   Each entry blocks the whole Europe/London calendar day.
 *
 * - Change a class time (e.g. the Saudi qaidah class moves to 17:30-18:00
 *   Riyadh time): edit that block's `start`/`end` in `recurringBlocks`. The
 *   UK-local time it blocks is computed automatically, including across the
 *   UK's own clock changes — you never need to hand-adjust for BST/GMT.
 *
 * - Narrow the jummah bands once your mosque publishes a timetable (e.g.
 *   summer jummah is reliably 13:10-13:40): edit the `start`/`end` on the
 *   "Jummah (summer)" or "Jummah (winter)" block. Narrower bands free up
 *   more Friday slots either side of prayer.
 *
 * - Add the US qaidah class once its time is confirmed: add a new entry to
 *   `recurringBlocks` following the same shape as the existing classes.
 *
 * - Pause bookings entirely without editing this file: set the Cloudflare
 *   Worker environment variable `BOOKING_ENABLED` to `"false"` (kill switch).
 *   Setting `enabled: false` below does the same thing from code.
 *
 * A short validation test suite (`config.test.ts`) checks this file for
 * typos — bad day names, times, dates, or timezones — every time it changes.
 * A config that fails validation cannot deploy.
 * ============================================================================
 */

import type { DayName } from './timezone';

export type { DayName };

/** A working-hours window on a given day, as ["HH:MM", "HH:MM"] local time. */
export type TimeWindow = [start: string, end: string];

export interface RecurringBlock {
  /** Human-readable label. Server-side only — never sent to visitors. */
  label: string;
  /** Days this recurs on, in the block's OWN time zone. */
  days: DayName[];
  /** Start time, "HH:MM", in the block's own time zone. */
  start: string;
  /** End time, "HH:MM", in the block's own time zone. */
  end: string;
  /** IANA time zone the days/start/end above are expressed in. */
  timeZone: string;
  /**
   * Restricts this block to dates when Europe/London is on this offset.
   * "bst" = British Summer Time (UTC+1), "gmt" = Greenwich Mean Time (UTC+0).
   * Omit for a block that should apply year-round.
   */
  ukSeason?: 'bst' | 'gmt';
}

export interface BlockedRange {
  /** Europe/London local time, "YYYY-MM-DDTHH:mm". */
  start: string;
  /** Europe/London local time, "YYYY-MM-DDTHH:mm". Must be after `start`. */
  end: string;
}

export interface BookingConfigShape {
  enabled: boolean;
  businessTimeZone: string;
  durationMinutes: number;
  slotStepMinutes: number;
  bookingBufferMinutes: number;
  blockBufferMinutes: number;
  minNoticeHours: number;
  horizonDays: number;
  maxCallsPerDay: number;
  weekly: Record<DayName, TimeWindow[]>;
  recurringBlocks: RecurringBlock[];
  blockedDates: string[];
  blockedRanges: BlockedRange[];
  topics: readonly string[];
}

export const BOOKING: BookingConfigShape = {
  enabled: true, // also overridable by env var BOOKING_ENABLED="false" (kill switch)
  businessTimeZone: 'Europe/London',
  durationMinutes: 30,
  slotStepMinutes: 30, // slots start on the hour and half hour
  bookingBufferMinutes: 15, // gap kept either side of an existing booking
  blockBufferMinutes: 30, // gap kept either side of a recurring or one-off block
  minNoticeHours: 24,
  horizonDays: 21, // if you change this, also update the "next three weeks" wording in src/scripts/book.ts — it isn't derived from this value
  maxCallsPerDay: 2,

  // Working hours: local wall-clock windows in Europe/London.
  // A slot must start and end inside a window.
  weekly: {
    mon: [['10:00', '14:00'], ['15:00', '17:00']],
    tue: [['10:00', '14:00'], ['15:00', '17:00']],
    wed: [['10:00', '14:00'], ['15:00', '17:00']], // hard stop 18:00 already respected
    thu: [['10:00', '13:00']],
    fri: [['10:00', '12:00'], ['15:00', '17:00']],
    sat: [],
    sun: [],
  },

  // Recurring commitments. Days, times and dates are in the block's OWN time zone,
  // so classes set in another country move automatically when UK clocks change.
  // Optional `ukSeason`: "bst" or "gmt" limits the block to dates when Europe/London
  // is on that offset (for things like jummah that change with the UK season).
  recurringBlocks: [
    { label: 'Qaidah (Saudi)', days: ['mon', 'tue', 'wed'], start: '17:00', end: '17:30', timeZone: 'Asia/Riyadh' },
    { label: 'Qaidah (India)', days: ['sat', 'sun'], start: '19:30', end: '20:00', timeZone: 'Asia/Kolkata' },
    { label: 'Thursday commitments', days: ['thu'], start: '13:00', end: '19:00', timeZone: 'Europe/London' },
    // Jummah moves through the year. These blocks deliberately cover the whole range for each
    // UK season (summer around 13:20; winter can be as early as 11:30), so no edits are needed
    // as the mosque's time drifts. Narrow them later if the mosque publishes a timetable.
    { label: 'Jummah (summer)', days: ['fri'], start: '12:45', end: '14:15', timeZone: 'Europe/London', ukSeason: 'bst' },
    { label: 'Jummah (winter)', days: ['fri'], start: '11:30', end: '13:00', timeZone: 'Europe/London', ukSeason: 'gmt' },
    // US qaidah class: time not confirmed yet, outside working hours. Add here when known.
  ],

  // One-off blocks, Europe/London local time. Whole days, and ranges within a day or across days.
  blockedDates: [] as string[], // e.g. "2026-10-07"
  blockedRanges: [] as BlockedRange[], // e.g. { start: "2026-10-07T09:00", end: "2026-10-07T12:00" }

  topics: ['ce-readiness', 'ce-renewal', 'cyber-care', 'automation', 'not-sure'] as const,
};

// ---------------------------------------------------------------------------
// Validation — catches typos before they can deploy. Pure, no I/O.
// ---------------------------------------------------------------------------

import { isValidTimeZone } from './timezone';
import { DATE_RE, LOCAL_DATETIME_RE, TIME_RE, isValidCalendarDate, parseLocalDate, timeToMinutes } from './time';

const DAY_NAME_SET = new Set<DayName>(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

function isDayName(value: string): value is DayName {
  return DAY_NAME_SET.has(value as DayName);
}

export function validateBookingConfig(config: BookingConfigShape): string[] {
  const errors: string[] = [];

  if (!isValidTimeZone(config.businessTimeZone)) {
    errors.push(`invalid businessTimeZone: "${config.businessTimeZone}"`);
  }

  for (const key of Object.keys(config.weekly)) {
    if (!isDayName(key)) errors.push(`unknown day name in weekly: "${key}"`);
  }
  for (const day of DAY_NAME_SET) {
    const windows = config.weekly[day] ?? [];
    for (const [start, end] of windows) {
      if (!TIME_RE.test(start)) {
        errors.push(`weekly.${day}: invalid start time "${start}"`);
      } else if (!TIME_RE.test(end)) {
        errors.push(`weekly.${day}: invalid end time "${end}"`);
      } else if (timeToMinutes(end) <= timeToMinutes(start)) {
        errors.push(`weekly.${day}: end "${end}" not after start "${start}"`);
      }
    }
  }

  config.recurringBlocks.forEach((block, i) => {
    for (const day of block.days) {
      if (!isDayName(day)) errors.push(`recurringBlocks[${i}] ("${block.label}"): unknown day name "${day}"`);
    }
    const startOk = TIME_RE.test(block.start);
    const endOk = TIME_RE.test(block.end);
    if (!startOk) errors.push(`recurringBlocks[${i}] ("${block.label}"): invalid start time "${block.start}"`);
    if (!endOk) errors.push(`recurringBlocks[${i}] ("${block.label}"): invalid end time "${block.end}"`);
    if (startOk && endOk && timeToMinutes(block.end) <= timeToMinutes(block.start)) {
      errors.push(`recurringBlocks[${i}] ("${block.label}"): end not after start`);
    }
    if (!isValidTimeZone(block.timeZone)) {
      errors.push(`recurringBlocks[${i}] ("${block.label}"): invalid timeZone "${block.timeZone}"`);
    }
    if (block.ukSeason !== undefined && block.ukSeason !== 'bst' && block.ukSeason !== 'gmt') {
      errors.push(`recurringBlocks[${i}] ("${block.label}"): invalid ukSeason "${block.ukSeason}"`);
    }
  });

  config.blockedDates.forEach((value, i) => {
    if (!DATE_RE.test(value)) {
      errors.push(`blockedDates[${i}]: malformed date "${value}"`);
      return;
    }
    const { year, month, day } = parseLocalDate(value);
    if (!isValidCalendarDate(year, month, day)) {
      errors.push(`blockedDates[${i}]: not a real calendar date "${value}"`);
    }
  });

  config.blockedRanges.forEach((range, i) => {
    const startOk = LOCAL_DATETIME_RE.test(range.start);
    const endOk = LOCAL_DATETIME_RE.test(range.end);
    if (!startOk) errors.push(`blockedRanges[${i}]: malformed start "${range.start}"`);
    if (!endOk) errors.push(`blockedRanges[${i}]: malformed end "${range.end}"`);
    // "YYYY-MM-DDTHH:mm" strings compare correctly with plain string ordering.
    if (startOk && endOk && range.end <= range.start) {
      errors.push(`blockedRanges[${i}]: end "${range.end}" not after start "${range.start}"`);
    }
  });

  if (!Array.isArray(config.topics) || config.topics.length === 0) {
    errors.push('topics must be a non-empty array');
  }

  const positiveNumberFields: [string, number][] = [
    ['durationMinutes', config.durationMinutes],
    ['slotStepMinutes', config.slotStepMinutes],
    ['minNoticeHours', config.minNoticeHours],
    ['horizonDays', config.horizonDays],
    ['maxCallsPerDay', config.maxCallsPerDay],
  ];
  for (const [name, value] of positiveNumberFields) {
    if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
      errors.push(`${name} must be a positive number`);
    }
  }
  for (const [name, value] of [
    ['bookingBufferMinutes', config.bookingBufferMinutes],
    ['blockBufferMinutes', config.blockBufferMinutes],
  ] as const) {
    if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
      errors.push(`${name} must be a non-negative number`);
    }
  }

  return errors;
}

export function assertValidBookingConfig(config: BookingConfigShape): void {
  const errors = validateBookingConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid booking config:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

// Fail fast: a broken config cannot be imported, so it cannot deploy or run.
assertValidBookingConfig(BOOKING);
