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

import { pruneTxProofCache } from "./proofCache";

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

/** Records the hashes handed to `deleteTxProofCbor`, in one flat set. */
function deleteSpy() {
  const deleted = new Set<string>();
  return {
    deleted,
    async deleteTxProofCbor(txHashes: readonly string[]) {
      for (const h of txHashes) deleted.add(h);
    },
  };
}

describe("pruneTxProofCache", () => {
  it("keeps an open survey's transactions and drops a finalized one's", async () => {
    const open = survey(tx("aa"), 600);
    const done = survey(tx("bb"), 400);
    const store = deleteSpy();
    await pruneTxProofCache(
      store,
      records({
        surveys: [open, done],
        cancellations: [cancellation(tx("c1"), open)],
        responses: [response(tx("r1"), open), response(tx("r2"), done)],
      }),
      TIP,
      new Set([`${tx("bb")}:0`]),
    );
    expect(store.deleted).toEqual(new Set([tx("bb"), tx("r2")]));
  });

  it("drops a survey that closed long ago but never produced an artifact", async () => {
    // A spec-invalid definition is untalliable, so finalization emits nothing
    // for it — ever. Without the epoch backstop its proofs would be pinned for
    // the life of the deployment.
    const neverFinalized = survey(tx("aa"), TIP.epoch - 6);
    const store = deleteSpy();
    await pruneTxProofCache(
      store,
      records({ surveys: [neverFinalized] }),
      TIP,
      new Set(),
    );
    expect(store.deleted).toEqual(new Set([tx("aa")]));
  });

  it("keeps a closed-but-unfinalized survey inside the grace window", async () => {
    // Finalization postpones — an unknown owner-proof, an unread link set — and
    // must not pay for the proofs again when it resumes next refresh.
    const justClosed = survey(tx("aa"), TIP.epoch - 1);
    const store = deleteSpy();
    await pruneTxProofCache(
      store,
      records({ surveys: [justClosed] }),
      TIP,
      new Set(),
    );
    expect(store.deleted).toEqual(new Set());
  });

  it("keeps a transaction shared by a live survey and a dead one", async () => {
    // One tx, two definitions: batching is the cart's whole point, so this is
    // the common shape, and the live survey still needs the bytes.
    const shared = tx("aa");
    const live = survey(shared, 600, 0);
    const dead = survey(shared, 400, 1);
    const store = deleteSpy();
    await pruneTxProofCache(
      store,
      records({ surveys: [live, dead] }),
      TIP,
      new Set([`${shared}:1`]),
    );
    expect(store.deleted).toEqual(new Set());
  });

  it("prunes nothing from an incomplete snapshot", async () => {
    const done = survey(tx("bb"), 400);
    const store = deleteSpy();
    await pruneTxProofCache(
      store,
      records({ surveys: [done], incomplete: true }),
      TIP,
      new Set([`${tx("bb")}:0`]),
    );
    expect(store.deleted).toEqual(new Set());
  });
});
