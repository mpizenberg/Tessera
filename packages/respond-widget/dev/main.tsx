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

render(
  () => (
    <RespondRoot
      definition={SAMPLES[sample()]}
      surveyRef={surveyRef}
      responder={responder}
      tipEpoch={TIP_EPOCH}
      locale={locale()}
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

function syncActive(attr: string, value: string): void {
  for (const el of document.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    el.classList.toggle("active", el.getAttribute(attr) === value);
  }
}
