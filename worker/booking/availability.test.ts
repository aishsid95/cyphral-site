import { describe, expect, it } from 'vitest';
import { BOOKING, type BookingConfigShape } from './config';
import { computeAvailableSlots, type LiveBookingInterval } from './availability';
import bankHolidayData from './bank-holidays.json';

const REAL_BANK_HOLIDAYS: string[] = bankHolidayData.dates;

/** Independent (not reusing the implementation's own helpers) UTC -> London label formatter, for assertions. */
function toLondonLabel(iso: string): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(iso))) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${map.hour}:${map.minute}` };
}

function groupByLondonDate(isoSlots: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const iso of isoSlots) {
    const { date, time } = toLondonLabel(iso);
    (out[date] ??= []).push(time);
  }
  return out;
}

function run(overrides: Partial<{
  config: BookingConfigShape;
  now: Date;
  bankHolidayDates: string[];
  liveBookings: LiveBookingInterval[];
}> = {}): string[] {
  return computeAvailableSlots({
    config: overrides.config ?? BOOKING,
    now: overrides.now ?? new Date('2026-07-10T00:00:00Z'),
    bankHolidayDates: overrides.bankHolidayDates ?? REAL_BANK_HOLIDAYS,
    liveBookings: overrides.liveBookings ?? [],
  });
}

/** A minimal single-window Monday-only config, for tests isolating one buffer/overlap rule. */
function minimalMondayConfig(): BookingConfigShape {
  const config = structuredClone(BOOKING);
  config.weekly = { mon: [['10:00', '12:00']], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  config.recurringBlocks = [];
  config.blockedDates = [];
  config.blockedRanges = [];
  return config;
}

describe('computeAvailableSlots — expected weekly table', () => {
  it('matches the BST table for the week of 20 July 2026', () => {
    const grouped = groupByLondonDate(run({ now: new Date('2026-07-10T00:00:00Z') }));

    const monToWed = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '16:00', '16:30'];
    expect(grouped['2026-07-20']).toEqual(monToWed); // Mon
    expect(grouped['2026-07-21']).toEqual(monToWed); // Tue
    expect(grouped['2026-07-22']).toEqual(monToWed); // Wed
    expect(grouped['2026-07-23']).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00']); // Thu
    expect(grouped['2026-07-24']).toEqual(['10:00', '10:30', '11:00', '11:30', '15:00', '15:30', '16:00', '16:30']); // Fri
    expect(grouped['2026-07-25']).toBeUndefined(); // Sat
    expect(grouped['2026-07-26']).toBeUndefined(); // Sun
  });

  it('matches the GMT table for the week of 18 January 2027', () => {
    const grouped = groupByLondonDate(run({ now: new Date('2027-01-08T00:00:00Z') }));

    const monToWed = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '15:00', '15:30', '16:00', '16:30'];
    expect(grouped['2027-01-18']).toEqual(monToWed); // Mon
    expect(grouped['2027-01-19']).toEqual(monToWed); // Tue
    expect(grouped['2027-01-20']).toEqual(monToWed); // Wed
    expect(grouped['2027-01-21']).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00']); // Thu
    expect(grouped['2027-01-22']).toEqual(['10:00', '10:30', '15:00', '15:30', '16:00', '16:30']); // Fri
    expect(grouped['2027-01-23']).toBeUndefined(); // Sat
    expect(grouped['2027-01-24']).toBeUndefined(); // Sun
  });
});

describe('computeAvailableSlots — DST transition weeks', () => {
  // Real bank holiday data (imported at the top of this file) throughout —
  // no synthetic substitution. 26 & 29 March 2027 (Good Friday / Easter
  // Monday) are real bank holidays that land either side of that year's
  // clock change, so the assertions below deliberately use OTHER weekdays
  // that aren't holidays; the holiday exclusion itself is checked as its
  // own test further down, against real dates and real data.

  it('October 2026: Mon-Wed afternoon slots and the Friday jummah gap flip on the transition date', () => {
    const before = run({ now: new Date('2026-10-10T00:00:00Z') }); // week of 19 Oct, still BST
    const after = run({ now: new Date('2026-10-24T00:00:00Z') }); // week of 26 Oct, now GMT
    const beforeGrouped = groupByLondonDate(before);
    const afterGrouped = groupByLondonDate(after);

    const bstMonToWed = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '16:00', '16:30'];
    const gmtMonToWed = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '15:00', '15:30', '16:00', '16:30'];

    expect(beforeGrouped['2026-10-19']).toEqual(bstMonToWed); // Mon, BST
    expect(beforeGrouped['2026-10-21']).toEqual(bstMonToWed); // Wed, BST
    expect(afterGrouped['2026-10-26']).toEqual(gmtMonToWed); // Mon, GMT
    expect(afterGrouped['2026-10-28']).toEqual(gmtMonToWed); // Wed, GMT

    // Same facts again, but against the raw UTC instants computeAvailableSlots
    // actually returns, not the test's own local-time relabelling.
    expect(before).toContain('2026-10-19T09:00:00Z'); // Mon 10:00 BST, first slot of the week
    expect(before).toContain('2026-10-19T12:30:00Z'); // Mon 13:30 BST, last slot before the Qaidah gap
    expect(after).toContain('2026-10-26T10:00:00Z'); // Mon 10:00 GMT, first slot — one real hour later in UTC
    expect(after).not.toContain('2026-10-26T13:30:00Z'); // Mon 13:30 GMT would collide with the Qaidah buffer in GMT; not offered

    // Friday: BST keeps 11:00/11:30, GMT loses them to the winter jummah block + buffer.
    expect(before).toContain('2026-10-23T10:00:00Z'); // Fri 11:00 BST
    expect(before).toContain('2026-10-23T10:30:00Z'); // Fri 11:30 BST
    expect(after).not.toContain('2026-10-30T11:00:00Z'); // Fri 11:00 GMT — removed
    expect(after).not.toContain('2026-10-30T11:30:00Z'); // Fri 11:30 GMT — removed
    expect(after).toContain('2026-10-30T10:00:00Z'); // Fri 10:00 GMT still offered
    expect(after).toContain('2026-10-30T10:30:00Z'); // Fri 10:30 GMT still offered
  });

  it('March 2027: the same flip happens on non-holiday weekdays either side of the transition', () => {
    // Tue/Wed instead of Mon/Wed, and Fridays a week away from the transition,
    // to sidestep 26 & 29 March (see the dedicated holiday test below).
    const before = run({ now: new Date('2027-03-08T00:00:00Z') }); // week of 15 Mar + Fri 19 Mar, still GMT
    const after = run({ now: new Date('2027-03-22T00:00:00Z') }); // week of 30 Mar, now BST
    const beforeGrouped = groupByLondonDate(before);
    const afterGrouped = groupByLondonDate(after);

    const gmtTueWed = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '15:00', '15:30', '16:00', '16:30'];
    const bstTueWed = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '16:00', '16:30'];

    expect(beforeGrouped['2027-03-23']).toEqual(gmtTueWed); // Tue, GMT
    expect(beforeGrouped['2027-03-24']).toEqual(gmtTueWed); // Wed, GMT
    expect(afterGrouped['2027-03-30']).toEqual(bstTueWed); // Tue, BST
    expect(afterGrouped['2027-03-31']).toEqual(bstTueWed); // Wed, BST

    expect(before).toContain('2027-03-23T10:00:00Z'); // Tue 10:00 GMT
    expect(before).not.toContain('2027-03-23T13:30:00Z'); // Tue 13:30 GMT — collides with Qaidah buffer
    expect(after).toContain('2027-03-30T09:00:00Z'); // Tue 10:00 BST — one real hour earlier in UTC
    expect(after).not.toContain('2027-03-30T14:00:00Z'); // Tue 15:00 BST — collides with Qaidah buffer in BST

    // Friday, one week away from the transition on each side (19 Mar and 2 Apr — neither is a holiday).
    expect(before).not.toContain('2027-03-19T11:00:00Z'); // Fri 11:00 GMT — removed (winter jummah)
    expect(before).not.toContain('2027-03-19T11:30:00Z'); // Fri 11:30 GMT — removed
    expect(before).toContain('2027-03-19T10:00:00Z'); // Fri 10:00 GMT still offered
    expect(after).toContain('2027-04-02T10:00:00Z'); // Fri 11:00 BST — kept (summer jummah doesn't reach it)
    expect(after).toContain('2027-04-02T10:30:00Z'); // Fri 11:30 BST — kept
  });

  it('excludes Good Friday (26 Mar 2027) and Easter Monday (29 Mar 2027) as real bank holidays', () => {
    const grouped = groupByLondonDate(run({ now: new Date('2027-03-15T00:00:00Z') }));
    expect(grouped['2027-03-26']).toBeUndefined(); // Good Friday
    expect(grouped['2027-03-29']).toBeUndefined(); // Easter Monday
    // Neighbouring non-holiday weekdays are unaffected.
    expect(grouped['2027-03-25']).toBeDefined(); // Thu before
    expect(grouped['2027-03-30']).toBeDefined(); // Tue after
  });
});

describe('computeAvailableSlots — block buffer boundary', () => {
  it('keeps a slot available when a block ends exactly at the buffer boundary', () => {
    const config = minimalMondayConfig(); // 10:00-12:00 window, 30-min slots, 30-min block buffer
    config.blockedRanges = [{ start: '2026-07-20T09:00', end: '2026-07-20T10:30' }]; // ends exactly 30min before the 11:00 slot
    const slots = run({ config, now: new Date('2026-07-10T00:00:00Z') });
    expect(slots).toContain('2026-07-20T10:00:00Z'); // 11:00 London (BST)
  });

  it('removes the slot when the same block overlaps the buffer by one minute', () => {
    const config = minimalMondayConfig();
    config.blockedRanges = [{ start: '2026-07-20T09:00', end: '2026-07-20T10:31' }]; // one minute into the buffer
    const slots = run({ config, now: new Date('2026-07-10T00:00:00Z') });
    expect(slots).not.toContain('2026-07-20T10:00:00Z');
  });
});

describe('computeAvailableSlots — booking buffer', () => {
  it('a booking at 10:00 removes the 10:00 and 10:30 slots but leaves 11:00', () => {
    const config = minimalMondayConfig(); // bookingBufferMinutes: 15 (inherited from BOOKING)
    const liveBookings: LiveBookingInterval[] = [
      { startUtc: '2026-07-20T09:00:00Z', endUtc: '2026-07-20T09:30:00Z' }, // 10:00-10:30 BST
    ];
    const slots = run({ config, now: new Date('2026-07-10T00:00:00Z'), liveBookings });
    expect(slots).not.toContain('2026-07-20T09:00:00Z'); // 10:00 BST
    expect(slots).not.toContain('2026-07-20T09:30:00Z'); // 10:30 BST
    expect(slots).toContain('2026-07-20T10:00:00Z'); // 11:00 BST — left available
  });
});

describe('computeAvailableSlots — one-off exclusions', () => {
  it('excludes a whole day in blockedDates', () => {
    const config = structuredClone(BOOKING);
    config.blockedDates = ['2026-07-21']; // Tuesday
    const grouped = groupByLondonDate(run({ config, now: new Date('2026-07-10T00:00:00Z') }));
    expect(grouped['2026-07-21']).toBeUndefined();
    expect(grouped['2026-07-20']).toBeDefined(); // Monday unaffected
  });

  it('excludes slots covered by a blockedRanges entry spanning midnight', () => {
    const config = structuredClone(BOOKING);
    // Monday 23:00 BST through Tuesday 10:15 BST.
    config.blockedRanges = [{ start: '2026-07-20T23:00', end: '2026-07-21T10:15' }];
    const grouped = groupByLondonDate(run({ config, now: new Date('2026-07-10T00:00:00Z') }));
    expect(grouped['2026-07-21']).not.toContain('10:00');
    expect(grouped['2026-07-21']).not.toContain('10:30');
    expect(grouped['2026-07-21']).toContain('11:00'); // outside the buffered range
  });

  it('excludes a bank holiday Monday', () => {
    const grouped = groupByLondonDate(run({ now: new Date('2026-08-20T00:00:00Z') }));
    expect(grouped['2026-08-31']).toBeUndefined(); // August bank holiday
    expect(grouped['2026-09-01']).toBeDefined(); // Tuesday after, unaffected
  });
});

describe('computeAvailableSlots — notice and horizon boundaries', () => {
  it('handles "now" at 23:59 London time without an off-by-one day error', () => {
    // 2026-07-20 23:59 BST = 2026-07-20T22:59:00Z. + 24h minNotice pushes the
    // earliest bookable instant past all of the 21st's working hours.
    const grouped = groupByLondonDate(run({ now: new Date('2026-07-20T22:59:00Z') }));
    expect(grouped['2026-07-21']).toBeUndefined();
    expect(grouped['2026-07-22']).toBeDefined();
  });

  it('includes a slot starting exactly minNoticeHours from now, excludes one starting a minute earlier', () => {
    // Monday 20 Jul 2026 10:00 BST = 2026-07-20T09:00:00Z, the first slot of the week.
    const exactlyOnBoundary = run({ now: new Date('2026-07-19T09:00:00Z') });
    expect(exactlyOnBoundary).toContain('2026-07-20T09:00:00Z');

    const oneMinuteLate = run({ now: new Date('2026-07-19T09:01:00Z') });
    expect(oneMinuteLate).not.toContain('2026-07-20T09:00:00Z');
  });

  it('fails closed beyond the bank holiday data horizon', () => {
    const slots = run({
      now: new Date('2026-07-10T00:00:00Z'),
      bankHolidayDates: ['2026-01-01'], // coverage ends long before the query window
    });
    expect(slots).toEqual([]);
  });
});

describe('computeAvailableSlots — daily cap', () => {
  it('excludes the rest of a day once maxCallsPerDay live bookings exist', () => {
    const liveBookings: LiveBookingInterval[] = [
      { startUtc: '2026-07-20T11:00:00Z', endUtc: '2026-07-20T11:30:00Z' }, // Mon 12:00 BST
      { startUtc: '2026-07-20T15:00:00Z', endUtc: '2026-07-20T15:30:00Z' }, // Mon 16:00 BST
    ];
    const grouped = groupByLondonDate(run({ now: new Date('2026-07-10T00:00:00Z'), liveBookings }));
    expect(grouped['2026-07-20']).toBeUndefined(); // cap (2) reached
    expect(grouped['2026-07-21']).toBeDefined(); // Tuesday unaffected
  });
});

describe('computeAvailableSlots — degenerate config', () => {
  it('returns [] without throwing for an entirely empty weekly config', () => {
    const config = structuredClone(BOOKING);
    config.weekly = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    expect(() => run({ config })).not.toThrow();
    expect(run({ config })).toEqual([]);
  });
});
