-- Cancellations become rows, like responses. A cancellation's effect lives in
-- its target survey's projection, but the cancelling tx has its own slot, so
-- detecting a rolled-back cancellation in O(window) needs cancellations as
-- slot-addressed rows the segment sweep can see. survey_index.cancellations
-- stays as the per-survey serving projection, rebuilt per touched survey from
-- these rows (the same pattern response_count follows over response rows).
CREATE TABLE cancellation (
  tx_hash    TEXT    NOT NULL,
  survey_key TEXT    NOT NULL,   -- "<txHex>:<index>" of the cancelled survey
  slot       INTEGER NOT NULL,
  record     TEXT    NOT NULL,   -- wire JSON CancellationRecord
  PRIMARY KEY (tx_hash, survey_key)
);
-- Covers the per-survey projection rebuild.
CREATE INDEX cancellation_survey ON cancellation (survey_key);
-- Covers the slot-bounded segment sweep and window read.
CREATE INDEX cancellation_slot ON cancellation (slot, tx_hash);

-- Rows written before this migration exist only inside the projections; every
-- cancellation in a projection row targets that row's survey.
INSERT OR IGNORE INTO cancellation (tx_hash, survey_key, slot, record)
SELECT json_extract(j.value, '$.txHash'), s.survey_key,
       json_extract(j.value, '$.slot'), j.value
FROM survey_index AS s, json_each(s.cancellations) AS j;

-- The digest gate is retired: change detection is now "the segment reconcile
-- changed no rows", and the reconcile the gate used to skip is O(window).
ALTER TABLE snapshot_meta DROP COLUMN payload_digest;

-- Whether the segment walker is caught up to the tip (the next run re-derives
-- the settlement margin) or mid catch-up (the next run continues strictly
-- after the cursor pair).
ALTER TABLE scan_state ADD COLUMN caught_up INTEGER NOT NULL DEFAULT 0;
