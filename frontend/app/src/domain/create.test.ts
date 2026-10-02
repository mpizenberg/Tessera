import { describe, expect, test } from "vitest";

import { Role, type Credential } from "cip-179";

import {
  buildDefinition,
  initDefinitionMeta,
  initQuestionDraft,
  type DefinitionMeta,
  type QuestionDraft,
} from "./create";

const owner: Credential = { type: "key", keyHash: new Uint8Array(28) };

const meta = (over: Partial<DefinitionMeta> = {}): DefinitionMeta => ({
  ...initDefinitionMeta(),
  title: "Survey",
  eligibleRoles: [Role.Stakeholder],
  endEpoch: "500",
  ...over,
});

const numeric = (over: Partial<QuestionDraft> = {}): QuestionDraft => ({
  ...initQuestionDraft("numericRange"),
  prompt: "How many?",
  ...over,
});

const single = (): QuestionDraft => ({
  ...initQuestionDraft("singleChoice"),
  prompt: "Which?",
  labels: ["a", "b"],
});

const MAX = "18446744073709551615";

describe("buildDefinition", () => {
  test("a form that parses builds its definition, with no problems", () => {
    const b = buildDefinition(owner, meta(), [numeric(), single()]);
    expect(b.problems).toEqual([]);
    expect(b.definition?.endEpoch).toBe(500);
    expect(b.definition?.questions[0]).toMatchObject({
      type: "numericRange",
      constraints: { min: 0n, max: 10n },
    });
  });

  test("integers reach cardano-cli's range, ±(2^64−1), and no further", () => {
    const edges = buildDefinition(owner, meta(), [
      numeric({ numMin: `-${MAX}`, numMax: MAX }),
    ]);
    expect(edges.problems).toEqual([]);
    expect(edges.definition?.questions[0]).toMatchObject({
      constraints: { min: -(2n ** 64n - 1n), max: 2n ** 64n - 1n },
    });

    const beyond = buildDefinition(owner, meta(), [
      numeric({
        numMin: "-18446744073709551616",
        numMax: "18446744073709551616",
      }),
    ]);
    expect(beyond.definition).toBeUndefined();
    expect(beyond.problems).toEqual([
      {
        code: "form.outOfRange",
        field: "min",
        question: 0,
        params: { text: "-18446744073709551616", min: `-${MAX}`, max: MAX },
      },
      {
        code: "form.outOfRange",
        field: "max",
        question: 0,
        params: { text: "18446744073709551616", min: `-${MAX}`, max: MAX },
      },
    ]);
  });

  test("a field that does not parse leaves no definition and hides rule problems", () => {
    // max < min is a codec rule; it only shows once the budget parses.
    const points: QuestionDraft = {
      ...initQuestionDraft("pointsAllocation"),
      labels: ["a", "b"],
      budget: "12abc",
    };
    const b = buildDefinition(owner, meta(), [
      numeric({ numMin: "5", numMax: "1" }),
      points,
    ]);
    expect(b.definition).toBeUndefined();
    expect(b.problems).toEqual([
      {
        code: "form.notWholeNumber",
        field: "budget",
        question: 1,
        params: { text: "12abc" },
      },
    ]);

    const fixed = buildDefinition(owner, meta(), [
      numeric({ numMin: "5", numMax: "1" }),
      { ...points, budget: "100" },
    ]);
    expect(fixed.definition).toBeDefined();
    expect(fixed.problems).toMatchObject([{ code: "question.maxLessThanMin" }]);
  });

  test("counts are whole numbers from zero, typed as text", () => {
    const multi: QuestionDraft = {
      ...initQuestionDraft("multiSelect"),
      labels: ["a", "b"],
      minSelections: "",
      maxSelections: "-1",
    };
    const b = buildDefinition(owner, meta(), [multi]);
    expect(b.definition).toBeUndefined();
    expect(b.problems).toMatchObject([
      { code: "form.notWholeNumber", field: "minSelections", question: 0 },
      { code: "form.outOfRange", field: "maxSelections", question: 0 },
    ]);

    const ok = buildDefinition(owner, meta(), [
      { ...multi, minSelections: "1", maxSelections: " 2 " },
    ]);
    expect(ok.problems).toEqual([]);
    expect(ok.definition?.questions[0]).toMatchObject({
      minSelections: 1,
      maxSelections: 2,
    });
  });

  test("the end epoch must parse", () => {
    for (const endEpoch of ["", "1e3", "-5"]) {
      const b = buildDefinition(owner, meta({ endEpoch }), [single()]);
      expect(b.definition).toBeUndefined();
      expect(b.problems).toMatchObject([{ field: "endEpoch" }]);
      expect(b.problems[0]).not.toHaveProperty("question");
    }
  });

  test("a custom question needs a URI and a 32-byte hash", () => {
    const custom: QuestionDraft = {
      ...initQuestionDraft("custom"),
      customUri: " ",
      customHash: "zz",
    };
    expect(buildDefinition(owner, meta(), [custom]).problems).toMatchObject([
      { code: "form.missing", field: "customUri" },
      { code: "form.notHex", field: "customHash" },
    ]);
    const short = buildDefinition(owner, meta(), [
      { ...custom, customUri: "ipfs://x", customHash: "ab" },
    ]);
    expect(short.problems).toMatchObject([
      { code: "form.hashLength", field: "customHash" },
    ]);
    const ok = buildDefinition(owner, meta(), [
      { ...custom, customUri: "ipfs://x", customHash: "ab".repeat(32) },
    ]);
    expect(ok.problems).toEqual([]);
  });

  describe("sealed", () => {
    const sealed = (over: Partial<DefinitionMeta>) =>
      buildDefinition(owner, meta({ mode: "sealed", ...over }), [single()]);

    test("a blank padding is sized automatically, a typed one is kept", () => {
      const auto = sealed({ sealedRound: "1000" });
      expect(auto.problems).toEqual([]);
      expect(auto.definition?.submissionMode).toMatchObject({
        type: "sealed",
        round: 1000,
      });
      const typed = sealed({ sealedRound: "1000", sealedPadding: "512" });
      expect(typed.definition?.submissionMode).toMatchObject({
        paddingSize: 512,
      });
    });

    test("round and padding must parse; zero is the codec's to refuse", () => {
      expect(
        sealed({ sealedRound: "12abc", sealedPadding: "x" }).problems,
      ).toMatchObject([
        { code: "form.notWholeNumber", field: "revealRound" },
        { code: "form.notWholeNumber", field: "padding" },
      ]);
      expect(
        sealed({ sealedRound: "0", sealedPadding: "0" }).problems,
      ).toMatchObject([
        { code: "definition.sealedRoundInvalid" },
        { code: "definition.sealedPaddingInvalid" },
      ]);
    });

    test("a public survey ignores them", () => {
      const b = buildDefinition(
        owner,
        meta({ sealedRound: "12abc", sealedPadding: "x" }),
        [single()],
      );
      expect(b.problems).toEqual([]);
      expect(b.definition?.submissionMode).toEqual({ type: "public" });
    });
  });
});
