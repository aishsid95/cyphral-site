-- Tracks whether the 30-minute cron has already sent the day-before reminder
-- for a confirmed booking, so it can only ever go out once.
ALTER TABLE bookings ADD COLUMN reminder_sent_at TEXT;
