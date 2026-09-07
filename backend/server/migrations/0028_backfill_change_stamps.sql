-- Chain-dated change stamps. 0027 backfilled `changed_at` to 0, which was
-- correct while a delta could only start from a cursor the server minted. It
-- stops being correct once the selection accepts `since=<unix>`: the axis asks
-- `changed_at > since`, so a row still at 0 is invisible to every query,
-- `since=0` included. Those rows are the surveys nothing has rewritten since
-- the change selection deployed, which on a quiet corpus is most of them.
--
-- Dated by chain time rather than by this migration's instant. A flat instant
-- would sit above every live cursor, and the next delta would re-send the
-- whole corpus to every mirror -- the cost the selection exists to avoid.
-- Chain time sits below every live cursor, and is the honest date besides.
--
-- Each row takes the latest moment that could have moved its projection: its
-- own transaction, its newest response or cancellation, or the finalizer's
-- decision (already unix seconds). Slots convert linearly -- post-Shelley
-- slots are 1 s -- so the offset is the stored tip's `time - slot`, with no
-- per-network literal. A governance-link change carries no date anywhere, so
-- a row whose only pre-deploy change was its link set is dated by its last
-- chain event instead.
--
-- `survey_tombstone` stops being retention-bounded in this same deploy: a
-- `since` older than any window has to be answerable, so the refresh no
-- longer prunes it.
UPDATE survey_index
SET changed_at = MAX(
      (SELECT json_extract(m.tip, '$.time') - json_extract(m.tip, '$.slot')
       FROM snapshot_meta m WHERE m.id = 1)
      + MAX(survey_index.slot,
            COALESCE((SELECT MAX(r.slot) FROM response r
                      WHERE r.survey_key = survey_index.survey_key), 0),
            COALESCE((SELECT MAX(c.slot) FROM cancellation c
                      WHERE c.survey_key = survey_index.survey_key), 0)),
      COALESCE((SELECT a.created_at FROM tally_artifact a
                WHERE a.survey_key = survey_index.survey_key), 0),
      COALESCE((SELECT u.decided_at FROM untalliable_survey u
                WHERE u.survey_key = survey_index.survey_key), 0))
-- Keyed on `survey_index_changed`. The guard keeps a database migrated before
-- its first refresh -- no tip, no rows -- from writing NULL into a NOT NULL
-- column.
WHERE changed_at = 0
  AND EXISTS (SELECT 1 FROM snapshot_meta WHERE id = 1);
