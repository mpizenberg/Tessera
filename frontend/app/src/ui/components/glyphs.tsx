import { For, Show, type Component } from "solid-js";

import { roleAbbr, roleColors, type ViewStatus } from "~/ui/format";

/** 3×3 "Form" mosaic — one filled tile per question, capped at 9. */
export const FormMosaic: Component<{ count: number; size?: number }> = (
  props,
) => {
  const size = () => props.size ?? 24;
  const on = () => Math.max(0, Math.min(props.count, 9));
  return (
    <span
      style={{
        display: "grid",
        "grid-template-columns": "repeat(3,1fr)",
        gap: "2px",
        width: `${size()}px`,
        height: `${size()}px`,
      }}
    >
      <For each={Array.from({ length: 9 }, (_, i) => i)}>
        {(i) => {
          const filled = i < on();
          return (
            <span
              style={{
                width: "100%",
                height: "100%",
                "border-radius": "1.5px",
                background: filled ? "var(--accent)" : "transparent",
                border: `1px solid ${filled ? "var(--accent)" : "#E2D9C7"}`,
                "box-sizing": "border-box",
              }}
            />
          );
        }}
      </For>
    </span>
  );
};

/** Visibility glyph: lock = sealed, ring = public/ended, dash = cancelled. */
export const VisGlyph: Component<{ status: ViewStatus }> = (props) => (
  <Show
    when={props.status === "sealed"}
    fallback={<RingOrDash status={props.status} />}
  >
    <span
      style={{
        position: "relative",
        display: "inline-block",
        width: "13px",
        height: "14px",
      }}
    >
      <span
        style={{
          position: "absolute",
          left: "3px",
          top: "0",
          width: "7px",
          height: "7px",
          border: "1.5px solid #B5832B",
          "border-bottom": "none",
          "border-radius": "4px 4px 0 0",
          "box-sizing": "border-box",
        }}
      />
      <span
        style={{
          position: "absolute",
          left: "0",
          top: "5px",
          width: "13px",
          height: "9px",
          background: "#B5832B",
          "border-radius": "2px",
        }}
      />
    </span>
  </Show>
);

const RingOrDash: Component<{ status: ViewStatus }> = (props) => (
  <Show
    when={props.status !== "cancelled"}
    fallback={
      <span
        style={{
          width: "11px",
          height: "2px",
          "border-radius": "1px",
          background: "#B9AF9B",
        }}
      />
    }
  >
    <span
      style={{
        width: "12px",
        height: "12px",
        "border-radius": "50%",
        border: `2px solid ${props.status === "ended" ? "#BBB1A0" : "#7E8B6A"}`,
        "box-sizing": "border-box",
      }}
    />
  </Show>
);

/** Up to three colored role chips, with a "+N" overflow chip. */
export const RoleChips: Component<{ roles: readonly number[] }> = (props) => {
  const shown = () => props.roles.slice(0, 3);
  const overflow = () => props.roles.length - 3;
  return (
    <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px" }}>
      <For each={shown()}>
        {(r) => {
          const [color, bg] = roleColors(r);
          return (
            <span
              style={{
                "font-size": "10.5px",
                "font-weight": "600",
                color,
                background: bg,
                border: `1px solid ${bg}`,
                "border-radius": "6px",
                padding: "2.5px 7px",
                "white-space": "nowrap",
              }}
            >
              {roleAbbr(r)}
            </span>
          );
        }}
      </For>
      <Show when={overflow() > 0}>
        <span
          style={{
            "font-size": "10.5px",
            "font-weight": "600",
            color: "#8A8377",
            background: "#EFEADF",
            border: "1px solid #E2DBCB",
            "border-radius": "6px",
            padding: "2.5px 7px",
            "white-space": "nowrap",
          }}
        >
          +{overflow()}
        </span>
      </Show>
    </div>
  );
};
