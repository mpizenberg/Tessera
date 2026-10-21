-- Whether the survey's definition is spec-valid enough to tally. An
-- untalliable survey is closed from the start, whatever its end epoch: it
-- sorts into a closed section and counts toward no open chip.
--
-- No backfill: the column only decides anything for a survey not yet past its
-- end epoch, which has no final verdict to read it from. Such a row keeps the
-- default until a refresh re-derives it, and the drift-healing rescan
-- re-derives every settled row within hours.
ALTER TABLE survey_index ADD COLUMN talliable INTEGER NOT NULL DEFAULT 1;
