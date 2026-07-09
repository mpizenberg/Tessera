import { afterEach, describe, expect, it, vi } from "vitest";

import { toJsonSafe } from "cip-179/tally";

import { IndexerDataSource } from "~/data/indexer";

const BASE = "http://localhost:8787";

// A byte string and a lovelace-scale bigint (> 2^53) that must survive the wire
// form untouched, plus a Map (as custom answers carry) — the three types plain
// JSON can't represent.
const TX_ID = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
const BIG = 45_000_000_000_000_000n;

/** A response body shaped like the server's `/api/surveys` (see http.ts). */
function surveyListBody(): unknown {
  const list = {
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
    cancellations: [],
    govLinks: [
      {
        surveyKey: "aa:0",
        actionId: "gov_action1abc",
        endEpoch: 1345,
        title: "Linked",
      },
    ],
    tip: {
      epoch: 1345,
      slot: 999,
      time: 1000,
      epochSlot: 5,
      govActionLifetime: 6,
    },
    responseCounts: { "deadbeef:0": 2 },
  };
  // The server wire-encodes the payload, then appends the freshness fields.
  return {
    ...(toJsonSafe(list) as Record<string, unknown>),
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
function stubFetch(
  handler: (url: string) => { status?: number; body: unknown },
) {
  const mock = vi.fn(async (input: string | URL) => {
    const { status = 200, body } = handler(String(input));
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The stub's `/health` answer (network check) alongside per-route bodies. */
function withHealth(
  handler: (url: string) => { status?: number; body: unknown },
  network = "preview",
): (url: string) => { status?: number; body: unknown } {
  return (url) =>
    url.endsWith("/health") ? { body: { ok: true, network } } : handler(url);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IndexerDataSource", () => {
  it("decodes the survey-list payload from a single /api/surveys fetch", async () => {
    const fetchMock = stubFetch(
      withHealth((url) => {
        expect(url).toBe(`${BASE}/api/surveys`);
        return { body: surveyListBody() };
      }),
    );
    const src = new IndexerDataSource(BASE, "preview");

    const list = await src.surveyList();
    expect(fetchMock).toHaveBeenCalledTimes(2); // /health + /api/surveys

    const survey = (list as unknown as DecodedView).surveys[0];
    expect(survey.ref.txId).toBeInstanceOf(Uint8Array);
    expect([...survey.ref.txId]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(survey.definition.stake).toBe(BIG);
    expect(survey.definition.custom).toBeInstanceOf(Map);
    expect(survey.definition.custom.get(1)).toBe("one");

    expect(list.tip.epoch).toBe(1345);
    expect(list.tip.govActionLifetime).toBe(6);

    expect(list.govLinks).toHaveLength(1);
    expect(list.govLinks[0]!.surveyKey).toBe("aa:0");
    expect(list.govLinks[0]!.title).toBe("Linked");

    // Counts are plain JSON, untouched by the wire decode.
    expect(list.responseCounts).toEqual({ "deadbeef:0": 2 });
  });

  it("refetches the list on each new load, checking the network once", async () => {
    const fetchMock = stubFetch(withHealth(() => ({ body: surveyListBody() })));
    const src = new IndexerDataSource(BASE, "preview");
    await src.surveyList();
    await src.surveyList();
    // Two list fetches, but /health only on the first (memoized).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.endsWith("/health"))).toHaveLength(1);
  });

  it("rejects a backend that serves a different network", async () => {
    stubFetch(withHealth(() => ({ body: surveyListBody() }), "mainnet"));
    const src = new IndexerDataSource(BASE, "preview");
    await expect(src.surveyList()).rejects.toThrow(/mainnet.*preview/s);
  });

  it("fetches a survey bundle by hex ref", async () => {
    const body = toJsonSafe({
      survey: { txHash: "deadbeef", slot: 100, ref: { txId: TX_ID, index: 3 } },
      responses: [{ txHash: "cc", slot: 150, response: { big: BIG } }],
      cancellations: [],
      tip: { epoch: 1345, slot: 999, time: 1000, epochSlot: 5 },
    });
    const fetchMock = stubFetch(
      withHealth((url) => {
        expect(url).toBe(`${BASE}/api/surveys/deadbeef/3`);
        return { body };
      }),
    );
    const src = new IndexerDataSource(BASE, "preview");

    const bundle = await src.surveyBundle({ txId: TX_ID, index: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // /health + the bundle
    expect(bundle.survey.ref.txId).toBeInstanceOf(Uint8Array);
    expect(
      (bundle.responses[0]!.response as unknown as { big: bigint }).big,
    ).toBe(BIG);
    expect(bundle.tip.epoch).toBe(1345);
  });

  it("surfaces an unknown survey ref (404) as an error", async () => {
    stubFetch(
      withHealth(() => ({ status: 404, body: { error: "unknown survey" } })),
    );
    const src = new IndexerDataSource(BASE, "preview");
    await expect(src.surveyBundle({ txId: TX_ID, index: 9 })).rejects.toThrow(
      /404/,
    );
  });

  it("fetches an artifact as plain JSON, mapping 404 to null", async () => {
    const artifact = {
      tally: { rulesetHash: "ab", perRole: [{ role: 3, total: "1000" }] },
      provenance: { source: { provider: "koios" } },
    };
    const fetchMock = stubFetch((url) =>
      url.endsWith(`/api/surveys/deadbeef/3/artifact`)
        ? { body: artifact }
        : { status: 404, body: { error: "no artifact" } },
    );
    const src = new IndexerDataSource(BASE, "preview");

    // Wire-plain: decimal strings arrive as-is, no fromJsonSafe decode.
    expect(await src.artifact({ txId: TX_ID, index: 3 })).toEqual(artifact);
    expect(await src.artifact({ txId: TX_ID, index: 9 })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // no /health round-trip
  });

  it("queries responded keys for a credential set, skipping the empty set", async () => {
    const fetchMock = stubFetch(
      withHealth((url) => {
        expect(url).toContain(`${BASE}/api/responded?`);
        // key:11,script:22 with the comma URL-encoded
        expect(url).toContain("credentials=key%3A11%2Cscript%3A22");
        return { body: { surveyKeys: ["aa:0"], fetchedAt: 1 } };
      }),
    );
    const src = new IndexerDataSource(BASE, "preview");

    expect(await src.respondedKeys([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    const keys = await src.respondedKeys(["key:11", "script:22"]);
    expect(keys).toEqual(["aa:0"]);
  });

  it("maps tx_status to confirmations, keeping null for txs not yet in a block", async () => {
    const fetchMock = stubFetch((url) => {
      expect(url).toContain(`${BASE}/api/tx_status?`);
      expect(url).toContain("hashes=h1%2Ch2"); // comma is URL-encoded
      return { body: { h1: 3, h2: null } };
    });
    const src = new IndexerDataSource(BASE, "preview");

    const statuses = await src.txStatus(["h1", "h2"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statuses.get("h1")).toBe(3);
    expect(statuses.get("h2")).toBeNull();
  });

  it("makes no request for an empty tx_status query", async () => {
    const fetchMock = stubFetch(() => ({ body: {} }));
    const src = new IndexerDataSource(BASE, "preview");

    const statuses = await src.txStatus([]);
    expect(statuses.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a clear error when the snapshot is not ready yet (503)", async () => {
    stubFetch(
      withHealth(() => ({
        status: 503,
        body: { error: "snapshot not ready" },
      })),
    );
    const src = new IndexerDataSource(BASE, "preview");
    await expect(src.surveyList()).rejects.toThrow(/503.*not ready/);
  });
});
