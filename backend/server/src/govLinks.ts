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
 * query filter, its anchors leave the bank, and the banked settlement floor
 * rises past it so no later pass reads it out of the database either — its
 * links live on in the survey rows they were projected into. The whole pass
 * costs O(active surveys) rather than growing with every survey ever run.
 *
 * Settlement waits for every anchor at the epoch to resolve, but not forever:
 * most anchors in the wild are permanently dead, and a fetch failure is not
 * evidence of absence, so *something* has to end the wait. A failed fetch is
 * banked as a miss and retried on the backoff (`backoff.ts`); once an anchor's
 * attempts are used up and a last one {@link SETTLEMENT_PATIENCE_EPOCHS} past
 * its epoch fails too, the epoch settles with the links it has and that anchor
 * recorded as given up. Without that bound a single dead anchor at a
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

import { due, MAX_MISSES, type Misses } from "./backoff";
import type { GovLinkStore, SettledGovEpoch } from "./store";

/**
 * Epochs past an expiration epoch before an anchor still unresolved there is
 * asked one last time, once its attempts on the backoff are used up, and given
 * up if that fails too. The backoff's attempts end about a day after the
 * first, so this last one covers a document published later than that; and
 * counting attempts, not epochs alone, keeps a backend catching up on past
 * epochs from giving up anchors its first pass failed or never reached.
 */
export const SETTLEMENT_PATIENCE_EPOCHS = 1;

/** Whether an anchor's last attempt, past its patience, has failed as well. */
const givenUp = (m: Misses | undefined): boolean =>
  m !== undefined && m.misses > MAX_MISSES;

/**
 * Anchors one refresh may attempt, out of the Worker's per-invocation
 * subrequest budget that the scan, validation and finalization also draw on:
 * an `ipfs://` anchor races up to five gateways, so this is at most 100
 * requests of the 1,000. Anchors left over wait for a later refresh, and the
 * settlement of their epoch waits for them.
 */
export const ANCHOR_ATTEMPTS_PER_REFRESH = 20;

/** What one pass resolved, and where its settlement frontier now stands. */
export interface GovLinkPass extends GovLinkScan {
  /**
   * The floor to bank: the lowest expiration this pass left unsettled, so the
   * next one starts its query set there. Banked by the caller and only once
   * the rows this pass fed are reconciled — a floor that ran ahead of the rows
   * would freeze a survey's links at whatever its row happened to hold.
   */
  readonly floor: number;
}

/**
 * The refresh's governance links: every link at a settled epoch, plus what this
 * pass could resolve at the unsettled ones — and the actions still unreadable
 * there, which are *unknown*, not unlinked (finding 6).
 *
 * `endEpochs` is the caller's query set, and this pass's links are authoritative
 * for exactly those epochs; below the floor an epoch is decided for good and
 * each survey's own stored link slice is the copy every consumer reads.
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
  floor: number,
  opts: ResolveAnchorsOptions = {},
): Promise<GovLinkPass> {
  const expirations = [...new Set(endEpochs)]
    .map((e) => e + 1)
    .sort((a, b) => a - b);
  if (expirations.length === 0) return { links: [], unresolved: [], floor };

  const settled = await store.settledGovEpochs(expirations);
  const settledLinks = expirations.flatMap(
    (e) => settled.get(e)?.links ?? ([] as readonly GovLink[]),
  );
  const unsettled = expirations.filter((e) => !settled.has(e));
  // The frontier after this pass. Nothing unsettled left in the query set puts
  // it past the whole set — but never backwards, since everything below the
  // old floor is settled too; a query set that still holds an unsettled epoch
  // (a future one, or an old survey only just discovered) pins it there, which
  // may well be *below* where it stood.
  const nextFloor = (settledNow: ReadonlySet<number>): number => {
    const open = unsettled.filter((e) => !settledNow.has(e));
    return open.length > 0
      ? open[0]
      : Math.max(floor, expirations[expirations.length - 1] + 1);
  };
  // Every epoch already settled: the snapshot's links are all stored, and the
  // proposal endpoint is not touched at all.
  if (unsettled.length === 0)
    return {
      links: settledLinks,
      unresolved: [],
      floor: nextFloor(new Set()),
    };

  const proposals = await source.fetchGovProposals(unsettled.map((e) => e - 1));
  const hashes = [...new Set(proposals.map((p) => p.anchorHash))];
  const banked = await store.cachedGovAnchors(hashes);
  const unbanked = hashes.filter((h) => !banked.has(h));
  const misses = await store.govAnchorMisses(unbanked);
  const patient = (h: string) =>
    proposals.some(
      (p) =>
        p.anchorHash === h &&
        tipEpoch >= p.endEpoch + 1 + SETTLEMENT_PATIENCE_EPOCHS,
    );
  const worthAsking = (h: string) => {
    const m = misses.get(h);
    return (
      m === undefined ||
      due(m, nowSec) ||
      (m.misses === MAX_MISSES && patient(h))
    );
  };
  // Least recently attempted first, never attempted before all: an anchor that
  // failed backs off, so the ones queued behind it get their turn.
  const lastTry = (h: string) => misses.get(h)?.checkedAt ?? -Infinity;
  const attempting = unbanked
    .filter(worthAsking)
    .sort((a, b) => lastTry(a) - lastTry(b) || (a < b ? -1 : 1))
    .slice(0, ANCHOR_ATTEMPTS_PER_REFRESH);
  const window = new Set(attempting);
  const fresh = await resolveGovAnchors(
    proposals.filter((p) => window.has(p.anchorHash)),
    opts,
  );
  await store.putGovAnchors(fresh);
  const failed = attempting.filter((h) => !fresh.has(h));
  await store.putGovAnchorMisses(failed, nowSec);
  for (const h of failed)
    misses.set(h, {
      misses: (misses.get(h)?.misses ?? 0) + 1,
      checkedAt: nowSec,
    });

  const docs = new Map<string, GovLinkDoc | null>([...banked, ...fresh]);
  const scan = govLinkScan(proposals, docs);

  const settledNow = await settleEpochs(
    store,
    unsettled,
    proposals,
    docs,
    misses,
    scan.links,
    tipEpoch,
    nowSec,
  );

  return {
    links: [...settledLinks, ...scan.links],
    // An action at an epoch that just settled is no longer unknown: the epoch
    // decided, and every verdict waiting on it can now be frozen.
    unresolved: scan.unresolved.filter((u) => !settledNow.has(u.endEpoch + 1)),
    floor: nextFloor(settledNow),
  };
}

/**
 * Settle every eligible expiration epoch, prune the anchors only those epochs
 * needed, and return the epochs settled. An epoch is eligible once the tip has
 * reached it (its proposal set is frozen) and settles when every anchor at it
 * is resolved or given up.
 */
async function settleEpochs(
  store: GovLinkStore,
  unsettled: readonly number[],
  proposals: readonly GovProposal[],
  docs: ReadonlyMap<string, GovLinkDoc | null>,
  misses: ReadonlyMap<string, Misses>,
  links: readonly GovLink[],
  tipEpoch: number,
  nowSec: number,
): Promise<Set<number>> {
  const settling: SettledGovEpoch[] = [];
  for (const expiration of unsettled) {
    if (tipEpoch < expiration) continue; // proposals can still land at it
    const open = proposals.filter(
      (p) => p.endEpoch + 1 === expiration && !docs.has(p.anchorHash),
    );
    if (
      open.length > 0 &&
      (tipEpoch < expiration + SETTLEMENT_PATIENCE_EPOCHS ||
        !open.every((p) => givenUp(misses.get(p.anchorHash))))
    ) {
      continue;
    }
    const gaveUp = open.map((p) => p.actionId);
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
