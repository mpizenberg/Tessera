-- Whether this run's governance-links read came back usable. A failure there
-- is otherwise invisible: the run still counts ok (links are best-effort
-- enrichment, and the refresh republishes the previous snapshot's links rather
-- than blanking them), so nothing recorded how often the read actually fails.
-- Existing rows predate the flag; 1 keeps them out of the failure count.
ALTER TABLE refresh_run ADD COLUMN gov_links_ok INTEGER NOT NULL DEFAULT 1;
