import { describe, expect, test } from "vitest";

import type { Question, SurveyDefinition } from "cip-179";

import {
  collectAnswers,
  hiddenQuestions,
  initDraft,
  readConditions,
  type Draft,
} from "../src/index.js";

const questions: Question[] = [
  {
    type: "singleChoice",
    prompt: "Do you build on Cardano?",
    options: { type: "options", labels: ["Yes", "No"] },
  },
  {
    type: "multiSelect",
    prompt: "Which languages?",
    minSelections: 0,
    maxSelections: 3,
    options: { type: "options", labels: ["Haskell", "Rust", "Aiken"] },
  },
  {
    type: "numericRange",
    prompt: "Years with Aiken?",
    constraints: { min: 0n, max: 20n },
  },
  {
    type: "custom",
    prompt: "Why not?",
    methodSchema: { uri: "ipfs://x", hash: new Uint8Array(32) },
    required: true,
  },
  {
    type: "custom",
    prompt: "Anything else?",
    methodSchema: { uri: "ipfs://x", hash: new Uint8Array(32) },
  },
];
const definition = { questions } as SurveyDefinition;

const single = (optionIndex: number | null): Draft => ({
  skipped: false,
  value: { type: "singleChoice", optionIndex },
});
const multi = (selected: number[] | null): Draft => ({
  skipped: false,
  value: { type: "multiSelect", selected },
});
const skipped = (d: Draft): Draft => ({ ...d, skipped: true });
const rest = questions.slice(2).map(initDraft);

// Question 1 shows for builders, question 2 for Aiken users.
const chain = readConditions(definition, {
  1: { question: 0, anyOf: [0] },
  2: { question: 1, anyOf: [2] },
});

describe("readConditions", () => {
  test("reads a well-formed document", () => {
    expect(chain.faults).toEqual([]);
    expect(chain.rules.map((r) => r !== undefined)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
  });

  test.each([
    ["a later question", { 1: { question: 2, anyOf: [0] } }],
    ["itself", { 1: { question: 1, anyOf: [0] } }],
    ["a question that is not a choice", { 4: { question: 2, anyOf: [0] } }],
    ["an out-of-range option", { 1: { question: 0, anyOf: [2] } }],
    ['"none" on a single choice', { 1: { question: 0, anyOf: ["none"] } }],
    ["no options", { 1: { question: 0, noneOf: [] } }],
    ["both tests", { 1: { question: 0, anyOf: [0], noneOf: [1] } }],
    ["no test", { 1: { question: 0 } }],
    ["a key that is not an index", { "01": { question: 0, anyOf: [0] } }],
    ["a key past the questions", { 9: { question: 0, anyOf: [0] } }],
  ])("one condition naming %s disables them all", (_, faulty) => {
    const read = readConditions(definition, {
      2: { question: 1, anyOf: [2] },
      ...faulty,
    });
    expect(read.faults).toHaveLength(1);
    expect(read.rules.every((r) => r === undefined)).toBe(true);
  });

  test("a required question cannot carry a condition", () => {
    const read = readConditions(definition, {
      3: { question: 0, noneOf: [0] },
    });
    expect(read.faults).toEqual([
      "question 3 is required and cannot be hidden",
    ]);
  });

  test('"none" names the None box of a multi-select with a minimum of 0', () => {
    const none = { 2: { question: 1, noneOf: ["none"] } };
    expect(readConditions(definition, none).faults).toEqual([]);
    const atLeastOne = {
      questions: questions.map((q) =>
        q.type === "multiSelect" ? { ...q, minSelections: 1 } : q,
      ),
    } as SurveyDefinition;
    expect(readConditions(atLeastOne, none).faults).toEqual([
      "question 2 lists options that question 1 does not have",
    ]);
  });

  test("a document that is not an object is a fault", () => {
    expect(readConditions(definition, [1]).faults).toHaveLength(1);
  });
});

describe("hiddenQuestions", () => {
  test("anyOf shows a question when a listed option is selected", () => {
    expect(hiddenQuestions(chain, [single(0), multi([2]), ...rest])).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(hiddenQuestions(chain, [single(0), multi([0]), ...rest])).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  test("an unanswered or skipped question has no option selected", () => {
    const noneOf = readConditions(definition, {
      1: { question: 0, noneOf: [1] },
    });
    for (const first of [single(null), skipped(single(0))]) {
      expect(hiddenQuestions(chain, [first, multi([2]), ...rest])[1]).toBe(
        true,
      );
      expect(hiddenQuestions(noneOf, [first, multi([2]), ...rest])[1]).toBe(
        false,
      );
    }
  });

  test("a hidden question hides the questions that hang on it", () => {
    // Question 1 still holds Aiken, but it is hidden, so question 2 is too.
    expect(hiddenQuestions(chain, [single(1), multi([2]), ...rest])).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
  });

  test("noneOf reads a hidden question as no option selected", () => {
    const read = readConditions(definition, {
      1: { question: 0, anyOf: [0] },
      2: { question: 1, noneOf: [2] },
    });
    expect(hiddenQuestions(read, [single(1), multi([2]), ...rest])).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  test('"none" matches a None, and not a skip, an unset or a hidden question', () => {
    const read = readConditions(definition, {
      1: { question: 0, anyOf: [0] },
      2: { question: 1, anyOf: ["none"] },
      4: { question: 1, noneOf: ["none"] },
    });
    const shown = (first: Draft, second: Draft) => {
      const hidden = hiddenQuestions(read, [first, second, ...rest]);
      return [!hidden[2], !hidden[4]];
    };
    expect(shown(single(0), multi([]))).toEqual([true, false]);
    expect(shown(single(0), multi([1]))).toEqual([false, true]);
    expect(shown(single(0), multi(null))).toEqual([false, true]);
    expect(shown(single(0), skipped(multi([])))).toEqual([false, true]);
    expect(shown(single(1), multi([]))).toEqual([false, true]);
  });

  test('"none" sits beside option indices', () => {
    const read = readConditions(definition, {
      2: { question: 1, anyOf: [0, "none"] },
    });
    const shown = (selected: number[]) =>
      !hiddenQuestions(read, [single(0), multi(selected), ...rest])[2];
    expect([shown([]), shown([0, 1]), shown([1])]).toEqual([true, true, false]);
  });

  test("no rules hide nothing", () => {
    const read = readConditions(definition, {});
    expect(hiddenQuestions(read, [single(1), multi(null), ...rest])).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  test("a hidden question read as skipped leaves the payload", () => {
    const text = (t: string): Draft => ({
      skipped: false,
      value: { type: "custom", text: t },
    });
    const drafts = [single(1), multi([2]), rest[0]!, text("a"), text("b")];
    const hidden = hiddenQuestions(chain, drafts);
    const answers = drafts.map((d, i) => ({
      ...d,
      skipped: d.skipped || hidden[i]!,
    }));
    expect(
      collectAnswers(questions, answers).map((a) => a.questionIndex),
    ).toEqual([0, 3, 4]);
  });
});
