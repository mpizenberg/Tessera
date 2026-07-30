import { describe, expect, it } from "vitest";

import {
  GOV_LINK_KIND,
  anchorContextMapsCip179Terms,
  parseCip179Link,
  parseGovLinkDoc,
} from "./govLink.js";

const TXID = "a".repeat(64);

const wellFormed = (over: Record<string, unknown> = {}) => ({
  "@context": {},
  body: {
    title: "A poll",
    cip179: {
      specVersion: 5,
      kind: GOV_LINK_KIND,
      surveyTxId: TXID,
      surveyIndex: 3,
      ...over,
    },
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

  // Finding 46 — the declared revision is reported so a reader can see it, but
  // the CIP's link-validation rules are addressing + kind, so it never
  // suppresses the ref.
  describe("specVersion is reported, not enforced", () => {
    it("reads the declared revision", () => {
      expect(parseCip179Link(wellFormed()).specVersion).toBe(5);
    });

    it("keeps the link of another revision, and says so", () => {
      const r = parseCip179Link(wellFormed({ specVersion: 4 }));
      expect(r.surveyRef).toEqual({ txId: TXID, index: 3 });
      expect(r.specVersion).toBe(4);
      expect(r.problems.some((p) => p.includes("specVersion"))).toBe(true);
    });

    it("keeps the link when the field is absent or malformed", () => {
      for (const bad of [undefined, "5", 5.5, null]) {
        const r = parseCip179Link(wellFormed({ specVersion: bad }));
        expect(r.surveyRef).toEqual({ txId: TXID, index: 3 });
        expect(r.specVersion).toBeNull();
        expect(r.problems.some((p) => p.includes("specVersion"))).toBe(true);
      }
    });
  });
});

// What a reader keeps from a verified anchor document: the survey it names and
// the title to show. Everything else about a link — which action carries it,
// when that action expires — is the action's own on-chain identity, so it is
// deliberately not derivable here.
describe("parseGovLinkDoc", () => {
  it("extracts the survey key and title from body.cip179", () => {
    expect(
      parseGovLinkDoc(wellFormed({ surveyTxId: "AB".repeat(32) })),
    ).toEqual({
      surveyKey: `${"ab".repeat(32)}:3`, // tx id lower-cased, joined with the index
      title: "A poll",
    });
  });

  it("reports no title rather than a non-string one", () => {
    const doc = wellFormed();
    doc.body.title = 7 as unknown as string;
    expect(parseGovLinkDoc(doc)?.title).toBeNull();
    const untitled = wellFormed();
    delete (untitled.body as { title?: unknown }).title;
    expect(parseGovLinkDoc(untitled)?.title).toBeNull();
  });

  it("is null when the addressing doesn't fully check out", () => {
    // Each of these can't address a real survey, so it is not a link at all —
    // never a partial one that would resolve to survey 0 of some transaction.
    expect(parseGovLinkDoc(wellFormed({ kind: "something-else" }))).toBeNull();
    expect(parseGovLinkDoc(wellFormed({ surveyTxId: "9a1c" }))).toBeNull();
    expect(parseGovLinkDoc(wellFormed({ surveyIndex: -1 }))).toBeNull();
    expect(parseGovLinkDoc(wellFormed({ surveyIndex: 1.5 }))).toBeNull();
    expect(parseGovLinkDoc(wellFormed({ surveyIndex: "0" }))).toBeNull();
  });

  // A link at another CIP-179 revision is still a link (the CIP's rules are the
  // ref resolving, the epoch alignment and the kind), so it must survive here.
  it("keeps a link declaring a foreign specVersion", () => {
    expect(parseGovLinkDoc(wellFormed({ specVersion: 99 }))?.surveyKey).toBe(
      `${TXID}:3`,
    );
  });

  it("is null for a document that carries no link at all", () => {
    expect(parseGovLinkDoc({ body: { title: "Just a normal action" } })).toBeNull();
    expect(parseGovLinkDoc({ hashAlgorithm: "blake2b-256" })).toBeNull();
    expect(parseGovLinkDoc(null)).toBeNull();
    expect(parseGovLinkDoc("not an object")).toBeNull();
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
