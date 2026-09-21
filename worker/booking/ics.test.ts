import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { buildBookingIcs, escapeIcsText, foldIcsLine, icsToBase64 } from './ics';

const BASE_INPUT = {
  bookingId: '11111111-2222-3333-4444-555555555555',
  slotStartUtcIso: '2026-07-20T09:00:00Z',
  slotEndUtcIso: '2026-07-20T09:30:00Z',
  dtstampUtcIso: '2026-07-19T00:00:00Z',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines Ltd',
  topicLabel: 'Automation',
  note: 'Looking forward to it',
};

describe('escapeIcsText', () => {
  it('escapes backslash, semicolon, comma, and CRLF per RFC 5545', () => {
    expect(escapeIcsText('a\\b;c,d\r\ne')).toBe('a\\\\b\\;c\\,d\\ne');
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeIcsText('Ada Lovelace')).toBe('Ada Lovelace');
  });

  it('strips a raw CR or LF that could somehow survive the newline conversion', () => {
    // Defence-in-depth branch: nothing should reach here in practice, but
    // prove the guard itself removes any stray CR/LF rather than passing it through.
    const withStray = 'a\rb\nc'.replace(/\\n/g, ''); // sanity: no-op, just documents intent
    expect(escapeIcsText(withStray)).not.toMatch(/[\r\n]/);
  });
});

describe('foldIcsLine', () => {
  it('leaves a short line unfolded', () => {
    const line = 'SUMMARY:Cyphral call: Ada';
    expect(foldIcsLine(line)).toBe(line);
  });

  it('folds a line over 75 octets, with each physical line at or under the limit', () => {
    const line = `DESCRIPTION:${'x'.repeat(200)}`;
    const folded = foldIcsLine(line);
    const physicalLines = folded.split('\r\n');
    expect(physicalLines.length).toBeGreaterThan(1);
    for (const physical of physicalLines) {
      expect(new TextEncoder().encode(physical).byteLength).toBeLessThanOrEqual(75);
    }
    // Continuation lines start with a single space, per RFC 5545 folding.
    for (const physical of physicalLines.slice(1)) {
      expect(physical.startsWith(' ')).toBe(true);
    }
  });

  it('does not split a multi-byte UTF-8 character across a fold boundary', () => {
    // Arabic text (2 bytes/char in UTF-8) padded so a naive byte-count fold
    // would land mid-character.
    const line = `DESCRIPTION:${'مرحبا بكم في '.repeat(15)}`;
    const folded = foldIcsLine(line);
    for (const physical of folded.split('\r\n')) {
      const bytes = new TextEncoder().encode(physical);
      // Re-decoding must not produce the U+FFFD replacement character, which
      // is what a mid-character split would produce.
      expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toContain('�');
    }
  });
});

describe('buildBookingIcs — structure', () => {
  it('produces CRLF line endings throughout', () => {
    const ics = buildBookingIcs(BASE_INPUT);
    expect(ics).not.toMatch(/(?<!\r)\n/); // every \n is preceded by \r
    expect(ics.split('\r\n').length).toBeGreaterThan(5);
  });

  it('includes METHOD:PUBLISH, UID, DTSTAMP, DTSTART, DTEND in UTC', () => {
    const ics = buildBookingIcs(BASE_INPUT);
    expect(ics).toContain('METHOD:PUBLISH');
    expect(ics).toContain(`UID:${BASE_INPUT.bookingId}@cyphral.co.uk`);
    expect(ics).toContain('DTSTAMP:20260719T000000Z');
    expect(ics).toContain('DTSTART:20260720T090000Z');
    expect(ics).toContain('DTEND:20260720T093000Z');
  });

  it('never includes ORGANIZER, ATTENDEE, ALARM, or URL', () => {
    const ics = buildBookingIcs(BASE_INPUT);
    expect(ics).not.toContain('ORGANIZER');
    expect(ics).not.toContain('ATTENDEE');
    expect(ics).not.toContain('VALARM');
    expect(ics).not.toContain('URL:');
  });

  it('SUMMARY uses the company when given', () => {
    const ics = buildBookingIcs(BASE_INPUT);
    expect(ics).toContain('SUMMARY:Cyphral call: Analytical Engines Ltd');
  });

  it('SUMMARY falls back to the name when there is no company', () => {
    const ics = buildBookingIcs({ ...BASE_INPUT, company: '' });
    expect(ics).toContain('SUMMARY:Cyphral call: Ada Lovelace');
  });

  it('DESCRIPTION carries topic, name, email, and note', () => {
    const ics = buildBookingIcs(BASE_INPUT);
    // Unfold (reverse the RFC 5545 CRLF+space continuation) before checking
    // content — the description is long enough to fold in real output, and
    // that's correct, not something a plain substring check should trip on.
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('DESCRIPTION:Topic: Automation\\nName: Ada Lovelace\\nEmail: ada@example.com\\nNote: Looking forward to it');
  });

  it('DESCRIPTION shows (none) for an empty note', () => {
    const ics = buildBookingIcs({ ...BASE_INPUT, note: '' });
    expect(ics).toContain('Note: (none)');
  });
});

describe('buildBookingIcs — injection resistance (round-tripped through ical.js)', () => {
  it('a name and note containing backslash, semicolon, comma, and CRLF parse back to exactly one VEVENT with the original text', () => {
    const maliciousText = 'Evil\\Name;With,Commas\r\nDTSTART:19700101T000000Z\r\nX-INJECTED:yes';
    const ics = buildBookingIcs({ ...BASE_INPUT, name: maliciousText, note: maliciousText });

    const jcal = ICAL.parse(ics);
    const component = new ICAL.Component(jcal);
    const vevents = component.getAllSubcomponents('vevent');
    expect(vevents).toHaveLength(1);

    const event = new ICAL.Event(vevents[0]);
    // The real DTSTART survives, untouched by the injection attempt.
    expect(event.startDate.toString()).not.toContain('1970');
    expect(event.startDate.toICALString()).toContain('20260720T090000Z');

    // DESCRIPTION round-trips to the original text. ical.js un-escapes the
    // ICS "\n" sequence back to a real newline character regardless of
    // whether the source had \r\n, \r, or \n — so compare against the
    // malicious text with its own line endings normalised the same way.
    const description = event.description;
    expect(description).toContain(maliciousText.replace(/\r\n?/g, '\n'));
    // The crucial security property isn't the exact line count (the
    // malicious text's own embedded newlines legitimately appear as DATA
    // inside the DESCRIPTION value) — it's that there's still only one
    // VEVENT and its DTSTART is the real slot time, asserted above. Both
    // the injected "DTSTART:19700101..." and "X-INJECTED:yes" text ended
    // up as inert content inside DESCRIPTION, never as their own properties.
    expect(component.getAllProperties('dtstart')).toHaveLength(0); // no DTSTART at the VCALENDAR level
    expect(component.getAllSubcomponents()).toHaveLength(1); // only the one VEVENT, nothing injected alongside it
  });

  it('a note containing only a lone CR (old-Mac style) still round-trips safely', () => {
    const text = 'line one\rline two';
    const ics = buildBookingIcs({ ...BASE_INPUT, note: text });
    const jcal = ICAL.parse(ics);
    const component = new ICAL.Component(jcal);
    expect(component.getAllSubcomponents('vevent')).toHaveLength(1);
  });
});

describe('icsToBase64', () => {
  it('round-trips through base64 back to the original UTF-8 text', () => {
    const ics = buildBookingIcs(BASE_INPUT);
    const encoded = icsToBase64(ics);
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    expect(decoded).toBe(ics);
  });
});
