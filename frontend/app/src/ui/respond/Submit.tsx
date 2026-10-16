/**
 * The sticky submit bar and the receipt that replaces the form once a response
 * is on its way.
 */

import { Index, Show, onCleanup, onMount, type Component } from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  LeftNote,
  SkipConfirm,
  type Finish,
  type Left,
  type QuestionProgress,
} from "cardano-tessera-respond-ui";

import { SubmissionReceipt } from "~/ui/components/SubmissionReceipt";
import { t } from "~/i18n";
import { RespondContexts } from "./Question";
import css from "./respond.module.css";

export const SubmitBar: Component<{
  /** Each question's state. */
  progress: readonly QuestionProgress[];
  left: Left;
  /** At least one question carries a recorded answer (not all-skipped). */
  answered: boolean;
  finish: Finish;
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
  submitRef: (el: HTMLButtonElement) => void;
  /** Receives the bar's height as it changes, and 0 once it is gone. */
  onHeight: (px: number) => void;
}> = (props) => {
  const enabled = () => !props.mismatch && !props.blocked && !props.submitting;
  let button: HTMLButtonElement | undefined;
  let bar!: HTMLDivElement;
  onMount(() => {
    const sizes = new ResizeObserver(() => props.onHeight(bar.offsetHeight));
    sizes.observe(bar);
    onCleanup(() => {
      sizes.disconnect();
      props.onHeight(0);
    });
  });
  return (
    <div ref={bar} class={css.submitBar}>
      <div class={css.submitInner}>
        <RespondContexts>
          <Show
            when={props.finish.asking() === "skip"}
            fallback={
              <>
                <div class={css.submitStatus}>
                  <span class={css.progressDots}>
                    <Index each={props.progress}>
                      {(p) => (
                        <span
                          class={css.progressDot}
                          classList={{
                            [css.progressDotOn]: p() === "answered",
                            [css.progressDotSkipped]:
                              p() === "skipped" || p() === "hidden",
                          }}
                        />
                      )}
                    </Index>
                  </span>
                  <LeftNote
                    left={props.left}
                    answered={props.answered}
                    calling={props.finish.asking() === "answerOne"}
                    onGoTo={props.finish.goTo}
                  />
                  <Show when={props.replacing}>
                    <span class={css.replacesNote}>
                      {t("respond.replacesNote")}
                    </span>
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
                      onClick={() => props.finish.finish(props.onQueue)}
                      disabled={!enabled()}
                      class={css.queueBtn}
                    >
                      {t("cart.addToCart")}
                    </button>
                  </Show>
                  <button
                    ref={(el) => {
                      button = el;
                      props.submitRef(el);
                    }}
                    onClick={() =>
                      props.finish.finish(
                        props.queueing ? props.onQueue : props.onSubmit,
                      )
                    }
                    disabled={!enabled()}
                    class={css.submitBtn}
                    classList={{ [css.submitBtnEnabled]: enabled() }}
                  >
                    {props.submitting
                      ? props.busyText
                      : props.queueing
                        ? t("cart.addToCart")
                        : props.idleText}{" "}
                    <span class={css.submitArrow}>→</span>
                  </button>
                </div>
              </>
            }
          >
            <SkipConfirm
              unanswered={props.left.unanswered}
              onSkip={() => {
                props.finish.skipAndFinish();
                button?.focus();
              }}
              onGoTo={props.finish.goTo}
            />
          </Show>
        </RespondContexts>
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
