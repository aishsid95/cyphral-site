/**
 * D1 data layer for the booking system. Every query here uses bound
 * parameters — nothing is ever interpolated into SQL text (see
 * sql-safety.test.ts, which statically checks this file for violations).
 *
 * This module owns storage only. Business logic — recomputing availability,
 * deciding what counts as a rate-limit violation, orchestrating email sends —
 * belongs to the API route handlers, which call these primitives.
 *
 * A booking is created directly as `confirmed` — there is no intermediate
 * `held`/unverified state (removed along with the email-verification step;
 * see worker/booking/booking-handler.ts). The `bookings.status` CHECK
 * constraint still technically permits the legacy 'held'/'expired' values —
 * left in place deliberately rather than migrated away, since no code here
 * ever writes them again and a constraint/index migration would add real
 * risk for zero behavioural benefit — but nothing in this file reads or
 * writes them either.
 */

export type BookingStatus = 'held' | 'confirmed' | 'cancelled' | 'expired';

export interface CreateBookingInput {
  id: string;
  slotStartUtc: string; // ISO, e.g. "2026-07-20T09:00:00Z"
  slotEndUtc: string; // ISO
  /** slotStart - bookingBufferMinutes, for the overlap-with-live-bookings check. */
  bufferedRangeStartUtc: string;
  /** slotEnd + bookingBufferMinutes, for the overlap-with-live-bookings check. */
  bufferedRangeEndUtc: string;
  /** Start of the slot's Europe/London calendar day, as a UTC instant. */
  londonDayStartUtc: string;
  /** Start of the NEXT Europe/London calendar day (exclusive upper bound), as a UTC instant. */
  londonDayEndUtc: string;
  maxCallsPerDay: number;
  name: string;
  email: string;
  emailKey: string;
  company: string | null;
  topic: string;
  note: string | null;
  visitorTz: string;
  cancelTokenHash: string;
  createdAtUtc: string;
  confirmedAtUtc: string;
  purgeAfterUtc: string;
}

export type CreateBookingResult = { ok: true } | { ok: false; reason: 'slot_unavailable' };

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/**
 * Atomically creates a `confirmed` booking, or fails with `slot_unavailable`.
 * A single INSERT ... SELECT ... WHERE: the SELECT re-checks slot overlap
 * (with the booking buffer), the daily cap, and one-live-booking-per-email,
 * all against the database as it actually stands right now — not against
 * whatever the caller last read. `bookings_one_live_per_slot` is the final
 * backstop against a genuine race between two concurrent inserts; its
 * constraint violation is caught and mapped to the same `slot_unavailable`
 * result.
 */
export async function createConfirmedBooking(db: D1Database, input: CreateBookingInput): Promise<CreateBookingResult> {
  const insert = db
    .prepare(
      `INSERT INTO bookings (
         id, slot_start_utc, slot_end_utc, status, name, email, email_key, company,
         topic, note, visitor_tz, cancel_token_hash, created_at, confirmed_at, purge_after
       )
       SELECT ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM bookings
         WHERE status = 'confirmed'
           AND slot_start_utc < ?
           AND slot_end_utc > ?
       )
       AND (
         SELECT COUNT(*) FROM bookings
         WHERE status = 'confirmed'
           AND slot_start_utc >= ?
           AND slot_start_utc < ?
       ) < ?
       AND NOT EXISTS (
         SELECT 1 FROM bookings WHERE status = 'confirmed' AND email_key = ?
       )`,
    )
    .bind(
      input.id,
      input.slotStartUtc,
      input.slotEndUtc,
      input.name,
      input.email,
      input.emailKey,
      input.company,
      input.topic,
      input.note,
      input.visitorTz,
      input.cancelTokenHash,
      input.createdAtUtc,
      input.confirmedAtUtc,
      input.purgeAfterUtc,
      // overlap check: existing.start < bufferedEnd AND existing.end > bufferedStart
      input.bufferedRangeEndUtc,
      input.bufferedRangeStartUtc,
      // daily cap check
      input.londonDayStartUtc,
      input.londonDayEndUtc,
      input.maxCallsPerDay,
      // duplicate-email check
      input.emailKey,
    );

  try {
    const result = await insert.run();
    return (result.meta.changes ?? 0) > 0 ? { ok: true } : { ok: false, reason: 'slot_unavailable' };
  } catch (err) {
    if (isUniqueConstraintError(err)) return { ok: false, reason: 'slot_unavailable' };
    throw err;
  }
}

export interface BookingDetails {
  id: string;
  slotStartUtc: string;
  slotEndUtc: string;
  name: string;
  email: string;
  emailKey: string;
  company: string | null;
  topic: string;
  note: string | null;
  visitorTz: string;
}

interface BookingDetailsRow {
  id: string;
  slot_start_utc: string;
  slot_end_utc: string;
  name: string;
  email: string;
  email_key: string;
  company: string | null;
  topic: string;
  note: string | null;
  visitor_tz: string;
}

function rowToBookingDetails(row: BookingDetailsRow): BookingDetails {
  return {
    id: row.id,
    slotStartUtc: row.slot_start_utc,
    slotEndUtc: row.slot_end_utc,
    name: row.name,
    email: row.email,
    emailKey: row.email_key,
    company: row.company,
    topic: row.topic,
    note: row.note,
    visitorTz: row.visitor_tz,
  };
}

/** Reads a `confirmed` booking by its cancel-token hash. Does not check the slot's start time — see cancelConfirmedBooking. */
export async function findConfirmedBookingByCancelTokenHash(
  db: D1Database,
  cancelTokenHash: string,
): Promise<BookingDetails | null> {
  const row = await db
    .prepare(
      `SELECT id, slot_start_utc, slot_end_utc, name, email, email_key, company, topic, note, visitor_tz
       FROM bookings WHERE status = 'confirmed' AND cancel_token_hash = ?`,
    )
    .bind(cancelTokenHash)
    .first<BookingDetailsRow>();
  return row ? rowToBookingDetails(row) : null;
}

export type CancelResult = { ok: true } | { ok: false; reason: 'link_expired' };

/**
 * Atomically cancels a confirmed booking by its cancel-token hash, but only
 * if the slot has not already started. Clears the (now single-use) cancel
 * token. Zero rows changed maps to the same `link_expired` result whether
 * the token was wrong, already used, or the slot already started.
 */
export async function cancelConfirmedBooking(
  db: D1Database,
  params: { cancelTokenHash: string; nowUtc: string; cancelledAtUtc: string },
): Promise<CancelResult> {
  const result = await db
    .prepare(
      `UPDATE bookings
       SET status = 'cancelled', cancelled_at = ?, cancel_token_hash = NULL
       WHERE status = 'confirmed' AND cancel_token_hash = ? AND slot_start_utc > ?`,
    )
    .bind(params.cancelledAtUtc, params.cancelTokenHash, params.nowUtc)
    .run();

  return (result.meta.changes ?? 0) > 0 ? { ok: true } : { ok: false, reason: 'link_expired' };
}

/** Marks a booking's post-confirmation (or reminder) email as failed, for the cron job to alert on. Does not roll back the booking. */
export async function markMailFailed(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE bookings SET mail_failed = 1 WHERE id = ?`).bind(id).run();
}

export interface LiveBookingInterval {
  startUtc: string;
  endUtc: string;
}

/** Every currently confirmed booking, for feeding into computeAvailableSlots. */
export async function listLiveBookingIntervals(db: D1Database): Promise<LiveBookingInterval[]> {
  const { results } = await db
    .prepare(`SELECT slot_start_utc, slot_end_utc FROM bookings WHERE status = 'confirmed'`)
    .all<{ slot_start_utc: string; slot_end_utc: string }>();
  return results.map((r) => ({ startUtc: r.slot_start_utc, endUtc: r.slot_end_utc }));
}

export interface ReminderCandidate {
  id: string;
  name: string;
  email: string;
  company: string | null;
  topic: string;
  slotStartUtc: string;
  visitorTz: string;
}

/**
 * Confirmed bookings that need their day-before reminder: not yet reminded,
 * starting more than 1 hour and at most 24 hours from now. The 1-hour floor
 * matches the spec's "starts more than 1 hour from now" — it exists so the
 * reminder is never the very last thing sent before a call that's about to
 * start, e.g. right after a 30-minute cron tick. Carries company/topic too,
 * not just what the booker's own reminder needs — the owner digest sent
 * alongside the reminders (see cron.ts) wants the full picture.
 */
export async function listBookingsNeedingReminder(db: D1Database, nowUtc: string): Promise<ReminderCandidate[]> {
  const earliestUtc = new Date(Date.parse(nowUtc) + 60 * 60 * 1000).toISOString();
  const latestUtc = new Date(Date.parse(nowUtc) + 24 * 60 * 60 * 1000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT id, name, email, company, topic, slot_start_utc, visitor_tz FROM bookings
       WHERE status = 'confirmed' AND reminder_sent_at IS NULL
         AND slot_start_utc > ? AND slot_start_utc <= ?`,
    )
    .bind(earliestUtc, latestUtc)
    .all<{ id: string; name: string; email: string; company: string | null; topic: string; slot_start_utc: string; visitor_tz: string }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    company: r.company,
    topic: r.topic,
    slotStartUtc: r.slot_start_utc,
    visitorTz: r.visitor_tz,
  }));
}

export type MarkReminderSentResult = { ok: true } | { ok: false };

/**
 * Atomically marks a booking's reminder sent, rotating its cancel token to a
 * fresh one at the same time — the reminder's own cancel link needs a raw
 * token to show, and only a hash of the original is ever stored, so a new
 * one is minted here rather than adding a second token column. The WHERE
 * clause (status = 'confirmed' AND reminder_sent_at IS NULL) is what makes
 * this safe to call from two overlapping cron runs: only the first ever
 * changes a row, so only the first ever sends an email.
 */
export async function markReminderSent(
  db: D1Database,
  params: { id: string; cancelTokenHash: string; sentAtUtc: string },
): Promise<MarkReminderSentResult> {
  const result = await db
    .prepare(
      `UPDATE bookings SET reminder_sent_at = ?, cancel_token_hash = ?
       WHERE id = ? AND status = 'confirmed' AND reminder_sent_at IS NULL`,
    )
    .bind(params.sentAtUtc, params.cancelTokenHash, params.id)
    .run();
  return (result.meta.changes ?? 0) > 0 ? { ok: true } : { ok: false };
}

// ---------------------------------------------------------------------------
// Rate limiting (rate_events)
// ---------------------------------------------------------------------------

export async function recordRateEvent(
  db: D1Database,
  params: { bucket: string; subjectHash: string; nowUtc: string },
): Promise<void> {
  await db
    .prepare(`INSERT INTO rate_events (bucket, subject_hash, created_at) VALUES (?, ?, ?)`)
    .bind(params.bucket, params.subjectHash, params.nowUtc)
    .run();
}

/** Count of events for `bucket`/`subjectHash` at or after `sinceUtc`. */
export async function countRateEvents(
  db: D1Database,
  params: { bucket: string; subjectHash: string; sinceUtc: string },
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND subject_hash = ? AND created_at >= ?`,
    )
    .bind(params.bucket, params.subjectHash, params.sinceUtc)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
