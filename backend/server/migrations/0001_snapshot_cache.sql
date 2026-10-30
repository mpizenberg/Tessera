-- Single-row snapshot cache (see src/store.ts).
--
-- These migration files are the single schema source for every driver
-- (src/migrations.ts, tracked in `schema_migration`).
CREATE TABLE snapshot_cache (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  payload    TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL
);
