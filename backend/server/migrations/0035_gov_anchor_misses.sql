-- The failed fetches of a governance anchor not yet resolved: how many, and
-- when the last was. A failure is not evidence of absence, so it decides
-- nothing about the link; it spaces the next attempt on the backoff the script
-- lookups use (backoff.ts), and an epoch settles without an anchor only once
-- its attempts are used up (govLinks.ts), never on a count of epochs alone.
--
-- The row goes when the anchor resolves into gov_anchor, and is pruned with
-- the anchors when its epoch settles.
CREATE TABLE gov_anchor_miss (
  anchor_hash TEXT    PRIMARY KEY,  -- blake2b-256 of the document (hex)
  misses      INTEGER NOT NULL,     -- fetches that failed
  checked_at  INTEGER NOT NULL      -- unix seconds of the last one
);
