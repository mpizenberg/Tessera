import { afterEach, describe, expect, it, vi } from "vitest";

import { API_VERSION } from "cardano-tessera-client";

import { IndexerDataSource } from "~/data/indexer";

const BASE = "http://localhost:8787";
const TX = "ab".repeat(32);

/** Install a fetch stub answering `/health` and one body for everything else. */
function stubFetch(status: number, body: unknown) {
  const mock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/health"))
      return Response.json({
        ok: true,
        network: "preview",
        apiVersion: API_VERSION,
      });
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IndexerDataSource over the client", () => {
  it("turns the client's not-ready answer into the seam's error", async () => {
    stubFetch(503, { error: "snapshot not ready" });
    const src = new IndexerDataSource(BASE, "preview");
    await expect(src.surveyList()).rejects.toThrow(/first snapshot/);
  });

  it("skips the request for an empty credential set, and maps tx_status to a Map", async () => {
    const fetchMock = stubFetch(200, { [TX]: 3, ["cd".repeat(32)]: null });
    const src = new IndexerDataSource(BASE, "preview");
    expect(await src.respondedKeys([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    const statuses = await src.txStatus([TX, "cd".repeat(32)]);
    expect(statuses.get(TX)).toBe(3);
    expect(statuses.get("cd".repeat(32))).toBeNull();
  });
});
