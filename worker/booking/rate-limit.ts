/**
 * Named rate limits on top of db.ts's rate_events table. These are soft
 * limits (check-then-record, not atomic) — acceptable here because the
 * consequence of losing a race is one extra request slipping through, not
 * a double-booking. The hard, must-never-race guarantees (slot overlap,
 * daily cap, one-booking-per-email) live in db.ts's atomic createHold batch.
 */
import { countRateEvents, recordRateEvent } from './db';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const RATE_LIMITS = {
  slotsPerIp: { bucket: 'slots:ip', windowMs: 10 * 60 * 1000, limit: 60 },
  bookPerIpHour: { bucket: 'book:ip', windowMs: HOUR_MS, limit: 3 },
  bookPerIpDay: { bucket: 'book:ip', windowMs: DAY_MS, limit: 10 },
  bookPerEmailDay: { bucket: 'book:email', windowMs: DAY_MS, limit: 3 },
  mailPerRecipientHour: { bucket: 'mail:recipient', windowMs: HOUR_MS, limit: 2 },
  mailPerRecipientDay: { bucket: 'mail:recipient', windowMs: DAY_MS, limit: 4 },
} as const;

interface WindowCheck {
  bucket: string;
  windowMs: number;
  limit: number;
}

async function isOverLimit(db: D1Database, subjectHash: string, nowUtc: string, window: WindowCheck): Promise<boolean> {
  const sinceUtc = new Date(Date.parse(nowUtc) - window.windowMs).toISOString();
  const count = await countRateEvents(db, { bucket: window.bucket, subjectHash, sinceUtc });
  return count >= window.limit;
}

/** True if any of the given windows is already at or over its limit. Does not record anything. */
export async function isRateLimited(
  db: D1Database,
  subjectHash: string,
  nowUtc: string,
  windows: WindowCheck[],
): Promise<boolean> {
  for (const window of windows) {
    if (await isOverLimit(db, subjectHash, nowUtc, window)) return true;
  }
  return false;
}

/** Records one event in `bucket` for `subjectHash`. Call only after confirming the request is allowed. */
export async function recordRateLimitEvent(
  db: D1Database,
  bucket: string,
  subjectHash: string,
  nowUtc: string,
): Promise<void> {
  await recordRateEvent(db, { bucket, subjectHash, nowUtc });
}
