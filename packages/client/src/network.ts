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
 * The security parameter `k`, from the Shelley genesis: a block can no longer
 * roll back once `k` later blocks exist.
 */
export const SECURITY_PARAM: Record<Network, number> = {
  mainnet: 2160,
  preprod: 2160,
  preview: 432,
};

/**
 * The active slot coefficient `f`, from the Shelley genesis: the share of
 * slots expected to hold a block, so a block every `1 / f` seconds.
 */
export const ACTIVE_SLOTS_COEFF = 0.05;

/**
 * Slots within which the chain grows by `k` blocks, `3k / f`: the protocol's
 * bound on how long a block takes to become final when blocks are sparse.
 */
export function stabilityWindowSlots(network: Network): number {
  return Math.round((3 * SECURITY_PARAM[network]) / ACTIVE_SLOTS_COEFF);
}

/**
 * How far the end of `epoch` is from final: `blocksLeft` more blocks make it
 * `k` deep. Only the epoch before the tip's can be short of that, since an
 * epoch is longer than the stability window.
 */
export interface Settling {
  readonly epoch: number;
  readonly blocksLeft: number;
}

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
