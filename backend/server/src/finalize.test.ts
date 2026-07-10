import { describe, expect, it, vi } from "vitest";

import {
  Role,
  type AnswerItem,
  type Credential,
  type SurveyDefinition,
} from "cip-179";
import {
  credentialKey,
  hexToBytes,
  type CancellationRecord,
  type ChainTip,
  type Cip179Records,
  type ResponseRecord,
  type SurveyRecord,
  type TxProof,
} from "cip-179/domain";
import {
  artifactHash,
  responderAnswers,
  type TallyArtifact,
  type TallyBody,
  type TallyInputSource,
  type WeightInfo,
} from "cip-179/tally";

import { loadConfig } from "./config";
import { finalizeClosedSurveys } from "./finalize";
import type { SealedRevealFn } from "./sealedReveal";
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
    specVersion: 5,
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
      specVersion: 5,
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

const QUICKNET_CHAIN_HASH_HEX =
  "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

/** A sealed submission mode on quicknet whose round has already published. */
const SEALED_MODE = {
  type: "sealed" as const,
  chainHash: hexToBytes(QUICKNET_CHAIN_HASH_HEX),
  round: 100, // publishes ~2023 (genesis + 99·3s) — available under the real clock
  paddingSize: 64,
};

/** A sealed response record; the dummy ciphertext is decrypted by the stub reveal. */
function sealedResponse(
  txHash: string,
  cred: Credential,
  slot = 200,
  role: Role = Role.Stakeholder,
): ResponseRecord {
  return {
    txHash,
    slot,
    epochNo: 499,
    responseIndex: 0,
    response: {
      specVersion: 5,
      surveyRef: { txId: hexToBytes(SURVEY_TX), index: 0 },
      role,
      credential: cred,
      answers: { type: "sealed", ciphertext: hexToBytes("ab".repeat(16)) },
    },
  };
}

/**
 * A stub {@link SealedRevealFn} (no crypto/network): decrypts each record to the
 * answers keyed by its txHash — `null` = undecryptable (reveal returns null).
 */
function stubReveal(answersByTx: Record<string, AnswerItem[] | null>) {
  const fn: SealedRevealFn = async (recs, { round }) => ({
    revealed: recs.map((r) => {
      const a = answersByTx[r.txHash];
      return a == null
        ? null
        : { ...r.response, answers: { type: "public" as const, answers: a } };
    }),
    beacon: { round, randomness: "be".repeat(16), signature: "51".repeat(48) },
  });
  return vi.fn(fn);
}

/** The one-answer singleChoice reply used by the sealed tests ("no" = option 1). */
const SEALED_ANSWER: AnswerItem[] = [
  { type: "singleChoice", questionIndex: 0, optionIndex: 1 },
];

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

  it("fetches the shared-credential union once across same-epoch surveys (§6.5)", async () => {
    const store = memBackendStore();
    const SURVEY_TX2 = "dd".repeat(32);
    const SURVEY_KEY2 = `${SURVEY_TX2}:0`;
    const s2: SurveyRecord = {
      txHash: SURVEY_TX2,
      slot: 100,
      epochNo: 495,
      ref: { txId: hexToBytes(SURVEY_TX2), index: 0 },
      definition: definition(), // same end epoch
    };
    const CRED_C = keyCred("c3".repeat(28));
    const KEY_C = credentialKey(CRED_C);
    // survey 1 ← {A, B}; survey 2 ← {A, C} — A responds to both.
    const rA1 = response("11".repeat(32), CRED_A, 0);
    const rB1 = response("22".repeat(32), CRED_B, 0);
    const rA2 = response("33".repeat(32), CRED_A, 0);
    const rC2 = response("44".repeat(32), CRED_C, 0);
    await seed(store, [
      validatedRow(rA1),
      validatedRow(rB1),
      validatedRow(rA2, { surveyKey: SURVEY_KEY2 }),
      validatedRow(rC2, { surveyKey: SURVEY_KEY2 }),
    ]);

    const seen: string[][] = [];
    const inputs: TallyInputSource = {
      async stakeholderWeights(_e, creds) {
        seen.push(creds.map(credentialKey));
        return new Map(
          creds.map((c) => [
            credentialKey(c),
            { weight: 1n, registered: true } as WeightInfo,
          ]),
        );
      },
      async drepWeights() {
        return new Map();
      },
      async stakeholderTotal() {
        return 1_000n;
      },
      async drepTotal() {
        return 2_000n;
      },
    };
    const recs: Cip179Records = {
      surveys: [survey(), s2],
      responses: [rA1, rB1, rA2, rC2],
      cancellations: [],
    };

    await finalizeClosedSurveys(CONFIG, store, inputs, noProofs, recs, TIP);
    // A single stakeholder fetch for the whole epoch — the union {A,B,C}, with
    // the shared A requested once, not once per survey.
    expect(seen).toHaveLength(1);
    expect([...seen[0]!].sort()).toEqual([KEY_A, KEY_B, KEY_C].sort());
    expect(store.artifacts.size).toBe(2); // both surveys emitted
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

  it("persists weights per credential so a mid-role failure resumes (finding 5)", async () => {
    const store = memBackendStore();
    const dA = response("11".repeat(32), CRED_A, 0, 200, Role.DRep);
    const dB = response("22".repeat(32), CRED_B, 1, 200, Role.DRep);
    await seed(store, [validatedRow(dA), validatedRow(dB)]);

    let failB = true;
    const inputs: TallyInputSource = {
      async stakeholderWeights() {
        return new Map();
      },
      async drepWeights(_e, creds) {
        const m = new Map<string, WeightInfo>();
        for (const c of creds) {
          const k = credentialKey(c);
          if (k === KEY_B && failB) throw new Error("koios boom mid-role");
          m.set(k, { weight: 10n, registered: true });
        }
        return m;
      },
      async stakeholderTotal() {
        return 1_000n;
      },
      async drepTotal() {
        return 2_000n;
      },
    };
    const recs = records(survey(), [dA, dB]);

    // First run dies fetching B; A's weight is already persisted (resume cursor).
    await expect(
      finalizeClosedSurveys(CONFIG, store, inputs, noProofs, recs, TIP),
    ).rejects.toThrow(/mid-role/);
    expect(store.weights.size).toBe(1);
    expect([...store.weights.values()][0]!.credential).toBe(KEY_A);
    expect(store.artifacts.size).toBe(0);

    // Next cron: B now resolves, A comes from the cursor → artifact emitted.
    failB = false;
    await finalizeClosedSurveys(CONFIG, store, inputs, noProofs, recs, TIP);
    expect(store.weights.size).toBe(2);
    expect(store.artifacts.size).toBe(1);
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

  it("emits a sealed artifact with revealed answers and a provenance beacon", async () => {
    const store = memBackendStore();
    const rSealed = sealedResponse("11".repeat(32), CRED_A);
    await seed(store, [validatedRow(rSealed)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 100n, registered: true } });
    const reveal = stubReveal({ [rSealed.txHash]: SEALED_ANSWER });

    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(definition({ submissionMode: SEALED_MODE })), [rSealed]),
      TIP,
      reveal,
    );

    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;
    expect(artifact.tally.sealed).toBe(true);
    expect(artifactHash(artifact.tally as TallyBody)).toBe(
      store.artifacts.get(SURVEY_KEY)!.artifactHash,
    );
    const role3 = artifact.tally.perRole.find((r) => r.role === 3)!;
    expect(role3.responders).toHaveLength(1);
    // The revealed answers are committed in the artifact (the sealed-artifact rule).
    expect(responderAnswers(role3.responders[0]!)).toEqual(SEALED_ANSWER);
    // And they drove the tally: option 1 ("no") carries A's weight.
    expect(role3.questions[0]).toMatchObject({ optionWeights: ["0", "100"] });
    // The beacon is recorded in (unhashed) provenance for offline audit.
    expect(artifact.provenance.sealedReveal).toEqual({
      chainHash: QUICKNET_CHAIN_HASH_HEX,
      round: SEALED_MODE.round,
      beacon: {
        round: SEALED_MODE.round,
        randomness: "be".repeat(16),
        signature: "51".repeat(48),
      },
    });
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("dedups sealed responses AFTER reveal: a later undecryptable ballot never supersedes an earlier valid one (finding 2)", async () => {
    const store = memBackendStore();
    const early = sealedResponse("11".repeat(32), CRED_A, 200);
    const late = sealedResponse("33".repeat(32), CRED_A, 250); // later in chain
    await seed(store, [validatedRow(early), validatedRow(late)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 100n, registered: true } });
    // The later ballot fails to decrypt; on-chain dedup would have let it
    // suppress the earlier valid one, disenfranchising A.
    const reveal = stubReveal({
      [early.txHash]: SEALED_ANSWER,
      [late.txHash]: null,
    });

    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(definition({ submissionMode: SEALED_MODE })), [
        early,
        late,
      ]),
      TIP,
      reveal,
    );

    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;
    const role3 = artifact.tally.perRole.find((r) => r.role === 3)!;
    expect(role3.responders).toHaveLength(1);
    // The earlier VALID response is the one counted — not the later null.
    expect(role3.responders[0]!.txHash).toBe(early.txHash);
    expect(role3.questions[0]).toMatchObject({ optionWeights: ["0", "100"] });
  });

  it("postpones a sealed reveal while the round is unavailable (weights frozen, reveal not called)", async () => {
    const store = memBackendStore();
    const rSealed = sealedResponse("11".repeat(32), CRED_A);
    await seed(store, [validatedRow(rSealed)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const reveal = stubReveal({ [rSealed.txHash]: SEALED_ANSWER });

    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(
        survey(
          definition({
            submissionMode: { ...SEALED_MODE, round: 999_999_999 },
          }),
        ),
        [rSealed],
      ),
      TIP,
      reveal,
    );

    expect(store.weights.size).toBe(1); // frozen this pass
    expect(store.artifacts.size).toBe(0); // no artifact until the round publishes
    expect(reveal).not.toHaveBeenCalled();
  });

  it("postpones (does not escape) when the reveal throws", async () => {
    const store = memBackendStore();
    const rSealed = sealedResponse("11".repeat(32), CRED_A);
    await seed(store, [validatedRow(rSealed)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const throwingReveal: SealedRevealFn = async () => {
      throw new Error("beacon fetch failed");
    };
    const reveal = vi.fn(throwingReveal);

    // Must resolve, not reject — one bad reveal can't abort the whole pass.
    await expect(
      finalizeClosedSurveys(
        CONFIG,
        store,
        inputs,
        noProofs,
        records(survey(definition({ submissionMode: SEALED_MODE })), [rSealed]),
        TIP,
        reveal,
      ),
    ).resolves.toBeUndefined();

    expect(reveal).toHaveBeenCalledTimes(1);
    expect(store.artifacts.size).toBe(0); // retried next refresh
  });

  it("skips a sealed survey on an unsupported (non-quicknet) chain — no reveal, no weight work", async () => {
    const store = memBackendStore();
    const rSealed = sealedResponse("11".repeat(32), CRED_A);
    await seed(store, [validatedRow(rSealed)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const reveal = stubReveal({ [rSealed.txHash]: SEALED_ANSWER });

    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(
        survey(
          definition({
            submissionMode: { ...SEALED_MODE, chainHash: new Uint8Array(32) },
          }),
        ),
        [rSealed],
      ),
      TIP,
      reveal,
    );

    expect(store.artifacts.size).toBe(0);
    expect(store.weights.size).toBe(0); // excluded before any weight work
    expect(inputs.stakeholderCalls).toBe(0);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("marks a sealed survey's cancellation artifact as sealed", async () => {
    const store = memBackendStore();
    const rSealed = sealedResponse("11".repeat(32), CRED_A);
    await seed(store, [validatedRow(rSealed)]);
    const cancellation: CancellationRecord = {
      txHash: "cc".repeat(32),
      slot: 300,
      epochNo: 499,
      target: { txId: hexToBytes(SURVEY_TX), index: 0 },
      proof: null,
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
    const reveal = stubReveal({ [rSealed.txHash]: SEALED_ANSWER });

    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      proofs,
      records(
        survey(definition({ submissionMode: SEALED_MODE })),
        [rSealed],
        [cancellation],
      ),
      TIP,
      reveal,
    );

    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;
    expect(artifact.tally.sealed).toBe(true);
    expect(artifact.tally.cancelled).toMatchObject({
      txHash: cancellation.txHash,
    });
    expect(artifact.tally.perRole).toEqual([]);
    expect(reveal).not.toHaveBeenCalled(); // cancelled → no reveal
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

  it("prunes a counted response that fell out of the snapshot, then finalizes (finding 3)", async () => {
    const store = memBackendStore();
    await seed(store, [validatedRow(rA)]); // validated earlier…
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });

    // …but the response tx is no longer in the (complete) snapshot: it was
    // reorged out and, with a fixed scan floor, can never age back in. This
    // refresh prunes the stale row and postpones (the one-refresh reorg buffer);
    // it must NOT postpone forever the way it once did.
    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), []),
      TIP,
    );
    expect(store.artifacts.size).toBe(0);
    expect(store.validated.has("11".repeat(32) + ":0")).toBe(false); // pruned

    // The tx stays gone. Because the stale row was pruned, the survey now
    // finalizes (no longer blocked by the vanished response) instead of
    // livelocking on it.
    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), []),
      TIP,
    );
    expect(store.artifacts.size).toBe(1);
  });

  it("re-counts a reorged-out response if it returns before the next finalize (finding 3)", async () => {
    const store = memBackendStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });

    // Refresh 1: absent → pruned, postponed.
    await finalizeClosedSurveys(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), []),
      TIP,
    );
    expect(store.artifacts.size).toBe(0);

    // The tx re-appears in the next scan, so validation re-runs and re-writes
    // the row (modelled here by re-seeding). Finalization then counts it.
    await seed(store, [validatedRow(rA)]);
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
