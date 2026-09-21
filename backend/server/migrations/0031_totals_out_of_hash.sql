-- Ruleset 14 moves each role's electorate total out of the hashed tally into
-- the artifact's unhashed `info` section, and the ruleset hash into its
-- unhashed `provenance`, and every stored artifact is re-emitted in that
-- shape. The artifacts go, the surveys they decided are
-- undecided again, and the finalization floor drops to 0 so the next pass
-- walks closed history once. That pass re-emits from the frozen
-- `weight_snapshot` and `epoch_totals` rows and the `sealed_reveal`
-- outcomes, and stamps each row with its new decision and hash.
--
-- Untalliable verdicts stay: they carry no artifact. A cleared row is stamped
-- now, so a mirror following `changes` learns it is undecided until then.
UPDATE survey_index
SET final_state = NULL,
    artifact_hash = NULL,
    changed_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE final_state IN ('finalized', 'cancelled');

DELETE FROM tally_artifact;

UPDATE scan_state SET finalization_floor = 0 WHERE id = 1;
