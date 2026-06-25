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

import type { Credential, SurveyRef } from "cip-179";

import { bytesToHex } from "~/util/hex";
import type {
  CancellationRecord,
  ChainTip,
  Cip179Records,
  GovLink,
  ResponseRecord,
  SurveyRecord,
} from "~/data/source";

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
  readonly cancelled: boolean;
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

/** Build per-survey aggregates from a full records snapshot. */
export function aggregateSurveys(
  records: Cip179Records,
  tip: ChainTip,
  govLinks: readonly GovLink[] = [],
): SurveyAggregate[] {
  // TODO(cancellation-verification): this honors *any* cancellation record that
  // references the survey, with NO owner-proof check — so currently any actor
  // can publish a label-17 cancellation for any survey and have this client
  // render it as authoritatively `cancelled` (which also blocks responding: a
  // suppression/griefing vector). We can't verify owner-proof from metadata
  // alone; it needs the cancelling tx's required_signers/witnesses vs.
  // `record.definition.owner`. Fix later by either (a) a semantic indexer that
  // confirms the owner credential signed, or (b) an extra Koios /tx_info lookup
  // per cancelling tx here. Until then this is knowingly unverified.
  const cancelledKeys = new Set(
    records.cancellations.map((c: CancellationRecord) => refKey(c.target)),
  );

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
    const cancelled = cancelledKeys.has(key);
    const link = linkByKey.get(key);
    const govLink =
      link && link.endEpoch === record.definition.endEpoch ? link : null;
    return {
      key,
      record,
      cancelled,
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
  const cancelled = new Set(
    records.cancellations.map((c: CancellationRecord) => refKey(c.target)),
  );
  let oldestSlot = Infinity;
  for (const s of records.surveys) {
    // Active = not cancelled and not past its end epoch (responses accepted
    // through end_epoch inclusive, mirroring `statusOf`).
    if (cancelled.has(refKey(s.ref))) continue;
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
