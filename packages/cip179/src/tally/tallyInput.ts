/**
 * The weight-input seam for stake-weighted tallies: everything finalization
 * needs to ask a chain indexer about role membership and weights at the end of
 * a survey's `end_epoch`, and the electorate totals beside it, expressed
 * role-semantically (not per endpoint) so a Tier-2 indexer can implement it
 * behind the same interface.
 *
 * Weights are exact lovelace BigInts. Every method is given the survey's
 * `end_epoch` and answers for the ledger as that epoch's last block leaves it
 * — never "current" values: the DRep distribution taken at that instant, and
 * the stake snapshot taken at the same instant (the ledger's mark).
 */

import type { Credential } from "../index.js";

/** One credential's membership + weight at the end of `endEpoch`. */
export interface WeightInfo {
  /** Exact weight in lovelace; `0n` for registered-but-empty. */
  readonly weight: bigint;
  /** Whether the credential was registered for the role at that instant. */
  readonly registered: boolean;
}

/**
 * Role-semantic weight source. Batch methods return a map keyed by the
 * credential's stable identity (`credentialKey` form) covering **every**
 * requested credential — unregistered ones map to
 * `{weight: 0n, registered: false}`.
 */
export interface TallyInputSource {
  /**
   * Stakeholder (role 3) weights: each account's stake behind its pool in the
   * stake snapshot taken at the end of `endEpoch`.
   */
  stakeholderWeights(
    endEpoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>>;
  /** DRep (role 0) weights: the DRep distribution taken at the end of `endEpoch`. */
  drepWeights(
    endEpoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>>;
}

/**
 * The electorate totals behind turnout. Apart from {@link TallyInputSource}
 * because no tally depends on them: an artifact carries them outside its
 * hash, so a source that cannot serve them can still reproduce a result.
 * Each returns `null` when the upstream can't serve it right now (retry
 * later), never throws for that.
 */
export interface ElectorateTotals {
  /**
   * Total stake of the snapshot taken at the end of `endEpoch` (turnout's
   * denominator), or null = retry.
   */
  stakeholderTotal(endEpoch: number): Promise<bigint | null>;
  /** Total of the DRep distribution taken at the end of `endEpoch`, or null = retry. */
  drepTotal(endEpoch: number): Promise<bigint | null>;
}
