import { describe, expect, it } from "vitest";

import { parseGovLink, type ProposalRow } from "./koios";

// A CIP-108 anchor doc where a survey link lives at `body.cip179`, as produced
// by the LinkActionPanel and described in CIP-179. Sub-objects are spread in so
// individual fields can be overridden per case.
function anchor(opts: {
  title?: unknown;
  cip179?: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if ("title" in opts) body["title"] = opts.title;
  if ("cip179" in opts) body["cip179"] = opts.cip179;
  return { hashAlgorithm: "blake2b-256", body, authors: [] };
}

function row(meta_json: unknown, expiration: number | null = 42): ProposalRow {
  return {
    proposal_id: "gov_action1abc",
    proposal_type: "InfoAction",
    expiration,
    meta_json,
  };
}

// 64-char hex tx id, upper-case on purpose: surveyKey must lower-case it.
const TXID = "9A1C".repeat(16);
const LINK = {
  specVersion: 4,
  kind: "survey-link",
  surveyTxId: TXID,
  surveyIndex: 2,
};

describe("parseGovLink", () => {
  it("extracts a well-formed link from body.cip179", () => {
    const link = parseGovLink(
      row(anchor({ title: "Ratify the budget", cip179: LINK })),
    );
    expect(link).toEqual({
      surveyKey: `${TXID.toLowerCase()}:2`, // tx id lower-cased, joined with the index
      actionId: "gov_action1abc",
      // Koios expiration 42 → voting-end epoch 41 (one before the drop-out epoch).
      endEpoch: 41,
      title: "Ratify the budget",
    });
  });

  it("returns null when surveyIndex is missing (it is mandatory)", () => {
    const { surveyIndex: _omit, ...noIndex } = LINK;
    expect(parseGovLink(row(anchor({ cip179: noIndex })))).toBeNull();
  });

  it("returns null when surveyIndex is malformed (never silently survey 0)", () => {
    expect(
      parseGovLink(row(anchor({ cip179: { ...LINK, surveyIndex: -1 } }))),
    ).toBeNull();
    expect(
      parseGovLink(row(anchor({ cip179: { ...LINK, surveyIndex: 1.5 } }))),
    ).toBeNull();
    expect(
      parseGovLink(row(anchor({ cip179: { ...LINK, surveyIndex: "0" } }))),
    ).toBeNull();
  });

  it("title is null when body.title is absent or non-string", () => {
    expect(parseGovLink(row(anchor({ cip179: LINK })))?.title).toBeNull();
    expect(
      parseGovLink(row(anchor({ title: 7, cip179: LINK })))?.title,
    ).toBeNull();
  });

  it("rejects a non-matching or missing kind discriminator", () => {
    expect(
      parseGovLink(
        row(anchor({ cip179: { ...LINK, kind: "something-else" } })),
      ),
    ).toBeNull();
    const { kind: _k, ...noKind } = LINK;
    expect(parseGovLink(row(anchor({ cip179: noKind })))).toBeNull();
  });

  it("rejects a missing or non-64-hex surveyTxId", () => {
    const { surveyTxId: _t, ...noTx } = LINK;
    expect(parseGovLink(row(anchor({ cip179: noTx })))).toBeNull();
    // A short / malformed id can't address a real tx → not a link.
    expect(
      parseGovLink(row(anchor({ cip179: { ...LINK, surveyTxId: "9a1c" } }))),
    ).toBeNull();
  });

  it("rejects an action with no cip179 object in its body", () => {
    expect(
      parseGovLink(row(anchor({ title: "Just a normal action" }))),
    ).toBeNull();
  });

  it("rejects an anchor with no body, or unresolved meta_json", () => {
    expect(parseGovLink(row({ hashAlgorithm: "blake2b-256" }))).toBeNull();
    expect(parseGovLink(row(null))).toBeNull(); // Koios couldn't resolve the doc
    expect(parseGovLink(row("not an object"))).toBeNull();
  });

  it("rejects an action with no voting deadline (expiration null)", () => {
    expect(
      parseGovLink(row(anchor({ cip179: LINK }), /* expiration */ null)),
    ).toBeNull();
  });
});
