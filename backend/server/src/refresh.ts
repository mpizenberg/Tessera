/**
 * Snapshot refresh: run the Koios read path server-side and cache the result.
 *
 * This is the exact `KoiosDataSource` the browser used to run per load, now run
 * once per interval behind the server's token (or the anonymous tier). A failed
 * refresh logs and leaves the previous good snapshot in place — the server never
 * serves a half-built or blank snapshot because one fetch hiccuped.
 */

import { toJsonSafe } from "@tessera/core";
import { KoiosDataSource } from "@tessera/koios";

import type { ServerConfig } from "./config";
import type { SnapshotStore } from "./store";

export async function refreshSnapshot(
  config: ServerConfig,
  store: SnapshotStore,
): Promise<void> {
  const source = new KoiosDataSource(config.app);
  const [records, tip] = await Promise.all([
    source.fetchAll(),
    source.chainTip(),
  ]);
  // Governance links are best-effort enrichment; a failure must not sink the
  // snapshot (mirrors the app's behaviour).
  const govLinks = await source
    .fetchGovernanceLinks(config.app.sinceUnix)
    .catch((err) => {
      console.warn(`gov links fetch failed: ${String(err)}`);
      return [];
    });

  const payload = toJsonSafe({ records, tip, govLinks });
  store.put({ payload, fetchedAt: Math.floor(Date.now() / 1000) });

  console.log(
    `snapshot refreshed: ${records.surveys.length} surveys, ` +
      `${records.responses.length} responses, ` +
      `${records.cancellations.length} cancellations` +
      `${records.incomplete ? " (incomplete)" : ""}`,
  );
}

/**
 * Refresh once now, then every `refreshSeconds`. Returns a stop function. The
 * interval is unref'd so it never keeps the process alive on its own.
 */
export function startRefreshLoop(
  config: ServerConfig,
  store: SnapshotStore,
): () => void {
  const tick = (): void => {
    refreshSnapshot(config, store).catch((err) =>
      console.error(`refresh failed (keeping last snapshot): ${String(err)}`),
    );
  };
  tick();
  const handle = setInterval(tick, config.refreshSeconds * 1000);
  handle.unref?.();
  return () => clearInterval(handle);
}
