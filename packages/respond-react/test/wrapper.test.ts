// @vitest-environment happy-dom
/**
 * The wrapper against the real built widget, run twice: once per React major
 * (this config's vs vitest.react18.config.ts's alias — see
 * EXPECTED_REACT_MAJOR). `flushSync` commits renders synchronously, and the
 * wrapper's effects are layout effects, so no `act`/timers are needed.
 */

import {
  createElement,
  createRef,
  version as reactVersion,
  type Ref,
} from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  TesseraRespond,
  type RespondChangeDetail,
  type RespondResult,
  type TesseraRespondElement,
  type TesseraRespondProps,
} from "../src/index";
import { REQUIRED, definition, surveyRef } from "./sample";

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(
  props: TesseraRespondProps & { ref?: Ref<TesseraRespondElement> },
): TesseraRespondElement {
  if (root === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  flushSync(() => root!.render(createElement(TesseraRespond, props)));
  const el = container!.querySelector("tessera-respond");
  expect(el, "the wrapper should render <tessera-respond>").not.toBe(null);
  return el!;
}

function shadow(el: TesseraRespondElement): ShadowRoot {
  expect(el.shadowRoot).not.toBe(null);
  return el.shadowRoot!;
}

function click(el: TesseraRespondElement, selector: string): void {
  const target = shadow(el).querySelector<HTMLElement>(selector);
  expect(target, `expected ${selector} in the shadow root`).not.toBe(null);
  target!.click();
}

afterEach(() => {
  root?.unmount();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("TesseraRespond (React wrapper)", () => {
  it("runs against the React major this config targets", () => {
    expect(reactVersion.split(".")[0]).toBe(
      process.env["EXPECTED_REACT_MAJOR"],
    );
  });

  it("renders the widget with object props as DOM properties, not attributes", () => {
    const el = render(REQUIRED);
    expect(el.definition).toBe(definition);
    expect(el.tipEpoch).toBe(500);
    expect(el.getAttribute("definition")).toBe(null);
    expect(shadow(el).querySelector(".headerTitle")?.textContent).toBe(
      "React wrapper survey",
    );
  });

  it("delivers widget events through the callbacks", async () => {
    const changes: RespondChangeDetail[] = [];
    let resolveResult!: (r: RespondResult) => void;
    const result = new Promise<RespondResult>((r) => (resolveResult = r));
    const el = render({
      ...REQUIRED,
      onChange: (d) => changes.push(d),
      onResponse: resolveResult,
    });
    // The widget announces progress as soon as it renders — the wrapper's
    // listeners attach before props sync, so they catch that initial event.
    expect(changes).toEqual([{ decided: 0, total: 1, valid: false }]);
    click(el, ".optionRow");
    expect(changes.at(-1)).toEqual({ decided: 1, total: 1, valid: true });
    click(el, ".submitBtn");
    const detail = await result;
    expect(detail.sealed).toBe(false);
    expect(detail.role).toBe(4);
    expect(detail.surveyRef).toEqual(surveyRef);
    expect(detail.proveCredentials[0]?.keyKind).toBe("payment");
  });

  it("applies prop updates and removals across re-renders", () => {
    const el = render({ ...REQUIRED, cancelled: true });
    expect(shadow(el).querySelector(".noticeTitle")).not.toBe(null);
    // Dropping the prop must reach the element as `undefined`, not linger.
    render(REQUIRED);
    expect(shadow(el).querySelector(".noticeTitle")).toBe(null);
    render({ ...REQUIRED, locale: "fr" });
    expect(shadow(el).querySelector(".respondLabel")?.textContent).toBe(
      "Répondre",
    );
  });

  it("keeps listeners attached while swapping to the latest callback", () => {
    const seen: string[] = [];
    const el = render({ ...REQUIRED, onChange: () => seen.push("first") });
    render({ ...REQUIRED, onChange: () => seen.push("second") });
    seen.length = 0;
    click(el, ".optionRow");
    expect(seen).toEqual(["second"]);
  });

  it("forwards the ref and passes className/style/id through", () => {
    const ref = createRef<TesseraRespondElement>();
    const el = render({
      ...REQUIRED,
      ref,
      className: "host",
      id: "widget",
      style: { maxWidth: "40rem" },
    });
    expect(ref.current).toBe(el);
    expect(el.className).toBe("host");
    expect(el.id).toBe("widget");
    expect(el.style.maxWidth).toBe("40rem");
  });

  it("stops delivering events after unmount", () => {
    let calls = 0;
    const el = render({ ...REQUIRED, onChange: () => calls++ });
    const detail: RespondChangeDetail = { decided: 1, total: 1, valid: true };
    const base = calls;
    el.dispatchEvent(new CustomEvent("tessera:change", { detail }));
    expect(calls).toBe(base + 1);
    root!.unmount();
    root = null;
    el.dispatchEvent(new CustomEvent("tessera:change", { detail }));
    expect(calls).toBe(base + 1);
  });
});
