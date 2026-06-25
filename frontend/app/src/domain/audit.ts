/**
 * Pure response audit: from the raw on-chain responses targeting one survey,
 * derive the *counted* set (valid + latest-wins) and a breakdown of the
 * exclusions provable from on-chain data alone.
 *
 * Detectable client-side (no indexer):
 *  - after-deadline — submitted past the survey's `end_epoch` (invalid window).
 *  - invalid        — fails codec validation against the on-chain definition
 *                     (out-of-constraint answer, duplicate/OOB indices,
 *                     ineligible role, missing required answer). On-chain data
 *                     is attacker-controllable, so a response can decode cleanly
 *                     yet violate the survey's rules — those must not be tallied.
 *  - superseded     — an earlier response for the same (role, credential),
 *                     replaced by a later valid one (latest-wins).
 *
 * Needs ledger state (NOT here — indexer-side): role *membership* re-checked at
 * the end_epoch snapshot (distinct from role *eligibility*, which is on-chain
 * and checked above), credential-proof failures. Those are deliberately absent
 * from this breakdown; the UI says so. Keeping the audit honest about what it
 * can and can't see avoids implying a completeness it doesn't have.
 */

import {
  validateResponse,
  type SurveyDefinition,
  type SurveyResponse,
} from "cip-179";

import type { ChainTip, ResponseRecord } from "~/data/source";
import { dedupeResponses, epochOfSlot } from "./survey";

// `epochOfSlot` now lives in ./survey (shared with cancellation-deadline logic);
// re-exported here so existing importers (and tests) keep their path.
export { epochOfSlot };

export type ExclusionKey =
  | "after-deadline"
  | "invalid"
  | "superseded"
  | "undecryptable";

/**
 * Whether a response may be counted against its survey: it passes the codec's
 * full {@link validateResponse} (correct submission mode, eligible role,
 * in-constraint answers with no duplicate/out-of-range indices, required
 * questions answered). This is the *same* validator the responder runs before
 * submitting — applied here to *others'* on-chain responses, which an attacker
 * can craft to decode cleanly yet break the survey's constraints (over-budget
 * points allocations, duplicate multi-select indices, out-of-range ratings).
 *
 * Sealed responses can only be checked structurally until their drand round
 * publishes; `validateResponse` passes them on mode + non-empty ciphertext, so
 * a sealed response stays counted (for participation) and its decrypted answers
 * are re-validated at reveal time.
 */
export function responseIsCountable(
  definition: SurveyDefinition,
  response: SurveyResponse,
): boolean {
  return validateResponse(definition, response).length === 0;
}

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
 * Audit the raw responses for one survey. Responses past the deadline are
 * dropped first (the invalid window), then those that fail codec validation
 * (out-of-constraint, ineligible role, …) as `invalid`; latest-valid-wins then
 * picks one per (role, credential) and the leftovers are `superseded`. Excluding
 * invalid responses *before* dedup is essential: otherwise a malformed later
 * response could suppress a valid earlier one. The `counted` set is exactly what
 * should be tallied, so a UI showing both stays consistent.
 */
export function auditResponses(
  raw: readonly ResponseRecord[],
  definition: SurveyDefinition,
  tip: ChainTip,
  secondsPerEpoch: number,
): ResponseAudit {
  const endEpoch = definition.endEpoch;
  const onTime: ResponseRecord[] = [];
  const excludedRecords: ExcludedRecord[] = [];
  for (const r of raw) {
    if (epochOfSlot(r.slot, tip, secondsPerEpoch) > endEpoch) {
      excludedRecords.push({ key: "after-deadline", record: r });
    } else if (!responseIsCountable(definition, r.response)) {
      excludedRecords.push({ key: "invalid", record: r });
    } else {
      onTime.push(r);
    }
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
