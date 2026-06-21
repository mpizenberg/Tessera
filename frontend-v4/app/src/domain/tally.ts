/**
 * Pure tallying of public responses against a survey definition.
 *
 * Sealed responses are opaque until their drand round publishes, so they are
 * not tallied here — the UI shows a "reveals in …" placeholder instead.
 *
 * Each question type produces the shape its Results widget needs. Tallies are
 * computed over whatever response set is passed in, so role-filtered tallies
 * are just a pre-filter at the call site.
 */

import type {
  AnswerItem,
  OptionsOrCount,
  Question,
  RatingScale,
  SurveyDefinition,
  SurveyResponse,
} from "cip-179";

export interface Bar {
  readonly label: string;
  readonly count: number;
  /** Fill fraction 0–1, relative to the leading bar. */
  readonly pct: number;
}

export interface PointsRow {
  readonly label: string;
  readonly avg: number;
}

export interface RatingRow {
  readonly label: string;
  readonly avg: number;
  /** Distribution count per level (index 0 = baseMin). */
  readonly counts: number[];
}

export interface HistogramBin {
  readonly label: string;
  readonly count: number;
}

export type QuestionTally =
  | {
      readonly kind: "bars";
      readonly bars: Bar[];
      readonly answered: number;
      readonly abstained: number;
      /** What the bar count measures, shown in the type label. */
      readonly unit: "votes" | "responders" | "first preferences";
    }
  | {
      readonly kind: "histogram";
      readonly bins: HistogramBin[];
      readonly mean: number;
      readonly median: number;
      readonly answered: number;
      readonly abstained: number;
    }
  | {
      readonly kind: "points";
      readonly rows: PointsRow[];
      readonly budget: number;
      readonly answered: number;
      readonly abstained: number;
    }
  | {
      readonly kind: "rating";
      readonly rows: RatingRow[];
      readonly levels: number;
      readonly levelLabels: string[] | null;
      readonly numeric: boolean;
      readonly baseMin: number;
      readonly answered: number;
      readonly abstained: number;
    }
  | {
      readonly kind: "custom";
      readonly answered: number;
      readonly abstained: number;
      readonly samples: string[];
    };

function optionLabels(opts: OptionsOrCount): string[] {
  return opts.type === "options"
    ? [...opts.labels]
    : Array.from({ length: opts.count }, (_, i) => `Option ${i + 1}`);
}

function answersFor(
  responses: readonly SurveyResponse[],
  questionIndex: number,
): AnswerItem[] {
  const items: AnswerItem[] = [];
  for (const r of responses) {
    if (r.answers.type !== "public") continue;
    for (const a of r.answers.answers) {
      if (a.questionIndex === questionIndex) items.push(a);
    }
  }
  return items;
}

function barsFrom(labels: string[], counts: number[]): Bar[] {
  const max = Math.max(1, ...counts);
  return labels.map((label, i) => ({
    label,
    count: counts[i] ?? 0,
    pct: (counts[i] ?? 0) / max,
  }));
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function ratingScaleInfo(scale: RatingScale): {
  levels: number;
  levelLabels: string[] | null;
  numeric: boolean;
  baseMin: number;
} {
  switch (scale.type) {
    case "numeric": {
      const min = Number(scale.constraints.min);
      const max = Number(scale.constraints.max);
      return {
        levels: Math.max(1, max - min + 1),
        levelLabels: null,
        numeric: true,
        baseMin: min,
      };
    }
    case "labels":
      return {
        levels: scale.labels.length,
        levelLabels: [...scale.labels],
        numeric: false,
        baseMin: 0,
      };
    case "count":
      return {
        levels: scale.count,
        levelLabels: null,
        numeric: false,
        baseMin: 0,
      };
  }
}

export function tallyQuestion(
  question: Question,
  questionIndex: number,
  responses: readonly SurveyResponse[],
  totalResponders: number,
): QuestionTally {
  const items = answersFor(responses, questionIndex);
  const answered = items.length;
  const abstained = Math.max(0, totalResponders - answered);

  switch (question.type) {
    case "singleChoice": {
      const labels = optionLabels(question.options);
      const counts = new Array(labels.length).fill(0);
      for (const a of items) {
        if (a.type === "singleChoice" && a.optionIndex < counts.length) {
          counts[a.optionIndex]++;
        }
      }
      return {
        kind: "bars",
        bars: barsFrom(labels, counts),
        answered,
        abstained,
        unit: "votes",
      };
    }

    case "multiSelect": {
      const labels = optionLabels(question.options);
      const counts = new Array(labels.length).fill(0);
      for (const a of items) {
        if (a.type === "multiSelect") {
          for (const i of a.optionIndices) if (i < counts.length) counts[i]++;
        }
      }
      return {
        kind: "bars",
        bars: barsFrom(labels, counts),
        answered,
        abstained,
        unit: "responders",
      };
    }

    case "ranking": {
      const labels = optionLabels(question.options);
      const counts = new Array(labels.length).fill(0);
      for (const a of items) {
        if (a.type === "ranking" && a.ranking.length > 0) {
          const top = a.ranking[0]!;
          if (top < counts.length) counts[top]++;
        }
      }
      return {
        kind: "bars",
        bars: barsFrom(labels, counts),
        answered,
        abstained,
        unit: "first preferences",
      };
    }

    case "numericRange": {
      const values: number[] = [];
      for (const a of items)
        if (a.type === "numeric") values.push(Number(a.value));
      const byValue = new Map<number, number>();
      for (const v of values) byValue.set(v, (byValue.get(v) ?? 0) + 1);
      const bins = [...byValue.entries()]
        .sort((x, y) => x[0] - y[0])
        .map(([v, count]) => ({ label: String(v), count }));
      return {
        kind: "histogram",
        bins,
        mean: mean(values),
        median: median(values),
        answered,
        abstained,
      };
    }

    case "pointsAllocation": {
      const labels = optionLabels(question.options);
      const totals = new Array(labels.length).fill(0);
      for (const a of items) {
        if (a.type === "pointsAllocation") {
          for (const p of a.allocations) {
            if (p.optionIndex < totals.length)
              totals[p.optionIndex] += p.points;
          }
        }
      }
      const n = Math.max(1, answered);
      return {
        kind: "points",
        rows: labels.map((label, i) => ({ label, avg: totals[i] / n })),
        budget: question.budget,
        answered,
        abstained,
      };
    }

    case "rating": {
      const labels = optionLabels(question.options);
      const info = ratingScaleInfo(question.scale);
      const sums = new Array(labels.length).fill(0);
      const ns = new Array(labels.length).fill(0);
      const counts = labels.map(() => new Array(info.levels).fill(0));
      for (const a of items) {
        if (a.type === "rating") {
          for (const r of a.ratings) {
            const oi = r.optionIndex;
            if (oi >= labels.length) continue;
            const val = Number(r.rating);
            sums[oi] += val;
            ns[oi]++;
            const li = val - info.baseMin;
            if (li >= 0 && li < info.levels) counts[oi]![li]++;
          }
        }
      }
      return {
        kind: "rating",
        rows: labels.map((label, i) => ({
          label,
          avg: ns[i] ? sums[i] / ns[i] : 0,
          counts: counts[i]!,
        })),
        levels: info.levels,
        levelLabels: info.levelLabels,
        numeric: info.numeric,
        baseMin: info.baseMin,
        answered,
        abstained,
      };
    }

    case "custom": {
      const samples: string[] = [];
      for (const a of items) {
        if (
          a.type === "custom" &&
          typeof a.value === "string" &&
          samples.length < 6
        ) {
          samples.push(a.value);
        }
      }
      return { kind: "custom", answered, abstained, samples };
    }
  }
}

export function tallySurvey(
  definition: SurveyDefinition,
  responses: readonly SurveyResponse[],
  totalResponders: number,
): QuestionTally[] {
  return definition.questions.map((q, i) =>
    tallyQuestion(q, i, responses, totalResponders),
  );
}

/** Per-role response counts (over the given, already-deduped response set). */
export function roleBreakdown(
  responses: readonly SurveyResponse[],
): Array<{ role: number; count: number }> {
  const by = new Map<number, number>();
  for (const r of responses) by.set(r.role, (by.get(r.role) ?? 0) + 1);
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([role, count]) => ({ role, count }));
}
