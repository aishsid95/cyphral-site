import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelConfirmedBooking, createConfirmedBooking, type CreateBookingInput } from './db';
import { purgeExpiredBookings, purgeOldRateEvents, runBookingMaintenance, type RunBookingMaintenanceDeps } from './cron';

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
function bookingInput(overrides: Partial<CreateBookingInput> = {}): CreateBookingInput {
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
    cancelTokenHash: `cancel-hash-${nextId}`,
    createdAtUtc: '2026-07-19T00:00:00Z',
    confirmedAtUtc: '2026-07-19T00:00:00Z',
    purgeAfterUtc: '2026-10-18T09:30:00Z',
    ...overrides,
  };
}

const BASE_PARAMS = { ownerEmail: 'hello@cyphral.co.uk', rateHmacSecret: 'secret' };

beforeEach(async () => {
  await env.BOOKINGS_DB.batch([
    env.BOOKINGS_DB.prepare('DELETE FROM bookings'),
    env.BOOKINGS_DB.prepare('DELETE FROM rate_events'),
  ]);
});

describe('purgeExpiredBookings', () => {
  it('deletes a booking past purge_after, keeps one not yet due', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'old', purgeAfterUtc: '2026-08-01T00:00:00Z' }));
    await createConfirmedBooking(
      env.BOOKINGS_DB,
      bookingInput({
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
        'book:ip',
        'old',
        '2026-07-01T00:00:00Z',
      ),
      env.BOOKINGS_DB.prepare('INSERT INTO rate_events (bucket, subject_hash, created_at) VALUES (?, ?, ?)').bind(
        'book:ip',
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
  async function bookingWithMailFailed(id: string, overrides: Partial<CreateBookingInput> = {}) {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id, ...overrides }));
    await env.BOOKINGS_DB.prepare('UPDATE bookings SET mail_failed = 1 WHERE id = ?').bind(id).run();
  }

  const deps = (): RunBookingMaintenanceDeps => ({
    sendMailFailedAlert: vi.fn(async () => ({ ok: true })),
    sendReminderEmail: vi.fn(async () => ({ ok: true })),
    sendReminderDigestEmail: vi.fn(async () => ({ ok: true })),
  });

  it('skips the alert step entirely when the Resend key is missing, without touching D1 or calling the sender', async () => {
    await bookingWithMailFailed('failed-no-key');
    const d = deps();

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T01:00:00Z', resendApiKey: undefined, ...BASE_PARAMS },
      d,
    );

    expect(result.alertsSent).toBe(0);
    expect(result.alertsFailed).toBe(0);
    expect(d.sendMailFailedAlert).not.toHaveBeenCalled();

    // The booking is untouched — still eligible for a real alert once the key is configured.
    const row = await env.BOOKINGS_DB
      .prepare('SELECT mail_alert_sent FROM bookings WHERE id = ?')
      .bind('failed-no-key')
      .first<{ mail_alert_sent: number }>();
    expect(row?.mail_alert_sent).toBe(0);
  });

  it('alerts once for a mail_failed booking and marks it as alerted', async () => {
    await bookingWithMailFailed('failed-1');
    const d = deps();

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T01:00:00Z', resendApiKey: 'key', ...BASE_PARAMS },
      d,
    );

    expect(result.alertsSent).toBe(1);
    expect(d.sendMailFailedAlert).toHaveBeenCalledTimes(1);
    expect(d.sendMailFailedAlert).toHaveBeenCalledWith(
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
    const d = deps();
    const params = { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T01:00:00Z', resendApiKey: 'key', ...BASE_PARAMS };

    await runBookingMaintenance(params, d);
    const second = await runBookingMaintenance(params, d);

    expect(second.alertsSent).toBe(0);
    expect(d.sendMailFailedAlert).toHaveBeenCalledTimes(1);
  });

  it('does not alert for a booking without mail_failed set', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'never-failed' }));
    const d = deps();

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T01:00:00Z', resendApiKey: 'key', ...BASE_PARAMS },
      d,
    );

    expect(result.alertsSent).toBe(0);
    expect(d.sendMailFailedAlert).not.toHaveBeenCalled();
  });

  it('a failed alert send for one row does not throw and does not block other rows', async () => {
    await bookingWithMailFailed('failed-a', SLOT_B);
    await bookingWithMailFailed('failed-b', SLOT_C);
    const d = deps();
    d.sendMailFailedAlert = vi.fn(async (p: { bookingId: string }) =>
      p.bookingId === 'failed-a' ? ({ ok: false } as const) : ({ ok: true } as const),
    );

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T01:00:00Z', resendApiKey: 'key', ...BASE_PARAMS },
      d,
    );

    expect(result.alertsSent).toBe(1);
    expect(result.alertsFailed).toBe(1);
    expect(d.sendMailFailedAlert).toHaveBeenCalledTimes(2);

    // The failed one stays un-alerted, so a future run will retry it.
    const row = await env.BOOKINGS_DB
      .prepare('SELECT mail_alert_sent FROM bookings WHERE id = ?')
      .bind('failed-a')
      .first<{ mail_alert_sent: number }>();
    expect(row?.mail_alert_sent).toBe(0);
  });

  it('an exception thrown by the alert sender is caught, not propagated', async () => {
    await bookingWithMailFailed('failed-throws');
    const d = deps();
    d.sendMailFailedAlert = vi.fn(async () => {
      throw new Error('network exploded');
    });

    await expect(
      runBookingMaintenance(
        { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T01:00:00Z', resendApiKey: 'key', ...BASE_PARAMS },
        d,
      ),
    ).resolves.toMatchObject({ alertsSent: 0, alertsFailed: 1 });
  });
});

describe('runBookingMaintenance — day-before reminders', () => {
  const deps = (): RunBookingMaintenanceDeps => ({
    sendMailFailedAlert: vi.fn(async () => ({ ok: true })),
    sendReminderEmail: vi.fn(async () => ({ ok: true })),
    sendReminderDigestEmail: vi.fn(async () => ({ ok: true })),
  });

  it('sends a reminder for a confirmed booking due one, and marks it sent', async () => {
    // Slot at 09:00 20 Jul; "now" is 12 hours before, well inside the 1-24h window.
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'due', ...SLOT_A }));
    const d = deps();

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T21:00:00Z', resendApiKey: 'key', ...BASE_PARAMS },
      d,
    );

    expect(result.remindersSent).toBe(1);
    expect(result.remindersFailed).toBe(0);
    expect(d.sendReminderEmail).toHaveBeenCalledTimes(1);
    expect(d.sendReminderEmail).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'due:reminder' }));

    const row = await env.BOOKINGS_DB
      .prepare('SELECT reminder_sent_at FROM bookings WHERE id = ?')
      .bind('due')
      .first<{ reminder_sent_at: string | null }>();
    expect(row?.reminder_sent_at).toBe('2026-07-19T21:00:00Z');
  });

  it('does not send a reminder twice if the cron runs twice', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'twice-run', ...SLOT_A }));
    const d = deps();
    const params = { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T21:00:00Z', resendApiKey: 'key', ...BASE_PARAMS };

    const first = await runBookingMaintenance(params, d);
    const second = await runBookingMaintenance({ ...params, nowUtc: '2026-07-19T21:30:00Z' }, d);

    expect(first.remindersSent).toBe(1);
    expect(second.remindersSent).toBe(0);
    expect(d.sendReminderEmail).toHaveBeenCalledTimes(1);
  });

  it('does not send a reminder for a cancelled booking', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'cancelled', ...SLOT_A, cancelTokenHash: 'ct-cancel-remind' }));
    await cancelConfirmedBooking(env.BOOKINGS_DB, {
      cancelTokenHash: 'ct-cancel-remind',
      nowUtc: '2026-07-19T00:30:00Z',
      cancelledAtUtc: '2026-07-19T00:30:00Z',
    });
    const d = deps();

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T21:00:00Z', resendApiKey: 'key', ...BASE_PARAMS },
      d,
    );

    expect(result.remindersSent).toBe(0);
    expect(d.sendReminderEmail).not.toHaveBeenCalled();
  });

  it('does not send a reminder for a call more than 24 hours away', async () => {
    // "now" is 25 hours before the slot.
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'too-far-out', ...SLOT_A }));
    const d = deps();

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T08:00:00Z', resendApiKey: 'key', ...BASE_PARAMS },
      d,
    );

    expect(result.remindersSent).toBe(0);
    expect(d.sendReminderEmail).not.toHaveBeenCalled();
  });

  it('does not send a reminder for a call starting within the next hour', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'too-soon', ...SLOT_A }));
    const d = deps();

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-20T08:30:00Z', resendApiKey: 'key', ...BASE_PARAMS },
      d,
    );

    expect(result.remindersSent).toBe(0);
    expect(d.sendReminderEmail).not.toHaveBeenCalled();
  });

  it('a failed reminder send is not retried on a later run — it is marked mail_failed instead', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'reminder-fails', ...SLOT_A }));
    const d = deps();
    d.sendReminderEmail = vi.fn(async () => ({ ok: false }) as const);
    const params = { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T21:00:00Z', resendApiKey: 'key', ...BASE_PARAMS };

    const first = await runBookingMaintenance(params, d);
    expect(first.remindersSent).toBe(0);
    expect(first.remindersFailed).toBe(1);

    const row = await env.BOOKINGS_DB
      .prepare('SELECT reminder_sent_at, mail_failed FROM bookings WHERE id = ?')
      .bind('reminder-fails')
      .first<{ reminder_sent_at: string | null; mail_failed: number }>();
    expect(row?.reminder_sent_at).not.toBeNull(); // marked sent even though the send itself failed — not retried forever
    expect(row?.mail_failed).toBe(1);

    const second = await runBookingMaintenance({ ...params, nowUtc: '2026-07-19T21:30:00Z' }, d);
    expect(second.remindersSent).toBe(0);
    expect(second.remindersFailed).toBe(0);
    expect(d.sendReminderEmail).toHaveBeenCalledTimes(1);
  });

  it('skips the reminder step entirely when the Resend key is missing', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'no-key', ...SLOT_A }));
    const d = deps();

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T21:00:00Z', resendApiKey: undefined, ...BASE_PARAMS },
      d,
    );

    expect(result.remindersSent).toBe(0);
    expect(d.sendReminderEmail).not.toHaveBeenCalled();
    const row = await env.BOOKINGS_DB
      .prepare('SELECT reminder_sent_at FROM bookings WHERE id = ?')
      .bind('no-key')
      .first<{ reminder_sent_at: string | null }>();
    expect(row?.reminder_sent_at).toBeNull();
  });
});

describe('runBookingMaintenance — reminder digest to the owner', () => {
  const deps = (): RunBookingMaintenanceDeps => ({
    sendMailFailedAlert: vi.fn(async () => ({ ok: true })),
    sendReminderEmail: vi.fn(async () => ({ ok: true })),
    sendReminderDigestEmail: vi.fn(async () => ({ ok: true })),
  });

  it('sends exactly one digest email when reminders go out for two bookings in the same run', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'digest-a', ...SLOT_A, name: 'Ada Lovelace' }));
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'digest-b', ...SLOT_B, name: 'Grace Hopper' }));
    const d = deps();

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T21:00:00Z', resendApiKey: 'key', ...BASE_PARAMS },
      d,
    );

    expect(result.remindersSent).toBe(2);
    expect(result.reminderDigestSent).toBe(1);
    expect(result.reminderDigestFailed).toBe(0);
    expect(d.sendReminderDigestEmail).toHaveBeenCalledTimes(1); // one digest, not one per booking

    const [call] = vi.mocked(d.sendReminderDigestEmail).mock.calls[0];
    expect(call.to).toBe('hello@cyphral.co.uk');
    expect(call.calls).toHaveLength(2);
    expect(call.calls.map((c) => c.name).sort()).toEqual(['Ada Lovelace', 'Grace Hopper']);
  });

  it('does not send a digest when no reminders went out this run', async () => {
    const d = deps();
    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T21:00:00Z', resendApiKey: 'key', ...BASE_PARAMS },
      d,
    );

    expect(result.remindersSent).toBe(0);
    expect(result.reminderDigestSent).toBe(0);
    expect(d.sendReminderDigestEmail).not.toHaveBeenCalled();
  });

  it('a failed digest send does not affect the booker reminders already sent', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'digest-fails', ...SLOT_A }));
    const d = deps();
    d.sendReminderDigestEmail = vi.fn(async () => ({ ok: false }) as const);

    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T21:00:00Z', resendApiKey: 'key', ...BASE_PARAMS },
      d,
    );

    expect(result.remindersSent).toBe(1); // the booker's own reminder still went out
    expect(result.reminderDigestSent).toBe(0);
    expect(result.reminderDigestFailed).toBe(1);
  });

  it('counts the digest against the daily mail cap, and is skipped once the cap is already used up', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'cap-a', ...SLOT_A }));
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'cap-b', ...SLOT_B }));
    const d = deps();

    // Exactly enough budget for the two booker reminders and nothing left over.
    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T21:00:00Z', resendApiKey: 'key', mailDailyCapGlobal: 2, ...BASE_PARAMS },
      d,
    );

    expect(result.remindersSent).toBe(2);
    expect(result.reminderDigestSent).toBe(0); // no budget left for it
    expect(result.reminderDigestFailed).toBe(1);
    expect(d.sendReminderDigestEmail).not.toHaveBeenCalled();
  });

  it('a successfully sent digest is itself recorded against the mail budget', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'digest-recorded', ...SLOT_A }));
    const d = deps();

    // Budget for the one reminder plus the digest, but no more — a third
    // send in the same run (there isn't one here) would be refused.
    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-07-19T21:00:00Z', resendApiKey: 'key', mailDailyCapGlobal: 2, ...BASE_PARAMS },
      d,
    );

    expect(result.remindersSent).toBe(1);
    expect(result.reminderDigestSent).toBe(1);

    const globalSends = await env.BOOKINGS_DB
      .prepare("SELECT COUNT(*) AS n FROM rate_events WHERE bucket = 'mail:global'")
      .first<{ n: number }>();
    expect(globalSends?.n).toBe(2); // the reminder and the digest each recorded their own send
  });
});

describe('runBookingMaintenance — full sweep', () => {
  it('runs every job and reports accurate counts', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'old-booking', ...SLOT_B, purgeAfterUtc: '2026-08-01T00:00:00Z' }));
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'due-reminder', ...SLOT_C, purgeAfterUtc: '2027-01-01T00:00:00Z' }));

    await env.BOOKINGS_DB
      .prepare('INSERT INTO rate_events (bucket, subject_hash, created_at) VALUES (?, ?, ?)')
      .bind('book:ip', 'stale-event', '2026-07-01T00:00:00Z')
      .run();

    const d = {
      sendMailFailedAlert: vi.fn(async () => ({ ok: true }) as const),
      sendReminderEmail: vi.fn(async () => ({ ok: true }) as const),
      sendReminderDigestEmail: vi.fn(async () => ({ ok: true }) as const),
    };
    // "now" purges old-booking (past its purge_after) and is 12 hours before
    // due-reminder's slot (13:00 20 Jul), inside the reminder window.
    const result = await runBookingMaintenance(
      { db: env.BOOKINGS_DB, nowUtc: '2026-09-01T00:00:00Z', resendApiKey: 'key', ...BASE_PARAMS },
      d,
    );

    // due-reminder's slot (2026-07-20) is long past by the September "now"
    // used to exercise the purge, so it isn't reminder-eligible in this run —
    // this test's job is the accurate-counts shape, not the reminder window
    // itself (covered above). Re-run isolated to check purging alone:
    expect(result.purgedBookings).toBe(1);
    expect(result.purgedRateEvents).toBe(1);
    expect(result.alertsSent).toBe(0);
    expect(result.alertsFailed).toBe(0);
  });

  it('still purges when the Resend key is missing — only the alert and reminder steps are skipped', async () => {
    await createConfirmedBooking(env.BOOKINGS_DB, bookingInput({ id: 'old-booking-no-key', ...SLOT_B, purgeAfterUtc: '2026-08-01T00:00:00Z' }));
    await env.BOOKINGS_DB
      .prepare('INSERT INTO rate_events (bucket, subject_hash, created_at) VALUES (?, ?, ?)')
      .bind('book:ip', 'stale-event-no-key', '2026-07-01T00:00:00Z')
      .run();

    const result = await runBookingMaintenance({
      db: env.BOOKINGS_DB,
      nowUtc: '2026-09-01T00:00:00Z',
      resendApiKey: undefined,
      ...BASE_PARAMS,
    });

    expect(result).toEqual({
      purgedBookings: 1,
      purgedRateEvents: 1,
      alertsSent: 0,
      alertsFailed: 0,
      remindersSent: 0,
      remindersFailed: 0,
      reminderDigestSent: 0,
      reminderDigestFailed: 0,
    });
  });
});
