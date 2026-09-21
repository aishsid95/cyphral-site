/**
 * Small, dependency-free helpers for the "HH:MM" and local-date-time string
 * formats used throughout the booking config and availability engine.
 */

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export interface ParsedTime {
  hour: number;
  minute: number;
}

/** Parses a validated "HH:MM" string. Callers must check TIME_RE first. */
export function parseTime(value: string): ParsedTime {
  const [hour, minute] = value.split(':').map(Number);
  return { hour, minute };
}

export function timeToMinutes(value: string): number {
  const { hour, minute } = parseTime(value);
  return hour * 60 + minute;
}

export interface ParsedLocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

export interface ParsedLocalDateTime extends ParsedLocalDate {
  hour: number;
  minute: number;
}

/** Parses a validated "YYYY-MM-DD" string. Callers must check DATE_RE first. */
export function parseLocalDate(value: string): ParsedLocalDate {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

/** Parses a validated "YYYY-MM-DDTHH:mm" string. Callers must check LOCAL_DATETIME_RE first. */
export function parseLocalDateTime(value: string): ParsedLocalDateTime {
  const [datePart, timePart] = value.split('T');
  const { year, month, day } = parseLocalDate(datePart);
  const { hour, minute } = parseTime(timePart);
  return { year, month, day, hour, minute };
}

/** True if year/month/day form a real Gregorian calendar date (rejects e.g. 2026-02-30). */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}
