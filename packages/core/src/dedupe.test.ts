import { describe, expect, it } from "vitest";

import { Role, type Credential, type SurveyRef } from "cip-179";

import {
  credentialKey,
  dedupeResponses,
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
): ResponseRecord {
  return {
    txHash,
    slot,
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

describe("dedupeResponses", () => {
  it("keeps the highest-slot response per (survey, role, credential)", () => {
    const early = record(refA, keyCred(1), 100, "tx-early");
    const late = record(refA, keyCred(1), 200, "tx-late");
    expect(dedupeResponses([early, late])).toEqual([late]);
    expect(dedupeResponses([late, early])).toEqual([late]);
  });

  it("breaks slot ties by tx hash, independent of input order", () => {
    const a = record(refA, keyCred(1), 100, "aaaa");
    const b = record(refA, keyCred(1), 100, "bbbb");
    expect(dedupeResponses([a, b])).toEqual([b]);
    expect(dedupeResponses([b, a])).toEqual([b]);
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
