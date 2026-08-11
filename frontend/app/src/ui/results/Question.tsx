/**
 * One question's results, whichever view asked for them. The committed tally
 * decides the card body; the role's weighting decides what a bar's figure reads.
 */

import { Show, type Component, type JSX } from "solid-js";
import type { Question } from "cip-179";
import {
  formatAda,
  type QuestionResults,
  type QuestionView,
} from "~/domain/results";

import { t, n } from "~/i18n";
import { Bars, ResultCard, typeLabel } from "./Card";
import { Custom } from "./Custom";
import { Histogram } from "./Histogram";
import { Rows } from "./Rows";

/** How a bar's right-hand figure reads under the role's weighting. */
export type Meta = (weight: bigint, count: number) => string;

/**
 * Lovelace-weighted roles show the ada behind a bar next to the head count;
 * unit-weighted ones (the live view, the one-vote toggle, count-only roles)
 * have nothing to add to the count.
 */
export function metaFor(weighted: boolean): Meta {
  return weighted
    ? (weight, count) =>
        t("survey.weightedBarMeta", { ada: formatAda(weight), n: n(count) })
    : (_weight, count) => n(count);
}

/** The type label's suffix, from what the committed unit says it measures. */
function suffixOf(v: QuestionView, q: Question): string | undefined {
  switch (v.kind) {
    case "bars":
      return v.unit === "multiSelect"
        ? t("survey.typeSuffixResponders")
        : v.unit === "rankingFirst"
          ? t("survey.typeSuffixFirstPreferences")
          : undefined;
    case "histogram":
      return t("survey.typeSuffixDistribution");
    case "rows":
      return v.unit === "points"
        ? t("survey.typeSuffixAverageAllocation")
        : q.type === "rating" && q.scale.type === "numeric"
          ? t("survey.typeSuffixNumericGrid")
          : t("survey.typeSuffixLabelledScale");
    case "custom":
      return t("survey.typeSuffixInterpretedOffchain");
  }
}

export const QuestionResult: Component<{
  q: Question | undefined;
  index: number;
  results: QuestionResults;
  /** Counted responders in this role — answered plus abstained. */
  responderCount: number;
  meta: Meta;
}> = (props) => (
  // `keyed` matters: the results object is swapped for a new one on every
  // role-filter or weighting change while staying truthy, and only a keyed Show
  // re-renders its children on a value (not truthiness) change.
  <Show when={props.q && props.results} keyed>
    {(results) => {
      const q = props.q!;
      const v = results.view;
      const abstained = Math.max(0, props.responderCount - v.answeredCount);
      const body = (): JSX.Element => {
        switch (v.kind) {
          case "bars":
            return (
              <Bars
                bars={v.bars.map((b) => ({
                  label: b.label,
                  meta: props.meta(b.weight, b.count),
                  pct: b.frac,
                }))}
              />
            );
          case "histogram":
            return <Histogram view={v} meta={props.meta} />;
          case "rows":
            return <Rows q={q} view={v} meta={props.meta} />;
          case "custom":
            return <Custom view={v} detail={results.detail} />;
        }
      };
      return (
        <ResultCard
          qLabel={t("survey.qLabel", { n: props.index + 1 })}
          typeLabel={typeLabel(q.type, suffixOf(v, q))}
          prompt={q.prompt}
          // Abstentions are the more informative figure when there are any;
          // otherwise everyone counted answered, and the count is the story.
          tally={
            abstained > 0
              ? t("survey.abstained", { n: n(abstained) })
              : t("survey.counted", { n: n(v.answeredCount) })
          }
        >
          {body()}
        </ResultCard>
      );
    }}
  </Show>
);
