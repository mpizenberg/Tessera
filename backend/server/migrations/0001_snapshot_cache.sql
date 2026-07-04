-- Single-row snapshot cache (see src/store.ts).
--
-- These migration files are the single schema source for BOTH backends:
-- D1 applies them via `wrangler d1 migrations apply`, the local node:sqlite
-- database via store-node.ts's runner (tracked in `schema_migration`).
CREATE TABLE snapshot_cache (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  payload    TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL
);
