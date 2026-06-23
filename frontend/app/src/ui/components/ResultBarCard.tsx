import { For, type Component } from "solid-js";

export interface ResultBar {
  readonly label: string;
  readonly meta: string;
  /** Fill fraction 0–1. */
  readonly pct: number;
}

export interface ResultBarCardProps {
  readonly qLabel: string;
  readonly typeLabel: string;
  readonly title: string;
  readonly abstainText: string;
  readonly bars: readonly ResultBar[];
}

/** Bar-chart result card, ported from ResultBarCard.dc.html. */
export const ResultBarCard: Component<ResultBarCardProps> = (props) => (
  <div
    style={{
      background: "#fff",
      border: "1px solid var(--line)",
      "border-radius": "var(--r-card)",
      padding: "22px",
    }}
  >
    <div
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        gap: "10px",
        "flex-wrap": "wrap",
      }}
    >
      <div style={{ display: "flex", gap: "10px", "align-items": "center" }}>
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "12px",
            "font-weight": "600",
            color: "var(--accent)",
            background: "var(--accent-bg)",
            "border-radius": "var(--r-chip)",
            padding: "5px 8px",
          }}
        >
          {props.qLabel}
        </span>
        <div
          style={{
            "font-family": "var(--mono)",
            "font-size": "10px",
            "letter-spacing": ".06em",
            "text-transform": "uppercase",
            color: "var(--dim)",
          }}
        >
          {props.typeLabel}
        </div>
      </div>
      <span
        style={{
          "font-family": "var(--mono)",
          "font-size": "11px",
          color: "var(--faint)",
          background: "var(--surface3)",
          "border-radius": "var(--r-xs)",
          padding: "5px 9px",
          "white-space": "nowrap",
        }}
      >
        {props.abstainText}
      </span>
    </div>
    <h3
      style={{
        "font-size": "16.5px",
        "font-weight": "700",
        "line-height": "1.3",
        margin: "11px 0 0",
        color: "var(--ink)",
      }}
    >
      {props.title}
    </h3>
    <div
      style={{
        "margin-top": "16px",
        display: "flex",
        "flex-direction": "column",
        gap: "13px",
      }}
    >
      <For each={props.bars}>
        {(b) => (
          <div>
            <div
              style={{
                display: "flex",
                "align-items": "center",
                "justify-content": "space-between",
                "margin-bottom": "7px",
              }}
            >
              <span
                style={{
                  "font-size": "13.5px",
                  color: "var(--body)",
                  "font-weight": "600",
                }}
              >
                {b.label}
              </span>
              <span
                style={{
                  "font-family": "var(--mono)",
                  "font-size": "12px",
                  color: "var(--muted)",
                }}
              >
                {b.meta}
              </span>
            </div>
            <div
              style={{
                height: "10px",
                "border-radius": "99px",
                background: "var(--track)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.round(Math.max(0, Math.min(1, b.pct)) * 100)}%`,
                  background: "var(--accent)",
                  "border-radius": "99px",
                }}
              />
            </div>
          </div>
        )}
      </For>
    </div>
  </div>
);
