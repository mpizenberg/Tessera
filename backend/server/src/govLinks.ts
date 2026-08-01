/**
 * Governance links for one refresh: fetch-once anchor resolution, and per-epoch
 * settlement.
 *
 * Two on-chain facts carry this whole design:
 *
 *  - **An anchor is hash-fixed.** A document that verifies against the hash a
 *    proposal committed to is that proposal's document forever, so one verified
 *    fetch classifies it permanently. Banked (`gov_anchor`), never re-fetched.
 *  - **A proposal's expiration epoch is in the future when it is proposed.** So
 *    once the tip reaches epoch X, the set of proposals expiring at X is frozen
 *    and its link set can be decided once and for all (`gov_epoch`).
 *
 * Settling epochs is what keeps this bounded: a settled epoch leaves the Koios
 * query filter and its anchors leave the bank, so the whole pass costs O(active
 * surveys) rather than growing with every survey ever run.
 *
 * Settlement waits for every anchor at the epoch to resolve, but not forever:
 * most anchors in the wild are permanently dead, and a fetch failure is not
 * evidence of absence, so *something* has to end the wait. After
 * {@link SETTLEMENT_PATIENCE_EPOCHS} the epoch settles with the links it has and
 * the rest recorded as given up. Without that bound a single dead anchor at a
 * survey's end epoch postpones that survey's artifact permanently: validation
 * holds a bindable verdict at "unknown" while an epoch-aligned action is
 * unresolved (finding 6), and finalization postpones on any unknown verdict.
 */

import {
  govLinkScan,
  resolveGovAnchors,
  type GovProposal,
  type KoiosDataSource,
  type ResolveAnchorsOptions,
} from "cardano-tessera-koios";
import type { GovLink, GovLinkDoc, GovLinkScan } from "cip-179/domain";

import type { GovLinkStore, SettledGovEpoch } from "./store";

/**
 * Epochs past an expiration epoch we keep trying its unresolved anchors before
 * settling without them. One epoch is hundreds of attempts at a 3-minute
 * cadence — long past the point where a reachable document would have answered.
 */
export const SETTLEMENT_PATIENCE_EPOCHS = 1;

/**
 * Anchors one refresh may attempt. The cap is the Worker's per-invocation
 * subrequest budget, which the scan, validation and finalization also draw on —
 * and an `ipfs://` anchor can cost several requests on its own. Unattempted
 * anchors simply wait for the next cron, which is why the patience above is
 * counted in epochs rather than passes.
 */
export const ANCHOR_ATTEMPTS_PER_REFRESH = 6;

/**
 * The refresh's governance links: every link at a settled epoch, plus what this
 * pass could resolve at the unsettled ones — and the actions still unreadable
 * there, which are *unknown*, not unlinked (finding 6).
 *
 * Unresolved is local and monotone now: an action leaves that set when its
 * anchor resolves or its epoch settles, and never re-enters. A link this backend
 * has verified once cannot flicker back to unknown on a later refresh.
 */
export async function refreshGovLinks(
  store: GovLinkStore,
  source: Pick<KoiosDataSource, "fetchGovProposals">,
  endEpochs: readonly number[],
  tipEpoch: number,
  nowSec: number,
  opts: ResolveAnchorsOptions = {},
): Promise<GovLinkScan> {
  const expirations = [...new Set(endEpochs)]
    .map((e) => e + 1)
    .sort((a, b) => a - b);
  if (expirations.length === 0) return { links: [], unresolved: [] };

  const settled = await store.settledGovEpochs(expirations);
  const settledLinks = expirations.flatMap(
    (e) => settled.get(e)?.links ?? ([] as readonly GovLink[]),
  );
  const unsettled = expirations.filter((e) => !settled.has(e));
  // Every epoch already settled: the snapshot's links are all stored, and the
  // proposal endpoint is not touched at all.
  if (unsettled.length === 0) return { links: settledLinks, unresolved: [] };

  const proposals = await source.fetchGovProposals(unsettled.map((e) => e - 1));
  const banked = await store.cachedGovAnchors([
    ...new Set(proposals.map((p) => p.anchorHash)),
  ]);
  const fresh = await resolveGovAnchors(
    proposals.filter((p) => !banked.has(p.anchorHash)),
    { ...opts, limit: opts.limit ?? ANCHOR_ATTEMPTS_PER_REFRESH },
  );
  await store.putGovAnchors(fresh);

  const docs = new Map<string, GovLinkDoc | null>([...banked, ...fresh]);
  const scan = govLinkScan(proposals, docs);

  const settledNow = await settleEpochs(
    store,
    unsettled,
    proposals,
    docs,
    scan.links,
    tipEpoch,
    nowSec,
  );

  return {
    links: [...settledLinks, ...scan.links],
    // An action at an epoch that just settled is no longer unknown: the epoch
    // decided, and every verdict waiting on it can now be frozen.
    unresolved: scan.unresolved.filter((u) => !settledNow.has(u.endEpoch + 1)),
  };
}

/**
 * Settle every eligible expiration epoch, prune the anchors only those epochs
 * needed, and return the epochs settled. An epoch is eligible once the tip has
 * reached it (its proposal set is frozen) and settles when nothing at it is
 * unresolved, or when patience runs out.
 */
async function settleEpochs(
  store: GovLinkStore,
  unsettled: readonly number[],
  proposals: readonly GovProposal[],
  docs: ReadonlyMap<string, GovLinkDoc | null>,
  links: readonly GovLink[],
  tipEpoch: number,
  nowSec: number,
): Promise<Set<number>> {
  const settling: SettledGovEpoch[] = [];
  for (const expiration of unsettled) {
    if (tipEpoch < expiration) continue; // proposals can still land at it
    const gaveUp = proposals
      .filter((p) => p.endEpoch + 1 === expiration && !docs.has(p.anchorHash))
      .map((p) => p.actionId);
    if (
      gaveUp.length > 0 &&
      tipEpoch < expiration + SETTLEMENT_PATIENCE_EPOCHS
    ) {
      continue; // still worth asking
    }
    settling.push({
      expiration,
      links: links.filter((l) => l.endEpoch + 1 === expiration),
      gaveUp,
      settledAt: nowSec,
    });
  }
  const settledNow = new Set(settling.map((e) => e.expiration));
  if (settledNow.size === 0) return settledNow;

  // Prune BEFORE recording the settlements. A settled epoch is never queried
  // again, so this pass is the last moment its anchors are in hand — and a bank
  // that only ever grows is the linear cost this design exists to remove. In
  // this order a run that dies mid-way leaves the epoch unsettled with an empty
  // bank, which the next refresh re-fetches; the other order would leave banked
  // anchors nothing ever revisits. Anchors shared with an epoch still unsettled
  // stay: over-deleting costs a re-fetch, under-deleting is permanent.
  const stillNeeded = new Set(
    proposals
      .filter((p) => !settledNow.has(p.endEpoch + 1))
      .map((p) => p.anchorHash),
  );
  const droppable = [
    ...new Set(
      proposals
        .filter((p) => settledNow.has(p.endEpoch + 1))
        .map((p) => p.anchorHash),
    ),
  ].filter((hash) => !stillNeeded.has(hash));
  await store.deleteGovAnchors(droppable);

  for (const epoch of settling) {
    await store.putSettledGovEpoch(epoch);
    if (epoch.gaveUp.length > 0) {
      console.log(
        `gov epoch ${epoch.expiration} settled with ${epoch.gaveUp.length} unresolved anchor(s) given up`,
      );
    }
  }
  console.log(
    `gov links: settled epoch(s) ${[...settledNow].join(", ")}, ` +
      `pruned ${droppable.length} banked anchor(s)`,
  );
  return settledNow;
}
