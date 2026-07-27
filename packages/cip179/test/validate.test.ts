import { describe, expect, it } from "vitest";

import {
  definitionErrors,
  describeProblem,
  describeProblems,
  isDefinitionTalliable,
  isSurveyTalliable,
  problemSeverity,
  Role,
  surveyErrors,
  validateDefinition,
  validateResponse,
  VALIDATION_PROBLEM_CODES,
  type SurveyDefinition,
  type SurveyResponse,
} from "../src/index.js";
import type { SurveyRecord } from "../src/domain/index.js";

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

  it("flags an empty public answers array (finding 9)", () => {
    // The decoder rejects `[]`, but the responder UIs and a revealed sealed
    // plaintext build a public answer set without it — so the validator is the
    // backstop. Use an *optional* question to isolate `answersEmpty` (a required
    // one would also add `requiredNotAnswered`).
    const def = singleChoiceDef();
    (def.questions[0] as { required: boolean }).required = false;
    const empty: SurveyResponse = {
      ...responseWith(0),
      answers: { type: "public", answers: [] },
    };
    expect(validateResponse(def, empty)).toEqual([
      { code: "response.answersEmpty" },
    ]);
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

describe("definition severity + talliability (findings 10, 11, 34)", () => {
  it("a valid v5 definition has no problems and is talliable", () => {
    const def = singleChoiceDef();
    expect(validateDefinition(def)).toEqual([]);
    expect(isDefinitionTalliable(def)).toBe(true);
  });

  it("duplicate eligible_roles is a SHOULD → warning, still talliable (finding 34)", () => {
    const def: SurveyDefinition = {
      ...singleChoiceDef(),
      eligibleRoles: [Role.DRep, Role.DRep] as Role[],
    };
    expect(validateDefinition(def)).toEqual([
      { code: "definition.eligibleRolesDuplicate", severity: "warning" },
    ]);
    // Warnings never disqualify: a spec-valid foreign survey stays talliable.
    expect(definitionErrors(def)).toEqual([]);
    expect(isDefinitionTalliable(def)).toBe(true);
  });

  it("a non-v5 spec_version is an error → untalliable (finding 10)", () => {
    const def: SurveyDefinition = { ...singleChoiceDef(), specVersion: 6 };
    expect(isDefinitionTalliable(def)).toBe(false);
    expect(definitionErrors(def).map((p) => p.code)).toContain(
      "definition.specVersionUnsupported",
    );
  });

  it("a structurally-invalid definition (no questions) is untalliable (finding 11)", () => {
    const def: SurveyDefinition = { ...singleChoiceDef(), questions: [] };
    expect(isDefinitionTalliable(def)).toBe(false);
    expect(definitionErrors(def).map((p) => p.code)).toContain(
      "definition.noQuestions",
    );
  });

  // Finding 45 — CIP-179 §Epoch Semantics: end_epoch MUST be greater than the
  // epoch the definition transaction was included in. Only the record knows the
  // latter, which is why the gate takes one.
  describe("end_epoch against the inclusion epoch", () => {
    const record = (endEpoch: number, epochNo: number): SurveyRecord => ({
      txHash: "ab".repeat(32),
      slot: 1,
      epochNo,
      ref: { txId: bytes(32), index: 0 },
      definition: { ...singleChoiceDef(), endEpoch },
    });

    it("is talliable when end_epoch is past the inclusion epoch", () => {
      expect(isSurveyTalliable(record(11, 10))).toBe(true);
      expect(surveyErrors(record(11, 10))).toEqual([]);
    });

    it("is untalliable when the survey ends in the epoch that published it", () => {
      expect(isSurveyTalliable(record(10, 10))).toBe(false);
      expect(surveyErrors(record(10, 10))).toContainEqual({
        code: "definition.endEpochNotAfterInclusion",
        params: { endEpoch: 10, inclusionEpoch: 10 },
      });
    });

    it("is untalliable when end_epoch is already past", () => {
      expect(isSurveyTalliable(record(9, 10))).toBe(false);
    });

    it("leaves the definition-only gate alone — the rule needs the record", () => {
      const same = record(10, 10);
      expect(isDefinitionTalliable(same.definition)).toBe(true);
      expect(definitionErrors(same.definition)).toEqual([]);
    });
  });

  it("error problems carry no severity field and default to 'error'", () => {
    const def: SurveyDefinition = { ...singleChoiceDef(), questions: [] };
    const [p] = validateDefinition(def);
    expect(p!.severity).toBeUndefined();
    expect(problemSeverity(p!)).toBe("error");
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
