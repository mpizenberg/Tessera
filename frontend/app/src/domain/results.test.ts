import { describe, expect, it } from "vitest";
import type { Question, Role, SurveyDefinition, SurveyResponse } from "cip-179";

import { hexToBytes } from "cip-179/domain";
import type { TallyArtifact } from "cip-179/tally";

import {
  MAX_DISPLAY_BUCKETS,
  fracOf,
  liveResults,
  ratioOf,
  artifactResults,
  questionView,
  type CountedResponse,
} from "./results";

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
});

describe("questionView", () => {
  it("bars: weights drive fills, labels come from the definition", () => {
    const v = questionView(SC, {
      kind: "options",
      unit: "singleChoice",
      options: [
        { index: 0, weight: "100", count: 1 },
        { index: 1, weight: "7", count: 1 },
      ],
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

  it("bars: a zero-answer option is refilled from the definition (sparse in, dense out)", () => {
    const v = questionView(SC, {
      kind: "options",
      unit: "singleChoice",
      // Only "yes" was chosen; the artifact omits "no" entirely.
      options: [{ index: 0, weight: "100", count: 2 }],
      answeredCount: 2,
      answeredWeight: "100",
    });
    if (v.kind !== "bars") throw new Error("expected bars");
    expect(v.bars).toEqual([
      { label: "yes", weight: 100n, count: 2, frac: 1 },
      { label: "no", weight: 0n, count: 0, frac: 0 },
    ]);
  });

  it("histogram: exact weighted mean, bins labeled by value", () => {
    const v = questionView(undefined, {
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
    const v = questionView(SC, {
      kind: "perOption",
      unit: "rating",
      // Only "yes" was rated; "no" is absent and refilled as an empty row.
      perOption: [
        { index: 0, weightedSum: "507", answeredWeight: "107", count: 2 },
      ],
      answeredCount: 2,
      answeredWeight: "107",
    });
    if (v.kind !== "rows") throw new Error("expected rows");
    expect(v.rows[0]).toEqual({ label: "yes", avg: 4.7383, count: 2 });
    expect(v.rows[1]).toEqual({ label: "no", avg: null, count: 0 });
  });

  it("rows: points means use the question-level denominator (no per-option answeredWeight)", () => {
    const v = questionView(SC, {
      kind: "perOption",
      unit: "points",
      // Points omits the per-option answeredWeight; both rows divide by the
      // question-level answeredWeight (200).
      perOption: [
        { index: 0, weightedSum: "300", count: 2 },
        { index: 1, weightedSum: "100", count: 1 },
      ],
      answeredCount: 2,
      answeredWeight: "200",
    });
    if (v.kind !== "rows") throw new Error("expected rows");
    expect(v.rows[0]).toEqual({ label: "yes", avg: 1.5, count: 2 }); // 300/200
    expect(v.rows[1]).toEqual({ label: "no", avg: 0.5, count: 1 }); // 100/200
  });
});

describe("artifactResults", () => {
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
              options: [
                { index: 0, weight: "100", count: 1 },
                { index: 1, weight: "150", count: 1 },
              ],
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
              // Only "yes" (index 0) got the vote; "no" is absent (sparse).
              options: [{ index: 0, weight: "1", count: 1 }],
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
    const [stakeholder, keyholder] = artifactResults(
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
    expect(stakeholder!.questions[0]!.view.kind).toBe("bars");
    expect(keyholder).toMatchObject({
      role: 4,
      votedWeight: 1n,
      total: null,
      turnout: null,
    });
  });

  it("one-vote weighting: same counted set, equal weights, no ada total", () => {
    const [stakeholder] = artifactResults(artifact, def, responses, "one");
    expect(stakeholder).toMatchObject({
      role: 3,
      responderCount: 2,
      votedWeight: null,
      total: null,
      turnout: null,
    });
    const q = stakeholder!.questions[0]!.view;
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
    const [stakeholder] = artifactResults(sealedArtifact, def, [], "one");
    const q = stakeholder!.questions[0]!.view;
    if (q.kind !== "bars") throw new Error("expected bars");
    expect(q.bars.map((b) => b.weight)).toEqual([1n, 1n]);
    expect(q.bars.map((b) => b.count)).toEqual([1, 1]);
    expect(q.bars.map((b) => b.frac)).toEqual([1, 1]);
  });
});

// --- the live path: the normative tally at unit weight -----------------------

describe("liveResults", () => {
  const NUM: Question = {
    type: "numericRange",
    prompt: "",
    constraints: { min: 0n, max: 100n },
  };
  const FREE: Question = {
    type: "custom",
    prompt: "",
    methodSchema: { uri: "ipfs://x", hash: new Uint8Array(32) },
  };
  const def = (questions: Question[]): SurveyDefinition => ({
    specVersion: 5,
    owner: { type: "key", keyHash: Uint8Array.of(0) },
    title: "t",
    description: "",
    eligibleRoles: [3] as Role[],
    endEpoch: 9,
    submissionMode: { type: "public" },
    questions,
  });
  function record(
    role: number,
    keyHashHex: string,
    answers: Extract<SurveyResponse["answers"], { type: "public" }>["answers"],
  ): CountedResponse {
    return {
      txHash: keyHashHex,
      responseIndex: 0,
      response: {
        specVersion: 5,
        surveyRef: { txId: hexToBytes("aa".repeat(32)), index: 0 },
        role: role as Role,
        credential: { type: "key", keyHash: hexToBytes(keyHashHex.repeat(28)) },
        answers: { type: "public", answers },
      },
    };
  }

  it("splits roles into independent electorates, role-ascending", () => {
    const roles = liveResults(def([SC]), [
      record(4, "aa", [
        { type: "singleChoice", questionIndex: 0, optionIndex: 0 },
      ]),
      record(3, "bb", [
        { type: "singleChoice", questionIndex: 0, optionIndex: 1 },
      ]),
      record(3, "cc", [
        { type: "singleChoice", questionIndex: 0, optionIndex: 1 },
      ]),
    ]);
    expect(roles.map((r) => [r.role, r.responderCount])).toEqual([
      [3, 2],
      [4, 1],
    ]);
    // No stake snapshot exists before finalization, so there is nothing to
    // weigh by and no turnout to report.
    expect(roles.every((r) => r.votedWeight === null && r.total === null)).toBe(
      true,
    );
    const view = roles[0]!.questions[0]!.view;
    if (view.kind !== "bars") throw new Error("expected bars");
    expect(view.bars.map((b) => b.count)).toEqual([0, 2]);
    expect(view.bars.map((b) => b.weight)).toEqual([0n, 2n]);
  });

  it("a sealed response counts as a responder but answers nothing", () => {
    const sealed: CountedResponse = {
      txHash: "dd",
      responseIndex: 0,
      response: {
        specVersion: 5,
        surveyRef: { txId: hexToBytes("aa".repeat(32)), index: 0 },
        role: 3 as Role,
        credential: { type: "key", keyHash: hexToBytes("dd".repeat(28)) },
        answers: { type: "sealed", ciphertext: new Uint8Array([1, 2, 3]) },
      },
    };
    const [role] = liveResults(def([SC]), [
      record(3, "bb", [
        { type: "singleChoice", questionIndex: 0, optionIndex: 0 },
      ]),
      sealed,
    ]);
    expect(role!.responderCount).toBe(2);
    expect(role!.questions[0]!.view.answeredCount).toBe(1);
  });

  it("numeric: weighted median matches the ordinary median at unit weight", () => {
    const values = (xs: number[]): CountedResponse[] =>
      xs.map((x, i) =>
        record(3, String(i).padStart(2, "0"), [
          { type: "numeric", questionIndex: 0, value: BigInt(x) },
        ]),
      );
    const median = (xs: number[]): number | null => {
      const view = liveResults(def([NUM]), values(xs))[0]!.questions[0]!.view;
      if (view.kind !== "histogram") throw new Error("expected histogram");
      return view.median;
    };
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5); // even count: the two middles
    expect(median([5])).toBe(5);
    expect(median([1, 1, 1, 9])).toBe(1);
  });

  it("custom: verbatim answers come back as supplementary detail, capped", () => {
    const records = Array.from({ length: 9 }, (_, i) =>
      record(3, String(i).padStart(2, "0"), [
        { type: "custom", questionIndex: 0, value: `answer ${i}` },
      ]),
    );
    const [role] = liveResults(def([FREE]), records);
    expect(role!.questions[0]!.view.answeredCount).toBe(9);
    expect(role!.questions[0]!.detail.samples).toEqual([
      "answer 0",
      "answer 1",
      "answer 2",
      "answer 3",
      "answer 4",
      "answer 5",
    ]);
  });

  it("no supplementary detail for a question kind that has none", () => {
    const [role] = liveResults(def([SC]), [
      record(3, "bb", [
        { type: "singleChoice", questionIndex: 0, optionIndex: 0 },
      ]),
    ]);
    expect(role!.questions[0]!.detail).toEqual({});
  });

  it("caps the buckets a hostile declared option count can force", () => {
    const hostile = def([
      {
        type: "singleChoice",
        prompt: "",
        options: { type: "count", count: 2 ** 40 },
      },
    ]);
    // A dense refill over the declared width would RangeError long before this.
    const view = liveResults(hostile, [
      record(3, "bb", [
        { type: "singleChoice", questionIndex: 0, optionIndex: 3 },
      ]),
    ])[0]!.questions[0]!.view;
    if (view.kind !== "bars") throw new Error("expected bars");
    expect(view.bars.length).toBeLessThanOrEqual(MAX_DISPLAY_BUCKETS);
    expect(view.bars[3]!.count).toBe(1); // the answered option is still there
  });
});
