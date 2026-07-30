-- Governance-link resolution state: a per-anchor bank and a per-epoch memo.
--
-- The refresh resolves a proposal's anchor itself (fetch, verify against the
-- on-chain hash, classify) rather than reading an indexer's off-chain
-- resolution. Anchor content is hash-fixed, so one verified fetch is terminal
-- and banked here; and a proposal's expiration epoch is always in the future
-- when it is proposed, so the set of proposals at a past epoch is frozen and
-- can be settled once and for all.
--
-- Both tables are rebuildable cache: dropping them costs a re-scan, a re-fetch
-- and a re-settle, never a wrong answer.
CREATE TABLE gov_anchor (
  anchor_hash TEXT PRIMARY KEY,  -- blake2b-256 of the document (hex)
  -- The document's survey link as JSON ({surveyKey, title}), or "null" for a
  -- document that verifiably carries none. Absent row = not yet resolved.
  link        TEXT NOT NULL
);

-- One settled expiration epoch: its link set is final and no refresh queries
-- that epoch again. Pruned only by a cache wipe — `links` is what keeps an old
-- survey's linkage on display, and `gave_up` is the audit trail of anchors we
-- stopped waiting for.
CREATE TABLE gov_epoch (
  expiration INTEGER PRIMARY KEY,  -- Koios `expiration` = survey end_epoch + 1
  links      TEXT NOT NULL,        -- JSON GovLink[]
  gave_up    TEXT NOT NULL,        -- JSON action id[] left unresolved at settlement
  settled_at INTEGER NOT NULL
);
