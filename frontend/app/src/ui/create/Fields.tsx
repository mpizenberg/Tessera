/** The input primitives the type-specific question fields are built from. */

import { Index, Show, type Component } from "solid-js";

import { t } from "~/i18n";
import css from "./create.module.css";

export const OptionsEditor: Component<{
  labels: readonly string[];
  addLabel?: string;
  /** Show 0-based indices (rating labels store the 0-based level). */
  zeroBased?: boolean;
  /** Tag the first/last rows "worst"/"best" (ordered rating scale). */
  endBadges?: boolean;
  /** Optional mono hint line above the rows. */
  hint?: string;
  onLabel: (j: number, v: string) => void;
  onAdd: () => void;
  onRemove: (j: number) => void;
}> = (props) => (
  <div class={css.optionsList}>
    <Show when={props.hint}>
      <div class={css.scaleHint}>{props.hint}</div>
    </Show>
    <Index each={props.labels}>
      {(label, j) => (
        <div class={css.optionRow}>
          <span class={css.optIndex}>{props.zeroBased ? j : j + 1}</span>
          <input
            type="text"
            value={label()}
            placeholder={t("create.optionPlaceholder", { n: j + 1 })}
            onInput={(e) => props.onLabel(j, e.currentTarget.value)}
            class={css.optionInput}
          />
          <Show when={props.endBadges && j === 0}>
            <span class={css.endBadgeWorst}>{t("create.endBadgeWorst")}</span>
          </Show>
          <Show when={props.endBadges && j === props.labels.length - 1}>
            <span class={css.endBadgeBest}>{t("create.endBadgeBest")}</span>
          </Show>
          <Show when={props.labels.length > 2}>
            <button
              type="button"
              onClick={() => props.onRemove(j)}
              class={css.removeBtn}
              aria-label={t("create.removeOption", { n: j + 1 })}
            >
              ×
            </button>
          </Show>
        </div>
      )}
    </Index>
    <button
      type="button"
      onClick={() => props.onAdd()}
      class={css.addOptionBtn}
    >
      {props.addLabel ?? t("create.addOption")}
    </button>
  </div>
);

export const MinMaxRow: Component<{
  label: string;
  min: number;
  max: number;
  onMin: (n: number) => void;
  onMax: (n: number) => void;
  minAllowed: number;
}> = (props) => (
  <div class={css.fieldRow}>
    <label class={css.inlineField}>
      <span class={css.fieldLabel}>
        {t("create.minOf", { label: props.label })}
      </span>
      <input
        type="number"
        min={props.minAllowed}
        value={props.min}
        onInput={(e) => props.onMin(intOf(e.currentTarget.value))}
        class={css.miniNumber}
      />
    </label>
    <label class={css.inlineField}>
      <span class={css.fieldLabel}>
        {t("create.maxOf", { label: props.label })}
      </span>
      <input
        type="number"
        value={props.max}
        onInput={(e) => props.onMax(intOf(e.currentTarget.value))}
        class={css.miniNumber}
      />
    </label>
  </div>
);

export const NumericRow: Component<{
  min: string;
  max: string;
  step: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
  onStep: (v: string) => void;
}> = (props) => (
  <div class={css.fieldRow}>
    <label class={css.inlineField}>
      <span class={css.fieldLabel}>{t("create.min")}</span>
      <input
        type="text"
        value={props.min}
        onInput={(e) => props.onMin(e.currentTarget.value)}
        class={css.miniNumber}
      />
    </label>
    <label class={css.inlineField}>
      <span class={css.fieldLabel}>{t("create.max")}</span>
      <input
        type="text"
        value={props.max}
        onInput={(e) => props.onMax(e.currentTarget.value)}
        class={css.miniNumber}
      />
    </label>
    <label class={css.inlineField}>
      <span class={css.fieldLabel}>{t("create.stepOptional")}</span>
      <input
        type="text"
        value={props.step}
        placeholder={t("create.numericStepPlaceholder")}
        onInput={(e) => props.onStep(e.currentTarget.value)}
        class={css.miniNumber}
      />
    </label>
  </div>
);

export function intOf(s: string): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}
