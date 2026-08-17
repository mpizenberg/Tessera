-- Count a survey's responders without reading its responses.
--
-- A survey's `response_count` is the number of distinct (role, credential)
-- identity keys among its responses. Every re-projection of a survey used to
-- recount it by pulling every one of its response rows — the full wire JSON,
-- sealed ciphertexts included — into the process, so a touched survey cost its
-- whole participation in bytes each time, on every run while it was being
-- answered. The identity key needs three columns; `credential` was already
-- one, `role` sat inside the JSON. Now it is a column too, and an index over
-- (survey_key, role, credential, slot) answers three questions without ever
-- touching a record: the distinct count of a survey, whether an identity key
-- already appears among the survey's rows below a slot, and both from index
-- entries alone.
ALTER TABLE response ADD COLUMN role INTEGER NOT NULL DEFAULT 0;
UPDATE response SET role = json_extract(record, '$.response.role');
CREATE INDEX response_identity ON response (survey_key, role, credential, slot);

-- The settled half of that count, banked per survey. Below the settlement
-- window a survey's response set cannot move, so the distinct count over its
-- rows below `below_slot` is frozen; a re-projection then merges only the rows
-- at or above it, probing the index for the keys it has not seen. A row is
-- overwritten whenever a survey is recounted, and read only when every row an
-- integration may add, replace or delete lies at or above `below_slot` —
-- otherwise the survey is recounted from all its rows and banked afresh.
CREATE TABLE response_count_bank (
  survey_key    TEXT    PRIMARY KEY,
  settled_count INTEGER NOT NULL,   -- distinct (role, credential) below below_slot
  below_slot    INTEGER NOT NULL
);
