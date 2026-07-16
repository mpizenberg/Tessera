import { describe, expect, it } from "vitest";
import type {
  AnswerItem,
  Question,
  Role,
  SurveyDefinition,
  SurveyResponse,
} from "cip-179";

import {
  weightedTallySurvey,
  type WeightedQuestionTally,
  type WeightedResponder,
} from "cip-179/tally";

import { MAX_DISPLAY_BUCKETS, tallySurvey } from "./displayTally";

// The count-based display tally (`displayTally.ts`) and the hashed weighted
// tally (`cip-179`) are independent code paths; these tests pin that with every
// weight `1n` they agree, and that the display path caps its dense buckets.

// --- fixtures ----------------------------------------------------------------

const OPTS = { type: "options", labels: ["a", "b", "c"] } as const;

const QUESTIONS: Question[] = [
  { type: "singleChoice", prompt: "", options: OPTS },
  {
    type: "multiSelect",
    prompt: "",
    options: OPTS,
    minSelections: 0,
    maxSelections: 3,
  },
  { type: "ranking", prompt: "", options: OPTS, minRanked: 1, maxRanked: 3 },
  { type: "numericRange", prompt: "", constraints: { min: 0n, max: 100n } },
  { type: "pointsAllocation", prompt: "", options: OPTS, budget: 10 },
  {
    type: "rating",
    prompt: "",
    options: OPTS,
    scale: { type: "numeric", constraints: { min: 1n, max: 5n } },
    requireAll: false,
  },
  {
    type: "custom",
    prompt: "",
    methodSchema: { uri: "ipfs://x", hash: new Uint8Array(32) },
  },
];

const DEF: SurveyDefinition = {
  specVersion: 5,
  owner: { type: "key", keyHash: Uint8Array.of(0) },
  title: "t",
  description: "",
  eligibleRoles: [3] as Role[],
  endEpoch: 9,
  submissionMode: { type: "public" },
  questions: QUESTIONS,
};

function respWith(cred: number, answers: AnswerItem[]): SurveyResponse {
  return {
    specVersion: 5,
    surveyRef: { txId: Uint8Array.of(9), index: 0 },
    role: 3 as Role,
    credential: { type: "key", keyHash: Uint8Array.of(cred) },
    answers: { type: "public", answers },
  };
}

function responder(
  cred: number,
  weight: bigint,
  answers: AnswerItem[],
): WeightedResponder {
  return {
    credentialKey: `key:0${cred}`,
    weight,
    txHash: `tx${cred}`,
    responseIndex: 0,
    response: respWith(cred, answers),
  };
}

/** Full answer set for one responder (every question answered). */
function fullAnswers(
  choice: number,
  multi: number[],
  ranking: number[],
  numeric: bigint,
  points: [number, number][],
  ratings: [number, bigint][],
): AnswerItem[] {
  return [
    { type: "singleChoice", questionIndex: 0, optionIndex: choice },
    { type: "multiSelect", questionIndex: 1, optionIndices: multi },
    { type: "ranking", questionIndex: 2, ranking },
    { type: "numeric", questionIndex: 3, value: numeric },
    {
      type: "pointsAllocation",
      questionIndex: 4,
      allocations: points.map(([optionIndex, p]) => ({
        optionIndex,
        points: p,
      })),
    },
    {
      type: "rating",
      questionIndex: 5,
      ratings: ratings.map(([optionIndex, rating]) => ({
        optionIndex,
        rating,
      })),
    },
    { type: "custom", questionIndex: 6, value: "free" },
  ];
}

const R1 = responder(
  1,
  100n,
  fullAnswers(0, [0, 2], [2, 0], 10n, [[0, 10]], [[0, 5n]]),
);
const R2 = responder(
  2,
  7n,
  fullAnswers(
    1,
    [1],
    [0, 1],
    40n,
    [
      [0, 4],
      [1, 6],
    ],
    [
      [0, 1n],
      [1, 3n],
    ],
  ),
);
const R3 = responder(3, 3n, [
  // Abstains from everything except the numeric question (same value as R1).
  { type: "numeric", questionIndex: 3, value: 10n },
]);

// --- the cross-check: all weights 1n ⇔ the count tally --------------------------

describe("weightedTallySurvey with all weights 1n reproduces displayTally counts", () => {
  const responders = [
    R1,
    R2,
    R3,
    responder(4, 1n, fullAnswers(2, [], [1], 55n, [[2, 10]], [[2, 4n]])),
  ].map((r) => ({ ...r, weight: 1n }));
  const counted = tallySurvey(
    DEF,
    responders.map((r) => r.response),
    responders.length,
  );
  const weighted = weightedTallySurvey(DEF, responders);

  /** Sparse option buckets → dense weight array of length n (Number). */
  const denseWeights = (
    opts: readonly { index: number; weight: bigint }[],
    n: number,
  ) => {
    const out = new Array<number>(n).fill(0);
    for (const o of opts) out[o.index] = Number(o.weight);
    return out;
  };
  /** Sparse option buckets → dense count array of length n. */
  const denseCounts = (
    opts: readonly { index: number; count: number }[],
    n: number,
  ) => {
    const out = new Array<number>(n).fill(0);
    for (const o of opts) out[o.index] = o.count;
    return out;
  };

  it("matches the three options-shaped questions", () => {
    for (const qi of [0, 1, 2]) {
      const c = counted[qi]!;
      const w = weighted[qi]! as Extract<
        WeightedQuestionTally,
        { kind: "options" }
      >;
      if (c.kind !== "bars") throw new Error("expected bars");
      const n = c.bars.length;
      expect(denseWeights(w.options, n)).toEqual(c.bars.map((b) => b.count));
      expect(denseCounts(w.options, n)).toEqual(c.bars.map((b) => b.count));
      expect(w.answeredCount).toBe(c.answered);
      expect(Number(w.answeredWeight)).toBe(c.answered);
    }
  });

  it("matches the numeric histogram, mean and participation", () => {
    const c = counted[3]!;
    const w = weighted[3]! as Extract<
      WeightedQuestionTally,
      { kind: "numeric" }
    >;
    if (c.kind !== "histogram") throw new Error("expected histogram");
    expect(
      w.values.map((v) => ({ label: String(v.value), count: v.count })),
    ).toEqual(c.bins);
    expect(w.values.map((v) => Number(v.weight))).toEqual(
      c.bins.map((b) => b.count),
    );
    expect(Number(w.weightedSum) / Number(w.answeredWeight)).toBe(c.mean);
    expect(w.answeredCount).toBe(c.answered);
  });

  it("matches points averages (weightedSum / answeredWeight = avg)", () => {
    const c = counted[4]!;
    const w = weighted[4]! as Extract<
      WeightedQuestionTally,
      { kind: "perOption" }
    >;
    if (c.kind !== "points") throw new Error("expected points");
    const byIndex = new Map(w.perOption.map((o) => [o.index, o]));
    for (let i = 0; i < c.rows.length; i++) {
      const o = byIndex.get(i);
      // Points denominator is the question-level answeredWeight (not per-option).
      const avg = o ? Number(o.weightedSum) / Number(w.answeredWeight) : 0;
      expect(avg).toBe(c.rows[i]!.avg);
    }
  });

  it("matches rating averages", () => {
    const c = counted[5]!;
    const w = weighted[5]! as Extract<
      WeightedQuestionTally,
      { kind: "perOption" }
    >;
    if (c.kind !== "rating") throw new Error("expected rating");
    const byIndex = new Map(w.perOption.map((o) => [o.index, o]));
    for (let i = 0; i < c.rows.length; i++) {
      const o = byIndex.get(i);
      const avg = o ? Number(o.weightedSum) / Number(o.answeredWeight) : 0;
      expect(avg).toBe(c.rows[i]!.avg);
    }
  });

  it("matches custom participation", () => {
    const c = counted[6]!;
    const w = weighted[6]!;
    if (c.kind !== "custom") throw new Error("expected custom");
    expect(w.answeredCount).toBe(c.answered);
    expect(Number(w.answeredWeight)).toBe(c.answered);
  });
});

// --- DoS resistance: the display path caps its dense buckets --------------------

describe("display tally resists a hostile huge declared span", () => {
  it("caps buckets so the browser path can't be forced to allocate", () => {
    const def: SurveyDefinition = {
      ...DEF,
      questions: [
        {
          type: "singleChoice",
          prompt: "",
          options: { type: "count", count: 2 ** 40 },
        },
        {
          type: "rating",
          prompt: "",
          options: OPTS,
          scale: {
            type: "numeric",
            constraints: { min: 0n, max: BigInt(2 ** 40), step: 1n },
          },
          requireAll: false,
        },
      ],
    };
    const resp = respWith(1, [
      { type: "singleChoice", questionIndex: 0, optionIndex: 3 },
      {
        type: "rating",
        questionIndex: 1,
        ratings: [{ optionIndex: 0, rating: 7n }],
      },
    ]);
    // The old dense `new Array(count)` / `new Array(levels)` would RangeError.
    const [choice, rating] = tallySurvey(def, [resp], 1);
    if (choice!.kind !== "bars") throw new Error("expected bars");
    expect(choice.bars.length).toBeLessThanOrEqual(MAX_DISPLAY_BUCKETS);
    expect(choice.bars[3]!.count).toBe(1); // the answered option is present
    if (rating!.kind !== "rating") throw new Error("expected rating");
    expect(rating.rows[0]!.counts.length).toBeLessThanOrEqual(
      MAX_DISPLAY_BUCKETS,
    );
  });
});
