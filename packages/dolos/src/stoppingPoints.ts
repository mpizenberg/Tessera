/**
 * Where the two Dolos nodes of an audit stop, as Mithril immutable-file
 * numbers. An immutable file spans `10k` slots (`k` the security parameter),
 * the length of a Byron epoch: a Byron epoch is one file, and a Shelley epoch
 * a fixed number of them. A replay reads every downloaded file but the
 * highest, so each `--download-end` is one past the last file to replay.
 */

import {
  SECONDS_PER_EPOCH,
  SECURITY_PARAM,
  type Network,
} from "cardano-tessera-client";

/** The first Shelley epoch, reached by protocol update, so in no genesis. */
const SHELLEY_EPOCH: Record<Network, number> = {
  mainnet: 208,
  preprod: 4,
  preview: 0,
};

/** The immutable file holding `slot`. */
export function fileOf(network: Network, slot: number): number {
  return Math.floor(slot / (10 * SECURITY_PARAM[network]));
}

/** The first slot of a Shelley-era `epoch`; a Shelley slot is one second. */
export function firstSlot(network: Network, epoch: number): number {
  const shelleyEpoch = SHELLEY_EPOCH[network];
  if (epoch < shelleyEpoch) {
    throw new Error(`epoch ${epoch} is before Shelley on ${network}`);
  }
  return (
    shelleyEpoch * 10 * SECURITY_PARAM[network] +
    (epoch - shelleyEpoch) * SECONDS_PER_EPOCH[network]
  );
}

export interface StoppingPoints {
  /** The end node's `--download-end`: its replay ends with `E`'s last file. */
  readonly endDownloadEnd: number;
  /**
   * The after node's `--download-start`: `E`'s last file, which holds the end
   * node's last block when it holds any block.
   */
  readonly afterDownloadStart: number;
  /** Its `--download-end`: its replay ends with the file holding `E + 2`'s first slot. */
  readonly afterDownloadEnd: number;
  /** Its `stop_epoch`, `E + 2`. */
  readonly stopEpoch: number;
}

/** The stopping points for a survey whose `end_epoch` is `endEpoch`. */
export function stoppingPoints(
  network: Network,
  endEpoch: number,
): StoppingPoints {
  const nextStart = firstSlot(network, endEpoch + 1);
  return {
    endDownloadEnd: fileOf(network, nextStart),
    afterDownloadStart: fileOf(network, nextStart - 1),
    afterDownloadEnd: fileOf(network, firstSlot(network, endEpoch + 2)) + 1,
    stopEpoch: endEpoch + 2,
  };
}
