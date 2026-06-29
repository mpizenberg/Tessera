/**
 * Shared validation/error callouts used by the Create and Respond screens.
 *
 * Both screens render the same danger-toned box for "fix these problems before
 * you can proceed" and for "the submission failed"; the only thing that varies
 * is the heading, so it is a prop.
 */

import { For, type Component } from "solid-js";

import css from "./Feedback.module.css";

/** A bulleted list of blocking problems (e.g. unmet publish/submit rules). */
export const ProblemList: Component<{ title: string; problems: string[] }> = (
  props,
) => (
  <div class={css.box}>
    <div class={css.heading}>{props.title}</div>
    <ul class={css.list}>
      <For each={props.problems}>{(p) => <li>{p}</li>}</For>
    </ul>
  </div>
);

/** A single error message (e.g. a failed on-chain submission). */
export const ErrorBox: Component<{ title?: string; message: string }> = (
  props,
) => (
  <div class={css.box}>
    <div class={css.heading}>{props.title ?? "Submission failed"}</div>
    <div class={css.message}>{props.message}</div>
  </div>
);
