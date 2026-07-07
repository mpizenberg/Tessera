import { describe, expect, it } from "vitest";

import {
  GOV_LINK_KIND,
  anchorContextMapsCip179Terms,
  parseCip179Link,
} from "./govLink.js";

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

describe("anchorContextMapsCip179Terms", () => {
  const fullContext = () => ({
    "@context": {
      CIP179:
        "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0179/README.md#",
      body: {
        "@id": "CIP108:body",
        "@context": {
          title: "CIP108:title",
          cip179: {
            "@id": "CIP179:link",
            "@context": {
              specVersion: "CIP179:specVersion",
              kind: "CIP179:kind",
              surveyTxId: "CIP179:surveyTxId",
              surveyIndex: "CIP179:surveyIndex",
            },
          },
        },
      },
    },
  });

  it("accepts a context that maps the namespace and every sub-term", () => {
    expect(anchorContextMapsCip179Terms(fullContext())).toBe(true);
  });

  it("rejects a missing CIP179 namespace at the root", () => {
    const doc = fullContext();
    delete (doc["@context"] as Record<string, unknown>)["CIP179"];
    expect(anchorContextMapsCip179Terms(doc)).toBe(false);
  });

  it("rejects a missing cip179 term in the body context", () => {
    const doc = fullContext();
    delete (
      (doc["@context"].body as Record<string, unknown>)["@context"] as Record<
        string,
        unknown
      >
    )["cip179"];
    expect(anchorContextMapsCip179Terms(doc)).toBe(false);
  });

  it("rejects when any sub-term is unmapped", () => {
    const doc = fullContext();
    const cipCtx = (
      (doc["@context"].body as Record<string, unknown>)["@context"] as Record<
        string,
        Record<string, unknown>
      >
    )["cip179"]["@context"] as Record<string, unknown>;
    delete cipCtx["surveyIndex"];
    expect(anchorContextMapsCip179Terms(doc)).toBe(false);
  });

  it("rejects a bare or absent @context", () => {
    expect(anchorContextMapsCip179Terms({ "@context": {} })).toBe(false);
    expect(anchorContextMapsCip179Terms({})).toBe(false);
    expect(anchorContextMapsCip179Terms(null)).toBe(false);
  });
});
