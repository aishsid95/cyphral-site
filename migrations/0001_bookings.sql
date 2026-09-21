CREATE TABLE bookings (
  id TEXT PRIMARY KEY,                       -- crypto.randomUUID()
  slot_start_utc TEXT NOT NULL,
  slot_end_utc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held','confirmed','cancelled','expired')),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_key TEXT NOT NULL,                   -- fully lowercased, for limits and duplicate checks
  company TEXT,
  topic TEXT NOT NULL,
  note TEXT,
  visitor_tz TEXT NOT NULL,
  confirm_token_hash TEXT,
  cancel_token_hash TEXT,
  hold_expires_at TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  cancelled_at TEXT,
  mail_failed INTEGER NOT NULL DEFAULT 0,
  purge_after TEXT NOT NULL
);
CREATE UNIQUE INDEX bookings_one_live_per_slot
  ON bookings(slot_start_utc) WHERE status IN ('held','confirmed');
CREATE UNIQUE INDEX bookings_confirm_token ON bookings(confirm_token_hash) WHERE confirm_token_hash IS NOT NULL;
CREATE UNIQUE INDEX bookings_cancel_token ON bookings(cancel_token_hash) WHERE cancel_token_hash IS NOT NULL;
CREATE INDEX bookings_email_status ON bookings(email_key, status);

CREATE TABLE rate_events (
  bucket TEXT NOT NULL,        -- e.g. 'hold:ip', 'hold:email', 'mail:recipient', 'mail:global', 'slots:ip'
  subject_hash TEXT NOT NULL,  -- HMAC-SHA256(secret, value), never the raw IP or email
  created_at TEXT NOT NULL
);
CREATE INDEX rate_events_lookup ON rate_events(bucket, subject_hash, created_at);
