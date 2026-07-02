/**
 * `IndexerDataSource` — the browser's read path against the Tier-1 serving
 * backend (`backend/ARCHITECTURE.md` §2, §5, §8).
 *
 * Where {@link import("@tessera/koios").KoiosDataSource} makes every browser
 * re-scan Koios (a shared token baked in the bundle; load scaling with
 * users × refreshes), this fetches a single snapshot the server already
 * assembled once per interval. It speaks the HTTP contract in
 * `backend/server/src/http.ts`, one route per `DataSource` method:
 *   - `GET /api/snapshot`   records + tip + governance links (+ freshness stamp)
 *   - `GET /api/tx_status`  live confirmation counts for just-submitted txs
 *
 * Records/tip/govLinks arrive in the `@tessera/core` JSON-safe wire form
 * (bytes → hex, bigint → decimal string) and are decoded with {@link fromJsonSafe}
 * back to the exact `Uint8Array`/`bigint`/`Map`-bearing shapes the domain layer
 * expects — so the rest of the app can't tell whether Koios or the indexer
 * produced them. `KoiosDataSource` stays available as the direct/power-user/
 * offline path (when no indexer URL is configured); this is an addition.
 */

import { fromJsonSafe } from "@tessera/core";
import type {
  ChainTip,
  Cip179Records,
  DataSource,
  GovLink,
} from "@tessera/core";

/** Abort a serving-tier request that hangs (the snapshot is cache-served, fast). */
const REQUEST_TIMEOUT_MS = 30_000;

/** The decoded `/api/snapshot` body — one coherent server-side read. */
interface Snapshot {
  readonly records: Cip179Records;
  readonly tip: ChainTip;
  readonly govLinks: GovLink[];
  /** Unix seconds when the server last rebuilt this snapshot. */
  readonly fetchedAt: number;
  /** Server-computed age of the snapshot at response time, in seconds. */
  readonly ageSeconds: number;
}

export class IndexerDataSource implements DataSource {
  /**
   * The snapshot promise for the current load. `fetchAll()` starts a fresh one;
   * `chainTip()`/`fetchGovernanceLinks()` reuse it, so one load makes exactly
   * one request even though the seam exposes three read methods — they're always
   * called together (`chainTip` concurrently with `fetchAll`, then
   * `fetchGovernanceLinks` right after). A later load's `fetchAll()` replaces it.
   */
  private current: Promise<Snapshot> | null = null;

  /**
   * @param baseUrl serving-tier origin (no trailing slash), e.g.
   * `http://localhost:8787`. May be a same-origin path prefix; routes are joined
   * as plain strings so a prefix is preserved.
   */
  constructor(private readonly baseUrl: string) {}

  async fetchAll(): Promise<Cip179Records> {
    const snap = (this.current = this.fetchSnapshot());
    return (await snap).records;
  }

  async chainTip(): Promise<ChainTip> {
    return (await this.snapshot()).tip;
  }

  /**
   * The server already bounded the governance scan when it built the snapshot,
   * so `sinceUnix` is unused here — the links ride along in the same snapshot.
   */
  async fetchGovernanceLinks(_sinceUnix: number): Promise<GovLink[]> {
    return (await this.snapshot()).govLinks;
  }

  async txStatus(
    txHashes: readonly string[],
  ): Promise<Map<string, number | null>> {
    if (txHashes.length === 0) return new Map();
    const qs = new URLSearchParams({ hashes: txHashes.join(",") });
    const body = await this.getJson<Record<string, number | null>>(
      `${this.baseUrl}/api/tx_status?${qs.toString()}`,
    );
    return new Map(Object.entries(body));
  }

  /** The current load's snapshot, starting one if nothing is in flight yet. */
  private snapshot(): Promise<Snapshot> {
    return (this.current ??= this.fetchSnapshot());
  }

  private async fetchSnapshot(): Promise<Snapshot> {
    const raw = await this.getJson<unknown>(`${this.baseUrl}/api/snapshot`);
    // Decode the wire form back to Uint8Array/bigint/Map-bearing records.
    return fromJsonSafe(raw) as Snapshot;
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 503 = the server hasn't completed its first snapshot refresh yet.
      const hint =
        res.status === 503 ? " — serving-tier snapshot not ready yet" : "";
      throw new Error(`Indexer ${url} → ${res.status}${hint}`);
    }
    return res.json() as Promise<T>;
  }
}
