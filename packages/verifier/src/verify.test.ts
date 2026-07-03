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

import { verifyArtifact, type VerifyInputs } from "./verify";

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
): ResponseRecord {
  return {
    txHash,
    slot,
    epochNo: 499,
    responseIndex: 0,
    response: {
      specVersion: 4,
      surveyRef: { txId: hexToBytes(SURVEY_TX), index: 0 },
      role: Role.Stakeholder,
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
      response: R_A.response,
    },
    {
      credentialKey: credentialKey(CRED_B),
      weight: 7n,
      txHash: R_B.txHash,
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

describe("verifyArtifact", () => {
  it("MATCHes a correctly emitted artifact", async () => {
    const result = await verifyArtifact(inputs());
    expect(result.notes).toEqual([]);
    expect(result.diffs).toEqual([]);
    expect(result.match).toBe(true);
    expect(result.rebuiltHash).toBe(result.receivedHash);
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
