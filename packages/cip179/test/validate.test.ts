import { describe, expect, it } from "vitest";

import {
  describeProblem,
  describeProblems,
  Role,
  validateDefinition,
  validateResponse,
  VALIDATION_PROBLEM_CODES,
  type SurveyDefinition,
  type SurveyResponse,
} from "../src/index.js";

const bytes = (n: number, fill = 0): Uint8Array => new Uint8Array(n).fill(fill);

const singleChoiceDef = (): SurveyDefinition => ({
  specVersion: 5,
  owner: { type: "key", keyHash: bytes(28, 1) },
  title: "",
  description: "",
  eligibleRoles: [Role.DRep],
  endEpoch: 1,
  submissionMode: { type: "public" },
  questions: [
    {
      type: "singleChoice",
      prompt: "",
      required: true,
      options: { type: "options", labels: ["a", "b"] },
    },
  ],
});

const responseWith = (optionIndex: number): SurveyResponse => ({
  specVersion: 5,
  surveyRef: { txId: bytes(32), index: 0 },
  role: Role.DRep,
  credential: { type: "key", keyHash: bytes(28) },
  answers: {
    type: "public",
    answers: [{ type: "singleChoice", questionIndex: 0, optionIndex }],
  },
});

describe("structured validation problems", () => {
  it("returns a stable code + params instead of prose", () => {
    const problems = validateResponse(singleChoiceDef(), responseWith(9));
    expect(problems).toEqual([
      {
        code: "answer.optionIndexOutOfRange",
        params: { where: "answers[0]", index: 9 },
      },
    ]);
  });

  it("keeps returning [] for a valid response (verdict unchanged)", () => {
    expect(validateResponse(singleChoiceDef(), responseWith(0))).toEqual([]);
  });

  it("emits codes drawn only from the frozen code set", () => {
    const def = singleChoiceDef();
    // Ineligible role + out-of-range option → two distinct problems.
    const res = { ...responseWith(9), role: Role.SPO };
    const problems = validateResponse(def, res);
    expect(problems.length).toBe(2);
    for (const p of problems) {
      expect(VALIDATION_PROBLEM_CODES).toContain(p.code);
    }
  });

  it("flags an over-long option label with the max byte param", () => {
    const def = singleChoiceDef();
    (def.questions[0] as { options: { labels: string[] } }).options.labels = [
      "ok",
      "x".repeat(65),
    ];
    const problems = validateDefinition(def);
    expect(problems).toContainEqual({
      code: "question.labelTooLong",
      params: { where: "questions[0]", index: 1, max: 64 },
    });
  });
});

describe("describeProblem (English fallback rendering)", () => {
  it("interpolates params into the English template", () => {
    expect(
      describeProblem({
        code: "answer.optionIndexOutOfRange",
        params: { where: "answers[0]", index: 9 },
      }),
    ).toBe("answers[0]: option index 9 out of range");
  });

  it("renders paramless problems verbatim", () => {
    expect(describeProblem({ code: "response.sealedRequired" })).toBe(
      "sealed survey requires a sealed (ciphertext) response",
    );
  });

  it("has a non-empty template for every declared code", () => {
    for (const code of VALIDATION_PROBLEM_CODES) {
      const text = describeProblem({ code });
      expect(text.length).toBeGreaterThan(0);
      // The template itself may keep {tokens} when params are omitted; the point
      // is a real message exists (not the raw code) for each declared problem.
      expect(text).not.toBe(code);
    }
  });

  it("maps a list with describeProblems", () => {
    const problems = validateResponse(singleChoiceDef(), responseWith(9));
    expect(describeProblems(problems)).toEqual([
      "answers[0]: option index 9 out of range",
    ]);
  });
});
