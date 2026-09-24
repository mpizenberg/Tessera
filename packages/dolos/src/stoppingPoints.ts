/**
 * Where the Dolos node of an audit stops, as a Mithril immutable-file number
 * and a stop epoch. An immutable file spans `10k` slots (`k` the security
 * parameter), the length of a Byron epoch: a Byron epoch is one file, and a
 * Shelley epoch a fixed number of them. A replay reads every downloaded file
 * but the highest, so `--download-end` is one past the last file to replay.
 */

import {
  SECURITY_PARAM,
  firstSlot,
  type Network,
} from "cardano-tessera-client";

/** The immutable file holding `slot`. */
export function fileOf(network: Network, slot: number): number {
  return Math.floor(slot / (10 * SECURITY_PARAM[network]));
}

export interface StoppingPoint {
  /**
   * `--download-end`: one past the file holding `E + 1`'s first slot, so the
   * replay reaches that epoch's first block.
   */
  readonly downloadEnd: number;
  /**
   * `stop_epoch`, `E + 1`: the replay closes `E` at that epoch's first block,
   * applies the block and stops, so the store holds the ledger at the end of
   * `E`.
   */
  readonly stopEpoch: number;
}

/** The stopping point for a survey whose `end_epoch` is `endEpoch`. */
export function stoppingPoint(
  network: Network,
  endEpoch: number,
): StoppingPoint {
  return {
    downloadEnd: fileOf(network, firstSlot(network, endEpoch + 1)) + 1,
    stopEpoch: endEpoch + 1,
  };
}
