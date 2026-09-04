import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { ResponseRow, SurveyIndexRow } from "./store";
import { d1BackendStore, type D1Like } from "./store-d1";
import { applyMigrations } from "./store-node";
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
  countedByRole: "{}",
  refutedCount: 0,
  finalState: null,
  artifactHash: null,
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
    countable: true,
    record: JSON.stringify({ n }),
  };
};

function fakeStore() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const d1 = new FakeD1(sqlite);
  return { d1, sqlite, store: d1BackendStore(d1) };
}

describe("D1 snapshot reconciliation", () => {
  it("rolls a failed reconcile's row changes back whole", async () => {
    const { sqlite, store } = fakeStore();
    await store.reconcileSegment(
      ALL_SLOTS,
      [survey("aa:0"), survey("bb:0")],
      [],
      [],
      [],
      7,
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
        8,
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
      1,
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
      2,
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
      1,
    );

    // The segment listed nothing: every response with slot in it rolled back.
    const changes = await store.reconcileSegment(
      { fromSlot: 5_000, toSlot: 5_999 },
      [],
      [],
      [],
      [],
      2,
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
