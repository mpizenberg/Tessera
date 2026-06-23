/**
 * Tests for {@link maxPlaintextSize}: the analytic worst-case must be a *safe
 * upper bound* on the real CBOR size of a fully-answered response (and tight for
 * the common small-number case). We check it against the actual bytes produced
 * by the real codec (`encodeAnswerItem`) + CBOR encoder (`metadatumToCbor`),
 * mirroring the Elm reference's `maxPlaintextSize` test suite.
 */

import { describe, expect, it } from "vitest";
import {
  encodeAnswerItem,
  type AnswerItem,
  type OptionsOrCount,
  type Question,
} from "cip-179";

import { metadatumToCbor } from "~/wallet/cbor";
import { maxPlaintextSize } from "./padding";

// --- question constructors --------------------------------------------------

const opts = (n: number): OptionsOrCount => ({
  type: "options",
  labels: Array.from({ length: n }, (_, i) => `option ${i}`),
});

const singleChoice = (n: number): Question => ({
  type: "singleChoice",
  prompt: "",
  options: opts(n),
});
const multiSelect = (n: number, max: number): Question => ({
  type: "multiSelect",
  prompt: "",
  options: opts(n),
  minSelections: 0,
  maxSelections: max,
});
const ranking = (n: number, max: number): Question => ({
  type: "ranking",
  prompt: "",
  options: opts(n),
  minRanked: 1,
  maxRanked: max,
});
const numeric = (min: number, max: number): Question => ({
  type: "numericRange",
  prompt: "",
  constraints: { min: BigInt(min), max: BigInt(max) },
});
const points = (n: number, budget: number): Question => ({
  type: "pointsAllocation",
  prompt: "",
  options: opts(n),
  budget,
});
const ratingNumeric = (n: number, min: number, max: number): Question => ({
  type: "rating",
  prompt: "",
  options: opts(n),
  scale: {
    type: "numeric",
    constraints: { min: BigInt(min), max: BigInt(max) },
  },
});
const custom = (): Question => ({
  type: "custom",
  prompt: "",
  methodSchema: { uri: "ipfs://x", hash: new Uint8Array(32) },
});

// --- actual worst-case size, via the real codec -----------------------------

const optionCount = (o: OptionsOrCount): number =>
  o.type === "options" ? o.labels.length : o.count;

const cborLen = (m: bigint): number => metadatumToCbor(m).length;

/** The largest-encoding answer for a question (mirrors `maxPlaintextSize`'s assumptions). */
function maximalAnswer(q: Question, i: number): AnswerItem {
  switch (q.type) {
    case "custom":
      return { type: "custom", questionIndex: i, value: "" };
    case "singleChoice":
      return {
        type: "singleChoice",
        questionIndex: i,
        optionIndex: Math.max(0, optionCount(q.options) - 1),
      };
    case "multiSelect": {
      const oc = optionCount(q.options);
      const count = Math.min(q.maxSelections, oc);
      return {
        type: "multiSelect",
        questionIndex: i,
        optionIndices: Array.from({ length: count }, (_, k) => oc - count + k),
      };
    }
    case "ranking": {
      const oc = optionCount(q.options);
      const count = Math.min(q.maxRanked, oc);
      return {
        type: "ranking",
        questionIndex: i,
        ranking: Array.from({ length: count }, (_, k) => oc - count + k),
      };
    }
    case "numericRange": {
      // pick whichever bound encodes wider
      const { min, max } = q.constraints;
      const value = cborLen(min) >= cborLen(max) ? min : max;
      return { type: "numeric", questionIndex: i, value };
    }
    case "pointsAllocation": {
      const oc = optionCount(q.options);
      const base = Math.floor(q.budget / oc);
      const rem = q.budget - base * oc;
      return {
        type: "pointsAllocation",
        questionIndex: i,
        allocations: Array.from({ length: oc }, (_, k) => ({
          optionIndex: k,
          points: base + (k < rem ? 1 : 0),
        })).filter((a) => a.points > 0),
      };
    }
    case "rating": {
      const oc = optionCount(q.options);
      const top = q.scale.type === "numeric" ? q.scale.constraints.max : 0n;
      return {
        type: "rating",
        questionIndex: i,
        ratings: Array.from({ length: oc }, (_, k) => ({
          optionIndex: k,
          rating: top,
        })),
      };
    }
  }
}

/** Real CBOR byte length of a maximal response to `questions`. */
function actualWidth(questions: readonly Question[]): number {
  const answers = questions.map((q, i) => maximalAnswer(q, i));
  return metadatumToCbor(answers.map(encodeAnswerItem)).length;
}

// --- tests ------------------------------------------------------------------

describe("maxPlaintextSize", () => {
  it("empty survey is just the empty CBOR array (1 byte)", () => {
    expect(maxPlaintextSize([])).toBe(1);
    expect(actualWidth([])).toBe(1);
  });

  it("is tight for a typical small survey (one of each bounded type)", () => {
    const questions = [
      singleChoice(4),
      multiSelect(5, 3),
      ranking(4, 4),
      numeric(0, 100),
      points(4, 10),
      ratingNumeric(4, 1, 5),
      custom(),
    ];
    expect(maxPlaintextSize(questions)).toBe(actualWidth(questions));
  });

  it("counts negative and wide numerics at full width", () => {
    const questions = [
      numeric(-1000000, 5),
      numeric(0, 70000),
      numeric(-23, 23),
    ];
    expect(maxPlaintextSize(questions)).toBe(actualWidth(questions));
  });

  it("is a safe upper bound for large option counts", () => {
    const questions = [
      multiSelect(300, 10),
      ranking(300, 10),
      points(300, 1000),
    ];
    expect(actualWidth(questions)).toBeLessThanOrEqual(
      maxPlaintextSize(questions),
    );
  });

  it("a long free-text answer can exceed the estimate (documented limitation)", () => {
    const questions = [custom()];
    const long: AnswerItem = {
      type: "custom",
      questionIndex: 0,
      value: "x".repeat(100),
    };
    const actual = metadatumToCbor([encodeAnswerItem(long)]).length;
    expect(actual).toBeGreaterThan(maxPlaintextSize(questions));
  });

  it("a maximal response never exceeds the estimate (varied surveys)", () => {
    // Deterministic pseudo-random surveys: each must stay within the bound.
    const make = (seed: number): Question => {
      const pick = seed % 6;
      const n = 2 + (seed % 9); // 2..10 options
      switch (pick) {
        case 0:
          return singleChoice(n);
        case 1:
          return multiSelect(n, 1 + (seed % n));
        case 2:
          return ranking(n, 1 + (seed % n));
        case 3:
          return numeric(-(seed * 137), seed * 991);
        case 4:
          return points(n, 1 + seed * 7);
        default:
          return ratingNumeric(n, 0, 1 + (seed % 7));
      }
    };
    for (let s = 0; s < 60; s++) {
      const questions = Array.from({ length: 1 + (s % 6) }, (_, k) =>
        make(s * 7 + k * 13 + 1),
      );
      expect(actualWidth(questions)).toBeLessThanOrEqual(
        maxPlaintextSize(questions),
      );
    }
  });
});
