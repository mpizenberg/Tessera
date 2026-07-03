/**
 * Pure count-based tallying. Moved to `@tessera/core` (shared with the serving
 * tier and verifier); this re-export keeps the `~/domain/tally` import path
 * stable.
 */
export { tallyQuestion, tallySurvey, roleBreakdown } from "@tessera/core";
export type {
  Bar,
  PointsRow,
  RatingRow,
  HistogramBin,
  QuestionTally,
} from "@tessera/core";
