-- Responses become rows, and the snapshot blob goes away entirely.
--
-- Everything the blob held was already materialized per survey (record,
-- cancellations, gov links, tip, incomplete, fetchedAt) except the responses
-- themselves — so promoting those empties it. What that removes is the
-- per-request parse: serving one survey's bundle used to deserialize every
-- survey and every response, including padded sealed ciphertexts, inside a
-- Worker's CPU and memory limits.
--
-- The meta row is cleared rather than kept: rows and envelope are written in
-- one transaction by each refresh, so an empty envelope is exactly "no
-- snapshot yet" and every snapshot-derived route answers 503 until the first
-- refresh after this migration. Carrying the old blob's responses over would
-- mean re-deriving survey and credential keys from JSON in SQL, duplicating
-- wire-encoding rules that live in TypeScript.
DROP TABLE snapshot_chunk;
DROP TABLE snapshot_meta;

ALTER TABLE survey_index_meta RENAME TO snapshot_meta;
DELETE FROM snapshot_meta;

CREATE TABLE response (
  tx_hash        TEXT    NOT NULL,
  response_index INTEGER NOT NULL,   -- position in the tx payload's array
  survey_key     TEXT    NOT NULL,   -- "<txHex>:<index>" of the target survey
  credential     TEXT    NOT NULL,   -- credentialKey of the responder
  slot           INTEGER NOT NULL,
  record         TEXT    NOT NULL,   -- wire JSON ResponseRecord
  PRIMARY KEY (tx_hash, response_index)
);

-- Covers the per-survey bundle: selection by survey, ordered, without a sort.
CREATE INDEX response_survey
  ON response (survey_key, slot, tx_hash, response_index);
-- Covers "surveys these credentials answered".
CREATE INDEX response_credential ON response (credential);
