import { afterEach, describe, expect, it, vi } from "vitest";

import { Role, type Metadatum } from "cip-179";
import type { ResponseRecord, SurveyRecord } from "cip-179/domain";
import { toJsonSafe } from "cip-179/tally";
import { API_VERSION } from "cardano-tessera-core";

import { IndexerDataSource } from "~/data/indexer";

const BASE = "http://localhost:8787";

// A byte string and a lovelace-scale bigint (> 2^53) that must survive the wire
// form untouched, plus a Map (as custom answers carry) — the three types plain
// JSON can't represent.
const TX_ID = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
const BIG = 45_000_000_000_000_000n;

const survey: SurveyRecord = {
  txHash: "deadbeef",
  slot: 100,
  epochNo: 1340,
  ref: { txId: TX_ID, index: 3 },
  definition: {
    specVersion: 5,
    owner: { type: "key", keyHash: new Uint8Array([0x11]) },
    title: "T",
    description: "",
    eligibleRoles: [Role.DRep],
    endEpoch: 1345,
    submissionMode: { type: "public" },
    questions: [
      {
        type: "custom",
        prompt: "c",
        methodSchema: { uri: "ipfs://schema", hash: new Uint8Array([1]) },
      },
      { type: "numericRange", prompt: "n", constraints: { min: 0n, max: BIG } },
    ],
  },
};

const responseAt = (txHash: string): ResponseRecord => ({
  txHash,
  slot: 150,
  epochNo: 1341,
  responseIndex: 0,
  response: {
    specVersion: 5,
    surveyRef: survey.ref,
    role: Role.DRep,
    credential: { type: "key", keyHash: new Uint8Array([0x22]) },
    answers: {
      type: "public",
      answers: [
        {
          questionIndex: 0,
          type: "custom",
          value: new Map<Metadatum, Metadatum>([[1n, "one"]]),
        },
        { questionIndex: 1, type: "numeric", value: BIG },
      ],
    },
  },
});

const tip = {
  epoch: 1345,
  slot: 999,
  time: 1000,
  epochSlot: 5,
  govActionLifetime: 6,
};

/** A response body shaped like the server's `/api/surveys` (see http.ts). */
function surveyListBody(): Record<string, unknown> {
  const list = {
    surveys: [survey],
    cancellations: [],
    govLinks: [
      {
        surveyKey: "deadbeef:3",
        actionId: "gov_action1abc",
        endEpoch: 1345,
        title: "Linked",
      },
    ],
    tip,
    responseCounts: { "deadbeef:3": 2 },
    // Audited, per role: one survey counts a DRep, the other counts nobody.
    countedByRole: { "deadbeef:3": { "0": 1 }, "aa:0": {} },
  };
  // The server wire-encodes the payload, then appends the freshness stamp.
  return {
    ...(toJsonSafe(list) as Record<string, unknown>),
    fetchedAt: 1_710_000_000,
  };
}

/** One page of the server's `/api/surveys/{txHash}/{index}` body. */
const bundlePage = (
  responses: readonly ResponseRecord[],
  nextCursor: string | null,
): unknown => ({
  ...(toJsonSafe({ survey, responses, cancellations: [], tip }) as Record<
    string,
    unknown
  >),
  nextCursor,
});

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

/** The stub's `/health` answer (network and version check) alongside per-route bodies. */
function withHealth(
  handler: (url: string) => { status?: number; body: unknown },
  network = "preview",
  apiVersion = API_VERSION,
): (url: string) => { status?: number; body: unknown } {
  return (url) =>
    url.endsWith("/health")
      ? { body: { ok: true, network, apiVersion } }
      : handler(url);
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

    // The record comes back equal to what was encoded: bytes as bytes, the
    // out-of-double-range bound as a bigint.
    expect(list.surveys).toEqual([survey]);
    expect(list.surveys[0]!.ref.txId).toBeInstanceOf(Uint8Array);
    const range = list.surveys[0]!.definition.questions[1]!;
    expect(range.type === "numericRange" && range.constraints.max).toBe(BIG);

    expect(list.tip.epoch).toBe(1345);
    expect(list.tip.govActionLifetime).toBe(6);
    expect(list.fetchedAt).toBe(1_710_000_000);

    expect(list.govLinks).toHaveLength(1);
    expect(list.govLinks[0]!.surveyKey).toBe("deadbeef:3");
    expect(list.govLinks[0]!.title).toBe("Linked");

    // Counts are plain JSON, untouched by the wire decode. A survey nothing
    // counts for carries an empty object, never a missing key — "none" and
    // "this source does not audit" must not read the same.
    expect(list.responseCounts).toEqual({ "deadbeef:3": 2 });
    expect(list.countedByRole).toEqual({
      "deadbeef:3": { "0": 1 },
      "aa:0": {},
    });
  });

  it("reports a record that does not fit its type by the field's path", async () => {
    const body = surveyListBody();
    const [wireSurvey] = body["surveys"] as Record<string, unknown>[];
    (wireSurvey!["definition"] as Record<string, unknown>)["questions"] = 7;
    stubFetch(withHealth(() => ({ body })));
    const src = new IndexerDataSource(BASE, "preview");
    await expect(src.surveyList()).rejects.toThrow(/definition\.questions/);
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

  it("rejects Preview data in a preprod build despite their shared CIP-30 id", async () => {
    stubFetch(withHealth(() => ({ body: surveyListBody() }), "preview"));
    const src = new IndexerDataSource(BASE, "preprod");
    await expect(src.surveyList()).rejects.toThrow(/preview.*preprod/s);
  });

  it("refuses a backend on another contract major, accepts an unknown minor", async () => {
    stubFetch(withHealth(() => ({ body: surveyListBody() }), "preview", "2.0"));
    await expect(
      new IndexerDataSource(BASE, "preview").surveyList(),
    ).rejects.toThrow(/API version 2\.0/);

    stubFetch(withHealth(() => ({ body: surveyListBody() }), "preview", "1.9"));
    await expect(
      new IndexerDataSource(BASE, "preview").surveyList(),
    ).resolves.toBeDefined();
  });

  it("follows the bundle's cursor until the responses run out", async () => {
    const fetchMock = stubFetch(
      withHealth((url) =>
        url.includes("cursor=")
          ? { body: bundlePage([responseAt("dd")], null) }
          : { body: bundlePage([responseAt("cc")], "150:cc:0") },
      ),
    );
    const src = new IndexerDataSource(BASE, "preview");

    const bundle = await src.surveyBundle({ txId: TX_ID, index: 3 });
    // The seam still hands back one whole bundle; paging is the client's.
    expect(bundle.responses.map((r) => r.txHash)).toEqual(["cc", "dd"]);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("/api/surveys/"))).toEqual([
      `${BASE}/api/surveys/deadbeef/3`,
      `${BASE}/api/surveys/deadbeef/3?cursor=150%3Acc%3A0`,
    ]);
  });

  it("fetches a survey bundle by hex ref", async () => {
    const fetchMock = stubFetch(
      withHealth((url) => {
        expect(url).toBe(`${BASE}/api/surveys/deadbeef/3`);
        return { body: bundlePage([responseAt("cc")], null) };
      }),
    );
    const src = new IndexerDataSource(BASE, "preview");

    const bundle = await src.surveyBundle({ txId: TX_ID, index: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // /health + the bundle
    expect(bundle.survey).toEqual(survey);
    // A custom answer's map and a numeric answer's bigint both survive.
    expect(bundle.responses).toEqual([responseAt("cc")]);
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

    // Wire-plain: decimal strings arrive as-is, no wire decode.
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
