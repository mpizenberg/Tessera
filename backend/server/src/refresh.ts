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
import { buildSurveyIndex } from "./listIndex";
import type { BackendStore } from "./store";
import { validateNewResponses } from "./validate";

/** Cap stored failure messages so a pathological error can't bloat the row. */
const ERROR_TEXT_MAX = 300;

export async function refreshSnapshot(
  config: ServerConfig,
  store: BackendStore,
): Promise<void> {
  // Every Koios request this run issues (scan + validation + finalization)
  // ticks this counter — the per-run stats row is the health footer's data,
  // and on Workers the count tracks headroom against the per-invocation
  // subrequest cap (50 free / 1000 paid).
  let koiosCalls = 0;
  const countCall = (): void => {
    koiosCalls += 1;
  };
  const startedAt = Math.floor(Date.now() / 1000);
  const startedMs = Date.now();
  const recordRun = (
    outcome:
      | {
          ok: true;
          incomplete: boolean;
          surveys: number;
          responses: number;
          payloadBytes: number;
        }
      | { ok: false; error: string },
  ): Promise<void> =>
    store
      .putRefreshRun({
        startedAt,
        durationMs: Date.now() - startedMs,
        koiosCalls,
        ...(outcome.ok
          ? { ...outcome, error: null }
          : {
              ok: false,
              error: outcome.error.slice(0, ERROR_TEXT_MAX),
              incomplete: false,
              surveys: 0,
              responses: 0,
              payloadBytes: 0,
            }),
      })
      // Stats are best-effort: recording must never mask the run's own outcome.
      .catch((err) =>
        console.warn(`refresh stats write failed: ${String(err)}`),
      );

  // The store-backed metadata cache makes the scan resumable: tx metadata is
  // immutable, so each fulfilled /tx_metadata batch is banked and never
  // re-fetched — a refresh cut short (Worker subrequest cap) converges over
  // successive crons instead of failing identically forever.
  const source = new KoiosDataSource(
    config.app,
    undefined,
    {
      get: (hashes) => store.cachedTxMetadata(hashes),
      put: (entries) => store.putTxMetadata(entries),
    },
    countCall,
  );
  try {
    const [records, tip] = await Promise.all([
      source.fetchAll(),
      source.chainTip(),
    ]);
    // Governance links are best-effort enrichment; a failure must not sink the
    // snapshot (mirrors the app's behaviour). But an empty list on *failure* means
    // "unknown", not "none" — validation must not freeze a link-dependent verdict
    // against it, so the failure is signalled separately.
    let govLinksReliable = true;
    const govLinks = await source
      .fetchGovernanceLinks(config.app.sinceUnix)
      .catch((err) => {
        console.warn(`gov links fetch failed: ${String(err)}`);
        govLinksReliable = false;
        return [];
      });

    const payload = toJsonSafe({ records, tip, govLinks });
    const payloadBytes = JSON.stringify(payload).length;
    const fetchedAt = Math.floor(Date.now() / 1000);
    await store.put({ payload, fetchedAt });

    console.log(
      `snapshot refreshed: ${records.surveys.length} surveys, ` +
        `${records.responses.length} responses, ` +
        `${records.cancellations.length} cancellations` +
        `${records.incomplete ? " (incomplete)" : ""}`,
    );

    // §6.3 validation rides the same refresh (Node loop + Worker cron alike):
    // incremental, so already-validated responses cost nothing. Best-effort —
    // the snapshot above is already stored either way.
    await validateNewResponses(
      store,
      records,
      govLinks,
      source,
      govLinksReliable,
    ).catch((err) =>
      console.warn(`response validation failed (will retry): ${String(err)}`),
    );

    // Finalization (§6.5/§7) runs last, on the freshly validated state: weight
    // snapshotting + artifact emission for safely-closed surveys. Idempotent and
    // resumable, so a failure here just retries next refresh.
    await finalizeClosedSurveys(
      config,
      store,
      new KoiosTallyInputs(config.app, undefined, countCall),
      source,
      records,
      tip,
    ).catch((err) =>
      console.warn(`finalization failed (will retry): ${String(err)}`),
    );

    // Materialize the paged Explore-list rows LAST, so the index reflects
    // this run's validation/finalization (a survey finalized as cancelled
    // above flips its row's overlay flag in the same refresh). Sharing the
    // snapshot's fetchedAt keeps the list route's ETag in step with the
    // per-survey routes serving the blob.
    await store.replaceSurveyIndex(
      buildSurveyIndex(
        records,
        tip,
        govLinks,
        await store.finalizedCancelledKeys(),
      ),
      {
        tip: JSON.stringify(toJsonSafe(tip)),
        incomplete: records.incomplete === true,
        fetchedAt,
      },
    );

    await recordRun({
      ok: true,
      incomplete: records.incomplete === true,
      surveys: records.surveys.length,
      responses: records.responses.length,
      payloadBytes,
    });
    console.log(
      `refresh ok: ${koiosCalls} Koios calls, ${Date.now() - startedMs} ms`,
    );
  } catch (err) {
    await recordRun({ ok: false, error: String(err) });
    console.error(
      `refresh failed after ${koiosCalls} Koios calls ` +
        `(keeping last snapshot): ${String(err)}`,
    );
    throw err;
  }
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
    // Failures are already logged (and recorded in refresh_run) by
    // refreshSnapshot itself — just keep the rejection from bubbling.
    refreshSnapshot(config, store).catch(() => {});
  };
  tick();
  const handle = setInterval(tick, config.refreshSeconds * 1000);
  handle.unref?.();
  return () => clearInterval(handle);
}
