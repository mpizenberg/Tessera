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

/** A single excluded response, tagged with why it wasn't counted. */
export interface ExcludedRecord {
  readonly key: ExclusionKey;
  readonly record: ResponseRecord;
}

export interface ResponseAudit {
  /** Valid, deduped responses — the set to tally. */
  readonly counted: ResponseRecord[];
  /**
   * The excluded records, each tagged with its reason — the single source of
   * truth for the exclusion breakdown. A UI groups these by key for a count
   * summary and per-response drill-down (CSV export). `undecryptable` is not
   * produced here (it's only knowable after reveal — appended UI-side).
   */
  readonly excludedRecords: readonly ExcludedRecord[];
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
  const excludedRecords: ExcludedRecord[] = [];
  for (const r of raw) {
    if (epochOfSlot(r.slot, tip, secondsPerEpoch) > endEpoch)
      excludedRecords.push({ key: "after-deadline", record: r });
    else onTime.push(r);
  }
  const counted = dedupeResponses(onTime);
  // `counted` holds references drawn from `onTime`; the leftovers are exactly
  // the superseded responses (an earlier entry beaten by a later latest-wins).
  // Appended after the late ones, so the breakdown reads deadline-then-superseded.
  const countedSet = new Set(counted);
  for (const r of onTime)
    if (!countedSet.has(r))
      excludedRecords.push({ key: "superseded", record: r });

  return { counted, excludedRecords };
}
