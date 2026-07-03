/**
 * Route tests for the per-page endpoints, against an in-memory SnapshotStore —
 * no Koios, no SQLite. Only the snapshot-derived routes are exercised (the
 * passthroughs `/api/tip`, `/api/tx_status`, `/api/pparams` go upstream).
 */

import { describe, expect, it } from "vitest";

import { Role, type Credential, type SurveyDefinition } from "cip-179";
import { fromJsonSafe, hexToBytes, toJsonSafe } from "@tessera/core";
import type {
  CancellationRecord,
  ChainTip,
  ResponseRecord,
  SurveyBundle,
  SurveyRecord,
} from "@tessera/core";

import { loadConfig } from "./config";
import { createApp } from "./http";
import type { CachedSnapshot } from "./store";
import { memBackendStore, type MemBackendStore } from "./store-mem";

const memStore = (initial: CachedSnapshot | null): MemBackendStore =>
  memBackendStore(initial);

function appWith(store: MemBackendStore) {
  return createApp(loadConfig({}), store, { compress: false });
}

// --- fixture snapshot --------------------------------------------------------

const TX_A = "aa".repeat(32);
const TX_B = "bb".repeat(32);

const tip: ChainTip = {
  epoch: 500,
  slot: 1_000_000,
  time: 1_750_000_000,
  epochSlot: 5_000,
  govActionLifetime: 6,
};

// Routes never look inside a definition — a minimal stand-in keeps the fixture
// readable without hand-building every CIP-179 field.
const def = { endEpoch: 510 } as unknown as SurveyDefinition;

const surveyA: SurveyRecord = {
  txHash: TX_A,
  slot: 900_000,
  epochNo: 499,
  ref: { txId: hexToBytes(TX_A), index: 0 },
  definition: def,
};
const surveyB: SurveyRecord = {
  txHash: TX_B,
  slot: 910_000,
  epochNo: 499,
  ref: { txId: hexToBytes(TX_B), index: 1 },
  definition: def,
};

const cred1: Credential = { type: "key", keyHash: hexToBytes("11") };
const cred2: Credential = { type: "script", scriptHash: hexToBytes("22") };

function response(
  survey: SurveyRecord,
  credential: Credential,
  slot: number,
  txHash: string,
): ResponseRecord {
  return {
    txHash,
    slot,
    epochNo: 500,
    responseIndex: 0,
    response: {
      specVersion: 1,
      surveyRef: survey.ref,
      role: Role.Stakeholder,
      credential,
      answers: { type: "public", answers: [] },
    },
  };
}

const responses = [
  response(surveyA, cred1, 950_000, "cc".repeat(32)),
  response(surveyA, cred1, 960_000, "dd".repeat(32)), // supersedes the first
  response(surveyA, cred2, 955_000, "ee".repeat(32)),
  response(surveyB, cred2, 956_000, "ff".repeat(32)),
];

const cancellation: CancellationRecord = {
  txHash: "99".repeat(32),
  slot: 970_000,
  epochNo: 500,
  target: surveyB.ref,
  proof: null,
};

const FETCHED_AT = 1_750_000_100;
const snapshot: CachedSnapshot = {
  payload: toJsonSafe({
    records: {
      surveys: [surveyA, surveyB],
      responses,
      cancellations: [cancellation],
    },
    tip,
    govLinks: [],
  }),
  fetchedAt: FETCHED_AT,
};

// --- tests -------------------------------------------------------------------

describe("before the first refresh", () => {
  const app = appWith(memStore(null));
  it.each(["/api/surveys", `/api/surveys/${TX_A}/0`, "/api/responded"])(
    "%s answers 503",
    async (path) => {
      expect((await app.request(path)).status).toBe(503);
    },
  );
});

describe("GET /api/surveys", () => {
  const app = appWith(memStore(snapshot));

  it("serves the list payload with deduped response counts", async () => {
    const res = await app.request("/api/surveys");
    expect(res.status).toBe(200);
    const body = fromJsonSafe(await res.json()) as Record<string, unknown>;
    expect((body["surveys"] as unknown[]).length).toBe(2);
    expect((body["cancellations"] as unknown[]).length).toBe(1);
    // cred1's earlier response is superseded: 2 distinct responders on A.
    expect(body["responseCounts"]).toEqual({
      [`${TX_A}:0`]: 2,
      [`${TX_B}:1`]: 1,
    });
    expect((body["tip"] as ChainTip).epoch).toBe(tip.epoch);
    expect(body["fetchedAt"]).toBe(FETCHED_AT);
  });

  it("revalidates by fetchedAt: 304 on matching If-None-Match", async () => {
    const first = await app.request("/api/surveys");
    const etag = first.headers.get("ETag");
    expect(etag).toBe(`W/"surveys-${FETCHED_AT}"`);
    expect(first.headers.get("Cache-Control")).toBe("no-cache");
    const again = await app.request("/api/surveys", {
      headers: { "If-None-Match": etag! },
    });
    expect(again.status).toBe(304);
  });
});

describe("GET /api/surveys/{txHash}/{index}", () => {
  const app = appWith(memStore(snapshot));

  it("serves a self-contained bundle sliced to that survey", async () => {
    const res = await app.request(`/api/surveys/${TX_A}/0`);
    expect(res.status).toBe(200);
    const body = fromJsonSafe(await res.json()) as unknown as SurveyBundle;
    expect(body.survey.txHash).toBe(TX_A);
    // ALL of A's responses ride along (raw, superseded one included) — the
    // client audit needs them; B's don't.
    expect(body.responses.map((r) => r.txHash).sort()).toEqual([
      "cc".repeat(32),
      "dd".repeat(32),
      "ee".repeat(32),
    ]);
    expect(body.cancellations).toEqual([]);
    expect(body.tip.epoch).toBe(tip.epoch);
  });

  it("includes the cancellations targeting the survey", async () => {
    const res = await app.request(`/api/surveys/${TX_B}/1`);
    const body = fromJsonSafe(await res.json()) as unknown as SurveyBundle;
    expect(body.cancellations.map((c) => c.txHash)).toEqual(["99".repeat(32)]);
    expect(body.responses.map((r) => r.txHash)).toEqual(["ff".repeat(32)]);
  });

  it("404s an unknown or malformed ref", async () => {
    expect((await app.request(`/api/surveys/${TX_A}/7`)).status).toBe(404);
    expect(
      (await app.request(`/api/surveys/${"00".repeat(32)}/0`)).status,
    ).toBe(404);
    expect((await app.request("/api/surveys/nothex/0")).status).toBe(404);
    expect((await app.request(`/api/surveys/${TX_A}/x`)).status).toBe(404);
  });

  it("supports 304 revalidation", async () => {
    const first = await app.request(`/api/surveys/${TX_A}/0`);
    const again = await app.request(`/api/surveys/${TX_A}/0`, {
      headers: { "If-None-Match": first.headers.get("ETag")! },
    });
    expect(again.status).toBe(304);
  });
});

describe("artifact routes", () => {
  const HASH = "ab".repeat(32);
  // Deliberately non-canonical spacing: the stored text must be served
  // byte-for-byte, never re-serialized.
  const ARTIFACT_TEXT = `{"tally": {"x": 1},  "provenance": {}}`;

  function storeWithArtifact() {
    const store = memStore(snapshot);
    void store.putArtifact({
      surveyKey: `${TX_A}:0`,
      endEpoch: 510,
      artifactHash: HASH,
      artifact: ARTIFACT_TEXT,
      createdAt: 1,
    });
    return store;
  }

  it("serves the stored JSON verbatim with a strong immutable ETag", async () => {
    const app = appWith(storeWithArtifact());
    for (const path of [
      `/api/surveys/${TX_A}/0/artifact`,
      `/api/artifacts/${HASH}`,
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(ARTIFACT_TEXT); // byte identity
      expect(res.headers.get("ETag")).toBe(`"${HASH}"`);
      expect(res.headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(res.headers.get("Content-Type")).toContain("application/json");
    }
  });

  it("answers 304 on a matching If-None-Match", async () => {
    const app = appWith(storeWithArtifact());
    const res = await app.request(`/api/surveys/${TX_A}/0/artifact`, {
      headers: { "If-None-Match": `"${HASH}"` },
    });
    expect(res.status).toBe(304);
  });

  it("404s when no artifact exists or the ref/hash is malformed", async () => {
    const app = appWith(storeWithArtifact());
    expect((await app.request(`/api/surveys/${TX_B}/1/artifact`)).status).toBe(
      404,
    );
    expect(
      (await app.request(`/api/artifacts/${"00".repeat(32)}`)).status,
    ).toBe(404);
    expect((await app.request("/api/surveys/nothex/0/artifact")).status).toBe(
      404,
    );
    expect((await app.request("/api/artifacts/nothex")).status).toBe(404);
  });
});

describe("GET /api/responded", () => {
  const app = appWith(memStore(snapshot));

  const keysFor = async (credentials: string): Promise<string[]> => {
    const res = await app.request(
      `/api/responded?credentials=${encodeURIComponent(credentials)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { surveyKeys: string[] };
    return body.surveyKeys.sort();
  };

  it("returns the survey keys answered by any given credential", async () => {
    // Raw responses (no dedupe): cred1 only ever answered A.
    expect(await keysFor("key:11")).toEqual([`${TX_A}:0`]);
    expect(await keysFor("script:22")).toEqual([`${TX_A}:0`, `${TX_B}:1`]);
    // Union across the wallet's credentials, one request.
    expect(await keysFor("key:11,script:22")).toEqual([
      `${TX_A}:0`,
      `${TX_B}:1`,
    ]);
  });

  it("credential kinds don't cross-match, unknowns match nothing", async () => {
    expect(await keysFor("script:11")).toEqual([]);
    expect(await keysFor("key:deadbeef")).toEqual([]);
  });

  it("no credentials → no keys", async () => {
    const res = await app.request("/api/responded");
    expect(((await res.json()) as { surveyKeys: string[] }).surveyKeys).toEqual(
      [],
    );
  });
});
