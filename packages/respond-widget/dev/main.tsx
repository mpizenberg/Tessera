/**
 * Dev harness (milestone 4): mount `RespondRoot` into a shadow root — the same
 * isolation `solid-element` will give it in milestone 6 — adopt the widget
 * styles, drive it with the sample props, and log every emitted event.
 *
 * The events (`tessera:*`) are `composed: true`, so a listener on the light-DOM
 * host element sees them cross the shadow boundary. Run with
 * `pnpm --filter @tessera/respond-widget dev`.
 */

import { render } from "solid-js/web";
import { createSignal } from "solid-js";

import { RespondRoot, adoptWidgetStyles } from "../src/index";
import {
  SAMPLES,
  responder,
  spoResponder,
  surveyRef,
  TIP_EPOCH,
  type SampleKey,
} from "./samples";

const mount = document.getElementById("mount") as HTMLElement;
const logEl = document.getElementById("log") as HTMLElement;
const changeLine = document.getElementById("change") as HTMLElement;

// --- Event log --------------------------------------------------------------

/** Recursively make a Metadatum-ish value JSON-friendly (bigint/bytes/Map). */
function plain(v: unknown): unknown {
  if (typeof v === "bigint") return `${v}n`;
  if (v instanceof Uint8Array) {
    return `0x${[...v].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  if (v instanceof Map) {
    return Object.fromEntries(
      [...v.entries()].map(([k, val]) => [String(plain(k)), plain(val)]),
    );
  }
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => [k, plain(val)]),
    );
  }
  return v;
}

function log(label: string, detail: unknown): void {
  const body = JSON.stringify(plain(detail), null, 2);
  // The high-frequency change stream gets its own single, latest line.
  if (label === "change") {
    changeLine.textContent = `tessera:change → ${body}`;
    return;
  }
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `[${time}] tessera:${label}\n${body}\n\n${logEl.textContent ?? ""}`;
}

mount.addEventListener("tessera:response", (e) =>
  log("response", (e as CustomEvent).detail),
);
mount.addEventListener("tessera:invalid", (e) =>
  log("invalid", (e as CustomEvent).detail),
);
mount.addEventListener("tessera:change", (e) =>
  log("change", (e as CustomEvent).detail),
);

// --- Shadow mount -----------------------------------------------------------

const shadow = mount.attachShadow({ mode: "open" });
adoptWidgetStyles(shadow);

const [sample, setSample] = createSignal<SampleKey>("public");
const [locale, setLocale] = createSignal("en");
const [layout, setLayout] = createSignal<"one-per-screen" | "list">(
  "one-per-screen",
);
const [themeName, setThemeName] = createSignal("default");

// `theme`-prop demo: re-skins the accent (and the DRep chip that follows it)
// without touching any CSS. "default" is an empty override set, so switching
// back also exercises the stale-key cleanup.
const THEMES: Record<string, Record<string, string>> = {
  default: {},
  plum: {
    accent: "#6b46ff",
    "accent-bg": "#efeaff",
    "accent-line": "#d9cdf8",
    "role-drep": "#6b46ff",
    "role-drep-bg": "#efeaff",
  },
  // A full dark re-skin, proving every color flows through the tokens (the
  // token-gate test forbids literals outside theme.css). Native controls
  // (range track, number spinners) also need `color-scheme: dark`, which a
  // custom property can't express — the harness sets it on the frame in CSS.
  dark: {
    ink: "#f2ede3",
    body: "#d9d2c4",
    muted: "#a89d8a",
    faint: "#7d7462",
    dim: "#6d6455",
    paper: "#1f1c16",
    line: "#3a352b",
    line2: "#353026",
    hair: "#2b2721",
    surface2: "#262219",
    surface3: "#2b2721",
    "header-line": "#3a3425",
    "card-bg": "#24211a",
    "card-line": "#322d22",
    label: "#b3a175",
    "label-strong": "#cdbf9a",
    accent: "#d97a4d",
    "accent-bg": "#3a2a1f",
    "accent-line": "#5a3d2a",
    ok: "#8fbf76",
    "ok-line": "#3d4f33",
    "ok-bg-soft": "#223024",
    "ok-ink": "#9ecfae",
    warn: "#d9a94f",
    "warn-line": "#55461f",
    danger: "#e07b63",
    "danger-bg": "#3a241d",
    "danger-line": "#55372a",
    "danger-line-soft": "#4a2f28",
    "danger-ink": "#e69582",
    "role-drep": "#d97a4d",
    "role-drep-bg": "#3a2a1f",
    "role-spo": "#7fbfae",
    "role-spo-bg": "#21362f",
    "role-cc": "#b39ddb",
    "role-cc-bg": "#2e2839",
    "role-stakeholder": "#9ccf7f",
    "role-stakeholder-bg": "#26331f",
    "role-keyholder": "#d9b36a",
    "role-keyholder-bg": "#38301c",
  },
};

render(
  () => (
    <RespondRoot
      definition={SAMPLES[sample()]}
      surveyRef={surveyRef}
      // The SPO sample's host vouches for a pool credential the wallet can't
      // hold — that's what makes its SPO/CC-only survey answerable.
      responder={sample() === "spo" ? spoResponder : responder}
      tipEpoch={TIP_EPOCH}
      // Cancellation is a host-observed on-chain fact, passed as a prop.
      cancelled={sample() === "cancelled"}
      locale={locale()}
      layout={layout()}
      theme={THEMES[themeName()] ?? {}}
    />
  ),
  shadow,
);

// --- Controls (light-DOM buttons in index.html) -----------------------------

for (const btn of document.querySelectorAll<HTMLButtonElement>(
  "[data-sample]",
)) {
  btn.addEventListener("click", () => {
    setSample(btn.dataset.sample as SampleKey);
    syncActive("data-sample", btn.dataset.sample!);
  });
}
for (const btn of document.querySelectorAll<HTMLButtonElement>(
  "[data-locale]",
)) {
  btn.addEventListener("click", () => {
    setLocale(btn.dataset.locale!);
    syncActive("data-locale", btn.dataset.locale!);
  });
}
for (const btn of document.querySelectorAll<HTMLButtonElement>(
  "[data-layout]",
)) {
  btn.addEventListener("click", () => {
    setLayout(btn.dataset.layout as "one-per-screen" | "list");
    syncActive("data-layout", btn.dataset.layout!);
  });
}
for (const btn of document.querySelectorAll<HTMLButtonElement>(
  "[data-theme]",
)) {
  btn.addEventListener("click", () => {
    setThemeName(btn.dataset.theme!);
    syncActive("data-theme", btn.dataset.theme!);
    document
      .querySelector(".frame")
      ?.classList.toggle("dark", btn.dataset.theme === "dark");
  });
}

function syncActive(attr: string, value: string): void {
  for (const el of document.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    el.classList.toggle("active", el.getAttribute(attr) === value);
  }
}
