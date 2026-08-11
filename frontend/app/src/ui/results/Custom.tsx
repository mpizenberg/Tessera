/**
 * Free-form answers: the committed tally counts participation and stops there —
 * interpreting the values is the method schema's job, off-chain. The verbatim
 * samples below it are read back from the counted responses, not committed.
 */

import { For, Show, type Component } from "solid-js";
import type { QuestionDetail, QuestionView } from "~/domain/results";

import { t, n } from "~/i18n";
import { DerivedNote } from "./Card";
import css from "./results.module.css";

export const Custom: Component<{
  view: Extract<QuestionView, { kind: "custom" }>;
  detail: QuestionDetail;
}> = (props) => (
  <>
    <div class={css.customCount}>
      <span class={css.customCountValue}>{n(props.view.answeredCount)}</span>
      <span class={css.customCountLabel}>{t("survey.customCountLabel")}</span>
    </div>
    <Show when={props.detail.samples}>
      {(samples) => (
        <div class={css.customSamples}>
          <For each={samples()}>
            {(x) => <span class={css.customSample}>“{x}”</span>}
          </For>
          <DerivedNote />
        </div>
      )}
    </Show>
  </>
);
