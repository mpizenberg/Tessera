/**
 * {@link SnapshotStore} over Cloudflare D1 for the Worker. Same single-row
 * `snapshot_cache` schema as `store-node.ts`, but created by the checked-in
 * `migrations/0001_snapshot_cache.sql` (applied with
 * `wrangler d1 migrations apply`) rather than at open time.
 *
 * D1 is typed structurally here (just the prepare/bind/first/run slice we use)
 * instead of pulling in `@cloudflare/workers-types`, whose global declarations
 * clash with `@types/node` in this package's single tsconfig.
 */

import type { CachedSnapshot, SnapshotStore } from "./store";

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}

/** The slice of Cloudflare's `D1Database` this store needs. */
export interface D1Like {
  prepare(query: string): D1PreparedStatement;
}

export function d1SnapshotStore(db: D1Like): SnapshotStore {
  return {
    async get(): Promise<CachedSnapshot | null> {
      const row = await db
        .prepare(
          "SELECT payload, fetched_at AS fetchedAt FROM snapshot_cache WHERE id = 1",
        )
        .first<{ payload: string; fetchedAt: number }>();
      if (!row) return null;
      return { payload: JSON.parse(row.payload), fetchedAt: row.fetchedAt };
    },
    async put(snapshot: CachedSnapshot): Promise<void> {
      await db
        .prepare(
          `INSERT INTO snapshot_cache (id, payload, fetched_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             payload = excluded.payload,
             fetched_at = excluded.fetched_at`,
        )
        .bind(JSON.stringify(snapshot.payload), snapshot.fetchedAt)
        .run();
    },
    close() {
      // Nothing to release: D1 connections are managed by the runtime.
    },
  };
}
