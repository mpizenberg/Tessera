/**
 * What `amaru-store-reader` printed, read back from one directory:
 * `snapshot-<epoch>.json` for each epoch snapshot and `blocks.json` for the
 * block walk. Only the fields the verifier consumes are typed; the reader
 * prints more.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SnapshotFile {
  readonly epoch: number;
  /**
   * Keyed `key:<hex>` or `script:<hex>`, each stake credential the reader
   * was asked about with the node's end-of-epoch view of it, its stake and
   * its pool when that pool still stands; `null` when not registered.
   */
  readonly accounts: Readonly<
    Record<
      string,
      { readonly stake: string; readonly pool: string | null } | null
    >
  >;
  /** Keyed like `accounts`, each DRep asked about, `null` when not registered. */
  readonly dreps: Readonly<
    Record<string, { readonly voting_stake: string } | null>
  >;
  /** Keyed `<tx hash>#<index>`, every governance action still in the state. */
  readonly proposals: Readonly<
    Record<
      string,
      {
        readonly valid_until: number;
        readonly anchor: { readonly url: string; readonly hash: string };
      }
    >
  >;
}

export interface WalkedTx {
  readonly hash: string;
  readonly slot: number;
  readonly epoch: number;
  /** Position in the block. */
  readonly index: number;
  /** The transaction's standalone CBOR, hex. */
  readonly cbor: string;
  /** The transaction's label-17 datum, CBOR hex. */
  readonly metadata: string;
}

export interface BlocksFile {
  readonly from: number;
  readonly to: number;
  readonly tip: {
    readonly slot: number;
    readonly epoch: number;
    readonly epoch_slot: number;
  };
  readonly transactions: readonly WalkedTx[];
}

export class AmaruStores {
  private readonly snapshots = new Map<number, SnapshotFile>();
  private walk: BlocksFile | undefined;

  constructor(readonly dir: string) {}

  snapshot(epoch: number): SnapshotFile {
    let s = this.snapshots.get(epoch);
    if (!s) {
      s = this.read<SnapshotFile>(`snapshot-${epoch}.json`);
      if (s.epoch !== epoch)
        throw new Error(
          `${this.dir}/snapshot-${epoch}.json is the snapshot of epoch ${s.epoch}`,
        );
      this.snapshots.set(epoch, s);
    }
    return s;
  }

  blocks(): BlocksFile {
    this.walk ??= this.read<BlocksFile>("blocks.json");
    return this.walk;
  }

  private read<T>(name: string): T {
    return JSON.parse(readFileSync(join(this.dir, name), "utf8")) as T;
  }
}
