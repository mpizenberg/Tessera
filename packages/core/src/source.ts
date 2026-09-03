/**
 * The data-source seam.
 *
 * Everything the UI needs to *read* CIP-179 state flows through `DataSource`.
 * One implementation talks to Koios directly (`cardano-tessera-koios`); the
 * other reads a serving backend through `cardano-tessera-client`, and the
 * domain and UI layers cannot tell which produced a payload.
 *
 * This seam is deliberately Tessera-specific: it has one method per
 * page-shaped read, so a serving-tier implementation maps each onto one bounded
 * HTTP route. The payload shapes are the HTTP contract's, typed in
 * `cardano-tessera-client`; the raw on-chain **record shapes** inside them —
 * and the pure aggregation over them — live in `cip-179/domain`.
 */

import type { SurveyRef } from "cip-179";
import type { TallyArtifact } from "cip-179/tally";
import type {
  BackendHealth,
  SurveyBundlePayload,
  SurveyListParams,
  SurveyListPayload,
} from "cardano-tessera-client";

/**
 * The seam the UI reads through — one method per page-shaped read, so a
 * serving-tier implementation maps each onto one bounded HTTP route. Full-scan
 * reads (`fetchAll`, `chainTip`, `fetchGovernanceLinks`) are deliberately NOT
 * part of the seam: they live on `KoiosDataSource` concretely, where the
 * serving tier's refresh (and the Koios implementation of the methods below)
 * still need them.
 */
export interface DataSource {
  /**
   * The Explore-list payload: every survey with per-survey response counts,
   * plus tip / governance links / raw cancellations. See {@link SurveyListPayload}.
   */
  surveyList(): Promise<SurveyListPayload>;
  /**
   * One page of the Explore list ({@link SurveyListParams}): filtered,
   * searched, and keyset-paginated server-side, with global chip counts and a
   * `nextCursor` continuation. Optional: the serving-tier implementation
   * answers from its materialized survey index; the direct Koios path leaves
   * it undefined and the app pages the full `surveyList()` payload in memory
   * with {@link import("./page").pageSurveyList} instead.
   */
  surveyListPage?(params: SurveyListParams): Promise<SurveyListPayload>;
  /**
   * The self-contained per-survey slice (detail/respond pages, verifiers),
   * every response page collected, with proof verdicts when the source
   * computes them ({@link SurveyBundlePayload}). Rejects when the ref matches
   * no known survey.
   */
  surveyBundle(ref: SurveyRef): Promise<SurveyBundlePayload>;
  /**
   * Survey keys ("<txHex>:<index>") having at least one response from any of
   * the given credentials, each in the `credentialKey` form
   * ("key:<hex>" | "script:<hex>"). Raw responses, no dedupe/validity filter —
   * this feeds Explore's "surveys I answered" flags, where any attempt counts.
   * Empty input resolves to [] without a fetch.
   */
  respondedKeys(credentialKeys: readonly string[]): Promise<string[]>;
  /**
   * Block-inclusion status for a set of just-submitted transactions, keyed by
   * tx hash. The value is the number of confirmations, or `null` when the tx is
   * not yet in a block (the chain indexer can't see the mempool). Used only to
   * flip a "pending" indicator to "confirmed" — never to drive the survey list.
   */
  txStatus(txHashes: readonly string[]): Promise<Map<string, number | null>>;
  /**
   * The survey's final tally artifact ({@link TallyArtifact}), or `null` when
   * none exists (survey still open, not yet finalized, or the source can't
   * produce artifacts — the direct Koios path never does; the UI then falls
   * back to the raw client-side tally).
   */
  artifact(ref: SurveyRef): Promise<TallyArtifact | null>;
  /**
   * Operational health of the backing service ({@link BackendHealth}), for the
   * app's health footer. Optional: only the serving-tier implementation has a
   * refresh loop to report on — the direct Koios path leaves it undefined and
   * the footer simply doesn't render.
   */
  health?(): Promise<BackendHealth>;
}
