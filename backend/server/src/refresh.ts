/**
 * Snapshot refresh: walk one slot segment of the label-17 index per run and
 * integrate it into the stored rows. The stored rows are the durable truth
 * for settled history; each run re-derives only the settlement margin below
 * its banked cursor (rollbacks are settlement-bounded), so the per-refresh
 * cost tracks the window, not the corpus age. A failed refresh logs and
 * leaves the previous good snapshot in place — the server never serves a
 * half-built or blank snapshot because one fetch hiccuped.
 *
 * At most one run at a time, enforced by a stored lease. Neither scheduler
 * serializes itself: a Cloudflare cron can start while the previous one is
 * still running, and the Node loop's interval fires regardless. Two runs
 * racing would let the slower one write its older scan last, over the newer
 * snapshot.
 */

import type { GovLink } from "cip-179/domain";
import { toJsonSafe } from "cip-179/tally";
import {
  KoiosDataSource,
  KoiosTallyInputs,
  type SegmentScan,
} from "cardano-tessera-koios";

import type { ServerConfig } from "./config";
import { finalizeClosedSurveys } from "./finalize";
import { refreshGovLinks } from "./govLinks";
import { integrateSegment } from "./integrate";
import { upstreamMeter } from "./meter";
import { pruneTxProofCache } from "./proofCache";
import {
  OPERATIONAL_RETENTION_SECONDS,
  REFRESH_LEASE_SECONDS,
  snapshotTip,
  sumUpstream,
  type BackendStore,
  type BankedListCounts,
  type ScanState,
  type SlotRange,
  type SnapshotStore,
  type UpstreamTotals,
} from "./store";
import { validateNewResponses } from "./validate";

/**
 * The derivation generation of the deployed code. Bump it whenever a deploy
 * changes how records project into rows: a banked generation that differs
 * rewinds the scan cursor to the config floor, and the ordinary segment
 * walker re-derives everything forward over as many crons as the page budget
 * needs.
 */
export const SCAN_GENERATION = 1;

/**
 * How far below the banked cursor a steady-state run re-derives, in 1 s
 * slots: ~3 days, about twice the 36 h mainnet/preprod stability window.
 * Nothing deeper can roll back, so re-integrating this margin every run heals
 * every chain-caused divergence. One constant for all networks.
 */
export const SETTLEMENT_MARGIN_SLOTS = 259_200;

/**
 * Listing pages one run may spend on its segment. Steady state expects ≤ 1;
 * the rest is catch-up throughput after downtime or a generation rewind,
 * bounded so the run stays inside the Worker's subrequest budget alongside
 * metadata batches, anchors, validation and finalization.
 */
const SEGMENT_PAGE_BUDGET = 8;

/** Cap stored failure messages so a pathological error can't bloat the row. */
const ERROR_TEXT_MAX = 300;

/** How one run resumes the walk, derived from the banked state. */
export interface SegmentPlan {
  /** `fetchSegment`'s resume point (inclusive floor, or strictly-after pair). */
  readonly from: { readonly slot: number; readonly txHash?: string };
  /**
   * First slot the sweep may delete in. In floor mode this is the floor
   * itself; continuing a keyset walk it is `cursor.slot + 1` — rows at the
   * cursor slot at-or-before the cursor hash are not re-listed, so sweeping
   * that slot would delete live rows.
   */
  readonly sweepFromSlot: number;
}

export function planSegment(
  state: ScanState | null,
  floorSlot: number,
): SegmentPlan {
  const cursor = state?.cursor ?? null;
  if (cursor === null)
    return { from: { slot: floorSlot }, sweepFromSlot: floorSlot };
  if (state!.caughtUp) {
    const slot = Math.max(floorSlot, cursor.slot - SETTLEMENT_MARGIN_SLOTS);
    return { from: { slot }, sweepFromSlot: slot };
  }
  return {
    from: { slot: cursor.slot, txHash: cursor.txHash },
    sweepFromSlot: cursor.slot + 1,
  };
}

/**
 * The slot range this scan safely covered — the sweep's deletion scope — or
 * null when nothing may be swept: an incomplete scan (an unfetched tx is
 * indistinguishable from a vanished one), or a budget-capped walk whose last
 * listed slot may hold further unlisted txs (the covered prefix then ends one
 * slot earlier; a range that inverts covers nothing).
 */
export function coveredRange(
  plan: SegmentPlan,
  scan: SegmentScan,
  tipSlot: number,
): SlotRange | null {
  if (scan.records.incomplete) return null;
  const toSlot = scan.exhausted ? tipSlot : scan.cursor!.slot - 1;
  if (toSlot < plan.sweepFromSlot) return null;
  return { fromSlot: plan.sweepFromSlot, toSlot };
}

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

  const recordRun = async (
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
    // Banked on every run (failed ones too — the table's state is a fact
    // either way) so /api/health serves it from the run row instead of
    // counting validated_response per request.
    const validationBacklog = await store
      .incompleteValidationCount()
      .catch(() => null);
    return (
      Promise.all([
        store.putRefreshRun({
          startedAt,
          durationMs: Date.now() - startedMs,
          upstreamRequests: sumUpstream(calls),
          koiosCalls: calls.koios,
          govLinksOk: govLinksReliable,
          validationBacklog,
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
  // metadata half is read keyed by the segment's listed hashes only; its
  // proof half spares an open survey the /tx_cbor batches its owner-proof
  // (and cancellation-proof) checks would otherwise cost on every single run.
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
    // The published tip of the previous snapshot, so this run can skip the
    // `/epoch_params` read whenever the epoch has not turned over — which, at a
    // three-minute cadence against day-long epochs, is nearly every run.
    const previous = await store.snapshotMeta();
    const tip = await source.chainTip(previous ? snapshotTip(previous) : null);

    const banked = await store.scanState();
    const rewound = banked !== null && banked.generation !== SCAN_GENERATION;
    if (rewound) {
      console.log(
        `scan generation ${banked.generation} → ${SCAN_GENERATION}: rewinding to the config floor`,
      );
    }
    const state = rewound ? null : banked;
    // Post-Shelley slots are 1 s, so the config floor's slot is derived
    // linearly from the tip — no per-network genesis math.
    const floorSlot = Math.max(
      0,
      Math.floor(tip.slot - (tip.time - config.app.sinceUnix)),
    );
    const plan = planSegment(state, floorSlot);
    const scan = await source.fetchSegment(
      { from: plan.from, pageBudget: SEGMENT_PAGE_BUDGET },
      tip,
    );
    const records = scan.records;
    console.log(
      `segment scanned: ${records.surveys.length} surveys, ` +
        `${records.responses.length} responses, ` +
        `${records.cancellations.length} cancellations` +
        `${records.incomplete ? " (incomplete)" : ""}` +
        `${scan.exhausted ? "" : " (catching up)"}`,
    );

    // The epoch set is the stored surveys' plus this segment's, so a survey
    // first seen this run links in the same run.
    const { links: govLinks, unresolved: govUnresolved } =
      await refreshGovLinks(
        store,
        source,
        [
          ...new Set([
            ...(await store.surveyEndEpochs(0)),
            ...records.surveys.map((s) => s.definition.endEpoch),
          ]),
        ],
        tip.epoch,
        startedAt,
        { onRequest: meter.hook("anchor") },
      ).catch((err) => {
        console.warn(`gov links fetch failed: ${String(err)}`);
        govLinksReliable = false;
        return { links: [], unresolved: [] };
      });

    // Integrate BEFORE the consumers run, so validation, finalization and the
    // proof-cache prune all see this run's corpus. The overlay input is the
    // pre-finalize artifact state; this run's own finalizations land through
    // the targeted overlay update below.
    const artifactKeys = await store.finalizedArtifactKeys();
    const range = coveredRange(plan, scan, tip.slot);
    const incomplete = records.incomplete === true || !scan.exhausted;
    const integration = await integrateSegment(store, source, {
      records,
      range,
      tip,
      govLinks: await displayGovLinks(store, govLinks, govLinksReliable),
      govLinksReliable,
      finalizedCancelled: artifactKeys.cancelled,
      meta: {
        tip: JSON.stringify(toJsonSafe(tip)),
        incomplete,
        // Stamped with the scan's start, not this write: `tip` was read then,
        // so the pair describes one instant, and age counts from when the
        // data was true rather than from when it happened to land.
        fetchedAt: startedAt,
        listCounts: previous?.listCounts ?? null,
      },
    });

    // Bank the cursor only after its segment is reconciled: a banked cursor
    // past unreconciled slots would settle a gap in for good, while a
    // reconciled segment with an unbanked cursor only costs an idempotent
    // re-walk. An incomplete scan banks nothing — a listed tx may be missing
    // its record, and advancing past it would settle the gap in.
    let cursor = state?.cursor ?? null;
    if (records.incomplete !== true) {
      cursor = scan.exhausted
        ? {
            slot: tip.slot,
            txHash: scan.cursor?.txHash ?? cursor?.txHash ?? "",
          }
        : scan.cursor!;
      await store.putScanState({
        cursor,
        caughtUp: scan.exhausted,
        generation: SCAN_GENERATION,
        trickle: rewound ? null : (state?.trickle ?? null),
      });
    }
    // The instant the integrated prefix reaches, on the chain's own clock —
    // finalization's safety gate during catch-up.
    const coveredThroughUnix =
      cursor === null ? null : tip.time + (cursor.slot - tip.slot);

    // §6.3 validation rides the same refresh (Node loop + Worker cron alike):
    // incremental, so already-validated responses cost nothing. Best-effort —
    // the rows above are already stored either way.
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

    // Finalization (§6.5/§7) runs on the freshly validated state: weight
    // snapshotting + artifact emission for safely-closed surveys. Idempotent and
    // resumable, so a failure here just retries next refresh. Its returned key
    // sets carry this pass's emissions, so the prune and overlay update below
    // need no `tally_artifact` scan of their own; a pass that died mid-way may
    // still have emitted, so only then is the store re-read.
    const finalKeys =
      (await finalizeClosedSurveys(
        config,
        store,
        new KoiosTallyInputs(config.app, undefined, countKoios),
        source,
        incomplete,
        tip,
        coveredThroughUnix,
        undefined,
        // `null` = unknown, so the pass defers rather than stamping "no links"
        // into an artifact that outlives this refresh.
        govLinksReliable ? govLinks : null,
      ).catch((err) => {
        console.warn(`finalization failed (will retry): ${String(err)}`);
        return null;
      })) ?? (await store.finalizedArtifactKeys());

    // A survey finalized as cancelled flips its row's overlay in the same
    // run. Idempotent over every cancelled artifact key, so it also heals a
    // row whose flag drifted.
    const overlayChanges = await store
      .markFinalizedCancelled([...finalKeys.cancelled])
      .catch((err) => {
        console.warn(
          `finalized-cancelled overlay update failed: ${String(err)}`,
        );
        return 0;
      });

    // After finalization, so a survey that just froze its artifact releases its
    // transactions in the same run rather than a refresh later. Best-effort: a
    // cache that keeps too much is only a cache that costs storage.
    await pruneTxProofCache(store, incomplete, tip, finalKeys.finalized).catch(
      (err) => console.warn(`tx proof cache prune failed: ${String(err)}`),
    );

    // Banked chip counts move only when rows changed or the epoch turned, so
    // recompute the aggregate only then; every other run republishes the
    // previous counts with this run's freshness (already done above).
    const previousEpoch = previous ? snapshotTip(previous).epoch : null;
    if (
      integration.changes > 0 ||
      overlayChanges > 0 ||
      previousEpoch !== tip.epoch ||
      previous?.listCounts == null
    ) {
      const counts = await store.surveyIndexCounts(tip.epoch, [], []);
      const bankedCounts: BankedListCounts = {
        all: counts.all,
        linked: counts.linked,
        active: counts.active,
        sealed: counts.sealed,
        public: counts.public,
      };
      await store.publishSnapshotMeta({
        tip: JSON.stringify(toJsonSafe(tip)),
        incomplete,
        fetchedAt: startedAt,
        listCounts: JSON.stringify(bankedCounts),
      });
    }

    // Read before recording: recording drains the meter.
    const summary = callSummary(meter.counted());
    await recordRun({
      ok: true,
      incomplete,
      surveys: records.surveys.length,
      responses: records.responses.length,
      payloadBytes: integration.payloadBytes,
    });
    console.log(
      `refresh ok: ${integration.changes} row changes, ${summary}, ` +
        `${Date.now() - startedMs} ms`,
    );
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
 * The governance links the touched-survey projections publish: this
 * refresh's, or the stored ones when the whole read failed.
 *
 * A failed read makes every link *unknown* at once, and publishing unknown as
 * "no links" would blank the linkage everywhere until the next good run.
 * Republishing is sound because an action's anchor is hash-fixed at proposal
 * time: whatever was resolved before is what the action still says. The links
 * only reach the display projection, where epoch alignment, haystack and counts
 * are re-derived against the fresh tip; validation and finalization see the
 * honest (empty) read, so no verdict or artifact is built on a stale link.
 *
 * A *successful* read needs no such rescue: classifications come from documents
 * verified against their on-chain hash and banked, so a link this backend has
 * seen once stays in the answer until its epoch settles it in for good.
 */
export async function displayGovLinks(
  store: Pick<SnapshotStore, "surveyGovLinks">,
  links: readonly GovLink[],
  reliable: boolean,
): Promise<readonly GovLink[]> {
  if (reliable) return links;
  try {
    const stored = [...(await store.surveyGovLinks(0)).values()].flat();
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
