import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cancelConfirmedBooking,
  countRateEvents,
  createConfirmedBooking,
  findConfirmedBookingByCancelTokenHash,
  listBookingsNeedingReminder,
  listLiveBookingIntervals,
  markMailFailed,
  markReminderSent,
  recordRateEvent,
  type CreateBookingInput,
} from './db';

// Monday 20 Jul 2026 10:00-10:30 BST = 09:00-09:30 UTC. London calendar day
// bounds for the 20th (BST, midnight local = 23:00 UTC the day before).
const SLOT_A = {
  slotStartUtc: '2026-07-20T09:00:00Z',
  slotEndUtc: '2026-07-20T09:30:00Z',
  bufferedRangeStartUtc: '2026-07-20T08:45:00Z', // -15min booking buffer
  bufferedRangeEndUtc: '2026-07-20T09:45:00Z', // +15min booking buffer
  londonDayStartUtc: '2026-07-19T23:00:00Z',
  londonDayEndUtc: '2026-07-20T23:00:00Z',
};
// The next slot on the same grid: 10:30-11:00 BST = 09:30-10:00 UTC.
const SLOT_B = {
  slotStartUtc: '2026-07-20T09:30:00Z',
  slotEndUtc: '2026-07-20T10:00:00Z',
  bufferedRangeStartUtc: '2026-07-20T09:15:00Z',
  bufferedRangeEndUtc: '2026-07-20T10:15:00Z',
  londonDayStartUtc: '2026-07-19T23:00:00Z',
  londonDayEndUtc: '2026-07-20T23:00:00Z',
};
// Well clear of A/B's buffers: 12:00-12:30 BST = 11:00-11:30 UTC.
const SLOT_C = {
  slotStartUtc: '2026-07-20T11:00:00Z',
  slotEndUtc: '2026-07-20T11:30:00Z',
  bufferedRangeStartUtc: '2026-07-20T10:45:00Z',
  bufferedRangeEndUtc: '2026-07-20T11:45:00Z',
  londonDayStartUtc: '2026-07-19T23:00:00Z',
  londonDayEndUtc: '2026-07-20T23:00:00Z',
};
// A different London day entirely: Tuesday 21 Jul, 10:00 BST.
const SLOT_TUESDAY = {
  slotStartUtc: '2026-07-21T09:00:00Z',
  slotEndUtc: '2026-07-21T09:30:00Z',
  bufferedRangeStartUtc: '2026-07-21T08:45:00Z',
  bufferedRangeEndUtc: '2026-07-21T09:45:00Z',
  londonDayStartUtc: '2026-07-20T23:00:00Z',
  londonDayEndUtc: '2026-07-21T23:00:00Z',
};

let nextId = 0;
function bookingInput(
  overrides: Partial<CreateBookingInput> &
    Pick<CreateBookingInput, 'slotStartUtc' | 'slotEndUtc' | 'bufferedRangeStartUtc' | 'bufferedRangeEndUtc' | 'londonDayStartUtc' | 'londonDayEndUtc'>,
): CreateBookingInput {
  nextId += 1;
  return {
    id: `booking-${nextId}`,
    maxCallsPerDay: 2,
    name: 'Test Visitor',
    email: `visitor${nextId}@example.com`,
    emailKey: `visitor${nextId}@example.com`,
    company: null,
    topic: 'ce-readiness',
    note: null,
    visitorTz: 'Europe/London',
    cancelTokenHash: `cancel-hash-${nextId}`,
    createdAtUtc: '2026-07-19T00:00:00Z',
    confirmedAtUtc: '2026-07-19T00:00:00Z',
    purgeAfterUtc: '2026-10-18T09:30:00Z',
    ...overrides,
  };
}

// D1 storage in the test Worker is NOT reset between individual `it()`
// blocks within a file (unlike Durable Object storage) — every test in this
// file shares one real SQLite database, so each must start from a clean slate.
beforeEach(async () => {
  await env.BOOKINGS_DB.batch([
    env.BOOKINGS_DB.prepare('DELETE FROM bookings'),
    env.BOOKINGS_DB.prepare('DELETE FROM rate_events'),
  ]);
});

describe('createConfirmedBooking', () => {
  it('succeeds for a fresh slot with no conflicts', async () => {
    const result = await createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_A));
    expect(result).toEqual({ ok: true });
  });

  it('writes status confirmed directly — no held intermediate state', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, id: 'direct-confirm' }));
    const row = await env.BOOKINGS_DB
      .prepare('SELECT status, confirmed_at FROM bookings WHERE id = ?')
      .bind('direct-confirm')
      .first<{ status: string; confirmed_at: string | null }>();
    expect(row?.status).toBe('confirmed');
    expect(row?.confirmed_at).not.toBeNull();
  });

  it('rejects a second booking on the exact same slot', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_A));
    const second = await createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_A));
    expect(second).toEqual({ ok: false, reason: 'slot_unavailable' });
  });

  it('rejects an adjacent slot within the booking buffer', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_A));
    const adjacent = await createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_B));
    expect(adjacent).toEqual({ ok: false, reason: 'slot_unavailable' });
  });

  it('allows a slot clear of the booking buffer', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_A));
    const clear = await createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_C));
    expect(clear).toEqual({ ok: true });
  });

  it('rejects once the daily cap is reached, even for a non-overlapping slot the same day', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, maxCallsPerDay: 2 }));
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_C, maxCallsPerDay: 2 }));
    const thirdSameDay = await createConfirmedBooking(
      env.BOOKINGS_DB,
      bookingInput({
        slotStartUtc: '2026-07-20T15:00:00Z',
        slotEndUtc: '2026-07-20T15:30:00Z',
        bufferedRangeStartUtc: '2026-07-20T14:45:00Z',
        bufferedRangeEndUtc: '2026-07-20T15:45:00Z',
        londonDayStartUtc: SLOT_A.londonDayStartUtc,
        londonDayEndUtc: SLOT_A.londonDayEndUtc,
        maxCallsPerDay: 2,
      }),
    );
    expect(thirdSameDay).toEqual({ ok: false, reason: 'slot_unavailable' });
  });

  it('allows the cap-reaching day to still book on a different day', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, maxCallsPerDay: 2 }));
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_C, maxCallsPerDay: 2 }));
    const nextDay = await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_TUESDAY, maxCallsPerDay: 2 }));
    expect(nextDay).toEqual({ ok: true });
  });

  it('rejects a second booking from the same email, even for an unrelated slot', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, emailKey: 'dup@example.com', email: 'dup@example.com' }));
    const secondFromSameEmail = await createConfirmedBooking(
      env.BOOKINGS_DB,
      bookingInput({ ...SLOT_C, emailKey: 'dup@example.com', email: 'dup@example.com' }),
    );
    expect(secondFromSameEmail).toEqual({ ok: false, reason: 'slot_unavailable' });
  });
});

describe('findConfirmedBookingByCancelTokenHash', () => {
  it('finds a confirmed booking by its cancel token hash, with full booking details', async () => {
    await createConfirmedBooking(
      env.BOOKINGS_DB,
      bookingInput({
        ...SLOT_A,
        id: 'find-me',
        cancelTokenHash: 'cancel-find',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        emailKey: 'ada@example.com',
        company: 'Analytical Engines Ltd',
        topic: 'automation',
        note: 'Looking forward to it',
        visitorTz: 'Europe/Paris',
      }),
    );
    const found = await findConfirmedBookingByCancelTokenHash(env.BOOKINGS_DB, 'cancel-find');
    expect(found).toEqual({
      id: 'find-me',
      slotStartUtc: SLOT_A.slotStartUtc,
      slotEndUtc: SLOT_A.slotEndUtc,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      emailKey: 'ada@example.com',
      company: 'Analytical Engines Ltd',
      topic: 'automation',
      note: 'Looking forward to it',
      visitorTz: 'Europe/Paris',
    });
  });

  it('returns null for an unknown token', async () => {
    expect(await findConfirmedBookingByCancelTokenHash(env.BOOKINGS_DB, 'nope')).toBeNull();
  });
});

describe('cancelConfirmedBooking', () => {
  it('cancels a confirmed booking whose slot has not started', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, cancelTokenHash: 'cancel-ok' }));
    const result = await cancelConfirmedBooking(env.BOOKINGS_DB, {
      cancelTokenHash: 'cancel-ok',
      nowUtc: '2026-07-19T00:30:00Z', // well before the 20 Jul slot
      cancelledAtUtc: '2026-07-19T00:30:00Z',
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects cancelling after the slot has already started', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, cancelTokenHash: 'cancel-late' }));
    const result = await cancelConfirmedBooking(env.BOOKINGS_DB, {
      cancelTokenHash: 'cancel-late',
      nowUtc: '2026-07-20T09:15:00Z', // slot started at 09:00
      cancelledAtUtc: '2026-07-20T09:15:00Z',
    });
    expect(result).toEqual({ ok: false, reason: 'link_expired' });
  });

  it('rejects an unknown cancel token', async () => {
    const result = await cancelConfirmedBooking(env.BOOKINGS_DB, {
      cancelTokenHash: 'never-issued',
      nowUtc: '2026-07-19T00:30:00Z',
      cancelledAtUtc: '2026-07-19T00:30:00Z',
    });
    expect(result).toEqual({ ok: false, reason: 'link_expired' });
  });

  it('a second cancel attempt with the same token fails (token is single-use)', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, cancelTokenHash: 'cancel-twice' }));
    const args = { cancelTokenHash: 'cancel-twice', nowUtc: '2026-07-19T00:30:00Z', cancelledAtUtc: '2026-07-19T00:30:00Z' };
    const first = await cancelConfirmedBooking(env.BOOKINGS_DB, args);
    const second = await cancelConfirmedBooking(env.BOOKINGS_DB, args);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, reason: 'link_expired' });
  });

  it('cancelling frees the slot for a new booking', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, cancelTokenHash: 'cancel-frees' }));
    await cancelConfirmedBooking(env.BOOKINGS_DB, {
      cancelTokenHash: 'cancel-frees',
      nowUtc: '2026-07-19T00:30:00Z',
      cancelledAtUtc: '2026-07-19T00:30:00Z',
    });
    const result = await createConfirmedBooking(env.BOOKINGS_DB, bookingInput(SLOT_A));
    expect(result).toEqual({ ok: true });
  });
});

describe('markMailFailed', () => {
  it('sets mail_failed on the booking without changing its status', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, id: 'mail-fail-me' }));
    await markMailFailed(env.BOOKINGS_DB, 'mail-fail-me');

    const row = await env.BOOKINGS_DB
      .prepare('SELECT status, mail_failed FROM bookings WHERE id = ?')
      .bind('mail-fail-me')
      .first<{ status: string; mail_failed: number }>();
    expect(row).toEqual({ status: 'confirmed', mail_failed: 1 });
  });
});

describe('listLiveBookingIntervals', () => {
  it('includes confirmed bookings, excludes cancelled', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, id: 'live-1', cancelTokenHash: 'ct-live-1' }));
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_C, id: 'cancel-me', cancelTokenHash: 'ct-cancel-me' }));
    await cancelConfirmedBooking(env.BOOKINGS_DB, {
      cancelTokenHash: 'ct-cancel-me',
      nowUtc: '2026-07-19T00:30:00Z',
      cancelledAtUtc: '2026-07-19T00:30:00Z',
    });

    const intervals = await listLiveBookingIntervals(env.BOOKINGS_DB);
    expect(intervals).toHaveLength(1);
    expect(intervals).toContainEqual({ startUtc: SLOT_A.slotStartUtc, endUtc: SLOT_A.slotEndUtc });
  });
});

describe('listBookingsNeedingReminder', () => {
  it('includes a confirmed, unreminded booking starting between 1 and 24 hours from now', async () => {
    await createConfirmedBooking(
      env.BOOKINGS_DB,
      bookingInput({ ...SLOT_A, id: 'due-reminder', name: 'Grace Hopper', email: 'grace@example.com', emailKey: 'grace@example.com' }),
    );
    // Slot is 2026-07-20T09:00:00Z; "now" here is 12 hours before it.
    const candidates = await listBookingsNeedingReminder(env.BOOKINGS_DB, '2026-07-19T21:00:00Z');
    expect(candidates).toEqual([
      {
        id: 'due-reminder',
        name: 'Grace Hopper',
        email: 'grace@example.com',
        company: null,
        topic: 'ce-readiness',
        slotStartUtc: SLOT_A.slotStartUtc,
        visitorTz: 'Europe/London',
      },
    ]);
  });

  it('excludes a booking whose slot starts less than 1 hour from now', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, id: 'too-soon' }));
    // 30 minutes before the slot.
    const candidates = await listBookingsNeedingReminder(env.BOOKINGS_DB, '2026-07-20T08:30:00Z');
    expect(candidates).toEqual([]);
  });

  it('excludes a booking whose slot starts more than 24 hours from now', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, id: 'too-far' }));
    // 25 hours before the slot.
    const candidates = await listBookingsNeedingReminder(env.BOOKINGS_DB, '2026-07-19T08:00:00Z');
    expect(candidates).toEqual([]);
  });

  it('excludes a booking that already has reminder_sent_at set', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, id: 'already-reminded', cancelTokenHash: 'ct-already' }));
    await markReminderSent(env.BOOKINGS_DB, { id: 'already-reminded', cancelTokenHash: 'new-hash', sentAtUtc: '2026-07-19T21:00:00Z' });
    const candidates = await listBookingsNeedingReminder(env.BOOKINGS_DB, '2026-07-19T21:05:00Z');
    expect(candidates).toEqual([]);
  });

  it('excludes a cancelled booking', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, id: 'cancelled-one', cancelTokenHash: 'ct-cancelled-one' }));
    await cancelConfirmedBooking(env.BOOKINGS_DB, {
      cancelTokenHash: 'ct-cancelled-one',
      nowUtc: '2026-07-19T00:30:00Z',
      cancelledAtUtc: '2026-07-19T00:30:00Z',
    });
    const candidates = await listBookingsNeedingReminder(env.BOOKINGS_DB, '2026-07-19T21:00:00Z');
    expect(candidates).toEqual([]);
  });
});

describe('markReminderSent', () => {
  it('sets reminder_sent_at and rotates the cancel token hash', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, id: 'to-remind', cancelTokenHash: 'original-hash' }));
    const result = await markReminderSent(env.BOOKINGS_DB, {
      id: 'to-remind',
      cancelTokenHash: 'rotated-hash',
      sentAtUtc: '2026-07-19T21:00:00Z',
    });
    expect(result).toEqual({ ok: true });

    const row = await env.BOOKINGS_DB
      .prepare('SELECT reminder_sent_at, cancel_token_hash FROM bookings WHERE id = ?')
      .bind('to-remind')
      .first<{ reminder_sent_at: string | null; cancel_token_hash: string }>();
    expect(row?.reminder_sent_at).toBe('2026-07-19T21:00:00Z');
    expect(row?.cancel_token_hash).toBe('rotated-hash');
  });

  it('the original cancel token stops matching once rotated, the new one works', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, id: 'rotate-check', cancelTokenHash: 'original-hash-2' }));
    await markReminderSent(env.BOOKINGS_DB, { id: 'rotate-check', cancelTokenHash: 'rotated-hash-2', sentAtUtc: '2026-07-19T21:00:00Z' });

    expect(await findConfirmedBookingByCancelTokenHash(env.BOOKINGS_DB, 'original-hash-2')).toBeNull();
    expect(await findConfirmedBookingByCancelTokenHash(env.BOOKINGS_DB, 'rotated-hash-2')).not.toBeNull();
  });

  it('a second call for the same booking is a no-op (idempotent — protects a double cron run)', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, id: 'twice', cancelTokenHash: 'first-hash' }));
    const first = await markReminderSent(env.BOOKINGS_DB, { id: 'twice', cancelTokenHash: 'second-hash', sentAtUtc: '2026-07-19T21:00:00Z' });
    const second = await markReminderSent(env.BOOKINGS_DB, { id: 'twice', cancelTokenHash: 'third-hash', sentAtUtc: '2026-07-19T21:05:00Z' });
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false });

    // The second call's hash must not have overwritten the first's.
    const row = await env.BOOKINGS_DB
      .prepare('SELECT cancel_token_hash FROM bookings WHERE id = ?')
      .bind('twice')
      .first<{ cancel_token_hash: string }>();
    expect(row?.cancel_token_hash).toBe('second-hash');
  });

  it('fails for a cancelled booking', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ ...SLOT_A, id: 'cancelled-no-remind', cancelTokenHash: 'ct-cnr' }));
    await cancelConfirmedBooking(env.BOOKINGS_DB, {
      cancelTokenHash: 'ct-cnr',
      nowUtc: '2026-07-19T00:30:00Z',
      cancelledAtUtc: '2026-07-19T00:30:00Z',
    });
    const result = await markReminderSent(env.BOOKINGS_DB, {
      id: 'cancelled-no-remind',
      cancelTokenHash: 'irrelevant',
      sentAtUtc: '2026-07-19T21:00:00Z',
    });
    expect(result).toEqual({ ok: false });
  });
});

describe('rate_events', () => {
  it('counts events for a bucket/subject since a given instant, scoped correctly', async () => {
    await recordRateEvent(env.BOOKINGS_DB, { bucket: 'book:ip', subjectHash: 'ip-hash-1', nowUtc: '2026-07-19T00:00:00Z' });
    await recordRateEvent(env.BOOKINGS_DB, { bucket: 'book:ip', subjectHash: 'ip-hash-1', nowUtc: '2026-07-19T00:05:00Z' });
    await recordRateEvent(env.BOOKINGS_DB, { bucket: 'book:ip', subjectHash: 'ip-hash-2', nowUtc: '2026-07-19T00:05:00Z' }); // different subject
    await recordRateEvent(env.BOOKINGS_DB, { bucket: 'book:email', subjectHash: 'ip-hash-1', nowUtc: '2026-07-19T00:05:00Z' }); // different bucket

    const count = await countRateEvents(env.BOOKINGS_DB, {
      bucket: 'book:ip',
      subjectHash: 'ip-hash-1',
      sinceUtc: '2026-07-19T00:00:00Z',
    });
    expect(count).toBe(2);
  });

  it('excludes events before the sinceUtc cutoff', async () => {
    await recordRateEvent(env.BOOKINGS_DB, { bucket: 'book:ip', subjectHash: 'ip-hash-3', nowUtc: '2026-07-19T00:00:00Z' });
    const count = await countRateEvents(env.BOOKINGS_DB, {
      bucket: 'book:ip',
      subjectHash: 'ip-hash-3',
      sinceUtc: '2026-07-19T00:00:01Z', // one second after the only event
    });
    expect(count).toBe(0);
  });
});
