/**
 * The libSQL driver's own parts: its migration runner, and its rows. The
 * store's SQL is pinned once, on node:sqlite, in `store-node.test.ts`.
 */

import { DatabaseSync } from "node:sqlite";

import { createClient } from "@libsql/client";
import { expect, it } from "vitest";

import type { BackendStore, ResponseRow, SurveyIndexRow } from "./store";
import { applyLibsqlMigrations, libsqlBackendStore } from "./store-libsql";
import { applyMigrations, openBackendStore } from "./store-node";
import { ALL_SLOTS } from "./testing/store";

const SCHEMA = `SELECT type, name, tbl_name AS tblName, sql FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`;

const survey: SurveyIndexRow = {
  surveyKey: "aa:0",
  slot: 100,
  endEpoch: 500,
  sealed: false,
  cancelled: false,
  govLinked: true,
  talliable: true,
  owner: "key:11",
  haystack: "aa:0",
  record: JSON.stringify({ surveyKey: "aa:0" }),
  cancellations: "[]",
  govLinks: "[]",
  responseCount: 1,
  countedByRole: `{"3":1}`,
  refutedCount: 0,
  finalState: null,
  artifactHash: null,
};

const response: ResponseRow = {
  txHash: "bb".repeat(32),
  responseIndex: 0,
  surveyKey: "aa:0",
  role: 3,
  credential: "key:22",
  slot: 120,
  countable: true,
  record: JSON.stringify({ answers: [1] }),
};

async function roundTrip(store: BackendStore) {
  const changes = await store.reconcileSegment(
    ALL_SLOTS,
    [survey],
    [response],
    [],
    [],
    1,
  );
  return {
    changes,
    surveys: await store.surveyRowsByKeys(["aa:0"]),
    responses: await store.responseRowsForSurveys(["aa:0"]),
  };
}

it("migrates to node's schema once, and reads back what node:sqlite does", async () => {
  const client = createClient({ url: ":memory:" });
  const node = new DatabaseSync(":memory:");
  applyMigrations(node);

  expect((await applyLibsqlMigrations(client)).length).toBeGreaterThan(0);
  expect(await applyLibsqlMigrations(client)).toEqual([]);
  const schema = (await client.execute(SCHEMA)).rows.map((row) => ({ ...row }));
  expect(schema).toEqual(
    node
      .prepare(SCHEMA)
      .all()
      .map((row) => ({ ...row })),
  );
  node.close();

  const libsql = libsqlBackendStore(client);
  const local = openBackendStore(":memory:");
  const expected = await roundTrip(local);
  expect(await roundTrip(libsql)).toEqual(expected);
  libsql.close();
  local.close();
});
