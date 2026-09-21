-- Tracks whether the cron job has already alerted Aisha about a given
-- mail_failed=1 booking, so the 30-minute sweep alerts once per booking
-- rather than repeating forever until someone clears the flag manually.
ALTER TABLE bookings ADD COLUMN mail_alert_sent INTEGER NOT NULL DEFAULT 0;
