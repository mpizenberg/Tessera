/**
 * The sticky submit bar and the receipt that replaces the form once a response
 * is on its way.
 */

import { Index, Show, type Component } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { QuestionProgress } from "cardano-tessera-respond-ui";

import { SubmissionReceipt } from "~/ui/components/SubmissionReceipt";
import { t, n } from "~/i18n";
import css from "./respond.module.css";

export const SubmitBar: Component<{
  /** Each question's state, hidden ones reading skipped. */
  progress: readonly QuestionProgress[];
  /** At least one question carries a recorded answer (not all-skipped). */
  answered: boolean;
  replacing: boolean;
  submitting: boolean;
  mismatch: boolean;
  /** Why submitting is impossible, if it is — shown as a note, disables the button. */
  blocked?: string | undefined;
  /** Submitting is still possible but time-critical (deadline within minutes). */
  warning?: string | undefined;
  network: string;
  idleText: string;
  busyText: string;
  /** True when submitting would queue the response rather than sign it now. */
  queueing: boolean;
  onSubmit: () => void;
  onQueue: () => void;
}> = (props) => {
  const decided = () => props.progress.filter((p) => p !== "undecided").length;
  const total = () => props.progress.length;
  const ready = () =>
    decided() >= total() &&
    total() > 0 &&
    props.answered &&
    !props.mismatch &&
    !props.blocked;
  return (
    <div class={css.submitBar}>
      <div class={css.submitInner}>
        <div class={css.submitStatus}>
          <span class={css.progressDots}>
            <Index each={props.progress}>
              {(p) => (
                <span
                  class={css.progressDot}
                  classList={{
                    [css.progressDotOn]: p() === "answered",
                    [css.progressDotSkipped]: p() === "skipped",
                  }}
                />
              )}
            </Index>
          </span>
          <span class={css.decidedCount}>
            {t("respond.decidedCount", {
              decided: n(decided()),
              total: n(total()),
            })}
          </span>
          <Show when={props.replacing}>
            <span class={css.replacesNote}>{t("respond.replacesNote")}</span>
          </Show>
          <Show when={props.mismatch}>
            <span class={css.mismatchNote}>
              {t("respond.switchNetwork", { network: props.network })}
            </span>
          </Show>
          <Show when={props.blocked}>
            {(note) => <span class={css.mismatchNote}>{note()}</span>}
          </Show>
          <Show when={props.warning}>
            {(note) => <span class={css.mismatchNote}>{note()}</span>}
          </Show>
        </div>
        <div class={css.submitActions}>
          <Show when={!props.queueing}>
            <button
              onClick={() => props.onQueue()}
              disabled={!ready() || props.submitting}
              class={css.queueBtn}
            >
              {t("cart.addToCart")}
            </button>
          </Show>
          <button
            onClick={() =>
              props.queueing ? props.onQueue() : props.onSubmit()
            }
            disabled={!ready() || props.submitting}
            class={css.submitBtn}
            classList={{ [css.submitBtnEnabled]: ready() && !props.submitting }}
          >
            {props.submitting
              ? props.busyText
              : props.queueing
                ? t("cart.addToCart")
                : props.idleText}{" "}
            <span class={css.submitArrow}>→</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export const SubmittedPanel: Component<{ hash: string; surveyKey: string }> = (
  props,
) => {
  const navigate = useNavigate();
  return (
    <SubmissionReceipt
      title={t("respond.submittedTitle")}
      body={t("respond.submittedText")}
      hash={props.hash}
      actions={[
        {
          label: t("respond.viewResults"),
          onClick: () =>
            navigate(`/survey/${encodeURIComponent(props.surveyKey)}`),
        },
      ]}
    />
  );
};
