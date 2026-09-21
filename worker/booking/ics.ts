/**
 * RFC 5545 (iCalendar) generation for the owner's booking notification.
 * Pure and dependency-free: no I/O, no external library. Deliberately
 * minimal — no ORGANIZER, ATTENDEE, ALARM, or URL property, per spec, and
 * the visitor never receives this file at all (owner-only).
 *
 * Every text value is escaped per RFC 5545 §3.3.11 before it reaches the
 * output, and lines are folded at 75 octets without splitting a UTF-8
 * character — without both of these, a name like `Bob\r\nDTSTART:...`
 * could inject its own calendar properties into the file.
 */

const FOLD_LIMIT_OCTETS = 75;

/** Escapes a free-text value for use as an RFC 5545 property value. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\n/g, '\\n')
    // Defence in depth: every real CR/LF above is already converted to the
    // literal two-character "\n" escape, so nothing should match here —
    // but a raw CR or LF must never reach the output regardless.
    .replace(/[\r\n]/g, '');
}

/** Folds one logical "NAME:value" content line into RFC 5545's CRLF + single-space-continuation form. */
export function foldIcsLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= FOLD_LIMIT_OCTETS) return line;

  const decoder = new TextDecoder();
  const physicalLines: string[] = [];
  let start = 0;
  let limit = FOLD_LIMIT_OCTETS;

  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a multi-byte UTF-8 character: a continuation byte has the
    // top two bits `10`, so back off while we're pointing into the middle of one.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end--;
    }
    physicalLines.push(decoder.decode(bytes.slice(start, end)));
    start = end;
    limit = FOLD_LIMIT_OCTETS - 1; // continuation lines lose one octet to the leading space
  }

  return physicalLines.map((text, i) => (i === 0 ? text : ` ${text}`)).join('\r\n');
}

function toIcsUtcDateTime(isoUtc: string): string {
  // "2026-07-20T09:00:00Z" -> "20260720T090000Z". Only ever called with our
  // own fixed-format UTC ISO strings (no milliseconds), so this is exact.
  return isoUtc.replace(/[-:]/g, '');
}

function textLine(name: string, value: string): string {
  return foldIcsLine(`${name}:${escapeIcsText(value)}`);
}

function dateTimeLine(name: string, isoUtc: string): string {
  return foldIcsLine(`${name}:${toIcsUtcDateTime(isoUtc)}`);
}

export interface BuildBookingIcsInput {
  bookingId: string;
  slotStartUtcIso: string;
  slotEndUtcIso: string;
  /** Generation instant — pass `new Date().toISOString()`-shaped UTC, injected so this stays pure. */
  dtstampUtcIso: string;
  name: string;
  email: string;
  /** Empty string if not given. */
  company: string;
  topicLabel: string;
  /** Empty string if not given. */
  note: string;
}

/** Builds a single-VEVENT iCalendar document (CRLF line endings, METHOD:PUBLISH) for the owner's calendar. */
export function buildBookingIcs(input: BuildBookingIcsInput): string {
  const summarySubject = input.company.trim() || input.name;
  const description = [
    `Topic: ${input.topicLabel}`,
    `Name: ${input.name}`,
    `Email: ${input.email}`,
    `Note: ${input.note.trim() || '(none)'}`,
  ].join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Cyphral//Booking//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    textLine('UID', `${input.bookingId}@cyphral.co.uk`),
    dateTimeLine('DTSTAMP', input.dtstampUtcIso),
    dateTimeLine('DTSTART', input.slotStartUtcIso),
    dateTimeLine('DTEND', input.slotEndUtcIso),
    textLine('SUMMARY', `Cyphral call: ${summarySubject}`),
    textLine('DESCRIPTION', description),
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return `${lines.join('\r\n')}\r\n`;
}

/** Base64-encodes the ICS document for Resend's `attachments[].content` field. */
export function icsToBase64(ics: string): string {
  const bytes = new TextEncoder().encode(ics);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
