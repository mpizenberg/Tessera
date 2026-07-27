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

import { isSurveyTalliable, type SurveyDefinition } from "../index.js";

import { refKey, responseCounts } from "./dedupe.js";
import type {
  CancellationRecord,
  ChainTip,
  Cip179Records,
  GovLink,
  SurveyRecord,
} from "./records.js";
import { cancellationVerified } from "./cancellation.js";

// The dedupe rule and its identity keys live in `./dedupe` (the server's
// per-survey `responseCount` calls the same code); re-exported here so
// importers of this module keep working.
export { refKey, credentialKey, dedupeResponses } from "./dedupe.js";

export type SurveyStatus = "active" | "ended" | "cancelled";

export interface SurveyAggregate {
  readonly key: string;
  readonly record: SurveyRecord;
  readonly status: SurveyStatus;
  /** Sealed (commit-reveal) survey — answers stay encrypted until reveal. */
  readonly sealed: boolean;
  /** External-content survey — presentation text lives off-chain (key 8). */
  readonly external: boolean;
  /**
   * Whether the on-chain definition is spec-valid enough to tally: no
   * error-severity {@link import("../index.js").validateDefinition} problem —
   * spec_version 5, non-empty roles, ≥1 question, in-bounds constraints (findings
   * 10, 11). `false` = untalliable: the emitter writes no artifact, the UI badges
   * it and blocks responding (answering it would waste a fee on a survey no
   * conformant reader tallies). Duplicate roles are a SHOULD (warning) and stay
   * talliable.
   */
  readonly talliable: boolean;
  /**
   * Epoch-aligned governance actions linking this survey (any action kind —
   * CIP-179 v5). Empty when standalone; a survey MAY be linked by several
   * actions, each independently able to bind a mechanism-B vote.
   */
  readonly govLinks: readonly GovLink[];
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

/**
 * Lifecycle from the chain tip alone, ignoring cancellation. Responses are
 * accepted through `endEpoch` **inclusive**, so a survey is `"ended"` only once
 * the tip has moved *past* it. Callers fold in cancellation separately: the
 * aggregate via {@link statusOf}, an embedding host via its own cancellation
 * flag (it has only the definition's `endEpoch` and a chain-tip epoch, not the
 * full records snapshot the aggregate needs).
 */
export function surveyStatus(
  endEpoch: number,
  tipEpoch: number,
): "active" | "ended" {
  return tipEpoch > endEpoch ? "ended" : "active";
}

function statusOf(
  endEpoch: number,
  cancelled: boolean,
  tipEpoch: number,
): SurveyStatus {
  if (cancelled) return "cancelled";
  return surveyStatus(endEpoch, tipEpoch);
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
 * Per-survey cancellation state, keyed by survey ref. A cancellation counts
 * only when it lands within the survey's window (`epochNo ≤ end_epoch`); a
 * later one is invalid per CIP-179 §6.3 and ignored.
 *
 * `verified` (owner-proven, CIP-179 mechanism A) is only ever assigned while
 * the survey is **still open** (tip at/before `end_epoch`): the scan fetches
 * owner-proofs only for open surveys — closed ones ride with `proof: null` — so
 * a closed survey's cancellation can never verify here. A closed survey's
 * *verified* cancellation is instead carried by an application's
 * finalized-cancelled overlay (derived from the emitted tally artifact), fed
 * through {@link aggregate}'s `finalizedCancelled` argument.
 *
 * An in-window cancellation that isn't (or can't be) verified surfaces as a
 * `claimed` state — **including for closed surveys**, so the "unverified
 * cancellation claim" warning stays visible after close (finding 6) instead of
 * silently vanishing. `verified` always wins over `claimed`. Surveys with no
 * in-window cancellation are absent from the map.
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
    if (c.epochNo > def.endEpoch) continue; // after the window — invalid (§6.3)
    // Verification is attempted only while the survey is open; a closed
    // survey's cancellation ships with `proof: null` (see above), so it can
    // only ever reach the `claimed` branch here, never `verified`.
    if (tip.epoch <= def.endEpoch && cancellationVerified(def.owner, c.proof)) {
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
 * Build per-survey aggregates from already-deduped response counts (keyed by
 * survey ref) rather than raw responses — the shape a paged/served survey list
 * provides. Uses the same cancellation and lifecycle rules as
 * {@link aggregateSurveys}, so both agree on the numbers.
 *
 * `finalizedCancelled` carries owner-verified cancellations of *closed* surveys
 * that client-side proof-checking can no longer confirm (see
 * {@link cancellationStates}); pass the survey keys an application finalized as
 * cancelled, or omit for pure client-side aggregation.
 */
export function aggregate(
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

  // Index links by survey key; a survey is "linked" only by actions whose
  // expiry epoch exactly equals the survey's end_epoch (the CIP invariant).
  // Several actions may satisfy that for the same survey (CIP-179 v5).
  const linksByKey = new Map<string, GovLink[]>();
  for (const link of govLinks) {
    const list = linksByKey.get(link.surveyKey);
    if (list) list.push(link);
    else linksByKey.set(link.surveyKey, [link]);
  }

  return surveys.map((record) => {
    const key = refKey(record.ref);
    const cancelState = cancelStates.get(key);
    // Two ways to be cancelled: a client-verified in-window cancellation (only
    // reachable while the survey is open — see `cancellationStates`), or the
    // serving tier's finalized-cancelled overlay, which carries that state past
    // close (the artifact records the cancellation; finding 19).
    const cancelled = cancelState === "verified" || finalizedCancelled.has(key);
    const govLinks = (linksByKey.get(key) ?? []).filter(
      (link) => link.endEpoch === record.definition.endEpoch,
    );
    return {
      key,
      record,
      cancelled,
      // A cancellation carried by the finalized-cancelled overlay (or verified
      // while open) is already reflected in `cancelled`; only surface the
      // "unverified claim" warning when the survey isn't otherwise cancelled.
      cancellationClaimed: !cancelled && cancelState === "claimed",
      sealed: record.definition.submissionMode.type === "sealed",
      external: record.definition.contentAnchor !== undefined,
      talliable: isSurveyTalliable(record),
      govLinks,
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
