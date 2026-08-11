/** The chrome every result card shares, and the two bodies most of them use. */

import { For, Show, type Component, type JSX } from "solid-js";
import type { Question } from "cip-179";

import { t } from "~/i18n";
import css from "./results.module.css";

const BASE_TYPE_KEY: Record<Question["type"], string> = {
  custom: "typeCustom",
  singleChoice: "typeSingleChoice",
  multiSelect: "typeMultiSelect",
  ranking: "typeRanking",
  numericRange: "typeNumericRange",
  pointsAllocation: "typePointsAllocation",
  rating: "typeRating",
};

/** Localized base type label; resolved at render time so it tracks the locale. */
export const baseType = (type: Question["type"]): string =>
  t(`survey.${BASE_TYPE_KEY[type]}` as Parameters<typeof t>[0]);

/** `<base> · <suffix>`, e.g. "MULTI-SELECT · % OF RESPONDERS". */
export const typeLabel = (type: Question["type"], suffix?: string): string =>
  suffix
    ? t("survey.typeLabelJoined", { base: baseType(type), suffix })
    : baseType(type);

export const ResultCard: Component<{
  qLabel: string;
  typeLabel: string;
  prompt: string;
  /** Right-hand count chip: how many abstained, or how many were counted. */
  tally?: string;
  children: JSX.Element;
}> = (props) => (
  <div class={css.card}>
    <div class={css.cardHead}>
      <div class={css.cardHeadLeft}>
        <span class={css.qChip}>{props.qLabel}</span>
        <div class={css.typeLabel}>{props.typeLabel}</div>
      </div>
      <Show when={props.tally}>
        <span class={css.abstain}>{props.tally}</span>
      </Show>
    </div>
    <h3 class={css.cardTitle}>{props.prompt || t("survey.noPrompt")}</h3>
    {props.children}
  </div>
);

export interface Bar {
  readonly label: string;
  readonly meta: string;
  /** Fill fraction 0–1. */
  readonly pct: number;
}

/** Horizontal bars with a label and a right-aligned figure each. */
export const Bars: Component<{ bars: readonly Bar[] }> = (props) => (
  <Show when={props.bars.length > 0} fallback={<NoData />}>
    <div class={css.bars}>
      <For each={props.bars}>
        {(b) => (
          <div>
            <div class={css.barHead}>
              <span class={css.barLabel}>{b.label}</span>
              <span class={css.barMeta}>{b.meta}</span>
            </div>
            <div class={css.barTrack}>
              <div
                class={css.barFill}
                style={{
                  "--pct": `${Math.round(Math.max(0, Math.min(1, b.pct)) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}
      </For>
    </div>
  </Show>
);

export const NoData: Component = () => (
  <p class={css.noData}>{t("survey.noResponsesYet")}</p>
);

/**
 * Marks a figure that was recomputed in the browser from the counted responses
 * rather than read from the tally artifact — true of every supplementary
 * detail, and the reason it must never be mistaken for a hash-covered number.
 */
export const DerivedNote: Component = () => (
  <span class={css.derived} title={t("survey.derivedTitle")}>
    {t("survey.derived")}
  </span>
);
