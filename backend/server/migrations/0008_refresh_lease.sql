-- Single-writer guard for the refresh (see src/refresh.ts).
--
-- Neither runtime serializes its own scheduler: Cloudflare may start a cron
-- while the previous one is still running (a separate isolate), and the Node
-- loop's setInterval fires on schedule whether or not the previous refresh has
-- settled. One row, held for a bounded TTL so that a run killed mid-flight —
-- which never gets to release it — cannot block refreshes forever.
CREATE TABLE refresh_lease (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  -- Opaque token identifying the run that holds the lease.
  holder     TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);
