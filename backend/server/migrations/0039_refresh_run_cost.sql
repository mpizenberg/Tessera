-- What a run cost the host: CPU time, and the store's driver calls, each one
-- round trip on a remote database. Wall time is already `duration_ms`.
-- Existing rows predate both and read 0.
ALTER TABLE refresh_run ADD COLUMN cpu_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE refresh_run ADD COLUMN db_round_trips INTEGER NOT NULL DEFAULT 0;
