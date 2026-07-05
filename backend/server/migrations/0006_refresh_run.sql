-- Per-refresh operational stats (the health footer's data): one row per
-- refresh run, newest-first by started_at. The writer prunes rows older than
-- its retention window on every insert, so the table stays a few thousand
-- rows at most (one cron every 3 minutes).
CREATE TABLE refresh_run (
  started_at    INTEGER PRIMARY KEY,
  duration_ms   INTEGER NOT NULL,
  koios_calls   INTEGER NOT NULL,
  ok            INTEGER NOT NULL,
  -- Failure message when ok = 0 (truncated by the writer), else NULL.
  error         TEXT,
  incomplete    INTEGER NOT NULL,
  surveys       INTEGER NOT NULL,
  responses     INTEGER NOT NULL,
  payload_bytes INTEGER NOT NULL
);
