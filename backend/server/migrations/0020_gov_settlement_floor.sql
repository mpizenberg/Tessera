-- Bound the governance-link pass to the epochs whose links can still move.
--
-- `end_epoch` is the axis the per-refresh link reads select on — the pass's
-- epoch set, the link-change diff, the cancelled-expiry check — and the
-- serving and proof-prune horizons read on it too. Unindexed, every one of
-- them was a full `survey_index` scan on every cron: exactly the
-- corpus-proportional cost the windowed refresh exists to remove.
CREATE INDEX survey_index_end_epoch ON survey_index (end_epoch);

-- The cancelled-expiry read (a verified-while-open cancellation whose survey
-- has since closed, so its row's flag must expire) matches nothing at all in
-- steady state. A partial index makes the whole index those few rows.
CREATE INDEX survey_index_expiring_cancelled
  ON survey_index (end_epoch)
  WHERE cancelled = 1 AND finalized_cancelled = 0;

-- The settlement floor: the lowest expiration epoch `gov_epoch` has not
-- settled. Below it every link set is frozen and each survey's own
-- `gov_links` slice is the authoritative copy, so the pass asks only about
-- epochs at or above it — a query set a few epochs wide however long the
-- deployment has been running.
--
-- It rides the scan-state row but is written by a statement of its own: the
-- cursor must not be banked from an incomplete scan, while settlement has
-- nothing to do with the scan's coverage. Before the first cursor is banked
-- there is no row to update and the floor reads 0, which is the right answer
-- anyway — ask about everything.
ALTER TABLE scan_state ADD COLUMN settlement_floor INTEGER NOT NULL DEFAULT 0;
