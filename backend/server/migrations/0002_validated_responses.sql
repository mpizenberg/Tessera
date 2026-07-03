-- Per-response validation results (ARCHITECTURE.md §6.3 rules 1–3), filled
-- incrementally during each snapshot refresh: only never-seen
-- (tx_hash, response_index) keys cost extra Koios calls. Mirrors the schema
-- store-node.ts creates for the local node:sqlite database.
--
-- NULL block_index / proof_ok mean "the enrichment fetch failed — retry on a
-- later refresh"; epoch_no is stored raw so the deadline rule stays a pure
-- comparison at tally time.
CREATE TABLE validated_response (
  tx_hash        TEXT    NOT NULL,
  response_index INTEGER NOT NULL,
  survey_key     TEXT    NOT NULL,
  role           INTEGER NOT NULL,
  credential     TEXT    NOT NULL,
  slot           INTEGER NOT NULL,
  epoch_no       INTEGER NOT NULL,
  block_index    INTEGER,
  proof_ok       INTEGER,
  well_formed    INTEGER NOT NULL,
  checked_at     INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, response_index)
);

CREATE INDEX validated_response_survey ON validated_response (survey_key);
