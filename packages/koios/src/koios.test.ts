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

function row(
  meta_json: unknown,
  expiration: number | null = 42,
  extra: Partial<ProposalRow> = {},
): ProposalRow {
  return {
    proposal_id: "gov_action1abc",
    proposal_type: "InfoAction",
    expiration,
    meta_json,
    ...extra,
  };
}

// 64-char hex tx id, upper-case on purpose: surveyKey must lower-case it.
const TXID = "9A1C".repeat(16);
const LINK = {
  specVersion: 5,
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
      // Koios expiration 42 → expiry epoch 41 (one before the drop-out epoch).
      endEpoch: 41,
      // Ran its full course: votable through its expiry epoch.
      votableThroughEpoch: 41,
      title: "Ratify the budget",
    });
  });

  it("links from a non-Info action kind (any kind may link in v5)", () => {
    const link = parseGovLink(
      row(anchor({ title: "Treasury withdrawal", cip179: LINK }), 42, {
        proposal_type: "TreasuryWithdrawals",
      }),
    );
    expect(link?.surveyKey).toBe(`${TXID.toLowerCase()}:2`);
    expect(link?.endEpoch).toBe(41);
  });

  it("shrinks the votable window when the action resolved early", () => {
    const link = parseGovLink(
      row(anchor({ cip179: LINK }), 42, { ratified_epoch: 38 }),
    );
    // endEpoch stays the expiry epoch, but voting stopped at ratification.
    expect(link?.endEpoch).toBe(41);
    expect(link?.votableThroughEpoch).toBe(38);
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
    "0": 5, // spec_version
    "1": [`0x${SURVEY_TX}`, 0], // survey_ref
    "2": 3, // role: Stakeholder
    "3": [0, `0x${credByte.repeat(28)}`], // key credential
    "4": [[1, 0, 0]], // public: one single-choice answer (Q0 → option 0)
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

  it("flags the snapshot incomplete when a tx_metadata batch fails (findings 3, 12)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/tx_by_metalabel")) {
          return new Response(
            JSON.stringify([
              { tx_hash: RESP_TX, absolute_slot: 5_000, epoch_no: 1_340 },
            ]),
            { status: 200 },
          );
        }
        if (url.includes("/tx_metadata")) {
          return new Response("boom", { status: 500 }); // the only batch fails
        }
        if (url.includes("/tip")) {
          return new Response(
            JSON.stringify([
              {
                epoch_no: 1_346,
                abs_slot: 10_000,
                epoch_slot: 100,
                block_time: 1_750_000_000,
              },
            ]),
            { status: 200 },
          );
        }
        return new Response("[]", { status: 200 });
      }),
    );
    const records = await new KoiosDataSource(CONFIG).fetchAll();
    // The dropped batch carried the only tx, so the snapshot shrank — and it is
    // flagged so finalization postpones rather than hashing a short tally.
    expect(records.incomplete).toBe(true);
    expect(records.responses).toHaveLength(0);
  });

  it("offset-paginates the label scan and dedups a tx seen on two pages (finding 12)", async () => {
    const PAGE_SIZE = 100;
    const T2 = "ef".repeat(32);
    const offsets: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/tx_by_metalabel")) {
          const offset = Number(new URL(url).searchParams.get("offset"));
          offsets.push(offset);
          // Page 0: a full page (all RESP_TX) forces a second page. Page 1:
          // RESP_TX again (cross-page dup) + a short page → scan stops.
          const rows =
            offset === 0
              ? Array.from({ length: PAGE_SIZE }, () => ({
                  tx_hash: RESP_TX,
                  absolute_slot: 5_000,
                  epoch_no: 1_340,
                }))
              : [
                  { tx_hash: RESP_TX, absolute_slot: 5_000, epoch_no: 1_340 },
                  { tx_hash: T2, absolute_slot: 6_000, epoch_no: 1_341 },
                ];
          return new Response(JSON.stringify(rows), { status: 200 });
        }
        if (url.includes("/tx_metadata")) {
          return new Response(
            JSON.stringify([
              { tx_hash: RESP_TX, metadata: responsesMetadata() },
            ]),
            { status: 200 },
          );
        }
        if (url.includes("/tip")) {
          return new Response(
            JSON.stringify([
              {
                epoch_no: 1_346,
                abs_slot: 10_000,
                epoch_slot: 100,
                block_time: 1_750_000_000,
              },
            ]),
            { status: 200 },
          );
        }
        return new Response("[]", { status: 200 });
      }),
    );
    const records = await new KoiosDataSource(CONFIG).fetchAll();
    expect(offsets).toEqual([0, PAGE_SIZE]); // followed the offset cursor
    // RESP_TX was seen 101 times across two pages but classified once.
    expect(records.responses).toHaveLength(2);
    expect(records.incomplete).toBe(false);
  });
});

// --- fetchAll: scan resume via the tx-metadata cache (finding 5) -------------

/** In-memory TxMetadataCache with the stores' insert-or-ignore semantics. */
function memCache() {
  const map = new Map<string, unknown>();
  return {
    map,
    async get(hashes: readonly string[]) {
      const out = new Map<string, unknown>();
      for (const h of hashes) if (map.has(h)) out.set(h, map.get(h));
      return out;
    },
    async put(entries: ReadonlyMap<string, unknown>) {
      for (const [h, m] of entries) if (!map.has(h)) map.set(h, m);
    },
  };
}

describe("fetchAll — tx metadata cache (finding 5)", () => {
  it("serves a warm cache without any /tx_metadata request", async () => {
    const cache = memCache();
    stubKoios();
    const first = await new KoiosDataSource(
      CONFIG,
      undefined,
      cache,
    ).fetchAll();
    expect(first.responses).toHaveLength(2);
    expect(cache.map.has(RESP_TX)).toBe(true); // banked

    // Fresh mock (fresh call log): the rescan classifies identically from the
    // cache and makes zero metadata requests.
    const fetchMock = stubKoios();
    const second = await new KoiosDataSource(
      CONFIG,
      undefined,
      cache,
    ).fetchAll();
    expect(second.responses).toHaveLength(2);
    expect(second.responses.map((r) => r.responseIndex)).toEqual([0, 1]);
    const metadataCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/tx_metadata"),
    );
    expect(metadataCalls).toHaveLength(0);
  });

  it("banks fulfilled batches so an over-budget scan converges across runs", async () => {
    // 51 label txs → two /tx_metadata batches (50 fillers + RESP_TX). The
    // filler batch fails on run 1 — only its work may repeat on run 2.
    const FILLERS = Array.from({ length: 50 }, (_, i) =>
      (i + 1).toString(16).padStart(2, "0").repeat(32),
    );
    const cache = memCache();
    let fillersFail = true;
    const metadataBatches: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/tx_by_metalabel")) {
          const rows = [...FILLERS, RESP_TX].map((tx_hash) => ({
            tx_hash,
            absolute_slot: 5_000,
            epoch_no: 1_340,
          }));
          return new Response(JSON.stringify(rows), { status: 200 });
        }
        if (url.includes("/tx_metadata")) {
          const { _tx_hashes } = JSON.parse(String(init?.body)) as {
            _tx_hashes: string[];
          };
          metadataBatches.push(_tx_hashes);
          if (_tx_hashes.includes(RESP_TX)) {
            return new Response(
              JSON.stringify([
                { tx_hash: RESP_TX, metadata: responsesMetadata() },
              ]),
              { status: 200 },
            );
          }
          // The filler batch: fails on run 1, fulfills empty (answered: these
          // txs carry no label-17 payload) on run 2.
          return fillersFail
            ? new Response("boom", { status: 500 })
            : new Response("[]", { status: 200 });
        }
        if (url.includes("/tip")) {
          return new Response(
            JSON.stringify([
              {
                epoch_no: 1_346,
                abs_slot: 10_000,
                epoch_slot: 100,
                block_time: 1_750_000_000,
              },
            ]),
            { status: 200 },
          );
        }
        return new Response("[]", { status: 200 });
      }),
    );
    const source = () => new KoiosDataSource(CONFIG, undefined, cache);

    // Run 1: the filler batch drops (incomplete), RESP_TX's batch is banked.
    const run1 = await source().fetchAll();
    expect(run1.incomplete).toBe(true);
    expect(run1.responses).toHaveLength(2);
    expect(metadataBatches).toHaveLength(2);
    expect(cache.map.has(RESP_TX)).toBe(true);
    expect(cache.map.has(FILLERS[0]!)).toBe(false); // failed batch not banked

    // Run 2: only the failed batch re-fetches (one request, the 50 fillers) —
    // RESP_TX comes from the cache. No-row hashes are banked as null.
    fillersFail = false;
    metadataBatches.length = 0;
    const run2 = await source().fetchAll();
    expect(run2.incomplete).toBe(false);
    expect(run2.responses).toHaveLength(2);
    expect(metadataBatches).toEqual([FILLERS]);
    expect(cache.map.get(FILLERS[0]!)).toBeNull();

    // Run 3: everything cached → zero metadata requests. The scan has converged.
    metadataBatches.length = 0;
    const run3 = await source().fetchAll();
    expect(run3.incomplete).toBe(false);
    expect(run3.responses).toHaveLength(2);
    expect(metadataBatches).toEqual([]);
  });
});
