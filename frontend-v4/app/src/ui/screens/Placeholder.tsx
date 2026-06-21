import type { Component } from "solid-js";
import { A } from "@solidjs/router";

/** Stub for screens not yet built (Create, Settings). */
export const Placeholder: Component<{ title: string; note: string }> = (
  props,
) => (
  <main
    style={{
      "max-width": "760px",
      margin: "0 auto",
      padding: "60px 24px",
      "text-align": "center",
    }}
  >
    <h1
      style={{
        "font-size": "26px",
        "font-weight": "700",
        color: "var(--ink)",
        margin: "0",
      }}
    >
      {props.title}
    </h1>
    <p
      style={{
        "font-size": "14.5px",
        color: "var(--muted)",
        "line-height": "1.55",
        margin: "12px auto 0",
        "max-width": "440px",
      }}
    >
      {props.note}
    </p>
    <A
      href="/"
      style={{
        display: "inline-block",
        "margin-top": "20px",
        background: "var(--accent)",
        color: "#fff",
        "text-decoration": "none",
        "border-radius": "var(--r-control)",
        padding: "11px 18px",
        "font-size": "14px",
        "font-weight": "700",
      }}
    >
      ← Back to all surveys
    </A>
  </main>
);
