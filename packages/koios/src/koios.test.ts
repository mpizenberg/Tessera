import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@tessera/core";
import type { Credential } from "cip-179";
import { cancellationVerified, hexToBytes } from "cip-179/domain";
import { decodeResolvedNativeScript } from "cip-179/txproof";
import { evolutionCodec } from "cip-179/evolution";

import {
  KoiosDataSource,
  anchorUnresolved,
  parseGovLink,
  type ProposalRow,
} from "./koios";

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

// An anchor Koios couldn't resolve (`meta_json` null) is UNKNOWN, not "no link":
// `fetchGovernanceLinks` files it under `unresolved` so a mechanism-B verdict it
// might decide is deferred/surfaced, never silently coerced to unproven
// (finding 6). This predicate is what draws that line.
describe("anchorUnresolved", () => {
  it("is true for a null (or non-object) meta_json — couldn't resolve", () => {
    expect(anchorUnresolved(null)).toBe(true);
    expect(anchorUnresolved(undefined)).toBe(true);
    expect(anchorUnresolved("not an object")).toBe(true);
  });

  it("is false for a resolved anchor object — parseGovLink then decides", () => {
    // A resolved doc that happens not to be a survey link is still "resolved".
    expect(anchorUnresolved(anchor({ title: "Just a normal action" }))).toBe(
      false,
    );
    expect(anchorUnresolved(anchor({ cip179: LINK }))).toBe(false);
    expect(anchorUnresolved({})).toBe(false);
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

  // Finding 27 — a broken sibling used to throw out of `decodePayload`, and the
  // scanner's only recourse was skipping the whole tx.
  it("keeps a batch's well-formed responses when one item is malformed", async () => {
    const resp = (credByte: string, role: number) => ({
      "0": 5,
      "1": [`0x${SURVEY_TX}`, 0],
      "2": role,
      "3": [0, `0x${credByte.repeat(28)}`],
      "4": [[1, 0, 0]],
    });
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
          return new Response(
            JSON.stringify([
              {
                tx_hash: RESP_TX,
                metadata: {
                  // Role 9 is not a CIP-179 role: item 1 alone is unreadable.
                  "17": [1, [resp("11", 3), resp("22", 9), resp("33", 3)]],
                },
              },
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

    expect(records.responses).toHaveLength(2);
    // Index 2 survives as index 2: renumbering it would move the response in
    // the dedup chain order and mis-address it in a finalized artifact.
    expect(records.responses.map((r) => r.responseIndex)).toEqual([0, 2]);
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

// --- mechanism-A native-script resolution by hash (finding 7) ----------------
//
// A native script backing a script credential need not be attached to the
// carrying tx (a metadata-only tx spends nothing from it). CIP-179 mechanism A
// lets it be resolved by hash via chain indexing; `txProofs` does so through
// Koios `/script_info` and folds the result into the tx's proof, so the pure
// evaluation is identical to the emitter's — otherwise Tessera and a conformant
// verifier tally the same chain differently.

// DREP_VOTE_TX_CBOR lists this key hash in required_signers; a sig script over it
// is therefore satisfied by that tx. CBOR of `[0, keyhash]`.
const KEYHASH = "d16978b7f8052ad3383bee5930d37ec05fe483ff4477d50df3585c57";
const SIG_SCRIPT_CBOR = `8200581c${KEYHASH}`;
const SCRIPT_HASH = decodeResolvedNativeScript(
  evolutionCodec,
  SIG_SCRIPT_CBOR,
)!.scriptHash;
// A minimal tx that lists KEYHASH in required_signers and attaches NO script.
const SIGNED_TX_CBOR =
  "84a600d9010281825820128d8098467043c6ba9d84d5360782ec3841084625afde5e0d7fdf7e" +
  "e951526300018182583900ad63500e30fae29cb2961f48b83360743abcd331aed01b9d3ec8f4" +
  "db4f467a090e6903ed92b585afd0a6932526a0eb1df314a4a3ce6be4001b00000001fa4a21f0" +
  "021a0002ab71031a06e621970ed9010281581cd16978b7f8052ad3383bee5930d37ec05fe483" +
  "ff4477d50df3585c5713a18202581cd16978b7f8052ad3383bee5930d37ec05fe483ff4477d5" +
  "0df3585c57a1825820178a410703c9a88d38acc8e7e00217722f98e697c826ebd105e0c5beaf" +
  "32e00f008200f6a100d90102828258201a0ca31c60a58eb30a18c463acf6bc670105655fa686" +
  "bbacce6f17f252f3646b58407b577b96203cc9bda779a10c61911fa609bf3196262ed4a5687c" +
  "54ab14076623b48648152f53d211a63c2b6db17c8fb13eb9d3e7de3af86713c0ef03a1320c0c" +
  "8258201f6479010c6a232da09c690550adf5740887de895ca4ffd446720915a165b1df58403e" +
  "ff09e7737a63c59eda414eff7105679f0da90574776ae16bd99abf1b0195e4633c6314f24dd2" +
  "802b7bfff954158719eee04cd609c638c1affda54bafbcbf08f5f6";

const TX = "77".repeat(32);
const scriptOwner = (): Credential => ({
  type: "script",
  scriptHash: hexToBytes(SCRIPT_HASH),
});

/** Stub `/tx_cbor` (one tx) and `/script_info` (parameterised) responses. */
function stubProofFetch(scriptInfo: () => Response) {
  const mock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/tx_cbor"))
      return new Response(
        JSON.stringify([{ tx_hash: TX, cbor: SIGNED_TX_CBOR }]),
        { status: 200 },
      );
    if (url.includes("/script_info")) return scriptInfo();
    return new Response("[]", { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("resolveNativeScripts", () => {
  it("decodes native rows, drops Plutus, and keys by the recomputed hash", async () => {
    stubProofFetch(
      () =>
        new Response(
          JSON.stringify([
            {
              script_hash: SCRIPT_HASH,
              type: "multisig",
              bytes: SIG_SCRIPT_CBOR,
            },
            { script_hash: "plu700", type: "plutusV3", bytes: "deadbeef" },
          ]),
          { status: 200 },
        ),
    );
    const { scripts, reliable } = await new KoiosDataSource(
      CONFIG,
    ).resolveNativeScripts([SCRIPT_HASH, "plu700"]);
    expect(reliable).toBe(true);
    expect([...scripts.keys()]).toEqual([SCRIPT_HASH]); // Plutus row excluded
    expect(scripts.get(SCRIPT_HASH)).toEqual({ kind: "sig", keyHash: KEYHASH });
  });

  it("reports reliable=false when a /script_info batch throws (couldn't ask)", async () => {
    stubProofFetch(() => new Response("boom", { status: 500 }));
    const { scripts, reliable } = await new KoiosDataSource(
      CONFIG,
    ).resolveNativeScripts([SCRIPT_HASH]);
    expect(reliable).toBe(false);
    expect(scripts.size).toBe(0);
  });
});

describe("txProofs — mechanism-A script resolution", () => {
  it("folds a chain-resolved script into the proof so mechanism A verifies", async () => {
    stubProofFetch(
      () =>
        new Response(
          JSON.stringify([
            {
              script_hash: SCRIPT_HASH,
              type: "multisig",
              bytes: SIG_SCRIPT_CBOR,
            },
          ]),
          { status: 200 },
        ),
    );
    const proofs = await new KoiosDataSource(CONFIG).txProofs(
      [TX],
      new Map([[TX, [SCRIPT_HASH]]]),
    );
    const proof = proofs.get(TX);
    expect(proof).not.toBeNull();
    // The witness set carried no script; the resolved one is merged in.
    expect(proof!.nativeScripts).toEqual([
      { scriptHash: SCRIPT_HASH, script: { kind: "sig", keyHash: KEYHASH } },
    ]);
    // …and the tx's required_signers satisfy it → the script owner is proven.
    expect(cancellationVerified(scriptOwner(), proof!)).toBe(true);
  });

  it("nulls the proof (unknown, retry) when /script_info can't be reached", async () => {
    stubProofFetch(() => new Response("boom", { status: 500 }));
    const proofs = await new KoiosDataSource(CONFIG).txProofs(
      [TX],
      new Map([[TX, [SCRIPT_HASH]]]),
    );
    // A needed, non-witnessed script we couldn't resolve is surfaced as unknown,
    // never silently decided "unproven" (findings 6/7).
    expect(proofs.get(TX)).toBeNull();
  });

  it("leaves a definitively-absent script unmerged → a final unproven (no paralysis)", async () => {
    // A successful fetch that returns no such native script (Plutus, or a hash
    // never on-chain — e.g. a bogus claim). The proof stays non-null, the script
    // stays absent, so mechanism A is a final negative and finalization proceeds.
    stubProofFetch(() => new Response("[]", { status: 200 }));
    const proofs = await new KoiosDataSource(CONFIG).txProofs(
      [TX],
      new Map([[TX, [SCRIPT_HASH]]]),
    );
    const proof = proofs.get(TX);
    expect(proof).not.toBeNull();
    expect(proof!.nativeScripts).toEqual([]);
    expect(cancellationVerified(scriptOwner(), proof!)).toBe(false);
  });

  it("makes no /script_info request when nothing needs resolving", async () => {
    const fetchMock = stubProofFetch(() => new Response("[]", { status: 200 }));
    await new KoiosDataSource(CONFIG).txProofs([TX]); // no needed-scripts map
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/script_info")),
    ).toBe(false);
  });
});

// --- Koios read-path resilience (findings 17, 37, 39) ------------------------

const TIP_ROW = {
  epoch_no: 1_346,
  abs_slot: 10_000,
  epoch_slot: 100,
  block_time: 1_750_000_000,
};
const tipResponse = () =>
  new Response(JSON.stringify([TIP_ROW]), { status: 200 });

// Finding 17 — `absolute_slot` alone is a partial order, so tied label-17 txs
// could shuffle across a page boundary and one could slip the scan unseen. The
// scan must order down to the unique, already-selected `tx_hash`.
describe("fetchAll — label scan tie-break order (finding 17)", () => {
  it("breaks slot ties on tx_hash for a total, page-stable order", async () => {
    const fetchMock = stubKoios();
    await new KoiosDataSource(CONFIG).fetchAll();
    const scanUrl = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("/tx_by_metalabel"))!;
    expect(scanUrl).toContain("order=absolute_slot.desc,tx_hash.desc");
  });
});

// Finding 39 — a transient failure on one label-scan page must flag the
// snapshot `incomplete` (finalization then postpones) rather than rejecting the
// whole scan and blanking an otherwise-good explorer.
describe("fetchAll — a failed scan page never sinks the scan (finding 39)", () => {
  it("returns an incomplete snapshot instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/tip")) return tipResponse();
        // The (only) label page fails — a 500 is not retried, so it fails once.
        if (url.includes("/tx_by_metalabel"))
          return new Response("boom", { status: 500 });
        return new Response("[]", { status: 200 });
      }),
    );
    const records = await new KoiosDataSource(CONFIG).fetchAll();
    expect(records.incomplete).toBe(true);
    expect(records.surveys).toEqual([]);
    expect(records.responses).toEqual([]);
  });
});

// Finding 39 — the per-tx metadata fan-out must throttle rather than fire every
// batch at once (the shape that trips Koios's rate limiter), while still
// fetching every batch.
describe("fetchAll — bounded tx_metadata fan-out (finding 39)", () => {
  it("caps in-flight metadata batches yet covers them all", async () => {
    const N = 350; // 7 batches of 50
    const labelTxs = Array.from({ length: N }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    let batchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/tip")) return tipResponse();
        if (url.includes("/tx_by_metalabel")) {
          const offset = Number(new URL(url).searchParams.get("offset"));
          const rows = labelTxs.slice(offset, offset + 100).map((tx_hash) => ({
            tx_hash,
            absolute_slot: 5_000,
            epoch_no: 1_340,
          }));
          return new Response(JSON.stringify(rows), { status: 200 });
        }
        if (url.includes("/tx_metadata")) {
          batchCount += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 2)); // hold the slot open
          inFlight -= 1;
          return new Response("[]", { status: 200 }); // fan-out only; no payloads
        }
        return new Response("[]", { status: 200 });
      }),
    );
    await new KoiosDataSource(CONFIG).fetchAll();
    expect(batchCount).toBe(Math.ceil(N / 50)); // every batch was fetched
    expect(maxInFlight).toBeLessThanOrEqual(6); // never more than the cap at once
    expect(maxInFlight).toBeGreaterThan(1); // …but genuinely parallel
  });
});

// Finding 37 — the governance-link read must page like every other unbounded
// Koios read, under a unique stable order, or it silently truncates at Koios's
// row cap and a linked survey renders standalone differently across refreshes.
describe("fetchGovernanceLinks — pagination (finding 37)", () => {
  it("offset-paginates proposal_list under a stable unique order", async () => {
    const PAGE = 100;
    const seenOffsets: number[] = [];
    let orderSeen: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (!url.includes("/proposal_list"))
          return new Response("[]", { status: 200 });
        const params = new URL(url).searchParams;
        const offset = Number(params.get("offset"));
        seenOffsets.push(offset);
        orderSeen = params.get("order");
        const count = offset === 0 ? PAGE : 2; // page 0 full → page 1 short
        const rows = Array.from({ length: count }, (_, i) =>
          row(anchor({ title: "T", cip179: LINK }), 42, {
            proposal_id: `gov_action1_${offset + i}`,
          }),
        );
        return new Response(JSON.stringify(rows), { status: 200 });
      }),
    );
    const { links } = await new KoiosDataSource(CONFIG).fetchGovernanceLinks(0);
    expect(seenOffsets).toEqual([0, PAGE]); // followed the offset cursor
    expect(orderSeen).toBe("proposal_id.asc"); // unique, stable across pages
    expect(links).toHaveLength(PAGE + 2); // both pages' links accumulated
  });
});
