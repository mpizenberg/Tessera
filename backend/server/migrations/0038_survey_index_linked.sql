-- The linked closed section of the Explore register reads the linked rows
-- only. A partial index makes the whole index those few rows, so the section
-- skips the full scan the closed standalone section pays, and only a linked
-- row's write touches it.
CREATE INDEX survey_index_linked ON survey_index (slot) WHERE gov_linked = 1;
