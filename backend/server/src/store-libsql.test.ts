/**
 * What the libSQL driver does on its own: migrate through its own transactions,
 * batch statements into one round trip, and roll a failed write batch back
 * whole. The store's SQL is pinned in `store-node.test.ts`, whose
 * interface-level suites run on this driver too.
 */

import { DatabaseSync } from "node:sqlite";

import type { Client } from "@libsql/client";
import { describe, expect, it } from "vitest";

import type { ResponseRow, SurveyIndexRow } from "./store";
import { applyLibsqlMigrations } from "./store-libsql";
import { applyMigrations } from "./store-node";
import { ALL_SLOTS, libsqlTestStore } from "./testing/store";

const SCHEMA = `SELECT type, name, tbl_name AS tblName, sql FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`;

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
  talliable: true,
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

/** The store, its client, and the statement count of every batch it sent. */
async function spiedStore() {
  const { client, store } = await libsqlTestStore();
  const batchSizes: number[] = [];
  const batch = client.batch.bind(client);
  client.batch = (statements, mode) => {
    batchSizes.push(statements.length);
    return batch(statements, mode);
  };
  return { batchSizes, client, store };
}

const rows = async (client: Client, sql: string, ...args: string[]) =>
  (await client.execute({ sql, args })).rows.map((row) => ({ ...row }));

describe("libSQL migrations", () => {
  it("build the schema the node driver builds, once", async () => {
    const { client } = await libsqlTestStore();
    const node = new DatabaseSync(":memory:");
    applyMigrations(node);

    expect(await rows(client, SCHEMA)).toEqual(
      node
        .prepare(SCHEMA)
        .all()
        .map((row) => ({ ...row })),
    );
    expect(await applyLibsqlMigrations(client)).toEqual([]);
    node.close();
    client.close();
  });
});

describe("libSQL snapshot reconciliation", () => {
  it("rolls a failed reconcile's row changes back whole", async () => {
    const { client, store } = await spiedStore();
    await store.reconcileSegment(
      ALL_SLOTS,
      [survey("aa:0"), survey("bb:0")],
      [],
      [],
      [],
      7,
    );
    await client.execute(`
      CREATE TRIGGER reject_bb BEFORE UPDATE ON survey_index
      WHEN NEW.survey_key = 'bb:0' AND NEW.slot = 999
      BEGIN SELECT RAISE(ABORT, 'reject bb'); END
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
      await rows(
        client,
        "SELECT survey_key, slot FROM survey_index ORDER BY survey_key",
      ),
    ).toEqual([
      { survey_key: "aa:0", slot: 100 },
      { survey_key: "bb:0", slot: 100 },
    ]);
    store.close();
  });

  it("materializes and prunes 10,000 responses in bounded set operations", async () => {
    const { batchSizes, client, store } = await spiedStore();
    const responses = Array.from({ length: 10_000 }, (_, n) => response(n));
    await store.reconcileSegment(
      ALL_SLOTS,
      [survey("survey:0", { responseCount: responses.length })],
      responses,
      [],
      [],
      1,
    );

    expect(batchSizes.at(-1)).toBeLessThan(100);
    expect(await rows(client, "SELECT COUNT(*) AS n FROM response")).toEqual([
      { n: 10_000 },
    ]);

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

    expect(batchSizes.at(-1)).toBeLessThan(100);
    expect(await rows(client, "SELECT COUNT(*) AS n FROM response")).toEqual([
      { n: 9_996 },
    ]);
    for (const n of removed) {
      expect(
        await rows(
          client,
          "SELECT 1 FROM response WHERE tx_hash = ?",
          n.toString(16).padStart(64, "0"),
        ),
      ).toEqual([]);
    }
    store.close();
  });

  it("sweeps a segment in one bounded batch, sparing rows outside it", async () => {
    const { batchSizes, client, store } = await spiedStore();
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
    expect(batchSizes.at(-1)).toBeLessThan(100);
    expect(await rows(client, "SELECT COUNT(*) AS n FROM response")).toEqual([
      { n: 9_000 },
    ]);
    expect(
      await rows(
        client,
        "SELECT COUNT(*) AS n FROM response WHERE slot >= 5000 AND slot < 6000",
      ),
    ).toEqual([{ n: 0 }]);
    // The survey row sits outside the segment and is not a sweep candidate.
    expect(
      await rows(client, "SELECT COUNT(*) AS n FROM survey_index"),
    ).toEqual([{ n: 1 }]);
    store.close();
  });
});
