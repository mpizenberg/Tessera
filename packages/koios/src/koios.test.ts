import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@tessera/core";

import { KoiosDataSource, parseGovLink, type ProposalRow } from "./koios";

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

// --- fetchAll: chain-position enrichment -------------------------------------

const CONFIG: AppConfig = {
  network: "preview",
  koiosUrl: "http://koios.test/api/v1",
  koiosToken: undefined,
  sinceUnix: 0,
  secondsPerEpoch: 86_400,
};

const RESP_TX = "ab".repeat(32);
const SURVEY_TX = "cd".repeat(32);

/** Koios-JSON CIP-179 responses payload: two responses in one tx. */
function responsesMetadata(): unknown {
  const resp = (credByte: string) => ({
    "0": 4, // spec_version
    "1": [`0x${SURVEY_TX}`, 0], // survey_ref
    "2": 3, // role: Stakeholder
    "3": [0, `0x${credByte.repeat(28)}`], // key credential
    "4": [], // public, no answers
  });
  return { "17": [1, [resp("11"), resp("22")]] };
}

function stubKoios() {
  const mock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const body = url.includes("/tx_by_metalabel")
      ? [{ tx_hash: RESP_TX, absolute_slot: 5_000, epoch_no: 1_340 }]
      : url.includes("/tx_metadata")
        ? [{ tx_hash: RESP_TX, metadata: responsesMetadata() }]
        : url.includes("/tip")
          ? [
              {
                epoch_no: 1_346,
                abs_slot: 10_000,
                epoch_slot: 100,
                block_time: 1_750_000_000,
              },
            ]
          : [];
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAll — chain position", () => {
  it("selects epoch_no in the scan and enumerates response payload indices", async () => {
    const fetchMock = stubKoios();
    const records = await new KoiosDataSource(CONFIG).fetchAll();

    const scanUrl = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("/tx_by_metalabel"));
    expect(scanUrl).toContain("select=tx_hash,absolute_slot,epoch_no");

    expect(records.responses).toHaveLength(2);
    for (const r of records.responses) {
      expect(r.txHash).toBe(RESP_TX);
      expect(r.slot).toBe(5_000);
      expect(r.epochNo).toBe(1_340); // authoritative, straight from the index
    }
    // The payload position is preserved — the §6.3 same-tx tiebreak.
    expect(records.responses.map((r) => r.responseIndex)).toEqual([0, 1]);
    expect(records.responses.map((r) => r.blockIndex)).toEqual([
      undefined,
      undefined, // browser scan doesn't enrich block indices (server-side only)
    ]);
  });
});
