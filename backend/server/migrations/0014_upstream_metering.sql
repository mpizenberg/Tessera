-- Split the one call counter into the two budgets it was standing in for.
--
-- `koios_calls` counted every upstream request a run made, which is really the
-- Worker's per-invocation subrequest budget — a budget that does not care which
-- host a request went to. Governance-anchor fetches spend it; they do not spend
-- the Koios daily quota. So the run row now carries both: `upstream_requests`
-- for the subrequest cap, `koios_calls` narrowed to Koios itself.
--
-- Rows written before anchor fetches existed spent every upstream request on
-- Koios, so copying the old count across is exact, not an approximation.
ALTER TABLE refresh_run ADD COLUMN upstream_requests INTEGER NOT NULL DEFAULT 0;
UPDATE refresh_run SET upstream_requests = koios_calls;

-- Upstream traffic per service over time, in fixed buckets.
--
-- Refresh runs are not the only spender: /api/tip and /api/pparams draw on the
-- operator's Koios identity outside any run, and /api/tx_status draws on a
-- separate one. A 24 h total summed from refresh_run cannot see either, which
-- is the whole reason this table exists.
--
-- Rebuildable: losing it costs a blind spot in the health footer until the
-- window refills, never a wrong answer about the chain.
CREATE TABLE upstream_tally (
  bucket INTEGER NOT NULL,  -- unix seconds, floored to the bucket width
  -- Which budget the calls were spent from: 'koios' (the operator identity),
  -- 'koios-passthrough' (the segregated comfort identity), 'anchor'
  -- (governance anchor documents, any host).
  kind   TEXT NOT NULL,
  calls  INTEGER NOT NULL,
  PRIMARY KEY (bucket, kind)
);
