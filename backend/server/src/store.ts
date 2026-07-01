/**
 * Snapshot cache storage.
 *
 * The read-path snapshot is content the browser used to re-fetch on every load;
 * here it is computed once server-side and cached. The store is a tiny
 * repository interface over SQLite — this phase persists a single JSON-safe
 * snapshot row. Cloudflare **D1** is also SQLite, so the same schema + a D1-bound
 * implementation of {@link SnapshotStore} drops in later without touching callers
 * (`backend/ARCHITECTURE.md` §3). The Phase-2 tally tables (§6.5) join here too.
 */

import { DatabaseSync } from "node:sqlite";

export interface CachedSnapshot {
  /** JSON-safe DTO (`@tessera/core` wire form) of `{ records, tip, govLinks }`. */
  readonly payload: unknown;
  /** Unix seconds when this snapshot was fetched from Koios. */
  readonly fetchedAt: number;
}

export interface SnapshotStore {
  get(): CachedSnapshot | null;
  put(snapshot: CachedSnapshot): void;
  close(): void;
}

export function openSnapshotStore(path: string): SnapshotStore {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_cache (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      payload    TEXT    NOT NULL,
      fetched_at INTEGER NOT NULL
    );
  `);

  const selectStmt = db.prepare(
    "SELECT payload, fetched_at AS fetchedAt FROM snapshot_cache WHERE id = 1",
  );
  const upsertStmt = db.prepare(`
    INSERT INTO snapshot_cache (id, payload, fetched_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      fetched_at = excluded.fetched_at
  `);

  return {
    get() {
      const row = selectStmt.get() as
        | { payload: string; fetchedAt: number }
        | undefined;
      if (!row) return null;
      return { payload: JSON.parse(row.payload), fetchedAt: row.fetchedAt };
    },
    put(snapshot) {
      upsertStmt.run(JSON.stringify(snapshot.payload), snapshot.fetchedAt);
    },
    close() {
      db.close();
    },
  };
}
