/**
 * Per-option means: a points budget spread across options, or a rating given
 * to each. Points read as bars against the leading option; ratings read against
 * their scale, whose labels and span only the definition knows.
 */

import { For, Show, type Component } from "solid-js";
import type { Question } from "cip-179";
import {
  decimalOf,
  fixed4,
  fracOf,
  ratingScaleInfo,
  type Fixed4,
  type QuestionView,
} from "~/domain/results";

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
        const peak = props.view.rows.reduce(
          (m, r) => (r.avg !== null && r.avg > m ? r.avg : m),
          0n,
        );
        return {
          label: row.label,
          meta:
            row.avg === null
              ? "—"
              : t("survey.pointsMeta", {
                  avg: n(decimalOf(row.avg), { maximumFractionDigits: 1 }),
                }),
          pct: row.avg === null ? 0 : fracOf(row.avg, peak),
        };
      })}
    />
  );

/** Fraction 0–1 of `avg` within `[min, top]`. */
function withinScale(avg: Fixed4, min: bigint, top: bigint): number {
  const span = fixed4(top - min);
  return Math.max(0, Math.min(1, fracOf(avg - fixed4(min), span)));
}

const Rating: Component<{
  scale: Extract<Question, { type: "rating" }>["scale"];
  view: Extract<QuestionView, { kind: "rows" }>;
}> = (props) => {
  const info = () => ratingScaleInfo(props.scale);
  const label = (avg: Fixed4): string => {
    const labels = info().levelLabels;
    if (!labels) return decimalOf(avg, 2);
    return `${labels[Number(decimalOf(avg, 0))] ?? "—"} (${decimalOf(avg, 2)})`;
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
                          : withinScale(row.avg, info().min, info().top) * 100
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
