/**
 * A dedicated overlay shown during multi-step submissions (pin → encrypt →
 * sign & submit), so the user sees exactly where a longer flow is rather than a
 * single button that just says "Submitting…". Single-step submits don't use it.
 */

import { For, Show, createUniqueId, onMount, type Component } from "solid-js";

import { Spinner } from "~/ui/components/Spinner";
import css from "./SubmitProgress.module.css";

export interface SubmitStep {
  key: string;
  label: string;
}

type StepState = "done" | "active" | "pending";

export const SubmitProgressModal: Component<{
  title: string;
  steps: SubmitStep[];
  /** The step currently in progress; earlier steps render as done. */
  currentKey: string | null;
}> = (props) => {
  const activeIndex = () =>
    props.steps.findIndex((step) => step.key === props.currentKey);
  const stateOf = (i: number): StepState => {
    const a = activeIndex();
    if (a < 0) return "pending";
    if (i < a) return "done";
    return i === a ? "active" : "pending";
  };

  const titleId = createUniqueId();
  let cardRef: HTMLDivElement | undefined;
  // Move focus into the blocking dialog on mount so keyboard / screen-reader
  // users land on it (the card is programmatically focusable but out of tab order).
  onMount(() => cardRef?.focus());

  return (
    <div class={css.backdrop} role="presentation">
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabindex="-1"
        class={css.card}
      >
        <h3 id={titleId} class={css.title}>
          {props.title}
        </h3>
        {/* Screen-reader announcement of the current step (the visual list
            below conveys the same via icon/weight, which AT can't read). */}
        <p class={css.srOnly} aria-live="polite">
          <Show when={activeIndex() >= 0}>
            Step {activeIndex() + 1} of {props.steps.length}:{" "}
            {props.steps[activeIndex()]?.label}
          </Show>
        </p>
        <div class={css.steps}>
          <For each={props.steps}>
            {(step, i) => <StepRow label={step.label} state={stateOf(i())} />}
          </For>
        </div>
        <p class={css.note}>
          Approve the transaction in your wallet when prompted — don't close
          this tab.
        </p>
      </div>
    </div>
  );
};

const StepRow: Component<{ label: string; state: StepState }> = (props) => (
  <div class={css.row}>
    <StepIcon state={props.state} />
    <span
      class={css.label}
      classList={{
        [css.labelActive]: props.state === "active",
        [css.labelPending]: props.state === "pending",
      }}
    >
      {props.label}
    </span>
  </div>
);

const StepIcon: Component<{ state: StepState }> = (props) => (
  <Show
    when={props.state !== "pending"}
    fallback={<span class={css.iconPending} />}
  >
    <Show
      when={props.state === "active"}
      fallback={<span class={css.iconDone}>✓</span>}
    >
      <Spinner />
    </Show>
  </Show>
);
