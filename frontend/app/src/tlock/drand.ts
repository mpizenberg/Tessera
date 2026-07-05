/**
 * Drand quicknet round/time math now lives in `@tessera/tlock` (shared with the
 * serving tier and the verifier) and is re-exported here so existing
 * `~/tlock/drand` importers keep their path. Only the `Date`-formatting helpers
 * — presentation, not domain math — stay in the frontend.
 */

export * from "@tessera/tlock";

import { epochEndUnix, unixTimeForRound } from "@tessera/tlock";

/** Format a unix time (seconds) as a local wall-clock, e.g. "Jun 30, 2026, 14:05". */
export function formatUnixDate(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human-friendly reveal moment for a round, e.g. "Jun 30, 2026, 14:05". */
export function formatRevealDate(round: number): string {
  return formatUnixDate(unixTimeForRound(round));
}

/**
 * Human-friendly wall-clock moment an `end_epoch` closes (responses stop being
 * accepted) — the start of the epoch after it. Same projection as
 * {@link import("@tessera/tlock").epochEndUnix}; an estimate, exact up to a
 * future epoch-length change.
 */
export function formatEpochEndDate(
  endEpoch: number,
  tipEpoch: number,
  tipUnix: number,
  tipEpochSlot: number,
  secondsPerEpoch: number,
): string {
  return formatUnixDate(
    epochEndUnix(endEpoch, tipEpoch, tipUnix, tipEpochSlot, secondsPerEpoch),
  );
}
