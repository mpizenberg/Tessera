/**
 * A {@link TallyInputSource} over an Amaru node's epoch snapshot `E`, the
 * ledger at the end of a survey's `end_epoch = E`, as `amaru-store-reader`
 * printed it:
 *  - registration, of a stake credential or a DRep, is a row;
 *  - a stakeholder's weight is the row's stake behind a pool still standing,
 *    the mark taken at that instant; 0 without a pool;
 *  - a DRep's weight is the row's `voting_stake`, the distribution taken at
 *    that instant.
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
      const account = this.row(epoch, "accounts", key);
      if (!account) return null;
      return account.pool ? BigInt(account.stake) : 0n;
    });
  }

  async drepWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>> {
    return weights(credentials, (key) => {
      const drep = this.row(epoch, "dreps", key);
      return drep ? BigInt(drep.voting_stake) : null;
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

/** `weightOf` gives `null` for a credential not registered at the end of `end_epoch`. */
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
