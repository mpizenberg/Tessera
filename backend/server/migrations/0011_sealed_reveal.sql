-- Per-response sealed-reveal outcomes: the resume cursor for §6.5 reveal, the
-- way weight_snapshot is the one for weights.
--
-- One timelock decrypt costs ~20 ms of Worker CPU against a 30 s cron ceiling,
-- so a large sealed survey cannot be revealed inside a single invocation.
-- Recording each ciphertext's outcome as it is decrypted lets a pass spend its
-- decrypt budget and stop, with the next pass resuming from here instead of
-- starting the survey over. Deterministic across passes: the round is pinned by
-- the immutable survey definition and drand beacons are immutable, so the same
-- beacon re-fetched each pass yields the same plaintext.
--
-- Row absent = not attempted yet. NULL `response` = the ciphertext did not
-- decrypt or did not decode, which is final rather than a retry — re-attempting
-- against the same immutable beacon can only reach the same verdict.
--
-- Reads join through validated_response's survey index, so no index here: the
-- join probes this table by primary key.
CREATE TABLE sealed_reveal (
  tx_hash        TEXT    NOT NULL,
  response_index INTEGER NOT NULL,
  response       TEXT,              -- wire JSON of the decrypted SurveyResponse
  PRIMARY KEY (tx_hash, response_index)
);
