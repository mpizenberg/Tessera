/**
 * The scaling bench: what one steady-state refresh costs the store, against
 * corpus size, on the SQL the deployments run.
 *
 * ARCHITECTURE.md §0 forbids a per-refresh cost that grows with the archive.
 * D1 bills rows *read* — every row a statement steps over, index entries
 * included — which no local counter exposes, so this bench measures the two
 * things it can and that together bound it: what each statement *returns*
 * (rows and bytes into the process), and each statement's query plan, in
 * which a `SCAN` of a corpus table is exactly a read proportional to that
 * table. A refresh whose plans are all keyed and whose returned rows do not
 * move with the archive has no per-archive term. It also counts driver round
 * trips: on the Worker each one crosses whatever distance separates the cron
 * isolate from the D1 region, so trips, not statements, are the wall-clock
 * term (ARCHITECTURE.md §3).
 *
 * No chain, no Koios: the passes take their I/O as parameters and the corpus
 * is generated in-process, written through the store's own reconcile path.
 * The steady-state run mirrors `refreshSnapshot`'s sequence of reads and
 * passes; keep the two aligned when the refresh gains a read.
 *
 * Three axes, one profile each: the settled archive (closed, finalized
 * surveys and their responses), one open survey's settled participation, and
 * the records inside the settlement window. The first two must be flat; the
 * third is the per-new-record term and may grow with itself. `BENCH_DUMP=1`
 * prints each profile's heaviest statements.
 */

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { Role, type Credential, type SurveyDefinition } from "cip-179";
import {
  hexToBytes,
  refKey,
  type ChainTip,
  type Cip179Records,
  type ResponseRecord,
  type SurveyRecord,
} from "cip-179/domain";
import type { TallyInputSource } from "cip-179/tally";

import { loadConfig } from "./config";
import { finalizeClosedSurveys } from "./finalize";
import { integrateSegment } from "./integrate";
import { materializeSnapshot } from "./materialize";
import { pruneTxProofCache } from "./proofCache";
import { SCAN_GENERATION, SETTLEMENT_MARGIN_SLOTS } from "./refresh";
import { finalStateEntries } from "./store";
import type { BackendStore, SqlDriver, SqlQuery } from "./store";
import { nodeSqlDriver } from "./store-node";
import { sqlBackendStore } from "./store-sql";
import { ALL_SLOTS } from "./testing/store";
import { validateNewResponses } from "./validate";

// --- the meter --------------------------------------------------------------

interface Statement {
  readonly sql: string;
  readonly rows: number;
  readonly bytes: number;
  readonly plan: readonly string[];
}

interface Meter {
  readonly statements: Statement[];
  /** Driver calls — one round trip each, however many statements it carries. */
  trips: number;
  reset(): void;
}

/**
 * Tables whose size is the corpus. A `SCAN` of one of these in a steady-state
 * refresh is a per-archive read; a `SEARCH` is keyed. Partial-index scans are
 * O(what the index holds), which is the point of the index, so they pass.
 * `tx_proof_cache` is absent on purpose: eviction holds it at the live
 * working set, and the prune scans its keys by design.
 */
const CORPUS_TABLES = new Set([
  "survey_index",
  "response",
  "cancellation",
  "validated_response",
  "tally_artifact",
  "tx_metadata_cache",
  "weight_snapshot",
  "sealed_reveal",
  "response_count_bank",
]);
const BOUNDED_INDEXES = new Set([
  "validated_response_incomplete",
  "validated_response_refuted",
  "survey_index_refuted",
]);

const corpusScans = (statement: Statement): string[] =>
  statement.plan.filter((detail) => {
    const scan = /^SCAN (\w+)(?: USING (?:COVERING )?INDEX (\w+))?/.exec(
      detail,
    );
    return (
      scan !== null &&
      CORPUS_TABLES.has(scan[1]!) &&
      !(scan[2] !== undefined && BOUNDED_INDEXES.has(scan[2]))
    );
  });

function meteredStore(): { store: BackendStore; meter: Meter } {
  const db = new DatabaseSync(":memory:");
  const inner = nodeSqlDriver(db);
  const statements: Statement[] = [];
  const explain = (q: SqlQuery): string[] =>
    (
      db
        .prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
        .all(...(q.params as (string | number | null)[])) as {
        detail: string;
      }[]
    ).map((r) => r.detail);
  const record = (q: SqlQuery, rows: unknown[]): void => {
    statements.push({
      sql: q.sql,
      rows: rows.length,
      bytes: JSON.stringify(rows).length,
      plan: explain(q),
    });
  };
  const meter: Meter = {
    statements,
    trips: 0,
    reset: () => {
      statements.length = 0;
      meter.trips = 0;
    },
  };
  // An empty batch is short-circuited by the D1 driver too: no trip.
  const trip = (n: number): void => {
    if (n > 0) meter.trips += 1;
  };
  const driver: SqlDriver = {
    async all<T>(q: SqlQuery): Promise<T[]> {
      trip(1);
      const rows = await inner.all<T>(q);
      record(q, rows);
      return rows;
    },
    async batchAll<T>(queries: readonly SqlQuery[]): Promise<T[][]> {
      trip(queries.length);
      const batches = await inner.batchAll<T>(queries);
      queries.forEach((q, i) => record(q, batches[i]!));
      return batches;
    },
    async batchWrite(queries: readonly SqlQuery[]): Promise<number[]> {
      trip(queries.length);
      for (const q of queries)
        statements.push({ sql: q.sql, rows: 0, bytes: 0, plan: explain(q) });
      return inner.batchWrite(queries);
    },
    close: () => inner.close(),
  };
  return { store: sqlBackendStore(driver), meter };
}

// --- the corpus -------------------------------------------------------------

const CONFIG = loadConfig({});
const EPOCH_SLOTS = CONFIG.app.secondsPerEpoch;
const TIP_EPOCH = 100;
const TIP: ChainTip = {
  epoch: TIP_EPOCH,
  slot: TIP_EPOCH * EPOCH_SLOTS + 1_000,
  epochSlot: 1_000,
  time: 1_750_000_000,
  govActionLifetime: 6,
};
const HORIZON = TIP.slot - SETTLEMENT_MARGIN_SLOTS;

const keyCred = (n: number): Credential => ({
  type: "key",
  keyHash: hexToBytes(n.toString(16).padStart(56, "0")),
});
const txHashOf = (n: number): string => n.toString(16).padStart(64, "0");

function surveyAt(n: number, slot: number, endEpoch: number): SurveyRecord {
  const txHash = txHashOf(n);
  return {
    txHash,
    slot,
    epochNo: Math.floor(slot / EPOCH_SLOTS),
    ref: { txId: hexToBytes(txHash), index: 0 },
    definition: {
      specVersion: 5,
      owner: keyCred(1),
      title: `survey ${n}`,
      description: "",
      eligibleRoles: [Role.DRep, Role.Stakeholder],
      endEpoch,
      submissionMode: { type: "public" },
      questions: [
        {
          type: "singleChoice",
          prompt: "",
          options: { type: "options", labels: ["a", "b"] },
        },
      ],
    } satisfies SurveyDefinition,
  };
}

function responseAt(
  n: number,
  slot: number,
  target: SurveyRecord,
  cred: number,
): ResponseRecord {
  return {
    txHash: txHashOf(n),
    slot,
    epochNo: Math.floor(slot / EPOCH_SLOTS),
    responseIndex: 0,
    response: {
      specVersion: 5,
      surveyRef: target.ref,
      role: n % 3 === 0 ? Role.DRep : Role.Stakeholder,
      credential: keyCred(cred),
      answers: {
        type: "public",
        answers: [{ type: "singleChoice", questionIndex: 0, optionIndex: 0 }],
      },
    },
  };
}

interface Profile {
  /** Responses in closed, finalized surveys (ten per survey), all settled. */
  readonly archived: number;
  /** Settled responses of one open survey that is still being answered. */
  readonly participation: number;
  /** Responses inside the settlement window, on a second open survey. */
  readonly window: number;
}

interface Corpus {
  readonly stored: Cip179Records;
  /** The records a steady-state segment re-lists: everything in the window. */
  readonly segment: Cip179Records;
  readonly active: SurveyRecord;
  readonly nextTx: number;
  readonly govFloor: number;
}

async function seed(store: BackendStore, profile: Profile): Promise<Corpus> {
  let tx = 1;
  const surveys: SurveyRecord[] = [];
  const responses: ResponseRecord[] = [];
  // The archive: closed surveys spread over the epochs below the horizon,
  // finalized (an artifact each) and settled.
  const archiveEnd = Math.floor(HORIZON / EPOCH_SLOTS) - 2;
  for (let i = 0; i < profile.archived / 10; i++) {
    const end = 10 + (i % (archiveEnd - 10));
    const s = surveyAt(tx++, (end - 3) * EPOCH_SLOTS + i, end);
    surveys.push(s);
    for (let r = 0; r < 10; r++)
      responses.push(responseAt(tx++, s.slot + 100 + r, s, 1_000 + r));
  }
  // The actively answered open survey: its settled participation below the
  // horizon, and one response in the window that every run re-lists.
  const active = surveyAt(tx++, HORIZON - 10 * EPOCH_SLOTS, TIP_EPOCH + 2);
  surveys.push(active);
  for (let r = 0; r < profile.participation; r++)
    responses.push(responseAt(tx++, active.slot + 10 + r, active, 5_000 + r));
  const windowStart = HORIZON + 100;
  responses.push(responseAt(tx++, windowStart, active, 5_000));
  // The window's other traffic, on a second open survey.
  const other = surveyAt(tx++, HORIZON - EPOCH_SLOTS, TIP_EPOCH + 1);
  surveys.push(other);
  for (let r = 0; r < profile.window; r++)
    responses.push(responseAt(tx++, windowStart + 1 + r, other, 9_000 + r));

  const stored: Cip179Records = { surveys, responses, cancellations: [] };
  const snapshot = materializeSnapshot(stored, TIP, [], new Map());
  const meta = {
    tip: JSON.stringify({ epoch: TIP.epoch }),
    incomplete: false,
    fetchedAt: TIP.time,
    listCounts: JSON.stringify(snapshot.listCounts),
  };
  await store.reconcileSegment(
    ALL_SLOTS,
    snapshot.surveys,
    snapshot.responses,
    snapshot.cancellations,
    [],
    meta,
  );
  await store.upsertValidatedResponses(
    responses.map((r) => ({
      txHash: r.txHash,
      responseIndex: r.responseIndex,
      surveyKey: refKey(r.response.surveyRef),
      role: r.response.role,
      credential: `key:${(r.response.credential as { keyHash: Uint8Array }).keyHash.length}`,
      slot: r.slot,
      epochNo: r.epochNo,
      blockIndex: 1,
      proofOk: true,
      linkedActionId: null,
      wellFormed: true,
      checkedAt: 1,
    })),
  );
  for (const s of surveys.slice(0, -2)) {
    await store.putArtifact({
      surveyKey: refKey(s.ref),
      endEpoch: s.definition.endEpoch,
      artifactHash: s.txHash,
      artifact: `{"tally":{"perRole":[]},"provenance":{}}`,
      createdAt: 1,
    });
  }
  await store.putTxMetadata(
    new Map([...surveys, ...responses].map((r) => [r.txHash, { label: 17 }])),
  );
  await store.putScanState({
    cursor: { slot: TIP.slot, txHash: "" },
    caughtUp: true,
    generation: SCAN_GENERATION,
    trickle: null,
    network: CONFIG.app.network,
  });
  const govFloor = TIP_EPOCH + 1;
  await store.putSettlementFloor(govFloor);
  await store.putFinalizationFloor(TIP_EPOCH);

  const inWindow = (r: { slot: number }) => r.slot >= HORIZON;
  return {
    stored,
    segment: {
      surveys: surveys.filter(inWindow),
      responses: responses.filter(inWindow),
      cancellations: [],
    },
    active,
    nextTx: tx,
    govFloor,
  };
}

// --- one steady-state refresh, as refreshSnapshot sequences it -----------

const noKoios = {
  txProofs: async () => new Map<string, null>(),
  txBlockIndices: async () => new Map<string, number>(),
};
const noInputs: TallyInputSource = {
  stakeholderWeights: async () => new Map(),
  drepWeights: async () => new Map(),
  stakeholderTotal: async () => null,
  drepTotal: async () => null,
};

async function steadyRun(
  store: BackendStore,
  corpus: Corpus,
  segment: Cip179Records,
): Promise<void> {
  const previous = await store.snapshotMeta();
  const bank = await store.scanState();
  const govFloor = bank.settlementFloor;
  const govEpochs = [
    ...new Set([
      ...(await store.surveyEndEpochs(Math.max(0, govFloor - 1))),
      ...segment.surveys.map((s) => s.definition.endEpoch),
    ]),
  ];
  const range = { fromSlot: HORIZON, toSlot: TIP.slot };
  const meta = {
    tip: JSON.stringify({ epoch: TIP.epoch }),
    incomplete: false,
    fetchedAt: TIP.time + 1,
    listCounts: previous?.listCounts ?? null,
  };
  const integration = await integrateSegment(store, noKoios, {
    records: segment,
    range,
    tip: TIP,
    govPass: { links: [], scope: new Set(govEpochs), floor: govFloor },
    settledBelowSlot: HORIZON,
    meta,
  });
  await store.putScanState({
    cursor: { slot: TIP.slot, txHash: "" },
    caughtUp: true,
    generation: SCAN_GENERATION,
    trickle: null,
    network: CONFIG.app.network,
  });
  const finalFloor = bank.finalizationFloor;
  await validateNewResponses(store, segment.responses, noKoios, finalFloor);
  const finalized = await finalizeClosedSurveys(
    CONFIG,
    store,
    noInputs,
    noKoios,
    {
      tip: TIP,
      incomplete: false,
      coveredThroughUnix: TIP.time,
      settlementFloor: govFloor,
      finalizationFloor: finalFloor,
    },
  );
  await store.markFinalStates(finalStateEntries(finalized.emitted));
  await pruneTxProofCache(store, false, TIP);
  if (integration.changes > 0) {
    await store.surveyIndexCounts(TIP.epoch, [], []);
    await store.publishSnapshotMeta(meta);
  }
  await store.putRefreshRun({
    startedAt: TIP.time + 1,
    durationMs: 1,
    upstreamRequests: 0,
    koiosCalls: 0,
    ok: true,
    error: null,
    govLinksOk: true,
    incomplete: false,
    surveys: 0,
    responses: segment.responses.length,
    payloadBytes: integration.payloadBytes,
  });
  await store.pruneUpstreamTally(0);
  void corpus;
}

interface Cost {
  readonly trips: number;
  readonly statements: number;
  readonly rows: number;
  readonly bytes: number;
  readonly scans: string[];
}

const costOf = ({ trips, statements }: Meter): Cost => ({
  trips,
  statements: statements.length,
  rows: statements.reduce((n, s) => n + s.rows, 0),
  bytes: statements.reduce((n, s) => n + s.bytes, 0),
  scans: statements.flatMap((s) =>
    corpusScans(s).map(
      (d) => `${d} ← ${s.sql.replace(/\s+/g, " ").trim().slice(0, 260)}`,
    ),
  ),
});

/**
 * Seed a profile, run one refresh to bank what the first touch banks, then
 * measure two: a quiet run that re-lists the window unchanged, and an active
 * run in which one more response to the open survey has landed.
 */
async function measure(
  profile: Profile,
): Promise<{ quiet: Cost; active: Cost }> {
  const { store, meter } = meteredStore();
  try {
    const corpus = await seed(store, profile);
    await steadyRun(store, corpus, corpus.segment);
    meter.reset();
    await steadyRun(store, corpus, corpus.segment);
    const quiet = costOf(meter);
    if (process.env["BENCH_DUMP"])
      console.log(
        [...meter.statements]
          .sort((a, b) => b.rows - a.rows)
          .slice(0, 6)
          .map(
            (s) =>
              `${s.rows} rows ${s.bytes} B ← ${s.sql.replace(/\s+/g, " ").trim().slice(0, 120)}`,
          )
          .join("\n"),
      );
    meter.reset();
    const landed = responseAt(
      corpus.nextTx,
      TIP.slot - 10,
      corpus.active,
      5_000 + profile.participation + 1,
    );
    await steadyRun(store, corpus, {
      ...corpus.segment,
      responses: [...corpus.segment.responses, landed],
    });
    const active = costOf(meter);
    return { quiet, active };
  } finally {
    store.close();
  }
}

// --- the bench --------------------------------------------------------------

const BASE: Profile = { archived: 100, participation: 100, window: 10 };
const AXES: readonly (readonly [keyof Profile, readonly number[]])[] = [
  ["archived", [100, 1_000, 10_000]],
  ["participation", [100, 1_000, 10_000]],
  ["window", [10, 100, 1_000]],
];

describe("scaling bench: one steady-state refresh against corpus size", () => {
  it("reads nothing proportional to the archive or to settled participation", async () => {
    const lines: string[] = [];
    const flat: Record<string, Cost[]> = {};
    for (const [axis, sizes] of AXES) {
      for (const size of sizes) {
        const profile = { ...BASE, [axis]: size };
        const { quiet, active } = await measure(profile);
        lines.push(
          `${axis.padEnd(14)} ${String(size).padStart(6)} | quiet ${String(quiet.trips).padStart(2)} trips ${String(quiet.statements).padStart(3)} stmts ${String(quiet.rows).padStart(6)} rows ${String(quiet.bytes).padStart(8)} B` +
            ` | active ${String(active.trips).padStart(2)} trips ${String(active.statements).padStart(3)} stmts ${String(active.rows).padStart(6)} rows ${String(active.bytes).padStart(8)} B` +
            (quiet.scans.length + active.scans.length > 0
              ? ` | scans: ${[...new Set([...quiet.scans, ...active.scans])].join("; ")}`
              : ""),
        );
        (flat[axis] ??= []).push(quiet);
        // A quiet steady-state run keys every read: no corpus table is scanned.
        expect(quiet.scans, `${axis}=${size} quiet run scans`).toEqual([]);
        // An active run scans exactly one thing: the banked chip counts'
        // recompute over survey_index, which every run that changed rows pays.
        expect(
          [...new Set(active.scans.map((s) => s.split(" ← ")[0]))],
          `${axis}=${size} active run scans`,
        ).toEqual(["SCAN survey_index"]);
      }
    }
    console.log(
      [
        "per-refresh store cost by corpus profile (driver round trips; rows and bytes returned to the process)",
        ...lines,
      ].join("\n"),
    );
    // The two settled axes are flat: a hundredfold larger archive or
    // participation returns no more rows to a quiet refresh than the base.
    for (const axis of ["archived", "participation"] as const) {
      const [base, , largest] = flat[axis]!;
      expect(
        largest!.rows,
        `${axis}: rows returned at 100× the base`,
      ).toBeLessThanOrEqual(base!.rows + 5);
    }
  }, 120_000);
});
