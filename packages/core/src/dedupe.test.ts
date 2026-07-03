import { describe, expect, it } from "vitest";

import { Role, type Credential, type SurveyRef } from "cip-179";

import {
  credentialKey,
  dedupeResponses,
  laterInChain,
  refKey,
  responseCounts,
} from "./dedupe";
import type { ResponseRecord } from "./source";

const refA: SurveyRef = { txId: new Uint8Array([0xaa, 0x01]), index: 0 };
const refB: SurveyRef = { txId: new Uint8Array([0xbb, 0x02]), index: 1 };

const keyCred = (byte: number): Credential => ({
  type: "key",
  keyHash: new Uint8Array([byte]),
});

function record(
  ref: SurveyRef,
  cred: Credential,
  slot: number,
  txHash: string,
  role: Role = Role.Stakeholder,
  pos: { responseIndex?: number; blockIndex?: number } = {},
): ResponseRecord {
  return {
    txHash,
    slot,
    epochNo: 10,
    responseIndex: pos.responseIndex ?? 0,
    ...(pos.blockIndex !== undefined && { blockIndex: pos.blockIndex }),
    response: {
      specVersion: 1,
      surveyRef: ref,
      role,
      credential: cred,
      answers: { type: "public", answers: [] },
    },
  };
}

describe("refKey / credentialKey", () => {
  it("renders '<txHex>:<index>' and 'kind:<hex>'", () => {
    expect(refKey(refA)).toBe("aa01:0");
    expect(refKey(refB)).toBe("bb02:1");
    expect(credentialKey(keyCred(0x1f))).toBe("key:1f");
    expect(
      credentialKey({ type: "script", scriptHash: new Uint8Array([0x1f]) }),
    ).toBe("script:1f");
  });

  it("keeps key and script credentials with the same hash distinct", () => {
    const hash = new Uint8Array([0x42]);
    expect(credentialKey({ type: "key", keyHash: hash })).not.toBe(
      credentialKey({ type: "script", scriptHash: hash }),
    );
  });
});

describe("laterInChain", () => {
  const at = (
    slot: number,
    pos: { responseIndex?: number; blockIndex?: number } = {},
  ) => record(refA, keyCred(1), slot, "t", Role.Stakeholder, pos);

  it("orders by slot first", () => {
    expect(laterInChain(at(200), at(100))).toBe(true);
    expect(laterInChain(at(100), at(200))).toBe(false);
  });

  it("breaks slot ties by tx position within the block", () => {
    expect(
      laterInChain(at(100, { blockIndex: 3 }), at(100, { blockIndex: 1 })),
    ).toBe(true);
    expect(
      laterInChain(at(100, { blockIndex: 1 }), at(100, { blockIndex: 3 })),
    ).toBe(false);
  });

  it("a missing blockIndex sorts before any present one (-1)", () => {
    expect(laterInChain(at(100, { blockIndex: 0 }), at(100))).toBe(true);
    expect(laterInChain(at(100), at(100, { blockIndex: 0 }))).toBe(false);
  });

  it("breaks full ties by position within the payload's responses array", () => {
    expect(
      laterInChain(
        at(100, { responseIndex: 2 }),
        at(100, { responseIndex: 1 }),
      ),
    ).toBe(true);
    expect(
      laterInChain(
        at(100, { responseIndex: 1 }),
        at(100, { responseIndex: 1 }),
      ),
    ).toBe(false);
  });
});

describe("dedupeResponses", () => {
  it("keeps the highest-slot response per (survey, role, credential)", () => {
    const early = record(refA, keyCred(1), 100, "tx-early");
    const late = record(refA, keyCred(1), 200, "tx-late");
    expect(dedupeResponses([early, late])).toEqual([late]);
    expect(dedupeResponses([late, early])).toEqual([late]);
  });

  it("breaks slot ties by (blockIndex, responseIndex), independent of input order", () => {
    const a = record(refA, keyCred(1), 100, "a", Role.Stakeholder, {
      blockIndex: 1,
      responseIndex: 5,
    });
    const b = record(refA, keyCred(1), 100, "b", Role.Stakeholder, {
      blockIndex: 2,
      responseIndex: 0,
    });
    expect(dedupeResponses([a, b])).toEqual([b]);
    expect(dedupeResponses([b, a])).toEqual([b]);

    const c = record(refA, keyCred(1), 100, "c", Role.Stakeholder, {
      responseIndex: 1,
    });
    const d = record(refA, keyCred(1), 100, "d", Role.Stakeholder, {
      responseIndex: 2,
    });
    expect(dedupeResponses([d, c])).toEqual([d]);
  });

  it("treats survey, role, and credential as independent identities", () => {
    const records = [
      record(refA, keyCred(1), 100, "t1"),
      record(refB, keyCred(1), 100, "t2"), // other survey
      record(refA, keyCred(2), 100, "t3"), // other credential
      record(refA, keyCred(1), 100, "t4", Role.DRep), // other role
    ];
    expect(dedupeResponses(records)).toHaveLength(4);
  });
});

describe("responseCounts", () => {
  it("counts distinct responders per survey key, after dedupe", () => {
    const records = [
      record(refA, keyCred(1), 100, "t1"),
      record(refA, keyCred(1), 200, "t2"), // supersedes t1
      record(refA, keyCred(2), 100, "t3"),
      record(refB, keyCred(1), 100, "t4"),
    ];
    expect(responseCounts(records)).toEqual({ "aa01:0": 2, "bb02:1": 1 });
    expect(responseCounts([])).toEqual({});
  });
});
