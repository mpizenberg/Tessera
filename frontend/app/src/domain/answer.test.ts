import { describe, expect, it } from "vitest";
import type { Question } from "cip-179";

import { humanizeAnswer, optionLabelOf, serializeAnswer } from "./answer";

const Q: Question = {
  type: "singleChoice",
  prompt: "",
  options: { type: "options", labels: ["Red", "Green", "Blue"] },
};

describe("serializeAnswer", () => {
  it("renders each variant in its stable machine form", () => {
    expect(
      serializeAnswer({
        type: "singleChoice",
        questionIndex: 0,
        optionIndex: 2,
      }),
    ).toBe("2");
    expect(
      serializeAnswer({
        type: "multiSelect",
        questionIndex: 0,
        optionIndices: [0, 2],
      }),
    ).toBe("0|2");
    expect(
      serializeAnswer({
        type: "ranking",
        questionIndex: 0,
        ranking: [2, 0, 1],
      }),
    ).toBe("2>0>1");
    expect(
      serializeAnswer({ type: "numeric", questionIndex: 0, value: 42n }),
    ).toBe("42");
    expect(
      serializeAnswer({
        type: "pointsAllocation",
        questionIndex: 0,
        allocations: [
          { optionIndex: 0, points: 3 },
          { optionIndex: 1, points: 7 },
        ],
      }),
    ).toBe("0:3|1:7");
    expect(
      serializeAnswer({
        type: "rating",
        questionIndex: 0,
        ratings: [
          { optionIndex: 0, rating: 5n },
          { optionIndex: 1, rating: 2n },
        ],
      }),
    ).toBe("0:5|1:2");
    expect(
      serializeAnswer({ type: "custom", questionIndex: 0, value: "free text" }),
    ).toBe("free text");
  });

  it("falls back to a placeholder for non-string custom values", () => {
    expect(
      serializeAnswer({ type: "custom", questionIndex: 0, value: 7n }),
    ).toBe("[custom]");
  });

  it("renders an empty multiSelect as the empty string", () => {
    expect(
      serializeAnswer({
        type: "multiSelect",
        questionIndex: 0,
        optionIndices: [],
      }),
    ).toBe("");
  });
});

describe("optionLabelOf", () => {
  it("uses the definition's labels when present", () => {
    expect(optionLabelOf(Q, 0)).toBe("Red");
    expect(optionLabelOf(Q, 2)).toBe("Blue");
  });

  it("falls back to 1-based Option N when label or question is missing", () => {
    expect(optionLabelOf(Q, 9)).toBe("Option 10");
    expect(optionLabelOf(undefined, 0)).toBe("Option 1");
  });
});

describe("humanizeAnswer", () => {
  it("labels a single choice", () => {
    expect(
      humanizeAnswer(
        { type: "singleChoice", questionIndex: 0, optionIndex: 1 },
        Q,
      ),
    ).toBe("Green");
  });

  it("joins selected labels and reports an empty multiSelect", () => {
    expect(
      humanizeAnswer(
        { type: "multiSelect", questionIndex: 0, optionIndices: [0, 2] },
        Q,
      ),
    ).toBe("Red, Blue");
    expect(
      humanizeAnswer(
        { type: "multiSelect", questionIndex: 0, optionIndices: [] },
        Q,
      ),
    ).toBe("(none selected)");
  });

  it("numbers a ranking in preference order", () => {
    expect(
      humanizeAnswer({ type: "ranking", questionIndex: 0, ranking: [2, 0] }, Q),
    ).toBe("1. Blue  ›  2. Red");
  });

  it("pairs labels with points and ratings", () => {
    expect(
      humanizeAnswer(
        {
          type: "pointsAllocation",
          questionIndex: 0,
          allocations: [{ optionIndex: 0, points: 4 }],
        },
        Q,
      ),
    ).toBe("Red: 4");
    expect(
      humanizeAnswer(
        {
          type: "rating",
          questionIndex: 0,
          ratings: [{ optionIndex: 1, rating: 3n }],
        },
        Q,
      ),
    ).toBe("Green: 3");
  });
});
