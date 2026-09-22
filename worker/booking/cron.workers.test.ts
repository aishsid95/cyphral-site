import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHold, type CreateHoldInput } from './db';
import { expireStaleHolds, purgeExpiredBookings, purgeOldRateEvents, runBookingMaintenance } from './cron';

const LONDON_DAY = { londonDayStartUtc: '2026-07-19T23:00:00Z', londonDayEndUtc: '2026-07-20T23:00:00Z' };
const SLOT_A = {
  slotStartUtc: '2026-07-20T09:00:00Z',
  slotEndUtc: '2026-07-20T09:30:00Z',
  bufferedRangeStartUtc: '2026-07-20T08:45:00Z',
  bufferedRangeEndUtc: '2026-07-20T09:45:00Z',
  ...LONDON_DAY,
};
const SLOT_B = {
  slotStartUtc: '2026-07-20T11:00:00Z',
  slotEndUtc: '2026-07-20T11:30:00Z',
  bufferedRangeStartUtc: '2026-07-20T10:45:00Z',
  bufferedRangeEndUtc: '2026-07-20T11:45:00Z',
  ...LONDON_DAY,
};
const SLOT_C = {
  slotStartUtc: '2026-07-20T13:00:00Z',
  slotEndUtc: '2026-07-20T13:30:00Z',
  bufferedRangeStartUtc: '2026-07-20T12:45:00Z',
  bufferedRangeEndUtc: '2026-07-20T13:45:00Z',
  ...LONDON_DAY,
};

let nextId = 0;
function holdInput(overrides: Partial<CreateHoldInput> = {}): CreateHoldInput {
  nextId += 1;
  return {
    id: `cron-${nextId}`,
    ...SLOT_A,
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

beforeEach(async () => {
  await env.BOOKINGS_DB.batch([
    env.BOOKINGS_DB.prepare('DELETE FROM bookings'),
    env.BOOKINGS_DB.prepare('DELETE FROM rate_events'),
  ]);
});

describe('expireStaleHolds', () => {
  it('expires a held booking past its hold_expires_at, leaves an unexpired one alone', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ id: 'stale', holdExpiresAtUtc: '2026-07-19T00:15:00Z' }));
    await createHold(env.BOOKINGS_DB, holdInput({ id: 'fresh', holdExpiresAtUtc: '2026-07-19T02:00:00Z', ...{ slotStartUtc: '2026-07-20T11:00:00Z', slotEndUtc: '2026-07-20T11:30:00Z', bufferedRangeStartUtc: '2026-07-20T10:45:00Z', bufferedRangeEndUtc: '2026-07-20T11:45:00Z' } }));

    const changed = await expireStaleHolds(env.BOOKINGS_DB, '2026-07-19T01:00:00Z');
    expect(changed).toBe(1);

    const rows = await env.BOOKINGS_DB.prepare('SELECT id, status FROM bookings ORDER BY id').all<{ id: string; status: string }>();
    expect(rows.results).toEqual([
      { id: 'fresh', status: 'held' },
      { id: 'stale', status: 'expired' },
    ]);
  });

  it('is idempotent: a second run at the same instant changes nothing further', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ id: 'stale', holdExpiresAtUtc: '2026-07-19T00:15:00Z' }));
    await expireStaleHolds(env.BOOKINGS_DB, '2026-07-19T01:00:00Z');
    const second = await expireStaleHolds(env.BOOKINGS_DB, '2026-07-19T01:00:00Z');
    expect(second).toBe(0);
  });
});

describe('purgeExpiredBookings', () => {
  it('deletes a booking past purge_after, keeps one not yet due', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ id: 'old', purgeAfterUtc: '2026-08-01T00:00:00Z' }));
    await createHold(
      env.BOOKINGS_DB,
      holdInput({
        id: 'new',
        purgeAfterUtc: '2027-01-01T00:00:00Z',
        slotStartUtc: '2026-07-20T11:00:00Z',
        slotEndUtc: '2026-07-20T11:30:00Z',
        bufferedRangeStartUtc: '2026-07-20T10:45:00Z',
        bufferedRangeEndUtc: '2026-07-20T11:45:00Z',
      }),
    );

    const deleted = await purgeExpiredBookings(env.BOOKINGS_DB, '2026-09-01T00:00:00Z');
    expect(deleted).toBe(1);

    const rows = await env.BOOKINGS_DB.prepare('SELECT id FROM bookings').all<{ id: string }>();
    expect(rows.results).toEqual([{ id: 'new' }]);
  });
});

describe('purgeOldRateEvents', () => {
  it('deletes events older than 7 days, keeps recent ones', async () => {
    await env.BOOKINGS_DB.batch([
      env.BOOKINGS_DB.prepare('INSERT INTO rate_events (bucket, subject_hash, created_at) VALUES (?, ?, ?)').bind(
        'hold:ip',
        'old',
        '2026-07-01T00:00:00Z',
      ),
      env.BOOKINGS_DB.prepare('INSERT INTO rate_events (bucket, subject_hash, created_at) VALUES (?, ?, ?)').bind(
        'hold:ip',
        'recent',
        '2026-07-18T00:00:00Z',
      ),
    ]);

    const deleted = await purgeOldRateEvents(env.BOOKINGS_DB, '2026-07-19T00:00:00Z'); // cutoff = 12 July
    expect(deleted).toBe(1);

    const rows = await env.BOOKINGS_DB.prepare('SELECT subject_hash FROM rate_events').all<{ subject_hash: string }>();
    expect(rows.results).toEqual([{ subject_hash: 'recent' }]);
  });
});

describe('runBookingMaintenance — alerting on mail_failed', () => {
  async function bookingWithMailFailed(id: string, overrides: Partial<CreateHoldInput> = {}) {
    await createHold(env.BOOKINGS_DB, holdInput({ id, ...overrides }));
    await env.BOOKINGS_DB.prepare('UPDATE bookings SET mail_failed = 1 WHERE id = ?').bind(id).run();
  }

  it('skips the alert step entirely when the Resend key is missing, without touching D1 or calling the sender', async () => {
    await bookingWithMailFailed('failed-no-key');
    const sendMailFailedAlert = vi.fn(async () => ({ ok: true }) as const);

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T01:00:00Z', resendApiKey: undefined, ownerEmail: 'hello@cyphral.co.uk' },
      { sendMailFailedAlert },
    );

    expect(result.alertsSent).toBe(0);
    expect(result.alertsFailed).toBe(0);
    expect(sendMailFailedAlert).not.toHaveBeenCalled();

    // The booking is untouched — still eligible for a real alert once the key is configured.
    const row = await env.BOOKINGS_DB
      .prepare('SELECT mail_alert_sent FROM bookings WHERE id = ?')
      .bind('failed-no-key')
      .first<{ mail_alert_sent: number }>();
    expect(row?.mail_alert_sent).toBe(0);
  });

  it('alerts once for a mail_failed booking and marks it as alerted', async () => {
    await bookingWithMailFailed('failed-1');
    const sendMailFailedAlert = vi.fn(async () => ({ ok: true }) as const);

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T01:00:00Z', resendApiKey: 'key', ownerEmail: 'hello@cyphral.co.uk' },
      { sendMailFailedAlert },
    );

    expect(result.alertsSent).toBe(1);
    expect(sendMailFailedAlert).toHaveBeenCalledTimes(1);
    expect(sendMailFailedAlert).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 'failed-1', idempotencyKey: 'failed-1:mail-failed-alert' }),
    );

    const row = await env.BOOKINGS_DB
      .prepare('SELECT mail_alert_sent FROM bookings WHERE id = ?')
      .bind('failed-1')
      .first<{ mail_alert_sent: number }>();
    expect(row?.mail_alert_sent).toBe(1);
  });

  it('does not alert again on a second run (idempotent)', async () => {
    await bookingWithMailFailed('failed-2');
    const sendMailFailedAlert = vi.fn(async () => ({ ok: true }) as const);
    const params = { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T01:00:00Z', resendApiKey: 'key', ownerEmail: 'hello@cyphral.co.uk' };

    await runBookingMaintenance(params, { sendMailFailedAlert });
    const second = await runBookingMaintenance(params, { sendMailFailedAlert });

    expect(second.alertsSent).toBe(0);
    expect(sendMailFailedAlert).toHaveBeenCalledTimes(1);
  });

  it('does not alert for a booking without mail_failed set', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ id: 'never-failed' }));
    const sendMailFailedAlert = vi.fn(async () => ({ ok: true }) as const);

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T01:00:00Z', resendApiKey: 'key', ownerEmail: 'hello@cyphral.co.uk' },
      { sendMailFailedAlert },
    );

    expect(result.alertsSent).toBe(0);
    expect(sendMailFailedAlert).not.toHaveBeenCalled();
  });

  it('a failed alert send for one row does not throw and does not block other rows', async () => {
    await bookingWithMailFailed('failed-a', SLOT_B);
    await bookingWithMailFailed('failed-b', SLOT_C);
    const sendMailFailedAlert = vi.fn(async (params: { bookingId: string }) =>
      params.bookingId === 'failed-a' ? ({ ok: false } as const) : ({ ok: true } as const),
    );

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T01:00:00Z', resendApiKey: 'key', ownerEmail: 'hello@cyphral.co.uk' },
      { sendMailFailedAlert },
    );

    expect(result.alertsSent).toBe(1);
    expect(result.alertsFailed).toBe(1);
    expect(sendMailFailedAlert).toHaveBeenCalledTimes(2);

    // The failed one stays un-alerted, so a future run will retry it.
    const row = await env.BOOKINGS_DB
      .prepare('SELECT mail_alert_sent FROM bookings WHERE id = ?')
      .bind('failed-a')
      .first<{ mail_alert_sent: number }>();
    expect(row?.mail_alert_sent).toBe(0);
  });

  it('an exception thrown by the alert sender is caught, not propagated', async () => {
    await bookingWithMailFailed('failed-throws');
    const sendMailFailedAlert = vi.fn(async () => {
      throw new Error('network exploded');
    });

    await expect(
      runBookingMaintenance(
        { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T01:00:00Z', resendApiKey: 'key', ownerEmail: 'hello@cyphral.co.uk' },
        { sendMailFailedAlert },
      ),
    ).resolves.toMatchObject({ alertsSent: 0, alertsFailed: 1 });
  });
});

describe('runBookingMaintenance — full sweep', () => {
  it('runs all three jobs and reports accurate counts', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ id: 'stale-hold', ...SLOT_A, holdExpiresAtUtc: '2026-07-19T00:15:00Z' }));

    await createHold(env.BOOKINGS_DB, holdInput({ id: 'old-booking', ...SLOT_B, purgeAfterUtc: '2026-08-01T00:00:00Z' }));
    // A booking that was already confirmed long ago — isolated from the
    // hold-expiry job, which only ever touches status = 'held' rows.
    await env.BOOKINGS_DB.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").bind('old-booking').run();

    await env.BOOKINGS_DB
      .prepare('INSERT INTO rate_events (bucket, subject_hash, created_at) VALUES (?, ?, ?)')
      .bind('hold:ip', 'stale-event', '2026-07-01T00:00:00Z')
      .run();

    const sendMailFailedAlert = vi.fn(async () => ({ ok: true }) as const);
    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-09-01T00:00:00Z', resendApiKey: 'key', ownerEmail: 'hello@cyphral.co.uk' },
      { sendMailFailedAlert },
    );

    expect(result).toEqual({ expiredHolds: 1, purgedBookings: 1, purgedRateEvents: 1, alertsSent: 0, alertsFailed: 0 });
  });

  it('still expires and purges when the Resend key is missing — only the alert step is skipped', async () => {
    await createHold(env.BOOKINGS_DB, holdInput({ id: 'stale-hold-no-key', ...SLOT_A, holdExpiresAtUtc: '2026-07-19T00:15:00Z' }));
    await createHold(env.BOOKINGS_DB, holdInput({ id: 'old-booking-no-key', ...SLOT_B, purgeAfterUtc: '2026-08-01T00:00:00Z' }));
    await env.BOOKINGS_DB.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").bind('old-booking-no-key').run();
    await env.BOOKINGS_DB
      .prepare('INSERT INTO rate_events (bucket, subject_hash, created_at) VALUES (?, ?, ?)')
      .bind('hold:ip', 'stale-event-no-key', '2026-07-01T00:00:00Z')
      .run();

    const result = await runBookingMaintenance({
      db: env.BOOKINGS_DB,
      nowUtc: '2026-09-01T00:00:00Z',
      resendApiKey: undefined,
      ownerEmail: 'hello@cyphral.co.uk',
    });

    expect(result).toEqual({ expiredHolds: 1, purgedBookings: 1, purgedRateEvents: 1, alertsSent: 0, alertsFailed: 0 });

    const staleHold = await env.BOOKINGS_DB
      .prepare('SELECT status FROM bookings WHERE id = ?')
      .bind('stale-hold-no-key')
      .first<{ status: string }>();
    expect(staleHold?.status).toBe('expired');
  });
});
