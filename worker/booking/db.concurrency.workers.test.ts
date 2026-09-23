/**
 * Race tests: fire genuinely concurrent createConfirmedBooking() calls (via
 * Promise.all, before any of them has resolved) at the same D1 instance, and
 * assert the database-level invariants hold no matter which one "wins".
 * These exist precisely because a race is not observable by calling things
 * one at a time — see db.workers.test.ts for the sequential behavioural
 * tests.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createConfirmedBooking, type CreateBookingInput } from './db';

// All on Monday 20 Jul 2026 (BST). Five slots on the half-hour grid, mutually
// non-overlapping once you're more than one apart, so buffer-overlap and
// day-cap effects can be isolated from each other in different tests.
const LONDON_DAY = {
  londonDayStartUtc: '2026-07-19T23:00:00Z',
  londonDayEndUtc: '2026-07-20T23:00:00Z',
};
const SLOT_10_00 = { slotStartUtc: '2026-07-20T09:00:00Z', slotEndUtc: '2026-07-20T09:30:00Z', bufferedRangeStartUtc: '2026-07-20T08:45:00Z', bufferedRangeEndUtc: '2026-07-20T09:45:00Z', ...LONDON_DAY };
const SLOT_10_30 = { slotStartUtc: '2026-07-20T09:30:00Z', slotEndUtc: '2026-07-20T10:00:00Z', bufferedRangeStartUtc: '2026-07-20T09:15:00Z', bufferedRangeEndUtc: '2026-07-20T10:15:00Z', ...LONDON_DAY };
const SLOT_12_00 = { slotStartUtc: '2026-07-20T11:00:00Z', slotEndUtc: '2026-07-20T11:30:00Z', bufferedRangeStartUtc: '2026-07-20T10:45:00Z', bufferedRangeEndUtc: '2026-07-20T11:45:00Z', ...LONDON_DAY };
const SLOT_14_00 = { slotStartUtc: '2026-07-20T13:00:00Z', slotEndUtc: '2026-07-20T13:30:00Z', bufferedRangeStartUtc: '2026-07-20T12:45:00Z', bufferedRangeEndUtc: '2026-07-20T13:45:00Z', ...LONDON_DAY };
const SLOT_16_00 = { slotStartUtc: '2026-07-20T15:00:00Z', slotEndUtc: '2026-07-20T15:30:00Z', bufferedRangeStartUtc: '2026-07-20T14:45:00Z', bufferedRangeEndUtc: '2026-07-20T15:45:00Z', ...LONDON_DAY };
// A different London day, for the duplicate-email test.
const SLOT_TUESDAY = { slotStartUtc: '2026-07-21T09:00:00Z', slotEndUtc: '2026-07-21T09:30:00Z', bufferedRangeStartUtc: '2026-07-21T08:45:00Z', bufferedRangeEndUtc: '2026-07-21T09:45:00Z', londonDayStartUtc: '2026-07-20T23:00:00Z', londonDayEndUtc: '2026-07-21T23:00:00Z' };

let nextId = 0;
type SlotFields = Pick<CreateBookingInput, 'slotStartUtc' | 'slotEndUtc' | 'bufferedRangeStartUtc' | 'bufferedRangeEndUtc' | 'londonDayStartUtc' | 'londonDayEndUtc'>;
function bookingInput(slot: SlotFields, overrides: Partial<CreateBookingInput> = {}): CreateBookingInput {
  nextId += 1;
  const email = overrides.emailKey ?? `racer${nextId}@example.com`;
  return {
    id: `race-${nextId}`,
    maxCallsPerDay: 2,
    name: 'Racer',
    email,
    emailKey: email,
    company: null,
    topic: 'ce-readiness',
    note: null,
    visitorTz: 'Europe/London',
    cancelTokenHash: `race-token-${nextId}`,
    createdAtUtc: '2026-07-19T00:00:00Z',
    confirmedAtUtc: '2026-07-19T00:00:00Z',
    purgeAfterUtc: '2026-10-18T09:30:00Z',
    ...slot,
    ...overrides,
  };
}

async function countLiveBetween(fromUtc: string, toUtc: string): Promise<number> {
  const row = await env.BOOKINGS_DB
    .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed' AND slot_start_utc >= ? AND slot_start_utc < ?`)
    .bind(fromUtc, toUtc)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function countLiveForEmail(emailKey: string): Promise<number> {
  const row = await env.BOOKINGS_DB
    .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed' AND email_key = ?`)
    .bind(emailKey)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.BOOKINGS_DB.batch([
    env.BOOKINGS_DB.prepare('DELETE FROM bookings'),
    env.BOOKINGS_DB.prepare('DELETE FROM rate_events'),
  ]);
});

describe('createConfirmedBooking races', () => {
  it('two concurrent bookings for the exact same slot: exactly one row is created', async () => {
    const [a, b] = await Promise.all([
      createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_10_00)),
      createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_10_00)),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'slot_unavailable' }]);
    expect(await countLiveBetween(SLOT_10_00.slotStartUtc, SLOT_10_00.slotEndUtc)).toBe(1);
  });

  it('concurrent bookings for 10:00 and 10:30 the same day: only one succeeds (buffer overlap)', async () => {
    const [a, b] = await Promise.all([
      createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_10_00)),
      createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_10_30)),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await countLiveBetween(LONDON_DAY.londonDayStartUtc, LONDON_DAY.londonDayEndUtc)).toBe(1);
  });

  it('concurrent bookings on a day with one slot left under the cap: the cap is never exceeded', async () => {
    // Pre-fill one of the two daily slots synchronously, then race three more
    // concurrent attempts — for three DIFFERENT, mutually non-overlapping
    // times — for the single remaining place.
    const setup = await createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_10_00, { maxCallsPerDay: 2 }));
    expect(setup).toEqual({ ok: true });

    const results = await Promise.all([
      createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_12_00, { maxCallsPerDay: 2 })),
      createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_14_00, { maxCallsPerDay: 2 })),
      createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_16_00, { maxCallsPerDay: 2 })),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1); // exactly one of the three wins the last place
    expect(await countLiveBetween(LONDON_DAY.londonDayStartUtc, LONDON_DAY.londonDayEndUtc)).toBe(2); // never more than maxCallsPerDay
  });

  it('concurrent bookings by the same email for different slots: only one live booking survives', async () => {
    const emailKey = 'same-person@example.com';
    const results = await Promise.all([
      createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_10_00, { emailKey, email: emailKey })),
      createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_12_00, { emailKey, email: emailKey })),
      createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_TUESDAY, { emailKey, email: emailKey })), // a different day entirely
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await countLiveForEmail(emailKey)).toBe(1);
  });
});
