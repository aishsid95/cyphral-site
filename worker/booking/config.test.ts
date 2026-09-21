import { describe, expect, it } from 'vitest';
import { BOOKING, type BookingConfigShape, validateBookingConfig } from './config';

/** A known-good config to mutate per test, so each test isolates one defect. */
function baseConfig(): BookingConfigShape {
  return structuredClone(BOOKING);
}

describe('validateBookingConfig', () => {
  it('accepts the shipped BOOKING config with no errors', () => {
    expect(validateBookingConfig(BOOKING)).toEqual([]);
  });

  it('rejects an unknown day name in weekly', () => {
    const config = baseConfig();
    (config.weekly as Record<string, unknown>).moon = [];
    expect(validateBookingConfig(config).some((e) => e.includes('unknown day name'))).toBe(true);
  });

  it('rejects an unknown day name in a recurring block', () => {
    const config = baseConfig();
    config.recurringBlocks[0].days = ['funday' as never];
    expect(validateBookingConfig(config).some((e) => e.includes('unknown day name'))).toBe(true);
  });

  it('rejects a weekly window where end is not after start', () => {
    const config = baseConfig();
    config.weekly.mon = [['14:00', '10:00']];
    expect(validateBookingConfig(config).some((e) => e.includes('end') && e.includes('not after start'))).toBe(true);
  });

  it('rejects a weekly window where end equals start', () => {
    const config = baseConfig();
    config.weekly.mon = [['10:00', '10:00']];
    expect(validateBookingConfig(config).length).toBeGreaterThan(0);
  });

  it('rejects a recurring block where end is not after start', () => {
    const config = baseConfig();
    config.recurringBlocks[0].end = config.recurringBlocks[0].start;
    expect(validateBookingConfig(config).some((e) => e.includes('end not after start'))).toBe(true);
  });

  it('rejects an invalid business time zone', () => {
    const config = baseConfig();
    config.businessTimeZone = 'Mars/Olympus_Mons';
    expect(validateBookingConfig(config).some((e) => e.includes('invalid businessTimeZone'))).toBe(true);
  });

  it('rejects an invalid recurring block time zone', () => {
    const config = baseConfig();
    config.recurringBlocks[0].timeZone = 'Nowhere/Land';
    expect(validateBookingConfig(config).some((e) => e.includes('invalid timeZone'))).toBe(true);
  });

  it('rejects a malformed blockedDates entry', () => {
    const config = baseConfig();
    config.blockedDates = ['2026-13-40'];
    expect(validateBookingConfig(config).length).toBeGreaterThan(0);
  });

  it('rejects a blockedDates entry that is not a real calendar date', () => {
    const config = baseConfig();
    config.blockedDates = ['2026-02-30'];
    expect(validateBookingConfig(config).some((e) => e.includes('not a real calendar date'))).toBe(true);
  });

  it('rejects a blockedRanges entry where end is before start', () => {
    const config = baseConfig();
    config.blockedRanges = [{ start: '2026-10-07T12:00', end: '2026-10-07T09:00' }];
    expect(validateBookingConfig(config).some((e) => e.includes('not after start'))).toBe(true);
  });

  it('rejects a blockedRanges entry where end equals start', () => {
    const config = baseConfig();
    config.blockedRanges = [{ start: '2026-10-07T09:00', end: '2026-10-07T09:00' }];
    expect(validateBookingConfig(config).length).toBeGreaterThan(0);
  });

  it('rejects a malformed blockedRanges timestamp', () => {
    const config = baseConfig();
    config.blockedRanges = [{ start: '7 Oct 2026 9am', end: '2026-10-07T12:00' }];
    expect(validateBookingConfig(config).length).toBeGreaterThan(0);
  });

  it('rejects an invalid ukSeason value', () => {
    const config = baseConfig();
    config.recurringBlocks[0].ukSeason = 'summer' as never;
    expect(validateBookingConfig(config).some((e) => e.includes('invalid ukSeason'))).toBe(true);
  });

  it('rejects an empty topics list', () => {
    const config = baseConfig();
    (config as { topics: readonly string[] }).topics = [] as readonly string[];
    expect(validateBookingConfig(config).some((e) => e.includes('topics'))).toBe(true);
  });
});
