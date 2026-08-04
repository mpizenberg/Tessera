import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { ResponseRow, SnapshotMeta, SurveyIndexRow } from "./store";
import { d1BackendStore, type D1Like } from "./store-d1";

class FakeD1Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly values: readonly SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): FakeD1Statement {
    return new FakeD1Statement(this.db, this.sql, values as SQLInputValue[]);
  }

  async first<T = unknown>(): Promise<T | null> {
    const row = this.statement().get(...this.values) as T | undefined;
    return row ?? null;
  }

  async run(): Promise<unknown> {
    return this.statement().run(...this.values);
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: this.rows<T>() };
  }

  rows<T = unknown>(): T[] {
    const statement = this.statement();
    if (statement.columns().length === 0) {
      statement.run(...this.values);
      return [];
    }
    return statement.all(...this.values) as T[];
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
  ): Promise<{ results: unknown[] }[]> {
    this.batchSizes.push(statements.length);
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => ({
        results: statement.rows(),
      }));
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
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE response (
    tx_hash TEXT NOT NULL,
    response_index INTEGER NOT NULL,
    survey_key TEXT NOT NULL,
    credential TEXT NOT NULL,
    slot INTEGER NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (tx_hash, response_index)
  );
  CREATE INDEX response_survey
    ON response (survey_key, slot, tx_hash, response_index);
  CREATE INDEX response_credential ON response (credential);
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
    credential: `key:${n % 100}`,
    slot: n,
    record: JSON.stringify({ n }),
  };
};

const meta = (fetchedAt: number): SnapshotMeta => ({
  tip: JSON.stringify({ epoch: 500, fetchedAt }),
  incomplete: false,
  fetchedAt,
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
    await store.reconcileSnapshot(
      [survey("aa:0"), survey("bb:0")],
      [],
      meta(7),
    );
    sqlite.exec(`
      CREATE TRIGGER reject_bb BEFORE UPDATE ON survey_index
      WHEN NEW.survey_key = 'bb:0' AND NEW.slot = 999
      BEGIN SELECT RAISE(ABORT, 'reject bb'); END;
    `);

    await expect(
      store.reconcileSnapshot(
        [survey("aa:0", { slot: 111 }), survey("bb:0", { slot: 999 })],
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
    await store.reconcileSnapshot(
      [survey("survey:0", { responseCount: responses.length })],
      responses,
      meta(1),
    );

    expect(d1.batchSizes.at(-1)).toBeLessThan(100);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM response").get()).toEqual({
      n: 10_000,
    });

    const removed = new Set([0, 4_999, 5_000, 9_999]);
    const kept = responses.filter((_, n) => !removed.has(n));
    await store.reconcileSnapshot(
      [survey("survey:0", { responseCount: kept.length })],
      kept,
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
});
