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

import type { GovLink } from "cip-179/domain";
import { toJsonSafe } from "cip-179/tally";
import { KoiosDataSource, KoiosTallyInputs } from "@tessera/koios";

import type { ServerConfig } from "./config";
import { finalizeClosedSurveys } from "./finalize";
import { refreshGovLinks } from "./govLinks";
import { materializeSnapshot, snapshotBytes } from "./materialize";
import { upstreamMeter } from "./meter";
import { pruneTxProofCache } from "./proofCache";
import {
  OPERATIONAL_RETENTION_SECONDS,
  REFRESH_LEASE_SECONDS,
  sumUpstream,
  type BackendStore,
  type SnapshotStore,
  type UpstreamTotals,
} from "./store";
import { validateNewResponses } from "./validate";

/** Cap stored failure messages so a pathological error can't bloat the row. */
const ERROR_TEXT_MAX = 300;

const callSummary = (calls: UpstreamTotals): string =>
  `${sumUpstream(calls)} upstream requests (${calls.koios} Koios)`;

export async function refreshSnapshot(
  config: ServerConfig,
  store: BackendStore,
): Promise<void> {
  const meter = upstreamMeter(store);
  const countKoios = meter.hook("koios");
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
  ): Promise<void> => {
    const calls = meter.counted();
    return (
      Promise.all([
        store.putRefreshRun({
          startedAt,
          durationMs: Date.now() - startedMs,
          upstreamRequests: sumUpstream(calls),
          koiosCalls: calls.koios,
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
        }),
        meter.drain(startedAt),
        // The tally's only writer that can afford to prune: the serving path adds
        // to it on requests that must stay one write.
        store.pruneUpstreamTally(startedAt - OPERATIONAL_RETENTION_SECONDS),
      ])
        .then(() => undefined)
        // Stats are best-effort: recording must never mask the run's own outcome.
        .catch((err) =>
          console.warn(`refresh stats write failed: ${String(err)}`),
        )
    );
  };

  // The store-backed scan cache banks what a tx hash content-addresses. Its
  // metadata half makes the scan resumable: each fulfilled /tx_metadata batch is
  // banked and never re-fetched, so a refresh cut short (Worker subrequest cap)
  // converges over successive crons instead of failing identically forever. Its
  // proof half spares an open survey the /tx_cbor batches its owner-proof would
  // otherwise cost on every single scan.
  const source = new KoiosDataSource(
    config.app,
    undefined,
    {
      metadata: (hashes) => store.cachedTxMetadata(hashes),
      putMetadata: (entries) => store.putTxMetadata(entries),
      proofCbor: (hashes) => store.cachedTxProofCbor(hashes),
      putProofCbor: (entries) => store.putTxProofCbor(entries),
    },
    countKoios,
  );
  try {
    const [records, tip] = await Promise.all([
      source.fetchAll(),
      source.chainTip(),
    ]);
    const { links: govLinks, unresolved: govUnresolved } =
      await refreshGovLinks(
        store,
        source,
        records.surveys.map((s) => s.definition.endEpoch),
        tip.epoch,
        startedAt,
        { onRequest: meter.hook("anchor") },
      ).catch((err) => {
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
      new KoiosTallyInputs(config.app, undefined, countKoios),
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

    // After finalization, so a survey that just froze its artifact releases its
    // transactions in the same run rather than a refresh later. Best-effort: a
    // cache that keeps too much is only a cache that costs storage.
    await pruneTxProofCache(
      store,
      records,
      tip,
      await store.finalizedSurveyKeys(),
    ).catch((err) =>
      console.warn(`tx proof cache prune failed: ${String(err)}`),
    );

    // Materialize LAST, so the stored rows reflect this run's validation and
    // finalization (a survey finalized as cancelled above flips its row's
    // overlay flag in the same refresh). One transaction publishes the whole
    // snapshot at once: until it commits, every route serves the previous one.
    const snapshot = materializeSnapshot(
      records,
      tip,
      await displayGovLinks(store, govLinks, govLinksReliable),
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

    // Read before recording: recording drains the meter.
    const summary = callSummary(meter.counted());
    await recordRun({
      ok: true,
      incomplete: records.incomplete === true,
      surveys: records.surveys.length,
      responses: records.responses.length,
      payloadBytes,
    });
    console.log(`refresh ok: ${summary}, ${Date.now() - startedMs} ms`);
  } catch (err) {
    const summary = callSummary(meter.counted());
    await recordRun({ ok: false, error: String(err) });
    console.error(
      `refresh failed after ${summary} (keeping last snapshot): ${String(err)}`,
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
 * The governance links the snapshot publishes: this refresh's, or the previous
 * snapshot's when the whole read failed.
 *
 * A failed read makes every link *unknown* at once, and publishing unknown as
 * "no links" would blank the linkage everywhere until the next good run.
 * Republishing is sound because an action's anchor is hash-fixed at proposal
 * time: whatever was resolved before is what the action still says. The links
 * only reach the display snapshot, where epoch alignment, haystack and counts
 * are re-derived against the fresh tip; validation and finalization see the
 * honest (empty) read, so no verdict or artifact is built on a stale link.
 *
 * A *successful* read needs no such rescue: classifications come from documents
 * verified against their on-chain hash and banked, so a link this backend has
 * seen once stays in the answer until its epoch settles it in for good.
 */
export async function displayGovLinks(
  store: Pick<SnapshotStore, "snapshotGovLinks">,
  links: readonly GovLink[],
  reliable: boolean,
): Promise<readonly GovLink[]> {
  if (reliable) return links;
  try {
    const stored = await store.snapshotGovLinks();
    console.warn(`gov links unreadable — republishing ${stored.length}`);
    return stored;
  } catch (err) {
    console.warn(`gov links recovery failed: ${String(err)}`);
    return links;
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
