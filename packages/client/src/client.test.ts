import { describe, expect, it, vi } from "vitest";

import { Cip179DecodeError, Role, type Metadatum } from "cip-179";
import type { ResponseRecord, SurveyRecord } from "cip-179/domain";
import { toJsonSafe } from "cip-179/tally";

import {
  API_VERSION,
  MAX_CREDENTIALS,
  MAX_PAGE_LIMIT,
  MAX_TX_STATUS_HASHES,
  TesseraHttpError,
  createTesseraClient,
  type TesseraClientOptions,
} from "./index.js";

const BASE = "http://localhost:8787";
const TX = "de".repeat(32);
const KEY = `${TX}:3`;

// A byte string and a lovelace-scale bigint (> 2^53) that must survive the wire
// form untouched, plus a Map (as custom answers carry) — the three types plain
// JSON can't represent.
const TX_ID = new Uint8Array(32).fill(0xde);
const BIG = 45_000_000_000_000_000n;

const survey: SurveyRecord = {
  txHash: TX,
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
          type: "custom",
          questionIndex: 0,
          value: new Map<Metadatum, Metadatum>([[1n, "one"]]),
        },
        { type: "numeric", questionIndex: 1, value: BIG },
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

/** A body shaped like the server's `/api/surveys`. */
function listBody(): Record<string, unknown> {
  const list = {
    surveys: [survey],
    cancellations: [],
    govLinks: [
      {
        surveyKey: KEY,
        actionId: "gov_action1abc",
        endEpoch: 1345,
        title: "Linked",
      },
    ],
    tip,
    responseCounts: { [KEY]: 2 },
    countedByRole: { [KEY]: { "0": 1 }, "aa:0": {} },
    finalState: { "aa:0": { state: "untalliable" } },
  };
  return {
    ...(toJsonSafe(list) as Record<string, unknown>),
    fetchedAt: 1_710_000_000,
    counts: { all: 1, linked: 1, active: 0, sealed: 0, public: 0, mine: 0 },
    nextCursor: null,
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
  verdicts: Object.fromEntries(responses.map((r) => [`${r.txHash}:0`, true])),
  govLinks: [],
  nextCursor,
  fetchedAt: 1_710_000_000,
});

type Answer = { status?: number; body: unknown };

/**
 * A client over a fetch stub. `/health` answers the default liveness unless
 * `health` gives a body or a function producing the whole answer.
 */
function clientOver(
  handler: (url: string) => Answer | undefined,
  options: Partial<TesseraClientOptions> & {
    health?: unknown | (() => Answer);
  } = {},
) {
  const healthAnswer = (): Answer =>
    typeof options.health === "function"
      ? (options.health as () => Answer)()
      : {
          body: options.health ?? {
            ok: true,
            network: "preview",
            apiVersion: API_VERSION,
          },
        };
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const answer =
      new URL(url).pathname === "/health" ? healthAnswer() : handler(url);
    if (!answer) throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
    });
  });
  const client = createTesseraClient({
    baseUrl: options.baseUrl ?? BASE,
    network: "network" in options ? options.network : "preview",
    fetch: fetchMock as unknown as typeof fetch,
  });
  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));
  return { client, fetchMock, urls };
}

const ready = <T>(answer: { ready: true; body: T } | { ready: false }): T => {
  if (!answer.ready) throw new Error("not ready");
  return answer.body;
};

describe("surveys", () => {
  it("decodes the paged list from one request beside the compatibility check", async () => {
    const { client, urls } = clientOver((url) =>
      url === `${BASE}/api/surveys` ? { body: listBody() } : undefined,
    );
    const list = ready(await client.surveys());
    expect(urls()).toEqual([`${BASE}/api/surveys`, `${BASE}/health`]);

    // The record comes back equal to what was encoded: bytes as bytes, the
    // out-of-double-range bound as a bigint.
    expect(list.surveys).toEqual([survey]);
    expect(list.surveys[0]!.ref.txId).toBeInstanceOf(Uint8Array);
    const range = list.surveys[0]!.definition.questions[1]!;
    expect(range.type === "numericRange" && range.constraints.max).toBe(BIG);

    expect(list.tip.govActionLifetime).toBe(6);
    expect(list.fetchedAt).toBe(1_710_000_000);
    expect(list.govLinks[0]!.title).toBe("Linked");
    expect(list.responseCounts).toEqual({ [KEY]: 2 });
    // A survey nothing counts for carries an empty object, never a missing
    // key — "none" and "this source does not audit" must not read the same.
    expect(list.countedByRole).toEqual({ [KEY]: { "0": 1 }, "aa:0": {} });
    expect(list.finalState).toEqual({ "aa:0": { state: "untalliable" } });
    expect(list.counts?.linked).toBe(1);
    expect(list.nextCursor).toBeNull();
  });

  it("encodes every query parameter and omits the defaults", async () => {
    const { client, urls } = clientOver((url) =>
      url.includes("/api/surveys") ? { body: listBody() } : undefined,
    );
    await client.surveys({
      limit: 20,
      cursor: "1:50:aa:0:7",
      filter: "linked",
      credentials: ["key:11", "script:22"],
      search: "  two words ",
    });
    await client.surveys({ filter: "all" });
    const [full, defaults] = urls().filter((u) => u.includes("/api/surveys"));
    expect(new URL(full!).searchParams.get("limit")).toBe("20");
    expect(new URL(full!).searchParams.get("cursor")).toBe("1:50:aa:0:7");
    expect(new URL(full!).searchParams.get("filter")).toBe("linked");
    expect(new URL(full!).searchParams.get("credentials")).toBe(
      "key:11,script:22",
    );
    expect(new URL(full!).searchParams.get("q")).toBe("two words");
    expect(defaults).toBe(`${BASE}/api/surveys`);
  });

  it("refuses an out-of-range limit or too many credentials before any request", async () => {
    const { client, fetchMock } = clientOver(() => undefined);
    expect(() => client.surveys({ limit: 0 })).toThrow(RangeError);
    expect(() => client.surveys({ limit: MAX_PAGE_LIMIT + 1 })).toThrow(
      RangeError,
    );
    expect(() => client.surveys({ limit: 1.5 })).toThrow(RangeError);
    expect(() =>
      client.surveys({
        credentials: Array.from({ length: MAX_CREDENTIALS + 1 }, () => "key:1"),
      }),
    ).toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a record that does not fit its type by the field's path", async () => {
    const body = listBody();
    const [wireSurvey] = body["surveys"] as Record<string, unknown>[];
    (wireSurvey!["definition"] as Record<string, unknown>)["questions"] = 7;
    const { client } = clientOver(() => ({ body }));
    await expect(client.surveys()).rejects.toThrow(/definition\.questions/);
  });

  it("reports a malformed envelope field by its path, as the same error class", async () => {
    const body = { ...listBody(), tip: { ...tip, epoch: "1345" } };
    const { client } = clientOver(() => ({ body }));
    const err = await client.surveys().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Cip179DecodeError);
    expect((err as Cip179DecodeError).path).toBe("tip.epoch");
  });

  it("refuses an unknown final state rather than modelling it", async () => {
    const body = {
      ...listBody(),
      finalState: { "aa:0": { state: "vanished" } },
    };
    const { client } = clientOver(() => ({ body }));
    await expect(client.surveys()).rejects.toThrow(/finalState\.aa:0\.state/);
  });
});

describe("compatibility check", () => {
  it("runs once per client, on the first snapshot read only", async () => {
    const { client, urls } = clientOver((url) =>
      url.includes("/api/surveys") ? { body: listBody() } : undefined,
    );
    await client.surveys();
    await client.surveys();
    expect(urls().filter((u) => u.endsWith("/health"))).toHaveLength(1);
  });

  it("refuses another network, and a network-less client accepts any", async () => {
    const { client } = clientOver(
      (url) =>
        url.includes("/api/surveys") ? { body: listBody() } : undefined,
      { network: "preprod" },
    );
    await expect(client.surveys()).rejects.toThrow(/"preview", not "preprod"/);

    const open = clientOver(
      (url) =>
        url.includes("/api/surveys") ? { body: listBody() } : undefined,
      { network: undefined },
    );
    expect((await open.client.surveys()).ready).toBe(true);
  });

  it("refuses another contract major and accepts an unknown minor", async () => {
    const other = clientOver(
      (url) =>
        url.includes("/api/surveys") ? { body: listBody() } : undefined,
      { health: { ok: true, network: "preview", apiVersion: "2.0" } },
    );
    await expect(other.client.surveys()).rejects.toThrow(/API version 2\.0/);

    const minor = clientOver(
      (url) =>
        url.includes("/api/surveys") ? { body: listBody() } : undefined,
      { health: { ok: true, network: "preview", apiVersion: "1.9" } },
    );
    expect((await minor.client.surveys()).ready).toBe(true);
  });

  it("retries the check after a failure instead of caching it", async () => {
    let healthy = false;
    const { client, urls } = clientOver(() => ({ body: listBody() }), {
      health: () =>
        healthy
          ? { body: { ok: true, network: "preview", apiVersion: API_VERSION } }
          : { status: 500, body: "boom" },
    });
    await expect(client.surveys()).rejects.toThrow(TesseraHttpError);
    healthy = true;
    expect((await client.surveys()).ready).toBe(true);
    expect(urls().filter((u) => u.endsWith("/health"))).toHaveLength(2);
  });

  it("does not gate health, artifacts, tip or tx_status", async () => {
    const { client, urls } = clientOver(
      (url) => {
        if (url.endsWith("/api/tip")) return { body: tip };
        if (url.includes("/artifact")) return { status: 404, body: {} };
        if (url.includes("/tx_status")) return { body: { [TX]: null } };
        return undefined;
      },
      {
        health: () => {
          throw new Error("must not be asked");
        },
      },
    );
    expect(await client.tip()).toEqual(tip);
    expect(await client.artifact(KEY)).toBeNull();
    expect(await client.txStatus([TX])).toEqual({ [TX]: null });
    expect(urls().some((u) => u.endsWith("/health"))).toBe(false);
  });
});

describe("not ready", () => {
  it("is a typed answer for the backend's own 503 body", async () => {
    const { client } = clientOver(() => ({
      status: 503,
      body: { error: "snapshot not ready" },
    }));
    expect(await client.surveys()).toEqual({ ready: false });
    expect(await client.wholeBundle(KEY)).toEqual({ ready: false });
    expect(await client.responded(["key:11"])).toEqual({ ready: false });
    expect(await client.responsesByTx(TX)).toEqual({ ready: false });
  });

  it("is not any other 503", async () => {
    const { client } = clientOver(() => ({ status: 503, body: "gateway" }));
    const err = await client.surveys().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TesseraHttpError);
    expect((err as TesseraHttpError).status).toBe(503);
  });
});

describe("surveysByRefs", () => {
  it("names the keys in one refs= query", async () => {
    const { client, urls } = clientOver((url) =>
      url.includes("refs=") ? { body: listBody() } : undefined,
    );
    ready(await client.surveysByRefs([KEY, `${"ab".repeat(32)}:0`]));
    const url = new URL(urls().find((u) => u.includes("refs="))!);
    expect(url.searchParams.get("refs")).toBe(`${KEY},${"ab".repeat(32)}:0`);
  });

  it("refuses an empty, oversized or malformed key list", () => {
    const { client, fetchMock } = clientOver(() => undefined);
    expect(() => client.surveysByRefs([])).toThrow(RangeError);
    expect(() =>
      client.surveysByRefs(
        Array.from({ length: MAX_PAGE_LIMIT + 1 }, () => KEY),
      ),
    ).toThrow(RangeError);
    expect(() => client.surveysByRefs([`${TX}:03`])).toThrow(
      /malformed survey key/,
    );
    expect(() => client.surveysByRefs([`${TX.toUpperCase()}:3`])).toThrow(
      RangeError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("bundle", () => {
  it("reads one page by ref or by key, cursor encoded", async () => {
    const { client, urls } = clientOver((url) =>
      url.includes(`/api/surveys/${TX}/3`)
        ? { body: bundlePage([responseAt("cc".repeat(32))], "150:cc:0") }
        : undefined,
    );
    const page = ready(await client.bundle({ txId: TX_ID, index: 3 }));
    expect(page.survey).toEqual(survey);
    // A custom answer's map and a numeric answer's bigint both survive.
    expect(page.responses).toEqual([responseAt("cc".repeat(32))]);
    expect(page.nextCursor).toBe("150:cc:0");
    expect(page.verdicts).toEqual({ [`${"cc".repeat(32)}:0`]: true });

    ready(await client.bundle(KEY, "150:cc:0"));
    expect(urls().filter((u) => u.includes("/api/surveys/"))).toEqual([
      `${BASE}/api/surveys/${TX}/3`,
      `${BASE}/api/surveys/${TX}/3?cursor=150%3Acc%3A0`,
    ]);
  });

  it("collects every page into one bundle", async () => {
    const { client } = clientOver((url) =>
      url.includes("cursor=")
        ? { body: bundlePage([responseAt("dd".repeat(32))], null) }
        : url.includes("/api/surveys/")
          ? { body: bundlePage([responseAt("cc".repeat(32))], "150:cc:0") }
          : undefined,
    );
    const bundle = ready(await client.wholeBundle(KEY));
    expect(bundle.responses.map((r) => r.txHash)).toEqual([
      "cc".repeat(32),
      "dd".repeat(32),
    ]);
    expect(Object.keys(bundle.verdicts ?? {})).toHaveLength(2);
    expect(bundle.nextCursor).toBeNull();
  });

  it("surfaces an unknown survey as a 404 error", async () => {
    const { client } = clientOver(() => ({
      status: 404,
      body: { error: "unknown survey" },
    }));
    const err = await client.bundle(KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TesseraHttpError);
    expect((err as TesseraHttpError).status).toBe(404);
  });
});

describe("the other routes", () => {
  it("responded: encodes the credential list and decodes the keys", async () => {
    const { client, urls } = clientOver((url) =>
      url.includes("/api/responded?")
        ? { body: { surveyKeys: ["aa:0"], fetchedAt: 1 } }
        : undefined,
    );
    const body = ready(await client.responded(["key:11", "script:22"]));
    expect(body.surveyKeys).toEqual(["aa:0"]);
    const url = new URL(urls().find((u) => u.includes("/api/responded"))!);
    expect(url.searchParams.get("credentials")).toBe("key:11,script:22");
  });

  it("responsesByTx: decodes the rows and refuses a malformed hash", async () => {
    const row = {
      responseIndex: 0,
      surveyKey: KEY,
      role: 0,
      credential: "key:22",
      slot: 150,
    };
    const { client, urls } = clientOver((url) =>
      url.endsWith(`/api/responses/${TX}`)
        ? { body: { responses: [row], fetchedAt: 1 } }
        : undefined,
    );
    expect(ready(await client.responsesByTx(TX)).responses).toEqual([row]);
    expect(urls()).toContain(`${BASE}/api/responses/${TX}`);
    expect(() => client.responsesByTx("abc")).toThrow(/malformed tx hash/);
  });

  it("artifacts: plain JSON by survey or by hash, 404 as null", async () => {
    const artifact = {
      tally: { rulesetHash: "ab", perRole: [{ role: 3, total: "1000" }] },
      provenance: { source: { provider: "koios" } },
    };
    const { client, urls } = clientOver((url) =>
      url.endsWith(`/api/surveys/${TX}/3/artifact`) ||
      url.endsWith(`/api/artifacts/${"ab".repeat(32)}`)
        ? { body: artifact }
        : { status: 404, body: { error: "no artifact" } },
    );
    expect(await client.artifact({ txId: TX_ID, index: 3 })).toEqual(artifact);
    expect(await client.artifact(`${TX}:9`)).toBeNull();
    expect(await client.artifactByHash("ab".repeat(32))).toEqual(artifact);
    expect(() => client.artifactByHash("ab")).toThrow(
      /malformed artifact hash/,
    );
    expect(urls()).toHaveLength(3);
  });

  it("txStatus: bounds and validates the list, answers {} for none", async () => {
    const { client, urls, fetchMock } = clientOver((url) =>
      url.includes("/api/tx_status?")
        ? { body: { [TX]: 3, ["cd".repeat(32)]: null } }
        : undefined,
    );
    expect(await client.txStatus([])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await client.txStatus([TX, "cd".repeat(32)])).toEqual({
      [TX]: 3,
      ["cd".repeat(32)]: null,
    });
    expect(new URL(urls()[0]!).searchParams.get("hashes")).toBe(
      `${TX},${"cd".repeat(32)}`,
    );
    expect(() =>
      client.txStatus(
        Array.from({ length: MAX_TX_STATUS_HASHES + 1 }, () => TX),
      ),
    ).toThrow(RangeError);
    expect(() => client.txStatus(["zz"])).toThrow(/malformed tx hash/);
  });

  it("health and liveness: decoded, with a trailing slash trimmed from the base", async () => {
    const health = {
      network: "preview",
      apiVersion: API_VERSION,
      commit: "abc",
      snapshot: { fetchedAt: 1, ageSeconds: 2 },
      lastRefresh: null,
      scan: { cursorSlot: null, caughtUp: false },
      last24h: {
        runs: 1,
        failures: 0,
        upstreamRequests: 3,
        koiosCalls: 2,
        passthroughCalls: 0,
      },
      validationBacklog: 0,
      quotas: { subrequestsPerInvocation: 1000, koiosCallsPerDay: null },
    };
    const { client, urls } = clientOver(
      (url) => (url.endsWith("/api/health") ? { body: health } : undefined),
      { baseUrl: `${BASE}/` },
    );
    expect(await client.health()).toEqual(health);
    expect(await client.liveness()).toEqual({
      ok: true,
      network: "preview",
      apiVersion: API_VERSION,
    });
    expect(urls()).toEqual([`${BASE}/api/health`, `${BASE}/health`]);
  });

  it("pparams: the wire form decoded, typed by the caller", async () => {
    const { client } = clientOver((url) =>
      url.endsWith("/api/pparams")
        ? { body: { minFeeA: { $bigint: "44" }, maxTxSize: 16384 } }
        : undefined,
    );
    expect(await client.pparams()).toEqual({ minFeeA: 44n, maxTxSize: 16384 });
  });

  it("names the failing request in a non-2xx error", async () => {
    const { client } = clientOver(() => ({ status: 500, body: "boom" }));
    await expect(client.tip()).rejects.toThrow(`${BASE}/api/tip → 500: "boom"`);
  });
});
