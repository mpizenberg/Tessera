/**
 * A {@link TallyInputSource} over a Dolos node replayed from Mithril-certified
 * immutable files to the first block of `end_epoch + 1 = E + 1`, where
 * `stop_epoch` halts it. The boundary out of `E` has run, so the store holds
 * the ledger at the end of `E`, which no route serves: each account's stake
 * and pool in the snapshot taken then (its `mark`), a DRep's `voting_power`
 * from the distribution taken then, a pool's standing then. They are read with
 * `dolos data dump-entity` ({@link DolosNode.dump}), one entity at a time;
 * the one block of `E + 1` applied writes none of them but what its
 * certificates change, and registration is judged by slot against `E + 1`'s
 * first. No route serves the electorate totals either, so this source reads
 * none.
 */

import type { Credential } from "cip-179";
import { bytesToHex, credentialKey } from "cip-179/domain";
import type { TallyInputSource, WeightInfo } from "cip-179/tally";
import type { Network } from "cardano-tessera-client";

import { accountAtEnd, drepAtEnd, poolStandsAt } from "./dump";
import type { DolosNode } from "./node";
import { firstSlot } from "./stoppingPoints";

const hashOf = (cred: Credential): string =>
  bytesToHex(cred.type === "key" ? cred.keyHash : cred.scriptHash);

/** The state's account key: the credential's CBOR, `[0 / 1, hash]`. */
const accountKey = (cred: Credential): string =>
  `820${cred.type === "key" ? 0 : 1}581c${hashOf(cred)}`;

/** The state's DRep key: the CIP-129 payload, header `0x22` / `0x23`. */
const drepKey = (cred: Credential): string =>
  `${cred.type === "key" ? "22" : "23"}${hashOf(cred)}`;

export class DolosTallyInputs implements TallyInputSource {
  private readonly pools = new Map<string, boolean>();

  constructor(
    private readonly node: Pick<DolosNode, "dir" | "tipSlot" | "dump">,
    private readonly network: Network,
  ) {}

  /** `E + 1`'s first slot, once the store is seen standing in `E + 1`. */
  private async nextStart(epoch: number): Promise<number> {
    const start = firstSlot(this.network, epoch + 1);
    const tip = await this.node.tipSlot();
    if (
      tip === null ||
      tip < start ||
      tip >= firstSlot(this.network, epoch + 2)
    )
      throw new Error(
        `the Dolos store in ${this.node.dir} stands at slot ${tip}, not in epoch ${epoch + 1}, where the end of ${epoch} is read`,
      );
    return start;
  }

  async drepWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>> {
    const start = await this.nextStart(epoch);
    const out = new Map<string, WeightInfo>();
    for (const cred of credentials) {
      const text = await this.node.dump("dreps", drepKey(cred));
      const drep =
        text === null ? null : atEnd(cred, () => drepAtEnd(text, epoch, start));
      out.set(
        credentialKey(cred),
        drep?.registered
          ? { registered: true, weight: drep.power }
          : { registered: false, weight: 0n },
      );
    }
    return out;
  }

  async stakeholderWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>> {
    const start = await this.nextStart(epoch);
    const out = new Map<string, WeightInfo>();
    for (const cred of credentials) {
      const text = await this.node.dump("accounts", accountKey(cred));
      const account =
        text === null
          ? null
          : atEnd(cred, () => accountAtEnd(text, epoch, start));
      if (!account?.registered) {
        out.set(credentialKey(cred), { registered: false, weight: 0n });
        continue;
      }
      out.set(credentialKey(cred), {
        registered: true,
        weight:
          account.pool !== null && (await this.poolStands(account.pool, epoch))
            ? account.stake
            : 0n,
      });
    }
    return out;
  }

  private async poolStands(pool: string, epoch: number): Promise<boolean> {
    let stands = this.pools.get(pool);
    if (stands === undefined) {
      const text = await this.node.dump("pools", pool);
      stands = text !== null && poolStandsAt(text, epoch);
      this.pools.set(pool, stands);
    }
    return stands;
  }
}

/** `read`'s answer, or its refusal naming the credential. */
function atEnd<T>(cred: Credential, read: () => T): T {
  try {
    return read();
  } catch (err) {
    throw new Error(`${credentialKey(cred)}: ${(err as Error).message}`);
  }
}
