-- Phase-2 tally tables (ARCHITECTURE.md §6.5).

-- Shared weight snapshot across all surveys ending at the same epoch: one row
-- per (epoch, role, credential), written only once fetched (complete rows),
-- so the table doubles as the finalization resume cursor.
CREATE TABLE weight_snapshot (
  epoch      INTEGER NOT NULL,
  role       INTEGER NOT NULL,
  credential TEXT    NOT NULL,          -- "key:<hex>" | "script:<hex>"
  weight     TEXT    NOT NULL,          -- lovelace as decimal string
  registered INTEGER NOT NULL,          -- 0/1 membership at `epoch`
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (epoch, role, credential)
);

CREATE TABLE epoch_totals (
  epoch      INTEGER NOT NULL,
  role       INTEGER NOT NULL,
  total      TEXT    NOT NULL,          -- decimal string
  endpoint   TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (epoch, role)
);

-- One immutable row per finalized survey; `artifact` is the exact JSON text
-- served verbatim (byte identity with the hash).
CREATE TABLE tally_artifact (
  survey_key    TEXT PRIMARY KEY,
  end_epoch     INTEGER NOT NULL,
  artifact_hash TEXT    NOT NULL,
  artifact      TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX tally_artifact_hash ON tally_artifact (artifact_hash);
