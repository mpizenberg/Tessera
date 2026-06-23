/**
 * Shared validation/error callouts used by the Create and Respond screens.
 *
 * Both screens render the same danger-toned box for "fix these problems before
 * you can proceed" and for "the submission failed"; the only thing that varies
 * is the heading, so it is a prop.
 */

import { For, type Component, type JSX } from "solid-js";

function boxStyle(): JSX.CSSProperties {
  return {
    background: "var(--danger-bg)",
    border: "1px solid var(--danger-line)",
    "border-radius": "var(--r-md)",
    padding: "13px 15px",
    "margin-top": "14px",
  };
}

function headingStyle(): JSX.CSSProperties {
  return {
    "font-size": "13px",
    "font-weight": "700",
    color: "var(--danger)",
  };
}

/** A bulleted list of blocking problems (e.g. unmet publish/submit rules). */
export const ProblemList: Component<{ title: string; problems: string[] }> = (
  props,
) => (
  <div style={boxStyle()}>
    <div style={headingStyle()}>{props.title}</div>
    <ul
      style={{
        margin: "8px 0 0",
        padding: "0 0 0 18px",
        color: "#8A3A2E",
        "font-size": "12.5px",
        "line-height": "1.6",
      }}
    >
      <For each={props.problems}>{(p) => <li>{p}</li>}</For>
    </ul>
  </div>
);

/** A single error message (e.g. a failed on-chain submission). */
export const ErrorBox: Component<{ title?: string; message: string }> = (
  props,
) => (
  <div style={boxStyle()}>
    <div style={headingStyle()}>{props.title ?? "Submission failed"}</div>
    <div
      style={{
        "font-size": "12.5px",
        color: "#8A3A2E",
        "line-height": "1.5",
        "margin-top": "5px",
        "word-break": "break-word",
      }}
    >
      {props.message}
    </div>
  </div>
);
