/**
 * D1 data layer for the booking system. Every query here uses bound
 * parameters — nothing is ever interpolated into SQL text (see
 * sql-safety.test.ts, which statically checks this file for violations).
 *
 * This module owns storage only. Business logic — recomputing availability,
 * deciding what counts as a rate-limit violation, orchestrating email sends —
 * belongs to the API route handlers (Phase 3), which call these primitives.
 */

export type BookingStatus = 'held' | 'confirmed' | 'cancelled' | 'expired';

// "('held','confirmed')" is written out literally everywhere below, rather
// than held in a constant and interpolated in — every .prepare() call in
// this file is a plain string with no `${...}` in it, by rule (see
// sql-safety.test.ts). All *data* still goes through bound parameters.

export interface CreateHoldInput {
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
  confirmTokenHash: string;
  holdExpiresAtUtc: string;
  createdAtUtc: string;
  purgeAfterUtc: string;
}

export type CreateHoldResult = { ok: true } | { ok: false; reason: 'slot_unavailable' };

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/**
 * Atomically creates a `held` booking, or fails with `slot_unavailable`.
 *
 * Runs as a two-statement `db.batch` (a single D1 transaction): first any
 * stale `held` rows past their `hold_expires_at` are flipped to `expired`
 * (freeing their slot and their place in the daily cap for the second
 * statement, which runs against the post-update state); then the INSERT's
 * own `SELECT ... WHERE` re-checks slot overlap (with the booking buffer),
 * the daily cap, and one-live-booking-per-email, all against the database as
 * it actually stands right now — not against whatever the caller last read.
 * `bookings_one_live_per_slot` is the final backstop against a genuine race
 * between two concurrent batches; its constraint violation is caught and
 * mapped to the same `slot_unavailable` result.
 */
export async function createHold(db: D1Database, input: CreateHoldInput): Promise<CreateHoldResult> {
  const expireStaleHolds = db
    .prepare(`UPDATE bookings SET status = 'expired' WHERE status = 'held' AND hold_expires_at < ?`)
    .bind(input.createdAtUtc);

  const insert = db
    .prepare(
      `INSERT INTO bookings (
         id, slot_start_utc, slot_end_utc, status, name, email, email_key, company,
         topic, note, visitor_tz, confirm_token_hash, hold_expires_at, created_at, purge_after
       )
       SELECT ?, ?, ?, 'held', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM bookings
         WHERE status IN ('held','confirmed')
           AND slot_start_utc < ?
           AND slot_end_utc > ?
       )
       AND (
         SELECT COUNT(*) FROM bookings
         WHERE status IN ('held','confirmed')
           AND slot_start_utc >= ?
           AND slot_start_utc < ?
       ) < ?
       AND NOT EXISTS (
         SELECT 1 FROM bookings WHERE status IN ('held','confirmed') AND email_key = ?
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
      input.confirmTokenHash,
      input.holdExpiresAtUtc,
      input.createdAtUtc,
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
    const [, insertResult] = await db.batch([expireStaleHolds, insert]);
    return (insertResult.meta.changes ?? 0) > 0 ? { ok: true } : { ok: false, reason: 'slot_unavailable' };
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

/** Reads a `held` booking by its confirm-token hash. Does not check expiry — see confirmHeldBooking. */
export async function findHeldBookingByConfirmTokenHash(
  db: D1Database,
  confirmTokenHash: string,
): Promise<BookingDetails | null> {
  const row = await db
    .prepare(
      `SELECT id, slot_start_utc, slot_end_utc, name, email, email_key, company, topic, note, visitor_tz
       FROM bookings WHERE status = 'held' AND confirm_token_hash = ?`,
    )
    .bind(confirmTokenHash)
    .first<BookingDetailsRow>();
  return row ? rowToBookingDetails(row) : null;
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

/** Marks a specific held booking expired (used when a re-checked availability no longer allows it). Idempotent. */
export async function expireHeldBooking(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE bookings SET status = 'expired' WHERE id = ? AND status = 'held'`).bind(id).run();
}

export type ConfirmResult = { ok: true } | { ok: false; reason: 'link_expired' };

/**
 * Atomically confirms a held, non-expired booking by its confirm-token hash,
 * clearing the (now single-use) confirm token and issuing a cancel token.
 * Zero rows changed — wrong/reused token, or hold_expires_at has passed —
 * is reported the same way, covering double-clicks and expiry races alike.
 */
export async function confirmHeldBooking(
  db: D1Database,
  params: { confirmTokenHash: string; nowUtc: string; cancelTokenHash: string; confirmedAtUtc: string },
): Promise<ConfirmResult> {
  const result = await db
    .prepare(
      `UPDATE bookings
       SET status = 'confirmed', confirmed_at = ?, confirm_token_hash = NULL, cancel_token_hash = ?
       WHERE status = 'held' AND confirm_token_hash = ? AND hold_expires_at >= ?`,
    )
    .bind(params.confirmedAtUtc, params.cancelTokenHash, params.confirmTokenHash, params.nowUtc)
    .run();

  return (result.meta.changes ?? 0) > 0 ? { ok: true } : { ok: false, reason: 'link_expired' };
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

/** Marks a booking's post-confirmation email as failed, for the cron job to alert on. Does not roll back the booking. */
export async function markMailFailed(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE bookings SET mail_failed = 1 WHERE id = ?`).bind(id).run();
}

export interface LiveBookingInterval {
  startUtc: string;
  endUtc: string;
}

/** Every currently held or confirmed booking, for feeding into computeAvailableSlots. */
export async function listLiveBookingIntervals(db: D1Database): Promise<LiveBookingInterval[]> {
  const { results } = await db
    .prepare(`SELECT slot_start_utc, slot_end_utc FROM bookings WHERE status IN ('held','confirmed')`)
    .all<{ slot_start_utc: string; slot_end_utc: string }>();
  return results.map((r) => ({ startUtc: r.slot_start_utc, endUtc: r.slot_end_utc }));
}

/** Number of currently active (non-expired) holds, for the global-active-holds rate limit. */
export async function countActiveHolds(db: D1Database, nowUtc: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE status = 'held' AND hold_expires_at >= ?`)
    .bind(nowUtc)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
