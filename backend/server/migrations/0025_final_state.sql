-- The finalizer's decision, materialized per survey row: 'finalized' or
-- 'cancelled' (an artifact exists, its hash denormalized beside it) or
-- 'untalliable' (decided that no artifact will ever exist). NULL = undecided.
-- Replaces the boolean finalized_cancelled overlay, which could only carry the
-- cancelled outcome.
ALTER TABLE survey_index ADD COLUMN final_state TEXT;
ALTER TABLE survey_index ADD COLUMN artifact_hash TEXT;

-- Untalliable verdicts get their own ground-truth table, mirroring the role
-- tally_artifact plays for the other two states: a projection rebuild re-reads
-- the verdict from here, so a re-materialized row keeps it. Never swept —
-- the verdict is only reached below the settlement window, where rollbacks
-- cannot occur.
CREATE TABLE untalliable_survey (
  survey_key TEXT PRIMARY KEY,   -- "<txHex>:<index>"
  decided_at INTEGER NOT NULL    -- unix seconds of the deciding pass
);

-- Backfill the two artifact-backed states from the artifacts themselves.
UPDATE survey_index
SET artifact_hash = (SELECT a.artifact_hash FROM tally_artifact a
                     WHERE a.survey_key = survey_index.survey_key),
    final_state = (SELECT CASE
                     WHEN json_extract(a.artifact, '$.tally.cancelled')
                          IS NOT NULL THEN 'cancelled'
                     ELSE 'finalized' END
                   FROM tally_artifact a
                   WHERE a.survey_key = survey_index.survey_key)
WHERE EXISTS (SELECT 1 FROM tally_artifact a
              WHERE a.survey_key = survey_index.survey_key);

-- The partial index behind the cancelled-expiry read moves with the column,
-- and its predicate tightens: any decided state — not just cancelled — means
-- the row no longer needs the expiry touch.
DROP INDEX survey_index_expiring_cancelled;
ALTER TABLE survey_index DROP COLUMN finalized_cancelled;
CREATE INDEX survey_index_expiring_cancelled
  ON survey_index (end_epoch)
  WHERE cancelled = 1 AND final_state IS NULL;

-- Untalliable verdicts reached before this table existed were dropped after
-- logging. Resetting the finalization floor makes the next pass walk closed
-- history once and re-decide it: artifact emission is INSERT-OR-IGNORE and
-- only artifact-less closed surveys are candidates, so the pass is idempotent
-- and re-reads little.
UPDATE scan_state SET finalization_floor = 0 WHERE id = 1;
