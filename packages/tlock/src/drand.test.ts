/**
 * Tests for {@link roundForUnixTime}: the core safety property of a sealed
 * survey is that the auto-reveal round never becomes decryptable *before* the
 * deadline it was derived from. The function must therefore return the
 * **earliest** round whose beacon publishes **at or after** the given time —
 * never one that publishes before it (the bug a `floor` would reintroduce).
 */

import { describe, expect, it } from "vitest";

import { roundForUnixTime, unixTimeForRound } from "./drand";

// Quicknet genesis (mirrors the module constant) and period.
const GENESIS = 1692803367;
const PERIOD = 3;

describe("roundForUnixTime", () => {
  it("collapses times at or before genesis to round 1", () => {
    expect(roundForUnixTime(GENESIS)).toBe(1);
    expect(roundForUnixTime(GENESIS - 1)).toBe(1);
    expect(roundForUnixTime(0)).toBe(1);
  });

  it("maps an exact round boundary to that round (publishes exactly at the time)", () => {
    // unixTimeForRound(3) === GENESIS + 6.
    expect(roundForUnixTime(GENESIS + 6)).toBe(3);
    expect(unixTimeForRound(roundForUnixTime(GENESIS + 6))).toBe(GENESIS + 6);
  });

  it("rounds a between-boundary time UP, never down (the floor-bug regression)", () => {
    // GENESIS+7 sits inside round 3's slot (covers [GENESIS+6, GENESIS+9));
    // round 3 publishes at GENESIS+6, which is BEFORE the deadline, so the
    // answer must be round 4 (publishes at GENESIS+9 ≥ GENESIS+7).
    expect(roundForUnixTime(GENESIS + 7)).toBe(4);
    expect(
      unixTimeForRound(roundForUnixTime(GENESIS + 7)),
    ).toBeGreaterThanOrEqual(GENESIS + 7);
  });

  it("never returns a round that publishes before the deadline (sweep)", () => {
    for (let delta = 1; delta <= 10_000; delta++) {
      const unix = GENESIS + delta;
      const round = roundForUnixTime(unix);
      // The chosen round's beacon publishes at or after the deadline …
      expect(unixTimeForRound(round)).toBeGreaterThanOrEqual(unix);
      // … and it is the *earliest* such round: the previous one is strictly before.
      expect(unixTimeForRound(round - 1)).toBeLessThan(unix);
    }
  });

  it("advances exactly one round per period step", () => {
    const base = GENESIS + 6;
    expect(roundForUnixTime(base + PERIOD) - roundForUnixTime(base)).toBe(1);
  });
});
