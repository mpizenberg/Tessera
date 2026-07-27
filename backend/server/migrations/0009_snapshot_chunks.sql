-- Split the cached snapshot across rows (see src/store.ts).
--
-- It used to be one TEXT value: every survey and every response, including
-- padded sealed ciphertexts that grow with sealed participation. D1 caps a
-- single value at ~2,000,000 bytes, so the blob had a hard ceiling past which
-- every refresh's write fails, the snapshot freezes at its last good state and
-- validation/finalization stop advancing — silently, since the previous
-- snapshot keeps serving.
--
-- Carries the existing snapshot over as chunk 0 rather than dropping it, so a
-- deployment doesn't serve 503 until the next refresh completes.
CREATE TABLE snapshot_chunk (
  seq     INTEGER PRIMARY KEY,
  payload TEXT NOT NULL
);

CREATE TABLE snapshot_meta (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at INTEGER NOT NULL
);

INSERT INTO snapshot_chunk (seq, payload)
  SELECT 0, payload FROM snapshot_cache WHERE id = 1;
INSERT INTO snapshot_meta (id, fetched_at)
  SELECT 1, fetched_at FROM snapshot_cache WHERE id = 1;

DROP TABLE snapshot_cache;
