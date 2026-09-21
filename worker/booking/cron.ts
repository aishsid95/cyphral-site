/**
 * The 30-minute maintenance sweep (Phase 5's cron trigger, wired in
 * src/worker.ts's `scheduled()` handler). Three independent jobs, each
 * a single blanket SQL statement (so each is naturally idempotent — running
 * it again with a later `nowUtc` just matches fewer or no rows) plus a
 * per-row alert loop that must not let one bad row abort the others.
 */
import { sendMailFailedAlert } from './mail';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface RunBookingMaintenanceDeps {
  sendMailFailedAlert: typeof sendMailFailedAlert;
}

export const defaultCronDeps: RunBookingMaintenanceDeps = { sendMailFailedAlert };

export interface RunBookingMaintenanceParams {
  db: D1Database;
  nowUtc: string;
  resendApiKey: string;
  ownerEmail: string;
}

export interface CronRunResult {
  expiredHolds: number;
  purgedBookings: number;
  purgedRateEvents: number;
  alertsSent: number;
  alertsFailed: number;
}

/** Expires held bookings whose hold_expires_at has passed. Returns the number of rows changed. */
export async function expireStaleHolds(db: D1Database, nowUtc: string): Promise<number> {
  const result = await db
    .prepare(`UPDATE bookings SET status = 'expired' WHERE status = 'held' AND hold_expires_at < ?`)
    .bind(nowUtc)
    .run();
  return result.meta.changes ?? 0;
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
 * thrown — one bad row must not stop the rest of the sweep.
 */
async function alertOnFailedMail(
  db: D1Database,
  resendApiKey: string,
  ownerEmail: string,
  deps: RunBookingMaintenanceDeps,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

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

export async function runBookingMaintenance(
  params: RunBookingMaintenanceParams,
  deps: RunBookingMaintenanceDeps = defaultCronDeps,
): Promise<CronRunResult> {
  const expiredHolds = await expireStaleHolds(params.db, params.nowUtc);
  const purgedBookings = await purgeExpiredBookings(params.db, params.nowUtc);
  const purgedRateEvents = await purgeOldRateEvents(params.db, params.nowUtc);
  const { sent: alertsSent, failed: alertsFailed } = await alertOnFailedMail(
    params.db,
    params.resendApiKey,
    params.ownerEmail,
    deps,
  );

  return { expiredHolds, purgedBookings, purgedRateEvents, alertsSent, alertsFailed };
}
