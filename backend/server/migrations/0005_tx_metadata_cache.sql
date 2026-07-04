-- Fetch-once cache of label-17 tx metadata: the snapshot scan's resume state.
-- A tx's metadata is immutable (content-addressed by its hash), so rows are
-- insert-or-ignore and only new on-chain activity grows the table. Snapshot
-- membership is decided by each run's fresh label-index scan, never by this
-- cache — a rolled-back tx's entry just stops being requested.
CREATE TABLE tx_metadata_cache (
  tx_hash  TEXT PRIMARY KEY,
  metadata TEXT NOT NULL  -- raw Koios `metadata` JSON ("null" when the tx had none)
);
