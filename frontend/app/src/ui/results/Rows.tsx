/**
 * Per-option means: a points budget spread across options, or a rating given
 * to each. Points read as bars against the leading option; ratings read against
 * their scale, whose labels and span only the definition knows.
 */

import { For, Show, type Component } from "solid-js";
import type { Question } from "cip-179";
import { ratingScaleInfo, type QuestionView } from "~/domain/results";

import { t, n } from "~/i18n";
import { Bars, NoData } from "./Card";
import type { Meta } from "./Question";
import css from "./results.module.css";

export const Rows: Component<{
  q: Question;
  view: Extract<QuestionView, { kind: "rows" }>;
  meta: Meta;
}> = (props) =>
  props.view.unit === "rating" && props.q.type === "rating" ? (
    <Rating scale={props.q.scale} view={props.view} />
  ) : (
    // Normalized to the leading option's mean so the longest bar fills its
    // track; the figure is the mean itself, not a share of anything.
    <Bars
      bars={props.view.rows.map((row) => {
        const peak = Math.max(0, ...props.view.rows.map((r) => r.avg ?? 0));
        return {
          label: row.label,
          meta:
            row.avg === null
              ? "—"
              : t("survey.pointsMeta", {
                  avg: n(row.avg, { maximumFractionDigits: 1 }),
                }),
          pct: peak > 0 && row.avg !== null ? row.avg / peak : 0,
        };
      })}
    />
  );

/** Fraction 0–1 of `avg` within the scale's span. */
function withinScale(avg: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.max(0, Math.min(1, (avg - min) / (max - min)));
}

const Rating: Component<{
  scale: Extract<Question, { type: "rating" }>["scale"];
  view: Extract<QuestionView, { kind: "rows" }>;
}> = (props) => {
  const info = () => ratingScaleInfo(props.scale);
  const top = (): number => {
    const s = info();
    return s.baseMin + (s.levels - 1) * s.step;
  };
  const label = (avg: number): string => {
    const labels = info().levelLabels;
    if (!labels) return avg.toFixed(2);
    return `${labels[Math.round(avg)] ?? "—"} (${avg.toFixed(2)})`;
  };
  return (
    <>
      <Show when={info().levelLabels}>
        {(labels) => (
          <div class={css.ratingLegend}>
            <For each={labels()}>
              {(text, i) => (
                <span class={css.ratingLegendItem}>
                  <span class={css.ratingLegendIndex}>{i()}</span>
                  {text}
                </span>
              )}
            </For>
          </div>
        )}
      </Show>
      <Show when={props.view.answeredCount > 0} fallback={<NoData />}>
        <div class={css.ratingRows}>
          <For each={props.view.rows}>
            {(row) => (
              <div class={css.ratingRow}>
                <span class={css.ratingRowLabel}>{row.label}</span>
                <div class={css.ratingTrack}>
                  <div
                    class={css.ratingBar}
                    style={{
                      "--rating-pct": `${
                        row.avg === null
                          ? 0
                          : withinScale(row.avg, info().baseMin, top()) * 100
                      }%`,
                    }}
                  />
                </div>
                <span class={css.ratingAvg}>
                  {row.avg === null ? "—" : label(row.avg)}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </>
  );
};
