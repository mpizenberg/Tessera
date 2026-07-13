import { describe, expect, it } from "vitest";
import type { Question, Role, SurveyDefinition, SurveyResponse } from "cip-179";

import { hexToBytes } from "cip-179/domain";
import type { TallyArtifact } from "cip-179/tally";

import {
  formatAda,
  fracOf,
  ratioOf,
  resultRoleViews,
  weightedQuestionView,
  type CountedResponse,
} from "./artifactView";

const SC: Question = {
  type: "singleChoice",
  prompt: "",
  options: { type: "options", labels: ["yes", "no"] },
};

describe("exact-to-float helpers", () => {
  it("fracOf is relative with 4-decimal precision and safe at 0", () => {
    expect(fracOf(50n, 100n)).toBe(0.5);
    expect(fracOf(1n, 3n)).toBe(0.3333);
    expect(fracOf(45_000_000_000_000_000n, 45_000_000_000_000_000n)).toBe(1);
    expect(fracOf(1n, 0n)).toBe(0);
  });

  it("ratioOf yields null on an empty denominator", () => {
    expect(ratioOf(10n, 4n)).toBe(2.5);
    expect(ratioOf(0n, 0n)).toBeNull();
  });

  it("formatAda renders whole ada, grouped", () => {
    expect(formatAda(512_793_397_078n)).toBe("512,793");
    expect(formatAda(0n)).toBe("0");
    expect(formatAda(999_999n)).toBe("<1");
  });
});

describe("weightedQuestionView", () => {
  it("bars: weights drive fills, labels come from the definition", () => {
    const v = weightedQuestionView(SC, {
      kind: "options",
      unit: "singleChoice",
      optionWeights: ["100", "7"],
      optionCounts: [1, 1],
      answeredCount: 2,
      answeredWeight: "107",
    });
    expect(v).toEqual({
      kind: "bars",
      unit: "singleChoice",
      bars: [
        { label: "yes", weight: 100n, count: 1, frac: 1 },
        { label: "no", weight: 7n, count: 1, frac: 0.07 },
      ],
      answeredCount: 2,
      answeredWeight: 107n,
    });
  });

  it("histogram: exact weighted mean, bins labeled by value", () => {
    const v = weightedQuestionView(undefined, {
      kind: "numeric",
      weightedSum: "1310",
      answeredWeight: "110",
      answeredCount: 3,
      values: [
        { value: "10", weight: "103", count: 2 },
        { value: "40", weight: "7", count: 1 },
      ],
    });
    if (v.kind !== "histogram") throw new Error("expected histogram");
    expect(v.mean).toBe(11.909); // 1310/110 to 4 places
    expect(v.bins.map((b) => b.label)).toEqual(["10", "40"]);
    expect(v.bins[0]!.frac).toBe(1);
  });

  it("rows: per-option means; empty denominators become null", () => {
    const v = weightedQuestionView(SC, {
      kind: "perOption",
      unit: "rating",
      perOption: [
        { weightedSum: "507", answeredWeight: "107", count: 2 },
        { weightedSum: "0", answeredWeight: "0", count: 0 },
      ],
      answeredCount: 2,
      answeredWeight: "107",
    });
    if (v.kind !== "rows") throw new Error("expected rows");
    expect(v.rows[0]).toEqual({ label: "yes", avg: 4.7383, count: 2 });
    expect(v.rows[1]).toEqual({ label: "no", avg: null, count: 0 });
  });
});

describe("resultRoleViews", () => {
  const def: SurveyDefinition = {
    specVersion: 5,
    owner: { type: "key", keyHash: Uint8Array.of(0) },
    title: "t",
    description: "",
    eligibleRoles: [3] as Role[],
    endEpoch: 500,
    submissionMode: { type: "public" },
    questions: [SC],
  };
  const artifact: TallyArtifact = {
    tally: {
      rulesetHash: "rr",
      network: "preview",
      survey: { txId: "aa", index: 0, endEpoch: 500 },
      sealed: false,
      perRole: [
        {
          role: 3,
          total: "1000",
          responders: [
            {
              credential: "key:a1",
              weight: "100",
              txHash: "t1",
              responseIndex: 0,
            },
            {
              credential: "key:b2",
              weight: "150",
              txHash: "t2",
              responseIndex: 0,
            },
          ],
          questions: [
            {
              kind: "options",
              unit: "singleChoice",
              optionWeights: ["100", "150"],
              optionCounts: [1, 1],
              answeredCount: 2,
              answeredWeight: "250",
            },
          ],
        },
        {
          role: 4,
          total: null,
          responders: [
            {
              credential: "key:c3",
              weight: "1",
              txHash: "t3",
              responseIndex: 0,
            },
          ],
          questions: [
            {
              kind: "options",
              unit: "singleChoice",
              optionWeights: ["1", "0"],
              optionCounts: [1, 0],
              answeredCount: 1,
              answeredWeight: "1",
            },
          ],
        },
      ],
    },
    provenance: {
      source: { provider: "koios", baseUrl: "x" },
      fetchedAt: 1,
      byRole: [],
    },
  };

  // Two stakeholders (a1 → yes, b2 → no) whose txs match the artifact, so the
  // one-vote view can rejoin their answers by (txHash, credential).
  const response = (
    keyHashHex: string,
    optionIndex: number,
  ): SurveyResponse => ({
    specVersion: 5,
    surveyRef: { txId: hexToBytes("aa".repeat(32)), index: 0 },
    role: 3 as Role,
    credential: { type: "key", keyHash: hexToBytes(keyHashHex) },
    answers: {
      type: "public",
      answers: [{ type: "singleChoice", questionIndex: 0, optionIndex }],
    },
  });
  const responses: CountedResponse[] = [
    { txHash: "t1", responseIndex: 0, response: response("a1", 0) },
    { txHash: "t2", responseIndex: 0, response: response("b2", 1) },
  ];

  it("chain weighting: sums voted weight and derives turnout only when a total exists", () => {
    const [stakeholder, keyholder] = resultRoleViews(
      artifact,
      def,
      [],
      "chain",
    );
    expect(stakeholder).toMatchObject({
      role: 3,
      responderCount: 2,
      votedWeight: 250n,
      total: 1000n,
      turnout: 0.25,
    });
    expect(stakeholder!.questions[0]!.kind).toBe("bars");
    expect(keyholder).toMatchObject({
      role: 4,
      votedWeight: 1n,
      total: null,
      turnout: null,
    });
  });

  it("one-vote weighting: same counted set, equal weights, no ada total", () => {
    const [stakeholder] = resultRoleViews(artifact, def, responses, "one");
    expect(stakeholder).toMatchObject({
      role: 3,
      responderCount: 2,
      votedWeight: null,
      total: null,
      turnout: null,
    });
    const q = stakeholder!.questions[0]!;
    if (q.kind !== "bars") throw new Error("expected bars");
    // yes/no each got exactly one vote — equal weight, equal fill.
    expect(q.bars.map((b) => b.weight)).toEqual([1n, 1n]);
    expect(q.bars.map((b) => b.count)).toEqual([1, 1]);
    expect(q.bars.map((b) => b.frac)).toEqual([1, 1]);
  });

  it("one-vote weighting over a SEALED artifact uses the committed answers (no chain rejoin)", () => {
    // A sealed survey's on-chain responses are ciphertexts, so `responses` is
    // empty here — the answers come from each responder's committed `answers`.
    const sealedArtifact: TallyArtifact = {
      ...artifact,
      tally: {
        ...artifact.tally,
        sealed: true,
        perRole: [
          {
            ...artifact.tally.perRole[0]!,
            responders: [
              {
                credential: "key:a1",
                weight: "100",
                txHash: "t1",
                responseIndex: 0,
                answers: [
                  { type: "singleChoice", questionIndex: 0, optionIndex: 0 },
                ],
              },
              {
                credential: "key:b2",
                weight: "150",
                txHash: "t2",
                responseIndex: 0,
                answers: [
                  { type: "singleChoice", questionIndex: 0, optionIndex: 1 },
                ],
              },
            ],
          },
        ],
      },
    };
    // Note the empty `responses` — a chain rejoin would tally nothing.
    const [stakeholder] = resultRoleViews(sealedArtifact, def, [], "one");
    const q = stakeholder!.questions[0]!;
    if (q.kind !== "bars") throw new Error("expected bars");
    expect(q.bars.map((b) => b.weight)).toEqual([1n, 1n]);
    expect(q.bars.map((b) => b.count)).toEqual([1, 1]);
    expect(q.bars.map((b) => b.frac)).toEqual([1, 1]);
  });
});
