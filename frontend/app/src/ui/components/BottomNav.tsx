/**
 * Mobile bottom navigation.
 *
 * Fixed to the bottom on narrow viewports (shown/hidden purely via the
 * `.bottom-nav` media query in `theme.css`, which also hides the header's nav
 * links so the two never coexist). Hidden on the Respond route, where the
 * sticky submit bar owns the bottom edge.
 */

import { For, Show, type Component, type JSX } from "solid-js";
import { A, useLocation } from "@solidjs/router";

import css from "./BottomNav.module.css";

const ITEMS: ReadonlyArray<{
  href: string;
  label: string;
  icon: Component;
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
      <nav class={`bottom-nav ${css.bar}`}>
        <For each={ITEMS}>
          {(item) => (
            <A
              href={item.href}
              class={css.item}
              classList={{ [css.active]: active(item.href) }}
            >
              <item.icon />
              <span class={css.label}>{item.label}</span>
            </A>
          )}
        </For>
      </nav>
    </Show>
  );
};

// --- icons (mirror the mockup's inline glyphs) -------------------------------

function ExploreIcon(): JSX.Element {
  const bar = (h: string): JSX.Element => <span style={{ height: h }} />;
  return (
    <span class={css.explore}>
      {bar("7px")}
      {bar("13px")}
      {bar("10px")}
    </span>
  );
}

function CreateIcon(): JSX.Element {
  return <span class={css.create}>+</span>;
}

function SettingsIcon(): JSX.Element {
  const knob = (side: "left" | "right"): JSX.Element => (
    <span
      class={`${css.knob} ${side === "left" ? css.knobLeft : css.knobRight}`}
    >
      <span />
    </span>
  );
  return (
    <span class={css.settings}>
      {knob("left")}
      {knob("right")}
    </span>
  );
}
