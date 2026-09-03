/**
 * The Tessera adapter from a served `SurveyListPayload` to survey aggregates.
 *
 * `SurveyListPayload` is a Tessera seam shape (how the Explore list is served),
 * so this glue stays here rather than in the reusable `cip-179/domain` package.
 * It just decomposes the payload and defers to the pure `aggregate` primitive,
 * so the numbers match `aggregateSurveys` on raw records.
 */

import { aggregate, type SurveyAggregate } from "cip-179/domain";

import type { SurveyListPayload } from "cardano-tessera-client";

/**
 * Build per-survey aggregates from a `surveyList()` payload, whose response
 * counts the source already deduped — with the same core rule, so the numbers
 * match what `aggregateSurveys` computes from raw responses.
 */
export function aggregateSurveyList(
  list: SurveyListPayload,
): SurveyAggregate[] {
  // `aggregate` only needs the cancelled overlay: the other final states never
  // change how a survey aggregates, they only describe what finalization left.
  const cancelled = new Set(
    Object.entries(list.finalState ?? {})
      .filter(([, s]) => s.state === "cancelled")
      .map(([key]) => key),
  );
  return aggregate(
    list.surveys,
    list.cancellations,
    list.responseCounts,
    list.tip,
    list.govLinks,
    cancelled,
  );
}
