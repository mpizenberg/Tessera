/**
 * A {@link TallyInputSource} over an Amaru node's epoch snapshots, as
 * `amaru-store-reader` printed them. For a survey ending at `E`:
 *  - registration at `E`, of a stake credential or a DRep, is its presence in
 *    snapshot `E`, the state at that epoch's end;
 *  - a stakeholder's active stake for `E` is the stake snapshot `E-2` holds
 *    behind a pool still standing there, the distribution the ledger takes
 *    two boundaries ahead; 0 without a pool or a row;
 *  - a DRep's voting power for `E` is snapshot `E-1`'s `voting_stake`, the
 *    distribution taken one boundary ahead; 0 without a row.
 * The electorate totals sit outside the artifact's hash and are not read.
 */

import type { Credential } from "cip-179";
import { credentialKey } from "cip-179/domain";
import type { TallyInputSource, WeightInfo } from "cip-179/tally";

import type { AmaruStores } from "./stores";

export class AmaruTallyInputs implements TallyInputSource {
  constructor(private readonly stores: AmaruStores) {}

  async stakeholderWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>> {
    const registered = this.stores.snapshot(epoch).accounts;
    const staked = this.stores.snapshot(epoch - 2).accounts;
    return weights(credentials, registered, (key) => {
      const account = staked[key];
      return account?.pool ? BigInt(account.stake) : 0n;
    });
  }

  async drepWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>> {
    const registered = this.stores.snapshot(epoch).dreps;
    const powered = this.stores.snapshot(epoch - 1).dreps;
    return weights(credentials, registered, (key) =>
      BigInt(powered[key]?.voting_stake ?? "0"),
    );
  }
}

function weights(
  credentials: readonly Credential[],
  registered: Readonly<Record<string, unknown>>,
  weightOf: (key: string) => bigint,
): Map<string, WeightInfo> {
  const out = new Map<string, WeightInfo>();
  for (const cred of credentials) {
    const key = credentialKey(cred);
    out.set(
      key,
      key in registered
        ? { registered: true, weight: weightOf(key) }
        : { registered: false, weight: 0n },
    );
  }
  return out;
}
