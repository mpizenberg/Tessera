-- Bound finalization's candidate read to the epochs it can still decide.
--
-- The read asks for every closed survey holding no artifact, which under a
-- fixed lower bound of "the beginning of time" grows with the archive twice
-- over: `end_epoch < tipEpoch` matches every survey that ever closed, and the
-- `NOT IN (SELECT survey_key FROM tally_artifact)` anti-join reads every
-- artifact ever emitted. It is the last read a steady-state refresh runs whose
-- cost tracks corpus age rather than the window.
--
-- The finalization floor is the lowest end epoch that still holds a survey the
-- pass expects to decide. Below it every survey is finalized or permanently
-- untalliable, so the read starts there and the anti-join is scoped to the same
-- bound — which is what this index makes cheap.
CREATE INDEX tally_artifact_end_epoch ON tally_artifact (end_epoch);

-- It rides the scan-state row beside the settlement floor and is written by a
-- statement of its own, for the same reason: the cursor must not be banked
-- from an incomplete scan, while what finalization decided has nothing to do
-- with the scan's coverage. 0 asks about everything, which is what a database
-- that has never finalized owes.
ALTER TABLE scan_state ADD COLUMN finalization_floor INTEGER NOT NULL DEFAULT 0;
