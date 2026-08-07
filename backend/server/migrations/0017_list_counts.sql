-- Credential- and search-independent chip counts (all/linked/active/sealed/
-- public), computed by the refresh over the rows it materializes and banked
-- with the envelope, so the list route stops aggregating the whole
-- survey_index on every no-search request. NULL means "not banked yet" (an
-- envelope written before this column); serving then falls back to the live
-- aggregate until the next refresh publishes.
ALTER TABLE snapshot_meta ADD COLUMN list_counts TEXT;

-- The one chip the bank cannot carry is `mine` — it depends on the caller's
-- credentials. This index keeps that per-request count (and the `mine`
-- filter) proportional to the caller's own surveys instead of the table.
CREATE INDEX survey_index_owner ON survey_index (owner);
