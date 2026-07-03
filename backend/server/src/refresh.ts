/**
 * Snapshot refresh: run the Koios read path server-side and cache the result.
 *
 * This is the exact `KoiosDataSource` the browser used to run per load, now run
 * once per interval behind the server's token (or the anonymous tier). A failed
 * refresh logs and leaves the previous good snapshot in place — the server never
 * serves a half-built or blank snapshot because one fetch hiccuped.
 */

import { toJsonSafe } from "@tessera/core";
import { KoiosDataSource, KoiosTallyInputs } from "@tessera/koios";

import type { ServerConfig } from "./config";
import { finalizeClosedSurveys } from "./finalize";
import type { BackendStore } from "./store";
import { validateNewResponses } from "./validate";

export async function refreshSnapshot(
  config: ServerConfig,
  store: BackendStore,
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
  await store.put({ payload, fetchedAt: Math.floor(Date.now() / 1000) });

  console.log(
    `snapshot refreshed: ${records.surveys.length} surveys, ` +
      `${records.responses.length} responses, ` +
      `${records.cancellations.length} cancellations` +
      `${records.incomplete ? " (incomplete)" : ""}`,
  );

  // §6.3 validation rides the same refresh (Node loop + Worker cron alike):
  // incremental, so already-validated responses cost nothing. Best-effort —
  // the snapshot above is already stored either way.
  await validateNewResponses(store, records, govLinks, source).catch((err) =>
    console.warn(`response validation failed (will retry): ${String(err)}`),
  );

  // Finalization (§6.5/§7) runs last, on the freshly validated state: weight
  // snapshotting + artifact emission for safely-closed surveys. Idempotent and
  // resumable, so a failure here just retries next refresh.
  await finalizeClosedSurveys(
    config,
    store,
    new KoiosTallyInputs(config.app),
    source,
    records,
    tip,
  ).catch((err) =>
    console.warn(`finalization failed (will retry): ${String(err)}`),
  );
}

/**
 * Refresh once now, then every `refreshSeconds`. Returns a stop function. The
 * interval is unref'd so it never keeps the process alive on its own.
 */
export function startRefreshLoop(
  config: ServerConfig,
  store: BackendStore,
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
