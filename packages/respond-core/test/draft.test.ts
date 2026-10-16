import { describe, expect, it } from "vitest";

import {
  Role,
  SPEC_VERSION,
  type Credential,
  type Metadatum,
  type Question,
  type SurveyRef,
} from "cip-179";

import {
  buildResponse,
  buildSealedResponse,
  collectAnswers,
  draftState,
  findPriorResponse,
  initDraft,
  prefillDrafts,
  type Draft,
} from "../src/index.js";

const single: Question = {
  type: "singleChoice",
  prompt: "pick one",
  required: true,
  options: { type: "options", labels: ["a", "b", "c"] },
};

const numeric: Question = {
  type: "numericRange",
  prompt: "how many",
  required: false,
  constraints: { min: 0n, max: 10n },
};

const questions: Question[] = [single, numeric];

const ref: SurveyRef = { txId: new Uint8Array(32), index: 0 };
const credential: Credential = { type: "key", keyHash: new Uint8Array(28) };

describe("draftState", () => {
  it("an untouched single choice is unanswered", () => {
    expect(draftState(single, initDraft(single))).toBe("unanswered");
  });

  it("a chosen option answers it", () => {
    const draft: Draft = {
      skipped: false,
      value: { type: "singleChoice", optionIndex: 1 },
    };
    expect(draftState(single, draft)).toBe("answered");
  });

  it("a skip outranks the value", () => {
    const draft: Draft = {
      skipped: true,
      value: { type: "singleChoice", optionIndex: 1 },
    };
    expect(draftState(single, draft)).toBe("skipped");
  });

  it("an untouched number is unanswered and records nothing", () => {
    const untouched = initDraft(numeric);
    expect(draftState(numeric, untouched)).toBe("unanswered");
    expect(collectAnswers([numeric], [untouched])).toEqual([]);
  });

  it("a chosen zero answers the number and is recorded", () => {
    const zero: Draft = {
      skipped: false,
      value: { type: "numeric", value: 0n },
    };
    expect(draftState(numeric, zero)).toBe("answered");
    expect(collectAnswers([numeric], [zero])).toEqual([
      { type: "numeric", questionIndex: 0, value: 0n },
    ]);
  });

  const pickAny: Question = {
    type: "multiSelect",
    prompt: "pick any",
    required: false,
    options: { type: "options", labels: ["a", "b"] },
    minSelections: 0,
    maxSelections: 2,
  };

  it("an untouched selection is unanswered and records nothing, even when none is allowed", () => {
    const untouched = initDraft(pickAny);
    expect(draftState(pickAny, untouched)).toBe("unanswered");
    expect(collectAnswers([pickAny], [untouched])).toEqual([]);
  });

  it("a chosen none answers the selection and is recorded", () => {
    const none: Draft = {
      skipped: false,
      value: { type: "multiSelect", selected: [] },
    };
    expect(draftState(pickAny, none)).toBe("answered");
    expect(collectAnswers([pickAny], [none])).toEqual([
      { type: "multiSelect", questionIndex: 0, optionIndices: [] },
    ]);
  });

  const lovelace: Question = {
    type: "pointsAllocation",
    prompt: "split",
    options: { type: "options", labels: ["a", "b", "c"] },
    budget: 2n ** 60n + 1n,
  };

  it("points summing exactly to a budget beyond 2^53 answer it, zeros dropped", () => {
    const split: Draft = {
      skipped: false,
      value: { type: "pointsAllocation", points: [2n ** 60n, 0n, 1n] },
    };
    expect(draftState(lovelace, initDraft(lovelace))).toBe("unanswered");
    expect(draftState(lovelace, split)).toBe("answered");
    expect(collectAnswers([lovelace], [split])).toEqual([
      {
        type: "pointsAllocation",
        questionIndex: 0,
        allocations: [
          { optionIndex: 0, points: 2n ** 60n },
          { optionIndex: 2, points: 1n },
        ],
      },
    ]);
    const short: Draft = {
      skipped: false,
      value: { type: "pointsAllocation", points: [2n ** 60n, 0n, 0n] },
    };
    expect(draftState(lovelace, short)).toBe("unfinished");
  });
});

describe("drafts not answered record nothing", () => {
  const options = { type: "options", labels: ["a", "b", "c"] } as const;
  const every: Question[] = [
    single,
    {
      type: "multiSelect",
      prompt: "pick two",
      options,
      minSelections: 2,
      maxSelections: 3,
    },
    { type: "ranking", prompt: "rank", options, minRanked: 2, maxRanked: 3 },
    numeric,
    { type: "pointsAllocation", prompt: "split", options, budget: 10n },
    {
      type: "rating",
      prompt: "rate",
      options,
      scale: { type: "count", count: 5 },
      requireAll: true,
    },
    {
      type: "custom",
      prompt: "tell us",
      methodSchema: { uri: "ipfs://schema", hash: new Uint8Array(32) },
    },
  ];

  it("untouched, of every type", () => {
    const drafts = every.map(initDraft);
    expect(every.map((q, i) => draftState(q, drafts[i]!))).toEqual(
      every.map(() => "unanswered"),
    );
    expect(collectAnswers(every, drafts)).toEqual([]);
  });

  it("started but short of an answer", () => {
    const drafts: Draft[] = [
      initDraft(single),
      { skipped: false, value: { type: "multiSelect", selected: [0] } },
      { skipped: false, value: { type: "ranking", ranked: [2] } },
      initDraft(numeric),
      {
        skipped: false,
        value: { type: "pointsAllocation", points: [3n, 0n, 0n] },
      },
      { skipped: false, value: { type: "rating", ratings: [1n, null, 4n] } },
      { skipped: false, value: { type: "custom", text: "  " } },
    ];
    expect(every.map((q, i) => draftState(q, drafts[i]!))).toEqual([
      "unanswered",
      "unfinished",
      "unfinished",
      "unanswered",
      "unfinished",
      "unfinished",
      "unanswered",
    ]);
    expect(collectAnswers(every, drafts)).toEqual([]);
  });
});

describe("collectAnswers + buildResponse", () => {
  const drafts: Draft[] = [
    { skipped: false, value: { type: "singleChoice", optionIndex: 2 } },
    { skipped: true, value: { type: "numeric", value: 0n } },
  ];

  it("collects only non-skipped, answerable items", () => {
    expect(collectAnswers(questions, drafts)).toEqual([
      { type: "singleChoice", questionIndex: 0, optionIndex: 2 },
    ]);
  });

  it("assembles a public response envelope", () => {
    const response = buildResponse(
      ref,
      Role.Keyholder,
      credential,
      questions,
      drafts,
    );
    expect(response).toMatchObject({
      specVersion: SPEC_VERSION,
      surveyRef: ref,
      role: Role.Keyholder,
      credential,
      answers: {
        type: "public",
        answers: [{ type: "singleChoice", questionIndex: 0, optionIndex: 2 }],
      },
    });
    expect("rationale" in response).toBe(false);
  });
});

describe("findPriorResponse", () => {
  const drafts: Draft[] = [
    { skipped: false, value: { type: "singleChoice", optionIndex: 1 } },
    { skipped: true, value: { type: "numeric", value: 0n } },
  ];
  const other: Credential = {
    type: "key",
    keyHash: new Uint8Array(28).fill(9),
  };
  const publicPrior = buildResponse(
    ref,
    Role.Keyholder,
    credential,
    questions,
    drafts,
  );
  const sealedPrior = buildSealedResponse(
    ref,
    Role.DRep,
    credential,
    new Uint8Array([1, 2, 3]),
  );

  it("matches on survey ref, role and credential", () => {
    expect(
      findPriorResponse([publicPrior], ref, Role.Keyholder, credential),
    ).toBe(publicPrior);
    expect(
      findPriorResponse([publicPrior], ref, Role.DRep, credential),
    ).toBeUndefined();
    expect(
      findPriorResponse([publicPrior], ref, Role.Keyholder, other),
    ).toBeUndefined();
    expect(
      findPriorResponse(
        [publicPrior],
        { txId: new Uint8Array(32).fill(1), index: 0 },
        Role.Keyholder,
        credential,
      ),
    ).toBeUndefined();
  });

  it("finds a sealed prior: the envelope proves they answered", () => {
    expect(findPriorResponse([sealedPrior], ref, Role.DRep, credential)).toBe(
      sealedPrior,
    );
  });
});

describe("prefillDrafts", () => {
  it("round-trips answered questions and marks omitted (non-required) ones skipped", () => {
    const drafts: Draft[] = [
      { skipped: false, value: { type: "singleChoice", optionIndex: 1 } },
      { skipped: true, value: { type: "numeric", value: 0n } },
    ];
    const response = buildResponse(
      ref,
      Role.Keyholder,
      credential,
      questions,
      drafts,
    );
    const refilled = prefillDrafts(questions, response);
    expect(refilled[0]).toEqual({
      skipped: false,
      value: { type: "singleChoice", optionIndex: 1 },
    });
    // q1 was omitted and isn't required → reconstructed as a skip.
    expect(refilled[1]!.skipped).toBe(true);
  });
});

describe("custom answers", () => {
  const custom: Question = {
    type: "custom",
    prompt: "tell us",
    required: false,
    methodSchema: { uri: "ipfs://schema", hash: new Uint8Array(32) },
  };
  const text = (t: string): Draft => ({
    skipped: false,
    value: { type: "custom", text: t },
  });
  const valueOf = (t: string) => collectAnswers([custom], [text(t)])[0];

  it("writes text up to 64 bytes as one string", () => {
    const t = "a".repeat(64);
    expect(valueOf(t)).toEqual({ type: "custom", questionIndex: 0, value: t });
  });

  it("writes longer text as 64-byte chunks", () => {
    expect(valueOf("a".repeat(65))).toMatchObject({
      value: ["a".repeat(64), "a"],
    });
  });

  it("never splits a code point across chunks", () => {
    // 63 one-byte chars then a 4-byte emoji: the emoji moves to chunk two.
    expect(valueOf(`${"a".repeat(63)}🙂`)).toMatchObject({
      value: ["a".repeat(63), "🙂"],
    });
  });

  it("prefills from either form, and blank from any other value", () => {
    const prefilled = (value: Metadatum) =>
      prefillDrafts([custom], {
        specVersion: SPEC_VERSION,
        surveyRef: ref,
        role: Role.Keyholder,
        credential,
        answers: {
          type: "public",
          answers: [{ type: "custom", questionIndex: 0, value }],
        },
      })[0]!.value;
    expect(prefilled("short")).toEqual({ type: "custom", text: "short" });
    expect(prefilled(["a".repeat(64), "b"])).toEqual({
      type: "custom",
      text: `${"a".repeat(64)}b`,
    });
    expect(prefilled(7n)).toEqual({ type: "custom", text: "" });
  });

  it("a text over maxTextBytes is unfinished", () => {
    // "é" is two UTF-8 bytes: four of them are 8 bytes, one character count off.
    expect(draftState(custom, text("éééé"), 8)).toBe("answered");
    expect(draftState(custom, text("éééé"), 7)).toBe("unfinished");
    expect(draftState(custom, text("éééé"))).toBe("answered");
  });
});
