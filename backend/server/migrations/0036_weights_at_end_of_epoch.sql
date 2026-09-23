-- Ruleset 15 reads every DRep and Stakeholder weight, and its registration,
-- at the end of a survey's end epoch, where the frozen rows below were read at
-- its start (DReps) or two epochs before (Stakeholders). Rows are never
-- revised once written, so they go, with the totals read beside them, and the
-- next pass reads them again at the new instant. Keyholder rows weigh 1 at
-- any instant and stay.
--
-- Stored artifacts stay, each naming the ruleset it was counted under.
-- Migration 0031, deployed with this one, re-emits them all anyway.
DELETE FROM weight_snapshot WHERE role IN (0, 3);

DELETE FROM epoch_totals;
