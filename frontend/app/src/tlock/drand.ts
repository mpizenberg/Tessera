/**
 * Frontend-only `Date`-formatting helpers over drand rounds and Cardano epochs.
 * The underlying round/time math lives in `cip-179/tlock` (shared with the
 * serving tier and the verifier) and is imported directly by call sites; only
 * this presentation layer stays in the frontend.
 */

import { epochEndUnix, unixTimeForRound } from "cip-179/tlock";

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
 * {@link import("cip-179/tlock").epochEndUnix}; an estimate, exact up to a
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
