import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { isRateLimited, RATE_LIMITS, recordRateLimitEvent } from './rate-limit';

beforeEach(async () => {
  await env.BOOKINGS_DB.prepare('DELETE FROM rate_events').run();
});

describe('isRateLimited / recordRateLimitEvent', () => {
  it('is not limited with no prior events', async () => {
    const limited = await isRateLimited(env.BOOKINGS_DB, 'subject-1', '2026-07-19T00:00:00Z', [RATE_LIMITS.holdPerIpHour]);
    expect(limited).toBe(false);
  });

  it('becomes limited once the count reaches the limit within the window', async () => {
    const subject = 'subject-2';
    for (let i = 0; i < RATE_LIMITS.holdPerIpHour.limit; i++) {
      await recordRateLimitEvent(env.BOOKINGS_DB, RATE_LIMITS.holdPerIpHour.bucket, subject, '2026-07-19T00:00:00Z');
    }
    const limited = await isRateLimited(env.BOOKINGS_DB, subject, '2026-07-19T00:30:00Z', [RATE_LIMITS.holdPerIpHour]);
    expect(limited).toBe(true);
  });

  it('checking multiple windows fails if any single window is over its limit', async () => {
    const subject = 'subject-3';
    // Exceed the hourly limit only; daily has a higher cap and isn't reached.
    for (let i = 0; i < RATE_LIMITS.holdPerIpHour.limit; i++) {
      await recordRateLimitEvent(env.BOOKINGS_DB, RATE_LIMITS.holdPerIpHour.bucket, subject, '2026-07-19T00:00:00Z');
    }
    const limited = await isRateLimited(env.BOOKINGS_DB, subject, '2026-07-19T00:10:00Z', [
      RATE_LIMITS.holdPerIpHour,
      RATE_LIMITS.holdPerIpDay,
    ]);
    expect(limited).toBe(true);
  });

  it('events outside the window do not count', async () => {
    const subject = 'subject-4';
    await recordRateLimitEvent(env.BOOKINGS_DB, RATE_LIMITS.holdPerIpHour.bucket, subject, '2026-07-19T00:00:00Z');
    const limited = await isRateLimited(env.BOOKINGS_DB, subject, '2026-07-19T02:00:00Z', [RATE_LIMITS.holdPerIpHour]);
    expect(limited).toBe(false); // two hours later, outside the 1-hour window
  });

  it('different subjects are isolated from each other', async () => {
    for (let i = 0; i < RATE_LIMITS.holdPerIpHour.limit; i++) {
      await recordRateLimitEvent(env.BOOKINGS_DB, RATE_LIMITS.holdPerIpHour.bucket, 'busy-subject', '2026-07-19T00:00:00Z');
    }
    const limited = await isRateLimited(env.BOOKINGS_DB, 'quiet-subject', '2026-07-19T00:10:00Z', [RATE_LIMITS.holdPerIpHour]);
    expect(limited).toBe(false);
  });

  it('different buckets for the same subject are isolated from each other', async () => {
    for (let i = 0; i < RATE_LIMITS.holdPerIpHour.limit; i++) {
      await recordRateLimitEvent(env.BOOKINGS_DB, RATE_LIMITS.holdPerIpHour.bucket, 'shared-subject', '2026-07-19T00:00:00Z');
    }
    const limited = await isRateLimited(env.BOOKINGS_DB, 'shared-subject', '2026-07-19T00:10:00Z', [RATE_LIMITS.holdPerEmailDay]);
    expect(limited).toBe(false);
  });
});
