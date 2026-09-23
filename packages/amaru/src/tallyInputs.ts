/**
 * A {@link TallyInputSource} over an Amaru node's epoch snapshots, as
 * `amaru-store-reader` printed them. For a survey ending at `E`:
 *  - registration at `E`, of a stake credential or a DRep, is a row in
 *    snapshot `E`, the state at that epoch's end;
 *  - a stakeholder's active stake for `E` is the stake snapshot `E-2` holds
 *    behind a pool still standing there, the distribution the ledger takes
 *    two boundaries ahead; 0 without a pool or a row;
 *  - a DRep's voting power for `E` is snapshot `E-1`'s `voting_stake`, the
 *    distribution taken one boundary ahead; 0 without a row.
 * The electorate totals sit outside the artifact's hash and are not read.
 * Each snapshot holds only the credentials the reader was asked about, so one
 * it was not asked about is refused rather than read as unregistered.
 */

import type { Credential } from "cip-179";
import { credentialKey } from "cip-179/domain";
import type { TallyInputSource, WeightInfo } from "cip-179/tally";

import type { AmaruStores, SnapshotFile } from "./stores";

export class AmaruTallyInputs implements TallyInputSource {
  constructor(private readonly stores: AmaruStores) {}

  async stakeholderWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>> {
    return weights(credentials, (key) => {
      if (!this.row(epoch, "accounts", key)) return null;
      const staked = this.row(epoch - 2, "accounts", key);
      return staked?.pool ? BigInt(staked.stake) : 0n;
    });
  }

  async drepWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>> {
    return weights(credentials, (key) => {
      if (!this.row(epoch, "dreps", key)) return null;
      return BigInt(this.row(epoch - 1, "dreps", key)?.voting_stake ?? "0");
    });
  }

  private row<F extends "accounts" | "dreps">(
    epoch: number,
    field: F,
    key: string,
  ): SnapshotFile[F][string] {
    const rows = this.stores.snapshot(epoch)[field];
    if (!(key in rows))
      throw new Error(
        `${this.stores.dir}/snapshot-${epoch}.json was not asked about ${key}`,
      );
    return rows[key] as SnapshotFile[F][string];
  }
}

/** `weightOf` gives `null` for a credential not registered at `end_epoch`. */
function weights(
  credentials: readonly Credential[],
  weightOf: (key: string) => bigint | null,
): Map<string, WeightInfo> {
  const out = new Map<string, WeightInfo>();
  for (const cred of credentials) {
    const key = credentialKey(cred);
    const weight = weightOf(key);
    out.set(
      key,
      weight === null
        ? { registered: false, weight: 0n }
        : { registered: true, weight },
    );
  }
  return out;
}
