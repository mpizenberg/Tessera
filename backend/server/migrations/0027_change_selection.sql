-- The change selection: `GET /api/surveys?changes=<cursor>` answers the rows
-- whose stored projection moved and the keys removed since a position the
-- server minted, so a mirror applies deltas instead of re-reading what it
-- holds.
--
-- Every write to a survey row stamps the generation that wrote it — the
-- refresh's start instant, the same number the envelope's fetched_at and the
-- ETag carry. A quiet refresh writes nothing (the reconcile upsert is gated
-- on a changed row), so the stamp moves exactly when the projection does.
-- Backfilled to 0: a consumer only ever starts from a cursor minted after this
-- deploy, so no read crosses the backfill.
ALTER TABLE survey_index ADD COLUMN changed_at INTEGER NOT NULL DEFAULT 0;

-- The delta's own keyset order. Under the list's (bucket, slot DESC, key)
-- order a `changed_at > ?` read scans the table; under this one it is a range
-- seek bounded above by the published generation.
CREATE INDEX survey_index_changed ON survey_index (changed_at, survey_key);

-- A swept survey leaves its key here, stamped with the sweeping generation,
-- captured by the same predicate the delete applies. A key that re-lands
-- keeps its tombstone: "removed" is read as tombstoned AND absent from
-- survey_index, so nothing has to be un-tombstoned. Retention-bounded — the
-- refresh prunes rows older than the operational window, and a cursor that
-- old is answered `resync`.
CREATE TABLE survey_tombstone (
  survey_key TEXT PRIMARY KEY,   -- "<txHex>:<index>"
  deleted_at INTEGER NOT NULL    -- the sweeping refresh's generation
);
CREATE INDEX survey_tombstone_deleted ON survey_tombstone (deleted_at, survey_key);
