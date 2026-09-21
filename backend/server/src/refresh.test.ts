/**
 * The refresh's pure decision points: how a run resumes the segment walk and
 * the drift-healing rotation from the banked state, and which slots their
 * sweeps may delete in.
 */

import { describe, expect, it, vi } from "vitest";

import type { ChainTip } from "cip-179/domain";
import { toJsonSafe } from "cip-179/tally";
import type { SegmentScan } from "cardano-tessera-koios";

import {
  coveredRange,
  coveredThroughUnix,
  finality,
  nextTrickle,
  planSegment,
  planTrickle,
  SCAN_GENERATION,
  SETTLEMENT_MARGIN_SLOTS,
  wholeThroughSlot,
} from "./refresh";
import { snapshotTip, type ScanState } from "./store";

const state = (over: Partial<ScanState>): ScanState => ({
  cursor: { slot: 900_000, txHash: "cc" },
  caughtUp: true,
  generation: SCAN_GENERATION,
  trickle: null,
  network: "preview",
  ...over,
});

describe("planSegment", () => {
  it("walks from the config floor with no banked cursor", () => {
    expect(planSegment(null, 1_000)).toEqual({
      from: { slot: 1_000 },
      sweepFromSlot: 1_000,
      settledBelowSlot: 1_000,
    });
  });

  it("re-derives the settlement margin below a caught-up cursor", () => {
    const plan = planSegment(state({}), 1_000);
    expect(plan.from).toEqual({ slot: 900_000 - SETTLEMENT_MARGIN_SLOTS });
    expect(plan.sweepFromSlot).toBe(900_000 - SETTLEMENT_MARGIN_SLOTS);
    expect(plan.settledBelowSlot).toBe(900_000 - SETTLEMENT_MARGIN_SLOTS);
  });

  it("clamps the margin re-derivation at the config floor", () => {
    expect(planSegment(state({}), 850_000).from).toEqual({ slot: 850_000 });
  });

  it("continues strictly after a budget-capped cursor, sweeping past its slot", () => {
    // Rows at the cursor slot at-or-before the cursor hash are not re-listed,
    // so a sweep at that slot would delete live rows.
    const plan = planSegment(state({ caughtUp: false }), 1_000);
    expect(plan.from).toEqual({ slot: 900_000, txHash: "cc" });
    expect(plan.sweepFromSlot).toBe(900_001);
    // Settled means below the tip's margin, and the cursor is at or below the
    // tip — nothing this or a later main segment reaches lies below this.
    expect(plan.settledBelowSlot).toBe(900_000 - SETTLEMENT_MARGIN_SLOTS);
  });
});

const scanWith = (over: Partial<SegmentScan>): SegmentScan => ({
  records: { surveys: [], responses: [], cancellations: [], incomplete: false },
  unfetched: [],
  cursor: { slot: 950_000, txHash: "dd" },
  exhausted: true,
  ...over,
});

describe("coveredRange", () => {
  const plan = { sweepFromSlot: 700_000 };

  it("covers through the tip when the segment is exhausted", () => {
    expect(coveredRange(plan, scanWith({}), 960_000)).toEqual({
      fromSlot: 700_000,
      toSlot: 960_000,
    });
  });

  it("stops one slot short of a budget-capped walk's last listed slot", () => {
    // The last slot may hold further unlisted txs past the page budget, so
    // rows there are not deletion candidates yet.
    expect(coveredRange(plan, scanWith({ exhausted: false }), 960_000)).toEqual(
      { fromSlot: 700_000, toSlot: 949_999 },
    );
  });

  it("covers nothing on an incomplete scan", () => {
    expect(
      coveredRange(
        plan,
        scanWith({
          records: {
            surveys: [],
            responses: [],
            cancellations: [],
            incomplete: true,
          },
        }),
        960_000,
      ),
    ).toBeNull();
  });

  it("stops below the oldest listed tx Koios has not served", () => {
    // Its record may be the one a stored row stands for; a sweep over its slot
    // would take a lagging instance for a rollback.
    const scan = scanWith({
      unfetched: [
        { txHash: "ee", slot: 820_000 },
        { txHash: "ff", slot: 800_000 },
      ],
    });
    expect(wholeThroughSlot(scan)).toBe(799_999);
    expect(coveredRange(plan, scan, 960_000)).toEqual({
      fromSlot: 700_000,
      toSlot: 799_999,
    });
  });

  it("covers nothing when the walk never left its starting slot", () => {
    expect(
      coveredRange(
        { sweepFromSlot: 950_001 },
        scanWith({ exhausted: false, cursor: { slot: 950_000, txHash: "zz" } }),
        960_000,
      ),
    ).toBeNull();
  });
});

describe("coveredThroughUnix", () => {
  const tip = { slot: 960_000, time: 1_750_000_000 } as ChainTip;
  const cursor = { slot: 960_000, txHash: "dd" };

  it("reaches the banked cursor when every listed tx was fetched", () => {
    expect(coveredThroughUnix(cursor, scanWith({}), tip)).toBe(tip.time);
  });

  it("holds below the oldest unfetched tx, though the cursor advanced past it", () => {
    const scan = scanWith({ unfetched: [{ txHash: "ee", slot: 950_000 }] });
    expect(coveredThroughUnix(cursor, scan, tip)).toBe(tip.time - 10_001);
  });

  it("is null before any cursor", () => {
    expect(coveredThroughUnix(null, scanWith({}), tip)).toBeNull();
  });
});

describe("planTrickle", () => {
  const FLOOR = 1_000;
  const settledTop = 900_000 - SETTLEMENT_MARGIN_SLOTS - 1;
  /** The main segment of a steady-state run whose cursor reached the tip. */
  const steady = planSegment(state({}), FLOOR);

  it("starts the rotation at the config floor with nothing banked", () => {
    expect(planTrickle(state({}), steady, FLOOR)).toEqual({
      from: { slot: FLOOR },
      sweepFromSlot: FLOOR,
      toSlot: settledTop,
    });
  });

  it("continues strictly after the banked rotation cursor", () => {
    const plan = planTrickle(
      state({ trickle: { slot: 500_000, txHash: "aa" } }),
      steady,
      FLOOR,
    );
    expect(plan!.from).toEqual({ slot: 500_000, txHash: "aa" });
    expect(plan!.sweepFromSlot).toBe(500_001);
    expect(plan!.toSlot).toBe(settledTop);
  });

  it("stops one slot below the run's own segment", () => {
    // Two integrations in one refresh; neither may sweep where the other
    // wrote. The main segment's floor lags the cursor by a run, so it is the
    // lower of the two bounds whenever the tip has moved.
    const behind = { sweepFromSlot: 600_000 };
    expect(planTrickle(state({}), behind, FLOOR)!.toSlot).toBe(599_999);
  });

  it("stops below the settlement margin when the segment swept above it", () => {
    // The run that finishes a catch-up: its segment continued from a cursor
    // near the tip, but nothing there is settled enough to rescan.
    const catchUp = planSegment(
      state({ caughtUp: false, cursor: { slot: 899_000, txHash: "bb" } }),
      FLOOR,
    );
    expect(planTrickle(state({}), catchUp, FLOOR)!.toSlot).toBe(settledTop);
  });

  it("rescans nothing while the main walk is catching up", () => {
    expect(planTrickle(state({ caughtUp: false }), steady, FLOOR)).toBeNull();
  });

  it("rescans nothing until something has settled below the margin", () => {
    expect(planTrickle(state({ cursor: null }), steady, FLOOR)).toBeNull();
    const young = planSegment(state({}), 850_000);
    expect(planTrickle(state({}), young, 850_000)).toBeNull();
  });
});

describe("nextTrickle", () => {
  const banked = { slot: 500_000, txHash: "aa" };

  it("moves on from the last row listed", () => {
    expect(nextTrickle(scanWith({ exhausted: false }), banked)).toEqual({
      slot: 950_000,
      txHash: "dd",
    });
  });

  it("wraps to the start once the settled prefix is exhausted", () => {
    expect(nextTrickle(scanWith({}), banked)).toBeNull();
  });

  it("holds its place when the scan was incomplete", () => {
    expect(
      nextTrickle(
        scanWith({
          records: {
            surveys: [],
            responses: [],
            cancellations: [],
            incomplete: true,
          },
        }),
        banked,
      ),
    ).toBe(banked);
  });
});

describe("snapshotTip", () => {
  // Two upstream reads are skipped by trusting this round-trip: a refresh
  // rebanks `gov_action_lifetime` when the stored epoch still holds, and
  // `/api/pparams` keys its Koios read on that same epoch. Every field must
  // therefore survive the wire encoding unwrapped — one bigint or bytes field
  // would come back as an object and silently break both.
  it("recovers the stored ChainTip as plain numbers", () => {
    const tip: ChainTip = {
      epoch: 511,
      slot: 1_000,
      time: 1_750_000_000,
      epochSlot: 100,
      govActionLifetime: 6,
    };

    const meta = {
      tip: JSON.stringify(toJsonSafe(tip)),
      incomplete: false,
      fetchedAt: 1_750_000_000,
      listCounts: null,
      settling: null,
    };

    expect(snapshotTip(meta)).toEqual(tip);
  });
});

describe("finality", () => {
  const tip = { epoch: 501 } as ChainTip;
  const sourceOf = (blocksLeft: number) => ({
    settling: vi.fn(async () => ({ epoch: 500, blocksLeft })),
  });

  it("holds the gate one epoch back while the last epoch settles", async () => {
    expect(await finality(sourceOf(120), tip, 499)).toEqual({
      finalThroughEpoch: 499,
      settling: { epoch: 500, blocksLeft: 120 },
    });
  });

  it("opens once the last epoch is k blocks deep", async () => {
    expect(await finality(sourceOf(0), tip, 499)).toEqual({
      finalThroughEpoch: 500,
      settling: null,
    });
  });

  it("does not ask the chain about an epoch already banked as final", async () => {
    const source = sourceOf(0);
    expect(await finality(source, tip, 500)).toEqual({
      finalThroughEpoch: 500,
      settling: null,
    });
    expect(source.settling).not.toHaveBeenCalled();
  });

  it("treats a failed read as not final yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = {
      settling: async () => {
        throw new Error("Koios 503");
      },
    };
    expect(await finality(source, tip, 499)).toEqual({
      finalThroughEpoch: 499,
      settling: null,
    });
    warn.mockRestore();
  });
});
