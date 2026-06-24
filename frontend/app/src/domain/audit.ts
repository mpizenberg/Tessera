/**
 * Pure response audit: from the raw on-chain responses targeting one survey,
 * derive the *counted* set (valid + latest-wins) and a breakdown of the
 * exclusions provable from on-chain data alone.
 *
 * Detectable client-side (no indexer):
 *  - after-deadline — submitted past the survey's `end_epoch` (invalid window).
 *  - superseded     — an earlier response for the same (role, credential),
 *                     replaced by a later valid one (latest-wins).
 *
 * Needs ledger state (NOT here — indexer-side): role membership re-checked at
 * the end_epoch snapshot, credential-proof failures. Those are deliberately
 * absent from this breakdown; the UI says so. Keeping the audit honest about
 * what it can and can't see avoids implying a completeness it doesn't have.
 */

import type { ChainTip, ResponseRecord } from "~/data/source";
import { dedupeResponses } from "./survey";

export type ExclusionKey = "after-deadline" | "superseded" | "undecryptable";

export interface ExclusionReason {
  readonly key: ExclusionKey;
  readonly label: string;
  readonly hint: string;
  readonly count: number;
}

export interface ResponseAudit {
  /** Valid, deduped responses — the set to tally. */
  readonly counted: ResponseRecord[];
  /** Non-empty exclusion categories, detectable from chain data alone. */
  readonly excluded: readonly ExclusionReason[];
  readonly excludedTotal: number;
}

/**
 * Estimate the epoch a past absolute slot fell in, from the tip. Post-Shelley
 * slots are 1s and an epoch spans `secondsPerEpoch` slots; the current epoch
 * started at `tip.slot − tip.epochSlot`. Constant epoch length is assumed going
 * back — exact for the recent window we index, a coarse estimate further back.
 */
export function epochOfSlot(
  slot: number,
  tip: ChainTip,
  secondsPerEpoch: number,
): number {
  const epochStartSlot = tip.slot - tip.epochSlot;
  if (slot >= epochStartSlot) return tip.epoch;
  const back = Math.ceil((epochStartSlot - slot) / secondsPerEpoch);
  return tip.epoch - back;
}

/**
 * Audit the raw responses for one survey. Responses past `endEpoch` are dropped
 * first (the invalid window), then latest-valid-wins picks one per (role,
 * credential); the leftovers are the two exclusion categories. The `counted`
 * set is exactly what should be tallied, so a UI showing both stays consistent.
 */
export function auditResponses(
  raw: readonly ResponseRecord[],
  endEpoch: number,
  tip: ChainTip,
  secondsPerEpoch: number,
): ResponseAudit {
  const onTime: ResponseRecord[] = [];
  let late = 0;
  for (const r of raw) {
    if (epochOfSlot(r.slot, tip, secondsPerEpoch) > endEpoch) late++;
    else onTime.push(r);
  }
  const counted = dedupeResponses(onTime);
  const superseded = onTime.length - counted.length;

  const excluded: ExclusionReason[] = [];
  if (late > 0) {
    excluded.push({
      key: "after-deadline",
      label: "Submitted after the deadline",
      hint: `recorded past end_epoch ${endEpoch}`,
      count: late,
    });
  }
  if (superseded > 0) {
    excluded.push({
      key: "superseded",
      label: "Superseded by a later response",
      hint: "same role + credential · latest-wins",
      count: superseded,
    });
  }
  return { counted, excluded, excludedTotal: late + superseded };
}
