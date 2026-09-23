/**
 * The 30-minute maintenance sweep (wired in src/worker.ts's `scheduled()`
 * handler). Independent jobs, each tolerant of the others failing: a purge
 * step is a single blanket SQL statement (naturally idempotent — running it
 * again with a later `nowUtc` just matches fewer or no rows), and the two
 * per-row loops (mail-failed alerts, day-before reminders) must not let one
 * bad row abort the rest of the sweep, or each other.
 */
import { generateToken, hashToken, hmacHex } from './crypto';
import { listBookingsNeedingReminder, markMailFailed, markReminderSent, type ReminderCandidate } from './db';
import { isWithinMailBudget, recordMailSent, sendMailFailedAlert, sendReminderEmail } from './mail';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAIL_DAILY_CAP_DEFAULT = 40;

export interface RunBookingMaintenanceDeps {
  sendMailFailedAlert: typeof sendMailFailedAlert;
  sendReminderEmail: typeof sendReminderEmail;
}

export const defaultCronDeps: RunBookingMaintenanceDeps = { sendMailFailedAlert, sendReminderEmail };

export interface RunBookingMaintenanceParams {
  db: D1Database;
  nowUtc: string;
  /** Undefined when the BOOKING_RESEND_API_KEY secret isn't set — the sweep still runs, only the alert and reminder steps are skipped. */
  resendApiKey: string | undefined;
  ownerEmail: string;
  rateHmacSecret: string;
  mailDailyCapGlobal?: number;
}

export interface CronRunResult {
  purgedBookings: number;
  purgedRateEvents: number;
  alertsSent: number;
  alertsFailed: number;
  remindersSent: number;
  remindersFailed: number;
}

/** Deletes bookings past their purge_after date. Returns the number of rows deleted. */
export async function purgeExpiredBookings(db: D1Database, nowUtc: string): Promise<number> {
  const result = await db.prepare(`DELETE FROM bookings WHERE purge_after < ?`).bind(nowUtc).run();
  return result.meta.changes ?? 0;
}

/** Deletes rate_events older than 7 days. Returns the number of rows deleted. */
export async function purgeOldRateEvents(db: D1Database, nowUtc: string): Promise<number> {
  const cutoff = new Date(Date.parse(nowUtc) - SEVEN_DAYS_MS).toISOString();
  const result = await db.prepare(`DELETE FROM rate_events WHERE created_at < ?`).bind(cutoff).run();
  return result.meta.changes ?? 0;
}

interface MailFailedRow {
  id: string;
  slot_start_utc: string;
}

/**
 * Alerts Aisha once per booking with mail_failed=1 and mail_alert_sent=0.
 * A failure sending or updating one row is caught and counted, never
 * thrown — one bad row must not stop the rest of the sweep. If the Resend
 * key isn't configured, skips straight to returning zero counts — no D1
 * read, no doomed network call.
 */
async function alertOnFailedMail(
  db: D1Database,
  resendApiKey: string | undefined,
  ownerEmail: string,
  deps: RunBookingMaintenanceDeps,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  if (!resendApiKey) {
    return { sent, failed };
  }

  let rows: MailFailedRow[] = [];
  try {
    const result = await db
      .prepare(`SELECT id, slot_start_utc FROM bookings WHERE mail_failed = 1 AND mail_alert_sent = 0`)
      .all<MailFailedRow>();
    rows = result.results;
  } catch {
    return { sent, failed };
  }

  for (const row of rows) {
    try {
      const result = await deps.sendMailFailedAlert({
        apiKey: resendApiKey,
        to: ownerEmail,
        bookingId: row.id,
        slotStartIso: row.slot_start_utc,
        idempotencyKey: `${row.id}:mail-failed-alert`,
      });
      if (result.ok) {
        await db.prepare(`UPDATE bookings SET mail_alert_sent = 1 WHERE id = ?`).bind(row.id).run();
        sent += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return { sent, failed };
}

/**
 * Sends the day-before reminder to every confirmed booking that's due one:
 * see db.ts's listBookingsNeedingReminder for the exact window. Each row is
 * gated behind the same mail budget the initial confirmation uses, and
 * `markReminderSent`'s own WHERE clause is the sole idempotency guard — it
 * only succeeds for the first of any two overlapping cron runs racing on the
 * same row, so only that first run ever sends the email. A row whose budget
 * check fails is left untouched (not marked sent), so it's retried on a
 * later run once the budget has room again; a row whose send itself fails
 * (already marked sent by then) is not retried — it's flagged mail_failed
 * instead, for alertOnFailedMail to pick up. If the Resend key isn't
 * configured, skips straight to returning zero counts.
 */
async function sendReminders(
  db: D1Database,
  nowUtc: string,
  resendApiKey: string | undefined,
  rateHmacSecret: string,
  mailDailyCapGlobal: number | undefined,
  deps: RunBookingMaintenanceDeps,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  if (!resendApiKey) {
    return { sent, failed };
  }

  let candidates: ReminderCandidate[] = [];
  try {
    candidates = await listBookingsNeedingReminder(db, nowUtc);
  } catch {
    return { sent, failed };
  }

  const dailyCapGlobal = mailDailyCapGlobal ?? MAIL_DAILY_CAP_DEFAULT;

  for (const booking of candidates) {
    try {
      const recipientHash = await hmacHex(rateHmacSecret, booking.email);
      const withinBudget = await isWithinMailBudget({ db, recipientSubjectHash: recipientHash, nowUtc, dailyCapGlobal });
      if (!withinBudget) continue; // left un-marked, so a later run (once budget frees up) retries it

      const cancelToken = generateToken();
      const cancelTokenHash = await hashToken(cancelToken);
      const marked = await markReminderSent(db, { id: booking.id, cancelTokenHash, sentAtUtc: nowUtc });
      if (!marked.ok) continue; // already sent by another run — not a failure, just nothing to do

      const result = await deps.sendReminderEmail({
        apiKey: resendApiKey,
        to: booking.email,
        name: booking.name,
        slotStartIso: booking.slotStartUtc,
        visitorTz: booking.visitorTz,
        cancelToken,
        idempotencyKey: `${booking.id}:reminder`,
      });

      if (result.ok) {
        await recordMailSent(db, recipientHash, nowUtc);
        sent += 1;
      } else {
        await markMailFailed(db, booking.id);
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return { sent, failed };
}

export async function runBookingMaintenance(
  params: RunBookingMaintenanceParams,
  deps: RunBookingMaintenanceDeps = defaultCronDeps,
): Promise<CronRunResult> {
  const purgedBookings = await purgeExpiredBookings(params.db, params.nowUtc);
  const purgedRateEvents = await purgeOldRateEvents(params.db, params.nowUtc);
  const { sent: alertsSent, failed: alertsFailed } = await alertOnFailedMail(
    params.db,
    params.resendApiKey,
    params.ownerEmail,
    deps,
  );
  const { sent: remindersSent, failed: remindersFailed } = await sendReminders(
    params.db,
    params.nowUtc,
    params.resendApiKey,
    params.rateHmacSecret,
    params.mailDailyCapGlobal,
    deps,
  );

  return { purgedBookings, purgedRateEvents, alertsSent, alertsFailed, remindersSent, remindersFailed };
}
