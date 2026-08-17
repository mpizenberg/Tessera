-- Make the validation backlog O(backlog) to read instead of O(history).
--
-- Two refresh reads and the health endpoint ask "which verdicts still await an
-- enrichment retry" (`block_index IS NULL OR proof_ok IS NULL`). Without an
-- index that predicate scans every verdict ever recorded to return the handful
-- that are pending — a per-refresh cost that grows with the archive, which
-- ARCHITECTURE.md §0 forbids. A partial index holds exactly the pending rows,
-- so the read costs what the backlog is, and empties as it does.
CREATE INDEX validated_response_incomplete
  ON validated_response (survey_key)
  WHERE block_index IS NULL OR proof_ok IS NULL;
