-- Finalization waits until the end of a survey's end epoch is k blocks deep.
--
-- Only the epoch before the tip's can be short of that, and once it is final
-- it stays final, so the refresh banks the latest epoch it has seen reach that
-- depth and stops asking the chain about it. It rides the scan-state row and
-- is written by a statement of its own, like the two floors. 0 asks again,
-- which is what a database that has never looked owes.
ALTER TABLE scan_state ADD COLUMN final_through_epoch INTEGER NOT NULL DEFAULT 0;

-- While that epoch is still short of k blocks, the envelope says so, so the
-- list payload can tell a reader that results are settling and how many blocks
-- are left. Wire JSON of `{ epoch, blocksLeft }`; NULL when nothing is settling
-- or the depth could not be read.
ALTER TABLE snapshot_meta ADD COLUMN settling TEXT;
