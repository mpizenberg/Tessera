import { describe, expect, it } from "vitest";

import { Role, type Credential, type SurveyDefinition } from "cip-179";
import {
  artifactHash,
  credentialKey,
  hexToBytes,
  rulesetHash,
  toArtifactQuestions,
  toArtifactResponders,
  weightedTallySurvey,
  type SurveyBundle,
  type TallyArtifact,
  type TallyBody,
  type TallyInputSource,
  type TxProof,
  type WeightInfo,
  type ResponseRecord,
} from "@tessera/core";

import { diffResponseSets, verifyArtifact, type VerifyInputs } from "./verify";

// --- fixtures ------------------------------------------------------------------

const SURVEY_TX = "aa".repeat(32);
const END_EPOCH = 500;

const keyCred = (hex: string): Credential => ({
  type: "key",
  keyHash: hexToBytes(hex),
});
const CRED_A = keyCred("a1".repeat(28));
const CRED_B = keyCred("b2".repeat(28));

const DEF: SurveyDefinition = {
  specVersion: 4,
  owner: keyCred("0f".repeat(28)),
  title: "t",
  description: "",
  eligibleRoles: [Role.Stakeholder] as Role[],
  endEpoch: END_EPOCH,
  submissionMode: { type: "public" },
  questions: [
    {
      type: "singleChoice",
      prompt: "",
      options: { type: "options", labels: ["yes", "no"] },
    },
  ],
};

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

const R_A = response("11".repeat(32), CRED_A, 0);
const R_B = response("22".repeat(32), CRED_B, 1);

const bundle: SurveyBundle = {
  survey: {
    txHash: SURVEY_TX,
    slot: 100,
    epochNo: 495,
    ref: { txId: hexToBytes(SURVEY_TX), index: 0 },
    definition: DEF,
  },
  responses: [R_A, R_B],
  cancellations: [],
  tip: {
    epoch: 502,
    slot: 1,
    time: 1,
    epochSlot: 0,
    govActionLifetime: 6,
  },
};

const WEIGHTS: Record<string, WeightInfo> = {
  [credentialKey(CRED_A)]: { weight: 100n, registered: true },
  [credentialKey(CRED_B)]: { weight: 7n, registered: true },
};

const weights: TallyInputSource = {
  async stakeholderWeights(_e, creds) {
    return new Map(
      creds.map((c) => [
        credentialKey(c),
        WEIGHTS[credentialKey(c)] ?? { weight: 0n, registered: false },
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
    return null;
  },
};

/** Signed by each response credential — mechanism A proof per tx. */
const proofs = new Map<string, TxProof | null>([
  [
    R_A.txHash,
    {
      requiredSigners: ["a1".repeat(28)],
      nativeScripts: [],
      votes: [],
    },
  ],
  [
    R_B.txHash,
    {
      requiredSigners: ["b2".repeat(28)],
      nativeScripts: [],
      votes: [],
    },
  ],
]);

/** The artifact a correct emitter produces for this bundle. */
function emittedArtifact(): TallyArtifact {
  const responders = [
    {
      credentialKey: credentialKey(CRED_A),
      weight: 100n,
      txHash: R_A.txHash,
      responseIndex: R_A.responseIndex,
      response: R_A.response,
    },
    {
      credentialKey: credentialKey(CRED_B),
      weight: 7n,
      txHash: R_B.txHash,
      responseIndex: R_B.responseIndex,
      response: R_B.response,
    },
  ];
  const tally: TallyBody = {
    rulesetHash: rulesetHash(),
    network: "preview",
    survey: { txId: SURVEY_TX, index: 0, endEpoch: END_EPOCH },
    sealed: false,
    perRole: [
      {
        role: Role.Stakeholder,
        total: "1000",
        responders: toArtifactResponders(responders),
        questions: toArtifactQuestions(weightedTallySurvey(DEF, responders)),
      },
    ],
  };
  return {
    tally,
    provenance: {
      source: { provider: "koios", baseUrl: "x" },
      fetchedAt: 1,
      byRole: [{ role: 3, endpoint: "account_stake_history" }],
    },
  };
}

function inputs(overrides: Partial<VerifyInputs> = {}): VerifyInputs {
  return {
    bundle,
    artifact: emittedArtifact(),
    network: "preview",
    linkedActionId: null,
    blockIndices: new Map([
      [R_A.txHash, 0],
      [R_B.txHash, 1],
    ]),
    proofs,
    weights,
    ...overrides,
  };
}

// --- tests -----------------------------------------------------------------------

describe("diffResponseSets", () => {
  const r = (txHash: string, responseIndex = 0) => ({ txHash, responseIndex });

  it("is silent when the backend bundle matches the chain scan", () => {
    const set = [r("a"), r("b", 1)];
    expect(diffResponseSets(set, [...set].reverse())).toEqual([]);
  });

  it("flags a response the backend omitted from what the chain has (finding 1)", () => {
    const chain = [r("a"), r("b")];
    const backend = [r("a")];
    const notes = diffResponseSets(chain, backend);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("OMITS");
    expect(notes[0]).toContain("b:0");
  });

  it("flags a response the backend has but the chain scan does not", () => {
    const notes = diffResponseSets([r("a")], [r("a"), r("ghost")]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("not seen in the chain scan");
    expect(notes[0]).toContain("ghost:0");
  });
});

describe("verifyArtifact", () => {
  it("MATCHes a correctly emitted artifact", async () => {
    const result = await verifyArtifact(inputs());
    expect(result.notes).toEqual([]);
    expect(result.diffs).toEqual([]);
    expect(result.match).toBe(true);
    expect(result.rebuiltHash).toBe(result.receivedHash);
    // Public regression: a public survey still rebuilds as sealed:false.
    expect(result.rebuilt.sealed).toBe(false);
  });

  it("MISMATCHes a tampered aggregate, naming the difference", async () => {
    const artifact = emittedArtifact();
    const role = artifact.tally.perRole[0]!;
    const tampered: TallyArtifact = {
      ...artifact,
      tally: {
        ...artifact.tally,
        perRole: [
          {
            ...role,
            // Flip one weight: claims A voted with 999 instead of 100.
            responders: role.responders.map((r) =>
              r.credential === credentialKey(CRED_A)
                ? { ...r, weight: "999" }
                : r,
            ),
          },
        ],
      },
    };
    const result = await verifyArtifact(inputs({ artifact: tampered }));
    expect(result.match).toBe(false);
    expect(result.diffs.join("\n")).toContain("weight 999→100");
  });

  it("MISMATCHes when the backend counted an unproven response", async () => {
    // B's tx no longer proves its credential — a correct rebuild drops it.
    const weakProofs = new Map(proofs);
    weakProofs.set(R_B.txHash, {
      requiredSigners: [],
      nativeScripts: [],
      votes: [],
    });
    const result = await verifyArtifact(inputs({ proofs: weakProofs }));
    expect(result.match).toBe(false);
    expect(result.diffs.join("\n")).toContain("counted only in received");
  });

  it("verifies a cancellation artifact from the cancellation evidence", async () => {
    const cancellation = {
      txHash: "cc".repeat(32),
      slot: 300,
      epochNo: 499,
      target: { txId: hexToBytes(SURVEY_TX), index: 0 },
      proof: null,
    };
    const cancelledBundle: SurveyBundle = {
      ...bundle,
      cancellations: [cancellation],
    };
    const proofsWithCancel = new Map(proofs);
    proofsWithCancel.set(cancellation.txHash, {
      requiredSigners: ["0f".repeat(28)], // the owner
      nativeScripts: [],
      votes: [],
    });
    const tally: TallyBody = {
      rulesetHash: rulesetHash(),
      network: "preview",
      survey: { txId: SURVEY_TX, index: 0, endEpoch: END_EPOCH },
      sealed: false,
      cancelled: { txHash: cancellation.txHash, slot: 300, epoch: 499 },
      perRole: [],
    };
    const artifact: TallyArtifact = {
      tally,
      provenance: {
        source: { provider: "koios", baseUrl: "x" },
        fetchedAt: 1,
        byRole: [],
      },
    };
    const result = await verifyArtifact(
      inputs({ bundle: cancelledBundle, proofs: proofsWithCancel, artifact }),
    );
    expect(result.match).toBe(true);
    expect(artifactHash(tally)).toBe(result.rebuiltHash);
  });

  it("breaks a same-slot dedup tie by block index (finding 12)", async () => {
    // A responds twice in the same slot; the later-in-chain one (higher block
    // index) wins. rA2 has the higher index, so a correct artifact counts it.
    const rA1 = response("11".repeat(32), CRED_A, 0, 200); // "yes"
    const rA2 = response("33".repeat(32), CRED_A, 1, 200); // "no", same slot
    const tieBundle: SurveyBundle = { ...bundle, responses: [rA1, rA2] };
    const tieProofs = new Map<string, TxProof | null>([
      [
        rA1.txHash,
        { requiredSigners: ["a1".repeat(28)], nativeScripts: [], votes: [] },
      ],
      [
        rA2.txHash,
        { requiredSigners: ["a1".repeat(28)], nativeScripts: [], votes: [] },
      ],
    ]);
    const responders = [
      {
        credentialKey: credentialKey(CRED_A),
        weight: 100n,
        txHash: rA2.txHash,
        responseIndex: rA2.responseIndex,
        response: rA2.response,
      },
    ];
    const tally: TallyBody = {
      rulesetHash: rulesetHash(),
      network: "preview",
      survey: { txId: SURVEY_TX, index: 0, endEpoch: END_EPOCH },
      sealed: false,
      perRole: [
        {
          role: Role.Stakeholder,
          total: "1000",
          responders: toArtifactResponders(responders),
          questions: toArtifactQuestions(weightedTallySurvey(DEF, responders)),
        },
      ],
    };
    const artifact: TallyArtifact = {
      tally,
      provenance: {
        source: { provider: "koios", baseUrl: "x" },
        fetchedAt: 1,
        byRole: [{ role: 3, endpoint: "account_stake_history" }],
      },
    };

    // rA2 later in chain → matches.
    const ok = await verifyArtifact(
      inputs({
        bundle: tieBundle,
        proofs: tieProofs,
        blockIndices: new Map([
          [rA1.txHash, 0],
          [rA2.txHash, 1],
        ]),
        artifact,
      }),
    );
    expect(ok.match).toBe(true);

    // Flip the ordering → the tie resolves to rA1 ("yes") instead, so the same
    // artifact must MISMATCH. This is exactly the divergence finding 1 warns of.
    const bad = await verifyArtifact(
      inputs({
        bundle: tieBundle,
        proofs: tieProofs,
        blockIndices: new Map([
          [rA1.txHash, 1],
          [rA2.txHash, 0],
        ]),
        artifact,
      }),
    );
    expect(bad.match).toBe(false);
  });

  it("falls back to the artifact's total (with a note) when unfetchable", async () => {
    const flakyWeights: TallyInputSource = {
      ...weights,
      async stakeholderTotal() {
        return null;
      },
    };
    const result = await verifyArtifact(inputs({ weights: flakyWeights }));
    expect(result.match).toBe(true); // everything else re-verified
    expect(result.notes.join("\n")).toContain("not independently re-fetchable");
  });
});

// --- Sealed surveys: reveal with an independently fetched beacon -------------
//
// A sealed artifact commits each responder's REVEALED answers; the verifier
// rebuilds them by decrypting the on-chain ciphertexts with its own beacon
// (stubbed here — no crypto). MATCH means the committed answers reproduce; a
// tampered answer MISMATCHes even when weight/tx are untouched.

describe("verifyArtifact — sealed survey", () => {
  const QUICKNET_HEX =
    "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
  const DEF_SEALED: SurveyDefinition = {
    ...DEF,
    submissionMode: {
      type: "sealed",
      chainHash: hexToBytes(QUICKNET_HEX),
      round: 100,
      paddingSize: 64,
    },
  };

  /** A sealed response record (opaque ciphertext; the stub reveal decrypts it). */
  function sealedRecord(txHash: string, cred: Credential): ResponseRecord {
    return {
      txHash,
      slot: 200,
      epochNo: 499,
      responseIndex: 0,
      response: {
        specVersion: 4,
        surveyRef: { txId: hexToBytes(SURVEY_TX), index: 0 },
        role: Role.Stakeholder,
        credential: cred,
        answers: { type: "sealed", ciphertext: hexToBytes("ab".repeat(16)) },
      },
    };
  }
  const publicAnswers = (optionIndex: number) => ({
    type: "public" as const,
    answers: [{ type: "singleChoice" as const, questionIndex: 0, optionIndex }],
  });

  const sA = sealedRecord("77".repeat(32), CRED_A);
  const sB = sealedRecord("88".repeat(32), CRED_B);
  const revealed = new Map([
    [sA.txHash, { ...sA.response, answers: publicAnswers(0) }],
    [sB.txHash, { ...sB.response, answers: publicAnswers(1) }],
  ]);
  const reveal: VerifyInputs["reveal"] = async (records) =>
    records.map((r) => revealed.get(r.txHash) ?? null);

  const sealedBundle: SurveyBundle = {
    ...bundle,
    survey: { ...bundle.survey, definition: DEF_SEALED },
    responses: [sA, sB],
  };
  const sealedProofs = new Map<string, TxProof | null>([
    [
      sA.txHash,
      { requiredSigners: ["a1".repeat(28)], nativeScripts: [], votes: [] },
    ],
    [
      sB.txHash,
      { requiredSigners: ["b2".repeat(28)], nativeScripts: [], votes: [] },
    ],
  ]);
  const sealedBlockIndices = new Map([
    [sA.txHash, 0],
    [sB.txHash, 1],
  ]);

  // The artifact a correct emitter produces: responders carry the REVEALED
  // (public) responses and commit their answers.
  const sealedResponders = [
    {
      credentialKey: credentialKey(CRED_A),
      weight: 100n,
      txHash: sA.txHash,
      responseIndex: 0,
      response: revealed.get(sA.txHash)!,
    },
    {
      credentialKey: credentialKey(CRED_B),
      weight: 7n,
      txHash: sB.txHash,
      responseIndex: 0,
      response: revealed.get(sB.txHash)!,
    },
  ];
  function sealedArtifact(): TallyArtifact {
    return {
      tally: {
        rulesetHash: rulesetHash(),
        network: "preview",
        survey: { txId: SURVEY_TX, index: 0, endEpoch: END_EPOCH },
        sealed: true,
        perRole: [
          {
            role: Role.Stakeholder,
            total: "1000",
            responders: toArtifactResponders(sealedResponders, {
              revealedAnswers: true,
            }),
            questions: toArtifactQuestions(
              weightedTallySurvey(DEF_SEALED, sealedResponders),
            ),
          },
        ],
      },
      provenance: {
        source: { provider: "koios", baseUrl: "x" },
        fetchedAt: 1,
        byRole: [{ role: 3, endpoint: "account_stake_history" }],
        sealedReveal: {
          chainHash: QUICKNET_HEX,
          round: 100,
          beacon: {
            round: 100,
            randomness: "be".repeat(16),
            signature: "51".repeat(48),
          },
        },
      },
    };
  }
  const sealedInputs = (overrides: Partial<VerifyInputs> = {}): VerifyInputs =>
    inputs({
      bundle: sealedBundle,
      proofs: sealedProofs,
      blockIndices: sealedBlockIndices,
      artifact: sealedArtifact(),
      reveal,
      ...overrides,
    });

  it("MATCHes a sealed artifact by revealing with the stubbed beacon", async () => {
    const result = await verifyArtifact(sealedInputs());
    expect(result.notes).toEqual([]);
    expect(result.diffs).toEqual([]);
    expect(result.match).toBe(true);
    expect(result.rebuilt.sealed).toBe(true);
  });

  it("MISMATCHes a tampered committed answer even when weight and tx match", async () => {
    const artifact = sealedArtifact();
    const role = artifact.tally.perRole[0]!;
    const tampered: TallyArtifact = {
      ...artifact,
      tally: {
        ...artifact.tally,
        perRole: [
          {
            ...role,
            responders: role.responders.map((r) =>
              r.credential === credentialKey(CRED_A)
                ? // Claim A answered option 1 ("no") — but the ciphertext reveals 0.
                  {
                    ...r,
                    answers: toArtifactResponders(
                      [
                        {
                          ...sealedResponders[0]!,
                          response: revealed.get(sB.txHash)!,
                        },
                      ],
                      { revealedAnswers: true },
                    )[0]!.answers,
                  }
                : r,
            ),
          },
        ],
      },
    };
    const result = await verifyArtifact(sealedInputs({ artifact: tampered }));
    expect(result.match).toBe(false);
    expect(result.diffs.join("\n")).toContain("committed answers differ");
  });

  it("throws when a sealed artifact is verified without a reveal function", async () => {
    const { reveal: _omit, ...noReveal } = sealedInputs();
    await expect(verifyArtifact(noReveal)).rejects.toThrow(/reveal/);
  });
});

// --- Keyholder: the count-only weight path (finding 12) ----------------------
//
// Keyholders have no on-chain electorate: no fetched weight (constant 1), no
// registration/membership filter, no electorate total (null). Both the emitter
// (finalize.ts) and this rebuild implement that fork independently and must
// agree byte-for-byte — these tests pin the rebuild's side of the contract.

describe("verifyArtifact — Keyholder role", () => {
  const DEF_KH: SurveyDefinition = {
    ...DEF,
    eligibleRoles: [Role.Keyholder] as Role[],
  };
  const K_A = response("44".repeat(32), CRED_A, 0, 200, Role.Keyholder);
  const K_B = response("55".repeat(32), CRED_B, 1, 200, Role.Keyholder);
  const khBundle: SurveyBundle = {
    ...bundle,
    survey: { ...bundle.survey, definition: DEF_KH },
    responses: [K_A, K_B],
  };
  const khProofs = new Map<string, TxProof | null>([
    [
      K_A.txHash,
      { requiredSigners: ["a1".repeat(28)], nativeScripts: [], votes: [] },
    ],
    [
      K_B.txHash,
      { requiredSigners: ["b2".repeat(28)], nativeScripts: [], votes: [] },
    ],
  ]);
  // If the rebuild consults ANY weight endpoint for a keyholder-only survey,
  // that's a bug (e.g. a bare key routed through stakeholderWeights would come
  // back unregistered and silently drop every responder) — so every method
  // throws, proving the branch never fetches.
  const noWeights: TallyInputSource = {
    async stakeholderWeights() {
      throw new Error("keyholders must not fetch weights");
    },
    async drepWeights() {
      throw new Error("keyholders must not fetch weights");
    },
    async stakeholderTotal() {
      throw new Error("keyholders have no electorate total");
    },
    async drepTotal() {
      throw new Error("keyholders have no electorate total");
    },
  };

  const khResponders = [
    {
      credentialKey: credentialKey(CRED_A),
      weight: 1n,
      txHash: K_A.txHash,
      responseIndex: K_A.responseIndex,
      response: K_A.response,
    },
    {
      credentialKey: credentialKey(CRED_B),
      weight: 1n,
      txHash: K_B.txHash,
      responseIndex: K_B.responseIndex,
      response: K_B.response,
    },
  ];
  const khArtifact: TallyArtifact = {
    tally: {
      rulesetHash: rulesetHash(),
      network: "preview",
      survey: { txId: SURVEY_TX, index: 0, endEpoch: END_EPOCH },
      sealed: false,
      perRole: [
        {
          role: Role.Keyholder,
          total: null, // no on-chain electorate for keyholders
          responders: toArtifactResponders(khResponders),
          questions: toArtifactQuestions(
            weightedTallySurvey(DEF_KH, khResponders),
          ),
        },
      ],
    },
    provenance: {
      source: { provider: "koios", baseUrl: "x" },
      fetchedAt: 1,
      byRole: [{ role: 4, endpoint: "local-count" }],
    },
  };

  it("MATCHes with weight 1, no membership filter, and a null total — no fetches", async () => {
    const result = await verifyArtifact(
      inputs({
        bundle: khBundle,
        proofs: khProofs,
        weights: noWeights,
        artifact: khArtifact,
      }),
    );
    // No total-fallback note either: a null total is the rule, not a caveat.
    expect(result.notes).toEqual([]);
    expect(result.diffs).toEqual([]);
    expect(result.match).toBe(true);
  });

  it("MISMATCHes a keyholder counted with weight ≠ 1", async () => {
    const role = khArtifact.tally.perRole[0]!;
    const tampered: TallyArtifact = {
      ...khArtifact,
      tally: {
        ...khArtifact.tally,
        perRole: [
          {
            ...role,
            responders: role.responders.map((r) =>
              r.credential === credentialKey(CRED_A)
                ? { ...r, weight: "3" }
                : r,
            ),
          },
        ],
      },
    };
    const result = await verifyArtifact(
      inputs({
        bundle: khBundle,
        proofs: khProofs,
        weights: noWeights,
        artifact: tampered,
      }),
    );
    expect(result.match).toBe(false);
    expect(result.diffs.join("\n")).toContain("weight 3→1");
  });
});

// --- Mechanism B: vote-binding credential proof (finding 12) -----------------
//
// On a governance-linked survey, a tx can prove its credential by voting on the
// linked action with that same credential (voter tag 2 = DRep key). Every test
// above runs with linkedActionId null, so this block pins the three rules:
// a vote alone proves; a failing binding invalidates even when mechanism A
// passes; no link means votes prove nothing.

describe("verifyArtifact — mechanism B (governance vote binding)", () => {
  const ACTION = "gov_action1linked";
  const DEF_DREP: SurveyDefinition = {
    ...DEF,
    eligibleRoles: [Role.DRep] as Role[],
  };
  const D_A = response("66".repeat(32), CRED_A, 0, 200, Role.DRep);
  const drepBundle: SurveyBundle = {
    ...bundle,
    survey: { ...bundle.survey, definition: DEF_DREP },
    responses: [D_A],
  };
  const drepSource: TallyInputSource = {
    async stakeholderWeights() {
      throw new Error("DRep surveys must not fetch stakeholder weights");
    },
    async drepWeights(_e, creds) {
      return new Map(
        creds.map((c) => [
          credentialKey(c),
          { weight: 500n, registered: true },
        ]),
      );
    },
    async stakeholderTotal() {
      throw new Error("DRep surveys must not fetch the stakeholder total");
    },
    async drepTotal() {
      return 10_000n;
    },
  };
  const drepResponders = [
    {
      credentialKey: credentialKey(CRED_A),
      weight: 500n,
      txHash: D_A.txHash,
      responseIndex: D_A.responseIndex,
      response: D_A.response,
    },
  ];
  const drepArtifact: TallyArtifact = {
    tally: {
      rulesetHash: rulesetHash(),
      network: "preview",
      survey: { txId: SURVEY_TX, index: 0, endEpoch: END_EPOCH },
      sealed: false,
      perRole: [
        {
          role: Role.DRep,
          total: "10000",
          responders: toArtifactResponders(drepResponders),
          questions: toArtifactQuestions(
            weightedTallySurvey(DEF_DREP, drepResponders),
          ),
        },
      ],
    },
    provenance: {
      source: { provider: "koios", baseUrl: "x" },
      fetchedAt: 1,
      byRole: [{ role: 0, endpoint: "drep_voting_power_history" }],
    },
  };
  const drepInputs = (overrides: Partial<VerifyInputs>): VerifyInputs =>
    inputs({
      bundle: drepBundle,
      weights: drepSource,
      artifact: drepArtifact,
      linkedActionId: ACTION,
      ...overrides,
    });

  it("MATCHes when the credential is proven only by its vote on the linked action", async () => {
    // No required_signers at all: the vote binding is the sole proof.
    const proofs = new Map<string, TxProof | null>([
      [
        D_A.txHash,
        {
          requiredSigners: [],
          nativeScripts: [],
          votes: [
            {
              voterTag: 2, // DRep key
              credentialHash: "a1".repeat(28),
              actionIds: [ACTION],
            },
          ],
        },
      ],
    ]);
    const result = await verifyArtifact(drepInputs({ proofs }));
    expect(result.notes).toEqual([]);
    expect(result.diffs).toEqual([]);
    expect(result.match).toBe(true);
  });

  it("a failing binding invalidates even when mechanism A passes", async () => {
    // The credential IS in required_signers (mechanism A alone would pass),
    // but it also cast a vote — on the WRONG action. A present-but-failing
    // binding decides alone, so a correct rebuild drops the responder.
    const proofs = new Map<string, TxProof | null>([
      [
        D_A.txHash,
        {
          requiredSigners: ["a1".repeat(28)],
          nativeScripts: [],
          votes: [
            {
              voterTag: 2,
              credentialHash: "a1".repeat(28),
              actionIds: ["gov_action1other"],
            },
          ],
        },
      ],
    ]);
    const result = await verifyArtifact(drepInputs({ proofs }));
    expect(result.match).toBe(false);
    // The dropped responder was the role's only one → the whole role vanishes.
    expect(result.diffs.join("\n")).toContain("present only in received");
  });

  it("falls back to mechanism A when the credential cast no binding", async () => {
    const proofs = new Map<string, TxProof | null>([
      [
        D_A.txHash,
        { requiredSigners: ["a1".repeat(28)], nativeScripts: [], votes: [] },
      ],
    ]);
    const result = await verifyArtifact(drepInputs({ proofs }));
    expect(result.match).toBe(true);
  });

  it("votes prove nothing on a standalone survey (linkedActionId null)", async () => {
    // Same vote-only proof as the MATCH case, but the survey has no linked
    // action — mechanism B doesn't exist, so the response stays unproven and
    // an artifact that counted it must MISMATCH.
    const proofs = new Map<string, TxProof | null>([
      [
        D_A.txHash,
        {
          requiredSigners: [],
          nativeScripts: [],
          votes: [
            {
              voterTag: 2,
              credentialHash: "a1".repeat(28),
              actionIds: [ACTION],
            },
          ],
        },
      ],
    ]);
    const result = await verifyArtifact(
      drepInputs({ proofs, linkedActionId: null }),
    );
    expect(result.match).toBe(false);
    expect(result.diffs.join("\n")).toContain("present only in received");
  });
});
