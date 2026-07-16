/**
 * Stake-weighted tallying (`backend/ARCHITECTURE.md` §6.6). Every aggregate is
 * a BigInt — no floats anywhere; presentation layers derive fractions/means
 * from the exact `{weightedSum, answeredWeight}` rationals. With every weight
 * `1n` it reduces to a plain count tally (which is also how the count-only
 * Keyholder role is tallied, and what the frontend's display tally is
 * cross-checked against).
 *
 * **Input contract:** callers pass responses that already passed validation and
 * dedup — the *counted* set, at most one responder per (role, credential), each
 * carrying its snapshot weight. Out-of-range indices are still skipped
 * defensively, but in-constraint answers are trusted.
 */

import type {
  AnswerItem,
  OptionsOrCount,
  Question,
  SurveyDefinition,
  SurveyResponse,
} from "../index.js";

/** One counted responder with the weight it carries into the tally. */
export interface WeightedResponder {
  /** Stable credential identity ("key:<hex>" | "script:<hex>"). */
  readonly credentialKey: string;
  /** Snapshot weight (lovelace), or `1n` for count-only roles (Keyholder). */
  readonly weight: bigint;
  /** Tx that carried the counted response (provenance). */
  readonly txHash: string;
  /** Index of the response within that tx's label-17 payload — with `txHash`,
   * the full on-chain coordinate of the counted response. */
  readonly responseIndex: number;
  readonly response: SurveyResponse;
}

/** A per-value histogram entry of a numeric question, values ascending. */
export interface WeightedValueBin {
  readonly value: bigint;
  readonly weight: bigint;
  readonly count: number;
}

/**
 * One option that received at least one answer. **Sparse:** the declared option
 * count (`{type:"count", count}`) is attacker-controlled and unbounded, so we
 * never allocate a dense per-option array — only options actually answered are
 * emitted, `index` ascending. A zero-answer option simply doesn't appear (the
 * display fills it back in from the definition; see `artifactView.ts`).
 */
export interface WeightedOptionBucket {
  /** The option's index in the definition. */
  readonly index: number;
  /** Σ responder weight backing this option. */
  readonly weight: bigint;
  /** Responders who selected this option. */
  readonly count: number;
}

/** Weighted numerator/denominator for one answered option (points/rating). */
export interface WeightedPerOption {
  /** The option's index in the definition. */
  readonly index: number;
  /** Σ (answer value × responder weight) for this option. */
  readonly weightedSum: bigint;
  /**
   * Σ responder weight backing that sum — the mean's exact denominator.
   * Rating only: each option's raters differ, so the denominator is per option.
   * Points omits it — every answering responder backs every option, so the
   * denominator is identically the question-level `answeredWeight`.
   */
  readonly answeredWeight?: bigint;
  /** Responders explicitly contributing to this option. */
  readonly count: number;
}

export type WeightedQuestionTally =
  | {
      /** One weight bucket per *answered* option (single/multi choice, first
       * preferences) — sparse, `index` ascending. */
      readonly kind: "options";
      readonly unit: "singleChoice" | "multiSelect" | "rankingFirst";
      readonly options: readonly WeightedOptionBucket[];
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
      /** One entry per *answered* option — sparse, `index` ascending. */
      readonly perOption: readonly WeightedPerOption[];
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      /** Free-form answers aggregate to participation only. */
      readonly kind: "custom";
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    };

/** Accumulate `weight`/`+1 count` into a sparse option map. */
function addOption(
  m: Map<number, { weight: bigint; count: number }>,
  index: number,
  weight: bigint,
): void {
  const e = m.get(index);
  if (e) {
    e.weight += weight;
    e.count++;
  } else {
    m.set(index, { weight, count: 1 });
  }
}

/** A sparse option map → sorted {@link WeightedOptionBucket} list. */
function optionBuckets(
  m: Map<number, { weight: bigint; count: number }>,
): WeightedOptionBucket[] {
  return [...m.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, e]) => ({ index, weight: e.weight, count: e.count }));
}

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
      const byOption = new Map<number, { weight: bigint; count: number }>();
      for (const { a, w } of answered) {
        if (
          a.type === "singleChoice" &&
          a.optionIndex >= 0 &&
          a.optionIndex < n
        )
          addOption(byOption, a.optionIndex, w);
      }
      return {
        kind: "options",
        unit: "singleChoice",
        options: optionBuckets(byOption),
        answeredCount,
        answeredWeight,
      };
    }

    case "multiSelect": {
      const n = optionCountOf(question.options);
      const byOption = new Map<number, { weight: bigint; count: number }>();
      for (const { a, w } of answered) {
        if (a.type === "multiSelect") {
          for (const i of a.optionIndices)
            if (i >= 0 && i < n) addOption(byOption, i, w);
        }
      }
      return {
        kind: "options",
        unit: "multiSelect",
        options: optionBuckets(byOption),
        answeredCount,
        answeredWeight,
      };
    }

    case "ranking": {
      const n = optionCountOf(question.options);
      const byOption = new Map<number, { weight: bigint; count: number }>();
      for (const { a, w } of answered) {
        if (a.type === "ranking" && a.ranking.length > 0) {
          const top = a.ranking[0]!;
          if (top >= 0 && top < n) addOption(byOption, top, w);
        }
      }
      return {
        kind: "options",
        unit: "rankingFirst",
        options: optionBuckets(byOption),
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
      const byOption = new Map<number, { sum: bigint; count: number }>();
      for (const { a, w } of answered) {
        if (a.type === "pointsAllocation") {
          for (const p of a.allocations) {
            if (p.optionIndex >= 0 && p.optionIndex < n) {
              const e = byOption.get(p.optionIndex);
              const add = BigInt(p.points) * w;
              if (e) {
                e.sum += add;
                e.count++;
              } else {
                byOption.set(p.optionIndex, { sum: add, count: 1 });
              }
            }
          }
        }
      }
      const perOption = [...byOption.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, e]) => ({
          index,
          weightedSum: e.sum,
          // No per-option `answeredWeight`: every answering responder backs every
          // option, so the denominator is the question-level `answeredWeight`.
          count: e.count,
        }));
      return {
        kind: "perOption",
        unit: "points",
        perOption,
        answeredCount,
        answeredWeight,
      };
    }

    case "rating": {
      // Unlike points, rating an option is per option: only responders who
      // rated it enter that option's numerator AND denominator. A require_all
      // question forces every option rated, so its denominators converge on the
      // responder count; a subset question (require_all=false) leaves them opt-in.
      const n = optionCountOf(question.options);
      // Sparse per option: only rated options are emitted. Each carries its own
      // `answeredWeight` (the raters of *that* option), which is the mean's exact
      // denominator and genuinely differs per option when `require_all=false`.
      const byOption = new Map<
        number,
        { sum: bigint; weight: bigint; count: number }
      >();
      for (const { a, w } of answered) {
        if (a.type !== "rating") continue;
        for (const r of a.ratings) {
          const oi = r.optionIndex;
          if (oi < 0 || oi >= n) continue;
          let e = byOption.get(oi);
          if (!e) {
            e = { sum: 0n, weight: 0n, count: 0 };
            byOption.set(oi, e);
          }
          e.sum += r.rating * w;
          e.weight += w;
          e.count++;
        }
      }
      const perOption = [...byOption.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, e]) => ({
          index,
          weightedSum: e.sum,
          answeredWeight: e.weight,
          count: e.count,
        }));
      return {
        kind: "perOption",
        unit: "rating",
        perOption,
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
