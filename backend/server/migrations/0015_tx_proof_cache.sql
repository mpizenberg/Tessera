-- Fetch-once cache of transaction CBOR, the credential-proof evidence behind
-- every owner-proof and response proof. A tx hash content-addresses its bytes,
-- so a row is immutable and insert-or-ignore.
--
-- The raw bytes are stored, never the decoded proof: mechanism-A script
-- resolution merges scripts fetched by hash from the chain, and a script absent
-- today can be registered tomorrow — banking a merged proof would freeze a
-- verdict that was only true at fetch time. Decoding and merging run per call.
--
-- Absences are not cached. A hash /tx_cbor returned no row for is a node that
-- is behind, not an answer, so it is retried; only bytes actually returned land
-- here.
--
-- Unlike tx_metadata_cache this table is pruned (see proofCache.ts): the rows
-- are large, and a survey's proof stops being read once its artifact is frozen.
CREATE TABLE tx_proof_cache (
  tx_hash TEXT PRIMARY KEY,
  cbor    TEXT NOT NULL  -- raw Koios `cbor` hex
);
