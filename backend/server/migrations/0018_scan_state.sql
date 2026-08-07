-- Banked state of the windowed segment walker: the main cursor (last chain
-- position whose slot segment is fully integrated into the materialized
-- rows), the rebuild generation the stored rows were derived under (a
-- mismatch with the deployed code's generation rewinds the cursor and
-- re-derives from the config floor), and the trickle cursor (where the
-- drift-healing rescan is in its rotation over the settled prefix). One row;
-- no row means "never walked", which scans from the config floor. Each
-- cursor is a (slot, tx_hash) pair or wholly NULL — half a cursor is not a
-- resume point.
CREATE TABLE scan_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  cursor_slot     INTEGER,
  cursor_tx_hash  TEXT,
  generation      INTEGER NOT NULL,
  trickle_slot    INTEGER,
  trickle_tx_hash TEXT,
  CHECK ((cursor_slot IS NULL) = (cursor_tx_hash IS NULL)),
  CHECK ((trickle_slot IS NULL) = (trickle_tx_hash IS NULL))
);

-- Slot-bounded segment sweeps and window reads select responses by slot
-- range; both existing indexes lead with another column, so without this one
-- every segment pass would scan the whole table — the corpus-proportional
-- cost the windowed refresh exists to remove.
CREATE INDEX response_slot ON response (slot, tx_hash, response_index);
