import { describe, expect, it } from "vitest";

import type { ChainTip } from "cip-179/domain";

import { finalityNotice, type FinalityInputs } from "./finalityNotice";

// Preview: k is 432, the stability window 25 920 slots.
const tipAt = (epochSlot: number): ChainTip => ({
  epoch: 1_346,
  slot: 1_000_000 + epochSlot,
  time: 1_750_000_000 + epochSlot,
  epochSlot,
  govActionLifetime: 6,
});

const closed: FinalityInputs = {
  network: "preview",
  tip: tipAt(6_000),
  status: "ended",
  talliable: true,
  endEpoch: 1_345,
  settling: { epoch: 1_345, blocksLeft: 232 },
  finalizes: true,
  decided: false,
};

describe("finalityNotice", () => {
  it("estimates the wait from the rate the epoch has produced blocks at", () => {
    // 200 blocks in 6 000 s is 30 s a block; 232 to go is 6 960 s, 1.93 h.
    expect(finalityNotice(closed)).toEqual({ kind: "settling", hoursLeft: 2 });
  });

  it("falls back to a block every 1/f seconds before any block is seen", () => {
    // 432 blocks at 20 s is 2.4 h.
    const notice = finalityNotice({
      ...closed,
      tip: tipAt(0),
      settling: { epoch: 1_345, blocksLeft: 432 },
    });
    expect(notice).toEqual({ kind: "settling", hoursLeft: 2.5 });
  });

  it("never promises later than the stability window", () => {
    // 10 blocks in 24 000 s would put 422 more at 281 hours; the window ends
    // 1 920 s from now.
    const notice = finalityNotice({
      ...closed,
      tip: tipAt(24_000),
      settling: { epoch: 1_345, blocksLeft: 422 },
    });
    expect(notice).toEqual({ kind: "settling", hoursLeft: 0 });
  });

  it("reports under an hour as 0", () => {
    const notice = finalityNotice({
      ...closed,
      tip: tipAt(12_000),
      settling: { epoch: 1_345, blocksLeft: 30 },
    });
    expect(notice).toEqual({ kind: "settling", hoursLeft: 0 });
  });

  it("says the result is being prepared once the end epoch is final", () => {
    expect(finalityNotice({ ...closed, settling: undefined })).toEqual({
      kind: "finalizing",
    });
    // Another epoch settling says nothing about this survey's.
    expect(finalityNotice({ ...closed, endEpoch: 1_340 })).toEqual({
      kind: "finalizing",
    });
  });

  it("says nothing of a decided, open, cancelled or untalliable survey", () => {
    expect(finalityNotice({ ...closed, decided: true })).toBeNull();
    expect(finalityNotice({ ...closed, status: "active" })).toBeNull();
    expect(finalityNotice({ ...closed, status: "cancelled" })).toBeNull();
    expect(finalityNotice({ ...closed, talliable: false })).toBeNull();
  });

  it("says nothing when the source finalizes nothing", () => {
    expect(finalityNotice({ ...closed, finalizes: false })).toBeNull();
  });
});
