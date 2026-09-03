/**
 * Drand quicknet parameters and round/time math — pure, no I/O, no heavy deps.
 *
 * Sealed (commit-reveal) surveys timelock-encrypt responses to a future drand
 * round; the round becomes decryptable once the quicknet beacon for it
 * publishes. We pin **quicknet** (the only chain the bundled tlock supports),
 * so the round ↔ time mapping is linear in the 3-second period. The chain's
 * identity (`QUICKNET_CHAIN_HASH`, `isQuicknet`) is a definition-level fact and
 * lives in `cip-179/domain`; it is re-exported here for existing importers.
 *
 * The actual encrypt/decrypt lives in the lazy `./client` seam; this module
 * only does the arithmetic the UI and the finalizer need (which round, when it
 * reveals). The `Date`-formatting helpers that used to live here stay in the
 * frontend — they are presentation, not domain math, and pull in locale APIs.
 */

export {
  QUICKNET_CHAIN_HASH,
  QUICKNET_CHAIN_HASH_HEX,
  isQuicknet,
} from "../domain/quicknet.js";

/** Quicknet genesis time (unix seconds) and round period (seconds). */
const GENESIS_TIME = 1692803367;
const PERIOD = 3;

/**
 * The first drand round whose beacon publishes at or after `unix` — i.e. the
 * earliest round that guarantees the deadline has passed. Rounds before genesis
 * collapse to round 1.
 */
export function roundForUnixTime(unix: number): number {
  if (unix <= GENESIS_TIME) return 1;
  // `ceil`, not `floor`: we need the first round publishing *at or after* `unix`.
  // The round for round number r publishes at GENESIS + (r-1)*PERIOD, so the
  // smallest r with that ≥ unix is ceil((unix-GENESIS)/PERIOD) + 1. `floor`
  // would return a round publishing up to PERIOD-1 seconds *before* `unix`,
  // breaking the "deadline has passed" guarantee for any non-period-aligned time.
  return Math.ceil((unix - GENESIS_TIME) / PERIOD) + 1;
}

/** The unix time (seconds) at which a given round's beacon publishes. */
export function unixTimeForRound(round: number): number {
  return GENESIS_TIME + (round - 1) * PERIOD;
}

/** Has `round` already published as of `nowUnix`? (Then it is decryptable.) */
export function roundIsAvailable(round: number, nowUnix: number): boolean {
  return unixTimeForRound(round) <= nowUnix;
}

/**
 * Margin (seconds) added after an epoch boundary before the reveal — a couple
 * of minutes so the round lands just *after* responses close, never before.
 */
export const REVEAL_MARGIN_SECONDS = 120;

/**
 * The wall-clock unix time at which `endEpoch` *closes* (the start of the epoch
 * after it). Anchors on the current epoch's start, which post-Shelley (1s
 * slots) is `tipUnix - tipEpochSlot`, then projects forward whole epochs. Exact
 * up to a future hard fork changing the epoch length. Mirrors the Elm
 * reference's `defaultRevealDeadline`.
 */
export function epochEndUnix(
  endEpoch: number,
  tipEpoch: number,
  tipUnix: number,
  tipEpochSlot: number,
  secondsPerEpoch: number,
): number {
  const currentEpochStart = tipUnix - tipEpochSlot;
  return currentEpochStart + (endEpoch + 1 - tipEpoch) * secondsPerEpoch;
}

/**
 * The drand round that auto-reveals a sealed survey: the first round at/after
 * the end epoch closes plus {@link REVEAL_MARGIN_SECONDS}.
 */
export function autoRevealRound(
  endEpoch: number,
  tipEpoch: number,
  tipUnix: number,
  tipEpochSlot: number,
  secondsPerEpoch: number,
): number {
  const deadline =
    epochEndUnix(endEpoch, tipEpoch, tipUnix, tipEpochSlot, secondsPerEpoch) +
    REVEAL_MARGIN_SECONDS;
  return roundForUnixTime(deadline);
}
