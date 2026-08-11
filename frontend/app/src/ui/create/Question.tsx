/** The per-question editor: header row, prompt, and the type-specific fields. */

import { For, Show, type Component } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";

import {
  QUESTION_TYPES,
  questionTypeLabel,
  usesOptions,
  type QuestionDraft,
  type QuestionType,
} from "~/domain/create";
import { t } from "~/i18n";
import { MinMaxRow, NumericRow, OptionsEditor, intOf } from "./Fields";
import css from "./create.module.css";

export const QuestionEditor: Component<{
  index: number;
  draft: QuestionDraft;
  set: SetStoreFunction<QuestionDraft[]>;
  canRemove: boolean;
  onRemove: () => void;
}> = (props) => {
  const i = () => props.index;
  return (
    <div class={css.card}>
      <div class={css.qHeadRow}>
        <div class={css.qHeadLeft}>
          <span class={css.qChip}>
            {t("create.questionChip", { n: props.index + 1 })}
          </span>
          <select
            value={props.draft.type}
            onChange={(e) =>
              props.set(i(), "type", e.currentTarget.value as QuestionType)
            }
            class={css.select}
          >
            <For each={QUESTION_TYPES}>
              {(t) => <option value={t}>{questionTypeLabel(t)}</option>}
            </For>
          </select>
        </div>
        <div class={css.qHeadRight}>
          <button
            type="button"
            aria-pressed={props.draft.required}
            onClick={() => props.set(i(), "required", !props.draft.required)}
            class={css.requiredBtn}
            classList={{ [css.requiredBtnOn]: props.draft.required }}
          >
            {props.draft.required ? t("create.required") : t("create.optional")}
          </button>
          <Show when={props.canRemove}>
            <button
              type="button"
              onClick={() => props.onRemove()}
              class={css.removeBtn}
              aria-label={t("create.removeQuestion")}
            >
              ×
            </button>
          </Show>
        </div>
      </div>

      <input
        type="text"
        value={props.draft.prompt}
        placeholder={t("create.promptPlaceholder")}
        onInput={(e) => props.set(i(), "prompt", e.currentTarget.value)}
        class={css.promptInput}
      />

      <div class={css.typeFields}>
        <TypeFields index={i()} draft={props.draft} set={props.set} />
      </div>
    </div>
  );
};

const TypeFields: Component<{
  index: number;
  draft: QuestionDraft;
  set: SetStoreFunction<QuestionDraft[]>;
}> = (props) => {
  const i = () => props.index;
  // Add an option row; for multi-select / ranking, grow the max ceiling to the
  // new option count (it can never exceed the number of options anyway).
  const addOption = () => {
    const newCount = props.draft.labels.length + 1;
    props.set(i(), "labels", (ls) => [...ls, ""]);
    if (props.draft.type === "multiSelect") {
      props.set(i(), "maxSelections", (m) => Math.max(m, newCount));
    } else if (props.draft.type === "ranking") {
      props.set(i(), "maxRanked", (m) => Math.max(m, newCount));
    }
  };
  return (
    <>
      <Show when={usesOptions(props.draft.type)}>
        <OptionsEditor
          labels={props.draft.labels}
          onLabel={(j, v) => props.set(i(), "labels", j, v)}
          onAdd={addOption}
          onRemove={(j) =>
            props.set(i(), "labels", (ls) => ls.filter((_, k) => k !== j))
          }
        />
      </Show>

      <Show when={props.draft.type === "multiSelect"}>
        <MinMaxRow
          label={t("create.selectionsLabel")}
          min={props.draft.minSelections}
          max={props.draft.maxSelections}
          onMin={(v) => props.set(i(), "minSelections", v)}
          onMax={(v) => props.set(i(), "maxSelections", v)}
          minAllowed={0}
        />
      </Show>

      <Show when={props.draft.type === "ranking"}>
        <MinMaxRow
          label={t("create.rankedLabel")}
          min={props.draft.minRanked}
          max={props.draft.maxRanked}
          onMin={(v) => props.set(i(), "minRanked", v)}
          onMax={(v) => props.set(i(), "maxRanked", v)}
          minAllowed={1}
        />
      </Show>

      <Show when={props.draft.type === "numericRange"}>
        <NumericRow
          min={props.draft.numMin}
          max={props.draft.numMax}
          step={props.draft.numStep}
          onMin={(v) => props.set(i(), "numMin", v)}
          onMax={(v) => props.set(i(), "numMax", v)}
          onStep={(v) => props.set(i(), "numStep", v)}
        />
      </Show>

      <Show when={props.draft.type === "pointsAllocation"}>
        <label class={css.inlineField}>
          <span class={css.fieldLabel}>{t("create.budget")}</span>
          <input
            type="number"
            value={props.draft.budget}
            onInput={(e) =>
              props.set(i(), "budget", intOf(e.currentTarget.value))
            }
            class={css.budgetInput}
          />
        </label>
      </Show>

      <Show when={props.draft.type === "rating"}>
        <div class={css.ratingBlock}>
          <div class={css.ratingPillRow}>
            <button
              type="button"
              aria-pressed={props.draft.ratingScale === "numeric"}
              onClick={() => props.set(i(), "ratingScale", "numeric")}
              class={css.pill}
              classList={{
                [css.pillOn]: props.draft.ratingScale === "numeric",
              }}
            >
              {t("create.ratingNumericScale")}
            </button>
            <button
              type="button"
              aria-pressed={props.draft.ratingScale === "labels"}
              onClick={() => props.set(i(), "ratingScale", "labels")}
              class={css.pill}
              classList={{ [css.pillOn]: props.draft.ratingScale === "labels" }}
            >
              {t("create.ratingLabelledScale")}
            </button>
          </div>
          <Show
            when={props.draft.ratingScale === "numeric"}
            fallback={
              <OptionsEditor
                labels={props.draft.ratingLabels}
                addLabel={t("create.addLevel")}
                zeroBased
                endBadges
                hint={t("create.scaleHint")}
                onLabel={(j, v) => props.set(i(), "ratingLabels", j, v)}
                onAdd={() =>
                  props.set(i(), "ratingLabels", (ls) => [...ls, ""])
                }
                onRemove={(j) =>
                  props.set(i(), "ratingLabels", (ls) =>
                    ls.filter((_, k) => k !== j),
                  )
                }
              />
            }
          >
            <NumericRow
              min={props.draft.ratingMin}
              max={props.draft.ratingMax}
              step={props.draft.ratingStep}
              onMin={(v) => props.set(i(), "ratingMin", v)}
              onMax={(v) => props.set(i(), "ratingMax", v)}
              onStep={(v) => props.set(i(), "ratingStep", v)}
            />
          </Show>
          <button
            type="button"
            role="switch"
            aria-checked={props.draft.requireAll}
            onClick={() =>
              props.set(i(), "requireAll", !props.draft.requireAll)
            }
            class={css.requireAllRow}
          >
            <span
              class={css.requireAllTrack}
              classList={{ [css.requireAllTrackOn]: props.draft.requireAll }}
            >
              <span
                class={css.requireAllKnob}
                classList={{ [css.requireAllKnobOn]: props.draft.requireAll }}
              />
            </span>
            <span class={css.requireAllLabel}>
              {t("create.ratingRequireAllLabel")}
            </span>
          </button>
          <p class={css.hint}>{t("create.ratingRequireAllHint")}</p>
        </div>
      </Show>

      <Show when={props.draft.type === "custom"}>
        <div class={css.customFields}>
          <label class={css.blockLabel}>
            <span class={css.fieldLabel}>{t("create.customUriLabel")}</span>
            <input
              type="text"
              value={props.draft.customUri}
              placeholder={t("create.customUriPlaceholder")}
              onInput={(e) =>
                props.set(i(), "customUri", e.currentTarget.value)
              }
              class={css.customInput}
            />
          </label>
          <label class={css.blockLabel}>
            <span class={css.fieldLabel}>{t("create.customHashLabel")}</span>
            <input
              type="text"
              value={props.draft.customHash}
              placeholder={t("create.customHashPlaceholder")}
              onInput={(e) =>
                props.set(i(), "customHash", e.currentTarget.value)
              }
              class={css.customInput}
            />
          </label>
        </div>
      </Show>
    </>
  );
};
