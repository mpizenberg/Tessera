/**
 * {@link SnapshotStore} over `node:sqlite` for the local Node process. Kept in
 * its own module so the Cloudflare Worker bundle (which uses `store-d1.ts`)
 * never imports `node:sqlite` — Workers' nodejs_compat does not provide it.
 * Creates the schema itself; the D1 twin gets it from `migrations/` instead.
 */

import { DatabaseSync } from "node:sqlite";

import type { CachedSnapshot, SnapshotStore } from "./store";

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
    async get(): Promise<CachedSnapshot | null> {
      const row = selectStmt.get() as
        | { payload: string; fetchedAt: number }
        | undefined;
      if (!row) return null;
      return { payload: JSON.parse(row.payload), fetchedAt: row.fetchedAt };
    },
    async put(snapshot: CachedSnapshot): Promise<void> {
      upsertStmt.run(JSON.stringify(snapshot.payload), snapshot.fetchedAt);
    },
    close() {
      db.close();
    },
  };
}
