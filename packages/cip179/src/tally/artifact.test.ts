import { describe, expect, it } from "vitest";
import type {
  Credential,
  Role,
  SurveyDefinition,
  SurveyResponse,
} from "../index.js";

import {
  RULESET_DESCRIPTOR,
  artifactHash,
  assembleTallyBody,
  rulesetHash,
  toArtifactQuestions,
  toArtifactResponders,
  type RoleTally,
  type TallyBody,
  type TallyBodyIdentity,
} from "./artifact.js";
import { canonicalJson } from "./canonical.js";
import type {
  WeightedQuestionTally,
  WeightedResponder,
} from "./weightedTally.js";

const RESPONSE: SurveyResponse = {
  specVersion: 5,
  surveyRef: { txId: Uint8Array.of(9), index: 0 },
  role: 3 as Role,
  credential: { type: "key", keyHash: Uint8Array.of(1) },
  answers: { type: "public", answers: [] },
};

function body(weight: string): TallyBody {
  return {
    network: "preview",
    survey: { txId: "aa".repeat(32), index: 0, endEpoch: 900 },
    sealed: false,
    perRole: [
      {
        role: 3,
        responders: [
          { credential: "key:01", weight, txHash: "cc", responseIndex: 0 },
        ],
        questions: [
          { kind: "custom", answeredCount: 1, answeredWeight: weight },
        ],
      },
    ],
  };
}

describe("rulesetHash", () => {
  it("is a stable blake2b-256 of the canonical descriptor", () => {
    expect(rulesetHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(rulesetHash()).toBe(rulesetHash());
  });

  // Golden value: every artifact's provenance records it, and an auditor maps
  // it to the release that counts as the emitter did (the README's table), so
  // it MUST NOT drift silently. If this fails, a counting rule changed — decide
  // deliberately: a real semantic change (to RULESET_DESCRIPTOR, or to the
  // behavior of `validateResponse` / `dedupeResponses` it describes) requires
  // bumping `rulesetVersion` and updating this literal in the same commit; an
  // accidental change must be reverted. Never just paste the new value to make
  // CI green: the bump is what gives the new rules their own row, so an
  // auditor is never sent to rules the emitter did not run.
  it("matches its pinned golden hash (bump rulesetVersion on any change)", () => {
    expect(rulesetHash()).toBe(
      "7c78775e6c70d40d9e1daade043e42509ef1756fa5f7a359c9cf00bbf9efe004",
    );
  });

  it("pins every counting dimension in the descriptor", () => {
    // The hash only protects what the descriptor *says* — make sure the
    // load-bearing rules are actually in there.
    const text = canonicalJson(RULESET_DESCRIPTOR);
    for (const needle of [
      "end_epoch",
      "required_signers",
      "voting_procedures",
      "(slot, tx_block_index, response_index)",
      "drep_voting_power_at_end_epoch",
      "active_stake_at_end_epoch",
    ]) {
      expect(text).toContain(needle);
    }
    expect(RULESET_DESCRIPTOR.coveredRoles).toEqual([0, 3, 4]);
  });
});

describe("artifactHash", () => {
  it("is deterministic and ignores property insertion order", () => {
    const a = body("100");
    // Same content, reversed property insertion order at two levels.
    const b = {
      perRole: a.perRole,
      sealed: a.sealed,
      survey: { endEpoch: 900, index: 0, txId: "aa".repeat(32) },
      network: a.network,
    } as TallyBody;
    expect(artifactHash(a)).toBe(artifactHash(b));
  });

  it("changes when any committed value changes", () => {
    expect(artifactHash(body("100"))).not.toBe(artifactHash(body("101")));
  });

  it("survives a JSON round-trip (artifact bodies are wire-plain)", () => {
    const a = body("45000000000000000");
    const roundTripped = JSON.parse(JSON.stringify(a)) as TallyBody;
    expect(artifactHash(roundTripped)).toBe(artifactHash(a));
  });
});

// The ONE shared body assembler the emitter and verifier both call (finding 29).
// A golden hash + a permutation test pin its output so a drift in role/responder
// ordering or the base-body shape fails CI mechanically (finding 30).
describe("assembleTallyBody", () => {
  const ID: TallyBodyIdentity = {
    network: "preview",
    survey: { txId: "aa".repeat(32), index: 0, endEpoch: 900 },
    sealed: false,
  };
  const DEF: SurveyDefinition = {
    specVersion: 5,
    owner: { type: "key", keyHash: Uint8Array.of(0) },
    title: "t",
    description: "",
    eligibleRoles: [0, 3] as Role[],
    endEpoch: 900,
    submissionMode: { type: "public" },
    questions: [
      {
        type: "singleChoice",
        prompt: "",
        options: { type: "options", labels: ["a", "b"] },
      },
    ],
  };
  const cred = (b: number): Credential => ({
    type: "key",
    keyHash: Uint8Array.of(b),
  });
  const wr = (b: number, weight: bigint, optionIndex: number) => ({
    credentialKey: `key:0${b}`,
    weight,
    txHash: `tx${b}`,
    responseIndex: 0,
    response: {
      specVersion: 5,
      surveyRef: { txId: Uint8Array.of(9), index: 0 },
      role: 3 as Role,
      credential: cred(b),
      answers: {
        type: "public" as const,
        answers: [
          { type: "singleChoice" as const, questionIndex: 0, optionIndex },
        ],
      },
    },
  });
  // Roles and responders passed OUT of sorted order on purpose.
  const roles: RoleTally[] = [
    { role: 3, responders: [wr(2, 100n, 0), wr(1, 50n, 1)] },
    { role: 0, responders: [wr(3, 7n, 0)] },
  ];

  it("sorts roles ascending and responders by credential identity", () => {
    const body = assembleTallyBody(DEF, ID, roles);
    expect(body.perRole.map((r) => r.role)).toEqual([0, 3]);
    expect(body.perRole[1]!.responders.map((r) => r.credential)).toEqual([
      "key:01",
      "key:02",
    ]);
  });

  it("is invariant to the input order of roles and responders (finding 30)", () => {
    const shuffled: RoleTally[] = [
      { role: 0, responders: [wr(3, 7n, 0)] },
      { role: 3, responders: [wr(1, 50n, 1), wr(2, 100n, 0)] },
    ];
    expect(artifactHash(assembleTallyBody(DEF, ID, shuffled))).toBe(
      artifactHash(assembleTallyBody(DEF, ID, roles)),
    );
  });

  // Golden content address of a nontrivial two-role weighted body. Like the
  // ruleset golden above, this MUST NOT drift silently: a change here means the
  // shared assembly changed the body's bytes, which moves every artifact's
  // hash — update deliberately (and bump `rulesetVersion`), never paste to make
  // CI green.
  it("matches its pinned golden artifact hash", () => {
    expect(artifactHash(assembleTallyBody(DEF, ID, roles))).toBe(
      "c97ffddb01799c1480fdbdfa97128854444dbc12257319829df4c489f10442a0",
    );
  });
});

describe("toArtifactQuestions", () => {
  it("converts every bigint aggregate to a decimal string", () => {
    const tallies: WeightedQuestionTally[] = [
      {
        kind: "options",
        unit: "singleChoice",
        options: [{ index: 0, weight: 45_000_000_000_000_000n, count: 1 }],
        answeredCount: 1,
        answeredWeight: 45_000_000_000_000_000n,
      },
      {
        kind: "numeric",
        weightedSum: 10n,
        answeredWeight: 2n,
        answeredCount: 2,
        values: [{ value: 5n, weight: 2n, count: 2 }],
      },
      {
        kind: "perOption",
        unit: "rating",
        perOption: [
          { index: 0, weightedSum: 6n, answeredWeight: 2n, count: 2 },
        ],
        answeredCount: 2,
        answeredWeight: 2n,
      },
      { kind: "custom", answeredCount: 3, answeredWeight: 3n },
    ];
    const qs = toArtifactQuestions(tallies);
    expect(qs[0]).toEqual({
      kind: "options",
      unit: "singleChoice",
      options: [{ index: 0, weight: "45000000000000000", count: 1 }],
      answeredCount: 1,
      answeredWeight: "45000000000000000",
    });
    expect(qs[1]).toMatchObject({
      weightedSum: "10",
      values: [{ value: "5", weight: "2", count: 2 }],
    });
    expect(qs[2]).toMatchObject({
      perOption: [
        { index: 0, weightedSum: "6", answeredWeight: "2", count: 2 },
      ],
    });
    expect(qs[3]).toEqual({
      kind: "custom",
      answeredCount: 3,
      answeredWeight: "3",
    });
    // The converted form must be canonicalizable (no bigints slipped through).
    expect(() => canonicalJson(qs)).not.toThrow();
  });

  it("omits per-option answeredWeight when the tally omits it (points)", () => {
    const qs = toArtifactQuestions([
      {
        kind: "perOption",
        unit: "points",
        // Points entries carry no per-option answeredWeight — the denominator is
        // the question-level value, identical for every option.
        perOption: [{ index: 0, weightedSum: 4n, count: 2 }],
        answeredCount: 2,
        answeredWeight: 2n,
      },
    ]);
    const q0 = qs[0]!;
    if (q0.kind !== "perOption") throw new Error("expected perOption");
    expect("answeredWeight" in q0.perOption[0]!).toBe(false);
  });
});

describe("toArtifactResponders", () => {
  it("converts and sorts by credential identity", () => {
    const rs: WeightedResponder[] = [
      {
        credentialKey: "script:ff",
        weight: 2n,
        txHash: "t2",
        responseIndex: 1,
        response: RESPONSE,
      },
      {
        credentialKey: "key:aa",
        weight: 1n,
        txHash: "t1",
        responseIndex: 0,
        response: RESPONSE,
      },
    ];
    expect(toArtifactResponders(rs)).toEqual([
      { credential: "key:aa", weight: "1", txHash: "t1", responseIndex: 0 },
      { credential: "script:ff", weight: "2", txHash: "t2", responseIndex: 1 },
    ]);
  });
});
