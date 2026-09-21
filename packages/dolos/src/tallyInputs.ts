/**
 * A {@link TallyInputSource} over two Dolos nodes replayed from Mithril-
 * certified immutable files and stopped at two points around a survey's
 * `end_epoch = E`:
 *  - `end`, whose tip is the last block of `E`: DRep power and registration
 *    (`/governance/dreps/{id}`, whose `amount` is the distribution for the
 *    tip's epoch) and stake registration (`/accounts/{id}` `registered`) are
 *    read from its state, which answers for the tip only;
 *  - `after`, at least one block into `E + 2`: each account's active stake for
 *    `E` (`/accounts/{id}/history`), a log the node writes when it closes
 *    `E + 1`.
 * No route serves the electorate totals, so this source reads none.
 */

import type { Credential } from "cip-179";
import { credentialKey } from "cip-179/domain";
import { evolutionCodec } from "cip-179/evolution";
import type { TallyInputSource, WeightInfo } from "cip-179/tally";

import { lastBlockOf, type BlockRow, type Minibf } from "./minibfClient";

interface DrepRow {
  amount: string;
  retired: boolean;
  /** The epoch of the DRep's latest registration. */
  active_epoch: number | null;
}

export class DolosTallyInputs implements TallyInputSource {
  private readonly checked = new Map<number, Promise<void>>();

  constructor(
    private readonly end: Minibf,
    private readonly after: Minibf,
    private readonly network: string,
  ) {}

  /** Both nodes stand where `epoch`'s inputs are read, or this throws. */
  private stoppedFor(epoch: number): Promise<void> {
    let check = this.checked.get(epoch);
    if (!check) {
      check = (async () => {
        const [tip, last, later] = await Promise.all([
          this.end.get<BlockRow>("/blocks/latest"),
          lastBlockOf(this.after, epoch),
          this.after.get<BlockRow>("/blocks/latest"),
        ]);
        if (tip.hash !== last.hash) {
          throw new Error(
            `the node at ${this.end.url} stands at block ${tip.height}, not ${last.height}, the last of epoch ${epoch}`,
          );
        }
        if (later.epoch < epoch + 2) {
          throw new Error(
            `the node at ${this.after.url} is in epoch ${later.epoch}; the stake of ${epoch} is logged from ${epoch + 2}`,
          );
        }
      })();
      this.checked.set(epoch, check);
    }
    return check;
  }

  async drepWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>> {
    await this.stoppedFor(epoch);
    const out = new Map<string, WeightInfo>();
    for (const cred of credentials) {
      const id = evolutionCodec.drepId(cred);
      const d = await this.end.find<DrepRow>(`/governance/dreps/${id}`);
      if (!d || d.retired) {
        out.set(credentialKey(cred), { registered: false, weight: 0n });
        continue;
      }
      // Registration applies the deposit as `amount`, which stands until the
      // next distribution: for such a DRep it is not the power for `epoch`,
      // and no case has been measured to read that power from.
      if (d.active_epoch === epoch) {
        throw new Error(
          `DRep ${id} registered during epoch ${epoch}: its amount is its deposit, not its power`,
        );
      }
      out.set(credentialKey(cred), {
        registered: true,
        weight: BigInt(d.amount || "0"),
      });
    }
    return out;
  }

  async stakeholderWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>> {
    await this.stoppedFor(epoch);
    const out = new Map<string, WeightInfo>();
    for (const cred of credentials) {
      const address = evolutionCodec.stakeAddress(cred, this.network);
      const account = await this.end.find<{ registered: boolean }>(
        `/accounts/${address}`,
      );
      if (account?.registered !== true) {
        out.set(credentialKey(cred), { registered: false, weight: 0n });
        continue;
      }
      out.set(credentialKey(cred), {
        registered: true,
        weight: await this.activeStake(address, epoch),
      });
    }
    return out;
  }

  /** The account's active stake for `epoch`; 0 when it has no row (no pool). */
  private async activeStake(address: string, epoch: number): Promise<bigint> {
    for (let page = 1; ; page++) {
      const rows =
        (await this.after.find<{ active_epoch: number; amount: string }[]>(
          `/accounts/${address}/history?order=desc&count=100&page=${page}`,
        )) ?? [];
      for (const r of rows) {
        if (r.active_epoch === epoch) return BigInt(r.amount);
        if (r.active_epoch < epoch) return 0n;
      }
      if (rows.length < 100) return 0n;
    }
  }
}
