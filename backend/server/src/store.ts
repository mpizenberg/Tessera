/**
 * Snapshot cache storage — the repository interface.
 *
 * The read-path snapshot is content the browser used to re-fetch on every load;
 * here it is computed once server-side and cached. Two implementations share
 * this seam and the same single-row SQLite schema (`snapshot_cache`):
 * `store-node.ts` (node:sqlite, local process) and `store-d1.ts` (Cloudflare
 * D1, Worker) — see `backend/ARCHITECTURE.md` §3. `get`/`put` are async because
 * D1 is; the node impl just wraps its synchronous calls. The Phase-2 tally
 * tables (§6.5) join this schema too.
 */

export interface CachedSnapshot {
  /** JSON-safe DTO (`@tessera/core` wire form) of `{ records, tip, govLinks }`. */
  readonly payload: unknown;
  /** Unix seconds when this snapshot was fetched from Koios. */
  readonly fetchedAt: number;
}

export interface SnapshotStore {
  get(): Promise<CachedSnapshot | null>;
  put(snapshot: CachedSnapshot): Promise<void>;
  close(): void;
}
