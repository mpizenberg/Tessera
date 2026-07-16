import { describe, expect, it } from "vitest";
import type {
  AnswerItem,
  Question,
  Role,
  SurveyDefinition,
  SurveyResponse,
} from "../index.js";

import { MAX_DISPLAY_BUCKETS, tallySurvey } from "./tally.js";
import {
  weightedTallyQuestion,
  weightedTallySurvey,
  type WeightedQuestionTally,
  type WeightedResponder,
} from "./weightedTally.js";

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

// --- per-kind behaviour --------------------------------------------------------

describe("weightedTallyQuestion", () => {
  const all = [R1, R2, R3];

  it("options: buckets weight and count per chosen option (sparse — no zero option)", () => {
    const t = weightedTallyQuestion(QUESTIONS[0]!, 0, all);
    expect(t).toEqual({
      kind: "options",
      unit: "singleChoice",
      // Option "c" (index 2) got no votes → absent, not a zero bucket.
      options: [
        { index: 0, weight: 100n, count: 1 },
        { index: 1, weight: 7n, count: 1 },
      ],
      answeredCount: 2,
      answeredWeight: 107n,
    });
  });

  it("multiSelect: a responder's full weight lands on each selection", () => {
    const t = weightedTallyQuestion(QUESTIONS[1]!, 1, all);
    expect(t).toMatchObject({
      unit: "multiSelect",
      options: [
        { index: 0, weight: 100n, count: 1 },
        { index: 1, weight: 7n, count: 1 },
        { index: 2, weight: 100n, count: 1 },
      ],
      answeredWeight: 107n,
    });
  });

  it("ranking: only the first preference is weighted", () => {
    const t = weightedTallyQuestion(QUESTIONS[2]!, 2, all);
    expect(t).toMatchObject({
      unit: "rankingFirst",
      // R2 top=0 (w7), R1 top=2 (w100); index 1 never leads → absent.
      options: [
        { index: 0, weight: 7n, count: 1 },
        { index: 2, weight: 100n, count: 1 },
      ],
    });
  });

  it("numeric: exact weighted sum + per-value histogram, values ascending", () => {
    const t = weightedTallyQuestion(QUESTIONS[3]!, 3, all);
    expect(t).toEqual({
      kind: "numeric",
      weightedSum: 100n * 10n + 7n * 40n + 3n * 10n, // 1310n
      answeredWeight: 110n,
      answeredCount: 3,
      values: [
        { value: 10n, weight: 103n, count: 2 },
        { value: 40n, weight: 7n, count: 1 },
      ],
    });
  });

  it("points: implicit zero allocations — every answerer backs every option", () => {
    const t = weightedTallyQuestion(QUESTIONS[4]!, 4, all);
    expect(t).toMatchObject({
      unit: "points",
      // Option 2 got no allocation → absent (sparse). Points entries carry no
      // per-option answeredWeight — the denominator is the survey-level
      // answeredWeight (107n), identical for every option.
      perOption: [
        { index: 0, weightedSum: 100n * 10n + 7n * 4n, count: 2 },
        { index: 1, weightedSum: 7n * 6n, count: 1 },
      ],
      answeredWeight: 107n,
    });
    if (t.kind !== "perOption") throw new Error("expected perOption");
    expect("answeredWeight" in t.perOption[0]!).toBe(false);
  });

  it("rating: per-option denominators cover only that option's raters", () => {
    const t = weightedTallyQuestion(QUESTIONS[5]!, 5, all);
    // R1 rated a=5 (w100); R2 rated a=1 (w7) and b=3 (w7). Option c (index 2)
    // unrated → absent. Each option's answeredWeight covers only its own raters,
    // so a's is 107n (both) but b's is 7n (R2 only) — the require_all=false case.
    expect(t).toMatchObject({
      unit: "rating",
      perOption: [
        {
          index: 0,
          weightedSum: 100n * 5n + 7n * 1n,
          answeredWeight: 107n,
          count: 2,
        },
        { index: 1, weightedSum: 7n * 3n, answeredWeight: 7n, count: 1 },
      ],
    });
    if (t.kind !== "perOption") throw new Error("expected perOption");
    expect(t.perOption).toHaveLength(2); // no entry for the unrated option
  });

  it("custom: participation only", () => {
    const t = weightedTallyQuestion(QUESTIONS[6]!, 6, all);
    expect(t).toEqual({
      kind: "custom",
      answeredCount: 2,
      answeredWeight: 107n,
    });
  });

  it("skips out-of-range option indices defensively", () => {
    const rogue = responder(9, 50n, [
      { type: "singleChoice", questionIndex: 0, optionIndex: 7 },
    ]);
    const t = weightedTallyQuestion(QUESTIONS[0]!, 0, [rogue]);
    expect(t).toMatchObject({
      options: [], // out-of-range selection lands nowhere → no buckets
      // It still *answered* (participation), the weight just lands nowhere.
      answeredCount: 1,
      answeredWeight: 50n,
    });
  });

  it("sealed answers never contribute", () => {
    const sealed: WeightedResponder = {
      ...R1,
      response: {
        ...R1.response,
        answers: { type: "sealed", ciphertext: Uint8Array.of(1) },
      },
    };
    const t = weightedTallyQuestion(QUESTIONS[0]!, 0, [sealed]);
    expect(t).toMatchObject({ answeredCount: 0, answeredWeight: 0n });
  });
});

// --- the cross-check: all weights 1n ⇔ the count tally --------------------------

describe("weightedTallySurvey with all weights 1n reproduces tally.ts counts", () => {
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

// --- DoS resistance: cost scales with responses, never the declared span -------

describe("resists a hostile huge declared span", () => {
  it("count-type options: only selected indices emitted, no giant allocation", () => {
    // 2^40 options: the old dense `new Array(count)` would RangeError/OOM here.
    const q: Question = {
      type: "singleChoice",
      prompt: "",
      options: { type: "count", count: 2 ** 40 },
    };
    const r = responder(1, 5n, [
      { type: "singleChoice", questionIndex: 0, optionIndex: 3 },
    ]);
    const t = weightedTallyQuestion(q, 0, [r]) as Extract<
      WeightedQuestionTally,
      { kind: "options" }
    >;
    expect(t.options).toEqual([{ index: 3, weight: 5n, count: 1 }]);
  });

  it("rating with an astronomically wide numeric scale: cost is per-rater, not per-span", () => {
    // A 2^40-wide scale: the hashed rating path never touches the scale span now
    // (the per-level histogram was dropped in ruleset v6), so nothing is sized by
    // the declared width — only the rated options are emitted.
    const q: Question = {
      type: "rating",
      prompt: "",
      options: OPTS,
      scale: {
        type: "numeric",
        constraints: { min: 0n, max: BigInt(2 ** 40), step: 1n },
      },
      requireAll: false,
    };
    const r = responder(1, 5n, [
      {
        type: "rating",
        questionIndex: 0,
        ratings: [{ optionIndex: 0, rating: 7n }],
      },
    ]);
    const t = weightedTallyQuestion(q, 0, [r]) as Extract<
      WeightedQuestionTally,
      { kind: "perOption" }
    >;
    expect(t.perOption).toEqual([
      { index: 0, weightedSum: 35n, answeredWeight: 5n, count: 1 },
    ]);
  });

  it("display tally caps buckets so the browser path can't be forced to allocate", () => {
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
