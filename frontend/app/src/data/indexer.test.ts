import { afterEach, describe, expect, it, vi } from "vitest";

import { toJsonSafe } from "@tessera/core";

import { IndexerDataSource } from "~/data/indexer";

const BASE = "http://localhost:8787";

// A byte string and a lovelace-scale bigint (> 2^53) that must survive the wire
// form untouched, plus a Map (as custom answers carry) — the three types plain
// JSON can't represent.
const TX_ID = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
const BIG = 45_000_000_000_000_000n;

/** A response body shaped like the server's `/api/snapshot` (see http.ts). */
function snapshotBody(): unknown {
  const snapshot = {
    records: {
      surveys: [
        {
          txHash: "aa",
          slot: 100,
          ref: { txId: TX_ID, index: 0 },
          definition: {
            title: "T",
            stake: BIG,
            custom: new Map<number, string>([[1, "one"]]),
          },
        },
      ],
      responses: [],
      cancellations: [],
    },
    tip: {
      epoch: 1345,
      slot: 999,
      time: 1000,
      epochSlot: 5,
      govActionLifetime: 6,
    },
    govLinks: [
      {
        surveyKey: "aa:0",
        actionId: "gov_action1abc",
        endEpoch: 1345,
        title: "Linked",
      },
    ],
  };
  // The server wire-encodes the snapshot, then appends the freshness fields.
  return {
    ...(toJsonSafe(snapshot) as Record<string, unknown>),
    fetchedAt: 1_710_000_000,
    ageSeconds: 12,
  };
}

/** The decoded shape we assert on (looser than the real domain types). */
interface DecodedView {
  surveys: {
    ref: { txId: Uint8Array; index: number };
    definition: { title: string; stake: bigint; custom: Map<number, string> };
  }[];
}

/** Install a fetch stub returning real `Response`s; returns the mock for asserts. */
function stubFetch(handler: (url: string) => { status?: number; body: unknown }) {
  const mock = vi.fn(async (input: string | URL) => {
    const { status = 200, body } = handler(String(input));
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IndexerDataSource", () => {
  it("serves records, tip, and govLinks from a single snapshot fetch", async () => {
    const fetchMock = stubFetch((url) => {
      expect(url).toBe(`${BASE}/api/snapshot`);
      return { body: snapshotBody() };
    });
    const src = new IndexerDataSource(BASE);

    // The exact load order state.tsx uses: fetchAll + chainTip concurrently,
    // then fetchGovernanceLinks right after — all served by one request.
    const [records, tip] = await Promise.all([src.fetchAll(), src.chainTip()]);
    const links = await src.fetchGovernanceLinks(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const view = records as unknown as DecodedView;
    const survey = view.surveys[0];
    expect(survey.ref.txId).toBeInstanceOf(Uint8Array);
    expect([...survey.ref.txId]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(survey.definition.stake).toBe(BIG);
    expect(survey.definition.custom).toBeInstanceOf(Map);
    expect(survey.definition.custom.get(1)).toBe("one");

    expect(tip.epoch).toBe(1345);
    expect(tip.govActionLifetime).toBe(6);

    expect(links).toHaveLength(1);
    expect(links[0].surveyKey).toBe("aa:0");
    expect(links[0].title).toBe("Linked");
  });

  it("refetches the snapshot on each new load (reload)", async () => {
    const fetchMock = stubFetch(() => ({ body: snapshotBody() }));
    const src = new IndexerDataSource(BASE);
    await src.fetchAll();
    await src.fetchAll();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps tx_status to confirmations, keeping null for txs not yet in a block", async () => {
    const fetchMock = stubFetch((url) => {
      expect(url).toContain(`${BASE}/api/tx_status?`);
      expect(url).toContain("hashes=h1%2Ch2"); // comma is URL-encoded
      return { body: { h1: 3, h2: null } };
    });
    const src = new IndexerDataSource(BASE);

    const statuses = await src.txStatus(["h1", "h2"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statuses.get("h1")).toBe(3);
    expect(statuses.get("h2")).toBeNull();
  });

  it("makes no request for an empty tx_status query", async () => {
    const fetchMock = stubFetch(() => ({ body: {} }));
    const src = new IndexerDataSource(BASE);

    const statuses = await src.txStatus([]);
    expect(statuses.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a clear error when the snapshot is not ready yet (503)", async () => {
    stubFetch(() => ({ status: 503, body: { error: "snapshot not ready" } }));
    const src = new IndexerDataSource(BASE);
    await expect(src.fetchAll()).rejects.toThrow(/503.*not ready/);
  });
});
