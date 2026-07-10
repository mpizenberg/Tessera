import { describe, expect, it } from "vitest";
import type { Role, SurveyResponse } from "../index.js";

import {
  RULESET_DESCRIPTOR,
  artifactHash,
  responderAnswers,
  rulesetHash,
  toArtifactQuestions,
  toArtifactResponders,
  type TallyBody,
} from "./artifact.js";
import type { AnswerItem, Metadatum } from "../index.js";
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

function body(perRoleTotal: string | null): TallyBody {
  return {
    rulesetHash: rulesetHash(),
    network: "preview",
    survey: { txId: "aa".repeat(32), index: 0, endEpoch: 900 },
    sealed: false,
    perRole: [
      {
        role: 3,
        total: perRoleTotal,
        responders: [
          {
            credential: "key:01",
            weight: "45000000000000000",
            txHash: "cc",
            responseIndex: 0,
          },
        ],
        questions: [
          {
            kind: "custom",
            answeredCount: 1,
            answeredWeight: "45000000000000000",
          },
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

  // Golden value: the hash a verifier reproduces to confirm it counts under the
  // SAME ruleset as the emitter. It is embedded in every historical artifact, so
  // it MUST NOT drift silently. If this fails, a counting rule changed — decide
  // deliberately: a real semantic change (to RULESET_DESCRIPTOR, or to the
  // behavior of `validateResponse` / `dedupeResponses` it describes) requires
  // bumping `rulesetVersion` and updating this literal in the same commit; an
  // accidental change must be reverted. Never just paste the new value to make
  // CI green — that re-labels old artifacts as MISMATCH instead of "different
  // rules", which is the exact failure mode the hash exists to prevent.
  it("matches its pinned golden hash (bump rulesetVersion on any change)", () => {
    expect(rulesetHash()).toBe(
      "64efbd0fb3614348e5c2620275baa9f9eb3e274e4ae9fa46d7fb9f8643fd24bc",
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
      rulesetHash: a.rulesetHash,
    } as TallyBody;
    expect(artifactHash(a)).toBe(artifactHash(b));
  });

  it("changes when any committed value changes", () => {
    expect(artifactHash(body("100"))).not.toBe(artifactHash(body("101")));
    expect(artifactHash(body("100"))).not.toBe(artifactHash(body(null)));
  });

  it("survives a JSON round-trip (artifact bodies are wire-plain)", () => {
    const a = body(null);
    const roundTripped = JSON.parse(JSON.stringify(a)) as TallyBody;
    expect(artifactHash(roundTripped)).toBe(artifactHash(a));
  });
});

describe("toArtifactQuestions", () => {
  it("converts every bigint aggregate to a decimal string", () => {
    const tallies: WeightedQuestionTally[] = [
      {
        kind: "options",
        unit: "singleChoice",
        optionWeights: [45_000_000_000_000_000n, 0n],
        optionCounts: [1, 0],
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
        perOption: [{ weightedSum: 6n, answeredWeight: 2n, count: 2 }],
        levelWeights: [[0n, 2n]],
        answeredCount: 2,
        answeredWeight: 2n,
      },
      { kind: "custom", answeredCount: 3, answeredWeight: 3n },
    ];
    const qs = toArtifactQuestions(tallies);
    expect(qs[0]).toEqual({
      kind: "options",
      unit: "singleChoice",
      optionWeights: ["45000000000000000", "0"],
      optionCounts: [1, 0],
      answeredCount: 1,
      answeredWeight: "45000000000000000",
    });
    expect(qs[1]).toMatchObject({
      weightedSum: "10",
      values: [{ value: "5", weight: "2", count: 2 }],
    });
    expect(qs[2]).toMatchObject({ levelWeights: [["0", "2"]] });
    expect(qs[3]).toEqual({
      kind: "custom",
      answeredCount: 3,
      answeredWeight: "3",
    });
    // The converted form must be canonicalizable (no bigints slipped through).
    expect(() => canonicalJson(qs)).not.toThrow();
  });

  it("omits levelWeights when the tally has none (points)", () => {
    const qs = toArtifactQuestions([
      {
        kind: "perOption",
        unit: "points",
        perOption: [],
        answeredCount: 0,
        answeredWeight: 0n,
      },
    ]);
    expect("levelWeights" in qs[0]!).toBe(false);
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

  it("omits answers for public tallies (no revealedAnswers)", () => {
    const rs: WeightedResponder[] = [
      {
        credentialKey: "key:aa",
        weight: 1n,
        txHash: "t1",
        responseIndex: 0,
        response: RESPONSE,
      },
    ];
    expect("answers" in toArtifactResponders(rs)[0]!).toBe(false);
    expect(responderAnswers(toArtifactResponders(rs)[0]!)).toBeNull();
  });

  it("commits revealed answers as canonicalizable wire form and round-trips them", () => {
    // Answers with a bigint (numeric) and a custom Metadatum carrying Map + bytes
    // — exactly the values JSON can't hold, so the wire tags must survive.
    const answers: AnswerItem[] = [
      { type: "numeric", questionIndex: 0, value: 42n },
      {
        type: "custom",
        questionIndex: 1,
        value: new Map<Metadatum, Metadatum>([[1n, Uint8Array.of(0xab, 0xcd)]]),
      },
    ];
    const rs: WeightedResponder[] = [
      {
        credentialKey: "key:aa",
        weight: 3n,
        txHash: "t1",
        responseIndex: 0,
        response: { ...RESPONSE, answers: { type: "public", answers } },
      },
    ];
    const [committed] = toArtifactResponders(rs, { revealedAnswers: true });
    // No bigints/bytes slipped through — the artifact hash must be computable.
    expect(() => canonicalJson([committed])).not.toThrow();
    // Survives the JSON round-trip an artifact makes over HTTP + SQLite, and
    // `responderAnswers` is the exact inverse.
    const wire = JSON.parse(JSON.stringify(committed));
    expect(responderAnswers(wire)).toEqual(answers);
  });
});
