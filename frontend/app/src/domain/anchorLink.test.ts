import { describe, expect, it } from "vitest";

import { SPEC_VERSION } from "cip-179";
import {
  anchorContextMapsCip179Terms,
  parseCip179Link,
  parseGovLinkDoc,
} from "cip-179/domain";

import {
  anchorFromText,
  buildLinkedAnchor,
  injectSurveyLink,
  validateAnchorShape,
  computeAlignment,
} from "./anchorLink";

const REF = {
  txId: "ab".repeat(32),
  index: 3,
};

const FIELDS = {
  title: "Try the survey",
  abstract: "An abstract.",
  motivation: "A motivation.",
  rationale: "A rationale.",
};

/** A CIP-108 document the way external governance tooling emits it: no
 * `body.cip179`, no CIP-179 context terms, a signed author witness. */
const external = () => ({
  "@context": {
    "@language": "en-us",
    CIP100:
      "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#",
    CIP108:
      "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0108/README.md#",
    hashAlgorithm: "CIP100:hashAlgorithm",
    body: {
      "@id": "CIP108:body",
      "@context": {
        title: "CIP108:title",
        abstract: "CIP108:abstract",
        motivation: "CIP108:motivation",
        rationale: "CIP108:rationale",
      },
    },
    authors: { "@id": "CIP100:authors", "@container": "@set" },
  },
  hashAlgorithm: "blake2b-256",
  authors: [
    {
      name: "Jane Doe",
      witness: {
        witnessAlgorithm: "ed25519",
        publicKey: "aa",
        signature: "bb",
      },
    },
  ],
  body: {
    title: "Some governance action",
    abstract: "Abstract.",
    motivation: "Motivation.",
    rationale: "Rationale.",
    references: [{ "@type": "Other", label: "x", uri: "https://example.com" }],
  },
});

// Every emitted document goes back through the *reading* validators — the
// generator and the discovery layer cannot drift apart unnoticed.
function expectValidLink(text: string) {
  const parsed: unknown = JSON.parse(text);
  const link = parseCip179Link(parsed);
  expect(link.problems).toEqual([]);
  expect(link.surveyRef).toEqual(REF);
  expect(link.specVersion).toBe(SPEC_VERSION);
  expect(anchorContextMapsCip179Terms(parsed)).toBe(true);
  expect(validateAnchorShape(text).problems).toEqual([]);
}

describe("buildLinkedAnchor", () => {
  it("emits a document the reading validators accept", () => {
    expectValidLink(buildLinkedAnchor(FIELDS, REF));
  });

  it("carries the body fields where the discovery layer reads them", () => {
    const doc: unknown = JSON.parse(buildLinkedAnchor(FIELDS, REF));
    expect(parseGovLinkDoc(doc)).toEqual({
      surveyKey: `${REF.txId}:${REF.index}`,
      title: FIELDS.title,
    });
    const body = (doc as { body: Record<string, unknown> }).body;
    expect(body["abstract"]).toBe(FIELDS.abstract);
    expect(body["motivation"]).toBe(FIELDS.motivation);
    expect(body["rationale"]).toBe(FIELDS.rationale);
  });

  it("serializes with a trailing newline and hashes deterministically", () => {
    const text = buildLinkedAnchor(FIELDS, REF);
    expect(text.endsWith("}\n")).toBe(true);
    const a = anchorFromText("a.jsonld", text);
    const b = anchorFromText("b.jsonld", text);
    expect(a.hashHex).toBe(b.hashHex);
    expect(a.problems).toEqual([]);
    expect(a.surveyRef).toEqual(REF);
    expect(new TextDecoder().decode(a.bytes)).toBe(text);
  });
});

describe("injectSurveyLink", () => {
  it("links an external document and strips its author witness", () => {
    const res = injectSurveyLink(JSON.stringify(external()), REF);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.strippedAuthors).toBe(true);
    expectValidLink(res.text);
    const doc = JSON.parse(res.text) as Record<string, unknown>;
    expect(doc["authors"]).toEqual([]);
    // Unrelated fields survive the edit untouched.
    const body = doc["body"] as Record<string, unknown>;
    expect(body["title"]).toBe("Some governance action");
    expect(body["references"]).toEqual(external().body.references);
    expect(doc["hashAlgorithm"]).toBe("blake2b-256");
  });

  it("reports nothing stripped when the input carries no witness", () => {
    const doc = external() as Record<string, unknown>;
    delete doc["authors"];
    const res = injectSurveyLink(JSON.stringify(doc), REF);
    expect(res.ok && !res.strippedAuthors).toBe(true);
  });

  it("promotes a string-mapped body context to hold the CIP-179 terms", () => {
    const doc = external();
    (doc["@context"] as Record<string, unknown>)["body"] = "CIP108:body";
    const res = injectSurveyLink(JSON.stringify(doc), REF);
    expect(res.ok).toBe(true);
    if (res.ok) expectValidLink(res.text);
  });

  it("refuses an input that already carries a link, and names it", () => {
    const linked = buildLinkedAnchor(FIELDS, REF);
    const res = injectSurveyLink(linked, { txId: "cd".repeat(32), index: 0 });
    expect(res).toMatchObject({
      ok: false,
      reason: "alreadyLinked",
      linkedRef: REF,
    });
  });

  it("refuses non-documents with a precise reason", () => {
    const inject = (s: string) => injectSurveyLink(s, REF);
    expect(inject("not json")).toMatchObject({ ok: false, reason: "notJson" });
    expect(inject("[]")).toMatchObject({ ok: false, reason: "notObject" });
    expect(inject("{}")).toMatchObject({ ok: false, reason: "noBody" });
    expect(inject('{"body":{}}')).toMatchObject({
      ok: false,
      reason: "noContext",
    });
  });
});

describe("computeAlignment", () => {
  // Current epoch started at unix 1_900_000 and spans 432_000 s (5 days).
  const SPE = 432_000;
  const tip = (epoch: number) => ({
    epoch,
    slot: 130_000_000,
    time: 2_000_000,
    epochSlot: 100_000,
    govActionLifetime: 6,
  });
  const align = (epoch: number, surveyEndEpoch: number | undefined) =>
    computeAlignment({
      hasLink: true,
      tip: tip(epoch),
      surveyEndEpoch,
      secondsPerEpoch: SPE,
    });

  it("is ok exactly when now + lifetime hits the survey's end epoch", () => {
    const r = align(310, 316);
    expect(r?.level).toBe("ok");
    // The submit epoch is the current one, so its window is this epoch's wall
    // clock: [epoch start, epoch end).
    expect(r?.window).toEqual({
      submitEpoch: 310,
      startUnix: 1_900_000,
      endUnix: 1_900_000 + SPE,
    });
    expect(r?.text).not.toMatch(/\{\w+\}/);
  });

  it("is danger before and after the one aligned epoch, window stated", () => {
    const early = align(308, 316);
    expect(early?.level).toBe("danger");
    expect(early?.window).toEqual({
      submitEpoch: 310,
      startUnix: 1_900_000 + 2 * SPE,
      endUnix: 1_900_000 + 3 * SPE,
    });
    const late = align(311, 316);
    expect(late?.level).toBe("danger");
    expect(late?.window?.submitEpoch).toBe(310);
    expect(late?.text).not.toMatch(/\{\w+\}/);
  });

  it("is null without a link, warn (windowless) without data to judge", () => {
    expect(
      computeAlignment({
        hasLink: false,
        tip: tip(1),
        surveyEndEpoch: 2,
        secondsPerEpoch: SPE,
      }),
    ).toBeNull();
    const noTip = computeAlignment({
      hasLink: true,
      tip: undefined,
      surveyEndEpoch: 2,
      secondsPerEpoch: SPE,
    });
    expect(noTip).toMatchObject({ level: "warn" });
    expect(noTip?.window).toBeUndefined();
    expect(align(1, undefined)?.level).toBe("warn");
  });
});
