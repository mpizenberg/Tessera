import { describe, expect, it } from "vitest";

import {
  Role,
  SPEC_VERSION,
  type Credential,
  type Question,
  type SurveyRef,
} from "cip-179";

import {
  buildResponse,
  buildSealedResponse,
  collectAnswers,
  decided,
  findPriorResponse,
  hasAnyAnswer,
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

describe("decided", () => {
  it("an un-answered required single-choice is not decided", () => {
    expect(decided(single, initDraft(single))).toBe(false);
  });

  it("a chosen option decides it", () => {
    const draft: Draft = {
      skipped: false,
      value: { type: "singleChoice", optionIndex: 1 },
    };
    expect(decided(single, draft)).toBe(true);
  });

  it("skip counts as decided (deliberate abstention)", () => {
    expect(decided(single, { ...initDraft(single), skipped: true })).toBe(true);
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

describe("hasAnyAnswer", () => {
  // Two optional questions: an all-skipped form is fully `decided()` yet records
  // nothing — the gap the submit gate must close (finding 9).
  const optionals: Question[] = [{ ...single, required: false }, numeric];

  it("is false when every question is skipped (all-optional form)", () => {
    const drafts: Draft[] = optionals.map((q) => ({
      ...initDraft(q),
      skipped: true,
    }));
    expect(drafts.every((d, i) => decided(optionals[i]!, d))).toBe(true);
    expect(hasAnyAnswer(optionals, drafts)).toBe(false);
  });

  it("is true once one question carries an answer", () => {
    const drafts: Draft[] = [
      { skipped: false, value: { type: "singleChoice", optionIndex: 0 } },
      { skipped: true, value: { type: "numeric", value: 0n } },
    ];
    expect(hasAnyAnswer(optionals, drafts)).toBe(true);
  });

  it("is guard-safe against a transiently-missing draft", () => {
    expect(hasAnyAnswer(optionals, [])).toBe(false);
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
