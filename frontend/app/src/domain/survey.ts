/**
 * Pure survey aggregation. Moved to `@tessera/core` (shared with the serving
 * tier and verifier); this re-export keeps the `~/domain/survey` import path
 * stable.
 */
export {
  refKey,
  credentialKey,
  dedupeResponses,
  epochOfSlot,
  voteDeadlineUnix,
  cancellationStates,
  aggregateSurveys,
  aggregateSurveyList,
  findSurvey,
} from "@tessera/core";
export type {
  SurveyStatus,
  SurveyAggregate,
  CancellationState,
} from "@tessera/core";
