import { describe, expect, it } from "vitest";
import type { Role } from "cip-179";

import type { ChainTip, ResponseRecord } from "~/data/source";
import { auditResponses, epochOfSlot } from "./audit";

// secondsPerEpoch = 100 → epochs are 100 slots; current epoch 10 starts at
// slot 1000 (tip.slot − tip.epochSlot). Easy mental math for the cases below.
const TIP: ChainTip = { epoch: 10, slot: 1050, epochSlot: 50, time: 1_000_000 };
const SPE = 100;

const keyCred = (b: number) => ({
  type: "key" as const,
  keyHash: Uint8Array.of(b),
});
const REF = { txId: Uint8Array.of(9), index: 0 };

function rec(
  txHash: string,
  slot: number,
  role: Role,
  cred: number,
): ResponseRecord {
  return {
    txHash,
    slot,
    response: {
      specVersion: 4,
      surveyRef: REF,
      role,
      credential: keyCred(cred),
      answers: { type: "public", answers: [] },
    },
  };
}

describe("epochOfSlot", () => {
  it("places slots into the right epoch relative to the tip", () => {
    expect(epochOfSlot(1050, TIP, SPE)).toBe(10); // current epoch
    expect(epochOfSlot(1000, TIP, SPE)).toBe(10); // exact epoch start
    expect(epochOfSlot(999, TIP, SPE)).toBe(9); // one slot before → prev epoch
    expect(epochOfSlot(900, TIP, SPE)).toBe(9); // start of prev epoch
    expect(epochOfSlot(899, TIP, SPE)).toBe(8); // two epochs back
  });
});

describe("auditResponses", () => {
  it("counts all on-time, distinct responses with no exclusions", () => {
    const raw = [rec("a", 950, 0, 1), rec("b", 960, 1, 2)];
    const audit = auditResponses(raw, 9, TIP, SPE);
    expect(audit.counted).toHaveLength(2);
    expect(audit.excluded).toEqual([]);
    expect(audit.excludedTotal).toBe(0);
  });

  it("excludes earlier duplicates as superseded (latest-wins)", () => {
    const raw = [rec("a", 950, 0, 1), rec("b", 960, 0, 1)];
    const audit = auditResponses(raw, 9, TIP, SPE);
    expect(audit.counted).toHaveLength(1);
    expect(audit.counted[0]!.slot).toBe(960); // the later one wins
    expect(audit.excluded).toEqual([
      {
        key: "superseded",
        label: "Superseded by a later response",
        hint: "same role + credential · latest-wins",
        count: 1,
      },
    ]);
  });

  it("excludes responses recorded after the end epoch", () => {
    const raw = [rec("a", 950, 0, 1), rec("late", 1050, 0, 2)]; // 1050 → epoch 10
    const audit = auditResponses(raw, 9, TIP, SPE);
    expect(audit.counted).toHaveLength(1);
    expect(audit.counted[0]!.txHash).toBe("a");
    expect(audit.excluded).toEqual([
      {
        key: "after-deadline",
        label: "Submitted after the deadline",
        hint: "recorded past end_epoch 9",
        count: 1,
      },
    ]);
  });

  it("a late response never suppresses an on-time one for the same identity", () => {
    // Same role+credential: late slot 1050 is dropped first, so the on-time
    // slot 950 is counted (not treated as superseded by the invalid later one).
    const raw = [rec("ontime", 950, 1, 1), rec("late", 1050, 1, 1)];
    const audit = auditResponses(raw, 9, TIP, SPE);
    expect(audit.counted).toHaveLength(1);
    expect(audit.counted[0]!.txHash).toBe("ontime");
    expect(audit.excludedTotal).toBe(1);
    expect(audit.excluded.map((e) => e.key)).toEqual(["after-deadline"]);
  });

  it("reports both categories together, deadline first", () => {
    const raw = [
      rec("a", 940, 0, 1),
      rec("b", 950, 0, 1), // supersedes a
      rec("late", 1050, 2, 3), // after deadline
    ];
    const audit = auditResponses(raw, 9, TIP, SPE);
    expect(audit.counted).toHaveLength(1);
    expect(audit.excludedTotal).toBe(2);
    expect(audit.excluded.map((e) => e.key)).toEqual([
      "after-deadline",
      "superseded",
    ]);
  });
});
