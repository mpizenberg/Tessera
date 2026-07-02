-- Single-row snapshot cache (see src/store.ts). Mirrors the schema
-- store-node.ts creates for the local node:sqlite database.
CREATE TABLE snapshot_cache (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  payload    TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL
);
