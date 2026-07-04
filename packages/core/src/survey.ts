/**
 * Pure domain layer: turns raw on-chain records into the aggregates the UI
 * renders. No framework, no I/O — unit-testable in isolation.
 *
 * Scope note: this is read-side aggregation only. Anything needing ledger
 * state (credential proofs, role membership, owner-verified cancellation) is
 * deliberately out of scope here — it belongs to a future indexer. A
 * cancellation is treated as effective if it merely *references* the survey;
 * the indexer will later confirm it proved the owner credential.
 */

import type { SurveyDefinition } from "cip-179";

import { refKey, responseCounts } from "./dedupe";
import type {
  CancellationRecord,
  ChainTip,
  Cip179Records,
  GovLink,
  SurveyListPayload,
  SurveyRecord,
} from "./source";
import { cancellationVerified } from "./cancellation";

// The dedupe rule and its identity keys live in `./dedupe` (the server's
// per-survey `responseCount` calls the same code); re-exported here so
// importers of this module keep working.
export { refKey, credentialKey, dedupeResponses } from "./dedupe";

export type SurveyStatus = "active" | "ended" | "cancelled";

export interface SurveyAggregate {
  readonly key: string;
  readonly record: SurveyRecord;
  readonly status: SurveyStatus;
  /** Sealed (commit-reveal) survey — answers stay encrypted until reveal. */
  readonly sealed: boolean;
  /** External-content survey — presentation text lives off-chain (key 8). */
  readonly external: boolean;
  /** Linking Info Action (epoch-aligned), or null if standalone. */
  readonly govLink: GovLink | null;
  /** Distinct responders, after latest-valid-wins dedup. */
  readonly responseCount: number;
  /**
   * Owner-verified, in-window cancellation: the cancelling tx proved the survey's
   * `owner` credential (CIP-179 mechanism A) — verified client-side while the
   * survey is open, or attested by the serving tier's finalized-cancelled
   * artifact after close. Only this makes a survey effectively cancelled
   * (`status: "cancelled"`, responding blocked).
   */
  readonly cancelled: boolean;
  /**
   * A cancellation referencing this survey exists but could NOT be verified as
   * the owner's (forgery/griefing, an unsupported owner type, or unfetchable
   * proof) — and there is no verified one. Surfaced as a warning; it does not
   * change status or block responding, so it can't be used to suppress a survey.
   */
  readonly cancellationClaimed: boolean;
}

function statusOf(
  endEpoch: number,
  cancelled: boolean,
  tipEpoch: number,
): SurveyStatus {
  if (cancelled) return "cancelled";
  // Responses are accepted through end_epoch inclusive.
  return tipEpoch > endEpoch ? "ended" : "active";
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
 * Unix deadline for accepting responses: responses are valid through `endEpoch`
 * inclusive, so the cutoff is the *start* of the next epoch. Post-Shelley slots
 * are 1s, so the current epoch began at `tip.time − tip.epochSlot` and each
 * epoch spans `secondsPerEpoch` seconds.
 */
export function voteDeadlineUnix(
  endEpoch: number,
  tip: ChainTip,
  secondsPerEpoch: number,
): number {
  const epochStartUnix = tip.time - tip.epochSlot;
  return epochStartUnix + (endEpoch + 1 - tip.epoch) * secondsPerEpoch;
}

/** Verified (owner-proven) vs. merely claimed (unverified) cancellation. */
export type CancellationState = "verified" | "claimed";

/**
 * Per-survey cancellation state, keyed by survey ref. A cancellation is only
 * considered while its target survey is **still open** (tip at/before the
 * survey's `end_epoch`): the scan only fetches owner-proofs for those (closed
 * ones ride with `proof: null`), so nothing here could verify a closed survey's
 * cancellation anyway — that case is covered by the serving tier's
 * finalized-cancelled overlay in {@link SurveyListPayload.finalizedCancelled},
 * derived from the emitted artifact. (The open-only rule also subsumes the
 * CIP-179 rule that a cancellation after `end_epoch` is invalid — for a
 * still-open survey, any cancellation already on chain is necessarily within
 * the window.) Among the considered cancellations an owner-proven one wins
 * (`verified`), otherwise the survey is `claimed` (unverified). Surveys with no
 * such cancellation are absent from the map.
 */
export function cancellationStates(
  records: Cip179Records,
  tip: ChainTip,
): Map<string, CancellationState> {
  const defByKey = new Map<string, SurveyDefinition>(
    records.surveys.map((s) => [refKey(s.ref), s.definition]),
  );
  const states = new Map<string, CancellationState>();
  for (const c of records.cancellations) {
    const key = refKey(c.target);
    const def = defByKey.get(key);
    if (!def) continue; // references an unknown survey — ignore
    if (tip.epoch > def.endEpoch) continue; // survey already closed — moot
    if (cancellationVerified(def.owner, c.proof)) {
      states.set(key, "verified");
    } else if (states.get(key) !== "verified") {
      states.set(key, "claimed");
    }
  }
  return states;
}

/** Build per-survey aggregates from a full records snapshot. */
export function aggregateSurveys(
  records: Cip179Records,
  tip: ChainTip,
  govLinks: readonly GovLink[] = [],
): SurveyAggregate[] {
  return aggregate(
    records.surveys,
    records.cancellations,
    responseCounts(records.responses),
    tip,
    govLinks,
  );
}

/**
 * Build per-survey aggregates from a `surveyList()` payload, whose response
 * counts the source already deduped — with the same core rule, so the numbers
 * match what {@link aggregateSurveys} computes from raw responses.
 */
export function aggregateSurveyList(
  list: SurveyListPayload,
): SurveyAggregate[] {
  return aggregate(
    list.surveys,
    list.cancellations,
    list.responseCounts,
    list.tip,
    list.govLinks,
    new Set(list.finalizedCancelled ?? []),
  );
}

function aggregate(
  surveys: readonly SurveyRecord[],
  cancellations: readonly CancellationRecord[],
  countByKey: Record<string, number>,
  tip: ChainTip,
  govLinks: readonly GovLink[],
  finalizedCancelled: ReadonlySet<string> = new Set(),
): SurveyAggregate[] {
  // A cancellation only takes effect when the cancelling tx proves the survey's
  // owner credential (CIP-179 mechanism A); unproven ones are surfaced as
  // unverified claims, never acted on — so they can't be used to suppress a
  // survey. See {@link cancellationStates} / {@link import("./cancellation")}.
  const cancelStates = cancellationStates(
    { surveys, responses: [], cancellations },
    tip,
  );

  // Index links by survey key; a survey is "linked" only when the action's
  // voting end epoch exactly equals the survey's end_epoch (the CIP invariant).
  const linkByKey = new Map<string, GovLink>();
  for (const link of govLinks) linkByKey.set(link.surveyKey, link);

  return surveys.map((record) => {
    const key = refKey(record.ref);
    const cancelState = cancelStates.get(key);
    // Two ways to be cancelled: a client-verified in-window cancellation (only
    // reachable while the survey is open — see `cancellationStates`), or the
    // serving tier's finalized-cancelled overlay, which carries that state past
    // close (the artifact records the cancellation; finding 19).
    const cancelled =
      cancelState === "verified" || finalizedCancelled.has(key);
    const link = linkByKey.get(key);
    const govLink =
      link && link.endEpoch === record.definition.endEpoch ? link : null;
    return {
      key,
      record,
      cancelled,
      cancellationClaimed: cancelState === "claimed",
      sealed: record.definition.submissionMode.type === "sealed",
      external: record.definition.contentAnchor !== undefined,
      govLink,
      responseCount: countByKey[key] ?? 0,
      status: statusOf(record.definition.endEpoch, cancelled, tip.epoch),
    };
  });
}

/** Find one aggregate by its ref key (for the survey detail screen). */
export function findSurvey(
  aggregates: readonly SurveyAggregate[],
  key: string,
): SurveyAggregate | undefined {
  return aggregates.find((a) => a.key === key);
}
