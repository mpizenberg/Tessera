/**
 * `store-sql.ts` over the node driver, against a real (in-memory) SQLite
 * database — exercised where the SQL itself carries logic the in-memory store
 * re-implements in JS, so the two can't silently disagree. That's the
 * `json_extract` predicate behind `finalizedArtifactKeys`, the conditional
 * upsert behind the refresh lease, the join and cascade behind the
 * sealed-reveal cursor, and the paging keyset. D1 shares both the dialect and
 * this store, so what passes here holds there too; `store-d1.test.ts` covers
 * only what its driver does differently (batching, transaction rollback).
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
import {
  OPERATIONAL_RETENTION_SECONDS,
  TALLY_BUCKET_SECONDS,
  tallyBucket,
} from "./store";
import { openBackendStore } from "./store-node";

const artifact = (surveyKey: string, tally: string, hash: string) => ({
  surveyKey,
  endEpoch: 500,
  artifactHash: hash,
  artifact: `{"tally":${tally},"provenance":{}}`,
  createdAt: 1,
});

describe("store-node finalizedArtifactKeys (json_extract)", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  it("marks cancelled only artifacts whose tally.cancelled is set", async () => {
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

    expect(await store.finalizedArtifactKeys()).toEqual({
      finalized: new Set(["aa:0", "bb:1", "cc:2"]),
      cancelled: new Set(["bb:1"]),
    });
  });

  it("is empty with no artifacts", async () => {
    store = openBackendStore(":memory:");
    expect(await store.finalizedArtifactKeys()).toEqual({
      finalized: new Set(),
      cancelled: new Set(),
    });
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

describe("store-node validation candidate reads", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  it("keys completed verdicts by survey and surfaces stale-cursor and retry surveys", async () => {
    store = openBackendStore(":memory:");
    await store.upsertValidatedResponses([
      // s1: completed bindable verdicts pinned to two distinct link sets.
      { ...validatedRow("aa", 0, "s1:0"), role: 0, linkedActionId: "gov#1" },
      { ...validatedRow("aa", 1, "s1:0"), role: 0, linkedActionId: "gov#1" },
      { ...validatedRow("ab", 0, "s1:0"), role: 2 },
      // s2: completed but non-bindable — never a link-change candidate.
      { ...validatedRow("bb", 0, "s2:0"), linkedActionId: "gov#2" },
      // s3: bindable but enrichment-pending — a retry survey, not a cursor.
      { ...validatedRow("cc", 0, "s3:0"), role: 0, proofOk: null },
    ]);

    expect(
      await store.completedValidationsForSurveys(["s1:0", "s3:0"]),
    ).toEqual(
      new Map([
        ["aa:0", { linkedActionId: "gov#1", slot: 1, epochNo: 499 }],
        ["aa:1", { linkedActionId: "gov#1", slot: 1, epochNo: 499 }],
        ["ab:0", { linkedActionId: null, slot: 1, epochNo: 499 }],
      ]),
    );
    expect(await store.completedValidationsForSurveys([])).toEqual(new Map());

    // One cursor per distinct (survey, link set) a bindable verdict pinned.
    expect(
      (await store.validatedLinkCursors()).sort((a, b) =>
        (a.linkedActionId ?? "").localeCompare(b.linkedActionId ?? ""),
      ),
    ).toEqual([
      { surveyKey: "s1:0", linkedActionId: null },
      { surveyKey: "s1:0", linkedActionId: "gov#1" },
    ]);
    expect(await store.incompleteValidationSurveys()).toEqual(["s3:0"]);
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
      expect(await store.completedValidationsForSurveys(["aa:0"])).toEqual(
        new Map([["aa:0", { linkedActionId: null, slot: 10, epochNo: 500 }]]),
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
      expect(
        (await store.completedValidationsForSurveys(["bb:1"])).get("bb:1"),
      ).toMatchObject({ linkedActionId: "gov#0" });
      // Missing tables were created by their migrations, not the baseline.
      await store.reconcileSnapshot([], [], [], {
        tip: "{}",
        incomplete: false,
        fetchedAt: 7,
        listCounts: null,
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
      "0012_refresh_run_gov_links.sql",
      "0013_gov_links.sql",
      "0014_upstream_metering.sql",
      "0015_tx_proof_cache.sql",
      "0016_snapshot_digest_and_backlog.sql",
      "0017_list_counts.sql",
      "0018_scan_state.sql",
      "0019_cancellation_rows.sql",
      "0020_gov_settlement_floor.sql",
      "0021_finalization_floor.sql",
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
      await store.reconcileSnapshot([], [], [], {
        tip: "{}",
        incomplete: false,
        fetchedAt: 100,
        listCounts: null,
      });
      expect((await store.snapshotMeta())?.fetchedAt).toBe(100);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("store-node migration to cancellation rows", () => {
  it("backfills rows from the stored projections' wire JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-store-"));
    const path = join(dir, "cache.sqlite");
    // A deployed backend just before 0019: every migration up to it applied,
    // and a survey row carrying two cancellations in its projection column.
    const migrationsDir = fileURLToPath(
      new URL("../migrations", import.meta.url),
    );
    const before = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql") && f < "0019")
      .sort();
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE schema_migration (
      name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
    );`);
    for (const file of before) {
      old.exec(readFileSync(join(migrationsDir, file), "utf8"));
      old.prepare("INSERT INTO schema_migration VALUES (?, 1)").run(file);
    }
    const record = (txHash: string, slot: number) =>
      // The wire shape materialize stored: plain fields plus encoded bytes.
      `{"txHash":"${txHash}","slot":${slot},"epochNo":499,` +
      `"target":{"txId":{"$bytes":"${"ab".repeat(32)}"},"index":0},"proof":null}`;
    old
      .prepare(
        `INSERT INTO survey_index
           (survey_key, slot, end_epoch, sealed, cancelled, gov_linked, owner,
            haystack, record, cancellations, gov_links, response_count,
            finalized_cancelled)
         VALUES ('aa:0', 100, 500, 0, 0, 0, 'key:11', 'aa', '{}',
                 '[${record("c1", 150)},${record("c2", 160)}]', '[]', 0, 0)`,
      )
      .run();
    old.close();

    const store = openBackendStore(path);
    try {
      expect(
        (await store.cancellationRowsForSurveys(["aa:0"])).map((r) => [
          r.txHash,
          r.surveyKey,
          r.slot,
        ]),
      ).toEqual([
        ["c1", "aa:0", 150],
        ["c2", "aa:0", 160],
      ]);
      // Each row's record is that cancellation's own slice of the projection.
      const rows = await store.cancellationRowsInSlotRange({
        fromSlot: 150,
        toSlot: 150,
      });
      expect(JSON.parse(rows[0]!.record)).toEqual(
        JSON.parse(record("c1", 150)),
      );
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
    listCounts: null,
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
    await store.reconcileSnapshot(rows, [], [], meta);
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
    await store.reconcileSnapshot(rows, [], [], meta);

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
    await store.reconcileSnapshot(rows, [], [], meta);
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

  it("counts owned surveys alone via the owner index", async () => {
    store = openBackendStore(":memory:");
    await store.reconcileSnapshot(rows, [], [], meta);
    expect(await store.ownedSurveyCount(["key:11"])).toBe(4);
    expect(await store.ownedSurveyCount(["key:11", "key:99"])).toBe(4);
    expect(await store.ownedSurveyCount(["key:99"])).toBe(0);
    expect(await store.ownedSurveyCount([])).toBe(0);
  });

  it("deletes surveys absent from the authoritative scan", async () => {
    store = openBackendStore(":memory:");
    await store.reconcileSnapshot(rows, [], [], meta);
    await store.reconcileSnapshot([row("ee:0", 50)], [], [], {
      ...meta,
      fetchedAt: 8,
    });
    expect((await page({})).map((r) => r.surveyKey)).toEqual(["ee:0"]);
    expect((await store.snapshotMeta())?.fetchedAt).toBe(8);
  });

  it("republishes the envelope alone, leaving rows untouched", async () => {
    store = openBackendStore(":memory:");
    const counts = `{"all":4,"linked":1,"active":3,"sealed":1,"public":2}`;
    await store.reconcileSnapshot(rows, [], [], meta);
    await store.publishSnapshotMeta({
      ...meta,
      fetchedAt: 8,
      listCounts: counts,
    });
    expect(await store.snapshotMeta()).toEqual({
      ...meta,
      fetchedAt: 8,
      listCounts: counts,
    });
    expect(await page({})).toHaveLength(rows.length);
  });

  // The stored side of the link-change diff: the slices a refresh compares its
  // freshly resolved links against, inside its settlement horizon.
  it("reads back every stored governance link, across rows", async () => {
    store = openBackendStore(":memory:");
    const link = (key: string, action: string, endEpoch = 510) =>
      `{"surveyKey":"${key}","actionId":"${action}","endEpoch":${endEpoch},"title":null}`;
    await store.reconcileSnapshot(
      [
        row("aa:0", 100, {
          govLinked: true,
          govLinks: `[${link("aa:0", "gov_action1a")},${link("aa:0", "gov_action1b")}]`,
        }),
        row("bb:0", 300), // no links: contributes nothing, not a parse error
        row("cc:0", 500, {
          endEpoch: 520,
          govLinked: true,
          govLinks: `[${link("cc:0", "gov_action1c", 520)}]`,
        }),
      ],
      [],
      [],
      meta,
    );
    const stored = await store.surveyGovLinks(0);
    expect([...stored.keys()]).toEqual(["aa:0", "cc:0"]);
    expect([...stored.values()].flat().map((l) => l.actionId)).toEqual([
      "gov_action1a",
      "gov_action1b",
      "gov_action1c",
    ]);
    expect(stored.get("aa:0")![0]).toEqual({
      surveyKey: "aa:0",
      actionId: "gov_action1a",
      endEpoch: 510,
      title: null,
    });
    // Below the horizon a link slice is frozen, so the diff never reads it.
    expect([...(await store.surveyGovLinks(511)).keys()]).toEqual(["cc:0"]);
  });
});

describe("store-node response rows", () => {
  let store: BackendStore;
  let storeDir: string | null = null;
  afterEach(() => {
    store.close();
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
    storeDir = null;
  });

  const meta = {
    tip: `{"epoch":500}`,
    incomplete: false,
    fetchedAt: 7,
    listCounts: null,
  };
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

  it("writes only changed domain rows on reconciliation", async () => {
    storeDir = mkdtempSync(join(tmpdir(), "tessera-reconcile-"));
    const path = join(storeDir, "store.sqlite");
    store = openBackendStore(path);
    await store.reconcileSnapshot(surveys, rows, [], meta);

    const audit = new DatabaseSync(path);
    audit.exec(`
      CREATE TABLE reconcile_audit (event TEXT NOT NULL);
      CREATE TRIGGER audit_survey_insert AFTER INSERT ON survey_index
        BEGIN INSERT INTO reconcile_audit VALUES ('survey:insert:' || NEW.survey_key); END;
      CREATE TRIGGER audit_survey_update AFTER UPDATE ON survey_index
        BEGIN INSERT INTO reconcile_audit VALUES ('survey:update:' || NEW.survey_key); END;
      CREATE TRIGGER audit_survey_delete AFTER DELETE ON survey_index
        BEGIN INSERT INTO reconcile_audit VALUES ('survey:delete:' || OLD.survey_key); END;
      CREATE TRIGGER audit_response_insert AFTER INSERT ON response
        BEGIN INSERT INTO reconcile_audit VALUES ('response:insert:' || NEW.tx_hash || ':' || NEW.response_index); END;
      CREATE TRIGGER audit_response_delete AFTER DELETE ON response
        BEGIN INSERT INTO reconcile_audit VALUES ('response:delete:' || OLD.tx_hash || ':' || OLD.response_index); END;
      CREATE TRIGGER audit_meta_update AFTER UPDATE ON snapshot_meta
        BEGIN INSERT INTO reconcile_audit VALUES ('meta:update'); END;
    `);
    audit.close();

    await store.reconcileSnapshot(surveys, rows, [], {
      ...meta,
      fetchedAt: 8,
    });
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT event FROM reconcile_audit").all()).toEqual([
      { event: "meta:update" },
    ]);
    check.exec("DELETE FROM reconcile_audit");
    check.close();

    const newResponse = resp("gg", "aa:0", "key:11", 970_000);
    await store.reconcileSnapshot(
      surveys.map((survey) =>
        survey.surveyKey === "aa:0"
          ? { ...survey, responseCount: survey.responseCount + 1 }
          : survey,
      ),
      [...rows, newResponse],
      [],
      { ...meta, fetchedAt: 9 },
    );
    const changed = new DatabaseSync(path);
    expect(changed.prepare("SELECT event FROM reconcile_audit").all()).toEqual([
      { event: "survey:update:aa:0" },
      { event: "response:insert:gg:0" },
      { event: "meta:update" },
    ]);
    changed.close();
  });

  it("serves one survey's bundle in a stable order", async () => {
    store = openBackendStore(":memory:");
    await store.reconcileSnapshot(surveys, rows, [], meta);

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
    await store.reconcileSnapshot(surveys, rows, [], meta);

    expect(await store.respondedSurveyKeys(["key:11"])).toEqual(["aa:0"]);
    // Union across a wallet's credentials, deduped across several responses.
    expect(
      (await store.respondedSurveyKeys(["key:11", "script:22"])).sort(),
    ).toEqual(["aa:0", "bb:1"]);
    // Credential kinds must not cross-match.
    expect(await store.respondedSurveyKeys(["script:11"])).toEqual([]);
    expect(await store.respondedSurveyKeys([])).toEqual([]);
  });

  it("deletes a response absent from the authoritative scan", async () => {
    store = openBackendStore(":memory:");
    await store.reconcileSnapshot(surveys, rows, [], meta);
    // A reorg drops the later response; a merging write would keep serving it.
    await store.reconcileSnapshot(
      surveys,
      rows.filter((r) => r.txHash !== "dd"),
      [],
      { ...meta, fetchedAt: 8 },
    );

    expect((await store.surveyBundle("aa:0"))?.responses).toEqual([
      `{"tx":"cc","i":0}`,
      `{"tx":"cc","i":1}`,
    ]);
  });
});

describe("store-node scan state", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  it("round-trips the walker state, including a generation rewind", async () => {
    store = openBackendStore(":memory:");
    // No row yet is the "never walked" signal, distinct from any cursor value.
    expect(await store.scanState()).toBeNull();

    const walked = {
      cursor: { slot: 5_000, txHash: "aa".repeat(32) },
      caughtUp: true,
      generation: 3,
      trickle: { slot: 1_200, txHash: "bb".repeat(32) },
    };
    await store.putScanState(walked);
    expect(await store.scanState()).toEqual(walked);

    // A rewind rewrites the whole row: null cursor, new generation, trickle
    // reset — nothing of the previous walk may survive by omission.
    const rewound = {
      cursor: null,
      caughtUp: false,
      generation: 4,
      trickle: null,
    };
    await store.putScanState(rewound);
    expect(await store.scanState()).toEqual(rewound);
  });

  it("banks both floors without disturbing the cursor", async () => {
    store = openBackendStore(":memory:");
    // Before the first cursor there is no row to update, and 0 — ask about
    // everything — is exactly what a database with no history owes.
    await store.putSettlementFloor(511);
    await store.putFinalizationFloor(498);
    expect(await store.settlementFloor()).toBe(0);
    expect(await store.finalizationFloor()).toBe(0);

    const walked = {
      cursor: { slot: 5_000, txHash: "aa".repeat(32) },
      caughtUp: true,
      generation: 3,
      trickle: null,
    };
    await store.putScanState(walked);
    await store.putSettlementFloor(511);
    await store.putFinalizationFloor(498);
    expect(await store.settlementFloor()).toBe(511);
    expect(await store.finalizationFloor()).toBe(498);

    // The cursor write leaves both alone: neither frontier is the scan's
    // coverage, and an incomplete scan that banks no cursor must not lose them.
    await store.putScanState({ ...walked, cursor: null, caughtUp: false });
    expect(await store.settlementFloor()).toBe(511);
    expect(await store.finalizationFloor()).toBe(498);
  });
});

describe("store-node segment reconciliation", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  const meta = (fetchedAt: number) => ({
    tip: `{"epoch":500}`,
    incomplete: false,
    fetchedAt,
    listCounts: null,
  });
  const survey = (
    surveyKey: string,
    slot: number,
    over: Partial<SurveyIndexRow> = {},
  ): SurveyIndexRow => ({
    surveyKey,
    slot,
    endEpoch: 510,
    sealed: false,
    cancelled: false,
    govLinked: false,
    owner: "key:11",
    haystack: surveyKey,
    record: `{"k":"${surveyKey}"}`,
    cancellations: "[]",
    govLinks: "[]",
    responseCount: 0,
    finalizedCancelled: false,
    ...over,
  });
  const resp = (
    txHash: string,
    surveyKey: string,
    slot: number,
    record = `{"tx":"${txHash}"}`,
  ): ResponseRow => ({
    txHash,
    responseIndex: 0,
    surveyKey,
    credential: "key:11",
    slot,
    record,
  });

  // A settled corpus spanning the segment on both sides.
  const seededSurveys = [
    survey("aa:0", 100),
    survey("bb:0", 400),
    survey("cc:0", 800),
  ];
  const seededResponses = [
    resp("r1", "aa:0", 150),
    resp("r2", "aa:0", 450),
    resp("r5", "bb:0", 550),
    resp("r3", "cc:0", 850),
  ];

  it("sweeps only in-range rows, keeps settled history, applies repositions", async () => {
    store = openBackendStore(":memory:");
    await store.reconcileSnapshot(seededSurveys, seededResponses, [], meta(1));

    // The segment [300, 600] saw: survey bb:0 gone (rolled back), response r2
    // re-listed with drifted bytes (a rollback repositioned its tx), r5 gone,
    // r4 new. aa:0 rides along as a touched survey from outside the range.
    const changes = await store.reconcileSegment(
      { fromSlot: 300, toSlot: 600 },
      [survey("aa:0", 100, { responseCount: 2 })],
      [resp("r2", "aa:0", 450, `{"tx":"drifted"}`), resp("r4", "aa:0", 500)],
      [],
      meta(2),
    );
    // aa:0 updated, r2 updated, r4 inserted, bb:0 and r5 swept.
    expect(changes).toBe(5);

    // bb:0 was in range and unlisted → swept; cc:0 out of range → untouched.
    expect(
      (await store.surveyRowsByKeys(["aa:0", "bb:0", "cc:0"])).map((r) => [
        r.surveyKey,
        r.responseCount,
      ]),
    ).toEqual([
      ["aa:0", 2],
      ["cc:0", 0],
    ]);
    // r5 swept with its survey; r1/r3 outside the range survive; r4 joined;
    // r2 took the re-listed bytes — a reposition must not pin the old slot.
    expect(
      (await store.responseRowsForSurveys(["aa:0", "bb:0", "cc:0"])).map(
        (r) => [r.txHash, r.record],
      ),
    ).toEqual([
      ["r1", `{"tx":"r1"}`],
      ["r2", `{"tx":"drifted"}`],
      ["r4", `{"tx":"r4"}`],
      ["r3", `{"tx":"r3"}`],
    ]);
    expect((await store.snapshotMeta())?.fetchedAt).toBe(2);
  });

  it("with nothing listed, empties exactly the segment", async () => {
    store = openBackendStore(":memory:");
    await store.reconcileSnapshot(seededSurveys, seededResponses, [], meta(1));
    await store.reconcileSegment(
      { fromSlot: 300, toSlot: 600 },
      [],
      [],
      [],
      meta(2),
    );

    expect(
      (await store.surveyRowsByKeys(["aa:0", "bb:0", "cc:0"])).map(
        (r) => r.surveyKey,
      ),
    ).toEqual(["aa:0", "cc:0"]);
    expect(
      (await store.responseRowsInSlotRange({ fromSlot: 0, toSlot: 1_000 })).map(
        (r) => r.txHash,
      ),
    ).toEqual(["r1", "r3"]);
  });

  it("reads the pre-sweep window state by inclusive slot bounds", async () => {
    store = openBackendStore(":memory:");
    await store.reconcileSnapshot(seededSurveys, seededResponses, [], meta(1));

    expect(
      (await store.responseRowsInSlotRange({ fromSlot: 450, toSlot: 550 })).map(
        (r) => r.txHash,
      ),
    ).toEqual(["r2", "r5"]);
    expect(
      await store.responseRowsInSlotRange({ fromSlot: 451, toSlot: 549 }),
    ).toEqual([]);
  });

  it("serves keyed projection and response reads in stable order", async () => {
    store = openBackendStore(":memory:");
    await store.reconcileSnapshot(
      [...seededSurveys, survey("dd:0", 900, { sealed: true })],
      seededResponses,
      [],
      meta(1),
    );

    const rows = await store.surveyRowsByKeys(["dd:0", "aa:0", "unknown:0"]);
    expect(rows.map((r) => r.surveyKey)).toEqual(["aa:0", "dd:0"]);
    expect(rows[1]).toMatchObject({ sealed: true, cancelled: false });

    expect(
      (await store.responseRowsForSurveys(["aa:0"])).map((r) => r.txHash),
    ).toEqual(["r1", "r2"]);
    expect(await store.responseRowsForSurveys([])).toEqual([]);
    expect(await store.surveyRowsByKeys([])).toEqual([]);
  });

  it("feeds each refresh consumer its bounded slice of the corpus", async () => {
    store = openBackendStore(":memory:");
    await store.reconcileSnapshot(
      [
        survey("aa:0", 100, { endEpoch: 490 }), // closed, finalized below
        survey("bb:0", 200, { endEpoch: 495 }), // closed, artifact-less
        survey("cc:0", 300, { endEpoch: 500 }), // open at tip 500
        survey("dd:0", 400, { endEpoch: 495 }), // closed, artifact-less
      ],
      [],
      [],
      meta(1),
    );
    await store.putArtifact({
      surveyKey: "aa:0",
      endEpoch: 490,
      artifactHash: "h1",
      artifact: "{}",
      createdAt: 1,
    });

    // The governance pass's input: distinct, ascending, from its horizon up.
    expect(await store.surveyEndEpochs(0)).toEqual([490, 495, 500]);
    expect(await store.surveyEndEpochs(495)).toEqual([495, 500]);
    // Finalization candidates: closed at the tip, minus the finalized, from
    // the floor (inclusive) up — above it, nothing is left to decide.
    expect(
      (await store.unfinalizedClosedSurveyRows(0, 500)).map((r) => r.surveyKey),
    ).toEqual(["bb:0", "dd:0"]);
    expect(
      (await store.unfinalizedClosedSurveyRows(495, 500)).map(
        (r) => r.surveyKey,
      ),
    ).toEqual(["bb:0", "dd:0"]);
    expect(await store.unfinalizedClosedSurveyRows(496, 500)).toEqual([]);
    // The prune's live horizon is inclusive at its floor.
    expect(
      (await store.surveyRowsEndingAtOrAfter(495)).map((r) => r.surveyKey),
    ).toEqual(["bb:0", "cc:0", "dd:0"]);
    expect(
      (await store.surveyRowsEndingAtOrAfter(496)).map((r) => r.surveyKey),
    ).toEqual(["cc:0"]);
  });
});

describe("store-node tx proof cache", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  const hash = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

  it("banks CBOR per tx hash, terminally, and drops what it is told to", async () => {
    store = openBackendStore(":memory:");
    await store.putTxProofCbor(
      new Map([
        [hash(1), "84a4"],
        [hash(2), "84a5"],
      ]),
    );
    expect(await store.cachedTxProofCbor([hash(1), hash(2), hash(3)])).toEqual(
      new Map([
        [hash(1), "84a4"],
        [hash(2), "84a5"],
      ]),
    );

    // A tx hash content-addresses its bytes, so a second write of the same hash
    // cannot revise evidence a verdict may already rest on.
    await store.putTxProofCbor(new Map([[hash(1), "deadbeef"]]));
    expect((await store.cachedTxProofCbor([hash(1)])).get(hash(1))).toBe(
      "84a4",
    );

    await store.deleteTxProofCbor([hash(1)]);
    expect(await store.cachedTxProofCbor([hash(1), hash(2)])).toEqual(
      new Map([[hash(2), "84a5"]]),
    );
  });

  it("reads more hashes than one statement may bind", async () => {
    store = openBackendStore(":memory:");
    const hashes = Array.from({ length: 250 }, (_, i) => hash(i));
    await store.putTxProofCbor(new Map(hashes.map((h) => [h, `cbor${h}`])));
    const got = await store.cachedTxProofCbor(hashes);
    expect(got.size).toBe(250);
    expect(got.get(hashes[249]!)).toBe(`cbor${hashes[249]!}`);
  });

  it("lists what it holds, so the sweep costs the cache and not the archive", async () => {
    store = openBackendStore(":memory:");
    await store.putTxProofCbor(
      new Map([
        [hash(1), "84a4"],
        [hash(2), "84a5"],
      ]),
    );
    expect(new Set(await store.cachedTxProofHashes())).toEqual(
      new Set([hash(1), hash(2)]),
    );

    await store.deleteTxProofCbor([hash(1)]);
    expect(await store.cachedTxProofHashes()).toEqual([hash(2)]);
  });
});

describe("store-node governance-link resolution state", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  const doc = (surveyKey: string) => ({ surveyKey, title: "a title" });

  it("banks a classification per anchor hash, including a verified non-link", async () => {
    store = openBackendStore(":memory:");
    await store.putGovAnchors(
      new Map([
        ["aa".repeat(32), doc("s1:0")],
        ["bb".repeat(32), null], // verified: this document is not a link
      ]),
    );

    // A cached row and a null row are different answers; an unbanked hash is a
    // third one (absent), which is what "still unresolved" means.
    expect(
      await store.cachedGovAnchors([
        "aa".repeat(32),
        "bb".repeat(32),
        "cc".repeat(32),
      ]),
    ).toEqual(
      new Map<string, unknown>([
        ["aa".repeat(32), doc("s1:0")],
        ["bb".repeat(32), null],
      ]),
    );

    // Content is hash-fixed, so a banked row is terminal — a later write of the
    // same hash cannot revise the classification an artifact may already rest on.
    await store.putGovAnchors(new Map([["aa".repeat(32), doc("other:9")]]));
    expect(
      (await store.cachedGovAnchors(["aa".repeat(32)])).get("aa".repeat(32)),
    ).toEqual(doc("s1:0"));

    await store.deleteGovAnchors(["aa".repeat(32)]);
    expect(
      await store.cachedGovAnchors(["aa".repeat(32), "bb".repeat(32)]),
    ).toEqual(new Map([["bb".repeat(32), null]]));
  });

  it("settles an epoch once, with its links and its given-up anchors", async () => {
    store = openBackendStore(":memory:");
    const link = {
      surveyKey: "s1:0",
      actionId: "gov_action1a",
      endEpoch: 510,
      title: null,
    };
    await store.putSettledGovEpoch({
      expiration: 511,
      links: [link],
      gaveUp: ["gov_action1dead"],
      settledAt: 1000,
    });
    // A settled epoch leaves the scan for good, so re-settling it must not be
    // able to drop links a snapshot is already publishing.
    await store.putSettledGovEpoch({
      expiration: 511,
      links: [],
      gaveUp: [],
      settledAt: 2000,
    });

    expect(await store.settledGovEpochs([511, 512])).toEqual(
      new Map([
        [
          511,
          {
            expiration: 511,
            links: [link],
            gaveUp: ["gov_action1dead"],
            settledAt: 1000,
          },
        ],
      ]),
    );
    expect(await store.settledGovEpochs([512])).toEqual(new Map());
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
    upstreamRequests: 9,
    koiosCalls: 7,
    ok: true,
    error: null,
    govLinksOk: true,
    incomplete: false,
    surveys: 3,
    responses: 5,
    payloadBytes: 10_000,
    validationBacklog: 2,
    ...over,
  });

  it("round-trips the latest run and aggregates a window", async () => {
    store = openBackendStore(":memory:");
    expect(await store.lastRefreshRun()).toBeNull();

    await store.putRefreshRun(run(1000));
    await store.putRefreshRun(
      run(1180, { ok: false, error: "Koios GET /tip → 502", koiosCalls: 2 }),
    );
    await store.putRefreshRun(
      run(1360, { upstreamRequests: 17, koiosCalls: 11, incomplete: true }),
    );

    const last = await store.lastRefreshRun();
    expect(last).toMatchObject({
      startedAt: 1360,
      upstreamRequests: 17,
      koiosCalls: 11,
      ok: true,
      error: null,
      govLinksOk: true,
      incomplete: true,
      validationBacklog: 2,
    });

    // Window covering the two most recent runs only.
    expect(await store.refreshTotalsSince(1180)).toEqual({
      runs: 2,
      failures: 1,
    });
    // Empty window aggregates to zeros, not NULLs.
    expect(await store.refreshTotalsSince(9999)).toEqual({
      runs: 0,
      failures: 0,
    });
  });

  // A gov-links failure leaves the run `ok` (the snapshot still publishes, with
  // the previous run's links), so this flag is the only thing that records it.
  it("records a gov-links failure on an otherwise successful run", async () => {
    store = openBackendStore(":memory:");
    await store.putRefreshRun(run(1000, { govLinksOk: false }));
    expect(await store.lastRefreshRun()).toMatchObject({
      ok: true,
      govLinksOk: false,
    });
  });

  it("prunes rows older than the retention window on insert", async () => {
    store = openBackendStore(":memory:");
    const now = 10_000_000;
    await store.putRefreshRun(run(now - OPERATIONAL_RETENTION_SECONDS - 1));
    await store.putRefreshRun(run(now - OPERATIONAL_RETENTION_SECONDS + 1));
    await store.putRefreshRun(run(now));

    expect(await store.refreshTotalsSince(0)).toMatchObject({ runs: 2 });
  });

  it("accumulates upstream calls per kind and bucket", async () => {
    store = openBackendStore(":memory:");
    const t = tallyBucket(1_000_000);
    await store.addUpstreamCalls(t, { koios: 4, anchor: 2 });
    // Same bucket: adds to the existing row rather than replacing it.
    await store.addUpstreamCalls(t + TALLY_BUCKET_SECONDS - 1, { koios: 1 });
    await store.addUpstreamCalls(t + TALLY_BUCKET_SECONDS, {
      "koios-passthrough": 3,
    });

    expect(await store.upstreamTotalsSince(t)).toEqual({
      koios: 5,
      "koios-passthrough": 3,
      anchor: 2,
    });
    // A window starting after the first bucket sees only what followed it.
    expect(await store.upstreamTotalsSince(t + TALLY_BUCKET_SECONDS)).toEqual({
      koios: 0,
      "koios-passthrough": 3,
      anchor: 0,
    });
    // Every kind is reported, zero included, so a reader never sees a hole.
    expect(
      await store.upstreamTotalsSince(t + 10 * TALLY_BUCKET_SECONDS),
    ).toEqual({ koios: 0, "koios-passthrough": 0, anchor: 0 });
  });

  it("drops tally buckets before the prune point", async () => {
    store = openBackendStore(":memory:");
    const t = tallyBucket(1_000_000);
    await store.addUpstreamCalls(t, { koios: 4 });
    await store.addUpstreamCalls(t + TALLY_BUCKET_SECONDS, { koios: 6 });

    await store.pruneUpstreamTally(t + TALLY_BUCKET_SECONDS);
    expect(await store.upstreamTotalsSince(0)).toMatchObject({ koios: 6 });
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
