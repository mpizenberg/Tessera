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

import { t } from "~/i18n";
import css from "./BottomNav.module.css";

// `label` is a message key resolved reactively in the render, so the labels
// re-translate on a locale switch (a module-level `t()` would resolve once).
const ITEMS: ReadonlyArray<{
  href: string;
  label: "explore" | "create" | "settings";
  icon: Component;
}> = [
  { href: "/", label: "explore", icon: ExploreIcon },
  { href: "/create", label: "create", icon: CreateIcon },
  { href: "/settings", label: "settings", icon: SettingsIcon },
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
              <span class={css.label}>{t(`bottomNav.${item.label}`)}</span>
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
