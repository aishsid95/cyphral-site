import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cancelConfirmedBooking,
  confirmHeldBooking,
  countActiveHolds,
  countRateEvents,
  createHold,
  expireHeldBooking,
  findHeldBookingByConfirmTokenHash,
  listLiveBookingIntervals,
  recordRateEvent,
  type CreateHoldInput,
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
function holdInput(overrides: Partial<CreateHoldInput> & Pick<CreateHoldInput, 'slotStartUtc' | 'slotEndUtc' | 'bufferedRangeStartUtc' | 'bufferedRangeEndUtc' | 'londonDayStartUtc' | 'londonDayEndUtc'>): CreateHoldInput {
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
    confirmTokenHash: `confirm-hash-${nextId}`,
    holdExpiresAtUtc: '2026-07-19T00:15:00Z',
    createdAtUtc: '2026-07-19T00:00:00Z',
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

describe('createHold', () => {
  it('succeeds for a fresh slot with no conflicts', async () => {
    const result = await createHold(env.BOOKINGS_DB, holdInput(SLOT_A));
    expect(result).toEqual({ ok: true });
  });

  it('rejects a second hold on the exact same slot', async () => {
    await createHold(env.BOOKINGS_DB, holdInput(SLOT_A));
    const second = await createHold(env.BOOKINGS_DB, holdInput(SLOT_A));
    expect(second).toEqual({ ok: false, reason: 'slot_unavailable' });
  });

  it('rejects an adjacent slot within the booking buffer', async () => {
    await createHold(env.BOOKINGS_DB, holdInput(SLOT_A));
    const adjacent = await createHold(env.BOOKINGS_DB, holdInput(SLOT_B));
    expect(adjacent).toEqual({ ok: false, reason: 'slot_unavailable' });
  });

  it('allows a slot clear of the booking buffer', async () => {
    await createHold(env.BOOKINGS_DB, holdInput(SLOT_A));
    const clear = await createHold(env.BOOKINGS_DB, holdInput(SLOT_C));
    expect(clear).toEqual({ ok: true });
  });

  it('rejects once the daily cap is reached, even for a non-overlapping slot the same day', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_A, maxCallsPerDay: 2 }));
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_C, maxCallsPerDay: 2 }));
    const thirdSameDay = await createHold(
      env.BOOKINGS_DB,
      holdInput({
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
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_A, maxCallsPerDay: 2 }));
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_C, maxCallsPerDay: 2 }));
    const nextDay = await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_TUESDAY, maxCallsPerDay: 2 }));
    expect(nextDay).toEqual({ ok: true });
  });

  it('rejects a second hold from the same email, even for an unrelated slot', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_A, emailKey: 'dup@example.com', email: 'dup@example.com' }));
    const secondFromSameEmail = await createHold(
      env.BOOKINGS_DB,
      holdInput({ ...SLOT_C, emailKey: 'dup@example.com', email: 'dup@example.com' }),
    );
    expect(secondFromSameEmail).toEqual({ ok: false, reason: 'slot_unavailable' });
  });

  it('frees a stale (past hold_expires_at) held slot atomically within the same batch', async () => {
    const first = await createHold(
      env.BOOKINGS_DB,
      holdInput({ ...SLOT_A, holdExpiresAtUtc: '2026-07-19T00:15:00Z', createdAtUtc: '2026-07-19T00:00:00Z' }),
    );
    expect(first).toEqual({ ok: true });

    // Attempt a new hold on the same slot "later", after the first hold's
    // expiry — the stale row must be flipped to expired and the slot re-offered
    // to the second attempt, in the same atomic batch.
    const second = await createHold(
      env.BOOKINGS_DB,
      holdInput({ ...SLOT_A, holdExpiresAtUtc: '2026-07-19T01:15:00Z', createdAtUtc: '2026-07-19T01:00:00Z' }),
    );
    expect(second).toEqual({ ok: true });
  });

  it('does not free a held slot before its hold_expires_at', async () => {
    await createHold(
      env.BOOKINGS_DB,
      holdInput({ ...SLOT_A, holdExpiresAtUtc: '2026-07-19T01:00:00Z', createdAtUtc: '2026-07-19T00:00:00Z' }),
    );
    const stillHeld = await createHold(
      env.BOOKINGS_DB,
      holdInput({ ...SLOT_A, holdExpiresAtUtc: '2026-07-19T00:45:00Z', createdAtUtc: '2026-07-19T00:30:00Z' }),
    );
    expect(stillHeld).toEqual({ ok: false, reason: 'slot_unavailable' });
  });
});

describe('confirmHeldBooking', () => {
  it('confirms a valid, unexpired hold and issues a cancel token', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_A, confirmTokenHash: 'ct-1' }));
    const result = await confirmHeldBooking(env.BOOKINGS_DB, {
      confirmTokenHash: 'ct-1',
      nowUtc: '2026-07-19T00:10:00Z',
      cancelTokenHash: 'cancel-1',
      confirmedAtUtc: '2026-07-19T00:10:00Z',
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects an unknown token', async () => {
    const result = await confirmHeldBooking(env.BOOKINGS_DB, {
      confirmTokenHash: 'does-not-exist',
      nowUtc: '2026-07-19T00:10:00Z',
      cancelTokenHash: 'cancel-x',
      confirmedAtUtc: '2026-07-19T00:10:00Z',
    });
    expect(result).toEqual({ ok: false, reason: 'link_expired' });
  });

  it('rejects a token whose hold has already expired', async () => {
    await createHold(
      env.BOOKINGS_DB,
      holdInput({ ...SLOT_A, confirmTokenHash: 'ct-2', holdExpiresAtUtc: '2026-07-19T00:15:00Z' }),
    );
    const result = await confirmHeldBooking(env.BOOKINGS_DB, {
      confirmTokenHash: 'ct-2',
      nowUtc: '2026-07-19T00:20:00Z', // after hold_expires_at
      cancelTokenHash: 'cancel-2',
      confirmedAtUtc: '2026-07-19T00:20:00Z',
    });
    expect(result).toEqual({ ok: false, reason: 'link_expired' });
  });

  it('a second confirm attempt with the same token fails (double-click / race)', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_A, confirmTokenHash: 'ct-3' }));
    const confirmArgs = {
      confirmTokenHash: 'ct-3',
      nowUtc: '2026-07-19T00:10:00Z',
      cancelTokenHash: 'cancel-3',
      confirmedAtUtc: '2026-07-19T00:10:00Z',
    };
    const first = await confirmHeldBooking(env.BOOKINGS_DB, confirmArgs);
    const second = await confirmHeldBooking(env.BOOKINGS_DB, confirmArgs);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, reason: 'link_expired' });
  });
});

describe('findHeldBookingByConfirmTokenHash / expireHeldBooking', () => {
  it('finds a held booking by its confirm token hash', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_A, id: 'find-me', confirmTokenHash: 'ct-find' }));
    const found = await findHeldBookingByConfirmTokenHash(env.BOOKINGS_DB, 'ct-find');
    expect(found).toEqual({ id: 'find-me', slotStartUtc: SLOT_A.slotStartUtc, slotEndUtc: SLOT_A.slotEndUtc });
  });

  it('returns null for an unknown token', async () => {
    expect(await findHeldBookingByConfirmTokenHash(env.BOOKINGS_DB, 'nope')).toBeNull();
  });

  it('expiring a held booking frees its slot for a new hold', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_A, id: 'to-expire' }));
    await expireHeldBooking(env.BOOKINGS_DB, 'to-expire');
    const result = await createHold(env.BOOKINGS_DB, holdInput(SLOT_A));
    expect(result).toEqual({ ok: true });
  });

  it('expiring an already-confirmed booking is a no-op (only touches held rows)', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_A, id: 'stays-confirmed', confirmTokenHash: 'ct-4' }));
    await confirmHeldBooking(env.BOOKINGS_DB, {
      confirmTokenHash: 'ct-4',
      nowUtc: '2026-07-19T00:10:00Z',
      cancelTokenHash: 'cancel-4',
      confirmedAtUtc: '2026-07-19T00:10:00Z',
    });
    await expireHeldBooking(env.BOOKINGS_DB, 'stays-confirmed');
    // Still confirmed and still occupying the slot: a new hold on it must fail.
    const stillBlocked = await createHold(env.BOOKINGS_DB, holdInput(SLOT_A));
    expect(stillBlocked).toEqual({ ok: false, reason: 'slot_unavailable' });
  });
});

describe('cancelConfirmedBooking', () => {
  async function confirmedBooking(cancelTokenHash: string) {
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_A, confirmTokenHash: `ct-for-${cancelTokenHash}` }));
    await confirmHeldBooking(env.BOOKINGS_DB, {
      confirmTokenHash: `ct-for-${cancelTokenHash}`,
      nowUtc: '2026-07-19T00:10:00Z',
      cancelTokenHash,
      confirmedAtUtc: '2026-07-19T00:10:00Z',
    });
  }

  it('cancels a confirmed booking whose slot has not started', async () => {
    await confirmedBooking('cancel-ok');
    const result = await cancelConfirmedBooking(env.BOOKINGS_DB, {
      cancelTokenHash: 'cancel-ok',
      nowUtc: '2026-07-19T00:30:00Z', // well before the 20 Jul slot
      cancelledAtUtc: '2026-07-19T00:30:00Z',
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects cancelling after the slot has already started', async () => {
    await confirmedBooking('cancel-late');
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
    await confirmedBooking('cancel-twice');
    const args = { cancelTokenHash: 'cancel-twice', nowUtc: '2026-07-19T00:30:00Z', cancelledAtUtc: '2026-07-19T00:30:00Z' };
    const first = await cancelConfirmedBooking(env.BOOKINGS_DB, args);
    const second = await cancelConfirmedBooking(env.BOOKINGS_DB, args);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, reason: 'link_expired' });
  });

  it('cancelling frees the slot for a new hold', async () => {
    await confirmedBooking('cancel-frees');
    await cancelConfirmedBooking(env.BOOKINGS_DB, {
      cancelTokenHash: 'cancel-frees',
      nowUtc: '2026-07-19T00:30:00Z',
      cancelledAtUtc: '2026-07-19T00:30:00Z',
    });
    const result = await createHold(env.BOOKINGS_DB, holdInput(SLOT_A));
    expect(result).toEqual({ ok: true });
  });
});

describe('listLiveBookingIntervals', () => {
  it('includes held and confirmed bookings, excludes cancelled and expired', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_A, id: 'held-1' })); // held
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_C, id: 'confirm-me', confirmTokenHash: 'ct-list' }));
    await confirmHeldBooking(env.BOOKINGS_DB, {
      confirmTokenHash: 'ct-list',
      nowUtc: '2026-07-19T00:10:00Z',
      cancelTokenHash: 'cancel-list',
      confirmedAtUtc: '2026-07-19T00:10:00Z',
    }); // confirmed
    await createHold(env.BOOKINGS_DB, holdInput({ ...SLOT_TUESDAY, id: 'expire-me' }));
    await expireHeldBooking(env.BOOKINGS_DB, 'expire-me'); // expired

    const intervals = await listLiveBookingIntervals(env.BOOKINGS_DB);
    expect(intervals).toHaveLength(2);
    expect(intervals).toContainEqual({ startUtc: SLOT_A.slotStartUtc, endUtc: SLOT_A.slotEndUtc });
    expect(intervals).toContainEqual({ startUtc: SLOT_C.slotStartUtc, endUtc: SLOT_C.slotEndUtc });
  });
});

describe('countActiveHolds', () => {
  it('counts only unexpired held bookings as of the given instant', async () => {
    await createHold(
      env.BOOKINGS_DB,
      holdInput({ ...SLOT_A, id: 'active', holdExpiresAtUtc: '2026-07-19T00:15:00Z', createdAtUtc: '2026-07-19T00:00:00Z' }),
    );
    await createHold(
      env.BOOKINGS_DB,
      holdInput({ ...SLOT_C, id: 'gone-stale', holdExpiresAtUtc: '2026-07-18T00:15:00Z', createdAtUtc: '2026-07-18T00:00:00Z' }),
    );
    expect(await countActiveHolds(env.BOOKINGS_DB, '2026-07-19T00:10:00Z')).toBe(1); // "gone-stale" already past its own expiry
  });
});

describe('rate_events', () => {
  it('counts events for a bucket/subject since a given instant, scoped correctly', async () => {
    await recordRateEvent(env.BOOKINGS_DB, { bucket: 'hold:ip', subjectHash: 'ip-hash-1', nowUtc: '2026-07-19T00:00:00Z' });
    await recordRateEvent(env.BOOKINGS_DB, { bucket: 'hold:ip', subjectHash: 'ip-hash-1', nowUtc: '2026-07-19T00:05:00Z' });
    await recordRateEvent(env.BOOKINGS_DB, { bucket: 'hold:ip', subjectHash: 'ip-hash-2', nowUtc: '2026-07-19T00:05:00Z' }); // different subject
    await recordRateEvent(env.BOOKINGS_DB, { bucket: 'hold:email', subjectHash: 'ip-hash-1', nowUtc: '2026-07-19T00:05:00Z' }); // different bucket

    const count = await countRateEvents(env.BOOKINGS_DB, {
      bucket: 'hold:ip',
      subjectHash: 'ip-hash-1',
      sinceUtc: '2026-07-19T00:00:00Z',
    });
    expect(count).toBe(2);
  });

  it('excludes events before the sinceUtc cutoff', async () => {
    await recordRateEvent(env.BOOKINGS_DB, { bucket: 'hold:ip', subjectHash: 'ip-hash-3', nowUtc: '2026-07-19T00:00:00Z' });
    const count = await countRateEvents(env.BOOKINGS_DB, {
      bucket: 'hold:ip',
      subjectHash: 'ip-hash-3',
      sinceUtc: '2026-07-19T00:00:01Z', // one second after the only event
    });
    expect(count).toBe(0);
  });
});
