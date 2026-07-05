/**
 * Build the materialized `survey_index` rows from a freshly fetched snapshot —
 * the refresh-time half of the paged Explore list. Aggregation (verified
 * cancellations, epoch-aligned governance links, deduped response counts)
 * reuses the exact core domain code the app runs, so a row's flags always
 * agree with what a client would derive from the full payload.
 */

import {
  aggregateSurveyList,
  credentialKey,
  refKey,
  responseCounts,
  surveyHaystack,
  toJsonSafe,
} from "@tessera/core";
import type {
  CancellationRecord,
  ChainTip,
  Cip179Records,
  GovLink,
} from "@tessera/core";

import type { SurveyIndexRow } from "./store";

export function buildSurveyIndex(
  records: Cip179Records,
  tip: ChainTip,
  govLinks: readonly GovLink[],
  finalizedCancelled: ReadonlySet<string>,
): SurveyIndexRow[] {
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

  return aggregates.map((a) => ({
    surveyKey: a.key,
    slot: a.record.slot,
    endEpoch: a.record.definition.endEpoch,
    sealed: a.sealed,
    cancelled: a.cancelled,
    govLinked: a.govLink !== null,
    owner: credentialKey(a.record.definition.owner),
    haystack: surveyHaystack(a.record, a.govLink),
    record: JSON.stringify(toJsonSafe(a.record)),
    cancellations: JSON.stringify(
      toJsonSafe(cancellationsByKey.get(a.key) ?? []),
    ),
    govLinks: JSON.stringify(toJsonSafe(linksByKey.get(a.key) ?? [])),
    responseCount: a.responseCount,
    finalizedCancelled: finalizedCancelled.has(a.key),
  }));
}
