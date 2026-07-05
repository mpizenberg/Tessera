/**
 * `store-node.ts` against a real (in-memory) SQLite database — exercised where
 * the SQL itself carries logic the in-memory store re-implements in JS, so the
 * two can't silently disagree. Today that's the `json_extract` predicate behind
 * `finalizedCancelledKeys` (D1 shares the same SQLite JSON1 dialect).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { BackendStore, RefreshRunRow } from "./store";
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
      await store.put({ payload: { surveys: [] }, fetchedAt: 7 });
      expect((await store.get())?.fetchedAt).toBe(7);
    } finally {
      store.close();
    }

    // Every migration file must now be tracked — the baseline for the ones
    // whose objects pre-existed, the runner for the rest.
    const check = new DatabaseSync(path);
    const tracked = (
      check.prepare("SELECT name FROM schema_migration ORDER BY name").all() as {
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
    ]);
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
