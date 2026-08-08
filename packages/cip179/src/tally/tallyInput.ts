/**
 * The weight-input seam for stake-weighted tallies: everything finalization
 * needs to ask a chain indexer about role membership and weights at a survey's
 * `end_epoch`, expressed role-semantically (not per endpoint) so a Tier-2
 * indexer can implement it behind the same interface.
 *
 * Weights are exact lovelace BigInts. All methods snapshot **at the given
 * epoch** — never "current" values.
 */

import type { Credential } from "../index.js";

/** One credential's membership + weight at the snapshot epoch. */
export interface WeightInfo {
  /** Exact weight in lovelace; `0n` for registered-but-empty. */
  readonly weight: bigint;
  /** Whether the credential was registered for the role at that epoch. */
  readonly registered: boolean;
}

/**
 * Role-semantic weight source. Batch methods return a map keyed by the
 * credential's stable identity (`credentialKey` form) covering **every**
 * requested credential — unregistered ones map to
 * `{weight: 0n, registered: false}`. Totals return `null` when the upstream
 * can't serve them right now (retry later), never throw for that.
 */
export interface TallyInputSource {
  /** Stakeholder (role 3) weights: active stake at `epoch`. */
  stakeholderWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>>;
  /** DRep (role 0) weights: DRep voting power at `epoch`. */
  drepWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>>;
  /** Total active stake at `epoch` (turnout denominator), or null = retry. */
  stakeholderTotal(epoch: number): Promise<bigint | null>;
  /** Total DRep voting power at `epoch`, or null = retry. */
  drepTotal(epoch: number): Promise<bigint | null>;
}
