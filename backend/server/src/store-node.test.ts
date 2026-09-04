/**
 * The store itself, where the SQL carries logic no behavioural test would
 * pin on its own: the migration runner (including the pre-runner databases it
 * has to recognise), the `json_extract` predicate behind a touched survey's
 * artifact keys, the conditional upsert behind the refresh lease,
 * the join and cascade behind the sealed-reveal cursor, the paging keyset and
 * the filters no route test reaches, the segment sweep's changed-row count,
 * the changed-rows-only write contract of a reconcile, the write-once
 * terminality of the evidence tables, the D1 parameter-cap chunking, and the
 * operational retention prunes. Everything else the store does is pinned by
 * the behavioural suites, which run on this same SQL via `testing/store.ts`.
 *
 * D1 shares both the dialect and `store-sql.ts`, so what passes here holds
 * there; `store-d1.test.ts` covers only what its driver does differently
 * (batching, transaction rollback).
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
import { changesCursorAt } from "./changes";
import { changedSurveysSql, removedSurveysSql } from "./sqlBuilders";
import { openBackendStore } from "./store-node";
import { ALL_SLOTS, testStore, type TestStore } from "./testing/store";

const artifact = (surveyKey: string, tally: string, hash: string) => ({
  surveyKey,
  endEpoch: 500,
  artifactHash: hash,
  artifact: `{"tally":${tally},"provenance":{}}`,
  createdAt: 1,
});

describe("store-node artifact keys (json_extract)", () => {
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

    expect(
      (await store.touchedRows(["aa:0", "bb:1", "cc:2", "dd:3"])).finalStates,
    ).toEqual(
      new Map([
        ["aa:0", { state: "finalized", artifactHash: "a1".repeat(32) }],
        ["bb:1", { state: "cancelled", artifactHash: "b2".repeat(32) }],
        ["cc:2", { state: "finalized", artifactHash: "c3".repeat(32) }],
      ]),
    );
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
      expect(await store.completedValidationsForTxs(["aa"])).toEqual(
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
        (await store.completedValidationsForTxs(["bb"])).get("bb:1"),
      ).toMatchObject({ linkedActionId: "gov#0" });
      // Missing tables were created by their migrations, not the baseline.
      await store.reconcileSegment(ALL_SLOTS, [], [], [], [], 7);
      await store.publishSnapshotMeta({
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
      "0022_validation_backlog_index.sql",
      "0023_response_identity.sql",
      "0024_scan_state_network.sql",
      "0025_final_state.sql",
      "0026_counted_by_role.sql",
      "0027_change_selection.sql",
    ]);
  });
});

describe("store-node migration to identity columns", () => {
  it("backfills each stored response's role from its record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-store-"));
    const path = join(dir, "cache.sqlite");
    // A database at 0022 exactly, holding a response row in the shape the
    // wire JSON has always had — role inside the record.
    const migrationsDir = fileURLToPath(
      new URL("../migrations", import.meta.url),
    );
    const before = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql") && f < "0023")
      .sort();
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE schema_migration (
      name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
    );`);
    for (const file of before) {
      old.exec(readFileSync(join(migrationsDir, file), "utf8"));
      old.prepare("INSERT INTO schema_migration VALUES (?, 1)").run(file);
    }
    const record = JSON.stringify({
      txHash: "aa",
      slot: 5,
      epochNo: 1,
      responseIndex: 0,
      response: { specVersion: 5, role: 3, credential: {}, answers: {} },
    });
    old
      .prepare(
        `INSERT INTO response (tx_hash, response_index, survey_key, credential, slot, record)
         VALUES ('aa', 0, 's:0', 'key:11', 5, ?)`,
      )
      .run(record);
    old.close();

    const store = openBackendStore(path);
    try {
      expect(
        await store.responseIdentitiesFrom([{ surveyKey: "s:0", fromSlot: 0 }]),
      ).toEqual([
        {
          txHash: "aa",
          responseIndex: 0,
          surveyKey: "s:0",
          role: 3,
          credential: "key:11",
          slot: 5,
          // No verdict says otherwise, so 0026's backfill leaves it countable.
          countable: true,
        },
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
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
      await store.publishSnapshotMeta({
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
        (await store.touchedRows(["aa:0"])).cancellations.map((r) => [
          r.txHash,
          r.surveyKey,
          r.slot,
        ]),
      ).toEqual([
        ["c1", "aa:0", 150],
        ["c2", "aa:0", 160],
      ]);
      // Each row's record is that cancellation's own slice of the projection.
      const rows = (
        await store.sweepInputs({ fromSlot: 150, toSlot: 150 }, null, 0)
      ).cancellations;
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
    countedByRole: "{}",
    refutedCount: 0,
    finalState: null,
    artifactHash: null,
    ...over,
  });
  const GENERATION = 7;

  // linked (bucket 0), three open (cb/cc slot-tied, so the key tie-break the
  // cursor rests on has a witness), one closed.
  const rows = [
    row("aa:0", 100, { govLinked: true }),
    row("bb:0", 300),
    row("cb:0", 500),
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
    await store.reconcileSegment(ALL_SLOTS, rows, [], [], [], GENERATION);

    const all = await page({});
    expect(all.map((r) => r.surveyKey)).toEqual([
      "aa:0",
      "cb:0",
      "cc:0",
      "bb:0",
      "dd:0",
    ]);
    expect(all.map((r) => r.bucket)).toEqual([0, 1, 1, 1, 2]);

    // A cursor on the first of two slot-tied rows resumes at the second.
    const second = await page({
      cursor: { bucket: 1, slot: 500, key: "cb:0" },
      limit: 2,
    });
    expect(second.map((r) => r.surveyKey)).toEqual(["cc:0", "bb:0"]);
  });

  // The route fixture carries no sealed survey, so these two filters have no
  // behavioural witness.
  it("filters sealed and public against the active set", async () => {
    store = openBackendStore(":memory:");
    await store.reconcileSegment(ALL_SLOTS, rows, [], [], [], GENERATION);

    expect((await page({ filter: "sealed" })).map((r) => r.surveyKey)).toEqual([
      "cc:0",
    ]);
    expect((await page({ filter: "public" })).map((r) => r.surveyKey)).toEqual([
      "aa:0",
      "cb:0",
      "bb:0",
    ]);
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

  const GENERATION = 7;
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
    role: 3,
    credential,
    slot,
    countable: true,
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
    // Only one is linked, so a bundle serving the wrong survey's links shows.
    govLinks: surveyKey === "aa:0" ? `[{"g":"aa:0"}]` : "[]",
    responseCount: 0,
    countedByRole: "{}",
    refutedCount: 0,
    finalState: null,
    artifactHash: null,
  }));

  it("writes only changed rows on reconciliation, and never the envelope", async () => {
    storeDir = mkdtempSync(join(tmpdir(), "tessera-reconcile-"));
    const path = join(storeDir, "store.sqlite");
    store = openBackendStore(path);
    await store.reconcileSegment(ALL_SLOTS, surveys, rows, [], [], GENERATION);

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
      CREATE TRIGGER audit_tombstone AFTER INSERT ON survey_tombstone
        BEGIN INSERT INTO reconcile_audit VALUES ('tombstone:' || NEW.survey_key); END;
      CREATE TRIGGER audit_meta_insert AFTER INSERT ON snapshot_meta
        BEGIN INSERT INTO reconcile_audit VALUES ('meta:insert'); END;
      CREATE TRIGGER audit_meta_update AFTER UPDATE ON snapshot_meta
        BEGIN INSERT INTO reconcile_audit VALUES ('meta:update'); END;
    `);
    audit.close();

    // A quiet refresh under a new generation writes nothing at all: the
    // generation reaches a row only through the SET list of a changed one.
    await store.reconcileSegment(ALL_SLOTS, surveys, rows, [], [], 8);
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT event FROM reconcile_audit").all()).toEqual(
      [],
    );
    check.close();
    expect(await store.snapshotMeta()).toBeNull();

    const newResponse = resp("gg", "aa:0", "key:11", 970_000);
    await store.reconcileSegment(
      ALL_SLOTS,
      surveys.map((survey) =>
        survey.surveyKey === "aa:0"
          ? { ...survey, responseCount: survey.responseCount + 1 }
          : survey,
      ),
      [...rows, newResponse],
      [],
      [],
      9,
    );
    const changed = new DatabaseSync(path);
    expect(changed.prepare("SELECT event FROM reconcile_audit").all()).toEqual([
      { event: "survey:update:aa:0" },
      { event: "response:insert:gg:0" },
    ]);
    changed.close();
  });

  it("serves one survey's bundle in a stable order", async () => {
    store = openBackendStore(":memory:");
    await store.reconcileSegment(ALL_SLOTS, surveys, rows, [], [], GENERATION);
    const whole = { cursor: null, limit: 10 };

    // (slot, txHash, responseIndex): the same bytes on every refresh, so the
    // ETag's promise that an unchanged snapshot means an unchanged body holds.
    const bundle = await store.surveyBundle("aa:0", whole);
    expect(bundle?.record).toBe(`{"k":"aa:0"}`);
    expect(bundle?.cancellations).toBe(`[{"c":"aa:0"}]`);
    expect(bundle?.govLinks).toBe(`[{"g":"aa:0"}]`);
    expect(bundle?.responses.map((r) => r.record)).toEqual([
      `{"tx":"cc","i":0}`,
      `{"tx":"cc","i":1}`,
      `{"tx":"dd","i":0}`,
    ]);
    const other = await store.surveyBundle("bb:1", whole);
    expect(other?.responses.map((r) => r.record)).toEqual([
      `{"tx":"ff","i":0}`,
    ]);
    expect(other?.govLinks).toBe("[]");
    // A survey nobody answered still has a bundle; an unknown one has none.
    expect((await store.surveyBundle("empty:0", whole))?.responses).toEqual([]);
    expect(await store.surveyBundle("unknown:0", whole)).toBeNull();
  });

  it("pages a survey's responses by keyset, resuming after the cursor", async () => {
    store = openBackendStore(":memory:");
    await store.reconcileSegment(ALL_SLOTS, surveys, rows, [], [], GENERATION);

    const first = await store.surveyBundle("aa:0", { cursor: null, limit: 2 });
    expect(first?.responses.map((r) => r.record)).toEqual([
      `{"tx":"cc","i":0}`,
      `{"tx":"cc","i":1}`,
    ]);
    // The cursor is the page's last row, so the tie inside transaction `cc` is
    // broken by response index rather than re-serving or skipping a row.
    const last = first!.responses[1]!;
    const second = await store.surveyBundle("aa:0", {
      cursor: {
        slot: last.slot,
        txHash: last.txHash,
        responseIndex: last.responseIndex,
      },
      limit: 2,
    });
    expect(second?.responses.map((r) => r.record)).toEqual([
      `{"tx":"dd","i":0}`,
    ]);
    // The survey's own row rides every page — it is what a page of responses
    // hangs off, not a section of the page.
    expect(second?.record).toBe(`{"k":"aa:0"}`);
    // Past the end: no rows, and the page still resolves rather than 404ing.
    const third = await store.surveyBundle("aa:0", {
      cursor: {
        slot: last.slot + 1_000_000,
        txHash: "ff",
        responseIndex: 0,
      },
      limit: 2,
    });
    expect(third?.responses).toEqual([]);
  });
});

describe("store-node scan state", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  it("round-trips the walker state, including a generation rewind", async () => {
    store = openBackendStore(":memory:");
    // No row yet is the "never walked" signal, distinct from any cursor value.
    expect((await store.scanState()).walker).toBeNull();

    const walked = {
      cursor: { slot: 5_000, txHash: "aa".repeat(32) },
      caughtUp: true,
      generation: 3,
      trickle: { slot: 1_200, txHash: "bb".repeat(32) },
      network: "preview",
    };
    await store.putScanState(walked);
    expect((await store.scanState()).walker).toEqual(walked);

    // A rewind rewrites the whole row: null cursor, new generation, trickle
    // reset — nothing of the previous walk may survive by omission.
    const rewound = {
      cursor: null,
      caughtUp: false,
      generation: 4,
      trickle: null,
      network: "preview",
    };
    await store.putScanState(rewound);
    expect((await store.scanState()).walker).toEqual(rewound);
  });

  it("banks both floors without disturbing the cursor", async () => {
    store = openBackendStore(":memory:");
    // Before the first cursor there is no row to update, and 0 — ask about
    // everything — is exactly what a database with no history owes.
    await store.putSettlementFloor(511);
    await store.putFinalizationFloor(498);
    expect(await store.scanState()).toEqual({
      walker: null,
      settlementFloor: 0,
      finalizationFloor: 0,
    });

    const walked = {
      cursor: { slot: 5_000, txHash: "aa".repeat(32) },
      caughtUp: true,
      generation: 3,
      trickle: null,
      network: "preview",
    };
    await store.putScanState(walked);
    await store.putSettlementFloor(511);
    await store.putFinalizationFloor(498);
    expect(await store.scanState()).toEqual({
      walker: walked,
      settlementFloor: 511,
      finalizationFloor: 498,
    });

    // The cursor write leaves both alone: neither frontier is the scan's
    // coverage, and an incomplete scan that banks no cursor must not lose them.
    await store.putScanState({ ...walked, cursor: null, caughtUp: false });
    expect(await store.scanState()).toEqual({
      walker: { ...walked, cursor: null, caughtUp: false },
      settlementFloor: 511,
      finalizationFloor: 498,
    });
  });
});

describe("store-node segment reconciliation", () => {
  let store: BackendStore;
  afterEach(() => store.close());

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
    countedByRole: "{}",
    refutedCount: 0,
    finalState: null,
    artifactHash: null,
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
    role: 3,
    credential: "key:11",
    slot,
    countable: true,
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
    await store.reconcileSegment(
      ALL_SLOTS,
      seededSurveys,
      seededResponses,
      [],
      [],
      1,
    );

    // The segment [300, 600] saw: survey bb:0 gone (rolled back), response r2
    // re-listed with drifted bytes (a rollback repositioned its tx), r5 gone,
    // r4 new. aa:0 rides along as a touched survey from outside the range.
    const changes = await store.reconcileSegment(
      { fromSlot: 300, toSlot: 600 },
      [survey("aa:0", 100, { responseCount: 2 })],
      [resp("r2", "aa:0", 450, `{"tx":"drifted"}`), resp("r4", "aa:0", 500)],
      [],
      [],
      2,
    );
    // aa:0 updated, r2 updated, r4 inserted, bb:0 and r5 swept — bb:0's
    // tombstone is bookkeeping, not a sixth row change.
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
});

describe("store-node governance-link resolution state", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  const doc = (surveyKey: string) => ({ surveyKey, title: "a title" });

  it("a banked classification is terminal, safe to rest an artifact on", async () => {
    store = openBackendStore(":memory:");
    await store.putGovAnchors(new Map([["aa".repeat(32), doc("s1:0")]]));

    // Content is hash-fixed, so a banked row is terminal — a later write of the
    // same hash cannot revise the classification an artifact may already rest on.
    await store.putGovAnchors(new Map([["aa".repeat(32), doc("other:9")]]));
    expect(
      (await store.cachedGovAnchors(["aa".repeat(32)])).get("aa".repeat(32)),
    ).toEqual(doc("s1:0"));
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

    await store.pruneOperationalHistory(t + TALLY_BUCKET_SECONDS);
    expect(await store.upstreamTotalsSince(0)).toMatchObject({ koios: 6 });
  });
});

describe("store-node change selection", () => {
  let store: TestStore;
  afterEach(() => store.close());

  const row = (
    surveyKey: string,
    slot: number,
    over: Partial<SurveyIndexRow> = {},
  ): SurveyIndexRow => ({
    surveyKey,
    slot,
    endEpoch: 500,
    sealed: false,
    cancelled: false,
    govLinked: false,
    owner: "key:11",
    haystack: surveyKey,
    record: `{"k":"${surveyKey}"}`,
    cancellations: "[]",
    govLinks: "[]",
    responseCount: 0,
    countedByRole: "{}",
    refutedCount: 0,
    finalState: null,
    artifactHash: null,
    ...over,
  });
  const stamps = () =>
    Object.fromEntries(
      (
        store.db
          .prepare(
            "SELECT survey_key AS k, changed_at AS at FROM survey_index ORDER BY k",
          )
          .all() as { k: string; at: number }[]
      ).map((r) => [r.k, r.at]),
    );
  const tombstones = () =>
    store.db
      .prepare(
        "SELECT survey_key AS surveyKey, deleted_at AS deletedAt FROM survey_tombstone ORDER BY survey_key",
      )
      .all();

  it("stamps a row with the generation that moved it, and only then", async () => {
    store = testStore();
    const rows = [row("aa:0", 100), row("bb:0", 200)];
    await store.reconcileSegment(ALL_SLOTS, rows, [], [], [], 1);
    expect(stamps()).toEqual({ "aa:0": 1, "bb:0": 1 });

    // A quiet refresh leaves every stamp where it was.
    await store.reconcileSegment(ALL_SLOTS, rows, [], [], [], 2);
    expect(stamps()).toEqual({ "aa:0": 1, "bb:0": 1 });

    // A moved count stamps its row alone.
    await store.reconcileSegment(
      ALL_SLOTS,
      [row("aa:0", 100, { responseCount: 1 }), row("bb:0", 200)],
      [],
      [],
      [],
      3,
    );
    expect(stamps()).toEqual({ "aa:0": 3, "bb:0": 1 });

    // A final state stamps with the deciding run; re-stamping the same
    // decision touches nothing.
    const decided = [
      { surveyKey: "bb:0", state: "untalliable" as const, artifactHash: null },
    ];
    expect(await store.markFinalStates(decided, 4)).toBe(1);
    expect(await store.markFinalStates(decided, 5)).toBe(0);
    expect(stamps()).toEqual({ "aa:0": 3, "bb:0": 4 });
  });

  it("tombstones a swept survey, and a re-landed one is not a removal", async () => {
    store = testStore();
    await store.reconcileSegment(
      ALL_SLOTS,
      [row("aa:0", 100), row("bb:0", 200)],
      [],
      [],
      [],
      1,
    );
    // bb:0 rolled back: the segment covering its slot no longer lists it.
    await store.reconcileSegment(
      { fromSlot: 150, toSlot: 250 },
      [],
      [],
      [],
      [],
      2,
    );
    expect(tombstones()).toEqual([{ surveyKey: "bb:0", deletedAt: 2 }]);
    expect(await store.surveyChanges(changesCursorAt(1), 2, 10)).toEqual({
      rows: [],
      removed: [{ surveyKey: "bb:0", deletedAt: 2 }],
    });

    // It re-lands at a new slot: a row again, and the removal is gone from
    // the delta without the tombstone being touched.
    await store.reconcileSegment(
      ALL_SLOTS,
      [row("aa:0", 100), row("bb:0", 210)],
      [],
      [],
      [],
      3,
    );
    const relanded = await store.surveyChanges(changesCursorAt(1), 3, 10);
    expect(relanded.rows.map((r) => [r.surveyKey, r.changedAt])).toEqual([
      ["bb:0", 3],
    ]);
    expect(relanded.removed).toEqual([]);
    expect(tombstones()).toEqual([{ surveyKey: "bb:0", deletedAt: 2 }]);

    // Swept again: the one tombstone is restamped, and the removal shows to a
    // consumer positioned after the re-landing.
    await store.reconcileSegment(
      { fromSlot: 150, toSlot: 250 },
      [],
      [],
      [],
      [],
      4,
    );
    expect(tombstones()).toEqual([{ surveyKey: "bb:0", deletedAt: 4 }]);
    expect(
      (await store.surveyChanges(changesCursorAt(3), 4, 10)).removed,
    ).toEqual([{ surveyKey: "bb:0", deletedAt: 4 }]);

    await store.pruneOperationalHistory(4);
    expect(tombstones()).toEqual([{ surveyKey: "bb:0", deletedAt: 4 }]);
    await store.pruneOperationalHistory(5);
    expect(tombstones()).toEqual([]);
  });

  it("reads strictly after the position, at or below the generation, in its own order", async () => {
    store = testStore();
    const at = (n: number) => row("a".repeat(n) + ":0", 100 * n);
    // Later generations touch one or two rows each and sweep nothing.
    await store.reconcileSegment(
      ALL_SLOTS,
      [at(1), at(2), at(3)],
      [],
      [],
      [],
      1,
    );
    await store.reconcileSegment(
      null,
      [{ ...at(2), responseCount: 1 }],
      [],
      [],
      [],
      2,
    );
    await store.reconcileSegment(
      null,
      [{ ...at(3), responseCount: 1 }, at(4)],
      [],
      [],
      [],
      3,
    );
    await store.reconcileSegment(
      null,
      [{ ...at(1), responseCount: 1 }],
      [],
      [],
      [],
      4,
    );
    expect(stamps()).toEqual({ "a:0": 4, "aa:0": 2, "aaa:0": 3, "aaaa:0": 3 });

    const keysOf = (delta: { rows: { surveyKey: string }[] }) =>
      delta.rows.map((r) => r.surveyKey);
    // Everything after generation 1, published at 3: the row stamped 4 waits.
    expect(
      keysOf(await store.surveyChanges(changesCursorAt(1), 3, 10)),
    ).toEqual(["aa:0", "aaa:0", "aaaa:0"]);
    // Continuing from a key inside generation 3, published at 4.
    expect(
      keysOf(
        await store.surveyChanges(
          {
            rows: { stamp: 3, key: "aaa:0" },
            removed: { stamp: 3, key: null },
          },
          4,
          10,
        ),
      ),
    ).toEqual(["aaaa:0", "a:0"]);
    expect(keysOf(await store.surveyChanges(changesCursorAt(1), 3, 2))).toEqual(
      ["aa:0", "aaa:0"],
    );
    expect(
      keysOf(await store.surveyChanges(changesCursorAt(4), 4, 10)),
    ).toEqual([]);
  });

  it("seeks both axes on their own index, in either cursor form", () => {
    store = testStore();
    const planOf = ({ sql, params }: { sql: string; params: unknown[] }) =>
      (
        store.db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...(params as (string | number)[])) as { detail: string }[]
      ).map((r) => r.detail);
    for (const position of [
      { stamp: 5, key: null },
      { stamp: 5, key: "aa:0" },
    ]) {
      expect(planOf(changedSurveysSql(position, 9, 10))).toEqual([
        "SEARCH survey_index USING INDEX survey_index_changed (changed_at>? AND changed_at<?)",
      ]);
      expect(planOf(removedSurveysSql(position, 9, 10))[0]).toBe(
        "SEARCH survey_tombstone USING COVERING INDEX survey_tombstone_deleted (deleted_at>? AND deleted_at<?)",
      );
    }
  });
});
