/**
 * The refresh's pure decision points: how a run resumes the segment walk from
 * the banked state, and which slots its sweep may delete in.
 */

import { describe, expect, it } from "vitest";

import type { ChainTip } from "cip-179/domain";
import { toJsonSafe } from "cip-179/tally";
import type { SegmentScan } from "cardano-tessera-koios";

import {
  coveredRange,
  planSegment,
  SCAN_GENERATION,
  SETTLEMENT_MARGIN_SLOTS,
} from "./refresh";
import { snapshotTip, type ScanState } from "./store";

const state = (over: Partial<ScanState>): ScanState => ({
  cursor: { slot: 900_000, txHash: "cc" },
  caughtUp: true,
  generation: SCAN_GENERATION,
  trickle: null,
  ...over,
});

describe("planSegment", () => {
  it("walks from the config floor with no banked cursor", () => {
    expect(planSegment(null, 1_000)).toEqual({
      from: { slot: 1_000 },
      sweepFromSlot: 1_000,
    });
  });

  it("re-derives the settlement margin below a caught-up cursor", () => {
    const plan = planSegment(state({}), 1_000);
    expect(plan.from).toEqual({ slot: 900_000 - SETTLEMENT_MARGIN_SLOTS });
    expect(plan.sweepFromSlot).toBe(900_000 - SETTLEMENT_MARGIN_SLOTS);
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
  });
});

const scanWith = (over: Partial<SegmentScan>): SegmentScan => ({
  records: { surveys: [], responses: [], cancellations: [], incomplete: false },
  cursor: { slot: 950_000, txHash: "dd" },
  exhausted: true,
  ...over,
});

describe("coveredRange", () => {
  const plan = { from: { slot: 700_000 }, sweepFromSlot: 700_000 };

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

  it("covers nothing when the walk never left its starting slot", () => {
    expect(
      coveredRange(
        { from: { slot: 950_000, txHash: "aa" }, sweepFromSlot: 950_001 },
        scanWith({ exhausted: false, cursor: { slot: 950_000, txHash: "zz" } }),
        960_000,
      ),
    ).toBeNull();
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
    };

    expect(snapshotTip(meta)).toEqual(tip);
  });
});
