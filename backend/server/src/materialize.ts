/**
 * Project on-chain records into the rows the serving routes read. The
 * per-record projections are shared by the runtime segment integration
 * (`integrate.ts`, applied per touched survey) and by `materializeSnapshot` —
 * the pure whole-corpus rebuild kept as the differential-test oracle:
 * windowed integration over any event sequence must leave exactly the rows a
 * full rebuild would produce. Aggregation (verified cancellations,
 * epoch-aligned governance links, deduped response counts) reuses the exact
 * core domain code the app runs, so a row's flags always agree with what a
 * client would derive from the full payload.
 */

import {
  aggregate,
  byCancellationChainOrder,
  credentialKey,
  refKey,
  responseCounts,
  type CancellationRecord,
  type ChainTip,
  type Cip179Records,
  type GovLink,
  type ResponseRecord,
  type SurveyRecord,
} from "cip-179/domain";
import { toJsonSafe } from "cip-179/tally";
import { surveyHaystack } from "cardano-tessera-core";

import type {
  BankedListCounts,
  CancellationRow,
  ResponseRow,
  SurveyIndexRow,
} from "./store";

export interface MaterializedSnapshot {
  readonly surveys: SurveyIndexRow[];
  readonly responses: ResponseRow[];
  readonly cancellations: CancellationRow[];
  /**
   * Credential-free chip counts over all rows, against this snapshot's tip —
   * what the refresh banks with the envelope so the list route serves them
   * without aggregating. Mirrors core `pageSurveyList`'s counts with no
   * search terms.
   */
  readonly listCounts: BankedListCounts;
}

/**
 * Project the given surveys' index rows from their full aggregation inputs:
 * each survey's definition record, every cancellation targeting it, its
 * deduped response count, and the current links/tip/overlay. Callers own the
 * scoping — the oracle passes the whole corpus, the segment integration
 * passes the touched surveys with their merged stored+segment inputs.
 */
export function surveyRowsOf(
  surveys: readonly SurveyRecord[],
  cancellations: readonly CancellationRecord[],
  countByKey: Record<string, number>,
  tip: ChainTip,
  govLinks: readonly GovLink[],
  finalizedCancelled: ReadonlySet<string>,
): SurveyIndexRow[] {
  // Grouped in chain order, so the projected JSON is identical whether the
  // inputs arrive in scan order (the oracle) or as stored-plus-segment merges
  // (the segment integration).
  const cancellationsByKey = new Map<string, CancellationRecord[]>();
  for (const c of [...cancellations].sort(byCancellationChainOrder)) {
    const key = refKey(c.target);
    const list = cancellationsByKey.get(key);
    if (list) list.push(c);
    else cancellationsByKey.set(key, [c]);
  }
  // All links naming the survey ride along (the client re-checks alignment
  // from the raw records, as it does today); the `govLinked` flag is the
  // verified (epoch-aligned) one the filters and section buckets use.
  const linksByKey = new Map<string, GovLink[]>();
  for (const l of govLinks) {
    const list = linksByKey.get(l.surveyKey);
    if (list) list.push(l);
    else linksByKey.set(l.surveyKey, [l]);
  }
  return aggregate(
    surveys,
    cancellations,
    countByKey,
    tip,
    govLinks,
    finalizedCancelled,
  ).map((a) => ({
    surveyKey: a.key,
    slot: a.record.slot,
    endEpoch: a.record.definition.endEpoch,
    sealed: a.sealed,
    cancelled: a.cancelled,
    govLinked: a.govLinks.length > 0,
    owner: credentialKey(a.record.definition.owner),
    haystack: surveyHaystack(a.record, a.govLinks),
    record: JSON.stringify(toJsonSafe(a.record)),
    cancellations: JSON.stringify(
      toJsonSafe(cancellationsByKey.get(a.key) ?? []),
    ),
    govLinks: JSON.stringify(toJsonSafe(linksByKey.get(a.key) ?? [])),
    responseCount: a.responseCount,
    finalizedCancelled: finalizedCancelled.has(a.key),
  }));
}

export const responseRowOf = (r: ResponseRecord): ResponseRow => ({
  txHash: r.txHash,
  responseIndex: r.responseIndex,
  surveyKey: refKey(r.response.surveyRef),
  credential: credentialKey(r.response.credential),
  slot: r.slot,
  record: JSON.stringify(toJsonSafe(r)),
});

export const cancellationRowOf = (c: CancellationRecord): CancellationRow => ({
  txHash: c.txHash,
  surveyKey: refKey(c.target),
  slot: c.slot,
  record: JSON.stringify(toJsonSafe(c)),
});

/** Chip counts over projected rows — the SQL aggregate's in-memory twin. */
export function listCountsOf(
  surveys: readonly SurveyIndexRow[],
  tipEpoch: number,
): BankedListCounts {
  const active = surveys.filter((r) => !r.cancelled && r.endEpoch >= tipEpoch);
  return {
    all: surveys.length,
    linked: surveys.filter((r) => r.govLinked).length,
    active: active.length,
    sealed: active.filter((r) => r.sealed).length,
    public: active.filter((r) => !r.sealed).length,
  };
}

export function materializeSnapshot(
  records: Cip179Records,
  tip: ChainTip,
  govLinks: readonly GovLink[],
  finalizedCancelled: ReadonlySet<string>,
): MaterializedSnapshot {
  const surveys = surveyRowsOf(
    records.surveys,
    records.cancellations,
    responseCounts(records.responses),
    tip,
    govLinks,
    finalizedCancelled,
  );
  return {
    listCounts: listCountsOf(surveys, tip.epoch),
    surveys,
    responses: records.responses.map(responseRowOf),
    cancellations: records.cancellations.map(cancellationRowOf),
  };
}
