-- By-hash lookups of native scripts, per script hash: the script found, or the
-- lookups that found none so far. A native-script credential its record's
-- transaction does not carry is resolved this way, and counts if the script is
-- on chain by the end of the survey's end epoch.
--
-- A found script is on chain for good, with the epoch it first appeared in, so
-- its row is never rewritten. A lookup that found none is asked again on a
-- backoff (scriptLookups.ts), so a made-up hash, named by a response to a
-- survey ending far off, cannot buy a Koios request on every refresh. A failed
-- lookup banks nothing.
--
-- Pruned like tx_proof_cache (proofCache.ts): a hash stays while a live survey
-- names it, as its owner or as a response's credential.
CREATE TABLE script_lookup_cache (
  script_hash TEXT    PRIMARY KEY,
  script      TEXT,              -- wire JSON NativeScriptInfo; NULL: none found
  epoch       INTEGER,           -- first epoch on chain; NULL: none found
  misses      INTEGER NOT NULL,  -- lookups that found none
  checked_at  INTEGER NOT NULL   -- unix seconds of the last lookup
);
