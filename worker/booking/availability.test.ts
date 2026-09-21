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

// Isolated from real-world bank holidays (a single far-future sentinel date
// gives "coverage" without risking a real holiday landing in a test week —
// as Good Friday/Easter Monday do near the March transition some years).
const SYNTHETIC_BANK_HOLIDAYS = ['2030-01-01'];

describe('computeAvailableSlots — DST transition weeks', () => {
  it('October 2026: the week before the clock change is BST, the week after is GMT', () => {
    const grouped = groupByLondonDate(
      run({ now: new Date('2026-10-10T00:00:00Z'), bankHolidayDates: SYNTHETIC_BANK_HOLIDAYS }),
    );

    const bstMonToWed = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '16:00', '16:30'];
    const gmtMonToWed = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '15:00', '15:30', '16:00', '16:30'];

    // Before the 25 Oct 2026 transition (still BST)
    expect(grouped['2026-10-19']).toEqual(bstMonToWed); // Mon
    expect(grouped['2026-10-21']).toEqual(bstMonToWed); // Wed
    expect(grouped['2026-10-23']).toEqual(['10:00', '10:30', '11:00', '11:30', '15:00', '15:30', '16:00', '16:30']); // Fri, BST column

    // After the transition (now GMT)
    expect(grouped['2026-10-26']).toEqual(gmtMonToWed); // Mon
    expect(grouped['2026-10-28']).toEqual(gmtMonToWed); // Wed
    expect(grouped['2026-10-30']).toEqual(['10:00', '10:30', '15:00', '15:30', '16:00', '16:30']); // Fri, GMT column
  });

  it('March 2027: the week before the clock change is GMT, the week after is BST', () => {
    const grouped = groupByLondonDate(
      run({ now: new Date('2027-03-15T00:00:00Z'), bankHolidayDates: SYNTHETIC_BANK_HOLIDAYS }),
    );

    const gmtMonToWed = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '15:00', '15:30', '16:00', '16:30'];
    const bstMonToWed = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '16:00', '16:30'];

    // Before the 28 Mar 2027 transition (still GMT)
    expect(grouped['2027-03-22']).toEqual(gmtMonToWed); // Mon
    expect(grouped['2027-03-24']).toEqual(gmtMonToWed); // Wed
    expect(grouped['2027-03-26']).toEqual(['10:00', '10:30', '15:00', '15:30', '16:00', '16:30']); // Fri, GMT column

    // After the transition (now BST)
    expect(grouped['2027-03-29']).toEqual(bstMonToWed); // Mon
    expect(grouped['2027-03-31']).toEqual(bstMonToWed); // Wed
    expect(grouped['2027-04-02']).toEqual(['10:00', '10:30', '11:00', '11:30', '15:00', '15:30', '16:00', '16:30']); // Fri, BST column
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
