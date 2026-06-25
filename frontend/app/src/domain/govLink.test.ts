import { describe, expect, it } from "vitest";

import { GOV_LINK_KIND, parseCip179Link } from "./govLink";

const TXID = "a".repeat(64);

const wellFormed = (over: Record<string, unknown> = {}) => ({
  "@context": {},
  body: {
    title: "A poll",
    cip179: { kind: GOV_LINK_KIND, surveyTxId: TXID, surveyIndex: 3, ...over },
  },
});

describe("parseCip179Link", () => {
  it("extracts a lower-cased ref from a well-formed link with no problems", () => {
    const r = parseCip179Link(wellFormed({ surveyTxId: "AB".repeat(32) }));
    expect(r.problems).toEqual([]);
    expect(r.surveyRef).toEqual({ txId: "ab".repeat(32), index: 3 });
  });

  it("rejects non-object top levels", () => {
    for (const v of [null, 42, "x", [1, 2]]) {
      const r = parseCip179Link(v);
      expect(r.surveyRef).toBeNull();
      expect(r.problems).toEqual(["Top level must be a JSON object."]);
    }
  });

  it("flags a missing body and stops there", () => {
    const r = parseCip179Link({ "@context": {} });
    expect(r.surveyRef).toBeNull();
    expect(r.problems).toEqual(['Missing CIP-108 "body" object.']);
  });

  it("flags a missing body.cip179 link", () => {
    const r = parseCip179Link({ body: { title: "x" } });
    expect(r.surveyRef).toBeNull();
    expect(r.problems).toEqual(['Missing "body.cip179" survey link.']);
  });

  it("rejects a wrong kind (no ref even if the ids are valid)", () => {
    const r = parseCip179Link(wellFormed({ kind: "other" }));
    expect(r.surveyRef).toBeNull();
    expect(r.problems.some((p) => p.includes('"body.cip179.kind"'))).toBe(true);
  });

  it("rejects a non-64-hex surveyTxId", () => {
    const r = parseCip179Link(wellFormed({ surveyTxId: "abc" }));
    expect(r.surveyRef).toBeNull();
    expect(r.problems.some((p) => p.includes("surveyTxId"))).toBe(true);
  });

  it("rejects a missing / negative / non-integer surveyIndex", () => {
    for (const bad of [undefined, -1, 1.5, "0"]) {
      const r = parseCip179Link(wellFormed({ surveyIndex: bad }));
      expect(r.surveyRef).toBeNull();
      expect(r.problems.some((p) => p.includes("surveyIndex"))).toBe(true);
    }
  });

  it("accepts index 0", () => {
    const r = parseCip179Link(wellFormed({ surveyIndex: 0 }));
    expect(r.surveyRef).toEqual({ txId: TXID, index: 0 });
    expect(r.problems).toEqual([]);
  });
});
