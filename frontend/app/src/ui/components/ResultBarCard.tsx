import { For, type Component } from "solid-js";

import css from "./ResultBarCard.module.css";

export interface ResultBar {
  readonly label: string;
  readonly meta: string;
  /** Fill fraction 0–1. */
  readonly pct: number;
}

export interface ResultBarCardProps {
  readonly qLabel: string;
  readonly typeLabel: string;
  readonly title: string;
  readonly abstainText: string;
  readonly bars: readonly ResultBar[];
}

/** Bar-chart result card, ported from ResultBarCard.dc.html. */
export const ResultBarCard: Component<ResultBarCardProps> = (props) => (
  <div class={css.card}>
    <div class={css.head}>
      <div class={css.headLeft}>
        <span class={css.qLabel}>{props.qLabel}</span>
        <div class={css.typeLabel}>{props.typeLabel}</div>
      </div>
      <span class={css.abstain}>{props.abstainText}</span>
    </div>
    <h3 class={css.title}>{props.title}</h3>
    <div class={css.bars}>
      <For each={props.bars}>
        {(b) => (
          <div>
            <div class={css.barHead}>
              <span class={css.barLabel}>{b.label}</span>
              <span class={css.barMeta}>{b.meta}</span>
            </div>
            <div class={css.track}>
              <div
                class={css.fill}
                style={{
                  "--pct": `${Math.round(Math.max(0, Math.min(1, b.pct)) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}
      </For>
    </div>
  </div>
);
