/**
 * Route tests against a real store on an in-memory database, so a route and
 * the SQL under it are exercised together. The passthroughs `/api/tip` and
 * `/api/tx_status` reach Koios through a stubbed `fetch`. `/api/pparams` is not
 * exercised end-to-end: evolution-sdk maps its response through a schema
 * wanting some sixty fields, so what it caches on is covered through
 * `keyedCache` instead.
 *
 * The fixture is materialized through `materializeSnapshot`, exactly as a
 * refresh does, so a route test can't pass against rows the refresh would
 * never write.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { Role, type Credential, type SurveyDefinition } from "cip-179";
import { hexToBytes, refKey } from "cip-179/domain";
import { fromJsonSafe, toJsonSafe } from "cip-179/tally";
import {
  encodeResponseCursor,
  encodeSurveyCursor,
  parseSurveyCursor,
} from "cardano-tessera-core";
import type {
  CancellationRecord,
  ChainTip,
  GovLink,
  ResponseRecord,
  SurveyBundle,
  SurveyRecord,
} from "cip-179/domain";

import { loadConfig } from "./config";
import { createApp, keyedCache } from "./http";
import { materializeSnapshot } from "./materialize";
import { ALL_SLOTS, testStore, type TestStore } from "./testing/store";
import type { ValidatedResponseRow } from "./store";

function appWith(store: TestStore) {
  return createApp(loadConfig({}), store, { compress: false });
}

/** Materialize the fixture snapshot into the store, as the refresh does. */
async function seed(
  store: TestStore,
  govLinks: readonly GovLink[] = [],
  extraResponses: readonly ResponseRecord[] = [],
): Promise<void> {
  const snapshot = materializeSnapshot(
    {
      surveys: [surveyA, surveyB],
      responses: [...responses, ...extraResponses],
      cancellations: [cancellation],
    },
    tip,
    govLinks,
    (await store.touchedRows([surveyA, surveyB].map((s) => refKey(s.ref))))
      .finalStates,
  );
  await store.reconcileSegment(
    ALL_SLOTS,
    snapshot.surveys,
    snapshot.responses,
    snapshot.cancellations,
    [],
    {
      tip: JSON.stringify(toJsonSafe(tip)),
      incomplete: false,
      fetchedAt: FETCHED_AT,
      listCounts: JSON.stringify(snapshot.listCounts),
    },
  );
}

async function seededStore(): Promise<TestStore> {
  const store = testStore();
  await seed(store);
  return store;
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

const cred1: Credential = { type: "key", keyHash: hexToBytes("11") };
const cred2: Credential = { type: "script", scriptHash: hexToBytes("22") };

// The per-survey routes never look inside a definition, but the list index
// builder aggregates real fields (owner, submission mode, searchable text) —
// so the stand-in carries the minimum honest set.
const defFor = (
  endEpoch: number,
  owner: Credential,
  title: string,
): SurveyDefinition =>
  ({
    specVersion: 5,
    owner,
    title,
    description: "",
    eligibleRoles: [],
    endEpoch,
    submissionMode: { type: "public" },
    questions: [],
  }) as unknown as SurveyDefinition;

// A is open at the fixture tip (epoch 500 ≤ 510) and owned by cred1;
// B closed (499 < 500) and owned by cred2 — so buckets, the `active`/`mine`
// filters, and search all have something to distinguish.
const surveyA: SurveyRecord = {
  txHash: TX_A,
  slot: 900_000,
  epochNo: 499,
  ref: { txId: hexToBytes(TX_A), index: 0 },
  definition: defFor(510, cred1, "alpha budget"),
};
const surveyB: SurveyRecord = {
  txHash: TX_B,
  slot: 910_000,
  epochNo: 499,
  ref: { txId: hexToBytes(TX_B), index: 1 },
  definition: defFor(499, cred2, "beta poll"),
};

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

// Epoch-aligned with survey A (expiry epoch 510 === its end_epoch), so it counts
// as a verified link rather than riding along undisplayed.
const govLinkA: GovLink = {
  surveyKey: `${TX_A}:0`,
  actionId: "gov_action1alpha",
  endEpoch: 510,
  title: "Fund the alpha budget",
};

const FETCHED_AT = 1_750_000_100;

// --- tests -------------------------------------------------------------------

describe("GET /health", () => {
  it("reports the exact configured preprod identity", async () => {
    const app = createApp(loadConfig({ NETWORK: "preprod" }), testStore(), {
      compress: false,
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, network: "preprod" });
  });
});

describe("before the first refresh", () => {
  const app = appWith(testStore());
  it.each([
    "/api/surveys",
    `/api/surveys/${TX_A}/0`,
    "/api/responded",
    `/api/responses/${"cc".repeat(32)}`,
  ])("%s answers 503", async (path) => {
    expect((await app.request(path)).status).toBe(503);
  });
});

describe("GET /api/surveys", () => {
  it("serves the list payload with deduped response counts", async () => {
    const app = appWith(await seededStore());
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
    expect(body["nextCursor"]).toBeNull();
    expect(body["counts"]).toEqual({
      all: 2,
      linked: 0,
      active: 1,
      sealed: 0,
      public: 1,
      mine: 0,
    });
  });

  it("revalidates by fetchedAt: 304 on matching If-None-Match", async () => {
    const app = appWith(await seededStore());
    const first = await app.request("/api/surveys");
    const etag = first.headers.get("ETag");
    expect(etag).toBe(`W/"surveys-${FETCHED_AT}"`);
    expect(first.headers.get("Cache-Control")).toBe("no-cache");
    const again = await app.request("/api/surveys", {
      headers: { "If-None-Match": etag! },
    });
    expect(again.status).toBe(304);
  });

  it("reports each decided survey's final state with its artifact hash", async () => {
    const store = await seededStore();
    await store.putArtifact({
      surveyKey: `${TX_A}:0`,
      endEpoch: 510,
      artifactHash: "a1".repeat(32),
      artifact: `{"tally":{"perRole":[{"role":3}]},"provenance":{}}`,
      createdAt: 1,
    });
    await store.putArtifact({
      surveyKey: `${TX_B}:1`,
      endEpoch: 510,
      artifactHash: "b2".repeat(32),
      artifact:
        `{"tally":{"cancelled":{"txHash":"${"99".repeat(32)}",` +
        `"slot":970000,"epoch":500},"perRole":[]},"provenance":{}}`,
      createdAt: 1,
    });
    // The overlay is baked into the rows at refresh time.
    await seed(store);
    const res = await appWith(store).request("/api/surveys");
    const body = fromJsonSafe(await res.json()) as Record<string, unknown>;
    expect(body["finalState"]).toEqual({
      [`${TX_A}:0`]: { state: "finalized", artifactHash: "a1".repeat(32) },
      [`${TX_B}:1`]: { state: "cancelled", artifactHash: "b2".repeat(32) },
    });
  });

  it("reports a persisted untalliable verdict, hash-less", async () => {
    const store = await seededStore();
    await store.putUntalliable([`${TX_B}:1`], 1);
    await seed(store);
    const body = fromJsonSafe(
      await (await appWith(store).request("/api/surveys")).json(),
    ) as Record<string, unknown>;
    expect(body["finalState"]).toEqual({
      [`${TX_B}:1`]: { state: "untalliable" },
    });
  });

  it("finalState is empty with nothing decided", async () => {
    const app = appWith(await seededStore());
    const body = fromJsonSafe(
      await (await app.request("/api/surveys")).json(),
    ) as Record<string, unknown>;
    expect(body["finalState"]).toEqual({});
  });

  // A refresh whose gov-links fetch failed re-projects nothing from a set it
  // never read: each survey's row carries its own slice through untouched, so
  // the app never loses the linkage for an interval. What comes back out of
  // the rows has to survive the round trip whole — links, flags, counts and
  // searchable text alike.
  it("keeps the links a failed gov-links fetch would have blanked", async () => {
    const store = await seededStore();
    await seed(store, [govLinkA]);
    const linked = fromJsonSafe(
      await (await appWith(store).request("/api/surveys")).json(),
    ) as Record<string, unknown>;

    const recovered = [
      ...(await store.sweepInputs(null, 0, 0)).govLinks.values(),
    ].flat();
    expect(recovered).toEqual([govLinkA]);
    await seed(store, recovered); // the next refresh, gov links unreachable
    const body = fromJsonSafe(
      await (await appWith(store).request("/api/surveys")).json(),
    ) as Record<string, unknown>;
    expect(body["govLinks"]).toEqual([govLinkA]);
    expect(body["counts"]).toEqual(linked["counts"]);
    const stored = store.surveyRows;
    expect(stored.map((r) => [r.surveyKey, r.govLinked])).toEqual([
      [`${TX_A}:0`, true],
      [`${TX_B}:1`, false],
    ]);
    // The action's id and title stay searchable, as on a good refresh —
    // neither appears in the on-chain definition.
    const searched = fromJsonSafe(
      await (
        await appWith(store).request("/api/surveys?q=gov_action1alpha")
      ).json(),
    ) as Record<string, unknown>;
    expect((searched["surveys"] as unknown[]).length).toBe(1);
  });
});

describe("GET /api/surveys selection: paging, filters, search, refs", () => {
  const keysOf = (body: Record<string, unknown>): string[] =>
    (body["surveys"] as { txHash: string }[]).map(
      (s) => `${s.txHash}:${s.txHash === TX_A ? 0 : 1}`,
    );
  const getBody = async (
    app: ReturnType<typeof appWith>,
    qs: string,
  ): Promise<Record<string, unknown>> => {
    const res = await app.request(`/api/surveys${qs}`);
    expect(res.status).toBe(200);
    return fromJsonSafe(await res.json()) as Record<string, unknown>;
  };

  it("walks pages by cursor: open bucket first, then closed", async () => {
    const app = appWith(await seededStore());
    const page1 = await getBody(app, "?limit=1");
    expect(keysOf(page1)).toEqual([`${TX_A}:0`]); // open bucket sorts first
    expect(page1["nextCursor"]).toBeTypeOf("string");
    // Page slices ride restricted to their page's surveys.
    expect(page1["responseCounts"]).toEqual({ [`${TX_A}:0`]: 2 });
    expect((page1["cancellations"] as unknown[]).length).toBe(0);

    const page2 = await getBody(
      app,
      `?limit=1&cursor=${encodeURIComponent(page1["nextCursor"] as string)}`,
    );
    expect(keysOf(page2)).toEqual([`${TX_B}:1`]);
    expect((page2["cancellations"] as unknown[]).length).toBe(1);
    expect(page2["nextCursor"]).toBeNull();
  });

  it("flags resync on a cursor from another snapshot generation", async () => {
    const app = appWith(await seededStore());
    const page1 = await getBody(app, "?limit=1");
    const cursor = parseSurveyCursor(page1["nextCursor"] as string)!;
    expect(cursor.generation).toBe(page1["fetchedAt"]);
    // Same generation: no resync.
    const same = await getBody(
      app,
      `?limit=1&cursor=${encodeURIComponent(page1["nextCursor"] as string)}`,
    );
    expect(same["resync"]).toBeUndefined();
    // Older generation: best-effort page + resync.
    const staleCursor = encodeSurveyCursor({
      ...cursor,
      generation: cursor.generation! - 1,
    });
    const stale = await getBody(
      app,
      `?limit=1&cursor=${encodeURIComponent(staleCursor)}`,
    );
    expect(stale["resync"]).toBe(true);
    expect(keysOf(stale)).toEqual([`${TX_B}:1`]);
  });

  it("filters: active excludes the closed survey", async () => {
    const app = appWith(await seededStore());
    const body = await getBody(app, "?filter=active");
    expect(keysOf(body)).toEqual([`${TX_A}:0`]);
  });

  it("filters: mine matches owners against the given credentials", async () => {
    const app = appWith(await seededStore());
    const body = await getBody(app, "?filter=mine&credentials=key:11");
    expect(keysOf(body)).toEqual([`${TX_A}:0`]);
    expect((body["counts"] as { mine: number }).mine).toBe(1);
    const none = await getBody(app, "?filter=mine");
    expect(none["surveys"]).toEqual([]);
  });

  it("serves banked counts without aggregating; a search aggregates live", async () => {
    const store = await seededStore();
    let aggregates = 0;
    const counting = {
      ...store,
      surveyIndexCounts: (
        tipEpoch: number,
        credentials: readonly string[],
        searchTerms: readonly string[],
      ) => {
        aggregates++;
        return store.surveyIndexCounts(tipEpoch, credentials, searchTerms);
      },
    };
    const app = appWith(counting);

    // No search: the counts come from the envelope, and they must be exactly
    // what the live aggregate would have said.
    const body = await getBody(app, "");
    expect(aggregates).toBe(0);
    expect(body["counts"]).toEqual(
      await store.surveyIndexCounts(tip.epoch, [], []),
    );
    // Credentials add only the indexed owner count, never the aggregate.
    const mine = await getBody(app, "?credentials=key:11");
    expect(aggregates).toBe(0);
    expect((mine["counts"] as { mine: number }).mine).toBe(1);
    // A search scopes counts to the matching set — banked counts can't.
    await getBody(app, "?q=alpha");
    expect(aggregates).toBe(1);
  });

  it("aggregates live when the envelope predates the banked counts", async () => {
    const store = await seededStore();
    const meta = await store.snapshotMeta();
    await store.publishSnapshotMeta({ ...meta!, listCounts: null });
    const body = await getBody(appWith(store), "");
    expect(body["counts"]).toEqual({
      all: 2,
      linked: 0,
      active: 1,
      sealed: 0,
      public: 1,
      mine: 0,
    });
  });

  it("search ANDs terms and scopes counts to matches", async () => {
    const app = appWith(await seededStore());
    const body = await getBody(app, "?q=beta");
    expect(keysOf(body)).toEqual([`${TX_B}:1`]);
    expect((body["counts"] as { all: number }).all).toBe(1);
    const both = await getBody(app, "?q=alpha%20budget");
    expect(keysOf(both)).toEqual([`${TX_A}:0`]);
  });

  it("treats LIKE wildcards in a search term as literals", async () => {
    const app = appWith(await seededStore());
    // Unescaped, `%` would match every haystack instead of none.
    const body = await getBody(app, "?q=%25");
    expect(body["surveys"]).toEqual([]);
    expect((body["counts"] as { all: number }).all).toBe(0);
  });

  it("rejects malformed paging params", async () => {
    const app = appWith(await seededStore());
    expect((await app.request("/api/surveys?limit=0")).status).toBe(400);
    expect((await app.request("/api/surveys?limit=9999")).status).toBe(400);
    expect((await app.request("/api/surveys?limit=abc")).status).toBe(400);
    expect((await app.request("/api/surveys?filter=bogus")).status).toBe(400);
    expect((await app.request("/api/surveys?cursor=junk")).status).toBe(400);
  });

  it("answers exactly the refs named, with no counts and no cursor", async () => {
    const store = await seededStore();
    await seed(store, [govLinkA]);
    const body = await getBody(appWith(store), `?refs=${TX_B}:1,${TX_A}:0`);
    // Key order, not the caller's — the read is chunked, so its own order is
    // the only stable one.
    expect(keysOf(body)).toEqual([`${TX_A}:0`, `${TX_B}:1`]);
    expect(body["responseCounts"]).toEqual({
      [`${TX_A}:0`]: 2,
      [`${TX_B}:1`]: 1,
    });
    expect((body["cancellations"] as unknown[]).length).toBe(1);
    expect(body["govLinks"]).toEqual([govLinkA]);
    expect(body["fetchedAt"]).toBe(FETCHED_AT);
    // A named set has no filtered order to page and no set to count over.
    expect(body["counts"]).toBeUndefined();
    expect(body["nextCursor"]).toBeUndefined();
  });

  it("omits a ref that names nothing instead of failing", async () => {
    const body = await getBody(
      appWith(await seededStore()),
      `?refs=${TX_A}:0,${"11".repeat(32)}:0,${TX_A}:9`,
    );
    expect(keysOf(body)).toEqual([`${TX_A}:0`]);
  });

  it("rejects refs beside a paging param, and malformed or oversized refs", async () => {
    const app = appWith(await seededStore());
    for (const qs of [
      `?refs=${TX_A}:0&limit=1`,
      `?refs=${TX_A}:0&filter=linked`,
      `?refs=${TX_A}:0&q=alpha`,
      `?refs=${TX_A}:0&cursor=junk`,
    ])
      expect((await app.request(`/api/surveys${qs}`)).status).toBe(400);
    const oversized = Array.from({ length: 201 }, () => `${TX_A}:0`).join(",");
    for (const refs of [
      "",
      "nothex:0",
      TX_A,
      `${TX_A}:01`,
      `${TX_A}:-1`,
      oversized,
    ])
      expect(
        (await app.request(`/api/surveys?refs=${encodeURIComponent(refs)}`))
          .status,
      ).toBe(400);
  });
});

describe("GET /api/surveys/{txHash}/{index}", () => {
  it("serves a self-contained bundle sliced to that survey", async () => {
    const app = appWith(await seededStore());
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
    const app = appWith(await seededStore());
    const res = await app.request(`/api/surveys/${TX_B}/1`);
    const body = fromJsonSafe(await res.json()) as unknown as SurveyBundle;
    expect(body.cancellations.map((c) => c.txHash)).toEqual(["99".repeat(32)]);
    expect(body.responses.map((r) => r.txHash)).toEqual(["ff".repeat(32)]);
  });

  it("ships decided proof verdicts; undecided rows are omitted", async () => {
    const store = await seededStore();
    const row = (
      txHash: string,
      proofOk: boolean | null,
    ): ValidatedResponseRow => ({
      txHash,
      responseIndex: 0,
      surveyKey: `${TX_A}:0`,
      role: 0,
      credential: "key:11",
      slot: 999_000,
      epochNo: 499,
      blockIndex: 1,
      proofOk,
      linkedActionId: null,
      wellFormed: true,
      checkedAt: 1,
    });
    await store.upsertValidatedResponses([
      row("cc".repeat(32), true),
      row("dd".repeat(32), false),
      row("ee".repeat(32), null), // enrichment pending — must not ship
    ]);
    const app = appWith(store);
    const body = (await (
      await app.request(`/api/surveys/${TX_A}/0`)
    ).json()) as { verdicts: Record<string, boolean> };
    expect(body.verdicts).toEqual({
      [`${"cc".repeat(32)}:0`]: true,
      [`${"dd".repeat(32)}:0`]: false,
    });
    // Nothing validated yet → present-but-empty: "serving tier, all pending",
    // distinct from the field's absence on a proof-less source.
    const other = (await (
      await app.request(`/api/surveys/${TX_B}/1`)
    ).json()) as { verdicts: Record<string, boolean> };
    expect(other.verdicts).toEqual({});
  });

  it("carries the survey's own governance links, and only those", async () => {
    const store = await seededStore();
    await seed(store, [govLinkA]);
    const app = appWith(store);
    const linked = fromJsonSafe(
      await (await app.request(`/api/surveys/${TX_A}/0`)).json(),
    ) as Record<string, unknown>;
    expect(linked["govLinks"]).toEqual([govLinkA]);
    // Present-but-empty on an unlinked survey: "none as of the last link pass",
    // distinct from the field's absence on a source with no anchor machinery.
    const unlinked = fromJsonSafe(
      await (await app.request(`/api/surveys/${TX_B}/1`)).json(),
    ) as Record<string, unknown>;
    expect(unlinked["govLinks"]).toEqual([]);
  });

  it("pages the responses, the survey riding every page", async () => {
    const store = testStore();
    // 199 more responses on A, each in its own transaction, so A holds 202 and
    // the 200-row page boundary is crossed once with a remainder.
    const extra = Array.from({ length: 199 }, (_, i) =>
      response(
        surveyA,
        cred1,
        970_000 + i,
        (i + 1).toString(16).padStart(64, "0"),
      ),
    );
    await seed(store, [], extra);
    const app = appWith(store);
    const pageOf = async (qs: string): Promise<Record<string, unknown>> => {
      const res = await app.request(`/api/surveys/${TX_A}/0${qs}`);
      expect(res.status).toBe(200);
      return fromJsonSafe(await res.json()) as Record<string, unknown>;
    };

    const first = await pageOf("");
    expect((first["responses"] as unknown[]).length).toBe(200);
    expect(first["nextCursor"]).toBeTypeOf("string");
    const second = await pageOf(
      `?cursor=${encodeURIComponent(first["nextCursor"] as string)}`,
    );
    expect((second["responses"] as unknown[]).length).toBe(2);
    expect(second["nextCursor"]).toBeNull();

    // Every page describes the whole survey; only the responses are the page.
    for (const page of [first, second]) {
      expect((page["survey"] as { txHash: string }).txHash).toBe(TX_A);
      expect(page["govLinks"]).toEqual([]);
      expect(page["cancellations"]).toEqual([]);
      expect(page["resync"]).toBeUndefined();
    }
    // No row served twice or skipped, and the order is (slot, tx, index).
    const seen = [
      ...(first["responses"] as { slot: number }[]),
      ...(second["responses"] as { slot: number }[]),
    ];
    expect(seen.length).toBe(202);
    expect(new Set(seen.map((r) => JSON.stringify(r))).size).toBe(202);
    expect(seen.map((r) => r.slot)).toEqual(
      [...seen.map((r) => r.slot)].sort((a, b) => a - b),
    );
  });

  it("flags a cursor from an older snapshot instead of stitching", async () => {
    const app = appWith(await seededStore());
    const stale = encodeResponseCursor({
      slot: 950_000,
      txHash: "cc".repeat(32),
      responseIndex: 0,
      generation: FETCHED_AT - 1,
    });
    const body = (await (
      await app.request(
        `/api/surveys/${TX_A}/0?cursor=${encodeURIComponent(stale)}`,
      )
    ).json()) as Record<string, unknown>;
    expect(body["resync"]).toBe(true);
    // Still answered from the current snapshot — the flag is the contract, not
    // an error.
    expect((body["responses"] as unknown[]).length).toBe(2);
    expect(
      (await app.request(`/api/surveys/${TX_A}/0?cursor=junk`)).status,
    ).toBe(400);
  });

  it("404s an unknown or malformed ref", async () => {
    const app = appWith(await seededStore());
    expect((await app.request(`/api/surveys/${TX_A}/7`)).status).toBe(404);
    expect(
      (await app.request(`/api/surveys/${"00".repeat(32)}/0`)).status,
    ).toBe(404);
    expect((await app.request("/api/surveys/nothex/0")).status).toBe(404);
    expect((await app.request(`/api/surveys/${TX_A}/x`)).status).toBe(404);
  });

  it("supports 304 revalidation", async () => {
    const app = appWith(await seededStore());
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

  async function storeWithArtifact() {
    const store = await seededStore();
    await store.putArtifact({
      surveyKey: `${TX_A}:0`,
      endEpoch: 510,
      artifactHash: HASH,
      artifact: ARTIFACT_TEXT,
      createdAt: 1,
    });
    return store;
  }

  it("serves the stored JSON verbatim with a strong immutable ETag", async () => {
    const app = appWith(await storeWithArtifact());
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
    const app = appWith(await storeWithArtifact());
    const res = await app.request(`/api/surveys/${TX_A}/0/artifact`, {
      headers: { "If-None-Match": `"${HASH}"` },
    });
    expect(res.status).toBe(304);
  });

  it("404s when no artifact exists or the ref/hash is malformed", async () => {
    const app = appWith(await storeWithArtifact());
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
  const keysFor = async (credentials: string): Promise<string[]> => {
    const app = appWith(await seededStore());
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
    const app = appWith(await seededStore());
    const res = await app.request("/api/responded");
    expect(((await res.json()) as { surveyKeys: string[] }).surveyKeys).toEqual(
      [],
    );
  });

  // Both routes bind these into an `IN (…)`, which D1 caps at 100 parameters:
  // an oversized list is rejected rather than turned into a 500 downstream.
  it("rejects an abusively long credential list", async () => {
    const app = appWith(await seededStore());
    const many = Array.from({ length: 21 }, (_, i) => `key:${i}`).join(",");
    for (const path of ["/api/responded?", "/api/surveys?filter=mine&"]) {
      expect((await app.request(`${path}credentials=${many}`)).status).toBe(
        400,
      );
    }
  });
});

describe("GET /api/responses/{txHash}", () => {
  const TX_CC = "cc".repeat(32);

  // One transaction carrying two responses, like a batch submission: the
  // fixture "cc" response (index 0, survey A) plus a second at index 1.
  const secondInSameTx: ResponseRecord = {
    ...response(surveyB, cred1, 950_000, TX_CC),
    responseIndex: 1,
  };

  const storeWithBatchTx = async (): Promise<TestStore> => {
    const store = testStore();
    await seed(store, [], [secondInSameTx]);
    return store;
  };

  it("serves the transaction's responses in index order", async () => {
    const app = appWith(await storeWithBatchTx());
    const res = await app.request(`/api/responses/${TX_CC}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      responses: [
        {
          txHash: TX_CC,
          responseIndex: 0,
          surveyKey: `${TX_A}:0`,
          role: Role.Stakeholder,
          credential: "key:11",
          slot: 950_000,
        },
        {
          txHash: TX_CC,
          responseIndex: 1,
          surveyKey: `${TX_B}:1`,
          role: Role.Stakeholder,
          credential: "key:11",
          slot: 950_000,
        },
      ],
      fetchedAt: FETCHED_AT,
    });
  });

  // A submission the snapshot hasn't caught up to is the normal case this
  // route exists for — absence is an answer, never an error.
  it("answers an unknown transaction with an empty list, not 404", async () => {
    const app = appWith(await seededStore());
    const res = await app.request(`/api/responses/${"12".repeat(32)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      responses: [],
      fetchedAt: FETCHED_AT,
    });
  });

  it("rejects a malformed hash", async () => {
    const app = appWith(await seededStore());
    expect((await app.request("/api/responses/nothex")).status).toBe(404);
  });

  it("revalidates by fetchedAt: 304 on matching If-None-Match", async () => {
    const app = appWith(await seededStore());
    const first = await app.request(`/api/responses/${TX_CC}`);
    const etag = first.headers.get("ETag");
    expect(etag).toBe(`W/"responses-${FETCHED_AT}"`);
    const revalidated = await app.request(`/api/responses/${TX_CC}`, {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(revalidated.status).toBe(304);
  });
});

describe("GET /api/health", () => {
  // The route's 24 h window is anchored to the real clock, so run rows must
  // be too (unlike the fixture snapshot, whose fetchedAt only feeds age).
  const NOW = Math.floor(Date.now() / 1000);
  const runRow = {
    startedAt: NOW - 20,
    durationMs: 900,
    upstreamRequests: 15,
    koiosCalls: 12,
    ok: true,
    error: null,
    govLinksOk: true,
    incomplete: false,
    surveys: 2,
    responses: 4,
    payloadBytes: 5_000,
  };
  const incomplete = (txHash: string) => ({
    txHash,
    responseIndex: 0,
    surveyKey: "aa:0",
    role: 0,
    credential: "key:11",
    slot: 1,
    epochNo: 500,
    blockIndex: null,
    proofOk: null,
    linkedActionId: null,
    wellFormed: true,
    checkedAt: NOW,
  });

  it("reports snapshot freshness, last run, totals, and quotas", async () => {
    const store = await seededStore();
    await store.upsertValidatedResponses(
      ["ab", "cd", "ef"].map((h) => incomplete(h.repeat(32))),
    );
    await store.putRefreshRun({ ...runRow, startedAt: NOW - 200 });
    await store.putRefreshRun({
      ...runRow,
      startedAt: NOW - 100,
      ok: false,
      error: "Koios GET /tip → 502",
    });
    await store.putRefreshRun(runRow);
    // Serving-path and refresh traffic land in the same tally, which is why the
    // 24 h totals cannot be summed from run rows alone.
    await store.addUpstreamCalls(NOW - 50, {
      koios: 30,
      "koios-passthrough": 7,
      anchor: 5,
    });
    const app = createApp(
      loadConfig({
        WORKER_SUBREQUEST_CAP: "1000",
        KOIOS_DAILY_LIMIT: "5000",
        GIT_COMMIT: "f2b86aa",
      }),
      store,
      { compress: false },
    );

    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["network"]).toBe("preview");
    expect(body["commit"]).toBe("f2b86aa");
    expect(body["snapshot"]).toMatchObject({ fetchedAt: FETCHED_AT });
    expect(body["lastRefresh"]).toMatchObject({
      startedAt: NOW - 20,
      upstreamRequests: 15,
      koiosCalls: 12,
      ok: true,
      govLinksOk: true,
    });
    expect(body["last24h"]).toEqual({
      runs: 3,
      failures: 1,
      upstreamRequests: 42,
      koiosCalls: 30,
      passthroughCalls: 7,
    });
    // Banked on the latest run row, not counted live per request.
    expect(body["validationBacklog"]).toBe(3);
    // Rows that land after the run don't move it until the next run banks.
    await store.upsertValidatedResponses([incomplete("99".repeat(32))]);
    expect(
      (
        (await (await appWith(store).request("/api/health")).json()) as Record<
          string,
          unknown
        >
      )["validationBacklog"],
    ).toBe(3);
    expect(body["quotas"]).toEqual({
      subrequestsPerInvocation: 1000,
      koiosCallsPerDay: 5000,
    });
  });

  it("reports where the walker stands, so catching up is not read as stuck", async () => {
    const store = await seededStore();
    await store.putRefreshRun({ ...runRow, incomplete: true });

    // Nothing walked yet: an `incomplete` run with no cursor to compare.
    const before = (await (
      await appWith(store).request("/api/health")
    ).json()) as Record<string, unknown>;
    expect(before["scan"]).toBeNull();

    await store.putScanState({
      cursor: { slot: 4_000, txHash: "aa".repeat(32) },
      caughtUp: false,
      generation: 1,
      trickle: null,
      network: "preview",
    });
    const during = (await (
      await appWith(store).request("/api/health")
    ).json()) as Record<string, unknown>;
    // The pair an operator watches across crons: still catching up, and the
    // slot it reached — which either moves next run or doesn't.
    expect(during["scan"]).toEqual({ cursorSlot: 4_000, caughtUp: false });
  });

  it("falls back to a live backlog count when the run predates banking", async () => {
    const store = await seededStore();
    await store.putRefreshRun(runRow);
    store.db.exec("UPDATE refresh_run SET validation_backlog = NULL");
    await store.upsertValidatedResponses([incomplete("ab".repeat(32))]);

    const res = await appWith(store).request("/api/health");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["validationBacklog"]).toBe(1);
  });

  it("memoizes the aggregates until a new run lands", async () => {
    const store = await seededStore();
    await store.putRefreshRun(runRow);
    let scans = 0;
    const counting = {
      ...store,
      refreshTotalsSince: (since: number) => {
        scans++;
        return store.refreshTotalsSince(since);
      },
    };
    const app = appWith(counting);

    await app.request("/api/health");
    await app.request("/api/health");
    expect(scans).toBe(1);

    // A new run row (failures write one too) re-keys the memo.
    await store.putRefreshRun({ ...runRow, startedAt: NOW - 10 });
    const res = await app.request("/api/health");
    expect(scans).toBe(2);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["lastRefresh"]).toMatchObject({ startedAt: NOW - 10 });
  });

  it("serves nulls before any refresh, with a default per-refresh limit", async () => {
    const app = appWith(testStore());
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["commit"]).toBeNull();
    expect(body["snapshot"]).toBeNull();
    expect(body["lastRefresh"]).toBeNull();
    expect(body["last24h"]).toEqual({
      runs: 0,
      failures: 0,
      upstreamRequests: 0,
      koiosCalls: 0,
      passthroughCalls: 0,
    });
    // Neither quota declared: no denominators, nothing invented.
    expect(body["quotas"]).toEqual({
      subrequestsPerInvocation: null,
      koiosCallsPerDay: null,
    });
  });
});

// Serving-path calls spend the same daily quotas the refresh does. Nothing
// summed from refresh runs can see them, which is what the tally is for.
describe("serving-path metering", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tallies a passthrough call against its own identity, not the operator's", async () => {
    const hash = "ab".repeat(32);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([{ tx_hash: hash, num_confirmations: 2 }]),
            { status: 200 },
          ),
      ),
    );
    const store = testStore();
    const res = await appWith(store).request(`/api/tx_status?hashes=${hash}`);
    expect(res.status).toBe(200);

    // Written by the time the response resolves: a Worker would cancel a write
    // started after the request ended.
    expect(await store.upstreamTotalsSince(0)).toEqual({
      koios: 0,
      "koios-passthrough": 1,
      anchor: 0,
    });
  });

  it("costs no storage on a request that reaches nothing upstream", async () => {
    const store = testStore();
    await appWith(store).request("/api/health");
    expect(await store.upstreamTotalsSince(0)).toEqual({
      koios: 0,
      "koios-passthrough": 0,
      anchor: 0,
    });
  });
});

// The one passthrough this suite exercises upstream (the others hit real Koios).
// It is the sole *comfort* call, and finding 15 gave it two guards: input
// validation before anything reaches Koios, and a segregated (default
// unauthenticated) token so a flood can't burn the refresh/finalize quota.
describe("GET /api/tx_status (finding 15)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const H = (b: string) => b.repeat(32); // a 64-hex tx hash from a byte literal

  it("rejects a malformed hash with 400 and never calls Koios", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await appWith(testStore()).request(
      "/api/tx_status?hashes=not-a-hash",
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an oversized hash list with 400 and never calls Koios", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const many = Array.from({ length: 21 }, (_, i) =>
      i.toString(16).padStart(2, "0").repeat(32),
    ).join(",");
    const res = await appWith(testStore()).request(
      `/api/tx_status?hashes=${many}`,
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards valid hashes and returns the confirmation map", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([{ tx_hash: H("ab"), num_confirmations: 3 }]),
            { status: 200 },
          ),
      ),
    );
    const res = await appWith(testStore()).request(
      `/api/tx_status?hashes=${H("ab")}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ [H("ab")]: 3 });
  });

  it("polls Koios unauthenticated even when KOIOS_TOKEN is set (quota segregation)", async () => {
    const authHeaders: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        authHeaders.push(new Headers(init?.headers).get("Authorization"));
        return new Response(
          JSON.stringify([{ tx_hash: H("cd"), num_confirmations: 1 }]),
          { status: 200 },
        );
      }),
    );
    // The critical path's identity is set, but comfort polling must not carry it.
    const app = createApp(
      loadConfig({ KOIOS_TOKEN: "super-secret" }),
      testStore(),
      {
        compress: false,
      },
    );
    await app.request(`/api/tx_status?hashes=${H("cd")}`);
    expect(authHeaders).toEqual([null]);
  });
});

// A `ChainTip` is two Koios reads wearing one name: `/tip` for the near-live
// fields, `/epoch_params` for `gov_action_lifetime`. The second is the one part
// of a tip that cannot move within an epoch, so the stored snapshot answers it.
describe("GET /api/tip", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Serve Koios's tip at `epoch`, recording which endpoints were asked. */
  const koiosAt = (epoch: number) => {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        paths.push(url.includes("/epoch_params") ? "epoch_params" : "tip");
        return new Response(
          JSON.stringify(
            url.includes("/epoch_params")
              ? [{ gov_action_lifetime: 6 }]
              : [
                  {
                    epoch_no: epoch,
                    abs_slot: 1_100_000,
                    epoch_slot: 6_000,
                    block_time: 1_750_000_500,
                  },
                ],
          ),
          { status: 200 },
        );
      }),
    );
    return paths;
  };

  it("reuses the snapshot's gov_action_lifetime inside its epoch", async () => {
    const paths = koiosAt(tip.epoch);
    const res = await appWith(await seededStore()).request("/api/tip");

    expect(res.status).toBe(200);
    expect(paths).toEqual(["tip"]);
    // Read fresh from Koios, not served from the snapshot: this route is the
    // near-live one, and the stored tip is a refresh interval behind.
    expect(await res.json()).toEqual({
      epoch: tip.epoch,
      slot: 1_100_000,
      epochSlot: 6_000,
      time: 1_750_000_500,
      govActionLifetime: 6,
    });
  });

  it("re-reads the parameter once the chain leaves that epoch", async () => {
    const paths = koiosAt(tip.epoch + 1);
    await appWith(await seededStore()).request("/api/tip");
    expect(paths).toEqual(["tip", "epoch_params"]);
  });

  it("re-reads it when there is no snapshot to bank from", async () => {
    const paths = koiosAt(tip.epoch);
    await appWith(testStore()).request("/api/tip");
    expect(paths).toEqual(["tip", "epoch_params"]);
  });
});

// What `/api/pparams` reuses its Koios read on. Protocol parameters are fixed
// within an epoch, so the key is the epoch of the stored snapshot — the only
// notion of "now" this tier has that costs no upstream call.
describe("keyedCache", () => {
  const cacheOver = (key: () => number | null) => {
    let produced = 0;
    const read = keyedCache(
      () => Promise.resolve(key()),
      () => Promise.resolve(++produced),
    );
    return { read, calls: () => produced };
  };

  it("reads once per key, however many requests arrive", async () => {
    let epoch: number | null = 500;
    const { read, calls } = cacheOver(() => epoch);

    expect(await read()).toBe(1);
    expect(await read()).toBe(1);
    expect(calls()).toBe(1);

    epoch = 501;
    expect(await read()).toBe(2);
    expect(calls()).toBe(2);
  });

  // The pre-first-refresh key: unknown, not absent. One read serves until a
  // snapshot lands and names an epoch.
  it("treats a null key as a key", async () => {
    let epoch: number | null = null;
    const { read, calls } = cacheOver(() => epoch);

    await read();
    await read();
    expect(calls()).toBe(1);

    epoch = 500;
    await read();
    expect(calls()).toBe(2);
  });

  it("collapses a concurrent burst into one read", async () => {
    const { read, calls } = cacheOver(() => 500);
    expect(await Promise.all([read(), read(), read()])).toEqual([1, 1, 1]);
    expect(calls()).toBe(1);
  });

  it("evicts a failure rather than serving it for the whole epoch", async () => {
    let attempt = 0;
    const read = keyedCache(
      () => Promise.resolve(500),
      () =>
        ++attempt === 1
          ? Promise.reject(new Error("koios 502"))
          : Promise.resolve("params"),
    );

    await expect(read()).rejects.toThrow("koios 502");
    expect(await read()).toBe("params");
  });
});
