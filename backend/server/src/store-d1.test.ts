import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { ResponseRow, SnapshotMeta, SurveyIndexRow } from "./store";
import { d1BackendStore, type D1Like } from "./store-d1";
import { ALL_SLOTS } from "./testing/store";

class FakeD1Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly values: readonly SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): FakeD1Statement {
    return new FakeD1Statement(this.db, this.sql, values as SQLInputValue[]);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const result = this.statement().run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: this.execute().results as T[] };
  }

  execute(): { results: unknown[]; changes: number } {
    const statement = this.statement();
    if (statement.columns().length === 0) {
      const result = statement.run(...this.values);
      return { results: [], changes: Number(result.changes) };
    }
    return { results: statement.all(...this.values), changes: 0 };
  }

  private statement(): StatementSync {
    return this.db.prepare(this.sql);
  }
}

class FakeD1 implements D1Like {
  readonly batchSizes: number[] = [];

  constructor(readonly sqlite: DatabaseSync) {}

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this.sqlite, query);
  }

  async batch(
    statements: FakeD1Statement[],
  ): Promise<{ results: unknown[]; meta: { changes: number } }[]> {
    this.batchSizes.push(statements.length);
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        const { results, changes } = statement.execute();
        return { results, meta: { changes } };
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

const schema = `
  CREATE TABLE survey_index (
    survey_key TEXT PRIMARY KEY,
    slot INTEGER NOT NULL,
    end_epoch INTEGER NOT NULL,
    sealed INTEGER NOT NULL,
    cancelled INTEGER NOT NULL,
    gov_linked INTEGER NOT NULL,
    owner TEXT NOT NULL,
    haystack TEXT NOT NULL,
    record TEXT NOT NULL,
    cancellations TEXT NOT NULL,
    gov_links TEXT NOT NULL,
    response_count INTEGER NOT NULL,
    finalized_cancelled INTEGER NOT NULL
  );
  CREATE TABLE snapshot_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    tip TEXT NOT NULL,
    incomplete INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    list_counts TEXT
  );
  CREATE TABLE response (
    tx_hash TEXT NOT NULL,
    response_index INTEGER NOT NULL,
    survey_key TEXT NOT NULL,
    role INTEGER NOT NULL,
    credential TEXT NOT NULL,
    slot INTEGER NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (tx_hash, response_index)
  );
  CREATE INDEX response_survey
    ON response (survey_key, slot, tx_hash, response_index);
  CREATE INDEX response_credential ON response (credential);
  CREATE INDEX response_slot ON response (slot, tx_hash, response_index);
  CREATE INDEX response_identity ON response (survey_key, role, credential, slot);
  CREATE TABLE response_count_bank (
    survey_key TEXT PRIMARY KEY,
    settled_count INTEGER NOT NULL,
    below_slot INTEGER NOT NULL
  );
  CREATE TABLE scan_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cursor_slot INTEGER,
    cursor_tx_hash TEXT,
    caught_up INTEGER NOT NULL DEFAULT 0,
    generation INTEGER NOT NULL,
    trickle_slot INTEGER,
    trickle_tx_hash TEXT,
    settlement_floor INTEGER NOT NULL DEFAULT 0,
    finalization_floor INTEGER NOT NULL DEFAULT 0,
    network TEXT
  );
  CREATE TABLE cancellation (
    tx_hash TEXT NOT NULL,
    survey_key TEXT NOT NULL,
    slot INTEGER NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (tx_hash, survey_key)
  );
  CREATE INDEX cancellation_survey ON cancellation (survey_key);
  CREATE INDEX cancellation_slot ON cancellation (slot, tx_hash);
`;

const survey = (
  surveyKey: string,
  over: Partial<SurveyIndexRow> = {},
): SurveyIndexRow => ({
  surveyKey,
  slot: 100,
  endEpoch: 500,
  sealed: false,
  cancelled: false,
  govLinked: false,
  owner: "key:11",
  haystack: surveyKey,
  record: JSON.stringify({ surveyKey }),
  cancellations: "[]",
  govLinks: "[]",
  responseCount: 0,
  finalizedCancelled: false,
  ...over,
});

const response = (n: number): ResponseRow => {
  const txHash = n.toString(16).padStart(64, "0");
  return {
    txHash,
    responseIndex: 0,
    surveyKey: "survey:0",
    role: 3,
    credential: `key:${n % 100}`,
    slot: n,
    record: JSON.stringify({ n }),
  };
};

const meta = (fetchedAt: number): SnapshotMeta => ({
  tip: JSON.stringify({ epoch: 500, fetchedAt }),
  incomplete: false,
  fetchedAt,
  listCounts: null,
});

function fakeStore() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  const d1 = new FakeD1(sqlite);
  return { d1, sqlite, store: d1BackendStore(d1) };
}

describe("D1 snapshot reconciliation", () => {
  it("rolls row changes and the envelope back as one generation", async () => {
    const { sqlite, store } = fakeStore();
    await store.reconcileSegment(
      ALL_SLOTS,
      [survey("aa:0"), survey("bb:0")],
      [],
      [],
      [],
      meta(7),
    );
    sqlite.exec(`
      CREATE TRIGGER reject_bb BEFORE UPDATE ON survey_index
      WHEN NEW.survey_key = 'bb:0' AND NEW.slot = 999
      BEGIN SELECT RAISE(ABORT, 'reject bb'); END;
    `);

    await expect(
      store.reconcileSegment(
        ALL_SLOTS,
        [survey("aa:0", { slot: 111 }), survey("bb:0", { slot: 999 })],
        [],
        [],
        [],
        meta(8),
      ),
    ).rejects.toThrow(/reject bb/);

    expect(
      sqlite
        .prepare(
          "SELECT survey_key, slot FROM survey_index ORDER BY survey_key",
        )
        .all(),
    ).toEqual([
      { survey_key: "aa:0", slot: 100 },
      { survey_key: "bb:0", slot: 100 },
    ]);
    expect(await store.snapshotMeta()).toEqual(meta(7));
    sqlite.close();
  });

  it("materializes and prunes 10,000 responses in bounded set operations", async () => {
    const { d1, sqlite, store } = fakeStore();
    const responses = Array.from({ length: 10_000 }, (_, n) => response(n));
    await store.reconcileSegment(
      ALL_SLOTS,
      [survey("survey:0", { responseCount: responses.length })],
      responses,
      [],
      [],
      meta(1),
    );

    expect(d1.batchSizes.at(-1)).toBeLessThan(100);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM response").get()).toEqual({
      n: 10_000,
    });

    const removed = new Set([0, 4_999, 5_000, 9_999]);
    const kept = responses.filter((_, n) => !removed.has(n));
    await store.reconcileSegment(
      ALL_SLOTS,
      [survey("survey:0", { responseCount: kept.length })],
      kept,
      [],
      [],
      meta(2),
    );

    expect(d1.batchSizes.at(-1)).toBeLessThan(100);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM response").get()).toEqual({
      n: 9_996,
    });
    for (const n of removed) {
      expect(
        sqlite
          .prepare("SELECT 1 FROM response WHERE tx_hash = ?")
          .get(n.toString(16).padStart(64, "0")),
      ).toBeUndefined();
    }
    expect(await store.snapshotMeta()).toEqual(meta(2));
    sqlite.close();
  });

  it("sweeps a segment in one bounded batch, sparing rows outside it", async () => {
    const { d1, sqlite, store } = fakeStore();
    const responses = Array.from({ length: 10_000 }, (_, n) => response(n));
    await store.reconcileSegment(
      ALL_SLOTS,
      [survey("survey:0", { slot: 20_000 })],
      responses,
      [],
      [],
      meta(1),
    );

    // The segment listed nothing: every response with slot in it rolled back.
    const changes = await store.reconcileSegment(
      { fromSlot: 5_000, toSlot: 5_999 },
      [],
      [],
      [],
      [],
      meta(2),
    );

    expect(changes).toBe(1_000);
    expect(d1.batchSizes.at(-1)).toBeLessThan(100);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM response").get()).toEqual({
      n: 9_000,
    });
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM response WHERE slot >= 5000 AND slot < 6000",
        )
        .get(),
    ).toEqual({ n: 0 });
    // The survey row sits outside the segment and is not a sweep candidate.
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM survey_index").get(),
    ).toEqual({ n: 1 });
    expect(await store.snapshotMeta()).toEqual(meta(2));
    sqlite.close();
  });

  it("reports no scan state before the walker first banks one", async () => {
    const { sqlite, store } = fakeStore();
    expect((await store.scanState()).walker).toBeNull();

    const state = {
      cursor: { slot: 7_000, txHash: "ab".repeat(32) },
      caughtUp: true,
      generation: 1,
      trickle: null,
      network: "preview",
    };
    await store.putScanState(state);
    expect((await store.scanState()).walker).toEqual(state);

    // Both floors ride the same row but are written on their own, so a later
    // cursor write can't drop them.
    await store.putSettlementFloor(512);
    await store.putFinalizationFloor(499);
    await store.putScanState({ ...state, cursor: null, caughtUp: false });
    expect(await store.scanState()).toEqual({
      walker: { ...state, cursor: null, caughtUp: false },
      settlementFloor: 512,
      finalizationFloor: 499,
    });
    sqlite.close();
  });
});
