/** Numeric answers: the weighted distribution, with its mean and median. */

import { For, Show, type Component } from "solid-js";
import type { QuestionView } from "~/domain/results";

import { t, n } from "~/i18n";
import { NoData } from "./Card";
import type { Meta } from "./Question";
import css from "./results.module.css";

export const Histogram: Component<{
  view: Extract<QuestionView, { kind: "histogram" }>;
  meta: Meta;
}> = (props) => {
  const peak = (): bigint =>
    props.view.bins.reduce((m, b) => (b.weight > m ? b.weight : m), 1n);
  const stat = (value: number | null): string =>
    value === null ? "—" : n(value);
  return (
    <>
      <div class={css.histStats}>
        <span class={css.histStat}>
          {t("survey.histMean")}{" "}
          <b class={css.histStatValue}>{stat(props.view.mean)}</b>
        </span>
        <span class={css.histStat}>
          {t("survey.histMedian")}{" "}
          <b class={css.histStatValue}>{stat(props.view.median)}</b>
        </span>
      </div>
      <Show when={props.view.bins.length > 0} fallback={<NoData />}>
        <div class={css.histBars}>
          <For each={props.view.bins}>
            {(b) => (
              <div class={css.histCol} title={props.meta(b.weight, b.count)}>
                <span class={css.histCount}>{n(b.count)}</span>
                <div class={css.histColTrack}>
                  <div
                    class={css.histBar}
                    style={{
                      "--hist-h": `${Number((b.weight * 100n) / peak())}%`,
                    }}
                  />
                </div>
                <span class={css.histLabel}>{b.label}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </>
  );
};
