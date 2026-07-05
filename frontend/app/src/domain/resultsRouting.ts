/**
 * Which results view a survey shows — a pure decision shared by the Survey
 * screen so the routing is unit-testable without SolidJS.
 *
 * - `"final"`: the server-emitted, hash-verifiable tally artifact (FinalResults).
 *   Shown whenever an artifact exists and the user hasn't asked for the raw view.
 * - `"sealed"`: the client-side reveal (SealedResults) — the trust-minimized
 *   path for a sealed survey, reached when there's no artifact yet or the user
 *   toggled away from the final view.
 * - `"raw"`: the live on-chain tally of a public survey (ResultsBody), before an
 *   artifact exists or when the user toggled away from it.
 */
export type ResultsView = "final" | "sealed" | "raw";

/**
 * @param sealed      the survey's submission mode is sealed
 * @param hasArtifact a finalized tally artifact is available
 * @param showRaw     the user asked to see the pre-artifact view
 */
export function resultsView(
  sealed: boolean,
  hasArtifact: boolean,
  showRaw: boolean,
): ResultsView {
  return hasArtifact && !showRaw ? "final" : sealed ? "sealed" : "raw";
}
