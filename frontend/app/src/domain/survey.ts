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

import type { Credential, SurveyDefinition, SurveyRef } from "cip-179";

import { bytesToHex } from "~/util/hex";
import type {
  ChainTip,
  Cip179Records,
  GovLink,
  ResponseRecord,
  SurveyRecord,
} from "~/data/source";
import { cancellationVerified } from "./cancellation";

/** Stable string identity for a survey reference: "<txHex>:<index>". */
export function refKey(ref: SurveyRef): string {
  return `${bytesToHex(ref.txId)}:${ref.index}`;
}

/** Stable identity for a responder credential. */
export function credentialKey(cred: Credential): string {
  return cred.type === "key"
    ? `key:${bytesToHex(cred.keyHash)}`
    : `script:${bytesToHex(cred.scriptHash)}`;
}

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
   * `owner` credential (CIP-179 mechanism A). Only this makes a survey
   * effectively cancelled (`status: "cancelled"`, responding blocked).
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
 * Latest-valid-wins: at most one response per (survey, role, credential),
 * keeping the one at the highest slot (ties broken by tx hash for determinism).
 */
export function dedupeResponses(
  responses: readonly ResponseRecord[],
): ResponseRecord[] {
  const best = new Map<string, ResponseRecord>();
  for (const r of responses) {
    const id =
      `${refKey(r.response.surveyRef)}|${r.response.role}|` +
      credentialKey(r.response.credential);
    const prev = best.get(id);
    if (
      !prev ||
      r.slot > prev.slot ||
      (r.slot === prev.slot && r.txHash > prev.txHash)
    ) {
      best.set(id, r);
    }
  }
  return [...best.values()];
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

/** Verified (owner-proven) vs. merely claimed (unverified) cancellation. */
export type CancellationState = "verified" | "claimed";

/**
 * Per-survey cancellation state, keyed by survey ref. A cancellation is only
 * considered while its target survey is **still open** (tip at/before the
 * survey's `end_epoch`): once a survey has ended it's closed regardless, so there
 * is nothing to suppress and no point distinguishing verified from claimed. (This
 * also subsumes the CIP-179 rule that a cancellation after `end_epoch` is invalid
 * — for a still-open survey, any cancellation already on chain is necessarily
 * within the window.) Among the considered cancellations an owner-proven one wins
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
  // A cancellation only takes effect when the cancelling tx proves the survey's
  // owner credential (CIP-179 mechanism A); unproven ones are surfaced as
  // unverified claims, never acted on — so they can't be used to suppress a
  // survey. See {@link cancellationStates} / {@link import("./cancellation")}.
  const cancelStates = cancellationStates(records, tip);

  // Index links by survey key; a survey is "linked" only when the action's
  // voting end epoch exactly equals the survey's end_epoch (the CIP invariant).
  const linkByKey = new Map<string, GovLink>();
  for (const link of govLinks) linkByKey.set(link.surveyKey, link);

  const deduped = dedupeResponses(records.responses);
  const countByKey = new Map<string, number>();
  for (const r of deduped) {
    const k = refKey(r.response.surveyRef);
    countByKey.set(k, (countByKey.get(k) ?? 0) + 1);
  }

  return records.surveys.map((record) => {
    const key = refKey(record.ref);
    const cancelState = cancelStates.get(key);
    const cancelled = cancelState === "verified";
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
      responseCount: countByKey.get(key) ?? 0,
      status: statusOf(record.definition.endEpoch, cancelled, tip.epoch),
    };
  });
}

/**
 * Unix-time floor for scanning governance actions: the on-chain creation time of
 * the **oldest still-active survey**. Linkage is Action → Survey (the action
 * points at an already-existing survey), so a linking Info Action can never
 * predate the survey it links to — actions older than our oldest active survey
 * can't link to any of them, and scanning them is just overload. Falls back to
 * `fallbackUnix` when no survey is currently active.
 *
 * Post-Shelley slots are 1s, so a survey's slot projects to wall-clock from the
 * tip (`tip.time − (tip.slot − slot)`), no per-network genesis math.
 */
export function governanceSinceUnix(
  records: Cip179Records,
  tip: ChainTip,
  fallbackUnix: number,
): number {
  // Only an owner-verified cancellation makes a survey inactive; an unverified
  // claim leaves it active (mirrors aggregateSurveys).
  const cancelStates = cancellationStates(records, tip);
  let oldestSlot = Infinity;
  for (const s of records.surveys) {
    // Active = not cancelled and not past its end epoch (responses accepted
    // through end_epoch inclusive, mirroring `statusOf`).
    if (cancelStates.get(refKey(s.ref)) === "verified") continue;
    if (s.definition.endEpoch < tip.epoch) continue;
    if (s.slot < oldestSlot) oldestSlot = s.slot;
  }
  if (!Number.isFinite(oldestSlot)) return fallbackUnix;
  return tip.time - (tip.slot - oldestSlot);
}

/** Find one aggregate by its ref key (for the survey detail screen). */
export function findSurvey(
  aggregates: readonly SurveyAggregate[],
  key: string,
): SurveyAggregate | undefined {
  return aggregates.find((a) => a.key === key);
}
