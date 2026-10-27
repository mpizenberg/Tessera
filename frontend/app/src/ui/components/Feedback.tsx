/**
 * Shared validation/error callouts used by the Create and Respond screens.
 *
 * Both screens render the same danger-toned box for "fix these problems before
 * you can proceed" and for "the submission failed"; the only thing that varies
 * is the heading, so it is a prop.
 */

import { For, onMount, type Component, type ParentComponent } from "solid-js";

import { t } from "~/i18n";
import css from "./Feedback.module.css";

/**
 * The box appears in answer to an action (submit, publish, import) whose
 * button can be a screen away, behind a sticky bar on a phone — so it brings
 * itself into view, or the failure goes unseen.
 */
const Box: ParentComponent = (props) => {
  let el!: HTMLDivElement;
  onMount(() => el.scrollIntoView({ block: "center" }));
  return (
    <div ref={el} class={css.box}>
      {props.children}
    </div>
  );
};

/** A bulleted list of blocking problems (e.g. unmet publish/submit rules). */
export const ProblemList: Component<{ title: string; problems: string[] }> = (
  props,
) => (
  <Box>
    <div class={css.heading}>{props.title}</div>
    <ul class={css.list}>
      <For each={props.problems}>{(p) => <li>{p}</li>}</For>
    </ul>
  </Box>
);

/** A single error message (e.g. a failed on-chain submission). */
export const ErrorBox: Component<{ title?: string; message: string }> = (
  props,
) => (
  <Box>
    <div class={css.heading}>
      {props.title ?? t("feedback.submissionFailed")}
    </div>
    <div class={css.message}>{props.message}</div>
  </Box>
);
