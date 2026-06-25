/**
 * Mobile bottom navigation.
 *
 * Fixed to the bottom on narrow viewports (shown/hidden purely via the
 * `.bottom-nav` media query in `theme.css`, which also hides the header's nav
 * links so the two never coexist). Hidden on the Respond route, where the
 * sticky submit bar owns the bottom edge.
 */

import { For, Show, type Accessor, type Component, type JSX } from "solid-js";
import { A, useLocation } from "@solidjs/router";

const ITEMS: ReadonlyArray<{
  href: string;
  label: string;
  icon: Component<{ color: Accessor<string> }>;
}> = [
  { href: "/", label: "Explore", icon: ExploreIcon },
  { href: "/create", label: "Create", icon: CreateIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

export const BottomNav: Component = () => {
  const loc = useLocation();
  // The respond view owns the bottom edge with its sticky submit bar.
  const hidden = () => loc.pathname.endsWith("/respond");
  const active = (href: string) =>
    href === "/" ? loc.pathname === "/" : loc.pathname.startsWith(href);

  return (
    <Show when={!hidden()}>
      <nav
        class="bottom-nav"
        style={{
          position: "fixed",
          left: "0",
          right: "0",
          bottom: "0",
          "z-index": "45",
          background: "rgba(255,255,255,.94)",
          "backdrop-filter": "blur(10px)",
          "border-top": "1px solid var(--line)",
          "padding-bottom": "env(safe-area-inset-bottom)",
        }}
      >
        <For each={ITEMS}>
          {(item) => {
            const color = (): string =>
              active(item.href) ? "var(--accent)" : "var(--dim)";
            return (
              <A href={item.href} style={itemStyle(color())}>
                <item.icon color={color} />
                <span
                  style={{
                    "font-size": "11px",
                    "font-weight": "700",
                    "letter-spacing": "-.01em",
                  }}
                >
                  {item.label}
                </span>
              </A>
            );
          }}
        </For>
      </nav>
    </Show>
  );
};

function itemStyle(color: string): JSX.CSSProperties {
  return {
    flex: "1",
    display: "flex",
    "flex-direction": "column",
    "align-items": "center",
    "justify-content": "center",
    gap: "4px",
    height: "58px",
    "text-decoration": "none",
    color,
  };
}

// --- icons (mirror the mockup's inline glyphs) -------------------------------

function ExploreIcon(props: { color: Accessor<string> }): JSX.Element {
  const bar = (h: string): JSX.Element => (
    <span
      style={{
        width: "3px",
        height: h,
        background: props.color(),
        "border-radius": "1px",
      }}
    />
  );
  return (
    <span
      style={{
        display: "flex",
        "align-items": "flex-end",
        gap: "2.5px",
        height: "16px",
      }}
    >
      {bar("7px")}
      {bar("13px")}
      {bar("10px")}
    </span>
  );
}

function CreateIcon(props: { color: Accessor<string> }): JSX.Element {
  return (
    <span
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        width: "18px",
        height: "16px",
        border: `1.6px solid ${props.color()}`,
        "border-radius": "var(--r-3xs)",
        "font-size": "13px",
        "font-weight": "700",
        "line-height": "0",
        color: props.color(),
      }}
    >
      +
    </span>
  );
}

function SettingsIcon(props: { color: Accessor<string> }): JSX.Element {
  const knob = (side: "left" | "right"): JSX.Element => (
    <span
      style={{
        position: "relative",
        height: "2px",
        background: props.color(),
        "border-radius": "2px",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: "-2px",
          [side]: "3px",
          width: "6px",
          height: "6px",
          "border-radius": "50%",
          background: props.color(),
        }}
      />
    </span>
  );
  return (
    <span
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "4px",
        width: "16px",
        height: "16px",
        "justify-content": "center",
      }}
    >
      {knob("left")}
      {knob("right")}
    </span>
  );
}
