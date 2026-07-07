import { describe, expect, it } from "vitest";
import type { AnswerItem, Role, SurveyDefinition } from "../index.js";

import type { SurveyResponse } from "../index.js";

import type { ChainTip, ResponseRecord } from "./records.js";
import {
  auditResponses,
  auditRevealedResponses,
  epochOfSlot,
  responseIsCountable,
} from "./audit.js";

// secondsPerEpoch = 100 → epochs are 100 slots; current epoch 10 starts at
// slot 1000 (tip.slot − tip.epochSlot). Easy mental math for the cases below.
const TIP: ChainTip = {
  epoch: 10,
  slot: 1050,
  epochSlot: 50,
  time: 1_000_000,
  govActionLifetime: 6,
};
const SPE = 100;

const keyCred = (b: number) => ({
  type: "key" as const,
  keyHash: Uint8Array.of(b),
});
const REF = { txId: Uint8Array.of(9), index: 0 };

/** Base definition: end_epoch 9, roles 0–3 eligible, no questions (so the
 *  empty-answer responses the deadline/dedup cases use validate cleanly). */
const DEF: SurveyDefinition = {
  specVersion: 4,
  owner: keyCred(0),
  title: "t",
  description: "",
  eligibleRoles: [0, 1, 2, 3] as Role[],
  endEpoch: 9,
  submissionMode: { type: "public" },
  questions: [],
};

/** Same window, but with one (optional) single-choice question of two options —
 *  used to exercise out-of-constraint answers. */
const DEF_SC: SurveyDefinition = {
  ...DEF,
  questions: [
    {
      type: "singleChoice",
      prompt: "",
      options: { type: "options", labels: ["a", "b"] },
    },
  ],
};

const sc = (optionIndex: number): AnswerItem => ({
  type: "singleChoice",
  questionIndex: 0,
  optionIndex,
});

/** epochNo derives from the slot on the same 100-slot grid as TIP above. */
function recWith(
  txHash: string,
  slot: number,
  role: Role,
  cred: number,
  answers: AnswerItem[],
): ResponseRecord {
  return {
    txHash,
    slot,
    epochNo: Math.floor(slot / 100),
    responseIndex: 0,
    response: {
      specVersion: 4,
      surveyRef: REF,
      role,
      credential: keyCred(cred),
      answers: { type: "public", answers },
    },
  };
}

const rec = (txHash: string, slot: number, role: Role, cred: number) =>
  recWith(txHash, slot, role, cred, []);

describe("epochOfSlot", () => {
  it("places slots into the right epoch relative to the tip", () => {
    expect(epochOfSlot(1050, TIP, SPE)).toBe(10); // current epoch
    expect(epochOfSlot(1000, TIP, SPE)).toBe(10); // exact epoch start
    expect(epochOfSlot(999, TIP, SPE)).toBe(9); // one slot before → prev epoch
    expect(epochOfSlot(900, TIP, SPE)).toBe(9); // start of prev epoch
    expect(epochOfSlot(899, TIP, SPE)).toBe(8); // two epochs back
  });
});

describe("responseIsCountable", () => {
  it("accepts an in-constraint answer and rejects an out-of-range one", () => {
    expect(
      responseIsCountable(DEF_SC, recWith("", 0, 0, 1, [sc(0)]).response),
    ).toBe(true);
    expect(
      responseIsCountable(DEF_SC, recWith("", 0, 0, 1, [sc(5)]).response),
    ).toBe(false);
  });

  it("rejects a response whose role is not eligible", () => {
    // 4 is not in DEF.eligibleRoles.
    expect(responseIsCountable(DEF, rec("", 0, 4 as Role, 1).response)).toBe(
      false,
    );
  });
});

const pub = (
  role: Role,
  cred: number,
  answers: AnswerItem[],
): SurveyResponse => ({
  specVersion: 4,
  surveyRef: REF,
  role,
  credential: keyCred(cred),
  answers: { type: "public", answers },
});

describe("auditRevealedResponses", () => {
  it("dedups only the valid decrypted set (latest-valid-wins)", () => {
    // Two valid ballots for the same identity: the chain-later one wins, the
    // earlier is superseded.
    const inWindow = [
      recWith("early", 940, 0, 1, [sc(0)]),
      recWith("late", 950, 0, 1, [sc(1)]),
    ];
    const revealed = [pub(0, 1, [sc(0)]), pub(0, 1, [sc(1)])];
    const r = auditRevealedResponses(inWindow, revealed, DEF_SC);
    expect(r.counted.map((x) => x.txHash)).toEqual(["late"]);
    expect(r.superseded.map((x) => x.txHash)).toEqual(["early"]);
    expect(r.invalid).toEqual([]);
    expect(r.failed).toEqual([]);
  });

  it("an invalid later ballot does NOT supersede a valid earlier one (finding 2)", () => {
    // Same identity: the later ciphertext decodes to an out-of-constraint answer.
    // It must be dropped as invalid, and the valid earlier one must be counted —
    // never suppressed by a ballot that only looked structurally valid while sealed.
    const inWindow = [
      recWith("early", 940, 0, 1, [sc(0)]),
      recWith("laterBad", 950, 0, 1, [sc(0)]),
    ];
    const revealed = [pub(0, 1, [sc(0)]), pub(0, 1, [sc(9)])]; // 9 is out of range
    const r = auditRevealedResponses(inWindow, revealed, DEF_SC);
    expect(r.counted.map((x) => x.txHash)).toEqual(["early"]);
    expect(r.superseded).toEqual([]);
    expect(r.invalid.map((x) => x.txHash)).toEqual(["laterBad"]);
    expect(r.failed).toEqual([]);
  });

  it("an undecryptable later ballot does NOT supersede a valid earlier one (finding 2)", () => {
    const inWindow = [
      recWith("early", 940, 0, 1, [sc(0)]),
      recWith("laterFail", 950, 0, 1, [sc(0)]),
    ];
    const revealed = [pub(0, 1, [sc(0)]), null]; // later decrypt/decode failed
    const r = auditRevealedResponses(inWindow, revealed, DEF_SC);
    expect(r.counted.map((x) => x.txHash)).toEqual(["early"]);
    expect(r.superseded).toEqual([]);
    expect(r.failed.map((x) => x.txHash)).toEqual(["laterFail"]);
    expect(r.invalid).toEqual([]);
  });

  it("carries the decrypted answers onto the counted record", () => {
    const inWindow = [recWith("a", 940, 0, 1, [])];
    const r = auditRevealedResponses(inWindow, [pub(0, 1, [sc(1)])], DEF_SC);
    expect(r.counted[0]!.response.answers).toEqual({
      type: "public",
      answers: [sc(1)],
    });
  });
});

describe("auditResponses", () => {
  it("counts all on-time, distinct responses with no exclusions", () => {
    const raw = [rec("a", 950, 0, 1), rec("b", 960, 1, 2)];
    const audit = auditResponses(raw, DEF);
    expect(audit.counted).toHaveLength(2);
    expect(audit.excludedRecords).toEqual([]);
  });

  it("excludes earlier duplicates as superseded (latest-wins)", () => {
    const raw = [rec("a", 950, 0, 1), rec("b", 960, 0, 1)];
    const audit = auditResponses(raw, DEF);
    expect(audit.counted).toHaveLength(1);
    expect(audit.counted[0]!.slot).toBe(960); // the later one wins
    // The superseded record itself is retained, tagged, for per-response audit.
    expect(audit.excludedRecords).toHaveLength(1);
    expect(audit.excludedRecords[0]!.key).toBe("superseded");
    expect(audit.excludedRecords[0]!.record.txHash).toBe("a"); // the earlier one
  });

  it("excludes responses recorded after the end epoch", () => {
    const raw = [rec("a", 950, 0, 1), rec("late", 1050, 0, 2)]; // 1050 → epoch 10
    const audit = auditResponses(raw, DEF);
    expect(audit.counted).toHaveLength(1);
    expect(audit.counted[0]!.txHash).toBe("a");
    expect(audit.excludedRecords).toHaveLength(1);
    expect(audit.excludedRecords[0]!.key).toBe("after-deadline");
    expect(audit.excludedRecords[0]!.record.txHash).toBe("late");
  });

  it("the deadline reads the record's epochNo, not a slot estimate", () => {
    // In-window slot but an authoritative epochNo past the deadline (e.g. a
    // chain where the slot grid assumption breaks): the explicit epoch decides.
    const late = { ...rec("x", 950, 0, 1), epochNo: 10 };
    const audit = auditResponses([late], DEF);
    expect(audit.excludedRecords.map((e) => e.key)).toEqual(["after-deadline"]);
  });

  it("a late response never suppresses an on-time one for the same identity", () => {
    // Same role+credential: late slot 1050 is dropped first, so the on-time
    // slot 950 is counted (not treated as superseded by the invalid later one).
    const raw = [rec("ontime", 950, 1, 1), rec("late", 1050, 1, 1)];
    const audit = auditResponses(raw, DEF);
    expect(audit.counted).toHaveLength(1);
    expect(audit.counted[0]!.txHash).toBe("ontime");
    expect(audit.excludedRecords.map((e) => e.key)).toEqual(["after-deadline"]);
  });

  it("excludes an out-of-constraint answer as invalid", () => {
    const raw = [
      recWith("ok", 950, 0, 1, [sc(0)]), // valid option
      recWith("bad", 960, 1, 2, [sc(5)]), // optionIndex out of range
    ];
    const audit = auditResponses(raw, DEF_SC);
    expect(audit.counted.map((r) => r.txHash)).toEqual(["ok"]);
    expect(audit.excludedRecords).toHaveLength(1);
    expect(audit.excludedRecords[0]!.key).toBe("invalid");
    expect(audit.excludedRecords[0]!.record.txHash).toBe("bad");
  });

  it("an invalid later response does not supersede a valid earlier one", () => {
    // Same role+credential: the later response is invalid, so it must be dropped
    // *before* dedup and must not knock out the valid earlier one.
    const raw = [
      recWith("early", 950, 0, 1, [sc(0)]), // valid
      recWith("laterBad", 960, 0, 1, [sc(9)]), // invalid, same identity
    ];
    const audit = auditResponses(raw, DEF_SC);
    expect(audit.counted.map((r) => r.txHash)).toEqual(["early"]);
    expect(audit.excludedRecords.map((e) => e.key)).toEqual(["invalid"]);
  });

  it("retains all three exclusion categories together", () => {
    const raw = [
      recWith("a", 940, 0, 1, [sc(0)]), // valid, superseded by b
      recWith("b", 950, 0, 1, [sc(1)]), // valid, latest-wins
      recWith("bad", 955, 3, 9, [sc(7)]), // invalid answer
      recWith("late", 1050, 2, 3, [sc(0)]), // after deadline
    ];
    const audit = auditResponses(raw, DEF_SC);
    expect(audit.counted.map((r) => r.txHash)).toEqual(["b"]);
    // Compared order-independently: after-deadline/invalid are emitted in raw
    // order during the scan, superseded after dedup — what matters is each
    // record lands in the right bucket.
    const got = audit.excludedRecords
      .map((e) => `${e.key}:${e.record.txHash}`)
      .sort();
    expect(got).toEqual(
      ["after-deadline:late", "invalid:bad", "superseded:a"].sort(),
    );
  });
});
