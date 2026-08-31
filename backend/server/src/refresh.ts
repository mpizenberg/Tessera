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
  finalStateEntries,
  OPERATIONAL_RETENTION_SECONDS,
  REFRESH_LEASE_SECONDS,
  snapshotTip,
  sumUpstream,
  type BackendStore,
  type BankedListCounts,
  type ScanCursor,
  type ScanState,
  type SlotRange,
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

/**
 * Listing pages the drift-healing rescan spends per run. One page rotates ~100
 * settled txs back through the same integration, so the whole settled prefix
 * is re-derived every corpus/100 refreshes — hours, at a three-minute cadence,
 * for any corpus this design expects. The cost is one listing call: its
 * metadata reads are cache hits, and re-deriving a row that never moved
 * changes nothing.
 */
const TRICKLE_PAGE_BUDGET = 1;

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
  /**
   * The settlement horizon: the margin below the banked cursor. No main
   * segment of this run or any later one reaches below it — a caught-up run
   * re-derives from here, a catch-up continuation from above the cursor —
   * so a per-survey aggregate over the rows below it is frozen and may be
   * banked as of this slot. Only the drift-healing rescan walks below it,
   * and it recounts what it touches from scratch.
   */
  readonly settledBelowSlot: number;
}

export function planSegment(
  state: ScanState | null,
  floorSlot: number,
): SegmentPlan {
  const cursor = state?.cursor ?? null;
  if (cursor === null)
    return {
      from: { slot: floorSlot },
      sweepFromSlot: floorSlot,
      settledBelowSlot: floorSlot,
    };
  const settledBelowSlot = Math.max(
    floorSlot,
    cursor.slot - SETTLEMENT_MARGIN_SLOTS,
  );
  if (state!.caughtUp) {
    return {
      from: { slot: settledBelowSlot },
      sweepFromSlot: settledBelowSlot,
      settledBelowSlot,
    };
  }
  return {
    from: { slot: cursor.slot, txHash: cursor.txHash },
    sweepFromSlot: cursor.slot + 1,
    settledBelowSlot,
  };
}

/**
 * The slot range this scan safely covered — the sweep's deletion scope — or
 * null when nothing may be swept: an incomplete scan (an unfetched tx is
 * indistinguishable from a vanished one), or a budget-capped walk whose last
 * listed slot may hold further unlisted txs (the covered prefix then ends one
 * slot earlier; a range that inverts covers nothing). `ceilingSlot` is what an
 * exhausted walk reached: the tip for the main segment, the top of the settled
 * prefix for the rescan.
 */
export function coveredRange(
  plan: Pick<SegmentPlan, "sweepFromSlot">,
  scan: SegmentScan,
  ceilingSlot: number,
): SlotRange | null {
  if (scan.records.incomplete) return null;
  const toSlot = scan.exhausted ? ceilingSlot : scan.cursor!.slot - 1;
  if (toSlot < plan.sweepFromSlot) return null;
  return { fromSlot: plan.sweepFromSlot, toSlot };
}

/** Where the drift-healing rescan resumes, with the ceiling it stops at. */
export interface TricklePlan extends Omit<SegmentPlan, "settledBelowSlot"> {
  /** Inclusive slot ceiling: the top of the settled prefix. */
  readonly toSlot: number;
}

/**
 * One rotation step of the drift-healing rescan, or null when there is nothing
 * to rescan. `plan` is the main segment of the same run.
 *
 * It walks the *settled prefix*: below the settlement margin, so nothing it
 * lists can still move on chain, and below whatever the run's own segment
 * swept, so two integrations of one refresh never both claim a slot. Only a
 * caught-up walk has such a prefix at all — while catching up, every page of
 * budget belongs to the main segment, and its cursor has not yet reached the
 * tip that makes anything settled.
 *
 * A null trickle cursor starts the rotation at the config floor; otherwise it
 * continues strictly after the banked pair (an inclusive floor would re-list
 * the same page forever). Advancing past the ceiling wraps back to null, which
 * is what makes drift heal without operator discipline: every settled row is
 * re-derived, in order, over and over.
 */
export function planTrickle(
  state: ScanState,
  plan: Pick<SegmentPlan, "sweepFromSlot">,
  floorSlot: number,
): TricklePlan | null {
  if (state.cursor === null || !state.caughtUp) return null;
  const toSlot =
    Math.min(
      plan.sweepFromSlot,
      Math.max(floorSlot, state.cursor.slot - SETTLEMENT_MARGIN_SLOTS),
    ) - 1;
  if (toSlot < floorSlot) return null;
  const from = state.trickle;
  return from === null
    ? { from: { slot: floorSlot }, sweepFromSlot: floorSlot, toSlot }
    : {
        from: { slot: from.slot, txHash: from.txHash },
        sweepFromSlot: from.slot + 1,
        toSlot,
      };
}

/**
 * Where the rotation stands after a rescan: on from the last row listed, back
 * to the start once the settled prefix is exhausted, or unmoved when the scan
 * was incomplete — an unfetched tx is indistinguishable from a vanished one,
 * and rotating past it would skip the very row this pass came to check.
 */
export function nextTrickle(
  scan: SegmentScan,
  current: ScanCursor | null,
): ScanCursor | null {
  if (scan.records.incomplete === true) return current;
  return scan.exhausted ? null : scan.cursor;
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

    const bank = await store.scanState();
    const banked = bank.walker;
    // The one check no later step can make: every row below is a mirror of
    // whatever chain the cursor was walked on, and a run configured for
    // another would list that chain, integrate its records and sweep the real
    // ones away as rolled back.
    if (banked?.network != null && banked.network !== config.app.network)
      throw new Error(
        `store is banked for ${banked.network}, config names ${config.app.network}`,
      );
    const rewound = banked !== null && banked.generation !== SCAN_GENERATION;
    if (rewound) {
      console.log(
        `scan generation ${banked.generation} → ${SCAN_GENERATION}: rewinding to the config floor`,
      );
      // Finalization's frontier summarizes what the *previous* derivation
      // decided. Rewinding without dropping it would leave every survey below
      // it — including any this deploy judges differently — outside the
      // candidate read for good.
      await store.putFinalizationFloor(0);
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

    // The epoch set: stored surveys from the settlement horizon up, plus this
    // segment's, so a survey first seen this run links in the same run. Below
    // the horizon every epoch is decided and its links already live in the
    // rows they were projected into, so the pass never asks again.
    const govFloor = bank.settlementFloor;
    const govEpochs = [
      ...new Set([
        ...(await store.surveyEndEpochs(Math.max(0, govFloor - 1))),
        ...records.surveys.map((s) => s.definition.endEpoch),
      ]),
    ];
    const {
      links: govLinks,
      unresolved: govUnresolved,
      floor: nextGovFloor,
    } = await refreshGovLinks(
      store,
      source,
      govEpochs,
      tip.epoch,
      startedAt,
      govFloor,
      { onRequest: meter.hook("anchor") },
    ).catch((err) => {
      console.warn(`gov links fetch failed: ${String(err)}`);
      govLinksReliable = false;
      return { links: [], unresolved: [], floor: govFloor };
    });

    // Integrate BEFORE the consumers run, so validation, finalization and the
    // proof-cache prune all see this run's corpus. This run's own
    // finalizations land through the targeted overlay update below.
    const range = coveredRange(plan, scan, tip.slot);
    const incomplete = records.incomplete === true || !scan.exhausted;
    const meta = {
      tip: JSON.stringify(toJsonSafe(tip)),
      incomplete,
      // Stamped with the scan's start, not this write: `tip` was read then, so
      // the pair describes one instant, and age counts from when the data was
      // true rather than from when it happened to land.
      fetchedAt: startedAt,
      listCounts: previous?.listCounts ?? null,
    };
    const integration = await integrateSegment(store, source, {
      records,
      range,
      tip,
      // A failed pass makes every row its own link source, which is both the
      // display fallback (an unread set published as "none" would blank the
      // linkage everywhere) and the honest one: nothing was re-read, so
      // nothing may change.
      govPass: govLinksReliable
        ? { links: govLinks, scope: new Set(govEpochs), floor: govFloor }
        : null,
      settledBelowSlot: plan.settledBelowSlot,
      meta,
    });
    let rowChanges = integration.changes;

    // Bank the cursors only after their segments are reconciled: a banked
    // cursor past unreconciled slots would settle a gap in for good, while a
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
      let next: ScanState = {
        cursor,
        caughtUp: scan.exhausted,
        generation: SCAN_GENERATION,
        network: config.app.network,
        // A rewind nulls the whole banked state, so the rotation restarts at
        // the config floor with the walk it heals behind.
        trickle: state?.trickle ?? null,
      };

      // The drift-healing rescan: one page of the settled prefix per run,
      // rotating oldest→newest through the same integration. It asks the
      // governance pass nothing — the main integration already wrote whatever
      // moved — so a settled row it re-derives is byte-identical unless the
      // stored one had drifted, which is the whole point. Best-effort: the
      // run's own segment is already banked either way.
      const rotation = planTrickle(next, plan, floorSlot);
      if (rotation !== null) {
        try {
          const rescan = await source.fetchSegment(
            {
              from: rotation.from,
              toSlot: rotation.toSlot,
              pageBudget: TRICKLE_PAGE_BUDGET,
            },
            tip,
          );
          const healed = await integrateSegment(store, source, {
            records: rescan.records,
            range: coveredRange(rotation, rescan, rotation.toSlot),
            tip,
            govPass: null,
            settledBelowSlot: plan.settledBelowSlot,
            meta,
          });
          rowChanges += healed.changes;
          if (healed.changes > 0) {
            console.log(
              `rescan healed ${healed.changes} row change(s) at or below slot ${rotation.toSlot}`,
            );
          }
          next = { ...next, trickle: nextTrickle(rescan, next.trickle) };
        } catch (err) {
          console.warn(`rescan failed (will retry): ${String(err)}`);
        }
      }
      await store.putScanState(next);
    }
    // Same ordering rule for the settlement frontier: the rows carrying the
    // links this pass settled are written, so the epochs behind it can leave
    // the query set for good.
    if (nextGovFloor !== govFloor) await store.putSettlementFloor(nextGovFloor);
    // The instant the integrated prefix reaches, on the chain's own clock —
    // finalization's safety gate during catch-up.
    const coveredThroughUnix =
      cursor === null ? null : tip.time + (cursor.slot - tip.slot);

    // Response validation (TALLY-SPEC §3) rides the same refresh (Node loop +
    // Worker cron alike): incremental, so already-validated responses cost
    // nothing. Best-effort — the rows above are already stored either way.
    const finalFloor = rewound ? 0 : bank.finalizationFloor;
    await validateNewResponses(
      store,
      records.responses,
      source,
      finalFloor,
      govLinksReliable,
      govUnresolved,
    ).catch((err) =>
      console.warn(`response validation failed (will retry): ${String(err)}`),
    );

    // Finalization (ARCHITECTURE §6.2) runs on freshly validated state: weight
    // snapshotting + artifact emission for safely-closed surveys. Idempotent and
    // resumable, so a failure here just retries next refresh.
    const finalized = await finalizeClosedSurveys(
      config,
      store,
      new KoiosTallyInputs(config.app, undefined, countKoios),
      source,
      {
        tip,
        incomplete,
        coveredThroughUnix,
        settlementFloor: nextGovFloor,
        finalizationFloor: finalFloor,
      },
    ).catch((err) => {
      console.warn(`finalization failed (will retry): ${String(err)}`);
      return null;
    });
    if (finalized?.floor != null && finalized.floor !== finalFloor) {
      await store.putFinalizationFloor(finalized.floor);
    }

    // What the pass decided lands on the survey rows in the same run. A pass
    // that died between deciding and this stamp leaves the row to integration,
    // which re-derives the state from the ground-truth tables whenever the
    // survey is next touched — and a closed survey still flagged `cancelled`
    // without a decided state is touched on every run until then.
    const overlayChanges = finalized
      ? await store
          .markFinalStates(finalStateEntries(finalized.emitted))
          .catch((err) => {
            console.warn(`final-state overlay update failed: ${String(err)}`);
            return 0;
          })
      : 0;

    // After finalization, so a survey that just froze its artifact releases its
    // transactions in the same run rather than a refresh later. Best-effort: a
    // cache that keeps too much is only a cache that costs storage.
    await pruneTxProofCache(store, incomplete, tip).catch((err) =>
      console.warn(`tx proof cache prune failed: ${String(err)}`),
    );

    // Banked chip counts move only when rows changed or the epoch turned, so
    // recompute the aggregate only then; every other run republishes the
    // previous counts with this run's freshness (already done above).
    const previousEpoch = previous ? snapshotTip(previous).epoch : null;
    if (
      rowChanges > 0 ||
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
      `refresh ok: ${rowChanges} row changes, ${summary}, ` +
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
