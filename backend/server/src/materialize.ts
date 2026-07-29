/**
 * Turn a freshly fetched snapshot into the rows the serving routes read — the
 * refresh-time half of every snapshot-derived endpoint. Aggregation (verified
 * cancellations, epoch-aligned governance links, deduped response counts)
 * reuses the exact core domain code the app runs, so a row's flags always
 * agree with what a client would derive from the full payload.
 */

import {
  credentialKey,
  refKey,
  responseCounts,
  type CancellationRecord,
  type ChainTip,
  type Cip179Records,
  type GovLink,
} from "cip-179/domain";
import { toJsonSafe } from "cip-179/tally";
import { aggregateSurveyList, surveyHaystack } from "@tessera/core";

import type { ResponseRow, SurveyIndexRow } from "./store";

export interface MaterializedSnapshot {
  readonly surveys: SurveyIndexRow[];
  readonly responses: ResponseRow[];
}

export function materializeSnapshot(
  records: Cip179Records,
  tip: ChainTip,
  govLinks: readonly GovLink[],
  finalizedCancelled: ReadonlySet<string>,
): MaterializedSnapshot {
  const cancellationsByKey = new Map<string, CancellationRecord[]>();
  for (const c of records.cancellations) {
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

  const aggregates = aggregateSurveyList({
    surveys: records.surveys,
    cancellations: records.cancellations,
    govLinks,
    tip,
    responseCounts: responseCounts(records.responses),
    finalizedCancelled: [...finalizedCancelled],
  });

  return {
    surveys: aggregates.map((a) => ({
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
    })),
    responses: records.responses.map((r) => ({
      txHash: r.txHash,
      responseIndex: r.responseIndex,
      surveyKey: refKey(r.response.surveyRef),
      credential: credentialKey(r.response.credential),
      slot: r.slot,
      record: JSON.stringify(toJsonSafe(r)),
    })),
  };
}

/** Stored wire JSON across all rows — the refresh's growth metric. */
export function snapshotBytes(snapshot: MaterializedSnapshot): number {
  return (
    snapshot.surveys.reduce(
      (n, r) =>
        n + r.record.length + r.cancellations.length + r.govLinks.length,
      0,
    ) + snapshot.responses.reduce((n, r) => n + r.record.length, 0)
  );
}
