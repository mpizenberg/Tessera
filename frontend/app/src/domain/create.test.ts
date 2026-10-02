import { describe, expect, test } from "vitest";

import {
  Role,
  SPEC_VERSION,
  decodePayload,
  encodePayload,
  type Credential,
  type OptionsOrCount,
  type Question,
  type SurveyDefinition,
} from "cip-179";
import { QUICKNET_CHAIN_HASH, maxPlaintextSize } from "cip-179/tlock";

import type { Presentation } from "~/enrichment/presentation";
import {
  buildDefinition,
  buildPresentationDoc,
  formFromDefinition,
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

describe("formFromDefinition", () => {
  const questions: Question[] = [
    {
      type: "singleChoice",
      prompt: "Which?",
      required: true,
      options: { type: "options", labels: ["a", "b", "c"] },
    },
    {
      type: "multiSelect",
      prompt: "Which ones?",
      options: { type: "options", labels: ["a", "b", "c"] },
      minSelections: 1,
      maxSelections: 2,
    },
    {
      type: "ranking",
      prompt: "Order them",
      options: { type: "options", labels: ["a", "b", "c"] },
      minRanked: 2,
      maxRanked: 3,
    },
    {
      type: "numericRange",
      prompt: "How much?",
      required: true,
      constraints: { min: -(2n ** 64n - 1n), max: 2n ** 64n - 1n },
    },
    {
      type: "numericRange",
      prompt: "How many, by fives?",
      constraints: { min: 0n, max: 100n, step: 5n },
    },
    {
      type: "pointsAllocation",
      prompt: "Split it",
      options: { type: "options", labels: ["a", "b"] },
      budget: 1000n,
    },
    {
      type: "rating",
      prompt: "Rate them",
      options: { type: "options", labels: ["a", "b"] },
      scale: { type: "numeric", constraints: { min: 1n, max: 9n, step: 2n } },
      requireAll: false,
    },
    {
      type: "rating",
      prompt: "Judge them",
      options: { type: "options", labels: ["a", "b"] },
      scale: { type: "labels", labels: ["bad", "fine", "good"] },
      requireAll: true,
    },
    {
      type: "custom",
      prompt: "Anything",
      methodSchema: { uri: "ipfs://schema", hash: new Uint8Array(32).fill(9) },
    },
  ];

  const definition = (
    over: Partial<SurveyDefinition> = {},
  ): SurveyDefinition => ({
    specVersion: SPEC_VERSION,
    owner,
    title: "Survey",
    description: "About things",
    eligibleRoles: [Role.DRep, Role.Stakeholder],
    endEpoch: 500,
    submissionMode: { type: "public" },
    questions,
    ...over,
  });

  /** The definition the form builds, with the round the screen would set. */
  const rebuilt = (
    def: SurveyDefinition,
    presentation?: Presentation,
  ): ReturnType<typeof buildDefinition> => {
    const form = formFromDefinition(def, presentation);
    const mode = def.submissionMode;
    return buildDefinition(
      owner,
      {
        ...form.meta,
        sealedRound: mode.type === "sealed" ? String(mode.round) : "",
      },
      form.questions,
      { contentAnchor: def.contentAnchor },
    );
  };

  /** The definition as a file brings it: through the wire format and back. */
  const fromFile = (def: SurveyDefinition): SurveyDefinition => {
    const payload = decodePayload(
      encodePayload({ type: "definitions", definitions: [def] }),
    );
    if (payload.type !== "definitions") throw new Error(payload.type);
    return payload.definitions[0]!;
  };

  test("an embedded public survey with every question type comes back whole", () => {
    const def = fromFile(definition());
    expect(rebuilt(def)).toEqual({ definition: def, problems: [] });
  });

  test("a sealed survey keeps its padding; the automatic one stays automatic", () => {
    const sealed = (paddingSize: number) =>
      fromFile(
        definition({
          submissionMode: {
            type: "sealed",
            chainHash: QUICKNET_CHAIN_HASH,
            round: 12345,
            paddingSize,
          },
        }),
      );
    const auto = sealed(maxPlaintextSize(questions));
    expect(formFromDefinition(auto).meta.sealedPadding).toBe("");
    expect(rebuilt(auto)).toEqual({ definition: auto, problems: [] });

    const fixed = sealed(4096);
    expect(formFromDefinition(fixed).meta.sealedPadding).toBe("4096");
    expect(rebuilt(fixed)).toEqual({ definition: fixed, problems: [] });
  });

  test("a sealed survey on another drand chain comes back on quicknet", () => {
    const def = definition({
      submissionMode: {
        type: "sealed",
        chainHash: new Uint8Array(32).fill(1),
        round: 12345,
        paddingSize: 4096,
      },
    });
    expect(rebuilt(def).definition?.submissionMode).toEqual({
      type: "sealed",
      chainHash: QUICKNET_CHAIN_HASH,
      round: 12345,
      paddingSize: 4096,
    });
  });

  describe("external content", () => {
    // The on-chain half: no text, option and level lists as counts.
    const counted = (o: OptionsOrCount): OptionsOrCount => ({
      type: "count",
      count: o.type === "options" ? o.labels.length : o.count,
    });
    const countForm = (q: Question): Question => {
      const prompt = "";
      switch (q.type) {
        case "custom":
        case "numericRange":
          return { ...q, prompt };
        case "rating":
          return {
            ...q,
            prompt,
            options: counted(q.options),
            scale:
              q.scale.type === "labels"
                ? { type: "count", count: q.scale.labels.length }
                : q.scale,
          };
        default:
          return { ...q, prompt, options: counted(q.options) };
      }
    };
    const def = fromFile(
      definition({
        title: "",
        description: "",
        questions: questions.map(countForm),
        contentAnchor: { uri: "ipfs://doc", hash: new Uint8Array(32).fill(3) },
      }),
    );
    const presentation: Presentation = {
      title: "Survey",
      description: "About things",
      questions: questions.map((q) => ({
        prompt: q.prompt,
        ...("options" in q && q.options.type === "options"
          ? { options: q.options.labels }
          : {}),
        ...(q.type === "rating" && q.scale.type === "labels"
          ? { ratingLabels: q.scale.labels }
          : {}),
      })),
    };

    test("the definition comes back up to its anchor, the text from the document", () => {
      expect(rebuilt(def, presentation)).toEqual({
        definition: def,
        problems: [],
      });
      const form = formFromDefinition(def, presentation);
      expect(
        buildPresentationDoc({ ...form.meta, sealedRound: "" }, form.questions),
      ).toMatchObject(presentation);
    });

    test("without the document, the text comes back blank and the counts as blank rows", () => {
      const form = formFromDefinition(def);
      expect(form.meta).toMatchObject({
        contentMode: "external",
        title: "",
        description: "",
      });
      expect(form.questions.map((q) => q.prompt)).toEqual(
        questions.map(() => ""),
      );
      expect(form.questions[0]!.labels).toEqual(["", "", ""]);
      expect(form.questions[7]!.ratingLabels).toEqual(["", "", ""]);
    });
  });
});
