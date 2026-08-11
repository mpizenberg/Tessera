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
  refKey,
  type CancellationRecord,
  type ChainTip,
  type Cip179Records,
  type GovLink,
  type ResponseRecord,
  type SurveyBundle,
  type SurveyRecord,
  type TxProof,
} from "cip-179/domain";
import { verifyArtifact } from "cardano-tessera-verifier";
import {
  artifactHash,
  responderAnswers,
  type TallyArtifact,
  type TallyBody,
  type TallyInputSource,
  type WeightInfo,
} from "cip-179/tally";

import { loadConfig, type ServerConfig } from "./config";
import { finalizeClosedSurveys } from "./finalize";
import { materializeSnapshot } from "./materialize";
import type { SealedRevealFn } from "./sealedReveal";
import type { ValidatedResponseRow } from "./store";
import { testStore, type TestStore } from "./testing/store";

// --- fixtures ------------------------------------------------------------------

const CONFIG = loadConfig({}); // preview: secondsPerEpoch 86_400

const SURVEY_TX = "aa".repeat(32);
/** A second survey, for the cases that need two in one pass. */
const SURVEY_TX2 = "dd".repeat(32);
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
  surveyTx = SURVEY_TX,
): ResponseRecord {
  return {
    txHash,
    slot,
    epochNo: 499,
    responseIndex: 0,
    response: {
      specVersion: 5,
      surveyRef: { txId: hexToBytes(surveyTx), index: 0 },
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
  surveyTx = SURVEY_TX,
): ResponseRecord {
  return {
    txHash,
    slot,
    epochNo: 499,
    responseIndex: 0,
    response: {
      specVersion: 5,
      surveyRef: { txId: hexToBytes(surveyTx), index: 0 },
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
    surveyKey: refKey(r.response.surveyRef),
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

/**
 * `n` sealed responses for one survey, each from its own credential so none
 * dedups away, numbered from `offset` so two fleets never collide. Returns the
 * records, their validated rows, and a registered weight for every credential —
 * enough to make the survey emit if the pass lets it.
 */
function sealedFleet(n: number, surveyKey = SURVEY_KEY, offset = 0) {
  const recs: ResponseRecord[] = [];
  const rows: ValidatedResponseRow[] = [];
  const weights: Record<string, WeightInfo> = {};
  for (let i = offset; i < offset + n; i++) {
    const cred = keyCred(i.toString(16).padStart(56, "0"));
    const rec = sealedResponse(
      i.toString(16).padStart(64, "0"),
      cred,
      200,
      Role.Stakeholder,
      surveyKey.split(":")[0],
    );
    recs.push(rec);
    rows.push(validatedRow(rec));
    weights[credentialKey(cred)] = { weight: 1n, registered: true };
  }
  return { recs, rows, weights };
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

/**
 * Both stubs answer for the defining transactions too: CIP-179 requires those to
 * prove the survey owner, and finalization postpones a survey whose owner-proof
 * it couldn't read — so without these entries every case would postpone for a
 * reason unrelated to what it tests.
 */
/**
 * A `txProofs` source. Each *defining* transaction proves its owner — CIP-179
 * requires that, and finalization postpones a survey whose owner-proof it can't
 * read, so a case about anything else still needs it — while `entries` answers
 * for the rest (cancelling txs); an unlisted hash reads as a failed fetch.
 */
function proofsStub(
  entries: Record<string, TxProof | null> = {},
  definitionTxs: readonly string[] = [SURVEY_TX, SURVEY_TX2],
) {
  return {
    txProofs: vi.fn(
      async (hashes: readonly string[]) =>
        new Map<string, TxProof | null>(
          hashes.map((h) => [
            h,
            definitionTxs.includes(h) ? OWNER_PROOF : (entries[h] ?? null),
          ]),
        ),
    ),
  };
}

/** No cancellation evidence — the common case. */
const noProofs = proofsStub();

/** Owner-verified evidence: the survey owner's key hash is a required signer. */
const OWNER_PROOF: TxProof = {
  requiredSigners: [OWNER_HASH],
  nativeScripts: [],
  votes: [],
};
/** Fetched + decoded, but the owner isn't among the signers — definitive no. */
const STRANGER_PROOF: TxProof = {
  requiredSigners: ["ff".repeat(28)],
  nativeScripts: [],
  votes: [],
};

/** An in-window cancellation targeting the fixture survey. */
function cancellation(
  txHash: string,
  slot: number,
  epochNo = 499, // ≤ END_EPOCH → in-window
): CancellationRecord {
  return {
    txHash,
    slot,
    epochNo,
    target: { txId: hexToBytes(SURVEY_TX), index: 0 },
    proof: null, // snapshot never verified it (survey was closed)
  };
}

async function seed(store: TestStore, rows: readonly ValidatedResponseRow[]) {
  await store.upsertValidatedResponses(rows);
}

function records(
  s: SurveyRecord,
  responses: ResponseRecord[],
  cancellations: CancellationRecord[] = [],
): Cip179Records {
  return { surveys: [s], responses, cancellations };
}

/**
 * Publish `recs` as materialized rows, then run the pass — the differential
 * harness: identical fixtures to the pre-windowed tests, read back through
 * the store instead of handed over in memory.
 */
async function finalizeRecords(
  config: ServerConfig,
  store: TestStore,
  inputs: TallyInputSource,
  source: Pick<import("cardano-tessera-koios").KoiosDataSource, "txProofs">,
  recs: Cip179Records,
  tip: ChainTip,
  reveal?: SealedRevealFn,
  govLinks: readonly GovLink[] = [],
  // Every epoch settled: the rows' link slices are final, which is the state
  // finalization normally finds a closed survey in.
  settlementFloor = Number.MAX_SAFE_INTEGER,
  finalizationFloor = 0,
) {
  const snapshot = materializeSnapshot(recs, tip, govLinks, new Set());
  await store.reconcileSnapshot(
    snapshot.surveys,
    snapshot.responses,
    snapshot.cancellations,
    { tip: "{}", incomplete: false, fetchedAt: 1, listCounts: null },
  );
  // A caught-up cursor: the covered prefix reaches the wall clock, so the
  // cursor gate reduces to the deadline-plus-margin check.
  return finalizeClosedSurveys(
    config,
    store,
    inputs,
    source,
    {
      tip,
      incomplete: recs.incomplete === true,
      coveredThroughUnix: Number.MAX_SAFE_INTEGER,
      settlementFloor,
      finalizationFloor,
    },
    reveal,
  );
}

// --- tests -----------------------------------------------------------------------

describe("finalizeClosedSurveys", () => {
  const rA = response("11".repeat(32), CRED_A, 0);
  const rB = response("22".repeat(32), CRED_B, 1);

  it("emits a complete weighted artifact (weights, totals, sorted responders)", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA), validatedRow(rB)]);
    const inputs = fakeInputs({
      [KEY_A]: { weight: 100n, registered: true },
      [KEY_B]: { weight: 7n, registered: true },
    });

    const outcome = await finalizeRecords(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), [rA, rB]),
      TIP,
    );
    // The pass's own emission rides back on the returned key sets, so the
    // refresh needs no second tally_artifact read.
    expect(outcome.keys.finalized).toEqual(new Set([SURVEY_KEY]));
    expect(outcome.keys.cancelled).toEqual(new Set());

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
      options: [
        { index: 0, weight: "100" },
        { index: 1, weight: "7" },
      ],
      answeredWeight: "107",
    });
    // Weight rows were snapshotted (the resume cursor).
    expect(store.weights.size).toBe(2);
    expect(artifact.provenance.byRole).toEqual([
      { role: 3, endpoint: "account_stake_history" },
    ]);
  });

  it("fetches the shared-credential union once across same-epoch surveys", async () => {
    const store = testStore();
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
    const rA2 = response(
      "33".repeat(32),
      CRED_A,
      0,
      200,
      Role.Stakeholder,
      SURVEY_TX2,
    );
    const rC2 = response(
      "44".repeat(32),
      CRED_C,
      0,
      200,
      Role.Stakeholder,
      SURVEY_TX2,
    );
    await seed(store, [
      validatedRow(rA1),
      validatedRow(rB1),
      validatedRow(rA2),
      validatedRow(rC2),
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

    await finalizeRecords(CONFIG, store, inputs, noProofs, recs, TIP);
    // A single stakeholder fetch for the whole epoch — the union {A,B,C}, with
    // the shared A requested once, not once per survey.
    expect(seen).toHaveLength(1);
    expect([...seen[0]!].sort()).toEqual([KEY_A, KEY_B, KEY_C].sort());
    expect(store.artifacts.size).toBe(2); // both surveys emitted
  });

  it("isolates a poisoned survey: one failing emission never blocks the others (finding 3)", async () => {
    const store = testStore();
    const SURVEY_KEY2 = `${SURVEY_TX2}:0`;
    const s2: SurveyRecord = {
      txHash: SURVEY_TX2,
      slot: 100,
      epochNo: 495,
      ref: { txId: hexToBytes(SURVEY_TX2), index: 0 },
      definition: definition(),
    };
    const rA1 = response("11".repeat(32), CRED_A, 0);
    const rB2 = response(
      "22".repeat(32),
      CRED_B,
      0,
      200,
      Role.Stakeholder,
      SURVEY_TX2,
    );
    await seed(store, [validatedRow(rA1), validatedRow(rB2)]);
    const inputs = fakeInputs({
      [KEY_A]: { weight: 100n, registered: true },
      [KEY_B]: { weight: 7n, registered: true },
    });
    // Survey 1's artifact write throws (stand-in for any per-survey failure —
    // e.g. a definition whose tally blows up). Without per-survey isolation the
    // throw would abort the whole pass and starve survey 2 forever.
    const poisoned = {
      ...store,
      async putArtifact(row: Parameters<typeof store.putArtifact>[0]) {
        if (row.surveyKey === SURVEY_KEY)
          throw new Error("poisoned survey emission");
        return store.putArtifact(row);
      },
    };
    const recs: Cip179Records = {
      surveys: [survey(), s2],
      responses: [rA1, rB2],
      cancellations: [],
    };

    // The pass completes normally (does not reject) despite survey 1 throwing.
    const outcome = await finalizeRecords(
      CONFIG,
      poisoned,
      inputs,
      noProofs,
      recs,
      TIP,
    );
    expect(outcome.keys.finalized).toEqual(new Set([SURVEY_KEY2]));

    expect(store.artifacts.has(SURVEY_KEY)).toBe(false); // poisoned → skipped
    expect(store.artifacts.has(SURVEY_KEY2)).toBe(true); // healthy → finalized
  });

  it("skips a spec-invalid (untalliable) survey — no artifact — without blocking valid ones (findings 10, 11)", async () => {
    const store = testStore();
    const SURVEY_KEY2 = `${SURVEY_TX2}:0`;
    // Survey 1's on-chain definition declares spec_version 6 — untalliable, so it
    // must produce no artifact (never tallied under v5 semantics).
    const invalid: SurveyRecord = {
      ...survey(),
      definition: definition({ specVersion: 6 }),
    };
    const s2: SurveyRecord = {
      txHash: SURVEY_TX2,
      slot: 100,
      epochNo: 495,
      ref: { txId: hexToBytes(SURVEY_TX2), index: 0 },
      definition: definition(),
    };
    const rA1 = response("11".repeat(32), CRED_A, 0);
    const rB2 = response(
      "22".repeat(32),
      CRED_B,
      0,
      200,
      Role.Stakeholder,
      SURVEY_TX2,
    );
    await seed(store, [validatedRow(rA1), validatedRow(rB2)]);
    const inputs = fakeInputs({
      [KEY_A]: { weight: 100n, registered: true },
      [KEY_B]: { weight: 7n, registered: true },
    });
    const recs: Cip179Records = {
      surveys: [invalid, s2],
      responses: [rA1, rB2],
      cancellations: [],
    };

    const outcome = await finalizeRecords(
      CONFIG,
      store,
      inputs,
      noProofs,
      recs,
      TIP,
    );
    expect(store.artifacts.has(SURVEY_KEY)).toBe(false); // untalliable → no artifact
    expect(store.artifacts.has(SURVEY_KEY2)).toBe(true); // valid → finalized
    // Both are decided — one emitted, one permanently untalliable — so neither
    // holds the frontier down and the residue stops being re-read forever.
    expect(outcome.floor).toBe(TIP.epoch);
  });

  it("buys no evidence for a survey the ruleset already rejects without it", async () => {
    // Such a survey produces no artifact, so nothing ever retires it from the
    // candidate set. Fetching its proof first would re-read its CBOR on every
    // refresh for the life of the deployment — the cost is permanent, and no
    // proof could change the verdict.
    const store = testStore();
    const SURVEY_KEY2 = `${SURVEY_TX2}:0`;
    const invalid: SurveyRecord = {
      ...survey(),
      definition: definition({ specVersion: 6 }),
    };
    const s2: SurveyRecord = {
      txHash: SURVEY_TX2,
      slot: 100,
      epochNo: 495,
      ref: { txId: hexToBytes(SURVEY_TX2), index: 0 },
      definition: definition(),
    };
    const rA1 = response("11".repeat(32), CRED_A, 0);
    const rB2 = response(
      "22".repeat(32),
      CRED_B,
      0,
      200,
      Role.Stakeholder,
      SURVEY_TX2,
    );
    await seed(store, [validatedRow(rA1), validatedRow(rB2)]);
    const inputs = fakeInputs({
      [KEY_A]: { weight: 100n, registered: true },
      [KEY_B]: { weight: 7n, registered: true },
    });
    const source = proofsStub();
    const recs: Cip179Records = {
      surveys: [invalid, s2],
      responses: [rA1, rB2],
      cancellations: [],
    };

    await finalizeRecords(CONFIG, store, inputs, source, recs, TIP);

    const asked = source.txProofs.mock.calls.flatMap(([hashes]) => [...hashes]);
    expect(asked).not.toContain(SURVEY_TX);
    expect(asked).toContain(SURVEY_TX2);
    expect(store.artifacts.has(SURVEY_KEY2)).toBe(true);
  });

  // Finding 12 — CIP-179: "The definition transaction MUST prove ownership of
  // the `owner` credential." Nothing checked it, so a survey could name any
  // credential as owner and be tallied under a borrowed name.
  it("skips a survey whose defining tx never proved the owner — without blocking valid ones", async () => {
    const store = testStore();
    const s2: SurveyRecord = {
      txHash: SURVEY_TX2,
      slot: 100,
      epochNo: 495,
      ref: { txId: hexToBytes(SURVEY_TX2), index: 0 },
      definition: definition(),
    };
    const rA1 = response("11".repeat(32), CRED_A, 0);
    const rB2 = response(
      "22".repeat(32),
      CRED_B,
      0,
      200,
      Role.Stakeholder,
      SURVEY_TX2,
    );
    await seed(store, [validatedRow(rA1), validatedRow(rB2)]);
    const inputs = fakeInputs({
      [KEY_A]: { weight: 100n, registered: true },
      [KEY_B]: { weight: 7n, registered: true },
    });

    // Survey 1's defining tx is read in full and simply doesn't sign for the
    // owner — a definitive no, unlike a fetch that failed.
    await finalizeRecords(
      CONFIG,
      store,
      inputs,
      proofsStub({ [SURVEY_TX]: STRANGER_PROOF }, [SURVEY_TX2]),
      {
        surveys: [survey(), s2],
        responses: [rA1, rB2],
        cancellations: [],
      },
      TIP,
    );
    expect(store.artifacts.has(SURVEY_KEY)).toBe(false);
    expect(store.artifacts.has(`${SURVEY_TX2}:0`)).toBe(true);
  });

  it("postpones (never decides) a survey whose owner-proof could not be fetched", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    // No definition tx proves out and none is listed: every hash reads as a
    // failed fetch — unknown, which must not freeze an artifact either way.
    await finalizeRecords(
      CONFIG,
      store,
      inputs,
      proofsStub({}, []),
      records(survey(), [rA], []),
      TIP,
    );
    expect(store.artifacts.has(SURVEY_KEY)).toBe(false);

    // Next pass, the fetch succeeds and the survey finalizes normally.
    await finalizeRecords(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), [rA], []),
      TIP,
    );
    expect(store.artifacts.has(SURVEY_KEY)).toBe(true);
  });

  it("postpones when the electorate total is unavailable, resumes without refetching weights", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs(
      { [KEY_A]: { weight: 5n, registered: true } },
      { stakeholder: null }, // upstream can't serve it yet
    );

    await finalizeRecords(
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
    await finalizeRecords(
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
    const store = testStore();
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

    // First run gives up on the epoch fetching B; A's weight is already
    // persisted, and is the resume cursor.
    await finalizeRecords(CONFIG, store, inputs, noProofs, recs, TIP);
    expect(store.weights.size).toBe(1);
    expect([...store.weights.values()][0]!.credential).toBe(KEY_A);
    expect(store.artifacts.size).toBe(0);

    // Next cron: B now resolves, A comes from the cursor → artifact emitted.
    failB = false;
    await finalizeRecords(CONFIG, store, inputs, noProofs, recs, TIP);
    expect(store.weights.size).toBe(2);
    expect(store.artifacts.size).toBe(1);
  });

  // Finding 13 — weights are read per end epoch, before any survey is emitted.
  // An account whose history the upstream can't resolve used to abort the whole
  // pass, starving every other epoch of finalization for as long as it lasted.
  it("skips only the epoch whose weights failed, finalizing the others", async () => {
    const store = testStore();
    const s2: SurveyRecord = {
      txHash: SURVEY_TX2,
      slot: 100,
      epochNo: 495,
      ref: { txId: hexToBytes(SURVEY_TX2), index: 0 },
      definition: definition({ endEpoch: END_EPOCH + 1 }),
    };
    const rA1 = response("11".repeat(32), CRED_A, 0);
    const rB2 = response(
      "22".repeat(32),
      CRED_B,
      0,
      200,
      Role.Stakeholder,
      SURVEY_TX2,
    );
    await seed(store, [validatedRow(rA1), validatedRow(rB2)]);
    const inputs: TallyInputSource = {
      ...fakeInputs({ [KEY_B]: { weight: 7n, registered: true } }),
      async stakeholderWeights(epoch, creds) {
        if (epoch === END_EPOCH) throw new Error("unreadable account history");
        return new Map(
          creds.map((c) => [
            credentialKey(c),
            { weight: 7n, registered: true } as WeightInfo,
          ]),
        );
      },
    };

    await finalizeRecords(
      CONFIG,
      store,
      inputs,
      noProofs,
      {
        surveys: [survey(), s2],
        responses: [rA1, rB2],
        cancellations: [],
      },
      TIP,
    );
    expect(store.artifacts.has(SURVEY_KEY)).toBe(false); // its epoch failed
    expect(store.artifacts.has(`${SURVEY_TX2}:0`)).toBe(true);
  });

  it("is idempotent: an emitted survey is never re-finalized", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const recs = records(survey(), [rA]);

    await finalizeRecords(CONFIG, store, inputs, noProofs, recs, TIP);
    const first = store.artifacts.get(SURVEY_KEY)!;
    await finalizeRecords(CONFIG, store, inputs, noProofs, recs, TIP);
    expect(store.artifacts.get(SURVEY_KEY)).toEqual(first);
    expect(inputs.stakeholderCalls).toBe(1);
  });

  it("never looks below its banked floor", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });

    // A survey that would finalize on its own merits, at an epoch a previous
    // pass has already declared settled. It is not a candidate at all — which
    // is what makes the read bounded, and what a generation rewind (floor back
    // to 0) is the escape hatch from.
    const outcome = await finalizeRecords(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), [rA]),
      TIP,
      undefined,
      [],
      Number.MAX_SAFE_INTEGER,
      END_EPOCH + 1,
    );
    expect(store.artifacts.size).toBe(0);
    expect(inputs.stakeholderCalls).toBe(0);
    expect(outcome.floor).toBe(TIP.epoch);
  });

  it("produces the same artifact hash on independent runs (determinism)", async () => {
    const make = async () => {
      const store = testStore();
      await seed(store, [validatedRow(rA), validatedRow(rB)]);
      await finalizeRecords(
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

  it("emits the same artifact hash regardless of input record order (finding 30)", async () => {
    const run = async (
      responses: ResponseRecord[],
      rows: ValidatedResponseRow[],
    ) => {
      const store = testStore();
      await seed(store, rows);
      await finalizeRecords(
        CONFIG,
        store,
        fakeInputs({
          [KEY_A]: { weight: 100n, registered: true },
          [KEY_B]: { weight: 7n, registered: true },
        }),
        noProofs,
        records(survey(), responses),
        TIP,
      );
      return store.artifacts.get(SURVEY_KEY)!.artifactHash;
    };
    const forward = await run([rA, rB], [validatedRow(rA), validatedRow(rB)]);
    const reversed = await run([rB, rA], [validatedRow(rB), validatedRow(rA)]);
    expect(reversed).toBe(forward);
  });

  it("emits an artifact the independent verifier reproduces (cross-seam, finding 30)", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA), validatedRow(rB)]);
    await finalizeRecords(
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
    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;

    // Feed the emitter's own artifact into the INDEPENDENT verifier, which
    // re-derives the counted set and re-fetches weights/totals through a
    // distinct code path. A MATCH proves the emitter↔verifier seam holds — not
    // just the shared `assembleTallyBody` (a bug there would cancel out) but the
    // surrounding glue each side implements separately (finding 30).
    const proofOf = (hex: string): TxProof => ({
      requiredSigners: [hex],
      nativeScripts: [],
      votes: [],
    });
    const result = await verifyArtifact({
      bundle: {
        survey: survey(),
        responses: [rA, rB],
        cancellations: [],
        tip: TIP,
      } satisfies SurveyBundle,
      artifact,
      network: "preview",
      linkedActionIds: [],
      blockIndices: new Map([
        [rA.txHash, 0],
        [rB.txHash, 0],
      ]),
      proofs: new Map<string, TxProof | null>([
        // The verifier gates on the defining tx's owner-proof too, exactly as
        // the emitter just did.
        [SURVEY_TX, OWNER_PROOF],
        [rA.txHash, proofOf("a1".repeat(28))],
        [rB.txHash, proofOf("b2".repeat(28))],
      ]),
      weights: fakeInputs({
        [KEY_A]: { weight: 100n, registered: true },
        [KEY_B]: { weight: 7n, registered: true },
      }),
    });
    expect(result.match).toBe(true);
    expect(result.unverifiedTotals).toBe(false);
    expect(result.diffs).toEqual([]);
  });

  it("commits the resolved gov-link set to (unhashed) provenance (finding 6)", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const link: GovLink = {
      surveyKey: SURVEY_KEY,
      actionId: "gov_action1linked",
      endEpoch: END_EPOCH,
      title: null,
    };
    // Noise that must be filtered out: a link for this survey at the wrong epoch,
    // and a link for a different survey at this epoch.
    const noise: GovLink[] = [
      {
        surveyKey: SURVEY_KEY,
        actionId: "gov_action1wrongepoch",
        endEpoch: END_EPOCH + 1,
        title: null,
      },
      {
        surveyKey: `${"bb".repeat(32)}:0`,
        actionId: "gov_action1othersurvey",
        endEpoch: END_EPOCH,
        title: null,
      },
    ];
    const before = store.artifacts.get(SURVEY_KEY);
    await finalizeRecords(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), [rA]),
      TIP,
      undefined,
      [link, ...noise],
    );
    const stored = store.artifacts.get(SURVEY_KEY)!;
    const artifact = JSON.parse(stored.artifact) as TallyArtifact;
    expect(artifact.provenance.govLinks).toEqual(["gov_action1linked"]);
    // Provenance is outside the hash: the committed link set changes no content
    // address (the counted set already committed it via perRole).
    expect(before).toBeUndefined();
    expect(stored.artifactHash).toBe(artifactHash(artifact.tally));
  });

  // An artifact's provenance is immutable, so a link set that can still change
  // must never be committed: an anchor resolving tomorrow would add a link the
  // artifact denies. The survey waits for its epoch to settle.
  it("postpones a survey whose governance epoch has not settled", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    await finalizeRecords(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), [rA]),
      TIP,
      undefined,
      [],
      END_EPOCH + 1, // the survey's own expiration is still the frontier
    );
    expect(store.artifacts.size).toBe(0);
  });

  it("commits an empty gov-link set for a standalone survey (finding 6)", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    await finalizeRecords(
      CONFIG,
      store,
      inputs,
      noProofs,
      records(survey(), [rA]),
      TIP,
    );
    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;
    expect(artifact.provenance.govLinks).toEqual([]);
  });

  it("emits a cancellation artifact for an owner-proven, in-window cancellation", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const cancellation: CancellationRecord = {
      txHash: "cc".repeat(32),
      slot: 300,
      epochNo: 499, // ≤ END_EPOCH → in-window
      target: { txId: hexToBytes(SURVEY_TX), index: 0 },
      proof: null, // snapshot never verified it (survey was closed)
    };
    const proofs = proofsStub({ [cancellation.txHash]: OWNER_PROOF });
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });

    const outcome = await finalizeRecords(
      CONFIG,
      store,
      inputs,
      proofs,
      records(survey(), [rA], [cancellation]),
      TIP,
    );
    // A cancellation emission lands in both returned sets — materialize reads
    // the cancelled one for the same-refresh overlay flip.
    expect(outcome.keys.finalized).toEqual(new Set([SURVEY_KEY]));
    expect(outcome.keys.cancelled).toEqual(new Set([SURVEY_KEY]));

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

  it("postpones (never tallies) a survey whose in-window cancellation proof failed to fetch (finding 1)", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const cx = cancellation("cc".repeat(32), 300);

    // The cancelling tx's CBOR couldn't be fetched/decoded this refresh → the
    // proof is `null` (unknown). The pre-fix bug tallied the survey in full and
    // froze that immutable artifact; it must instead postpone.
    await finalizeRecords(
      CONFIG,
      store,
      inputs,
      proofsStub({ [cx.txHash]: null }),
      records(survey(), [rA], [cx]),
      TIP,
    );
    expect(store.artifacts.size).toBe(0); // neither tallied nor cancelled
    expect(store.weights.size).toBe(0); // and no weight work yet
    expect(inputs.stakeholderCalls).toBe(0);

    // Next refresh the proof resolves (owner-verified) → cancellation artifact.
    await finalizeRecords(
      CONFIG,
      store,
      inputs,
      proofsStub({ [cx.txHash]: OWNER_PROOF }),
      records(survey(), [rA], [cx]),
      TIP,
    );
    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;
    expect(artifact.tally.cancelled).toMatchObject({ txHash: cx.txHash });
    expect(artifact.tally.perRole).toEqual([]);
    expect(inputs.stakeholderCalls).toBe(0); // still no weight work
  });

  it("tallies a survey whose in-window cancellation is fetched but unproven (owner not a signer)", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const cx = cancellation("cc".repeat(32), 300);

    // A *definitive* negative (fetched + decoded, owner not a signer) must NOT
    // postpone — the survey is genuinely uncancelled and tallies normally.
    await finalizeRecords(
      CONFIG,
      store,
      inputs,
      proofsStub({ [cx.txHash]: STRANGER_PROOF }),
      records(survey(), [rA], [cx]),
      TIP,
    );
    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;
    expect(artifact.tally.cancelled).toBeUndefined();
    expect(
      artifact.tally.perRole.find((r) => r.role === 3)!.responders,
    ).toHaveLength(1);
  });

  it("postpones when an earlier cancellation's proof is unknown but a later one verifies (winner undetermined)", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const earlier = cancellation("c1".repeat(32), 300); // unknown proof
    const later = cancellation("c2".repeat(32), 400); // owner-verified

    // The earlier unknown could resolve to the winning cancellation, changing
    // the artifact the verifier would rebuild — so freeze nothing yet.
    await finalizeRecords(
      CONFIG,
      store,
      inputs,
      proofsStub({ [earlier.txHash]: null, [later.txHash]: OWNER_PROOF }),
      records(survey(), [rA], [earlier, later]),
      TIP,
    );
    expect(store.artifacts.size).toBe(0);
    expect(store.weights.size).toBe(0);
  });

  it("emits the earlier verified cancellation even when a later one's proof is unknown (winner determined)", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const earlier = cancellation("c1".repeat(32), 300); // owner-verified
    const later = cancellation("c2".repeat(32), 400); // unknown, irrelevant

    // The earliest verified cancellation wins; a later unknown can't displace it.
    await finalizeRecords(
      CONFIG,
      store,
      inputs,
      proofsStub({ [earlier.txHash]: OWNER_PROOF, [later.txHash]: null }),
      records(survey(), [rA], [earlier, later]),
      TIP,
    );
    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;
    expect(artifact.tally.cancelled).toMatchObject({
      txHash: earlier.txHash,
      slot: 300,
    });
  });

  it("emits a sealed artifact with revealed answers and a provenance beacon", async () => {
    const store = testStore();
    const rSealed = sealedResponse("11".repeat(32), CRED_A);
    await seed(store, [validatedRow(rSealed)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 100n, registered: true } });
    const reveal = stubReveal({ [rSealed.txHash]: SEALED_ANSWER });

    await finalizeRecords(
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
    expect(role3.questions[0]).toMatchObject({
      options: [{ index: 1, weight: "100" }],
    });
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
    const store = testStore();
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

    await finalizeRecords(
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
    expect(role3.questions[0]).toMatchObject({
      options: [{ index: 1, weight: "100" }],
    });
  });

  it("postpones a sealed reveal while the round is unavailable (weights frozen, reveal not called)", async () => {
    const store = testStore();
    const rSealed = sealedResponse("11".repeat(32), CRED_A);
    await seed(store, [validatedRow(rSealed)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const reveal = stubReveal({ [rSealed.txHash]: SEALED_ANSWER });

    await finalizeRecords(
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

  // Finding 28 — one timelock decrypt costs ~20 ms of Worker CPU, so a big
  // sealed survey outlives any single invocation; `sealed_reveal` is the cursor
  // that lets it finish anyway.
  it("resumes a sealed reveal across passes, re-decrypting nothing", async () => {
    const store = testStore();
    const fleet = sealedFleet(200); // past MAX_SEALED_DECRYPTS_PER_PASS (150)
    await seed(store, fleet.rows);
    // The first ciphertext never decrypts. That verdict has to be recorded too,
    // or the survey re-attempts it every pass and never completes.
    const reveal = stubReveal(
      Object.fromEntries(
        fleet.recs.map((r, i) => [r.txHash, i === 0 ? null : SEALED_ANSWER]),
      ),
    );
    const chain = records(
      survey(definition({ submissionMode: SEALED_MODE })),
      fleet.recs,
    );
    const pass = () =>
      finalizeRecords(
        CONFIG,
        store,
        fakeInputs(fleet.weights),
        noProofs,
        chain,
        TIP,
        reveal,
      );

    await pass();
    expect(reveal.mock.calls[0]![0]).toHaveLength(150);
    expect(store.artifacts.size).toBe(0); // 50 ciphertexts still sealed

    await pass();
    // Exactly the leftovers — the 150 already recorded are not decrypted again.
    expect(reveal.mock.calls[1]![0].map((r) => r.txHash)).toEqual(
      fleet.recs.slice(150).map((r) => r.txHash),
    );

    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;
    const role3 = artifact.tally.perRole.find((r) => r.role === 3)!;
    expect(role3.responders).toHaveLength(199); // all but the undecryptable one
  });

  it("spends the pass-wide decrypt budget on one sealed survey and defers the next", async () => {
    const store = testStore();
    const first = sealedFleet(150); // exactly MAX_SEALED_DECRYPTS_PER_PASS
    const SURVEY_KEY2 = `${SURVEY_TX2}:0`;
    const second = sealedFleet(1, SURVEY_KEY2, 200);
    await seed(store, [...first.rows, ...second.rows]);
    const reveal = stubReveal(
      Object.fromEntries(first.recs.map((r) => [r.txHash, SEALED_ANSWER])),
    );
    const sealedDef = definition({ submissionMode: SEALED_MODE });

    await finalizeRecords(
      CONFIG,
      store,
      fakeInputs(first.weights),
      noProofs,
      {
        surveys: [
          survey(sealedDef),
          {
            txHash: SURVEY_TX2,
            slot: 100,
            epochNo: 495,
            ref: { txId: hexToBytes(SURVEY_TX2), index: 0 },
            definition: sealedDef,
          },
        ],
        responses: [...first.recs, ...second.recs],
        cancellations: [],
      },
      TIP,
      reveal,
    );

    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal.mock.calls[0]![0]).toHaveLength(150);
    expect(store.artifacts.has(SURVEY_KEY)).toBe(true);
    // The budget is gone, so the second survey's ciphertext waits for the next
    // pass rather than pushing this one past its CPU ceiling.
    expect(store.artifacts.has(SURVEY_KEY2)).toBe(false);
  });

  it("postpones (does not escape) when the reveal throws", async () => {
    const store = testStore();
    const rSealed = sealedResponse("11".repeat(32), CRED_A);
    await seed(store, [validatedRow(rSealed)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const throwingReveal: SealedRevealFn = async () => {
      throw new Error("beacon fetch failed");
    };
    const reveal = vi.fn(throwingReveal);

    // Must resolve, not reject — one bad reveal can't abort the whole pass.
    await expect(
      finalizeRecords(
        CONFIG,
        store,
        inputs,
        noProofs,
        records(survey(definition({ submissionMode: SEALED_MODE })), [rSealed]),
        TIP,
        reveal,
      ),
      // …and the survey it postponed holds the frontier at its own epoch.
    ).resolves.toEqual({
      keys: { finalized: new Set(), cancelled: new Set() },
      floor: END_EPOCH,
    });

    expect(reveal).toHaveBeenCalledTimes(1);
    expect(store.artifacts.size).toBe(0); // retried next refresh
  });

  it("skips a sealed survey on an unsupported (non-quicknet) chain — no reveal, no weight work", async () => {
    const store = testStore();
    const rSealed = sealedResponse("11".repeat(32), CRED_A);
    await seed(store, [validatedRow(rSealed)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const reveal = stubReveal({ [rSealed.txHash]: SEALED_ANSWER });

    await finalizeRecords(
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
    const store = testStore();
    const rSealed = sealedResponse("11".repeat(32), CRED_A);
    await seed(store, [validatedRow(rSealed)]);
    const cancellation: CancellationRecord = {
      txHash: "cc".repeat(32),
      slot: 300,
      epochNo: 499,
      target: { txId: hexToBytes(SURVEY_TX), index: 0 },
      proof: null,
    };
    const proofs = proofsStub({ [cancellation.txHash]: OWNER_PROOF });
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });
    const reveal = stubReveal({ [rSealed.txHash]: SEALED_ANSWER });

    await finalizeRecords(
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
    const store = testStore();
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

    await finalizeRecords(
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
    expect(role3.questions[0]).toMatchObject({
      options: [{ index: 1, weight: "100" }],
    });
  });

  it("postpones emission while any counted-candidate verdict or block index is pending (finding 1)", async () => {
    const store = testStore();
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

    await finalizeRecords(CONFIG, store, inputs, noProofs, recs, TIP);
    // Artifact must NOT be emitted: rC could still resolve to counted, and an
    // immutable artifact would freeze it out forever.
    expect(store.artifacts.size).toBe(0);

    // A null block index on an otherwise-proven row also postpones.
    await store.upsertValidatedResponses([
      validatedRow(rC, { proofOk: true, blockIndex: null }),
    ]);
    await finalizeRecords(CONFIG, store, inputs, noProofs, recs, TIP);
    expect(store.artifacts.size).toBe(0);

    // Both verdict and block index final → the survey finalizes, rC included.
    await store.upsertValidatedResponses([
      validatedRow(rC, { proofOk: true, blockIndex: 0 }),
    ]);
    await finalizeRecords(CONFIG, store, inputs, noProofs, recs, TIP);
    const artifact = JSON.parse(
      store.artifacts.get(SURVEY_KEY)!.artifact,
    ) as TallyArtifact;
    const role3 = artifact.tally.perRole.find((r) => r.role === 3)!;
    expect(role3.responders.map((r) => r.credential).sort()).toEqual(
      [KEY_A, credentialKey(rC.response.credential)].sort(),
    );
  });

  it("skips all finalization when the snapshot is incomplete (finding 3)", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });

    const outcome = await finalizeRecords(
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
    // A pass that decided nothing moves no frontier: the banked one stands.
    expect(outcome.floor).toBeNull();
  });

  it("prunes a counted response that fell out of the snapshot, then finalizes (finding 3)", async () => {
    const store = testStore();
    await seed(store, [validatedRow(rA)]); // validated earlier…
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });

    // …but the response tx is no longer in the (complete) snapshot: it was
    // reorged out and, with a fixed scan floor, can never age back in. This
    // refresh prunes the stale row and postpones (the one-refresh reorg buffer);
    // it must NOT postpone forever the way it once did.
    await finalizeRecords(
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
    await finalizeRecords(
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
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const inputs = fakeInputs({ [KEY_A]: { weight: 5n, registered: true } });

    // Refresh 1: absent → pruned, postponed.
    await finalizeRecords(
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
    await finalizeRecords(
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
    const store = testStore();
    await seed(store, [validatedRow(rA)]);
    const openTip: ChainTip = { ...TIP, epoch: END_EPOCH }; // not yet past
    await finalizeRecords(
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
