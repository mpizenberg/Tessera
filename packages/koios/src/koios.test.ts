import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "cardano-tessera-core";
import type { Credential } from "cip-179";
import { mechanismAProven, hexToBytes } from "cip-179/domain";
import { decodeResolvedNativeScript } from "cip-179/txproof";
import { evolutionCodec } from "cip-179/evolution";

import { KoiosDataSource } from "./koios";
import { type ProposalRow } from "./govLinks";

// A proposal row as Koios serves it: identity, expiry, and the on-chain anchor.
function row(extra: Partial<ProposalRow> = {}): ProposalRow {
  return {
    proposal_id: "gov_action1abc",
    expiration: 42,
    meta_url: "https://anchor.example/doc.json",
    meta_hash: "ab".repeat(32),
    ...extra,
  };
}

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

  // Finding 12 — an open survey's defining tx is fetched so the UI can badge a
  // survey whose owner was never proven, before anyone pays a fee answering it.
  it("attaches the defining tx's owner-proof to open surveys only", async () => {
    const OWNER = "0f".repeat(28);
    const definitionMetadata = {
      "17": [
        0,
        [
          {
            "0": 5,
            "1": [0, `0x${OWNER}`],
            "2": "t",
            "3": "",
            "4": [3],
            "5": 1_400, // ends well past the tip → open
            "6": [0],
            "7": [[1, "q", ["yes", "no"]]],
          },
          {
            "0": 5,
            "1": [0, `0x${OWNER}`],
            "2": "t",
            "3": "",
            "4": [3],
            "5": 1_000, // already ended → closed, no proof fetched
            "6": [0],
            "7": [[1, "q", ["yes", "no"]]],
          },
        ],
      ],
    };
    const cborCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/tx_by_metalabel")) {
          return new Response(
            JSON.stringify([
              { tx_hash: SURVEY_TX, absolute_slot: 5_000, epoch_no: 1_340 },
            ]),
            { status: 200 },
          );
        }
        if (url.includes("/tx_metadata")) {
          return new Response(
            JSON.stringify([
              { tx_hash: SURVEY_TX, metadata: definitionMetadata },
            ]),
            { status: 200 },
          );
        }
        if (url.includes("/tx_cbor")) {
          cborCalls.push(String(init?.body));
          // A tx body with the owner in required_signers (field 14).
          return new Response(
            JSON.stringify([{ tx_hash: SURVEY_TX, cbor: null }]),
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

    expect(records.surveys).toHaveLength(2);
    // Requested once for the defining tx, because one of its surveys is open.
    expect(cborCalls).toHaveLength(1);
    expect(cborCalls[0]).toContain(SURVEY_TX);
    // Undecodable CBOR is `null` — unknown, which the gate treats as "no
    // opinion" rather than a failed proof.
    expect(records.surveys[0]!.proof).toBeNull();
    // The closed one is never asked about: its verdict comes from its artifact.
    expect(records.surveys[1]!.proof).toBeUndefined();
  });

  // A definition proof and a cancellation proof are the same question over the
  // same evidence, so they ride one request — two would double the scan's
  // /tx_cbor cost for nothing.
  it("fetches definition and cancellation proofs in a single tx_cbor request", async () => {
    const CANCEL_TX = "ef".repeat(32);
    const OWNER = "0f".repeat(28);
    const definitionMetadata = {
      "17": [
        0,
        [
          {
            "0": 5,
            "1": [0, `0x${OWNER}`],
            "2": "t",
            "3": "",
            "4": [3],
            "5": 1_400, // open
            "6": [0],
            "7": [[1, "q", ["yes", "no"]]],
          },
        ],
      ],
    };
    const cancellationMetadata = {
      "17": [2, [[`0x${SURVEY_TX}`, 0]]],
    };
    const cborBodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/tx_by_metalabel")) {
          return new Response(
            JSON.stringify([
              { tx_hash: SURVEY_TX, absolute_slot: 5_000, epoch_no: 1_340 },
              { tx_hash: CANCEL_TX, absolute_slot: 6_000, epoch_no: 1_341 },
            ]),
            { status: 200 },
          );
        }
        if (url.includes("/tx_metadata")) {
          return new Response(
            JSON.stringify([
              { tx_hash: SURVEY_TX, metadata: definitionMetadata },
              { tx_hash: CANCEL_TX, metadata: cancellationMetadata },
            ]),
            { status: 200 },
          );
        }
        if (url.includes("/tx_cbor")) {
          cborBodies.push(String(init?.body));
          return new Response("[]", { status: 200 });
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

    expect(records.surveys).toHaveLength(1);
    expect(records.cancellations).toHaveLength(1);
    expect(cborBodies).toHaveLength(1);
    expect(cborBodies[0]).toContain(SURVEY_TX);
    expect(cborBodies[0]).toContain(CANCEL_TX);
    // Both sides still get their (unknown) verdict from that one reading.
    expect(records.surveys[0]!.proof).toBeNull();
    expect(records.cancellations[0]!.proof).toBeNull();
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

/** In-memory ScanCache with the stores' insert-or-ignore semantics. */
function memCache() {
  const map = new Map<string, unknown>();
  const cbor = new Map<string, string>();
  return {
    map,
    cbor,
    async metadata(hashes: readonly string[]) {
      const out = new Map<string, unknown>();
      for (const h of hashes) if (map.has(h)) out.set(h, map.get(h));
      return out;
    },
    async putMetadata(entries: ReadonlyMap<string, unknown>) {
      for (const [h, m] of entries) if (!map.has(h)) map.set(h, m);
    },
    async proofCbor(hashes: readonly string[]) {
      const out = new Map<string, string>();
      for (const h of hashes) {
        const hit = cbor.get(h);
        if (hit !== undefined) out.set(h, hit);
      }
      return out;
    },
    async putProofCbor(entries: ReadonlyMap<string, string>) {
      for (const [h, c] of entries) if (!cbor.has(h)) cbor.set(h, c);
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
    expect(mechanismAProven(scriptOwner(), proof!)).toBe(true);
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
    expect(mechanismAProven(scriptOwner(), proof!)).toBe(false);
  });

  it("makes no /script_info request when nothing needs resolving", async () => {
    const fetchMock = stubProofFetch(() => new Response("[]", { status: 200 }));
    await new KoiosDataSource(CONFIG).txProofs([TX]); // no needed-scripts map
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/script_info")),
    ).toBe(false);
  });
});

describe("txProofs — tx CBOR cache", () => {
  const scriptInfoOk = () =>
    new Response(
      JSON.stringify([
        { script_hash: SCRIPT_HASH, type: "multisig", bytes: SIG_SCRIPT_CBOR },
      ]),
      { status: 200 },
    );
  const cborCalls = (mock: { mock: { calls: unknown[][] } }) =>
    mock.mock.calls.filter((c) => String(c[0]).includes("/tx_cbor"));

  it("serves a warm cache without any /tx_cbor request", async () => {
    const cache = memCache();
    stubProofFetch(scriptInfoOk);
    const first = await new KoiosDataSource(CONFIG, undefined, cache).txProofs([
      TX,
    ]);
    expect(first.get(TX)).not.toBeNull();
    expect(cache.cbor.get(TX)).toBe(SIGNED_TX_CBOR);

    const fetchMock = stubProofFetch(scriptInfoOk);
    const second = await new KoiosDataSource(CONFIG, undefined, cache).txProofs(
      [TX],
    );
    expect(second.get(TX)).toEqual(first.get(TX));
    expect(cborCalls(fetchMock)).toHaveLength(0);
  });

  it("re-runs the mechanism-A merge on a cached hit, never banking it", async () => {
    // The cached bytes carry no script; only the /script_info fetch supplies it.
    // A run where that fetch fails must still read unknown — which it can only do
    // if the merge is redone per call rather than frozen into the cache.
    const cache = memCache();
    stubProofFetch(scriptInfoOk);
    const warm = await new KoiosDataSource(CONFIG, undefined, cache).txProofs(
      [TX],
      new Map([[TX, [SCRIPT_HASH]]]),
    );
    expect(mechanismAProven(scriptOwner(), warm.get(TX)!)).toBe(true);

    stubProofFetch(() => new Response("boom", { status: 500 }));
    const degraded = await new KoiosDataSource(
      CONFIG,
      undefined,
      cache,
    ).txProofs([TX], new Map([[TX, [SCRIPT_HASH]]]));
    expect(degraded.get(TX)).toBeNull();

    // …and the reverse: once /script_info answers again, so does the proof.
    stubProofFetch(scriptInfoOk);
    const recovered = await new KoiosDataSource(
      CONFIG,
      undefined,
      cache,
    ).txProofs([TX], new Map([[TX, [SCRIPT_HASH]]]));
    expect(mechanismAProven(scriptOwner(), recovered.get(TX)!)).toBe(true);
  });

  it("banks nothing for a hash Koios returned no row for", async () => {
    // A tx the node hasn't caught up to is unknown, not "no evidence": banking
    // it would turn every later refresh's retry into a permanent unproven.
    const cache = memCache();
    const OTHER = "88".repeat(32);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        String(input).includes("/tx_cbor")
          ? new Response(
              JSON.stringify([{ tx_hash: TX, cbor: SIGNED_TX_CBOR }]),
              { status: 200 },
            )
          : new Response("[]", { status: 200 }),
      ),
    );
    const proofs = await new KoiosDataSource(CONFIG, undefined, cache).txProofs(
      [TX, OTHER],
    );
    expect(proofs.get(OTHER)).toBeNull();
    expect(cache.cbor.has(OTHER)).toBe(false);
    expect(cache.cbor.has(TX)).toBe(true);
  });

  it("banks nothing from a batch that threw", async () => {
    const cache = memCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        String(input).includes("/tx_cbor")
          ? new Response("boom", { status: 500 })
          : new Response("[]", { status: 200 }),
      ),
    );
    const proofs = await new KoiosDataSource(CONFIG, undefined, cache).txProofs(
      [TX],
    );
    expect(proofs.get(TX)).toBeNull();
    expect(cache.cbor.size).toBe(0);
  });

  it("requests only the hashes the cache missed", async () => {
    const cache = memCache();
    const OTHER = "88".repeat(32);
    await cache.putProofCbor(new Map([[TX, SIGNED_TX_CBOR]]));
    const batches: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (!String(input).includes("/tx_cbor"))
          return new Response("[]", { status: 200 });
        const { _tx_hashes } = JSON.parse(String(init?.body)) as {
          _tx_hashes: string[];
        };
        batches.push(_tx_hashes);
        return new Response(
          JSON.stringify([{ tx_hash: OTHER, cbor: SIGNED_TX_CBOR }]),
          { status: 200 },
        );
      }),
    );
    const proofs = await new KoiosDataSource(CONFIG, undefined, cache).txProofs(
      [TX, OTHER],
    );
    expect(batches).toEqual([[OTHER]]);
    expect(proofs.get(TX)).not.toBeNull();
    expect(proofs.get(OTHER)).not.toBeNull();
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

/** The `/proposal_list` query strings a scan issued, in request order. */
function captureProposalQueries(
  rowsFor: (params: URLSearchParams) => unknown[],
): URLSearchParams[] {
  const queries: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (!url.includes("/proposal_list"))
        return new Response("[]", { status: 200 });
      const params = new URL(url).searchParams;
      queries.push(params);
      return new Response(JSON.stringify(rowsFor(params)), { status: 200 });
    }),
  );
  return queries;
}

// The scan asks Koios only for the actions that could align with a survey the
// caller holds — epoch alignment is what makes an action relevant at all — and
// reads only on-chain columns, leaving classification to the anchor fetch.
describe("fetchGovProposals — scope", () => {
  it("bounds the scan by the surveys' end epochs and reads on-chain columns only", async () => {
    const queries = captureProposalQueries(() => []);
    await new KoiosDataSource(CONFIG).fetchGovProposals([1395, 1388, 1395]);
    expect(queries).toHaveLength(1);
    const q = queries[0]!;
    // end_epoch + 1 is the action's Koios `expiration`; deduped and ordered.
    expect(q.get("expiration")).toBe("in.(1389,1396)");
    // Any action kind may carry a link (v5) — kind is never filtered.
    expect(q.get("proposal_type")).toBeNull();
    // Koios drops a filter over a column the projection omits, so every filtered
    // column is selected — silently unfiltered rows are the failure mode.
    const select = q.get("select")?.split(",") ?? [];
    expect(select).toEqual([
      "proposal_id",
      "expiration",
      "meta_url",
      "meta_hash",
    ]);
    // The anchor is committed on-chain, so nothing here depends on Koios having
    // resolved it — and no block-time floor hides an action published before the
    // survey definition it links (a tx hash is knowable before it is broadcast).
    expect(q.get("block_time")).toBeNull();
  });

  it("fetches nothing when no survey could be linked", async () => {
    const queries = captureProposalQueries(() => []);
    expect(await new KoiosDataSource(CONFIG).fetchGovProposals([])).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it("carries each action's identity, expiry epoch and anchor", async () => {
    captureProposalQueries(() => [row({ proposal_id: "gov_action1a" })]);
    expect(await new KoiosDataSource(CONFIG).fetchGovProposals([41])).toEqual([
      {
        actionId: "gov_action1a",
        // Koios expiration 42 → expiry epoch 41 (one before the drop-out epoch).
        endEpoch: 41,
        anchor: {
          uri: "https://anchor.example/doc.json",
          hash: hexToBytes("ab".repeat(32)),
        },
        anchorHash: "ab".repeat(32),
      },
    ]);
  });

  // No committed hash means no document could ever be verified against it, so
  // the action can carry no link — a final answer, not an unresolved one.
  it("drops an action whose on-chain anchor is unusable", async () => {
    captureProposalQueries(() => [
      row({ proposal_id: "gov_action1nourl", meta_url: null }),
      row({ proposal_id: "gov_action1nohash", meta_hash: null }),
      row({ proposal_id: "gov_action1badhash", meta_hash: "abcd" }),
      row({ proposal_id: "gov_action1ok" }),
    ]);
    expect(
      (await new KoiosDataSource(CONFIG).fetchGovProposals([41])).map(
        (p) => p.actionId,
      ),
    ).toEqual(["gov_action1ok"]);
  });
});

// Finding 37 — the governance-link read must page like every other unbounded
// Koios read, under a unique stable order, or it silently truncates at Koios's
// row cap and a linked survey renders standalone differently across refreshes.
describe("fetchGovProposals — pagination (finding 37)", () => {
  it("offset-paginates proposal_list under a stable unique order", async () => {
    const PAGE = 100;
    const queries = captureProposalQueries((p) => {
      const offset = Number(p.get("offset"));
      const count = offset === 0 ? PAGE : 2; // page 0 full → page 1 short
      return Array.from({ length: count }, (_, i) =>
        row({ proposal_id: `gov_action1_${offset + i}` }),
      );
    });
    const proposals = await new KoiosDataSource(CONFIG).fetchGovProposals([41]);
    expect(queries.map((p) => p.get("offset"))).toEqual(["0", String(PAGE)]);
    // unique, stable across pages
    expect(queries.every((p) => p.get("order") === "proposal_id.asc")).toBe(
      true,
    );
    expect(proposals).toHaveLength(PAGE + 2); // both pages accumulated
  });
});

// --- upstream cost: one tip per scan, one epoch_params per epoch -------------

const requested = (
  mock: { mock: { calls: unknown[][] } },
  path: string,
): string[] =>
  mock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(path));

describe("chainTip — /epoch_params is read once per epoch, not once per call", () => {
  it("reuses a banked parameter from the same epoch and re-reads across a boundary", async () => {
    const fetchMock = stubKoios(); // its /tip sits in epoch 1_346
    const source = new KoiosDataSource(CONFIG);

    const cold = await source.chainTip();
    expect(cold.govActionLifetime).toBe(0); // the stub serves no epoch_params row
    expect(requested(fetchMock, "/epoch_params")).toHaveLength(1);

    const banked = await source.chainTip({
      epoch: 1_346,
      govActionLifetime: 6,
    });
    expect(banked.govActionLifetime).toBe(6);
    expect(requested(fetchMock, "/epoch_params")).toHaveLength(1);

    // A parameter can change at an epoch boundary, so a tip banked in the
    // previous one says nothing about this one.
    const stale = await source.chainTip({ epoch: 1_345, govActionLifetime: 6 });
    expect(stale.govActionLifetime).toBe(0);
    expect(requested(fetchMock, "/epoch_params")).toHaveLength(2);
  });
});

describe("scan — the records are cut off at the tip published with them", () => {
  it("reads /tip once and scans against it", async () => {
    const fetchMock = stubKoios();
    const payload = await new KoiosDataSource(CONFIG).surveyList();

    expect(payload.tip.epoch).toBe(1_346);
    expect(requested(fetchMock, "/tip")).toHaveLength(1);
  });

  it("still reads its own tip when fetchAll is called alone", async () => {
    const fetchMock = stubKoios();
    await new KoiosDataSource(CONFIG).fetchAll();

    expect(requested(fetchMock, "/tip")).toHaveLength(1);
    expect(requested(fetchMock, "/epoch_params")).toHaveLength(0);
  });
});
