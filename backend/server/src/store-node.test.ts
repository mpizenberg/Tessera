/**
 * `store-node.ts` against a real (in-memory) SQLite database — exercised where
 * the SQL itself carries logic the in-memory store re-implements in JS, so the
 * two can't silently disagree. That's the `json_extract` predicate behind
 * `finalizedCancelledKeys`, the conditional upsert behind the refresh lease,
 * the join and cascade behind the sealed-reveal cursor, and the paging keyset
 * (D1 shares the same SQLite dialect).
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type {
  BackendStore,
  RefreshRunRow,
  ResponseRow,
  SurveyIndexRow,
  SurveyPageQuery,
  ValidatedResponseRow,
} from "./store";
import { REFRESH_RUN_RETENTION_SECONDS } from "./store";
import { openBackendStore } from "./store-node";

const artifact = (surveyKey: string, tally: string, hash: string) => ({
  surveyKey,
  endEpoch: 500,
  artifactHash: hash,
  artifact: `{"tally":${tally},"provenance":{}}`,
  createdAt: 1,
});

describe("store-node finalizedCancelledKeys (json_extract)", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  it("selects only artifacts whose tally.cancelled is set", async () => {
    store = openBackendStore(":memory:");
    await store.putArtifact(
      artifact("aa:0", `{"perRole":[{"role":3}]}`, "a1".repeat(32)),
    );
    await store.putArtifact(
      artifact(
        "bb:1",
        `{"cancelled":{"txHash":"cc","slot":1,"epoch":499},"perRole":[]}`,
        "b2".repeat(32),
      ),
    );
    // JSON null must read as not-cancelled, same as an absent key (the
    // json_extract → SQL NULL note in the query).
    await store.putArtifact(
      artifact("cc:2", `{"cancelled":null,"perRole":[]}`, "c3".repeat(32)),
    );

    expect(await store.finalizedCancelledKeys()).toEqual(new Set(["bb:1"]));
    expect(await store.finalizedSurveyKeys()).toEqual(
      new Set(["aa:0", "bb:1", "cc:2"]),
    );
  });

  it("is empty with no artifacts", async () => {
    store = openBackendStore(":memory:");
    expect(await store.finalizedCancelledKeys()).toEqual(new Set());
  });
});

const validatedRow = (
  txHash: string,
  responseIndex: number,
  surveyKey: string,
): ValidatedResponseRow => ({
  txHash,
  responseIndex,
  surveyKey,
  role: 3,
  credential: "key:aa",
  slot: 1,
  epochNo: 499,
  blockIndex: 0,
  proofOk: true,
  linkedActionId: null,
  wellFormed: true,
  checkedAt: 1,
});

describe("store-node sealed reveal cursor", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  it("scopes outcomes by survey and drops them with a reorged-out response", async () => {
    store = openBackendStore(":memory:");
    await store.upsertValidatedResponses([
      validatedRow("aa", 0, "s1:0"),
      validatedRow("aa", 1, "s1:0"),
      validatedRow("bb", 0, "s2:0"),
    ]);
    await store.putSealedReveals([
      { txHash: "aa", responseIndex: 0, response: `{"answers":1}` },
      { txHash: "aa", responseIndex: 1, response: null },
      { txHash: "bb", responseIndex: 0, response: `{"answers":2}` },
    ]);

    // A row with a null value is "attempted, undecryptable" — distinct from an
    // absent row, and that distinction is what lets the cursor terminate.
    expect(await store.sealedReveals("s1:0")).toEqual(
      new Map([
        ["aa:0", `{"answers":1}`],
        ["aa:1", null],
      ]),
    );

    // Written once, never revised.
    await store.putSealedReveals([
      { txHash: "aa", responseIndex: 1, response: `{"answers":9}` },
    ]);
    expect((await store.sealedReveals("s1:0")).get("aa:1")).toBeNull();

    // A reorged-out response takes its outcome with it, so a re-validated tx is
    // decrypted afresh rather than inheriting the old row by key collision.
    await store.deleteValidatedResponses([{ txHash: "aa", responseIndex: 0 }]);
    await store.upsertValidatedResponses([validatedRow("aa", 0, "s1:0")]);
    expect(await store.sealedReveals("s1:0")).toEqual(
      new Map([["aa:1", null]]),
    );
    expect(await store.sealedReveals("s2:0")).toEqual(
      new Map([["bb:0", `{"answers":2}`]]),
    );
  });
});

describe("store-node migration of a pre-runner database", () => {
  it("baselines existing tables and applies the missing 0004 column", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-store-"));
    const path = join(dir, "cache.sqlite");
    // Seed a file as the deleted inline schema would have left it before
    // migration 0004 existed: the 0002 objects present (without
    // linked_action_id), no schema_migration table, later tables missing.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE validated_response (
        tx_hash        TEXT    NOT NULL,
        response_index INTEGER NOT NULL,
        survey_key     TEXT    NOT NULL,
        role           INTEGER NOT NULL,
        credential     TEXT    NOT NULL,
        slot           INTEGER NOT NULL,
        epoch_no       INTEGER NOT NULL,
        block_index    INTEGER,
        proof_ok       INTEGER,
        well_formed    INTEGER NOT NULL,
        checked_at     INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, response_index)
      );
      CREATE INDEX validated_response_survey
        ON validated_response (survey_key);
      INSERT INTO validated_response VALUES
        ('aa', 0, 'aa:0', 3, 'cred', 10, 500, 1, 1, 1, 1);
    `);
    old.close();

    const store = openBackendStore(path);
    try {
      // The pre-existing row survives, with a NULL linked action.
      expect(await store.completedValidations()).toEqual(
        new Map([["aa:0", null]]),
      );
      // And writes touching the new column work.
      await store.upsertValidatedResponses([
        {
          txHash: "bb",
          responseIndex: 1,
          surveyKey: "bb:1",
          role: 0,
          credential: "cred2",
          slot: 11,
          epochNo: 500,
          blockIndex: 2,
          proofOk: true,
          linkedActionId: "gov#0",
          wellFormed: true,
          checkedAt: 2,
        },
      ]);
      expect((await store.completedValidations()).get("bb:1")).toBe("gov#0");
      // Missing tables were created by their migrations, not the baseline.
      await store.replaceSnapshot([], [], {
        tip: "{}",
        incomplete: false,
        fetchedAt: 7,
      });
      expect((await store.snapshotMeta())?.fetchedAt).toBe(7);
    } finally {
      store.close();
    }

    // Every migration file must now be tracked — the baseline for the ones
    // whose objects pre-existed, the runner for the rest.
    const check = new DatabaseSync(path);
    const tracked = (
      check
        .prepare("SELECT name FROM schema_migration ORDER BY name")
        .all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    check.close();
    rmSync(dir, { recursive: true, force: true });
    expect(tracked).toEqual([
      "0001_snapshot_cache.sql",
      "0002_validated_responses.sql",
      "0003_tally.sql",
      "0004_validated_response_linked_action.sql",
      "0005_tx_metadata_cache.sql",
      "0006_refresh_run.sql",
      "0007_survey_index.sql",
      "0008_refresh_lease.sql",
      "0009_snapshot_chunks.sql",
      "0010_response_rows.sql",
      "0011_sealed_reveal.sql",
    ]);
  });
});

describe("store-node migration to per-response rows", () => {
  it("drops the blob and reports not-ready until the next refresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-store-"));
    const path = join(dir, "cache.sqlite");
    // Bring a database up to 0009 exactly — the state a deployed backend is in
    // before this upgrade — with a snapshot cached and its index materialized.
    const migrationsDir = fileURLToPath(
      new URL("../migrations", import.meta.url),
    );
    const before = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql") && f < "0010")
      .sort();
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE schema_migration (
      name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
    );`);
    for (const file of before) {
      old.exec(readFileSync(join(migrationsDir, file), "utf8"));
      old.prepare("INSERT INTO schema_migration VALUES (?, 1)").run(file);
    }
    old
      .prepare("INSERT INTO snapshot_chunk (seq, payload) VALUES (0, ?)")
      .run(JSON.stringify({ records: { responses: ["stale"] } }));
    old
      .prepare(
        `INSERT INTO survey_index_meta (id, tip, incomplete, fetched_at)
         VALUES (1, '{"epoch":500}', 0, 99)`,
      )
      .run();
    old.close();

    const store = openBackendStore(path);
    try {
      // The rows can't carry over (their keys are derived in TypeScript), so
      // the envelope is cleared: routes answer "not ready" rather than serving
      // surveys whose responses have silently vanished.
      expect(await store.snapshotMeta()).toBeNull();
      // And the next refresh publishes into the new shape.
      await store.replaceSnapshot([], [], {
        tip: "{}",
        incomplete: false,
        fetchedAt: 100,
      });
      expect((await store.snapshotMeta())?.fetchedAt).toBe(100);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("store-node survey_index paging SQL", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  const TIP_EPOCH = 500;
  const row = (
    key: string,
    slot: number,
    over: Partial<SurveyIndexRow> = {},
  ): SurveyIndexRow => ({
    surveyKey: key,
    slot,
    endEpoch: 510,
    sealed: false,
    cancelled: false,
    govLinked: false,
    owner: "key:11",
    haystack: `title of ${key}`,
    record: `{"k":"${key}"}`,
    cancellations: "[]",
    govLinks: "[]",
    responseCount: 1,
    finalizedCancelled: false,
    ...over,
  });
  const meta = {
    tip: `{"epoch":${TIP_EPOCH}}`,
    incomplete: false,
    fetchedAt: 7,
  };

  // linked (bucket 0), two open (bucket 1, newest slot first), one closed.
  const rows = [
    row("aa:0", 100, { govLinked: true }),
    row("bb:0", 300),
    row("cc:0", 500, { sealed: true }),
    row("dd:0", 900, { endEpoch: 499 }),
  ];

  const page = (q: Partial<SurveyPageQuery>) =>
    store.surveyIndexPage({
      tipEpoch: TIP_EPOCH,
      filter: "all",
      credentials: [],
      searchTerms: [],
      cursor: null,
      limit: 10,
      ...q,
    });

  it("orders by bucket, slot desc, key — and follows the keyset cursor", async () => {
    store = openBackendStore(":memory:");
    await store.replaceSnapshot(rows, [], meta);
    expect(await store.snapshotMeta()).toEqual(meta);

    const all = await page({});
    expect(all.map((r) => r.surveyKey)).toEqual([
      "aa:0",
      "cc:0",
      "bb:0",
      "dd:0",
    ]);
    expect(all.map((r) => r.bucket)).toEqual([0, 1, 1, 2]);

    const second = await page({
      cursor: { bucket: 1, slot: 500, key: "cc:0" },
      limit: 2,
    });
    expect(second.map((r) => r.surveyKey)).toEqual(["bb:0", "dd:0"]);
  });

  it("applies filters and search terms", async () => {
    store = openBackendStore(":memory:");
    await store.replaceSnapshot(rows, [], meta);

    // Active = not cancelled and deadline not passed; the linked row is
    // active too and still sorts first by bucket.
    expect((await page({ filter: "active" })).map((r) => r.surveyKey)).toEqual([
      "aa:0",
      "cc:0",
      "bb:0",
    ]);
    expect((await page({ filter: "sealed" })).map((r) => r.surveyKey)).toEqual([
      "cc:0",
    ]);
    expect(
      (await page({ filter: "mine", credentials: ["key:11"] })).map(
        (r) => r.surveyKey,
      ),
    ).toHaveLength(4);
    expect(await page({ filter: "mine", credentials: ["key:99"] })).toEqual([]);
    expect(
      (await page({ searchTerms: ["title", "bb"] })).map((r) => r.surveyKey),
    ).toEqual(["bb:0"]);
    // LIKE wildcards in a term must not act as wildcards.
    expect(await page({ searchTerms: ["%"] })).toEqual([]);
  });

  it("computes global counts over the search-matching set", async () => {
    store = openBackendStore(":memory:");
    await store.replaceSnapshot(rows, [], meta);
    expect(await store.surveyIndexCounts(TIP_EPOCH, ["key:11"], [])).toEqual({
      all: 4,
      linked: 1,
      active: 3,
      sealed: 1,
      public: 2,
      mine: 4,
    });
    expect(await store.surveyIndexCounts(TIP_EPOCH, [], ["bb"])).toEqual({
      all: 1,
      linked: 0,
      active: 1,
      sealed: 0,
      public: 1,
      mine: 0,
    });
  });

  it("replace is a full swap", async () => {
    store = openBackendStore(":memory:");
    await store.replaceSnapshot(rows, [], meta);
    await store.replaceSnapshot([row("ee:0", 50)], [], {
      ...meta,
      fetchedAt: 8,
    });
    expect((await page({})).map((r) => r.surveyKey)).toEqual(["ee:0"]);
    expect((await store.snapshotMeta())?.fetchedAt).toBe(8);
  });
});

describe("store-node response rows", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  const meta = { tip: `{"epoch":500}`, incomplete: false, fetchedAt: 7 };
  const resp = (
    txHash: string,
    surveyKey: string,
    credential: string,
    slot: number,
    responseIndex = 0,
  ): ResponseRow => ({
    txHash,
    responseIndex,
    surveyKey,
    credential,
    slot,
    record: `{"tx":"${txHash}","i":${responseIndex}}`,
  });

  // Two surveys, and one responder answering both — so a per-survey read that
  // leaked across surveys, or a credential read that didn't, would show.
  const rows = [
    resp("dd", "aa:0", "key:11", 960_000),
    resp("cc", "aa:0", "key:11", 950_000),
    resp("cc", "aa:0", "script:22", 950_000, 1),
    resp("ff", "bb:1", "script:22", 956_000),
  ];
  const surveys = ["aa:0", "bb:1", "empty:0"].map((surveyKey) => ({
    surveyKey,
    slot: 900_000,
    endEpoch: 510,
    sealed: false,
    cancelled: false,
    govLinked: false,
    owner: "key:11",
    haystack: surveyKey,
    record: `{"k":"${surveyKey}"}`,
    cancellations: `[{"c":"${surveyKey}"}]`,
    govLinks: "[]",
    responseCount: 0,
    finalizedCancelled: false,
  }));

  it("serves one survey's bundle in a stable order", async () => {
    store = openBackendStore(":memory:");
    await store.replaceSnapshot(surveys, rows, meta);

    // (slot, txHash, responseIndex): the same bytes on every refresh, so the
    // ETag's promise that an unchanged snapshot means an unchanged body holds.
    expect(await store.surveyBundle("aa:0")).toEqual({
      record: `{"k":"aa:0"}`,
      cancellations: `[{"c":"aa:0"}]`,
      responses: [
        `{"tx":"cc","i":0}`,
        `{"tx":"cc","i":1}`,
        `{"tx":"dd","i":0}`,
      ],
    });
    expect((await store.surveyBundle("bb:1"))?.responses).toEqual([
      `{"tx":"ff","i":0}`,
    ]);
    // A survey nobody answered still has a bundle; an unknown one has none.
    expect((await store.surveyBundle("empty:0"))?.responses).toEqual([]);
    expect(await store.surveyBundle("unknown:0")).toBeNull();
  });

  it("maps credentials to the surveys they answered", async () => {
    store = openBackendStore(":memory:");
    await store.replaceSnapshot(surveys, rows, meta);

    expect(await store.respondedSurveyKeys(["key:11"])).toEqual(["aa:0"]);
    // Union across a wallet's credentials, deduped across several responses.
    expect(
      (await store.respondedSurveyKeys(["key:11", "script:22"])).sort(),
    ).toEqual(["aa:0", "bb:1"]);
    // Credential kinds must not cross-match.
    expect(await store.respondedSurveyKeys(["script:11"])).toEqual([]);
    expect(await store.respondedSurveyKeys([])).toEqual([]);
  });

  it("replaces wholesale, so a vanished response stops being served", async () => {
    store = openBackendStore(":memory:");
    await store.replaceSnapshot(surveys, rows, meta);
    // A reorg drops the later response; a merging write would keep serving it.
    await store.replaceSnapshot(
      surveys,
      rows.filter((r) => r.txHash !== "dd"),
      { ...meta, fetchedAt: 8 },
    );

    expect((await store.surveyBundle("aa:0"))?.responses).toEqual([
      `{"tx":"cc","i":0}`,
      `{"tx":"cc","i":1}`,
    ]);
  });
});

describe("store-node refresh lease", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  const TTL = 600;

  it("admits one holder at a time and frees the lease on release", async () => {
    store = openBackendStore(":memory:");

    const first = await store.acquireRefreshLease(1000, TTL);
    expect(first).not.toBeNull();
    // A second run starting mid-flight gets nothing — this is the overlap the
    // cron scheduler does not prevent on its own.
    expect(await store.acquireRefreshLease(1180, TTL)).toBeNull();

    await store.releaseRefreshLease(first!);
    expect(await store.acquireRefreshLease(1360, TTL)).not.toBeNull();
  });

  it("lets the next run take over once an unreleased lease expires", async () => {
    store = openBackendStore(":memory:");
    // A run killed mid-flight (Worker CPU cap) never releases; only expiry
    // unblocks its successors.
    const killed = await store.acquireRefreshLease(1000, TTL);
    expect(await store.acquireRefreshLease(1000 + TTL - 1, TTL)).toBeNull();

    const heir = await store.acquireRefreshLease(1000 + TTL, TTL);
    expect(heir).not.toBeNull();
    expect(heir).not.toBe(killed);

    // The superseded run must not be able to free its successor's lease.
    await store.releaseRefreshLease(killed!);
    expect(await store.acquireRefreshLease(1000 + TTL + 1, TTL)).toBeNull();
  });
});

describe("store-node weight_snapshot immutability", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  it("keeps the first row written for an (epoch, role, credential)", async () => {
    store = openBackendStore(":memory:");
    const row = {
      epoch: 500,
      role: 3,
      credential: "key:aa",
      weight: "1000",
      registered: true,
      fetchedAt: 10,
    };
    await store.insertWeightRows([row]);
    // An artifact may already have been emitted from the stored weight, so a
    // later read of the same past epoch must not be able to revise it.
    await store.insertWeightRows([
      { ...row, weight: "42", registered: false, fetchedAt: 99 },
    ]);

    expect(await store.weightRows(500, 3)).toEqual([row]);
  });
});

describe("store-node refresh_run health metrics", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  const run = (startedAt: number, over: Partial<RefreshRunRow> = {}) => ({
    startedAt,
    durationMs: 1200,
    koiosCalls: 7,
    ok: true,
    error: null,
    incomplete: false,
    surveys: 3,
    responses: 5,
    payloadBytes: 10_000,
    ...over,
  });

  it("round-trips the latest run and aggregates a window", async () => {
    store = openBackendStore(":memory:");
    expect(await store.lastRefreshRun()).toBeNull();

    await store.putRefreshRun(run(1000));
    await store.putRefreshRun(
      run(1180, { ok: false, error: "Koios GET /tip → 502", koiosCalls: 2 }),
    );
    await store.putRefreshRun(run(1360, { koiosCalls: 11, incomplete: true }));

    const last = await store.lastRefreshRun();
    expect(last).toMatchObject({
      startedAt: 1360,
      koiosCalls: 11,
      ok: true,
      error: null,
      incomplete: true,
    });

    // Window covering the two most recent runs only.
    expect(await store.refreshTotalsSince(1180)).toEqual({
      runs: 2,
      failures: 1,
      koiosCalls: 13,
    });
    // Empty window aggregates to zeros, not NULLs.
    expect(await store.refreshTotalsSince(9999)).toEqual({
      runs: 0,
      failures: 0,
      koiosCalls: 0,
    });
  });

  it("prunes rows older than the retention window on insert", async () => {
    store = openBackendStore(":memory:");
    const now = 10_000_000;
    await store.putRefreshRun(run(now - REFRESH_RUN_RETENTION_SECONDS - 1));
    await store.putRefreshRun(run(now - REFRESH_RUN_RETENTION_SECONDS + 1));
    await store.putRefreshRun(run(now));

    expect(await store.refreshTotalsSince(0)).toMatchObject({ runs: 2 });
  });

  it("counts validated rows still awaiting enrichment", async () => {
    store = openBackendStore(":memory:");
    const row = (
      txHash: string,
      blockIndex: number | null,
      proofOk: boolean | null,
    ) => ({
      txHash,
      responseIndex: 0,
      surveyKey: "aa:0",
      role: 3,
      credential: "cred",
      slot: 10,
      epochNo: 500,
      blockIndex,
      proofOk,
      linkedActionId: null,
      wellFormed: true,
      checkedAt: 1,
    });
    await store.upsertValidatedResponses([
      row("aa", 1, true), // complete
      row("bb", null, true), // missing block index
      row("cc", 2, null), // missing proof verdict
    ]);
    expect(await store.incompleteValidationCount()).toBe(2);
  });
});
