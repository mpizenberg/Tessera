/**
 * The networks a Tessera backend serves, and each one's epoch calendar.
 */

export const NETWORKS = ["mainnet", "preprod", "preview"] as const;

export type Network = (typeof NETWORKS)[number];

/** Parse a network at an environment or HTTP boundary; unknown values fail closed. */
export function parseNetwork(value: unknown): Network {
  if (
    typeof value === "string" &&
    (NETWORKS as readonly string[]).includes(value)
  ) {
    return value as Network;
  }
  throw new Error(`Unsupported Cardano network: ${String(value)}`);
}

/** Epoch length per network, in seconds. */
export const SECONDS_PER_EPOCH: Record<Network, number> = {
  mainnet: 432000,
  preprod: 432000,
  preview: 86400,
};

/**
 * Unix time of each network's epoch 0 — the genesis `systemStart`. Byron
 * epochs on mainnet and preprod were 21600 slots of 20 s, the same 432000 s as
 * a Shelley epoch, and preview has no Byron era, so one anchor and one length
 * cover each network's whole history: epoch `e` starts at
 * `EPOCH_ZERO_UNIX + e × SECONDS_PER_EPOCH`.
 */
export const EPOCH_ZERO_UNIX: Record<Network, number> = {
  mainnet: 1506203091,
  preprod: 1654041600,
  preview: 1666656000,
};

/**
 * The epoch a network's calendar is in at `nowUnix` (default: now).
 *
 * This is the epoch a host passes to `<tessera-respond>` as `tipEpoch`, and
 * the one to judge "still open" by: a survey accepts responses through its
 * `endEpoch` inclusive, and the ledger's epoch is wall-clock. A snapshot's
 * `tip.epoch` lags this by up to one refresh interval, which around an epoch
 * boundary shows a just-closed survey as open.
 */
export function currentEpoch(
  network: Network,
  nowUnix: number = Math.floor(Date.now() / 1000),
): number {
  return Math.floor(
    (nowUnix - EPOCH_ZERO_UNIX[network]) / SECONDS_PER_EPOCH[network],
  );
}
