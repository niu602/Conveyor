-- Conveyor Courier's desk, on Cloudflare D1.
--
-- The idempotency key is unique: a dispatch replayed with the same key finds the first
-- job instead of making a second one. request_digest holds what that transaction was —
-- quote, order reference, parcel and amount — so the same key sent with a different
-- amount is refused rather than silently answered with the first job. Visitor details
-- live here because the courier needs them to deliver; they never appear in a bridge
-- call, a receipt or a public file.

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  drop_zone TEXT NOT NULL,
  parcel_size TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  eta_minutes INTEGER NOT NULL,
  basis TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL DEFAULT '',
  pizza_order_ref TEXT NOT NULL DEFAULT '',
  item_summary TEXT NOT NULL DEFAULT '',
  drop_zone TEXT NOT NULL,
  parcel_size TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  fee_cents INTEGER NOT NULL,
  eta_minutes INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id, id);
