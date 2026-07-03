import { describe, expect, it, vi } from "vitest";

import { Role, type Credential, type SurveyDefinition } from "cip-179";
import {
  artifactHash,
  credentialKey,
  hexToBytes,
  type CancellationRecord,
  type ChainTip,
  type Cip179Records,
  type ResponseRecord,
  type SurveyRecord,
  type TallyArtifact,
  type TallyBody,
  type TallyInputSource,
  type TxProof,
  type WeightInfo,
} from "@tessera/core";

import { loadConfig } from "./config";
import { finalizeClosedSurveys } from "./finalize";
import type { ValidatedResponseRow } from "./store";
import { memBackendStore, type MemBackendStore } from "./store-mem";

// --- fixtures ------------------------------------------------------------------

const CONFIG = loadConfig({}); // preview: secondsPerEpoch 86_400

const SURVEY_TX = "aa".repeat(32);
const SURVEY_KEY = `${SURVEY_TX}:0`;
const END_EPOCH = 500;

// Tip well past END_EPOCH: epoch 502, anchored far enough in the past that
// `now ≥ voteDeadlineUnix(500) + 600` holds with the real clock.
const TIP: ChainTip = {
  epoch: 502,
  slot: 43_372_800,
  epochSlot: 0,
  time: 1_750_000_000,
  govActionLifetime: 6,
};

const OWNER_HASH = "0f".repeat(28);
const keyCred = (hex: string): Credential => ({
  type: "key",
  keyHash: hexToBytes(hex),
});
const CRED_A = keyCred("a1".repeat(28));
const CRED_B = keyCred("b2".repeat(28));
const KEY_A = credentialKey(CRED_A);
const KEY_B = credentialKey(CRED_B);

function definition(
  overrides: Partial<SurveyDefinition> = {},
): SurveyDefinition {
  return {
    specVersion: 4,
    owner: keyCred(OWNER_HASH),
    title: "t",
    description: "",
    eligibleRoles: [Role.DRep, Role.Stakeholder, Role.Keyholder] as Role[],
    endEpoch: END_EPOCH,
    submissionMode: { type: "public" },
    questions: [
      {
        type: "singleChoice",
        prompt: "",
        options: { type: "options", labels: ["yes", "no"] },
      },
    ],
    ...overrides,
  };
}

function survey(def = definition()): SurveyRecord {
  return {
    txHash: SURVEY_TX,
    slot: 100,
    epochNo: 495,
    ref: { txId: hexToBytes(SURVEY_TX), index: 0 },
    definition: def,
  };
}

function response(
  txHash: string,
  cred: Credential,
  optionIndex: number,
  slot = 200,
  role: Role = Role.Stakeholder,
): ResponseRecord {
  return {
    txHash,
    slot,
    epochNo: 499,
    responseIndex: 0,
    response: {
      specVersion: 4,
      surveyRef: { txId: hexToBytes(SURVEY_TX), index: 0 },
      role,
      credential: cred,
      answers: {
        type: "public",
        answers: [{ type: "singleChoice", questionIndex: 0, optionIndex }],
      },
    },
  };
}

function validatedRow(
  r: ResponseRecord,
  overrides: Partial<ValidatedResponseRow> = {},
): ValidatedResponseRow {
  return {
    txHash: r.txHash,
    responseIndex: r.responseIndex,
    surveyKey: SURVEY_KEY,
    role: r.response.role,
    credential: credentialKey(r.response.credential),
    slot: r.slot,
    epochNo: r.epochNo,
    blockIndex: 0,
    proofOk: true,
    linkedActionId: null,
    wellFormed: true,
    checkedAt: 1,
    ...overrides,
  };
}

function fakeInputs(
  weights: Record<string, WeightInfo>,
  totals: { stakeholder?: bigint | null; drep?: bigint | null } = {},
): TallyInputSource & { stakeholderCalls: number } {
  const self = {
    stakeholderCalls: 0,
    async stakeholderWeights(_e: number, creds: readonly Credential[]) {
      self.stakeholderCalls += 1;
      return new Map(
        creds.map((c) => [
          credentialKey(c),
          weights[credentialKey(c)] ?? { weight: 0n, registered: false },
        ]),
      );
    },
    async drepWeights(_e: number, creds: readonly Credential[]) {
      return new Map(
        creds.map((c) => [
          credentialKey(c),
          weights[credentialKey(c)] ?? { weight: 0n, registered: false },
        ]),
      );
    },
    async stakeholderTotal() {
      return totals.stakeholder === undefined ? 1_000n : totals.stakeholder;
    },
    async drepTotal() {
      return totals.drep === undefined ? 2_000n : totals.drep;
    },
  };
  return self;
}

const noProofs = {
  txProofs: vi.fn(async () => new Map<string, TxProof | null>()),
};

async function seed(
  store: MemBackendStore,
  rows: readonly ValidatedResponseRow[],
) {
  await store.upsertValidatedResponses(rows);
}

function records(
  s: SurveyRecord,
  responses: ResponseRecord[],
  cancellations: CancellationRecord[] = [],
): Cip179Records {
  return { surveys: [s], responses, cancellations };
}

// --- tests -----------------------------------------------------------------------

describe("finalizeClosedSurveys", () => {
  const rA = response("11".repeat(32), CRED_A, 0);
  const rB = response("22".repeat(32), CRED_B, 1);

  it("emits a complete weighted artifact (weights, totals, sorted responders)", async () => {
    const store = memBackendStore();
    await seed(store, [validatedRow(rA), validatedRow(rB)]);
    const inputs = fakeInputs({
      [KEY_A]: { weight: 100n, registered: true },
      [KEY_B]: { weight: 7n, registered: true },
    });

    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), [rA, rB]),
      TIP,
    );

    const row = store.artifacts.get(SURVEY_KEY);
    expect(row).toBeDefined();
    const artifact = JSON.parse(row!.artifact) as TallyArtifact;
    // The stored hash is the content address of the canonical tally body.
    expect(artifactHash(artifact.tally as TallyBody)).toBe(row!.artifactHash);
    expect(artifact.tally.network).toBe("preview");
    expect(artifact.tally.survey).toEqual({
      txId: SURVEY_TX,
      index: 0,
      endEpoch: END_EPOCH,
    });

    const role3 = artifact.tally.perRole.find((r) => r.role === 3)!;
    expect(role3.total).toBe("1000");
    expect(role3.responders.map((r) => r.credential)).toEqual(
      [KEY_A, KEY_B].sort(),
    );
    const q = role3.questions[0]!;
    expect(q).toMatchObject({
      kind: "options",
      optionWeights: ["100", "7"],
      answeredWeight: "107",
    });
    // Weight rows were snapshotted (the resume cursor).
    expect(store.weights.size).toBe(2);
    expect(artifact.provenance.byRole).toEqual([
      { role: 3, endpoint: "account_stake_history" },
    ]);
  });

  it("postpones when the electorate total is unavailable, resumes without refetching weights", async () => {
    const store = memBackendStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs(
      { [KEY_A]: { weight: 5n, registered: true } },
      { stakeholder: null }, // upstream can't serve it yet
    );

    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), [rA]),
      TIP,
    );
    expect(store.artifacts.size).toBe(0);
    expect(store.weights.size).toBe(1); // weights already frozen

    // Next cron: total now available; weights must come from the cursor.
    const inputs2 = fakeInputs({ [KEY_A]: { weight: 999n, registered: true } });
    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs2,
      noProofs,
      records(survey(), [rA]),
      TIP,
    );
    expect(inputs2.stakeholderCalls).toBe(0); // resume cursor, no refetch
    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;
    // The frozen weight (5), not the would-be refetched 999.
    expect(artifact.tally.perRole[0]!.responders[0]!.weight).toBe("5");
  });

  it("is idempotent: an emitted survey is never re-finalized", async () => {
    const store = memBackendStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const recs = records(survey(), [rA]);

    await finalizeClosedSurveys(CONFIG, store, inputs, noProofs, recs, TIP);
    const first = store.artifacts.get(SURVEY_KEY)!;
    await finalizeClosedSurveys(CONFIG, store, inputs, noProofs, recs, TIP);
    expect(store.artifacts.get(SURVEY_KEY)).toBe(first);
    expect(inputs.stakeholderCalls).toBe(1);
  });

  it("produces the same artifact hash on independent runs (determinism)", async () => {
    const make = async () => {
      const store = memBackendStore();
      await seed(store, [validatedRow(rA), validatedRow(rB)]);
      await finalizeClosedSurveys(
        CONFIG,
        store,
        fakeInputs({
          [KEY_A]: { weight: 100n, registered: true },
          [KEY_B]: { weight: 7n, registered: true },
        }),
        noProofs,
        records(survey(), [rA, rB]),
        TIP,
      );
      return store.artifacts.get(SURVEY_KEY)!.artifactHash;
    };
    expect(await make()).toBe(await make());
  });

  it("emits a cancellation artifact for an owner-proven, in-window cancellation", async () => {
    const store = memBackendStore();
    await seed(store, [validatedRow(rA)]);
    const cancellation: CancellationRecord = {
      txHash: "cc".repeat(32),
      slot: 300,
      epochNo: 499, // ≤ END_EPOCH → in-window
      target: { txId: hexToBytes(SURVEY_TX), index: 0 },
      proof: null, // snapshot never verified it (survey was closed)
    };
    const proofs = {
      txProofs: vi.fn(
        async () =>
          new Map<string, TxProof | null>([
            [
              cancellation.txHash,
              { requiredSigners: [OWNER_HASH], nativeScripts: [], votes: [] },
            ],
          ]),
      ),
    };
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });

    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      proofs,
      records(survey(), [rA], [cancellation]),
      TIP,
    );

    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;
    expect(artifact.tally.cancelled).toEqual({
      txHash: cancellation.txHash,
      slot: 300,
      epoch: 499,
    });
    expect(artifact.tally.perRole).toEqual([]);
    expect(inputs.stakeholderCalls).toBe(0); // no weight work for cancelled
  });

  it("freezes weights for a sealed survey but emits no artifact", async () => {
    const store = memBackendStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });

    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(
        survey(
          definition({
            submissionMode: { type: "sealed", drandRound: 1 } as never,
          }),
        ),
        [rA],
      ),
      TIP,
    );
    expect(store.weights.size).toBe(1); // frozen
    expect(store.artifacts.size).toBe(0); // TODO(sealed-artifact)
  });

  it("applies the counted-set rules: dedupe latest-wins, unproven excluded, unregistered dropped", async () => {
    const store = memBackendStore();
    const rA2 = response("33".repeat(32), CRED_A, 1, 250); // A's later answer: "no"
    const rC = response("44".repeat(32), keyCred("c3".repeat(28)), 0);
    const rD = response("55".repeat(32), CRED_B, 0);
    await seed(store, [
      validatedRow(rA),
      validatedRow(rA2),
      validatedRow(rC, { proofOk: false }), // unproven → excluded (final verdict)
      validatedRow(rD), // proven but unregistered at END_EPOCH
    ]);
    const inputs = fakeInputs({
      [KEY_A]: { weight: 100n, registered: true },
      [KEY_B]: { weight: 50n, registered: false },
    });

    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), [rA, rA2, rC, rD]),
      TIP,
    );

    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;
    const role3 = artifact.tally.perRole.find((r) => r.role === 3)!;
    // Only A counted, via its LATER response (option "no").
    expect(role3.responders).toEqual([
      {
        credential: KEY_A,
        weight: "100",
        txHash: rA2.txHash,
        responseIndex: rA2.responseIndex,
      },
    ]);
    expect(role3.questions[0]).toMatchObject({ optionWeights: ["0", "100"] });
  });

  it("postpones emission while any counted-candidate verdict or block index is pending (finding 1)", async () => {
    const store = memBackendStore();
    const rC = response("44".repeat(32), keyCred("c3".repeat(28)), 0);
    await seed(store, [
      validatedRow(rA),
      validatedRow(rC, { proofOk: null }), // verdict not in yet → postpone
    ]);
    const inputs = fakeInputs({
      [KEY_A]: { weight: 100n, registered: true },
      [credentialKey(rC.response.credential)]: { weight: 7n, registered: true },
    });
    const recs = records(survey(), [rA, rC]);

    await finalizeClosedSurveys(CONFIG, store, inputs, noProofs, recs, TIP);
    // Artifact must NOT be emitted: rC could still resolve to counted, and an
    // immutable artifact would freeze it out forever.
    expect(store.artifacts.size).toBe(0);

    // A null block index on an otherwise-proven row also postpones.
    await store.upsertValidatedResponses([
      validatedRow(rC, { proofOk: true, blockIndex: null }),
    ]);
    await finalizeClosedSurveys(CONFIG, store, inputs, noProofs, recs, TIP);
    expect(store.artifacts.size).toBe(0);

    // Both verdict and block index final → the survey finalizes, rC included.
    await store.upsertValidatedResponses([
      validatedRow(rC, { proofOk: true, blockIndex: 0 }),
    ]);
    await finalizeClosedSurveys(CONFIG, store, inputs, noProofs, recs, TIP);
    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;
    const role3 = artifact.tally.perRole.find((r) => r.role === 3)!;
    expect(role3.responders.map((r) => r.credential).sort()).toEqual(
      [KEY_A, credentialKey(rC.response.credential)].sort(),
    );
  });

  it("skips all finalization when the snapshot is incomplete (finding 3)", async () => {
    const store = memBackendStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });

    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      { ...records(survey(), [rA]), incomplete: true },
      TIP,
    );
    expect(store.artifacts.size).toBe(0);
    expect(store.weights.size).toBe(0); // no weight work either
    expect(inputs.stakeholderCalls).toBe(0);
  });

  it("postpones a survey whose counted response fell out of the snapshot (finding 3)", async () => {
    const store = memBackendStore();
    await seed(store, [validatedRow(rA)]); // validated earlier…
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });

    // …but the response tx is no longer in the snapshot's records.
    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), []),
      TIP,
    );
    expect(store.artifacts.size).toBe(0);

    // It finalizes once the response is back in the snapshot.
    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), [rA]),
      TIP,
    );
    expect(store.artifacts.size).toBe(1);
  });

  it("leaves still-open or too-recent surveys alone", async () => {
    const store = memBackendStore();
    await seed(store, [validatedRow(rA)]);
    const openTip: ChainTip = { ...TIP, epoch: END_EPOCH }; // not yet past
    await finalizeClosedSurveys(
      CONFIG,
      store,
      fakeInputs({}),
      noProofs,
      records(survey(), [rA]),
      openTip,
    );
    expect(store.artifacts.size).toBe(0);
    expect(store.weights.size).toBe(0);
  });
});
