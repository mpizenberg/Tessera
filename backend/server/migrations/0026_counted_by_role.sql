-- The audited per-role responder count, materialized per survey row.
--
-- `response_count` is distinct responders across roles with no validity,
-- deadline or proof filter — a figure anyone can inflate by answering an
-- ineligible role, answering past the deadline, or naming a credential they do
-- not control. This column is the audit rule instead: in-window, valid against
-- the definition, latest-valid-wins, refuted proofs dropped, pending verdicts
-- counted, grouped by CIP-179 role. JSON object, role integer (as a key) →
-- count; '{}' when nothing counts.
ALTER TABLE survey_index ADD COLUMN counted_by_role TEXT NOT NULL DEFAULT '{}';

-- The two halves of the rule move on different clocks, so each gets the
-- storage its clock needs.
--
-- The static half — in-window (the record's authoritative epoch_no against the
-- survey's end_epoch) and valid against the definition — reads two immutable
-- inputs, so it is settled the moment a response row is projected and belongs
-- on the row as a column. Without it, an audited count could only be derived
-- by re-reading every response record of every touched survey on every
-- refresh: 8.2 MB per run for one survey with 10,000 responders, measured, and
-- exactly the per-survey participation cost migration 0023 exists to retire.
ALTER TABLE response ADD COLUMN countable INTEGER NOT NULL DEFAULT 1;

-- The moving half is the credential proof, and only a *refuted* one changes
-- the answer (a pending verdict counts, and so does a proven one). Refutations
-- are rare, so the reads that find them must cost what they are and not what
-- participation is — the same reasoning as validated_response_incomplete
-- (0022).
CREATE INDEX validated_response_refuted
  ON validated_response (survey_key)
  WHERE proof_ok = 0;

-- How many refuted proofs the row's counted_by_role was projected against.
-- A refutation lands after the integration that projected the row (validation
-- runs later in the same refresh), and can land on a survey no segment
-- touches, so the row would otherwise stay stale until something else touched
-- it — precisely the closed-but-not-yet-finalized survey this count exists to
-- carry. A stamp that disagrees with the live count makes the survey stale,
-- the same way an expired cancellation does.
ALTER TABLE survey_index ADD COLUMN refuted_count INTEGER NOT NULL DEFAULT 0;

-- Both halves of that comparison must cost the refutations: the refuted rows
-- are found through validated_response_refuted, and the rows that stamped a
-- refutation they no longer hold through this one.
CREATE INDEX survey_index_refuted
  ON survey_index (survey_key)
  WHERE refuted_count > 0;

-- The per-role half of the banked settled count. Counted over `countable`
-- rows alone — refutation-blind, so a later refutation never invalidates a
-- bank; the refuted keys are subtracted at projection instead, at one probe
-- each.
ALTER TABLE response_count_bank ADD COLUMN settled_by_role TEXT NOT NULL DEFAULT '{}';

-- The bank's shape changed, so its contents die with it: a banked row carries
-- no per-role vector and '{}' would read as "nothing counted below the slot".
-- Each survey recounts whole once, on the refresh that next touches it, and
-- re-banks both vectors.
DELETE FROM response_count_bank;

-- Backfill the static half from the verdicts, which carry both its inputs:
-- a row's epoch_no against its survey's end_epoch, and well_formed. A response
-- with no verdict yet keeps the optimistic default — the same direction the
-- rule takes for an undecided proof — and is re-derived when the drift-healing
-- rescan next re-lists it.
UPDATE response SET countable = 0
WHERE EXISTS (
  SELECT 1 FROM validated_response v JOIN survey_index s USING (survey_key)
  WHERE v.tx_hash = response.tx_hash
    AND v.response_index = response.response_index
    AND (v.well_formed = 0 OR v.epoch_no > s.end_epoch));

-- And the audited counts themselves, from the same source, so a survey no
-- refresh touches for a while is not serving '{}'.
UPDATE survey_index SET
  counted_by_role = COALESCE((
    SELECT json_group_object(role, n)
    FROM (SELECT CAST(v.role AS TEXT) AS role,
                 COUNT(DISTINCT v.credential) AS n
          FROM validated_response v
          WHERE v.survey_key = survey_index.survey_key
            AND v.well_formed = 1
            AND v.epoch_no <= survey_index.end_epoch
            AND (v.proof_ok IS NULL OR v.proof_ok = 1)
          GROUP BY v.role)), '{}'),
  refuted_count = (
    SELECT COUNT(*) FROM validated_response v
    WHERE v.survey_key = survey_index.survey_key AND v.proof_ok = 0);
