/**
 * A dedicated overlay shown during multi-step submissions (pin → encrypt →
 * sign & submit), so the user sees exactly where a longer flow is rather than a
 * single button that just says "Submitting…". Single-step submits don't use it.
 */

import { For, Show, type Component, type JSX } from "solid-js";

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
    props.steps.findIndex((s) => s.key === props.currentKey);
  const stateOf = (i: number): StepState => {
    const a = activeIndex();
    if (a < 0) return "pending";
    if (i < a) return "done";
    return i === a ? "active" : "pending";
  };
  return (
    <div style={backdropStyle}>
      <div style={cardStyle}>
        <h3 style={titleStyle}>{props.title}</h3>
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "13px",
            "margin-top": "18px",
          }}
        >
          <For each={props.steps}>
            {(step, i) => <StepRow label={step.label} state={stateOf(i())} />}
          </For>
        </div>
        <p style={noteStyle}>
          Approve the transaction in your wallet when prompted — don't close
          this tab.
        </p>
      </div>
    </div>
  );
};

const StepRow: Component<{ label: string; state: StepState }> = (props) => (
  <div style={{ display: "flex", "align-items": "center", gap: "11px" }}>
    <StepIcon state={props.state} />
    <span
      style={{
        "font-size": "13.5px",
        "font-weight": props.state === "active" ? "700" : "600",
        color: props.state === "pending" ? "var(--faint)" : "var(--ink)",
      }}
    >
      {props.label}
    </span>
  </div>
);

const StepIcon: Component<{ state: StepState }> = (props) => (
  <Show
    when={props.state !== "pending"}
    fallback={
      <span
        style={{
          width: "16px",
          height: "16px",
          "border-radius": "50%",
          border: "2px solid var(--line)",
          flex: "none",
        }}
      />
    }
  >
    <Show
      when={props.state === "active"}
      fallback={
        <span
          style={{
            display: "inline-flex",
            "align-items": "center",
            "justify-content": "center",
            width: "16px",
            height: "16px",
            "border-radius": "50%",
            background: "var(--ok-bg)",
            color: "var(--ok)",
            "font-size": "11px",
            flex: "none",
          }}
        >
          ✓
        </span>
      }
    >
      <span
        style={{
          width: "16px",
          height: "16px",
          "border-radius": "50%",
          border: "2px solid var(--line)",
          "border-top-color": "var(--accent)",
          animation: "spin 0.8s linear infinite",
          flex: "none",
        }}
      />
    </Show>
  </Show>
);

const backdropStyle: JSX.CSSProperties = {
  position: "fixed",
  inset: "0",
  background: "rgba(40,33,20,.45)",
  "backdrop-filter": "blur(2px)",
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  padding: "20px",
  "z-index": "80",
};

const cardStyle: JSX.CSSProperties = {
  background: "#fff",
  border: "1px solid var(--line)",
  "border-radius": "var(--r-card)",
  "box-shadow": "0 24px 60px -20px rgba(70,55,30,.5)",
  padding: "24px 26px",
  width: "100%",
  "max-width": "380px",
};

const titleStyle: JSX.CSSProperties = {
  "font-size": "18px",
  "font-weight": "800",
  "letter-spacing": "-.01em",
  margin: "0",
  color: "var(--ink)",
};

const noteStyle: JSX.CSSProperties = {
  "font-size": "12px",
  color: "var(--muted)",
  "line-height": "1.5",
  margin: "18px 0 0",
};
