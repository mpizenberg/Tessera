/**
 * Pure presentation model for a final tally artifact (`TallyArtifact`): the
 * exact decimal-string aggregates become render-ready structures. This is the
 * ONLY place floats appear — derived here from exact integers, never stored:
 * fractions via `Number(x * 10_000n / max) / 10_000`, means likewise. No
 * framework, no I/O; unit-testable in isolation.
 */

import type { Question, SurveyDefinition } from "cip-179";

import { optionLabelOf } from "@tessera/core";
import type {
  ArtifactQuestion,
  ArtifactRoleTally,
  TallyArtifact,
} from "@tessera/core";

/** Fill fraction 0–1 of `part` relative to `max` (4 decimal places). */
export function fracOf(part: bigint, max: bigint): number {
  if (max <= 0n) return 0;
  return Number((part * 10_000n) / max) / 10_000;
}

/** `num / den` to 4 decimal places, or null when the denominator is empty. */
export function ratioOf(num: bigint, den: bigint): number | null {
  if (den <= 0n) return null;
  return Number((num * 10_000n) / den) / 10_000;
}

/** Whole-ada rendering of a lovelace amount, grouped ("512,793"). */
export function formatAda(lovelace: bigint): string {
  const ada = lovelace / 1_000_000n;
  if (ada === 0n && lovelace > 0n) return "<1";
  return ada.toLocaleString("en-US");
}

export interface WeightedBarView {
  readonly label: string;
  readonly weight: bigint;
  readonly count: number;
  /** Fill fraction 0–1, relative to the leading bar. */
  readonly frac: number;
}

export interface WeightedRowView {
  readonly label: string;
  /** Weighted mean, or null when nothing backs it. */
  readonly avg: number | null;
  readonly count: number;
}

export type WeightedQuestionView =
  | {
      readonly kind: "bars";
      readonly unit: "singleChoice" | "multiSelect" | "rankingFirst";
      readonly bars: readonly WeightedBarView[];
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      readonly kind: "histogram";
      readonly bins: readonly WeightedBarView[];
      /** Weighted mean of the numeric values, or null with no answers. */
      readonly mean: number | null;
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      readonly kind: "rows";
      readonly unit: "points" | "rating";
      readonly rows: readonly WeightedRowView[];
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      readonly kind: "custom";
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    };

export interface WeightedRoleView {
  readonly role: number;
  /** Counted responders for this role. */
  readonly responderCount: number;
  /** Σ counted responder weights (lovelace, or votes for count-only roles). */
  readonly votedWeight: bigint;
  /** The role's electorate total, or null for count-only roles. */
  readonly total: bigint | null;
  /** votedWeight / total, or null when there is no meaningful total. */
  readonly turnout: number | null;
  readonly questions: readonly WeightedQuestionView[];
}

function barViews(
  labels: readonly string[],
  weights: readonly bigint[],
  counts: readonly number[],
): WeightedBarView[] {
  const max = weights.reduce((a, b) => (b > a ? b : a), 0n);
  return labels.map((label, i) => ({
    label,
    weight: weights[i] ?? 0n,
    count: counts[i] ?? 0,
    frac: fracOf(weights[i] ?? 0n, max),
  }));
}

export function weightedQuestionView(
  q: Question | undefined,
  aq: ArtifactQuestion,
): WeightedQuestionView {
  switch (aq.kind) {
    case "options": {
      const weights = aq.optionWeights.map(BigInt);
      const labels = weights.map((_, i) => optionLabelOf(q, i));
      return {
        kind: "bars",
        unit: aq.unit,
        bars: barViews(labels, weights, aq.optionCounts),
        answeredCount: aq.answeredCount,
        answeredWeight: BigInt(aq.answeredWeight),
      };
    }
    case "numeric": {
      const answeredWeight = BigInt(aq.answeredWeight);
      const weights = aq.values.map((v) => BigInt(v.weight));
      return {
        kind: "histogram",
        bins: barViews(
          aq.values.map((v) => v.value),
          weights,
          aq.values.map((v) => v.count),
        ),
        mean: ratioOf(BigInt(aq.weightedSum), answeredWeight),
        answeredCount: aq.answeredCount,
        answeredWeight,
      };
    }
    case "perOption":
      return {
        kind: "rows",
        unit: aq.unit,
        rows: aq.perOption.map((o, i) => ({
          label: optionLabelOf(q, i),
          avg: ratioOf(BigInt(o.weightedSum), BigInt(o.answeredWeight)),
          count: o.count,
        })),
        answeredCount: aq.answeredCount,
        answeredWeight: BigInt(aq.answeredWeight),
      };
    case "custom":
      return {
        kind: "custom",
        answeredCount: aq.answeredCount,
        answeredWeight: BigInt(aq.answeredWeight),
      };
  }
}

function roleView(
  role: ArtifactRoleTally,
  def: SurveyDefinition,
): WeightedRoleView {
  const votedWeight = role.responders.reduce(
    (sum, r) => sum + BigInt(r.weight),
    0n,
  );
  const total = role.total === null ? null : BigInt(role.total);
  return {
    role: role.role,
    responderCount: role.responders.length,
    votedWeight,
    total,
    turnout: total === null ? null : ratioOf(votedWeight, total),
    questions: role.questions.map((aq, i) =>
      weightedQuestionView(def.questions[i], aq),
    ),
  };
}

/** Per-role render models, in the artifact's (role-ascending) order. */
export function weightedRoleViews(
  artifact: TallyArtifact,
  def: SurveyDefinition,
): WeightedRoleView[] {
  return artifact.tally.perRole.map((r) => roleView(r, def));
}
