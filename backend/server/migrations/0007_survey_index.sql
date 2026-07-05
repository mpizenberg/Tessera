-- Materialized per-survey rows for the paged Explore list. Rebuilt wholesale
-- by each refresh (a full replace — the set is scan-sized), so the list route
-- answers filter/search/page queries from indexed rows instead of decoding
-- the whole snapshot_cache blob. The JSON columns carry each survey's slice
-- of the wire payload (record, its cancellations, its governance links), so a
-- page body is assembled by concatenation, no re-encoding.
CREATE TABLE survey_index (
  survey_key          TEXT PRIMARY KEY,   -- "<txHex>:<index>"
  slot                INTEGER NOT NULL,   -- keyset sort key (newest first)
  end_epoch           INTEGER NOT NULL,
  sealed              INTEGER NOT NULL,   -- commit-reveal submission mode
  cancelled           INTEGER NOT NULL,   -- owner-verified (incl. finalized overlay)
  gov_linked          INTEGER NOT NULL,   -- has an epoch-aligned governance link
  owner               TEXT    NOT NULL,   -- credentialKey of the definition owner
  haystack            TEXT    NOT NULL,   -- lowercased searchable on-chain text
  record              TEXT    NOT NULL,   -- wire JSON SurveyRecord
  cancellations       TEXT    NOT NULL,   -- wire JSON CancellationRecord[]
  gov_links           TEXT    NOT NULL,   -- wire JSON GovLink[]
  response_count      INTEGER NOT NULL,
  finalized_cancelled INTEGER NOT NULL    -- artifact finalized it as cancelled
);
CREATE INDEX survey_index_slot ON survey_index (slot DESC);

-- The page-independent envelope of the list payload, written atomically with
-- the rows above: the snapshot's tip (wire JSON), its incomplete flag, and the
-- fetchedAt that versions the route's ETag.
CREATE TABLE survey_index_meta (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  tip        TEXT    NOT NULL,
  incomplete INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);
