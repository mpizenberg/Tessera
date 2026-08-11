import { describe, expect, it } from "vitest";

import { Role, type SurveyDefinition } from "cip-179";
import {
  hexToBytes,
  type CancellationRecord,
  type ChainTip,
  type Cip179Records,
  type ResponseRecord,
  type SurveyRecord,
} from "cip-179/domain";

import { materializeSnapshot } from "./materialize";
import { pruneTxProofCache } from "./proofCache";
import { ALL_SLOTS, testStore } from "./testing/store";

const tx = (byte: string) => byte.repeat(32);

const TIP: ChainTip = {
  epoch: 502,
  slot: 43_372_800,
  epochSlot: 0,
  time: 1_750_000_000,
  govActionLifetime: 6,
};

const definition = (endEpoch: number): SurveyDefinition => ({
  specVersion: 5,
  owner: { type: "key", keyHash: hexToBytes("0f".repeat(28)) },
  title: "t",
  description: "",
  eligibleRoles: [Role.Stakeholder] as Role[],
  endEpoch,
  submissionMode: { type: "public" },
  questions: [
    {
      type: "singleChoice",
      prompt: "",
      options: { type: "options", labels: ["yes", "no"] },
    },
  ],
});

const survey = (txHash: string, endEpoch: number, index = 0): SurveyRecord => ({
  txHash,
  slot: 100,
  epochNo: 495,
  ref: { txId: hexToBytes(txHash), index },
  definition: definition(endEpoch),
});

const cancellation = (
  txHash: string,
  target: SurveyRecord,
): CancellationRecord => ({
  txHash,
  slot: 200,
  epochNo: 499,
  target: target.ref,
  proof: null,
});

const response = (txHash: string, target: SurveyRecord): ResponseRecord => ({
  txHash,
  slot: 300,
  epochNo: 499,
  responseIndex: 0,
  response: {
    specVersion: 5,
    surveyRef: target.ref,
    role: Role.Stakeholder,
    credential: { type: "key", keyHash: hexToBytes("a1".repeat(28)) },
    answers: {
      type: "public",
      answers: [{ type: "singleChoice", questionIndex: 0, optionIndex: 0 }],
    },
  },
});

const records = (r: Partial<Cip179Records>): Cip179Records => ({
  surveys: [],
  responses: [],
  cancellations: [],
  ...r,
});

/**
 * A cache holding `banked`, recording what the sweep deletes. `calls` counts
 * deletion round-trips, so a test can tell "deleted nothing" from "asked the
 * database to delete nothing".
 */
function fakeCache(banked: readonly string[]) {
  const deleted = new Set<string>();
  let calls = 0;
  return {
    deleted,
    get calls() {
      return calls;
    },
    async cachedTxProofHashes() {
      return banked;
    },
    async deleteTxProofCbor(txHashes: readonly string[]) {
      calls += 1;
      for (const h of txHashes) deleted.add(h);
    },
  };
}

/**
 * Publish `recs` as materialized rows, then run the sweep over `banked` — the
 * differential harness: the fixtures the prune used to receive in memory,
 * read back through the store.
 */
async function prune(
  banked: readonly string[],
  recs: Cip179Records,
  finalized: ReadonlySet<string>,
) {
  const mem = testStore();
  const snapshot = materializeSnapshot(recs, TIP, [], new Set());
  await mem.reconcileSegment(
    ALL_SLOTS,
    snapshot.surveys,
    snapshot.responses,
    snapshot.cancellations,
    { tip: "{}", incomplete: false, fetchedAt: 1, listCounts: null },
  );
  const cache = fakeCache(banked);
  await pruneTxProofCache(
    {
      surveyRowsEndingAtOrAfter: (e) => mem.surveyRowsEndingAtOrAfter(e),
      responseRowsForSurveys: (keys) => mem.responseRowsForSurveys(keys),
      cachedTxProofHashes: cache.cachedTxProofHashes,
      deleteTxProofCbor: cache.deleteTxProofCbor,
    },
    recs.incomplete === true,
    TIP,
    finalized,
  );
  return cache;
}

describe("pruneTxProofCache", () => {
  it("keeps an open survey's transactions and drops a finalized one's", async () => {
    const open = survey(tx("aa"), 600);
    const done = survey(tx("bb"), 400);
    const cache = await prune(
      [tx("aa"), tx("bb"), tx("c1"), tx("r1"), tx("r2")],
      records({
        surveys: [open, done],
        cancellations: [cancellation(tx("c1"), open)],
        responses: [response(tx("r1"), open), response(tx("r2"), done)],
      }),
      new Set([`${tx("bb")}:0`]),
    );
    expect(cache.deleted).toEqual(new Set([tx("bb"), tx("r2")]));
  });

  it("drops a survey that closed long ago but never produced an artifact", async () => {
    // A spec-invalid definition is untalliable, so finalization emits nothing
    // for it — ever. Without the epoch backstop its proofs would be pinned for
    // the life of the deployment.
    const neverFinalized = survey(tx("aa"), TIP.epoch - 6);
    const cache = await prune(
      [tx("aa")],
      records({ surveys: [neverFinalized] }),
      new Set(),
    );
    expect(cache.deleted).toEqual(new Set([tx("aa")]));
  });

  it("keeps a closed-but-unfinalized survey inside the grace window", async () => {
    // Finalization postpones — an unknown owner-proof, an unread link set — and
    // must not pay for the proofs again when it resumes next refresh.
    const justClosed = survey(tx("aa"), TIP.epoch - 1);
    const cache = await prune(
      [tx("aa")],
      records({ surveys: [justClosed] }),
      new Set(),
    );
    expect(cache.calls).toBe(0);
  });

  it("keeps a transaction shared by a live survey and a dead one", async () => {
    // One tx, two definitions: batching is the cart's whole point, so this is
    // the common shape, and the live survey still needs the bytes.
    const shared = tx("aa");
    const live = survey(shared, 600, 0);
    const dead = survey(shared, 400, 1);
    const cache = await prune(
      [shared],
      records({ surveys: [live, dead] }),
      new Set([`${shared}:1`]),
    );
    expect(cache.calls).toBe(0);
  });

  it("collects a banked transaction no stored row mentions any more", async () => {
    // A rolled-back tx is claimed by nothing, so nothing keeps it.
    const cache = await prune(
      [tx("aa"), tx("f0")],
      records({ surveys: [survey(tx("aa"), 600)] }),
      new Set(),
    );
    expect(cache.deleted).toEqual(new Set([tx("f0")]));
  });

  it("costs nothing per dead survey that was never banked", async () => {
    // The archive grows without bound while the cache tracks the open set. A
    // sweep sized by the archive rather than by the cache would re-delete every
    // historical hash on every refresh, until the batch outgrew what the
    // database accepts and eviction failed exactly when it started to matter.
    const nth = (n: number) => n.toString(16).padStart(64, "0");
    const open = survey(tx("aa"), 600);
    const archive = Array.from({ length: 500 }, (_, i) =>
      survey(nth(i), 100, i),
    );
    const cache = await prune(
      [tx("aa")],
      records({
        surveys: [open, ...archive],
        responses: archive.map((s, i) => response(nth(1000 + i), s)),
      }),
      new Set(),
    );
    expect(cache.calls).toBe(0);
  });

  it("prunes nothing from an incomplete snapshot", async () => {
    const done = survey(tx("bb"), 400);
    const cache = await prune(
      [tx("bb")],
      records({ surveys: [done], incomplete: true }),
      new Set([`${tx("bb")}:0`]),
    );
    expect(cache.calls).toBe(0);
  });
});
