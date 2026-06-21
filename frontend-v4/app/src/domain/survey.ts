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
): SurveyAggregate[] {
  const cancelledKeys = new Set(
    records.cancellations.map((c: CancellationRecord) => refKey(c.target)),
  );

  const deduped = dedupeResponses(records.responses);
  const countByKey = new Map<string, number>();
  for (const r of deduped) {
    const k = refKey(r.response.surveyRef);
    countByKey.set(k, (countByKey.get(k) ?? 0) + 1);
  }

  return records.surveys.map((record) => {
    const key = refKey(record.ref);
    const cancelled = cancelledKeys.has(key);
    return {
      key,
      record,
      cancelled,
      sealed: record.definition.submissionMode.type === "sealed",
      responseCount: countByKey.get(key) ?? 0,
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
