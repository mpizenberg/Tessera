/**
 * Snapshot refresh: run the Koios read path server-side and cache the result.
 *
 * This is the exact `KoiosDataSource` the browser used to run per load, now run
 * once per interval behind the server's token (or the anonymous tier). A failed
 * refresh logs and leaves the previous good snapshot in place — the server never
 * serves a half-built or blank snapshot because one fetch hiccuped.
 *
 * At most one run at a time, enforced by a stored lease. Neither scheduler
 * serializes itself: a Cloudflare cron can start while the previous one is
 * still running, and the Node loop's interval fires regardless. Two runs racing
 * would let the slower one write its older scan last, over the newer snapshot.
 */

import type { GovLink, GovLinkScan } from "cip-179/domain";
import { toJsonSafe } from "cip-179/tally";
import { KoiosDataSource, KoiosTallyInputs } from "@tessera/koios";

import type { ServerConfig } from "./config";
import { finalizeClosedSurveys } from "./finalize";
import { materializeSnapshot, snapshotBytes } from "./materialize";
import {
  REFRESH_LEASE_SECONDS,
  type BackendStore,
  type SnapshotStore,
} from "./store";
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
  // Governance links are best-effort enrichment; a failure must not sink the
  // snapshot (mirrors the app's behaviour). But an empty list on *failure* means
  // "unknown", not "none": validation must not freeze a link-dependent verdict
  // against it, finalization must not stamp it into an artifact, and the
  // snapshot must not publish it as "no links" — so the failure travels as a
  // flag, and is recorded on the run for whoever asks how often it happens.
  let govLinksReliable = true;
  const startedAt = Math.floor(Date.now() / 1000);
  const startedMs = Date.now();

  const lease = await store.acquireRefreshLease(
    startedAt,
    REFRESH_LEASE_SECONDS,
  );
  if (!lease) {
    console.log("refresh skipped: another run holds the lease");
    return;
  }

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
        govLinksOk: govLinksReliable,
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
    const { links: govLinks, unresolved: govUnresolved } = await source
      .fetchGovernanceLinks(
        config.app.sinceUnix,
        records.surveys.map((s) => s.definition.endEpoch),
      )
      .catch((err) => {
        console.warn(`gov links fetch failed: ${String(err)}`);
        govLinksReliable = false;
        return { links: [], unresolved: [] };
      });

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
      govUnresolved,
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
      undefined,
      // `null` = unknown, so the pass defers rather than stamping "no links"
      // into an artifact that outlives this refresh.
      govLinksReliable ? govLinks : null,
    ).catch((err) =>
      console.warn(`finalization failed (will retry): ${String(err)}`),
    );

    // Materialize LAST, so the stored rows reflect this run's validation and
    // finalization (a survey finalized as cancelled above flips its row's
    // overlay flag in the same refresh). One transaction publishes the whole
    // snapshot at once: until it commits, every route serves the previous one.
    const snapshot = materializeSnapshot(
      records,
      tip,
      await displayGovLinks(
        store,
        { links: govLinks, unresolved: govUnresolved },
        govLinksReliable,
      ),
      await store.finalizedCancelledKeys(),
    );
    const payloadBytes = snapshotBytes(snapshot);
    await store.replaceSnapshot(snapshot.surveys, snapshot.responses, {
      tip: JSON.stringify(toJsonSafe(tip)),
      incomplete: records.incomplete === true,
      // Stamped with the scan's start, not this write: `tip` was read then, so
      // the pair describes one instant, and age counts from when the data was
      // true rather than from when it happened to land.
      fetchedAt: startedAt,
    });

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
  } finally {
    // Never let the release mask this run's outcome — a lease that goes
    // unreleased just expires, which is the same path a killed run takes.
    await store
      .releaseRefreshLease(lease)
      .catch((e) => console.warn(`refresh lease release failed: ${String(e)}`));
  }
}

/**
 * The governance links the snapshot publishes: what this refresh read, plus the
 * previous snapshot's link for every action it could NOT read.
 *
 * An unreadable action is *unknown*, not unlinked, and publishing it as "no
 * link" is what makes links flicker in the app. Two ways to be unreadable, both
 * routine: Koios resolves an anchor into `meta_json` lazily and its nodes
 * disagree about which ones are resolved — the same action comes back a link on
 * one refresh and a null anchor on the next — or the whole scan failed, which
 * makes every link unknown at once. A scan classifies each action as one or the
 * other, never both, so the recovered links never collide with the fresh ones.
 *
 * Recovering a link is sound because an action's anchor is hash-fixed at
 * proposal time: whatever we resolved before is what the action still says. The
 * links only reach the display snapshot, where epoch alignment, haystack and
 * counts are re-derived against the fresh tip; validation and finalization see
 * the honest scan, so no verdict or artifact is ever built on a recovered link.
 */
export async function displayGovLinks(
  store: Pick<SnapshotStore, "snapshotGovLinks">,
  scan: GovLinkScan,
  reliable: boolean,
): Promise<readonly GovLink[]> {
  const unknown = new Set(scan.unresolved.map((u) => u.actionId));
  if (reliable && unknown.size === 0) return scan.links;
  try {
    const stored = await store.snapshotGovLinks();
    if (!reliable) {
      console.warn(`gov links unreadable — republishing ${stored.length}`);
      return stored;
    }
    const recovered = stored.filter((l) => unknown.has(l.actionId));
    if (recovered.length > 0) {
      console.log(
        `gov links: ${recovered.length} anchor(s) unresolved this refresh — kept the stored link`,
      );
    }
    return [...scan.links, ...recovered];
  } catch (err) {
    console.warn(`gov links recovery failed: ${String(err)}`);
    return scan.links;
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
