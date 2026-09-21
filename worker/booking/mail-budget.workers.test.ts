import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { isWithinMailBudget, recordMailSent } from './mail';

beforeEach(async () => {
  await env.BOOKINGS_DB.prepare('DELETE FROM rate_events').run();
});

describe('isWithinMailBudget / recordMailSent', () => {
  it('is within budget with no prior sends', async () => {
    const within = await isWithinMailBudget({
      db: env.BOOKINGS_DB,
      recipientSubjectHash: 'recipient-1',
      nowUtc: '2026-07-19T12:00:00Z',
      dailyCapGlobal: 40,
    });
    expect(within).toBe(true);
  });

  it('the global cap is a UTC-calendar-day boundary, not a rolling 24h window', async () => {
    // One send late on the 18th...
    await recordMailSent(env.BOOKINGS_DB, 'r', '2026-07-18T23:50:00Z');
    // ...checked 20 minutes later, on the 19th: a rolling 24h window would
    // still count it; the UTC-day window must not.
    const within = await isWithinMailBudget({
      db: env.BOOKINGS_DB,
      recipientSubjectHash: 'other-recipient',
      nowUtc: '2026-07-19T00:10:00Z',
      dailyCapGlobal: 1,
    });
    expect(within).toBe(true);
  });

  it('the global cap blocks once reached within the same UTC day, regardless of recipient', async () => {
    await recordMailSent(env.BOOKINGS_DB, 'recipient-a', '2026-07-19T01:00:00Z');
    const within = await isWithinMailBudget({
      db: env.BOOKINGS_DB,
      recipientSubjectHash: 'recipient-b', // a different recipient
      nowUtc: '2026-07-19T02:00:00Z',
      dailyCapGlobal: 1,
    });
    expect(within).toBe(false);
  });

  it('a per-recipient cap blocks that recipient even when the global budget has room', async () => {
    const recipient = 'busy-recipient';
    for (let i = 0; i < 4; i++) {
      await recordMailSent(env.BOOKINGS_DB, recipient, '2026-07-19T01:00:00Z');
    }
    const within = await isWithinMailBudget({
      db: env.BOOKINGS_DB,
      recipientSubjectHash: recipient,
      nowUtc: '2026-07-19T01:30:00Z',
      dailyCapGlobal: 40,
    });
    expect(within).toBe(false);
  });

  it('a per-recipient cap does not affect a different recipient', async () => {
    const busy = 'busy-recipient-2';
    for (let i = 0; i < 4; i++) {
      await recordMailSent(env.BOOKINGS_DB, busy, '2026-07-19T01:00:00Z');
    }
    const within = await isWithinMailBudget({
      db: env.BOOKINGS_DB,
      recipientSubjectHash: 'quiet-recipient',
      nowUtc: '2026-07-19T01:30:00Z',
      dailyCapGlobal: 40,
    });
    expect(within).toBe(true);
  });
});
