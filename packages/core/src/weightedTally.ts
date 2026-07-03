/**
 * Stake-weighted tallying (`backend/ARCHITECTURE.md` §6.6). Every aggregate is
 * a BigInt — no floats anywhere; presentation layers derive fractions/means
 * from the exact `{weightedSum, answeredWeight}` rationals. Mirrors `./tally.ts`
 * question-by-question, and with every weight `1n` it reproduces its counts
 * exactly (which is also how the count-only Keyholder role is tallied).
 *
 * **Input contract:** like `tally.ts`, callers pass responses that already
 * passed validation and dedup — the *counted* set, at most one responder per
 * (role, credential), each carrying its snapshot weight. Out-of-range indices
 * are still skipped defensively, but in-constraint answers are trusted.
 */

import type {
  AnswerItem,
  OptionsOrCount,
  Question,
  SurveyDefinition,
  SurveyResponse,
} from "cip-179";

import { ratingScaleInfo } from "./tally";

/** One counted responder with the weight it carries into the tally. */
export interface WeightedResponder {
  /** Stable credential identity ("key:<hex>" | "script:<hex>"). */
  readonly credentialKey: string;
  /** Snapshot weight (lovelace), or `1n` for count-only roles (Keyholder). */
  readonly weight: bigint;
  /** Tx that carried the counted response (provenance). */
  readonly txHash: string;
  readonly response: SurveyResponse;
}

/** A per-value histogram entry of a numeric question, values ascending. */
export interface WeightedValueBin {
  readonly value: bigint;
  readonly weight: bigint;
  readonly count: number;
}

/** Weighted numerator/denominator for one option of a per-option question. */
export interface WeightedOptionAggregate {
  /** Σ (answer value × responder weight) for this option. */
  readonly weightedSum: bigint;
  /** Σ responder weight backing that sum — the mean's exact denominator. */
  readonly answeredWeight: bigint;
  /** Responders explicitly contributing to this option. */
  readonly count: number;
}

export type WeightedQuestionTally =
  | {
      /** One weight bucket per option (single/multi choice, first preferences). */
      readonly kind: "options";
      readonly unit: "singleChoice" | "multiSelect" | "rankingFirst";
      readonly optionWeights: readonly bigint[];
      readonly optionCounts: readonly number[];
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      readonly kind: "numeric";
      /** Σ (value × weight); mean = weightedSum / answeredWeight. */
      readonly weightedSum: bigint;
      readonly answeredWeight: bigint;
      readonly answeredCount: number;
      readonly values: readonly WeightedValueBin[];
    }
  | {
      readonly kind: "perOption";
      readonly unit: "points" | "rating";
      readonly perOption: readonly WeightedOptionAggregate[];
      /**
       * Rating only: weight distribution per option per scale level
       * (`levelWeights[option][level]`, level 0 = the scale's minimum, bucketed
       * by {@link ratingScaleInfo} exactly as the count tally does).
       */
      readonly levelWeights?: readonly (readonly bigint[])[];
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      /** Free-form answers aggregate to participation only. */
      readonly kind: "custom";
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    };

function optionCountOf(opts: OptionsOrCount): number {
  return opts.type === "options" ? opts.labels.length : opts.count;
}

/** The responder's answer to `questionIndex`, or null (sealed or abstained). */
function answerOf(r: SurveyResponse, questionIndex: number): AnswerItem | null {
  if (r.answers.type !== "public") return null;
  for (const a of r.answers.answers) {
    if (a.questionIndex === questionIndex) return a;
  }
  return null;
}

export function weightedTallyQuestion(
  question: Question,
  questionIndex: number,
  responders: readonly WeightedResponder[],
): WeightedQuestionTally {
  const answered: { a: AnswerItem; w: bigint }[] = [];
  for (const r of responders) {
    const a = answerOf(r.response, questionIndex);
    if (a) answered.push({ a, w: r.weight });
  }
  const answeredCount = answered.length;
  let answeredWeight = 0n;
  for (const { w } of answered) answeredWeight += w;

  switch (question.type) {
    case "singleChoice": {
      const n = optionCountOf(question.options);
      const optionWeights = new Array<bigint>(n).fill(0n);
      const optionCounts = new Array<number>(n).fill(0);
      for (const { a, w } of answered) {
        if (a.type === "singleChoice" && a.optionIndex < n) {
          optionWeights[a.optionIndex] += w;
          optionCounts[a.optionIndex]++;
        }
      }
      return {
        kind: "options",
        unit: "singleChoice",
        optionWeights,
        optionCounts,
        answeredCount,
        answeredWeight,
      };
    }

    case "multiSelect": {
      const n = optionCountOf(question.options);
      const optionWeights = new Array<bigint>(n).fill(0n);
      const optionCounts = new Array<number>(n).fill(0);
      for (const { a, w } of answered) {
        if (a.type === "multiSelect") {
          for (const i of a.optionIndices) {
            if (i < n) {
              optionWeights[i] += w;
              optionCounts[i]++;
            }
          }
        }
      }
      return {
        kind: "options",
        unit: "multiSelect",
        optionWeights,
        optionCounts,
        answeredCount,
        answeredWeight,
      };
    }

    case "ranking": {
      const n = optionCountOf(question.options);
      const optionWeights = new Array<bigint>(n).fill(0n);
      const optionCounts = new Array<number>(n).fill(0);
      for (const { a, w } of answered) {
        if (a.type === "ranking" && a.ranking.length > 0) {
          const top = a.ranking[0]!;
          if (top < n) {
            optionWeights[top] += w;
            optionCounts[top]++;
          }
        }
      }
      return {
        kind: "options",
        unit: "rankingFirst",
        optionWeights,
        optionCounts,
        answeredCount,
        answeredWeight,
      };
    }

    case "numericRange": {
      let weightedSum = 0n;
      const byValue = new Map<bigint, { weight: bigint; count: number }>();
      for (const { a, w } of answered) {
        if (a.type !== "numeric") continue;
        weightedSum += a.value * w;
        const bin = byValue.get(a.value);
        if (bin) {
          bin.weight += w;
          bin.count++;
        } else {
          byValue.set(a.value, { weight: w, count: 1 });
        }
      }
      const values = [...byValue.entries()]
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([value, bin]) => ({ value, ...bin }));
      return {
        kind: "numeric",
        weightedSum,
        answeredWeight,
        answeredCount,
        values,
      };
    }

    case "pointsAllocation": {
      // Answering allocates the whole budget across options — options an
      // answer doesn't mention received 0 points from that responder. Every
      // answering responder therefore backs every option's denominator, so a
      // weighted mean is weightedSum / answeredWeight (same for all options);
      // `count` records who allocated to the option explicitly.
      const n = optionCountOf(question.options);
      const sums = new Array<bigint>(n).fill(0n);
      const counts = new Array<number>(n).fill(0);
      for (const { a, w } of answered) {
        if (a.type === "pointsAllocation") {
          for (const p of a.allocations) {
            if (p.optionIndex < n) {
              sums[p.optionIndex] += BigInt(p.points) * w;
              counts[p.optionIndex]++;
            }
          }
        }
      }
      return {
        kind: "perOption",
        unit: "points",
        perOption: sums.map((weightedSum, i) => ({
          weightedSum,
          answeredWeight,
          count: counts[i]!,
        })),
        answeredCount,
        answeredWeight,
      };
    }

    case "rating": {
      // Unlike points, rating an option is opt-in per option: only responders
      // who rated it enter that option's numerator AND denominator.
      const n = optionCountOf(question.options);
      const info = ratingScaleInfo(question.scale);
      const sums = new Array<bigint>(n).fill(0n);
      const optWeights = new Array<bigint>(n).fill(0n);
      const counts = new Array<number>(n).fill(0);
      const levelWeights = Array.from({ length: n }, () =>
        new Array<bigint>(info.levels).fill(0n),
      );
      for (const { a, w } of answered) {
        if (a.type !== "rating") continue;
        for (const r of a.ratings) {
          const oi = r.optionIndex;
          if (oi >= n) continue;
          sums[oi] += r.rating * w;
          optWeights[oi] += w;
          counts[oi]++;
          const li = Math.round((Number(r.rating) - info.baseMin) / info.step);
          if (li >= 0 && li < info.levels) levelWeights[oi]![li] += w;
        }
      }
      return {
        kind: "perOption",
        unit: "rating",
        perOption: sums.map((weightedSum, i) => ({
          weightedSum,
          answeredWeight: optWeights[i]!,
          count: counts[i]!,
        })),
        levelWeights,
        answeredCount,
        answeredWeight,
      };
    }

    case "custom":
      return { kind: "custom", answeredCount, answeredWeight };
  }
}

/** Weighted tally of a whole survey — one entry per question, in order. */
export function weightedTallySurvey(
  definition: SurveyDefinition,
  responders: readonly WeightedResponder[],
): WeightedQuestionTally[] {
  return definition.questions.map((q, i) =>
    weightedTallyQuestion(q, i, responders),
  );
}
